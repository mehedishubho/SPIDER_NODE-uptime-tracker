import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextResponse } from "next/server";
import "./_harness";
import {
  buildRequest,
  dbLog,
  dbState,
  h,
  mockSession,
  resetDbMocks,
  routeParams,
  sessionA,
  sessionB,
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
// monitor gets the not-found path (07-08: the value-level WHERE proof moved
// to tests/integration/route-scoping.test.ts; the invocation-level chain is
// pinned here via dbLog).
//
// 06-03 (D-17) flipped the three pinned route defects WITH their fixes
// (Pitfall 7): GET findUnique→findFirst scoping, PATCH/DELETE bare
// `return`→400 "Invalid monitor ID" bodies. The SSRF pins (D-23/D-25) ride
// the @/lib/ssrf mock seam below. 07-08 (DRZ-07): the model-access seam is
// @/db — write paths keep Prisma's vanished-row 500s via the returning-empty
// guards.
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
  resetDbMocks();
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

  it("ownership: user B asking for A's monitor id → 404 via the scoped pre-check (D-17 flipped)", async () => {
    mockSession(sessionB);
    // The mock mirrors the DB truth: a row with id 5 + userId B does not exist.
    dbState.results = [[]];

    const res = await GET(buildRequest({ path: "/api/monitors/5" }), routeParams({ id: "5" }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    // The scoping IS the defense: id AND userId in the WHERE clause — the
    // compound predicate form the 06-03/D-17 flip established (findUnique
    // cannot express compound non-unique scoping).
    expect(dbLog[0].calls.map((call) => call.method)).toEqual(["from", "where", "limit"]);
  });

  it("200 for the owning session — body { monitor }", async () => {
    mockSession(sessionA);
    dbState.results = [[monitorOfA]];

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
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("ownership: B patching A's monitor → 404 via the scoped pre-check", async () => {
    mockSession(sessionB);
    dbState.results = [[]];

    const res = mustRespond(await PATCH(
      buildRequest({ path: "/api/monitors/5", method: "PATCH", body: { name: "Hijack" } }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("400 on invalid URL in the update payload (shorter message than POST's)", async () => {
    mockSession(sessionA);
    dbState.results = [[monitorOfA]];

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
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("D-25: PATCH carrying a url field re-validates admission on the TRIMMED url before update", async () => {
    mockSession(sessionA);
    const updated = { ...monitorOfA, url: "https://public.example.test/new" };
    dbState.results = [[monitorOfA], [updated]];

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
    const updateEntry = dbLog.find((entry) => entry.op === "update");
    expect(updateEntry).toBeDefined();
    const [set] = updateEntry!.calls.find((call) => call.method === "set")!.args as [
      Record<string, unknown>,
    ];
    expect(set).toEqual({ url: "https://public.example.test/new" });
    await expect(res.json()).resolves.toEqual({
      message: "Monitor updated successfully",
      monitor: updated,
    });
  });

  it("D-25: PATCH url DENIED by admission → 400 with the typed message verbatim, update never runs", async () => {
    mockSession(sessionA);
    dbState.results = [[monitorOfA]];
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
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("D-25: PATCH with name/interval ONLY performs NO URL validation even when the stored URL is private", async () => {
    mockSession(sessionA);
    // Stored URL is private — irrelevant: the request carries no url field,
    // so re-validation must not fire (D-25 conditional check).
    dbState.results = [[{ ...monitorOfA, url: "http://10.0.0.5/" }], [{ ...monitorOfA, name: "Renamed Only" }]];

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
    const updateEntry = dbLog.find((entry) => entry.op === "update");
    const [set] = updateEntry!.calls.find((call) => call.method === "set")!.args as [
      Record<string, unknown>,
    ];
    expect(set).toEqual({ name: "Renamed Only", interval: 10 });
  });

  it("200 on success — update runs UNSCOPED (where: { id } only); the url field IS re-validated (D-25)", async () => {
    mockSession(sessionA);
    const updated = { ...monitorOfA, name: "Renamed", isActive: false };
    dbState.results = [[monitorOfA], [updated]];

    const res = mustRespond(await PATCH(
      buildRequest({
        path: "/api/monitors/5",
        method: "PATCH",
        body: { name: "  Renamed  ", url: "https://a.test/new", isActive: false, interval: "15" },
      }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(200);
    const updateEntry = dbLog.find((entry) => entry.op === "update");
    const [set] = updateEntry!.calls.find((call) => call.method === "set")!.args as [
      Record<string, unknown>,
    ];
    expect(set).toEqual({ name: "Renamed", url: "https://a.test/new", interval: 15, isActive: false });
    // The multi-field update DID run admission on its url field (mock default:
    // allowed) before the update landed.
    expect(ssrfMocks.assertUrlAllowed).toHaveBeenCalledWith("https://a.test/new");
    await expect(res.json()).resolves.toEqual({
      message: "Monitor updated successfully",
      monitor: updated,
    });
  });

  it("vanished-row race on the write → the same 500 Prisma's P2025 rejection produced (07-08 guard)", async () => {
    mockSession(sessionA);
    dbState.results = [[monitorOfA], []];

    const res = mustRespond(await PATCH(
      buildRequest({ path: "/api/monitors/5", method: "PATCH", body: { name: "x" } }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to update monitor" });
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
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  it("ownership: B deleting A's monitor → 404, delete never invoked", async () => {
    mockSession(sessionB);
    dbState.results = [[]];

    const res = mustRespond(await DELETE(
      buildRequest({ path: "/api/monitors/5", method: "DELETE" }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  it("200 for the owner — message-only body, delete where { id }", async () => {
    mockSession(sessionA);
    dbState.results = [[monitorOfA], [monitorOfA]];

    const res = mustRespond(await DELETE(
      buildRequest({ path: "/api/monitors/5", method: "DELETE" }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(200);
    expect(dbLog.find((entry) => entry.op === "delete")).toBeDefined();
    await expect(res.json()).resolves.toEqual({ message: "Monitor deleted successfully" });
  });

  it("vanished-row race on the write → the same 500 Prisma's P2025 rejection produced (07-08 guard)", async () => {
    mockSession(sessionA);
    dbState.results = [[monitorOfA], []];

    const res = mustRespond(await DELETE(
      buildRequest({ path: "/api/monitors/5", method: "DELETE" }),
      routeParams({ id: "5" }),
    ));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to delete monitor" });
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

  it("ownership: B requesting A's details → 404; the scoped pre-check never reaches the relations", async () => {
    mockSession(sessionB);
    dbState.results = [[]];

    const res = await GET_DETAILS(
      buildRequest({ path: "/api/monitors/5/details" }),
      routeParams({ id: "5" }),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    expect(h.db.select).toHaveBeenCalledTimes(1); // the monitor row only
  });

  it("200 for the owner — body { monitor } with the included relations (100 pings / 20 incidents bounds)", async () => {
    mockSession(sessionA);
    const pings = [{ id: "ping-1", status: "UP" }];
    const incidents: Array<Record<string, unknown>> = [];
    dbState.results = [[monitorOfA], pings, incidents];

    const res = await GET_DETAILS(
      buildRequest({ path: "/api/monitors/5/details" }),
      routeParams({ id: "5" }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      monitor: { ...monitorOfA, pings, incidents },
    });
    // The relation-load bounds carried over from the Prisma include shape.
    const selectEntries = dbLog.filter((entry) => entry.op === "select");
    expect(selectEntries).toHaveLength(3);
    expect(selectEntries[1].calls.find((call) => call.method === "limit")!.args).toEqual([100]);
    expect(selectEntries[2].calls.find((call) => call.method === "limit")!.args).toEqual([20]);
  });

  it("500 body is 'Internal Server Error' — DIFFERENT from the monitors route's message", async () => {
    mockSession(sessionA);
    (h.db.select as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("db exploded");
    });

    const res = await GET_DETAILS(
      buildRequest({ path: "/api/monitors/5/details" }),
      routeParams({ id: "5" }),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal Server Error" });
  });
});
