import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { processTick } from "@/worker/scheduler";
import { resetBacklogDropCount } from "@/worker/backlog";
import type { WorkerQueueSet } from "@/worker/queues";

// ---------------------------------------------------------------------------
// Tick heartbeat proof suite (WRK-09 / D-21 / D-22, audit §14.2 step 5 +
// §14.4 rows 1-3): every completed tick pings the WORKER_HC_PING_URL check
// exactly once; a tick-level exception or any enqueue failure pings /fail
// INSTEAD; ping errors never fail the tick and are never retried (Pitfall 3:
// healthchecks.io silently enforces 5 pings/min/check — a 30 s tick emits
// 2/min, so exactly-one-ping is the load-bearing discipline).
//
// The claim still runs against the REAL docker test Postgres (the §14.3
// transaction is the tick's own semantics — scheduler-flag suite precedent);
// the checks queue is a plain fake (CheckQueueClient's documented injection
// seam) so no Redis connection is minted, and global fetch is stubbed so the
// ping side is pure observation.
//
// Conventions follow tests/worker/scheduler-flag.test.ts.
// ---------------------------------------------------------------------------

const HEARTBEAT_URL = "https://hc.example.test/worker-heartbeat-mock";

let pg: Client;
let testUserId: string;
let fetchMock: ReturnType<typeof vi.fn>;
let savedHeartbeatEnv: string | undefined;

/** The checks-queue surface processTick actually uses (add + depth read). */
function healthyChecks() {
  return {
    add: vi.fn(async () => ({})),
    getJobCounts: vi.fn(async () => ({ wait: 0, prioritized: 0, delayed: 0, active: 0 })),
  };
}

function fakeQueues(checks: ReturnType<typeof healthyChecks>): WorkerQueueSet {
  // Only queues.checks is consumed by processTick — cast keeps the fake
  // honest about that without minting six BullMQ Queue instances.
  return { checks } as unknown as WorkerQueueSet;
}

async function seedMonitor(opts: { status: string }): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval, next_check_at, "updatedAt")
     VALUES ($1, $2, $3, $4, true, 5, now() - interval '5 seconds', now()) RETURNING id`,
    [
      "https://example.com",
      `hb-test-${crypto.randomUUID()}`,
      testUserId,
      opts.status,
    ]
  );
  return result.rows[0].id as number;
}

/** Every URL the stubbed fetch was called with, in order. */
function pingedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
});

afterAll(async () => {
  // Leave the tables clean for the files that run after this one.
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE users CASCADE");
  await pg.end();
});

beforeEach(async () => {
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`hb-test-${crypto.randomUUID()}@example.test`]
  );
  testUserId = user.rows[0].id as string;
  resetBacklogDropCount();
  fetchMock = vi.fn(async () => new Response("OK"));
  vi.stubGlobal("fetch", fetchMock);
  savedHeartbeatEnv = process.env.WORKER_HC_PING_URL;
  process.env.WORKER_HC_PING_URL = HEARTBEAT_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedHeartbeatEnv === undefined) delete process.env.WORKER_HC_PING_URL;
  else process.env.WORKER_HC_PING_URL = savedHeartbeatEnv;
});

describe("tick heartbeat dead-man (WRK-09 / D-21 / D-22, audit §14.2 step 5)", () => {
  it(
    "1. a completing tick pings the heartbeat success URL exactly once",
    async () => {
      await seedMonitor({ status: "DOWN" }); // non-UP lane: no backlog-gate read
      const result = await processTick({ queues: fakeQueues(healthyChecks()) });

      expect(result).toMatchObject({ claimed: 1, enqueued: 1, dropped: 0, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pingedUrls()).toEqual([HEARTBEAT_URL]);
    },
    15_000
  );

  it(
    "2. a tick whose claim body throws pings /fail exactly once and the error still surfaces",
    async () => {
      // claimDue's own argument validation throws before any SQL — the
      // deterministic claim-side failure without mocking the database.
      await expect(
        processTick({ queues: fakeQueues(healthyChecks()), batchSize: 0 })
      ).rejects.toThrow(/positive integer/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pingedUrls()).toEqual([`${HEARTBEAT_URL}/fail`]);
    },
    15_000
  );

  it(
    "3. failed enqueues (result.failed > 0, body completed) ping /fail instead of success (audit §14.4 row 1)",
    async () => {
      await seedMonitor({ status: "DOWN" });
      const checks = healthyChecks();
      checks.add = vi.fn(async () => {
        throw new Error("redis add rejected");
      });

      const result = await processTick({ queues: fakeQueues(checks) });

      expect(result).toMatchObject({ claimed: 1, enqueued: 0, dropped: 0, failed: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pingedUrls()).toEqual([`${HEARTBEAT_URL}/fail`]);
    },
    15_000
  );

  it(
    "4. a rejecting fetch never fails the tick and never triggers a second attempt (audit §14.4 row 3)",
    async () => {
      fetchMock = vi.fn(async () => {
        throw new Error("hc.io unreachable");
      });
      vi.stubGlobal("fetch", fetchMock);
      await seedMonitor({ status: "DOWN" });

      const result = await processTick({ queues: fakeQueues(healthyChecks()) });

      expect(result).toMatchObject({ claimed: 1, enqueued: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1); // no retry — Pitfall 3
    },
    15_000
  );

  it(
    "5. with WORKER_HC_PING_URL unset, zero fetch calls occur",
    async () => {
      delete process.env.WORKER_HC_PING_URL;
      await seedMonitor({ status: "DOWN" });

      const result = await processTick({ queues: fakeQueues(healthyChecks()) });

      expect(result.enqueued).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    },
    15_000
  );

  it(
    "6. the ping fetch carries an AbortSignal (5 s bound — presence asserted, not timing)",
    async () => {
      await seedMonitor({ status: "DOWN" });
      await processTick({ queues: fakeQueues(healthyChecks()) });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    },
    15_000
  );

  it(
    "7. backlog-gated drops are deliberate J-5 skips — success ping, never /fail",
    async () => {
      // UP monitor -> routine lane -> the gate reads the (inflated) depth and
      // drops the enqueue WITHOUT counting a failure.
      await seedMonitor({ status: "UP" });
      const checks = healthyChecks();
      checks.getJobCounts = vi.fn(async () => ({ wait: 0, prioritized: 9999, delayed: 0, active: 0 }));

      const result = await processTick({ queues: fakeQueues(checks) });

      expect(result).toMatchObject({ claimed: 1, enqueued: 0, dropped: 1, failed: 0 });
      expect(checks.add).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pingedUrls()).toEqual([HEARTBEAT_URL]);
    },
    15_000
  );

  it("8. source form: helper + env wired; no ping URL ever reaches a log call (T-05-02-02)", () => {
    const source = readFileSync("src/worker/scheduler.ts", "utf8");

    expect(source).toContain("pingDeadMan");
    expect(source).toContain("WORKER_HC_PING_URL");

    // pino ids-only rule (secret-bearing env class): no line that logs may
    // carry a ping URL/env reference.
    const offending = source
      .split("\n")
      .filter((line) => /\blog\.(info|warn|error)\(/.test(line) && line.includes("PING_URL"));
    expect(offending).toEqual([]);
  });
});
