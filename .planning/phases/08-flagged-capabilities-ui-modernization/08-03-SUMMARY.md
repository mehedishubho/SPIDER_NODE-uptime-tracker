---
phase: 08
plan: 03
subsystem: dashboard-ui
tags: [ui-04, client-robustness, abort-controller, timer-cleanup, hydration-safe, single-toaster, e2e-regression-net]
requires:
  - 08-02 clean tree (single Toaster after the dashboard-layout import deletion; dialog primitives) — commits 8c84587..444f72a
  - 06-01 check-now abort pattern (checkPollAbortRef + pollMonitorCheckResult signal discipline)
  - 02-07 mounted-guard precedent (useSyncExternalStore no-op subscribe)
provides:
  - Abort seams on all four polling surfaces: fetchMonitors (Dashboard), fetchDetails (MonitorDetails), fetchStatus (DashboardStatus), PublicStatus load fetch
  - Every fetch in Dashboard.tsx carries signal (mutation/check handlers included) with silent aborted rejections
  - DashboardStatus copied-reset timeout ref-held and cleared on unmount
  - Hydration-safe publicUrl derivation (02-07 mounted guard + post-mount effect-set state)
  - tests/e2e/ui-robustness.spec.ts — 6-test standing regression net, RED-proven, owned by this plan per the plan contract
affects:
  - 08-04/08-05 redesign plans (the robustness net keeps the visual work honest)
  - 08-07 AI surfaces (the abort seams and the publicUrl derivation pattern sit under the AI additions)
tech-stack:
  added: []
  patterns:
    - "Per-pass AbortController held in a ref, signal passed to fetch, aborted re-check after each await, unmount aborts the latest pass (06-01 pattern generalized)"
    - "Aborted rejections are silent: every catch checks the signal first — no toast, no console.error (the spec pins zero console errors on navigate-away)"
    - "Client-side navigate-away tests hold the poll response in flight via a page.route delay so the mid-flight abort is deterministic"
actuals:
  tokens: 6800
  tasks: 3
  commits: 3
plan_head_before: 444f72a85ae1a63dfd88a5608639dfd50e422a9f
plan_head_after: c676d907fb241f426378c2d5a97c7feb069cb487
key-files:
  created:
    - tests/e2e/ui-robustness.spec.ts
  modified:
    - src/components/Dashboard/Dashboard.tsx
    - src/components/Dashboard/MonitorDetails.tsx
    - src/components/Dashboard/DashboardStatus.tsx
    - src/components/Status/PublicStatus.tsx
key-decisions:
  - "Every fetch in Dashboard.tsx passes signal per the acceptance criterion: mutation/check handlers register per-call controllers in actionAbortRef and treat aborted rejections as silent no-ops; the poll seam (monitorsPollAbortRef) stays separate from the check-now loop (checkPollAbortRef)"
  - "The plan's 'forced check-now' e2e leg fulfills POST /api/monitors/{id}/check at the network layer with a faithful 202 — the T-02-09 no-real-check test-scope discipline (tests/api/monitors.core.spec.ts:16) wins over the plan's literal click; the real client poll machinery runs unchanged"
  - "publicUrl derives post-mount behind the 02-07 mounted guard (useSyncExternalStore no-op subscribe, emptySubscribe local form); eslint-plugin-react-hooks 7.0.1 accepts the effect-set state form (lint green)"
  - "The single-Toaster DOM census uses sonner 2.0.7's eager <section aria-label='Notifications …'> mount container — data-sonner-toaster lists only exist while toasts are active, so they resolve to 0 on an idle page"
  - "Navigate-away strength: client-side (same-document) navigation wherever the surface affords it (dashboard x2, monitor detail via Next-router-managed back); the public status surface renders no in-app links, so its leg leaves via a real document navigation with the fetch held in flight (the realistic exit path), with abort-catch silence pinned on the three authenticated surfaces plus the source sweep"
patterns-established:
  - "Robustness e2e shape: attach pageerror + console-error listeners BEFORE navigation; hold the poll response with a page.route delay; navigate client-side; settle past the hold; assert zero events"
  - "RED-probe discipline applied to a behavior spec: removing the aborted guard tripped the listeners (AbortError console noise), restoring went green — the net is proven to bite"
