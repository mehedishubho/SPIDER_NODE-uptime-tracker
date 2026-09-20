import IORedis from "ioredis";
import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@/worker/queues";

// ---------------------------------------------------------------------------
// The WEB process's bounded BullMQ producer (06-01, API-02 / Pitfall 1).
//
// Deliberately NOT the worker connection profile: maxRetriesPerRequest null
// is only required for Worker/QueueEvents BLOCKING connections — for Queue
// producers used from request handlers the documented producer profile is a
// BOUNDED retry budget so an unreachable Redis makes add() reject fast
// instead of hanging the HTTP request (docs.bullmq.io/guide/connections).
// Routes map that rejection to a loud 503, never a silent no-op.
//
// ONE globalThis-cached ioredis connection shared by both Queue instances
// (§25 web budget: this producer + the limiter's client = 2 Redis
// connections). Queue TOPOLOGY constants come from @/worker/queues's pure
// exports only — never workerConnection()/workerQueues() (the null-retry
// hang class this module exists to avoid).
// ---------------------------------------------------------------------------

export interface WebQueueProducerSet {
  /** The checks lane (manual checks enqueue here at priority 1). */
  checks: Queue;
  /** The email lane (register/forgot-password render-at-enqueue jobs). */
  email: Queue;
  /** The one shared bounded producer connection. */
  connection: IORedis;
  /** Bounded connection liveness probe for route pre-flight (06-02). */
  ping(): Promise<string>;
  /** Closes both queues, then the connection — idempotent. */
  close(): Promise<void>;
}

const globalForProducer = global as unknown as {
  webQueueProducer?: WebQueueProducerSet;
};

export function webQueueProducer(): WebQueueProducerSet {
  if (!globalForProducer.webQueueProducer) {
    const connectionString = process.env.REDIS_URL;
    if (!connectionString) {
      throw new Error("Environment variable REDIS_URL is not set");
    }
    // Producer profile (API-02): bounded retries + short connect/command
    // timeouts — add() rejects in bounded time when Redis is unreachable.
    const connection = new IORedis(connectionString, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      commandTimeout: 1000,
      enableReadyCheck: true,
    });
    // Attached INSIDE the factory so module re-evaluations (vitest
    // resetModules, dev HMR) hitting the globalThis cache never stack
    // duplicate listeners (03-01 precedent). Never log the URL itself.
    connection.on("error", (err) => {
      console.error("[web-queue-producer] connection error:", err.message);
    });
    const checks = new Queue(QUEUE_NAMES.checks, { connection });
    const email = new Queue(QUEUE_NAMES.email, { connection });
    globalForProducer.webQueueProducer = {
      checks,
      email,
      connection,
      ping: () => connection.ping(),
      async close(): Promise<void> {
        // BullMQ quits a passed-in client on close() (it does not track
        // shared ownership), so every close is settled defensively and the
        // connection quit stays idempotent — queues first, then the wire
        // (createWorkerQueues teardown order).
        await Promise.allSettled([checks.close(), email.close()]);
        await connection.quit().catch(() => {
          /* already ended by a queue close — shutdown stays idempotent */
        });
      },
    };
  }
  return globalForProducer.webQueueProducer;
}

/** Drops the cached set (vitest resetModules discipline — mirrors disposeWorkerQueues). */
export function disposeWebQueueProducer(): void {
  const set = globalForProducer.webQueueProducer;
  if (set) {
    void set.close();
    delete globalForProducer.webQueueProducer;
  }
}
