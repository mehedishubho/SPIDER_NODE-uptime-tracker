import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import Redis from "ioredis";
import type { Job } from "bullmq";
import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/db/schema";
import { workerDb } from "@/worker/db";
import {
  INCIDENT_RETENTION_DAYS,
  PING_RETENTION_DAYS,
  processMaintenanceJob,
  RETENTION_BATCH,
  runConsistencyAudit,
  WRITE_GUARD_RETENTION_DAYS,
} from "@/worker/maintenance";
import {
  createWorkerQueues,
  enqueueMaintenance,
  startMaintenanceLaneWorker,
  ALERTS_LANE_CONCURRENCY,
  MAINTENANCE_LANE_CONCURRENCY,
  MAINTENANCE_JOB_OPTIONS,
} from "@/worker/queues";
import type { WorkerQueueSet } from "@/worker/queues";
import { OUTBOX_RELAY_SCHEDULER_ID, upsertSchedulersAtBoot } from "@/worker/scheduler";
import { RELAY_PASS_EVERY_MS } from "@/worker/persist/outbox";

// ---------------------------------------------------------------------------
// Maintenance lane proof suite (WRK-13 / DAT-08 / D-37, audit §16 + §13) on
// the REAL docker test Postgres (:5453) + Redis (:6390) — batched DELETE
// statement shapes, the D-36 recomputation, and the D-16 manual-enqueue path
// through a real BullMQ lane worker are engine semantics, only provable live.
// Seeds go through raw SQL via TEST_DATABASE_URL only (02-02 rule).
//
// Pins:
//   1. source/constants — 5000-row batches, 30/90-day cleanup-logic parity
//      horizons, 7-day write_guards observation, id-IN-subselect batch form,
//      dry-run DEFAULT (absent flag => zero writes), loud unknown-name
//      rejection, alerts-lane relay scheduler + lane worker wiring
//   2. dry run — correct per-monitor deletable counts + the D-37 audit flags
//      EXACTLY the corrupted monitor + ZERO writes (row counts and every
//      stored uptime_percent unchanged before/after)
//   3. real run — 5015 beyond-horizon pings delete in [5000, 15] batches
//      (every statement ≤ RETENTION_BATCH), fresh rows untouched, ONGOING
//      incident never eligible (T-04-27); the pass logs its deleted-row
//      counts at info level (D-18, 06-04)
//   4. D-16 — WORKER_SCHEDULER_ENABLED=false: zero scheduler upserts, yet a
//      manual enqueueMaintenance({dryRun}) processes end-to-end on the real
//      maintenance-lane Worker
//   5. D-18 (06-04) — a THROWING real pass logs at ERROR level (never a
//      silent failure) and rethrows so BullMQ's attempts/backoff keep the
//      retry contract
// ---------------------------------------------------------------------------

let pg: Client;
let admin: Redis;
let queues: WorkerQueueSet;
let testUserId: string;

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function seedUser(): Promise<string> {
  const result = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`maintenance-test-${crypto.randomUUID()}@example.test`]
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
      `maintenance-test-${crypto.randomUUID().slice(0, 8)}`,
      testUserId,
      opts.totalChecks,
      opts.failedChecks,
      opts.uptimePercent,
    ]
  );
  return result.rows[0].id as number;
}

async function seedPings(monitorId: number, count: number, ageDays: number): Promise<void> {
  await pg.query(
    `INSERT INTO pings ("monitorId", status, "responseTime", "createdAt")
     SELECT $1, 'UP', 100, ((now() AT TIME ZONE 'utc') - (${ageDays}::int * interval '1 day'))
       FROM generate_series(1, ${count})`,
    [monitorId]
  );
}

async function seedIncident(
  monitorId: number,
  status: "ONGOING" | "RESOLVED",
  resolvedAgeDays?: number
): Promise<string> {
  const result = await pg.query(
    `INSERT INTO incidents ("monitorId", status, description, "startedAt", "resolvedAt")
     VALUES ($1, $2, 'Monitor went down. Status code: 500',
             ((now() AT TIME ZONE 'utc') - interval '120 days'),
             CASE WHEN $2 = 'RESOLVED'
                  THEN ((now() AT TIME ZONE 'utc') - (${resolvedAgeDays ?? 0}::int * interval '1 day'))
                  ELSE NULL END)
     RETURNING id`,
    [monitorId, status]
  );
  return result.rows[0].id as string;
}

