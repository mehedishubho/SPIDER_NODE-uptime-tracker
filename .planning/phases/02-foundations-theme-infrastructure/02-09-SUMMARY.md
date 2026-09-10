---
phase: 02-foundations-theme-infrastructure
plan: 09
subsystem: testing
tags: [mutation-testing, characterization-tests, vitest, playwright, red-green, d-21]

# Dependency graph
requires:
  - phase: 02-foundations-theme-infrastructure (02-03)
    provides: characterization suite for cron-logic (tests/integration/cron-logic.test.ts, 19 cases)
  - phase: 02-foundations-theme-infrastructure (02-05)
    provides: API contract suites — handler-import (tests/api/monitors.handler.test.ts) and HTTP-level (tests/api/monitors.core.spec.ts)
  - phase: 02-foundations-theme-infrastructure (02-08)
    provides: HEAD with full `pnpm verify` green (the baseline this plan's final gate re-proves)
provides:
  - Executable D-21 evidence: three red/green pairs proving the characterization suite catches changes to every pinned canonical behavior (roadmap success criterion 2)
  - The ASVS V4 access-control regression proof (ownership-scoping mutation caught at both test layers)
affects: [03-drizzle-baseline, 04-bullmq-worker, 05-worker-cutover, gsd-verify-work]

# Tech tracking
tech-stack:
  added: []  # none — evidence-only plan
  patterns:
    - "Mutation spot-check discipline: one-file-per-mutation → targeted RED run → git checkout -- single file → targeted GREEN run → residue gate; mutations live only in the working tree, never a commit"
    - "HTTP-layer mutation proof requires rebuilding between red and green (Playwright `api` project runs the built artifact via `next start`, not source)"

key-files:
  created:
    - .planning/phases/02-foundations-theme-infrastructure/02-09-SUMMARY.md (this evidence record)
  modified: []  # src/lib/cron-logic.ts and src/app/api/monitors/route.ts were mutated temporarily and reverted — zero diff

key-decisions:
  - "Mutation 1 realized as a true 2-consecutive-failure gate (DOWN only when monitor.status already DOWN) — the plan's `failedChecks >= 2` example leaves the seeded failedChecks=2 UP→DOWN case green; the consecutive form turns BOTH plan-named cases (1-strike and UP→DOWN) red"
  - "Mutation 2 required rebuild-between: mutate → pnpm build → RED e2e → revert → rebuild → GREEN, because Playwright's api project exercises the built artifact"
  - "Per-task evidence recorded as --allow-empty commits carrying the failing-case names in the message body — the only durable artifact is the SUMMARY"

patterns-established:
  - "D-21 mutation spot-check: break → prove RED → revert (no trace) → prove GREEN → full verify as closing gate"

requirements-completed: [FND-05, FND-06]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Mutation 1 proven: 1-strike→2-strike DOWN transition in cron-logic.ts turns tests/integration/cron-logic.test.ts RED with 6 named failures; revert restores 19/19 green"
    requirement: FND-05
    verification:
      - kind: integration
        ref: "pnpm vitest run tests/integration/cron-logic.test.ts (mutation run: 6 failed / 13 passed — cases 2b, 3, 5, 8, 11, 14; revert run: 19 passed)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Mutation 2 proven: dropping the ownership-scoping userId filter from the monitors GET handler turns BOTH test layers RED (handler-import: 2 cases; HTTP-level e2e: 2 cases); revert + rebuild restores 12/12 green at both layers"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "pnpm vitest run tests/api/monitors.handler.test.ts (mutation run: session-A scoping + session-B scoping cases failed; revert run: 12 passed)"
        status: pass
      - kind: e2e
        ref: "pnpm test:e2e --project=api against rebuilt artifact (mutation run: 2 failed / 10 passed — both ownership-filter-over-the-wire cases; revert run: 12 passed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Mutation 3 proven: swapping the DOWN-alert Telegram template phrase turns the cron-logic content-phrase cases RED (2 failures); revert restores 19/19 green"
    requirement: FND-05
    verification:
      - kind: integration
        ref: "pnpm vitest run tests/integration/cron-logic.test.ts (mutation run: 2 failed / 17 passed — cases 5, 8; revert run: 19 passed)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Zero mutation residue + final full pnpm verify green as the phase's closing execution-time gate"
    requirement: FND-05
    verification:
      - kind: other
        ref: "git status --porcelain src/ → empty; pnpm verify → exit 0 in 22s (lint warnings-only, typecheck, vitest 102/102, build compiled, e2e 18/18)"
        status: pass
    human_judgment: false

# Metrics
duration: ~6min (387s)
completed: 2026-09-10
status: complete
---

# Phase 02 Plan 09: D-21 Mutation Spot-Check Summary

**Three deliberate behavior mutations (1-strike→2-strike DOWN, ownership-scoping removal, Telegram template swap) each proven to turn the characterization suite RED, reverted to GREEN with zero residue — roadmap success criterion 2 is now executable fact, closed by a full green `pnpm verify`.**

## Performance

- **Duration:** ~6 min (387s) — 2026-09-10T20:44:42Z → 2026-09-10T20:51:09Z
- **Tasks:** 3 / 3
- **Files modified:** 0 lasting (both target files temporarily mutated, then reverted — `git status --porcelain src/` empty)
- **Created:** this SUMMARY (the D-21 evidence record — the plan's only artifact)

## The D-21 Evidence Table

Each row: the mutation → the tests that caught it → the revert proof. All mutations lived only in the working tree; none was ever committed (verified before every commit).

| # | Mutation (file) | RED — failing cases (suite → counts) | Revert proof | GREEN |
|---|-----------------|--------------------------------------|--------------|-------|
| 1 | 1-strike → 2-strike DOWN: `const newStatus = isUp ? "UP" : "DOWN"` became a 2-consecutive-failure gate (DOWN only when `monitor.status` already DOWN; first failure classifies UP, ping still recorded via fast path) — `src/lib/cron-logic.ts` | `pnpm vitest run tests/integration/cron-logic.test.ts` → **6 failed / 13 passed**: • "3. DOWN classification + 1-strike: UP monitor + HTTP 500 → DOWN on the FIRST failure (no N-strike buffer)" • "5. UP→DOWN: sends the ALERT message and opens an ONGOING incident…" • "2b. classification boundary: HTTP 400 is already DOWN" • "8. full cycle UP→DOWN→UP…" • "11. timeout / network-failure classification…" • "14. uptime clamp…" | `git checkout -- src/lib/cron-logic.ts`; `git diff --stat src/lib/cron-logic.ts` → 0 lines | Same command → **19/19 passed** |
| 2 | Ownership-scoping dropped: GET list `where: { userId: session.user.id }` → `where: {}` (returns ALL users' monitors) — `src/app/api/monitors/route.ts` | Handler layer `pnpm vitest run tests/api/monitors.handler.test.ts` → **2 failed**: • "with session A, findMany is scoped to A's userId (D-21 mutation target)" • "with session B, the same route scopes to B's DISTINCT userId". HTTP layer `pnpm test:e2e --project=api` (vs rebuilt artifact) → **2 failed / 10 passed**: • "GET /api/monitors is ownership-filtered over the wire: A sees only A's monitor" • "GET /api/monitors as B sees only B's monitor (both directions of the scoping)" | `git checkout -- src/app/api/monitors/route.ts` (diff → 0 lines) **+ clean rebuild** (Playwright runs the built artifact) | Handler → **12/12 passed**; HTTP → **12/12 passed** |
| 3 | Telegram template swap: DOWN-alert header "ALERT: Website Down!" → "NOTICE: Website Maintenance Window!" (delivery mechanics identical) — `src/lib/cron-logic.ts` | `pnpm vitest run tests/integration/cron-logic.test.ts` → **2 failed / 17 passed**: • "5. UP→DOWN: sends the ALERT message…" • "8. full cycle UP→DOWN→UP…" (both assert `stringContaining("ALERT: Website Down!")`) | `git checkout -- src/lib/cron-logic.ts`; diff → 0 lines | Same command → **19/19 passed** |

**Reading the table:** mutation 1 was caught by 6 cases across both describe blocks (the plan-named 1-strike AND UP→DOWN cases at minimum — both present); mutation 2 was caught at both layers of the D-16 hybrid split, which is the access-control regression proof for ASVS V4; mutation 3 was caught by exactly the two message-content cases while the delivery-mechanics cases (11's "No Response / Timeout") stayed green — the swap isolated content from mechanics precisely as intended.

## Final Phase Gate

- `git status --porcelain src/` → **empty** (zero mutation residue anywhere)
- Full **`pnpm verify` → exit 0 in 22s** (docker stack already healthy → no cold-start): lint (pre-existing warnings only, exit 0) · typecheck · **vitest 102/102** · build (compiled, 39 static pages) · **e2e 18/18** (smoke + theme + api HTTP-level)
- Duration 22s vs the 5-minute budget: everything warm (stack up since 02-08's verify; incremental build from the Task-2 rebuilds). The budget is a cold-CI ceiling, not a local warm-run expectation.

## Accomplishments

- Mutation 1 (1-strike DOWN): 6-case RED including both plan-named cases → 19/19 GREEN after revert
- Mutation 2 (ownership scoping): RED at BOTH layers (handler-import mock-args assertion + HTTP-level B-not-in-A over the wire) → 12/12 + 12/12 GREEN after revert + rebuild
- Mutation 3 (Telegram content): precise 2-case RED (content assertions only) → 19/19 GREEN after revert
- Clean tree + full `pnpm verify` green — Phase 2's execution work is complete

## Task Commits

Each task was committed atomically (evidence-record commits — `--allow-empty` by design: the mutations themselves must never be committed, so the failing-case evidence lives in the message body):

1. **Task 1: Mutation 1 — 1-strike DOWN becomes 2-strike** - `9a40b93` (test)
2. **Task 2: Mutation 2 — ownership-scoping filter dropped** - `be56966` (test)
3. **Task 3: Mutation 3 — Telegram template swap + final full verify** - `b7e2170` (test)

**Plan metadata:** see final docs commit (SUMMARY + STATE + ROADMAP + REQUIREMENTS).

## Files Created/Modified

- `.planning/phases/02-foundations-theme-infrastructure/02-09-SUMMARY.md` — this evidence record (the plan's only artifact)
- `src/lib/cron-logic.ts` — temporarily mutated twice (tasks 1, 3), reverted both times; zero diff vs HEAD
- `src/app/api/monitors/route.ts` — temporarily mutated once (task 2), reverted; zero diff vs HEAD

## Decisions Made

- **Mutation 1 form:** implemented as a true 2-consecutive-failure gate (`monitor.status === "DOWN"` as prior-failure evidence) rather than the plan's literal `failedChecks >= 2` example — the example leaves test 5's seed (failedChecks=2, status UP) green, so the UP→DOWN case the plan expects red would not fail; the consecutive form turns both plan-named cases red and is the smallest faithful edit
- **Rebuild-between for mutation 2:** the Playwright `api` project runs the BUILT artifact (`next start`), so the HTTP-level red/green pair required mutate → build → RED → revert → build → GREEN; both builds used `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007` (the documented env-less-checkout requirement)
- **Evidence commits:** per-task `--allow-empty` commits carry the red/green evidence in their messages; the SUMMARY is the single durable artifact (matches the plan's artifacts section: "No lasting code artifacts")

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Rebuild steps added around the mutation-2 e2e runs**
- **Found during:** Task 2 (ownership-scoping mutation)
- **Issue:** The plan's action says run `pnpm test:e2e --project=api` against the mutation, but that project boots `next start` from the built `.next` artifact — without a rebuild the HTTP layer would run the un-mutated build and stay green (false negative)
- **Fix:** Added `pnpm build` after mutating (before the RED run) and again after reverting (before the GREEN run)
- **Files modified:** none committed (build artifact only)
- **Verification:** RED run showed the 2 ownership cases failing over the wire; GREEN run after clean rebuild showed 12/12
- **Committed in:** be56966 (evidence message documents the rebuild)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for the plan's own acceptance criterion ("Red captured at BOTH layers"). No scope change; no code shipped.

## Issues Encountered

None — all three red/green pairs behaved exactly as the plan predicted on the first attempt.

## Authentication Gates

None.

## Known Stubs

None — no code shipped.

## Next Phase Readiness

- **Phase 2 execution is complete (9/9 plans).** All roadmap success criteria for the phase have executable evidence: criterion 1 (suite exists — 102 vitest + 18 Playwright), criterion 2 (suite catches pinned-behavior changes — proven three ways above)
- Ready for `/gsd-verify-work 02`, then `/gsd-plan-phase 03` (Drizzle live-DDL baseline) and `/gsd-discuss-phase 03`
- No blockers from this plan; the pre-existing design-debt register items (CR-01/CR-02, Phase 4/5 planning inputs) are unchanged

## Self-Check: PASSED

- SUMMARY file exists on disk at `.planning/phases/02-foundations-theme-infrastructure/02-09-SUMMARY.md`
- Task commits found in git log: 9a40b93, be56966, b7e2170 (`git log --grep="02-09"` ≥ 1)
- All task acceptance criteria re-verified: red pairs with named cases (all 3), reverts proven (all 3), both layers for mutation 2, `git status --porcelain src/` empty, full `pnpm verify` exit 0

---
*Phase: 02-foundations-theme-infrastructure*
*Completed: 2026-09-10*
