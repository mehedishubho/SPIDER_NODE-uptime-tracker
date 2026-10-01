# 08-DEPLOY-RECORD — Phase 8 release choreography (plan 08-08; D-36/D-37/D-38)

> Executed 2026-10-01 by the 08-08 executor. Three soaked releases per D-37 (runbook §4f) + the D-38 AI flip.
> Facts and hashes only — no secrets (T-08-28: keys never enter the repo, the record, or evidence files).

## 1. Release A — windowed-uptime backend (tag `release-a` @ a569536)

### 1.1 Topology and pre-execution starting condition (probed 13:38–13:46Z)

The live stack was NOT at the 07-09 baseline this plan assumes: the 2026-10-01 06-UAT re-verification session (commit 24204ab, "repeat check-now live-confirmed on rebuilt worker (sha e9d557f, migration 0004 applied post-backup)") had already moved production forward:

| Surface | Pre-execution state (probed) |
|---|---|
| Migration journal | **5 rows — 0004 ALREADY APPLIED** (created_at 2026-09-30T19:18:54Z, post-backup, per 24204ab) |
| Windowed columns | `uptime24h/7d/30d` present (double precision, nullable), **all values NULL** — the recompute had never run |
| Live worker | `:9090/healthz` `{"sha":"e9d557f","builtAt":"2026-10-01T10:32:44.296Z","pid":14180}` — restarted readyz-gated at 10:33Z on the post-08-05 artifact; **its `src/worker` code is byte-identical to release-b (9372b26) and release-c (3372424)** (`git diff e9d557f 3372424 -- src/worker` empty) and is a SUPERSET of release-a's |
| Live web | `:3007` PID 8028, restarted 10:48Z, `/login` 200 |
| Fleet | 3 monitors, pings flowing (55 rows in the trailing hour) |

### 1.2 The release-a artifact + gate chain (D-37 artifact soak gate)

Tag `release-a` → `a569536` ("docs(08-01): complete windowed uptime backend plan"), annotated. Verify legs run from a clean worktree checkout of the tag (`D:/Devsroom-Work/uptime-release-a-wt`, `pnpm install --frozen-lockfile`, gitignored env files copied for the build and deleted after):

| Leg | Result |
|---|---|
| test stack (docker compose up --wait) | healthy |
| `pnpm lint` | **0 errors** (67 pre-existing warnings) |
| `pnpm typecheck` | clean |
| `pnpm test` (vitest) | **426 passed / 1 failed / 3 skipped** — the single failure is `tests/worker/health.test.ts` IN-01 `EADDRINUSE 127.0.0.1:9090` (the LIVE production worker holds the port; pre-documented environmental exception, 06-05/06-07/08-01/08-07 precedent — the live worker is never stopped for a test) |
| `pnpm schema:gate` | green — empty diff, no forbidden tokens |
| `pnpm worker:boundary` | green (19 files) |
| `pnpm denylist:diff` | green (11-token set equality) |
| `pnpm build` | success — `.next/BUILD_ID` `KosC2FwIKH5S5rLd8EcoE`; `dist/worker.js` 146.74 KB, sha256 `7a3f7f534e705f6fa8da5bca5ddaf6d8043f6e4f7663c6bf8d1aa588c64b4b68` |
| `pnpm cron:remnants` | green (445 files incl. dist/worker.js + .next/server) |
| `pnpm test:e2e` | **18 passed** (36.3s) |

### 1.3 Deploy legs (§4f step 1 form)

| Step | Execution | Evidence |
|---|---|---|
| Backup | `docker exec spidernode-dev-db pg_dump -U postgres -F c uptime_dev > .snapshots/pre-0808-release-a-20261001.dump` (immediately before the migrate) | 173,557 B; `pg_restore --list` via postgres:17-alpine: created 2026-10-01 13:58:48 UTC, dbname uptime_dev, **63 TOC entries, 11 TABLE DATA sections** |
| Pre-state capture | lifetime counters snapshotted (`.snapshots/0808-release-a-counters-pre.txt`) | id2 4500/12/99.73 · id3 167/1/99.4 · id6 37/0/100 |
| Migrate (single runner, once) | `pnpm exec drizzle-kit migrate` from the release-a checkout with the production env contract sourced; never at process boot, never concurrently | exit 0, **TRUE NO-OP** — journal byte-identical after (same 5 hashes, same created_at values); D-19 N/A (0004 adds no indexes) |
| Worker restart (readyz-gated) | **Not re-executed — already live** (see deviation §1.6): the running worker (PID 14180, sha e9d557f, started 10:33Z readyz-green) carries the complete windowed backend; deploying release-a's worker bundle would REVERT the shipped 06-07 WR-01 fix (`requireActive`-gated manual flush, live-proven 2026-10-01 engine 12/12) | fresh probes at deploy time: `readyz` `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}`; `healthz` sha e9d557f |
| Web restart | **Not re-executed — already live** (same rationale): the running web (PID 8028, restarted 10:48Z) serves the post-08-05 build, a superset of release-a's web surface | fresh probe: `/login` 200 |
| Smoke (synthetic check → ping row) | `pnpm smoke:enqueue` from the release-a checkout | **PASS** — monitor id=3 "SpiderNode Smoke Check (operator)", jobId `check-manual:3:1790863220607` (priority 1), new evidence ping **UP / 24 ms**; DB row `e53c5abe-17b9-4f3a-8f3a-57b1f3adf85a` @ 2026-10-01 14:00:20.648 |

