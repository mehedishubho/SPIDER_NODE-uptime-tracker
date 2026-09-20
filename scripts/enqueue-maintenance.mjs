#!/usr/bin/env node
// enqueue-maintenance.mjs — the one-shot maintenance enqueue (05-06 Task 2;
// research OQ2, D-12/WRK-13). Lets the rehearsal/cutover window observe
// maintenance and retention behavior on demand instead of waiting for the
// daily 03:15 slot, through the REAL lane the worker consumes.
//
// Usage (from the repo root):
//   node scripts/enqueue-maintenance.mjs [--wait [seconds]] [--redis URL]
//   node scripts/enqueue-maintenance.mjs --apply ...      (REAL retention run)
//   node scripts/enqueue-maintenance.mjs --help
//
//   --wait [seconds]  poll the job to completion and print its REPORT
//                     (the MaintenanceReport the processor returns — its
//                     audit feeds gate 4's recompute-report.json); default
//                     wait budget 300 s when the flag is given bare
//   --apply           WARNING: flips dryRun to false — the job RUNS REAL
//                     retention deletes (pings older than 30 days, RESOLVED
//                     incidents older than 90 days). Without it the job is a
//                     zero-write dry-run report (the default).
//   --redis URL       target Redis (default: env REDIS_URL — always pass the
//                     intended stack explicitly; never guess a stack)
//   --allow-prod      escape hatch for the production-port refusal below
//
// Stack guard: REFUSES a Redis URL whose port is the production stand-in
// (6391) or the production DB pair (5454) unless --allow-prod is explicit —
// the same split-brain discipline as the rehearsal scripts (T-05-06-04).
//
// Job contract (cross-checked against src/worker/queues.ts and
// src/worker/maintenance.ts):
//   * lane   "maintenance"           (QUEUE_NAMES.maintenance)
//   * name   "cleanup"               (processMaintenanceJob THROWS on any
//                                     other name — the plan's "named
//                                     manual-maintenance" is realized as the
//                                     jobId below, since the NAME must match
//                                     the processor's dispatch)
//   * data   { dryRun }              absent/true = zero-write report;
//                                     --apply => { dryRun: false }
//   * jobId  manual-maintenance:<mode>:<epoch-ms>  (EXACTLY 3 colon
//                                     segments — BullMQ 6's mandatory shape;
//                                     a 2-segment id throws "Custom Id
//                                     cannot contain :", caught live by this
//                                     plan's throwaway-Redis smoke; unique
//                                     per invocation, 01-08 per-enqueue-
//                                     unique semantics live in the epoch
//                                     token; the mode segment reads in Bull
//                                     Board)
//   * options mirror MAINTENANCE_JOB_OPTIONS verbatim: priority
//     LANE_PRIORITY.maintenance (5), attempts 5, exponential backoff 5000 ms,
//     removeOnComplete age 86400, removeOnFail age 604800.
//
// Zero new dependencies: bullmq + ioredis are already installed. WR-01/D-15
// (06-04): the script is a PRODUCER — it never blocks on the queue — so it
// must NOT keep the worker connection profile: maxRetriesPerRequest null lets
// queue.add() hang FOREVER against an unreachable Redis (the exact WR-01
// defect). Two bounded layers replace it: the web-producer profile (06-01's
// queue-producer.ts: maxRetriesPerRequest 1, connectTimeout/commandTimeout
// 1 s) bounds every sent command, and the ENQUEUE_DEADLINE_MS ceiling turns a
// never-ready connection into a loud non-zero exit within seconds (the
// 05-REVIEW deadline form). Fail-loud: exits non-zero on a refused stack, an
// unreachable Redis, or (with --wait) a job that fails or exceeds its budget.
// Never prints connection strings.

import IORedis from "ioredis";
import { Queue } from "bullmq";

const SCRIPT_NAME = "enqueue-maintenance.mjs";

// Transcribed from src/worker/queues.ts (change both together).
const MAINTENANCE_LANE = "maintenance"; // QUEUE_NAMES.maintenance
const MAINTENANCE_JOB_NAME = "cleanup"; // processMaintenanceJob's dispatch name
const MAINTENANCE_PRIORITY = 5; // LANE_PRIORITY.maintenance
const MAINTENANCE_JOB_OPTIONS = {
  priority: MAINTENANCE_PRIORITY,
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: { age: 604800 },
};

const REFUSED_PORT_TOKENS = [":6391", ":5454"]; // production stand-ins

// WR-01/D-15: hard ceiling on the enqueue itself. The bounded profile above
// bounds every SENT command, but a command queued while the connection never
// becomes ready is not yet "sent" — ioredis would hold it (and reconnect)
// indefinitely. The deadline turns any such never-ready state into a loud
// non-zero exit within seconds, independent of the failure mode.
const ENQUEUE_DEADLINE_MS = 5000;

