# 🕸️ SpiderNode — Modern Uptime Monitoring

**SpiderNode** is a premium, high-performance uptime tracking and status page application built for modern teams. It allows you to monitor your HTTP/HTTPS endpoints, track response times, manage incidents, and provide transparent public status pages to your users.

**Positioning:** The free uptime monitor with Telegram alerts — built by a developer, for developers.

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

- **🌐 Real-time HTTP/HTTPS Monitoring** — configure per-monitor check intervals; a dedicated worker process executes every check ("check now" enqueues and returns `202` instantly, results stream back via polling).
- **🚨 Incident Management** — outages open incidents, recoveries resolve them, and every transition (monitor + ping + incident + alert outbox) commits in one atomic database transaction. Exactly one Telegram alert per incident, guaranteed.
- **📊 Detailed Dashboards** — historical response times, latency averages, and uptime percentages; per-window uptime (24h/7d/30d) is recomputed nightly from ping history (display switch ships in v2).
- **📣 Public Status Pages** — shareable, read-only status pages for your customers (`/status/[id]`).
- **📱 Telegram Alerts** — connect a bot via deep link to receive instant push notifications, with webhook updates authenticated by a constant-time secret token.
- **🔐 Better Auth Authentication** — email/password (bcrypt, lazy-rehashed to the modern default on login), Google and GitHub OAuth, complete email-verification and password-reset flows — all transactional email queued off the request path.
- **🤖 AI Post-Mortems & Monitor Assistant (flagged, default off)** — with `AI_ENABLED=true`, stream an incident post-mortem draft (never auto-written to incidents) and turn a natural-language description into monitor config validated by the same schema as the manual form. Zero AI calls when the flag is off — no keys required.
- **🛡️ Production-Grade Security** — Redis-backed atomic rate limiting, SSRF-hardened checks (per-redirect-hop private-range denial, scheme allowlist, 2 MB cap, strict 10 s timeout), ownership-scoped APIs, admin surfaces gated by role + IP allowlist, and no stack traces in error responses.
- **🎨 Premium UI/UX** — light/dark/system themes on stable semantic tokens (no first-paint flash), shadcn/Radix primitives with one dialog system, Motion micro-interactions, skeleton loaders, and Sonner toasts.

---

## 🔁 The Modernization (Phases 1–8)

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

---

## 🏗️ System Architecture

Two PM2 applications built from the same repo and SHA by one `pnpm build` (Next.js for the web app, tsup for the worker bundle):

1. **Web process — `uptime-tracker`** (Next.js App Router, port `3007`)
   Stateless producer: Better Auth sessions, dashboards, public status pages. API routes enqueue work (check-now, email) and never execute a check against a target themselves. Redis-backed rate limiting fails open in dev, degrades safely in prod.

2. **Worker process — `uptime-worker`** (`dist/worker.js`, PM2 `wait_ready`, `kill_timeout` 20 s)
   Owns **all** monitoring execution on BullMQ:
   - **Scheduler tick** (30 s) claims due monitors by advancing `next_check_at` in SQL — the legacy cron endpoint no longer exists.
   - **Exactly-once guarantees** — SQL claim + schedule-epoch idempotency keys + per-monitor Redis locks (owner-only release); duplicate job delivery yields exactly one ping row.
   - **Tiered writes** — transitions (UP→DOWN, DOWN→UP, first check) commit monitor + ping + incident + outbox in one synchronous transaction; routine UP pings stage in Redis and flush via a guarded atomic update that never touches `status`.
   - **Outbox relay** — byte-parity Telegram alerts with 7-day dedup; **email lane** — SMTP/console provider with exact backoff and typed dead-lettering (registration never fails because SMTP is down).
   - **Resilience** — Postgres circuit breaker (5-fail/60 s opens and pauses enqueueing), backlog cap that drops routine checks but never transitions, bounded retries with exponential backoff + DLQ retention, SIGINT drain before SIGKILL.
   - **Maintenance** — retention cleanup with dry-run; nightly windowed-uptime recompute (04:00 UTC).
   - **Observability** — pino JSON logs correlated by `monitorId`; loopback HTTP server on `:9090`:
     | Endpoint | Purpose |
     |---|---|
     | `/healthz` | Provenance (sha, builtAt, uptime) |
     | `/readyz` | `200` only when Redis **and** Postgres answer |
     | `/metrics` | Prometheus text exposition (queue depth/age, stalled, alert latency, Redis memory) |
     | `/metrics.json` | JSON collector seed |
     | `/admin/queues` | Bull Board queue UI — admin session + IP allowlist required |

