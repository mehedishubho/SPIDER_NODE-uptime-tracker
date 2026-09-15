---
phase: 05-worker-cutover-operational-hardening
plan: 01
subsystem: worker
tags: [worker, outbox-relay, queues, breaker, pool, wr-fixes, observability]
requires:
  - "04-07 outbox relay + collector (collectOutboxMetrics shape extended additively)"
  - "04-02 queue topology (enqueueClaimedCheck / addCheckJob gates)"
  - "04-01 worker pool pin block (§25.2)"
provides:
  - "workerPgPool sessions pinned to TimeZone UTC (WR-05) — one clock domain for Tier-1/Tier-2/maintenance writers"
  - "telegramSend bounded by AbortSignal.timeout(10_000) (WR-04) — relay transaction can no longer idle past the 30 s cap on a Telegram black-hole"
  - "collectOutboxMetrics().oldestUnsentSeconds (OBS-03 gauge input; null when empty, -1 on failure) riding /metrics.json additively"
  - "enqueueClaimedCheck §14.4 posture: breaker refusal (incl. the WR-02 TOCTOU window) is a SKIP; claims stay advanced on every enqueue failure (rollbackFailedClaim deleted)"
  - "redisMemorySnapshot exported from src/worker/health.ts (enabler for 05-02 memory ping / 05-03 memory gauge)"
  - "D-04 pin: manual-check route's flushBatches proven AWAITED in-request (deferred-mock + ordering + reject-surfaces tests, mutation-verified)"
affects:
  - "05-02 outbox-age + memory dead-man pings read oldestUnsentSeconds and redisMemorySnapshot"
  - "05-03 Prometheus gauges wrap the same collectors"
  - "05-08 co-run window relies on the J-1 claims-advanced posture and the bounded relay send"
tech-stack:
  added: []
  patterns:
    - "AbortSignal.timeout(10_000) on the only internet-path await inside a FOR UPDATE transaction"
    - "pg Pool options: '-c timezone=UTC' session GUC pin (typed pass-through, shipped @types/pg)"
    - "deferred-mock (hand-resolved promise) to pin that a route AWAITS a call before responding"
key-files:
  created: []
  modified:
    - src/worker/db.ts
    - src/worker/health.ts
    - src/worker/queues.ts
    - src/worker/persist/outbox.ts
    - tests/worker/persist-tier1.test.ts
    - tests/worker/outbox-relay.test.ts
    - tests/worker/queues.test.ts
    - tests/api/monitors-id.handler.test.ts
decisions:
  - "WR-05 pin is behavioral + source-form: the docker stand-in's server default already spells UTC, so only the options-pin assertion makes drift fail loudly"
  - "oldestUnsentSeconds convention: null when nothing unsent (queue-gauge oldestWaitingJobAgeMs precedent), -1 on query failure"
  - "rollbackFailedClaim deleted outright — no other caller or test seam remained after the call-site removal"
  - "WR-04 transaction-scope audit recorded in-code: Telegram send was the only internet-path await; local PG/Redis awaits are reaped by the 30 s idle cap if a pathological stall ever hits"
metrics:
  duration: "~11 min active execution (resumed session; initial context leg interrupted pre-commit)"
  completed: 2026-09-15
status: complete
---

# Phase 05 Plan 01: Pre-Co-Run Hardening — WR-02..05 + OBS-03 Gauge + D-04 Pin Summary

**One-liner:** All four 04-REVIEW warnings fixed toward the audit's intent — UTC-pinned worker pool sessions, 10 s-bounded Telegram send inside the FOR UPDATE relay transaction, breaker-refusal-is-a-SKIP with claims-left-advanced (rollback deleted), plus the oldestUnsentSeconds outbox-age gauge and the awaited-flush D-04 pin, every one pinned by tests.

## What Was Built

### Task 1 — WR-05: one UTC clock domain (commit 359742a RED, 897cfdf GREEN)