requirements-completed: [UI-04]
coverage:
  - id: dashboard-abort-seam
    description: "fetchMonitors and every Dashboard fetch carry signal with unmount abort and aborted re-checks"
    requirement: UI-04
    verification:
      - kind: e2e
        ref: "tests/e2e/ui-robustness.spec.ts: dashboard mid-poll + check-now-poll navigate-away cases (zero pageerror / zero console-error)"
        status: pass
      - kind: gate-red-check
        ref: "RED probe: removing the aborted guard in fetchMonitors' catch failed the spec with a recorded console error; restore went green"
        status: pass
      - kind: verify-command
        ref: "rg fetch( sweep over Dashboard.tsx — 6/6 call sites carry signal: abort.signal (manual read of printed matches)"
        status: pass
    human_judgment: false
  - id: details-status-public-abort-seams
    description: "MonitorDetails fetchDetails, DashboardStatus fetchStatus, and the PublicStatus load fetch are abort-aware; the copied-reset timer clears on unmount"
    requirement: UI-04
    verification:
      - kind: e2e
        ref: "spec: monitor-detail client-side back mid-fetch; public-status navigate-away with the load fetch held in flight — zero events"
        status: pass
      - kind: verify-command
        ref: "bare await-fetch sweep over the three files prints nothing; pnpm typecheck green"
        status: pass
    human_judgment: false
  - id: hydration-safe-publicurl
    description: "DashboardStatus publicUrl derives post-mount behind the 02-07 mounted guard; no render-time window access"
    requirement: UI-04
    verification:
      - kind: e2e
        ref: "spec: /dashboard/status loads with zero hydration-mismatch errors and the copy control populates /status/{userId} after mount"
        status: pass
      - kind: verify-command
        ref: "rg 'typeof window' src/components/Dashboard/DashboardStatus.tsx → no matches (the sole window read is inside the post-mount effect)"
        status: pass
    human_judgment: false
  - id: single-toaster
    description: "Exactly one Toaster in the app tree — assertion owned by this plan's spec per the plan (08-02 deleted the duplicate import)"
    requirement: UI-04
    verification:
      - kind: e2e
        ref: "spec: sonner Notifications-section census toHaveCount(1)"
        status: pass
      - kind: grep-census
        ref: "Toaster over src/app resolves to src/app/layout.tsx only (import + render of root ThemedToaster)"
        status: pass
    human_judgment: false
  - id: full-verify-green
    description: "Characterization/contract suites untouched-green (phase criterion 5); full gate chain over the final state"
    requirement: UI-04
    verification:
      - kind: verify-command
        ref: "pnpm verify legs: lint, typecheck, schema:gate, worker:boundary, denylist:diff, build, cron:remnants, e2e 31/31 — all green; vitest 427 passed + 2 pre-existing skips + 1 environmental IN-01 (live worker EADDRINUSE :9090, pre-warned)"
        status: pass
    human_judgment: false
duration: 26 min
completed: 2026-09-30T21:00:30Z
status: complete
---

# Phase 8 Plan 03: Client Robustness Summary

**All four polling surfaces now abort-aware on the 06-01 pattern, every touched timer clears on unmount, the dashboard-status public URL derives hydration-safely behind the 02-07 mounted guard, and a RED-proven 6-test robustness spec pins zero pageerrors / console errors on navigate-away plus the single Toaster.**

## Performance

- **Duration:** 26 min (single session, 3 tasks sequential)
- **Tasks:** 3/3 complete (Task 1 tracer with automated verify gate, Tasks 2-3 auto)
- **Commits:** 3 (`1a1cb7a`, `9115dcb`, `c676d90`) — measured `git rev-list 444f72a..c676d90` = 3
- **Diff:** 5 files, +410/−24 lines (~6.8k tokens realized vs 38k estimated — the plan over-estimated; the abort seam is a mechanical generalization of a proven in-repo pattern)

## Accomplishments

