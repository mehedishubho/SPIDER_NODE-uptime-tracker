#!/usr/bin/env node
// auth-soak-gate.mjs — the D-31 typed soak-gate command (07-07 Task 3).
// One command evaluates the ~24h post-flip soak checklist (07-CONTEXT D-31,
// runbook §4c step 8's follow-on window) and appends the evidence block to
// 07-DEPLOY-RECORD.md (gate-cutover.mjs / 05 D-14 precedent; the
// machine-verified vs operator-attested split follows 06-DEPLOY-RECORD §12).
//
// Verdicts per leg: PASS (machine-proven) · ATTEST (operator attestation
// recorded verbatim from attestations.md) · FAIL (with reason). The gate
// NEVER silently passes: an un-runnable leg — missing env, missing evidence
// file, unreachable origin — is FAIL with the reason, never a skip.
//
// The D-31 legs:
//   machine:
//   1 feedback-admin-matrix (D-14/R17)  GET /api/feedback — anonymous 401,
//                                       admin cookie 200, non-admin 403
//                                       (sessions via env cookie jars minted
//                                       on the target stack by the operator).
//   2 bullboard-allowlisted (D-17/D-18) GET :9090/admin/queues with the
//                                       admin cookie from an ALLOWLISTED
//                                       source — 200 + Bull Board HTML.
//   3 bullboard-refusal (D-17)          evidence file: the status captured
//                                       from a NON-allowlisted source must
//                                       be the refusal (403).
//   4 notice-strip (D-02)               GET /login carries the frozen strip
//                                       copy INSIDE the AUTH_NOTICE_* window.
//   5 email-roundtrip (EML-04/D-31)     verification + reset round-trips
//                                       moved the email-lane completed
//                                       counter (counters captured around
//                                       the trigger via --queue-status), or
//                                       console-provider log lines >= 2.
//   6 dead-error-quiet (D-31)           zero auth/email-surface error lines
//                                       in the captured window logs (typed
//                                       marker set; check-engine DOWN
//                                       classifications are NOT auth errors).
//   attest (operator, recorded verbatim):
//   7 D38-CREDENTIALS  8 D38-GOOGLE  9 D38-GITHUB   the three canary logins
//  10 D40-NO-RECONSENT                both OAuth logins WITHOUT a re-consent
//                                      screen (the live refresh-token proof)
//  11 INBOX-VERIFICATION 12 INBOX-RESET  delivery inbox checks
//  13 NOTICE-VISUAL                   the strip's visual check in a browser
//
// Usage (run from the repo root):
//   node scripts/auth-soak-gate.mjs --dry-run
//   node scripts/auth-soak-gate.mjs --queue-status
//   node scripts/auth-soak-gate.mjs --soak-dir DIR --start <epoch-s|ISO> --end <epoch-s|ISO>
//        [--web-origin URL] [--worker-origin URL] [--record PATH]
//   node scripts/auth-soak-gate.mjs --help
//
// soak-dir layout (the operator's capture contract):
//   attestations.md        lines "KEY: verdict text" per attest leg above
//   bullboard-refusal.json { "status": 403, "note": "captured from <non-allowlisted source> at <time>" }
//   email-roundtrip.json   { "completedBefore": N, "completedAfter": M }
//                          (or { "consoleLogLines": K } for console-provider stacks)
//   logs/*.log             the window's captured web+worker logs (scanned by leg 6)
//
// Env: SOAK_ADMIN_COOKIE / SOAK_NONADMIN_COOKIE (the better-auth.session_token
// values minted on the target stack — NEVER echoed; T-07-26),
// AUTH_NOTICE_START / AUTH_NOTICE_END (the live window bounds), REDIS_URL
// (--queue-status / nothing else). Evidence blocks carry statuses, counts,
// and verdicts only — never cookie values or connection strings.
//
// Window arithmetic is RECORDED PLAINLY, never dispositioned away (06 §12
// precedent): a window shorter than ~24h prints a loud SHORT-WINDOW note and
// is covered by the D-36 operator approval, which is the closing human gate.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SCRIPT_NAME = "auth-soak-gate.mjs";
const DEFAULT_RECORD = path.join(
  ".planning", "phases", "07-better-auth-cutover-admin-gating-prisma-removal", "07-DEPLOY-RECORD.md"
);

