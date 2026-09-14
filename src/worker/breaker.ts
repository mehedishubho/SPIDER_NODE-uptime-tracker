import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { isInfraFailure } from "@/lib/ssrf";
import { workerDb } from "./db";
import { buildLogger } from "./logger";

// ---------------------------------------------------------------------------
// Postgres circuit breaker (RES-01 / audit §13.3, D-33 pins, Pattern 6).
//
// An in-process three-state machine counting CONSECUTIVE Postgres
// infra-failures: 5 (BREAKER_THRESHOLD) trip it OPEN for 60 s
// (BREAKER_OPEN_MS); after the window it goes HALF_OPEN and admits ONE
// probe write — INSERT INTO write_guards (key) VALUES ('breaker:probe:{ts}')
// ON CONFLICT DO NOTHING (§13.3's reserved prefix: probe traffic is
// identifiable in logs and can never double-apply real data). Probe success
// closes the breaker; probe failure re-opens it for another window. State
// lives in the worker PROCESS only (01-03): a restart resets to CLOSED —
// safe, because the first infra failure re-arms it within one tick and the
// pause never depends on Redis state surviving a restart.
//
// ENQUEUE-SIDE GATING (Pattern 6 — NOT queue.pause): canEnqueue() is the one
// gate surface. In-flight jobs drain and finish their bounded attempts while
// OPEN; the stalled checker stays out of the loop entirely. A paused queue
// would also block operator smoke enqueues (Pitfall 12's dark-launch trap),
// and BullMQ's Redis-side pause persistence is exactly the semantics this
// design refuses to depend on. This module contains no queue reference and
// no pause call — the gate is consulted by the enqueue helpers in
// queues.ts / engine/check.ts.
//
// CLASSIFICATION (WRK-05, single-sourced): only infra-class failures count.
// Target outcomes (UP, DOWN, timeout, DNS failure, TLS failure, SSRF block)
// are successful jobs that never reach this counter — performCheck returns
// them as data and never throws. isInfraFailure (src/lib/ssrf.ts) is the
// shared classifier; the only extension here is the pg driver's connection/
// timeout error class, whose errno codes (ECONNREFUSED, ETIMEDOUT, ...) the
// HTTP-path classifier rightly treats as TARGET class when a checked website
// refuses the connection. Call-context contract: recordResult(err) is fed
// errors escaping WORKER Postgres paths (monitor loads, Tier 1/2 writes, the
// probe) — by the WRK-05 contract those are either infra or pg-layer
// failures, never target HTTP results.
// ---------------------------------------------------------------------------

/** D-33 pin: consecutive infra failures before the breaker opens. */
export const BREAKER_THRESHOLD = 5;

/** D-33 pin: OPEN duration (ms) — also the probe interval (§13.10). */
export const BREAKER_OPEN_MS = 60_000;

/** Greppable log marker for enqueue refusals while OPEN (RES-01). */
export const BREAKER_GATE_MARKER = "BREAKER_GATE";

/** Thrown by enqueue helpers that must fail loudly while the breaker is OPEN. */
export class BreakerOpenError extends Error {
  constructor(context: string) {
    super(
      `[breaker] OPEN — refusing ${context}: Postgres circuit breaker is open ` +
        `(${BREAKER_THRESHOLD} consecutive infra failures / ${BREAKER_OPEN_MS} ms, RES-01/D-33)`
    );
    this.name = "BreakerOpenError";
  }
}

export type BreakerStateName = "CLOSED" | "OPEN" | "HALF_OPEN";

/** What state()/the health collector sees (D-25-adjacent observability). */
export interface BreakerStatus {
  state: BreakerStateName;
  /** Consecutive infra failures counted in the current CLOSED run. */
  consecutiveFailures: number;
  /** Epoch ms when OPEN began; null whenever the state is CLOSED. */
  openSince: number | null;
}

/**
 * The minimum surface probe() needs — the worker drizzle client satisfies it
 * structurally; tests inject counting/failing fakes without a pool.
 */
export interface ProbeDb {
  execute(query: unknown): Promise<unknown>;
}

const log: Logger = buildLogger();

// --- in-process state (01-03: restart = CLOSED, no Redis involved) ---------

let phase: "CLOSED" | "OPEN" = "CLOSED";
let consecutiveFailures = 0;
let openSince: number | null = null;

