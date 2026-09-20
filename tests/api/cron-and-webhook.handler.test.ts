import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
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
//   DEFECT 3 (S-2, Phase 6 SEC-03): RESOLVED (06-03) — the webhook half below
//     now PINS the enforced contract: X-Telegram-Bot-Api-Secret-Token
//     constant-time authentication (SEC-03/D-20), a per-IP limiter ahead of
//     any DB write (D-21), and HTML-escaped user.name in the confirmation
//     (D-24). The old red marker (unauthenticated /start processed end-to-end)
//     flipped green WITH the fix in the same change (Pitfall 7).
//
// All check/cleanup/alert internals are mocked (@/lib/cron-logic,
// @/lib/cleanup-logic, @/lib/db-batcher, @/lib/telegram) and global.fetch is
// stubbed to reject — these tests make ZERO real network calls. The webhook's
// per-IP limiter (D-21) runs against the REAL docker test Redis like every
// limiter suite (03-01 pattern), with a per-case rl:* flush via the admin
// client below.
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

/** The pinned webhook secret value (SEC-03/D-20) — Telegram charset, 25 chars. */
const WEBHOOK_SECRET = "test-webhook-secret-value";

/** Dedicated admin client for the per-case rl:* flush (separate from the limiter's). */
const redisAdmin = new Redis(process.env.REDIS_URL!);

/** Flushes limiter keys on the test Redis — the fresh-state reset per case. */
async function flushLimiterKeys(): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await redisAdmin.scan(cursor, "MATCH", "rl:*", "COUNT", 100);
    if (batch.length > 0) {
      await redisAdmin.del(...batch);
    }
    cursor = next;
  } while (cursor !== "0");
}

afterAll(async () => {
  await redisAdmin.quit();
  // Drop the limiter singleton's socket so the worker process can exit cleanly.
  const globalForRedis = global as unknown as { redis?: Redis };
  globalForRedis.redis?.disconnect();
  delete globalForRedis.redis;
});

