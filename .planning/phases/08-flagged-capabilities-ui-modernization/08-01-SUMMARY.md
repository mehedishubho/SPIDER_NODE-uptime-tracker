---
phase: 08-flagged-capabilities-ui-modernization
plan: 01
subsystem: worker-db-migrations
tags: [dat-11, windowed-uptime, migration, scheduler, maintenance-lane, rehearsal]
requires:
  - 04-04 D-36 binary-extraction uptime expression (src/worker/maintenance.ts consistencyAuditSql)
  - 03-05 migration rehearsal pipeline (scripts/rehearse-migrations.mjs)
  - Phase-7 carve-out inventory convention (CARVE_OUT_0002 / SANCTIONED_DROPS_0003)
provides:
  - monitors.uptime24h/uptime7d/uptime30d nullable double precision columns (migration 0004, rehearsed)
  - recompute-windowed-uptime maintenance job (D-36-exact math, lifetime counters untouched)
  - RECOMPUTE_WINDOWED_SCHEDULER_ID + RECOMPUTE_WINDOWED_PATTERN ("0 4 * * *") nightly registration
  - WINDOWED_UPTIME_ENABLED read-gate env entry + isWindowedUptimeReadEnabled helper (tests-only consumer)
affects:
  - 08-08 (Release A: production apply of 0004 rides the deploy)
  - v2 PROD-01 display switch (finds populated columns from night one via D-23 backfill)
tech-stack:
  added: []
  patterns:
    - Phase-7 carve-out list-extension rule applied to 0004 (CARVE_OUT_0004_COLUMNS, labeling contract only)
    - nightly recompute on the concurrency-1 maintenance lane at a separated 04:00 UTC cron
key-files:
  created:
    - drizzle/0004_windowed_uptime.sql
    - drizzle/meta/0004_snapshot.json
    - tests/worker/windowed-uptime.test.ts
    - tests/worker/maintenance-windowed.test.ts
    - .planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260930.md
  modified:
    - src/db/schema.ts
    - src/worker/maintenance.ts
    - src/worker/scheduler.ts
    - src/worker/queues.ts (re-export surface untouched; lane constants consumed)
    - .env.example
    - scripts/rehearse-migrations.mjs
    - scripts/schema-gate.mjs (deviation: canonicalizeUptimeWindowProperties)
    - tests/worker/scheduler-flag.test.ts
    - drizzle/meta/_journal.json
key-decisions:
  - "D-22 reversibility gate RESOLVED: user selected 'proceed' (mehedishubho, 2026-09-30) — land the per-window columns via additive migration 0004 through the rehearsal pipeline; production apply rides the Release A deploy in 08-08; nightly recompute runs unconditionally from ship"
  - "RECOMPUTE_WINDOWED_PATTERN = \"0 4 * * *\" (research OQ2) — separated from MAINTENANCE_CLEANUP_PATTERN \"15 3 * * *\" so retention deletes never delay the recompute on the concurrency-1 maintenance lane"
  - "Rehearsal carve-out took the plan's first branch: monitors' digest inventory stays pinned to the pre-0004 column set (columns arrive NULL, digests EQUAL by construction, the 0001 precedent); CARVE_OUT_0004_COLUMNS names them for evidence truthfulness per the CARVE_OUT_0002 labeling convention"
patterns-established:
  - "0004-style additive-column migrations: no inventory edit needed when the migration writes no data — name the columns in a dated carve-out constant instead"
requirements-completed: [DAT-11]
coverage:
  - id: DAT-11-backend
    description: Per-window columns + nightly recompute + scheduler + env entry, rehearsed and gate-green
    requirement: DAT-11
    verification:
      - kind: command
        ref: "pnpm vitest run tests/worker/windowed-uptime.test.ts tests/worker/maintenance-windowed.test.ts tests/worker/scheduler-flag.test.ts"
        status: pass
      - kind: command
        ref: "pnpm rehearse:migrations (verdict PASS, monitors digest EQUAL, DDL delta adds exactly uptime24h/7d/30d, journal rows 5)"
        status: pass
      - kind: command
        ref: "pnpm schema:gate (empty diff, no forbidden tokens)"
        status: pass
      - kind: command
        ref: "grep -c '^WINDOWED_UPTIME_ENABLED=' .env.example → 1"
        status: pass
    human_judgment: false