- **Dashboard abort seam (Task 1, tracer):** `fetchMonitors` now creates a controller per pass held in `monitorsPollAbortRef`, passes the signal to the fetch, re-checks `aborted` after each await before setState, and the interval effect's cleanup aborts the latest pass on unmount. The 30s cadence, endpoint, and response handling are untouched — purely the abort seam.
- **Every fetch in Dashboard.tsx carries signal:** the create/edit/toggle/delete/check handlers register per-call controllers in `actionAbortRef` (unmount-aborted alongside `checkPollAbortRef`), and every catch treats an aborted rejection as a silent no-op — no error toast, no `console.error` — which is exactly what the robustness listeners pin.
- **Remaining surfaces (Task 2):** the same discipline landed on `fetchDetails` (MonitorDetails, interval cleanup extended), `fetchStatus` (DashboardStatus), and the PublicStatus load fetch (effect cleanup aborts on unmount or id change). The leaking copied-reset `setTimeout` at DashboardStatus moved into `copiedResetTimeoutRef` — cleared on unmount, restarted on overlapping clicks.
- **Hydration-safe URL (Task 3):** the in-render window read at DashboardStatus.tsx:57-59 is gone; `publicUrl` derives post-mount behind the 02-07 mounted guard (`useSyncExternalStore` no-op-subscribe form) into state. Server HTML and the client's first render agree on the empty value (T-08-08 mitigation); the copy handler and "Loading..." fallback already tolerated the delayed value.
- **The robustness spec (standing net):** `tests/e2e/ui-robustness.spec.ts` — six tests: dashboard navigate-away mid-poll, dashboard navigate-away with the check-now poll running, monitor-detail navigate-away mid-fetch (client-side back), public-status navigate-away with the fetch held in flight, /dashboard/status hydration (zero mismatch errors + copy value populates `/status/{userId}` after mount), and the single-Toaster census. **RED-proven:** with the aborted guard temporarily removed from `fetchMonitors`' catch, the mid-poll test failed with a recorded AbortError console entry; restoring went green.
- **Full verify:** lint, typecheck, schema:gate, worker:boundary, denylist:diff, build, cron:remnants, and the full e2e suite (31/31 — 25 prior + 6 new) all green; vitest 427 passed + 2 pre-existing skips + the one pre-warned environmental failure (below).

## Task Commits

| Task | Type | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | feat | `1a1cb7a` | Dashboard.tsx, tests/e2e/ui-robustness.spec.ts (created) |
| 2 | feat | `9115dcb` | MonitorDetails.tsx, DashboardStatus.tsx, PublicStatus.tsx, ui-robustness.spec.ts |
| 3 | feat | `c676d90` | DashboardStatus.tsx, ui-robustness.spec.ts |

## Files Created/Modified

**Created:** `tests/e2e/ui-robustness.spec.ts`
**Modified:** `src/components/Dashboard/Dashboard.tsx`, `src/components/Dashboard/MonitorDetails.tsx`, `src/components/Dashboard/DashboardStatus.tsx`, `src/components/Status/PublicStatus.tsx`
**Deleted:** none

## Decisions Made

1. **Signal on every fetch, abort semantics only where they belong.** The Task-1 criterion "every fetch call inside the file passes signal" pulled the mutation/check fetches into the discipline: per-call controllers, unmount abort via `actionAbortRef`, and aborted-aware catches. The monitors poll keeps its own ref so a scheduled pass can never clobber the check-now loop's controller.
2. **T-02-09 wins over the plan's literal check-now click.** No test may let a real POST reach `/api/monitors/{id}/check` (it enqueues a real check — tests/api/monitors.core.spec.ts:16 discipline). The spec fulfills the enqueue at the network layer with a faithful 202 `{jobId, queuedAt}`; the real client machinery (enqueue handler + 2s `pollMonitorCheckResult` loop over `fetchMonitors`) runs exactly as in production with zero real enqueues.
3. **The 02-07 mounted-guard form, not an effect-only derivation.** `mounted` via `useSyncExternalStore(emptySubscribe, () => true, () => false)` guards the post-mount effect that reads `window.location.origin` into state — matching the ThemeToggle precedent byte-for-byte in spirit; the repo lint (eslint-plugin-react-hooks 7.0.1 config) accepts the form.
4. **The Toaster census counts sonner's eager mount container.** `data-sonner-toaster` lives on per-position lists that only exist while toasts are active (verified in the installed sonner 2.0.7 source) — the eager `<section aria-label="Notifications …">` is the stable once-per-mount marker.
5. **Client-side navigation wherever the surface affords it.** A full document load destroys the JS context and proves nothing; the dashboard legs leave via the sidebar link, the detail leg via Next-router-managed browser back (same document → popstate → client-side swap). The public status surface renders no in-app links (bare root layout), so its leg leaves via a real document navigation with the load fetch held in flight — the realistic exit path — while abort-catch silence for the shared pattern is pinned on the three authenticated surfaces plus the source sweep.

## Deviations from Plan

**1. [Rule 3 - Blocker] The "forced check-now" e2e leg conflicts with the T-02-09 no-real-check test-scope discipline**
- **Found during:** Task 1 (spec authoring)
- **Issue:** the plan's "navigate away immediately after a forced check-now" read literally means clicking the check-now button, which POSTs `/api/monitors/{id}/check` and enqueues a real check — an established test-scope violation (tests/api/monitors.core.spec.ts:16: "no HTTP test touches /api/monitors/{id}/check — it would enqueue a real check").
- **Fix:** the spec routes the check POST and fulfills it with a faithful 202 at the network layer; the real client poll machinery runs, zero real enqueues.
- **Files modified:** tests/e2e/ui-robustness.spec.ts
- **Verification:** the check-now-poll navigate-away test is green; no job ever reaches the test Redis from the suite
- **Commit:** 1a1cb7a

