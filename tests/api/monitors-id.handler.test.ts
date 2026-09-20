import { beforeEach, describe, expect, it } from "vitest";
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
// ---------------------------------------------------------------------------

// Imported AFTER the harness (mocks registered) — vitest hoists these
// vi.mock calls above the imports anyway.
import { DELETE, GET, PATCH } from "@/app/api/monitors/[id]/route";
import { GET as GET_DETAILS } from "@/app/api/monitors/[id]/details/route";

beforeEach(() => {
  mockSession(null);
  resetPrismaMocks();
});

/**
 * PATCH/DELETE on this route can legitimately resolve to `undefined` (the
 * bare `return` on non-numeric ids — pinned below). For every OTHER case the
 * response must exist; this guard both asserts that and satisfies strict TS.
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

  it("ownership: user B asking for A's monitor id → 404, scoping asserted via findUnique args", async () => {
    mockSession(sessionB);
    // The mock mirrors the DB truth: a row with id 5 + userId B does not exist.
    h.prisma.monitor.findUnique.mockResolvedValue(null);

    const res = await GET(buildRequest({ path: "/api/monitors/5" }), routeParams({ id: "5" }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    // The scoping IS the defense: id AND userId in the WHERE clause.
    expect(h.prisma.monitor.findUnique).toHaveBeenCalledWith({
      where: { id: 5, userId: USER_B_ID },
    });
  });

  it("200 for the owning session — body { monitor }", async () => {
    mockSession(sessionA);
    h.prisma.monitor.findUnique.mockResolvedValue(monitorOfA);

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

  it("non-numeric id → handler returns UNDEFINED (today's bare `return` — pinned as-is)", async () => {
    mockSession(sessionA);

    // Defect pin: `if (isNaN(monitorId)) { return }` has no response — the
    // handler resolves to undefined, which over the wire surfaces as a 500
    // from the runtime. Pinned deliberately; the thin-routes rewrite (Phase 6)
    // owns fixing it.
    const res = await PATCH(
      buildRequest({ path: "/api/monitors/abc", method: "PATCH", body: { name: "x" } }),
      routeParams({ id: "abc" }),
    );

    expect(res).toBeUndefined();
    expect(h.prisma.monitor.findFirst).not.toHaveBeenCalled();
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
    expect(h.prisma.monitor.update).not.toHaveBeenCalled();
  });

  it("200 on success — update runs UNSCOPED (where: { id } only); ownership relies on the pre-check", async () => {
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

  it("non-numeric id → handler returns UNDEFINED (same bare `return` defect as PATCH)", async () => {
    mockSession(sessionA);

    const res = await DELETE(
      buildRequest({ path: "/api/monitors/abc", method: "DELETE" }),
      routeParams({ id: "abc" }),
    );

    expect(res).toBeUndefined();
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
