---
phase: 02-foundations-theme-infrastructure
plan: 10
subsystem: theme-infrastructure
tags: [theming, gap-closure, thm-03, cr-01, cr-02, dark-byte-identity, hex-gate, emerald-500, global-error]
requires:
  - "02-08 (the swap commit bebd879 being reverted; the standing hex gate being amended)"
  - "02-VERIFICATION.md gaps block (the authoritative gap input: CR-01/CR-02)"
provides:
  - "CR-01 closed: UP-status opacity utilities compute from emerald-500 (#10b981) again, byte-identical to bebd879~ (33 instances across 8 files)"
  - "CR-02 closed: global-error.tsx body restores the frozen bg-[#121212] literal (always-dark fatal-error surface, byte-identical to 53b0ce8)"
  - "Amended standing hex gate: filename-fragment exclusions (separator-agnostic for Windows rg) + global-error.tsx documented frozen literal"
affects:
  - "THM-03 re-verification (02-VERIFICATION.md criterion 3 — now expected to pass)"
  - "Phase 8 UI-03 (single-green convergence, if ever wanted, is an explicit redesign decision — NOT this closure)"
key-files:
  created: []
  modified:
    - src/components/Dashboard/Dashboard.tsx
    - src/components/Dashboard/DashboardStatus.tsx
    - src/components/Dashboard/Incidents.tsx
    - src/components/Dashboard/MonitorDetails.tsx
    - src/components/Status/PublicStatus.tsx
    - src/components/Pages/StatusContent.tsx
    - src/components/common/Footer/Footer.tsx
    - src/components/home/LivePreviewMockup.tsx
    - src/app/global-error.tsx
key-decisions:
  - "Closure direction REVERT (per plan, not reopened): the 33 opacity-suffixed swaps were palette classes, not orphan hexes — reverting costs nothing; single-green convergence would need explicit human ratification (Phase 8 decision)"
  - "Hex gate exclusion extended by exactly ONE name (global-error) with frozen-literal rationale; command form switched to filename-fragment exclusions because rg on this Windows checkout emits backslash-separated paths (src/app\\global-error.tsx), silently defeating the 02-08 full-path exclusion patterns (-e \"src/lib/mail.ts\")"
patterns-established:
  - "Hex gate (amended, separator-agnostic — supersedes the 02-08 form on this checkout): rg -l \"#[0-9a-fA-F]{3,8}\" src/ | grep -v -e \"globals.css\" -e \"mail.ts\" -e \"LoginForm\" -e \"RegisterForm\" -e \"global-error\" | wc -l → 0"
requirements-completed: [THM-03]
coverage:
  - id: D1
    description: "33 CR-01 opacity-suffixed UP-status utility swaps reverted to emerald-500 originals across 8 component files, byte-identical to the bebd879~ multiset"
    requirement: THM-03
    verification:
      - kind: other
        ref: "per-file multiset diff gate: diff <(git show bebd879~:$f | grep -oE \"(bg|border)-emerald-500/(5|10|20|30)\" | sort) <(grep -oE ... $f | sort) for all 8 files → empty; zero (bg|border)-status-up/[0-9]+ remain; 9 unsuffixed bg-status-up + 29 text-status-up unchanged"
        status: pass
      - kind: e2e
        ref: "pnpm verify → 102 vitest + 18 playwright green (default-dark html.dark assertions included)"
        status: pass
    human_judgment: false
  - id: D2
    description: "CR-02 frozen bg-[#121212] literal restored in global-error.tsx line 14 (byte-identical to 53b0ce8); fatal-error surface always-dark again"
    requirement: THM-03
    verification:
      - kind: other
        ref: "grep -c bg-background src/app/global-error.tsx = 0; grep -cF bg-[#121212] = 1; diff of line 14 vs git show 53b0ce8:...:14 empty → CR02_RESTORED"
        status: pass
      - kind: other
        ref: "HEX_GATE_PASS with the extended 5-name exclusion list (rg file list verified to contain ONLY the five excluded names)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Visual identity of the reverted surfaces in a running browser (perceptual, not computed-value)"
    requirement: THM-03
    verification: []
    human_judgment: true
    rationale: "Computed color values are machine-verified (D1/D2 gates); perceptual identity of UP-status tints and the fatal-error page requires the running app — carried by the 02-VERIFICATION human items, which now check for UNCHANGED pre-phase appearance"
duration: 21min
completed: 2026-09-11
status: complete
---

# Phase 02 Plan 10: THM-03 Gap Closure (CR-01/CR-02 Reverts) Summary

