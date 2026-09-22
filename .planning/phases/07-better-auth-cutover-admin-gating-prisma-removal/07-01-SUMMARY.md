---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 01
subsystem: auth
tags: [better-auth, bcrypt, drizzle, postgres, migration, credentials, admin-roles, seed-script]

requires:
  - phase: 03-redis-drizzle-schema-ownership
    provides: drizzle schema authority + schema:gate empty-diff pipeline + migration runner journal (0000/0001)
  - phase: 04/05 worker + rehearsal machinery
    provides: operator-script fail-loud contract (enqueue-smoke), docker test stack harness discipline
  - phase: 06-thin-api-routes-email-abstraction
    provides: throw-early env convention (D-11 lineage), queue hooks delegation target (EML-04)
provides:
  - cutover migration 0002: additive account/session/verification tables + users.role/email_verified/banned/banReason/banExpires, credential backfill + OAuth reshape + D-23 boolean backfill (all ON CONFLICT idempotent)
  - scripts/seed-admin-roles.mjs with D-09 missing/empty/zero-match abort semantics
  - A-1 hash gate (src/lib/auth-password.ts): bcrypt prefix router + AUTH-09 lazy rehash keyed on hash equality (A1)
  - minimal Better Auth core (src/lib/auth.ts rewrite, worker-safe zero next-auth) + /api/auth catch-all [...all]/route.ts
  - src/lib/auth-legacy.ts interim home for authOptions (10 NextAuth-session routes keep serving until 07-03/07-04; dies at 07-08)
  - installed pins better-auth@1.7.5 + @better-auth/redis-storage@1.7.5; BETTER_AUTH_*/ADMIN_* env contract in .env.example
affects: [07-02 announcement blast, 07-03 auth expansion, 07-04 client swap, 07-05 Bull Board gate, 07-06 rehearsal, 07-08 deletion release]

actuals:
  tokens: 31012    # chars/4 over the realized diff (124049 chars, 28 files)
  tasks: 5
  commits: 4

tech-stack:
  added: [better-auth@1.7.5, "@better-auth/redis-storage@1.7.5"]
  patterns: [A-1 hash-prefix routing, lazy rehash-on-login, expand/contract dual auth stack (auth-legacy.ts), Better Auth core-schema init validation, operator seed script with abort semantics]

key-files:
  created:
    - drizzle/0002_better_auth_cutover.sql
    - scripts/seed-admin-roles.mjs
    - src/lib/auth-password.ts
    - src/lib/auth-legacy.ts
    - src/app/api/auth/[...all]/route.ts
    - tests/lib/auth-password.test.ts
    - tests/integration/cutover-migration.test.ts
    - tests/integration/better-auth-cutover.test.ts
  modified:
    - src/db/schema.ts
    - src/lib/auth.ts
    - drizzle/meta/_journal.json
    - drizzle/meta/0002_snapshot.json
    - package.json
    - pnpm-lock.yaml
    - .env.example
    - scripts/schema-gate.mjs
    - 10 NextAuth-session API routes (import repoint to @/lib/auth-legacy)

key-decisions:
  - "Package set approved by operator (mehedishubho), 2026-09-23 — better-auth@1.7.5, @better-auth/redis-storage@1.7.5, @bull-board/api@9.10.1, @bull-board/hono@9.10.1, hono@^4.13.8, @hono/node-server@^2.1.1, ipaddr.js ^2.x"
  - "D-08 one-way decision ratified by operator (mehedishubho), 2026-09-23 — Option A; ADMIN_EMAILS=mehedihassanshubho@gmail.com (operator-confirmed)"
  - "ADMIN_EMAILS roster value recorded verbatim for the snapshot canary and production .env at flip: mehedihassanshubho@gmail.com (D-10: exactly the operator's account email; operator-confirmed mehedishubho, 2026-09-23)"
  - "Better Auth core schema requires verification.createdAt (init-time validation, Pitfall 7 class) — column added inside 0002; plugin columns already present day-one"
  - "Adapter schema map keyed 'users' to honor user.modelName: 'users' — the plan's literal { user: schema.users } key is inconsistent with the modelName pin; canary suite proves the binding"
  - "Task 4's commit amended (070cf79 -> 04ccf58) after the Task 5 tracer surfaced the verification.createdAt init failure — the cutover migration is correct as committed; full Task 4 verification re-run green"

