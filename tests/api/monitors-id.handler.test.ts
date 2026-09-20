import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextResponse } from "next/server";
import "./_harness";
import {
  buildRequest,
  h,
  mockSession,
  resetPrismaMocks,
  routeParams,
  sessionA,
  sessionB,
  USER_B_ID,
} from "./_harness";
import { UrlNotAllowedError } from "@/lib/ssrf";

// ---------------------------------------------------------------------------
// Characterization suite: src/app/api/monitors/[id]/route.ts (GET / PATCH /
// DELETE) and src/app/api/monitors/[id]/details/route.ts (GET).
//
// The check route (src/app/api/monitors/[id]/check/route.ts) was rewritten in
// Phase 6 (06-01) as the enqueue + 202 producer — its contract now lives in
// tests/api/check-route.handler.test.ts, and the old runCronChecks/flushBatches
// pins were removed WITH the rewrite (Pitfall 7 — the suite never asserts
// removed behavior mid-wave).
//
// Ownership cases pin what the code REALLY does: user B asking for user A's
// monitor gets the not-found path, and the scoping WHERE clause is asserted
// through the prisma mock's call args (the D-21 mutation target).
//
// 06-03 (D-17) flipped the three pinned route defects WITH their fixes
// (Pitfall 7): GET findUnique→findFirst scoping, PATCH/DELETE bare
// `return`→400 "Invalid monitor ID" bodies. The SSRF pins (D-23/D-25) ride
// the @/lib/ssrf mock seam below.
// ---------------------------------------------------------------------------

// SSRF seam: @/lib/ssrf mocked at assertUrlAllowed only. vi.hoisted keeps
// the factory's bindings alive at link time (vi.mock hoists above the module
// body — plain let/const would be TDZ), and the cached actual keeps
// UrlNotAllowedError's class identity stable — the route's instanceof check
// must match the class this file constructs.
const ssrfMocks = vi.hoisted(() => ({
  assertUrlAllowed: vi.fn(),
  actual: null as typeof import("@/lib/ssrf") | null,
}));

vi.mock("@/lib/ssrf", async (importOriginal) => {
  ssrfMocks.actual ??= await importOriginal<typeof import("@/lib/ssrf")>();
  return { ...ssrfMocks.actual, assertUrlAllowed: ssrfMocks.assertUrlAllowed };
});

// Imported AFTER the harness (mocks registered) — vitest hoists these
// vi.mock calls above the imports anyway.
import { DELETE, GET, PATCH } from "@/app/api/monitors/[id]/route";
import { GET as GET_DETAILS } from "@/app/api/monitors/[id]/details/route";

beforeEach(() => {
  mockSession(null);
  resetPrismaMocks();
  ssrfMocks.assertUrlAllowed.mockReset(); // default: admission passes (public URL)
  ssrfMocks.assertUrlAllowed.mockResolvedValue(undefined);
});

/**
 * Strict-TS guard: every handler below must return a response (the old bare
 * `return` on non-numeric ids — a 500 over the wire — was fixed to a 400 in
 * 06-03/D-17; the pins flipped with the fix).
 */
function mustRespond(value: NextResponse | undefined): NextResponse {
  expect(value).toBeDefined();
  return value as NextResponse;
}

const monitorOfA = { id: 5, name: "A Monitor", url: "https://a.test", userId: "user-a" };

