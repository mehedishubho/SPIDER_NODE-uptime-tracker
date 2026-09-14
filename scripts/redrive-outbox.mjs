#!/usr/bin/env node
// redrive-outbox.mjs — the D-46 operator re-drive for FAILED outbox rows.
//
// FAILED is a derived, zero-migration state (04-07 D-44):
//     sent_at IS NULL AND (payload ? '_relayFailure' OR attempts >= 3)
// The relay never revisits those rows — they are RETAINED for the operator.
// This script lists them and (only with --apply) re-marks them PENDING:
//     attempts = 0, payload = payload - '_relayFailure'
// which restores the pending-claim shape (sent_at NULL, attempts < 3, no
// marker) so the next relay pass retries the send.
//
// DEDUP-BEFORE-REMARK (T-04-33): the relay writes the alert dedup key
// (alert:{incidentId}:down|recovered / alert:{monitorId}:first_check, TTL 7d)
// ONLY after a CONFIRMED send. If the key EXISTS, the human already received
// that alert — re-marking would double-send. Rows whose dedup key exists are
// reported and SKIPPED (never written, in dry-run AND --apply).
//
// DRY-RUN BY DEFAULT (D-37 maintenance precedent: absent flag = zero writes).
// Pass --apply to actually re-mark. Plain node — no tsx needed; the dedup-key
// derivation mirrors src/worker/persist/outbox.ts dedupKeyFor (§16.4 declares
// exactly three event types; keep in sync).
//
// Usage: node scripts/redrive-outbox.mjs [--apply]
// Env:   DATABASE_URL + REDIS_URL of the target topology. Never prints
//        connection strings or tokens; failure payloads are NOT dumped.

import "dotenv/config"; // honors .env when present; explicit process env ALWAYS wins (dotenv never overrides)
import { Client } from "pg";
import Redis from "ioredis";

const RELAY_MAX_ATTEMPTS = 3; // mirrors RELAY_MAX_ATTEMPTS (outbox.ts)
const RELAY_FAILURE_KEY = "_relayFailure"; // mirrors RELAY_FAILURE_KEY

const APPLY = process.argv.includes("--apply");

function fail(message) {
  console.error(`[redrive] FAIL: ${message}`);
  process.exit(1);
}

for (const name of ["DATABASE_URL", "REDIS_URL"]) {
  if (!process.env[name]) fail(`${name} is not set — pass the target stack explicitly (never guess a stack)`);
}

// dedupKeyFor (outbox.ts, §16.4) — mirrored here because this script runs
// under plain node, not tsx. Exactly three event types; anything else is a
// contract violation and fails loudly.
function dedupKeyFor(eventType, monitorId, incidentId) {
  switch (eventType) {
    case "incident.down":
      return `alert:${incidentId}:down`;
    case "incident.recovered":
      return `alert:${incidentId}:recovered`;
    case "monitor.first_check":
      return `alert:${monitorId}:first_check`;
    default:
      throw new Error(`unknown outbox event_type '${eventType}' (§16.4 declares exactly three)`);
  }
}

const pg = new Client({ connectionString: process.env.DATABASE_URL });
pg.on("error", () => {}); // idle-termination shield (resilience-harness precedent)
await pg.connect();

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1, // operator tooling fails fast, never hangs
  enableOfflineQueue: false,
});
redis.on("error", () => {}); // surfaced by the next command instead

try {
  // 1. The FAILED set, exactly as the relay derives it (D-44).
  const failed = await pg.query(
    `SELECT id, event_type, monitor_id, incident_id, attempts,
            (payload ? $1) AS marker,
            created_at
       FROM outbox
      WHERE sent_at IS NULL
        AND ((payload ? $1) OR attempts >= $2)
      ORDER BY created_at`,
    [RELAY_FAILURE_KEY, RELAY_MAX_ATTEMPTS]
  );

  if (failed.rows.length === 0) {
    console.log("[redrive] no FAILED outbox rows — nothing to do (healthy outbox)");
    process.exit(0);
  }

  // 2. Per row: check the dedup key BEFORE any write decision (T-04-33).
  let skippedSent = 0;
  let redriveable = 0;
  const applyResults = [];
  for (const row of failed.rows) {
    const label = `outbox ${row.id} (${row.event_type}, monitorId=${row.monitor_id}, attempts=${row.attempts}${row.marker ? ", _relayFailure" : ""}, created ${row.created_at.toISOString()})`;
    let key;
    try {
      key = dedupKeyFor(row.event_type, row.monitor_id, row.incident_id);
    } catch (err) {
      await redis.quit().catch(() => {});
      await pg.end().catch(() => {});
      fail(`${label}: ${err.message}`);
    }
    // CR-03: down/recovered REQUIRE incident_id — a NULL incidentId yields the
    // literal key "alert:null:down", which can never exist; treat as a
    // contract violation instead of pretending to re-drive it.
    if ((row.event_type === "incident.down" || row.event_type === "incident.recovered") && !row.incident_id) {
      console.log(`[redrive] CONTRACT-VIOLATION (skip): ${label} — down/recovered requires incident_id (CR-03)`);
      continue;
    }
    const alreadySent = (await redis.exists(key)) === 1;
    if (alreadySent) {
      skippedSent += 1;
      console.log(`[redrive] SKIP (dedup key held — alert already delivered): ${label} key=${key}`);
      continue;
    }
    redriveable += 1;
    if (APPLY) {
      // Re-mark PENDING; the WHERE re-check keeps the UPDATE idempotent against
      // a concurrent relay/second re-drive run (only a still-FAILED row is
      // touched — a row that moved on is left alone).
      const res = await pg.query(
        `UPDATE outbox
            SET attempts = 0, payload = payload - $2
          WHERE id = $1
            AND sent_at IS NULL
            AND ((payload ? $2) OR attempts >= $3)`,
        [row.id, RELAY_FAILURE_KEY, RELAY_MAX_ATTEMPTS]
      );
      const requeued = res.rowCount === 1;
      applyResults.push({ id: row.id, requeued });
      console.log(
        requeued
          ? `[redrive] REQUEUED: ${label} — re-marked PENDING (attempts=0, marker removed)`
          : `[redrive] RACE (no write): ${label} — row left the FAILED state concurrently, left untouched`
      );
    } else {
      console.log(`[redrive] DRY-RUN would requeue: ${label} (dedup key free — re-mark PENDING with --apply)`);
    }
  }

  console.log(
    `[redrive] summary: ${failed.rows.length} FAILED rows — ${redriveable} requeueable${
      APPLY ? ` (${applyResults.filter((r) => r.requeued).length} requeued)` : " (dry-run; pass --apply)"
    }, ${skippedSent} skipped (dedup key held)`
  );
} finally {
  await redis.quit().catch(() => {});
  await pg.end().catch(() => {});
}
process.exit(0);
