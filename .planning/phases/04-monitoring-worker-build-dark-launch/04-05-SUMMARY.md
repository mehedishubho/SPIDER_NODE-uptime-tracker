---
phase: 04-monitoring-worker-build-dark-launch
plan: 05
subsystem: worker-persistence
tags: [tier-2, routine-up-flush, renamenx, write-guards, batchid, dat-02, dat-03, dat-07, never-write-status, uptime-parity, d-35, cr-02]

# Dependency graph
requires:
  - phase: 04-monitoring-worker-build-dark-launch
    provides: worker Redis/DB connection profiles + logger (04-01); workerDb pool max 20 (the flush transaction's client)
  - phase: 04-monitoring-worker-build-dark-launch
    provides: the D-35/D-36 exact-extraction uptime derivation shipped in tier1.ts (04-04) — reused VERBATIM in the Tier-2 UPDATE (only the increment arity changes from +1 check to +dTotal/-dFailed batch deltas)
provides:
  - stageResult(monitorId, outcome, checkedAt) — UP-class-only routine staging into the stage:{monitorId} hash; DOWN-class throws loudly (misroute guard)
  - flushMonitor(monitorId, batchId) — the §16.2 three-step flush: write_guards pre-check skip -> RENAMENX ownership handoff -> ONE guarded transaction (guard ON CONFLICT DO NOTHING + multi-row ping INSERT + additive never-status UPDATE) -> DEL strictly after COMMIT
  - flushDueMonitors() — SCAN-based stage:* sweep with deterministic batchIds, the driver 04-06's D-16-gated scheduler wiring calls; FLUSH_CADENCE_MS = 60_000 (rule 9 upper bound)
  - makeBatchId(passEpochMs, monitorId) + key builders (stagingKey/flushStageKey/flushGuardKey) — the IN-03/01-06 batchId pin {epochMs-of-flush-pass}:{monitorId} surfaced for 04-06's job data
  - guardInsertSql/pingsBulkInsertSql/monitorFlushUpdateSql exported SQL builders — compiled-form source pins for future suites (PgDialect)
  - Tier2Outcome local vocabulary — 04-06's processor joins CheckOutcome and Tier2Outcome structurally (tier1.ts same-wave precedent)
affects: [04-06, 04-07, 04-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "RENAMENX ownership handoff: Redis RENAMENX ERRORS (no such key) when the SOURCE is absent and returns 0 when the TARGET exists — the flush handles both: source-absent + no surviving own snapshot = benign no-op; target-exists under OUR deterministic batchId = our own pre-crash snapshot, apply it (CR-02)"
    - "Row-derived flush deltas: dTotal/dFailed derive from the staged evidence rows, never a parallel counter field — an HINCRBY maintained beside the rows can drift from them across a crash between the two writes; row-derived counters can never account a check whose evidence row is absent"
    - "Bounded-profile module Redis client (maxRetriesPerRequest 1, commandTimeout 2 s) globalThis-cached — the locks.ts discipline, NOT the BullMQ null profile"
    - "Naive timestamp(3) determinism: staged epoch ms rendered as explicit UTC wall-clock strings (formatPgTimestamp) for both the pings INSERT and the GREATEST/CASE comparisons — no session-timezone dependence"

key-files:
  created:
    - src/worker/persist/tier2.ts
    - tests/worker/persist-tier2.test.ts

key-decisions:
  - "Single staging hash stage:{monitorId} (this plan's key-namespace pin) consolidates the audit's two containers (agg hash + pings list); deltas DERIVE from the ping:{slot} rows so counters and evidence are crash-consistent by construction"
  - "RENAMENX error semantics handled explicitly: source-absent arrives as an error reply, not 0 — caught and classified; target-exists (returns 0) under our own deterministic batchId is always our pre-crash snapshot, so the flush applies it rather than bailing"
  - "Deleted-monitor FK-safe no-op: an in-transaction existence check (after the guard insert) skips pings+counters while the guard row still commits and the snapshot still cleans — without it a monitor deleted mid-staging poisons the flush job into an FK-violation retry loop (mirrors tier1's §15.1 step-1 no-op)"
  - "uptime_percent reuses the tier1 D-36 exact-extraction expression verbatim (2^52/2^60 ::bigint shifts + integer floor round) — never round(); the plan's 'numeric-cast chain' requirement resolves to the shipped 04-04 form per the orchestrator handoff"
  - "stageResult rejects DOWN-class loudly (throws) — transition evidence belongs to Tier 1; misrouting can never be silently swallowed as routine evidence"
  - "lastChecked = GREATEST(COALESCE(lastChecked, epoch-zero timestamp), staged max) per the plan must_have; responseTime = the §16.2 monotonic CASE (replaced only when the staged newest ts is strictly newer than the row's CURRENT lastChecked — SET reads old values, the pinned NULL asymmetry holds)"
  - "Per-case test hygiene: write_guards TRUNCATE + SCAN/DEL of stage:/flushstage: keys on the admin client (never FLUSHDB — the Redis container is shared with BullMQ suites)"

requirements-completed: [DAT-02, DAT-03, DAT-07]

# Coverage metadata (#1602)
coverage:
  - id: T1
    description: "Tier 2 staging + guarded flush: additive counters via ONE guarded UPDATE that never writes status, RENAMENX ownership, ≤60 s cadence constant, batchId determinism (DAT-02)"
    requirement: DAT-02
    verification:
      - kind: integration
        ref: "tests/worker/persist-tier2.test.ts#1,3,4,5,10 (real docker Postgres :5453 + Redis :6390)"
      status: pass
    human_judgment: false
  - id: T2
    description: "Transactional write guards: same-transaction guard insert + delta apply, ON CONFLICT DO NOTHING skips re-application under crash-after-COMMIT redelivery and same-batchId parallelism (DAT-03, CR-02)"
    requirement: DAT-03
    verification:
      - kind: integration
        ref: "tests/worker/persist-tier2.test.ts#6,7 (guard-preexists skip; counters/pings applied exactly once; fresh staging key never stolen)"
      status: pass
    human_judgment: false
  - id: T3
    description: "Multi-row ping INSERT with ids omitted — every row receives a DB-generated UUID; evidence fields (status/responseTime/error_class/status_code/createdAt) ride every row (DAT-07)"
    requirement: DAT-07
    verification:
      - kind: integration
        ref: "tests/worker/persist-tier2.test.ts#1 (source pin: no id in column list),#3 (3 UUID rows with exact evidence)"
      status: pass
    human_judgment: false

# Metrics
duration: ~11 min (666s) single session
completed: 2026-09-13
status: complete
---

# Phase 4 Plan 5: Tier-2 Routine-UP Staged Flush Summary

**Redis-staged routine-UP aggregation with the RENAMENX ownership handoff, the write_guards same-transaction guard, additive never-status counters carrying the tier1 D-36 byte-parity uptime derivation, and id-less multi-row evidence INSERTs — 10 engine-level proof cases green on the real docker Postgres+Redis, full verify chain green end-to-end (210/210)**

## Session Notes

Single-session sequential execution. Task 1 (module) landed green on typecheck + lint + worker:boundary; Task 2's first run exposed one test-authoring bug (case 6 flushed before staging its first batch — the module correctly returned not-owner), fixed before commit. Full `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm verify` green end-to-end (lint, typecheck, 210 vitest, schema:gate, worker:boundary, Next build + tsup worker bundle, 18/18 e2e).

## Performance

- **Duration:** ~11 min (666s)
- **Started/Completed:** 2026-09-13T21:33:11Z → 2026-09-13T21:44:17Z
- **Tasks:** 2/2
- **Files created:** 2 (both inside the plan's files_modified list)

## Accomplishments

- DAT-02: `stageResult` stages UP-class results into `stage:{monitorId}` (atomic HINCRBY slot allocation, one complete evidence JSON per check); `flushMonitor` runs the §16.2 literal three-step flush — write_guards pre-check skip → RENAMENX handoff → ONE guarded transaction (guard insert + multi-row ping INSERT + additive UPDATE) → DEL strictly after COMMIT; `FLUSH_CADENCE_MS = 60_000` (rule 9); the UPDATE structurally contains no status reference (B3 fix) (T-04-18 mitigated)
- DAT-03: crash-after-COMMIT redelivery of the same batchId applies counters and pings exactly once total (guard pre-check path), and same-batchId PARALLEL flushes dedupe through the in-transaction ON CONFLICT DO NOTHING — the CR-02 case proven live, including that a redelivery never steals/deletes the fresh live staging key (T-04-17 mitigated)
- DAT-07: the bulk INSERT never supplies ids — every ping row carries a non-null DB-generated text UUID with the DAT-10 metadata columns riding along
- The uptime derivation is the tier1 D-36 exact-extraction form reused verbatim (same 2^52/2^60 constants, same branch structure, same op order) — flush-uptime byte-parity with the legacy JS toFixed(2) rendering asserted via the recomputed legacy formula ("84.62" for 11/13, "83.33" for 5/6, "100.00", plus the case-4/10 re-assertions)
- GREATEST no-regression + the §16.2 responseTime monotonicity CASE both pinned: a row holding a NEWER lastChecked keeps it AND its paired responseTime (the ELSE branch)
- `flushDueMonitors()` sweeps via SCAN (COUNT 100 cursor loop), skips malformed `stage:*` keys untouched, and derives one pass-epoch batchId set (`{epochMs}:{monitorId}`, IN-03) (T-04-19 partially mitigated — the ≤60 s cadence bounds staging; 04-07's dry-run reports sizes)

## Task Commits

1. **Task 1: Tier-2 staged flush module (§16.2 literal)** — `d824f1b` (feat)
2. **Task 2: integration proof suite** — `faab87f` (test)

## Files Created/Modified

- `src/worker/persist/tier2.ts` — FLUSH_CADENCE_MS, stagingKey/flushStageKey/flushGuardKey/makeBatchId, stagingRedis/disposeStagingRedis (bounded profile, globalThis-cached), Tier2Outcome/StagedPingRow/Tier2FlushResult/DueFlushOutcome types, formatPgTimestamp, stageResult, parseSnapshot, guardInsertSql/pingsBulkInsertSql/monitorFlushUpdateSql (D-35 derivation), takeSnapshot (RENAMENX error semantics), flushMonitor, flushDueMonitors. Zero imports from queues.ts (worker:boundary green).
- `tests/worker/persist-tier2.test.ts` — 10 cases: source-form pins (module + compiled SQL), staging math, flush apply + GREATEST/monotonicity, sentinel never-status, ownership race, CR-02 redelivery, same-batchId parallel guard, DOWN misroute rejection, deleted-monitor no-op, sweep driver

## Decisions Made

See key-decisions in the frontmatter. The load-bearing ones for downstream plans:

- 04-06's check processor MUST call `stageResult` ONLY on routine UP-class outcomes while `monitor.status === "UP"`; every non-UP outcome routes to Tier 1 — stageResult throws on DOWN-class by contract, and that throw is the misroute safety net
- 04-06's flush job carries `batchId` in job data (derive at enqueue via `makeBatchId(Date.now(), monitorId)` or the flush-pass epoch) — redelivery determinism depends on it; never mint a fresh batchId inside the processor
- The flush job's cadence wiring belongs to the D-16-gated scheduler calling `flushDueMonitors()` (straggler re-enqueue path); this module owns no timers
- T-04-20 (lost staged results if Redis restarts mid-window, ≤60 s of routine-UP EVIDENCE) is ACCEPTED by design per the plan's threat register — Postgres authority is never corrupted; recorded here per the register's disposition

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - missing correctness path] deleted-monitor poison-loop guard**
- **Found during:** Task 1 implementation — §16.2's literal SQL would let the pings INSERT hit an FK violation when the monitor is deleted between staging and flush, rolling back the guard row and re-failing every redelivery forever
- **Fix:** an in-transaction existence check after the guard insert skips pings+counters while the guard row still commits and the snapshot still cleans (skipped: "monitor-missing") — mirrors tier1's §15.1 step-1 deleted-monitor no-op
- **Files modified:** src/worker/persist/tier2.ts
- **Verification:** case 9 (no throw, guard committed, snapshot cleaned, zero orphan rows)
- **Committed in:** d824f1b

**2. [Rule 1 - bug] Redis RENAMENX error semantics**
- **Found during:** Task 1 implementation — RENAMENX returns an error reply (not 0) when the SOURCE key is absent; unhandled it would crash the benign "nothing staged" no-op path mandated by §16.2
- **Fix:** takeSnapshot classifies the reply explicitly: error-and-source-absent → apply only a surviving own snapshot; 0 (target exists under our deterministic batchId) → our own pre-crash snapshot, apply it; 1 → fresh handoff won
- **Files modified:** src/worker/persist/tier2.ts
- **Verification:** cases 5/6/10 exercise all three paths
- **Committed in:** d824f1b

---

**Total deviations:** 2 auto-fixed (1 Rule 2 correctness guard, 1 Rule 1 error-semantics fix). No scope creep: every change lands inside the plan's files_modified list.

## Issues Encountered

- Task 2 case 6's first run failed on a test-authoring bug (the first flush ran before the first staging — the module correctly answered not-owner); fixed before any commit, so no broken state ever landed
- `pnpm test -- <file>` passes the literal `--` through and runs the whole suite (04-04 learning, still true) — `npx vitest run <file>` used for single-file isolation

## User Setup Required

None.

## Threat Flags

None — no security-relevant surface beyond the plan's threat_model. Register rows T-04-17/T-04-18 carry their mitigations in this plan's code/tests; T-04-19's cadence bound landed here with the 04-07 dry-run leg to come; T-04-20 is the recorded accepted risk (see Decisions Made).

## Self-Check: PASSED

Both created files exist on disk; both task commits (d824f1b, faab87f) present in git log.
