# SpiderNode — Architecture Audit

> **Repository:** SPIDER_NODE-uptime-tracker
> **Audit date:** 2026-09-08
> **Scope:** Full-repository inspection (backend, frontend, data layer, jobs, deployment) in preparation for the modernization to Next.js 16 App Router + Drizzle + Better Auth + Redis + BullMQ + dedicated monitoring worker.
> **Status of this document:** Audit + target architecture proposal. **No application code was modified.**
> **Amendment note:** This document was amended on 2026-09-09 to incorporate the design addenda required by [ARCHITECTURE-REVIEW.md](./ARCHITECTURE-REVIEW.md) §8. Amendment markers appear inline as "Amended 2026-09-09 (resolves &lt;issue-ids&gt;)".

---

## Executive Summary

SpiderNode is a single-process Next.js 16 application that is simultaneously the marketing site, the dashboard SPA-ish frontend, the REST API, **and the monitoring engine**. Monitoring runs on `node-cron` inside the web process (`instrumentation.ts`), performs HTTP checks inline, dispatches Telegram alerts inline, and writes results either immediately (status changes) or into a **process-local, in-memory write-behind buffer** (`db-batcher.ts`) flushed every 15 minutes.

This design has five structural problems the migration must fix:

1. **Monitoring state is process-local** — the batching buffer, the cron scheduler, and the rate limiter all live in memory. A crash loses up to 15 minutes of pings; scaling to >1 instance duplicates every check.
2. **No durability or retries** — failed flushes drop batches by design ("losing a few routine UP pings is generally acceptable", per the code comment). There is no retry, no backoff, no lock.
3. **Status transitions are not prioritized** — DOWN/RECOVERED, incident creation, and alerting are processed inline with the same concurrency and failure semantics as routine UP checks.
4. **No idempotency or locking** — two triggers (internal cron + external Vercel Cron or the manual check endpoint) can check the same monitor concurrently and double-count stats.
5. **The web process does heavy work** — HTTP fetches with 10s timeouts, Telegram calls, and daily `DELETE` scans all run inside request handlers or the web server loop.

The target architecture resolves each with Redis + BullMQ + a dedicated worker process, keeping **PostgreSQL as the sole source of truth**, and moves email behind a provider abstraction and AI strictly off the critical path.

### Current vs. target stack at a glance

| Concern | Current | Target |
|---|---|---|
| Framework | Next.js 16 (App Router, `next start` on VPS) | Next.js 16.3 (App Router, web-only) |
| ORM | Prisma 7 (`@prisma/adapter-pg` + `pg` Pool) | Drizzle ORM |
| Auth | NextAuth v4 (`@auth/prisma-adapter`, JWT sessions) | Better Auth |
| Scheduler | `node-cron` inside web process / Vercel Cron HTTP trigger | BullMQ repeatable jobs + worker |
| Batching | In-memory arrays/Map in web process | Redis-backed aggregation + durable queues |
| Worker | None (web process) | Dedicated Node worker process (PM2 app) |
| Email | Nodemailer → Hostinger SMTP (hardcoded) | Provider abstraction (SMTP / Resend / SES…) |
| Alerts | Telegram (inline fetch, no retry) | Alert job queue with retries; Telegram + email channels |
| AI | None | Vercel AI SDK (async, non-critical path only) |
| State | Redux Toolkit + Redux Persist (localStorage) | Redux Toolkit + Redux Persist (kept, pruned) |
| UI | Tailwind v4, shadcn/ui (partial), Radix, Motion, Sonner, Hugeicons + react-icons | Same, formalized; light/dark theme infra |
| Package manager | npm (`package-lock.json`) | pnpm |
| Tests | None | Unit + integration + E2E (see §23) |

---

## 1. Current Architecture

### 1.1 Process topology

A **single Node process** (PM2 app `uptime-tracker`, [ecosystem.config.js](../ecosystem.config.js)) runs `next start -p 3007`. Inside that process:

- **HTTP server** — all pages and all `/api/*` route handlers.
- **Scheduler** — [src/instrumentation.ts](../src/instrumentation.ts) registers three `node-cron` schedules at server boot (`register()` hook):
  - `* * * * *` → monitor checks ([src/lib/cron-logic.ts](../src/lib/cron-logic.ts))
  - `*/15 * * * *` → flush in-memory batch to Postgres ([src/lib/db-batcher.ts](../src/lib/db-batcher.ts))
  - `0 0 * * *` → daily cleanup ([src/lib/cleanup-logic.ts](../src/lib/cleanup-logic.ts))
- **Write-behind buffer** — module-scope arrays/Maps in `db-batcher.ts`.
- **Rate limiter** — module-scope `Map` ([src/lib/rate-limit.ts](../src/lib/rate-limit.ts)).
- **Dead man's switch** — heartbeat to healthchecks.io (`HC_PING_URL`) after each internal cron tick.

