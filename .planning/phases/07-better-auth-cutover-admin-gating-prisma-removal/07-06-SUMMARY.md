---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: "06"
subsystem: infra
tags: [better-auth, rehearsal, pg_dump, anonymization, drizzle-migrations, bcrypt, canary, rollback-drill, deploy-runbook]

requires:
  - phase: 07-01..07-05
    provides: the Better Auth engine, admin gating (role + Bull Board), email hooks, and login notice strip this plan rehearsed end-to-end
  - phase: 03-05
    provides: the rehearsal pipeline (throwaway restore -> digest -> additive-only gate) extended here, not replaced
provides:
  - Count-agnostic rehearsal bookkeeping + 0002 digest inventory (WR-05 carry-forward closed)
  - Canary-designating anonymizer (D-37) — exactly one real-email account with a known legacy bcrypt hash
  - Full D-34 flip rehearsal evidence (legs 1-8) in 07-DEPLOY-RECORD.md
  - D-35 redeploy-rollback drill evidence — rollback = redeploy-only, drilled not argued
  - D-06 operator-approved cutover copy (verification/reset/announcement bytes, notice strip, D-22 refusal)
  - Runbook §4c "Phase-7 flip release" (backup -> migrate -> seed-admin-roles -> readyz -> web -> canary + D-07/D-11/D-15)
affects: [07-07, 07-08, 07-09, phase-8-planning]

actuals:
  tokens: 13274   # chars/4 over the realized diff f9592fa..HEAD (estimate was 48000 — evidence-heavy plan, small code delta)
  tasks: 3
  commits: 6      # measured: git rev-list --count f9592fa..HEAD

tech-stack:
  added: []
  patterns:
    - count-agnostic migration bookkeeping (report N + journal-derived range, never a hard-coded count)
    - canary-designated anonymization reconciling the anonymizer with the D-09 zero-match abort
    - rollback-by-redeploy drill choreography: previous release artifact rebooted against the post-migration schema

key-files:
  created:
    - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-DEPLOY-RECORD.md
    - .planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260923.md
    - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-06-SUMMARY.md
  modified:
    - scripts/rehearse-migrations.mjs
    - scripts/anonymize-snapshot.mjs
    - docs/DEPLOY-RUNBOOK.md
    - src/app/(authLayout)/login/page.tsx
    - tests/setup/seed.ts

key-decisions:
  - "D-40 needs a synthetic-fixture pass: the fresh production snapshot has ZERO OAuth rows, so the pure per-provider comparison is a vacuous zero/zero — three clearly-synthetic rows (2 google incl. one NULL refresh_token, 1 github) on a throwaway database make the token-preservation property non-vacuous"
  - "The D-35 drill artifact is the exact production HEAD 51a9fbb built in a clean worktree (05-07 precedent), not a stand-in approximation — healthz sha provenance proves the previous release itself ran against the post-0002 schema"
  - "The stand-in (DB :5461 + re-flipped web/worker) stays RUNNING for the remaining phase-7 plans; both rehearsal-only .env.production files (main tree + legacy worktree) were deleted at close-out per the recorded teardown item"

patterns-established:
  - "Rehearsal evidence legs land in 07-DEPLOY-RECORD.md with per-leg UTC dates, exact statuses, and gitignored byte-artifact hashes — no narrative greens"
  - "Rollback drills rebuild the previous release from its commit, never from memory of what it contained"

requirements-completed: [AUTH-02, AUTH-05]

