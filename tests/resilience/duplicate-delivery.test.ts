import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
import { createWorkerQueues, enqueueClaimedCheck } from "@/worker/queues";
import type { WorkerQueueSet } from "@/worker/queues";
import {
  connectAdminRedis,
  connectPg,
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
// RES-04 injection case 1 — DUPLICATE DELIVERY (plan 04-08 Task 2).
//
// Claimed-check enqueue twice with the SAME row (same monitorId + same
// nextCheckAt => the identical claimed jobId `check:{monitorId}:{epochSec}`):
// the REAL spawned worker bundle must admit only one job (BullMQ jobId dedup)
// and produce EXACTLY ONE evidence ping / one counter bump / one ONGOING
// incident / one outbox row across both deliveries. The monitor targets the
// SSRF denylist (127.0.0.1) so the outcome is a deterministic DOWN — the
// Tier 1 synchronous path (§16.1).
// ---------------------------------------------------------------------------

let pg: Client;
let admin: Redis;
let queues: WorkerQueueSet;
let worker: WorkerHandle | undefined;
let userId: string;
let monitorId: number;

async function snapshot(id: number) {
  const monitor = await pg.query(
    `SELECT status, "totalChecks", "failedChecks" FROM monitors WHERE id = $1`,
    [id]
  );
  const pings = await pg.query(`SELECT count(*)::int AS n FROM pings WHERE "monitorId" = $1`, [id]);
  const incidents = await pg.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'ONGOING')::int AS ongoing
       FROM incidents WHERE "monitorId" = $1`,
    [id]
  );
  const outbox = await pg.query(
    `SELECT count(*)::int AS n FROM outbox WHERE monitor_id = $1`,
    [id]
  );
  return {
    status: monitor.rows[0]?.status as string,
    totalChecks: monitor.rows[0]?.totalChecks as number,
    failedChecks: monitor.rows[0]?.failedChecks as number,
    pings: pings.rows[0].n as number,
    incidents: incidents.rows[0].total as number,
    ongoingIncidents: incidents.rows[0].ongoing as number,
    outbox: outbox.rows[0].n as number,
  };
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
  // Containers were never stopped in this case, but the uniform finally
  // contract restores them loudly (rehearse-migrations convention).
  ensureStackUp();
});

describe("resilience: duplicate delivery of one claimed check", () => {
  it("admits exactly one job by claimed jobId dedup and persists one transition", async () => {
    monitorId = await seedMonitor(pg, { userId, status: "PENDING", interval: 30 });
    worker = await spawnWorker({ WORKER_SCHEDULER_ENABLED: "false" });
    await worker.waitReady();
    const startedAt = Date.now();

    // Same row twice -> enqueueClaimedCheck derives the IDENTICAL claimed
    // jobId both times (check:{monitorId}:{epochSec}) — the real add path.
    const row = { id: monitorId, status: "PENDING", nextCheckAt: new Date(Date.now() + 60_000) };
    const first = await enqueueClaimedCheck(row, { checksQueue: queues.checks });
    const second = await enqueueClaimedCheck(row, { checksQueue: queues.checks });
    expect(first.dropped).toBe(false);
    expect(second.dropped).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    // The claimed jobId shape (BullMQ 6 three-segment contract).
    expect(first.jobId.startsWith(`check:${monitorId}:`)).toBe(true);
    expect(first.jobId.split(":")).toHaveLength(3);

    // Exactly ONE job exists across every state — the second add deduped.
    const counts = await queues.checks.getJobCounts(
      "wait",
      "prioritized",
      "delayed",
      "active",
      "completed",
      "failed"
    );
    const total = Object.values(counts).reduce((sum, n) => sum + Number(n ?? 0), 0);
    expect(total).toBe(1);

    const job = await queues.checks.getJob(first.jobId);
    await waitFor(
      async () => (await job!.getState()) === "completed",
      30_000,
      "duplicate-delivery: the single admitted job completed"
    );

    // One delivery => one evidence ping, one counter bump, one ONGOING
    // incident, one outbox row, DOWN status (§16.1 exactly-once semantics).
    const snap = await snapshot(monitorId);
    expect(snap.status).toBe("DOWN");
    expect(snap.totalChecks).toBe(1);
    expect(snap.failedChecks).toBe(1);
    expect(snap.pings).toBe(1);
    expect(snap.incidents).toBe(1);
    expect(snap.ongoingIncidents).toBe(1);
    expect(snap.outbox).toBe(1);

    recordObservations("duplicate-delivery", {
      enqueueAttempts: 2,
      admittedJobs: total,
      pings: snap.pings,
      totalChecks: snap.totalChecks,
      enqueueToCompletedMs: Date.now() - startedAt,
      jobId: first.jobId,
    });
  });
});
