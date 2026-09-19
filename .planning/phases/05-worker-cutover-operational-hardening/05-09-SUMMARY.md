---
phase: 05-worker-cutover-operational-hardening
plan: 09
subsystem: infra
tags: [node-cron, deletion-release, healthchecks.io, rollback-rehearsal, db-batcher, env-transition, drizzle]

requires:
  - phase: 05-worker-cutover-operational-hardening
    provides: "05-08's 7/7 cutover gates + D-20 GREEN disposition + D-18 operator approval (8a7577d) authorizing the deletion"
provides:
  - "Deletion release d55cad5 live: src/instrumentation.ts deleted, node-cron deps removed, worker (sole monitoring path) + web running with zero cron lines"
  - "D-41 cron-remnants enforcement gate wired into pnpm verify (post-build, pre-e2e) — green over 444 files"
  - "D-46 reader-driven .env.example retirement: CRON_MODE + HC_PING_URL entries removed; CRON_SECRET annotated dormant-lever retiring Phase 6"
  - "D-21 resolved-by-absence: no old-cron hc.io check exists under any operator account (cannot false-page)"
  - "Tier-2 rollback rehearsal PASS: retained 9f667e2 tarball + pre-add-release dump proven restorable (readyz, legacy cron passes, scheduled flush, lever)"
  - "Runbook §7 amendment: tarball restore on fresh install needs 2 node_modules junction shims (mangled Turbopack externals)"
  - "Phase-5 closeout: REQUIREMENTS.md Phase-5 set Complete with evidence citations; PROJECT.md residuals per D-40; zero drizzle drift (D-44)"
affects: [06-api-hardening-email, auth-cutover-phase-7, deploy-runbook]

tech-stack:
  added: []
  removed: [node-cron, "@types/node-cron"]
  patterns:
    - "Empty-window kill: stop a batcher-backed web inside the [flush-complete, next-minute-tick) window for deterministic zero-loss drain on Windows (D-43)"
    - "cron:remnants gate as a verify leg substitutes for absent CI (D-41)"
    - "Mangled-external junction shims for restoring old .next builds whose instrumentation externals carry pnpm-hash names"

