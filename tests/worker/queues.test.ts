import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
import type { Logger } from "pino";
import {
  addCheckJob,
  CHECK_JOB_OPTIONS,
  claimedCheckJobId,
  createWorkerQueues,
  enqueueClaimedCheck,
  enqueueManualCheck,
  manualCheckJobId,
  LANE_PRIORITY,
} from "@/worker/queues";
import type { CheckQueueClient, WorkerQueueSet } from "@/worker/queues";
import { backlogDropCount, noteBacklogDrop, openBacklogGate, resetBacklogDropCount } from "@/worker/backlog";
import { BACKLOG_DROP_MARKER } from "@/worker/backlog";
import { BREAKER_THRESHOLD, recordInfraFailure, resetBreaker } from "@/worker/breaker";

// ---------------------------------------------------------------------------
// Queue-topology proof suite (WRK-02/WRK-12/RES-02, audit §14.1) against the
// REAL docker test stack — Redis :6390 / Postgres :5453 (vitest wiring; never
// mocked: the jobId/priority/option contracts under test are BullMQ's own
// storage behavior). bull:* keys are flushed per case via the rate-limit
// suite's admin-client SCAN+DEL discipline; monitors are seeded with raw SQL
// through TEST_DATABASE_URL only (02-02 rule).
//
// Pins:
//   1. the explicit-priority invariant — addCheckJob REFUSES without priority
//      (Pitfall 3), and every helper's job carries its lane priority
//   2. jobId derivation — check:{monitorId}:{epoch-seconds} for claims,
//      check:{monitorId}:manual:{epochMs} unique per manual enqueue
//   3. J-1 failed-enqueue disposition (re-pinned, WR-03/D-29) — add()
//      rejection propagates to the tick AND next_check_at STAYS advanced
//      (audit §14.4: leave claims advanced; one missed check per monitor
//      is the accepted consequence — no rollback churn against a dying
//      Redis). The 4b TOCTOU case (WR-02) proves a breaker opened BETWEEN
//      the outer canEnqueue check and add() is a SKIP — dropped +
//      breakerGated, same shape as the outer-gate skip verbatim — never
//      a rollback and never a throw
//   4. the backlog gate — routine (UP/priority-10) enqueues drop above the
//      ~2x cap with the BACKLOG_DROP marker + counter; non-UP NEVER gates
// ---------------------------------------------------------------------------

let admin: Redis;
let pg: Client;
let queues: WorkerQueueSet;
let testUserId: string;

/** SCAN+DEL flush for one queue's whole keyspace (rate-limit suite discipline). */
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

async function seedMonitor(opts: {
  status?: string;
  interval?: number;
  isActive?: boolean;
  nextCheckAt?: string | null;
}): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval, next_check_at, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [
      "https://example.com",
      `queues-test-${crypto.randomUUID()}`,
      testUserId,
      opts.status ?? "UP",
      opts.isActive ?? true,
      opts.interval ?? 5,
      opts.nextCheckAt ?? null,
    ]
  );
  return result.rows[0].id as number;
}

/** A checks-queue stand-in with controllable add() and counts (injectable seam). */
function fakeQueue(overrides?: {
  add?: CheckQueueClient["add"];
  counts?: Record<string, number>;
}): CheckQueueClient {
  return {
    add: overrides?.add ?? vi.fn(async () => ({})),
    getJobCounts: vi.fn(async () => overrides?.counts ?? { wait: 0, delayed: 0, active: 0 }),
  };
}

beforeAll(async () => {
  admin = new Redis(process.env.REDIS_URL!);
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  // Own the tables this file seeds (fileParallelism: false — no concurrent files).
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`queues-test-${crypto.randomUUID()}@example.test`]
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
  resetBacklogDropCount();
  // Case 4b trips the breaker module state OPEN; it must never leak into
  // another case's enqueue gates (01-03: process-lifetime state).
  resetBreaker();
});