patterns-established:
  - "A-1 verify router: prefix-match $2a$/$2b$/$2y$ -> bcrypt.compare; unknown prefixes fail closed; lazy rehash UPDATE keyed on the salted legacy hash (A1) is fire-and-forget with logged (never rethrown) failures"
  - "Dual-stack interim: new auth modules stay free of next-auth (worker-safe); legacy NextAuth config lives in auth-legacy.ts until the deletion release"
  - "Better Auth route surface: better-auth/next-js export + per-verb handler map destructure (NOT the NextAuth single-function re-export shape)"
  - "schema-gate canonicalizations now three: gen_random_uuid default form, bool_ops, and pull's non-adoptable emailVerified property collision (TS1117)"

requirements-completed: [AUTH-01, AUTH-02, AUTH-03, AUTH-09]

coverage:
  - id: D1
    description: "Cutover migration 0002 backfill semantics: credential rows = users-with-password, per-provider reshaped counts equal legacy counts, D-40 non-null refresh/access token counts preserved per provider, D-23 boolean maps exact truthiness both sides"
    requirement: AUTH-03
    verification:
      - kind: integration
        ref: "tests/integration/cutover-migration.test.ts#1..4 (real docker PG :5453)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Admin seed script D-08/D-09/D-10 semantics: missing/empty/zero-match ADMIN_EMAILS abort non-zero without granting; one-match roster grants role='admin' case-insensitively"
    verification:
      - kind: integration
        ref: "tests/integration/cutover-migration.test.ts#5..8 (spawns scripts/seed-admin-roles.mjs)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Additive-only migration contract: comment-stripped 0002 contains no DROP and no RENAME anywhere (prohibition P1 / D-30 redeploy-only rollback)"
    verification:
      - kind: other
        ref: "tests/integration/cutover-migration.test.ts#9 (source assertion)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A-1 hash gate + AUTH-09 lazy rehash: $2a$/$2b$/$2y$ verify matrix, unknown prefixes refuse closed, hash() emits 10-round bcrypt, successful legacy verify upgrades the stored account.password and the upgrade still verifies; failed verify upgrades nothing"
    requirement: AUTH-01
    verification:
      - kind: unit
        ref: "tests/lib/auth-password.test.ts#1..6 (upgrade cases on real db.execute seam)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Canary legacy-bcrypt sign-in through the real catch-all handler POST /api/auth/sign-in/email on migrated docker-stack data: 200 + better-auth.session_token cookie + session row; 401 INVALID_EMAIL_OR_PASSWORD; 403 EMAIL_NOT_VERIFIED (D-23); second sign-in after the lazy upgrade still verifies (AUTH-09 loop)"
    requirement: AUTH-02
    verification:
      - kind: integration
        ref: "tests/integration/better-auth-cutover.test.ts#1..4 (real handler, real DB, no mocks)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Schema authority integrity after the cutover migration: pnpm schema:gate empty structural diff against a pull of the migrated docker DB (with the third email_verified canonicalization), zero forbidden tokens"
    verification:
      - kind: other
        ref: "pnpm schema:gate (green: migrate 0.76s, pull 1.54s, diff 0.00s, scan 0.02s)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Task 2 install set pinned and env contract active: better-auth@1.7.5 + @better-auth/redis-storage@1.7.5 in dependencies; BETTER_AUTH_SECRET/BETTER_AUTH_URL/ADMIN_EMAILS/ADMIN_IP_ALLOWLIST entries in .env.example with D-12/D-17 annotations"
    verification:
      - kind: other
        ref: "pnpm ls better-auth @better-auth/redis-storage (1.7.5 both) + grep -c '^BETTER_AUTH_SECRET=' .env.example = 1"
        status: pass
    human_judgment: false

duration: 33min (this continuation leg: Tasks 4-5 + close-out; Tasks 1-3 incl. the D-08 blocking checkpoint ran in the prior session)
completed: 2026-09-23
status: complete
---

# Phase 7 Plan 1: Better Auth Cutover Tracer Summary

**Legacy-bcrypt sign-in through Better Auth proven end-to-end on migrated docker-stack data: additive cutover migration 0002 (count-exact backfills, zero DROP/RENAME), A-1 bcrypt prefix router with lazy rehash, and the D-09-aborting admin seed — 365/365 suite green.**

## Performance

