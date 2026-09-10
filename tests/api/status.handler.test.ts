import { beforeEach, describe, expect, it } from "vitest";
import "./_harness";
import {
  buildRequest,
  h,
  mockSession,
  resetPrismaMocks,
  routeParams,
  sessionA,
  sessionNoUserId,
  USER_A_ID,
} from "./_harness";
import { GET as GET_STATUS } from "@/app/api/status/route";
import { GET as GET_PUBLIC_STATUS } from "@/app/api/status/[userId]/route";
import { GET as GET_FEEDBACK, POST as POST_FEEDBACK } from "@/app/api/feedback/route";

// ---------------------------------------------------------------------------
// Characterization suite: src/app/api/status/route.ts (own status page),
// src/app/api/status/[userId]/route.ts (public status page), and
// src/app/api/feedback/route.ts (POST create + GET list).
//
// Discovered truths pinned here (not fixes — D-17):
//   - /api/status REQUIRES a session despite its "no auth needed" comment.
//   - /api/status/[userId] is the genuinely public route (no session at all).
//   - feedback's guard is WEAKER than the template (`!session || !session.user`,
//     no id check) and its GET list is NOT ownership-scoped — any
//     authenticated user sees every user's feedback.
// No rate limiter on any of these routes — static imports are safe.
// ---------------------------------------------------------------------------

const PUBLIC_USER_ID = "public-user-id-for-status";

beforeEach(() => {
  mockSession(null);
  resetPrismaMocks();
});

describe("GET /api/status (own status page)", () => {
  it("401 without session — the route's 'no auth needed' comment is NOT today's behavior", async () => {
    const res = await GET_STATUS();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("200 with session — user + ACTIVE-only monitors, exact select list, body shape", async () => {
    mockSession(sessionA);
    const user = { id: USER_A_ID, name: "User A" };
    const monitors = [{ id: 1, name: "a-mon", status: "UP" }];
    h.prisma.user.findUnique.mockResolvedValue(user);
    h.prisma.monitor.findMany.mockResolvedValue(monitors);

    const res = await GET_STATUS();

    expect(res.status).toBe(200);
    expect(h.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_A_ID },
      select: { id: true, name: true },
    });
    // isActive: true — inactive monitors are invisible on the status page.
    expect(h.prisma.monitor.findMany).toHaveBeenCalledWith({
      where: { userId: USER_A_ID, isActive: true },
      select: {
        id: true,
        name: true,
        url: true,
        status: true,
        uptimePercent: true,
        responseTime: true,
        lastChecked: true,
        interval: true,
      },
      orderBy: { createdAt: "asc" },
    });
    await expect(res.json()).resolves.toEqual({ user, monitors });
  });

  it("500 on prisma failure — body VERBATIM", async () => {
    mockSession(sessionA);
    h.prisma.user.findUnique.mockRejectedValue(new Error("db exploded"));

    const res = await GET_STATUS();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch status data" });
  });
});

describe("GET /api/status/[userId] (public status page)", () => {
  it("unknown user → 404 'Page not found' — no session involved", async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);

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
    h.prisma.user.findUnique.mockResolvedValue(user);
    h.prisma.monitor.findMany.mockResolvedValue(monitors);
    h.prisma.incident.findMany.mockResolvedValue(recentIncidents);

    const res = await GET_PUBLIC_STATUS(
      buildRequest({ path: `/api/status/${PUBLIC_USER_ID}` }),
      routeParams({ userId: PUBLIC_USER_ID }),
    );

    expect(res.status).toBe(200);
    expect(h.prisma.monitor.findMany).toHaveBeenCalledWith({
      where: { userId: PUBLIC_USER_ID, isActive: true },
      select: {
        id: true,
        name: true,
        url: true,
        status: true,
        uptimePercent: true,
        responseTime: true,
        lastChecked: true,
        interval: true,
      },
      orderBy: { createdAt: "asc" },
    });
    // Only ONGOING incidents, newest 10, scoped through the relation.
    expect(h.prisma.incident.findMany).toHaveBeenCalledWith({
      where: { monitor: { userId: PUBLIC_USER_ID }, status: "ONGOING" },
      include: { monitor: { select: { name: true } } },
      orderBy: { startedAt: "desc" },
      take: 10,
    });
    await expect(res.json()).resolves.toEqual({ user, monitors, recentIncidents });
  });

  it("500 on prisma failure — body VERBATIM (same message as /api/status)", async () => {
    h.prisma.user.findUnique.mockRejectedValue(new Error("db exploded"));

    const res = await GET_PUBLIC_STATUS(
      buildRequest({ path: `/api/status/${PUBLIC_USER_ID}` }),
      routeParams({ userId: PUBLIC_USER_ID }),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch status data" });
  });
});

