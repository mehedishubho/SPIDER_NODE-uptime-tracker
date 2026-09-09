# Phase 2: Foundations & Theme Infrastructure - Research

**Researched:** 2026-09-10
**Domain:** Toolchain migration (npm→pnpm, Node 24 pin, typecheck flip) · Test infrastructure (Vitest + Playwright on docker Postgres/Redis) · Characterization testing · Theme infrastructure (next-themes class strategy)
**Confidence:** HIGH (codebase seams verified by direct read; external claims verified against official docs or npm registry; LOW items explicitly tagged and logged)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### CI/CD removal & manual deployment
- **D-01:** Delete `.github/workflows/deploy.yml` in this phase — fully manual deployment, **no GitHub Actions at all** (not even CI-only). Side benefit: removes the `prisma db push --accept-data-loss`-on-every-deploy hazard from the deploy path immediately.
- **D-02:** The gate chain (lint → typecheck → unit/integration → build) lives in a single local **`pnpm verify`** command that auto-starts the docker Postgres/Redis containers for tests. This is the ONLY script added; gate enforcement is operator discipline (run verify before shipping).
- **D-03:** **No deploy automation or artifact tooling from us** — no `pnpm deploy`, no scripts, no SCP helpers (user: "I will deploy it manually, no readymade system, make everything default"). The runbook documents the typed sequence; the default safe path is build on the dev machine and ship artifacts (the VPS should not build Next 16 itself — the 2 GB memory flag and deploy.yml's "small servers" comment exist for this reason).
- **D-04:** Post-deploy verification is **typed checks in the runbook** (curl the app, `pm2 status`, glance at logs). No smoke script; no `readyz` endpoint exists until Phase 4's worker.
- **D-05:** Phase 2 deploys run **no schema command** (no schema changes in this phase) — consistent with the runbook's phase-conditional Migrate step (Phase 2 = no migrate).

#### Node & pnpm foundations
- **D-06:** **Node 24 LTS** pinned identically across dev machine, verify environment, and VPS (`.nvmrc`, `package.json` engines) — VPS is Ubuntu 24.04 loading Node via NVM; backward-compatibility floor of 22 is acceptable (BullMQ 6 and Next 16 both support it; 24 is a superset of 22).
- **D-07:** **`pnpm import` — exact freeze**: convert `package-lock.json` to `pnpm-lock.yaml` preserving every resolved version, then delete the npm lockfile. Zero dependency drift while the characterization suite pins behavior — any suite-observable change can only come from our edits. Version upgrades become deliberate later work.
- **D-08:** pnpm 10 via corepack (`packageManager` field in package.json); `onlyBuiltDependencies` configured for prisma engines and other build-script packages; npm artifacts (`package-lock.json`, npm `node_modules`) removed.
- **D-09:** **Delete all four root ad-hoc scripts** (`test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`) — they require live credentials, are superseded by the characterization suite, and git history preserves them.

#### Typecheck flip (FND-02)
- **D-10:** **Fix-all-then-flip**: size the pile (tsc + prisma generate) in the first task, fix every error, then turn `ignoreBuildErrors` off — one clean cutover; no suppression markers, no two-stage red gate.
- **D-11:** **Minimal churn** fix policy: smallest possible diff that makes types honest — assertions and precise annotations where code is correct, signature tweaks only where truly wrong. No refactors, no drive-by tightening; the suite pins behavior, not type elegance.
- **D-12:** **Escalation threshold**: if the pile exceeds **~100 errors**, stop and reconvene — split fixes into dedicated plan(s) with their own verification rather than letting one plan balloon. Under 100: just fix.
- **D-13:** The flip lands **early — in the phase's first plans** (alongside pnpm/Node work), so all later tasks run under a green typecheck. Sequenced with the suite per D-19.
- **D-14 (consequence):** deleting deploy.yml + shipping the build machine's generated client means the VPS never runs `prisma generate` (deploy.yml's `npx prisma generate` after `--omit=dev` was fetching prisma from the registry at deploy time — a wart this removes).

#### Characterization suite (FND-04/05/06)
- **D-15:** Data-path tests (`runCronChecks`, `flushBatches`) run as **real-Postgres integration tests**: docker Postgres, seed via SQL, stub `fetch` (target URLs) and Telegram, call the functions **as-is** (no refactor-before-pin — `runCronChecks` is a single 220-line export and stays that way), assert actual rows. Matches audit §23's given/when/then cases with expected DB effects.
- **D-16:** API contract tests are **hybrid**: HTTP-level (Playwright request context against a booted real Next server + real Postgres; seeded user logs in over HTTP) for the core routes, handler-import (constructed NextRequest + mocked `getServerSession`/prisma) for the rest.
- **D-17:** Route scope = **rewrite-touched core ~10 routes**: monitors CRUD ×4 (list/create/update/delete), monitor check, incidents, public status ×2, cron/check, cron/cleanup, feedback. The Telegram webhook is pinned **as-is including today's unauthenticated-access defect** — deliberately, so Phase 6's S-2 fix is a visible red→green. Auth routes get shallow contracts only (register/validation status codes) — Phase 7 replaces NextAuth wholesale; deep characterization of soon-to-die code wastes effort.
- **D-18:** Playwright ships **scaffold + ONE smoke E2E**: config + webServer boot wired to the docker stack, one test (seeded-user login → dashboard renders with a seeded monitor) proving the scaffold runs. Feature-E2E work is Phase 8 (UI-04).
- **D-19:** **Risk-tiered sequencing** between fixes and suite: typecheck fixes in **monitored logic** (cron-logic, db-batcher, API routes) wait until their characterization tests are green; UI/type-only fixes proceed immediately. The suite's cron/batcher/API core lands in the same early wave as the flip.
- **D-20:** **`pnpm verify` runtime budget: ≤5 minutes** (docker warm) — cut scope or parallelize rather than ship a slow manual gate; a gate that takes 20 minutes gets skipped, defeating DEP-04.
- **D-21:** **Mutation spot-check task** proves the suite pins behavior: during execution, deliberately break pinned behaviors (1-strike→2-strike DOWN, drop an ownership-scoping WHERE clause, swap a Telegram message template), record the suite goes red each time, revert. This makes roadmap success criterion 2 ("deliberately changing any pinned behavior turns the suite red") an explicitly verified task.

#### Theme infrastructure (THM-01/02/03)
- **D-22:** Light palette = **neutral zinc mirror** of today's dark: zinc/white family (≈#fafafa background, white cards, zinc-200 borders), same red brand identity (`#ef4444`). First-pass functional palette; Phase 8 refines (UI-03). Dark values stay byte-identical.
- **D-23:** Toggle = **cycle icon button** (sun/moon/monitor icons from existing icon sets) cycling Light → Dark → System, tooltip showing state. Placed in the **dashboard header AND the auth (login) layout**.
- **D-24:** **`defaultTheme="dark"`** in next-themes — every existing user sees exactly today's app until they opt in; the "dark visually identical to today" compatibility constraint holds by default, not just after toggle.
- **D-25:** Of the 237 hardcoded hexes, **only semantic status colors get curated light-mode variants** (UP green → green-600 family, DOWN red → red-600 family on light) so dashboards read correctly day one — this is a monitoring app; green/red IS the content. Everything else migrates mechanically to same-value tokens (dark byte-identical). Full per-hex review is Phase 8 UI-03 work.

#### VPS cutover
- **D-26:** Phase 2 is **repo-only**: no VPS access during execution. The runbook documents the one-time VPS switch (nvm install 24 → default, corepack enable pnpm, remove npm `node_modules`, first pnpm-based deploy with the generated prisma client shipped in the tarball). The user executes these at their next real deploy, whenever that is.

### Claude's Discretion
- `.env.example` contents — every variable the app reads (from code + `.env` usage), names + purpose comments only, no values
- ngrok binary + `ngrok.log` removal details; any other stray root artifacts flagged during hygiene
- db-batcher test isolation mechanics — module-level queues require `vi.resetModules()` or equivalent between cases; exact approach is implementation detail
- Redis container in docker-compose wired now but unused by app code until Phase 3 (per FND-04 wording)
- Sonner Toaster `theme` prop wiring to the resolved theme (THM-02 requirement, mechanics are standard)
- Pre-paint/FOUC mechanics — next-themes' `attribute="class"` + `suppressHydrationWarning` standard pattern satisfies THM-01; the inline pre-paint script is next-themes' default injection
- tsconfig `exclude` for `src/generated/prisma` if generated code pollutes the tsc pile
- Whether `engines` documents the 22 floor (e.g. `>=22`) while `.nvmrc` pins 24 — recommend yes
- Exact zinc/shadcn token values for the light palette within the "neutral zinc mirror" character (D-22)
- Seed-data shapes and test-DB reset strategy (truncate vs transaction-rollback) for the integration suite
- Telegram assertion style (spy on send vs captured payload fixtures)

