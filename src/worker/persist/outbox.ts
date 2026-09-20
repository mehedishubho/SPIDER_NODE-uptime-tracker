import { UnrecoverableError } from "bullmq";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type IORedis from "ioredis";
import type pino from "pino";
import { buildLogger } from "../logger";
import { workerConnection } from "../connection";
import { workerDb } from "../db";
import type * as schema from "@/db/schema";

// ---------------------------------------------------------------------------
// Outbox relay (DAT-05/DAT-06, audit §16.3/§16.4 + D-44..D-48) — the alert
// delivery lane. One relay pass claims unsent outbox rows in a batch, renders
// the byte-parity Telegram message per event_type, sends through the
// sanctioned telegram send path (WRAPPED so failures classify), sets the
// incident-keyed dedup key AFTER a confirmed send, and marks the row sent.
//
// BATCH/CADENCE (A3 discretion, documented): batch 50 rows, relay pass every
// 5 s (RELAY_PASS_EVERY_MS — the scheduler id lives in scheduler.ts). 50 rows
// keeps one pass well inside the stalled-checker's 30 s lockDuration at
// ~100-300 ms per Telegram send; 5 s bounds DOWN-alert lag from Tier 1 commit
// to delivery. §16.3's table suggested 100/5 s; 50 halves the worst-case pass
// duration for the same lag bound — the same pinned shape, tuned conservative.
//
// LOCKING (DAT-05, "two concurrent relays never double-send one row"): the
// audit's single-transaction pass holds one FOR UPDATE SKIP LOCKED batch for
// the whole pass because its per-row work is a fast enqueue. THIS relay sends
// synchronously (network I/O per row), so the pass reads a candidate batch
// (plain SELECT riding idx_outbox_unsent) and then claims EACH ROW in its own
// short transaction — `WHERE id = $1 AND sent_at IS NULL ... FOR UPDATE SKIP
// LOCKED` — holding that row's lock across its send + mark, never across the
// whole batch. A concurrent relay's claim of a locked row returns empty and
// moves on: every row is owned by exactly one sender at any instant.
//
// FAILED STATE (D-44, ZERO new migrations — Phase 4 pins zero schema churn):
// the outbox has no status column, so FAILED is a DERIVED state:
//   pending : sent_at IS NULL AND attempts < RELAY_MAX_ATTEMPTS
//             AND NOT (payload ? '_relayFailure')
//   FAILED  : sent_at IS NULL AND (payload ? '_relayFailure'
//             OR attempts >= RELAY_MAX_ATTEMPTS)
// `_relayFailure` is a reserved top-level payload key the relay merges in
// (jsonb ||) on terminal failure: { classification, lastError, failedAt }.
// attempts counts FAILED send attempts only (a clean send sets sent_at without
// incrementing) — so "fail twice then succeed" records attempts=2, three
// transient failures record attempts=3 (D-44's terminal shape), and a
// permanent 400/401/403 fails FAST with attempts < 3. FAILED rows are RETAINED
// forever (never deleted, never auto-retried); D-46's operator re-drive script
// is the only path back.
//
// Typed failure split (D-45): the existing src/lib/telegram.ts sendTelegramAlert
// swallows every failure (false on data.ok===false, undefined on throw), which
// cannot carry the classification. The relay therefore performs the IDENTICAL
// request (URL shape, headers, parse_mode "HTML", disable_notification false —
// copied verbatim from src/lib/telegram.ts, the sanctioned transport) but
// returns a typed outcome carrying the HTTP status + Telegram description.
// isPermanentTelegramFailure then splits: 400/401/403-class (chat not found,
// unauthorized, forbidden/blocked) => UnrecoverableError + row FAILED
// immediately, no retries burned; everything else (429, 5xx, network,
// timeout, missing token) => transient => plain throw => BullMQ backoff.
//
// Dedup (D-47, §16.4 vocabulary from 01-06): alert:{incidentId}:down |
// alert:{incidentId}:recovered | alert:{monitorId}:first_check. TTL is
// D-47's locked 7 days (604800 s) — the §16.4 table's 24 h was superseded by
// D-47 (a relay stall over a weekend must not be able to double-send). The key
// is written SET NX EX only AFTER a confirmed send; every attempt checks
// EXISTS first — if held, the send is skipped and the row still marked sent
// (a re-drive can never double-send).
//
// CR-03 contract: incident.down / incident.recovered rows REQUIRE a non-null
// incident_id. A violating row (and any unknown event_type) is dead-lettered:
// terminal marker + UnrecoverableError — never silently skipped, never a
// minted alert:null:* collision key.
// ---------------------------------------------------------------------------

