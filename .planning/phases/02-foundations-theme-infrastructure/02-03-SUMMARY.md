---
phase: 02-foundations-theme-infrastructure
plan: 03
subsystem: characterization-suite
tags: [integration-tests, characterization, cron-logic, db-batcher, vitest, real-postgres, d-15]

requires:
  - phase: 02-02
  provides: vitest scaffold + global-setup schema push, docker test stack (:5453), localhost DB guard
provides:
  - tests/integration/cron-logic.test.ts — 19 green cases pinning runCronChecks exactly as it runs today (FND-05 complete)
  - tests/integration/db-batcher.test.ts — 7 green cases pinning enqueue/flush arithmetic + failure-swallow (FND-06 batcher half)
  - The executable behavior contract every later phase (flip, worker extraction) must keep green; 02-09's mutation spot-check breaks it deliberately
  - fileParallelism:false guard in vitest.config.ts for every future DB-backed test file
affects: [02-05 characterization API suite (reuses truncate/batcher-drain harness patterns), 02-06 typecheck flip (D-19: monitored-logic fixes now have their green suite), 02-09 mutation proof (D-21), phase-04 worker (failure-swallow + fast-path pins are the red/green markers)]

tech-stack:
  added: []
  patterns: [characterize-through-the-seam (3 interventions only: telegram mock, fetch stub, prisma seeding), default-rejecting fetch stub as egress tripwire, vi.resetModules + dynamic import for module-state isolation, batcher drain in afterEach to stop cross-case queue bleed]

key-files:
  created: [tests/integration/cron-logic.test.ts, tests/integration/db-batcher.test.ts]
  modified: [vitest.config.ts (fileParallelism: false)]

key-decisions:
  - "Only FND-05 marked complete: FND-06 spans this plan (batcher half) AND 02-05 (per-route API contracts) — marking FND-06 now would falsely signal done before 02-05 lands"
  - "vitest.config.ts fileParallelism:false (Rule 3): both integration files TRUNCATE whole tables in beforeEach against one shared Postgres — vitest's default parallel forks would race seeds; the plan's 'no cross-file state bleed' acceptance demanded sequential files"
  - "Cron harness drains db-batcher in afterEach: runCronChecks queues routine checks into module-level memory that survives the test — an undrained queue would flush into the NEXT case's truncated tables (Pitfall 3 applied to the cron file, not just the batcher file)"
  - "A default REJECTING fetch stub is installed in beforeEach as an egress tripwire: any case that forgets to stub its target fails loudly instead of dialing a real URL (T-02-09 defense in depth on top of per-case stubs)"

patterns-established:
  - "Characterization assert style: specific columns only (status, counters, uptimePercent, lastChecked, description substrings) — never whole-row snapshots; Telegram asserted via template phrases, never blobs"
  - "Fast-path pin: UP→UP (no-change) checks write NOTHING to Postgres synchronously — ping + counters appear only after flushBatches; asserted in cases 1/2/13"
  - "Hand-computed uptime arithmetic asserted with toBeCloseTo(x, 6); clamps asserted with exact toBe(0)"

requirements-completed: [FND-05]

coverage:
  - id: C1
    description: "cron-logic characterization suite green: 19 cases covering every FND-05 truth (due-filter, classification window, all four transition paths, telegram selection, force/specific-id, timeout, redirect, stat math, clamp, cleanup sweep)"
    requirement: FND-05
    verification:
      - kind: test
      - ref: "pnpm vitest run tests/integration/cron-logic.test.ts → 1 file / 19 tests passed (~1.7s warm)"
      - status: pass
    human_judgment: false
  - id: C2
    description: "db-batcher characterization suite green: 7 cases (aggregation, flush math, DOWN accounting, clamp, failure-swallow, queue clearing, empty no-op) with module isolation"
    requirement: FND-06
    verification:
      - kind: test
      - ref: "pnpm vitest run tests/integration/db-batcher.test.ts → 1 file / 7 tests passed (~1.4s warm); grep for a static top-level db-batcher import in the file returns nothing"
      - status: pass
    human_judgment: false
  - id: C3
    description: "Full integration directory green with no cross-file state bleed; full vitest suite (incl. 02-02 db-guard) green"
    requirement: FND-05
    verification:
      - kind: test
      - ref: "pnpm vitest run tests/integration/ → 2 files / 26 tests passed; pnpm test → 3 files / 31 tests passed"
      - status: pass
    human_judgment: false
  - id: C4
    description: "D-15 honored: zero production-code changes (git diff --stat src/ empty); runCronChecks/flushBatches driven as-is"
    requirement: FND-05
    verification:
      - kind: other
      - ref: "git diff --stat src/ → empty across all three task commits; three interventions only (telegram vi.mock, fetch vi.stubGlobal, prisma seeding)"
      - status: pass
    human_judgment: false

