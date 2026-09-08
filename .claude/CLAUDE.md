<!-- GSD:project-start source:PROJECT.md -->

## Project

**SpiderNode Uptime Tracker — Backend Modernization**

SpiderNode is a live, production uptime-monitoring SaaS (Next.js 16 App Router, single VPS under PM2) that checks user-defined URLs on cron schedules, records pings/incidents in PostgreSQL, and alerts via Telegram. This milestone is a **backend/infrastructure modernization — no new user-facing features** — migrating to Drizzle ORM, Better Auth, Redis + BullMQ job orchestration, and a dedicated monitoring worker process, followed by Redux pruning, an AI SDK integration (flagged off), and a final visual redesign.

Authoritative source documents: `docs/ARCHITECTURE-AUDIT.md` (audit + target architecture, §1–24) and `docs/ARCHITECTURE-REVIEW.md` (NOT READY verdict, 14 blocking issues J/D/R/A/S/M/P, §9 pre-implementation checklist, §8 required design addenda).

**Core Value:** Modernize the infrastructure **without breaking existing monitoring functionality** — the monitoring engine must never lose or corrupt uptime data, silently stop checking, or lock users out irrecoverably. Every migration step ships revertibly with monitoring continuity preserved (audit M3 overlap window).

### Constraints

- **Tech stack (target):** Next.js 16.3 App Router · Drizzle ORM · Better Auth · PostgreSQL (unchanged, source of truth) · Redis + BullMQ · dedicated Node worker process · Redux Toolkit + Redux Persist (pruned) · Tailwind v4, shadcn/ui, Hugeicons, Sonner, Radix UI, Framer Motion · Vercel AI SDK (off critical path) · multi-provider email abstraction · pnpm
- **Hard constraints:** the eight binding requirements listed under Active above (audit rules 1–20 traceable in audit Appendix B)
- **Review gate:** all §9 checklist items resolved in design before implementation (verdict READY)
- **Behavior compatibility:** monitoring semantics preserved through cutover — 1-strike DOWN, lifetime uptime math, Telegram alert content, public API shapes
- **Deployment:** single VPS, two PM2 apps, forward-only additive-first migrations, health gates (`readyz`) before a release counts as good
- **Forced re-login at auth cutover:** accepted consequence (M2/D6), announced (Q-4)
- **Manual check UX:** becomes enqueue + optimistic read + poll, per-user rate limited (Q-5)

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript 5 - All application code in `src/`
- JavaScript (Node) - Tooling scripts at repo root (`test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`, `ecosystem.config.js`)
- CSS - `src/app/globals.css` (Tailwind v4 + global sidebar CSS variables)
- Prisma DSL - `prisma/schema.prisma`

## Runtime

- Node.js (LTS; `@types/node` ^20). Build uses `NODE_OPTIONS="--max_old_space_size=2048"` (see `package.json` build script)
- Runs on a VPS managed by PM2 (`ecosystem.config.js`, app name `uptime-tracker`, cwd `/var/www/uptime-tracker`)
- Vercel Cron is optionally used as external scheduler (`CRON_MODE=vercel`)
- npm
- Lockfile: `package-lock.json` (present)

## Frameworks

- Next.js ^16.0.10 (App Router) - Full-stack framework; API routes under `src/app/api/`, route groups `(authLayout)`, `(commonLayout)`, `(dashboardLayout)`
- React ^19.2.3 + React DOM - UI runtime; React Compiler enabled via Babel plugin (`babel-plugin-react-compiler`) and `reactCompiler: true` in `next.config.ts`
- NextAuth (next-auth ^4.24.15) - Auth with JWT session strategy (`src/lib/auth.ts`)
- Redux Toolkit ^2.9.2 + react-redux ^9.2.0 + redux-persist ^6.0.0 (`src/redux/store.ts`, `src/redux/features/`, `src/redux/api/baseApi.ts`)
- No test framework detected. Only ad-hoc Node scripts at root (`test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`)
- Next.js CLI (`next dev -p 3007`, `next build`, `next start -p 3007`)
- Prisma CLI ^7.9.1 (build runs `npx prisma generate` first; config in `prisma.config.ts`)
- ESLint 9 + eslint-config-next (`eslint.config.mjs`)
- PostCSS via `@tailwindcss/postcss` (`postcss.config.mjs`)

