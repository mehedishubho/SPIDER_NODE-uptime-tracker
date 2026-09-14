import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Client } from "pg";
import { processCheckJob } from "@/worker/engine/check";
import { lockKey } from "@/worker/locks";
import {
  connectAdminRedis,
  connectPg,
  ensureStackUp,
  flushWorkerKeys,
  recordObservations,
  seedMonitor,
  seedUser,
} from "./helpers/worker-process";

// ---------------------------------------------------------------------------
// RES-01 injection case 5 — LOCK LOSS MID-JOB (plan 04-08 Task 2, D-28 #5).
//
// Externally DELETE the per-monitor lock key DURING a live check — at the
// engine's documented TEST-ONLY injectable checkpoint `checkpoints.
// beforeReverify`, which fires after classification and immediately before
// the Tier 1 ownership re-check (the exact race window the T-04-21/J-3 abort
// path guards). The case proves the §15.2 lock-lost row: the write is
// ABORTED with zero Postgres effects — no ping, no counter move, no incident,
// no outbox row — never racing a possible new owner (Pitfall 5's warning
// sign, "two ONGOING incidents", is impossible by construction here).
//
// WHY IN-PROCESS: the beforeReverify checkpoint is a ProcessCheckDeps
// injection seam (same discipline as the failing-db fakes in
// tests/worker/engine-check.test.ts) — it is the only DETERMINISTIC way to
// land a deletion inside the classification->re-verify window. A spawned
// worker could only be raced nondeterministically. Everything else in this
// case is REAL: the real engine, the real Postgres writer it would have
// called, the real Redis lock client, the real admin deletion. The subsequent
// contrast run (no interference) proves the next executor re-acquires the
// freed lock and lands the transition EXACTLY ONCE — abort never
// double-writes and never wedges the monitor.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let pg: Client;
let admin: Redis;
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
});

afterAll(async () => {
  await flushWorkerKeys(admin).catch(() => {});
  await admin.quit().catch(() => {});
  await pg.end().catch(() => {});
  // Containers were never stopped in this case, but the uniform finally
  // contract restores them loudly (rehearse-migrations convention).
  ensureStackUp();
});

describe("resilience: per-monitor lock lost between classification and the Tier 1 commit", () => {
  it("aborts the write with zero Postgres effects, logs the abort, and lets the next executor apply the transition exactly once", async () => {
    // Source pin (Pitfall 5 / T-04-21): the abort branch exists in the
    // engine AND its warn line is the greppable audit surface.
    const source = readFileSync(path.join(REPO_ROOT, "src", "worker", "engine", "check.ts"), "utf8");
    expect(source).toContain("await handle.isStillOwner()");
    expect(source).toContain("Tier 1 aborted");

    monitorId = await seedMonitor(pg, { userId, status: "PENDING", interval: 30 });
    const before = await snapshot(monitorId);
    expect(before).toMatchObject({
      status: "PENDING",
      totalChecks: 0,
      failedChecks: 0,
      pings: 0,
      incidents: 0,
      outbox: 0,
    });

    // The engine's baseLog is created at module scope — pino/sonic-boom
    // binds its write path at creation, so a process.stdout spy installed
    // later cannot observe its lines (verified empirically; a FRESH logger
    // IS captured, which is how tests/worker/logger.test.ts works). The
    // "abort logged" half of the claim is therefore pinned by the SOURCE
    // assertion above (the warn line exists at exactly the abort branch);
    // the behavioral half is the returned outcome below.
    let deletedAtHeldLock = false;
    const startedAt = Date.now();
    const result = await processCheckJob(
      {
        id: `check:${monitorId}:${Math.floor(Date.now() / 1000)}`,
        name: "check",
        data: { monitorId },
      },
      {
        checkpoints: {
          beforeReverify: async () => {
            // We are mid-job, post-classification, pre-commit: the engine
            // MUST be holding the lock right now. Delete it out from under
            // the owner — the external injection (a rogue operator DEL, a
            // Redis flush, a TTL expiry after a slow fetch).
            const held = await admin.exists(lockKey(monitorId));
            if (held === 1) {
              deletedAtHeldLock = true;
              await admin.del(lockKey(monitorId));
            }
          },
        },
      }
    );
    const abortedAt = Date.now();

    expect(deletedAtHeldLock).toBe(true);
    expect(result).toEqual({ outcome: "aborted-lock-lost" });

    // Zero Postgres effects — the abort discards the classified result
    // BEFORE applyTransition is ever called (never a partial write).
    const afterAbort = await snapshot(monitorId);
    expect(afterAbort).toEqual(before);

    // The lock key is gone (deleted externally; the owner-only release was a
    // no-op) — nothing wedged, the monitor is immediately re-checkable.
    expect(await admin.exists(lockKey(monitorId))).toBe(0);

    // Contrast leg — the next delivery re-acquires the freed lock and the
    // transition lands EXACTLY ONCE (abort never double-writes, never
    // blocks progress). Evidence parity: one delivery => one ping.
    const second = await processCheckJob(
      {
        id: `check:${monitorId}:${Math.floor(Date.now() / 1000)}`,
        name: "check",
        data: { monitorId },
      },
      {}
    );
    expect(second.outcome).toBe("tier1");
    const afterRecovery = await snapshot(monitorId);
    expect(afterRecovery.status).toBe("DOWN");
    expect(afterRecovery.totalChecks).toBe(1);
    expect(afterRecovery.failedChecks).toBe(1);
    expect(afterRecovery.pings).toBe(1);
    expect(afterRecovery.incidents).toBe(1);
    expect(afterRecovery.ongoingIncidents).toBe(1);
    expect(afterRecovery.outbox).toBe(1);

    recordObservations("lock-loss", {
      injection: "admin DEL at checkpoints.beforeReverify",
      abortedWithZeroWrites: true,
      abortOutcome: result.outcome,
      jobMsToAbort: abortedAt - startedAt,
      pingsAfterRecovery: afterRecovery.pings,
      totalChecksAfterRecovery: afterRecovery.totalChecks,
    });
  });
});
