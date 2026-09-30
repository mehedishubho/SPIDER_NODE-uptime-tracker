---
phase: 08
plan: 02
subsystem: dashboard-ui
tags: [ui-02, dialog-consolidation, icon-consolidation, shadcn, radix, hugeicons, remnant-gate, dep-deletion]
requires:
  - Radix dialog substrate (@radix-ui/react-dialog + radix-ui umbrella, pre-existing)
  - hugeicons-react 0.4.0 (pre-existing)
  - shadcn registry (shadcn@4.21.0-class CLI, pnpm dlx)
  - 08-01 clean tree (commits af031c5..a569536)
provides:
  - src/components/ui/dialog.tsx + alert-dialog.tsx (Radix variants, hugeicons icons)
  - One dialog system: 3 confirm sites + Add/Edit Monitor modals on shadcn primitives
  - One icon system: zero react-icons specifiers under src/
  - PHASE8 remnant-gate block in scripts/check-cron-remnants.mjs (RED-proven, ENFORCED)
  - tests/e2e/dialogs.spec.ts (cancel-aborts/confirm-executes pins for delete/disconnect/logout)
  - Multi-spec-resilient e2e seed pool (tests/setup/seed.ts)
affects:
  - 08-03+ redesign plans (primitives now exist for shadcn adoption sweeps)
  - 08-07 AI surfaces (the Add Monitor dialog is the assistant's 08-07 mount)
  - 08-08 Release B (dep deletions ride the redesign release per D-37)
tech-stack:
  added:
    - "@radix-ui/react-alert-dialog ^1.1.15 (resolved 1.1.19; legitimacy-checked: radix-ui org repo, no postinstall)"
  patterns:
    - "controlled AlertDialog (open state + onOpenChange; destructive fetch fires ONLY from AlertDialogAction)"
    - "shadcn Dialog re-host with DialogHeader/DialogTitle/DialogDescription keeping pre-existing field markup"
    - "aliased single-line hugeicons imports (sheet.tsx precedent)"
    - "phased remnant-gate extension in the exact Phase-7 vocabulary (exact specifiers + prefix forms + banned deps + phase-marked findings)"
actuals:
  tokens: 15300
  tasks: 3
  commits: 3
key-files:
  created:
    - src/components/ui/dialog.tsx
    - src/components/ui/alert-dialog.tsx
    - tests/e2e/dialogs.spec.ts
  modified:
    - src/components/Dashboard/Dashboard.tsx
    - src/components/Dashboard/TelegramSettings.tsx
    - src/components/dashboardLayout/TeamSwitch.tsx
    - src/components/form/MyFormSelect.tsx
    - src/components/form/MyFormInput.tsx
    - src/app/(dashboardLayout)/dashboard/layout.tsx
    - package.json
    - pnpm-lock.yaml
    - scripts/check-cron-remnants.mjs
    - tests/setup/seed.ts
  deleted:
    - src/components/common/DeleteModal.tsx
key-decisions:
  - "Primitives delivered as Radix-umbrella variants (radix-ui package) — verified NOT Base-UI (two-trap check); the plan's conditional @radix-ui/react-alert-dialog package.json addition honored after the CLI skipped it"
  - "CLI-era file conventions normalized to project conventions: cn-package import rewritten to @/lib/utils, the CLI-auto-added cn dependency removed (zero new deps beyond the sanctioned Radix add)"
  - "Delete/disconnect/logout confirms are controlled dialogs whose destructive fetch fires only from the confirm action — T-08-04's broken-dialog-must-never-auto-confirm pin"
  - "PHASE8 gate born ENFORCED (no advisory period): the rg sweep proved zero specifiers before pnpm remove, so arming could not relax anything"
  - "lucide-react insurance leg (specifier + dependency) armed against the stale components.json iconLibrary (Pitfall 1)"
patterns-established:
  - "Multi-file e2e specs share tests/setup/seed.ts: pool close is idempotent and queries revive it (worker-process module cache)"
  - "e2e destructive-confirm shape: request-listener pins prove cancel fires NO request and confirm fires exactly the destructive call"
requirements-completed: [UI-02]
coverage:
  - id: dialog-alert-dialog-primitives
    description: "Radix dialog + alert-dialog primitives with hugeicons icons, zero Base-UI/lucide specifiers"
    requirement: UI-02
    verification:
      - kind: verify-command
        ref: "pnpm build (rc=0) + rg trap-check (no @base-ui-components/react|lucide-react in the two files)"
        status: pass
    human_judgment: false
  - id: delete-monitor-confirm
    description: "Dashboard delete confirm migrates from native confirm() to controlled AlertDialog with UI-SPEC copy verbatim"
    requirement: UI-02
    verification:
      - kind: e2e
        ref: "tests/e2e/dialogs.spec.ts: copy/cancel-aborts (no DELETE request)/confirm-executes (DELETE + toast + empty state)"
        status: pass
    human_judgment: false
  - id: telegram-disconnect-confirm
    description: "TelegramSettings disconnect confirm -> controlled AlertDialog, contract copy verbatim"
    requirement: UI-02
    verification:
      - kind: e2e
        ref: "tests/e2e/dialogs.spec.ts: cancel-aborts (no PATCH)/confirm-executes (PATCH + badge flip)"
        status: pass
    human_judgment: false
  - id: logout-confirm
    description: "TeamSwitch Swal.fire logout confirm -> controlled AlertDialog; sweetalert2 import removed"
    requirement: UI-02
    verification:
      - kind: e2e
        ref: "tests/e2e/dialogs.spec.ts: cancel keeps the session, confirm redirects to /login"
        status: pass
    human_judgment: false
  - id: add-edit-modals-dialog
    description: "Add/Edit Monitor hand-rolled fixed overlays -> shadcn Dialog; three-field useState model intact"
    requirement: UI-02
    verification:
      - kind: verify-command
        ref: "pnpm build rc=0 + full e2e suite 25/25 (dashboard flows unchanged); zero native-overlay markup remains"
        status: pass
    human_judgment: false
  - id: dep-deletions
    description: "react-icons + sweetalert2 removed from package.json; lockfile refreshed"
    requirement: UI-02
    verification:
      - kind: verify-command
        ref: "node dep-absence check (rc=0) + rg sweeps (zero react-icons/sweetalert2/Swal under src/)"
        status: pass
    human_judgment: false
  - id: phase8-remnant-gate
    description: "PHASE8 block in check-cron-remnants.mjs (react-icons, sweetalert2, lucide-react insurance) ENFORCED"
    requirement: UI-02
    verification:
      - kind: gate-red-check
        ref: "scratch react-icons import -> cron:remnants rc=1 (violation printed); removal -> rc=0 green"
        status: pass
    human_judgment: false
  - id: single-toaster
    description: "Dashboard-layout Toaster import deleted; root ThemedToaster is the single mount"
    requirement: UI-02
    verification:
      - kind: grep-census
        ref: "Toaster over src/app resolves to src/app/layout.tsx only"
        status: pass
    human_judgment: false
duration: 25 min
completed: 2026-09-30T20:28:52Z
status: complete
plan_head_before: a569536d162f26e3d3fbe692bf9b1b9c947ae14d
plan_head_after: 8c845877d18915814fd3b625bcb704aa7b744341
commits: 3
---

# Phase 8 Plan 02: Dialog & Icon Consolidation Summary

**One dialog system (shadcn/Radix alert-dialog + dialog), one icon system (hugeicons-react), two dependencies deleted, and the PHASE8 remnant gate RED-proven inside the verify chain.**

## Performance

- **Duration:** 25 min (single session, 3 tasks sequential)
- **Tasks:** 3/3 complete (Task 1 tracer, Tasks 2-3 auto)
- **Commits:** 3 (`06b5fdb`, `dd48a47`, `8c84587`)
- **Diff:** 14 files, +1018/−358 lines (~15.3k tokens realized vs 58k estimated — the plan over-estimated migration volume; migrations were mechanical re-hosts)

## Accomplishments

- **Primitives landed two-trap verified:** `pnpm dlx shadcn add dialog alert-dialog` delivered the Radix-umbrella variants (`import { Dialog as DialogPrimitive } from "radix-ui"`, `asChild` idiom — never `render=`). Trap 1 (lucide): the delivered `XIcon` lucide import swapped to `Cancel01Icon as XIcon` from hugeicons-react (sheet.tsx precedent); lucide-react never installed. Trap 2 (Base-UI): absent — verified by rg. The registry's `cn`-package import was normalized to `@/lib/utils` and the CLI-auto-added `cn` dependency removed.
- **All three destructive confirms migrated** to controlled `AlertDialog`s with the UI-SPEC Copywriting Contract copy verbatim: delete monitor (Dashboard), disconnect Telegram (TelegramSettings), log out (TeamSwitch, ex-sweetalert popup). Every destructive fetch fires only from the confirm action (T-08-04).
- **Add/Edit Monitor modals migrated** to shadcn `Dialog` (DialogHeader/Title/Description re-host, `sm:max-w-md`); the three-field useState state model is untouched (Pitfall 9) — the 08-07 assistant input can mount inside this dialog later.
- **Icon sweep complete:** MyFormSelect chevrons → `ArrowDown01Icon`/`ArrowUp01Icon`; MyFormInput password toggles → `ViewIcon`/`ViewOffIcon` (research-verified 0.4.0 exports). Zero react-icons specifiers under src/.
- **Dependencies deleted:** `react-icons` and `sweetalert2` removed; lockfile refreshed; dep-absence node check green.
- **PHASE8 remnant gate armed** in `scripts/check-cron-remnants.mjs` in the exact Phase-7 vocabulary: exact specifiers `react-icons`/`sweetalert2` (+ `react-icons/` prefix form), banned dependencies for both, the `lucide-react` insurance leg (Pitfall 1), `PHASE8_ENFORCED = true` from arming. RED spot-check per the 06-05 discipline: scratch probe trips the gate (rc=1, violation printed), removal restores green.
- **Single Toaster:** the unused dashboard-layout `Toaster` import deleted; root `ThemedToaster` is the only mount. Dead `DeleteModal.tsx` (102 commented lines referencing a non-existent ui/dialog) deleted.

## Task Commits

| Task | Type | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | feat | `06b5fdb` | dialog.tsx, alert-dialog.tsx, Dashboard.tsx, dialogs.spec.ts, seed.ts, package.json, pnpm-lock.yaml |
| 2 | feat | `dd48a47` | TelegramSettings.tsx, TeamSwitch.tsx, Dashboard.tsx, dashboard/layout.tsx, dialogs.spec.ts, seed.ts, DeleteModal.tsx (deleted) |
| 3 | feat | `8c84587` | MyFormSelect.tsx, MyFormInput.tsx, package.json, pnpm-lock.yaml, check-cron-remnants.mjs |

## Files Created/Modified

**Created:** `src/components/ui/dialog.tsx`, `src/components/ui/alert-dialog.tsx`, `tests/e2e/dialogs.spec.ts`
**Modified:** `src/components/Dashboard/Dashboard.tsx`, `src/components/Dashboard/TelegramSettings.tsx`, `src/components/dashboardLayout/TeamSwitch.tsx`, `src/components/form/MyFormSelect.tsx`, `src/components/form/MyFormInput.tsx`, `src/app/(dashboardLayout)/dashboard/layout.tsx`, `package.json`, `pnpm-lock.yaml`, `scripts/check-cron-remnants.mjs`, `tests/setup/seed.ts`
**Deleted:** `src/components/common/DeleteModal.tsx` (intentional — dead fully-commented file, plan-named deletion target)

## Decisions Made

1. **Radix-umbrella variants accepted as the Radix variant.** The delivered files import the `radix-ui` umbrella package (already a dependency, internally resolves `@radix-ui/react-alert-dialog` — verified by requiring the umbrella and inspecting its dep graph). The plan's "add @radix-ui/react-alert-dialog if the CLI did not" was still honored: the scoped package is now a direct dependency (legitimacy-checked per T-08-SC: radix-ui org repository, no postinstall scripts).
2. **Registry file conventions normalized to project conventions.** The CLI delivered `import { cn } from "cn"` (auto-installing a `cn` package) — rewritten to `@/lib/utils` (sheet.tsx/file-style contract) and the `cn` dependency removed. Zero net new dependencies beyond the sanctioned Radix add.
3. **PHASE8 gate born ENFORCED.** Unlike Phase-7's advisory→arm lifecycle, the 08-02 sweep proved zero specifiers *before* `pnpm remove`, so the gate armed in the same task with nothing to relax.
4. **E2E destructive-confirm proof shape.** Each confirm leg pins a request listener: cancel asserts NO destructive request was ever sent; confirm asserts the exact method+URL fired, then the visible outcome (toast/redirect/empty state).

## Deviations from Plan

**1. [Rule 3 - Blocker] e2e seed pool was single-spec-only**
- **Found during:** Task 1 (first e2e run with two spec files)
- **Issue:** `tests/setup/seed.ts` held a module-level pool; multiple spec files in one Playwright worker share module state, so the second file's `closeSeedPool()` threw "Called end on pool more than once" and the first file's after-end queries failed — the e2e project could not grow past one spec file.
- **Fix:** idempotent `closeSeedPool()` + `ensurePool()` revival on demand; all query sites route through it.
- **Files modified:** tests/setup/seed.ts
- **Verification:** full e2e suite (both projects, all spec files) 25/25 green
- **Commit:** 06b5fdb

**2. [Rule 1 - Bug] Test-selector strict-mode violations in dialogs.spec.ts**
- **Found during:** Task 1 (copy assertion) and Task 2 (telegram cancel assertion)
- **Issue:** `getByText("Delete monitor")` case-insensitively matched the "Delete Monitor" confirm button too; `getByText("Connected")` matched two spans on the profile page.
- **Fix:** title asserted via `getByRole("heading", ...)`; connected-state asserted via the connected-branch's Disconnect button instead of the ambiguous text.
- **Files modified:** tests/e2e/dialogs.spec.ts
- **Verification:** e2e suite green
- **Commit:** 06b5fdb / dd48a47

**3. [Rule 3 - Blocker] shadcn CLI aborted mid-delivery + missing dependency**
- **Found during:** Task 1
- **Issue:** First `pnpm dlx shadcn add` segfaulted (0xC0000005, transient); the retry hit an interactive overwrite prompt for `button.tsx` which aborted the run after `dialog.tsx` but before `alert-dialog.tsx`; the CLI also never installed `@radix-ui/react-alert-dialog` and auto-added a `cn` package not in the plan.
- **Fix:** re-ran `add alert-dialog` answering no to overwrite prompts (button.tsx untouched); added `@radix-ui/react-alert-dialog` manually per the plan's conditional; removed the `cn` dep.
- **Files modified:** package.json, pnpm-lock.yaml, src/components/ui/alert-dialog.tsx
- **Verification:** pnpm install clean; build green; trap-checks green
- **Commit:** 06b5fdb

**4. [Rule 3 - Blocker] `pnpm test:e2e -- <file>` does not filter on this toolchain**
- **Found during:** Task 1
- **Issue:** the plan's per-task verify command form ran the FULL suite (both projects) — the file argument was swallowed by pnpm's arg handling.
- **Fix:** per-task verification used the direct form `pnpm exec playwright test tests/e2e/dialogs.spec.ts` (proven by `--list` to select exactly 3 tests); the full suite runs anyway as the binding `pnpm verify` e2e leg and is green.
- **Files modified:** none (execution-form note only)
- **Verification:** --list shows exactly the dialogs file; full suite 25/25
- **Commit:** n/a

**Total deviations:** 4 auto-fixed (2 Rule-3 blockers, 2 Rule-1 bugs). **Impact:** none on plan scope — all four were test-infrastructure/toolchain friction surfaced and fixed without touching plan deliverables.

## Issues Encountered

- **Environmental (pre-warned):** `tests/worker/health.test.ts` IN-01 case fails with `EADDRINUSE 127.0.0.1:9090` while the live production worker holds the health port — the only verify-chain test failure (427/430 passed; the other 3 are pre-existing skips). Documented per the orchestrator note; the live worker was NOT stopped. Every other verify leg is green: lint, typecheck, schema:gate, worker:boundary, denylist:diff, build, cron:remnants (RED-proven), e2e 25/25.
- **Environmental:** three consecutive transient build crashes (0xC000001d/0xC0000005 in postcss loader and page-data worker) during the Task-1 tracer re-verify; cleared on the fourth attempt after a pause — the documented 05-07 remedy class. TypeScript compilation completed on every attempt (no code error).
- **Toolchain:** `pnpm dlx shadcn` first invocation segfaulted (0xC0000005) — one-retry remedy (see deviation 3).

## User Setup Required

None.

## Next Phase Readiness

- 08-03+ redesign plans can adopt the two new primitives (`@/components/ui/dialog`, `@/components/ui/alert-dialog`) — both Radix, hugeicons-iconed, token-driven.
- 08-07's assistant input mounts inside the migrated Add Monitor Dialog; the three-field useState contract is intact and field markup is unchanged.
- The PHASE8 gate legs ride `pnpm cron:remnants` inside `pnpm verify` — react-icons/sweetalert2/lucide-react cannot reappear silently; 08-08 Release B ships the deletions per D-37 with the gate already armed.
- `components.json` `iconLibrary: "lucide"` staleness remains (08-05 may reconcile the config value); the insurance gate covers the gap meanwhile.

## Self-Check: PASSED

- Created files exist: src/components/ui/dialog.tsx, src/components/ui/alert-dialog.tsx, tests/e2e/dialogs.spec.ts — FOUND.
- `git log --grep="(08-02)"` → 3 commits (06b5fdb, dd48a47, 8c84587).
- Acceptance criteria re-run: primitives Radix + zero Base-UI/lucide (PASS); no native confirm in the migrated files (PASS); dialogs e2e 25/25 (PASS); DeleteModal absent (PASS); Toaster census = src/app/layout.tsx only (PASS); react-icons/sweetalert2 absent from src/ and package.json (PASS); gate RED-probe detected then green (PASS).
- Plan verification re-run: build rc=0; e2e rc=0 (25 passed); absence sweeps PASS; dep node-check PASS; cron:remnants rc=0 after probe removal; full verify green on every leg except the documented environmental IN-01 case.