## Key Dependencies

- `@prisma/client` ^7.9.1 + `prisma` ^7.9.1 - ORM; client generated to `src/generated/prisma`; driver adapter preview feature enabled
- `@prisma/adapter-pg` ^7.9.1 + `pg` ^8.22.0 - Prisma Pg driver adapter with connection Pool (`src/lib/prisma.ts`)
- `next-auth` ^4.24.15 + `@auth/prisma-adapter` ^2.11.3 - Auth (Google, GitHub, credentials) (`src/lib/auth.ts`)
- `node-cron` ^4.6.0 - Internal 1-minute monitor check scheduler (`src/instrumentation.ts`)
- `nodemailer` ^7.0.13 - SMTP email alerts with HTML templates (`src/lib/mail.ts`)
- `bcryptjs` ^3.0.3 - Password hashing in credentials login (`src/lib/auth.ts`)
- Tailwind CSS v4 + `tailwind-merge` + `clsx` + `class-variance-authority` + `tw-animate-css` (shadcn-style setup, `components.json`)
- Radix UI (`radix-ui` ^1.6.2, `@radix-ui/react-dialog`, `@radix-ui/react-slot`)
- `motion` ^12 (animation), `sonner` (toasts), `sweetalert2`, `hugeicons-react`, `react-icons`, `@lottiefiles/dotlottie-react`
- `react-hook-form` ^7.71.1
- `cloudinary` ^2.10.0 - Profile image uploads (`src/app/api/user/profile/route.ts`)
- `js-cookie`, `uuid`

## Configuration

- `.env` files present (contents not read). Key vars used in code: `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `SMTP_HOST/PORT/USER/PASS`, `TELEGRAM_BOT_TOKEN`, `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`, `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET`, `CRON_SECRET`, `CRON_MODE`, `HC_PING_URL`, `NEXT_PUBLIC_ENV`, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_DEV_BASE_URL`
- `next.config.ts` is the active config (`reactCompiler: true`, `typescript: { ignoreBuildErrors: true }`). Stale duplicates exist: `next.config.js`, `next.config.mjs`
- `tsconfig.json`, `prisma.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json` (shadcn)
- `src/proxy.ts` - auth middleware (NextAuth JWT check; note: named `proxy.ts` not `middleware.ts`)

## Platform Requirements

