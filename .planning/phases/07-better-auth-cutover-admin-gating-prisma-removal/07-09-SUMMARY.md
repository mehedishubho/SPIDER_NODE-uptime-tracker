---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 09
subsystem: database
tags: [drop-release, migration, drizzle, legacy-tables, d-32, auth-07, phase-closeout, deploy]

# Dependency graph
requires:
  - phase: 07-better-auth-cutover-admin-gating-prisma-removal (07-08)
    provides: the DEPLOYED deletion release (healthz sha eaa5a4d, record §16.4), the four legacy tables intact read-only (D-32 substrate), the restored production topology, AUTH-07's literal "then dropped" clause open
provides:
  - Migration 0003 (drizzle/0003_drop_legacy_auth_tables.sql) — the additive-inverse drop release: the four legacy NextAuth-era tables dropped WITH their data (D-27), rehearsed on the anonymized snapshot BEFORE production (twice PASS), sanctioned drop list asserted in-header and pipeline-enforced (T-07-32)
  - The DROP is DEPLOYED to production per runbook §4e — journal 3→4, information_schema census: legacy_left=0, substrate users 5 / account 5 / session 3 / verification 0 intact, post-drop canary re-login 200 + authenticated /api/monitors 200, monitoring continuity proven (pings 4084→4086, 0 error lines)
  - src/db/schema.ts reconciled to the post-0003 shape — schema:gate green (empty diff, 10 tables) on the migrated test DB
  - Runbook §4e (drop-release choreography) authored AND executed; the pre-drop pg_dump documented as the ONLY rollback artifact (no un-drop migration exists)
  - Phase closeout in 07-DEPLOY-RECORD.md §18: DRZ-07 final proof (0/9 banned deps, prisma dirs absent, armed gate 426 files, schema:gate green) + per-requirement dispositions for all 13 phase IDs + D-05 final status + sanctioned-delta reconciliation notes
  - AUTH-07 CLOSED — the phase's 13/13 requirements are now Complete