3. **PostgreSQL 17** accessed only through a single `pg` pool shared by the one Drizzle client. Schema is owned by versioned Drizzle migrations (`drizzle/0000_baseline` → `0004_windowed_uptime`) applied by the single migration runner, rehearsed against anonymized production snapshots before every schema-touching release.

4. **Redis 8** (loopback, `requirepass`, AOF `everysec`, `noeviction`) — BullMQ queues, atomic Lua rate limiting, Tier-2 staging. No correctness dependence: a Redis outage pauses monitoring by design while Postgres stays intact and users see in-product staleness ("last checked Xm ago").

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
| Testing | Vitest (unit / integration / resilience with real SIGKILL + outage injection), Playwright (e2e + AI stub specs) |

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js ≥ 22 (24 recommended) and pnpm 10 (`corepack enable`)
- Docker (Postgres + Redis) or your own instances
- Telegram bot token (optional, for alerts), SMTP credentials (optional — `EMAIL_PROVIDER=console` for dev)

### 2. Clone & Install
```bash
git clone https://github.com/mehedishubho/SPIDER_NODE-uptime-tracker.git
cd SPIDER_NODE-uptime-tracker
pnpm install
```

### 3. Local Infrastructure
Bring up the persistent dev Postgres (`:5454`):
```bash
docker compose -f docker-compose.dev.yml up -d --wait
```
Redis for local development: point `REDIS_URL` at any local Redis, or reuse the throwaway test stack (`:6390`):
```bash
docker compose -f docker-compose.test.yml up -d --wait
```

### 4. Environment Variables
Copy `.env.example` → `.env`. It is the complete environment contract — names, purposes, and per-environment examples (dev vs prod) for every variable: database, Better Auth (`BETTER_AUTH_*`, OAuth apps), Telegram (including `TELEGRAM_WEBHOOK_SECRET`), SMTP/`EMAIL_PROVIDER`, `REDIS_URL`, worker settings (`WORKER_SCHEDULER_ENABLED`, `WORKER_HEALTH_PORT`, dead-man switch URLs), and the flagged capabilities (`AI_ENABLED` + `AI_PROVIDER`/`AI_MODEL`/`AI_API_KEY`, `WINDOWED_UPTIME_ENABLED`).

Minimum for local dev:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5454/uptime_dev"
BETTER_AUTH_SECRET="<any long random string>"
BETTER_AUTH_URL="http://localhost:3007"
REDIS_URL="redis://localhost:6390"
```

### 5. Database Setup
Apply the versioned Drizzle migrations with the single runner:
```bash
pnpm exec drizzle-kit migrate
```

### 6. Run
Two processes in development:
```bash
pnpm dev          # web app on http://localhost:3007
pnpm dev:worker   # monitoring worker (tsx watch) — health on :9090
```
For local checking to run, the worker must be up with `WORKER_SCHEDULER_ENABLED=true`.

---

## ⚙️ How Automated Checks Run

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
`pnpm verify` is the operator-run gate before every deploy — including the empty-diff schema gate (no silent Drizzle drift) and the worker-boundary gate (no monitoring execution leaks back into web).

---

## 🏭 Production Deployment

Two PM2 apps from one build (`pnpm build` → Next.js + `dist/worker.js`), defined in `ecosystem.config.js`:

```bash
pm2 start ecosystem.config.js --only uptime-worker   # first: worker waits for readyz
pm2 start ecosystem.config.js --only uptime-tracker  # then: web
```

The deploy sequence (build → backup → migrate → worker restart → web restart → smoke check with a synthetic ping) with per-step rollback, connection budgets (web 10 / worker 20 / migrations 1), Redis hardening, and release choreography is documented in **[`docs/DEPLOY-RUNBOOK.md`](docs/DEPLOY-RUNBOOK.md)**.

| Port | Service |
|---|---|
| `3007` | Web app (Next.js) |
| `9090` | Worker HTTP — `/healthz`, `/readyz`, `/metrics`, `/admin/queues` |
| `5454` | Dev Postgres (docker-compose.dev.yml) |
| `6379` | Production Redis (loopback, requirepass) |

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License.
