#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Telegram webhook auth-ladder probe (06-07 / G-06-7, SEC-03 D-20/D-21).
//
// Verifies the LIVE web process's POST /api/telegram/webhook refusal ladder:
//   leg 1 — no x-telegram-bot-api-secret-token header
//   leg 2 — deliberately WRONG-LENGTH token header (8 chars; never a
//           plausible-length value, so this probe can never accidentally
//           authenticate)
//   leg 3 — bounded flood (up to 35 rapid leg-1-shaped POSTs) until the
//           per-IP 30/min limiter answers 429 (assert 429-within-cap, not an
//           exact request index — earlier legs consume bucket entries)
//
// Modes:
//   default            expect 401 / 401 / 429   (the designed posture)
//   --baseline         expect 500 / 500 / 429   (the 06-UAT G-06-7 gap shape:
//                        the launch env contract omits the secret, so the
//                        route's fail-closed unset-env path throws -> 500)
//
// Origin: defaults to http://127.0.0.1:3007; override with the first CLI
// argument or the WEB_ORIGIN environment variable (CLI wins).
//
// Secret hygiene (T-06-10): this script NEVER reads the webhook secret
// environment variable and NEVER sends a correctly-shaped secret — refusal
// legs only. Output carries HTTP status codes ONLY.
//
// OPERATOR FIX PROCEDURE (the gap this probe guards — 06-07 Task 3):
//   Root cause: the Phase-07 flip launch env contract
//   (.snapshots/0707-prod-worker-env.sh, 14 keys, gitignored) omits
//   TELEGRAM_WEBHOOK_SECRET, so the web process (restarted through that
//   contract) takes the route's DESIGNED loud config-error path (throw ->
//   logged 500, fail-closed, body never processed). The CODE is correct per
//   the 06-03 pins; only the env is missing. The production mint was
//   operator-attested at 06-05 §12 — the executor never sees, mints, or
//   handles the value.
//
//   1. OPERATOR: append one export line to .snapshots/0707-prod-worker-env.sh
//      for TELEGRAM_WEBHOOK_SECRET using the contract's existing file-read
//      pattern (store the §12-attested mint in a new gitignored file under
//      .snapshots/ and export its cat) — the SAME secret_token the 06-05
//      setWebhook registration used. The value must never appear in chat,
//      logs, commit messages, or any tracked file.
//   2. OPERATOR: restart web per the §4e form —
//      `bash .snapshots/0709-web-restart.sh` — and confirm its output shows
//      the old web stopped by cmdline-verified PID and login=200. (A worker
//      restart is NOT required for this gap — the worker does not read this
//      variable.)
//   3. OPTIONAL: to make the G-06-2 in-job manual persist observable at the
//      phase UAT re-run, build from the 06-07 Task 1 commit and restart the
//      worker via `bash .snapshots/0709-worker-restart.sh` (healthz must
//      report the new SHA, D-10 provenance). Skipping this leaves the live
//      worker on the current artifact.
//   4. Re-run this probe in default mode (expect 401/401/429, exit 0) and
//      confirm GET /login still answers 200.
//
// Lesson of record: every future launch-env-contract mint MUST carry
// TELEGRAM_WEBHOOK_SECRET (already documented in .env.example) — see
// docs/DEPLOY-RUNBOOK.md §9.
// ---------------------------------------------------------------------------

const DEFAULT_ORIGIN = "http://127.0.0.1:3007";
const WEBHOOK_PATH = "/api/telegram/webhook";
const SECRET_HEADER = "x-telegram-bot-api-secret-token";
// 8 characters — deliberately wrong-length for ANY plausible secret; this
// constant is a refusal instrument, never a candidate value.
const WRONG_LENGTH_TOKEN = "deadbeef";
const FLOOD_CAP = 35;

const argv = process.argv.slice(2);
const baseline = argv.includes("--baseline");
const cliOrigin = argv.find((a) => !a.startsWith("--"));
const origin = (cliOrigin || process.env.WEB_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, "");
const url = origin + WEBHOOK_PATH;

/** One refusal-shaped POST; resolves to the HTTP status code or "error". */
async function post(token) {
  const headers = { "content-type": "application/json" };
  if (token !== undefined) headers[SECRET_HEADER] = token;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch {
    return "error";
  }
}

const lines = [];
let allPass = true;

function leg(name, expected, actual) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  lines.push(`leg=${name} expected=${expected} actual=${actual} ${pass ? "PASS" : "FAIL"}`);
}

// Legs 1-2: the two authentication refusal shapes.
leg("no-header", baseline ? 500 : 401, await post(undefined));
leg("wrong-length", baseline ? 500 : 401, await post(WRONG_LENGTH_TOKEN));

// Leg 3: bounded flood until the 30/min per-IP limiter answers 429.
let floodActual = "no-429-within-cap";
for (let i = 1; i <= FLOOD_CAP; i++) {
  const status = await post(undefined);
  if (status === 429) {
    floodActual = 429;
    break;
  }
}
leg("flood-429", 429, floodActual);

for (const line of lines) console.log(line);
console.log(
  `verdict=${allPass ? "PASS" : "FAIL"} mode=${baseline ? "baseline" : "default"} origin=${origin}`
);
process.exit(allPass ? 0 : 1);