**Byte-identical revert of the two 02-08 over-reaches: 33 opacity-suffixed UP-status utilities back to emerald-500 originals (8 files) + the frozen bg-[#121212] literal restored on the always-dark fatal-error surface — both theme gates and the full pnpm verify chain green.**

## Performance

- **Duration:** ~21 min (17:31–17:52 UTC)
- **Started:** 2026-09-11T17:31:25Z
- **Completed:** 2026-09-11T17:52:00Z
- **Tasks:** 3 (2 code tasks + 1 verification task)
- **Files modified:** 9 (8 component reverts + 1 literal restore)

## Task 1 — CR-01 revert: 33 utility swaps → emerald-500 originals

Baseline before any edit (Step 0, matched the pinned planning state exactly): 9 unsuffixed `bg-status-up`, 29 `text-status-up`, and the five swap-product forms at 13/11/3/3/3 = 33 instances on 19 lines across the 8 files.

Replacement map applied (each form exists in the tree ONLY as a bebd879 swap product):

| Swap product | Restored original | Instances |
|---|---|---|
| `bg-status-up/10` | `bg-emerald-500/10` | 13 |
| `border-status-up/30` | `border-emerald-500/30` | 11 |
| `bg-status-up/20` | `bg-emerald-500/20` | 3 |
| `border-status-up/20` | `border-emerald-500/20` | 3 |
| `bg-status-up/5` | `bg-emerald-500/5` | 3 |
| **Total** | | **33** |

Per-file restored instance counts (grep -oE instance counts, equal to the bebd879~ multiset for every file):

| File | Instances | File | Instances |
|---|---|---|---|
| Dashboard.tsx | 2 | StatusContent.tsx | 3 |
| DashboardStatus.tsx | 5 | Footer.tsx | 2 |
| Incidents.tsx | 5 | LivePreviewMockup.tsx | 6 |
| MonitorDetails.tsx | 5 | PublicStatus.tsx | 5 |

**Task 1 gate (run verbatim from the plan):** per-file `diff <(git show bebd879~:$f | grep -oE "(bg|border)-emerald-500/(5|10|20|30)" | sort) <(grep -oE "(bg|border)-emerald-500/(5|10|20|30)" "$f" | sort)` → empty for all 8 files; `grep -roE '(bg|border)-status-up/[0-9]+' src | wc -l` = 0; unsuffixed `bg-status-up` = 9; `text-status-up` = 29 → **CR01_REVERT_VERIFIED**.

## Task 2 — CR-02 restore: global-error.tsx frozen literal

```diff
-      <body className="bg-background">
+      <body className="bg-[#121212]">
```

**Task 2 gate (run verbatim):** `grep -c bg-background src/app/global-error.tsx` = 0; `grep -cF "bg-[#121212]"` = 1; line-14 diff vs `git show 53b0ce8:src/app/global-error.tsx | sed -n "14p"` empty → **CR02_RESTORED**. Line 16's `bg-foreground-invert` (correct same-value token for the old `#0F172A` inner card) unchanged. 1-line diff total.

## Task 3 — Both theme gates + full pnpm verify

**Gate 1 — .dark byte-identity** (comm -23 subset check vs the pre-phase 53b0ce8 `:root`, the form STATE records for 02-07):

```
comm -23 <(git show 53b0ce8:src/app/globals.css | sed -n "/^:root/,/^}/p" | grep -oE "^  --[a-z-]+: [^;]+" | sort) \
         <(sed -n "/^\.dark/,/^}/p" src/app/globals.css | grep -oE "^  --[a-z-]+: [^;]+" | sort) | wc -l
→ 0     # DARK_BYTE_IDENTICAL — every original token value survives unchanged in .dark
```

**Gate 2 — hex gate, extended exclusion list.** The raw `rg -l "#[0-9a-fA-F]{3,8}" src/` list was inspected BEFORE gating and contains EXACTLY the five excluded names — no other file, so nothing was hidden by the exclusion (T-02-19):

```
src/lib\mail.ts
src/components\Auth\RegisterForm.tsx
src/components\Auth\LoginForm.tsx
src/app\globals.css
src/app\global-error.tsx
```

```
rg -l "#[0-9a-fA-F]{3,8}" src/ | grep -v -e "globals.css" -e "mail.ts" -e "LoginForm" -e "RegisterForm" -e "global-error" | wc -l
→ 0     # HEX_GATE_PASS
```

**Amended standing hex gate (supersedes the 02-08 form for all future runs on this checkout).** Exclusions are now FILENAME FRAGMENTS, never full paths: rg on this Windows machine emits backslash-separated paths (e.g. `src/app\global-error.tsx`), so the 02-08 full-path patterns (`-e "src/lib/mail.ts"`) silently fail to exclude and produce a false red. Extended exclusion list (five names) with rationale:

| Exclusion | Rationale |
|---|---|
| globals.css | token definitions live here |
| mail.ts | email HTML — email clients cannot use CSS vars |
| LoginForm / RegisterForm | Google brand-mark hexes stay |
| global-error.tsx | **frozen literal outside the theme system — .dark never applies on this surface** |

The global-error.tsx entry documents a DELIBERATE frozen literal (the CR-02 restore), not a missed migration; the closure direction (revert, not single-green convergence) does not change.

**Gate 3 — full DEP-04 chain** (with `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007` exported first — src/redux/api/baseApi.ts throws at module load without it on this env-less checkout):

```
export NEXT_PUBLIC_DEV_BASE_URL="http://localhost:3007" && pnpm verify
→ PNPM_VERIFY_EXIT=0
   docker compose up -d --wait : spidernode-test-db + redis healthy
   pnpm lint        : 0 errors (37 pre-existing warnings) — pass
   pnpm typecheck   : pass
   pnpm test        : Test Files 9 passed (9), Tests 102 passed (102)
   pnpm build       : pass (full route table emitted)
   pnpm test:e2e    : 18 passed — incl. all five Theme: tests (default dark html.dark,
                      toggle presence, Dark→System→Light cycle, light persistence,
                      zero hydration warnings) + seeded-dashboard smoke
```

The characterization suite and theme e2e confirm the reverts changed nothing observable (D-20 budget met; warm chain comfortably inside 5 min).

## Untouched-by-construction (explicit confirmation)

- **globals.css received zero edits** from this entire plan (`git diff 51df260..HEAD -- src/app/globals.css` empty; DARK_BYTE_IDENTICAL corroborates).
- **text-status-up adoptions untouched**: exactly 29 instances under src/, before and after (descend from emerald-400 = #34d399 = `--status-up` dark — byte-identical, correct per CR-01 analysis).
- **Unsuffixed bg-status-up untouched**: exactly 9 instances, before and after (descends from bg-emerald-400 — byte-identical, correct).
- **shadow-emerald-500/5 still present at StatusContent.tsx:29** (correctly never swapped in 02-08; the revert matches its treatment).
- Correctly-left-alone emerald-500 utilities intact: LivePreviewMockup.tsx:14 `bg-emerald-500/80`, MonitorDetails.tsx:296 + Incidents.tsx:240 `text-emerald-500/80`, and all instances in the files outside the 8 (TelegramSettings, ProfileComponent, SecuritySlaContent, api-reference, Auth, error.tsx, FeedbackButton, HowItWorks, UptimeMonitoringContent).
- **rose-\* DOWN branches untouched** (D-25: rose stays rose), including the branches sharing lines with reverts (DashboardStatus.tsx:133/139, PublicStatus.tsx:105/111, MonitorDetails.tsx:279, Incidents ternaries).
- Only className string literals changed — no logic, layout, spacing, typography, or copy edits (UI-SPEC freeze; full diff reviewed line-by-line).

## Task Commits

1. **Task 1: revert 33 CR-01 utility swaps (8 files)** — `e4999bf` (fix)
2. **Task 2: restore CR-02 frozen literal (global-error.tsx)** — `6a93cb4` (fix)
3. **Task 3: gates + full verify** — verification-only task, evidence recorded here (no code changes)

**Plan metadata:** docs commit (this SUMMARY + tracking updates).

## Decisions Made

- Revert (not override) chosen per the plan's locked closure direction; no accepted-deviation override recorded and none needed — the pre-phase state is restored byte-identically.
- Hex gate exclusion widened by exactly one pinned name (global-error) with the frozen-literal rationale recorded verbatim; the command form switched to filename-fragment exclusions for Windows path-separator correctness. The rg list was verified to contain ONLY the five excluded names before gating — the exclusion hides nothing (T-02-19 mitigated).

## Deviations from Plan

None — plan executed exactly as written. All three gate outputs matched the plan's predictions (CR01_REVERT_VERIFIED, CR02_RESTORED, DARK_BYTE_IDENTICAL + HEX_GATE_PASS + PNPM_VERIFY_EXIT=0); no count drift, no reconcile branch taken.

## Issues Encountered

- Docker Desktop daemon was down at Task 3 start ("failed to connect to the docker API"). Started Docker Desktop and polled until the daemon answered (~10 s), then the verify chain's own `docker compose up -d --wait` brought up spidernode-test-db + redis healthy. Documented precondition on this checkout, not a defect.
- First `pnpm verify` run was piped through `tail`, masking the exit code (output showed 18/18 e2e, implying success); re-ran the full chain with explicit exit-code capture for a clean gate artifact → `PNPM_VERIFY_EXIT=0`. No code or flake issue.
- Pre-existing lint warnings (37, incl. `'error' is defined but never used` in global-error.tsx — the destructured-but-unused prop existed before this plan) — out of scope, unchanged.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- THM-03's failed truth (criterion 3 "dark visually identical") is now closable: both computed-value regressions are reverted byte-identically, and every gate in this SUMMARY is re-runnable verbatim for the phase re-verifier.
- Phase 2 can transition from `gaps_found` to `verified` on re-run of `/gsd-verify`. The 02-VERIFICATION human visual items (UP-status tints, fatal-error page) now check for UNCHANGED pre-phase appearance instead of the regression.
- Remaining open items for the re-verifier are unchanged from 02-VERIFICATION.md: the behavior_unverified runtime items (pre-paint/hydration, toast theming) and the human items (.env.example content, 02-07/02-08 deferred visual spot-checks, WR-02 light-mode scope decision).

## Self-Check: PASSED

- Commits e4999bf (Task 1) and 6a93cb4 (Task 2) exist on main (`git log` verified); no tracked-file deletions in either.
- All 9 modified files + this SUMMARY exist on disk.
- Post-write gate re-check: frozen literal in place in global-error.tsx; zero `(bg|border)-status-up/[0-9]+` instances under src/.

---
*Phase: 02-foundations-theme-infrastructure*
*Completed: 2026-09-11*
