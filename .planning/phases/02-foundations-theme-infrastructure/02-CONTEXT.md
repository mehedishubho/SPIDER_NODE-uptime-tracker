# Phase 2: Foundations & Theme Infrastructure - Context

**Gathered:** 2026-09-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the safety net before any risky migration — pnpm + Node 24 pinning, the typecheck flip (`ignoreBuildErrors` off), Vitest + Playwright scaffolding on docker-compose Postgres/Redis, the characterization suite pinning current monitoring behavior, repo hygiene (deploy.yml, ngrok, test scripts, `.env.example`), and light/dark theme infrastructure. **Zero change to monitoring behavior** — the suite pins today's behavior, defects included.

**Operational reframe (user-directed, supersedes PROJECT.md's deploy description):** deployment is **fully manual from this phase on — no GitHub CI/CD at all**. DEP-04's "CI gates" become a local `pnpm verify` command run by hand before deploying; the deploy itself is typed-by-hand steps documented in the runbook. No deploy scripts or artifact tooling are built in this phase ("no readymade system, make everything default").

</domain>

<decisions>
## Implementation Decisions

### CI/CD removal & manual deployment
- **D-01:** Delete `.github/workflows/deploy.yml` in this phase — fully manual deployment, **no GitHub Actions at all** (not even CI-only). Side benefit: removes the `prisma db push --accept-data-loss`-on-every-deploy hazard from the deploy path immediately.
- **D-02:** The gate chain (lint → typecheck → unit/integration → build) lives in a single local **`pnpm verify`** command that auto-starts the docker Postgres/Redis containers for tests. This is the ONLY script added; gate enforcement is operator discipline (run verify before shipping).
- **D-03:** **No deploy automation or artifact tooling from us** — no `pnpm deploy`, no scripts, no SCP helpers (user: "I will deploy it manually, no readymade system, make everything default"). The runbook documents the typed sequence; the default safe path is build on the dev machine and ship artifacts (the VPS should not build Next 16 itself — the 2 GB memory flag and deploy.yml's "small servers" comment exist for this reason).
- **D-04:** Post-deploy verification is **typed checks in the runbook** (curl the app, `pm2 status`, glance at logs). No smoke script; no `readyz` endpoint exists until Phase 4's worker.
- **D-05:** Phase 2 deploys run **no schema command** (no schema changes in this phase) — consistent with the runbook's phase-conditional Migrate step (Phase 2 = no migrate).

### Node & pnpm foundations
- **D-06:** **Node 24 LTS** pinned identically across dev machine, verify environment, and VPS (`.nvmrc`, `package.json` engines) — VPS is Ubuntu 24.04 loading Node via NVM; backward-compatibility floor of 22 is acceptable (BullMQ 6 and Next 16 both support it; 24 is a superset of 22).
- **D-07:** **`pnpm import` — exact freeze**: convert `package-lock.json` to `pnpm-lock.yaml` preserving every resolved version, then delete the npm lockfile. Zero dependency drift while the characterization suite pins behavior — any suite-observable change can only come from our edits. Version upgrades become deliberate later work.
- **D-08:** pnpm 10 via corepack (`packageManager` field in package.json); `onlyBuiltDependencies` configured for prisma engines and other build-script packages; npm artifacts (`package-lock.json`, npm `node_modules`) removed.
- **D-09:** **Delete all four root ad-hoc scripts** (`test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`) — they require live credentials, are superseded by the characterization suite, and git history preserves them.

### Typecheck flip (FND-02)
- **D-10:** **Fix-all-then-flip**: size the pile (tsc + prisma generate) in the first task, fix every error, then turn `ignoreBuildErrors` off — one clean cutover; no suppression markers, no two-stage red gate.
- **D-11:** **Minimal churn** fix policy: smallest possible diff that makes types honest — assertions and precise annotations where code is correct, signature tweaks only where truly wrong. No refactors, no drive-by tightening; the suite pins behavior, not type elegance.
- **D-12:** **Escalation threshold**: if the pile exceeds **~100 errors**, stop and reconvene — split fixes into dedicated plan(s) with their own verification rather than letting one plan balloon. Under 100: just fix.
- **D-13:** The flip lands **early — in the phase's first plans** (alongside pnpm/Node work), so all later tasks run under a green typecheck. Sequenced with the suite per D-19.
- **D-14 (consequence):** deleting deploy.yml + shipping the build machine's generated client means the VPS never runs `prisma generate` (deploy.yml's `npx prisma generate` after `--omit=dev` was fetching prisma from the registry at deploy time — a wart this removes).

### Characterization suite (FND-04/05/06)
- **D-15:** Data-path tests (`runCronChecks`, `flushBatches`) run as **real-Postgres integration tests**: docker Postgres, seed via SQL, stub `fetch` (target URLs) and Telegram, call the functions **as-is** (no refactor-before-pin — `runCronChecks` is a single 220-line export and stays that way), assert actual rows. Matches audit §23's given/when/then cases with expected DB effects.
- **D-16:** API contract tests are **hybrid**: HTTP-level (Playwright request context against a booted real Next server + real Postgres; seeded user logs in over HTTP) for the core routes, handler-import (constructed NextRequest + mocked `getServerSession`/prisma) for the rest.
- **D-17:** Route scope = **rewrite-touched core ~10 routes**: monitors CRUD ×4 (list/create/update/delete), monitor check, incidents, public status ×2, cron/check, cron/cleanup, feedback. The Telegram webhook is pinned **as-is including today's unauthenticated-access defect** — deliberately, so Phase 6's S-2 fix is a visible red→green. Auth routes get shallow contracts only (register/validation status codes) — Phase 7 replaces NextAuth wholesale; deep characterization of soon-to-die code wastes effort.
- **D-18:** Playwright ships **scaffold + ONE smoke E2E**: config + webServer boot wired to the docker stack, one test (seeded-user login → dashboard renders with a seeded monitor) proving the scaffold runs. Feature-E2E work is Phase 8 (UI-04).
- **D-19:** **Risk-tiered sequencing** between fixes and suite: typecheck fixes in **monitored logic** (cron-logic, db-batcher, API routes) wait until their characterization tests are green; UI/type-only fixes proceed immediately. The suite's cron/batcher/API core lands in the same early wave as the flip.
- **D-20:** **`pnpm verify` runtime budget: ≤5 minutes** (docker warm) — cut scope or parallelize rather than ship a slow manual gate; a gate that takes 20 minutes gets skipped, defeating DEP-04.
- **D-21:** **Mutation spot-check task** proves the suite pins behavior: during execution, deliberately break pinned behaviors (1-strike→2-strike DOWN, drop an ownership-scoping WHERE clause, swap a Telegram message template), record the suite goes red each time, revert. This makes roadmap success criterion 2 ("deliberately changing any pinned behavior turns the suite red") an explicitly verified task.

### Theme infrastructure (THM-01/02/03)
- **D-22:** Light palette = **neutral zinc mirror** of today's dark: zinc/white family (≈#fafafa background, white cards, zinc-200 borders), same red brand identity (`#ef4444`). First-pass functional palette; Phase 8 refines (UI-03). Dark values stay byte-identical.
- **D-23:** Toggle = **cycle icon button** (sun/moon/monitor icons from existing icon sets) cycling Light → Dark → System, tooltip showing state. Placed in the **dashboard header AND the auth (login) layout**.
- **D-24:** **`defaultTheme="dark"`** in next-themes — every existing user sees exactly today's app until they opt in; the "dark visually identical to today" compatibility constraint holds by default, not just after toggle.
- **D-25:** Of the 237 hardcoded hexes, **only semantic status colors get curated light-mode variants** (UP green → green-600 family, DOWN red → red-600 family on light) so dashboards read correctly day one — this is a monitoring app; green/red IS the content. Everything else migrates mechanically to same-value tokens (dark byte-identical). Full per-hex review is Phase 8 UI-03 work.

### VPS cutover
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design source documents (amended by Phase 01, verdict READY)
- `docs/ARCHITECTURE-AUDIT.md` §23 — Testing Requirements: given/when/then test cases (SSRF, duplicate-incident, duplicate-alert + current-behavior cases) authored in Phase 01 (01-CONTEXT D-08) to be transcribed **directly** by this phase's characterization suite; §11 schema mapping (context for what tests seed); Appendix B rules
- `docs/ARCHITECTURE-REVIEW.md` — issue vocabulary (J/D/R/A/S/M/P IDs) and §9 checklist; verdict READY since 2026-09-09
- `docs/DEPLOY-RUNBOOK.md` — interim web-only topology (build → backup → migrate[no-op in Phase 2] → web restart → smoke check); **this phase amends it**: manual-deploy steps (D-03/D-04), the one-time VPS Node/pnpm switch (D-26), and typed post-deploy checks (D-04)

### Planning artifacts
- `.planning/REQUIREMENTS.md` — FND-01..07, THM-01..03, DEP-04 (this phase's 11 requirements with pinned bounds)
- `.planning/PROJECT.md` — locked defaults Q-1..Q-5, behavior-compatibility constraint, rehearsal strategy (docker-compose local dev); note D-01..D-05 here **supersede** PROJECT.md's "GitHub Actions → SCP" deployment description
- `.planning/ROADMAP.md` §Phase 2 — goal + 4 success criteria (the contract this context serves)
- `.planning/phases/01-design-gate-review-verdict-ready/01-CONTEXT.md` — Phase 01 decisions that shaped the audit amendments this suite transcribes (esp. D-08 test-case format)
- `.planning/codebase/TESTING.md` — current zero-test state + recommended first targets
- `.planning/codebase/STACK.md` — current npm/tooling state the pnpm migration transforms

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@custom-variant dark (&:is(.dark *))` already in `src/app/globals.css` — the class strategy `next-themes` needs is pre-wired
- `@theme inline` token mapping (color-* → CSS vars) already complete in globals.css — THM-03's mechanical migration targets this existing token vocabulary; extend it (status tokens) rather than inventing a parallel system
- `src/components/ui/dropdown-menu.tsx` and the shadcn primitive set — available if the toggle needs them (cycle button chosen instead, D-23)
- Hugeicons/react-icons sun/moon/monitor icons already in the dependency tree for the toggle (D-23)
- `src/lib/prisma.ts` singleton over a `pg.Pool` — integration tests seed through SQL/prisma directly; no new client needed
- `ecosystem.config.js` — PM2 config unchanged this phase (D-03 "everything default")

### Established Patterns
- Route-handler template (session check → prisma select → try/catch `{ error }` responses) — handler-import tests (D-16) mock exactly two seams: `getServerSession` and `@/lib/prisma`
- Module-level mutable state in `db-batcher.ts` (`pendingPings` array + `pendingMonitorUpdates` Map) — test isolation needs module resets between cases (discretion)
- `runCronChecks(force, specificMonitorId)` single-export monolith — integration tests drive it whole with fetch/Telegram stubbed (D-15); the manual-check route calls the same function with an id

### Integration Points
- `src/app/layout.tsx` — ThemeProvider wraps here; Toaster gets the resolved-theme prop (THM-02)
- Root scripts deletion (D-09) touches nothing that imports them — they are standalone
- `next.config.ts` — the `ignoreBuildErrors: false` flip (D-10) plus deletion of stale `next.config.js`/`next.config.mjs` duplicates
- `.github/workflows/deploy.yml` — deleted (D-01); its mechanics become runbook prose (D-03), minus the `db push --accept-data-loss` step (D-05) and minus VPS-side `prisma generate` (D-14)
- 19 API routes at `src/app/api/**` — the ~10-route core set (D-17) maps to: `monitors/route.ts`, `monitors/[id]/route.ts`, `monitors/[id]/check/route.ts`, `monitors/[id]/details/route.ts`, `incidents/route.ts`, `status/route.ts`, `status/[userId]/route.ts`, `cron/check/route.ts`, `cron/cleanup/route.ts`, `feedback/route.ts`, plus `telegram/webhook/route.ts` pinned as-is

</code_context>

<specifics>
## Specific Ideas

- User's exact posture on deployment (quote): *"I will deploy it manually, no readymade system, make everything default"* — the runbook and any tooling decisions must respect this; when in doubt, document typed steps rather than build tooling
- User's Node choice (quote): *"as I use ubuntu 24.04 version so I would like to use 24 LTS with backward compatible with 22"*
- "Deliberately changing any pinned behavior turns the suite red" (ROADMAP success criterion 2) is treated as a first-class executable verification (D-21), not a review-time hope
- The mutation spot-check's canonical examples: 1-strike→2-strike DOWN, ownership-scoping WHERE removal, Telegram template swap

</specifics>

<deferred>
## Deferred Ideas

- Deploy automation / `pnpm deploy` script with embedded gates — deferred to Phase 4/5 P-1 pipeline revision where the worker topology forces the pipeline rewrite anyway (D-03)
- Light palette refinement, light-safe brand assets (Lottie overlays, sidebar token reconciliation) — Phase 8 UI-03 (D-22/D-25)
- Full per-hex light-mode review of all 237 hardcoded hexes — Phase 8 UI-03 (D-25)
- Feature-level E2E browser tests (abortable polling, hydration robustness) — Phase 8 UI-04 (D-18)
- Dependency version upgrades post-pnpm-import — deliberate future work, not this phase (D-07)
- `readyz` health endpoint — arrives with the Phase 4 worker (WRK-08); interim smoke stays typed checks (D-04)

</deferred>

---

*Phase: 2-Foundations & Theme Infrastructure*
*Context gathered: 2026-09-10*
