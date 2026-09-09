# Phase 2: Foundations & Theme Infrastructure - Pattern Map

**Mapped:** 2026-09-10
**Files analyzed:** 20 (new + modified + deleted)
**Analogs found:** 11 / 14 non-deletion files (test files have no in-repo analog — repo has ZERO tests; patterns sourced from RESEARCH.md verified code examples + the seams they target)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `package.json` (modify) | config | — | itself (pnpm wiring adds fields; scripts chain mirrors existing `"build"`) | exact |
| `.nvmrc` (new) | config | — | none | none |
| `pnpm-workspace.yaml` (new) | config | — | none (`allowScripts` dead field in package.json lines 66-70 is the anti-analog to remove) | none |
| `next.config.ts` (modify) | config | — | itself (delete `typescript.ignoreBuildErrors` block) | exact |
| `vitest.config.ts` (new) | config | — | `next.config.ts` (TS `defineConfig` + `export default` shape) | role-match |
| `playwright.config.ts` (new) | config | — | `next.config.ts` | role-match |
| `docker-compose.test.yml` (new) | config | — | none (weak: `ecosystem.config.js` process config — different domain) | none |
| `tests/setup/global-setup.ts` (new) | test setup | batch | none — targets `src/lib/prisma.ts` singleton seam | none |
| `tests/setup/seed.ts` (new) | test utility | CRUD | none — uses `prisma` from `@/lib/prisma` | none |
| `tests/integration/cron-logic.test.ts` (new) | test | integration | none — targets `src/lib/cron-logic.ts` (`runCronChecks`) | none |
| `tests/integration/db-batcher.test.ts` (new) | test | integration | none — targets `src/lib/db-batcher.ts` | none |
| `tests/api/_harness.ts` + `tests/api/*.handler.test.ts` (new) | test | request-response | none — targets the route template in `src/app/api/monitors/route.ts` | none |
| `tests/e2e/smoke.spec.ts` (new) | test | request-response | none | none |
| `src/components/theme/ThemeProvider.tsx` (new) | component (provider) | — | `src/redux/Provider.tsx` (client provider wrapping children inside layout) | role-match |
| `src/components/theme/ThemeToggle.tsx` (new) | component | event-driven | `src/hooks/use-mobile.ts` (useEffect + state, client-only) | role-match |
| `src/components/theme/ThemedToaster.tsx` (new) | component | — | `src/app/layout.tsx` line 32 (`<Toaster richColors position="top-right" theme="dark" />`) | exact usage |
| `src/app/layout.tsx` (modify) | component (layout) | — | itself — ThemeProvider wrap mirrors existing AuthProvider/ReduxProvider nesting | exact |
| `src/app/globals.css` (modify) | config (styles) | — | itself — `:root`/`.dark`/`@theme inline` blocks all exist | exact |
| `src/app/api/monitors/route.ts` (modify) | route | request-response | itself — remove the one `details: error.message` leak (line 25) | exact |
| `.env.example` (new) | config | — | none (source: audit Appendix A inventory) | none |
| **Deletions:** `next.config.js`, `next.config.mjs`, `.github/workflows/deploy.yml`, `ngrok`, `ngrok.log`, `test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`, `package-lock.json` | — | — | n/a (delete only; no imports reference them per CONTEXT code_context) | n/a |

## Pattern Assignments

### `src/components/theme/ThemeProvider.tsx` (component/provider)

**Analog:** `src/redux/Provider.tsx` — client provider wrapping children, nested inside `src/app/layout.tsx` alongside existing providers.

**Provider nesting pattern** (`src/app/layout.tsx` lines 28-35) — insert ThemeProvider as the OUTERMOST wrap (next-themes writes to `<html>`, must wrap everything):
```tsx
<Suspense fallback={<Loading />}>
  <AuthProvider>
    <ReduxProvider>
      {children}
      <Toaster richColors position="top-right" theme="dark" />
    </ReduxProvider>
  </AuthProvider>
</Suspense>
```