duration: "split across 2 sessions (Tasks 1-3 + D-22 checkpoint prior session; Task 4 + closeout this leg, ~10 min active)"
completed: 2026-09-30
status: complete
actuals:
  tokens: 20800
  tasks: 4
  commits: 5
plan_head_before: 778624e
plan_head_after: 27eee3b
---

# Phase 8 Plan 01: Windowed Uptime Backend Summary

Per-window uptime columns (uptime24h/7d/30d) with a nightly recompute job on the worker's maintenance lane, landed via additive migration 0004 through the 03-05 rehearsal pipeline — D-36-exact math, lifetime counters byte-unchanged, zero visible change in v1 (D-22/D-24), Release-A-ready for the 08-08 production apply.

## Performance

- **Duration:** split across 2 sessions — Tasks 1-3 (TDD cycles + D-22 checkpoint) prior session; Task 4 (rehearsal + carve-out extension) + closeout this leg, ~10 min active.
- **Started:** prior session (post 778624e plan commit) · **Completed:** 2026-09-30 (UTC)
- **Tasks:** 4/4 · **Files:** 9 production/plan files (+ rehearsal evidence copy + drizzle meta)
- **Tracer gate:** Task 1 verify re-ran end-to-end green (4/4 tests + schema:gate) before expansion (prior session).

## Accomplishments

