import { beforeEach, describe, expect, it } from "vitest";
import "./_harness";
import { buildRequest, h, mockSession, resetPrismaMocks, sessionA, sessionB, USER_A_ID, USER_B_ID } from "./_harness";
import { GET } from "@/app/api/incidents/route";

// ---------------------------------------------------------------------------
// Characterization suite: src/app/api/incidents/route.ts (GET list).
// Ownership scoping goes through the RELATION (where.monitor.userId), not a
// direct column — pinned via the prisma mock's call args. No rate limiter on
// this route, so a static import is safe (no module state to isolate).
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSession(null);
  resetPrismaMocks();
});

describe("GET /api/incidents", () => {
  it("401 without session — body VERBATIM", async () => {
    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.prisma.incident.findMany).not.toHaveBeenCalled();
  });

  it("with session A, scoping goes through where.monitor.userId = A (D-21 mutation target)", async () => {
    mockSession(sessionA);
    const incidents = [{ id: "inc-1", status: "ONGOING", monitor: { id: 5, name: "a-mon" } }];
    h.prisma.incident.findMany.mockResolvedValue(incidents);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(h.prisma.incident.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.incident.findMany).toHaveBeenCalledWith({
      where: { monitor: { userId: USER_A_ID } },
      include: {
        monitor: { select: { id: true, name: true, url: true, status: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    await expect(res.json()).resolves.toEqual({ incidents });
  });

  it("with session B, the same query scopes to B's DISTINCT userId", async () => {
    mockSession(sessionB);
    h.prisma.incident.findMany.mockResolvedValue([]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(h.prisma.incident.findMany).toHaveBeenCalledWith({
      where: { monitor: { userId: USER_B_ID } },
      include: {
        monitor: { select: { id: true, name: true, url: true, status: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    await expect(res.json()).resolves.toEqual({ incidents: [] });
  });

  it("500 on prisma failure — body VERBATIM", async () => {
    mockSession(sessionA);
    h.prisma.incident.findMany.mockRejectedValue(new Error("db exploded"));

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch incidents" });
  });
});
