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

vi.mock("@/lib/queue-producer", () => ({
  webQueueProducer: () => ({ checks: seams.checksQueue }),
}));
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

beforeEach(() => {
  mockSession(null);
  resetDbMocks();
  seams.checksQueue.add.mockReset();
  seams.enqueueManualCheck.mockReset();
  seams.rateLimit.mockReset();
  // Admit-by-default limiter; the 429 cases override per call.
  seams.rateLimit.mockResolvedValue({ success: true, remaining: 5, resetSeconds: 30 });
  // Advance-by-default drizzle UPDATE (one row claimed).
  h.db.execute.mockResolvedValue({ rows: [{ id: 5 }] });
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
