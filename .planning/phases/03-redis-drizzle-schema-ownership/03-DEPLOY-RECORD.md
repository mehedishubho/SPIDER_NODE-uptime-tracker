# Phase 3 production release — deploy record

> Plan 03-08 · Release SHA **2207f5e** · Record started 2026-09-13 (dev-machine pre-flight)
> Runbook: `docs/DEPLOY-RUNBOOK.md` as amended 2026-09-12 (§3 + §3b/§3c/§3d).
> This file records outcomes only — never secrets, connection strings, or passwords (T-03-22).

## Topology note (to be confirmed by the operator at the deploy checkpoint)

The 03-03 recorded deviation says the current ground truth for "the production database" is the
local docker container `spidernode-dev-db` (PostgreSQL 17.7, port 5454, db `uptime_dev`) on the
dev machine — not Neon, and possibly not a VPS-hosted database at all. The operator confirms at
the Task 2 checkpoint which host each leg runs against:

- **schema-apply leg** (backup / stamp / migrate): runs against whatever host currently holds the
  live monitoring data, using the DIRECT unpooled URL `pg_dump`/`psql` would use (runbook §3
  step 3 deviation note).
- **app leg** (ship / install / pm2 reload / Redis hardening / typed checks): runs on the app
  host (the VPS per the runbook, or wherever the operator runs PM2).

**Operator answer:** *(pending — recorded at checkpoint)*

## Pre-flight (Task 1 — dev machine, executor-run)

| # | Check | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | `pnpm verify` on release commit 2207f5e | exit 0, ≤ 5 min warm (D-20) | exit 0, **28.6 s warm**; 114 vitest passed, schema:gate green, build compiled, 18 e2e passed | GREEN |
| 2 | Rehearsal evidence file (DRZ-06 gate) | newest `03-REHEARSAL-EVIDENCE-*.md` present, PASS, counts/digests equal, additive-only delta | `03-REHEARSAL-EVIDENCE-20260912.md` — verdict PASS; 9 tables counts+digests EQUAL (carve-out labeled: digest over pinned pre-migration column inventory); DDL delta additive-only (+7/−0 pg_dump statements; removed tables/columns/indexes: none); journal rows 2; D-19 timings recorded | GREEN |
| 3 | Runbook sections the operator follows | §3b, §3c, §3d present; §3 step 3 activated (stamp + single runner); §3 step 5 checks (a)–(f) incl. corrected restart-survival arithmetic | all grep-verified: §3b/§3c/§3d headers ×1 each; `stamp-baseline` ×2; limiter-degradation check present; `6th request in the 5-per-hour window` ×1 (runbook supersedes older "5th" plan text) | GREEN |
| 4a | Release tarball packed per §3 step 1 | exists, non-empty, SHA-named | `/tmp/uptime-tracker-2207f5e.tar.gz`, 612,003,150 bytes | GREEN |
| 4b | drizzle/ tree inside tarball | 0000_baseline.sql + 0001_worker-prereqs.sql + meta/_journal.json | all listed (`./drizzle/…` paths) | GREEN |
| 4c | configs + scripts inside tarball | drizzle.config.ts, drizzle.gate.config.ts, scripts/{stamp-baseline,anonymize-snapshot,rehearse-migrations,schema-gate}.mjs | all 6 listed | GREEN |
| 4d | drizzle-kit ships in the --prod install (D-08) | package.json in tarball lists drizzle-kit among `dependencies` | `"drizzle-kit": "^0.31.10"` (line 33, dependencies block) | GREEN |
| 4e | generated Prisma client inside (D-14) | non-zero `src/generated/prisma` entries | 23 entries | GREEN |
| 4f | no `.env*` shipped | zero matches | 0 matches | GREEN |

**Pre-flight verdict: GREEN — cleared to hand the release to the operator.**

### Pre-flight observations (runbook feedback, non-blocking)

