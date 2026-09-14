import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
import { BreakerOpenError, recordInfraFailure, resetBreaker, BREAKER_THRESHOLD } from "@/worker/breaker";
import { createWorkerQueues, enqueueClaimedCheck, enqueueManualCheck } from "@/worker/queues";
import type { WorkerQueueSet } from "@/worker/queues";
import {
  connectAdminRedis,
  connectPg,
  dockerCompose,
  ensureStackUp,
  flushWorkerKeys,
  recordObservations,
  seedMonitor,
  seedUser,
  spawnWorker,
  waitFor,
} from "./helpers/worker-process";
import type { WorkerHandle } from "./helpers/worker-process";

// ---------------------------------------------------------------------------
// RES-01 injection case 3 — POSTGRES DOWN (plan 04-08 Task 2).
//
// Stops the test-stack Postgres container while the REAL spawned worker is
// live, enqueues three checks, and proves:
//   1. the attempts fail as INFRA (ECONNREFUSED / terminated-connection
//      class) and BullMQ keeps them RETRYABLE (never 'failed') — bounded
//      attempts + backoff, nothing is lost (RES-01 retry-not-lost);
//   2. the in-worker breaker reaches OPEN (5 consecutive infra failures) and
//      is visible in /metrics.json;
//   3. the enqueue-side gate refuses while OPEN — proven behaviorally in the
//      test process via the REAL canEnqueue path (enqueueManualCheck rejects
//      BreakerOpenError after 5 recordInfraFailure calls, then resets);
//   4. after the container returns, the retried jobs COMPLETE and the
//      transitions land exactly once;
//   5. the breaker recovers OPEN -> HALF_OPEN (derived, 60 s window) ->
//      CLOSED after one successful post-window check.
// ---------------------------------------------------------------------------

let pg: Client;
let admin: Redis;
let queues: WorkerQueueSet;
let worker: WorkerHandle | undefined;
let userId: string;
let monitorIds: number[] = [];

async function monitorState(id: number) {
  const result = await pg.query(
    `SELECT status, "totalChecks", "failedChecks" FROM monitors WHERE id = $1`,
    [id]
  );
  const pings = await pg.query(`SELECT count(*)::int AS n FROM pings WHERE "monitorId" = $1`, [id]);
  return {
    status: result.rows[0]?.status as string,
    totalChecks: result.rows[0]?.totalChecks as number,
    pings: pings.rows[0].n as number,
  };
}

async function breakerMetrics(): Promise<{ state: string; consecutiveFailures: number }> {
  const metrics = await worker!.curl<{ breaker: { state: string; consecutiveFailures: number } }>(
    "/metrics.json"
  );
  return metrics.breaker;
}

async function waitPostgresAccepting(): Promise<Client> {
  let client: Client | undefined;
  await waitFor(
    async () => {
      client = await connectPg().catch(() => undefined);
      return client !== undefined;
    },
    60_000,
    "postgres-down: Postgres accepting connections again after the container restart"
  );
  return client!;
}

beforeAll(async () => {
  pg = await connectPg();
  admin = await connectAdminRedis();
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE write_guards");
  await pg.query("TRUNCATE users CASCADE");
  userId = await seedUser(pg);
  queues = createWorkerQueues(new Redis(process.env.TEST_REDIS_URL!));
});

afterAll(async () => {
  if (worker && !worker.hasExited()) await worker.stop().catch(() => {});
  await queues.close().catch(() => {});
  await flushWorkerKeys(admin).catch(() => {});
  await admin.quit().catch(() => {});
  await pg.end().catch(() => {});
  // Fail-loud container restoration — this case STOPPED the db container.
  ensureStackUp();
});

