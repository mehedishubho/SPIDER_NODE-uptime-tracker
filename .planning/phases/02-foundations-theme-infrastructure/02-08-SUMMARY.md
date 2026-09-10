---
phase: 02-foundations-theme-infrastructure
plan: 08
subsystem: theme-infrastructure
tags: [theming, tokens, hex-migration, globals-css, thm-03, dark-byte-identity]
requires:
  - "02-07 (semantic token vocabulary + status tokens + next-themes wiring)"
  - "02-02 (characterization suite: 102 vitest + 18 e2e as the no-change proof)"
provides:
  - "hex-free src/ outside the three sanctioned exclusions (standing hex gate reusable by later phases)"
  - "13 same-value-both-modes tokens in globals.css incl. the UI-SPEC pair --foreground-invert/--highlight-purple"
  - "status-up/status-down utility adoption across dashboard/status/public-status components (D-25)"
affects:
  - "src/app/globals.css (token additions + @theme inline mappings)"
  - "38 hex-bearing files across src/components/** and src/app/**"
  - "Phase 8 UI-03 (full per-hex/per-class light review inherits the flagged leftovers)"
tech-stack:
  added: []
  patterns:
    - "same-value-both-modes tokens as the mechanical fallback for orphan hexes (dark byte-identity by construction)"
    - "CSS var() references in imperative widget config (sweetalert2 colors read the token system at computed time)"
key-files:
  created: []
  modified:
    - src/app/globals.css
    - 37 component/route files (full per-file table below)
decisions:
  - "11 extra same-value tokens beyond the UI-SPEC pair — zero-hex gate forbids orphans, byte-identity forbids nearest-token fits; all flagged for Phase 8 UI-03"
  - "rose-*/amber-*/slate-* DOWN-branch classes left as-is (D-25): rose-400 != #ef4444, a status-down swap would change dark values; only emerald UP branches migrated"
  - "sweetalert2 config colors -> var(--primary)/var(--dialog-*) so the Swal popup stays white-in-both-modes exactly as today"
metrics:
  duration: 796s (~13min)
  completed: 2026-09-10
  tasks: 2
status: complete
---

# Phase 02 Plan 08: Hex-to-Token Migration (THM-03) Summary

**One-liner:** Mechanical sweep migrating 225 raw hex occurrences across 38 files to semantic/same-value token utilities (plus 71 UP-semantic emerald-class swaps to `status-up`) with dark computed values preserved by construction — hex gate zero, `pnpm verify` fully green.

## What Was Built

THM-03 complete. Every color in `src/` outside the three sanctioned exclusions now routes through the token system, making the 02-07 palette the single source of color truth. Dark mode is unchanged by construction: every mapping either targets a token whose `.dark` value is byte-identical to the replaced hex, or a same-value token whose value is identical in both modes. Light mode is unchanged from its 02-07 state (the only mode-dependent mappings — `bg-background`, `text-foreground`, `status-up/down`, `bg-primary` — resolve to values the 02-07 palette already curated).

- `src/app/globals.css` — 13 new tokens added to BOTH `:root` and `.dark` with identical values (verified: all 13 appear exactly twice, byte-identical), plus `@theme inline` `--color-*` mappings for the 10 className-consumed ones.
- 225 hex occurrences migrated across 38 files; 71 `emerald-*` class instances with UP semantics migrated to `status-up` utilities; the one DOWN-semantic hex site (Dashboard monitor-row left border/wash) migrated to `status-down`.
- 14 root page containers `bg-[#121212] text-slate-100` → `bg-background text-foreground` (the UI-SPEC body-text mapping; input/`slate-900`-surface `text-slate-100` deliberately NOT touched).

## New Tokens (exact values)

