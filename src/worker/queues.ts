import { Queue, Worker } from "bullmq";
import type { JobsOptions } from "bullmq";
import type IORedis from "ioredis";
import { workerConnection } from "./connection";
import { buildLogger } from "./logger";
import { backlogDropCount, noteBacklogDrop, openBacklogGate } from "./backlog";
import type { BacklogGate } from "./backlog";
import { BREAKER_GATE_MARKER, BreakerOpenError, canEnqueue } from "./breaker";

// ---------------------------------------------------------------------------
// Six-lane BullMQ 6 queue topology (WRK-02, audit §14.1 D-12) over ONE shared
// producer connection (§25 worker budget: 1 producer + 1 blocking worker
// connection). Queue instances are created here; consumers register in
// 04-06/04-07 as their processors land — the email lane's consumers arrive in
// Phase 6, only the Queue instance and options exist now.
//
// EXPLICIT PRIORITY INVARIANT (Pitfall 3 / WRK-12): BullMQ's default priority
// 0 means "no explicit priority", and unprioritized jobs are processed BEFORE
// prioritized ones — one unprioritized lane would queue-jump every prioritized
// lane and invert J-6. Every enqueue therefore goes through addCheckJob(),
// which REFUSES to enqueue without an explicit priority.
//
// Check-lane job options (WRK-06, 01-02 pins): attempts 5, exponential
// backoff from 2000 ms, removeOnComplete age 1 h, removeOnFail age 14 d (DLQ
// retention). KeepJobs eviction is LAZY (Pitfall 6 — no background timer;
// space is reclaimed only when another job in the same queue finishes), which
// the 04-07 maintenance dry-run reports on.
// ---------------------------------------------------------------------------

const log = buildLogger();

/** §14.1 queue names — the D-12 six-queue topology. */
export const QUEUE_NAMES = {
  scheduler: "monitor-scheduler",
  checks: "monitor-checks",
  dbWrites: "db-writes",
  alerts: "alerts",
  maintenance: "maintenance",
  email: "email-transactional",
} as const;

/**
 * 01-02 lane priorities: manual/non-UP checks, ticks, relay and alerts run at
 * 1 (cadence- and transition-critical); maintenance, db-writes and email at 5;
 * routine UP checks at 10 (droppable under the backlog gate). Lower numbers
 * dequeue first — priority orders jobs WITHIN a queue only.
 */
export const LANE_PRIORITY = {
  manualCheck: 1,
  nonUpCheck: 1,
  tick: 1,
  relayPass: 1,
  alert: 1,
  maintenance: 5,
  dbWrites: 5,
  email: 5,
  routineCheck: 10,
} as const;

/** Check-job options pinned by this plan (asserted verbatim in retries tests). */
export const CHECK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 14 * 24 * 3600 }, // DLQ retention (WRK-06)
} as const;

/**
 * The claim transaction's RETURNING shape (§14.3, 01-02): status drives the
 * J-6 lane assignment and next_check_at drives the jobId epoch — both come
 * from the atomic claim, never from a second read.
 */
export interface ClaimedMonitor {
  id: number;
  status: string;
  nextCheckAt: Date;
}

/**
 * What the check enqueue paths need from the checks queue: add() plus the
 * backlog gate's getJobCounts depth read. Injectable so tests substitute
 * fakes (rejections, inflated counts) without touching the real queue.
 */
