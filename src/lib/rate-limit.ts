import { redis } from "@/lib/redis";

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  /**
   * Whole seconds until the fixed window resets (the Retry-After basis,
   * D-06) — ceil(PTTL/1000) from the SAME atomic command, 0 when the ttl is
   * negative/absent. Absent on the fail-open degraded path (Redis was never
   * reached, so there is no window to report).
   */
  resetSeconds?: number;
}

// Fixed-window counter in ONE atomic Lua script: INCR + EXPIRE-on-first-hit,
// returning the count AND the key's PTTL so callers get everything (admission
// + Retry-After) from one atomic round trip — a second PTTL call would break
// the Phase-01 IN-01 single-command pin and add a round trip. Separate
// INCR/EXPIRE round-trips can strand a TTL-less counter between the two
// calls and permanently limit a user (Phase 01 IN-01/OBS-04 pin) — the
// whole script executes as a single atomic command server-side.
const WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { current, ttl }
`;

redis.defineCommand("rlIncr", { numberOfKeys: 1, lua: WINDOW_LUA });

// defineCommand adds rlIncr at RUNTIME; ioredis 6's TypeScript type does not
// surface custom commands on the client (03-RESEARCH A9 quirk), so the call
// goes through this typed view of the same instance.
const limiterRedis = redis as typeof redis & {
  rlIncr(key: string, windowSeconds: number): Promise<[number, number]>;
};

export async function rateLimit(
  identifier: string,
  options: RateLimitOptions
): Promise<RateLimitResult> {
  // Identifiers already carry the monitors_/register_ bucket (D-04 parity —
  // only the backing store changed, never the key semantics or parameters).
  const key = `rl:${identifier}`;
  const windowSeconds = Math.ceil(options.windowMs / 1000);
  try {
    const [count, ttl] = await limiterRedis.rlIncr(key, windowSeconds);
    return {
      success: count <= options.limit,
      remaining: Math.max(0, options.limit - count),
      resetSeconds: ttl > 0 ? Math.ceil(ttl / 1000) : 0,
    };
  } catch (err) {
    // D-01/D-02: fail-open, fast, with the greppable marker — never rethrow,
    // never fall back to an in-memory Map (that would re-import the
    // process-local state this migration deletes).
    console.error("[redis-limiter] DEGRADED fail-open:", (err as Error).message);
    return { success: true, remaining: options.limit - 1 };
  }
}

// Utility to derive the limiter's client key (WR-06): the key must be an
// address the CLIENT does not control, or the fixed windows are bypassable
// by header rotation and the Redis keyspace — pinned `noeviction` with a
// 512 MB ceiling (runbook §3b) — grows without bound under spoofing.
//
// What the runtime actually guarantees (verified against next@16's server):
// Next stamps `x-forwarded-for` from the socket's remoteAddress ONLY when
// the header is absent, and never sets `x-real-ip`. So on a direct
// connection the header IS the socket peer (the client sent nothing); a
// client-supplied value, however, passes through verbatim and is not
// distinguishable from the stamped one inside a route handler.
//
// Resolution (minimal, behavior-compatible — D-04 key semantics preserved
// for every legitimate client):
//   - TRUST_PROXY=true: a sanitizing proxy fronts the app and appends to
//     the forwarding headers, so the RIGHTMOST x-forwarded-for entry (the
//     one the proxy added) is the real client address; leftmost entries are
//     client-supplied and spoofable.
//   - otherwise (today's direct topology): first entry as before — for
//     direct clients that is the Next-stamped socket peer, so keys are
//     unchanged, including the runbook's `127.0.0.1` VPS-local bucket.
//   - any extracted value must still parse as an IP literal: a present-but-
//     unparseable value collapses into the single shared `unknown` bucket,
//     so arbitrary strings can never enter a Redis key and the spoofed
//     keyspace is bounded no matter what is sent.
// Residual risk (accepted, deferred to Phase 6's S-series trust-proxy
// work): a direct-connection attacker rotating VALID IP literals still
// mints fresh counters; closing that requires the proxy-fronted
// deployment + TRUST_PROXY design, not a code tweak here.
const IP_LIKE_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IP_LIKE_V6 = /^[0-9a-f:]+(?:\.[0-9a-f:]+)*$/i;

function normalizeClientAddress(value: string): string | null {
  const candidate = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!candidate || candidate.length > 45) return null;
  const v4 = IP_LIKE_V4.exec(candidate);
  if (v4) {
    return v4.slice(1).every((octet) => Number(octet) <= 255) ? candidate : null;
  }
  // IPv6 (including ::ffff: mapped-IPv4): hex/colon shape with one colon.
  if (candidate.includes(":") && IP_LIKE_V6.test(candidate)) return candidate;
  return null;
}

// Utility to get the limiter's client address from a Request.
export function getIP(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for");
  let candidate: string | null = null;
  if (forwarded) {
    const entries = forwarded.split(",");
    candidate =
      process.env.TRUST_PROXY === "true"
        ? entries[entries.length - 1]
        : entries[0];
  }
  if (!candidate) candidate = req.headers.get("x-real-ip");
  // No forwarding headers at all keeps the historical loopback fallback —
  // the test harness's header-less requests land here, and on the VPS the
  // Next server always stamps the header for direct local clients anyway.
  if (candidate === null) return "127.0.0.1";
  return normalizeClientAddress(candidate) ?? "unknown";
}