describe("resilience: Postgres down under live enqueue", () => {
  it("keeps jobs retryable, opens the breaker, refuses enqueue while OPEN, then recovers exactly-once to CLOSED", async () => {
    monitorIds = [
      await seedMonitor(pg, { userId, status: "PENDING", interval: 30 }),
      await seedMonitor(pg, { userId, status: "PENDING", interval: 30 }),
      await seedMonitor(pg, { userId, status: "PENDING", interval: 30 }),
    ];
    worker = await spawnWorker({ WORKER_SCHEDULER_ENABLED: "false" });
    await worker.waitReady();
    resetBreaker(); // test-process breaker isolation for the gate leg below

    // --- the outage -------------------------------------------------------
    dockerCompose("stop db");
    const outageStartedAt = Date.now();
    const enqueuedAt = Date.now();
    const outcomes: Awaited<ReturnType<typeof enqueueClaimedCheck>>[] = [];
    for (const [index, id] of monitorIds.entries()) {
      const outcome = await enqueueClaimedCheck(
        { id, status: "PENDING", nextCheckAt: new Date(Date.now() + 60_000 + index * 1000) },
        { checksQueue: queues.checks }
      );
      expect(outcome.dropped).toBe(false);
      outcomes.push(outcome);
    }

    // (1) infra failures stay RETRYABLE: at least one attempt has been made
    // and the job is NOT terminally 'failed' (bounded attempts + backoff).
    await waitFor(
      async () => {
        for (const outcome of outcomes) {
          const job = await queues.checks.getJob(outcome.jobId);
          const state = await job?.getState();
          if (state !== "waiting" && state !== "delayed" && state !== "active") return false;
          if ((job?.attemptsMade ?? 0) < 1) return false;
        }
        return true;
      },
      60_000,
      "postgres-down: all three jobs failed at least once and remain retryable (not 'failed')"
    );

    // (2) the worker-internal breaker reaches OPEN — visible in metrics.
    let opened: { state: string; consecutiveFailures: number } | undefined;
    await waitFor(
      async () => {
        const breaker = await breakerMetrics();
        if (breaker.state === "OPEN") {
          opened = breaker;
          return true;
        }
        return false;
      },
      60_000,
      "postgres-down: breaker reached OPEN in /metrics.json after 5 consecutive infra failures"
    );
    expect(opened!.consecutiveFailures).toBeGreaterThanOrEqual(BREAKER_THRESHOLD);
    const openedAt = Date.now();

    // (3) the enqueue-side gate refuses while OPEN — the REAL gate path,
    // driven in-process (the spawned worker's gate is the same code; the
    // metrics above prove its state, this proves the refusal behavior).
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) recordInfraFailure();
    await expect(
      enqueueManualCheck(monitorIds[0], { checksQueue: queues.checks })
    ).rejects.toBeInstanceOf(BreakerOpenError);
    resetBreaker();

    // --- the recovery ------------------------------------------------------
    dockerCompose("start db");
    pg = await waitPostgresAccepting();

    // (4) the retried jobs COMPLETE once Postgres returns; each transition
    // lands EXACTLY ONCE (attempt failures never wrote anything).
    await waitFor(
      async () => {
        for (const outcome of outcomes) {
          const job = await queues.checks.getJob(outcome.jobId);
          if ((await job?.getState()) !== "completed") return false;
        }
        return true;
      },
      120_000,
      "postgres-down: all three jobs completed after Postgres returned"
    );
    for (const id of monitorIds) {
      const state = await monitorState(id);
      expect(state.status).toBe("DOWN");
      expect(state.totalChecks).toBe(1);
      expect(state.pings).toBe(1);
    }
    const recoveredAt = Date.now();

    // (5) breaker recovery: OPEN window elapses (60 s from openSince) ->
    // HALF_OPEN (derived) -> one successful check closes it to CLOSED.
    await waitFor(
      async () => (await breakerMetrics()).state === "HALF_OPEN",
      90_000,
      "postgres-down: breaker HALF_OPEN after the 60 s OPEN window elapsed"
    );
    const finalOutcome = await enqueueClaimedCheck(
      { id: monitorIds[0], status: "DOWN", nextCheckAt: new Date(Date.now() + 120_000) },
      { checksQueue: queues.checks }
    );
    expect(finalOutcome.dropped).toBe(false);
    await waitFor(
      async () => (await breakerMetrics()).state === "CLOSED",
      60_000,
      "postgres-down: breaker CLOSED after a successful HALF_OPEN check"
    );
    const finalJob = await queues.checks.getJob(finalOutcome.jobId);
    expect(await finalJob?.getState()).toBe("completed");
    // Evidence parity on the recovery delivery; counters still exactly-once.
    const finalState = await monitorState(monitorIds[0]);
    expect(finalState.pings).toBe(2);
    expect(finalState.totalChecks).toBe(1);

    recordObservations("postgres-down", {
      enqueueToOpenMs: openedAt - enqueuedAt,
      consecutiveFailuresAtOpen: opened!.consecutiveFailures,
      outageToRecoveredMs: recoveredAt - outageStartedAt,
      openWindowMs: 60_000,
      closedRecoveryMs: Date.now() - openedAt,
      jobsRetriedNotLost: outcomes.length,
    });
  });
});
