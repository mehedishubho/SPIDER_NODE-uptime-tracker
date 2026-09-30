import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import Redis from "ioredis";
import { DENYLIST, performCheck } from "@/lib/ssrf";
import type { CheckOutcome, CheckRequest } from "@/lib/ssrf";
import { startCheckTarget } from "../lib/helpers/check-target-server";
import type { CheckTargetHandle } from "../lib/helpers/check-target-server";
import { FLUSH_JOB_DELAY_MS, fromLaneJob, makeFlushProcessor, processCheckJob } from "@/worker/engine/check";
import type { CheckJobResult, ProcessCheckDeps } from "@/worker/engine/check";
import { acquireMonitorLock, disposeLocksRedis, lockKey } from "@/worker/locks";
import { resetBreaker, state as breakerState } from "@/worker/breaker";
import {
  createWorkerQueues,
  enqueueClaimedCheck,
  enqueueManualCheck,
  flushJobId,
  LANE_PRIORITY,
  startCheckLaneWorker,
} from "@/worker/queues";
import type { LaneWorkerHandle, WorkerQueueSet } from "@/worker/queues";
import { disposeStagingRedis, stagingKey } from "@/worker/persist/tier2";

// ---------------------------------------------------------------------------
// Check-processor proof suite (WRK-01 / WRK-05 / RES-01, audit §15.1 + §16)
// against the REAL docker Postgres (:5453) + Redis (:6390) and the 04-03
// fixture target server — the lock/lane/flush composition is only provable
// live. The fixture binds ::1, so the check function rides the documented
// CheckRequest TEST-ONLY seam (denylist omitting exactly the ::1 token —
// production callers never set it; pinned structurally in case 1).
//
// Pins:
//   1. source form — url always from the monitors row (T-04-22), no denylist
//      in production code, lock re-verify before the Tier 1 commit (T-04-21),
//      flush delay <= 60 s cadence, 3-segment flush jobId, lane/breaker wiring
//      in index.ts + scheduler.ts
//   2. routine UP end-to-end (D-18): real enqueue -> real check-lane Worker ->
//      Tier-2 staging + DELAYED guarded flush job (priority 5, batchId minted
//      at enqueue) -> flush processor applies -> ONE ping row, with the
//      scheduler NEVER enabled (zero Job Schedulers)
//   3. DOWN (1-strike): synchronous Tier 1 — status DOWN, evidence ping with
//      error_class/status_code, ONGOING incident, outbox incident.down
//   4. PENDING -> UP first_check (Tier 1) + manual UP-on-UP (synchronous
//      evidence ping, applied:false non-transition)
//   5. lock held by another executor: zero writes
//   6. lock lost before the Tier 1 commit: abort, zero writes (J-3/T-04-21)
//   7. missing/inactive monitor: successful no-ops
//   8. infra failure: job rejects (BullMQ retry path) + breaker counts it
//   9. dbWrites dispatch: flush-sweep benign on empty, unknown/malformed loud
//  10. G-06-2: repeat MANUAL check on an UP monitor persists in-job — the
//      §16.2 additive follow-up advances lastChecked past the enqueue epoch
//      (D-01 poll predicate) and counters by one, never staged
//  11. G-06-2: repeat MANUAL check on a DOWN monitor persists the same way
//      (failedChecks +1) with zero fabricated incidents/outbox rows
//  12. WR-01: monitor deactivated mid-job — the manual non-transition
//      follow-up is requireActive-gated, so the paused monitor records
//      NOTHING beyond its evidence ping (matching tier1's transition guard)
// ---------------------------------------------------------------------------

const TEST_DENYLIST = DENYLIST.filter((token) => token !== "::1");

function testPerformCheck(req: CheckRequest): Promise<CheckOutcome> {
  return performCheck({ ...req, denylist: TEST_DENYLIST });
}

let pg: Client;
let admin: Redis;
let queues: WorkerQueueSet;
let target: CheckTargetHandle;
let testUserId: string;

