---
phase: 03-redis-drizzle-schema-ownership
plan: "06"
subsystem: infra
tags: [redis, hardening, deploy-runbook, systemd, healthchecks-io, drizzle-kit, migrations, rehearsal, rate-limiting]

requires:
  - phase: 03-redis-drizzle-schema-ownership (03-01)
    provides: src/lib/redis.ts env contract (REDIS_URL throw-early), Lua limiter with [redis-limiter] DEGRADED fail-open marker
  - phase: 03-redis-drizzle-schema-ownership (03-03)
    provides: scripts/stamp-baseline.mjs (DIRECT one-shot contract), recorded source deviation (local docker spidernode-dev-db, not Neon)
  - phase: 03-redis-drizzle-schema-ownership (03-04)
    provides: drizzle/0001_worker-prereqs.sql + baseline-only stamp boundary
  - phase: 03-redis-drizzle-schema-ownership (03-05)
    provides: pnpm rehearse:migrations pipeline + committed evidence file (03-REHEARSAL-EVIDENCE-20260912.md)
provides:
  - Runbook §3b — one-time VPS Redis install + hardening (apt + the eight pinned conf lines, REDIS_URL wiring, PONG/active/supervised-restart/noeviction verifications, per-step rollbacks, TLS/ACL rationales)
  - Runbook §3c — Redis 70% memory alert (operator-provisioned dedicated healthchecks.io check + /usr/local/bin/redis-memory-check.sh + 5-minute cron + both-branch verification)
  - Runbook §3d — migration rehearsal procedure (fresh dump → pnpm rehearse:migrations → evidence review → abort-on-mismatch)
  - Runbook §3 step 3 Phase-3 activation (one-time stamp → single runner) + §3 step 5 limiter-live checks (d)/(e)/(f)
  - The complete typed Phase-3 operator path 03-08 executes: gate → backup → stamp → migrate → ship → harden → verify limiter live
affects: [03-08 (deploy — executes §3/§3b/§3c/§3d verbatim), Phase 4 (maxmemory revisit when BullMQ state lands), Phase 5 OBS-03 (supersedes §3c), Phase 7 (reuses §3d rehearsal pipeline)]