| Token | Value (identical in `:root` and `.dark`) | Consumed by |
|---|---|---|
| `--foreground-invert` | `#0f172a` (UI-SPEC pair) | text-on-light/brand + panel backgrounds: Navbar mobile menu, LoginForm/RegisterForm divider chips, FeatureGrid band, ApiMonitoringContent + api-reference code panels, FeedbackButton sheet, global-error card, DeleteModal comment |
| `--highlight-purple` | `#A141FE` (UI-SPEC pair) | Pagination active/border/buttons, DeleteModal (dead-code comment) |
| `--accent-cyan` | `#00E5FF` | NavMain active-item/NEW badge text |
| `--muted-meta` | `#8A8D91` | NavMain group labels, TeamSwitch meta text (comment) |
| `--danger-strong` | `#DE251F` | TeamSwitch logout action |
| `--surface-deep` | `#0f0f0f` | UnderConstruction gradient start + text-on-gold |
| `--surface-raised` | `#1e1e1e` | UnderConstruction gradient end + track/button surfaces |
| `--accent-gold` | `#E6B800` | UnderConstruction gold accent |
| `--accent-gold-deep` | `#c9a227` | UnderConstruction gold hover/gradient end |
| `--foreground-bright` | `#f5f5f5` | UnderConstruction body text |
| `--dialog-surface` | `#FFFFFF` | TeamSwitch Swal `background` (var() ref; not @theme-mapped) |
| `--dialog-foreground` | `#111827` | TeamSwitch Swal `color` (var() ref; not @theme-mapped) |
| `--dialog-muted` | `#6B7280` | TeamSwitch Swal `cancelButtonColor` (var() ref; not @theme-mapped) |

## Hex Gate (final output)

```
$ rg -l "#[0-9a-fA-F]{3,8}" src/ | tr '\' '/'   # normalized for Windows rg backslash paths
src/lib/mail.ts
src/components/Auth/RegisterForm.tsx
src/components/Auth/LoginForm.tsx
src/app/globals.css
$ <that list> | grep -v -e globals.css -e mail.ts -e LoginForm -e RegisterForm | wc -l
0            # HEX_GATE_PASS
```

Only the four sanctioned files retain hexes: globals.css (token definitions), mail.ts (email HTML — email clients cannot use CSS vars), LoginForm/RegisterForm (Google brand-mark `fill` values only — their OTHER hexes were migrated; the gate excludes these files wholesale because the brand marks stay).

## Per-file Migration Counts

Hex occurrences migrated (from removed diff lines) — 225 total:

| Count | File | Count | File |
|---|---|---|---|
| 31 | Dashboard/Dashboard.tsx | 5 | Auth/ForgotPasswordForm.tsx |
| 21 | Others/UnderConstruction/UnderConstruction.tsx | 4 | home/HowItWorks.tsx |
| 11 | dashboardLayout/TeamSwitch.tsx | 4 | home/FeatureGrid.tsx |
| 10 | common/DeleteModal.tsx (comments only) | 4 | common/Pagination.tsx |
| 10 | Auth/LoginForm.tsx | 4 | Status/PublicStatus.tsx |
| 9 | Dashboard/ProfileComponent.tsx | 4 | (commonLayout)/cookie-settings/page.tsx |
| 9 | Auth/ResetPasswordForm.tsx | 3 | (commonLayout)/docs/page.tsx |
| 8 | common/Navbar/Navbar.tsx | 3 | (commonLayout)/api-reference/page.tsx |
| 8 | common/Footer/Footer.tsx | 2 | dashboardLayout/NavMain.tsx |
| 8 | Features/ApiMonitoringContent.tsx | 2 | Pages/SecuritySlaContent.tsx |
| 8 | Dashboard/DashboardStatus.tsx | 2 | app/global-error.tsx |
| 8 | Auth/RegisterForm.tsx | 1 | home/LivePreviewMockup.tsx |
| 7 | home/HeroSection.tsx | 1 | home/Home.tsx |
| 7 | Features/UptimeMonitoringContent.tsx | 7 | Dashboard/MonitorDetails.tsx |
| 7 | Features/StatusPagesContent.tsx | 7 | Dashboard/Incidents.tsx |
| 7 | Features/IncidentResponseContent.tsx | 1 | Pages/TermsContent.tsx |
| 1 | Pages/StatusContent.tsx | 1 | Pages/PrivacyPolicyContent.tsx |
| 1 | Dashboard/FeedbackButton.tsx | 1 | (dashboardLayout)/layout.tsx |
| 1 | (authLayout)/layout.tsx | | |

Plus 71 emerald→`status-up` utility swaps: LivePreviewMockup 13, MonitorDetails 12, Incidents 10, PublicStatus 9, DashboardStatus 9, Dashboard 8, StatusContent 6, Footer 4. Plus 2 `status-down` utilities (Dashboard DOWN row). Plus `src/app/globals.css` token additions.

Baseline check: CONTEXT D-25 figures were 303 raw / 237 after full-file exclusions; live re-inventory (authoritative) found 283 raw hex lines / 225 migrated occurrences + 8 Google brand fills + globals/mail exclusions — same work, counted per-occurrence instead of per-line.

