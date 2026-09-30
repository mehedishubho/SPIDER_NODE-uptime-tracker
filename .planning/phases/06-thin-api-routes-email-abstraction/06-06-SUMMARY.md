---
phase: 06-thin-api-routes-email-abstraction
plan: "06"
subsystem: api
tags: [postgres, drizzle, bullmq, redis, tdd, compensation, deadline, nextjs]

requires:
  - phase: 06-01
    provides: stateless check-now producer route + bounded web queue producer
  - phase: 06-02
    provides: email enqueue door (enqueueTransactionalEmail) + worker email lane
provides:
  - Guarded compensating restore of next_check_at on check-now enqueue failure (VERIFICATION truth 12 closure)
  - PRODUCER_DEADLINE_MS 3s backstop bounding every web-side producer await (VERIFICATION truth 3, silent-unreachable mode)
  - withProducerDeadline / ProducerDeadlineError contract in src/lib/queue-producer.ts
  - deferred-items item 3 resolution note
affects: [06-VERIFICATION re-run, verify-work 06, phase-08 UI, any future producer-consumer seam]

actuals:
  tokens: 8018
  tasks: 3
  commits: 6

plan_head_before: b756c8a45ff45752deea2de850af7bb61b894ea2
plan_head_after: a46a89093320b540c9fa5e050006c00c13a7a986

tech-stack:
  added: []
  patterns:
    - "prior-CTE pre-update value capture (RETURNING cannot see pre-update values on this Postgres)"
    - "guarded compensating write: ownership + expected-value equality in WHERE so a concurrent writer is never clobbered"
    - "Promise.race deadline wrapper with clearTimeout-in-finally around shared-infra awaits"

key-files:
  created:
    - tests/lib/queue-producer-deadline.test.ts
  modified:
    - src/app/api/monitors/[id]/check/route.ts
    - src/lib/queue-producer.ts
    - src/lib/email/enqueue.ts
    - tests/api/check-route.handler.test.ts
    - tests/integration/auth-email-hooks.test.ts
    - tests/integration/better-auth-cutover.test.ts
    - .planning/phases/06-thin-api-routes-email-abstraction/deferred-items.md

key-decisions:
  - "Compensation over reorder: prior-CTE capture + guarded restore keeps the Pitfall 8 advance-before-enqueue ordering intact; both envelope alternatives (enqueue-before-advance, one transaction spanning the Redis enqueue) documented in-code as rejected — each reopens the in-flight double-claim window"
  - "PRODUCER_DEADLINE_MS=3000: above the 1s connect + 1s command budget so fast rejection stays primary; 3s realizes the deferred-items 2-3s candidate; a late add() may still run once — bounded by the per-enqueue-unique jobId + Tier-1 dedup (DAT-04)"
  - "paramValues() probe finding: THIS drizzle version stores sql-template params RAW in queryChunks (StringChunk | Number | String | Date) — the plan's 'entries carrying a value property' parenthetical matches a Param-wrapped drizzle and would extract only StringChunks; the helper filters non-StringChunk chunks instead"

patterns-established:
  - "importOriginal-spread mock factories for @/lib/queue-producer (override ONLY webQueueProducer so the REAL withProducerDeadline runs through the route/door)"

requirements-completed: [API-01, API-02]