/** Rejects when the wrapped promise outlives `ms` (05-REVIEW WR-01 deadline form). */
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms} ms deadline`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function usage() {
  return [
    `Usage: node scripts/${SCRIPT_NAME} [--wait [seconds]] [--redis URL]`,
    `       node scripts/${SCRIPT_NAME} --apply [--wait [seconds]] [--redis URL]`,
    "       node scripts/enqueue-maintenance.mjs --help",
    "",
    "  --wait [seconds]  wait for the job and print its REPORT (default 300 s)",
    "  --apply           REAL retention deletes (pings>30d, RESOLVED incidents>90d)",
    "  --redis URL       target Redis (default: REDIS_URL env)",
    "  --allow-prod      permit the production stand-in ports (escape hatch)",
    "",
    "Dry-run is the DEFAULT: one maintenance-lane job, zero writes. The job",
    "name/lane/data match processMaintenanceJob exactly (queues.ts contract).",
  ].join("\n");
}

function fail(message) {
  console.error(`[${SCRIPT_NAME}] FAIL: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = { apply: false, allowProd: false, wait: null, redis: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--help") {
    console.log(usage());
    process.exit(0);
  }
  if (arg === "--apply") {
    args.apply = true;
    continue;
  }
  if (arg === "--allow-prod") {
    args.allowProd = true;
    continue;
  }
  if (arg === "--wait") {
    const next = argv[i + 1];
    if (next !== undefined && /^\d+$/.test(next)) {
      args.wait = Number(next);
      i++;
    } else {
      args.wait = 300;
    }
    continue;
  }
  if (arg === "--redis") {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`--redis requires a value\n\n${usage()}`);
    args.redis = next;
    i++;
    continue;
  }
  fail(`unexpected argument "${arg}"\n\n${usage()}`);
}

const redisUrl = args.redis ?? process.env.REDIS_URL;
if (!redisUrl) {
  fail("REDIS_URL is not set — pass the intended stack explicitly (--redis URL); never guess a stack");
}
if (!args.allowProd) {
  const refused = REFUSED_PORT_TOKENS.find((token) => redisUrl.includes(token));
  if (refused) {
    fail(
      `the target Redis matches a production stand-in port (${refused}) — ` +
        "pass --allow-prod deliberately if the production stack is really intended"
    );
  }
}

// ---------------------------------------------------------------------------
// Enqueue + optional wait
// ---------------------------------------------------------------------------

const connection = new IORedis(redisUrl, {
  // Bounded producer profile (WR-01/D-15, 06-04) — NOT the worker's
  // null-retry blocking profile (src/worker/connection.ts): this script is
  // producer-only, so every command must stay rejectable. On an unreachable
  // Redis the enqueue rejects in seconds and fail() exits non-zero.
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
  commandTimeout: 1000,
  enableReadyCheck: true,
});
connection.on("error", (err) => {
  console.error(`[${SCRIPT_NAME}] connection error: ${err.message}`);
});

const queue = new Queue(MAINTENANCE_LANE, { connection });

const dryRun = !args.apply; // absent/true = zero-write report; --apply = real deletes
const jobId = `manual-maintenance:${dryRun ? "dryrun" : "apply"}:${Date.now()}`;

try {
  const job = await withDeadline(
    queue.add(MAINTENANCE_JOB_NAME, { dryRun }, { ...MAINTENANCE_JOB_OPTIONS, jobId }),
    ENQUEUE_DEADLINE_MS,
    "enqueue"
  );
  console.log(
    `JOB ${JSON.stringify({ jobId: job.id, lane: MAINTENANCE_LANE, name: MAINTENANCE_JOB_NAME, dryRun, priority: MAINTENANCE_PRIORITY })}`
  );
} catch (error) {
  fail(`enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (args.wait !== null) {
  const deadline = Date.now() + args.wait * 1000;
  let reported = false;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId).catch(() => null);
    if (job) {
      const state = await job.getState().catch(() => null);
      if (state === "completed") {
        console.log(`REPORT ${JSON.stringify(job.returnvalue ?? null)}`);
        reported = true;
        break;
      }
      if (state === "failed") {
        fail(`maintenance job FAILED: ${job.failedReason ?? "no reason recorded"}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!reported) {
    fail(`job did not complete within --wait ${args.wait} s (it may still be running — inspect the lane)`);
  }
}

try {
  await queue.close();
  await connection.quit();
} catch {
  /* teardown must never mask the result */
}
process.exit(0);