- `src/worker/db.ts`: `workerPgPool` gains `options: "-c timezone=UTC"` with a comment naming the aligned writers (Tier-1 naive `now()`, Tier-2 `formatPgTimestamp` UTC strings, maintenance `AT TIME ZONE 'utc'`). Scoped to the worker pool only — web pool (`src/lib/db-pool.ts`) and migration runner untouched (prohibition 2; verified by git diff).
- `tests/worker/persist-tier1.test.ts` case 10: a pool-acquired client answers `SHOW timezone` with exactly `UTC`, plus a source-form pin on the option itself.
- `src/worker/health.ts`: `redisMemorySnapshot` exported (one-word change + JSDoc) for the 05-02/05-03 consumers (key_links).
- Regression: tier1 + tier2 suites green (20/20) — both writer tiers land in the same clock domain.

### Task 2 — WR-04 + OBS-03: bounded send + age gauge (commit 126b95e RED, 24f5ace GREEN)

- `telegramSend` fetch carries `signal: AbortSignal.timeout(10_000)` — a black-holed `api.telegram.org` connection now aborts an order of magnitude under the 30 s `idle_in_transaction_session_timeout` and classifies transient (attempts advance through the existing handler).
- WR-04 transaction-scope audit recorded as an in-code comment at the `db.transaction` site: the Telegram send was the only internet-path await inside the per-row FOR UPDATE transaction; remaining awaits (local-socket PG under `statement_timeout`, co-located Redis dedup reads) cannot stall past the cap unboundedly — the 30 s idle cap itself reaps any pathological stall (session killed, lock released, BullMQ backoff retries).
- `collectOutboxMetrics` extended additively with `oldestUnsentSeconds`: a bounded sibling query (`EXTRACT(EPOCH FROM (now() - created_at))::double precision` over the unsent non-FAILED set, `ORDER BY created_at ASC LIMIT 1`); null when nothing unsent, -1 on query failure (mirrors the existing degradation pattern); `created_at` is timestamptz so the comparison is clock-safe under Task 1's UTC pin.
- Tests (outbox-relay cases 1/10/11/12): source pin for the signal; direct `telegramSend` against a signal-honoring black-hole aborts in ~10 s; the relay classifies the timeout transient (attempts advance, mark-failure commits, row re-claimable by the next pass — no orphaned FOR UPDATE row); age-gauge exact-value, empty-null, and failure-minus-one cases; `/metrics.json` carries the gauge.

### Task 3 — WR-02 + WR-03: SKIP, never rollback (commit 7352fb2 RED, 91a879c GREEN)

- `enqueueClaimedCheck`'s catch now distinguishes `BreakerOpenError` — the TOCTOU window where the breaker opens between the outer `canEnqueue` check and `addCheckJob`'s inner gate — and returns the skip shape `{ jobId, priority, dropped: true, breakerGated: true }` matching the outer-gate skip verbatim (with a warn log carrying `BREAKER_GATE_MARKER`).
- Every other `add()` failure: ids-only `log.error`, rethrow for the tick, and **no rollback** — audit §14.4's J-1 disposition (leave claims advanced) is the code's only behavior; the per-tick claim/rollback churn loop under sustained Redis outage is gone.
- `rollbackFailedClaim` deleted (orphaned — grep-verified no other caller or test seam), along with its now-unused `sql`/`workerDb` imports in queues.ts.
- Tests: case 4 re-pinned to assert `next_check_at` stays at the advanced slot on a rejecting enqueue; new case 4b injects the trip via the routine row's backlog-gate seam and asserts the verbatim skip shape + advanced claim + `add()` never dialed; `beforeEach` resets breaker module state so the tripped case cannot leak OPEN.

### Task 4 — D-04 pin: awaited flush at the handler seam (commit 596f8ed, tests-only)

