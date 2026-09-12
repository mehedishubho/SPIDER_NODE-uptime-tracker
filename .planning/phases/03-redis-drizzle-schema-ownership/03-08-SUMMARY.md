---
phase: 03-redis-drizzle-schema-ownership
plan: "08"
subsystem: infra
tags: [deploy, drizzle, drizzle-kit, migrations, baseline-stamp, redis, hardening, rate-limiting, restart-survival, local-release]

requires:
  - phase: 03-redis-drizzle-schema-ownership (03-01)
    provides: src/lib/redis.ts + Lua limiter (DEGRADED fail-open marker), REDIS_URL throw-early contract
  - phase: 03-redis-drizzle-schema-ownership (03-03)
    provides: drizzle/0000_baseline.sql, scripts/stamp-baseline.mjs, committed journal anchor (when=1789218624104, hash 9b294622…5030), recorded local-container source deviation
  - phase: 03-redis-drizzle-schema-ownership (03-04)
    provides: drizzle/0001_worker-prereqs.sql (baseline-only stamp boundary)
  - phase: 03-redis-drizzle-schema-ownership (03-05)
    provides: rehearsal evidence 03-REHEARSAL-EVIDENCE-20260912.md (PASS — the DRZ-06 deploy gate)
  - phase: 03-redis-drizzle-schema-ownership (03-06)
    provides: runbook §3/§3b/§3c/§3d as amended — the operator path this plan executed
  - phase: 03-redis-drizzle-schema-ownership (03-07)
    provides: pnpm verify chain with schema:gate (the pre-deploy gate)
provides:
  - The Phase 3 release applied and proven on the operator-ratified local-only production topology: stamped baseline + 0001 through the single runner, idempotence proven, data intact
  - Hardened Redis stand-in (spidernode-prod-redis, loopback 6391) — requirepass/noeviction/AOF-everysec/512mb, restart-supervised — serving the live limiter
  - Criterion 1 observed in production form: limiter window survives an app process restart (6th window request → 429) AND the counter survives a Redis restart (AOF persistence)
  - 03-DEPLOY-RECORD.md — the phase's production evidence transcript (per-step outcomes, (a)–(i) checks, deviations, timings)
affects: [Phase 4 (worker cutover — schema + Redis now proven live; §3b maxmemory revisit when BullMQ lands), Phase 7 (rehearsal pipeline reused; auth-cutover deploy follows this path), Phase 5 OBS-03 (supersedes §3c)]

tech-stack:
  added: []  # redis:7-alpine image pulled for the stand-in container — no repo dependency changes
  patterns: [local-stand-in release preserving runbook safety semantics (backup→stamp→single-runner→forward-only; harden-before-boot; explicit env on the launch command so .env is never read), MSYS_NO_PATHCONV=1 for docker volume commands in Git Bash]

key-files:
  created:
    - .planning/phases/03-redis-drizzle-schema-ownership/03-DEPLOY-RECORD.md
  modified: []

key-decisions:
  - "Operator-ratified topology at the Task 2 checkpoint: LOCAL-ONLY release — DB leg on spidernode-dev-db (the 03-03 ground-truth production data), Redis leg on a dedicated hardened container, app leg via pnpm start; mechanical execution delegated to the executor; §3b/§3c VPS-specific mechanisms (apt/systemd/cron/healthchecks.io) dispositioned N/A-locally"
  - "RDS-03 and DRZ-02 marked complete under that ratified topology: every applicable §3b pinned directive is live and proven (requirepass, loopback, AOF everysec, 512mb, noeviction, restart supervision) and the schema-apply pipeline ran against the real production database; the literal VPS forms (systemd enable, §3c healthchecks.io check) remain typed in the runbook for whenever production moves to a real VPS — recorded in the deploy record, not silently assumed"
  - "Restart-survival proof executed with the runbook's corrected arithmetic: request 1 → kill → relaunch → requests 2–5 non-429 → 6th window request 429 (x-ratelimit-remaining: 0); the older plan-text '5th' wording was never followed"
  - "Bonus proof captured beyond the plan: the Redis container restart preserved the limiter counter at 6 (AOF everysec) — RDS-03's persistence clause demonstrated, not just asserted"

