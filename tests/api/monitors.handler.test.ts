import { beforeEach, describe, expect, it, vi } from "vitest";
import "./_harness";
import {
  buildRequest,
  h,
  mockSession,
  resetPrismaMocks,
  sessionA,
  sessionB,
  USER_A_ID,
  USER_B_ID,
} from "./_harness";

// ---------------------------------------------------------------------------
// Characterization suite: src/app/api/monitors/route.ts (GET list + POST
// create) — the canonical session-guard template every D-17 route follows.
//
// This file exercises the rate limiter (@/lib/rate-limit keeps an in-memory
// Map that survives across cases), so every case re-resolves the route via
// vi.resetModules() + dynamic import — the same registry-reset discipline
// 02-03 established for db-batcher (Pitfall 6). The harness mocks (next-auth,
// @/lib/prisma) keep their identity across resets via vi.hoisted().
//
// ZERO production code is changed by this suite: every response body below —
// including the misspellings — is pinned VERBATIM as today's contract. A
// future "fix the typo" PR must update these assertions DELIBERATELY.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules(); // fresh @/lib/rate-limit Map per case (Pitfall 6)
  mockSession(null); // default: unauthenticated
  resetPrismaMocks();
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
    expect(h.prisma.monitor.findMany).not.toHaveBeenCalled();
  });

  it("with session A, findMany is scoped to A's userId (D-21 mutation target)", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findMany.mockResolvedValue([{ id: 1, name: "a-mon" }]);

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(200);
    expect(h.prisma.monitor.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.monitor.findMany).toHaveBeenCalledWith({
      where: { userId: USER_A_ID },
      orderBy: { createdAt: "desc" },
    });
    await expect(res.json()).resolves.toEqual({
      monitors: [{ id: 1, name: "a-mon" }],
    });
  });

  it("with session B, the same route scopes to B's DISTINCT userId", async () => {
    mockSession(sessionB);
    h.prisma.monitor.findMany.mockResolvedValue([]);

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(200);
    // The scoping is session-identity-driven, not hardcoded: B's id, not A's.
    expect(h.prisma.monitor.findMany).toHaveBeenCalledWith({
      where: { userId: USER_B_ID },
      orderBy: { createdAt: "desc" },
    });
  });

  it("500 on prisma failure — the 02-01-fixed contract: error key only, NO error-echo details field", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findMany.mockRejectedValue(new Error("db exploded"));

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(500);
    // toEqual against the WHOLE body proves the old `details: error.message`
    // leak (FND-07) stays gone — any re-added key turns this red.
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch monitors" });
  });
});

describe("POST /api/monitors (create)", () => {
  it("401 without session — body pinned VERBATIM including today's misspelling", async () => {
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: "/api/monitors", method: "POST", body: {} }));

    expect(res.status).toBe(401);
    // "Unauthirized" — DELIBERATE pin. This misspelling is part of today's
    // API contract until the Phase 6 thin-routes rewrite changes it on purpose.
    await expect(res.json()).resolves.toEqual({ error: "Unauthirized" });
    expect(h.prisma.monitor.count).not.toHaveBeenCalled();
  });

  it("403 when the user already owns 10 monitors (free-tier limit)", async () => {
    mockSession(sessionA);
    h.prisma.monitor.count.mockResolvedValue(10);

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "Over Limit", url: "https://over-limit.test" },
      }),
    );

    expect(res.status).toBe(403);
    expect(h.prisma.monitor.count).toHaveBeenCalledWith({
      where: { userId: USER_A_ID },
    });
    await expect(res.json()).resolves.toEqual({
      error: "Monitor limit reached. You can only create up to 10 monitors on the free tier.",
    });
    expect(h.prisma.monitor.create).not.toHaveBeenCalled();
  });

  it("400 when name or url is missing (limit check runs BEFORE validation)", async () => {
    mockSession(sessionA);
    h.prisma.monitor.count.mockResolvedValue(0);

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({ path: "/api/monitors", method: "POST", body: { url: "https://x.test" } }),
    );

    expect(res.status).toBe(400);
    expect(h.prisma.monitor.count).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual({ error: "Name and URL are required" });
    expect(h.prisma.monitor.create).not.toHaveBeenCalled();
  });

  it("400 on URL parse failure — exact error string with the e.g. example", async () => {
    mockSession(sessionA);
    h.prisma.monitor.count.mockResolvedValue(0);

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
    expect(h.prisma.monitor.create).not.toHaveBeenCalled();
  });

  it("201 on success — trims name/url, parses interval, creates with status PENDING", async () => {
    mockSession(sessionA);
    h.prisma.monitor.count.mockResolvedValue(0);
    const created = { id: 42, name: "Trimmed", url: "https://trimmed.test/" };
    h.prisma.monitor.create.mockResolvedValue(created);

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
    expect(h.prisma.monitor.create).toHaveBeenCalledWith({
      data: {
        name: "Trimmed",
        url: "https://trimmed.test/",
        interval: 10,
        userId: USER_A_ID,
        status: "PENDING",
      },
    });
    await expect(res.json()).resolves.toEqual({
      message: "Monitor listed successfully",
      monitor: created,
    });
  });

  it("201 defaults interval to 5 when not supplied", async () => {
    mockSession(sessionB);
    h.prisma.monitor.count.mockResolvedValue(3);
    h.prisma.monitor.create.mockResolvedValue({ id: 43 });

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/monitors",
        method: "POST",
        body: { name: "Default Interval", url: "https://default-interval.test" },
      }),
    );

    expect(res.status).toBe(201);
    expect(h.prisma.monitor.create).toHaveBeenCalledWith({
      data: {
        name: "Default Interval",
        url: "https://default-interval.test",
        interval: 5,
        userId: USER_B_ID,
        status: "PENDING",
      },
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
    h.prisma.monitor.count.mockResolvedValue(0);
    h.prisma.monitor.create.mockResolvedValue({ id: 44 });

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