- The existing POST_CHECK 200 case extended with a deferred-mock pin: `flushBatches` returns a hand-resolved promise and the 200 must NOT settle until it resolves (pins the await, not the call); `invocationCallOrder` pins `runCronChecks(true, id)` before `flushBatches`; a new case pins a rejecting flush surfacing through the 500 path.
- Mutation-verified (uncommitted): changing the route's `await flushBatches()` to `void flushBatches()` fails both cases; reverted byte-identical. ZERO source changes to the route, `cron-logic.ts`, and `db-batcher.ts` (frozen engine untouched), exactly as the plan expected.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - RED determinism] WR-05 behavioral test passed on RED**
- **Found during:** Task 1 RED run
- **Issue:** The docker test Postgres's server default TimeZone already spells exactly `UTC`, so the `SHOW timezone` assertion alone cannot fail before the fix — WR-05 is a latent deploy-topology hazard (04-REVIEW's own framing), invisible on this topology.
- **Fix:** Added a source-form pin (`options: "-c timezone=UTC"` present in `src/worker/db.ts`, and it is the file's only `new Pool(`) alongside the behavioral assertion — the outbox-relay suite's source-pin precedent. RED now fails deterministically and a future container/server TZ default change fails loudly.
- **Files modified:** tests/worker/persist-tier1.test.ts
- **Commit:** 359742a / 897cfdf

Otherwise the plan executed exactly as written. Task 4's expected "tests pass immediately against today's code" shape was confirmed (plan-anticipated, not a deviation).

## Verification Evidence

- `docker compose -f docker-compose.test.yml up -d --wait && pnpm exec vitest run tests/worker/persist-tier1.test.ts tests/worker/outbox-relay.test.ts tests/worker/queues.test.ts` — **32/32 green**
- `pnpm exec vitest run tests/api/monitors-id.handler.test.ts` — **23/23 green** (D-04 pin)
- Full suite `pnpm test` — **254/254 green (30 files)**, no cross-suite fallout
- `pnpm typecheck` — 0 errors; `pnpm lint` — 0 errors (10 warnings in touched files are pre-existing underscore-mock params; zero new)
- `pnpm worker:boundary` — green (16 files, no next/react/@app imports); `pnpm denylist:diff` — OK (11 tokens agree)
- `git status src/db/ drizzle/` — empty (D-44 zero-migration holds); `src/lib/pg-pool*` and the migration runner untouched (prohibition 2)
- D-04 mutation check: `void flushBatches()` fails both new cases; reverted clean

## TDD Gate Compliance

All three implementation tasks followed RED→GREEN with per-gate commits: `test(...)` commits 359742a, 126b95e, 7352fb2 precede their `feat(...)` counterparts 897cfdf, 24f5ace, 91a879c. Task 4 is tests-only by design (pin task; the plan documents expecting zero source changes) and lands as a single `test(...)` commit (596f8ed) after mutation-verification that the pin bites.

## Requirement Status

`WRK-11` and `OBS-03` (plan frontmatter) deliberately stay **Pending**: this plan lands their inputs (claims-advanced/bounded-send co-run write-path safety; the oldestUnsentSeconds gauge value), but WRK-11 completes at the 05-08 overlap window and OBS-03 at 05-02's dead-man paging — the 02-03/03-02/04-02 false-signal precedent applies.

## Key Learnings

- The WR-05 RED lesson generalizes: on a topology where the hazard is latent, a behavioral test alone is a vacuous pin — pair it with a source-form pin so the *fix* (not the accident of the environment) is what the suite guards.
- A deferred (hand-resolved) mock is the cheapest honest pin for "this call is awaited before the response settles" — call-count pins cannot distinguish `await f()` from `void f()`.
- Injecting the WR-02 TOCTOU through the routine row's backlog-gate seam reproduces the real window exactly: that gate's depth read is the work that runs between the two breaker checks.

## Self-Check: PASSED

- Files: src/worker/db.ts, src/worker/health.ts, src/worker/queues.ts, src/worker/persist/outbox.ts, tests/worker/persist-tier1.test.ts, tests/worker/outbox-relay.test.ts, tests/worker/queues.test.ts, tests/api/monitors-id.handler.test.ts — all present (modified in place)
- Commits: 359742a, 897cfdf, 126b95e, 24f5ace, 7352fb2, 91a879c, 596f8ed — all in `git log`
- No tracked-file deletions in any task commit; no untracked artifacts left behind
