import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./_harness";
import { buildRequest, h, resetPrismaMocks } from "./_harness";

// ---------------------------------------------------------------------------
// Characterization suite: the CRON routes and the Telegram webhook — the
// DELIBERATE PINNED-DEFECT file (D-17). Everything here documents today's
// security posture so the scheduled remediations land as visible red→green:
//
//   DEFECT 1 (S-4, Phase 6 SEC-06): both cron routes accept CRON_SECRET via
//     the QUERY STRING (?secret=...). Secrets in URLs end up in access logs,
//     proxy logs, and browser history. Pinned as-is below — do NOT "fix".
//   DEFECT 2 (S-4 family): the cron routes' 500 handler echoes err.message
//     AND the full err.stack into the response body. Pinned as-is.
//   DEFECT 3 (S-2, Phase 6 SEC-03): the Telegram webhook processes requests
//     with NO authentication/secret at all (Telegram's signed-path check is
//     absent). Pinned as-is — the 200s below must turn red when the fix lands.
//
// All check/cleanup/alert internals are mocked (@/lib/cron-logic,
// @/lib/cleanup-logic, @/lib/db-batcher, @/lib/telegram) and global.fetch is
// stubbed to reject — these tests make ZERO real network calls.
// ---------------------------------------------------------------------------

const cronMocks = vi.hoisted(() => ({
  runCronChecks: vi.fn(),
  flushBatches: vi.fn(),
  runCleanup: vi.fn(),
  sendTelegramAlert: vi.fn(),
}));

vi.mock("@/lib/cron-logic", () => ({ runCronChecks: cronMocks.runCronChecks }));
vi.mock("@/lib/db-batcher", () => ({ flushBatches: cronMocks.flushBatches }));
vi.mock("@/lib/cleanup-logic", () => ({ runCleanup: cronMocks.runCleanup }));
vi.mock("@/lib/telegram", () => ({ sendTelegramAlert: cronMocks.sendTelegramAlert }));

import { GET as GET_CRON_CHECK } from "@/app/api/cron/check/route";
import { GET as GET_CRON_CLEANUP } from "@/app/api/cron/cleanup/route";
import { POST as POST_WEBHOOK } from "@/app/api/telegram/webhook/route";

const SECRET = "test-cron-secret-value";

beforeEach(() => {
  delete process.env.CRON_SECRET; // each case sets exactly the env it pins
  resetPrismaMocks();
  for (const fn of [
    cronMocks.runCronChecks,
    cronMocks.flushBatches,
    cronMocks.runCleanup,
    cronMocks.sendTelegramAlert,
  ]) {
    fn.mockReset();
  }
  // Egress tripwire (02-03 pattern): any unstubbed fetch fails loudly.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("UNSTUBBED FETCH — cron/webhook tests must not make real calls");
  }));
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  vi.unstubAllGlobals();
});

describe("GET /api/cron/check", () => {
  it("500 when CRON_SECRET is unset — exact message", async () => {
    const res = await GET_CRON_CHECK(buildRequest({ path: "/api/cron/check" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "CRON_SECRET is not configured in production environment.",
    });
    expect(cronMocks.runCronChecks).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret (query and header forms) — checks never run", async () => {
    process.env.CRON_SECRET = SECRET;

    const viaQuery = await GET_CRON_CHECK(
      buildRequest({ path: "/api/cron/check?secret=wrong-value" }),
    );
    const viaHeader = await GET_CRON_CHECK(
      buildRequest({ path: "/api/cron/check", headers: { authorization: "Bearer wrong-value" } }),
    );

    for (const res of [viaQuery, viaHeader]) {
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "Unauthorized Cron Request" });
    }
    expect(cronMocks.runCronChecks).not.toHaveBeenCalled();
  });

  it("PINNED DEFECT (S-4): the secret is accepted via the QUERY STRING — remediated in Phase 6 (SEC-06)", async () => {
    // Today's behavior, deliberately pinned: ?secret=<correct value> passes.
    // When Phase 6 removes query-string acceptance this test goes RED on
    // purpose and gets updated alongside the fix.
    process.env.CRON_SECRET = SECRET;
    cronMocks.runCronChecks.mockResolvedValue({
      message: "Successfully checked all monitors",
      result: [{ monitorId: 1, status: "UP" }],
    });

    const res = await GET_CRON_CHECK(buildRequest({ path: `/api/cron/check?secret=${SECRET}` }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      message: "Successfully checked all monitors",
      result: [{ monitorId: 1, status: "UP" }],
    });
  });

  it("Bearer header form also accepted — and batches are flushed after checks", async () => {
    process.env.CRON_SECRET = SECRET;
    cronMocks.runCronChecks.mockResolvedValue({ message: "done", result: [] });

    const res = await GET_CRON_CHECK(
      buildRequest({ path: "/api/cron/check", headers: { authorization: `Bearer ${SECRET}` } }),
    );

    expect(res.status).toBe(200);
    expect(cronMocks.runCronChecks).toHaveBeenCalledTimes(1);
    expect(cronMocks.flushBatches).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual({ message: "done", result: [] });
  });

  it("force=true forwards force to runCronChecks; default (absent) forwards false", async () => {
    process.env.CRON_SECRET = SECRET;
    cronMocks.runCronChecks.mockResolvedValue({ message: "done", result: [] });

    const forced = await GET_CRON_CHECK(
      buildRequest({ path: `/api/cron/check?secret=${SECRET}&force=true` }),
    );
    expect(forced.status).toBe(200);
    expect(cronMocks.runCronChecks).toHaveBeenLastCalledWith(true);

    const unforced = await GET_CRON_CHECK(
      buildRequest({ path: `/api/cron/check?secret=${SECRET}` }),
    );
    expect(unforced.status).toBe(200);
    expect(cronMocks.runCronChecks).toHaveBeenLastCalledWith(false);
  });

  it("PINNED DEFECT (S-4 family): the 500 body echoes err.message AND the full stack", async () => {
    // Today's catch handler returns { message, error: err.message,
    // stack: err.stack } — an information-disclosure defect pinned verbatim
    // here. Phase 6 (S-4) removes the echo; this goes red then.
    process.env.CRON_SECRET = SECRET;
    cronMocks.runCronChecks.mockRejectedValue(new Error("db exploded"));

    const res = await GET_CRON_CHECK(
      buildRequest({ path: `/api/cron/check?secret=${SECRET}` }),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      message: "Internal Server Error",
      error: "db exploded",
      stack: expect.any(String),
    });
  });
});