const log = buildLogger();

/** Relay batch size (A3 discretion — see module header). */
export const RELAY_BATCH_SIZE = 50;

/** Relay pass cadence (A3 discretion — see module header). */
export const RELAY_PASS_EVERY_MS = 5_000;

/** D-47: dedup key TTL — 7 days, symmetric with the DLQ retention pin. */
export const DEDUP_TTL_SECONDS = 604800;

/** D-44: terminal attempt cap — nothing auto-retries past this. */
export const RELAY_MAX_ATTEMPTS = 3;

/** Reserved payload key carrying the terminal-failure metadata (zero-migration FAILED state). */
export const RELAY_FAILURE_KEY = "_relayFailure";

export type RelayFailureClassification = "permanent" | "transient_exhausted" | "contract_violation";

// ---------------------------------------------------------------------------
// Rendering (D-48 byte parity)
// ---------------------------------------------------------------------------

/** The outbox row as the relay consumes it (payload shape written by Tier 1). */
export interface OutboxEvent {
  eventType: string;
  monitorId: number;
  incidentId: string | null;
  payload: {
    monitorName: string;
    monitorUrl: string;
    statusCode: number | null;
    responseTimeMs: number;
    errorClass: string | null;
    occurredAt: string;
    userTimezone: string;
    claimEpoch: number;
    [key: string]: unknown;
  };
}

/** The timestamp format pinned by cron-logic (D-48): en-US, user tz, short tz name. */
function formatAlertTime(occurredAt: string, userTimezone: string): string {
  return new Date(occurredAt).toLocaleString("en-US", {
    timeZone: userTimezone || "UTC",
    timeZoneName: "short",
  });
}

/**
 * Renders the alert text for one outbox event — the three cron-logic templates
 * (src/lib/cron-logic.ts lines 104-133) transcribed CHARACTER-FOR-CHARACTER
 * (D-48): identical emoji, labels, spacing, and the
 * statusCode || "No Response / Timeout" fallback in the DOWN form. Message
 * SELECTION moves to event_type; what lands in the user's chat is unchanged.
 * The 🕒 Time value renders the transition instant (payload.occurredAt —
 * captured in the Tier 1 transaction) through the same pinned formatting call
 * cron-logic applied to its render-time now().
 */
