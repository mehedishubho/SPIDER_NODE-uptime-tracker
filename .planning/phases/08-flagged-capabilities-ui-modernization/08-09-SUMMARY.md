---
phase: 08
plan: 09
subsystem: ui-tier2-sidebar
tags: [ui-03, tier-2-sweep, sidebar-reconciliation, token-migration, emerald-rose-ternaries, skeleton-loading, micro-interactions, light-mode, both-themes, e2e]
requires:
  - 08-05 per-mode token substrate (--accent-cyan light #0e7490, --muted-meta, 3:1 light border family; consumed unchanged — zero globals.css edits this plan)
  - 08-04 tier-1 sweep (shared skeleton pattern, motion/stagger discipline, animate-status-pulse/animate-alert-pulse keyframes)
  - 02-08 token system + zero-hex gate form (sanctioned list: globals.css, mail.ts, render.ts, LoginForm, RegisterForm, global-error.tsx)
provides:
  - Tier-2 surfaces (public status, /dashboard/incidents, /dashboard/status, /dashboard/profile) fully on the token substrate in BOTH themes — emerald/rose ternaries migrated to status-up/status-down, slate/white hardcodes gone, skeleton loading everywhere, D-28 micro-interactions
  - Sidebar reconciliation: NavMain inactive state routes through the sidebar primitive's own tokens (text-sidebar-foreground/70 + hover:bg-sidebar-accent/hover:text-sidebar-accent-foreground); the active-nav cyan tint/text/border state byte-intact (reserved accent item 1)
  - tests/e2e/light-mode.spec.ts extended to 13 tests (6 new tier-2 both-theme legs: populated/empty/404/skeleton, light+dark token resolution, whole-surface raw-palette sweeps)
  - Seed helpers: seedMonitor gains a DOWN status param; seedResolvedIncident added (RESOLVED half the incidents legs needed)
affects:
  - 08-08 (Release B ships the tier-2 surfaces + reconciled sidebar; UI-05 completes there)
  - 08-10 (phase close / UAT consumes the both-theme legs; deferred-items.md carries the NavUser/Navbar-rose/Pagination dispositions)
tech-stack:
  added: []
  patterns:
    - "Both-theme e2e assertion: assert in forced light -> forceDarkTheme (a later-registered init script overrides the beforeEach light-setter) -> reload -> re-assert the SAME token resolutions — proves theme-independence of the token wiring, not just one palette"
    - "Deterministic skeleton observation: page.route(pattern, () => new Promise(() => {})) keeps the load fetch pending forever so the skeleton state is asserted without race"
    - "Regex classList sweep (expectNoRawPaletteClasses): catches variant-prefixed raw utilities (hover:bg-slate-800/50) that exact-class matching misses; scoped per surface (body for the bare-root-layout public page, the min-h-screen root for incidents) so sidebar chrome stays in its own lanes"
    - "Sidebar token reconciliation = swap the raw classes onto the primitive's own vocabulary; cn/tailwind-merge means surface classes override primitive variants, so the swap must name the sidebar tokens explicitly rather than relying on primitive defaults"
actuals:
  tokens: 25036   # chars/4 over the realized 7-file diff (vs 26000 estimated)
  tasks: 2
  commits: 2      # plan commits 0d05bb4 + b2e280d; ledger window measured 3 (see Performance — one concurrent non-plan commit)
plan_head_before: e9d557f52fb837558b68e21d10f3fdda158daa6b
plan_head_after: b2e280d6f060317c1d6d1af76a917090dfeed7da
key-files:
  created: []
  modified:
    - src/components/Status/PublicStatus.tsx
    - src/components/Dashboard/Incidents.tsx
    - src/components/Dashboard/DashboardStatus.tsx
    - src/components/Dashboard/ProfileComponent.tsx
    - src/components/dashboardLayout/NavMain.tsx
    - tests/e2e/light-mode.spec.ts
    - tests/setup/seed.ts
key-decisions:
  - "Salvage verdict on the usage-limit-terminated prior session: the 6-file uncommitted tier-2 state was kept WHOLE after verification — every referenced token/animation utility exists on the 08-05 substrate, typecheck/lint clean, all Task-1 acceptance criteria green unmodified; nothing needed completing or correcting. Task 2 (sidebar) was untouched by the dead session and executed fresh here."
  - "NavMain inactive branch maps to the sidebar primitive's own vocabulary (text-sidebar-foreground/70 + hover:bg-sidebar-accent hover:text-sidebar-accent-foreground) — closest visual match to the muted slate idle state in both themes while routing through sidebar tokens; the active-nav cyan classes stay byte-intact per reserved accent item 1 and T-08-31."
  - "bg-black/60 scrims in ProfileComponent (avatar-upload hover overlay, delete-modal backdrop) deliberately kept — scrims over content, not surfaces; black reads correctly in both modes and is outside the plan's forbidden vocabulary (emerald/rose/slate/white)."
  - "Incidents empty state keeps the production copy 'All Clear!' verbatim — the Copywriting Contract preamble keeps existing strings unless a row overrides; the 'Clean History' row names the monitor-detail incidents surface, not this page."
  - "Indigo (member-since) and sky (telegram) accents in ProfileComponent kept — the 02-08 carry-forward is emerald/rose status vocabulary only; non-status accent hues were never in any migration mandate."
  - "tests/setup/seed.ts modified beyond the plan's declared file list (Rule 3): the spec extension's incidents legs require the RESOLVED-half seed helper and a DOWN-capable seedMonitor; tests/api and tests/worker remain byte-untouched (the actual criterion)."
  - "Out-of-plan discoveries logged to the phase deferred-items.md instead of swept: NavUser.tsx raw utilities, Navbar.tsx rose-400, Pagination.tsx dead component, and the app-wide emerald/rose survey — the plan file list is the binding scope; sweeping them would have exceeded it."
patterns-established:
  - "forceDarkTheme init-script override for same-test both-theme legs — reusable wherever a future leg needs dark re-assertion after light assertions"
  - "Never-fulfilling route interception as the canonical skeleton-state probe"
  - "Surface-scoped raw-palette regex sweeps as the tier-2+ DOM-level gate (complementing the file-level rg gates in pnpm verify legs)"
requirements-completed: [UI-03]
coverage:
  - id: tier2-token-sweep
    description: "All four tier-2 surfaces on the token substrate: zero emerald/rose utilities; status colors resolve from status tokens in BOTH themes; contract empty-state/404 copy verbatim; skeleton loading on incidents + public status"
    requirement: UI-03
    verification:
      - kind: verify-command
        ref: "rg 'emerald-|rose-' over the four tier-2 files — rc=1 clean (re-run post-commit and at self-check: PASS)"
        status: pass
      - kind: e2e
        ref: "light-mode.spec.ts 13/13: public-status populated leg asserts badge/PARTIAL-OUTAGE/--status-down + uptime/--accent-cyan in light AND dark; 404 leg asserts the contract heading+body; skeleton legs assert both surfaces under stalled APIs; incidents legs assert ACTIVE/--status-down + RESOLVED/--status-up both themes"
        status: pass
    human_judgment: false
  - id: sidebar-reconciliation
    description: "AppSidebar/NavMain carry no raw status/white/slate utilities; active-nav cyan tint/text/border preserved exactly; surfaces route through sidebar tokens"
    requirement: UI-03
    verification:
      - kind: verify-command
        ref: "rg 'emerald-|rose-|text-white|text-slate-' over AppSidebar.tsx + NavMain.tsx — rc=1 clean; git diff shows the one-line inactive-branch class swap only, accent classes intact"
        status: pass
    human_judgment: false
  - id: verify-chain-green
    description: "Full pnpm verify chain green (zero-hex gate included) with zero contract-suite edits; dark token values untouched (zero globals.css edits)"
    requirement: UI-03
    verification:
      - kind: verify-command
        ref: "lint 0 errors (64 pre-existing warnings) / typecheck clean / vitest 430 passed + 2 skipped + 1 pre-warned environmental IN-01 EADDRINUSE :9090 (live production worker — never stopped; 08-03/08-04/08-05 posture) / schema:gate / worker:boundary / denylist:diff / build rc=0 / cron:remnants 478 files / full playwright 50 passed / zero-hex gate 0 unsanctioned files"
        status: pass
      - kind: verify-command
        ref: "git diff over tests/api + tests/worker across both plan commits — empty; git diff over globals.css — empty (D-29/D-31 preserved)"
        status: pass
    human_judgment: false
  - id: both-theme-intentionality
    description: "Tier-2 surfaces + sidebar read as intentional in light mode with dark refined as default (the plan's headline user-facing claim)"
    requirement: UI-03
    verification:
      - kind: e2e
        ref: "token-resolution + raw-palette-sweep legs in both themes (machine half)"
        status: pass
    human_judgment: true
    rationale: "computed token equality and class sweeps are machine-proof; whether the surfaces FEEL intentional in both palettes is visual judgment — manual UAT at phase close (08-10), the established e2e+UAT posture"
duration: 15 min this resume leg (876s; prior session's partial work salvaged — split-session)
completed: 2026-10-01T10:42:36Z
status: complete
---

# Phase 8 Plan 09: Tier-2 Sweep + Sidebar Reconciliation Summary

**All four tier-2 surfaces (public status, incidents, dashboard status, profile) plus the sidebar's NavMain migrated onto the both-mode token substrate — emerald/rose ternaries -> status tokens, slate/white hardcodes -> tokens, spinner loaders -> layout-mirroring skeletons, D-28 micro-interactions — pinned by 6 new both-theme e2e legs (13 total), with the reserved cyan active-nav accent byte-intact and the full verify chain green on zero contract-suite edits.**

## Performance

- **Duration:** ~15 min active this resume leg (876s, single session); the tier-2 implementation itself was salvaged from the usage-limit-terminated prior session (split-session total unknown — prior leg died before any commit).
- **Tasks:** 2/2 complete (Task 1 tracer — tracer feedback gate re-ran both verify legs end-to-end green post-commit before expansion; Task 2 auto)
- **Commits:** 2 plan commits (`0d05bb4`, `b2e280d`). The ledger window `e9d557f..b2e280d` measures 3 — the extra commit `24204ab` is a CONCURRENT phase-06 UAT session's commit (`test(06): UAT test 19 PASS...`, touching only `.planning/phases/06-.../06-UAT.md`) that landed on main mid-execution; it is not this plan's work and touches none of this plan's files.
- **Diff:** 7 files, +585/−253 (~25.0k tokens realized vs 26k estimated — the salvage made the estimate nearly exact).

## Accomplishments

- **Tier-2 sweep (Task 1, salvaged + verified):** PublicStatus/Incidents/DashboardStatus/ProfileComponent — every emerald/rose ternary now reads status-up/status-down (badges, banners, incident icons, summary cards); every slate/white hardcode routes through foreground/muted-foreground/muted-meta/border/card/secondary tokens; ProfileComponent's border-t hack became a Separator; all four spinner+text loaders retired for skeleton.tsx compositions mirroring final layout; public status 404 renders the contract copy token-driven; uptime/latency values carry the cyan emphasis (reserved item 2 — the light #0e7490 variant applies through the token).
- **Micro-interactions (D-28):** incidents timeline rows animate in via motion v12 with the 50ms stagger capped at 8, honoring prefers-reducedMotion; status dot/badge transitions gained 200ms color crossfades; the public/dashboard-status UP dots use the shared animate-status-pulse, DOWN dots animate-alert-pulse (08-04 keyframes — consumed, not redefined).
- **Both-theme e2e (Task 1):** 6 new legs in light-mode.spec.ts — public status populated (badge + PARTIAL OUTAGE + cyan uptime in light AND dark, whole-body raw-palette sweep valid because /status/[id] sits under the bare root layout), 404 contract copy, stalled-API skeleton; incidents empty (All Clear + scoped sweep), populated (ACTIVE/RESOLVED badges both themes), stalled-API skeleton. Seed helpers extended: seedMonitor DOWN param + seedResolvedIncident.
- **Sidebar reconciliation (Task 2, fresh):** NavMain's inactive branch swapped from raw slate utilities onto the sidebar primitive's own token vocabulary — one line, swap-only, cyan active-nav accent untouched; AppSidebar already carried zero raw utilities (structure verified, no change needed).
- **Gates:** full chain green — lint (0 errors), typecheck, vitest 430+2skip (1 pre-warned environmental IN-01), schema:gate, worker:boundary, denylist:diff, build (one transient 0xC0000005 retry), cron:remnants, full playwright 50/50, zero-hex gate 0 unsanctioned files, zero edits under tests/api + tests/worker, zero globals.css edits (dark values exactly as 08-04/08-05 left them).

## Task Commits

| Task | Type | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | feat | `0d05bb4` | PublicStatus.tsx, Incidents.tsx, DashboardStatus.tsx, ProfileComponent.tsx, light-mode.spec.ts, seed.ts |
| 2 | feat | `b2e280d` | NavMain.tsx |

## Files Created/Modified

**Created:** none
**Modified:** `src/components/Status/PublicStatus.tsx`, `src/components/Dashboard/Incidents.tsx`, `src/components/Dashboard/DashboardStatus.tsx`, `src/components/Dashboard/ProfileComponent.tsx`, `src/components/dashboardLayout/NavMain.tsx`, `tests/e2e/light-mode.spec.ts`, `tests/setup/seed.ts`, plus `.planning/phases/08-.../deferred-items.md` (discoveries ledger, docs commit)

## Decisions Made

1. **Salvage, not rewrite.** The dead session's 6-file uncommitted state was audited against the plan (tokens/animations existence on the 08-05 substrate, file-level sweeps, typecheck, lint, full e2e) and kept whole — it was sound and complete for Task 1; only Task 2 remained to build.
2. **Sidebar tokens named explicitly.** Because cn/tailwind-merge lets surface classes override the primitive's variants, the inactive branch names text-sidebar-foreground/70 + hover:bg-sidebar-accent/hover:text-sidebar-accent-foreground rather than dropping classes and relying on primitive defaults — a faithful swap-only diff (T-08-31's pin).
3. **Scrims, indigo, sky stay.** Black scrims (upload overlay, modal backdrop), indigo (member-since), sky (telegram) are outside the emerald/rose + slate/white migration vocabulary and read correctly in both modes — kept deliberately, documented here.
4. **Spec scoping by layout reality.** The public status body-level sweep is valid because /status/[id] renders under the bare root layout (verified — no marketing chrome); the incidents sweep scopes to the page root so the sidebar/header stay in their own reconciliation lanes.
5. **Discoveries deferred, not swept.** NavUser raw utilities, Navbar's rose-400, the dead Pagination component, and the app-wide emerald/rose survey are logged in the phase deferred-items.md — none are in this plan's file list (see Deviations #3).
6. **UI-03 marked complete** — part 1 (08-05) + part 2 (this plan) both summarized; the requirement's full text is now true.

## Deviations from Plan

**1. [Interruption - Resume] Prior executor session terminated by provider usage limit mid-plan, before any commit**
- **Found during:** session start (dispatch continuation state)
- **Issue:** Task 1's implementation existed as uncommitted modifications on exactly 6 files (the 4 tier-2 components + light-mode.spec.ts + seed.ts); no commits, no SUMMARY existed.
- **Fix:** read every file's state against the plan's task definitions, verified the substrate references (all tokens/keyframes exist from 08-05/08-04), ran typecheck/lint/build/e2e — the work was sound and complete for Task 1. Salvaged whole; Task 2 executed fresh. Non-task modified files in the tree (skills-lock.json, tests/resilience/observations.json — tooling/runtime-generated) were excluded from plan commits.
- **Files modified:** none beyond the salvage itself
- **Verification:** Task 1 acceptance criteria all green unmodified; 13/13 spec twice
- **Commits:** 0d05bb4 (salvage + verified), b2e280d

**2. [Rule 3 - Blocker] Spec extension required seed helpers beyond the plan's declared file list**
- **Found during:** Task 1 salvage review
- **Issue:** the incidents both-theme legs need a RESOLVED incident seed and a DOWN-status monitor; tests/setup/seed.ts only had seedOngoingIncident and a hardcoded 'UP'
- **Fix:** seedMonitor gained an optional status param (default UP — all existing callers unchanged); seedResolvedIncident added. tests/api and tests/worker byte-untouched (the actual zero-edit criterion).
- **Files modified:** tests/setup/seed.ts
- **Verification:** e2e 13/13; api project 12/12 inside the full 50/50 playwright run
- **Commit:** 0d05bb4

**3. [Scope boundary - Documented] Cross-plan expectations not carried by this plan's file list**
- **Found during:** Task 2 read_first + app-wide survey
- **Issue:** 08-05's summary pointed NavUser raw classes, Navbar's rose-400, and the Pagination dead-component disposition at "08-09" — but 08-09's plan file list declares only AppSidebar + NavMain (+ tier-2 files); sweeping the others would exceed the binding scope.
- **Fix:** logged all four items (incl. the app-wide emerald/rose survey) in the phase deferred-items.md with dispositions for 08-08/08-10.
- **Files modified:** .planning/phases/08-.../deferred-items.md (docs commit)
- **Verification:** deferred-items.md entries present
- **Commit:** docs closeout commit

**Total deviations:** 3 (1 interruption/resume, 1 Rule-3 supporting-file extension, 1 scope-boundary documentation). **Impact:** none on plan scope — production changes landed exactly as planned; the file-list delta (seed.ts) is a functional prerequisite of the planned spec extension.

## Issues Encountered

- **Environmental (pre-warned IN-01):** vitest leg reports exactly one failure — `tests/worker/health.test.ts` EADDRINUSE 127.0.0.1:9090 while the live production worker (PID 14180, running the phase-06 UAT rebuild) holds the health port. 430 passed + 2 pre-existing skips; the live worker was NOT stopped; every remaining verify leg run individually to green against the final source state (08-03/08-04/08-05 pattern).
- **Environmental (pre-warned, transient):** first `pnpm build` died with 0xC0000005 (exit 3221225477) during page-data collection; immediate retry green (rc=0).
- **Concurrent activity:** a phase-06 UAT session committed `24204ab` to main mid-execution (only `.planning/phases/06-.../06-UAT.md`; no overlap with this plan's files). Recorded because the ledger-based commit measurement (3) includes it.
- **Untracked tree noise:** ~90 untracked tooling/config dirs (.claude/, .codex/, agents/, scripts/changeset/, etc.) pre-exist this session and are out of scope; nothing this plan generated was left untracked.

## User Setup Required

None.

## Next Phase Readiness

- **08-06/08-07 (incomplete plans):** AI surfaces render on the same split substrate — every cyan emphasis site this plan added consumes --accent-cyan, light-AA by construction.
- **08-08 (Release B):** ships the tier-2 surfaces + reconciled sidebar; UI-05 completes there. The deferred-items.md entries (NavUser, Navbar rose-400, Pagination, app-wide emerald/rose survey) are inputs to its scope decision.
- **08-10 (phase close/UAT):** the both-theme-intentionality coverage entry (human_judgment) is the manual-UAT leg; light-mode.spec.ts's 13 tests are the machine half.
- **UI-03 is complete** across both parts (08-05 + 08-09): whole app token-driven on tier-1/2/sidebar surfaces, dark default preserved byte-for-byte in values.

## Self-Check: PASSED

- Files: all 7 modified files exist on disk (verified via git show + working tree).
- Commits: `0d05bb4`, `b2e280d` present in git log (2 plan commits; ledger window 3 incl. concurrent `24204ab`).
- Task 1 acceptance re-run: rg emerald/rose over the 4 tier-2 files rc=1 clean (PASS); light-mode.spec.ts 13/13 both-theme (PASS, run twice — task verify + tracer feedback gate).
- Task 2 acceptance re-run: rg over AppSidebar/NavMain rc=1 clean (PASS); git diff swap-only with cyan accent intact (PASS); verify chain legs individually green with the documented IN-01 environmental exception (PASS); git diff over tests/api + tests/worker across both plan commits empty (PASS).
- Plan verification re-run: zero-hex gate 0 unsanctioned files (PASS); globals.css untouched (PASS); full playwright 50/50 (PASS).