### Deferred Ideas (OUT OF SCOPE)
- Deploy automation / `pnpm deploy` script with embedded gates — deferred to Phase 4/5 P-1 pipeline revision where the worker topology forces the pipeline rewrite anyway (D-03)
- Light palette refinement, light-safe brand assets (Lottie overlays, sidebar token reconciliation) — Phase 8 UI-03 (D-22/D-25)
- Full per-hex light-mode review of all 237 hardcoded hexes — Phase 8 UI-03 (D-25)
- Feature-level E2E browser tests (abortable polling, hydration robustness) — Phase 8 UI-04 (D-18)
- Dependency version upgrades post-pnpm-import — deliberate future work, not this phase (D-07)
- `readyz` health endpoint — arrives with the Phase 4 worker (WRK-08); interim smoke stays typed checks (D-04)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-01 | Package manager migrated to pnpm (committed lockfile, npm artifacts removed, `onlyBuiltDependencies` configured) | `pnpm import` exact-freeze mechanics [CITED: pnpm.io/cli/import]; build-script gating lives in `pnpm-workspace.yaml` — `onlyBuiltDependencies` (pnpm 9/10) vs `allowBuilds` (≥10.26, the pnpm-11-surviving form) [CITED: pnpm.io/settings/build]; stray `allowScripts` field in package.json confirmed dead config (repo-read); registry versions verified |
| FND-02 | Typecheck enforced (`ignoreBuildErrors` off) and lint/typecheck gates green in CI | Next 16 still supports the option, **default false** — flip = delete the `typescript: { ignoreBuildErrors: true }` block from `next.config.ts` + delete stale `next.config.js`/`.mjs` duplicates (repo-read + [CITED: nextjs.org docs]); `tsc --noEmit` script for fast feedback; tsconfig exclude for `src/generated/prisma` (discretion, recommended) |
| FND-03 | Node version standardized across dev/CI before tooling version pins | Node 24 "Krypton" LTS (start 2025-10-28, EOL 2028-04-30); Node 22 EOL 2027-04-30 — valid floor [VERIFIED: nodejs/release schedule.json]; local machine runs 24.15.0 (verified by probe); `.nvmrc` + `engines` field mechanics |
| FND-04 | Vitest + Playwright scaffolding wired with docker-compose Postgres/Redis for local dev and CI | Vitest 4.1.11 / Playwright 1.63.0 [VERIFIED: npm registry]; docker-compose available locally (verified by probe); Playwright `webServer` readiness/reuse/env semantics [CITED: playwright.dev]; Redis container wired-but-unused per discretion |
| FND-05 | Characterization tests pin `runCronChecks` behavior: due-time filtering, UP/DOWN classification, transition paths, incident open/resolve, Telegram message selection | Full `cron-logic.ts` read (seams: `fetch` stub + `vi.mock("@/lib/telegram")` + real Postgres seeded via SQL); critical nuances verified: UNKNOWN→UP sends NO telegram (schema default) vs PENDING→UP sends "MONITORING STARTED" (API-created); `runCleanup()` side effect purges seeds >30 days old; `vi.mock` alias support verified [CITED: vitest.dev/api/vi] |
| FND-06 | Characterization tests pin db-batcher enqueue/flush math and per-route API contracts | `db-batcher.ts` module-level state (`pendingPings` array + `pendingMonitorUpdates` Map) requires `vi.resetModules()` + dynamic `import()` per case — static imports are NOT re-evaluated [CITED: vitest.dev/api/vi]; handler-import harness pattern (mock exactly `next-auth` + `@/lib/prisma`); rate-limit module reset between handler tests (repo-read) |
| FND-07 | Repo hygiene: ngrok binary/log removed, `.env.example` documenting the full variable set, error responses never include stack traces | ngrok binary (33 MB) + `ngrok.log` confirmed git-tracked (repo-read); NO `.env.example` exists today — audit Appendix A's 19-variable inventory is the source; exactly ONE API route leaks `error.message` (`monitors/route.ts` GET `details:` field — repo-read) |
| THM-01 | Light/dark theme infrastructure (`next-themes`, class strategy): real light `:root` palette, current dark values preserved as `.dark`, inline pre-paint script, no FOUC or hydration mismatch | next-themes 0.4.6 verified [VERIFIED: npm registry]; full ThemeProvider/useTheme semantics [CITED: github.com/pacocoursey/next-themes]; `@custom-variant dark (&:is(.dark *))` already present in globals.css (repo-read); `:root` and `.dark` currently byte-identical (repo-read) — the split is the work |
| THM-02 | Theme toggle (Light/Dark/System) in app header/nav; resolved theme passed to Sonner Toaster | `defaultTheme="dark"` (D-24), cycle-button pattern with `mounted` hydration guard [CITED: next-themes README]; sonner `theme` prop proven by existing in-repo usage `<Toaster theme="dark" />` in `src/app/layout.tsx`; Toaster currently lives in a server component — needs client wrapper |
| THM-03 | Hardcoded hex classes migrated to semantic tokens (mechanical hygiene; no visual change) | Baseline re-measured 2026-09-10: **303 raw hex occurrences across 40 files** in `src/` (repo grep `#[0-9a-fA-F]{3,8}`); minus the two fully-excluded files — globals.css token definitions (49) and `mail.ts` email-template HTML (17; email clients can't use CSS vars) — leaves **237**, the figure CONTEXT D-25 cites (it still contains the LoginForm/RegisterForm Google brand marks, which stay raw as a partial exclusion); the earlier 254 was a stale count — plan 02-08 Task 1's live re-inventory at execution time is authoritative; status-only curated light variants per D-25; `@theme inline` token mapping already complete in globals.css — extend it, don't replace it |
| DEP-04 | CI gates on PRs → reframed: local `pnpm verify` chain (lint → typecheck → unit/integration → build), ≤5 min budget | Single-script chain with `docker compose up -d --wait` prefix (D-02/D-20); Windows caveats (dev machine is win32): `&&` chains fine in npm/pnpm script shells, avoid env-var syntax in scripts; Playwright `gracefulShutdown` SIGTERM unsupported on Windows [CITED: playwright.dev] |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **GSD workflow enforcement:** all repo changes flow through GSD entry points (`$gsd-quick`, `$gsd-debug`, `$gsd-execute-phase`); this research is the sanctioned pre-planning step
- **Monitoring continuity is the core value:** never lose/corrupt uptime data, never silently stop checking, never irreversibly lock users out — behavior compatibility preserved (1-strike DOWN, lifetime uptime math, Telegram alert content, public API shapes)
- **Target stack includes pnpm** — Phase 2 makes it real; `package-lock.json` currently present
- **Always import `prisma` from `@/lib/prisma`**, never instantiate PrismaClient directly (singleton over pg Pool) — integration tests seed through this singleton or raw `pg`
- **New toasts use `sonner`**, not `sweetalert2`; shadcn primitives composed via `npx shadcn@latest` (project skill) — theme toggle should compose existing primitives/icon sets, not pull new UI deps
- **Never log secrets/passwords**; error responses must not leak stack traces (FND-07 enforces the one leak found)
- **English-only comments**; match each file's existing quote/semicolon style (repo is mixed)
- **`tsconfig.json` is `strict: true`** — the typecheck flip makes strictness load-bearing for the first time
- **CLAUDE.md tech-stack table still lists npm/Prisma/NextAuth** — expected to be updated by the migration phases themselves; planner should not treat the stale table as a blocker

## Summary

Phase 2 is a zero-behavior-change safety-net phase with three workstreams that must be sequenced deliberately: (1) toolchain migration — `pnpm import` exact-freeze, Node 24 pin, typecheck flip, repo hygiene; (2) test infrastructure — Vitest + Playwright on docker Postgres/Redis with a characterization suite pinning today's monitoring behavior defects included; (3) theme infrastructure — next-themes class strategy splitting today's byte-identical `:root`/`.dark` palettes into a real light palette plus preserved dark. Everything is repo-only (D-26); the VPS switch is runbook prose executed later.

The codebase is unusually well-seamed for characterization work despite having zero tests today: `runCronChecks(force, specificMonitorId)` is a single exported function whose only external effects are Postgres writes, `global.fetch` calls, and `sendTelegramAlert` — meaning three stubs/mocks plus a seeded docker Postgres pin it completely. The API routes follow one template (`getServerSession` → prisma → try/catch `{ error }`), so a single handler-import harness mocking exactly two modules (`next-auth`, `@/lib/prisma`) covers the non-core routes. The critical test-infra traps are all verified in-repo: instrumentation.ts registers node-cron on server boot (test server needs `CRON_MODE=vercel`), `runCronChecks` calls `runCleanup()` as a side effect (purges seeds older than 30 days), db-batcher holds module-level mutable state (needs `vi.resetModules()` + dynamic import per case), and the in-memory rate limiter persists across handler tests in the same worker. Two external facts refine locked decisions without contradicting them: pnpm's build-script gating has moved to `pnpm-workspace.yaml` with `allowBuilds` as the pnpm-11-surviving form (D-08's `onlyBuiltDependencies` is pnpm-9/10 vocabulary, removed in 11 — both work on pinned 10.x), and pnpm.io no longer documents corepack as an install method at all (corepack + `packageManager` still works on Node 24; the standalone script becomes the documented runbook fallback).

