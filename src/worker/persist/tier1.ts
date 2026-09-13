import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { workerDb } from "../db";
import type * as schema from "@/db/schema";

// ---------------------------------------------------------------------------
// Tier 1 — the synchronous transition transaction (DAT-01/04, audit §16.1
// literal + D-35 in-UPDATE uptime derivation).
//
// Every check whose classified result CHANGES monitors.status — DOWN
// transition, RECOVERED, first check — persists here as ONE synchronous
// Postgres transaction: evidence ping INSERT + conditional monitor UPDATE +
// incident INSERT/UPDATE + outbox INSERT. Never batched, never buffered.
//
// Statement order (01-01 pin): the evidence ping INSERT PRECEDES the
// conditional monitor UPDATE — every executed check leaves evidence,
// including duplicate redeliveries, while the transition effects stay gated
// by `WHERE status <> target AND isActive` so a duplicate applies them
// exactly once (DAT-04 idempotency). The audit's IN-04 rule: when the UPDATE
// returns zero rows (another executor already made this transition, OR
// is_active was cleared after the claim), steps incident/outbox are skipped
// and the evidence ping still commits — never branch on WHICH cause fired.
//
// The context read (previous status, identity, user timezone) runs BEFORE
// the ping only because applyTransition is self-contained — the §16.1
// processor derives the event type from its execution-time re-read (§15.1
// step 1); this module owns that read so its callers cannot get it wrong.
// A missing monitor row (deleted while queued) exits with nothing written —
// the §15.1 step-1 no-op — which also protects the pings FK.
//
// Idempotency layers (D-1 defense in depth): the conditional UPDATE is the
// primary gate; incidents_one_ongoing (partial unique on monitorId WHERE
// status='ONGOING') is the physical backstop that keeps the one-ONGOING
// invariant unviolated even under a concurrent double-insert.
//
// uptime_percent (D-35/CR-01): derived IN the same UPDATE. The rounding runs
// on the double's EXACT binary value via a power-of-two integer extraction —
// no round() call anywhere (see the D-36 adjustment below for why round(),
// in every form, was rejected).
//
// D-36 ADJUSTMENT (the parity suite drove this form, per the documented
// cast/round lever — the SQL changed, never the test). The legacy JS computes
// y = ((total - failed) / total) * 100 in IEEE double, then DISPLAYS
// y.toFixed(2), which rounds y's EXACT binary expansion half-up at the
// hundredth. Two SQL forms were tried and both failed the 2667/4000 case
// (y = 66.6749999999999971578..., the closest double BELOW the decimal tie
// 66.675, so JS shows "66.67"):
//   - round((100.0*up/total)::numeric, 2): rounds the exact RATIONAL — 66.675
//     is an exact decimal tie, half-away-from-zero gives 66.68. WRONG.
//   - round((up::float8/total*100.0::float8)::numeric, 2): PG's float8→numeric
//     conversion goes through the SHORTEST ROUND-TRIP decimal ("66.675"),
//     collapsing the sub-tie double exactly onto the tie — 66.68 again.
//     Proven live: ::text and ::numeric both print "66.675" while the exact
//     expansion is 66.6749999999999972.
// The shipped form extracts the double's exact value as an integer instead:
// multiplying a double by a power of two is EXACT (exponent bump only), and an
// integral float8 ≤ 2^63 casts to bigint EXACTLY. y*2^52 is integral for every
// y ≥ 1, y*2^60 for every y ≥ 2^-8 (uptime below 0.005 renders "0.00" with
// error margin to spare, so the sub-2^-8 region is safe); a two-branch CASE
// keeps both products inside bigint range for y ∈ [0, 100]. The round-half-up
// at the hundredth is then pure arbitrary-precision integer arithmetic:
//   n = floor((m*100 + 2^(s-1)) / 2^s)   with m = (y * 2^s)::bigint
// which reproduces toFixed(2)'s "nearest, ties to larger n" for positives
// bit-for-bit, because it sees y's true expansion rather than a decimalized
// approximation. n/100 back to double is the stored value. Sweep proof:
// 73,210 ratios (every .xx5 tie for 2^a*5^b totals up to 200,000 plus 3,000
// random non-terminating ratios) rendered byte-identically to the legacy JS.
//
// DAT-07: NO INSERT statement supplies an id — pings/incidents/outbox ids
// come from the pinned gen_random_uuid() defaults, so an undefined PK can
// never reach the database.
//
// DAT-10: errorClass/statusCode ride the evidence ping from the 04-03
// CheckOutcome vocabulary. Tier1Input mirrors that vocabulary field-for-field
// but is defined LOCALLY — 04-03 owns the SSRF engine module in the same
// wave, and an eager cross-plan type import would break the same-wave
// no-file-overlap assumption; 04-06's processor wiring joins the two
// vocabularies structurally in wave 3.
// ---------------------------------------------------------------------------