describe("queue topology — priorities, jobIds, J-1, backlog gate (WRK-02/WRK-12/RES-02)", () => {
  it(
    "1. addCheckJob REFUSES to enqueue without an explicit priority (Pitfall 3 / WRK-12)",
    async () => {
      const fake = fakeQueue();
      await expect(
        addCheckJob(fake, 1, { priority: undefined, jobId: "check:1:123" })
      ).rejects.toThrow(/without an explicit priority/i);
      expect(fake.add).not.toHaveBeenCalled();
    },
    15_000
  );

  it(
    "2. enqueueClaimedCheck assigns lanes from the claim shape: DOWN -> priority 1, UP -> priority 10, jobId = check:{monitorId}:{epoch-seconds}",
    async () => {
      const downId = await seedMonitor({ status: "DOWN", nextCheckAt: null });
      const upId = await seedMonitor({ status: "UP", nextCheckAt: null });
      const claimedAt = new Date(Date.now() + 5 * 60_000); // what the claim's RETURNING would carry

      const down = await enqueueClaimedCheck(
        { id: downId, status: "DOWN", nextCheckAt: claimedAt },
        { checksQueue: queues.checks }
      );
      expect(down.priority).toBe(LANE_PRIORITY.nonUpCheck);
      expect(down.dropped).toBe(false);
      expect(down.jobId).toBe(claimedCheckJobId(downId, claimedAt));
      expect(down.jobId).toMatch(new RegExp(`^check:${downId}:\\d{10}$`)); // epoch SECONDS

      const up = await enqueueClaimedCheck(
        { id: upId, status: "UP", nextCheckAt: claimedAt },
        { checksQueue: queues.checks }
      );
      expect(up.priority).toBe(LANE_PRIORITY.routineCheck);

      // The stored jobs carry exactly those priorities and jobIds (BullMQ is
      // the authority — read the jobs back, do not trust the return value).
      const downJob = await queues.checks.getJob(down.jobId);
      const upJob = await queues.checks.getJob(up.jobId);
      expect(downJob?.id).toBe(down.jobId);
      expect(downJob?.opts.priority).toBe(1);
      expect(upJob?.id).toBe(up.jobId);
      expect(upJob?.opts.priority).toBe(10);
      expect(downJob?.data.monitorId).toBe(downId);
    },
    15_000
  );

  it(
    "3. manual jobId derivation: check:{monitorId}:manual:{epochMs}, unique per enqueue, priority 1",
    async () => {
      const monitorId = await seedMonitor({ status: "UP" });

      // Pure form: the epochMs token is the caller's clock at enqueue time.
      // 3-segment shape (BullMQ 6 rejects colon jobIds that do not split into
      // exactly 3 parts): `check-manual:{monitorId}:{epochMs}`.
      expect(manualCheckJobId(42, 1_770_000_000_123)).toBe("check-manual:42:1770000000123");

      const first = await enqueueManualCheck(monitorId, { checksQueue: queues.checks });
      const second = await enqueueManualCheck(monitorId, { checksQueue: queues.checks });
      expect(first.priority).toBe(LANE_PRIORITY.manualCheck);
      expect(first.jobId).toMatch(new RegExp(`^check-manual:${monitorId}:\\d{13,}$`));
      // 01-08: admission is the limiter's job — the jobId NEVER dedupes a
      // second manual check.
      expect(first.jobId).not.toBe(second.jobId);

      const job = await queues.checks.getJob(first.jobId);
      expect(job?.opts.priority).toBe(1);
    },
    15_000
  );

  it(
    "4. J-1 failed-enqueue disposition (re-pinned, WR-03/D-29): add() rejection propagates — next_check_at STAYS advanced (audit §14.4)",
    async () => {
      const monitorId = await seedMonitor({ status: "DOWN", interval: 5 });
      // What the claim just did: advanced a due row to now()+5m.
      const claimedTo = new Date(Date.now() + 5 * 60_000);
      await pg.query(`UPDATE monitors SET next_check_at = $1 WHERE id = $2`, [
        claimedTo.toISOString(),
        monitorId,
      ]);

      const rejecting = fakeQueue({
        add: vi.fn(async () => {
          throw new Error("simulated redis down");
        }),
      });
      await expect(
        enqueueClaimedCheck({ id: monitorId, status: "DOWN", nextCheckAt: claimedTo }, { checksQueue: rejecting })
      ).rejects.toThrow("simulated redis down");

      // Audit §14.4 disposition (WR-03): the claim is NOT rolled back. The
      // row stays at its advanced slot — the missed check is the accepted
      // J-1 consequence, the next tick re-claims the monitor when due, and
      // a sustained Redis outage produces one failed enqueue per tick per
      // due monitor instead of a per-monitor claim/rollback churn loop.
      const after = await pg.query(`SELECT next_check_at FROM monitors WHERE id = $1`, [monitorId]);
      const stayed = new Date(after.rows[0].next_check_at as string).getTime();
      expect(Math.abs(stayed - claimedTo.getTime())).toBeLessThan(1_000);
    },
    15_000
  );

  it(
    "4b. WR-02 TOCTOU: breaker opening between the outer gate and add() is a SKIP — dropped + breakerGated, outer-gate skip shape verbatim, claim stays advanced",
    async () => {
      const monitorId = await seedMonitor({ status: "UP", interval: 5 });
      const claimedTo = new Date(Date.now() + 5 * 60_000);
      await pg.query(`UPDATE monitors SET next_check_at = $1 WHERE id = $2`, [
        claimedTo.toISOString(),
        monitorId,
      ]);

      // The reference outcome FIRST: breaker already OPEN before the call —
      // the outer canEnqueue gate refuses and returns the canonical skip.
      resetBreaker();
      for (let i = 0; i < BREAKER_THRESHOLD; i += 1) recordInfraFailure();
      const outerSkip = await enqueueClaimedCheck(
        { id: monitorId, status: "UP", nextCheckAt: claimedTo },
        { checksQueue: queues.checks }
      );
      expect(outerSkip).toEqual({
        jobId: claimedCheckJobId(monitorId, claimedTo),
        priority: LANE_PRIORITY.routineCheck,
        dropped: true,
        breakerGated: true,
      });

      // The TOCTOU window itself: breaker CLOSED at enqueueClaimedCheck's
      // outer check, tripped by the work that runs BETWEEN the two gates
      // (for a routine row that is the backlog gate's depth read) — so
      // addCheckJob's inner gate then throws BreakerOpenError after the
      // outer check already passed. The suite's injection seam: the gate
      // callback does the tripping.
      resetBreaker();
      const add = vi.fn(async () => ({}));
      const neverDialed: CheckQueueClient = {
        add,
        getJobCounts: vi.fn(async () => ({ wait: 0, prioritized: 0, delayed: 0, active: 0 })),
      };
      const trippingGate = {
        canAcceptRoutine: async () => {
          for (let i = 0; i < BREAKER_THRESHOLD; i += 1) recordInfraFailure();
          return true; // depth is fine — Postgres died mid-tick anyway
        },
      };
      const toctou = await enqueueClaimedCheck(
        { id: monitorId, status: "UP", nextCheckAt: claimedTo },
        { checksQueue: neverDialed, gate: trippingGate }
      );

      // NOT a throw, and the skip-return shape matches the outer-gate skip
      // verbatim — same fields, same values (WR-02's fix requirement).
      expect(toctou).toEqual(outerSkip);
      expect(toctou.breakerGated).toBe(true);
      expect(toctou.dropped).toBe(true);
      // The enqueue itself never fired.
      expect(add).not.toHaveBeenCalled();

      // §14.4 holds through the refusal: the claim stays advanced.
      const after = await pg.query(`SELECT next_check_at FROM monitors WHERE id = $1`, [monitorId]);
      const stayed = new Date(after.rows[0].next_check_at as string).getTime();
      expect(Math.abs(stayed - claimedTo.getTime())).toBeLessThan(1_000);

      resetBreaker(); // leave the module state CLOSED for later cases
    },
    15_000
  );

  it(
    "5. backlog gate: a routine (UP) enqueue DROPS above ~2x active monitors — counter increments, add() never fires, marker logged",
    async () => {
      const monitorId = await seedMonitor({ status: "UP", interval: 5 });
      const flooded = fakeQueue({ counts: { wait: 100, delayed: 0, active: 0 } });
      const gate = openBacklogGate({ checksQueue: flooded, activeMonitorCount: 3 }); // cap 6 < 100

      const outcome = await enqueueClaimedCheck(
        { id: monitorId, status: "UP", nextCheckAt: new Date() },
        { checksQueue: queues.checks, gate }
      );
      expect(outcome.dropped).toBe(true);
      expect(outcome.priority).toBe(LANE_PRIORITY.routineCheck);
      expect(flooded.getJobCounts).toHaveBeenCalled();
      expect(backlogDropCount()).toBe(1);

      // The real queue received nothing.
      expect(await queues.checks.getJob(outcome.jobId)).toBeUndefined();

      // noteBacklogDrop emits the greppable marker (injectable logger).
      const fakeLog = { warn: vi.fn() } as unknown as Logger;
      noteBacklogDrop({ monitorId: 1, jobId: "check:1:1" }, fakeLog);
      expect(fakeLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ marker: BACKLOG_DROP_MARKER, monitorId: 1, jobId: "check:1:1" }),
        expect.stringContaining("DROPPED")
      );
      expect(backlogDropCount()).toBe(2);
      resetBacklogDropCount();
      expect(backlogDropCount()).toBe(0);
    },
    15_000
  );

  it(
    "6. the non-UP lane is NEVER gated: same flooded counts, DOWN row still enqueues at priority 1",
    async () => {
      const monitorId = await seedMonitor({ status: "DOWN", interval: 5 });
      const flooded = fakeQueue({ counts: { wait: 100, delayed: 0, active: 0 } });
      const gate = openBacklogGate({ checksQueue: flooded, activeMonitorCount: 3 });

      const outcome = await enqueueClaimedCheck(
        { id: monitorId, status: "DOWN", nextCheckAt: new Date() },
        { checksQueue: queues.checks, gate }
      );
      expect(outcome.dropped).toBe(false);
      expect(outcome.priority).toBe(1);
      const job = await queues.checks.getJob(outcome.jobId);
      expect(job?.opts.priority).toBe(1);
      expect(backlogDropCount()).toBe(0); // transition lane: never droppable
    },
    15_000
  );

  it(
    "7. gate boundary: depth exactly AT the cap accepts (~2x is inclusive), one gate caches its verdict per tick",
    async () => {
      const atCap = fakeQueue({ counts: { wait: 4, delayed: 2, active: 0 } }); // depth 6
      const gate = openBacklogGate({ checksQueue: atCap, activeMonitorCount: 3 }); // cap 6
      expect(await gate.canAcceptRoutine()).toBe(true); // 6 <= 6

      // Verdict cached: a second depth read is not even issued.
      expect(await gate.canAcceptRoutine()).toBe(true);
      expect(atCap.getJobCounts).toHaveBeenCalledTimes(1);
    },
    15_000
  );

  it(
    "8. REAL-queue depth: prioritized jobs count toward the cap (bullmq files priority-carrying jobs in the prioritized set)",
    async () => {
      // Five routine (priority-10) checks on the REAL checks queue — bullmq
      // files every one of them in the PRIORITIZED set, none in plain wait.
      // A gate blind to that set would read depth 0 and never trip RES-02.
      const token = Date.now();
      for (let i = 0; i < 5; i++) {
        await queues.checks.add(
          "check",
          { monitorId: 900 + i },
          { ...CHECK_JOB_OPTIONS, priority: LANE_PRIORITY.routineCheck, jobId: `check:${900 + i}:${token}` }
        );
      }
      const counts = await queues.checks.getJobCounts("wait", "prioritized", "delayed", "active");
      expect(counts.prioritized).toBe(5); // the empirical pin this test guards
      expect(counts.wait).toBe(0);

      // 2 active monitors -> cap 4 < depth 5 -> routine enqueue refused.
      const gate = openBacklogGate({ checksQueue: queues.checks, activeMonitorCount: 2 });
      expect(await gate.canAcceptRoutine()).toBe(false);
    },
    15_000
  );
});
