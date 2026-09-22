# Phase 7: Better Auth Cutover, Admin Gating & Prisma Removal - Context

**Gathered:** 2026-09-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Users authenticate through Better Auth against the **existing tables** without a single lockout; admin surfaces are gated by role; Prisma is fully removed. Concretely, Phase 7 delivers:

1. **The auth cutover** — Better Auth configured with a bcrypt-compatible hash/verify path (hash-prefix routing, A-1) bound to the existing `users` table; new Better Auth `account`/`session`/`verification` tables; OAuth rows reshaped from NextAuth `accounts` into Better Auth's `account` (dry-run-verified `providerId` casing, refresh tokens preserved); boolean `emailVerified` backfilled from the legacy timestamp; lazy rehash-on-login upgrades stored bcrypt hashes to the modern default. The migration is **purely additive** — legacy tables/columns untouched, which is what makes the redeploy-only rollback real (AUTH-01..05, AUTH-09).
2. **Forced re-login, announced** — one advance email blast to all registered users before the flip; a persistent env-dated notice strip on `/login` after it; sessions start empty (audit §12.6/Q-4, locked) (AUTH-06).
3. **Transactional email through the queue** — Better Auth's `sendVerificationEmail`/`sendResetPassword` hooks delegate to the existing render-at-enqueue email queue unchanged (06 D-07/D-08) (EML-04).
4. **Admin gating** — Better Auth admin plugin's role primitive; `ADMIN_EMAILS`-fed migration seeding; `GET /api/feedback` admin-only (fixes R17); Bull Board on the worker's :9090 under IP allowlist + admin session (SEC-04, OBS-04).
5. **Removal** — NextAuth deps/routes, Redux `auth` slice/token mirror/`js-cookie`, and the entire Prisma stack (`prisma/`, generated client, `@prisma/*` deps, adapter) deleted after the soak; legacy `sessions`/`verification_tokens`/`password_reset_tokens`/`accounts` tables read-only for one release, then dropped in an explicit drop release (AUTH-07, AUTH-08, DRZ-07).

**Not in scope:** admin UI pages (feedback viewer, ban/impersonate surfaces — deferred), the visual redesign (Phase 8), windowed-uptime compute (Phase 8), AI (Phase 8), cookieCache revocation-lag policy mechanics (research-routed per the roadmap flag), any new user-facing capability (no resend-verification affordance, no OAuth password-setting, no auto-linking, no session caps).

Requirements: AUTH-01..09, DRZ-07, EML-04, SEC-04, OBS-04.

</domain>

<decisions>
## Implementation Decisions

### Re-login announcement & UX (AUTH-06 / Q-4)

