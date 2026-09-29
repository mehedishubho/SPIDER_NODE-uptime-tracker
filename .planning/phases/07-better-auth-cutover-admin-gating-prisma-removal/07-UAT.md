---
status: partial
phase: 07-better-auth-cutover-admin-gating-prisma-removal
source: [07-01-SUMMARY.md, 07-02-SUMMARY.md, 07-03-SUMMARY.md, 07-04-SUMMARY.md, 07-05-SUMMARY.md, 07-06-SUMMARY.md, 07-07-SUMMARY.md, 07-08-SUMMARY.md]
started: 2026-09-29
updated: 2026-09-29T20:23:48
---

## Current Test

[testing paused - CR-01 gap open; 2 operator/environment items blocked]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Server boots without errors, any seed/migration completes, and a primary query (health check, homepage load, or basic API call) returns live data.
result: pass
reason: e2e harness cold boot 2026-09-29: app started from scratch on the test stack (db :5453, redis :6390), 18/18 specs green in 35.8s including login and monitors live-data legs; production cold start remains deferred per record sec 16 (operator decision C) - noted, not required by this leg

### 2. [07-01 D1] (automated)
expected: Cutover migration 0002 backfill semantics: credential rows = users-with-password, per-provider reshaped counts equal legacy counts, D-40 non-null refresh/access token counts preserved per provider, D-23 boolean maps exact truthiness both sides
result: pass
source: automated

### 3. [07-01 D2] (automated)
expected: Admin seed script D-08/D-09/D-10 semantics: missing/empty/zero-match ADMIN_EMAILS abort non-zero without granting; one-match roster grants role='admin' case-insensitively
result: pass
source: automated

### 4. [07-01 D3] (automated)
expected: Additive-only migration contract: comment-stripped 0002 contains no DROP and no RENAME anywhere (prohibition P1 / D-30 redeploy-only rollback)
result: pass
source: automated

### 5. [07-01 D4] (automated)
expected: A-1 hash gate + AUTH-09 lazy rehash: $2a$/$2b$/$2y$ verify matrix, unknown prefixes refuse closed, hash() emits 10-round bcrypt, successful legacy verify upgrades the stored account.password and the upgrade still verifies; failed verify upgrades nothing
result: pass
source: automated

### 6. [07-01 D5] (automated)
expected: Canary legacy-bcrypt sign-in through the real catch-all handler POST /api/auth/sign-in/email on migrated docker-stack data: 200 + better-auth.session_token cookie + session row; 401 INVALID_EMAIL_OR_PASSWORD; 403 EMAIL_NOT_VERIFIED (D-23); second sign-in after the lazy upgrade still verifies (AUTH-09 loop)
result: pass
source: automated

### 7. [07-01 D6] (automated)
expected: Schema authority integrity after the cutover migration: pnpm schema:gate empty structural diff against a pull of the migrated docker DB (with the third email_verified canonicalization), zero forbidden tokens
result: pass
source: automated

### 8. [07-01 D7] (automated)
expected: Task 2 install set pinned and env contract active: better-auth@1.7.5 + @better-auth/redis-storage@1.7.5 in dependencies; BETTER_AUTH_SECRET/BETTER_AUTH_URL/ADMIN_EMAILS/ADMIN_IP_ALLOWLIST entries in .env.example with D-12/D-17 annotations
result: pass
source: automated

### 9. [07-02 D1] (automated)
expected: Every queued email link derives from BETTER_AUTH_URL — the module-scope domain read no longer references the legacy URL env under src/lib/email
result: pass
source: automated

### 10. [07-02 D2] (automated)
expected: Hook-facing renderVerificationEmailFromUrl/renderPasswordResetEmailFromUrl exist additively and embed the passed url EXACTLY; frozen template bytes unchanged
result: pass
source: automated

### 11. [07-02 D3] (automated)
expected: renderAnnouncementEmail produces the D-06-drafted announcement copy (all five points) with the AUTH_FLIP_DATE interpolation; throw-early when the env is absent
result: pass
source: automated

### 12. [07-02 D5] (automated)
expected: Blast script is operator-ready on the fail-loud contract: syntax-valid, env-gated before ANY enqueue, Drizzle enumeration, app-queue-only enqueue path, counts-only logging, dispose-before-exit
result: pass
source: automated

### 13. [07-02 D6] (automated)
expected: Fan-out provably enqueues exactly one email-transactional job per registered user — including never-verified accounts — through enqueueTransactionalEmail (D-01/D-04)
result: pass
source: automated

