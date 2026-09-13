---
phase: 04-monitoring-worker-build-dark-launch
plan: 02
subsystem: infra
tags: [bullmq, job-schedulers, upsertJobScheduler, priorities, claim-transaction, skip-locked, backlog-cap, dark-launch-flag, queue-metrics, dlq]

# Dependency graph
requires:
  - phase: 04-monitoring-worker-build-dark-launch
    provides: bootable worker entry (src/worker/index.ts), health server with /readyz + /metrics.json skeleton, workerConnection/workerDb singletons, drain registration + shutdown path
provides:
  - Six-lane BullMQ 6 queue topology (scheduler/checks/db-writes/alerts/maintenance/email) over ONE shared producer connection, with explicit-priority-only enqueue helpers (addCheckJob refuses missing priority — Pitfall 3/WRK-12)
  - enqueueClaimedCheck(row) / enqueueManualCheck(monitorId) with idempotency jobIds (check:{monitorId}:{epoch-seconds} from the claim RETURNING; check-manual:{monitorId}:{epochMs} per-enqueue-unique)
  - claimDue(batchSize) — §14.3 claim as ONE transaction, CTE-scoped FOR UPDATE SKIP LOCKED, D-50 GREATEST catch-up-safe advance, RETURNING (id, status, next_check_at)
  - J-1 failed-enqueue compensation (rollbackFailedClaim rolls next_check_at back one interval on add() rejection)
  - Backlog gate (openBacklogGate) dropping routine priority-10 enqueues above ~2x active monitors, depth counted over wait+prioritized+delayed+active, BACKLOG_DROP greppable marker + process counter (RES-02)
  - src/worker/scheduler.ts — processTick (claim -> lane assignment -> gated enqueues), startTickWorker (always-live consumer, concurrency 1, stalled config pinned), upsertSchedulersAtBoot gated by WORKER_SCHEDULER_ENABLED (check-tick every 30 s + maintenance-cleanup 03:15 UTC dry-run; boot-idempotent; NO queue pausing — Pitfall 12)
  - /metrics.json queue section: per-lane depth (incl. prioritized), oldest-pending age (bounded wait+prioritized head scan), per-process stalled counters, backlog drop counter (OBS-01 subset)
  - Lane priority constants (LANE_PRIORITY) + CHECK_JOB_OPTIONS (attempts 5, exponential 2000 ms, removeOnComplete age 1 h, removeOnFail age 14 d)
affects: [04-03, 04-04, 04-05, 04-06, 04-07, 04-08, 04-09, phase-05-worker-cutover]

# Tech tracking
tech-stack:
  added: [] # no new deps — bullmq/pino/ioredis landed in 04-01
  patterns:
    - "Dark-launch flag gates SCHEDULING only (skip the upsertJobScheduler calls), never queue.pause — consumers stay live for operator smoke enqueues (D-16/Pitfall 12, source-form pinned by test)"
    - "upsertJobScheduler at every boot with a stable scheduler id — idempotent convergence to exactly one scheduler per id (RES-05); templates never pin a custom jobId (Pitfall 11)"
    - "Empirical bullmq 6.3 discipline: a priority-carrying job is filed in the PRIORITIZED set, never plain wait — EVERY depth read (metrics gauge AND backlog gate) must include counts.prioritized, else the check lane reads empty while it backs up"
    - "One backlog gate per tick: verdict + inputs cached for the gate's lifetime (one depth read + one active-monitor count per tick); fail-open on depth-read error"
    - "Per-tick lane assignment derives from the claim's OWN RETURNING row (status -> lane, next_check_at -> jobId epoch) — never a second read"
    - "JobSchedulerJson identity field is `key` (bullmq 6) — the optional `id` is the delayed job's id and is absent until materialized"

key-files:
  created:
    - src/worker/scheduler.ts
    - tests/worker/scheduler-flag.test.ts
  modified:
    - src/worker/queues.ts
    - src/worker/claim.ts
    - src/worker/backlog.ts
    - src/worker/health.ts
    - src/worker/index.ts
    - docs/ARCHITECTURE-AUDIT.md
    - tests/worker/queues.test.ts
    - tests/worker/claim.test.ts
    - tests/worker/retries.test.ts

