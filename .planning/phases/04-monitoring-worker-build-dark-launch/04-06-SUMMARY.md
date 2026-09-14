---
phase: 04-monitoring-worker-build-dark-launch
plan: 06
subsystem: worker-engine
tags: [check-processor, circuit-breaker, tier-routing, lane-workers, wrk-01, wrk-05, res-01, d-33, pattern-6, flush-job, dark-launch]

# Dependency graph
requires:
  - phase: 04-monitoring-worker-build-dark-launch
    provides: the SSRF check pipeline performCheck + WRK-05 classification contract + isInfraFailure (04-03) — consumed verbatim as the processor's fetch leg
  - phase: 04-monitoring-worker-build-dark-launch
    provides: per-monitor lock + TTL/3 renewal + isStillOwner (04-04, locks.ts) — acquired/renewed/re-verified by the processor
  - phase: 04-monitoring-worker-build-dark-launch
    provides: Tier 1 applyTransition (04-04) and Tier 2 stageResult/flushMonitor/flushDueMonitors/makeBatchId/FLUSH_CADENCE_MS (04-05) — the two persistence legs
  - phase: 04-monitoring-worker-build-dark-launch
    provides: six-lane queue topology + enqueue helpers + LANE_PRIORITY + backlog gate (04-02, 04-01) — extended with the breaker gates and lane worker starters
provides:
  - processCheckJob(job, deps) — the WRK-01 check processor: row-authoritative url load (T-04-22), per-monitor lock with whole-lifetime renewal, WRK-05 classification, Tier 1 (re-verify + applyTransition) / Tier 2 (stageResult + guarded flush enqueue) routing, breaker accounting on every escape
  - makeFlushProcessor() — the dbWrites-lane consumer: name dispatch ("flush" -> flushMonitor with the data-carried batchId; "flush-sweep" -> flushDueMonitors), loud on unknown names/malformed data
  - src/worker/breaker.ts — the RES-01/D-33 in-process Postgres circuit breaker: 5-fail/60 s, HALF_OPEN single-flight write_guards probe (breaker:probe:{ts}, ON CONFLICT DO NOTHING), enqueue-side gating ONLY (canEnqueue — never queue.pause, Pattern 6), recordResult single-sourced WRK-05 classification + pg-connection extension, restart resets CLOSED (01-03)
  - Breaker gates wired into queues.ts — addCheckJob throws BreakerOpenError; enqueueClaimedCheck pre-gates to a NO-rollback skip (claims stay advanced, §14.4); enqueueManualCheck throws (the API 503 path); the flush enqueue in check.ts skips with the sweep as backstop
  - startCheckLaneWorker/startDbWritesLaneWorker (concurrency 10/5, own blocking connections, stalled->noteStalledEvent) registered as drainables in index.ts; breaker state rides /metrics.json via the index.ts queueMetrics provider
  - FLUSH_SWEEP_SCHEDULER_ID "tier2-flush-sweep" — the §16.2 cadence driver on the dbWrites lane behind the D-16 flag
