---
phase: 04-monitoring-worker-build-dark-launch
plan: 09
subsystem: deploy-tooling
tags: [dark-launch, rehearsal, smoke-check, denylist-gate, deploy-record, operator-tooling]
requires:
  - "04-01..04-08 — the worker engine, queues, health surfaces, resilience suite"
  - "03-08 — the operator-ratified local stand-in topology (spidernode-dev-db :5454, hardened Redis stand-in :6391, pnpm start web :3007)"
provides:
  - "scripts/rehearse:worker — one-command deploy-day rehearsal (D-32) with evidence file"
  - "scripts/smoke:enqueue — the D-18 enqueue-form smoke check (priority-1 manual job, ping-row evidence)"
  - "scripts/redrive-outbox.mjs — D-46 operator re-drive for FAILED outbox rows (dry-run default, dedup-before-remark)"
  - "scripts/seed-synthetic.sql + scripts/check-denylist-diff.mjs — D-19 seed and the D-40 denylist drift gate (in pnpm verify)"
  - "04-DEPLOY-RECORD.md — the executed dark launch with evidence, N/A-locally dispositions, D-33 pointer, rollback story"
  - "The live dark-launch steady state: worker running with zero schedulers, cron serving 100% of user checks (Task 4 operator gate APPROVED 2026-09-14 ~17:35Z — Phase 4 closed)"
affects:
  - docs/DEPLOY-RUNBOOK.md (§3/§4/§4a/§6a/§10 amendments)
  - package.json (rehearse:worker / smoke:enqueue / denylist:diff scripts; verify chain)
tech-stack:
  added: []
  patterns:
    - "tsup v8 self-contained bundling requires noExternal: [/.*/] — skipNodeModulesBundle:false alone leaves package.json dependencies externalized (discovered in the rehearsal container leg)"
    - "Windows SIGINT/SIGTERM cannot be delivered to native process trees — SIGINT-drain proofs go through a Linux container; process restarts are hard stops timed against batcher flush boundaries"
    - "Count-delta assertions for ping evidence (timezone-proof) — node-pg renders naive timestamp columns in local time"
key-files:
  created:
    - scripts/seed-synthetic.sql
    - scripts/enqueue-smoke.mjs
    - scripts/redrive-outbox.mjs
    - scripts/rehearse-worker.mjs
    - scripts/check-denylist-diff.mjs
    - .planning/phases/04-monitoring-worker-build-dark-launch/04-DEPLOY-RECORD.md
    - .planning/phases/04-monitoring-worker-build-dark-launch/04-REHEARSAL-EVIDENCE-20260914.md
  modified:
    - package.json
    - docs/DEPLOY-RUNBOOK.md
    - tests/resilience/observations.json (D-33 refresh, closeout commit)
decisions:
  - "D-16 dark-launch posture: WORKER_SCHEDULER_ENABLED=false skips scheduler upserts only; consumers stay live; rollback = stop the worker process (D-22)"
  - "D-40 denylist gate machine-enforces engine↔runbook set equality inside pnpm verify (mismatch proven once, then reverted)"
  - "Windows web restart dispositions honestly: taskkill loses the in-flight batched ping (1 of 23 ticks); PM2 SIGTERM graceful flush forward-tracked to first VPS deploy"
metrics:
  duration: 1h 5m
  completed: 2026-09-14
status: complete
---

# Phase 4 Plan 09: Deploy tooling, rehearsal & dark launch Summary

**One-liner:** Deploy-day tooling shipped and proven live — rehearse:worker (D-32, 13-step throwaway-stack rehearsal), smoke:enqueue (D-18), outbox re-drive (D-46), the D-40 denylist gate in verify, and the dark launch executed on the 03-08 stand-in with the scheduler paused, cron serving 100% of checks, smoke ping evidenced, and rollback one stop away.

## What Was Built

