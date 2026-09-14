---
phase: 04-monitoring-worker-build-dark-launch
plan: "08"
subsystem: testing
tags: [bullmq, resilience, failure-injection, circuit-breaker, docker, vitest, sigkill, staleness]

requires:
  - phase: 04-monitoring-worker-build-dark-launch
    provides: check processor (04-06), outbox relay + maintenance lanes (04-07), queue topology + breaker + backlog gate (04-02), lock manager (04-01), Tier 1/2 persistence (04-04/04-05)
provides:
  - "pnpm test:resilience — standalone seven-case failure-injection suite driving the REAL dist/worker.js bundle against the exclusive 5453/6390 docker stack (D-27/D-28/D-29/D-30)"
  - "D-33 tuning dataset (tests/resilience/observations.json): breaker open/recovery timings, backlog drop counts, retry/redelivery accounting — cited by the 04-09 deploy record"
  - "staleness-display pin (D-34): raw-timestamp rendering of aging lastChecked pinned on Dashboard/MonitorDetails/PublicStatus"
  - "two production defects found and fixed by injection: worker crash on idle-pool-client termination during a Postgres outage; breaker misclassification of drizzle-wrapped pg errors (never opened during a real outage)"
affects: [04-09 (rehearsal + dark launch deploy record), phase-05 (cutover), verify-work UAT]

tech-stack:
  added: []  # no new libraries — the suite composes existing bullmq/pg/ioredis/docker tooling
  patterns:
    - "real-bundle injection: spawn dist/worker.js child with explicit stack pins; SIGKILL as the win32-deliverable kill primitive (Pitfall 8)"
    - "writeSync(1, ...) marker before every intentional hard-kill — survives pino/sonic-boom buffering"
    - "process-split proof: enqueue-side gate verdicts driven in the test process (same code path), processing/lifecycle legs proven in the spawned child (postgres-down/backlog-flood precedent)"
    - "checkpoints.beforeReverify: deterministic in-process injection seam inside the classification->re-verify race window (lock-loss)"
    - "cause-chain error classification: walk err.cause (8-deep, cycle-guarded) — drizzle wraps every driver error in a DrizzleQueryError"

key-files:
  created:
    - tests/resilience/duplicate-delivery.test.ts
    - tests/resilience/kill-mid-job.test.ts
    - tests/resilience/postgres-down.test.ts
    - tests/resilience/redis-down.test.ts
    - tests/resilience/lock-loss.test.ts
    - tests/resilience/redis-restart.test.ts
    - tests/resilience/backlog-flood.test.ts
    - tests/resilience/observations.json
    - tests/staleness-display.test.ts
  modified:
    - src/worker/engine/check.ts
    - src/worker/breaker.ts
    - src/worker/db.ts
    - tests/resilience/helpers/worker-process.ts
    - tests/worker/engine-check.test.ts
    - vitest.config.ts

key-decisions:
  - "04-08: resilience suite lives OUTSIDE pnpm verify as pnpm test:resilience (D-27) — vitest.config.ts excludes tests/resilience/**; verify = what the code does, test:resilience = what breakage it survives (D-31 split kept clean)"
  - "04-08: check.ts carries two TEST-ONLY seams — env-gated WORKER_TEST_CRASH_AFTER=tier1_commit SIGKILL hook (D-29, inert without the env) and checkpoints.beforeReverify (deterministic lock-loss injection); both source-pinned by the cases (T-04-30)"
  - "04-08: breaker pg-classification is cause-chain-aware — drizzle's DrizzleQueryError hides the pg error at the top level; errno-class socket codes classify infra on the worker-DB call-context regardless of message form, EXCEPT ENOTFOUND which stays connect-message-gated (the WRK-05 target-NXDOMAIN pin holds)"
  - "04-08: test Redis runs redis:8-alpine STOCK (RDB default save points, no AOF/volume) — restart-state indeterminate by design; redis-restart proves boot-time scheduler re-upsert + TTL expiry + next_check_at re-claim without asserting survivor-set invariants the image cannot give (RES-05 posture)"
  - "04-08: D-34 dispositioned, not built — no relative 'Xm ago' surface exists in the codebase; the staleness pin asserts the raw toLocaleTimeString surface + 'Never' ternary on all three named surfaces so aging timestamps cannot silently stop rendering"