affects: [04-07, 04-08, 04-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Enqueue-side breaker gating (Pattern 6): canEnqueue() is the ONLY gate surface — no queue.pause anywhere (a paused queue would also block operator smoke enqueues, Pitfall 12); in-flight jobs drain and finish their bounded attempts while OPEN"
    - "Skip-vs-throw gate semantics: enqueueClaimedCheck's breaker refusal is a SKIP with NO J-1 rollback (claims stay advanced per §14.4 — a rollback storm against a dead DB only adds write pressure), while enqueueManualCheck/addCheckJob THROW BreakerOpenError (the API maps it to 503)"
    - "3-segment jobId discipline extended to the flush lane: flush:{monitorId}:{epochMs}; the batchId {epochMs}:{monitorId} contains its own colon and therefore rides job DATA (04-05 redelivery-determinism contract: never minted inside the processor)"
    - "Derived HALF_OPEN breaker state: the internal phase records only CLOSED/OPEN; an OPEN whose window elapsed READS HALF_OPEN and the next canEnqueue runs the single-flight probe — concurrent gate callers share one in-flight probe write"

key-files:
  created:
    - src/worker/breaker.ts
    - src/worker/engine/check.ts
    - tests/worker/breaker.test.ts
    - tests/worker/engine-check.test.ts
  modified:
    - src/worker/queues.ts
    - src/worker/scheduler.ts
    - src/worker/index.ts

key-decisions:
  - "Tier classification predicate: Tier 1 iff outcome.kind === 'down' || monitor.status !== 'UP' || manual; Tier 2 ONLY for routine UP on an UP monitor — routes UP-on-DOWN (RECOVERED), UP-on-PENDING (first_check), unchanged DOWN, and manual UP-on-UP (synchronous evidence ping for the enqueue-and-poll UX) through the Tier 1 transaction, mirroring stageResult's UP-only contract exactly"
  - "Breaker classification is single-sourced through recordResult: isInfraFailure (src/lib/ssrf.ts) PLUS a pg-connection extension (connect-phase errno codes with /^connect\\s/ messages, pool termination/timeout phrases, server-sent severity/routine shapes) — the same errno is TARGET class on the HTTP path and infra on the worker Postgres path, per the documented call-context contract (recordResult is fed only worker-Postgres-path escapes)"
  - "Breaker in /metrics.json wired via the index.ts queueMetrics provider (breaker: breakerState()) — health.ts itself untouched; trivially local as the plan allowed"
  - "J-1 rollback vs breaker-gate skip kept distinct: enqueue REJECTION (add throws) rolls next_check_at back one interval; breaker refusal leaves claims advanced — the §14.4 posture transcribed literally"
  - "The manual UP-on-UP non-transition commits its evidence ping with applied:false and counters unchanged — DAT-04's conditional-UPDATE semantics give the manual poll UX its synchronous answer without double-counting"

requirements-completed: [WRK-01, WRK-05, WRK-12, RES-01]

# Coverage metadata (#1602)
coverage:
  - id: T1
    description: "WRK-01 check processor: lock-acquire -> renewal -> fetch -> classify -> Tier 1 (re-verify + transaction) / Tier 2 (stage + flush enqueue), missing/inactive/lock-held no-ops, abort-on-loss"
    requirement: WRK-01
    verification:
      - kind: integration
        ref: "tests/worker/engine-check.test.ts#2,3,4,5,6,7 (real docker Postgres+Redis, real BullMQ lane worker, 04-03 fixture server)"
      status: pass
    human_judgment: false
  - id: T2
    description: "WRK-05 exercised end-to-end: target outcomes (UP, DOWN http_5xx, first_check) complete as successful jobs; only infra failures reject for BullMQ retry"
    requirement: WRK-05
    verification:
      - kind: integration
        ref: "tests/worker/engine-check.test.ts#2,3,4,7 (successful target-outcome jobs), #8 (infra reject + breaker count)"
      status: pass
    human_judgment: false
  - id: T3
    description: "RES-01 circuit breaker: 5-fail/60 s pins, enqueue-side gating only (no pause), HALF_OPEN write_guards probe with fresh-window re-open, WRK-05 classification single-sourcing, restart-reset semantics"
    requirement: RES-01
    verification:
      - kind: integration
        ref: "tests/worker/breaker.test.ts#1-11 (real Postgres probe case + fake-clock windows + single-flight), tests/worker/engine-check.test.ts#8 (processor accounting)"
      status: pass
    human_judgment: false
  - id: T4
    description: "Lane workers + priorities honored: check lane concurrency 10, dbWrites 5, flush job priority 5 with delay inside the 60 s cadence, explicit priorities on every enqueue (WRK-12 invariant preserved by addCheckJob's refusal)"
    requirement: WRK-12
    verification:
      - kind: integration
        ref: "tests/worker/engine-check.test.ts#1 (source pins), #2 (flush job priority/delay/attempts asserted on the stored job)"
      status: pass
    human_judgment: false

# Metrics
duration: ~15 min (900s) single session
completed: 2026-09-14
status: complete
---

# Phase 4 Plan 6: Check Job Processor + Circuit Breaker Summary

**The WRK-01 check processor composing 04-03's SSRF fetch, 04-04's locks and Tier 1, and 04-05's Tier 2 behind the WRK-05 never-throw classification, plus the RES-01/D-33 in-process Postgres breaker gating enqueues (never queue.pause) — 20 new proof cases green on the real docker stack, full verify chain green end-to-end including the D-18 dark-launch shape (one ping row appears with the scheduler off)**

## Session Notes

Single-session sequential execution after a prior dispatch was cut by a usage limit before any changes. Task 1 (breaker + suite) landed green on its first run. Task 2's first suite run failed two test-authoring issues (a source-pin regex window too narrow for the module's real layout; a denylist pin matching prose in comments) and one transient case-2 result capture that passed on every subsequent run — fixed/verified before any commit. Full `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm verify` green end-to-end (lint, typecheck, full vitest suite incl. scheduler-flag regression check, schema:gate, worker:boundary, Next build + tsup worker bundle 79.62 KB, 18/18 e2e).

## Performance