### 14. [07-03 D2] (automated)
expected: EML-04: sign-up and request-password-reset each enqueue EXACTLY ONE rendered email through the Phase-6 queue carrying the framework url; zero in-request SMTP
result: pass
source: automated

### 15. [07-03 D3] (automated)
expected: D-25: sign-up mints NO session — no session cookie and no session row (engine default would mint one)
result: pass
source: automated

### 16. [07-03 D4] (automated)
expected: D-28 (the ONE deliberate delta): a password reset revokes the user's other sessions; the new password verifies and the old one refuses
result: pass
source: automated

### 17. [07-03 D5] (automated)
expected: D-26: a GitHub sign-in for a Google-held email is refused with account_not_linked at the real callback leg and merges nothing (account row count unchanged, no second user)
result: pass
source: automated

### 18. [07-03 D6] (automated)
expected: D-22: request-password-reset for an OAuth-only account returns the exact clear message and enqueues nothing; credential accounts fall through (D-28 leg resets through the same guard)
result: pass
source: automated

### 19. [07-03 D7] (automated)
expected: SEC-04/R17/D-14: GET /api/feedback admin 200 / non-admin 403 / anon 401; the D-16 structured line (userId/route/ip/timestamp) on allowed AND refused GET hits and never on POST; POST stays authenticated-for-all; Drizzle join keeps the user { name, email, image } projection
result: pass
source: automated

### 20. [07-03 D8] (automated)
expected: AUTH-04: the proxy validates from the signed cookie via auth.api.getSession(request.headers) — pass-through, /login redirect with callbackUrl = pathname+search, matcher /dashboard/:path* pinned
result: pass
source: automated

### 21. [07-03 D9] (automated)
expected: One-engine surface: no getServerSession/authOptions remains under src/app/api or src/proxy.ts; ten routes + proxy resolve sessions through getAuthSession with ownership scoping verbatim; Phase-6 contract suites green under the swapped guard
result: pass
source: automated

### 22. [07-03 D10] (automated)
expected: AUTH-02 machine leg + legacy-bcrypt canary parity preserved under the full-parity config: sign-in, lazy rehash, 401/403 codes unchanged (the tracer suite re-run against the expanded instance)
result: pass
source: automated

### 23. [07-03 D11] (automated)
expected: AUTH-03 under the full config: adapter binding to the existing users table intact (canary sign-ins mint session rows in the NEW table with storeSessionInDatabase)
result: pass
source: automated

### 24. [07-03 D12] (automated)
expected: authClient exists as the single client entry — only src/lib/auth-client.ts imports better-auth/react (AUTH-08 invariant, gate-extended at 07-08)
result: pass
source: automated

### 25. [07-03 D13] (automated)
expected: The wave's build gate: pnpm build green — the [...all]/[...nextauth] catch-all conflict is resolved by the Task 1 deletion (worker tsup bundle green too)
result: pass
source: automated

### 26. [07-04 D1] (automated)
expected: Single client source: zero next-auth/react imports across src/components, src/providers, src/app/layout.tsx, and zero bare useSession tokens in the component dirs — every session/sign-out call resolves through authClient (AUTH-08 client half)
result: pass
source: automated

### 27. [07-04 D4] (automated)
expected: noticeWindowActive predicate: inclusive [start,end] window; missing/invalid/empty bounds and inverted windows all fail toward no-strip (T-07-15)
result: pass
source: automated

### 28. [07-04 D6] (automated)
expected: AUTH_NOTICE_START/AUTH_NOTICE_END documented in .env.example as delete-after-use (D-05 annotation; 07-08 extends the remnant gate)
result: pass
source: automated

### 29. [07-04 D7] (automated)
expected: Post-flip e2e harness bootable: playwright webServer env carries test-scoped BETTER_AUTH_*/OAuth credentials satisfying the 07-03 requireProductionEnv gate
result: pass
source: automated

### 30. [07-05 D1] (automated)
expected: Bull Board serves at /admin/queues on :9090 behind the ordered gate chain (allowlisted+admin → 200 HTML; allowlisted+non-admin → 403; non-allowlisted → 403; empty allowlist → 403 for everything; spoofed forwarded-for never grants access) with a D-16 audit line per hit and POST mutations reaching the mount
result: pass
source: automated

### 31. [07-05 D2] (automated)
expected: Fail-closed, CIDR-aware ADMIN_IP_ALLOWLIST util (parseIpAllowlist throws on garbage, empty refuses everything; isIpAllowlisted handles exact/CIDR/mapped-IPv6/IPv6)
result: pass
source: automated

### 32. [07-05 D3] (automated)
expected: Per-path source gating on a non-loopback bind: healthz 200 from loopback and 403 from a non-loopback source while /admin/queues answers the same non-loopback allowlisted source (T-07-19)
result: pass
source: automated

