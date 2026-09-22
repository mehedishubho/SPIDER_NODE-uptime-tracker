# Phase 7: Better Auth Cutover, Admin Gating & Prisma Removal - Research

**Researched:** 2026-09-22
**Domain:** Authentication-framework cutover (NextAuth v4 → Better Auth 1.7) against existing tables, role-based admin gating with Bull Board, and full Prisma/NextAuth removal — on a live production system, rehearsed on an anonymized snapshot
**Confidence:** HIGH (stack versions + Better Auth mechanics verified against official docs and npm this session) / MEDIUM (a small, explicitly logged tail of implementation-shape assumptions)

## Summary

Phase 7 is the milestone's biggest behavioral flip: every user's login path changes engine in one deploy. The research confirms the locked design is mechanically sound and — critically — that **every parity decision in 07-CONTEXT.md maps to a concrete Better Auth 1.7.5 config surface**, with three places where the engine's *defaults* are the opposite of what we need and must be set explicitly: `account.accountLinking.disableImplicitLinking: true` (D-26 — the engine auto-links same-email OAuth by default; NextAuth v4 rejected it with `OAuthAccountNotLinked`), `emailAndPassword.autoSignIn: false` (D-25 — sign-up mints a session by default), and `emailAndPassword.revokeSessionsOnPasswordReset: true` (D-28 — the phase's one deliberate security delta, off by default). Password survival is exactly the A-1 gate: Better Auth's default hash is scrypt, the custom `emailAndPassword.password.hash/verify` hooks accept our bcryptjs path, and the credential hash lives in a Better Auth `account` row with `providerId: "credential"` — confirmed verbatim from the official core-schema doc.

The research also resolves the roadmap's three research flags: (1) **providerId casing** — the `account.providerId` value is the provider *key* in `socialProviders` config (`google`, `github` lowercase), confirmed from two official pages; the rehearsal dry-run (D-39/D-40) remains the execution-time proof. (2) **Token-flow cutover** — exact defaults are `emailVerification.expiresIn: 3600` (1 hour) and `resetPasswordTokenExpiresIn: 3600` (1 hour, matching today's reset TTL exactly); legacy tokens are NOT copied because Better Auth stores tokens *hashed* in `verification.value`, and D-20 kills old links anyway. (3) **cookieCache revocation lag** — the accepted policy is the audit's own: 5-minute `cookieCache.maxAge` bounds revocation latency, `disableCookieCache: true` (a per-request `disableCookieCache` query param / config) forces DB reads on sensitive checks, and the cold-cache path falls back to the session table. One previously-unflagged integration fact surfaced: `src/lib/email/render.ts:15` derives the email link domain from `NEXTAUTH_URL` at module scope — that read must move to `BETTER_AUTH_URL` at the flip release (template bytes untouched), or every queued link breaks when the env retires.

Bull Board (OBS-04/SEC-04) mounts on the worker's existing loopback `node:http` server via the official `@bull-board/hono` adapter (v9.10.1, peer `hono@^4`) bridged with `@hono/node-server`'s `getRequestListener` — no Express, no second port. This forces one open security decision: the worker health server currently binds `127.0.0.1` only (T-04-01), so "reachable from an allowlisted IP" (D-17/D-31) requires either a bind change with per-path source gating or an SSH-tunnel convention — flagged for the planner + operator.

**Primary recommendation:** Pin `better-auth@1.7.5` (with the core `better-auth/adapters/drizzle` adapter path still shipped by that version), configure every parity decision as an explicit config pin (never trust the defaults — three of them are inverted), author the new `account`/`session`/`verification` tables + `users.role` + a *new* boolean column (mapped via `user.fields`) hand-in-hand with the 03-07 pull-formatting gate, delegate both email hooks to `enqueueTransactionalEmail`, and rehearse the full flip + redeploy-rollback on the refreshed snapshot exactly as D-34/D-35 prescribe.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Re-login announcement & UX (AUTH-06 / Q-4)

- **D-01: Advance blast to ALL registered users.** One announcement email to every registered account — including never-verified users — sent a few days before the flip ("heads-up + what changes"). No pre-flip in-app banner. Unauthenticated users simply land on `/login` at the flip.
- **D-02: Post-flip in-app notice = persistent strip on `/login`.** A notice strip ("Sign-in moved to a new system — sign in with your existing email and password") rendered for an env-dated window (`notice` start/end envs), non-dismissible, zero client state, self-cleaning when the window closes. This is the audit Q-4 "in-app" half.
- **D-03: Mid-session users at flip time: accept the blip.** The deploy instantly invalidates JWTs; users get a 401 → the existing per-component redirect to `/login` (now showing the notice strip). No new "session expired" UX is built — the announcement email already explains why.
- **D-04: Blast mechanics = queue fan-out.** An operator-triggered script enqueues one `email-transactional` job per registered user (render-at-enqueue, same render/enqueue helpers as verification email — 06 D-07 lineage). SMTP throttling inherits queue concurrency; console provider dry-runs the blast locally first. No direct-SMTP bulk path, no out-of-band sending.
- **D-05: Blast script is delete-after-use.** Ships in the flip release, runs once on production, deleted in the deletion release; the D-41 remnant gate extends to keep both the script and the notice-window envs out afterwards.
- **D-06: Copy is drafted in-plan, approved at rehearsal.** Planner/executors draft the email + notice text (visible in plan review); the operator signs off at the deploy rehearsal by inspecting exact rendered bytes via the console provider.
- **D-07: Slip rule is a runbook line, not code.** If the flip slips more than ~48h past the announced date, re-run the blast script with updated copy; otherwise say nothing.

#### Admin bootstrapping, roles & Bull Board (SEC-04 / OBS-04)

- **D-08: First admin is minted by an env-fed migration step.** The cutover migration reads `ADMIN_EMAILS` (comma-separated), sets `role='admin'` for matching users. The snapshot rehearsal proves an admin AND a non-admin surface before any production flip.
- **D-09: `ADMIN_EMAILS` missing/empty/zero-match ABORTS the migration** (throw-early convention, 06 D-11 lineage).
- **D-10: Roster = just the operator.** `ADMIN_EMAILS` holds exactly the operator's account email; gates are exercised with a real second (non-admin) account in tests.
- **D-11: Ongoing role changes = runbook SQL one-liner.** Parameterized grant/revoke UPDATE documented in the runbook with the "sign out/in to take effect" note.
- **D-12: `ADMIN_EMAILS` stays in `.env.example` as the documented roster** (DEP-05 annotation form); it has no runtime role after the migration.
- **D-13: Admin-plugin scope = role primitive only.** The plugin is enabled for the role column and server-side role checks powering the gates. Its management endpoints (ban/unban, impersonate, user listing) stay unused.
- **D-14: Admin-gating surface is exactly feedback-GET + Bull Board.** `GET /api/feedback` becomes admin-only (fixes R17); feedback POST stays for all authenticated users; no other endpoint is swept.
- **D-15: Feedback consumption is API-only.** The operator reads feedback via a runbook-documented curl or SQL until a future UI exists.
- **D-16: Admin-surface access logs one structured line** (userId, route, IP, timestamp) into the existing request logging.
- **D-17: IP allowlist reaches Bull Board ONLY.** `ADMIN_IP_ALLOWLIST` env (IPs/CIDRs) gates the queue UI; the feedback API stays reachable from any IP with a valid admin session.
- **D-18: Bull Board mounts on the worker's existing :9090 HTTP server** (beside healthz/readyz/metrics), gated in order: IP allowlist → Better Auth admin session (cookie validated from the request). The web process stays a pure Postgres reader — no BullMQ in the web bundle.
- **D-19: Bull Board keeps its mutation powers.** Retry/remove/drain stay enabled.

#### Pre-flip token & link fate (EML-04 / token flows)

- **D-20: Old links are dead on arrival.** Verification/reset links issued before the flip stop working. Legacy token tables stay read-only purely as a rollback window — never consulted by the new flow. No dual-source token code.
- **D-21: New link TTLs = Better Auth defaults.** Researcher confirms exact values against the installed version. Zero tuning surface; no explicit pinning.
- **D-22: Reset rules mirror today, 1:1.** Reset requires a password hash to exist — OAuth-only accounts get the clear "this account signs in with Google/GitHub" message; reset succeeds regardless of `emailVerified` status. Researcher pins the current route behavior first; zero new policy.
- **D-23: The email-verification login gate survives as-is.** Unverified credentials users still cannot log in until verified. The boolean backfill maps each user's legacy timestamp: set → `true`, null/false → `false`.
- **D-24: Rate limits = parity policy.** Every auth endpoint with a limit today keeps an equivalent limit after cutover (register, forgot-password ~5/h per IP; login whatever it has today — researcher pins the current coverage list). Mechanism is researcher/planner territory.
- **D-25: No session on sign-up until verified.** Registration must NOT mint a usable session.
- **D-26: OAuth cross-provider linking mirrors today.** Researcher pins NextAuth v4's effective behavior (same-email different-provider login → account-not-linked error, linking not automatic) and the cutover reproduces it under Better Auth. No auto-linking.
- **D-27: Legacy table data drops with the tables.** No export/archive step.
- **D-28: Password reset revokes other sessions — the one deliberate security improvement.** Better Auth's native revoke-on-password-change.

#### Release structure, rollback & Prisma exit (AUTH-07 / DRZ-07)

