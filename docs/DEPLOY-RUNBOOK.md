# SpiderNode — Deploy Runbook

> **Date:** 2026-09-09
> **Audience:** the operator executing a release on the production VPS — written to be followed mid-deploy, without reading any other document first.
> **Scope:** every release of this milestone (backend modernization), from Phase 2 foundations through the final visual redesign.
> **Status:** design-stage runbook — no corresponding code exists yet. Steps marked worker/`readyz` apply from Phase 4 onward (see topology table). Each step is verified live from Phase 2 onward and corrected here when reality disagrees.
> **Companion document:** [ARCHITECTURE-AUDIT.md](./ARCHITECTURE-AUDIT.md) — all design rationale lives there, not here (D-01/D-03). This document contains ordering, verification, and rollback only.
> **Amended 2026-09-09 (fix cycle):** §1/§2/§3/§4/§5 amended and §4a added — the Migrate step is phase-conditional (WR-03), the PM2 ready handshake names the process signal (WR-04), the first worker release has its own path (WR-05), and the steady-state budget is stated as ≤ 30 (IN-05 runbook half). §10 added later in the same fix cycle — worker-host egress control, closing RR-01's operator half (S-1 layer 1, mirroring audit §15.4).
> **Amended 2026-09-11 (Phase 2, plan 02-04):** deployment is fully manual from Phase 2 on — the GitHub-hosted deploy workflow was deleted (D-01), so §3 is rewritten as typed-by-hand steps with `pnpm verify` as the pre-deploy gate (D-02), the build happens on the dev machine and ships as a tarball (D-03), post-deploy verification is typed checks (D-04), Phase 2 runs no schema command (D-05), the generated Prisma client ships in the tarball so the VPS never builds or generates (D-14), and §3a adds the one-time VPS Node 24 + pnpm switch for the operator to run at their next real deploy (D-26). Every workflow-era instruction is gone from this document.
> **Amended 2026-09-12 (Phase 3, plan 03-06):** the Phase 3 operator path is complete — §3b adds the one-time VPS Redis install + hardening (D-15/D-17/D-18), §3c the Redis 70% memory alert via VPS cron + a dedicated healthchecks.io check (D-16), and §3d the migration-rehearsal procedure (D-10..D-12). §3 step 3's Phase-3 branch is activated (one-time baseline stamp via `scripts/stamp-baseline.mjs`, then the single `pnpm exec drizzle-kit migrate` runner), §3 step 5 gains the limiter-live checks (d)/(e)/(f), and §1's budget now counts the web process's 1 Redis connection.
> **Amended 2026-09-14 (Phase 4, plan 04-09):** the worker deploy form is real — §4/§4a ordering ACTIVATES per D-23 (build → backup → migrate no-op-when-pending-zero → worker start + `readyz` wait → web restart → smoke in the D-18 enqueue form); §4a gains step 4, the `next_check_at` re-seed typed now for Phase-5 execution (D-49); §10's egress rules are authored as concrete iptables/nftables text with the D-17 first-VPS-deploy disposition; pre-deploy steps gain `pnpm test:resilience` (D-27) and the worker deploy rehearsal `pnpm rehearse:worker` (D-32); §6a documents the synthetic smoke monitor seed values (D-19) and the outbox re-drive procedure (D-46); the dark-launch rollback is stated as stop-the-worker (D-22). The one-list-in-three-statements denylist mandate (engine §15.1 / audit §15.4 / §10) is now machine-enforced by `pnpm denylist:diff` (D-40) in the verify chain.

---

## 1. Connection budget (memorize these three numbers)

| Process | Pool `max` | Connection string |
|---|---|---|
| **web** (PM2 `uptime-tracker`, port 3007) | **10** | **POOLED** (provider pooler endpoint) |
| **worker** (PM2 `uptime-worker`, from Phase 4) | **20** | **DIRECT** |
| **migration runner** (operator-run, one-shot) | **1** | **DIRECT** |

Operational summary — **web 10 / worker 20 / migrations 1**; steady-state total ≤ 30 connections (web 10 + worker 20), rising to ≤ 31 only during deploys while the single one-shot migration runner is connected. Redis is budgeted separately: from Phase 3 the web process holds **1 Redis connection** (the rate limiter, `src/lib/redis.ts`) on top of its 10 Postgres; Phase 4's BullMQ raises web to 2 (queue producer + limiter) and adds the worker's 2 (IN-05/OBS-05). Full spec (pool options, timeouts, pooled-vs-direct rationale, Neon limits): audit [§25](./ARCHITECTURE-AUDIT.md).

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

> **The pre-deploy gate is `pnpm verify` (D-02).** One typed command runs the whole chain on the dev machine before anything ships: it brings up the throwaway test stack (`docker compose -f docker-compose.test.yml up -d --wait` — containerized Postgres + Redis), then `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm schema:gate` → `pnpm worker:boundary` → `pnpm denylist:diff` → `pnpm build` → `pnpm test:e2e`. Budget: **≤ 5 minutes warm (D-20)** — if the chain ever grows past that, the budget is defended (cut scope or parallelize), because a 20-minute gate gets skipped. **The gate is only as good as the operator discipline of actually running it before every release (D-02): no CI exists to enforce it (D-01).** A release shipped without a green verify is an unverified release. **Phase 4+ (D-27/D-32, added 2026-09-14): a release that ships or runs the worker additionally runs `pnpm test:resilience`** (the injection suite — what breakage the worker survives; it takes exclusive ownership of the 5453/6390 test stack, so never run it concurrently with `pnpm verify`) **and rehearses the full deploy-day sequence with `pnpm rehearse:worker`** (build → migrate no-op assert → backup → seed → worker + readyz → smoke → both outage injections → SIGINT-drain container leg → evidence file under the phase directory). The rehearsal owns its throwaway stack (ports 5460/6460/9460) and never touches the production stand-ins.

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
   - *Action:* on the VPS, take a full database backup: `pg_dump "$DATABASE_URL" -F c -f /var/backups/uptime/pre-release-<SHA>.dump`. Before any cutover-adjacent release (schema or auth changes), rehearse the release first — the procedure is §3d (fresh dump → `pnpm rehearse:migrations` → evidence review → abort on mismatch).
   - *Verification:* `pg_dump` exits 0; the dump file is non-empty; the rehearsal (§3d) completed with a PASS evidence file.
   - *Rollback:* abort the release — production data is unchanged. (No rollback action is ever taken against the dump itself; it is retained as the restore point of last resort.)
3. **Migrate (phase-conditional — check which phase you are releasing).**
   - *Action:* **Phase 2 releases: run no schema command at all (D-05).** The deploy workflow that used to run `prisma db push` on every release was deleted in Phase 2 (D-01) — its push-with-`--accept-data-loss` hazard left the deploy path with it, and no automated schema mechanism exists anymore. Production's schema stays exactly as the last workflow-driven deploy left it until Phase 3 transcribes it into versioned SQL; do not run any schema command ad hoc from this runbook. **Phase 3 onward (activated — the baseline and runner shipped in Phase 3): first Phase-3 release ONLY, stamp the baseline one time before the first migrate.** From `/var/www/uptime-tracker`, after extracting the new tarball and before the app reload:

     ```
     DATABASE_URL="<DIRECT connection string — not the pooled web endpoint; the script
     opens a one-shot client with statement_timeout deliberately unset>" \
       node scripts/stamp-baseline.mjs
     ```

     Then verify the bookkeeping table holds one row per committed migration: `SELECT hash, created_at FROM drizzle.__drizzle_migrations;` — the baseline row present, later entries still pending for the runner to apply exactly once. **Every release thereafter (the first included, after the stamp): run the single migration runner — one runner, once:** `pnpm exec drizzle-kit migrate`. Never run migrations at process boot; never run two runners concurrently (concurrent boot = concurrent DDL is forbidden, M-1). If no migrations are pending, the command is a no-op that exits 0.
   - *Verification:* Phase 2 — nothing to check: no schema command ran anywhere, by design (D-05). Phase 3+ — the first-release stamp prints `stamped 0000_baseline` (or `already stamped 0000_baseline — skipped` if re-run); `pnpm exec drizzle-kit migrate` exits 0; the migrations journal shows the release's entries. M-3's no-drift guarantee is NOT verified against the live production database in this step — no production-side diff command exists in this toolchain (the schema gate deliberately never targets a production database). It is enforced pre-ship on the dev side: `pnpm schema:gate` proves `src/db/schema.ts` equals a normalized pull of the migrated docker test database, and the §3d rehearsal proves the committed migration set reproduces exactly that shape against real (anonymized) production data. Drift introduced directly in production after those checks — e.g. a stray push from the frozen `prisma/schema.prisma` — is out of their reach by construction; the standing guards are the freeze warning in that file plus the gate's destructive-push absence scan, and any production-side pull-diff must be run as an explicitly reviewed standalone procedure, never assumed as a release step.
   - *Rollback:* do not run down-migrations inside the verification window. Migrations are forward-only, additive-first (§7): restore the previous release tarball and restart — the previous code runs against the expanded schema.

   > *Note (D-01):* deleting the workflow also orphaned any repo secrets it referenced (deploy keys, host entries). They are inert — nothing reads them anymore. Prune them in the repository's secret settings at leisure; nothing in this runbook depends on them.

   > *Note (03-03 recorded deviation):* the pooled-vs-DIRECT distinction above assumes the planning docs' provider model (Neon). Phase 3 recorded the operator-confirmed reality that the production database currently lives in the local docker container `spidernode-dev-db` (PostgreSQL 17.7), where every connection is direct and no pooler exists. Whichever host holds production at deploy time: give the stamp the same one-shot, unpooled URL that `pg_dump`/`psql` would use — never a pooler endpoint.
