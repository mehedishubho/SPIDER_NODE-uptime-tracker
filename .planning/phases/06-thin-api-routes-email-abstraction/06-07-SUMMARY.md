---
phase: 06-thin-api-routes-email-abstraction
plan: "07"
subsystem: worker
tags: [bullmq, postgres, drizzle, tdd, telegram-webhook, rate-limiting, secret-hygiene, verification]

requires:
  - phase: 06-01
    provides: stateless check-now producer + the D-01 poll contract (lastChecked > queuedAt, 30 s give-up) this plan makes completable for repeats
  - phase: 06-03
    provides: webhook secret ladder pins (D-20 length-guard 401 path behind the D-21 limiter-first order) — code proven correct, re-verified live here
  - phase: 06-05
    provides: setWebhook cutover + the §12-attested production secret mint the operator enters into the env contract
provides:
  - In-job manual non-transition persist — a MANUAL job's applyTransition applied:false is followed by one monitorFlushUpdateSql additive UPDATE (counters/lastChecked/responseTime only, never status/scheduling), closing the G-06-2 "repeat check-now persists nothing" UAT blocker
  - manualFlushed flag on the tier1 CheckJobResult member + distinct manual-flush log line
  - scripts/probe-telegram-webhook-ladder.mjs — standing tracked ladder probe (default 401/401/429 + --baseline RED 500/500/429, WEB_ORIGIN/argv origin override, secret-blind)
  - Runbook §9 env-contract omission lesson (TELEGRAM_WEBHOOK_SECRET mandatory in every future launch-env-contract mint)
  - Deferred-hardening backlog record (boot-time env checklist / healthz posture field)
affects: [06-UAT re-run, verify-work 06, future launch-env-contract mints, next release deploy (worker artifact), phase-08 live posture]

actuals:
  tokens: 6014
  tasks: 3
  commits: 4

plan_head_before: 0c014c04577d302c5678fa12be8e183aaa20ef44
plan_head_after: cfe6826bd4ffabf6b5aaeaebbe4d9308d30459f6

tech-stack:
  added: []
  patterns:
    - "Reused-SQL-over-new-SQL: the manual follow-up calls the exported §16.2 monitorFlushUpdateSql builder — no new SQL fragment authored, persist modules byte-untouched"
    - "RED-mode instrument pattern: a standing probe whose --baseline mode reproduces the broken posture (500/500) so the instrument is proven non-vacuous before the fix flips it"
    - "Secret-blind probing: the probe exercises refusal legs only (absent header, wrong-length header) and never reads the secret env var — key name in docs, never a value"

key-files:
  created:
    - scripts/probe-telegram-webhook-ladder.mjs
  modified:
    - src/worker/engine/check.ts
    - tests/worker/engine-check.test.ts
    - docs/DEPLOY-RUNBOOK.md
    - .planning/phases/06-thin-api-routes-email-abstraction/deferred-items.md

key-decisions:
  - "G-06-2 mechanism: keep manual -> applyTransition unchanged and add ONE in-job follow-up when a MANUAL job's applyTransition returns applied:false — the exported §16.2 additive UPDATE with dTotal 1 / dFailed (down-class?1:0), synchronous per 06-CONTEXT D-01 and Phase-05 D-04; both envelope alternatives (un-guarding the transition UPDATE, Tier-2 delayed staging) documented in-code as rejected with their fabrication/latency reasons"
  - "G-06-7 closure is an OPERATOR action (env contract + §4e web restart), never a code change — the route was correct per the 06-03 pins; the executor re-verifies with the tracked probe and never sees the secret value"
  - "Optional hardening (boot-time env checklist / healthz required-by-feature posture field) DEFERRED to the backlog — it would extend the 07-05-owned healthz surface and needs its own design pass (deferred-items.md, unresolved by design)"
  - "Optional worker redeploy for the G-06-2 fix NOT taken at this checkpoint — the live UAT test-2 re-run is deferred to the next release; the engine-side end-to-end pin (tests 10-11) is the closure proof meanwhile"

