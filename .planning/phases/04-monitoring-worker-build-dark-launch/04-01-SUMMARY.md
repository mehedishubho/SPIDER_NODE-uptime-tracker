---
phase: 04-monitoring-worker-build-dark-launch
plan: 01
subsystem: infra
tags: [bullmq, tsup, pino, undici, pm2, worker-process, health-endpoints, boundary-gate, dark-launch]

# Dependency graph
requires:
  - phase: 03-redis-drizzle-schema-ownership
    provides: drizzle schema + migration pipeline, hardened Redis stand-in, shared src/lib/redis.ts and src/lib/db-pool.ts patterns this plan's worker modules copy
provides:
  - Bootable single-entry worker bundle dist/worker.js (+ .map) produced by the same `pnpm build` as the web app, with embedded WORKER_BUILD_SHA/WORKER_BUILD_TS provenance
  - src/worker/ module set every later Phase 4 plan composes from — logger (buildLogger + monitorId/jobId child bindings), connection (workerConnection), db (worker pg pool max 20 + drizzle), health (startHealthServer), index (boot + signal registration + shutdown drain)
  - Boundary verify gate (scripts/check-worker-boundary.mjs) wired into `pnpm verify` between schema:gate and build — worker/Next isolation is an invariant, not a habit
  - PM2 worker app stanza (uptime-worker) with wait_ready/listen_timeout 30000/kill_timeout 20000
  - WORKER_SCHEDULER_ENABLED / WORKER_HEALTH_PORT / WORKER_LOG_LEVEL documented in .env.example
affects: [04-02, 04-03, 04-04, 04-05, 04-06, 04-07, 04-08, 04-09, phase-05-worker-cutover]

# Tech tracking
tech-stack:
  added: ["bullmq 6.3.4 (dep)", "pino 10.3.1 (dep)", "undici 8.10.2 (dep)", "tsup 8.5.1 (devDep — bundler)", "tsx 4.23.13 (explicit devDep, was transitive only)"]
  patterns:
    - "dotenv/config as the literal first import of the worker entry (D-12)"
    - "Two-signal readiness: HTTP /readyz for operator/CI + process.send('ready') for PM2 wait_ready — wiring only HTTP boot-crash-loops under wait_ready (WRK-08, 01-07 precedent)"
    - "Worker-only code isolated under src/worker/ sharing src/lib//src/db/ modules, enforced by a verify-chain gate (D-08)"
    - "Provenance chain: tsup define block resolves git SHA at build time; health payloads and the boot log consume it (D-10)"
    - "Health server accepts injected Redis/pg ping clients so tests can pass failing fakes (503 path provable without killing real dependencies)"
    - "globalThis-cached worker pool + drizzle instance so vitest resetModules discipline works (PATTERNS shared pattern)"
    - "One flat package, worker as an in-repo entry — no workspace/monorepo restructure (D-01)"

key-files:
  created:
    - src/worker/index.ts
    - src/worker/connection.ts
    - src/worker/logger.ts
    - src/worker/health.ts
    - src/worker/db.ts
    - tsup.config.ts
    - scripts/check-worker-boundary.mjs
    - tests/worker/logger.test.ts
    - tests/worker/health.test.ts
    - tests/worker/shutdown.test.ts
    - tests/worker/build-gate.test.ts
  modified:
    - package.json
    - ecosystem.config.js
    - .gitignore
    - eslint.config.mjs
    - .env.example
    - pnpm-lock.yaml

key-decisions:
  - "tsup 8.5.1 locked despite unmaintained status per D-02 — needed config surface is ~15 verified lines and the bundler is a swappable seam (04-RESEARCH Open Question 1); operator approved at the blocking package-legitimacy gate"
  - "Worker Redis connection uses maxRetriesPerRequest: null + enableReadyCheck: true (BullMQ worker-side requirement) — deliberately NOT the web client's fail-open config"
  - "Worker pg pool copies the db-pool.ts §25.2 pin block with max raised to 20, globalThis-cached"
  - "Health surface binds 127.0.0.1 only (T-04-01) and carries provenance/status payloads only — no connection strings, tokens, or env values"
  - "Shutdown tested by direct in-process invocation of the exported drain function — Windows cannot deliver SIGINT to children (RESEARCH Pitfall 8)"

