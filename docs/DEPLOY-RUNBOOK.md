# SpiderNode — Deploy Runbook

> **Date:** 2026-09-09
> **Audience:** the operator executing a release on the production VPS — written to be followed mid-deploy, without reading any other document first.
> **Scope:** every release of this milestone (backend modernization), from Phase 2 foundations through the final visual redesign.
> **Status:** design-stage runbook — no corresponding code exists yet. Steps marked worker/`readyz` apply from Phase 4 onward (see topology table). Each step is verified live from Phase 2 onward and corrected here when reality disagrees.
> **Companion document:** [ARCHITECTURE-AUDIT.md](./ARCHITECTURE-AUDIT.md) — all design rationale lives there, not here (D-01/D-03). This document contains ordering, verification, and rollback only.
> **Amended 2026-09-09 (fix cycle):** §1/§2/§3/§4/§5 amended and §4a added — the Migrate step is phase-conditional (WR-03), the PM2 ready handshake names the process signal (WR-04), the first worker release has its own path (WR-05), and the steady-state budget is stated as ≤ 30 (IN-05 runbook half).

---

## 1. Connection budget (memorize these three numbers)

| Process | Pool `max` | Connection string |
|---|---|---|
| **web** (PM2 `uptime-tracker`, port 3007) | **10** | **POOLED** (provider pooler endpoint) |
| **worker** (PM2 `uptime-worker`, from Phase 4) | **20** | **DIRECT** |
| **migration runner** (deploy pipeline, one-shot) | **1** | **DIRECT** |

Operational summary — **web 10 / worker 20 / migrations 1**; steady-state total ≤ 30 connections (web 10 + worker 20), rising to ≤ 31 only during deploys while the single one-shot migration runner is connected. Full spec (pool options, timeouts, pooled-vs-direct rationale, Neon limits): audit [§25](./ARCHITECTURE-AUDIT.md).

During a release, keep `psql` and dashboard sessions to a minimum: web 10 / worker 20 / migrations 1 leaves ≥ 70 % headroom against Neon's ~104 `max_connections` (assumption A4 — verify the project's tier before Phase 3).

---

## 2. Deploy topologies at a glance

Two orderings exist this milestone. Pick by phase, then follow the numbered steps for that topology exactly (D-04).

| Step | Interim topology (Phases 2–3, single PM2 app) | Target topology (Phase 4+, two PM2 apps) |
|---|---|---|
| **1** | Build (web from one SHA) | Build (web **and** worker from one SHA) |
| **2** | Backup (`pg_dump`) + rehearsal | Backup (`pg_dump`) + rehearsal |
| **3** | Migrate — Phase 2: no migrate step (CI `prisma db push` is still the live schema mechanism); Phase 3+: single runner (`drizzle-kit migrate`) | Migrate (single runner) |
| **4** | — | **Restart worker → wait for `readyz`** |
| **5** | Restart web | Restart web |
| **6** | Smoke check | Smoke check (synthetic check → ping row) |

In every release the migration runs **before** any process restart, and in the target topology the **worker gates the release**: proceed to the web restart only after `:9090/readyz` passes.

---

## 3. Interim topology (Phases 2–3) — single PM2 app

`uptime-tracker` (web) is the only PM2 app. No worker exists yet; skip every worker/`readyz` step.

1. **Build.**
   - *Action:* from the release commit, run the CI pipeline: `pnpm install --frozen-lockfile` → lint → typecheck → test → `pnpm build`. Package the artifact (`.next` output) tagged with the commit SHA.
   - *Verification:* every gate exits 0; the artifact exists and carries the SHA.
   - *Rollback:* abort the release — nothing has touched production yet.
2. **Backup.**
   - *Action:* on the VPS, take a full database backup: `pg_dump "$DATABASE_URL" -F c -f /var/backups/uptime/pre-release-<SHA>.dump`. Before any cutover-adjacent release (schema or auth changes), rehearse the release first against an anonymized local copy of that snapshot (restore → run migration → run smoke check locally).
   - *Verification:* `pg_dump` exits 0; the dump file is non-empty; the rehearsal completed with the smoke check passing.
   - *Rollback:* abort the release — production data is unchanged. (No rollback action is ever taken against the dump itself; it is retained as the restore point of last resort.)
