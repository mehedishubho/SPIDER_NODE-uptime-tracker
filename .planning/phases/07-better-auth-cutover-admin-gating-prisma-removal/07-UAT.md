---
status: testing
phase: 07-better-auth-cutover-admin-gating-prisma-removal
source: [07-01-SUMMARY.md, 07-02-SUMMARY.md, 07-03-SUMMARY.md, 07-04-SUMMARY.md, 07-05-SUMMARY.md, 07-06-SUMMARY.md, 07-07-SUMMARY.md, 07-08-SUMMARY.md]
started: 2026-10-01T16:24:04.832Z
updated: 2026-10-01T16:24:04.832Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 1
name: Cold Start Smoke Test
expected: |
  Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Server boots without errors, any seed/migration completes, and a primary query (health check, homepage load, or basic API call) returns live data.
awaiting: user response

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Server boots without errors, any seed/migration completes, and a primary query (health check, homepage load, or basic API call) returns live data.
result: [pending]

### 2. [07-01 D1] Cutover migration 0002 backfill semantics: credential rows = users-wit… (automated)
expected: Cutover migration 0002 backfill semantics: credential rows = users-with-password, per-provider reshaped counts equal legacy counts, D-40 non-null refresh/access token counts preserved per provider, D-23 boolean maps exact truthiness both sides
result: pass
source: automated
coverage_id: D1

### 3. [07-01 D2] Admin seed script D-08/D-09/D-10 semantics: missing/empty/zero-match A… (automated)
expected: Admin seed script D-08/D-09/D-10 semantics: missing/empty/zero-match ADMIN_EMAILS abort non-zero without granting; one-match roster grants role='admin' case-insensitively
result: pass
source: automated
coverage_id: D2

### 4. [07-01 D3] Additive-only migration contract: comment-stripped 0002 contains no DR… (automated)
expected: Additive-only migration contract: comment-stripped 0002 contains no DROP and no RENAME anywhere (prohibition P1 / D-30 redeploy-only rollback)
result: pass
source: automated
coverage_id: D3

### 5. [07-01 D4] A-1 hash gate + AUTH-09 lazy rehash: $2a$/$2b$/$2y$ verify matrix, unk… (automated)
expected: A-1 hash gate + AUTH-09 lazy rehash: $2a$/$2b$/$2y$ verify matrix, unknown prefixes refuse closed, hash() emits 10-round bcrypt, successful legacy verify upgrades the stored account.password and the upgrade still verifies; failed verify upgrades nothing
result: pass
source: automated
coverage_id: D4

### 6. [07-01 D5] Canary legacy-bcrypt sign-in through the real catch-all handler POST /… (automated)
expected: Canary legacy-bcrypt sign-in through the real catch-all handler POST /api/auth/sign-in/email on migrated docker-stack data: 200 + better-auth.session_token cookie + session row; 401 INVALID_EMAIL_OR_PASSWORD; 403 EMAIL_NOT_VERIFIED (D-23); second sign-in after the lazy upgrade still verifies (AUTH-09 loop)
result: pass
source: automated
coverage_id: D5

### 7. [07-01 D6] Schema authority integrity after the cutover migration: pnpm schema:ga… (automated)
expected: Schema authority integrity after the cutover migration: pnpm schema:gate empty structural diff against a pull of the migrated docker DB (with the third email_verified canonicalization), zero forbidden tokens
result: pass
source: automated
coverage_id: D6

### 8. [07-01 D7] Task 2 install set pinned and env contract active: better-auth@1.7.5 +… (automated)
expected: Task 2 install set pinned and env contract active: better-auth@1.7.5 + @better-auth/redis-storage@1.7.5 in dependencies; BETTER_AUTH_SECRET/BETTER_AUTH_URL/ADMIN_EMAILS/ADMIN_IP_ALLOWLIST entries in .env.example with D-12/D-17 annotations
result: pass
source: automated
coverage_id: D7

### 9. [07-02 D1] Every queued email link derives from BETTER_AUTH_URL — the module-scop… (automated)
expected: Every queued email link derives from BETTER_AUTH_URL — the module-scope domain read no longer references the legacy URL env under src/lib/email
result: pass
source: automated
coverage_id: D1

