import { Worker } from "bullmq";
import { buildLogger } from "./logger";
import { workerConnection } from "./connection";
import { claimDue, CLAIM_BATCH_LIMIT_DEFAULT } from "./claim";
import { openBacklogGate } from "./backlog";
import type { BacklogGate } from "./backlog";
import { enqueueClaimedCheck, LANE_PRIORITY, noteStalledEvent, QUEUE_NAMES, workerQueues } from "./queues";
import type { WorkerQueueSet } from "./queues";
import { FLUSH_CADENCE_MS } from "./persist/tier2";

// ---------------------------------------------------------------------------
// The scheduler lane (WRK-10 / D-16, audit §14.2): the tick processor, the
// tick worker, and the boot-time Job Scheduler upserts.
//
// D-16 DARK-LAUNCH FLAG: WORKER_SCHEDULER_ENABLED=false skips the upserts
// ENTIRELY — the consumers (tick worker) still run, so any operator smoke
// enqueue exercises the real machinery. queue pausing is FORBIDDEN here
// (Pitfall 12): a paused queue blocks smoke enqueues too, defeating the
// dark-launch design. One flag gates every recurring scheduler — the
// maintenance cleanup rides the same lever so dark launch produces zero
// autonomous activity of any kind.
//
// Pitfall 11: the upsert templates NEVER pin a custom job id — BullMQ 6's
// JobSchedulerTemplateOptions drops it and a tick's identity is its scheduler
// id + iteration, never a caller-chosen key.
//
// §14.2 step 1 (RES-05): upsertJobScheduler is idempotent — concurrent boots
// and post-Restart re-declarations converge on exactly one active scheduler
// per id and at most one delayed job per scheduler.
// ---------------------------------------------------------------------------

const log = buildLogger();

/** §14.5: tick period 30 s — <= 1/2 the minimum supported interval (J-1). */
export const CHECK_TICK_EVERY_MS = 30_000;
/** Stable scheduler id — the idempotency anchor for the tick (§14.2 step 1). */
export const CHECK_TICK_SCHEDULER_ID = "check-tick";
/** Daily off-peak maintenance window (03:15 UTC, §14.1 maintenance lane). */
export const MAINTENANCE_CLEANUP_SCHEDULER_ID = "maintenance-cleanup";
export const MAINTENANCE_CLEANUP_PATTERN = "15 3 * * *";
/**
 * Tier-2 straggler sweep (§16.2 cadence driver): rides the DBWRITES lane —
 * the lane whose consumer owns flush dispatch — every FLUSH_CADENCE_MS, so
 * staged routine-UP batches whose flush job was breaker-gated (or lost to a
 * crash between staging and enqueue) still land inside the ≤60 s window.
 * Documented Rule-3 deviation: the plan's prose said "maintenance tick", but
 * the maintenance lane has no consumer until 04-07 and its scheduler count
 * is pinned at exactly one by the flag suite — a sweep on a consumer-less
 * lane cannot run.
 */
export const FLUSH_SWEEP_SCHEDULER_ID = "tier2-flush-sweep";

export interface TickResult {
  claimed: number;
  enqueued: number;
  dropped: number;
  failed: number;
}

/**
 * One tick (§14.2 steps 2-4): claim due monitors atomically, then enqueue one
 * check per claimed row through the backlog-gated helper — lane assignment
 * (UP -> routine 10 via the gate; anything else -> 1 ungated) happens inside
 * enqueueClaimedCheck from the claim's own RETURNING shape. ONE gate (one
 * depth read + one active-monitor count, cached) serves the whole tick.
 * Per-monitor enqueue failures are logged and counted, never fatal to the
 * tick — J-1 compensation (the rollback) already ran inside the helper.
 */
