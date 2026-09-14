import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
import { createWorkerQueues } from "@/worker/queues";
import type { WorkerQueueSet } from "@/worker/queues";
import { CHECK_TICK_EVERY_MS, CHECK_TICK_SCHEDULER_ID } from "@/worker/scheduler";
import { LOCK_TTL_MS, lockKey } from "@/worker/locks";
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
// RES-05 injection case 6 — REDIS RESTART RECOVERY (plan 04-08 Task 2,
// D-28 #6).
//
// PERSISTENCE POSTURE (documented per the plan): docker-compose.test.yml runs
// `redis:8-alpine` with the STOCK image config — no --appendonly, no volume,
// RDB snapshotting at default save points only. State surviving a container
// restart is therefore INDETERMINATE by design (an RDB save may or may not
// have fired mid-suite). This case leans into that: it proves the RES-05
// RECOVERY CONTRACT, which must hold under ANY persistence level —
//   1. a stale lock key cannot outlive its TTL (SET NX PX expiry, no owner
//      renewing — verified by watching TTL reach -2 with no worker running);
//   2. the worker's next boot RE-UPSERTS the recurring Job Schedulers
//      (upsertJobScheduler idempotence — exactly one check-tick scheduler
//      exists after re-boot even if the restart lost them);
//   3. the next tick RE-CLAIMS via next_check_at (a monitor whose due slot
//      passed during/after the outage is claimed and checked — pings resume
//      with no manual lock cleanup).
//
// The first worker is STOPPED after the restart (its in-flight Redis clients
// died with the server): RES-05's procedure is restart-the-worker, and the
// replacement boot is where the re-upsert contract is exercised.
// ---------------------------------------------------------------------------

let pg: Client;
let queues: WorkerQueueSet;
const workers: WorkerHandle[] = [];
let userId: string;
let pingMonitorIds: number[] = [];
let staleLockMonitorId = 0;

async function pingCount(): Promise<number> {
  const result = await pg.query(`SELECT count(*)::int AS n FROM pings`);
  return result.rows[0].n as number;
}

async function tickSchedulerPresent(): Promise<boolean> {
  const schedulers = await queues.scheduler.getJobSchedulers();
  return schedulers.some((entry) => entry.key === CHECK_TICK_SCHEDULER_ID);
}

async function reDuePingMonitors(): Promise<void> {
  await pg.query(
    `UPDATE monitors SET next_check_at = now() - interval '1 minute' WHERE id = ANY($1::int[])`,
    [pingMonitorIds]
  );
}

beforeAll(async () => {
  pg = await connectPg();
  queues = createWorkerQueues(new Redis(process.env.TEST_REDIS_URL!));
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE write_guards");
  await pg.query("TRUNCATE users CASCADE");
  userId = await seedUser(pg);
});

afterAll(async () => {
  for (const w of workers) {
    if (!w.hasExited()) await w.stop().catch(() => {});
  }
  await queues.close().catch(() => {});
  // The pre-restart admin client may be dead — reconnect for key hygiene so
  // the next case starts from a clean queue/lock keyspace.
  const cleanup = await connectAdminRedis();
  await flushWorkerKeys(cleanup).catch(() => {});
  await cleanup.quit().catch(() => {});
  await pg.end().catch(() => {});
  // Fail-loud container restoration — this case RESTARTED the redis container.
  ensureStackUp();
});

