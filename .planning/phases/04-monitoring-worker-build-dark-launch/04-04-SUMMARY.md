---
phase: 04-monitoring-worker-build-dark-launch
plan: 04
subsystem: worker-persistence
tags: [tier-1, transition-transaction, per-monitor-lock, lua-release, wrk-04, dat-01, dat-04, dat-07, dat-10, uptime-parity, d-35, d-36]

# Dependency graph
requires:
  - phase: 04-monitoring-worker-build-dark-launch
    provides: worker Redis/DB connection profiles + logger (04-01); six-lane queue topology + claim engine (04-02 — the check:{monitorId}:{epoch} jobs whose persistence lands here); CheckOutcome vocabulary + errorClass tokens (04-03 — consumed field-for-field)
provides:
  - applyTransition(input: Tier1Input): Promise<Tier1Result> — the §16.1 literal Tier 1 synchronous transaction (evidence ping FIRST → conditional UPDATE → incident open/resolve → outbox INSERT), duplicate-delivery idempotent (DAT-04)
  - Tier1Input/Tier1Result types — the processor-facing contract 04-06 wires to CheckOutcome (structurally identical, locally defined per the same-wave no-file-overlap rule)
  - transitionUpdateSql/evidencePingSql exported SQL builders — the 04-06 processor and future suites can pin compiled forms via PgDialect
  - OutboxEventType vocabulary — exactly incident.down | incident.recovered | monitor.first_check with the CR-03 nullability contract (down/recovered REQUIRE non-null incident_id)
  - Per-monitor lock API (WRK-04/J-3): acquireMonitorLock/isStillOwner/releaseMonitorLock/withLockRenewal + LockHandle — SET NX PX with crypto.randomUUID owner token, owner-only Lua compare-and-delete release and compare-and-PEXPIRE renewal, TTL 15 s = 10 s timeout + 5 s margin, renewal TTL/3, abort-on-loss onLoss hook
  - The D-36 uptime_percent derivation — the exact-extraction round proven byte-identical to legacy JS toFixed(2) across 73,210 swept ratios (the form 04-07 read paths and any re-derivation must preserve)
