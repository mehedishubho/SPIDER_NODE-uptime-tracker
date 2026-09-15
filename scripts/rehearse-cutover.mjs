#!/usr/bin/env node
// rehearse-cutover.mjs — the D-30/D-33 abbreviated cutover rehearsal
// (05-06 Task 1; 05-07 executes it against the add-release SHA). One
// leg-addressable script drives the runbook §4a choreography on a THROWAWAY
// anonymized-snapshot stand-in with zero real side effects, so the first
// cron + worker-scheduler co-run anywhere in the project happens on a
// snapshot, not on production.
//
// Usage (from the repo root):
//   node scripts/rehearse-cutover.mjs --leg all [--minutes N] [--dump PATH]
//   node scripts/rehearse-cutover.mjs --leg NAME [...]   (one leg, re-enterable)
//     NAME: rebuild | restore | sweep | reseed | unpause | corun | induce |
//           maintenance | gates | drill | teardown
//   node scripts/rehearse-cutover.mjs --self-test        (guard unit checks)
//   node scripts/rehearse-cutover.mjs --help
//
//     --dump PATH   anonymized pg_dump -F c snapshot (restore leg, REQUIRED)
//     --minutes N   co-run window length (corun leg, default 45)
//
// Legs (runbook §4a steps 4-8 + the 03-05/04-09 machinery):
//   rebuild     pnpm build; same-SHA discipline (D-31) — dist staleness
//               assert vs src/ mtimes, dist sha256 + .next BUILD_ID recorded;
//               zero-new-migrations assertion (D-44, journal-derived)
//   restore     throwaway stand-in: docker network spidernode-rehearse-net
//               (subnet 203.0.113.0/24, RFC 5737 TEST-NET-3 — see the
//               induced-parity note below), postgres:17-alpine 127.0.0.1:5460,
//               redis:8-alpine 127.0.0.1:6460, both with explicit container
//               IPs; restores the operator's anonymized dump via docker cp +
//               pg_restore with row-count/monitor-checksum verification
//   sweep       egress-neutral guard (D-30): TELEGRAM_BOT_TOKEN must be the
//               dummy value, every HC_PING_URL/WORKER_*_HC_PING_URL and
//               SMTP_*/CLOUDINARY_* var unset-equivalent, CRON_MODE unset,
//               Next telemetry off — and DATABASE_URL/REDIS_URL values
//               matching the production stand-in ports are REFUSED
//   reseed      runbook §4a step-4 D-49 UPDATE applied VERBATIM
//               (string-compared against the runbook block; row count must
//               equal the active-monitor count)
//   unpause     runbook §4a step 5: worker container (self-contained tsup
//               bundle, 04-09 step-12 machinery) with
//               WORKER_SCHEDULER_ENABLED=true — readyz via docker exec, boot
//               log must print "recurring scheduling ACTIVE" (Pitfall 4) —
//               plus the controllable-target container, plus the WEB process
//               on the host (internal cron live) on 127.0.0.1:3460
//   corun       runbook §4a step 7 (abbreviated, default 45 min): both
//               engines live; scrape-metrics.mjs runs INSIDE the worker
//               container (the health server binds in-container loopback
//               only) producing the gate-2 samples layout;
//               --capture-baseline at window open (gate 4's delta base);
//               cron-originated incidents detected -> legacy-observations
//   induce      runbook §4a step 7's parity leg (D-11): monitor against the
//               controllable target, manual-enqueue driven (deterministic —
//               both engines starved by a fresh lastChecked/next_check_at),
//               DOWN then RECOVERED flips; outbox rows captured ->
//               parity-evidence.json (D-48 payload shape, exactly one relay
//               attempt per event, FAILED under the dummy token — D-34)
//   maintenance runbook §4a step 7's WRK-13 leg: enqueue-maintenance.mjs
//               dry-run via --wait; the job's audit -> recompute-report.json
//   gates       runbook §4a step 8, two passes over the rehearsal snapshot
//               dir (05-05 contract): pass A with the TRUE window bounds —
//               the sub-4h D-16 refusal is EXPECTED (the clock rule is part
//               of what is being rehearsed); pass B with extended bounds
//               (>= 4h) against the live throwaway DB (online mode — the
//               same parameterized queries the offline fixtures stand in
//               for, already test-pinned by 05-05) + a SYNTHETIC
//               flips-heartbeat.json fixture (the real hc.io check belongs
//               to the 05-08 live window)
//   drill       runbook §4a step 6 abort drill: re-pause (flag=false +
//               container recreate) -> assert the pause boot marker ->
//               cron auto-resume proven via the §9 curl lever (due checks +
//               in-request flush) -> re-unpause into a FRESH window (D-16)
//   teardown    stop the web child, remove containers/network/work
//               artifacts, write the evidence file (the layout 05-07
//               transcribes into 05-REHEARSAL-EVIDENCE.md)
//
// Stand-in topology (all loopback-publish or docker-network-internal — the
// wildcard bind address is NEVER used, D-45 / 03-REVIEW WR-02):
//   spidernode-rehearse-pg     postgres:17-alpine  203.0.113.2  pub 127.0.0.1:5460
//   spidernode-rehearse-redis  redis:8-alpine      203.0.113.3  pub 127.0.0.1:6460
//   spidernode-rehearse-worker node:<major>-alpine 203.0.113.4  (no publish)
//   spidernode-rehearse-target node:<major>-alpine 203.0.113.5  (no publish)
//
// INDUCED-PARITY TARGET FORM (documented deviation, 05-CONTEXT D-11 leaves
// the controllable-target form to execution): the production check engine's
// SSRF denylist (src/lib/ssrf.ts) blocks every loopback and private-range
// address, and tests/lib/helpers/check-target-server.ts binds only loopback
// — a loopback target can therefore NEVER produce the UP leg of the
// DOWN/RECOVERED pair (it would classify ssrf_blocked, DOWN-only). The
// worker and a minimal controllable-target driver run as sibling containers
// on a user-defined docker network in TEST-NET-3 (203.0.113.0/24, RFC 5737
// documentation space): outside the denylist, unreachable from the host or
// LAN, and no real internet host can occupy it. The worker dials the
// target's explicit container IP (literal IP — no DNS hop).
//
// EGRESS POSTURE (prohibition 1): every spawned command receives an
// EXPLICIT env object built by buildStandInEnv() — a scrubbed copy of the
// spawning environment with every alert/heartbeat/SMTP/cloud channel
// pinned empty (present-but-empty beats file-loaded values: loaders never
// override existing keys) and TELEGRAM_BOT_TOKEN pinned to the dummy value
// below. The ONE sanctioned outbound dial is the relay's real
// api.telegram.org attempt with the dummy token, which authenticates
// nothing and lands the row FAILED (D-34's live FAILED exercise — the plan
// sanctions exactly this). Next telemetry is disabled. The sweep guard
// runs before every leg and fails loud naming any channel it finds.
//
// Zero new dependencies: node:* + the already-installed pg. Plain ESM. No
// file-based env loading anywhere in this script — explicit env only
// (split-brain guard, 04-DEPLOY-RECORD lineage).

import { execSync, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Constants — the throwaway stand-in. Own ports, own names, loopback publishes.
// ---------------------------------------------------------------------------

const SCRIPT_NAME = "rehearse-cutover.mjs";

const PG_PORT = 5460; // 03-03/03-05 precedent — never the 5453 test / 5454 prod pair
const REDIS_PORT = 6460; // fresh — never 6390 (test) or 6391 (prod stand-in)
const WEB_PORT = 3460; // rehearsal web (the cron host) — loopback
const TARGET_PORT = 8477; // in-container only (rehearsal network)

const NETWORK = "spidernode-rehearse-net";
const NETWORK_SUBNET = "203.0.113.0/24"; // RFC 5737 TEST-NET-3 — see header
const PG_IP = "203.0.113.2";
const REDIS_IP = "203.0.113.3";
const WORKER_IP = "203.0.113.4";
const TARGET_IP = "203.0.113.5";

const PG_CONTAINER = "spidernode-rehearse-pg";
const REDIS_CONTAINER = "spidernode-rehearse-redis";
const WORKER_CONTAINER = "spidernode-rehearse-worker";
const TARGET_CONTAINER = "spidernode-rehearse-target";
const ALL_CONTAINERS = [PG_CONTAINER, REDIS_CONTAINER, WORKER_CONTAINER, TARGET_CONTAINER];

const PG_IMAGE = "postgres:17-alpine";
const REDIS_IMAGE = "redis:8-alpine";
const DB = "uptime_rehearse";

// Throwaway credentials, constructed here (rehearse-migrations posture) —
// loopback-published, torn down in teardown, and the sweep/preflight guards
// assert these are the only stacks anything dials.
const PG_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${DB}`;
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;
const PG_URL_INNER = `postgres://postgres:postgres@${PG_CONTAINER}:5432/${DB}`;
const REDIS_URL_INNER = `redis://${REDIS_CONTAINER}:6379`;

// Sibling stacks nothing in this rehearsal may ever dial (T-05-06-04).
const FORBIDDEN_PORT_TOKENS = [":5454", ":6391", ":5453", ":6390", ":5433", ":6380"];

// The dummy alert token (prohibition 1): the relay dials api.telegram.org,
// authenticates nothing, and the outbox row lands FAILED after exactly one
// attempt (D-34). Obvious non-secret by construction.
const DUMMY_TELEGRAM_TOKEN = "0000000000:REHEARSAL-DUMMY-TOKEN-never-real";

// Throwaway cron secret for the rehearsal web child (§9 lever auth).
const THROWAWAY_CRON_SECRET = "rehearse-cron-secret-throwaway";

const HC_URL_KEYS = [
  "HC_PING_URL",
  "WORKER_HC_PING_URL",
  "WORKER_OUTBOX_HC_PING_URL",
  "WORKER_MEMORY_HC_PING_URL",
];
const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
const CLOUDINARY_KEYS = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];

const SNAPSHOTS_DIR = ".snapshots";
const STATE_FILE = path.join(SNAPSHOTS_DIR, "cutover-rehearsal-state.json");
const WORK_DIR = path.join(SNAPSHOTS_DIR, "cutover-rehearsal-work");
const CONTAINER_BUNDLE_DIR = path.join(WORK_DIR, "worker-bundle");
const TEMP_TSUP_CONFIG = path.join(WORK_DIR, "rehearsal-tsup.config.ts");
const DRIVER_FILE = path.join(WORK_DIR, "manual-enqueue-driver.mjs");
const TARGET_DRIVER_FILE = path.join(WORK_DIR, "target-driver.mjs");