### 10. [07-02 D2] Hook-facing renderVerificationEmailFromUrl/renderPasswordResetEmailFro… (automated)
expected: Hook-facing renderVerificationEmailFromUrl/renderPasswordResetEmailFromUrl exist additively and embed the passed url EXACTLY; frozen template bytes unchanged
result: pass
source: automated
coverage_id: D2

### 11. [07-02 D3] renderAnnouncementEmail produces the D-06-drafted announcement copy (a… (automated)
expected: renderAnnouncementEmail produces the D-06-drafted announcement copy (all five points) with the AUTH_FLIP_DATE interpolation; throw-early when the env is absent
result: pass
source: automated
coverage_id: D3

### 12. [07-02 D5] Blast script is operator-ready on the fail-loud contract: syntax-valid… (automated)
expected: Blast script is operator-ready on the fail-loud contract: syntax-valid, env-gated before ANY enqueue, Drizzle enumeration, app-queue-only enqueue path, counts-only logging, dispose-before-exit
result: pass
source: automated
coverage_id: D5

### 13. [07-02 D6] Fan-out provably enqueues exactly one email-transactional job per regi… (automated)
expected: Fan-out provably enqueues exactly one email-transactional job per registered user — including never-verified accounts — through enqueueTransactionalEmail (D-01/D-04)
result: pass
source: automated
coverage_id: D6

### 14. [07-03 D2] EML-04: sign-up and request-password-reset each enqueue EXACTLY ONE re… (automated)
expected: EML-04: sign-up and request-password-reset each enqueue EXACTLY ONE rendered email through the Phase-6 queue carrying the framework url; zero in-request SMTP
result: pass
source: automated
coverage_id: D2

### 15. [07-03 D3] D-25: sign-up mints NO session — no session cookie and no session row … (automated)
expected: D-25: sign-up mints NO session — no session cookie and no session row (engine default would mint one)
result: pass
source: automated
coverage_id: D3

### 16. [07-03 D4] D-28 (the ONE deliberate delta): a password reset revokes the user's o… (automated)
expected: D-28 (the ONE deliberate delta): a password reset revokes the user's other sessions; the new password verifies and the old one refuses
result: pass
source: automated
coverage_id: D4

### 17. [07-03 D5] D-26: a GitHub sign-in for a Google-held email is refused with account… (automated)
expected: D-26: a GitHub sign-in for a Google-held email is refused with account_not_linked at the real callback leg and merges nothing (account row count unchanged, no second user)
result: pass
source: automated
coverage_id: D5

### 18. [07-03 D6] D-22: request-password-reset for an OAuth-only account returns the exa… (automated)
expected: D-22: request-password-reset for an OAuth-only account returns the exact clear message and enqueues nothing; credential accounts fall through (D-28 leg resets through the same guard)
result: pass
source: automated
coverage_id: D6

### 19. [07-03 D7] SEC-04/R17/D-14: GET /api/feedback admin 200 / non-admin 403 / anon 40… (automated)
expected: SEC-04/R17/D-14: GET /api/feedback admin 200 / non-admin 403 / anon 401; the D-16 structured line (userId/route/ip/timestamp) on allowed AND refused GET hits and never on POST; POST stays authenticated-for-all; Drizzle join keeps the user { name, email, image } projection
result: pass
source: automated
coverage_id: D7

### 20. [07-03 D8] AUTH-04: the proxy validates from the signed cookie via auth.api.getSe… (automated)
expected: AUTH-04: the proxy validates from the signed cookie via auth.api.getSession(request.headers) — pass-through, /login redirect with callbackUrl = pathname+search, matcher /dashboard/:path* pinned
result: pass
source: automated
coverage_id: D8

### 21. [07-03 D9] One-engine surface: no getServerSession/authOptions remains under src/… (automated)
expected: One-engine surface: no getServerSession/authOptions remains under src/app/api or src/proxy.ts; ten routes + proxy resolve sessions through getAuthSession with ownership scoping verbatim; Phase-6 contract suites green under the swapped guard
result: pass
source: automated
coverage_id: D9

### 22. [07-03 D10] AUTH-02 machine leg + legacy-bcrypt canary parity preserved under the … (automated)
expected: AUTH-02 machine leg + legacy-bcrypt canary parity preserved under the full-parity config: sign-in, lazy rehash, 401/403 codes unchanged (the tracer suite re-run against the expanded instance)
result: pass
source: automated
coverage_id: D10

