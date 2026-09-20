import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type IORedis from "ioredis";
import type pino from "pino";
import { buildLogger } from "./logger";
import { workerConnection } from "./connection";
import { workerDb } from "./db";
import type * as schema from "@/db/schema";

// ---------------------------------------------------------------------------
// Maintenance lane (WRK-13 / DAT-08 / D-37, audit §16 maintenance job + §13
// retention rules) — the operator's audit-and-purge lane.
//
// DRY-RUN FIRST (default true — the job payload carries dryRun, and an absent
// flag STILL means dry-run: the safe default is the one that writes nothing).
// Dry-run produces the full report with ZERO writes:
//   - per-monitor counts of pings older than PING_RETENTION_DAYS (30,
//     cleanup-logic parity — the legacy cron deletes pings older than 30 days)
//   - the count of RESOLVED incidents with resolvedAt older than
//     INCIDENT_RETENTION_DAYS (90, cleanup-logic parity — ONGOING incidents
//     are NEVER eligible; T-04-27: the retention run cannot delete live data)
//   - the D-37 uptime_percent consistency audit: stored vs counters-derived,
//     recomputed with the writers' OWN D-36 exact-extraction expression in
//     ABSOLUTE form (over current totalChecks/failedChecks, not the in-UPDATE
//     increments). During the Phase-5 overlap window the legacy cron writes
//     raw toFixed-style floats while Tier 1/Tier 2 write this expression —
//     every row where they disagree surfaces HERE, which is the audit's
//     entire purpose.
//   - BullMQ/Redis key-size observations (Pitfall 6: keepJobs eviction is
//     lazy — space reclaims only when another job finishes, so the operator
//     watches bull:* key sizes and counts) plus the write_guards rows older
//     than WRITE_GUARD_RETENTION_DAYS (7) — observation only, zero writes.
//
// REAL RUN (dryRun false): looped DELETE batches of at most RETENTION_BATCH
// (5000) rows per statement — `WHERE id IN (SELECT id ... LIMIT 5000)` until
// the eligible set is empty — inside the maintenance lane ONLY (DAT-08: no
// other lane, no API route, ever deletes in bulk). The pool's 30 s
// statement_timeout (§25.2) is sized above one 5000-row batch pass (01-03).
// The lane's worker runs at concurrency 1 (D-7: deletes never parallelize).
//
// Security (T-04-28): report payloads and log lines carry ids, counts, and
// sizes only — never URLs, alert bodies, or tokens.
// ---------------------------------------------------------------------------

const log = buildLogger();

/** Legacy cleanup-logic parity: pings older than 30 days are deletable. */
export const PING_RETENTION_DAYS = 30;

/** Legacy cleanup-logic parity: RESOLVED incidents older than 90 days are deletable. */
export const INCIDENT_RETENTION_DAYS = 90;

/** DAT-08: max rows per DELETE statement in the real run. */
export const RETENTION_BATCH = 5000;

/** Observation-only horizon for stale write_guards rows (§13; reported, never deleted here). */
export const WRITE_GUARD_RETENTION_DAYS = 7;

/** Redis SCAN page size for the key-size observation. */
const REDIS_SCAN_PAGE = 100;

/** Cap on MEMORY USAGE probes per report (bounded observation, not a census). */
const REDIS_SAMPLE_LIMIT = 50;

type WorkerDb = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// The D-37 uptime_percent consistency audit
// ---------------------------------------------------------------------------

export interface UptimeDiscrepancy {
  monitorId: number;
  stored: number;
  derived: number;
  /** stored - derived (signed; the recomputation is the truth per D-36). */
  delta: number;
}

export interface ConsistencyAuditResult {
  /** Monitors with totalChecks > 0 that were recomputed. */
  checked: number;
  /** Every monitor whose stored uptime_percent disagrees with the derivation. */
  discrepancies: UptimeDiscrepancy[];
}

/**
 * The D-36 exact-extraction expression in ABSOLUTE form — the same
 * power-of-two ::bigint extraction, half-adder, and integer floor division
 * tier1.ts/tier2.ts apply to the POST-update counters, recomputed over the
 * CURRENT totalChecks/failedChecks. D-37: Phase 5 reuses this standalone
 * export during the two-writer overlap window.
 */
