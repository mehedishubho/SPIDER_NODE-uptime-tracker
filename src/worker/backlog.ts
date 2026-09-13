import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { workerDb } from "./db";
import { buildLogger } from "./logger";

// ---------------------------------------------------------------------------
// Enqueue-side backlog cap (RES-02 / J-5, audit §14.2 step 4 + §14.5).
//
// Before the tick enqueues a routine (priority-10) check, it reads the check
// queue's depth (getJobCounts wait+delayed+active) and compares it against
// ~2x the active-monitor count. Above the cap the routine enqueue is DROPPED,
// logged with the greppable BACKLOG_DROP marker, and counted — the counter is
// exposed to the health collector (D-25). Claims stay advanced, so a dropped
// check self-heals at the monitor's next due slot: the accepted consequence is
// one missed routine sample for an UP monitor.
//
// The non-UP lane is NEVER gated (01-02): transition writes are synchronous
// inside check jobs (§16.1) and thus never droppable. The gate wraps ONLY the
// routine enqueue path in queues.ts — nothing here pauses the queue.
//
// Fail-open philosophy (rate-limit.ts precedent): a depth-read error resolves
// to "accept" — a broken metrics read must not silently stop routine checks.
// ---------------------------------------------------------------------------

/** Greppable log marker for dropped routine enqueues (RES-02 observability). */
export const BACKLOG_DROP_MARKER = "BACKLOG_DROP";

/** Cap = depth limit above which routine enqueues drop (§14.5 "~2x"). */
export const BACKLOG_CAP_MULTIPLIER = 2;

const backlogLogger = buildLogger();

let backlogDropTotal = 0;

/** Monotonic process-lifetime drop counter — surfaced on /metrics.json (D-25). */
export function backlogDropCount(): number {
  return backlogDropTotal;
}

/** Test-isolation reset only; the production counter is monotonic. */
export function resetBacklogDropCount(): void {
  backlogDropTotal = 0;
}

/**
 * Counts active monitors — the denominator of the backlog cap. One SELECT on
 * the claim's own partial-index predicate (isActive), cheap and exact at this
 * scale; the gate caches the result for its lifetime so a tick reads it once.
 */
export async function countActiveMonitors(): Promise<number> {
  const result = await workerDb.execute(
    sql`SELECT count(*) AS count FROM monitors WHERE "isActive"`
  );
  const rows = result.rows as Array<{ count: string | number }>;
  return Number(rows[0]?.count ?? 0);
}

/** What the gate needs from the checks queue: the depth read (RES-02). */
export interface BacklogCountClient {
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

export interface BacklogGateDeps {
  /** Depth source; required — the gate never resolves the queue itself. */
  checksQueue: BacklogCountClient;
  /** Pre-fetched active-monitor count (the tick passes its per-tick value). */
  activeMonitorCount?: number;
}

export interface BacklogGate {
  /**
   * True when a routine (priority-10) enqueue may proceed. The verdict AND its
   * inputs are cached for the gate's lifetime — one gate per tick means one
   * depth read and one active-monitor count per tick (§14.2 step 4 reads the
   * depth "before enqueuing routine checks", then skips every routine enqueue
   * for that tick). Depth-read failures fail OPEN (accept): a broken metrics
   * read must not silently stop routine checks.
   */
  canAcceptRoutine(): Promise<boolean>;
}

/**
 * Opens a per-tick backlog gate. The scheduler creates one per tick and
 * threads it through every routine enqueue; ad-hoc callers get a fresh gate
 * (single-shot, same semantics).
 */
export function openBacklogGate(deps: BacklogGateDeps): BacklogGate {
  let cachedVerdict: boolean | null = null;
  return {
    async canAcceptRoutine(): Promise<boolean> {
      if (cachedVerdict !== null) return cachedVerdict;
      let depth: number;
      let active: number;
      try {
        const counts = await deps.checksQueue.getJobCounts("wait", "delayed", "active");
        depth = (counts.wait ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
        active = deps.activeMonitorCount ?? (await countActiveMonitors());
      } catch {
        // Fail-open (rate-limit.ts DEGRADED precedent): monitoring must not
        // stop because the depth gauge broke.
        backlogLogger.warn(
          { marker: BACKLOG_DROP_MARKER, phase: "depth-read" },
          "backlog depth read FAILED — failing open (routine enqueue accepted)"
        );
        cachedVerdict = true;
        return cachedVerdict;
      }
      cachedVerdict = depth <= BACKLOG_CAP_MULTIPLIER * active;
      if (!cachedVerdict) {
        backlogLogger.warn(
          { marker: BACKLOG_DROP_MARKER, depth, activeMonitors: active },
          "backlog cap exceeded — routine check enqueues will drop this tick (RES-02)"
        );
      }
      return cachedVerdict;
    },
  };
}

/**
 * Records one dropped routine enqueue: increments the metrics counter and
 * emits the greppable BACKLOG_DROP warn line. `log` is injectable so tests
 * capture the line without spying on stdout.
 */
export function noteBacklogDrop(
  context: { monitorId: number; jobId: string },
  log: Logger = backlogLogger
): void {
  backlogDropTotal += 1;
  log.warn(
    { marker: BACKLOG_DROP_MARKER, monitorId: context.monitorId, jobId: context.jobId },
    "routine check enqueue DROPPED — check-queue depth exceeds ~2x active monitors (RES-02)"
  );
}
