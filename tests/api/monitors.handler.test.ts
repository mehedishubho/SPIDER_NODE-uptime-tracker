import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import "./_harness";
import {
  buildRequest,
  dbLog,
  dbState,
  h,
  mockSession,
  resetDbMocks,
  sessionA,
  sessionB,
  USER_A_ID,
  USER_B_ID,
} from "./_harness";
import { UrlNotAllowedError } from "@/lib/ssrf";

// ---------------------------------------------------------------------------
// Characterization suite: src/app/api/monitors/route.ts (GET list + POST
// create) — the canonical session-guard template every D-17 route follows.
//
// This file exercises the rate limiter — REAL, never mocked: since Phase 3
// (03-01) @/lib/rate-limit is Redis-backed (atomic Lua INCR+EXPIRE) against
// the docker test Redis via REDIS_URL, so limiter state now survives module
// resets. The per-case reset mechanism is a flush of the rl:* keyspace on
// that Redis (SCAN+DEL via the admin client below — never KEYS) in
// beforeEach; vi.resetModules() is RETAINED because the route/db mock seams
// still need a fresh module registry per case (Pitfall 6 / 03-01 Pitfall 3).
// The 429 + same-IP follow-up cases below prove cross-case isolation through
// that flush.
//
// ZERO production code is changed by this suite except where a pin was
// DELIBERATELY flipped alongside its fix (Pitfall 7): the 06-03 slice flipped
// the POST 401 "Unauthirized" typo pin to the corrected spelling WITH the
// route fix, and added the SSRF admission pins (D-23/D-33). Every other
// response body below is pinned VERBATIM as today's contract.
//
// 07-08 deletion release (DRZ-07): the model-access seam is @/db (the ONE
// Drizzle client). The Prisma-era scoping-by-call-args pins became
// invocation-level pins (from/where/orderBy recorded in dbLog); the
// value-level ownership proof lives on a real database in
// tests/integration/route-scoping.test.ts.
//
// SSRF seam: @/lib/ssrf is mocked at assertUrlAllowed only (cached
// importOriginal keeps UrlNotAllowedError's class identity stable across
// vi.resetModules — the route's instanceof check must match the class this
// file constructs).
// ---------------------------------------------------------------------------

// vi.hoisted: the vi.mock factory is hoisted above the module body, so every
// binding it touches must exist at link time (the cron-suite pattern) — a
// plain `let`/`const` would be TDZ. The cached actual keeps
// UrlNotAllowedError's class identity stable across vi.resetModules — the
// route's instanceof check must match the class this file constructs.
const ssrfMocks = vi.hoisted(() => ({
  assertUrlAllowed: vi.fn(),
  actual: null as typeof import("@/lib/ssrf") | null,
}));

vi.mock("@/lib/ssrf", async (importOriginal) => {
  ssrfMocks.actual ??= await importOriginal<typeof import("@/lib/ssrf")>();
  return { ...ssrfMocks.actual, assertUrlAllowed: ssrfMocks.assertUrlAllowed };
});

/** Dedicated admin client for the per-case rl:* flush (separate from the limiter's). */
const redisAdmin = new Redis(process.env.REDIS_URL!);

/** Flushes limiter keys on the test Redis — the fresh-state reset per case. */
async function flushLimiterKeys(): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await redisAdmin.scan(cursor, "MATCH", "rl:*", "COUNT", 100);
    if (batch.length > 0) {
      await redisAdmin.del(...batch);
    }
    cursor = next;
  } while (cursor !== "0");
}

afterAll(async () => {
  await redisAdmin.quit();
  // Drop the limiter singleton's socket so the worker process can exit cleanly.
  const globalForRedis = global as unknown as { redis?: Redis };
  globalForRedis.redis?.disconnect();
  delete globalForRedis.redis;
});

beforeEach(async () => {
  vi.resetModules(); // fresh route-module registry per case (mock seams — Pitfall 6)
  await flushLimiterKeys(); // limiter state lives in Redis now — flush rl:* per case
  mockSession(null); // default: unauthenticated
  resetDbMocks();
  ssrfMocks.assertUrlAllowed.mockReset(); // default: admission passes (public URL)
  ssrfMocks.assertUrlAllowed.mockResolvedValue(undefined);
});

/** Re-imports the route against the freshly reset module registry. */
async function loadRoute() {
  return import("@/app/api/monitors/route");
}

