#!/usr/bin/env node
// rehearse-worker.mjs — the deploy-day rehearsal (D-32, plan 04-09 Task 1).
//
//   pnpm rehearse:worker
//
// Replays the FULL §4/§4a deploy sequence against a THROWAWAY stand-in stack
// this script owns end-to-end (own docker network, own loopback-bound
// ports), including both outage injections and the graceful-shutdown signal
// leg — so the dark launch (Task 3) and the first VPS deploy are second
// performances, not first attempts.
//
// Pipeline (every step fail-loud; teardown in finally; no secrets echoed —
// the throwaway URLs below are constructed throwaway credentials, the same
// posture as scripts/rehearse-migrations.mjs):
//   0.  pre-flight: container-name collisions (3), docker-port holds
//       (5460/6460), TCP probes (5460/6460/9460), journal presence, and a
//       hard source assertion that NOTHING in this script targets the
//       sibling stacks (5454 production stand-in DB, 6391 hardened Redis,
//       5453/6390 vitest stack — T-04-34)
//   1.  build (D-06): one `pnpm build` produces BOTH .next and dist/worker.js
//       from one SHA; the SHA is recorded
//   2.  zero-new-migrations assertion (phase goal, WR-05 lesson): journal
//       entries == on-disk drizzle/*.sql == git-tracked count, and the
//       working tree is clean of drizzle/ changes — DERIVED from the
//       journal, never a hard-coded count
//   3.  throwaway stand-in: dedicated docker network + postgres:17-alpine on
//       127.0.0.1:5460 + redis:8-alpine on 127.0.0.1:6460 (loopback-only
//       publishes — WR-02; plain redis: the hardened-redis posture was
//       proven live by 03-08, this leg rehearses the WORKER)
//   4.  migrate (D-32 leg 1): `drizzle-kit migrate` on the fresh DB applies
//       the committed set; journal rows == entries; a SECOND run is a no-op
//       (journal rows unchanged) — the deploy-day "zero pending" assert
//   5.  backup (D-9 posture): pg_dump -F c into .snapshots/ + restore-list
//       readability sanity
//   6.  seed synthetic monitor (D-19): scripts/seed-synthetic.sql via
//       docker exec psql (ON_ERROR_STOP), then row assert
//   7.  worker start (host leg): node dist/worker.js against the throwaway
//       stack, WORKER_SCHEDULER_ENABLED=true (the rehearsal MAY exercise
//       ticks — the scheduler machinery boots; the dark-launch flag-off
//       posture runs in the container leg below), health on 127.0.0.1:9460
//   8.  readyz wait (WRK-08) + provenance assert (D-10): /healthz sha ==
//       the build SHA recorded in step 1
//   9.  smoke #1 (D-18): pnpm smoke:enqueue — priority-1 manual check, NEW
//       Tier-1 evidence ping row
//  10.  Postgres-stop injection (RES-01): docker stop pg -> /readyz 503 with
//       db:false, process SURVIVES; docker start -> readyz 200 -> breaker
//       CLOSED (via /metrics.json) -> smoke #2
//  11.  Redis-stop injection (RES-05, pause-by-design): no enqueue attempted
//       (retry-forever clients would hang it — D-33 observation); asserts
//       instead: process alive, Postgres intact, ZERO new ping rows during
//       the outage window; docker start -> readyz 200 -> smoke #3
//  12.  SIGINT-drain container leg (Windows Pitfall 8): SIGINT is not
//       programmatically deliverable to a child on win32, so the signal leg
//       runs in a throwaway Linux container — a SELF-CONTAINED bundle (tsup
//       with deps inlined; the pnpm junction node_modules cannot bind-mount
//       into Linux) is built to .snapshots/rehearsal-container-bundle,
//       docker create+cp+start on the rehearsal network with
//       WORKER_SCHEDULER_ENABLED=false (the D-16 dark-launch posture),
//       readiness via docker exec fetch, smoke #4 processed by the CONTAINER
//       worker, then `docker kill --signal=SIGINT` -> exit code 0 ->
//       `worker booted` + `worker shutting down` in docker logs (WRK-07)
//  13.  evidence: .snapshots/rehearse-worker-YYYYMMDD.md (+ .json) and a
//       committable copy at
//       .planning/phases/04-monitoring-worker-build-dark-launch/04-REHEARSAL-EVIDENCE-YYYYMMDD.md
//       (observations only — zero PII/secrets, T-04-35)
//  14.  teardown (finally): host worker SIGKILL (Pitfall 8 — documented),
//       three containers + network removed, temp bundle artifacts removed —
//       on success AND failure
//
// Runtime contract: plain Node ESM + pg + docker CLI (zero new deps). Run
// from the repo root.

