import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import baseGlobalSetup from "./global-setup";

// ---------------------------------------------------------------------------
// Resilience-suite global setup (D-30 exclusive stack ownership, plan 04-08).
//
// The resilience run stops/starts the shared 5453/6390 docker test stack —
// while it runs, NOTHING else may use that stack (a concurrent vitest
// suite's TRUNCATE seeds or a stray worker child would corrupt both runs).
// This guard refuses to let the suite start when the stack appears in use:
//   1. a lockfile in the OS temp dir (pid-checked: a dead holder's lock is
//      stale and taken over, a live foreign holder refuses loudly);
//   2. an unexpected-connection probe — any OTHER Postgres backend attached
//      to uptime_test means someone else is mid-run right now.
// Released in the returned teardown (vitest awaits it after all tests).
//
// After acquiring ownership the setup runs the SAME schema discipline as the
// correctness suite: it imports and calls tests/setup/global-setup.ts
// (assertLocalDatabaseUrl fail-closed guard + the single drizzle-kit
// migrate runner — the DB is built by the committed migrations, never push).
// ---------------------------------------------------------------------------

const LOCK_FILE = path.join(tmpdir(), "spidernode-resilience-stack.lock.json");

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function refuse(message: string): never {
  throw new Error(
    `[D-30] resilience suite refusing to start: ${message} ` +
      `The seven injection cases take EXCLUSIVE ownership of the 5453/6390 ` +
      `docker test stack (docker-compose.test.yml) — stop the other run ` +
      `(another vitest/verify in flight, a stray worker child, an orphaned ` +
      `script) or remove '${LOCK_FILE}' if it is stale, then re-run ` +
      `pnpm test:resilience.`
  );
}

function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    let holder: { pid?: number; startedAt?: string } = {};
    try {
      holder = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    } catch {
      holder = {};
    }
    const pid = Number(holder.pid);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)) {
      refuse(
        `lockfile held by live pid ${pid} (started ${holder.startedAt ?? "unknown"}).`
      );
    }
    // Dead holder (crashed previous run) — take over the stale lock below.
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

async function assertStackIdle(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  let client: Client;
  try {
    client = new Client({ connectionString: url });
    await client.connect();
  } catch (err) {
    throw new Error(
      `[D-30] resilience suite cannot reach the test Postgres (${url.replace(/:[^:@/]+@/, ":***@")}): ` +
        `${err instanceof Error ? err.message : String(err)}. Bring the stack up first — ` +
        `docker compose -f docker-compose.test.yml up -d --wait (pnpm test:resilience does this for you).`
    );
  }
  try {
    const result = await client.query(
      `SELECT count(*)::int AS others
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`
    );
    const others = Number(result.rows[0]?.others ?? 0);
    if (others > 0) {
      refuse(
        `${others} unexpected Postgres backend(s) already connected to uptime_test — ` +
          `another suite is using the stack right now.`
      );
    }
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  acquireLock();
  await assertStackIdle();
  // Same discipline as the correctness suite: localhost guard + the single
  // drizzle-kit migrate runner over the committed migrations.
  baseGlobalSetup();
  return async () => {
    // Best-effort release — a crashed run leaves the lockfile, which the
    // pid-liveness check in acquireLock treats as stale on the next run.
    try {
      if (existsSync(LOCK_FILE)) {
        const holder = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as { pid?: number };
        if (Number(holder.pid) === process.pid) {
          rmSync(LOCK_FILE, { force: true });
        }
      }
    } catch {
      /* never fail teardown over the lockfile */
    }
  };
}
