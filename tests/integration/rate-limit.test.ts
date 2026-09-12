import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// D-20 limiter proof suite: src/lib/rate-limit.ts (Phase 3, RDS-02).
//
// Pins the five success-criterion-1 behaviors of the Redis-backed limiter:
//   1. window SURVIVES client re-creation (simulated process restart)
//   2. limit enforced + WINDOW expiry resets the counter
//   3. FAIL-OPEN on unreachable Redis — fast, with the greppable DEGRADED marker
//   4. Lua ATOMICITY under concurrent hammering (no lost/double increments)
//   5. no TTL-LESS keys (every rl:* key carries a TTL)
//
// The Redis is the real docker test instance (localhost:6390 via REDIS_URL,
// wired by vitest.config.ts) — ioredis is NEVER mocked here: the fail-open
// profile (commandTimeout / maxRetriesPerRequest / connectTimeout) is itself
// under test against a genuinely dead port. Identifiers are unique per case
// (crypto.randomUUID() suffix) so cases cannot bleed into each other.
//
// The @/lib/redis singleton caches itself on globalThis in non-production
// NODE_ENV — the restart simulation (case 1) must delete that cache key
// BEFORE vi.resetModules() + dynamic import, or the re-import silently
// reuses the old client and the restart is not actually simulated.
// ---------------------------------------------------------------------------

/** A dead local port that nothing listens on (never 6390/6398 — the test stack). */
const DEAD_PORT_URL = "redis://localhost:64444";

/** Dedicated admin client for SCAN/TTL inspection — separate from the limiter's. */
let admin: Redis;

/** The globalThis cache key used by the @/lib/redis singleton. */
const globalForRedis = global as unknown as { redis?: Redis };

/**
 * Disconnects the cached singleton (if any) and clears the cache key — the
 * process-restart simulation. Also keeps stray reconnect loops from holding
 * the worker open after the file finishes.
 */
function disposeSingleton(): void {
  if (globalForRedis.redis) {
    globalForRedis.redis.disconnect();
    delete globalForRedis.redis;
  }
}

/** Re-imports the limiter against the freshly reset module registry. */
async function freshRateLimit() {
  return import("@/lib/rate-limit");
}

beforeAll(() => {
  admin = new Redis(process.env.REDIS_URL!);
});

afterAll(async () => {
  disposeSingleton();
  await admin.quit();
});

beforeEach(() => {
  vi.resetModules(); // re-evaluate @/lib/rate-limit on the next dynamic import
});