describe("GET /api/monitors (list)", () => {
  it("401 without session — body pinned VERBATIM", async () => {
    const { GET } = await loadRoute();

    const res = await GET();

    expect(res.status).toBe(401);
    // GET spells it correctly (POST does not — see below); both are today's contract.
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it("with session A, the read chains from/where/orderBy — scoped to the session identity (07-08: value-level proof in route-scoping.test.ts)", async () => {
    mockSession(sessionA);
    const rows = [{ id: 1, name: "a-mon" }];
    dbState.results = [rows];

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(200);
    expect(h.db.select).toHaveBeenCalledTimes(1);
    expect(dbLog).toHaveLength(1);
    expect(dbLog[0].op).toBe("select");
    expect(dbLog[0].calls.map((call) => call.method)).toEqual(["from", "where", "orderBy"]);
    await expect(res.json()).resolves.toEqual({
      monitors: rows,
    });
  });

  it("with session B, the same route re-runs the same scoped shape for B's identity", async () => {
    mockSession(sessionB);
    dbState.results = [[]];

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(200);
    // The scoping is session-identity-driven, not hardcoded: an identical
    // chain shape issues a second time (see the route: eq(monitors.userId,
    // session.user.id) — the only variable is the session).
    expect(dbLog[0].calls.map((call) => call.method)).toEqual(["from", "where", "orderBy"]);
    await expect(res.json()).resolves.toEqual({ monitors: [] });
  });

  it("500 on db failure — the 02-01-fixed contract: error key only, NO error-echo details field", async () => {
    mockSession(sessionA);
    (h.db.select as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("db exploded");
    });

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(500);
    // toEqual against the WHOLE body proves the old `details: error.message`
    // leak (FND-07) stays gone — any re-added key turns this red.
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch monitors" });
  });
});

describe("POST /api/monitors (create)", () => {
  it("401 without session — FLIPPED (06-03/D-17): the corrected spelling, pinned with the fix", async () => {
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: "/api/monitors", method: "POST", body: {} }));

    expect(res.status).toBe(401);
    // The old "Unauthirized" misspelling was fixed in 06-03 (D-17); this pin
    // flipped in the SAME change. Zero client string-matching existed on the
    // typo (06-RESEARCH delegated verification #1).
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("403 when the user already owns 10 monitors (free-tier limit)", async () => {
    mockSession(sessionA);
    dbState.results = [[{ value: 10 }]];

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "Over Limit", url: "https://over-limit.test" },
      }),
    );

    expect(res.status).toBe(403);
    expect(h.db.select).toHaveBeenCalledTimes(1); // the count
    expect(dbLog[0].calls.map((call) => call.method)).toEqual(["from", "where"]);
    await expect(res.json()).resolves.toEqual({
      error: "Monitor limit reached. You can only create up to 10 monitors on the free tier.",
    });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("400 when name or url is missing (limit check runs BEFORE validation)", async () => {
    mockSession(sessionA);
    dbState.results = [[{ value: 0 }]];

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({ path: "/api/monitors", method: "POST", body: { url: "https://x.test" } }),
    );

    expect(res.status).toBe(400);
    expect(h.db.select).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual({ error: "Name and URL are required" });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("400 on URL parse failure — exact error string with the e.g. example", async () => {
    mockSession(sessionA);
    dbState.results = [[{ value: 0 }]];

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "Bad Url", url: "not-a-valid-url" },
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid URL format (e.g., https://example.com)",
    });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("400 when SSRF admission denies the URL — monitor never created (D-23)", async () => {
    mockSession(sessionA);
    dbState.results = [[{ value: 0 }]];
    ssrfMocks.assertUrlAllowed.mockRejectedValueOnce(
      new UrlNotAllowedError("URL is not allowed: only public http(s) targets are permitted"),
    );

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "Internal Target", url: "http://10.0.0.5/" },
      }),
    );

    expect(res.status).toBe(400);
    // The typed rejection's message surfaces verbatim — actionable, never
    // internals-bearing (D-32).
    await expect(res.json()).resolves.toEqual({
      error: "URL is not allowed: only public http(s) targets are permitted",
    });
    expect(ssrfMocks.assertUrlAllowed).toHaveBeenCalledWith("http://10.0.0.5/");
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("the 201 path runs assertUrlAllowed on the TRIMMED url before create (D-23)", async () => {
    mockSession(sessionA);
    const created = { id: 45 };
    dbState.results = [[{ value: 0 }], [created]];

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "Public Target", url: "  https://public.example.test/  " },
      }),
    );

    expect(res.status).toBe(201);
    // What gets STORED is what gets validated — the trimmed form.
    expect(ssrfMocks.assertUrlAllowed).toHaveBeenCalledWith("https://public.example.test/");
    expect(h.db.insert).toHaveBeenCalledTimes(1);
  });

  it("assertUrlAllowed infra failure (not a UrlNotAllowedError) → 500, monitor NOT created (fail closed)", async () => {
    mockSession(sessionA);
    dbState.results = [[{ value: 0 }]];
    ssrfMocks.assertUrlAllowed.mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN resolver outage"));

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "Flaky Target", url: "https://flaky.example.test/" },
      }),
    );

    // A resolver outage must not be laundered into a user-error 400 — and
    // must never create the row (fail closed).
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to create monitor" });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("201 on success — trims name/url, parses interval, inserts with status PENDING", async () => {
    mockSession(sessionA);
    const created = { id: 42, name: "Trimmed", url: "https://trimmed.test/" };
    dbState.results = [[{ value: 0 }], [created]];

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "  Trimmed  ", url: "  https://trimmed.test/  ", interval: "10" },
      }),
    );

    expect(res.status).toBe(201);
    // status: "PENDING" (not the schema default UNKNOWN) is why API-created
    // monitors send "MONITORING STARTED" on first UP — 02-RESEARCH Pitfall 4.
    const insertEntry = dbLog.find((entry) => entry.op === "insert");
    expect(insertEntry).toBeDefined();
    const [values] = insertEntry!.calls.find((call) => call.method === "values")!.args as [
      Record<string, unknown>,
    ];
    expect(values).toEqual({
      name: "Trimmed",
      url: "https://trimmed.test/",
      interval: 10,
      userId: USER_A_ID,
      status: "PENDING",
      updatedAt: expect.any(String), // NOT NULL, no DB default — supplied explicitly
    });
    await expect(res.json()).resolves.toEqual({
      message: "Monitor listed successfully",
      monitor: created,
    });
  });

  it("201 defaults interval to 5 when not supplied", async () => {
    mockSession(sessionB);
    dbState.results = [[{ value: 3 }], [{ id: 43 }]];

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "Default Interval", url: "https://default-interval.test" },
      }),
    );

    expect(res.status).toBe(201);
    const insertEntry = dbLog.find((entry) => entry.op === "insert");
    const [values] = insertEntry!.calls.find((call) => call.method === "values")!.args as [
      Record<string, unknown>,
    ];
    expect(values).toMatchObject({
      name: "Default Interval",
      url: "https://default-interval.test",
      interval: 5,
      userId: USER_B_ID,
      status: "PENDING",
    });
  });

  it("429 when the 20/min per-IP limiter trips — and the limiter fires BEFORE the session guard", async () => {
    const { POST } = await loadRoute();

    // One dedicated IP so this case is self-contained; 20 calls exhaust the
    // limit, the 21st is rejected. Session stays null, which doubles as a pin
    // of the guard ORDER: unauthenticated callers burn/bounce on the limiter
    // first (rate limit precedes the session check in today's code).
    const ip = "203.0.113.77";
    for (let i = 1; i <= 20; i++) {
      const res = await POST(
        buildRequest({ path: "/api/monitors", method: "POST", body: {}, ip }),
      );
      expect(res.status).toBe(401); // rate-limit pass + no session
    }

    const res = await POST(buildRequest({ path: "/api/monitors", method: "POST", body: {}, ip }));

    expect(res.status).toBe(429);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    await expect(res.json()).resolves.toEqual({
      error: "Too many requests. Please try again later.",
    });
  });

  it("after a reset (next case), the same IP starts from a clean limiter — module reset proven", async () => {
    // Runs directly after the 429 case in file order. If the rate-limit Map
    // leaked across cases, this POST would 429; the beforeEach resetModules
    // guarantees a fresh module (Pitfall 6). Passing in file order AND in
    // isolation is the acceptance criterion.
    mockSession(sessionA);
    dbState.results = [[{ value: 0 }], [{ id: 44 }]];

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        ip: "203.0.113.77", // the SAME IP the 429 case exhausted
        body: { name: "Fresh Window", url: "https://fresh-window.test" },
      }),
    );

    expect(res.status).toBe(201);
  });
});
