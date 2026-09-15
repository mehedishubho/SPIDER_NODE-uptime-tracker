#!/usr/bin/env node
// gate-cutover.mjs — the D-14 typed cutover gate command (WRK-11's
// verification half). One command evaluates the 7-gate window checklist
// (05-CONTEXT D-13) over the captured snapshot directory, prints PASS/FAIL
// per gate, and appends a markdown evidence block to 05-DEPLOY-RECORD.md
// (03-08/04 disposition-register pattern). Runbook §4a step 8 is this
// script; 05-06's rehearsal invokes it over stand-in snapshots and 05-08
// over the real window.
//
// The seven gates (D-13):
//   1 heartbeat steady (D-17)   — the healthchecks.io check's own flips
//                                 record over the window; the dead-man
//                                 switch IS the monitor, no local ticks.
//   2 queue health (D-19)       — no monitor-checks job older than 120 s at
//                                 any sample (the WRK-12 worst case), and
//                                 depth back to 0 at least once (drain).
//   3 alert parity (D-48/D-05)  — relayed bytes match the D-48 pins; one
//                                 relayed alert row per incident event.
//   4 counter gates (D-02+D-37) — pings-vs-total_count reconciliation AND
//                                 the dry-run recompute drift (both: D-37
//                                 alone is blind to the clobber class).
//   5 continuity gap-scan       — per-monitor max ping gap <= interval
//                                 minutes + 120 s tolerance.
//   6 duplicate ONGOING         — no monitor with >1 ONGOING incident
//                                 overlapping the window.
//   7 legacy-path disposition   — every cron-originated observation in
//                                 legacy-observations.json has a matching
//                                 line-prefix entry in disposition.md.
//
// Usage (run from the repo root):
//   node scripts/gate-cutover.mjs --start <epoch-s> --end <epoch-s> \
//        --snapshots DIR [--record PATH] [--db URL] [--offline-fixtures]
//   node scripts/gate-cutover.mjs --capture-baseline --snapshots DIR [--db URL]
//   node scripts/gate-cutover.mjs --help
//
// Snapshot layout (research OQ4 — the 05-06/05-08 capture contract):
//   DIR/samples/sample-<n>.txt   throwaway scraper output (scrape-metrics.mjs)
//   DIR/recompute-report.json    D-37 dry-run recompute captured in-window:
//                                { checked, discrepancies: [{monitorId,...}] }
//   DIR/parity-evidence.json     induced-incident relayed bytes + D-48 pins:
//                                { induced: {...}, byteMatch, extraTransientAlerts }
//   DIR/disposition.md           operator dispositions ("LO-n: ..." lines)
//   DIR/legacy-observations.json cron-originated observations captured
//                                in-window: [{ id, kind, observed }, ...]
//   DIR/flips-heartbeat.json     optional cache of the hc.io flips response:
//                                { flips: [{ timestamp, up }, ...] }
//   DIR/counters-baseline.json   written by --capture-baseline at window
//                                open (gate 4's delta base)
//   DIR/db-evidence.json         ONLY in --offline-fixtures mode: the
//                                pre-captured stand-in for the parameterized
//                                pg queries (same shape the online queries
//                                produce — see collectDbEvidence()).
//
// Env: HC_READ_ONLY_API_KEY (gate 1 live flips read), WORKER_HC_PING_URL
// (check UUID derivation — its tail path segment), DATABASE_URL (--db
// fallback). Keys and ping URLs are NEVER echoed (T-05-05-01); evidence
// blocks carry UUIDs, counts, and verdicts only.
//
// Fail-loud contract: exit 0 only on 7/7 PASS over a >= 4 h continuous
// window; any failure exits non-zero listing per-gate reasons. DB-backed
// gates degrade to FAIL-with-reason, never a crash (prohibition 4). Plain
// ESM; node:*, global fetch, and the already-installed pg only — gated
// behind a lazy import so --help/offline runs never load it.
//
// D-16 rule: end - start must be >= 14400 s or the script fails BEFORE any
// gate runs — an interruption restarts the clock and a gap is never
// dispositioned away. Only the final continuous stretch counts; earlier
// stretches belong in the record as aborted-window evidence.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCRIPT_NAME = "gate-cutover.mjs";
const DEFAULT_RECORD = path.join(
  ".planning", "phases", "05-worker-cutover-operational-hardening", "05-DEPLOY-RECORD.md"
);