3. **Migrate (phase-conditional — check which phase you are releasing).**
   - *Action:* **Phase 2 releases: run no migrate command in this step.** No migration runner exists yet — schema changes still flow through the existing CI schema step (`prisma db push` in the deploy pipeline, as deployed today), which the Phase 3 baseline PR removes (audit §24 step 3); do not run it ad hoc from this runbook. **Phase 3 onward: run the single migration runner from the deploy pipeline — one runner, once:** `pnpm drizzle-kit migrate`. Never run migrations at process boot; never run two runners concurrently (concurrent boot = concurrent DDL is forbidden, M-1). If no migrations are pending, the command is a no-op that exits 0.
   - *Verification:* Phase 2 — the CI schema step (`prisma db push`) exited 0 in the build pipeline; nothing else to check here. Phase 3+ — command exits 0; the migrations journal shows the release's entries; the empty-diff check (`drizzle-kit` diff against the live database) reports no drift (M-3).
   - *Rollback:* do not run down-migrations inside the verification window. Migrations are forward-only, additive-first (§7): restore the previous release tarball and restart — the previous code runs against the expanded schema.
4. **Restart web.**
   - *Action:* deploy the new tarball to `/var/www/uptime-tracker`, then `pm2 restart uptime-tracker`.
   - *Verification:* `pm2 ls` shows the app `online`; `curl -fsS http://127.0.0.1:3007/login` returns HTTP 200.
   - *Rollback:* restore the previous release tarball and `pm2 restart uptime-tracker` again; re-verify the 200.
5. **Smoke check (interim form — web serving).**
   - *Action:* `curl -fsS http://127.0.0.1:3007/login` and confirm the page renders; confirm the healthchecks.io heartbeat for the app has resumed (no `/fail` ping fired during the restart window).
   - *Verification:* HTTP 200 within 30 s of the restart; heartbeat green.
   - *Rollback:* if the smoke check fails, restore the previous release tarball, restart, and repeat this check. If it still fails, stop and escalate — do not attempt schema changes under pressure.

---

## 4. Target topology (Phase 4+) — two PM2 apps

`uptime-tracker` (web) + `uptime-worker` (worker). The worker restart and `readyz` wait are inserted **before** the web restart — the worker gates the release (D-04/P-1).

Health surfaces (worker, port 9090): `GET :9090/healthz` = process alive only. `GET :9090/readyz` = process alive **and** Redis ping passes **and** database ping passes. Only `readyz` passing means the worker can take traffic.

Two distinct readiness signals exist, and PM2 watches only the first: the worker must emit the **PM2 ready signal** — a `process.send('ready')` call — once its Redis and DB pings pass, i.e. exactly when `readyz` would return success. The HTTP `readyz` endpoint remains the operator/CI gate; the process ready signal is the PM2 gate (§5 `wait_ready`). An implementer who wires only the HTTP server never signals PM2: with `wait_ready` set, PM2 force-restarts the worker after `listen_timeout` on every boot — a crash loop in the process that gates every Phase 4+ release.

1. **Build.**
   - *Action:* from the release commit, run the CI pipeline (lint → typecheck → test → `pnpm build`) producing **both** artifacts from one SHA: `.next` (web) and `worker/dist/index.js` (worker). Tag both with the commit SHA.
   - *Verification:* every gate exits 0; both artifacts exist and carry the same SHA.
   - *Rollback:* abort the release — nothing has touched production yet.
2. **Backup.**
   - *Action:* on the VPS, take a full database backup: `pg_dump "$DATABASE_URL" -F c -f /var/backups/uptime/pre-release-<SHA>.dump`. For cutover-adjacent releases, rehearse against an anonymized local copy of that snapshot first (restore → migrate → worker restart → `readyz` → smoke check locally).
   - *Verification:* `pg_dump` exits 0; the dump file is non-empty; the rehearsal completed with `readyz` and the smoke check passing.
   - *Rollback:* abort the release — production data is unchanged.
3. **Migrate.**
   - *Action:* run the single migration runner from the deploy pipeline: `pnpm drizzle-kit migrate` — never at web or worker boot, never concurrently (M-1). No pending migrations ⇒ no-op exiting 0.
   - *Verification:* command exits 0; journal shows the release's entries; the empty-diff check reports no drift (M-3).
   - *Rollback:* no down-migrations inside the verification window — restore the previous tarball pair and restart both apps (additive-only schema, §7).