// The frozen D-02 strip copy (src/components/Auth/LoginNotice.tsx) — the leg
// asserts the exact sentence so a stray redesign can't fake a pass.
const NOTICE_COPY = "Sign-in moved to a new system";
const EMAIL_LANE = "email-transactional"; // QUEUE_NAMES.email (src/worker/queues.ts)
const SESSION_COOKIE = "better-auth.session_token";
const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:3007";
const DEFAULT_WORKER_ORIGIN = "http://127.0.0.1:9090";
const HTTP_TIMEOUT_MS = 10_000;
const ROUNDTRIP_MIN_DELTA = 2; // one verification + one reset
// Leg-6 typed marker set — AUTH/EMAIL surface only. Check-engine level-50
// lines ("check job FAILED (infra)", DOWN classifications, breaker counts)
// are expected soak noise for real monitors and are deliberately NOT here.
const ERROR_MARKERS = [
  "email send PERMANENT failure",
  "email job name is not",
  "email job payload malformed",
  "[redis-limiter] DEGRADED",
  "unhandledRejection",
  "uncaughtException",
];

const MACHINE_LEGS = [
  { n: 1, name: "feedback-admin-matrix", refs: "D-14/R17", inputs: "SOAK_ADMIN_COOKIE + SOAK_NONADMIN_COOKIE + web origin" },
  { n: 2, name: "bullboard-allowlisted", refs: "D-17/D-18", inputs: "SOAK_ADMIN_COOKIE + worker origin (run from an allowlisted source)" },
  { n: 3, name: "bullboard-refusal", refs: "D-17", inputs: "soak-dir/bullboard-refusal.json (captured from a NON-allowlisted source)" },
  { n: 4, name: "notice-strip", refs: "D-02", inputs: "AUTH_NOTICE_START/END + web origin" },
  { n: 5, name: "email-roundtrip", refs: "EML-04/D-31", inputs: "soak-dir/email-roundtrip.json (counters via --queue-status around the trigger)" },
  { n: 6, name: "dead-error-quiet", refs: "D-31", inputs: "soak-dir/logs/*.log (the window's captured web+worker logs)" },
];
const ATTEST_LEGS = [
  { n: 7, name: "D38-CREDENTIALS", refs: "D-38" },
  { n: 8, name: "D38-GOOGLE", refs: "D-38" },
  { n: 9, name: "D38-GITHUB", refs: "D-38" },
  { n: 10, name: "D40-NO-RECONSENT", refs: "D-40" },
  { n: 11, name: "INBOX-VERIFICATION", refs: "D-31" },
  { n: 12, name: "INBOX-RESET", refs: "D-31" },
  { n: 13, name: "NOTICE-VISUAL", refs: "D-02" },
];

function usage() {
  return [
    `Usage: node scripts/${SCRIPT_NAME} --dry-run`,
    `       node scripts/${SCRIPT_NAME} --queue-status`,
    `       node scripts/${SCRIPT_NAME} --soak-dir DIR --start <epoch-s|ISO> --end <epoch-s|ISO>`,
    "             [--web-origin URL] [--worker-origin URL] [--record PATH]",
    "",
    "Evaluates the D-31 soak checklist (PASS/FAIL/ATTEST per leg) and appends",
    "the evidence block to the deploy record.",
    "",
    "  --dry-run          parse + evaluate the leg list only (no network, no",
    "                     DB, no Redis, no record append) — the plan's verify",
    "  --queue-status     print the email lane's BullMQ counters (JSON) for",
    "                     drain-watching and the round-trip delta capture",
    "  --soak-dir DIR     the operator capture dir (layout in the header)",
    "  --start/--end      window bounds, epoch seconds or ISO timestamps",
    "  --web-origin URL   default " + DEFAULT_WEB_ORIGIN,
    "  --worker-origin URL default " + DEFAULT_WORKER_ORIGIN,
    "  --record PATH      evidence append target (default: " + DEFAULT_RECORD + ")",
    "  --help             this usage text",
    "",
    "Env: SOAK_ADMIN_COOKIE, SOAK_NONADMIN_COOKIE, AUTH_NOTICE_START,",
    "     AUTH_NOTICE_END, REDIS_URL (--queue-status)",
  ].join("\n");
}