- **Migration 0004 (purely additive):** three nullable `double precision` columns on monitors (`uptime24h`/`uptime7d`/`uptime30d`) in `drizzle/0004_windowed_uptime.sql` — exactly three `ADD COLUMN "uptime` statements, zero DROP/ALTER COLUMN, no migration-time backfill (D-23: the nightly job's first run IS the backfill).
- **Recompute job:** `processMaintenanceJob` now dispatches `recompute-windowed-uptime` alongside cleanup (unknown names still throw the loud two-name error); the windowed UPDATE pins exactly the three new columns and feeds window-scoped (total, down) counts through the 04-04 D-36 binary-extraction expression verbatim — the numeric half-up `round()` call exists only inside the prohibition comment (maintenance.ts:220-221), never in SQL. Report carries ids/counts only (T-04-28).
- **Scheduler:** fifth `upsertJobScheduler` keyed `RECOMPUTE_WINDOWED_SCHEDULER_ID` at `"0 4 * * *"` (separated from the 03:15 retention pass) with maintenance-lane priority; flag-suite pins updated to one check-tick + TWO maintenance-lane schedulers, idempotent re-upsert pinned (RES-05 lineage). Boot log confirms all five upserted.
- **Env:** `WINDOWED_UPTIME_ENABLED` documented in `.env.example` (Phase-8 dated banner) as a READS-only gate — nothing reads the windowed values in v1; the recompute runs unconditionally regardless (D-22/D-24). Read helper `isWindowedUptimeReadEnabled` exported for the future v2 consumer (tests-only consumer today, per research OQ3 minimal form).
- **Rehearsal (Task 4):** `pnpm rehearse:migrations` PASS against `prod-20260924.dump` (140,066 B): restored DB was pre-0002, so the timed migrate applied 0002+0003+0004 (843 ms wall); monitors digest EQUAL over the pre-migration inventory; DDL delta added columns include exactly `monitors.uptime24h/7d/30d` for 0004; all removals sanctioned 0003; journal rows 5 = journal-derived expectation; D-19 max index build 0.442 ms (plain indexes). Evidence: `.planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260930.md`.
- **Single-runner apply re-proven:** `pnpm exec drizzle-kit migrate` no-op success against the guarded test stack (5453); `pnpm schema:gate` green after the apply — empty diff, no forbidden tokens. `drizzle-kit push` never invoked (DRZ-02).

## Task Commits

1. `af031c5` — test(08-01): add failing tests for the windowed uptime recompute (TDD RED, evidence `RED_EVIDENCE_OK`)
2. `b9d54b2` — feat(08-01): implement windowed uptime recompute behind migration 0004 (TDD GREEN)
3. `a7ea13e` — test(08-01): extend flag-suite pins for the windowed recompute scheduler (TDD RED, evidence `RED_EVIDENCE_OK`)
4. `b2555a7` — feat(08-01): register the nightly windowed recompute scheduler + read-gate env (TDD GREEN)
5. `27eee3b` — feat(08-01): rehearse migration 0004 with the extended carve-out inventory
6. `docs(08-01)` plan-metadata commit (this SUMMARY + STATE/ROADMAP/REQUIREMENTS) — created immediately after this file.

## Files Created/Modified

**Created:** `drizzle/0004_windowed_uptime.sql`, `drizzle/meta/0004_snapshot.json`, `tests/worker/windowed-uptime.test.ts`, `tests/worker/maintenance-windowed.test.ts`, `03-REHEARSAL-EVIDENCE-20260930.md` (phase-03 evidence dir per script convention)

**Modified:** `src/db/schema.ts`, `src/worker/maintenance.ts`, `src/worker/scheduler.ts`, `.env.example`, `scripts/rehearse-migrations.mjs`, `scripts/schema-gate.mjs` (deviation), `tests/worker/scheduler-flag.test.ts`, `drizzle/meta/_journal.json`

## Decisions Made

- **D-22 gate (Task 3, blocking-human) RESOLVED:** user response verbatim "proceed" (mehedishubho, 2026-09-30) — migration 0004 lands through the rehearsal pipeline; production apply rides Release A (08-08); nightly recompute unconditional from ship. Recorded via `state.add-decision`.
- **Cron separation:** `"0 4 * * *"` per research OQ2 so the 03:15 retention delete pass never delays the recompute on the concurrency-1 lane.
- **Carve-out branch choice:** monitors' digest inventory stays pinned to the pre-0004 set (the plan's first branch, 0001 precedent — columns NULL post-migrate, digests EQUAL by construction); `CARVE_OUT_0004_COLUMNS` names the columns in the evidence label per the CARVE_OUT_0002 convention. List extension only — no pipeline logic touched, the FATAL-on-non-sanctioned-removal rule (T-07-32) untouched.

## Deviations from Plan

**1. [Rule 3 - Blocker] schema-gate canonicalization for windowed property names**
- **Found during:** Task 1 (prior session)
- **Issue:** drizzle-kit pull's bundled camelcase@7 uppercases the letter after a digit, rendering `uptime24H/7D/30D` property names that describe physical columns that do not exist — the empty-diff gate would false-fail (same non-adoptable-rendering class as 07-01's `email_verified` rule)
- **Fix:** `canonicalizeUptimeWindowProperties` added to `scripts/schema-gate.mjs` — exact-match narrow, fail-closed preserved
- **Files modified:** scripts/schema-gate.mjs
- **Verification:** `pnpm schema:gate` green (empty diff) across Tasks 1-4
- **Committed in:** b9d54b2

**2. [Rule 1 - Bug] Windowed NULL-shape test corrected**
- **Found during:** Task 1 (prior session)
- **Issue:** windows are cumulative (30d ⊇ 7d ⊇ 24h), so a monitor with pings in an inner window cannot have NULL in an outer window — NULLs can only occur in outer windows; the plan's test framing implied otherwise
- **Fix:** NULL-shape assertions corrected to the cumulative-window reality (A5 nullable shape still pinned)
- **Files modified:** tests/worker/windowed-uptime.test.ts
- **Verification:** suite green (2 tests)
- **Committed in:** b9d54b2

