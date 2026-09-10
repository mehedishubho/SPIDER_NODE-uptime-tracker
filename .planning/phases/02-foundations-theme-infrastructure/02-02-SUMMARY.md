---
phase: 02-foundations-theme-infrastructure
plan: 02
subsystem: test-infrastructure
tags: [vitest, playwright, docker-compose, e2e, safety-guard, verify-chain]

requires:
  - phase: 02-01
  provides: pnpm toolchain rail, .env.example contract, build-env caveat (NEXT_PUBLIC_DEV_BASE_URL on env-less checkouts)
provides:
  - Health-gated docker test stack (Postgres 17 :5453, Redis 8 :6390) every later test plan runs against
  - Vitest scaffold (node env, @→src alias, globalSetup schema push) owning tests/**/*.test.ts
  - Playwright scaffold (e2e + api projects, webServer `next start -p 3100` with CRON_MODE=vercel — no test-server egress)
  - assertLocalDatabaseUrl localhost guard, proven by unit test — the suite physically cannot touch a non-local database (T-02-05)
  - E2E seed helpers (resetE2EData / seedE2EUser / seedMonitor) reused by 02-05 HTTP-level tests
  - pnpm verify gate chain definition (D-02)
affects: [02-03 redis wiring, 02-05 characterization suite, 02-06 typecheck flip (lint debt finding), 02-09 mutation proof, phase-08 feature-E2E]

tech-stack:
  added: [vitest ^4.1.11, @playwright/test 1.63.0, docker-compose.test.yml (postgres:17-alpine, redis:8-alpine)]
  patterns: [dotenv-in-runner-config with override-first .env.test + in-code docker default, raw-pg SQL seeding (PROJECT.md-sanctioned), localhost-guard before any destructive test machinery]

key-files:
  created: [docker-compose.test.yml, vitest.config.ts, playwright.config.ts, tests/setup/global-setup.ts, tests/setup/db-guard.test.ts, tests/setup/seed.ts, tests/e2e/smoke.spec.ts, tests/api/.gitkeep]
  modified: [package.json, .gitignore]

key-decisions:
  - "Test stack ports moved 5433/6380 → 5453/6390: the planned ports are held by LIVE sibling project stacks (devsroom_personal_tracker_db, devsroom-license-manager-redis) — moved our stack, did not touch theirs"
  - ".env.test could not be created this session (.env* write deny; the 02-01 tmp+mv allowance did not recur) — configs load .env.test override-first when present and fall back to an in-code localhost-docker constant, so the scaffold is fully functional either way; !.env.test gitignore negation is in place for when the file can be created"
  - "global-setup runs plain `prisma db push`: --skip-generate no longer exists in Prisma 7, and --force-reset both trips Prisma's AI-agent dangerous-action consent gate (honored, not evaded) and is unnecessary against the volume-less throwaway container — plain push fails closed on schema drift instead of silently wiping"
  - "E2E seeding goes through raw pg SQL (PROJECT.md-sanctioned alternative to the prisma singleton) — immune to @/ alias and prisma-client transpilation differences across runners"

patterns-established:
  - "Test env resolution: TEST_DATABASE_URL ?? docker default, asserted-local before any connection — never ambient DATABASE_URL"
  - "Playwright webServer env carries CRON_MODE=vercel + NEXTAUTH_URL/SECRET + NEXT_PUBLIC_DEV_BASE_URL; spec drives the UI, never raw HTTP (CSRF handled by next-auth/react)"
  - "Config-file type errors DO fail `next build` even with ignoreBuildErrors:true (Turbopack validates root TS configs) — relevant to 02-06"

requirements-completed: [FND-04, DEP-04]