/**
 * TEST-ONLY clock seam (the CheckRequest.denylist precedent in ssrf.ts):
 * the state machine is time-driven (60 s windows), and the proof suite
 * drives those transitions deterministically. Production code never touches
 * it — calling setBreakerClock() with no argument restores the real clock.
 */
let clock: () => number = () => Date.now();

export function setBreakerClock(now?: () => number): void {
  clock = now ?? (() => Date.now());
}

/** Test-isolation reset; also the simulated process restart (01-03). */
export function resetBreaker(): void {
  phase = "CLOSED";
  consecutiveFailures = 0;
  openSince = null;
  halfOpenProbe = null;
}

/**
 * The effective state. HALF_OPEN is DERIVED: the internal phase records only
 * CLOSED/OPEN, and an OPEN whose 60 s window has elapsed reads HALF_OPEN —
 * the next operation (canEnqueue) is what actually runs the probe.
 */
export function state(): BreakerStatus {
  const halfOpen = phase === "OPEN" && openSince !== null && clock() - openSince >= BREAKER_OPEN_MS;
  return {
    state: phase === "CLOSED" ? "CLOSED" : halfOpen ? "HALF_OPEN" : "OPEN",
    consecutiveFailures,
    openSince: phase === "OPEN" ? openSince : null,
  };
}

/** CLOSED with the failure counter at zero (probe-success terminal). */
function closeUp(): void {
  phase = "CLOSED";
  consecutiveFailures = 0;
  openSince = null;
}

/**
 * Records one infra failure. The 5th consecutive failure in CLOSED opens the
 * breaker; a failure arriving while the OPEN window has already elapsed
 * (HALF_OPEN — a failed probe or a failed real write) re-opens it for a
 * FRESH 60 s window (§13.9). Failures inside a live window never extend it —
 * the window is pinned from the moment of opening.
 */
export function recordInfraFailure(): void {
  consecutiveFailures += 1;
  if (phase === "CLOSED") {
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      phase = "OPEN";
      openSince = clock();
      log.warn(
        { consecutiveFailures, openSince, threshold: BREAKER_THRESHOLD, openMs: BREAKER_OPEN_MS },
        "Postgres breaker OPEN — enqueue gates refuse until the HALF_OPEN probe recovers (RES-01)"
      );
    }
    return;
  }
  if (openSince !== null && clock() - openSince >= BREAKER_OPEN_MS) {
    const previousSince = openSince;
    openSince = clock();
    log.warn(
      { previousSince, openSince, openMs: BREAKER_OPEN_MS },
      "Postgres breaker re-OPENED — probe-window failure starts a fresh 60 s window (§13.9)"
    );
  }
}

/**
 * Records one successful Postgres operation (§13.3 CLOSED). In CLOSED it
 * resets the consecutive-failure counter; in HALF_OPEN a successful real
 * write is de-facto probe evidence and closes the breaker; within a live
 * OPEN window it is a no-op — recovery is the probe's pinned job.
 */
export function recordSuccess(): void {
  if (phase === "CLOSED") {
    consecutiveFailures = 0;
    return;
  }
  const halfOpen = openSince !== null && clock() - openSince >= BREAKER_OPEN_MS;
  if (halfOpen) {
    closeUp();
    log.info("breaker CLOSED — successful Postgres write in HALF_OPEN (de-facto probe evidence)");
  }
}

// --- classification (WRK-05 single-sourcing) ----------------------------------

const PG_INFRA_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EPIPE",
]);

/**
 * One cause-chain LEVEL's shape test. A server-sent error shape
 * (severity/routine fields — only a real pg error path produces those), ANY
 * socket-errno class from our own Postgres connection, or the driver's
 * termination/timeout phrases. Per the module header's call-context contract
 * this classifier only ever sees errors escaping WORKER Postgres paths — a
 * target website's ECONNREFUSED arrives here never (performCheck returns
 * those as data) — so an errno code is unambiguous infra REGARDLESS of the
 * message form: "connect ECONNREFUSED ...", "read ECONNRESET", and pg's
 * connection-timeout wrapper ("Connection terminated due to connection
 * timeout", code CONNECTION_TIMEOUT — no errno at all, caught by phrase) all
 * count (found by the postgres-down resilience injection, plan 04-08).
 */
