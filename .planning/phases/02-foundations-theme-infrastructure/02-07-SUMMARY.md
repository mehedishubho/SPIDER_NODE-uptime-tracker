---
phase: 02-foundations-theme-infrastructure
plan: 07
subsystem: theme-infrastructure
tags: [next-themes, theming, light-mode, globals-css, sonner, e2e]
requires:
  - "02-02 (smoke E2E scaffold + seed helpers)"
  - "02-06 (green typecheck gate)"
provides:
  - "ThemeProvider/ThemeToggle/ThemedToaster components (src/components/theme/)"
  - "split :root(light)/.dark(frozen) palettes + --status-up/--status-down tokens + text-status-up/bg-status-down utilities"
  - "five Theme: e2e assertions (default dark, toggle, cycle, persistence, hydration guard)"
  - "next-themes@^0.4.6 dependency"
affects:
  - "src/app/layout.tsx (provider nesting, body classes, ThemedToaster)"
  - "src/components/dashboardLayout/AppHeader.tsx (toggle placement)"
  - "src/app/(authLayout)/layout.tsx (toggle placement)"
  - "02-08 hex migration (status utilities now exist; authLayout bg still hardcoded)"
tech-stack:
  added:
    - "next-themes ^0.4.6 (the only new UI dependency)"
  patterns:
    - "useSyncExternalStore isHydrated guard (repo lint forbids setState-in-effect)"
    - ".dark-prefixed plain-CSS overrides for mode-aware custom utilities"
key-files:
  created:
    - src/components/theme/ThemeProvider.tsx
    - src/components/theme/ThemeToggle.tsx
    - src/components/theme/ThemedToaster.tsx
  modified:
    - src/app/globals.css
    - src/app/layout.tsx
    - src/components/dashboardLayout/AppHeader.tsx
    - "src/app/(authLayout)/layout.tsx"
    - tests/e2e/smoke.spec.ts
    - package.json
    - pnpm-lock.yaml
decisions:
  - "hugeicons-react@0.4.0 predates the UI-SPEC's icon names — Sun03Icon/ComputerIcon are the 0.4.x export names for the sunlight/monitor glyphs (Moon02Icon exists as named)"
  - "mounted guard expressed as useSyncExternalStore(no-op subscribe, ()=>true, ()=>false) — repo react-hooks lint forbids synchronous setState in effects"
  - "byte-identity gate run as a subset check (comm -23 old:new empty = no pre-change token changed/removed); the literal diff shows exactly the two sanctioned status-token additions"
metrics:
  duration: ~16min (928s)
  completed: 2026-09-10
  tasks: 3
status: complete
---

# Phase 02 Plan 07: Light/Dark/System Theming Slice Summary

**One-liner:** next-themes class-strategy theming (default dark, D-24) with a cycle toggle on both surfaces, theme-following toasts, and a palette split that gives a real light zinc `:root` while `.dark` stays byte-identical to today.

## What Was Built

THM-01/THM-02 delivered as the phase's user-facing vertical slice. A user can now cycle Light → Dark → System from one header button on the dashboard AND the pre-login auth pages; the choice persists across reloads; toasts follow the resolved theme; with no stored preference every user still sees today's dark app pixel-for-pixel (defaultTheme="dark" — the compatibility constraint holds by default, not after toggling).

