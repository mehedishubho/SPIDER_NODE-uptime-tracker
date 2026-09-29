import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "./_harness";
import {
  buildRequest,
  dbLog,
  dbState,
  h,
  mockSession,
  resetDbMocks,
  sessionA,
  sessionB,
  USER_A_ID,
  USER_B_ID,
} from "./_harness";
import { GET, POST } from "@/app/api/feedback/route";

// ---------------------------------------------------------------------------
// GET /api/feedback admin-gate matrix (07-03 Task 3, SEC-04 / D-14 / R17 /
// D-16) — the flipped contract that replaces the R17-leak defect pins removed
// from status.handler.test.ts WITH the rewrite (Pitfall 7).
//
// Seam discipline (tests/api/_harness.ts): the session seam is the SHARED
// h.getServerSession instance backing @/lib/session's getAuthSession — the
// fixtures below add the admin-plugin `role` (D-13 primitive, seeded on
// users.role by 07-01 migration 0002) to the two distinct-id fixtures.
// The read/write seam is @/db — the ONE Drizzle client (the 07-03 converted
// GET join; 07-08 moved POST's create off Prisma, DRZ-07). The SELECT
// projection is captured so the user: { name, email, image } shape stays
// pinned.
//
// Matrix (D-14): GET admin 200 / non-admin 403 / anon 401; POST stays
// authenticated-for-all. D-16: ONE structured audit line per GET hit —
// allowed AND refused — never on POST (GET is the admin surface).
// ---------------------------------------------------------------------------

const FIXTURE_ROWS = [
  {
    id: "fb-1",
    userId: USER_B_ID,
    type: "FEATURE",
    title: "B's feedback",
    description: "d",
    status: "PENDING",
    upvotes: 0,
    createdAt: "2026-09-01 10:00:00.000",
    updatedAt: "2026-09-01 10:00:00.000",
    user: { name: "User B", email: "user-b@owner.test", image: null },
  },
];

/** The admin/non-admin fixtures: the harness ids with `role` added (D-13). */
const sessionAdmin = {
  user: { ...sessionA.user, image: null, role: "admin" },
  expires: sessionA.expires,
};
const sessionNonAdmin = {
  user: { ...sessionB.user, image: null, role: "user" },
  expires: sessionB.expires,
};

let logSpy: Mock;

beforeEach(() => {
  mockSession(null);
  resetDbMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

/** The D-16 structured lines captured on console.log. */
function adminAccessLines(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === "string")
    .filter((value) => value.includes("admin_surface_access"))
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

describe("GET /api/feedback — admin-gate matrix (D-14/R17)", () => {
  it("401 anon — the gate sits AFTER authentication; nothing is read", async () => {
    const res = await GET(buildRequest({ path: "/api/feedback" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.db.select).not.toHaveBeenCalled();
    // No session, no admin-surface line (the audit line needs a userId).
    expect(adminAccessLines()).toHaveLength(0);
  });

  it("403 non-admin — the R17 leak closed; the D-16 line records the refusal", async () => {
    mockSession(sessionNonAdmin);

    const res = await GET(buildRequest({ path: "/api/feedback", ip: "198.51.100.7" }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    // Refused = no read.
    expect(h.db.select).not.toHaveBeenCalled();

    // D-16: exactly one structured line for the refused hit.
    const lines = adminAccessLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "admin_surface_access",
      userId: USER_B_ID,
      route: "/api/feedback",
      ip: "198.51.100.7",
    });
    expect(typeof lines[0].timestamp).toBe("string");
  });

  it("200 admin — the Drizzle join resolves, projection keeps user { name, email, image }, D-16 line logs", async () => {
    mockSession(sessionAdmin);
    dbState.result = FIXTURE_ROWS;

    const res = await GET(buildRequest({ path: "/api/feedback", ip: "198.51.100.8" }));

    expect(res.status).toBe(200);
    // The projection captured at select() — the joined user shape is
    // preserved from the Prisma-era read.
    const projection = (h.db.select as unknown as Mock).mock.calls[0][0] as {
      user: { name: unknown; email: unknown; image: unknown };
    };
    expect(Object.keys(projection.user).sort()).toEqual(["email", "image", "name"]);

    await expect(res.json()).resolves.toEqual(FIXTURE_ROWS);

    const lines = adminAccessLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "admin_surface_access",
      userId: USER_A_ID,
      route: "/api/feedback",
      ip: "198.51.100.8",
    });
  });

  it("?status= filter still narrows rows for the admin (orderBy createdAt desc kept)", async () => {
    mockSession(sessionAdmin);
    dbState.result = [];

    const res = await GET(buildRequest({ path: "/api/feedback?status=PENDING" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });
});

describe("POST /api/feedback — stays authenticated-for-all (D-14)", () => {
  it("201 for a plain authenticated user — NO admin gate, NO D-16 line (POST is not the admin surface)", async () => {
    mockSession(sessionNonAdmin);
    const created = { id: "fb-2", userId: USER_B_ID, type: "FEATURE", title: "t", description: "d" };
    dbState.results = [[created]];

    const res = await POST(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "FEATURE", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(201);
    const insertEntry = dbLog.find((entry) => entry.op === "insert");
    expect(insertEntry).toBeDefined();
    const [values] = insertEntry!.calls.find((call) => call.method === "values")!.args as [
      Record<string, unknown>,
    ];
    expect(values).toMatchObject({
      userId: USER_B_ID,
      type: "FEATURE",
      title: "t",
      description: "d",
    });
    expect(adminAccessLines()).toHaveLength(0);
  });

  it("201 for an admin too — the gate never narrows POST", async () => {
    mockSession(sessionAdmin);
    const created = { id: "fb-3", userId: USER_A_ID, type: "BUG", title: "t", description: "d" };
    dbState.results = [[created]];

    const res = await POST(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "BUG", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(201);
    expect(adminAccessLines()).toHaveLength(0);
  });

  it("401 without a session — POST keeps its authentication requirement", async () => {
    const res = await POST(
      buildRequest({
        path: "/api/feedback",
        method: "POST",
        body: { type: "BUG", title: "t", description: "d" },
      }),
    );

    expect(res.status).toBe(401);
    expect(h.db.insert).not.toHaveBeenCalled();
  });
});
