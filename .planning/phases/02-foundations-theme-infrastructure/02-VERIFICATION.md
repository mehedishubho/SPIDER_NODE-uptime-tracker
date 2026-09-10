---
phase: 02-foundations-theme-infrastructure
verified: 2026-09-11T03:20:00Z
status: gaps_found
score: 6/11 must-haves verified
behavior_unverified: 2 # truths present + wired but runtime behavior not exercised in this verification
overrides_applied: 0
gaps:
  - truth: "Dark mode is visually identical to today after the theme/hex-to-token work (criterion 3: 'dark visually identical', 'no visual change'; THM-03 'no visual change' clause)"
    status: failed
    reason: "Two verifiable computed-value regressions in dark mode landed with the 02-07/02-08 theme work and remain unfixed (review CR-01/CR-02, independently re-confirmed by this verifier via git + current tree). The token layer itself IS byte-identical (all 27 original :root values preserved in .dark — verified); the regressions are in utility swaps and a theme-system edge surface the byte-identity gate could not see."
    artifacts:
      - path: "src/components/Dashboard/Dashboard.tsx (also DashboardStatus, Incidents, MonitorDetails, PublicStatus, StatusContent, Footer, LivePreviewMockup)"
        issue: "CR-01: 33 opacity-suffixed emerald-500-derived utilities (bg-emerald-500/10 x13, border-emerald-500/30 x11, bg-emerald-500/20 x3, border-emerald-500/20 x3, bg-emerald-500/5 x3) were swapped to status-up/* whose dark value is #34d399 (emerald-400), not emerald-500's #10b981 — computed dark tints/borders on UP-status pills, banners, footer badge and home mockup changed. Confirmed: current grep counts 19 lines / 33 instances; git bebd879 removed the emerald-500 originals."
      - path: "src/app/global-error.tsx"
        issue: "CR-02: line 14 body className bg-[#121212] -> bg-background. global-error replaces the root layout, so ThemeProvider/next-themes never injects .dark on this surface; --background resolves to the light :root #fafafa. The fatal-error page flips from always-dark to always-light. Pre-state confirmed via git 53b0ce8:14."
    missing:
      - "Revert the 33 opacity-suffixed swaps to their original emerald-500 utilities (they were palette classes, not orphan hexes — shadow-emerald-500/5 was correctly left alone and they should match), OR record an explicit accepted-deviation override (re-baselined gate + visual diff) if converging on one green is the intended design end state"
      - "Restore the frozen literal in src/app/global-error.tsx (bg-[#121212]) — the only byte-identical option for a surface outside the theme system"
deferred: # Items addressed in later phases — not actionable gaps
  - truth: "Error responses never include stack traces (criterion 4 clause)"
    addressed_in: "Phase 6"
    evidence: "Phase 6 Success Criterion 3 (verbatim): 'No endpoint accepts a secret via query string and no CRON_SECRET reference remains in the codebase; error responses never leak stack traces or internals' + requirement SEC-06 (Phase 6, Pending): 'No secret accepted via query string; CRON_SECRET retires with the cron endpoints (S-4/R15)'. The two remaining echo sites (src/app/api/cron/check/route.ts:45 and src/app/api/cron/cleanup/route.ts:39, returning error.message + error.stack) are pinned AS-IS in tests/api/cron-and-webhook.handler.test.ts ('PINNED DEFECT (S-4 family): the 500 body echoes err.message AND the full stack') with in-file Phase-6/SEC-06 remediation notes. The echo is only reachable after CRON_SECRET validation. The monitors GET leak (the plan-scoped FND-07 fix) IS fixed and test-pinned."
