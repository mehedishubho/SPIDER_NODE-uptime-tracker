import "dotenv/config"; // D-12 — FIRST import, before anything else
import { buildLogger } from "./logger";
import { workerConnection } from "./connection";
import { workerPgPool } from "./db";
import { startHealthServer, WORKER_BUILD_SHA, WORKER_BUILD_TS } from "./health";
import { collectQueueMetrics, workerQueues } from "./queues";
import { startAlertsLaneWorker, startCheckLaneWorker, startDbWritesLaneWorker, startMaintenanceLaneWorker } from "./queues";
import { startTickWorker, upsertSchedulersAtBoot } from "./scheduler";
import { fromLaneJob, makeFlushProcessor, processCheckJob } from "./engine/check";
import { collectOutboxMetrics, processRelayJob } from "./persist/outbox";
import { processMaintenanceJob } from "./maintenance";
import { state as breakerState } from "./breaker";

// ---------------------------------------------------------------------------
// dist/worker.js — the SINGLE worker entry (D-11). All queue workers, the
// scheduler, the health server, and the breaker compose into this one entry
// behind one PM2 app; later Phase-4 plans register their machinery into the
// drain list and boot flow built here.
//
// Boot order (WRK-08 two-signal contract): dotenv -> env assertions ->
// health server on WORKER_HEALTH_PORT (default 9090) -> Redis + Postgres
// boot pings -> process.send('ready') ONLY after both pings pass -> boot
// log carrying build provenance (D-10). If a ping fails the process stays
// up and /readyz keeps reporting 503 — under PM2 wait_ready the missing
// ready signal is what triggers the restart after listen_timeout.
//
// Shutdown (WRK-07, handler level): SIGINT and SIGTERM share one drain
// path — close the health server, await every registered drainable (queues,
// lane workers, the tick worker), end the worker pool, quit Redis, exit 0.
// PM2 kill_timeout 20000 (D-20, ecosystem.config.js) bounds how long this
// may take before SIGKILL.
// ---------------------------------------------------------------------------

const logger = buildLogger();

/** Machinery registered by later plans (queue workers, scheduler) that must drain before exit. */
export interface Drainable {
  close(): Promise<void>;
}

const drainables: Drainable[] = [];

/** Later plans call this at boot so their workers drain on shutdown (WRK-07). */
export function registerDrainable(drainable: Drainable): void {
  drainables.push(drainable);
}

export interface ShutdownDeps {
  closeHealth(): Promise<unknown>;
  endPool(): Promise<unknown>;
  quitRedis(): Promise<unknown>;
}

/**
 * The shared shutdown path (WRK-07), exported so tests invoke it directly
 * (Windows cannot deliver SIGINT to a spawned child — Pitfall 8; the
 * signal-level proof runs in the rehearsal's Linux-container leg).
 *
 * Order is load-bearing: stop taking requests first, drain in-flight work,
 * then tear dependencies down bottom-up — persistence (pool) outlives
 * queueing (Redis) so a late write never lands on a dead queue.
 */
export async function drainAndTeardown(deps: ShutdownDeps): Promise<void> {
  await deps.closeHealth();
  await Promise.allSettled(drainables.map((drainable) => drainable.close()));
  await deps.endPool();
  await deps.quitRedis();
}

function assertRequiredEnv(): void {
  if (!process.env.REDIS_URL) {
    throw new Error("Environment variable REDIS_URL is not set");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Environment variable DATABASE_URL is not set");
  }
}