- **Duration:** 33 min (this continuation leg; plan spans two sessions — Tasks 1-2 committed and the Task 3 D-08 checkpoint resolved before this leg)
- **Started (leg):** 2026-09-22T19:03:31Z
- **Completed (leg):** 2026-09-22T19:36:42Z (close-out follows)
- **Tasks:** 5
- **Files modified:** 28 (19 created / 9 modified, plus 10 route import repoints)

## Approvals Recorded (blocking checkpoints)

- `Package set approved by operator (mehedishubho), 2026-09-23 — better-auth@1.7.5, @better-auth/redis-storage@1.7.5, @bull-board/api@9.10.1, @bull-board/hono@9.10.1, hono@^4.13.8, @hono/node-server@^2.1.1, ipaddr.js ^2.x`
- `D-08 one-way decision ratified by operator (mehedishubho), 2026-09-23 — Option A; ADMIN_EMAILS=mehedihassanshubho@gmail.com (operator-confirmed)`
- Snapshot canary documentation (D-37/D-10): the roster value used at rehearsal seeding and in production .env at flip is exactly `mehedihassanshubho@gmail.com`.

## Accomplishments

- The phase's lockout risk is killed by evidence: a user whose stored hash is a legacy bcrypt hash signs in through the Better Auth catch-all handler against real migrated Postgres data, the stored hash upgrades on that login, and the second sign-in verifies the upgraded hash (AUTH-01/AUTH-02/AUTH-09).
- Migration 0002 is purely additive and proven count-exact on the docker stack: credential account rows equal users-with-password, per-provider reshaped counts equal legacy `accounts` counts, non-null refresh/access token counts preserved per provider (D-40 snapshot leg), and `email_verified` maps the legacy timestamp's truthiness exactly, both directions (D-23).
- The D-08 one-way decision landed as ratified: users.role + the boolean inside 0002; the admin grant via scripts/seed-admin-roles.mjs with the D-09 zero-match abort (a zero-match roster can never silently pass).
- Better Auth instance is the minimal worker-safe core (zero next-auth imports) with D-23/D-25/D-42 pins and the A-1 password hooks; 07-03 expands it with socialProviders, admin plugin, queue hooks, cookieCache and rateLimiter.
- Full suite green: 42 files / 365 tests (includes the 19 new tests); pnpm schema:gate green; pnpm typecheck green.

## Task Commits

1. **Task 1: Package legitimacy checkpoint** — no commit (blocking-human gate; approval recorded above)
2. **Task 2: Install better-auth pin + env entries** - `1492c0b` (chore, prior session)
3. **Task 3: D-08 one-way checkpoint** — no commit (decision gate; ratification recorded above)
4. **Task 4: Cutover schema + additive migration + admin seed + [BLOCKING] apply** - `04ccf58` (feat; amended from 070cf79 to carry the verification.createdAt fix — see Deviations 1)
5. **Task 5: TRACER — legacy-bcrypt sign-in through Better Auth** - `9d4bfc4` (feat)

**Plan metadata:** this docs commit (docs: complete plan)

## Files Created/Modified

