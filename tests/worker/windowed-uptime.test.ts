import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { processMaintenanceJob, runConsistencyAudit } from "@/worker/maintenance";

// ---------------------------------------------------------------------------
// Windowed-uptime recompute proof suite (DAT-11, 08-CONTEXT D-22/D-23/D-24)
// on the REAL docker test Postgres (:5453) — the windowed math is engine
// semantics (the D-36 binary-extraction expression over window-scoped ping
// counts), only provable live. Seeds go through raw SQL via
// TEST_DATABASE_URL only (02-02 rule).
//
// Pins:
//   1. one recompute run populates uptime24h/uptime7d/uptime30d from pings
//      (failure = status='DOWN', the tier1/tier2 vocabulary) and the 30d
//      window is BYTE-EQUAL to the lifetime D-36 derivation
//      (runConsistencyAudit) over identical ping counts — the 04-04 D-36
//      pinned form is the only rounding path (never round())
//   2. the recompute UPDATE writes ONLY the three new columns: the displayed
//      lifetime numbers (uptimePercent/totalChecks/failedChecks) are
//      byte-unchanged after the job (D-24: nothing visible changes)
//   3. a monitor with zero pings inside a window keeps NULL there (A5
//      nullable shape, explicit-NULL form); a zero-ping monitor stays
//      all-NULL (the D-23 first-run backfill populates only windows WITH
//      pings)
// ---------------------------------------------------------------------------

/** Local structural shape of the windowed recompute report (ids/counts only). */
type WindowedReport = {
  monitors: Array<{
    monitorId: number;
    uptime24h: number | null;
    uptime7d: number | null;
    uptime30d: number | null;
  }>;
  monitorsRecomputed: number;
  batches: number[];
};

let pg: Client;
let testUserId: string;

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function seedUser(): Promise<string> {
  const result = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`windowed-test-${crypto.randomUUID()}@example.test`]
  );
  return result.rows[0].id as string;
}

