import { beforeEach, describe, expect, it, vi } from "vitest";
import "./_harness";
import {
  buildRequest,
  dbLog,
  dbState,
  h,
  mockSession,
  resetDbMocks,
  sessionA,
  USER_A_ID,
} from "./_harness";

// ---------------------------------------------------------------------------
// Contract suite: src/app/api/user/profile/route.ts PATCH password branch —
// the WINDOWS #4 closure (2026-10-02).
//
// Before the closure the branch verified currentPassword against and wrote
// ONLY the legacy inert users.password copy, so a profile-set password never
// changed the real login password (account.password, the Better Auth engine
// copy since the Phase-7 flip). The contract now pinned:
//   1. the branch DELEGATES to auth.api.changePassword on the one createAuth()
//      instance (engine validates against + writes account.password,
//      revokeOtherSessions: true per the D-28 posture) carrying the request
//      headers for the session;
//   2. the legacy users.password copy is re-synced in the same PATCH write
//      (07-08 both-copies discipline);
//   3. an engine rejection maps to the long-standing 400 "Invalid current
//      password" with NO user-row write;
//   4. plain profile saves (no password fields) never touch the engine.
//
// Seams: the harness mocks @/lib/session + @/db; this file mocks @/lib/auth
// whole (the route imports only { auth }) with an api.changePassword spy.
// The never-taken image branch's cloudinary import is inert without image
// payloads. bcryptjs is REAL — the legacy-copy sync hash is asserted by
// prefix, never by literal.
// ---------------------------------------------------------------------------

const seams = vi.hoisted(() => ({
  changePassword: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { changePassword: seams.changePassword } },
}));

import { PATCH } from "@/app/api/user/profile/route";

const existingUserRow = {
  id: USER_A_ID,
  name: "User A",
  email: "user-a@owner.test",
  image: null,
  telegramChatId: null,
  timezone: null,
  password: "$2a$10$legacycopyhashthatnothingverifies",
  createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
};

const updatedUserRow = {
  id: USER_A_ID,
  name: "Renamed A",
  email: "user-a@owner.test",
  image: null,
  telegramChatId: null,
  timezone: null,
  updatedAt: new Date("2026-10-02T00:00:00Z").toISOString(),
};

function patchProfile(body: unknown) {
  return PATCH(buildRequest({ path: "/api/user/profile", method: "PATCH", body }));
}

beforeEach(() => {
  resetDbMocks();
  seams.changePassword.mockReset();
  seams.changePassword.mockResolvedValue({ status: true });
  mockSession(sessionA);
  dbState.results = [[existingUserRow], [updatedUserRow]];
});

describe("profile PATCH password branch (WINDOWS #4 closure)", () => {
  it("delegates to auth.api.changePassword with the session headers and D-28 revocation, then syncs the legacy copy", async () => {
    const res = await patchProfile({
      currentPassword: "the-real-old-password",
      newPassword: "the-new-password",
    });

    expect(res.status).toBe(200);

    // The engine call: authoritative copy, revocation posture, request
    // headers for the session.
    expect(seams.changePassword).toHaveBeenCalledTimes(1);
    const arg = seams.changePassword.mock.calls[0][0] as {
      body: Record<string, unknown>;
      headers: Headers;
    };
    expect(arg.body).toEqual({
      currentPassword: "the-real-old-password",
      newPassword: "the-new-password",
      revokeOtherSessions: true,
    });
    expect(arg.headers).toBeInstanceOf(Headers);

    // The same PATCH write carries the re-synced legacy copy (bcrypt-10
    // prefix — never a literal) alongside updatedAt (WR-01).
    const update = dbLog.find((op) => op.op === "update");
    expect(update).toBeDefined();
    const set = update!.calls.find((c) => c.method === "set");
    expect(set).toBeDefined();
    const setData = set!.args[0] as Record<string, unknown>;
    expect(setData.password).toMatch(/^\$2[aby]\$10\$/);
    expect(setData.updatedAt).toEqual(expect.any(String));
  });

  it("maps an engine rejection to the 400 contract and writes nothing", async () => {
    seams.changePassword.mockRejectedValue(new Error("INVALID_PASSWORD"));
    dbState.results = [[existingUserRow]];

    const res = await patchProfile({
      currentPassword: "wrong-current",
      newPassword: "the-new-password",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid current password" });
    expect(dbLog.some((op) => op.op === "update")).toBe(false);
  });

  it("keeps the stable missing-current-password 400 without calling the engine", async () => {
    dbState.results = [[existingUserRow]];

    const res = await patchProfile({ newPassword: "the-new-password" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Current password is required to set a new password",
    });
    expect(seams.changePassword).not.toHaveBeenCalled();
    expect(dbLog.some((op) => op.op === "update")).toBe(false);
  });

  it("keeps the min-length 400 ahead of any engine call", async () => {
    dbState.results = [[existingUserRow]];

    const res = await patchProfile({
      currentPassword: "whatever",
      newPassword: "abc",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "New password must be at least 6 characters long",
    });
    expect(seams.changePassword).not.toHaveBeenCalled();
  });

  it("never touches the engine on a plain profile save", async () => {
    const res = await patchProfile({ name: "Renamed A" });

    expect(res.status).toBe(200);
    expect(seams.changePassword).not.toHaveBeenCalled();
    const update = dbLog.find((op) => op.op === "update");
    const set = update!.calls.find((c) => c.method === "set");
    expect((set!.args[0] as Record<string, unknown>).password).toBeUndefined();
  });

  it("refuses unauthenticated PATCHes before any read or engine call", async () => {
    mockSession(null);

    const res = await patchProfile({
      currentPassword: "x",
      newPassword: "the-new-password",
    });

    expect(res.status).toBe(401);
    expect(seams.changePassword).not.toHaveBeenCalled();
    expect(h.db.select).not.toHaveBeenCalled();
  });
});