coverage:
  - id: C1
    description: "docker compose -f docker-compose.test.yml up -d --wait brings up Postgres and Redis, both health-gated (FND-04)"
    requirement: FND-04
    verification:
      - kind: other
      - ref: "up -d --wait exits 0; ps --format json shows Health=healthy for both; pg_isready accepts on :5453 and redis-cli PONG on :6390 (probed via host.docker.internal from a container)"
      - status: pass
    human_judgment: false
  - id: C2
    description: "pnpm test (vitest run) executes in node env with the @→src alias against the docker Postgres and exits 0"
    requirement: FND-04
    verification:
      - kind: other
      - ref: "pnpm vitest run --passWithNoTests → 1 file / 5 tests passed, 1.7s wall warm; global-setup log shows schema push against localhost:5453/uptime_test"
      - status: pass
    human_judgment: false
  - id: C3
    description: "Non-local DATABASE_URL guard: prod-style URL throws /non-local/; localhost, 127.0.0.1, host.docker.internal pass (T-02-05)"
    requirement: FND-04
    verification:
      - kind: test
      - ref: "pnpm vitest run tests/setup/db-guard.test.ts → 5 passed (prod URL throws; three local forms pass; unparseable fails closed)"
      - status: pass
    human_judgment: false
  - id: C4
    description: "pnpm test:e2e boots next start -p 3100 with CRON_MODE=vercel against the docker Postgres; the ONE smoke E2E passes: seeded user logs in over real HTTP, dashboard renders the seeded monitor (D-18)"
    requirement: FND-04
    verification:
      - kind: test
      - ref: "pnpm build (NEXT_PUBLIC_DEV_BASE_URL injected) && pnpm test:e2e → 1 passed (11.3s incl. server boot); assertions: /dashboard URL, seeded monitor name visible, documentElement classList contains dark"
      - status: pass
    human_judgment: false
  - id: C5
    description: "pnpm verify exists as the single local gate chain (D-02): docker up --wait → lint → typecheck → test → build → test:e2e"
    requirement: DEP-04
    verification:
      - kind: other
      - ref: "grep '\"verify\"' package.json → 1; each link individually executed and timed this session. Recorded expectations: typecheck RED until 02-06 (plan-stated); lint RED from 397 pre-existing src/ errors (new finding, logged to deferred-items.md); build link needs NEXT_PUBLIC base-URL env on env-less checkouts (02-01 finding, still true)"
      - status: pass
    human_judgment: false

duration: 34min (2023s, 2026-09-10T15:21:28Z → 15:55:11Z)
completed: 2026-09-10
status: complete
---

# Phase 2 Plan 2: Test Infrastructure Scaffold Summary

**Docker Postgres/Redis test stack (health-gated, localhost-guarded), Vitest + Playwright scaffolds with a proven production-database safety guard, E2E seed helpers, exactly ONE smoke E2E (real server → real login → dashboard render), and the `pnpm verify` gate chain — the frame every characterization test in 02-05/02-09 rides on.**

## Performance

- **Duration:** ~34 min (2026-09-10T15:21:28Z → 15:55:11Z)
- **Tasks:** 3/3 (+1 housekeeping commit)
- **Files:** 10 (8 created, 2 modified)

## D-20 timing inputs (warm, this machine)

| verify-chain link | warm time |
|---|---|
| docker compose up -d --wait | ~4s |
| pnpm lint | ~5.5s (red — pre-existing debt) |
| pnpm typecheck | red until 02-06 (not timed as green) |
| pnpm test (vitest run) | **1.7s** |
| pnpm build | **5.8s** |
| pnpm test:e2e | **11.3s** (incl. webServer boot; test itself 3.2s) |

Green-path total ≈ 30s warm — the ≤5 min D-20 budget has an order of magnitude of headroom even before 02-06 makes typecheck green.

## Guard-proof output

```
pnpm vitest run tests/setup/db-guard.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```
(prod-style URL → /non-local/ throw; localhost, 127.0.0.1, host.docker.internal pass; unparseable/empty fails closed.)

## Task Commits

1. **Task 1: Docker test stack + runner configs + verify script** — `9627ba3`
2. **Task 2: Install test frameworks + safety global-setup** — `85e8d26`
3. **Task 3: E2E seed helpers + the ONE smoke E2E** — `5447f72`
4. Housekeeping: gitignore playwright test-results — `c04500d`

## Files Created/Modified

