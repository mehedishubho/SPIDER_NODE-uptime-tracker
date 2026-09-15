# SpiderNode — Architecture Audit

> **Repository:** SPIDER_NODE-uptime-tracker
> **Audit date:** 2026-09-08
> **Scope:** Full-repository inspection (backend, frontend, data layer, jobs, deployment) in preparation for the modernization to Next.js 16 App Router + Drizzle + Better Auth + Redis + BullMQ + dedicated monitoring worker.
> **Status of this document:** Audit + target architecture proposal. **No application code was modified.**
> **Amendment note:** This document was amended on 2026-09-09 to incorporate the design addenda required by [ARCHITECTURE-REVIEW.md](./ARCHITECTURE-REVIEW.md) §8. Amendment markers appear inline as "Amended 2026-09-09 (resolves &lt;issue-ids&gt;)" — new sections carry the same marker form prefixed "Added". The operator-facing deploy procedure is [DEPLOY-RUNBOOK.md](./DEPLOY-RUNBOOK.md). A 2026-09-09 fix-cycle pass (re-review cycle 1 follow-up, per 01-REREVIEW.md §6/§10) further amended sections to close the escalated gap set; fix-cycle amendments carry markers of the form "Amended 2026-09-09, fix cycle (resolves &lt;issue-ids&gt;)".

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
| Scheduler | `node-cron` inside web process / Vercel Cron HTTP trigger | BullMQ Job Schedulers + worker |
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

*Amended 2026-09-09 (resolves A-1, A-2, A-3, S-2, S-3; §9 items 14, 15, 16, 17, 18)*

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