async function main(): Promise<void> {
  assertRequiredEnv();

  // D-16 dark-launch flag: consumed by the scheduler plan (the upsert is
  // simply skipped when false — the queue is NEVER paused, because a paused
  // queue would block operator smoke enqueues too; Pitfall 12). Read here so
  // the boot log records the launch mode from day one.
  const schedulerEnabled = process.env.WORKER_SCHEDULER_ENABLED === "true";
  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 9090); // D-13

  const redis = workerConnection();
  const pool = workerPgPool;
  const queues = workerQueues();

  const health = await startHealthServer({
    port: healthPort,
    redis,
    pool,
    // OBS-01: the /metrics.json queue section (per-lane depth, head-waiting
    // age, stalled count, backlog drop counter) plus the Postgres breaker's
    // in-process state (RES-01 — CLOSED/OPEN/HALF_OPEN, consecutive-failure
    // count, openSince; trivially local, no extra collector needed) plus the
    // outbox section (04-07 — unsent + FAILED counts and the
    // transition-to-alert latency distribution) — lazy, collected per scrape.
    queueMetrics: async () => ({
      ...(await collectQueueMetrics(queues)),
      breaker: breakerState(),
      outbox: await collectOutboxMetrics(),
    }),
    onReady: () => {
      // The PM2 gate (wait_ready) — a DIFFERENT consumer than HTTP /readyz
      // (01-07): the signal must come from the process, not the endpoint.
      if (process.send) process.send("ready");
    },
  });

  const readiness = await health.bootReadiness;
  if (readiness.redis && readiness.db) {
    logger.info(
      {
        sha: WORKER_BUILD_SHA,
        builtAt: WORKER_BUILD_TS,
        healthPort: health.port,
        schedulerEnabled,
        pid: process.pid,
      },
      "worker booted"
    );
  } else {
    logger.error(
      { readiness, sha: WORKER_BUILD_SHA, healthPort: health.port },
      "worker boot readiness FAILED — PM2 ready signal NOT sent (wait_ready restarts after listen_timeout)"
    );
  }

  // Queue machinery (D-16): consumers ALWAYS live — any enqueued job
  // exercises the real machinery while dark-launched. Only the RECURRING
  // schedulers are flag-gated (never queue pausing — Pitfall 12: a paused
  // queue blocks operator smoke enqueues too).
  registerDrainable(queues);
  const tickWorker = startTickWorker();
  registerDrainable(tickWorker);
  // WRK-01: the check lane consumes monitor checks (SSRF fetch -> WRK-05
  // classification -> Tier 1/Tier 2 persistence); the dbWrites lane consumes
  // the Tier-2 guarded flush jobs and the flush-sweep scheduler tick.
  const checkLaneWorker = startCheckLaneWorker((job) => processCheckJob(fromLaneJob(job)));
  registerDrainable(checkLaneWorker);
  const dbWritesWorker = startDbWritesLaneWorker(makeFlushProcessor());
  registerDrainable(dbWritesWorker);
  // 04-07: the alerts lane consumes the outbox relay pass (SKIP LOCKED batch
  // claim -> byte-parity render -> send -> dedup/mark); the maintenance lane
  // consumes dry-run reports and batched retention deletes (concurrency 1).
  const alertsWorker = startAlertsLaneWorker((job) => processRelayJob(job));
  registerDrainable(alertsWorker);
  const maintenanceWorker = startMaintenanceLaneWorker((job) => processMaintenanceJob(job));
  registerDrainable(maintenanceWorker);
  try {
    const schedulers = await upsertSchedulersAtBoot({ schedulerEnabled });
    if (schedulers.upserted.length > 0) {
      logger.info({ schedulers: schedulers.upserted }, "recurring scheduling ACTIVE");
    }
  } catch (err) {
    // Stay up (04-01 fail-stay-up philosophy): the next boot/restart re-runs
    // the idempotent upserts, and the heartbeat gap covers the pause.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "job scheduler upsert FAILED — schedulers re-declare at next boot (RES-05)"
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    try {
      await drainAndTeardown({
        closeHealth: health.shutdown,
        endPool: () => pool.end(),
        quitRedis: () => redis.quit(),
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "shutdown error (proceeding to exit)"
      );
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Run only as the direct entry (`node dist/worker.js` / `tsx watch`) — a
// bare import (vitest pulling in drainAndTeardown) must not boot the
// worker. The typeof guards keep this safe in both module worlds: CJS
// bundle/dev (require.main defined) and vitest's ESM transform (undefined).
const isMainModule =
  typeof require === "function" && typeof module !== "undefined" && require.main === module;

if (isMainModule) {
  main().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "fatal worker boot");
    process.exit(1);
  });
}