describe("rate-limit — Redis-backed limiter (D-20, RDS-02)", () => {
  it(
    "1. window SURVIVES client re-creation (simulated process restart): the counter lives in Redis, not the module",
    async () => {
      const identifier = `monitors_survives_${crypto.randomUUID()}`;
      const options = { limit: 3, windowMs: 60_000 };

      const rl = await freshRateLimit();
      const first = await rl.rateLimit(identifier, options);
      const second = await rl.rateLimit(identifier, options);
      expect(first).toEqual({ success: true, remaining: 2 });
      expect(second).toEqual({ success: true, remaining: 1 });

      // Simulate a process restart: drop the singleton (socket + cache) and
      // re-import the module tree from scratch. A Map-based limiter forgets
      // everything here; a Redis-backed one must not.
      disposeSingleton();
      vi.resetModules();
      const rlRestarted = await freshRateLimit();

      const third = await rlRestarted.rateLimit(identifier, options);
      expect(third.success).toBe(true); // 3 <= 3 — still the same window
      expect(third.remaining).toBe(0); // counter survived: 2 prior hits counted

      const fourth = await rlRestarted.rateLimit(identifier, options);
      expect(fourth.success).toBe(false); // 4 > 3
      expect(fourth.remaining).toBe(0);
    },
    15_000
  );

  it(
    "2. limit enforced + WINDOW expiry resets: the (limit+1)th in-window hit is rejected, a post-window hit starts fresh",
    async () => {
      const identifier = `register_window_${crypto.randomUUID()}`;
      const options = { limit: 3, windowMs: 250 };

      const rl = await freshRateLimit();
      for (let i = 1; i <= options.limit; i++) {
        await rl.rateLimit(identifier, options);
      }

      // The (limit+1)th consecutive hit INSIDE the window is rejected.
      const blocked = await rl.rateLimit(identifier, options);
      expect(blocked.success).toBe(false);
      expect(blocked.remaining).toBe(0);

      // Past the window (Redis TTL granularity: ceil(250ms) = 1s; wait past
      // it with margin) the same identifier succeeds with a fresh count.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const fresh = await rl.rateLimit(identifier, options);
      expect(fresh.success).toBe(true);
      expect(fresh.remaining).toBe(options.limit - 1); // count restarted at 1
    },
    15_000
  );

  it(
    "3. FAIL-OPEN on unreachable Redis: resolves (never rejects) to success in under ~1s and logs the DEGRADED marker",
    async () => {
      const identifier = `monitors_failopen_${crypto.randomUUID()}`;
      const options = { limit: 5, windowMs: 60_000 };

      // Keep the connection-error noise out of the run while still capturing
      // calls — the DEGRADED marker is the assertion target.
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const originalUrl = process.env.REDIS_URL;
      try {
        disposeSingleton(); // a cached 6390 client would mask the outage
        vi.resetModules();
        process.env.REDIS_URL = DEAD_PORT_URL;
        const rlDead = await freshRateLimit();

        const start = Date.now();
        // Must RESOLVE — the limiter never rethrows (D-01).
        const result = await rlDead.rateLimit(identifier, options);
        const elapsed = Date.now() - start;

        expect(result).toEqual({ success: true, remaining: options.limit - 1 });
        expect(elapsed).toBeLessThan(1_000); // D-03: fast degrade, not seconds
        expect(
          errSpy.mock.calls.some((args) => args.some((a) => String(a).includes("DEGRADED")))
        ).toBe(true);
      } finally {
        disposeSingleton(); // drop the dead-port client + its reconnect loop
        process.env.REDIS_URL = originalUrl;
        errSpy.mockRestore();
      }
    },
    15_000
  );

  it(
    "4. Lua ATOMICITY under concurrent hammering: 50 concurrent hits with limit 20 admit exactly 20 and reject 30",
    async () => {
      const identifier = `monitors_atomicity_${crypto.randomUUID()}`;
      const options = { limit: 20, windowMs: 60_000 };

      const rl = await freshRateLimit();
      const results = await Promise.all(
        Array.from({ length: 50 }, () => rl.rateLimit(identifier, options))
      );

      const admitted = results.filter((r) => r.success).length;
      const rejected = results.filter((r) => !r.success).length;
      expect(admitted).toBe(20); // no lost increments
      expect(rejected).toBe(30); // no double-counted increments
      expect(results.filter((r) => !r.success).every((r) => r.remaining === 0)).toBe(true);
    },
    15_000
  );

  it(
    "5. no TTL-LESS keys: after hammering, every rl:* key in the test Redis reports TTL > 0",
    async () => {
      const identifier = `monitors_ttl_${crypto.randomUUID()}`;

      const rl = await freshRateLimit();
      await Promise.all(
        Array.from({ length: 5 }, () => rl.rateLimit(identifier, { limit: 20, windowMs: 60_000 }))
      );

      // Enumerate via SCAN (never KEYS — O(N) blocking on the whole keyspace).
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await admin.scan(cursor, "MATCH", "rl:*", "COUNT", 100);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");

      // The hammering above must have produced limiter keys in Redis at all…
      expect(keys.length).toBeGreaterThan(0);
      // …and every one of them must carry a TTL (INCR + EXPIRE in ONE Lua
      // script — a stranded TTL-less counter would permanently limit a user).
      for (const key of keys) {
        expect(await admin.ttl(key)).toBeGreaterThan(0);
      }
    },
    15_000
  );
});
