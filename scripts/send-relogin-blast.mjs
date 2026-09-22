#!/usr/bin/env node
// send-relogin-blast.mjs — the AUTH-06 / D-01 advance re-login announcement
// blast. DELETE-AFTER-USE (D-05): ships in the flip release, runs ONCE on
// production, and is deleted in the deletion release (07-08's extended
// remnant gate keeps it out afterwards).
//
// Enqueues EXACTLY ONE email-transactional job per registered user —
// INCLUDING never-verified accounts (D-01: all registered accounts) —
// through the SAME enqueue path the app uses: renderAnnouncementEmail +
// enqueueTransactionalEmail from src/lib/email, imported via tsx so the .ts
// modules resolve (D-04: render-at-enqueue, one queue job per user). There
// is NO direct-SMTP path here by construction: the fan-out rides the
// email lane, so SMTP throttling inherits the worker's queue concurrency,
// and the console provider (EMAIL_PROVIDER=console on the target stack)
// dry-runs the entire blast locally first — the documented first-run mode
// (D-04/D-06; the operator approves the exact rendered bytes before any
// real send).
//
// Usage: pnpm exec tsx scripts/send-relogin-blast.mjs
// Env (ALL required — never guess a stack):
//   DATABASE_URL      the target Postgres (Drizzle recipient enumeration)
//   REDIS_URL         the target Redis (the email lane's queue producer)
//   BETTER_AUTH_URL   render input (the cutover's canonical origin)
//   AUTH_FLIP_DATE    render input — the switch date named in the copy
//   EMAIL_PROVIDER    optional; "console" = the documented local dry-run
//
// Fail-loud contract: exits non-zero when ANY required env is missing
// (before ANY enqueue), the TS modules cannot be imported (not run via
// tsx), the Drizzle enumeration fails, or any single enqueue rejects —
// a partial fan-out never reports success. Progress logs carry COUNTS
// only: never recipient addresses, never connection strings (T-07-07).
//
// The fan-out logic is exported (missingRequiredEnv / runBlast /
// enqueueAnnouncementForUsers) so tests/lib/relogin-blast.test.ts can
// unit-test it against a captured fake queue with no Redis; execution is
// guarded behind a main-module check so importing this file has no side
// effects.

import "dotenv/config"; // honors .env when present; explicit process env ALWAYS wins (dotenv never overrides)
import { pathToFileURL } from "node:url";

/** The fail-loud env gate: render inputs + the explicit target stack. */
export const REQUIRED_ENV = ["BETTER_AUTH_URL", "AUTH_FLIP_DATE", "DATABASE_URL", "REDIS_URL"];

/** Progress counter cadence — counts only, never addresses (T-07-07). */
export const PROGRESS_LOG_EVERY = 50;

/**
 * Names of required envs that are unset or empty. Exported + pure so the
 * unit suite proves the gate BEFORE any enqueue without spawning a process.
 */
export function missingRequiredEnv(env = process.env) {
  return REQUIRED_ENV.filter((name) => !env[name]);
}

/**
 * The fan-out: one enqueueTransactionalEmail(renderAnnouncementEmail(email))
 * per enumerated user, in order, with a per-batch progress counter and the
 * final enqueued count. ALL collaborators are injected (render, enqueue,
 * optional explicit queue client, logger) — the unit suite captures a fake
 * queue through the same seam the app exposes (enqueue.ts's deps.emailQueue).
 */
export async function enqueueAnnouncementForUsers(users, deps) {
  const { renderAnnouncementEmail, enqueueTransactionalEmail, emailQueue, log = () => {} } = deps;
  let enqueued = 0;
  for (const user of users) {
    await enqueueTransactionalEmail(renderAnnouncementEmail(user.email), emailQueue ? { emailQueue } : {});
    enqueued += 1;
    if (enqueued % PROGRESS_LOG_EVERY === 0) {
      log(`[blast] progress: ${enqueued}/${users.length} announcement job(s) enqueued`);
    }
  }
  log(`[blast] fan-out complete: ${enqueued} announcement job(s) enqueued for ${users.length} registered user(s)`);
  return enqueued;
}