**Primary recommendation:** Land the toolchain first (pnpm import → Node 24 pin → typecheck fix-all-then-flip with monitored-logic fixes gated on green characterization tests per D-19), scaffold the suite in the same early wave, execute the mutation spot-check (D-21) as an explicit task, and do the theme split last so the suite protects the hex token migration (237 mappable occurrences per the THM-03 re-measure); every theme/behavior question resolves to "dark byte-identical by default" (`defaultTheme="dark"`, D-24).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| pnpm migration, Node pin, lockfile | Build/Tooling (repo) | VPS (deferred, D-26) | Lockfile + `packageManager` + `.nvmrc` are repo artifacts; VPS switch is runbook prose |
| Typecheck flip | Build tooling (`next.config.ts`, `tsconfig.json`) | — | `ignoreBuildErrors` is a Next build option; `tsc --noEmit` is a scripts entry |
| Unit/integration characterization | Test infrastructure (Vitest, node env) | Domain logic (`src/lib/**`) under test AS-IS | Tests drive `runCronChecks`/`flushBatches` against docker Postgres — no production-code changes |
| API contract tests | Test infrastructure | Web/API tier (route handlers) under test | HTTP-level via Playwright request context against booted server; handler-import for the rest |
| E2E smoke | Test infrastructure (Playwright + webServer) | Browser tier | Proves the scaffold boots a real Next server against the docker stack |
| `pnpm verify` orchestration | Local dev tooling (package.json scripts + docker compose) | — | Single command, operator-run, no CI |
| Theme state (localStorage, toggle, pre-paint) | Browser / Client components | Root layout (provider wrap) | next-themes is a client-side library; server renders attributes only |
| Theme palette (CSS custom properties) | Static assets (`globals.css`) | — | `:root` light + `.dark` preserved values + `@theme inline` mapping |
| Runbook amendments | Docs / Ops | — | Manual deploy steps, one-time VPS switch, typed post-deploy checks |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pnpm | 10.34.5 (via `packageManager` field) | Package manager; exact-freeze import from package-lock.json | D-08 pins pnpm 10; 10.34.5 is the latest pnpm-10 release [VERIFIED: npm registry] and includes `allowBuilds` (≥10.26) |
| vitest | ^4.1.11 | Unit + integration test runner | De facto standard for Vite-based/TS projects; v4 line is current-maintained (5.0.0 released 2026-09-03 — brand new; stay on 4.x per pin rationale below) [VERIFIED: npm registry] |
| @playwright/test | 1.63.0 | HTTP-level API tests + smoke E2E + webServer orchestration | Microsoft-maintained, ships its own request context + webServer config (no separate supertest needed) [VERIFIED: npm registry] |
| next-themes | ^0.4.6 | Theme provider (class strategy, pre-paint script, no FOUC) | The Next.js ecosystem standard; 18.1M dl/wk, legitimacy OK [VERIFIED: npm registry + package-legitimacy check] |
| docker compose | v5.5.0 (local) | Postgres + Redis containers for tests/dev | Verified installed locally; `--wait` flag gives health-gated startup inside `pnpm verify` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| playwright (browsers) | installed via `pnpm exec playwright install` | Browser binaries for the smoke E2E | Once during Wave 0; not a package.json dep beyond @playwright/test |
| `pg` / `@prisma/client` | existing (^8.22.0 / ^7.9.1) | SQL seeding + schema push in globalSetup | Already in tree — tests reuse `src/lib/prisma.ts` singleton |
| sonner | existing (2.x line; 2.0.8 latest) | Toaster `theme` prop wiring (THM-02) | Already installed and used in layout.tsx — no new install |
| bcryptjs | existing (^3.0.3) | Hash the seeded E2E user's password | E2E seed helper only |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| vitest | jest | Jest needs ts-jest/babel config and slower transforms; vitest natively handles TS + path aliases via Vite resolve — and its `vi.resetModules` semantics are exactly what db-batcher isolation needs |
| @playwright/test request context | supertest | supertest can't boot a Next production server, has no readiness polling, no browser tests; Playwright covers API + E2E + orchestration in one dep |
| next-themes | hand-rolled ThemeProvider + script | Pre-paint script, hydration safety, localStorage persistence, system-preference resolution are all deceptively hard — don't hand-roll (see below) |
| vite-tsconfig-paths plugin | manual `resolve.alias` in vitest.config.ts | Manual alias is zero new deps and two lines for this single-alias repo; plugin only pays off with complex path maps |
| `next dev` for Playwright webServer | `next start` on the just-built artifact | `next start` is closer to production behavior and reuses the build `pnpm verify` already produced; `next dev` boots faster but dev-mode behavior differs (React Compiler dev warnings, HMR overhead). Recommended: `next start` (build precedes e2e in the chain) |

**Installation:**
```bash
# after pnpm import + corepack enable (toolchain wave)
pnpm add -D vitest@^4.1.11 @playwright/test@1.63.0
pnpm exec playwright install
pnpm add next-themes@^0.4.6
```

**Version verification (run 2026-09-10):** [VERIFIED: npm registry via `npm view`]
- next-themes 0.4.6 (latest; 18.1M dl/wk; no postinstall script)
- vitest 5.0.0 (latest, published 2026-09-03); **4.1.11 is the maintained 4.x line** — recommended pin for a brand-new scaffold (5.0.0 is 7 days old)
- @playwright/test / playwright 1.63.0 (published 2026-09-04)
- pnpm: latest 12.3.4 · latest-10 **10.34.5** · latest-11 11.26.0 (local standalone install is 11.10.0 — see Pitfall 7)
- sonner 2.0.8 (already in tree — no action)

## Package Legitimacy Audit

> Package Legitimacy Gate executed 2026-09-10 via `gsd-tools query package-legitimacy check --ecosystem npm`.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| next-themes | npm | ~6 yrs (since 2020) | 18.1M/wk | github.com/pacocoursey/next-themes | OK | Approved |
| vitest | npm | ~5 yrs (since 2021) | 92.6M/wk | github.com/vitest-dev/vitest | SUS (latest 5.0.0 published 2026-09-03 — recency heuristic only) | Approved — pin `^4.1.11`; canonical org, no postinstall |
| @playwright/test | npm | ~6 yrs (since 2020) | 54.4M/wk | github.com/microsoft/playwright | SUS (1.63.0 published 2026-09-04 — recency heuristic only) | Approved — pin `1.63.0`; canonical Microsoft repo |
| sonner | npm | ~4 yrs | high | github.com/emilkowalski/sonner | OK (in-repo already) | No new install |

**Packages removed due to SLOP verdict:** none
**Packages flagged as suspicious [SUS]:** vitest, @playwright/test — both flagged purely by the "latest release <2 weeks old" heuristic; both are canonical, high-download, well-sourced packages. Mitigation is the version pin (4.1.11 / 1.63.0) rather than `checkpoint:human-verify`; if the planner prefers strict protocol, a single human-verify checkpoint before `pnpm add -D` covers both.

*No package in this phase was discovered via WebSearch/training data alone: next-themes was confirmed against its official GitHub README [CITED: github.com/pacocoursey/next-themes], vitest against vitest.dev/api/vi, Playwright against playwright.dev/docs/test-webserver, and all versions against the npm registry.*

## Architecture Patterns

### System Architecture Diagram