/**
 * IN-04/D-16: escape the HTML-significant trio (& < >) before interpolation
 * into a parse_mode HTML body — the D-24 webhook discipline. Characters
 * outside the escape set render byte-identically (D-48 parity preserved).
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderAlertMessage(event: OutboxEvent): string {
  const p = event.payload;
  const time = formatAlertTime(p.occurredAt, p.userTimezone);
  switch (event.eventType) {
    case "monitor.first_check":
      return `
🚀 <b>MONITORING STARTED: Website is Online!</b>

📌 <b>Name:</b> ${escapeHtml(p.monitorName)}
🌐 <b>URL:</b> ${escapeHtml(p.monitorUrl)}
⚡ <b>Response Time:</b> ${p.responseTimeMs}ms
🕒 <b>Time:</b> ${time}
          `.trim();
    case "incident.down":
      return `
🚨 <b>ALERT: Website Down!</b>

📌 <b>Name:</b> ${escapeHtml(p.monitorName)}
🌐 <b>URL:</b> ${escapeHtml(p.monitorUrl)}
⚠️ <b>Status Code:</b> ${p.statusCode || "No Response / Timeout"}
⏱️ <b>Response Time:</b> ${p.responseTimeMs}ms
🕒 <b>Time:</b> ${time}
          `.trim();
    case "incident.recovered":
      return `
✅ <b>RECOVERY: Website Back Online!</b>

📌 <b>Name:</b> ${escapeHtml(p.monitorName)}
🌐 <b>URL:</b> ${escapeHtml(p.monitorUrl)}
⚡ <b>Response Time:</b> ${p.responseTimeMs}ms
🕒 <b>Time:</b> ${time}
          `.trim();
    default:
      // Loud, never a silent skip — an undeclared event type is a §16.4
      // contract violation the caller dead-letters.
      throw new Error(
        `renderAlertMessage: unknown outbox event_type '${event.eventType}' (§16.4 declares exactly three)`
      );
  }
}

// ---------------------------------------------------------------------------
// Dedup keys (§16.4 vocabulary, D-47 TTL)
// ---------------------------------------------------------------------------

/** The dedup key for one outbox event (01-06 vocabulary, CR-03 non-null rule). */
export function dedupKeyFor(
  event: Pick<OutboxEvent, "eventType" | "monitorId" | "incidentId">
): string {
  switch (event.eventType) {
    case "incident.down":
      return `alert:${event.incidentId}:down`;
    case "incident.recovered":
      return `alert:${event.incidentId}:recovered`;
    case "monitor.first_check":
      return `alert:${event.monitorId}:first_check`;
    default:
      throw new Error(
        `dedupKeyFor: unknown outbox event_type '${event.eventType}' (§16.4 declares exactly three)`
      );
  }
}

// ---------------------------------------------------------------------------
// The wrapped Telegram send path (D-45 typed classification)
// ---------------------------------------------------------------------------

/** The classified result of one Telegram send attempt. */
export interface RelaySendOutcome {
  ok: boolean;
  /** Telegram's HTTP status when the API answered (absent on network-level failure). */
  status?: number;
  /** Telegram's error description when the API rejected the send. */
  description?: string;
}

/** The send seam — injectable so tests mock the boundary (no real egress). */
export type TelegramSendFn = (chatId: string, message: string) => Promise<RelaySendOutcome>;

/**
 * The sanctioned Telegram send path, wrapped for classification: the request
 * is src/lib/telegram.ts sendTelegramAlert verbatim (same URL shape, headers,
 * and body — parse_mode "HTML", disable_notification false), but the outcome
 * is typed so the relay can split permanent from transient failures itself.
 * A network-level failure THROWS (the caller classifies it transient); a
 * missing TELEGRAM_BOT_TOKEN throws too (not in D-45's permanent enumeration
 * — an env fix plus the next pass recovers it, so transient is the honest
 * class).
 */
export const telegramSend: TelegramSendFn = async (chatId, message) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not defined");
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    // WR-04 (D-29): the relay awaits this exchange INSIDE the row's FOR
    // UPDATE transaction, and the worker pool reaps sessions idle in a
    // transaction at 30 s (idle_in_transaction_session_timeout). undici's
    // default headers/body timeout is ~300 s — a black-holed
    // api.telegram.org connection would blow past the cap, kill the session
    // mid-send, and freeze the attempts accounting (every failure
    // transaction rolls back, so a stall repeats forever). Aborting at 10 s
    // keeps the exchange well under the cap; the abort surfaces in the
    // relay's existing transient-failure handling (D-45: timeout is not in
    // the permanent enumeration — env/token issues aside, the next pass
    // retries with attempts advanced).
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_notification: false,
    }),
  });
  const data = (await response.json()) as { ok?: boolean; description?: string };
  return {
    ok: data.ok === true,
    status: response.status,
    description: typeof data.description === "string" ? data.description : undefined,
  };
};