patterns-established:
  - "Boundary gate: any src/worker/** import of next-namespace packages, react, or @/app/ paths exits non-zero inside pnpm verify (D-08)"
  - "One build, two artifacts: `pnpm build` = prisma generate + next build + tsup (D-06); dist/ is gitignored, artifacts rebuilt every verify"

requirements-completed: [WRK-14, WRK-08]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "One `pnpm build` emits both the Next build and dist/worker.js + dist/worker.js.map (CJS, sourcemapped, WORKER_BUILD_SHA/WORKER_BUILD_TS embedded via tsup define)"
    requirement: WRK-14
    verification:
      - kind: unit
        ref: "tests/worker/build-gate.test.ts#asserts dist/worker.js and dist/worker.js.map exist after the build step"
        status: pass
    human_judgment: false
  - id: D2
    description: "Worker boots standalone: dotenv-first entry, REDIS_URL/DATABASE_URL asserted at boot, pino JSON boot line carrying build SHA, process.send('ready') only after Redis+Postgres pings succeed"
    requirement: WRK-01
    verification:
      - kind: other
        ref: "smoke boot (prior session): WORKER_HEALTH_PORT=9191 node dist/worker.js → /healthz 200 {ok:true,sha:fc71c9b}, /readyz 200 (redis+db ok), /metrics.json seeded; bundle 19.99KB embedding WORKER_BUILD_SHA=fc71c9b"
        status: pass
    human_judgment: false
  - id: D3
    description: "Health surface on 127.0.0.1:9090 — /healthz provenance JSON, /readyz 200 when Redis+Postgres answer / 503 when either fails, /metrics.json provenance + Redis memory percent seed"
    requirement: WRK-08
    verification:
      - kind: integration
        ref: "tests/worker/health.test.ts#/healthz 200 with sha+builtAt; /readyz 200 both-ok; /readyz 503 + ready-callback-not-fired with injected failing Redis fake"
        status: pass
    human_judgment: false
  - id: D4
    description: "Graceful shutdown drain: shared handler closes the health server, awaits registered worker close-hooks, ends the pg pool, quits Redis, exits 0 (WRK-07 handler-level)"
    verification:
      - kind: unit
        ref: "tests/worker/shutdown.test.ts#direct in-process invocation; pool.end and redis.quit asserted before exit"
        status: pass
    human_judgment: false
  - id: D5
    description: "Worker/Next boundary gate wired into pnpm verify between schema:gate and build; fails on violating fixtures, passes on src/worker"
    verification:
      - kind: unit
        ref: "tests/worker/build-gate.test.ts#temp fixture importing a forbidden module family → non-zero exit; src/worker scan → zero exit; pnpm verify chain includes worker:boundary"
        status: pass
    human_judgment: false
  - id: D6
    description: "pino structured logger: JSON to stdout, level from WORKER_LOG_LEVEL (default info), child loggers bound with monitorId/jobId (OBS-02 foundation)"
    requirement: OBS-02
    verification:
      - kind: unit
        ref: "tests/worker/logger.test.ts#parseable JSON, merged monitorId/jobId bindings, level honored"
        status: pass
    human_judgment: false
  - id: D7
    description: "PM2 worker app stanza (uptime-worker): node dist/worker.js, wait_ready true, listen_timeout 30000, kill_timeout 20000"
    requirement: DEP-01
    verification: []
    human_judgment: true
    rationale: "Config pins verified by inspection during execution; the wait_ready handshake and kill_timeout drain are runtime behaviors only provable at first deploy (runbook §4a path, 04-09 dark launch) — no automated assertion exists for ecosystem.config.js"
  - id: D8
    description: ".env.example documents WORKER_SCHEDULER_ENABLED (default false — dark launch, D-16), WORKER_HEALTH_PORT (default 9090), WORKER_LOG_LEVEL (default info)"
    verification:
      - kind: other
        ref: "grep WORKER_ .env.example → 3 vars present (commit 18204fc)"
        status: pass
    human_judgment: false