### 23. [07-03 D11] AUTH-03 under the full config: adapter binding to the existing users t… (automated)
expected: AUTH-03 under the full config: adapter binding to the existing users table intact (canary sign-ins mint session rows in the NEW table with storeSessionInDatabase)
result: pass
source: automated
coverage_id: D11

### 24. [07-03 D12] authClient exists as the single client entry — only src/lib/auth-clien… (automated)
expected: authClient exists as the single client entry — only src/lib/auth-client.ts imports better-auth/react (AUTH-08 invariant, gate-extended at 07-08)
result: pass
source: automated
coverage_id: D12

### 25. [07-03 D13] The wave's build gate: pnpm build green — the [...all]/[...nextauth] c… (automated)
expected: The wave's build gate: pnpm build green — the [...all]/[...nextauth] catch-all conflict is resolved by the Task 1 deletion (worker tsup bundle green too)
result: pass
source: automated
coverage_id: D13

### 26. [07-04 D1] Single client source: zero next-auth/react imports across src/componen… (automated)
expected: Single client source: zero next-auth/react imports across src/components, src/providers, src/app/layout.tsx, and zero bare useSession tokens in the component dirs — every session/sign-out call resolves through authClient (AUTH-08 client half)
result: pass
source: automated
coverage_id: D1

### 27. [07-04 D4] noticeWindowActive predicate: inclusive [start,end] window; missing/in… (automated)
expected: noticeWindowActive predicate: inclusive [start,end] window; missing/invalid/empty bounds and inverted windows all fail toward no-strip (T-07-15)
result: pass
source: automated
coverage_id: D4

### 28. [07-04 D6] AUTH_NOTICE_START/AUTH_NOTICE_END documented in .env.example as delete… (automated)
expected: AUTH_NOTICE_START/AUTH_NOTICE_END documented in .env.example as delete-after-use (D-05 annotation; 07-08 extends the remnant gate)
result: pass
source: automated
coverage_id: D6

### 29. [07-04 D7] Post-flip e2e harness bootable: playwright webServer env carries test-… (automated)
expected: Post-flip e2e harness bootable: playwright webServer env carries test-scoped BETTER_AUTH_*/OAuth credentials satisfying the 07-03 requireProductionEnv gate
result: pass
source: automated
coverage_id: D7

### 30. [07-05 D1] Bull Board serves at /admin/queues on :9090 behind the ordered gate ch… (automated)
expected: Bull Board serves at /admin/queues on :9090 behind the ordered gate chain (allowlisted+admin → 200 HTML; allowlisted+non-admin → 403; non-allowlisted → 403; empty allowlist → 403 for everything; spoofed forwarded-for never grants access) with a D-16 audit line per hit and POST mutations reaching the mount
result: pass
source: automated
coverage_id: D1

### 31. [07-05 D2] Fail-closed, CIDR-aware ADMIN_IP_ALLOWLIST util (parseIpAllowlist thro… (automated)
expected: Fail-closed, CIDR-aware ADMIN_IP_ALLOWLIST util (parseIpAllowlist throws on garbage, empty refuses everything; isIpAllowlisted handles exact/CIDR/mapped-IPv6/IPv6)
result: pass
source: automated
coverage_id: D2

### 32. [07-05 D3] Per-path source gating on a non-loopback bind: healthz 200 from loopba… (automated)
expected: Per-path source gating on a non-loopback bind: healthz 200 from loopback and 403 from a non-loopback source while /admin/queues answers the same non-loopback allowlisted source (T-07-19)
result: pass
source: automated
coverage_id: D3

### 33. [07-05 D4] The A5 bridge serves the Bull Board UI through getRequestListener on t… (automated)
expected: The A5 bridge serves the Bull Board UI through getRequestListener on the existing node:http server (entry HTML 200 + static asset 200 behind the gates)
result: pass
source: automated
coverage_id: D4

### 34. [07-05 D5] The hono-path Bull Board dependency set pinned exactly as researched; … (automated)
expected: The hono-path Bull Board dependency set pinned exactly as researched; the web bundle gains zero BullMQ/Bull Board code (pnpm worker:boundary green)
result: pass
source: automated
coverage_id: D5

### 35. [07-06 D1] WR-05 closure: count-agnostic rehearsal bookkeeping + 0002 digest inve… (automated)
expected: WR-05 closure: count-agnostic rehearsal bookkeeping + 0002 digest inventory (account/session/verification + users.role/email_verified)
result: pass
source: automated
coverage_id: D1