export interface CheckQueueClient {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

export interface WorkerQueueSet {
  scheduler: Queue;
  checks: Queue;
  dbWrites: Queue;
  alerts: Queue;
  maintenance: Queue;
  email: Queue;
  /** The one shared producer connection (§25 budget — never per-queue). */
  connection: IORedis;
  close(): Promise<void>;
}

/**
 * Builds the six Queue instances. All share ONE ioredis producer connection
 * (pass one in to reuse an existing client — e.g. tests over the docker test
 * Redis); when the factory creates the connection itself it owns the quit.
 */
export function createWorkerQueues(connection?: IORedis): WorkerQueueSet {
  const ownsConnection = connection === undefined;
  const conn = connection ?? workerConnection();
  const queues = {
    scheduler: new Queue(QUEUE_NAMES.scheduler, { connection: conn }),
    checks: new Queue(QUEUE_NAMES.checks, { connection: conn }),
    dbWrites: new Queue(QUEUE_NAMES.dbWrites, { connection: conn }),
    alerts: new Queue(QUEUE_NAMES.alerts, { connection: conn }),
    maintenance: new Queue(QUEUE_NAMES.maintenance, { connection: conn }),
    email: new Queue(QUEUE_NAMES.email, { connection: conn }),
  };
  return {
    ...queues,
    connection: conn,
    async close(): Promise<void> {
      // BullMQ quits a passed-in client on close() (it does not track shared
      // ownership), so every close is settled defensively and the connection
      // quit stays idempotent — teardown order is queues first, then the wire.
      await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
      if (ownsConnection) {
        await conn.quit().catch(() => {
          /* already ended by a queue close — shutdown stays idempotent */
        });
      }
    },
  };
}

const globalForQueues = global as unknown as { workerQueueSet?: WorkerQueueSet };

/** The process-wide queue set (lazy — one shared connection for all lanes). */
export function workerQueues(): WorkerQueueSet {
  if (!globalForQueues.workerQueueSet) {
    globalForQueues.workerQueueSet = createWorkerQueues();
  }
  return globalForQueues.workerQueueSet;
}

/** Drops the cached set (vitest resetModules discipline — see db.ts). */
export function disposeWorkerQueues(): void {
  const set = globalForQueues.workerQueueSet;
  if (set) {
    void set.close();
    delete globalForQueues.workerQueueSet;
  }
}

// ---------------------------------------------------------------------------
// JobId derivation (WRK-03 / 01-02 / 01-08)
// ---------------------------------------------------------------------------

/**
 * Claimed-check idempotency key: `check:{monitorId}:{epoch-seconds}`.
 * Exactly 3 colon-separated segments — BullMQ 6 REJECTS colon-containing
 * jobIds that do not split into exactly 3 parts (legacy repeatable-job
 * compatibility check in Job.validateOptions).
 */
export function claimedCheckJobId(monitorId: number, nextCheckAt: Date): string {
  return `check:${monitorId}:${Math.floor(nextCheckAt.getTime() / 1000)}`;
}

/**
 * Manual-check key: unique per enqueue (admission is the limiter's job).
 * Form `check-manual:{monitorId}:{epochMs}` — the 01-08 semantics (unique per
 * enqueue, never a dedup across manual checks) in BullMQ 6's MANDATORY
 * 3-segment shape: the 4-segment form `check:{monitorId}:manual:{epochMs}`
 * throws "Custom Id cannot contain :" in Job.validateOptions (Rule 3
 * deviation, documented in 04-02-SUMMARY.md; §14.1 amendment note).
 *
 * The epoch token is strictly monotonic per process: two enqueues inside the
 * same millisecond (double-click) still get distinct keys.
 */
let lastManualToken = 0;

export function manualCheckJobId(monitorId: number, nowMs: number = Date.now()): string {
  lastManualToken = nowMs > lastManualToken ? nowMs : lastManualToken + 1;
  return `check-manual:${monitorId}:${lastManualToken}`;
}

/**
 * Tier-2 flush job id: `flush:{monitorId}:{passEpochMs}` — exactly 3 colon
 * segments (BullMQ 6's mandatory shape). The batchId `{epochMs}:{monitorId}`
 * contains its OWN colon, so embedding it wholesale would build a rejected
 * 4-segment id; it rides job DATA instead (04-06 resolution of the plan's
 * flush:{monitorId}:{batchId} form — see enqueueFlushJob in engine/check.ts).
 */
export function flushJobId(monitorId: number, passEpochMs: number): string {
  return `flush:${monitorId}:${passEpochMs}`;
}

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

/**
 * The ONLY door to the check queue: enqueues a check job and REFUSES to run
 * without an explicit priority (Pitfall 3 — unpriorized jobs would dequeue
 * before every prioritized lane, inverting J-6), and refuses LOUDLY while the
 * Postgres breaker is OPEN (RES-01 — the enqueue-side gate, Pattern 6).
 */
export async function addCheckJob(
  queue: CheckQueueClient,
  monitorId: number,
  opts: { priority?: number; jobId: string }
): Promise<unknown> {
  if (opts.priority === undefined) {
    throw new Error(
      "[worker-queues] refusing to enqueue a check job without an explicit priority — " +
        "BullMQ default-0 processes unprioritized jobs BEFORE prioritized ones (Pitfall 3 / WRK-12)"
    );
  }
  if (!(await canEnqueue())) {
    log.warn(
      { monitorId, jobId: opts.jobId, marker: BREAKER_GATE_MARKER },
      "check enqueue refused — Postgres breaker OPEN (RES-01, enqueue-side gate)"
    );
    throw new BreakerOpenError(`check job ${opts.jobId}`);
  }
  return queue.add("check", { monitorId }, {
    ...CHECK_JOB_OPTIONS,
    priority: opts.priority,
    jobId: opts.jobId,
  });
}

export interface CheckEnqueueDeps {
  /** Overrides the checks queue (tests inject rejections/fakes). */
  checksQueue?: CheckQueueClient;
  /** Reuses the scheduler's per-tick backlog gate (routine lane only). */
  gate?: BacklogGate;
}

export interface CheckEnqueueOutcome {
  jobId: string;
  priority: number;
  /** true when the backlog gate dropped a routine enqueue (RES-02). */
  dropped: boolean;
  /** true when the Postgres breaker gate skipped this enqueue (RES-01). */
  breakerGated?: boolean;
}

/**
 * Enqueues one check for a row returned by the claim transaction. Lane
 * assignment (J-6): status UP -> routine priority 10 (backlog-gated, droppable);
 * anything else -> priority 1 (a non-UP monitor's next check can carry the
 * RECOVERED transition — never gated, 01-02). A breaker refusal — at the
 * outer gate below, or inside addCheckJob's inner gate after it passed
 * (the WR-02 TOCTOU window) — is a SKIP. Any OTHER add() failure rethrows
 * with the claim LEFT ADVANCED: the audit §14.4 J-1 disposition (one missed
 * check per un-enqueued monitor is the accepted consequence; a rollback
 * storm against a dying database would only add write pressure, WR-03/D-29).
 */
export async function enqueueClaimedCheck(
  row: ClaimedMonitor,
  deps: CheckEnqueueDeps = {}
): Promise<CheckEnqueueOutcome> {
  const routine = row.status === "UP";
  const priority = routine ? LANE_PRIORITY.routineCheck : LANE_PRIORITY.nonUpCheck;
  const jobId = claimedCheckJobId(row.id, row.nextCheckAt);
  const queue = deps.checksQueue ?? workerQueues().checks;

  // Breaker gate BEFORE any add(): a refusal is a SKIP, not a failed enqueue
  // — deliberately NO J-1 rollback (§14.4 posture: claims stay advanced; the
  // next tick re-claims naturally once Postgres recovers, and a rollback
  // storm against a dead database would only add write pressure).
  if (!(await canEnqueue())) {
    log.warn(
      { monitorId: row.id, jobId, marker: BREAKER_GATE_MARKER },
      "claimed-check enqueue skipped — Postgres breaker OPEN, claims stay advanced (RES-01 / §14.4)"
    );
    return { jobId, priority, dropped: true, breakerGated: true };
  }

  if (routine) {
    const gate = deps.gate ?? openBacklogGate({ checksQueue: queue });
    if (!(await gate.canAcceptRoutine())) {
      noteBacklogDrop({ monitorId: row.id, jobId });
      return { jobId, priority, dropped: true };
    }
  }

  try {
    await addCheckJob(queue, row.id, { priority, jobId });
  } catch (err) {
    if (err instanceof BreakerOpenError) {
      // WR-02 (D-29): the breaker OPENED between the outer canEnqueue check
      // above and addCheckJob's inner gate — a refusal is STILL a skip, not
      // a failed enqueue. Same skip shape as the outer-gate return above,
      // verbatim; claims stay advanced per the §14.4 posture.
      log.warn(
        { monitorId: row.id, jobId, marker: BREAKER_GATE_MARKER },
        "claimed-check enqueue skipped — breaker OPENED between the enqueue gates, claims stay advanced (RES-01 / §14.4)"
      );
      return { jobId, priority, dropped: true, breakerGated: true };
    }
    // WR-03 (D-29, audit §14.4 J-1): NO rollback — the claim stays advanced,
    // the missed check is the accepted consequence, and the next tick
    // re-claims the monitor when due. Re-throw so the tick counts a failure.
    log.error(
      {
        monitorId: row.id,
        jobId,
        err: err instanceof Error ? err.message : String(err),
      },
      "check enqueue FAILED — claim stays advanced, next tick re-claims when due (J-1 / §14.4)"
    );
    throw err;
  }
  return { jobId, priority, dropped: false };
}

/**
 * Enqueues a manual ("check now") check at priority 1 (J-6), with the
 * per-enqueue-unique manual jobId (01-08): admission is the D-13 limiter's
 * job in the API route, never the jobId's. Never gated by the backlog cap.
 * The API-side next_check_at advance (01-08) belongs to the caller — this
 * helper owns the enqueue only.
 */
export async function enqueueManualCheck(
  monitorId: number,
  deps: { checksQueue?: CheckQueueClient } = {}
): Promise<{ jobId: string; priority: number }> {
  const queue = deps.checksQueue ?? workerQueues().checks;
  // Breaker gate FIRST (before minting a jobId): manual enqueues must FAIL
  // LOUDLY — the API route maps BreakerOpenError to a 503 "try again", which
  // is the honest answer while Postgres is down (a queued manual check would
  // outlive the poll window anyway).
  if (!(await canEnqueue())) {
    log.warn(
      { monitorId, marker: BREAKER_GATE_MARKER },
      "manual-check enqueue refused — Postgres breaker OPEN (API maps BreakerOpenError to 503)"
    );
    throw new BreakerOpenError(`manual check for monitor ${monitorId}`);
  }
  const jobId = manualCheckJobId(monitorId);
  await addCheckJob(queue, monitorId, { priority: LANE_PRIORITY.manualCheck, jobId });
  return { jobId, priority: LANE_PRIORITY.manualCheck };
}

// ---------------------------------------------------------------------------
// Queue observability (OBS-01 subset) — the /metrics.json queue section
// ---------------------------------------------------------------------------

/**
 * In-process Worker 'stalled' event counters, keyed by queue name. BullMQ
 * exposes no stalled-set size (stalls are transient re-deliveries, not a
 * stored set), so the count is of stall events OBSERVED since process start —
 * the honest per-process signal the health snapshot can carry.
 */
const stalledEvents = new Map<string, number>();

/** Called from a Worker's 'stalled' handler; monotonic per process. */
export function noteStalledEvent(queueName: string): void {
  stalledEvents.set(queueName, (stalledEvents.get(queueName) ?? 0) + 1);
}

export function stalledEventCount(queueName: string): number {
  return stalledEvents.get(queueName) ?? 0;
}

/**
 * In-process PERMANENT email-failure counters, keyed by queue name — the
 * stalledEvents precedent applied to the email lane's dead-letter path
 * (D-10/D-34: permanent failure is log + metric only, no user-facing
 * surface; BullMQ's failed set already retains the jobs themselves).
 */
const emailFailures = new Map<string, number>();

/** Called from processEmailJob's permanent-failure path; monotonic per process. */
export function noteEmailFailure(queueName: string): void {
  emailFailures.set(queueName, (emailFailures.get(queueName) ?? 0) + 1);
}

export function emailFailureCount(queueName: string): number {
  return emailFailures.get(queueName) ?? 0;
}

/** Per-queue gauge surfaced on /metrics.json (OBS-01). */
export interface QueueGauge {
  /**
   * wait+prioritized+delayed+active depth — the backlog gate's own depth
   * definition. Empirical bullmq 6.3 note: a job carrying `priority` is
   * filed in the PRIORITIZED set, never plain wait — and every check-lane
   * enqueue carries one (Pitfall 3) — so a wait-only read would report an
   * empty check queue while it backs up.
   */
  depth: { wait: number; prioritized: number; delayed: number; active: number };
  /**
   * Age of the oldest job waiting for a worker. Scanned over bounded head
   * pages of BOTH the wait set (FIFO — the head IS the oldest) and the
   * prioritized set (priority-ordered — the oldest can sit anywhere in the
   * page, so the minimum timestamp wins); null when nothing is pending.
   */
  oldestWaitingJobAgeMs: number | null;
  /** Stall events observed since process start (see noteStalledEvent). */
  stalledCount: number;
}

/** The full queue section: one gauge per lane plus the backlog drop counter. */
export interface QueueMetricsSnapshot {
  queues: Record<string, QueueGauge>;
  backlogDrops: number;
}

/** Bounded head-page size for the oldest-pending age scan (per set). */
const AGE_SCAN_PAGE = 50;

/**
 * Collects one gauge per queue lane (depth via getJobCounts, oldest-pending
 * age via a bounded wait+prioritized head scan) plus the process backlog-drop
 * counter. A lane whose depth read fails degrades its depths to -1 — visible,
 * never fatal to the health endpoint (fail-open, same philosophy as the
 * backlog gate).
 */
export async function collectQueueMetrics(queues: WorkerQueueSet): Promise<QueueMetricsSnapshot> {
  const entries = await Promise.all(
    (Object.keys(QUEUE_NAMES) as Array<keyof typeof QUEUE_NAMES>).map(async (lane) => {
      const queue = queues[lane];
      const name = QUEUE_NAMES[lane];
      const stalledCount = stalledEventCount(name);
      try {
        const counts = await queue.getJobCounts("wait", "prioritized", "delayed", "active");
        const depth = {
          wait: counts.wait ?? 0,
          prioritized: counts.prioritized ?? 0,
          delayed: counts.delayed ?? 0,
          active: counts.active ?? 0,
        };
        let oldestWaitingJobAgeMs: number | null = null;
        if (depth.wait + depth.prioritized > 0) {
          const [waiting, prioritized] = await Promise.all([
            depth.wait > 0 ? queue.getWaiting(0, AGE_SCAN_PAGE - 1) : Promise.resolve([]),
            depth.prioritized > 0 ? queue.getPrioritized(0, AGE_SCAN_PAGE - 1) : Promise.resolve([]),
          ]);
          const stamps = [...waiting, ...prioritized]
            .map((job) => job.timestamp)
            .filter((ts): ts is number => typeof ts === "number");
          if (stamps.length > 0) {
            oldestWaitingJobAgeMs = Math.max(0, Date.now() - Math.min(...stamps));
          }
        }
        return [name, { depth, oldestWaitingJobAgeMs, stalledCount }] as const;
      } catch {
        return [
          name,
          {
            depth: { wait: -1, prioritized: -1, delayed: -1, active: -1 },
            oldestWaitingJobAgeMs: null,
            stalledCount,
          },
        ] as const;
      }
    })
  );
  return { queues: Object.fromEntries(entries), backlogDrops: backlogDropCount() };
}

// ---------------------------------------------------------------------------
// Lane workers (WRK-01 — registered by src/worker/index.ts at boot). Each lane
// owns ONE blocking worker connection (§25 budget: 1 producer + N blocking
// workers per process, one per lane) and pins the stalled config explicitly:
// lockDuration/stalledInterval 30000 with maxStalledCount 1 — a stalled job is
// redelivered AT LEAST ONCE, which every persistence layer here is built to
// absorb (write guards, RENAMENX, conditional transitions).
// ---------------------------------------------------------------------------

/** §14.1 check-lane concurrency: 10 checks in flight per worker process. */
export const CHECK_LANE_CONCURRENCY = 10;

/** §14.1 db-writes-lane concurrency: 5 guarded flushes in flight. */
export const DB_WRITES_LANE_CONCURRENCY = 5;

/**
 * §14.1 alerts-lane concurrency: 1 — one relay pass at a time. The pass
 * self-spaces via the 5 s scheduler cadence, and processRelayJob's per-row
 * FOR UPDATE SKIP LOCKED claim is what guards multi-PROCESS overlap; a single
 * pass at a time per process keeps the stalled-checker's 30 s lockDuration
 * comfortably above a 50-row batch of Telegram sends.
 */
export const ALERTS_LANE_CONCURRENCY = 1;

/** §14.1 maintenance-lane concurrency: 1 — D-7: bulk deletes never parallelize. */
export const MAINTENANCE_LANE_CONCURRENCY = 1;

/** A lane job as consumers see it (BullMQ Job structural subset). */
export interface LaneJob {
  id?: string;
  name: string;
  data: unknown;
}

/** A lane consumer — index.ts wires the engine processors in here. */
export type LaneProcessor = (job: LaneJob) => Promise<unknown>;

/** What the boot flow needs to drain the lane (WRK-07 drainable). */
export interface LaneWorkerHandle {
  close(): Promise<void>;
}

function startLaneWorker(
  queueName: string,
  processor: LaneProcessor,
  concurrency: number
): LaneWorkerHandle {
  const worker = new Worker(queueName, async (job) => processor({ id: job.id, name: job.name, data: job.data }), {
    // The blocking worker connection — dedicated, owned and closed by BullMQ.
    connection: workerConnection(),
    concurrency,
    lockDuration: 30_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  });
  worker.on("stalled", (jobId) => {
    noteStalledEvent(queueName);
    log.warn({ jobId, queueName }, "lane job stalled — redelivered at-least-once (idempotent persistence absorbs it)");
  });
  worker.on("error", (err) => {
    log.error({ queueName, err: err.message }, "lane worker error");
  });
  return {
    close: () => worker.close(),
  };
}

/**
 * Starts the check-lane consumer (WRK-01). ALWAYS runs regardless of the
 * D-16 flag — dark launch keeps consumers live for operator smoke enqueues;
 * only the recurring schedulers are gated (never queue.pause, Pitfall 12).
 */
export function startCheckLaneWorker(
  processor: LaneProcessor,
  opts: { concurrency?: number } = {}
): LaneWorkerHandle {
  return startLaneWorker(QUEUE_NAMES.checks, processor, opts.concurrency ?? CHECK_LANE_CONCURRENCY);
}

/**
 * Starts the dbWrites-lane consumer — the Tier-2 flush jobs and the
 * flush-sweep scheduler tick land here (name dispatch inside the processor).
 */
export function startDbWritesLaneWorker(
  processor: LaneProcessor,
  opts: { concurrency?: number } = {}
): LaneWorkerHandle {
  return startLaneWorker(QUEUE_NAMES.dbWrites, processor, opts.concurrency ?? DB_WRITES_LANE_CONCURRENCY);
}

/**
 * Starts the alerts-lane consumer — the outbox relay pass (04-07's
 * processRelayJob, driven by the relay-pass scheduler or any manual enqueue).
 * ALWAYS runs regardless of the D-16 flag (consumers live during dark launch).
 */
export function startAlertsLaneWorker(
  processor: LaneProcessor,
  opts: { concurrency?: number } = {}
): LaneWorkerHandle {
  return startLaneWorker(QUEUE_NAMES.alerts, processor, opts.concurrency ?? ALERTS_LANE_CONCURRENCY);
}

/**
 * Starts the maintenance-lane consumer — dry-run reports and batched
 * retention deletes (04-07's processMaintenanceJob). Concurrency 1 (D-7).
 */
export function startMaintenanceLaneWorker(
  processor: LaneProcessor,
  opts: { concurrency?: number } = {}
): LaneWorkerHandle {
  return startLaneWorker(QUEUE_NAMES.maintenance, processor, opts.concurrency ?? MAINTENANCE_LANE_CONCURRENCY);
}

// ---------------------------------------------------------------------------
// Email lane (06-02, EML-02/EML-03) — transactional sends enqueued by the
// web routes via enqueueTransactionalEmail. The ONE lane-family deviation:
// its Worker carries settings.backoffStrategy (D-09's exact table) because
// email jobs use backoff { type: "custom" } — the built-in exponential
// yields 30s/1m/2m/4m/8m and fails the hour-or-two SMTP outage reach
// (Pitfall 2).
// ---------------------------------------------------------------------------

/** Email-lane concurrency (planner pin per research A4 — trivially tunable). */
export const EMAIL_LANE_CONCURRENCY = 1;

/**
 * D-09's exact retry table: 30s / 2m / 8m / 30m / 2h (≈2.7h total reach —
 * "an hour-or-two SMTP outage still delivers"). NOT a 2^(n-1) progression.
 */
export const EMAIL_BACKOFF_MS = [30_000, 120_000, 480_000, 1_800_000, 7_200_000] as const;

/**
 * The Worker-side custom backoff strategy (Pitfall 2): the exact per-attempt
 * table value, clamped — beyond the table the LAST value (2h) repeats.
 */
export function emailBackoffDelay(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1), EMAIL_BACKOFF_MS.length) - 1;
  return EMAIL_BACKOFF_MS[index];
}

