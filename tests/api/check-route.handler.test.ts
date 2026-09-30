import { beforeEach, describe, expect, it, vi } from "vitest";
import "./_harness";
import {
  buildRequest,
  dbState,
  h,
  mockSession,
  resetDbMocks,
  routeParams,
  sessionA,
  sessionB,
  USER_A_ID,
  USER_B_ID,
} from "./_harness";

// ---------------------------------------------------------------------------
// Contract suite: src/app/api/monitors/[id]/check/route.ts — the Phase 6
// stateless-producer rewrite (API-01/02, SEC-05, D-01..D-06, D-28).
//
// Handler-import pattern (02-05 / monitors-id.handler.test.ts precedent): the
// harness mocks the session door + @/db (the ONE Drizzle client — 07-08
// deletion release, DRZ-07); the file-local seams below mock the whole
// ENQUEUE path the route touches —
//   - @/lib/queue-producer -> webQueueProducer() returning a fake checks queue
//   - @/worker/queues      -> enqueueManualCheck (resolves { jobId } / rejects)
//   - @/lib/rate-limit     -> rateLimit (the REAL limiter semantics — TTL
//                             return, manual buckets, getIP spoof trio — live
//                             in tests/integration/rate-limit.test.ts)
// The next_check_at advance rides the harness's h.db.execute seam (the same
// @/db mock that serves the ownership read).
// No test dials a network target: the route module imports only these seams.
// Mocks are plain hoisted consts with lazy vi.mock factories (Pitfall 6 —
// never EXPORT vi.hoisted values).
// ---------------------------------------------------------------------------

const seams = vi.hoisted(() => {
  const checksQueue = { add: vi.fn() };
  return {
    checksQueue,
    enqueueManualCheck: vi.fn(),
    rateLimit: vi.fn(),
  };
});

// 06-06 (gap 2): async importOriginal factory spreading the REAL module and
// overriding ONLY webQueueProducer — the REAL withProducerDeadline runs
// through the route (a locally re-implemented mock would prove nothing about
// the production wrap). The @/worker/queues mock keeps enqueueManualCheck
// only; QUEUE_NAMES is referenced solely inside the never-called real
// webQueueProducer factory body.
vi.mock("@/lib/queue-producer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queue-producer")>();
  return {
    ...actual,
    webQueueProducer: () => ({ checks: seams.checksQueue }),
  };
});
vi.mock("@/worker/queues", () => ({ enqueueManualCheck: seams.enqueueManualCheck }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: seams.rateLimit, getIP: vi.fn() }));

// Imported AFTER the harness + seam mocks are registered (vitest hoists the
// vi.mock calls above the imports regardless — the established layout).
import { POST as POST_CHECK } from "@/app/api/monitors/[id]/check/route";

const activeMonitor = {
  id: 5,
  name: "A Monitor",
  url: "https://a.test",
  userId: USER_A_ID,
  isActive: true,
};

// 06-06 (gap 1): module-level fixture Dates shared by the advance mock and
// the compensation pin — the route must pass the advance RETURNING values
// straight back as the restore's parameters, so identity is assertable.
const PRIOR_NEXT_CHECK_AT = new Date("2026-09-30T10:00:00.000Z");
const ADVANCED_NEXT_CHECK_AT = new Date("2026-09-30T10:05:00.000Z");

/**
 * Extracts the parameter VALUES from a drizzle sql`...` statement captured by
 * h.db.execute. In this drizzle version template params sit RAW in
 * queryChunks (Number/String/Date directly) while template text is wrapped in
 * StringChunk instances — so the params are exactly the non-StringChunk
 * chunks (probe-verified chunk types: StringChunk | Number | String | Date).
 */
function paramValues(statement: unknown): unknown[] {
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter(
    (chunk) =>
      !(
        chunk !== null &&
        typeof chunk === "object" &&
        chunk.constructor?.name === "StringChunk"
      ),
  );
}

beforeEach(() => {
  mockSession(null);
  resetDbMocks();
  seams.checksQueue.add.mockReset();
  seams.enqueueManualCheck.mockReset();
  seams.rateLimit.mockReset();
  // Admit-by-default limiter; the 429 cases override per call.
  seams.rateLimit.mockResolvedValue({ success: true, remaining: 5, resetSeconds: 30 });
  // Advance-by-default drizzle UPDATE (one row claimed). 06-06: the CTE
  // advance's RETURNING also carries the captured prior + the advanced value.
  h.db.execute.mockResolvedValue({
    rows: [
      {
        id: 5,
        prior_next_check_at: PRIOR_NEXT_CHECK_AT,
        advanced_next_check_at: ADVANCED_NEXT_CHECK_AT,
      },
    ],
  });
  seams.enqueueManualCheck.mockResolvedValue({
    jobId: "check-manual:5:1699999999999",
    priority: 1,
  });
});

function postCheck(id = "5") {
  return POST_CHECK(
    buildRequest({ path: `/api/monitors/${id}/check`, method: "POST" }),
    routeParams({ id }),
  );
}