/** Outbox event vocabulary (audit §11 / §16.4 — exactly three types). */
export type OutboxEventType = "incident.down" | "incident.recovered" | "monitor.first_check";

/**
 * One classified check result about to persist a transition. Mirrors the
 * CheckOutcome vocabulary (status/responseTimeMs/errorClass/statusCode, DAT-10)
 * plus the claim context the worker carries (monitorId, epoch, interval).
 */
export interface Tier1Input {
  monitorId: number;
  /** The claim-slot epoch of the check:{monitorId}:{epoch} job id (01-02). */
  epoch: number;
  /** The classified target status. 'UP' from 'DOWN' means RECOVERED. */
  targetStatus: "UP" | "DOWN";
  responseTimeMs: number;
  /** CheckOutcome.errorClass — null when the check succeeded. */
  errorClass: string | null;
  /** CheckOutcome.statusCode — null when no HTTP response was received. */
  statusCode: number | null;
  /** Monitor interval in minutes (next_check_at advance). */
  interval: number;
}

/** What applyTransition did — the processor's log/metric surface. */
export interface Tier1Result {
  /** True when the conditional UPDATE flipped the status (this run owns it). */
  applied: boolean;
  /** The outbox event written, null when not applied (or no event derives). */
  eventType: OutboxEventType | null;
  /** The incident the event rides (down: opened/ongoing, recovered: resolved). */
  incidentId: string | null;
}

type WorkerDb = NodePgDatabase<typeof schema>;

/**
 * The §16.1 statement-1 evidence ping — ALWAYS inserted, duplicate deliveries
 * included. id is omitted so the pinned gen_random_uuid() default applies
 * (DAT-07); error_class/status_code carry the DAT-10 metadata.
 */
export function evidencePingSql(input: Tier1Input): SQL {
  return sql`
INSERT INTO pings ("monitorId", status, "responseTime", error_class, status_code, "createdAt")
VALUES (${input.monitorId}, ${input.targetStatus}, ${input.responseTimeMs}, ${input.errorClass}, ${input.statusCode}, now())
`;
}

/**
 * The §16.1 statement-2 conditional transition UPDATE — only the executor
 * that flips the status proceeds. Counters ride this statement via
 * SQL-relative increments, so a duplicate delivery counts the check exactly
 * once (zero rows => skip the incident/outbox steps, IN-04).
 *
 * Beyond the audit text (which predates three 0001 columns), the same UPDATE
 * carries: the D-35 in-UPDATE uptime_percent derivation (the exact-extraction
 * form the D-36 parity suite mandated — module header above), the
 * next_check_at advance (the same on-time form the §14.3 claim applies — this
 * transaction IS the schedule slot's write), and consecutive_failures
 * maintenance (schema-reserved column; UP resets, DOWN increments — the
 * N-strike THRESHOLD semantics stay unused, 1-strike DOWN is the pinned
 * characterization behavior).
 */
export function transitionUpdateSql(input: Tier1Input): SQL {
  const failedInc = input.targetStatus === "DOWN" ? 1 : 0;
  // Power-of-two extraction constants (D-36): 2^52 = 4503599627370496 with
  // half-adder 2^51 = 2251799813685248 covers y >= 1; 2^60 =
  // 1152921504606846976 with half-adder 2^59 = 576460752303423488 covers
  // y < 1 exactly down to 2^-8 and safely below that.
  return sql`
UPDATE monitors
   SET status = ${input.targetStatus},
       "lastChecked" = now(),
       "responseTime" = ${input.responseTimeMs},
       "totalChecks" = "totalChecks" + 1,
       "failedChecks" = "failedChecks" + ${failedInc},
       "uptimePercent" = (
         CASE
           WHEN (
             (
               ("totalChecks" + 1 - ("failedChecks" + ${failedInc}))::double precision
               / ("totalChecks" + 1)
             ) * 100.0::double precision >= 1::double precision
           ) THEN floor(
             (
               (
                 (
                   (
                     ("totalChecks" + 1 - ("failedChecks" + ${failedInc}))::double precision
                     / ("totalChecks" + 1)
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
                     ("totalChecks" + 1 - ("failedChecks" + ${failedInc}))::double precision
                     / ("totalChecks" + 1)
                   ) * 100.0::double precision
                   * 1152921504606846976::double precision
                 )::bigint
               )::numeric * 100 + 576460752303423488
             ) / 1152921504606846976
           )
         END
       )::double precision / 100.0::double precision,
       consecutive_failures = CASE WHEN ${failedInc} = 1
                                  THEN consecutive_failures + 1
                                  ELSE 0 END,
       next_check_at = now() + (${input.interval}::int * interval '1 minute')
 WHERE id = ${input.monitorId}
   AND status <> ${input.targetStatus}
   AND "isActive"
RETURNING id
`;
}

