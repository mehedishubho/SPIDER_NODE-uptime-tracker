---
phase: 08
plan: 04
subsystem: dashboard-ui
tags: [ui-01, ui-05, tier-1-redesign, shadcn, typography, token-migration, skeleton-loaders, motion-v12, e2e]
requires:
  - 08-02 primitives (dialog/alert-dialog/dropdown-menu/tooltip on shadcn new-york Radix variants; icon sweep) — commits 8c84587..444f72a
  - 08-03 abort seams + the standing ui-robustness.spec net — commits 1a1cb7a..c676d90
  - Phase-2 token system (status-up/status-down, accent-cyan reserved list, zero-hex gate)
provides:
  - StatsSummaryHeader component (shadcn Card composition; aggregates of loaded /api/monitors data only — no new endpoint)
  - Tier-1 redesigned surfaces: Dashboard.tsx + MonitorDetails.tsx (Card composition, 12px row rhythm, staggered entrance, dropdown row actions, skeleton loaders, 200ms status crossfades)
  - Tier-1 typography/token conformance: exactly text-sm 400 / text-xs 400 / text-lg 600 / text-[28px] 600; data values in JetBrains Mono; zero emerald/rose/text-white/text-slate utilities on tier-1
  - tests/e2e/dashboard-redesign.spec.ts (6 tests: stats aggregates, dense rhythm + sticky headers, reduced-motion, empty state, incident-block composition + status tokens, Clean History + type roles)
  - Incident-block structure preserved verbatim as the 08-07 post-mortem mount (icon + title + description + started/resolved timestamps + ACTIVE/RESOLVED badge)
affects:
  - 08-05 (globals.css token work; owns the deferred render.ts zero-hex gate-list staleness logged in deferred-items.md)
  - 08-07 (AI surfaces mount on the preserved incident-block structure and the tier-1 primitives)
  - 08-08 (Release B ships this UI; UI-05 completes there)
tech-stack:
  added: []
  patterns:
    - "Skeleton compositions mirror the loaded layout by reusing the same Card primitive shells (CardHeader/Content + Skeleton children) — shape-parity by construction, no bespoke skeleton markup"
    - "Status-change crossfade = AnimatePresence mode=wait + motion.span keyed on the status label, 200ms fade, reduced-motion collapses duration to 0 (no exit animation)"
    - "Typography/contract e2e assertions read computed className attributes (like the Task-1 py-3 rhythm pin) — class-level, not screenshot-level"
actuals:
  tokens: 24200
  tasks: 3
  commits: 3
plan_head_before: 3d7a2318f2b04a31862780e0d059f53238b4116c
plan_head_after: 6807708a7a55c979a251ba25f82e5a4757db3d4c
key-files:
  created:
    - src/components/Dashboard/StatsSummaryHeader.tsx
    - tests/e2e/dashboard-redesign.spec.ts
  modified:
    - src/components/Dashboard/Dashboard.tsx
    - src/components/Dashboard/MonitorDetails.tsx
    - tests/e2e/ui-robustness.spec.ts
    - tests/e2e/dialogs.spec.ts
key-decisions:
  - "Prior-session salvage: the dead session's uncommitted Task-2 work (MonitorDetails Card rebuild + both-file token/typography migration) was verified sound against every plan sweep before being kept — sweeps 1+2 were already clean — then completed with the spec extension, not rewritten"
  - "The redesign e2e seed grew to two monitors (incident-free + ONGOING-incident) so one spec file drives both detail legs; the Task-1 aggregate assertions were updated to the real fleet (2 UP, avg 100.00%, avg 42ms) and the rows test became order-agnostic (filter by name) because the list renders newest-first"
  - "ui-robustness.spec.ts reconciled to the dropdown row-actions overflow (open 'Row actions' menu before the Re-check item) — the Task-1 commit reconciled dialogs.spec but missed this spec because its per-task verify leg ran only the redesign file (the pnpm test:e2e -- filter quirk)"
  - "Tier-1 full-screen spinner+text loaders retired alongside the named 'Fetching status records...' string — all three loading renders (dashboard page, in-card list, monitor detail) are now skeleton compositions; 'Loading Dashboard...' and 'Loading Monitor Data...' go with it (UI-SPEC loading rows: skeleton shape mirrors final layout)"
  - "UP chart bars migrated bg-primary -> bg-status-up (UI-SPEC Color contract: primary red is never status; UP semantics ride status-up)"
  - "Status crossfade keyed-remount form (AnimatePresence mode=wait) rather than overlapping absolute-position crossfade — inside table cells the sequential fade is the contract-faithful 200ms swap without layout side effects"