patterns-established:
  - "Pattern: a local-only release adapts runbook §3 by mapping each safety semantic to its local equivalent (docker restart ↔ supervised restart; -p 127.0.0.1 ↔ bind 127.0.0.1; explicit shell env ↔ .env) and recording every mapping in the deploy record"
  - "Pattern: secrets for local stand-ins live in gitignored files under .snapshots/ (mode 600), constructed in-shell, never echoed into transcripts or records"

requirements-completed: [RDS-03, DRZ-02]

coverage:
  - id: D1
    description: "Pre-flight: pnpm verify green on release commit 2207f5e (28.6s warm), rehearsal evidence PASS confirmed, tarball verified (drizzle tree, both configs, four scripts, drizzle-kit in dependencies, no .env*)"
    verification:
      - kind: other
        ref: "verify exit 0 (timed run) + tar -tzf content checks + grep proofs — transcribed in 03-DEPLOY-RECORD.md pre-flight table"
        status: pass
    human_judgment: false
  - id: D2
    description: "Schema-apply production leg: pre-stamp probe clean (0 drizzle tables, 0 worker-prereqs, 9 public, 1/1/234 rows) → stamp wrote exactly the baseline row (hash byte-identical to the committed anchor) → runner applied 0001 exactly once (hash == sha256 of 0001_worker-prereqs.sql) → second run no-op exit 0 → 11 public tables, 3 indexes, backfill landed, data intact"
    requirement: DRZ-02
    verification:
      - kind: other
        ref: "stamp/migrate exit codes + psql bookkeeping/structure/backfill probes in 03-DEPLOY-RECORD.md §3 step 3"
        status: pass
    human_judgment: false
  - id: D3
    description: "Hardened Redis stand-in: dedicated container mirroring §3b's pinned directives (requirepass 64-hex on-disk-only, loopback publish, AOF everysec, maxmemory 536870912, noeviction, --restart unless-stopped); PONG/NOAUTH/CONFIG-GET verified; §3c dispositioned N/A-locally per operator"
    requirement: RDS-03
    verification:
      - kind: other
        ref: "redis-server 7.4.8 version line + PING/NOAUTH/CONFIG GET outputs in 03-DEPLOY-RECORD.md §3b table"
        status: pass
    human_judgment: false
  - id: D4
    description: "Limiter live proofs: (a) login 200, (c)/(d) zero errors and zero [redis-limiter] DEGRADED across both launches, (e) db0 keys=1 with rl:register counter TTL≈1h after request 1, (f) restart-survival — app killed + relaunched, requests 2–5 → 400, 6th → 429 with x-ratelimit-remaining: 0, counter=6 in Redis, (g) Redis restart → PONG with counter surviving at 6 (AOF), (i) 3 cron cycles, pings 234→236 on the 1-minute schedule into the migrated DB"
    verification:
      - kind: other
        ref: "per-request status codes + headers, redis GET/TTL values, psql ping-count delta in 03-DEPLOY-RECORD.md §3 step 5 table"
        status: pass
    human_judgment: false
  - id: D5
    description: "Operator sign-off on the release path (Task 2/3 human-verify checkpoints) and post-hoc review of the executor transcript + deploy record under the local-only delegation"
    verification: []
    human_judgment: true
    rationale: "The operator ratified the local-only topology and delegated execution at the checkpoint, and reviews the transcript + 03-DEPLOY-RECORD.md afterwards — a human decision no automation asserts"

duration: ~40 min
completed: 2026-09-12
status: complete
---

# Phase 03 Plan 08: Production Release (Operator-Guided) Summary

**The Phase 3 release applied live under an operator-ratified local-only topology: baseline stamped + 0001 applied exactly once through the single runner (idempotence proven, data intact 1/1/234), a hardened Redis stand-in serving the live limiter whose window survived an app restart (6th window request → 429) and whose counter survived a Redis restart (AOF) — every check transcribed in 03-DEPLOY-RECORD.md.**

## Performance

- **Duration:** ~40 min total (pre-flight ~10 min; operator checkpoint; local deploy leg ~9 min 18:37–18:46 UTC)
- **Started:** 2026-09-12T18:08:43Z
- **Completed:** 2026-09-12T18:49:00Z (approx)
- **Tasks:** 3 (Task 1 auto; Tasks 2–3 checkpoint-gated, resolved by operator decision + delegation)
- **Files modified:** 1 (03-DEPLOY-RECORD.md created)