import { execSync, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Constants — the throwaway stand-in. Own ports, own names, loopback binds.
// ---------------------------------------------------------------------------

const PG_PORT = 5460; // 03-03/03-05 precedent (free), NOT the 5453 test stack
const REDIS_PORT = 6460; // fresh — never collides with 6390 (test) or 6391 (prod stand-in)
const HEALTH_PORT = 9460; // host-leg worker health (default would be 9090)
const PG_CONTAINER = "spidernode-rehearse-pg";
const REDIS_CONTAINER = "spidernode-rehearse-redis";
const WORKER_CONTAINER = "spidernode-rehearse-worker";
const NETWORK = "spidernode-rehearse-net";
const PG_IMAGE = "postgres:17-alpine"; // source major recorded in 03-03 (17.7)
const REDIS_IMAGE = "redis:8-alpine"; // test-stack image precedent (stock)
const DB = "uptime_rehearse";

// Throwaway credentials, constructed here (rehearse-migrations posture).
// Loopback-published + torn down in finally — and step 0 asserts these are
// the ONLY stacks this script ever talks to (T-04-34).
const PG_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${DB}`;
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;

// Container-internal URLs (docker-network DNS) for the container leg.
const PG_URL_INNER = `postgres://postgres:postgres@${PG_CONTAINER}:5432/${DB}`;
const REDIS_URL_INNER = `redis://${REDIS_CONTAINER}:6379`;

// Sibling stacks that must NEVER appear in anything this script dials.
const FORBIDDEN_PORT_TOKENS = [":5454", ":6391", ":5453", ":6390", ":5433", ":6380"];

const SNAPSHOTS_DIR = ".snapshots";
const CONTAINER_BUNDLE_DIR = path.join(SNAPSHOTS_DIR, "rehearsal-container-bundle");
const TEMP_TSUP_CONFIG = path.join(SNAPSHOTS_DIR, "rehearsal-tsup.config.ts");
const PHASE_EVIDENCE_DIR = ".planning/phases/04-monitoring-worker-build-dark-launch";

const WORKER_BUNDLE = path.join("dist", "worker.js");
const SEED_FILE = "scripts/seed-synthetic.sql";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(context, error) {
  throw new Error(
    `rehearse-worker failed: ${context}. ` +
      `Cause: ${error instanceof Error ? error.message : String(error)}.`
  );
}

/** Shell run (pnpm / git plumbing that is cmd.exe-safe). */
function run(command, options = {}) {
  return execSync(command, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/** Argv docker invocation — NO shell, so nested quoting never breaks. */
function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Synchronous sleep (retry seams inside sync helpers) — Atomics.wait. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function probePortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function fetchJson(port, route, timeoutMs = 3000) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Parse the body for ANY status — /readyz 503 carries {db:{ok:false}} that
  // the PG-outage assert reads; degrade to null when the body is not JSON.
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Normalizes a Windows path to forward slashes (docker cp / tsup --config args). */
function toPosix(p) {
  return p.split(path.sep).join("/");
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
  fail(`waitFor(${label}) timed out after ${timeoutMs} ms (last: ${last})`, new Error("T-04-31 fail-loud timeouts"));
}

// --- rehearsal-owned pg client (reconnects after the PG-stop injection) ----
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

// --- host-leg worker child (spawnWorker pattern from 04-08) ---------------

let child = null;
let childExited = false;
const outputChunks = [];
let outputBuffered = 0;

function spawnHostWorker() {
  child = spawn(process.execPath, [WORKER_BUNDLE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Explicit throwaway-stack pins — dotenv in the child cannot override.
      DATABASE_URL: PG_URL,
      REDIS_URL: REDIS_URL,
      WORKER_HEALTH_PORT: String(HEALTH_PORT),
      WORKER_SCHEDULER_ENABLED: "true", // rehearsal MAY exercise ticks (container leg runs flag-off)
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    const text = chunk.toString("utf8");
    outputBuffered += text.length;
    outputChunks.push(text);
    while (outputBuffered > 2_000_000 && outputChunks.length > 1) {
      outputBuffered -= outputChunks[0].length;
      outputChunks.shift();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", () => {
    childExited = true;
  });
}
function childOutputTail(bytes = 4000) {
  return outputChunks.join("").slice(-bytes);
}
function assertWorkerAlive(stepLabel) {
  if (childExited) {
    fail(
      `${stepLabel}: host worker process EXITED during the injection (fail-stay-up violated, RES-01/RES-05)`,
      new Error(`output tail:\n${childOutputTail()}`)
    );
  }
}

/** One smoke run (D-18) as its own process — exit code is the verdict. */
function runSmoke(label) {
  console.log(`    -> smoke ${label}: pnpm smoke:enqueue against the throwaway stack...`);
  try {
    run("pnpm exec tsx scripts/enqueue-smoke.mjs", {
      env: {
        ...process.env,
        DATABASE_URL: PG_URL,
        REDIS_URL: REDIS_URL,
        SMOKE_TIMEOUT_MS: process.env.SMOKE_TIMEOUT_MS ?? "90000",
      },
      stdio: "inherit",
    });
  } catch (error) {
    fail(`smoke ${label} did not pass`, error);
  }
}

async function pingCount() {
  const res = await pgQuery(
    `SELECT count(*)::int AS n FROM pings WHERE "monitorId" IN (SELECT id FROM monitors WHERE "userId" = 'spidernode-ops-smoke')`
  );
  return res.rows[0].n;
}

// ---------------------------------------------------------------------------
// Step 0: pre-flight
// ---------------------------------------------------------------------------

function checkNamesFree() {
  let names = [];
  try {
    names = docker(["ps", "-a", "--format", "{{.Names}}"]).split(/\r?\n/);
  } catch (error) {
    fail("could not list docker containers (is Docker Desktop running?)", error);
  }
  for (const name of [PG_CONTAINER, REDIS_CONTAINER, WORKER_CONTAINER]) {
    if (names.includes(name)) {
      fail(
        `container name ${name} already exists (orphaned previous run)`,
        new Error(`remove it first: docker rm -f ${name}`)
      );
    }
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

function assertSiblingStackIsolation() {
  const dialed = [PG_URL, REDIS_URL, PG_URL_INNER, REDIS_URL_INNER];
  for (const url of dialed) {
    for (const token of FORBIDDEN_PORT_TOKENS) {
      if (url.includes(token)) {
        fail(
          `isolation guard tripped: ${url} targets a sibling stack`,
          new Error("T-04-34: the rehearsal must NEVER dial 5454/6391 (production stand-ins) or 5453/6390 (vitest stack)")
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: zero-new-migrations (dynamic — WR-05 lesson: derive, never pin)
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
      "zero-new-migrations assertion FAILED",
      new Error(
        `journal entries=${entries}, drizzle/*.sql on disk=${onDisk}, git-tracked=${tracked} — every migration must be committed before a deploy rehearsal`
      )
    );
  }
  const dirty = run("git status --porcelain -- drizzle")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (dirty.length > 0) {
    fail(
      "zero-new-migrations assertion FAILED",
      new Error(`uncommitted drizzle/ changes: ${dirty.join("; ")} — commit or stash them first`)
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Step 12: the self-contained container bundle (temp tsup config)
// ---------------------------------------------------------------------------

function buildContainerBundle(buildSha) {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  rmSync(CONTAINER_BUNDLE_DIR, { recursive: true, force: true });
  const buildTs = new Date().toISOString();
  // skipNodeModulesBundle:false + noExternal:[/.*/] — deps REALLY inlined:
  // tsup v8 externalizes package.json dependencies by default (the first run
  // of this rehearsal shipped a 102 KB bundle of raw require()s and the
  // container worker died on missing modules), so the wildcard noExternal is
  // what actually forces the single-file bundle. The repo's pnpm node_modules
  // (Windows junctions) cannot bind-mount into a Linux container. pg-native
  // stays external: pg's lazy native getter is never loaded at runtime, and
  // the package is not installed at all.
  writeFileSync(
    TEMP_TSUP_CONFIG,
    `// TEMPORARY rehearsal artifact (scripts/rehearse-worker.mjs step 12) — removed in teardown.\n` +
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
    fail("container-leg tsup bundle build failed", error);
  }
  if (!existsSync(path.join(CONTAINER_BUNDLE_DIR, "worker.js"))) {
    fail("container-leg bundle missing", new Error(`${CONTAINER_BUNDLE_DIR}/worker.js not produced`));
  }
}

// ---------------------------------------------------------------------------
// Step 13: evidence
// ---------------------------------------------------------------------------

function writeEvidence(evidence) {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  mkdirSync(PHASE_EVIDENCE_DIR, { recursive: true });
  const md = renderEvidenceMarkdown(evidence);
  writeFileSync(`${SNAPSHOTS_DIR}/rehearse-worker-${evidence.day}.md`, md, "utf8");
  writeFileSync(`${SNAPSHOTS_DIR}/rehearse-worker-${evidence.day}.json`, JSON.stringify(evidence, null, 2), "utf8");
  copyFileSync(`${SNAPSHOTS_DIR}/rehearse-worker-${evidence.day}.md`, `${PHASE_EVIDENCE_DIR}/04-REHEARSAL-EVIDENCE-${evidence.day}.md`);
  console.log(`evidence written: ${SNAPSHOTS_DIR}/rehearse-worker-${evidence.day}.md (+ .json)`);
  console.log(`committable copy:  ${PHASE_EVIDENCE_DIR}/04-REHEARSAL-EVIDENCE-${evidence.day}.md`);
}

function renderEvidenceMarkdown(e) {
  const lines = [];
  lines.push(`# Worker deploy rehearsal evidence — ${e.day}`);
  lines.push("");
  lines.push(`Generated by \`pnpm rehearse:worker\` (scripts/rehearse-worker.mjs, D-32). Observations only — zero PII/secrets by construction (T-04-35).`);
  lines.push("");
  lines.push(`- **Build SHA (D-06/D-10):** ${e.buildSha} — one \`pnpm build\` produced .next + dist/worker.js; /healthz provenance matched`);
  lines.push(`- **Zero-new-migrations (dynamic, WR-05):** journal=${e.migrations.journalEntries}, on-disk=${e.migrations.onDiskSql}, git-tracked=${e.migrations.trackedSql}, working tree clean`);
  lines.push(`- **Throwaway stack:** ${PG_IMAGE} \`${PG_CONTAINER}\` 127.0.0.1:${PG_PORT}, ${REDIS_IMAGE} \`${REDIS_CONTAINER}\` 127.0.0.1:${REDIS_PORT}, network \`${NETWORK}\` — loopback-only publishes (WR-02), torn down after the run; sibling stacks (5454/6391/5453/6390) never dialed (T-04-34)`);
  lines.push(`- **Verdict:** ${e.verdict}`);
  lines.push("");
  lines.push(`## Steps`);
  lines.push("");
  lines.push(`| # | Step | Result | Observation |`);
  lines.push(`|---|---|---|---|`);
  for (const step of e.steps) {
    lines.push(`| ${step.n} | ${step.name} | ${step.ok ? "GREEN" : "**RED**"} | ${step.note} |`);
  }
  lines.push("");
  lines.push(`## Outage injections + signal leg (timings, D-33 dataset adjacent)`);
  lines.push("");
  for (const [key, value] of Object.entries(e.timings)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");
  lines.push(`## Notes`);
  lines.push("");
  lines.push(...e.notes.map((n) => `- ${n}`));
  if (e.failures.length > 0) {
    lines.push("");
    lines.push(`## Failures`);
    lines.push("");
    lines.push(...e.failures.map((f) => `- ${f}`));
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

let pgStarted = false;
let redisStarted = false;
let networkCreated = false;
let workerContainerCreated = false;
const steps = [];
const timings = {};
const notes = [];
const failures = [];

function recordStep(n, name, ok, note) {
  steps.push({ n, name, ok, note });
  console.log(`    -> ${ok ? "GREEN" : "RED"}: ${note}`);
  if (!ok) failures.push(`${name}: ${note}`);
}

async function main() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // --- Step 0: pre-flight ---------------------------------------------------
  console.log(`[0] pre-flight: names, ports, journal, sibling-stack isolation...`);
  checkNamesFree();
  checkDockerPortsFree();
  for (const port of [PG_PORT, REDIS_PORT, HEALTH_PORT]) {
    if (!(await probePortFree(port))) {
      fail(`rehearsal port ${port} is held by a non-docker listener`, new Error("free the port or adjust the constants in scripts/rehearse-worker.mjs"));
    }
  }
  assertSiblingStackIsolation();
  if (!existsSync(WORKER_BUNDLE)) {
    // build runs below anyway; this just documents the current artifact state
    console.log(`    (no existing ${WORKER_BUNDLE} — step 1 build creates it)`);
  }
  recordStep(0, "pre-flight", true, "names free, ports 5460/6460/9460 free, isolation guard green (no sibling-stack URLs)");

  // --- Step 1: build ---------------------------------------------------------
  console.log(`[1] pnpm build (one SHA -> .next + dist/worker.js, D-06)...`);
  const buildStart = Date.now();
  try {
    run("pnpm build", {
      env: {
        ...process.env,
        // env-less-checkout precedent (02-07): the Next build needs this var
        NEXT_PUBLIC_DEV_BASE_URL: process.env.NEXT_PUBLIC_DEV_BASE_URL ?? "http://localhost:3007",
      },
      stdio: "inherit",
    });
  } catch (error) {
    fail("pnpm build failed", error);
  }
  if (!existsSync(WORKER_BUNDLE)) {
    fail("build completed but dist/worker.js is missing", new Error("tsup worker entry did not emit"));
  }
  const buildSha = run("git rev-parse --short HEAD").trim();
  timings["pnpm build wall (ms)"] = Date.now() - buildStart;
  recordStep(1, "build", true, `dist/worker.js produced; build SHA ${buildSha}`);

  // --- Step 2: zero-new-migrations (dynamic) ---------------------------------
  console.log(`[2] zero-new-migrations assertion (journal-derived, WR-05)...`);
  const journalEntries = assertZeroNewMigrations();
  const onDiskSql = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).length;
  const trackedSql = run("git ls-files -- drizzle").split(/\r?\n/).filter((l) => l.endsWith(".sql")).length;
  recordStep(2, "zero-new-migrations", true, `journal=${journalEntries} == on-disk=${onDiskSql} == tracked=${trackedSql}; git status drizzle/ clean`);

  // --- Step 3: throwaway network + containers --------------------------------
  console.log(`[3] throwaway network + ${PG_IMAGE} :${PG_PORT} + ${REDIS_IMAGE} :${REDIS_PORT} (loopback)...`);
  try {
    docker(["network", "create", NETWORK], { stdio: "ignore" });
    networkCreated = true;
  } catch (error) {
    fail(`docker network create ${NETWORK} failed`, error);
  }
  try {
    docker([
      "run", "-d", "--name", PG_CONTAINER, "--network", NETWORK,
      "-e", `POSTGRES_PASSWORD=postgres`, "-e", `POSTGRES_DB=${DB}`,
      "-p", `127.0.0.1:${PG_PORT}:5432`, PG_IMAGE,
    ], { stdio: "inherit" });
    pgStarted = true;
  } catch (error) {
    fail(`docker run failed for ${PG_CONTAINER}`, error);
  }
  try {
    docker([
      "run", "-d", "--name", REDIS_CONTAINER, "--network", NETWORK,
      "-p", `127.0.0.1:${REDIS_PORT}:6379`, REDIS_IMAGE,
    ], { stdio: "inherit" });
    redisStarted = true;
  } catch (error) {
    fail(`docker run failed for ${REDIS_CONTAINER}`, error);
  }
  // TWO consecutive pg_isready successes ~1 s apart — Docker Desktop's port
  // forward can accept-and-drop the very first connection right after
  // container start (observed: run 2's migrate died with "Connection
  // terminated unexpectedly" after a single passing probe).
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
  recordStep(3, "throwaway stack", true, `${PG_CONTAINER} + ${REDIS_CONTAINER} up on 127.0.0.1:${PG_PORT}/${REDIS_PORT}, network ${NETWORK}`);

  // --- Step 4: migrate + zero-pending no-op -----------------------------------
  console.log(`[4] drizzle-kit migrate (fresh DB) + no-op second run (D-32 leg 1)...`);
  // One bounded retry at this infra seam — a first-connection drop right
  // after container start is a known transient (observed on Docker Desktop
  // for Windows), not a migration defect; the retry re-runs the SAME runner
  // command, which is safe (journal-driven, idempotent).
  const runMigrate = (label) => {
    try {
      run("pnpm exec drizzle-kit migrate", {
        env: { ...process.env, DATABASE_URL: PG_URL },
        stdio: "inherit",
      });
    } catch (error) {
      console.log(`    (${label}: transient failure — ${error instanceof Error ? error.message.split("\n")[0] : String(error)}; one retry after 5 s)`);
      sleepSync(5000);
      try {
        run("pnpm exec drizzle-kit migrate", {
          env: { ...process.env, DATABASE_URL: PG_URL },
          stdio: "inherit",
        });
      } catch (retryError) {
        fail(`drizzle-kit migrate (${label}) failed against the throwaway on the retry`, retryError);
      }
    }
  };
  try {
    await pgConnect();
  } catch (error) {
    fail("rehearsal pg client could not connect to the throwaway", error);
  }
  runMigrate("initial apply");
  const rowsAfterFirst = (await pgQuery(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)).rows[0].n;
  if (rowsAfterFirst !== journalEntries) {
    fail(
      "migrate applied the wrong count",
      new Error(`drizzle.__drizzle_migrations has ${rowsAfterFirst} rows, journal declares ${journalEntries}`)
    );
  }
  try {
    run("pnpm exec drizzle-kit migrate", {
      env: { ...process.env, DATABASE_URL: PG_URL },
      stdio: "inherit",
    });
  } catch (error) {
    console.log(`    (no-op run: transient failure — retrying once after 5 s)`);
    sleepSync(5000);
    try {
      run("pnpm exec drizzle-kit migrate", {
        env: { ...process.env, DATABASE_URL: PG_URL },
        stdio: "inherit",
      });
    } catch (retryError) {
      fail("SECOND drizzle-kit migrate (zero-pending assert) failed", retryError);
    }
  }
  const rowsAfterSecond = (await pgQuery(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)).rows[0].n;
  if (rowsAfterSecond !== rowsAfterFirst) {
    fail(
      "second migrate was NOT a no-op",
      new Error(`journal rows ${rowsAfterFirst} -> ${rowsAfterSecond} — deploy-day 'zero pending' would be false`)
    );
  }
  recordStep(4, "migrate + no-op", true, `applied ${rowsAfterFirst} migration(s) (journal ${journalEntries}); second run applied 0 (zero pending)`);

  // --- Step 5: backup ----------------------------------------------------------
  console.log(`[5] pg_dump backup (D-9 posture)...`);
  let dumpBytes = 0;
  try {
    const dump = execFileSync(
      "docker",
      ["exec", PG_CONTAINER, "pg_dump", "-U", "postgres", "-F", "c", "-d", DB],
      { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }
    );
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    writeFileSync(`${SNAPSHOTS_DIR}/rehearse-worker-${day}-preseed.dump`, dump);
    dumpBytes = dump.length;
  } catch (error) {
    fail("pg_dump failed", error);
  }
  if (dumpBytes <= 0) {
    fail("pg_dump produced an empty file", new Error("backup posture requires a non-empty dump"));
  }
  try {
    execFileSync(
      "docker",
      ["exec", "-i", PG_CONTAINER, "pg_restore", "-U", "postgres", "--list"],
      { input: readFileSync(`${SNAPSHOTS_DIR}/rehearse-worker-${day}-preseed.dump`), stdio: ["pipe", "ignore", "ignore"], maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (error) {
    fail("backup readability sanity (pg_restore --list) failed", error);
  }
  recordStep(5, "backup", true, `${SNAPSHOTS_DIR}/rehearse-worker-${day}-preseed.dump (${dumpBytes} bytes, -F c, restore-list OK)`);

  // --- Step 6: seed synthetic monitor ------------------------------------------
  console.log(`[6] seed synthetic monitor (D-19)...`);
  try {
    execFileSync(
      "docker",
      ["exec", "-i", PG_CONTAINER, "psql", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1"],
      { input: readFileSync(SEED_FILE), stdio: ["pipe", "inherit", "inherit"] }
    );
  } catch (error) {
    fail(`applying ${SEED_FILE} failed`, error);
  }
  const seeded = (
    await pgQuery(`SELECT count(*)::int AS n FROM monitors WHERE "userId" = 'spidernode-ops-smoke' AND url = 'https://example.com/'`)
  ).rows[0].n;
  if (seeded !== 1) {
    fail("seed assert failed", new Error(`expected exactly 1 synthetic monitor row, found ${seeded}`));
  }
  // Idempotency probe: re-apply must stay at 1.
  try {
    execFileSync(
      "docker",
      ["exec", "-i", PG_CONTAINER, "psql", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1"],
      { input: readFileSync(SEED_FILE), stdio: ["pipe", "ignore", "ignore"] }
    );
  } catch (error) {
    fail(`re-applying ${SEED_FILE} (idempotency probe) failed`, error);
  }
  const seededAgain = (
    await pgQuery(`SELECT count(*)::int AS n FROM monitors WHERE "userId" = 'spidernode-ops-smoke'`)
  ).rows[0].n;
  if (seededAgain !== 1) {
    fail("seed idempotency probe failed", new Error(`re-apply produced ${seededAgain} rows (expected 1)`));
  }
  recordStep(6, "seed", true, "synthetic monitor present (owner spidernode-ops-smoke, https://example.com/, interval 1440); re-apply idempotent");

  // --- Step 7: host-leg worker start --------------------------------------------
  console.log(`[7] host worker start (node dist/worker.js, scheduler ENABLED, health :${HEALTH_PORT})...`);
  const workerSpawnAt = Date.now();
  spawnHostWorker();
  try {
    await waitFor(
      async () => (await fetchJson(HEALTH_PORT, "/readyz")).status === 200,
      45_000,
      "host worker readyz"
    );
  } catch (error) {
    fail(error.message, new Error(`output tail:\n${childOutputTail()}`));
  }
  timings["host worker spawn -> readyz 200 (ms)"] = Date.now() - workerSpawnAt;
  assertWorkerAlive("step 7");
  recordStep(7, "worker start + readyz", true, `readyz 200 on :${HEALTH_PORT} in ${timings["host worker spawn -> readyz 200 (ms)"]} ms; process alive (WRK-08)`);

  // --- Step 8: provenance assert ---------------------------------------------------
  console.log(`[8] /healthz provenance assert (D-10)...`);
  const healthz = await fetchJson(HEALTH_PORT, "/healthz");
  if (healthz.status !== 200 || healthz.body?.sha !== buildSha) {
    fail(
      "provenance mismatch",
      new Error(`/healthz sha=${healthz.body?.sha} (status ${healthz.status}) but build SHA=${buildSha}`)
    );
  }
  recordStep(8, "provenance", true, `/healthz sha=${buildSha} == build SHA (one build, one SHA — D-10)`);

  // --- Step 9: smoke #1 --------------------------------------------------------------
  console.log(`[9] smoke #1 (D-18)...`);
  const smoke1Start = Date.now();
  runSmoke("#1");
  timings["smoke #1 enqueue -> ping row (ms)"] = Date.now() - smoke1Start;
  recordStep(9, "smoke #1", true, `priority-1 manual check completed with a NEW Tier-1 evidence ping row (${timings["smoke #1 enqueue -> ping row (ms)"]} ms)`);

  // --- Step 10: Postgres-stop injection -----------------------------------------------
  console.log(`[10] Postgres-stop injection (RES-01)...`);
  docker(["stop", PG_CONTAINER], { stdio: "ignore" });
  const pgStopAt = Date.now();
  try {
    await waitFor(async () => {
      const res = await fetchJson(HEALTH_PORT, "/readyz", 4000);
      return res.status === 503 && res.body?.db?.ok === false;
    }, 30_000, "readyz 503 db:false during PG outage");
  } finally {
    // never leave the DB stopped, even on assert failure
    docker(["start", PG_CONTAINER], { stdio: "ignore" });
  }
  const pg503SeenAt = Date.now();
  timings["PG stop -> readyz 503 db:false (ms)"] = pg503SeenAt - pgStopAt;
  assertWorkerAlive("PG outage");
  await waitFor(
    () => {
      try {
        docker(["exec", PG_CONTAINER, "pg_isready", "-U", "postgres", "-d", DB], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    45_000,
    "postgres restart ready"
  );
  await pgConnect(); // rehearsal client reconnect (idle connection was terminated)
  const pgRecoveryStart = Date.now();
  await waitFor(async () => (await fetchJson(HEALTH_PORT, "/readyz")).status === 200, 60_000, "readyz 200 after PG recovery");
  await waitFor(async () => {
    const res = await fetchJson(HEALTH_PORT, "/metrics.json", 5000);
    return res.status === 200 && res.body?.breaker?.state === "CLOSED";
  }, 120_000, "breaker CLOSED after PG recovery");
  timings["PG restart -> readyz 200 + breaker CLOSED (ms)"] = Date.now() - pgRecoveryStart;
  runSmoke("#2 (post-PG-recovery)");
  recordStep(10, "PG outage + recovery", true, `readyz 503 db:false observed, process SURVIVED; recovery -> readyz 200 + breaker CLOSED (${timings["PG restart -> readyz 200 + breaker CLOSED (ms)"]} ms) -> smoke #2 GREEN`);

  // --- Step 11: Redis-stop injection (pause-by-design) -----------------------------------
  console.log(`[11] Redis-stop injection (RES-05, pause-by-design)...`);
  const pingsBefore = await pingCount();
  docker(["stop", REDIS_CONTAINER], { stdio: "ignore" });
  const redisStopAt = Date.now();
  // NOTE (D-33 observation): during a Redis outage /readyz HANGS (retry-forever
  // clients queue the ping) — it does not 503. The honest asserts are: process
  // alive, Postgres intact, ZERO new pings. No enqueue is attempted (it would
  // hang the smoke script until its watchdog fires — the enqueue path PAUSES,
  // by design, D-16's queue.pause prohibition notwithstanding).
  notes.push("Redis-outage window: enqueue deliberately NOT attempted (retry-forever clients would hang it — pause-by-design, D-33 'readyzDuringOutage: hung' observation)");
  await sleep(20_000);
  assertWorkerAlive("Redis outage");
  const midOutage = await pingCount();
  if (midOutage !== pingsBefore) {
    fail(
      "pause-by-design violated during Redis outage",
      new Error(`pings for the synthetic monitor changed ${pingsBefore} -> ${midOutage} while Redis was down`)
    );
  }
  const stillQueryable = (await pgQuery(`SELECT 1 AS one`)).rows[0].one;
  if (stillQueryable !== 1) {
    fail("Postgres was collateral damage of the Redis outage", new Error("SELECT 1 failed mid-Redis-outage"));
  }
  docker(["start", REDIS_CONTAINER], { stdio: "ignore" });
  const redisRecoveryStart = Date.now();
  await waitFor(
    () => {
      try {
        docker(["exec", REDIS_CONTAINER, "redis-cli", "ping"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    45_000,
    "redis restart ready"
  );
  await waitFor(async () => (await fetchJson(HEALTH_PORT, "/readyz", 5000)).status === 200, 120_000, "readyz 200 after Redis recovery");
  timings["Redis restart -> readyz 200 (ms)"] = Date.now() - redisRecoveryStart;
  runSmoke("#3 (post-Redis-recovery)");
  recordStep(11, "Redis outage + recovery", true, `20 s outage: process alive, pings ${pingsBefore}->${midOutage} (pause held), PG intact; recovery -> readyz 200 (${timings["Redis restart -> readyz 200 (ms)"]} ms) -> smoke #3 GREEN`);

  // --- Step 12: SIGINT-drain container leg -----------------------------------------------
  console.log(`[12] SIGINT-drain container leg (Pitfall 8) — self-contained bundle in ${WORKER_CONTAINER}...`);
  buildContainerBundle(buildSha);
  const nodeMajor = process.versions.node.split(".")[0];
  const nodeImage = `node:${nodeMajor}-alpine`;
  try {
    docker(["pull", nodeImage], { stdio: "inherit" });
  } catch (error) {
    fail(`docker pull ${nodeImage} failed (container leg needs the Linux node image)`, error);
  }
  try {
    docker([
      "create", "--name", WORKER_CONTAINER, "--network", NETWORK,
      "-e", `DATABASE_URL=${PG_URL_INNER}`,
      "-e", `REDIS_URL=${REDIS_URL_INNER}`,
      "-e", "WORKER_SCHEDULER_ENABLED=false", // D-16 dark-launch posture for the signal leg
      "-e", "NODE_ENV=production",
      nodeImage, "node", "/worker/worker.js",
    ], { stdio: "inherit" });
    workerContainerCreated = true;
    // `/.` form: copies the bundle CONTENTS as /worker — deterministic whether
    // or not the destination already exists.
    docker(["cp", `${toPosix(CONTAINER_BUNDLE_DIR)}/.`, `${WORKER_CONTAINER}:/worker`], { stdio: "inherit" });
    docker(["start", WORKER_CONTAINER], { stdio: "inherit" });
  } catch (error) {
    fail(`container-leg worker (${nodeImage}) create/cp/start failed`, error);
  }
  const containerReadyStart = Date.now();
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
    }, 60_000, "container worker readyz (docker exec)");
  } catch (error) {
    // Fail loud WITH the container's own output — a dead worker's logs are
    // the only way to diagnose a bundle/runtime fault after teardown.
    let containerLogs = "(docker logs unavailable)";
    try {
      containerLogs = docker(["logs", "--tail", "80", WORKER_CONTAINER]).trim();
    } catch {
      /* container may already be gone */
    }
    fail(
      `container worker never became ready — docker logs tail:\n${containerLogs}`,
      error
    );
  }
  timings["container worker start -> readyz (ms)"] = Date.now() - containerReadyStart;
  // The container worker serves smoke #4 — proving real work crosses the
  // signal (not just a boot/shutdown cycle).
  runSmoke("#4 (served by the CONTAINER worker)");
  const sigintAt = Date.now();
  docker(["kill", "--signal=SIGINT", WORKER_CONTAINER], { stdio: "ignore" });
  await waitFor(() => {
    const state = docker(["inspect", "-f", "{{.State.Status}}", WORKER_CONTAINER]).trim();
    return state !== "running";
  }, 60_000, "container worker exited after SIGINT");
  const exitCode = Number(docker(["inspect", "-f", "{{.State.ExitCode}}", WORKER_CONTAINER]).trim());
  const logs = docker(["logs", WORKER_CONTAINER]);
  const sawBoot = logs.includes("worker booted");
  const sawShutdown = logs.includes("worker shutting down");
  timings["SIGINT -> container exit (drain, ms)"] = Date.now() - sigintAt;
  if (exitCode !== 0 || !sawBoot || !sawShutdown) {
    fail(
      "SIGINT drain leg failed",
      new Error(`exitCode=${exitCode}, bootedMarker=${sawBoot}, shutdownMarker=${sawShutdown}, drainMs=${timings["SIGINT -> container exit (drain, ms)"]}`)
    );
  }
  recordStep(12, "SIGINT drain (container)", true, `${nodeImage} as PID 1, flag-off posture: readyz ${timings["container worker start -> readyz (ms)"]} ms, smoke #4 served, SIGINT -> graceful drain -> exit 0 in ${timings["SIGINT -> container exit (drain, ms)"]} ms (WRK-07)`);

  // --- Step 13: evidence ------------------------------------------------------------------
  console.log(`[13] writing evidence...`);
  const evidence = {
    day,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    buildSha,
    migrations: { journalEntries, onDiskSql, trackedSql },
    stack: {
      pg: { image: PG_IMAGE, container: PG_CONTAINER, port: PG_PORT, db: DB },
      redis: { image: REDIS_IMAGE, container: REDIS_CONTAINER, port: REDIS_PORT },
      network: NETWORK,
      isolation: "127.0.0.1-only publishes; sibling stacks (5454/6391/5453/6390) never dialed (T-04-34)",
    },
    steps,
    timings,
    notes,
    failures,
  };
  notes.push(
    "Host-leg worker stop is a hard kill (win32 cannot deliver SIGINT to a child — Pitfall 8); the graceful drain is proven by the container leg in step 12."
  );
  notes.push(
    "Throwaway Redis runs stock redis:8-alpine (no requirepass/AOF) — the hardened posture was proven live by 03-08; this rehearsal exercises the WORKER, not the Redis config."
  );
  writeEvidence(evidence);

  if (failures.length > 0) {
    console.error(`\nREHEARSAL FAILED — ${failures.length} step failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    fail("rehearsal verdict FAIL", new Error("the dark launch (Task 3) is BLOCKED until the rehearsal passes (D-32)"));
  }
  console.log(`\nREHEARSAL PASSED — ${steps.length} steps green; evidence at ${SNAPSHOTS_DIR}/rehearse-worker-${day}.md.`);
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // Step 14: teardown on success AND failure — only what this run created.
  console.log(`[teardown] removing throwaway stack + temp bundle artifacts...`);
  if (child && !childExited) {
    try {
      child.kill("SIGKILL"); // Pitfall 8 — hard kill, documented in evidence notes
      console.log(`  host worker child killed (SIGKILL — win32 signal limit, Pitfall 8)`);
    } catch {
      /* already gone */
    }
  }
  for (const name of [WORKER_CONTAINER, PG_CONTAINER, REDIS_CONTAINER]) {
    try {
      docker(["inspect", name], { stdio: "ignore" });
    } catch {
      continue; // never created this run — nothing to remove
    }
    try {
      docker(["rm", "-f", name], { stdio: "ignore" });
      console.log(`  removed container ${name}`);
    } catch {
      console.error(`TEARDOWN WARNING: could not remove ${name} — run: docker rm -f ${name}`);
    }
  }
  if (networkCreated) {
    try {
      docker(["network", "rm", NETWORK], { stdio: "ignore" });
      console.log(`  removed network ${NETWORK}`);
    } catch {
      console.error(`TEARDOWN WARNING: could not remove network ${NETWORK} — run: docker network rm ${NETWORK}`);
    }
  }
  try {
    if (pg) await pg.end();
  } catch {
    /* already ended */
  }
  try {
    rmSync(TEMP_TSUP_CONFIG, { force: true });
    rmSync(CONTAINER_BUNDLE_DIR, { recursive: true, force: true });
    console.log(`  removed temp bundle artifacts (${TEMP_TSUP_CONFIG}, ${CONTAINER_BUNDLE_DIR})`);
  } catch {
    console.error(`TEARDOWN WARNING: could not remove temp bundle artifacts under ${SNAPSHOTS_DIR}/ — remove manually`);
  }
}