const WORKER_BUNDLE = path.join("dist", "worker.js");
const RUNBOOK = "docs/DEPLOY-RUNBOOK.md";
const NEXT_BIN = path.join("node_modules", "next", "dist", "bin", "next");

// D-16 (gate-cutover's clock rule) — pass B extends the rehearsal window to
// the 4 h minimum so the gates actually evaluate; pass A proves the refusal.
const MIN_WINDOW_SECONDS = 4 * 3600;
const EXTENDED_PAD_SECONDS = 600;

const LEGS = [
  "rebuild",
  "restore",
  "sweep",
  "reseed",
  "unpause",
  "corun",
  "induce",
  "maintenance",
  "gates",
  "drill",
  "teardown",
];

// The runbook §4a step-4 UPDATE, transcribed VERBATIM (reseed leg
// string-compares this against docs/DEPLOY-RUNBOOK.md before executing).
const RESEED_SQL = `-- D-49 re-seed (run once, immediately before the Phase 5 scheduler unpause):
UPDATE monitors
   SET next_check_at = LEAST(
         "lastChecked" + ("interval" * interval '1 minute'),
         now()         + ("interval" * interval '1 minute'))
 WHERE "isActive";`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(context, error) {
  throw new Error(
    `rehearse-cutover failed: ${context}. ` +
      `Cause: ${error instanceof Error ? error.message : String(error)}.`
  );
}

function usage() {
  return [
    `Usage: node scripts/${SCRIPT_NAME} --leg all [--minutes N] [--dump PATH]`,
    `       node scripts/${SCRIPT_NAME} --leg NAME [--minutes N] [--dump PATH]`,
    `       node scripts/${SCRIPT_NAME} --self-test`,
    "",
    `  --leg NAME   one of: ${LEGS.join(", ")}, all`,
    `  --dump PATH  anonymized pg_dump -F c snapshot (restore leg, REQUIRED)`,
    `  --minutes N  co-run window minutes (corun leg, default 45; plan 30-60)`,
    "  --self-test run the sweep/isolation guard unit checks (no docker needed)",
    "  --help      this usage text",
    "",
    "Legs are individually addressable so a failed leg re-enters without",
    "redoing the stand-in; state persists in " + STATE_FILE + ".",
  ].join("\n");
}

/** Shell run (pnpm / git plumbing that is cmd.exe-safe). */
function run(command, options = {}) {
  return execSync(command, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

/** Argv docker invocation — NO shell, so nested quoting never breaks. */
function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

/** Captured node child (gate-cutover invocations) — status + streams. */
function runNodeCapture(scriptPath, args, env) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
    cwd: process.cwd(),
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** Bounded poll helper — every wait in this rehearsal has a deadline. */
async function waitFor(predicate, timeoutMs, label, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = "condition never evaluated true";
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      last = "still false";
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(intervalMs);
  }
  fail(`waitFor(${label}) timed out after ${timeoutMs} ms (last: ${last})`, new Error("fail-loud timeouts"));
}

function probePortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

// --- rehearsal state (leg-addressable persistence) --------------------------

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (error) {
    fail("could not parse " + STATE_FILE, error);
  }
}

function saveState(mutate) {
  const state = loadState();
  mutate(state);
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// --- rehearsal-owned pg client (host loopback; reconnectable) ---------------

let pg = null;
async function pgConnect() {
  if (pg) await pg.end().catch(() => {});
  pg = new Client({ connectionString: PG_URL });
  pg.on("error", () => {}); // idle-termination shield (harness precedent)
  await pg.connect();
}
async function pgQuery(text, params) {
  if (!pg) fail("pg client not connected", new Error("internal ordering bug"));
  return pg.query(text, params);
}

// ---------------------------------------------------------------------------
// Stand-in env + egress sweep (prohibition 1 / T-05-06-01, T-05-06-04)
// ---------------------------------------------------------------------------

/**
 * The EXPLICIT env every spawned command receives. Starts from the spawning
 * environment for PATH/system vars only, then scrubs or pins EVERY channel:
 * alert/heartbeat/SMTP/cloud keys pinned present-but-empty (file-based env
 * loaders never override existing keys, so an empty pin beats a file value),
 * TELEGRAM_BOT_TOKEN pinned to the dummy, telemetry off, cron mode
 * unset-equivalent. Overrides win last (explicit stack pins).
 */
function buildStandInEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of [...HC_URL_KEYS, ...SMTP_KEYS, ...CLOUDINARY_KEYS, "CRON_MODE"]) {
    env[key] = "";
  }
  env.TELEGRAM_BOT_TOKEN = DUMMY_TELEGRAM_TOKEN;
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.NODE_ENV = "production";
  return { ...env, ...overrides };
}

/** Extracts the forbidden host:port token from a URL without echoing the URL. */
function forbiddenPortIn(url) {
  for (const token of FORBIDDEN_PORT_TOKENS) {
    if (String(url).includes(token)) return token;
  }
  return null;
}

/**
 * The egress-neutral sweep (D-30). Returns {ok, violations}; each violation
 * NAMES the channel. Env values are never echoed — only the matched port.
 */