## Accomplishments

- **Pre-flight green:** `pnpm verify` exit 0 in 28.6s warm on release commit 2207f5e (114 vitest + schema:gate + build + 18 e2e); rehearsal evidence PASS confirmed as the DRZ-06 deploy gate; tarball `/tmp/uptime-tracker-2207f5e.tar.gz` verified to carry the full migration machinery (drizzle tree, both configs, four scripts, generated client, drizzle-kit in `dependencies`, zero `.env*`).
- **Schema-apply gate closed on the production database (local ground truth):** pre-stamp probe clean → stamp wrote exactly the baseline row (hash `9b294622…5030` byte-identical to the committed anchor, `created_at` = the committed `when`) → `pnpm exec drizzle-kit migrate` applied 0001 exactly once (runner row hash byte-identical to sha256 of the 0001 file) → second invocation a no-op exit 0 → 11 public tables, all three 0001 indexes, backfill landed, row counts unchanged.
- **Redis hardened and proven both directions:** dedicated `spidernode-prod-redis` (7.4.8) with requirepass (64-hex, gitignored file, never echoed), loopback-only publish, AOF everysec, 512 MiB ceiling, noeviction, restart policy — PONG behind auth, NOAUTH without, CONFIG GET proofs, PONG after `docker restart`.
- **Criterion 1 observed:** restart-survival proof per the runbook's corrected arithmetic — request 1 (400) → app killed (port verified free, counter still 1 in Redis) → relaunch → requests 2–5 (400) → **6th window request 429** with `x-ratelimit-remaining: 0`. Bonus: the counter also survived a full Redis restart at value 6 (AOF persistence demonstrated).
- **Monitoring continuity through the deploy:** the untouched cron engine ran 3 check cycles on the monitor's 1-minute schedule and the batcher flush persisted 2 new UP pings (234 → 236) into the migrated database.
- **Full evidence trail:** 03-DEPLOY-RECORD.md — pre-flight table, per-step §3/§3b outcomes, the (a)–(i) check transcript, five dispositioned deviations, timings.

## Task Commits

1. **Task 1: Pre-flight verification + deploy record skeleton** - `c960eb8` (docs)
2. **Tasks 2–3: Deploy executed (delegated) + record completed** - `e8bd9be` (docs)
3. **Plan metadata (this SUMMARY + state files)** - *(final docs commit below)*

## Files Created/Modified

- `.planning/phases/03-redis-drizzle-schema-ownership/03-DEPLOY-RECORD.md` - the phase's production evidence: topology decision, pre-flight table, backup/stamp/migrate outputs, §3b verification table, (a)–(i) check transcript, deviations, timings, verdict

## Decisions Made

- **Local-only release** — operator-ratified at the Task 2 checkpoint ("Local only" + delegation); every §3 safety semantic mapped to its local equivalent and recorded (see deploy record deviation table)
- **RDS-03 + DRZ-02 marked complete under the ratified topology** — every applicable §3b directive is live and the schema pipeline ran against the real production database; the literal VPS forms (systemd enable, §3c healthchecks.io check) stay typed in the runbook for a future VPS move and are recorded as the operator's N/A-locally disposition — not silently assumed away
- Restart-survival executed with the runbook's 6th-request arithmetic (03-06's correction), never the plan's stale "5th"
- Kept post-release: `spidernode-prod-redis` (running), `.snapshots/pre-release-2207f5e.dump`, gitignored password file — per instruction; never down-migrated

## Deviations from Plan

### Operator-Ratified Deviations (checkpoint resolutions)

**1. [Topology] Local-only stand-in instead of VPS/Neon/PM2**
- **Found during:** Task 2 checkpoint
- **Issue:** The plan/runbook assume a VPS with pm2 and (optionally) Neon; the 03-03 recorded ground truth is that production data lives in the local docker container
- **Fix:** Operator chose "Local only" and delegated mechanical execution: DB leg → spidernode-dev-db, Redis leg → dedicated hardened container, app leg → `pnpm start` with explicit env; §3b/§3c VPS-only mechanisms recorded N/A-locally
- **Files modified:** 03-DEPLOY-RECORD.md (topology section + deviation table)
- **Verification:** all adapted checks green (see record)
- **Committed in:** e8bd9be