describe("POST /api/monitors/[id]/check — 202 enqueue contract (API-01, D-05)", () => {
  it("401 without session — no monitor read, no limiter, no enqueue", async () => {
    const res = await postCheck();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.db.select).not.toHaveBeenCalled();
    expect(seams.rateLimit).not.toHaveBeenCalled();
    expect(seams.enqueueManualCheck).not.toHaveBeenCalled();
  });

  it("400 on non-numeric id", async () => {
    mockSession(sessionA);
    const res = await postCheck("abc");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid monitor ID" });
  });

  it("ownership via the compound id+userId scope (D-17 form): B checking A's monitor → 404 with this route's distinct message", async () => {
    mockSession(sessionB);
    dbState.results = [[]];

    const res = await postCheck();

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found or unauthorized" });
    expect(h.db.select).toHaveBeenCalledTimes(1);
    expect(seams.rateLimit).not.toHaveBeenCalled();
    expect(seams.enqueueManualCheck).not.toHaveBeenCalled();
  });

  it("active owned monitor → 202 { jobId, queuedAt }; enqueue rides the web producer's checks queue through enqueueManualCheck", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];
    let enqueueSeenAt = 0;
    seams.enqueueManualCheck.mockImplementation(async () => {
      enqueueSeenAt = Date.now();
      return { jobId: "check-manual:5:1699999999999", priority: 1 };
    });

    const res = await postCheck();

    expect(res.status).toBe(202);
    const body = await res.json();
    // jobId is the 04-02 3-segment manual shape, verbatim from enqueueManualCheck.
    expect(body.jobId).toMatch(/^check-manual:5:\d+$/);
    expect(typeof body.queuedAt).toBe("number");
    // D-05: queuedAt is captured BEFORE the enqueue call (the poll basis).
    expect(body.queuedAt).toBeLessThanOrEqual(enqueueSeenAt);
    // The route enqueues through the shared helper over the web producer —
    // never a raw queue.add of its own.
    expect(seams.enqueueManualCheck).toHaveBeenCalledWith(5, {
      checksQueue: seams.checksQueue,
    });
    expect(seams.checksQueue.add).not.toHaveBeenCalled();
    // The admission ladder ran the two ratified buckets first (SEC-05).
    expect(seams.rateLimit).toHaveBeenNthCalledWith(
      1,
      `manual_${USER_A_ID}_5`,
      { limit: 1, windowMs: 30_000 },
    );
    expect(seams.rateLimit).toHaveBeenNthCalledWith(
      2,
      `manual-user_${USER_A_ID}`,
      { limit: 6, windowMs: 60_000 },
    );
  });

  it("D-28 mirror: inactive monitor → legacy success-shaped 200 with an empty result, zero enqueue, zero limiter consumption", async () => {
    mockSession(sessionA);
    dbState.results = [[{ ...activeMonitor, isActive: false }]];

    const res = await postCheck();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      message: "Monitor checked successfully",
      result: [],
    });
    expect(seams.rateLimit).not.toHaveBeenCalled();
    expect(h.db.execute).not.toHaveBeenCalled();
    expect(seams.enqueueManualCheck).not.toHaveBeenCalled();
  });
});

describe("POST /api/monitors/[id]/check — limiter admission (SEC-05, D-06)", () => {
  it("per-(user,monitor) bucket exhausted (2nd within 30s) → 429 with a NUMERIC Retry-After from resetSeconds", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];
    seams.rateLimit.mockResolvedValue({ success: false, remaining: 0, resetSeconds: 17 });

    const res = await postCheck();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
    await expect(res.json()).resolves.toEqual({
      error: "You're checking too often — try again shortly.",
    });
    expect(h.db.execute).not.toHaveBeenCalled();
    expect(seams.enqueueManualCheck).not.toHaveBeenCalled();
  });

  it("per-user bucket exhausted (7th check within a minute) → 429 with THAT bucket's Retry-After", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];
    seams.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 0, resetSeconds: 30 }) // per-monitor passes
      .mockResolvedValueOnce({ success: false, remaining: 0, resetSeconds: 23 }); // per-user exhausted

    const res = await postCheck();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("23");
    expect(seams.enqueueManualCheck).not.toHaveBeenCalled();
  });
});