patterns-established:
  - "Exit-encoded verify gates in test-form for zero-expected greps (grep -c exits 1 on zero — the test(...) form encodes every expectation in the exit code, no masking echo)"
  - "Naive-UTC timestamp assertion seam: pg returns lastChecked as a Date parsed LOCAL, so in-job assertions normalize via getTime() minus host offset; string reads keep the literal T+Z form"

requirements-completed: [API-01, SEC-03]

coverage:
  - id: D1
    description: "G-06-2 — a repeat manual check-now persists in-job on UP-on-UP and DOWN-on-DOWN (lastChecked advances past the enqueue epoch, counters move by one, zero fabricated incidents/outbox, staging key absent) while transitions, the scheduler path, and both persist modules stay byte-untouched"
    requirement: API-01
    verification:
      - kind: unit
        ref: "tests/worker/engine-check.test.ts#test 10 — repeat manual on UP: manualFlushed true, totalChecks 2, UTC-normalized lastChecked > enqueue epoch, one ping per enqueue, staging key absent (D-01 predicate, engine end-to-end through the real queue lane)"
        status: pass
      - kind: unit
        ref: "tests/worker/engine-check.test.ts#test 11 — DOWN-on-DOWN repeat: failedChecks 1, zero ONGOING incidents, zero outbox rows, evidence ping http_5xx/500"
        status: pass
      - kind: unit
        ref: "tests/worker/engine-check.test.ts#test 4 manual leg — totalChecks 4 on the seeded-3 monitor, lastChecked non-null, manualFlushed true"
        status: pass
      - kind: unit
        ref: "exit-encoded grep gate — monitorFlushUpdateSql >= 2 (import + call site), manualFlushed >= 1, next_check_at assignment count = 0 (no scheduling-column write)"
        status: pass
      - kind: unit
        ref: "tests/worker/persist-tier1.test.ts + tests/worker/persist-tier2.test.ts — 10/10 + 10/10, the reused additive UPDATE and untouched transition SQL stay pinned green"
        status: pass
    human_judgment: false
  - id: D2
    description: "G-06-7 — the live web answers the designed auth ladder after the operator's env-contract fix and §4e web restart: 401 (no header), 401 (wrong-length token), 429 (flood past 30/min); the --baseline RED run had first proven the probe detects the pre-fix 500/500 posture"
    requirement: SEC-03
    verification:
      - kind: other
        ref: "node scripts/probe-telegram-webhook-ladder.mjs (default, 2026-10-01, this close-out leg) -> legs 401/401/429, verdict=PASS, exit 0 vs live web 127.0.0.1:3007; GET /login = 200"
        status: pass
      - kind: other
        ref: "node scripts/probe-telegram-webhook-ladder.mjs --baseline (Task 2, 2026-09-30, pre-fix posture) -> legs 500/500/429, verdict=PASS, exit 0 (RED evidence the instrument is not vacuous)"
        status: pass
      - kind: other
        ref: "secret hygiene — git log 0c014c0..cfe6826 -p scanned for the secret key with a value assignment: 0 matches; git status --porcelain .snapshots/ empty; the probe's read count of the secret env var = 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Runbook §9 carries the env-contract omission lesson (TELEGRAM_WEBHOOK_SECRET mandatory in every future launch-env-contract mint, probe named as the standing instrument) and deferred-items.md records the deliberately deferred healthz posture hardening with rationale"
    requirement: SEC-03
    verification:
      - kind: other
        ref: "grep TELEGRAM_WEBHOOK_SECRET docs/DEPLOY-RUNBOOK.md >= 1; grep 0707-prod-worker-env docs/DEPLOY-RUNBOOK.md >= 1 (Task 2 verify gate, exit 0)"
        status: pass
      - kind: other
        ref: "deferred-items.md new dated DEFERRED item present; item 3 (queue-producer, 06-06's resolution target) untouched"
        status: pass
    human_judgment: false
  - id: D4
    description: "Live UAT re-run of monitor test-2 (repeat check-now on the production stack) — requires the fixed worker artifact deployed; the operator elected NOT to redeploy the worker at this checkpoint, so the live re-run waits for the next release per the plan's own skip-note language (the engine-side pin D1 is the closure proof meanwhile)"
    verification: []
    human_judgment: true
    rationale: "The live-worker redeploy is an operator-side release decision (rebuild + worker restart with operator-managed .env.production entries); until it happens the production worker artifact cannot exhibit the fix, so no executor-side check can close this leg — deferred by design, not blocked."