**Task 1 — operator deploy tooling (commit `70060e5`):** `scripts/rehearse-worker.mjs` (14-step pipeline: own 5460/6460/9460 stack, dynamic zero-new-migrations assert, migrate, seed, worker+readyz, smoke, Postgres-stop and Redis-stop injections with recovery, a Linux-container SIGINT-drain leg proving exit-0 drain with boot/shutdown markers, evidence file, finally-teardown), `scripts/enqueue-smoke.mjs` (D-18 smoke: one priority-1 manual enqueue via the real `enqueueManualCheck`, count-delta ping-row assert, watchdog, fail-loud), `scripts/redrive-outbox.mjs` (D-46: FAILED-row listing, dedup-key check BEFORE any re-mark, dry-run default, `--apply` re-marks PENDING), `scripts/seed-synthetic.sql` (D-19 idempotent sentinel-owner seed honoring both engines' NULL semantics), plus `rehearse:worker`/`smoke:enqueue` package scripts. Rehearsal green on run 3 (see Deviations for runs 1-2).

**Task 2 — runbook amendments + D-40 gate (commit `9f667e2`):** DEPLOY-RUNBOOK §3 pre-deploy chain (test:resilience D-27 + rehearse:worker D-32), §4/§4a ACTIVATED ordering (D-23) with the D-49 re-seed typed text-now/execution-Phase-5 and D-22 stop-the-worker rollback, §6a D-19 seed values + D-46 re-drive, §10 concrete iptables/nftables egress text (11 CIDR tokens) with the D-17 first-VPS-deploy disposition; `scripts/check-denylist-diff.mjs` wired into verify adjacent to worker:boundary — extraction is shape-filtered so prose decoys (80/tcp, 10.x.x.x, URLs) never enter the set compare; mismatch behavior proven once (removed `64:ff9b::/96` → exit 1 naming exactly that token) then reverted → green with 11 tokens.

**Task 3 — the dark launch executed (commit `858e1b9`):** on the 03-08 stand-in per the amended §4/§4a ordering — test:resilience 7/7 (235.85s, D-33 dataset regenerated); one-SHA build at `9f667e2` (.next + dist/worker.js, SHA embedded); pg_dump backup (28,192 B, pg_restore --list 0); migrate no-op with journal 2→2 asserted; seed applied twice (idempotent); worker up as a plain process (`WORKER_SCHEDULER_ENABLED=false`, `readyz` 200 first poll); web restart continuity proven across batcher flush boundaries (T1 lastChecked 13:59 / T2 14:14, pings 236→245→258 with exact tick accounting); smoke at 14:01:30Z — jobId `check-manual:3:1789394490276`, Tier-1 persist 121ms, ping `62ff7108…` UP 97ms; zero-scheduler proven directly in Redis (delayed zset 0, repeat hash absent, only meta/stalled-check bookkeeping); same-SHA provenance on both health surfaces; steady state LEFT RUNNING for the operator gate; `04-DEPLOY-RECORD.md` written mirroring the 03-08 pattern (evidence pointers, N/A-locally dispositions with VPS consumption points, D-33 summary, D-22 rollback record), automated keyword+drizzle verify green, schema:gate corroborated.

**Task 4 — operator confirmation of the boring dark launch (gate CLOSED):** blocking human-verify gate resolved by the operator typing "approved" at 2026-09-14 ~17:35Z, after the six checks ran against the steady state held live for ~3.7 h: `/readyz` 200 (operator-run curl); `/metrics.json` all six lanes depth 0, zero scheduler activity, outbox 0/0, sha `9f667e2`; monitor id=2 `lastChecked` advancing (age 2m43s at query); smoke PASS on the explicit-env invocation (ping `68f9bbc0…` UP 178ms, jobId `check-manual:3:1789407269546`, Tier-1 `applied:false` — the correct duplicate-safe evidence path per DAT-04); same-SHA one-build provenance; deploy record dispositions reviewed. The first, ambient-env smoke invocation failed loud (job stranded on the 6390 test stack, 60s timeout, exit 1) — validating the script's fail-loud contract, an invocation error not a deployment defect (full account in the DEPLOY-RECORD's Task 4 section). Recorded by the continuation agent in `04-DEPLOY-RECORD.md`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] tsup v8 externalized dependencies in the rehearsal container bundle**
- **Found during:** Task 1, rehearsal run 1 (container leg never reached readyz; bundle 102.88 KB with 8 raw `require("pg")/("bullmq")/…` calls)
- **Issue:** tsup v8 externalizes package.json `dependencies` by default; `skipNodeModulesBundle: false` does not override it
- **Fix:** temp rehearsal tsup config uses `noExternal: [/.*/]` (kept `external: ["pg-native"]` for pg's lazy native getter) → 3.28 MB self-contained bundle, 0 external requires, container leg green
- **Files modified:** scripts/rehearse-worker.mjs
- **Commit:** 70060e5

**2. [Rule 1 - Bug] fetchJson discarded 503 bodies**
- **Found during:** Task 1 (self-review before first run)
- **Issue:** the PG-outage assert reads `{db:{ok:false}}` from a 503 response, but the helper only parsed bodies on 200
- **Fix:** parse body for any status (null fallback)
- **Files modified:** scripts/rehearse-worker.mjs
- **Commit:** 70060e5

**3. [Rule 3 - Blocking] Docker Desktop transient connection drop at the migrate seam**
- **Found during:** Task 1, rehearsal run 2 ("Connection terminated unexpectedly" after a single passing pg_isready — run 1 passed identically)
- **Fix:** two consecutive pg_isready probes 1s apart required, plus one bounded 5s retry at the migrate seam with idempotent re-run; honest teardown messages (inspect-before-rm)
- **Files modified:** scripts/rehearse-worker.mjs
- **Commit:** 70060e5

**4. [Rule 1 - Bug] Windows path handling in rehearsal (self-caught)**
- **Issue:** `replaceAll("\\\\","/")` searched for a two-backslash literal; `docker cp` source form fragile
- **Fix:** `toPosix()` helper via `path.sep` split; contents-copy form `${toPosix(dir)}/.`
- **Files modified:** scripts/rehearse-worker.mjs
- **Commit:** 70060e5

**5. [Plan-text vs engine] manual jobId form**
- **Issue:** the plan's key_links wrote `check:{id}:manual:{epochMs}`; the engine's actual form is `check-manual:{monitorId}:{epochMs}` (verified live: `check-manual:3:1789394490276`)
- **Resolution:** implemented to match `queues.ts` exactly, per the dispatch's explicit instruction; recorded here so the plan text is not treated as authoritative on the shape

**6. [Environment] Windows web restart in Task 3**
- **Issue:** no SIGTERM/SIGINT delivery to a native Windows process tree — the plan's "restart the web" had to use `taskkill /T /F` timed against a batcher flush boundary
- **Disposition:** exact accounting recorded (23 tick completions in flush-covered windows, 22 persisted — one in-flight ping lost at the hard stop, one boundary inside the 22s boot gap); the PM2 SIGTERM→gracefulShutdown flush is forward-tracked to the first VPS deploy (deploy record disposition 2)
- **Commit:** 858e1b9 (record documents it)

### Deferred Items

None. Out-of-scope tree state deliberately untouched per hard constraints: `skills-lock.json`, `.claude/skills/*`, `.planning/research/.cache/*`, `.playwright-mcp/`, `docker-compose.dev.yml`, `.env.test`, `04-PATTERNS.md`.

## Verification Evidence

- Task 1: `node --check` × 3 scripts green; `pnpm rehearse:worker` exit 0 — evidence at `.planning/phases/04-monitoring-worker-build-dark-launch/04-REHEARSAL-EVIDENCE-20260914.md` (13 steps GREEN, both outage injections, SIGINT container leg exit 0)
- Task 2: mismatch proof (exit 1 naming `64:ff9b::/96`) then green with 11 tokens; `node scripts/check-denylist-diff.mjs && pnpm verify` green (18 e2e)
- Task 3: plan verify green (`record ok` + `drizzle/ unchanged`), `pnpm schema:gate` green (empty diff); steady state live at close — `readyz` 200, `/healthz` sha `9f667e2`, web `/login` 200, monitor 2 lastChecked advancing

## TDD Gate Compliance

Not a TDD plan (`type: execute`); no test commits required. The resilience suite and rehearsal serve as the executed-behavior evidence.

## Known Stubs

None. No placeholder values, no unwired data paths, no TODO/FIXME markers in the delivered files.

## Threat Flags

None. No new network surface: the health server already binds 127.0.0.1; all new scripts are local operator tooling; the D-40 gate strengthens (not extends) the existing SSRF denylist boundary. No secrets logged anywhere (Redis password only ever via `$(cat …)` substitution).

## Self-Check: PASSED

Verified after SUMMARY creation: all 7 created files exist on disk; commits `70060e5`, `9f667e2`, `858e1b9` present in `git log`; Task 4 initially not executed (blocking human gate) — subsequently executed via operator approval 2026-09-14 ~17:35Z, with the continuation agent recording the approval in `04-DEPLOY-RECORD.md` and amending this SUMMARY.
