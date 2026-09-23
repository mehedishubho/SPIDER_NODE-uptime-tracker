#!/usr/bin/env node
// rehearse-migrations.mjs — the orchestrated migration rehearsal (03-05, D-12, DRZ-06).
//
// One typed command replays the exact production migration path against real
// (anonymized) production data and refuses to pass unless every row and
// checksum survives untouched:
//
//   pnpm rehearse:migrations [path/to/prod-dump.dump]
//
// Pipeline (research Pattern 4; every step fail-loud, teardown in finally):
//   0.  pre-flight: container-name collision check, port pre-check (docker ps
//       + TCP probe — never touches sibling stacks, T-03-13), dump discovery
//       (explicit argv path, else the NEWEST .snapshots/prod-*.dump by mtime)
//   1.  docker run throwaway postgres:17-alpine (matches the source major
//       recorded in 03-03) on port 5460 — isolated from the vitest stack (5453)
//   2.  pg_restore via docker exec (-i, --no-owner --no-privileges
//       --exit-on-error — pg_restore would otherwise CONTINUE on errors)
//   3.  scripts/anonymize-snapshot.mjs (deterministic md5 masking, D-10)
//       + sanity probe: every users.email must be @anon.test afterwards
//   4.  BEFORE metrics: per-table row count + deterministic digest (below)
//   5.  scripts/stamp-baseline.mjs — marks 0000_baseline applied (baseline
//       ONLY; 0001 stays pending for the runner — 03-04's fixed boundary)
//   4.5 structure snapshot BEFORE the migrate: public tables/columns/indexes
//       + pg_dump --schema-only line inventory (taken after the stamp so the
//       drizzle bookkeeping schema is identical on both sides of the diff)
//   6.  timed `pnpm exec drizzle-kit migrate` (wall clock) with per-statement
//       durations captured via pg_stat_statements (preloaded at container
//       start, reset immediately before the timed migrate) — its utility hook
//       fires PER STATEMENT inside the real migrate, so each CREATE INDEX
//       build is timed individually (the D-19 evidence). The docker server
//       log (log_min_duration_statement = 0) is kept as an auxiliary probe:
//       it logs one duration per query STRING, and the migrator submits the
//       whole migration file as a single multi-statement string, so it can
//       show transaction shape but NOT per-index timings.
//   7.  AFTER metrics — identical rules; any count/digest mismatch outside
//       the carve-out exits non-zero naming the offending table (T-03-12)
//   8.  additive-only assertion: the DDL delta may contain ONLY new tables /
//       columns / indexes; dropped or renamed objects, changed index
//       definitions, or type/nullability changes on existing columns exit
//       non-zero. Column DEFAULT changes are recorded but do not fail (0001
//       legitimately SETs gen_random_uuid()::text defaults — 03-04 inventory).
//   9.  evidence file: .snapshots/rehearsal-YYYYMMDD.md (+ .json) with
//       per-table counts + digests, the carve-out label, the DDL delta
//       summary, timings, journal row count, and the derived D-19 decision;
//       then a committable copy at
//       .planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-YYYYMMDD.md
//       (counts + digests only — ZERO PII by construction, T-03-11)
//   10. docker rm -f — in a finally block, on success AND failure
//
// DIGEST DEFINITION (the documented checksum helper — discretion item; stable):
//   digest(table) = md5( string_agg( md5( ROW(<pinned column inventory>)::text ),
//                                     '' ORDER BY id ) )
//   with the literal '<empty>' substituted when the table has zero rows.
//   The pinned inventory per table is the PRE-migration column set from
//   src/db/schema.ts (the 0000 baseline set), used identically BEFORE and
//   AFTER. Columns that migration 0001 adds are therefore outside the digest
//   by construction — this is the SANCTIONED-WRITE CARVE-OUT (research Open
//   Question 4): monitors.next_check_at (0001's backfill legitimately writes
//   it) and monitors.consecutive_failures, plus pings.error_class/status_code
//   (additive NULL columns — a whole-row t.*::text digest would false-fail on
//   ANY added column, sanctioned or not). Their additive-only arrival is
//   asserted separately by the step-8 DDL delta. A future migration that
//   writes data into a NEW column must extend this carve-out list (Phase 7's
//   rehearsal reuses this script — D-10 repeatability) — and Phase 7 DID:
//   CARVE_OUT_0002 below names the 0002_better_auth_cutover objects.
//
// BOOKKEEPING EVIDENCE (WR-05 closure): the evidence file's journal-row line
// is count-agnostic — it reports the actual drizzle.__drizzle_migrations row
// count N alongside the expectation DERIVED from drizzle/meta/_journal.json
// (1 stamped baseline + entries.length - 1 runner-applied = entries.length),
// never a hard-coded Phase-3 count. Later phases add journal entries and the
// evidence line follows automatically (D-10 repeatability).
//
// Runtime contract: plain Node ESM + pg (zero new deps). The rehearsal
// DATABASE_URL is the throwaway container's (postgres:postgres@localhost) —
// safe to construct here; the PRODUCTION-derived dump stays inside
// gitignored .snapshots/ and is never echoed. Run from the repo root.

import { execSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { Client } from "pg";

const PORT = 5460; // recorded free by 03-03; isolated from the 5453 vitest stack
const CONTAINER = "spidernode-rehearse";
const IMAGE = "postgres:17-alpine"; // source PostgreSQL major recorded in 03-03 (17.7)
const DB = "uptime_rehearse";
const REHEARSAL_URL = `postgres://postgres:postgres@localhost:${PORT}/${DB}`;
const SNAPSHOTS_DIR = ".snapshots";
const PHASE_EVIDENCE_DIR = ".planning/phases/03-redis-drizzle-schema-ownership";
const D19_THRESHOLD_MS = 1000; // "sub-second" index builds keep plain CREATE INDEX (D-19)

// Pinned pre-migration column inventories (src/db/schema.ts — live column
// names, quoted where the DDL spells camelCase). carveOut marks the tables
// whose 0001-added columns are excluded from the digest (see header).
const DIGEST_TABLES = [
  { table: "accounts", columns: ["id", "userId", "type", "provider", "providerAccountId", "refresh_token", "access_token", "expires_at", "token_type", "scope", "id_token", "session_state"] },
  { table: "feedbacks", columns: ["id", "userId", "type", "title", "description", "status", "upvotes", "createdAt", "updatedAt"] },
  { table: "incidents", columns: ["id", "monitorId", "status", "description", "startedAt", "resolvedAt"] },
  { table: "monitors", carveOut: true, columns: ["id", "url", "name", "status", "isActive", "interval", "lastChecked", "responseTime", "uptimePercent", "totalChecks", "failedChecks", "userId", "createdAt", "updatedAt"] },
  { table: "password_reset_tokens", columns: ["id", "email", "token", "expires"] },
  { table: "pings", carveOut: true, columns: ["id", "monitorId", "status", "responseTime", "createdAt"] },
  { table: "sessions", columns: ["id", "sessionToken", "userId", "expires"] },
  { table: "users", columns: ["id", "name", "email", "emailVerified", "image", "password", "telegramChatId", "timezone", "createdAt", "updatedAt"] },
  { table: "verification_tokens", columns: ["id", "email", "token", "expires"] },
];

// SANCTIONED-WRITE CARVE-OUT, Phase-7 extension (0002_better_auth_cutover —
// the 03-REVIEW WR-05 carry-forward's inventory half). The 0002 migration's
// additive arrivals, NAMED here so the evidence labels stay truthful — this
// extends the list, never the pipeline structure (03-05 precedent):
//   - users.role + users.email_verified are 0002-ADDED columns that migration
//     time WRITES (the D-08 role default and the D-23 boolean backfill from
//     the legacy "emailVerified" timestamp). They sit outside users' pinned
//     pre-migration inventory above by construction — the same mechanism that
//     keeps 0001's carve-out columns out — so the users digest stays EQUAL
//     across the migrate. The admin-plugin columns users.banned/banReason/
//     banExpires ride outside the digest the same way.
//   - The three new Better Auth tables have no BEFORE baseline, so they are
//     not digestable before/after; the existing new-tables path counts them
//     post-migrate (with their pinned inventories recorded in the evidence)
//     and the step-8 DDL delta asserts their additive arrival. The column
//     inventories below are pinned from src/db/schema.ts exactly like
//     DIGEST_TABLES — a documentation/labeling contract, consumed by the
//     evidence renderer, never by the digest pipeline.
const CARVE_OUT_0002_TABLES = [
  { table: "account", columns: ["id", "userId", "providerId", "accountId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"] },
  { table: "session", columns: ["id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt", "impersonatedBy"] },
  { table: "verification", columns: ["id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"] },
];
const CARVE_OUT_0002_USER_COLUMNS = ["users.role", "users.email_verified"];

function fail(context, error) {
  throw new Error(
    `rehearse-migrations failed: ${context}. ` +
      `Cause: ${error instanceof Error ? error.message : String(error)}.`
  );
}

function run(command, options = {}) {
  return execSync(command, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Step 0 pre-flight
// ---------------------------------------------------------------------------

function checkContainerNameFree() {
  let names = "";
  try {
    names = run(`docker ps -a --format "{{.Names}}"`);
  } catch (error) {
    fail("could not list docker containers (is Docker Desktop running?)", error);
  }
  if (names.split(/\r?\n/).includes(CONTAINER)) {
    fail(
      `a container named ${CONTAINER} already exists (orphaned from a previous run)`,
      new Error("name collision — remove it first: docker rm -f " + CONTAINER)
    );
  }
}

function checkDockerPortHeld() {
  let ports = "";
  try {
    ports = run(`docker ps --format "{{.Names}} {{.Ports}}"`);
  } catch (error) {
    fail("could not list docker containers (is Docker Desktop running?)", error);
  }
  const holder = ports
    .split(/\r?\n/)
    .filter((line) => line.includes(`:${PORT}->`));
  if (holder.length > 0) {
    fail(
      `rehearsal port ${PORT} is already published by another container`,
      new Error(`held by: ${holder.join("; ")} — refusing to touch sibling stacks`)
    );
  }
}

async function probePortFree() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(PORT, "127.0.0.1");
  });
}