**3. [Plan-prose correction] Column placement follows pull ordinal, not "beside uptimePercent"**
- **Found during:** Task 1 (prior session)
- **Issue:** `ADD COLUMN` appends; the plan's "beside uptimePercent" prose would break the schema:gate column-order comparison against pull output
- **Fix:** the three columns sit at the pull-ordinal position (after `consecutiveFailures`); the gate contract wins over plan prose
- **Files modified:** src/db/schema.ts
- **Verification:** `pnpm schema:gate` empty-diff green
- **Committed in:** b9d54b2

**Total deviations:** 3 auto-fixed/corrected (2 implemented prior session, 1 plan-prose correction). **Impact:** none on the plan's goal — all three resolve plan-prose vs. tooling-reality conflicts in favor of the gate contracts; deliverables unchanged.

## Issues Encountered

- **IN-01 environmental port collision (pre-existing, NOT caused by 08-01):** `tests/worker/health.test.ts` IN-01 case fails with `EADDRINUSE 127.0.0.1:9090` while the LIVE production worker (`node dist/worker.js`) is up. 219/220 worker tests pass; documented environmental failure (IN-01 precedent, 06-05 finding). The live worker was never stopped or restarted.
- **Continuation-note shorthand:** the resume notes referenced `pnpm db:migrate`, but no such script exists — the plan's own command (`pnpm exec drizzle-kit migrate`) was used, matching the single-runner contract.
- **First-use rehearsal startup:** the rehearsal harness had not been exercised this phase; ran clean end-to-end on the first attempt (Docker Desktop already up, postgres:17-alpine cached).

## User Setup Required

None.

## Next Phase Readiness

- **08-02 is next** (UI redesign wave per D-36 build order). DAT-11 backend is code-complete and Release-A-ready: 0004 rehearsed with evidence, single-runner applied on the test stack, both gates green.
- **08-08 (Release A)** applies 0004 to production (backup → single-runner migrate → readyz-gated restarts); the rehearsal evidence file is the deploy input.
- **v2/PROD-01** display switch will find populated columns from night one (D-23 backfill on the first nightly run); `WINDOWED_UPTIME_ENABLED` + the read helper are the documented read-gate surface.
- The night after the production apply, the 04:00 UTC recompute backfills all three windows from retained 30-day ping history.

## Self-Check: PASSED

- Key created files exist: `drizzle/0004_windowed_uptime.sql`, `tests/worker/windowed-uptime.test.ts`, `tests/worker/maintenance-windowed.test.ts`, `drizzle/meta/0004_snapshot.json`, `03-REHEARSAL-EVIDENCE-20260930.md` — all verified `[ -f ]`.
- `git log --oneline --grep="(08-01)"` returns 5 commits (af031c5, b9d54b2, a7ea13e, b2555a7, 27eee3b).
- Task 1 acceptance re-verified: exactly 3 `ADD COLUMN "uptime` occurrences, 0 DROP/ALTER COLUMN in 0004; three nullable `doublePrecision()` columns in schema.ts; no `round(` in SQL (comment-only, maintenance.ts:220-221); dispatch + loud unknown-name pinned by green tests.
- Task 2 acceptance re-verified: `RECOMPUTE_WINDOWED_SCHEDULER_ID="recompute-windowed-uptime"`, `RECOMPUTE_WINDOWED_PATTERN="0 4 * * *"` (≠ "15 3 * * *"); scheduler-flag pins five schedulers (boot log confirms); `grep -c "^WINDOWED_UPTIME_ENABLED=" .env.example` → 1.
- Task 4 acceptance re-verified: carve-out extension in script convention (no pipeline logic change); `pnpm rehearse:migrations` exit 0, PASS, DDL delta carries exactly the three sanctioned 0004 columns; `pnpm schema:gate` green.
- Plan-level verification: 3 test files / 11 tests passed (windowed-uptime 2, maintenance-windowed 3, scheduler-flag 6).

---

*Phase: 8-Flagged Capabilities & UI Modernization · Plan: 01 · Completed: 2026-09-30*