duration: ~10min (2026-09-10T17:51:48Z → ~18:01Z)
completed: 2026-09-10
status: complete
---

# Phase 2 Plan 3: Data-Path Characterization Suite Summary

**19 cron-logic + 7 db-batcher integration cases on the real docker Postgres pin the monitoring engine's exact behavior — defects included (D-15): 1-strike DOWN, the UNKNOWN→UP telegram silence, the differing timeout markers, and the batcher's silent whole-batch loss are now executable specification.**

## Performance

- **Duration:** ~10 min (2026-09-10T17:51:48Z → ~18:01Z)
- **Tasks:** 3/3
- **Files:** 3 (2 created, 1 modified — all test infra; `src/` untouched)

## Task Commits

1. **Task 1: Core transition characterization (9 cases)** — `699335d`
2. **Task 2: Extended paths — force, specific id, timeout, redirect, cleanup, clamps (10 cases)** — `af9450e`
3. **Task 3: db-batcher enqueue/flush math + failure-swallow (7 cases) + fileParallelism fix** — `604106f`

## FND-05 case → audit §23 mapping

Audit §23.1 (minimum characterization gate) → named test cases in `tests/integration/cron-logic.test.ts`:

| §23.1 / 02-RESEARCH FND-05 behavior | Case(s) |
|---|---|
| due-time filtering (only past-next-due checked; null lastChecked = immediately due) | 1, 15b |
| UP/DOWN classification window 200–399 | 2 (200 + 399 edge), 2b (400 edge → DOWN), 3 (500 → DOWN) |
| PENDING→UP sends "MONITORING STARTED" | 4 |
| UP→DOWN sends "ALERT" + ONGOING incident w/ status code | 5, 3 (1-strike focus) |
| DOWN→UP sends "RECOVERY" + incident RESOLVED | 6 |
| UNKNOWN→UP sends NO telegram (asymmetry) | 7 |
| Full cycle + counter deltas across runs | 8 |
| Incident open (statusCode‖Timeout marker) / resolve | 5, 2b, 11 / 6, 8 |
| No-change → batcher queue, zero synchronous writes | 1, 2, 13 |
| force flag semantics | 9 (skips interval filter, NOT isActive), 9b (only-inactive → early return) |
| specificMonitorId | 10 (selects only it), 10b (ANDs with isActive) |
| timeout classification + markers | 11 |
| redirect following (final hop classifies) + request shape | 12 |
| monitor stat math (hand-computed) | 13, 8, 5, 6 |
| uptime clamp 0–100 | 14 (slow path), db-batcher 4 (flush UPDATE) |
| runCleanup retention sweep (30d pings / 90d RESOLVED incidents) | 15, 15b |

## Exact Telegram template phrases pinned (from cron-logic.ts, verbatim)

- `"MONITORING STARTED: Website is Online!"` — PENDING→UP only
- `"ALERT: Website Down!"` — any non-DOWN → DOWN
- `"RECOVERY: Website Back Online!"` — DOWN→UP only
- `"No Response / Timeout"` — the Telegram DOWN message's status-code fallback (statusCode falsy)
- Incident description markers: `"Monitor went down. Status code: 500"` / `: 400` / `: Timeout` — note the Telegram fallback (`No Response / Timeout`) and the incident fallback (`Timeout`) are DIFFERENT strings for the same condition; both pinned (case 11)

## DOWN-counts-as-failure arithmetic discovered

- **Slow path (transition, cron-logic):** `totalChecks = total+1` per checked transition; `failedChecks = failed + (!isUp ? 1 : 0)`; `uptimePercent = clamp((total-failed)/total × 100)`. 1-strike: a single 500 on a healthy monitor lands `failedChecks=1, status=DOWN` immediately.
- **Fast path (routine, db-batcher):** each queued check adds `totalChecks += 1`; a queued **DOWN also adds `failedChecks += 1`** — routine DOWN→DOWN checks accumulate as failures (case db-3). Flush recomputes uptime from `monitor totals + batch deltas`, and the queued **status is written to the monitor** (the batcher is not status-neutral — Tier-2 writes carry status today). Latest queued responseTime/status win; `lastChecked` = latest queue timestamp; the upper clamp (100) is mathematically unreachable — only the 0-clamp can ever fire (needs corrupt failed>total seeds).

## Behaviors that surprised (candidates for the phase verification report)