key-decisions:
  - "Manual-check jobId form is check-manual:{monitorId}:{epochMs} (3 colon segments), not the planned check:{monitorId}:manual:{epochMs} — BullMQ 6 REJECTS colon-containing jobIds that do not split into exactly 3 parts (Job.validateOptions); 01-08 per-enqueue-unique semantics preserved via a strictly monotonic epoch token"
  - "Queue depth reads include the PRIORITIZED set everywhere (metrics gauge + backlog gate) — bullmq 6.3 files priority-carrying jobs there and all check-lane jobs carry one; a wait-only read makes RES-02's cap untrippable (Rule 1 fix, commit 2984f81)"
  - "Scheduler-record identity asserted via JobSchedulerJson.key, not .id — the optional id is the delayed job's id, absent until materialized (empirical probe against test Redis)"
  - "OBS-01 and WRK-10 deliberately NOT marked complete — this plan delivers the OBS-01 depth/age/stalled subset (transition->alert latency lands in 04-07 'metrics completion') and the WRK-10 flag MECHANIC (the deployed/rehearsed dark launch is 04-09); false-signal precedent 02-03/03-02"
  - "Tick worker concurrency 1 with lockDuration/stalledInterval 30000 + maxStalledCount 1 — a re-executed tick is a no-op because the claim transaction already advanced every row it returned"
  - "Maintenance scheduler ships now (daily 03:15 UTC, dryRun true template) with its processor landing in 04-07 — the job may sit in the lane until then; acceptable per plan, cleaned in tests"

patterns-established:
  - "Pattern: flag-gated recurring scheduling — upsertJobScheduler only when schedulerEnabled, consumers unconditional (Pitfall 12 source-form test guards the absence of .pause( in scheduler.ts + index.ts)"
  - "Pattern: prioritized-set-aware depth reads — any future BullMQ depth/age computation must count wait+prioritized (pin: tests/worker/queues.test.ts test 8, real-queue)"
  - "Pattern: per-tick gate object threading — openBacklogGate({checksQueue}) created once per tick and passed through every enqueueClaimedCheck call"

requirements-completed: [WRK-02, WRK-03, WRK-06, WRK-12, RES-02] # OBS-01 subset only (04-07 completes); WRK-10 mechanic only (04-09 deploys) — see Decisions

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Six-lane queue topology with explicit priorities everywhere and retry/DLQ options (WRK-02, WRK-06, WRK-12)"
    requirement: WRK-02
    verification:
      - kind: unit
        ref: "tests/worker/queues.test.ts#1-4 (priority refusal, jobId forms, J-1 rollback)"
        status: pass
      - kind: unit
        ref: "tests/worker/retries.test.ts#attempts/backoff/removeOnComplete/removeOnFail forms on real enqueued jobs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Claim transaction with D-50 GREATEST catch-up-safe advance, SKIP LOCKED concurrency exclusion, inactive monitors never claimed (WRK-03) + §14 audit amendment"
    requirement: WRK-03
    verification:
      - kind: integration
        ref: "tests/worker/claim.test.ts#on-time/stale-40min/inactive/parallel-disjoint cases on real Postgres"
        status: pass
    human_judgment: false
  - id: D3
    description: "Scheduler behind WORKER_SCHEDULER_ENABLED: flag false = zero schedulers + live consumers; flag true = exactly one per lane, idempotent re-upsert, Redis-wipe re-declare (D-16/RES-05)"
    requirement: WRK-10
    verification:
      - kind: integration
        ref: "tests/worker/scheduler-flag.test.ts#1-2,5 (real Redis, source-form pause guard)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Backlog cap dropping routine priority-10 enqueues above ~2x active monitors incl. the prioritized set; non-UP lane never gated (RES-02)"
    requirement: RES-02
    verification:
      - kind: integration
        ref: "tests/worker/queues.test.ts#5-8 (fakes + real-queue prioritized regression)"
        status: pass
    human_judgment: false
  - id: D5
    description: "/metrics.json queue section: per-lane depth, oldest-pending age, stalled counters, backlog drop counter (OBS-01 subset — transition->alert latency lands 04-07)"
    requirement: OBS-01
    verification:
      - kind: integration
        ref: "tests/worker/scheduler-flag.test.ts#4 (/metrics.json over live health server)"
        status: pass
      - kind: manual_procedural
        ref: "flag-off boot smoke: node dist/worker.js against test stack; curl /metrics.json + /readyz; getJobSchedulers() empty on both lanes"
        status: pass
    human_judgment: false

