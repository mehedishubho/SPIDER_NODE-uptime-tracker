<!-- refreshed: 2026-09-08 -->
# Architecture

**Analysis Date:** 2026-09-08

## System Overview

SpiderNode — a Next.js 16 (App Router) uptime monitoring SaaS. Monitors websites/APIs on cron schedules, records pings and incidents in PostgreSQL via Prisma, and alerts users via email (Nodemailer) and Telegram.

```text
┌───────────────────────────────────────────────────────────────────────┐
│                        UI Layer (React 19 Client Components)          │
│  Landing: `(commonLayout)`   Auth: `(authLayout)`   App: `(dashboardLayout)` │
│  Components: `src/components/{Dashboard,Auth,Pages,home,common,ui}`   │
├──────────────────────────┬────────────────────┬───────────────────────┤
│  Redux Toolkit store     │  NextAuth session  │  Fetch calls to       │
│  `src/redux/`            │  `src/providers/`  │  `/api/*` routes      │
├──────────────────────────┴────────────────────┴───────────────────────┤
│                     API Layer (Route Handlers)                        │
│  `src/app/api/{monitors,incidents,status,user,feedback,telegram,     │
│                auth,cron}/.../route.ts`                               │
├───────────────────────────────────────────────────────────────────────┤
│                     Service / Domain Layer                            │
│  `src/lib/cron-logic.ts` (checks) · `src/lib/db-batcher.ts` (write   │
│  batching) · `src/lib/telegram.ts` · `src/lib/mail.ts` ·             │
│  `src/lib/cleanup-logic.ts` · `src/lib/rate-limit.ts` · `src/lib/auth.ts` │
├───────────────────────────────────────────────────────────────────────┤
│                     Data Layer                                         │
│  Prisma Client (singleton) `src/lib/prisma.ts` → PostgreSQL          │
│  Schema: `prisma/schema.prisma` (User, Monitor, Ping, Incident,       │
│  Feedback, Account, Session, VerificationToken)                       │
└───────────────────────────────────────────────────────────────────────┘

Background scheduling (VPS runtime only):
  `src/instrumentation.ts` (node-cron: check every 1m, flush every 15m,
  cleanup daily) ─ OR ─ external Vercel Cron → `GET /api/cron/check`
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Root layout | Fonts, global dark theme, AuthProvider + ReduxProvider + Toaster | `src/app/layout.tsx` |
| Instrumentation | node-cron registration (checks/flush/cleanup), healthchecks.io heartbeat, graceful shutdown | `src/instrumentation.ts` |
| Proxy (middleware) | JWT gate — unauthenticated users redirected to `/login?callbackUrl=...` | `src/proxy.ts` |
| Auth config | NextAuth options: credentials + Google + GitHub, JWT sessions, PrismaAdapter | `src/lib/auth.ts` |
| Prisma singleton | Pool + PrismaPg driver adapter, HMR-safe global caching | `src/lib/prisma.ts` |
| Cron engine | Fetch all due monitors, ping with 10s timeout, compute status/stats, create incidents, send alerts | `src/lib/cron-logic.ts` |
| DB batcher | In-memory queue for routine pings + monitor stat updates; `flushBatches()` writes in bulk | `src/lib/db-batcher.ts` |
| Cleanup | Daily purge of old ping/incident data | `src/lib/cleanup-logic.ts` |
| Telegram bot | Alert delivery + webhook handling | `src/lib/telegram.ts` |
| Rate limiter | In-memory per-IP fixed-window limiter | `src/lib/rate-limit.ts` |
| Redux store | RTK + redux-persist (auth slice persisted) | `src/redux/store.ts` |
| RTK base API | fetchBaseQuery with credentials + auth token header | `src/redux/api/baseApi.ts` |

## Pattern Overview

**Overall:** Next.js App Router monolith with route-handler REST API, thin client components calling `/api/*` with `fetch`, and a service layer in `src/lib/` shared between cron and API routes.

**Key Characteristics:**
- All API authorization via `getServerSession(authOptions)` per-route (see `src/app/api/monitors/route.ts:11`)
- Dual-cron strategy controlled by `CRON_MODE` env (`internal` node-cron vs `vercel` external cron) — `src/instrumentation.ts`
- Write batching: routine pings held in module-level memory arrays and flushed every 15 min or on cron-route completion (`src/lib/db-batcher.ts`)
- Route groups by shell: `(authLayout)`, `(commonLayout)` public pages, `(dashboardLayout)` app pages
- `src/components/ui/*` are shadcn-style primitives; feature components in `src/components/{Dashboard,Auth,...}`

## Layers

**UI Layer:**
- Purpose: Pages and interactive components
- Location: `src/app/**/page.tsx`, `src/components/`
- Contains: Client components ("use client"), form wrappers in `src/components/form/`
- Depends on: `next-auth/react` session hooks, Redux store, `/api` endpoints
- Used by: Browser

**API Layer:**
- Purpose: REST endpoints (route.ts handlers)
- Location: `src/app/api/**/route.ts`
- Contains: Session checks, validation, rate limiting, Prisma calls
- Depends on: `src/lib/*`
- Used by: Client components, cron systems

**Service/Domain Layer:**
- Purpose: Reusable business logic (checks, batching, alerts, cleanup)
- Location: `src/lib/`
- Depends on: Prisma, external services (Telegram, SMTP, healthchecks.io)
- Used by: API routes and `src/instrumentation.ts` (via dynamic `import()`)

**Data Layer:**
- Purpose: Persistence
- Location: `src/lib/prisma.ts`, `prisma/schema.prisma`, generated client at `src/generated/prisma`
- Contains: PrismaClient with `PrismaPg` driver adapter over a `pg.Pool`

## Data Flow

### Monitor Check Path (primary)

1. Trigger: node-cron every minute (`src/instrumentation.ts:35`) or Vercel Cron `GET /api/cron/check` (`src/app/api/cron/check/route.ts:4`)
2. Secret validation (`CRON_SECRET` bearer/query) for the HTTP path
3. `runCronChecks(force)` fetches active monitors + user telegram info, filters by interval due (`src/lib/cron-logic.ts:8`)
4. `Promise.allSettled` pings each URL with `AbortController` 10s timeout (`src/lib/cron-logic.ts:55-74`)
5. Status change → immediate DB write + incident create + Telegram alert; no change → `queueRoutineCheck()` memory queue
6. HTTP path flushes batches immediately (`src/app/api/cron/check/route.ts:35`); internal cron flushes every 15 min

### Client Request Path

1. Page/component in `src/components/Dashboard/*` calls `fetch('/api/monitors', ...)`
2. `src/proxy.ts` middleware enforces JWT on navigations
3. Route handler validates session (`getServerSession`), rate limits, queries Prisma
4. JSON response rendered by client component

**State Management:**
- Server: NextAuth JWT sessions (strategy `"jwt"`, `src/lib/auth.ts:12`)
- Client: Redux Toolkit (`src/redux/store.ts`) with redux-persist whitelist `["auth"]` (`src/redux/features/auth/authSlice.ts`); most dashboard data is fetched ad hoc, not cached in Redux

## Key Abstractions

**Prisma singleton with driver adapter:**
- Pattern: global-cached client + pool to survive Next HMR
- Example: `src/lib/prisma.ts`

**In-memory write batcher:**
- Purpose: Amortize DB writes for high-frequency routine pings
- Examples: `src/lib/db-batcher.ts` (`queueRoutineCheck`, `flushBatches`)
- Pattern: module-level `pendingPings: any[]` + `pendingMonitorUpdates: Map` — per-process only; data lost if process crashes between flushes

**Dual-cron orchestration:**
- `CRON_MODE=vercel` disables internal cron; otherwise node-cron is primary
- Example: `src/instrumentation.ts`

**Route-group layout shells:**
- `(authLayout)`, `(commonLayout)`, `(dashboardLayout)` each define a `layout.tsx` wrapping distinct chrome (e.g. `src/components/dashboardLayout/AppSidebar.tsx`)

## Entry Points

**App:** `src/app/layout.tsx` → route-group layouts → pages
**API:** `src/app/api/**/route.ts` (NextAuth at `src/app/api/auth/[...nextauth]/route.ts`)
**Background:** `src/instrumentation.ts` `register()` — runs once at server boot on Node.js runtime
**Middleware:** `src/proxy.ts` (Next 16's renamed middleware)
**Process manager:** `ecosystem.config.js` (PM2, production on `/var/www/uptime-tracker`, port 3007)

## Architectural Constraints

- **Threading:** Single Node.js process per PM2 app; the batcher and rate limiter are in-memory and per-process — they break under horizontal scaling or serverless (flush-on-request in `/api/cron/check` partially compensates)
- **Global state:** `src/lib/db-batcher.ts` (pending queues), `src/lib/rate-limit.ts` (limiter store), `src/lib/prisma.ts` (singleton)
- **Runtime:** instrumentation and node-cron require Node.js runtime; not deployable as edge/serverless-only
- **Generated code:** Prisma client output is `src/generated/prisma` (gitignored; regenerated by `npm run build` via `prisma generate`)

## Anti-Patterns

### Business logic inline in route handlers

**What happens:** Validation, limits, and Prisma queries live directly in `src/app/api/monitors/route.ts` etc.
**Why it's wrong:** Logic can't be reused; cron and API paths duplicate patterns.
**Do this instead:** Extract monitor CRUD operations into `src/lib/` modules (as was done for cron in `src/lib/cron-logic.ts`).

### Error responses leaking stack traces

**What happens:** `src/app/api/cron/check/route.ts:45` returns `err.stack` to the client.
**Why it's wrong:** Information disclosure in production.
**Do this instead:** Log details server-side, return only a message.

## Error Handling

**Strategy:** try/catch per handler with `NextResponse.json({error}, {status})`; `console.error`/`console.log` logging; global React error boundaries at `src/app/error.tsx` and `src/app/global-error.tsx`.

**Patterns:**
- 401 for missing session, 400 for validation, 403 for monitor-limit (10 free tier), 429 for rate limit
- Cron failures ping `HC_PING_URL/fail` to healthchecks.io dead-man's switch

## Cross-Cutting Concerns

**Logging:** `console.log/error` only (emoji-prefixed in instrumentation); no structured logger
**Validation:** Manual inline checks (`new URL(url)`, field presence); no schema validator (react-hook-form on client only)
**Authentication:** NextAuth JWT + credentials/Google/GitHub; email verification gate before login (`src/lib/auth.ts:47`); bcrypt password hashing; API-token helpers in `src/lib/tokens.ts`

---

*Architecture analysis: 2026-09-08*