function consistencyAuditSql(): SQL {
  return sql`
SELECT id,
       "uptimePercent" AS stored_percent,
       (CASE
          WHEN (
            (
              (("totalChecks" - "failedChecks")::double precision / "totalChecks")
              * 100.0::double precision
            ) >= 1::double precision
          ) THEN floor(
            (
              (
                (
                  (
                    (("totalChecks" - "failedChecks")::double precision / "totalChecks")
                    * 100.0::double precision
                    * 4503599627370496::double precision
                  )::bigint
                )::numeric * 100 + 2251799813685248
              ) / 4503599627370496
            )
          )
          ELSE floor(
            (
              (
                (
                  (
                    (("totalChecks" - "failedChecks")::double precision / "totalChecks")
                    * 100.0::double precision
                    * 1152921504606846976::double precision
                  )::bigint
                )::numeric * 100 + 576460752303423488
              ) / 1152921504606846976
            )
          )
        END)::double precision / 100.0::double precision AS derived_percent
  FROM monitors
 WHERE "totalChecks" > 0
`;
}

/**
 * D-37: recomputes every counting monitor's uptime_percent with the writers'
 * own expression and lists every row that disagrees with the stored value.
 * Read-only — safe to run at any time, on any lane, from the operator console.
 */
export async function runConsistencyAudit(db: WorkerDb = workerDb): Promise<ConsistencyAuditResult> {
  const rows = (await db.execute(consistencyAuditSql())).rows as unknown as Array<{
    id: number;
    stored_percent: number;
    derived_percent: number;
  }>;
  const discrepancies = rows
    .filter((row) => row.stored_percent !== row.derived_percent)
    .map((row) => ({
      monitorId: row.id,
      stored: row.stored_percent,
      derived: row.derived_percent,
      delta: row.stored_percent - row.derived_percent,
    }));
  return { checked: rows.length, discrepancies };
}

// ---------------------------------------------------------------------------
// Retention report (dry-run) + batched deletes (real run)
// ---------------------------------------------------------------------------

/** Per-monitor deletable-ping counts (cleanup-logic parity horizon). */
function deletablePingsSql(): SQL {
  return sql`
SELECT "monitorId" AS monitor_id, count(*)::int AS deletable
  FROM pings
 WHERE "createdAt" < ((now() AT TIME ZONE 'utc') - (${PING_RETENTION_DAYS}::int * interval '1 day'))
 GROUP BY "monitorId"
 ORDER BY "monitorId"
`;
}

/** Deletable RESOLVED-incidents count (ONGOING incidents are never eligible). */
function deletableIncidentsSql(): SQL {
  return sql`
SELECT count(*)::int AS deletable
  FROM incidents
 WHERE status = 'RESOLVED'
   AND "resolvedAt" < ((now() AT TIME ZONE 'utc') - (${INCIDENT_RETENTION_DAYS}::int * interval '1 day'))
`;
}

/** One bounded DELETE batch: the id IN (subselect LIMIT RETENTION_BATCH) form. */
function deletePingsBatchSql(): SQL {
  return sql`
DELETE FROM pings
 WHERE id IN (
   SELECT id FROM pings
    WHERE "createdAt" < ((now() AT TIME ZONE 'utc') - (${PING_RETENTION_DAYS}::int * interval '1 day'))
    ORDER BY id
    LIMIT ${RETENTION_BATCH}
 )
RETURNING id
`;
}

function deleteIncidentsBatchSql(): SQL {
  return sql`
DELETE FROM incidents
 WHERE id IN (
   SELECT id FROM incidents
    WHERE status = 'RESOLVED'
      AND "resolvedAt" < ((now() AT TIME ZONE 'utc') - (${INCIDENT_RETENTION_DAYS}::int * interval '1 day'))
    ORDER BY id
    LIMIT ${RETENTION_BATCH}
 )
RETURNING id
`;
}

/** The maintenance report — the operator job log captures this object. */
export interface MaintenanceReport {
  dryRun: boolean;
  pings: {
    perMonitor: Array<{ monitorId: number; deletable: number }>;
    totalDeletable: number;
    /** Real run only: rows actually deleted. */
    deleted: number;
    /** Real run only: rows deleted per DELETE statement (each ≤ RETENTION_BATCH). */
    batches: number[];
  };
  incidents: {
    deletable: number;
    deleted: number;
    batches: number[];
  };
  /** D-37 audit — carried in BOTH modes (read-only). */
  audit: ConsistencyAuditResult;
  redis: {
    /** bull:* key count at report time (Pitfall 6 lazy-eviction watch). */
    bullKeyCount: number;
    /** Bounded MEMORY USAGE sample of the largest-namespace keys. */
    sampledKeys: Array<{ key: string; memoryBytes: number | null }>;
    /** write_guards rows older than WRITE_GUARD_RETENTION_DAYS (observation only). */
    writeGuardsOverHorizon: number;
    writeGuardHorizonDays: number;
  };
}