```
                        pnpm verify  (the ONLY gate script — D-02, local, operator-run)
                                      │
                 docker compose up -d --wait   (Postgres :5433 + Redis :6380, test network)
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        ▼                             ▼                              ▼
   pnpm lint                    pnpm typecheck                  pnpm test
   (eslint 9)                   (tsc --noEmit,                  (vitest run)
                                 flip ALREADY off)
                                      │                   ┌─────────┴────────────────────┐
                                      │                   │  unit + integration cases   │
                                      │                   │  ─ SQL seed → real Postgres │
                                      │                   │  ─ global.fetch stubbed     │
                                      │                   │    (vi.stubGlobal)          │
                                      │                   │  ─ @/lib/telegram mocked    │
                                      │                   │  ─ runCronChecks AS-IS      │
                                      │                   │  ─ assert actual rows       │
                                      │                   │  ─ db-batcher via           │
                                      │                   │    vi.resetModules+import() │
                                      │                   └─────────┬────────────────────┘
                                      ▼                             │
                                pnpm build   (tsc-clean build; flip enforced here too)
                                      │
                                      ▼
                          pnpm test:e2e  (playwright)
                          webServer boots `next start` on the built artifact
                          env: CRON_MODE=vercel  ← suppresses node-cron in instrumentation.ts
                                DATABASE_URL → docker Postgres
                                │                          │
                                ▼                          ▼
                     API contract tests          ONE smoke E2E
                     (playwright request         (seeded login → dashboard
                      context over HTTP;         renders with seeded monitor)
                      seeded user logs in
                      over real HTTP)
```

Theme data flow (independent of the verify chain):

```
next-themes  attribute="class"  defaultTheme="dark"  enableSystem
   │  injects pre-paint script → html.class set from localStorage|default BEFORE paint (no FOUC)
   ▼
html.dark (default) ── ThemeToggle cycles light → dark → system (writes localStorage "theme")
   │
   ├── globals.css:  :root { light zinc palette (D-22) + status tokens (D-25) }
   │                 .dark { today's values, BYTE-IDENTICAL }
   │                 @custom-variant dark (&:is(.dark *))   ← already present
   │                 @theme inline → --color-* utilities    ← already present, extend only
   ▼
ThemedToaster (client wrapper) reads useTheme().resolvedTheme → <Toaster theme=…/>
```

### Recommended Project Structure
```
docker-compose.test.yml        # postgres + redis (ports offset from any local defaults), healthchecks
vitest.config.ts               # alias @→src, globalSetup, node environment
playwright.config.ts           # webServer (next start, CRON_MODE=vercel), baseURL
tests/
├── setup/
│   ├── global-setup.ts        # DATABASE_URL localhost guard + prisma db push (once per run)
│   └── seed.ts                # SQL/pgsql seed helpers (fresh timestamps — cleanup pitfall)
├── integration/
│   ├── cron-logic.test.ts     # FND-05: audit §23 cases transcribed
│   └── db-batcher.test.ts     # FND-06: enqueue/flush math, failure-swallow behavior
├── api/
│   ├── _harness.ts            # handler-import helper: NextRequest + mock getServerSession/prisma
│   ├── monitors.core.spec.ts  # HTTP-level via Playwright request context (core ~10 routes)
│   └── *.handler.test.ts      # handler-import contracts (rest of D-17 scope)
└── e2e/
    └── smoke.spec.ts          # D-18: login → dashboard renders (+ html.dark default assert)
src/components/theme/
├── ThemeProvider.tsx          # "use client" wrapper (attribute="class", defaultTheme="dark")
├── ThemeToggle.tsx            # cycle button Light→Dark→System, mounted guard
└── ThemedToaster.tsx          # "use client" Toaster wrapper with resolvedTheme
```

### Pattern 1: Characterize-through-the-seam (data path)
**What:** Test `runCronChecks`/`flushBatches` with three interventions only — seed Postgres via SQL, `vi.stubGlobal("fetch", …)`, `vi.mock("@/lib/telegram")` — and assert actual database rows.
**When to use:** Every FND-05/FND-06 data-path test. Never mock prisma here; mocking the ORM defeats characterization.
**Why:** [VERIFIED: repo read] The function's entire external surface is {Postgres via `@/lib/prisma`, `global.fetch`, `sendTelegramAlert`, dynamic `import("./db-batcher")`}. Three stubs yield complete control.

### Pattern 2: Module-state isolation via registry reset
**What:** `vi.resetModules()` in `beforeEach` + `await import("@/lib/db-batcher")` inside each test.
**When to use:** db-batcher tests (module-level `pendingPings` array + `pendingMonitorUpdates` Map). Also any handler test where `@/lib/rate-limit`'s in-memory Map must start clean.
**Constraints:** [CITED: vitest.dev/api/vi] `vi.resetModules` clears the module registry so dynamic imports re-evaluate (fresh module state), but static top-level imports are NOT re-evaluated and the mocks registry is NOT reset (that needs `vi.unmock`/`vi.doUnmock`).

### Pattern 3: Handler-import harness (API contracts, non-core routes)
**What:** Import the route handler directly, mock exactly two modules (`next-auth` → `getServerSession`, `@/lib/prisma` → prisma), invoke with a constructed `NextRequest`, assert status + JSON body verbatim (typos included).
**When to use:** The non-core portion of D-17's route scope. Core routes get HTTP-level tests instead.
**Why:** [VERIFIED: repo read] Every route follows the template `getServerSession(authOptions)` → prisma → try/catch `{ error }`. Two mocks cover all of it. Pin response bodies **verbatim** — `"Unauthirized"` and `"Featch"` typos are part of today's contract.

### Pattern 4: Playwright webServer against the built artifact
**What:** `webServer: { command: "pnpm start", url: "http://localhost:3100/login", reuseExistingServer: !process.env.CI, env: { CRON_MODE: "vercel", DATABASE_URL: <docker> } }`.
**When to use:** API HTTP-level tests + smoke E2E. Readiness polling accepts 2xx/3xx and 400/401/402/403 [CITED: playwright.dev/docs/test-webserver] — `/login` returning 200 is a safe readiness URL.
**Why env override matters:** the booted server executes `src/instrumentation.ts`; without `CRON_MODE=vercel` it registers node-cron and starts making real Telegram/fetch calls against your seeded test data.

### Pattern 5: Theme split without behavior change
**What:** Move today's `:root` values into `.dark` unchanged; author the light zinc palette as the new `:root`; wrap children in `<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>`; keep `suppressHydrationWarning` on `<html>`; delete the hardcoded `className="dark"`; replace body's hardcoded `bg-[#121212] text-slate-100` with `bg-background text-foreground`.
**When to use:** THM-01. The pre-paint script next-themes injects sets `class="dark"` before first paint, so existing users see today's app pixel-for-pixel (D-24).

