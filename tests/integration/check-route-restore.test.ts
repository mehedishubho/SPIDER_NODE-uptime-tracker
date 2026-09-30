import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Real-Postgres integration proof for the check route's compensating restore
// (06-06 gap 1 + 06-REVIEW-GAPCLOSURE CR-01).
//
// The mocked contract suite (tests/api/check-route.handler.test.ts) pins the
// restore's ORDERING and parameter identity, but it mocks db.execute with
// hand-built fixtures — the driver's type pipeline never runs. This suite
// runs the REAL route handler over the REAL drizzle client (@/db -> the
// docker test Postgres :5453); only the session door, the limiter, and the
// enqueue path are seam-mocked (the enqueue seam is forced to reject to
// reach the compensation catch). It pins the CONTRACT that matters end to
// end: after a failed enqueue the row carries its exact pre-advance value at
// full microsecond precision, and after a successful enqueue the advance
// stands.
//
// DRIZZLE PARSER FINDING (documented because it contradicts the review's
// RED expectation): CR-01 claimed the RETURNING values reach the route as
// Date objects (ms-truncated) making the restore's equality guard match
// zero rows. That does NOT reproduce on this stack — drizzle-orm 0.45.x's
// node-postgres session (node_modules/drizzle-orm/node-postgres/session.js)
// installs a custom types.getTypeParser on EVERY query that returns the raw
// server text for TIMESTAMPTZ(1184)/TIMESTAMP(1114)/DATE, so db.execute
// already delivers full-microsecond strings and the guard matched BEFORE
// the ::text fix (this suite ran GREEN against the pre-fix route: the
// compensate log printed prior=2026-09-30 10:00:00.123456+00). The ::text
// round trip is nonetheless shipped per the review: it moves the precision
// guarantee INTO the SQL contract so the restore no longer depends on a
// drizzle-internal parser behavior whose removal (a drizzle upgrade) would
// silently recreate exactly the inert-restore failure CR-01 described.
// ---------------------------------------------------------------------------

const sessionSeam = vi.hoisted(() => ({
  userId: "restore-it-user",
  getAuthSession: vi.fn(),
}));
const limiterSeam = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const queueSeam = vi.hoisted(() => ({
  checksQueue: { add: vi.fn() },
  enqueueManualCheck: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getAuthSession: sessionSeam.getAuthSession }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: limiterSeam.rateLimit,
  getIP: vi.fn(),
}));
vi.mock("@/worker/queues", () => ({
  enqueueManualCheck: queueSeam.enqueueManualCheck,
  // The REAL @/lib/queue-producer binds QUEUE_NAMES from this module at import
  // time; provide the real names so importOriginal below can load it.
  QUEUE_NAMES: {
    scheduler: "monitor-scheduler",
    checks: "monitor-checks",
    dbWrites: "db-writes",
    alerts: "alerts",
    maintenance: "maintenance",
    email: "email-transactional",
  },
}));
// The REAL withProducerDeadline wraps the route's enqueue (the wrap is not
// under test but must behave); webQueueProducer is overridden so the route's
// argument evaluation never builds a live ioredis Queue.
vi.mock("@/lib/queue-producer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queue-producer")>();
  return {
    ...actual,
    webQueueProducer: () => ({ checks: queueSeam.checksQueue }),
  };
});

// Imported AFTER the seam mocks; @/db is deliberately NOT mocked.
import { POST as POST_CHECK } from "@/app/api/monitors/[id]/check/route";

let pg: Client;

/** µs-bearing pre-advance value (the .123456 fraction is the whole point). */
const SEEDED_NEXT_CHECK_AT = "2026-09-30 10:00:00.123456+00";

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  // Deterministic ::text rendering for the byte-exact comparison below (the
  // restore's correctness is timezone-independent — the text is re-parsed
  // with its offset — but the comparison must happen in ONE session).
  await pg.query("SET TIME ZONE 'UTC'");
});

afterAll(async () => {
  await pg.query("TRUNCATE monitors CASCADE").catch(() => {});
  await pg.end();
});

