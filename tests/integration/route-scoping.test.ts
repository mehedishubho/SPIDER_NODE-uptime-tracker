import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Value-level ownership-scoping proof on the REAL Drizzle client (docker PG).
//
// 07-08 (DRZ-07): the handler suites' Prisma-era scoping pins asserted the
// mock's call args (where: { userId }). The @/db seam records the query
// CHAIN, not the SQL value, so the D-21 mutation-target proof — the scoping
// WHERE clause routes by session identity on a real query — lives here,
// where the routes run against the real docker test Postgres (global-setup's
// drizzle-kit migrate): two distinct users own monitors/incidents, and each
// session's read returns ONLY that user's rows.
//
// The session door is mocked (the cookie machinery is Better Auth's, covered
// by the cutover suites) — the query engine is REAL, never mocked here.
// ---------------------------------------------------------------------------

const sessionState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/session", () => ({
  getAuthSession: async () => sessionState.session,
}));

import { GET as GET_MONITORS } from "@/app/api/monitors/route";
import { GET as GET_INCIDENTS } from "@/app/api/incidents/route";
import { db } from "@/db";
import { incidents, monitors, users } from "@/db/schema";

const RUN = randomUUID();
const USER_A_ID = `route-scope-a-${RUN}`;
const USER_B_ID = `route-scope-b-${RUN}`;
const MONITOR_BASE = 9_700_000; // high serial band, far from fixture data
const INCIDENT_A_ID = `route-scope-ia-${RUN}`;
const INCIDENT_B_ID = `route-scope-ib-${RUN}`;

beforeAll(async () => {
  const now = new Date().toISOString();
  for (const [id, email] of [
    [USER_A_ID, `route-scope-a-${RUN}@example.test`],
    [USER_B_ID, `route-scope-b-${RUN}@example.test`],
  ] as const) {
    await db.insert(users).values({ id, name: id, email, timezone: "UTC", updatedAt: now });
  }
  // A owns two monitors (one of them feeding an incident); B owns one plus
  // its own incident. Any cross-user bleed in the scoping WHERE fails here.
  await db.insert(monitors).values([
    { id: MONITOR_BASE + 1, name: "A-one", url: "https://scope-a1.test", userId: USER_A_ID, updatedAt: now },
    { id: MONITOR_BASE + 2, name: "A-two", url: "https://scope-a2.test", userId: USER_A_ID, updatedAt: now },
    { id: MONITOR_BASE + 3, name: "B-one", url: "https://scope-b1.test", userId: USER_B_ID, updatedAt: now },
  ]);
  await db.insert(incidents).values([
    { id: INCIDENT_A_ID, monitorId: MONITOR_BASE + 1, status: "ONGOING" },
    { id: INCIDENT_B_ID, monitorId: MONITOR_BASE + 3, status: "ONGOING" },
  ]);
});

afterAll(async () => {
  await db.delete(incidents).where(inArray(incidents.id, [INCIDENT_A_ID, INCIDENT_B_ID])).catch(() => {});
  await db.delete(monitors).where(inArray(monitors.id, [MONITOR_BASE + 1, MONITOR_BASE + 2, MONITOR_BASE + 3])).catch(() => {});
  await db.delete(users).where(inArray(users.id, [USER_A_ID, USER_B_ID])).catch(() => {});
});

describe("route reads scope by session identity on the real query engine (D-21)", () => {
  it("GET /api/monitors returns ONLY the session user's monitors — A never sees B's rows", async () => {
    sessionState.session = { user: { id: USER_A_ID } };

    const res = await GET_MONITORS();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { monitors: Array<{ id: number; userId: string }> };
    expect(body.monitors.map((m) => m.id).sort()).toEqual([MONITOR_BASE + 1, MONITOR_BASE + 2]);
    for (const monitor of body.monitors) {
      expect(monitor.userId).toBe(USER_A_ID);
    }
  });

  it("the same route scoped to B returns exactly B's DISTINCT monitor set", async () => {
    sessionState.session = { user: { id: USER_B_ID } };

    const res = await GET_MONITORS();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { monitors: Array<{ id: number }> };
    expect(body.monitors.map((m) => m.id)).toEqual([MONITOR_BASE + 3]);
  });

  it("GET /api/incidents scopes through the monitor relation — B's incident never rides A's read", async () => {
    sessionState.session = { user: { id: USER_A_ID } };

    const res = await GET_INCIDENTS();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidents: Array<{ id: string; monitor: { id: number } }> };
    expect(body.incidents.map((incident) => incident.id)).toEqual([INCIDENT_A_ID]);
    expect(body.incidents[0].monitor.id).toBe(MONITOR_BASE + 1);

    sessionState.session = { user: { id: USER_B_ID } };
    const resB = await GET_INCIDENTS();
    const bodyB = (await resB.json()) as { incidents: Array<{ id: string }> };
    expect(bodyB.incidents.map((incident) => incident.id)).toEqual([INCIDENT_B_ID]);
  });
});
