import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { processMaintenanceJob } from "@/worker/maintenance";

// ---------------------------------------------------------------------------
// Maintenance-lane dispatcher proof for the windowed-uptime recompute
// (DAT-11, 08-CONTEXT D-22) on the REAL docker test Postgres (:5453).
//
// Pins:
//   1. processMaintenanceJob accepts the job name 'recompute-windowed-uptime'
//      alongside 'cleanup'; ANY other name still throws the loud
//      unknown-name error, now enumerating BOTH accepted names (the same
//      dbWrites-dispatcher discipline — never a silent skip); the cleanup
//      path itself is unchanged (dry-run default, zero writes)
//   2. the recompute report carries ids/counts ONLY — monitorId plus the
//      three computed values, never URLs or bodies (T-04-28 discipline)
// ---------------------------------------------------------------------------

let pg: Client;
let testUserId: string;

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Redis stub — the recompute path needs NO Redis; the cleanup path's observations do. */
function redisStub() {
  return { scan: vi.fn().mockResolvedValue(["0", []]), call: vi.fn().mockResolvedValue(0) };
}

async function seedUser(): Promise<string> {
  const result = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`windowed-dispatch-${crypto.randomUUID()}@example.test`]
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
      `windowed-dispatch-${crypto.randomUUID().slice(0, 8)}`,
      testUserId,
      opts.totalChecks,
      opts.failedChecks,
      opts.uptimePercent,
    ]
  );
  return result.rows[0].id as number;
}

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

describe("maintenance lane — windowed recompute dispatcher (DAT-11)", () => {
  it(
    "1. accepts 'recompute-windowed-uptime' alongside cleanup; any other name still throws the loud unknown-name error naming BOTH accepted names",
    async () => {
      // The new name resolves end-to-end (empty DB: nothing to recompute).
      await expect(
        processMaintenanceJob({ name: "recompute-windowed-uptime", data: {} }, { logger: fakeLogger() })
      ).resolves.toBeDefined();

      // Any other name is STILL a loud contract violation — the error now
      // enumerates both accepted names.
      await expect(
        processMaintenanceJob({ name: "purge-everything", data: {} }, { logger: fakeLogger() })
      ).rejects.toThrow(
        /unknown maintenance job name 'purge-everything' \(expected 'cleanup' or 'recompute-windowed-uptime'\)/
      );

      // The cleanup path is unchanged: dry-run is the default (zero writes).
      const cleanup = await processMaintenanceJob({ name: "cleanup", data: {} }, {
        redis: redisStub(),
        logger: fakeLogger(),
      });
      expect(cleanup.dryRun).toBe(true);
      expect(cleanup.pings.deleted).toBe(0);
      expect(cleanup.pings.batches).toEqual([]);
    },
    20_000
  );

  it(
    "2. the recompute report carries ids/counts only — never URLs (T-04-28)",
    async () => {
      const monitorId = await seedMonitor({ totalChecks: 5, failedChecks: 1, uptimePercent: 80 });
      await seedPings(monitorId, 4, 2, 4); // 4 pings @ 2h, 1 DOWN -> 75.00

      const report = (await processMaintenanceJob(
        { name: "recompute-windowed-uptime", data: {} },
        { logger: fakeLogger() }
      )) as unknown as {
        monitors: Array<Record<string, unknown>>;
        monitorsRecomputed: number;
        batches: number[];
      };

      expect(report.monitorsRecomputed).toBe(1);
      expect(report.batches).toEqual([1]);
      expect(Object.keys(report.monitors[0]).sort()).toEqual([
        "monitorId",
        "uptime24h",
        "uptime30d",
        "uptime7d",
      ]);
      expect(report.monitors[0].monitorId).toBe(monitorId);
    },
    20_000
  );
});

describe("WINDOWED_UPTIME_ENABLED read gate (DAT-11/D-22)", () => {
  it(
    "isWindowedUptimeReadEnabled: true ONLY for the literal 'true'; unset/false/other are off",
    async () => {
      const saved = process.env.WINDOWED_UPTIME_ENABLED;
      try {
        vi.resetModules();
        const mod = await import("@/worker/maintenance");

        delete process.env.WINDOWED_UPTIME_ENABLED;
        expect(mod.isWindowedUptimeReadEnabled()).toBe(false);

        process.env.WINDOWED_UPTIME_ENABLED = "false";
        expect(mod.isWindowedUptimeReadEnabled()).toBe(false);

        process.env.WINDOWED_UPTIME_ENABLED = "1";
        expect(mod.isWindowedUptimeReadEnabled()).toBe(false);

        process.env.WINDOWED_UPTIME_ENABLED = "true";
        expect(mod.isWindowedUptimeReadEnabled()).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.WINDOWED_UPTIME_ENABLED;
        else process.env.WINDOWED_UPTIME_ENABLED = saved;
        vi.resetModules();
      }
    },
    15_000
  );
});
