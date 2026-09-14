import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
import { WORKER_TEST_CRASH_MARKER } from "@/worker/engine/check";
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
// RES-01 injection case 2 — KILL MID-JOB past the Tier-1 commit (D-29).
//
// The crash hook (src/worker/engine/check.ts, WORKER_TEST_CRASH_AFTER=
// tier1_commit) hard-exits the REAL spawned dist/worker.js child via SIGKILL
// immediately AFTER applyTransition's COMMIT and BEFORE the job ack. The case
// then proves the D-29 marker pair — the transition is durable (DB) while the
// job is NOT acked (still 'active' in Redis) — restarts the worker, and lets
// the stalled checker (lockDuration/stalledInterval 30 s, maxStalledCount 1)
// redeliver: the redelivered delivery re-runs evidence parity (01-01: pings x2)
// while the conditional UPDATE keeps counters/incident/outbox EXACTLY-ONCE.
// ---------------------------------------------------------------------------

// tests/resilience/*.test.ts is TWO dirs below the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let pg: Client;
let admin: Redis;
let queues: WorkerQueueSet;
const workers: WorkerHandle[] = [];
let userId: string;
let monitorId: number;

async function snapshot(id: number) {
  const monitor = await pg.query(
    `SELECT status, "totalChecks", "failedChecks" FROM monitors WHERE id = $1`,
    [id]
  );
  const pings = await pg.query(
    `SELECT count(*)::int AS n FROM pings WHERE "monitorId" = $1`,
    [id]
  );
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
  for (const w of workers) {
    if (!w.hasExited()) await w.stop().catch(() => {});
  }
  await queues.close().catch(() => {});
  await flushWorkerKeys(admin).catch(() => {});
  await admin.quit().catch(() => {});
  await pg.end().catch(() => {});
  ensureStackUp();
});

describe("resilience: SIGKILL between the Tier 1 commit and the job ack", () => {
  it("keeps the committed transition, redelivers via the stalled checker, and stays exactly-once on counters", async () => {
    // T-04-30 source pin: the crash hook is ENV-GATED and inert without
    // WORKER_TEST_CRASH_AFTER — the gate is the env read itself. Also pin
    // its position: after applyTransition (post-COMMIT), before the return
    // (pre-ack), inside the tier1 branch.
    const source = readFileSync(path.join(REPO_ROOT, "src", "worker", "engine", "check.ts"), "utf8");
    expect(source).toContain('process.env.WORKER_TEST_CRASH_AFTER === "tier1_commit"');
    expect(source).toMatch(
      /await applyTransition\((?:.|\n)*?WORKER_TEST_CRASH_AFTER === "tier1_commit"(?:.|\n)*?process\.kill\(process\.pid, "SIGKILL"\)/
    );

    monitorId = await seedMonitor(pg, { userId, status: "PENDING", interval: 30 });
    const crashed = await spawnWorker({
      WORKER_SCHEDULER_ENABLED: "false",
      WORKER_TEST_CRASH_AFTER: "tier1_commit",
    });
    workers.push(crashed);
    await crashed.waitReady();

    const enqueueStartedAt = Date.now();
    const outcome = await enqueueClaimedCheck(
      { id: monitorId, status: "PENDING", nextCheckAt: new Date(Date.now() + 60_000) },
      { checksQueue: queues.checks }
    );
    expect(outcome.dropped).toBe(false);
    const job = await queues.checks.getJob(outcome.jobId);

    // The 127.0.0.1 SSRF-blocked check resolves fast; Tier 1 commits; the
    // hook fires. The sync writeSync marker precedes the kill by contract.
    await waitFor(
      () => Promise.resolve(crashed.hasExited()),
      30_000,
      "kill-mid-job: worker self-killed at the tier1_commit checkpoint"
    );
    const crashedAt = Date.now();
    expect(crashed.stdoutText()).toContain(WORKER_TEST_CRASH_MARKER);

    // D-29 marker pair, half 1 — the job is NOT acked: with the worker dead
    // nothing can move it out of 'active' until a live worker's stalled
    // checker redelivers.
    expect(await job!.getState()).toBe("active");

    // D-29 marker pair, half 2 — the transition IS durable in Postgres.
    const atCrash = await snapshot(monitorId);
    expect(atCrash.status).toBe("DOWN");
    expect(atCrash.totalChecks).toBe(1);
    expect(atCrash.failedChecks).toBe(1);
    expect(atCrash.pings).toBe(1);
    expect(atCrash.incidents).toBe(1);
    expect(atCrash.ongoingIncidents).toBe(1);
    expect(atCrash.outbox).toBe(1);

    // Restart WITHOUT the crash env — the stalled checker redelivers the
    // still-active job (~30-60 s at lockDuration/stalledInterval 30 000).
    const replacement = await spawnWorker({ WORKER_SCHEDULER_ENABLED: "false" });
    workers.push(replacement);
    await replacement.waitReady();
    await waitFor(
      async () => (await job!.getState()) === "completed",
      150_000,
      "kill-mid-job: stalled job redelivered and completed after the restart"
    );
    const redeliveredAt = Date.now();

    // Exactly-once: the redelivered delivery re-ran evidence (01-01 parity —
    // every delivery records its ping) but the conditional UPDATE (§16.1)
    // refused to double-apply the already-committed transition.
    const after = await snapshot(monitorId);
    expect(after.status).toBe("DOWN");
    expect(after.totalChecks).toBe(1);
    expect(after.failedChecks).toBe(1);
    expect(after.pings).toBe(2);
    expect(after.incidents).toBe(1);
    expect(after.ongoingIncidents).toBe(1);
    expect(after.outbox).toBe(1);

    recordObservations("kill-mid-job", {
      crashHook: "tier1_commit",
      enqueueToCrashMs: crashedAt - enqueueStartedAt,
      committedAtCrash: atCrash,
      stallRedeliveryMs: redeliveredAt - crashedAt,
      pingsAfterRedelivery: after.pings,
      totalChecksAfterRedelivery: after.totalChecks,
    });
  });
});
