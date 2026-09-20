import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit, getIP } from "@/lib/rate-limit";
import { generatePasswordResetToken } from "@/lib/tokens";
import { renderPasswordResetEmail } from "@/lib/email/render";
import { enqueueTransactionalEmail } from "@/lib/email/enqueue";
import { webQueueProducer } from "@/lib/queue-producer";
import { apiError } from "@/lib/api-error";

export async function POST(req: Request) {
  try {
    // 06-02 (D-29): bounded pre-flight liveness probe — 503 fast when Redis
    // is unreachable, before the limiter/token writes (register parity).
    try {
      await webQueueProducer().ping();
    } catch {
      return apiError(503, "Service temporarily unavailable — try again shortly");
    }

    const ip = getIP(req);
    // 06-02 (D-21): 5/hour per-IP limiter, register parity — ABOVE the body
    // parse so even malformed probes burn the budget (reset mails are a
    // spam/abuse vector an unauthenticated caller can trigger).
    const { success, remaining } = await rateLimit(`forgot_${ip}`, { limit: 5, windowMs: 3600000 });
    if (!success) {
      return NextResponse.json(
        { error: "Too many password reset requests. Please try again later." },
        { status: 429, headers: { "X-RateLimit-Remaining": remaining.toString() } }
      );
    }

    const body = await req.json();
    const { email } = body;

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    if (!existingUser) {
      // Return 200 even if user doesn't exist to prevent email enumeration attacks
      return NextResponse.json({ success: "Reset email sent!" }, { status: 200 });
    }

    // 06-02 (D-07 render-at-enqueue): render here, transport in the worker.
    // An enqueue rejection AFTER the token write is acceptable: re-requesting
    // forgot-password is idempotent and enqueues a fresh email once Redis
    // returns — still surfaced as a loud 503, never a silent no-op.
    const passwordResetToken = await generatePasswordResetToken(existingUser.email);
    const emailPayload = renderPasswordResetEmail(passwordResetToken.email, passwordResetToken.token);
    try {
      await enqueueTransactionalEmail(emailPayload);
    } catch (error) {
      console.error("Forgot-password email enqueue error:", error);
      return apiError(503, "Service temporarily unavailable — try again shortly");
    }

    return NextResponse.json({ success: "Reset email sent!" }, { status: 200 });

  } catch (error) {
    console.error("Forgot password error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
