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

### 1.7 Task-3 operator gate — RESOLVED (proceed-b)

Release A soak **ACCEPTED**; proceed to Release B. Operator **mehedishubho**, 2026-10-01, response verbatim: **"use recommand"** (= the recommended option `proceed-b`). Recorded per the 05-08 D-18 / 06-05 precedent (gate, operator, date, verdict).

### 1.8 Interlude — stack-down event + Rule-3 restoration legs (14:47–14:55Z, before Release B)

At probe time 14:49:27Z the live stack was found **completely down**: zero node processes (no worker on :9090, no web on :3007; `netstat` empty for both). Docker Desktop had bounced ~14:48Z (all four containers `Up 3–4 minutes`), and the node processes — plain processes hosted by prior session shells on the local stand-in topology — died with their host shells around the same event. Last successful check before the gap: **14:39:41Z**; monitoring interrupted ≈ 15 min (the healthchecks.io dead-men page operator-side; machine-side continuity was unprovable with the processes gone). No release artifact was implicated — the Release A soak had closed clean at 14:22:01Z.

Restoration (Rule 3 — active monitoring outage; restore service first, prove artifacts after):

| Leg | Execution | Evidence |
|---|---|---|
| Worker restore | started 14:54Z from the main tree's on-disk bundle (`dist/worker.js` sha256 `0f3b356b…`, built 13:22:53Z during the 08-07 verify — its `src/worker` is byte-identical to release-b/c by the §1.1 proof), `0707-prod-worker-env.sh` contract sourced | `readyz` `{"ok":true,…}` first poll; `healthz` `{"sha":"e2f7393","builtAt":"2026-10-01T13:22:53.335Z","pid":2840}`; checks staging within seconds |
| Web restore | started 14:55Z from the main tree's `.next` (built 13:22Z, post-08-07 code — with the flag off it renders identically to release-b's web; its full verify chain ran green at 13:1x–13:3xZ in 08-07 Task 3), contract sourced (launcher exports beat the ambient `.env`) | `/login` **200** |
| Flow proof | pings resumed | first restored checks land 14:54:22Z; fleet cadence steady thereafter |

Release B's own deploy legs (below) then ran per the §4f form from the release-b artifacts, restoring clean tag provenance (`healthz` sha `9372b26`).

## 2. Release B — the redesign + dep deletions (tag `release-b` @ 9372b26)

Tag `release-b` created this leg (annotated → `9372b26`, "docs(08-09): complete tier-2 sweep + sidebar reconciliation plan"). Gate + deploy from a clean worktree checkout (`D:/Devsroom-Work/uptime-release-b-wt`, `pnpm install --frozen-lockfile` 8.1 s; the gitignored `.env` + `.env.production` copied in for the build per §4f and **retained for runtime** — the prior main-tree-hosted web always loaded the ambient `.env` alongside the sourced contract, so feature parity requires them; gitignored, never committed).

### 2.1 Artifact gate (D-37 — remnant gates armed with the deletions)

| Leg | Result |
|---|---|
| `pnpm verify` in-chain prefix | lint **0 errors**, typecheck clean, vitest **429 passed / 1 failed / 3 skipped** — the single failure is `tests/worker/health.test.ts` IN-01 `EADDRINUSE 127.0.0.1:9090` (the RESTORED live worker holds the port; pre-documented environmental exception, §1.2/§1.6-3 lineage); the chain halted at the failing vitest leg per pnpm semantics, remaining legs run individually per the 08-07 deviation-4 precedent |
| `pnpm schema:gate` | green — empty diff, no forbidden tokens |
| `pnpm worker:boundary` | green (19 files) |
| `pnpm denylist:diff` | green (11-token set equality) |
| `pnpm build` | success — `.next/BUILD_ID` `ezYkCmZqj6__tZ7r2ahII`; `dist/worker.js` 150,902 B, sha256 `90213c996199dcf7dbeb62b96d7d5da5d68e41f47779e9f5b2b4e1f3f3d8b33d` |
| `pnpm cron:remnants` | green — **456 files** incl. `dist/worker.js` + `.next/server`: "no Phase-8 icon/dialog remnants" — **the D-37 dep deletions proven to stay out on the shipped artifact** |
| `pnpm test:e2e` | **50 passed** (3.2 m) incl. `dashboard-redesign.spec.ts` + `light-mode.spec.ts` — **both themes machine-verified on the exact artifact** (token-resolved computed colors + in-page WCAG contrast in forced light) |