affects: [04-06, 04-07, 04-08, 04-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Exact-binary rounding in SQL: to replicate JS toFixed(2) on an IEEE product, extract the double's exact value as a bigint via a power-of-two shift (exponent-bump = exact; integral float8 <= 2^63 casts exactly) and round half-up in arbitrary-precision integer arithmetic — floor((m*100 + 2^(s-1)) / 2^s). Every round()-based form fails: PG float8::numeric collapses to the SHORTEST round-trip decimal, landing exactly ON .xx5 ties"
    - "Owner-token Lua gating (03-01 one-script-per-atomic-op): release = compare-and-DEL, renewal = compare-and-PEXPIRE; client-side GET-then-DEL sequences are forbidden (they can delete a re-acquired key)"
    - "Bounded lock-client profile (maxRetriesPerRequest 1, commandTimeout 2 s) vs BullMQ's null profile — J-3 abort-on-loss is only real if Redis outages surface as fast errors"
    - "globalThis-cached singletons for worker Redis clients (same shape as db-pool) — HMR-safe, test-disposable"
    - "Compiled-SQL source pins: export the drizzle sql` builders and compile with PgDialect().sqlToQuery() so source-form assertions test the real shipped SQL"

key-files:
  created:
    - src/worker/locks.ts
    - tests/worker/locks.test.ts
    - src/worker/persist/tier1.ts
    - tests/worker/persist-tier1.test.ts
    - tests/worker/uptime-parity.test.ts

key-decisions:
  - "D-36 FINAL FORM: the uptime round is NOT round(x::numeric, 2) — the plan's cast/round lever was pushed to its conclusion because BOTH round forms fail 2667/4000 (y=66.675-as-double sits BELOW the decimal tie; exact-rational round half-away gives 66.68, and float8::numeric collapses to the shortest round-trip '66.675' recreating the tie). The shipped expression extracts the double's exact binary value (2^52 shift for y>=1, 2^60 for y<1) and rounds in integer arithmetic; 73,210-ratio sweep (every .xx5 tie for 2^a*5^b totals to 200k + 3,000 randoms) renders byte-identical to legacy JS. The tests were never touched to make a form pass"
  - "Tier1Input is defined LOCALLY (no type import from 04-03's ssrf.ts) — same-wave plans must not create cross-file coupling; 04-06 joins CheckOutcome and Tier1Input structurally"
  - "Event derivation mirrors cron-logic exactly: DOWN from any non-DOWN => incident.down (1-strike); UP from DOWN => incident.recovered; UP from PENDING => monitor.first_check; UP from anything else (schema default 'UNKNOWN') => NO event (legacy sends nothing — behavior parity)"
  - "First-check-DOWN is incident.down, NOT monitor.first_check (cron-logic parity); incident description is the character-exact legacy string `Monitor went down. Status code: ${statusCode || 'Timeout'}`"
  - "Incident resolve has a latest-incident fallback when no ONGOING row survives (retention purged it) so incident.recovered always rides a real incident id (CR-03); incident open has the ON CONFLICT DO NOTHING survivor SELECT (§16.1)"
  - "UP from UNKNOWN derives no event but STILL applies the transition (status/counters/uptime) — the conditional UPDATE and the event derivation are independent layers"
  - "Lock renewal is armed for the ENTIRE job lifetime (never stops at fetch return — a slow §16.1 transaction must not outlive the TTL); isStillOwner is a plain GET compare (read-only, atomicity not required)"
  - "`pnpm test -- <file>` passes the `--` through and runs the WHOLE suite — use `npx vitest run <file>` for single-file isolation"

patterns-established:
  - "Pattern: evidence-before-effects — the ping INSERT always precedes the conditional UPDATE; zero-row UPDATE skips incident/outbox while the ping commits (IN-04: never branch on WHICH cause fired)"
  - "Pattern: idempotency by conditional UPDATE — counters ride the same statement via SQL-relative increments, so a duplicate delivery counts exactly once"
  - "Pattern: live-schema column authority — schema.ts names beat audit prose (pings error_class/status_code snake; monitors consecutive_failures snake next to camelCase quoted columns; outbox ALL snake)"

requirements-completed: [WRK-04, DAT-01, DAT-04, DAT-07, DAT-10]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Per-monitor lock: NX exclusion, owner-only Lua compare-and-delete release + compare-and-PEXPIRE renewal, TTL 15 s (10 s timeout + 5 s margin), TTL/3 renewal cadence, isStillOwner flip on loss, onLoss exactly once (WRK-04, J-3)"
    requirement: WRK-04
    verification:
      - kind: unit
        ref: "tests/worker/locks.test.ts#1-8 (real docker Redis :6390, ioredis never mocked, real timers for TTL/renewal)"
      status: pass
    human_judgment: false
  - id: D2
    description: "Tier 1 transition transaction: all four transition paths (PENDING->UP first_check, UP->DOWN 1-strike incident, DOWN->UP resolve+recovered, PENDING->DOWN), evidence-first ordering, conditional WHERE gate, counters/uptime/next_check_at in the UPDATE (DAT-01)"
    requirement: DAT-01
    verification:
      - kind: integration
        ref: "tests/worker/persist-tier1.test.ts#2-5 (real docker Postgres :5453, raw-SQL seeds)"
      status: pass
    human_judgment: false
  - id: D3
    description: "Duplicate delivery: second evidence ping commits, zero-row UPDATE, exactly one ONGOING incident, one outbox row, counters advanced once; deactivated + deleted monitors take the same no-op paths (DAT-04, IN-04, §15.1 step-1)"
    requirement: DAT-04
    verification:
      - kind: integration
        ref: "tests/worker/persist-tier1.test.ts#6-8"
      status: pass
    human_judgment: false
  - id: D4
    description: "No INSERT supplies an id (gen_random_uuid() defaults only) and every inserted row carries a non-null DB-generated UUID; error_class/status_code ride the evidence ping (DAT-07, DAT-10)"
    requirement: DAT-07
    verification:
      - kind: integration
        ref: "tests/worker/persist-tier1.test.ts#1,9 + #2-3 (ping metadata assertions)"
      status: pass
    human_judgment: false
  - id: D5
    description: "uptime_percent byte parity with the legacy JS toFixed(2) rendering across the mandated ratio set plus every .xx5 tie class (exact-double 3.125/15.625; inexact-double 66.675/0.005/0.015) — character-compared, never tolerance-based (D-36/CR-01)"
    requirement: DAT-01
    verification:
      - kind: integration
        ref: "tests/worker/uptime-parity.test.ts (16 cases incl. source-form pin; 73,210-ratio offline sweep documented in tier1.ts header)"
      status: pass
    human_judgment: false

# Metrics
duration: ~23.5 min single session (1408s)
completed: 2026-09-14
status: complete
---

# Phase 4 Plan 4: Tier-1 Transition Persistence + Per-Monitor Locks Summary

**The §16.1 literal synchronous transition transaction (evidence-ping-first, conditional-UPDATE-gated, incident/outbox-riding, duplicate-idempotent) plus the WRK-04 owner-token Lua lock, with the D-36 uptime derivation proven byte-identical to legacy JS toFixed(2) via exact binary extraction — 33 worker-proof cases green on the real docker Postgres/Redis**

## Session Notes

Single-session sequential execution across the compaction boundary. Tasks 1 and 2 were green on their committed forms; Task 3's parity suite then exposed that EVERY round()-based uptime form fails inexact-double .xx5 ties, and the plan's own D-36 lever ("adjust the SQL, never the test") was driven to the exact-extraction conclusion (see Deviations 3). Full `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm verify` re-run green end-to-end after the Rule 1 typecheck fix (lint 0 errors, typecheck, 170 vitest, schema:gate, worker:boundary, Next build + tsup worker bundle, 18/18 e2e).

## Performance

- **Duration:** ~23.5 min (1408s)
- **Started/Completed:** 2026-09-13T21:04:25Z → 2026-09-13T21:27:53Z
- **Tasks:** 3/3
- **Files created:** 5 (all inside the plan's files_modified list)

## Accomplishments
- WRK-04 per-monitor lock: `lock:check:{monitorId}` key, crypto.randomUUID owner token, SET NX PX acquire, ONE compare-and-delete Lua release + ONE compare-and-PEXPIRE Lua renewal (03-01 discipline), TTL 15 s = 10 s timeout + 5 s margin (§15.3 non-negotiable formula), TTL/3 renewal armed for the whole job lifetime, abort-on-loss onLoss fired exactly once (J-3) — proven with real timers on the real Redis
- The bounded lock-client profile (maxRetriesPerRequest 1, commandTimeout 2 s, connectTimeout 1 s) keeps J-3's abort path fail-fast — deliberately NOT the BullMQ null profile (T-04-13 mitigated)
- DAT-01/DAT-04 Tier 1 transaction: statement order evidence-ping → conditional UPDATE (`WHERE id AND status <> target AND "isActive"`) → incident lifecycle → outbox INSERT; counters ride the UPDATE via SQL-relative increments; zero-row UPDATE skips effects while evidence commits (IN-04 — no branching on cause); incidents_one_ongoing partial-unique ON CONFLICT DO NOTHING is the physical backstop (T-04-14 mitigated)
- All four transition paths + duplicate redelivery + deactivated + deleted monitors proven on the real Postgres; incident description is the character-exact legacy string incl. the `Timeout` no-response fallback (T-04-15 mitigated)
- Outbox events carry the 01-06 vocabulary with CR-03 nullability enforced in code (down/recovered REQUIRE a non-null incident_id; first_check is monitor-scoped NULL by design) (T-04-16 mitigated)
- D-36 parity: the shipped uptime expression renders byte-identically to legacy JS at 2 decimals for the full mandated ratio set AND the complete inexact-tie class; the two low-tie cases (0.005 from above, 0.015 from below) pin the sub-1 branch

## Task Commits

1. **Task 1: per-monitor lock module + proof** — `f1de29d` (feat)
2. **Task 2: Tier 1 transition transaction + proof** — `2545ce6` (feat)
3. **Task 3: D-36 parity suite + SQL adjustment** — `2a39cfc` (test)
4. **Rule 1 fix: lock-test null assertions (found by pnpm verify typecheck)** — `c4f5a3b` (fix)

## Files Created/Modified
- `src/worker/locks.ts` — LOCK_TTL_MS/LOCK_RENEWAL_DIVISOR, lockKey, LOCK_RELEASE_LUA/LOCK_RENEW_LUA, LockRedis typed view, globalThis-cached locksRedis/disposeLocksRedis, acquireMonitorLock, isStillOwner, releaseMonitorLock, withLockRenewal
- `tests/worker/locks.test.ts` — 8 cases on the real Redis: source forms, NX exclusion, non-owner no-op, owner release, TTL expiry, renewal survival, isStillOwner flip, onLoss-once
- `src/worker/persist/tier1.ts` — OutboxEventType, Tier1Input/Tier1Result, evidencePingSql, transitionUpdateSql (D-35 in-UPDATE uptime derivation), monitorContextSql, incident open/resolve + fallbacks, outboxInsertSql, deriveEventType, applyTransition
- `tests/worker/persist-tier1.test.ts` — 9 cases: source form (DAT-07/DAT-10 pins), the four transition paths, duplicate delivery, deactivated, deleted, UUID audit
- `tests/worker/uptime-parity.test.ts` — 16 cases: legacyRendering baseline vs stored-value toFixed(2), character-compared, across 15 ratios + source-form pin

## Decisions Made
See key-decisions in the frontmatter. The load-bearing ones for downstream plans:
- 04-06's processor MUST call acquire → withLockRenewal (job lifetime) → isStillOwner immediately before applyTransition → release in finally (J-3; the lock is a performance guard, correctness stays with the claim + conditional UPDATE)
- Never reintroduce `round(x::numeric, 2)` for uptime — the parity suite will fail 2667/4000 and 3/20000; the exact-extraction form is pinned by source-form tests in BOTH suites
- The outbox payload shape (monitorName/monitorUrl/statusCode/responseTimeMs/errorClass/occurredAt/userTimezone/claimEpoch) is what 04-08's relay renders from — extend, never rename

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] live column names diverged from the audit's prose in pings**
- **Found during:** Task 2 first run — INSERT failed 42703 (`column "errorClass" of relation "pings" does not exist`); the live 0001-added columns are error_class/status_code (snake)
- **Fix:** column lists corrected in tier1.ts and the test row-types; schema.ts re-confirmed as the naming authority (also monitors.consecutive_failures — snake — surfaced in the same pass)
- **Files modified:** src/worker/persist/tier1.ts, tests/worker/persist-tier1.test.ts
- **Verification:** 9/9 green
- **Committed in:** 2545ce6

**2. [Rule 1 - Bug] typecheck failures in the lock suite (null-narrowing)**
- **Found during:** plan-level `pnpm verify` — `withLockRenewal(handle, ...)` passed `LockHandle | null` at cases 6/8 (vitest does not typecheck, so the Task 1 run missed it)
- **Fix:** `handle!` assertions matching the pattern used elsewhere in the suite
- **Files modified:** tests/worker/locks.test.ts
- **Verification:** `tsc --noEmit` clean; full verify chain green end-to-end
- **Committed in:** c4f5a3b

**3. [Rule 1 - D-36 lever] the uptime round is exact binary extraction, not a round() cast chain**
- **Found during:** Task 3 — the plan's Task 2 form `round((...)::numeric, 2)::double precision` failed the 2667/4000 parity case (stored 66.68, legacy displays "66.67"); the float-first variant failed the SAME case because PG's float8→numeric conversion collapses onto the shortest round-trip decimal ("66.675"), recreating the tie the true binary expansion (66.6749999999999972) sits below
- **Fix:** per the plan's own D-36 rule (adjust the SQL, never the test), the shipped expression multiplies the computed double by 2^52 (y>=1) / 2^60 (y<1) — exact exponent bumps — casts the integral product to bigint exactly, and rounds half-up in arbitrary-precision integer arithmetic: floor((m*100 + 2^(s-1)) / 2^s). Offline sweep: 73,210 ratios (every .xx5 tie for 2^a*5^b totals up to 200,000 + 3,000 random non-terminating ratios) render byte-identically to the legacy JS. Source-form pins in both suites updated to track the shipped form
- **Files modified:** src/worker/persist/tier1.ts, tests/worker/persist-tier1.test.ts, tests/worker/uptime-parity.test.ts
- **Verification:** 33/33 worker cases green (16 parity incl. both low-tie directions); full verify chain green
- **Committed in:** 2a39cfc

---

**Total deviations:** 3 auto-fixed (2 Rule 1 bugs, 1 Rule 1 parity-driven SQL adjustment executed through the plan's own documented D-36 lever). No scope creep: every change lands inside the plan's files_modified list.

## Issues Encountered
- `pnpm test -- <file>` passes the literal `--` through to vitest and runs the whole suite — `npx vitest run <file>` is the isolation command (superset runs are green anyway)
- The parity investigation needed live diagnostics on both engines (node `toFixed` vs psql `::numeric` expansion) to identify the shortest-round-trip collapse; the evidence is transcribed into the tier1.ts module header so the reasoning survives the session

## User Setup Required

None.

## Threat Flags

None — no security-relevant surface beyond the plan's threat_model. All four register rows (T-04-13..T-04-16) carry their mitigations in this plan's code/tests.

## Self-Check: PASSED

All 5 created files exist on disk; all 4 task commits (f1de29d, 2545ce6, 2a39cfc, c4f5a3b) present in git log.
