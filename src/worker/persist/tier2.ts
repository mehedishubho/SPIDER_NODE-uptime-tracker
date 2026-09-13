import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import IORedis from "ioredis";
import { workerDb } from "../db";

// ---------------------------------------------------------------------------
// Tier 2 — the guarded monotonic flush for routine-UP results (DAT-02/03/07,
// audit §16.2 amended literal + the D-35 in-UPDATE uptime derivation shared
// with tier1.ts).
//
// Every check whose classified result KEEPS monitors.status (routine UP on an
// UP monitor) stages its evidence + deltas in Redis and lands in Postgres via
// ONE guarded flush per monitor within the ≤60 s window (rule 9) — the durable
// rewrite of src/lib/db-batcher.ts whose in-memory queues lost up to 15 min of
// pings on crash (CONCERNS B-series) and whose flush wrote monitor.status from
// a stale in-memory value (B3 state regression — this module NEVER writes
// status, structurally: the UPDATE below references no status column).
//
// §16.2 three-step sequence, transcribed:
//   step 0 — job-start exclusive snapshot (Redis): a read-only write_guards
//     pre-check first (a pre-existing flush:{batchId} row means this batch
//     already COMMITTED — skip straight to cleanup, never touch the live key),
//     then RENAMENX stage:{monitorId} -> flushstage:{batchId} as the atomic
//     ownership handoff. RENAMENX, never a plain rename: a redelivered job
//     whose snapshot still exists (crash BEFORE COMMIT) does not recapture the
//     live key — post-snapshot deltas stay staged for the next pass — and a
//     redelivery AFTER commit is stopped by the guard pre-check before any
//     rename could drag fresh live deltas into a key the exit path deletes
//     (CR-02 over-delete; 01-06 pin).
//   step 1 — ONE guarded Postgres transaction: write_guards insert
//     (ON CONFLICT DO NOTHING, RETURNING) -> multi-row pings INSERT ->
//     additive monitors UPDATE. Zero guard rows returned means the batch was
//     already applied (crash after COMMIT, pre-check raced) — counters AND
//     pings are skipped while the transaction still commits (J-2/DAT-03).
//   step 2 — post-commit cleanup: DEL flushstage:{batchId} strictly AFTER the
//     COMMIT, including on every skip path. The live stage:{monitorId} key is
//     NEVER deleted by a flush — only ever moved by the next pass's snapshot.
//
// Single-key consolidation (this plan's key-namespace pin): the audit's two
// Redis containers (agg hash + pings list) collapse into ONE staging hash
// stage:{monitorId} whose ping:{slot} fields each carry a complete evidence
// row (status, responseTime, errorClass, statusCode, createdAtMs). The flush
// deltas are DERIVED from those rows (dTotal = row count, dFailed = non-UP
// row count) instead of a parallel counter field: an HINCRBY maintained
// beside the rows can drift from them across a crash between the two writes
// (counter says +1, evidence row absent), while row-derived deltas are
// self-consistent by construction — the counters can never account a check
// whose evidence row does not exist.
//
// uptime_percent (D-35/D-36): derived IN the same UPDATE with the EXACT
// expression shipped in tier1.ts — power-of-two ::bigint extraction of the
// computed double's exact binary value (2^52 shift for y >= 1, 2^60 for
// y < 1) then round-half-up in integer arithmetic floor((m*100 + 2^(s-1)) /
// 2^s). No round() call anywhere: every round()-based form fails inexact
// .xx5 ties because PG's float8-to-numeric collapse lands exactly ON the
// decimal tie (see the tier1.ts header for the full proof — 73,210 swept
// ratios render byte-identically to the legacy JS toFixed(2)).
//
// batchId (IN-03, 01-06 pin): {epochMs-of-flush-pass}:{monitorId}, carried in
// the flush job's data so a redelivery re-derives the identical snapshot key
// and guard key. This module imports NOTHING from queues.ts — the trigger
// wiring (check processor stageResult + db-writes flush job + D-16-gated
// scheduler sweep) is 04-06's job.
//
// Accepted ceiling (T-04-20): Redis is staging only — a Redis crash can drop
// at most ~60 s of routine-UP evidence. Postgres counters/monitors are never
// corrupted by it (the flush is all-or-nothing per batch).
// ---------------------------------------------------------------------------

