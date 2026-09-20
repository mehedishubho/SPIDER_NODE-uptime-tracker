import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { sendTelegramAlert } from "@/lib/telegram";
import { NextResponse } from "next/server";
import { rateLimit, getIP } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";

// ---------------------------------------------------------------------------
// Telegram webhook (SEC-03 / S-2 closure, 06-03).
//
// Admission ladder, in order:
//   1. Per-IP rate limit (D-21) — 30 req/min, generous for Telegram's
//      server-side retries, AHEAD of any DB write.
//   2. Secret-token authentication (D-20): Telegram sends
//      X-Telegram-Bot-Api-Secret-Token on every request when the webhook was
//      registered with setWebhook's secret_token. Constant-time compare
//      behind a length guard; an unset TELEGRAM_WEBHOOK_SECRET is a LOUD
//      config error (500), never a fail-open accept.
//   3. Payload shape-checking + /start deep-link handling, with user.name
//      HTML-escaped before it enters the parse_mode HTML confirmation
//      (D-24 — characters outside the escape set render byte-identically).
//
// The one-time setWebhook registration that makes Telegram send the header is
// a runbook + release step (06-04) — enforcement is code-complete here but
// cutover-ordered.
// ---------------------------------------------------------------------------

/** D-20: constant-time secret compare. Throws (loud) when the env is unset — never accepts. */
function secretMatches(provided: string | null): boolean {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected) {
        // Config error — a missing secret must never degrade into an accept
        // (Pitfall 4). The throw surfaces through the handler's catch as a
        // logged 500.
        throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
    }
    // Length first: timingSafeEqual throws RangeError on unequal lengths — a
    // 500 on the very spoofed request this check exists to refuse. Length is
    // not secret-sensitive here: the 401 response is byte-identical either way.
    if (!provided || provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/** D-24 (IN-04 discipline): escape the HTML-significant trio for parse_mode HTML. */
function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function POST(req: Request) {
    try {
        // 1. Per-IP limiter (D-21) — ahead of any DB write, register-route pattern.
        const ip = getIP(req);
        const { success } = await rateLimit(`telegram-webhook_${ip}`, { limit: 30, windowMs: 60000 });
        if (!success) {
            return apiError(429, "Too many requests. Please try again later.");
        }

        // 2. Secret-token authentication (D-20/SEC-03).
        if (!secretMatches(req.headers.get("x-telegram-bot-api-secret-token"))) {
            return apiError(401, "Unauthorized");
        }

        const body = await req.json()

        // if message is came check it

        if (body.message && body.message.text) {
            const chatId = body.message.chat.id.toString();
            const text = body.message.text;


            if (text.startsWith('/start ')) {
                const userId = text.split(' ')[1];


                if (userId) {
                    const user = await prisma.user.update({
                        where: { id: userId },
                        data: { telegramChatId: chatId }
                    })

                    // Send the Telegram confirmation message — user.name is
                    // HTML-escaped before entering the parse_mode HTML body
                    // (D-24); plain names render byte-identically.
                    await sendTelegramAlert(
                        chatId,
                        `🎉 <b>Account Connected!</b>\n\nHello <b>${escapeHtml(user.name || 'User')
                        }</b>, your Telegram account is now successfully linked to SpiderNode.`
                    );
                }
            }
        }
        return NextResponse.json({ ok: true }, { status: 200 });

    } catch (error) {
        console.error('Telegram Webhook Error:', error);
        return apiError(500, 'Webhook Handler Failed');
    }
}