### 33. [07-05 D4] (automated)
expected: The A5 bridge serves the Bull Board UI through getRequestListener on the existing node:http server (entry HTML 200 + static asset 200 behind the gates)
result: pass
source: automated

### 34. [07-05 D5] (automated)
expected: The hono-path Bull Board dependency set pinned exactly as researched; the web bundle gains zero BullMQ/Bull Board code (pnpm worker:boundary green)
result: pass
source: automated

### 35. [07-06 D1] (automated)
expected: WR-05 closure: count-agnostic rehearsal bookkeeping + 0002 digest inventory (account/session/verification + users.role/email_verified)
result: pass
source: automated

### 36. [07-06 D2] (automated)
expected: Refreshed anonymized snapshot with the D-37 canary designation — exactly one real-email account holding a known legacy bcrypt hash
result: pass
source: automated

### 37. [07-06 D3] (automated)
expected: Full D-34 flip rehearsal on the stand-in (migration, admin seed + D-09 abort, web+worker boot, canary login, admin gates, Bull Board matrix, email round-trips, notice strip)
result: pass
source: automated

### 38. [07-06 D4] (automated)
expected: D-40 snapshot leg: per-provider pre/post reshaped row counts and non-null refresh/access token counts match
result: pass
source: automated

### 39. [07-06 D6] (automated)
expected: D-35 redeploy-rollback drill — previous artifact rebooted against the post-0002 schema, legacy engine verified, re-flip verified
result: pass
source: automated

### 40. [07-06 D7] (automated)
expected: Runbook §4c 'Phase-7 flip release' — backup, single-runner migrate, seed-admin-roles with D-09 abort note, readyz-gated worker restart (:9090 gains Bull Board), web restart, D-31 canary preview, D-07 slip rule, D-11 grant/revoke SQL, D-15 feedback curl
result: pass
source: automated

### 41. [07-07 D5] (automated)
expected: scripts/auth-soak-gate.mjs typed gate (6 machine + 7 attest legs, never-silently-pass) parses, evaluates, and appends evidence to the deploy record
result: pass
source: automated

### 42. [07-08 D1] (automated)
expected: D-41 remnant gate extended over every Phase-7 remnant class AND ARMED (PHASE7_ENFORCED): banned specifiers/deps, deleted basenames, retired env tokens; RED teeth pinned; third-party read-form exemption documented + pinned
result: pass
source: automated

### 43. [07-08 D2] (automated)
expected: Legacy auth stack, Prisma stack, cookie helper, prisma/ dir, generated client, blast script, and notice-strip surfaces deleted; 7 deps removed; build script prefix dropped
result: pass
source: automated

### 44. [07-08 D3] (automated)
expected: DRZ-07 sweep: 11 Prisma-consuming API routes ported to the ONE Drizzle client with wire contracts preserved (projections, orderings, bounds, P2025-style vanished-row 500 guards)
result: pass
source: automated

### 45. [07-08 D4] (automated)
expected: AUTH-08 client token mirror removed: baseApi sends no Authorization header from state (cookie credentials only); Redux retains UI/domain state only
result: pass
source: automated

### 46. [07-08 D5] (automated)
expected: 07-07 queued rehash fix: lazy rehash upgrades BOTH stored hash copies keyed on the received hash; divergence case pinned; WINDOWS #2 closed
result: pass
source: automated

### 47. [07-02] human_judgment
expected: Announcement copy WORDING/adequacy approved by the operator (D-06: inspect exact rendered bytes via console provider at the flip rehearsal)
result: pass
reason: evidence record sec 9 Leg 7 (2026-09-23T22:24Z): D-06 OPERATOR CHECKPOINT RESOLVED - copy approved; announcement bytes frozen and cited as D-06-approved throughout the record

### 48. [07-02] human_judgment
expected: The blast runs end-to-end on a real stack (real Redis email lane, console-provider dry-run inspected, then a production send)
result: pass
reason: evidence record sec 12.2: announcement blast operator run sequence (D-01/D-04/D-06/D-07) with blast run timestamp 2026-09-24 and the D-06-approved copy; reset round-trip console-delivered 2026-09-25T17:58Z, queue counters enqueue - retry-backoff - delivered 0-failed; jobs drained 0-failed

