#!/usr/bin/env node
// seed-admin-roles.mjs — the D-08/D-09/D-10 admin bootstrapping seed
// (07-01 Task 4; one-way decision ratified at the Task-3 checkpoint).
//
// Grants role='admin' to every user whose lowercase email appears in
// ADMIN_EMAILS (comma-separated roster, D-12). Run at cutover-migration time
// against the target stack — the snapshot rehearsal AND production at flip
// (D-34/D-37: the roster canary is what satisfies D-09 on the snapshot).
// It has NO runtime role after the migration (D-12); ongoing grants are
// runbook SQL (D-11).
//
// Usage (from the repo root):
//   DATABASE_URL=... ADMIN_EMAILS="ops@example.com" node scripts/seed-admin-roles.mjs
//
// Fail-loud contract (D-09, enqueue-smoke shape): exits non-zero WITHOUT
// granting when ADMIN_EMAILS is missing, empty after parsing, or matches
// ZERO users. Production can never flip with zero admins (D-09). Never
// prints connection strings; matched emails are not echoed (count only).

import "dotenv/config"; // honors .env when present; explicit process env ALWAYS wins (dotenv never overrides)
import { Client } from "pg";

function fail(message) {
  console.error(`[seed-admin-roles] FAIL: ${message}`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set — pass the target stack and roster explicitly (never guess a stack)`);
  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
const rosterRaw = requireEnv("ADMIN_EMAILS");

// D-12 parsing contract: comma-separated, trimmed, lowercased. An empty
// roster after parsing is the D-09 empty case — abort before any query runs.
const roster = rosterRaw
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry.length > 0);
if (roster.length === 0) {
  fail("ADMIN_EMAILS is empty after parsing (comma-separated emails expected) — aborting without granting (D-09)");
}

const pg = new Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});
// Idle-client 'error' events must not crash the script (enqueue-smoke shield).
pg.on("error", () => {});

let granted;
try {
  await pg.connect();
  const res = await pg.query(
    `UPDATE users SET "role" = 'admin' WHERE lower("email") = ANY($1::text[]) RETURNING "id"`,
    [roster]
  );
  granted = res.rows;
} catch (err) {
  await pg.end().catch(() => {});
  fail(`role UPDATE failed: ${err instanceof Error ? err.message : String(err)}`);
}

// Teardown before any verdict is reported — the connection must never hold
// the process open (enqueue-smoke teardown discipline).
await pg.end().catch(() => {});

// D-09: a zero-match roster is an operator mistake (typo'd email, wrong
// stack) — abort loudly so it is caught in rehearsal, never at flip.
if (granted.length === 0) {
  fail("ADMIN_EMAILS matched zero users — aborting without granting (D-09)");
}

console.log(`[seed-admin-roles] PASS: ${granted.length} admin grant(s) applied (roster entries: ${roster.length})`);
process.exit(0);
