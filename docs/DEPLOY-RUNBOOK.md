# SpiderNode — Deploy Runbook

> **Date:** 2026-09-09
> **Audience:** the operator executing a release on the production VPS — written to be followed mid-deploy, without reading any other document first.
> **Scope:** every release of this milestone (backend modernization), from Phase 2 foundations through the final visual redesign.
> **Status:** design-stage runbook — no corresponding code exists yet. Steps marked worker/`readyz` apply from Phase 4 onward (see topology table). Each step is verified live from Phase 2 onward and corrected here when reality disagrees.
> **Companion document:** [ARCHITECTURE-AUDIT.md](./ARCHITECTURE-AUDIT.md) — all design rationale lives there, not here (D-01/D-03). This document contains ordering, verification, and rollback only.
> **Amended 2026-09-09 (fix cycle):** §1/§2/§3/§4/§5 amended and §4a added — the Migrate step is phase-conditional (WR-03), the PM2 ready handshake names the process signal (WR-04), the first worker release has its own path (WR-05), and the steady-state budget is stated as ≤ 30 (IN-05 runbook half). §10 added later in the same fix cycle — worker-host egress control, closing RR-01's operator half (S-1 layer 1, mirroring audit §15.4).
> **Amended 2026-09-11 (Phase 2, plan 02-04):** deployment is fully manual from Phase 2 on — the GitHub-hosted deploy workflow was deleted (D-01), so §3 is rewritten as typed-by-hand steps with `pnpm verify` as the pre-deploy gate (D-02), the build happens on the dev machine and ships as a tarball (D-03), post-deploy verification is typed checks (D-04), Phase 2 runs no schema command (D-05), the generated Prisma client ships in the tarball so the VPS never builds or generates (D-14), and §3a adds the one-time VPS Node 24 + pnpm switch for the operator to run at their next real deploy (D-26). Every workflow-era instruction is gone from this document.

---

## 1. Connection budget (memorize these three numbers)

| Process | Pool `max` | Connection string |
|---|---|---|
| **web** (PM2 `uptime-tracker`, port 3007) | **10** | **POOLED** (provider pooler endpoint) |
| **worker** (PM2 `uptime-worker`, from Phase 4) | **20** | **DIRECT** |
| **migration runner** (operator-run, one-shot) | **1** | **DIRECT** |

Operational summary — **web 10 / worker 20 / migrations 1**; steady-state total ≤ 30 connections (web 10 + worker 20), rising to ≤ 31 only during deploys while the single one-shot migration runner is connected. Full spec (pool options, timeouts, pooled-vs-direct rationale, Neon limits): audit [§25](./ARCHITECTURE-AUDIT.md).

During a release, keep `psql` and dashboard sessions to a minimum: web 10 / worker 20 / migrations 1 leaves ≥ 70 % headroom against Neon's ~104 `max_connections` (assumption A4 — verify the project's tier before Phase 3).

---

## 2. Deploy topologies at a glance

Two orderings exist this milestone. Pick by phase, then follow the numbered steps for that topology exactly (D-04).

| Step | Interim topology (Phases 2–3, single PM2 app) | Target topology (Phase 4+, two PM2 apps) |
|---|---|---|
| **1** | Build (web from one SHA) | Build (web **and** worker from one SHA) |
| **2** | Backup (`pg_dump`) + rehearsal | Backup (`pg_dump`) + rehearsal |
| **3** | Migrate — Phase 2: run **no schema command** (the deleted deploy workflow took `prisma db push` with it, D-01/D-05); Phase 3+: single runner (`drizzle-kit migrate`) | Migrate (single runner) |
| **4** | — | **Restart worker → wait for `readyz`** |
| **5** | Restart web | Restart web |
| **6** | Smoke check | Smoke check (synthetic check → ping row) |

In every release the migration runs **before** any process restart, and in the target topology the **worker gates the release**: proceed to the web restart only after `:9090/readyz` passes.

---

## 3. Interim topology (Phases 2–3) — single PM2 app

`uptime-tracker` (web) is the only PM2 app. No worker exists yet; skip every worker/`readyz` step.

> **Deployment is fully manual from Phase 2 on (D-03).** No CI, no deploy scripts, no artifact tooling — the operator types every step below, on the dev machine and over SSH. Nothing is assumed beyond `pnpm` on the dev machine, `ssh`/`scp` to reach the VPS, and `pm2` on the VPS. The dev machine builds; the VPS extracts, installs, and reloads. The VPS never builds Next 16 itself (the `--max_old_space_size=2048` flag in the build script exists precisely because small servers run out of memory) and never runs `prisma generate` — the generated client ships inside the tarball (D-14).