async function countRows(table: "pings" | "incidents" | "monitors"): Promise<number> {
  const result = await pg.query(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0].n as number;
}

async function storedUptimePercent(monitorId: number): Promise<number> {
  const result = await pg.query(`SELECT "uptimePercent" AS p FROM monitors WHERE id = $1`, [monitorId]);
  return result.rows[0].p as number;
}

/** Per-case Redis hygiene: only the maintenance lane's keys (03-01 rule). */
async function flushMaintenanceQueueKeys(): Promise<void> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await admin.scan(cursor, "MATCH", "bull:maintenance:*", "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length > 0) await admin.del(...keys);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor: condition not met within timeout");
}

const cleanupJob = (data: unknown) => ({ id: `maintenance-test-${crypto.randomUUID().slice(0, 8)}`, name: "cleanup", data });

/** Renders a drizzle sql`` template's raw text chunks (test-only routing key). */
function sqlText(query: SQL): string {
  const chunks = (query as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk === null || chunk === undefined) return "";
      const value = (chunk as { value?: unknown }).value;
      if (Array.isArray(value)) return value.join("");
      if (typeof chunk === "string") return chunk;
      return "";
    })
    .join("");
}

beforeAll(async () => {
  admin = new Redis(process.env.REDIS_URL!);
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  queues = createWorkerQueues(new Redis(process.env.REDIS_URL!));
  await pg.query("TRUNCATE pings, incidents, monitors, users, outbox, write_guards CASCADE");
  testUserId = await seedUser();
});

afterAll(async () => {
  await pg.query("TRUNCATE pings, incidents, monitors, users, outbox, write_guards CASCADE");
  await queues.close().catch(() => {});
  await pg.end();
  await admin.quit();
});