- **D-01: Advance blast to ALL registered users.** One announcement email to every registered account — including never-verified users — sent a few days before the flip ("heads-up + what changes"). No pre-flip in-app banner. Unauthenticated users simply land on `/login` at the flip.
- **D-02: Post-flip in-app notice = persistent strip on `/login`.** A notice strip ("Sign-in moved to a new system — sign in with your existing email and password") rendered for an env-dated window (`notice` start/end envs), non-dismissible, zero client state, self-cleaning when the window closes. This is the audit Q-4 "in-app" half.
- **D-03: Mid-session users at flip time accept the blip.** The deploy instantly invalidates JWTs; users get a 401 → the existing per-component redirect to `/login` (now showing the notice strip). No new "session expired" UX is built — the announcement email already explains why.
- **D-04: Blast mechanics = queue fan-out.** An operator-triggered script enqueues one `email-transactional` job per registered user (render-at-enqueue, same render/enqueue helpers as verification email — 06 D-07 lineage). SMTP throttling inherits queue concurrency; console provider dry-runs the blast locally first. No direct-SMTP bulk path, no out-of-band sending.
- **D-05: Blast script is delete-after-use.** Ships in the flip release, runs once on production, deleted in the deletion release; the D-41 remnant gate extends to keep both the script and the notice-window envs out afterwards.
- **D-06: Copy is drafted in-plan, approved at rehearsal.** Planner/executors draft the email + notice text (visible in plan review); the operator signs off at the deploy rehearsal by inspecting exact rendered bytes via the console provider.
- **D-07: Slip rule is a runbook line, not code.** If the flip slips more than ~48h past the announced date, re-run the blast script with updated copy; otherwise say nothing. (Decided via plain-text fallback after two UI timeouts — the user's choice is binding.)

### Admin bootstrapping, roles & Bull Board (SEC-04 / OBS-04)

- **D-08: First admin is minted by an env-fed migration step.** The cutover migration reads `ADMIN_EMAILS` (comma-separated), sets `role='admin'` for matching users. The snapshot rehearsal proves an admin AND a non-admin surface before any production flip. **Reversibility:** one-way — it creates the role column + admin grant inside the cutover migration; undoing it means another migration and re-planning the gating, so it is checkpointed before the task that implements it.
- **D-09: `ADMIN_EMAILS` missing/empty/zero-match ABORTS the migration** (throw-early convention, 06 D-11 lineage). Production can never flip with zero admins and a freshly-403 feedback API; the mistake is caught in rehearsal.
- **D-10: Roster = just the operator.** `ADMIN_EMAILS` holds exactly the operator's account email; gates are exercised with a real second (non-admin) account in tests.
- **D-11: Ongoing role changes = runbook SQL one-liner.** Parameterized grant/revoke UPDATE documented in the runbook with the "sign out/in to take effect" note. No operator script, no admin UI. Matches how the runbook already handles one-off ops (setWebhook, retention drills).
- **D-12: `ADMIN_EMAILS` stays in `.env.example` as the documented roster** (DEP-05 annotation form); it has no runtime role after the migration.
- **D-13: Admin-plugin scope = role primitive only.** The plugin is enabled for the role column and server-side role checks powering the gates. Its management endpoints (ban/unban, impersonate, user listing) stay unused — noted as deferred ideas — so an admin-session theft can't ban users or browse identities.
- **D-14: Admin-gating surface is exactly feedback-GET + Bull Board.** `GET /api/feedback` becomes admin-only (fixes R17 — today any authenticated user reads every user's name/email); feedback POST stays for all authenticated users; no other endpoint is swept.
- **D-15: Feedback consumption is API-only.** The operator reads feedback via a runbook-documented curl or SQL until a future UI exists. No admin page in this milestone.
- **D-16: Admin-surface access logs one structured line** (userId, route, IP, timestamp) into the existing request logging — a lightweight audit trail with zero new machinery.
- **D-17: IP allowlist reaches Bull Board ONLY.** `ADMIN_IP_ALLOWLIST` env (IPs/CIDRs) gates the queue UI; the feedback API stays reachable from any IP with a valid admin session (no lockout when checking from a phone/new network).
- **D-18: Bull Board mounts on the worker's existing port-9090 HTTP server** (beside healthz/readyz/metrics), gated in order — IP allowlist → Better Auth admin session (cookie validated from the request). The web process stays a pure Postgres reader — no BullMQ in the web bundle. **Reversibility:** costly — it puts a second authenticated surface on the worker's health port with env plumbing; moving it later means re-doing the auth validation and allowlist on a different host.
- **D-19: Bull Board keeps its mutation powers.** Retry/remove/drain stay enabled — the house "operator emergency lever" philosophy (05 D-03 kept the cron curl lever for exactly this). Session + allowlist are the controls; D-16's audit line records every hit.

### Pre-flip token & link fate (EML-04 / token flows)

- **D-20: Old links are dead on arrival.** Verification/reset links issued before the flip stop working (clear expired/error state). Legacy token tables stay read-only purely as a rollback window (audit §12.6) — never consulted by the new flow. No dual-source token code.
- **D-21: New link TTLs = Better Auth defaults.** Researcher confirms exact values against the installed version. Zero tuning surface; no explicit pinning.
- **D-22: Reset rules mirror today exactly.** Reset requires a password hash to exist — OAuth-only accounts get the clear "this account signs in with Google/GitHub" message; reset succeeds regardless of `emailVerified` status. Researcher pins the current route behavior first; zero new policy.
- **D-23: The email-verification login gate survives as-is.** Unverified credentials users still cannot log in until verified (now via Better Auth's `verification` table + queue-sent email). The boolean backfill maps each user's legacy timestamp: set → `true`, null/false → `false`. Nobody newly locked out, nobody newly admitted.
- **D-24: Rate limits = parity policy.** Every auth endpoint with a limit today keeps an equivalent limit after cutover (register, forgot-password ~5/h per IP per 06 D-21; login whatever it has today — researcher pins the current coverage list). The mechanism — Better Auth's built-in rateLimiter vs the house Redis Lua limiter — is researcher/planner territory. Modernization = same guardrails, new engine.
- **D-25: No session on sign-up until verified.** Registration must NOT mint a usable session (Better Auth's default would) — new users cannot use the app until they click the verification link, exactly today's effective behavior. Pure parity.
- **D-26: OAuth cross-provider linking mirrors today.** Researcher pins NextAuth v4's effective behavior (same-email different-provider login → account-not-linked error, linking not automatic) and the cutover reproduces it under Better Auth. No auto-linking of same-email identities.
- **D-27: Legacy table data drops with the tables.** When the read-only window closes, `sessions`/`verification_tokens`/`password_reset_tokens` (and the already-reshaped `accounts` data) are dropped WITH their data — expired tokens are worthless; the one-release window was the protection. No export/archive step.
- **D-28: Password reset revokes other sessions — the one deliberate security improvement.** Better Auth's native revoke-on-password-change replaces today's behavior (JWTs never re-checked, so sessions survived a reset). Strictly safer; near-invisible to honest users (one extra sign-in on the other device). Flagged here as the phase's single intentional behavior delta in the session domain.

### Release structure, rollback & Prisma exit (AUTH-07 / DRZ-07)

- **D-29: Flip → soak → deletion, textbook expand/contract.** Release 1 (flip): Better Auth live, Prisma/NextAuth still installed but serving nothing. Soak on real logins. Release 2 (deletion): NextAuth deps+routes, Redux `auth` slice, token mirror, `js-cookie`, Prisma directory/deps/adapter all removed; D-41 gate extended. The dead-but-present old stack IS the rollback.
- **D-30: Rollback lever = redeploy-only (no DB restore).** The cutover migration is purely additive (new tables + role column + boolean column + reshaped copies), so rollback = redeploy the previous release tarball and NextAuth works again against its intact tables. Pre-committed abort rule (05 D-06 lineage). Rows written during a rolled-back Better-Auth window need a reconciliation note in the deploy record.
- **D-31: Soak = ~24h + a typed gate checklist** before the deletion release (06 D-31 duration + 05 D-14 one-command evaluation): canary credentials login (old password), one real Google + one GitHub login, verification + reset round-trips through the queue, admin gates proven (admin yes / non-admin no on feedback GET; Bull Board reachable from an allowlisted IP and refused from a non-allowlisted one), notice strip rendering, dead errors quiet. Evidence writes into `07-DEPLOY-RECORD.md`.
- **D-32: Legacy tables drop in an explicit drop release.** The phase ends with code removal done and legacy tables read-only; the physical DROP is a tiny follow-up release (additive-inverse migration) after its own short soak — inside or right at the phase's close, explicit in the plan. AUTH-07's "one release, then dropped" is satisfied literally.
- **D-33: Auth pages = same pixels, new plumbing.** Login/register/forgot/reset/verify pages keep exact current visuals; only the client swaps (NextAuth → `authClient`), with error-message parity where the UI surfaces it. Visual redesign is Phase 8's.

### Rehearsal & canary (AUTH-02 / AUTH-05)

- **D-34: Full flip rehearsal on the refreshed snapshot.** Regenerate the anonymized snapshot from current production first (the Phase-5-era one is stale), then run the full cutover on the stand-in: migration + `ADMIN_EMAILS` seeding + boolean backfill, web AND worker booted (Bull Board's :9090 auth/allowlist exercised, not first-on-production), canary login, admin vs non-admin gate checks, verification/reset round-trips on the console provider, notice strip. Phase 6 skipped rehearsal because it had zero migrations; Phase 7 has the milestone's biggest one.
- **D-35: The redeploy rollback is DRILLED, not argued.** The rehearsal ends with: flip stand-in → verify Better Auth → redeploy PREVIOUS artifact → verify NextAuth still works against untouched tables → re-flip. Turns "rollback = redeploy-only" from an additive-migration assumption into evidence (05 D-15 precedent adapted to the redeploy lever).
- **D-36: One operator approval gate sits soak-green → deletion release** (05 D-18 pattern, verbatim record in `07-DEPLOY-RECORD.md`). The flip itself is covered by the rehearsal + production canary gate; the drop release inherits the deletion release's approval after its own short soak. No approval before the flip (it would just push the announced date), none after.
- **D-37: Snapshot canary = one designated real-email account.** The anonymization pipeline designates ONE account that keeps/receives the operator's real email and a known bcrypt hash (rehearse-time password); every other row stays anonymized. This simultaneously satisfies the D-09 zero-match abort rule on the snapshot, proves the preserved-hash path, and gives the admin-gate tests their subject.
- **D-38: Production canary = the operator.** Immediately after the flip deploy, the operator logs in with the old password (preserved hash path on real data), then completes one Google and one GitHub login (reshaped providerId mapping on real rows) before the soak clock starts.
- **D-39: The operator account holds all three login types BEFORE flip night.** If the Google or GitHub link is missing, it's connected pre-flip so the canary exercises real reshaped rows for both providers; the researcher's reshaping dry-run verifies row counts against the snapshot.
- **D-40: Refresh-token preservation is proven from two angles** (AUTH-05). Snapshot: pre/post-reshaping row-count comparison of non-null refresh/access tokens per provider (researcher-scripted, in the rehearsal evidence). Production: the canary's post-flip OAuth logins must complete WITHOUT a re-consent screen (live refresh tokens survived).
- **D-41: Canary-red = immediate redeploy, pre-committed.** Any canary failure (credentials, either OAuth, or an admin gate) → redeploy the previous release; no debugging on production, no partial states. Post-mortem happens on the snapshot. The D-07 slip rule covers re-announcement.

### Session lifetime

- **D-42: 30-day session expiry, parity with today's JWTs.** Users' felt experience is unchanged. (cookieCache's short TTL on top is research-routed and explicitly NOT decided here.)
- **D-43: Sliding renewal via engine defaults.** Active use extends the session up to the 30-day cap; researcher confirms exact values against the installed version. No hard wall.
- **D-44: Concurrent sessions unlimited, parity.** No device-count cap; session rows expire naturally at 30 days. DB cost trivial at this user scale.

### Claude's Discretion

- Exact announcement email + notice-strip copy (drafted in-plan per D-06, operator-approved at rehearsal).
- Rate-limit mechanism selection (Better Auth built-in vs house Lua limiter) and the current login-coverage pin (D-24).
- Exact cookieCache TTL and revocation-lag policy (explicitly research-routed by the roadmap; the only user-visible anchor locked here is the 30-day outer expiry).
- Better Auth base-path mapping (expected to keep `/api/auth/*` shape so client call sites and runbook URLs stay stable — researcher verifies).
- Deploy-record structure for 07 (inherits the 03-08/04/05 disposition-register pattern).
- Worker restart choreography within the flip/deletion releases (runbook §4 ordering; worker restart required because :9090 gains Bull Board).
- Blast-script internals (recipient enumeration via Drizzle, env for the flip date in copy, batch/concurrency parameters).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Authoritative architecture & requirements
- `docs/ARCHITECTURE-AUDIT.md` — §7 (A-1/A-2 addenda: bcrypt gate-not-spike, cookieCache), §12.1 (Better Auth table mapping), §12.4 (admin plugin, feedback admin-only, Bull Board + allowlist), §12.6 (forced re-login DECIDED; legacy tables read-only one release), §21 (table reshaping plan; D-41 drop timing)
- `docs/ARCHITECTURE-REVIEW.md` — verdict READY (2026-09-09); §9 pre-implementation checklist items 6/14-18 (A-1/A-2/A-3 constraints) now resolved by this discussion
- `.planning/REQUIREMENTS.md` — AUTH-01..09, DRZ-07, EML-04, SEC-04, OBS-04 requirement texts + the R17 leak row
- `.planning/ROADMAP.md` §"Phase 7" — goal, 5 success criteria, research flag (`--research-phase` depth: providerId casing, token-flow cutover, cookieCache revocation lag)
- `.planning/research/SUMMARY.md` — source of the Phase-7 research flags

### Prior phase decisions (locked — do not re-litigate)
- `.planning/phases/06-thin-api-routes-email-abstraction/06-CONTEXT.md` — D-07 render-at-enqueue (EML-04 hooks reuse the queue unchanged), D-08 both send sites, D-11 throw-early provider selection, D-21 forgot-password limiter coverage, D-29 Redis-down 503, D-31 24h soak precedent, D-26 feature→deletion release structure
- `.planning/phases/05-worker-cutover-operational-hardening/05-CONTEXT.md` — D-06 pre-committed abort rule, D-14 typed gate command + deploy-record evidence, D-15 rollback rehearsal precedent, D-18 operator approval gate placement, D-07 expand/contract release structure
- `.planning/phases/03-redis-drizzle-schema-ownership/03-CONTEXT.md` — rehearsal digest pattern ("Phase 7 extends the list, not the pipeline"), Drizzle schema ownership, migration rehearsal pipeline

### Codebase anchors (from scout)
- `src/lib/auth.ts` — current NextAuth config (JWT strategy, PrismaAdapter, credentials bcrypt compare, emailVerified gate in `authorize`) — the behavior contract to mirror
- `src/proxy.ts` — `/dashboard/:path*` matcher + `getToken` guard → swaps to Better Auth cookie validation, same matcher
- `src/app/api/feedback/route.ts` — GET currently unauthenticated-user-readable (R17); POST stays for all users
- `src/db/schema.ts` — `users` (timestamp `emailVerified`, no role), `accounts` (NextAuth shape incl. `refresh_token`), `sessions`, `verificationTokens`, `passwordResetTokens` — the tables the cutover migration touches
- `src/lib/email/` — the Phase-6 queue-side module (render.ts/enqueue.ts/providers) the Better Auth hooks delegate into
- `src/redux/features/auth/authSlice.ts`, `js-cookie` — the client state to delete at the deletion release (AUTH-08)
- `package.json` build script (`prisma generate &&` prefix) and `@prisma/*`/`next-auth`/`@auth/prisma-adapter` deps — the deletion-release removal list

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/email/` (06-02): provider interface + render + enqueue — Better Auth's `sendVerificationEmail`/`sendResetPassword` hooks call the existing enqueue helper; the announcement blast (D-04) reuses the same helpers via an operator script.
- Redis Lua limiter (03): the parity policy's candidate mechanism for auth endpoints.
- Typed gate-command pattern (05 D-14): the 24h soak's PASS/FAIL evaluation inherits it.
- Anonymized-snapshot pipeline + stand-in topology (04/05): the full-flip rehearsal's substrate; needs regeneration + canary designation (D-34/D-37).
- Worker :9090 health server (04): Bull Board's mount host — already has metrics/health endpoints and proven boot wiring.

### Established Patterns
- Expand/contract releases with a deletion release and an extended D-41 remnant gate (05/06) — Phase 7 repeats it with three steps: flip, deletion, drop.
- Throw-early config convention (06 D-11) — applied to `ADMIN_EMAILS` (D-09) and expected for `BETTER_AUTH_*` envs.
- "Zero new policy in a modernization phase" — the discussion answered every behavior edge with parity (D-22/23/24/25/26/42/43/44), with exactly two deliberate deltas: revoke-on-reset (D-28) and the admin gate itself (D-14).
- Rehearse-then-approve (05 D-18, 06 operator approval) — one approval gate sits between soak-green and deletion (D-36).

### Integration Points
- Better Auth instance in the web app: `src/lib/auth.ts` replacement; `src/app/api/auth/[...nextauth]/route.ts` is replaced by Better Auth's catch-all handler at the same `/api/auth` path.
- Better Auth instance in the worker: :9090 Bull Board's session validation constructs the same auth server object (worker has Drizzle access).
- `emailVerified` boolean: cutover migration backfills from the legacy timestamp; `authorize`'s gate moves into Better Auth's emailVerified handling.
- Redux `auth` slice / `js-cookie`: deletion release removes them; `AuthProvider` (NextAuth SessionProvider) swaps to Better Auth's client provider in the flip release.
- Env map (DEP-05): `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` + notice-window + `ADMIN_EMAILS` + `ADMIN_IP_ALLOWLIST` added at the flip release; `NEXTAUTH_URL`/`NEXTAUTH_SECRET` retired at the deletion release.

</code_context>

<specifics>
## Specific Ideas

- The announcement notice strip's env-dated window must be trivially removable with the deletion release (D-02/D-05) — the gate extension should catch both the script and the envs.
- The D-28 revoke-on-reset delta must be called out in the plan as the phase's ONE intentional session-behavior change so review doesn't mistake it for drift.
- The snapshot canary account (D-37) is the load-bearing trick that reconciles the anonymizer with the D-09 zero-match abort — the plan must sequence anonymizer changes before the migration rehearsal.
- Production canary OAuth logins are asserted by absence of the re-consent screen (D-40) — bake that assertion into the soak checklist verbatim.

</specifics>

<deferred>
## Deferred Ideas

- Admin feedback viewer UI (list + status update page) — new user-facing surface; Phase 8 redesign territory (per D-15).
- Better Auth admin-plugin management endpoints (ban/unban, impersonate, user listing) — new capability beyond this phase; revisit only with a real need (per D-13).
- Resend-verification affordance for unverified users — new UX; candidate for Phase 8 (per the token-area "mirror today" decision).
- Password-setting for OAuth-only accounts — account-linking policy change with takeover surface; explicitly out (per D-22).
- Same-email OAuth auto-linking — deliberate non-goal this phase (per D-26).
- Session-count caps / "sign out everywhere" affordance — no current need (per D-44).

</deferred>

---

*Phase: 7-Better Auth Cutover, Admin Gating & Prisma Removal*
*Context gathered: 2026-09-21*