function isPgConnectionFailureLevel(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as { code?: unknown; message?: unknown; severity?: unknown; routine?: unknown };
  if (typeof o.severity === "string" || typeof o.routine === "string") return true;
  const code = typeof o.code === "string" ? o.code : "";
  const message = typeof o.message === "string" ? o.message : "";
  if (PG_INFRA_CODES.has(code)) {
    // ENOTFOUND is the ONE code with a target-side twin the WRK-05 pin keeps
    // out (a checked website's NXDOMAIN reaching this catch is a bug, not a
    // Postgres outage — pinned in tests/worker/breaker.test.ts): count it
    // only on OUR connect path, where net.connect reports the DB host as
    // "connect ENOTFOUND <db-host>:<port>". Every other socket errno thrown
    // into a worker-DB catch can only be OUR Postgres connection.
    if (code !== "ENOTFOUND" || /^connect\s/i.test(message)) return true;
  }
  if (/connection terminated|timeout expired|socket hang up/i.test(message)) return true;
  return false;
}

/**
 * The pg driver's connection/timeout error class, detected at ANY depth of
 * the cause chain: drizzle wraps every driver error in a DrizzleQueryError
 * ("Failed query: ...") whose .cause carries the actual pg error, so a
 * top-level-only test sees neither an errno nor a severity field and
 * misclassifies real Postgres outages as target-class — the breaker then
 * never counts them and never opens (found by the postgres-down resilience
 * injection, plan 04-08: the worker logged verdict:"target" against a
 * stopped container for the whole outage window). Bounded 8-deep walk with
 * a seen-set cycle guard, mirroring rootCause in src/lib/ssrf.ts.
 */
function isPgConnectionFailure(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>([current]);
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (isPgConnectionFailureLevel(current)) return true;
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === null || seen.has(cause)) break;
    seen.add(cause);
    current = cause;
  }
  return false;
}

/**
 * Classifies one escaped error with the SINGLE-SOURCED vocabulary: infra
 * (isInfraFailure from src/lib/ssrf.ts, or the pg connection/timeout class)
 * counts toward the breaker; everything else is a target-class outcome and
 * NEVER increments (WRK-05). Returns the verdict for the caller's logging.
 */
export function recordResult(err: unknown): "infra" | "target" {
  if (isInfraFailure(err) || isPgConnectionFailure(err)) {
    recordInfraFailure();
    return "infra";
  }
  return "target";
}

// --- the HALF_OPEN probe (§13.3) ----------------------------------------------

/** Single-flight guard: HALF_OPEN admits ONE probe write, shared by callers. */
let halfOpenProbe: Promise<boolean> | null = null;

/**
 * The probe write: one synthetic write_guards insert, ON CONFLICT DO NOTHING.
 * Never a replay of a failed real write (Phase 1 research resolution) — the
 * reserved breaker:probe:{ts} prefix makes the traffic identifiable and
 * unable to double-apply real data. Success closes; failure re-opens.
 */
export async function probe(db: ProbeDb = workerDb): Promise<boolean> {
  const probeKey = `breaker:probe:${clock()}`;
  try {
    await db.execute(
      sql`INSERT INTO write_guards (key) VALUES (${probeKey}) ON CONFLICT DO NOTHING`
    );
  } catch (err) {
    log.warn(
      { probeKey, err: err instanceof Error ? err.message : String(err) },
      "breaker HALF_OPEN probe FAILED — re-opening for another 60 s window"
    );
    recordInfraFailure(); // in HALF_OPEN this starts a fresh window
    return false;
  }
  log.info({ probeKey }, "breaker HALF_OPEN probe succeeded — CLOSED, enqueue gates reopen");
  closeUp();
  return true;
}

/**
 * THE enqueue-side gate (Pattern 6 — the only gate surface; never
 * queue.pause). CLOSED admits everything; OPEN within its window refuses;
 * HALF_OPEN runs (and shares) the single probe and admits exactly what the
 * probe verdict says.
 */
export async function canEnqueue(db?: ProbeDb): Promise<boolean> {
  const current = state();
  if (current.state === "CLOSED") return true;
  if (current.state === "OPEN") return false;
  if (!halfOpenProbe) {
    halfOpenProbe = probe(db).finally(() => {
      halfOpenProbe = null;
    });
  }
  return halfOpenProbe;
}