beforeEach(async () => {
  await pg.query("TRUNCATE pings, incidents, monitors, users, outbox, write_guards CASCADE");
  testUserId = await seedUser();
  await flushMaintenanceQueueKeys();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("maintenance lane — WRK-13 / DAT-08 / D-37", () => {
  it(
    "1. source pins: constants, batched DELETE form, dry-run default, loud unknown name, lane wiring",
    async () => {
      expect(RETENTION_BATCH).toBe(5000);
      expect(PING_RETENTION_DAYS).toBe(30); // cleanup-logic parity
      expect(INCIDENT_RETENTION_DAYS).toBe(90); // cleanup-logic parity
      expect(WRITE_GUARD_RETENTION_DAYS).toBe(7);

      const source = readFileSync("src/worker/maintenance.ts", "utf8");
      // The batched form: id IN (subselect ... LIMIT RETENTION_BATCH) on BOTH
      // delete statements (DAT-08) — anchored to the DELETE lines so prose in
      // comments cannot match.
      expect(source.match(/DELETE FROM \w+\s*\n\s*WHERE id IN \(/g)).toHaveLength(2);
      expect(source.match(new RegExp(`LIMIT \\$\\{RETENTION_BATCH\\}`, "g"))?.length).toBeGreaterThanOrEqual(2);
      expect(source).toContain("status = 'RESOLVED'"); // ONGOING incidents never eligible
      // Retention horizons use the cleanup-logic constants, not literals.
      expect(source).toContain("${PING_RETENTION_DAYS}::int * interval '1 day'");
      expect(source).toContain("${INCIDENT_RETENTION_DAYS}::int * interval '1 day'");
      // Never pausing a queue anywhere in the lane.
      expect(source).not.toMatch(/\.pause\s*\(/);

      // WRK-13: dry-run is the DEFAULT — an absent flag writes nothing.
      const report = await processMaintenanceJob(cleanupJob({}), { redis: admin, logger: fakeLogger() });
      expect(report.dryRun).toBe(true);
      expect(report.pings.deleted).toBe(0);
      expect(report.pings.batches).toEqual([]);

      // Unknown job names are loud, never silent skips.
      await expect(
        processMaintenanceJob({ name: "not-cleanup", data: {} }, { redis: admin, logger: fakeLogger() })
      ).rejects.toThrow(/unknown maintenance job name 'not-cleanup'/);

      // Lane wiring: the relay-pass scheduler rides the alerts lane at the
      // pinned cadence (Rule-2 deviation, documented); both lane workers are
      // registered at boot; the outbox gauges ride /metrics.json.
      const schedulerSource = readFileSync("src/worker/scheduler.ts", "utf8");
      expect(schedulerSource).toContain(`export const OUTBOX_RELAY_SCHEDULER_ID = "${OUTBOX_RELAY_SCHEDULER_ID}"`);
      expect(schedulerSource).toContain("queues.alerts.upsertJobScheduler");
      expect(schedulerSource).toContain("{ every: RELAY_PASS_EVERY_MS }");
      expect(schedulerSource).toContain(`"${OUTBOX_RELAY_SCHEDULER_ID}"`);

      const queuesSource = readFileSync("src/worker/queues.ts", "utf8");
      expect(queuesSource).toContain("export function startAlertsLaneWorker");
      expect(queuesSource).toContain("export function startMaintenanceLaneWorker");
      expect(queuesSource).toContain("export async function enqueueMaintenance");
      expect(queuesSource).not.toMatch(/\.pause\s*\(/);

      const indexSource = readFileSync("src/worker/index.ts", "utf8");
      expect(indexSource).toContain("startAlertsLaneWorker");
      expect(indexSource).toContain("startMaintenanceLaneWorker");
      expect(indexSource).toContain("outbox: await collectOutboxMetrics()");

      expect(ALERTS_LANE_CONCURRENCY).toBe(1);
      expect(MAINTENANCE_LANE_CONCURRENCY).toBe(1); // D-7: deletes never parallelize
      expect(MAINTENANCE_JOB_OPTIONS.priority).toBe(5);
      expect(RELAY_PASS_EVERY_MS).toBe(5_000);
    },
    20_000
  );

  it(
    "2. dry run: per-monitor deletable counts, the D-37 audit flags exactly the corrupted monitor, ZERO writes",
    async () => {
      // A: consistent (10 checks / 5 failed -> derived 50.00, stored 50).
      const monitorA = await seedMonitor({ totalChecks: 10, failedChecks: 5, uptimePercent: 50 });
      // B: corrupted (100 / 50 -> derived 50.00, stored 75.5).
      const monitorB = await seedMonitor({ totalChecks: 100, failedChecks: 50, uptimePercent: 75.5 });
      // C: zero checks — nothing to derive, excluded from the audit.
      const monitorC = await seedMonitor({ totalChecks: 0, failedChecks: 0, uptimePercent: 100 });

      // Pings: A 3 old + 2 fresh; B 2 old + 1 fresh.
      await seedPings(monitorA, 3, 31);
      await seedPings(monitorA, 2, 3);
      await seedPings(monitorB, 2, 40);
      await seedPings(monitorB, 1, 3);

      // Incidents: one RESOLVED 100 days old (deletable), one RESOLVED 10
      // days old (kept), one ONGOING (NEVER eligible — T-04-27).
      await seedIncident(monitorA, "RESOLVED", 100);
      await seedIncident(monitorA, "RESOLVED", 10);
      const ongoingId = await seedIncident(monitorA, "ONGOING");

      const before = {
        pings: await countRows("pings"),
        incidents: await countRows("incidents"),
        monitors: await countRows("monitors"),
        a: await storedUptimePercent(monitorA),
        b: await storedUptimePercent(monitorB),
        c: await storedUptimePercent(monitorC),
      };
      expect(before.pings).toBe(8);
      expect(before.incidents).toBe(3);
      expect(before.monitors).toBe(3);

      const report = await processMaintenanceJob(cleanupJob({ dryRun: true }), {
        redis: admin,
        logger: fakeLogger(),
      });

      // Per-monitor deletable counts, ordered by monitor id.
      expect(report.pings.perMonitor).toEqual([
        { monitorId: monitorA, deletable: 3 },
        { monitorId: monitorB, deletable: 2 },
      ]);
      expect(report.pings.totalDeletable).toBe(5);
      expect(report.pings.deleted).toBe(0);
      expect(report.incidents.deletable).toBe(1);
      expect(report.incidents.deleted).toBe(0);

      // D-37: exactly the corrupted monitor flagged, with stored/derived/delta.
      expect(report.audit.checked).toBe(2); // A + B; C has zero checks
      expect(report.audit.discrepancies).toEqual([
        { monitorId: monitorB, stored: 75.5, derived: 50, delta: 25.5 },
      ]);

      // Observations present (read-only; numbers vary with the shared Redis).
      expect(typeof report.redis.bullKeyCount).toBe("number");
      expect(typeof report.redis.writeGuardsOverHorizon).toBe("number");
      expect(report.redis.writeGuardHorizonDays).toBe(WRITE_GUARD_RETENTION_DAYS);

      // ZERO writes: counts and stored percentages unchanged.
      expect(await countRows("pings")).toBe(before.pings);
      expect(await countRows("incidents")).toBe(before.incidents);
      expect(await countRows("monitors")).toBe(before.monitors);
      expect(await storedUptimePercent(monitorA)).toBe(before.a);
      expect(await storedUptimePercent(monitorB)).toBe(before.b);
      expect(await storedUptimePercent(monitorC)).toBe(before.c);

      // The standalone export (Phase 5 reuses it during the overlap window).
      const standalone = await runConsistencyAudit();
      expect(standalone.checked).toBe(2);
      expect(standalone.discrepancies).toEqual([
        { monitorId: monitorB, stored: 75.5, derived: 50, delta: 25.5 },
      ]);

      // The ONGOING incident is still there.
      const ongoing = await pg.query(`SELECT id FROM incidents WHERE id = $1`, [ongoingId]);
      expect(ongoing.rows).toHaveLength(1);
    },
    20_000
  );

  it(
    "3. real run: 5015 beyond-horizon pings delete in [5000, 15] batches, fresh rows untouched, ONGOING never eligible",
    async () => {
      const monitor = await seedMonitor({ totalChecks: 5, failedChecks: 1, uptimePercent: 80 });
      await seedPings(monitor, 5015, 40); // beyond the 30-day horizon
      await seedPings(monitor, 3, 3); // fresh — must survive
      const oldResolvedId = await seedIncident(monitor, "RESOLVED", 100);
      const recentResolvedId = await seedIncident(monitor, "RESOLVED", 10);
      const ongoingId = await seedIncident(monitor, "ONGOING");

      const logger = fakeLogger();
      const report = await processMaintenanceJob(cleanupJob({ dryRun: false }), {
        redis: admin,
        logger,
      });

      // Every statement capped at RETENTION_BATCH; the 5015 rows took exactly
      // two passes: 5000 then the 15-row remainder.
      expect(report.dryRun).toBe(false);
      expect(report.pings.deleted).toBe(5015);
      expect(report.pings.batches).toEqual([5000, 15]);
      for (const batch of report.pings.batches) {
        expect(batch).toBeLessThanOrEqual(RETENTION_BATCH);
      }

      // D-18 (06-04): the real pass logs its deleted-row counts — the
      // structured summary line carries both tables' deleted numbers for the
      // job log / operator.
      const summaryLine = logger.info.mock.calls
        .map((call) => JSON.stringify(call))
        .find((line) => line.includes("maintenance REAL run complete"));
      expect(summaryLine).toBeDefined();
      expect(summaryLine).toContain('"deletedPings":5015');
      expect(summaryLine).toContain('"deletedIncidents":1');

      // Incidents: only the 100-day RESOLVED went; recent RESOLVED and the
      // ONGOING incident survive (T-04-27).
      expect(report.incidents.deleted).toBe(1);
      expect(report.incidents.batches).toEqual([1]);
      expect(await countRows("pings")).toBe(3);
      const survivors = await pg.query(`SELECT id FROM incidents`);
      const survivorIds = survivors.rows.map((r) => r.id as string);
      expect(survivorIds).toContain(recentResolvedId);
      expect(survivorIds).toContain(ongoingId);
      expect(survivorIds).not.toContain(oldResolvedId);

      // The survivors are the FRESH pings (all younger than the horizon).
      const remainingAges = await pg.query(
        `SELECT EXTRACT(DAY FROM ((now() AT TIME ZONE 'utc') - "createdAt"))::int AS age FROM pings`
      );
      expect(remainingAges.rows).toHaveLength(3);
      for (const row of remainingAges.rows) {
        expect(row.age).toBeLessThan(PING_RETENTION_DAYS);
      }
    },
    60_000
  );

  it(
    "4. D-16: flag off — zero scheduler upserts, yet a manual enqueueMaintenance processes on the real lane worker",
    async () => {
      // The dark-launch posture: scheduling is OFF (the exact parse index.ts
      // applies — anything but the literal string "true" means disabled).
      expect(process.env.WORKER_SCHEDULER_ENABLED === "true").toBe(false);
      const schedulerResult = await upsertSchedulersAtBoot({ schedulerEnabled: false, queues });
      expect(schedulerResult.upserted).toEqual([]);
      expect(await queues.maintenance.getJobSchedulers()).toEqual([]);

      // The manual path still works and the always-live consumer processes it.
      const { dryRun, priority, job } = await enqueueMaintenance({ dryRun: true }, { maintenanceQueue: queues.maintenance });
      expect(dryRun).toBe(true);
      expect(priority).toBe(5);
      const laneJob = job as Job;

      const worker = startMaintenanceLaneWorker((j) => processMaintenanceJob(j, { redis: admin, logger: fakeLogger() }));
      try {
        await waitFor(async () => (await laneJob.getState()) === "completed");
        expect(await laneJob.getState()).toBe("completed");
        // Job instances do not live-refresh returnvalue — re-fetch the job
        // for the processor's report.
        const fresh = await queues.maintenance.getJob(laneJob.id ?? "");
        expect((fresh?.returnvalue as { dryRun: boolean }).dryRun).toBe(true);
      } finally {
        await worker.close();
      }

      // Processing consumed the job but created ZERO recurring schedulers —
      // the D-16 invariant.
      expect(await queues.maintenance.getJobSchedulers()).toEqual([]);
    },
    20_000
  );

  it(
    "5. D-18 (06-04): a throwing real pass logs at ERROR level and rethrows — never a silent failure",
    async () => {
      const monitor = await seedMonitor({ totalChecks: 1, failedChecks: 0, uptimePercent: 100 });
      await seedPings(monitor, 2, 40); // beyond the 30-day horizon — eligible

      // TEST-ONLY seam (04-08 discipline): wrap the real workerDb and inject
      // the failure exactly at the pings DELETE statement. Everything before
      // it (the deletable counts, D-37 audit, write_guards observation) runs
      // against the real test database.
      const failingDb = {
        execute: async (query: SQL) => {
          if (sqlText(query).includes("DELETE FROM pings")) {
            throw new Error("injected pings DELETE failure (D-18 error-path pin)");
          }
          return workerDb.execute(query);
        },
      };

      const logger = fakeLogger();
      await expect(
        processMaintenanceJob(cleanupJob({ dryRun: false }), {
          db: failingDb as unknown as NodePgDatabase<typeof schema>,
          redis: admin,
          logger,
        })
      ).rejects.toThrow(/injected pings DELETE failure/);

      // D-18: the failure is LOUD — one error-level line naming the job and
      // the partial state, before the rethrow that drives BullMQ's retry.
      const errLine = logger.error.mock.calls
        .map((call) => JSON.stringify(call))
        .find((line) => line.includes("maintenance REAL run FAILED"));
      expect(errLine).toBeDefined();
      expect(errLine).toContain('"dryRun":false');
      expect(errLine).toContain("injected pings DELETE failure");

      // Zero silent partial loss: the injected failure fired on the FIRST
      // pings batch, so nothing was deleted.
      expect(await countRows("pings")).toBe(2);

      // No success summary for a failed pass.
      const successLine = logger.info.mock.calls
        .map((call) => JSON.stringify(call))
        .find((line) => line.includes("maintenance REAL run complete"));
      expect(successLine).toBeUndefined();
    },
    20_000
  );
});
