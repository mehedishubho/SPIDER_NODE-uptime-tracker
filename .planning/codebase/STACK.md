# Technology Stack

**Analysis Date:** 2026-09-08

## Languages

**Primary:**
- TypeScript 5 - All application code in `src/`
- JavaScript (Node) - Tooling scripts at repo root (`test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`, `ecosystem.config.js`)

**Secondary:**
- CSS - `src/app/globals.css` (Tailwind v4 + global sidebar CSS variables)
- Prisma DSL - `prisma/schema.prisma`

## Runtime

**Environment:**
- Node.js (LTS; `@types/node` ^20). Build uses `NODE_OPTIONS="--max_old_space_size=2048"` (see `package.json` build script)
- Runs on a VPS managed by PM2 (`ecosystem.config.js`, app name `uptime-tracker`, cwd `/var/www/uptime-tracker`)
- Vercel Cron is optionally used as external scheduler (`CRON_MODE=vercel`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- Next.js ^16.0.10 (App Router) - Full-stack framework; API routes under `src/app/api/`, route groups `(authLayout)`, `(commonLayout)`, `(dashboardLayout)`
- React ^19.2.3 + React DOM - UI runtime; React Compiler enabled via Babel plugin (`babel-plugin-react-compiler`) and `reactCompiler: true` in `next.config.ts`
- NextAuth (next-auth ^4.24.15) - Auth with JWT session strategy (`src/lib/auth.ts`)

**State Management:**
- Redux Toolkit ^2.9.2 + react-redux ^9.2.0 + redux-persist ^6.0.0 (`src/redux/store.ts`, `src/redux/features/`, `src/redux/api/baseApi.ts`)

**Testing:**
- No test framework detected. Only ad-hoc Node scripts at root (`test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`)

**Build/Dev:**
- Next.js CLI (`next dev -p 3007`, `next build`, `next start -p 3007`)
- Prisma CLI ^7.9.1 (build runs `npx prisma generate` first; config in `prisma.config.ts`)
- ESLint 9 + eslint-config-next (`eslint.config.mjs`)
- PostCSS via `@tailwindcss/postcss` (`postcss.config.mjs`)

## Key Dependencies

**Critical:**
- `@prisma/client` ^7.9.1 + `prisma` ^7.9.1 - ORM; client generated to `src/generated/prisma`; driver adapter preview feature enabled
- `@prisma/adapter-pg` ^7.9.1 + `pg` ^8.22.0 - Prisma Pg driver adapter with connection Pool (`src/lib/prisma.ts`)
- `next-auth` ^4.24.15 + `@auth/prisma-adapter` ^2.11.3 - Auth (Google, GitHub, credentials) (`src/lib/auth.ts`)
- `node-cron` ^4.6.0 - Internal 1-minute monitor check scheduler (`src/instrumentation.ts`)
- `nodemailer` ^7.0.13 - SMTP email alerts with HTML templates (`src/lib/mail.ts`)
- `bcryptjs` ^3.0.3 - Password hashing in credentials login (`src/lib/auth.ts`)

**UI:**
- Tailwind CSS v4 + `tailwind-merge` + `clsx` + `class-variance-authority` + `tw-animate-css` (shadcn-style setup, `components.json`)
- Radix UI (`radix-ui` ^1.6.2, `@radix-ui/react-dialog`, `@radix-ui/react-alert-dialog`, `@radix-ui/react-slot`)
- `motion` ^12 (animation), `sonner` (toasts), `hugeicons-react` (the single icon system — react-icons/sweetalert2/lucide-react deleted and gate-banned at 08-02), `@lottiefiles/dotlottie-react`
- `react-hook-form` ^7.71.1

**Infrastructure:**
- `cloudinary` ^2.10.0 - Profile image uploads (`src/app/api/user/profile/route.ts`)
- `js-cookie`, `uuid`

## Configuration

**Environment:**
- `.env` files present (contents not read). Key vars used in code: `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `SMTP_HOST/PORT/USER/PASS`, `TELEGRAM_BOT_TOKEN`, `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`, `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET`, `CRON_SECRET`, `CRON_MODE`, `HC_PING_URL`, `NEXT_PUBLIC_ENV`, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_DEV_BASE_URL`

**Build:**
- `next.config.ts` is the active config (`reactCompiler: true`, `typescript: { ignoreBuildErrors: true }`). Stale duplicates exist: `next.config.js`, `next.config.mjs`
- `tsconfig.json`, `prisma.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json` (shadcn)

**Middleware:**
- `src/proxy.ts` - auth middleware (NextAuth JWT check; note: named `proxy.ts` not `middleware.ts`)

## Platform Requirements

**Development:**
- Node 20+, npm; Postgres database reachable via `DATABASE_URL`; ngrok config present at root for Telegram webhook local testing (`ngrok`, `ngrok.log`)

**Production:**
- Linux VPS behind PM2 (`ecosystem.config.js`), port 3007; optional Vercel Cron calling `/api/cron/check` with `CRON_SECRET`; healthchecks.io dead-man's-switch ping via `HC_PING_URL`

---

*Stack analysis: 2026-09-08*