// ---------------------------------------------------------------------------
// The maintenance Redis client (key-size observations) — module singleton
// ---------------------------------------------------------------------------

const globalForMaintenance = global as unknown as { workerMaintenanceRedis?: IORedis };

/** The maintenance lane's Redis client (SCAN/MEMORY USAGE observations). */
export function maintenanceRedis(): IORedis {
  if (!globalForMaintenance.workerMaintenanceRedis) {
    const client = workerConnection();
    client.on("error", (err) => {
      log.error({ err: err.message }, "[worker-maintenance] connection error");
    });
    globalForMaintenance.workerMaintenanceRedis = client;
  }
  return globalForMaintenance.workerMaintenanceRedis;
}

/** Disposes the singleton (vitest resetModules discipline). */
export function disposeMaintenanceRedis(): void {
  if (globalForMaintenance.workerMaintenanceRedis) {
    globalForMaintenance.workerMaintenanceRedis.disconnect();
    delete globalForMaintenance.workerMaintenanceRedis;
  }
}

/** Read-only BullMQ/Redis observations; failures degrade to nulls, never throw. */
async function collectRedisObservations(
  // `call` is ioredis's universal command surface — the typings predate the
  // `memory usage` command's dedicated method, so MEMORY USAGE rides call().
  redis: Pick<IORedis, "scan" | "call">,
  logger: Pick<pino.Logger, "warn">
): Promise<MaintenanceReport["redis"]> {
  const base = {
    bullKeyCount: 0,
    sampledKeys: [] as Array<{ key: string; memoryBytes: number | null }>,
    writeGuardsOverHorizon: 0,
    writeGuardHorizonDays: WRITE_GUARD_RETENTION_DAYS,
  };
  try {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", "bull:*", "COUNT", REDIS_SCAN_PAGE);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");

    const sampledKeys: Array<{ key: string; memoryBytes: number | null }> = [];
    for (const key of keys.slice(0, REDIS_SAMPLE_LIMIT)) {
      try {
        const bytes = (await redis.call("memory", "usage", key)) as number | null;
        sampledKeys.push({ key, memoryBytes: bytes });
      } catch {
        sampledKeys.push({ key, memoryBytes: null });
      }
    }
    return { ...base, bullKeyCount: keys.length, sampledKeys };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "maintenance: Redis key observation failed — reported as zeros (fail-open)"
    );
    return base;
  }
}

/** One table's looped batch deletes until the eligible set is empty. */
async function deleteInBatches(
  db: WorkerDb,
  batchSql: () => SQL,
  logger: Pick<pino.Logger, "info" | "error">,
  table: "pings" | "incidents"
): Promise<{ deleted: number; batches: number[] }> {
  const batches: number[] = [];
  let deleted = 0;
  // Bounded by construction: every statement removes RETENTION_BATCH rows or
  // drains the remainder; the loop ends the first time a batch comes back
  // short. A pathological non-shrinking set would still terminate via the
  // short-batch exit below (DELETE ... WHERE id IN returns what it removed).
  for (;;) {
    const rows = (await db.execute(batchSql())).rows as unknown as Array<{ id: string }>;
    batches.push(rows.length);
    deleted += rows.length;
    logger.info({ table, batch: batches.length, rows: rows.length }, "maintenance: retention batch deleted");
    if (rows.length < RETENTION_BATCH) break;
  }
  return { deleted, batches };
}

// ---------------------------------------------------------------------------
// The maintenance processor
// ---------------------------------------------------------------------------

/** Minimal lane-job shape (BullMQ structural subset — matches LaneProcessor). */
export interface MaintenanceLaneJob {
  id?: string;
  name: string;
  data: unknown;
}

export interface MaintenanceDeps {
  db?: WorkerDb;
  redis?: Pick<IORedis, "scan" | "call">;
  logger?: Pick<pino.Logger, "info" | "warn" | "error">;
}

/**
 * The maintenance-lane processor (WRK-13). Job name is "cleanup" (the
 * §14.1 maintenance-cleanup scheduler's name; enqueueMaintenance uses the same
 * — one name, one processor, no dispatch ambiguity). Payload { dryRun }:
 * absent or true => the zero-write report; false => the looped batched
 * deletes. Both modes return the full report object (the job log captures
 * it) and log one structured pino line.
 */
