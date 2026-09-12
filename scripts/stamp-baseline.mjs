#!/usr/bin/env node
// stamp-baseline.mjs — deterministic migration-journal stamping (03-03, D-12).
//
// Purpose: mark the committed baseline migration (drizzle/0000_baseline.sql)
// as ALREADY APPLIED on an existing database — the restored rehearsal
// snapshot and, one time, production itself — so `drizzle-kit migrate`
// never re-executes existing DDL against it (research Pattern 4, Pitfall 2).
//
// BASELINE ONLY (Pattern 4: "the stamp records 0000 — and only 0000 — as
// applied; then drizzle-kit migrate applies 0001+ everywhere"). Journal
// entries AFTER the baseline are deliberately left pending: the runner must
// be the thing that applies them (rehearsal timing evidence, 03-05/03-08's
// "runner applies 0001 exactly once"). Stamping every journal entry here
// would silently mark additive migrations as applied without ever running
// them — a fake-green deploy path.
//
// The computation mirrors the drizzle-orm 0.45.x node-postgres migrator
// EXACTLY (verified from shipped source, pg-core/dialect.js + migrator.js):
//   hash       = sha256 hex digest of the migration .sql file content (utf8)
//   created_at = the journal entry's `when` (folderMillis, epoch ms)
// The runner selects pending migrations by `folderMillis > last created_at`,
// so the stamp boundary is exact: after stamping, migrate never re-executes
// the baseline; every later journal entry remains pending for the runner.
//
// Runtime contract (D-08): plain Node ESM + pg only — zero TypeScript
// toolchain, executable on the VPS with just the prod install. Uses a
// one-shot pg Client (the migration-runner connection profile: no Pool, no
// statement_timeout — never wrapped in the web pool's timeouts).
//
// Usage: DATABASE_URL="<DIRECT connection string>" node scripts/stamp-baseline.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const MIGRATIONS_DIR = "drizzle";
const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

// Fail-loud restatement helper (tests/setup/global-setup.ts house style):
// rethrow with the cause and a remediation hint, never swallow. The
// connection string itself is deliberately never echoed (secrets stay out
// of logs and chat).
function fail(context, error) {
  throw new Error(
    `stamp-baseline failed: ${context}. ` +
      `Cause: ${error instanceof Error ? error.message : String(error)}. ` +
      `Check that DATABASE_URL points at the intended database (restored ` +
      `snapshot / production), the drizzle/ migrations folder is committed, ` +
      `and the target Postgres is reachable.`
  );
}

async function main() {
  let journal;
  try {
    journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
  } catch (error) {
    fail(`could not read migration journal at ${JOURNAL_PATH}`, error);
  }

  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    fail("migration journal has no entries — nothing to stamp", new Error("empty journal"));
  }

  // BASELINE ONLY: entry idx 0 (0000_baseline) is the stamp boundary. The
  // loop below deliberately stamps nothing after it — later entries stay
  // pending so the runner applies them for real (see header, Pattern 4).
  const baseline = journal.entries[0];
  const laterEntries = journal.entries.slice(1).map((entry) => entry.tag);
  const entriesToStamp = [baseline];

  // Pre-compute (hash, when) BEFORE connecting, so a missing/misnamed .sql
  // file fails before any database write happens.
  const stamps = entriesToStamp.map((entry) => {
    const sqlPath = `${MIGRATIONS_DIR}/${entry.tag}.sql`;
    let sql;
    try {
      sql = readFileSync(sqlPath, "utf8");
    } catch (error) {
      fail(`could not read migration file at ${sqlPath} (journal tag ${entry.tag})`, error);
    }
    // EXACT migrator computation: sha256 over the utf8 file content.
    const hash = createHash("sha256").update(sql).digest("hex");
    return { tag: entry.tag, hash, when: entry.when };
  });

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail("DATABASE_URL is not set", new Error("missing env"));
  }

  const client = new Client({ connectionString }); // one-shot, DIRECT — no Pool
  try {
    await client.connect();

    // Same bookkeeping DDL the runner itself uses (drizzle-orm 0.45.x):
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await client.query(
      `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`
    );

    for (const { tag, hash, when } of stamps) {
      // Idempotent: insert only when this exact hash is not already recorded.
      const seen = await client.query(
        "SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1",
        [hash]
      );
      if (seen.rowCount === 0) {
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [hash, when]
        );
        console.log(`stamped ${tag} (created_at=${when})`);
      } else {
        console.log(`already stamped ${tag} — skipped`);
      }
    }

    if (laterEntries.length > 0) {
      console.log(
        `left pending for the runner (NOT stamped): ${laterEntries.join(", ")}`
      );
    }
  } catch (error) {
    fail("database error while stamping", error);
  } finally {
    await client.end().catch(() => {});
  }
}

await main();