// Pinned constants (05-CONTEXT / runbook §4a step 7).
const MIN_WINDOW_SECONDS = 4 * 3600; // D-16
const CHECK_LANE = "monitor-checks"; // QUEUE_NAMES.checks (src/worker/queues.ts)
const QUEUE_AGE_BOUND_SECONDS = 120; // D-19 — the documented WRK-12 worst case
const CONTINUITY_TOLERANCE_SECONDS = 120; // gate 5 tolerance over interval
const HC_FLIPS_URL = "https://healthchecks.io/api/v3/checks"; // Management API v3

const GATES = [
  { n: 1, name: "heartbeat steady", refs: "D-17" },
  { n: 2, name: "queue health", refs: "D-19" },
  { n: 3, name: "alert parity", refs: "D-48+D-05" },
  { n: 4, name: "counter gates", refs: "D-02+D-37" },
  { n: 5, name: "continuity gap-scan", refs: "" },
  { n: 6, name: "duplicate ONGOING", refs: "" },
  { n: 7, name: "legacy-path disposition", refs: "" },
];

function usage() {
  return [
    `Usage: node scripts/${SCRIPT_NAME} --start <epoch-s> --end <epoch-s> --snapshots DIR`,
    "             [--record PATH] [--db URL] [--offline-fixtures]",
    "       node scripts/gate-cutover.mjs --capture-baseline --snapshots DIR [--db URL]",
    "",
    "Evaluates the 7-gate cutover window checklist (D-13/D-14) over captured",
    "snapshots and appends the evidence block to the deploy record.",
    "",
    "  --start, --end       window bounds, integer epoch seconds (V5: validated",
    "                       at entry; end - start must be >= 14400 s, D-16)",
    "  --snapshots DIR      snapshot directory (the scrape-metrics.mjs layout)",
    "  --record PATH        evidence append target (default: " + DEFAULT_RECORD + ")",
    "  --db URL             Postgres URL (default: DATABASE_URL)",
    "  --offline-fixtures   test mode: gates 3-6 read DIR/db-evidence.json",
    "                       instead of querying; gate 1 reads the flips cache",
    "                       only; no network, no DB, no default record append",
    "  --capture-baseline   write DIR/counters-baseline.json from the DB now",
    "                       (run once at window open — gate 4's delta base)",
    "  --help               this usage text",
    "",
    "Env: HC_READ_ONLY_API_KEY, WORKER_HC_PING_URL, DATABASE_URL",
  ].join("\n");
}