/** Rule 9 upper bound on the staging-to-Postgres window (§16 Tier 2). */
export const FLUSH_CADENCE_MS = 60_000;

/** Live staging namespace: one hash per monitor (this plan's key pin). */
const STAGE_KEY_PREFIX = "stage:";

/** Snapshot namespace: batch-scoped, holds the renamed staging hash. */
const FLUSH_STAGE_KEY_PREFIX = "flushstage:";

/** Postgres write_guards namespace (audit §11 key formats). */
const GUARD_KEY_PREFIX = "flush:";

/** Hash field that allocates the next ping slot (HINCRBY). */
const PING_SEQ_FIELD = "pingSeq";

/** Hash field prefix for staged evidence rows (JSON blobs). */
const PING_FIELD_PREFIX = "ping:";

/** Staging key for a monitor's live routine-UP deltas. */
export function stagingKey(monitorId: number): string {
  return `${STAGE_KEY_PREFIX}${monitorId}`;
}

/** Snapshot key a flush owns exclusively for one batchId. */
export function flushStageKey(batchId: string): string {
  return `${FLUSH_STAGE_KEY_PREFIX}${batchId}`;
}

/** Postgres write_guards key for one flush batch (DAT-03). */
export function flushGuardKey(batchId: string): string {
  return `${GUARD_KEY_PREFIX}${batchId}`;
}

/** The pinned deterministic batchId form (IN-03 / 01-06). */
export function makeBatchId(passEpochMs: number, monitorId: number): string {
  return `${passEpochMs}:${monitorId}`;
}

/**
 * One classified routine check result. Mirrors the CheckOutcome vocabulary
 * (status/responseTimeMs/errorClass/statusCode, DAT-10) but is defined
 * LOCALLY — same-wave plans never create cross-file type coupling; 04-06's
 * processor joins the vocabularies structurally (tier1.ts precedent).
 * Tier 2's contract accepts UP-CLASS ONLY: any DOWN-class outcome belongs to
 * Tier 1's transition transaction and is rejected loudly here so a misrouted
 * transition can never be silently swallowed as routine evidence.
 */
export interface Tier2Outcome {
  status: "UP" | "DOWN";
  responseTimeMs: number;
  errorClass: string | null;
  statusCode: number | null;
}

/** One staged evidence row (the ping:{slot} JSON payload). */
export interface StagedPingRow {
  status: string;
  responseTime: number;
  errorClass: string | null;
  statusCode: number | null;
  createdAtMs: number;
}

/** Why a flush completed without applying (all benign, logged paths). */
export type Tier2SkipReason =
  | "guard-preexists" // this batchId already committed (pre-check or in-txn)
  | "not-owner" // another flush owns the staging, or nothing was staged
  | "empty" // snapshot held no evidence rows
  | "monitor-missing"; // monitor deleted while staged — FK-safe no-op

/** What flushMonitor did — the flush job's log/metric surface. */
export interface Tier2FlushResult {
  applied: boolean;
  skipped: Tier2SkipReason | null;
  pingsInserted: number;
}

/** One flushDueMonitors() outcome, keyed for the sweep's caller. */
export interface DueFlushOutcome extends Tier2FlushResult {
  monitorId: number;
  batchId: string;
}

// globalThis cache (same shape as src/worker/db-pool.ts and locks.ts) so
// vitest's resetModules/re-import discipline can dispose and rebuild the
// singleton between cases. Bounded profile like the lock client (NOT the
// BullMQ null profile): every Tier-2 Redis op is a fast one-shot command and
// a Redis outage must surface as an error, not an infinite retry hang.
const globalForTier2 = global as unknown as { workerStagingRedis?: IORedis };

function createStagingRedis(): IORedis {
  const connectionString = process.env.REDIS_URL;
  if (!connectionString) {
    throw new Error("Environment variable REDIS_URL is not set");
  }
  const client = new IORedis(connectionString, {
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
    connectTimeout: 1000,
    enableReadyCheck: true,
  });
  // Error listener attached inside the factory so module re-evaluations never
  // stack duplicate listeners; err.message only (secrets rule).
  client.on("error", (err) => {
    console.error("[worker-tier2] connection error:", err.message);
  });
  return client;
}