patterns-established:
  - "QUEUE_KEY_PATTERNS glob discipline: SCAN MATCH needs the trailing '*' — bare 'bull:monitor-checks:' matches only a key literally named that (a no-op); stale active/prioritized members then leak across runs (fixed in BOTH the resilience helper and engine-check beforeEach)"
  - "pino/sonic-boom binds its write path at logger CREATION — a process.stdout spy installed later cannot observe module-scope loggers; assert marker contracts via source-pins or injectable loggers instead"
  - "pg Pool/Client idle-connection terminations (57P01) re-emit as 'error' events — unlistened = uncaught exception = process crash; every long-lived pool and every query-only test client needs a listener"

requirements-completed: [RES-01, RES-02, RES-03, RES-04, RES-05, WRK-07]

coverage:
  - id: D1
    description: "Case 1 — duplicate delivery of one check produces exactly one ping row for the epoch"
    requirement: RES-03
    verification:
      - kind: integration
        ref: "tests/resilience/duplicate-delivery.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Case 2 — real SIGKILL past the Tier 1 commit (D-29): committed transition survives, stalled checker redelivers, counters exactly-once"
    requirement: RES-03
    verification:
      - kind: integration
        ref: "tests/resilience/kill-mid-job.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Case 3 — Postgres down: jobs retryable (not lost), breaker OPEN visible in /metrics.json, enqueue gate refuses while OPEN, exactly-once recovery, breaker recovers OPEN->HALF_OPEN->CLOSED"
    requirement: RES-01
    verification:
      - kind: integration
        ref: "tests/resilience/postgres-down.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Case 4 — Redis down: monitoring pauses by design, no fallback scheduler, Postgres rows intact"
    requirement: RES-04
    verification:
      - kind: integration
        ref: "tests/resilience/redis-down.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "Case 5 — lock lost between classification and the Tier 1 commit: write aborts with zero Postgres effects; next executor lands the transition exactly once"
    requirement: RES-03
    verification:
      - kind: integration
        ref: "tests/resilience/lock-loss.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Case 6 — Redis restart: schedulers re-upsert at boot (RES-05), stale locks expire via TTL, next tick re-claims via next_check_at"
    requirement: RES-05
    verification:
      - kind: integration
        ref: "tests/resilience/redis-restart.test.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "Case 7 — backlog flood above the ~2x cap drops routine (priority-10) enqueues with counted drops while the transition lane processes ungated (RES-02)"
    requirement: RES-02
    verification:
      - kind: integration
        ref: "tests/resilience/backlog-flood.test.ts"
        status: pass
    human_judgment: false
  - id: D8
    description: "Staleness display pin (D-34) — aging lastChecked timestamps keep rendering as raw timestamps on Dashboard/MonitorDetails/PublicStatus; 'Never' ternary preserved"
    requirement: WRK-07
    verification:
      - kind: unit
        ref: "tests/staleness-display.test.ts"
        status: pass
    human_judgment: false
  - id: D9
    description: "D-33 tuning dataset — breaker timings, drop counts, retry latencies captured to tests/resilience/observations.json for the deploy record to cite"
    verification:
      - kind: other
        ref: "tests/resilience/observations.json (written by every case via recordObservations; full-suite run 2026-09-14)"
        status: pass
    human_judgment: false
  - id: D10
    description: "verify/resilience split — pnpm test:resilience runs the seven cases standalone; pnpm verify green and unchanged (regular suite never runs the injection cases)"
    verification:
      - kind: other
        ref: "pnpm test:resilience (7/7 files, 7/7 tests, 242s) + NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm verify (exit 0: lint, typecheck, 30 files/249 tests, schema:gate, worker:boundary, build, api e2e)"
        status: pass
    human_judgment: false

duration: 2 sessions (Task 2-3 continuation after usage-limit cutoff; this leg ~75 min incl. two Rule-1 production fixes)
completed: 2026-09-14
status: complete
---