/** Context read: previous status, identity fields, owner timezone, now(). */
function monitorContextSql(monitorId: number): SQL {
  return sql`
SELECT m.status AS prev_status,
       m."isActive" AS is_active,
       m.name AS monitor_name,
       m.url AS monitor_url,
       u.timezone AS user_timezone,
       now() AS occurred_at
FROM monitors m
JOIN users u ON u.id = m."userId"
WHERE m.id = ${monitorId}
`;
}

/** §16.1 statement-3a: open the incident, ON CONFLICT rides the partial unique. */
function incidentOpenSql(monitorId: number, description: string): SQL {
  return sql`
INSERT INTO incidents ("monitorId", status, description, "startedAt")
VALUES (${monitorId}, 'ONGOING', ${description}, now())
ON CONFLICT ("monitorId") WHERE status = 'ONGOING' DO NOTHING
RETURNING id
`;
}

/** §16.1 statement-3b: resolve the existing ONGOING incident instead. */
function incidentResolveSql(monitorId: number): SQL {
  return sql`
UPDATE incidents
   SET status = 'RESOLVED',
       "resolvedAt" = now()
 WHERE "monitorId" = ${monitorId}
   AND status = 'ONGOING'
RETURNING id
`;
}

/** Fallback after a swallowed conflict: read the surviving ONGOING incident. */
function incidentOngoingSelectSql(monitorId: number): SQL {
  return sql`
SELECT id FROM incidents WHERE "monitorId" = ${monitorId} AND status = 'ONGOING' LIMIT 1
`;
}

/** Fallback after a no-op resolve: the monitor's most recent incident row. */
function incidentLatestSelectSql(monitorId: number): SQL {
  return sql`
SELECT id FROM incidents WHERE "monitorId" = ${monitorId} ORDER BY "startedAt" DESC LIMIT 1
`;
}

/**
 * §16.1 statement-4: the outbox INSERT. event_type comes from the §16.4
 * vocabulary — down/recovered carry a non-null incident_id (CR-03; a null
 * there is the dead-letter contract violation), first_check is
 * monitor-scoped with incident_id NULL by design. payload carries exactly
 * what the relay's byte-parity Telegram rendering needs (D-48): monitor
 * identity, status code, timestamps, user timezone. id omitted (DAT-07);
 * created_at defaults to now() at the DB.
 */
function outboxInsertSql(
  eventType: OutboxEventType,
  input: Tier1Input,
  context: { monitorName: string; monitorUrl: string; userTimezone: string; occurredAt: string },
  incidentId: string | null
): SQL {
  const payload = {
    monitorId: input.monitorId,
    monitorName: context.monitorName,
    monitorUrl: context.monitorUrl,
    statusCode: input.statusCode,
    responseTimeMs: input.responseTimeMs,
    errorClass: input.errorClass,
    occurredAt: context.occurredAt,
    userTimezone: context.userTimezone,
    claimEpoch: input.epoch,
  };
  return sql`
INSERT INTO outbox (event_type, monitor_id, incident_id, payload)
VALUES (${eventType}, ${input.monitorId}, ${incidentId}, ${JSON.stringify(payload)}::jsonb)
`;
}

/**
 * Event-type derivation mirroring cron-logic's transition contract exactly:
 * DOWN from any non-DOWN previous state opens the incident (1-strike — the
 * first failure flips UP->DOWN immediately); UP from DOWN is RECOVERED; UP
 * from PENDING is the first check (no incident). UP from any other status
 * (e.g. the never-used 'UNKNOWN' schema default) derives NO event — the
 * legacy path sends nothing there, and behavior compatibility is the
 * milestone's core value.
 */
function deriveEventType(prevStatus: string, targetStatus: "UP" | "DOWN"): OutboxEventType | null {
  if (targetStatus === "DOWN") return "incident.down";
  if (prevStatus === "DOWN") return "incident.recovered";
  if (prevStatus === "PENDING") return "monitor.first_check";
  return null;
}