1. **Fast path = zero synchronous footprint:** a UP→UP check writes NOTHING to Postgres until `flushBatches` — not even `lastChecked`. A process crash between queue and flush erases the check entirely (the audit's B1 data-loss defect, now pinned in cases 1/2/13).
2. **runCleanup is skipped unless something was checked:** both early returns (no active monitors / none due) exit BEFORE the retention sweep — a >30-day ping survives forever while no monitor is due (case 15b).
3. **Divergent timeout markers** between incident description and Telegram message (above).
4. **Failure-swallow destroys the whole batch:** one FK-violating row kills the bulk `createMany`, so VALID pings in the same batch are lost too — and permanently (queues cleared before the write; retry flush is a no-op). Pinned verbatim in db-5 as the red/green marker for Phase 4's guarded flush.
5. **Batcher writes monitor.status** — routine flushes are not pure counter aggregation; they can overwrite a concurrently-set status (state-regression defect R-row adjacency, relevant to Phase 4's Tier-2 spec).
6. **force never overrides isActive** — the WHERE clause always filters inactive monitors regardless of force/specificMonitorId (cases 9/9b/10b).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Parallel test files would race each other's TRUNCATE**
- **Found during:** Task 3 verification (full-dir run)
- **Issue:** Both integration files TRUNCATE whole tables in `beforeEach` against the single shared docker Postgres; vitest's default parallel forks would interleave file A's truncate with file B's mid-test asserts — the plan's "no cross-file state bleed" acceptance criterion is unmeetable in parallel.
- **Fix:** `fileParallelism: false` in vitest.config.ts (one line + comment). Test-infra config only; `src/` untouched, D-15 intact.
- **Files modified:** vitest.config.ts
- **Committed in:** 604106f

**2. [Rule 2 - Correctness] Undrained batcher queues would bleed across cron cases**
- **Found during:** Task 1 harness design
- **Issue:** runCronChecks queues routine checks into db-batcher's module-level memory; without a drain, case N's queued pings flush into case N+1's freshly-truncated tables (Pitfall 3 applies to the cron file too, not only the batcher file).
- **Fix:** `afterEach` drains via dynamic `import("@/lib/db-batcher")` + `flushBatches()` before the next truncate.
- **Files modified:** tests/integration/cron-logic.test.ts (harness section)
- **Committed in:** 699335d

**3. [Rule 2 - Correctness] Missing-stub egress tripwire**
- **Found during:** Task 1 harness design
- **Issue:** A case that forgets to stub fetch would perform REAL network egress against the seeded URL (T-02-09).
- **Fix:** beforeEach installs a default fetch stub that rejects with "UNSTUBBED FETCH" — every case overrides it; forgetfulness now fails loudly. Seeded URLs additionally use reserved `.test.example.com` domains (double safety).
- **Files modified:** tests/integration/cron-logic.test.ts (harness section)
- **Committed in:** 699335d

---

**Total deviations:** 3 auto-fixed (correctness/blocking accommodations, all in test infra)
**Impact on plan:** No scope creep; zero production-code changes. Case counts exceeded plan minimums (19 vs ≥15 cron, 7 vs ≥6 batcher) by pinning boundary/discovery cases found while reading the code (400-edge, inactive-force semantics, early-return-skips-cleanup, empty-flush no-op) — each maps to a plan truth, none refactor the monolith.

## Issues Encountered

None. All suites green on first run; docker stack healthy; no flakiness observed across repeated full-suite runs.

## User Setup Required

None. (End-of-phase human check unchanged from 02-02: package-legitimacy glance only.)

## Next Phase Readiness

- 02-05 (API characterization) reuses the truncate harness, the batcher-drain pattern (any route test that reaches cron paths), and the module-isolation pattern for `@/lib/rate-limit` (Pitfall 6)
- 02-06 typecheck flip: monitored logic (cron-logic, db-batcher) now HAS its green suite — D-19's precondition for touching those files is satisfied
- 02-09 mutation spot-check: the pinned truths to mutate (1-strike→2-strike, ownership WHERE, template swap) each have named cases that must go red
- Phase 4: db-5 (failure-swallow) and the fast-path footprint pins are the explicit red/green markers for the guarded flush and Tier-1/Tier-2 split

## Self-Check: PASSED

Both artifacts exist on disk (tests/integration/cron-logic.test.ts, tests/integration/db-batcher.test.ts); all 3 commits found in git log (699335d, af9450e, 604106f); `git diff --stat src/` empty; `pnpm test` → 3 files / 31 tests passed.

---
*Phase: 02-foundations-theme-infrastructure*
*Completed: 2026-09-10*