/**
 * D-45 permanent classification: 400 (chat not found), 401 (unauthorized),
 * 403 (forbidden / bot blocked). The HTTP status decides when present; the
 * canonical Telegram description phrases decide when only a description is
 * available (the mock seam's minimal shape).
 */
export function isPermanentTelegramFailure(outcome: RelaySendOutcome): boolean {
  if (outcome.status !== undefined && [400, 401, 403].includes(outcome.status)) {
    return true;
  }
  return /\b(bad request|unauthorized|forbidden)\b/i.test(outcome.description ?? "");
}

// ---------------------------------------------------------------------------
// The relay's Redis client (dedup keys) — module singleton, lazy
// ---------------------------------------------------------------------------

const globalForOutbox = global as unknown as { workerRelayRedis?: IORedis };

/** The relay's Redis client for dedup keys (module singleton, lazy). */
export function relayRedis(): IORedis {
  if (!globalForOutbox.workerRelayRedis) {
    const client = workerConnection();
    client.on("error", (err) => {
      log.error({ err: err.message }, "[worker-outbox] connection error");
    });
    globalForOutbox.workerRelayRedis = client;
  }
  return globalForOutbox.workerRelayRedis;
}

/** Disposes the singleton (vitest resetModules discipline — mirrors tier2). */
export function disposeRelayRedis(): void {
  if (globalForOutbox.workerRelayRedis) {
    globalForOutbox.workerRelayRedis.disconnect();
    delete globalForOutbox.workerRelayRedis;
  }
}

// ---------------------------------------------------------------------------
// The relay pass
// ---------------------------------------------------------------------------

type WorkerDb = NodePgDatabase<typeof schema>;

/** Per-row outcomes a pass reports (the summary the job log captures). */
export type RelayRowOutcome =
  | "sent"
  | "dedup_skipped"
  | "no_chat_skipped"
  | "transient_failed"
  | "permanent_failed"
  | "contract_violation"
  | "not_claimed";

export interface RelayResult {
  candidates: number;
  sent: number;
  dedupSkipped: number;
  noChatSkipped: number;
  transientFailed: number;
  /** Transient failures that reached the attempt cap and are now terminal FAILED. */
  terminalFailed: number;
  permanentFailed: number;
  contractViolations: number;
  notClaimed: number;
  outcomes: Array<{ outboxId: string; outcome: RelayRowOutcome; attempts: number }>;
}

export interface RelayDeps {
  db?: WorkerDb;
  redis?: Pick<IORedis, "exists" | "set">;
  send?: TelegramSendFn;
  batchSize?: number;
  logger?: Pick<pino.Logger, "info" | "warn" | "error">;
}

/** Minimal lane-job shape (BullMQ structural subset — matches LaneProcessor). */
export interface RelayLaneJob {
  id?: string;
  name: string;
  data: unknown;
}

interface CandidateRow {
  id: string;
  event_type: string;
  monitor_id: number;
  incident_id: string | null;
  payload: OutboxEvent["payload"];
  attempts: number;
  chat_id: string | null;
}

/** One row's transaction result (uniform shape for the pass accumulator). */
interface RowTxOutcome {
  outcome: RelayRowOutcome;
  attempts: number;
  terminal: boolean;
}

/** The candidate batch read (plain SELECT riding idx_outbox_unsent). */
function candidatesSql(batchSize: number): ReturnType<typeof sql> {
  return sql`
SELECT o.id, o.event_type, o.monitor_id, o.incident_id, o.payload, o.attempts,
       u."telegramChatId" AS chat_id
  FROM outbox o
  JOIN monitors m ON m.id = o.monitor_id
  LEFT JOIN users u ON u.id = m."userId"
 WHERE o.sent_at IS NULL
   AND o.attempts < ${RELAY_MAX_ATTEMPTS}
   AND NOT (o.payload ? ${RELAY_FAILURE_KEY}::text)
 ORDER BY o.created_at ASC
 LIMIT ${batchSize}
`;
}