describe("GET /api/cron/cleanup", () => {
  it("500 when CRON_SECRET is unset — same message as the check route", async () => {
    const res = await GET_CRON_CLEANUP(buildRequest({ path: "/api/cron/cleanup" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "CRON_SECRET is not configured in production environment.",
    });
    expect(cronMocks.runCleanup).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret — cleanup never runs", async () => {
    process.env.CRON_SECRET = SECRET;

    const res = await GET_CRON_CLEANUP(
      buildRequest({ path: "/api/cron/cleanup?secret=wrong-value" }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized Cron Request" });
    expect(cronMocks.runCleanup).not.toHaveBeenCalled();
  });

  it("PINNED DEFECT (S-4): query-string secret accepted here too — Phase 6 SEC-06", async () => {
    process.env.CRON_SECRET = SECRET;
    cronMocks.runCleanup.mockResolvedValue({
      success: true,
      message: "Cleanup successful: Deleted 2 old pings and 1 old resolved incidents.",
      deletedPings: 2,
      deletedIncidents: 1,
    });

    const res = await GET_CRON_CLEANUP(
      buildRequest({ path: `/api/cron/cleanup?secret=${SECRET}` }),
    );

    expect(res.status).toBe(200);
    // The runCleanup() return value IS the body — no wrapper key.
    await expect(res.json()).resolves.toEqual({
      success: true,
      message: "Cleanup successful: Deleted 2 old pings and 1 old resolved incidents.",
      deletedPings: 2,
      deletedIncidents: 1,
    });
  });

  it("runCleanup's FAILURE return still yields 200 — the route never inspects success", async () => {
    // runCleanup catches its own errors and returns { success: false, ... };
    // the route spreads that into a 200 body.
    process.env.CRON_SECRET = SECRET;
    cronMocks.runCleanup.mockResolvedValue({
      success: false,
      message: "Failed to run cleanup",
      error: "db exploded",
    });

    const res = await GET_CRON_CLEANUP(
      buildRequest({ path: `/api/cron/cleanup?secret=${SECRET}` }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: false,
      message: "Failed to run cleanup",
      error: "db exploded",
    });
  });
});

describe("POST /api/telegram/webhook", () => {
  it("PINNED DEFECT (S-2): an UNAUTHENTICATED /start deep-link is processed end-to-end — Phase 6 SEC-03 red→green", async () => {
    // No secret, no signature, no auth header — today the webhook trusts the
    // body completely. An attacker POSTing this exact shape links ANY user id
    // to an arbitrary Telegram chat. Deliberately pinned as-is (D-17); the
    // Phase 6 secret check makes this case red.
    const linkedUser = { id: "user-to-link", name: "Telegram User" };
    h.prisma.user.update.mockResolvedValue(linkedUser);
    cronMocks.sendTelegramAlert.mockResolvedValue({ ok: true });

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: {
          message: { chat: { id: 556677 }, text: "/start user-to-link" },
        },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-to-link" },
      data: { telegramChatId: "556677" },
    });
    expect(cronMocks.sendTelegramAlert).toHaveBeenCalledWith(
      "556677",
      expect.stringContaining("Account Connected!"),
    );
    expect(cronMocks.sendTelegramAlert).toHaveBeenCalledWith(
      "556677",
      expect.stringContaining("Telegram User"),
    );
  });

  it("non-/start message text → 200 ok with NO linking and NO alert", async () => {
    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: { message: { chat: { id: 1 }, text: "hello there" } },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.prisma.user.update).not.toHaveBeenCalled();
    expect(cronMocks.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("message without text, and /start with an EMPTY deep-link payload, are both tolerated as 200 ok", async () => {
    const noText = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: { message: { chat: { id: 1 } } },
      }),
    );
    expect(noText.status).toBe(200);
    await expect(noText.json()).resolves.toEqual({ ok: true });

    const emptyDeepLink = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: { message: { chat: { id: 1 }, text: "/start " } }, // no id after the prefix
      }),
    );
    expect(emptyDeepLink.status).toBe(200);
    await expect(emptyDeepLink.json()).resolves.toEqual({ ok: true });

    expect(h.prisma.user.update).not.toHaveBeenCalled();
  });

  it("500 when the prisma update fails — body VERBATIM", async () => {
    h.prisma.user.update.mockRejectedValue(new Error("record not found"));

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: { message: { chat: { id: 556677 }, text: "/start missing-user" } },
      }),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Webhook Handler Failed" });
    expect(cronMocks.sendTelegramAlert).not.toHaveBeenCalled();
  });
});
