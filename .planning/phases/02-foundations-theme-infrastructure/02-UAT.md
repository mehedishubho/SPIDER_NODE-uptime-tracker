---
status: pending
phase: 02-foundations-theme-infrastructure
source: [02-VERIFICATION.md (round 2), 02-10-SUMMARY.md]
started: 2026-09-12T00:00:00Z
updated: 2026-09-12T00:00:00Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

[not started — awaiting human]

## Tests

### 1. .env.example content review (IN-06)
expected: Every variable the app reads is listed with name + purpose comment ONLY — cross-check against the 31 unique `process.env.*` reads in src/ + ecosystem.config.js. Zero real secrets or token-shaped values anywhere in the file. (02-01 executor reported a 24-key equality sweep + 0 token-shaped values; agents cannot read `.env*` paths to confirm — deny rule.)
result: pending
source: manual
coverage_id: 02-VERIF/H1

### 2. Dark surfaces UNCHANGED visual confirm (post-closure)
expected: In dark mode, UP-status pills/banners/borders across Dashboard, Incidents, MonitorDetails, DashboardStatus, PublicStatus, StatusContent, Footer badge, and the home LivePreviewMockup look IDENTICAL to pre-phase (emerald-500 tints, not the lighter emerald-400 convergence). Computed values proven identical by the round-2 verifier — this is the cheap perceptual confirm.
how: `export NEXT_PUBLIC_DEV_BASE_URL="http://localhost:3007" && pnpm dev`, open http://localhost:3007, toggle dark, compare the UP-status surfaces.
result: pending
source: manual
coverage_id: 02-VERIF/H2

### 3. Fatal-error page UNCHANGED visual confirm
expected: global-error renders full-bleed dark `#121212` background with the dark inner card — always-dark regardless of theme state.
how: temporarily add `throw new Error("UAT-crash");` as the first statement inside `src/app/layout.tsx`, load http://localhost:3007, observe the fatal-error page, then revert the throw.
result: pending
source: manual
coverage_id: 02-VERIF/H3

### 4. Both-palette / toast / layout / copy spot-checks (02-07 + 02-08 deferred)
expected: Light palette reads correctly on migrated surfaces; no layout shift vs pre-phase; toasts follow the resolved theme (trigger one via a save action in dark, toggle light, trigger another); theme applies BEFORE first paint (no light flash on dark reload) with zero hydration/mismatch console errors across Light/Dark/System cycling + reload; copy changes limited to the six toggle-related strings.
result: pending
source: manual
coverage_id: 02-VERIF/H4

### 5. WR-02 scope decision — light-mode legibility of unmigrated surfaces
expected: A recorded decision: either ACCEPT as Phase-8 scope (light-mode `text-white` headings on Navbar/TeamSwitch, `bg-slate-950/80` header, `text-slate-300/400` marketing copy — a user opting into light sees invisible/illegible headings on several surfaces today) or gate/fix the worst offenders now. Record the decision + date below when made.
result: pending
source: manual decision
coverage_id: 02-REVIEW/WR-02

## Notes

- All programmatic gates are green (round-2 verification: 7/11 truths verified, both round-1 gaps independently confirmed closed, zero regressions, full `pnpm verify` exit 0). These 5 items are open because they are agent-unreachable by construction (deny rules / perception / product judgment).
- Items 2–4 previously gated the "regression" direction; post-closure they check for UNCHANGED pre-phase appearance.
- After all 5 pass (or are explicitly dispositioned), re-run the verification step to flip `human_needed` → `passed` and close Phase 2.

## Decision Record

(used by Test 5 — WR-02 disposition)
