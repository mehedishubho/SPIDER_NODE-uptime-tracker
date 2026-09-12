# Phase 3 production release — deploy record

> Plan 03-08 · Release SHA **2207f5e** (tarball `/tmp/uptime-tracker-2207f5e.tar.gz`, verified in pre-flight)
> Deployed 2026-09-12 18:37–18:46 UTC (~9 min local leg) · Executor-run under explicit operator delegation
> Runbook: `docs/DEPLOY-RUNBOOK.md` as amended 2026-09-12 (§3 + §3b/§3c/§3d).
> This file records outcomes only — never secrets, connection strings, or passwords (T-03-22).

## Topology — OPERATOR-RATIFIED DEVIATION: local-only stand-in release

The 03-03 recorded deviation (production data lives in the local docker container, not Neon/VPS)
was put to the operator at the Task 2 checkpoint. **Operator decision: local-only release**, with
mechanical execution delegated to the executor on this machine. Consequences recorded here:

| Leg | Runbook target | Actual (operator-ratified) |
|---|---|---|
| Database | VPS/Neon Postgres | **local `spidernode-dev-db`** (postgres:17-alpine, PostgreSQL 17.7, port 5454, db `uptime_dev`) — the ground-truth production data per 03-03 |
| Schema-apply URL | DIRECT unpooled string | `postgresql://postgres:postgres@localhost:5454/uptime_dev` — one-shot direct connection (dev credentials from docker-compose.dev.yml, non-secret) |
| Redis (§3b) | VPS apt `redis-server` + systemd | **dedicated local container `spidernode-prod-redis`** (redis:7-alpine 7.4.8, port 6391, loopback-published) mirroring the pinned conf directives; systemd supervision → `--restart unless-stopped` |
| §3c memory alert | VPS cron + healthchecks.io check | **N/A-locally** (no systemd cron / no check provisioned per operator decision; mechanism exists in runbook §3c for the VPS form) |
| App (§3 step 4) | VPS pm2 `uptime-tracker` | built app via `pnpm start` on port 3007 with release env on the command line (shell env wins over `.env`); no PM2 locally |
| Restart-survival (f) | `pm2 restart` | kill process + relaunch identical command |

Safety semantics preserved: backup before everything, stamp-before-migrate ordering, single
runner, forward-only, `.env` never read or edited (explicit env on the launch command).

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

**Pre-flight verdict: GREEN.**

### Pre-flight observations (runbook feedback, non-blocking)