coverage:
  - id: D1
    description: "WR-05 closure: count-agnostic rehearsal bookkeeping + 0002 digest inventory (account/session/verification + users.role/email_verified)"
    requirement: AUTH-05
    verification:
      - kind: other
        ref: "pnpm rehearse:migrations — REHEARSAL PASSED (9 tables verified, journal rows 3, migrate 785 ms) re-run 2026-09-23T22:47Z"
        status: pass
      - kind: other
        ref: "pnpm exec rg -c 'email_verified|account|session|verification' scripts/rehearse-migrations.mjs > 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Refreshed anonymized snapshot with the D-37 canary designation — exactly one real-email account holding a known legacy bcrypt hash"
    requirement: AUTH-02
    verification:
      - kind: manual_procedural
        ref: "07-DEPLOY-RECORD.md §2 — restore exit 0, canary pre-check exactly-1, anonymizer bcrypt.compare OK, independent post-commit compare PASS, email census 1 non-anon"
        status: pass
    human_judgment: false
  - id: D3
    description: "Full D-34 flip rehearsal on the stand-in (migration, admin seed + D-09 abort, web+worker boot, canary login, admin gates, Bull Board matrix, email round-trips, notice strip)"
    requirement: AUTH-02
    verification:
      - kind: manual_procedural
        ref: "07-DEPLOY-RECORD.md §3-§9 — per-leg dated evidence with HTTP statuses and byte-artifact hashes"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-40 snapshot leg: per-provider pre/post reshaped row counts and non-null refresh/access token counts match"
    requirement: AUTH-05
    verification:
      - kind: other
        ref: "node .snapshots/0706-leg8-d40.mjs — VERDICT PASS (pure-snapshot zero/zero + synthetic-fixture MATCH per provider; legacy tables invariant)"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-06 operator copy sign-off — verification/reset/announcement bytes, notice strip render, D-22 refusal copy approved as rendered"
    verification:
      - kind: other
        ref: "07-DEPLOY-RECORD.md §9 — 'D-06 copy approved by operator (mehedishubho), 2026-09-24'"
        status: pass
    human_judgment: true
    rationale: "Copy approval is a human judgment call by design (D-06) — the operator must read the rendered bytes; automation can only prove which bytes were inspected"
  - id: D6
    description: "D-35 redeploy-rollback drill — previous artifact rebooted against the post-0002 schema, legacy engine verified, re-flip verified"
    verification:
      - kind: manual_procedural
        ref: "07-DEPLOY-RECORD.md §11 — 51a9fbb healthz sha provenance, readyz 200, NextAuth credentials login 200 + authenticated API 200, re-flip login/gate/Bull Board green"
        status: pass
    human_judgment: false
  - id: D7
    description: "Runbook §4c 'Phase-7 flip release' — backup, single-runner migrate, seed-admin-roles with D-09 abort note, readyz-gated worker restart (:9090 gains Bull Board), web restart, D-31 canary preview, D-07 slip rule, D-11 grant/revoke SQL, D-15 feedback curl"
    verification:
      - kind: other
        ref: "pnpm exec rg -c 'D-07|D-11|D-15|seed-admin-roles' docs/DEPLOY-RUNBOOK.md -> 15"
        status: pass
    human_judgment: false

duration: ~24h elapsed (3 executor sessions; two operator checkpoints between — dump delivery + D-06 copy approval)
completed: 2026-09-24
status: complete
plan_head_before: f9592faa0a55df5cfca80cc963409fb98af0a974
---

# Phase 7 Plan 06: Rehearsal — snapshot refresh, canary designation, full flip rehearsal + rollback drill Summary

**The Phase-7 auth flip was rehearsed end-to-end on a canary-designated anonymized snapshot — WR-05-fixed count-agnostic machinery, a non-vacuous D-40 token-preservation proof, a drilled redeploy-only rollback against the exact production HEAD, operator-approved cutover copy, and an executable runbook §4c.**

## Performance

- **Duration:** ~24h elapsed across 3 executor sessions (Tasks 1-2 session, Task 3 legs 1-7 session ending at the D-06 checkpoint, legs 8-13 close-out session)
- **Started:** 2026-09-22T22:44Z (first plan commit)
- **Completed:** 2026-09-23T22:48Z (UTC)
- **Tasks:** 3/3
- **Files modified:** 8

## Accomplishments

- WR-05 carry-forward closed: rehearsal bookkeeping is count-agnostic (journal-derived expectation, no hard-coded Phase-3 count) and the digest carve-out inventory names the 0002 objects (account/session/verification + users.role/email_verified)
- Fresh production snapshot (prod-20260924.dump, D-34) anonymized with the new D-37 canary designation — exactly one real-email account with a known rounds-10 bcrypt hash, reconciling the anonymizer with the D-09 zero-match abort
- Full D-34 flip rehearsal on the stand-in, every leg green with dated evidence: 0002 applies (1.1 s, additive-only), admin seed + D-09 zero-match abort proven, web AND worker booted (Pitfall-7 init validation live), canary old-password login through Better Auth, admin gate matrix (401/200/403), Bull Board allowlist matrix incl. static-asset + non-allowlisted refusal + 5 D-16 audit lines, verification/reset round-trips + announcement blast dry-run on the console provider, notice strip rendered live
- D-40 snapshot leg PASS — per-provider reshaped counts and non-null token counts match, proven non-vacuously with synthetic OAuth fixtures (one NULL-refresh row propagates as NULL); legacy tables invariant pre/post (D-30 substrate)
- D-35 rollback drill PASS — the exact previous release (51a9fbb, what production runs) rebuilt in a clean worktree, rebooted against the post-0002 stand-in: worker readyz + healthz sha provenance, NextAuth credentials login 200, authenticated API read 200 from untouched tables, then re-flip fully verified (login, feedback gate, Bull Board)
- D-06 operator copy approval recorded (2026-09-24) with the inspected byte-artifact hashes
- Runbook §4c authored: the operator-executable Phase-7 flip sequence with the D-07 slip rule, D-11 grant/revoke SQL one-liner (sign-out/in note), and the D-15 feedback curl