beforeEach(async () => {
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE users CASCADE");
  await pg.query(
    `INSERT INTO users (id, email, "updatedAt") VALUES ($1, $2, now())`,
    [sessionSeam.userId, `restore-it-${crypto.randomUUID()}@example.test`]
  );
  sessionSeam.getAuthSession.mockReset();
  sessionSeam.getAuthSession.mockResolvedValue({ user: { id: sessionSeam.userId } });
  limiterSeam.rateLimit.mockReset();
  limiterSeam.rateLimit.mockResolvedValue({ success: true, remaining: 5, resetSeconds: 30 });
  queueSeam.enqueueManualCheck.mockReset();
});

async function seedMonitor(): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval,
       "totalChecks", "failedChecks", "updatedAt", next_check_at)
     VALUES ($1, $2, $3, 'UP', true, 5, 0, 0, now(), $4::timestamptz)
     RETURNING id`,
    [
      "https://restore-it.test/ok",
      `restore-it-${crypto.randomUUID().slice(0, 8)}`,
      sessionSeam.userId,
      SEEDED_NEXT_CHECK_AT,
    ]
  );
  return result.rows[0].id as number;
}

async function fetchNextCheckAt(id: number): Promise<string> {
  const result = await pg.query(
    `SELECT next_check_at::text AS v FROM monitors WHERE id = $1`,
    [id]
  );
  return result.rows[0].v as string;
}

describe("POST /api/monitors/[id]/check — compensating restore precision (CR-01, real Postgres)", () => {
  it(
    "enqueue failure → the restore returns next_check_at to the EXACT µs pre-advance value (guard matches, no ms truncation)",
    async () => {
      const monitorId = await seedMonitor();
      const priorText = await fetchNextCheckAt(monitorId);
      expect(priorText).toBe("2026-09-30 10:00:00.123456+00"); // µs survive the seed

      // Redis down: the bounded producer rejects fast — the compensation
      // catch must fire and restore the pre-advance value.
      queueSeam.enqueueManualCheck.mockRejectedValueOnce(
        new Error("Reached the max retries per request limit (current value: 1).")
      );

      const res = await POST_CHECK(new Request(`http://localhost/api/monitors/${monitorId}/check`, { method: "POST" }), {
        params: Promise.resolve({ id: String(monitorId) }),
      });

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({
        error: "Service temporarily unavailable — try again shortly",
      });

      // The row must carry its PRIOR value again — byte-identical ::text in
      // this session AND exact timestamptz equality. Against the Date-based
      // restore (CR-01) the guard compared .123456 against the ms-truncated
      // .123, matched zero rows, and the ADVANCED (now()-anchored, µs-bearing)
      // value stayed standing — this assertion is what failed RED.
      const after = await pg.query(
        `SELECT next_check_at::text AS v,
                (next_check_at = $2::timestamptz) AS restored,
                (next_check_at <> $2::timestamptz AND next_check_at IS NOT NULL) AS still_advanced
           FROM monitors WHERE id = $1`,
        [monitorId, priorText]
      );
      expect(after.rows[0].restored).toBe(true);
      expect(after.rows[0].v).toBe(priorText);
      expect(after.rows[0].still_advanced).toBe(false);
    },
    15_000
  );

  it(
    "successful enqueue → the advance stands (µs-bearing), no restore runs",
    async () => {
      const monitorId = await seedMonitor();
      queueSeam.enqueueManualCheck.mockResolvedValue({
        jobId: `check-manual:${monitorId}:${Date.now()}`,
        priority: 1,
      });

      const res = await POST_CHECK(new Request(`http://localhost/api/monitors/${monitorId}/check`, { method: "POST" }), {
        params: Promise.resolve({ id: String(monitorId) }),
      });

      expect(res.status).toBe(202);
      // GREATEST(now() + 5min, prior + 5min): either branch lands strictly
      // past the seeded prior — the advance committed and was NOT rolled
      // back (exactly one enqueue attempt, zero compensations).
      const after = await pg.query(
        `SELECT (next_check_at > $2::timestamptz) AS advanced_past_prior
           FROM monitors WHERE id = $1`,
        [monitorId, SEEDED_NEXT_CHECK_AT]
      );
      expect(after.rows[0].advanced_past_prior).toBe(true);
    },
    15_000
  );
});