behavior_unverified_items:
  - truth: "Theme applies before first paint (no flash of wrong theme) and produces zero hydration mismatches during load and toggle cycling"
    test: "Load /login and the dashboard with no stored preference, cycle Light/Dark/System, reload; watch first paint and the browser console"
    expected: "html.dark is set before first paint (no light flash), selected theme persists across reload, zero hydration/mismatch console errors"
    why_human: "The e2e spec (tests/e2e/smoke.spec.ts — 5 dedicated 'Theme:' tests incl. a zero-hydration-warnings collector) exists and is wired, but running it requires a built server (next start), which this verifier may not launch. Final-green is documented (18/18 e2e) but not reproduced here."
  - truth: "Toasts render in the active palette — the Toaster follows the resolved theme"
    test: "Trigger a sonner toast (e.g. save a monitor) in dark, then toggle light and trigger another"
    expected: "Toast chrome follows the resolved theme (richColors, position top-right frozen)"
    why_human: "ThemedToaster is present and wired inside ThemeProvider (src/components/theme/ThemedToaster.tsx reads useTheme().resolvedTheme into the Toaster theme prop), but no test asserts toast rendering at runtime — presence checks cannot see rendered toast chrome."
human_verification: # surfaced because gaps_found also fires; these items remain open regardless
  - test: "Review .env.example content (permission rules deny .env* to agents — IN-06)"
    expected: "Every variable the app reads is listed (31 unique process.env.* reads in src/ + ecosystem.config.js at HEAD) with names + purpose comments only; zero real secrets or token-shaped values (02-01 executor reported a 24-key equality sweep + 0 token-shaped values; not independently confirmable)"
    why_human: "Deny rule blocks agent reads of .env* paths; only existence + git-tracking verified programmatically"
  - test: "Visual: dark dashboard/status pages/home — confirm or accept CR-01 tint changes"
    expected: "UP-status pill/banner/border tints across Dashboard, Incidents, MonitorDetails, DashboardStatus, PublicStatus, StatusContent, Footer, LivePreviewMockup either look unchanged (post-fix) or the single-green convergence is explicitly accepted via override"
    why_human: "Computed color values are verifiable, perceptual identity is not; the byte-identity gate cannot see utility-level value changes"
  - test: "Visual: fatal-error page (force src/app/global-error.tsx to render)"
    expected: "Full-bleed dark #121212 background (post-fix); before fix it renders light #fafafa with a dark inner card"
    why_human: "Requires triggering a root-layout-crashing error in a running app"
  - test: "02-07/02-08 deferred visual spot-checks: both palettes, auth + dashboard surfaces, toast theming"
    expected: "Light palette reads correctly on migrated surfaces; no layout shift vs pre-phase; toasts follow theme; copy changes limited to the six toggle strings"
    why_human: "Planner-deferred end-of-phase human checks (human_verify_mode); grep cannot judge visual layout/copy equivalence"
  - test: "WR-02 decision: light-mode legibility of unmigrated surfaces (text-white on bg-background in Navbar/TeamSwitch, bg-slate-950/80 header, text-slate-300/400 marketing copy)"
    expected: "Either accept as Phase-8 scope (record it) or gate/fix the worst offenders — a user opting into light sees invisible headings on several surfaces today"
    why_human: "Product/scope judgment on a user-reachable state; review WR-02 lists the exact sites"
---

# Phase 2: Foundations & Theme Infrastructure Verification Report

**Phase Goal:** A safety net exists — pnpm, enforced CI gates, and characterization tests running against real Postgres/Redis — and stable theme tokens land, all with zero change to monitoring behavior.
**Verified:** 2026-09-11T03:20:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