4. **Ship, install, reload web.**
   - *Action:* copy the tarball to the VPS, extract it over the app directory, install the runtime dependency tree from the shipped lockfile, then reload:

     ```
     scp /tmp/uptime-tracker-<SHA>.tar.gz <user>@<vps-host>:/tmp/
     ssh <user>@<vps-host>
     tar -xzf /tmp/uptime-tracker-<SHA>.tar.gz -C /var/www/uptime-tracker
     cd /var/www/uptime-tracker && pnpm install --frozen-lockfile --prod
     pm2 restart uptime-tracker
     ```

     `--prod` keeps the VPS to the runtime tree — the toolchain (typescript, vitest, playwright, eslint, the prisma CLI) never installs there; it is not needed because the client ships pre-generated (D-14). **First Phase-3 release:** §3b step 4 must already have added `REDIS_URL` to the VPS `.env` — without it the process still boots and `pm2 status` shows `online` (nothing in the startup graph imports Redis; Next.js evaluates route modules lazily), but the first hit to `POST /api/auth/register` or `POST /api/monitors` throws at module evaluation and returns 500; never reload Phase 3+ code before that line exists. **First release after the toolchain switch:** §3a replaces this step — PM2 re-reads `ecosystem.config.js` only on `pm2 startOrReload` (see §3a step 4).
   - *Verification:* `pm2 ls` shows the app `online`; `curl -fsS http://127.0.0.1:3007/login` returns HTTP 200.
   - *Rollback:* restore the previous release tarball (`tar -xzf` over `/var/www/uptime-tracker`, `pnpm install --frozen-lockfile --prod`, `pm2 restart uptime-tracker`); re-verify the 200.
