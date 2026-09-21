# Phase 7: Better Auth Cutover, Admin Gating & Prisma Removal - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-21
**Phase:** 7-better-auth-cutover-admin-gating-prisma-removal
**Areas discussed:** Re-login announcement UX, Admin bootstrapping & roles, Pre-flip token & link fate, Release structure & Prisma exit, Rehearsal & approval gates, Session lifetime, Canary account strategy

---

## Re-login announcement UX

| Option | Description | Selected |
|--------|-------------|----------|
| Advance blast, all users | One announcement email to ALL registered users a few days before the flip; unauthenticated users land on login | ✓ |
| At-flip blast, all users | Single email sent AT the flip moment to all users | |
| Advance blast + in-app banner | Advance email + persistent env-dated in-app banner before the flip | |
| Login-page notice | Post-flip notice strip on /login, env date window, auto-expires with a later release | ✓ |
| Interstitial notice page | Dedicated "we've upgraded sign-in" page before /login | |
| Email only, no in-app | No in-app surface (under-delivers on audit Q-4's "in-app and by email") | |
| Accept the blip | Mid-session users get 401 → existing redirect; no new expired-session UX | ✓ |
| Graceful expired-session UX | Detect flip case and show friendly "session ended" toast/notice | |
| Queue fan-out | Operator script enqueues one email-transactional job per user (render-at-enqueue) | ✓ |
| Direct SMTP bulk-send | Straight SMTP loop in the script, bypassing the queue | |
| Out-of-band (no code) | Operator's own mail tool; not reproducible from the repo | |
| All registered users | Blast includes never-verified accounts | ✓ |
| Verified users only | Only verified emails get the blast (bounce-noise avoidance) | |
| Delete after use | Script deleted in the deletion release; D-41 gate extended | ✓ |
| Keep as operator tool | Script stays as a permanent operator tool | |
| Draft in-plan, approve at rehearsal | Planner drafts copy; operator approves rendered bytes at rehearsal | ✓ |
| Pin exact copy now | Exact wording pinned verbatim in CONTEXT.md this session | |
| Persistent strip | Non-dismissible notice for the whole env window; zero client state | ✓ |
| Dismissible strip | Users can dismiss (cookie/localStorage flag) | |
| Runbook rule: re-blast on slip | If flip slips >~48h past announced date, re-run blast with updated copy | ✓ |

**User's choice:** as marked — advance blast (all users, incl. never-verified), persistent login-page notice, accept the blip, queue fan-out, delete-after-use script, copy drafted in-plan, slip rule as a runbook line.
**Notes:** The flip-slip question was asked twice via AskUserQuestion without a response (timeouts) and re-asked as plain text; the user answered "1" (runbook re-blast rule). The blast dry-run runs on the console provider locally first.

---

## Admin bootstrapping & roles

| Option | Description | Selected |
|--------|-------------|----------|
| Env-fed migration step | Cutover migration reads ADMIN_EMAILS, sets role='admin'; rehearsed on snapshot | ✓ |
| Manual SQL runbook step | One documented UPDATE run by hand on production post-flip | |
| Dedicated operator script | scripts/set-admin.ts via Drizzle, run post-flip | |
| Just the operator | ADMIN_EMAILS = the operator's own account only | ✓ |
| Operator + backup admin | 2+ accounts for cover | |
| Runbook SQL one-liner | Parameterized grant/revoke UPDATE + sign-out/in note documented | ✓ |
| Operator script | Checked-in set-role.ts for grant/revoke | |
| Nothing documented | Grant at migration, never change | |
| Worker :9090 mount | Bull Board on the worker health server; IP allowlist → admin session; web stays Postgres-only | ✓ |
| Next.js admin route | Bull Board in a Next route (no official adapter; BullMQ in web bundle) | |
| Standalone service | Third PM2 app with express | |
| Feedback GET + Bull Board only | Exactly the roadmap-named gates; POST stays user-wide | ✓ |
| Sweep other endpoints too | Gate additional existing endpoints in the same pass | |
| API-only now, UI deferred | Operator consumes feedback via documented curl/SQL; no admin page | ✓ |
| Minimal admin page now | New admin feedback page in Phase 7 | |
| Log admin access lines | One structured line (userId, route, IP, timestamp) per admin-gated access | ✓ |
| No special logging | Gates only; generic request logging covers troubleshooting | |
| Bull Board only | ADMIN_IP_ALLOWLIST gates exactly the queue UI | ✓ |
| All admin APIs | Allowlist also wraps the feedback API | |
| Even admin logins | Allowlist gates the admin user's logins themselves | |
| Abort the migration | ADMIN_EMAILS unset/empty/zero-match = hard error (throw-early) | ✓ |
| Warn and continue | Proceed with zero admins + loud warning | |
| Role primitive only | Plugin for role column + checks; ban/impersonate unused, deferred | ✓ |
| Full plugin surface | Full management endpoints exposed | |
| Full actions enabled | Bull Board retry/remove/drain kept (operator emergency lever) | ✓ |
| Read-only variant | Custom suppression of action endpoints | |
| Keep as documented roster | ADMIN_EMAILS stays in .env.example (DEP-05 annotation) | ✓ |
| Retire with the deletion release | Remove from env docs at deletion | |

**User's choice:** as marked — env-fed migration with abort-on-missing, operator-only roster, runbook SQL for changes, worker :9090 Bull Board behind allowlist+session, gates limited to feedback GET + Bull Board, API-only feedback consumption, structured audit lines, Bull-Board-only allowlist, role-primitive-only plugin, full Bull Board actions, env kept as documented roster.

---

## Pre-flip token & link fate

| Option | Description | Selected |
|--------|-------------|----------|
| Dead on arrival | Old links stop with a clear error; legacy tables read-only for rollback only | ✓ |
| Honor legacy tokens one release | Dual-source token flow (new table first, legacy read-only fallback) | |
| Better Auth defaults | Verification/reset TTLs = library defaults; researcher confirms values | ✓ |
| Pin explicit expiries | Hard-coded short expiries, tested | |
| Mirror today's rules | Reset requires password hash; OAuth-only accounts get the clear message | ✓ |
| Let OAuth users set passwords | Reset bridges OAuth accounts to credentials (new capability + takeover surface) | |
| Gate survives as-is | Unverified users still can't log in; boolean backfill maps timestamps | ✓ |
| Drop the gate | Anyone with a password can log in | |
| Parity policy | Every endpoint with a limit today keeps an equivalent limit; mechanism = researcher/planner | ✓ |
| House limiter everywhere | Wrap Better Auth's handler with the Redis Lua limiter | |
| No session until verified | signUp returns no session; login gate applies exactly as before | ✓ |
| Better Auth default (session now) | signUp mints a session immediately | |
| Mirror today's linking | Cross-provider same-email login stays blocked (account-not-linked) | ✓ |
| Auto-link same-email | Deliberately loosen at cutover | |
| Drop with data | Legacy tables dropped WITH data; read-only window was the protection | ✓ |
| Archive before drop | Dump tables to a dated SQL archive before dropping | |
| Revoke other sessions | Password reset kills other-device sessions (the one deliberate improvement) | ✓ |
| Strict parity (survive) | Sessions survive a reset as today's JWTs do | |
| Mirror today | No resend affordance (none coded today either) | ✓ |
| Add resend affordance | "Resend verification email" on login/verify pages | |

**User's choice:** as marked — old links dead, default TTLs, reset rules mirrored, verification gate kept, rate-limit parity, no-session-until-verified, OAuth linking mirrored, data dropped with tables, revoke-on-reset adopted and flagged as the deliberate delta, no resend path.

---

## Release structure & Prisma exit

| Option | Description | Selected |
|--------|-------------|----------|
| Flip → soak → deletion | Release 1 flips (old stack dead-but-present = rollback); soak; release 2 deletes everything | ✓ |
| Single big-bang release | Flip and delete the same night; rollback = tarball + DB restore | |
| Three-stage (flip/code/tables) | Three releases, each soaked | |
| Redeploy-only | Additive migration ⇒ rollback = redeploy previous release; reconciliation note for window rows | ✓ |
| Redeploy + DB restore | Previous release + pre-migration backup restore (loses window rows) | |
| ~24h + typed gate checklist | 06 D-31 duration + 05 D-14 one-command evaluation writing into 07-DEPLOY-RECORD.md | ✓ |
| Hours-level smoke | Operator-driven logins only | |
| No soak | Back-to-back flip+delete (only sensible with big-bang) | |
| Explicit drop release | Physical DROP as a tiny follow-up release after its own short soak | ✓ |
| Drop with deletion release | Tables die the same night as the code | |
| Defer past the phase | Tables stay read-only indefinitely | |
| Same pixels, new plumbing | Auth pages keep exact visuals; only the client swaps | ✓ |
| Light visual refresh now | Refresh visuals while touching the pages | |

**User's choice:** as marked — flip/soak/deletion structure, redeploy-only rollback with drilled evidence, 24h typed-gate soak, explicit drop release, unchanged page visuals.
**Notes:** The table-drop question timed out once and was re-asked successfully.

---

## Rehearsal & approval gates

| Option | Description | Selected |
|--------|-------------|----------|
| Full flip rehearsal | Migration + seeding + backfill + both apps + canary + gate checks + token round-trips on the refreshed snapshot | ✓ |
| Migration-only rehearsal | Only the migration is rehearsed; first Better Auth boot happens on production | |
| One gate: soak→deletion | Single operator approval before the deletion release (05 D-18 pattern) | ✓ |
| Three gates (flip/deletion/drop) | Explicit approvals at each release boundary | |
| No explicit approvals | Gate-script PASS auto-proceeds | |
| Drill the redeploy rollback | Flip stand-in → verify → redeploy previous → verify NextAuth → re-flip | ✓ |
| Paper argument only | Trust the additive-migration argument | |
| Both apps incl. Bull Board | Worker side (:9090 auth + allowlist) exercised on the stand-in | ✓ |
| Web-only rehearsal | Bull Board first boots on production | |
| Refresh from production | Regenerate the anonymized snapshot before rehearsal (Phase-5-era one is stale) | ✓ |
| Reuse existing snapshot | Reuse the Phase-5-era snapshot | |

**User's choice:** as marked — full flip rehearsal on a refreshed snapshot covering both apps, one approval gate (soak→deletion), the redeploy rollback actively drilled.

---

## Session lifetime

| Option | Description | Selected |
|--------|-------------|----------|
| 30 days, parity | Matches today's JWT lifetime; felt behavior unchanged | ✓ |
| 7 days, Better Auth default | Visible change: weekly re-logins | |
| 14 days (tightened) | Deliberate tightening; doubles login frequency | |
| Engine defaults | Sliding renewal semantics from the library; researcher confirms values | ✓ |
| Hard 30-day wall | Session dies exactly 30 days after login regardless of activity | |
| Unlimited, parity | No concurrent-session cap (as today) | ✓ |
| Cap concurrent sessions | e.g., 5 with oldest evicted | |

**User's choice:** 30-day parity, engine-default sliding renewal, unlimited devices. cookieCache revocation-lag policy remains explicitly research-routed.

---

## Canary account strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Designated real-email canary | Anonymizer keeps one account with the operator's real email + known bcrypt hash; satisfies the zero-match abort + proves the hash path + doubles as admin-gate subject | ✓ |
| Relax the guard on stand-in | Snapshot mode relaxes the ADMIN_EMAILS abort; canary hash injected ad hoc | |
| Operator is the canary | Production's first login = the operator's own credentials, then Google, then GitHub | ✓ |
| Dedicated test account | Separate known-password account as production's first canary | |
| One account, all three types | Operator account links Google + GitHub before flip night | ✓ |
| Credentials canary + natural OAuth | OAuth proof left to whatever the soak produces naturally | |
| DB counts + no-reconsent | Snapshot row-count comparison + production no-re-consent-screen assertion | ✓ |
| No-reconsent only | Production observation only | |
| Immediate redeploy | Canary red → pre-committed redeploy of the previous release, no production debugging | ✓ |
| Bounded debug-then-rollback | ~30 min debugging window before rollback | |

**User's choice:** as marked — designated snapshot canary, operator as production canary with all three login types pre-linked, two-angle refresh-token proof, immediate-redeploy abort rule.

---

## Claude's Discretion

- Announcement email + notice-strip copy (drafted in-plan, operator-approved at rehearsal)
- Rate-limit mechanism (Better Auth built-in vs house Lua limiter) and the current login-coverage pin
- Exact cookieCache TTL and revocation-lag policy (research-routed by the roadmap flag)
- Better Auth base-path mapping (expected to keep `/api/auth/*`)
- 07-DEPLOY-RECORD.md structure (03-08/04/05 disposition-register pattern)
- Worker restart choreography in the release runbook
- Blast-script internals (recipient enumeration, flip-date env, batching)

## Deferred Ideas

- Admin feedback viewer UI (Phase 8 territory)
- Better Auth admin-plugin management endpoints (ban/unban, impersonate, user listing)
- Resend-verification affordance for unverified users
- Password-setting for OAuth-only accounts
- Same-email OAuth auto-linking
- Session-count caps / "sign out everywhere"
