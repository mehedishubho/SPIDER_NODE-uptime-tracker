import Redis from "ioredis";

// ioredis singleton for the web process (Phase 3: rate limiter only).
// Shape mirrors src/lib/prisma.ts (globalThis cache for HMR survival) and the
// throw-early env validation of src/redux/api/baseApi.ts (D-21).
//
// Fail-open profile (D-03): a dead Redis must cost each request milliseconds,
// never stall it — commandTimeout caps any single command at 200ms and
// maxRetriesPerRequest: 1 stops the default 20-retry reconnect backoff from
// holding requests hostage. NO keyPrefix anywhere: BullMQ (Phase 4) prefixes
// its own keys and documents prefix-shared connections as incompatible.
const globalForRedis = global as unknown as { redis?: Redis };

const connectionString = process.env.REDIS_URL;
if (!connectionString) {
  throw new Error("Environment variable REDIS_URL is not set");
}

export const redis =
  globalForRedis.redis ||
  (() => {
    const client = new Redis(connectionString, {
      commandTimeout: 200,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
    });
    // REQUIRED (Pitfall 6): ioredis emits "error" on connection loss and an
    // unhandled "error" event throws — crashing the process. Fail-open needs
    // this listener so a dead Redis only logs. Attached INSIDE the factory so
    // module re-evaluations (vitest resetModules, dev HMR) that hit the
    // globalThis cache never stack duplicate listeners. Never log the URL
    // itself (secrets rule).
    client.on("error", (err) => {
      console.error("[redis] connection error (limiter will fail-open):", err.message);
    });
    return client;
  })();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