`instrumentation.ts` supports a dual-cron strategy: `CRON_MODE=vercel` disables internal cron entirely (Vercel Cron calls `GET /api/cron/check` externally); `CRON_MODE=internal` (default) is VPS-native. Note that in `vercel` mode the internal 15-minute flusher and daily cleanup schedules are also disabled — the check route compensates by flushing inline ([src/app/api/cron/check/route.ts:34-37](../src/app/api/cron/check/route.ts#L34-L37)), but cleanup then depends on an external trigger of `/api/cron/cleanup`.

### 1.2 Source layout

```
src/
  app/
    (authLayout)/        login, register, forgot/reset password, verify-email
    (commonLayout)/      marketing pages, docs, legal, /status public page
    (dashboardLayout)/   /dashboard (monitors, incidents, monitor detail, profile, status)
    api/
      auth/[...nextauth] NextAuth v4 catch-all
      auth/*             register, verify-email, forgot-password, reset-password (custom routes)
      cron/check         protected monitor-check trigger (CRON_SECRET)
      cron/cleanup       protected cleanup trigger (CRON_SECRET)
      monitors[...]      CRUD + manual check + details (session-guarded)
      incidents          list incidents for user
      status             session status data; /api/status/[userId] public status page
      telegram           connect-link, webhook, test
      user/profile       profile GET/PATCH/DELETE (Cloudinary avatar upload)
      feedback           create + list (no role gating)
  components/            Auth/, Dashboard/, dashboardLayout/, home/, Features/, Pages/, common/, ui/ (shadcn), form/, Others/
  lib/                   prisma, auth, cron-logic, db-batcher, cleanup-logic, mail, telegram, tokens, rate-limit, utils
  redux/                 store (persisted), Provider, features/auth/authSlice, api/baseApi (RTK Query)
  providers/AuthProvider.tsx
  proxy.ts               Next 16 middleware (proxy) — guards /dashboard/*
  instrumentation.ts     node-cron bootstrap
prisma/schema.prisma     9 models (see §10)
```

### 1.3 Dependencies of note

- `next ^16.0.10`, `react ^19.2.3` (React Compiler enabled in [next.config.ts](../next.config.ts))
- `@prisma/client ^7.9.1` + `@prisma/adapter-pg` + `pg` (driver adapter; generated client in `src/generated/prisma`, gitignored)
- `next-auth ^4.24.15` + `@auth/prisma-adapter`, `bcryptjs`
- `node-cron ^4.6.0`, `nodemailer ^7`, `cloudinary ^2`
- `@reduxjs/toolkit ^2.9.2`, `react-redux ^9`, `redux-persist ^6`
- `tailwindcss ^4`, `radix-ui`, `motion ^12` (Framer Motion package `motion`), `sonner`, `sweetalert2`, `hugeicons-react`, `react-icons`, `react-hook-form`, `@lottiefiles/dotlottie-react`
- **No Redis, BullMQ, ioredis, Drizzle, Better Auth, or AI SDK packages exist yet.**

---

## 2. Current Request Flow

**Browser → PM2 (next start :3007) → Next.js route handler → Prisma → Postgres.**

1. `GET /dashboard/*` → [src/proxy.ts](../src/proxy.ts) (Next 16's renamed middleware) validates the NextAuth JWT (`getToken`) and redirects unauthenticated users to `/login?callbackUrl=…`. Matcher: `/dashboard/:path*` only.
2. Dashboard client components call session-guarded REST endpoints via `fetch` (most) or RTK Query (`baseApi`) with `credentials: "include"`:
   - `GET/POST /api/monitors` — list/create (10-monitor free-tier cap enforced in code)
   - `GET/PATCH/DELETE /api/monitors/[id]` — read/update/delete, ownership-checked
   - `POST /api/monitors/[id]/check` — **synchronous** manual check (runs the whole cron pipeline for one monitor, then force-flushes)
   - `GET /api/monitors/[id]/details` — monitor + last 100 pings + last 20 incidents
   - `GET /api/incidents`, `GET /api/status`, `GET/PATCH/DELETE /api/user/profile`, `POST/GET /api/feedback`
3. Every handler re-checks `getServerSession(authOptions)` — there is no shared auth helper/middleware for APIs.
4. Public: `GET /api/status/[userId]` returns the user's active monitors (incl. URLs) + ongoing incidents, no auth. `GET /api/cron/*` guarded by `CRON_SECRET` (Bearer header **or** `?secret=` query param).
5. Mutating side effects that belong in the background happen **inside requests**: registration awaits SMTP send; manual monitor check awaits the full fetch + possible Telegram call.

Notable sharp edges in the current request flow:

- `POST /api/monitors/[id]/check` has **no rate limit** and runs a forced check end-to-end in the request → user-spammable load and a doubles-check hazard against the cron cycle (no lock).
- `/api/cron/*` error responses return `err.stack` to the caller ([src/app/api/cron/check/route.ts:44-47](../src/app/api/cron/check/route.ts#L44-L47)).
- `GET /api/feedback` returns **all users'** feedback including names/emails to any authenticated user (no admin role concept exists).
- `baseApi.ts` throws at module import if `NEXT_PUBLIC_BASE_URL` is unset — a build/prerender hazard.

---

## 3. Current Monitoring Flow

Single function, [src/lib/cron-logic.ts](../src/lib/cron-logic.ts) → `runCronChecks(force?, specificMonitorId?)`:

1. **Select:** `prisma.monitor.findMany({ isActive: true, include: user { telegramChatId, name, timezone } })` — loads *all* active monitors and their users every minute.
2. **Filter by due time:** in code — `lastChecked + interval minutes <= now` (interval granularity is minutes; default 5). `force=true` (manual check endpoint or `?force=true`) skips the filter.
3. **Check:** `Promise.allSettled` over all due monitors; per monitor a `fetch(url, { signal: AbortController(10s), redirect: "follow", cache: "no-store" })`. UP ⇔ status 200–399. Response time measured around the fetch.
4. **Alert (inline, before persistence):** if `user.telegramChatId` exists and `previousStatus !== newStatus`, one of three HTML messages is sent synchronously via `sendTelegramAlert` (MONITORING STARTED on first UP from `PENDING`; ALERT: Website Down; RECOVERY). **Alerts are sent before the result is persisted** — a crash between alert and write yields alerted-but-unrecorded downtime.
5. **Persist:**
   - **Slow path (status changed / first check):** `monitor.update` (status, lastChecked, responseTime, totalChecks±, failedChecks±, recomputed `uptimePercent`), `ping.create`, and incident lifecycle: DOWN ⇒ `incident.create({status:"ONGOING"})`; UP from DOWN ⇒ find latest `ONGOING` incident → set `RESOLVED` + `resolvedAt`. These are **three-plus separate statements, not a transaction**.
   - **Fast path (no status change):** `queueRoutineCheck()` → in-memory buffer only. Note this applies to routine **DOWN** checks too (a monitor that stays DOWN is queued in memory, so its DOWN pings are subject to batch loss and its `lastChecked` is not refreshed in DB until flush).
6. **Cleanup:** `runCleanup()` is invoked at the end of *every* cron tick ([cron-logic.ts:212-218](../src/lib/cron-logic.ts#L212-L218)) — i.e. delete-scan queries run **every minute**, in addition to the daily midnight schedule.

**Uptime math:** `uptimePercent = (totalChecks − failedChecks) / totalChecks` over the monitor's *lifetime* — never resets, decays toward the long-run average, and is recomputed read-modify-write (race-prone, see §9).

**First-check semantics:** monitors are created with `status: "PENDING"`; the schema default `UNKNOWN` is effectively unused. A monitor whose very first check fails immediately fires a DOWN alert — correct for uptime honesty, but there is no "consecutive failures before DOWN" (failure threshold) concept, so single network blips flap status and alerts.

---

## 4. Current Database Flow

- **Client:** single global `pg.Pool` (HMR-cached on `globalThis`) → `PrismaPg` driver adapter → `PrismaClient` ([src/lib/prisma.ts](../src/lib/prisma.ts)). Query logging on in dev.
- **Access pattern:** all reads/writes go through Prisma in route handlers and lib functions. No query layer, no repository boundary, no transactions anywhere in the codebase (`$transaction` never used).
- **Writes per cron tick:** bulk `ping.createMany` on flush (fast path) or per-monitor `update` + `ping.create` + incident `create/update` (slow path). Monitor stat counters (`totalChecks`, `failedChecks`, `uptimePercent`) are **read-modify-write** in application code, both in the slow path and in the flusher — concurrent writers can lose increments.
- **Retention:** `runCleanup()` deletes pings older than 30 days and `RESOLVED` incidents older than 90 days, every minute (as a side effect of checks) and again at midnight.
- **Migrations:** none — deployment uses `prisma db push --accept-data-loss` in CI ([.github/workflows/deploy.yml:74](../.github/workflows/deploy.yml#L74)). There is no migration history, which is itself a risk and must be corrected during the Drizzle cutover (§21, §22).

---

## 5. Current Batching Mechanism

[src/lib/db-batcher.ts](../src/lib/db-batcher.ts) — a write-behind cache in the web process:

- `pendingPings: any[]` — module-scope array of ping rows.
- `pendingMonitorUpdates: Map<monitorId, {totalChecks, failedChecks, lastChecked, responseTime, status}>` — running per-monitor deltas.
- **Enqueue:** `queueRoutineCheck()` on every routine (status-unchanged) check.
- **Flush:** every 15 min (internal cron), after every `/api/cron/check` request, after manual `POST /api/monitors/[id]/check`, and on `SIGTERM`/`SIGINT` (graceful-shutdown hook in `instrumentation.ts`).
- **Flush algorithm:** snapshot + clear the queues → `ping.createMany(bulk)` → for each monitor: `findUnique(counters)` → compute new `uptimePercent` → `monitor.update` (all `Promise.allSettled`, concurrent).

**Failure semantics (explicit in code):** if the flush throws, the batch is dropped — no requeue, no retry, no persistence. Comment: *"losing a few routine UP pings is generally acceptable for a free-tier app."*

**Structural defects to eliminate in the redesign:**

| # | Defect | Consequence |
|---|---|---|
| B1 | Buffer is process-local | Data loss on crash/SIGKILL/OOM; invisible to any second instance |
| B2 | Flush is time-based only (15 min) | Up to 15 min of stale dashboard data & `lastChecked` |
| B3 | Batched monitor update writes `status` from a stale in-memory value | A routine `UP` delta flushing *after* a newer DOWN transition can overwrite `monitor.status` back to UP (state regression) |
| B4 | Counters via find-then-update | Lost updates under concurrency (cron vs manual check vs flush) |
| B5 | No size cap on `pendingPings` | Unbounded memory if DB is down (flush keeps failing) |
| B6 | Batching applies to routine DOWN checks | Downtime evidence delayed/lossy |

---

## 6. Authentication Architecture

- **NextAuth v4** ([src/lib/auth.ts](../src/lib/auth.ts)), mounted at `/api/auth/[...nextauth]`.
- **Providers:** Google OAuth, GitHub OAuth, Credentials (email + bcrypt password, requires `emailVerified`).
- **Adapter:** `PrismaAdapter` for `users` / `accounts` / `sessions` / `verification_tokens`; **JWT session strategy** — so the `sessions` table is written but never consulted (dead weight).
- **Token payload:** `id` added to JWT; `session` callback copies `id`, `picture`, `name`; client-side session updates via `useSession().update` (image/name changes).
- **Route protection:** edge `proxy.ts` guards only `/dashboard/*` by JWT cookie presence; every API route independently calls `getServerSession`.
- **Custom auth routes (Prisma-direct, not NextAuth):** register (bcrypt, rate-limited 5/IP/hour, creates user + verification token + awaits verification email), verify-email (token → `emailVerified`), forgot-password (enumeration-safe 200), reset-password (token → password update **and silently sets `emailVerified`** — an unverified user who resets a password becomes verified; questionable), token generation in [src/lib/tokens.ts](../src/lib/tokens.ts) (uuid, 24 h / 1 h expiry, single-use by delete-on-read).
- **Client state:** NextAuth `SessionProvider` (context) **plus** a parallel Redux `auth` slice (`user`, `token`) persisted to localStorage — a duplicated source of truth left over from a starter template; `baseApi` attaches `Authorization: <token>` if present although the API only reads cookies.
- **Misc:** Cloudinary avatar upload in profile PATCH; account DELETE cascades user data; rate limiting is in-memory per-instance (§9).

**Better Auth mapping is proposed in §12.**

---

## 7. Current Frontend Architecture

- **Route groups:** `(authLayout)` — login/register/recovery pages; `(commonLayout)` — public marketing/legal/docs/status (`/status/[id]`); `(dashboardLayout)` — the app shell around `/dashboard`. Layouts are server components; nearly all interactive UI is client components (`"use client"`): `Dashboard.tsx`, `Incidents.tsx`, `MonitorDetails.tsx`, `DashboardStatus.tsx`, `ProfileComponent.tsx`, `TelegramSettings.tsx`, `FeedbackButton.tsx`, `PublicStatus.tsx`, all `dashboardLayout/*`, `ui/sidebar.tsx`.
- **Providers:** root [layout.tsx](../src/app/layout.tsx) wraps `AuthProvider` (NextAuth `SessionProvider`) → `ReduxProvider` (store + `PersistGate`) → sonner `<Toaster theme="dark">`. The dashboard layout mounts a **second `<Toaster>`** — duplicate toast trees.
- **Data fetching:** raw `fetch()` inside `useEffect`, gated on `useSession().status === "authenticated"`; polling via `setInterval` — 30 s in `Dashboard.tsx:86` and `MonitorDetails.tsx:85`, **3 s** in `TelegramSettings.tsx:45` while awaiting Telegram connect. No SWR/React Query. The RTK Query `baseApi` exists with **zero endpoints** (`endpoints: () => ({})`) — hollow infrastructure.
- **Auth guarding is duplicated:** server-side `proxy.ts` (matcher `/dashboard/:path*`) *plus* per-component client redirects to `/login` on `unauthenticated` or 401 — the same logic copy-pasted in ~5 components.
- **State:** Redux Toolkit with a single `auth` slice `{ user, token }`, persisted to localStorage (`whitelist: ["auth"]`). Effectively **dead code**: nothing dispatches `setUser`, so `selectCurrentUser` is always null — `AppSidebar` permanently renders fallback name/email (`"user@spidernode.com"`); only `TeamSwitch` dispatches `logout` (and removes a `token` cookie that is never set anywhere; `js-cookie` ships for this). NextAuth's `useSession` is the de-facto client auth source.
- **Component library:** shadcn/ui, `new-york` style, RSC, Tailwind v4 CSS vars (`components.json`), primitives present: avatar, button, card, dropdown-menu, input, separator, sheet, sidebar, skeleton, tooltip. In practice only sidebar/avatar/dropdown/sheet/tooltip are used — dashboard feature components are hand-rolled Tailwind. `ui/sidebar.tsx` is the shadcn sidebar adapted to use **hugeicons** instead of lucide, with open-state persisted in a `sidebar_state` cookie.
- **Icons:** three systems configured — `hugeicons-react` (de-facto everywhere), `react-icons` (only in `form/MyFormInput`/`MyFormSelect`, which are themselves largely unused), and `lucide` (declared in `components.json`, unused).
- **Animation/feedback:** `motion` keyframes in `globals.css` (`status-pulse`, `alert-pulse`, `fade-in-up`) used heavily by the dashboard; `tw-animate-css` in a few components; `framer-motion` imported in `UnderConstruction.tsx` **but not declared in package.json** (undeclared direct dependency); Lottie (`dotlottie-react`) loaders pull remote `lottie.host` assets with `bg-white/80` overlays (clashes with dark theme); **three dialog systems** coexist — `sweetalert2` (logout confirm, styled light), `window.confirm` (delete monitor, telegram disconnect), and a custom `DeleteModal`; `sonner` for toasts.
- **Error handling:** `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx` exist (a strength).
- **Theme:** see §19 — `.dark` is hardcoded on `<html>`, `:root` and `.dark` palettes are identical (permanent dark mode), and a user-facing toggle does not exist.
- **Client robustness gaps:** interval-driven fetches have no `AbortController` (responses can land after unmount); short `setTimeout`s not cleared on unmount (`DashboardStatus.tsx:66`, `ProfileComponent.tsx:195`); `publicUrl` derived from `window.location.origin` during render (`DashboardStatus.tsx:57` — hydration risk); `PublicStatus.tsx:133` renders `new Date()` as "Last updated" for data that never refreshes.

---

## 8. Current Cron Architecture

Three `node-cron` schedules registered in `instrumentation.ts` `register()` (Node runtime only), **inside the web server process**:

| Schedule | Job | Mode dependency |
|---|---|---|
| `* * * * *` | `runCronChecks()` — select due monitors → fetch → alert → persist/queue | Disabled when `CRON_MODE=vercel` |
| `*/15 * * * *` | `flushBatches()` — drain in-memory buffer to Postgres | Disabled when `CRON_MODE=vercel` |
| `0 0 * * *` | `runCleanup()` — retention deletes | Disabled when `CRON_MODE=vercel` |

External trigger path (`CRON_MODE=vercel` or any external scheduler): `GET /api/cron/check?secret=…` → auth check → `runCronChecks(force?)` → `flushBatches()` inline → JSON summary. `GET /api/cron/cleanup` likewise.

Operational properties:

- **No distributed lock, no leader election** — every instance of the web process runs its own cron. One PM2 instance today; a second instance (or a stray dev server against the prod DB) double-checks every monitor and corrupts counters.
- **Minute-granularity cadence** with per-monitor due-time filtering in application code (`lastChecked + interval`), so check jitter is bounded by the 1-minute tick.
- **Overlap hazard:** a slow tick (many slow monitors × 10 s timeouts, sequential Telegram sends) can overrun into the next minute tick; `node-cron` will start the next run concurrently — no overlap guard.
- **Heartbeat:** healthchecks.io ping on success, `/fail` on exception — the only crash observability.
- **Cleanup double-scheduling:** daily cron *and* per-tick invocation (§3.6).

---

## 9. Current Risks

### Correctness
| ID | Risk | Evidence |
|---|---|---|
| R1 | Stale batched `status` can overwrite a newer DOWN transition (state regression) | §5/B3, db-batcher flush |
| R2 | Lost counter updates (find-modify-write, no transactions/increment) | cron-logic slow path + flusher |
| R3 | Multi-step persistence not transactional → partial state (monitor updated, ping missing, incident dangling) | cron-logic.ts:165-205 |
| R4 | Duplicate execution when >1 process/instance exists (no locks, per-process cron) | instrumentation.ts |
| R5 | Tick overlap: long ticks stack with next minute's tick | node-cron, no overlap guard |
| R6 | No failure threshold / flapping: single failed check ⇒ DOWN alert + incident | cron-logic.ts:96-134 |
| R7 | Manual check endpoint forces checks without rate limit or lock, racing the scheduler | api/monitors/[id]/check |
| R8 | Routine DOWN pings are batched ⇒ downtime evidence can be delayed/lost | §5/B6 |
| R9 | Alerts sent **before** persistence; no alert dedup/retry; Telegram fetch has no timeout | cron-logic.ts:100-135, telegram.ts |

### Durability
| ID | Risk | Evidence |
|---|---|---|
| R10 | Crash between flushes loses ≤15 min of pings and stat deltas | db-batcher.ts |
| R11 | Flush failure drops the batch permanently (by design) | db-batcher.ts:108-112 |
| R12 | Unbounded in-memory buffer if Postgres is down | §5/B5 |
| R13 | No Postgres migrations; `db push --accept-data-loss` in production CI | deploy.yml:74 |

### Security
| ID | Risk | Evidence |
|---|---|---|
| R14 | In-memory rate limiting resets on restart and is per-instance (trivially bypassed) | rate-limit.ts |
| R15 | `CRON_SECRET` accepted via query string (log/referrer leakage) | cron routes |
| R16 | Error handlers leak stack traces to clients | cron routes |
| R17 | `/api/feedback` GET exposes all users' names/emails to any authenticated user | api/feedback/route.ts:43-79 |
| R18 | Password reset silently marks unverified accounts verified | reset-password/route.ts:38-44 |
| R19 | Monitor URL validation accepts private/loopback addresses → SSRF-style internal probing from the server | monitors POST/PATCH (`new URL()` only) |
| R20 | Public status page exposes raw monitor URLs by design (acceptable product decision, but should be explicit/configurable) | api/status/[userId] |
| R21 | `ngrok` binary (32 MB) and `ngrok.log` committed to git; local tunnel hostname recorded | repo root |
| R22 | NextAuth v4 is in maintenance mode on Next 16; `NEXTAUTH_SECRET`/URL naming is legacy | auth.ts |

### Product/tech-debt
- Monitor intervals are minutes-only; no keyword/TCP/SSL checks yet (both `UPGRADE_PLAN.md` and `ADVANCED_MONITORING_PLAN.md` describe them as future work — the Drizzle schema should reserve fields for them, §11).
- No tests of any kind (§23); no lint/type safety gate in CI (`typescript.ignoreBuildErrors: true`).
- Frontend: dead Redux `auth` slice + redux-persist + `js-cookie` shipped for state nobody reads; RTK Query configured with zero endpoints; duplicated client auth-redirect logic in ~5 components; duplicate `<Toaster>` (root + dashboard layout); three coexisting dialog systems (`sweetalert2`, `window.confirm`, custom modal) plus sonner; three icon libraries (hugeicons used, react-icons marginal, lucide declared-unused); `framer-motion` imported without being a declared dependency; Lottie assets loaded from a remote host; hardcoded hex colors bypass the token system (`bg-[#121212]`, `text-[#EF4444]`), which blocks theming (§19).
- 32 MB `ngrok` binary in git history bloats clones.

---

## 10. Prisma Schema Inventory

Source: [prisma/schema.prisma](../prisma/schema.prisma). Postgres, `cuid()` string PKs except `Monitor` (autoincrement **Int**). Table names via `@@map`.

| Model | Table | PK | Key fields | Relations / notes |
|---|---|---|---|---|
| User | `users` | `id` String cuid | name?, email **unique**, emailVerified?, image?, password?, telegramChatId?, timezone (default "UTC"), createdAt, updatedAt | → monitors, accounts, sessions, feedbacks (all cascade) |
| Account | `accounts` | id String cuid | type, provider, providerAccountId, OAuth token fields (Text) | unique(`provider`,`providerAccountId`); FK user cascade — **NextAuth-specific shape** |
| Session | `sessions` | id String cuid | sessionToken **unique**, userId, expires | **Unused at runtime** (JWT strategy) |
| Monitor | `monitors` | `id` **Int autoincrement** | url, name, status (default "UNKNOWN"; app uses "PENDING"/"UP"/"DOWN"), isActive (default true), interval Int (minutes, default 5), lastChecked?, responseTime Int? default 0, uptimePercent Float default 100.0, totalChecks Int default 0, failedChecks Int default 0 | FK user cascade; → pings, incidents. **No index on `isActive` / `lastChecked`** (the cron's hot query) |
| Ping | `pings` | id String cuid | monitorId Int, status ("UP"/"DOWN"), responseTime Int, createdAt default now | FK monitor cascade; index on `monitorId` only — **no index on `createdAt`** (cleanup + range scans) |
| Incident | `incidents` | id String cuid | monitorId Int, status ("ONGOING"/"RESOLVED"), description?, startedAt default now, resolvedAt? | FK monitor cascade; index `monitorId` only |
| Feedback | `feedbacks` | id String cuid | userId, type, title, description, status default "PENDING", upvotes default 0 | FK user cascade; index userId |
| VerificationToken | `verification_tokens` | id String cuid | email, token **unique**, expires | unique(email, token); custom (not consumed by NextAuth itself) |
| PasswordResetToken | `password_reset_tokens` | id String cuid | email, token **unique**, expires | unique(email, token) |

Volume hotspots: `pings` grows fastest (1 row per check per monitor, minus batching) and is the retention-critical table; `monitors.status/lastChecked` is read every minute for every active monitor.

---

## 11. Proposed Drizzle Schema Mapping

*Amended 2026-09-09 (resolves J-1, J-2, D-1, D-2, D-3, N-5; §9 items 1, 8, 9, 10, 11)*

Principles: PostgreSQL stays the **only** source of truth; keep table/column names (or map deliberately) to enable data migration without a rewrite of public API responses; introduce missing indexes; make state machines explicit; keep `monitors.id` as `serial` (integer) to avoid breaking public status-page URLs and ping foreign keys.

**Baseline rule (D-05 / DRZ-01).** This section specifies **new and changed** objects at DDL precision — column name / type / default / nullability / index. **Existing column types are not declared as fact**: production was built with `prisma db push --accept-data-loss` and live DDL may drift from `schema.prisma` (M-6). Everywhere the §10 Prisma inventory is cited as the baseline below, it carries the marker **verify against live `pg_dump --schema-only` (M-6 / DRZ-01)**; Phase 3 baselines the Drizzle schema from live DDL, proves equivalence with an empty `drizzle-kit` diff (M-3), and only then transcribes. Full Drizzle table code is deliberately **not** authored here (it would pre-empt the live-DDL baseline); Drizzle fragments appear only where index semantics are subtle — the two partial indexes in §11's index subsections below.

#### `monitors` — claim column, due index, reserved column

```sql
-- NEW: claim column (J-1). Due-selection CLAIMS advance next_check_at
-- transactionally at selection time; last_checked remains the result-written
-- display/monotonicity column (§16). NULL = never claimed.
ALTER TABLE monitors ADD COLUMN next_check_at timestamptz NULL;

-- Backfill (Phase 3 migration, additive, idempotent):
--   UPDATE monitors
--      SET next_check_at = COALESCE(last_checked, created_at) + (interval * interval '1 minute')
--    WHERE next_check_at IS NULL;
-- (last_checked / created_at types per §10 inventory — verify against live
--  pg_dump (M-6 / DRZ-01) before running the backfill)

-- NEW: due-selection partial index (J-1). Covers the scheduler claim predicate
-- (is_active AND (next_check_at IS NULL OR next_check_at <= now())); the
-- WHERE is_active predicate keeps inactive monitors out of the index entirely.
CREATE INDEX idx_monitors_due ON monitors (is_active, next_check_at) WHERE is_active;

-- NEW: reserved column (Q-2 / ALRT-02). No v1 writer exists; the column lands
-- now so a future N-consecutive-failure threshold needs no migration.
ALTER TABLE monitors ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
```

`idx_monitors_due` **supersedes** the previously sketched `monitors_active_due_idx (is_active, last_checked)`: `last_checked` lags reality by up to the 60 s flush window, which is exactly the duplicate-check race J-1 closes — do not create the old index. Remaining `monitors` columns (id serial PK, url, name, status, is_active, interval, last_checked, response_time, uptime_percent, total_checks, failed_checks, user_id, created_at, updated_at — per the §10 inventory): verify against live pg_dump (M-6 / DRZ-01), in particular `timestamp` vs `timestamptz` on the three time columns (M-6 drift risk).

#### `write_guards` — NEW table (J-2 / DAT-03)

```sql
CREATE TABLE write_guards (
  key        text        PRIMARY KEY,  -- e.g. 'flush:{batchId}' (§16.2), 'breaker:probe:{ts}' (§13 amendment)
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- One row per successfully applied guarded write. The guard key column referenced by the §16.2 flush SQL (`INSERT INTO write_guards(key) …`) is exactly this `key` column; key formats are `flush:{batchId}` for aggregate flushes and `breaker:probe:{ts}` for circuit-breaker probes.
- Append-only; pruned by the maintenance queue (retention pinned in the parameter table below).

#### `outbox` — NEW table (D-2 / DAT-05)

```sql
CREATE TABLE outbox (
  id          text        PRIMARY KEY DEFAULT gen_random_uuid()::text,  -- pinned ID default (D-3, ID-generation subsection)
  event_type  text        NOT NULL,       -- 'incident.down' | 'incident.recovered' | 'monitor.first_check'
  monitor_id  integer     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  incident_id text        NULL REFERENCES incidents(id) ON DELETE CASCADE,  -- incidents.id type: verify live pg_dump (M-6/DRZ-01)
  payload     jsonb       NOT NULL,       -- alert content snapshot; chat target resolved by the alerts processor
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz NULL,           -- NULL = unsent; set exactly once by the relay (§16.3)
  attempts    integer     NOT NULL DEFAULT 0
);

CREATE INDEX idx_outbox_unsent ON outbox (created_at) WHERE sent_at IS NULL;
```

- `monitor_id` is `integer` (not uuid) because `monitors.id` stays integer `serial` (M-5, mapping decision 1) — a foreign key must match its PK type.
- `idx_outbox_unsent` is the relay's polling index; every column the §16.3 relay SQL reads or writes (`created_at`, `sent_at`, `attempts`) is defined here.

#### `incidents` — partial unique ONGOING index (D-1 / DAT-04)

```sql
-- Exact predicate text is load-bearing: §16.1's INSERT uses
--   ON CONFLICT (monitor_id) WHERE status = 'ONGOING' DO NOTHING
-- and Postgres partial-index inference requires the conflict target's
-- index_predicate to match this index's predicate (CREATE INDEX format).
-- Source: postgresql.org/docs/current/sql-insert.html — "index_predicate …
-- Used to allow inference of partial unique indexes. Follows CREATE INDEX format."
CREATE UNIQUE INDEX incidents_one_ongoing ON incidents (monitor_id) WHERE status = 'ONGOING';
```

Phase 3 ordering caveat: while `CREATE INDEX CONCURRENTLY` is running on a unique index, `INSERT … ON CONFLICT` statements on the same table may unexpectedly fail (postgresql.org/docs/current/sql-insert.html). Apply this index **before** any writer path using the `ON CONFLICT` clause goes live (the baseline migration window precedes the Phase 4 writer), or accept brief conflict failures during the migration window — never create it concurrently with the §16.1 writer active.

Subtle-semantics Drizzle fragments — the only Drizzle code in this section (full tables are authored in Phase 3 against live DDL):

```ts
// partial unique index (D-1) — predicate must match §16.1's ON CONFLICT target
uniqueIndex("incidents_one_ongoing").on(t.monitorId).where(sql`status = 'ONGOING'`),
// claim index (J-1) — partial; predicate excludes inactive monitors
index("idx_monitors_due").on(t.isActive, t.nextCheckAt).where(sql`is_active`),
```

#### `pings` — check metadata (N-5 / DAT-10)

```sql
ALTER TABLE pings ADD COLUMN error_class text NULL;     -- 'timeout' | 'dns' | 'tls' | 'ssrf_blocked' | 'http_5xx' | 'network' (app-validated vocabulary)
ALTER TABLE pings ADD COLUMN status_code integer NULL;  -- HTTP status when a response arrived; NULL for network-level failures
```

Remaining `pings` columns (id text PK, monitor_id, status, response_time, created_at — per the §10 inventory): verify against live pg_dump (M-6 / DRZ-01).

#### ID generation (D-3 / DAT-07)

Pinned: **database-side default `gen_random_uuid()::text`** on the primary key of every new table (`outbox.id`) and, in the Phase 3 baseline, added as the default for existing text PKs (`pings.id`, `incidents.id`, `users.id`) so every INSERT path gets a PK without app-side generation. `gen_random_uuid()` is built into PostgreSQL 13+ (Neon is 17-compatible; confirm at baseline that no `pgcrypto` extension is required).

- Bulk-insert paths (the `pings` flush `createMany` / multi-row INSERT) must either **omit** the id column entirely (the default applies) or supply explicit values — never bind `undefined`/NULL explicitly, which silently violates the PK.
- Existing cuid-format rows are unaffected (both old and new values are `text`).
- Phase 4 adds a unit/CI assertion that bulk-inserted rows never have NULL ids (DAT-07).

#### Schema-level parameter pinning (D-10)

| Parameter | Default | Rationale | Class |
|---|---|---|---|
| Routine-flush window | ≤ 60 s | Rule 9 upper bound; downtime-evidence lag ≤ 1 min (§16 Tier 2) | non-negotiable |
| Retention delete batch | 5000 rows per DELETE loop pass | D-7: bounds row locks, bloat, and replication lag on Neon; loop until fewer than batch rows are deleted | default — tune in Phase 4/5 |
| Outbox relay batch size | 100 rows per relay pass | bounds the `FOR UPDATE` lock hold and the alert-enqueue burst per tick; far exceeds the transition rate at current scale | default — tune in Phase 4/5 |
| write_guards retention | prune rows older than 7 days (daily, maintenance queue) | retry horizon is BullMQ attempts × backoff (minutes); 7 d aligns with the DLQ retention bound (D-14) | default — tune in Phase 4/5 |

Mapping decisions to record now:

1. **`monitors.id` stays integer `serial`.** Public URLs (`/status`, monitor detail) and all ping/incident FKs depend on it; new FKs (`outbox.monitor_id`) are integer to match.
2. **Timestamps become `timestamptz`** — existing columns carry the verify-against-live-pg_dump marker (M-6 / DRZ-01); all NEW columns and tables specified above are declared `timestamptz` outright.
3. **Status strings stay strings** initially (zero-downtime), with app-level validation; a later pass can introduce PG enums/check constraints.
4. **Indexes:** `pings(monitor_id, created_at)` and `incidents(monitor_id, status)` remain additive additions; the monitors hot-path index is `idx_monitors_due` on `(is_active, next_check_at) WHERE is_active` (supersedes the `(is_active, last_checked)` sketch, J-1); `incidents_one_ongoing` adds the D-1 physical invariant; `idx_outbox_unsent` serves the relay.
5. **Counter strategy:** SQL-relative increments everywhere — the transition UPDATE and the guarded flush (§16) — never read-modify-write; `uptime_percent` stays derived lifetime math per the D-6 decision recorded in §16.
6. `sessions` table is dropped in the Better Auth model (JWT ⇒ stateless); `accounts` is replaced by Better Auth's `account` table (§12).
7. **Drop Prisma entirely after cutover** (rule 20): remove `prisma/`, `@prisma/*`, `pg`-adapter config, and the `src/generated` output from build.
8. **`monitors.next_check_at` + `idx_monitors_due`** (J-1): claims advance at selection time; backfill per the SQL above.
9. **`write_guards`** (J-2 / DAT-03): same-transaction guards for non-naturally-idempotent writes; also hosts breaker probe keys.
10. **`outbox`** (D-2 / DAT-05): transactional alert events; relay-polled via `idx_outbox_unsent`; `sent_at` set exactly once.
11. **Partial unique `incidents_one_ongoing`** (D-1 / DAT-04): exact predicate text pinned for `ON CONFLICT` inference; migration-window caveat above.
12. **ID generation pinned** DB-side `gen_random_uuid()::text` (D-3 / DAT-07); bulk inserts never bind NULL/undefined PKs.
13. **`pings.error_class` + `pings.status_code`** (N-5 / DAT-10).
14. **`monitors.consecutive_failures` reserved** (Q-2 / ALRT-02) — integer NOT NULL DEFAULT 0, no v1 writer.

---

## 12. Proposed Better Auth Mapping

Current NextAuth v4 surface → Better Auth equivalent:

| NextAuth v4 today | Better Auth target |
|---|---|
| `authOptions` in `lib/auth.ts`, route `api/auth/[...nextauth]` | Better Auth instance in `lib/auth.ts` (`betterAuth({ database: drizzleAdapter(db), emailAndPassword: { enabled: true, requireEmailVerification: true }, socialProviders: { google, github }, session: { cookieCache } })`), mounted via `toNextJsHandler` at `api/auth/[...all]` |
| PrismaAdapter (user/account/session/verificationToken) | Drizzle adapter over Better Auth's canonical tables |
| JWT session strategy + `sessions` table unused | Server-side sessions (Better Auth default) or JWT plugin — **recommend DB sessions + short cookieCache** so account deletion/plan changes revoke instantly |
| `session.user.id` augmentation (`types/next-auth.d.ts`) | Better Auth inferred types (`$Infer`), no module augmentation |
| Credentials + bcrypt (`bcryptjs`, 10 rounds) | Built-in email/password (keeps bcrypt/argon via Better Auth config) |
| Email verification: custom `verification_tokens` + custom routes | Better Auth `emailVerification` plugin + `sendVerificationEmail` hook |
| Password reset: custom `password_reset_tokens` + routes | Better Auth `resetPassword` flow + `sendResetPassword` hook |
| `proxy.ts` guard via `getToken` | `auth.api.getSession({ headers })` in proxy/middleware (Better Auth supports edge) |
| Client `SessionProvider` + duplicated Redux `auth` slice | `authClient.react()` hooks (`useSession`) as the single client source; **delete the Redux `auth` slice token mirror** (keep Redux for UI/domain state only) |
| OAuth Google/GitHub | Same providers, configured in `socialProviders` |

Migration constraints:

- **Password hashes must survive.** Better Auth stores `account.password` (its own `account` table). Migrate existing `users.password` bcrypt hashes into Better Auth's account rows with `providerId: "credential"`; bcrypt hashes remain verifiable if Better Auth's password config keeps bcrypt (it supports custom hash functions — verify hash prefix compatibility during a spike).
- **User IDs are cuid strings** — Better Auth accepts a text `id` primary key; keep existing IDs so monitors/feedback FKs remain valid.
- **OAuth identities** in `accounts` must be reshaped into Better Auth's `account` table (`providerId`, `accountId`, `accessToken`, etc.) — column mapping is mechanical but must preserve refresh tokens.
- `verification_tokens` / `password_reset_tokens` rows can be truncated at cutover (users simply re-request; tokens are short-lived).
- `NEXTAUTH_SECRET`/`NEXTAUTH_URL` env names retire in favor of `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` (+ `NEXT_PUBLIC_*` where the client needs them).

---

## 13. Proposed Redis Architecture

Redis is **infrastructure only** — never a source of truth (rule 2). Every piece of state below is recoverable from Postgres or is disposable by design.

| Use | Key shape | TTL | Recovery story |
|---|---|---|---|
| BullMQ queues + repeatable job schedulers | `bull:{queues}` (managed by BullMQ) | — | Jobs re-enqueued by scheduler; pending jobs drained from Redis; unacked checks re-created on scheduler tick |
| Distributed lock per check | `lock:monitor:{monitorId}` (`SET NX PX`, value = jobId, released by owner) | interval + slack | Expiry auto-releases; stale locks harmless (idempotent jobs) |
| Leader lock for the scheduler loop | `lock:scheduler` (Redlock or single SET NX) | ~30 s, renewed | Any worker can take over |
| Routine-result aggregation buffer | `agg:results:{monitorId}` (hash: count, failedCount, sumResponseTime, lastResponseTime, lastStatus, lastCheckedAt) + `agg:pending` set | flushed ≤60 s; TTL as safety | **Loss-tolerable data only**; monitor row itself always carries last immediate status |
| Idempotency ledger | `idem:check:{monitorId}:{scheduledAtEpoch}` | 24 h | Prevents duplicate writes from retried jobs |
| Cache: dashboard summaries, status pages | `cache:status:{userId}`, `cache:dashboard:{userId}` | 15–60 s | Cache-miss rebuilds from Postgres |
| Rate limiting (replaces in-memory Map) | `rl:{bucket}:{ip}` (`INCR` + `EXPIRE`) | window | Counter loss only loosens limits, never corrupts data |
| Alert dedup/throttle | `alert:sent:{monitorId}:{state}` | until state change | Duplicate alert worst case, no data impact |

Operational rules:

- **Redis failure ⇒ degrade, don't corrupt (rule 13).** All *critical* writes (status transitions, incidents, alerts-of-record) go to Postgres first. If Redis is unreachable, the worker falls back to writing routine pings straight to Postgres (unbatched) rather than buffering; the web app serves uncached data. BullMQ unavailable ⇒ checks pause (visible via healthchecks.io heartbeat gap) but Postgres data stays consistent.
- **Postgres failure ⇒ retryable jobs (rule 14).** Job handlers wrap DB writes with BullMQ retries + exponential backoff; results stay in the aggregation buffer / job payload until the write succeeds. Nothing is dropped on DB error.
- One Redis instance suffices at current scale; enable AOF persistence for queue durability; document maxmemory policy (`noeviction`) so BullMQ keys are never evicted.

---

## 14. Proposed BullMQ architecture

Queues (single Redis, prefix `bull`):

| Queue | Producer | Consumer | Jobs |
|---|---|---|---|
| `monitor-scheduler` | BullMQ repeatable job (every 30–60 s) + API-route producers | Worker: scheduler step | `tick`: SELECT due monitors (`isActive AND (last_checked IS NULL OR last_checked + interval <= now)`) → enqueue `check` per monitor; take `lock:scheduler` |
| `monitor-checks` | scheduler tick; API routes (manual check, monitor create → immediate first check) | Worker: check pool | `check { monitorId, scheduledAt, jobIdempotencyKey, force }` — one monitor per job (horizontal scale unit) |
| `db-writes` | check handler | Worker: writer pool | `flush-monitor-aggregate { monitorId }`, `record-pings-bulk { rows }` — routine UP persistence |
| `alerts` | check handler (on transition) | Worker: notifier pool | `send-alert { monitorId, transition, channels[] }` (telegram, email) — retries with backoff |
| `maintenance` | repeatable (daily) + API trigger | Worker | `cleanup` (retention), `recompute-uptime` (nightly window recompute), `ping-rollup` (optional hourly aggregation) |

Key mechanics:

- **Job options:** `monitor-checks`: `{ attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: { age: 3600, count: 5000 }, removeOnFail: { age: 86400 } }`. `alerts`: 5 attempts, exponential from 10 s. `db-writes`: 5 attempts — retries make rule 14 real.
- **Idempotency (rule 10):** every `check` carries `scheduledAt`; handler short-circuits if `idem:check:{monitorId}:{scheduledAt}` exists, or if `lastChecked >= scheduledAt − skew` in Postgres. Lock `lock:monitor:{monitorId}` (SET NX PX) guards execution; lock is released in a `finally` by the lock owner only.
- **DOWN/RECOVERED immediate path (rule 8):** the check handler evaluates the transition and performs the **critical transaction synchronously in the worker** (monitor status + ping + incident open/resolve in one `db.transaction`), then enqueues `alerts` (post-write). It never routes transitions through the aggregation buffer.
- **Routine UP aggregation (rule 9):** UP results mutate the Redis aggregation hash and, when the buffer is ≥N results or ≥60 s old (checked by a repeatable flusher job), a `db-writes` job applies them in one transaction with atomic increments (`total_checks = total_checks + δ`, `last_checked = GREATEST(...)`). Buffer entries are deleted only after a successful commit — losing the Redis buffer costs only a few routine pings, never a transition.
- **Scheduler-producer separation** keeps cadence logic (which monitors are due) in SQL, not in per-process timers — eliminates R4/R5.
- **FlowProducer** (`check` → children `db-writes`/`alerts`) is optional later; plain chains suffice initially.
- **Bull Board** (or `bullmq` UI) behind an admin gate for queue observability.

---

## 15. Proposed Worker Architecture

A **separate long-running Node process**, first-class in the repo:

```
worker/
  index.ts            # bootstrap: env validation, graceful shutdown, health server
  queues.ts           # queue/worker/factory + shared BullMQ config (from src/lib/queues or worker-shared)
  processors/
    scheduler.ts      # tick → enqueue checks
    check-http.ts     # HTTP(S) check engine (fetch, timeout, keyword-ready)
    check-tcp.ts      # future (UPGRADE_PLAN phase 3)
    persist.ts        # transitions (transactional) + aggregate flush
    alerts.ts         # telegram + email dispatch
    maintenance.ts    # cleanup, uptime recompute
  health.ts           # :9090/healthz (process up) + /readyz (Redis+DB ping)
```

- **Runtime:** PM2 app #2 in `ecosystem.config.js` (`name: "uptime-worker", script: "worker/dist/index.js"`), or systemd unit; **never** runs inside `next start` (rules 4–6). `instrumentation.ts` cron code is deleted at cutover.
- **Concurrency:** check workers sized to `concurrency × 10s timeout` budget (start: concurrency 10); alert/persist workers separate concurrency so slow Telegram/SMTP calls never stall checks (fixes R9 partially — alert enqueue stays inline-fast, dispatch is queued).
- **Ownership of all monitoring logic:** the check engine module moves to a shared location importable by the worker only; API routes never execute checks — they enqueue (`monitors/[id]/check` becomes a fast 202-style enqueue + read-after-write from Postgres).
- **Deployment coupling:** web and worker deploy together from one build (shared TypeScript), versioned by the same git SHA; schema migrations run before worker restart (§22).
- **Observability:** healthchecks.io heartbeat moves to the worker's scheduler tick; BullMQ event listeners export job counts; structured logs with `monitorId` correlation.
- **Scale-out path:** N workers are safe by construction — scheduler leader lock, per-monitor locks, idempotency keys, and SQL-side due-selection make duplicate execution impossible rather than merely unlikely.

---

## 16. Proposed Batching / Aggregation Architecture

*Amended 2026-09-09 (resolves J-2, D-1, D-2, D-4, D-5, D-6; §9 items 2, 8, 9, 12)*

Replaces `db-batcher.ts` (deleted). Split by criticality into two tiers, each specified as literal SQL a Phase 4 implementer transcribes without interpretation:

**Tier 1 — synchronous transaction (never batched):** every check whose classified result **changes** `monitors.status` — DOWN transition, RECOVERED transition, first check (PENDING → UP/DOWN) — regardless of whether the check was scheduled or manual. Written as **one synchronous Postgres transaction** by the `persist` processor inside the check job: monitor UPDATE + ping INSERT + incident INSERT/UPDATE + outbox INSERT (§16.1). Durability: BullMQ retries ⇒ a Postgres outage yields retryable jobs, not lost data (rule 14).

**Tier 2 — guarded aggregation (routinely batched):** every check whose result **matches** current status (routine UP, unchanged DOWN) — again including manual checks that don't transition. Deltas are aggregated in Redis (atomic `HINCRBY`/`HSET` per monitor) and flushed within 60 s via **one guarded atomic UPDATE per monitor that never writes `status`** (§16.2). Redis hash entries are deleted only after the flush transaction commits.

Invariants:
1. `monitor.status` is **only** written by Tier 1 (fixes B3 state-regression defect).
2. Aggregate flush uses `last_checked = GREATEST(existing, incoming)`, additive counters, and the `CASE` response-time guard (fixes B4, D-5).
3. Redis buffer is loss-tolerable by definition; Postgres is authoritative for every transition (rules 1, 7, 13).
4. Buffer size is bounded by design (60 s window × check rate) — no unbounded growth (fixes B5).
5. Flush batches are exactly-once per batch id via the same-transaction `write_guards` guard (J-2) — replacing the earlier vague "idempotency key per flush batch".

### 16.1 Transition transaction (Tier 1 — D-1, D-2, DAT-01)

```sql
BEGIN;

-- 1. Evidence ping: ALWAYS inserted — every executed check leaves evidence,
--    including duplicate (redelivered) executions. Ids come from the pinned
--    DB default (D-3): omit the id column or supply values, never undefined.
INSERT INTO pings (monitor_id, status, response_time, error_class, status_code, created_at)
VALUES ($mid, $pingStatus, $rt, $errorClass, $statusCode, now());

-- 2. Conditional transition + counters (D-1): only the executor that flips
--    the status proceeds. Counters ride this statement, so a duplicate
--    delivery counts the check exactly once. Zero rows returned ⇒ another
--    executor already made this transition ⇒ skip steps 3–4 and COMMIT.
UPDATE monitors
   SET status        = $target,              -- 'DOWN' | 'UP' (UP from DOWN = RECOVERED)
       last_checked  = now(),
       response_time = $rt,
       total_checks  = total_checks + 1,     -- SQL-relative increments only (D-5)
       failed_checks = failed_checks + CASE WHEN $failed THEN 1 ELSE 0 END
 WHERE id = $mid
   AND status <> $target
   AND is_active
RETURNING id;

-- (steps 3–4 run only if RETURNING yielded a row)

-- 3a. DOWN: open the incident. The WHERE clause after the conflict target is
--     the index_predicate matching incidents_one_ongoing (§11) — partial
--     unique index inference per postgresql.org/docs/current/sql-insert.html
--     ("Used to allow inference of partial unique indexes… Follows CREATE
--     INDEX format"). A concurrent double-insert becomes a physical no-op.
INSERT INTO incidents (monitor_id, status, started_at)
VALUES ($mid, 'ONGOING', now())
ON CONFLICT (monitor_id) WHERE status = 'ONGOING' DO NOTHING
RETURNING id;
-- (if DO NOTHING swallowed a concurrent insert and no row returns, SELECT the
--  surviving ONGOING incident id for the outbox row)

-- 3b. RECOVERED: resolve the existing ONGOING incident instead.
UPDATE incidents
   SET status      = 'RESOLVED',
       resolved_at = now()
 WHERE monitor_id = $mid
   AND status = 'ONGOING'
RETURNING id;   -- resolved incident id feeds the outbox row

-- 4. Outbox event (D-2): the alert enqueue is driven from this durable row
--    AFTER commit by the relay (§16.3) — a crash between commit and alert
--    enqueue is impossible by construction.
INSERT INTO outbox (event_type, monitor_id, incident_id, payload, created_at)
VALUES ($eventType, $mid, $incidentId, $payload::jsonb, now());

COMMIT;
```

Defense in depth (D-1): the conditional UPDATE is the primary gate; `incidents_one_ongoing` is the physical backstop that makes the one-ONGOING-per-monitor invariant unviolable even if a buggy path ever inserts without the gate.

### 16.2 Guarded monotonic flush (Tier 2 — J-2, D-5, DAT-02/DAT-03)

```sql
BEGIN;

-- Guard: same-transaction write guard (J-2). Zero rows returned ⇒ this batch
-- was already applied (worker crashed after commit but before the Redis hash
-- delete; BullMQ redelivered the flush job) ⇒ COMMIT and exit — the retry is
-- a no-op. A Redis-side guard alone is insufficient (keys can be flushed/lost).
INSERT INTO write_guards(key) VALUES ('flush:{batchId}')
  ON CONFLICT DO NOTHING
RETURNING key;

-- Additive monotonic UPDATE: never writes status (B3 fix). Deltas only.
UPDATE monitors SET
  total_checks  = total_checks + $dTotal,
  failed_checks = failed_checks + $dFailed,
  last_checked  = GREATEST(last_checked, $lastTs),
  response_time = CASE WHEN $lastTs > last_checked THEN $lastRt ELSE response_time END
WHERE id = $mid;

COMMIT;
-- Redis aggregate hash is deleted only after this COMMIT succeeds.
```

**NULL semantics, pinned** (postgresql.org/docs/current/functions-conditional.html):

- `GREATEST` **ignores NULL arguments** — a documented deviation from the SQL standard: *"NULL values in the argument list are ignored. The result will be NULL only if all the expressions evaluate to NULL."* ⇒ `GREATEST(NULL, $lastTs)` = `$lastTs`; **no `COALESCE` is needed** (contrary to SQL-standard intuition — do not "fix" it).
- Asymmetry: the `CASE` guard's comparison `$lastTs > NULL` yields NULL (not true), so a never-checked row (`last_checked IS NULL`) takes the **ELSE** branch and keeps the old `response_time`.
- Reachability: this edge is **unreachable by construction** — a monitor's first result is always a Tier 1 transition (PENDING → UP/DOWN writes `last_checked` synchronously), so Tier 2 only ever sees rows with `last_checked` set. If a bug ever reaches it anyway, the outcome is benign: `response_time` is simply not updated for that flush; counters still apply.

### 16.3 Outbox relay (D-2 / DAT-05)

```sql
BEGIN;

SELECT id, event_type, monitor_id, incident_id, payload
  FROM outbox
 WHERE sent_at IS NULL
 ORDER BY created_at
 LIMIT $batch                      -- default 100 (pinned in §11 parameter table)
   FOR UPDATE SKIP LOCKED;         -- postgresql.org/docs/current/sql-select.html:
                                   -- rows already locked by another relay consumer
                                   -- are skipped — the queue-table pattern

-- per selected row: enqueue the alerts job (Redis/BullMQ), then:
UPDATE outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $id;

COMMIT;                            -- one transaction per relay pass (batched)
```

- `sent_at` is set **exactly once** per row; `attempts` counts relay passes that picked the row (crash safety — an enqueue that failed mid-pass leaves `sent_at NULL` and the row is re-selected next pass).
- The relay is a BullMQ-scheduled job on the worker; `FOR UPDATE SKIP LOCKED` keeps multiple relay instances safe without coordination.

### 16.4 Incident-keyed alert dedup (D-4 / DAT-06)

Deduplication is keyed to the **incident event**, not the monitor state — a state-keyed scheme cannot distinguish incidents that recur. The outbox (§16.3) is the durable event source; Redis dedup is a best-effort collapse of at-least-once duplicates on top (rule 2).

- **Key format:** `alert:{incidentId}:{direction}` where `direction ∈ {down, recovered}`.
- **Write discipline:** `SET alert:{incidentId}:{direction} 1 NX EX 86400` — written **only after a confirmed send** (Telegram API 2xx). TTL 24 h bounds key growth; a recurring incident gets a new `incidentId` anyway.
- **Check-before-retry:** every attempt (BullMQ retry or a redelivered outbox event) checks `EXISTS alert:{incidentId}:{direction}` first; if held, the processor skips the send and completes the job successfully.
- **Attempt bound:** ≤ 3 BullMQ attempts, then the job dead-letters (7-day retention, D-14).
- **Residual duplicates** (send succeeded, response lost, and the key write also lost) are accepted, documented at-least-once behavior — preferable to silence.

### 16.5 Uptime semantics decision (D-6 / Q-1)

Locked decision: **lifetime counters remain the displayed numbers** — `uptime_percent = (total_checks − failed_checks) / total_checks` over the monitor's lifetime, the current behavior (behavior-compatibility constraint). Consequences:

- No display change during the behavior-compatibility window; the dashboard/status-page contract is untouched.
- The nightly `recompute-uptime` job suggested in earlier queue sketches has no algorithm and no purpose while counters are authoritative — v1 job lists must not include it.
- Windowed uptime (24 h/7 d/30 d computed from `pings` via the `(monitor_id, created_at)` index, stored per-window) ships **flagged in Phase 8** (DAT-11); those columns are added then, not now.

### 16.6 Writer failure modes (D-07 shape)

| Failure | Detection | Response | Recovery |
|---|---|---|---|
| Duplicate job delivery runs the transition transaction twice | Step-2 conditional UPDATE returns 0 rows; or the incident INSERT hits the `ON CONFLICT` no-op | Transaction commits as a near-no-op: evidence ping recorded, no second incident, no double counter increment, no second outbox row | None needed — idempotent by construction; TC-DUP-INCIDENT-01 pins it |
| Crash between transition commit and alert enqueue | Impossible by construction: the outbox row is committed **inside** the Tier 1 transaction (D-2) | Relay selects the unsent row on its next pass (`sent_at IS NULL`) | Relay retry; §16.4 dedup collapses any duplicate alert deliveries |
| Flush re-applied after a crash between commit and Redis-hash delete | `write_guards` insert returns 0 rows for the same `flush:{batchId}` key | Transaction exits **before** the UPDATE — counters change by zero | Redis hash deleted on the retry's exit path; TC-FLUSH-GUARD-01 pins it |
| Outbox relay crashes mid-batch | Row locks released on crash; affected rows still have `sent_at IS NULL` | Unsent rows re-selected on the next relay pass (`FOR UPDATE SKIP LOCKED` clears after crash) | `sent_at` set once per row; §16.4 dedup collapses redelivered alert events; TC-DUP-ALERT-01 pins it |

---

## 17. Proposed Email Provider Abstraction

Current: Nodemailer transport created at module scope against Hostinger SMTP ([src/lib/mail.ts](../src/lib/mail.ts)); template strings inline; send awaited in the registration request path.

Target:

```
src/lib/email/
  types.ts          # EmailProvider interface: send({ to, subject, html, text, tags }) : Promise<{ id }>
  provider-smtp.ts  # Nodemailer (Hostinger) — default, keeps current behavior
  provider-resend.ts# HTTP API provider (example of the abstraction paying off)
  provider-console.ts # dev: logs instead of sending
  index.ts          # getEmailProvider() from EMAIL_PROVIDER env; typed errors
  templates/        # verification.tsx or .ts (keep current SpiderNode HTML template, extracted)
```

Rules:
- **Interface-first (rule 16):** callers (`register`, `forgot-password`, Better Auth hooks, future alert emails) depend only on `send()`; provider selection is env-driven (`EMAIL_PROVIDER=smtp|resend|ses|console`).
- **Never in the request path:** registration/forgot-password enqueue an `email` BullMQ job (small `email-transactional` queue, 5 attempts, backoff) so SMTP latency/outage can't fail signup; Better Auth's `sendVerificationEmail` hook delegates to the same queue.
- **Failure semantics:** retryable errors (429/5xx/timeout) vs permanent (invalid address) mapped to typed errors so BullMQ doesn't retry hopeless sends.
- Existing HTML template is preserved as-is during migration (rule 19 — no redesign), just relocated.
- Healthchecks: alert emails (UPGRADE_PLAN phase 7) reuse the same abstraction from the `alerts` queue processor.

---

## 18. Proposed AI SDK Architecture

No AI exists today; Vercel AI SDK is greenfield. Governing rule: **AI is never in the monitoring critical path (rule 15).**

Placement:

```
src/app/api/ai/*/route.ts      # thin, session-guarded endpoints; stream responses
src/lib/ai/provider.ts         # AI SDK instance (model selection via env: AI_MODEL, provider keys)
src/lib/ai/prompts/            # versioned prompt templates
```

Approved, decoupled use cases (all user-initiated, all async):

1. **Incident summarization** — given a monitor's incident + pings window (fetched from Postgres on demand), produce a human-readable post-mortem draft. Job-based or on-demand; output never written back to `incidents` automatically.
2. **Status-page / incident message drafting** — assist compose for public updates; user edits before publishing.
3. **Monitor-setup assistant** — natural-language → monitor config JSON (URL, interval, keyword), validated by the same zod schema the manual form uses; never executed without user confirmation.
4. **Alert noise triage (later)** — batch, nightly job classifying flapping monitors; advisory only.

Hard boundaries:

- Monitoring check → transition → alert pipeline contains **zero AI calls**; AI outage must be invisible to uptime accuracy (no AI in `check-http`, `persist`, or `alerts` processors).
- All AI endpoints: auth-required, rate-limited (Redis limiter), input-size capped, timeouts set, streaming preferred so long generations don't hold serverless/VPS resources.
- Feature-flagged (`AI_ENABLED=false` default) so the app runs fully without any AI keys.
- Model/provider choices are centralized in `lib/ai/provider.ts` to avoid key sprawl; never log prompt contents containing user URLs/secrets.

---

## 19. Theme Architecture

Current state (verified against `globals.css`, root layout, and component usage):

- Tailwind CSS v4 via `@tailwindcss/postcss`; `@import "tailwindcss"` + `tw-animate-css`; shadcn token mapping via `@theme inline` (`--color-*` mapped onto raw CSS vars).
- The class-based `dark` variant already exists: `@custom-variant dark (&:is(.dark *))` — but `className="dark"` is **hardcoded on `<html>`**, and the `:root` and `.dark` variable blocks are **byte-identical dark palettes**. The app is permanently dark; **no light palette exists at all**.
- **No theme infrastructure is present**: zero matches for `next-themes`, `ThemeProvider`, `useTheme`, `prefers-color-scheme`, or any theme-storage key across `src/`. No toggle UI.
- Components frequently bypass tokens with hardcoded hex (`bg-[#121212]`, `text-[#EF4444]` throughout `Dashboard.tsx`), and several surfaces are styled light regardless (`sweetalert2` logout dialog, Lottie loader overlays `bg-white/80`). Sidebar tokens use a green `--sidebar-primary` while `--primary` is brand red — an existing token inconsistency.
- Sonner's `<Toaster>` is fixed to `theme="dark"` in the root layout.

Target (implement infra early; visual redesign deferred to the final phase per rules 17–19):

1. **Mechanism:** keep the existing class-based `dark` variant; toggle `.dark` on `<html>`, persisted to `localStorage`, with an inline blocking script in the root layout applying the stored/system theme before first paint (no FOUC, no hydration mismatch).
2. **Provider:** `next-themes` (small, SSR-safe, App Router-native) — recommended over a custom provider for its `<html suppressHydrationWarning>` handling.
3. **Tokens:** author a real `:root` (light) palette; keep today's dark values as `.dark` so the default visual experience is unchanged on rollout. Make the current values the baseline rather than a redesign.
4. **Toggle UI:** shadcn `dropdown-menu` pattern (Light / Dark / System) in `AppHeader`/`NavUser`; "System" respects `prefers-color-scheme`. Pass the resolved theme to sonner's `<Toaster>`.
5. **Token hygiene (prerequisite work, mechanical):** migrate hardcoded hex classes in components to semantic tokens (`bg-background`, `bg-card`, `text-muted-foreground`, `text-destructive`…) and reconcile the sidebar/primary token mismatch. This is prep, not redesign, and is what makes rule 17 achievable.
6. **Scope control:** theme infra lands early (step 1 of §24); the **visual redesign** — new palettes, surfaces, motion polish, icon consolidation, dialog-system unification (`sweetalert2`/`window.confirm` → shadcn `alert-dialog`), light variants for Lottie/brand assets — happens only in the final phase (rules 18–19).

---

## 20. Migration Risks

| ID | Risk | Mitigation |
|---|---|---|
| M1 | **Dual-write/divergence during transition** — Prisma and Drizzle against the same tables | Don't dual-write. Cutover is by module with Drizzle owning the schema from day one of the migration branch; Prisma remains read-only fallback only until each module flips (rule 20 ⇒ removed at the end) |
| M2 | **Auth cutover locks users out** (hash/session/cookie incompatibility) | Password-hash compatibility spike first (§12); keep user IDs; accept forced re-login (sessions invalidated) as a known, announced consequence; keep old NextAuth tables intact for rollback |
| M3 | **Monitoring gap during worker cutover** (checks stop while jobs move) | Run overlap window: worker live and verified (healthchecks.io + queue depth ≈ 0) *before* disabling `instrumentation.ts` cron; both paths idempotent so brief overlap only wastes checks, never corrupts |
| M4 | **Counter corruption** from overlapping old/new write paths during overlap | Make increments SQL-atomic in the new path first; old path disabled before first new-path flush; verify totals before/after |
| M5 | **`monitors.id` type drift** breaks public URLs/FKs | Keep `serial` integers (§11.1) |
| M6 | **Timestamp TZ drift** (Prisma `timestamp` ↔ Drizzle `timestamptz`) silently shifts stored times | Inspect live column types before writing the Drizzle schema; pin explicit modes; validate with a data diff script (§21) |
| M7 | **Redis becomes a hidden dependency** — outage taken as full outage | §13 degradation rules; routine-ping fallback write; alerts/heartbeat monitor queue health |
| M8 | **BullMQ repeatable-job drift** after Redis restarts (missing/duplicated schedules) | Repeatable jobs are declarative (upserted at worker boot); idempotency keys absorb duplicates; scheduler leader lock prevents parallel ticks |
| M9 | **Next 16/React 19 + pnpm migration churn** mixed with backend migration | Do package-manager + Next patch bump as an isolated first step with its own verification (§24 step 0) |
| M10 | **`typescript.ignoreBuildErrors: true`** hides migration type breakage | Turn it off at migration start; fix errors as part of step 0 (small codebase; feasible) |
| M11 | **Vercel-mode cron parity** — features silently missing after cutover | `CRON_MODE` is deleted; the worker replaces both modes; update docs/deploy scripts to remove healthchecks/external-cron duplication |
| M12 | **Advanced-monitoring schema (UPGRADE_PLAN) collides with migration** | Freeze new schema features until Drizzle cutover completes; reserved columns documented in §11 rather than added twice |

---

## 21. Data Migration Risks

| ID | Risk | Handling |
|---|---|---|
| D1 | **No migration history exists** (`db push` only) — live schema may drift from `schema.prisma` | Baseline first: dump actual DDL (`pg_dump --schema-only`) from production; generate the Drizzle schema from **reality**, then re-introduce versioned migrations (drizzle-kit) from that baseline |
| D2 | **Row preservation** — users/monitors/pings/incidents/feedbacks must survive with IDs intact | Tables are renamed-preserving (same table names, §11) ⇒ in-place additive migration; no table rewrite for existing columns; new indexes `CREATE INDEX CONCURRENTLY` |
| D3 | **Password hash portability** | Keep bcrypt hashes verbatim into Better Auth account rows; verify with a canary login test before cutover |
| D4 | **OAuth account reshaping** (NextAuth `accounts` → Better Auth `account`) | Mechanical column map; preserve refresh tokens; users may need to re-link if a provider secret rotates — acceptable |
| D5 | **Token tables reset** | `verification_tokens` / `password_reset_tokens` truncated; users re-request (tokens ≤24 h) |
| D6 | **Sessions invalidated** | Announce re-login; better-auth sessions start empty |
| D7 | **`uptimePercent` semantic change** if we move to window-based uptime | Recompute once from `pings` at cutover and store; keep lifetime math visible only through the same API shape to avoid dashboard regressions |
| D8 | **Retention gap/overrun** during cutover (cleanup job moves) | Run cleanup manually before/after; the 30/90-day rules are unchanged |
| D9 | **Idempotent migration script requirement** — migration re-runs after partial failure | Every step guarded (IF NOT EXISTS / INSERT … ON CONFLICT DO NOTHING); dry-run against a staging copy of production data; row-count + checksum verification report |
| D10 | **Backups** | `pg_dump` full backup immediately before cutover; keep until verification window closes |

Sequencing note: the data migration is **mostly schema-additive** because we keep table names, PK types, and column names. The two reshapes (auth tables, token tables) are the only destructive steps, and both are rollback-tolerant (old tables retained for one release).

---

## 22. Deployment Changes

Current: GitHub Actions on push to `main` → `npm ci` → build → SCP tarball → VPS → `npm ci --omit=dev` → `prisma generate` → `prisma db push --accept-data-loss` → `pm2 start` (single PM2 app, [deploy.yml](../.github/workflows/deploy.yml)).

Target changes:

1. **pnpm:** `pnpm fetch/install --frozen-lockfile` in CI; commit `pnpm-lock.yaml`; remove `package-lock.json` (and the stray `allowScripts` block moves to pnpm's `onlyBuiltDependencies`).
2. **Two PM2 apps** in [ecosystem.config.js](../ecosystem.config.js): `uptime-tracker` (web, unchanged) + `uptime-worker` (new, `worker/dist/index.js`), with `kill_timeout` to let the worker drain jobs and flush aggregates on deploy.
3. **Migrations replace `db push`:** `pnpm drizzle-kit migrate` (versioned SQL files committed to the repo) runs in the deploy script **before** app/worker restart; delete `--accept-data-loss` forever.
4. **Worker build artifact:** tsc/tsup build of `worker/` included in the tarball (or the whole deploy switches to a single `pnpm build` producing `.next` + `worker/dist`).
5. **Env additions:** `REDIS_URL`, `EMAIL_PROVIDER`, provider keys, `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`, `AI_*` (optional/flagged); retire `NEXTAUTH_*`, `CRON_MODE` (keep `CRON_SECRET` only if the API-triggered cleanup path is retained during transition).
6. **Health surfaces:** worker `:9090/healthz|readyz` wired to PM2 restart + healthchecks.io; heartbeat moves from web cron to worker scheduler tick.
7. **Rollback story:** keep previous release tarball on VPS; DB migrations are forward-only but additive-first (§21/D2) so the previous web+worker pair runs against the migrated schema during the verification window.
8. **Repo hygiene (do early):** remove `ngrok` binary + `ngrok.log` from git (and purge from history or accept the bloat), add `.env.example` documenting the full variable set (currently only prose in README).
9. Optionally split CI jobs: `lint → typecheck → test → build` gates before deploy (no gates exist today).

---

## 23. Testing Requirements

*Amended 2026-09-09 (resolves D-1, D-4, J-2; §9 items 2, 8, 12; §10 criterion 3)*

Today there are **no tests** (no unit/integration/E2E framework, no CI gates; only ad-hoc root scripts `test-email.js`, `test-prisma*.js`, `test-webhook.js`). The migration must introduce a safety net *before* the risky steps:

**Stack:** Vitest (unit/integration, workers + lib) · Testcontainers or docker-compose Postgres+Redis for integration · Playwright (E2E, dashboard + status page).

**Minimum gate before any migration step (Phase 0):**
1. **Characterization tests** for `runCronChecks`: due-time filter, UP/DOWN classification, transition paths (PENDING→UP, UP→DOWN, DOWN→UP), incident open/resolve, Telegram message selection — against a test DB, with `fetch` stubbed. These pin current behavior so the rewrite provably preserves it (rule: "modernize without breaking existing functionality").
2. **db-batcher tests:** enqueue/flush math, counter accumulation, flush-failure data-loss behavior (documented, then intentionally changed by §16).
3. **API contract tests:** per route — auth required, ownership scoping, validation, status codes. These become the Drizzle/Better Auth regression net.

**New-path tests:**
4. **Worker unit tests:** idempotency key short-circuit; lock acquire/release incl. owner-only release; retry/backoff config; transition transaction (monitor+ping+incident atomic).
5. **Aggregation tests:** concurrent `HINCRBY` correctness; flush exactly-once (idempotent apply); Redis-down fallback write; buffer bounded.
6. **Failure-injection integration tests:** Redis down ⇒ degradation, Postgres intact (rule 13); Postgres down ⇒ jobs retry, no loss (rule 14); duplicate `check` jobs ⇒ single write (rule 10); DOWN then immediate RECOVERED ⇒ one incident pair, correct status (rule 8).
7. **Auth migration tests:** canary login (bcrypt verify), OAuth account row mapping, session acquisition, email-verification and reset flows end-to-end.
8. **Email abstraction tests:** provider selection by env, retryable vs permanent error classification, queue offload (registration succeeds when SMTP is down).
9. **E2E smoke (Playwright):** register → verify → login → create monitor → manual check → status appears → incident flow on simulated DOWN → public status page renders; theme toggle persists across reload.
10. **CI:** GitHub Actions — pnpm install, lint, typecheck (`ignoreBuildErrors` off), unit+integration on PR; deploy job only from `main` after green.

**Data-correctness cases (given/when/then, per review §10 criterion 3).** Each case states its expected observable effect as DB rows, Redis keys, or queue state so Phase 2's characterization suite and Phase 4's failure-injection tests transcribe it directly.

**TC-DUP-INCIDENT-01 — duplicate transition delivery creates exactly one ONGOING incident**
- Given: monitor id 42 (`status='UP'`, `is_active=true`); an `ONGOING` incident `inc-7` (started 10:00:00Z) exists for monitor 42; a duplicate check-job delivery classifies DOWN again at 10:05:00Z (`$target='DOWN'`)
- When: the §16.1 transition transaction executes twice for `$mid=42` (each execution supplies a distinct evidence ping, `ping-a1` then `ping-a2`)
- Then: **DB** — `incidents` still contains exactly one row with `status='ONGOING'` for `monitor_id=42` (`inc-7`; the second run's conditional UPDATE returns 0 rows so no incident INSERT is attempted, and a concurrent double-insert would be a physical no-op via `incidents_one_ongoing`); `pings` contains **both** evidence rows (`ping-a1`, `ping-a2`, `status='DOWN'` — evidence is never deduplicated); `monitors.total_checks` and `failed_checks` advance by **1** each across both runs (counters ride the conditional UPDATE); `outbox` gains exactly **1** new `incident.down` row (first run only). **Queue** — the relay enqueues exactly one alert job for `inc-7`.

**TC-DUP-ALERT-01 — redelivered outbox event sends no second Telegram alert**
- Given: incident `inc-7` whose Telegram DOWN alert was sent at 10:05:05Z; Redis key `alert:inc-7:down` is held (TTL 86400); the outbox row is already `sent_at=10:05:04Z`; BullMQ redelivers the alert job
- When: the alerts processor handles the redelivered event
- Then: **Redis** — zero additional `SET alert:inc-7:down` operations (the `EXISTS` check short-circuits; the key's TTL is untouched). **Telegram** — zero additional `sendMessage` calls. **DB** — the outbox row's `sent_at` stays at its single set value (marked sent exactly once; no re-marking). **Queue** — the redelivered alert job **completes successfully** (not failed); its attempts counter increments toward the ≤ 3 bound without any re-send.

**TC-FLUSH-GUARD-01 — re-applied flush batch changes counters by zero**
- Given: flush batch `flush:b-1024` for monitor 42 was already applied at 10:06:00Z (a `write_guards` row with `key='flush:b-1024'` exists; `monitors.total_checks=101`); the flush job crashed after COMMIT but before deleting the Redis hash `agg:results:42`, and BullMQ redelivers
- When: the §16.2 guarded flush re-runs with the same batch id (`flush:b-1024`) and the same deltas (`$dTotal=4`, `$dFailed=0`, `$lastTs=10:05:58Z`, `$lastRt=210`)
- Then: **DB** — the `write_guards` `INSERT … ON CONFLICT DO NOTHING RETURNING key` returns **0 rows**, and the transaction exits **before** the UPDATE: `monitors.total_checks` stays 101 (change by zero), `last_checked` and `response_time` unchanged; no new `write_guards` row. **Redis** — `agg:results:42` is deleted on the retry's exit path (cleanup proceeds despite the skip).

**TC-MONOTONIC-01 — late-arriving buffered result cannot regress display fields**
- Given: monitor 42 with `last_checked=T1=10:06:00Z`, `response_time=250`, `total_checks=100`, `failed_checks=5`; a buffered routine result with timestamp `T0=10:04:30Z` (older than T1) and response 900 ms flushes in a batch with deltas `$dTotal=1`, `$dFailed=0`, `$lastTs=T0`, `$lastRt=900`
- When: the §16.2 guarded flush applies the batch
- Then: **DB** — `last_checked` stays `T1` (`GREATEST(T1, T0)=T1`); `response_time` stays 250 (`CASE WHEN T0 > T1` is false → ELSE keeps the current value; the older sample does not overwrite); `total_checks=101` and `failed_checks=5` (the buffered deltas still apply additively); `status` is untouched (Tier 2 never writes status). **Redis** — the batch hash is deleted only after the flush transaction commits.

---

## 24. Recommended Migration Order

Sequenced so every step ships value, remains revertible, and never leaves monitoring broken. Rules references in parentheses.

| # | Step | Contents | Rules honored |
|---|---|---|---|
| 0 | **Foundations (no behavior change)** | pnpm + lockfile migration; enable typecheck (drop `ignoreBuildErrors`); Vitest + Playwright scaffolding; characterization tests for cron/batcher/API (§23.1–3); repo hygiene (remove ngrok artifacts, `.env.example`) | — |
| 1 | **Theme infrastructure** | `next-themes`, `.dark` variant, token audit of `globals.css`, toggle component; **no visual redesign** | 17, 18, 19 |
| 2 | **Redis introduction** | Add Redis client (`ioredis`), Redis-backed rate limiter + cache; no behavior dependence yet; AOF + `noeviction` config documented | 2, 13 |
| 3 | **Drizzle adoption (additive)** | drizzle-kit baseline from live DDL (§21/D1); versioned migrations introduced; Drizzle instantiated alongside Prisma; new code (queues, email) uses Drizzle only | 1, 20-partial |
| 4 | **BullMQ + dedicated worker (the core move)** | Worker process + queues (§14–15); move check engine; scheduler leader lock, per-monitor locks, idempotency keys, retries/backoff; DOWN/RECOVERED immediate path; aggregation buffer replaces `db-batcher.ts`; overlap-run old cron, then **delete `instrumentation.ts` cron + `CRON_MODE`** | 3–14 |
| 5 | **API routes become thin** | Manual-check route → enqueue + 202; rate limits via Redis; remove stack-trace leakage; fix feedback exposure (R17), SSRF validation (R19), secret-in-query (R15) | 5, 6 |
| 6 | **Email abstraction** | `lib/email` interface + SMTP provider + queue offload; Better Auth hooks wired to it | 16 |
| 7 | **Better Auth cutover** | Password-hash spike → migrate `users`/`accounts`/tokens (§12, §21); flip routes to Better Auth handlers; invalidate sessions (announced); delete NextAuth deps + duplicated Redux auth-token mirror | — |
| 8 | **Prisma removal** | Port remaining routes/read paths to Drizzle; delete `prisma/`, generated client, deps; Drizzle is sole ORM | 20 |
| 9 | **AI SDK (flagged)** | `lib/ai` + streaming endpoints for incident summarization & monitor-setup assistant; feature-flag off by default | 15 |
| 10 | **Final visual redesign** | The UI overhaul on top of stable theme tokens + stable APIs (shadcn expansion, hugeicons consolidation, light palette refinement, motion polish, sweetalert2 → shadcn alert-dialog) | 17–19 |

**Critical-path dependencies:** 0 → (1,2,3 in parallel) → 4 → 5/6 → 7 → 8 → 9/10. Step 4 is the highest-risk step and depends on 2–3; it must ship behind the overlap window described in M3.

---

## Appendix A — Environment Variable Inventory (current)

| Variable | Used in | Notes |
|---|---|---|
| `DATABASE_URL` | lib/prisma.ts | Postgres (Neon-compatible) |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | lib/auth.ts, lib/mail.ts, proxy.ts | Retire with Better Auth (mail.ts should use an explicit `APP_URL`) |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | lib/auth.ts | OAuth |
| `CRON_SECRET` | cron routes | Bearer or `?secret=` |
| `CRON_MODE` (`internal`\|`vercel`) | instrumentation.ts | Deleted at worker cutover |
| `HC_PING_URL` | instrumentation.ts | healthchecks.io dead man's switch |
| `TELEGRAM_BOT_TOKEN`, `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | telegram.ts, api/telegram/connect | Alerts + connect deep link |
| `SMTP_HOST/PORT/USER/PASS` | lib/mail.ts | Hostinger SMTP |
| `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` | api/user/profile | Avatar uploads |
| `NEXT_PUBLIC_ENV`, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_DEV_BASE_URL` | redux/api/baseApi.ts | Client API base URL selection |
| `NEXT_PUBLIC_APP_URL` | README only | Referenced in docs but unused in code — reconcile |

*(Redis/AI/email-provider variables listed in §22 are additions, not current state.)*

## Appendix B — Architectural Rules Traceability

| Rule | Where addressed |
|---|---|
| 1 PostgreSQL source of truth | §11, §13, §16 |
| 2 Redis = infrastructure | §13 |
| 3 BullMQ = orchestration | §14 |
| 4–6 Dedicated worker; API ≠ worker | §15, §24 step 4–5 |
| 7 Replace in-memory batching | §5 → §16 |
| 8 Immediate DOWN/RECOVERED | §14, §16 Tier 1 |
| 9 Routine UP batching | §16 Tier 2 |
| 10 Idempotency | §14, §23.6 |
| 11 Retries + backoff | §14 |
| 12 Distributed locks | §13, §14 |
| 13 Redis failure ⇒ no corruption | §13, §16, §23.6 |
| 14 PG failure ⇒ retryable jobs | §13, §14, §16 |
| 15 AI off critical path | §18 |
| 16 Email abstraction | §17 |
| 17–19 Theme + phased UI | §19, §24 steps 1/10 |
| 20 Remove Prisma after migration | §11.7, §24 step 8 |