describe("resilience: Redis restart (state loss) recovery", () => {
  it("expires stale locks via TTL, re-upserts schedulers at boot, and re-claims due monitors via next_check_at", async () => {
    // Seed: two ping monitors (due now — first tick claims them) and one
    // stale-lock monitor that is NEVER due (next_check_at far future) so the
    // TTL proof cannot interfere with a real claim.
    pingMonitorIds = [
      await seedMonitor(pg, {
        userId,
        status: "PENDING",
        interval: 30,
        nextCheckAt: new Date(Date.now() - 60_000),
      }),
      await seedMonitor(pg, {
        userId,
        status: "PENDING",
        interval: 30,
        nextCheckAt: new Date(Date.now() - 60_000),
      }),
    ];
    staleLockMonitorId = await seedMonitor(pg, {
      userId,
      status: "PENDING",
      interval: 30,
      nextCheckAt: new Date(Date.now() + 3_600_000),
    });

    // --- pre-restart: the scheduler is live and the first tick ran ---------
    const first = await spawnWorker({ WORKER_SCHEDULER_ENABLED: "true" });
    workers.push(first);
    await first.waitReady();
    await waitFor(tickSchedulerPresent, 15_000, "redis-restart: check-tick scheduler present after first boot");
    await waitFor(
      async () => (await pingCount()) >= 1,
      60_000,
      "redis-restart: first scheduler tick produced at least one ping"
    );

    // Re-due both ping monitors so the outage eats their next due slot.
    await reDuePingMonitors();
    const pingsBefore = await pingCount();

    // --- the restart -------------------------------------------------------
    const restartedAt = Date.now();
    dockerCompose("restart redis");
    // The old worker's Redis clients died with the server — RES-05's
    // procedure restarts the worker; take it down before the re-boot.
    await first.stop();
    const recoveryAdmin = await connectAdminRedis();
    await waitFor(
      async () => {
        try {
          await recoveryAdmin.ping();
          return true;
        } catch {
          return false;
        }
      },
      60_000,
      "redis-restart: Redis accepting commands again after the container restart"
    );
    const redisBackAt = Date.now();

    // (1) stale locks expire via TTL — inject a lock an old worker might have
    // left behind (SET NX PX shape) and watch TTL reach -2 with NOTHING
    // renewing it. No manual cleanup, no DEL: the TTL is the reaper.
    const ok = await recoveryAdmin.set(lockKey(staleLockMonitorId), "stale-owner-token", "PX", LOCK_TTL_MS);
    expect(ok).toBe("OK");
    const ttlFresh = await recoveryAdmin.ttl(lockKey(staleLockMonitorId));
    expect(ttlFresh).toBeGreaterThan(0);
    expect(ttlFresh).toBeLessThanOrEqual(LOCK_TTL_MS / 1000);
    await waitFor(
      async () => (await recoveryAdmin.ttl(lockKey(staleLockMonitorId))) === -2,
      LOCK_TTL_MS + 10_000,
      "redis-restart: stale lock key expired via TTL (ttl() === -2)"
    );
    const lockExpiredAt = Date.now();

    // (2)+(3) re-boot the worker: schedulers re-upsert at boot, the next
    // tick re-claims the still-due monitors via next_check_at.
    await reDuePingMonitors(); // the due slot may have advanced past the outage
    const replacement = await spawnWorker({ WORKER_SCHEDULER_ENABLED: "true" });
    workers.push(replacement);
    await replacement.waitReady();
    await waitFor(tickSchedulerPresent, 15_000, "redis-restart: check-tick scheduler re-upserted at the replacement boot (RES-05)");
    const upsertedAt = Date.now();

    // The upsert is CONVERGENT, not duplicated: exactly one check-tick
    // scheduler exists regardless of what the restart did or did not keep.
    const schedulers = await queues.scheduler.getJobSchedulers();
    const tickSchedulers = schedulers.filter((entry) => entry.key === CHECK_TICK_SCHEDULER_ID);
    expect(tickSchedulers).toHaveLength(1);

    await waitFor(
      async () => (await pingCount()) > pingsBefore,
      CHECK_TICK_EVERY_MS + 60_000,
      "redis-restart: the next tick re-claimed the due monitors and pings resumed"
    );

    recordObservations("redis-restart", {
      persistence: "redis:8-alpine stock config (RDB default save points, no AOF/volume) — restart state indeterminate by design",
      redisRestartMs: redisBackAt - restartedAt,
      staleLockTtlExpiryMs: lockExpiredAt - redisBackAt,
      bootToSchedulerReupsertMs: upsertedAt - lockExpiredAt,
      pingsResumed: true,
      tickSchedulersAfterReboot: tickSchedulers.length,
    });
  });
});
