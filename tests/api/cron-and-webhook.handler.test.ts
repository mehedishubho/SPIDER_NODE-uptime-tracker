import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import "./_harness";
import { buildRequest, dbLog, dbState, h, resetDbMocks } from "./_harness";

// ---------------------------------------------------------------------------
// Characterization suite: the Telegram webhook (D-17 DEFECT 3 half). The
// cron-route half of this file (the S-4 pinned defects: query-string secret
// acceptance, stack-echo 500s, the CRON_SECRET env contract) was DELETED at
// the 06-05 deletion release together with the routes themselves — the S-4
// surface no longer exists to pin. Every deleted pin is mapped to its
// successor guarantee in 06-PIN-INVENTORY.md: the deleted surface itself is
// the guarantee (gate-enforced absence via the extended check-cron-remnants
// gate + production 404s), and the worker owns checking.
//
// The webhook half below pins the enforced contract (rewritten 06-03):
// X-Telegram-Bot-Api-Secret-Token constant-time authentication (SEC-03/D-20),
// a per-IP limiter ahead of any DB write (D-21), and HTML-escaped user.name
// in the confirmation (D-24).
//
// Alert internals are mocked (@/lib/telegram) and global.fetch is stubbed to
// reject — these tests make ZERO real network calls. The webhook's per-IP
// limiter (D-21) runs against the REAL docker test Redis like every limiter
// suite (03-01 pattern), with a per-case rl:* flush via the admin client
// below.
// ---------------------------------------------------------------------------

const webhookMocks = vi.hoisted(() => ({
  sendTelegramAlert: vi.fn(),
}));

vi.mock("@/lib/telegram", () => ({ sendTelegramAlert: webhookMocks.sendTelegramAlert }));

import { POST as POST_WEBHOOK } from "@/app/api/telegram/webhook/route";

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
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  await flushLimiterKeys(); // webhook limiter state lives in Redis — flush rl:* per case
  resetDbMocks();
  webhookMocks.sendTelegramAlert.mockReset();
  // Egress tripwire (02-03 pattern): any unstubbed fetch fails loudly.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("UNSTUBBED FETCH — webhook tests must not make real calls");
  }));
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  vi.unstubAllGlobals();
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
    expect(h.db.update).not.toHaveBeenCalled();
    expect(webhookMocks.sendTelegramAlert).not.toHaveBeenCalled();
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
    expect(h.db.update).not.toHaveBeenCalled();
    expect(webhookMocks.sendTelegramAlert).not.toHaveBeenCalled();
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
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("CORRECT header → the deep-link binding runs end-to-end; the confirmation is byte-identical for a plain name (D-24)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const linkedUser = { id: "user-to-link", name: "Telegram User" };
    dbState.results = [[linkedUser]];
    webhookMocks.sendTelegramAlert.mockResolvedValue({ ok: true });

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
    const updateEntry = dbLog.find((entry) => entry.op === "update");
    expect(updateEntry).toBeDefined();
    const [set] = updateEntry!.calls.find((call) => call.method === "set")!.args as [
      Record<string, unknown>,
    ];
    // 07-10 (WR-01): the deep-link binding's UPDATE set carries updatedAt.
    expect(set).toEqual({ telegramChatId: "556677", updatedAt: expect.any(String) });
    // Byte-identical plain-name pin — characters outside the escape set
    // render unchanged (D-24 content escaping, not redesign).
    expect(webhookMocks.sendTelegramAlert).toHaveBeenCalledWith(
      "556677",
      "🎉 <b>Account Connected!</b>\n\nHello <b>Telegram User</b>, your Telegram account is now successfully linked to SpiderNode.",
    );
  });

  it("D-24: a user.name containing & < > is HTML-escaped in the confirmation message", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    dbState.results = [[{ id: "user-to-link", name: "Alfa & <Beta>" }]];
    webhookMocks.sendTelegramAlert.mockResolvedValue({ ok: true });

    const res = await POST_WEBHOOK(
      buildRequest({
        path: "/api/telegram/webhook",
        method: "POST",
        body: startMessage("user-to-link"),
        headers: withSecret(),
      }),
    );

    expect(res.status).toBe(200);
    expect(webhookMocks.sendTelegramAlert).toHaveBeenCalledWith(
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
      expect(h.db.update).not.toHaveBeenCalled();
      expect(webhookMocks.sendTelegramAlert).not.toHaveBeenCalled();
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
    expect(h.db.update).not.toHaveBeenCalled();
    expect(webhookMocks.sendTelegramAlert).not.toHaveBeenCalled();
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
    expect(h.db.update).not.toHaveBeenCalled();
    expect(webhookMocks.sendTelegramAlert).not.toHaveBeenCalled();
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

    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("500 when the chat-binding write fails — body VERBATIM", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    (h.db.update as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("record not found");
    });

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
    expect(webhookMocks.sendTelegramAlert).not.toHaveBeenCalled();
  });
});
