import { beforeEach, describe, expect, it, vi } from "vitest";
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
  sessionNoUserId,
  USER_A_ID,
} from "./_harness";
import { GET as GET_STATUS } from "@/app/api/status/route";
import { GET as GET_PUBLIC_STATUS } from "@/app/api/status/[userId]/route";
import { POST as POST_FEEDBACK } from "@/app/api/feedback/route";

// ---------------------------------------------------------------------------
// Characterization suite: src/app/api/status/route.ts (own status page),
// src/app/api/status/[userId]/route.ts (public status page), and
// src/app/api/feedback/route.ts (POST create).
//
// Discovered truths pinned here (not fixes — D-17):
//   - /api/status REQUIRES a session despite its "no auth needed" comment.
//   - /api/status/[userId] is the genuinely public route (no session at all).
//   - feedback's guard is WEAKER than the template (`!session || !session.user`,
//     no id check) on POST.
//
// 07-03: the feedback GET list pins (NOT ownership-scoped, any authenticated
// user read every row — the R17 leak) were removed WITH the admin-gate
// rewrite, per the Pitfall-7 discipline. The flipped contract — admin 200 /
// non-admin 403 / anon 401, POST authenticated-for-all, and the D-16 audit
// line — lives in tests/api/feedback-admin.handler.test.ts (the Drizzle-read
// @/db seam rides there too).
//
// 07-08 deletion release (DRZ-07): the model-access seam is @/db (the ONE
// Drizzle client); multi-query routes resolve per-query fixtures through the
// dbState.results queue, and the status-page select projections are pinned
// via the select() call args.
//
// No rate limiter on any of these routes — static imports are safe.
// ---------------------------------------------------------------------------

const PUBLIC_USER_ID = "public-user-id-for-status";

beforeEach(() => {
  mockSession(null);
  resetDbMocks();
});