export async function processMaintenanceJob(
  job: MaintenanceLaneJob,
  deps: MaintenanceDeps = {}
): Promise<MaintenanceReport> {
  const db = deps.db ?? workerDb;
  const redis = deps.redis ?? maintenanceRedis();
  const logger = deps.logger ?? log;
  const jobId = job.id ?? "maintenance";

  if (job.name !== "cleanup") {
    // Loud, never a silent skip — an undeclared maintenance job name is a
    // contract violation (same discipline as the dbWrites lane's dispatcher).
    throw new Error(
      `processMaintenanceJob: unknown maintenance job name '${job.name}' (expected 'cleanup')`
    );
  }
  const data = (job.data ?? {}) as { dryRun?: boolean };
  // WRK-13: dry-run is the DEFAULT — only an explicit false ever deletes.
  const dryRun = data.dryRun !== false;

  const pingRows = (await db.execute(deletablePingsSql())).rows as unknown as Array<{
    monitor_id: number;
    deletable: number;
  }>;
  const incidentRows = (await db.execute(deletableIncidentsSql())).rows as unknown as Array<{
    deletable: number;
  }>;
  const audit = await runConsistencyAudit(db);
  const redisObservations = await collectRedisObservations(redis, logger);

  // Stale write_guards observation (§13 reserved-prefix rows; reported, never
  // deleted by this lane — their cleanup belongs to a later, explicitly
  // scoped decision). Fail-open to 0 like the Redis observations.
  let writeGuardsOverHorizon = 0;
  try {
    const guardRows = (await db.execute(sql`
      SELECT count(*)::int AS over_horizon
        FROM write_guards
       WHERE created_at < (now() - (${WRITE_GUARD_RETENTION_DAYS}::int * interval '1 day'))
    `)) as unknown as { rows: Array<{ over_horizon: number }> };
    writeGuardsOverHorizon = guardRows.rows[0]?.over_horizon ?? 0;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "maintenance: write_guards observation failed — reported as 0 (fail-open)"
    );
  }

  const report: MaintenanceReport = {
    dryRun,
    pings: {
      perMonitor: pingRows.map((row) => ({ monitorId: row.monitor_id, deletable: row.deletable })),
      totalDeletable: pingRows.reduce((sum, row) => sum + row.deletable, 0),
      deleted: 0,
      batches: [],
    },
    incidents: {
      deletable: incidentRows[0]?.deletable ?? 0,
      deleted: 0,
      batches: [],
    },
    audit,
    redis: { ...redisObservations, writeGuardsOverHorizon },
  };

  if (dryRun) {
    logger.info(
      {
        jobId,
        dryRun: true,
        deletablePings: report.pings.totalDeletable,
        deletableIncidents: report.incidents.deletable,
        auditDiscrepancies: report.audit.discrepancies.length,
        bullKeyCount: report.redis.bullKeyCount,
        writeGuardsOverHorizon: report.redis.writeGuardsOverHorizon,
      },
      "maintenance DRY-RUN report (zero writes)"
    );
    return report;
  }

  try {
    const pings = await deleteInBatches(db, deletePingsBatchSql, logger, "pings");
    report.pings.deleted = pings.deleted;
    report.pings.batches = pings.batches;
    const incidents = await deleteInBatches(db, deleteIncidentsBatchSql, logger, "incidents");
    report.incidents.deleted = incidents.deleted;
    report.incidents.batches = incidents.batches;
  } catch (err) {
    // D-18 (06-04): a failed REAL pass logs at ERROR level before the
    // rethrow — the throw is what drives BullMQ's attempts/backoff retry,
    // and the log line makes the failure and its partial state (the rows
    // already deleted before the failing statement) visible in the job log.
    // Never a silent failure; no new dead-man — the worker heartbeat covers
    // a dead tick loop (D-18/D-34).
    logger.error(
      {
        jobId,
        dryRun: false,
        deletedPings: report.pings.deleted,
        deletedIncidents: report.incidents.deleted,
        err: err instanceof Error ? err.message : String(err),
      },
      "maintenance REAL run FAILED — partial deletes may have applied; rethrowing for BullMQ retry"
    );
    throw err;
  }

  logger.info(
    {
      jobId,
      dryRun: false,
      deletedPings: report.pings.deleted,
      pingBatches: report.pings.batches.length,
      deletedIncidents: report.incidents.deleted,
      incidentBatches: report.incidents.batches.length,
      auditDiscrepancies: report.audit.discrepancies.length,
    },
    "maintenance REAL run complete (looped batches, each <= RETENTION_BATCH)"
  );
  return report;
}
