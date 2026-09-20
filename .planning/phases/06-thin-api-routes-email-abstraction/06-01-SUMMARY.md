---
phase: 06-thin-api-routes-email-abstraction
plan: 01
title: Check-Now Enqueue Slice (202 + Poll)
subsystem: api-monitors-check
tags: [api, bullmq, redis, rate-limiting, dashboard, tdd]
requires:
  - "Phase 01 Redis limiter (@/lib/rate-limit) and worker queues module (@/worker/queues with enqueueManualCheck)"
  - "Phase 01/03 drizzle web client (@/db) and the vitest handler harness (tests/api/_harness.ts)"
provides:
  - "POST /api/monitors/[id]/check as a stateless producer: 202 { jobId, queuedAt }, never dials the target"
  - "src/lib/queue-producer.ts — globalThis-cached bounded web-side BullMQ producer (checks + email queues)"
  - "rateLimit() returns resetSeconds; 429s carry a numeric Retry-After header (D-06)"
  - "src/lib/check-now-poll.ts + Dashboard check-now UX: enqueue → poll monitor data → toast per UI-SPEC"
affects:
  - "Dashboard manual check button (optimistic 202 + poll replaces the old synchronous force-check)"
  - "All rateLimit call sites (register, monitors) — backward-compatible optional field addition"
tech-stack:
  added: []
  patterns:
    - "Stateless producer route (admission ladder → atomic claim → enqueue → 202)"
    - "Bounded web-side Redis profile (maxRetriesPerRequest 1, 1s connect/command timeouts) vs worker null-retry profile"
    - "Client completion poll over existing monitor reads (never job state)"
key-files:
  created:
    - src/lib/queue-producer.ts
    - src/lib/api-error.ts
    - src/lib/check-now-poll.ts
    - tests/api/check-route.handler.test.ts
    - tests/lib/check-now-poll.test.ts
  modified:
    - src/app/api/monitors/[id]/check/route.ts
    - src/lib/rate-limit.ts
    - src/components/Dashboard/Dashboard.tsx
    - tests/integration/rate-limit.test.ts
    - tests/api/monitors-id.handler.test.ts
decisions:
  - "Manual check = 202 enqueue + client polls GET /api/monitors until lastChecked > queuedAt (D-01, never job state)"
  - "Web process gets its own bounded BullMQ producer; workerConnection()/workerQueues() stay forbidden on the web side"
  - "BreakerOpenError and generic enqueue rejection collapse into one inner catch → identical 503 (OQ4)"
  - "Both manual limiter buckets always increment (no short-circuit); Retry-After reports the first failing bucket's resetSeconds"
metrics:
  duration: 34m
  completed: 2026-09-20
status: complete
---

# Phase 6 Plan 1: Check-Now Enqueue Slice (202 + Poll) Summary

Manual "check now" rewritten as a stateless BullMQ producer — POST /api/monitors/[id]/check admits via ownership + two Redis limiter buckets, atomically advances next_check_at one interval, enqueues a priority-1 job, and returns 202 { jobId, queuedAt }; the Dashboard then polls the existing monitor read every 2s (30s give-up) and toasts UP/DOWN per the UI-SPEC copy contract.

## What Was Built

### Task 1 — RED: contract suites (commit 4f19931)

- `tests/api/check-route.handler.test.ts` (13 tests): pins the full admission ladder — 401/400/404, D-28 inactive 200 mirror, both SEC-05 buckets and their 429 Retry-After values ("17"/"23"), advance-before-enqueue ordering (`mock.invocationCallOrder`), the 202 body (`jobId` matching `check-manual:5:\d+`, `queuedAt` ≤ enqueue time), `enqueueManualCheck(5, { checksQueue })` with the route NEVER touching the raw queue, D-17 ownership via scoped `findFirst`, 503 on enqueue rejection, 500 fallback.
- `tests/lib/check-now-poll.test.ts` (6 fake-timer tests): first read only after the interval, equal-timestamp not completion, missing monitor keeps polling, 30s deadline → null after exactly 15 reads, abort → null with zero live timers and no further reads, null lastChecked + custom interval/deadline.
- Confirmed RED before implementation: 8 handler-suite failures + unresolvable poll module.

### Task 2 — GREEN: server producer (commit 2d50a79)

- `src/lib/queue-producer.ts`: globalThis-cached web producer — ONE ioredis (`maxRetriesPerRequest: 1`, `connectTimeout: 1000`, `commandTimeout: 1000`, `enableReadyCheck: true`), checks + email queues, `ping()`/`close()`/`disposeWebQueueProducer()`. Imports only `QUEUE_NAMES` from the worker module — `workerConnection()`/`workerQueues()` are never used on the web side.
- `src/lib/rate-limit.ts`: WINDOW_LUA now does INCR + EXPIRE-on-first + PTTL in the single atomic script; `RateLimitResult` gains optional `resetSeconds` (`ceil(PTTL/1000)`, 0 when negative). Fail-open catch block left verbatim — the degraded path carries no resetSeconds.
- `src/app/api/monitors/[id]/check/route.ts`: rewritten as the stateless producer (ladder above); enqueue-time one-interval `next_check_at` advance via drizzle `GREATEST(...)` UPDATE with userId + isActive restated in WHERE (Pitfall 8 — no double-claim); `queuedAt` captured BEFORE the enqueue call (D-05); enqueue failures map to a loud 503.
- `src/lib/api-error.ts`: shared `{ error }` JSON helper.
- `tests/integration/rate-limit.test.ts`: resetSeconds countdown pin, both manual buckets asserted against the real test Redis (`rl:manual_*`, `rl:manual-user_*` keys exist; 7th/min rejected), and the D-22/WR-06 getIP spoof trio (no XFF → 127.0.0.1, multi-entry XFF first/last by TRUST_PROXY, junk → unknown) with keys verified via `admin.exists`.
- `tests/api/monitors-id.handler.test.ts`: removed the old 200 force-check/flush pins (Pitfall 7 — never assert removed behavior mid-wave); header points at the new suite.