/** The worker's Tier-2 staging Redis client (module singleton, lazy). */
export function stagingRedis(): IORedis {
  if (!globalForTier2.workerStagingRedis) {
    globalForTier2.workerStagingRedis = createStagingRedis();
  }
  return globalForTier2.workerStagingRedis;
}

/** Disposes the singleton (tests; mirrors the locks.ts discipline). */
export function disposeStagingRedis(): void {
  if (globalForTier2.workerStagingRedis) {
    globalForTier2.workerStagingRedis.disconnect();
    delete globalForTier2.workerStagingRedis;
  }
}

/**
 * Renders an epoch-ms instant as the UTC wall-clock string Postgres parses
 * into the naive timestamp(3) columns (pings."createdAt",
 * monitors."lastChecked" — A6: without time zone). Explicit UTC formatting
 * keeps staging->Postgres comparisons deterministic regardless of any
 * session/runner timezone.
 */
export function formatPgTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").replace("Z", "");
}

function validateMonitorId(monitorId: number): void {
  if (!Number.isInteger(monitorId) || monitorId <= 0) {
    throw new Error(`tier2: monitorId must be a positive integer (got ${monitorId})`);
  }
}

function validateBatchId(batchId: string): void {
  if (!/^\d+:\d+$/.test(batchId)) {
    throw new Error(
      `tier2: batchId must match {epochMs}:{monitorId} (IN-03 pin), got '${batchId}'`
    );
  }
}

/**
 * Stages one routine-UP result into the live hash stage:{monitorId}.
 *
 * Slot allocation is HINCRBY (atomic), so concurrent stagers never collide;
 * the row lands as its own ping:{slot} field, making the write
 * crash-consistent — a crash between the HINCRBY and the HSET leaves a slot
 * gap that only ever loses that one row (the T-04-20 ceiling), never a
 * counter without evidence. DOWN-class outcomes throw: transition evidence
 * belongs to Tier 1 (§16.2 contract; misrouting must be loud).
 */
export async function stageResult(
  monitorId: number,
  outcome: Tier2Outcome,
  checkedAt: Date,
  client: IORedis = stagingRedis()
): Promise<void> {
  validateMonitorId(monitorId);
  if (outcome.status !== "UP") {
    throw new Error(
      `stageResult: only routine UP-class outcomes may be staged (got '${outcome.status}') — transition-class results belong to Tier 1 (§16.2)`
    );
  }
  if (!Number.isInteger(outcome.responseTimeMs) || outcome.responseTimeMs < 0) {
    throw new Error(
      `stageResult: responseTimeMs must be a non-negative integer (got ${outcome.responseTimeMs})`
    );
  }
  if (!(checkedAt instanceof Date) || Number.isNaN(checkedAt.getTime())) {
    throw new Error("stageResult: checkedAt must be a valid Date");
  }

  const key = stagingKey(monitorId);
  const row: StagedPingRow = {
    status: "UP",
    responseTime: outcome.responseTimeMs,
    errorClass: outcome.errorClass,
    statusCode: outcome.statusCode,
    createdAtMs: checkedAt.getTime(),
  };
  const slot = await client.hincrby(key, PING_SEQ_FIELD, 1);
  await client.hset(key, `${PING_FIELD_PREFIX}${slot}`, JSON.stringify(row));
}

/** The parsed staging snapshot the flush applies. */
interface StagedSnapshot {
  rows: StagedPingRow[];
  dTotal: number;
  dFailed: number;
  /** Max staged createdAt (ties: later slot wins) — the $lastTs parameter. */
  lastTsMs: number;
  /** responseTime paired with lastTsMs — the $lastRt parameter (§16.2). */
  lastRtMs: number;
}

/**
 * Parses the snapshot hash. Deltas DERIVE from the evidence rows (see the
 * module header): dTotal = row count, dFailed = non-UP row count — the
 * counters can never account a check whose evidence row is absent. The
 * lastTs/lastRt pairing scans rows in slot order with >=, so the response
 * time applied is always the one staged WITH the newest timestamp (the
 * monotonicity rule's write side; the UPDATE's CASE is its read side).
 */