### Anti-Patterns to Avoid
- **Mocking prisma in data-path tests** — a characterization suite that mocks the ORM characterizes the mock, not the system
- **Refactoring `runCronChecks` before pinning** — explicitly forbidden (D-15); the 220-line monolith stays
- **`@ts-expect-error`/`@ts-ignore` during the flip** — explicitly forbidden (D-10); assertions and precise annotations only
- **Snapshotting whole rows** — assert specific columns (`status`, `totalChecks`, `uptimePercent`, message substrings); full-row snapshots break on unrelated column noise
- **Seeding timestamps far in the past** — `runCronChecks` ends with `runCleanup()`, which deletes pings older than 30 days and RESOLVED incidents older than 90; old seeds silently vanish mid-test
- **Pointing tests at the production DATABASE_URL** — globalSetup must hard-fail on non-local hostnames (live production system; see Security Domain)
- **Using Redis in Phase 2 app code** — the container exists for the stack wiring only; app usage is Phase 3 (RDS-01)
- **Snapshot-testing Telegram message strings as opaque blobs** — assert `expect.stringContaining("ALERT")` plus a few template fields; the full template is email/UX copy that Phase 8 may touch

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| FOUC-free theme switching | Inline pre-paint script + localStorage + matchMedia wiring | next-themes | Pre-paint injection, hydration-safe attribute writes, system-preference resolution, SSR correctness — all solved; hand-rolled versions flash or mismatch |
| Module registry reset / module mocking | Dependency-injection refactor of db-batcher | `vi.resetModules` + `vi.mock` | The refactor would change monitored code before it's pinned (violates D-15); Vitest's registry semantics are exactly sufficient |
| Lockfile conversion | Editing pnpm-lock.yaml or reinstalling from scratch | `pnpm import` | Preserves every resolved version exactly (D-07's zero-drift requirement); hand conversion re-resolves |
| HTTP-level test client + server boot | Custom fetch wrapper + spawn/kill scripts | Playwright request context + webServer | Readiness polling, env injection, graceful shutdown, reuseExistingServer — all built in |
| Postgres/Redis test lifecycle | Per-test container scripts | docker compose + `--wait` | Health-gated startup, fixed ports, reproducible state |
| Container orchestration in verify | Bash/PowerShell scripts | `docker compose up -d --wait` in the pnpm script | Cross-platform (Windows dev machine), single command |

**Key insight:** Every hand-rolled alternative in this phase either (a) modifies monitored production code before it's pinned (worst possible move in a characterization phase) or (b) rebuilds solved infrastructure (theme pre-paint, test-server lifecycle) with fresh bug surface.

## Runtime State Inventory

> Phase 2 includes a package-manager migration (npm→pnpm) — inventory below answers the canonical question for that migration.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | pnpm-lock.yaml generated from package-lock.json (D-07); no database/datastore state changes — Phase 2 runs no schema command (D-05) | Code/git artifact only |
| Live service config | `.github/workflows/deploy.yml` — deleted in-repo (D-01); **GitHub-side**: the workflow disappears on push to main (no GitHub API state to clean) | Delete file + push; no GitHub settings change needed |
| OS-registered state | VPS PM2: process "uptime-tracker" started via `ecosystem.config.js` (`script: "npm"`, args "run start") — still invokes npm until the D-26 switch; VPS `node_modules` installed by npm | Runbook only (D-26): nvm install 24, corepack enable pnpm, delete npm node_modules, pnpm install from shipped lockfile; **edit `ecosystem.config.js` to pnpm only as part of that switch** (see Open Questions) |
| Secrets/env vars | `.env` (not in git) — untouched; no variable renames in Phase 2; `.env.example` is NEW with names+comments only | None (creation, not migration) |
| Build artifacts | npm `node_modules/` on dev machine — delete before pnpm install; `src/generated/prisma` — regenerated by every build, shipped in deploy tarball per D-14; ngrok binary (33 MB) + `ngrok.log` git-tracked — `git rm` (ngrok.log may embed historical public tunnel URLs — removal from working tree is the scope; history rewrite is NOT in scope) | Dev: `rm -rf node_modules && pnpm install`; repo: `git rm ngrok ngrok.log` |

**Nothing found in category:** Stored data (no DB migration) — verified by D-05/phase description; no Redis, Mem0, or other datastore state exists (grep + repo audit).

## Common Pitfalls

### Pitfall 1: The test Next server starts node-cron and makes real network calls
**What goes wrong:** Playwright boots the server; `src/instrumentation.ts` registers a 1-minute `node-cron` check loop + healthchecks.io heartbeat; tests begin hitting real Telegram/monitor URLs.
**Why it happens:** instrumentation runs on every Next server boot (that's its job in production).
**How to avoid:** `webServer.env: { CRON_MODE: "vercel", … }` — verified in-repo: `CRON_MODE=vercel` makes instrumentation return before any cron registration.
**Warning signs:** Flaky tests with real HTTP latency; Telegram rate errors in test output.

### Pitfall 2: `runCleanup()` side effect silently deletes test seeds
**What goes wrong:** Seeds with pings older than 30 days (or RESOLVED incidents older than 90) vanish when `runCronChecks` completes — assertions fail mysteriously or (worse) pass against half-empty tables.
**Why:** `runCronChecks` ends with `await runCleanup()` — verified in-repo. `cleanup-logic.ts` deletes pings `< now - 30d` and resolved incidents `< now - 90d`.
**How to avoid:** Seed fresh timestamps (minutes old); where the test needs "old" rows (retention tests), isolate those cases and assert the purge behavior itself (it's a legitimate characterization case).
**Warning signs:** Row counts lower than seeded.

### Pitfall 3: db-batcher module state leaks between test cases
**What goes wrong:** `pendingPings` from test A flush during test B; math assertions off by exactly one batch.
**Why:** Module-level `let pendingPings: any[]` + `const pendingMonitorUpdates = new Map()` persist across cases in the same file; static imports never re-evaluate.
**How to avoid:** `vi.resetModules()` in `beforeEach` + `await import("@/lib/db-batcher")` inside each test; do NOT statically import db-batcher in its test file. (Vitest-verified semantics.)
**Warning signs:** Tests pass individually, fail in file runs (or vice versa).

### Pitfall 4: UNKNOWN vs PENDING initial status — two different first-check behaviors
**What goes wrong:** Tests seed monitors with schema default `status: "UNKNOWN"` and expect a "MONITORING STARTED" Telegram message — it never fires (UNKNOWN→UP sends nothing). API-created monitors use `status: "PENDING"` and DO message on first UP.
**Why:** Schema default is "UNKNOWN"; `monitors/route.ts` POST explicitly creates "PENDING"; `cron-logic.ts` only sends on transitions from PENDING or DOWN. Verified in-repo — this is exactly the kind of accidental behavior characterization must pin.
**How to avoid:** Pin BOTH paths as separate cases; seed initial status explicitly per case.
**Warning signs:** Telegram-mock assertion failures only for fresh-seed tests.

### Pitfall 5: `prisma.ts` reads DATABASE_URL at module load
**What goes wrong:** Integration tests import `@/lib/prisma` before the docker DATABASE_URL is set → singleton binds to the wrong DB (or throws).
**How to avoid:** Set `process.env.DATABASE_URL` in `globalSetup` (or `.env.test` loaded by vitest `env` config) before any test module imports; the singleton caches on `globalThis` in non-production mode.
**Warning signs:** ECONNREFUSED against localhost:5432 instead of the docker port.

### Pitfall 6: In-memory rate limiter pollutes consecutive handler tests
**What goes wrong:** `monitors` POST tests hit `rateLimit(20/min)` — the per-IP Map survives across cases in the same worker; test 21 fails with 429.
**How to avoid:** Same registry-reset pattern as db-batcher for files that exercise rate-limited routes (mock or reset `@/lib/rate-limit`), or keep each route's handler tests one-file-per-route with `vi.resetModules()`.
**Warning signs:** 429s in test N that pass in isolation.

### Pitfall 7: Local pnpm 11.10.0 (standalone) vs corepack-pinned pnpm 10
**What goes wrong:** The dev machine already has standalone pnpm 11.10.0 on PATH. With `packageManager: "pnpm@10.34.5"`, corepack shims and the standalone binary can fight depending on PATH order — `pnpm --version` differs by shell.
**How to avoid:** Verify `which pnpm` / `pnpm --version` resolves to the corepack shim inside the repo after `corepack enable`; if the standalone install wins, either remove it or rely on corepack's project-local shim. Document the check as a task step, and note pnpm 10 vs 11 config differences (`onlyBuiltDependencies` vs `allowBuilds`) make version drift load-bearing here.
**Warning signs:** Lockfile format 9.x vs 10.x flip-flopping; "unknown option" errors from pnpm 11-only flags.

### Pitfall 8: Theme-dependent UI renders before mount → hydration mismatch
**What goes wrong:** Toggle icon or Toaster reads `useTheme()` on the server where values are `undefined`; SSR HTML ≠ client first render.
**How to avoid:** `mounted` state guard (`useEffect(() => setMounted(true), [])`) before rendering theme-dependent output; `suppressHydrationWarning` on `<html>` (one level deep — exactly where next-themes writes). next-themes-documented pattern.
**Warning signs:** React hydration warnings in console; icon flicker.

### Pitfall 9: `:root` becomes light — anything styled outside `.dark *` scope changes
**What goes wrong:** After the split, `:root` is the light palette. Elements not covered by the dark variant (`&:is(.dark *)` matches DESCENDANTS of html.dark — the html element itself never matches) or code paths that read CSS vars without the dark class (e.g., plain HTML emails, canvas, chart libs) get light values.
**How to avoid:** Keep the hardcoded `bg-[#121212]`-style body styles converting to `bg-background text-foreground` (body IS a `.dark *` descendant — fine); audit the handful of utilities with inline rgba (`glass-panel`, `red-glow`, `red-gradient-text`) to derive from vars; exclude `mail.ts` email HTML from token migration (email clients don't support CSS vars).
**Warning signs:** White flash before paint on first load (means the pre-paint script isn't running — check ThemeProvider actually wraps children).

### Pitfall 10: Windows dev machine vs deploy-path Unix-isms
**What goes wrong:** verify scripts using `VAR=x cmd` syntax or Playwright `gracefulShutdown` relying on SIGTERM break on Windows (SIGTERM/SIGINT unsupported — playwright.dev-documented).
**How to avoid:** Keep pnpm scripts to plain command chains (`a && b && c` works in cmd); pass env via config files (vitest/playwright config `env`), not inline shell syntax; accept Windows kill-fallback for webServer teardown (orphaned node processes on Windows are cosmetic for a one-test suite — kill by port if annoying).
**Warning signs:** `VAR is not recognized` errors; port 3100 stuck in use between runs.

### Pitfall 11: Stale next.config duplicates make the flip a no-op
**What goes wrong:** `next.config.js` / `next.config.mjs` exist alongside `next.config.ts`; if Next resolves a stale duplicate, removing `ignoreBuildErrors` from the `.ts` file changes nothing.
**How to avoid:** Delete the stale duplicates in the same change as the flip (repo-read confirms they exist).
**Warning signs:** `next build` still succeeds with intentional type errors introduced as a canary.

### Pitfall 12: Stray `allowScripts` field masquerading as pnpm config
**What goes wrong:** package.json contains `allowScripts: {"@prisma/engines@7.9.1": true, …}` — looks like build-script approval but is read by no tool (audit §22 already flagged it).
**How to avoid:** Remove it during the pnpm migration; the REAL config is `onlyBuiltDependencies`/`allowBuilds` in `pnpm-workspace.yaml` [CITED: pnpm.io/settings/build].
**Warning signs:** pnpm still warning about ignored build scripts after "configuring" the dead field.

## Don't Hand-Roll (key insight recap) — Code Examples

Verified patterns from official sources and repo reads:

### Vitest config with path alias + global setup
```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/setup/global-setup.ts"],
    testMatch: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") }, // manual alias — no extra plugin needed
  },
});
```

### Global setup: refuse non-local databases, push schema once
```ts
// tests/setup/global-setup.ts — runs BEFORE any test module (so prisma.ts env is right)
export default async function globalSetup() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!/^(localhost|127\.0\.0\.1|.*\.docker\.internal)$/.test(url.hostname)) {
    throw new Error(`Refusing integration tests against non-local host: ${url.hostname}`);
  }
  const { execSync } = await import("node:child_process");
  // Interim schema authority until Phase 3 (runbook M-step contract): prisma db push
  execSync("pnpm exec prisma db push --skip-generate --force-reset", { stdio: "inherit" });
}
```

### Characterization test: cron-logic (FND-05 shape)
```ts
// tests/integration/cron-logic.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/telegram", () => ({
  sendTelegramAlert: vi.fn().mockResolvedValue({ ok: true }),
}));

import { sendTelegramAlert } from "@/lib/telegram";
import { prisma } from "@/lib/prisma";
import { runCronChecks } from "@/lib/cron-logic";

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE users, monitors, pings, incidents, feedbacks RESTART IDENTITY CASCADE`
  );
});
afterEach(() => vi.clearAllMocks());

it("pins 1-strike DOWN: UP monitor + HTTP 500 → DOWN ping + ONGOING incident + ALERT", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
  const user = await prisma.user.create({
    data: { email: "u@t.dev", telegramChatId: "42", timezone: "UTC" }, // fresh timestamps (cleanup pitfall)
  });
  await prisma.monitor.create({
    data: { userId: user.id, name: "m", url: "https://t.dev", status: "UP", isActive: true,
            interval: 5, lastChecked: new Date(Date.now() - 10 * 60_000) }, // due
  });

  await runCronChecks();

  const m = await prisma.monitor.findFirstOrThrow();
  expect(m.status).toBe("DOWN");
  expect(m.failedChecks).toBe(1);
  const ping = await prisma.ping.findFirstOrThrow();
  expect(ping.status).toBe("DOWN");
  const incident = await prisma.incident.findFirstOrThrow();
  expect(incident.status).toBe("ONGOING");
  expect(sendTelegramAlert).toHaveBeenCalledWith("42", expect.stringContaining("ALERT"));
  vi.unstubAllGlobals();
});
```

### Module-state isolation: db-batcher (FND-06 shape)
```ts
// tests/integration/db-batcher.test.ts — NO static import of db-batcher
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

beforeEach(() => { vi.resetModules(); /* fresh pendingPings/pendingMonitorUpdates per case */ });

it("aggregates two routine UP checks into one flush + monitor counters", async () => {
  const { queueRoutineCheck, flushBatches } = await import("@/lib/db-batcher");
  queueRoutineCheck(1, "UP", 120);
  queueRoutineCheck(1, "UP", 140);
  await flushBatches();
  const pings = await prisma.ping.findMany({ where: { monitorId: 1 } });
  expect(pings).toHaveLength(2);
  // …monitor counters, latest status/lastChecked math, DOWN-counts-as-failure case…
});
```

### Handler-import harness (API contracts)
```ts
// tests/api/monitors.handler.test.ts
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { monitor: { findMany: vi.fn() } } }));

