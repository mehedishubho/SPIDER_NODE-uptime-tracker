import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import type Redis from "ioredis";
import {
  EMAIL_BACKOFF_MS,
  emailBackoffDelay,
  emailFailureCount,
  noteEmailFailure,
  QUEUE_NAMES,
  startEmailLaneWorker,
} from "@/worker/queues";
import type { EmailProvider } from "@/lib/email";

// ---------------------------------------------------------------------------
// Email-lane suite (06-02 Task 2) — EML-02/EML-03, D-09/D-10/D-34, WR-02.
//
//   1. Backoff table (Pitfall 2): the D-09 schedule is a ×4-shaped table
//      [30s, 2m, 8m, 30m, 2h] — NOT BullMQ's built-in exponential (which
//      yields 30s/1m/2m/4m/8m and fails the hour-or-two-outage reach). The
//      exact per-attempt values are pinned, not just monotonic growth.
//   2. Worker wiring: startEmailLaneWorker constructs its Worker with
//      settings.backoffStrategy = the pinned table function, concurrency 1,
//      and the lane family's stalled config.
//   3. Typed error split (EML-03, A1 conservative): only the obvious
//      permanents (EAUTH/EENVELOPE/EMESSAGE/5xx) dead-letter via
//      UnrecoverableError + failure counter + error log; everything else
//      rethrows for retry.
//   4. Teardown (WR-02): drainAndTeardown disposes the relay Redis singleton
//      alongside the main client.
//
// The Worker construction seam: bullmq's Worker is stubbed (ctor capture —
// no real blocking connection needed to prove the OPTIONS wiring); the
// processor tests use fake providers (no real SMTP). The created
// workerConnection() client from the captured options is quit per case.
// ---------------------------------------------------------------------------