/** The per-row claim: re-verifies eligibility UNDER the row lock (Pitfall 4 —
 * the locking clause stays on the SELECT that fetches the row). */
function claimRowSql(outboxId: string): ReturnType<typeof sql> {
  return sql`
SELECT id, event_type, monitor_id, incident_id, payload, attempts
  FROM outbox
 WHERE id = ${outboxId}
   AND sent_at IS NULL
   AND attempts < ${RELAY_MAX_ATTEMPTS}
   AND NOT (payload ? ${RELAY_FAILURE_KEY}::text)
   FOR UPDATE SKIP LOCKED
`;
}

function markSentSql(outboxId: string): ReturnType<typeof sql> {
  return sql`UPDATE outbox SET sent_at = now() WHERE id = ${outboxId}`;
}

function markFailureSql(
  outboxId: string,
  terminal: boolean,
  meta: { classification: RelayFailureClassification; lastError: string }
): ReturnType<typeof sql> {
  const marker = terminal
    ? JSON.stringify({
        [RELAY_FAILURE_KEY]: {
          classification: meta.classification,
          lastError: meta.lastError,
          failedAt: new Date().toISOString(),
        },
      })
    : null;
  return marker === null
    ? sql`UPDATE outbox SET attempts = attempts + 1 WHERE id = ${outboxId}`
    : sql`UPDATE outbox SET attempts = attempts + 1,
             payload = payload || ${marker}::jsonb
           WHERE id = ${outboxId}`;
}

function asEvent(row: { event_type: string; monitor_id: number; incident_id: string | null; payload: OutboxEvent["payload"] }): OutboxEvent {
  return {
    eventType: row.event_type,
    monitorId: row.monitor_id,
    incidentId: row.incident_id,
    payload: row.payload,
  };
}

/**
 * One relay pass (the relay-lane processor): read the candidate batch, then
 * per row claim -> validate (CR-03) -> dedup-check -> render -> send ->
 * classify -> mark, each row inside its own short SKIP LOCKED transaction.
 *
 * Pass-level failure semantics: the pass ALWAYS finishes every row it can
 * (committed per row), then throws once — plain Error when a non-terminal
 * transient failure wants a BullMQ backoff retry, UnrecoverableError when a
 * permanent failure or contract violation was dead-lettered (retrying THIS
 * pass is pointless: the terminal rows are no longer claimable). Terminal
 * FAILED rows emit exactly one error-level pino line (D-44).
 */