import { getServerSession } from "next-auth";
import { GET } from "@/app/api/monitors/route";

it("401s without session — response body pinned VERBATIM (typo included)", async () => {
  vi.mocked(getServerSession).mockResolvedValue(null);
  const res = await GET(new NextRequest("http://localhost/api/monitors"));
  expect(res.status).toBe(401);
  await expect(res.json()).resolves.toEqual({ error: "Unauthirized" }); // deliberate: today's contract
});
```

### Playwright config (webServer against built artifact)
```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "pnpm start",                    // next start -p 3100 on the just-built artifact
    url: "http://localhost:3100/login",       // readiness: 2xx/3xx (+400/401/402/403 accepted)
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      CRON_MODE: "vercel",                    // CRITICAL: suppress node-cron in instrumentation.ts
      DATABASE_URL: process.env.TEST_DATABASE_URL!,
      PORT: "3100",
    },
  },
});
```

### Theme components (THM-01/02)
```tsx
// src/components/theme/ThemeProvider.tsx
"use client";
import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
```

```tsx
// src/components/theme/ThemeToggle.tsx — cycles Light → Dark → System (D-23)
"use client";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

const CYCLE = ["light", "dark", "system"] as const;

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="size-9" aria-hidden />; // layout-stable placeholder

  const next = CYCLE[(CYCLE.indexOf((theme ?? "dark") as (typeof CYCLE)[number]) + 1) % 3];
  // icon: theme === "system" ? MonitorIcon : theme === "dark" ? MoonIcon : SunIcon (sets already in tree)
  return (
    <button onClick={() => setTheme(next)} title={`Theme: ${theme}`} aria-label="Toggle theme">
      {/* icon + tooltip per D-23 */}
    </button>
  );
}
```

```tsx
// src/components/theme/ThemedToaster.tsx — replaces direct <Toaster/> in server layout
"use client";
import { useTheme } from "next-themes";
import { Toaster } from "sonner";

export function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster richColors position="top-right" theme={resolvedTheme === "light" ? "light" : "dark"} />;
}
```

### pnpm wiring (FND-01/03)
```yaml
# pnpm-workspace.yaml — pnpm 10's config home even for a single-package repo
onlyBuiltDependencies:      # pnpm 9/10 form (D-08's wording)
  - "@prisma/client"
  - prisma
  - unrs-resolver