coverage:
  - id: D1
    description: "Gap 1 — rejected check-now enqueue restores next_check_at to its pre-advance value before the 503 (guarded, ownership-scoped); happy path never restores"
    requirement: API-02
    verification:
      - kind: unit
        ref: tests/api/check-route.handler.test.ts#enqueue rejection → the guarded restore fires AFTER the rejection with the advance RETURNING values as its parameters
        status: pass
      - kind: unit
        ref: tests/api/check-route.handler.test.ts#guard miss (concurrent writer moved the row — restore matches zero rows) → still the 503 body, zero unhandled rejections
        status: pass
      - kind: unit
        ref: tests/api/check-route.handler.test.ts#happy path never restores: successful enqueue → exactly ONE db.execute (the advance), restore never invoked
        status: pass
    human_judgment: false
  - id: D2
    description: "Gap 2 — 3s producer-side deadline bounds the check-route enqueue await; never-settling Redis yields the fixed 503 (with the gap-1 restore) instead of an indefinite hang"
    requirement: API-02
    verification:
      - kind: unit
        ref: tests/lib/queue-producer-deadline.test.ts#a never-settling promise rejects with ProducerDeadlineError at PRODUCER_DEADLINE_MS — name pinned, timer cleared
        status: pass
      - kind: unit
        ref: tests/api/check-route.handler.test.ts#never-settling enqueue (silently-unreachable Redis) → deadline rejects → the fixed 503 + the compensating restore (06-06 gap 2, T-06-07)
        status: pass
      - kind: command
        ref: grep -n "connection.ping(" src/lib/queue-producer.ts (exactly one line, inside the withProducerDeadline wrap)
        status: pass
    human_judgment: false
  - id: D3
    description: "Email door bounded — enqueueTransactionalEmail's queue.add wrapped; Better Auth verification/reset hooks bounded through the door, error surfacing unchanged"
    requirement: API-02
    verification:
      - kind: unit
        ref: tests/lib/queue-producer-deadline.test.ts#a never-settling add() rejects by the deadline under fake timers (register/forgot hooks bounded through the door)
        status: pass
      - kind: unit
        ref: tests/worker/email-provider.test.ts#propagates an add() rejection to the caller (routes map it to a loud 503, D-29)
        status: pass
    human_judgment: false
  - id: D4
    description: "deferred-items item 3 (never-connected Redis hang instead of 503) resolved with a dated closure note; no other deferred item touched"
    verification:
      - kind: command
        ref: grep -c "06-06 gap closure" .planning/phases/06-thin-api-routes-email-abstraction/deferred-items.md (=1; git diff shows one appended block, 15 insertions)
        status: pass
    human_judgment: false
  - id: D5
    description: "Regression sweep green — no contract drift: typecheck 0 errors, lint 0 errors (baseline warnings), tests/api/ + tests/lib/ 157/157, full suite 420 passed with only the documented IN-01 environmental failure, build + e2e 18/18"
    verification:
      - kind: command
        ref: pnpm typecheck && pnpm lint && pnpm exec vitest run tests/api/ tests/lib/
        status: pass
      - kind: e2e
        ref: pnpm test:e2e (18 passed)
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-09-30
status: complete
---

# Phase 06 Plan 06: Enqueue-Failure Gap Closure Summary

**Guarded compensating restore of next_check_at on check-now enqueue failure plus a 3s producer-side deadline bounding every web-side Redis await (ping / check enqueue / email door) — closing 06-VERIFICATION truths 12 and 3**

## Performance

- **Duration:** ~20 min active (this continuation leg; Task 1 RED authoring + environment probe happened in the prior session interrupted by the Docker outage)
- **Started:** 2026-09-30T15:43:47Z (continuation start)
- **Completed:** 2026-09-30T16:03:42Z
- **Tasks:** 3/3
- **Files modified:** 8 (1 created, 7 modified; plan-declared 6 + 2 Rule-1 integration-mock fixes)

## Accomplishments
- Gap 1 (truth 12, was FAILED): the check-now route's advance now captures the pre-advance next_check_at via a prior CTE; on any enqueue failure a guarded restore puts it back BEFORE the 503 — the WHERE restates ownership (id + userId) AND requires next_check_at to still equal this request's advanced value, so a concurrent writer's row is never clobbered and the per-retry GREATEST compounding is gone
- Gap 2 (truth 3, was PARTIAL): withProducerDeadline (PRODUCER_DEADLINE_MS = 3000) races every web-side producer await — ping(), the check-route enqueueManualCheck call, and the email door's queue.add — so a silently-unreachable (firewall-drop) Redis rejects to the loud fixed 503 instead of pinning request handlers forever
- Three new check-route pins + a five-test deadline suite, both TDD cycles RED-verified (machine-checked RED_EVIDENCE_OK) before GREEN; deferred-items item 3 closed with a dated note
- Full verify chain re-run: typecheck/lint/schema-gate/worker-boundary/denylist-diff/cron-remnants/build/e2e all green; full vitest 420 passed with only the documented IN-01 EADDRINUSE-on-9090 environmental failure (live production worker holds the port)

## Task Commits

Each task was committed atomically (TDD: RED then GREEN per task):