- **Duration:** ~15 min (900s)
- **Started/Completed:** 2026-09-14T05:04:01Z → 2026-09-14T05:19:00Z
- **Tasks:** 2/2
- **Files:** 5 (4 created, 3 modified — all inside the plan's files_modified list)

## Accomplishments

- **RES-01 (breaker):** `src/worker/breaker.ts` — 5 consecutive infra failures open the gate for 60 s; HALF_OPEN admits exactly one single-flight probe (`INSERT INTO write_guards (key) VALUES ('breaker:probe:{ts}') ON CONFLICT DO NOTHING`, §13.3's reserved prefix); probe success closes, failure re-opens a FRESH window (§13.9); in-process state with restart-reset to CLOSED (01-03); `canEnqueue()` is the only gate surface — no queue reference, no pause call (Pattern 6, structurally pinned)
- **WRK-05 completion leg:** `recordResult` single-sources classification — `isInfraFailure` from src/lib/ssrf.ts plus the pg-connection class; target DNS/abort escapes never count; the engine suite proves target outcomes complete as successful jobs while infra rejects for BullMQ retry
- **WRK-01 (processor):** `processCheckJob` runs the §15.1 sequence — child logger (ids/timings only, T-04-24), row-authoritative url load (T-04-22: job data carries monitorId and nothing else), per-monitor lock + whole-lifetime TTL/3 renewal, fetch, tier routing, teardown (renewal stop + owner-only release in finally). Missing/inactive monitors and held locks are successful no-ops; ownership loss before the Tier 1 commit aborts with zero writes (T-04-21)
- **Tier routing:** every non-UP outcome, every non-UP monitor status, and every manual job take Tier 1 (transition transaction with incident/outbox artifacts proven live: 1-strike DOWN with `Monitor went down. Status code: 500`, PENDING->UP first_check, manual UP-on-UP synchronous evidence ping); routine UP on an UP monitor stages to Redis and enqueues the guarded flush (priority 5, 30 s delay inside the 60 s cadence, batchId minted at enqueue and carried in job data)
- **Gates:** `addCheckJob` throws `BreakerOpenError` while OPEN; `enqueueClaimedCheck` pre-gates to a no-rollback skip (claims stay advanced, §14.4); `enqueueManualCheck` throws (the future API 503 path); the flush enqueue skips with the sweep as backstop — all four refuse WITHOUT J-1 rollbacks except the add-rejection path that keeps its original rollback
- **Lane workers + boot wiring:** `startCheckLaneWorker`/`startDbWritesLaneWorker` (concurrency 10/5, dedicated blocking connections, stalled events counted) registered as drainables in index.ts; the dbWrites consumer dispatches "flush"/"flush-sweep" by name and is loud on anything else; breaker state rides /metrics.json via the index.ts provider
- **D-18 proof (code level):** engine-check case 2 enqueues through the real helper, runs the real check-lane worker with ZERO Job Schedulers present (`getJobSchedulers()` toEqual []), and watches exactly one ping row appear after the flush processor applies — the plan's manual-smoke acceptance, proven as an automated case

## Task Commits

1. **Task 1: circuit breaker module + suite** — `6e3fe5c` (feat)
2. **Task 2: processor + lane wiring + suite** — `31bb9b2` (feat)

## Files Created/Modified

- `src/worker/breaker.ts` — BREAKER_THRESHOLD/BREAKER_OPEN_MS/BREAKER_GATE_MARKER, BreakerOpenError, state()/canEnqueue()/probe()/recordInfraFailure()/recordSuccess()/recordResult(), setBreakerClock/resetBreaker test seams, PG_INFRA_CODES + isPgConnectionFailure, single-flight halfOpenProbe
- `src/worker/engine/check.ts` — FLUSH_JOB_DELAY_MS, CheckJob/fromLaneJob, ProcessCheckDeps (db/performCheck/dbWritesQueue/checkpoints), CheckJobResult, processCheckJob + runCheckJob, enqueueFlushJob, makeFlushProcessor
- `src/worker/queues.ts` — flushJobId, breaker gates in addCheckJob/enqueueClaimedCheck/enqueueManualCheck, CheckEnqueueOutcome.breakerGated, CHECK_LANE_CONCURRENCY/DB_WRITES_LANE_CONCURRENCY, LaneJob/LaneProcessor/LaneWorkerHandle, startLaneWorker/startCheckLaneWorker/startDbWritesLaneWorker
- `src/worker/scheduler.ts` — FLUSH_SWEEP_SCHEDULER_ID + the tier2-flush-sweep upsert on the dbWrites lane inside the D-16-gated branch
- `src/worker/index.ts` — check/dbWrites lane registration as drainables; queueMetrics provider merges `breaker: breakerState()`
- `tests/worker/breaker.test.ts` — 11 cases (source pins, threshold/window/consecutive semantics, real-Postgres probe, fresh-window re-open, WRK-05 classification matrix, single-flight, restart reset, probe-resolves-false)
- `tests/worker/engine-check.test.ts` — 9 cases over the real stack + fixture server

## Decisions Made

See key-decisions in the frontmatter. The load-bearing ones for downstream plans:

- 04-08's alert relay consumes the outbox rows exactly as this processor's Tier 1 writes them (incident.down/recovered/first_check with CR-03 non-null incident ids) — extend, never rename
- 04-09's dark launch starts the worker with consumers live and zero schedulers; the operator smoke path is `enqueueManualCheck` (priority 1, synchronous evidence ping) — a BreakerOpenError from it means Postgres is down, map to 503
- The breaker's /metrics.json key is `breaker` (`{state, consecutiveFailures, openSince}`) — 04-07's health/heartbeat collector reads it additively

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking placement] flush sweep registered on the dbWrites lane, not the maintenance lane**
- **Found during:** Task 2 — the plan's action text says "flush sweep in scheduler behind D-16 flag" with prose placing it on the maintenance tick
- **Issue:** the maintenance lane has NO consumer until 04-07, and scheduler-flag.test.ts pins the maintenance queue's scheduler count at exactly one — a sweep on a consumer-less lane cannot run and would break the pinned count
- **Fix:** `FLUSH_SWEEP_SCHEDULER_ID` upserted on the dbWrites queue (the lane whose consumer dispatches flush-sweep), `{every: FLUSH_CADENCE_MS}`, priority 5, behind the same schedulerEnabled flag; scheduler-flag suite re-run green (its per-queue assertions never touch dbWrites)
- **Files modified:** src/worker/scheduler.ts
- **Verification:** tests/worker/scheduler-flag.test.ts 5/5; engine-check case 9 dispatch
- **Committed in:** 31bb9b2

**2. [Rule 1 - rejected jobId form] flush jobId resolved to a 3-segment shape with the batchId in job data**
- **Found during:** Task 2 design — the plan's "jobId flush:{monitorId}:{batchId placeholder}" embeds batchId `{epochMs}:{monitorId}` wholesale, a 4-segment colon jobId BullMQ 6 rejects in Job.validateOptions
- **Fix:** `flushJobId(monitorId, passEpochMs)` = `flush:{monitorId}:{passEpochMs}` (3 segments, exported next to its sibling builders); the full batchId rides job DATA minted at enqueue time — preserving the 04-05 redelivery-determinism contract (never minted inside the processor); engine-check case 2 pins batchId === the jobId's own epoch segment
- **Files modified:** src/worker/queues.ts, src/worker/engine/check.ts
- **Committed in:** 31bb9b2

**3. [Plan-sanctioned resolution] breaker health exposure wired via index.ts, health.ts untouched**
- The plan offered "expose state+openSince to the health collector only if trivially local — otherwise note for 04-07"; it was trivially local: the existing queueMetrics provider in index.ts merges `breaker: breakerState()` into /metrics.json (health.ts already merges any provider keys). Documented as a resolution, not a fix.

---

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking placement, 1 Rule 1 rejected-jobId resolution) + 1 plan-sanctioned resolution. No scope creep: every change lands inside the plan's files_modified list.

## Issues Encountered

- Task 2's first suite run failed on test-authoring bugs fixed pre-commit: the T-04-21 ordering pin's regex window (200 -> 600 chars) and the denylist pin matching prose in comments (now matches only the property-assignment form `denylist:`)
- One transient case-2 failure (a captured lane result arriving for a job outside the case's own enqueue) passed on every subsequent run and in the full-suite verify — per-case SCAN/DEL hygiene of bull:monitor-checks:/db-writes:/monitor-scheduler: keys is retained as the guard
- `pnpm test -- <file>` still passes the `--` through and runs the whole suite — `npx vitest run <file>` used for isolation (04-04/04-05 learning)

## User Setup Required

None.

## Threat Flags

None — no security-relevant surface beyond the plan's threat_model. Register rows all mitigated in this plan's code/tests: T-04-21 (isStillOwner re-verify immediately before the Tier 1 commit; abort proven live), T-04-22 (url from the monitors row — structurally pinned: job data is mined for monitorId only), T-04-23 (breaker gates live on every enqueue door), T-04-24 (log bindings carry ids/timings/outcomes only — never URLs or bodies).

## Self-Check: PASSED

All four created files exist on disk; both task commits (6e3fe5c, 31bb9b2) present in git log.