tech-stack:
  added: []  # documentation-only plan — no new dependencies
  patterns: [runbook sections as typed Action/Verification/Rollback triples (§3a layout extended to 3b/3c/3d), dead-man's-switch alert (ping-while-healthy, silence pages), one-authoritative-procedure cross-referencing (§3d owns rehearsal)]

key-files:
  created: []
  modified:
    - docs/DEPLOY-RUNBOOK.md

key-decisions:
  - "Restart-survival check (f) corrected to the 6th window request returning 429 — the plan's '5th request returns 429' was off by one against the shipped register route (limit: 5 per hour, src/app/api/auth/register/route.ts); 1 POST → pm2 restart → 4 allowed → the 6th POST 429s. 03-08 must follow the runbook's arithmetic, not its plan's"
  - "§3c threshold documented as ~358 MB decimal AND exactly 377,487,360 bytes / 360 MiB — Redis's `mb` is binary, so the plan's 358 MB shorthand alone would mislead; the script computes from INFO raw bytes, making its arithmetic exact"
  - "Neon references softened per the 03-03 recorded deviation: §3 step 3 and §3d note that production currently lives in local docker spidernode-dev-db and require 'the DIRECT unpooled URL pg_dump/psql would use' instead of hard-asserting Neon facts"
  - "RDS-03 NOT marked complete — this plan is the documented half; 03-08 executes the hardening live (02-03 FND-06 / 03-04 DRZ-02 precedent against false done-signals)"

patterns-established:
  - "Pattern: every new runbook section is a numbered Action/Verification/Rollback layout copied from §3a — one authoritative procedure per concern, other sections point at it (rehearsal = §3d everywhere)"
  - "Pattern: monitoring scripts exit 0 on all paths and signal only via dead-man ping/silence (never disrupt the watched app, never spam cron mail)"

requirements-completed: []  # RDS-03 deliberately NOT marked — documented half only; 03-08 (which also carries RDS-03) completes it live

coverage:
  - id: D1
    description: "Runbook §3b — one-time VPS Redis install + hardening: apt install, the eight pinned conf directives verbatim (incl. Type=notify/supervised-systemd coupling warning), REDIS_URL=redis://:<pass>@127.0.0.1:6379 into .env before any pm2 restart, PONG/active/supervised-restart/noeviction verifications, per-step rollbacks, TLS/ACL rationales"
    requirement: RDS-03
    verification:
      - kind: other
        ref: "grep proofs: '3b. One-time VPS Redis'=1, all 8 directives verbatim (supervised systemd / bind 127.0.0.1 / protected-mode yes / requirepass / appendonly yes / appendfsync everysec / maxmemory 512mb / maxmemory-policy noeviction), 'openssl rand -hex 32'=1, Type=notify=1, REDIS_URL construction=1, 14 Action/Verification/Rollback triples across §3b–3d"
        status: pass
    human_judgment: false
  - id: D2
    description: "Runbook §3c — Redis 70% memory alert: operator-provisioned dedicated healthchecks.io check (separate from the app heartbeat), /usr/local/bin/redis-memory-check.sh (INFO memory, ping-only-below-70%, exit-0-always), 5-minute cron, both-branch hand verification, rollback, Phase 5 OBS-03 supersession note"
    requirement: RDS-03
    verification:
      - kind: other
        ref: "grep proofs: '3c. Redis 70% memory alert'=1, 'INFO memory'=1, 'redis-memory-check'=9, 358 MB + 512mb numbers present, '*/5 * * * *' schedule present, 'silence pages'=3, heartbeat-separation statement present"
        status: pass
    human_judgment: false
  - id: D3
    description: "Runbook §3 step 3 Phase-3 activation (stamp-baseline one-time with DIRECT string + journal verification, then pnpm exec drizzle-kit migrate every release, single-runner rules verbatim) + §3d rehearsal procedure (fresh dump incl. recorded docker-exec deviation, pnpm rehearse:migrations, evidence review with carve-out explanation, abort-on-mismatch)"
    verification:
      - kind: other
        ref: "grep proofs: '3d. Migration rehearsal'=1, 'stamp-baseline'=2, 'node scripts/stamp-baseline.mjs' command block present, 'rehearse:migrations'=3, 'statement_timeout deliberately unset'=1, §3d step 4 'Abort the release on any mismatch' present; §7/§8 single-runner + forward-only statements intact"
        status: pass
    human_judgment: false
  - id: D4
    description: "Runbook §3 step 5 limiter-live checks (d)/(e)/(f): no [redis-limiter] DEGRADED in 50-line pm2 logs, non-empty db0 keyspace after one rate-limited request, restart-survival proof (1 register POST → pm2 restart → 4 allowed → 6th window request 429)"
    verification:
      - kind: other
        ref: "grep proofs: 'redis-limiter'=1 in check (d), 'survived the restart'=1, '(f)' present, '6th request in the 5-per-hour window'=1, restart sequence present; §6 + header note updated to the (a)–(f) list"
        status: pass
    human_judgment: false
  - id: D5
    description: "Whole-runbook consistency and operator-runnability: §1 web budget now counts 1 Redis connection (Phase 4 → 2+2), §3 step 2 and §4 step 2 defer to §3d as the one rehearsal authority, no section claims Redis unused, no contradiction with §7 rollback rule or §8 migration discipline, and an operator can execute the full Phase-3 path without inventing anything"
    verification: []
    human_judgment: true
    rationale: "Mechanical greps prove the additions landed, but 'operator-runnable without inventing anything under pressure' and absence of subtle cross-section contradictions are judgment calls — 03-08's live deploy (human-gated) is the operational proof of the runbook text"

duration: 474s (~8 min)
completed: 2026-09-12
status: complete
---

# Phase 03 Plan 06: Deploy Runbook — Phase 3 Redis/Hardening/Rehearsal Operator Path Summary

**The Phase-3 deploy runbook now carries every operator step as typed Action/Verification/Rollback triples: §3b Redis install + eight-line hardening with supervised-restart proof, §3c the 70% dead-man memory alert, §3d the rehearsal gate, the activated stamp-then-migrate step, and the (d)/(e)/(f) limiter-live post-deploy checks including the restart-survival 429 proof.**

## Performance

- **Duration:** 474s (~8 min)
- **Started:** 2026-09-12T14:10:54Z
- **Completed:** 2026-09-12T14:18:48Z
- **Tasks:** 3
- **Files modified:** 1 (docs/DEPLOY-RUNBOOK.md, +150/−10 lines across three commits)

## Accomplishments

- **§3b (D-15/D-17/D-18):** the complete one-time VPS Redis install + hardening — apt `redis-server`; the eight conf lines verbatim with one-line reasons (the `Type=notify`↔`supervised systemd` restart-loop warning front and center); `REDIS_URL=redis://:<pass>@127.0.0.1:6379` ordered into `.env` BEFORE any `pm2 restart` (module-load throw documented as T-03-21's failure mode); PONG-behind-password, ActiveState, supervised-restart proof, `CONFIG GET maxmemory-policy` → `noeviction`, and `NOAUTH` on the unauthenticated probe; per-step rollbacks from a pre-edit conf backup to full package removal; TLS-unnecessary-on-loopback and no-ACL rationales (D-18).
- **§3c (D-16):** the 70% memory alert fully specified — operator-provisioned dedicated healthchecks.io check (explicitly separate from the app heartbeat), `/usr/local/bin/redis-memory-check.sh` (mode 700, embeds the password) reading `used_memory`/`maxmemory` from `INFO memory`, pinging ONLY below 70% (silence pages; an unreachable Redis also silences → outage coverage for free), every-5-minute cron, both branches verified by hand (the over-threshold branch via a `THRESHOLD_PCT=0` throwaway copy — production threshold never touched), whole-mechanism rollback, Phase 5 OBS-03 supersession.
- **§3 step 3 + §3d (D-08/D-10..D-12):** the Migrate step's Phase-3 branch activated with the two typed commands in order — first-release-only `node scripts/stamp-baseline.mjs` (DIRECT string, statement_timeout unset, `__drizzle_migrations` verification) then `pnpm exec drizzle-kit migrate` every release — single-runner/boot/never-two rules kept verbatim; §3d owns the rehearsal procedure (fresh dump → `pnpm rehearse:migrations` → evidence review → abort-on-mismatch).
- **§3 step 5 (d)/(e)/(f):** the limiter-live proofs — no `[redis-limiter] DEGRADED` in the 50-line log window, non-empty `db0` keyspace after one rate-limited request, and the restart-survival sequence proving the window lives in Redis across a `pm2 restart`.
- **Consistency sweep:** §1 budget line (web = 10 Postgres + 1 Redis this phase; Phase 4 → 2+2 per IN-05/OBS-05), §3 step 2 and §4 step 2 now defer to §3d (one authoritative rehearsal procedure), §3 step 4 orders `REDIS_URL` before the first Phase-3 reload, §6 and the header amendment note updated; no section claims Redis is unused.

## Task Commits

1. **Task 1: §3b one-time VPS Redis install + hardening** - `7ddf59d` (docs)
2. **Task 2: §3c Redis 70% memory alert (cron + dedicated check)** - `2cc2644` (docs)
3. **Task 3: §3 step 3 activation + §3d rehearsal + (d)/(e)/(f) checks + consistency** - `cc0a07f` (docs)

**Plan metadata:** (final docs commit below)

## Section Numbers as Landed (for 03-08's checkpoint citations)

- **§3b** "One-time VPS Redis install + hardening (run once, at the Phase 3 deploy)" — 5 steps: (1) install, (2) conf hardening, (3) restart+enable, (4) REDIS_URL into .env, (5) service verification
- **§3c** "Redis 70% memory alert — VPS cron + dedicated healthchecks.io check (D-16)" — 5 steps: (1) provision check, (2) script, (3) cron, (4) both-branch verification, (5) whole-mechanism rollback
- **§3d** "Migration rehearsal — before every schema-touching release (D-10..D-12)" — 4 steps: (1) fresh dump, (2) run, (3) review evidence, (4) abort on mismatch
- **§3 step 3** now embeds the stamp command block + `__drizzle_migrations` verification + the two deviation notes (D-01, 03-03)
- **§3 step 5** is now checks (a)–(f)
- These match 03-08-PLAN.md's citations (§3b/§3c/§3d/§3 step 3/§3 step 5) exactly.

## Records the Plan's Output Spec Requires

- **maxmemory chosen:** `512mb` (§3b step 2) with the inline note "**revisit at Phase 4 (BullMQ state)****"** — when the worker's queues/dedup keys land, re-derive the ceiling from measured `used_memory` under load; the §3c alert threshold follows automatically (70% of whatever the ceiling then is).
- **§3 step 2 vs §3d wording tension:** resolved in favor of ONE authoritative procedure — §3 step 2's inline rehearsal parenthetical ("restore → run migration → run smoke check locally") was replaced by a pointer to §3d (its Verification now says "rehearsal (§3d) completed with a PASS evidence file"). The old inline wording predated 03-05's scripted pipeline and would have had operators hand-running a rehearsal that no longer exists in that shape. §4 step 2 (Phase 4+) keeps its worker-specific wrapper (`readyz` around the migrate) but points at §3d for the mechanics.
- **DB-host discrepancy handling (per prior-wave instruction):** §3 step 3's DIRECT-string requirement and §3d's dump command both carry the 03-03 recorded deviation as blockquotes — the generic docker-run/direct-connection forms are typed out, with the note that production today is the local docker container `spidernode-dev-db` (both committed dumps taken via `docker exec`). No Neon fact is hard-asserted.

## Files Created/Modified

- `docs/DEPLOY-RUNBOOK.md` - §3b/§3c/§3d added after §3a; §3 steps 2/3/4/5 amended; §1 budget line; §4 step 2 pointer; §6 wording; header amendment note (2026-09-12)

## Decisions Made

- Corrected the restart-survival arithmetic (see Deviations #1) — runbook follows the shipped code, not the plan's off-by-one
- Threshold prose carries both the plan's ~358 MB decimal figure and the exact byte value (377,487,360 / 360 MiB) so neither reading misleads
- RDS-03 left unchecked in REQUIREMENTS.md (documented half only — 03-08 executes it live and also carries RDS-03)
- §3b step 4's rollback deliberately says "never remove the REDIS_URL line while Phase 3+ code is live" — the naive rollback (delete the line) re-arms the module-load crash loop

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Restart-survival check's request arithmetic was off by one**
- **Found during:** Task 3 (check (f) authoring)
- **Issue:** the plan states "POST four more times — the 5th request in the window returns 429", but the shipped limiter is `limit: 5, windowMs: 3600000` (`src/app/api/auth/register/route.ts`): requests 1–5 all pass (`count <= limit`), the **6th** returns 429. As written, the typed check would have operators expecting a 429 that never comes and possibly "fixing" a healthy deploy
- **Fix:** runbook (f) reads: 1 POST → `pm2 restart` → POST five more times — first four allowed (window requests 2–5), the fifth post-restart POST (6th in the window) returns 429. The in-memory-limiter counterfactual ("sixth would have succeeded after a reset") stays in the text as the proof's meaning. **03-08's plan text still carries the old '5th' wording — its executor must follow the runbook**
- **Files modified:** docs/DEPLOY-RUNBOOK.md (§3 step 5 (f))
- **Verification:** grep "6th request in the 5-per-hour window" = 1; sequence grep green; limit fact read from source
- **Committed in:** cc0a07f

**2. [Rule 1 - Precision] 358 MB threshold shorthand is wrong in bytes**
- **Found during:** Task 2 (§3c authoring)
- **Issue:** the plan's "~358 MB" is 70% of 512 **decimal** MB; Redis's `maxmemory 512mb` is 536,870,912 bytes, so the true threshold is 377,487,360 bytes (360 MiB). A byte-comparing operator would think the alert early-fires
- **Fix:** §3c carries both: "~358 MB decimal (exactly 377,487,360 bytes / 360 MiB, since Redis's `mb` is binary; the script computes from `INFO`'s raw byte values, so its arithmetic is exact)"
- **Files modified:** docs/DEPLOY-RUNBOOK.md (§3c header)
- **Verification:** grep "358 MB" = 1 with the byte value adjacent; script computes used/max from INFO bytes directly
- **Committed in:** 2cc2644

**3. [Rule 2 - Missing Critical] §3b wiring rollbacks could re-arm the crash loop**
- **Found during:** Task 1 (rollback lines authoring)
- **Issue:** a naive "rollback: remove the REDIS_URL line" instruction would instruct operators to recreate T-03-21's boot crash loop (`src/lib/redis.ts` throws at module load without the var)
- **Fix:** §3b step 4's rollback explicitly says never remove the line while Phase 3+ code is live; password regeneration = update the line in the same change
- **Files modified:** docs/DEPLOY-RUNBOOK.md (§3b step 4)
- **Verification:** grep proof — "never remove the line" present in step 4's Rollback
- **Committed in:** 7ddf59d

---

**Total deviations:** 3 auto-fixed (2 Rule 1, 1 Rule 2)
**Impact on plan:** No scope creep. All three are correctness of the operator instructions themselves — exactly what a runbook plan must get right; none changed any section's structure or the plan's scope.

## Issues Encountered

None beyond the deviations above. All plan-specified greps and acceptance criteria passed on first run for every task.

## User Setup Required

None — this plan is documentation-only. The operator-facing manual steps (provision the healthchecks.io redis-memory check, supply the production connection strings) are typed instructions INSIDE the runbook for 03-08's deploy, not configuration this plan performs.

## Next Phase Readiness

- **03-08 (deploy, depends on this + 03-07):** the runbook is 03-08's script — §3 in order with §3b before the reload, §3c installed during the same window, §3d's obligation already satisfied by 03-05's PASS evidence. **Caution for 03-08's executor:** follow the runbook's corrected restart-survival arithmetic (6th request 429), not the plan-text "5th"; and read §3 step 3's deviation note before assuming a Neon console — the recorded production host is the local docker container until the operator says otherwise
- **03-07 (empty-diff gate):** unaffected; §3 step 3's Verification already names the empty-diff check as part of the release verification
- **Phase 4:** revisit §3b's `maxmemory 512mb` when BullMQ state lands (noted inline in §3b and §3c follows automatically)
- **Phase 5 OBS-03:** supersedes §3c entirely (noted in §3c twice — header + script comment): do not extend the cron mechanism

## Self-Check: PASSED

docs/DEPLOY-RUNBOOK.md is the single modified file (exists, modified in 3 commits); all 3 task commits verified in git log (7ddf59d, 2cc2644, cc0a07f); section order verified 1→2→3→3a→3b→3c→3d→4→4a→5…10; 14/14/14 Action/Verification/Rollback triples across §3b–3d; working tree shows no stray files beyond the pre-existing hygiene exclusions (skills-lock.json, .claude/skills/*, .planning/research/.cache/*, .playwright-mcp/, docker-compose.dev.yml — untouched).

---
*Phase: 03-redis-drizzle-schema-ownership*
*Completed: 2026-09-12*