- `src/components/theme/ThemeProvider.tsx` — next-themes wrapper: `attribute="class"`, `defaultTheme="dark"`, `enableSystem`, `disableTransitionOnChange`; outermost provider in layout.tsx (outside Suspense/AuthProvider).
- `src/components/theme/ThemeToggle.tsx` — native `<button type="button">` cycling light→dark→system; icon/tooltip/aria-label reflect the SELECTED theme; six UI-SPEC copy strings (`Theme: Light|Dark|System`, `Switch theme (current: Light|Dark|System)`); shadcn Tooltip with per-instance `TooltipProvider` (the auth surface has no global provider — same composition as sidebar.tsx); size-9 target, 18px icon, `text-muted-foreground hover:text-foreground`, focus ring from `--ring`; mounted guard renders a layout-stable `size-9` placeholder.
- `src/components/theme/ThemedToaster.tsx` — `useTheme().resolvedTheme` → sonner `<Toaster richColors position="top-right" theme={resolvedTheme === "light" ? "light" : "dark"} />`; every prop except theme frozen. The undefined-during-hydration ternary renders "dark" on both sides of hydration — no mismatch.
- `src/app/layout.tsx` — `<html suppressHydrationWarning>` (hardcoded `className="dark"` deleted), body `bg-background text-foreground`, ThemeProvider outermost, ThemedToaster replaces the server-rendered Toaster.
- Placements: AppHeader right cluster left of NavUser (existing `gap-3`); `(authLayout)/layout.tsx` absolute `top-6 right-6` (container made `relative`).
- `src/app/globals.css` — `:root` is now the light neutral zinc mirror (UI-SPEC token table verbatim: `#fafafa` bg, `#ffffff` cards, `#e4e4e7` borders, `#18181b` foregrounds, destructive `#dc2626`, brand `#ef4444` unchanged); `.dark` holds today's values byte-identically; new `--status-up` (`#16a34a`/`#34d399`) and `--status-down` (`#dc2626`/`#ef4444`) in both blocks; `@theme inline` EXTENDED with `--color-status-up`/`--color-status-down`; `.glass-panel` light base + `.dark` override; `.red-gradient-text` light start `#18181b`; `.red-glow` unchanged; `@custom-variant dark` untouched.
- `tests/e2e/smoke.spec.ts` — five new `Theme:` tests + shared `loginViaUi` helper; `colorScheme: "light"` pinned so "system" resolves deterministically; console/pageerror listener fails on hydration-mismatch patterns.
- `package.json` — exactly one dependency added: `next-themes ^0.4.6` (registry safety verified in research; pinned install resolved 0.4.6).

## The RED → GREEN Arc

**RED (commit 49bef7d)** — tests written first, no implementation. Capture `/tmp/pw-red.txt`:

```
1) [e2e] › tests\e2e\smoke.spec.ts:75:5 › Theme: toggle button exists in the dashboard header
2) [e2e] › tests\e2e\smoke.spec.ts:85:5 › Theme: clicking cycles Dark → System → Light and rewrites the html class
3) [e2e] › tests\e2e\smoke.spec.ts:132:5 › Theme: selected light theme persists across reload
4) [e2e] › tests\e2e\smoke.spec.ts:160:5 › Theme: zero hydration warnings during load and toggle cycling
4 failed / 14 passed (4.3m)
```

Failure signature: `getByRole('button', { name: 'Switch theme (current: Dark)' })` → `element(s) not found` — the missing toggle, exactly the implementation target. The `Theme: default theme is dark` test passed in RED (today's hardcoded `className="dark"` satisfies it) and continues to pass in GREEN via next-themes — it pins the D-24 invariant against regression either way.

**GREEN (commit 9c0dd2c)** — wiring landed; `pnpm typecheck && pnpm build && pnpm test:e2e` → 18/18 passed (6 e2e incl. all five Theme: tests + 12 api specs).

**Palette split (commit f1443f1)** — default-dark path re-verified: 18/18 e2e again; `pnpm test` 102/102 vitest; `pnpm lint` 0 errors (37 pre-existing warnings in untouched files).

## Dark Byte-Identity Gate (T-02-14)

Reference: pre-change `:root` extracted via `git show HEAD:src/app/globals.css` (27 tokens).

- Literal diff old-`:root` vs new-`.dark`: shows ONLY the two sanctioned additions — `> --status-down: #ef4444`, `> --status-up: #34d399`. Every one of the 27 pre-change tokens appears with the identical value and formatting.
- Subset gate `comm -23 old new` → **empty**: no pre-change token changed, removed, or reformatted.
- New `.dark` also carries `--radius: 0.75rem` (the old `.dark` inherited it from `:root`; the UI-SPEC table lists it in both blocks — same computed value either way).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] UI-SPEC icon names don't exist in the installed hugeicons-react**
- **Found during:** Task 2 (component creation)
- **Issue:** `SunLightIcon` and `Monitor01Icon` are not exported by the installed `hugeicons-react@0.4.0` (verified against the package `.d.ts` — no `SunLight*` or `Monitor*` exports at all; those are newer-library names). Typecheck/build would fail on the plan-verbatim imports.
- **Fix:** Used the 0.4.x export names for the same glyphs: `Sun03Icon` (the sunlight/sun glyph), `Moon02Icon` (exists as named), `ComputerIcon` (the monitor glyph). Still hugeicons-react `*Icon` named exports per repo convention; still zero new UI dependencies.
- **Files modified:** src/components/theme/ThemeToggle.tsx
- **Commit:** 9c0dd2c