patterns-established:
  - "Redesign e2e seed pattern: capture monitor ids in beforeAll at module scope (workers:1), drive detail pages by direct goto, assert composition via data-testids (incident-block, incident-status-badge, detail-status-badge, detail-uptime)"
  - "Class-census typography pins: rg -no over the text-size vocabulary proves exactly the four declared sizes appear on tier-1 surfaces"
requirements-completed: [UI-01]
coverage:
  - id: stats-summary-header
    description: "StatsSummaryHeader renders real aggregates of the seeded fleet (count, UP/DOWN, avg uptime, avg latency) from existing /api/monitors data — no new endpoint, no windowed values (D-24/D-25)"
    requirement: UI-01
    verification:
      - kind: e2e
        ref: "tests/e2e/dashboard-redesign.spec.ts: stats summary header renders real aggregates (stat-total/status/uptime/_latency + 'Total 2 listed')"
        status: pass
      - kind: verify-command
        ref: "git diff c3b1167^..HEAD -- src/app/api — empty (no new API route)"
        status: pass
    human_judgment: true
    rationale: "e2e pins the numbers and data-truth; the visual quality of the header (spacing, hierarchy, cyan emphasis) is manual-UAT territory at phase close per the plan's e2e+UAT posture"
  - id: dense-list-stagger
    description: "Monitor list: py-3 rhythm, Card shell with sticky column headers, overflow-x-auto on small viewports, dropdown row actions with tooltip trigger, 50ms stagger capped at 8, reduced-motion static fallbacks"
    requirement: UI-01
    verification:
      - kind: e2e
        ref: "dashboard-redesign.spec.ts: denser 12px rhythm + sticky top-16 headers; staggered entrance honors prefers-reduced-motion"
        status: pass
      - kind: verify-command
        ref: "rg py-3 Dashboard.tsx (10 cell sites); Math.min(index, 8) * 0.05 stagger cap; useReducedMotion in all three tier-1 files"
        status: pass
    human_judgment: true
    rationale: "structural facts are pinned; entrance-animation feel and dropdown ergonomics are visual judgment (manual UAT)"
  - id: monitor-detail-composition
    description: "Incident history on Card composition (CardHeader/Title/Description/Action/Content + Separator), name truncate + title attr, description line-clamp-2, ACTIVE/RESOLVED badge + timestamps on status tokens and JetBrains Mono; block structure preserved for 08-07"
    requirement: UI-01
    verification:
      - kind: e2e
        ref: "dashboard-redesign.spec.ts: incident blocks on the Card composition with status tokens; Clean History copy verbatim + Display/Heading/Label type roles via computed classes"
        status: pass
    human_judgment: true
    rationale: "composition + copy + class-level typography pinned; aesthetic cleanliness is manual UAT"
  - id: tier1-typography-tokens
    description: "Exactly 4 sizes / 2 weights on tier-1; 500/700/800 retired; text-[10px]/[11px] consolidated; text-white/slate -> tokens; every status-colored utility on status-up/status-down; zero raw hex introduced"
    requirement: UI-05
    verification:
      - kind: verify-command
        ref: "sweeps over both tier-1 files: emerald|rose|text-white|text-slate (rc=1) and font-medium|bold|extrabold|text-[10px]|[11px] (rc=1); text-size census = exactly sm/xs/lg/[28px]"
        status: pass
      - kind: verify-command
        ref: "02-08-form zero-hex gate over src/ — all 08-04 surfaces clean; residual hits are the sanctioned files + pre-existing Phase-7 render.ts (deferred, not introduced here)"
        status: pass
    human_judgment: false
  - id: skeleton-loaders-motion
    description: "Tier-1 loading renders skeletons mirroring final layout; the spinner+text loader strings retire; status dot/badge crossfades at 200ms; transition-number numeric fade stays; all motion reduced-motion-aware"
    requirement: UI-05
    verification:
      - kind: verify-command
        ref: "rg 'Fetching status records|Loading Monitor Data|Loading Dashboard' src/components/Dashboard/ — rc=1 (clean); rg transition-number — both numeric sites retained"
        status: pass
      - kind: e2e
        ref: "full e2e suite 37/37 on the final state (redesign + robustness + smoke + dialogs + api projects)"
        status: pass
    human_judgment: true
    rationale: "string retirement and reduced-motion gating are machine-checked; skeleton shape-parity and crossfade feel are visual judgment"
  - id: criterion5-contract-suites
    description: "Characterization/contract suites stay green with zero expectation edits — monitoring behavior and public API shapes unchanged by the redesign"
    requirement: UI-05
    verification:
      - kind: verify-command
        ref: "git diff --name-only over tests/api and tests/worker (committed + working tree) — empty; vitest 427 passed + 2 pre-existing skips + the pre-warned environmental IN-01 only"
        status: pass
      - kind: verify-command
        ref: "remaining verify legs individually green on final state: lint, typecheck, schema:gate, worker:boundary, denylist:diff, build, cron:remnants (478 files incl. fresh .next), e2e 37/37"
        status: pass
    human_judgment: false
