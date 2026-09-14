import { writeSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { JobsOptions } from "bullmq";
import { performCheck } from "@/lib/ssrf";
import type { CheckOutcome, CheckRequest } from "@/lib/ssrf";
import { workerDb } from "../db";
import type * as schema from "@/db/schema";
import { buildLogger, jobLogger } from "../logger";
import { acquireMonitorLock, withLockRenewal } from "../locks";
import { applyTransition } from "../persist/tier1";
import type { Tier1Result } from "../persist/tier1";
import { flushDueMonitors, flushMonitor, makeBatchId, stageResult } from "../persist/tier2";
import type { Tier2FlushResult } from "../persist/tier2";
import { BREAKER_GATE_MARKER, canEnqueue, recordResult, recordSuccess } from "../breaker";
import { flushJobId, LANE_PRIORITY, workerQueues } from "../queues";

// ---------------------------------------------------------------------------
// The check-job processor (WRK-01 / audit §15.1 + §16 routing) — the composition
// point of the whole worker: SSRF-hardened fetch (04-03) -> WRK-05
// classification -> per-monitor lock (04-04) -> Tier 1 transition transaction
// (04-04) or Tier 2 staged flush (04-05), with the Postgres breaker (04-06
// task 1) accounting every escaped error.
//
// Sequence per job (§15.1 literal):
//   1. child logger — monitorId/jobId correlation on every line (OBS-02);
//      bindings are ids/timings ONLY, never URLs or bodies (T-04-24)
//   2. load the monitor row — the checked url comes from the monitors ROW,
//      never from job data (T-04-22: job data is attacker-adjacent enqueue
//      input; the row is the trusted source). Missing or inactive monitor =>
//      successful no-op (the §15.1 step-1 posture), never a retry loop
//   3. acquire the per-monitor lock (WRK-04/J-3): null => another executor
//      owns the monitor => successful no-op, zero writes, no acquire retry
//   4. arm the TTL/3 renewal for the WHOLE job lifetime (§15.3)
//   5. performCheck — target behavior NEVER throws (WRK-05): UP/DOWN/timeout/
//      DNS/TLS/SSRF-block all return as typed CheckOutcome data
//   6. classify the persistence tier:
//        Tier 1 — any down-class outcome, any non-UP monitor status (a
//          PENDING first check, a DOWN->UP RECOVERED, an unchanged DOWN's
//          evidence), or a manual-flagged job (synchronous ping for the
//          manual enqueue-and-poll UX): re-verify lock ownership IMMEDIATELY
//          before applyTransition (T-04-21) — ownership lost => abort with
//          zero writes (J-3), never race a possible new owner
//        Tier 2 — routine UP on an UP monitor: stageResult into Redis, then
//          enqueue the guarded flush job on the dbWrites lane (priority 5,
//          delayed <= 60 s cadence). The batchId is minted HERE at ENQUEUE
//          time and carried in job data — the flush processor never mints
//          one (04-05 redelivery-determinism contract)
//   7. finally: stop the renewal timer, owner-only release (a lost lock is
//      already handled; release failures are swallowed — teardown must never
//      mask the job's result)
//
// Breaker accounting wraps the whole job: a successful return did at least
// one working Postgres read (the monitor load), so it is CLOSED-counter
// evidence (recordSuccess); a thrown error is classified by the single-sourced
// recordResult vocabulary (infra counts, target-class never does) and then
// RETHROWN for BullMQ's bounded attempts (WRK-06) — this processor never
// swallows an infra failure.
//
// The flush lane consumer (makeFlushProcessor) dispatches by job name:
// "flush" -> flushMonitor(monitorId, batchId-from-data); "flush-sweep" ->
// flushDueMonitors() (the D-16-gated scheduler's straggler sweep). Unknown
// names throw — a misrouted dbWrites job must be loud, not silently dropped.
// ---------------------------------------------------------------------------

type WorkerDb = NodePgDatabase<typeof schema>;

const baseLog = buildLogger();

/**
 * §14.5 margin: the flush job's delay sits at HALF the 60 s Tier-2 cadence
 * (rule 9 upper bound) so the guarded write lands well inside the window even
 * under one retry, while the scheduler sweep backstops anything the delay
 * window straddles.
 */
export const FLUSH_JOB_DELAY_MS = 30_000;

/**
 * TEST-ONLY crash-checkpoint marker (D-29, plan 04-08 Task 2). Written via
 * fs.writeSync(1, ...) — a SYNCHRONOUS pipe write — immediately before the
 * SIGKILL so the marker line is guaranteed to reach the parent's capture ring
 * even though the process dies mid-flight (pino/sonic-boom buffering would
 * lose it). Inert unless WORKER_TEST_CRASH_AFTER is set; production boots
 * never carry that env (pinned by source assertion in the resilience suite).
 */
export const WORKER_TEST_CRASH_MARKER = "WORKER_TEST_CRASH";

/** The check job as the processor consumes it (BullMQ Job structural subset). */
export interface CheckJob {
  id?: string;
  name: string;
  data: { monitorId: number };
}

/**
 * Validates/derives a CheckJob from a lane job's untyped data. The ONLY field
 * ever read from job data is monitorId (T-04-22) — everything else about the
 * monitor comes from the row.
 */
export function fromLaneJob(job: { id?: string; name: string; data: unknown }): CheckJob {
  const data = (job.data ?? {}) as { monitorId?: unknown };
  const monitorId = Number(data.monitorId);
  if (!Number.isInteger(monitorId) || monitorId <= 0) {
    throw new Error(`check processor: job data carries no valid monitorId (T-04-22: data is enqueue input, row is authority)`);
  }
  return { id: job.id, name: job.name, data: { monitorId } };
}

/** What the dbWrites lane's enqueue surface needs (tests inject fakes). */
export interface DbWritesQueueClient {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
}

export interface ProcessCheckDeps {
  /** Overrides the drizzle client (tests inject failing fakes). */
  db?: WorkerDb;
  /**
   * Overrides the check function (tests point it at the fixture server via
   * the documented CheckRequest timeout/denylist test seams — production
   * callers pass NOTHING here and take the §15.3 defaults).
   */
  performCheck?: (req: CheckRequest) => Promise<CheckOutcome>;
  /** Overrides the dbWrites queue (flush-enqueue injection point). */
  dbWritesQueue?: DbWritesQueueClient;
  /**
   * TEST-ONLY observation hooks — beforeReverify fires after classification,
   * immediately before the Tier 1 ownership re-check (the lock-loss race
   * window the abort path guards).
   */
  checkpoints?: { beforeReverify?: () => void | Promise<void> };
}

/** What one check job did — the log/metric surface. */
export type CheckJobResult =
  | { outcome: "noop-monitor-missing" }
  | { outcome: "noop-lock-held" }
  | { outcome: "aborted-lock-lost" }
  | ({ outcome: "tier1"; targetStatus: "UP" | "DOWN" } & Tier1Result)
  | { outcome: "tier2"; flushJobId: string | null; flushGated: boolean };

/** The monitor fields the processor needs — loaded from the ROW (T-04-22). */
interface MonitorLoad {
  url: string;
  status: string;
  is_active: boolean;
  interval: number;
}

/**
 * The claim-slot epoch from the 3-segment jobId
 * (check:{monitorId}:{epochSec} / check-manual:{monitorId}:{epochMs});
 * Date.now() when the id is absent or unshaped (the outbox payload's
 * claimEpoch is observability data, never correctness data).
 */
function epochFromJobId(jobId: string | undefined): number {
  const parts = (jobId ?? "").split(":");
  const parsed = parts.length === 3 ? Number.parseInt(parts[2], 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

/** Enqueues the guarded Tier-2 flush job; null when the breaker gate refused. */
async function enqueueFlushJob(
  monitorId: number,
  deps: Pick<ProcessCheckDeps, "dbWritesQueue">
): Promise<{ jobId: string } | null> {
  const queue = deps.dbWritesQueue ?? workerQueues().dbWrites;
  const passEpochMs = Date.now();
  // 3-segment jobId (BullMQ 6 rejects anything else); the batchId's OWN colon
  // means it rides job DATA, never the id (04-06 resolution of the plan's
  // flush:{monitorId}:{batchId} form).
  const jobId = flushJobId(monitorId, passEpochMs);
  const batchId = makeBatchId(passEpochMs, monitorId); // minted at ENQUEUE (04-05 contract)

  if (!(await canEnqueue())) {
    baseLog.warn(
      { monitorId, jobId, marker: BREAKER_GATE_MARKER },
      "flush enqueue skipped — Postgres breaker OPEN; the scheduler sweep flushes the staged batch after recovery (RES-01)"
    );
    return null;
  }
  await queue.add("flush", { monitorId, batchId }, {
    priority: LANE_PRIORITY.dbWrites,
    delay: FLUSH_JOB_DELAY_MS,
    jobId,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 14 * 24 * 3600 },
  });
  return { jobId };
}

/**
 * The check-lane processor entry (WRK-01). NEVER throws for target behavior —
 * every target outcome is a successful job (WRK-05). Throws only for infra
 * failures (after breaker accounting) so BullMQ's bounded attempts apply.
 */
export function processCheckJob(job: CheckJob, deps: ProcessCheckDeps = {}): Promise<CheckJobResult> {
  return runCheckJob(job, deps).then(
    (result) => {
      recordSuccess(); // the monitor load alone is working-Postgres evidence
      return result;
    },
    (err: unknown) => {
      const verdict = recordResult(err); // single-sourced WRK-05 classification
      baseLog.error(
        {
          monitorId: job.data.monitorId,
          jobId: job.id,
          verdict,
          err: err instanceof Error ? err.message : String(err),
        },
        "check job FAILED (infra) — rethrown for BullMQ retry, breaker counted (RES-01)"
      );
      throw err;
    }
  );
}

async function runCheckJob(job: CheckJob, deps: ProcessCheckDeps): Promise<CheckJobResult> {
  const monitorId = job.data.monitorId;
  const jobId = typeof job.id === "string" ? job.id : undefined;
  const log = jobLogger(baseLog, { monitorId, jobId });
  const db = deps.db ?? workerDb;
  const startedAt = Date.now();
  // Manual jobs ride the check-manual:{monitorId}:{epochMs} id shape — they
  // always take Tier 1 (a synchronous evidence ping for the poll UX) even
  // when the outcome is a non-transition UP.
  const manual = jobId?.startsWith("check-manual:") ?? false;

  // 1. Load the monitor — the ROW is the url authority (T-04-22).
  const rows = (
    await db.execute(sql`
      SELECT url, status, "isActive" AS is_active, interval FROM monitors WHERE id = ${monitorId}
    `)
  ).rows as unknown as MonitorLoad[];
  const monitor = rows[0];
  if (!monitor || !monitor.is_active) {
    log.warn(
      { found: Boolean(monitor), isActive: monitor ? monitor.is_active : null },
      "check no-op — monitor missing or inactive (§15.1 step-1 posture)"
    );
    return { outcome: "noop-monitor-missing" };
  }

  // 2. Per-monitor lock (WRK-04/J-3): held => another executor owns it.
  const handle = await acquireMonitorLock(monitorId);
  if (!handle) {
    log.info("check no-op — per-monitor lock held by another executor");
    return { outcome: "noop-lock-held" };
  }

  // 3. Renewal armed for the WHOLE job lifetime (§15.3).
  const renewal = withLockRenewal(handle);
  try {
    // 4. The check itself — target behavior returns, never throws (WRK-05).
    const check = deps.performCheck ?? performCheck;
    const outcome = await check({ url: monitor.url });

    // 5. Tier classification: Tier 1 for any down-class outcome, any non-UP
    //    monitor status, or a manual job; Tier 2 ONLY for routine UP on an
    //    UP monitor (stageResult's UP-only contract mirrors this exactly).
    const tier1 = outcome.kind === "down" || monitor.status !== "UP" || manual;

    if (tier1) {
      // TEST-ONLY checkpoint sits inside the classification->re-verify window.
      await deps.checkpoints?.beforeReverify?.();

      // T-04-21: re-verify ownership IMMEDIATELY before the Tier 1 commit —
      // abort with zero writes when it slipped (J-3).
      if (!(await handle.isStillOwner())) {
        log.warn("Tier 1 aborted — lock ownership lost before the commit, discarding the classified result (J-3)");
        return { outcome: "aborted-lock-lost" };
      }
      const result = await applyTransition(
        {
          monitorId,
          epoch: epochFromJobId(jobId),
          targetStatus: outcome.kind === "up" ? "UP" : "DOWN",
          responseTimeMs: outcome.responseTimeMs,
          errorClass: outcome.kind === "down" ? (outcome.errorClass ?? null) : null,
          statusCode: outcome.statusCode ?? null,
          interval: monitor.interval,
        },
        db
      );
      // TEST-ONLY crash checkpoint (D-29 / T-04-30, plan 04-08 Task 2):
      // WORKER_TEST_CRASH_AFTER=tier1_commit hard-exits the process
      // immediately AFTER the Tier 1 COMMIT (applyTransition resolved — the
      // transition is durable in Postgres) and BEFORE the job ack (the
      // processor return that marks the BullMQ job completed). This is the
      // kill-mid-job injection seam. Inert unless the env var is set —
      // production boots never carry it; the resilience suite pins the
      // env-gate by source assertion. The marker uses writeSync so it lands
      // in the pipe before the kill.
      if (process.env.WORKER_TEST_CRASH_AFTER === "tier1_commit") {
        writeSync(
          1,
          `${WORKER_TEST_CRASH_MARKER} monitorId=${monitorId} jobId=${jobId ?? "unknown"} after=tier1_commit\n`
        );
        process.kill(process.pid, "SIGKILL");
      }
      log.info(
        { tier: 1, durationMs: Date.now() - startedAt, ...result },
        "check persisted — Tier 1 transition transaction (§16.1)"
      );
      return { outcome: "tier1", targetStatus: outcome.kind === "up" ? "UP" : "DOWN", ...result };
    }

    // 6. Tier 2: routine UP on an UP monitor — stage, then enqueue the flush.
    await stageResult(
      monitorId,
      {
        status: "UP",
        responseTimeMs: outcome.responseTimeMs,
        errorClass: null,
        statusCode: outcome.statusCode ?? null,
      },
      new Date()
    );
    const flush = await enqueueFlushJob(monitorId, deps);
    log.info(
      {
        tier: 2,
        durationMs: Date.now() - startedAt,
        flushJobId: flush ? flush.jobId : null,
        flushGated: flush === null,
      },
      "check staged — Tier 2 routine-UP flush enqueued on the dbWrites lane (§16.2)"
    );
    return { outcome: "tier2", flushJobId: flush ? flush.jobId : null, flushGated: flush === null };
  } finally {
    // 7. Teardown: renewal off, owner-only release. A release failure never
    //    masks the job result (the TTL reaps the key regardless).
    await renewal.stop();
    await handle.release().catch(() => {
      /* owner-scoped no-op on a lost/expired lock — TTL covers it */
    });
  }
}

/** A dbWrites-lane job (BullMQ Job structural subset). */
export interface DbWritesJob {
  id?: string;
  name: string;
  data: unknown;
}

/**
 * The dbWrites-lane consumer: dispatches by job name. "flush" applies ONE
 * monitor's staged batch — the batchId comes from job DATA (minted at enqueue
 * time in enqueueFlushJob; redelivery determinism is the 04-05 contract, a
 * fresh id here would re-derive a DIFFERENT snapshot/guard key pair).
 * "flush-sweep" runs the SCAN-based straggler sweep the D-16-gated scheduler
 * fires on the flush cadence. Breaker accounting wraps both: a successful
 * flush is real working-Postgres evidence; a failure is classified and
 * rethrown for the lane's bounded attempts.
 */
export function makeFlushProcessor(): (job: DbWritesJob) => Promise<unknown> {
  return (job: DbWritesJob): Promise<unknown> => {
    const run = async (): Promise<unknown> => {
      if (job.name === "flush-sweep") {
        const outcomes = await flushDueMonitors();
        baseLog.info(
          { swept: outcomes.length, applied: outcomes.filter((o) => o.applied).length, jobId: job.id },
          "Tier-2 straggler sweep complete (§16.2 cadence driver)"
        );
        return { swept: outcomes.length, applied: outcomes.filter((o) => o.applied).length };
      }
      if (job.name === "flush") {
        const data = (job.data ?? {}) as { monitorId?: unknown; batchId?: unknown };
        const monitorId = Number(data.monitorId);
        const batchId = typeof data.batchId === "string" ? data.batchId : "";
        if (!Number.isInteger(monitorId) || monitorId <= 0 || !/^\d+:\d+$/.test(batchId)) {
          throw new Error(
            `flush processor: job data requires {monitorId, batchId:{epochMs}:{monitorId}} (got monitorId=${String(data.monitorId)}, batchId='${batchId}')`
          );
        }
        const result: Tier2FlushResult = await flushMonitor(monitorId, batchId);
        baseLog.info({ monitorId, batchId, jobId: job.id, ...result }, "Tier-2 flush applied (§16.2)");
        return result;
      }
      throw new Error(`dbWrites lane: unknown job name '${job.name}' — refusing to silently drop`);
    };
    return run().then(
      (result) => {
        recordSuccess();
        return result;
      },
      (err: unknown) => {
        const verdict = recordResult(err);
        baseLog.error(
          { name: job.name, jobId: job.id, verdict, err: err instanceof Error ? err.message : String(err) },
          "dbWrites job FAILED (infra) — rethrown for BullMQ retry, breaker counted (RES-01)"
        );
        throw err;
      }
    );
  };
}