> **The pre-deploy gate is `pnpm verify` (D-02).** One typed command runs the whole chain on the dev machine before anything ships: it brings up the throwaway test stack (`docker compose -f docker-compose.test.yml up -d --wait` — containerized Postgres + Redis), then `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm test:e2e`. Budget: **≤ 5 minutes warm (D-20)** — if the chain ever grows past that, the budget is defended (cut scope or parallelize), because a 20-minute gate gets skipped. **The gate is only as good as the operator discipline of actually running it before every release (D-02): no CI exists to enforce it (D-01).** A release shipped without a green verify is an unverified release.

1. **Gate, then build (dev machine).**
   - *Action:* from the release commit, run `pnpm verify` and require green. Then build and pack the release tarball from the repo root (Git Bash or any POSIX-flavored shell on the dev machine):

     ```
     pnpm verify
     pnpm build
     tar --exclude=node_modules --exclude=.git --exclude='.env*' \
         --exclude=test-results --exclude=playwright-report \
         -czf /tmp/uptime-tracker-<SHA>.tar.gz .
     ```

     The tarball deliberately includes the two gitignored build outputs — `.next/` (the Next build) and `src/generated/prisma/` (the generated client, D-14) — plus everything the VPS needs to install and start: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the Next config, `public/`, and `src/`. It never contains `.env` or any `.env.*` file; the VPS keeps its own.
   - *Verification:* `pnpm verify` exited 0 (all five stages green); the tarball exists, is non-empty, and its name carries the release SHA; `tar -tzf /tmp/uptime-tracker-<SHA>.tar.gz | grep -c 'src/generated/prisma'` is non-zero (the client really is inside).
   - *Rollback:* abort the release — nothing has touched production yet.
2. **Backup.**
   - *Action:* on the VPS, take a full database backup: `pg_dump "$DATABASE_URL" -F c -f /var/backups/uptime/pre-release-<SHA>.dump`. Before any cutover-adjacent release (schema or auth changes), rehearse the release first against an anonymized local copy of that snapshot (restore → run migration → run smoke check locally).
   - *Verification:* `pg_dump` exits 0; the dump file is non-empty; the rehearsal completed with the smoke check passing.
   - *Rollback:* abort the release — production data is unchanged. (No rollback action is ever taken against the dump itself; it is retained as the restore point of last resort.)
3. **Migrate (phase-conditional — check which phase you are releasing).**
   - *Action:* **Phase 2 releases: run no schema command at all (D-05).** The deploy workflow that used to run `prisma db push` on every release was deleted in Phase 2 (D-01) — its push-with-`--accept-data-loss` hazard left the deploy path with it, and no automated schema mechanism exists anymore. Production's schema stays exactly as the last workflow-driven deploy left it until Phase 3 transcribes it into versioned SQL; do not run any schema command ad hoc from this runbook. **Phase 3 onward: run the single migration runner — one runner, once:** `pnpm drizzle-kit migrate`. Never run migrations at process boot; never run two runners concurrently (concurrent boot = concurrent DDL is forbidden, M-1). If no migrations are pending, the command is a no-op that exits 0.
   - *Verification:* Phase 2 — nothing to check: no schema command ran anywhere, by design (D-05). Phase 3+ — command exits 0; the migrations journal shows the release's entries; the empty-diff check (`drizzle-kit` diff against the live database) reports no drift (M-3).
   - *Rollback:* do not run down-migrations inside the verification window. Migrations are forward-only, additive-first (§7): restore the previous release tarball and restart — the previous code runs against the expanded schema.

   > *Note (D-01):* deleting the workflow also orphaned any repo secrets it referenced (deploy keys, host entries). They are inert — nothing reads them anymore. Prune them in the repository's secret settings at leisure; nothing in this runbook depends on them.
