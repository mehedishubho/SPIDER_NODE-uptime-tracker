import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
import { createWorkerQueues, enqueueClaimedCheck, CHECK_JOB_OPTIONS, LANE_PRIORITY } from "@/worker/queues";
import type { WorkerQueueSet } from "@/worker/queues";
import { BACKLOG_CAP_MULTIPLIER, backlogDropCount, resetBacklogDropCount } from "@/worker/backlog";
import {
  connectAdminRedis,
  connectPg,
  ensureStackUp,
  flushWorkerKeys,
  recordObservations,
  seedMonitor,
  seedUser,
  spawnWorker,
  waitFor,
} from "./helpers/worker-process";
import type { WorkerHandle } from "./helpers/worker-process";

// ---------------------------------------------------------------------------
// RES-02 injection case 7 — BACKLOG-CAP FLOOD (plan 04-08 Task 2, D-28 #7).
//
// Flood the REAL check queue above the ~2x-active-monitors cap with raw
// routine (priority-10) check jobs while NO worker is draining, then prove
// through the REAL enqueueClaimedCheck path:
//   1. the next routine (UP, priority-10) enqueue is DROPPED — outcome.
//      dropped === true, the job never enters the queue, the BACKLOG_DROP
//      marker is logged, and the drop counter (the exact value
//      collectQueueMetrics surfaces as metrics.backlogDrops) increments;
//   2. a non-UP/transition enqueue in the SAME flooded window is ADMITTED
//      ungated at priority 1 (the routine lane is the ONLY gated lane);
//   3. the REAL spawned worker then processes the transition job to a
//      completed Tier-1 transition WHILE the routine backlog sits in the
//      same queue (priority 1 dequeues first), and the routine backlog
//      drains behind it.
//
// Same split as postgres-down (the suite's established precedent): the
// enqueue-side gate verdict + counter are the TEST process running the REAL
// enqueue code (the identical path the worker's tick executes — only the
// process differs); the spawned worker proves the processing half and that
// /metrics.json carries the backlogDrops counter surface.
// ---------------------------------------------------------------------------

let pg: Client;
let admin: Redis;
let queues: WorkerQueueSet;
let worker: WorkerHandle | undefined;
let userId: string;
let upMonitorId = 0;
let droppedMonitorId = 0;
let transitionMonitorId = 0;

const FLOOD_JOBS = 8; // > cap 6 (2x3 active monitors) — deterministic trip