- **D-29: Flip → soak → deletion, textbook expand/contract.** Release 1 (flip): Better Auth live, Prisma/NextAuth still installed but serving nothing. Release 2 (deletion): NextAuth deps+routes, Redux `auth` slice, token mirror, `js-cookie`, Prisma directory/deps/adapter all removed; D-41 gate extended.
- **D-30: Rollback lever = redeploy-only (no DB restore).** The cutover migration is purely additive.
- **D-31: Soak = ~24h + a typed gate checklist.** Evidence writes into `07-DEPLOY-RECORD.md`.
- **D-32: Legacy tables drop in an explicit drop release.** After its own short soak — inside or right at the phase's close.
- **D-33: Auth pages = same pixels, new plumbing.** Login/register/forgot/reset/verify pages keep exact current visuals; only the client swaps, with error-message parity.

#### Rehearsal & canary (AUTH-02 / AUTH-05)

- **D-34: Full flip rehearsal on the refreshed snapshot.** Regenerate the anonymized snapshot from current production first.
- **D-35: The redeploy rollback is DRILLED, not argued.**
- **D-36: One operator approval gate: soak-green → deletion release.**
- **D-37: Snapshot canary = one designated real-email account.** Keeps/receives the operator's real email and a known bcrypt hash.
- **D-38: Production canary = the operator.** Old-password login, then one Google and one GitHub login before the soak clock starts.
- **D-39: The operator account holds all three login types BEFORE flip night.**
- **D-40: Refresh-token preservation is proven from two angles.** Snapshot: pre/post-reshaping row-count comparison per provider. Production: post-flip OAuth logins complete WITHOUT a re-consent screen.
- **D-41: Canary-red = immediate redeploy, pre-committed.**

#### Session lifetime

- **D-42: 30-day session expiry, parity with today's JWTs.**
- **D-43: Sliding renewal via engine defaults.** Researcher confirms exact values against the installed version.
- **D-44: Concurrent sessions unlimited, parity.**

### Claude's Discretion

- Exact announcement email + notice-strip copy (drafted in-plan per D-06, operator-approved at rehearsal).
- Rate-limit mechanism selection (Better Auth built-in vs house Lua limiter) and the current login-coverage pin (D-24).
- Exact cookieCache TTL and revocation-lag policy (explicitly research-routed by the roadmap; the only user-visible anchor locked here is the 30-day outer expiry).
- Better Auth base-path mapping (expected to keep `/api/auth/*` shape so client call sites and runbook URLs stay stable — researcher verifies).
- Deploy-record structure for 07 (inherits the 03-08/04/05 disposition-register pattern).
- Worker restart choreography within the flip/deletion releases (runbook §4 ordering; worker restart required because :9090 gains Bull Board).
- Blast-script internals (recipient enumeration via Drizzle, env for the flip date in copy, batch/concurrency parameters).

### Deferred Ideas (OUT OF SCOPE)