4. **Ship, install, reload web.**
   - *Action:* copy the tarball to the VPS, extract it over the app directory, install the runtime dependency tree from the shipped lockfile, then reload:

     ```
     scp /tmp/uptime-tracker-<SHA>.tar.gz <user>@<vps-host>:/tmp/
     ssh <user>@<vps-host>
     tar -xzf /tmp/uptime-tracker-<SHA>.tar.gz -C /var/www/uptime-tracker
     cd /var/www/uptime-tracker && pnpm install --frozen-lockfile --prod
     pm2 restart uptime-tracker
     ```

     `--prod` keeps the VPS to the runtime tree — the toolchain (typescript, vitest, playwright, eslint, the prisma CLI) never installs there; it is not needed because the client ships pre-generated (D-14). **First release after the toolchain switch:** §3a replaces this step — PM2 re-reads `ecosystem.config.js` only on `pm2 startOrReload` (see §3a step 4).
   - *Verification:* `pm2 ls` shows the app `online`; `curl -fsS http://127.0.0.1:3007/login` returns HTTP 200.
   - *Rollback:* restore the previous release tarball (`tar -xzf` over `/var/www/uptime-tracker`, `pnpm install --frozen-lockfile --prod`, `pm2 restart uptime-tracker`); re-verify the 200.
5. **Typed post-deploy checks (D-04 — all hand-executed; no smoke script exists).**
   - *Action:* run all three, by hand: (a) `curl -fsS https://<app-url>/login` (or the local form `curl -fsS http://127.0.0.1:3007/login` over SSH) and confirm the login page renders — HTTP 200; (b) `pm2 status` and confirm `uptime-tracker` is `online` — not `errored`, not restart-looping; (c) `pm2 logs uptime-tracker --lines 50` and glance for startup errors (unhandled rejections, missing env vars, database connection failures). Also confirm the healthchecks.io heartbeat for the app has resumed (no `/fail` ping fired during the restart window).
   - *Verification:* all checks green within 30 s of the reload; heartbeat green. **No `readyz` endpoint exists in this topology** — it arrives with Phase 4's worker; these typed checks are the entire post-deploy verification until then (D-04).
   - *Rollback:* if any check fails, restore the previous release tarball, restart, and repeat the checks. If they still fail, stop and escalate — do not attempt schema changes under pressure.

---

## 3a. One-time VPS switch to Node 24 + pnpm (run once, at the next real deploy)

> **D-26 — repo-only phase.** Nothing here has been executed against the VPS; this section is typed documentation the operator runs **exactly once**, as the opening moves of their next real deploy. Every later deploy starts at §3 step 1 and skips this section entirely. The section is ordered to precede the first pnpm-based deploy so that deploy runs against an already-switched VPS.

The VPS currently runs the app the way it always has: Node loaded via NVM (Ubuntu 24.04), dependencies installed by npm, and PM2 invoking `npm run start` through `ecosystem.config.js`. This switch moves it onto the repo's pinned toolchain — `.nvmrc` pins Node `24`, and the `packageManager` field pins `pnpm@10.34.5` (D-06: the pin is identical on dev machine and VPS; Node 22 remains a valid floor, 24 is the standard).

1. **Node 24 as the default runtime.**
   - *Action:* on the VPS: `nvm install 24`, then `nvm alias default 24`. This matches the repo's `.nvmrc` (`24`) and the `engines` range in `package.json` (`>=22 <25`).
   - *Verification:* open a fresh shell — `node --version` prints a 24.x line.
2. **pnpm 10.34.5 via corepack — with the standalone fallback.**
   - *Action:* `corepack enable` (needs the rights to place shims on the Node bin directory). With that in place, the `packageManager: "pnpm@10.34.5"` field in the shipped `package.json` pins pnpm to exactly 10.34.5 inside `/var/www/uptime-tracker`. **Fallback if corepack is unavailable** on the installed Node build: install pnpm with its official standalone script — pnpm.io no longer documents corepack as an install method, and the standalone script is the documented path (fetch it over HTTPS from pnpm.io/installation and run it).
   - *Verification:* **`pnpm --version` must print `10.34.5` before proceeding** (Pitfall 7). A different major (11/12) changes config vocabulary (`allowBuilds` vs the removed `onlyBuiltDependencies`) and lockfile format — if any other version prints, stop and fix the resolution (`which pnpm` shows which binary won) instead of continuing.
3. **Replace the npm dependency tree.**
   - *Action:* run §3 steps 1–3 first (gate, build, backup, no-migrate), ship and extract the tarball (§3 step 4, up to the `tar -xzf`), then in `/var/www/uptime-tracker`: remove the npm-installed tree — `rm -rf node_modules` — and install from the shipped lockfile: `pnpm install --frozen-lockfile --prod`. The tarball carries `pnpm-lock.yaml` and `pnpm-workspace.yaml` (the build-script approvals ride along with it).
   - *Verification:* the install exits 0 with no unreviewed-build-script failure; `node_modules/` exists again; `pnpm list --prod --depth 0` prints the runtime tree.
