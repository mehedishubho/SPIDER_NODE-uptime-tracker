import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollMonitorCheckResult } from "@/lib/check-now-poll";

// ---------------------------------------------------------------------------
// Contract suite: src/lib/check-now-poll.ts — the client-side completion poll
// (API-01 client leg, D-01..D-04).
//
//   - polls the INJECTED monitor read (never BullMQ job state — D-01)
//   - 2s cadence, 30s give-up (D-02)
//   - completion = new Date(lastChecked).getTime() > queuedAt, STRICTLY
//   - abort stops the loop: no timer, no further read (UI-SPEC timer
//     discipline — the loop may never outlive the component)
//
// Fake timers drive the cadence/deadline/abort cases deterministically.
// ---------------------------------------------------------------------------

type Row = { id: number; lastChecked: string | null };

function rowAt(ms: number): Row {
  return { id: 5, lastChecked: new Date(ms).toISOString() };
}

describe("pollMonitorCheckResult (D-01/D-02 — poll the monitor read, never job state)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits one interval before the first read (no instant fetch), then resolves the fresh row", async () => {
    const queuedAt = Date.now();
    const fetchMonitors = vi.fn().mockResolvedValue([rowAt(queuedAt + 5_000)]);

    const pending = pollMonitorCheckResult<Row>({ monitorId: 5, queuedAt, fetchMonitors });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMonitors).not.toHaveBeenCalled(); // no read before the first cadence tick

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(rowAt(queuedAt + 5_000));
    expect(fetchMonitors).toHaveBeenCalledTimes(1);
    // Completion stops the loop — no live timer survives.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a row with lastChecked EQUAL to queuedAt does NOT complete (strictly greater), polling continues at the 2s cadence", async () => {
    const queuedAt = Date.now();
    const fetchMonitors = vi
      .fn()
      .mockResolvedValueOnce([rowAt(queuedAt - 60_000)]) // stale
      .mockResolvedValueOnce([rowAt(queuedAt)]) // equal — not completion
      .mockResolvedValue([rowAt(queuedAt + 1)]); // fresh

    const pending = pollMonitorCheckResult<Row>({ monitorId: 5, queuedAt, fetchMonitors });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMonitors).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMonitors).toHaveBeenCalledTimes(2); // equal did not complete

    await vi.advanceTimersByTimeAsync(2_000);
    const settled = await pending;
    expect(settled).toEqual(rowAt(queuedAt + 1));
    expect(fetchMonitors).toHaveBeenCalledTimes(3);
  });

  it("a monitor missing from the list keeps polling (deleted mid-flight → give-up, never a crash)", async () => {
    const queuedAt = Date.now();
    const fetchMonitors = vi.fn().mockResolvedValue([{ id: 7, lastChecked: rowAt(queuedAt).lastChecked }]);

    const pending = pollMonitorCheckResult<Row>({ monitorId: 5, queuedAt, fetchMonitors });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchMonitors).toHaveBeenCalledTimes(3); // still polling — rows for OTHER monitors never complete it
    expect(vi.getTimerCount()).toBe(1);
    pending.catch(() => {
      /* silenced: the loop is abandoned by the deadline test's contract; this case only pins cadence */
    });
  });

  it("gives up with null at the 30s deadline — never rejects, never errors (D-04 quiet handoff basis)", async () => {
    const queuedAt = Date.now();
    const fetchMonitors = vi.fn().mockResolvedValue([rowAt(queuedAt - 60_000)]);

    const pending = pollMonitorCheckResult<Row>({ monitorId: 5, queuedAt, fetchMonitors });

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBeNull();
    // Every 2s across the 30s window = 15 reads; then the loop is gone.
    expect(fetchMonitors).toHaveBeenCalledTimes(15);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort stops the loop mid-poll — resolves null, no timer, no further read (timer discipline)", async () => {
    const queuedAt = Date.now();
    const controller = new AbortController();
    const fetchMonitors = vi.fn().mockResolvedValue([rowAt(queuedAt - 60_000)]);

    const pending = pollMonitorCheckResult<Row>({
      monitorId: 5,
      queuedAt,
      fetchMonitors,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMonitors).toHaveBeenCalledTimes(2);

    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMonitors).toHaveBeenCalledTimes(2); // nothing after the abort
  });

  it("a null lastChecked row keeps polling (never completes on a never-checked row)", async () => {
    const queuedAt = Date.now();
    const fetchMonitors = vi.fn().mockResolvedValue([{ id: 5, lastChecked: null }]);

    const pending = pollMonitorCheckResult<Row>({
      monitorId: 5,
      queuedAt,
      fetchMonitors,
      intervalMs: 1_000,
      deadlineMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeNull();
    // Custom 1s cadence over a 5s deadline — also pins the overrides.
    expect(fetchMonitors).toHaveBeenCalledTimes(5);
  });

  it("G-07-63: a legacy naive Postgres lastChecked text (space, no designator) still completes — normalized as UTC", async () => {
    // The driver's raw timestamp(3) form for an instant AFTER queuedAt.
    // Literal UTC derivation (toISOString is UTC-based), TZ-independent to
    // BUILD; the COMPARISON was the timezone-dependent part — on the
    // unhardened poll this value parses as LOCAL time and, on any UTC+
    // machine, lands hours in the past so the monitor never completes (the
    // CR-01 signature this case pins shut).
    const queuedAt = Date.now();
    const naivePostgresText = new Date(queuedAt + 5_000).toISOString().slice(0, 23).replace("T", " ");
    const fetchMonitors = vi.fn().mockResolvedValue([{ id: 5, lastChecked: naivePostgresText }]);

    const pending = pollMonitorCheckResult<Row>({ monitorId: 5, queuedAt, fetchMonitors });

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ id: 5, lastChecked: naivePostgresText });
    // Resolved on the FIRST read, well inside the 30s deadline.
    expect(fetchMonitors).toHaveBeenCalledTimes(1);
  });
});