### 36. [07-06 D2] Refreshed anonymized snapshot with the D-37 canary designation — exact… (automated)
expected: Refreshed anonymized snapshot with the D-37 canary designation — exactly one real-email account holding a known legacy bcrypt hash
result: pass
source: automated
coverage_id: D2

### 37. [07-06 D3] Full D-34 flip rehearsal on the stand-in (migration, admin seed + D-09… (automated)
expected: Full D-34 flip rehearsal on the stand-in (migration, admin seed + D-09 abort, web+worker boot, canary login, admin gates, Bull Board matrix, email round-trips, notice strip)
result: pass
source: automated
coverage_id: D3

### 38. [07-06 D4] D-40 snapshot leg: per-provider pre/post reshaped row counts and non-n… (automated)
expected: D-40 snapshot leg: per-provider pre/post reshaped row counts and non-null refresh/access token counts match
result: pass
source: automated
coverage_id: D4

### 39. [07-06 D6] D-35 redeploy-rollback drill — previous artifact rebooted against the … (automated)
expected: D-35 redeploy-rollback drill — previous artifact rebooted against the post-0002 schema, legacy engine verified, re-flip verified
result: pass
source: automated
coverage_id: D6

### 40. [07-06 D7] Runbook §4c 'Phase-7 flip release' — backup, single-runner migrate, se… (automated)
expected: Runbook §4c 'Phase-7 flip release' — backup, single-runner migrate, seed-admin-roles with D-09 abort note, readyz-gated worker restart (:9090 gains Bull Board), web restart, D-31 canary preview, D-07 slip rule, D-11 grant/revoke SQL, D-15 feedback curl
result: pass
source: automated
coverage_id: D7

### 41. [07-07 D5] scripts/auth-soak-gate.mjs typed gate (6 machine + 7 attest legs, neve… (automated)
expected: scripts/auth-soak-gate.mjs typed gate (6 machine + 7 attest legs, never-silently-pass) parses, evaluates, and appends evidence to the deploy record
result: pass
source: automated
coverage_id: D5

### 42. [07-08 D1] D-41 remnant gate extended over every Phase-7 remnant class AND ARMED … (automated)
expected: D-41 remnant gate extended over every Phase-7 remnant class AND ARMED (PHASE7_ENFORCED): banned specifiers/deps, deleted basenames, retired env tokens; RED teeth pinned; third-party read-form exemption documented + pinned
result: pass
source: automated
coverage_id: D1

### 43. [07-08 D2] Legacy auth stack, Prisma stack, cookie helper, prisma/ dir, generated… (automated)
expected: Legacy auth stack, Prisma stack, cookie helper, prisma/ dir, generated client, blast script, and notice-strip surfaces deleted; 7 deps removed; build script prefix dropped
result: pass
source: automated
coverage_id: D2

### 44. [07-08 D3] DRZ-07 sweep: 11 Prisma-consuming API routes ported to the ONE Drizzle… (automated)
expected: DRZ-07 sweep: 11 Prisma-consuming API routes ported to the ONE Drizzle client with wire contracts preserved (projections, orderings, bounds, P2025-style vanished-row 500 guards)
result: pass
source: automated
coverage_id: D3

### 45. [07-08 D4] AUTH-08 client token mirror removed: baseApi sends no Authorization he… (automated)
expected: AUTH-08 client token mirror removed: baseApi sends no Authorization header from state (cookie credentials only); Redux retains UI/domain state only
result: pass
source: automated
coverage_id: D4

### 46. [07-08 D5] 07-07 queued rehash fix: lazy rehash upgrades BOTH stored hash copies … (automated)
expected: 07-07 queued rehash fix: lazy rehash upgrades BOTH stored hash copies keyed on the received hash; divergence case pinned; WINDOWS #2 closed
result: pass
source: automated
coverage_id: D5

### 47. [07-02] Announcement copy WORDING/adequacy approved by the operator (D-06: ins…
expected: Announcement copy WORDING/adequacy approved by the operator (D-06: inspect exact rendered bytes via console provider at the flip rehearsal)
result: [pending]

### 48. [07-02] The blast runs end-to-end on a real stack (real Redis email lane, cons…
expected: The blast runs end-to-end on a real stack (real Redis email lane, console-provider dry-run inspected, then a production send)
result: [pending]