## Hexes With NO Clean Token Mapping (Phase 8 UI-03 flags)

Mapped via new same-value tokens rather than force-fitted to existing tokens (nearest fits would have changed dark values): `#0F172A`-as-background, `#A141FE`/`#8b2de8`, `#00E5FF`, `#8A8D91`, `#DE251F`, `#6B7280`/`#FFFFFF`/`#111827` (Swal), `#0f0f0f`/`#1e1e1e`/`#E6B800`/`#c9a227`/`#f5f5f5` (UnderConstruction).

Class-level leftovers (deliberate, D-25 scope — Phase 8 UI-03):

- `rose-*` DOWN/degradation branches (all monitor DOWN chips/dots/banners use rose, not red-500) — rose-400 ≠ `--status-down`; migrating would change dark values. Mixed ternaries now pair `status-up` with `rose-*`.
- `amber-*` paused/PENDING, `slate-*` chrome — untouched per D-25.
- `emerald-500/80` resolved-timestamps (Incidents.tsx:240, MonitorDetails.tsx:296) — emerald-500 ≠ status-up dark value.
- Non-UP/DOWN emerald/red: success buttons (error.tsx, global-error.tsx, VerifyEmail*), "Copied!" feedback (DashboardStatus.tsx:123), Telegram connected-state chip, ProfileComponent 2FA/security success greens, SecuritySlaContent SLA cards, api-reference code accents, HowItWorks/LivePreviewMockup decorative icons/dots, FeedbackButton brand accent.
- `hover:bg-red-400/500/600`-style hover states on primary buttons — Tailwind classes (not hex), interaction states outside D-25.
- `rgba(...)` literals (shadows/glows incl. the DOWN-row inset shadow) — not hex; outside the gate.

## Verification

- Hex gate: 0 files outside exclusions (output above).
- `pnpm typecheck`: green.
- `pnpm verify` (docker stack → lint → typecheck → 102 vitest → build → e2e): fully green; 18/18 e2e incl. all five Theme: assertions (default dark `html.dark`, toggle presence, cycle order, light persistence, zero hydration warnings) and the seeded-dashboard smoke render.
- Token identity: all 13 same-value tokens byte-identical between `:root` and `.dark` (each appears exactly twice, `sort | uniq -c` = 2).
- No tracked-file deletions in the commit; every new token has ≥1 consumer outside globals.css.
- Human visual no-change check (dark dashboard with UP+DOWN monitors, status page, modal vs 02-07; light unchanged) — deferred to the end-of-phase review per human_verify_mode.

## Deviations from Plan

**1. [Rule 2 - missing functionality] 11 additional same-value tokens beyond the UI-SPEC's named pair**
- **Found during:** Task 1 — the zero-hex gate plus the dark-value-preservation rule leave no valid representation for 11 orphan hex values (Swal dialog trio, sidebar meta/badge/cyan, logout red, UnderConstruction palette).
- **Fix:** added them as role-named same-value-both-modes tokens per the plan's "everything else: a same-value token" rule; must_haves' "two tokens" refers to the UI-SPEC-required pair, which is included.
- **Files:** src/app/globals.css.
- **Commit:** bebd879

**2. [Rule 3 - blocking] DeleteModal dead-code comment `#8b2de8` hover variant**
- **Issue:** comments must not retain raw hex, but the darker-purple hover has no token and the whole file is commented-out dead code.
- **Fix:** expressed as `hover:bg-highlight-purple/80` inside the comment (dead code, zero rendering effect); flagged for Phase 8.
- **Commit:** bebd879

None otherwise — mapping table, exclusions, and gates executed as written.

## Notes

- `global-error.tsx` now uses `bg-background`: on a client-side error the `.dark` class set by the next-themes pre-paint script persists, so dark is unchanged; only a hypothetical SSR-time root error before any script execution would render the light surface (accepted; same class of edge as the 02-07 body change).
- TeamSwitch Swal config reads tokens via `var()` — sweetalert2 applies inline styles, and CSS custom properties resolve on the Swal container at computed time, so dark rendering is unchanged while the values remain token-sourced.

## Self-Check: PASSED

- Commit bebd879 exists (`git log` verified) — 38 files, 0 deletions.
- src/ working tree clean post-commit.
- Hex gate re-run after all state updates: still 0 files outside exclusions.
- All 13 tokens consumed outside globals.css (9/2/1/2/1/1/1/1/1/1/1/1/1 files respectively).
