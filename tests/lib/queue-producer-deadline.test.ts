import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueTransactionalEmail } from "@/lib/email/enqueue";

// ---------------------------------------------------------------------------
// Unit suite: src/lib/queue-producer.ts deadline contract + the email door
// wrap (06-06 gap 2, VERIFICATION truth 3 — the SILENT-unreachable mode).
//
// The bounded producer profile (maxRetriesPerRequest 1, 1s connect/command
// timeouts) only rejects FAST when Redis actively refuses; a
// never-connectable endpoint (firewall drop) never settles either way and
// can pin a request handler forever. withProducerDeadline is the backstop:
// every web-side producer await races a 3s deadline and rejects with
// ProducerDeadlineError, which the routes' existing catches map to the
// fixed 503 (D-29 loud degradation; deferred-items item 3 recorded the
// 2-3s candidate).
//
// Bindings load through a presence-asserting helper so the suite fails on
// ASSERTIONS while the export is absent (a missing export is a behavioral
// fact of the RED phase, not a load crash to be mistaken for a fixture bug).
// ---------------------------------------------------------------------------

interface DeadlineContract {
  PRODUCER_DEADLINE_MS: number;
  ProducerDeadlineError: new (ms: number) => Error;
  withProducerDeadline: <T>(promise: Promise<T>, ms?: number) => Promise<T>;
}

async function loadDeadlineContract(): Promise<DeadlineContract> {
  const mod = (await import("@/lib/queue-producer")) as unknown as Record<string, unknown>;
  expect(typeof mod.withProducerDeadline).toBe("function");
  expect(typeof mod.ProducerDeadlineError).toBe("function");
  // 3s sits above the 1s connect + 1s command budget so the fast-rejection
  // path stays primary — the deadline is the silent-mode backstop only.
  expect(mod.PRODUCER_DEADLINE_MS).toBe(3000);
  return mod as unknown as DeadlineContract;
}

describe("withProducerDeadline — pass-through (bounded-profile fast settles ride the race untouched)", () => {
  it("passes a resolving promise's value through unchanged", async () => {
    const { withProducerDeadline } = await loadDeadlineContract();

    await expect(withProducerDeadline(Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("passes a rejecting promise's ORIGINAL error through unchanged (no wrapping, deadline never fires)", async () => {
    const { withProducerDeadline } = await loadDeadlineContract();
    const original = new Error("fast refusal");

    await expect(withProducerDeadline(Promise.reject(original))).rejects.toBe(original);
  });
});

describe("withProducerDeadline — hang mode (never-settling producer await)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a never-settling promise rejects with ProducerDeadlineError at PRODUCER_DEADLINE_MS — name pinned, timer cleared", async () => {
    const { withProducerDeadline, PRODUCER_DEADLINE_MS, ProducerDeadlineError } =
      await loadDeadlineContract();

    let caught: unknown;
    const pending = withProducerDeadline(new Promise<never>(() => {})).catch((err: unknown) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(PRODUCER_DEADLINE_MS);
    await pending;

    expect(caught).toBeInstanceOf(ProducerDeadlineError);
    expect((caught as Error).name).toBe("ProducerDeadlineError");
    // The message names the ms bound — operators see the deadline, not silence.
    expect((caught as Error).message).toContain(String(PRODUCER_DEADLINE_MS));
    // Timer hygiene (check-now-poll precedent): the losing deadline timer is
    // cleared — no live timer survives the settled race.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a custom ms argument is honored — no rejection before it, rejection at it", async () => {
    const { withProducerDeadline, ProducerDeadlineError } = await loadDeadlineContract();

    let caught: unknown;
    const pending = withProducerDeadline(new Promise<never>(() => {}), 10_000).catch(
      (err: unknown) => {
        caught = err;
      },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(caught).toBeUndefined(); // custom bound not yet reached — still hanging

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(caught).toBeInstanceOf(ProducerDeadlineError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("enqueueTransactionalEmail — the email door is deadline-bounded (Better Auth hook path, T-06-07)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a never-settling add() rejects by the deadline under fake timers (register/forgot hooks bounded through the door)", async () => {
    const { PRODUCER_DEADLINE_MS, ProducerDeadlineError } = await loadDeadlineContract();
    const add = vi.fn(() => new Promise<never>(() => {}));

    let caught: unknown;
    const tracked = enqueueTransactionalEmail(
      { to: "x@y.test", subject: "s", html: "h" },
      { emailQueue: { add } },
    ).catch((err: unknown) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(PRODUCER_DEADLINE_MS);
    await tracked;

    expect(add).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(ProducerDeadlineError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