affects: [phase verification/UAT (07), Phase 8 planning (WINDOWS #4 open item), the standing drop-release stack]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 16500    # chars/4 over the realized diff (11 files, +1557/−94 vs ledger base 6271598)
  tasks: 3         # all three plan tasks complete (Task 1 resumed from an interrupted prior session's uncommitted work — verified, completed, committed)
  commits: 3       # MEASURED: git rev-list --count 6271598..HEAD (5f33b51 + 5993bf2 + 6789c98)
plan_head_before: 62715988c6bffef1e7787ab3b1672e9804b8e4a1
plan_head_after: 6789c98668ec7e6ad123e866c1b812bf78b55982

# Tech tracking
tech-stack:
  added: []        # zero new packages — a drop release
  patterns:
    - "Additive-inverse drop release: the contract half of expand/contract lands as its own tiny migration AFTER the deletion release's soak; the pre-drop pg_dump replaces the redeploy lever as the rollback form (the old artifact's fallback substrate no longer exists)"
    - "Sanctioned-drop rehearsal carve-out: the migration pipeline extends its carve-out INVENTORY ONLY (03-05 precedent) — dropped tables render BEFORE-count-as-rows-dropped with no AFTER digest, the DDL delta sanctions exactly the named removals and stays FATAL on anything else, D-19 goes N/A for a drop-only applied set"
    - "Journal-derived test substrate skip: integration cases seeding a physically-dropped table self-skip via it.skip keyed on the committed journal, with their historical proof cited — the skip is recorded in the broken-windows ledger, never silent"

key-files:
  created:
    - drizzle/0003_drop_legacy_auth_tables.sql
    - drizzle/meta/0003_snapshot.json
    - .planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260929.md
    - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-09-SUMMARY.md
  modified:
    - drizzle/meta/_journal.json (idx 3)
    - src/db/schema.ts (four legacy declarations removed; header reconciled)
    - scripts/rehearse-migrations.mjs (sanctioned-drop carve-out + post-drop inventory + D-19 drop-only N/A)
    - tests/integration/cutover-migration.test.ts (legacy-substrate cases 2-3 journal-derived skip)
    - tests/setup/seed.ts (truncate list loses the four gone tables)
    - eslint.config.mjs (.planning/** ignore — Rule-3 unblock)
    - docs/DEPLOY-RUNBOOK.md (§4e authored)
    - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-DEPLOY-RECORD.md (§17 execution record + §18 closeout)

key-decisions:
  - "Precondition reconciliation recorded (§17.1): the D-32 short soak was MET — deletion release deployed 2026-09-29T14:53Z with all §4d smoke legs green, legacy tables retained read-only across one full release (flip 2026-09-24T19:00Z → deletion 2026-09-29T14:53Z), the drop inherits the D-36 approval per the plan, and the dispatch briefing instructed the drop explicitly"
  - "Production drop executed by the executor with machine evidence (07-08 deploy-leg precedent): backup → migrate → readyz-gated worker restart → web restart → census + canary + continuity, every leg recorded in §17.3 with dated values"
  - "Rollback form change authored into §4e: there is NO un-drop migration — the pre-drop backup (pre-0709-drop-20260929-1556.dump, 153,839 B, archive-verified) is the ONLY revert; §7's redeploy lever dies with the legacy tables by design"
  - "Rehearsal pipeline Rule-1 fix kept minimal: a drop-only applied set (journal-derived) records D-19 as N/A standing on the additive rehearsals instead of failing the probe — nothing else in the pipeline restructured (03-05 extends-the-list-only rule)"
  - "AUTH-07 closed at closeout (REQUIREMENTS.md checkbox + traceability): 13/13 phase requirements Complete — DRZ-07 final proof re-run green at §18.1"

patterns-established:
  - "Drop-release census: the information_schema legacy_left + substrate-count query is the deploy's own drop proof, stamped pre-migrate, post-migrate, and post-restart"
  - "Build-env teardown discipline held for a third release: gitignored .env.production used for the build, deleted immediately after, never committed"

requirements-completed: [AUTH-07, DRZ-07]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Migration 0003 authored (exactly the four sanctioned drops, D-27 data-drops-with-tables) and rehearsed on the anonymized snapshot BEFORE production (rehearse-first, 03d/DRZ-06 discipline)"
    requirement: AUTH-07
    verification:
      - kind: other
        ref: "pnpm rehearse:migrations — REHEARSAL PASSED (journal rows 4, migrate 923 ms, evidence .snapshots/rehearsal-20260929.md + committed copy 03-REHEARSAL-EVIDENCE-20260929.md; DDL delta = exactly the four table removals + their 10 indexes; post-drop inventory present)"
        status: pass
      - kind: other
        ref: "drizzle/0003_drop_legacy_auth_tables.sql header asserts the T-07-32 sanctioned list and that users + the Better Auth tables are untouched"
        status: pass
    human_judgment: false
  - id: D2
    description: "src/db/schema.ts reconciled to the post-0003 shape; schema/DB agreement proven (the declaration removal and the drops match exactly)"
    requirement: DRZ-07
    verification:
      - kind: other
        ref: "pnpm exec drizzle-kit migrate (test DB) + pnpm schema:gate — green, empty diff, 10 tables / 91 columns / 9 indexes / 8 FKs"
        status: pass
      - kind: unit
        ref: "tests/integration/cutover-migration.test.ts — legacy-substrate cases 2-3 self-skip (journal-derived); remaining cases green (07-08-era run 394 passed / 2 skipped)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Runbook §4e authored: pre-flight → backup (the ONLY rollback artifact) → migrate → artifact → worker-first readyz restart → web restart → post-proofs"
    requirement: AUTH-07
    verification:
      - kind: other
        ref: "pnpm exec rg -c \"4e\" docs/DEPLOY-RUNBOOK.md → 2 (non-zero)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The drop DEPLOYED to production per §4e: backup → migrate (journal 3→4) → readyz-gated worker restart → web restart → census legacy_left=0 with substrate intact → post-drop canary re-login 200 + /api/monitors 200 → monitoring continuity (pings 4084→4086, 0 error lines)"
    requirement: AUTH-07
    verification:
      - kind: other
        ref: "07-DEPLOY-RECORD.md §17.3 — full §4e ledger with dated evidence (backup archive-verified 15 TABLE DATA; healthz sha 5f33b51; Bull Board 403 unauth; census re-stamped post-restart)"
        status: pass
    human_judgment: true
    rationale: "The legs are machine-verified, but the release itself is an irreversible production-data deletion (D-27 sanctioned): the human surfaces are the operator's dispatch authorization for this plan, the D-36 approval it inherits, and UAT review of the census/canary evidence — the record preserves every value so the judgment is one read away"
  - id: D5
    description: "Phase closeout: DRZ-07 final proof (armed gate green, Prisma dirs absent, 0/9 banned deps, schema:gate green) + 13-requirement disposition table + D-05 final status + sanctioned-delta reconciliation notes"
    requirement: DRZ-07
    verification:
      - kind: other
        ref: "pnpm cron:remnants — GREEN 426 files (.snapshots/0709-final-gate.log); banned-dependency node assertion — CLEAN 0 of 9 (output pasted in §18.1); prisma/ + src/generated/prisma + src/lib/prisma.ts — absent"
        status: pass
      - kind: other
        ref: "pnpm schema:gate — green (empty diff); rg count of AUTH-0|DRZ-07|EML-04|SEC-04|OBS-04 in 07-DEPLOY-RECORD.md → 28"
        status: pass
    human_judgment: false

# Metrics
duration: ~17 min (this close-out session; Task 1 resumed an interrupted prior session's verified uncommitted work)
completed: 2026-09-29
status: complete
---

# Phase 7 Plan 09: Drop Release — Legacy Table Retirement & Phase Closeout Summary

**The four legacy NextAuth-era tables are physically dropped from production WITH their data per D-27 — rehearsed first on the anonymized snapshot, deployed per runbook §4e with the pre-drop backup as the sole rollback artifact, post-drop canary re-login green — and the phase closes with all 13 requirements Complete, AUTH-07's "retained read-only one release, then dropped" satisfied literally.**

## Performance

- **Duration:** ~17 min (close-out session; Task 1 resumed from the interrupted prior session)
- **Started:** 2026-09-29T15:46Z · Task-1 artifacts authored + rehearsed in the prior session; deploy leg 2026-09-29T15:46–15:58Z
- **Completed:** 2026-09-29T16:03Z
- **Tasks:** 3 complete
- **Files:** 11 changed (+1557/−94) vs ledger base 6271598

## Accomplishments

- **Task 1 (`5f33b51`):** 0003 authored (house header, exactly four `DROP TABLE IF EXISTS ... CASCADE` statements, D-27 data-drops-with-tables, users.password stays inert); schema.ts reconciled (legacy declarations gone, pull format preserved); the rehearsal pipeline extended by carve-out inventory only — dropped tables render BEFORE-count-as-rows-dropped, the DDL delta stays FATAL on any non-sanctioned removal (T-07-32), D-19 goes N/A for a drop-only set, evidence gains the post-drop row/table inventory; **rehearsed TWICE PASS on the snapshot** (journal rows 4, post-drop inventory recorded) after a Rule-1 fix to the D-19 probe guard; test-DB migrate + schema:gate green (empty diff, 10 tables)
- **Task 2 (`5993bf2`):** runbook §4e authored AND executed — pre-drop backup `pre-0709-drop-20260929-1556.dump` (153,839 B, archive-verified) → `drizzle-kit migrate` exit 0 (journal **3→4**) → artifact BUILD_ID `FhPbRPfKnOTQR4IwjSQx6` (worker sha256-16 `098908730ae95df9`) → worker restart **readyz 200** (healthz sha `5f33b51`, Bull Board 403 unauth) → web restart `/login` 200 → **census: 10 public tables, `legacy_left=0`, substrate users 5 / account 5 / session 3 / verification 0 intact** → **canary re-login 200 + authenticated `/api/monitors` 200 AFTER the drop** (T-07-33) → armed gate GREEN on the deployed tree → monitoring continuity (pings 4084→4086, checks 15:54:12/15:55:42/15:57:12Z UP, relay every 5 s, 0 error lines). Record §17 filled (precondition reconciliation §17.1, Task-1 evidence §17.2, §4e ledger §17.3, teardown §17.4)
- **Task 3 (`6789c98`):** phase closeout §18 — DRZ-07 final proof (banned-dependency assertion **CLEAN 0 of 9**, `prisma/` + `src/generated/prisma` + `src/lib/prisma.ts` **absent**, armed gate **GREEN 426 files**, schema:gate **green**); the 13-requirement disposition table with evidence citations (AUTH-07 closes here); D-05 final status (blast script deleted, `AUTH_NOTICE_*` env entries REMOVED, strip count 0); reconciliation notes (D-30 window loss, A4 toast delta, D-24 sign-in-limit, D-28 revoke-on-reset, WINDOWS ledger state)

## Task Commits

1. **Task 1: Author 0003 + reconcile schema + rehearse on the snapshot** - `5f33b51` (feat)
2. **Task 2: Runbook §4e + production drop deploy + post-proofs** - `5993bf2` (feat)
3. **Task 3: Phase closeout — DRZ-07 final proof + requirement dispositions** - `6789c98` (docs)

## Files Created/Modified

See the frontmatter key-files block. Highlights:
- `drizzle/0003_drop_legacy_auth_tables.sql` — the additive-inverse drop release
- `src/db/schema.ts` — post-0003 shape (the four legacy declarations removed)
- `scripts/rehearse-migrations.mjs` — sanctioned-drop carve-out + post-drop inventory
- `docs/DEPLOY-RUNBOOK.md` §4e — the drop-release choreography (authored AND executed)
- `07-DEPLOY-RECORD.md` §17/§18 — execution record + phase closeout

## Decisions Made

See `key-decisions` frontmatter — the load-bearing calls: the D-32 precondition reconciled on the record (deletion deployed + one-release read-only retention + inherited D-36 approval + explicit dispatch instruction); the executor-executed production legs with machine evidence (07-08 deploy-leg precedent); §4e's rollback-form change (backup-only, no un-drop); the minimal pipeline fix for drop-only D-19; AUTH-07 closed at closeout making the phase 13/13.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Rehearsal D-19 probe false-failed on the drop-only applied set**
- **Found during:** Task 1 (rehearsal run 1, prior session) · **Issue:** the drop-only migration set contains zero CREATE INDEX statements; the probe guard read the empty capture as a broken probe and failed the rehearsal · **Fix:** derive the pending set from the journal + last-applied journal row; a drop-only set records "D-19: N/A — stands from the additive rehearsals (0001 max 0.841 ms, 0002 max 0.46 ms)" · **Files:** scripts/rehearse-migrations.mjs · **Verification:** runs 2+3 REHEARSAL PASSED · **Committed in:** `5f33b51`

**2. [Rule 3 - Sweep] Test-side substrate co-fixes for the migrated world**
- **Found during:** Task 1 · **Issue:** cutover-migration cases 2-3 seed/read the legacy `accounts` table (physically gone once 0003 is committed); the test seed truncate-lists four now-nonexistent tables · **Fix:** journal-derived `it.skip` for cases 2-3 (proof role cited: 07-06 record §10, §13.3/§16.6) recorded in the WINDOWS ledger; truncate list loses the four tables · **Files:** tests/integration/cutover-migration.test.ts, tests/setup/seed.ts · **Committed in:** `5f33b51`

**3. [Rule 3 - Blocking] eslint scanning untracked .planning/ harness tooling**
- **Found during:** Task 1 verify chain (prior session) · **Issue:** untracked planning-harness generator scripts under .planning/ trip lint · **Fix:** globalIgnores += `.planning/**` (07-08 tool-dir precedent) · **Files:** eslint.config.mjs · **Committed in:** `5f33b51`

**4. [Rule 3 - Blocking] Host pg_restore absent for backup verification**
- **Found during:** Task 2 step 2 · **Issue:** `pg_restore` is not on the Windows host PATH (pg_dump ran via docker exec; the redirect put the archive on the host) · **Fix:** verified the archive INSIDE the container (docker cp + `pg_restore --list` exit 0, 15 TABLE DATA entries) · **Files:** none (procedure note in record §17.3) · **Committed in:** `5993bf2` (recorded)

---

**Total deviations:** 4 auto-fixed (1 Rule 1, 3 Rule 3; zero Rule 4 escalations). **Impact on plan:** all four were verify-chain unblocks or evidence-procedure details; zero scope growth — the diff landed ~half of the 32K-token estimate.

## Issues Encountered

- **Task 1 resumed from an interrupted prior session:** the migration, schema reconciliation, pipeline extension, test co-fixes, and rehearsal evidence existed uncommitted (rehearsal run 2 PASS in `.snapshots/0709-rehearsal-run2.log`); this session re-verified (rehearsal run 3 PASS first-hand, test-DB migrate + schema:gate green, typecheck clean) and committed atomically rather than redoing.
- **Continuity-window cadence note:** the first 70 s continuity window showed no ping delta because the interval-1 monitor checks on a ~90 s cadence (15:54:12 → 15:55:42 → 15:57:12); the wider window confirmed pings 4084→4086 UP — recorded plainly so the momentary 4084→4084 read is not mistaken for a stall.
- **Operator action still outstanding (carried):** the operator's password remains the §16.6-minted value in gitignored `.snapshots/0708-operator-password.txt` (used for the post-drop canary re-login leg) — change it at next login.

## User Setup Required

None - no external service configuration required. (Carried flag: the operator should still change the machine-minted password from §16.6 A.2.)

## Next Phase Readiness

- **Phase 7 execution is COMPLETE (9/9 plans):** flip (§13) → deletion (§16) → drop (§17) all deployed and evidenced; 13/13 requirements Complete (AUTH-07 closed by this plan); the database carries no dead auth surface.
- **Ready for `/gsd-verify-work 07`** (the verifier will harvest this plan's Task-2 human-check: operator review of the drop evidence + canary) and then `/gsd-plan-phase 8`.
- **WINDOWS ledger:** #1-#3 closed; open count 2 — #4 (profile-route password surface, Phase-8 scope) and #5 (the by-design journal-derived test skip, recorded this plan, proof citations embedded).
- The standing stack runs the drop release (web :3007 / worker :9090 / Redis :6391 / DB :5454); the pre-drop backup remains the documented revert path.

---

## Self-Check: PASSED

Re-verified at close-out (2026-09-29T16:0xZ):

1. **Task 1 verify** — `pnpm rehearse:migrations` exit 0 (run 3, first-hand this session; journal rows 4, post-drop inventory in the evidence); `docker compose test up --wait` + `drizzle-kit migrate` + `pnpm schema:gate` exit 0 (empty diff, 10 tables); typecheck clean
2. **Task 2 verify** — `rg -c "4e" docs/DEPLOY-RUNBOOK.md` = 2; production evidence in record §17.3 (backup 153,839 B archive-verified, journal 4, legacy_left=0, canary 200 post-drop, continuity green)
3. **Task 3 verify** — `rg -c "AUTH-0|DRZ-07|EML-04|SEC-04|OBS-04" 07-DEPLOY-RECORD.md` = 28; `pnpm cron:remnants` GREEN (426 files); `pnpm schema:gate` green
4. **Commits exist** — `git rev-list --count 6271598..HEAD` = 3 (`5f33b51`, `5993bf2`, `6789c98` measured from the ledger)
5. **Key files exist** — drizzle/0003_drop_legacy_auth_tables.sql, drizzle/meta/0003_snapshot.json, 03-REHEARSAL-EVIDENCE-20260929.md, this SUMMARY
6. **Requirement honesty** — AUTH-07 checked off in REQUIREMENTS.md (checkbox + traceability) via requirements mark-complete; DRZ-07 was already complete (07-08); phase now 13/13
7. **Windows ledger** — entry #5 (skipped-test, by design) appended this plan; open count 2 (#4 Phase-8 scope, #5 with proof citations)

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-29 (drop release deployed per runbook §4e — legacy tables gone with their data, post-drop canary green, phase 13/13)*
