---
phase: 01-design-gate-review-verdict-ready
plan: 07
subsystem: design-docs
tags: [deploy-runbook, gap-closure, fix-cycle, phase-conditional-migrate, pm2-wait-ready, first-worker-cutover, connection-budget]
requires: [01-05]
provides: [WR-03-closed, WR-04-closed, WR-05-closed, IN-05-runbook-half-closed]
affects: [01-08]
tech-stack:
  added: []
  patterns:
    - "phase-conditional Migrate step keyed on the Phase 3 baseline PR (same switchover event as audit §24 step 3 / runbook §8): Phase 2 = no migrate command, CI prisma db push remains the interim schema authority; Phase 3+ = single pnpm drizzle-kit migrate runner"
    - "PM2 dual readiness signals with distinct consumers — process.send('ready') is the PM2 gate (wait_ready/listen_timeout), HTTP :9090/readyz is the operator/CI gate"
    - "lettered subsection insertion (§4a) to add a new path without renumbering cross-referenced sections (§5/§8/§9 cited by number elsewhere)"
key-files:
  created: []
  modified:
    - docs/DEPLOY-RUNBOOK.md
requirements: [DSGN-01]
decisions:
  - "01-07: the interim-topology Migrate step is phase-conditional keyed on the Phase 3 baseline PR (the exact switchover event of audit §24 step 3) — Phase 2 releases run no migrate command (the legacy CI `prisma db push` step is the acknowledged interim schema authority on its dated removal path), Phase 3+ runs the single `drizzle-kit migrate` runner (WR-03)"
  - "01-07: PM2 readiness is two signals with distinct consumers — the worker emits `process.send('ready')` once Redis + DB pings pass (the PM2 gate); HTTP `:9090/readyz` remains the operator/CI gate; wiring only the HTTP endpoint makes PM2 force-restart after listen_timeout — the boot crash-loop (WR-04)"
  - "01-07: the first worker release has its own §4a path — `pm2 start`/`startOrReload` (never restart on an unregistered name), M3 overlap window with continuity verification (heartbeat, queue depth ≈ 0, ping flow, alert parity, M4 counter sanity) before anything is disabled, cutover completion as a separate follow-up release deleting instrumentation.ts cron + CRON_MODE; §4's restart form applies from the second worker release onward (WR-05)"
metrics:
  duration: 213s (~4m)
  completed: 2026-09-09
status: complete
---

# Phase 1 Plan 7: Fix-Cycle Runbook Executability (WR-03/WR-04/WR-05 + IN-05 runbook half) Summary

Phase-conditional Migrate step keyed on the Phase 3 baseline, the PM2 `process.send('ready')` vs HTTP `readyz` handshake, and a new §4a first-worker-release/Phase 4 cutover path — the runbook is now followable verbatim at every phase it covers.

## What Was Done

| Task | Name | Commit | Key changes |
|------|------|--------|-------------|
| 1 | Make the Migrate step phase-conditional (WR-03) | `6e4d689` | §3 step 3 split: Phase 2 = run no migrate command (no runner exists; schema flows through the existing CI `prisma db push` step until the Phase 3 baseline PR removes it, cited to audit §24 step 3) vs Phase 3+ = single `pnpm drizzle-kit migrate` (never at boot, never two runners M-1, no-op exit 0); per-branch Verification (Phase 2 = CI schema step exited 0; Phase 3+ = journal + empty-diff M-3); §2 Migrate row annotated with the same conditional; §8 sentence naming the legacy CI step as the acknowledged interim mechanism on its dated removal path; header fix-cycle amendment note |
| 2 | PM2 wait_ready handshake (WR-04) + budget wording (IN-05) | `7560f2d` | §4: after the readyz definition, the handshake paragraph — worker emits the PM2 ready signal (`process.send('ready')`) once Redis + DB pings pass (exactly when readyz would succeed); HTTP readyz = operator/CI gate, process signal = PM2 gate; crash-loop consequence stated; §5 `wait_ready` and `listen_timeout` Why cells reference the §4 signal (an HTTP-only implementer never signals PM2); §1 steady-state rewritten: ≤ 30 connections (web 10 + worker 20), ≤ 31 only during deploys while the one-shot migration runner is connected |
| 3 | Add §4a — first worker release / Phase 4 cutover path (WR-05) | `1d28836` | NEW §4a between §4 and §5 (lettered, no renumbering): step 1 first registration via `pm2 start`/`startOrReload` (never `pm2 restart` on an unregistered name — it errors), PM2 ready signal per §4/§5, rollback = `pm2 delete` + web-only monitoring (old cron still live); step 2 M3 overlap window — old `instrumentation.ts` cron keeps running, both paths idempotent, continuity verification (heartbeat steady, queue depth ≈ 0 after initial drain, pings flowing for sampled monitors, Telegram alert parity, M4 counter-delta sanity), rollback = disable nothing; step 3 cutover completion as a separate follow-up release deleting `instrumentation.ts` cron + `CRON_MODE`, rollback = restore previous tarball pair (web-cron returns); §4 step 4 scope pointer added |

## Coverage (plan must_haves → where closed)