- The §3 step 1 tar command as typed packs the whole working tree minus the typed excludes, so
  inert/untracked material rides along: `.next/cache` (the bulk of the 612 MB), `.planning/`,
  `.snapshots/` (contains the production dump — the operator's own data, but pointless to ship),
  `.agents/`, `.claude/`, `.playwright-mcp/`. Nothing shipped is secret (`.env*` is excluded) and
  extraction overlaying these dirs is harmless, but a future runbook amendment should consider
  `--exclude=.next/cache --exclude=.snapshots --exclude=.planning` to cut the artifact ~10×.
- The plan's tar-verification regex assumed bare tar paths (`^drizzle/`); packing with `.` from
  Git Bash yields `./drizzle/` prefixes. Cosmetic only — the machinery is verifiably inside.

## Pre-stamp state probe (safety check before any write)

| Probe | Expected | Observed |
|---|---|---|
| `drizzle` schema tables | 0 (never stamped) | 0 |
| worker-prereq tables (`write_guards`, `outbox`) | 0 (0001 not applied) | 0 |
| public tables | 9 (baseline set) | 9 |
| server version | PG 17 | PostgreSQL 17.7 |
| rows (users/monitors/pings) | 1/1/234 (rehearsal profile) | 1/1/234 |

## §3 step 2 — Backup (adapted: docker exec)

- **Command:** `docker exec spidernode-dev-db pg_dump -U postgres -F c uptime_dev > .snapshots/pre-release-2207f5e.dump`
- **Observed:** exit 0; **21,595 bytes** (byte-size identical to the 03-03/03-05 dumps — data
  unchanged since rehearsal); `pg_restore --list` (throwaway postgres:17-alpine) exit 0, 9 TABLE
  DATA entries. Result: **GREEN**.

## §3 step 3 — One-time baseline stamp + single-runner migrate

**Stamp (first Phase-3 release ONLY):**

- **Command:** `DATABASE_URL="postgresql://postgres:postgres@localhost:5454/uptime_dev" node scripts/stamp-baseline.mjs`
- **Observed:** exit 0; output `stamped 0000_baseline (created_at=1789218624104)` +
  `left pending for the runner (NOT stamped): 0001_worker-prereqs`
- **Bookkeeping after stamp:** exactly 1 row — hash
  `9b294622ecf0e9c41d53fed5d6437b6febde9ce11dcf28e5f84ba5cb15dd5030` (byte-identical to the
  committed journal anchor recorded in 03-03), `created_at=1789218624104` (the committed `when`).
  Result: **GREEN**.

**Migrate (run 1):**

- **Command:** `DATABASE_URL="postgresql://postgres:postgres@localhost:5454/uptime_dev" pnpm exec drizzle-kit migrate`
- **Observed:** exit 0, `migrations applied successfully`. Result: **GREEN**.

**Migrate (run 2 — idempotence proof):**

- **Observed:** exit 0; bookkeeping still exactly **2 rows** (one per committed migration — the
  runner row `04fb27a3d4a51ee09870a0412b2d76c5e605a8edd05d6b9183089c885319c85c`, `created_at`
  distinct from the stamp anchor, i.e. written by the runner, and byte-identical to sha256 of
  `drizzle/0001_worker-prereqs.sql` verified directly). 0001 applied exactly once; second run a
  no-op. Result: **GREEN**.

**Post-migrate spot-checks:**

| Check | Observed |
|---|---|
| worker-prereq tables | `write_guards` + `outbox` present; public count 11 (9+2) |
| `write_guards` columns | `key text`, `created_at timestamptz` |
| 0001 indexes | `idx_monitors_due`, `idx_outbox_unsent`, `incidents_one_ongoing` all present |
| backfill | monitor row: `next_check_at` NOT NULL, `consecutive_failures = 0` |
| data integrity | users 1 / monitors 1 / pings 234 — unchanged (rehearsal promise held) |

## §3b — Redis hardening (adapted: dedicated local container)

- **Command:** `docker run -d --name spidernode-prod-redis --restart unless-stopped -p 127.0.0.1:6391:6379 redis:7-alpine --requirepass <generated: openssl rand -hex 32, stored gitignored at .snapshots/spidernode-prod-redis.pass, never echoed> --appendonly yes --appendfsync everysec --maxmemory 512mb --maxmemory-policy noeviction`
- **Directive mapping (§3b step 2 → container):** `requirepass` ✓ (64-hex, on-disk only) ·
  `bind 127.0.0.1` → `-p 127.0.0.1:6391:6379` loopback-only publish ✓ · `protected-mode` →
  satisfied by requirepass (auth enforced) · `appendonly yes` + `appendfsync everysec` ✓ ·
  `maxmemory 512mb` (536,870,912 bytes confirmed via CONFIG GET) ✓ · `maxmemory-policy
  noeviction` ✓ · `supervised systemd` → docker supervision + `--restart unless-stopped`
  (boot-survival analog) ✓. Dedicated container; the 6390 test-stack redis was NOT reused.

| # | Verification (§3b step 5) | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | `redis-server --version` | 7.x (A1) | Redis server v=7.4.8 (build 3235b498) | GREEN |
| 2 | PING with password | PONG | PONG | GREEN |
| 3 | PING without password | NOAUTH | `NOAUTH Authentication required.` | GREEN |
| 4 | `CONFIG GET maxmemory-policy` | noeviction | noeviction | GREEN |
| 5 | CONFIG GET maxmemory/appendonly/appendfsync | 512mb / yes / everysec | 536870912 / yes / everysec | GREEN |
| 6 | supervised restart → PONG | PONG after restart | `docker restart` → PONG | GREEN |
| 7 | AOF persistence across restart | counter survives | limiter counter survived redis restart with value intact (see (g)) | GREEN |

## §3c — Redis 70% memory alert

**N/A-locally** (operator decision): the §3c mechanism is VPS-form (systemd cron + a dedicated
healthchecks.io check). Neither exists on the local stand-in topology. The typed procedure
remains in runbook §3c for the VPS form; superseded by Phase 5 OBS-03 regardless.

## §3 step 4 — Ship, install, reload (adapted: local launch)

- **Command (launch):** `REDIS_URL="redis://:<pass>@127.0.0.1:6391" DATABASE_URL="postgresql://postgres:postgres@localhost:5454/uptime_dev" NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm start` (built release artifact from pre-flight; explicit env wins over `.env`; `.env` never read or edited)
- **Observed:** port 3007 free before launch → app up (`✓ Ready in 147ms`, Next.js 16.3.1);
  `REDIS_URL` present in the launch environment BEFORE first boot (no module-load throw — the
  app booted clean against the hardened Redis). Result: **GREEN**.

## §3 step 5 — Typed post-deploy checks (a)–(i)

| # | Check | Expected | Observed | Result |
|---|---|---|---|---|
| (a) | login page | HTTP 200 | **200** (first launch and again after the restart-survival relaunch) | GREEN |
| (b) | process online (pm2 → node locally) | serving, not crash-looping | serving 200s throughout; both launches clean | GREEN |
| (c) | startup logs clean | no startup errors | `Ready in 147ms`; zero error/unhandled/exception lines | GREEN |
| (d) | no `[redis-limiter] DEGRADED` | 0 matches in logs | **0 matches** in both launch logs | GREEN |
| (e) | limiter counters in Redis | db0 keys>0 with `rl:*` after one rate-limited request | request 1 → 400 (limiter counted before validation, no user created); `db0:keys=1,expires=1`; key `rl:register_::ffff:127.0.0.1` = 1, TTL ≈ 3593 s | GREEN |
| (f) | restart-survival (criterion 1) | requests 2–5 non-429 after restart; **6th window request → 429** | request 1 (400) → kill app (port verified free; counter still =1 in Redis) → relaunch identical command → requests 2–5 → **400** each → **request 6 → 429** with `x-ratelimit-remaining: 0`, body "Too many registration attempts…"; counter = 6 in Redis afterward. An in-memory limiter would have reset at the kill and served all six | GREEN |
| (g) | Redis restart survival (RDS-03) | enabled unit / supervised restart → PONG | `docker restart spidernode-prod-redis` → **PONG**; limiter counter **survived the Redis restart at value 6** (AOF everysec persistence proven) | GREEN |
| (h) | healthchecks.io | memory check fresh; app heartbeat no /fail | **N/A-locally** (operator decision — no checks provisioned on the local topology) | N/A |
| (i) | monitoring sanity | monitors keep checking on schedule | cron engine untouched and live: 3 check cycles fired on the 1-minute schedule; batcher flush wrote 2 new pings (`234 → 236`, both UP, at :43:00 and :44:00 exactly on schedule) into the **migrated** database | GREEN |

## Cleanup (as instructed)

- App server stopped; port 3007 verified free.
- **Kept:** `spidernode-prod-redis` (running, loopback 6391), `.snapshots/pre-release-2207f5e.dump`,
  `.snapshots/spidernode-prod-redis.pass` (gitignored, mode 600).
- No down-migration performed at any point (forward-only).

## Deviations and dispositions

| # | Deviation | Disposition |
|---|---|---|
| 1 | **Local-only stand-in release** — no VPS/Neon/PM2; DB leg on local `spidernode-dev-db`, Redis leg on a dedicated local container, app leg via `pnpm start` | **Operator-ratified at the Task 2 checkpoint** ("Local only" + explicit delegation). Consistent with the 03-03 recorded ground truth (production data lives in the local container). §3's safety semantics preserved verbatim: backup → stamp → single-runner migrate → forward-only, Redis hardened before app boot, REDIS_URL in the launch env before first boot |
| 2 | §3c (memory alert cron + healthchecks.io check) and §3b's apt/systemd/`supervised systemd` form | **N/A-locally per operator decision**; container mirrors every applicable pinned directive (requirepass/loopback/AOF-everysec/512mb/noeviction) with `--restart unless-stopped` as the supervision analog; §3c's typed procedure remains in the runbook for a future VPS form |
| 3 | §3b `bind 127.0.0.1` realized as `-p 127.0.0.1:6391:6379` (loopback-only publish) | Faithful docker adaptation of the same network restriction (D-18) |
| 4 | (b)/(c) runbook checks reference pm2; local run has no PM2 | Adapted to node-process equivalents (serving 200s, clean logs); recorded per-check |
| 5 | MSYS path mangling broke `pg_restore --list` inside `docker run` (container path `/dump` translated to a Windows path) | Retried with `MSYS_NO_PATHCONV=1` + `pwd -W` — exit 0. Note for any future Git Bash docker volume command |

## Timings

| Milestone | Time (UTC) |
|---|---|
| Pre-flight verify green (28.6 s warm chain) | 2026-09-12 ~18:11 |
| Backup taken + verified | 18:37 |
| Baseline stamped | 18:38 |
| 0001 applied (run 1) + no-op proof (run 2) | 18:39 |
| Redis stand-in up + verified | 18:39–18:40 |
| App launch (first) + checks (a)–(e) | 18:41 |
| Restart-survival proof (f) | 18:42–18:43 |
| Redis supervised-restart proof (g) | 18:44 |
| Monitoring sanity window (i) — pings 234→236 | 18:43–18:45 |
| Cleanup (app stopped, port free) | 18:46 |
| **Total local deploy leg** | **~9 minutes** |

## Verdict

**RELEASE GOOD.** Schema-apply gate (production leg) closed: stamped baseline + 0001 through the
single runner, idempotence proven, data intact. Redis hardened (stand-in form) and proven across
both a process restart (limiter window survives — criterion 1: the 6th window request 429) and a
Redis restart (AOF persistence — RDS-03's supervised-restart + persistence clauses). Monitoring
continuity observed on schedule through the deploy. The (a)–(i) transcript above is the phase's
production evidence; §3c's VPS form and the literal systemd `enable` remain recorded as the
operator's N/A-locally disposition.
