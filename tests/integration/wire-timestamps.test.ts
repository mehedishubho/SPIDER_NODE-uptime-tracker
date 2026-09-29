import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// REAL-DB wire regression suite (07-10 gap closure G-07-63 — CR-01 + WR-01 +
// WR-02). The handler suites stub the @/db seam with hand-built rows, so the
// driver's raw Postgres timestamp text — the exact thing the route ports
// leaked onto the wire — is invisible to them (why the suites stayed green
// through CR-01). This file is the only machine check that CAN see it: it
// seeds the docker test Postgres through the REAL Drizzle client, mocks ONLY
// the session door, drives the REAL route handlers, and pins the on-the-wire
// timestamp contract (ISO-8601 UTC Z), the WR-01 updatedAt advance, and the
// WR-02 empty-PATCH no-op on the real rows.
//
// Discipline (tests/integration/better-auth-cutover.test.ts +
// route-scoping.test.ts): fileParallelism false (vitest.config.ts), the
// session door is the ONLY mock (the real auth singleton must never
// evaluate), whole-table TRUNCATE per case (02-03), and NO import of
// tests/api/_harness — that harness replaces @/db with a stub and would
// silence exactly the driver behavior under test.
// ---------------------------------------------------------------------------

const sessionState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/session", () => ({
  getAuthSession: async () => sessionState.session,
}));

// Imported AFTER the mock registration (vi.mock hoists above these — the
// session door the routes receive is the mock; the query engine is real).
const { GET: GET_MONITORS } = await import("@/app/api/monitors/route");
const { PATCH: PATCH_MONITOR } = await import("@/app/api/monitors/[id]/route");
const { PATCH: PATCH_PROFILE } = await import("@/app/api/user/profile/route");

import { db } from "@/db";
import { monitors, users } from "@/db/schema";
import { iso } from "@/lib/serialize";

const RUN = randomUUID();
const USER_ID = `wire-user-${RUN}`;
const WIRE_EMAIL = `wire-user-${RUN}@example.test`;
// The known instant every seeded timestamp carries. Seeded as ISO-Z: the DB
// parses it into the naive columns (UTC wall-clock per the stored
// convention) and the suite proves the round-trip back to this exact
// instant — the DB-stores-UTC convention proven live, not by assertion.
const SEED_INSTANT = "2026-09-29T15:00:00.789Z";
const SEED_MS = Date.parse(SEED_INSTANT);
/** The strict Prisma-era wire contract: ISO-8601 UTC, Z-terminated. */
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MONITOR_TIMESTAMP_KEYS = ["lastChecked", "createdAt", "updatedAt", "nextCheckAt"] as const;

let monitorId = 0;

beforeEach(async () => {
  // 02-03 whole-table discipline: monitors then users (FK order), identity
  // restarted — every case seeds its own rows through the REAL client.
  await db.execute(sql`TRUNCATE TABLE monitors, users RESTART IDENTITY CASCADE`);
  await db.insert(users).values({
    id: USER_ID,
    name: "Wire User",
    email: WIRE_EMAIL,
    timezone: "UTC",
    createdAt: SEED_INSTANT,
    updatedAt: SEED_INSTANT,
  });
  const [row] = await db
    .insert(monitors)
    .values({
      name: "Wire Monitor",
      url: "https://wire.test",
      userId: USER_ID,
      status: "UP",
      lastChecked: SEED_INSTANT,
      createdAt: SEED_INSTANT,
      updatedAt: SEED_INSTANT,
      nextCheckAt: SEED_INSTANT,
    })
    .returning({ id: monitors.id });
  monitorId = row.id;
  sessionState.session = { user: { id: USER_ID } };
});

afterAll(async () => {
  // Leave the shared test tables empty for the next integration file.
  await db
    .execute(sql`TRUNCATE TABLE monitors, users RESTART IDENTITY CASCADE`)
    .catch(() => {});
});

function monitorRequest(method: string, body: string): Request {
  return new Request(`http://localhost/api/monitors/${monitorId}`, {
    method,
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("CR-01: the wire carries ISO-8601 UTC timestamps (real driver, real handlers)", () => {
  it("GET /api/monitors — every full-row timestamp matches the strict Z form and round-trips to the seeded instant", async () => {
    const res = await GET_MONITORS();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { monitors: Array<Record<string, unknown>> };
    expect(body.monitors).toHaveLength(1);
    const monitor = body.monitors[0];

    for (const key of MONITOR_TIMESTAMP_KEYS) {
      const value = monitor[key];
      expect(value).toMatch(ISO_Z);
      expect(new Date(value as string).getTime()).toBe(SEED_MS);
    }
  });
});

describe("WR-01: updatedAt advances on every UPDATE write path", () => {
  it("monitors PATCH — the stored row's updatedAt is strictly later than the seed, and the response row is ISO-Z", async () => {
    const res = await PATCH_MONITOR(
      monitorRequest("PATCH", JSON.stringify({ name: "Wire Renamed" })),
      { params: Promise.resolve({ id: String(monitorId) }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { monitor: Record<string, unknown> };
    for (const key of MONITOR_TIMESTAMP_KEYS) {
      expect(body.monitor[key]).toMatch(ISO_Z);
    }

    const [row] = await db.select().from(monitors).where(eq(monitors.id, monitorId));
    expect(row.name).toBe("Wire Renamed");
    expect(new Date(iso(row.updatedAt) as string).getTime()).toBeGreaterThan(SEED_MS);
  });

  it("profile PATCH — the stored user row's updatedAt is strictly later than the seed, and the response is ISO-Z", async () => {
    const res = await PATCH_PROFILE(
      new Request("http://localhost/api/user/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Wire Renamed User" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user.updatedAt).toMatch(ISO_Z);

    const [row] = await db.select().from(users).where(eq(users.id, USER_ID));
    expect(row.name).toBe("Wire Renamed User");
    expect(new Date(iso(row.updatedAt) as string).getTime()).toBeGreaterThan(SEED_MS);
  });
});

describe("WR-02: an empty monitors PATCH is a Prisma-equivalent no-op success", () => {
  it("PATCH with an empty JSON object answers 200 with the existing row (ISO-Z) and the DB row is unchanged", async () => {
    const res = await PATCH_MONITOR(
      monitorRequest("PATCH", "{}"),
      { params: Promise.resolve({ id: String(monitorId) }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; monitor: Record<string, unknown> };
    expect(body.message).toBe("Monitor updated successfully");
    expect(body.monitor.name).toBe("Wire Monitor");
    for (const key of MONITOR_TIMESTAMP_KEYS) {
      expect(body.monitor[key]).toMatch(ISO_Z);
    }

    const [row] = await db.select().from(monitors).where(eq(monitors.id, monitorId));
    expect(iso(row.updatedAt)).toBe(SEED_INSTANT);
    expect(row.name).toBe("Wire Monitor");
  });
});
