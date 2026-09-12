import { redis } from "@/lib/redis";

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

// Fixed-window counter in ONE atomic Lua script: INCR + EXPIRE-on-first-hit.
// Separate INCR/EXPIRE round-trips can strand a TTL-less counter between the
// two calls and permanently limit a user (Phase 01 IN-01/OBS-04 pin) — the
// whole script executes as a single atomic command server-side.
const WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
`;

redis.defineCommand("rlIncr", { numberOfKeys: 1, lua: WINDOW_LUA });

// defineCommand adds rlIncr at RUNTIME; ioredis 6's TypeScript type does not
// surface custom commands on the client (03-RESEARCH A9 quirk), so the call
// goes through this typed view of the same instance.
const limiterRedis = redis as typeof redis & {
  rlIncr(key: string, windowSeconds: number): Promise<number>;
};

export async function rateLimit(identifier: string, options: RateLimitOptions) {
  // Identifiers already carry the monitors_/register_ bucket (D-04 parity —
  // only the backing store changed, never the key semantics or parameters).
  const key = `rl:${identifier}`;
  const windowSeconds = Math.ceil(options.windowMs / 1000);
  try {
    const count = await limiterRedis.rlIncr(key, windowSeconds);
    return { success: count <= options.limit, remaining: Math.max(0, options.limit - count) };
  } catch (err) {
    // D-01/D-02: fail-open, fast, with the greppable marker — never rethrow,
    // never fall back to an in-memory Map (that would re-import the
    // process-local state this migration deletes).
    console.error("[redis-limiter] DEGRADED fail-open:", (err as Error).message);
    return { success: true, remaining: options.limit - 1 };
  }
}

// Utility to get IP from NextRequest
export function getIP(req: Request) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0] ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}