function listSnapshotsDir() {
  try {
    return readdirSync(SNAPSHOTS_DIR)
      .map((name) => {
        const stat = statSync(`${SNAPSHOTS_DIR}/${name}`);
        return `  ${name} (${stat.size} bytes, mtime ${stat.mtime.toISOString()})`;
      })
      .join("\n");
  } catch {
    return `  (${SNAPSHOTS_DIR}/ does not exist)`;
  }
}

function discoverDump() {
  const explicit = process.argv[2];
  if (explicit) {
    if (!existsSync(explicit) || statSync(explicit).size === 0) {
      fail(
        `dump path argument "${explicit}" does not exist or is empty`,
        new Error(
          `expected a pg_dump custom-format (-F c) production dump.\n` +
            `Current ${SNAPSHOTS_DIR}/ contents:\n${listSnapshotsDir()}`
        )
      );
    }
    return explicit;
  }
  let candidates = [];
  try {
    candidates = readdirSync(SNAPSHOTS_DIR)
      .filter((name) => /^prod-.*\.dump$/.test(name))
      .map((name) => ({
        name,
        path: `${SNAPSHOTS_DIR}/${name}`,
        mtimeMs: statSync(`${SNAPSHOTS_DIR}/${name}`).mtimeMs,
        size: statSync(`${SNAPSHOTS_DIR}/${name}`).size,
      }))
      .filter((c) => c.size > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  } catch (error) {
    fail(`could not read ${SNAPSHOTS_DIR}/`, error);
  }
  if (candidates.length === 0) {
    fail(
      `no non-empty ${SNAPSHOTS_DIR}/prod-*.dump found`,
      new Error(
        `take a FRESH production dump first (D-11), or pass an explicit path:\n` +
          `  pnpm rehearse:migrations path/to/prod-dump.dump\n` +
          `Current ${SNAPSHOTS_DIR}/ contents:\n${listSnapshotsDir()}`
      )
    );
  }
  console.log(
    `discovered dump: ${candidates[0].path} (${candidates[0].size} bytes, ` +
      `newest of ${candidates.length} candidate(s))`
  );
  return candidates[0].path;
}

// ---------------------------------------------------------------------------
// Metrics (steps 4 and 7) + structure snapshots (step 4.5 / step 8)
// ---------------------------------------------------------------------------

function digestQuery({ table, columns }) {
  const rowExpr = `ROW(${columns.map((c) => `t."${c}"`).join(", ")})::text`;
  return (
    `SELECT count(*)::text AS count, ` +
    `md5(COALESCE(string_agg(md5(${rowExpr}), '' ORDER BY t."id"), '<empty>')) AS digest ` +
    `FROM "${table}" t`
  );
}

async function collectMetrics(client) {
  const metrics = {};
  for (const spec of DIGEST_TABLES) {
    const result = await client.query(digestQuery(spec));
    metrics[spec.table] = {
      count: result.rows[0].count,
      digest: result.rows[0].digest,
    };
  }
  return metrics;
}

async function collectStructure(client) {
  const tables = (
    await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    )
  ).rows.map((r) => r.tablename);

  const columns = (
    await client.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable,
              character_maximum_length, numeric_precision, numeric_scale,
              datetime_precision, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`
    )
  ).rows;

  const indexes = (
    await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`
    )
  ).rows;

  const pgDumpLines = run(
    `docker exec ${CONTAINER} pg_dump -U postgres -d ${DB} --schema-only --no-owner`
  )
    .split(/\r?\n/)
    .filter((line) => /^(CREATE|ALTER)\s/.test(line.trim()));

  return { tables, columns, indexes, pgDumpLines };
}

// ---------------------------------------------------------------------------
// Step 8: additive-only assertion over the two structure snapshots
// ---------------------------------------------------------------------------