key-files:
  created:
    - scripts/check-cron-remnants.mjs (already existed from planning; wired into verify here)
    - .snapshots/0509-tier2/target.mjs (egress-neutral rehearsal fixture)
  modified:
    - package.json (verify pipeline + node-cron removal)
    - .env.example (D-46 retirements + dormant-lever annotation)
    - eslint.config.mjs (.kilo/** ignore)
    - .planning/phases/05-worker-cutover-operational-hardening/05-DEPLOY-RECORD.md (deletion-release, D-21, tier-2 entries)
    - .planning/phases/05-worker-cutover-operational-hardening/deferred-items.md
    - .planning/PROJECT.md
    - .planning/REQUIREMENTS.md
  deleted:
    - src/instrumentation.ts

key-decisions:
  - "D-43 executed via empty-window kill: the curl-lever flush was impossible on the stand-in (web never carried CRON_SECRET — HTTP 500 fail-closed), so the old web was killed at 18:45:00.111Z inside the just-flushed empty-batcher window; zero pings lost by construction"
  - "D-21 resolved-by-absence: operator's only hc.io project holds the worker trio + a never-pinged default check; the second account was deleted — nothing to pause, T-05-09-02 satisfied"
  - "Docker Desktop restart mid-plan (Rule 3): engine API wedged (new API calls hung while containers kept serving); restart recovered everything in ~15 s, spidernode-dev-db manually restarted, worker PID 9252 self-healed through the whole outage (more D-17 evidence)"
  - "Tier-2 rehearsal finding recorded as a runbook §7 amendment rather than treated as a rehearsal failure: the tarball boots perfectly after 2 junction shims; the current build is structurally immune (instrumentation deleted → mangled externals are dead code)"

patterns-established:
  - "Reader-driven env retirement (D-46): grep proves the reader set before removing any .env.example entry"
  - "Rehearsal isolation (D-32/05-06): throwaway loopback containers on dedicated ports, reseeded loopback monitor URLs, dummy tokens, forbidden sibling ports never dialed"

requirements-completed: [WRK-11, DEP-03, DEP-05]

coverage:
  - id: D1
    description: "Legacy cron scheduler deleted (src/instrumentation.ts + node-cron deps) with full pnpm verify green including the new cron:remnants leg"
    requirement: WRK-11
    verification:
      - kind: unit
        ref: "pnpm verify (lint, typecheck, test, schema:gate, worker:boundary, denylist:diff, build, cron:remnants green over 444 files, e2e 18/18)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Deletion release deployed zero-loss: flush-first empty-window kill, worker then web restart, emergency lever 200/401, smoke ping, 5.5-min worker-only continuity, hc.io trio advancing"
    requirement: WRK-11
    verification:
      - kind: manual_procedural
        ref: "05-DEPLOY-RECORD.md 05-09 deletion-release entry (18:45:00.111Z kill, lever body quoted, smoke check-manual:3:1789843711353)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Old cron hc.io check retired (D-21) — resolved by absence per operator evidence"
    requirement: WRK-11
    verification:
      - kind: manual_procedural
        ref: "05-DEPLOY-RECORD.md 05-09 Task 3 entry (operator statements + masked read-only API read)"
        status: pass
    human_judgment: true
    rationale: "Operator-owned dashboard state; their account statements are the authoritative evidence (API keys are read-only)"
  - id: D4
    description: "Tier-2 rollback rehearsal from the retained 9f667e2 tarball + pre-add-release dump: prior release boots, serves, and monitors"
    requirement: DEP-03
    verification:
      - kind: manual_procedural
        ref: "05-DEPLOY-RECORD.md 05-09 Task 4 entry (readyz green, legacy cron passes, 710→740 pings incl. 28-ping scheduled flush, lever 200/401, teardown + retention confirmed)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Environment transition executed on dated paths (D-40/D-46) and Phase-5 requirements closed with evidence"
    requirement: DEP-05
    verification:
      - kind: unit
        ref: "git diff --quiet HEAD -- drizzle/ && empty porcelain (zero drift, D-44); .env.example reader-driven retirements"
        status: pass
    human_judgment: false

metrics:
  duration: "~3h20m across two sessions (2026-09-19 17:30–18:57Z deploy session; 19:54–20:50Z post-checkpoint session)"
  completed: 2026-09-19T20:50:00Z

status: complete
---

# Phase 05 Plan 09: Deletion Release — Legacy Cron Scheduler Removed Summary

**One-liner:** Deleted `src/instrumentation.ts` + node-cron so the worker owns 100% of checks, deployed the release zero-loss via an empty-batcher-window kill, retired the old hc.io check by proving it never existed, and rehearsed the tier-2 tarball rollback — with a junction-shim finding now recorded in the runbook.

## What Was Done

### Task 1 — Deletion (d55cad5)
- `git rm src/instrumentation.ts`; `pnpm remove node-cron @types/node-cron`; `.env.example` trimmed per D-46 — CRON_MODE and HC_PING_URL entries removed (grep proved their only `src/` reader was the deleted file), CRON_SECRET kept with a dormant-emergency-lever annotation retiring Phase 6 (SEC-06).
- `cron:remnants` gate wired into `pnpm verify` after build, before e2e (D-41): green over 444 files.
- Full `pnpm verify` green (lint, typecheck, unit, schema:gate, worker:boundary, denylist:diff, build, cron:remnants, e2e 18/18); zero drizzle/schema drift (D-44).
- NEXT_RUNTIME's `.env.example` entry also removed (FND-07 reader-driven — same rule, its only reader was the deleted file).

### Task 2 — Deletion-release deploy (d5424e1 record)
- Pre-release pg_dump `.snapshots/pre-deletion-release-20260919-181530.dump`; rebuild at d55cad5.
- Flush-first (D-43) with a documented mechanism deviation: the plan's curl-lever returned HTTP 500 fail-closed (the stand-in web never carried CRON_SECRET — runbook blind spot; fresh secret minted into gitignored `.snapshots/standin-web-env.sh`). The deterministic zero-loss drain was achieved by killing the old web at 18:45:00.111Z inside the empty-batcher window (flush-completed detected and taskkill executed the same second; zero entries buffered; first 18:30 attempt missed by ~2 s — lesson captured).
- Restart worker-then-web: worker PID 9252 (sha d55cad5, schedulers ACTIVE, readyz green); web `/login` 200 with a 9-line silent boot log — zero cron lines.
- Proofs: emergency lever 200 (`No monitors are due...` with in-request flush) + 401 negative control; `smoke:enqueue` PASS (check-manual:3:1789843711353, UP 36 ms); worker-only continuity 18:45:56→18:51:26Z all uuid-form pings; hc.io trio lockstep-advancing 3117→3120 over 40 s.

### Task 3 — D-21 checkpoint → resolved-by-absence (c1203aa)
- Blocking human-verify checkpoint delivered (operator dashboard step). Operator: "I have 1 project only" (worker trio + My First Check) and "previously created account was deleted". With the masked read-only API read, conclusion: no old-cron check exists under any operator account — HC_PING_URL has no live target, cannot false-page; T-05-09-02 satisfied. Incidental: operator paused My First Check during the search (0 pings, harmless).

### Task 4 — Tier-2 rehearsal + Phase-5 closeout (c62ecf6)
- Rehearsed the rollback artifact pair: tarball `uptime-tracker-9f667e2.tar.gz` + dump `pre-add-release-20260916-101543.dump` on a throwaway stand-in (postgres:17 @5460, redis:8-alpine @6460, loopback fixture @8460, dummy tokens, forbidden sibling ports never dialed).
- Proofs: tarball worker readyz green (dark-launch posture, sha 9f667e2); web `/login` 200; legacy cron banner + per-minute scheduled passes; emergency lever 200 with both monitors checked (+401 control); pings 710→712 (lever flush) →740 (20:45:00Z scheduled batcher flush of 28 pings, per-minute UP cadence visible). Teardown clean; tarball + dump retained post-rehearsal.
- **Finding (runbook §7 amendment):** the tarball's `.next` externalizes instrumentation deps under pnpm-hash names (`node-cron-5efbb29b9a4eb14a`, `pg-4c0d8067d674414d`); fresh `pnpm install` cannot satisfy them — restore needs two junction shims. Current build immune (deletion makes the mangled import dead code).
- D-44 confirmed: last drizzle/ change 279fe14 (2026-09-13) — zero Phase-5 migrations, zero drift.
- PROJECT.md residuals per D-40 (CRON_MODE retired; CRON_SECRET Phase 6; EMAIL_PROVIDER Phase 6; BETTER_AUTH_*/NEXTAUTH_* Phase 7; Grafana/persistent Prometheus → VPS era). REQUIREMENTS.md: WRK-09/WRK-11/DEP-03/DEP-05/OBS-03/OBS-05 Complete + OBS-02 with D-42 window-evidence citation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Foreign `.kilo/**` worktrees broke eslint**
- Found during Task 1 verify; fix: `globalIgnores` entry, committed separately (65d35cb) so the deletion commit stayed inside D-03's file list.