function parseSnapshot(fields: Record<string, string>): StagedSnapshot {
  const slots = Object.keys(fields)
    .filter((field) => field.startsWith(PING_FIELD_PREFIX))
    .map((field) => Number.parseInt(field.slice(PING_FIELD_PREFIX.length), 10))
    .filter((slot) => Number.isInteger(slot) && slot > 0)
    .sort((a, b) => a - b);

  const rows: StagedPingRow[] = [];
  for (const slot of slots) {
    let row: StagedPingRow;
    try {
      row = JSON.parse(fields[`${PING_FIELD_PREFIX}${slot}`]) as StagedPingRow;
    } catch {
      // Corrupt staging is surfaced, never silently dropped — the snapshot
      // stays undeleted so the failure is visible in the flush job's retry.
      throw new Error(`tier2: corrupt staging row at ${PING_FIELD_PREFIX}${slot}`);
    }
    if (
      typeof row.status !== "string" ||
      !Number.isInteger(row.responseTime) ||
      !Number.isInteger(row.createdAtMs) ||
      (row.errorClass !== null && typeof row.errorClass !== "string") ||
      (row.statusCode !== null && !Number.isInteger(row.statusCode))
    ) {
      throw new Error(`tier2: malformed staging row at ${PING_FIELD_PREFIX}${slot}`);
    }
    rows.push(row);
  }

  let lastTsMs = Number.NEGATIVE_INFINITY;
  let lastRtMs = 0;
  for (const row of rows) {
    if (row.createdAtMs >= lastTsMs) {
      lastTsMs = row.createdAtMs;
      lastRtMs = row.responseTime;
    }
  }

  return {
    rows,
    dTotal: rows.length,
    dFailed: rows.filter((row) => row.status !== "UP").length,
    lastTsMs,
    lastRtMs,
  };
}

/**
 * §16.2 step-1 statement-1: the same-transaction write guard. Zero rows
 * returned means this batch already committed (crash after COMMIT,
 * redelivery) — the caller skips the counters AND the ping INSERT while the
 * transaction still commits (J-2 / DAT-03).
 */
export function guardInsertSql(guardKeyValue: string): SQL {
  return sql`
INSERT INTO write_guards (key)
VALUES (${guardKeyValue})
ON CONFLICT DO NOTHING
RETURNING key
`;
}

/**
 * §16.2 step-1 statement-2: the multi-row evidence INSERT (CR-01) — one tuple
 * per staged check, id omitted so the pinned gen_random_uuid() default
 * applies (DAT-07: an undefined PK can never reach the database), and the
 * DAT-10 metadata riding every row.
 */
export function pingsBulkInsertSql(monitorId: number, rows: StagedPingRow[]): SQL {
  const tuples = rows.map(
    (row) => sql`(${monitorId}, ${row.status}, ${row.responseTime}, ${row.errorClass}, ${row.statusCode}, ${formatPgTimestamp(row.createdAtMs)}::timestamp)`
  );
  return sql`
INSERT INTO pings ("monitorId", status, "responseTime", error_class, status_code, "createdAt")
VALUES ${sql.join(tuples, sql`, `)}
`;
}

/**
 * §16.2 step-1 statement-3: the ONE guarded additive UPDATE — the module's
 * whole counter effect. NEVER writes status (B3 fix — structurally absent,
 * not merely conditional). All math is SQL-relative so redelivery under the
 * guard's skip path cannot double-apply:
 *   - counters: additive deltas
 *   - uptimePercent: the D-35/D-36 exact-extraction derivation, IDENTICAL in
 *     shape to tier1.ts's transitionUpdateSql (the tier1 constants and
 *     branch structure are reused verbatim; only the increment arity changes
 *     from +1 check to +dTotal/-dFailed batch deltas) — byte-parity with the
 *     legacy JS toFixed(2) rendering is pinned there and must not be
 *     reimplemented as round()
 *   - lastChecked: GREATEST with an explicit epoch-zero COALESCE baseline —
 *     monotonic, never regresses an existing newer value
 *   - responseTime: the §16.2 monotonicity rule — replaced only when the
 *     staged newest timestamp is strictly newer than the row's CURRENT
 *     lastChecked (SET expressions read the old row; a NULL lastChecked
 *     takes the ELSE branch per the pinned asymmetry)
 */
