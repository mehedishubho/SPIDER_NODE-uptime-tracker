import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Redis from "ioredis";
import { Client } from "pg";
import {
  claimedCheckJobId,
  collectQueueMetrics,
  createWorkerQueues,
  LANE_PRIORITY,
  noteStalledEvent,
  QUEUE_NAMES,
} from "@/worker/queues";
import type { WorkerQueueSet } from "@/worker/queues";
import { resetBacklogDropCount } from "@/worker/backlog";
import {
  CHECK_TICK_EVERY_MS,
  CHECK_TICK_SCHEDULER_ID,
  MAINTENANCE_CLEANUP_PATTERN,
  MAINTENANCE_CLEANUP_SCHEDULER_ID,
  processTick,
  startTickWorker,
  upsertSchedulersAtBoot,
} from "@/worker/scheduler";
import { startHealthServer } from "@/worker/health";

// ---------------------------------------------------------------------------
// Scheduler-flag proof suite (WRK-10 / D-16 / RES-05, audit §14.2) against
// the REAL docker test stack — the flag mechanic and the scheduler
// convergence are BullMQ/Redis storage semantics, only provable live.
//
// Pins:
//   1. flag false -> ZERO schedulers on BOTH queues, yet the tick-lane
//      consumer still processes a manually enqueued job (D-16: flag gates
//      SCHEDULING only — never a paused queue, Pitfall 12)
//   2. flag true -> exactly one check-tick + TWO maintenance-lane schedulers
//      (the 03:15 cleanup + the 04:00 windowed-uptime recompute, DAT-11);
//      re-upsert is idempotent; after a simulated Redis restart (flush) the
//      next boot re-declares, still exactly one per id (RES-05);
//      the cleanup template carries DRYRUN FALSE (D-14, 06-04) — the daily
//      03:15 pass runs REAL retention deletes, restoring legacy daily-cleanup
//      parity (05-REVIEW WR-03); the recompute template carries an EMPTY
//      payload — its write posture is structural (D-22: unconditional from
//      ship, no dry-run form)
//   3. processTick assigns lanes through the real claim: UP -> priority 10,
//      non-UP -> priority 1, jobId = check:{monitorId}:{claim-epoch}
//   4. /metrics.json carries the queue section (per-lane depth, head-waiting
//      age, stalled counter, backlog drop counter — OBS-01)
//   5. source form: no queue pausing anywhere in the boot flow; the upsert
//      templates pin no custom job key (Pitfall 11)
// ---------------------------------------------------------------------------

let admin: Redis;
let pg: Client;
let queues: WorkerQueueSet;
let testUserId: string;

async function flushQueueKeys(prefix: string): Promise<void> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await admin.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length > 0) await admin.del(...keys);
}