**Concrete change to layout.tsx (THM-01/02):**
- Line 24: `<html lang="en" className="dark">` → `<html lang="en" suppressHydrationWarning>` (delete hardcoded `className="dark"`; next-themes pre-paint injects it — D-24 default `dark` keeps pixels identical)
- Line 26: replace hardcoded `bg-[#121212] text-slate-100` with `bg-background text-foreground`
- Line 32: replace `<Toaster ... theme="dark" />` with `<ThemedToaster />` (client wrapper required — layout is a server component, per RESEARCH THM-02)

### `src/components/theme/ThemeToggle.tsx` (component, event-driven)

**Analog:** `src/hooks/use-mobile.ts` — the repo's existing client-only-effect + state pattern (lines 5-19):
```ts
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)
  React.useEffect(() => {
    // client-only logic
  }, [])
  return !!isMobile
}
```

Apply the same `useEffect(() => setMounted(true), [])` guard before rendering theme-dependent icons (RESEARCH Pitfall 8). File convention: `"use client";` first line, PascalCase named function export, `cn()` from `@/lib/utils` if class merging needed, sun/moon/monitor icons from `hugeicons-react` / `react-icons` (already in dependencies, package.json lines 23/34).

### `src/components/theme/ThemedToaster.tsx` (component)

**Analog:** `src/app/layout.tsx` line 32 — existing verbatim usage to preserve (props `richColors position="top-right"`), only `theme` becomes derived from `useTheme().resolvedTheme`. Copy the RESEARCH.md ThemedToaster excerpt exactly.

### `src/app/globals.css` (modify — palette split)

**Analog:** itself. The structure to extend already exists:

- Line 4: `@custom-variant dark (&:is(.dark *));` — already present, do not touch
- Lines 6-42: `@theme inline` token mapping — EXTEND with `--color-status-up: var(--status-up)` / `--color-status-down: var(--status-down)` (D-25), do not invent a parallel system
- Lines 44-72 `:root` and 74-101 `.dark` are currently **byte-identical** — the work: copy the current block into `.dark` UNCHANGED, author the light zinc palette as the new `:root` (D-22)
- Lines 118-144 `.glass-panel` / `.red-glow` / `.red-gradient-text` contain hardcoded rgba/hex — audit to derive from vars (Pitfall 9); `src/lib/mail.ts` hexes are EXCLUDED (email HTML)

### `vitest.config.ts` / `playwright.config.ts` (config)

