---
phase: 01-design-gate-review-verdict-ready
plan: "03"
subsystem: infra
tags: [resilience, circuit-breaker, bullmq, redis, better-auth, bcrypt, cookiecache, pg-pool, connection-budget, design-spec]

requires:
  - phase: 01-design-gate-review-verdict-ready
    provides: "Plan 01-01 (§11 DDL schema addendum, §16 literal-SQL writer specs, §23 data-correctness test cases) and plan 01-02 (§14 scheduler/queue topology, §15 check-job spec, §23 SSRF/classification cases) — §13's breaker references §15.1 step 5's infra-failure classification and §14.2's tick steps; §12's field maps must align with §11's table markers"
provides:
  - "Audit §13 rewritten as the resilience spec: D-11 breaker state machine (CLOSED/OPEN/HALF_OPEN with write_guards breaker:probe: key), R-1 pause-by-design with dead-man's-switch detection and UI staleness, J-5 backlog asymmetry, D-14 best-effort ~7-day DLQ with UnrecoverableError, RES-05 numbered Redis-restart recovery, D-7 batched retention deletes with dry-run, RDS-01/RDS-03 client config and hardening"
  - "Audit §12 expanded into the full auth spec: four D-09 field-mapping tables against the verified Better Auth 1.7 core schema, A-1 bcrypt hash-prefix routing + canary gate + lazy rehash, A-2 cookieCache 5-min TTL, A-3/S-3 admin roles + D-13 manual-check rate limit, S-2 Telegram webhook secret_token decision note, forced re-login recorded as decided"
  - "New audit §25 PostgreSQL connection budget: web 10 POOLED / worker 20 DIRECT / migrations 1 DIRECT (DAT-09 non-negotiable), pinned pg Pool timeouts, pooled-vs-direct string split, DRZ-05 shared-single-pool transition rule"
  - "Global stale-sentence sweep returns zero across the entire audit (fallback-write path, alert:sent: key, interval+slack TTL, scheduledAt token, repeatable-job wording)"
affects: [01-design-gate-review-verdict-ready, phase-04-worker-orchestration, phase-07-auth-cutover, phase-03-drizzle-migration]

tech-stack:
  added: []  # documentation phase — no packages installed
  patterns:
    - "Breaker probe = dedicated synthetic write_guards insert keyed breaker:probe:{ts} (never a replay of a failed real write)"
    - "DLQ retention worded as a lower bound (>= ~7 days best-effort) because BullMQ KeepJobs eviction has no background timer"
    - "Field-map confidence column with explicit 'confirm by Phase 7 dry-run' markers on cells the design cannot yet guarantee"
    - "Connection-budget numbers are pools-per-process, not ORMs — both ORMs share one pg Pool during transition"

key-files:
  created: []
  modified:
    - docs/ARCHITECTURE-AUDIT.md

key-decisions:
  - "§25 placed as a new top-level section after §24 (ops region) rather than between §16/§17 — mid-numbering insertion would renumber §17–§24 and break cross-references already committed by plans 01-01/01-02"
  - "Breaker state lives in the worker process (module scope); restart resets to CLOSED — safe because the first infra-failure re-arms it within one tick"
  - "statement_timeout pinned 30 s on web+worker pools (sized above the 5000-row retention-delete pass) but explicitly UNSET on the migration runner (CREATE INDEX CONCURRENTLY / backfills legitimately run long)"
  - "DSGN-01 intentionally NOT marked complete in REQUIREMENTS.md — this plan delivers 3 of the 8 §8 addenda; the deploy runbook (8th) lands in plan 01-04, which also lists DSGN-01 and performs the final marking"

patterns-established:
  - "Amendment markers carry the plan's prescribed §9 item-number citations verbatim (issue IDs are the load-bearing traceability tokens)"
  - "Failure-mode tables pair every behavioral spec (breaker, Redis restart) with failure → detection → response → recovery rows (D-07)"

requirements-completed: []  # DSGN-01 spans plans 01-03 + 01-04 (runbook addendum pending); marked by 01-04