/**
 * Injectable orchestration: main() calls this with real deps; the unit
 * suite injects fakes. The env gate runs BEFORE enumeration and BEFORE any
 * enqueue (D-01 ordering: no partial blast may start under a missing env).
 */
export async function runBlast(deps) {
  const { env = process.env, fail, listUsers, log = () => {}, ...fanoutDeps } = deps;
  const missing = missingRequiredEnv(env);
  if (missing.length > 0) {
    fail(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set — pass the target stack and ` +
        "render inputs explicitly (never guess a stack)"
    );
  }
  const users = await listUsers();
  if (users.length === 0) {
    fail("no registered users found — refusing to report success on an empty fan-out");
  }
  log(`[blast] enumeration complete: ${users.length} registered user(s)`);
  return enqueueAnnouncementForUsers(users, { log, ...fanoutDeps });
}

/** A blast failure distinct from infra errors — carries the operator-facing message. */
class BlastFailure extends Error {}

async function main() {
  const timeoutMs = Number(process.env.BLAST_TIMEOUT_MS ?? 600_000);
  const watchdog = setTimeout(() => {
    console.error(`[blast] FAIL: no completion within BLAST_TIMEOUT_MS=${timeoutMs} ms (enumerate + fan-out)`);
    process.exit(1);
  }, timeoutMs);
  watchdog.unref?.();

  // Env gate FIRST — fail before importing anything, constructing pools, or
  // opening sockets. Same requireEnv posture as enqueue-smoke.mjs.
  const missing = missingRequiredEnv();
  if (missing.length > 0) {
    console.error(
      `[blast] FAIL: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set — pass the target ` +
        "stack and render inputs explicitly (never guess a stack)"
    );
    process.exit(1);
  }

  let renderModule;
  let enqueueModule;
  let dbModule;
  let schemaModule;
  try {
    // tsx resolves the .ts modules (and their @/* alias imports) the same way
    // dev:worker does — the SAME render/enqueue path the app uses (D-04).
    [renderModule, enqueueModule, dbModule, schemaModule] = await Promise.all([
      import("../src/lib/email/render.ts"),
      import("../src/lib/email/enqueue.ts"),
      import("../src/db/index.ts"),
      import("../src/db/schema.ts"),
    ]);
  } catch (err) {
    console.error(
      `[blast] FAIL: could not import the email/db TS modules — run via tsx ` +
        `(pnpm exec tsx scripts/send-relogin-blast.mjs): ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  const { renderAnnouncementEmail } = renderModule;
  const { enqueueTransactionalEmail, disposeWebQueueProducer } = enqueueModule;
  const { db } = dbModule;
  const { users } = schemaModule;

  let enqueued = 0;
  let failure = null;
  try {
    enqueued = await runBlast({
      fail: (message) => {
        throw new BlastFailure(message);
      },
      listUsers: async () => {
        // Drizzle recipient enumeration (D-01: ALL registered accounts — the
        // SELECT has no WHERE, so never-verified users are included). Ordered
        // by signup for deterministic progress logs.
        return db.select({ email: users.email }).from(users).orderBy(users.createdAt);
      },
      renderAnnouncementEmail,
      enqueueTransactionalEmail,
      log: (message) => console.log(message),
    });
  } catch (err) {
    failure = err;
  }

  // Teardown BEFORE reporting (enqueue-smoke discipline): dispose the queue
  // clients and end the shared pool so no connection holds the process open.
  // Teardown must never mask the outcome.
  try {
    disposeWebQueueProducer();
  } catch {
    /* teardown must never mask the result */
  }
  try {
    const { pgPool } = await import("../src/lib/db-pool.ts");
    await pgPool.end();
  } catch {
    /* teardown must never mask the result */
  }
  clearTimeout(watchdog);

  if (failure !== null) {
    console.error(`[blast] FAIL: ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exit(1);
  }
  console.log(`[blast] PASS: ${enqueued} announcement email(s) enqueued`);
  process.exit(0);
}

// Main-module guard: run only when invoked directly (tsx/node
// scripts/send-relogin-blast.mjs); vitest imports stay side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