function validateInput(input: Tier1Input): void {
  if (!Number.isInteger(input.monitorId) || input.monitorId <= 0) {
    throw new Error(`applyTransition: monitorId must be a positive integer (got ${input.monitorId})`);
  }
  if (input.targetStatus !== "UP" && input.targetStatus !== "DOWN") {
    throw new Error(`applyTransition: targetStatus must be 'UP' or 'DOWN' (got ${input.targetStatus})`);
  }
  if (!Number.isInteger(input.responseTimeMs) || input.responseTimeMs < 0) {
    throw new Error(`applyTransition: responseTimeMs must be a non-negative integer (got ${input.responseTimeMs})`);
  }
  if (!Number.isInteger(input.interval) || input.interval <= 0) {
    throw new Error(`applyTransition: interval must be a positive integer (got ${input.interval})`);
  }
}

/**
 * Executes the ONE synchronous Tier 1 transaction (§16.1). Duplicate delivery
 * of the same claimed check records a second evidence ping but touches zero
 * monitor rows the second time — no second ONGOING incident, no duplicate
 * outbox row, counters advanced exactly once.
 */
export async function applyTransition(
  input: Tier1Input,
  db: WorkerDb = workerDb
): Promise<Tier1Result> {
  validateInput(input);

  return db.transaction(async (tx) => {
    // Context read first: a missing monitor row (deleted while queued) exits
    // with nothing written — the §15.1 step-1 no-op, FK-safe.
    const contextRows = (await tx.execute(monitorContextSql(input.monitorId)))
      .rows as Array<{
      prev_status: string;
      is_active: boolean;
      monitor_name: string;
      monitor_url: string;
      user_timezone: string;
      occurred_at: string | Date;
    }>;
    const context = contextRows[0];
    if (!context) {
      return { applied: false, eventType: null, incidentId: null } satisfies Tier1Result;
    }

    // 1. Evidence ping — ALWAYS, before the conditional UPDATE (01-01).
    await tx.execute(evidencePingSql(input));

    // 2. Conditional transition. Zero rows => duplicate delivery or a
    //    deactivated monitor — same skip path either way (IN-04); the
    //    evidence ping above still commits.
    const updated = (await tx.execute(transitionUpdateSql(input))).rows as Array<{ id: number }>;
    if (updated.length === 0) {
      return { applied: false, eventType: null, incidentId: null } satisfies Tier1Result;
    }

    const eventType = deriveEventType(context.prev_status, input.targetStatus);

    // 3. Incident lifecycle (cron-logic parity).
    let incidentId: string | null = null;
    if (input.targetStatus === "DOWN") {
      // Description parity: `Monitor went down. Status code: ${statusCode || "Timeout"}`.
      const description = `Monitor went down. Status code: ${input.statusCode || "Timeout"}`;
      const opened = (await tx.execute(incidentOpenSql(input.monitorId, description)))
        .rows as Array<{ id: string }>;
      incidentId = opened[0]?.id ?? null;
      if (!incidentId) {
        // DO NOTHING swallowed a concurrent insert — use the survivor (§16.1).
        const survivor = (await tx.execute(incidentOngoingSelectSql(input.monitorId)))
          .rows as Array<{ id: string }>;
        incidentId = survivor[0]?.id ?? null;
      }
    } else if (eventType === "incident.recovered") {
      const resolved = (await tx.execute(incidentResolveSql(input.monitorId)))
        .rows as Array<{ id: string }>;
      incidentId = resolved[0]?.id ?? null;
      if (!incidentId) {
        // No ONGOING row left (data drift — e.g. retention purged a very old
        // incident): fall back to the monitor's latest incident so the
        // recovered event still rides a real incident id (CR-03 non-null).
        const latest = (await tx.execute(incidentLatestSelectSql(input.monitorId)))
          .rows as Array<{ id: string }>;
        incidentId = latest[0]?.id ?? null;
      }
    }

    // 4. Outbox event — only when an event type derives AND the CR-03
    //    nullability contract holds (down/recovered REQUIRE a non-null
    //    incident_id; skip rather than mint an alert:null:* collision key).
    if (eventType === null) return { applied: true, eventType: null, incidentId: null } satisfies Tier1Result;
    if (eventType !== "monitor.first_check" && !incidentId) {
      return { applied: true, eventType: null, incidentId: null } satisfies Tier1Result;
    }
    await tx.execute(
      outboxInsertSql(eventType, input, {
        monitorName: context.monitor_name,
        monitorUrl: context.monitor_url,
        userTimezone: context.user_timezone,
        occurredAt:
          context.occurred_at instanceof Date
            ? context.occurred_at.toISOString()
            : new Date(context.occurred_at).toISOString(),
      }, incidentId)
    );

    return { applied: true, eventType, incidentId } satisfies Tier1Result;
  });
}