4. **Restart worker, then wait for `readyz`.**
   - *Action:* deploy the new worker tarball, then `pm2 restart uptime-worker`. Poll `curl -fsS http://127.0.0.1:9090/readyz` until it passes. **Do not proceed to the web restart until `readyz` passes.** (This restart form applies from the **second** worker release onward — the first registration of the app follows §4a, not this step.)
   - *Verification:* `pm2 ls` shows `uptime-worker` `online`; `readyz` returns success (Redis ping + DB ping both green); `healthz` alone is not sufficient.
   - *Rollback:* restore the previous worker tarball, `pm2 restart uptime-worker`, and re-check `readyz`. Only if the previous worker also fails `readyz` treat it as an infrastructure fault (Redis/Postgres), not a release fault — stop and escalate.
5. **Restart web.**
   - *Action:* deploy the new web tarball to `/var/www/uptime-tracker`, then `pm2 restart uptime-tracker`.
   - *Verification:* `pm2 ls` shows the app `online`; `curl -fsS http://127.0.0.1:3007/login` returns HTTP 200.
   - *Rollback:* restore the previous web tarball and restart; re-verify the 200.
6. **Smoke check (target form — synthetic check through the queue).**
   - *Action:* enqueue **one** synthetic check against a known-good target (the dedicated smoke-test monitor), then query the database and assert the new ping row appears for that monitor.
   - *Verification:* a `pings` row for the synthetic monitor exists with a timestamp after the enqueue, within one check interval. The release counts as good only when this row appears **and** `readyz` stayed green.
   - *Rollback:* if no ping row appears (or `readyz` flipped), restore the previous web **and** worker tarballs, restart worker first (`readyz`) then web, and repeat the smoke check. If it still fails, restore the database from the pre-release dump taken in step 2 and escalate.

---

## 4a. First worker release (Phase 4 cutover)

The first release that introduces `uptime-worker` is not a restart: the app does not exist in PM2 yet, there is no previous worker tarball, and the old monitoring path must stay live until the new one has proven continuity (audit M3 — this is the highest-risk release of the milestone). §4 step 4's `pm2 restart` form applies from the **second** worker release onward; this subsection is the complete path for the **first** release only. §4 steps 1–3 (build, backup, migrate) and the §4 step 6 smoke check run unchanged around it.

1. **Register and start the worker — never `pm2 restart`.**
   - *Action:* deploy the worker artifact, then register the new PM2 app: `pm2 start ecosystem.config.js --only uptime-worker` (or `pm2 startOrReload` — both handle an unregistered app). **Never `pm2 restart uptime-worker`** on the first release: it errors on a name PM2 has never started. The app must emit the PM2 ready signal (`process.send('ready')` after its Redis + DB pings pass — §4/§5).
   - *Verification:* `pm2 ls` shows `uptime-worker` `online` (not `errored`, not restart-looping); `curl -fsS http://127.0.0.1:9090/readyz` passes; the §4 step 6 synthetic-check smoke passes.
   - *Rollback:* there is no previous worker tarball on this one release — rollback is **web-only monitoring**: `pm2 delete uptime-worker`. The old `instrumentation.ts` cron path is still live (step 2 keeps it that way), so monitoring never stops.
2. **Overlap window — verify continuity with both paths live (M3).**
   - *Action:* disable nothing. The old `instrumentation.ts` cron **keeps running** while the new worker serves — both paths are idempotent by design, so the overlap only wastes duplicate checks, never corrupts data (audit M3). Hold this window until every item below is green.
   - *Verification:* healthchecks.io heartbeat steady (no `/fail` ping fired); worker queue depth returns to ≈ 0 after the initial drain (Redis/BullMQ metrics); pings still flowing for sampled monitors (fresh `pings` rows appearing under both paths); Telegram alert parity over the window (every DOWN/RECOVERY event alerted exactly once); monitor counter deltas sane (audit M4 — `total_checks`/`failed_checks` advance by ≈ the interval count, no doubling).
   - *Rollback:* disable nothing and keep web-cron as the monitoring path — a red item in this window means the worker is not yet trusted; the old path was never turned off, so no rollback action exists or is needed.
3. **Cutover completion — a separate, later release.**
   - *Action:* only after the overlap window has closed green, ship a follow-up release that deletes the old monitoring path — the `instrumentation.ts` cron registration and `CRON_MODE` (audit §24 step 4). From this release the worker is the sole monitoring path. (The external cron endpoints and `CRON_SECRET` follow their own later retirement path in §9 — they are not deleted here.)
   - *Verification:* one full check cycle with zero cron-route traffic (`/api/cron/*` access logs silent; `CRON_MODE` absent from the environment); the healthchecks.io heartbeat still green, now fired from the worker scheduler tick; §4 step 6 smoke check green.
   - *Rollback:* restore the previous release tarball pair and restart both apps — the previous release still carries the cron path, so web-cron returns; watch one check interval to confirm it is firing.

