import { NextResponse } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { getAuthSession } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";

// ---------------------------------------------------------------------------
// The shared /api/ai/* guard chain (08-10, AI-02) — the ordered checks every
// AI route runs before ANY provider work. Order is load-bearing:
//   1. aiEnabled() false -> 404 BEFORE the body is read (D-21: with the flag
//      off there is no surface to probe — no identity resolution, no
//      limiter, no AI package touch; the lib/ai getters throw if reached).
//   2. getAuthSession() -> 401 without session.user.id (identity BEFORE the
//      limiter — the bucket key needs the authenticated user, and the
//      session guard is what makes per-USER keys unspoofable; Pitfall 8:
//      getIP never enters an AI route).
//   3. per-user Redis bucket via the ONE Lua limiter (D-08) — 429 answers
//      carry the 06 D-06 shape: numeric Retry-After from resetSeconds,
//      conditionally present on the fail-open degraded path.
//   4. input-size cap on the raw body (A4 discretion): exactly-at-cap
//      passes, one char over answers 413 naming the cap. The cap runs AFTER
//      the limiter so oversized bodies still consume a bucket slot.
//
// WEB-PROCESS ONLY by contract (rule 15 — nothing under src/worker may
// import lib/ai; the AI-in-worker remnant-gate leg enforces it).
// ---------------------------------------------------------------------------

/**
 * The AI input cap (A4): the raw request body may be at most this many
 * characters. Pinned at 2,000 — the post-mortem body is two ids (well under
 * the cap) and the 08-07 assistant description is a short natural-language
 * sentence; the cap exists to bound provider cost, not to shape features.
 */
export const AI_INPUT_MAX_CHARS = 2000;

/** The default provider-call bound (A2/A4 discretion): 30 seconds. */
export const AI_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The effective provider-call timeout. AI_TIMEOUT_MS is an OPTIONAL
 * execution-discretion seam (validated: anything non-numeric, zero, or
 * negative falls back to the default) — it lets operators tighten the bound
 * without a code change and lets the handler tests prove the timeout
 * composition without waiting 30 real seconds. It is NOT part of the
 * required D-02 env contract; the default is authoritative.
 */
export function aiTimeoutMs(): number {
  const raw = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : AI_DEFAULT_TIMEOUT_MS;
}

export interface AiGuardsOptions {
  /**
   * Per-feature bucket suffix (D-08): "drafts" -> key ai_drafts_{userId}
   * (~10/h); the 08-07 assistant route reuses this helper with its own
   * bucket. The limiter prefixes rl: itself — never add it here.
   */
  bucket: string;
  limit: number;
  windowMs: number;
}

export type AiGuardsResult =
  | { ok: true; userId: string; body: unknown }
  | { ok: false; response: NextResponse };

/**
 * Runs the ordered guard chain and reads the (capped, parsed) body. On
 * failure the returned response is the route's answer verbatim; on success
 * `userId` is the authenticated identity every downstream scoping decision
 * must use and `body` is the parsed JSON payload.
 */
export async function runAiGuards(
  req: Request,
  opts: AiGuardsOptions,
): Promise<AiGuardsResult> {
  // (1) D-21 flag-off posture: refuse before touching anything else —
  // no body read, no session, no limiter, no AI package evaluation.
  if (!aiEnabled()) {
    return { ok: false, response: apiError(404, "Not Found") };
  }

  // (2) Identity first — the session door every authenticated route uses.
  const session = await getAuthSession();
  if (!session?.user?.id) {
    return { ok: false, response: apiError(401, "Unauthorized") };
  }

  // (3) Per-USER bucket (D-08): the key derives from the authenticated
  // identity only — an address the client does not control.
  const rl = await rateLimit(`ai_${opts.bucket}_${session.user.id}`, {
    limit: opts.limit,
    windowMs: opts.windowMs,
  });
  if (!rl.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Too many AI requests — try again later." },
        {
          status: 429,
          // 06 D-06 shape: numeric Retry-After from the atomic command's
          // resetSeconds; absent on the degraded fail-open path (no window
          // exists to report).
          headers:
            rl.resetSeconds !== undefined
              ? { "Retry-After": String(rl.resetSeconds) }
              : {},
        },
      ),
    };
  }

  // (4) Input-size cap on the RAW body text (A4): exactly at the cap is
  // accepted; one character over is rejected with the documented 413.
  const raw = await req.text();
  if (raw.length > AI_INPUT_MAX_CHARS) {
    return {
      ok: false,
      response: apiError(
        413,
        `Request body too large — AI input is capped at ${AI_INPUT_MAX_CHARS} characters.`,
      ),
    };
  }

  let body: unknown;
  try {
    body = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, response: apiError(400, "Invalid JSON body") };
  }

  return { ok: true, userId: session.user.id, body };
}
