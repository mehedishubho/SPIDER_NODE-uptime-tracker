#!/usr/bin/env node
// enqueue-smoke.mjs — the D-18 dark-launch / deploy-day smoke check.
//
// Enqueues EXACTLY ONE priority-1 manual check against the operator-owned
// synthetic monitor seeded by scripts/seed-synthetic.sql (D-19), through the
// SAME manual enqueue helper the web app uses (enqueueManualCheck from
// src/worker/queues.ts — imported via tsx so the .ts module resolves), then
// waits for the synchronous Tier-1 evidence ping row to appear in Postgres.
// The ping row IS the smoke evidence (D-18): a manual job always takes
// Tier 1, so a completed smoke means check-engine -> transition transaction
// -> monitors row update all worked on the deploy topology.
//
// Usage (package.json): pnpm smoke:enqueue   (== tsx scripts/enqueue-smoke.mjs)
// Env: DATABASE_URL + REDIS_URL (the deploy topology under test — the
// rehearsal passes its throwaway stack, the dark launch passes the
// production stand-ins; never ambient env alone when you mean a specific
// stack). SMOKE_TIMEOUT_MS (default 60000) bounds the WHOLE operation.
//
// Fail-loud contract: exits non-zero when the enqueue is refused (Postgres
// breaker OPEN), the monitor row is missing (seed not applied), or no NEW
// ping row lands within the timeout. Never prints connection strings.

import "dotenv/config"; // honors .env when present; explicit process env ALWAYS wins (dotenv never overrides)
import { Client } from "pg";

// Natural-key literals — mirrored in scripts/seed-synthetic.sql (change both
// together). The owner sentinel has no telegram binding, so this check can
// never page a human.
const SMOKE_OWNER_ID = "spidernode-ops-smoke";
const SMOKE_MONITOR_URL = "https://example.com/";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

// Global watchdog: covers the enqueue leg too — an enqueue that hangs (e.g.
// Redis unreachable with retry-forever clients) must fail loudly, not hang
// the deploy script.
const watchdog = setTimeout(() => {
  fail(`no smoke completion within SMOKE_TIMEOUT_MS=${TIMEOUT_MS} ms (enqueue+ping)`);
}, TIMEOUT_MS);
watchdog.unref?.();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set — pass the target stack explicitly (never guess a stack)`);
  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
const redisUrl = requireEnv("REDIS_URL");

const pg = new Client({ connectionString: databaseUrl });
// Idle client 'error' events (57P01 terminations when a stack container is
// cycled mid-deploy) must not crash the script — the next query surfaces the
// dead connection loudly. Same shield as the resilience harness clients.
pg.on("error", () => {});

let queues;
try {
  // tsx resolves the .ts module (and its @/* alias imports) the same way
  // dev:worker does — this is the "same enqueue path the worker exposes".
  queues = await import("../src/worker/queues.ts");
} catch (err) {
  fail(
    `could not import src/worker/queues.ts — run via tsx (pnpm smoke:enqueue): ${
      err instanceof Error ? err.message : String(err)
    }`
  );
}

await pg.connect();

// 1. Resolve the synthetic monitor by the seed's natural key.
const monitorRes = await pg.query(
  `SELECT id, name, status FROM monitors WHERE "userId" = $1 AND url = $2 LIMIT 1`,
  [SMOKE_OWNER_ID, SMOKE_MONITOR_URL]
);
const monitor = monitorRes.rows[0];
if (!monitor) {
  fail(`synthetic monitor not found (owner=${SMOKE_OWNER_ID}, url=${SMOKE_MONITOR_URL}) — apply scripts/seed-synthetic.sql first (D-19)`);
}
console.log(`[smoke] target: monitor id=${monitor.id} name="${monitor.name}" status=${monitor.status}`);

// 2. Baseline ping count for THIS monitor — the evidence is a NEW row, so a
//    count delta is the timezone-proof assertion (no naive-timestamp math).
const before = Number(
  (await pg.query(`SELECT count(*)::int AS n FROM pings WHERE "monitorId" = $1`, [monitor.id])).rows[0].n
);

// 3. The single priority-1 manual enqueue (D-18). enqueueManualCheck refuses
//    with BreakerOpenError when the Postgres breaker is OPEN — that refusal
//    is a deploy-relevant failure, exit non-zero.
let jobId;
try {
  ({ jobId } = await queues.enqueueManualCheck(monitor.id));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    queues.disposeWorkerQueues();
  } catch {
    /* teardown must never mask the failure */
  }
  await pg.end().catch(() => {});
  fail(`enqueueManualCheck refused (monitorId=${monitor.id}): ${message}`);
}
console.log(`[smoke] enqueued manual check jobId=${jobId} (priority 1)`);

// 4. Poll for the NEW Tier-1 evidence ping row (manual jobs are always Tier 1
//    — the row is synchronous with job completion).
const deadline = Date.now() + TIMEOUT_MS;
let latest = null;
while (Date.now() < deadline) {
  const res = await pg.query(
    `SELECT count(*)::int AS n FROM pings WHERE "monitorId" = $1`,
    [monitor.id]
  );
  if (Number(res.rows[0].n) > before) {
    latest = await pg.query(
      `SELECT status, "responseTime", "createdAt" FROM pings WHERE "monitorId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 1`,
      [monitor.id]
    );
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// 5. Teardown: dispose the queue clients (the shared ioredis connections
//    otherwise hold the process open), then report.
try {
  queues.disposeWorkerQueues();
} catch {
  /* teardown must never mask the result */
}
await pg.end().catch(() => {});

if (!latest) {
  fail(`no new ping row for monitorId=${monitor.id} within ${TIMEOUT_MS} ms (before=${before})`);
}
const row = latest.rows[0];
console.log(
  `[smoke] PASS: new evidence ping status=${row.status} responseTime=${row.responseTime}ms at ${row.createdAt.toISOString()} (jobId=${jobId})`
);
clearTimeout(watchdog);
process.exit(0);