### Auto-fixed Issues

**2. [Rule 3 - Blocking] MSYS path mangling broke `pg_restore --list` inside `docker run`**
- **Found during:** Task 2 step 1 (backup verification)
- **Issue:** Git Bash translated the container-side path `/dump/...` to `C:/Program Files/Git/dump/...`
- **Fix:** `MSYS_NO_PATHCONV=1` + `$(pwd -W)` for the host side of the volume mount; exit 0 on retry
- **Files modified:** none (command form only; pattern recorded in SUMMARY frontmatter)
- **Verification:** pg_restore --list exit 0, 9 TABLE DATA entries
- **Committed in:** n/a (transcript)

**3. [Rule 1 - Precision] Plan's tarball-verify regex assumed bare tar paths**
- **Found during:** Task 1 (tarball verification)
- **Issue:** packing with `.` from Git Bash yields `./drizzle/` prefixes, so `^drizzle/` matched 0
- **Fix:** verified with `./`-prefixed patterns — machinery verifiably inside; recorded as pre-flight observation
- **Committed in:** c960eb8

---

**Total deviations:** 3 (1 operator-ratified topology, 1 Rule 3 command-form fix, 1 Rule 1 verification-regex precision)
**Impact on plan:** No scope creep. The topology deviation was the checkpoint's designed decision point; both auto-fixes are command-form corrections that changed no artifact.

## Issues Encountered

- `spidernode-dev-db` was stopped at deploy start (only the test stack was up) — started it and waited for `pg_isready` before the backup; recorded in the transcript flow.
- Background task exit codes of 1 for both app launches are the expected artifacts of the mandated `taskkill` steps (kill for the restart-survival proof, kill for cleanup) — not failures.

## Authentication Gates

None — the local topology uses the non-secret dev credentials from docker-compose.dev.yml; the generated Redis password was created and consumed on-machine without ever entering a transcript.

## User Setup Required

None remaining for this plan. Operator-side follow-ups recorded (not blockers): review the deploy record; the §3c healthchecks.io check + literal systemd `enable` exist as typed runbook steps for whenever production moves to a real VPS; Phase 4 must revisit §3b `maxmemory 512mb` when BullMQ state lands.

## Known Stubs

None — no stubs introduced. The N/A-locally dispositions ((h) healthchecks.io, §3c cron) are recorded absences on the ratified topology, not unwired placeholders.

## Next Phase Readiness

- **Phase 4 (worker cutover):** the schema the worker needs is live (outbox/write_guards/next_check_at/consecutive_failures + indexes), Redis is proven persistent and restart-supervised, and the release path (stamp once → migrate every release → verify) is exercised end-to-end. Revisit `maxmemory` when BullMQ state lands. The 03-03/03-08 hosting-story flag stands: planning must not lean on Neon-specific constraints until the operator confirms the long-term hosting topology.
- **Phase 5 OBS-03:** supersedes §3c (already dispositioned N/A-locally).
- **Phase 7:** auth-cutover deploy reuses this exact path + the rehearsal pipeline.
- **Runbook feedback (for the next runbook-touching phase):** the §3 step 1 tar command ships ~612 MB because `.next/cache`, `.planning/`, `.snapshots/` ride along — consider explicit excludes; and note the Git Bash `./`-prefix tar-path quirk in any future tarball-verification wording.

## Self-Check: PASSED

03-DEPLOY-RECORD.md exists at the plan-specified path and is committed (e8bd9be); Task 1 commit c960eb8 verified in git log; production state verified by direct probe (bookkeeping 2 rows, 11 public tables, redis PONG, pings 236); no stray untracked files beyond the pre-existing hygiene exclusions (skills-lock.json, .claude/skills/*, .planning/research/.cache/*, .playwright-mcp/, docker-compose.dev.yml, .env.test — untouched; .snapshots/* intentionally uncommitted).

---
*Phase: 03-redis-drizzle-schema-ownership*
*Completed: 2026-09-12*
