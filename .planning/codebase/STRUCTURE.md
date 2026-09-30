# Codebase Structure

**Analysis Date:** 2026-09-08

## Directory Layout

```
devsroom-uptime-tracker/
├── prisma/                 # Prisma schema (schema.prisma); generated client → src/generated/prisma
├── public/                 # Static assets
├── root_images/            # README images
├── docs/                   # Documentation
├── src/
│   ├── app/                # Next.js App Router: pages, layouts, API routes
│   │   ├── (authLayout)/       # Auth pages: login, register, forgot/reset-password, verify-email
│   │   ├── (commonLayout)/     # Public pages: home, features/*, docs, terms, privacy, status
│   │   ├── (dashboardLayout)/  # Authed app: dashboard/{monitor/[id],incidents,status,profile}
│   │   ├── api/                # REST route handlers (see Key File Locations)
│   │   └── status/[id]/        # Public per-monitor status page
│   ├── assets/             # logo.png
│   ├── components/
│   │   ├── Auth/           # Auth form components (LoginForm, RegisterForm, ...)
│   │   ├── common/         # Navbar, Footer, Pagination, Spinner
│   │   ├── Dashboard/      # Feature components (Dashboard, Incidents, MonitorDetails,
│   │   │                   #   TelegramSettings, ProfileComponent, FeedbackButton, ...)
│   │   ├── dashboardLayout/ # App shell: AppHeader, AppSidebar, NavMain, NavUser, TeamSwitch
│   │   ├── Features/       # Marketing feature page content
│   │   ├── form/           # Reusable form controls (MyFormInput, MyFormSelect, MyFormWrapper, ...)
│   │   ├── home/           # Landing page sections (HeroSection, FeatureGrid, HowItWorks)
│   │   ├── Others/         # Loader, PageNotFound, UnderConstruction
│   │   ├── Pages/          # Static/legal page content (Terms, Privacy, SecuritySla, Status)
│   │   ├── Status/         # PublicStatus
│   │   └── ui/             # shadcn primitives (button, card, sidebar, dropdown-menu, ...)
│   ├── fonts/Fonts.tsx     # next/font definitions (Inter, Space Grotesk)
│   ├── hooks/use-mobile.ts
│   ├── lib/                # Service layer (see ARCHITECTURE.md)
│   ├── providers/AuthProvider.tsx  # NextAuth SessionProvider wrapper
│   ├── redux/              # RTK store, baseApi, authSlice, rootReducer, Provider
│   ├── generated/prisma/   # Prisma generated client (build artifact, do not edit)
│   ├── instrumentation.ts  # node-cron background jobs (register())
│   ├── proxy.ts            # Next 16 middleware (auth redirect)
│   └── types/next-auth.d.ts
├── ecosystem.config.js     # PM2 production config
├── next.config.ts          # (note: next.config.js/.mjs also present)
├── prisma.config.ts
└── tsconfig.json           # "@/*" → "./src/*" alias
```

## Directory Purposes

**`src/app/api/`:** All backend endpoints as Next route handlers
- `auth/*` — register, forgot/reset password, verify-email, `[...nextauth]`
- `monitors/*` — CRUD (`route.ts`), `[id]/check`, `[id]/details`
- `cron/*` — `check` (runs monitor checks), `cleanup`
- `incidents/`, `status/[userId]`, `user/profile`, `feedback/`, `telegram/{connect,test,webhook}`

**`src/lib/`:** Shared server logic — `prisma.ts`, `auth.ts`, `cron-logic.ts`, `db-batcher.ts`, `cleanup-logic.ts`, `telegram.ts`, `mail.ts`, `rate-limit.ts`, `tokens.ts`, `utils.ts` (cn helper)

**`src/components/ui/`:** shadcn-generated primitives; safe to regenerate via `components.json` config

## Key File Locations

**Entry Points:**
- `src/app/layout.tsx`: root layout (providers, fonts, dark theme)
- `src/instrumentation.ts`: background cron jobs
- `src/proxy.ts`: auth middleware
- `ecosystem.config.js`: PM2 process definition

**Configuration:**
- `prisma/schema.prisma`: DB schema (models: User, Account, Session, Monitor, Ping, Incident, Feedback, VerificationToken)
- `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json`

**Core Logic:**
- `src/lib/cron-logic.ts`: monitor checking engine
- `src/lib/db-batcher.ts`: batched DB writes
- `src/lib/auth.ts`: NextAuth configuration

**Root-level test scripts (manual, not a test suite):**
- `test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`

## Naming Conventions

**Files:**
- Pages: `page.tsx`; layouts: `layout.tsx`; endpoints: `route.ts` (App Router convention)
- Components: PascalCase (`MonitorDetails.tsx`); form primitives prefixed `MyForm*`
- Lib modules: kebab-case (`cron-logic.ts`)
- Route groups: parenthesized kebab-case (`(dashboardLayout)`)

**Directories:**
- Component groups: PascalCase (`Dashboard/`, `Auth/`); one lowercase exception (`dashboardLayout/`, `form/`, `home/`, `common/`)

## Where to Add New Code

**New dashboard feature page:**
- Page: `src/app/(dashboardLayout)/dashboard/<feature>/page.tsx`
- Component: `src/components/Dashboard/<Feature>.tsx`
- API: `src/app/api/<feature>/route.ts` (follow the session-check + rate-limit + Prisma pattern in `src/app/api/monitors/route.ts`)

**New public page:**
- `src/app/(commonLayout)/<page>/page.tsx` + content component in `src/components/Pages/`

**New shared server logic:**
- `src/lib/<module>.ts` (kebab-case, import Prisma from `@/lib/prisma`)

**New UI primitive:**
- Prefer adding to `src/components/ui/` (shadcn pattern, use `cn` from `@/lib/utils.ts`)

**New Prisma model:**
- Edit `prisma/schema.prisma`, run `npx prisma generate` (also runs during `npm run build`), create migration

**New background job:**
- Add `cron.schedule(...)` in `src/instrumentation.ts`, keep logic in `src/lib/`

**Import alias:** Always use `@/` (maps to `src/`, defined in `tsconfig.json`)

## Special Directories

**`src/generated/prisma/`:**
- Purpose: Prisma client output
- Generated: Yes (by `prisma generate`)
- Committed: No — never edit; always import from `@/lib/prisma`

**`docs/`, `README.md`, `UPGRADE_PLAN.md`, `ADVANCED_MONITORING_PLAN.md`:**
- Planning/documentation only

---

*Structure analysis: 2026-09-08*