**2. [Rule 1 - Bug] setState-in-effect lint error in the mounted guard**
- **Found during:** Task 3 verification (broader gate sweep)
- **Issue:** The next-themes README pattern `useEffect(() => setMounted(true), [])` trips the repo's react-hooks lint (`Error: Calling setState synchronously within an effect can trigger cascading renders`) — `pnpm lint` is part of the 02-06 green gate chain.
- **Fix:** `useMounted()` = `useSyncExternalStore(emptySubscribe, () => true, () => false)` — identical isHydrated semantics (false through SSR + hydration render, true after) with no effect state write. Lint back to 0 errors; all theme e2e still green (the placeholder/visibility behavior is covered by the toggle tests).
- **Files modified:** src/components/theme/ThemeToggle.tsx
- **Commit:** 797737d

**3. [Gate form] Byte-identity diff exits 1 on the sanctioned additions**
- The plan's literal verify command `diff old-:root new-.dark` necessarily reports the two status-token additions the same plan prescribes. Ran it (output above — additions only), plus the equivalent subset gate (`comm -23`, empty) which is the faithful statement of "every .dark token equals the pre-change :root value". Both recorded.

## Surfaces that flashed or mismatched

None observed. No FOUC (ThemeProvider outermost + pre-paint class write), zero hydration warnings in the dedicated console-guard test through a full toggle cycle, and the layout-stable placeholder eliminates icon-shift on mount. The only intentional dark-mode computed-style delta: body text color moves from `text-slate-100` (#f1f5f9) to `text-foreground` (#f8fafc) — the exact replacement the plan/UI-SPEC prescribe.

## Notes for the 02-08 Hex Migration

- **Utilities reading vars without the dark class (Pitfall 9):** none found — every existing custom-utility consumer sits inside `body`, which is a `.dark *` descendant (and body itself now uses `bg-background text-foreground`). The `html` ELEMENT is the only node `&:is(.dark *)` never matches; nothing styles it directly today, so no escape hatch exists.
- **Status utilities now available:** `text-status-up` / `bg-status-up` / `text-status-down` / `bg-status-down` (dark values byte-equal to today's status classes: `#34d399` = emerald-400, `#ef4444` = red-500 — the emerald/red status-class migration in 02-08 is value-neutral in dark).
- **authLayout container still hardcodes** `bg-[#121212] text-slate-100` (out of this plan's files scope; unchanged so the plan diff stays minimal). 02-08's recurring-mappings table covers it exactly: `#121212`-as-background → `bg-background`, `text-slate-100` → `text-foreground`.
- **`.glass-panel-hover:hover` background** `rgba(39,39,42,0.85)` runs in BOTH modes — the UI-SPEC utility table curates only its border/glow tints for light; flag as a Phase 8 light-polish candidate (dark zinc hover fill on a white panel).
- **Header chrome stays slate-*** (`bg-slate-950/80`, `border-slate-800` in AppHeader; NavUser dropdown colors) — inside the D-25 "left as-is this phase" exclusion list; Phase 8 UI-03 reviews.
- **`--radius` now declared in both blocks** (was `:root`-only) — no computed change; note for the 02-08 grep inventory so the globals.css token-definition exclusion count (+2 status tokens) stays accurate.

## Verification Evidence

- RED record: 4 failed / 14 passed (`/tmp/pw-red.txt`, reproduced above)
- GREEN + palette: `pnpm lint` (0 errors) → `pnpm typecheck` (clean) → `pnpm test` (102/102) → `pnpm build` (with `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3100` injected per env-less checkout precedent) → `pnpm test:e2e` (18/18)
- Byte-identity: subset gate empty; literal diff = 2 sanctioned additions only
- Threat mitigations: T-02-14 (byte-identity gates), T-02-15 (body via bg-background/text-foreground), T-02-16 (next-themes pinned ^0.4.6, only new UI dep)
- Pending (end-of-phase human check per human_verify_mode): visual spot-check of both palettes + toast theming on dashboard and auth pages — the automated layer above covers the mechanical invariants

## Self-Check: PASSED

- Files exist: ThemeProvider.tsx, ThemeToggle.tsx, ThemedToaster.tsx, globals.css (split), layout.tsx (wired), AppHeader.tsx + (authLayout)/layout.tsx (placements), smoke.spec.ts (5 Theme: tests)
- Commits found: 49bef7d (RED), 9c0dd2c (GREEN), 797737d (lint fix), f1443f1 (palette split)