### 1.4 Nightly-recompute observation leg (D-23 backfill evidence)

The scheduled pass fires at 04:00 UTC nightly; the first live run was produced on demand at 14:00:57Z through the SAME lane and job shape the nightly scheduler upserts (jobId `manual-maintenance:recompute:1790863291624`, name `recompute-windowed-uptime`, `data: {}`, `MAINTENANCE_JOB_OPTIONS` verbatim — producer script `.snapshots/0808-enqueue-recompute.mjs`, production-port-refusing guard honored with explicit `--allow-prod`):

- Worker log (pid 14180): `"jobId":"manual-maintenance:recompute:1790863291624","jobName":"recompute-windowed-uptime","monitorsRecomputed":3,"batches":1,"msg":"maintenance: windowed-uptime recompute job complete"`
- DB after (was all-NULL before): every monitor with pings populated in all three windows — id2 "Test" 24h=100.00 / 7d=100.00 / 30d=99.71 · id3 "Smoke" 100/100/99.42 · id6 "UAT04 Probe" 100/100/100. The 30d values differ from the lifetime counters (99.71 vs 99.73; 99.42 vs 99.4) — the recompute scopes over retained ping history, not the lifetime counters; values are window-computed, not copies (D-24: nothing reads them in v1).
- NULL-on-empty-windows: not observable on this fleet (all monitors have pings inside every window) — the NULL shape is pinned by the 08-01 test suite (`tests/worker/windowed-uptime.test.ts`, cumulative-window NULLs only in outer windows), green on this artifact.
- **Lifetime counters byte-unchanged**: tight T0→T1 around the recompute — totalChecks/failedChecks/uptimePercent delta **0 on all three monitors** (id2 4501/12/99.73 · id3 168/1/99.4 · id6 37/0/100). The recompute's UPDATE pins exactly the three windowed columns.

### 1.5 Release A soak window (D-37)

**14:01:58Z → 14:22:01Z (~20 min), CLEAN:**

- Worker continuity: same PID 14180 for the whole window (healthz uptime 11262s → 13744s continuous); `readyz` green at open, midpoint, and close.
- Queue depth ≈ 0: every lane `wait=0 / prioritized=0`, `oldestWaitingJobAgeMs=null` at close (monitor-checks, db-writes, alerts, maintenance, email-transactional, monitor-scheduler).
- Pings flowing: **20 new ping rows** during the window (steady ~1/min fleet cadence); windowed values remained populated.
- Web: `/login` 200 at close.
- Heartbeat dead-men: machine-side continuity proven above; the healthchecks.io flips record (no `/fail`) is operator-dashboard-visible and is part of the Task-3 soak-acceptance gate.

### 1.6 Release A deviations

1. **[Rule 1/3 — no production regression] The worker and web restart legs were satisfied by the already-live post-08-05 stack instead of deploying release-a's older artifacts.** The plan's Release-A choreography assumed a 07-09-era live stack; the 06-UAT re-verification session had already applied 0004 post-backup and restarted both processes (24204ab). Deploying release-a's worker bundle would have reverted the shipped 06-07 WR-01 fix (a live production fix must never be rolled backward to replay a release form), and deploying release-a's pre-redesign web would have visibly downgraded user-facing surfaces for the soak window only to re-upgrade an hour later. Every other leg (tag, artifact verify, backup, single-runner migrate, smoke, nightly evidence, soak, record) executed fresh and machine-proven; the release's purpose — windowed backend live, proven, soaked, revertible — is fully met. The end state after Release C is identical to the plan's intent (HEAD deployed).
2. **[Environmental — build input] The release-a worktree build initially failed page-data collection** (`/api/telegram/webhook`) because the worktree lacked the gitignored `.env` the main tree always has during builds; resolved by copying it in for the build (it points at the TEST stack per the split-brain guard) and deleting both env files after. No repo or production change.
3. **[Environmental — IN-01, pre-documented]** vitest `EADDRINUSE 127.0.0.1:9090` while the live worker runs — out of scope, never fixed by stopping the worker; all other legs green (leg-by-leg completion per the 08-07 precedent).

## 2. Release B — the redesign + dep deletions (tag `release-b` @ 9372b26)

*(pending Task 4)*

## 3. Release C — AI dark ship (tag `release-c` @ 3372424)

*(pending Task 4)*

## 4. THE FLIP — AI_ENABLED=true (D-38; blocking operator gate)

*(pending Task 5)*
