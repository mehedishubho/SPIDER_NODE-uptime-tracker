import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
import { createWorkerQueues, enqueueClaimedCheck, enqueueManualCheck, CHECK_JOB_OPTIONS } from "@/worker/queues";
import type { WorkerQueueSet } from "@/worker/queues";

// ---------------------------------------------------------------------------
// Retry/DLQ option-form proof suite (WRK-06) against the REAL docker test
// Redis (:6390): the options are read back off the STORED jobs (BullMQ is the
// authority), flushed per case with the rate-limit suite's admin-client
// SCAN+DEL discipline. Pins the plan's check-lane form:
//   attempts 5, exponential backoff 2000 ms base,
//   removeOnComplete { age: 3600 }, removeOnFail { age: 14 days } (DLQ).
// KeepJobs eviction is LAZY (Pitfall 6) — retention is declarative here; the
// 04-07 maintenance dry-run reports on actual key sizes.
// ---------------------------------------------------------------------------

let admin: Redis;
let pg: Client;
let queues: WorkerQueueSet;
let testUserId: string;

async function flushQueueKeys(prefix: string): Promise<void> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await admin.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length > 0) await admin.del(...keys);
}

async function seedMonitor(status: string): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "updatedAt")
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    ["https://example.com", `retries-test-${crypto.randomUUID()}`, testUserId, status]
  );
  return result.rows[0].id as number;
}

/** Asserts the full pinned option form on a stored job's opts. */
function expectCheckOptions(opts: {
  attempts?: unknown;
  backoff?: unknown;
  removeOnComplete?: unknown;
  removeOnFail?: unknown;
}): void {
  expect(opts.attempts).toBe(5);
  expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });
  expect(opts.removeOnComplete).toEqual({ age: 3600 });
  expect(opts.removeOnFail).toEqual({ age: 14 * 24 * 3600 }); // 1209600 s = 14 days
}

beforeAll(async () => {
  admin = new Redis(process.env.REDIS_URL!);
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`retries-test-${crypto.randomUUID()}@example.test`]
  );
  testUserId = user.rows[0].id as string;
  queues = createWorkerQueues(new Redis(process.env.REDIS_URL!));
});

afterAll(async () => {
  await queues.close().catch(() => {});
  await pg.end();
  await admin.quit();
});

beforeEach(async () => {
  await flushQueueKeys("bull:monitor-checks:");
});

describe("check-lane retry/DLQ option forms (WRK-06, Pitfall 6)", () => {
  it(
    "1. a claimed check job carries attempts 5 / exponential 2000ms / removeOnComplete 1h / removeOnFail 14d",
    async () => {
      const monitorId = await seedMonitor("DOWN");
      const nextCheckAt = new Date(Date.now() + 60_000);

      const { jobId } = await enqueueClaimedCheck(
        { id: monitorId, status: "DOWN", nextCheckAt },
        { checksQueue: queues.checks }
      );
      const job = await queues.checks.getJob(jobId);
      expect(job).toBeDefined();
      expectCheckOptions(job!.opts);
      // The exported constant is the transcription source of truth (§14 pins).
      expect(CHECK_JOB_OPTIONS).toEqual({
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 1209600 },
      });
    },
    15_000
  );

  it(
    "2. a manual check job carries the same option form (one lane contract, two key forms)",
    async () => {
      const monitorId = await seedMonitor("UP");
      const { jobId } = await enqueueManualCheck(monitorId, { checksQueue: queues.checks });
      const job = await queues.checks.getJob(jobId);
      expect(job).toBeDefined();
      expectCheckOptions(job!.opts);
    },
    15_000
  );

  it(
    "3. a routine (UP) claimed check carries the identical option form — options never vary by lane",
    async () => {
      const monitorId = await seedMonitor("UP");
      const { jobId } = await enqueueClaimedCheck(
        { id: monitorId, status: "UP", nextCheckAt: new Date(Date.now() + 60_000) },
        { checksQueue: queues.checks }
      );
      const job = await queues.checks.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.opts.priority).toBe(10);
      expectCheckOptions(job!.opts);
    },
    15_000
  );
});