const workerCtor = vi.hoisted(() => ({
  names: [] as string[],
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  // Stub (not subclass): the wiring test asserts the CONSTRUCTOR OPTIONS —
  // running a real Worker is the resilience suites' job, not this one's.
  class WorkerStub {
    constructor(name: string, _processor: unknown, options?: Record<string, unknown>) {
      workerCtor.names.push(name);
      workerCtor.options.push(options ?? {});
    }
    on() {}
    close() {
      return Promise.resolve();
    }
  }
  return { ...actual, Worker: WorkerStub as unknown as typeof actual.Worker };
});

/** A payload-carrying email lane job. */
function emailJob(data: unknown, name = "send") {
  return { id: `job-${Math.random().toString(36).slice(2)}`, name, data };
}

/** A provider that behaves as instructed (never dials SMTP). */
function fakeProvider(send: () => Promise<void>): EmailProvider {
  return { name: "fake", send };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("email lane — exact D-09 backoff table (Pitfall 2)", () => {
  it("EMAIL_BACKOFF_MS pins the five D-09 values: 30s / 2m / 8m / 30m / 2h", () => {
    expect(EMAIL_BACKOFF_MS).toEqual([30_000, 120_000, 480_000, 1_800_000, 7_200_000]);
  });

  it("emailBackoffDelay returns the exact per-attempt values, the last value beyond — NOT the 2^(n-1) progression", () => {
    expect([1, 2, 3, 4, 5].map((n) => emailBackoffDelay(n))).toEqual([
      30_000, 120_000, 480_000, 1_800_000, 7_200_000,
    ]);
    // Beyond the table: the LAST value repeats (2h ceiling).
    expect(emailBackoffDelay(6)).toBe(7_200_000);
    expect(emailBackoffDelay(50)).toBe(7_200_000);
    // The built-in exponential (2^(n-1) * 30s) would give 30s/60s/120s/240s/480s
    // — explicitly NOT this table (the Pitfall 2 warning sign).
    expect([1, 2, 3, 4, 5].map((n) => emailBackoffDelay(n))).not.toEqual(
      [1, 2, 3, 4, 5].map((n) => 30_000 * 2 ** (n - 1))
    );
  });

  it("startEmailLaneWorker wires settings.backoffStrategy + the lane family's config on the Worker", async () => {
    const handle = startEmailLaneWorker(async () => {});

    try {
      expect(workerCtor.names.at(-1)).toBe(QUEUE_NAMES.email);
      const options = workerCtor.options.at(-1)!;
      expect(options.concurrency).toBe(1);
      expect(options.lockDuration).toBe(30_000);
      expect(options.stalledInterval).toBe(30_000);
      expect(options.maxStalledCount).toBe(1);
      expect(options.connection).toBeDefined();

      const settings = options.settings as { backoffStrategy?: (n: number) => number };
      // The exact pinned table function is the Worker's strategy.
      expect(settings.backoffStrategy).toBe(emailBackoffDelay);
      expect([1, 2, 3, 4, 5, 6].map((n) => settings.backoffStrategy!(n))).toEqual([
        30_000, 120_000, 480_000, 1_800_000, 7_200_000, 7_200_000,
      ]);
    } finally {
      await handle.close();
      // workerConnection() created one real client for the options object —
      // quit it so the fork does not dangle.
      const options = workerCtor.options.at(-1)!;
      await (options.connection as unknown as Redis).quit().catch(() => {});
    }
  });
});

describe("processEmailJob — typed permanent/transient split (EML-03, A1)", () => {
  it("happy path: dispatches the job's {to, subject, html} to the provider", async () => {
    const { processEmailJob } = await import("@/worker/email");
    const send = vi.fn(async () => {});
    const logger = fakeLogger();

    const result = await processEmailJob(
      emailJob({ to: "user@lane.test", subject: "s", html: "<b>h</b>" }),
      { provider: fakeProvider(send), logger }
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ to: "user@lane.test", subject: "s", html: "<b>h</b>" });
    expect(result).toEqual({ to: "user@lane.test", sent: true });
  });

  it.each(["EAUTH", "EENVELOPE", "EMESSAGE"])(
    "permanent code %s -> UnrecoverableError, failure counter +1, error-level log (D-10/D-34)",
    async (code) => {
      const { processEmailJob } = await import("@/worker/email");
      const before = emailFailureCount(QUEUE_NAMES.email);
      const logger = fakeLogger();
      const send = vi.fn(async () => {
        throw Object.assign(new Error("SMTP failure"), { code });
      });

      await expect(
        processEmailJob(emailJob({ to: "user@lane.test", subject: "s", html: "h" }), {
          provider: fakeProvider(send),
          logger,
        })
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(emailFailureCount(QUEUE_NAMES.email)).toBe(before + 1);
      expect(logger.error).toHaveBeenCalledTimes(1);
    }
  );

  it("responseCode >= 500 (5xx) -> UnrecoverableError + counter (permanent)", async () => {
    const { processEmailJob } = await import("@/worker/email");
    const before = emailFailureCount(QUEUE_NAMES.email);
    const send = vi.fn(async () => {
      throw Object.assign(new Error("SMTP server error"), { responseCode: 550 });
    });

    await expect(
      processEmailJob(emailJob({ to: "user@lane.test", subject: "s", html: "h" }), {
        provider: fakeProvider(send),
      })
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(emailFailureCount(QUEUE_NAMES.email)).toBe(before + 1);
  });

  it.each(["ETIMEOUT", "ECONNECTION", "ESOCKET"])(
    "transient code %s -> the ORIGINAL error rethrows (retry per D-09), counter unchanged",
    async (code) => {
      const { processEmailJob } = await import("@/worker/email");
      const before = emailFailureCount(QUEUE_NAMES.email);
      const logger = fakeLogger();
      const original = Object.assign(new Error("transient SMTP failure"), { code });
      const send = vi.fn(async () => {
        throw original;
      });

      const caught = await processEmailJob(
        emailJob({ to: "user@lane.test", subject: "s", html: "h" }),
        { provider: fakeProvider(send), logger }
      ).catch((err: unknown) => err);

      expect(caught).toBe(original);
      expect(caught).not.toBeInstanceOf(UnrecoverableError);
      expect(emailFailureCount(QUEUE_NAMES.email)).toBe(before);
      expect(logger.error).not.toHaveBeenCalled();
    }
  );

  it("responseCode 421 (4xx) -> transient rethrow, NOT UnrecoverableError", async () => {
    const { processEmailJob } = await import("@/worker/email");
    const original = Object.assign(new Error("service unavailable"), { responseCode: 421 });
    const send = vi.fn(async () => {
      throw original;
    });

    const caught = await processEmailJob(
      emailJob({ to: "user@lane.test", subject: "s", html: "h" }),
      { provider: fakeProvider(send) }
    ).catch((err: unknown) => err);

    expect(caught).toBe(original);
    expect(caught).not.toBeInstanceOf(UnrecoverableError);
  });

  it("an error with NO code/responseCode rethrows (A1 conservative default: only the obvious permanents dead-letter)", async () => {
    const { processEmailJob } = await import("@/worker/email");
    const before = emailFailureCount(QUEUE_NAMES.email);
    const original = new Error("mystery socket hiccup");
    const send = vi.fn(async () => {
      throw original;
    });

    const caught = await processEmailJob(
      emailJob({ to: "user@lane.test", subject: "s", html: "h" }),
      { provider: fakeProvider(send) }
    ).catch((err: unknown) => err);

    expect(caught).toBe(original);
    expect(emailFailureCount(QUEUE_NAMES.email)).toBe(before);
  });

  it("malformed payload (missing subject) -> UnrecoverableError + counter (can never succeed on retry)", async () => {
    const { processEmailJob } = await import("@/worker/email");
    const before = emailFailureCount(QUEUE_NAMES.email);
    const send = vi.fn(async () => {});

    await expect(
      processEmailJob(emailJob({ to: "user@lane.test", html: "h" }), {
        provider: fakeProvider(send),
      })
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
    expect(emailFailureCount(QUEUE_NAMES.email)).toBe(before + 1);
  });
});

describe("drainAndTeardown — WR-02 relay Redis disposal", () => {
  it("disposes the relay Redis singleton alongside the main client", async () => {
    const { drainAndTeardown } = await import("@/worker/index");

    // Plant a fake relay singleton (the exact global disposeRelayRedis reads).
    const globalForOutbox = globalThis as unknown as { workerRelayRedis?: unknown };
    const previous = globalForOutbox.workerRelayRedis;
    const relayDisconnect = vi.fn();
    globalForOutbox.workerRelayRedis = { disconnect: relayDisconnect };

    const deps = {
      closeHealth: vi.fn(async () => {}),
      endPool: vi.fn(async () => {}),
      quitRedis: vi.fn(async () => {}),
    };

    try {
      await drainAndTeardown(deps);

      // WR-02: the relay singleton's disposal fired alongside the main quit.
      expect(relayDisconnect).toHaveBeenCalledTimes(1);
      expect(deps.quitRedis).toHaveBeenCalledTimes(1);
      expect(deps.closeHealth).toHaveBeenCalledTimes(1);
      expect(deps.endPool).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) {
        delete globalForOutbox.workerRelayRedis;
      } else {
        globalForOutbox.workerRelayRedis = previous;
      }
    }
  });

  it("noteEmailFailure is the monotonic in-process counter (stalledEvents precedent, D-34)", () => {
    const before = emailFailureCount(QUEUE_NAMES.email);
    noteEmailFailure(QUEUE_NAMES.email);
    noteEmailFailure(QUEUE_NAMES.email);
    expect(emailFailureCount(QUEUE_NAMES.email)).toBe(before + 2);
    // Other lanes read their own zero-based slot.
    expect(emailFailureCount("some-other-lane")).toBe(0);
  });
});
