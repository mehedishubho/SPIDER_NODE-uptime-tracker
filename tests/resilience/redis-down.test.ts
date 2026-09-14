import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
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
// RES-01 injection case 4 — REDIS DOWN (plan 04-08 Task 2).
//
// Stops the test-stack Redis container while the REAL spawned worker (with
// the D-16 scheduler ENABLED) is live and has already ticked once, then
// re-dues both monitors so the next tick WOULD fire inside the outage
// window. The case proves the pause-by-design posture (RES-01):
//   1. NO fallback scheduler exists — zero new pings during a 40 s outage
//      window (the BullMQ schedulers live in Redis; nothing else enqueues);
//   2. Postgres is untouched by the outage — the monitor/incident state
//      checksum is byte-identical before and after the window;
//   3. the worker's readiness degrades (readyz stops answering 200 while
//      Redis is unreachable);
//   4. once Redis returns, a worker boot (schedulers re-upserted at boot,
//      RES-05's contract) reclaims the due monitors and pings resume.
// ---------------------------------------------------------------------------

const PAUSED_WINDOW_MS = 40_000; // spans at least one 30 s check tick

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let pg: Client;
let admin: Redis;
const workers: WorkerHandle[] = [];
let userId: string;
let monitorIds: number[] = [];

interface Checksum {
  pings: number;
  monitors: Array<{ id: number; status: string; totalChecks: number; failedChecks: number; lastChecked: string | null }>;
  incidents: number;
}

async function checksum(): Promise<Checksum> {
  const pings = await pg.query(`SELECT count(*)::int AS n FROM pings`);
  const monitors = await pg.query(
    `SELECT id, status, "totalChecks", "failedChecks", "lastChecked" FROM monitors ORDER BY id`
  );
  const incidents = await pg.query(`SELECT count(*)::int AS n FROM incidents`);
  return {
    pings: pings.rows[0].n as number,
    monitors: monitors.rows.map((row: Record<string, unknown>) => ({
      id: row.id as number,
      status: row.status as string,
      totalChecks: row.totalChecks as number,
      failedChecks: row.failedChecks as number,
      lastChecked: (row.lastChecked as string | null) ?? null,
    })),
    incidents: incidents.rows[0].n as number,
  };
}

async function pingCount(): Promise<number> {
  const result = await pg.query(`SELECT count(*)::int AS n FROM pings`);
  return result.rows[0].n as number;
}

beforeAll(async () => {
  pg = await connectPg();
  admin = await connectAdminRedis();
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE write_guards");
  await pg.query("TRUNCATE users CASCADE");
  userId = await seedUser(pg);
});

afterAll(async () => {
  for (const w of workers) {
    if (!w.hasExited()) await w.stop().catch(() => {});
  }
  await flushWorkerKeys(admin).catch(() => {});
  await admin.quit().catch(() => {});
  await pg.end().catch(() => {});
  // Fail-loud container restoration — this case STOPPED the redis container.
  ensureStackUp();
});

describe("resilience: Redis down with the scheduler enabled", () => {
  it("pauses silently (no fallback scheduler), keeps Postgres intact, and resumes after recovery", async () => {
    monitorIds = [
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

    const first = await spawnWorker({ WORKER_SCHEDULER_ENABLED: "true" });
    workers.push(first);
    await first.waitReady();

    // The first tick has claimed + checked both due monitors.
    await waitFor(
      async () => (await pingCount()) >= 1,
      60_000,
      "redis-down: first scheduler tick produced at least one ping"
    );
    const initialPings = await pingCount();

    // Re-due both monitors — the NEXT tick would pick them up.
    await pg.query(
      `UPDATE monitors SET next_check_at = now() - interval '1 minute' WHERE id = ANY($1::int[])`,
      [monitorIds]
    );
    const before = await checksum();

    // --- the outage ---------------------------------------------------------
    dockerCompose("stop redis");
    const outageStartedAt = Date.now();

    // (3) readiness degrades: readyz no longer answers 200 — either it hangs
    // (the readiness ping never resolves against a down server) or it
    // reports redis NOT ok. Both prove the dependency gates readiness.
    let readyzObserved: "hung" | "unhealthy" | "unexpected-200" = "unexpected-200";
    try {
      const body = await first.curl<{ redis?: { ok?: boolean } }>("/readyz", 3_000);
      readyzObserved = body?.redis?.ok === false ? "unhealthy" : "unexpected-200";
    } catch {
      readyzObserved = "hung"; // fetch timeout — the ping never resolved
    }
    expect(readyzObserved).not.toBe("unexpected-200");

    // (1)+(2) the paused window: would span >=1 tick at the 30 s cadence.
    await sleep(PAUSED_WINDOW_MS);
    const after = await checksum();
    expect(after.pings).toBe(before.pings);
    expect(after.pings).toBe(initialPings);
    expect(after.incidents).toBe(before.incidents);
    expect(after.monitors).toEqual(before.monitors); // Postgres byte-intact

    // --- the recovery -------------------------------------------------------
    dockerCompose("start redis");
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
      "redis-down: Redis accepting commands again after the container restart"
    );
    await recoveryAdmin.quit().catch(() => {});

    // A worker boot re-upserts the schedulers (RES-05 boot contract) and the
    // next tick reclaims the still-due monitors.
    const replacement = await spawnWorker({ WORKER_SCHEDULER_ENABLED: "true" });
    workers.push(replacement);
    await replacement.waitReady();
    await waitFor(
      async () => (await pingCount()) > before.pings,
      90_000,
      "redis-down: pings resumed after Redis recovery and a worker boot"
    );

    recordObservations("redis-down", {
      pausedWindowMs: PAUSED_WINDOW_MS,
      pingsBefore: before.pings,
      pingsDuringPause: after.pings - before.pings,
      readyzDuringOutage: readyzObserved,
      recoveryLatencyMs: Date.now() - outageStartedAt,
      postgresIntact: true,
    });
  });
});