- The §3 step 1 tar command as typed packs the whole working tree minus the typed excludes, so
  inert/untracked material rides along: `.next/cache` (the bulk of the 612 MB), `.planning/`,
  `.snapshots/` (contains the production dump — the operator's own data, but pointless to ship),
  `.agents/`, `.claude/`, `.playwright-mcp/`. Nothing shipped is secret (`.env*` is excluded) and
  extraction overlaying these dirs is harmless, but a future runbook amendment should consider
  `--exclude=.next/cache --exclude=.snapshots --exclude=.planning` to cut the artifact ~10×.
- The plan's tar-verification regex assumed bare tar paths (`^drizzle/`); packing with `.` from
  Git Bash yields `./drizzle/` prefixes. Cosmetic only — the machinery is verifiably inside.

## §3 step 2 — Backup (operator)

| Field | Value |
|---|---|
| Command | `pg_dump "$DATABASE_URL" -F c -f /var/backups/uptime/pre-release-2207f5e.dump` (or the docker-exec form per the recorded deviation, on whichever host holds production) |
| Expected | exit 0, non-empty dump |
| Observed | *(pending)* |
| Result | *(pending)* |

## §3b — Redis install + hardening (operator, one-time)

| # | Step | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | `sudo apt update && sudo apt install redis-server` | `redis-server --version` prints (record the line); ActiveState `active` | *(pending)* | *(pending)* |
| 2 | Conf backup + the eight pinned lines (supervised systemd / bind 127.0.0.1 / protected-mode yes / requirepass / appendonly yes / appendfsync everysec / maxmemory 512mb / maxmemory-policy noeviction) | grep shows all eight with pinned values; `.bak` exists | *(pending)* | *(pending)* |
| 3 | `systemctl restart` + `enable redis-server` | ActiveState `active`; `is-enabled` → `enabled` | *(pending)* | *(pending)* |
| 4 | `REDIS_URL=redis://:<password>@127.0.0.1:6379` into app `.env` BEFORE any pm2 restart | `grep -c '^REDIS_URL=' .env` prints 1 | *(pending)* | *(pending)* |
| 5 | Service verification | PONG behind requirepass; unauthenticated ping → NOAUTH; `CONFIG GET maxmemory-policy` → noeviction; PONG again after one `systemctl restart` (supervised restart) | *(pending)* | *(pending)* |

## §3c — Redis 70% memory alert (operator, one-time)

| # | Step | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | Provision dedicated healthchecks.io check (e.g. `redis-memory-vps`, Period 5 min, short grace) | check exists in dashboard; ping URL at hand | *(pending)* | *(pending)* |
| 2 | Install `/usr/local/bin/redis-memory-check.sh` (root:root, 700) | manual run exits 0; check shows a fresh ping | *(pending)* | *(pending)* |
| 3 | Cron every 5 minutes (root crontab or /etc/cron.d) | entry lists; Last Ping advances within 5 min | *(pending)* | *(pending)* |
| 4 | Both-branch verification | real run → fresh ping; `THRESHOLD_PCT=0` copy in /tmp → no ping | *(pending)* | *(pending)* |

## §3 step 3 — One-time baseline stamp + single-runner migrate (operator)

| Field | Value |
|---|---|
| Stamp (first Phase-3 release ONLY) | `DATABASE_URL="<DIRECT unpooled string>" node scripts/stamp-baseline.mjs` from the app dir, after extracting the tarball, before any reload |
| Expected (stamp) | prints `stamped 0000_baseline`; bookkeeping shows one row per committed migration: `SELECT hash, created_at FROM drizzle.__drizzle_migrations;` |
| Observed (stamp) | *(pending)* |
| Migrate (every release) | `pnpm exec drizzle-kit migrate` — exit 0, applies 0001 exactly once |
| Migrate idempotence | second invocation → no-op, exit 0 |
| Observed (migrate) | *(pending)* |
| Result | *(pending)* |

## §3 step 4 — Ship, install, reload (operator)

| Field | Value |
|---|---|
| Actions | scp tarball → extract over app dir → `pnpm install --frozen-lockfile --prod` → (REDIS_URL already in .env from §3b step 4) → `pm2 restart uptime-tracker` |
| Expected | `pm2 ls` online; `curl -fsS http://127.0.0.1:3007/login` → 200 |
| Observed | *(pending)* |
| Result | *(pending)* |

## §3 step 5 — Typed post-deploy checks (a)–(i)

| # | Check | Expected | Observed | Result |
|---|---|---|---|---|
| (a) | `curl -fsS` login page (https app-url or `http://127.0.0.1:3007/login`) | HTTP 200 | *(pending)* | *(pending)* |
| (b) | `pm2 status` | uptime-tracker `online`, not restart-looping | *(pending)* | *(pending)* |
| (c) | `pm2 logs uptime-tracker --lines 50` | no startup errors | *(pending)* | *(pending)* |
| (d) | same 50 lines | zero `[redis-limiter] DEGRADED` matches | *(pending)* | *(pending)* |
| (e) | one rate-limited request then `INFO keyspace` | `db0` keys>0 (`rl:*` counters) | *(pending)* | *(pending)* |
| (f) | restart-survival proof: register POST ×1 → `pm2 restart` → ×5 more | first four post-restart POSTs non-429; the **6th window request returns 429** (runbook arithmetic — limit 5/h) | *(pending)* | *(pending)* |
| (g) | `systemctl is-enabled redis-server` + one more restart + PING | `enabled`; PONG after supervised restart | *(pending)* | *(pending)* |
| (h) | healthchecks.io | redis-memory check fresh pings; app heartbeat shows no `/fail` during the deploy window | *(pending)* | *(pending)* |
| (i) | monitoring sanity over ~10 min | existing monitors keep checking on schedule | *(pending)* | *(pending)* |

## Deviations and dispositions

*(recorded as reported — none yet)*

## Timings

| Milestone | Time |
|---|---|
| Pre-flight verify green | 2026-09-13T00:11 (dev, 28.6 s warm chain) |
| Operator deploy started | *(pending)* |
| Operator deploy complete | *(pending)* |
| Post-deploy checks (a)–(i) green | *(pending)* |