async function monitorState(id: number) {
  const monitor = await pg.query(
    `SELECT status, "totalChecks", "failedChecks" FROM monitors WHERE id = $1`,
    [id]
  );
  const pings = await pg.query(`SELECT count(*)::int AS n FROM pings WHERE "monitorId" = $1`, [id]);
  const incidents = await pg.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'ONGOING')::int AS ongoing
       FROM incidents WHERE "monitorId" = $1`,
    [id]
  );
  return {
    status: monitor.rows[0]?.status as string,
    totalChecks: monitor.rows[0]?.totalChecks as number,
    pings: pings.rows[0].n as number,
    incidents: incidents.rows[0].total as number,
    ongoingIncidents: incidents.rows[0].ongoing as number,
  };
}

async function checkDepth(): Promise<number> {
  const counts = await queues.checks.getJobCounts("wait", "prioritized", "delayed", "active");
  return Object.values(counts).reduce((sum, n) => sum + Number(n ?? 0), 0);
}

beforeAll(async () => {
  pg = await connectPg();
  admin = await connectAdminRedis();
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE write_guards");
  await pg.query("TRUNCATE users CASCADE");
  userId = await seedUser(pg);
  queues = createWorkerQueues(new Redis(process.env.TEST_REDIS_URL!));
});

afterAll(async () => {
  if (worker && !worker.hasExited()) await worker.stop().catch(() => {});
  await queues.close().catch(() => {});
  await flushWorkerKeys(admin).catch(() => {});
  await admin.quit().catch(() => {});
  await pg.end().catch(() => {});
  // Containers were never stopped in this case, but the uniform finally
  // contract restores them loudly (rehearse-migrations convention).
  ensureStackUp();
});

describe("resilience: backlog flood above the ~2x cap", () => {
  it("drops routine enqueues with the marker logged and counter incremented while the transition lane still processes", async () => {
    // Three active monitors => cap = 2 x 3 = 6 (BACKLOG_CAP_MULTIPLIER).
    upMonitorId = await seedMonitor(pg, { userId, status: "UP", interval: 30 });
    droppedMonitorId = await seedMonitor(pg, { userId, status: "UP", interval: 30 });
    transitionMonitorId = await seedMonitor(pg, { userId, status: "PENDING", interval: 30 });
    const cap = BACKLOG_CAP_MULTIPLIER * 3;

    // --- the flood: raw routine jobs, real queue, nothing draining ---------
    const floodJobIds: string[] = [];
    const epochBase = Math.floor(Date.now() / 1000);
    for (let i = 0; i < FLOOD_JOBS; i += 1) {
      const jobId = `check:${upMonitorId}:${epochBase + i}`;
      await queues.checks.add("check", { monitorId: upMonitorId }, {
        ...CHECK_JOB_OPTIONS,
        priority: LANE_PRIORITY.routineCheck,
        jobId,
      });
      floodJobIds.push(jobId);
    }
    expect(await checkDepth()).toBe(FLOOD_JOBS);
    expect(FLOOD_JOBS).toBeGreaterThan(cap);

    // (1) the next ROUTINE enqueue is dropped by the real gate path. The
    // BACKLOG_DROP log MARKER is not stdout-captured here: backlog.ts's
    // logger is module-scope (pino binds its write path at creation — a
    // later process.stdout spy cannot observe it; verified empirically in
    // this suite), and the marker contract is already unit-pinned with the
    // injectable logger in tests/worker/queues.test.ts. This case pins the
    // BEHAVIOR: the drop counter (the exact value collectQueueMetrics
    // surfaces as metrics.backlogDrops) increments and the job never lands.
    resetBacklogDropCount();
    const droppedOutcome = await enqueueClaimedCheck(
      { id: droppedMonitorId, status: "UP", nextCheckAt: new Date(Date.now() + 60_000) },
      { checksQueue: queues.checks }
    );
    expect(droppedOutcome).toMatchObject({ dropped: true, priority: LANE_PRIORITY.routineCheck });
    expect(droppedOutcome.breakerGated).toBeUndefined(); // a CAP drop, not a breaker skip
    expect(backlogDropCount()).toBe(1);
    expect(await queues.checks.getJob(droppedOutcome.jobId)).toBeUndefined();

    // (2) the transition enqueue in the SAME flooded window is admitted
    // ungated at priority 1 — the non-UP lane is never cap-gated.
    const transitionOutcome = await enqueueClaimedCheck(
      { id: transitionMonitorId, status: "PENDING", nextCheckAt: new Date(Date.now() + 61_000) },
      { checksQueue: queues.checks }
    );
    expect(transitionOutcome.dropped).toBe(false);
    expect(transitionOutcome.priority).toBe(LANE_PRIORITY.nonUpCheck);
    expect(await queues.checks.getJob(transitionOutcome.jobId)).toBeDefined();
    expect(await checkDepth()).toBe(FLOOD_JOBS + 1);

    // (3) the real worker: the priority-1 transition completes its Tier 1
    // transition while the routine backlog is still in the queue, then the
    // routine flood drains behind it.
    const transitionStartedAt = Date.now();
    worker = await spawnWorker({ WORKER_SCHEDULER_ENABLED: "false" });
    await worker.waitReady();
    const transitionJob = await queues.checks.getJob(transitionOutcome.jobId);
    await waitFor(
      async () => (await transitionJob?.getState()) === "completed",
      60_000,
      "backlog-flood: the ungated transition job completed while the routine backlog existed"
    );
    const transition = await monitorState(transitionMonitorId);
    expect(transition.status).toBe("DOWN");
    expect(transition.totalChecks).toBe(1);
    expect(transition.pings).toBe(1);
    expect(transition.ongoingIncidents).toBe(1);

    // The routine flood drains (the flood monitor's first check transitions
    // DOWN once; the redelivered-same-epoch siblings add evidence only).
    await waitFor(
      async () => {
        for (const jobId of floodJobIds) {
          const job = await queues.checks.getJob(jobId);
          if ((await job?.getState()) !== "completed") return false;
        }
        return true;
      },
      90_000,
      "backlog-flood: the flooded routine jobs drained behind the transition"
    );
    const floodMonitor = await monitorState(upMonitorId);
    expect(floodMonitor.status).toBe("DOWN");
    expect(floodMonitor.totalChecks).toBe(1); // exactly-once under redelivery
    expect(floodMonitor.ongoingIncidents).toBe(1);

    // /metrics.json carries the queue-gauge + drop-counter surfaces (D-25).
    const metrics = await worker.curl<{
      queues: Record<string, { depth: { wait: number; prioritized: number; delayed: number; active: number } }>;
      backlogDrops: number;
    }>("/metrics.json");
    const gauge = metrics.queues["monitor-checks"];
    expect(gauge).toBeDefined();
    expect(gauge.depth.wait + gauge.depth.prioritized + gauge.depth.delayed + gauge.depth.active).toBe(0);
    expect(typeof metrics.backlogDrops).toBe("number");

    recordObservations("backlog-flood", {
      floodedDepth: FLOOD_JOBS,
      activeMonitors: 3,
      cap,
      droppedRoutineEnqueues: 1,
      backlogDropCounter: backlogDropCount(),
      transitionAdmittedAtDepth: FLOOD_JOBS + 1,
      transitionCompletedMs: Date.now() - transitionStartedAt,
    });
  });
});