/**
 * Starts the email-lane consumer (06-02's processEmailJob over the
 * env-selected provider). Follows the startMaintenanceLaneWorker factory
 * shape with one deviation: settings.backoffStrategy — the D-09 table.
 */
export function startEmailLaneWorker(
  processor: LaneProcessor,
  opts: { concurrency?: number } = {}
): LaneWorkerHandle {
  const worker = new Worker(QUEUE_NAMES.email, async (job) => processor({ id: job.id, name: job.name, data: job.data }), {
    connection: workerConnection(),
    concurrency: opts.concurrency ?? EMAIL_LANE_CONCURRENCY,
    lockDuration: 30_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
    settings: {
      backoffStrategy: emailBackoffDelay,
    },
  });
  worker.on("stalled", (jobId) => {
    noteStalledEvent(QUEUE_NAMES.email);
    log.warn({ jobId, queueName: QUEUE_NAMES.email }, "lane job stalled — redelivered at-least-once (idempotent persistence absorbs it)");
  });
  worker.on("error", (err) => {
    log.error({ queueName: QUEUE_NAMES.email, err: err.message }, "lane worker error");
  });
  return {
    close: () => worker.close(),
  };
}

// The enqueue contract (EMAIL_JOB_OPTIONS — priority LANE_PRIORITY.email,
// attempts 5, backoff { type: "custom" }) lives in the web-side module
// src/lib/email/enqueue.ts and is NOT re-exported from here: a re-export
// would make enqueue.ts a dependency of this module, and enqueue.ts reads
// LANE_PRIORITY at module scope — the cycle would evaluate it BEFORE this
// module's body runs (undefined.email at import time; verified in vitest).
// The lone enqueue → queues direction stays safe: queue-producer references
// QUEUE_NAMES/LANE_PRIORITY only inside function bodies (ESM live bindings).