**Process note (Mode: mvp discrepancy):** ROADMAP.md carries `Mode: mvp` on every phase, but the Phase 2 goal is not user-story format (`gsd-tools user-story.validate` → false). Per verify-mvp-mode.md the MVP framing fires only when BOTH mode: mvp AND a user-story goal hold, so standard goal-backward verification was applied. Recommendation: run `/gsd mvp-phase 2` or drop the mode marker for infrastructure phases — this discrepancy will recur at every phase in this milestone.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Fresh clone installs/builds with pnpm; `pnpm verify` chain (docker up --wait → lint → typecheck → test → build → e2e) green; `ignoreBuildErrors` off; Node pinned dev+VPS (SC-1, amended manual-verify contract) | ✓ VERIFIED | pnpm-lock.yaml committed (304KB); packageManager pnpm@10.34.5; engines ">=22 <25"; .nvmrc=24; package-lock.json absent from tree AND git; verify script is the exact D-02 chain (package.json). next.config.ts has NO typescript block; next.config.js/.mjs deleted. **Independently reproduced this session:** `pnpm typecheck` exit 0; `pnpm lint` 0 errors/37 warnings exit 0; docker test stack up+healthy. Build/e2e green rests on documented evidence whose every cross-checkable count matched my runs exactly. |
| 2 | docker compose brings up Postgres + Redis locally, health-gated (SC-2a) | ✓ VERIFIED | docker-compose.test.yml: postgres:17-alpine + redis:8-alpine, both with healthchecks; ports 5453/6390 (documented deviation from plan's 5433/6380 — sibling-stack collision, noted in-file). Containers observed running healthy during this verification. |
| 3 | Characterization suite pins due-time filtering, PENDING→UP/UP→DOWN/DOWN→UP, incident open/resolve, Telegram selection, batcher math, API contracts (SC-2b) | ✓ VERIFIED | tests/integration/cron-logic.test.ts (757 lines, 19 tests — titles cover due-time filtering, 200-399/400-boundary classification, 1-strike, all four transition paths incl. UNKNOWN→UP no-Telegram asymmetry, incident open/resolve, Telegram selection by content phrase); tests/integration/db-batcher.test.ts (7 tests — aggregation, latest-wins, DOWN-counts, uptime clamp, failure-swallow pin, no double-flush); tests/api/* handler suites (verbatim 401 bodies incl. pinned misspellings, ownership via distinct user ids, 400/403/429, pinned S-4 defects) + monitors.core.spec.ts HTTP-level. **3 named tests run green by this verifier** (see Behavioral Spot-Checks). |
| 4 | Deliberately changing any pinned behavior turns the suite red — mutation-tested (SC-2c) | ✓ VERIFIED | Three durable evidence commits (9a40b93, be56966, b7e2170) whose bodies carry the exact named failing cases and RED/GREEN counts (e.g. mutation 1: 6 failed / 13 passed, cases 2b/3/5/8/11/14; revert: 19/19). Mutations were working-tree-only by design; file test counts (19/7/12) match my runs exactly. |
| 5 | User can toggle Light/Dark/System in the header on both surfaces; choice persists (SC-3a) | ✓ VERIFIED | ThemeToggle.tsx cycles light→dark→system via useTheme().setTheme; mounted in src/components/dashboardLayout/AppHeader.tsx:17 AND src/app/(authLayout)/layout.tsx:12; composes existing shadcn Tooltip + hugeicons; hydration guard via useSyncExternalStore. e2e spec asserts cycle order, aria-labels, and persistence across reload. |
| 6 | Theme applies before first paint; no flash; no hydration mismatch (SC-3b) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | ThemeProvider (next-themes attribute="class" defaultTheme="dark" enableSystem) wraps everything in layout.tsx; html suppressHydrationWarning present; 5 dedicated "Theme:" e2e tests exist incl. a console/pageerror hydration-problem collector. Runtime proof requires a booted server — not launchable by this verifier. |
| 7 | Toasts follow the resolved theme (SC-3c) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | ThemedToaster.tsx reads useTheme().resolvedTheme into the sonner Toaster theme prop (richColors + position frozen, SSR-safe ternary); mounted inside ThemeProvider in layout.tsx. No runtime test asserts rendered toast chrome. |
| 8 | Dark mode visually identical to today; hex routes through semantic tokens with NO visual change (SC-3d / THM-03) | ✗ FAILED | Token layer is clean — all 27 original :root values byte-identical in .dark (verified by token-by-token diff vs git 53b0ce8~) and raw-hex gate green (8 remaining hexes = excluded Google brand marks). BUT two utility/surface regressions: (a) 33 emerald-500-derived opacity utilities swapped to status-up/* whose dark value is #34d399 ≠ emerald-500 #10b981 — computed dark tints/borders changed on UP-status surfaces in 8 files; (b) global-error.tsx body bg-[#121212] → bg-background, and .dark never applies on that surface → fatal-error page flips to light #fafafa. Both independently confirmed in current tree + git. See Gaps Summary. |
| 9 | No ngrok binary or log in the repo (SC-4a) | ✓ VERIFIED | Absent from working tree and from git ls-files (also: .github entirely absent; root test-*.js scripts deleted). |
| 10 | .env.example documents every variable the app reads, names + purpose only (SC-4b) | ? UNCERTAIN (human) | File exists and is git-tracked; content unreadable by agents (deny rule on .env* — IN-06 confirmed for this verifier too). 31 unique process.env.* reads in src/ + ecosystem.config.js at HEAD for the human to reconcile. |
| 11 | Error responses never include stack traces (SC-4c) | DEFERRED (Phase 6) | Two echo sites remain (cron check route.ts:45, cleanup route.ts:39 — error.message + error.stack), pinned AS-IS as scheduled defects with Phase-6/SEC-06 notes in-test; reachable only after CRON_SECRET validation. Phase 6 SC-3 covers this verbatim ("error responses never leak stack traces or internals") + SEC-06 (Pending). The plan-scoped FND-07 leak (monitors GET) IS fixed — code + passing test verified. Not counted in score; recorded under Deferred Items. |

**Score:** 6/11 truths verified (2 present-but-behavior-unverified, 1 failed, 1 human-uncertain, 1 deferred)

### Prohibition Checks (02-07 must_haves_prohibitions)

| Statement | Tier | Status | Evidence |
|-----------|------|--------|----------|
| No new UI dependencies beyond next-themes | judgment (code-checkable) | ✓ VERIFIED | git diff 53b0ce8..HEAD package.json: only next-themes ^0.4.6 added as runtime UI dep (installed 0.4.6); @playwright/test/vitest/@types/node/typescript are dev tooling |
| No parallel token system — @theme inline extended, not replaced | judgment | ✓ VERIFIED | globals.css retains the full original @theme inline mapping block; additions are color mappings only |
| No layout, spacing, typography, or copy changes | judgment | 🚩 unverified-prohibition — human review recommended | e2e smoke green (documented) + review found no layout changes, but no automated check can see visual layout/copy equivalence; deferred to the 02-07 human visual check |

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Error responses never include stack traces (criterion 4 clause) | Phase 6 | Phase 6 SC-3 verbatim: "error responses never leak stack traces or internals"; SEC-06 (Phase 6, Pending); cron echo pinned in-test with remediation notes |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| pnpm-lock.yaml | committed lockfile | ✓ VERIFIED | 304KB, tracked, install tree functional (typecheck/lint/tests ran) |
| pnpm-workspace.yaml | build-script approvals | ✓ VERIFIED | allowBuilds: prisma/@prisma/client/@prisma/engines/unrs-resolver (documented deviation: allowBuilds is the pnpm>=10.26 form; onlyBuiltDependencies removed in pnpm 11 — FND-01's intent satisfied) |
| .nvmrc | Node 24 | ✓ VERIFIED | "24" |
| .env.example | full variable set | ✓ EXISTS / ⚠ CONTENT HUMAN | tracked in git; content agent-unreadable (deny rule) |
| docker-compose.test.yml | Postgres+Redis health-gated | ✓ VERIFIED | both services healthchecked; ports 5453/6390 (documented deviation) |
| vitest.config.ts / playwright.config.ts | scaffold wiring | ✓ VERIFIED | @→src alias; globalSetup; .test.ts/.spec.ts split; api+e2e projects; webServer CRON_MODE=vercel + NEXT_PUBLIC_DEV_BASE_URL |
| tests/setup/global-setup.ts | localhost DB guard + schema push | ✓ VERIFIED | fail-closed guard (exported, unit-tested in db-guard.test.ts); prisma db push deviation (--force-reset dropped: Prisma 7 + consent gate; fails closed on drift — documented) |
| tests/integration/cron-logic.test.ts | transition pins | ✓ VERIFIED | 757 lines, 19 tests |
| tests/integration/db-batcher.test.ts | flush-math pins | ✓ VERIFIED | 239 lines, 7 tests incl. failure-swallow |
| tests/api/* (8 files) | API contract pins | ✓ VERIFIED | 1809 lines total across harness + 7 suites + 1 HTTP spec |
| tests/e2e/smoke.spec.ts | ONE smoke + theme assertions | ✓ VERIFIED | 190 lines, 6 tests (login+monitor render, default-dark, toggle presence, cycle, persistence, hydration) |
| src/components/theme/* (3 files) | ThemeProvider/Toggle/Toaster | ✓ VERIFIED | all present, wired into layout.tsx + both surfaces |
| src/app/globals.css | split palettes + status tokens | ✓ VERIFIED (token layer) | .dark byte-identical to old :root (27/27 tokens); 13 same-value tokens; utility-layer regressions tracked as Gap 1 |
| docs/DEPLOY-RUNBOOK.md | manual-deploy amendments | ✓ VERIFIED | 231 lines; §3a one-time VPS Node24+pnpm switch (nvm/corepack+fallback/npm-tree replace/ecosystem edit/prisma client in tarball); typed smoke checks; Phase-2 no-migrate; pnpm verify gate with ≤5-min budget + operator-discipline statement; zero CI-era instructions remain |
| next.config.ts | no typescript block | ✓ VERIFIED | reactCompiler only; duplicates deleted |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| package.json verify | full D-02 chain | script | ✓ WIRED | docker up --wait && lint && typecheck && test && build && test:e2e |
| layout.tsx | ThemeProvider → html class | next-themes attribute="class" | ✓ WIRED | outermost wrap; pre-paint via next-themes; suppressHydrationWarning on html |
| ThemedToaster | sonner Toaster theme | useTheme().resolvedTheme | ✓ WIRED | mounted inside ThemeProvider |
| ThemeToggle | both surfaces | AppHeader:17, authLayout:12 | ✓ WIRED | imports + JSX verified |
| vitest | @→src + docker DB | alias + env + globalSetup | ✓ WIRED | proven by 3 green named-test runs |
| playwright webServer | CRON_MODE=vercel → no cron | instrumentation early-return | ✓ WIRED | env pinned in config; documented Pitfall 1 |
| handler tests | route modules + vi.mock(next-auth/@/lib/prisma) | direct import harness | ✓ WIRED | _harness.ts 175 lines; mock-args ownership assertions |
| HTTP-level specs | booted server api project | playwright api project | ✓ WIRED | monitors.core.spec.ts (284 lines) |
| runbook | repo pins + verify script | §3a ↔ .nvmrc/packageManager | ✓ WIRED | cross-referenced values match exactly |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 1-strike DOWN transition pinned (real Postgres) | `pnpm exec vitest run tests/integration/cron-logic.test.ts -t "3. DOWN classification"` | 1 passed, 18 skipped (19 in file) — exit 0 | ✓ PASS |
| db-batcher flush math (latest-wins, lastChecked) | `pnpm exec vitest run tests/integration/db-batcher.test.ts -t "2. flush math"` | 1 passed, 6 skipped — exit 0 | ✓ PASS |
| Monitors GET 500 contract (FND-07 fix: error key only, no details echo) | `pnpm exec vitest run tests/api/monitors.handler.test.ts -t "500 on prisma failure"` | 1 passed, 11 skipped — exit 0 | ✓ PASS |
| Typecheck gate green (ignoreBuildErrors off) | `pnpm typecheck` | exit 0 | ✓ PASS |
| Lint gate green (errors block) | `pnpm lint` | 0 errors, 37 warnings, exit 0 | ✓ PASS |
| Hex gate (no raw hex outside exclusions) | grep over src/ | 8 remaining = Google brand marks only | ✓ PASS |
| Docker stack healthy | `docker ps` | spidernode-test-db + redis Up (healthy) | ✓ PASS |
| Full build + full vitest (102) + full e2e (18) | not run (server/build launch out of verifier scope) | documented green in 02-06..02-09 summaries; every cross-checkable count matched this verifier's runs | ? DOCUMENTED-ONLY |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| FND-01 | 02-01 | pnpm migration (lockfile, npm artifacts removed, build scripts configured) | ✓ SATISFIED | lockfile committed; package-lock/ngrok/test-scripts gone; allowBuilds (documented newer form of onlyBuiltDependencies) |
| FND-02 | 02-06 | Typecheck enforced (ignoreBuildErrors off), gates green | ✓ SATISFIED | next.config.ts clean; tsc exit 0 (this session); lint 0 errors |
| FND-03 | 02-01 | Node standardized dev/VPS before tool pins (BullMQ 6 pinned) | ✓ SATISFIED | .nvmrc 24 + engines >=22<25 + runbook §3a identical VPS pin; BullMQ parenthetical is prospective policy (bullmq not yet a dependency — Phase 3+) |
| FND-04 | 02-02 | Vitest + Playwright + docker Postgres/Redis | ✓ SATISFIED | all artifacts verified + running |
| FND-05 | 02-03, 02-09 | runCronChecks characterization | ✓ SATISFIED | 19-test suite + mutation-1/3 red/green commits |
| FND-06 | 02-03, 02-05, 02-09 | db-batcher + API contract characterization | ✓ SATISFIED | 7-test batcher suite + 8 API files + mutation-2 two-layer red/green |
| FND-07 | 02-01 | ngrok removed, .env.example full, no stack traces | ◐ PARTIAL | ngrok ✓; .env.example exists ✓ / content human; stack-trace clause: monitors leak fixed ✓, cron echo deferred Phase 6 (SEC-06, pinned in-test) |
| THM-01 | 02-07 | theme infra: light :root, frozen .dark, pre-paint, no mismatch | ✓ SATISFIED (runtime → human) | artifacts + byte-identical .dark verified; pre-paint/hydration runtime behavior → human items |
| THM-02 | 02-08→02-07 | toggle + resolved theme to Toaster | ✓ SATISFIED (runtime → human) | both placements wired; toast runtime → human |
| THM-03 | 02-08 | hex→tokens, no visual change | ✗ NOT SATISFIED | hex migration itself byte-identical ✓; "no visual change" violated by CR-01 (33 swaps) + CR-02 (global-error) — see Gap |
| DEP-04 | 02-02, 02-04 | CI gates → amended manual verify contract | ✓ SATISFIED | verify chain + runbook gate section (D-02/D-20); CONTEXT D-01/D-02 amendment applied |

No orphaned requirements: REQUIREMENTS.md maps exactly these 11 IDs to Phase 2; all are claimed by plan frontmatters.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/app/api/cron/check/route.ts | 45 | stack trace in 500 body (pinned defect) | ℹ️ Info | scheduled Phase 6 / SEC-06 — deferred, documented in-test |
| src/app/api/cron/cleanup/route.ts | 39 | same | ℹ️ Info | same |
| src/components/Dashboard/Dashboard.tsx | 64-68 | dead errData.details branch (WR-03 — server stopped sending the field) | ⚠️ Warning | misleading dead code; trivial cleanup |
| src/components/dashboardLayout/TeamSwitch.tsx + globals.css | 101, 102-104/150-152 | --dialog-* trio not mapped in @theme → text-dialog-foreground generates no CSS (WR-01; usage in commented JSX only) | ⚠️ Warning | no runtime impact today; uncommenting yields silently unstyled element |
| src/components/common/Navbar, TeamSwitch, commonLayout pages, AppHeader | various | text-white / bg-slate-950 hardcodes illegible in light mode (WR-02) | ⚠️ Warning | user-reachable via toggle; accept as Phase-8 scope or fix — human decision |
| src/components/ui/sidebar.tsx | 607-610 | useMemo→useState behavior-adjacent change inside "type fixes" commit (IN-01) | ℹ️ Info | negligible risk; should have been named in summary |
| playwright.config.ts | 52 | reuseExistingServer without CI guard (IN-02) | ℹ️ Info | stale-server masking risk |
| tests/setup/global-setup.ts | 13-19 | ::1 not accepted (IN-03) | ℹ️ Info | fail-closed direction; safe |
| DeleteModal.tsx | 1-103 | fully commented-out file that received token churn incl. one value-changing swap in comments (IN-05/IN-07) | ℹ️ Info | dead code; delete file or restore |

Debt-marker gate: zero TBD/FIXME/XXX in phase-modified files (one benign "placeholder" word in a hydration-guard comment).

### Human Verification Required

See `human_verification` in frontmatter (5 items): .env.example content review (agent-denied), CR-01 visual confirm/accept, global-error page visual, 02-07/02-08 deferred visual spot-checks (palettes/toast/layout/copy), WR-02 light-mode scope decision.

### Gaps Summary

The safety net is genuinely built and strong: toolchain, docker stack, and a characterization suite whose pins I re-ran green against real Postgres, with durable mutation-proof commits — criterion 1, 2, and 4 (minus the explicitly Phase-6-deferred stack-echo clause) all hold, and monitoring behavior is untouched (type-only lib changes, byte-identical token layer).

**The single failed truth is criterion 3's zero-visual-change clause, in two small, mechanical, fully-diagnosed places:**

1. **CR-01 (33 utility swaps):** emerald-500-derived opacity utilities → status-up/* whose dark value is emerald-400's #34d399, changing computed dark tints/borders on UP-status surfaces across 8 files. The hex gate could not see this class of change (it checks raw hexes, not utility values). Fix: revert to the original emerald-500 utilities (byte-identical path, matching the correctly-unswapped shadow-emerald-500/5), OR record an explicit override if single-green convergence is the intended design.
2. **CR-02 (global-error.tsx):** bg-[#121212] → bg-background on the one surface where next-themes never injects .dark — the fatal-error page now renders light. Fix: restore the literal.

Both were surfaced by the committed code review (02-REVIEW.md) as Critical, and nothing landed after it (last commit is the review report itself). No override exists for this truth, and Phase 8's redesign is not a recorded remediation for these accidental regressions, so they cannot be deferred under Step 9b's conservative rule.

**This looks potentially intentional (CR-01 only).** If converging on one green is the desired end state, add to this file's frontmatter:

```yaml
overrides:
  - must_have: "Dark mode is visually identical to today after the hex-to-token migration"
    reason: "Single-green convergence accepted: status-up token replaces the two-green emerald-400/500 system; visual diff recorded"
    accepted_by: "{name}"
    accepted_at: "{ISO timestamp}"
```

CR-02 is not override-shaped (it is a plain regression on the worst surface to regress) — fix it.

Closure is cheap: two file-scope edits + a green `pnpm verify`, then re-verify. The ROADMAP phase checkbox was pre-marked [x] by the executor; per this verdict it should be treated as open until the gap closes or an override is recorded.

---

_Verified: 2026-09-11T03:20:00Z_
_Verifier: Claude (gsd-verifier)_