coverage:
  - id: D1
    description: "Audit §13 resilience spec — breaker state machine, pause-by-design, backlog cap, DLQ, Redis-restart recovery, retention deletes, client hardening"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: "grep -nE 'falls back to writing routine pings|alert:sent:|interval \\+ slack' docs/ARCHITECTURE-AUDIT.md → empty; grep -nE 'repeatable job' → empty; grep -n 'scheduledAt' → empty"
        status: pass
      - kind: other
        ref: "grep -c 'HALF_OPEN' → 4 (>= 2); grep -c 'noeviction' → 4 (>= 1); grep -c 'UnrecoverableError' → 2 (>= 1); grep -c 'breaker:probe:' → 6"
        status: pass
    human_judgment: false
  - id: D2
    description: "Audit §12 auth spec — four Better Auth field-mapping tables, bcrypt gate, cookieCache, roles, S-2 note, decided cutover items"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: "grep -c 'emailVerified' → 4 (>= 3); grep -c 'providerId' → 6 (>= 3); grep -c 'cookieCache' → 5 (>= 2); grep -c 'confirm by Phase 7 dry-run' → 2 (>= 1); grep -c 'X-Telegram-Bot-Api-Secret-Token' → 1 (>= 1)"
        status: pass
    human_judgment: false
  - id: D3
    description: "New audit §25 PostgreSQL connection budget — 10/20/1 pool pins, timeout options, pooled-vs-direct split, D-10 pinning table"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: "grep -c 'connectionTimeoutMillis' → 2 (>= 1); grep -c 'idle_in_transaction_session_timeout' → 2 (>= 1); grep -cE 'pooled|POOLED' → 3 (>= 2); grep -cE 'Amended 2026-|Added 2026-' → 10 (>= 9)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cross-section coherence: breaker infra-failure class matches §15.1 step 5 verbatim; §12 account columns align with §11 markers; budget numbers match DAT-09 (10/20/1)"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: "grep confirms §13 line 'Infra-failure is exactly the class §15.1 step 5 defines — Postgres unreachable, Redis unavailable, internal exceptions/bugs' matches §15.1 'Only infrastructure failures throw — Postgres unreachable, Redis unavailable, internal exceptions/bugs'; §11 decision 6 defers account to §12; §25.1 rows read 10/20/1"
        status: pass
    human_judgment: false

duration: 9m 20s
completed: 2026-09-09
status: complete
---

# Phase 01 Plan 03: Platform Design Slice (Resilience + Auth + Connection Budget) Summary

**Audit §13 rewritten as the failure-mode resilience spec (breaker/backlog/DLQ/Redis-outage/recovery), §12 expanded into the full Better Auth field-map spec, and a new §25 connection budget — with every review-rejected sentence swept from the entire audit.**

## Performance

- **Duration:** 9m 20s
- **Started:** 2026-09-08T20:22:58Z
- **Completed:** 2026-09-08T20:32:18Z
- **Tasks:** 3/3
- **Files modified:** 1 (docs/ARCHITECTURE-AUDIT.md)

## Accomplishments

- **§13 is now the resilience spec (per D-11/D-14/R-1/D-7):** CLOSED → 5 consecutive infra-failures → OPEN 60 s (pauses enqueueing AND `Queue.pause()`; never pauses the heartbeat) → HALF_OPEN single synthetic `write_guards` probe keyed `breaker:probe:{ts}` → CLOSED/re-OPEN. Redis outage is pause-by-design with healthchecks.io dead-man's-switch detection and "last checked Xm ago" UI staleness — no fallback sentence survives anywhere. Backlog cap (~2x active monitors) drops only routine enqueues; DLQ retention worded as ≥ ~7 days best-effort with `UnrecoverableError` for permanent failures; numbered 5-step Redis-restart recovery; looped 5000-row batched retention deletes with mandatory dry-run; two-connection ioredis client config with AOF/noeviction/70%-alert hardening; D-07 failure-mode tables (breaker + restart) and a D-10 pinning table.
- **§12 is now the full auth spec (per D-09):** four field-mapping tables (users/session/account/verification) against the research-verified Better Auth 1.7 core schema with a confidence column; boolean `emailVerified` truthiness backfill (`IS NOT NULL`); the `providerId` google/github casing cell carries the explicit **confirm by Phase 7 dry-run** marker; upstream issue #8111 FK-schema-key warning; `advanced.database.generateId` pinned to agree with §11/D-3. A-1 bcrypt gate (hash-prefix routing, canary ordered snapshot → production → flip, lazy rehash), A-2 cookieCache (5 min TTL, `disableCookieCache` on sensitive endpoints, DB fallback), A-3/S-3 roles (admin plugin, admin-only feedback, Bull Board admin + IP allowlist) plus the D-13 manual-check rate-limit numbers (1/monitor/30 s, 6/min/user), S-2 constant-time `X-Telegram-Bot-Api-Secret-Token` check, and forced re-login recorded as DECIDED with its Q-4 announcement requirement.
- **New §25 connection budget (per D-08/D-03):** web 10 POOLED / worker 20 DIRECT / migrations 1 DIRECT — non-negotiable per DAT-09, total ≤ 31 against the Neon ~104 assumption with a verify-tier instruction; `connectionTimeoutMillis` pinned 10000 with the default-0-means-no-timeout rationale; `statement_timeout` 30000 (sized above the worst legitimate writer — the 5000-row retention pass) and `idle_in_transaction_session_timeout` 30000, both explicitly unset on the migration runner; pooled-vs-direct string split and the DRZ-05 one-pool-per-process transition rule.

## Task Commits

Each task was committed atomically:

1. **Task 1: §13 rewrite + resilience spec** - `4ad560a` (docs)
2. **Task 2: §12 auth spec expansion** - `e0bf04a` (docs)
3. **Task 3: Connection-budget section** - `8afd66a` (docs)

**Plan metadata:** see final commit below (docs: complete plan)

## Files Created/Modified

- `docs/ARCHITECTURE-AUDIT.md` — §13 fully rewritten (key inventory modernized to match §14/§15/§16, ten subsections added); §12 expanded (marker, 3 new constraint items, six subsections with four field-map tables); new §25 before Appendix A; exec-summary scheduler row and §20 M7/M8 rows de-staled.

## Decisions Made

- **§25 placement:** appended as a new top-level section after §24 (end of the §22–§24 ops/deployment region) instead of inserting after §16 — insertion mid-numbering would renumber §17–§24 and break cross-references already committed by plans 01-01/01-02 (e.g. §17 cited from §14's queue table and §22; §23 from §15; §24 from §19). The plan made numbering discretionary; recorded here per its instruction.
- **Breaker state location:** worker-process module scope; restart resets to CLOSED. Safe because the first infra-failure re-arms it within one tick; also makes the pause independent of Redis state surviving a restart (§13.9 row 5).
- **Migration runner exempt from `statement_timeout`:** `CREATE INDEX CONCURRENTLY` and backfill migrations legitimately exceed the 30 s web/worker pin — a timeout there would abort migrations mid-flight.
- **§9 item-number citation scheme:** the plan's prescribed marker strings use its own §9 item numbering (e.g. "§9 item 20" for D-8; the literal checklist line for D-8 is 13). Markers were written exactly as prescribed because the plan's acceptance criteria check those strings verbatim and the issue IDs (the load-bearing traceability tokens) are correct; numbering follows the plan's citation scheme consistently.
- **DSGN-01 not yet marked complete** — 7 of 8 §8 addenda now exist; the deploy runbook lands in 01-04, which also lists DSGN-01 and performs the marking.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] De-staled two §20 risk-table rows referencing removed mechanisms**
- **Found during:** Task 1 (§13 rewrite)
- **Issue:** The global sweep requirement ("every stale sentence gone from the ENTIRE audit") extended beyond §13's lines: M7's mitigation cell still cited the deleted "routine-ping fallback write" (semantically re-asserting the R-1-rejected path), and M8 still used the legacy "repeatable-job" vocabulary ("Repeatable jobs are declarative…") that BullMQ 6 removed. Neither would necessarily trip a case-sensitive grep, but both are residual contradictions per research Pitfall 1 — exactly what the fresh-agent re-review hunts.
- **Fix:** M7 now cites pause-by-design + dead-man's-switch + staleness UI; M8 now cites Job Schedulers via `upsertJobScheduler` at boot and claim-epoch jobIds. The exec-summary "at a glance" table row ("BullMQ repeatable jobs + worker") — a literal `repeatable job` grep match outside §13 — became "BullMQ Job Schedulers + worker".
- **Files modified:** docs/ARCHITECTURE-AUDIT.md (lines 32, M7, M8)
- **Verification:** `grep -nE "repeatable job"` returns empty across the audit; re-read of M7/M8 confirms no fallback or legacy-vocabulary reference.
- **Committed in:** 4ad560a (part of Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1; covering three stale locations outside §13 proper)
**Impact on plan:** Required by the plan's own global-sweep must-have. No scope creep.

## Issues Encountered

- The plan's §9 item-number citations diverge from the literal checklist line numbers (documented under Decisions Made). Resolved by following the prescribed marker strings verbatim; issue-ID traceability greps all pass (J-5, J-6, R-1, D-4, D-7, A-1..A-3, S-2, S-3, D-8 each appear in ≥ 1 "resolves" marker).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 7 of 8 §8 addenda now live in the audit with D-02 markers (10 markers total; 8 distinct addendum topics incl. §23 tests). Plan 01-04 (deploy runbook + §22 pointer + full §9 self-trace) can proceed directly; its "≥ 8 distinct amendment markers" precondition is already satisfied.
- The stale-sentence sweep over the audit returns zero — 01-04's re-run of the sweep should stay green as long as the runbook task does not reintroduce rejected wording.
- Phase 4/5 implementers get pinned numbers for every resilience tunable; Phase 7 gets a field map whose only open cells are the explicit dry-run markers.
- DSGN-01 formally completes in 01-04 (runbook = 8th addendum); DSGN-02 completes in 01-05 (verdict flip).

## Self-Check: PASSED

- `01-03-SUMMARY.md` exists on disk.
- Task commits verified in git history: `4ad560a` (Task 1), `e0bf04a` (Task 2), `8afd66a` (Task 3).

---
*Phase: 01-design-gate-review-verdict-ready*
*Completed: 2026-09-09*