// ---------------------------------------------------------------------------
// Maintenance enqueue (WRK-13 / D-16)
// ---------------------------------------------------------------------------

/** What the maintenance enqueue path needs from the queue (injectable). */
export interface MaintenanceQueueClient {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
}

/** Maintenance job options — mirrors the maintenance-cleanup scheduler template. */
export const MAINTENANCE_JOB_OPTIONS = {
  priority: LANE_PRIORITY.maintenance,
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: { age: 604800 },
} as const;

/**
 * Manually enqueues one maintenance job (WRK-13). Works REGARDLESS of
 * WORKER_SCHEDULER_ENABLED (D-16): the flag gates the recurring scheduler
 * upserts only — the operator can enqueue a dry-run audit (or a real run)
 * during dark launch, and the always-live lane consumer processes it.
 */
export async function enqueueMaintenance(
  opts: { dryRun: boolean },
  deps: { maintenanceQueue?: MaintenanceQueueClient } = {}
): Promise<{ dryRun: boolean; priority: number; job: unknown }> {
  const queue = deps.maintenanceQueue ?? workerQueues().maintenance;
  const job = await queue.add("cleanup", { dryRun: opts.dryRun }, { ...MAINTENANCE_JOB_OPTIONS });
  log.info({ dryRun: opts.dryRun, priority: LANE_PRIORITY.maintenance }, "maintenance job enqueued (manual path, D-16)");
  return { dryRun: opts.dryRun, priority: LANE_PRIORITY.maintenance, job };
}
