# External Integrations

**Analysis Date:** 2026-09-08

## APIs & External Services

**Telegram Bot API:**
- Outgoing alerts via `https://api.telegram.org/bot{token}/sendMessage` (HTML parse mode)
  - SDK/Client: raw `fetch` in `src/lib/telegram.ts` (`sendTelegramAlert`)
  - Auth: `TELEGRAM_BOT_TOKEN`
- Incoming webhook: `src/app/api/telegram/webhook/route.ts` handles `/start {userId}` to link `telegramChatId` to a User
- Connect flow: `src/app/api/telegram/connect/route.ts` (uses `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`); test: `src/app/api/telegram/test/`

**Google OAuth:**
- NextAuth GoogleProvider in `src/lib/auth.ts`
  - Auth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

**GitHub OAuth:**
- NextAuth GithubProvider in `src/lib/auth.ts`
  - Auth: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`

**Cloudinary:**
- Profile image upload from `src/app/api/user/profile/route.ts`
  - SDK/Client: `cloudinary` npm package
  - Auth: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

**Healthchecks.io (dead man's switch):**
- Pinged after each internal cron run in `src/instrumentation.ts` via `HC_PING_URL`

**Vercel Cron (optional external scheduler):**
- Calls `/api/cron/check` every minute when `CRON_MODE=vercel` (dual-cron strategy documented in `src/instrumentation.ts`)

## Data Storage

**Databases:**
- PostgreSQL
  - Connection: `DATABASE_URL`
  - Client: Prisma 7 with `PrismaPg` driver adapter over a shared `pg` Pool (`src/lib/prisma.ts`); schema in `prisma/schema.prisma` (models include User, Account, Session, Monitor, Feedback, Incident)
- Batched DB writes for monitor checks: `src/lib/db-batcher.ts`

**File Storage:**
- Cloudinary (profile images); otherwise local filesystem only

**Caching:**
- None. Rate limiting is in-memory `Map` per process (`src/lib/rate-limit.ts`)

## Authentication & Identity

**Auth Provider:**
- NextAuth v4 (custom, in `src/lib/auth.ts`)
  - JWT session strategy, PrismaAdapter, credentials (bcrypt password compare), Google and GitHub OAuth
  - Route protection via `src/proxy.ts` (next-auth/jwt `getToken`)

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry etc.); only `console.log`/`console.error` and healthchecks.io ping

**Logs:**
- PM2-managed console output; `ngrok.log` at repo root from local webhook testing

## CI/CD & Deployment

**Hosting:**
- Self-hosted Linux VPS (`/var/www/uptime-tracker`) via PM2 (`ecosystem.config.js`)

**CI Pipeline:**
- None detected

## Environment Configuration

**Required env vars:**
- `DATABASE_URL` - Postgres connection
- `NEXTAUTH_URL`, `NEXTAUTH_SECRET` - NextAuth
- `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` - OAuth
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` - email
- `TELEGRAM_BOT_TOKEN`, `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` - Telegram alerts
- `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` - image uploads
- `CRON_SECRET` - protects `/api/cron/check` and `/api/cron/cleanup`
- `CRON_MODE` (`internal` | `vercel`), `HC_PING_URL` - cron strategy
- `NEXT_PUBLIC_ENV`, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_DEV_BASE_URL` - Redux base API URL selection (`src/redux/api/baseApi.ts`)

**Secrets location:**
- `.env` file(s) at repo root (existence confirmed; contents not read)

## Webhooks & Callbacks

**Incoming:**
- `POST /api/telegram/webhook` - Telegram bot updates (`src/app/api/telegram/webhook/route.ts`)
- `GET /api/cron/check` - monitor checks, guarded by `CRON_SECRET` (`src/app/api/cron/check/route.ts`)
- `GET /api/cron/cleanup` - data cleanup, guarded by `CRON_SECRET` (`src/app/api/cron/cleanup/route.ts`)

**Internal API surface (Phase 8 addition, 08-10):**
- `POST /api/ai/post-mortem` - streaming incident post-mortem draft (`src/app/api/ai/post-mortem/route.ts`); session-guarded, per-user Redis rate limit (ai_drafts 10/h), input-capped (2000 chars), timeout-bound; flag-off (`AI_ENABLED` not "true") answers 404 before the body is read; copy-only — zero DB writes; ownership-scoped evidence via `src/lib/ai/guards.ts` guard chain + `src/lib/ai/log.ts` D-10 log line

**Outgoing:**
- Telegram sendMessage (alerts), SMTP email (alerts via `src/lib/mail.ts`), healthchecks.io ping
- AI provider HTTPS streaming via `src/lib/ai/providers/*` (`AI_API_KEY` → Z.ai GLM day-1 / OpenAI / Anthropic / custom OpenAI-compatible; web-process only — no AI import under `src/worker/**`, remnant-gate leg 14 enforces)

---

*Integration audit: 2026-09-08; AI route leg added 2026-10-01 (08-10)*