1. **Task 1: Gap 1 — compensating restore** — `6b86bd8` (test: 3 new pins, RED 2-failed/12-passed) + `7dd5522` (feat: prior-CTE advance + guarded restore)
2. **Task 2: Gap 2 — producer deadline** — `9b4de08` (test: deadline suite + route hang pin + importOriginal factory, RED 6-failed/14-passed) + `8ef7599` (feat: deadline contract + three wraps)
3. **Task 3: regression sweep + deferred-items note** — `5240ac3` (docs)
4. **Rule 1 follow-fix (Task 3 full-suite sweep)** — `a46a890` (fix: integration mock factories spread the real producer module)

**Plan metadata:** (see final docs commit)

## Files Created/Modified
- `src/app/api/monitors/[id]/check/route.ts` — prior-CTE advance (FOR UPDATE inside the CTE SELECT), guarded compensating restore in the enqueue catch, enqueue wrapped in withProducerDeadline, rejected-alternatives + late-delivery tradeoff documented in-code
- `src/lib/queue-producer.ts` — PRODUCER_DEADLINE_MS, ProducerDeadlineError (name pinned, message names the ms bound), withProducerDeadline (Promise.race + clearTimeout in finally), ping() wrapped
- `src/lib/email/enqueue.ts` — queue.add wrapped in withProducerDeadline (email contract otherwise unchanged: no jobId, EMAIL_JOB_OPTIONS untouched)
- `tests/api/check-route.handler.test.ts` — 4 new pins total (3 compensation + 1 hang-mode), paramValues() drizzle-param extraction helper, extended advance mock (prior/advanced fixture Dates), @/lib/queue-producer mock switched to the importOriginal spread
- `tests/lib/queue-producer-deadline.test.ts` — NEW: pass-through pins, fake-timer hang pins (name/ms-message/timer-count, custom ms), email-door hang pin; presence-asserting loader keeps RED assertion-based
- `tests/integration/auth-email-hooks.test.ts`, `tests/integration/better-auth-cutover.test.ts` — mock factories converted to importOriginal spreads (Rule 1)
- `.planning/phases/06-thin-api-routes-email-abstraction/deferred-items.md` — item 3 resolution note appended (one block; other items untouched)

## Decisions Made
- Compensation chosen over both envelope alternatives (documented in route comments): enqueue-before-advance reorder and a single transaction spanning the Redis enqueue each reopen the Pitfall 8 in-flight double-claim window; compensation keeps the pinned ordering and is mechanically testable through the existing h.db.execute seam
- Restore row-count read via RETURNING id + rows.length (works uniformly for pg and the mocked seam); restore failure logs its own marker + error.message and never masks the byte-identical 503
- 3s deadline (not 2s): sits above the 1s connect + 1s command budget so the bounded-profile fast rejection stays the primary path — the deadline is the silent-mode backstop only
- RED evidence persisted as machine-verifiable records (both verdicts RED_EVIDENCE_OK); vitest's default reporter is not TAP, so evidence runs used --reporter=tap-flat with the TAP summary derived mechanically from the run's own ok/not-ok counts
- REQUIREMENTS.md rows NOT marked — per the plan's Task 3 action, API-01/API-02 are already Complete at their letter; this closure fixes the failure-path qualifier the verifier graded, and re-verification of truths 3/12 belongs to /gsd-verify-work

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Full-replacement producer mocks broke under the new email-door import**
- **Found during:** Task 3 (full `pnpm test` sweep)
- **Issue:** Task 2 made `enqueueTransactionalEmail` import `withProducerDeadline` from `@/lib/queue-producer`; the full-replacement mock factories in `tests/integration/auth-email-hooks.test.ts` and `tests/integration/better-auth-cutover.test.ts` left it `undefined`, so the enqueue threw a TypeError inside the Better Auth hooks and 3 pins saw `emailAdd` 0 calls
- **Fix:** Both factories converted to async `importOriginal` spreads overriding ONLY `webQueueProducer` (the exact pattern the plan prescribed for check-route) — the real withProducerDeadline now wraps their captured emailAdd
- **Files modified:** tests/integration/auth-email-hooks.test.ts, tests/integration/better-auth-cutover.test.ts
- **Verification:** both suites 10/10; full suite re-run 420 passed / 1 failed (only the documented IN-01)
- **Committed in:** `a46a890`