# Phase 4 Plan 08: Resilience Injection Suite Summary

**Seven failure-injection cases (duplicate delivery, real SIGKILL past Tier-1 commit, Postgres down, Redis down, lock loss, Redis restart, backlog flood) driving the real worker bundle — all green standalone outside verify, finding and fixing two real production defects (worker crash on pool-client termination; breaker blind to drizzle-wrapped pg errors)**

## Performance

- **Duration:** 2 sessions (prior executor: Task 1 + partial Task 2, cut off by usage limit; continuation: Task 2 completion + Task 3 closeout, ~75 min active)
- **Started:** 2026-09-14 ~11:57 (after 90fddcb)
- **Completed:** 2026-09-14 ~19:15
- **Tasks:** 3 (Task 1 prior session; Tasks 2-3 continuation)
- **Files modified:** 15 (14 in the Task-2 commit + observations.json dataset refresh in the tracking commit)

## Accomplishments
- All seven D-28 injection cases green as `pnpm test:resilience` (7/7 files, 242s), each also proven standalone; the suite drives the REAL dist/worker.js bundle against the exclusively-held 5453/6390 docker stack (D-29/D-30)
- Two genuine production defects surfaced by the injections and fixed: (1) the worker process CRASHED during a Postgres outage (unlistened Pool 'error' event on idle-client 57P01 termination — fail-stay-up violated); (2) the Postgres breaker NEVER OPENED during a real outage (drizzle's DrizzleQueryError wrapper hides the pg error; the classifier saw neither errno nor severity and logged verdict:"target" for the whole outage window)
- D-33 dataset captured (observations.json): enqueue->OPEN timing, open-window/recovery timings, consecutive-failure count at open, backlog drop counts, redelivery latency — ready for the 04-09 deploy record to cite
- Staleness display pinned (D-34 dispositioned): the codebase has no relative "Xm ago" surface — the test pins the raw toLocaleTimeString rendering + "Never" ternary on all three named surfaces (Dashboard.tsx, MonitorDetails.tsx, PublicStatus.tsx) plus a behavioral render of a 10-minute-old timestamp
- `pnpm verify` green and unchanged (exit 0; 30 files/249 tests + build + api e2e) — the D-31 split holds: resilience cases run only via the separate command

## Task Commits

Each task was committed atomically:

1. **Task 1: resilience harness** - `72d62fc` (feat) — separate vitest config, test:resilience script, D-30 stack guard, real-bundle spawnWorker (prior session)
2. **Task 2: seven injection cases + staleness test + seam fixes** - `5e5a654` (test)
3. **Task 3: full verify gate** - `5e5a654` covers the gate-driven fixes (lint/typecheck/poisoning); the verify run itself is a gate, not a commit

**Plan metadata:** this SUMMARY + STATE/ROADMAP tracking commit follows.

## Files Created/Modified
- `tests/resilience/duplicate-delivery.test.ts` - Case 1: one epoch's duplicate deliveries produce exactly one ping row (inherited file, schema-fixed)
- `tests/resilience/kill-mid-job.test.ts` - Case 2: env-gated SIGKILL past the Tier 1 commit; stalled redelivery; exactly-once counters (inherited file, schema + REPO_ROOT fixed)
- `tests/resilience/postgres-down.test.ts` - Case 3: retry-not-lost, breaker OPEN in /metrics.json, gate refusal, exactly-once recovery, OPEN->HALF_OPEN->CLOSED (inherited file, schema + typing fixed)
- `tests/resilience/redis-down.test.ts` - Case 4: pause-by-design, no fallback scheduler, rows intact (inherited file, schema + lint fixed)
- `tests/resilience/lock-loss.test.ts` - Case 5 (new): admin DEL at checkpoints.beforeReverify -> abort with zero PG effects; contrast leg lands the transition exactly once
- `tests/resilience/redis-restart.test.ts` - Case 6 (new): docker restart of the Redis container mid-run; boot re-upsert proves exactly one tick scheduler; TTL expiry proof; next_check_at re-claim
- `tests/resilience/backlog-flood.test.ts` - Case 7 (new): raw routine flood above the cap; real gate drops with counter=1; transition admitted ungated at priority 1 and completed by the real worker while the backlog sat in queue
- `tests/resilience/observations.json` - D-33 dataset (appended per run by recordObservations)
- `tests/staleness-display.test.ts` - D-34 pin (new): surface inventory + ternary source-pins + behavioral render
- `src/worker/engine/check.ts` - D-29 TEST-ONLY crash hook (env-gated) + checkpoints.beforeReverify seam (plan-directed; files_modified omission — see deviations)
- `src/worker/breaker.ts` - cause-chain classification fix (see deviations #1)
- `src/worker/db.ts` - Pool 'error' listener (see deviations #2)
- `tests/resilience/helpers/worker-process.ts` - wildcarded QUEUE_KEY_PATTERNS + idle-client error shield (see deviations #4)
- `tests/worker/engine-check.test.ts` - flushKeyPattern glob fix (see deviations #5)
- `vitest.config.ts` - resilience excluded from the main suite (see deviations #3)

## Decisions Made
- Resilience cases assert marker/log contracts via source-pins + counters instead of stdout capture: pino binds its write path at logger creation, so module-scope loggers (engine baseLog, backlog logger) are invisible to a later process.stdout spy (proven empirically); tests/worker/queues.test.ts already unit-pins the BACKLOG_DROP marker with the injectable logger
- postgres-down and backlog-flood use the process-split proof (established 04-08 precedent): gate verdicts driven in-process through the REAL enqueue helpers; processing/lifecycle legs in the spawned child — identical code, only the process differs
- redis-restart documents the redis:8-alpine STOCK persistence posture (RDB defaults, no AOF/volume): restart-survivor state is indeterminate BY DESIGN; the case proves the RES-05 recovery contract (boot re-upsert + TTL + re-claim), not persistence invariants the image cannot provide
- kill-mid-job asserts pings===2 after redelivery (evidence parity: one ping per delivery) while counters stay exactly-once via the conditional UPDATE — the crash hook fires after applyTransition COMMIT and before the processor return

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Breaker never opened during a real Postgres outage (drizzle cause-chain blindness)**
- **Found during:** Task 2 (postgres-down case; isolated via a scratch reproduction script, since deleted)
- **Issue:** `isPgConnectionFailure` tested only the top-level error. Drizzle wraps every driver error in a `DrizzleQueryError` ("Failed query: ...") whose `.cause` holds the pg error — the classifier saw neither errno nor severity and classified the whole outage as `verdict:"target"` (breaker stuck CLOSED, `consecutiveFailures:0` for 45s while the container was stopped). ssrf.ts's isInfraFailure DOES unwrap but (correctly for the HTTP side) treats ECONNREFUSED-class codes as target.
- **Fix:** breaker.ts classification split into a per-level shape test walked over an 8-deep, cycle-guarded cause chain (mirroring ssrf.ts rootCause). On the worker-DB call-context (module-header contract: only pg-path escapes are fed here), errno-class socket codes classify infra regardless of message form ("read ECONNRESET", pg's CONNECTION_TIMEOUT wrapper). ONE exception preserves the WRK-05 unit pin: ENOTFOUND stays connect-message-gated — a bare `getaddrinfo ENOTFOUND` (a checked website's NXDOMAIN leaking in) remains target; `connect ENOTFOUND <db-host>:<port>` (our DB connect) is infra. tests/worker/breaker.test.ts unchanged and green (11/11).
- **Files modified:** src/worker/breaker.ts
- **Verification:** postgres-down case green (breaker OPEN in /metrics.json, gate refusal, exactly-once recovery, CLOSED); breaker unit suite 11/11; full verify green
- **Committed in:** 5e5a654 (Task 2 commit)

**2. [Rule 2 - Missing Critical] Worker process crashed during a Postgres outage (unlistened Pool 'error' event)**
- **Found during:** Task 2 (postgres-down case)
- **Issue:** When the db container stops, every IDLE pooled client receives a backend termination (57P01); node-postgres re-emits it on the Pool. An unlistened 'error' event on an EventEmitter THROWS — the spawned worker died mid-outage, killing the very retry machinery RES-01 exists to provide (fail-stay-up violated). The same shape crashed bare test-process Clients ("Client has encountered a connection error").
- **Fix:** `workerPgPool.on("error", ...)` logging err.message only (secrets rule); the harness's connectPg() attaches a no-op shield (query-only clients fail loudly on next use).
- **Files modified:** src/worker/db.ts, tests/resilience/helpers/worker-process.ts
- **Verification:** postgres-down case: worker stayed alive through the whole outage (`[worker-db] idle pool client error: terminating connection...` logged, no crash) and completed the recovery leg
- **Committed in:** 5e5a654 (Task 2 commit)

**3. [Rule 3 - Blocking] Resilience cases nearly ran inside pnpm verify (D-31 near-violation)**
- **Found during:** Task 2 (before first full-suite run)
- **Issue:** the main vitest include `tests/**/*.test.ts` matched tests/resilience/** — the injection cases (container stop/start, spawned children, ~4 min) would have blown verify's ≤5-min budget (D-27) and violated the exclusive-stack ownership contract (D-30).
- **Fix:** vitest.config.ts exclude adds `tests/resilience/**` (default excludes restated — overriding replace vitest defaults).
- **Files modified:** vitest.config.ts
- **Verification:** `pnpm test` runs 30 files/249 tests without resilience; `pnpm test:resilience` runs exactly the 7 case files
- **Committed in:** 5e5a654 (Task 2 commit)

**4. [Rule 1 - Bug] Harness SCAN patterns were glob no-ops (stale queue state leaked across runs)**
- **Found during:** Task 2 (backlog-flood depth 9 vs 8 — a stale active-set job from the prior executor's aborted session)
- **Issue:** QUEUE_KEY_PATTERNS entries like `"bull:monitor-checks:"` match only a key literally named that — SCAN MATCH without the trailing `*` deletes nothing; stale job hashes and active/prioritized members survived case boundaries.
- **Fix:** wildcarded all patterns (`bull:monitor-scheduler:*` etc.). The SAME bug existed in tests/worker/engine-check.test.ts beforeEach (`flushKeyPattern("bull:monitor-checks:")`) — found later when full verify runs failed test 2 with a poisoned FIFO capture (see #5).
- **Files modified:** tests/resilience/helpers/worker-process.ts, tests/worker/engine-check.test.ts
- **Verification:** backlog-flood depth exact; engine-check 9/9 standalone and inside the full suite
- **Committed in:** 5e5a654 (Task 2 commit)

**5. [Rule 1 - Bug] engine-check captureLane poisoned by stale check jobs from other suites (verify-gate failure)**
- **Found during:** Task 3 (verify gate: engine-check test 2 failed inside full runs while passing standalone — twice)
- **Issue:** Other suites legitimately add raw check jobs without draining them (queue-gate tests); engine-check's beforeEach flush patterns were glob no-ops (#4's twin), so a leftover job survived. captureLane consumes FIFO: the stale job processed FIRST as `noop-monitor-missing` (its monitor was truncated) and hijacked `nextResult()`; the expect threw, the lane closed with the fresh job still pending, perpetuating the poison into the next run (traced via the jobId epoch: the poisoning job was enqueued 65s before the run started). Root enabling factors: TRUNCATE does not reset serial sequences and afterAll does not flush queue keys.
- **Fix:** wildcarded the three bare prefixes in engine-check's beforeEach (same fix class as #4; maintenance.test.ts already used the correct form).
- **Files modified:** tests/worker/engine-check.test.ts
- **Verification:** engine-check 9/9; Redis verified clean of leftover check job hashes after the run; full vitest 30 files/249 tests green; full verify exit 0
- **Committed in:** 5e5a654 (Task 2 commit, amended during the Task-3 gate)

**6. [Rule 1 - Bug] Inherited case files used wrong schema columns + path depth**
- **Found during:** Task 2 validation of the prior executor's four uncommitted case files (never run before this session)
- **Issue:** pings/incidents columns are camelCase quoted `"monitorId"` (not monitor_id); the outbox table is `outbox` with snake `monitor_id` (not alert_outbox) — verified via information_schema. kill-mid-job's REPO_ROOT used three ".." for a two-deep file (ENOENT on the source-pin read). postgres-down's `outcomes` array was implicitly any[] (typecheck gate).
- **Fix:** corrected column names in all five affected case files; REPO_ROOT to two ".."; explicit `Awaited<ReturnType<typeof enqueueClaimedCheck>>[]` typing; three prefer-const lint fixes.
- **Files modified:** tests/resilience/{duplicate-delivery,kill-mid-job,postgres-down,redis-down}.test.ts
- **Verification:** all cases green standalone; lint + typecheck gates pass
- **Committed in:** 5e5a654 (Task 2 commit)

**7. [Plan documentation] files_modified omission: src/worker/engine/check.ts**
- **Found during:** continuation start (uncommitted WIP disposition — the FIRST mandated action)
- **Issue:** The plan's Task 2 action text, threat model (T-04-30 env-gate), and key_links DIRECT the crash hook in engine/check.ts, but the file is absent from files_modified. The prior executor's uncommitted WIP was exactly that seam.
- **Disposition:** KEPT — the WIP matched the plan-directed hook verbatim (env-gated WORKER_TEST_CRASH_AFTER check + writeSync marker + SIGKILL, placed after applyTransition COMMIT / before the processor return) plus the checkpoints.beforeReverify injection seam. Committed as part of Task 2; documented here as the omission.
- **Committed in:** 5e5a654

---

**Total deviations:** 6 auto-fixed (3 Rule 1 bugs, 1 Rule 2 missing-critical, 1 Rule 3 blocking, 1 gate-driven lint/type fix batch) + 1 documented files_modified omission
**Impact on plan:** Two of the fixes are PRODUCTION defects the suite existed to catch (worker crash mid-outage; breaker that could never open) — the injection discipline worked as designed. No scope creep; no behavior change outside the pg-error classification contract.

## Issues Encountered
- Prior executor was cut off by a usage limit mid-Task-2 (four complete-but-never-run inherited case files + the check.ts seam WIP). Continuation validated each inherited file by reading + running, fixed latent schema/path bugs (#6), then authored the three missing cases (lock-loss, redis-restart, backlog-flood) around the engine's real seams and the staleness test.
- The scratch reproduction script used to isolate deviation #1 (scripts/zz-debug-pgdown.mjs) was deleted before the Task-2 commit; each debug iteration restored the docker stack (fail-loud finally discipline).
- verify gate required three iterative fix rounds (lint prefer-const -> typecheck implicit-any -> the #5 poisoning); each fix was amended into the single atomic Task-2 commit, and the final full verify exited 0.
- observations.json gains entries whenever a case reruns (recordObservations appends); the post-commit gate reruns refreshed it — the updated dataset rides in the tracking commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- 04-09 (rehearsal + dark-launch deploy record) can cite tests/resilience/observations.json directly (D-33): breaker enqueueToOpenMs/outageToRecoveredMs/closedRecoveryMs, backlog drop counts, kill-mid-job redelivery latency
- The D-31 split is proven end-to-end: verify stays ~19s (regular suite), test:resilience runs 242s standalone with exclusive stack ownership
- Both production fixes (breaker classification, pool error handler) are covered by green tests in BOTH suites (breaker.test.ts 11/11 unchanged; postgres-down injection green)

## Self-Check: PASSED

- Commit 5e5a654 (Task 2 + gate fixes): FOUND
- Commit 72d62fc (Task 1 harness): FOUND
- tests/resilience/{duplicate-delivery,kill-mid-job,postgres-down,redis-down,lock-loss,redis-restart,backlog-flood}.test.ts: all FOUND
- tests/staleness-display.test.ts: FOUND
- tests/resilience/observations.json: FOUND
- pnpm test:resilience latest full run: 7/7 files, 7/7 tests PASS
- pnpm verify (NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007): EXIT 0

---
*Phase: 04-monitoring-worker-build-dark-launch*
*Completed: 2026-09-14*
