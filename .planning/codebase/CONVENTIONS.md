# Coding Conventions

**Analysis Date:** 2026-09-08

## Naming Patterns

**Files:**
- Components: PascalCase `.tsx` (`src/components/Dashboard/Dashboard.tsx`, `src/components/Auth/LoginForm.tsx`)
- shadcn/ui primitives: kebab-case `.tsx` (`src/components/ui/dropdown-menu.tsx`, `src/components/ui/sidebar.tsx`)
- Non-component modules: camelCase or kebab-case (`.ts` (`src/lib/rate-limit.ts`, `src/lib/db-batcher.ts`, `src/lib/cleanup-logic.ts`)
- API routes: Next.js convention `route.ts` inside `src/app/api/<resource>/route.ts` (dynamic segments use `[id]`)
- Redux slices: camelCase `*Slice.ts` (`src/redux/features/auth/authSlice.ts`)

**Functions:**
- Exported React components: PascalCase named function exports (`export function useIsMobile`, `export default function Dashboard`)
- Route handlers: uppercase HTTP verb exports (`export async function GET`, `PATCH`, `DELETE` in `src/app/api/user/profile/route.ts`)
- Helpers/utilities: camelCase (`cn` in `src/lib/utils.ts`)

**Variables:**
- camelCase for locals/state; UPPER_SNAKE for constants (`MOBILE_BREAKPOINT` in `src/hooks/use-mobile.ts`)

**Types:**
- Interfaces/types PascalCase; type declarations in `src/types/` (e.g. `src/types/next-auth.d.ts` module augmentation); Prisma client generated at `src/generated/prisma`

## Code Style

**Formatting:**
- No Prettier config detected; style follows `eslint-config-next` defaults
- Mixed quoting: lib/redux files use double quotes semicolon-terminated; API routes frequently use single quotes without semicolons — match the file you edit
- 2-space indent throughout

**Linting:**
- ESLint 9 flat config: `eslint.config.mjs` (extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`)
- Run: `npm run lint`

**TypeScript:**
- `tsconfig.json`: `strict: true`, `noEmit`, `moduleResolution: bundler`, path alias `@/*` → `./src/*`
- React Compiler enabled via `babel-plugin-react-compiler`

## Import Organization

**Order:**
1. React/Next imports
2. Third-party packages (`next-auth`, `@reduxjs/toolkit`, `prisma`, `cloudinary`)
3. Internal `@/...` alias imports (lib, redux, components)

**Path Aliases:**
- `@/*` → `./src/*` (use this for all cross-directory imports)
- Relative imports used for generated Prisma client (`'../generated/prisma'` in `src/lib/prisma.ts`)

## Component Conventions

**"use client" / "use server":**
- Interactive components start with `"use client";` (first line, e.g. `src/components/Dashboard/Dashboard.tsx`)
- API route handlers are server by default; no `"use server"` actions in use

**UI primitives:**
- shadcn/ui pattern: components in `src/components/ui/` composed with `cn()` from `src/lib/utils.ts` (clsx + tailwind-merge)
- Project skill `.claude/skills/shadcn/SKILL.md` — use `npx shadcn@latest` to add/search components; prefer composing existing ui primitives before writing new ones
- Tailwind CSS v4 with `tw-animate-css` (see also `.claude/skills/tailwind-design-system`)

**Forms:**
- `react-hook-form` with custom inputs in `src/components/form/MyFormInput.tsx`

**State management:**
- Redux Toolkit: store in `src/redux/store.ts`, RTK Query base API in `src/redux/api/baseApi.ts` (`fetchBaseQuery`, `credentials: "include"`, Authorization header from `state.auth.token`), slices in `src/redux/features/<name>/`, selectors exported next to slices (`selectCurrentUser`)
- `redux-persist` wired via `src/redux/Provider.tsx`
- NextAuth session via `getServerSession(authOptions)` on server (`src/lib/auth.ts`)

## Server-Side Patterns

**Prisma:**
- Singleton client in `src/lib/prisma.ts` using driver adapter `PrismaPg` with a `pg` `Pool`, cached on `global` for dev HMR — always import `prisma` from `@/lib/prisma`, never instantiate `PrismaClient` directly
- Prisma skills available: `.claude/skills/prisma-*` (client API, driver adapters, upgrade v7)

**Route handler template** (follow `src/app/api/user/profile/route.ts`):
```typescript
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // prisma query with explicit select
    return NextResponse.json({ ... }, { status: 200 });
  } catch (error) {
    console.error("Get Profile Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```
- Section banner comments (`// 1. GET CURRENT USER PROFILE (GET)`) separate multiple handlers per file
- Always use explicit Prisma `select` to avoid leaking fields (password excluded via destructuring + `hasPassword` boolean flag)

## Error Handling

**Patterns:**
- API routes: try/catch wrapping the whole handler, `console.error("<Handler name>:", error)` then `NextResponse.json({ error: "..." }, { status: 500 })`
- Validation errors return 400 with descriptive `{ error }` payloads
- Next.js error boundaries: `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/not-found.tsx`
- Startup validation pattern: throw at module load if env missing (`src/redux/api/baseApi.ts` lines 9–11)

## Logging

**Framework:** `console` only (no logger library)

**Patterns:**
- Server: `console.error("<Context> Error:", error)` in catch blocks
- Prisma dev logging: `log: ['query', 'error', 'warn']` in development, `['error']` in production (`src/lib/prisma.ts`)
- Never log secrets/passwords (see `test-email.js` comment)

## Comments

**When to Comment:**
- Section dividers in larger route files (`// -------------------`)
- Bangla-language inline comments exist in places (`src/lib/prisma.ts`); new comments should be English

**JSDoc/TSDoc:**
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

**Exports:**
- Components: named or default export (both in use); shadcn primitives use named exports
- Slices: default-export reducer + named action/selectors (`src/redux/features/auth/authSlice.ts`)
- Lib modules: named exports (`prisma`, `authOptions`, `cn`)
- No barrel files (`index.ts` re-exports not used)

---

*Convention analysis: 2026-09-08*