- `docker-compose.test.yml` — postgres:17-alpine :5453 + redis:8-alpine :6390, `pg_isready`/`redis-cli ping` healthchecks, fixed container names (spidernode-test-db / spidernode-test-redis)
- `vitest.config.ts` — node env, globalSetup, `include: tests/**/*.test.ts` (vitest owns .test.ts), manual `@`→src alias, .env.test(override)→docker-default env resolution
- `playwright.config.ts` — e2e + api projects, webServer `pnpm exec next start -p 3100`, url readiness `/login`, CRON_MODE=vercel
- `tests/setup/global-setup.ts` — assertLocalDatabaseUrl + prisma db push (interim schema authority until Phase 3)
- `tests/setup/db-guard.test.ts` — the guard's unit proof
- `tests/setup/seed.ts` — resetE2EData / seedE2EUser / seedMonitor / closeSeedPool; E2E_EMAIL/E2E_PASSWORD/E2E_MONITOR_NAME exported
- `tests/e2e/smoke.spec.ts` — the one smoke test
- `package.json` — typecheck/test/test:e2e/verify scripts; vitest ^4.1.11 + @playwright/test 1.63.0 devDeps
- `.gitignore` — `!.env.test` negation, `/test-results/`

## NextAuth login-flow quirks (for 02-05 HTTP-level tests)

1. **emailVerified must be set** or `authorize()` throws "Please verify your email address before logging in." — every seeded login user needs a non-null emailVerified.
2. **Email is lowercased + trimmed** before lookup (`credentials.email.toLowerCase().trim()`) — seed lowercase emails.
3. **`authorize()` throws (not returns null) on every failure path** — the client sees a CredentialsSignin-class error, not the thrown message; do not assert on the message text over HTTP.
4. **No server-side redirect on success**: the client (`signIn("credentials", { redirect: false })`) sets `window.location.href = callbackUrl` (default `/dashboard`) after `res.ok`. HTTP-level tests should assert the session cookie / `GET /api/auth/session`, never a 3xx.
5. **CSRF round-trip is mandatory over raw HTTP**: get `/api/auth/csrf`, then POST `email`/`password`/`csrfToken` (form-encoded) to `/api/auth/callback/credentials`.
6. **JWT session strategy** — session state lives in the `next-auth.session-token` cookie; NEXTAUTH_SECRET is required at the server (test value `test-secret` in playwright.config.ts).
7. Seeded password hashes: bcryptjs 10 rounds (matches `bcrypt.compare` in auth.ts).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Planned ports 5433/6380 occupied by live sibling stacks**
- **Found during:** Task 1 (docker compose up)
- **Issue:** `devsroom_personal_tracker_db` (Up, healthy) publishes 5433; `devsroom-license-manager-redis` (Up, healthy) publishes 6380 — active infrastructure for other projects on this shared dev machine
- **Fix:** Test stack moved to **5453/6390** (free, spaced from the sibling cluster); all references updated (compose file, both runner configs). Sibling stacks untouched per scope boundary.
- **Files modified:** docker-compose.test.yml, vitest.config.ts, playwright.config.ts
- **Committed in:** 9627ba3