### 2.2 Deploy legs (§4f step 2 form)

| Step | Execution | Evidence |
|---|---|---|
| Backup | `docker exec spidernode-dev-db pg_dump -U postgres -F c uptime_dev > .snapshots/pre-0808-release-b-20261001.dump` | 175,421 B; archive verified via postgres:17-alpine: created 2026-10-01 14:56:42 UTC, dbname uptime_dev, TOC 63, **11 TABLE DATA sections** |
| Pre-state capture | counters snapshotted (`.snapshots/0808-release-b-counters-pre.txt`) | id2 4534/12/99.74 · id3 170/1/99.41 · id6 46/0/100 |
| Migrate (single runner, once) | `pnpm exec drizzle-kit migrate` from the release-b checkout with the production env contract sourced | exit 0, **TRUE NO-OP** — journal unchanged at **5 rows** (0004 already applied; the release range adds no migration) |
| Worker restart (readyz-gated) | guarded kill — PID 2840 on :9090, cmdline verified `dist/worker` — then `node dist/worker.js` started from the release-b worktree, contract sourced from the main-tree cwd (its pass-file reads are relative) | `readyz` green on first poll `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}`; `healthz` **`{"sha":"9372b26","builtAt":"2026-10-01T14:59:20.596Z","pid":23128}`** — D-10 provenance = the release tag |
| Web restart | guarded kill — PID 27944 on :3007, cmdline verified next/pnpm — then `pnpm start` from the release-b worktree, contract sourced | `/login` **200** on first poll; `/` **200** |
| Smoke (synthetic check → ping row) | `pnpm smoke:enqueue` from the release-b checkout | **PASS** — monitor id=3 "SpiderNode Smoke Check (operator)", jobId `check-manual:3:1790867092431` (epoch 15:04:52Z, priority 1), new evidence ping **UP / 24 ms** |

### 2.3 Both-theme visual spot-check leg (§4f Release B)

Machine-verified on the shipped artifact: the 50-test e2e run above includes the tier-1 dashboard redesign spec AND the 7-test light-mode suite (token-resolved computed colors + in-page contrast in forced light, on the token substrate); public surfaces answer 200 post-deploy. The subjective visual pass (does the redesign LOOK intentional in both themes on real pages) is operator-visible now and rides the Task-5 blocking gate where the operator is present — recorded here as the machine/human split per the 06-05 §12 precedent.

### 2.4 Release B soak window (D-37)

**Opened 15:05:38Z → closed 15:26:26Z (~21 min), CLEAN:**

- Worker continuity: same PID 23128 (sha 9372b26) for the whole window (healthz uptime 95.8 s → 1344 s continuous); `readyz` green at open, midpoint (15:07:03Z, 15:11:03Z), and close.
- Queue depth ≈ 0 at close: every lane `wait=0 / prioritized=0`, `oldestWaitingJobAgeMs=null` (monitor-scheduler, monitor-checks, db-writes, alerts, maintenance, email-transactional).
- Pings flowing: **19 new ping rows** during the window; windowed columns remained populated throughout.
- Counters advance naturally with checks only (id2 4534 → 4557, id3 170 → 172, id6 46 → 51; failures unchanged) — no redesign-era anomaly.
- Web: `/login` 200 at open, midpoint, and close.
- D-37 gate: green — the Release C deploy legs begin only after this close.

## 3. Release C — AI dark ship (tag `release-c` @ 3372424)

*(pending Task 4)*

## 4. THE FLIP — AI_ENABLED=true (D-38; blocking operator gate)

*(pending Task 5)*