- `drizzle/0002_better_auth_cutover.sql` - additive cutover migration: account/session/verification DDL, users admin/boolean columns, credential backfill, OAuth reshape, D-23 backfill
- `src/db/schema.ts` - account/session/verification tables + users role/email_verified/banned/banReason/banExpires in pull-format
- `scripts/seed-admin-roles.mjs` - D-09 aborting admin seed (enqueue-smoke contract: fail-loud, teardown, no connection strings)
- `src/lib/auth-password.ts` - A-1 prefix router + lazy rehash (fire-and-forget, logged failures)
- `src/lib/auth.ts` - minimal Better Auth core (createAuth() + auth singleton; D-23/D-25/D-42 pins; generateId:false)
- `src/lib/auth-legacy.ts` - verbatim authOptions interim module for the 10 NextAuth-session routes (dies at 07-08)
- `src/app/api/auth/[...all]/route.ts` - Better Auth catch-all (better-auth/next-js, per-verb export)
- `scripts/schema-gate.mjs` - third canonicalization (pull's non-adoptable emailVerified property form)
- `tests/integration/cutover-migration.test.ts`, `tests/lib/auth-password.test.ts`, `tests/integration/better-auth-cutover.test.ts` - 19 new tests
- `.env.example`, `package.json`, `pnpm-lock.yaml` - Task 2 install + env contract (prior session)
- 10 route files under `src/app/api/` - authOptions import repoint to `@/lib/auth-legacy`

## Decisions Made

- Verified the installed 1.7.5 surface before wiring: `better-auth/next` does not exist at this pin (`./next-js` does), `toNextJsHandler` returns a per-verb map, the drizzle adapter resolves `user.fields` against drizzle table PROPERTY names (making the `email_verified` property load-bearing), and the core schema-check requires `verification.createdAt`.
- Task 4's commit was amended (070cf79 → 04ccf58) when the Task 5 tracer exposed the init-time schema failure — keeping the cutover migration correct as a single committed artifact rather than stacking a fix migration; Task 4's full verification re-ran green after the amend.
- New tables' text-PK defaults carry `gen_random_uuid()::text` (0001/§11 house pin) — pull renders the un-cast form as non-adoptable TypeScript.
- Interim dual-stack: the rewrite must not break the routes still serving NextAuth sessions, so authOptions moved verbatim to a legacy module instead of being re-exported through the Better Auth module (which would put next-auth in the worker's import graph).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Better Auth init schema-check requires `verification.createdAt`**
- **Found during:** Task 5 (tracer canary) — surfaced by the framework's own init validation (Pitfall 7 mechanism, core-schema class)
- **Issue:** The plan's verification table column list (id/identifier/value/expiresAt/updatedAt) omits createdAt; Better Auth 1.7.5's init-time Drizzle schema check fails with "Missing columns: verification.createdAt" — in production too
- **Fix:** Column added (timestamp DEFAULT now() NOT NULL) to src/db/schema.ts, drizzle/0002 SQL, and meta/0002_snapshot.json; test DB reset + re-applied; Task 4 commit amended to 04ccf58 and its verification re-run (migration suite 9/9, schema:gate green)
- **Files modified:** src/db/schema.ts, drizzle/0002_better_auth_cutover.sql, drizzle/meta/0002_snapshot.json
- **Verification:** tests/integration/cutover-migration.test.ts 9/9; canary suite green after fix
- **Committed in:** 04ccf58 (amended Task 4 commit)

**2. [Rule 3 - Blocking] `better-auth/next` import path does not exist at the 1.7.5 pin**
- **Found during:** Task 5 (route authoring)
- **Issue:** Plan/research specify `import { toNextJsHandler } from "better-auth/next"`; the installed exports map ships `./next-js` only
- **Fix:** Import from `better-auth/next-js`; documented in-file
- **Files modified:** src/app/api/auth/[...all]/route.ts
- **Verification:** canary suite drives the route's POST export end-to-end
- **Committed in:** 9d4bfc4

**3. [Rule 1 - Bug] `toNextJsHandler` returns a per-verb handler map, not a single handler**
- **Found during:** Task 5 (tracer did its job — the NextAuth-shaped re-export produced non-function GET/POST)
- **Issue:** The plan's analog shape (`const handler = NextAuth(...); export { handler as GET, handler as POST }`) doesn't transfer: toNextJsHandler returns `{ GET, POST, PATCH, PUT, DELETE }`
- **Fix:** `export const { GET, POST } = toNextJsHandler(auth);`
- **Files modified:** src/app/api/auth/[...all]/route.ts
- **Verification:** all four canary cases run through the route's POST export
- **Committed in:** 9d4bfc4

**4. [Rule 3 - Blocking] auth.ts rewrite broke 10 routes importing `authOptions` (typecheck red beyond the task's file list)**
- **Found during:** Task 5 (pnpm typecheck gate)
- **Issue:** feedback/incidents/monitors/status/telegram/user-profile + [...nextauth] routes import `authOptions` from `@/lib/auth`; the minimal core has no NextAuth options, yet the dual stack must keep compiling until the flip swaps them
- **Fix:** authOptions moved verbatim to `src/lib/auth-legacy.ts` (interim module, dies with NextAuth at 07-08); the 10 import lines repointed. Re-exporting from @/lib/auth was rejected — it would pull next-auth into the worker's import graph
- **Files modified:** src/lib/auth-legacy.ts (new) + 10 route files
- **Verification:** pnpm typecheck green; full suite green
- **Committed in:** 9d4bfc4

**5. [Rule 1/3 - Gate fix] schema-gate needed a third canonicalization for pull's `email_verified` rendering**
- **Found during:** Task 4 (schema:gate after the BLOCKING apply)
- **Issue:** pull camelCases the physical column "email_verified" into property `emailVerified` — which already exists on users (the untouched legacy timestamp); adopting pull's line verbatim is TS1117 non-adoptable TypeScript (same class as the gen_random_uuid rule)
- **Fix:** narrowly-scoped third normalization in scripts/schema-gate.mjs (rewrites `emailVerified: boolean("email_verified")` to `email_verified:` on BOTH sides only); committed schema spells `email_verified:` — which the drizzle adapter's field resolution also requires
- **Files modified:** scripts/schema-gate.mjs
- **Verification:** pnpm schema:gate green (empty diff)
- **Committed in:** 04ccf58

**6. [Rule 3 - Blocking] New tables' id defaults lacked the §11 `::text` cast**
- **Found during:** Task 4 (schema:gate drift analysis)
- **Issue:** drizzle renders `.default(sql`gen_random_uuid()`)` as `DEFAULT gen_random_uuid()` (no cast); pull then renders a bare `gen_random_uuid()` default form that differs from the 0001-era house pin (`gen_random_uuid()::text` per §11/D-3)
- **Fix:** migration DDL hand-edited to `DEFAULT gen_random_uuid()::text` (sanctioned "edit the emitted 0002" step); DB reset + re-applied
- **Files modified:** drizzle/0002_better_auth_cutover.sql
- **Verification:** schema:gate green; migration suite green
- **Committed in:** 04ccf58

---

**Total deviations:** 6 auto-fixed (3 blocking Rule 3, 2 bug/gate Rule 1, 1 mixed). **Impact on plan:** all fixes were forced by verified behavior of the pinned framework or the existing repo contract; none expanded scope. The amended Task 4 commit keeps the cutover migration atomic and correct.

## Issues Encountered

- Docker Desktop was not running at leg start — started programmatically and the engine came up in ~10s; no further environment friction.
- `@better-auth/redis-storage@1.7.5` declares peer `ioredis@^5` while the repo carries ioredis 6 (upstream range lag; noted at install). The wiring proof lands in 07-03 — no runtime code touches the package in this plan.
- Interim-state note for 07-03: with both `src/app/api/auth/[...all]/` and `[...nextauth]/` present, Next.js will refuse the conflicting catch-alls at build time; the flip release deletes `[...nextauth]` (its route serves nothing after the flip). Typecheck/tests (this plan's gates) are unaffected — build was not in this plan's gate.

## User Setup Required

None - no external service configuration required. (Operator-side flip-time duties — ADMIN_EMAILS in production .env, snapshot regeneration — are 07-06/07-07 scope and already documented in the runbook/plan.)

## Next Phase Readiness

- Ready for 07-02 (announcement blast) and 07-03 (Better Auth expansion): the core instance, hash gate, catch-all route, cutover schema and admin seed all exist and are proven; 07-03 extends the SAME auth.ts (socialProviders, admin plugin, email hooks → queue, cookieCache, rateLimiter + redis-storage secondary storage).
- The `email_verified` property name in src/db/schema.ts is load-bearing for Better Auth's field mapping — do not rename it.
- AUTH-02/AUTH-03 requirement checkboxes stay open by the shared-ID gate until their last declaring plan (07-03/07-06 rehearsal legs) produces its SUMMARY — machine evidence for this plan's share is in the coverage block above.
- No known stubs: the minimal core is the plan's designed slice; every expansion point is named for 07-03/07-05.

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-23*

## Self-Check: PASSED

- All 9 created files verified on disk (`[ -f ]`): migration 0002, seed script, auth-password.ts, auth-legacy.ts, [...all]/route.ts, 3 test files, SUMMARY.md
- All 4 plan commits verified in history: 1492c0b, 04ccf58, 9d4bfc4, 460b90c (4 measured from ledger base 0c38c80)
- Plan verification re-run: full vitest suite 42 files / 365 tests green (incl. the 3 new files), pnpm schema:gate green, pnpm typecheck green, 0002 source pinned DROP/RENAME-free
- STATE.md advanced (Plan 2 of 9, metrics + decisions + session recorded); ROADMAP.md progress row updated; REQUIREMENTS.md: AUTH-01/AUTH-09 marked complete (AUTH-02/AUTH-03 held by the shared-ID gate until 07-03/07-06 SUMMARIES exist)
- Pre-existing orchestrator artifacts (STATE.md/skills-lock.json/observations.json modifications, untracked .claude/skills/*, .env.test, research cache) left unstaged throughout — only task-owned files committed
