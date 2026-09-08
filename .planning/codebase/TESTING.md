# Testing Patterns

**Analysis Date:** 2026-09-08

## Test Framework

**Runner:**
- None. No Jest, Vitest, Playwright, or any test framework is installed (`package.json` has no test runner or `test` script)

**Assertion Library:**
- None

**Run Commands:**
```bash
npm run lint        # Static analysis only (ESLint 9 flat config)
npm run build       # Type-checks via next build (only automated verification)
```

## Test File Organization

**Location:**
- No test files exist anywhere (`src/**` contains zero `*.test.*` / `*.spec.*` files)

**Ad-hoc verification scripts (not automated tests):**
- `test-email.js` — manual SMTP/nodemailer connectivity check; run directly with `node`
- `test-prisma.js`, `test-prisma-adapter.js` — manual Prisma query/adapter checks using `src/generated/prisma`
- `test-webhook.js` — manual webhook delivery check
- Pattern: plain Node scripts, `require("dotenv").config()`, async `main()` with try/catch/finally `prisma.$disconnect()`, `console.log` output

**Structure:**
```
project-root/
├── test-*.js        # Ad-hoc manual verification scripts (root, CommonJS)
└── src/             # No co-located or centralized tests
```

## Test Structure

Not applicable — no test suites exist.

## Mocking

**Framework:** None

**What to Mock (when tests are introduced):**
- `@/lib/prisma` (singleton client) — mock the exported `prisma` object per module
- `getServerSession` from `next-auth` — control auth state in route handler tests
- `nodemailer` (`src/lib/mail.ts`) and `cloudinary` — never hit real services
- `fetch`/network in RTK Query tests (`src/redux/api/baseApi.ts`)

## Fixtures and Factories

None. Prisma schema (`prisma/`) is the de facto data model reference for building fixtures.

## Coverage

**Requirements:** None enforced

**View Coverage:** Not available

## Test Types

**Unit Tests:** None
**Integration Tests:** None
**E2E Tests:** None

## Current Verification Practices

- ESLint (`npm run lint`) and TypeScript strict mode are the only automated checks
- `npm run build` runs `prisma generate` + `next build` — catches type errors
- Manual verification via root `test-*.js` scripts for email/DB/webhook integrations
- UI verified manually via `npm run dev` (port 3007)

## Recommendations for New Tests

- Introduce Vitest (pairs naturally with the ESLint flat config and TS setup); add a `test` script to `package.json`
- Highest-value first targets: `src/lib/rate-limit.ts`, `src/lib/tokens.ts`, `src/lib/cleanup-logic.ts`, `src/lib/cron-logic.ts` (pure-ish logic), then route handlers in `src/app/api/**` with mocked prisma/session
- Co-locate as `*.test.ts` next to source or mirror under `src/**/__tests__/`
- Keep root `test-*.js` scripts out of CI; they require live credentials

---

*Testing analysis: 2026-09-08*