async function seedMonitor(opts: { status: string; nextCheckAt: Date }): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval, next_check_at, "updatedAt")
     VALUES ($1, $2, $3, $4, true, 5, $5, now()) RETURNING id`,
    [
      "https://example.com",
      `sched-test-${crypto.randomUUID()}`,
      testUserId,
      opts.status,
      opts.nextCheckAt.toISOString(),
    ]
  );
  return result.rows[0].id as number;
}

async function fetchNextCheckAt(monitorId: number): Promise<Date> {
  const result = await pg.query(`SELECT next_check_at FROM monitors WHERE id = $1`, [monitorId]);
  return new Date(result.rows[0].next_check_at as string);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor: condition not met within timeout");
}

beforeAll(async () => {
  admin = new Redis(process.env.REDIS_URL!);
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`sched-test-${crypto.randomUUID()}@example.test`]
  );
  testUserId = user.rows[0].id as string;
  queues = createWorkerQueues(new Redis(process.env.REDIS_URL!));
});

afterAll(async () => {
  // Leave the tables clean for the files that run after this one.
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE users CASCADE");
  await queues.close().catch(() => {});
  await pg.end();
  await admin.quit();
});

beforeEach(async () => {
  await flushQueueKeys("bull:monitor-scheduler:");
  await flushQueueKeys("bull:maintenance:");
  await flushQueueKeys("bull:monitor-checks:");
  await flushQueueKeys("bull:db-writes:");
  await flushQueueKeys("bull:alerts:");
  resetBacklogDropCount();
});

describe("scheduler flag + tick lane (WRK-10 / D-16 / RES-05)", () => {
  it(
    "1. flag FALSE: zero schedulers on both queues, yet the tick-lane consumer still processes a manual job (D-16, Pitfall 12)",
    async () => {
      const result = await upsertSchedulersAtBoot({ schedulerEnabled: false, queues });
      expect(result.upserted).toEqual([]);
      expect(await queues.scheduler.getJobSchedulers()).toEqual([]);
      expect(await queues.maintenance.getJobSchedulers()).toEqual([]);

      // Consumers stay LIVE: an operator smoke enqueue runs end-to-end.
      const worker = startTickWorker({ queues });
      try {
        const job = await queues.scheduler.add(
          "check-tick",
          {},
          { priority: LANE_PRIORITY.tick, attempts: 1, removeOnComplete: { age: 300 } }
        );
        await waitFor(async () => (await job.getState()) === "completed");
        expect(await job.getState()).toBe("completed");
      } finally {
        await worker.close();
      }

      // The dark-launch invariant: processing consumed the job but created
      // ZERO recurring schedulers.
      expect(await queues.scheduler.getJobSchedulers()).toEqual([]);
    },
    20_000
  );

  it(
    "2. flag TRUE: exactly one check-tick + TWO maintenance-lane schedulers (cleanup + windowed recompute); idempotent re-upsert; Redis-wipe re-declare stays (RES-05)",
    async () => {
      await upsertSchedulersAtBoot({ schedulerEnabled: true, queues });

      // JobSchedulerJson's stable identity field is `key` (bullmq 6: the
      // optional `id` is the delayed job's id, absent until materialized).
      const tickSchedulers = await queues.scheduler.getJobSchedulers();
      expect(tickSchedulers).toHaveLength(1);
      expect(tickSchedulers[0].key).toBe(CHECK_TICK_SCHEDULER_ID);
      expect(tickSchedulers[0].name).toBe("check-tick");
      expect(tickSchedulers[0].every).toBe(CHECK_TICK_EVERY_MS);

      // DAT-11 (08-01): the maintenance lane carries TWO schedulers — the
      // 03:15 cleanup AND the 04:00 windowed-uptime recompute (a separated
      // pattern so retention deletes never delay the recompute on the
      // concurrency-1 lane; research OQ2). Five schedulers total.
      const maintenanceSchedulers = await queues.maintenance.getJobSchedulers();
      expect(maintenanceSchedulers).toHaveLength(2);
      const cleanup = maintenanceSchedulers.find((s) => s.key === MAINTENANCE_CLEANUP_SCHEDULER_ID);
      const recompute = maintenanceSchedulers.find((s) => s.key === "recompute-windowed-uptime");
      expect(cleanup).toBeDefined();
      expect(recompute).toBeDefined();
      expect(cleanup?.pattern).toBe(MAINTENANCE_CLEANUP_PATTERN);
      expect(recompute?.pattern).toBe("0 4 * * *");
      expect(recompute?.pattern).not.toBe(MAINTENANCE_CLEANUP_PATTERN);
      expect(recompute?.name).toBe("recompute-windowed-uptime");
      // The dryRun-false note applies to the CLEANUP only: the recompute's
      // write posture is structural (D-22 — unconditional from ship, no
      // dry-run form), so its template payload is empty. BullMQ 6 omits
      // template.data entirely for an empty payload — `?? {}` normalizes
      // that storage form (the pin is "no payload / no dryRun flag").
      expect(cleanup?.template?.data).toEqual({ dryRun: false });
      expect(recompute?.template?.data ?? {}).toEqual({});

      // Exactly five schedulers across all lanes: 1 tick + 2 maintenance
      // + 1 flush sweep + 1 relay pass.
      expect(await queues.dbWrites.getJobSchedulers()).toHaveLength(1);
      expect(await queues.alerts.getJobSchedulers()).toHaveLength(1);

      // Idempotent: a second boot (concurrent or restart) converges — still
      // exactly one scheduler per id, at most one delayed job per scheduler.
      await upsertSchedulersAtBoot({ schedulerEnabled: true, queues });
      expect(await queues.scheduler.getJobSchedulers()).toHaveLength(1);
      expect(await queues.maintenance.getJobSchedulers()).toHaveLength(2);

      // RES-05: Redis restarted (schedulers wiped) — the next boot
      // re-declares, and upsert convergence keeps it at exactly one.
      await flushQueueKeys("bull:monitor-scheduler:");
      expect(await queues.scheduler.getJobSchedulers()).toHaveLength(0);
      await upsertSchedulersAtBoot({ schedulerEnabled: true, queues });
      const redeclared = await queues.scheduler.getJobSchedulers();
      expect(redeclared).toHaveLength(1);
      expect(redeclared[0].key).toBe(CHECK_TICK_SCHEDULER_ID);
      // The maintenance lane re-declares BOTH schedulers.
      expect(await queues.maintenance.getJobSchedulers()).toHaveLength(2);
    },
    20_000
  );

  it(
    "3. processTick: claim -> lane assignment UP -> priority 10, non-UP -> priority 1, jobId from the claim epoch",
    async () => {
      const upId = await seedMonitor({ status: "UP", nextCheckAt: new Date(Date.now() - 2_000) });
      const downId = await seedMonitor({ status: "DOWN", nextCheckAt: new Date(Date.now() - 3_000) });

      const result = await processTick({ queues });
      expect(result.claimed).toBeGreaterThanOrEqual(2);
      expect(result.enqueued + result.dropped + result.failed).toBe(result.claimed);

      // Read each monitor's just-advanced next_check_at, derive the expected
      // jobId, and prove the STORED job carries the lane priority.
      const upJob = await queues.checks.getJob(claimedCheckJobId(upId, await fetchNextCheckAt(upId)));
      expect(upJob?.opts.priority).toBe(LANE_PRIORITY.routineCheck);

      const downJob = await queues.checks.getJob(claimedCheckJobId(downId, await fetchNextCheckAt(downId)));
      expect(downJob?.opts.priority).toBe(LANE_PRIORITY.nonUpCheck);

      // Idempotent second tick over the same data: everything is advanced
      // past now, so nothing new is claimed.
      const second = await processTick({ queues });
      expect(second.claimed).toBe(0);
    },
    20_000
  );

  it(
    "4. /metrics.json carries the queue section: per-lane depth, head-waiting age, stalled counter, backlog drops (OBS-01)",
    async () => {
      noteStalledEvent(QUEUE_NAMES.checks); // in-process Worker event counter
      await queues.checks.add(
        "check",
        { monitorId: 1 },
        { priority: 10, jobId: `metrics-probe-${Date.now()}` }
      );

      const metricsRedis = new Redis(process.env.REDIS_URL!);
      const server = await startHealthServer({
        port: 0,
        redis: metricsRedis,
        pool: { query: (text: string) => pg.query(text) },
        queueMetrics: () => collectQueueMetrics(queues),
      });
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/metrics.json`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          queues: Record<
            string,
            {
              depth: Record<string, number>;
              oldestWaitingJobAgeMs: number | null;
              stalledCount: number;
            }
          >;
          backlogDrops: number;
        };

        // All six lanes report a gauge.
        for (const name of Object.values(QUEUE_NAMES)) {
          expect(body.queues[name]).toBeDefined();
        }

        const checks = body.queues[QUEUE_NAMES.checks];
        // The probe job carries priority 10, so BullMQ files it in the
        // PRIORITIZED set (a priority-carrying job never sits in plain wait)
        // — the depth gauge must see it there.
        expect(checks.depth.prioritized).toBeGreaterThanOrEqual(1);
        expect(checks.depth.wait + checks.depth.prioritized).toBeGreaterThanOrEqual(1);
        expect(checks.oldestWaitingJobAgeMs).toBeGreaterThanOrEqual(0); // probe is the oldest pending
        expect(checks.stalledCount).toBeGreaterThanOrEqual(1); // noted above
        expect(body.backlogDrops).toBe(0); // reset in beforeEach, none dropped
      } finally {
        await server.shutdown();
      }
    },
    20_000
  );

  it(
    "5. source form: no queue pausing in the boot flow; upsert templates pin no custom job key (Pitfall 11 / Pitfall 12)",
    () => {
      const schedulerSource = readFileSync("src/worker/scheduler.ts", "utf8");
      const indexSource = readFileSync("src/worker/index.ts", "utf8");

      // Pitfall 12: dark launch must gate SCHEDULING, never pause a queue
      // (a paused queue blocks operator smoke enqueues too).
      expect(schedulerSource).not.toMatch(/\.pause\s*\(/);
      expect(indexSource).not.toMatch(/\.pause\s*\(/);

      // Pitfall 11: JobSchedulerTemplateOptions drops job ids — the template
      // must not attempt to pin one.
      expect(schedulerSource).not.toMatch(/jobId\s*:/);

      // D-16 wiring: the boot flow reads the flag.
      expect(indexSource).toContain("WORKER_SCHEDULER_ENABLED");
    },
    15_000
  );

  it(
    "6. flag-off boot produces ZERO autonomous pings — the dead-man wiring rides inert (D-37 alignment)",
    async () => {
      // The 05-02 dead-man checks (heartbeat/outbox-age/memory) are wired on
      // processTick, NOT gated on the D-16 flag: inertness is structural —
      // flag off means no schedulers are upserted, so no scheduler path can
      // ever invoke processTick and no ping is ever issued. This case proves
      // that posture by simulation: boot the module's exported surface with
      // the flag off while all three ping URLs are armed, and assert zero
      // global-fetch calls.
      //
      // This inertness is exactly why the REAL healthchecks.io checks are
      // provisioned at window-open (D-37), not at the add-release deploy: an
      // add-release soak is scheduler-off, so provisioning early would leave
      // three live checks receiving silence and false-paging through their
      // graces before the window ever opens.
      const saved: Record<string, string | undefined> = {};
      for (const key of [
        "WORKER_HC_PING_URL",
        "WORKER_OUTBOX_HC_PING_URL",
        "WORKER_MEMORY_HC_PING_URL",
      ]) {
        saved[key] = process.env[key];
      }
      process.env.WORKER_HC_PING_URL = "https://hc.example.test/flag-off-heartbeat-mock";
      process.env.WORKER_OUTBOX_HC_PING_URL = "https://hc.example.test/flag-off-outbox-mock";
      process.env.WORKER_MEMORY_HC_PING_URL = "https://hc.example.test/flag-off-memory-mock";

      const fetchMock = vi.fn(async () => new Response("OK"));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const result = await upsertSchedulersAtBoot({ schedulerEnabled: false, queues });
        expect(result.upserted).toEqual([]);

        // No scheduler exists on any lane — nothing can autonomously fire a
        // tick. (The tick-lane CONSUMER stays live by design, D-16/Pitfall
        // 12 — but only a manual enqueue reaches it, never a boot path.)
        expect(await queues.scheduler.getJobSchedulers()).toEqual([]);
        expect(await queues.maintenance.getJobSchedulers()).toEqual([]);

        // The dark-launch invariant, ping edition: zero autonomous pings.
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    15_000
  );
});