## Task Commits

Each task was committed atomically (continuation session included):

1. **Task 1: WR-05 rehearsal-machinery fix + digest inventory extension** - `3a1f1dc` (fix)
2. **Handoff: 07-04 e2e seed fixture email_verified boolean** - `3579f32` (test, first-session rider)
3. **Task 2: Snapshot regeneration with the D-37 canary designation** - `b066404` (feat; record skeleton + anonymizer + rehearse canary probe)
4. **Task 3 (leg 7 Rule-1 fix): /login force-dynamic** - `8ed37bd` (fix)
5. **Task 3 (legs 1-7): rehearsal evidence + D-06 checkpoint state** - `1ad434f` (docs)
6. **Task 3 (close-out): D-06 approval, D-40 leg, D-35 drill, runbook §4c** - `521eeee` (docs)

**Plan metadata:** (this commit)

## Files Created/Modified

- `scripts/rehearse-migrations.mjs` - count-agnostic bookkeeping assertion + 0002 carve-out inventory + canary sanity probe
- `scripts/anonymize-snapshot.mjs` - CANARY_EMAIL/CANARY_PASSWORD designation (bcryptjs rounds 10, in-transaction write + post-write compare)
- `tests/setup/seed.ts` - e2e seed sets the email_verified boolean (07-04 handoff)
- `src/app/(authLayout)/login/page.tsx` - `export const dynamic = "force-dynamic"` (notice strip)
- `docs/DEPLOY-RUNBOOK.md` - new §4c Phase-7 flip release
- `.planning/phases/07-.../07-DEPLOY-RECORD.md` - created: topology + legs 1-8 + D-35 drill + D-06 approval
- `.planning/phases/03-.../03-REHEARSAL-EVIDENCE-20260923.md` - committed copy of the fresh rehearsal PASS evidence
- `.planning/phases/07-.../07-06-SUMMARY.md` - this file

## Decisions Made

- D-40 synthetic-fixture pass added (see Deviation 3): the fresh dump's empty legacy `accounts` table made the pure comparison vacuous — three synthetic OAuth rows on the throwaway database give the token-preservation claim real content
- D-35 drill uses the exact production HEAD `51a9fbb` (clean worktree build, healthz sha provenance) rather than any approximation — the drill must prove THE artifact an operator would redeploy
- Stand-in left running (DB :5461, re-flipped web :3007 / worker :9090) for the remaining phase-7 plans; both rehearsal-only `.env.production` files deleted at close-out (teardown item honored — the production flip build must inline the production origin, never these stand-in values)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] /login static prerender froze the notice strip out of every production build**
- **Found during:** Task 3 leg 7 (notice strip render)
- **Issue:** `/login` was statically prerendered, baking the no-window `null` in forever — unrenderable in any production build; the 07-04 e2e had only exercised dev mode
- **Fix:** `export const dynamic = "force-dynamic"` on the login page, rebuild, web reboot
- **Files modified:** src/app/(authLayout)/login/page.tsx
- **Verification:** strip verified live in a real browser (outerHTML + screenshot)
- **Committed in:** 8ed37bd

**2. [Rule 3 - Blocking] Stand-in build needed a gitignored `.env.production` for NEXT_PUBLIC_* values**
- **Found during:** Task 3 leg 3 (stand-in boot)
- **Issue:** Next's prerender workers did not inherit shell-exported NEXT_PUBLIC_* on this Windows spawn path
- **Fix:** gitignored `.env.production` (NEXT_PUBLIC_ENV + NEXT_PUBLIC_BASE_URL) for the rehearsal build
- **Files modified:** (gitignored file — never committed)
- **Verification:** build succeeded; strip + client surfaces rendered with the stand-in origin
- **Committed in:** n/a — **teardown executed at close-out:** the file is DELETED; the production flip build must inline the production origin