- **WR-03 (interim Migrate executability)** — §3 step 3 gives a Phase 2 operator an executable instruction (explicit "run no migrate command" + the named CI schema mechanism), never a drizzle command before Phase 3; the Phase 3+ branch retains single-runner / never-at-boot / no-op-exit-0 verbatim; §2's Migrate row and §8 agree with §3 (no surface prescribes `drizzle-kit migrate` unconditionally for Phases 2–3).
- **WR-04 (PM2 wait_ready semantics)** — §4 names both readiness signals and their distinct consumers (PM2 vs operator/CI) and states the crash-loop consequence; §5 `wait_ready`/`listen_timeout` rows reference the §4 handshake; an implementer wiring only the HTTP server cannot ship the boot crash-loop unknowingly.
- **WR-05 (first-worker-cutover path)** — §4a exists between §4 and §5 with 4a numbering; §5 onward headings byte-identical in number and title (verified: `## 5. PM2`, `## 6. Smoke` … `## 9.` all unrenumbered); all four required elements present (first-registration command form, overlap-window verification, follow-up cron-deletion release, web-only rollback); §4a states its scope (first release only) and defers to §4 for later releases — reciprocally, §4 step 4 now points to §4a.
- **IN-05 (runbook half)** — §1 reads "steady-state total ≤ 30 connections (web 10 + worker 20), rising to ≤ 31 only during deploys while the single one-shot migration runner is connected", mirroring the audit §25.1 wording plan 01-08 writes (numbers unchanged, precision fixed).
- **Operator-voice contract (D-01/D-04)** — every numbered step in §3 (5), §4 (6), and §4a (3) carries the full Action / Verification / Rollback triple (11 + 3 counted by grep); no step requires reading another document mid-deploy.

## Key Links (verified)

- §3 step 3 ↔ audit §24 step 3 + §8 via the identical switchover event ("Phase 3 baseline" ×3: §3 step 3, §8 ×2 — the baseline PR that deletes `prisma db push` from CI).
- §5 wait_ready/listen_timeout rows ↔ §4 health-surfaces paragraph via "ready signal" ×4 — both name the two distinct readiness signals consistently.

## Verification Results

All per-task automated checks pass against `docs/DEPLOY-RUNBOOK.md`: Phase 2 ×7 (≥ 3), fix cycle ×1 (≥ 1), prisma db push ×4 (≥ 2); process.send/process ready signal/PM2 gate ×4 (≥ 2), ≤ 30 ×2 (≥ 1); §4a heading ×1 (≥ 1), overlap ×4 (≥ 2), pm2 start ×1 (≥ 1), §5/§6 headings ×2 (= 2, unrenumbered). Plan-level: 14 numbered steps across §3/§4/§4a each carry Action/Verification/Rollback (11 + 3 + 3 + 3); full heading set inspected — §5–§9 numbers and titles unchanged. `docs/DEPLOY-RUNBOOK.md` clean in `git status`; no file deletions in any task commit; no new untracked files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Reciprocal scope pointer added in §4 step 4**
- **Found during:** Task 3
- **Issue:** The plan required §4a to defer to §4 ("restart form applies from the second release onward") but not the reverse pointer. An operator following §4 step 4 verbatim on the first worker release would still run `pm2 restart uptime-worker` and hit the unregistered-name error §4a exists to prevent — a violation of the runbook's own D-01 mid-deploy contract (followable without reading any other section).
- **Fix:** One parenthetical appended to §4 step 4's Action: "(This restart form applies from the **second** worker release onward — the first registration of the app follows §4a, not this step.)"
- **Files modified:** docs/DEPLOY-RUNBOOK.md (§4 step 4)
- **Commit:** `1d28836`

**2. [Rule 1 - Bug] §4a step 3 disambiguated from §9's Phase 5 retirement path**
- **Found during:** Task 3
- **Issue:** The plan's action item said the follow-up release "deletes the instrumentation.ts cron path and CRON_MODE (the §9 retirement path)". Taken literally, an operator could read §9's retirement (which deletes the external cron endpoints and `CRON_SECRET` at the Phase 5 overlap-verified cutover) as happening in the same release — dropping the external-cron fallback early and contradicting §9's existing dated path.
- **Fix:** §4a step 3 deletes exactly the internal path (`instrumentation.ts` cron registration + `CRON_MODE`, per audit §24 step 4) and states explicitly: "(The external cron endpoints and `CRON_SECRET` follow their own later retirement path in §9 — they are not deleted here.)"
- **Files modified:** docs/DEPLOY-RUNBOOK.md (§4a step 3)
- **Commit:** `1d28836`

## Auth Gates

None — documentation-only plan; no authenticated systems touched.

## Known Stubs

None — the deliverable is the amended runbook itself; every amended section is complete (no TODO/placeholder markers introduced).

## Self-Check: PASSED

- Files: `docs/DEPLOY-RUNBOOK.md` (committed, clean in git status), `.planning/phases/01-design-gate-review-verdict-ready/01-07-SUMMARY.md` — both FOUND.
- Commits: `6e4d689`, `7560f2d`, `1d28836` present in `git log` — all FOUND.