describe("GET /api/status (own status page)", () => {
  it("401 without session — the route's 'no auth needed' comment is NOT today's behavior", async () => {
    const res = await GET_STATUS();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it("200 with session — user + ACTIVE-only monitors, exact select projections, body shape", async () => {
    mockSession(sessionA);
    const user = { id: USER_A_ID, name: "User A" };
    const monitors = [{ id: 1, name: "a-mon", status: "UP" }];
    dbState.results = [[user], monitors];

    const res = await GET_STATUS();

    expect(res.status).toBe(200);
    expect(h.db.select).toHaveBeenCalledTimes(2);
    const userProjection = (h.db.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(userProjection).sort()).toEqual(["id", "name"]);
    // isActive: true — inactive monitors are invisible on the status page.
    const monitorProjection = (h.db.select as ReturnType<typeof vi.fn>).mock.calls[1][0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(monitorProjection).sort()).toEqual([
      "id",
      "interval",
      "lastChecked",
      "name",
      "responseTime",
      "status",
      "uptimePercent",
      "url",
    ]);
    await expect(res.json()).resolves.toEqual({ user, monitors });
  });

  it("500 on db failure — body VERBATIM", async () => {
    mockSession(sessionA);
    (h.db.select as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("db exploded");
    });

    const res = await GET_STATUS();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch status data" });
  });
});

describe("GET /api/status/[userId] (public status page)", () => {
  it("unknown user → 404 'Page not found' — no session involved", async () => {
    dbState.results = [[]];

    const res = await GET_PUBLIC_STATUS(
      buildRequest({ path: `/api/status/${PUBLIC_USER_ID}` }),
      routeParams({ userId: PUBLIC_USER_ID }),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Page not found" });
    // Genuinely public: the session is never even consulted.
    expect(h.getServerSession).not.toHaveBeenCalled();
  });

  it("200 — user + active monitors + recent ONGOING incidents, pinning all three query shapes", async () => {
    const user = { id: PUBLIC_USER_ID, name: "Public User" };
    const monitors = [{ id: 9, name: "pub-mon", status: "DOWN" }];
    const recentIncidents = [{ id: "inc-9", status: "ONGOING", monitor: { name: "pub-mon" } }];
    dbState.results = [[user], monitors, recentIncidents];

    const res = await GET_PUBLIC_STATUS(
      buildRequest({ path: `/api/status/${PUBLIC_USER_ID}` }),
      routeParams({ userId: PUBLIC_USER_ID }),
    );

    expect(res.status).toBe(200);
    // Only ONGOING incidents, newest 10, scoped through the monitor relation.
    const selectEntries = dbLog.filter((entry) => entry.op === "select");
    expect(selectEntries).toHaveLength(3);
    const incidentProjection = (h.db.select as ReturnType<typeof vi.fn>).mock.calls[2][0] as {
      monitor: Record<string, unknown>;
    };
    expect(Object.keys(incidentProjection.monitor).sort()).toEqual(["name"]);
    expect(selectEntries[2].calls.find((call) => call.method === "limit")!.args).toEqual([10]);
    await expect(res.json()).resolves.toEqual({ user, monitors, recentIncidents });
  });

  it("500 on db failure — body VERBATIM (same message as /api/status)", async () => {
    (h.db.select as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("db exploded");
    });

    const res = await GET_PUBLIC_STATUS(
      buildRequest({ path: `/api/status/${PUBLIC_USER_ID}` }),
      routeParams({ userId: PUBLIC_USER_ID }),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch status data" });
  });
});

describe("POST /api/feedback", () => {
  it("401 without session — body VERBATIM", async () => {
    const res = await POST_FEEDBACK(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "BUG", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("weaker guard pinned: a session WITHOUT user.id passes — the insert runs with userId undefined", async () => {
    // Defect pin (documented, not fixed — D-17): feedback checks
    // `!session || !session.user` while every template route checks the id.
    // The seam-level pin is the write ATTEMPT carrying the undefined userId —
    // the guard never narrows it (a real DB would reject the NOT NULL column;
    // the pin documents the guard shape, not the storage outcome).
    mockSession(sessionNoUserId);
    const created = { id: "fb-1", title: "t", type: "BUG" };
    dbState.results = [[created]];

    const res = await POST_FEEDBACK(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "BUG", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(201);
    const insertEntry = dbLog.find((entry) => entry.op === "insert");
    expect(insertEntry).toBeDefined();
    const [values] = insertEntry!.calls.find((call) => call.method === "values")!.args as [
      Record<string, unknown>,
    ];
    expect(values).toMatchObject({ userId: undefined, type: "BUG", title: "t", description: "d" });
  });

  it("400 when any of title/description/type is missing — exact message", async () => {
    mockSession(sessionA);

    const res = await POST_FEEDBACK(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { title: "only title" }, // no description, no type
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Missing required fields: title, description, and type are required",
    });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("201 on success — the created feedback object is returned BARE (no wrapper key), id generated client-side (text PK has no DB default)", async () => {
    mockSession(sessionA);
    const created = { id: "fb-2", userId: USER_A_ID, type: "FEATURE", title: "t", description: "d" };
    dbState.results = [[created]];

    const res = await POST_FEEDBACK(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "FEATURE", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(201);
    const insertEntry = dbLog.find((entry) => entry.op === "insert");
    const [values] = insertEntry!.calls.find((call) => call.method === "values")!.args as [
      Record<string, unknown>,
    ];
    expect(values).toMatchObject({
      userId: USER_A_ID,
      type: "FEATURE",
      title: "t",
      description: "d",
    });
    expect(typeof values.id).toBe("string");
    expect((values.id as string).length).toBeGreaterThan(0);
    // Not { feedback: ... } — the row itself is the body.
    await expect(res.json()).resolves.toEqual(created);
  });
});

// 07-03: the GET /api/feedback list pins were REMOVED WITH the admin-gate
// rewrite (Pitfall 7 — the suite never asserts removed behavior mid-wave).
// The full flipped matrix — admin 200 / non-admin 403 / anon 401, the D-16
// audit line, and the Drizzle read seam — lives in
// tests/api/feedback-admin.handler.test.ts.
