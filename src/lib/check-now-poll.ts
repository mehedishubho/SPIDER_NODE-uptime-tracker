// ---------------------------------------------------------------------------
// Client-side completion poll for the manual check (API-01 client leg,
// D-01..D-04): after the 202 enqueue, poll the EXISTING monitor read until
// the row's lastChecked advances past the enqueue timestamp.
//
//   - D-01: polls monitor DATA, never BullMQ job state — the web stays a pure
//     Postgres reader; completion = lastChecked > queuedAt (manual checks
//     persist synchronously via Tier 1, so completion is seconds).
//   - D-02: 2s cadence, 30s give-up.
//   - D-04: give-up resolves null (the quiet-handoff basis) — never rejects,
//     never re-enqueues.
//   - Timer discipline (UI-SPEC): the loop stops on completion, give-up, or
//     abort — it may never outlive the component that started it.
//   - 07-10 (G-07-63/CR-01): the completion comparison normalizes the polled
//     value through the shared iso() seam BEFORE comparing instants — a raw
//     naive Postgres text (space separator, no designator) parses as LOCAL
//     time per ECMAScript, which either never completes (UTC+ browsers) or
//     false-completes on stale values (UTC−). iso() is an isomorphic pure
//     helper, so the client bundle gains nothing but that function.
// ---------------------------------------------------------------------------

import { iso } from "@/lib/serialize";

/** The minimum row shape the poll needs (the Dashboard's Monitor satisfies it). */
export interface PolledMonitor {
  id: number;
  lastChecked: string | null;
}

export interface PollMonitorCheckOptions {
  monitorId: number;
  /** The 202 body's enqueue timestamp — completion is lastChecked strictly AFTER it. */
  queuedAt: number;
  /** The existing monitor list read (e.g. the dashboard's fetchMonitors). */
  fetchMonitors: () => Promise<PolledMonitor[]>;
  /** Abort stops the loop (unmount) — resolves null. */
  signal?: AbortSignal;
  /** Poll cadence; default 2000 (D-02). */
  intervalMs?: number;
  /** Give-up deadline; default 30000 (D-02). */
  deadlineMs?: number;
}

/** Sleep that resolves EARLY on abort — no pending timer ever outlives the loop. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollMonitorCheckResult<T extends PolledMonitor = PolledMonitor>(
  opts: PollMonitorCheckOptions
): Promise<T | null> {
  const intervalMs = opts.intervalMs ?? 2000;
  const deadline = Date.now() + (opts.deadlineMs ?? 30000);

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return null;
    await sleep(intervalMs, opts.signal);
    if (opts.signal?.aborted) return null;
    const monitors = await opts.fetchMonitors();
    const monitor = monitors.find((m) => m.id === opts.monitorId) as T | undefined;
    // G-07-63: normalize BEFORE comparing — the polled value may be the raw
    // naive Postgres text, which ECMAScript would read as LOCAL time. Null
    // (never-checked) stays a skip.
    const lastChecked = monitor?.lastChecked ? iso(monitor.lastChecked) : null;
    if (monitor && lastChecked && new Date(lastChecked).getTime() > opts.queuedAt) {
      return monitor;
    }
  }
  return null;
}