export function monitorFlushUpdateSql(
  monitorId: number,
  dTotal: number,
  dFailed: number,
  lastTsMs: number,
  lastRtMs: number
): SQL {
  const lastTs = formatPgTimestamp(lastTsMs);
  // Power-of-two extraction constants (D-36): 2^52 = 4503599627370496 with
  // half-adder 2^51 = 2251799813685248 covers y >= 1; 2^60 =
  // 1152921504606846976 with half-adder 2^59 = 576460752303423488 covers
  // y < 1 exactly down to 2^-8 and safely below that.
  return sql`
UPDATE monitors
   SET "totalChecks" = "totalChecks" + ${dTotal},
       "failedChecks" = "failedChecks" + ${dFailed},
       "uptimePercent" = (
         CASE
           WHEN (
             (
               ("totalChecks" + ${dTotal} - ("failedChecks" + ${dFailed}))::double precision
               / ("totalChecks" + ${dTotal})
             ) * 100.0::double precision >= 1::double precision
           ) THEN floor(
             (
               (
                 (
                   (
                     ("totalChecks" + ${dTotal} - ("failedChecks" + ${dFailed}))::double precision
                     / ("totalChecks" + ${dTotal})
                   ) * 100.0::double precision
                   * 4503599627370496::double precision
                 )::bigint
               )::numeric * 100 + 2251799813685248
             ) / 4503599627370496
           )
           ELSE floor(
             (
               (
                 (
                   (
                     ("totalChecks" + ${dTotal} - ("failedChecks" + ${dFailed}))::double precision
                     / ("totalChecks" + ${dTotal})
                   ) * 100.0::double precision
                   * 1152921504606846976::double precision
                 )::bigint
               )::numeric * 100 + 576460752303423488
             ) / 1152921504606846976
           )
         END
       )::double precision / 100.0::double precision,
       "lastChecked" = GREATEST(
         COALESCE("lastChecked", '1970-01-01 00:00:00'::timestamp),
         ${lastTs}::timestamp
       ),
       "responseTime" = CASE WHEN ${lastTs}::timestamp > "lastChecked"
                             THEN ${lastRtMs}
                             ELSE "responseTime" END
 WHERE id = ${monitorId}
RETURNING id
`;
}

interface TxOutcome {
  applied: boolean;
  skip: Tier2SkipReason | null;
  pingsInserted: number;
}

/**
 * §16.2 step 0: take the exclusive snapshot for this batch. Returns
 * "snapshot" when this call owns the batch's evidence (rename won, OR our own
 * pre-crash snapshot still holds the batch-scoped key — the crash-before-
 * COMMIT redelivery path), "none" when there is nothing to do.
 *
 * Redis semantics handled explicitly: the NX rename ERRORS when the SOURCE
 * key is absent (not a 0), and returns 0 when the TARGET exists. A target
 * that exists under OUR deterministic batchId is always our own earlier
 * snapshot — a concurrent pass with a different batchId renames to a
 * different target and leaves ours alone.
 */
async function takeSnapshot(
  client: IORedis,
  monitorId: number,
  batchId: string
): Promise<"snapshot" | "none"> {
  let renamed: number | null = null;
  try {
    renamed = await client.renamenx(stagingKey(monitorId), flushStageKey(batchId));
  } catch (err) {
    // Source key absent — the §16.2 "source absent => no-op" case arrives as
    // an error reply, never as a 0.
    if (!(err instanceof Error) || !/no such key/i.test(err.message)) throw err;
    renamed = null;
  }
  if (renamed === 0 || renamed === 1) return "snapshot";
  // renamed === null: live key absent. Apply only a surviving own snapshot
  // (crash after rename, before COMMIT — redelivered here).
  const own = await client.exists(flushStageKey(batchId));
  return own === 1 ? "snapshot" : "none";
}

/**
 * Executes the §16.2 flush for one monitor + batchId: exclusive snapshot,
 * then ONE guarded transaction (guard insert -> ping INSERT -> additive
 * UPDATE), then the strictly-post-commit snapshot delete.
 *
 * Skip paths (all commit-or-nothing and all still clean the snapshot key):
 *   guard-preexists — batch already committed (pre-check, or raced in-txn);
 *     live staging staged AFTER that commit is never touched (CR-02)
 *   not-owner — a concurrent flush owns the staging, or nothing was staged
 *   empty — snapshot held no evidence rows (no transaction opened)
 *   monitor-missing — monitor deleted while staged; the guard row still
 *     commits so the job cannot retry forever against a dead FK target
 *     (mirrors tier1's §15.1 step-1 deleted-monitor no-op)
 */