4. **Point PM2 at pnpm — edit `ecosystem.config.js` as part of this switch.**
   - *Action:* edit `/var/www/uptime-tracker/ecosystem.config.js` on the VPS (extracted in step 3): change the app stanza from invoking npm to invoking pnpm — `script: "pnpm"`, `args: "run start"` — leaving `cwd: "/var/www/uptime-tracker"` and the `env` block untouched. Make the identical edit in the repo and commit it as part of this switch, so repo and VPS agree from here on. (The repo deliberately kept the npm-invoking stanza until now: PM2 never re-reads the file on its own, and editing it as a standalone earlier change would only create a window where repo and VPS disagree.) Then register the change: `pm2 startOrReload ecosystem.config.js` — **PM2 re-reads `ecosystem.config.js` only on `startOrReload`; a plain `pm2 restart` keeps the old interpreter.**
   - *Verification:* `pm2 describe uptime-tracker` shows the pnpm interpreter and the app is `online`; `curl -fsS http://127.0.0.1:3007/login` returns HTTP 200.
5. **Close the first pnpm-based deploy with the typed checks.**
   - *Action:* finish with §3 step 5 (curl, `pm2 status`, log glance). From the next deploy on, the §3 sequence runs start-to-finish and this section is skipped.
   - *Verification:* all §3 step 5 checks green. The switch is done — never repeat it.

---

## 4. Target topology (Phase 4+) — two PM2 apps

`uptime-tracker` (web) + `uptime-worker` (worker). The worker restart and `readyz` wait are inserted **before** the web restart — the worker gates the release (D-04/P-1).

Health surfaces (worker, port 9090): `GET :9090/healthz` = process alive only. `GET :9090/readyz` = process alive **and** Redis ping passes **and** database ping passes. Only `readyz` passing means the worker can take traffic.

Two distinct readiness signals exist, and PM2 watches only the first: the worker must emit the **PM2 ready signal** — a `process.send('ready')` call — once its Redis and DB pings pass, i.e. exactly when `readyz` would return success. The HTTP `readyz` endpoint remains the operator's gate; the process ready signal is the PM2 gate (§5 `wait_ready`). An implementer who wires only the HTTP server never signals PM2: with `wait_ready` set, PM2 force-restarts the worker after `listen_timeout` on every boot — a crash loop in the process that gates every Phase 4+ release.

1. **Build.**
   - *Action:* from the release commit, run the same §3 step 1 gate and build on the dev machine (`pnpm verify` green, then `pnpm build`), producing **both** artifacts from one SHA: `.next` (web) and `worker/dist/index.js` (worker). Tag both with the commit SHA.
   - *Verification:* every gate exits 0; both artifacts exist and carry the same SHA.
   - *Rollback:* abort the release — nothing has touched production yet.
2. **Backup.**
   - *Action:* on the VPS, take a full database backup: `pg_dump "$DATABASE_URL" -F c -f /var/backups/uptime/pre-release-<SHA>.dump`. For cutover-adjacent releases, rehearse against an anonymized local copy of that snapshot first (restore → migrate → worker restart → `readyz` → smoke check locally).
   - *Verification:* `pg_dump` exits 0; the dump file is non-empty; the rehearsal completed with `readyz` and the smoke check passing.
   - *Rollback:* abort the release — production data is unchanged.
3. **Migrate.**
   - *Action:* run the single migration runner (same phase-conditional contract as §3 step 3): `pnpm drizzle-kit migrate` — never at web or worker boot, never concurrently (M-1). No pending migrations ⇒ no-op exiting 0.
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

The target-topology smoke check is: **enqueue one synthetic check against a known-good target and assert the ping row appears in the database.** It proves the full path — web enqueue → Redis/BullMQ → worker check → Postgres persist — in one action. Interim releases (Phases 2–3) have no worker; their post-deploy check is the typed check set in §3 step 5 (curl, `pm2 status`, log glance — D-04). A release is not good until its topology's check passes.

---

## 7. Rollback compatibility rule (M-2 / DEP-03)

