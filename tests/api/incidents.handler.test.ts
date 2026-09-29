import { beforeEach, describe, expect, it, vi } from "vitest";
import "./_harness";
import { dbLog, dbState, h, mockSession, resetDbMocks, sessionA, sessionB } from "./_harness";
import { GET } from "@/app/api/incidents/route";

// ---------------------------------------------------------------------------
// Characterization suite: src/app/api/incidents/route.ts (GET list).
// Ownership scoping goes through the monitor relation (where monitors.userId),
// not a direct column — 07-08 (DRZ-07) realized it as the equivalent Drizzle
// inner join; the join chain is pinned via dbLog, the projection via the
// select() call arg, and the value-level ownership proof lives on a real
// database in tests/integration/route-scoping.test.ts. No rate limiter on
// this route, so a static import is safe (no module state to isolate).
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSession(null);
  resetDbMocks();
});

describe("GET /api/incidents", () => {
  it("401 without session — body VERBATIM", async () => {
    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it("with session A, the read is one join query scoped through the monitor relation (projection keeps monitor { id, name, url, status })", async () => {
    mockSession(sessionA);
    const incidentRows = [
      { id: "inc-1", status: "ONGOING", monitor: { id: 5, name: "a-mon", url: "https://a.test", status: "DOWN" } },
    ];
    dbState.results = [incidentRows];

    const res = await GET();

    expect(res.status).toBe(200);
    expect(h.db.select).toHaveBeenCalledTimes(1);
    const projection = (h.db.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      monitor: Record<string, unknown>;
    };
    expect(Object.keys(projection.monitor).sort()).toEqual(["id", "name", "status", "url"]);
    expect(dbLog).toHaveLength(1);
    expect(dbLog[0].calls.map((call) => call.method)).toEqual([
      "from",
      "innerJoin",
      "where",
      "orderBy",
      "limit",
    ]);
    await expect(res.json()).resolves.toEqual({ incidents: incidentRows });
  });

  it("with session B, the same route re-runs the same scoped shape for B's DISTINCT userId", async () => {
    mockSession(sessionB);
    dbState.results = [[]];

    const res = await GET();

    expect(res.status).toBe(200);
    expect(dbLog[0].calls.map((call) => call.method)).toEqual([
      "from",
      "innerJoin",
      "where",
      "orderBy",
      "limit",
    ]);
    await expect(res.json()).resolves.toEqual({ incidents: [] });
  });

  it("500 on db failure — body VERBATIM", async () => {
    mockSession(sessionA);
    (h.db.select as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("db exploded");
    });

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch incidents" });
  });
});