duration: 2 sessions (prior session Tasks 1 + partial 2, terminated by provider quota limit; resume leg Tasks 2-3 + closeout ~45 min)
completed: 2026-09-30T22:00:00Z
status: complete
---

# Phase 8 Plan 04: Tier-1 Redesign Summary

**Dashboard + monitor detail rebuilt on shadcn Card/Button/Input/dropdown primitives with a stats summary header aggregating existing API data, a denser staggered monitor list, a Card-composed incident history preserving the 08-07 post-mortem mount, exact 4-size/2-weight typography, full status-token migration, skeleton loaders, and 200ms status crossfades — pinned by a 6-test redesign e2e with every contract suite untouched-green.**

## Performance

- **Duration:** 2 sessions — prior session (Task 1 committed `c3b1167` + partial uncommitted Task 2) was terminated by a provider quota limit; this resume leg salvaged, completed Tasks 2-3, and closed out (~45 min active)
- **Tasks:** 3/3 complete (Task 1 tracer — prior session; Tasks 2-3 auto — resume leg)
- **Commits:** 3 plan commits (`c3b1167`, `59d4ba0`, `6807708`) — measured over `3d7a231..6807708`; note the range also contains one unrelated interleaved `docs(06)` commit (`33a4d4d`, code-review report from outside this plan — not counted)
- **Diff:** 6 files, +1596/−579 (~24.2k tokens realized vs 62k estimated — the plan over-estimated; the Card-composition surface reused 08-02 primitives heavily)

## Accomplishments