# Forward-compatible alternative (≥10.26, survives pnpm 11 — recommended if pinning 10.34.5):
# allowBuilds:
#   "@prisma/client": true
#   prisma: true
#   unrs-resolver: true
```

```json
// package.json (additions)
{
  "packageManager": "pnpm@10.34.5",
  "engines": { "node": ">=22 <25" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "verify": "docker compose -f docker-compose.test.yml up -d --wait && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e"
  }
}
```

```
# .nvmrc
24
```

### globals.css palette split (THM-01/03 sketch)
```css
:root {
  /* light — neutral zinc mirror (D-22) */
  --background: #fafafa;
  --card: #ffffff;
  --border: #e4e4e7;             /* zinc-200 */
  --primary: #ef4444;            /* brand red — unchanged */
  --muted-foreground: #71717a;   /* zinc-500 */
  /* status tokens — curated light variants (D-25) */
  --status-up: #16a34a;          /* green-600 */
  --status-down: #dc2626;        /* red-600 */
}
.dark {
  /* today's values — BYTE-IDENTICAL */
  --background: #121212;
  --card: #27272a;
  --primary: #ef4444;
  --muted-foreground: #a1a1aa;
  --status-up: <today's UP green hex>;
  --status-down: <today's DOWN red hex>;
  /* borders stay rgba(255,255,255,0.1) etc. */
}
/* @custom-variant dark and @theme inline mapping already exist — extend @theme inline
   with --color-status-up/down; do NOT invent a parallel token system */
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| pnpm `onlyBuiltDependencies` | `allowBuilds` map in `pnpm-workspace.yaml`; `onlyBuiltDependencies` REMOVED in pnpm 11; codemod `pnpx codemod run pnpm-v10-to-v11` | allowBuilds added v10.26.0; removal in pnpm 11 | Pinning 10.34.5 can use either; `allowBuilds` is the forward-compatible choice (pinned pnpm can still be re-pointed later without config rewrite) |
| `strictDepBuilds` opt-in | Default true — install FAILS on unreviewed build scripts | v10.3.0 | After `pnpm import`, first install will hard-stop until build scripts are approved — expected, configure the field in the same task |
| corepack as pnpm's documented install path | pnpm.io/installation documents standalone script / `npx get-pnpm` / `pnpm self-update`; pnpm 12 is a standalone native binary | docs observed 2026-09-10 | Corepack + `packageManager` still functions on Node 24 (locked D-08 stands); runbook should carry the standalone-script fallback |
| Node 22 LTS | Node 24 "Krypton" LTS (maintenance 2026-10-20, EOL 2028-04-30); Node 26 LTS lands 2026-10-28 | 24 LTS start 2025-10-28 [VERIFIED: nodejs/release schedule.json] | D-06's pin is current for the whole milestone window |
| vitest 4.x | vitest 5.0.0 released 2026-09-03 | 2026-09-03 | New scaffold on ^4.1.11 (maintained, docs match); 5.x evaluation is post-phase deliberate work (D-07 spirit) |
| Playwright webServer `port` | `url`-based readiness (accepts 2xx/3xx + 400/401/402/403) | `port` deprecated | Use `url`; `/login` (200) or any redirect works as readiness probe |

**Deprecated/outdated:**
- `typescript.ignoreBuildErrors: true` — still supported in Next 16 but default false; this phase deletes it (FND-02)
- `next.config.js` / `next.config.mjs` duplicates in this repo — delete at flip time
- package.json `allowScripts` field — dead config, remove during migration
- `@types/node` ^20 vs Node 24 runtime — mismatch to resolve during the typecheck wave (upgrade types to match the 24 pin)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | docker tags `postgres:17-alpine` / `redis:8-alpine` are current stable majors | Standard Stack / Env | LOW — any supported major works for characterization (schema pushed via prisma db push); swap tag if pull fails |
| A2 | Production Postgres major version is unknown (docker fidelity unconfirmed) | Open Questions | LOW — characterization semantics don't depend on major; match later via `SELECT version()` |
| A3 | sonner `theme` prop accepts "light"/"dark"/"system" union | Code Examples | LOW — "dark" usage verified in-repo (layout.tsx); wrapper narrows to "light"/"dark" anyway |
| A4 | Corepack remains available/bundled on the Node 24 LTS line for the milestone window | Standard Stack | MEDIUM — pnpm.io de-emphasized corepack; if a future Node 24.x drops it, runbook's standalone-script fallback covers VPS; dev machine already has standalone pnpm |
| A5 | vitest 4.1.13's `vi.*` API matches the latest docs fetched (api/vi) | Code Examples | LOW — vi.mock/resetModules/stubGlobal semantics stable across 4.x; docs fetched are current |
| A6 | Next 16.3.4 docs describe the installed ^16.0.10's `typescript` option behavior | Standard Stack | LOW — option exists in both; verify empirically during flip (canary error → build must fail) |
| A7 | `pnpm-workspace.yaml` with only settings (no `packages`) is valid for a single-package repo on pnpm 10 | Code Examples | MEDIUM — if pnpm requires `packages`, add `packages: ["."]`; one-line fix, discoverable at first `pnpm install` |
| A8 | `engines: ">=22 <25"` range is the right floor expression (discretion item recommended yes) | Code Examples | LOW — expression detail; planner may choose `>=22` |

## Open Questions

1. **pnpm major line for the `packageManager` pin**
   - What we know: D-08 locks "pnpm 10 via corepack"; 10.34.5 is the latest pnpm-10; pnpm 11/12 exist with config-format changes.
   - What's unclear: whether the user wants forward-compat config (`allowBuilds`) on the 10.x pin now.
   - Recommendation: pin `pnpm@10.34.5` per the locked decision, use `allowBuilds` in pnpm-workspace.yaml (supported ≥10.26, survives a later 11 bump); note it in the plan for user visibility.
2. **Production Postgres major version (docker fidelity)**
   - What we know: unknown; characterization pushes schema via prisma db push.
   - Recommendation: default `postgres:17-alpine`; opportunistically run `SELECT version()` on the VPS at the next real deploy and align the compose tag then (one-line change).
3. **`ecosystem.config.js` `script: "npm"` → pnpm timing**
   - What we know: PM2 only re-reads the file on `pm2 startOrReload ecosystem`; editing in-repo now is inert until then, but creates a window where repo and VPS disagree.
   - Recommendation: edit it as part of the documented D-26 switch (runbook-gated), not as a standalone Phase 2 commit — keeps "repo-only, nothing VPS-touching" honest.
4. **`.nvmrc` granularity: `24` vs `24.15.0`**
   - Recommendation: `24` (major pin, NVM resolves latest 24.x) — matches "24 LTS" language of D-06; strict-pinning exact patches adds churn with no safety gain on a single-dev, single-VPS project.
5. **E2E server mode: `next start` on built artifact vs `next dev`**
   - Recommendation: `next start` (verify chain already builds; production-behavior fidelity; fast warm boot). If the 5-minute budget strains, `next dev` is the documented fallback.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | FND-03 runtime pin | ✓ | 24.15.0 (matches D-06) | — |
| pnpm | FND-01 | ✓ (standalone) | 11.10.0 — **differs from pinned 10.34.5**; corepack shim must win (Pitfall 7) | corepack enable |
| corepack | FND-01/D-08 | ✓ | 0.34.6 | pnpm standalone install (11.x) |
| Docker Engine | FND-04 test stack | ✓ | 29.7.2 | — |
| docker compose | FND-04 / `pnpm verify` | ✓ | v5.5.0 (compose subcommand) | — |
| Docker Hub pull access | postgres/redis images | ✓ (images not pre-pulled) | — | Pre-pull in Wave 0 (`docker compose pull`) |
| Playwright browsers | E2E smoke | ✗ (not installed) | — | `pnpm exec playwright install` in Wave 0 |
| ngrok | none (removal target) | present — 33 MB binary + ngrok.log tracked | — | `git rm` (FND-07) |
| `.env.example` | FND-07 | ✗ (does not exist) | — | Create from audit Appendix A inventory |
| VPS access | D-26 | ✗ (out of scope by decision) | — | Runbook documents the one-time switch |

**Missing dependencies with no fallback:** none blocking — Playwright browsers and image pulls are Wave 0 install steps, not blockers.
**Missing dependencies with fallback:** pnpm-version mismatch (standalone 11 vs pinned 10) — corepack project shim resolves it; VPS steps — runbook deferral is the decision itself (D-26).

## Validation Architecture