function assertAdditiveOnly(before, after) {
  const problems = [];
  const summary = {
    addedTables: [],
    removedTables: [],
    addedColumns: [],
    removedColumns: [],
    changedColumns: [],
    defaultChanges: [],
    addedIndexes: [],
    removedIndexes: [],
    changedIndexes: [],
    pgDumpAddedLines: [],
    pgDumpRemovedLines: [],
  };

  const beforeTables = new Set(before.tables);
  const afterTables = new Set(after.tables);
  for (const t of beforeTables) {
    if (!afterTables.has(t)) {
      summary.removedTables.push(t);
      problems.push(`table dropped: ${t}`);
    }
  }
  for (const t of afterTables) {
    if (!beforeTables.has(t)) summary.addedTables.push(t);
  }

  const colKey = (c) => `${c.table_name}.${c.column_name}`;
  const colAttrs = (c) =>
    JSON.stringify([
      c.data_type, c.udt_name, c.is_nullable, c.character_maximum_length,
      c.numeric_precision, c.numeric_scale, c.datetime_precision,
    ]);
  const beforeCols = new Map(before.columns.map((c) => [colKey(c), c]));
  for (const afterCol of after.columns) {
    const key = colKey(afterCol);
    const beforeCol = beforeCols.get(key);
    if (!beforeCol) {
      summary.addedColumns.push(key);
      continue;
    }
    if (colAttrs(beforeCol) !== colAttrs(afterCol)) {
      summary.changedColumns.push(`${key}: ${colAttrs(beforeCol)} -> ${colAttrs(afterCol)}`);
      problems.push(`existing column changed (type/nullability/precision): ${key}`);
    }
    if (beforeCol.column_default !== afterCol.column_default) {
      // Recorded, not fatal: 0001 legitimately SETs gen_random_uuid()::text
      // defaults on existing text PKs (03-04 inventory; catalog-only).
      summary.defaultChanges.push(`${key}: ${beforeCol.column_default ?? "NULL"} -> ${afterCol.column_default ?? "NULL"}`);
    }
  }
  for (const [key] of beforeCols) {
    if (!after.columns.some((c) => colKey(c) === key)) {
      summary.removedColumns.push(key);
      problems.push(`column dropped: ${key}`);
    }
  }

  const beforeIdx = new Map(before.indexes.map((i) => [i.indexname, i.indexdef]));
  const afterIdxNames = new Set(after.indexes.map((i) => i.indexname));
  for (const [name, def] of beforeIdx) {
    if (!afterIdxNames.has(name)) {
      summary.removedIndexes.push(name);
      problems.push(`index dropped: ${name}`);
    }
  }
  for (const idx of after.indexes) {
    if (!beforeIdx.has(idx.indexname)) {
      summary.addedIndexes.push(idx.indexname);
    } else if (beforeIdx.get(idx.indexname) !== idx.indexdef) {
      summary.changedIndexes.push(idx.indexname);
      problems.push(`index definition changed: ${idx.indexname}`);
    }
  }

  const beforeLines = new Set(before.pgDumpLines);
  const afterLines = new Set(after.pgDumpLines);
  for (const line of beforeLines) {
    if (!afterLines.has(line)) {
      summary.pgDumpRemovedLines.push(line.trim());
      problems.push(`pg_dump statement disappeared: ${line.trim().slice(0, 120)}`);
    }
  }
  for (const line of afterLines) {
    if (!beforeLines.has(line)) summary.pgDumpAddedLines.push(line.trim());
  }

  return { problems, summary };
}

// ---------------------------------------------------------------------------
// Step 6: timing — pg_stat_statements (per statement) + docker server log
// (per query string, auxiliary)
// ---------------------------------------------------------------------------

// Per-STATEMENT durations from inside the real migrate run. pg_stat_statements
// hooks fire for every statement individually (utility statements included —
// CREATE INDEX builds are timed whole), which the server log cannot do: the
// migrator submits the entire migration file as ONE multi-statement simple-
// protocol string, and postgres logs a single duration for that whole string.
async function collectIndexBuildTimings(client) {
  const result = await client.query(
    `SELECT regexp_replace(query, E'[\\n\\r]+', ' ', 'g') AS statement,
            calls,
            round(total_exec_time::numeric, 3)::float8 AS ms
       FROM pg_stat_statements
      WHERE query ~* '^\\s*CREATE\\s+(UNIQUE\\s+)?INDEX'
      ORDER BY total_exec_time DESC`
  );
  return result.rows.map((r) => ({
    statement: r.statement,
    calls: r.calls,
    ms: r.ms,
  }));
}

function parseStatementTimings() {
  let logs = "";
  try {
    logs = run(`docker logs ${CONTAINER} 2>&1`);
  } catch (error) {
    fail("could not read docker logs for statement timings", error);
  }
  const timings = [];
  for (const match of logs.matchAll(/duration: ([0-9.]+) ms\s+statement: ([^\r\n]+)/g)) {
    timings.push({ statement: match[2].trim(), ms: parseFloat(match[1]) });
  }
  return timings;
}

// ---------------------------------------------------------------------------
// Step 9: evidence
// ---------------------------------------------------------------------------