- **Stats summary header (Task 1, prior session):** `StatsSummaryHeader.tsx` composes shadcn Card primitives over the already-loaded monitors array — active count, UP/DOWN distribution, mean lifetime uptime (cyan emphasis, the UI-SPEC reserved role), mean latency. No new endpoint, no windowed values (D-24/D-25).
- **Denser monitor list (Task 1):** Card shell with sticky column headers (top-16 under the h-16 AppHeader; overflow visible ≥sm so page scroll drives stickiness, overflow-x-auto retained below), py-3 row rhythm, URL truncation + external-link affordance + title attrs, dropdown row actions with tooltip-carrying icon trigger, 50ms stagger capped at 8 items via `Math.min(index, 8) * 0.05` with useReducedMotion static fallbacks.
- **Monitor detail redesign (Task 2, salvaged + completed):** metrics on Card (Display-role `text-[28px]` mono values), chart on Card (UP bars `status-up`, DOWN bars `status-down`, popover-token tooltip), incident history on Card composition with Separator replacing border-t hacks. The incident-block structure (icon + title + description + started/resolved timestamps + ACTIVE/RESOLVED badge) is preserved verbatim with a comment marking the 08-07 post-mortem mount.
- **Typography + token migration (Task 2):** both tier-1 files now carry exactly the four declared sizes and two weights (text-sm 400 / text-xs 400 / text-lg 600 / text-[28px] 600); `font-medium/bold/extrabold` and `text-[10px]/[11px]` retired; every `text-white`/`text-slate-*`/`border-slate-800`/`bg-slate-900` migrated to foreground/muted-foreground/border/secondary tokens; every status ternary on `status-up`/`status-down`; form/header controls moved to Button/Input primitives with stable `htmlFor`-paired field ids (`new-monitor-*`/`edit-monitor-*` — the ids 08-06's assistant will target).
- **Skeletons + transitions (Task 3):** all three tier-1 loading renders are now skeleton.tsx compositions mirroring the loaded layout (reusing the same Card shells); the spinner+text strings retire. Status pill (dashboard rows) and status badge (detail header) crossfade through a 200ms keyed motion-v12 fade with duration-0 reduced-motion swaps; the CSS `transition-number` numeric fade stays on both numeric sites.
- **Verification:** redesign spec 6/6; full e2e 37/37 (robustness + smoke + dialogs + api projects included); every verify leg green on the final state with zero edits under tests/api and tests/worker.

## Task Commits

| Task | Type | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | feat | `c3b1167` (prior session) | Dashboard.tsx, StatsSummaryHeader.tsx (new), dashboard-redesign.spec.ts (new), dialogs.spec.ts |
| 2 | feat | `59d4ba0` | Dashboard.tsx, MonitorDetails.tsx, dashboard-redesign.spec.ts, ui-robustness.spec.ts |
| 3 | feat | `6807708` | Dashboard.tsx, MonitorDetails.tsx |

## Files Created/Modified

**Created:** `src/components/Dashboard/StatsSummaryHeader.tsx`, `tests/e2e/dashboard-redesign.spec.ts`
**Modified:** `src/components/Dashboard/Dashboard.tsx`, `src/components/Dashboard/MonitorDetails.tsx`, `tests/e2e/ui-robustness.spec.ts`, `tests/e2e/dialogs.spec.ts`
**Deleted:** none

## Decisions Made

1. **Salvage, not rewrite.** The dead session's uncommitted Task-2 work was read in full, checked against every plan sweep (both token/typography sweeps were already clean), and only then kept — the resume added the spec extension and the aggregate-assertion fixes rather than redoing sound work.
2. **Two-monitor seed.** The redesign spec seeds an incident-free monitor AND an ONGOING-incident monitor for the same user so both detail legs (Clean History + incident-block composition) run from one login surface. Consequence: the Task-1 aggregate assertions read the real two-monitor fleet, and the rows test filters by name (the list renders newest-first).
3. **Dropdown reconciliation extended to ui-robustness.spec.ts.** Task 1 reconciled dialogs.spec to the dropdown overflow but missed ui-robustness (its per-task verify never ran that file — see Deviation 2). The full-suite run this session caught it; the fix mirrors the dialogs.spec pattern (open "Row actions", then the menu item).
4. **All three spinner+text loaders retired, not just the named one.** UI-SPEC's loading row says skeleton shape mirrors final layout; leaving full-screen spinners while retiring the in-card one would keep two of three loading states off-contract. The verify grep covers the named string; the other two strings are gone as well.
5. **UP bars ride status-up.** The old chart colored UP bars `bg-primary` (brand red) — the UI-SPEC Color contract reserves primary for CTAs/brand and never status; the redesign migrates the pair to status-up/status-down.
6. **UI-01 complete here; UI-05 deliberately not marked.** UI-01's shadcn adoption on the redesign surfaces is done and pinned. UI-05's full text ("both modes on the same token set... release-ready") spans 08-05 (light-pass + globals.css) and 08-08 (Release B) — marking it now would be the 02-03 false-signal precedent.

## Deviations from Plan

**1. [Rule 3 - Blocker] ui-robustness.spec.ts selector broke under the Task-1 redesign**
- **Found during:** Task 2 verify (full e2e run)
- **Issue:** the spec's check-now leg clicked `getByTitle("Re-check endpoint status")` directly; the redesign moved that action into the dropdown-menu overflow (Task 1 reconciled dialogs.spec but not this file — its verify leg never executed this spec)
- **Fix:** open the "Row actions" dropdown first, then click the menuitem (identical to the dialogs.spec reconciliation committed in Task 1)
- **Files modified:** tests/e2e/ui-robustness.spec.ts
- **Verification:** the previously-failing case passes; robustness suite 6/6
- **Commit:** 59d4ba0

**2. [Rule 3 - Blocker] `pnpm test:e2e -- <file>` does not filter on this toolchain (recurrence)**
- **Found during:** Task 2 verify
- **Issue:** third recurrence of the 08-02/08-03 finding — pnpm swallows the file argument and the FULL suite runs
- **Fix:** per-task verification used `pnpm exec playwright test <name-substring>` (proven selection); the binding full-suite run happens anyway in the verify chain
- **Files modified:** none (execution-form note only)
- **Verification:** full e2e 37/37 green
- **Commit:** n/a

**3. [Rule 1 - Bug] Task-1 aggregate assertions broke under the richer Task-2 seed**
- **Found during:** Task 2 verify
- **Issue:** seeding the second (incident-bearing) monitor changed the fleet the stats header aggregates (1 -> 2); the Task-1 tests asserted "1"/"Total 1 listed"/"1 UP • 0 DOWN" and `.first()` landed on the newest row
- **Fix:** assertions updated to the real fleet values; rows test made order-agnostic via name filter — the header still proves data-truth against seeded data, now against the full seed shape
- **Files modified:** tests/e2e/dashboard-redesign.spec.ts
- **Verification:** stats + rhythm tests green
- **Commit:** 59d4ba0

**4. [Process] Provider quota limit terminated the prior session mid-Task-2**
- **Found during:** resume (dispatch context)
- **Issue:** Task 1 was committed; Task 2's component work sat uncommitted in the working tree
- **Fix:** uncommitted work verified sound (sweeps clean, typecheck/lint green) and completed per plan; this session owns Tasks 2-3, all acceptance re-verification, and closeout
- **Files modified:** none beyond the task files above
- **Verification:** all acceptance criteria re-run across ALL tasks (below)
- **Commit:** n/a (session event)

**Total deviations:** 4 (2 Rule-3 blockers, 1 Rule-1 test fix, 1 process interruption). **Impact:** none on plan scope — one extra test file touched (selector reconciliation), everything else landed as specified.

## Issues Encountered

- **Environmental (pre-warned):** the verify chain's vitest leg reports exactly one failure — `tests/worker/health.test.ts` IN-01 `EADDRINUSE 127.0.0.1:9090` while the live production worker holds the health port (427 passed, 2 pre-existing skips). The live worker was NOT stopped; every subsequent verify leg was run individually to green against the final source state (08-03 pattern).
- **Out-of-scope discovery (logged, not fixed):** the 02-08-form zero-hex gate flags `src/lib/email/render.ts` — a Phase-7 (07-02) email-HTML template with inline hex colors under the same email-clients-can't-use-CSS-vars rationale as the sanctioned `mail.ts`, never added to the gate's exclusion list. Not introduced by 08-04; logged to the phase's deferred-items.md for 08-05 disposition.
- **Observed and left (pre-existing):** the DOWN-row inset shadow literal `rgba(239,68,68,0.1)` in Dashboard.tsx predates this plan (02-08-era commit) and passes the `#`-based gate; token-izing it risks visual churn on committed Task-1 surface — recorded here, not re-litigated.
- **Unrelated working-tree noise:** `tests/resilience/observations.json`, `skills-lock.json`, `.planning/agent-history.json` carry modifications from other sessions/tools — deliberately left unstaged by the task commits.

## User Setup Required

None.

## Next Phase Readiness

- **08-05 (serialized after this plan):** owns globals.css/token VALUES and the light-pass; the tier-1 surfaces now consume only tokens, so value changes flow without further component edits. The deferred render.ts gate-list item rides to it.
- **08-07:** the incident-block structure (icon + title + description + started/resolved timestamps + ACTIVE/RESOLVED badge) is preserved on Card primitives with an explicit mount-point comment; `data-testid="incident-block"`/`incident-status-badge` give the post-mortem card stable anchors.
- **08-06:** the Add-Monitor dialog fields carry stable ids (`new-monitor-name`/`new-monitor-url`/`new-monitor-interval`) with `htmlFor`-paired labels — the assistant prefill targets exist; the form remains useState-based (Pitfall 9 unchanged).
- **08-08:** UI-05 completes at Release B; this plan's surfaces are release-ready (full verify green, contract suites untouched).

## Self-Check: PASSED

- Created files exist: `src/components/Dashboard/StatsSummaryHeader.tsx` — FOUND; `tests/e2e/dashboard-redesign.spec.ts` — FOUND; all modified files present on disk.
- Commits exist: `c3b1167`, `59d4ba0`, `6807708` all in `git log` (3 plan commits over 3d7a231..6807708, plus one unrelated interleaved docs(06) commit not counted).
- Task 1 acceptance re-run: StatsSummaryHeader exists and the e2e asserts its aggregates (PASS); py-3 rhythm (10 sites) + `Math.min(index, 8)` stagger cap + useReducedMotion gating in all three files (PASS); `git diff c3b1167^..HEAD -- src/app/api` empty — no new API route (PASS).
- Task 2 acceptance re-run: sweep 1 (emerald|rose|text-white|text-slate) rc=1 clean; sweep 2 (font-medium|bold|extrabold|text-[10px]|[11px]) rc=1 clean; text-size census = exactly sm/xs/lg/[28px]; incident-block + Clean History e2e green (PASS).
- Task 3 acceptance re-run: 'Fetching status records' sweep rc=1 (plus both full-screen loader strings also retired); skeleton compositions present in both components; `pnpm verify` legs green on final state (lint, typecheck, schema:gate, worker:boundary, denylist:diff, build, cron:remnants over fresh .next, e2e 37/37) with the vitest leg at 427 passed + 1 pre-warned environmental IN-01; `git diff --name-only` over tests/api and tests/worker empty — zero contract edits (PASS).
- Plan verification re-run: redesign spec 6/6; token/typography sweeps print nothing; zero-hex gate clean for all 08-04 surfaces.