> `workflow.nyquist_validation` is `true` in `.planning/config.json` — section included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.11 + @playwright/test 1.63.0 — **Wave 0 install** (repo currently has ZERO tests; ad-hoc root scripts deleted per D-09) |
| Config file | `vitest.config.ts` + `playwright.config.ts` — none today (Wave 0) |
| Quick run command | `pnpm vitest run tests/integration/cron-logic.test.ts` |
| Full suite command | `pnpm verify` (docker up → lint → typecheck → vitest → build → playwright) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FND-01 | pnpm lockfile installable, npm artifacts gone | command gate | `pnpm install --frozen-lockfile` | ❌ Wave 0 (script/config) |
| FND-02 | tsc clean + build fails on type errors | command gate | `pnpm typecheck && pnpm build` (canary-error check during flip) | ❌ Wave 0 (config) |
| FND-03 | Node version standardized | manual one-time | `node --version` matches `.nvmrc` | n/a |
| FND-04 | Suite runs against docker PG/Redis | smoke | `pnpm test` (containers up) | ❌ Wave 0 |
| FND-05 | due-filter; 200-399=UP else DOWN; PENDING→UP "MONITORING STARTED"; UP→DOWN "ALERT"; DOWN→UP "RECOVERY"; UNKNOWN→UP NO message; incident open (DOWN, desc w/ statusCode‖Timeout) / resolve (UP after DOWN); no-change → batcher queue; uptime clamp 0-100; force/specificMonitorId paths; 10s timeout; redirect-follow | integration | `pnpm vitest run tests/integration/cron-logic.test.ts` | ❌ Wave 0 |
| FND-06 | db-batcher enqueue aggregation, flush math (counts, latest status/rt, lastChecked), failure-swallow loss; API: 401-no-session (verbatim typo bodies), ownership scoping, 400 validation, 403 limit, 429 rate-limit, 201/200 shapes, cron routes, telegram webhook unauthenticated defect pinned | integration + API | `pnpm vitest run tests/integration/db-batcher.test.ts tests/api` + `pnpm test:e2e` (core routes HTTP-level) | ❌ Wave 0 |
| FND-07 | no ngrok, `.env.example` complete, no error-message leaks | grep checks | `rg -n "details: error.message" src/` → 0 after fix; file existence | ❌ (fix + greps) |
| THM-01 | default dark identical; light palette loads; no FOUC/mismatch | e2e + manual visual | smoke spec asserts `documentElement.classList` contains "dark" before/after toggle cycle; human visual check both palettes | ❌ Wave 0 |
| THM-02 | toggle cycles L→D→S in dashboard header + auth layout; Toaster follows resolvedTheme | e2e + manual | same smoke spec (click cycle, assert class changes) | ❌ Wave 0 |
| THM-03 | hexes → tokens, dark byte-identical | grep + manual visual | `rg -c "#[0-9a-fA-F]{3,8}" src/` delta report; computed-style spot check | ❌ (migration + greps) |
| DEP-04 | `pnpm verify` exists, ≤5 min warm | timed manual run | `time pnpm verify` recorded in plan verification | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted vitest file(s) for the touched area (`pnpm vitest run <file>`, <30 s warm)
- **Per wave merge:** `pnpm test` (full vitest suite) + `pnpm lint && pnpm typecheck`
- **Phase gate:** full `pnpm verify` green + D-21 mutation spot-check records (three deliberate breaks each proven red, then reverted) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `vitest.config.ts` — alias, globalSetup, node env (FND-04/05/06)
- [ ] `playwright.config.ts` — webServer, CRON_MODE=vercel env (FND-04, DEP-04)
- [ ] `docker-compose.test.yml` — postgres + redis, offset ports, healthchecks (FND-04)
- [ ] `tests/setup/global-setup.ts` — localhost DB guard + schema push (FND-04/05)
- [ ] `tests/setup/seed.ts` — SQL seed helpers, fresh-timestamp discipline
- [ ] `tests/integration/cron-logic.test.ts` — FND-05 cases (audit §23 transcription)
- [ ] `tests/integration/db-batcher.test.ts` — FND-06 batcher cases
- [ ] `tests/api/_harness.ts` + route test files — FND-06 contracts (D-17 scope)
- [ ] `tests/e2e/smoke.spec.ts` — D-18 login → dashboard (+ theme class assertions)
- [ ] Framework install: `pnpm add -D vitest@^4.1.11 @playwright/test@1.63.0 && pnpm exec playwright install`
- [ ] `.env.test` (or vitest env config) — DATABASE_URL for docker; NEVER the production URL

## Security Domain

> `security_enforcement: true`, ASVS level 1, block_on high — section required.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (pin only — no auth changes) | NextAuth JWT unchanged; characterization pins 401 on all session-guarded routes; telegram-webhook's **unauthenticated-access defect pinned as-is by deliberate decision D-17** (Phase 6 SEC-03/S-2 makes it red→green) |
| V3 Session Management | no | JWT strategy untouched this phase |
| V4 Access Control | yes (pin only) | Ownership-scoping WHERE clauses pinned by API tests; D-21's mutation (drop an ownership WHERE) must turn the suite red — the spot-check IS the access-control regression proof |
| V5 Input Validation | yes (pin only) | Route validation behavior (400 paths, `new URL` parse failure, monitor-limit 403) pinned verbatim |
| V6 Cryptography | no | No new crypto; bcryptjs usage untouched |

### Known Threat Patterns for this phase's work

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Test suite writing to production database (live prod system!) | Tampering / Destruction | `globalSetup` hard-fails on non-localhost `DATABASE_URL` hostname (see Code Examples); `.env.test` never contains prod URLs; docker ports offset from 5432/6379 defaults |
| Information disclosure via error responses | Information Disclosure | FND-07 fixes the single known leak (`monitors/route.ts` GET returns `details: error.message`); grep gate keeps it fixed |
| Secret accepted via query string (cron routes, CRON_SECRET) | Elevation/Spoofing | Known defect (audit R15/S-4, fixed Phase 6 SEC-06); characterization pins current behavior — do NOT "helpfully" fix it this phase (would break the red→green plan) |
| Unauthenticated telegram webhook | Elevation | Same as above — pinned defect (S-2, Phase 6) |
| `.env.example` leaking real values | Information Disclosure | Names + purpose comments ONLY (discretion item, FND-07) |
| ngrok.log containing historical tunnel URLs | Information Disclosure | `git rm` binary + log (FND-07); history rewrite explicitly out of scope |
| Deleting deploy.yml orphaning GitHub secrets | — | Non-issue: workflow deletion is the control (D-01); note in runbook that repo secrets can be pruned manually at leisure |

**Enforcement note:** block_on=high — none of the pinned-defect decisions (webhook, query-string secret) constitute NEW vulnerabilities introduced by this phase; they are documented, scheduled remediations whose test coverage this phase creates. The test-DB safety guard is a NEW high-value control this phase adds.

## Sources

### Primary (HIGH confidence)
- Codebase reads (this session): `src/lib/cron-logic.ts`, `src/lib/db-batcher.ts`, `src/lib/cleanup-logic.ts`, `src/lib/prisma.ts`, `src/lib/telegram.ts`, `src/instrumentation.ts`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/api/monitors/route.ts`, `next.config.ts`, `package.json`, `tsconfig.json`, `prisma/schema.prisma`, `ecosystem.config.js`, `components.json` + hex-count grep (initially recorded 254; re-measured 2026-09-10 at 303 raw / 237 after full-file exclusions — see THM-03)
- npm registry (`npm view`, 2026-09-10): next-themes 0.4.6, vitest 4.1.11/5.0.0, @playwright/test 1.63.0, pnpm 10.34.5/11.26.0/12.3.4, sonner 2.0.8; package-legitimacy gate executed
- nodejs/release `schedule.json` (fetched 2026-09-10): Node 24/22/26 LTS dates

### Secondary (MEDIUM confidence)
- [pnpm.io/settings/build] — `allowBuilds` (≥10.26) / `onlyBuiltDependencies` (removed in 11), `strictDepBuilds`, codemod
- [pnpm.io/cli/import] — lockfile conversion preserves resolved versions
- [pnpm.io/installation] — corepack no longer documented; standalone script; pnpm 12 native binary
- [nextjs.org docs — typescript config, v16.3.4, updated 2026-03-18] — `ignoreBuildErrors` default false
- [playwright.dev/docs/test-webserver] — url readiness (2xx/3xx/400/401/402/403), reuseExistingServer, env inheritance, gracefulShutdown Windows caveat
- [vitest.dev/api/vi] (two fetches) — vi.mock hoisting/aliases/factories, vi.resetModules semantics (static imports not re-evaluated; mocks registry not reset), vi.stubGlobal/unstubAllGlobals, doMock/doUnmock, clear/reset/restoreAllMocks distinctions
- [github.com/pacocoursey/next-themes README] — ThemeProvider props, useTheme, suppressHydrationWarning, FOUC injection, mounted-guard pattern

### Tertiary (LOW confidence)
- Docker image tags (postgres:17-alpine, redis:8-alpine) — [ASSUMED], WebSearch rate-limited this session
- Sonner `theme` prop union breadth — landing page doesn't document it; in-repo `"dark"` usage is the evidence base [ASSUMED for the union]
- Corepack's long-term bundling in Node distributions — [ASSUMED] from training; corroborated only by pnpm.io dropping it from install docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version registry-verified; every package legitimacy-checked; docs fetched from official domains
- Architecture: HIGH — test seams and theme seams verified by direct code reads; pitfall list is repo-grounded, not generic
- Pitfalls: HIGH — 10 of 12 pitfalls verified in-repo or in official docs; the 2 partially-assumed items (A1 docker tags, A4 corepack) carry explicit fallbacks

**Research date:** 2026-09-10
**Valid until:** 2026-10-10 (stable tooling domain; revisit vitest/playwright pins if the phase slips past mid-October — both released fresh majors in September)
