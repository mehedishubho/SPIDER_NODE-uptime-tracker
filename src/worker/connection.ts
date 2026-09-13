import IORedis from "ioredis";

// ---------------------------------------------------------------------------
// BullMQ-side Redis connection factory (worker-only — deliberately NOT the
// web client's fail-open profile in src/lib/redis.ts).
//
// BullMQ Worker/QueueEvents issue BLOCKING commands: maxRetriesPerRequest
// MUST be null or a blocking command can never outlive the retry budget
// (BullMQ's own documented requirement). enableReadyCheck stays on so a
// silent half-open connection surfaces as an error instead of a hang.
//
// The factory returns a NEW client per call — BullMQ consumes TWO dedicated
// connections (queue commands + blocking) by design, both from here. The
// error listener is attached INSIDE the factory so module re-evaluations
// (vitest resetModules, HMR) never stack duplicate listeners, and the URL
// itself is never logged (secrets rule — err.message only).
// ---------------------------------------------------------------------------

export function workerConnection(): IORedis {
  const connectionString = process.env.REDIS_URL;
  if (!connectionString) {
    throw new Error("Environment variable REDIS_URL is not set");
  }
  const client = new IORedis(connectionString, {
    maxRetriesPerRequest: null, // REQUIRED for BullMQ Worker/QueueEvents
    enableReadyCheck: true,
  });
  client.on("error", (err) => {
    console.error("[worker-redis] connection error:", err.message);
  });
  return client;
}