- **Password hashes must survive.** Better Auth stores `account.password` (its own `account` table). Migrate existing `users.password` bcrypt hashes into Better Auth's account rows with `providerId: "credential"`; bcrypt hashes remain verifiable if Better Auth's password config keeps bcrypt (it supports custom hash functions — the §12.2 compatibility gate's hash-prefix routing step is the specified verification path for this, not an ad-hoc investigation).
- **User IDs are cuid strings** — Better Auth accepts a text `id` primary key; keep existing IDs so monitors/feedback FKs remain valid.
- **OAuth identities** in `accounts` must be reshaped into Better Auth's `account` table (`providerId`, `accountId`, `accessToken`, etc.) — column mapping is mechanical but must preserve refresh tokens.
- `verification_tokens` / `password_reset_tokens` rows can be truncated at cutover (users simply re-request; tokens are short-lived).
- `NEXTAUTH_SECRET`/`NEXTAUTH_URL` env names retire in favor of `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` (+ `NEXT_PUBLIC_*` where the client needs them).
- **Canary gate before any route flip (A-1 / AUTH-02).** A canary account must log in through the preserved hash path on the anonymized snapshot, then in production, before any route flips — ordering in §12.2.
- **Drizzle FKs must reference the schema key, not the modelName** (upstream better-auth issue #8111) — warning in §12.1.
- **ID generation stays DB-side** (§11 / D-3 pin); Better Auth's `advanced.database.generateId` must agree — §12.1.

### 12.1 Field-mapping tables (D-09)

Field lists below are the **verified Better Auth 1.7 core schema** (extracted from `get-tables.ts` — Phase 1 research, HIGH confidence). Columns: current column → Better Auth field → mapping rule → confidence. Cells the design cannot yet guarantee carry the explicit marker **confirm by Phase 7 dry-run**; Phase 7 research fills only those marked gaps, it never re-derives the mapping.

#### `users` → Better Auth `user` (A-3: bound to the existing table — no renames)

| Current `users` column | Better Auth `user` field | Mapping rule | Confidence |
|---|---|---|---|
| `id` (text, cuid PK) | `id` | **preserved verbatim — no rename, no regeneration**; every FK (`monitors`, `feedbacks`, account rows) depends on it | verified |
| `name` (nullable) | `name` (required, sortable) | copied; existing NULLs backfill to `''` at migration (core marks the field required) | verified |
| `email` (unique) | `email` (required, unique) | copied; the unique constraint is preserved | verified |
| `emailVerified` (DateTime, nullable) | `emailVerified` (BOOLEAN, required, not input-accepted) | **truthiness backfill: `emailVerified IS NOT NULL`** — any non-NULL NextAuth verification timestamp ⇒ `true`, NULL ⇒ `false`. The timestamp value itself is not carried; only its presence | verified |
| `image` (nullable) | `image` | copied verbatim | verified |
| `createdAt` | `createdAt` | preserved as-is (live column type per the M-6 / DRZ-01 verify-against-pg_dump marker) | verified |
| `updatedAt` | `updatedAt` | preserved; Better Auth maintains it on write | verified |
| — (new column) | `role` (admin plugin) | added with the Better Auth admin plugin (§12.4); default `user` | verified |

Unmapped app-owned columns (`telegramChatId`, `timezone`) are untouched — Better Auth only owns the fields above.

#### `sessions` (legacy) → Better Auth `session` (new table)

Better Auth uses **server-side sessions**. The legacy `sessions` table (written by the PrismaAdapter but never consulted under the JWT strategy — dead weight) is **not migrated**: sessions start empty at cutover (forced re-login, §12.6) and the legacy table is retained read-only for one release, then dropped (AUTH-07). The mapping below defines shape compatibility only:

| Legacy `sessions` column | Better Auth `session` field | Mapping rule | Confidence |
|---|---|---|---|
| `sessionToken` (unique) | `token` (required, unique) | shape-compatible; **zero rows migrated** — sessions are invalidated at cutover | verified |
| `userId` | `userId` (required, FK → `user`, cascade, indexed) | shape-compatible; FK references the schema key `user` — see the adapter warning below | verified |
| `expires` | `expiresAt` (required) | shape-compatible; Better Auth manages session TTLs | verified |
| — | `ipAddress`, `userAgent` | new; recorded by Better Auth on session create | verified |
| — | `createdAt`, `updatedAt` | new; Better Auth-managed | verified |

#### `accounts` → Better Auth `account` (reshaped per §21-D4)

| Current `accounts` column | Better Auth `account` field | Mapping rule | Confidence |
|---|---|---|---|
| `providerAccountId` | `accountId` (required) | copied verbatim — the provider's immutable user id; unique with `providerId` | verified |
| `provider` (`google` \| `github`) | `providerId` (required) | assumed lowercase `google` / `github` casing | **confirm by Phase 7 dry-run** |
| `access_token` (Text, nullable) | `accessToken` | copied | verified |
| `refresh_token` (Text, nullable) | `refreshToken` | copied — **refresh tokens MUST survive the reshape**; losing them breaks silent re-auth until re-consent | verified |
| `id_token` (Text, nullable) | `idToken` | copied when present | verify against live pg_dump (M-6) |
| `expires_at` (nullable) | `accessTokenExpiresAt` | copied; NULL-safe | verified |
| `scope` (nullable) | `scope` | copied when present | verify against live pg_dump (M-6) |
| `type` | — (no equivalent field) | dropped at reshape; Better Auth discriminates OAuth vs credential rows via `providerId` | verified |
| `userId` | `userId` (required, FK → `user`, cascade, indexed) | preserved — user ids unchanged | verified |
| `users.password` (bcrypt hash) | `password` | moved out of `users` into per-user credential rows (`providerId: 'credential'`, `accountId` = user id) — §12.2 | verified |

#### `verification_tokens` → Better Auth `verification` (new table)

| Current `verification_tokens` column | Better Auth `verification` field | Mapping rule | Confidence |
|---|---|---|---|
| `email` | `identifier` (required, indexed) | copied at reshape; Better Auth keys both email-verification and password-reset flows off `identifier` | verified |
| `token` (unique) | `value` (required) | copied at reshape; ongoing tokens are Better Auth-generated | verified |
| `expires` | `expiresAt` (required) | copied | verified |

Both legacy token tables (`verification_tokens`, `password_reset_tokens`) truncate at cutover — tokens are short-lived and users simply re-request (§21-D5).

**Adapter warnings (Phase 7 Drizzle):**

- **FKs reference the schema key, not the modelName** (upstream better-auth issue #8111): Better Auth's generated foreign keys reference the schema *key* (`user`) even when the model is aliased to a different physical table (`users` via `modelName`). The Drizzle adapter's FK definitions must reference the schema key or the mapping breaks — verify in the Phase 7 dry-run.
- **ID pin (cross-ref §11 / D-3):** `advanced.database.generateId` (`false | "serial" | "uuid" | fn`) is the config surface for id generation. The project pin is **DB-side `gen_random_uuid()::text` defaults with existing cuid ids preserved** — configure `generateId` to defer to the column default and confirm the exact adapter behavior in the Phase 7 dry-run.
- The field-map columns above must stay aligned with §11's schema markers (mapping decision 6: `accounts` replaced by Better Auth's `account`; `session` / `verification` added new).

### 12.2 Password hashing — bcrypt compatibility gate (A-1 / AUTH-01, AUTH-02, AUTH-09)

Better Auth's **default password hashing is scrypt**; every existing credentials user has a bcrypt hash. Without explicit configuration, all of them are locked out at cutover — this is a **gate, not a spike**:

1. **Wire `emailAndPassword.password.hash` / `.verify` to bcrypt-compatible functions** at configuration time (Phase 7), with **hash-prefix routing** in `verify`: stored hashes prefixed `$2a$` / `$2b$` / `$2y$` (bcryptjs output) verify via bcrypt; modern-default hashes verify via the modern verifier. `hash` always produces the modern default.
2. **Canary login gate — the ordering is non-negotiable:** a canary account must log in through the preserved hash path on the **anonymized snapshot**, then in **production**, **before any route flips**. Snapshot → production → flip. A failed production canary aborts the cutover.
3. **Lazy rehash-on-login (AUTH-09):** a successful bcrypt verify re-stores the hash through `password.hash` (modern default) — stored hashes upgrade gradually with no bulk rehash job and no forced password resets.

### 12.3 Session architecture — cookieCache (A-2 / AUTH-04)

- **Server-side sessions + `cookieCache`:** the proxy (and API session checks) validate the **signed cookie cache** without a per-request DB hit. TTL **5 min**.
- **`disableCookieCache: true` on sensitive endpoints** (password change, email change, session list/revocation) — those always read the DB.
- **DB fallback:** a cold or invalid cache falls back to the session-table read and re-signs — correctness never depends on the cache being warm.
- **Revocation latency is bounded by the TTL (≤ 5 min worst case)** — the accepted cost of cookieCache; account deletion / plan change revocations apply at TTL expiry at the latest.

### 12.4 Roles and admin surfaces (A-3 / S-3 / SEC-04) + manual-check rate limit (D-13)

- **Better Auth `admin` plugin** adds the `role` column on `users` (§12.1) — the fix vehicle for S-3.
- **Feedback listing is admin-only** (fixes R17 — today any authenticated user can read every user's name/email via `GET /api/feedback`).
- **Queue UI (Bull Board) is admin + IP allowlist** (OBS-04) — never an unauthenticated surface.
- **Manual-check per-user rate limit (D-13 / SEC-05, user-facing choice):** **1 per monitor per 30 s and 6 total per minute per user across monitors** — enforced at the API route via the Redis limiter (`rl:` keys, §13.1) before enqueue, per Q-5's enqueue-and-poll UX.

### 12.5 Telegram webhook authentication (S-2 / SEC-03 — decision note; implementation Phase 6)

The webhook is authenticated with Telegram's `secret_token` mechanism:

- `setWebhook` carries a `secret_token` — charset `[A-Za-z0-9_-]`, length 1–256 (core.telegram.org/bots/api#setwebhook).
- Telegram then sends the `X-Telegram-Bot-Api-Secret-Token` header with every update; the handler validates it via **constant-time comparison** against the configured secret and rejects wrong/missing headers before touching the payload.

### 12.6 Cutover sequencing — decided items

- **Forced re-login at cutover: DECIDED** — accepted consequence (M2 / §21-D6), **announced in-app and by email per Q-4**. Not an open question. Sessions start empty under Better Auth.
- **Legacy `sessions` / `verification_tokens` / `password_reset_tokens` tables stay read-only for one release post-flip**, then drop (rollback window, AUTH-07).

---

## 13. Proposed Redis Architecture

*Amended 2026-09-09 (resolves J-5, J-6, R-1, D-4, D-7; §9 items 5, 7, 13)*
*Amended 2026-09-09, fix cycle (resolves CR-01, CR-02, IN-02, IN-04, OBS-01; §13.1 aggregation rows now describe live buffers + staging keys)*
*Amended 2026-09-09, fix cycle (resolves WR-02, IN-01, OBS-04, OBS-05; §13.1 limiter row adds the rl:manual-user key + Lua INCR/EXPIRE-NX atomicity, idempotency row carries both jobId forms, §13.8 budgets the web process's Redis connections)*

Redis is **infrastructure only** — never a source of truth (rule 2). Its complete role inventory: routine-UP result aggregation, rate limiting, alert dedup keys, and BullMQ job orchestration (queues, locks, Job Schedulers). PostgreSQL is always the source of truth and **no correctness path depends on Redis** — every piece of state below is recoverable from Postgres or disposable by design.

### 13.1 Key inventory

| Use | Key shape | TTL | Recovery story |
|---|---|---|---|
| BullMQ queues + Job Schedulers | `bull:{queues}` (managed by BullMQ) | — | Schedulers re-upserted at worker boot (§13.6); pending jobs drained from Redis; unacked checks re-created by the next tick's claim (§14.2) |
| Per-monitor check lock | `lock:check:{monitorId}` (`SET NX PX`, value `{workerId}:{jobId}`, owner-only Lua release) | 15 s = 10 s timeout + 5 s margin, renewed every TTL/3 (J-3; lifecycle in §15.1) | Expiry auto-releases; renewal failure aborts the check without persisting; a stale lock never delays the next check beyond its TTL — the lock is a performance guard, correctness rests on J-1/J-2/D-1 |
| Leader lock for the scheduler loop | `lock:scheduler` (single `SET NX`, renewed; no Redlock — excluded by the out-of-scope table) | ~30 s, renewed | Any worker can take over; defense-in-depth only (§14.2 step 1) |
| Routine-result aggregation (live buffers) | `agg:results:{monitorId}` (hash: count, failedCount, sumResponseTime, lastResponseTime, lastStatus, lastCheckedAt — counter deltas per routine check, `HINCRBY`/`HSET`) + `pings:pending:{monitorId}` (list: one per-check evidence row per routine check, `RPUSH` — drained by the §16.2 multi-row `INSERT INTO pings`) + `agg:pending` (set of monitor ids with unflushed deltas) | flushed ≤ 60 s; TTL as safety | **Loss-tolerable data only**; the monitor row itself always carries the last immediate (Tier 1) status; live keys are never deleted by a flush job — only moved to staging by the owning flush's snapshot (§16.2) |
| Flush staging keys (exclusive snapshot) | `agg:flushing:{batchId}` (hash) / `pings:flushing:{batchId}` (list) — created by the owning flush job's job-start `RENAMENX` (§16.2); `batchId = {epochMs-of-flush-pass}:{monitorId}` (IN-03) | none — deleted by the owning flush job after COMMIT (dead-lettered flush jobs retain their staging keys; see §16.6) | **Loss-tolerable data only**; the `write_guards` guard (`flush:{batchId}`) makes a manual retry of a dead-lettered flush a safe no-op if the batch ever applied; unapplied staged deltas are Tier 2 loss-tolerable (invariant 3) — detection via DLQ/outbox-age observability (§13.5, OBS-01) |
| Check-job idempotency (jobId) | two forms: scheduled `check:{monitorId}:{epoch}` (the claim-epoch key, §14.2 step 3) and manual `check:{monitorId}:manual:{epochMs-of-enqueue}` (unique per enqueue — the manual lane must never dedupe a user's second check; §14.1 manual-lane paragraph) — the BullMQ job id **is** the idempotency key in both lanes | retained while the completed job exists (`removeOnComplete` age 3600 s — the same horizon for both forms) | Duplicate adds with an existing jobId are ignored by BullMQ; at-least-once redelivery is absorbed by the §16 writers (write guards + conditional UPDATE); manual-lane admission is governed by the D-13 limiter (§12.4), not the jobId |
| Cache: dashboard summaries, status pages | `cache:status:{userId}`, `cache:dashboard:{userId}` | 15–60 s | Cache-miss rebuilds from Postgres |
| Rate limiting (replaces in-memory Map) | `rl:{bucket}:{ip}`, `rl:manual:{userId}:{monitorId}` (1 per monitor / 30 s), and `rl:manual-user:{userId}` (the §12.4 D-13 cross-monitor per-user counter — 6/min) — each limit check runs as a **single Lua script**: `INCR` followed by `EXPIRE` with NX semantics on the first increment, never a bare `INCR` with a separate `EXPIRE` call (IN-01/OBS-04: a crash between the two strands a TTL-less counter and permanently rate-limits the user) | window | Counter loss only loosens limits, never corrupts data |
| Alert dedup | `alert:{incidentId}:down` and `alert:{incidentId}:recovered` (incident events — non-NULL `incident_id` required) + `alert:{monitorId}:first_check` (monitor-scoped — the event has no incident; CR-03) (`SET NX EX 86400`, written only after a confirmed send) | 24 h | Duplicate alert worst case, no data impact (§16.4) |

### 13.2 Redis outage = monitoring pause, by design (R-1 / RES-03)

With BullMQ as the orchestrator, **no Redis = no jobs** — there is nothing to execute and nothing to write. An in-process fallback scheduler is therefore not merely undesirable but incoherent, and the project's out-of-scope table explicitly excludes it (reintroducing one would recreate forbidden process-local monitoring state). The design makes the pause explicit and visible instead:

1. **No fallback write path or fallback scheduler exists.** Redis outage = monitoring pause, by design. Postgres data stays consistent; nothing is partially written; transitions that cannot be recorded are not half-recorded.
2. **External dead-man's-switch detection.** The worker's scheduler tick heartbeats healthchecks.io (`HC_PING_URL`, §14.2 step 5); a heartbeat gap pages the operator. This is the *only* independent detection of the pause, and it must keep firing when the failure is Redis itself.
3. **Staleness surfaced in-product.** Dashboard and public status pages render "last checked Xm ago" from `monitors.last_checked` and visually degrade stale monitors — a hard requirement (RES-03), not an implication. The UI must never present stale statuses as current.
4. **Web behavior under Redis outage.** The web app serves uncached data (cache-miss rebuilds from Postgres); API routes that need to enqueue fail loudly (503), never silently no-op.

### 13.3 Circuit breaker around Postgres (D-11 / RES-01 / J-5)

A Postgres outage must not become a retry storm that compounds into Redis memory exhaustion under `noeviction` (J-5). The breaker wraps every Postgres-writing step in the worker with a three-state machine:

- **CLOSED (normal).** All lanes run. Every Postgres operation reports to the breaker: success resets the consecutive-failure counter to 0; an **infra-failure** increments it. *Infra-failure is exactly the class §15.1 step 5 defines* — Postgres unreachable, Redis unavailable, internal exceptions/bugs. Target outcomes (UP, DOWN, timeout, DNS failure, TLS failure) are successful jobs and **never** count toward the breaker.
- **OPEN (tripped).** After **5 consecutive infra-failures**, the breaker opens for **60 s**. OPEN pauses: (a) the scheduler tick's enqueue step — §14.2 steps 3–4, no new check jobs — and (b) queue consumption via `Queue.pause()` on `monitor-checks` and `db-writes` (in-flight jobs finish their bounded attempts; nothing new starts). OPEN **never pauses the healthchecks.io heartbeat** (§14.2 step 5) — the dead-man's switch keeps firing so a Postgres outage remains distinguishable from a Redis outage or a dead worker.
- **HALF_OPEN (probing).** After the 60 s window the breaker admits a **single probe write** — a dedicated synthetic insert, never a replay of a failed real write (Phase 1 research, Open Question 3 resolution), using the key prefix reserved for this purpose in §11's `write_guards` definition:

  ```sql
  INSERT INTO write_guards(key) VALUES ('breaker:probe:{ts}') ON CONFLICT DO NOTHING;
  ```

  The `breaker:probe:` prefix makes probe traffic identifiable in logs and guarantees the probe can never double-apply real data (it inserts only a guard row, which normal write_guards retention prunes).
  - Probe **succeeds** (Postgres accepted the write) → **CLOSED**: `Queue.resume()`, failure counter reset to 0, the next tick claims normally via §14.3.
  - Probe **fails** → **re-OPEN** for another 60 s. The probe repeats each OPEN window — probe interval follows the OPEN duration; no separate timer exists to configure or drift.

The breaker's counter and state live in the worker process (module scope; single worker at current scale). A worker restart resets it to CLOSED — safe, because the first infra-failure re-arms it within one tick (the Redis-restart interaction is row 5 of the §13.9 breaker table).

### 13.4 Backlog cap — the J-5 asymmetry (RES-02)

Routine checks are **droppable**; transitions are **not**:

- When `monitor-checks` depth (`wait` + `active` + `delayed`, read via `getJobCounts` in §14.2 step 4) exceeds **~2x the active-monitor count**, the tick skips every routine (priority-10) enqueue — the gate step specified in §14.2. Claims stay advanced, so a skipped check self-heals at the monitor's next due slot; the accepted consequence is one missed routine sample for an UP monitor.
- Transition **writes** are never droppable by construction: they execute synchronously inside check jobs (§16.1), never as separately enqueued scheduler work. Priority-1 enqueues (manual lane + non-UP lane) are never gated. This asymmetry is the J-5 requirement: routine backlog may be shed; downtime evidence may not.

### 13.5 Dead-letter policy (D-14 / WRK-06)

- **Bounded attempts 3–5** per lane with exponential backoff — per-lane values pinned in §14.1 (checks 3, db-writes 5, alerts 3, email 5). Attempts exhausted ⇒ the job dead-letters into BullMQ's `failed` set.
- **DLQ retention: `removeOnFail: { age: 604800 }` — at least ~7 days, best-effort.** BullMQ's KeepJobs eviction has no background timer: aged failed jobs are removed only when another job fails afterwards (verified from BullMQ source — Phase 1 research, Pitfall 5). Dashboards and the runbook must treat 7 days as a lower-bound approximation, never a deterministic eviction SLA.
- **Permanent business failures throw `UnrecoverableError`** — the BullMQ 6 pattern; the `Job#discard()` method was removed in v6. An invalid Telegram chat target or a hard-rejected email address dead-letters immediately instead of burning attempts. Retryable-vs-permanent classification per lane: §14.1 (alerts) and §17 (email).
- Dead-lettered jobs detect nothing on their own — outbox-age alerting (OBS-03) and queue-depth/job-age observability (§15) are the detection path.

### 13.6 Redis-restart recovery procedure (RES-05)

1. **Schedulers re-declare themselves.** Worker (re)boot upserts every Job Scheduler via `upsertJobScheduler` (§14.2 step 1) — idempotent, so concurrent boots and post-restart re-declarations converge on exactly one active scheduler per id. No manual scheduler cleanup ever exists.
2. **Stale locks expire via TTL.** Per-monitor locks (`lock:check:{monitorId}`, ≤ 15 s once renewal stops) and the scheduler leader lock (~30 s) simply age out — no cleanup job, no operator action. A lock held by a dead worker cannot delay the next check beyond its TTL.
3. **In-flight jobs recover as stalled.** Jobs executing at restart time are re-run per the stalled config pinned in §14.1 (`stalledInterval` 30000 ms, `maxStalledCount` 1) — at-least-once, absorbed by the §16 idempotent writers.
4. **No check storm.** The next tick re-claims monitors via the claim transaction on `next_check_at` (§14.3): claims already advanced at selection time (J-1), so each monitor is re-claimed exactly at its next due slot — never en masse.
5. **Breaker state is in-process only.** If Postgres was the outage that opened the breaker, the boot-time `readyz` DB ping (§15) fails and the first persist failures re-open the breaker within one tick — the pause never depends on Redis state surviving the restart.

### 13.7 Retention deletes (D-7 / DAT-08 / WRK-13)

Retention deletes (pings > 30 d, RESOLVED incidents > 90 d, `write_guards` > 7 d) run **only** in the `maintenance` queue — never inside a check tick, never in a request handler:

```sql
-- Loop until a pass deletes fewer than the batch size (batch pinned 5000 in §11):
DELETE FROM pings
 WHERE id IN (SELECT id FROM pings WHERE created_at < $cutoff LIMIT 5000);
```

Looped batched deletes bound row locks, bloat, and replication lag on Neon (D-7). **Dry-run mode is mandatory** (WRK-13): invoked with the dry-run flag, the maintenance job reports the row counts it *would* delete, without deleting.

### 13.8 Redis client configuration and hardening (RDS-01 / RDS-03)

- **Two connections per worker process** (ioredis 6, installed explicitly — BullMQ 6 makes it an optional peer): one **blocking connection** for Workers and one **queue connection** for producers (Queue / Job Scheduler operations); blocking operations must not share a connection with command traffic.
- **Web-process Redis budget (OBS-05 / IN-05):** the web process holds **2 Redis connections** — one queue-producer connection for enqueues (manual-check `Queue` adds, §14.1 manual lane) and one limiter/cache client (`rl:*` / `cache:*` keys) — counted separately from the worker's two connections above; Redis total across both processes is therefore 4 steady-state.
- **`maxRetriesPerRequest: null` on the worker-side connections** — required for blocking connections; wrong values cause crashes/retry loops.
- **No `keyPrefix`** — BullMQ manages its own `bull:` prefix; an ioredis `keyPrefix` would corrupt BullMQ key access.
- **Hardening (RDS-03):** AOF with `appendfsync everysec` (queue durability across restarts); `maxmemory-policy noeviction` so BullMQ keys are never evicted; supervised auto-restart (PM2/systemd); memory alerting at 70 % — early warning before `noeviction` starts rejecting writes.
- One Redis instance suffices at current scale (Q-3: self-hosted on the VPS + the external heartbeat above).

### 13.9 Failure-mode tables (D-07)

**Breaker transitions:**

| Failure | Detection | Response | Recovery |
|---|---|---|---|
| Postgres outage (5th consecutive infra-failure) | breaker counter reaches threshold | OPEN: enqueueing stops (§14.2 steps 3–4), `Queue.pause()` on `monitor-checks`/`db-writes`; heartbeat keeps firing; in-flight jobs finish bounded attempts | 60 s → HALF_OPEN probe → CLOSED on probe success |
| Probe write fails (Postgres still down) | `breaker:probe:` insert errors in HALF_OPEN | re-OPEN for another 60 s; log carries the probe key for traceability | probe repeats each OPEN window until one lands |
| Probe write succeeds | HALF_OPEN insert commits | CLOSED: `Queue.resume()`, failure counter reset | next tick claims normally via §14.3; skipped checks self-heal at their due slots |
| Target failures during the outage window (checked websites also down) | §15.1 step 5 classification — DOWN/timeout/DNS/TLS are successful jobs | never counted by the breaker; only infra-failures increment it | none needed — the classification is the guard |
| Redis restarts while the breaker is OPEN | boot-time `readyz` Redis ping; BullMQ's paused-queue flag may not survive the restart | in-process breaker re-applies `Queue.pause()` if still OPEN; if pause state was lost, the first persist failures re-open the breaker within one tick (≤ 5 failures execute and fail) | procedure §13.6 runs in parallel |

**Redis restart:**

| Failure | Detection | Response | Recovery |
|---|---|---|---|
| Redis process dies / restarts | worker Redis clients error; `readyz` Redis ping fails | monitoring pauses by design (§13.2); heartbeat keeps firing → healthchecks.io gap pages the operator | schedulers re-upserted at boot (§13.6 step 1); AOF `everysec` minimizes queue loss |
| Stale per-monitor lock outlives its worker | next check's `SET NX` fails (§15.1 step 2) | the job completes successfully without executing — a performance miss only | lock ages out via TTL ≤ 15 s; the next due slot executes normally |
| In-flight jobs lost at restart | BullMQ stall detection (`stalledInterval` 30000, `maxStalledCount` 1) | jobs re-run at-least-once | §16 write guards + conditional UPDATE make re-runs no-ops (TC-DUP-INCIDENT-01, TC-FLUSH-GUARD-01) |
| Scheduler duplicated after restart | two ticks running concurrently | claim transaction excludes double-claims (§14.3); the leader lock is defense-in-depth | upsert convergence yields one active scheduler per id (§14.2 step 1) |

### 13.10 Parameter pinning (D-10)

| Parameter | Default | Rationale | Class |
|---|---|---|---|
| Breaker threshold | 5 consecutive infra-failures | D-11 shape — high enough to ride through transient blips, low enough to trip before backlog compounds | default — tune in Phase 4/5 with data |
| OPEN duration | 60 s | bounds probe pressure on a recovering Postgres while keeping pause windows short | default — tune in Phase 4/5 with data |
| Probe write | single `write_guards` insert, key `breaker:probe:{ts}` | synthetic write — identifiable in logs, never double-applies real data (§11 key-format reservation) | non-negotiable (shape) |
| Probe interval | follows the OPEN duration (one probe per OPEN window) | no separate timer to configure or drift | default |
| DLQ retention | `removeOnFail { age: 604800 }` — ≥ ~7 days best-effort | D-14; BullMQ eviction is lazy (no background timer, §13.5) | pinned (best-effort wording) |
| Backlog-cap multiplier | ~2x active-monitor count | J-5/RES-02 — routine checks droppable above it; matches §14.5's pin | default — tune in Phase 4/5 with data |
| Redis memory alert threshold | 70 % of `maxmemory` | early warning before `noeviction` rejects writes | default |


---

## 14. Proposed BullMQ architecture

*Amended 2026-09-09 (resolves J-1, J-5, J-6; §9 items 1, 5, 6)*
*Amended 2026-09-09, fix cycle (resolves CR-01, CR-02, IN-02, IN-04, OBS-01; absent-jobs paragraph + flush-lane cell aligned to the §16.2 staging-key flush)*
*Amended 2026-09-09, fix cycle (resolves WR-02, WR-07; manual-lane claim-semantics paragraph added, priority paragraph carries the Phase 4 verification marker + standalone explicit-priority invariant)*
*Amended 2026-09-13 (resolves D-50: §14.3 claim advance made catch-up-safe via the GREATEST form; §14.1 manual-lane jobId reshaped to `check-manual:{monitorId}:{epochMs}` — BullMQ 6's Job.validateOptions rejects colon-containing custom jobIds that do not split into exactly three segments, so the four-segment manual form throws "Custom Id cannot contain :"; uniqueness-per-enqueue contract unchanged, admission remains the D-13 limiter's job)*

All recurring work is produced by **BullMQ 6 Job Schedulers**: every scheduler is created or updated idempotently at worker boot via `upsertJobScheduler(schedulerId, { every | pattern }, { name, data, opts })` — the v6 primitive that replaced the legacy recurring-job option (removed in v6). No other recurring-job mechanism exists in this design. Single Redis, prefix `bull`.

### 14.1 Queue topology (D-12)

| Queue / lane | Producer | Consumer / worker | Concurrency | Priority | Rate limit | removeOnComplete | removeOnFail | Stalled config |
|---|---|---|---|---|---|---|---|---|
| `monitor-scheduler` — `tick` | Job Scheduler `scheduler-tick` (worker boot, every 30 s) | scheduler worker | 1 — one tick at a time | **1** — cadence-critical; explicit on every lane | none — cadence bounded by the 30 s scheduler period | `{ age: 300, count: 100 }` | `{ age: 604800 }` | defaults: `stalledInterval` 30000, `maxStalledCount` 1 (verify against Phase 4 BullMQ 6 research) |
| `monitor-checks` — `check { monitorId }` (manual lane) | API routes: manual check (Q-5 enqueue-and-poll), monitor-create first check | check pool (§15) | 10 — check pool baseline | **1** (J-6) | per-user at the API: 1 per monitor / 30 s, 6 per minute / user (D-13); no queue-level limiter | `{ age: 3600, count: 5000 }` | `{ age: 604800 }` (D-14, best-effort) | `lockDuration` 30000, `stalledInterval` 30000, `maxStalledCount` 1 + graceful shutdown (J-3; verify against Phase 4 BullMQ 6 research) |
| `monitor-checks` — `check { monitorId }` (non-UP lane) | scheduler tick step 3 (§14.2) | check pool (§15) | shared 10 | **1** (J-6) | none — bounded by claim LIMIT 500 / tick | shared | shared | shared |
| `monitor-checks` — `check { monitorId }` (routine lane) | scheduler tick steps 3–4 (§14.2) | check pool (§15) | shared 10 | **10** (J-6; droppable under the backlog gate) | none — volume bounded by claim LIMIT 500 / tick | shared | shared | shared |
| `db-writes` — `relay-pass` | Job Scheduler `outbox-relay` (every 5 s) | writer pool | 5 | **1** — DOWN-alert delivery depends on it (D-2) | none — bounded by relay batch 100 (§16.3) | `{ age: 3600, count: 5000 }` | `{ age: 604800 }` | defaults (verify against Phase 4 BullMQ 6 research) |
| `db-writes` — `flush-monitor-aggregate { monitorId, batchId }` | Job Scheduler `flush-pass` (every 30 s — purely time-based; no buffer threshold exists: §16 invariant 4 bounds the buffer by the 60 s window) | writer pool | shared 5 | **10** — routine Tier 2 persistence (counter deltas + per-check evidence rows); guarded and loss-tolerable (§16.2) | none — bounded by the buffer window | shared | shared | shared |
| `alerts` — `send-alert { incidentId, eventType, channels[] }` | outbox relay (§16.3) — never the check handler directly (D-2) | notifier pool | 5 — separate from checks so slow Telegram/SMTP never stalls check lanes | **1** — transition-adjacent, never droppable | none at queue level; ≤ 3 attempts (D-4), channel-level throttling in the processor | `{ age: 3600, count: 1000 }` | `{ age: 604800 }` (D-14, best-effort) | defaults (verify against Phase 4 BullMQ 6 research) |
| `maintenance` — `cleanup`, `ping-rollup` | Job Schedulers (`cleanup` daily off-peak; `ping-rollup` optional hourly) + admin API trigger | maintenance worker | 1 — batched retention deletes never parallelize (D-7) | **5** | none — scheduled off-peak | `{ age: 86400 }` | `{ age: 604800 }` | defaults (verify against Phase 4 BullMQ 6 research) |
| `email-transactional` — `send-email { to, template, params }` | API routes (register, forgot-password); Better Auth hooks (Phase 7, §17) | notifier pool | 5 | **5** — user-facing, never monitoring-critical | none at queue level; provider 429/5xx map to retryable typed errors (§17) | `{ age: 86400, count: 1000 }` | `{ age: 604800 }` | defaults (verify against Phase 4 BullMQ 6 research) |

Per-lane attempts/backoff:

- `monitor-checks`: `attempts: 3`, exponential backoff from 5 s — a throw is an infrastructure failure only (J-4; §15.1 step 5).
- `db-writes` (both lanes): `attempts: 5`, exponential from 5 s — retries make rule 14 real; guarded writes are idempotent (J-2).
- `alerts`: `attempts: 3`, exponential from 10 s (the D-4 attempt bound); a permanent send failure (invalid chat target, hard-rejected address) throws `UnrecoverableError` so hopeless sends dead-letter instead of retrying — the BullMQ 6 pattern, not a discard call.
- `email-transactional`: `attempts: 5`, exponential from 10 s (§17).
- `tick`: `attempts: 1` — the next 30 s period supersedes any retry. `relay-pass`: `attempts: 5` — idempotent by §16.3.

**Why every lane carries an explicit priority.** BullMQ's default priority value 0 means *no explicit priority*, and jobs without an explicit priority are processed **before** jobs that have one (verified against BullMQ source in the Phase 1 research; lower numbers run first among prioritized jobs — verify against Phase 4 BullMQ 6 research with a live dequeue-order check: enqueue one prioritized and one unprioritized job, assert the order). Any unprioritized lane would therefore queue-jump every prioritized lane — an unprioritized routine-check lane would outrank manual and transition-candidate checks, inverting J-6. **Invariant (WR-07, independent of the default-behavior claim): every lane MUST set an explicit priority; cross-lane ordering relies on numeric priority among explicit values only** — the design's ordering never depends on how BullMQ treats unprioritized jobs, because no lane in this design is unprioritized. Reference assignment: manual/transition 1, maintenance 5, routine 10 — refined above with rationale (cadence- and transition-critical lanes 1, user-facing non-monitoring 5, routine droppable 10); priority orders jobs **within** a queue only, so cross-queue values never compete.

**J-6 lane assignment and worst-case latency bound.** Manual checks (API "check now") and checks for monitors currently in a non-UP state run at priority 1; routine checks for UP monitors run at priority 10. A priority-1 job queues only behind other priority-1 jobs, so its worst-case dequeue latency is `(priority-1 depth x per-job time) / concurrency = (priority-1 depth x 10 s) / 10`. Priority-1 depth is bounded by the non-UP monitor count M plus manual admissions (≤ 6 / min / user, D-13): with M = 100 during a broad incident the worst case is ~100 s, and the J-5 backlog gate (§14.2 step 4) plus priority-10 droppability keep routine backlog from ever sitting ahead of priority-1 work. Monitors in a non-UP state get priority 1 because their next check can carry the RECOVERED transition — the case J-6 exists for (recovery alerts arriving minutes late during incidents, when backlog is largest).

**Manual-lane claim semantics (WR-02).** A manual check **advances `next_check_at` by one interval at enqueue time**, executed by the API route *before* the enqueue via the same atomic UPDATE shape as §14.3's claim: `UPDATE monitors SET next_check_at = now() + (interval * interval '1 minute') WHERE id = $mid AND is_active RETURNING next_check_at` — both claim paths (scheduled and manual) therefore share semantics. Rationale (D-10): the check happened, so the next due slot must move — matching the user-visible meaning of "check now" and eliminating the deterministic double-sample in which a manual check at 10:04:50 is followed by the scheduled claim at 10:05 executing a second check inside the same interval window. The manual-lane jobId is **not** the claim-epoch key: it is unique per enqueue, so a user's second manual check minutes later is never silently deduped by BullMQ — admission is governed by the D-13 limiter (§12.4), not the jobId. *(Amended 2026-09-13: the originally specified four-segment form `check:{monitorId}:manual:{epochMs-of-enqueue}` is rejected by BullMQ 6 — `Job.validateOptions` throws "Custom Id cannot contain :" for any colon-containing custom jobId that does not split into exactly three segments, a legacy repeatable-job compatibility constraint. The stored form is `check-manual:{monitorId}:{epochMs}` with a strictly monotonic per-process epoch token, preserving the uniqueness-per-enqueue contract verbatim.)* Both key forms are mirrored in §13.1's idempotency row with the same `removeOnComplete` horizon.

**Deliberately absent jobs:** `recompute-uptime` (D-6 / §16.5 — lifetime counters are authoritative; the job has no algorithm and no purpose in v1). No separately scheduled bulk ping-row writer exists either — routine ping-row persistence rides the `flush-monitor-aggregate` job itself: the §16.2 multi-row `INSERT INTO pings` executes inside that job's guarded flush transaction.

### 14.2 Scheduler tick algorithm (D-07)

1. **Tick idempotency.** The `tick` job is produced exclusively by the Job Scheduler `scheduler-tick`, declared at worker boot: `upsertJobScheduler('scheduler-tick', { every: 30_000 }, { name: 'tick' })`. The upsert is idempotent — concurrent worker boots and post-restart re-declarations converge on exactly one active scheduler, and at most one delayed `tick` job exists per scheduler id, so N worker processes never multiply tick volume. The §13 `lock:scheduler` leader lock is retained as defense-in-depth against overlapping ticks after Redis restarts; correctness never depends on it — step 2 is the guard.
2. **Claim.** Execute the claim transaction (§14.3) in a single round trip; it returns the claimed `(id, status, next_check_at)` rows (batch ≤ 500). Only claimed monitors are enqueued — the claim advances `next_check_at` inside the same transaction that selects the row (J-1), so a concurrent or delayed second tick cannot claim the same row (§14.3 notes).
3. **Enqueue one check job per claimed id** on `monitor-checks`, with `jobId` set to the idempotency key `check:{monitorId}:{epoch}`, where `{epoch}` is the epoch (ms) of the monitor's just-advanced `next_check_at` as returned by the claim. The claim-epoch key is unique per monitor per schedule slot **and** per tick — it replaces the enqueue-timestamp token the review rejected as a retry-dedup that never deduplicated cross-tick. A duplicate add with an existing `jobId` is ignored by BullMQ; if a duplicate nonetheless executes (at-least-once delivery), §15.1's execution-time re-read and the §16 guards make it idempotent. Lane assignment (J-6): `status <> 'UP'` → priority 1 (the check can carry a RECOVERED transition); `status = 'UP'` → priority 10 (routine).
4. **Backlog gate (J-5).** Before enqueuing routine (priority-10) checks, read the `monitor-checks` depth (`getJobCounts('wait', 'active', 'delayed')`); if it exceeds ~2x the active-monitor count, skip every routine enqueue this tick. Claims stay advanced, so a skipped check self-heals at the monitor's next due slot — the accepted consequence is one missed routine sample for an UP monitor (bounded and visible in queue metrics). Priority-1 enqueues (non-UP lane) are never gated; manual-lane jobs enter via the API regardless. Transition **writes** are not droppable by construction — they execute synchronously inside check jobs (§16.1), never as separately enqueued scheduler work — so the gate only ever drops routine *check enqueues*.
5. **Heartbeat.** On tick completion, ping healthchecks.io (`HC_PING_URL`); on any exception caught in steps 2–4, ping `HC_PING_URL/fail` before surfacing the error. The heartbeat is the only independent detection of a monitoring pause (R-1) — it must fire even when the failure is Redis itself.
6. **Failed-enqueue compensation.** If an enqueue throws mid-batch (Redis down after the claim committed), leave the claims advanced: the J-1-accepted consequence is one missed check per un-enqueued monitor, and the next tick re-claims each monitor when its advanced `next_check_at` comes due — no rollback path, no repair job. Log claimed-vs-enqueued counts per tick; a persistent mismatch surfaces through queue-depth observability (§15) and the §13 circuit breaker (J-5).

### 14.3 Claim transaction (J-1 — literal SQL)

```sql
-- Source: postgresql.org/docs/current/sql-select.html (locking-clause semantics)
WITH due AS (
  SELECT id FROM monitors
   WHERE is_active AND (next_check_at IS NULL OR next_check_at <= now())
   ORDER BY next_check_at NULLS FIRST
   LIMIT 500
   FOR UPDATE SKIP LOCKED          -- MUST remain inside the WITH query: per
)                                  -- postgresql.org/docs/current/sql-select.html,
                                   -- outer-level locking clauses do not reach
                                   -- into WITH queries — moving FOR UPDATE
                                   -- outside the CTE locks nothing from "due"
                                   -- and re-opens the J-1 duplicate-claim race
UPDATE monitors m
   SET next_check_at = GREATEST(   -- catch-up-safe advance (D-50, amended
        now() + (m.interval * interval '1 minute'),          -- 2026-09-13): a
        m.next_check_at + (m.interval * interval '1 minute') -- stale monitor
       )                                                     -- reaches now+n
  FROM due
 WHERE m.id = due.id
RETURNING m.id, m.status, m.next_check_at;
```

Notes:

- **Catch-up-safe advance (amended 2026-09-13, resolves D-50).** The original form advanced `next_check_at` by exactly one interval (`now() + interval`). Research verdict (04-RESEARCH Pattern 2): the naive one-interval advance **starves stale monitors** — a monitor 40 minutes behind at interval 5 needs 8 ticks to catch up, and dark launch (every user monitor served only by cron, `next_check_at` never touched) makes that staleness the norm, draining the scheduler exactly when it must drain fastest. The amended `GREATEST(now() + interval, next_check_at + interval)` advances a far-behind monitor to `now + interval` in ONE claim while an on-time monitor keeps its exact slot (monotonicity preserved — the GREATEST never moves a due slot backwards). This composes with D-49's cutover re-seed: either mechanism alone keeps the scheduler correct; both together are belt-and-suspenders.
- **Locking-clause placement is load-bearing.** `FOR UPDATE SKIP LOCKED` stays inside the `WITH` query because outer-level locking clauses do not reach into WITH queries (postgresql.org/docs/current/sql-select.html). This is the exact trap Pitfall 4 of the phase research names: a refactoring that "cleans up" the clause to the outer statement silently breaks claim exclusivity.
- **Two concurrent ticks cannot claim the same row.** The first transaction's row locks are taken inside the CTE, so the second transaction's `SKIP LOCKED` skips those rows rather than waiting; after the first commits, the advanced `next_check_at` excludes them from the WHERE clause anyway. Defense in depth, not a single guard.
- **LIMIT interplay.** "If a `LIMIT` is used, locking stops once enough rows have been returned to satisfy the limit" (postgresql.org/docs/current/sql-select.html) — the scan stops at 500 claimable rows and contended rows are skipped, not waited on.
- **READ COMMITTED ordering caution.** Under READ COMMITTED, `ORDER BY` is applied before row locking, so rows can be returned out of request order. For claims, oldest-due-first ordering is a fairness preference, not a correctness requirement — any claimed subset is safe.
- **Index alignment.** The WHERE clause filters on `is_active` and `next_check_at` exactly as §11's `idx_monitors_due` predicate defines them (`(is_active, next_check_at) WHERE is_active`) — the claim is the index's designed consumer.
- **RETURNING extension (documented deviation from the research baseline, which returned `m.id` only):** `m.status` rides the claim so step 3 assigns the J-6 lane without a second query, and `m.next_check_at` rides it so the jobId epoch is the server-computed claim value. The WHERE clause is unchanged from the verified baseline.

### 14.4 Tick failure modes (D-07)

| Failure | Detection | Response | Recovery |
|---|---|---|---|
| Redis down mid-batch (enqueue throws after claims committed) | enqueue reject/timeout in step 3 | stop enqueuing; ping `HC_PING_URL/fail`; leave claims advanced (one missed check per un-enqueued monitor — the accepted J-1 consequence) | next tick re-claims each monitor when due; monitoring pause is visible as a heartbeat gap (R-1) |
| Claim transaction failure (Postgres unreachable / statement error) | error from §14.3 in step 2 | abort the tick; ping `HC_PING_URL/fail`; no claims written — the transaction is atomic, no partial claim survives | next tick retries; the §13 circuit breaker (J-5) governs sustained-outage pause/resume |
| Heartbeat failure (healthchecks.io unreachable) | fetch to `HC_PING_URL` rejects | log and continue — heartbeat errors must never fail the tick or the checks it schedules; healthchecks.io's own dead-man switch covers sustained loss | operator paged only on a sustained gap; a transient heartbeat loss is a monitoring-of-monitoring event, not a monitoring event |
| Backlog threshold exceeded (depth > ~2x active monitors) | `getJobCounts` in step 4, before routine enqueues | skip all routine enqueues this tick (J-5); non-UP lane still enqueued at priority 1 | backlog drains through the priority lanes; skipped checks self-heal next interval; sustained backlog surfaces via Redis memory alerting at 70% (§13) |

### 14.5 Scheduler parameter pinning (D-10)

| Parameter | Default | Rationale | Class |
|---|---|---|---|
| Tick period | 30 s | ≤ 1/2 the minimum supported interval (1 minute) per J-1 — a missed tick never causes a check to be skipped at its due slot | non-negotiable |
| Claim batch LIMIT | 500 rows per tick | bounds the tick's enqueue burst and lock footprint; comfortably above the plausible due-count at current scale | default — tune in Phase 4/5 with data |
| Backlog-cap multiplier | ~2x active-monitor count | J-5: routine checks are droppable once depth exceeds ~2x active — the next tick re-checks anyway; skipped checks self-heal | default — tune in Phase 4/5 with data |
| Relay-pass cadence | 5 s | bounds DOWN-alert lag from Tier 1 commit to alert enqueue; 100-row batches keep each pass short (§16.3) | default — tune in Phase 4/5 with data |
| Flush-pass cadence | 30 s | keeps Tier 2 flush lag ≤ 60 s (rule 9 / §16 Tier 2) with margin for job latency | default — tune in Phase 4/5 with data |

Transition and aggregation persistence semantics are owned by §16 (Tier 1 / Tier 2); queue-consumer runtime, the check algorithm, and the lock lifecycle are owned by §15 — §14 does not restate them. FlowProducer (`check` → children `db-writes`/`alerts`) remains optional later; plain chains suffice initially. Bull Board behind an admin gate remains the queue-observability plan (S-3).

---

## 15. Proposed Worker Architecture

*Amended 2026-09-09 (resolves J-3, J-4, S-1; §9 items 3, 4, 18)*
*Amended 2026-09-09, fix cycle (resolves RR-01, RR-02, WR-01, WR-08; §15.4 worker-host egress layer added, §15.1 denylist extended with canonicalization, maintenance-lane file-tree comment corrected, lock-renewal lifetime pinned)*

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
    maintenance.ts    # cleanup (looped retention deletes, §13.7), ping-rollup, write_guards pruning
  health.ts           # :9090/healthz (process up) + /readyz (Redis+DB ping)
```

- **Runtime:** PM2 app #2 in `ecosystem.config.js` (`name: "uptime-worker", script: "worker/dist/index.js"`), or systemd unit; **never** runs inside `next start` (rules 4–6). `instrumentation.ts` cron code is deleted at cutover.
- **Concurrency:** check workers sized to `concurrency × 10s timeout` budget (start: concurrency 10); alert/persist workers separate concurrency so slow Telegram/SMTP calls never stall checks (fixes R9 partially — alert enqueue stays inline-fast, dispatch is queued).
- **Ownership of all monitoring logic:** the check engine module moves to a shared location importable by the worker only; API routes never execute checks — they enqueue (`monitors/[id]/check` becomes a fast 202-style enqueue + read-after-write from Postgres).
- **Deployment coupling:** web and worker deploy together from one build (shared TypeScript), versioned by the same git SHA; schema migrations run before worker restart (§22).
- **Observability:** healthchecks.io heartbeat moves to the worker's scheduler tick; BullMQ event listeners export job counts; structured logs with `monitorId` correlation.
- **Scale-out path:** N workers are safe by construction — scheduler leader lock, per-monitor locks, idempotency keys, and SQL-side due-selection make duplicate execution impossible rather than merely unlikely.

### 15.1 Check job algorithm (D-07)

The `check` job's id **is** the §14 idempotency key (`check:{monitorId}:{epoch}`): a redelivered job carries the same id and BullMQ ignores duplicate adds; the steps below make any executed duplicate a no-op regardless (at-least-once delivery, J-2).

1. **Re-read the monitor row at execution time** (`SELECT id, url, interval, status, is_active FROM monitors WHERE id = $mid`). Configuration may have changed since the claim (J-1, "also required"): if the row is gone (monitor deleted while claimed/queued) or `is_active = false`, complete the job successfully as a no-op — nothing to check, nothing to write.
2. **Acquire the per-monitor lock** `lock:check:{monitorId}` via `SET NX PX` — value `{workerId}:{jobId}`, TTL 15000 ms (**TTL = fetch timeout 10 s + margin 5 s**; the formula is non-negotiable, WRK-04/J-3). If `NX` fails, another executor owns the monitor: complete the job successfully without executing. The lock is a performance guard against duplicate concurrent work, never a correctness mechanism — correctness rests on the J-1 claim, the J-2 write guards, and the D-1 conditional transition (see §13's lock row for the key's place in the Redis architecture; the lifecycle contract is specified here).
3. **Arm renewal every TTL/3 (5 s)** — a compare-and-expire by owner (Lua: extend the TTL only if the stored value equals ours). The renewal timer runs for the **entire job lifetime** — fetch, classification, and Tier 1 persistence (§16.1, which may legitimately take up to the 30 s `statement_timeout`, §25.2) — it does **not** stop when the fetch returns; the lock is released only in the step-7 `finally` (WR-08). Without renewal-through-persist, a legitimately slow transition transaction would outlive the 15 s TTL mid-persist and hand ownership to the next claimant while the original executor is still inside its transaction. If renewal fails — key missing, value mismatch, or Redis error — the lock may be lost: **abort immediately**: stop writing, discard the classified result, log `lock_lost`, and complete the job without persisting. Never race a possible new owner.
4. **Fetch through the SSRF pipeline** (S-1 / SEC-01 — ordered sub-steps, all inside the strict 10 s budget):
   1. **Scheme allowlist:** parse the URL; accept `http`/`https` only. Any other scheme is rejected **before any network I/O** → result DOWN with `error_class = 'ssrf_blocked'` (defense in depth — create-time validation should have rejected such a URL earlier; the engine does not trust it).
   2. **Resolve-then-validate, with canonicalization:** resolve the host to **all** of its A/AAAA records and validate **every** resolved IP (IPv4 and IPv6) against the private-range denylist (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, `64:ff9b::/96`). Each address is canonicalized **before** comparison: an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, in `::ffff:0:0/96`) is canonicalized to its embedded IPv4 form and checked against the IPv4 denylist **as that address** (`::ffff:10.0.0.1` → `10.0.0.1` → denied by `10/8`) — the raw mapped literal matches none of the legacy IPv6 ranges and would sail through an uncanonicalized comparison (WR-01). The unspecified range `0.0.0.0/8` is denied because many stacks connect it to localhost; `64:ff9b::/96` is the NAT64 range whose embedded IPv4 side is likewise canonicalized before comparison. This denylist is mirrored verbatim at the OS layer by §15.4 (S-1 layer 1) — extend both statements together, never one alone. Any denylisted IP → result DOWN with `error_class = 'ssrf_blocked'`; no connection is attempted.
   3. **Connection-time re-validation (DNS-rebinding countermeasure):** the dialer connects only to an address from the resolve-time validated set — it never re-resolves. If the peer address at connect time is not in the validated set, abort the connection → result DOWN with `error_class = 'ssrf_blocked'`.
   4. **Redirect re-validation:** follow redirects manually; every hop re-runs sub-steps 1–3 on the new URL (scheme check, resolve-then-validate), up to a cap of **5 hops**. A hop to a private address, a disallowed scheme, or exceeding the cap → result DOWN with `error_class = 'ssrf_blocked'`; no request reaches the private address.
   5. **Response cap:** read at most **2 MB** of body; abort the read at the cap and record the check from the response status plus the capped body (keyword checks operate on that prefix). The whole exchange — DNS, connect, redirects, capped body read — must fit inside the 10 s timeout.
5. **Classify (J-4 / WRK-05).** Target outcomes — **UP, DOWN, timeout, DNS failure, TLS failure** — are **successful jobs** carrying a typed result `{ status, error_class?, response_time, status_code }` with `error_class ∈ { timeout, dns, tls, ssrf_blocked, http_5xx, network }` (the §11 `pings.error_class` vocabulary). A blocked SSRF attempt is a successful job carrying result DOWN with `error_class = 'ssrf_blocked'`. **Only infrastructure failures throw** — Postgres unreachable, Redis unavailable, internal exceptions/bugs — and only those retry per the queue's attempts/backoff (§14.1). A target timeout is never retried; redelivery after a worker crash is absorbed by the idempotent writers, not by classifying target outcomes as failures.
6. **Persist — dispatch by tier (§16 owns the SQL; §15 does not restate it):** if the classified result changes `monitors.status` (DOWN, RECOVERED, or the first check), run the **Tier 1 transition transaction synchronously inside the job** (§16.1). If the result matches the current status (routine UP, unchanged DOWN), apply the **Tier 2 buffer path** — Redis `HINCRBY`/`HSET` counter deltas **plus one `RPUSH` evidence row onto `pings:pending:{monitorId}`** (per-check evidence is carried, not discarded — CR-01), flushed by §16.2 within 60 s. Never route a transition through the buffer; never write `status` from Tier 2.
7. **Release the lock in a `finally`** — owner-only, via Lua compare-and-delete (`GET` equals our value → `DEL`); a lock you no longer own is never deleted.

**BullMQ stall hygiene (J-3):** worker `lockDuration` 30000 ms, `stalledInterval` 30000 ms, `maxStalledCount` 1 (source defaults, pinned in §14.1 — verify against Phase 4 BullMQ 6 research); graceful shutdown via `worker.close()` on SIGINT/SIGTERM with PM2 `kill_timeout ≥ 20 s`, so deploys drain in-flight checks instead of manufacturing stalled jobs.

### 15.2 Check failure modes (D-07)

| Failure | Detection | Response | Recovery |
|---|---|---|---|
| Lock lost mid-check (TTL expired under a slow target) | step-3 renewal returns 0 / value mismatch | abort: stop writing, discard the classified result, log `lock_lost`, complete the job without persisting | the new owner's execution is the recorded one; correctness never depended on the lock (J-1/J-2/D-1) |
| Renewal failure (Redis briefly unavailable) | renewal command errors or times out | same abort path — never race a possibly-new owner | the lock expires via TTL if genuinely lost; the next scheduled check is unaffected |
| Redirect to a private IP | per-hop validation, step 4 sub-step 4 | result DOWN `error_class = 'ssrf_blocked'`; the request to the private address is never issued | none needed — recorded as a normal classified DOWN check |
| Oversized body (> 2 MB) | byte counter hits the cap mid-read, step 4 sub-step 5 | abort the body read at the cap; record the completed check (headers + capped prefix) | none — this is a target outcome, not an infra retry |
| Target timeout (> 10 s) | fetch timer fires | result DOWN `error_class = 'timeout'`; the job **succeeds** — a target timeout is never retried | the next scheduled check re-evaluates the target |
| DNS resolution failure (NXDOMAIN / SERVFAIL) | resolver error in step 4 sub-step 2 | result DOWN `error_class = 'dns'`; job succeeds, no retry | the next scheduled check re-evaluates |
| Postgres down at persist time (after a successful fetch) | Tier 1 transaction error, step 6 | the job **throws** (infrastructure failure) → BullMQ retry with bounded attempts (3) and exponential backoff; Tier 1 atomicity means no partial write survives | on retry the D-1 conditional UPDATE gates re-application; attempts exhausted → dead-letter with ≥ ~7 d best-effort retention (D-14) |

### 15.3 Check-job parameter pinning (D-10)

| Parameter | Default | Rationale | Class |
|---|---|---|---|
| Fetch timeout | 10 s | strict per-check budget covering DNS, connect, redirects, and the capped body read (S-1.3); unchanged from current behavior | non-negotiable |
| Redirect hop cap | 5 | S-1: bounds redirect chains; every hop is re-validated anyway | non-negotiable |
| Response body cap | 2 MB | S-1.3: memory-exhaustion / archive-bomb bound; keyword checks use the capped prefix | non-negotiable |
| Lock TTL | 15 s = 10 s timeout + 5 s margin | **TTL = timeout + margin** (WRK-04 formula — non-negotiable); the 5 s margin absorbs scheduler jitter and the acquire-to-fetch window — renewal (every TTL/3) then spans the **entire job lifetime** including classification and Tier 1 persistence (§16.1, legitimately up to the 30 s `statement_timeout`), so a slow persist never outlives the lock; release happens only in the step-7 `finally` (WR-08) | non-negotiable formula; 5 s margin is the default value |
| Lock renewal interval | TTL/3 (5 s) | three renewal windows per TTL — a single missed renewal must not expire the lock mid-fetch | non-negotiable |
| Check-worker concurrency | 10 | pool baseline above: 10 x 10 s timeout bounds in-flight fetches and their sockets | default — tune in Phase 4/5 with data |

### 15.4 Worker-host network egress control (S-1 layer 1)

*Added 2026-09-09, fix cycle (egress layer — resolves S-1 layer 1 / RR-01)*

S-1's layered defense does not stop at the check engine. Review S-1 names **egress control at the OS/network level on the worker host** as layer 1 — the boundary that still holds when application code is bypassed — and this subsection specifies it as design (S-1 / RR-01):

- **Deny outbound connections to the private ranges, with a range list that mirrors the §15.1 step 4 sub-step 2 engine denylist exactly:** the IPv4 private/loopback/link-local ranges (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`), the IPv6 loopback/ULA/link-local ranges (`::1`, `fc00::/7`, `fe80::/10`), plus the mapped/unspecified/NAT64 additions of this same fix cycle (`0.0.0.0/8`, `::ffff:0:0/96`, `64:ff9b::/96`). The two layers share one list so they cannot drift: every range the engine denies, the host denies too, and any future denylist extension (a newly identified bypass class) must be applied to §15.1, this subsection, and the runbook §10 rule set in the same change.
- **Egress to the public internet is allowed on ports 80/443 only** — the two ports the engine's scheme allowlist already permits; every other destination port is refused at the host boundary.
- **Explicit exceptions the worker cannot function without:** DNS resolution (resolve-then-validate needs the resolver), and loopback/VPC-internal reachability to Postgres (5432) and Redis (6379) — the worker's own infrastructure lives inside the boundary the denylist protects, and the engine cannot run without it.

**Rationale (S-1's own layered-defense requirement):** engine validation is strong but retains residual bypass classes — a future engine refactor, a bug in the canonicalization step, or a non-HTTP check type added by a later UPGRADE_PLAN phase could route traffic the engine never validated. The OS layer is the independent backstop that makes the worker host incapable of reaching the private network regardless of what application code does; S-1 is the review's highest-severity security item and its §9 text lists network egress first among the layers for exactly this reason.

**Verification stance:** the host firewall rules are applied **once, at Phase 4 worker provisioning, before the worker takes production traffic** — not per release. The operator steps (apply, verify, rollback) are [DEPLOY-RUNBOOK.md](./DEPLOY-RUNBOOK.md) §10; this subsection is the design-level rule set only — no shell commands live here (D-01 scope split: commands belong to the runbook).

---

## 16. Proposed Batching / Aggregation Architecture

*Amended 2026-09-09 (resolves J-2, D-1, D-2, D-4, D-5, D-6; §9 items 2, 8, 9, 12)*
*Amended 2026-09-09, fix cycle (resolves CR-01, CR-02, CR-03, IN-03, IN-04, OBS-01; §16.2 exclusive-snapshot flush + evidence-row INSERT, §16.4 dedup vocabulary)*

Replaces `db-batcher.ts` (deleted). Split by criticality into two tiers, each specified as literal SQL a Phase 4 implementer transcribes without interpretation:

**Tier 1 — synchronous transaction (never batched):** every check whose classified result **changes** `monitors.status` — DOWN transition, RECOVERED transition, first check (PENDING → UP/DOWN) — regardless of whether the check was scheduled or manual. Written as **one synchronous Postgres transaction** by the `persist` processor inside the check job: monitor UPDATE + ping INSERT + incident INSERT/UPDATE + outbox INSERT (§16.1). Durability: BullMQ retries ⇒ a Postgres outage yields retryable jobs, not lost data (rule 14).

**Tier 2 — guarded aggregation (routinely batched):** every check whose result **matches** current status (routine UP, unchanged DOWN) — again including manual checks that don't transition. Counter deltas aggregate in the `agg:results:{monitorId}` Redis hash (atomic `HINCRBY`/`HSET` per routine check) **and one per-check evidence row is buffered per routine check (`RPUSH` onto the `pings:pending:{monitorId}` list)** — Tier 2 carries per-check ping evidence, it does not discard it (CR-01). Both containers are flushed within 60 s by the §16.2 guarded transaction: a job-start `RENAMENX` moves the live keys to batch-scoped staging keys, one transaction applies a **multi-row `INSERT INTO pings`** plus **one guarded atomic UPDATE per monitor that never writes `status`**, and only the staging keys are deleted after COMMIT — the live keys are never deleted by a flush job.

Invariants:
1. `monitor.status` is **only** written by Tier 1 (fixes B3 state-regression defect).
2. Aggregate flush uses `last_checked = GREATEST(existing, incoming)`, additive counters, and the `CASE` response-time guard (fixes B4, D-5).
3. Redis buffer is loss-tolerable by definition; Postgres is authoritative for every transition (rules 1, 7, 13).
4. Buffer size — hash deltas **and** pending evidence rows — is bounded by design (60 s window × check rate) — no unbounded growth (fixes B5).
5. Flush batches are exactly-once by a two-part guarantee (CR-02): the same-transaction `write_guards` guard keyed `flush:{batchId}` (J-2) **plus** `RENAMENX` staging exclusivity — a flush reads and deletes only its own `agg:flushing:{batchId}` / `pings:flushing:{batchId}` staging keys, so concurrent or retried passes can neither double-apply deltas nor destroy post-snapshot deltas.

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
--    delivery counts the check exactly once. Zero rows returned ⇒ skip
--    steps 3–4 and COMMIT. Zero rows has two causes and implementers must
--    NOT branch on which one occurred (IN-04): (a) another executor already
--    made this transition, or (b) is_active was cleared after the claim —
--    same skip path for steps 3–4 either way. The step-1 evidence ping for
--    a deactivated monitor is accepted (retention cleans it in 30 days).
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

*Amended 2026-09-09, fix cycle (resolves CR-01, CR-02, IN-03)*

One transcribable sequence: **step 0** — job-start exclusive snapshot (Redis); **step 1** — guarded transaction (SQL); **step 2** — post-commit cleanup (Redis). The `{batchId}` in every key and guard name is generated by the pinned scheme at the end of this subsection and rides the BullMQ job's `data`, so a redelivered job re-derives the same staging key names and the same guard key.

**Step 0 — job-start exclusive snapshot (Redis, before the transaction).** First a read-only guard pre-check — `SELECT 1 FROM write_guards WHERE key = 'flush:{batchId}'`: a returned row means this batch already committed (worker crashed after COMMIT, before cleanup); the job skips straight to step 2 (cleanup) and never touches the live keys. Otherwise the job takes the exclusive snapshot:

```redis
RENAMENX agg:results:{monitorId}   agg:flushing:{batchId}
RENAMENX pings:pending:{monitorId} pings:flushing:{batchId}
```

- `RENAMENX` is atomic (redis.io/commands/renamenx): a concurrent flush pass for the same monitor either gets the whole live container or finds nothing (source key absent ⇒ that pass completes as a no-op). Routine deltas accrued after the snapshot accumulate in freshly created live keys (`HINCRBY`/`RPUSH` create on first write) that no in-flight flush touches.
- The **NX clause is what makes redelivery safe** (CR-02): a redelivered job whose staging keys still hold its earlier snapshot (crash before COMMIT) does not recapture the live keys — the rename is skipped, the staged snapshot is applied by this run, and post-snapshot deltas stay in the live keys for the next pass. A plain `RENAME` here would overwrite the staged snapshot (or, on the already-applied path, drag post-snapshot live deltas into a staging key that the exit path then deletes) — do not "simplify" it.
- **Missing-key handling:** if neither live key exists **and** neither staging key for this batch exists, nothing was accrued and nothing is staged — the job completes successfully without opening a transaction.

**Step 1 — guarded transaction (SQL).** The UPDATE's parameters are read from the staging hash `agg:flushing:{batchId}` (`HGETALL`: `count`→`$dTotal`, `failedCount`→`$dFailed`, `lastCheckedAt`→`$lastTs`, `lastResponseTime`→`$lastRt`); the INSERT's tuples are the staged evidence rows read from the staging list `pings:flushing:{batchId}` (`LRANGE 0 -1`).

```sql
BEGIN;

-- Guard: same-transaction write guard (J-2). Zero rows returned ⇒ this batch
-- was already applied (worker crashed after commit but before the staging-key
-- delete; BullMQ redelivered the flush job) ⇒ COMMIT and exit — the retry is
-- a no-op BEFORE the pings INSERT and the UPDATE. A Redis-side guard alone is
-- insufficient (keys can be flushed/lost).
INSERT INTO write_guards(key) VALUES ('flush:{batchId}')
  ON CONFLICT DO NOTHING
RETURNING key;

-- Per-check evidence rows (CR-01): one row per routine check staged in the
-- pings:flushing:{batchId} list — Tier 2 carries per-check ping evidence, it
-- never discards it. The id column is omitted so the pinned DB default
-- applies (D-3) — ids are never bound. Natural row bound (D-10): rows per
-- flush = checks accrued in one flush window at the monitor's interval —
-- 1-2 rows per pass at the 1-minute minimum interval — no artificial cap.
INSERT INTO pings (monitor_id, status, response_time, error_class, status_code, created_at)
VALUES ($mid, $status, $rt, $errClass, $statusCode, $ts), ... ;  -- multi-row: one tuple per staged check

-- Additive monotonic UPDATE: never writes status (B3 fix). Deltas only.
UPDATE monitors SET
  total_checks  = total_checks + $dTotal,
  failed_checks = failed_checks + $dFailed,
  last_checked  = GREATEST(last_checked, $lastTs),
  response_time = CASE WHEN $lastTs > last_checked THEN $lastRt ELSE response_time END
WHERE id = $mid;

COMMIT;
```

**Step 2 — post-commit cleanup (Redis, after COMMIT succeeds):**

```redis
DEL agg:flushing:{batchId} pings:flushing:{batchId}
```

Both **staging** keys are deleted only after COMMIT succeeds — including on the guard's no-op exit paths (the step-0 pre-check exit and the in-transaction 0-rows exit). The **live** keys `agg:results:{monitorId}` / `pings:pending:{monitorId}` are never deleted by a flush job; they are only ever moved by the *next* pass's step-0 snapshot.

**batchId generation (IN-03, pinned per D-10):**

| Parameter | Default | Rationale | Class |
|---|---|---|---|
| batchId scheme | `{epochMs-of-flush-pass}:{monitorId}` | the flush-pass scheduler job's creation timestamp (epoch ms) plus the monitor id — unique per flush-job creation (`{epochMs}` separates passes, `{monitorId}` separates monitors; the `flush-pass` scheduler creates one job per monitor per pass, so a created job's batchId never repeats); carried in the BullMQ job's `data`, so a redelivery re-derives the identical staging key names and guard key — deterministic under retry (CR-02) | non-negotiable (shape) |

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
- **Relay validation (event_type / incident_id consistency, CR-03):** the relay treats `event_type` and `incident_id` nullability as a consistency contract when enqueueing alert jobs — `monitor.first_check` rows carry NULL `incident_id` by design; `incident.down` / `incident.recovered` rows carrying NULL `incident_id` are the §16.4 contract violation and dead-letter at the alerts processor (`UnrecoverableError`), never silently skipped.
- The relay is a BullMQ-scheduled job on the worker; `FOR UPDATE SKIP LOCKED` keeps multiple relay instances safe without coordination.

### 16.4 Alert dedup vocabulary — one key per declared event type (D-4 / DAT-06)

*Amended 2026-09-09, fix cycle (resolves CR-03)*

Deduplication is keyed to the **alert event**, not the monitor state — a state-keyed scheme cannot distinguish incidents that recur. The outbox (§16.3) is the durable event source; Redis dedup is a best-effort collapse of at-least-once duplicates on top (rule 2). §11 declares exactly three outbox event types, and every one of them has a dedup key (CR-03):

- **Key formats — one per declared event type:**
  - `incident.down` → `alert:{incidentId}:down`
  - `incident.recovered` → `alert:{incidentId}:recovered`
  - `monitor.first_check` → `alert:{monitorId}:first_check` (monitor-scoped, not incident-scoped — the event has no incident)
- **Contract rule (non-NULL `incident_id`):** `incident.down` and `incident.recovered` outbox rows **REQUIRE a non-NULL `incident_id`**. A violating row is a contract violation detected by the alerts processor, which throws `UnrecoverableError` so it dead-letters immediately (the same §13.5 pattern as an invalid chat target) instead of silently suppressing alerts — interpolating a NULL incidentId would mint a shared `alert:null:*` key that collides across every monitor and suppresses other monitors' alerts for 24 h (CR-03's cross-monitor failure mode).
- **Write discipline:** `SET <dedup-key> 1 NX EX 86400` — written **only after a confirmed send** (Telegram API 2xx). TTL 24 h bounds key growth; a recurring incident gets a new `incidentId` anyway.
- **Check-before-retry:** every attempt (BullMQ retry or a redelivered outbox event) checks `EXISTS <dedup-key>` first; if held, the processor skips the send and completes the job successfully.
- **Attempt bound:** ≤ 3 BullMQ attempts, then the job dead-letters (7-day retention, D-14).
- **Residual duplicates** (send succeeded, response lost, and the key write also lost) are accepted, documented at-least-once behavior — preferable to silence.
- **Dead-lettered flush jobs are inspect-only (OBS-01 ops note):** a flush job that exhausts its attempts leaves its snapshot in the `agg:flushing:{batchId}` / `pings:flushing:{batchId}` staging keys — operators never replay it; the `write_guards` guard makes a manual retry a safe no-op if the batch ever applied, and unapplied staged deltas are Tier 2 loss-tolerable (invariant 3). Detection is DLQ / outbox-age observability (§13.5); the failure-mode disposition is §16.6's dead-lettered-flush row.

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
| Flush re-applied after a crash between commit and the staging-key delete | `write_guards` insert returns 0 rows for the same `flush:{batchId}` key (or the step-0 guard pre-check returns a row) | Transaction exits **before** the pings INSERT and the UPDATE — counters and ping rows change by zero | **Staging** keys (`agg:flushing:{batchId}`, `pings:flushing:{batchId}`) deleted on the retry's exit path; the **live** keys — holding post-snapshot deltas for the next pass — are untouched; TC-FLUSH-GUARD-01 pins it |
| Flush job dead-letters (attempts exhausted; snapshot still in its staging keys) | DLQ / outbox-age observability (§13.5, OBS-01) | **inspect-only** — never auto-retried past the lane's attempt bound; a manual retry is a safe no-op if the batch ever applied (`write_guards` guard), and unapplied staged deltas are Tier 2 loss-tolerable data (invariant 3) | subsequent flush passes persist later deltas normally; the retained staging keys keep the dead-lettered batch inspectable until operator cleanup |
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

*Amended 2026-09-15 (resolves CR-02 — 01-VERIFICATION design-debt register: §20.1 adds the M4 GATED WINDOW procedure per the Phase-5 context decisions D-01/D-02/D-06/D-08, encoding the runbook §4a "disable nothing" co-run strategy; the original M4 ordering remains binding for ungated overlap)*

| ID | Risk | Mitigation |
|---|---|---|
| M1 | **Dual-write/divergence during transition** — Prisma and Drizzle against the same tables | Don't dual-write. Cutover is by module with Drizzle owning the schema from day one of the migration branch; Prisma remains read-only fallback only until each module flips (rule 20 ⇒ removed at the end) |
| M2 | **Auth cutover locks users out** (hash/session/cookie incompatibility) | bcrypt compatibility gate (§12.2): canary login on the anonymized snapshot, then production, before any route flip; keep user IDs; accept forced re-login (sessions invalidated) as a known, announced consequence; keep old NextAuth tables intact for rollback *(Amended 2026-09-09, fix cycle — resolves RR-04/WR-06)* |
| M3 | **Monitoring gap during worker cutover** (checks stop while jobs move) | Run overlap window: worker live and verified (healthchecks.io + queue depth ≈ 0) *before* disabling `instrumentation.ts` cron; both paths idempotent so brief overlap only wastes checks, never corrupts |
| M4 | **Counter corruption** from overlapping old/new write paths during overlap | Make increments SQL-atomic in the new path first; old path disabled before first new-path flush; verify totals before/after *(Amended 2026-09-15 — resolves CR-02: the disable-before-first-flush ordering remains binding for UNGATED overlap; the GATED WINDOW procedure of §20.1 supersedes it for the rehearsed Phase-5 cutover only)* |
| M5 | **`monitors.id` type drift** breaks public URLs/FKs | Keep `serial` integers (§11.1) |
| M6 | **Timestamp TZ drift** (Prisma `timestamp` ↔ Drizzle `timestamptz`) silently shifts stored times | Inspect live column types before writing the Drizzle schema; pin explicit modes; validate with a data diff script (§21) |
| M7 | **Redis becomes a hidden dependency** — outage taken as full outage | §13.2 pause-by-design with dead-man's-switch detection and staleness UI; no fallback write path exists; heartbeat + queue metrics keep the pause visible |
| M8 | **BullMQ Job Scheduler drift** after Redis restarts (missing/duplicated schedules) | Job Schedulers are declarative — `upsertJobScheduler` at every worker boot (§13.6 step 1); claim-epoch jobIds absorb duplicates; scheduler leader lock prevents parallel ticks |
| M9 | **Next 16/React 19 + pnpm migration churn** mixed with backend migration | Do package-manager + Next patch bump as an isolated first step with its own verification (§24 step 0) |
| M10 | **`typescript.ignoreBuildErrors: true`** hides migration type breakage | Turn it off at migration start; fix errors as part of step 0 (small codebase; feasible) |
| M11 | **Vercel-mode cron parity** — features silently missing after cutover | `CRON_MODE` is deleted; the worker replaces both modes; update docs/deploy scripts to remove healthchecks/external-cron duplication |
| M12 | **Advanced-monitoring schema (UPGRADE_PLAN) collides with migration** | Freeze new schema features until Drizzle cutover completes; reserved columns documented in §11 rather than added twice |

### 20.1 M4 amendment — the GATED WINDOW procedure

*Amended 2026-09-15 (resolves CR-02, 01-VERIFICATION design-debt register — the §4a/M4 overlap contradiction; ratified in the Phase-5 context decisions D-01/D-02/D-06/D-08. The executable choreography — re-seed, unpause, abort drill, window, gates, operator approval, deletion release — lives in DEPLOY-RUNBOOK.md §4a; this section is the design authority behind it.)*

M4's original mitigation — *old path disabled before first new-path flush* — encodes the assumption that the only safe overlap is one in which the legacy writer never runs concurrently with the new one. **That ordering remains binding for UNGATED overlap**: any co-run that is not the gated procedure below must still disable the legacy write path before the first new-path flush, exactly as the original row prescribes. The Phase-5 cutover does not weaken this rule; it replaces the ungated form with a **GATED WINDOW** — a rehearsed, evidence-gated procedure with a pre-committed abort, in which the legacy cron deliberately stays live for the whole window as a hot fallback (the "disable nothing" posture, 05-CONTEXT D-01). The co-run is safe because four named mechanisms bound, absorb, and detect the overlap:

**Mechanism 1 — due-filter starvation bounds write overlap to the takeover minute.** The worker claims monitors through `next_check_at` (§14.3's atomic claim with the GREATEST catch-up advance) and **both** worker write tiers advance `last_checked`: Tier 1 writes it inside the conditional transition UPDATE (§16.1), and Tier 2's guarded flush writes `GREATEST(last_checked, staged)` so a late-arriving buffered sample can never regress it (§16.2, TC-MONOTONIC-01). Cron's due-filter, by contrast, is a pure re-read of `lastChecked + interval` on every pass (legacy `cron-logic.ts:33-46`: a monitor with no `lastChecked` is due now; otherwise due iff `now >= lastChecked + interval×60s`). The consequence is the load-bearing argument: **once the worker has checked a monitor, the next cron pass stops finding it due.** Cron self-suppresses within one interval of a worker check — no coordination protocol, no shared lock, no disable step. Cron thereby becomes a *self-suppressing hot fallback*, and the same mechanism is why the abort rule (mechanism 4) restores full cron coverage within one interval of a re-pause, with zero monitoring gap. The residual exposure is the takeover sweep itself: if cron fetched the monitor row just before the worker's write landed, one duplicate check executes — bounded to the takeover minute per monitor. For routine UP results, which reach Postgres via the Tier-2 flush (≤60 s window), starvation lag is bounded to roughly one interval plus the flush cadence; transition writes are synchronous inside check jobs (§16.1) and never wait on a flush.

**Mechanism 2 — the write paths are idempotent and guarded where they do overlap.** The worker's increments are SQL-atomic and additive (the original M4 "make increments SQL-atomic in the new path first" — shipped in Phase 4): Tier 2 applies counter deltas plus evidence rows inside a guarded flush transaction whose `write_guards` key and RENAMENX staging snapshot make redeliveries no-ops (§16.2, TC-FLUSH-GUARD-01); Tier 1's transition transaction is serialized by the conditional UPDATE plus the partial unique ONGOING index, so a duplicate transition delivery records its evidence ping but counts transition effects and outbox rows exactly once (§16.1, TC-DUP-INCIDENT-01). What mechanism 2 cannot fix is the legacy path itself — the batcher's counters are unguarded read-modify-write from a pass-start read, the original M4 concern. That class is not patched (the legacy engine is frozen); it is *detected* (mechanism 3) and *bounded* (mechanism 1) instead.

**Mechanism 3 — typed detection: verify + gate + disposition, no suppression machinery.** Duplicate exposure during the window is observed through typed gates, never suppressed with new coordination code (05-CONTEXT D-05 posture):
- **Pings-vs-counters reconciliation (05-CONTEXT D-02):** per-monitor `pings` rows created in the window compared against the `total_checks` delta — the direct detector for a legacy read-modify-write clobbering a worker Tier-2 additive flush.
- **Alert-parity counts:** exactly one relayed alert per incident, message bytes pinned to the D-48 characterization; any transient takeover-minute duplicate is dispositioned in the deploy record, not machine-suppressed.
- **D-37 dry-run recompute:** uptime percentages recomputed with the writers' own expression over window data. Crucially, D-37 **alone is blind to the lost-update class** — a clobbered counter pair carries a self-consistent `uptime_percent`, because the same stale read wrote both `total_checks` and `failed_checks`; only the pings-vs-counters reconcile sees the corruption. Both detectors therefore run as window gates; neither substitutes for the other.

**Mechanism 4 — the pre-committed re-pause abort rule (05-CONTEXT D-06).** On any red gate the operator re-pauses the scheduler (`WORKER_SCHEDULER_ENABLED=false` + worker restart). Mechanism 1 then works in reverse: with the worker no longer advancing `last_checked`, cron's due-filter re-admits every monitor within one interval — zero-gap rollback with no code rollback. Tarball restore is reserved for code-level breakage only. The abort is drilled live *before* the window opens (runbook §4a), so the first real use is never under incident stress.

The gated window closes only on the full seven-gate checklist (heartbeat steady via the healthchecks.io flips record, queue age+drain, alert parity, both counter gates, continuity gap-scan, zero duplicate ONGOING incidents, legacy-path log disposition — 05-CONTEXT D-13/D-17), and operator approval sits between window-green and the deletion release (05-CONTEXT D-18). The deletion release itself is scheduler-only (`instrumentation.ts` + `CRON_MODE`); the cron engine, batcher, and `/api/cron/*` routes survive dormant as the manual emergency lever until Phase 6 deletes them (05-CONTEXT D-03/D-38).

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

*Amended 2026-09-09 (resolves P-1, M-1, M-2, M-3, S-4; §9 items 21, 22)*

The authoritative operator runbook for every release this milestone is [DEPLOY-RUNBOOK.md](./DEPLOY-RUNBOOK.md) — exact step orderings, per-step verification and rollback actions, PM2 settings, and the connection-budget summary. This section stays design-level: the changes below describe the **target** shape. The interim ordering (Phases 2–3, single PM2 app, no worker step until Phase 4) exists and is specified in the runbook; where any ordering statement here and the runbook could be read differently, the runbook wins.

Current: GitHub Actions on push to `main` → `npm ci` → build → SCP tarball → VPS → `npm ci --omit=dev` → `prisma generate` → `prisma db push --accept-data-loss` → `pm2 start` (single PM2 app, [deploy.yml](../.github/workflows/deploy.yml)).

Target changes:

1. **pnpm:** `pnpm fetch/install --frozen-lockfile` in CI; commit `pnpm-lock.yaml`; remove `package-lock.json` (and the stray `allowScripts` block moves to pnpm's `onlyBuiltDependencies`).
2. **Two PM2 apps** in [ecosystem.config.js](../ecosystem.config.js): `uptime-tracker` (web, unchanged) + `uptime-worker` (new, `worker/dist/index.js`), with `kill_timeout` to let the worker drain jobs and flush aggregates on deploy.
3. **Migrations replace `db push`:** `pnpm drizzle-kit migrate` (versioned SQL files committed to the repo) runs in the deploy script **before** app/worker restart; delete `--accept-data-loss` forever.
4. **Worker build artifact:** tsc/tsup build of `worker/` included in the tarball (or the whole deploy switches to a single `pnpm build` producing `.next` + `worker/dist`).
5. **Env additions:** `REDIS_URL`, `EMAIL_PROVIDER`, provider keys, `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`, `AI_*` (optional/flagged); retire `NEXTAUTH_*`, `CRON_MODE` (keep `CRON_SECRET` only if the API-triggered cleanup path is retained during transition).
6. **Health surfaces:** worker `:9090/healthz|readyz` wired to PM2 restart + healthchecks.io; heartbeat moves from web cron to worker scheduler tick.
7. **Rollback story:** keep previous release tarball on VPS; DB migrations are forward-only but additive-first (§21/D2) so the previous web+worker pair runs against the migrated schema during the verification window.
8. **Repo hygiene (do early; S-4):** remove `ngrok` binary + `ngrok.log` from git (and purge from history or accept the bloat), add `.env.example` documenting the full variable set (currently only prose in README); design rule — no endpoint accepts secrets via query strings, and `CRON_SECRET` retires with the cron endpoints (decision note: [DEPLOY-RUNBOOK.md](./DEPLOY-RUNBOOK.md) §9).
9. Optionally split CI jobs: `lint → typecheck → test → build` gates before deploy (no gates exist today).

---

## 23. Testing Requirements

*Amended 2026-09-09 (resolves D-1, D-4, J-2; §9 items 2, 8, 12; §10 criterion 3)*
*Amended 2026-09-09, fix cycle (resolves CR-01, CR-02, CR-03, IN-02, IN-04, OBS-01; TC-FLUSH-GUARD-01 / TC-MONOTONIC-01 staging-key rewrites + new TC-FIRST-CHECK-DEDUP-01)*
*Amended 2026-09-09, fix cycle (resolves WR-01, RR-03; new TC-SSRF-MAPPED-V6-01 + item 5 rewritten to the real degradation assertions)*

Today there are **no tests** (no unit/integration/E2E framework, no CI gates; only ad-hoc root scripts `test-email.js`, `test-prisma*.js`, `test-webhook.js`). The migration must introduce a safety net *before* the risky steps:

**Stack:** Vitest (unit/integration, workers + lib) · Testcontainers or docker-compose Postgres+Redis for integration · Playwright (E2E, dashboard + status page).

**Minimum gate before any migration step (Phase 0):**
1. **Characterization tests** for `runCronChecks`: due-time filter, UP/DOWN classification, transition paths (PENDING→UP, UP→DOWN, DOWN→UP), incident open/resolve, Telegram message selection — against a test DB, with `fetch` stubbed. These pin current behavior so the rewrite provably preserves it (rule: "modernize without breaking existing functionality").
2. **db-batcher tests:** enqueue/flush math, counter accumulation, flush-failure data-loss behavior (documented, then intentionally changed by §16).
3. **API contract tests:** per route — auth required, ownership scoping, validation, status codes. These become the Drizzle/Better Auth regression net.

**New-path tests:**
4. **Worker unit tests:** idempotency key short-circuit; lock acquire/release incl. owner-only release; retry/backoff config; transition transaction (monitor+ping+incident atomic).
5. **Aggregation tests:** concurrent `HINCRBY` correctness; flush exactly-once via the staging/guard semantics (§16.2 — idempotent apply, TC-FLUSH-GUARD-01); buffer bounded. Degradation assertions at the unit level (complementing — not duplicating — item 6's injected-outage rows): with Redis unavailable, the manual-check enqueue path returns **503**, never a silent no-op (§13.2 item 4); monitoring pauses by design; Postgres data stays intact — no fallback write path is exercised because none exists (§13.2 item 1).
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

**TC-FIRST-CHECK-DEDUP-01 — monitor-scoped first_check dedup never collides across monitors**
- Given: monitor 42's `monitor.first_check` outbox row (`incident_id` NULL by design — a PENDING→UP first check opens no incident) whose "MONITORING STARTED" alert was already sent at 09:14:05Z; Redis key `alert:42:first_check` is held (TTL 86400); BullMQ redelivers 42's alert job; in the same relay pass at 09:14:20Z, monitor 43's fresh `monitor.first_check` outbox row (never sent) is selected
- When: the alerts processor handles both events (42 redelivered, 43 fresh)
- Then: **Redis** — no additional `SET alert:42:first_check` (the `EXISTS` check short-circuits; TTL untouched) and one `SET alert:43:first_check 1 NX EX 86400` after 43's confirmed send. **Telegram** — monitor 42 sends **nothing**; monitor 43's start alert **SENDS** — the monitor-scoped key means no cross-monitor collision (a NULL-incident `alert:null:*` key shape would have suppressed 43's alert for 24 h — CR-03's failure mode). **DB** — both outbox rows keep `sent_at` set exactly once. **Queue** — both alert jobs **complete successfully** (42's via the dedup skip path).

**TC-FLUSH-GUARD-01 — redelivered flush changes counters and ping rows by zero; live keys untouched**
- Given: flush batch `flush:1770890760000:42` (batchId `1770890760000:42`, flush pass created 2026-02-12T10:06:00Z) for monitor 42 was already applied at 10:06:00Z (a `write_guards` row with `key='flush:1770890760000:42'` exists; `monitors.total_checks=101`; the batch's 4 evidence ping rows are already in `pings`); the flush job crashed after COMMIT but before deleting its staging keys (`agg:flushing:1770890760000:42` / `pings:flushing:1770890760000:42` still hold the applied snapshot), and BullMQ redelivers. Post-snapshot deltas have since accrued in the live keys: `agg:results:42` holds `count=2` and `pings:pending:42` holds 2 evidence rows, waiting for the next pass
- When: the redelivered §16.2 flush re-runs with the same batchId in its job data and the staged snapshot's values (`$dTotal=4`, `$dFailed=0`, `$lastTs=10:05:58Z`, `$lastRt=210`)
- Then: **DB** — the step-0 guard pre-check returns the existing row (equivalently, the `write_guards` `INSERT … ON CONFLICT DO NOTHING RETURNING key` returns **0 rows**), and the transaction exits **before** the pings INSERT and the UPDATE: `monitors.total_checks` stays 101 (change by zero), `last_checked` and `response_time` unchanged, `pings` gains **no** rows; no new `write_guards` row. **Redis** — the **staging** keys `agg:flushing:1770890760000:42` and `pings:flushing:1770890760000:42` are deleted on the retry's exit path (cleanup proceeds despite the skip); the **live** keys `agg:results:42` (`count=2`) and `pings:pending:42` (2 rows) are **explicitly NOT deleted** — they hold the next pass's data.

**TC-MONOTONIC-01 — late-arriving buffered result cannot regress display fields**
- Given: monitor 42 with `last_checked=T1=10:06:00Z`, `response_time=250`, `total_checks=100`, `failed_checks=5`; a buffered routine result with timestamp `T0=10:04:30Z` (older than T1) and response 900 ms flushes in a batch with deltas `$dTotal=1`, `$dFailed=0`, `$lastTs=T0`, `$lastRt=900`
- When: the §16.2 guarded flush applies the batch
- Then: **DB** — `last_checked` stays `T1` (`GREATEST(T1, T0)=T1`); `response_time` stays 250 (`CASE WHEN T0 > T1` is false → ELSE keeps the current value; the older sample does not overwrite); `total_checks=101` and `failed_checks=5` (the buffered deltas still apply additively); `status` is untouched (Tier 2 never writes status). **Redis** — the batch's **staging** keys (`agg:flushing:{batchId}`, `pings:flushing:{batchId}`) are deleted only after the flush transaction commits; the **live** keys are untouched by this flush.

**SSRF and classification cases (given/when/then, per review §10 criterion 3).** *Amended 2026-09-09 (resolves S-1, J-4; §9 items 4, 18; §10 criterion 3)* — the check-job mechanics under test are §15.1 steps 4–6; each Then names its expected DB rows (`pings.error_class` values), queue state (completed vs retried), and network effect.

**TC-SSRF-REDIRECT-PRIVATE-01 — redirect to a link-local metadata address is blocked, recorded, and never dialed**
- Given: a monitor whose url is `https://good.example/redirect`; the origin responds `302` with `Location: http://169.254.169.254/latest/meta-data` (link-local cloud-metadata address)
- When: the check job executes
- Then: **queue** — the job **completes successfully** carrying result DOWN with `error_class = 'ssrf_blocked'` (never retried); **network** — **no request reaches `169.254.169.254`**: hop 2 is rejected by the per-hop resolve-then-validate of §15.1 step 4 before any connect; **DB** — the resulting ping row records `pings.error_class = 'ssrf_blocked'`.

**TC-SSRF-DNS-REBIND-01 — public at resolve time, private at connect time, refused by the connection-time validator**
- Given: a hostname that resolves to a public IP (e.g. `203.0.113.10`) at resolve time and to a private IP (e.g. `192.168.0.5`) at connect time (DNS rebinding)
- When: the check executes
- Then: **network** — the connection is refused by the connection-time validator: the dialer connects only to addresses from the resolve-time validated set (§15.1 step 4), so no packet reaches `192.168.0.5`; **DB** — the result is DOWN with `pings.error_class = 'ssrf_blocked'`; **queue** — job completed, not retried.

**TC-SSRF-MAPPED-V6-01 — IPv4-mapped IPv6 AAAA record with a private embedded IPv4 is caught by canonicalization, not the raw range list**
- Given: a monitor hostname whose AAAA record resolves to the IPv4-mapped address `::ffff:10.0.0.1` (inside `::ffff:0:0/96`; the embedded IPv4 `10.0.0.1` is inside `10/8`) — a raw literal that matches none of the legacy IPv6 denylist ranges
- When: the check executes
- Then: **network** — no connection is attempted: §15.1 step 4 sub-step 2's canonicalization rule reduces the address to its embedded IPv4 form (`10.0.0.1`) and the IPv4 denylist rejects it before the dialer runs — canonicalization catches what the raw range list misses (WR-01); **DB** — the result is DOWN with `pings.error_class = 'ssrf_blocked'`; **queue** — the job completes successfully (a target outcome, never an infra retry).

**TC-SSRF-SCHEME-01 — non-http(s) scheme rejected before any network I/O**
- Given: a monitor url with a non-http(s) scheme (e.g. `file:///etc/passwd` or `gopher://internal.example:6379/_INFO`)
- When: the check executes
- Then: **network** — zero DNS queries and zero connections: the scheme allowlist rejects at §15.1 step 4 sub-step 1, before any network I/O; **DB** — result DOWN with an explicit `pings.error_class = 'ssrf_blocked'`; **queue** — job completed successfully.

**TC-SSRF-SIZE-CAP-01 — oversized body aborts at the cap without becoming an infra retry**
- Given: a target whose response body exceeds 2 MB
- When: the check executes
- Then: **network** — the body read aborts at the 2 MB cap and the connection is abandoned; **DB** — the check still records a completed result: a ping row written with the header-derived status and `status_code`; **queue** — job **completed** (a target outcome, not an infra retry).

**TC-CLASSIFY-TIMEOUT-01 — target timeout is a successful DOWN job, never retried**
- Given: a target that never responds within the 10 s fetch timeout
- When: the check executes
- Then: **queue** — the job is a **success** carrying DOWN with `error_class = 'timeout'`; the job is **never retried** for a target timeout (attempts stay at 1 — J-4); **DB** — `pings.error_class = 'timeout'`, `pings.status_code` NULL (no response arrived).

**TC-CLASSIFY-DNS-01 — NXDOMAIN is a successful DOWN job, no retry**
- Given: a monitor hostname whose DNS lookup returns NXDOMAIN
- When: the check executes
- Then: **queue** — the job **succeeds** carrying DOWN with `error_class = 'dns'`; no retry; **DB** — `pings.error_class = 'dns'`, `pings.status_code` NULL.

**TC-CLASSIFY-INFRA-01 — Postgres unreachable at persist time retries with bounded attempts, no partial write**
- Given: a check whose fetch succeeded and classified a DOWN transition (Tier 1 path, §16.1), with Postgres unreachable at persist time
- When: the check executes the persistence step
- Then: **queue** — the job **throws** (infrastructure failure) and is retried with bounded attempts (3) and exponential backoff; if attempts exhaust, it dead-letters (≥ ~7 d best-effort retention, D-14); **DB** — **no partial write survives**: the Tier 1 transaction is atomic — either monitor UPDATE + ping + incident + outbox all commit or none does — and on the successful retry the D-1 conditional UPDATE gates re-application.

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
| 7 | **Better Auth cutover** | bcrypt compatibility gate (§12.2): canary login on the anonymized snapshot, then production, before any route flip → migrate `users`/`accounts`/tokens (§12, §21); flip routes to Better Auth handlers; invalidate sessions (announced); delete NextAuth deps + duplicated Redux auth-token mirror *(Amended 2026-09-09, fix cycle — resolves RR-04/WR-06)* | — |
| 8 | **Prisma removal** | Port remaining routes/read paths to Drizzle; delete `prisma/`, generated client, deps; Drizzle is sole ORM | 20 |
| 9 | **AI SDK (flagged)** | `lib/ai` + streaming endpoints for incident summarization & monitor-setup assistant; feature-flag off by default | 15 |
| 10 | **Final visual redesign** | The UI overhaul on top of stable theme tokens + stable APIs (shadcn expansion, hugeicons consolidation, light palette refinement, motion polish, sweetalert2 → shadcn alert-dialog) | 17–19 |

**Critical-path dependencies:** 0 → (1,2,3 in parallel) → 4 → 5/6 → 7 → 8 → 9/10. Step 4 is the highest-risk step and depends on 2–3; it must ship behind the overlap window described in M3.

---

## 25. PostgreSQL Connection Budget

*Added 2026-09-09 (resolves D-8; §9 item 20)*
*Amended 2026-09-09, fix cycle (resolves IN-05; §25.1 steady-state restated as ≤ 30 connections, ≤ 31 only during deploys while the migration runner is connected)*

Three processes open Postgres connections — web (Next.js), worker, and the migration runner — plus the transitional Prisma pool during Phases 3–7 (M-1). This section is the full budget spec (D-03); the deploy runbook carries only the operational summary table (web 10 / worker 20 / migrations 1).

### 25.1 Per-process pool budget (DAT-09 — non-negotiable)

| Process | Pool `max` | Connection string | Rationale |
|---|---|---|---|
| **web** (Next.js, PM2 `uptime-tracker`) | **10** | **POOLED** (provider pooler endpoint) | Request-serving reads/writes; concurrent request handlers share one pool; the pooler multiplexes the server-side connections (D-8, N-10) |
| **worker** (PM2 `uptime-worker`) | **20** | **DIRECT** | Check concurrency 10 × (Tier 1 transition + Tier 2 flush overlap) plus relay/maintenance lanes; DIRECT keeps full transaction semantics off the pooler |
| **migration runner** (deploy pipeline, one-shot) | **1** | **DIRECT** | Exactly one runner applies migrations, serially (M-1 — concurrent boot DDL is forbidden); DDL over a transaction-mode pooler is unsafe (D-8) |

Steady-state total ≤ **30** connections (web 10 + worker 20); ≤ **31** during deploys while the single migration runner is connected (IN-05 — the runner is a one-shot deploy-time process, not steady-state; this mirrors the runbook §1 wording). **Assumption A4 — verify before Phase 3:** Neon `max_connections` ≈ 104 at the project's 0.25 CU tier [CITED: neon.com/docs via project research] — the operator must verify the tier. 31 / 104 leaves ≥ 70 % headroom for psql sessions, dashboards, and restart overlap (old + new process coexisting during a deploy).

### 25.2 pg Pool options (node-postgres 8.23; defaults from node-postgres.com/apis/pool)

| Option | Pinned value | node-postgres default | Rationale |
|---|---|---|---|
| `max` | per §25.1 (10 / 20 / 1) | 10 | the per-process budget itself |
| `connectionTimeoutMillis` | **10000** | **0 — no timeout** | The default means a client waits **forever** for a pool slot. A pinned nonzero timeout makes pool exhaustion fail fast (web: 503) instead of hanging requests — this must be pinned on every pool |
| `idleTimeoutMillis` | 10000 (documented; 0 disables — do not set 0) | 10000 | Releases idle server connections promptly so the budget tracks actual load |
| `statement_timeout` | 30000 on web + worker pools | none | Sized above the worst legitimate writer statement — the 5000-row retention-delete pass (§13.7) — and far above the Tier 1 transaction's individual statements (§16.1); kills runaway queries. Client-level option accepted via Pool config pass-through |
| `idle_in_transaction_session_timeout` | 30000 on web + worker pools | none | Reaps sessions stuck idle inside an open transaction (abandoned worker/request) so their locks and snapshots cannot pin the database. Client-level pass-through |
| `statement_timeout` (migration runner) | **unset — no limit** | none | `CREATE INDEX CONCURRENTLY` and backfill migrations legitimately run long; a statement timeout here would abort a migration mid-flight |

### 25.3 Pooled vs direct strings + ORM transition rule

- **Web → POOLED string** (provider pooler endpoint): short request-scoped statements multiplex well through transaction-mode pooling.
- **Worker and migration runner → DIRECT strings**: the worker's multi-statement Tier 1 transactions (§16.1) and the runner's DDL both need full connection semantics (D-8, N-10).
- **Transition rule (DRZ-05 / M-1):** during the Prisma→Drizzle transition (Phases 3–7) both ORMs share **one `pg` Pool per process** — the budget counts pools, not ORMs. Drizzle is adopted additively (new code uses Drizzle only) and the pair **never dual-writes** (out-of-scope table).

### 25.4 Budget pinning table (D-10)

| Parameter | Default | Rationale | Class |
|---|---|---|---|
| web pool `max` | 10 (POOLED) | DAT-09 | non-negotiable |
| worker pool `max` | 20 (DIRECT) | DAT-09 | non-negotiable |
| migration runner `max` | 1 (DIRECT) | DAT-09 / M-1 single runner | non-negotiable |
| `connectionTimeoutMillis` | 10000 | default 0 = no timeout; pool exhaustion must fail fast | non-negotiable to pin nonzero; the value is a default — tune in Phase 4/5 with data |
| `idleTimeoutMillis` | 10000 | node-postgres default retained | default |
| `statement_timeout` | 30000 (web + worker; unset for migrations) | sized above the worst legitimate writer (§13.7 batch delete) | default — tune in Phase 4/5 with data |
| `idle_in_transaction_session_timeout` | 30000 (web + worker) | reaps abandoned transactions | default — tune in Phase 4/5 with data |
| Neon `max_connections` | ~104 at 0.25 CU (assumption A4) | headroom math | assumption — operator verifies the tier |

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