async function seedMonitor(opts: {
  totalChecks: number;
  failedChecks: number;
  uptimePercent: number;
}): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval,
       "totalChecks", "failedChecks", "uptimePercent", "updatedAt")
     VALUES ('https://example.com', $1, $2, 'UP', true, 5, $3, $4, $5, now()) RETURNING id`,
    [
      `windowed-test-${crypto.randomUUID().slice(0, 8)}`,
      testUserId,
      opts.totalChecks,
      opts.failedChecks,
      opts.uptimePercent,
    ]
  );
  return result.rows[0].id as number;
}

/** count pings at ageHours; every downEvery-th one DOWN (the tier 'DOWN' vocabulary). */
async function seedPings(
  monitorId: number,
  count: number,
  ageHours: number,
  downEvery: number
): Promise<void> {
  await pg.query(
    `INSERT INTO pings ("monitorId", status, "responseTime", "createdAt")
     SELECT $1,
            CASE WHEN i % ${downEvery} = 0 THEN 'DOWN' ELSE 'UP' END,
            100,
            ((now() AT TIME ZONE 'utc') - (${ageHours}::int * interval '1 hour'))
       FROM generate_series(1, ${count}) AS i`,
    [monitorId]
  );
}

/** The lifetime trio — exists BEFORE migration 0004 (pre-column read is RED-safe). */
async function lifetimeRow(
  monitorId: number
): Promise<{ uptimePercent: number; totalChecks: number; failedChecks: number }> {
  const result = await pg.query(
    `SELECT "uptimePercent", "totalChecks", "failedChecks" FROM monitors WHERE id = $1`,
    [monitorId]
  );
  return result.rows[0];
}

/** The three windowed columns (migration 0004). */
async function windowedRow(
  monitorId: number
): Promise<{ uptime24h: number | null; uptime7d: number | null; uptime30d: number | null }> {
  const result = await pg.query(
    `SELECT "uptime24h", "uptime7d", "uptime30d" FROM monitors WHERE id = $1`,
    [monitorId]
  );
  return result.rows[0];
}

async function runRecompute(): Promise<WindowedReport> {
  return (await processMaintenanceJob(
    { name: "recompute-windowed-uptime", data: {} },
    { logger: fakeLogger() }
  )) as unknown as WindowedReport;
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
});

afterAll(async () => {
  await pg.query("TRUNCATE pings, incidents, monitors, users, outbox, write_guards CASCADE");
  await pg.end();
});

beforeEach(async () => {
  await pg.query("TRUNCATE pings, incidents, monitors, users, outbox, write_guards CASCADE");
  testUserId = await seedUser();
});

describe("windowed uptime recompute (DAT-11)", () => {
  it(
    "1. populates all three windows from pings; 30d is byte-equal to the lifetime D-36 derivation; lifetime counters byte-unchanged",
    async () => {
      // One monitor, pings across all three (overlapping) windows:
      //   20 @ 1h (4 DOWN) + 30 @ 72h (6 DOWN) + 23 @ 480h (3 DOWN)
      //   => total24=20/down24=4, total7=50/down7=10, total30=73/down30=13.
      // The sentinel stored uptimePercent (-1) guarantees the D-37 audit
      // flags this monitor, so the discrepancy's `derived` IS the lifetime
      // D-36 value over (totalChecks, failedChecks) = (73, 13) — the exact
      // byte-equality anchor for the 30d window.
      const monitorId = await seedMonitor({ totalChecks: 73, failedChecks: 13, uptimePercent: -1 });
      await seedPings(monitorId, 20, 1, 5);
      await seedPings(monitorId, 30, 72, 5);
      await seedPings(monitorId, 23, 480, 7);

      const before = await lifetimeRow(monitorId);
      expect(before).toEqual({ uptimePercent: -1, totalChecks: 73, failedChecks: 13 });

      const report = await runRecompute();
      expect(report.monitorsRecomputed).toBe(1);
      expect(report.monitors[0].monitorId).toBe(monitorId);

      const after = await windowedRow(monitorId);
      // 24h: (20-4)/20*100 = 80 exactly; 7d: (50-10)/50*100 = 80 exactly.
      expect(after.uptime24h).toBe(80);
      expect(after.uptime7d).toBe(80);

      // 30d: byte-equal to the lifetime D-36 derivation over the SAME ping
      // rows (73 total / 13 DOWN), read off runConsistencyAudit's
      // discrepancy (`derived` is computed by the writers' own expression).
      const audit = await runConsistencyAudit();
      expect(audit.checked).toBe(1);
      expect(audit.discrepancies).toHaveLength(1);
      expect(audit.discrepancies[0].monitorId).toBe(monitorId);
      expect(after.uptime30d).toBe(audit.discrepancies[0].derived);
      // Secondary pin: the concrete value (60/73*100 = 82.1917... -> 82.19 —
      // no .xx5 tie, so any correct 2-decimal path agrees).
      expect(after.uptime30d).toBe(82.19);

      // T-08-01: the UPDATE touched ONLY the three new columns — the
      // displayed lifetime numbers are byte-unchanged (D-24).
      const lifetimeAfter = await lifetimeRow(monitorId);
      expect(lifetimeAfter).toEqual(before);
    },
    20_000
  );

  it(
    "2. zero-ping windows keep NULL (A5 nullable shape); a zero-ping monitor stays all-NULL",
    async () => {
      // M2: pings ONLY inside the 24h window -> uptime7d/uptime30d stay NULL.
      const withRecent = await seedMonitor({ totalChecks: 0, failedChecks: 0, uptimePercent: 100 });
      await seedPings(withRecent, 4, 2, 4); // 4 pings @ 2h, 1 DOWN -> 75.00

      // M3: zero pings anywhere -> all three windows NULL.
      const silent = await seedMonitor({ totalChecks: 0, failedChecks: 0, uptimePercent: 100 });

      const report = await runRecompute();
      expect(report.monitorsRecomputed).toBe(2);
      expect(report.batches).toEqual([2]);

      const recentRow = await windowedRow(withRecent);
      expect(recentRow.uptime24h).toBe(75);
      expect(recentRow.uptime7d).toBeNull();
      expect(recentRow.uptime30d).toBeNull();

      const silentRow = await windowedRow(silent);
      expect(silentRow.uptime24h).toBeNull();
      expect(silentRow.uptime7d).toBeNull();
      expect(silentRow.uptime30d).toBeNull();
    },
    20_000
  );
});
