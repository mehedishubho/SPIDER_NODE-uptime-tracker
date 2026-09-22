---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 03
subsystem: auth
tags: [better-auth, cookie-cache, rate-limiting, redis, drizzle, admin-role, email-queue, engine-flip]

# Dependency graph
requires:
  - phase: "07 plan 01"
    provides: minimal Better Auth core + A-1 hash gate + migration 0002 (role/boolean/account/session/verification) + [...all] catch-all + redis-storage install
  - phase: "07 plan 02"
    provides: renderVerificationEmailFromUrl/renderPasswordResetEmailFromUrl (the hooks' render targets) + BETTER_AUTH_URL domain source
  - phase: 06-thin-api-routes-email-abstraction
    provides: enqueueTransactionalEmail with injectable queue seam (EML-04 delegation target)
provides:
  - full-parity Better Auth instance in src/lib/auth.ts — every D-21..D-28/D-42..D-44 pin explicit, D-26/D-25/D-28 proven behaviorally
  - src/lib/session.ts getAuthSession() — the ONE server-side session door (all ten routes + the feedback admin gate ride it)
  - src/lib/auth-client.ts authClient — the single client source for 07-04 (nothing else imports better-auth/react; 07-08 gate extends)
  - src/proxy.ts on cookieCache validation with byte-identical redirect shape + matcher
  - GET /api/feedback admin-only (R17 closed) with the D-16 structured audit line; POST authenticated-for-all
  - legacy engine code surface deleted: [...nextauth] + register/verify-email/forgot-password/reset-password routes + src/lib/tokens.ts (deps stay idle until 07-08)
  - the wave's build-gate conflict resolved — pnpm build green again
affects: [07-04 client swap, 07-05 Bull Board gate, 07-06 rehearsal, 07-08 deletion release gate]

# Actuals (#2632) — pairs with the plan's estimate to calibrate future estimates.
actuals:
  tokens: 21200      # chars/4 over the realized diff (27 files, 1205 insertions + 916 deletions)
  tasks: 3
  commits: 4        # MEASURED: git rev-list --count b53a47b690da47f692052285731725ae9524f91f..HEAD (3 task commits + 1 build-gate fix)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One session door: getAuthSession() wraps auth.api.getSession({ headers: await headers() }); the worker (07-05) builds Headers from node:req instead (next/headers is web-only)"
    - "Engine-default inversion pins: disableImplicitLinking/autoSignIn:false/revokeSessionsOnPasswordReset:true — never trust defaults on a parity flip"
    - "Test the provider without the provider: OAuth callback driven end-to-end with the provider's HTTP surface stubbed on global.fetch (state cookie forwarded like a browser)"

key-files:
  created:
    - src/lib/session.ts
    - src/lib/auth-client.ts
    - tests/integration/auth-email-hooks.test.ts
    - tests/api/feedback-admin.handler.test.ts
    - tests/lib/proxy-auth.test.ts
  modified:
    - src/lib/auth.ts
    - src/proxy.ts
    - src/app/api/feedback/route.ts
    - 9 further src/app/api routes (guard swap: incidents, monitors, monitors/[id], monitors/[id]/check, monitors/[id]/details, status, telegram/connect, telegram/test, user/profile)
    - tests/api/_harness.ts (@/lib/session seam)
    - tests/api/status.handler.test.ts (stale R17 pins removed WITH the fix)
    - tests/integration/better-auth-cutover.test.ts (behavioral pins extended)
key-decisions:
  - "storeSessionInDatabase: true — with secondaryStorage present the engine default is Redis-ONLY sessions; the phase design is DB-backed session rows (D-44 'rows expire naturally', D-30 rollback substrate must not depend on Redis contents). Reads still come from secondary storage, so the cookieCache proxy path is unchanged"
  - "The engine's reset endpoint is /request-password-reset — the plan's '/forget-password' spelling (and its customRules key) is the docs' legacy alias; POSTing /forget-password 404s (Pitfall-9-class docs discrepancy, resolved against the installed routes)"
  - "D-22 realized mirror-the-intent via hooks.before on /request-password-reset: OAuth-only accounts get the exact message 'This account signs in with Google or GitHub.'; unknown emails keep the engine's neutral 200"
  - "The build gate fix: requireProductionEnv skips NEXT_PHASE=phase-production-build — next build evaluates route modules under NODE_ENV=production before any operator env exists; the throw-early guarantee stays a RUNTIME boot gate"
  - "requireProductionEnv extended to GOOGLE_/GITHUB_ credentials (production-only) — no || \"\" fallback carried over from the legacy config"
  - "tests/api/status.handler.test.ts R17-leak pins removed WITH the admin-gate fix (Pitfall-7 discipline); the flipped matrix lives in the new dedicated feedback-admin suite"

patterns-established:
  - "Harness seam evolution: @/lib/session's getAuthSession mocks the SAME instance as the legacy next-auth seam — one mockSession() drives both guard generations"
  - "Per-file @/db seam: chainable thenable Drizzle builder mock with the SELECT projection captured for shape pins"
  - "Engine limiter determinism in tests: SCAN+DEL the better-auth:* keyspace per case (the counters persist across runs in the test Redis)"

requirements-completed: [AUTH-02, AUTH-03, AUTH-04, EML-04, SEC-04]

# Coverage metadata (#1602) — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "Full-parity config inventory in src/lib/auth.ts: every D-21..D-28/D-42..D-44 pin explicit (TTLs 3600, minPasswordLength 6, requireEmailVerification, sendOnSignIn false, 30d session + updateAge/freshAge defaults, cookieCache jwt 5min, disableImplicitLinking, autoSignIn false, revokeSessionsOnPasswordReset true, rateLimit customRules 5/h on /sign-up/email + /request-password-reset, ipAddressHeaders x-forwarded-for, trustedOrigins, admin role primitive only)"
    verification:
      - kind: other
        ref: "command: pnpm typecheck (config compiles against installed 1.7.5 option types; every pin name verified in @better-auth/core init-options.d.mts)"
        status: pass
      - kind: integration
        ref: "tests/integration/better-auth-cutover.test.ts#D-25/D-28/D-26/D-22 (four pins proven behaviorally through the real handler)"
        status: pass
    human_judgment: true
    rationale: "The remaining pins (TTLs, cookieCache shape, limiter numbers, ipAddressHeaders) are config-as-code proven by typecheck + the suite subset, not individually asserted on auth.options — the verifier should classify the inventory against RESEARCH Pattern 1"
  - id: D2
    description: "EML-04: sign-up and request-password-reset each enqueue EXACTLY ONE rendered email through the Phase-6 queue carrying the framework url; zero in-request SMTP"
    requirement: EML-04
    verification:
      - kind: integration
        ref: "tests/integration/auth-email-hooks.test.ts#sign-up enqueues EXACTLY ONE rendered verification email carrying the framework url"
        status: pass
      - kind: integration
        ref: "tests/integration/auth-email-hooks.test.ts#request-password-reset enqueues EXACTLY ONE rendered reset email carrying the framework url"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-25: sign-up mints NO session — no session cookie and no session row (engine default would mint one)"
    verification:
      - kind: integration
        ref: "tests/integration/better-auth-cutover.test.ts#D-25: sign-up mints NO session"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-28 (the ONE deliberate delta): a password reset revokes the user's other sessions; the new password verifies and the old one refuses"
    verification:
      - kind: integration
        ref: "tests/integration/better-auth-cutover.test.ts#D-28: a password reset revokes the user's other sessions"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-26: a GitHub sign-in for a Google-held email is refused with account_not_linked at the real callback leg and merges nothing (account row count unchanged, no second user)"
    verification:
      - kind: integration
        ref: "tests/integration/better-auth-cutover.test.ts#D-26: a GitHub sign-in for a Google-held email is refused with account_not_linked and merges nothing"
        status: pass
    human_judgment: false
  - id: D6
    description: "D-22: request-password-reset for an OAuth-only account returns the exact clear message and enqueues nothing; credential accounts fall through (D-28 leg resets through the same guard)"
    verification:
      - kind: integration
        ref: "tests/integration/better-auth-cutover.test.ts#D-22: request-password-reset for an OAuth-only account returns the clear Google/GitHub message"
        status: pass
    human_judgment: false
  - id: D7
    description: "SEC-04/R17/D-14: GET /api/feedback admin 200 / non-admin 403 / anon 401; the D-16 structured line (userId/route/ip/timestamp) on allowed AND refused GET hits and never on POST; POST stays authenticated-for-all; Drizzle join keeps the user { name, email, image } projection"
    requirement: SEC-04
    verification:
      - kind: integration
        ref: "tests/api/feedback-admin.handler.test.ts#7-test matrix (gate placement, D-16 lines, POST ungated, projection pin)"
        status: pass
    human_judgment: false
  - id: D8
    description: "AUTH-04: the proxy validates from the signed cookie via auth.api.getSession(request.headers) — pass-through, /login redirect with callbackUrl = pathname+search, matcher /dashboard/:path* pinned"
    requirement: AUTH-04
    verification:
      - kind: unit
        ref: "tests/lib/proxy-auth.test.ts#4-test contract (headers identity, redirect shape, matcher)"
        status: pass
    human_judgment: false
  - id: D9
    description: "One-engine surface: no getServerSession/authOptions remains under src/app/api or src/proxy.ts; ten routes + proxy resolve sessions through getAuthSession with ownership scoping verbatim; Phase-6 contract suites green under the swapped guard"
    verification:
      - kind: other
        ref: "command: { ! pnpm exec rg -l 'getServerSession|authOptions' src/app/api src/proxy.ts; } exits 0 (zero matches)"
        status: pass
      - kind: integration
        ref: "tests/api/monitors.handler.test.ts + monitors-id + status + incidents + check-route: 61/61 green (part of the full-suite run)"
        status: pass
    human_judgment: false
  - id: D10
    description: "AUTH-02 machine leg + legacy-bcrypt canary parity preserved under the full-parity config: sign-in, lazy rehash, 401/403 codes unchanged (the tracer suite re-run against the expanded instance)"
    requirement: AUTH-02
    verification:
      - kind: integration
        ref: "tests/integration/better-auth-cutover.test.ts#1..4 (tracer canary re-run green on the expanded config)"
        status: pass
    human_judgment: false
  - id: D11
    description: "AUTH-03 under the full config: adapter binding to the existing users table intact (canary sign-ins mint session rows in the NEW table with storeSessionInDatabase)"
    requirement: AUTH-03
    verification:
      - kind: integration
        ref: "tests/integration/better-auth-cutover.test.ts#1 (200 + session row in the new session table) + #D-28 (rows revoked)"
        status: pass
    human_judgment: false
  - id: D12
    description: "authClient exists as the single client entry — only src/lib/auth-client.ts imports better-auth/react (AUTH-08 invariant, gate-extended at 07-08)"
    verification:
      - kind: other
        ref: "command: grep -rln 'better-auth/react' src/ -> src/lib/auth-client.ts only"
        status: pass
    human_judgment: false
  - id: D13
    description: "The wave's build gate: pnpm build green — the [...all]/[...nextauth] catch-all conflict is resolved by the Task 1 deletion (worker tsup bundle green too)"
    verification:
      - kind: other
        ref: "command: NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm build (Next 16 production build + route table + worker bundle, exit 0)"
        status: pass
    human_judgment: false

# Metrics
duration: 43min
completed: 2026-09-23
status: complete
---

# Phase 7 Plan 3: FLIP ENGINE Summary

**Every session now resolves through Better Auth: full-parity config with D-25/D-26/D-28/D-22 proven behaviorally at the real handler, both email hooks enqueueing rendered framework urls, one getAuthSession door across ten routes, an admin-gated feedback GET with the D-16 audit line — and the legacy auth route/config surface deleted, restoring pnpm build.**

## Performance

- **Duration:** 43 min
- **Started:** 2026-09-22T20:21:51Z
- **Completed:** 2026-09-22T21:04:51Z
- **Tasks:** 3 (+1 build-gate fix commit)
- **Files modified:** 27 (5 created, 6 deleted, 16 modified)

## Accomplishments

- The engine flip is complete server-side: `src/lib/auth.ts` carries every locked parity pin explicitly (three inverted engine defaults pinned; D-28 the one sanctioned delta), and D-25 (no session on sign-up), D-28 (reset revokes other sessions), D-26 (cross-provider sign-in refused at the REAL callback with zero merge), and D-22 (OAuth-only reset refusal) are proven behaviorally through the catch-all handler on real docker-stack data.
- Both Better Auth email hooks delegate to the Phase-6 queue (render-at-enqueue, 07-02 FromUrl variants) — exactly one rendered email per sign-up / request-password-reset, zero in-request SMTP (EML-04 closed).
- One session door: `getAuthSession()` in `src/lib/session.ts`; the proxy validates from the signed cookie (cookieCache, no per-request DB hit) with the redirect shape and matcher byte-identical; all ten server routes swept with ownership scoping verbatim; the rg gate proves zero legacy guard remains.
- GET /api/feedback is admin-only (R17 closed) with the D-16 structured audit line on allowed and refused hits; POST stays authenticated-for-all; its Prisma-era read became the equivalent Drizzle join preserving the user projection.
- The legacy code surface is deleted ([...nextauth] + four custom auth routes + tokens.ts) and `pnpm build` is green again — the wave's post-merge gate landed inside this plan.
- Full suite: 45 files / 376 tests green; pnpm typecheck clean; build + worker bundle green.

## Task Commits

Each task was committed atomically:

1. **Task 1: Full-parity auth instance + email hooks + legacy route/config deletion** - `4110038` (feat)
2. **Task 2: Proxy swap + session helper + ten-route sweep + feedback admin gate** - `7d9c00a` (feat)
3. **Task 3: Single client entry + admin-gate handler matrix + proxy contract suite** - `e35cbae` (feat)
4. **Build-gate fix: throw-early env gate skips phase-production-build** - `01fc48f` (fix)

**Plan metadata:** `PLAN_HEAD_BEFORE=b53a47b` → 4 commits measured (see actuals).

## Files Created/Modified

- `src/lib/auth.ts` — full-parity config: D-21..D-28/D-42..D-44 pins, hooks (D-22 guard + both email hooks), socialProviders with production-only env gate, rateLimit + redisStorage secondaryStorage, cookieCache, admin plugin, storeSessionInDatabase, NEXT_PHASE build-phase skip
- `src/lib/session.ts` (NEW) — getAuthSession(): the one server-side session door
- `src/lib/auth-client.ts` (NEW) — authClient, the single client source (07-04 consumes)
- `src/proxy.ts` — auth.api.getSession from request headers; everything else byte-identical
- `src/app/api/feedback/route.ts` — admin gate + D-16 line + Drizzle join on GET; POST guard swap only
- 9 further routes under `src/app/api/` — legacy guard import+call swapped for getAuthSession()
- Deleted: `src/app/api/auth/[...nextauth]/route.ts`, `src/app/api/auth/{register,verify-email,forgot-password,reset-password}/route.ts`, `src/lib/tokens.ts`, `tests/api/auth-shallow.handler.test.ts` (dead characterization of two deleted routes)
- `tests/integration/auth-email-hooks.test.ts` (NEW), `tests/api/feedback-admin.handler.test.ts` (NEW), `tests/lib/proxy-auth.test.ts` (NEW)
- `tests/integration/better-auth-cutover.test.ts` — +4 behavioral pins (D-25/D-28/D-26/D-22)
- `tests/api/_harness.ts` — @/lib/session seam on the shared mock instance
- `tests/api/status.handler.test.ts` — stale R17 pins removed with the fix

## Decisions Made

- **storeSessionInDatabase: true.** With secondaryStorage configured, the engine defaults to Redis-ONLY sessions. The phase design is DB-backed session rows (D-44 "rows expire naturally"; D-30's rollback story must not depend on Redis contents), so rows are also persisted; reads still come from secondary storage, leaving the cookieCache proxy path untouched.
- **The engine's reset path is `/request-password-reset`.** The plan's `/forget-password` spelling (including its customRules key note) is the docs' legacy alias — POSTing it 404s. The D-22 hooks.before guard and the 5/h custom rule key the REAL path (verified against the installed routes; Pitfall-9-class docs discrepancy).
- **D-22 realized as mirror-the-intent** per 07-RESEARCH OQ2's resolution: hooks.before refuses OAuth-only accounts with the exact message; unknown emails keep the engine's neutral 200; reset touches no verified timestamp.
- **Production-only env gate extended** to GOOGLE_/GITHUB_ credentials — the legacy `|| ""` fallback form is not carried over; a production boot without OAuth credentials fails loud (06 D-11 lineage).
- **OAuth without the provider in tests:** the D-26 leg drives the real initiation → state → callback with GitHub's HTTP surface stubbed on global.fetch and the signed state cookie forwarded verbatim (the engine's CSRF guard), proving the refusal and the zero-merge end to end.
- **Rate-limit determinism in integration tests:** the engine's limiter counters persist across runs in the test Redis (custom 5/h rules + the 3-per-10s sign-in sensitive default), so the suites SCAN+DEL the better-auth:* keyspace per case and carry per-case x-forwarded-for headers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tests/api/auth-shallow.handler.test.ts imported the deleted routes**
- **Found during:** Task 1 (deletion)
- **Issue:** The plan's deletion premise said the legacy routes' importers "were only each other"; tests/api/auth-shallow.handler.test.ts dynamically imports register/forgot-password — typecheck and the suite would break
- **Fix:** Deleted the dead characterization suite with its routes (its header explicitly anticipated deletion; the 06-05 mail-tripwire retirement precedent); Task 3's feedback suite and the cutover/email-hooks suites own the surviving contracts
- **Files modified:** tests/api/auth-shallow.handler.test.ts (deleted)
- **Verification:** pnpm typecheck green; full suite green
- **Committed in:** 4110038

**2. [Rule 3 - Blocking] With secondaryStorage present the engine stores sessions ONLY in Redis**
- **Found during:** Task 1 (tracer test 1 re-run: 200 + cookie but zero session rows)
- **Issue:** The engine default (`storeSessionInDatabase: false` when secondaryStorage exists) contradicts the phase's DB-backed session design (D-44/D-30) and broke the D-28 row-count proof
- **Fix:** `session.storeSessionInDatabase: true` pinned in auth.ts with the decision lineage; D-28's revocation still deletes the rows (preserveSessionInDatabase stays false)
- **Files modified:** src/lib/auth.ts
- **Verification:** tracer suite green; D-28 revocation proven on real rows
- **Committed in:** 4110038

**3. [Rule 1 - Bug] The plan's "/forget-password" endpoint path does not exist at 1.7.5**
- **Found during:** Task 1 (D-22 test returned 404)
- **Issue:** The engine endpoint is `/request-password-reset`; the plan's spelling (and customRules key) is the docs' legacy alias — the D-22 guard and the 5/h rule were keyed on a path that never fires
- **Fix:** hooks.before and customRules re-keyed to `/request-password-reset`; tests repointed
- **Files modified:** src/lib/auth.ts, tests/integration/auth-email-hooks.test.ts, tests/integration/better-auth-cutover.test.ts
- **Verification:** D-22 refusal case + email-hooks reset case green
- **Committed in:** 4110038

**4. [Rule 3 - Blocking] next build aborted: throw-early env gate fires during page-data collection**
- **Found during:** Wave gate (pnpm build)
- **Issue:** next build evaluates route modules under NODE_ENV=production BEFORE the operator env exists; requireProductionEnv threw at import of the first route touching @/lib/session → @/lib/auth
- **Fix:** the gate skips `NEXT_PHASE=phase-production-build` (Next's own marker) — the throw-early guarantee remains a production RUNTIME boot gate (PM2 runs without NEXT_PHASE)
- **Files modified:** src/lib/auth.ts
- **Verification:** pnpm build green end-to-end (Next build + worker bundle)
- **Committed in:** 01fc48f

**5. [Rule 3 - Blocking] tests/api/status.handler.test.ts pinned the R17 leak as today's contract**
- **Found during:** Task 2 (two feedback-GET pins red under the admin gate)
- **Issue:** "any authenticated user lists EVERY feedback row (pinned as-is)" is exactly the behavior this plan removes; asserting removed behavior mid-wave violates the suite's own discipline
- **Fix:** the two stale pins removed WITH the fix (Pitfall-7 precedent, same as 06's check-route rewrite); the flipped matrix lives in the new dedicated feedback-admin suite; the @/lib/session harness seam was added so every other suite stayed green untouched
- **Files modified:** tests/api/status.handler.test.ts, tests/api/_harness.ts
- **Verification:** 5 contract suites 61/61 green
- **Committed in:** 7d9c00a

**6. [Rule 1/3 - Companion] The D-26 initiation 500s without provider credentials, and state validation requires the signed state cookie**
- **Found during:** Task 1 (D-26 leg)
- **Issue:** the engine throws on undefined client ids when building authorize URLs, and parseState enforces the signed better-auth.state cookie (CSRF guard)
- **Fix:** tests pin deterministic fake provider envs (the established env-pinning discipline) and forward the initiation's set-cookie on the callback — faithful browser behavior, no config changes
- **Files modified:** tests/integration/better-auth-cutover.test.ts, tests/integration/auth-email-hooks.test.ts
- **Verification:** D-26 end-to-end refusal green
- **Committed in:** 4110038

---

**Total deviations:** 6 auto-fixed (3 blocking Rule 3, 2 bug/companion Rule 1, 1 mixed companion set). **Impact on plan:** all fixes were forced by verified behavior of the pinned engine version or by the deletion's true importer set; none expanded scope. The D-28/D-25/D-26/D-22 behavioral proofs are exactly the plan's named pins.

## Issues Encountered

- `pnpm build` on this checkout additionally needs `NEXT_PUBLIC_DEV_BASE_URL` injected (baseApi's module-scope throw at /_not-found prerender) — the documented env-less-checkout precondition (02-07/03-01 precedent), unrelated to this plan's surface; the gate was proven with `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm build`.
- Better Auth logs loud non-fatal warnings during the build (default-secret / base-url) while page-data collection evaluates the auth singleton without envs — build-time noise only; the production runtime gate (requireProductionEnv) still fails loud at boot.
- The engine's sensitive-route default limits sign-in to 3 per 10s — the tracer suite's back-to-back sign-ins needed the per-case keyspace flush noted above; production requests are keyed per-IP via the pinned x-forwarded-for header.

## User Setup Required

None - no external service configuration required. (Flip-time operator duties — BETTER_AUTH_* envs, ADMIN_EMAILS, D-06 copy sign-off — are 07-04/07-06/07-07 scope and already documented.)

## Next Phase Readiness

- 07-04 can swap every client component to `@/lib/auth-client` immediately — the single client source exists; the D-33 error-code mapping table (07-RESEARCH OQ4 + UI-SPEC) is ready to consume; the deleted legacy routes mean the still-unswapped client forms 404 on register/forgot/verify/reset until 07-04 lands (documented transitional state).
- 07-05's worker gate imports the same `createAuth()`/`auth` instance (zero next/* imports held); note sessions read from secondary storage first — the worker gate inherits that path.
- 07-08's deletion gate now has three extra invariants to encode: nothing else imports better-auth/react (single client source), no authOptions/getServerSession anywhere (rg gate extension), and src/lib/auth-legacy.ts dies with next-auth.
- The transitional dual-stack is code-idle only: next-auth remains installed (D-29) but no route resolves a session through it.
- EML-04 requirement is now fully machine-proven (hooks + queue + rendered bytes); SEC-04's feedback half is proven here (Bull Board half lands in 07-05) — the shared-ID gate governs the REQUIREMENTS flip.

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-23*

## Self-Check: PASSED

- All 5 created files verified on disk: session.ts, auth-client.ts, auth-email-hooks.test.ts, feedback-admin.handler.test.ts, proxy-auth.test.ts
- All 4 plan commits verified in history: 4110038, 7d9c00a, e35cbae, 01fc48f (4 measured from ledger base b53a47b)
- Plan `<verification>` re-run: the four plan-named suites + both Phase-6 contract suites 57/57 green in one run; rg gate zero matches; pnpm typecheck green; full suite 45 files / 376 tests green; pnpm build green (with the documented NEXT_PUBLIC_DEV_BASE_URL injection)
- STATE.md advanced (Plan 4 of 9, metrics + decisions + session recorded); ROADMAP.md progress row updated; REQUIREMENTS.md flips applied per the ready-ids gate
- Pre-existing working-tree artifacts (skills-lock.json, observations.json, untracked .claude/skills/*, .env.test, research caches, docker-compose.dev.yml) left unstaged throughout — only task-owned files committed