function sweepEgressChannels(env) {
  const violations = [];
  if (env.TELEGRAM_BOT_TOKEN !== DUMMY_TELEGRAM_TOKEN) {
    violations.push(
      "TELEGRAM_BOT_TOKEN is not the rehearsal dummy value — a real alert egress channel (T-05-06-01)"
    );
  }
  for (const key of HC_URL_KEYS) {
    if (env[key]) violations.push(`${key} is set to a live ping URL — real heartbeat egress channel`);
  }
  for (const key of SMTP_KEYS) {
    if (env[key]) violations.push(`${key} is set — real SMTP egress channel`);
  }
  for (const key of CLOUDINARY_KEYS) {
    if (env[key]) violations.push(`${key} is set — real cloud egress channel`);
  }
  if (env.CRON_MODE) {
    violations.push("CRON_MODE must stay unset-equivalent (internal cron is the rehearsal form)");
  }
  if (env.NEXT_TELEMETRY_DISABLED !== "1") {
    violations.push("NEXT_TELEMETRY_DISABLED must be 1 — Next build/start telemetry is egress");
  }
  for (const key of ["DATABASE_URL", "REDIS_URL"]) {
    const token = env[key] ? forbiddenPortIn(env[key]) : null;
    if (token) {
      violations.push(
        `${key} targets port ${token} — the production/test sibling stacks are refused (T-05-06-04)`
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Asserts the sweep on the real stand-in env — every leg calls this first. */
function runSweepGuard() {
  const { ok, violations } = sweepEgressChannels(buildStandInEnv());
  if (!ok) {
    fail(
      "egress sweep REFUSED to proceed — real side-effect channel(s) found:\n  - " + violations.join("\n  - "),
      new Error("D-30: neutralize every channel before the rehearsal runs")
    );
  }
  return { ok, violations };
}

/** Asserts nothing this script dials targets a sibling stack (T-05-06-04). */
function assertSiblingStackIsolation() {
  for (const url of [PG_URL, REDIS_URL, PG_URL_INNER, REDIS_URL_INNER]) {
    const token = forbiddenPortIn(url);
    if (token) {
      fail(
        `isolation guard tripped: a stand-in URL matches port ${token}`,
        new Error("the rehearsal must NEVER dial 5454/6391 (production stand-ins) or 5453/6390 (test)")
      );
    }
  }
}

// ---------------------------------------------------------------------------
// --self-test: the guard unit checks (plan acceptance — recorded in SUMMARY)
// ---------------------------------------------------------------------------

function selfTest() {
  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  };

  // 1. A real-looking bot token must be REFUSED, naming the channel.
  const realTokenEnv = buildStandInEnv();
  realTokenEnv.TELEGRAM_BOT_TOKEN = "1234567890:AAHfL2xQ7tRealLookingBotTokenXyZ";
  const tokenSweep = sweepEgressChannels(realTokenEnv);
  check(
    "sweep refuses a real-looking TELEGRAM_BOT_TOKEN, naming the channel",
    !tokenSweep.ok && tokenSweep.violations.some((v) => v.includes("TELEGRAM_BOT_TOKEN")),
    tokenSweep.violations[0]
  );

  // 2. The production Redis URL must be REFUSED (prohibition 3 verification).
  const prodRedisEnv = buildStandInEnv({ REDIS_URL: "redis://127.0.0.1:6391" });
  const redisSweep = sweepEgressChannels(prodRedisEnv);
  check(
    "sweep refuses the production Redis URL (port 6391)",
    !redisSweep.ok && redisSweep.violations.some((v) => v.includes("REDIS_URL") && v.includes("6391")),
    redisSweep.violations.find((v) => v.includes("REDIS_URL"))
  );

  // 3. The clean stand-in env passes.
  const clean = sweepEgressChannels(buildStandInEnv());
  check("sweep passes the clean stand-in env", clean.ok, clean.ok ? "zero violations" : clean.violations[0]);

  // 4. Source scan: no wildcard bind literal anywhere in this script, and no
  //    file-based env loader import. The scan pattern is built at runtime so
  //    this source never contains the literal either.
  const ownSource = readFileSync(new URL(import.meta.url), "utf8");
  const wildcard = ["0", ".", "0", ".", "0", ".", "0"].join("");
  check(
    "source contains no wildcard bind literal (D-45)",
    !ownSource.includes(wildcard),
    ownSource.includes(wildcard) ? "literal found" : "absent"
  );
  check(
    "source loads no file-based env (explicit env objects only)",
    !ownSource.includes(["dot", "env"].join("")),
    "no file-env loader reference"
  );

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n[${SCRIPT_NAME}] self-test: ${results.length - failed.length}/${results.length} checks green`
  );
  if (failed.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Leg: rebuild — pnpm build + same-SHA discipline (D-31) + zero-new-migrations
// ---------------------------------------------------------------------------

function assertZeroNewMigrations() {
  if (!existsSync("drizzle/meta/_journal.json")) {
    fail("drizzle/meta/_journal.json not found", new Error("run from the repository root"));
  }
  const entries = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries.length;
  const onDisk = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).length;
  const tracked = run("git ls-files -- drizzle")
    .split(/\r?\n/)
    .filter((l) => l.endsWith(".sql")).length;
  if (entries !== onDisk || onDisk !== tracked) {
    fail(
      "zero-new-migrations assertion FAILED (D-44)",
      new Error(`journal=${entries}, on-disk=${onDisk}, tracked=${tracked} — commit migrations first`)
    );
  }
  const dirty = run("git status --porcelain -- drizzle")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (dirty.length > 0) {
    fail(
      "zero-new-migrations assertion FAILED (D-44)",
      new Error(`uncommitted drizzle/ changes: ${dirty.join("; ")}`)
    );
  }
  return entries;
}

/** Newest mtime under src/ — the staleness bound for the dist artifact. */
function newestSourceMtime(dir, best = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) best = newestSourceMtime(full, best);
    else if (/\.(ts|tsx)$/.test(entry.name)) best = Math.max(best, statSync(full).mtimeMs);
  }
  return best;
}

async function legRebuild() {
  console.log("[rebuild] zero-new-migrations + pnpm build + provenance (D-31/D-44)...");
  const journalEntries = assertZeroNewMigrations();
  try {
    run("pnpm build", {
      env: buildStandInEnv({
        // env-less-checkout precedent (02-07): the Next build needs this var
        NEXT_PUBLIC_DEV_BASE_URL: process.env.NEXT_PUBLIC_DEV_BASE_URL ?? "http://localhost:3007",
      }),
      stdio: "inherit",
    });
  } catch (error) {
    fail("pnpm build failed", error);
  }
  if (!existsSync(WORKER_BUNDLE)) {
    fail("build completed but dist/worker.js is missing", new Error("tsup worker entry did not emit"));
  }
  // D-31 same-SHA discipline: the artifact must not be stale vs sources.
  const distMtime = statSync(WORKER_BUNDLE).mtimeMs;
  const srcNewest = newestSourceMtime("src");
  if (distMtime < srcNewest) {
    fail(
      "dist/worker.js is STALE relative to src/ (D-31)",
      new Error("a source file is newer than the bundle — rebuild before rehearsing")
    );
  }
  const buildSha = run("git rev-parse --short HEAD").trim();
  const distSha = sha256(readFileSync(WORKER_BUNDLE));
  const nextBuildId = existsSync(path.join(".next", "BUILD_ID"))
    ? readFileSync(path.join(".next", "BUILD_ID"), "utf8").trim()
    : "(no .next BUILD_ID)";
  saveState((s) => {
    s.buildSha = buildSha;
    s.distSha256 = distSha.slice(0, 16);
    s.nextBuildId = nextBuildId;
    s.journalEntries = journalEntries;
    s.legs = { ...s.legs, rebuild: { status: "ok", buildSha, distSha256: distSha.slice(0, 16), nextBuildId } };
  });
  console.log(
    `  -> GREEN: SHA ${buildSha}, dist sha256 ${distSha.slice(0, 16)}, .next BUILD_ID ${nextBuildId}, journal ${journalEntries}, dist fresh vs src/`
  );
}

// ---------------------------------------------------------------------------
// Leg: restore — throwaway stand-in + anonymized snapshot restore
// ---------------------------------------------------------------------------

function checkContainersAbsent() {
  let names = [];
  try {
    names = docker(["ps", "-a", "--format", "{{.Names}}"]).split(/\r?\n/);
  } catch (error) {
    fail("could not list docker containers (is Docker Desktop running?)", error);
  }
  const present = ALL_CONTAINERS.filter((name) => names.includes(name));
  if (present.length > 0) {
    fail(
      `container name(s) already exist: ${present.join(", ")}`,
      new Error(`orphaned previous run — remove first: docker rm -f ${present.join(" ")}`)
    );
  }
}

function checkDockerPortsFree() {
  let ports = "";
  try {
    ports = docker(["ps", "--format", "{{.Names}} {{.Ports}}"]);
  } catch (error) {
    fail("could not list docker containers", error);
  }
  for (const port of [PG_PORT, REDIS_PORT]) {
    const holder = ports.split(/\r?\n/).filter((line) => line.includes(`:${port}->`));
    if (holder.length > 0) {
      fail(
        `rehearsal port ${port} is already published by another container`,
        new Error(`held by: ${holder.join("; ")} — refusing to touch sibling stacks`)
      );
    }
  }
}

async function legRestore(dumpPath) {
  console.log("[restore] throwaway stand-in + anonymized snapshot restore...");
  if (!dumpPath || !existsSync(dumpPath)) {
    fail(
      "--dump PATH is required (an anonymized pg_dump -F c snapshot)",
      new Error("produce one with scripts/anonymize-snapshot.mjs (03-05 machinery), then pass --dump")
    );
  }
  checkContainersAbsent();
  checkDockerPortsFree();
  for (const port of [PG_PORT, REDIS_PORT, WEB_PORT]) {
    if (!(await probePortFree(port))) {
      fail(`rehearsal port ${port} is held by a non-docker listener`, new Error("free the port first"));
    }
  }
  assertSiblingStackIsolation();

  // Network with the pinned TEST-NET-3 subnet (header: induced-parity form).
  try {
    docker(["network", "create", NETWORK, "--subnet", NETWORK_SUBNET], { stdio: "ignore" });
  } catch (error) {
    fail(`docker network create ${NETWORK} failed`, error);
  }
  try {
    docker(
      [
        "run", "-d", "--name", PG_CONTAINER, "--network", NETWORK, "--ip", PG_IP,
        "-e", "POSTGRES_PASSWORD=postgres", "-e", `POSTGRES_DB=${DB}`,
        "-p", `127.0.0.1:${PG_PORT}:5432`, PG_IMAGE,
      ],
      { stdio: "inherit" }
    );
  } catch (error) {
    fail(`docker run failed for ${PG_CONTAINER}`, error);
  }
  try {
    docker(
      [
        "run", "-d", "--name", REDIS_CONTAINER, "--network", NETWORK, "--ip", REDIS_IP,
        "-p", `127.0.0.1:${REDIS_PORT}:6379`, REDIS_IMAGE,
      ],
      { stdio: "inherit" }
    );
  } catch (error) {
    fail(`docker run failed for ${REDIS_CONTAINER}`, error);
  }

  // TWO consecutive pg_isready successes (Docker Desktop first-accept quirk).
  let pgReadyStreak = 0;
  await waitFor(async () => {
    try {
      docker(["exec", PG_CONTAINER, "pg_isready", "-U", "postgres", "-d", DB], { stdio: "ignore" });
      pgReadyStreak += 1;
    } catch {
      pgReadyStreak = 0;
    }
    if (pgReadyStreak >= 2) return true;
    await sleep(1000);
    return false;
  }, 45_000, "postgres ready (2 consecutive probes)");
  try {
    docker(["exec", REDIS_CONTAINER, "redis-cli", "ping"], { stdio: "ignore" });
  } catch (error) {
    fail("redis did not answer PING after start", error);
  }

  // Restore: docker cp the dump in, pg_restore --no-owner/--no-privileges
  // (the anonymized dump's roles do not exist on the throwaway), then rm.
  const inContainerDump = "/tmp/rehearsal-anon.dump";
  try {
    docker(["cp", toPosix(path.resolve(dumpPath)), `${PG_CONTAINER}:${inContainerDump}`], {
      stdio: "inherit",
    });
  } catch (error) {
    fail(`docker cp of the anonymized dump into ${PG_CONTAINER} failed`, error);
  }
  try {
    docker(
      [
        "exec", PG_CONTAINER, "pg_restore", "-U", "postgres",
        "--no-owner", "--no-privileges", "--dbname", DB, inContainerDump,
      ],
      { stdio: "inherit" }
    );
  } catch (error) {
    fail("pg_restore of the anonymized snapshot failed", error);
  }
  try {
    docker(["exec", PG_CONTAINER, "rm", "-f", inContainerDump], { stdio: "ignore" });
  } catch {
    /* best-effort cleanup inside the throwaway */
  }

  // Row-count/checksum verification against the restored snapshot.
  await pgConnect();
  const tableCounts = {};
  for (const table of ["users", "monitors", "pings", "incidents", "outbox"]) {
    tableCounts[table] = Number(
      (await pgQuery(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
    );
  }
  if (tableCounts.users === 0 || tableCounts.monitors === 0) {
    fail(
      "restored snapshot is empty",
      new Error(`counts: ${JSON.stringify(tableCounts)} — wrong dump file?`)
    );
  }
  const monitorChecksum = (
    await pgQuery(
      `SELECT md5(string_agg(id::text || '|' || url || '|' || status, ',' ORDER BY id)) AS c FROM monitors`
    )
  ).rows[0].c;
  let migrationRows = null;
  try {
    migrationRows = Number(
      (await pgQuery(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)).rows[0].n
    );
  } catch {
    migrationRows = null; // snapshot predates the drizzle journal — observation only
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
  const snapDir = `${SNAPSHOTS_DIR}/cutover-rehearsal-${stamp}`;
  mkdirSync(snapDir, { recursive: true });
  saveState((s) => {
    s.snapDir = snapDir;
    s.dumpFile = path.resolve(dumpPath);
    s.containersUp = true;
    s.restore = { tableCounts, monitorChecksum, migrationRows };
    s.legs = { ...s.legs, restore: { status: "ok", snapDir, tableCounts, monitorChecksum, migrationRows } };
  });
  console.log(`  -> GREEN: ${PG_CONTAINER}+${REDIS_CONTAINER} up; counts ${JSON.stringify(tableCounts)}`);
  console.log(`  -> monitor checksum ${monitorChecksum}; migration rows ${migrationRows}; snapshots ${snapDir}`);
}

// ---------------------------------------------------------------------------
// Leg: sweep — record the egress-neutral verdict (D-30)
// ---------------------------------------------------------------------------

function legSweep() {
  console.log("[sweep] egress-neutral guard over the stand-in env (D-30)...");
  runSweepGuard(); // fails loud on any real channel
  saveState((s) => {
    s.legs = { ...s.legs, sweep: { status: "ok", violations: 0 } };
  });
  console.log("  -> GREEN: zero real side-effect channels (dummy token, empty pins, telemetry off)");
}

// ---------------------------------------------------------------------------
// Leg: reseed — the runbook §4a step-4 D-49 UPDATE, verbatim
// ---------------------------------------------------------------------------

function normalizeSql(text) {
  return text.replace(/\s+/g, " ").trim();
}

async function legReseed() {
  console.log("[reseed] D-49 next_check_at re-seed (runbook §4a step 4, verbatim)...");
  if (!existsSync(RUNBOOK)) {
    fail(`${RUNBOOK} not found`, new Error("run from the repository root"));
  }
  // String-compare the encoded UPDATE against the runbook block (plan
  // acceptance): extract from the "-- D-49 re-seed" marker through the
  // WHERE clause, normalize whitespace, require byte-equal semantics.
  const runbook = readFileSync(RUNBOOK, "utf8");
  const start = runbook.indexOf("-- D-49 re-seed");
  const whereEnd = runbook.indexOf('WHERE "isActive";', start);
  if (start < 0 || whereEnd < 0) {
    fail("could not locate the D-49 re-seed block in the runbook", new Error("runbook layout drifted — reconcile"));
  }
  const runbookBlock = runbook.slice(start, whereEnd + 'WHERE "isActive";'.length);
  if (normalizeSql(runbookBlock) !== normalizeSql(RESEED_SQL)) {
    fail(
      "the encoded D-49 UPDATE no longer matches the runbook block verbatim",
      new Error("transcribe the runbook §4a step-4 UPDATE into RESEED_SQL and re-run")
    );
  }

  await pgConnect();
  const activeBefore = Number(
    (await pgQuery(`SELECT count(*)::int AS n FROM monitors WHERE "isActive"`)).rows[0].n
  );
  const updateStatement = RESEED_SQL.split("\n").slice(1).join("\n"); // strip the comment line
  const res = await pgQuery(updateStatement);
  const applied = Number(res.rowCount ?? 0);
  if (applied !== activeBefore) {
    fail(
      "D-49 UPDATE row count != active-monitor count",
      new Error(`applied ${applied}, active monitors ${activeBefore} (runbook verification step)`)
    );
  }
  const sqlSha = sha256(RESEED_SQL).slice(0, 16);
  saveState((s) => {
    s.legs = { ...s.legs, reseed: { status: "ok", applied, activeBefore, sqlSha } };
  });
  console.log(`  -> GREEN: applied to ${applied} row(s) == active count; block sha256 ${sqlSha} (runbook-matched)`);
}

// ---------------------------------------------------------------------------
// Leg: unpause — worker container (schedulers ON) + target container + web
// ---------------------------------------------------------------------------

function buildWorkerContainerBundle(buildSha) {
  mkdirSync(WORK_DIR, { recursive: true });
  rmSync(CONTAINER_BUNDLE_DIR, { recursive: true, force: true });
  const buildTs = new Date().toISOString();
  // skipNodeModulesBundle:false + noExternal:[/.*/] — deps REALLY inlined
  // (04-09 lesson: the pnpm junction node_modules cannot bind-mount into
  // Linux); pg-native stays external (lazy native getter never loads).
  writeFileSync(
    TEMP_TSUP_CONFIG,
    `// TEMPORARY rehearsal artifact (scripts/rehearse-cutover.mjs) — removed in teardown.\n` +
      `import { defineConfig } from "tsup";\n` +
      `export default defineConfig({\n` +
      `  entry: { worker: "src/worker/index.ts" },\n` +
      `  format: ["cjs"],\n` +
      `  outDir: ${JSON.stringify(toPosix(CONTAINER_BUNDLE_DIR))},\n` +
      `  sourcemap: false,\n` +
      `  skipNodeModulesBundle: false,\n` +
      `  noExternal: [/.*/],\n` +
      `  platform: "node",\n` +
      `  target: "node20",\n` +
      `  splitting: false,\n` +
      `  external: ["pg-native"],\n` +
      `  define: {\n` +
      `    "process.env.WORKER_BUILD_SHA": ${JSON.stringify(JSON.stringify(buildSha))},\n` +
      `    "process.env.WORKER_BUILD_TS": ${JSON.stringify(JSON.stringify(buildTs))},\n` +
      `  },\n` +
      `});\n`,
    "utf8"
  );
  try {
    run(`pnpm exec tsup --config ${toPosix(TEMP_TSUP_CONFIG)}`, { stdio: "inherit" });
  } catch (error) {
    fail("worker container-bundle tsup build failed", error);
  }
  if (!existsSync(path.join(CONTAINER_BUNDLE_DIR, "worker.js"))) {
    fail("container bundle missing", new Error(`${CONTAINER_BUNDLE_DIR}/worker.js not produced`));
  }
}

/** The controllable-target driver (plain Node — no src imports, no bundle). */
function writeTargetDriver() {
  writeFileSync(
    TARGET_DRIVER_FILE,
    [
      "// TEMPORARY rehearsal artifact (scripts/rehearse-cutover.mjs induce leg).",
      "// The induced-parity controllable target: binds its EXPLICIT container",
      "// IP on the rehearsal network only (never the wildcard bind).",
      "//   GET /probe        200 (up) | 503 (down)  — the monitor's URL",
      "//   GET /__flip?state=up|down                  — the flip lever",
      "import http from \"node:http\";",
      `const HOST = "${TARGET_IP}";`,
      `const PORT = ${TARGET_PORT};`,
      "let up = true;",
      "const server = http.createServer((req, res) => {",
      "  const url = new URL(req.url, `http://${HOST}:${PORT}`);",
      "  if (url.pathname === \"/__flip\") {",
      "    up = url.searchParams.get(\"state\") !== \"down\";",
      "    res.writeHead(200, { \"content-type\": \"text/plain\" });",
      "    res.end(up ? \"up\" : \"down\");",
      "    return;",
      "  }",
      "  if (url.pathname === \"/probe\") {",
      "    if (up) { res.writeHead(200, { \"content-type\": \"text/plain\" }); res.end(\"ok\"); }",
      "    else { res.writeHead(503, { \"content-type\": \"text/plain\" }); res.end(\"down\"); }",
      "    return;",
      "  }",
      "  res.writeHead(404, { \"content-type\": \"text/plain\" }); res.end(\"not found\");",
      "});",
      "server.listen(PORT, HOST, () => console.log(`target listening on ${HOST}:${PORT}`));",
      "",
    ].join("\n"),
    "utf8"
  );
}

function pullNodeImage() {
  const nodeImage = `node:${process.versions.node.split(".")[0]}-alpine`;
  try {
    docker(["pull", nodeImage], { stdio: "inherit" });
  } catch (error) {
    fail(`docker pull ${nodeImage} failed`, error);
  }
  return nodeImage;
}

/** (Re)creates the worker container in the given flag posture. */
async function recreateWorkerContainer(nodeImage, schedulerEnabled) {
  try {
    docker(["rm", "-f", WORKER_CONTAINER], { stdio: "ignore" });
  } catch {
    /* absent — fine */
  }
  try {
    docker(
      [
        "create", "--name", WORKER_CONTAINER, "--network", NETWORK, "--ip", WORKER_IP,
        "-e", `DATABASE_URL=${PG_URL_INNER}`,
        "-e", `REDIS_URL=${REDIS_URL_INNER}`,
        "-e", `WORKER_SCHEDULER_ENABLED=${schedulerEnabled ? "true" : "false"}`,
        "-e", `TELEGRAM_BOT_TOKEN=${DUMMY_TELEGRAM_TOKEN}`,
        "-e", "NODE_ENV=production",
        nodeImage, "node", "/worker/worker.js",
      ],
      { stdio: "inherit" }
    );
    docker(["cp", `${toPosix(CONTAINER_BUNDLE_DIR)}/.`, `${WORKER_CONTAINER}:/worker`], {
      stdio: "inherit",
    });
    docker(["start", WORKER_CONTAINER], { stdio: "inherit" });
  } catch (error) {
    fail(`worker container create/cp/start failed (flag=${schedulerEnabled})`, error);
  }
  const readyStart = Date.now();
  try {
    await waitFor(() => {
      try {
        docker(
          ["exec", WORKER_CONTAINER, "node", "-e",
           "fetch('http://127.0.0.1:9090/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
          { stdio: "ignore" }
        );
        return true;
      } catch {
        return false;
      }
    }, 60_000, "worker container readyz (docker exec)");
  } catch (error) {
    let logs = "(docker logs unavailable)";
    try {
      logs = docker(["logs", "--tail", "80", WORKER_CONTAINER]).trim();
    } catch {
      /* container may be gone */
    }
    fail(`worker container never became ready — docker logs tail:\n${logs}`, error);
  }
  return Date.now() - readyStart;
}

// --- web child (the cron host) ----------------------------------------------

let webChild = null;
let webChildExited = false;
const webOutputChunks = [];

function spawnWebChild() {
  webChild = spawn(process.execPath, [toPosix(NEXT_BIN), "start", "-p", String(WEB_PORT)], {
    cwd: process.cwd(),
    env: buildStandInEnv({
      DATABASE_URL: PG_URL,
      REDIS_URL: REDIS_URL,
      CRON_SECRET: THROWAWAY_CRON_SECRET,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    webOutputChunks.push(chunk.toString("utf8"));
    if (webOutputChunks.length > 400) webOutputChunks.shift();
  };
  webChild.stdout.on("data", capture);
  webChild.stderr.on("data", capture);
  webChild.once("exit", () => {
    webChildExited = true;
  });
}

function assertWebAlive(stepLabel) {
  if (webChildExited) {
    fail(`${stepLabel}: web process EXITED`, new Error(`output tail:\n${webOutputChunks.join("").slice(-3000)}`));
  }
}

async function legUnpause(state) {
  console.log("[unpause] worker container (schedulers ON) + target container + web (Pitfall 4)...");
  if (!state.buildSha) {
    fail("unpause needs the rebuild leg first", new Error("run --leg rebuild"));
  }
  // Stand-in containers must be up (restore leg).
  for (const name of [PG_CONTAINER, REDIS_CONTAINER]) {
    try {
      docker(["inspect", name], { stdio: "ignore" });
    } catch {
      fail(`${name} is not running`, new Error("run --leg restore (with --dump) first"));
    }
  }

  buildWorkerContainerBundle(state.buildSha);
  writeTargetDriver();
  const nodeImage = pullNodeImage();

  // Target container: explicit container IP bind, readiness via its own IP.
  try {
    docker(["rm", "-f", TARGET_CONTAINER], { stdio: "ignore" });
  } catch {
    /* absent */
  }
  try {
    docker(
      ["create", "--name", TARGET_CONTAINER, "--network", NETWORK, "--ip", TARGET_IP,
       nodeImage, "node", "/target/target-driver.mjs"],
      { stdio: "inherit" }
    );
    docker(["cp", toPosix(TARGET_DRIVER_FILE), `${TARGET_CONTAINER}:/target/target-driver.mjs`], {
      stdio: "inherit",
    });
    docker(["start", TARGET_CONTAINER], { stdio: "inherit" });
  } catch (error) {
    fail("target container create/cp/start failed", error);
  }
  await waitFor(() => {
    try {
      docker(
        ["exec", TARGET_CONTAINER, "node", "-e",
         `fetch('http://${TARGET_IP}:${TARGET_PORT}/probe').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],
        { stdio: "ignore" }
      );
      return true;
    } catch {
      return false;
    }
  }, 30_000, "target container /probe up");

  // Worker container — flag ON (the unpause itself). The flag is boot-read:
  // the container recreate IS the restart (runbook §4a step 5).
  const readyMs = await recreateWorkerContainer(nodeImage, true);
  const bootLogs = docker(["logs", WORKER_CONTAINER]);
  if (!bootLogs.includes("recurring scheduling ACTIVE")) {
    fail(
      "worker boot log did not print 'recurring scheduling ACTIVE' (Pitfall 4 — flag never reached the process)",
      new Error("check the container env wiring; the 04 split-brain guard exists for exactly this")
    );
  }

  // Web (cron host) on the host loopback. Internal cron live (CRON_MODE
  // unset-equivalent); ready = the cron route answers 401 without auth.
  spawnWebChild();
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/cron/check`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.status === 401;
    } catch {
      return false;
    }
  }, 90_000, "web up (cron route gated)");

  const windowStart = nowEpochSeconds();
  saveState((s) => {
    s.windowStart = windowStart;
    s.workerFlagOn = true;
    s.legs = {
      ...s.legs,
      unpause: {
        status: "ok",
        activeMarker: true,
        readyMs,
        windowStart,
        note: "four schedulers activate at once at unpause (check-tick 30s, tier2-flush 30s, relay-pass 5s, maintenance daily) — expected, noted per runbook §4a step 5",
      },
    };
  });
  console.log(`  -> GREEN: ACTIVE marker seen; worker readyz in ${readyMs} ms; web gated on :${WEB_PORT}`);
}

// ---------------------------------------------------------------------------
// Leg: corun — the abbreviated overlap window (runbook §4a step 7)
// ---------------------------------------------------------------------------

async function legCorun(state, minutes) {
  console.log(`[corun] ${minutes}-minute overlap window (worker schedulers + web cron)...`);
  const snapDir = state.snapDir;
  if (!snapDir || !existsSync(snapDir)) {
    fail("corun needs the restore leg first", new Error("run --leg restore --dump PATH"));
  }
  try {
    docker(["inspect", WORKER_CONTAINER], { stdio: "ignore" });
  } catch {
    fail(`${WORKER_CONTAINER} is not running`, new Error("run --leg unpause first"));
  }
  if (!webChild) spawnWebChild(); // standalone re-entry: web must be up too
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/cron/check`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.status === 401;
    } catch {
      return false;
    }
  }, 90_000, "web up (corun)");

  // Gate 4's delta base — captured at window open (D-02; 05-05 contract).
  const gateEnv = buildStandInEnv({ DATABASE_URL: PG_URL });
  delete gateEnv.HC_READ_ONLY_API_KEY; // cache path stays deterministic
  const baseline = runNodeCapture("scripts/gate-cutover.mjs",
    ["--capture-baseline", "--snapshots", snapDir, "--db", PG_URL], gateEnv);
  if (baseline.status !== 0 || !existsSync(path.join(snapDir, "counters-baseline.json"))) {
    fail("gate-cutover --capture-baseline failed at window open", new Error(baseline.stderr || baseline.stdout));
  }

  // The scraper runs INSIDE the worker container: the health server binds
  // in-container loopback only (no env seam), so a sibling process can never
  // reach it — docker cp in, docker exec -d, docker cp the samples out.
  try {
    docker(["exec", WORKER_CONTAINER, "mkdir", "-p", "/scrape", "/scrape-out"], { stdio: "ignore" });
    docker(["cp", "scripts/scrape-metrics.mjs", `${WORKER_CONTAINER}:/scrape/scrape-metrics.mjs`], {
      stdio: "inherit",
    });
  } catch (error) {
    fail("could not stage scrape-metrics.mjs into the worker container", error);
  }
  try {
    docker(
      ["exec", "-d", WORKER_CONTAINER, "node", "/scrape/scrape-metrics.mjs",
       "--url", "http://127.0.0.1:9090/metrics", "--interval", "15", "--out", "/scrape-out"],
      { stdio: "ignore" }
    );
  } catch (error) {
    fail("could not start the in-container scraper", error);
  }

  // Hold the window: assert both engines stay up; snapshot /metrics.json.
  await pgConnect();
  const pingsBefore = Number((await pgQuery(`SELECT count(*)::int AS n FROM pings`)).rows[0].n);
  const metricsSnapshotsPath = path.join(snapDir, "metrics-snapshots.jsonl");
  const windowStartedAt = Date.now();
  while (Date.now() - windowStartedAt < minutes * 60_000) {
    await sleep(60_000);
    try {
      docker(["inspect", "-f", "{{.State.Running}}", WORKER_CONTAINER], { stdio: "ignore" });
    } catch {
      fail("worker container stopped mid-window", new Error("docker inspect says not running"));
    }
    assertWebAlive("corun window");
    try {
      const raw = docker(
        ["exec", WORKER_CONTAINER, "node", "-e",
         "fetch('http://127.0.0.1:9090/metrics.json').then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(String(e));process.exit(1)})"]
      );
      const parsed = JSON.parse(raw);
      writeFileSync(
        metricsSnapshotsPath,
        JSON.stringify({ at: new Date().toISOString(), breaker: parsed.breaker ?? null }) + "\n",
        { flag: "a" }
      );
    } catch {
      /* observation only — the samples are the gate evidence */
    }
  }

  // Stop the scraper (SIGTERM -> its clean-shutdown path), collect samples.
  try {
    docker(["exec", WORKER_CONTAINER, "pkill", "-f", "scrape-metrics"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  await sleep(2000);
  mkdirSync(path.join(snapDir, "samples"), { recursive: true });
  try {
    docker(["cp", `${WORKER_CONTAINER}:/scrape-out/samples/.`, toPosix(path.resolve(snapDir, "samples")) + "/"], {
      stdio: "inherit",
    });
    docker(["cp", `${WORKER_CONTAINER}:/scrape-out/summary.md`, toPosix(path.resolve(snapDir, "scraper-summary.md"))], {
      stdio: "inherit",
    });
  } catch (error) {
    fail("could not collect the scraper samples out of the worker container", error);
  }
  const sampleCount = readdirSync(path.join(snapDir, "samples")).filter((f) => f.endsWith(".txt")).length;
  const minSamples = Math.max(1, Math.floor((minutes * 60) / 15) - 3);
  if (sampleCount < minSamples) {
    fail(
      `only ${sampleCount} sample(s) collected (expected >= ${minSamples})`,
      new Error("the scraper failed mid-window — inspect scraper-summary.md; a dead worker must never yield a silent PASS")
    );
  }

  const windowEnd = nowEpochSeconds();
  const pingsCreated = Number((await pgQuery(`SELECT count(*)::int AS n FROM pings`)).rows[0].n) - pingsBefore;

  // Cron-originated incidents (zero outbox rows = the direct-send class)
  // become gate 7's observation log entries (D-05 verify+gate+disposition).
  const cronIncidents = (
    await pgQuery(
      `SELECT i.id AS incident_id, i."monitorId" AS monitor_id
         FROM incidents i
        WHERE i."startedAt" >= to_timestamp($1) AT TIME ZONE 'utc'
          AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.incident_id = i.id)`,
      [state.windowStart ?? windowEnd - minutes * 60]
    )
  ).rows;
  const observations = cronIncidents.map((row, i) => ({
    id: `LO-${i + 1}`,
    kind: "cron-originated-incident",
    observed: `incident ${String(row.incident_id).slice(0, 8)} on monitor ${row.monitor_id} has no outbox rows (direct-send class)`,
  }));
  writeFileSync(path.join(snapDir, "legacy-observations.json"), JSON.stringify(observations, null, 2), "utf8");

  saveState((s) => {
    s.windowEnd = windowEnd;
    s.legs = {
      ...s.legs,
      corun: { status: "ok", minutes, sampleCount, pingsCreated, cronOriginatedIncidents: observations.length },
    };
  });
  console.log(
    `  -> GREEN: ${sampleCount} samples, ${pingsCreated} pings created, ${observations.length} cron-originated incident(s) logged`
  );
}

// ---------------------------------------------------------------------------
// Leg: induce — the D-11 DOWN/RECOVERED parity pair (runbook §4a step 7)
// ---------------------------------------------------------------------------

function writeEnqueueDriver() {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(
    DRIVER_FILE,
    [
      "// TEMPORARY rehearsal artifact (scripts/rehearse-cutover.mjs induce leg) —",
      "// one manual enqueue via the REAL helper (enqueueManualCheck), tsx-run",
      "// with explicit stand-in env. Prints JSON; exit code is the verdict.",
      "const monitorId = Number(process.argv[2]);",
      "const watchdog = setTimeout(() => { console.error('driver timeout'); process.exit(1); }, 120000);",
      "watchdog.unref?.();",
      "try {",
      "  const queues = await import('../../src/worker/queues.ts');",
      "  const { jobId } = await queues.enqueueManualCheck(monitorId);",
      "  console.log(JSON.stringify({ ok: true, jobId }));",
      "} finally {",
      "  try { (await import('../../src/worker/queues.ts')).disposeWorkerQueues(); } catch {}",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
}

function manualEnqueueOnce(monitorId) {
  try {
    const out = run(`pnpm exec tsx ${toPosix(DRIVER_FILE)} ${monitorId}`, {
      env: buildStandInEnv({ DATABASE_URL: PG_URL, REDIS_URL: REDIS_URL }),
    });
    const parsed = JSON.parse(out.trim().split(/\r?\n/).pop());
    if (!parsed.ok) throw new Error("driver reported not-ok");
    return parsed.jobId;
  } catch (error) {
    fail(`manual enqueue driver failed for monitor ${monitorId}`, error);
  }
}

/** Waits for the monitor row to reach the target status + optional outbox row. */
async function waitForCheck(monitorId, targetStatus, wantEventType) {
  await waitFor(async () => {
    const monitor = (await pgQuery(`SELECT status FROM monitors WHERE id = $1`, [monitorId])).rows[0];
    if (!monitor || monitor.status !== targetStatus) return false;
    if (wantEventType) {
      const rows = (
        await pgQuery(`SELECT id FROM outbox WHERE monitor_id = $1 AND event_type = $2`, [monitorId, wantEventType])
      ).rows;
      if (rows.length < 1) return false;
    }
    return true;
  }, 120_000, `monitor ${monitorId} -> ${targetStatus}${wantEventType ? ` + ${wantEventType}` : ""}`);
}

/** Flips the target container's /probe state via docker exec (host cannot). */
function flipTarget(state) {
  docker(
    ["exec", TARGET_CONTAINER, "node", "-e",
     `fetch('http://${TARGET_IP}:${TARGET_PORT}/__flip?state=${state}').then(r=>process.exit(r.ok?0:1)).catch(e=>{console.error(String(e));process.exit(1)})`],
    { stdio: "ignore" }
  );
}

// The D-48 outbox payload shape — extend, never rename (04-04 decision).
const D48_PAYLOAD_KEYS = [
  "claimEpoch",
  "errorClass",
  "monitorName",
  "monitorUrl",
  "occurredAt",
  "userTimezone",
  "statusCode",
  "responseTimeMs",
];
const ERROR_CLASS_VOCABULARY = ["timeout", "dns", "tls", "ssrf_blocked", "http_5xx", "network"];

/**
 * byteMatch at the payload boundary (05-06 must-have): each induced event's
 * payload carries EXACTLY the D-48 keys (the _relayFailure marker excluded),
 * values are render-compatible, exactly one row per event, down/recovered
 * share one incident, and every row shows exactly ONE relay attempt that
 * landed FAILED under the dummy token (D-34). Byte-level identity against
 * the cron template is pinned by 04-07's suite; the rehearsal proves the
 * live pipeline emits the pinned shape.
 */
function evaluateByteMatch(rows, inducedUrl) {
  const reasons = [];
  const byType = {};
  for (const row of rows) byType[row.event_type] = (byType[row.event_type] ?? 0) + 1;
  for (const type of ["monitor.first_check", "incident.down", "incident.recovered"]) {
    if (byType[type] !== 1) reasons.push(`expected exactly 1 ${type} row, found ${byType[type] ?? 0}`);
  }
  const down = rows.find((r) => r.event_type === "incident.down");
  const recovered = rows.find((r) => r.event_type === "incident.recovered");
  if (down && recovered) {
    if (!down.incident_id || down.incident_id !== recovered.incident_id) {
      reasons.push("down/recovered rows do not share one incident_id");
    }
  }
  for (const row of rows) {
    const payload = row.payload ?? {};
    const keys = Object.keys(payload).filter((k) => k !== "_relayFailure").sort();
    if (JSON.stringify(keys) !== JSON.stringify([...D48_PAYLOAD_KEYS].sort())) {
      reasons.push(`${row.event_type}: payload keys != the D-48 shape`);
      continue;
    }
    if (typeof payload.monitorName !== "string" || !payload.monitorName) {
      reasons.push(`${row.event_type}: monitorName not a non-empty string`);
    }
    if (payload.monitorUrl !== inducedUrl) {
      reasons.push(`${row.event_type}: monitorUrl is not the induced target URL`);
    }
    if (
      (payload.statusCode !== null && typeof payload.statusCode !== "number") ||
      (payload.responseTimeMs !== null && typeof payload.responseTimeMs !== "number")
    ) {
      reasons.push(`${row.event_type}: statusCode/responseTimeMs not number|null`);
    }
    if (
      payload.errorClass !== null &&
      !ERROR_CLASS_VOCABULARY.includes(payload.errorClass)
    ) {
      reasons.push(`${row.event_type}: errorClass outside the audit vocabulary`);
    }
    if (Number.isNaN(Date.parse(payload.occurredAt))) {
      reasons.push(`${row.event_type}: occurredAt not ISO`);
    }
    if (payload.userTimezone !== null && typeof payload.userTimezone !== "string") {
      reasons.push(`${row.event_type}: userTimezone not string|null`);
    }
    if (typeof payload.claimEpoch !== "number") {
      reasons.push(`${row.event_type}: claimEpoch not a number`);
    }
    // Exactly one relay attempt per event, FAILED under the dummy token.
    if (row.attempts !== 1) {
      reasons.push(`${row.event_type}: attempts=${row.attempts} (expected exactly 1 — permanent 401 fails fast, D-34)`);
    }
    if (payload._relayFailure === undefined) {
      reasons.push(`${row.event_type}: no _relayFailure marker (relay never dialed or never failed)`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

async function legInduce(state) {
  console.log("[induce] DOWN/RECOVERED parity pair via the manual-enqueue lever (D-11)...");
  const snapDir = state.snapDir;
  try {
    docker(["inspect", WORKER_CONTAINER], { stdio: "ignore" });
    docker(["inspect", TARGET_CONTAINER], { stdio: "ignore" });
  } catch {
    fail("induce needs the worker + target containers (unpause leg)", new Error("run --leg unpause first"));
  }

  await pgConnect();
  // Owner: an anonymized user WITH a chat id (anonymize preserves non-null as
  // a hashed id) — the relay must resolve a chat id and genuinely dial, else
  // the FAILED state is never exercised. No human is reachable by
  // construction (dummy token).
  const owner = (await pgQuery(`SELECT id FROM users WHERE "telegramChatId" IS NOT NULL ORDER BY "createdAt" LIMIT 1`)).rows[0];
  if (!owner) {
    fail(
      "no user with a telegramChatId in the restored snapshot",
      new Error("the parity leg needs a chat-bound owner; check the anonymized dump (anonymize-snapshot preserves non-null chat ids)")
    );
  }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const inducedUrl = `http://${TARGET_IP}:${TARGET_PORT}/probe`;
  // INSERT mirroring the /api/monitors create path's exact data shape (the
  // HTTP route needs a NextAuth session the anonymized stand-in cannot mint;
  // documented deviation). interval 1440 + fresh lastChecked/next_check_at
  // starve BOTH engines — the manual lever is the only check driver, so the
  // DOWN/RECOVERED pair is fully deterministic (Pitfall 2: cron must never
  // win the race and alert from stale memory without an outbox row).
  const monitorId = (
    await pgQuery(
      `INSERT INTO monitors (
         url, name, status, "isActive", interval,
         "userId", "createdAt", "updatedAt", "lastChecked",
         next_check_at, "totalChecks", "failedChecks"
       ) VALUES ($1, $2, 'PENDING', true, 1440, $3, now(), now(), now(), now() + (1440 * interval '1 minute'), 0, 0)
       RETURNING id`,
      [inducedUrl, `rehearsal-induced-parity-${day}`, owner.id]
    )
  ).rows[0].id;

  writeEnqueueDriver();

  // UP first: PENDING -> UP derives monitor.first_check (the IN-01 seed fix
  // is what makes this derivation possible at all).
  flipTarget("up");
  manualEnqueueOnce(monitorId);
  await waitForCheck(monitorId, "UP", "monitor.first_check");

  // DOWN: UP -> DOWN creates the incident + incident.down row (1-strike).
  flipTarget("down");
  manualEnqueueOnce(monitorId);
  await waitForCheck(monitorId, "DOWN", "incident.down");
  const incident = (
    await pgQuery(`SELECT id FROM incidents WHERE "monitorId" = $1 AND status = 'ONGOING' ORDER BY "startedAt" DESC LIMIT 1`, [monitorId])
  ).rows[0];
  if (!incident) {
    fail("no ONGOING incident after the DOWN flip", new Error("expected a 1-strike incident"));
  }

  // RECOVERED: DOWN -> UP resolves the incident + incident.recovered row.
  flipTarget("up");
  manualEnqueueOnce(monitorId);
  await waitForCheck(monitorId, "UP", "incident.recovered");

  // Wait for the relay pass (5 s cadence) to attempt + fail every row.
  await waitFor(async () => {
    const rows = (await pgQuery(`SELECT attempts, payload FROM outbox WHERE monitor_id = $1`, [monitorId])).rows;
    return rows.length >= 3 && rows.every((r) => r.attempts >= 1);
  }, 60_000, "relay attempts on all induced rows");

  const rows = (
    await pgQuery(
      `SELECT id, event_type, incident_id, attempts, payload FROM outbox WHERE monitor_id = $1 ORDER BY created_at`,
      [monitorId]
    )
  ).rows;
  const byteMatch = evaluateByteMatch(rows, inducedUrl);
  if (!byteMatch.ok) {
    fail(
      "induced parity byteMatch FAILED:\n  - " + byteMatch.reasons.join("\n  - "),
      new Error("D-48 payload-boundary proof (05-06 must-have)")
    );
  }
  writeFileSync(
    path.join(snapDir, "parity-evidence.json"),
    JSON.stringify(
      {
        induced: {
          monitorId,
          ownerUserId: owner.id,
          incidentId: incident.id,
          events: rows.map((r) => r.event_type),
          attemptsPerEvent: rows.map((r) => r.attempts),
          failedUnderDummyToken: rows.every((r) => r.payload?._relayFailure !== undefined),
        },
        byteMatch: true,
        extraTransientAlerts: [],
      },
      null,
      2
    ),
    "utf8"
  );
  saveState((s) => {
    s.induced = { monitorId, incidentId: incident.id };
    s.legs = { ...s.legs, induce: { status: "ok", monitorId, incidentId: incident.id, byteMatch: true } };
  });
  console.log(`  -> GREEN: monitor ${monitorId}, incident ${String(incident.id).slice(0, 8)}, 3 events, 1 attempt each, FAILED (dummy token)`);
}

// ---------------------------------------------------------------------------
// Leg: maintenance — WRK-13 manual dry-run; audit -> recompute-report.json
// ---------------------------------------------------------------------------

async function legMaintenance(state) {
  console.log("[maintenance] enqueue-maintenance dry-run via --wait (WRK-13)...");
  const snapDir = state.snapDir;
  if (!existsSync("scripts/enqueue-maintenance.mjs")) {
    fail("scripts/enqueue-maintenance.mjs not found", new Error("05-06 Task 2 deliverable"));
  }
  const res = runNodeCapture(
    "scripts/enqueue-maintenance.mjs",
    ["--wait", "300", "--redis", REDIS_URL],
    buildStandInEnv({ REDIS_URL })
  );
  if (res.status !== 0) {
    fail("enqueue-maintenance --wait failed", new Error(res.stderr || res.stdout));
  }
  // The script's final REPORT line carries the job's return value.
  const reportLine = res.stdout.split(/\r?\n/).filter((l) => l.startsWith("REPORT ")).pop();
  if (!reportLine) {
    fail("enqueue-maintenance printed no REPORT line", new Error(res.stdout.slice(-500)));
  }
  const report = JSON.parse(reportLine.slice("REPORT ".length));
  const audit = report.audit ?? { checked: null, discrepancies: [] };
  writeFileSync(
    path.join(snapDir, "recompute-report.json"),
    JSON.stringify({ checked: audit.checked ?? 0, discrepancies: audit.discrepancies ?? [] }, null, 2),
    "utf8"
  );
  saveState((s) => {
    s.legs = {
      ...s.legs,
      maintenance: {
        status: "ok",
        dryRun: report.dryRun,
        checked: audit.checked ?? 0,
        discrepancies: (audit.discrepancies ?? []).length,
      },
    };
  });
  console.log(
    `  -> GREEN: dry-run=${report.dryRun}, audit checked ${audit.checked ?? 0}, discrepancies ${(audit.discrepancies ?? []).length}`
  );
}

// ---------------------------------------------------------------------------
// Leg: gates — runbook §4a step 8 over the rehearsal snapshots (two passes)
// ---------------------------------------------------------------------------

/** Splits gate-cutover stdout into per-gate verdicts + reasons. */
function parseGateVerdicts(stdout) {
  const gates = [];
  let current = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const verdict = raw.match(/^GATE (\d+) \([^)]*\): (PASS|FAIL)/);
    if (verdict) {
      current = { n: Number(verdict[1]), pass: verdict[2] === "PASS", reasons: [] };
      gates.push(current);
      continue;
    }
    const reason = raw.match(/^\s+- (.+)$/);
    if (reason && current) current.reasons.push(reason[1]);
  }
  return gates;
}

async function legGates(state) {
  console.log("[gates] gate-cutover two-pass evaluation over the rehearsal snapshots...");
  const snapDir = state.snapDir;
  if (!state.windowStart || !state.windowEnd) {
    fail("gates needs the corun window", new Error("run --leg corun first"));
  }
  for (const input of ["parity-evidence.json", "recompute-report.json", "legacy-observations.json", "counters-baseline.json"]) {
    if (!existsSync(path.join(snapDir, input))) {
      fail(`snapshot input ${input} missing from ${snapDir}`, new Error("run the producing leg first"));
    }
  }
  const gateEnv = buildStandInEnv({ DATABASE_URL: PG_URL });
  delete gateEnv.HC_READ_ONLY_API_KEY; // the synthetic cache is the intended source

  // Synthetic flips fixture: the rehearsal provisions NO real hc.io check
  // (provisioning the real checks is runbook §4a step 5's live leg, 05-08).
  // One up-flip spanning the window start, zero down-flips — labeled.
  const extendedEnd = nowEpochSeconds();
  const extendedStart = extendedEnd - (MIN_WINDOW_SECONDS + EXTENDED_PAD_SECONDS);
  writeFileSync(
    path.join(snapDir, "flips-heartbeat.json"),
    JSON.stringify(
      {
        synthetic: true,
        note: "rehearsal fixture — no real healthchecks.io check exists for the stand-in; the live flips record belongs to the 05-08 window (D-17)",
        flips: [{ timestamp: new Date(extendedStart * 1000 - 60_000).toISOString(), up: 1 }],
      },
      null,
      2
    ),
    "utf8"
  );

  // Rehearsal dispositions for any cron-originated observations (D-05 form
  // letter — live-window entries get HUMAN dispositions, never these).
  const observations = JSON.parse(readFileSync(path.join(snapDir, "legacy-observations.json"), "utf8"));
  writeFileSync(
    path.join(snapDir, "disposition.md"),
    [
      "# Rehearsal dispositions (gate 7)",
      "",
      ...observations.map(
        (o) => `${o.id}: rehearsal disposition — cron-originated direct-send expected during the overlap (D-05); the live window requires a human disposition`
      ),
      "",
    ].join("\n"),
    "utf8"
  );

  // Pass A — TRUE rehearsal bounds: the sub-4h D-16 refusal is EXPECTED (the
  // clock rule is part of what is being rehearsed). Evidence goes into the
  // snapshot dir — NEVER the default deploy record (that is 05-08's).
  const passA = runNodeCapture(
    "scripts/gate-cutover.mjs",
    ["--start", String(state.windowStart), "--end", String(state.windowEnd),
     "--snapshots", snapDir, "--record", path.join(snapDir, "gate-passA.md"), "--db", PG_URL],
    gateEnv
  );
  writeFileSync(
    path.join(snapDir, "gate-passA.txt"),
    `exit=${passA.status}\n${passA.stdout}\n${passA.stderr}`,
    "utf8"
  );
  if (passA.status !== 1 || !/shorter than/.test(passA.stdout) || !/D-16/.test(passA.stdout)) {
    fail(
      "gate pass A (true bounds) did NOT produce the expected D-16 refusal",
      new Error(`exit=${passA.status}; stdout tail: ${passA.stdout.slice(-300)}`)
    );
  }

  // Pass B — extended bounds (>= 4 h) so all seven gates actually evaluate,
  // ONLINE against the throwaway DB (the parameterized queries the offline
  // fixtures stand in for; the offline contract is pinned by 05-05's suite).
  const passB = runNodeCapture(
    "scripts/gate-cutover.mjs",
    ["--start", String(extendedStart), "--end", String(extendedEnd),
     "--snapshots", snapDir, "--record", path.join(snapDir, "gate-evidence.md"), "--db", PG_URL],
    gateEnv
  );
  writeFileSync(
    path.join(snapDir, "gate-passB.txt"),
    `exit=${passB.status}\n${passB.stdout}\n${passB.stderr}`,
    "utf8"
  );
  const verdicts = parseGateVerdicts(passB.stdout);
  if (verdicts.length !== 7) {
    fail(
      `gate pass B produced ${verdicts.length}/7 gate verdict lines`,
      new Error(passB.stdout.slice(-500))
    );
  }
  // Machinery acceptance: gates 1-4, 6, 7 must PASS. Gate 5 (continuity) may
  // honestly report sparse monitors unmeasurable in an abbreviated window
  // (a monitor whose interval exceeds the window cannot produce a gap) —
  // every reason must be that class; any over-bound gap is a REAL finding.
  const sparseClass = /continuity unmeasurable/;
  const gate5 = verdicts.find((g) => g.n === 5);
  const gate5Allowed = gate5.pass || gate5.reasons.every((r) => sparseClass.test(r));
  for (const gate of verdicts) {
    if (gate.n === 5) continue;
    if (!gate.pass) {
      fail(
        `gate ${gate.n} FAILED in pass B:\n  - ${gate.reasons.join("\n  - ")}`,
        new Error("rehearsal gate acceptance — fix before the live window")
      );
    }
  }
  if (!gate5Allowed) {
    fail(
      `gate 5 FAILED with over-bound gaps:\n  - ${gate5.reasons.join("\n  - ")}`,
      new Error("real continuity finding — fix before the live window")
    );
  }
  const passedCount = verdicts.filter((g) => g.pass).length;
  saveState((s) => {
    s.legs = {
      ...s.legs,
      gates: {
        status: "ok",
        passA: "D-16 refusal produced as expected (sub-4h true window)",
        passB: `${passedCount}/7 PASS${gate5.pass ? "" : " (gate 5: sparse-monitor unmeasurable class, allowed)"}`,
        extendedWindow: [extendedStart, extendedEnd],
      },
    };
  });
  console.log(`  -> GREEN: pass A refused (D-16, as designed); pass B ${passedCount}/7 PASS`);
}

// ---------------------------------------------------------------------------
// Leg: drill — runbook §4a step 6 abort drill (D-06/D-15 mechanics)
// ---------------------------------------------------------------------------

async function legDrill() {
  console.log("[drill] abort drill: re-pause -> cron auto-resume -> re-unpause (D-06)...");
  const nodeImage = `node:${process.versions.node.split(".")[0]}-alpine`;
  if (!existsSync(path.join(CONTAINER_BUNDLE_DIR, "worker.js"))) {
    fail("drill needs the worker bundle on disk", new Error("run --leg unpause first"));
  }
  if (!webChild && !webChildExited) spawnWebChild();
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/cron/check`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.status === 401;
    } catch {
      return false;
    }
  }, 90_000, "web up (drill)");

  await pgConnect();
  const pingsBefore = Number((await pgQuery(`SELECT count(*)::int AS n FROM pings`)).rows[0].n);

  // Re-pause: the flag is boot-read, so the container recreate IS the
  // restart (runbook §4a step 6 form; never queue.pause()).
  await recreateWorkerContainer(nodeImage, false);
  const pausedLogs = docker(["logs", WORKER_CONTAINER]);
  if (!pausedLogs.includes("scheduler flag OFF") || pausedLogs.includes("recurring scheduling ACTIVE")) {
    fail(
      "paused worker boot log does not show the D-16 pause posture",
      new Error("expected 'scheduler flag OFF' and no ACTIVE marker")
    );
  }

  // Cron auto-resume via the due-filter, proven with the §9 curl lever:
  // GET /api/cron/check (Bearer) runs due checks AND flushes in-request —
  // the restored monitors' stale lastChecked values make them due now.
  const lever = await fetch(`http://127.0.0.1:${WEB_PORT}/api/cron/check`, {
    headers: { Authorization: `Bearer ${THROWAWAY_CRON_SECRET}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!lever.ok) {
    fail(`cron lever returned HTTP ${lever.status}`, new Error("the §9 emergency path must work during the pause"));
  }
  const pingsAfterLever = Number((await pgQuery(`SELECT count(*)::int AS n FROM pings`)).rows[0].n);
  if (pingsAfterLever <= pingsBefore) {
    fail(
      "cron did NOT auto-resume during the worker pause (due-filter zero-gap broken)",
      new Error(`pings ${pingsBefore} -> ${pingsAfterLever} after the lever`)
    );
  }

  // Observation: one natural internal-cron pass (1-min cadence) within 90 s.
  let naturalPassSeen = false;
  const naturalDeadline = Date.now() + 90_000;
  while (Date.now() < naturalDeadline && !naturalPassSeen) {
    await sleep(10_000);
    const n = Number((await pgQuery(`SELECT count(*)::int AS n FROM pings`)).rows[0].n);
    naturalPassSeen = n > pingsAfterLever;
  }

  // Re-unpause into a FRESH window (D-16: the clock restarts; only the final
  // continuous >= 4 h stretch counts — the real fresh window is 05-08's).
  await recreateWorkerContainer(nodeImage, true);
  const activeLogs = docker(["logs", WORKER_CONTAINER]);
  if (!activeLogs.includes("recurring scheduling ACTIVE")) {
    fail("re-unpaused worker did not print 'recurring scheduling ACTIVE'", new Error("step 6 verification"));
  }
  saveState((s) => {
    s.drillDone = true;
    s.legs = {
      ...s.legs,
      drill: {
        status: "ok",
        pauseMarker: true,
        pingsBefore,
        pingsAfterLever,
        naturalPassSeen,
        freshWindowFrom: new Date().toISOString(),
      },
    };
  });
  console.log(
    `  -> GREEN: paused marker seen; cron lever pings ${pingsBefore} -> ${pingsAfterLever}; natural pass ${naturalPassSeen ? "seen" : "not due in 90 s (observation)"}; re-unpaused ACTIVE`
  );
}

// ---------------------------------------------------------------------------
// Leg: teardown — processes, containers, network, work artifacts, evidence
// ---------------------------------------------------------------------------

function killWebChild() {
  if (webChild && !webChildExited) {
    try {
      webChild.kill("SIGKILL"); // win32 cannot deliver SIGINT to a child (Pitfall 8)
    } catch {
      /* already gone */
    }
  }
}

async function stopWebAndFreePort() {
  killWebChild();
  await waitFor(async () => await probePortFree(WEB_PORT), 10_000, `web port ${WEB_PORT} free`).catch(
    () => {
      if (process.platform === "win32" && webChild && !webChildExited) {
        try {
          execSync(`taskkill /PID ${webChild.pid} /T /F`, { stdio: "ignore" });
        } catch {
          /* best effort — surfaced by the port probe on the next run */
        }
      }
    }
  );
}

/** Composes the evidence file — the layout 05-07 transcribes into
 *  05-REHEARSAL-EVIDENCE.md. Counts/verdicts/ids only (T-05-06-03). */
function writeEvidenceFile(state, verdict) {
  if (!state.snapDir) return null;
  const legs = state.legs ?? {};
  const lines = [];
  lines.push(`# Cutover rehearsal evidence — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Generated by scripts/rehearse-cutover.mjs (D-30/D-33). Counts, verdicts, and ids only — no secrets, no payload contents, no connection strings (T-05-06-03). This is the layout 05-07 transcribes into 05-REHEARSAL-EVIDENCE.md."
  );
  lines.push("");
  lines.push(`- **Build provenance (D-31):** SHA ${state.buildSha ?? "?"}, dist sha256 ${state.distSha256 ?? "?"}, .next BUILD_ID ${state.nextBuildId ?? "?"}, drizzle journal ${state.journalEntries ?? "?"} (zero new, D-44)`);
  lines.push(`- **Stand-in:** ${PG_IMAGE} 127.0.0.1:${PG_PORT} + ${REDIS_IMAGE} 127.0.0.1:${REDIS_PORT} (loopback publishes only), worker + target containers on \`${NETWORK}\` (${NETWORK_SUBNET}, TEST-NET-3), torn down after the run`);
  lines.push(`- **Restored snapshot counts:** ${JSON.stringify(state.restore?.tableCounts ?? {})}; monitor checksum ${state.restore?.monitorChecksum ?? "?"}; migration rows ${state.restore?.migrationRows ?? "?"}`);
  lines.push(`- **Egress sweep (D-30):** ${legs.sweep?.status === "ok" ? "GREEN — zero real channels (dummy token, empty pins, telemetry off)" : "not recorded"}`);
  lines.push(`- **D-49 reseed:** ${legs.reseed ? `applied ${legs.reseed.applied} == active count; block sha256 ${legs.reseed.sqlSha} (runbook string-compare PASS)` : "not run"}`);
  lines.push(`- **Unpause (§4a step 5):** ${legs.unpause ? `ACTIVE marker seen, worker readyz in ${legs.unpause.readyMs} ms; ${legs.unpause.note}` : "not run"}`);
  lines.push(`- **Co-run window:** ${legs.corun ? `${legs.corun.minutes} min, ${legs.corun.sampleCount} samples, ${legs.corun.pingsCreated} pings created, ${legs.corun.cronOriginatedIncidents} cron-originated incident(s)` : "not run"}`);
  lines.push(`- **Induced parity (D-11/D-48/D-34):** ${legs.induce ? `monitor ${legs.induce.monitorId}, incident ${String(legs.induce.incidentId).slice(0, 8)}, 3 events (first_check/down/recovered), one relay attempt each, FAILED under the dummy token, byteMatch PASS` : "not run"}`);
  lines.push(`- **Maintenance dry-run (WRK-13):** ${legs.maintenance ? `audit checked ${legs.maintenance.checked}, discrepancies ${legs.maintenance.discrepancies}` : "not run"}`);
  lines.push(`- **Gates (§4a step 8):** ${legs.gates ? `pass A: ${legs.gates.passA}; pass B: ${legs.gates.passB}` : "not run"}`);
  lines.push(`- **Abort drill (§4a step 6):** ${legs.drill ? `pause marker seen, cron lever pings ${legs.drill.pingsBefore} -> ${legs.drill.pingsAfterLever}, natural pass ${legs.drill.naturalPassSeen ? "seen" : "not due in 90 s"}, re-unpause ACTIVE, fresh window from ${legs.drill.freshWindowFrom} (D-16)` : "not run"}`);
  lines.push(`- **Verdict:** ${verdict}`);
  lines.push("");
  lines.push("## Deviations encoded in the script (documented in 05-06-SUMMARY.md)");
  lines.push("");
  lines.push("- Induced-parity target form: TEST-NET-3 sibling containers (the SSRF denylist blocks every loopback/private target; a loopback target is DOWN-only — ssrf_blocked — and can never produce the UP leg). 05-CONTEXT D-11 leaves the target form to execution.");
  lines.push("- The create path is mirrored as an INSERT with the /api/monitors route's exact data shape (the HTTP route requires a NextAuth session the anonymized stand-in cannot mint).");
  lines.push("- Gates run ONLINE against the throwaway DB with extended bounds (pass A proves the D-16 refusal on the true window; the offline-fixture contract is pinned by 05-05's test suite).");
  lines.push("");
  const evidencePath = path.join(state.snapDir, "evidence.md");
  writeFileSync(evidencePath, lines.join("\n") + "\n", "utf8");
  return evidencePath;
}

async function legTeardown(state, verdictOverride) {
  console.log("[teardown] stopping processes, removing the stand-in, writing evidence...");
  const verdict =
    verdictOverride ??
    (Object.values(state.legs ?? {}).every((l) => l?.status === "ok") &&
     ["rebuild", "restore", "sweep", "reseed", "unpause", "corun", "induce", "maintenance", "gates", "drill"].every(
       (name) => state.legs?.[name]?.status === "ok"
     )
      ? "PASS"
      : "PARTIAL (see per-leg lines)");
  const evidencePath = writeEvidenceFile(state, verdict);

  await stopWebAndFreePort();
  for (const name of ALL_CONTAINERS) {
    try {
      docker(["inspect", name], { stdio: "ignore" });
    } catch {
      continue; // never created this run
    }
    try {
      docker(["rm", "-f", name], { stdio: "ignore" });
      console.log(`  removed container ${name}`);
    } catch {
      console.error(`TEARDOWN WARNING: could not remove ${name} — run: docker rm -f ${name}`);
    }
  }
  try {
    docker(["network", "rm", NETWORK], { stdio: "ignore" });
    console.log(`  removed network ${NETWORK}`);
  } catch {
    /* absent or in use — the container removals above drain it */
  }
  try {
    if (pg) await pg.end();
  } catch {
    /* already ended */
  }
  try {
    rmSync(WORK_DIR, { recursive: true, force: true });
    rmSync(STATE_FILE, { force: true });
    console.log(`  removed work artifacts + state (snapshot dir kept: ${state.snapDir})`);
  } catch {
    console.error(`TEARDOWN WARNING: could not remove ${WORK_DIR} — remove manually`);
  }
  if (evidencePath) console.log(`  evidence: ${evidencePath}`);
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { leg: null, minutes: 45, dump: null, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "--self-test") {
      args.flags.add(arg.slice(2));
      continue;
    }
    if (arg === "--leg") {
      args.leg = argv[++i];
      continue;
    }
    if (arg === "--minutes") {
      args.minutes = Number(argv[++i]);
      continue;
    }
    if (arg === "--dump") {
      args.dump = argv[++i];
      continue;
    }
    fail(`unexpected argument "${arg}"\n\n${usage()}`, new Error("usage"));
  }
  return args;
}

async function runLeg(name, args) {
  switch (name) {
    case "rebuild":
      await legRebuild();
      break;
    case "restore":
      await legRestore(args.dump);
      break;
    case "sweep":
      legSweep();
      break;
    case "reseed":
      await legReseed();
      break;
    case "unpause":
      await legUnpause(loadState());
      break;
    case "corun":
      await legCorun(loadState(), args.minutes);
      break;
    case "induce":
      await legInduce(loadState());
      break;
    case "maintenance":
      await legMaintenance(loadState());
      break;
    case "gates":
      await legGates(loadState());
      break;
    case "drill":
      await legDrill();
      break;
    case "teardown":
      await legTeardown(loadState(), null);
      break;
    default:
      fail(`unknown leg "${name}"\n\n${usage()}`, new Error("usage"));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help")) {
    console.log(usage());
    return;
  }
  if (args.flags.has("self-test")) {
    selfTest();
    return;
  }
  if (!args.leg) {
    fail(`--leg is required\n\n${usage()}`, new Error("usage"));
  }
  if (args.leg === "all") {
    const sequence = [
      "rebuild",
      "restore",
      "sweep",
      "reseed",
      "unpause",
      "corun",
      "induce",
      "maintenance",
      "gates",
      "drill",
    ];
    runSweepGuard(); // before ANY leg runs (prohibition 1)
    let outcome = "PASS";
    try {
      for (const leg of sequence) {
        runSweepGuard(); // re-assert before every leg
        await runLeg(leg, args);
      }
      const finalState = loadState();
      await legTeardown(finalState, "PASS");
      console.log(`\nREHEARSAL PASSED — evidence under ${finalState.snapDir ?? "(see above)"}`);
      return;
    } catch (error) {
      outcome = "FAILED";
      // SOFT teardown only: stop the host web child (it holds a port), leave
      // the containers for post-mortem + leg re-entry; `--leg teardown` does
      // the full cleanup once diagnosis is done.
      killWebChild();
      try {
        if (pg) await pg.end();
      } catch {
        /* already ended */
      }
      console.error(`\nREHEARSAL ${outcome}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`Stand-in containers left for diagnosis — clean up with: node scripts/${SCRIPT_NAME} --leg teardown`);
      process.exitCode = 1;
      return;
    }
  }
  if (!LEGS.includes(args.leg)) {
    fail(`unknown leg "${args.leg}"\n\n${usage()}`, new Error("usage"));
  }
  runSweepGuard(); // before any single leg too (prohibition 1)
  await runLeg(args.leg, args);
}

try {
  await main();
  if (process.exitCode === undefined) process.exitCode = 0;
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (!webChildExited) killWebChild(); // never leak the web child on any exit path
}