**Analog:** `next.config.ts` — minimal TS config shape (lines 1-8):
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = { reactCompiler: true, typescript: { ignoreBuildErrors: true } };
export default nextConfig;
```
Follow the same `import ... defineConfig` + single `export default` style. Contents come from RESEARCH.md Code Examples (verified against vitest.dev / playwright.dev). The `next.config.ts` modification itself is a deletion: remove the `typescript: { ignoreBuildErrors: true }` line (line 5) in the SAME change that deletes `next.config.js`/`next.config.mjs` (Pitfall 11).

### `package.json` (modify)

**Analog:** itself. Existing scripts (lines 5-10) establish the chain style — plain `&&` command chains (Windows-safe, DEP-04 caveat). Add `typecheck`, `test`, `test:e2e`, `verify` per RESEARCH Code Examples; add `packageManager: "pnpm@10.34.5"` and `engines`; **delete the dead `allowScripts` field (lines 66-70)** — real config goes in `pnpm-workspace.yaml` (RESEARCH Pitfall 12). Note existing `build` uses `NODE_OPTIONS="..."` env-prefix syntax — new scripts must NOT copy that pattern (breaks on cmd.exe).

### `tests/api/_harness.ts` + handler tests (test, request-response)

**Analog (target seam):** `src/app/api/monitors/route.ts` — the canonical route template every D-17 route follows. The harness mocks exactly what this template imports:

**Session guard** (lines 11-14):
```ts
const session = await getServerSession(authOptions);
if (!session?.user?.id) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```
**Error handling** (lines 22-28) — includes the one FND-07 leak to fix in production code (line 25 `details: error instanceof Error ? error.message : String(error)`) and a typo to pin verbatim (line 49 `{ error: "Unauthirized" }` in POST; line 23 `"Featch Monitors Error:"`):
```ts
} catch (error) {
  console.error("Featch Monitors Error:", error);
  return NextResponse.json(
    { error: "Failed to fetch monitors", details: error instanceof Error ? error.message : String(error) },
    { status: 500 }
  );
}
```
**Rate limit seam** (lines 37-45): `rateLimit()` from `@/lib/rate-limit` — in-memory Map, needs module reset between tests (Pitfall 6). **Ownership scoping** (line 17 `where: { userId: session.user.id }`) — the D-21 mutation target.

### `tests/integration/db-batcher.test.ts` (test)

**Analog (target seam):** `src/lib/db-batcher.ts` — module-level state at lines 4 and 14 is exactly why the test must use `vi.resetModules()` + dynamic `import()` (no static import):
```ts
let pendingPings: any[] = [];
const pendingMonitorUpdates = new Map<number, MonitorUpdate>();
```
Flush math to pin: lines 89-91 (uptime clamp `Math.max(0, Math.min(100, ...))`), failure-swallow catch at lines 108-112 (batch silently lost).

### `tests/integration/cron-logic.test.ts` (test)

**Analog (target seam):** `src/lib/cron-logic.ts` `runCronChecks(force, specificMonitorId)` — called AS-IS; three interventions only (SQL seed, `vi.stubGlobal("fetch", …)`, `vi.mock("@/lib/telegram")`). Test imports `prisma` from `@/lib/prisma` — never instantiate PrismaClient.

### `tests/setup/global-setup.ts` / `seed.ts` (test setup)

**Analog (target seam):** `src/lib/prisma.ts` — singleton reads `DATABASE_URL` at module load (line 10) and caches on `globalThis` (lines 23-26); globalSetup must set the docker DATABASE_URL before any test module imports. Note Bangla comment at line 12 — new comments must be English.

## Shared Patterns

### Provider wrapping in root layout
**Source:** `src/app/layout.tsx` lines 28-35
**Apply to:** ThemeProvider insertion, ThemedToaster replacement — preserve the AuthProvider > ReduxProvider nesting; theme provider goes outermost.

### Client-only effect guard
**Source:** `src/hooks/use-mobile.ts` lines 5-19 (state starts `undefined`, set inside `useEffect`)
**Apply to:** ThemeToggle mounted guard, ThemedToaster — SSR renders no theme-dependent output.

### Route handler template (what API tests pin, not what new code copies)
**Source:** `src/app/api/monitors/route.ts` (session guard lines 11-14, validation 400s lines 68-84, limit 403 lines 53-62, rate-limit 429 lines 39-45, catch `{ error }` 500s)
**Apply to:** all handler-import tests in D-17 scope; response bodies pinned VERBATIM including typos; the single `details: error.message` leak (line 25) is the one production-code fix (FND-07).

### Config file style
**Source:** `next.config.ts`, `postcss.config.mjs` — TS/JS `export default` objects, minimal, no comments
**Apply to:** vitest.config.ts, playwright.config.ts, pnpm-workspace.yaml.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `vitest.config.ts`, `playwright.config.ts` | config | — | No test tooling exists; use RESEARCH.md verified Code Examples |
| `docker-compose.test.yml` | config | — | No compose/infra files in repo |
| `tests/**` (all) | test | integration/request-response | Repo has ZERO tests (deliberate delete of ad-hoc scripts, D-09); RESEARCH.md Code Examples are the verified source |
| `.env.example` | config | — | Does not exist; audit Appendix A 19-variable inventory is the source |
| `.nvmrc`, `pnpm-workspace.yaml` | config | — | New toolchain artifacts; RESEARCH.md Code Examples |

## Metadata

**Analog search scope:** `src/app/layout.tsx`, `src/app/globals.css`, `src/app/api/monitors/route.ts`, `src/lib/{prisma,db-batcher}.ts`, `src/hooks/use-mobile.ts`, `next.config.ts`, `package.json`, root scripts/configs
**Files scanned:** 8 direct reads + CLAUDE.md architecture map
**Pattern extraction date:** 2026-09-10