function fail(message, code = 1) {
  console.error(`[${SCRIPT_NAME}] FAIL: ${message}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "--dry-run" || arg === "--queue-status") {
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

/** Epoch-seconds from an integer or an ISO timestamp (D-16-style entry check). */
function parseBound(name, raw) {
  if (raw === undefined || !/^-?\d+$/.test(String(raw).trim())) {
    const parsed = raw === undefined ? NaN : Date.parse(raw);
    if (!Number.isFinite(parsed)) {
      fail(`--${name} must be an integer epoch-seconds value or an ISO timestamp (got ${JSON.stringify(raw)})`, 2);
    }
    return Math.floor(parsed / 1000);
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function fetchStatus(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const body = await response.text();
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return { ok: false, missing: true };
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, missing: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function cookieHeader(token) {
  // The env holds the raw session-token value; never echo it (T-07-26).
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

/** Parses attestations.md into a Map of KEY -> verbatim line text. */
function parseAttestations(file) {
  if (!existsSync(file)) return { ok: false, missing: true, entries: new Map() };
  const entries = new Map();
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z0-9-]+)\s*:\s*(.+)$/);
    if (match) entries.set(match[1], match[2].trim());
  }
  return { ok: true, missing: false, entries };
}

// ---------------------------------------------------------------------------
// --queue-status: email-lane BullMQ counters (drain-watch + round-trip delta)
// ----------------------------------------------------------------------------

async function printQueueStatus() {
  if (!process.env.REDIS_URL) {
    fail("REDIS_URL is not set — pass the target stack explicitly (never guess a stack)");
  }
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    const key = (suffix) => `bull:${EMAIL_LANE}:${suffix}`;
    // wait/prioritized/active are lists; delayed/failed/completed are zsets.
    const [waiting, prioritized, active, delayed, failed, completed] = await Promise.all([
      redis.llen(key("wait")),
      redis.llen(key("prioritized")),
      redis.llen(key("active")),
      redis.zcard(key("delayed")),
      redis.zcard(key("failed")),
      redis.zcard(key("completed")),
    ]);
    const lanes = { waiting, prioritized, active, delayed, failed, completed };
    const pending = waiting + prioritized + active + delayed;
    console.log(JSON.stringify({ emailLane: lanes, pending }));
    console.log(`[${SCRIPT_NAME}] email lane: ${pending} pending (drain ≈ 0), ${completed} completed, ${failed} failed`);
  } finally {
    await redis.quit().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Machine legs
// ---------------------------------------------------------------------------

async function evaluateFeedbackMatrix(opts) {
  const reasons = [];
  const web = opts.webOrigin;
  const admin = process.env.SOAK_ADMIN_COOKIE;
  const nonadmin = process.env.SOAK_NONADMIN_COOKIE;
  if (!admin || !nonadmin) {
    return {
      pass: false,
      reasons: [
        `SOAK_ADMIN_COOKIE and/or SOAK_NONADMIN_COOKIE not set — mint both sessions on the target stack`,
        "(sign in once as the admin canary and once as a non-admin, copy each better-auth.session_token value)",
      ],
      observed: {},
    };
  }

  const anon = await fetchStatus(`${web}/api/feedback`);
  const asAdmin = await fetchStatus(`${web}/api/feedback`, cookieHeader(admin));
  const asNonAdmin = await fetchStatus(`${web}/api/feedback`, cookieHeader(nonadmin));

  const observed = {
    anonymous: anon.ok ? anon.status : `fetch error: ${anon.error}`,
    admin: asAdmin.ok ? asAdmin.status : `fetch error: ${asAdmin.error}`,
    nonAdmin: asNonAdmin.ok ? asNonAdmin.status : `fetch error: ${asNonAdmin.error}`,
  };
  if (!anon.ok || anon.status !== 401) reasons.push(`anonymous GET /api/feedback must be 401 (observed ${observed.anonymous})`);
  if (!asAdmin.ok || asAdmin.status !== 200) reasons.push(`admin-session GET /api/feedback must be 200 (observed ${observed.admin})`);
  if (!asNonAdmin.ok || asNonAdmin.status !== 403) reasons.push(`non-admin-session GET /api/feedback must be 403 (observed ${observed.nonAdmin})`);
  return { pass: reasons.length === 0, reasons, observed };
}

async function evaluateBullBoardAllowlisted(opts) {
  const reasons = [];
  const admin = process.env.SOAK_ADMIN_COOKIE;
  if (!admin) {
    return { pass: false, reasons: ["SOAK_ADMIN_COOKIE not set — cannot exercise the Bull Board session gate"], observed: {} };
  }
  const res = await fetchStatus(`${opts.workerOrigin}/admin/queues`, cookieHeader(admin));
  const observed = { status: res.ok ? res.status : `fetch error: ${res.error}`, htmlMarker: false };
  if (!res.ok) {
    reasons.push(`worker origin unreachable: ${res.error}`);
  } else {
    observed.htmlMarker = res.body.includes("/admin/queues/") || res.body.toLowerCase().includes("bull board");
    if (res.status !== 200) reasons.push(`allowlisted+admin GET /admin/queues must be 200 (observed ${res.status}; 403 = gate refused, 500 = server fault — never acceptable)`);
    if (!observed.htmlMarker) reasons.push("response does not look like Bull Board HTML (no /admin/queues/ base marker)");
  }
  return { pass: reasons.length === 0, reasons, observed };
}

function evaluateBullBoardRefusal(dir) {
  const file = path.join(dir, "bullboard-refusal.json");
  const parsed = readJsonIfExists(file);
  if (!parsed.ok) {
    return {
      pass: false,
      reasons: [
        parsed.missing
          ? "bullboard-refusal.json missing — curl /admin/queues ONCE from a NON-allowlisted source (e.g. a phone-hotspot/other-network shell) and save {status, note}"
          : `bullboard-refusal.json is not valid JSON (${parsed.error})`,
      ],
      observed: {},
    };
  }
  const status = Number(parsed.value?.status);
  const observed = { status, note: parsed.value?.note ?? "" };
  if (status !== 403) {
    return {
      pass: false,
      reasons: [
        `non-allowlisted GET /admin/queues must be REFUSED with 403 (observed ${String(parsed.value?.status)}) — a 200 means the allowlist gate is not enforcing`,
      ],
      observed,
    };
  }
  return { pass: true, reasons: [], observed };
}

async function evaluateNoticeStrip(opts) {
  const reasons = [];
  const start = process.env.AUTH_NOTICE_START;
  const end = process.env.AUTH_NOTICE_END;
  const observed = { window: `${start ?? "<unset>"} .. ${end ?? "<unset>"}`, strip: false };

  const startDate = start ? Date.parse(start) : NaN;
  const endDate = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) {
    reasons.push("AUTH_NOTICE_START/AUTH_NOTICE_END must both parse as timestamps (unset/invalid bounds fail toward NO-STRIP by construction)");
  }
  const now = Date.now();
  if (Number.isFinite(startDate) && Number.isFinite(endDate)) {
    if (now < startDate || now > endDate) {
      reasons.push(`the gate runs OUTSIDE the notice window (now ${new Date(now).toISOString()}) — re-run inside it or extend the window (the strip is window-scoped by design, D-02)`);
    }
  }

  const res = await fetchStatus(`${opts.webOrigin}/login`);
  if (!res.ok) {
    reasons.push(`web origin unreachable: ${res.error}`);
  } else {
    observed.strip = res.body.includes(NOTICE_COPY);
    if (!observed.strip) reasons.push(`/login does not carry the frozen notice copy ("${NOTICE_COPY}…") — outside the window, or the strip regressed`);
  }
  return { pass: reasons.length === 0, reasons, observed };
}

function evaluateEmailRoundtrip(dir) {
  const file = path.join(dir, "email-roundtrip.json");
  const parsed = readJsonIfExists(file);
  if (!parsed.ok) {
    return {
      pass: false,
      reasons: [
        parsed.missing
          ? "email-roundtrip.json missing — capture the email-lane completed counter (--queue-status), trigger one verification + one reset round-trip, capture again, save {completedBefore, completedAfter}"
          : `email-roundtrip.json is not valid JSON (${parsed.error})`,
      ],
      observed: {},
    };
  }
  const value = parsed.value ?? {};
  if (typeof value.consoleLogLines === "number") {
    // Console-provider stacks (rehearsal): each round-trip dumps one
    // [email-console] line into the worker log.
    const observed = { consoleLogLines: value.consoleLogLines };
    if (value.consoleLogLines >= ROUNDTRIP_MIN_DELTA) return { pass: true, reasons: [], observed };
    return {
      pass: false,
      reasons: [`console-provider log lines ${value.consoleLogLines} < ${ROUNDTRIP_MIN_DELTA} (one verification + one reset expected)`],
      observed,
    };
  }
  const before = Number(value.completedBefore);
  const after = Number(value.completedAfter);
  const observed = { completedBefore: value.completedBefore, completedAfter: value.completedAfter };
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return {
      pass: false,
      reasons: ["email-roundtrip.json needs numeric completedBefore/completedAfter (capture both with --queue-status around the trigger)"],
      observed,
    };
  }
  if (after - before < ROUNDTRIP_MIN_DELTA) {
    return {
      pass: false,
      reasons: [
        `email-lane completed delta ${after - before} < ${ROUNDTRIP_MIN_DELTA} — the verification/reset round-trips did not transit the queue (EML-04)`,
      ],
      observed,
    };
  }
  return { pass: true, reasons: [], observed };
}

function evaluateDeadErrorQuiet(dir) {
  const logsDir = path.join(dir, "logs");
  let files = [];
  if (existsSync(logsDir)) {
    files = readdirSync(logsDir).filter((f) => f.endsWith(".log")).sort();
  }
  if (files.length === 0) {
    return {
      pass: false,
      reasons: ["no logs/*.log found — capture the window's web + worker logs into the soak dir (they are leg 6's entire input)"],
      observed: { filesScanned: 0, matches: [] },
    };
  }
  const matches = [];
  for (const file of files) {
    const lines = readFileSync(path.join(logsDir, file), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const marker of ERROR_MARKERS) {
        if (lines[i].includes(marker)) {
          matches.push(`${file}:${i + 1}: ${marker}`);
          break; // one hit per line is enough
        }
      }
    }
  }
  const observed = { filesScanned: files.length, matches: matches.slice(0, 10) };
  return {
    pass: matches.length === 0,
    reasons: matches.length === 0 ? [] : [`${matches.length} auth/email-surface error line(s) over the window (first 10: ${matches.slice(0, 10).join(" | ")})`],
    observed,
  };
}

// ---------------------------------------------------------------------------
// Evidence block (statuses, counts, verdicts — never secrets; T-07-26)
// ---------------------------------------------------------------------------

function evidenceBlock(opts, results, verdictLine) {
  const now = new Date().toISOString();
  const durationH = ((opts.end - opts.start) / 3600).toFixed(2);
  const lines = [
    "",
    "---",
    "",
    `## Auth soak gate evaluation — ${now}`,
    "",
    `- Window: ${new Date(opts.start * 1000).toISOString()} .. ${new Date(opts.end * 1000).toISOString()} (${opts.end - opts.start} s ≈ ${durationH} h)`,
    `- Mode: ${opts.dryRun ? "dry-run (leg list only)" : "live"}`,
    `- Verdict: ${verdictLine}`,
  ];
  if (!opts.dryRun && opts.end - opts.start < 20 * 3600) {
    lines.push(
      `- **SHORT-WINDOW NOTE:** ${durationH} h < the ~24h D-31 target — recorded plainly, covered by the D-36 operator approval (06-DEPLOY-RECORD §12 precedent; never dispositioned away)`
    );
  }
  lines.push("");
  for (const result of results) {
    const refs = result.refs ? ` [${result.refs}]` : "";
    lines.push(`LEG ${result.n} (${result.name}): ${result.verdict}${refs}`);
    for (const reason of result.reasons ?? []) lines.push(`  - ${reason}`);
    const observed = result.observed && Object.keys(result.observed).length > 0 ? JSON.stringify(result.observed) : "";
    if (observed) lines.push(`  - observed: ${observed}`);
  }
  lines.push("");
  return lines.join("\n");
}