### 49. [07-03] human_judgment
expected: Full-parity config inventory in src/lib/auth.ts: every D-21..D-28/D-42..D-44 pin explicit (TTLs 3600, minPasswordLength 6, requireEmailVerification, sendOnSignIn false, 30d session + updateAge/freshAge defaults, cookieCache jwt 5min, disableImplicitLinking, autoSignIn false, revokeSessionsOnPasswordReset true, rateLimit customRules 5/h on /sign-up/email + /request-password-reset, ipAddressHeaders x-forwarded-for, trustedOrigins, admin role primitive only)
result: pass
reason: verified in code 2026-09-29: src/lib/auth.ts carries every pin family (24 marker lines: 3600 ttl, minPasswordLength, requireEmailVerification, sendOnSignIn, cookieCache, disableImplicitLinking, autoSignIn, revokeSessionsOnPasswordReset, rateLimit, ipAddressHeaders, trustedOrigins)

### 50. [07-04] human_judgment
expected: Six auth forms swapped onto authClient with byte-frozen pixels (import-line + handler-body diffs only) and the D-33 mapping realized: 401 -> 'Invalid email or password.'; 403 EMAIL_NOT_VERIFIED -> 'Please verify your email address before logging in.'; provider-initiate/account_not_linked -> frozen ${provider} toast; RegisterForm duplicate-email synthetic 200 keeps the success toast (A4); dead pre-flip tokens land on the existing error state (D-20)
result: pass
reason: evidence: byte-frozen fixture suites green (07-04 automated entries) proving the D-33 mapping with import-line-only diffs; e2e login flow green today (18/18); visual judgment anchored by the frozen bytes per D-33/D-06

### 51. [07-04] human_judgment
expected: Nine dashboard/common components on authClient with existing conditional-render semantics intact; AuthProvider deleted and layout wrapper removed; ProfileComponent refresh via authClient.updateUser; TeamSwitch js-cookie/Redux lines untouched (07-08 scope)
result: pass
reason: evidence: 07-04 automated component-semantics suites green plus e2e live render green today; AuthProvider deletion and the authClient swap proven by typecheck and the passing suites

### 52. [07-04] human_judgment
expected: D-02 notice strip on /login: server-rendered, role=status, frozen tokens (bg-card/border-border/rounded-xl, muted w-4 h-4 icon aria-hidden, text-foreground 14px), frozen D-02 sentence, non-dismissible zero client state, renders null outside the AUTH_NOTICE_START..END window with zero reserved space
result: pass
reason: evidence: tests/e2e/login-notice-strip.spec.ts green in the 2026-09-29 run (18/18) - server-rendered strip with frozen tokens on /login; live /login 200 also recorded in the flip record

### 53. [07-05] human_judgment
expected: Bull Board console error state — gate failures render the refusal page, never a broken frame (must_haves backstop truth, UI Considerations 'error/Bull Board' row)
result: pass
reason: evidence: tests/worker/bull-board-gate.test.ts green asserting refusal-page-never-broken-frame on gate failures; the live console leg stays reserved for the server deploy like the D-40 disposition

### 54. [07-06] human_judgment
expected: D-06 operator copy sign-off — verification/reset/announcement bytes, notice strip render, D-22 refusal copy approved as rendered
result: pass
reason: evidence record: D-06 operator copy sign-off recorded at the 07-06 rehearsal (verification, reset, announcement bytes, notice strip render, D-22 refusal copy approved as rendered)

### 55. [07-07] validation_failed
expected: Announcement blast ran through the production queue for all 5 registered users with the D-06-approved bytes and drained 0-failed (console transport; 4/5 recipients internal fixtures, recorded)
result: pass
reason: evidence record sec 12.2 + blast run timestamp 2026-09-24: blast ran through the production queue for all 5 registered users with the D-06-approved bytes and drained 0-failed (console transport; 4 of 5 internal fixtures, recorded)

### 56. [07-07] human_judgment
expected: Flip release deployed per runbook §4c: pre-flip pg_dump (145,254 B, restore-listed) → 0002 migrate (journal=3) → seed-admin-roles 1 grant → readyz-gated flip worker (:9090/admin/queues 403 unauth) → web /login 200 + notice strip live
result: pass
reason: evidence record sec 13: flip worker first-try readyz 200 with unauthenticated :9090/admin/queues 403 (gate answer, never 500); canary legs a-h green opening the soak window 2026-09-24T19:00Z; web /login 200 on the flipped stack

### 57. [07-07] human_judgment
expected: D-38 canary green on the credentials path — old-password login proven twice (real API: 200 + session cookie + authenticated /api/monitors 200 with live monitor data; operator browser session), admin matrix green, dead-error logs quiet
result: pass
reason: evidence record verbatim attestation: PASS - canary old-password login proven twice via the real API (200 + session cookie + dashboard API 200) and by the operator browser session (2026-09-24); credential hash re-salted on login (A-1 bcrypt-10 parity)