5. **Typed post-deploy checks (D-04 — all hand-executed; no smoke script exists).**
   - *Action:* run all six, by hand. **(a)** `curl -fsS https://<app-url>/login` (or the local form `curl -fsS http://127.0.0.1:3007/login` over SSH) and confirm the login page renders — HTTP 200. **(b)** `pm2 status` and confirm `uptime-tracker` is `online` — not `errored`, not restart-looping. **(c)** `pm2 logs uptime-tracker --lines 50` and glance for startup errors (unhandled rejections, missing env vars, database connection failures). **(d)** The same 50-line log must contain **no** line matching `[redis-limiter] DEGRADED` (`pm2 logs uptime-tracker --lines 50 | grep -c '\[redis-limiter\] DEGRADED'` prints `0`) — that marker means the app cannot reach Redis and the limiter is failing open; if it appears, re-check §3b step 4's `REDIS_URL` wiring and the `redis-server` unit, fix, restart, and re-run this check. A clean (d) alone does NOT prove the Redis wiring: with `REDIS_URL` missing entirely the route module throws before any limiter call, so `DEGRADED` never prints — the load-bearing assertion is (e)'s register-probe status code (400/429, never 500). **(e)** Prove the limiter's counters live in Redis, not process memory: send one rate-limited request (`curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3007/api/auth/register -H 'content-type: application/json' -d '{}'` — the status must be 400, or 429 if this shared window is already exhausted, and NEVER 500: a 500 means the route module failed to evaluate (missing `REDIS_URL` — §3b step 4); the limiter counts before validation), then `redis-cli -a '<password>' --no-auth-warning INFO keyspace` shows `db0` with `keys>0` (the limiter's `rl:*` counters). **(f)** Limiter restart-survival proof (Phase 3's headline check): `POST /api/auth/register` once with any body (the limiter fires before validation — no user is created), `pm2 restart uptime-tracker`, then POST five more times — the first four return non-429 (requests 2–5 of the window) and the fifth post-restart POST, the **6th request in the 5-per-hour window, returns 429**. The 429 proves the window survived the restart in Redis: the deleted in-memory limiter would have reset the counter at the restart, and the sixth request would have succeeded. (Requests sent from the VPS itself share the `127.0.0.1` bucket.) Also confirm the healthchecks.io heartbeat for the app has resumed (no `/fail` ping fired during the restart window).
   - *Verification:* checks (a)–(e) green within 30 s of the reload; (f) green when run — it performs its own restart mid-check; heartbeat green. **No `readyz` endpoint exists in this topology** — it arrives with Phase 4's worker; these typed checks are the entire post-deploy verification until then (D-04).
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

## 3b. One-time VPS Redis install + hardening (run once, at the Phase 3 deploy)

> **D-15/D-17 — typed one-time steps, run exactly once at the Phase 3 deploy.** From the next deploy on, skip this section entirely. Order within the Phase 3 release: steps 1–3 may run any time before the §3 step 4 reload; step 4 (the `REDIS_URL` line) **must** land in the VPS `.env` before that release's `pm2 restart uptime-tracker`. Redis is self-hosted on the VPS by decision Q-3: Ubuntu's native `redis-server` package with systemd supervision satisfies RDS-03's "supervised restart" clause — no docker daemon enters the monitoring-infra critical path on the 2 GB VPS. Connection budget (§1): this phase the web process holds **1 Redis connection** (the rate limiter) on top of its 10 Postgres; the queue-producer and worker connections arrive in Phase 4.

1. **Install the package.**
   - *Action:* on the VPS: `sudo apt update && sudo apt install redis-server` (Ubuntu 24.04 universe package, D-17).
   - *Verification:* `redis-server --version` prints — record the line in the deploy record. Assumption A1 expects 7.2.x; every directive pinned below has existed since ≤ 6, so any 7.x is safe. `systemctl show -p ActiveState redis-server` prints `active`.
   - *Rollback:* `sudo apt remove redis-server` — the full retreat. The app's limiter fails open without Redis (D-03): removing it degrades rate limiting to always-allow; it never stops the app.
2. **Harden `/etc/redis/redis.conf` — back it up first.**
   - *Action:* `sudo cp /etc/redis/redis.conf /etc/redis/redis.conf.bak`, then edit the eight load-bearing lines (values verbatim; one-line reason each):

     ```
     supervised systemd          # MUST stay matched to the unit's Type=notify — Ubuntu ships this pair;
                                 # editing either side alone (this line OR the unit file) makes Redis
                                 # restart-loop until systemd's start limit fails the unit. Do not
                                 # override the unit file; leave this line exactly as shipped.
     bind 127.0.0.1              # loopback only — the app connects from the same host (D-18)
     protected-mode yes          # refuses non-loopback clients even if bind is ever widened
     requirepass <password>      # generate it: openssl rand -hex 32 — hex needs no URL escaping;
                                 # the same value lands in REDIS_URL at step 4
     appendonly yes              # AOF persistence on (RDS-03); Redis 7+ writes it under appenddirname
     appendfsync everysec        # fsync once per second — at most ~1 s of writes lost on a disaster
     maxmemory 512mb             # hard ceiling on the 2 GB VPS — revisit at Phase 4 (BullMQ state)
     maxmemory-policy noeviction # at the ceiling writes FAIL LOUDLY (an error reply) while reads keep
                                 # working — silently evicting limiter/BullMQ state is data loss
                                 # dressed as health; BullMQ documents noeviction as its requirement
     ```

   - *Verification:* `grep -E '^(supervised|bind|protected-mode|requirepass|appendonly|appendfsync|maxmemory|maxmemory-policy)' /etc/redis/redis.conf` shows all eight lines with the pinned values; the backup `/etc/redis/redis.conf.bak` exists.
   - *Rollback:* `sudo cp /etc/redis/redis.conf.bak /etc/redis/redis.conf && sudo systemctl restart redis-server`.
3. **Restart and enable.**
   - *Action:* `sudo systemctl restart redis-server` — persistence and auth config needs a restart, not a reload (a reload/SIGHUP applies only some directives). Then `sudo systemctl enable redis-server` — boot survival is the supervised-restart half of RDS-03.
   - *Verification:* `systemctl show -p ActiveState redis-server` prints `active`; `systemctl is-enabled redis-server` prints `enabled`.
   - *Rollback:* `sudo systemctl disable --now redis-server`, then the step 2 conf rollback, then (full retreat) the step 1 package removal.
4. **Wire the app — `REDIS_URL` into `.env` BEFORE the next restart.**
   - *Action:* construct the URL from the step 2 password — `REDIS_URL=redis://:<password>@127.0.0.1:6379` — and add the line to `/var/www/uptime-tracker/.env` **before** the next `pm2 restart uptime-tracker`. `src/lib/redis.ts` throws when it is evaluated without the variable — and it is evaluated lazily, on the first request that imports the register/monitors route modules (nothing in the startup graph imports it): restarting without it is NOT a boot crash loop — the process stays `online`, the login smoke check stays 200, and only `POST /api/auth/register` and `POST /api/monitors` begin returning 500s. The loud detection is therefore §3 step 5's register-probe status assertion in checks (d)/(e) — the `[redis-limiter] DEGRADED` marker cannot print when the module itself failed to load.
   - *Verification:* `grep -c '^REDIS_URL=' /var/www/uptime-tracker/.env` prints `1` (app-side reachability is proven after the release by §3 step 5 checks (d)/(e)).
   - *Rollback:* never remove the line while Phase 3+ code is live — that re-arms the 500s on the rate-limited routes. If the password is ever regenerated in the conf, update this line in the same change and restart; the rollback for the whole Redis introduction is the previous release tarball plus the step 1 package removal.
5. **Verify the service — PONG, active, supervised restart, noeviction.**
   - *Action:* run, in order: `redis-cli -a '<password>' --no-auth-warning ping`; `systemctl show -p ActiveState redis-server`; one more `sudo systemctl restart redis-server` followed by the same PING; `redis-cli -a '<password>' --no-auth-warning CONFIG GET maxmemory-policy`.
   - *Verification:* the first PONG returns behind the password (`--no-auth-warning` suppresses only the clear-text-password warning); ActiveState prints `active`; the PONG after the second restart returns `PONG` again — supervised restart proven (RDS-03's second half); `CONFIG GET maxmemory-policy` prints `noeviction`. As the auth proof, an unauthenticated `redis-cli ping` must fail with `NOAUTH`.
   - *Rollback:* none needed — these checks change no state; a failed check means an earlier step is wrong (step 2's conf rollback is the corrective path).

> **Why no TLS and no ACL user (D-18):** TLS is unnecessary on loopback — an attacker able to sniff `127.0.0.1` traffic has already compromised the host and has better attacks than reading limiter counters; TLS would add certificate rotation to a single-host deployment without crossing any trust boundary. An ACL user is deliberately not created: Phase 4's BullMQ needs broad keyspace access (`~*`), so a least-privilege ACL would immediately need widening — `requirepass` + loopback bind + protected-mode is the chosen layering (authentication and network restriction together).

---

## 3c. Redis 70% memory alert — dedicated healthchecks.io check, pinged by the worker tick (D-16, amended D-24)

> **Dead-man's-switch semantics: the worker pings while memory is healthy; silence pages.** The check is **separate from the worker heartbeat** — one check, one meaning (D-02's philosophy): a Redis memory event must not surface as "worker down", and a healthy worker must not mask an unhealthy Redis. Threshold: 70% of `maxmemory` — at §3b's `maxmemory 512mb` that is ~358 MB decimal (exactly 377,487,360 bytes / 360 MiB, since Redis's `mb` is binary; the arithmetic runs on `INFO`'s raw byte values, so it is exact). An unreachable Redis also produces silence: the dead man catches both over-threshold memory **and** a Redis outage.

> **AMENDED 2026-09-15 (05-Context D-24 — supersedes the VPS-cron script form):** the operator provisions the healthchecks.io check and sets `WORKER_MEMORY_HC_PING_URL`; **the worker does the rest.** The scheduler tick already reads Redis `INFO` for the memory metrics gauge and pings the check each tick (every 30 s = 2 pings/min, under healthchecks.io's 5/min per-check cap) **only while used memory stays below 70% of maxmemory** — silence past the grace pages. This form works on the local stand-in today (no VPS cron exists to install) and retires the forward-tracked §3c application debt from the Phase-3 UAT disposition (03-UAT item (b)). The historical VPS-cron script form is retained at the bottom of this section, clearly marked — it is superseded; **do not install it**.

1. **Provision the dedicated check (manual step, healthchecks.io dashboard).**
   - *Action:* create a **new** check named for this purpose (e.g. `redis-memory-worker`), Schedule = Period **1 minute** (healthchecks.io's finest period; the tick's 30 s ping cadence stays under the 5-pings/min cap regardless), **Grace 30 minutes** (D-25 — avoids flapping on transient spikes; pages within ~36 min of sustained over-threshold memory). Record its ping URL (`https://hc-ping.com/<uuid>`) and set it as `WORKER_MEMORY_HC_PING_URL` in the **worker's** environment. No API is assumed — this is a dashboard step performed by the operator. The variable is optional by design: an unset URL skips the ping (nothing pages), so a stand-in without the check configured never errors.
   - *Verification:* the check exists in the dashboard with the 1-minute schedule and 30-minute grace; the worker environment carries the URL; once the scheduler is live (Phase 5 window-open onward) the check's Last Ping advances each tick while memory is under threshold.
   - *Rollback:* remove the variable from the worker environment and delete the check in the dashboard.
2. **Verify both branches by hand (once, at provisioning time).**
   - *Action:* the healthy branch proves itself (Last Ping advances). For the over-threshold branch, verify the decision **input** rather than disturbing production: read the worker's memory gauge (`:9090/metrics.json`, and the `/metrics` exposition from Phase 5) — it is the same `INFO`-derived value the ping decision reads — and compare it against a manual `redis-cli INFO memory` computation. Do NOT edit the production threshold or `maxmemory` to force a page.
   - *Verification:* the gauge's used/max percentage matches the manual computation; a value under 70% with pings flowing demonstrates the gated ping condition by inspection.
   - *Rollback:* n/a — read-only verification.
3. **Rollback — the whole mechanism.**
   - *Action:* unset `WORKER_MEMORY_HC_PING_URL` (pings stop) and delete the check in the dashboard in the same motion — a check whose pings stopped pages after its grace.
   - *Verification:* the check is deleted (no lingering "down" pages); the worker runs unaffected (the variable is optional).
   - *Rollback:* n/a — this step IS the rollback.

**Historical form — VPS cron script (SUPERSEDED by the worker-side dead-man above, 05-Context D-24). Retained for the record; NO step in this block is operative — do not install, schedule, or extend any of it:**

1. **Provision the dedicated check (manual step, healthchecks.io dashboard).**
   - *Action:* create a **new** check named for this purpose (e.g. `redis-memory-vps`), Schedule = Period **5 minutes**, Grace short (e.g. 5 minutes) so silence pages quickly. Record its ping URL (`https://hc-ping.com/<uuid>`). No API is assumed — this is a dashboard step performed by the operator.
   - *Verification:* the check exists in the dashboard with the 5-minute schedule; its ping URL is at hand for step 2's script.
   - *Rollback:* delete the check in the dashboard.
2. **Install `/usr/local/bin/redis-memory-check.sh`.**
   - *Action:* create the script below, substituting the `<password>` from §3b step 2 and the ping URL from step 1, then `sudo chown root:root /usr/local/bin/redis-memory-check.sh && sudo chmod 700 /usr/local/bin/redis-memory-check.sh` — it embeds the Redis password and must never be world-readable:

     ```bash
     #!/usr/bin/env bash
     # redis-memory-check.sh — 70% maxmemory dead-man alert (D-16).
     # Pings ONLY while used_memory is below 70% of maxmemory; silence pages.
     # SUPERSEDED by the worker-side dead-man (D-24) — do not install or extend.
     set -u
     REDIS_PASS="<password>"
     PING_URL="https://hc-ping.com/<uuid>"
     THRESHOLD_PCT=70

     info="$(redis-cli -a "$REDIS_PASS" --no-auth-warning INFO memory 2>/dev/null)" || exit 0
     used="$(awk -F: '/^used_memory:/{print $2}' <<<"$info" | tr -d '\r')"
     max="$(awk -F: '/^maxmemory:/{print $2}' <<<"$info" | tr -d '\r')"
     [ -n "$used" ] && [ -n "$max" ] && [ "$max" -gt 0 ] || exit 0

     pct=$(( used * 100 / max ))
     if [ "$pct" -lt "$THRESHOLD_PCT" ]; then
       curl -fsS -m 10 "$PING_URL" >/dev/null 2>&1 || true
     fi
     exit 0
     ```

     The script exits 0 on every path — a monitoring script must never disrupt the app it watches or spam cron mail; its only signals are ping and silence. (An unreachable Redis also produces silence: the dead man catches both over-threshold memory **and** a Redis outage.)
   - *Verification:* `sudo /usr/local/bin/redis-memory-check.sh; echo $?` prints `0`; the healthchecks.io check shows a fresh ping (Last Ping advanced).
   - *Rollback:* `sudo rm /usr/local/bin/redis-memory-check.sh`.
3. **Schedule it every 5 minutes.**
   - *Action:* as root — either `sudo crontab -e` adding `*/5 * * * * /usr/local/bin/redis-memory-check.sh`, or a root-owned `/etc/cron.d/redis-memory-check` (mode 0644) containing `*/5 * * * * root /usr/local/bin/redis-memory-check.sh`.
   - *Verification:* the entry lists (`sudo crontab -l`, or `cat /etc/cron.d/redis-memory-check`); within 5 minutes the check's Last Ping advances again on schedule.
   - *Rollback:* remove the cron entry — pings stop and the check pages; pause or delete the check in the dashboard in the same motion.
4. **Verify both branches by hand (once, at install time).**
   - *Action:* the healthy branch is already proven (steps 2–3). For the over-threshold branch, run the comparison against a fake threshold **locally** — do NOT edit the production threshold on the box: copy the script to `/tmp/redis-memory-check-test.sh`, set `THRESHOLD_PCT=0` there, run it, and confirm no new ping appears (the ping branch is provably skipped when the percentage is not below the threshold).
   - *Verification:* real run → fresh ping; zero-threshold copy → no ping. Silence-pages semantics demonstrated in both directions.
   - *Rollback:* `rm /tmp/redis-memory-check-test.sh` (test artifact only).
5. **Rollback — the whole mechanism.**
   - *Action:* remove the cron entry (step 3), remove the script (step 2), delete the check in the dashboard (step 1).
   - *Verification:* `sudo crontab -l` / `/etc/cron.d` no longer reference the script; the file is gone; the check is deleted (no lingering "down" pages).
   - *Rollback:* n/a — this step IS the rollback.

---

## 3d. Migration rehearsal — before every schema-touching release (D-10..D-12)

> **The rehearsal is the gate, not a formality.** Every release that ships a migration (or touches auth — Phase 7) rehearses the exact production migration path against a fresh anonymized production snapshot first: one command, zero hand-computed verification (D-12). Runs on the dev machine; production is never touched.

1. **Take a FRESH dump into `.snapshots/` (dev machine).**
   - *Action:* a new dump each time a rehearsal is scheduled (D-11 — a stale dump rehearses stale drift). Generic form (03-05's docker-run command — works against any reachable Postgres; run from the repo root in Git Bash):

     ```
     docker run --rm -v "${PWD}/.snapshots:/dump" postgres:17-alpine \
       pg_dump "<DIRECT production connection string — never paste it into chat>" \
       -F c -f /dump/prod-$(date +%Y%m%d).dump
     ```

     **Recorded deviation (03-03):** today's production data lives in the local docker container `spidernode-dev-db` (PostgreSQL 17.7) — both committed rehearsal dumps were taken as `docker exec spidernode-dev-db pg_dump -U postgres -F c uptime_dev > .snapshots/prod-YYYYMMDD.dump` instead. Whichever host holds production at rehearsal time: dump THAT, land it in `.snapshots/` as `prod-*.dump` (custom format), never commit it.
   - *Verification:* the dump file exists and is non-empty; `pg_restore --list` on it exits 0.
   - *Rollback:* nothing to undo — production untouched; delete the dump if the release is abandoned.
2. **Run the rehearsal — one command.**
   - *Action:* `pnpm rehearse:migrations` (discovers the newest `.snapshots/prod-*.dump`; needs Docker running and port 5460 free — its pre-checks abort rather than touch the 5453/6390 test stack). The pipeline: throwaway `postgres:17-alpine` → `pg_restore` → deterministic anonymization → BEFORE metrics (row counts + digests) → baseline stamp → timed migrate → AFTER metrics → additive-only assertion → evidence → teardown.
   - *Verification:* the command exits 0. A non-zero exit names the offending table or DDL violation — that IS the mismatch signal.
   - *Rollback:* n/a — throwaway container, torn down in a `finally` on success and failure alike.
3. **Review the evidence file.**
   - *Action:* read the committed evidence at `.planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-YYYYMMDD.md` (local copy in `.snapshots/rehearsal-*`): every table's row count and digest BEFORE == AFTER — the one **labeled sanctioned carve-out** excepted (the digest runs over the pinned pre-migration column inventory, so this release's added columns are outside it by construction); the DDL delta is additive-only (nothing dropped, renamed, or retyped); the D-19 per-index timing record lives in the same file.
   - *Verification:* verdict PASS; zero mismatches; the delta contains only this release's expected additive objects.
   - *Rollback:* n/a — review step.
4. **Abort the release on any mismatch.**
   - *Action:* any count/digest drift outside the carve-out, any non-additive DDL, or a non-zero pipeline exit aborts the release — do not proceed to §3 steps 2–3 on a failed rehearsal. Fix the migration, commit, re-rehearse.
   - *Verification:* the release either carries a PASS evidence file or does not ship.
   - *Rollback:* the abort IS the rollback — production was never touched.

---

## 4. Target topology (Phase 4+) — two PM2 apps

`uptime-tracker` (web) + `uptime-worker` (worker). The worker restart and `readyz` wait are inserted **before** the web restart — the worker gates the release (D-04/P-1).

> **ACTIVATED 2026-09-14 (D-23, plan 04-09):** this ordering executed for real as the Phase 4 dark launch (see §4a and the phase deploy record) — build, backup, migrate (a no-op exit 0 when zero migrations are pending), worker start + `readyz` wait, web restart, then the smoke check in the D-18 enqueue form. Every subsequent Phase 4+ worker release follows this section unchanged; the first worker registration is §4a.

Health surfaces (worker, port 9090): `GET :9090/healthz` = process alive only. `GET :9090/readyz` = process alive **and** Redis ping passes **and** database ping passes. Only `readyz` passing means the worker can take traffic.

Two distinct readiness signals exist, and PM2 watches only the first: the worker must emit the **PM2 ready signal** — a `process.send('ready')` call — once its Redis and DB pings pass, i.e. exactly when `readyz` would return success. The HTTP `readyz` endpoint remains the operator's gate; the process ready signal is the PM2 gate (§5 `wait_ready`). An implementer who wires only the HTTP server never signals PM2: with `wait_ready` set, PM2 force-restarts the worker after `listen_timeout` on every boot — a crash loop in the process that gates every Phase 4+ release.

1. **Build.**
   - *Action:* from the release commit, run the §3 step 1 gate and build on the dev machine (`pnpm verify` green, then — for worker releases — `pnpm test:resilience` green and one `pnpm rehearse:worker` pass per D-27/D-32, then `pnpm build`), producing **both** artifacts from one SHA (D-06): `.next` (web) and `dist/worker.js` (the single worker entry, D-11 — one build runs `next build` and `tsup` together, so the pair cannot diverge; `/healthz` carries the SHA as runtime proof, D-10). Tag both with the commit SHA.
   - *Verification:* every gate exits 0; both artifacts exist; the worker's `curl -fsS http://127.0.0.1:9090/healthz` reports the same SHA as the release commit (D-10 provenance).
   - *Rollback:* abort the release — nothing has touched production yet.
2. **Backup.**
   - *Action:* on the VPS, take a full database backup: `pg_dump "$DATABASE_URL" -F c -f /var/backups/uptime/pre-release-<SHA>.dump`. For cutover-adjacent releases, rehearse first — the mechanics are §3d's pipeline (fresh dump → `pnpm rehearse:migrations` → evidence review → abort on mismatch), with the worker restart and `readyz` wait wrapped around the migrate.
   - *Verification:* `pg_dump` exits 0; the dump file is non-empty; the rehearsal completed with `readyz` and the smoke check passing.
   - *Rollback:* abort the release — production data is unchanged.
3. **Migrate.**
   - *Action:* run the single migration runner (same phase-conditional contract as §3 step 3): `pnpm drizzle-kit migrate` — never at web or worker boot, never concurrently (M-1). No pending migrations ⇒ no-op exiting 0.
   - *Verification:* command exits 0; journal shows the release's entries; M-3's no-drift guarantee is the pre-ship dev-side one (see §3 step 3 — `pnpm schema:gate` + the §3d rehearsal), not a diff run against production: no production-side diff command exists.
   - *Rollback:* no down-migrations inside the verification window — restore the previous tarball pair and restart both apps (additive-only schema, §7).
4. **Restart worker, then wait for `readyz`.**
   - *Action:* deploy the new worker tarball, then `pm2 restart uptime-worker`. Poll `curl -fsS http://127.0.0.1:9090/readyz` until it passes. **Do not proceed to the web restart until `readyz` passes.** (This restart form applies from the **second** worker release onward — the first registration of the app follows §4a, not this step.)
   - *Verification:* `pm2 ls` shows `uptime-worker` `online`; `readyz` returns success (Redis ping + DB ping both green); `healthz` alone is not sufficient.
   - *Rollback:* restore the previous worker tarball, `pm2 restart uptime-worker`, and re-check `readyz`. Only if the previous worker also fails `readyz` treat it as an infrastructure fault (Redis/Postgres), not a release fault — stop and escalate.
5. **Restart web.**
   - *Action:* deploy the new web tarball to `/var/www/uptime-tracker`, then `pm2 restart uptime-tracker`.
   - *Verification:* `pm2 ls` shows the app `online`; `curl -fsS http://127.0.0.1:3007/login` returns HTTP 200.
   - *Rollback:* restore the previous web tarball and restart; re-verify the 200.
6. **Smoke check (target form — synthetic check through the queue, D-18).**
   - *Action:* enqueue **one** synthetic check against the dedicated operator-owned smoke monitor (§6a's seeded synthetic monitor) through the SAME manual enqueue path the app uses — `DATABASE_URL=… REDIS_URL=… pnpm smoke:enqueue`. The job rides the check lane at priority 1; a manual job always takes Tier 1, so the **ping row IS the evidence** (a completed smoke proves enqueue → Redis/BullMQ → worker check → Tier-1 transition transaction → Postgres persist). The script resolves the synthetic monitor, enqueues exactly one job, prints its `check-manual:{monitorId}:{epochMs}` jobId, polls for a NEW ping row, and exits non-zero on timeout or a refused enqueue (Postgres breaker OPEN).
   - *Verification:* `pnpm smoke:enqueue` exits 0 printing the jobId and the new ping row (status/responseTime); `readyz` stayed green throughout. The release counts as good only when both hold.
   - *Rollback:* if no ping row appears (or `readyz` flipped), restore the previous web **and** worker tarballs, restart worker first (`readyz`) then web, and repeat the smoke check. If it still fails, restore the database from the pre-release dump taken in step 2 and escalate.

---

## 4a. First worker release (Phase 4 cutover)

The first release that introduces `uptime-worker` is not a restart: the app does not exist in PM2 yet, there is no previous worker tarball, and the old monitoring path must stay live until the new one has proven continuity (audit M3 — this is the highest-risk release of the milestone). §4 step 4's `pm2 restart` form applies from the **second** worker release onward; this subsection is the complete path for the **first** release only. §4 steps 1–3 (build, backup, migrate) and the §4 step 6 smoke check run unchanged around it.

> **EXECUTED 2026-09-14 as the Phase 4 DARK LAUNCH (D-15/D-16/D-21/D-23, plan 04-09):** the worker went live as a plain process on the operator-ratified local stand-in (spidernode-dev-db + the hardened Redis stand-in + `pnpm start` web — the 03-08 topology) with `WORKER_SCHEDULER_ENABLED=false`. The flag pauses ONLY the scheduler upserts — consumers always live, and `queue.pause` is forbidden — so the worker consumes anything enqueued (the smoke check) while the legacy `instrumentation.ts` cron serves 100% of user monitors exactly as before. **Rollback for the dark launch is: stop the worker process (D-22).** No code-level rollback exists this phase by design — the worker is additive, the cron never stopped, and Phase 5 owns the overlap-verified cutover rehearsal. The PM2 handshake (`wait_ready`/`kill_timeout`) is exercised as configuration in `ecosystem.config.js` only — its live behavior is a first-VPS-deploy consumption point (deploy record disposition).

> **AMENDED 2026-09-15 (Phase 5 gated window, plans 05-04..05-09 — audit §20.1 is the design authority):** steps 1–3 above plus step 4's re-seed are the executed dark-launch history and its Phase-5 preamble. Phase 5 executes the cutover as one **add-release → env-flip window → deletion release** arc (05-CONTEXT D-07): the add-release ships all new wiring (heartbeat, outbox-age/memory dead-men, `/metrics`, gate/scraper scripts, these doc amendments) and soaks scheduler-off in the dark-launch posture; **steps 5–11 below are the window-open choreography and the deletion release** — the runbook an operator executes on window day. The window itself is a pure environment flip (`WORKER_SCHEDULER_ENABLED=true` + worker restart), not an application change.

1. **Register and start the worker — never `pm2 restart`.**
   - *Action:* deploy the worker artifact, then register the new PM2 app: `pm2 start ecosystem.config.js --only uptime-worker` (or `pm2 startOrReload` — both handle an unregistered app). **Never `pm2 restart uptime-worker`** on the first release: it errors on a name PM2 has never started. The app must emit the PM2 ready signal (`process.send('ready')` after its Redis + DB pings pass — §4/§5). **Dark-launch posture:** the plain-process stand-in runs `node dist/worker.js` with `WORKER_SCHEDULER_ENABLED=false` in its environment (D-16); readiness is still the two signals — `curl :9090/readyz` 200 for the operator, the process ready signal for PM2 (N/A-locally as a plain process).
   - *Verification:* `pm2 ls` shows `uptime-worker` `online` (not `errored`, not restart-looping); `curl -fsS http://127.0.0.1:9090/readyz` passes; the §4 step 6 synthetic-check smoke passes.
   - *Rollback:* there is no previous worker tarball on this one release — rollback is **web-only monitoring**: `pm2 delete uptime-worker` (dark launch: stop the worker process — D-22). The old `instrumentation.ts` cron path is still live (step 2 keeps it that way), so monitoring never stops.
2. **Overlap window — verify continuity with both paths live (M3).**
   - *Action:* disable nothing. The old `instrumentation.ts` cron **keeps running** while the new worker serves — both paths are idempotent by design, so the overlap only wastes duplicate checks, never corrupts data (audit M3). Hold this window until every item below is green.
   - *Verification:* healthchecks.io heartbeat steady (no `/fail` ping fired); worker queue depth returns to ≈ 0 after the initial drain (Redis/BullMQ metrics); pings still flowing for sampled monitors (fresh `pings` rows appearing under both paths); Telegram alert parity over the window (every DOWN/RECOVERY event alerted exactly once); monitor counter deltas sane (audit M4 — `total_checks`/`failed_checks` advance by ≈ the interval count, no doubling).
   - *Rollback:* disable nothing and keep web-cron as the monitoring path — a red item in this window means the worker is not yet trusted; the old path was never turned off, so no rollback action exists or is needed.
3. **Cutover completion — a separate, later release (mechanics expanded in step 10).**
   - *Action:* only after the gated window has closed green — the steps 5–8 choreography with its 7-gate evaluation PASS plus the step 9 operator approval — ship the follow-up release that deletes the old monitoring path's scheduler: the `instrumentation.ts` cron registration and `CRON_MODE` (audit §24 step 4; the release mechanics, including the Windows flush and the old-check pause, are step 10 below). From this release the worker is the sole monitoring path. (The external cron endpoints and `CRON_SECRET` follow their own later retirement path in §9 — they are not deleted here; they survive dormant as §9's emergency lever until Phase 6.)
   - *Verification:* one full check cycle with zero cron-route traffic (`/api/cron/*` access logs silent; `CRON_MODE` absent from the environment); the healthchecks.io heartbeat still green, now fired from the worker scheduler tick; §4 step 6 smoke check green.
   - *Rollback:* restore the previous release tarball pair and restart both apps — the previous release still carries the cron path, so web-cron returns; watch one check interval to confirm it is firing.
4. **Re-seed `next_check_at` BEFORE the scheduler unpause (D-49 — TEXT NOW, execution Phase 5).**
   - *Action:* **do not run this at the Phase 4 dark launch.** The legacy cron serves the whole dark launch and never advances `next_check_at` — it is stale for every user monitor for the entire window (fresh installs get a backfilled value, but every pre-existing monitor's slot goes progressively stale). Immediately BEFORE Phase 5 unpause of the worker scheduler (removing `WORKER_SCHEDULER_ENABLED=false`), run the re-seed against the DIRECT database URL, in live column names:

     ```sql
     -- D-49 re-seed (run once, immediately before the Phase 5 scheduler unpause):
     UPDATE monitors
        SET next_check_at = LEAST(
              "lastChecked" + ("interval" * interval '1 minute'),
              now()         + ("interval" * interval '1 minute'))
      WHERE "isActive";
     ```

     `LEAST` bounds the wave: a monitor overdue by hours gets its (past) nominal slot — the claim's D-50 `GREATEST` catch-up advance then handles it as one immediately-due claim — while a monitor checked recently keeps its true next slot. One UPDATE, zero new migrations, forward-only.
   - *Verification:* the UPDATE reports a row count equal to the active-monitor count; the first scheduler tick after unpause claims a sane wave (no backlog-gate drops in `/metrics.json`), and §4 step 6 smoke stays green.
   - *Rollback:* no down-path needed — the column is derived scheduling state, not data; re-running the UPDATE (or letting one tick pass) recomputes it. If the unpause itself goes wrong, re-pause (`WORKER_SCHEDULER_ENABLED=false`) — the cron is still live until the §4a step-3 cutover release.
5. **Unpause the scheduler — flag flip + worker RESTART (window-open, 05-CONTEXT D-01).**
   - *Action:* run step 4's D-49 re-seed UPDATE **immediately before** this step — it is mandatory, not optional (the claim's D-50 `GREATEST` catch-up alone would still be correct, but the re-seed is what makes the first wave sane). Provision the three real healthchecks.io checks (D-37 — throwaway rehearsal checks were separate; these are the permanent ones) and put their ping URLs in the worker's environment: `WORKER_HC_PING_URL` (heartbeat), `WORKER_OUTBOX_HC_PING_URL` (outbox age), `WORKER_MEMORY_HC_PING_URL` (Redis memory) — all optional, ping skipped when unset, graces per step 11's table. Then set `WORKER_SCHEDULER_ENABLED=true` and **restart the worker**: the flag is boot-read (`src/worker/index.ts` reads it once; `upsertSchedulersAtBoot` runs at boot only) — flipping the env on a running worker does nothing.
   - *Verification:* `curl -fsS http://127.0.0.1:9090/readyz` passes; the worker boot log prints **`recurring scheduling ACTIVE`** (a boot payload still showing `schedulerEnabled: false` means the flag never reached the process — the 04 split-brain guard exists because exactly that happened); expect the first samples to show immediate relay-pass and flush-sweep activity — at unpause, four schedulers activate at once (check-tick 30 s, tier2-flush 30 s, relay-pass 5 s, maintenance daily) — this is harmless and is noted in the gate evidence, not treated as an anomaly.
   - *Rollback:* re-pause — `WORKER_SCHEDULER_ENABLED=false` + worker restart (the step 6 abort form; 05-CONTEXT D-06). Cron never stopped, so monitoring never stopped.
6. **Live abort drill — prove the lever BEFORE the window (05-CONTEXT D-35/D-15 tier 1).**
   - *Action:* after 10–15 minutes of unpause, re-pause (`WORKER_SCHEDULER_ENABLED=false` + worker restart). Verify cron auto-resumes via the due-filter: monitors the worker had just checked are not due (starved), and everything else comes back on its own slot — zero gap. Then unpause again (step 5 form) into the **fresh** window — the drill's re-pause restarts the window clock (D-16). Keep the drill under the heartbeat check's grace (10 min, step 11) or pause the heartbeat check in the dashboard for its duration so the drill does not page.
   - *Verification:* per-monitor ping timestamps show no gap exceeding interval + tolerance across the drill; the web process's cron-pass logs show the due set re-admitted (monitors the worker had not yet taken come due on their own slots); after the second unpause the boot log again prints `recurring scheduling ACTIVE`.
   - *Rollback:* n/a — this step IS the abort rehearsal. Its purpose is that the first real abort is never performed under incident stress; a stand-in rehearsal (D-30) proved the mechanics earlier, but env-wiring mistakes on the real stack are only caught by a live pull.
7. **The window — 4–6 h dense co-run (05-Context D-12/D-16).**
   - *Action:* hold the co-run dense so every monitor cycles multiple times within it. Induce DOWN/RECOVERED parity events mid-window on the operator-owned monitor against a controllable target (D-11 — exercise the real create path; natural incidents count as bonus evidence only). Enqueue the maintenance dry-run pass manually instead of waiting for the daily 03:15 slot (WRK-13's manual path). Any interruption — reboot, restart, operator-caused gap — **restarts the window clock**: gates evaluate only over the final continuous ≥4 h stretch; a gap IS a monitoring gap and is never dispositioned away.
   - *Verification:* the throwaway scraper's samples flow continuously; no check-lane job older than **120 s** at any sample and depth returns to 0 between claim cycles (D-19's age bound — this is the documented worst-case check latency, the WRK-12/J-6 number); the heartbeat check's flips record stays green.
   - *Rollback:* any red signal → step 6's abort form (re-pause; D-06 — pre-committed, no debate at 2 a.m.).
8. **Gate evaluation — one typed command (05-CONTEXT D-14).**
   - *Action:* run `node scripts/gate-cutover.mjs` with the window start/end timestamps and the captured snapshot directory. It emits PASS/FAIL per the 7 gates — (1) heartbeat steady via the healthchecks.io flips record (D-17 — the dead-man switch IS the monitor, no local tick counting), (2) queue age + drain, (3) alert parity (exactly one relayed alert per incident, D-48 bytes), (4) counter gates: pings-vs-counters reconciliation (D-02) AND the D-37 dry-run recompute, (5) continuity gap-scan, (6) zero duplicate ONGOING incidents, (7) legacy-path log disposition — and appends the evidence block to `.planning/phases/05-worker-cutover-operational-hardening/05-DEPLOY-RECORD.md`. The alert-parity gate is a **verify + gate + disposition** control: duplicate-alert suppression machinery is deliberately NOT built (D-05) — a transient takeover-minute duplicate is dispositioned in the record.
   - *Verification:* the script exits 0 with 7/7 PASS; a window shorter than 4 continuous hours fails up front (D-16).
   - *Rollback:* any FAIL → re-pause (D-06), fix, re-rehearse on the stand-in (D-30/D-32), and reopen a fresh window — the window never "counts" partially.
9. **Operator approval — BLOCKING step (05-Context D-18).**
   - *Action:* the operator reviews the gate-script PASS output and the evidence, then **explicitly approves before the deletion release ships**. The approval is recorded with date + verdict in `05-DEPLOY-RECORD.md` (the 04-09 Task 4 pattern). No approval, no deletion release — the co-run may simply continue (cron is still live) or the scheduler may be re-paused.
   - *Verification:* an affirmative approval entry with the operator's name, date, and verdict exists in the deploy record, referencing the gate evidence.
   - *Rollback:* decline or defer — the system keeps running exactly as it is (co-run or re-paused); nothing about the window forces the deletion.
10. **Deletion release — SCHEDULER-ONLY (05-Context D-03).**
   - *Action:* ship the follow-up release of step 3. It deletes exactly **`src/instrumentation.ts` + `CRON_MODE`** (plus the now-unread `node-cron` dependency). `cron-logic.ts`, `db-batcher.ts`, and the `/api/cron/*` routes **survive dormant** as §9's manual emergency lever until Phase 6 (API-01/SEC-06) deletes them. On the Windows stand-in, immediately **BEFORE stopping web**, run `curl -fsS "http://127.0.0.1:3007/api/cron/check" -H "Authorization: Bearer $CRON_SECRET"` (a GET — both cron routes export GET only) so the batcher flushes in-request — the SIGTERM flush never fires under a Windows hard stop (`taskkill /T /F` lost exactly one batched ping at the 04 dark launch), and timing it just after a 15-minute flush boundary leaves minimal residue (D-43). In the same release, **pause or delete the OLD cron healthchecks.io check** (the one behind `HC_PING_URL`) in the dashboard — its pings stop when `instrumentation.ts` dies, and an un-paused check false-pages within its grace (D-21).
   - *Verification:* one full check cycle with zero cron-route traffic; the heartbeat stays green, now fired from the worker scheduler tick; §4 step 6's smoke check green; the old cron check shows paused/deleted in the dashboard.
   - *Rollback:* restore the previous release tarball pair and restart both apps (worker first, `readyz` gate) — the previous release still carries the cron path, so web-cron returns; watch one check interval to confirm it fires.
11. **Post-cutover standing state — the pause lever and the dead-man graces (05-Context D-09/D-25).**
   - **`WORKER_SCHEDULER_ENABLED=false` + worker restart is THE permanent operator emergency/maintenance pause** — never `queue.pause()` (forbidden since the dark launch; pausing queues strands in-flight work). The flag form lets consumers drain, keeps health endpoints up, and lets in-flight jobs finish; after the deletion release there is no cron to fall back on, so the emergency check path is §9's curl lever.
   - Dead-man grace table (D-25) — provisioned at step 5, operative from window-open:

     | Check (env var) | Grace | Pages within | Why this grace |
     |---|---|---|---|
     | Worker heartbeat (`WORKER_HC_PING_URL`) | 10 min | ~11 min | absorbs deploy restarts; a dead worker pages one tick + transport after grace |
     | Outbox age (`WORKER_OUTBOX_HC_PING_URL`) | 5 min | ~6 min | relay cadence is 5 s — 5 min of silence is ~60 missed passes, a real problem |
     | Redis memory (`WORKER_MEMORY_HC_PING_URL`) | 30 min | ~36 min | avoids flapping on transient memory spikes (§3c's 70% threshold) |

   - **Tuning rule (D-20):** the pinned constants stand unless window data shows a concrete problem — breaker 5-fail/60 s, backlog gate ~2x active monitors, attempt bounds 3–5, the D-19 120 s age bound. Any tuning change lands with its evidence in the deploy record; no speculative tuning.

---

## 5. PM2 settings checklist (apply to both apps; values for `ecosystem.config.js`)

| Setting | Value | Applies to | Why (one line) |
|---|---|---|---|
| **`kill_timeout`** | **`20000`** (≥ 20 s) | worker (required), web | Lets in-flight jobs finish and flush before SIGKILL — deploys must not manufacture "stalled" jobs (J-3). Must be ≥ max job duration. |
| **`wait_ready`** | `true` | worker | PM2 counts the process as started only when it receives the **process ready signal** (`process.send('ready')`, §4) — not the HTTP `readyz` endpoint. Pairs with the `readyz` gate **via that signal**: an implementer who wires only the HTTP endpoint never signals PM2, and PM2 force-restarts after `listen_timeout` (boot crash loop, §4). |
| **`listen_timeout`** | `30000` | worker | How long PM2 waits for the **process ready signal from §4** before force-restarting — covers worker boot (queue workers up, Job Schedulers re-declared, Redis + DB pings). If the signal is never sent, this expiry is what manufactures the crash loop. |
| **`max_restarts`** | `10` | both | Crash-loop visibility: PM2 flags `errored` instead of restarting forever. |
| **`min_uptime`** | `60000` | both | A process that cannot stay up 60 s counts toward the crash-loop budget. |

`kill_timeout ≥ 20 s` is the non-negotiable floor (P-1/DEP-01). `listen_timeout`, `max_restarts`, and `min_uptime` are defaults — tune with data from Phase 4 onward (D-10). The worker's heartbeat to healthchecks.io fires from the scheduler tick (R-1); a heartbeat gap pages the operator independently of PM2. *(Annotated 2026-09-15, Phase 5: the tick→heartbeat wiring lands with the Phase-5 add-release — during the Phase-4 dark launch the heartbeat still fires from the legacy `instrumentation.ts` cron pass; from window-open the tick pings the NEW dedicated check behind `WORKER_HC_PING_URL`, 05-Context D-21/D-22, grace per §4a step 11's table.)*

---

## 6. Smoke check definition (normative)

The target-topology smoke check is: **enqueue one synthetic check against a known-good target and assert the ping row appears in the database.** It proves the full path — web enqueue → Redis/BullMQ → worker check → Postgres persist — in one action. Interim releases (Phases 2–3) have no worker; their post-deploy check is the typed check set in §3 step 5 (from Phase 3 including the Redis limiter-live checks (d)–(f) — D-04). A release is not good until its topology's check passes.

---

## 6a. The synthetic smoke monitor + outbox re-drive (D-19/D-46)

**Seed values (D-19 — applied by `scripts/seed-synthetic.sql` after every migrate on a deploy topology):** the smoke target is an operator-owned monitor, never a user's. Its owner is the sentinel user `spidernode-ops-smoke` (email `ops-smoke@spidernode.internal`, **no telegram binding** — any outbox row its checks produce takes the relay's no-chat skip path, so a smoke can never page a human). The monitor's natural key is (`spidernode-ops-smoke`, `https://example.com/`): IANA's reserved documentation host — stable, publicly reachable, fast. `interval` is 1440 (once a day): `lastChecked` is seeded to `now()` because the legacy cron treats a NULL `lastChecked` as "check immediately", and `next_check_at` is seeded one interval ahead because the worker claim treats NULL as due (NULLS FIRST). The seed is idempotent (ON CONFLICT / WHERE NOT EXISTS) — re-running never resets `lastChecked`. Every Tier-1 smoke check re-advances `lastChecked`, keeping the 24 h quiet window rolling under both engines.

**Re-drive (D-46 — `node scripts/redrive-outbox.mjs [--apply]`):** FAILED outbox rows are derived state (`sent_at IS NULL AND (payload ? '_relayFailure' OR attempts >= 3)`) and are RETAINED for the operator — the relay never revisits them. The re-drive lists them, and only with `--apply` re-marks them PENDING (`attempts = 0`, `_relayFailure` marker removed). **The dedup key is checked BEFORE any re-mark**: the relay writes `alert:{incidentId}:down|recovered` / `alert:{monitorId}:first_check` (TTL 7 d) only after a CONFIRMED send, so a held key means the human already got that alert — the row is reported and skipped, never double-sent. Default is dry-run (zero writes without `--apply`); rows that left the FAILED state concurrently are left untouched (idempotent UPDATE guard).

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
- **Baseline from live DDL:** the Phase 3 baseline is authored from `pg_dump --schema-only` of production (not `schema.prisma`). Its faithfulness was proven against the restored production snapshot (the 03-03 pull) and the migrated docker test database (the schema gate's empty diff) — not by a diff run against production itself.
- **Empty-diff check:** with no CI (D-01), the drift check is an operator-run typed step from Phase 3 on — `pnpm schema:gate`: the normalized empty-diff of `src/db/schema.ts` against a pull of the migrated docker TEST database, backed by the §3d rehearsal on real (anonymized) production data. It deliberately never targets the live production database, and this runbook claims no production-side diff command — one does not ship in the toolchain. The residual gap is drift introduced directly in production after release (e.g. a stray push from the frozen `prisma/schema.prisma`); its standing guards are the freeze warning in that file and the gate's destructive-push absence scan, and if direct-production drift is ever suspected the response is an explicitly reviewed standalone production-side pull-diff, not an assumed release step. Enforcement is operator discipline, same as the verify gate (D-02).

---

## 9. Operational secret hygiene (S-4 decision note)

> **Design rule (S-4):** no endpoint accepts secrets via query strings. Error responses never include stack traces or internal details.
>
> `CRON_SECRET` (today accepted as `?secret=` on cron routes) **retires with the cron endpoints** on a dated retirement path: repo hygiene (`.env.example`, no stack traces, no secrets in query) landed in Phase 2 (FND-07); the cron endpoints and `CRON_SECRET` themselves carry a **death date of Phase 6** — API-01 deletes the routes and SEC-06 retires the secret. *(Amended 2026-09-15, 05-Context D-38: this retirement was previously dated "at the Phase 5 overlap-verified cutover". The Phase-5 deletion release is scheduler-only — it deletes `instrumentation.ts` + `CRON_MODE` (§4a step 10) and deliberately deletes neither the routes nor the secret, converting the surviving pair into the emergency lever below. One story across REQUIREMENTS, this runbook, and the phase-5 context.)*

**The surviving emergency lever (from the Phase-5 deletion release until Phase 6).** The cron API routes — `/api/cron/check` (runs a full check pass and flushes the batcher in-request) and `/api/cron/cleanup` (the retention pass), both GET — plus `CRON_SECRET` survive **dormant**: nothing schedules them anymore (`instrumentation.ts` is gone), the engine (`cron-logic.ts`, `db-batcher.ts`) is unreachable dead code, but the operator holds a manual lever to force a full cron pass if the worker is ever down hard:

```
curl -fsS "http://127.0.0.1:3007/api/cron/check" -H "Authorization: Bearer $CRON_SECRET"
```

Prefer the `Authorization: Bearer` form — both routes accept it. The `?secret=` query-string form remains deliberately pinned as the Phase-6 red/green marker for SEC-06 (the 02-05 contract tests assert today's acceptance so Phase 6's removal is a visible behavior change); do not extend reliance on it in new tooling or docs beyond this historical note. **Death date: Phase 6** — until then the lever is part of the documented rollback posture (§4a step 11: with cron deleted, this curl is the emergency check path when the worker is paused or down).

---

## 10. Worker-host egress control (apply once — Phase 4 worker provisioning)

> **Design rule (S-1 layer 1 / audit §15.4):** the worker host denies outbound connections to the private ranges and allows public-internet egress on ports 80/443 only, with DNS and loopback/VPC-internal Postgres (5432) / Redis (6379) as the sole exceptions. The rule set is applied **once**, when the worker host is first provisioned (§4a step 1), before the worker takes production traffic — it is never part of a routine release.

1. **Apply the host-firewall egress rules.**
   - *Action:* on the worker host, apply and persist outbound firewall rules that (a) **deny** connections to the private ranges — `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, `64:ff9b::/96` — the identical range list audit §15.4 mirrors from the engine denylist (§15.1 step 4 sub-step 2); (b) **allow** outbound `80/tcp` and `443/tcp` to the public internet; (c) **allow** the exceptions — DNS resolution, and loopback/VPC-internal `5432/tcp` (Postgres) and `6379/tcp` (Redis). Make the rules survive a reboot. Concrete iptables form (Ubuntu 24.04 — pair with `iptables-persistent`/`netfilter-persistent save`; the nftables equivalent below):

     ```bash
     # IPv4 — deny the private ranges (the same 6 tokens the engine denylist carries):
     for cidr in 10/8 172.16/12 192.168/16 127/8 169.254/16 0.0.0.0/8; do
       iptables -A OUTPUT -d "$cidr" -j REJECT
     done
     # IPv6 — deny the private ranges (the remaining 5 tokens):
     for cidr in ::1 fc00::/7 fe80::/10 ::ffff:0:0/96 64:ff9b::/96; do
       ip6tables -A OUTPUT -d "$cidr" -j REJECT
     done
     # Allow public-internet egress on 80/443 only, plus loopback (worker health
     # server + local Redis/Postgres on this single-host topology):
     iptables  -A OUTPUT -p tcp -d 0.0.0.0/0 --dport 80  -j ACCEPT
     iptables  -A OUTPUT -p tcp -d 0.0.0.0/0 --dport 443 -j ACCEPT
     iptables  -A OUTPUT -o lo -j ACCEPT
     ip6tables -A OUTPUT -p tcp -d ::/0 --dport 80  -j ACCEPT
     ip6tables -A OUTPUT -p tcp -d ::/0 --dport 443 -j ACCEPT
     ip6tables -A OUTPUT -o lo -j ACCEPT
     # DNS (resolved via systemd-resolved on loopback — covered by -o lo above;
     # add an explicit UDP 53 rule only if egress DNS is used):
     # Final default-deny for everything not matched above:
     iptables  -A OUTPUT -j REJECT
     ip6tables -A OUTPUT -j REJECT
     ```

     nftables equivalent (one table, sets for the deny ranges — same tokens):

     ```bash
     nft add table inet egress
     nft add set inet egress deny4 { type ipv4_addr\; flags interval\; }
     nft add element inet egress deny4 { 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0.0.0.0/8 }
     nft add set inet egress deny6 { type ipv6_addr\; flags interval\; }
     nft add element inet egress deny6 { ::1, fc00::/7, fe80::/10, ::ffff:0:0/96, 64:ff9b::/96 }
     nft add chain inet egress out { type filter hook output priority 0\; policy drop\; }
     nft add rule inet egress out ip  daddr @deny4 reject
     nft add rule inet egress out ip6 daddr @deny6 reject
     nft add rule inet egress out tcp dport { 80, 443 } accept
     nft add rule inet egress out oif "lo" accept
     ```

   - *Verification:* from the worker host — a `curl` to a public `http://` target and a public `https://` target both succeed; a direct request to a private-range address — any `10.x.x.x`, `172.16.x.x`–`172.31.x.x`, or `192.168.x.x` host, or the link-local metadata canary `http://169.254.169.254/latest/meta-data` — is refused; a request to a public host on a non-80/443 port is refused; and the worker's `curl -fsS http://127.0.0.1:9090/readyz` stays green (the Redis + DB pings inside `readyz` prove the 6379/5432 exceptions work — §4).
   - *Rollback:* remove the rules and re-verify `readyz` stays green. The engine-layer SSRF validation (audit §15.1 step 4) remains enforced either way — the OS egress layer is defense-in-depth, so removing it never disables the primary boundary.

> **D-17 disposition (2026-09-14, plan 04-09):** the concrete rules above are AUTHORED AND VERIFIED AS TEXT ONLY. No SpiderNode worker host has existed to enforce them on yet — the Phase 4 dark launch runs on the local stand-in where no OS egress filter applies, and SEC-02's completion rides the **first VPS worker deploy**: at that deploy the operator types the command block, runs the verification probes live, and records the results in the deploy record. Until then this section's enforcement status is "text-ready, unenforced" — the engine denylist (src/lib/ssrf.ts) remains the enforced boundary.

This section is not re-run per release. If the denylist itself ever changes, audit §15.1 step 4 sub-step 2, audit §15.4, and this section must be updated in the same change — the three lists are one list, and `pnpm denylist:diff` (in the `pnpm verify` chain since plan 04-09, D-40) fails the verify on any drift between the engine export and this section.