- Node 20+, npm; Postgres database reachable via `DATABASE_URL`; ngrok config present at root for Telegram webhook local testing (`ngrok`, `ngrok.log`)
- Linux VPS behind PM2 (`ecosystem.config.js`), port 3007; optional Vercel Cron calling `/api/cron/check` with `CRON_SECRET`; healthchecks.io dead-man's-switch ping via `HC_PING_URL`

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- Components: PascalCase `.tsx` (`src/components/Dashboard/Dashboard.tsx`, `src/components/Auth/LoginForm.tsx`)
- shadcn/ui primitives: kebab-case `.tsx` (`src/components/ui/dropdown-menu.tsx`, `src/components/ui/sidebar.tsx`)
- Non-component modules: camelCase or kebab-case (`.ts` (`src/lib/rate-limit.ts`, `src/lib/db-batcher.ts`, `src/lib/cleanup-logic.ts`)
- API routes: Next.js convention `route.ts` inside `src/app/api/<resource>/route.ts` (dynamic segments use `[id]`)
- Redux slices: camelCase `*Slice.ts` (`src/redux/features/auth/authSlice.ts`)
- Exported React components: PascalCase named function exports (`export function useIsMobile`, `export default function Dashboard`)
- Route handlers: uppercase HTTP verb exports (`export async function GET`, `PATCH`, `DELETE` in `src/app/api/user/profile/route.ts`)
- Helpers/utilities: camelCase (`cn` in `src/lib/utils.ts`)
- camelCase for locals/state; UPPER_SNAKE for constants (`MOBILE_BREAKPOINT` in `src/hooks/use-mobile.ts`)
- Interfaces/types PascalCase; type declarations in `src/types/` (e.g. `src/types/next-auth.d.ts` module augmentation); Prisma client generated at `src/generated/prisma`

## Code Style

- No Prettier config detected; style follows `eslint-config-next` defaults
- Mixed quoting: lib/redux files use double quotes semicolon-terminated; API routes frequently use single quotes without semicolons — match the file you edit
- 2-space indent throughout
- ESLint 9 flat config: `eslint.config.mjs` (extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`)
- Run: `npm run lint`
- `tsconfig.json`: `strict: true`, `noEmit`, `moduleResolution: bundler`, path alias `@/*` → `./src/*`
- React Compiler enabled via `babel-plugin-react-compiler`

## Import Organization

- `@/*` → `./src/*` (use this for all cross-directory imports)
- Relative imports used for generated Prisma client (`'../generated/prisma'` in `src/lib/prisma.ts`)

## Component Conventions

- Interactive components start with `"use client";` (first line, e.g. `src/components/Dashboard/Dashboard.tsx`)
- API route handlers are server by default; no `"use server"` actions in use
- shadcn/ui pattern: components in `src/components/ui/` composed with `cn()` from `src/lib/utils.ts` (clsx + tailwind-merge)
- Project skill `.claude/skills/shadcn/SKILL.md` — use `npx shadcn@latest` to add/search components; prefer composing existing ui primitives before writing new ones
- Tailwind CSS v4 with `tw-animate-css` (see also `.claude/skills/tailwind-design-system`)
- `react-hook-form` with custom inputs in `src/components/form/MyFormInput.tsx`
- Redux Toolkit: store in `src/redux/store.ts`, RTK Query base API in `src/redux/api/baseApi.ts` (`fetchBaseQuery`, `credentials: "include"`, Authorization header from `state.auth.token`), slices in `src/redux/features/<name>/`, selectors exported next to slices (`selectCurrentUser`)
- `redux-persist` wired via `src/redux/Provider.tsx`
- NextAuth session via `getServerSession(authOptions)` on server (`src/lib/auth.ts`)

## Server-Side Patterns

- Singleton client in `src/lib/prisma.ts` using driver adapter `PrismaPg` with a `pg` `Pool`, cached on `global` for dev HMR — always import `prisma` from `@/lib/prisma`, never instantiate `PrismaClient` directly
- Prisma skills available: `.claude/skills/prisma-*` (client API, driver adapters, upgrade v7)
- Section banner comments (`// 1. GET CURRENT USER PROFILE (GET)`) separate multiple handlers per file
- Always use explicit Prisma `select` to avoid leaking fields (password excluded via destructuring + `hasPassword` boolean flag)

## Error Handling

- API routes: try/catch wrapping the whole handler, `console.error("<Handler name>:", error)` then `NextResponse.json({ error: "..." }, { status: 500 })`
- Validation errors return 400 with descriptive `{ error }` payloads
- Next.js error boundaries: `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/not-found.tsx`
- Startup validation pattern: throw at module load if env missing (`src/redux/api/baseApi.ts` lines 9–11)

## Logging

- Server: `console.error("<Context> Error:", error)` in catch blocks
- Prisma dev logging: `log: ['query', 'error', 'warn']` in development, `['error']` in production (`src/lib/prisma.ts`)
- Never log secrets/passwords (see `test-email.js` comment)

## Comments

- Section dividers in larger route files (`// -------------------`)
- Bangla-language inline comments exist in places (`src/lib/prisma.ts`); new comments should be English
- Not used; comment style is plain `//` line comments

## Toasts / User Feedback

- `sonner` (`toast.*`) is the primary toast API (~71 usages across `src/components/**`)
- `sweetalert2` (`Swal`) used in older flows (e.g. `src/components/common/DeleteModal.tsx`) — prefer `sonner` for new code
- Confirm-destructive-action modal pattern: `src/components/common/DeleteModal.tsx`

## Function Design

- Client components are large page-level compositions (800+ lines in `src/components/Dashboard/Dashboard.tsx`); extract subcomponents when adding features
- Shared display logic lives in `src/components/Dashboard/` and `src/components/Status/`
- Cron/background logic is factored into plain modules (`src/lib/cron-logic.ts`, `src/lib/cleanup-logic.ts`, `src/lib/db-batcher.ts`) invoked from `src/app/api/cron/*/route.ts`

## Module Design

- Components: named or default export (both in use); shadcn primitives use named exports
- Slices: default-export reducer + named action/selectors (`src/redux/features/auth/authSlice.ts`)
- Lib modules: named exports (`prisma`, `authOptions`, `cn`)
- No barrel files (`index.ts` re-exports not used)

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

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

- All API authorization via `getServerSession(authOptions)` per-route (see `src/app/api/monitors/route.ts:11`)
- Dual-cron strategy controlled by `CRON_MODE` env (`internal` node-cron vs `vercel` external cron) — `src/instrumentation.ts`
- Write batching: routine pings held in module-level memory arrays and flushed every 15 min or on cron-route completion (`src/lib/db-batcher.ts`)
- Route groups by shell: `(authLayout)`, `(commonLayout)` public pages, `(dashboardLayout)` app pages
- `src/components/ui/*` are shadcn-style primitives; feature components in `src/components/{Dashboard,Auth,...}`

## Layers

- Purpose: Pages and interactive components
- Location: `src/app/**/page.tsx`, `src/components/`
- Contains: Client components ("use client"), form wrappers in `src/components/form/`
- Depends on: `next-auth/react` session hooks, Redux store, `/api` endpoints
- Used by: Browser
- Purpose: REST endpoints (route.ts handlers)
- Location: `src/app/api/**/route.ts`
- Contains: Session checks, validation, rate limiting, Prisma calls
- Depends on: `src/lib/*`
- Used by: Client components, cron systems
- Purpose: Reusable business logic (checks, batching, alerts, cleanup)
- Location: `src/lib/`
- Depends on: Prisma, external services (Telegram, SMTP, healthchecks.io)
- Used by: API routes and `src/instrumentation.ts` (via dynamic `import()`)
- Purpose: Persistence
- Location: `src/lib/prisma.ts`, `prisma/schema.prisma`, generated client at `src/generated/prisma`
- Contains: PrismaClient with `PrismaPg` driver adapter over a `pg.Pool`

## Data Flow

### Monitor Check Path (primary)

### Client Request Path

- Server: NextAuth JWT sessions (strategy `"jwt"`, `src/lib/auth.ts:12`)
- Client: Redux Toolkit (`src/redux/store.ts`) with redux-persist whitelist `["auth"]` (`src/redux/features/auth/authSlice.ts`); most dashboard data is fetched ad hoc, not cached in Redux

## Key Abstractions

- Pattern: global-cached client + pool to survive Next HMR
- Example: `src/lib/prisma.ts`
- Purpose: Amortize DB writes for high-frequency routine pings
- Examples: `src/lib/db-batcher.ts` (`queueRoutineCheck`, `flushBatches`)
- Pattern: module-level `pendingPings: any[]` + `pendingMonitorUpdates: Map` — per-process only; data lost if process crashes between flushes
- `CRON_MODE=vercel` disables internal cron; otherwise node-cron is primary
- Example: `src/instrumentation.ts`
- `(authLayout)`, `(commonLayout)`, `(dashboardLayout)` each define a `layout.tsx` wrapping distinct chrome (e.g. `src/components/dashboardLayout/AppSidebar.tsx`)

## Entry Points

## Architectural Constraints

- **Threading:** Single Node.js process per PM2 app; the batcher and rate limiter are in-memory and per-process — they break under horizontal scaling or serverless (flush-on-request in `/api/cron/check` partially compensates)
- **Global state:** `src/lib/db-batcher.ts` (pending queues), `src/lib/rate-limit.ts` (limiter store), `src/lib/prisma.ts` (singleton)
- **Runtime:** instrumentation and node-cron require Node.js runtime; not deployable as edge/serverless-only
- **Generated code:** Prisma client output is `src/generated/prisma` (gitignored; regenerated by `npm run build` via `prisma generate`)

## Anti-Patterns

### Business logic inline in route handlers

### Error responses leaking stack traces

## Error Handling

- 401 for missing session, 400 for validation, 403 for monitor-limit (10 free tier), 429 for rate limit
- Cron failures ping `HC_PING_URL/fail` to healthchecks.io dead-man's switch

## Cross-Cutting Concerns

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

| Skill | Description | Path |
|-------|-------------|------|
| better-auth-best-practices | Configure Better Auth server and client, set up database adapters, manage sessions, add plugins, and handle environment variables. Use when users mention Better Auth, betterauth, auth.ts, or need to set up TypeScript authentication with email/password, OAuth, or plugin configuration. | `.agents/skills/better-auth-best-practices/SKILL.md` |
| better-auth-security-best-practices | Configure rate limiting, manage auth secrets, set up CSRF protection, define trusted origins, secure sessions and cookies, encrypt OAuth tokens, track IP addresses, and implement audit logging for Better Auth. Use when users need to secure their auth setup, prevent brute force attacks, or harden a Better Auth deployment. | `.agents/skills/better-auth-security-best-practices/SKILL.md` |
| create-auth | Scaffold and implement authentication in TypeScript/JavaScript apps using Better Auth. Detect frameworks, configure database adapters, set up route handlers, add OAuth providers, and create auth UI pages. Use when users want to add login, sign-up, or authentication to a new or existing project with Better Auth. | `.agents/skills/create-auth/SKILL.md` |
| email-and-password-best-practices | Configure email verification, implement password reset flows, set password policies, and customise hashing algorithms for Better Auth email/password authentication. Use when users need to set up login, sign-in, sign-up, credential authentication, or password security with Better Auth. | `.agents/skills/email-and-password-best-practices/SKILL.md` |
| iris-development | Iris is Redis's umbrella for AI-focused products. Use this skill when integrating with the Iris Redis Agent Memory (RAM) data plane on Redis Cloud — recording session events for an AI agent, creating or searching long-term memories, configuring a memory store, or tuning background memory promotion. Code examples use the official `redis-agent-memory` (Python) and `@redis-iris/agent-memory` (TypeScript) SDKs. | `.agents/skills/iris-development/SKILL.md` |
| migrate-radix-to-base | Migrates React projects and components from Radix UI to Base UI. Use when asked to migrate from radix, move to base-ui, convert radix primitives, or switch a shadcn project's base library. Handles single components ("migrate accordion") and whole projects. | `.agents/skills/migrate-radix-to-base/SKILL.md` |
| organization-best-practices | Configure multi-tenant organizations, manage members and invitations, define custom roles and permissions, set up teams, and implement RBAC using Better Auth's organization plugin. Use when users need org setup, team management, member roles, access control, or the Better Auth organization plugin. | `.agents/skills/organization-best-practices/SKILL.md` |
| redis-clustering | Redis Cluster and replication guidance covering hash tags for multi-key operations, avoiding CROSSSLOT errors, and reading from replicas to scale read-heavy workloads. Use when designing keys for a sharded Redis Cluster, debugging CROSSSLOT errors on MGET / SDIFF / pipelines, configuring a multi-key transaction in a cluster, or routing reads to replicas for caches, analytics, or dashboards. | `.agents/skills/redis-clustering/SKILL.md` |
| redis-connections | Redis client and connection guidance covering connection pooling, multiplexing, pipelining, client-side caching with RESP3, avoiding slow commands (KEYS, SMEMBERS, HGETALL), and tuning socket timeouts. Use when configuring a Redis client (redis-py, Jedis, Lettuce, NRedisStack), batching commands for throughput, eliminating per-request connection creation, iterating large keyspaces with SCAN, enabling client-side caching for read-heavy workloads, or setting connect and read timeouts. | `.agents/skills/redis-connections/SKILL.md` |
| redis-core | Core Redis modeling guidance — choose the right data structure (String, Hash, List, Set, Sorted Set, JSON, Stream, Vector Set) and use consistent colon-separated key names. Use when designing a Redis data model, caching objects, deciding between Hash and JSON, building counters, leaderboards, membership sets, or session stores, or when reviewing/cleaning up Redis key naming. | `.agents/skills/redis-core/SKILL.md` |
| redis-observability | Redis observability guidance — which metrics to monitor (memory, connections, hit ratio, ops/sec, rejected connections), which built-in commands to reach for during incident triage (SLOWLOG, INFO, MEMORY DOCTOR, CLIENT LIST, FT.PROFILE), and when to use the Redis Insight GUI. Use when setting up monitoring or alerts for a Redis instance, diagnosing a performance regression, profiling a slow FT.SEARCH query, or wiring Redis metrics into Prometheus, Datadog, or similar. | `.agents/skills/redis-observability/SKILL.md` |
| redis-search | Redis Search guidance covering FT.CREATE schema design, field type selection (TEXT, TAG, NUMERIC, GEO, GEOSHAPE, VECTOR, JSON path), DIALECT 2 query syntax, FT.SEARCH / FT.AGGREGATE / FT.HYBRID command selection, vector similarity with HNSW or FLAT, hybrid retrieval combining lexical and vector ranking, RAG pipelines, zero-downtime index updates via aliases, and debugging with FT.PROFILE and FT.EXPLAIN. Use when defining a search index on Hash or JSON documents, writing FT.SEARCH queries with filters, sorting, aggregation, or vector KNN, tuning HNSW parameters, building a RAG retrieval pipeline, or troubleshooting slow or empty search results. | `.agents/skills/redis-search/SKILL.md` |
| redis-security | Redis security guidance covering authentication (requirepass and ACL users), TLS, ACL-based least-privilege access control, restricting network exposure via bind and protected-mode, firewall rules, and disabling dangerous commands. Use when deploying Redis to production, defining ACL users for an application, configuring TLS connections, locking down a Redis instance behind a firewall, or auditing a Redis deployment for security hardening. | `.agents/skills/redis-security/SKILL.md` |
| redis-semantic-cache | Redis LangCache guidance for semantic caching of LLM responses on Redis Cloud — calling search/set via the SDK or REST API, tuning the similarity threshold, separating caches per task type, and filtering with custom attributes. Use when caching LLM completions or RAG answers to cut API cost and latency, building a cache-aside layer in front of OpenAI / Anthropic / etc., tuning hit rate vs precision, or splitting one app's LLM workloads into multiple LangCache caches. | `.agents/skills/redis-semantic-cache/SKILL.md` |
| shadcn | Manages shadcn components and projects — adding, searching, fixing, debugging, styling, and composing UI, including chat interfaces. Provides project context, component docs, and usage examples. Applies when working with shadcn/ui, component registries, presets, --preset codes, or any project with a components.json file. Also triggers for "shadcn init", "create an app with --preset", or "switch to --preset". | `.agents/skills/shadcn/SKILL.md` |
| tailwind-design-system | Build scalable design systems with Tailwind CSS v4, design tokens, component libraries, and responsive patterns. Use when creating component libraries, implementing design systems, or standardizing UI patterns. | `.agents/skills/tailwind-design-system/SKILL.md` |
| two-factor-authentication-best-practices | Configure TOTP authenticator apps, send OTP codes via email/SMS, manage backup codes, handle trusted devices, and implement 2FA sign-in flows using Better Auth's twoFactor plugin. Use when users need MFA, multi-factor authentication, authenticator setup, or login security with Better Auth. | `.agents/skills/two-factor-authentication-best-practices/SKILL.md` |
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `$gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `$gsd-debug` for investigation and bug fixing
- `$gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `$gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