---

## 5. PM2 settings checklist (apply to both apps; values for `ecosystem.config.js`)

| Setting | Value | Applies to | Why (one line) |
|---|---|---|---|
| **`kill_timeout`** | **`20000`** (≥ 20 s) | worker (required), web | Lets in-flight jobs finish and flush before SIGKILL — deploys must not manufacture "stalled" jobs (J-3). Must be ≥ max job duration. |
| **`wait_ready`** | `true` | worker | PM2 counts the process as started only when it receives the **process ready signal** (`process.send('ready')`, §4) — not the HTTP `readyz` endpoint. Pairs with the `readyz` gate **via that signal**: an implementer who wires only the HTTP endpoint never signals PM2, and PM2 force-restarts after `listen_timeout` (boot crash loop, §4). |
| **`listen_timeout`** | `30000` | worker | How long PM2 waits for the **process ready signal from §4** before force-restarting — covers worker boot (queue workers up, Job Schedulers re-declared, Redis + DB pings). If the signal is never sent, this expiry is what manufactures the crash loop. |
| **`max_restarts`** | `10` | both | Crash-loop visibility: PM2 flags `errored` instead of restarting forever. |
| **`min_uptime`** | `60000` | both | A process that cannot stay up 60 s counts toward the crash-loop budget. |

`kill_timeout ≥ 20 s` is the non-negotiable floor (P-1/DEP-01). `listen_timeout`, `max_restarts`, and `min_uptime` are defaults — tune with data from Phase 4 onward (D-10). The worker's heartbeat to healthchecks.io fires from the scheduler tick (R-1); a heartbeat gap pages the operator independently of PM2.

---

## 6. Smoke check definition (normative)

The target-topology smoke check is: **enqueue one synthetic check against a known-good target and assert the ping row appears in the database.** It proves the full path — web enqueue → Redis/BullMQ → worker check → Postgres persist — in one action. Interim releases (Phases 2–3) have no worker; their smoke check is the web-serving check in §3 step 5. A release is not good until its topology's smoke check passes.

---

## 7. Rollback compatibility rule (M-2 / DEP-03)

- **Retain the previous release tarball** on the VPS. Restoring it **is** the rollback action at every step above, and it must return the prior release cleanly.
- **Expand/contract discipline:** migrations landing during a verification window are **additive-only** — new columns nullable or defaulted, new indexes created `CONCURRENTLY`. No column drops, renames, or retypes until the **following** release, after the verification window closes.
- Why: deploys roll back by redeploying the previous tarball, but migrations are forward-only — the rollback runs old code on the new schema, which is safe only if the schema merely expanded.
- Destructive (contract) steps are deferred to their own release and carry a manually documented `drizzle-kit` down-path written **before** that release ships.
- A release is verified only when `readyz` (web serving + worker `readyz`) and the smoke check are green post-deploy. Until then, treat the release as unverified and the previous tarball as live-ready.

---

## 8. Migration discipline (M-1 / M-3)

- **Exactly one migration runner** — the deploy pipeline step (§3 step 3 / §4 step 3). Running migrations at web or worker boot is forbidden: concurrent boot = concurrent DDL.
- **Versioned SQL files are the only schema authority** after the Phase 3 baseline; `prisma db push` is deleted from CI in the same PR that lands the baseline. Before that baseline (Phase 2 releases), the legacy CI schema step (`prisma db push`) is the acknowledged interim schema mechanism — already on its dated removal path — and Phase 2 releases carry no migrate step at all (§3 step 3).
- **Baseline from live DDL:** the Phase 3 baseline is authored from `pg_dump --schema-only` of production (not `schema.prisma`), and `drizzle-kit` diff against the live database must be empty — or an explicitly reviewed, intentional delta list — before any application cutover.
- **Empty-diff CI gate:** the diff check runs in CI on every release so schema drift cannot silently return.

---

## 9. Operational secret hygiene (S-4 decision note)

> **Design rule (S-4):** no endpoint accepts secrets via query strings. Error responses never include stack traces or internal details.
>
> `CRON_SECRET` (today accepted as `?secret=` on cron routes) **retires with the cron endpoints** on a dated retirement path: repo hygiene (`.env.example`, no stack traces, no secrets in query) lands in Phase 2 (FND-07); the cron endpoints and `CRON_SECRET` itself are deleted at the Phase 5 overlap-verified cutover, once the worker has proven continuity. During the interim, prefer the `Authorization: Bearer` form where the current routes accept it.