**2. [Plan-text correction - probe finding] paramValues() extracts params differently than the plan's parenthetical**
- **Found during:** Task 1 (prior executor's probe, verified load-bearing at continuation)
- **Issue:** The plan described drizzle Param objects as "entries carrying a value property" in sql queryChunks; THIS drizzle version stores template params RAW in `queryChunks` (StringChunk | Number | String | Date), so a value-property scan would extract only StringChunks
- **Fix:** The helper filters non-StringChunk chunks instead (authored by the prior executor, adopted as-is; documented in the helper's comment)
- **Files modified:** tests/api/check-route.handler.test.ts
- **Verification:** the compensation pin proves the restore's parameters by identity (monitorId 5, USER_A_ID, both fixture Dates)
- **Committed in:** `6b86bd8`

**3. [Rule 3 - Process] RED evidence needed TAP-formatted output; assertion-based RED authoring**
- **Found during:** Tasks 1-2 (RED gates)
- **Issue:** The #3770 RED gate machine-parses TAP; vitest's default reporter output is not TAP, and a naive new-export static import / a hanging route pin would classify as INVALID_RED (load crash / timeout)
- **Fix:** Evidence runs used `--reporter=tap-flat` with the standard TAP summary lines derived mechanically from the run's own ok/not-ok counts; the deadline suite loads its bindings through a presence-asserting helper and the route hang pin races a sentinel so the pre-deadline tree fails the "ANSWERED" assertion instead of hanging
- **Verification:** `check tdd-red-evidence` → RED_EVIDENCE_OK for both tasks (records persisted under `.git/tdd-red-evidence-06-06-task{1,2}.json`)
- **Committed in:** `6b86bd8`, `9b4de08`

---

**Total deviations:** 3 auto-fixed (1 Rule 1 bug, 1 plan-text correction, 1 Rule 3 process)
**Impact on plan:** No scope creep — the Rule 1 fix repairs collateral test breakage from the planned Task 2 import; the other two document probe/process facts required to execute the plan as written on this tree.

## TDD Gate Compliance

Both tdd-typed tasks followed the canonical RED → GREEN cycle with machine-verified RED evidence and the `test(06-06)` → `feat(06-06)` commit pairs (6b86bd8→7dd5522, 9b4de08→8ef7599). No REFACTOR commits — no post-GREEN cleanup changes were needed.

## Issues Encountered
- Continuation context: the prior executor was interrupted by a Docker-daemon outage after authoring (but never running) Task 1's RED suite. This leg verified the authored RED first (exactly the predicted 2-failed/12-passed shape), then proceeded per plan. Nothing needed re-authoring.
- Full `pnpm verify` was run leg-by-leg (lint, typecheck, test, schema:gate, worker:boundary, denylist:diff, build, cron:remnants, e2e). Two documented environmental exceptions materialized exactly as the plan's verification block pre-authorized: (1) tests/worker/health.test.ts EADDRINUSE 127.0.0.1:9090 while the live production worker holds the port (IN-01 deferral — NOT a regression); (2) the machine-local `.env` still lacks the NEXT_PUBLIC_BASE_URL/NEXT_PUBLIC_DEV_BASE_URL entries (deferred-items item 5, operator action), so the build leg ran with build-shell-only env overrides per the sanctioned 06-04 workaround — no repo file changed.

## Known Stubs

None — no placeholder data paths, no skipped tests, no unwired components.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Both graded gaps closed with pins; /gsd-verify-work 06 should find truth 12 fully evidenced (Task 1 pins) and truth 3's silent-unreachable mode evidenced (Task 2 pins + source gates)
- Phase 06 plan 6 of 7 complete — next: 06-07 (per ROADMAP order); no blockers from this plan
- Standing environmental items unchanged: IN-01 9090 collision while the steady worker holds the port; machine `.env` NEXT_PUBLIC drift awaiting the operator's restore (deferred-items item 5)

---
*Phase: 06-thin-api-routes-email-abstraction*
*Completed: 2026-09-30*

## Self-Check: PASSED

All 9 created/modified files exist on disk; all 6 task commit hashes (6b86bd8, 7dd5522, 9b4de08, 8ef7599, 5240ac3, a46a890) verified in git log. Measured actuals from the ledger sentinel: 6 commits, plan_head_before b756c8a -> plan_head_after a46a890.