describe("POST /api/feedback", () => {
  it("401 without session — body VERBATIM (from the next-auth/next import)", async () => {
    const res = await POST_FEEDBACK(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "BUG", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.prisma.feedback.create).not.toHaveBeenCalled();
  });

  it("weaker guard pinned: a session WITHOUT user.id passes — create runs with userId undefined", async () => {
    // Defect pin (documented, not fixed — D-17): feedback checks
    // `!session || !session.user` while every template route checks the id.
    mockSession(sessionNoUserId);
    const created = { id: "fb-1", title: "t", type: "BUG" };
    h.prisma.feedback.create.mockResolvedValue(created);

    const res = await POST_FEEDBACK(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "BUG", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(201);
    expect(h.prisma.feedback.create).toHaveBeenCalledWith({
      data: { userId: undefined, type: "BUG", title: "t", description: "d" },
    });
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
    expect(h.prisma.feedback.create).not.toHaveBeenCalled();
  });

  it("201 on success — the created feedback object is returned BARE (no wrapper key)", async () => {
    mockSession(sessionA);
    const created = { id: "fb-2", userId: USER_A_ID, type: "FEATURE", title: "t", description: "d" };
    h.prisma.feedback.create.mockResolvedValue(created);

    const res = await POST_FEEDBACK(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "FEATURE", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(201);
    expect(h.prisma.feedback.create).toHaveBeenCalledWith({
      data: { userId: USER_A_ID, type: "FEATURE", title: "t", description: "d" },
    });
    // Not { feedback: ... } — the row itself is the body.
    await expect(res.json()).resolves.toEqual(created);
  });
});

describe("GET /api/feedback (list)", () => {
  it("401 without session — body VERBATIM", async () => {
    const res = await GET_FEEDBACK(buildRequest({ path: "/api/feedback" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.prisma.feedback.findMany).not.toHaveBeenCalled();
  });

  it("NOT ownership-scoped: any authenticated user lists EVERY feedback row (pinned as-is)", async () => {
    // Defect pin (documented, not fixed — D-17): the where clause has no
    // userId filter; the response includes every user's feedback with the
    // author's name/email/image. This is today's contract.
    mockSession(sessionA);
    const allRows = [
      { id: "fb-b", title: "someone else's feedback", user: { name: "B", email: "b@x.test", image: null } },
    ];
    h.prisma.feedback.findMany.mockResolvedValue(allRows);

    const res = await GET_FEEDBACK(buildRequest({ path: "/api/feedback" }));

    expect(res.status).toBe(200);
    expect(h.prisma.feedback.findMany).toHaveBeenCalledWith({
      where: {},
      include: {
        user: { select: { name: true, email: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    // Bare array — not wrapped in { feedback: ... }.
    await expect(res.json()).resolves.toEqual(allRows);
  });

  it("?status=... filters by status ONLY (still no user scoping)", async () => {
    mockSession(sessionA);
    h.prisma.feedback.findMany.mockResolvedValue([]);

    const res = await GET_FEEDBACK(buildRequest({ path: "/api/feedback?status=PLANNED" }));

    expect(res.status).toBe(200);
    expect(h.prisma.feedback.findMany).toHaveBeenCalledWith({
      where: { status: "PLANNED" },
      include: {
        user: { select: { name: true, email: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });
});