**3. [Rule 2 - Missing Critical] D-40 would have been a vacuous proof on this snapshot**
- **Found during:** Task 3 leg 8 (D-40)
- **Issue:** the fresh production dump's legacy `accounts` table is EMPTY (zero OAuth rows) — the mandated per-provider comparison would pass 0==0 and prove nothing about token preservation
- **Fix:** added a second pass inserting 3 clearly-synthetic OAuth rows (2 google — one with NULL refresh_token — 1 github) pre-migrate on the throwaway database; counts and non-null token counts must then match per provider
- **Files modified:** .snapshots/0706-leg8-d40.mjs (gitignored rehearsal helper)
- **Verification:** VERDICT PASS — google 2/1/2, github 1/1/1, credential 5/0/0 all MATCH; NULL refresh propagates as NULL
- **Committed in:** evidence in 521eeee (§10)

**4. [Rule 3 - Blocking] Legacy (51a9fbb) build failed without REDIS_URL at build time**
- **Found during:** Task 3 D-35 drill (previous-artifact build)
- **Issue:** the 06-era module-scope throw-early redis client aborts page-data collection for /api/auth/forgot-password when REDIS_URL is unset
- **Fix:** extended the worktree-local gitignored `.env.production` with stand-in DATABASE_URL/REDIS_URL + console/dummy values
- **Files modified:** (worktree-local gitignored file — worktree removed at teardown)
- **Verification:** build exit 0; both artifacts produced
- **Committed in:** n/a

---

**Total deviations:** 4 auto-fixed (1 Rule 1, 2 Rule 3, 1 Rule 2)
**Impact on plan:** All fixes necessary for the rehearsal/drill to prove what the plan mandates. No scope creep — deviation 3 strengthens an existing must-have rather than adding one.

## Issues Encountered

- Windows `git worktree remove --force` deregistered the legacy worktree but could not delete the directory (node_modules locks) — completed with a manual `rm -rf` of the scratch directory after deregistration; `git worktree list` confirms only the main tree remains
- Pre-existing dirty files (`skills-lock.json`, `tests/resilience/observations.json`) and untracked `.claude/skills/`, `.planning/research/.cache/` were present before this plan's sessions and were left untouched (out of scope)

## Authentication Gates

None — no external-service auth gates were hit (all rehearsal legs used the local stand-in; OAuth flows intentionally never executed).

## User Setup Required

The plan's `user_setup` item (fresh production pg_dump, D-34) was satisfied **during** the plan: the operator delivered `.snapshots/prod-20260924.dump` before Task 2 (recorded in 07-DEPLOY-RECORD.md §1-§2; never committed). No pending external configuration from this plan. (Project convention: operator-satisfied user_setup items are recorded in SUMMARY/deploy records — no separate USER-SETUP file exists across this milestone's 55 completed plans.)

## Teardown / Environment Notes

- Rehearsal-only `.env.production` (main tree) — **deleted** (the recorded teardown item; any production build must inline the production origin)
- Legacy build worktree `devsroom-uptime-tracker-legacy51a9fbb` + its `.env.production` — **removed**
- Throwaway rehearsal/d40 containers — torn down in `finally` by their scripts
- Stand-in intentionally LEFT RUNNING for 07-07..07-09: DB `spidernode-standin-07` (:5461), re-flipped web (:3007) and worker (:9090) on the new artifact — verified green at close-out (login 200, readyz ok). Note: a future rebuild of the stand-in web requires recreating a stand-in `.env.production` (deviation 2 finding)

## Next Phase Readiness

- 07-06 unblocked the production flip runbook path: §4c is executable and every step of it has stand-in evidence
- The stand-in is live for 07-07+ (its DB carries the migrated snapshot + canary + stand-in non-admin row; both rehearsal passwords remain in gitignored `.snapshots/`)
- 07-07 carries its own `user_setup` items (per its frontmatter) — operator-facing, unchanged by this plan
- D-40's production angle (canary OAuth logins without re-consent) is baked into §4c step 8's checklist verbatim — it executes at flip, not before

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-24*

## Self-Check: PASSED

All key files exist on disk (SUMMARY, both scripts, runbook, deploy record, evidence copy, login page); all 6 task commits verified present; `git log --grep=07-06` returns 6; plan verifications re-run green (`pnpm rehearse:migrations` PASSED, §4c element grep = 15).