**2. [Rule 3 - Blocking] Flush-lever HTTP 500 on the stand-in web**
- The stand-in never carried CRON_SECRET (fail-closed 500). Minted a fresh secret into gitignored `.snapshots/standin-web-env.sh` (never logged/committed); achieved D-43's zero-loss goal via the empty-window kill; lever then proven on the new web. Runbook §4a blind spot logged.

**3. [Rule 3 - Plan-letter correction] `-X POST /api/cron/check` → GET**
- Both cron routes export GET only (plan's own read_first and runbook §4a step 10 say GET).

**4. [Rule 3 - Blocking] Docker Desktop engine API wedged mid-Task-4**
- New API calls hung while containers kept serving (readyz stayed green). Killed zombie CLI clients (no effect), then restarted the Docker Desktop process tree; engine recovered in ~15 s; `spidernode-dev-db` manually restarted (no auto-restart policy); worker PID 9252 and web self-healed through the entire outage without a restart. Recorded in the record's Task-4 timeframe.

**5. [Rule 1 - FND-07] NEXT_RUNTIME `.env.example` entry removed**
- Same reader-driven rule as D-46: its only reader was the deleted instrumentation file. Not in the plan's explicit list; consistent with its letter.

**6. [Rehearsal environment] Detached-process reaping + junction shims**
- `(cmd &)`-detached children die when the harness reaps the tool call — rehearsal processes launched via the sanctioned background mechanism instead. The tarball boot needed 2 junction shims (documented as a runbook amendment, not a failure of the rollback story).

## Authentication Gates / Checkpoints

- Task 3 checkpoint:human-verify (gate="blocking") — operator round-trip completed via the orchestrator; resolution recorded (resolved-by-absence). Not auto-approved at any point.

## Known Stubs

None — no stubs introduced; the deletion removed code and the dormant `/api/cron/*` routes intentionally survive as runbook §9's emergency lever (D-03, retiring Phase 6).

## Threat Flags

None — no new security surface. The threat model's two entries (flush discipline at the restart boundary; CRON_SECRET-gated dormant lever) were both addressed and proven (empty-window kill; 200/401 lever proofs). The lever's error path still echoes message+stack — pre-existing, already pinned as the Phase-6 red/green marker in the plan.

## Self-Check: PASSED

All 7 created/modified files present; src/instrumentation.ts confirmed deleted; all 5 task commits verified in git log (65d35cb, d55cad5, d5424e1, c1203aa, c62ecf6).