- **Retain the previous release tarball** on the VPS. Restoring it **is** the rollback action at every step above, and it must return the prior release cleanly.
- **Expand/contract discipline:** migrations landing during a verification window are **additive-only** — new columns nullable or defaulted, new indexes created `CONCURRENTLY`. No column drops, renames, or retypes until the **following** release, after the verification window closes.
- Why: deploys roll back by redeploying the previous tarball, but migrations are forward-only — the rollback runs old code on the new schema, which is safe only if the schema merely expanded.
- Destructive (contract) steps are deferred to their own release and carry a manually documented `drizzle-kit` down-path written **before** that release ships.
- A release is verified only when `readyz` (web serving + worker `readyz`) and the smoke check are green post-deploy. Until then, treat the release as unverified and the previous tarball as live-ready.

---

## 8. Migration discipline (M-1 / M-3)

- **Exactly one migration runner** — the operator-run step (§3 step 3 / §4 step 3). Running migrations at web or worker boot is forbidden: concurrent boot = concurrent DDL.
- **Versioned SQL files are the only schema authority** after the Phase 3 baseline. The last automated schema mechanism — `prisma db push` inside the deleted deploy workflow — left the deploy path in Phase 2 (D-01); from the Phase 3 baseline PR on, no `db push` exists anywhere, `drizzle-kit`'s journal is authoritative, and Phase 2 releases carry no migrate step at all (§3 step 3, D-05).
- **Baseline from live DDL:** the Phase 3 baseline is authored from `pg_dump --schema-only` of production (not `schema.prisma`), and `drizzle-kit` diff against the live database must be empty — or an explicitly reviewed, intentional delta list — before any application cutover.
- **Empty-diff check:** with no CI (D-01), the drift check is an operator-run typed step from Phase 3 on — run the `drizzle-kit` diff against the live database as part of the release's verification (§3 step 3 / §4 step 3) so schema drift cannot silently return. Its enforcement is operator discipline, same as the verify gate (D-02).

---

## 9. Operational secret hygiene (S-4 decision note)

> **Design rule (S-4):** no endpoint accepts secrets via query strings. Error responses never include stack traces or internal details.
>
> `CRON_SECRET` (today accepted as `?secret=` on cron routes) **retires with the cron endpoints** on a dated retirement path: repo hygiene (`.env.example`, no stack traces, no secrets in query) lands in Phase 2 (FND-07); the cron endpoints and `CRON_SECRET` itself are deleted at the Phase 5 overlap-verified cutover, once the worker has proven continuity. During the interim, prefer the `Authorization: Bearer` form where the current routes accept it.

---

## 10. Worker-host egress control (apply once — Phase 4 worker provisioning)

> **Design rule (S-1 layer 1 / audit §15.4):** the worker host denies outbound connections to the private ranges and allows public-internet egress on ports 80/443 only, with DNS and loopback/VPC-internal Postgres (5432) / Redis (6379) as the sole exceptions. The rule set is applied **once**, when the worker host is first provisioned (§4a step 1), before the worker takes production traffic — it is never part of a routine release.

1. **Apply the host-firewall egress rules.**
   - *Action:* on the worker host, apply and persist outbound firewall rules that (a) **deny** connections to the private ranges — `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, `64:ff9b::/96` — the identical range list audit §15.4 mirrors from the engine denylist (§15.1 step 4 sub-step 2); (b) **allow** outbound `80/tcp` and `443/tcp` to the public internet; (c) **allow** the exceptions — DNS resolution, and loopback/VPC-internal `5432/tcp` (Postgres) and `6379/tcp` (Redis). Make the rules survive a reboot.
   - *Verification:* from the worker host — a `curl` to a public `http://` target and a public `https://` target both succeed; a direct request to a private-range address — any `10.x.x.x`, `172.16.x.x`–`172.31.x.x`, or `192.168.x.x` host, or the link-local metadata canary `http://169.254.169.254/latest/meta-data` — is refused; a request to a public host on a non-80/443 port is refused; and the worker's `curl -fsS http://127.0.0.1:9090/readyz` stays green (the Redis + DB pings inside `readyz` prove the 6379/5432 exceptions work — §4).
   - *Rollback:* remove the rules and re-verify `readyz` stays green. The engine-layer SSRF validation (audit §15.1 step 4) remains enforced either way — the OS egress layer is defense-in-depth, so removing it never disables the primary boundary.

This section is not re-run per release. If the denylist itself ever changes, audit §15.1 step 4 sub-step 2, audit §15.4, and this section must be updated in the same change — the three lists are one list.