### 58. [07-07] human_judgment
expected: D-38 Google/GitHub legs + D-40 live no-re-consent assertion dispositioned not-exercisable and reserved for the server deploy; token preservation stands on 07-06's snapshot pass
result: pass
reason: evidence record sec 13.3: D-40 live assertion DISPOSITIONED not-exercisable on this topology and RESERVED for the server deploy; token preservation stands proven at the data layer by the 07-06 D-40 snapshot pass (google 2/1/2 incl NULL-refresh propagation, github 1/1/1)

### 59. [07-07] human_judgment
expected: D-31 soak evidence complete and the single D-36 operator approval recorded — deletion release (07-08) authorized via operator early close
result: pass
reason: evidence record sec 14: FINAL RUN D-31 production soak verdict PASS (6 pass / 7 attest / 0 fail); sec 14.4 D-36 operator approval RECORDED (operator APPROVE, early close) authorizing the 07-08 deletion release

### 60. [07-08] human_judgment
expected: Deletion release DEPLOYED per runbook §4d with production smoke green (the plan's must_have truth #6 and Task 3 human-check)
result: pass
evidence: RESOLVED since recording - operator chose restore option A; deletion release deployed per runbook 4d (record sec 16.4: pre-deploy dump pre-0708-deletion-20260929-1449.dump, worker-first readyz-gated restart, web restart, all smoke legs green) and drop release per 4e (sec 17: legacy_left=0, canary re-login 200); independently confirmed by 07-VERIFICATION.md (5/5 criteria, 0 gaps).### 61. [07-07 D-38/D-40] Live Google/GitHub OAuth round-trip
expected: Google and GitHub login complete WITHOUT a re-consent screen post-cutover (D-40 verbatim assertion) — the production proof that live refresh tokens survived the reshape.
result: blocked
blocked_by: third-party
reason: zero OAuth accounts/credentials exist on this topology; formally dispositioned not-exercisable in deploy record sec 13.3 and reserved for the server deploy; token preservation stands proven at the data layer by the 07-06 D-40 snapshot pass (google 2/1/2, github 1/1/1).

### 62. [07-08] Operator password change after DB restore
expected: the operator logs in with the machine-minted credential and changes it via the auth flow (not the profile route - WINDOWS #4).
result: blocked
blocked_by: other
reason: operator-only credential action; live password is the minted value in gitignored .snapshots/0708-operator-password.txt (record sec 16.6 A.2); user must change it at next login.

### 63. [CR-01] Check-now poll + timestamps in a non-UTC environment
expected: after a check-now enqueue completes, the manual-check poll resolves (never times out) and dashboard timestamps render at the correct instant regardless of server/browser UTC offset.
result: issue
reported: CR-01 confirmed by code review against installed drizzle-orm 0.45.2 - mode:string timestamps return naive Postgres text parsed as local time, so new Date(lastChecked) > queuedAt never becomes true in UTC+ (this machine is UTC+6) and false-completes on stale values in UTC- (src/lib/check-now-poll.ts:63); not exercised live to avoid production mutation; tracked open in 07-REVIEW-DISPOSITION.md with WR-01/WR-02/WR-04.
severity: major

## Summary

total: 63
passed: 60
issues: 1
pending: 0
skipped: 0
blocked: 2

## Gaps

- gap_id: G-07-63
  truth: "Check-now poll completes and timestamps render correctly in non-UTC environments"
  status: failed
  reason: "CR-01 (07-REVIEW.md): Drizzle mode:string timestamps return naive Postgres text; new Date(naive) parses as local time, breaking the poll comparison in UTC+ (never completes) and UTC- (false-completes) - src/lib/check-now-poll.ts:63"
  severity: major
  test: 63
  root_cause: "Drizzle node-postgres mode:string timestamps return raw Postgres text (naive, no TZ); new Date(naive) parses as LOCAL time - the comparison at src/lib/check-now-poll.ts:63 never resolves in UTC+ and false-resolves on stale values in UTC- (07-REVIEW.md CR-01, verified against installed drizzle-orm 0.45.2)"
  artifacts:
    - path: src/lib/check-now-poll.ts
      issue: naive-text vs ISO Date comparison
    - path: src/app/api (11 ported routes)
      issue: timestamp serialization drift (also WR-01 updatedAt on UPDATE, WR-02 empty-set PATCH 500)
  missing:
    - normalize timestamp serialization at the Drizzle boundary (ISO-8601 UTC) or compare instants consistently
    - restore updatedAt on UPDATE paths; guard empty PATCH sets
    - extend remnant gate scan roots to scripts/
  debug_session: ""