describe("GET /api/monitors/[id]", () => {
  it("401 without session — body VERBATIM (correct spelling here, unlike POST /api/monitors)", async () => {
    const res = await GET(buildRequest({ path: "/api/monitors/5" }), routeParams({ id: "5" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("400 on non-numeric id", async () => {
    mockSession(sessionA);
    const res = await GET(buildRequest({ path: "/api/monitors/abc" }), routeParams({ id: "abc" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid monitor ID" });
  });

  it("ownership: user B asking for A's monitor id → 404, scoping asserted via findFirst args (D-17 flipped)", async () => {
    mockSession(sessionB);
    // The mock mirrors the DB truth: a row with id 5 + userId B does not exist.
    h.prisma.monitor.findFirst.mockResolvedValue(null);

    const res = await GET(buildRequest({ path: "/api/monitors/5" }), routeParams({ id: "5" }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    // The scoping IS the defense: id AND userId in the WHERE clause — via
    // findFirst (06-03/D-17 flipped the old findUnique pin with the fix:
    // findUnique cannot express compound non-unique scoping).
    expect(h.prisma.monitor.findFirst).toHaveBeenCalledWith({
      where: { id: 5, userId: USER_B_ID },
    });
    expect(h.prisma.monitor.findUnique).not.toHaveBeenCalled();
  });

  it("200 for the owning session — body { monitor }", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findFirst.mockResolvedValue(monitorOfA);

    const res = await GET(buildRequest({ path: "/api/monitors/5" }), routeParams({ id: "5" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ monitor: monitorOfA });
  });
});

describe("PATCH /api/monitors/[id]", () => {
  it("401 without session", async () => {
    const res = mustRespond(await PATCH(
      buildRequest({ path: "/api/monitors/5", method: "PATCH", body: { name: "x" } }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("non-numeric id → 400 'Invalid monitor ID' (D-17 flipped: was a bare `return`/500)", async () => {
    mockSession(sessionA);

    // The old `if (isNaN(monitorId)) { return }` produced NO response — a 500
    // over the wire. Fixed in 06-03 (D-17); the pin flipped WITH the fix.
    const res = mustRespond(await PATCH(
      buildRequest({ path: "/api/monitors/abc", method: "PATCH", body: { name: "x" } }),
      routeParams({ id: "abc" }),
    ));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid monitor ID" });
    expect(h.prisma.monitor.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.monitor.update).not.toHaveBeenCalled();
  });

  it("ownership: B patching A's monitor → 404 via the scoped findFirst pre-check", async () => {
    mockSession(sessionB);
    h.prisma.monitor.findFirst.mockResolvedValue(null);

    const res = mustRespond(await PATCH(
      buildRequest({ path: "/api/monitors/5", method: "PATCH", body: { name: "Hijack" } }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    expect(h.prisma.monitor.findFirst).toHaveBeenCalledWith({
      where: { id: 5, userId: USER_B_ID },
    });
    expect(h.prisma.monitor.update).not.toHaveBeenCalled();
  });

  it("400 on invalid URL in the update payload (shorter message than POST's)", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findFirst.mockResolvedValue(monitorOfA);

    const res = mustRespond(await PATCH(
      buildRequest({
        path: "/api/monitors/5",
        method: "PATCH",
        body: { url: "not-a-url" },
      }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(400);
    // NOTE: PATCH's message is 'Invalid URL format' — POST's is
    // 'Invalid URL format (e.g., https://example.com)'. Both pinned verbatim.
    await expect(res.json()).resolves.toEqual({ error: "Invalid URL format" });
    // The format check precedes admission: a syntactically-bad URL never
    // spends a DNS lookup.
    expect(ssrfMocks.assertUrlAllowed).not.toHaveBeenCalled();
    expect(h.prisma.monitor.update).not.toHaveBeenCalled();
  });

  it("D-25: PATCH carrying a url field re-validates admission on the TRIMMED url before update", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findFirst.mockResolvedValue(monitorOfA);
    const updated = { ...monitorOfA, url: "https://public.example.test/new" };
    h.prisma.monitor.update.mockResolvedValue(updated);

    const res = mustRespond(await PATCH(
      buildRequest({
        path: "/api/monitors/5",
        method: "PATCH",
        body: { url: "  https://public.example.test/new  " },
      }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(200);
    // What gets STORED is what gets validated — the trimmed form (D-25).
    expect(ssrfMocks.assertUrlAllowed).toHaveBeenCalledWith("https://public.example.test/new");
    expect(h.prisma.monitor.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { url: "https://public.example.test/new" },
    });
    await expect(res.json()).resolves.toEqual({
      message: "Monitor updated successfully",
      monitor: updated,
    });
  });

  it("D-25: PATCH url DENIED by admission → 400 with the typed message verbatim, update never runs", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findFirst.mockResolvedValue(monitorOfA);
    ssrfMocks.assertUrlAllowed.mockRejectedValueOnce(
      new UrlNotAllowedError("URL is not allowed: only public http(s) targets are permitted"),
    );

    const res = mustRespond(await PATCH(
      buildRequest({
        path: "/api/monitors/5",
        method: "PATCH",
        body: { url: "http://10.0.0.5/" },
      }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "URL is not allowed: only public http(s) targets are permitted",
    });
    expect(h.prisma.monitor.update).not.toHaveBeenCalled();
  });

  it("D-25: PATCH with name/interval ONLY performs NO URL validation even when the stored URL is private", async () => {
    mockSession(sessionA);
    // Stored URL is private — irrelevant: the request carries no url field,
    // so re-validation must not fire (D-25 conditional check).
    h.prisma.monitor.findFirst.mockResolvedValue({ ...monitorOfA, url: "http://10.0.0.5/" });
    h.prisma.monitor.update.mockResolvedValue({ ...monitorOfA, name: "Renamed Only" });

    const res = mustRespond(await PATCH(
      buildRequest({
        path: "/api/monitors/5",
        method: "PATCH",
        body: { name: "Renamed Only", interval: "10" },
      }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(200);
    expect(ssrfMocks.assertUrlAllowed).not.toHaveBeenCalled();
    expect(h.prisma.monitor.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { name: "Renamed Only", interval: 10 },
    });
  });

  it("200 on success — update runs UNSCOPED (where: { id } only); the url field IS re-validated (D-25)", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findFirst.mockResolvedValue(monitorOfA);
    const updated = { ...monitorOfA, name: "Renamed", isActive: false };
    h.prisma.monitor.update.mockResolvedValue(updated);

    const res = mustRespond(await PATCH(
      buildRequest({
        path: "/api/monitors/5",
        method: "PATCH",
        body: { name: "  Renamed  ", url: "https://a.test/new", isActive: false, interval: "15" },
      }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(200);
    expect(h.prisma.monitor.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { name: "Renamed", url: "https://a.test/new", interval: 15, isActive: false },
    });
    // The multi-field update DID run admission on its url field (mock default:
    // allowed) before the update landed.
    expect(ssrfMocks.assertUrlAllowed).toHaveBeenCalledWith("https://a.test/new");
    await expect(res.json()).resolves.toEqual({
      message: "Monitor updated successfully",
      monitor: updated,
    });
  });
});

describe("DELETE /api/monitors/[id]", () => {
  it("401 without session", async () => {
    const res = mustRespond(await DELETE(
      buildRequest({ path: "/api/monitors/5", method: "DELETE" }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("non-numeric id → 400 'Invalid monitor ID' (D-17 flipped: same fix as PATCH)", async () => {
    mockSession(sessionA);

    const res = mustRespond(await DELETE(
      buildRequest({ path: "/api/monitors/abc", method: "DELETE" }),
      routeParams({ id: "abc" }),
    ));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid monitor ID" });
    expect(h.prisma.monitor.delete).not.toHaveBeenCalled();
  });

  it("ownership: B deleting A's monitor → 404, delete never invoked", async () => {
    mockSession(sessionB);
    h.prisma.monitor.findFirst.mockResolvedValue(null);

    const res = mustRespond(await DELETE(
      buildRequest({ path: "/api/monitors/5", method: "DELETE" }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    expect(h.prisma.monitor.findFirst).toHaveBeenCalledWith({
      where: { id: 5, userId: USER_B_ID },
    });
    expect(h.prisma.monitor.delete).not.toHaveBeenCalled();
  });

  it("200 for the owner — message-only body, delete where { id }", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findFirst.mockResolvedValue(monitorOfA);
    h.prisma.monitor.delete.mockResolvedValue(monitorOfA);

    const res = mustRespond(await DELETE(
      buildRequest({ path: "/api/monitors/5", method: "DELETE" }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(200);
    expect(h.prisma.monitor.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    await expect(res.json()).resolves.toEqual({ message: "Monitor deleted successfully" });
  });
});

describe("GET /api/monitors/[id]/details", () => {
  it("401 without session — body VERBATIM", async () => {
    const res = await GET_DETAILS(
      buildRequest({ path: "/api/monitors/5/details" }),
      routeParams({ id: "5" }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("400 on non-numeric id", async () => {
    mockSession(sessionA);
    const res = await GET_DETAILS(
      buildRequest({ path: "/api/monitors/abc/details" }),
      routeParams({ id: "abc" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid monitor ID" });
  });

  it("ownership: B requesting A's details → 404; findFirst scoped AND carries the include shape", async () => {
    mockSession(sessionB);
    h.prisma.monitor.findFirst.mockResolvedValue(null);

    const res = await GET_DETAILS(
      buildRequest({ path: "/api/monitors/5/details" }),
      routeParams({ id: "5" }),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    expect(h.prisma.monitor.findFirst).toHaveBeenCalledWith({
      where: { id: 5, userId: USER_B_ID },
      include: {
        pings: { orderBy: { createdAt: "desc" }, take: 100 },
        incidents: { orderBy: { startedAt: "desc" }, take: 20 },
      },
    });
  });

  it("200 for the owner — body { monitor } with the included relations", async () => {
    mockSession(sessionA);
    const withRelations = {
      ...monitorOfA,
      pings: [{ id: 1, status: "UP" }],
      incidents: [],
    };
    h.prisma.monitor.findFirst.mockResolvedValue(withRelations);

    const res = await GET_DETAILS(
      buildRequest({ path: "/api/monitors/5/details" }),
      routeParams({ id: "5" }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ monitor: withRelations });
  });

  it("500 body is 'Internal Server Error' — DIFFERENT from the monitors route's message", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findFirst.mockRejectedValue(new Error("db exploded"));

    const res = await GET_DETAILS(
      buildRequest({ path: "/api/monitors/5/details" }),
      routeParams({ id: "5" }),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal Server Error" });
  });
});