**2. [Rule 3 - Blocking] `.env.test` creation denied by the environment**
- **Found during:** Task 1
- **Issue:** Write/Bash on `.env*` paths denied this session (02-01's tmp+mv allowance did not recur); the file cannot exist in this checkout
- **Fix:** Both runner configs load `.env.test` with `override: true` when present and fall back to an in-code localhost docker constant (`TEST_DATABASE_URL ?? postgresql://postgres:postgres@localhost:5453/uptime_test`); the `!.env.test` gitignore negation is committed so the file becomes committable wherever it can be created. Guard still enforces localhost either way. Intended content (for the operator, if desired): `DATABASE_URL=postgresql://postgres:postgres@localhost:5453/uptime_test` and the same value as `TEST_DATABASE_URL`.
- **Files modified:** vitest.config.ts, playwright.config.ts, .gitignore
- **Committed in:** 9627ba3

**3. [Rule 3 - Blocking] Prisma 7 flag changes in global-setup**
- **Found during:** Task 2 (first vitest run)
- **Issue:** `--skip-generate` no longer exists in Prisma 7 (db push never generates — CLI dumps help); `--force-reset` trips Prisma's AI-agent dangerous-action consent gate, which requires user consent this executor cannot self-grant
- **Fix:** Plain `pnpm exec prisma db push`. Honored the consent gate (no env-marker stripping). The target is a volume-less throwaway container — reset = `docker compose down && up -d --wait`; plain push also fails closed on destructive schema drift (demands explicit --accept-data-loss) instead of silently wiping. Schema-push link (interim authority until Phase 3) unchanged.
- **Files modified:** tests/setup/global-setup.ts
- **Committed in:** 85e8d26

**4. [Rule 1 - Bug] `testMatch` is jest vocabulary — vitest 4 property is `include`**
- **Found during:** Task 3 (pnpm build typecheck failed on vitest.config.ts)
- **Issue:** The research example config used `testMatch`; vitest 4.1.11 has no such property (verified against installed types) — `next build`'s TypeScript step failed the build on the config file even with `ignoreBuildErrors: true`
- **Fix:** `include: ["tests/**/*.test.ts"]` — same semantics (vitest owns .test.ts; playwright owns .spec.ts)
- **Files modified:** vitest.config.ts
- **Committed in:** 5447f72

**5. [Rule 3 - Blocking] Transient native crash in `next build` (environment)**
- **Found during:** Task 3 verification
- **Issue:** 2 of 4 build attempts died with 0xC0000005/SIGSEGV during page-data collection (Turbopack, 23 workers, machine loaded with sibling docker stacks)
- **Fix:** None possible/needed — every retry succeeded (warm build 5.8s). Documented in deferred-items.md; if verify's build step crashes, retry first.

---

**Total deviations:** 5 auto-fixed (1 bug, 4 blocking/environment accommodations)
**Impact on plan:** No scope creep; zero application-code changes (all commits touch test infrastructure, configs, and package.json scripts only). All must_have truths hold with the port-number and env-source substitutions noted above.

## Issues Encountered

- `pnpm lint` is red from **397 pre-existing errors (993 problems)**, all in src/ + global.d.ts — zero from this plan's files. Logged to deferred-items.md for 02-06 planning (FND-02's "lint gates green" needs a lint pass beyond the typecheck flip).
- The build's TypeScript step failed on a root config file despite `ignoreBuildErrors: true` — root TS configs are validated regardless; noted as a 02-06 input.
- Playwright 1.63 natively loads `.env.test` ("injected env (0)" with the file absent) — harmless synergy with the config-level dotenv load.

## User Setup Required

None for this plan. End-of-phase human check per plan: package legitimacy glance at npmjs.com/package/vitest (vitest-dev org) and npmjs.com/package/@playwright/test (microsoft/playwright), matching installed versions 4.1.11 / 1.63.0.

## Next Phase Readiness

- 02-03 (Redis wiring) installs against the running :6390 container via the pnpm rail
- 02-05 (characterization suite) reuses: the vitest scaffold + global-setup, the seed helpers, and the seven NextAuth quirks above for HTTP-level login tests; the `api` playwright project directory awaits its specs
- 02-06 should consume: the lint-debt finding, the config-file-typecheck behavior, and the build-env caveat (env-less checkouts need NEXT_PUBLIC base-URL injection for the build link)
- 02-09's mutation proof runs on this scaffold as-is

## Self-Check: PASSED

All 8 created artifacts exist on disk (docker-compose.test.yml, vitest.config.ts, playwright.config.ts, tests/setup/global-setup.ts, tests/setup/db-guard.test.ts, tests/setup/seed.ts, tests/e2e/smoke.spec.ts, tests/api/.gitkeep); all 4 commits found in git log (9627ba3, 85e8d26, 5447f72, c04500d).

---
*Phase: 02-foundations-theme-infrastructure*
*Completed: 2026-09-10*
