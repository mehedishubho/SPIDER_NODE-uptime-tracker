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

// ---------------------------------------------------------------------------
// Producer-side deadline (06-06 gap 2, T-06-07 / VERIFICATION truth 3): the
// bounded profile above only rejects FAST when Redis actively refuses — a
// never-connectable endpoint (firewall drop) never settles either way and
// would pin a request handler forever. withProducerDeadline is the backstop
// racing every web-side producer await (ping, check-route enqueue, email
// door add) against a 3s bound whose rejection the routes' existing catches
// map to the fixed 503. 3s sits above the 1s connect + 1s command budget so
// the fast-rejection path stays primary; the deadline covers the silent mode
// where nothing else fires (deferred-items item 3 recorded 2-3s).
// ---------------------------------------------------------------------------

/** Backstop bound for web-side producer awaits (silent-unreachable Redis). */
export const PRODUCER_DEADLINE_MS = 3000;

/** Rejection type when a producer await exceeds its deadline (name pinned). */
export class ProducerDeadlineError extends Error {
    constructor(ms: number) {
        super(
            `producer await exceeded the ${ms}ms deadline (silently-unreachable Redis backstop — mapped to a loud 503)`,
        );
        this.name = "ProducerDeadlineError";
    }
}

/**
 * Races a producer await against a deadline. Fast settles/rejects pass
 * through the race untouched; a never-settling await rejects with
 * ProducerDeadlineError at `ms` (default PRODUCER_DEADLINE_MS). The losing
 * timer is always cleared (check-now-poll timer-hygiene precedent).
 */
export async function withProducerDeadline<T>(
    promise: Promise<T>,
    ms: number = PRODUCER_DEADLINE_MS,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new ProducerDeadlineError(ms)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

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
            ping: () => withProducerDeadline(connection.ping()),
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