interface MonitorRow {
  status: string;
  "totalChecks": number;
  "failedChecks": number;
  "lastChecked": string | Date | null;
  "responseTime": number | null;
}

interface PingRow {
  status: string;
  "responseTime": number;
  error_class: string | null;
  status_code: number | null;
}

async function seedMonitor(opts: {
  url: string;
  status?: string;
  interval?: number;
  isActive?: boolean;
  totalChecks?: number;
}): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval,
       "totalChecks", "failedChecks", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, now()) RETURNING id`,
    [
      opts.url,
      `engine-test-${crypto.randomUUID().slice(0, 8)}`,
      testUserId,
      opts.status ?? "UP",
      opts.isActive ?? true,
      opts.interval ?? 5,
      opts.totalChecks ?? 0,
    ]
  );
  return result.rows[0].id as number;
}

async function fetchMonitor(id: number): Promise<MonitorRow | undefined> {
  const result = await pg.query(
    `SELECT status, "totalChecks", "failedChecks", "lastChecked", "responseTime"
     FROM monitors WHERE id = $1`,
    [id]
  );
  return result.rows[0] as MonitorRow | undefined;
}

async function fetchPings(monitorId: number): Promise<PingRow[]> {
  const result = await pg.query(
    `SELECT status, "responseTime", error_class, status_code FROM pings
     WHERE "monitorId" = $1 ORDER BY "createdAt" ASC`,
    [monitorId]
  );
  return result.rows as PingRow[];
}

async function fetchOngoingIncident(monitorId: number) {
  const result = await pg.query(
    `SELECT id, status, description FROM incidents WHERE "monitorId" = $1 AND status = 'ONGOING'`,
    [monitorId]
  );
  return result.rows[0] as { id: string; status: string; description: string } | undefined;
}

async function fetchOutbox(monitorId: number) {
  const result = await pg.query(
    `SELECT event_type, incident_id FROM outbox WHERE monitor_id = $1`,
    [monitorId]
  );
  return result.rows as Array<{ event_type: string; incident_id: string | null }>;
}

async function flushKeyPattern(pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await admin.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = next;
    if (keys.length > 0) await admin.del(...keys);
  } while (cursor !== "0");
}

/**
 * Starts the REAL check-lane worker (concurrency 1 for determinism) over the
 * test's queue set, capturing each processed job's CheckJobResult.
 */
function captureLane(extraDeps: ProcessCheckDeps = {}): {
  lane: LaneWorkerHandle;
  nextResult(): Promise<CheckJobResult>;
} {
  const waiting: Array<(r: CheckJobResult) => void> = [];
  const done: CheckJobResult[] = [];
  const lane = startCheckLaneWorker(
    async (job) => {
      const result = await processCheckJob(fromLaneJob(job), {
        performCheck: testPerformCheck,
        ...extraDeps,
      });
      const resolve = waiting.shift();
      if (resolve) resolve(result);
      else done.push(result);
      return result;
    },
    { concurrency: 1 }
  );
  return {
    lane,
    nextResult: () =>
      done.length > 0
        ? Promise.resolve(done.shift()!)
        : new Promise<CheckJobResult>((resolve) => waiting.push(resolve)),
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor: condition not met within timeout");
}

/** Enqueues one claimed check through the real helper and waits for completion. */
async function runOneClaimedCheck(
  monitorId: number,
  status: string,
  capture: { nextResult(): Promise<CheckJobResult> }
): Promise<{ jobId: string; result: CheckJobResult }> {
  const outcome = await enqueueClaimedCheck(
    { id: monitorId, status, nextCheckAt: new Date(Date.now() + 60_000) },
    { checksQueue: queues.checks }
  );
  expect(outcome.dropped).toBe(false);
  const job = await queues.checks.getJob(outcome.jobId);
  await waitFor(async () => (await job?.getState()) === "completed");
  return { jobId: outcome.jobId, result: await capture.nextResult() };
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  admin = new Redis(process.env.REDIS_URL!);
  await pg.connect();
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE write_guards");
  await pg.query("TRUNCATE users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`engine-test-${crypto.randomUUID()}@example.test`]
  );
  testUserId = user.rows[0].id as string;
  queues = createWorkerQueues(new Redis(process.env.REDIS_URL!));
  target = await startCheckTarget("::1");
});

afterAll(async () => {
  disposeStagingRedis();
  disposeLocksRedis();
  await target.close();
  await queues.close().catch(() => {});
  await admin.quit();
  await pg.query("TRUNCATE monitors CASCADE").catch(() => {});
  await pg.end();
});

beforeEach(async () => {
  // monitors CASCADE sweeps pings/incidents/outbox via their FKs.
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE write_guards");
  // Glob patterns need the trailing '*' — a bare 'bull:monitor-checks:'
  // matches only a key literally named that (a no-op). The wildcard form
  // clears job hashes AND the wait/prioritized/delayed/active member sets,
  // so check jobs left by OTHER suites (queue-gate tests add raw check jobs
  // without draining them) or by an interrupted run cannot survive into this
  // suite — captureLane() consumes FIFO, so a stale job would be processed
  // first as a noop-monitor-missing and hijack nextResult() (found via the
  // 04-08 verify loop; same fix as the resilience helper's QUEUE_KEY_PATTERNS).
  await flushKeyPattern("bull:monitor-checks:*");
  await flushKeyPattern("bull:db-writes:*");
  await flushKeyPattern("bull:monitor-scheduler:*");
  await flushKeyPattern("*stage:*");
  await flushKeyPattern("lock:check:*");
  resetBreaker();
});

describe("check processor — WRK-01/WRK-05/RES-01 (§15.1 + §16 routing)", () => {
  it(
    "1. source form: row-authoritative url, no production denylist, pre-commit re-verify, cadence-bounded flush delay, lane + sweep wiring",
    () => {
      const engineSource = readFileSync("src/worker/engine/check.ts", "utf8");
      // T-04-22: the checked url comes from the monitors ROW — job data is
      // never mined for anything but monitorId.
      expect(engineSource).toContain("url: monitor.url");
      expect(engineSource).not.toMatch(/data\.(url|body|target)/);
      // The denylist seam is TEST-ONLY: production code never SETS it (the
      // pin matches the property-assignment form, so prose in comments is
      // free to reference the seam by name).
      expect(engineSource).not.toMatch(/denylist\s*:/);
      // T-04-21: ownership re-verified immediately before applyTransition.
      expect(engineSource).toMatch(/isStillOwner\(\)[\s\S]{0,600}applyTransition\(/);
      // Lock lifecycle + both tiers present.
      expect(engineSource).toContain("acquireMonitorLock");
      expect(engineSource).toContain("withLockRenewal");
      expect(engineSource).toContain("stageResult");
      expect(engineSource).toContain("flushDueMonitors");
      // Breaker accounting + gate marker.
      expect(engineSource).toContain("recordResult");
      expect(engineSource).toContain("recordSuccess");
      expect(engineSource).toContain("BREAKER_GATE_MARKER");

      // Rule 9: the flush delay sits inside the 60 s Tier-2 cadence.
      expect(FLUSH_JOB_DELAY_MS).toBeGreaterThan(0);
      expect(FLUSH_JOB_DELAY_MS).toBeLessThanOrEqual(60_000);

      // 3-segment flush jobId (BullMQ 6 mandate).
      expect(flushJobId(42, 1757800000000).split(":")).toHaveLength(3);
      expect(flushJobId(42, 1757800000000)).toBe("flush:42:1757800000000");

      const indexSource = readFileSync("src/worker/index.ts", "utf8");
      expect(indexSource).toContain("startCheckLaneWorker((job) => processCheckJob(fromLaneJob(job)))");
      expect(indexSource).toContain("startDbWritesLaneWorker(makeFlushProcessor())");
      expect(indexSource).toMatch(/breaker:\s*breakerState\(\)/); // /metrics.json carries RES-01

      const schedulerSource = readFileSync("src/worker/scheduler.ts", "utf8");
      expect(schedulerSource).toContain("tier2-flush-sweep");
      expect(schedulerSource).toContain("flush-sweep");
    },
    10_000
  );

  it(
    "2. routine UP end-to-end (D-18): real worker -> Tier-2 staging -> delayed guarded flush -> ONE ping row, scheduler never enabled",
    async () => {
      const monitorId = await seedMonitor({ url: target.url("/ok"), status: "UP" });
      const capture = captureLane({ dbWritesQueue: queues.dbWrites });

      try {
        const { result } = await runOneClaimedCheck(monitorId, "UP", capture);
        expect(result.outcome).toBe("tier2");
        if (result.outcome !== "tier2") return;
        expect(result.flushJobId).toMatch(/^flush:\d+:\d+$/);
        expect(result.flushGated).toBe(false);

        // Nothing in Postgres yet — routine UP evidence is Redis-staged.
        expect(await fetchPings(monitorId)).toHaveLength(0);
        const staged = await admin.hgetall(stagingKey(monitorId));
        expect(Object.keys(staged).sort()).toEqual(["ping:1", "pingSeq"]);

        // The flush job: delayed on dbWrites, priority 5, batchId minted at
        // ENQUEUE time and derived from the SAME epoch as the jobId.
        const flushJob = await queues.dbWrites.getJob(result.flushJobId!);
        expect(flushJob).not.toBeNull();
        expect(flushJob!.opts.priority).toBe(LANE_PRIORITY.dbWrites);
        expect(flushJob!.opts.delay).toBe(FLUSH_JOB_DELAY_MS);
        expect(flushJob!.opts.attempts).toBe(5);
        expect(await flushJob!.getState()).toBe("delayed");
        const flushData = flushJob!.data as { monitorId: number; batchId: string };
        expect(flushData.monitorId).toBe(monitorId);
        expect(flushData.batchId).toMatch(/^\d+:\d+$/);
        expect(flushData.batchId).toBe(`${result.flushJobId!.split(":")[2]}:${monitorId}`);

        // D-18 dark-launch proof: ZERO recurring schedulers exist — the ping
        // row below appears with the scheduler off, purely from the lane.
        expect(await queues.scheduler.getJobSchedulers()).toEqual([]);

        // The dbWrites consumer applies the guarded flush.
        const applied = await makeFlushProcessor()({
          id: result.flushJobId!,
          name: "flush",
          data: flushData,
        });
        expect(applied).toEqual({ applied: true, skipped: null, pingsInserted: 1 });

        const monitor = (await fetchMonitor(monitorId))!;
        expect(monitor.status).toBe("UP"); // never written by Tier 2
        expect(monitor.totalChecks).toBe(1);
        expect(monitor.lastChecked).not.toBeNull();
        const pings = await fetchPings(monitorId);
        expect(pings).toHaveLength(1);
        expect(pings[0].status).toBe("UP");
        expect(pings[0].status_code).toBe(200);
        // Staging consumed by the RENAMENX handoff.
        expect(await admin.exists(stagingKey(monitorId))).toBe(0);
        // The manual-smoke shape from the plan: exactly one ping row.
      } finally {
        await capture.lane.close();
      }
    },
    30_000
  );

  it(
    "3. DOWN (1-strike): synchronous Tier 1 — status flip, evidence ping with error_class/status_code, ONGOING incident, outbox incident.down",
    async () => {
      const monitorId = await seedMonitor({ url: target.url("/error500"), status: "UP" });
      const capture = captureLane({ dbWritesQueue: queues.dbWrites });

      try {
        const { result } = await runOneClaimedCheck(monitorId, "UP", capture);
        expect(result.outcome).toBe("tier1");
        if (result.outcome !== "tier1") return;
        expect(result.targetStatus).toBe("DOWN");
        expect(result.applied).toBe(true);
        expect(result.eventType).toBe("incident.down");
        expect(result.incidentId).not.toBeNull();

        const monitor = (await fetchMonitor(monitorId))!;
        expect(monitor.status).toBe("DOWN");
        expect(monitor.totalChecks).toBe(1);
        expect(monitor.failedChecks).toBe(1);

        const pings = await fetchPings(monitorId);
        expect(pings).toHaveLength(1);
        expect(pings[0].status).toBe("DOWN");
        expect(pings[0].error_class).toBe("http_5xx");
        expect(pings[0].status_code).toBe(500);

        const incident = (await fetchOngoingIncident(monitorId))!;
        expect(incident.description).toBe("Monitor went down. Status code: 500");

        const outbox = await fetchOutbox(monitorId);
        expect(outbox).toHaveLength(1);
        expect(outbox[0].event_type).toBe("incident.down");
        expect(outbox[0].incident_id).toBe(result.incidentId);

        // Tier 1 never touches Redis staging.
        expect(await admin.exists(stagingKey(monitorId))).toBe(0);
      } finally {
        await capture.lane.close();
      }
    },
    30_000
  );

  it(
    "4. PENDING -> UP first_check (Tier 1); manual UP-on-UP is Tier 1 synchronous evidence (applied:false, ping still lands)",
    async () => {
      const pendingId = await seedMonitor({ url: target.url("/ok"), status: "PENDING" });
      const capture = captureLane({ dbWritesQueue: queues.dbWrites });

      try {
        const { result } = await runOneClaimedCheck(pendingId, "PENDING", capture);
        expect(result.outcome).toBe("tier1");
        if (result.outcome !== "tier1") return;
        expect(result.applied).toBe(true);
        expect(result.eventType).toBe("monitor.first_check");
        expect(result.incidentId).toBeNull();
        expect((await fetchMonitor(pendingId))!.status).toBe("UP");
        const outbox = await fetchOutbox(pendingId);
        expect(outbox).toHaveLength(1);
        expect(outbox[0].event_type).toBe("monitor.first_check");
        expect(outbox[0].incident_id).toBeNull();

        // Manual: the API's enqueue-and-poll UX gets its answer synchronously.
        const manualId = await seedMonitor({ url: target.url("/ok"), status: "UP", totalChecks: 3 });
        const enqueued = await enqueueManualCheck(manualId, { checksQueue: queues.checks });
        expect(enqueued.priority).toBe(LANE_PRIORITY.manualCheck);
        expect(enqueued.jobId).toMatch(/^check-manual:\d+:\d+$/);
        const manualJob = await queues.checks.getJob(enqueued.jobId);
        await waitFor(async () => (await manualJob?.getState()) === "completed");
        const manualResult = await capture.nextResult();
        expect(manualResult.outcome).toBe("tier1");
        if (manualResult.outcome !== "tier1") return;
        expect(manualResult.applied).toBe(false); // UP -> UP: no transition...
        expect(manualResult.eventType).toBeNull();
        expect((await fetchMonitor(manualId))!.status).toBe("UP");
        const manualPings = await fetchPings(manualId);
        expect(manualPings).toHaveLength(1); // ...but the evidence ping COMMITS
        expect(manualPings[0].status).toBe("UP");
        // 06-07 (G-06-2): the manual non-transition lands its fresh result via
        // the in-job §16.2 additive follow-up — counters advance by exactly 1
        // (3 -> 4), the stamp moves, and nothing is ever staged (DAT-04
        // count-once for TRANSITIONS stays intact: real transitions still
        // count exclusively in applyTransition's conditional UPDATE).
        expect((await fetchMonitor(manualId))!.totalChecks).toBe(4);
        expect((await fetchMonitor(manualId))!.lastChecked).not.toBeNull();
        expect(manualResult.manualFlushed).toBe(true);
        expect(await admin.exists(stagingKey(manualId))).toBe(0);
      } finally {
        await capture.lane.close();
      }
    },
    30_000
  );

  it(
    "5. lock held by another executor: successful no-op, zero writes",
    async () => {
      const monitorId = await seedMonitor({ url: target.url("/ok"), status: "UP" });
      const held = await acquireMonitorLock(monitorId);
      expect(held).not.toBeNull();

      try {
        const result = await processCheckJob(
          { id: `check:${monitorId}:${Math.floor(Date.now() / 1000)}`, name: "check", data: { monitorId } },
          { performCheck: testPerformCheck }
        );
        expect(result).toEqual({ outcome: "noop-lock-held" });
        expect(await fetchPings(monitorId)).toHaveLength(0);
        expect((await fetchMonitor(monitorId))!.totalChecks).toBe(0);
        expect(await admin.exists(stagingKey(monitorId))).toBe(0); // never even staged
      } finally {
        await held!.release();
      }
    },
    15_000
  );

  it(
    "6. lock lost before the Tier 1 commit: abort with zero writes (J-3 / T-04-21)",
    async () => {
      const monitorId = await seedMonitor({ url: target.url("/error500"), status: "UP" });

      const result = await processCheckJob(
        { id: `check:${monitorId}:${Math.floor(Date.now() / 1000)}`, name: "check", data: { monitorId } },
        {
          performCheck: testPerformCheck,
          checkpoints: {
            // Simulate the ownership slip inside the classification ->
            // re-verify window the abort path guards.
            beforeReverify: async () => {
              await admin.del(lockKey(monitorId));
            },
          },
        }
      );
      expect(result).toEqual({ outcome: "aborted-lock-lost" });
      expect(await fetchPings(monitorId)).toHaveLength(0);
      expect((await fetchMonitor(monitorId))!.status).toBe("UP"); // untouched
      expect(await fetchOngoingIncident(monitorId)).toBeUndefined();
      expect((await fetchOutbox(monitorId)).length === 0).toBe(true);
    },
    15_000
  );

  it(
    "7. missing or inactive monitor: successful no-ops (§15.1 step-1 posture)",
    async () => {
      const missing = await processCheckJob(
        { id: "check:987654321:1", name: "check", data: { monitorId: 987654321 } },
        { performCheck: testPerformCheck }
      );
      expect(missing).toEqual({ outcome: "noop-monitor-missing" });

      const inactiveId = await seedMonitor({ url: target.url("/ok"), status: "UP", isActive: false });
      const inactive = await processCheckJob(
        { id: `check:${inactiveId}:1`, name: "check", data: { monitorId: inactiveId } },
        { performCheck: testPerformCheck }
      );
      expect(inactive).toEqual({ outcome: "noop-monitor-missing" });
      expect(await fetchPings(inactiveId)).toHaveLength(0);
    },
    15_000
  );

  it(
    "8. infra failure: the job rejects for BullMQ retry AND the breaker counts it (WRK-05/RES-01)",
    async () => {
      const connectRefused = Object.assign(
        new Error("connect ECONNREFUSED 127.0.0.1:5432"),
        { code: "ECONNREFUSED" }
      );
      const failingDb = {
        execute: () => Promise.reject(connectRefused),
      } as unknown as NonNullable<ProcessCheckDeps["db"]>;

      await expect(
        processCheckJob({ id: "check:111:1", name: "check", data: { monitorId: 111 } }, { db: failingDb })
      ).rejects.toThrow(/ECONNREFUSED/);

      // Classified infra and counted — one failure toward the 5-fail trip.
      expect(breakerState().consecutiveFailures).toBe(1);
      expect(breakerState().state).toBe("CLOSED"); // below threshold: gate still open
    },
    15_000
  );

  it(
    "9. dbWrites dispatch: flush-sweep benign on empty staging; unknown names and malformed flush data are loud",
    async () => {
      await expect(makeFlushProcessor()({ name: "flush-sweep", data: {} })).resolves.toEqual({
        swept: 0,
        applied: 0,
      });

      await expect(makeFlushProcessor()({ name: "bogus", data: {} })).rejects.toThrow(/unknown job name/);

      await expect(
        makeFlushProcessor()({ name: "flush", data: { monitorId: 42, batchId: "not-a-batch" } })
      ).rejects.toThrow(/batchId/);

      // A successful sweep is breaker CLOSED-counter evidence (recordSuccess).
      expect(breakerState().state).toBe("CLOSED");
    },
    15_000
  );

  it(
    "10. G-06-2 manual repeat on an UP monitor persists in-job: lastChecked advances past the enqueue epoch, counters +1, one ping per enqueue, never staged",
    async () => {
      const monitorId = await seedMonitor({ url: target.url("/ok"), status: "PENDING" });
      const capture = captureLane({ dbWritesQueue: queues.dbWrites });

      try {
        // Manual check #1: PENDING -> UP — the full §16.1 transition contract.
        const first = await enqueueManualCheck(monitorId, { checksQueue: queues.checks });
        const firstJob = await queues.checks.getJob(first.jobId);
        await waitFor(async () => (await firstJob?.getState()) === "completed");
        const firstResult = await capture.nextResult();
        expect(firstResult.outcome).toBe("tier1");
        if (firstResult.outcome !== "tier1") return;
        expect(firstResult.applied).toBe(true);
        expect(firstResult.eventType).toBe("monitor.first_check");
        expect((await fetchMonitor(monitorId))!.status).toBe("UP");
        expect((await fetchMonitor(monitorId))!.totalChecks).toBe(1);

        // Manual check #2 on the now-UP monitor — the UAT test-2 scenario
        // verbatim (engine side): the repeat MUST persist inside the job.
        const second = await enqueueManualCheck(monitorId, { checksQueue: queues.checks });
        expect(second.jobId).not.toBe(first.jobId); // per-enqueue-unique ids
        const secondJob = await queues.checks.getJob(second.jobId);
        await waitFor(async () => (await secondJob?.getState()) === "completed");
        const secondResult = await capture.nextResult();
        expect(secondResult.outcome).toBe("tier1");
        if (secondResult.outcome !== "tier1") return;
        expect(secondResult.applied).toBe(false); // UP -> UP: no transition...
        expect(secondResult.manualFlushed).toBe(true); // ...but the in-job additive flush ran

        const monitor = (await fetchMonitor(monitorId))!;
        expect(monitor.totalChecks).toBe(2);
        expect(monitor.responseTime).not.toBeNull();
        expect(await fetchPings(monitorId)).toHaveLength(2); // one evidence ping per enqueue
        // The mechanism is a direct UPDATE — never Tier-2 staged.
        expect(await admin.exists(stagingKey(monitorId))).toBe(0);

        // The D-01 poll completion predicate: lastChecked is strictly newer
        // than the second enqueue's queuedAt epoch. The column is a naive UTC
        // timestamp and this host runs +06 — normalize to a UTC epoch-ms
        // before comparing. (Plan-text note: pg returns the column as a Date
        // parsed as LOCAL, whose local components ARE the naive stamp's
        // fields — getTime() - getTimezoneOffset()*60000 therefore reads the
        // stamp AS UTC; the string branch keeps the plan's literal space->T +
        // Z normalization. A bare Date(string) parse would be 6 h wrong.)
        const queuedAtMs = Number.parseInt(second.jobId.split(":")[2], 10);
        const stamped = monitor.lastChecked!;
        const lastCheckedMs =
          typeof stamped === "string"
            ? Date.parse(stamped.replace(" ", "T") + "Z")
            : stamped.getTime() - stamped.getTimezoneOffset() * 60_000;
        expect(lastCheckedMs).toBeGreaterThan(queuedAtMs);
      } finally {
        await capture.lane.close();
      }
    },
    30_000
  );

  it(
    "11. G-06-2 manual repeat on a DOWN monitor persists in-job (failedChecks +1) with zero fabricated incidents/outbox",
    async () => {
      const monitorId = await seedMonitor({ url: target.url("/error500"), status: "DOWN" });
      const capture = captureLane({ dbWritesQueue: queues.dbWrites });

      try {
        const enqueued = await enqueueManualCheck(monitorId, { checksQueue: queues.checks });
        const job = await queues.checks.getJob(enqueued.jobId);
        await waitFor(async () => (await job?.getState()) === "completed");
        const result = await capture.nextResult();
        expect(result.outcome).toBe("tier1");
        if (result.outcome !== "tier1") return;
        expect(result.applied).toBe(false); // DOWN -> DOWN: the guard skips
        expect(result.manualFlushed).toBe(true);
        expect(result.eventType).toBeNull();

        const monitor = (await fetchMonitor(monitorId))!;
        expect(monitor.status).toBe("DOWN");
        expect(monitor.totalChecks).toBe(1);
        expect(monitor.failedChecks).toBe(1);
        expect(monitor.lastChecked).not.toBeNull();

        // No fabricated alerting: applyTransition's statement-1 evidence ping
        // is the sole evidence row — incidents and outbox stay untouched.
        expect(await fetchOngoingIncident(monitorId)).toBeUndefined();
        expect(await fetchOutbox(monitorId)).toHaveLength(0);
        const pings = await fetchPings(monitorId);
        expect(pings).toHaveLength(1);
        expect(pings[0].status).toBe("DOWN");
        expect(pings[0].error_class).toBe("http_5xx");
        expect(pings[0].status_code).toBe(500);
        expect(await admin.exists(stagingKey(monitorId))).toBe(0);
      } finally {
        await capture.lane.close();
      }
    },
    30_000
  );

  it(
    "12. WR-01: monitor deactivated mid-job — the manual follow-up writes NOTHING beyond the evidence ping (requireActive guard)",
    async () => {
      const monitorId = await seedMonitor({ url: target.url("/ok"), status: "UP", totalChecks: 3 });
      const result = await processCheckJob(
        { id: `check-manual:${monitorId}:${Date.now()}`, name: "check", data: { monitorId } },
        {
          performCheck: testPerformCheck,
          checkpoints: {
            // Deactivate INSIDE the classification -> re-verify window: the
            // step-1 row load saw an active monitor, the transition guard
            // (AND "isActive") will not.
            beforeReverify: async () => {
              await pg.query(`UPDATE monitors SET "isActive" = false WHERE id = $1`, [monitorId]);
            },
          },
        }
      );
      expect(result.outcome).toBe("tier1");
      if (result.outcome !== "tier1") return;
      expect(result.applied).toBe(false); // transition skipped by AND "isActive"
      // The WR-01 contract: a deactivated monitor is fully inert beyond its
      // evidence ping — the follow-up's requireActive tail matches zero rows,
      // so manualFlushed stays unset (the no-write is observable, API-01).
      expect(result).toEqual({
        outcome: "tier1",
        targetStatus: "UP",
        applied: false,
        eventType: null,
        incidentId: null,
      });

      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.status).toBe("UP"); // never transitioned
      expect(monitor.totalChecks).toBe(3); // counters untouched by the follow-up
      expect(monitor.lastChecked).toBeNull(); // ...nor the stamp
      // Statement-1 evidence ping still commits (01-01 pin) — the sole write.
      const pings = await fetchPings(monitorId);
      expect(pings).toHaveLength(1);
      expect(pings[0].status).toBe("UP");
    },
    15_000
  );
});