### Task 3 — GREEN: client poll + UX (commit c031e72)

- `src/lib/check-now-poll.ts`: abortable 2s/30s poll loop over `fetchMonitors()` — completion is `lastChecked > queuedAt`; give-up/abort resolve `null`; the sleep clears its timer on abort so no pending timer outlives the component.
- `src/components/Dashboard/Dashboard.tsx`: `fetchMonitors` became a `useCallback` returning the list (the poll reuses the same read); `handleCheckMonitor` rewritten — 429 branch reads `Retry-After` into the copy-contract toast, non-OK surfaces the server `error` field, 202 hands `queuedAt` to the poll, DOWN → `toast.error`, UP → `toast.success`, timeout → `toast.info` (never an error, never a re-enqueue, D-04); unmount aborts the in-flight poll; button label/aria swap to "Checking…".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Sequencing] Task 2 verify deferred one test file to Task 3**
- **Found during:** Task 2 verification
- **Issue:** Task 2's verify list includes `tests/lib/check-now-poll.test.ts` and the typecheck, but the plan scopes `src/lib/check-now-poll.ts` to Task 3's files. Task 2's typecheck therefore showed exactly one error (unresolvable `@/lib/check-now-poll`).
- **Fix:** No code change — the poll module landed in Task 3 as planned; typecheck and the full suite are green from Task 3 onward. Documented here because Task 2's commit (2d50a79) intentionally carries that one transient typecheck error.

**2. [Rule 1 - Bug] Single-catch 503 mapping for both enqueue failure classes**
- **Found during:** Task 2 implementation
- **Issue:** The plan text named BreakerOpenError separately from generic enqueue rejection, but importing the class into the route for an `instanceof` split added an unused-in-effect import (breaker is inert in the web process today) for an identical 503 outcome.
- **Fix:** One inner catch maps every enqueue-path failure to the same 503 body; the comment names BreakerOpenError explicitly so the mapping stays greppable. Matches the plan's OQ4 disposition.

**3. [Rule 3 - Blocking] Acceptance-grep accommodations**
- **Found during:** Task 2 verification
- **Issue:** The plan's own prohibition greps tripped on incidental text — the D-28 explanatory comment contained the literal token "runCronChecks" (gate: 0 hits in the route), and the `findFirst` acceptance literal expected single-line formatting.
- **Fix:** Reworded the comment (same meaning) and formatted the call single-line. No behavior change.

## Deferred Issues

**Vitest forks-pool worker crash flake (pre-existing, environment-level).** Roughly 1 in 3 full-`pnpm test` runs on this machine exits 1 with `[vitest-pool]: Worker forks emitted error — Worker exited unexpectedly`; one file's tests are reported never-executed (victim varies per run), zero assertion failures. Verified pre-existing: reproduced identically on the pre-plan tree (all 06-01 files reverted to 274c5a8 content — 1 failure in 5 runs, same signature). All 06-01 suites pass in every run including the failing ones. Out of scope per executor scope boundary; details and follow-up candidates in `.planning/phases/06-thin-api-routes-email-abstraction/deferred-items.md`. Final verification run on HEAD: 37/37 files, 316/316 tests, exit 0.

## Verification Results

- Targeted suites: check-route.handler 13/13, monitors-id.handler 16/16, rate-limit 12/12, check-now-poll 6/6 — green.
- Typecheck: clean. Lint: 0 errors (53 pre-existing warnings; touched files contribute none).
- Acceptance greps: route has 0 `runCronChecks|flushBatches` hits; `src/app` + `src/lib` have 0 `getJob|getState` hits; `Queue(QUEUE_NAMES.checks` appears exactly once in queue-producer; route contains the single-line scoped `findFirst`, the Retry-After construction, `apiError`, `enqueueManualCheck(`, status 202, and the drizzle `GREATEST` import; `WINDOW_LUA` contains `PTTL`; register/monitors routes untouched.
- TDD gates: `test(06-01)` commit 4f19931 (RED) precedes `feat(06-01)` commits 2d50a79 and c031e72 (GREEN).

## TDD Gate Compliance

- RED gate: commit 4f19931 (8 failing handler tests + unresolvable poll suite confirmed before implementation).
- GREEN gate: commits 2d50a79, c031e72 after it.
- REFACTOR gate: not needed — no post-green cleanup required.

## Self-Check: PASSED