export async function processTick(
  deps: { batchSize?: number; queues?: WorkerQueueSet } = {}
): Promise<TickResult> {
  const queues = deps.queues ?? workerQueues();
  const claimed = await claimDue(deps.batchSize ?? CLAIM_BATCH_LIMIT_DEFAULT);
  const gate: BacklogGate = openBacklogGate({ checksQueue: queues.checks });
  const result: TickResult = { claimed: claimed.length, enqueued: 0, dropped: 0, failed: 0 };

  for (const row of claimed) {
    try {
      const outcome = await enqueueClaimedCheck(row, { checksQueue: queues.checks, gate });
      if (outcome.dropped) {
        result.dropped += 1;
      } else {
        result.enqueued += 1;
      }
    } catch (err) {
      result.failed += 1;
      log.error(
        {
          monitorId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "tick enqueue failed — J-1 rollback already applied inside the enqueue helper"
      );
    }
  }

  if (result.claimed !== result.enqueued) {
    log.warn({ ...result }, "tick claimed-vs-enqueued mismatch (drops and failures are visible here)");
  }
  return result;
}

/** What the boot flow needs to drain the tick lane (WRK-07 drainable). */
export interface TickWorkerHandle {
  close(): Promise<void>;
}

/**
 * Starts the tick-lane consumer on its own blocking connection (§25 budget:
 * 1 producer + 1 blocking). Concurrency 1 — one tick at a time (§14.1);
 * stalled config pinned explicitly (lockDuration/stalledInterval 30000,
 * maxStalledCount 1 — the re-run is safe: the claim transaction makes a
 * re-executed tick a no-op). ALWAYS runs, regardless of the D-16 flag —
 * dark launch keeps consumers live; only scheduling is gated.
 */
export function startTickWorker(deps: { queues?: WorkerQueueSet } = {}): TickWorkerHandle {
  const worker = new Worker(
    QUEUE_NAMES.scheduler,
    async () => {
      await processTick(deps.queues ? { queues: deps.queues } : {});
    },
    {
      // The blocking worker connection — dedicated, owned and closed by BullMQ.
      connection: workerConnection(),
      concurrency: 1,
      lockDuration: 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    }
  );
  worker.on("stalled", (jobId) => {
    noteStalledEvent(QUEUE_NAMES.scheduler);
    log.warn({ jobId }, "tick job stalled — re-run at-least-once (claim keeps it idempotent)");
  });
  return {
    close: () => worker.close(),
  };
}

export interface UpsertSchedulersResult {
  upserted: Array<{ queue: string; schedulerId: string }>;
}

/**
 * Declares every recurring Job Scheduler (§14.2 step 1). Idempotent — call at
 * every boot. When `schedulerEnabled` is false (D-16) NOTHING is upserted:
 * dark launch runs with zero autonomous scheduling, while consumers stay
 * live for operator smoke enqueues.
 */
export async function upsertSchedulersAtBoot(opts: {
  schedulerEnabled: boolean;
  queues?: WorkerQueueSet;
}): Promise<UpsertSchedulersResult> {
  if (!opts.schedulerEnabled) {
    log.info("scheduler flag OFF — skipping all Job Scheduler upserts (D-16 dark launch)");
    return { upserted: [] };
  }
  const queues = opts.queues ?? workerQueues();

  // The check tick: every 30 s, priority 1, attempts 1 (the next period
  // supersedes any retry — §14.1). Template carries no custom job key
  // (Pitfall 11).
  await queues.scheduler.upsertJobScheduler(
    CHECK_TICK_SCHEDULER_ID,
    { every: CHECK_TICK_EVERY_MS },
    {
      name: "check-tick",
      data: {},
      opts: {
        priority: LANE_PRIORITY.tick,
        attempts: 1,
        removeOnComplete: { age: 300, count: 100 },
        removeOnFail: { age: 604800 },
      },
    }
  );

  // The maintenance cleanup: daily 03:15 UTC, dry-run until its processor
  // lands (04-07) — WRK-13 mandates the dry-run default.
  await queues.maintenance.upsertJobScheduler(
    MAINTENANCE_CLEANUP_SCHEDULER_ID,
    { pattern: MAINTENANCE_CLEANUP_PATTERN },
    {
      name: "cleanup",
      data: { dryRun: true },
      opts: {
        priority: LANE_PRIORITY.maintenance,
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }
  );

  // The Tier-2 straggler sweep: every FLUSH_CADENCE_MS on the dbWrites lane
  // (see FLUSH_SWEEP_SCHEDULER_ID above for why dbWrites, not maintenance).
  // Same D-16 lever as every other recurring scheduler — zero autonomous
  // activity while dark-launched.
  await queues.dbWrites.upsertJobScheduler(
    FLUSH_SWEEP_SCHEDULER_ID,
    { every: FLUSH_CADENCE_MS },
    {
      name: "flush-sweep",
      data: {},
      opts: {
        priority: LANE_PRIORITY.dbWrites,
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 604800 },
      },
    }
  );

  const upserted = [
    { queue: QUEUE_NAMES.scheduler, schedulerId: CHECK_TICK_SCHEDULER_ID },
    { queue: QUEUE_NAMES.maintenance, schedulerId: MAINTENANCE_CLEANUP_SCHEDULER_ID },
    { queue: QUEUE_NAMES.dbWrites, schedulerId: FLUSH_SWEEP_SCHEDULER_ID },
  ];
  log.info({ upserted }, "job schedulers upserted (idempotent — safe at every boot)");
  return { upserted };
}
