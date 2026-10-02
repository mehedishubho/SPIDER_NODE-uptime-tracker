<div align="center">

# 🕸️ SpiderNode

**Modern, self-hosted uptime monitoring — dashboards, public status pages, incident management, and instant Telegram alerts.**

Built for developers who want honest, transparent monitoring without the enterprise price tag.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-8-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Better Auth](https://img.shields.io/badge/Auth-Better_Auth-6C47FF)](https://www.better-auth.com/)

</div>

---

**SpiderNode** monitors your HTTP/HTTPS endpoints, tracks response times, manages incidents, and gives your users transparent public status pages. A dedicated worker process owns all checking — the web app stays fast and stateless, and every state transition is atomic.

### Dashboard
![SpiderNode Dashboard](root_images/Screenshot.png)

### Public Status Page
![Status Page](root_images/Screenshot_3.png)

### Incident Management
![Incident Log](root_images/Screenshot_2.png)

### Instant Telegram Alerts
![Telegram Alerts](root_images/Screenshot_1.png)

---

## ✨ Features

- **🌐 Real-time HTTP/HTTPS Monitoring** — per-monitor check intervals; a dedicated worker process executes every check ("check now" enqueues and returns `202` instantly, results stream back via polling).
- **🚨 Incident Management** — outages open incidents, recoveries resolve them, and every transition (monitor + ping + incident + alert outbox) commits in one atomic database transaction. Exactly one Telegram alert per incident, guaranteed.
- **📊 Detailed Dashboards** — historical response times, latency averages, and uptime percentages; per-window uptime (24h/7d/30d) is recomputed nightly from ping history.
- **📣 Public Status Pages** — shareable, read-only status pages for your customers (`/status/[id]`).
- **📱 Telegram Alerts** — connect a bot via deep link to receive instant push notifications, with webhook updates authenticated by a constant-time secret token.
- **🔐 Better Auth Authentication** — email/password, Google and GitHub OAuth, complete email-verification and password-reset flows — all transactional email queued off the request path.
- **🤖 AI Post-Mortems & Monitor Assistant (flagged, default off)** — with `AI_ENABLED=true`, stream an incident post-mortem draft (never auto-written to incidents) and turn a natural-language description into monitor config validated by the same schema as the manual form. Zero AI calls when the flag is off — no keys required.
- **🛡️ Production-Grade Security** — Redis-backed atomic rate limiting, SSRF-hardened checks (per-redirect-hop private-range denial, scheme allowlist, 2 MB cap, strict 10 s timeout), ownership-scoped APIs, admin surfaces gated by role + IP allowlist, and no stack traces in error responses.
- **🎨 Premium UI/UX** — light/dark/system themes on stable semantic tokens (no first-paint flash), shadcn/Radix primitives, Motion micro-interactions, skeleton loaders, and Sonner toasts.

---

## 🏗️ System Architecture

Two PM2 applications built from the same repo and SHA by one `pnpm build` (Next.js for the web app, tsup for the worker bundle):

1. **Web process — `uptime-tracker`** (Next.js App Router, port `3007`)
   Stateless producer: Better Auth sessions, dashboards, public status pages. API routes enqueue work (check-now, email) and never execute a check against a target themselves. Redis-backed rate limiting fails open in dev, degrades safely in prod.

2. **Worker process — `uptime-worker`** (`dist/worker.js`, PM2 `wait_ready`, `kill_timeout` 20 s)
   Owns **all** monitoring execution on BullMQ:
   - **Scheduler tick** (30 s) claims due monitors by advancing `next_check_at` in SQL — there is no cron endpoint.
   - **Exactly-once guarantees** — SQL claim + schedule-epoch idempotency keys + per-monitor Redis locks (owner-only release); duplicate job delivery yields exactly one ping row.
   - **Tiered writes** — transitions (UP→DOWN, DOWN→UP, first check) commit monitor + ping + incident + outbox in one synchronous transaction; routine UP pings stage in Redis and flush via a guarded atomic update that never touches `status`.
   - **Outbox relay** — byte-parity Telegram alerts with 7-day dedup; **email lane** — SMTP/console provider with bounded backoff and typed dead-lettering (registration never fails because SMTP is down).
   - **Resilience** — Postgres circuit breaker (5-fail/60 s opens and pauses enqueueing), backlog cap that drops routine checks but never transitions, bounded retries with exponential backoff + DLQ retention, graceful drain before SIGKILL.
   - **Maintenance** — retention cleanup with dry-run; nightly windowed-uptime recompute (04:00 UTC).
   - **Observability** — pino JSON logs correlated by `monitorId`; loopback HTTP server on `:9090`:

   | Endpoint | Purpose |
   |---|---|
   | `/healthz` | Provenance (sha, builtAt, uptime) |
   | `/readyz` | `200` only when Redis **and** Postgres answer |
   | `/metrics` | Prometheus text exposition (queue depth/age, stalled, alert latency, Redis memory) |
   | `/metrics.json` | JSON collector seed |
   | `/admin/queues` | Bull Board queue UI — admin session + IP allowlist required |

3. **PostgreSQL 17** accessed only through a single `pg` pool shared by the one Drizzle client. Schema is owned by versioned Drizzle migrations applied by the single migration runner.

4. **Redis 8** (loopback, `requirepass`, AOF `everysec`, `noeviction` in prod) — BullMQ queues, atomic Lua rate limiting, Tier-2 staging. No correctness dependence: a Redis outage pauses monitoring by design while Postgres stays intact and users see in-product staleness ("last checked Xm ago").

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org/) (App Router + Turbopack, React Compiler) |
| Runtime | Node.js ≥ 22 (24 pinned in dev/production), pnpm 10 |
| Database | [PostgreSQL 17](https://www.postgresql.org/) |
| ORM | [Drizzle ORM](https://orm.drizzle.team/) + drizzle-kit (versioned migrations) |
| Queues / Jobs | [BullMQ 6](https://bullmq.io/) + [ioredis 6](https://github.com/redis/ioredis) on [Redis 8](https://redis.io/) |
| Worker HTTP | [Hono](https://hono.dev/) (`:9090` health/readiness/metrics + [Bull Board](https://www.bullmq.io/) at `/admin/queues`) |
| Authentication | [Better Auth](https://www.better-auth.com/) (credentials + Google/GitHub, admin plugin, Redis session storage) |
| AI (flagged) | [Vercel AI SDK](https://sdk.vercel.ai/) — Z.ai GLM default, OpenAI/Anthropic/custom-endpoint factories, env-swappable |
| Validation | [Zod 4](https://zod.dev/) (same schema validates manual form and AI-generated config) |
| State (client) | Redux Toolkit + Redux Persist |
| Styling / UI | [Tailwind CSS v4](https://tailwindcss.com/) semantic tokens, shadcn/Radix primitives, Motion, Sonner, Hugeicons |
| Transactional Email | Nodemailer behind a queue + provider interface (`smtp` / `console`) |
| Observability | pino JSON logs, Prometheus metrics, healthchecks.io dead-man switches (heartbeat / outbox age / Redis memory) |
| Process Manager | PM2 — `uptime-tracker` (web) + `uptime-worker`, graceful drain |
| Testing | Vitest (unit / integration / resilience with real SIGKILL + outage injection), Playwright (e2e) |

---

## 🚀 Installation & Setup

This guide takes you from zero to a fully running local installation. Every command has been verified against the repository's actual scripts and compose files.

### At a Glance (Quick Start)

Already comfortable? Here is the whole thing:

```bash
git clone https://github.com/mehedishubho/SPIDER_NODE-uptime-tracker.git
cd SPIDER_NODE-uptime-tracker
corepack enable && pnpm install
docker compose -f docker-compose.dev.yml up -d --wait    # Postgres :5454
docker compose -f docker-compose.test.yml up -d --wait   # Postgres :5453 + Redis :6390
cp .env.example .env                                     # then fill in the minimum below
pnpm exec drizzle-kit migrate
pnpm dev          # terminal 1 — web on http://localhost:3007
pnpm dev:worker   # terminal 2 — monitoring worker, health on http://localhost:9090
```

> **Windows:** run the commands from Git Bash or WSL, and use `Copy-Item .env.example .env` in PowerShell instead of `cp`.

### Step 1 — Prerequisites

| Tool | Version | Verify with | Notes |
|---|---|---|---|
| Node.js | ≥ 22 and < 25 (24 recommended) | `node -v` | Enforced by `package.json` `engines` |
| pnpm | 10.34.x | `pnpm -v` | Enable via `corepack enable` — Corepack ships with Node and reads the pinned version from `packageManager` |
| Docker + Compose v2 | recent | `docker compose version` | Hosts Postgres and Redis locally; or point the env at your own instances |
| Git | recent | `git --version` | — |

**Optional (can all be added later via `.env`):**
- **Telegram bot token** — for push alerts (create a bot with [@BotFather](https://t.me/BotFather)).
- **SMTP credentials** — for real verification/reset emails. Not needed in dev: set `EMAIL_PROVIDER=console` and emails print to the worker's stdout instead.
- **Google / GitHub OAuth app credentials** — for social login.
- **An AI provider key** (Z.ai GLM / OpenAI / Anthropic / any OpenAI-compatible endpoint) — only if you flip `AI_ENABLED=true`.

### Step 2 — Clone & Install

```bash
git clone https://github.com/mehedishubho/SPIDER_NODE-uptime-tracker.git
cd SPIDER_NODE-uptime-tracker
corepack enable
pnpm install
```

The lockfile is `pnpm-lock.yaml` (exact-frozen) — use pnpm, not npm, so the dependency graph matches what CI verifies.

### Step 3 — Local Infrastructure (Docker)

Bring up the **persistent dev Postgres** (port `5454`, database `uptime_dev`, user/password `postgres`/`postgres`):

```bash
docker compose -f docker-compose.dev.yml up -d --wait
```

Bring up the **dev Redis** (and the throwaway test Postgres used by the suite) from the test stack:

```bash
docker compose -f docker-compose.test.yml up -d --wait
```

| Service | Container | Port | Used for |
|---|---|---|---|
| PostgreSQL 17 (dev) | `spidernode-dev-db` | `5454` | Your data — persists across restarts (named volume) |
| PostgreSQL 17 (test) | `spidernode-test-db` | `5453` | Truncated by the test suite on every run |
| Redis 8 | `spidernode-test-redis` | `6390` | BullMQ queues + rate limiting in dev |

Ports are deliberately offset from the standard 5432/6379 so the stacks can never collide with — or be mistaken for — a real database on your machine.

Useful lifecycle commands:

```bash
docker compose -f docker-compose.dev.yml down        # stop, keep data
docker compose -f docker-compose.dev.yml down -v     # stop and WIPE dev data
docker compose -f docker-compose.test.yml down       # stop the test stack
```

### Step 4 — Configure Environment Variables

```bash
cp .env.example .env
```

`.env.example` **is the complete environment contract** — every variable with its name, purpose, and dev-vs-prod notes. Copy it and fill in values.

**Minimum for local development:**

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5454/uptime_dev"
BETTER_AUTH_SECRET="<any long random string — 64+ chars; openssl rand -base64 48>"
BETTER_AUTH_URL="http://localhost:3007"
REDIS_URL="redis://localhost:6390"
WORKER_SCHEDULER_ENABLED="true"
EMAIL_PROVIDER="console"
```

| Variable | Why |
|---|---|
| `DATABASE_URL` | The one Postgres connection string used by the single Drizzle client. |
| `BETTER_AUTH_SECRET` | Signs Better Auth session cookies and the cookie-cache JWT. |
| `BETTER_AUTH_URL` | Canonical public base URL — OAuth callbacks and email link domain. |
| `REDIS_URL` | BullMQ + rate limiting. Required for the **worker**; the web app alone degrades gracefully without it in dev. |
| `WORKER_SCHEDULER_ENABLED` | Must be `"true"` or the worker boots but never schedules checks. |
| `EMAIL_PROVIDER` | `"console"` prints emails to stdout in dev — no SMTP needed. Use `"smtp"` in production. |

Everything else (OAuth, Telegram, Cloudinary, AI, dead-man switches) is **optional and off by default** — see the [full reference](#environment-variable-reference) below.

### Step 5 — Apply Database Migrations

```bash
pnpm exec drizzle-kit migrate
```

This applies the versioned SQL migrations in order (`drizzle/0000_baseline` → `0004_windowed_uptime`) to the database in `DATABASE_URL`. Re-run it after pulling — new releases may add migrations.

### Step 6 — Create the First Admin Account

New users register with the default `user` role. To promote yourself to admin (unlocks Bull Board access alongside `ADMIN_IP_ALLOWLIST`):

1. Start the app (Step 7) and **register your account** through the UI.
2. In `.env`, set the roster: `ADMIN_EMAILS="you@example.com"` (comma-separated for several).
3. Run the seeding script — it honors `.env` via `dotenv/config`:

   ```bash
   node scripts/seed-admin-roles.mjs
   ```

The script is fail-loud by design: it grants nothing (exits non-zero) if `ADMIN_EMAILS` is missing/empty or matches zero users, and it never echoes emails or connection strings.

### Step 7 — Run the App

Two processes, two terminals:

```bash
pnpm dev          # web app — Next.js dev server on http://localhost:3007
pnpm dev:worker   # monitoring worker — tsx watch, health endpoint on http://localhost:9090
```

| URL | What you should see |
|---|---|
| `http://localhost:3007` | The app — landing page, register/login, dashboard |
| `http://localhost:9090/healthz` | Worker provenance JSON (sha, builtAt, uptime) |
| `http://localhost:9090/readyz` | `200` once the worker can reach Postgres **and** Redis |
| `http://localhost:9090/metrics` | Prometheus metrics |

### Step 8 — Verify the Installation

1. Open `http://localhost:3007`, register an account, and confirm the console email (with `EMAIL_PROVIDER=console`, the verification message is printed by the worker's stdout).
2. Create a monitor pointing at any public URL (e.g. `https://github.com`).
3. Within ~30 s the scheduler tick should claim it — watch the dashboard show its first ping, or hit the monitor's "Check now".
4. `curl http://localhost:9090/readyz` → `200` confirms the worker's DB + Redis wiring end-to-end.

If all four pass, your installation is complete. 🎉

<a id="environment-variable-reference"></a>
### Environment Variable Reference

Everything below is also documented inline in `.env.example` — that file remains the authoritative contract.

**Core**

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (Neon-compatible) for the single Drizzle client. |
| `REDIS_URL` | ✅ (worker) | Redis for BullMQ queues, rate limiting, and Tier-2 staging. Dev web app fails open without it; prod uses `redis://:pass@127.0.0.1:6379`. |
| `NEXT_PUBLIC_ENV` | — | `"production"` or anything else; selects which client base URL is used. |
| `NEXT_PUBLIC_BASE_URL` / `NEXT_PUBLIC_DEV_BASE_URL` | — | API base URLs for client fetches in prod / dev respectively. |

**Auth (Better Auth)**

| Variable | Required | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | ✅ | Signs session cookies and the cookie-cache JWT. |
| `BETTER_AUTH_URL` | ✅ | Canonical public base URL (OAuth callbacks, `/api/auth` catch-all, email links). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | GitHub OAuth. |
| `ADMIN_EMAILS` | — | Comma-separated admin roster for `scripts/seed-admin-roles.mjs`. Read only by that script — fail-loud if empty or zero-match. |
| `ADMIN_IP_ALLOWLIST` | — | Comma-separated IPs/CIDRs allowed to open Bull Board (`/admin/queues`). Empty = allow nobody. |

**Telegram alerts**

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Sends alert messages and polls the connect webhook. |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | — | Bot username for the browser "connect to Telegram" deep link. |
| `TELEGRAM_WEBHOOK_SECRET` | — | Authenticates the Telegram webhook origin (`X-Telegram-Bot-Api-Secret-Token`); register once via `setWebhook`. |

**Email**

| Variable | Required | Purpose |
|---|---|---|
| `EMAIL_PROVIDER` | — | `"smtp"` (default when unset) or `"console"` (dev — prints full dump to worker stdout). Unknown values fail loud at worker boot. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | SMTP transport credentials for the queued transactional email provider. |

**Media / integrations**

| Variable | Required | Purpose |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | — | Profile avatar uploads. |

**Worker**

| Variable | Required | Purpose |
|---|---|---|
| `WORKER_SCHEDULER_ENABLED` | ✅ for monitoring | Master switch for the check-tick and maintenance schedulers. `"true"` to actually monitor. |
| `WORKER_HEALTH_PORT` | — | Loopback health port (`:9090` per the runbook). |
| `WORKER_LOG_LEVEL` | — | pino log level for the worker (JSON lines on stdout). |
| `WORKER_HC_PING_URL` | — | healthchecks.io heartbeat — pinged each tick; stops pinging (pages you) on tick failure. |
| `WORKER_OUTBOX_HC_PING_URL` | — | healthchecks.io dead-man switch for outbox relay health. |
| `WORKER_MEMORY_HC_PING_URL` | — | healthchecks.io dead-man switch for Redis memory (< 70% of maxmemory). |

**Flagged capabilities (all default off)**

| Variable | Required | Purpose |
|---|---|---|
| `WINDOWED_UPTIME_ENABLED` | — | Only the literal `"true"` enables **reads** of the per-window uptime columns. The nightly job populates them unconditionally regardless. |
| `AI_ENABLED` | — | Only the literal `"true"` enables the AI post-mortem + monitor assistant. Server-side only — never a `NEXT_PUBLIC_*`. |
| `AI_PROVIDER` | — | `"glm"` \| `"openai"` \| `"anthropic"` \| `"custom"`. Incomplete/unknown values fail loud at first use. |
| `AI_MODEL` | — | Provider model id (e.g. `glm-4.6`). One model serves both features. |
| `AI_API_KEY` | — | Provider API key. Never reaches the client bundle. |
| `AI_BASE_URL` | — | Custom OpenAI-compatible endpoint — required only when `AI_PROVIDER=custom`. |

---

## 🔁 How Automated Checks Run

There is no cron endpoint to ping — monitoring is fully self-scheduled. The worker's scheduler tick (default every 30 s) claims every monitor whose `next_check_at` is due, enqueues check jobs, and the worker executes them: SSRF-hardened fetch → classification → tiered write → outbox alert. If you want an external dead-man's switch, configure the `WORKER_HC_PING_URL` / `WORKER_OUTBOX_HC_PING_URL` / `WORKER_MEMORY_HC_PING_URL` healthchecks.io checks — the worker pings them on each tick and stops (paging you) when the heartbeat, outbox relay, or Redis memory crosses its grace.

---

## 🧪 Testing & Verification

```bash
pnpm test              # Vitest unit + integration (real Postgres/Redis via the test stack)
pnpm test:e2e          # Playwright end-to-end
pnpm test:resilience   # failure injection: real SIGKILL mid-job, Postgres/Redis outage both directions
pnpm rehearse:migrations  # migration rehearsal against a prod snapshot (row-count + checksum verify)
pnpm verify            # the full gate chain: test stack up → lint → typecheck → test → schema gate
                       # → worker boundary → denylist diff → build → cron-remnant scan → e2e
```

`pnpm verify` is the operator-run gate before every deploy — including the empty-diff schema gate (no silent Drizzle drift) and the worker-boundary gate (no monitoring execution leaks back into web). The Vitest and resilience suites need the test stack running (`docker compose -f docker-compose.test.yml up -d --wait`).

---

## 🏭 Production Deployment

Two PM2 apps from one build (`pnpm build` → Next.js + `dist/worker.js`), defined in `ecosystem.config.js`:

```bash
pm2 start ecosystem.config.js --only uptime-worker   # first: worker waits for readyz
pm2 start ecosystem.config.js --only uptime-tracker  # then: web
```

> **Note:** `ecosystem.config.js` pins `cwd: "/var/www/uptime-tracker"` — change it to your actual deployment path (or manage the file per-server).

The deploy sequence (build → backup → migrate → worker restart → web restart → smoke check with a synthetic ping) with per-step rollback, connection budgets (web 10 / worker 20 / migrations 1), Redis hardening, and release choreography is documented in **[`docs/DEPLOY-RUNBOOK.md`](docs/DEPLOY-RUNBOOK.md)**.

| Port | Service |
|---|---|
| `3007` | Web app (Next.js) |
| `9090` | Worker HTTP — `/healthz`, `/readyz`, `/metrics`, `/admin/queues` |
| `5454` | Dev Postgres (`docker-compose.dev.yml`) |
| `5453` | Test Postgres (`docker-compose.test.yml`) |
| `6390` | Dev Redis (`docker-compose.test.yml`) |
| `6379` | Production Redis (loopback, `requirepass`) |

---

## 📁 Project Structure

```
├── src/
│   ├── app/                 # Next.js App Router — pages, API routes, public status pages
│   ├── components/          # UI — dashboard, auth, landing, common, shadcn/ui primitives
│   ├── worker/              # The dedicated BullMQ monitoring worker (scheduler, checks, outbox, health)
│   ├── db/                  # Single Drizzle client + schema (the shared pg pool)
│   ├── lib/                 # Better Auth, Redis, Telegram, email providers, AI providers
│   └── redux/               # Client state (RTK + persist, API base URL selection)
├── drizzle/                 # Versioned SQL migrations (0000_baseline → 0004_windowed_uptime)
├── docs/                    # DEPLOY-RUNBOOK, architecture review & audit
├── scripts/                 # Ops tooling — verify gates, migration rehearsal, admin seeding, smoke tests
├── docker-compose.dev.yml   # Persistent dev Postgres (:5454)
├── docker-compose.test.yml  # Test stack — Postgres (:5453) + Redis (:6390)
└── ecosystem.config.js      # PM2 process definitions (web + worker)
```

---

## 🩺 Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `pnpm: command not found` | Corepack isn't enabled: `corepack enable` (then reopen the shell). pnpm 10 is pinned via `packageManager`. |
| `Unsupported engine` warning on `pnpm install` | Node must be **≥ 22 and < 25**. Install Node 24 (`nvm install 24 && nvm use 24`). |
| Postgres/Redis already listening on 5454/6390 | The offset ports are shared across this project's stacks — `docker ps` to see what's holding them; stop the conflicting container or point `DATABASE_URL`/`REDIS_URL` at the running one. |
| Worker is up but no checks ever run | `WORKER_SCHEDULER_ENABLED` isn't `"true"` — without it the worker boots consumers/health only and intentionally schedules nothing. |
| Web app boots without Redis in dev | Expected: rate limiting fails open in dev. The **worker** still requires Redis for BullMQ — set `REDIS_URL` and start the test stack. |
| `403` on `/admin/queues` (Bull Board) | Two gates: you must be logged in as an `admin` **and** your IP must be in `ADMIN_IP_ALLOWLIST`. Empty allowlist = nobody, by design. |
| `drizzle-kit migrate` fails | The dev stack isn't up or `DATABASE_URL` points elsewhere — `docker compose -f docker-compose.dev.yml up -d --wait` first, then re-check `.env`. |
| No verification email arrives | With `EMAIL_PROVIDER=console` emails print to the **worker's** stdout (not the web terminal) — check the `pnpm dev:worker` output. |
| `pnpm build` fails on Windows | `NODE_OPTIONS` inline env syntax needs a POSIX shell — run builds from Git Bash or WSL, not cmd/PowerShell. |

---

## 📚 Documentation

- [`docs/DEPLOY-RUNBOOK.md`](docs/DEPLOY-RUNBOOK.md) — production deploy sequence, rollback, Redis hardening, release choreography
- [`docs/ARCHITECTURE-REVIEW.md`](docs/ARCHITECTURE-REVIEW.md) — architecture review record
- [`docs/ARCHITECTURE-AUDIT.md`](docs/ARCHITECTURE-AUDIT.md) — architecture audit record
- [`.env.example`](.env.example) — the complete environment contract

<details>
<summary><strong>🕰️ Project History — the 8-phase modernization (click to expand)</strong></summary>

This codebase went through a full brownfield backend modernization of the live production service — every phase shipped a complete, revertible increment while monitoring never stopped, lost data, or locked a user out:

| Phase | What changed |
|---|---|
| **1. Design Gate** | Adversarially re-reviewed design addenda for every correctness mechanism *before* any code — verdict flipped to READY through two clean review cycles |
| **2. Foundations** | pnpm + exact-freeze lockfile, the `pnpm verify` gate chain, characterization tests against real Postgres/Redis, stable theme tokens |
| **3. Redis & Schema Ownership** | Redis for rate limiting with **zero correctness dependence**; database schema re-owned by versioned Drizzle migrations baselined from the live production DDL |
| **4. Monitoring Worker** | All checking moved into a dedicated BullMQ worker process (idempotent claims, per-monitor locks, circuit breaker, bounded retries + DLQ), dark-launched alongside the legacy cron |
| **5. Worker Cutover** | Gated overlap window with idempotent co-run and alert parity, then the cron was deleted — the worker is the only monitoring path; healthchecks.io dead-man switches + Prometheus metrics added |
| **6. Thin API & Email** | Web routes became enqueue-only producers (Redis down → loud `503`, never a silent no-op); transactional email moved behind a provider interface onto a queue with bounded backoff |
| **7. Better Auth Cutover** | Canary-proved auth swap onto the existing tables — zero lockouts, social accounts and hashes preserved; admin roles + gated Bull Board; **NextAuth and Prisma fully removed**, every read path on Drizzle |
| **8. Flagged Capabilities & UI** | AI post-mortem/assistant and windowed-uptime compute behind default-off flags; full visual redesign on stable tokens with an intentional light mode |

</details>

---

## 🤝 Contributing

Contributions are welcome! Please feel free to open an issue or submit a Pull Request. For larger changes, run `pnpm verify` locally first — it is the same gate CI expects.

## 📄 License

This project is licensed under the [MIT License](LICENSE).