- Admin feedback viewer UI (list + status update page) — per D-15.
- Better Auth admin-plugin management endpoints (ban/unban, impersonate, user listing) — per D-13.
- Resend-verification affordance for unverified users — per the token-area "mirror today" decision.
- Password-setting for OAuth-only accounts — per D-22.
- Same-email OAuth auto-linking — per D-26.
- Session-count caps / "sign out everywhere" affordance — per D-44.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-01 | Better Auth configured with bcrypt-compatible `password.hash`/`verify` (gate, not spike) with hash-prefix routing (A-1) | `emailAndPassword.password.{hash,verify}` config surface confirmed (official docs); default is scrypt; prefix-routing pattern in Code Examples; `bcryptjs@3.0.3` already in repo [VERIFIED: package.json:37] |
| AUTH-02 | Canary login through the preserved hash path before any route flip — snapshot then production | A-1 gate ordering (audit §12.2); rehearsal substrate D-34/D-37 (canary designation); canary failure → D-41 pre-committed redeploy |
| AUTH-03 | Adapter bound to existing `users` table; `account`/`session`/`verification` added; boolean `emailVerified` backfilled | `user.modelName`/`user.fields` mapping + `advanced.database.generateId: false` (DB-side defaults) confirmed from docs; audit §12.1 field maps; add a NEW boolean column (name = planner's), never touch the timestamp |
| AUTH-04 | `cookieCache` so the proxy validates from the signed cookie without a per-request DB hit (A-2) | `session.cookieCache: { enabled, maxAge: 300, strategy }` (jwt default); `getSessionCookie`/`getCookieCache` helpers; Next.js 16 proxy convention compatible (docs integration page); revocation-lag policy in cookieCache section |
| AUTH-05 | OAuth accounts reshaped with verified field map; `providerId` casing confirmed by dry-run; refresh tokens preserved | `account` column map (audit §12.1); `providerId` = provider config key, lowercase `google`/`github` (two official pages); D-39/D-40 two-angle proof; reshaping script pattern below |
| AUTH-06 | Forced re-login announced in-app/email (Q-4) | D-01..D-07 blast + notice strip; hook fan-out reuses `enqueueTransactionalEmail` [VERIFIED: src/lib/email/enqueue.ts:46-53]; UI contract in 07-UI-SPEC |
| AUTH-07 | NextAuth deps and custom auth routes removed; legacy tables read-only one release, then dropped | Deletion-release removal list pinned from package.json; D-29/D-32 release structure; remnant-gate pattern (06-05 precedent: `check-cron-remnants.mjs`) |
| AUTH-08 | Duplicated client auth state removed (Redux `auth` slice, token mirror, `js-cookie`); Better Auth client is single source | `better-auth/react` `createAuthClient` + `useSession` replaces SessionProvider; deletion surface pinned: `src/redux/features/auth/authSlice.ts`, `js-cookie` usage in `TeamSwitch.tsx` |
| AUTH-09 | Lazy rehash-on-login upgrades stored hash to the modern default | No native rehash API found in 1.7 docs — implement inside the `verify` closure (successful legacy-prefix verify → fire-and-forget UPDATE of that account's password through `password.hash`); pattern + caveats in Code Examples [ASSUMED on mechanism] |
| DRZ-07 | Prisma fully removed: `prisma/`, generated client, `@prisma/*` deps, adapter config deleted | Removal list: `@prisma/client`, `@prisma/adapter-pg`, `prisma` (dev), `@auth/prisma-adapter`, `next-auth`, `js-cookie` (+`@types/*`); build script's `prisma generate &&` prefix [VERIFIED: package.json:8,29-33,50,47]; `_prisma_migrations` ABSENT [VERIFIED: src/db/schema.ts:38-40] |
| EML-04 | Better Auth hooks (`sendVerificationEmail`, `sendResetPassword`) delegate to the same queue | Hook signatures `({ user, url, token }, request)` confirmed; delegation pattern via `enqueueTransactionalEmail`; render.ts domain-source delta flagged (NEXTAUTH_URL → BETTER_AUTH_URL); link-shape inversion (API-first, not page-first) documented |
| SEC-04 | Admin role via Better Auth admin plugin; feedback listing admin-gated; queue UI admin-gated + IP allowlist | `admin()` plugin adds `role` (+ `banned`/`banReason`/`banExpires`) to user and `impersonatedBy` to session; `adminRoles` default `["admin"]`; server check = `session.user.role === "admin"` or `auth.api.userHasPermission`; R17 leak pinned at src/app/api/feedback/route.ts:43-72 |
| OBS-04 | Bull Board queue inspection behind admin auth + IP allowlist | `@bull-board/hono@9.10.1` + `hono@^4` official adapter; mount pattern from bull-board's own `with-hono` example; gate chain (socket-source allowlist → admin session) on the worker's existing `node:http` :9090 server; loopback-bind interaction flagged |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Session issuance/validation (login, cookie, cookieCache) | Frontend Server (SSR/API route) | Database/Storage | Better Auth instance runs in the Next web process; sessions persist in Postgres; proxy reads the signed cookie cache |
| Route protection (`/dashboard/*`) | Frontend Server (Next 16 proxy) | — | `src/proxy.ts` swaps `getToken` → `auth.api.getSession`/`getCookieCache`; same matcher |
| Credentials login (bcrypt path + lazy rehash) | API/Backend (Better Auth core) | Database/Storage | `emailAndPassword.password.{hash,verify}` in the web process; hashes live in `account` rows |
| OAuth (Google/GitHub) | API/Backend (Better Auth core) | External providers | `socialProviders` config; callback stays at `/api/auth/callback/{provider}` |
| Email verification / password reset flows | API/Backend (Better Auth core) | Worker (email lane) | Better Auth endpoints own tokens; emails delegate to the Phase-6 queue, transported by the worker |
| Announcement blast + notice strip | API/Backend (blast script enqueues) | Frontend Server (strip render) | Script enumerates via Drizzle and enqueues; strip is server-rendered on `/login` from env window |
| Admin role primitive + feedback gate | API/Backend | Database/Storage | `role` column seeded by migration; `GET /api/feedback` checks the session's role server-side |
| Bull Board + IP allowlist | API/Backend (worker process) | — | D-18: worker's :9090 `node:http` server; web stays a pure Postgres reader |
| Prisma removal | API/Backend + Build | — | Dep/deletion-release concerns: package.json, build script, `prisma/` dir, generated client |
| Rate limiting (auth endpoints) | API/Backend | Redis | Better Auth `rateLimit` (secondary-storage/Redis) or house Lua limiter wrapped via `hooks.before` — planner's call per D-24 |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-auth | 1.7.5 (exact pin) | The auth framework: sessions, credentials, OAuth, verification/reset, admin plugin, rate limiter | Latest 1.7 line (published 2026-09-14, ~6.07M weekly downloads); peers match the repo exactly (`next ^16`, `drizzle-orm ^0.45.2`, `drizzle-kit >=0.31.4`) [VERIFIED: npm registry, npm view better-auth peerDependencies] |
| bcryptjs | ^3.0.3 (already in repo) | Legacy hash verify + modern hash in the A-1 gate | Keeps every existing hash verifiable; pure JS (no native build on the VPS); own types since v3 [VERIFIED: package.json:37] |
| @bull-board/api | 9.10.1 | Bull Board core + `BullMQAdapter` | Official felixmosh/bull-board monorepo, current 9.x line [VERIFIED: npm registry] |
| @bull-board/hono | 9.10.1 | Bull Board adapter for the worker's `node:http` server | Official adapter with hono `^4` peer; avoids pulling Express 5 into the worker bundle; matches D-18's "existing :9090 server" [VERIFIED: npm registry — deps: ejs, @bull-board/ui, @bull-board/api; peer: hono ^4] |
| hono | ^4.13.8 | Tiny router hosting the Bull Board plugin inside the worker | Peer of @bull-board/hono; `getRequestListener` bridges fetch-style handlers onto `node:req/res` [VERIFIED: npm registry: hono 4.13.8, @hono/node-server 2.1.1] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @better-auth/redis-storage | 1.7.5 (version-locked to better-auth) | ioredis-backed `secondaryStorage` so the built-in rate limiter persists across PM2 restarts | If the planner picks Better Auth's built-in rateLimiter (D-24 recommendation below) [VERIFIED: npm registry — created 2026-01-28, version tracks better-auth] |
| @hono/node-server | ^2.1.1 | `getRequestListener(fetchHandler)` bridge from `node:http` to the hono app | Mounting Bull Board inside the existing health server without a second port [VERIFIED: npm registry] |
| @better-auth/drizzle-adapter | 1.7.5 | The split-out Drizzle adapter package (docs' default for new installs) | NOT needed at the 1.7.5 pin — `better-auth/adapters/drizzle` still ships in the core exports; listed so the planner recognizes the docs-page import difference [VERIFIED: unpkg better-auth@1.7.5 package.json exports include './adapters/drizzle'; npm registry shows the standalone package at the same 1.7.5 line] |
| ipaddr.js | (planner's pick; e.g. ^2.x) | CIDR matching for `ADMIN_IP_ALLOWLIST` | Only if the allowlist needs real CIDR semantics; a small tested IPv4/IPv6 matcher is acceptable for the operator's tiny roster |

**Installation (flip release):**
```bash
pnpm add better-auth@1.7.5 @bull-board/api@9.10.1 @bull-board/hono@9.10.1 hono@^4.13.8 @hono/node-server@^2.1.1
# optional, if built-in rateLimiter w/ Redis storage is chosen (D-24):
pnpm add @better-auth/redis-storage@1.7.5
```

**Installation (deletion release):**
```bash
pnpm remove next-auth @auth/prisma-adapter @prisma/client @prisma/adapter-pg prisma js-cookie @types/js-cookie
# then: delete prisma/ dir, src/lib/prisma.ts, src/lib/tokens.ts, custom auth routes,
# src/app/api/auth/[...nextauth]/, Redux authSlice, AuthProvider (NextAuth SessionProvider),
# build script's `prisma generate && ` prefix, src/generated/prisma artifacts
```

**Version verification:** All versions above were read live from the npm registry this session (2026-09-22): better-auth 1.7.5 (`time.modified 2026-09-14T22:10:53Z`), @bull-board/* 9.10.1 (2026-09-12), hono 4.13.8, @hono/node-server 2.1.1. Drizzle-orm stays at the repo's `^0.45.2` — better-auth 1.7.5's peer range `^0.45.2 || >=1.0.0-rc.1 <2.0.0` includes it [VERIFIED: npm view better-auth peerDependencies].

## Package Legitimacy Audit

> Run via `gsd-tools query package-legitimacy check --ecosystem npm` this session.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| better-auth | npm | ~8 days (latest publish) | 6.07M/wk | github.com/better-auth/better-auth | SUS (`too-new`) | Approved — SUS reason is publish recency only; official org repo, no postinstall. Operator checkpoint per Phase-4 precedent (04-01: SUS-by-recency set approved at the blocking gate) |
| @bull-board/api | npm | ~10 days | 1.25M/wk | github.com/felixmosh/bull-board | SUS (`too-new`) | Approved — same recency artifact; canonical repo |
| @bull-board/hono | npm | ~10 days | 102K/wk | github.com/felixmosh/bull-board | SUS (`too-new`) | Approved — same; planner adds the one `checkpoint:human-verify` covering the whole set |
| @bull-board/express | npm | ~10 days | 908K/wk | github.com/felixmosh/bull-board | SUS (`too-new`) | NOT installed (hono path chosen); listed for completeness |
| @bull-board/ui | npm | ~10 days | 1.24M/wk | github.com/felixmosh/bull-board | SUS (`too-new`) | Pulled transitively by the hono adapter; same disposition |
| bcryptjs | npm | established | 9.7M/wk | github.com/dcodeIO/bcrypt.js | OK | Already in repo |
| @better-auth/redis-storage | npm | version-locked 1.7.5 | — | better-auth org (monorepo) | not separately rated | Official monorepo package; covered by the same checkpoint if installed |
| hono / @hono/node-server | npm | established | — | github.com/honojs/* | OK-tier peers | Official honojs org |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** better-auth, @bull-board/api, @bull-board/hono, @bull-board/ui — all solely for `too-new` (latest publish < ~2 weeks). All have no `postinstall` script (verified in the legitimacy signals). Planner inserts one `checkpoint:human-verify` before the flip-release install, mirroring the 04-01 operator-approved precedent.

## Architecture Patterns

### System Architecture Diagram

```
                                   FLIP RELEASE TOPOLOGY
┌─────────────┐   authClient (better-auth/react)   ┌──────────────────────────────────┐
│   Browser    │ ── signUp.email / signIn.email ──▶ │  Next web process (:3007, PM2)   │
│  (React app) │ ── signIn.social({provider})      │                                  │
│              │ ◀─ useSession()/getSession() ─────  │  /api/auth/[...all]              │
└─────────────┘                                     │   └─ toNextJsHandler(auth)       │
      │                                             │        └─ betterAuth({           │
      │  signed session cookie (+ cookieCache)      │            drizzleAdapter(db,    │
      ▼                                             │              schema:{user:users, │
┌──────────────────┐                                │              account, session,   │
│ Next proxy        │  getCookieCache /              │              verification})      │
│ (src/proxy.ts,    │  auth.api.getSession            │          emailAndPassword(+A-1)  │
│  /dashboard/:path*)│ ────────────────────────────▶ │          socialProviders{google, │
└──────────────────┘  no per-request DB hit          │            github}               │
      │                                             │          session{expiresIn:30d,  │
      ▼                                             │            cookieCache{5min}}    │
┌──────────────────────────────────────────┐        │          account.accountLinking  │
│ Postgres (Neon) — source of truth         │◀───────│            .disableImplicitLinking│
│  users (+role, +boolean emailVerified col) │        │          admin() plugin (role)   │
│  account (reshaped OAuth + credential pws) │        │          emailVerification /     │
│  session / verification (new, empty)       │        │          sendResetPassword hooks │
│  users/sessions/verification_tokens/       │        │            └─ enqueue (D-07) ──┐ │
│  password_reset_tokens/accounts = READ-ONLY│        └────────────────────────────────┘ │
└──────────────────────────────────────────┘                                            ▼
                                                                              Redis (BullMQ)
┌──────────────────────────────────────────────────────────────┐                    │
│ Worker process (:9090 node:http, PM2 uptime-worker)           │◀───────────────────┘
│  existing: /healthz /readyz /metrics.json /metrics (loopback) │  email lane worker
│  NEW:      /admin/queues (Bull Board via @bull-board/hono)     │  └─ SMTP/console transport
│   gate 1: ADMIN_IP_ALLOWLIST (socket remote address)           │
│   gate 2: Better Auth admin session (auth.api.getSession       │  announcement blast:
│           from request headers → role === 'admin')             │   operator script (D-04/05)
│   audit line per hit (D-16)                                    │   enqueues one job/user
└──────────────────────────────────────────────────────────────┘
```

Rollback path (D-30): redeploy the previous tarball → NextAuth/JWT path runs again against the untouched legacy tables; rows written during the Better-Auth window get the reconciliation note in the deploy record.

### Recommended Project Structure

```
src/
├── lib/
│   ├── auth.ts                  # REWRITTEN: createAuth() factory returning the betterAuth instance
│   │                            #   (Next-free — importable by the worker; toNextJsHandler stays in the route)
│   ├── auth-client.ts           # NEW: createAuthClient from better-auth/react (single client source)
│   ├── email/render.ts          # domain source swaps NEXTAUTH_URL → BETTER_AUTH_URL (template bytes frozen);
│   │                            #   hook-facing variants accept a prebuilt url
│   └── email/enqueue.ts         # unchanged — the hooks' delegation target
├── app/api/auth/[...all]/route.ts   # NEW catch-all (replaces [...nextauth]) — exports GET/POST from toNextJsHandler
├── app/api/auth/{register,verify-email,forgot-password,reset-password}/  # die at flip (code), deleted at deletion release
├── app/api/feedback/route.ts    # GET gains the admin gate (D-14); POST unchanged
├── proxy.ts                     # getToken → auth.api.getSession / getCookieCache; same matcher
├── components/Auth/*.tsx        # plumbing swap only (D-33): next-auth/react → @/lib/auth-client
├── components/dashboardLayout/TeamSwitch.tsx   # js-cookie usage dies at deletion release
├── redux/features/auth/authSlice.ts            # deleted at deletion release (AUTH-08)
├── db/schema.ts                 # + role, + boolean emailVerified col, + account/session/verification tables
└── worker/
    ├── bull-board.ts            # NEW: HonoAdapter mount + gate chain + D-16 audit line
    └── health.ts                # gains the /admin/queues delegation (host/bind decision — see Pitfalls)
scripts/
├── send-relogin-blast.mjs       # NEW flip-release, delete-after-use (D-04/D-05); Drizzle enumeration
└── rehearse-migrations.mjs      # WR-05 journal-count fix + extend digest inventory for new tables FIRST
drizzle/
└── 000X_better_auth_cutover.sql # additive-only: new tables + users.role + boolean col + reshaped copies + admin seed
```

### Pattern 1: The Better Auth instance with every parity pin (the phase's centerpiece)

**What:** one `betterAuth()` config that encodes D-21..D-28, D-42..D-44 as explicit pins.
**When to use:** the flip release; this is the replacement for `src/lib/auth.ts`.

```typescript
// Source: better-auth.com/docs/{reference/options, concepts/database, concepts/users-accounts,
//         authentication/email-password, concepts/session-management, plugins/admin} (all fetched 2026-09-22)
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle"; // verified shipped in better-auth@1.7.5 exports
import { admin } from "better-auth/plugins";
import { db } from "@/db";                    // existing drizzle(pgPool) instance
import * as schema from "@/db/schema";        // the single schema authority (D-07)
import { hashPassword, verifyPassword } from "./auth-password"; // A-1 prefix routing (below)

export function createAuth() {
  return betterAuth({
    basePath: "/api/auth",                    // default — keeps /api/auth/* shape (discretion item, verified)
    secret: process.env.BETTER_AUTH_SECRET,   // throw-early convention (06 D-11) if absent in production
    trustedOrigins: [process.env.BETTER_AUTH_URL!],  // baseURL origin is auto-trusted; add if the app URL differs

    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {                               // "Using Existing Tables" — map models onto our tables
        user: schema.users,                   // modelName maps model `user` → physical `users`
        account: schema.account,              // NEW table
        session: schema.session,              // NEW table
        verification: schema.verification,    // NEW table
      },
    }),

    // A-3: existing table bound without renames; camelCase physical columns mapped via fields.
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified_bool", // NEW boolean column (name = planner's call; audit §12.1 truthiness backfill)
        // name/email/image/createdAt/updatedAt match our column names — no mapping needed
      },
      additionalFields: { role: { type: "string", defaultValue: "user", input: false } }, // admin plugin alternative — prefer the plugin's own field
    },

    account: {
      accountLinking: {
        disableImplicitLinking: true,         // D-26 PARITY PIN — engine default is AUTO-LINK (inverted!)
      },
    },

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,         // D-23 gate survives (unverified → 403)
      minPasswordLength: 6,                   // parity with today's register/reset rule (engine default 8)
      autoSignIn: false,                      // D-25 PARITY PIN — engine default TRUE mints a session on sign-up
      revokeSessionsOnPasswordReset: true,    // D-28 — the ONE deliberate delta (engine default false)
      resetPasswordTokenExpiresIn: 3600,      // Better Auth default (1h) — equals today's reset TTL (D-21: keep defaults)
      password: { hash: hashPassword, verify: verifyPassword },   // A-1 gate
      sendResetPassword: async ({ user, url, token }, request) => {
        await enqueueTransactionalEmail(renderPasswordResetFromUrl(user.email, url, token)); // EML-04 → queue
      },
    },

    emailVerification: {
      expiresIn: 3600,                        // Better Auth default (1h) — today was 24h; D-21 says defaults win
      sendOnSignUp: true,                     // replaces today's register-route send (registration still emails)
      sendOnSignIn: false,                    // D-23 PARITY: no new email on blocked login attempts (default false)
      sendVerificationEmail: async ({ user, url, token }, request) => {
        await enqueueTransactionalEmail(renderVerificationEmailFromUrl(user.email, url, token));
      },
    },

    socialProviders: {
      google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
      github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! },
    },                                        // provider KEY = account.providerId value: "google" / "github" (lowercase)

    session: {
      expiresIn: 60 * 60 * 24 * 30,           // D-42: 30-day pin (default is 7d)
      updateAge: 60 * 60 * 24,                // D-43: engine default 1-day sliding renewal — keep
      freshAge: 300,                          // engine default (5 min freshness for sensitive ops)
      cookieCache: {                          // A-2 / AUTH-04
        enabled: true,
        maxAge: 5 * 60,                       // 5 min — the accepted revocation-lag bound (audit §12.3)
        strategy: "jwt",                      // engine default strategy; compact/jwe are alternatives
      },
    },

    advanced: {
      database: { generateId: false },        // defer to DB defaults (gen_random_uuid()::text) — §11/D-3 pin
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },  // pairs with the WR-06 carry-forward; behind the VPS proxy
    },

    plugins: [admin({ adminRoles: ["admin"] })],  // D-13: role primitive only; management endpoints left unused
  });
}
export const auth = createAuth();
```

### Pattern 2: A-1 hash-prefix routing (bcrypt gate — AUTH-01/AUTH-09)

**What:** `verify` routes stored-hash prefixes; `hash` always produces bcrypt today (the "modern default" is bcryptjs until a future migration changes it — the prefix router is what makes that future change non-breaking).
**When to use:** always, exactly as audit §12.2 prescribes.

```typescript
// Source: docs better-auth.com/docs/authentication/email-password (password config shape);
//         audit §12.2 (A-1). bcryptjs 3.0.3 API.
import bcrypt from "bcryptjs";

const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"];

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);           // parity with today's rounds [VERIFIED: register route, reset route]
}

export async function verifyPassword({ password, hash }: { password: string; hash: string }): Promise<boolean> {
  const isLegacyBcrypt = BCRYPT_PREFIXES.some((p) => hash.startsWith(p));
  if (isLegacyBcrypt) {
    const ok = await bcrypt.compare(password, hash);
    if (ok) void upgradeHash(hash, password); // AUTH-09 lazy rehash — fire-and-forget; see Assumptions A1
    return ok;
  }
  // future modern-default verification path; today unreachable (all rows are bcrypt)
  return false;
}

async function upgradeHash(legacyHash: string, password: string) {
  const modern = await bcrypt.hash(password, 10);
  // The verify() closure has no account identity — the legacy hash itself is the key
  // (bcrypt output is salted, hence unique per user in practice):
  await db.execute(sql`UPDATE "account" SET "password" = ${modern} WHERE "password" = ${legacyHash}`);
}
```

### Pattern 3: Credential-row backfill + OAuth reshape (cutover migration, rehearsed per D-34)

**What:** the purely additive SQL that makes logins work: credential account rows from `users.password`, reshaped OAuth rows from `accounts`, boolean backfill, role seed with abort.
**When to use:** inside `drizzle/000X_better_auth_cutover.sql` + the migration's guarded steps.

```sql
-- 1. Credential rows (audit §12.1: providerId 'credential', accountId = user id)
INSERT INTO "account" ("id","userId","providerId","accountId","password","createdAt","updatedAt")
SELECT gen_random_uuid()::text, u."id", 'credential', u."id", u."password", now(), now()
FROM "users" u WHERE u."password" IS NOT NULL
ON CONFLICT DO NOTHING;                        -- idempotent (§21/D9 rule)

-- 2. OAuth reshape — providerId casing CONFIRMED by dry-run before production (D-39/D-40)
INSERT INTO "account" ("id","userId","providerId","accountId","accessToken","refreshToken",
                       "idToken","accessTokenExpiresAt","scope","createdAt","updatedAt")
SELECT gen_random_uuid()::text, a."userId", a."provider", a."providerAccountId",
       a."access_token", a."refresh_token", a."id_token",
       to_timestamp(a."expires_at"), a."scope", now(), now()
FROM "accounts" a
ON CONFLICT DO NOTHING;

-- 3. Boolean backfill (audit §12.1: truthiness of the legacy timestamp)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_bool" boolean NOT NULL DEFAULT false;
UPDATE "users" SET "email_verified_bool" = ("emailVerified" IS NOT NULL);

-- 4. Admin seed (D-08/D-09) — parameterized by env at migration-runner level:
--    if ADMIN_EMAILS missing/empty/zero-match -> THROW (abort the migration)
UPDATE "users" SET "role" = 'admin' WHERE "email" = ANY(${ADMIN_EMAILS_ARRAY});
```

The dry-run (run on the snapshot FIRST) compares, per provider: row counts of `accounts` vs inserted `account` rows, and pre/post non-null counts of refresh/access tokens (D-40's snapshot proof). Nothing in the legacy tables is modified — D-30's redeploy-only rollback rests on this.

### Pattern 4: Email hooks → queue delegation (EML-04, 06 D-07 lineage)

**What:** Better Auth's hooks receive `{ user, url, token }`; they render (render-at-enqueue) and enqueue — never SMTP in-request.
**Key shape change vs today:** today's links hit the *pages* (`/verify-email?token=`, `/reset-password?token=` — [VERIFIED: src/lib/email/render.ts:87,100]); Better Auth's `url` hits its *API* endpoint, which verifies/resets and then redirects to a `callbackURL`. The hooks must pass Better Auth's `url` into the rendered email (new render variants taking a prebuilt url), while the HTML template bytes stay frozen (EML-05).
**When to use:** flip release; re-capture `tests/lib/email-render.test.ts` fixtures for the new link values (fixture delta, template unchanged).

### Pattern 5: Admin gating (SEC-04 / D-14 / D-16)

```typescript
// GET /api/feedback — after (R17 fix). Session comes from Better Auth server-side:
const session = await auth.api.getSession({ headers: await headers() });  // or getServerSession-equivalent via request
if (!session) return apiError(401, "Unauthorized");
if (session.user.role !== "admin") return apiError(403, "Forbidden");     // role primitive (D-13)
// ... Drizzle read (join users for name/email/image as today)
```
The worker's Bull Board gate (D-17/D-18): (1) compare `req.socket.remoteAddress` against `ADMIN_IP_ALLOWLIST` (socket source — no spoofable header on a direct connection); (2) build a `Headers` object from the request, `const s = await auth.api.getSession({ headers })`, require `s?.user.role === "admin"`; (3) emit the D-16 structured line (userId, route, IP, timestamp) for every hit, allowed or refused.

### Pattern 6: Bull Board on the existing :9090 server (OBS-04)

```javascript
// Source: felixmosh/bull-board examples/with-hono/index.js (verbatim API shape, fetched 2026-09-22);
//         @hono/node-server README (getRequestListener bridge).
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { Hono } from "hono";
import { getRequestListener, serveStatic } from "@hono/node-server/serve-static"; // serveStatic from @hono/node-server

// inside src/worker/health.ts's handle(), before the 404:
//   if (path.startsWith("/admin/queues")) { gate chain; then: }
const app = new Hono();
const serverAdapter = new HonoAdapter(serveStatic);
createBullBoard({ queues: [/* BullMQAdapter per queue */], serverAdapter });
serverAdapter.setBasePath("/admin/queues");
app.route("/admin/queues", serverAdapter.registerPlugin());
// bridge fetch-style app onto node:req/res (env properly provided for serveStatic):
return new Promise((resolve) => getRequestListener(app.fetch)(req, res).once("finish", resolve));
```
Mutation powers stay enabled (D-19 — Bull Board's default). The gate chain runs *before* delegation; refusals are answered by the health server itself (403 + D-16 line), never by Bull Board.

### Anti-Patterns to Avoid

- **Trusting engine defaults on linking/sign-up/session-mint:** three defaults are inverted vs our parity (auto-linking ON, autoSignIn ON, revoke-on-reset OFF). Every parity decision must appear as an explicit pin in the config.
- **Copying legacy tokens into `verification`:** forbidden twice over — D-20 kills old links, and Better Auth stores `verification.value` *hashed* (a copied plaintext token could never match). Both token flows start empty.
- **Renaming or dropping legacy columns in the cutover migration:** the timestamp `emailVerified` stays untouched; the boolean is a NEW column mapped via `user.fields`. Renames break D-30's redeploy-only rollback.
- **Running `npx auth@latest generate/migrate`:** this repo owns its schema in `src/db/schema.ts` (D-07, single authority) under the 03-07 pull-formatting gate. Hand-author the tables + a drizzle-kit migration; never let the CLI emit a second schema file.
- **Importing Next-only modules into the worker auth path:** keep `createAuth()` free of `next/headers`/`next-auth`; the worker needs the same instance (or a DB-side check) for the Bull Board gate, but must keep the D-08 "zero Next imports" boundary.
- **Debugging on production:** D-41 — canary red means immediate redeploy; post-mortem on the snapshot.
- **Bulk rehash job:** AUTH-09 is lazy by design (audit §12.2); a bulk job is new machinery and a lockout amplifier if buggy.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Password hashing/verification | Custom crypto, timing-safe compare from scratch | `bcryptjs` behind Better Auth's `password.{hash,verify}` | bcrypt prefix/variant subtleties ($2a/$2b/$2y); the framework owns salt/verify plumbing |
| Session cookie signing, refresh, revocation | DIY signed-cookie scheme | Better Auth sessions + `cookieCache` | Rotation, expiry, `updateAge`, revocation semantics are load-bearing and battle-tested |
| Verification/reset tokens | Custom token tables/routes (today's) | Better Auth `verification` table + flows | Hashed token storage, single-use, expiry, enumeration protection — D-20/D-21 make this a wholesale swap |
| OAuth state/PKCE/refresh | Manual provider plumbing | Better Auth `socialProviders` | PKCE automatic, 32-char state w/ 10-min expiry, refresh helpers per docs |
| CSRF/origin checks | Custom middleware | Better Auth `trustedOrigins` + Fetch Metadata checks | Multi-layer and maintained |
| Rate limiting math | New limiter for auth endpoints | Better Auth `rateLimit` (Redis `secondaryStorage`) or the existing house Lua limiter | D-24: reuse a proven engine; `customRules` map today's 5/h limits 1:1 |
| Queue inspection UI | Custom admin dashboard | `@bull-board/*` (explicitly out-of-custom-design-scope per 07-UI-SPEC) | The library's console is the contract |
| CIDR matching | Untested string parsing | `ipaddr.js` or a small table-tested util | `ADMIN_IP_ALLOWLIST` gates a mutation-capable surface; a subnet bug is an auth bypass |
| Transactional email HTML | New templates | `src/lib/email/render.ts` (byte-frozen) + queue | EML-05 parity pin |

**Key insight:** Phase 7's safety comes from *deleting* hand-rolled auth (custom token tables, JWT mirror, Redux duplication) and letting the framework own the sharp edges — while the migration keeps the *data* (hashes, OAuth tokens, user IDs) byte-preserved.

## Runtime State Inventory

> Rename/refactor/migration phase — all five categories answered explicitly.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Legacy `sessions` (dead rows, JWT strategy never read them — [VERIFIED: src/lib/auth.ts:11-13]) / `verification_tokens` / `password_reset_tokens` / `accounts` (live OAuth rows to reshape) / `users.password` bcrypt hashes (to copy into credential `account` rows) / `users.emailVerified` timestamp (to backfill into the new boolean) | Data migration in the cutover SQL (Patterns 3); legacy tables READ-ONLY until the drop release (D-27/D-32). `_prisma_migrations` table ABSENT — nothing to clean [VERIFIED: src/db/schema.ts:38-40]. `users.password` column itself is retained (inert) — no column drop this milestone |
| Live service config | Google/GitHub OAuth apps' registered redirect URIs (provider consoles, outside git): current callback `{host}/api/auth/callback/{provider}`; Better Auth's default redirect is the identical path (`/api/auth/callback/${providerName}`) [CITED: better-auth.com/docs/concepts/oauth.md] — so keep `basePath` `/api/auth` and NO provider-console changes are needed; verify at flip (D-38 exercises both providers) | Verify-only at flip; if basePath ever changes, the provider consoles must be edited — avoid |
| OS-registered state | PM2 apps `uptime-tracker` + `uptime-worker` — names/topology unchanged [VERIFIED: ecosystem.config.js:4,24]; worker restart required at flip (D-18: :9090 gains Bull Board) and at the drop releases per runbook §4 | No re-registration; runbook restart choreography only |
| Secrets/env vars | `NEXTAUTH_SECRET` read by `src/proxy.ts:9` and `src/lib/auth.ts:97`; `NEXTAUTH_URL` read by `src/lib/email/render.ts:15` at MODULE SCOPE (test fixtures pin it — tests/api/auth-shallow.handler.test.ts:36-38 note); `.env.example` already annotates retirement + the commented `BETTER_AUTH_SECRET` placeholder [VERIFIED: .env.example:14,19,29]. Arrivals: `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`, `ADMIN_EMAILS` (migration-time), `ADMIN_IP_ALLOWLIST`, notice-window envs | Flip release: new envs live; render.ts domain source switches to `BETTER_AUTH_URL`. Deletion release: `NEXTAUTH_*` envs + annotations removed (D-41 gate extended). Operator updates VPS `.env` at each release |
| Build artifacts | `package.json:8` build script starts `pnpm exec prisma generate && ` (remove at deletion); `src/generated/prisma` (gitignored) rides in deploy tarballs today (02-04 note) and disappears after removal; `pnpm-lock.yaml` churns at both releases; `@types/js-cookie`, `@types/bcryptjs` (keep bcryptjs) in devDeps | Deletion-release checklist: deps, build-script prefix, lockfile, tarball contents; CI/verify pipeline untouched (`global-setup.ts` already migrates via drizzle-kit [VERIFIED: tests/setup/global-setup.ts:57]) |

## Common Pitfalls

### Pitfall 1: Scrypt default locks out every credentials user
**What goes wrong:** Better Auth's default `password.hash` is scrypt; every stored hash is bcrypt.
**Why it happens:** engine defaults assume greenfield.
**How to avoid:** wire `emailAndPassword.password.{hash,verify}` at config time (A-1); canary gate ordering snapshot → production → flip is non-negotiable (D-37/D-38/D-41).
**Warning signs:** any credentials canary login failing with INVALID_EMAIL_OR_PASSWORD after the flip.

### Pitfall 2: Same-email OAuth auto-linking silently merges identities
**What goes wrong:** Better Auth's `accountLinking.enabled` defaults to true — an OAuth sign-in whose email matches an existing user is *silently linked*; NextAuth v4 rejected exactly this with `OAuthAccountNotLinked` (D-26's pinned baseline — confirmed via NextAuth docs/GitHub this session).
**How to avoid:** `account.accountLinking.disableImplicitLinking: true` → engine returns the `account_not_linked` error instead. Add a D-33-parity client mapping for it.
**Warning signs:** a user gaining Google access to a GitHub-only account post-flip.

### Pitfall 3: Sign-up mints a session (D-25 violation)
**What goes wrong:** `emailAndPassword.autoSignIn` defaults to true — a fresh registration lands logged-in, bypassing the verification gate.
**How to avoid:** `autoSignIn: false` explicitly; pair with `sendOnSignUp: true` + `requireEmailVerification: true`.

### Pitfall 4: Resend-on-login-attempt behaves differently from today
**What goes wrong:** docs describe unverified sign-in attempts triggering a new verification email; the granular control is `emailVerification.sendOnSignIn` (default false) — leaving it unset preserves today's behavior (403 error only, no new email — today's authorize throws at [VERIFIED: src/lib/auth.ts:47-49]). The two docs pages state the interaction differently; pin `sendOnSignIn: false` explicitly and re-verify against the installed source at implementation.
**Warning signs:** SMTP volume spikes from repeated failed logins.

### Pitfall 5: Email link domain silently breaks when NEXTAUTH_URL retires
**What goes wrong:** `render.ts:15` reads `process.env.NEXTAUTH_URL` at module scope for every verification/reset/blast link; the deletion release removes that env.
**How to avoid:** flip release switches the domain source to `BETTER_AUTH_URL` (or passes Better Auth's `url` into the render variants); update the pinned env in `tests/api/auth-shallow.handler.test.ts`. Template bytes stay frozen.
**Warning signs:** queued emails pointing at `undefined/verify-email?...`.

### Pitfall 6: Hand-authored schema fails the 03-07 empty-diff gate
**What goes wrong:** the gate diffs `src/db/schema.ts` against a normalized `drizzle-kit pull` of a migrated DB; hand-formatting (quotes, ordering, default forms) breaks it; new tables also must extend `rehearse-migrations.mjs`'s pinned column inventory ("Phase 7 extends the list, not the pipeline" — 03-05).
**How to avoid:** author tables → `drizzle-kit generate` → migrate on the docker/test DB → `drizzle-kit pull` → reconcile formatting to pull output (the two sanctioned rewrites: `gen_random_uuid()` default form, `bool_ops`) → extend the rehearsal inventory with `account`/`session`/`verification` + `users.role`/boolean column.
**Warning signs:** `pnpm schema:gate` red after an innocent-looking table edit.

### Pitfall 7: Better Auth's init fails on missing plugin columns
**What goes wrong:** schema validation runs at initialization (including production — requests await the check and fail on mismatch) [CITED: docs/concepts/database.md]; the admin plugin's `banned`/`banReason`/`banExpires` (user) and `impersonatedBy` (session) columns must exist in the mapped tables even though D-13 never uses them.
**How to avoid:** include every plugin field in the hand-authored tables; rehearsal boots web AND worker (D-34), which exercises init.

### Pitfall 8: Worker :9090 loopback bind vs allowlisted-IP reachability
**What goes wrong:** the health server binds `127.0.0.1` only [VERIFIED: src/worker/health.ts:189] — "Bull Board reachable from an allowlisted IP" (D-31) is unsatisfiable as-is; naively binding 0.0.0.0 exposes healthz/readyz/metrics too.
**How to avoid (options for planner/operator):** (a) bind non-loopback and gate per path: health/metrics require loopback source, `/admin/queues` requires allowlist+session; or (b) keep loopback and standardize an SSH-tunnel convention (then "refused from a non-allowlisted IP" is tested with a spoofed/other source on the host). Option (a) matches D-17/D-31 literally; x-forwarded-for is absent on direct sockets, so gate on `req.socket.remoteAddress`.
**Warning signs:** rehearsal leg "Bull Board from allowlisted IP" impossible without a bind change.

### Pitfall 9: Rate limiter defaults don't match the parity policy
**What goes wrong:** built-in limiter defaults (window: the rate-limit page says 60 s, the options reference says 10 — a docs discrepancy; max 100; `/sign-in/email` sensitive default 3/10 s; storage default `memory`, which resets on every PM2 deploy) silently differ from today's register/forgot 5/h-per-IP [VERIFIED: src/app/api/auth/register/route.ts:30, src/app/api/auth/forgot-password/route.ts:24].
**How to avoid:** pin everything explicitly: `rateLimit: { enabled: true, window, max, storage: "secondary-storage", customRules: { "/sign-up/email": { window: 3600, max: 5 }, "/forget-password": { window: 3600, max: 5 } } }` (note Better Auth's spelling `/forget-password`), with `@better-auth/redis-storage` as secondaryStorage. D-24's pinned coverage list: register 5/h, forgot 5/h, **login has NO limit today** — the built-in sensitive-route default therefore *adds* a limit (an improvement consistent with "modernization = same guardrails, new engine"; call it out as a delta in the plan). Note server-side `auth.api` calls bypass the limiter (the worker's Bull Board check is unaffected).
**Warning signs:** limits resetting at each deploy (memory storage).

### Pitfall 10: Cookie name/prefix assumptions
**What goes wrong:** code/tests that assume `next-auth.session-token` break; Better Auth's default cookie is `better-auth.session_token` (with `__Secure-` prefix under HTTPS defaults).
**How to avoid:** proxy + worker gate + tests reference `getSessionCookie`/`getCookieCache` helpers or the configured names, never string literals; document the old cookies' death in the announcement copy implicitly (D-03 accepts the blip).

### Pitfall 11: rehearse-migrations.mjs is stale for this phase
**What goes wrong:** the script's evidence prose hard-codes the Phase-3 journal interpretation — `"(1 stamped baseline + 1 runner-applied 0001 — the runner applied 0001 exactly once)"` at [VERIFIED: scripts/rehearse-migrations.mjs:505] — which would be false evidence once the cutover migration adds rows; the 03-REVIEW WR-05 carry-forward explicitly requires fixing this BEFORE Phase 7 rehearsal reuse.
**How to avoid:** Wave/first-task fix: make the bookkeeping line count-agnostic (report N rows + expected range), and extend the digest carve-out inventory (Pattern 3's new tables/columns).

### Pitfall 12: Reset-flow "mirror today" isn't what today's code does
**What goes wrong:** D-22's parenthetical assumes a password-hash gate; the current routes have none — `forgot-password` issues tokens for ANY existing user, and `reset-password` resets any user *and silently sets `emailVerified`* [VERIFIED: src/app/api/auth/reset-password/route.ts:36-44] (the audit §6 itself calls the verified-flip "questionable"). Under Better Auth, `resetPassword` does not touch `emailVerified`, and resetting an OAuth-only account has no credential row to update.
**How to avoid:** the planner must translate "mirror today, 1:1" against the *pinned* behavior: (a) decide whether the D-22 hasPassword gate (clear OAuth message) is added as the parity-with-intent or omitted as parity-with-code; (b) accept that reset no longer flips `emailVerified` (a behavior delta vs today's code, aligned with D-22's "regardless of emailVerified status"). See Open Questions 2.

## Code Examples

Verified patterns from official sources are embedded in the Architecture Patterns above (Pattern 1 config — better-auth.com reference/options + concepts pages, fetched 2026-09-22; Pattern 2 — email-password password-config page; Pattern 6 — bull-board `examples/with-hono/index.js` verbatim API shape). Two additional client-side shapes:

### Client swap (D-33 plumbing-only)

```typescript
// src/lib/auth-client.ts — Source: better-auth.com/docs/integrations/next.md
import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient(); // basePath defaults to /api/auth

// LoginForm.tsx handler bodies (JSX/classes byte-identical per 07-UI-SPEC):
// credentials:
const { error } = await authClient.signIn.email({ email, password });
//   error.status 401 → toast.error("Invalid email or password.")
//   error.status 403 (EMAIL_NOT_VERIFIED) → map to today's surfaced string
//     "Please verify your email address before logging in." [VERIFIED: src/lib/auth.ts:48]
// social:
await authClient.signIn.social({ provider: "google", callbackURL: callbackUrl });
// sign-up (returns no session — autoSignIn:false):
await authClient.signUp.email({ email, password, name });
// reset flow:
await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
await authClient.resetPassword({ newPassword, token }); // token from ?token= as today
```

### Proxy swap (AUTH-04)

```typescript
// src/proxy.ts — Source: better-auth.com/docs/integrations/next.md (Next 16 "proxy" convention,
// Node runtime, full getSession validation; getCookieCache for the zero-DB path)
import { auth } from "@/lib/auth";            // or getCookieCache from "better-auth/cookies"
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers }); // cookieCache → no DB hit
  if (!session) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}
export const config = { matcher: ["/dashboard/:path*"] }; // matcher unchanged [VERIFIED: src/proxy.ts:23-26]
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| NextAuth v4 JWT strategy + duplicated Redux token mirror | Better Auth DB sessions + `cookieCache` + `authClient.useSession` as the single client source | This phase | Revocation becomes real (D-28 meaningful); proxy loses per-request DB hits |
| Custom token tables + custom register/verify/forgot/reset routes | Better Auth `verification` table + framework flows with queue-delegating hooks | This phase | Hashed token storage; enumeration-safe responses; `/forget-password` (engine spelling) |
| Drizzle adapter inside `better-auth/adapters/drizzle` | Docs now default to the split `@better-auth/drizzle-adapter` package | 1.7 line (package created 2026-01-21) | At the 1.7.5 pin BOTH work — core export path verified present; keep the project-skill import, revisit only on a future major bump |
| Bull Board Express-first examples | First-class adapters for hono/h3/elysia/bun at 9.x | bull-board 9.x line | Worker can avoid Express 5 entirely |
| In-memory Map rate limiting | Redis-backed (house Lua since Phase 3) / Better Auth `rateLimit` + `secondaryStorage` | This phase (D-24) | Limits survive restarts; consistent IP derivation |

**Deprecated/outdated:**
- `next-auth@^4.24.15`, `@auth/prisma-adapter`, Prisma 7 stack, `js-cookie` — all removed at the deletion release [VERIFIED: package.json:29-33,47,50,72,83].
- `reset-password`-sets-`emailVerified` behavior — dies with the custom route (Pitfall 12).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Lazy rehash (AUTH-09) has no first-class Better Auth API in 1.7; the verify()-closure side-effect UPDATE (Pattern 2) is the mechanism | Pattern 2; AUTH-09 | Rehash silently never fires (benign — hashes still verify; parity unaffected) or mis-fires (mitigated by hash-equality WHERE clause; unit-testable) |
| A2 | The worker validates Bull Board sessions via the shared `createAuth()` instance's `auth.api.getSession` (NOT by replicating Better Auth's session-token hashing for a direct table lookup — the stored token is hashed by a scheme we did not pin) | Pattern 5; OBS-04 | A wrong worker validation approach fails at the D-34 rehearsal leg (worker boots with Bull Board on the stand-in) — caught before production |
| A3 | `minPasswordLength: 6` parity pin is desired (engine default 8; today's register/reset enforce 6 and the UI contract freezes the 6-char message) | Pitfall 9 / Pattern 1 | If the operator prefers 8, new minimum diverges from the frozen UI copy — needs a one-line UI-spec amendment |
| A4 | Registration-with-existing-email under `requireEmailVerification` returns a synthetic 200 (enumeration protection) instead of today's 409 — surfaced strings need a D-33 mapping decision | Open Questions 4 | A missed mapping shows a success toast for a duplicate sign-up (confusing but harmless; no email sent to the existing address unless sendOnSignUp's existing-user path fires — verify at implementation) |
| A5 | `HonoAdapter`'s serveStatic functions correctly under the `getRequestListener` bridge inside the existing `node:http` server (the API shape is verbatim from bull-board's own hono example, but that example serves via `@hono/node-server`'s `serve()`) | Pattern 6 | Static UI assets 404 on :9090 — caught by the D-34 rehearsal Bull Board leg; fallback is routing through `serve()` with a shared port or the express adapter |
| A6 | better-auth 1.7.5 runs on the repo's Node line (>=22 <25): the package declares NO `engines` field (an absence — no compatibility claim either way), and its peer range covers next ^16/react ^19 | Standard Stack | Effectively none — peers + npm install probe at plan execution confirm |
| A7 | `@better-auth/redis-storage` exports a create-storage factory compatible with `secondaryStorage` (package purpose verified; exact export name not pinned this session) | Pitfall 9 | Build-time error immediately visible; docs page at implementation |

## Open Questions (RESOLVED)

> All six questions are substantively resolved in the Phase-7 plans; each carries its resolution marker below. Nothing is unresolved.

1. **Boolean `emailVerified` physical column name.** → **RESOLVED in 07-01**: the column is `email_verified` (snake_case boolean, NOT NULL DEFAULT false), added to `users` in cutover migration 0002; `user.fields` maps Better Auth's `emailVerified` → `"email_verified"` (07-01 Task 5), and the D-23 truthiness backfill lives in 0002. Name-agnostic consumers unaffected.
   - What we know: the timestamp column `emailVerified` cannot be reused; `user.fields` maps Better Auth's field to any column name; audit §12.1 pins the truthiness backfill.
   - What's unclear: the planner's column name (e.g. `email_verified_bool`) and whether to snake-case it (legacy table uses camelCase quoted identifiers).
   - Recommendation: pick a name in-plan; both `user.fields` and the drop/release story are name-agnostic.
2. **D-22 reset parity vs today's actual route behavior.** → **RESOLVED in 07-03**: mirror-the-intent — a hooks.before check on the engine's forget-password path returns the clear OAuth-only message ("This account signs in with Google or GitHub.") when the user has no credential-account password; reset succeeds regardless of verified status; reset no longer flips any verified timestamp (documented delta vs today's code, aligned with D-22 — 07-03 Task 1, rehearsed for copy sign-off per D-06).
   - What we know: today there is NO hasPassword gate and reset silently sets `emailVerified` [VERIFIED: src/app/api/auth/reset-password/route.ts:36-44]; D-22 says "requires a password hash to exist … reset succeeds regardless of emailVerified status; researcher pins the current route behavior first; zero new policy."
   - What's unclear: whether "mirror today" means mirror-the-code (no gate; verified-flip lost with the route) or mirror-the-intent (add the OAuth-only clear message via a `hooks.before` check on `/forget-password`).
   - Recommendation: raise at plan review as a one-line disposition; the hasPassword signal exists (`profile.hasPassword` at src/app/api/user/profile/route.ts:54) if the gate is wanted.
3. **Worker :9090 bind decision (Pitfall 8).** → **RESOLVED in 07-05**: per-path source gating on a non-loopback bind — healthz/readyz/metrics answer loopback-source sockets only while `/admin/queues` answers allowlisted sources (07-05 Task 3); the operator sets the host option at flip per runbook §4c and the configuration is proven first at the D-34 rehearsal (07-06).
   - What we know: loopback-only bind today (T-04-01); D-17/D-31 demand allowlisted-IP reachability.
   - Recommendation: per-path source gating on a non-loopback bind; operator confirms at the D-34 rehearsal.
4. **D-33 surfaced-string mapping for engine-native responses** (duplicate-email synthetic 200; `account_not_linked`; `EMAIL_NOT_VERIFIED`; INVALID_TOKEN redirect `?error=INVALID_TOKEN` on the reset page). → **RESOLVED in 07-04 + 07-03**: 401 → "Invalid email or password."; 403 EMAIL_NOT_VERIFIED → the exact legacy string "Please verify your email address before logging in."; provider-initiate / `account_not_linked` callback failure → the frozen "Failed to initiate sign in with ${provider}" toast; duplicate-email synthetic 200 → the existing success toast (enumeration protection, sanctioned A4 delta noted for the summary); INVALID_TOKEN lands on the EXISTING expired/error state (D-20 — no new copy, no new screen). Frozen list in 07-UI-SPEC Copywriting Contract.
   - Recommendation: planner drafts the mapping table in-plan against the 07-UI-SPEC frozen string list; note the UI-SPEC list does not yet contain the unverified-login string.
5. **Rate-limit mechanism final pick (D-24 discretion).** → **RESOLVED in 07-03**: Better Auth built-in rateLimiter + `@better-auth/redis-storage` secondaryStorage (Redis — limits survive deploys) + explicit `customRules` pinning register/forgot at 5/h per IP; sign-in gains the engine's sensitive-route default (D-24 improvement delta); the house Lua limiter remains for the non-auth routes.
   - Original recommendation (adopted): Better Auth built-in + `secondaryStorage` (Redis) + explicit `customRules` — one engine inside the auth surface; the house Lua limiter remains for the non-auth routes.
6. **Notice-window env names + exact blast-script knobs** → **RESOLVED in 07-04 + 07-02**: notice window envs `AUTH_NOTICE_START` / `AUTH_NOTICE_END` (07-04 Task 3, delete-after-use per D-05, gate-extended in 07-08); blast flip-date env `AUTH_FLIP_DATE` (07-02 Task 2); blast-script internals per planner discretion (Drizzle recipient enumeration, explicit target-stack requireEnv, per-batch progress, console-provider dry-run mode).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | ✓ | v24.15.0 (engines >=22 <25) | — |
| pnpm | installs/lockfile | ✓ | 10.34.5 (packageManager pin) | — |
| Docker + compose test stack | vitest/schema:gate/rehearsal legs | ✓ | Docker 29.8.0; PG :5453 / Redis :6390 | — |
| Postgres (Neon prod + snapshot) | cutover migration, rehearsal | ✓ (live system) | — | snapshot stand-in per D-34 |
| Redis | rate-limit secondaryStorage, email lane | ✓ (Phase-3-hardened) | — | memory storage would reset on deploys (rejected) |
| better-auth CLI (`npx auth@latest`) | NOT used — schema is hand-owned | n/a | @better-auth/cli 1.4.21 is a separate version line | hand-authored migration (chosen path) |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none — all probes green this session.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.11 (unit/integration/worker) + Playwright 1.63.0 (e2e) [VERIFIED: package.json:69,89] |
| Config file | vitest.config.ts (+ vitest.config.resilience.ts), playwright.config.ts, docker-compose.test.yml |
| Quick run command | `pnpm test` (vitest run; docker test stack up first) |
| Full suite command | `pnpm verify` (lint → typecheck → test → schema:gate → worker:boundary → denylist:diff → build → cron:remnants → test:e2e) [VERIFIED: package.json:22] |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01 | Hash-prefix routing: `$2a$/$2b$/$2y$` verify via bcrypt; unknown prefix refuses; hash() emits the pinned default | unit | `pnpm test -- tests/lib/auth-password.test.ts` | ❌ Wave 0 |
| AUTH-02 | Canary login through preserved hash path | integration (seeded canary on docker PG via sign-in endpoint) + manual-only at flip (snapshot → production canary per D-37/D-38, recorded in 07-DEPLOY-RECORD) | `pnpm test -- tests/integration/better-auth-cutover.test.ts` | ❌ Wave 0 |
| AUTH-03 | Cutover migration: ids preserved, boolean backfill counts match, credential rows = users-with-password, role seed + zero-match abort (D-09) | integration + rehearsal-scripted (rehearse-migrations.mjs, post-WR-05-fix) | `pnpm test -- tests/integration/cutover-migration.test.ts` + `pnpm rehearse:migrations` | ❌ Wave 0 (script exists, needs WR-05 fix + inventory extension) |
| AUTH-04 | cookieCache: proxy passes valid cookie w/o DB; redirects absent cookie to /login with callbackUrl | unit/integration (proxy handler + config assertion) | `pnpm test -- tests/lib/proxy-auth.test.ts` | ❌ Wave 0 (behavior today partially covered by e2e smoke) |
| AUTH-05 | Reshape preserves tokens: pre/post non-null refresh/access counts per provider (D-40) | rehearsal-scripted (operator evidence) + unit test of the reshape transform | `pnpm rehearse:migrations` (evidence block) | ❌ Wave 0 |
| AUTH-06 | Notice strip renders inside env window / `null` outside; blast enqueues N jobs via queue (console-provider dry-run at rehearsal per D-06) | e2e (strip) + unit (blast script fan-out, injectable queue) | `pnpm test:e2e` + `pnpm test -- tests/lib/relogin-blast.test.ts` | ❌ Wave 0 |
| AUTH-07 | No `next-auth`/`@auth/*`/custom-auth-route remnants after deletion | grep gate (extend `scripts/check-cron-remnants.mjs` pattern — 06-05 precedent) + `pnpm build` green | `pnpm cron:remnants` (extended gate) | ⚠️ gate exists; extension is deletion-release Wave 0 |
| AUTH-08 | No Redux auth slice / token mirror / js-cookie imports | grep gate (same extended gate) + typecheck red on leftover imports | `pnpm cron:remnants` + `pnpm typecheck` | ⚠️ same |
| AUTH-09 | Login with legacy hash upgrades `account.password` (prefix changes); second login verifies | unit (verify-closure + UPDATE) against docker PG | `pnpm test -- tests/lib/auth-password.test.ts` | ❌ Wave 0 (same file as AUTH-01) |
| DRZ-07 | Zero `@prisma/*` imports/deps; `prisma/` dir absent; build script clean; schema:gate still green | grep gate + `pnpm schema:gate` + `pnpm build` | `pnpm schema:gate` + `pnpm cron:remnants` (extended) | ⚠️ schema:gate exists; absence-gate is deletion-release |
| EML-04 | sign-up/reset enqueue `email-transactional` jobs with rendered bytes; no in-request transport | integration (injectable queue producer — 06-02 harness precedent) | `pnpm test -- tests/integration/auth-email-hooks.test.ts` | ❌ Wave 0 (`tests/lib/email-render.test.ts` exists for render parity — fixtures re-captured) |
| SEC-04 | feedback GET: admin 200 / non-admin 403 / anon 401; POST stays 200-for-all-authed | integration (handler harness — tests/api/_harness.ts precedent) | `pnpm test -- tests/api/feedback-admin.handler.test.ts` | ❌ Wave 0 |
| OBS-04 | Bull Board: allowlisted IP + admin cookie → 200; non-admin → 403; non-allowlisted IP → refusal; D-16 audit line emitted | integration (worker health-server test harness — tests/worker/health.test.ts precedent) | `pnpm test -- tests/worker/bull-board-gate.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test` (+ `pnpm typecheck`)
- **Per wave merge:** `pnpm verify`
- **Phase gate:** full `pnpm verify` green + the D-31 typed soak-gate checklist (canary credentials login, one Google + one GitHub login without re-consent — D-40's live assertion, verification + reset round-trips through the queue, admin yes / non-admin no on feedback GET, Bull Board allowed/refused matrix, notice strip, dead errors quiet) recorded in `07-DEPLOY-RECORD.md`.

### Wave 0 Gaps

- [ ] `tests/lib/auth-password.test.ts` — AUTH-01/AUTH-09 (prefix routing + lazy rehash)
- [ ] `tests/integration/better-auth-cutover.test.ts` — AUTH-02 (canary through the framework on docker PG)
- [ ] `tests/integration/cutover-migration.test.ts` — AUTH-03 (counts/abort semantics) + rehearse-migrations WR-05 fix
- [ ] `tests/lib/proxy-auth.test.ts` — AUTH-04
- [ ] `tests/lib/relogin-blast.test.ts` — AUTH-06 fan-out
- [ ] `tests/api/feedback-admin.handler.test.ts` — SEC-04
- [ ] `tests/worker/bull-board-gate.test.ts` — OBS-04 (extends tests/worker/health.test.ts harness)
- [ ] `tests/integration/auth-email-hooks.test.ts` — EML-04 (fixtures re-capture in tests/lib/email-render.test.ts)
- [ ] Extended remnant gate (AUTH-07/AUTH-08/DRZ-07) — ships with the deletion release's own plan per D-29

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1` (.planning/config.json).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Better Auth `emailAndPassword` + bcrypt-compatible hash/verify (A-1); OAuth via `socialProviders`; enumeration protection (synthetic responses, consistent messages) |
| V3 Session Management | yes | DB sessions, 30-day expiry + 1-day sliding renewal, 5-min `cookieCache` (bounded revocation lag), `revokeSessionsOnPasswordReset` (D-28), framework-managed cookie flags (secure/httpOnly/sameSite lax, `__Secure-` prefix in production) |
| V4 Access Control | yes | Admin plugin `role` primitive; `GET /api/feedback` admin-only (R17 fix); Bull Board behind IP allowlist + admin session (D-17/D-18); management endpoints deliberately unused (D-13) |
| V5 Input Validation | yes | Framework-side validation of auth payloads; existing hand validation + `apiError` on retained routes; never echo internals (FND-07 rule) |
| V6 Cryptography | yes | bcryptjs for password hashes; Better Auth HMAC-signed cookie cache + secret (≥32 chars, `openssl rand -base64 32`); no hand-rolled crypto anywhere |
| V7 (logging) | partial | D-16 structured admin-surface audit lines ride the existing pino request logging |
| V9/V12/V14 | no | No communications/TBE/file-upload surface changes in this phase |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Credential stuffing / brute force on `/sign-in/email` | Tampering/DoS | Built-in rateLimiter (sensitive-route default) + explicit customRules; Redis secondaryStorage so limits survive deploys |
| Email enumeration via register/forgot | Information Disclosure | Better Auth synthetic sign-up response + consistent messages; house forgot-password already returns 200 (kept shape) |
| Session theft → Bull Board abuse (retry/drain/delete jobs) | Elevation/DoS | Two independent gates (socket-source IP allowlist AND admin role); D-16 audit line per hit; D-19 accepts mutation powers by design |
| Spoofed `x-forwarded-for` to dodge IP gates | Spoofing | Allowlist keys on `req.socket.remoteAddress` (direct connection — no header); auth limiter's `trustedProxies`/`ipAddressHeaders` configured for the one reverse proxy; pairs with the WR-06 carry-forward |
| Same-email OAuth account takeover via silent linking | Elevation | `disableImplicitLinking: true` (D-26 pin) — matches NextAuth's `OAuthAccountNotLinked` refusal |
| Lockout of all credentials users (hash mismatch) | DoS (availability) | A-1 gate + canary ordering (D-37/D-38) + D-41 pre-committed redeploy |
| Legacy-token replay after cutover | Spoofing | D-20: old links dead; legacy tables read-only, never consulted; hashed `verification.value` makes copied tokens unusable anyway |
| Health/metrics exposure when :9090 rebinds | Information Disclosure | Per-path source gating (loopback-only for health/metrics; allowlist for `/admin/queues`) — planner/operator decision (Pitfall 8) |
| Secret drift (NEXTAUTH_SECRET vs BETTER_AUTH_SECRET) | Tampering | DEP-05 dated env paths; throw-early config convention (06 D-11) for missing `BETTER_AUTH_SECRET` in production |

## Sources

### Primary (HIGH confidence)

- npm registry (live `npm view`, 2026-09-22) — better-auth 1.7.5 + peerDependencies; @bull-board/{api,express,hono,ui}@9.10.1; hono 4.13.8; @hono/node-server 2.1.1; @better-auth/{drizzle-adapter,redis-storage}@1.7.5; express 5.2.1
- unpkg better-auth@1.7.5 package.json — exports map confirms `./adapters/drizzle` ships in the pinned version
- better-auth.com official docs (all `.md` pages fetched 2026-09-22): /docs/reference/options (exact defaults), /docs/concepts/database (core schema, credential providerId, generateId, modelName/fields, schema validation, secondary storage), /docs/adapters/drizzle (adapter + schema option), /docs/concepts/session-management (cookieCache, revocation lag, getCookieCache), /docs/concepts/email + /docs/authentication/email-password (hooks, TTLs, requireEmailVerification/autoSignIn/revokeSessionsOnPasswordReset/minPasswordLength), /docs/concepts/oauth + /docs/concepts/users-accounts (providerId casing, callback path, accountLinking/disableImplicitLinking), /docs/plugins/admin (role field set, adminRoles, userHasPermission, customSyntheticUser), /docs/concepts/rate-limit (defaults, customRules, storage, trustedProxies), /docs/integrations/next (toNextJsHandler, Next 16 proxy), /docs/guides/next-auth-migration-guide
- felixmosh/bull-board GitHub — `examples/with-hono/index.js` (verbatim HonoAdapter usage)
- In-repo (Read this session, cited inline): src/lib/auth.ts, src/proxy.ts, src/db/schema.ts, src/app/api/feedback/route.ts, src/app/api/auth/{register,forgot-password,reset-password,verify-email}/route.ts, src/lib/tokens.ts, src/lib/email/{render,enqueue}.ts, src/worker/health.ts, src/redux/features/auth/authSlice.ts, tests/setup/global-setup.ts, tests/api/auth-shallow.handler.test.ts, scripts/rehearse-migrations.mjs, package.json, .env.example, ecosystem.config.js

### Secondary (MEDIUM confidence)

- NextAuth v4 `OAuthAccountNotLinked` semantics — GitHub discussion + next-auth docs (web search, 2026-09-22), cross-checked against D-26's own statement
- gsd-tools package-legitimacy verdicts (registry signals: downloads, repo URLs, postinstall absence)

### Tertiary (LOW confidence)

- None — no claim in this document rests solely on an unverified web result.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version read live from npm this session; adapter export path proven from the published package
- Architecture (Better Auth mechanics/config): HIGH — every parity pin traced to an official docs page fetched today; the three inverted defaults are the load-bearing findings
- Cutover/rehearsal patterns: HIGH — inherited from audit §12/§21 + Phase 3/5 rehearsal machinery with two pinned in-repo deltas (WR-05 journal line, digest inventory)
- Pitfalls: MEDIUM-HIGH — all grounded in docs or in-repo reads; Pitfall 4's docs discrepancy and A1/A5 mechanics carry implementation-time verification
- Bull Board integration: MEDIUM — adapter API verbatim from the official example; the node:http delegation bridge (A5) is rehearsed per D-34 before production

**Research date:** 2026-09-22
**Valid until:** 2026-10-06 (14 days — fast-moving auth ecosystem; better-auth publishes weekly, re-verify the pin at plan execution)