beforeEach(async () => {
  delete process.env.CRON_SECRET; // each case sets exactly the env it pins
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  await flushLimiterKeys(); // webhook limiter state lives in Redis — flush rl:* per case
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
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
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
  /** The enforced deep-link payload shape used by the auth cases below. */
  const startMessage = (userId: string) => ({
    message: { chat: { id: 556677 }, text: `/start ${userId}` },
  });

  /** Request headers carrying the CORRECT secret token. */
  const withSecret = (headers: Record<string, string> = {}) => ({
    "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    ...headers,
  });

  it("FLIPPED (was the S-2 red marker): a POST WITHOUT the secret header → 401, the chat-binding write NEVER runs (SEC-03/D-20)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: startMessage("user-to-link"),
      }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.prisma.user.update).not.toHaveBeenCalled();
    expect(cronMocks.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("wrong-VALUE header (same length) → the identical 401 (constant-time compare path)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: startMessage("user-to-link"),
        headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret-WRONG" },
      }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.prisma.user.update).not.toHaveBeenCalled();
    expect(cronMocks.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("wrong-LENGTH header → 401, NOT a 500 (the timingSafeEqual length guard — Pitfall 4)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: startMessage("user-to-link"),
        headers: { "x-telegram-bot-api-secret-token": "short" },
      }),
    );

    // An unguarded timingSafeEqual would RangeError → the catch's 500. The
    // length comparison MUST precede the constant-time call.
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(h.prisma.user.update).not.toHaveBeenCalled();
  });

  it("CORRECT header → the deep-link binding runs end-to-end; the confirmation is byte-identical for a plain name (D-24)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const linkedUser = { id: "user-to-link", name: "Telegram User" };
    h.prisma.user.update.mockResolvedValue(linkedUser);
    cronMocks.sendTelegramAlert.mockResolvedValue({ ok: true });

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: startMessage("user-to-link"),
        headers: withSecret(),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-to-link" },
      data: { telegramChatId: "556677" },
    });
    // Byte-identical plain-name pin — characters outside the escape set
    // render unchanged (D-24 content escaping, not redesign).
    expect(cronMocks.sendTelegramAlert).toHaveBeenCalledWith(
      "556677",
      "🎉 <b>Account Connected!</b>\n\nHello <b>Telegram User</b>, your Telegram account is now successfully linked to SpiderNode.",
    );
  });

  it("D-24: a user.name containing & < > is HTML-escaped in the confirmation message", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    h.prisma.user.update.mockResolvedValue({ id: "user-to-link", name: "Alfa & <Beta>" });
    cronMocks.sendTelegramAlert.mockResolvedValue({ ok: true });

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: startMessage("user-to-link"),
        headers: withSecret(),
      }),
    );

    expect(res.status).toBe(200);
    expect(cronMocks.sendTelegramAlert).toHaveBeenCalledWith(
      "556677",
      "🎉 <b>Account Connected!</b>\n\nHello <b>Alfa &amp; &lt;Beta&gt;</b>, your Telegram account is now successfully linked to SpiderNode.",
    );
  });

  it("TELEGRAM_WEBHOOK_SECRET unset → loud 500 config error — the body is NEVER processed (D-20 no-fail-open)", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await POST_WEBHOOK(
        buildRequest({
          path: "/api/telegram/webhook",
          method: "POST",
          body: startMessage("user-to-link"),
          headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
        }),
      );

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Webhook Handler Failed" });
      expect(h.prisma.user.update).not.toHaveBeenCalled();
      expect(cronMocks.sendTelegramAlert).not.toHaveBeenCalled();
      // LOUD: the config error is named in the log, never swallowed.
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0]?.[1])).toContain("TELEGRAM_WEBHOOK_SECRET");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("D-21: over the 30/min per-IP limit → 429 BEFORE any DB write", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // A dedicated IP keeps this case self-contained. The filler requests
    // carry NO secret — every one must 401 (and still count against the
    // window: the limiter admission sits above the secret check).
    const ip = "198.51.100.77";
    for (let i = 1; i <= 30; i++) {
      const res = await POST_WEBHOOK(
        buildRequest({ path: "/api/telegram/webhook", method: "POST", body: startMessage("user-to-link"), ip }),
      );
      expect(res.status).toBe(401);
    }

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: startMessage("user-to-link"),
        headers: withSecret(),
        ip,
      }),
    );

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "Too many requests. Please try again later." });
    expect(h.prisma.user.update).not.toHaveBeenCalled();
    expect(cronMocks.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("non-/start message text → 200 ok with NO linking and NO alert", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: { message: { chat: { id: 1 }, text: "hello there" } },
        headers: withSecret(),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.prisma.user.update).not.toHaveBeenCalled();
    expect(cronMocks.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("message without text, and /start with an EMPTY deep-link payload, are both tolerated as 200 ok", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const noText = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: { message: { chat: { id: 1 } } },
        headers: withSecret(),
      }),
    );
    expect(noText.status).toBe(200);
    await expect(noText.json()).resolves.toEqual({ ok: true });

    const emptyDeepLink = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: { message: { chat: { id: 1 }, text: "/start " } }, // no id after the prefix
        headers: withSecret(),
      }),
    );
    expect(emptyDeepLink.status).toBe(200);
    await expect(emptyDeepLink.json()).resolves.toEqual({ ok: true });

    expect(h.prisma.user.update).not.toHaveBeenCalled();
  });

  it("500 when the prisma update fails — body VERBATIM", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    h.prisma.user.update.mockRejectedValue(new Error("record not found"));

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: { message: { chat: { id: 556677 }, text: "/start missing-user" } },
        headers: withSecret(),
      }),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Webhook Handler Failed" });
    expect(cronMocks.sendTelegramAlert).not.toHaveBeenCalled();
  });
});