function appendEvidence(recordPath, block) {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  appendFileSync(recordPath, block, "utf8");
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

  if (args.flags.has("queue-status")) {
    await printQueueStatus();
    return;
  }

  const dryRun = args.flags.has("dry-run");
  const webOrigin = args.values["web-origin"] ?? DEFAULT_WEB_ORIGIN;
  const workerOrigin = args.values["worker-origin"] ?? DEFAULT_WORKER_ORIGIN;

  if (dryRun) {
    // The plan's verify: the gate must parse and evaluate its leg list
    // without throwing. No network, no DB, no Redis, no record append.
    const opts = { dryRun: true, webOrigin, workerOrigin, start: 0, end: 0 };
    const results = [
      ...MACHINE_LEGS.map((leg) => ({ ...leg, verdict: "PASS (dry-run — definition only)", reasons: [], observed: {} })),
      ...ATTEST_LEGS.map((leg) => ({ ...leg, verdict: "ATTEST (dry-run — definition only)", reasons: [], observed: {} })),
    ];
    for (const result of results) {
      const refs = result.refs ? ` [${result.refs}]` : "";
      const inputs = result.inputs ? ` — inputs: ${result.inputs}` : "";
      console.log(`LEG ${result.n} (${result.name}): ${result.verdict}${refs}${inputs}`);
    }
    console.log(`[${SCRIPT_NAME}] dry-run OK — ${results.length} legs (6 machine + 7 attest) parsed and evaluated`);
    return;
  }

  const dir = args.values["soak-dir"];
  if (!dir || !existsSync(dir)) {
    fail(`--soak-dir DIR is required and must exist (got ${JSON.stringify(dir)})\n\n${usage()}`, 2);
  }
  const start = parseBound("start", args.values.start);
  const end = parseBound("end", args.values.end);
  if (end <= start) fail("--end must be after --start", 2);

  const recordPath = args.values.record ?? DEFAULT_RECORD;
  const opts = { dryRun: false, webOrigin, workerOrigin, start, end };

  const machineResults = [
    await evaluateFeedbackMatrix(opts),
    await evaluateBullBoardAllowlisted(opts),
    evaluateBullBoardRefusal(dir),
    await evaluateNoticeStrip(opts),
    evaluateEmailRoundtrip(dir),
    evaluateDeadErrorQuiet(dir),
  ];
  const attestParsed = parseAttestations(path.join(dir, "attestations.md"));

  const results = [];
  MACHINE_LEGS.forEach((leg, index) => {
    const evaluated = machineResults[index];
    results.push({
      ...leg,
      verdict: evaluated.pass ? "PASS" : "FAIL",
      reasons: evaluated.reasons ?? [],
      observed: evaluated.observed,
    });
  });
  ATTEST_LEGS.forEach((leg) => {
    const text = attestParsed.ok ? attestParsed.entries.get(leg.name) : undefined;
    if (text !== undefined) {
      results.push({ ...leg, verdict: "ATTEST", reasons: [], observed: { attestation: text } });
    } else {
      results.push({
        ...leg,
        verdict: "FAIL",
        reasons: [
          attestParsed.missing
            ? "attestations.md missing from the soak dir — record every operator-attested leg as a `KEY: verdict text` line"
            : `no attestation line for ${leg.name} — the gate never silently passes an un-recorded leg`,
        ],
        observed: {},
      });
    }
  });

  const passed = results.filter((r) => r.verdict === "PASS").length;
  const attested = results.filter((r) => r.verdict === "ATTEST").length;
  const failed = results.filter((r) => r.verdict === "FAIL").length;

  const durationH = ((end - start) / 3600).toFixed(2);
  console.log(`[${SCRIPT_NAME}] window ${new Date(start * 1000).toISOString()} -> ${new Date(end * 1000).toISOString()} (${end - start} s ≈ ${durationH} h)`);
  for (const result of results) {
    const refs = result.refs ? ` [${result.refs}]` : "";
    console.log(`LEG ${result.n} (${result.name}): ${result.verdict}${refs}`);
    for (const reason of result.reasons ?? []) console.log(`  - ${reason}`);
    const observed = result.observed && Object.keys(result.observed).length > 0 ? JSON.stringify(result.observed) : "";
    if (observed) console.log(`  - observed: ${observed}`);
  }
  const verdictText = failed === 0 ? `**PASS (${passed} pass / ${attested} attest / ${failed} fail)**` : `**FAIL (${passed} pass / ${attested} attest / ${failed} fail)**`;
  console.log(`[${SCRIPT_NAME}] VERDICT: ${passed} pass / ${attested} attest / ${failed} fail`);
  if (!dryRun && end - start < 20 * 3600) {
    console.log(`[${SCRIPT_NAME}] SHORT-WINDOW NOTE: ${durationH} h < the ~24h D-31 target — recorded plainly, covered by the D-36 approval`);
  }

  appendEvidence(recordPath, evidenceBlock(opts, results, verdictText));
  console.log(`[${SCRIPT_NAME}] evidence recorded: ${recordPath}`);

  process.exitCode = failed === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  // Never a stack dump: fail loud with the message only.
  fail(error instanceof Error ? error.message : String(error));
}