function writeEvidence(evidence) {
  const day = evidence.day; // YYYYMMDD
  const localMd = `${SNAPSHOTS_DIR}/rehearsal-${day}.md`;
  const localJson = `${SNAPSHOTS_DIR}/rehearsal-${day}.json`;
  const phaseCopy = `${PHASE_EVIDENCE_DIR}/03-REHEARSAL-EVIDENCE-${day}.md`;

  const md = renderEvidenceMarkdown(evidence);
  writeFileSync(localMd, md, "utf8");
  writeFileSync(localJson, JSON.stringify(evidence, null, 2), "utf8");
  copyFileSync(localMd, phaseCopy);
  console.log(`evidence written: ${localMd} (+ .json)`);
  console.log(`committable copy:  ${phaseCopy}`);
}

function renderEvidenceMarkdown(e) {
  const lines = [];
  lines.push(`# Migration rehearsal evidence — ${e.day}`);
  lines.push("");
  lines.push(`Generated by \`pnpm rehearse:migrations\` (scripts/rehearse-migrations.mjs, D-12).`);
  lines.push(`Counts + digests only — zero PII by construction (T-03-11).`);
  lines.push("");
  lines.push(`- **Dump:** ${e.dump.name} (${e.dump.bytes} bytes, custom -F c format)`);
  lines.push(`- **Container:** ${e.container.image}, name \`${e.container.name}\`, port ${e.container.port}, db \`${e.container.db}\` — torn down after the run`);
  lines.push(`- **Verdict:** ${e.verdict}`);
  lines.push("");
  lines.push(`## Digest definition (checksum helper)`);
  lines.push("");
  lines.push("digest(table) = md5( string_agg( md5( ROW(<pinned pre-migration column inventory>)::text ), '' ORDER BY id ) ), '<empty>' substituted for zero rows.");
  lines.push("");
  lines.push(`**SANCTIONED-WRITE CARVE-OUT (research Open Question 4):** the digest is computed over each table's pre-migration column inventory from src/db/schema.ts, so migration 0001's added columns are outside the digest — ${e.carveOut}. Their additive-only arrival is asserted by the DDL delta below. Row counts remain full-table and unconditional.`);
  lines.push("");
  lines.push(`## Per-table metrics (BEFORE vs AFTER migrate)`);
  lines.push("");
  lines.push(`| Table | Rows (before) | Rows (after) | Digest match | Note |`);
  lines.push(`|---|---|---|---|---|`);
  for (const row of e.tables) {
    lines.push(`| ${row.table} | ${row.before.count} | ${row.after.count} | ${row.digestMatch ? "EQUAL" : "**CHANGED**"} | ${row.note} |`);
  }
  lines.push("");
  lines.push("Digests (md5, BEFORE == AFTER):");
  for (const row of e.tables) {
    lines.push(`- ${row.table}: \`${row.before.digest}\`${row.digestMatch ? "" : ` -> \`${row.after.digest}\` (MISMATCH)`}`);
  }
  lines.push("");
  lines.push(`## New tables (no BEFORE baseline — additive arrival)`);
  lines.push("");
  if (e.newTables.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of e.newTables) {
      lines.push(
        `- ${t.table}: ${t.afterCount} row(s) after migrate` +
          (t.pinnedInventory
            ? ` (0002 pinned inventory: ${t.pinnedInventory.join(", ")})`
            : "")
      );
    }
  }
  lines.push("");
  lines.push(`## DDL delta (additive-only assertion)`);
  lines.push("");
  const d = e.ddlDelta;
  lines.push(`- Added tables: ${d.addedTables.length ? d.addedTables.join(", ") : "none"}`);
  lines.push(`- Removed tables: ${d.removedTables.length ? d.removedTables.join(", ") + " **(FATAL)**" : "none"}`);
  lines.push(`- Added columns: ${d.addedColumns.length ? d.addedColumns.join(", ") : "none"}`);
  lines.push(`- Removed columns: ${d.removedColumns.length ? d.removedColumns.join(", ") + " **(FATAL)**" : "none"}`);
  lines.push(`- Changed existing columns (type/nullability/precision): ${d.changedColumns.length ? d.changedColumns.join("; ") + " **(FATAL)**" : "none"}`);
  lines.push(`- Column default changes (recorded, sanctioned — 0001's gen_random_uuid()::text pins): ${d.defaultChanges.length ? d.defaultChanges.join("; ") : "none"}`);
  lines.push(`- Added indexes: ${d.addedIndexes.length ? d.addedIndexes.join(", ") : "none"}`);
  lines.push(`- Removed/changed indexes: ${[...d.removedIndexes, ...d.changedIndexes].length ? [...d.removedIndexes, ...d.changedIndexes].join(", ") + " **(FATAL)**" : "none"}`);
  lines.push(`- pg_dump schema-only statement delta: +${d.pgDumpAddedLines.length} added / -${d.pgDumpRemovedLines.length} removed lines`);
  if (d.pgDumpAddedLines.length) {
    lines.push("");
    lines.push("Added pg_dump statements:");
    for (const l of d.pgDumpAddedLines) lines.push(`  - \`${l.slice(0, 160)}\``);
  }
  lines.push("");
  lines.push(`## Timing (D-19 evidence)`);
  lines.push("");
  lines.push(`- \`drizzle-kit migrate\` wall time: **${e.timings.migrateWallMs} ms**`);
  lines.push(`- Per-statement probe: pg_stat_statements (server-side, per statement inside the real migrate run; stats reset immediately before)`);
  for (const t of e.timings.indexBuilds) {
    lines.push(`- Index build: \`${t.statement.slice(0, 120)}\` — ${t.ms} ms`);
  }
  // WR-05: count-agnostic bookkeeping evidence — the actual row count N plus
  // the expectation derived from drizzle/meta/_journal.json, never a
  // hard-coded Phase-3 count or prose (later phases add journal entries and
  // this line follows automatically).
  const bk = e.bookkeeping;
  const bkDerivation =
    `${bk.journalExpected} = 1 stamped baseline + ${bk.journalExpected - 1} runner-applied ` +
    `(derived from drizzle/meta/_journal.json entries)`;
  const bkNote =
    bk.journalRows === bk.journalExpected
      ? `matches the journal-derived expectation (${bkDerivation})`
      : `**MISMATCH** — expected ${bkDerivation}`;
  lines.push(
    `- Bookkeeping rows after migrate (drizzle.__drizzle_migrations): **${bk.journalRows}** — ${bkNote}`
  );
  lines.push("");
  lines.push(`## D-19 decision`);
  lines.push("");
  lines.push(e.d19.decision);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

let containerStarted = false;

async function main() {
  if (!existsSync("drizzle/meta/_journal.json")) {
    fail("drizzle/meta/_journal.json not found — run from the repository root", new Error("wrong cwd"));
  }

  const failures = [];
  let dumpPath;

  // Step 0: pre-flight — name, port, dump. All abort BEFORE any side effect.
  checkContainerNameFree();
  checkDockerPortHeld();
  if (!(await probePortFree())) {
    fail(
      `rehearsal port ${PORT} is held by a non-docker listener`,
      new Error("TCP probe could not bind — free the port or adjust PORT in scripts/rehearse-migrations.mjs")
    );
  }
  dumpPath = discoverDump();
  const dumpBytes = statSync(dumpPath).size;
  const dumpName = dumpPath.split(/[\\/]/).pop();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // Step 1: throwaway container + readiness wait.
  console.log(`[1/10] starting throwaway container ${CONTAINER} (${IMAGE}, port ${PORT})...`);
  try {
    run(
      // Postgres server flags go AFTER the image name (container command) —
      // before it, `-c` would be consumed by docker itself (--cpu-shares).
      // Loopback-only publish (WR-02): the full production dump is restored
      // BEFORE anonymization runs, so the container must never be reachable
      // off-host. docker exec and the localhost REHEARSAL_URL below are
      // unaffected by the 127.0.0.1 bind.
      `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=${DB} -p 127.0.0.1:${PORT}:5432 ` +
        `${IMAGE} -c shared_preload_libraries=pg_stat_statements`,
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    containerStarted = true;
  } catch (error) {
    fail(`docker run failed for ${CONTAINER}`, error);
  }
  let ready = false;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      run(`docker exec ${CONTAINER} pg_isready -U postgres -d ${DB}`, { stdio: "ignore" });
      ready = true;
      break;
    } catch {
      await sleep(1000);
    }
  }
  if (!ready) fail("postgres did not become ready within 30s", new Error("pg_isready timeout"));

  // Step 2: restore via the container's pg_restore binaries.
  console.log(`[2/10] restoring ${dumpName} via docker exec pg_restore...`);
  try {
    run(
      `docker exec -i ${CONTAINER} pg_restore -U postgres -d ${DB} --no-owner --no-privileges --exit-on-error`,
      { input: readFileSync(dumpPath), stdio: ["pipe", "pipe", "inherit"] }
    );
  } catch (error) {
    fail("pg_restore failed (dump corrupt, wrong format, or not a -F c dump)", error);
  }
  console.log("restore complete (exit 0, --exit-on-error)");

  // Step 3: anonymize + sanity probe.
  console.log("[3/10] anonymizing snapshot (deterministic md5 masking)...");
  try {
    run("node scripts/anonymize-snapshot.mjs", {
      env: { ...process.env, DATABASE_URL: REHEARSAL_URL },
      stdio: "inherit",
    });
  } catch (error) {
    fail("anonymize-snapshot.mjs failed", error);
  }

  const client = new Client({ connectionString: REHEARSAL_URL });
  try {
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");

    // Per-statement timing probe (D-19): the extension is created BEFORE any
    // structure snapshot so its view is present symmetrically in both the
    // BEFORE and AFTER snapshots and never pollutes the additive-only delta.
    // Preloading happened at docker run (-c shared_preload_libraries=...).
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    console.log("pg_stat_statements loaded (per-statement D-19 probe)");

    // D-37 canary carve-out: with CANARY_EMAIL set, exactly ONE real email is
    // sanctioned on the snapshot — the designated canary (which the anonymizer
    // wrote). Any other non-anon email, or more than one, still fails. With
    // no CANARY_EMAIL the strict all-anon rule applies unchanged.
    const nonAnonRows = (
      await client.query(`SELECT email FROM users WHERE email NOT LIKE '%@anon.test'`)
    ).rows;
    if (process.env.CANARY_EMAIL) {
      const canaryOk =
        nonAnonRows.length === 1 &&
        nonAnonRows[0].email === process.env.CANARY_EMAIL;
      if (!canaryOk) {
        fail(
          "anonymization sanity probe failed",
          new Error(
            `expected exactly the designated D-37 canary (${process.env.CANARY_EMAIL}) as the ` +
              `only non-anon users.email — found ${nonAnonRows.length} non-anon row(s)`
          )
        );
      }
      console.log(
        "anonymization sanity probe passed (exactly the designated D-37 canary keeps its real email)"
      );
    } else {
      if (nonAnonRows.length > 0) {
        fail(
          "anonymization sanity probe failed",
          new Error(`${nonAnonRows.length} users.email rows are not @anon.test`)
        );
      }
      console.log("anonymization sanity probe passed (0 non-anon users.email)");
    }

    // Step 4: BEFORE metrics.
    console.log("[4/10] collecting BEFORE metrics (counts + digests)...");
    const beforeMetrics = await collectMetrics(client);

    // Step 5: stamp the baseline row (0000 only — 0001 stays pending).
    console.log("[5/10] stamping baseline (0000 applied; 0001 pending for the runner)...");
    try {
      run("node scripts/stamp-baseline.mjs", {
        env: { ...process.env, DATABASE_URL: REHEARSAL_URL },
        stdio: "inherit",
      });
    } catch (error) {
      fail("stamp-baseline.mjs failed", error);
    }

    // Step 4.5: structure snapshot BEFORE the migrate (after the stamp so the
    // drizzle bookkeeping schema is identical on both sides of the diff).
    console.log("[4.5/10] capturing structure snapshot BEFORE migrate...");
    const beforeStructure = await collectStructure(client);

    // Step 6: per-statement duration capture + timed migrate.
    await client.query(`ALTER DATABASE ${DB} SET log_min_duration_statement = 0`);
    await client.query("SELECT pg_stat_statements_reset()"); // timings = this migrate only
    console.log("[6/10] running timed `pnpm exec drizzle-kit migrate`...");
    const migrateStart = Date.now();
    try {
      run("pnpm exec drizzle-kit migrate", {
        env: { ...process.env, DATABASE_URL: REHEARSAL_URL },
        stdio: "inherit",
      });
    } catch (error) {
      fail("drizzle-kit migrate failed against the rehearsal container", error);
    }
    const migrateWallMs = Date.now() - migrateStart;
    const statementTimings = parseStatementTimings(); // auxiliary: per query string
    const indexBuilds = await collectIndexBuildTimings(client); // primary: per statement

    // Step 7: AFTER metrics + comparison.
    console.log("[7/10] collecting AFTER metrics and comparing...");
    const afterMetrics = await collectMetrics(client);
    const tableRows = [];
    for (const spec of DIGEST_TABLES) {
      const b = beforeMetrics[spec.table];
      const a = afterMetrics[spec.table];
      const countMatch = a.count === b.count;
      const digestMatch = a.digest === b.digest;
      if (!countMatch) failures.push(`${spec.table}: row count changed ${b.count} -> ${a.count}`);
      if (!digestMatch) failures.push(`${spec.table}: digest changed (${b.digest} -> ${a.digest})`);
      tableRows.push({
        table: spec.table,
        before: b,
        after: a,
        countMatch,
        digestMatch,
        note: spec.carveOut ? "digest over pre-migration inventory (0001's added columns carved out)" : "",
      });
    }

    // Step 8: structure AFTER + additive-only assertion.
    console.log("[8/10] asserting additive-only DDL delta...");
    const afterStructure = await collectStructure(client);
    const { problems, summary: ddlDelta } = assertAdditiveOnly(beforeStructure, afterStructure);
    failures.push(...problems);

    const knownTables = new Set(DIGEST_TABLES.map((t) => t.table));
    const newTables = afterStructure.tables
      .filter((t) => !knownTables.has(t) && !beforeStructure.tables.includes(t))
      .map((t) => ({ table: t, afterCount: null }));
    for (const nt of newTables) {
      const r = await client.query(`SELECT count(*)::text AS count FROM "${nt.table}"`);
      nt.afterCount = r.rows[0].count;
      // Phase-7 carve-out inventory: record the pinned 0002 column inventory
      // next to the post-migrate count so the evidence names the new Better
      // Auth objects (account/session/verification) with their shapes.
      const pinned = CARVE_OUT_0002_TABLES.find((spec) => spec.table === nt.table);
      if (pinned) nt.pinnedInventory = pinned.columns;
    }

    // Bookkeeping proof: the stamp wrote the baseline row and the runner
    // applied every remaining committed migration exactly once. The expected
    // count is DERIVED from the committed journal (WR-05), never hard-coded —
    // this script is reused by every later phase's rehearsal (D-10), so the
    // first 0002+ migration must not break the proof: 1 stamped baseline +
    // (entries.length - 1) runner-applied = entries.length rows.
    const journalEntries = JSON.parse(
      readFileSync("drizzle/meta/_journal.json", "utf8")
    ).entries.length;
    const journalRows = (
      await client.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)
    ).rows[0].n;
    if (journalRows !== journalEntries) {
      failures.push(`drizzle.__drizzle_migrations has ${journalRows} rows — expected ${journalEntries} (1 stamped baseline + ${journalEntries - 1} runner-applied from drizzle/meta/_journal.json)`);
    }

    // D-19 decision derived from measured index-build timings. 0001 is KNOWN
    // to create indexes — an empty capture means the probe broke, not that
    // builds were free. Fail loud rather than derive D-19 from nothing.
    if (indexBuilds.length === 0) {
      failures.push(
        "index-build timing probe captured 0 CREATE INDEX statements — the D-19 evidence is missing (pg_stat_statements probe broken)"
      );
    }
    const maxIndexBuild = indexBuilds.reduce((m, t) => (t.ms > m ? t.ms : m), 0);
    const slowIndex = indexBuilds.find((t) => t.ms >= D19_THRESHOLD_MS);
    const d19 = slowIndex
      ? { maxIndexBuildMs: maxIndexBuild, decision: `D-19: index build exceeded ${D19_THRESHOLD_MS} ms on real data — \`${slowIndex.statement.slice(0, 120)}\` took ${slowIndex.ms} ms. That index needs the out-of-runner CONCURRENTLY path: a documented psql step in the runbook applied BEFORE drizzle-kit migrate (research Pitfall 1) — a runbook note, NOT a migration edit this phase.` }
      : { maxIndexBuildMs: maxIndexBuild, decision: `D-19: plain indexes confirmed, no concurrent path needed (max index build ${maxIndexBuild} ms < ${D19_THRESHOLD_MS} ms threshold on real data).` };

    // Step 9: evidence.
    console.log("[9/10] writing evidence files...");
    const evidence = {
      day,
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      dump: { name: dumpName, bytes: dumpBytes },
      container: { image: IMAGE, name: CONTAINER, port: PORT, db: DB },
      carveOut: [
        "monitors.next_check_at + monitors.consecutive_failures (0001 backfill/catalog writes)",
        "pings.error_class + pings.status_code (additive NULL columns)",
        `${CARVE_OUT_0002_USER_COLUMNS.join(" + ")} (0002 D-08 role + D-23 boolean backfill — written outside the pinned pre-migration inventory; admin-plugin columns users.banned/banReason/banExpires ride outside the same way)`,
        `${CARVE_OUT_0002_TABLES.map((t) => t.table).join("/")} (0002 new Better Auth tables — no BEFORE baseline; counted via the new-tables path, arrival asserted by the DDL delta)`,
      ].join("; "),
      tables: tableRows,
      newTables,
      ddlDelta,
      timings: { migrateWallMs, statements: statementTimings, indexBuilds },
      bookkeeping: { journalRows, journalExpected: journalEntries },
      d19,
      failures,
    };
    writeEvidence(evidence);

    if (failures.length > 0) {
      console.error("\nREHEARSAL FAILED — verification failures:");
      for (const f of failures) console.error(`  - ${f}`);
      fail(
        `${failures.length} verification failure(s) — see ${SNAPSHOTS_DIR}/rehearsal-${day}.md`,
        new Error("production deploy (03-08) is BLOCKED until the rehearsal passes (T-03-12)")
      );
    }

    console.log(`\nREHEARSAL PASSED (${tableRows.length} tables verified, migrate ${migrateWallMs} ms, journal rows ${journalRows}).`);
  } catch (error) {
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // Step 10: teardown on success AND failure — but only what this run created.
  if (containerStarted) {
    try {
      execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
      console.log(`[10/10] teardown complete: ${CONTAINER} removed`);
    } catch {
      console.error(`TEARDOWN WARNING: could not remove ${CONTAINER} — run: docker rm -f ${CONTAINER}`);
    }
  }
}