duration: ~15min (close-out leg)
completed: 2026-10-01
status: complete
---

# Phase 6 Plan 07: UAT Gap Closure (G-06-2 + G-06-7) Summary

**Repeat check-now results now persist in-job via the §16.2 additive follow-up (engine-pinned end-to-end), and the live Telegram webhook ladder answers 401/401/429 after the operator's secret env fix — verified by a tracked, baseline-RED probe**

## Performance

- **Duration:** ~15 min (close-out leg: Task 3 verification + SUMMARY; Tasks 1-2 and the operator checkpoint ran in prior sessions)
- **Started (this leg):** 2026-10-01 (checkpoint resume)
- **Completed:** 2026-10-01
- **Tasks:** 3
- **Files modified:** 5 (321 insertions, 8 deletions across the plan's tracked diff)

## Accomplishments

- **G-06-2 (blocker) closed:** a MANUAL check job whose applyTransition returns applied:false now runs one in-job follow-up — the exported §16.2 additive UPDATE `monitorFlushUpdateSql` with dTotal 1, dFailed (down-class ? 1 : 0), monotonic lastChecked/responseTime — so the D-01 poll (`lastChecked > queuedAt`) completes in seconds for repeat checks. Never writes status or scheduling columns (Pitfall 8 intact); one evidence ping still pairs with one counter increment per delivery (04-05 invariant); zero-row outcomes stay the benign §16.2 no-op (IN-04).
- **G-06-2 pinned end-to-end:** engine-check test 10 (UP-on-UP repeat: manualFlushed, totalChecks 2, UTC-normalized lastChecked > the enqueue's jobId epoch, pings 2, staging key absent), test 11 (DOWN-on-DOWN: failedChecks 1, zero incidents/outbox, ping http_5xx/500), test 4 moved to the new 3→4 contract; persist-tier1 10/10 and persist-tier2 10/10 confirm both persist modules byte-untouched.
- **G-06-7 (major) closed at the posture level:** after the operator appended the §12-attested `TELEGRAM_WEBHOOK_SECRET` to the gitignored launch env contract (`.snapshots/0707-prod-worker-env.sh`) and the orchestrator ran the §4e web restart, the tracked probe observes the designed 401/401/429 ladder live at 127.0.0.1:3007 — no code change to the route (correct per the 06-03 pins).
- **Standing instrument + lessons:** `scripts/probe-telegram-webhook-ladder.mjs` (zero-dependency, secret-blind, default + `--baseline` RED modes) is the permanent re-verification probe; runbook §9 records the env-contract omission lesson (2026-09-24 → 2026-09-30 the correct route answered fail-closed 500 instead of 401); the optional healthz posture hardening is recorded as a deferred backlog item.

## Machine-Observed Verification Evidence

**Before — Task 2 `--baseline` RED run (2026-09-30, pre-fix posture), verbatim:**

```
leg=no-header expected=500 actual=500 PASS
leg=wrong-length expected=500 actual=500 PASS
leg=flood-429 expected=429 actual=429 PASS
verdict=PASS mode=baseline origin=http://127.0.0.1:3007
```

**After — Task 3 default-mode probe (2026-10-01, this close-out leg), verbatim:**

```
leg=no-header expected=401 actual=401 PASS
leg=wrong-length expected=401 actual=401 PASS
leg=flood-429 expected=429 actual=429 PASS
verdict=PASS mode=default origin=http://127.0.0.1:3007
PROBE_EXIT=0
```

Login smoke: `GET http://127.0.0.1:3007/login` → **200**. Legs 1-2 did not trip the limiter, so the ≥60 s re-run contingency was not needed.

**Restart evidence (operator/orchestrator-reported, 2026-10-01):** the operator appended the secret export to `.snapshots/0707-prod-worker-env.sh` (key presence verified, value never displayed) and `bash .snapshots/0709-web-restart.sh` stopped the old web (PID 21632, cmdline-verified kill) and booted the new web through the env contract with login=200. The secret value was operator-handled end to end — no executor ever read, typed, or stored it.

**Plan-level regression sweep (this leg):**

- `pnpm typecheck` — exit 0.
- `pnpm exec vitest run tests/worker/` — 219/220 passed; the single failure is `tests/worker/health.test.ts` "binds 9090" hitting `EADDRINUSE` because the LIVE worker process (PID 35008) holds 127.0.0.1:9090 — an environmental collision with the running production stack, not a regression (this plan touched no health code; the test is 06-02-era). Out-of-scope per the deviation boundary; not fixed, not deferred as plan work.
- `pnpm exec vitest run tests/worker/engine-check.test.ts` (explicit re-run) — 11/11 passed, exit 0.
- Live worker `healthz` → `{"ok":true,"sha":"f71cbdc","builtAt":"2026-09-29T20:55:51.326Z",...}` — healthy, running the pre-fix artifact (see Deferred below).

## Task Commits

Each task was committed atomically:

1. **Task 1: G-06-2 — manual non-transition check results persist in-job** — `2117249` (test, RED) + `2b0b218` (feat, GREEN; engine-check 11/11, persist suites 10/10 + 10/10)
2. **Task 2: G-06-7 instrument — tracked ladder probe + runbook §9 lesson + deferred-hardening record** — `cfe6826` (feat; live baseline RED 500/500/429 captured)
3. **Task 3: G-06-7 operator action + green re-verification** — no tracked-file commit by design (the operator edits the gitignored contract; the executor only re-verifies and records evidence)

**Plan metadata:** the docs close-out commit (SUMMARY + STATE + ROADMAP) — see git log.

_Note: Task 1 was TDD — RED (`2117249`) committed before GREEN (`2b0b218`)._

## Files Created/Modified

- `src/worker/engine/check.ts` — tier1 branch: manual + applied:false follow-up via `monitorFlushUpdateSql` through the job's db handle; `manualFlushed` union member; distinct flush log line; classification comments document the routing and both rejected envelope alternatives
- `tests/worker/engine-check.test.ts` — new tests 10-11, test-4 manual leg re-contracted (3→4), same 30 s timeouts, real queue lane
- `scripts/probe-telegram-webhook-ladder.mjs` — NEW: standing ladder probe (default 401/401/429 / `--baseline` 500/500/429), origin via argv or WEB_ORIGIN, status-codes-only output, never reads the secret env var, header documents the operator fix procedure
- `docs/DEPLOY-RUNBOOK.md` — §9 bullet: the 0707-era contract omission lesson + the probe as standing instrument
- `.planning/phases/06-thin-api-routes-email-abstraction/deferred-items.md` — new dated DEFERRED item (boot-time env checklist / healthz posture field) with rationale; item 3 untouched

## Decisions Made

- Reused-SQL over new SQL: the follow-up calls the exported §16.2 `monitorFlushUpdateSql` verbatim — no new SQL fragment authored; `src/worker/persist/` diff is empty.
- Envelope alternatives rejected in-code: (a) un-guarding the transition UPDATE would fabricate incident.down + a duplicate ONGOING incident on every repeat manual DOWN check and break DAT-04 count-once; (b) Tier-2 delayed staging cannot beat the 30 s poll give-up (D-01 seconds contract) and stageResult is UP-class-only (04-05) so DOWN-on-DOWN cannot stage.
- G-06-7 stayed an operator action: code untouched, probe + docs shipped, secret value never executor-visible.
- Deferrals recorded rather than silently dropped: healthz posture hardening → deferred-items.md (backlog input); worker redeploy → next release (below).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test-10/11 timestamp normalization adapted to the actual driver return shape**
- **Found during:** Task 1 (GREEN, engine-check tests 10-11)
- **Issue:** the plan's literal parse assumed the lastChecked read arrives as a string (space→T + "Z" append); pg returns it as a `Date` already parsed as LOCAL on this +06 host, so the literal form would be 6 h wrong for the Date branch
- **Fix:** the Date branch normalizes via `getTime()` minus the host offset; the string branch keeps the plan's literal T+Z form — the D-01 predicate (`lastChecked` strictly newer than the enqueue epoch) is asserted correctly in both shapes
- **Files modified:** tests/worker/engine-check.test.ts
- **Verification:** engine-check 11/11 green, including both timestamp assertions
- **Committed in:** `2b0b218` (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug). The plan's Task 1 grep gate was also revised pre-execution (`b756c8a`, plan-side docs commit) to the exit-encoded test-form the verify block now uses.
**Impact on plan:** the one auto-fix was necessary for the poll-contract assertion to be truthful on this host; no scope creep.

## Issues Encountered

- `health.test.ts` binds port 9090 for real and collides with the live worker holding it (EADDRINUSE) whenever the production stack is up — environmental, pre-existing interaction, out of this plan's scope (logged here; the IN-01 06-05 precedent records the same deferral "while a steady worker holds 9090").
- The plan's checkpoint pause spanned multiple sessions while phases 07-08 work landed on main (22 interleaved commits after `cfe6826`); the ledger base `0c014c0..HEAD` therefore counts unrelated commits — the plan-scoped count is the 3 task commits + this docs commit.

## User Setup Required

The plan's one user_setup item is COMPLETE (operator, 2026-10-01): `TELEGRAM_WEBHOOK_SECRET` entered into `.snapshots/0707-prod-worker-env.sh` via the contract's file-read pattern and web restarted through the §4e form. No further operator setup is required for this plan.

## Deferred Items

- **Worker redeploy for G-06-2 (optional Task 3 step 3) NOT taken** — the operator elected to skip the rebuild + worker restart, so the live worker (artifact sha `f71cbdc`) does not yet carry the in-job manual persist; the live UAT test-2 re-run is deferred to the next release per the plan's own skip-note language. The engine-side end-to-end pin (tests 10-11 against the real queue lane/Postgres/Redis) is the closure proof meanwhile. Next release must rebuild (`pnpm build`) and restart the worker via `bash .snapshots/0709-worker-restart.sh` so `healthz` reports the new SHA (D-10 provenance).
- **Boot-time env checklist / healthz required-by-feature posture field** — deferred to the backlog (deferred-items.md, unresolved by design): would touch the 07-05-owned healthz surface and needs its own design pass.

## Next Phase Readiness

- Both 06-UAT gaps are closed at the plan's defined level: G-06-2 end-to-end in the engine (live re-run waits for the next worker release), G-06-7 live on the production posture (401/401/429 verified this leg).
- The probe is the standing re-verification instrument for any future env-contract change; runbook §9 prevents recurrence of the omission class.
- Phase 6 is fully executed (7/7 plans + 2 gap-closure plans); tracking moves forward under Phase 8, which owns the current position.

## Self-Check: PASSED

All 6 plan files (5 tracked + this SUMMARY) exist on disk; all 3 task commit hashes (2117249, 2b0b218, cfe6826) verified in git log. Measured actuals from the ledger sentinel: 3 plan-scoped task commits (0c014c0..cfe6826) + this docs close-out commit; plan_head_before 0c014c0 -> plan_head_after cfe6826 (22 unrelated phase-07/08 commits interleaved on main after the checkpoint pause — excluded from the plan count).

---
*Phase: 06-thin-api-routes-email-abstraction*
*Completed: 2026-10-01*