function fail(message, code = 1) {
  console.error(`[${SCRIPT_NAME}] FAIL: ${message}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// CLI parsing (integer-epoch validation at entry — V5 / T-05-05-02)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "--offline-fixtures" || arg === "--capture-baseline") {
      args.flags.add(arg.slice(2));
      continue;
    }
    const key = arg.startsWith("--") ? arg.slice(2) : null;
    if (!key) fail(`unexpected argument "${arg}"\n\n${usage()}`, 2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`--${key} requires a value\n\n${usage()}`, 2);
    }
    args.values[key] = value;
    i++;
  }
  return args;
}

function requireIntegerEpoch(name, raw) {
  if (raw === undefined || !/^-?\d+$/.test(String(raw).trim())) {
    fail(`--${name} must be an integer epoch-seconds value (got ${JSON.stringify(raw)})`, 2);
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// Snapshot readers (every read is tolerant: a missing input is gate evidence
// of absence, i.e. a FAIL reason — never a crash)
// ---------------------------------------------------------------------------

function readJsonIfExists(file) {
  if (!existsSync(file)) return { ok: false, missing: true };
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, missing: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Minimal Prometheus text-exposition parser: [{name, labels, value}]. */
function parseExposition(text) {
  const samples = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([^\s]+)$/);
    if (!match) continue;
    const labels = {};
    if (match[2]) {
      for (const lm of match[2].slice(1, -1).matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        labels[lm[1]] = lm[2].replace(/\\(.)/g, "$1");
      }
    }
    const value = Number(match[3]);
    samples.push({ name: match[1], labels, value: Number.isFinite(value) ? value : null });
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Gate 1 — heartbeat steady (D-17): zero down-flips inside the window, from
// the healthchecks.io check's OWN record. The check UUID is the tail path
// segment of WORKER_HC_PING_URL; the read-only key rides X-Api-Key. Neither
// is ever echoed. Without the cache file, live mode fetches; offline mode
// and a missing key degrade to FAIL-with-instructions (A1 fallback).
// ---------------------------------------------------------------------------

function checkUuidFromPingUrl(pingUrl) {
  try {
    const segments = new URL(pingUrl).pathname.split("/").filter((s) => s.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

function flipsInWindow(flips, startEpoch, endEpoch) {
  const inWindow = [];
  for (const flip of Array.isArray(flips) ? flips : []) {
    const ts = Date.parse(flip?.timestamp ?? "");
    if (!Number.isFinite(ts)) continue; // malformed rows are ignored by bounds, not fatal
    if (ts >= startEpoch * 1000 && ts < endEpoch * 1000) inWindow.push(flip);
  }
  return inWindow;
}

async function evaluateGate1(dir, opts) {
  const reasons = [];
  const cacheFile = path.join(dir, "flips-heartbeat.json");

  let flips = null;
  let source = "cache";
  if (existsSync(cacheFile)) {
    const parsed = readJsonIfExists(cacheFile);
    if (!parsed.ok) return { pass: false, reasons: [`flips-heartbeat.json is not valid JSON (${parsed.error})`] };
    flips = Array.isArray(parsed.value) ? parsed.value : parsed.value?.flips ?? null;
  } else if (opts.offline) {
    return {
      pass: false,
      reasons: ["no flips-heartbeat.json cache in the snapshot dir (offline mode never fetches)"],
    };
  } else {
    source = "live";
    const apiKey = process.env.HC_READ_ONLY_API_KEY;
    const pingUrl = process.env.WORKER_HC_PING_URL;
    const uuid = pingUrl ? checkUuidFromPingUrl(pingUrl) : null;
    if (!apiKey || !uuid) {
      return {
        pass: false,
        reasons: [
          "manual evidence required (A1 fallback): HC_READ_ONLY_API_KEY or WORKER_HC_PING_URL is not set —",
          "open the healthchecks.io check page, verify zero down periods inside the window, save the flips",
          "response as flips-heartbeat.json in the snapshot dir, and re-run",
        ],
      };
    }
    const url = `${HC_FLIPS_URL}/${encodeURIComponent(uuid)}/flips/?start=${opts.start}&end=${opts.end}`;
    try {
      const response = await fetch(url, { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        return { pass: false, reasons: [`hc.io flips read returned HTTP ${response.status} (D-17)`] };
      }
      const body = await response.json();
      flips = Array.isArray(body) ? body : body?.flips ?? null;
    } catch (error) {
      return {
        pass: false,
        reasons: [`hc.io flips read failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  if (!Array.isArray(flips)) {
    return { pass: false, reasons: [`flips record is not an array (${source} source)`] };
  }
  const downs = flipsInWindow(flips, opts.start, opts.end).filter((f) => f.up !== 1);
  if (downs.length > 0) {
    reasons.push(`${downs.length} down-flip(s) inside the window — the heartbeat check went down (D-17)`);
  }
  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Gate 2 — queue health (D-19): parse the scraper samples. Age bound and a
// depth-0 drain over the check lane; -1 sentinel reads (depth read failed)
// never count as a drain — absence of proof fails toward detection.
// ---------------------------------------------------------------------------

function evaluateGate2(dir) {
  const reasons = [];
  const samplesDir = path.join(dir, "samples");
  let files = [];
  if (existsSync(samplesDir)) {
    files = readdirSync(samplesDir)
      .filter((f) => f.endsWith(".txt"))
      .sort();
  }
  if (files.length === 0) {
    return { pass: false, reasons: ["no samples/*.txt found — run scrape-metrics.mjs over the window (D-27)"] };
  }

  let sawDepthSample = false;
  let drainSeen = false;
  const ageViolations = [];
  for (const file of files) {
    const parsed = parseExposition(readFileSync(path.join(samplesDir, file), "utf8"));
    let pendingSum = 0;
    let depthReadable = true;
    for (const sample of parsed) {
      if (sample.labels.queue !== CHECK_LANE || sample.value === null) continue;
      if (sample.name === "spidernode_queue_oldest_job_age_seconds") {
        if (sample.value > QUEUE_AGE_BOUND_SECONDS) {
          ageViolations.push(`${file}: ${sample.value} s`);
        }
      } else if (sample.name === "spidernode_queue_depth" && (sample.labels.state === "wait" || sample.labels.state === "prioritized")) {
        sawDepthSample = true;
        if (sample.value < 0) depthReadable = false;
        else pendingSum += sample.value;
      }
    }
    if (depthReadable && pendingSum === 0) drainSeen = true;
  }

  for (const violation of ageViolations) {
    reasons.push(`check-lane job age over the ${QUEUE_AGE_BOUND_SECONDS} s bound (D-19/WRK-12): ${violation}`);
  }
  if (!sawDepthSample) {
    reasons.push(`no ${CHECK_LANE} depth samples found in the exposition (family spidernode_queue_depth)`);
  } else if (!drainSeen) {
    reasons.push(`${CHECK_LANE} depth never returned to 0 across ${files.length} sample(s) (D-19 drain between claim cycles)`);
  }
  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Gates 3-6 — DB-backed. collectDbEvidence() yields ONE canonical shape both
// modes consume, so the gate comparisons run identically online and offline:
//   {
//     parity: { incidents: [{incidentId, monitorId, downRows, recoveredRows,
//                             alertRows}] },
//     counters: [{monitorId, intervalSeconds, pingsInWindow, totalCountDelta}],
//     continuity: [{monitorId, intervalSeconds, maxGapSeconds,
//                   pingsInWindow, createdInWindow}],
//     duplicateOngoing: [{monitorId, ongoing}],
//   }
// ---------------------------------------------------------------------------

async function connectDb(dbUrl) {
  if (!dbUrl) return { client: null, error: "no database URL (--db or DATABASE_URL)" };
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 3000 });
    client.on("error", () => {}); // idle terminations surface on the next query
    await client.connect();
    return { client, error: null };
  } catch (error) {
    return { client: null, error: `database unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function collectDbEvidence(dir, opts) {
  if (opts.offline) {
    const parsed = readJsonIfExists(path.join(dir, "db-evidence.json"));
    if (!parsed.ok) {
      const reason = parsed.missing
        ? "offline mode: db-evidence.json missing from the snapshot dir"
        : `offline mode: db-evidence.json is not valid JSON (${parsed.error})`;
      return { error: reason };
    }
    return { evidence: parsed.value, offline: true };
  }

  const { client, error } = await connectDb(opts.db);
  if (!client) return { error };
  try {
    // Pings per monitor + max consecutive-ping gap inside the window, joined
    // against the active-monitor inventory (interval + created-in-window
    // flag). pings."createdAt" is a NAIVE UTC column (legacy camelCase
    // table), so bounds compare via to_timestamp(...) AT TIME ZONE 'utc'.
    const continuityRes = await client.query(
      `SELECT m.id AS monitor_id,
              m."interval" AS interval_seconds,
              (m."createdAt" >= to_timestamp($1) AT TIME ZONE 'utc') AS created_in_window,
              COALESCE(p.pings, 0)::int AS pings_in_window,
              p.max_gap_seconds
         FROM monitors m
         LEFT JOIN (
           SELECT g.monitor_id, count(*)::int AS pings, max(g.gap_seconds) AS max_gap_seconds
             FROM (
               SELECT "monitorId" AS monitor_id,
                      EXTRACT(EPOCH FROM ("createdAt" - LAG("createdAt")
                        OVER (PARTITION BY "monitorId" ORDER BY "createdAt", id)))::double precision AS gap_seconds
                 FROM pings
                WHERE "createdAt" >= to_timestamp($1) AT TIME ZONE 'utc'
                  AND "createdAt" <  to_timestamp($2) AT TIME ZONE 'utc'
             ) g
            GROUP BY g.monitor_id
         ) p ON p.monitor_id = m.id
        WHERE m."isActive"`,
      [opts.start, opts.end]
    );

    // Current counters + the window-open baseline give the total_count delta
    // (D-02). Monitors absent from the baseline were created mid-window
    // (delta from zero).
    const countersRes = await client.query(
      `SELECT id AS monitor_id, "totalChecks" AS total_checks FROM monitors WHERE "isActive"`
    );
    const baselineFile = path.join(dir, "counters-baseline.json");
    const baselineParsed = readJsonIfExists(baselineFile);
    const baseline = new Map();
    let baselineMissing = false;
    if (baselineParsed.ok && Array.isArray(baselineParsed.value?.monitors)) {
      for (const row of baselineParsed.value.monitors) {
        baseline.set(Number(row.monitorId), Number(row.totalChecks));
      }
    } else {
      baselineMissing = true;
    }

    // Incidents created in the window with their outbox alert-row counts per
    // event type (the relay's alert trail — outbox.created_at is timestamptz
    // but the join rides the incident's naive startedAt bounds).
    const parityRes = await client.query(
      `SELECT i.id AS incident_id,
              i."monitorId" AS monitor_id,
              count(o.id) FILTER (WHERE o.event_type = 'incident.down')::int AS down_rows,
              count(o.id) FILTER (WHERE o.event_type = 'incident.recovered')::int AS recovered_rows,
              count(o.id)::int AS alert_rows
         FROM incidents i
         LEFT JOIN outbox o ON o.incident_id = i.id
        WHERE i."startedAt" >= to_timestamp($1) AT TIME ZONE 'utc'
          AND i."startedAt" <  to_timestamp($2) AT TIME ZONE 'utc'
        GROUP BY i.id, i."monitorId"`,
      [opts.start, opts.end]
    );

    // Duplicate ONGOING incidents overlapping the window (defense in depth —
    // the partial unique index should make this always empty).
    const dupRes = await client.query(
      `SELECT "monitorId" AS monitor_id, count(*)::int AS ongoing
         FROM incidents
        WHERE status = 'ONGOING'
          AND "startedAt" < to_timestamp($2) AT TIME ZONE 'utc'
          AND ("resolvedAt" IS NULL OR "resolvedAt" >= to_timestamp($1) AT TIME ZONE 'utc')
        GROUP BY "monitorId" HAVING count(*) > 1`,
      [opts.start, opts.end]
    );

    const counters = countersRes.rows.map((row) => {
      const current = Number(row.total_checks);
      const delta = baselineMissing ? null : current - (baseline.get(Number(row.monitor_id)) ?? 0);
      return { monitorId: Number(row.monitor_id), totalCountDelta: delta };
    });
    const countersByMonitor = new Map(counters.map((c) => [c.monitorId, c]));

    const evidence = {
      parity: {
        incidents: parityRes.rows.map((row) => ({
          incidentId: String(row.incident_id),
          monitorId: Number(row.monitor_id),
          downRows: Number(row.down_rows),
          recoveredRows: Number(row.recovered_rows),
          alertRows: Number(row.alert_rows),
        })),
      },
      counters: continuityRes.rows.map((row) => ({
        monitorId: Number(row.monitor_id),
        intervalSeconds: Number(row.interval_seconds) * 60,
        pingsInWindow: Number(row.pings_in_window),
        totalCountDelta: countersByMonitor.get(Number(row.monitor_id))?.totalCountDelta ?? null,
      })),
      continuity: continuityRes.rows.map((row) => ({
        monitorId: Number(row.monitor_id),
        intervalSeconds: Number(row.interval_seconds) * 60,
        maxGapSeconds: row.max_gap_seconds === null ? null : Number(row.max_gap_seconds),
        pingsInWindow: Number(row.pings_in_window),
        createdInWindow: Boolean(row.created_in_window),
      })),
      duplicateOngoing: dupRes.rows.map((row) => ({
        monitorId: Number(row.monitor_id),
        ongoing: Number(row.ongoing),
      })),
    };
    if (baselineMissing) evidence.baselineMissing = true;
    return { evidence, offline: false };
  } finally {
    await client.end().catch(() => {});
  }
}

function evaluateGate3(dir, dbResult) {
  const reasons = [];
  const dispositions = [];

  // Byte parity against the D-48 pins (induced-incident evidence, D-11).
  const parityFile = readJsonIfExists(path.join(dir, "parity-evidence.json"));
  if (!parityFile.ok) {
    reasons.push(
      parityFile.missing
        ? "parity-evidence.json missing — induce the DOWN/RECOVERED pair mid-window (D-11) and capture it"
        : `parity-evidence.json is not valid JSON (${parityFile.error})`
    );
  } else if (parityFile.value?.byteMatch !== true) {
    reasons.push("relay byteMatch is not true against the D-48 characterization pins");
  }
  const extras = parityFile.ok && Array.isArray(parityFile.value?.extraTransientAlerts)
    ? parityFile.value.extraTransientAlerts
    : [];

  if (dbResult.error) {
    reasons.push(dbResult.error);
    return { pass: false, reasons, dispositions };
  }
  const incidents = dbResult.evidence?.parity?.incidents ?? [];
  for (const incident of incidents) {
    if (incident.downRows > 1 || incident.recoveredRows > 1) {
      reasons.push(
        `incident ${incident.incidentId} (monitor ${incident.monitorId}): ${incident.downRows} down / ${incident.recoveredRows} recovered relay rows — more than one relayed alert per incident event`
      );
    } else if ((incident.downRows ?? 0) + (incident.recoveredRows ?? 0) === 0) {
      // Zero outbox rows = the cron-originated class (direct-send path never
      // writes the outbox): listed for disposition, not failed (D-05).
      dispositions.push(
        `incident ${incident.incidentId} (monitor ${incident.monitorId}) has no outbox rows — cron-originated direct-send alert? disposition it (D-05)`
      );
    }
  }
  for (const extra of extras) {
    dispositions.push(`extra transient alert listed for disposition (D-05): ${JSON.stringify(extra)}`);
  }
  return { pass: reasons.length === 0, reasons, dispositions };
}

function evaluateGate4(dir, dbResult) {
  const reasons = [];

  // D-02 leg: per-monitor pings count vs the total_count delta over the
  // window. A clobbered counter carries self-consistent uptime_percent —
  // ONLY this reconcile sees it (05-CONTEXT D-02, research Pitfall 2).
  if (dbResult.error) {
    reasons.push(dbResult.error);
  } else {
    const rows = dbResult.evidence?.counters ?? [];
    if (dbResult.evidence?.baselineMissing) {
      reasons.push(
        "counters-baseline.json missing — run --capture-baseline at window open (gate 4 cannot compute the delta)"
      );
    }
    for (const row of rows) {
      if (row.totalCountDelta === null || row.totalCountDelta === undefined) continue; // covered above
      if (Number(row.pingsInWindow) !== Number(row.totalCountDelta)) {
        reasons.push(
          `monitor ${row.monitorId}: pings in window = ${row.pingsInWindow} but total_count delta = ${row.totalCountDelta} (D-02 lost-update class)`
        );
      }
    }
  }

  // D-37 leg: the dry-run recompute report captured in-window must show
  // zero drift between stored and counters-derived uptime_percent.
  const reportFile = readJsonIfExists(path.join(dir, "recompute-report.json"));
  if (!reportFile.ok) {
    reasons.push(
      reportFile.missing
        ? "recompute-report.json missing — capture the D-37 dry-run recompute during the window"
        : `recompute-report.json is not valid JSON (${reportFile.error})`
    );
  } else {
    const discrepancies = reportFile.value?.discrepancies;
    if (!Array.isArray(discrepancies)) {
      reasons.push("recompute-report.json has no discrepancies array (expected the runConsistencyAudit shape)");
    } else if (discrepancies.length > 0) {
      const detail = discrepancies
        .map((d) => `monitor ${d.monitorId} stored=${d.stored} derived=${d.derived}`)
        .join("; ");
      reasons.push(`D-37 recompute drift on ${discrepancies.length} monitor(s): ${detail}`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

function evaluateGate5(dbResult) {
  const reasons = [];
  if (dbResult.error) {
    reasons.push(dbResult.error);
    return { pass: false, reasons };
  }
  const rows = dbResult.evidence?.continuity ?? [];
  for (const row of rows) {
    const bound = Number(row.intervalSeconds) + CONTINUITY_TOLERANCE_SECONDS;
    if (row.maxGapSeconds !== null && row.maxGapSeconds !== undefined) {
      if (Number(row.maxGapSeconds) > bound) {
        reasons.push(
          `monitor ${row.monitorId}: max ping gap ${row.maxGapSeconds} s over the ${bound} s bound (interval ${row.intervalSeconds} s + ${CONTINUITY_TOLERANCE_SECONDS} s tolerance)`
        );
      }
    } else if (!row.createdInWindow) {
      reasons.push(
        `monitor ${row.monitorId}: only ${row.pingsInWindow} ping(s) in the window — continuity unmeasurable`
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}

function evaluateGate6(dbResult) {
  const reasons = [];
  if (dbResult.error) {
    reasons.push(dbResult.error);
    return { pass: false, reasons };
  }
  for (const row of dbResult.evidence?.duplicateOngoing ?? []) {
    reasons.push(`monitor ${row.monitorId} has ${row.ongoing} ONGOING incidents overlapping the window`);
  }
  return { pass: reasons.length === 0, reasons };
}

function evaluateGate7(dir) {
  const reasons = [];

  const observationsFile = readJsonIfExists(path.join(dir, "legacy-observations.json"));
  if (!observationsFile.ok) {
    reasons.push(
      observationsFile.missing
        ? "legacy-observations.json missing — the cron-originated observation log is gate evidence, capture it even when empty ([])"
        : `legacy-observations.json is not valid JSON (${observationsFile.error})`
    );
    return { pass: false, reasons };
  }
  const observations = observationsFile.value;
  if (!Array.isArray(observations)) {
    return { pass: false, reasons: ["legacy-observations.json is not an array of {id, kind, observed} entries"] };
  }

  const dispositionPath = path.join(dir, "disposition.md");
  const dispositionLines = existsSync(dispositionPath)
    ? readFileSync(dispositionPath, "utf8").split(/\r?\n/)
    : null;
  if (dispositionLines === null) {
    reasons.push("disposition.md missing — every legacy-path observation needs a disposition line");
  }

  for (const observation of observations) {
    const id = String(observation?.id ?? "");
    if (!id) {
      reasons.push(`legacy observation without an id: ${JSON.stringify(observation)}`);
      continue;
    }
    const matched = (dispositionLines ?? []).some((line) => {
      const stripped = line.trim().replace(/^([-*+]|\d+[.)])\s+/, "");
      if (!stripped.startsWith(id)) return false;
      // The id must end at a delimiter (or line end) so LO-1 never matches
      // LO-10's line.
      const rest = stripped.slice(id.length);
      return rest === "" || /^[\s:]/.test(rest);
    });
    if (!matched) {
      reasons.push(`observation ${id} has no disposition entry in disposition.md (line-prefix match on the id)`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Evidence block (D-14): counts, verdicts, ids — never keys or ping URLs
// (T-05-05-01).
// ---------------------------------------------------------------------------

function evidenceBlock(opts, results, verdictLine) {
  const now = new Date().toISOString();
  const lines = [
    "",
    "---",
    "",
    `## Cutover gate evaluation — ${now}`,
    "",
    `- Window: ${new Date(opts.start * 1000).toISOString()} .. ${new Date(opts.end * 1000).toISOString()} (${opts.end - opts.start} s)`,
    `- Mode: ${opts.offline ? "offline fixtures" : "live"}`,
    `- Verdict: ${verdictLine}`,
    "",
  ];
  for (const result of results) {
    const refs = result.refs ? ` [${result.refs}]` : "";
    lines.push(`GATE ${result.n} (${result.name}): ${result.pass ? "PASS" : "FAIL"}${refs}`);
    for (const reason of result.reasons) lines.push(`  - ${reason}`);
    for (const disposition of result.dispositions ?? []) lines.push(`  - [disposition] ${disposition}`);
  }
  lines.push("");
  return lines.join("\n");
}

function appendEvidence(recordPath, block) {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  appendFileSync(recordPath, block, "utf8");
}

// ---------------------------------------------------------------------------
// Baseline capture (gate 4's delta base — run once at window open)
// ---------------------------------------------------------------------------

async function captureBaseline(dir, dbUrl) {
  const { client, error } = await connectDb(dbUrl);
  if (!client) fail(error);
  try {
    const res = await client.query(
      `SELECT id AS monitor_id, "totalChecks" AS total_checks, "failedChecks" AS failed_checks FROM monitors ORDER BY id`
    );
    const payload = {
      capturedAt: new Date().toISOString(),
      note: "gate 4 delta base — captured by gate-cutover.mjs --capture-baseline at window open (D-02)",
      monitors: res.rows.map((row) => ({
        monitorId: Number(row.monitor_id),
        totalChecks: Number(row.total_checks),
        failedChecks: Number(row.failed_checks),
      })),
    };
    const outFile = path.join(dir, "counters-baseline.json");
    writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[${SCRIPT_NAME}] baseline captured: ${payload.monitors.length} monitor(s) -> ${path.join(dir, "counters-baseline.json")}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help")) {
    console.log(usage());
    return;
  }

  const dir = args.values.snapshots;
  if (!dir || !existsSync(dir)) {
    fail(`--snapshots DIR is required and must exist (got ${JSON.stringify(dir)})\n\n${usage()}`, 2);
  }
  const dbUrl = args.values.db ?? process.env.DATABASE_URL ?? null;
  const offline = args.flags.has("offline-fixtures");

  if (args.flags.has("capture-baseline")) {
    if (offline) fail("--capture-baseline queries the database and cannot run with --offline-fixtures", 2);
    await captureBaseline(dir, dbUrl);
    return;
  }

  // V5: integer epochs validated at entry; D-16: the 4 h continuous minimum.
  const start = requireIntegerEpoch("start", args.values.start);
  const end = requireIntegerEpoch("end", args.values.end);
  if (end <= start) fail("--end must be after --start", 2);

  const recordPath = args.values.record ?? (offline ? null : DEFAULT_RECORD);
  const opts = { start, end, offline, db: dbUrl };

  if (end - start < MIN_WINDOW_SECONDS) {
    const reason =
      `window ${end - start} s is shorter than the ${MIN_WINDOW_SECONDS} s (4 h) continuous minimum (D-16) — ` +
      "an interruption restarts the clock; only the final continuous >= 4 h stretch counts. " +
      "Re-open a fresh window; do not disposition the gap.";
    console.log(`[${SCRIPT_NAME}] FAIL: ${reason}`);
    if (recordPath) {
      appendEvidence(
        recordPath,
        evidenceBlock(opts, [], `**FAIL — window too short (D-16)**: ${reason}`)
      );
      console.error(`[${SCRIPT_NAME}] aborted-window evidence recorded: ${recordPath}`);
    }
    process.exitCode = 1;
    return;
  }

  // Gates 3-6 share one DB-evidence collection (single connection).
  const dbResult = await collectDbEvidence(dir, opts);

  const gate1 = await evaluateGate1(dir, opts);
  const gate2 = evaluateGate2(dir);
  const gate3 = evaluateGate3(dir, dbResult);
  const gate4 = evaluateGate4(dir, dbResult);
  const gate5 = evaluateGate5(dbResult);
  const gate6 = evaluateGate6(dbResult);
  const gate7 = evaluateGate7(dir);

  const evaluated = [gate1, gate2, gate3, gate4, gate5, gate6, gate7];
  const results = GATES.map((gate, index) => ({
    ...gate,
    pass: evaluated[index].pass,
    reasons: evaluated[index].reasons ?? [],
    dispositions: evaluated[index].dispositions,
  }));

  const passed = results.filter((r) => r.pass).length;
  const windowLine = `window ${new Date(start * 1000).toISOString()} -> ${new Date(end * 1000).toISOString()} (${end - start} s >= ${MIN_WINDOW_SECONDS} s minimum, D-16)`;
  console.log(`[${SCRIPT_NAME}] ${windowLine}`);

  const dispositions = [];
  for (const result of results) {
    const refs = result.refs ? ` [${result.refs}]` : "";
    console.log(`GATE ${result.n} (${result.name}): ${result.pass ? "PASS" : "FAIL"}${refs}`);
    for (const reason of result.reasons) console.log(`  - ${reason}`);
    for (const disposition of result.dispositions ?? []) {
      console.log(`  - [disposition] ${disposition}`);
      dispositions.push(disposition);
    }
  }

  const verdictLine = passed === results.length ? `**PASS (7/7)**` : `**FAIL (${passed}/7)**`;
  console.log(`[${SCRIPT_NAME}] VERDICT: ${passed === results.length ? "PASS (7/7)" : `FAIL (${passed}/7)`}`);
  if (dispositions.length > 0) {
    console.log(`[${SCRIPT_NAME}] ${dispositions.length} item(s) listed for disposition — record them in disposition.md / the deploy record`);
  }

  if (recordPath) {
    appendEvidence(recordPath, evidenceBlock(opts, results, verdictLine));
    console.log(`[${SCRIPT_NAME}] evidence recorded: ${recordPath}`);
  } else if (offline) {
    console.log(`[${SCRIPT_NAME}] offline fixtures: pass --record to write the evidence block`);
  }

  process.exitCode = passed === results.length ? 0 : 1;
}

try {
  await main();
} catch (error) {
  // Never a stack dump: fail loud with the message only.
  fail(error instanceof Error ? error.message : String(error));
}