describe("POST /api/monitors/[id]/check — enqueue-time advance (Pitfall 8) + degradation (API-02)", () => {
  it("the drizzle next_check_at advance claims the row BEFORE the enqueue (Pitfall 8 ordering)", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];

    await postCheck();

    expect(h.db.execute).toHaveBeenCalledTimes(1);
    // Invocation order: advance precedes enqueue — a scheduler tick can never
    // double-claim a manual check in flight.
    expect(h.db.execute.mock.invocationCallOrder[0]).toBeLessThan(
      seams.enqueueManualCheck.mock.invocationCallOrder[0],
    );
  });

  it("advance returns zero rows (monitor vanished/paused mid-flight) → 404, no enqueue", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];
    h.db.execute.mockResolvedValue({ rows: [] });

    const res = await postCheck();

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found or unauthorized" });
    expect(seams.enqueueManualCheck).not.toHaveBeenCalled();
  });

  it("enqueue rejection (Redis down — the bounded producer rejects fast) → 503 with the service-unavailable body (API-02)", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];
    seams.enqueueManualCheck.mockRejectedValue(
      new Error("Reached the max retries per request limit (current value: 1)."),
    );

    const res = await postCheck();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Service temporarily unavailable — try again shortly",
    });
  });

  it("a monitor-read failure keeps the legacy 500 catch-all shape", async () => {
    mockSession(sessionA);
    (h.db.select as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("db exploded");
    });

    const res = await postCheck();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to check monitor" });
  });
});

describe("POST /api/monitors/[id]/check — enqueue-failure compensation (06-06 gap 1, API-02)", () => {
  it("enqueue rejection → the guarded restore fires AFTER the rejection with the advance RETURNING values as its parameters", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];
    seams.enqueueManualCheck.mockRejectedValue(
      new Error("Reached the max retries per request limit (current value: 1)."),
    );

    const res = await postCheck();

    // The 503 contract is byte-identical to the pre-compensation route.
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Service temporarily unavailable — try again shortly",
    });
    // Advance + compensating restore = exactly TWO db.execute calls.
    expect(h.db.execute).toHaveBeenCalledTimes(2);
    // The restore ran after the failed enqueue call (compensation, not a
    // pre-enqueue write).
    expect(h.db.execute.mock.invocationCallOrder[1]).toBeGreaterThan(
      seams.enqueueManualCheck.mock.invocationCallOrder[0],
    );
    // The restore statement is parameterized by the advance's RETURNING
    // values passed straight back: the prior (restore target), monitorId,
    // userId (ownership), and the advanced value (the equality guard).
    const restoreParams = paramValues(h.db.execute.mock.calls[1][0]);
    expect(restoreParams).toContain(5);
    expect(restoreParams).toContain(USER_A_ID);
    expect(restoreParams).toContain(PRIOR_NEXT_CHECK_AT);
    expect(restoreParams).toContain(ADVANCED_NEXT_CHECK_AT);
  });

  it("guard miss (concurrent writer moved the row — restore matches zero rows) → still the 503 body, zero unhandled rejections", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];
    h.db.execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: 5,
            prior_next_check_at: PRIOR_NEXT_CHECK_AT,
            advanced_next_check_at: ADVANCED_NEXT_CHECK_AT,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    seams.enqueueManualCheck.mockRejectedValue(new Error("simulated redis down"));

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    let res: Response;
    try {
      res = await postCheck();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Service temporarily unavailable — try again shortly",
    });
    // The restore executed and its zero-row guard miss never threw past the
    // catch — the concurrent writer's value stays authoritative.
    expect(h.db.execute).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
  });

  it("happy path never restores: successful enqueue → exactly ONE db.execute (the advance), restore never invoked", async () => {
    mockSession(sessionA);
    dbState.results = [[activeMonitor]];

    const res = await postCheck();

    expect(res.status).toBe(202);
    expect(h.db.execute).toHaveBeenCalledTimes(1);
    expect(seams.enqueueManualCheck).toHaveBeenCalledTimes(1);
  });

  it("never-settling enqueue (silently-unreachable Redis) → deadline rejects → the fixed 503 + the compensating restore (06-06 gap 2, T-06-07)", async () => {
    vi.useFakeTimers();
    try {
      mockSession(sessionA);
      dbState.results = [[activeMonitor]];
      // The essential property of never-connectable Redis: neither resolve
      // nor reject (offline-queue/connecting state that never settles).
      seams.enqueueManualCheck.mockImplementation(() => new Promise<never>(() => {}));

      const { PRODUCER_DEADLINE_MS } = (await import("@/lib/queue-producer")) as unknown as {
        PRODUCER_DEADLINE_MS?: number;
      };
      const deadlineMs = PRODUCER_DEADLINE_MS ?? 3000;

      const pending = postCheck();
      // Race the route answer against a sentinel so the pre-deadline tree
      // fails THIS assertion (the route hangs) instead of tripping the
      // suite-wide test timeout and leaking fake timers into sibling cases.
      const sentinelMs = deadlineMs + 2_000;
      const raced = Promise.race([
        pending.then(() => "ANSWERED"),
        new Promise<string>((resolve) => setTimeout(() => resolve("HANGING"), sentinelMs)),
      ]);
      await vi.advanceTimersByTimeAsync(sentinelMs);
      expect(await raced).toBe("ANSWERED");

      const res = await pending;
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({
        error: "Service temporarily unavailable — try again shortly",
      });
      // Task 1's restore runs on the deadline path too: advance + restore.
      expect(h.db.execute).toHaveBeenCalledTimes(2);
      // The deadline timer is cleared — no live timer survives the request.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