export async function processRelayJob(job: RelayLaneJob, deps: RelayDeps = {}): Promise<RelayResult> {
  const db = deps.db ?? workerDb;
  const redis = deps.redis ?? relayRedis();
  const send = deps.send ?? telegramSend;
  const logger = deps.logger ?? log;
  const batchSize = deps.batchSize ?? RELAY_BATCH_SIZE;
  const jobId = job.id ?? "relay-pass";

  const result: RelayResult = {
    candidates: 0,
    sent: 0,
    dedupSkipped: 0,
    noChatSkipped: 0,
    transientFailed: 0,
    terminalFailed: 0,
    permanentFailed: 0,
    contractViolations: 0,
    notClaimed: 0,
    outcomes: [],
  };

  const candidates = (await db.execute(candidatesSql(batchSize))).rows as unknown as CandidateRow[];
  result.candidates = candidates.length;

  for (const candidate of candidates) {
    const rowLog = logger; // bindings below stay ids-only (T-04-28: no URLs/bodies)
    // WR-04 transaction-scope audit (D-29): the ONLY internet-path await
    // inside this FOR UPDATE transaction is the Telegram send — bounded at
    // 10 s by telegramSend's AbortSignal, the one await class that could
    // resolve AFTER the 30 s idle_in_transaction cap and poison the attempts
    // accounting is closed. The remaining awaits cannot stall past the cap
    // unboundedly: the tx.execute statements are local-socket Postgres calls
    // under statement_timeout, and the dedup-key Redis reads target the
    // co-located Redis (connection loss fails fast; a pathological socket
    // black-hole is itself reaped by the 30 s idle cap — session killed,
    // row lock released, BullMQ backoff retries the pass).
    const outcome = await db.transaction(async (tx) => {
      const claimed = (await tx.execute(claimRowSql(candidate.id))).rows as unknown as Array<{
        id: string;
        event_type: string;
        monitor_id: number;
        incident_id: string | null;
        payload: OutboxEvent["payload"];
        attempts: number;
      }>;
      const row = claimed[0];
      if (!row) {
        return { outcome: "not_claimed", attempts: candidate.attempts, terminal: false } satisfies RowTxOutcome;
      }
      const event = asEvent(row);

      // CR-03: down/recovered REQUIRE a non-null incident_id; an unknown
      // event_type is the same class of contract violation. Dead-letter.
      const contractViolation =
        (event.eventType !== "incident.down" &&
          event.eventType !== "incident.recovered" &&
          event.eventType !== "monitor.first_check") ||
        ((event.eventType === "incident.down" || event.eventType === "incident.recovered") &&
          event.incidentId === null);
      if (contractViolation) {
        await tx.execute(
          markFailureSql(row.id, true, {
            classification: "contract_violation",
            lastError: `CR-03 violation: event_type '${event.eventType}' with incident_id ${event.incidentId === null ? "NULL" : "set"}`,
          })
        );
        return { outcome: "contract_violation", attempts: row.attempts + 1, terminal: true } satisfies RowTxOutcome;
      }

      // Dedup check-before-send (§16.4): held key => skip the send, still
      // mark the row sent — a re-drive can never double-send.
      const key = dedupKeyFor(event);
      if ((await redis.exists(key)) === 1) {
        await tx.execute(markSentSql(row.id));
        return { outcome: "dedup_skipped", attempts: row.attempts, terminal: false } satisfies RowTxOutcome;
      }

      // Cron parity: no telegramChatId on the owner => no alert is possible
      // for this transition (cron-logic sends nothing). Handle and mark sent.
      if (!candidate.chat_id) {
        await tx.execute(markSentSql(row.id));
        rowLog.info(
          { outboxId: row.id, monitorId: row.monitor_id, jobId },
          "relay: owner has no telegramChatId — alert skipped, row marked sent (cron parity)"
        );
        return { outcome: "no_chat_skipped", attempts: row.attempts, terminal: false } satisfies RowTxOutcome;
      }

      let message: string;
      try {
        message = renderAlertMessage(event);
      } catch (err) {
        // renderAlertMessage only throws on unknown event types, which the
        // contract check above already caught — unreachable in practice.
        await tx.execute(
          markFailureSql(row.id, true, {
            classification: "contract_violation",
            lastError: err instanceof Error ? err.message : String(err),
          })
        );
        return { outcome: "contract_violation", attempts: row.attempts + 1, terminal: true } satisfies RowTxOutcome;
      }

      let sendOutcome: RelaySendOutcome;
      try {
        sendOutcome = await send(candidate.chat_id, message);
      } catch (err) {
        // Network/timeout/token-missing => transient (D-45).
        const lastError = err instanceof Error ? err.message : String(err);
        const attemptsAfter = row.attempts + 1;
        const terminal = attemptsAfter >= RELAY_MAX_ATTEMPTS;
        await tx.execute(markFailureSql(row.id, terminal, { classification: "transient_exhausted", lastError }));
        if (terminal) {
          rowLog.error(
            { outboxId: row.id, monitorId: row.monitor_id, jobId, attempts: attemptsAfter, lastError },
            "relay: outbox row FAILED after exhausting attempts (D-44 — retained, operator re-drive only)"
          );
        } else {
          rowLog.warn(
            { outboxId: row.id, monitorId: row.monitor_id, jobId, attempts: attemptsAfter, lastError },
            "relay: transient send failure — BullMQ backoff will retry"
          );
        }
        return { outcome: "transient_failed", attempts: attemptsAfter, terminal } satisfies RowTxOutcome;
      }

      if (!sendOutcome.ok) {
        const lastError = sendOutcome.description ?? `telegram rejected the send (status ${sendOutcome.status ?? "unknown"})`;
        if (isPermanentTelegramFailure(sendOutcome)) {
          await tx.execute(markFailureSql(row.id, true, { classification: "permanent", lastError }));
          rowLog.error(
            { outboxId: row.id, monitorId: row.monitor_id, jobId, lastError },
            "relay: PERMANENT telegram failure — row FAILED immediately, no retries burned (D-45)"
          );
          return { outcome: "permanent_failed", attempts: row.attempts + 1, terminal: true } satisfies RowTxOutcome;
        }
        const attemptsAfter = row.attempts + 1;
        const terminal = attemptsAfter >= RELAY_MAX_ATTEMPTS;
        await tx.execute(markFailureSql(row.id, terminal, { classification: "transient_exhausted", lastError }));
        if (terminal) {
          rowLog.error(
            { outboxId: row.id, monitorId: row.monitor_id, jobId, attempts: attemptsAfter, lastError },
            "relay: outbox row FAILED after exhausting attempts (D-44 — retained, operator re-drive only)"
          );
        } else {
          rowLog.warn(
            { outboxId: row.id, monitorId: row.monitor_id, jobId, attempts: attemptsAfter, lastError },
            "relay: transient send failure — BullMQ backoff will retry"
          );
        }
        return { outcome: "transient_failed", attempts: attemptsAfter, terminal } satisfies RowTxOutcome;
      }

      // Confirmed send: dedup key FIRST (SET NX EX, D-47), then mark sent —
      // a crash between the two leaves the key held, so the re-drive path
      // skips the resend while still marking the row.
      await redis.set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
      await tx.execute(markSentSql(row.id));
      return { outcome: "sent", attempts: row.attempts, terminal: false } satisfies RowTxOutcome;
    });

    result.outcomes.push({ outboxId: candidate.id, outcome: outcome.outcome, attempts: outcome.attempts });
    switch (outcome.outcome) {
      case "sent": result.sent += 1; break;
      case "dedup_skipped": result.dedupSkipped += 1; break;
      case "no_chat_skipped": result.noChatSkipped += 1; break;
      case "not_claimed": result.notClaimed += 1; break;
      case "contract_violation": result.contractViolations += 1; break;
      case "permanent_failed": result.permanentFailed += 1; break;
      case "transient_failed":
        result.transientFailed += 1;
        if (outcome.terminal) result.terminalFailed += 1;
        break;
    }
  }

  logger.info(
    {
      jobId,
      candidates: result.candidates,
      sent: result.sent,
      dedupSkipped: result.dedupSkipped,
      noChatSkipped: result.noChatSkipped,
      transientFailed: result.transientFailed,
      terminalFailed: result.terminalFailed,
      permanentFailed: result.permanentFailed,
      contractViolations: result.contractViolations,
      notClaimed: result.notClaimed,
    },
    "relay pass complete"
  );

  // Pass-level throws AFTER every row is handled (see module header).
  if (result.permanentFailed > 0 || result.contractViolations > 0) {
    throw new UnrecoverableError(
      `relay pass: ${result.permanentFailed} permanent failure(s), ${result.contractViolations} contract violation(s) dead-lettered (D-44/D-45/CR-03)`
    );
  }
  const retryableTransients = result.transientFailed - result.terminalFailed;
  if (retryableTransients > 0) {
    throw new Error(
      `relay pass: ${retryableTransients} transient send failure(s) — BullMQ backoff will retry`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Outbox gauges (OBS-01 — D-24/D-25 / D-44, the /metrics.json outbox section)
// ---------------------------------------------------------------------------

export interface OutboxLatencyGauge {
  /** How many recently-sent rows the distribution covers (bounded at 100). */
  sample: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface OutboxMetricsSnapshot {
  /** Pending rows the relay will still pick up (sent_at NULL, not terminal). */
  unsent: number;
  /** Terminally FAILED rows (D-44 gauge — retained, awaiting operator re-drive). */
  failed: number;
  /** Transition-to-alert latency: sent_at - created_at deltas (D-25). */
  latency: OutboxLatencyGauge;
  /**
   * OBS-03 (05-01, Pitfall 7): age in seconds of the OLDEST unsent
   * non-FAILED row — the outbox-health dead-man threshold's input (05-02)
   * and the Prometheus gauge's (05-03). null when nothing is unsent (the
   * queue gauge's oldestWaitingJobAgeMs convention); -1 on query failure
   * (visible, never fatal — the degradation pattern below). created_at is
   * timestamptz, so now() - created_at is clock-safe under the WR-05 UTC
   * pool pin.
   */
  oldestUnsentSeconds: number | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

/**
 * Collects the outbox gauges from ONE counts query plus TWO bounded samples:
 * the latency distribution (the 100 most recently sent rows' created_at ->
 * sent_at deltas, D-25) and the oldest-unsent age (OBS-03's single-row
 * sibling read). Failures map to -1 depths (visible, never fatal to the
 * health endpoint).
 */
export async function collectOutboxMetrics(db: WorkerDb = workerDb): Promise<OutboxMetricsSnapshot> {
  try {
    const counts = (
      await db.execute(sql`
SELECT count(*) FILTER (
          WHERE sent_at IS NULL
            AND attempts < ${RELAY_MAX_ATTEMPTS}
            AND NOT (payload ? ${RELAY_FAILURE_KEY}::text))::int AS unsent,
       count(*) FILTER (
          WHERE sent_at IS NULL
            AND ((payload ? ${RELAY_FAILURE_KEY}::text) OR attempts >= ${RELAY_MAX_ATTEMPTS}))::int AS failed
  FROM outbox`)
    ).rows as unknown as Array<{ unsent: number; failed: number }>;

    const latencyRows = (
      await db.execute(sql`
SELECT (EXTRACT(EPOCH FROM (sent_at - created_at)) * 1000.0)::double precision AS ms
  FROM outbox
 WHERE sent_at IS NOT NULL
 ORDER BY sent_at DESC
 LIMIT 100`)
    ).rows as unknown as Array<{ ms: number }>;
    const sorted = latencyRows.map((r) => r.ms).sort((a, b) => a - b);

    // OBS-03 (Pitfall 7): a bounded sibling read over the SAME unsent
    // non-FAILED set the counts query defines — one row, riding the same
    // pattern as the latency sample above.
    const oldestRows = (
      await db.execute(sql`
SELECT EXTRACT(EPOCH FROM (now() - created_at))::double precision AS oldest_s
  FROM outbox
 WHERE sent_at IS NULL
   AND attempts < ${RELAY_MAX_ATTEMPTS}
   AND NOT (payload ? ${RELAY_FAILURE_KEY}::text)
 ORDER BY created_at ASC
 LIMIT 1`)
    ).rows as unknown as Array<{ oldest_s: number | null }>;

    return {
      unsent: counts[0]?.unsent ?? 0,
      failed: counts[0]?.failed ?? 0,
      latency: {
        sample: sorted.length,
        avgMs: sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted.length > 0 ? Math.round(sorted[sorted.length - 1]) : null,
      },
      oldestUnsentSeconds: oldestRows.length > 0 && oldestRows[0].oldest_s !== null ? oldestRows[0].oldest_s : null,
    };
  } catch {
    return {
      unsent: -1,
      failed: -1,
      latency: { sample: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
      oldestUnsentSeconds: -1,
    };
  }
}