### 49. [07-03] Full-parity config inventory in src/lib/auth.ts: every D-21..D-28/D-42…
expected: Full-parity config inventory in src/lib/auth.ts: every D-21..D-28/D-42..D-44 pin explicit (TTLs 3600, minPasswordLength 6, requireEmailVerification, sendOnSignIn false, 30d session + updateAge/freshAge defaults, cookieCache jwt 5min, disableImplicitLinking, autoSignIn false, revokeSessionsOnPasswordReset true, rateLimit customRules 5/h on /sign-up/email + /request-password-reset, ipAddressHeaders x-forwarded-for, trustedOrigins, admin role primitive only)
result: [pending]

### 50. [07-04] Six auth forms swapped onto authClient with byte-frozen pixels (import…
expected: Six auth forms swapped onto authClient with byte-frozen pixels (import-line + handler-body diffs only) and the D-33 mapping realized: 401 -> 'Invalid email or password.'; 403 EMAIL_NOT_VERIFIED -> 'Please verify your email address before logging in.'; provider-initiate/account_not_linked -> frozen ${provider} toast; RegisterForm duplicate-email synthetic 200 keeps the success toast (A4); dead pre-flip tokens land on the existing error state (D-20)
result: [pending]

### 51. [07-04] Nine dashboard/common components on authClient with existing condition…
expected: Nine dashboard/common components on authClient with existing conditional-render semantics intact; AuthProvider deleted and layout wrapper removed; ProfileComponent refresh via authClient.updateUser; TeamSwitch js-cookie/Redux lines untouched (07-08 scope)
result: [pending]

### 52. [07-04] D-02 notice strip on /login: server-rendered, role=status, frozen toke…
expected: D-02 notice strip on /login: server-rendered, role=status, frozen tokens (bg-card/border-border/rounded-xl, muted w-4 h-4 icon aria-hidden, text-foreground 14px), frozen D-02 sentence, non-dismissible zero client state, renders null outside the AUTH_NOTICE_START..END window with zero reserved space
result: [pending]

### 53. [07-05] Bull Board console error state — gate failures render the refusal page…
expected: Bull Board console error state — gate failures render the refusal page, never a broken frame (must_haves backstop truth, UI Considerations 'error/Bull Board' row)
result: [pending]

### 54. [07-06] D-06 operator copy sign-off — verification/reset/announcement bytes, n…
expected: D-06 operator copy sign-off — verification/reset/announcement bytes, notice strip render, D-22 refusal copy approved as rendered
result: [pending]

### 55. [07-07] Announcement blast ran through the production queue for all 5 register…
expected: Announcement blast ran through the production queue for all 5 registered users with the D-06-approved bytes and drained 0-failed (console transport; 4/5 recipients internal fixtures, recorded)
result: [pending]

### 56. [07-07] Flip release deployed per runbook §4c: pre-flip pg_dump (145,254 B, re…
expected: Flip release deployed per runbook §4c: pre-flip pg_dump (145,254 B, restore-listed) → 0002 migrate (journal=3) → seed-admin-roles 1 grant → readyz-gated flip worker (:9090/admin/queues 403 unauth) → web /login 200 + notice strip live
result: [pending]

### 57. [07-07] D-38 canary green on the credentials path — old-password login proven …
expected: D-38 canary green on the credentials path — old-password login proven twice (real API: 200 + session cookie + authenticated /api/monitors 200 with live monitor data; operator browser session), admin matrix green, dead-error logs quiet
result: [pending]

### 58. [07-07] D-38 Google/GitHub legs + D-40 live no-re-consent assertion dispositio…
expected: D-38 Google/GitHub legs + D-40 live no-re-consent assertion dispositioned not-exercisable and reserved for the server deploy; token preservation stands on 07-06's snapshot pass
result: [pending]

### 59. [07-07] D-31 soak evidence complete and the single D-36 operator approval reco…
expected: D-31 soak evidence complete and the single D-36 operator approval recorded — deletion release (07-08) authorized via operator early close
result: [pending]

### 60. [07-08] Deletion release DEPLOYED per runbook §4d with production smoke green …
expected: Deletion release DEPLOYED per runbook §4d with production smoke green (the plan's must_have truth #6 and Task 3 human-check)
result: [pending]


## Summary

total: 60
passed: 45
issues: 0
pending: 15
skipped: 0

## Gaps

[none yet]