# Metrics
duration: 2 sessions (Task 3 continuation after usage-limit cutoff; this leg ~35 min incl. verify + smoke)
completed: 2026-09-14
status: complete
---

# Phase 4 Plan 2: Worker Orchestration Core Summary

**Six-lane BullMQ topology with explicit priorities, SKIP-LOCKED claim with D-50 catch-up advance, flag-gated job schedulers, prioritized-set-aware backlog cap, and /metrics.json queue gauges**

## Session Notes

This plan ran across two sessions. The first session completed Tasks 1-2 (commits 7fb02d9, 2cff5a2) and left Task 3 mid-flight as uncommitted working-tree changes — the executor was terminated by a usage-limit cutoff while diagnosing three failing scheduler-flag tests (last words: "Three issues to diagnose. Checking each."). A continuation agent resumed on the working tree, re-derived the three failures from the WIP + test output, fixed them, and closed the plan out. No work was lost; the WIP files were complete in structure and needed only the fixes below.

## Performance

- **Duration:** 2 sessions (Task 3 continuation; this leg ~35 min)
- **Started:** 2026-09-13 (session 1)
- **Completed:** 2026-09-14T02:33 local (2026-09-13T20:33Z)
- **Tasks:** 3/3
- **Files modified:** 11 (7 in session 1's commits, Task 3 + fix touched 7 with overlap)

## Accomplishments
- Queue topology transcribed from audit §14 D-12: six lanes over ONE shared producer connection, every enqueue forced through priority-refusing helpers, check-lane options (attempts 5 / exponential 2000 ms / removeOnComplete 1 h / removeOnFail 14 d) pinned and proven on real Redis
- Claim engine with the D-50 GREATEST catch-up-safe advance — a 40-minutes-stale monitor advances to now+interval in ONE claim; two parallel claim transactions proven disjoint via CTE-scoped FOR UPDATE SKIP LOCKED; §14 amended with a dated note
- Dark-launch flag mechanic exact: WORKER_SCHEDULER_ENABLED=false boots with ZERO schedulers while the tick-lane consumer still processes smoke enqueues; flag true converges on exactly one check-tick (30 s) + one maintenance-cleanup (03:15 UTC dry-run) scheduler, re-declared idempotently after a Redis wipe (RES-05); NO queue.pause anywhere (source-form test)
- Queue observability live on /metrics.json: per-lane depth (wait/prioritized/delayed/active), oldest-pending age, stalled counters, backlog drop counter — verified by test AND by a flag-off boot smoke against the test stack
- Backlog gate proven against the REAL queue: bullmq 6.3's prioritized set is now counted (both in the gate and the metrics gauge) — without it, RES-02's cap could never trip because every routine check is filed as prioritized

## Task Commits

Each task was committed atomically:

1. **Task 1: Queue topology with priorities, retry/DLQ config, backlog cap** - `7fb02d9` (feat)
2. **Task 2: Claim transaction with catch-up-safe advance + §14 amendment** - `2cff5a2` (feat)
3. **Task 3: Scheduler behind the flag, boot wiring, queue metrics** - `e90c329` (feat — continuation session)
4. **Rule 1 fix: backlog gate depth counts the prioritized set** - `2984f81` (fix — continuation session, Task-3 diagnosis byproduct)

**Plan metadata:** (see final tracking commit below)

## Files Created/Modified
- `src/worker/scheduler.ts` - processTick (claim -> lane assignment -> gated enqueues), startTickWorker (always-live consumer), upsertSchedulersAtBoot (flag-gated, boot-idempotent, no custom jobIds)
- `src/worker/queues.ts` - six-lane topology, LANE_PRIORITY/CHECK_JOB_OPTIONS constants, jobId derivation, addCheckJob priority refusal, J-1 compensation, enqueueClaimedCheck/enqueueManualCheck, collectQueueMetrics + stalled counters
- `src/worker/claim.ts` - claimDue: §14.3 claim as one transaction, CTE-scoped SKIP LOCKED, GREATEST catch-up advance, RETURNING (id, status, next_check_at)
- `src/worker/backlog.ts` - openBacklogGate (per-tick cached verdict, fail-open), countActiveMonitors, noteBacklogDrop + counter; depth includes the prioritized set
- `src/worker/health.ts` - optional queueMetrics provider merged into /metrics.json (additive, degrade-not-500)
- `src/worker/index.ts` - boot wiring: queues + tick worker always live, drainables registered, flag-gated upserts with fail-stay-up error handling
- `docs/ARCHITECTURE-AUDIT.md` - §14 GREATEST catch-up-safe advance amendment (D-50, dated note)
- `tests/worker/queues.test.ts`, `tests/worker/claim.test.ts`, `tests/worker/scheduler-flag.test.ts`, `tests/worker/retries.test.ts` - the four proof suites

## Decisions Made
- Manual-check jobId uses the 3-segment `check-manual:{monitorId}:{epochMs}` form — BullMQ 6 rejects 4-segment colon jobIds; 01-08 semantics preserved via a strictly monotonic token (session 1, documented in-code)
- Depth reads include the prioritized set everywhere — empirical bullmq 6.3 behavior pinned by a real-queue regression test (see Deviations #2)
- Scheduler-record identity asserted via `.key` (JobSchedulerJson) — the optional `.id` is absent until the delayed job materializes
- OBS-01/WRK-10 not marked complete (subset/mechanic only; 04-07 and 04-09 carry completion) — false-signal precedent
- `oldestWaitingJobAgeMs` computed over bounded head pages of BOTH wait and prioritized sets (the prioritized set is priority-ordered, so min-timestamp wins, not head-position)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Scheduler-record identity field**
- **Found during:** Task 3 (continuation diagnosis, failing test 2)
- **Issue:** Test asserted `getJobSchedulers()[0].id` — bullmq 6.3's `JobSchedulerJson` identity field is `key`; the optional `id` is the delayed job's id and is absent right after upsert
- **Fix:** Assertions switched to `.key` (tick + maintenance + re-declare), with an in-test note; verified against the installed .d.ts and a live probe
- **Files modified:** tests/worker/scheduler-flag.test.ts
- **Verification:** scheduler-flag suite green
- **Committed in:** e90c329 (Task 3 commit)

**2. [Rule 1 - Bug] Depth reads blind to the PRIORITIZED set (metrics gauge + backlog gate)**
- **Found during:** Task 3 (continuation diagnosis, failing test 4)
- **Issue:** bullmq 6.3 files every priority-carrying job in the PRIORITIZED set, never plain wait — all check-lane jobs carry priorities (Pitfall 3), so the wait/delayed/active-only gauge read depth 0 while jobs waited, and the backlog gate could never see the routine backlog it exists to cap (RES-02 untrippable)
- **Fix:** collectQueueMetrics depth includes `prioritized`; oldest-pending age scans bounded head pages of wait+prioritized (min timestamp); backlog.ts gate depth sums wait+prioritized+delayed+active; real-queue regression test pins counts.prioritized and the refused verdict above the cap
- **Files modified:** src/worker/queues.ts (Task 3 commit), src/worker/backlog.ts + tests/worker/queues.test.ts (separate fix commit — backlog.ts is outside Task 3's file list)
- **Verification:** scheduler-flag test 4 green; queues.test.ts test 8 green (fails without the gate fix)
- **Committed in:** e90c329 + 2984f81

**3. [Rule 1 - Bug] Source-form assertion caught a comment**
- **Found during:** Task 3 (continuation diagnosis, failing test 5)
- **Issue:** index.ts's flag comment literally spelled `queue.pause()` — the Pitfall 12 source guard (`/\.pause\s*\(/`) correctly matched it; a comment is not a call, but the guard should stay simple and the source should stay clean
- **Fix:** Comment reworded to prose ("the queue is NEVER paused, because a paused queue would block operator smoke enqueues too; Pitfall 12") — same meaning, no literal
- **Files modified:** src/worker/index.ts
- **Verification:** scheduler-flag test 5 green
- **Committed in:** e90c329 (Task 3 commit)

**4. [Rule 3 - Blocking] pnpm build fails without NEXT_PUBLIC_DEV_BASE_URL**
- **Found during:** Task 3 verify chain (`pnpm verify` leg 6)
- **Issue:** Pre-existing env-less-checkout condition — `src/redux/api/baseApi.ts` (untouched by this plan) throws at module load, failing the static prerender of /dashboard and /_not-found
- **Fix:** None applied (out of scope per scope boundary); verify re-run as `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm verify` per the documented Phase 2/3 workaround (02-07/03-01 precedent)
- **Files modified:** none
- **Verification:** Full verify green end-to-end with the injection (152 unit + 18 e2e)
- **Committed in:** n/a

---

**Total deviations:** 4 auto-fixed (3 Rule 1 bugs — one spanning a separate fix commit; 1 Rule 3 environment with established workaround)
**Impact on plan:** Fixes #1/#3 were test/wording corrections; fix #2 was a real correctness repair to this plan's own RES-02/OBS-01 deliverables, caught because the tests run against real Redis. No scope creep — all changes land inside the plan's files_modified list.

## Issues Encountered
- Prior executor terminated by usage-limit cutoff mid-Task-3 with three undiagnosed test failures; the continuation re-derived each from the WIP diff + failing assertions (all three root causes above). The orchestrator's resume note also named docker-compose.dev.yml as the test stack — that file is the persistent dev DB (5454); the throwaway test stack (5453/6390) is docker-compose.test.yml, which the dev file's own header states. Both stacks were left healthy.
- BullMQ's upserted scheduler does not materialize its delayed job instantly (getDelayed() = 0 immediately after upsert) — irrelevant to the acceptance criteria (scheduler-count convergence is what RES-05 pins), noted for 04-06/04-07 processor work.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm vitest run tests/worker/` — 8 files, 38 tests green (scheduler-flag 5/5 after fixes)
- `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm verify` — FULL chain green: lint -> typecheck -> vitest (152 tests, 20 files) -> schema:gate (empty diff) -> worker:boundary (9 files, no next/react/@app imports) -> build (Next app + tsup dist/worker.js 32.77 KB) -> e2e (18 passed)
- Manual smoke (plan verification note): booted `node dist/worker.js` flag-off against the test stack (Redis 6390 / Postgres 5453): `/readyz` 200; `/metrics.json` carries all six lanes with depth/age/stalled + backlogDrops; `getJobSchedulers()` empty on BOTH the scheduler and maintenance lanes; build provenance sha 2984f81 in the payload. Worker terminated after capture.

## Self-Check: PASSED

- Files: src/worker/scheduler.ts, src/worker/claim.ts, src/worker/backlog.ts, src/worker/queues.ts, src/worker/health.ts, src/worker/index.ts, tests/worker/{queues,claim,scheduler-flag,retries}.test.ts — all present (committed)
- Commits 7fb02d9, 2cff5a2, e90c329, 2984f81 verified in git log
- Working tree clean of plan files (only the never-committed hygiene file skills-lock.json remains modified, per contract)

## Next Phase Readiness
- 04-03 (SSRF pipeline), 04-04 (locks + Tier 1), 04-05 (Tier 2 flush) can consume LANE_PRIORITY, enqueueClaimedCheck, claimDue, and the queue set now; 04-06 assembles the check processor onto the check lane this plan created (consumers for checks/db-writes/alerts register there)
- The maintenance lane carries the daily dry-run scheduler with no processor until 04-07 — by design this phase; jobs sit in the lane (age visible on /metrics.json)
- Forward note for 04-06: BullMQ's prioritized-set behavior is now pinned by tests/worker/queues.test.ts#8 — any new depth/age read must follow the same wait+prioritized discipline

---
*Phase: 04-monitoring-worker-build-dark-launch*
*Completed: 2026-09-14*
