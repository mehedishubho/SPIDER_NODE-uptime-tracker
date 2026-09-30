---
phase: 08
plan: 05
subsystem: theme-tokens
tags: [ui-03, wr-02, light-mode, token-splits, globals-css, brand-assets, lottie, sonner, wcag-contrast, e2e]
requires:
  - 08-02 dialog consolidation (Swal deleted — the --dialog-* retirement premise)
  - 08-04 tier-1 token/typography migration (surfaces consume only tokens; the deferred render.ts zero-hex gate-list item)
  - Phase-2 token system (02-07 palette, 02-08 hex sweep + zero-hex gate form, THM-01 next-themes class strategy)
provides:
  - Per-mode token substrate in globals.css (--accent-cyan light #0e7490 at 5.13:1, --muted-meta light #62666c at 5.53:1, --danger-strong light #b91c1c at 6.20:1; #00E5FF remains the dark value and stays valid for non-text accents)
  - 3:1 light borders (--border/--input/--sidebar-barrier family at #8b8e94 — 3.28:1 vs #ffffff cards)
  - WR-02 discharged (D-26): Navbar/AppHeader/TeamSwitch/HowItWorks token-driven and provably light-legible
  - Light-safe brand assets: Loading overlay bg-background/80; PageNotFound token heading + both-mode-safe dark illustration plate
  - Token-driven sonner neutral-toast surface (light toast aesthetics, richColors untouched)
  - tests/e2e/light-mode.spec.ts (7 tests; 08-09 extends with tier-2/sidebar legs)
affects:
  - 08-09 (consumes the per-mode substrate unchanged; owns tier-2 sweep + sidebar reconciliation + the emerald/rose ternaries)
  - 08-07 (AI surfaces render on the split substrate — cyan accents are light-AA by construction)
  - 08-08 (Release B ships the light-pass; UI-05 completes there)
tech-stack:
  added: []
  patterns:
    - "Per-mode token split discipline: edit :root only; .dark stays byte-stable (proven by sorted-block diff) — D-31 both-modes-same-set with dark defaults frozen in value"
    - "Engine-side color assertion: Tailwind v4 alpha utilities compute as color-mix/oklab — a probe element built with the same color-mix construction compares two engine-computed values instead of string forms"
    - "In-page WCAG verification: e2e computes relative-luminance contrast from computed styles, proving the light token VALUES meet AA, not just that a token resolved"
    - "Scoped DOM class sweeps: retired-utility assertions scoped to the migrated WR-02 containers because out-of-plan tier-3 components share the page until 08-09"
actuals:
  tokens: 8100
  tasks: 2
  commits: 2
plan_head_before: a7feeca7330c6c77ed86f7fe4b04699f498569db
plan_head_after: dcc4a6b6643dd2332f4b7f67fcd3ee2843330011
key-files:
  created:
    - tests/e2e/light-mode.spec.ts
  modified:
    - src/app/globals.css
    - src/components/common/Navbar/Navbar.tsx
    - src/components/dashboardLayout/AppHeader.tsx
    - src/components/dashboardLayout/TeamSwitch.tsx
    - src/components/home/HowItWorks.tsx
    - src/components/Others/Loader/Loading.tsx
    - src/components/Others/PageNotFound/PageNotFound.tsx
key-decisions:
  - "11-token review outcome: SPLIT 3 (accent-cyan #0e7490, muted-meta #62666c, danger-strong #b91c1c — all :root-only, dark byte-stable per D-31); KEEP 8 same-value with rationale (foreground-bright/surface-deep/raised/accent-gold*-deep ride UnderConstruction's always-dark canvas in both modes; foreground-invert is near-black text plus intentional dark panels; highlight-purple's only consumer is the unreferenced Pagination.tsx in a bg-fill role — dead-consumer finding logged for 08-09)"
  - "danger-strong split despite #DE251F technically passing on plain #fafafa (4.58:1): its hover wash (bg-danger-strong/10) blended the surface to ~4.0:1 — #b91c1c (6.20:1) clears the wash and matches the light gradient end"
  - "Light border family at #8b8e94 (3.28:1 vs card, 3.15:1 vs canvas): --border AND --input AND --sidebar-border share the value — input boundaries carry the same 1.4.11 3:1 discipline as card borders (02-UAT Test-4 'light dashboard contrast')"
  - "Navbar CTA text-white -> text-primary-foreground (not text-foreground): text-on-primary belongs to the primary-foreground token and matches the 08-04 shadcn Button language (#121212 on red, 6.0:1 vs white's 3.15:1) — the one deliberate dark-mode visual delta of the palette pass, in the direction the design system already established"
  - "PageNotFound 404 artwork treatment = dark illustration plate (rounded bg-surface-deep), the 'asset whose background works on both' smaller-diff form: the inspected artwork mixes dark-slate strokes (65 uses) with white/light-gray highlights (25 uses) — whites vanish on light, slates need non-light; the plate reproduces the dark-mode rendering exactly and lifts it into light mode intentionally; a light-variant asset swap was rejected as larger-diff (no authorable asset)"
  - "Loading overlay bg-white/80 -> bg-background/80: light keeps today's near-white scrim over the light-designed artwork; dark sheds the hardcoded white flash — the artwork's cream/orange/teal elements (25 of 56 color uses) carry it on dark"
  - "ThemedToaster unchanged in JS (richColors/top-right/resolved-theme were already the contract); the light-aesthetic polish landed as a globals.css --normal-* retarget on ol[data-sonner-toaster] [data-sonner-toast] — outranks sonner's theme var definitions while richColors typed toasts read their own --success-*/--error-* vars"
  - "render.ts zero-hex gate item CONSUMED: added to the sanctioned exclusion list under the mail.ts email-HTML rationale (email clients cannot consume CSS custom properties); gate list now globals.css, mail.ts, render.ts, LoginForm, RegisterForm, global-error.tsx; WINDOWS entries 6-7 marked fixed"
  - "UI-03 deliberately NOT marked complete — part 2 (tier-2 sweep + sidebar reconciliation) is 08-09's must-have; requirements-completed stays empty (02-03/08-04 false-signal precedent)"
patterns-established:
  - "light-mode.spec.ts composition: shared helpers (forceLightTheme/tokenColor/expectTokenBackgroundAlpha/expectNoRetiredRawClasses/contrastRatio) + one describe per surface — 08-09's tier-2/sidebar legs add describes without touching existing legs"
  - "Contrast assertions computed in-page from computed styles — reusable for any future token change (08-09 re-runs them over tier-2 surfaces)"
requirements-completed: []
coverage:
  - id: wr-02-token-migration
    description: "WR-02 surfaces (Navbar/TeamSwitch headings, AppHeader strip, HowItWorks copy) are token-driven and light-legible — the 02-UAT D-26 obligation discharged"
    requirement: UI-03
    verification:
      - kind: verify-command
        ref: "rg sweep over the four WR-02 files for bg-slate-950/80|text-white|text-slate-300|text-slate-400 — rc=1 clean"
        status: pass
      - kind: e2e
        ref: "light-mode.spec.ts: Navbar/copy/heading/AppHeader/TeamSwitch computed colors equal the :root token values in forced light theme"
        status: pass
    human_judgment: true
    rationale: "computed-color equality and class sweeps are machine-proof; the aesthetic quality of the light palette pass is manual-UAT territory at phase close (e2e+UAT posture)"
  - id: token-substrate-splits
    description: "11-token review executed: 3 per-mode splits (cyan/muted-meta/danger-strong light variants >= 4.5:1), 8 kept same-value with documented rationale; dark values byte-stable"
    requirement: UI-03
    verification:
      - kind: verify-command
        ref: "sorted .dark-block diff vs HEAD~1: exactly 3 removed tokens (the dialog trio), zero value edits; design-time WCAG math (node) for every candidate"
        status: pass
      - kind: e2e
        ref: "light-mode.spec.ts contrast leg: stat-uptime cyan text 5.36:1 vs its card (>= 4.5 asserted in-page)"
        status: pass
    human_judgment: false
  - id: dialog-token-retirement
    description: "--dialog-* trio retired with Swal's deletion; zero references remain in src/"
    requirement: UI-03
    verification:
      - kind: verify-command
        ref: "rg 'dialog-surface|dialog-foreground|dialog-muted' src/ — rc=1 (TeamSwitch dead comment deleted in Task 1)"
        status: pass
    human_judgment: false
  - id: light-border-contrast
    description: "Light card borders (and input boundaries) meet 3:1 against their surfaces (02-UAT Test-4)"
    requirement: UI-03
    verification:
      - kind: e2e
        ref: "light-mode.spec.ts: [data-slot=card] borderColor vs backgroundColor contrast >= 3 asserted in-page (3.28 measured)"
        status: pass
    human_judgment: false
  - id: light-safe-brand-assets
    description: "Lottie overlays light-safe: Loading overlay token-driven; PageNotFound token heading + both-mode-safe dark illustration plate (asset color inventory inspected)"
    requirement: UI-03
    verification:
      - kind: e2e
        ref: "light-mode.spec.ts: not-found heading token-resolved; plate background equals --surface-deep"
        status: pass
      - kind: verify-command
        ref: "zero-hex gate 02-08 form over src/ — 0 unsanctioned files (Loading/PageNotFound clean; a hex in my own comment was caught and reworded)"
        status: pass
    human_judgment: true
    rationale: "the plate treatment and dark-scrim loading are structural facts machine-checked; whether the dark plate reads intentional on the light 404 page is visual judgment (manual UAT)"
  - id: toast-aesthetics
    description: "ThemedToaster keeps richColors/top-right + resolved-theme; light toast aesthetics polished via token-driven neutral surface"
    requirement: UI-03
    verification:
      - kind: verify-command
        ref: "ThemedToaster.tsx byte-unchanged (contract preserved); globals.css sonner --normal-* retarget present; build + full e2e green"
        status: pass
    human_judgment: true
    rationale: "the CSS override is present and parse-clean; toast appearance in both modes is inherently visual (manual UAT)"
  - id: verify-chain-green
    description: "pnpm verify legs green with zero contract-suite edits; dark remains the default theme"
    requirement: UI-03
    verification:
      - kind: verify-command
        ref: "lint 0 errors / typecheck clean / schema:gate / worker:boundary / denylist:diff / build rc=0 / cron:remnants 478 files / full playwright 44/44 / vitest 430 passed + 1 pre-warned environmental IN-01"
        status: pass
      - kind: verify-command
        ref: "git diff over tests/api + tests/worker across both commits — empty (zero contract edits); ThemeProvider defaultTheme=dark untouched"
        status: pass
    human_judgment: false
duration: 26 min (single session)
completed: 2026-10-01T04:38:00Z
status: complete
---

# Phase 8 Plan 05: Light Mode + Token Splits Summary

**WR-02 discharged and the token substrate made both-mode-correct: the four WR-02 surfaces now render token-driven and provably light-legible (7-test e2e with in-page WCAG contrast math), globals.css splits 3 of the 11 same-value tokens to >= 4.5:1 light variants with .dark byte-stable by sorted-diff proof, retires the Swal --dialog-* trio, darkens light borders to 3:1, and makes both Lottie brand assets light-safe (asset color inventory inspected).**

## Performance

- **Duration:** ~26 min active (single session; test stack + two builds included)
- **Tasks:** 2/2 complete (Task 1 tracer — tracer feedback gate re-ran all three verify legs end-to-end green before expansion; Task 2 auto)
- **Commits:** 2 plan commits (`d856859`, `dcc4a6b`) — measured over `a7feeca..dcc4a6b`
- **Diff:** 8 files, +432/−58 (~8.1k tokens realized vs 34k estimated — the plan over-estimated; a tier-3 palette pass is small by construction)

## Accomplishments

- **WR-02 migration (Task 1):** Navbar headings/CTAs/chips/drawer, AppHeader strip (`bg-background/80` + `border-border`), TeamSwitch brand heading, HowItWorks badge/heading/copy — all token-driven; the four raw utilities are provably gone from the four files (rg sweep rc=1).
- **light-mode.spec.ts (Task 1, extended in Task 2):** 7 tests in 5 describes — forced-light wiring check, marketing token-resolution + scoped class sweeps, dashboard chrome (header strip via the color-mix probe, sidebar brand, trigger), login token-resolutions, in-page WCAG contrast legs (cyan >= 4.5 vs card, border >= 3 vs surface), and the 404 brand-asset treatment.
- **11-token review (Task 2):** 3 splits with computed AA margins (cyan #0e7490 5.13:1, muted-meta #62666c 5.53:1, danger-strong #b91c1c 6.20:1 incl. the /10 hover-wash case), 8 keeps with written rationale in the block header; freeze-lift notes record D-31 in both block headers.
- **Dialog retirement + borders + toast (Task 2):** --dialog-* gone from both blocks with zero surviving references; light border family at 3:1; sonner neutral toast surface token-driven while richColors keeps its typed vars.
- **Brand assets (Task 2):** both .lottie files downloaded and their color inventories parsed — the 404 asset's white-on-light invisibility is the concrete light-mode defect; the surface-deep plate fixes it in both modes, and the loading overlay sheds its hardcoded white scrim.

## Task Commits

| Task | Type | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | feat | `d856859` | Navbar.tsx, AppHeader.tsx, TeamSwitch.tsx, HowItWorks.tsx, light-mode.spec.ts (new) |
| 2 | feat | `dcc4a6b` | globals.css, Loading.tsx, PageNotFound.tsx, light-mode.spec.ts |

## Files Created/Modified

**Created:** `tests/e2e/light-mode.spec.ts`
**Modified:** `src/app/globals.css`, `src/components/common/Navbar/Navbar.tsx`, `src/components/dashboardLayout/AppHeader.tsx`, `src/components/dashboardLayout/TeamSwitch.tsx`, `src/components/home/HowItWorks.tsx`, `src/components/Others/Loader/Loading.tsx`, `src/components/Others/PageNotFound/PageNotFound.tsx`
**Deleted:** none (TeamSwitch's dead commented avatar block — comment-only content — removed within a modified file)

## Decisions Made

1. **Split 3, keep 8 — each with a written reason.** The review's primary candidates were split except where measurement said otherwise: danger-strong technically passed on plain #fafafa (4.58:1) but its own hover wash dropped to ~4.0:1, so it splits to #b91c1c (which the light gradient already uses); foreground-bright and the surface/gold family stay same-value because UnderConstruction paints an always-dark canvas in both modes; highlight-purple stays because its only consumer (Pagination.tsx) has zero importers — dead-consumer finding logged below for 08-09.
2. **The CTA mapping is text-primary-foreground, not text-foreground.** White-on-red was 3.15:1; the token gives 6.0:1 and matches every 08-04 primary Button. This is the palette pass's one deliberate dark-mode visual delta, in the direction the design system already took.
3. **PageNotFound plate over asset swap.** The artwork's color census (65 dark-slate + 56 black + 48 gold + 25 white/light-gray uses) rules out any single transparent background working in both modes; a rounded bg-surface-deep plate is the "asset whose background works on both" form — smallest diff, no new asset.
4. **Toast polish in CSS, not JS.** ThemedToaster's props were already the contract; the 02-UAT "light version looks bad" note is answered by retargeting sonner's neutral-surface CSS vars to tokens — typed richColors toasts are untouched by construction (they read different vars).
5. **render.ts consumed via the sanctioned list** (email clients cannot consume CSS vars — the mail.ts rationale verbatim); WINDOWS entries 6-7 marked fixed; the standing gate command's exclusion list documented in Deviations/Issues context.
6. **UI-03 stays Pending** — part 2 (tier-2 sweep + sidebar reconciliation) is 08-09's; `requirements-completed: []` follows the false-signal precedent.

## Deviations from Plan

**1. [Rule 3 - Blocker] Tailwind v4 alpha utilities compute as oklab/color-mix, not rgba**
- **Found during:** Task 1 verify (light-mode spec)
- **Issue:** `bg-background/80` computes to `oklab(0.985 … / 0.8)` — string comparison against any rgba form can never pass; a canvas-normalization attempt also failed (canvas echoes non-sRGB input)
- **Fix:** `expectTokenBackgroundAlpha` builds a probe element with the identical `color-mix(in oklab, var(--token) 80%, transparent)` construction and compares two engine-computed values — token-resolved proof by construction
- **Files modified:** tests/e2e/light-mode.spec.ts
- **Verification:** AppHeader background leg green (7/7)
- **Commit:** d856859

**2. [Rule 3 - Blocker] Sidebar-wide class sweep over-captured out-of-plan files**
- **Found during:** Task 1 verify
- **Issue:** sweeping `[data-sidebar='sidebar']` flagged NavMain/NavUser `text-slate-400` — those files are 08-09's sidebar reconciliation, not this plan's four files
- **Fix:** sweep scoped to the TeamSwitch block (the brand anchor's `space-y-5` root) — the plan's file-level sweep is faithfully mirrored at DOM level per WR-02 FILE surfaces
- **Files modified:** tests/e2e/light-mode.spec.ts
- **Verification:** dashboard sweep leg green
- **Commit:** d856859

**3. [Rule 1 - Bug] Own comment introduced a raw hex (zero-hex gate caught it)**
- **Found during:** Task 2 verify (hex gate)
- **Issue:** the PageNotFound treatment comment quoted the artwork's light-gray as `#ececec` — the 02-08 comments rule forbids raw hexes in touched comments
- **Fix:** reworded to "white and light-gray highlights"
- **Files modified:** src/components/Others/PageNotFound/PageNotFound.tsx
- **Verification:** hex gate 0 unsanctioned files
- **Commit:** dcc4a6b

**4. [Rule 3 - Blocker] Tracer-task verify legs that depend on Task-2 values**
- **Found during:** Task 1 (spec authoring)
- **Issue:** the WCAG contrast legs and the 404 token-heading leg assert values that only exist after Task 2's splits — a single-commit spec would be red at Task 1
- **Fix:** spec authored in two layers — Task 1 commits the token-resolution/sweep legs (green on pre-split values), Task 2 adds the contrast + brand-asset describes (green on post-split values); each commit independently green
- **Files modified:** tests/e2e/light-mode.spec.ts
- **Verification:** both commits' e2e runs green
- **Commits:** d856859, dcc4a6b

**Total deviations:** 4 (2 Rule-3 blockers in test mechanics, 1 Rule-1 comment fix, 1 Rule-3 ordering constraint). **Impact:** none on plan scope — all four are test-discipline mechanics; production changes landed exactly as planned.

## Issues Encountered

- **Environmental (pre-warned):** vitest leg reports exactly one failure — `tests/worker/health.test.ts` IN-01 `EADDRINUSE 127.0.0.1:9090` while the live production worker holds the health port (430 passed, 2 pre-existing skips). The live worker was NOT stopped; every other verify leg run individually to green against the final source state (08-03/08-04 pattern).
- **Out-of-scope discovery (logged for 08-09):** `src/components/common/Pagination.tsx` (highlight-purple's only consumer) has zero importers — dead component. Not deleted here (outside this plan's file list); recorded for the 08-09 tier-2 sweep to disposition.
- **Left as-is (documented):** TeamSwitch's display* locals and Avatar imports are now visibly unused in lint warnings (their comment-only consumers were deleted) — pre-existing warning posture, deliberately left for 08-09's sidebar reconciliation to either re-wire or remove; Navbar's mobile sign-out keeps `rose-400` (D-25 discipline: rose-400 != #ef4444, belongs to the 08-09 emerald/rose ternary migration).
- **Build-time stderr noise:** BetterAuthError lines during `next build` route-module evaluation (no env at build) — pre-existing since the throw-early gate; BUILD_RC=0 is the criterion.

## User Setup Required

None.

## Next Phase Readiness

- **08-09:** consumes the per-mode substrate unchanged (its criterion: dark values byte-stable where 08-05 left them); owns the tier-2 sweep, sidebar reconciliation (NavMain/NavUser raw classes + the dead Pagination disposition + the mixed emerald/rose ternaries), and EXTENDS tests/e2e/light-mode.spec.ts — the helper layer (forceLightTheme/tokenColor/probe/sweep/contrastRatio) and describe-per-surface structure are built for it.
- **08-07:** AI surfaces render on the split substrate — cyan affordances are light-AA by construction (the reserved-list cyan-as-text sites all consume --accent-cyan).
- **08-08:** Release B ships the light-pass; UI-05 completes there (08-04 deliberate deferral unchanged).

## Self-Check: PASSED

- Created file exists: `tests/e2e/light-mode.spec.ts` — FOUND. All 8 committed files present on disk.
- Commits exist: `d856859`, `dcc4a6b` in `git log` (2 plan commits measured over a7feeca..dcc4a6b).
- Task 1 acceptance re-run: four-file sweep rc=1 clean (PASS); light-mode spec 7/7 in forced light theme (PASS).
- Task 2 acceptance re-run: .dark block delta vs HEAD~1 = exactly the 3 dialog tokens, zero value edits (PASS); `rg 'dialog-surface|dialog-foreground|dialog-muted' src/` rc=1 zero references (PASS); zero-hex gate 0 unsanctioned files with render.ts dispositioned (PASS).
- Plan verification re-run: full playwright 44/44; vitest 430 passed + 1 pre-warned environmental IN-01; lint 0 errors; typecheck clean; schema:gate/worker:boundary/denylist:diff/build/cron:remnants each green; `git diff` over tests/api + tests/worker across both commits empty.