# Metrics
duration: ~2 sessions (checkpoint-gated)
completed: 2026-09-13
status: complete
---

# Phase 4 Plan 1: Worker Boot Slice Summary

**Standalone worker process that builds from the same `pnpm build` as the web app, boots with embedded git-SHA provenance, serves loopback /healthz + /readyz + /metrics.json on :9090, drains cleanly on SIGINT/SIGTERM, and is fenced off from Next/React by a verify-chain boundary gate**

## Performance

- **Duration:** ~2 sessions (checkpoint-gated: package-legitimacy approval + permission-rule relaxation)
- **Completed:** 2026-09-13
- **Tasks:** 3 (1 blocking checkpoint gate + 2 auto tasks; Task 2 residual .env.example landed via operator checkpoint)
- **Files modified:** 17 tracked files across three commits (11 + 5 + 1); 9 core deliverable files per the plan's artifacts list

## Accomplishments

- Dependencies installed behind a blocking human gate: bullmq 6.3.4, pino 10.3.1, undici 8.10.2 (deps); tsup 8.5.1, tsx 4.23.13 (explicit devDeps — tsx was transitive-only before, Pitfall 9)
- One `pnpm build` produces web + worker artifacts: build script now chains `prisma generate && next build && tsup`; dist/worker.js (19.99KB, CJS) ships with dist/worker.js.map and embeds `WORKER_BUILD_SHA="fc71c9b"` / WORKER_BUILD_TS via the tsup define block (D-06/D-10 provenance chain)
- src/worker/ module set landed: dotenv-first boot entry with env asserts and the two-signal ready contract (WRK-08), BullMQ-shaped Redis factory (maxRetriesPerRequest null), budgeted pg pool (max 20 + §25.2 pins, globalThis-cached), pino logger with monitorId/jobId child bindings, and the loopback health server with injectable ping clients
- Boundary convention is now an invariant: scripts/check-worker-boundary.mjs scans src/worker/** for next-namespace/react/@:app imports and runs inside `pnpm verify` between schema:gate and build (D-08)
- PM2 worker stanza appended (uptime-worker, wait_ready true, listen_timeout 30000, kill_timeout 20000 — deliberate raises over PM2 defaults per D-20/P-1/DEP-01)
- Four worker test suites joined the existing vitest suite; full `pnpm verify` green end-to-end: lint 0 errors → typecheck → 129 vitest tests → schema:gate → worker:boundary → build → 18 e2e
- Smoke boot recorded: `/healthz` 200 `{"ok":true,"sha":"fc71c9b"}`, `/readyz` 200 (redis+db ok), `/metrics.json` seeded; boundary gate proven to exit 1 on a fixture importing next/server, react, or @/app/* modules

## Task Commits

Each task was committed atomically:

1. **Task 1-2: Worker boot slice (checkpoint-approved deps, tsup bundle, boot/connection/logger/health/db, boundary gate, ecosystem stanza)** — `f65abb9` (feat)
2. **Task 3: Boot, health, shutdown, and build-gate test suites** — `c6f9d3e` (test)
3. **Task 2 residual: WORKER_* env vars documented in .env.example (operator permission-rule checkpoint)** — `18204fc` (docs)

**Plan metadata:** this summary commit + `docs(phase-04): update tracking after 04-01`

## Files Created/Modified

- `src/worker/index.ts` - boot entry: dotenv/config first import, env asserts, schedulerEnabled/healthPort reads, health server registration, ready pings, process.send('ready') two-signal contract, SIGINT/SIGTERM drain registration
- `src/worker/connection.ts` - workerConnection(): new IORedis from REDIS_URL, maxRetriesPerRequest null + enableReadyCheck true, throw-early on missing env, error listener inside the factory, URL never logged
- `src/worker/logger.ts` - buildLogger(): pino instance, level from WORKER_LOG_LEVEL (default info), stdout only, no transports; child-logger helper binding monitorId/jobId
- `src/worker/health.ts` - node:http server on 127.0.0.1:WORKER_HEALTH_PORT (default 9090): /healthz provenance JSON, /readyz Redis+Postgres ping with per-dependency status, /metrics.json provenance + Redis memory percent seed (D-24/D-25 collector start); accepts injected ping clients
- `src/worker/db.ts` - worker-owned pg Pool (max 20, statement_timeout 30000, idle_in_transaction_session_timeout 30000) + drizzle instance, globalThis-cached
- `tsup.config.ts` - entry src/worker/index.ts, format cjs, sourcemap true, skipNodeModulesBundle true, platform node, splitting false, define block injecting WORKER_BUILD_SHA (git rev-parse --short HEAD, fallback empty) / WORKER_BUILD_TS
- `scripts/check-worker-boundary.mjs` - boundary gate scanning src/worker/** for forbidden import families (next-namespace, react, @/app/*), non-zero exit listing violations
- `package.json` - deps/devDeps above; build chain extended with tsup; dev:worker (tsx watch); worker:boundary script; verify chain inserts worker:boundary between schema:gate and build
- `ecosystem.config.js` - second apps entry `uptime-worker` (node dist/worker.js, wait_ready true, listen_timeout 30000, kill_timeout 20000, §4a first-release comment)
- `tests/worker/logger.test.ts` - JSON parseability, child bindings merge, level honoring
- `tests/worker/health.test.ts` - /healthz 200 sha+builtAt, /readyz 200 both-ok on the docker test stack, /readyz 503 + ready-callback-not-fired with failing Redis fake
- `tests/worker/shutdown.test.ts` - direct in-process drain invocation: health server closes, worker close-hooks awaited, pool.end + redis.quit called before exit
- `tests/worker/build-gate.test.ts` - dist artifacts exist post-build; boundary script fails on violating temp fixture, passes on src/worker
- `eslint.config.mjs` - test-suite wiring for the new tests/worker files
- `.gitignore` - dist/ excluded (worker bundle is a build artifact, rebuilt every verify)
- `.env.example` - WORKER_SCHEDULER_ENABLED / WORKER_HEALTH_PORT / WORKER_LOG_LEVEL block
- `pnpm-lock.yaml` - lockfile for the five new packages

## Decisions Made

- tsup 8.5.1 locked despite unmaintained status per D-02: the needed config surface is ~15 verified lines and the bundler is a swappable seam (04-RESEARCH Open Question 1) — operator acknowledged and approved at the blocking gate
- Worker Redis connection deliberately diverges from the web client: maxRetriesPerRequest null + enableReadyCheck true (BullMQ worker-side requirement), not the fail-open web config
- Shutdown tested by direct in-process invocation of the exported drain function because Windows cannot deliver SIGINT to child processes (RESEARCH Pitfall 8)
- Health server accepts injected ping clients so the 503 path is provable in tests without sabotaging real dependencies
- Requirements marked conservatively (project false-signal precedent, cf. 02-03/03-02): only WRK-14 (one repo/one build) and WRK-08 (health endpoints + two-signal contract, implemented and tested) are complete. WRK-01 (worker "owns all monitoring execution" — this plan delivered the process slice only; queues/claim/persistence arrive in 04-02..04-07), OBS-02 (logger foundation landed; monitorId correlation across scheduler → check → persist → alert is unprovable until those stages exist), and DEP-01 (build/versioning half + PM2 stanza landed; same-SHA runtime claim and crash-loop visibility proven at dark launch/deploy, 04-09) stay pending until their later Phase 4 plans close them

## Checkpoints

**1. Package legitimacy gate (Task 1, `checkpoint:human-verify`, gate `blocking-human`)**
- **What:** Blocking human gate before any install. 04-RESEARCH's audit flagged bullmq 6.3.4, tsx 4.23.13, undici 8.10.2 as [SUS] solely by the recency heuristic (each publishes constantly), and tsup 8.5.1 is UNMAINTAINED per its README (recommends tsdown) — D-02 locks tsup anyway.
- **Operator response:** "Approved" after checking the npmjs.com registry pages (taskforce-sh/privatenumber/nodejs publishers, millions of weekly downloads).
- **Resolution:** `pnpm add bullmq@6.3.4 pino@10.3.1 undici@8.10.2` + `pnpm add -D tsup@8.5.1 tsx@4.23.13` proceeded as planned; installs committed in `f65abb9`. No package rejections, no substitutions.

**2. Permission-rule relaxation for .env.example (Task 2 residual, `checkpoint:human-action`)**
- **What:** Appending the WORKER_* block to .env.example was blocked by the user's global permission deny rule `Read(.env.*)` — the executor could not touch the file, and no auto-fix path exists for a user-owned permission rule.
- **Operator response:** "Relax rule + retry".
- **Resolution:** The user narrowed the global deny rule to the explicit secret-bearing variants (.env, .env.local, .env.test) so .env.example is writable while real env files stay denied. The orchestrator appended the WORKER_SCHEDULER_ENABLED / WORKER_HEALTH_PORT / WORKER_LOG_LEVEL block and committed it as `18204fc`. Secret-bearing env files were never read at any point.

## Deviations from Plan

None auto-fixed (no Rule 1-3 deviations). Two operator checkpoints were handled per protocol (see Checkpoints above); the only plan-shape deviation they caused:

- **Task 2's .env.example item slipped to a third commit (`18204fc`)** rather than riding the Task 2 commit — a direct consequence of checkpoint 2 (the file was unwritable until the user relaxed the permission rule mid-session). Content landed exactly as planned.

**Total deviations:** 0 auto-fixed; 1 checkpoint-driven commit reshuffle (no scope change)
**Impact on plan:** None — all must-have truths, artifacts, and acceptance criteria verified green.

## Issues Encountered

None beyond the two checkpoints. pnpm's esbuild build-script warning did not materialize into a failure (Pitfall 10 contingency unused); the first bundle build succeeded without pnpm-workspace allowBuilds changes.

## User Setup Required

None — no external service configuration introduced by this plan. (VPS deployment of the worker app is a later plan's concern; runbook §4a first-release path is referenced in the ecosystem stanza comment.)

## Verification

- `pnpm verify` green end-to-end: lint (0 errors) → typecheck → 129 vitest tests (includes the 4 new worker suites) → schema:gate → worker:boundary → build → 18 e2e
- Manual smoke (per plan verification spec): `node dist/worker.js` boots standalone; `/healthz` → 200 `{"ok":true,"sha":"fc71c9b"}`; `/readyz` → 200 (redis + db ok); `/metrics.json` seeded; boot log line carries the current git SHA; bundle 19.99KB with `WORKER_BUILD_SHA="fc71c9b"` embedded
- Boundary gate proven bidirectionally: exit 1 on a temp fixture importing next/server / react / @/app/* modules; exit 0 on src/worker
- No changes to web app behavior: next.config.ts, src/app/**, src/lib/cron-logic.ts, src/lib/db-batcher.ts, src/instrumentation.ts untouched (D-05 — cron-logic.ts and db-batcher.ts stay as-is until Phase 5 deletes them)

## Self-Check: PASSED

- Implementation files: 11/11 FOUND (src/worker/{index,connection,logger,health,db}.ts, tsup.config.ts, scripts/check-worker-boundary.mjs, tests/worker/{logger,health,shutdown,build-gate}.test.ts)
- Task commits: f65abb9 FOUND, c6f9d3e FOUND, 18204fc FOUND
- .env.example WORKER_* vars: 3/3 present

## Next Phase Readiness

- Every Wave 2 plan (04-02 queues, 04-03 claim, 04-04 persistence, 04-05 relay) can boot from src/worker/ modules: buildLogger for monitorId-correlated logging, workerConnection for BullMQ clients, the db pool/drizzle instance, the register-for-drain shutdown seam, and the health/metrics surface to extend with queue gauges
- dist/worker.js is the single worker entry (D-11): queue workers, scheduler, health server, and breaker all compose into it in later plans — no new PM2 apps
- WORKER_SCHEDULER_ENABLED is read but unconsumed (default false) — 04-08/04-09 dark-launch plans flip it; the env var contract is already documented
- DEP-01's runtime same-SHA claim is verifiable from this plan onward: the /healthz sha field must equal the web release's git SHA at deploy time (04-09 proves it live)

---
*Phase: 04-monitoring-worker-build-dark-launch*
*Completed: 2026-09-13*