**2. [Rule 3 - Blocker] `pnpm test:e2e -- <file>` does not filter on this toolchain**
- **Found during:** Task 1 (verify runs)
- **Issue:** recurrence of 08-02 deviation 4 — the plan's per-task verify command form runs the FULL suite; the file argument is swallowed by pnpm arg handling.
- **Fix:** per-task verification used the direct form `pnpm exec playwright test tests/e2e/ui-robustness.spec.ts` (proven 6-test selection); the full suite runs anyway as the binding `pnpm verify` e2e leg (31/31).
- **Files modified:** none (execution-form note only)
- **Verification:** full e2e suite green
- **Commit:** n/a

**3. [Rule 1 - Bug] The Task-2 bare-fetch sweep command, as literally written, always fails**
- **Found during:** Task 2 (verify)
- **Issue:** `rg -n "await fetch\(" <files>` matches every awaited fetch regardless of signal (the signal sits on the following line), so the command can never produce the non-print/exit-1 condition its fails_when prose describes ("a bare await fetch( — no signal on the same call — was printed").
- **Fix:** implemented the stated intent — `rg -n "await fetch\([^,)]*\)"` (single-line calls with no second argument, where no signal is possible) prints nothing / exits 1 — plus a manual read of the full literal sweep confirming `signal: abort.signal` at all call sites.
- **Files modified:** none (verify-command form only)
- **Verification:** intent sweep rc=1 (no matches); literal sweep manually read — every call carries signal
- **Commit:** n/a

**Total deviations:** 3 auto-fixed (2 Rule-3 blockers, 1 Rule-1 verify-command bug). **Impact:** none on plan scope — test-infrastructure and command-form adaptations; all plan deliverables landed as specified.

## Issues Encountered

- **Environmental (pre-warned):** the full verify chain's `pnpm test` leg reports exactly one failure — `tests/worker/health.test.ts` IN-01 `EADDRINUSE 127.0.0.1:9090` while the live production worker holds the health port (427 passed, 2 pre-existing skips). The live worker was NOT stopped, per the orchestrator note. Every other leg was run to green individually against the final source state: lint, typecheck, schema:gate, worker:boundary, denylist:diff, build, cron:remnants, e2e 31/31.
- **None otherwise:** the transient 0xC0000005/0xC000001d build-crash class did not recur this session (all builds clean on first attempt).

## User Setup Required

None.

## Next Phase Readiness

- 08-04/08-05 (redesign) inherit a standing robustness net: any redesign regression that reintroduces post-navigation errors, hydration mismatch, or a second Toaster fails `pnpm test:e2e` loudly.
- The abort seams are additive and local to each component — the 08-07 AI surfaces can adopt the same per-call controller pattern for their streaming fetches.
- `monitorsPollAbortRef`/`actionAbortRef`/`detailsPollAbortRef`/`statusPollAbortRef`/`publicStatusAbortRef` are the exhaustive ref inventory; PublicStatus has no interval by design (single load fetch — the plan's "public-status poll" wording did not match the code; no interval was invented).
- `components.json` `iconLibrary` staleness and the WR-02 token work remain queued for 08-05 (unchanged from 08-02's handoff).

## Self-Check: PASSED

- Created files exist: tests/e2e/ui-robustness.spec.ts — FOUND; all four modified components present on disk.
- Commits exist: `git log --oneline 444f72a..c676d90` → 3 commits (1a1cb7a, 9115dcb, c676d90); measured rev-list count = 3.
- Acceptance criteria re-run: Task 1 — AbortController ref + unmount abort present, 6/6 fetch sites carry signal (sweep re-read), spec green + RED-proven (PASS). Task 2 — three surfaces signal+abort, copied timeout ref-cleared, bare-fetch sweep prints nothing, typecheck green, spec covers dashboard/detail/public (PASS). Task 3 — typeof-window sweep no matches, publicUrl derives post-mount, /dashboard/status hydration case green with populated copy value, Toaster census 1 + source census layout.tsx only, full verify green modulo the documented environmental IN-01 (PASS).
- Plan verification re-run: ui-robustness.spec 6/6 green across all four surfaces; source sweeps clean (signal everywhere, no render-time window reads, no leaked timers in touched components); pnpm verify green end-to-end except the pre-warned environmental IN-01 case.