export async function flushMonitor(
  monitorId: number,
  batchId: string
): Promise<Tier2FlushResult> {
  validateMonitorId(monitorId);
  validateBatchId(batchId);

  const client = stagingRedis();
  const snapKey = flushStageKey(batchId);
  const guardKeyValue = flushGuardKey(batchId);

  // Step 0a — read-only guard pre-check: skip straight to cleanup without
  // ever touching the live staging key (§16.2 amended step 0).
  const pre = await workerDb.execute(
    sql`SELECT key FROM write_guards WHERE key = ${guardKeyValue} LIMIT 1`
  );
  if (pre.rows.length > 0) {
    await client.del(snapKey);
    return { applied: false, skipped: "guard-preexists", pingsInserted: 0 };
  }

  // Step 0b — the exclusive snapshot handoff.
  if ((await takeSnapshot(client, monitorId, batchId)) === "none") {
    return { applied: false, skipped: "not-owner", pingsInserted: 0 };
  }

  const fields = await client.hgetall(snapKey);
  const snapshot = parseSnapshot(fields);
  if (snapshot.rows.length === 0) {
    // §16.2 missing-key completion: nothing staged, no transaction opened.
    await client.del(snapKey);
    return { applied: false, skipped: "empty", pingsInserted: 0 };
  }

  // Step 1 — the ONE guarded transaction. If this throws, the snapshot key is
  // deliberately left in place for the redelivery (step 2 never runs).
  const outcome: TxOutcome = await workerDb.transaction(async (tx) => {
    const guard = await tx.execute(guardInsertSql(guardKeyValue));
    if (guard.rows.length === 0) {
      return { applied: false, skip: "guard-preexists", pingsInserted: 0 } as TxOutcome;
    }

    const monitor = await tx.execute(sql`SELECT 1 FROM monitors WHERE id = ${monitorId}`);
    if (monitor.rows.length === 0) {
      return { applied: false, skip: "monitor-missing", pingsInserted: 0 } as TxOutcome;
    }

    await tx.execute(pingsBulkInsertSql(monitorId, snapshot.rows));
    await tx.execute(
      monitorFlushUpdateSql(
        monitorId,
        snapshot.dTotal,
        snapshot.dFailed,
        snapshot.lastTsMs,
        snapshot.lastRtMs
      )
    );
    return { applied: true, skip: null, pingsInserted: snapshot.rows.length } as TxOutcome;
  });

  // Step 2 — post-commit cleanup, STRICTLY after COMMIT (also reached on
  // every skip path above; never reached when the transaction threw).
  await client.del(snapKey);

  return { applied: outcome.applied, skipped: outcome.skip, pingsInserted: outcome.pingsInserted };
}

/**
 * Sweeps every live staging key (SCAN-based iteration — a keyspace-wide KEYS
 * command is O(N) blocking and forbidden on the shared Redis) and flushes
 * each staged monitor with a deterministic batchId derived from ONE
 * pass-epoch (IN-03): {epochMs-of-flush-pass}:{monitorId}. Malformed
 * stage:* keys are skipped untouched. This is the driver the 04-06 scheduler
 * wiring calls on the flush cadence.
 */
export async function flushDueMonitors(): Promise<DueFlushOutcome[]> {
  const client = stagingRedis();
  const passEpochMs = Date.now();

  const monitorIds = new Set<number>();
  let cursor = "0";
  do {
    const [next, keys] = await client.scan(
      cursor,
      "MATCH",
      `${STAGE_KEY_PREFIX}*`,
      "COUNT",
      100
    );
    cursor = next;
    for (const key of keys) {
      const id = Number.parseInt(key.slice(STAGE_KEY_PREFIX.length), 10);
      if (Number.isInteger(id) && id > 0) monitorIds.add(id);
    }
  } while (cursor !== "0");

  const outcomes: DueFlushOutcome[] = [];
  for (const monitorId of monitorIds) {
    const batchId = makeBatchId(passEpochMs, monitorId);
    const result = await flushMonitor(monitorId, batchId);
    outcomes.push({ monitorId, batchId, ...result });
  }
  return outcomes;
}
