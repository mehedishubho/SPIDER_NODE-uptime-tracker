---
status: partial
phase: 06-thin-api-routes-email-abstraction
source: [06-01-SUMMARY.md, 06-02-SUMMARY.md, 06-03-SUMMARY.md, 06-04-SUMMARY.md, 06-05-SUMMARY.md]
started: 2026-09-29T22:24:06Z
updated: 2026-09-29T22:41:46Z
---

## Current Test

[testing paused — 1 item outstanding]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Server boots without errors, any seed/migration completes, and a primary query (health check, homepage load, or basic API call) returns live data.
result: pass
evidence: "Delegate-run 2026-09-29T22:33Z via the operator's own guarded restart scripts (worker-first readyz-gated, then web). Old web (PID 30772) + worker (PID 38424) killed after cmdline verification; worker rebooted (readyz 200 {redis:ok,db:ok}, scheduler ACTIVE, healthz sha f71cbdc PID 29292); web rebooted (login 200, home 200, unauth /api/monitors 401, notice strip 0 as expected post-07-08). Worker log shows recurring scheduling ACTIVE + live check flow. Durable DB/Redis containers intentionally not wiped (they are the app's persistent store on this topology); cold start = full app-tier process restart."

### 2. Check Now — 202 + Poll + Toast
expected: On the Dashboard, click Check now on an active monitor. The button swaps to "Checking…" and control returns immediately (202 enqueue, never a synchronous check). Within ~2-30s the fresh result appears via polling: UP → green success toast, DOWN → red error toast. On timeout an info toast appears (never an error, never an auto re-enqueue).
result: issue
reported: "Delegate-run: 202 body contract VERIFIED ({jobId: 'check-manual:4:...', queuedAt}, immediate). FIRST check (PENDING→UP transition) persisted sub-second (Tier 1 applied:true, lastChecked 22:36:28.676Z, status UP, responseTime 24ms). REPEAT check-now on the now-UP monitor: worker job ran (check-manual:4:1790721457894, Tier 1 txn applied:false) but NOTHING persisted — no check row, lastChecked stayed 22:36:28.676Z, totalChecks stayed 1 across a full 30s poll window AND re-check 44s later. The client poll (lastChecked > queuedAt, 30s give-up) can never complete for a repeat manual check on an UP monitor → always the timeout info toast; data refreshes only at the next SCHEDULED check (interval minutes later). The phase's #1 success criterion (SC-1/API-01 fresh result via polling) fails in the most common case."
severity: blocker

### 3. Check-Now Rate Limit — 429 + Retry-After
expected: Trigger check-now repeatedly past the per-user/per-IP limits (7/min, 30/h buckets). Response is 429 with a numeric Retry-After header, and the Dashboard toast surfaces the retry window from that header.
result: pass
evidence: "Delegate-run with authenticated probe session: after prior 202s in the window, next 202 then 429 with Retry-After: 30 (numeric) exactly at the bucket edge. Toast leg covered by UI-SPEC copy contract + check-now-poll suite (API leg is the observable contract here)."

### 4. Redis-Down Check-Now — Bounded 503
expected: With Redis unreachable, POST /api/monitors/[id]/check refuses loudly: a 503 (Service temporarily unavailable) within a bounded time — never a silent no-op and never an indefinite hang.
result: blocked
blocked_by: other
reason: "Requires stopping the production Redis (live monitoring outage on the operator's instance) plus an authenticated session. Note: the never-connectable-Redis hang variant is VERIFICATION gap 2, already diagnosed and planned as 06-06 Task 2 (producer-side 3000ms deadline) — not yet executed at UAT time."

### 5. Sign-Up Verification Email via Queue Lane
expected: Register a new account through the current auth (Better Auth) sign-up flow. Registration completes (no email wait on the request path) and the verification email arrives through the queue-backed email lane (console provider logs it locally; SMTP delivers in prod). With SMTP temporarily down, registration still succeeds and the email arrives once SMTP recovers.
result: pass
evidence: "Delegate-run: POST /api/auth/sign-up/email → HTTP 200 instantly (user created, email off the request path); worker log shows [email-console] verification render ('Confirm your email - SpiderNode') with the byte-verbatim EML-05 template from its relocated position, delivered via the email queue lane (enqueue → lane worker → console provider). SMTP-down degradation leg covered by email-lane suite (exact D-09 backoff pinned) — not re-induced on the live stack. Probe account: uat-probe-06@spidernode.internal (fixture, creds in .snapshots/06-uat-probe-creds.txt, gitignored)."

### 6. Forgot/Reset Email — Neutral 200 + Delivery
expected: Request a password reset: for a known email the reset message arrives; for an unknown email the API returns the same neutral 200 body ("Reset email sent!") — no account enumeration.
result: pass
evidence: "Delegate-run via the engine path /api/auth/request-password-reset: known email → 200 {status:true,'If this email exists...'} + [email-console] 'Reset your password - SpiderNode' rendered through the lane; unknown email → identical neutral 200 with ZERO enqueues (no console render). Non-browser POST without Origin → 403 MISSING_OR_NULL_ORIGIN (engine CSRF check — browsers always send Origin; correct hardening, not a defect). Legacy /forget-password alias 404s as documented in auth.ts:214."

### 7. Telegram Webhook Auth Ladder
expected: POST /api/telegram/webhook without the X-Telegram-Bot-Api-Secret-Token header → 401 and no chat-binding write. Wrong-length token → 401. Flooding past 30 req/min from one IP → 429 even with the correct secret.
result: issue
reported: "Delegate-run: rate-limit leg EXACT — 30 requests consumed the window then 429 from the 31st (limiter-first ladder, D-21, works; only the loopback bucket burned). Secret legs FAIL the contract shape: no-secret and wrong-length both return 500, not 401. Web log names the cause: 'Telegram Webhook Error: TELEGRAM_WEBHOOK_SECRET is not configured' — the Phase-07 flip env contract (.snapshots/0707-prod-worker-env.sh, 14 keys) omits TELEGRAM_WEBHOOK_SECRET, so the route takes its designed loud config-error path (fail-closed: body never processed, no chat-binding write, never accepts). The code is correct (06-03 pins: unset→500 by design, wrong secret→401); the RUNNING POSTURE lacks the secret. Production mint was operator-attested at 06-05 §12 but never entered the 07-era launch env."
severity: major

### 8. Monitor Create — SSRF Admission
expected: Creating (or PATCHing the URL of) a monitor with a private/loopback URL (e.g. http://127.0.0.1, http://169.254.169.254) is refused with 400 and an actionable message carrying no resolution internals. A normal public URL is accepted.
result: pass
evidence: "Delegate-run: POST /api/monitors url=http://127.0.0.1:9/x → 400 {error:'URL is not allowed: only public http(s) targets are permitted'}; url=http://169.254.169.254/latest/meta-data → 400 same actionable body, no internals. Public URL (https://example.com) → created (monitor id 4), later cleaned up (DELETE 200)."

### 9. Stand-In Feature-Release Rehearsal Record
expected: 06-DEPLOY-RECORD.md §2–§6 stands as executed: six green gates, four D-30 smoke legs with concrete evidence, same-SHA provenance, steady posture (rehearsal legs were live-stack observations recorded as evidence prose).
result: pass
evidence: "Record-verified by delegate: §2 pre-flight gate chain all GREEN (six gates, logs named), §4 legs (a)/(b1)/(b2)/(c)/(d) each with timestamps and concrete observations, §2 D-31 same-SHA provenance verified-from-mtimes section present, §5 steady-posture section present."

### 10. Operator Approval + Soak Window Opened (Feature Release)
expected: 06-DEPLOY-RECORD.md §8–§10 records the blocking operator approval of the production feature release verbatim, and the D-31 soak window opened on release 31a56df.
result: pass
evidence: "Record-verified: §7 THE BLOCKING CHECKPOINT, §8 'OPERATOR APPROVAL — VERDICT: APPROVED' (2026-09-20), §10 'D-31 soak window — OPENED' from window-open record 2026-09-20T20:00Z on release 31a56df."

### 11. Production Release 31a56df — setWebhook Cutover + Soak Gate Closed
expected: 06-DEPLOY-RECORD.md §8–§12: production feature release with setWebhook cutover inside the cutover window, soak criteria (real-user traffic, real registration delivery, retention counts, dead-men quiet) attested, D-31 soak gate closed on operator approval.
result: pass
evidence: "Record-verified: §12 '06-05 Task 1 CLOSED — operator approval recorded' with the machine-verified vs operator-attested split explicit (production TELEGRAM_WEBHOOK_SECRET mint + one-time setWebhook with secret_token + soak criteria #1–#4 = operator-attested under the documented 05-08 D-18 / 06-04 §8 bare-approval precedent; never presented as executor-seen). §12 also honestly records the approval arriving at T+~66min against the ~24h window — covered by the attestation form."

### 12. Phase Evidence Closeout
expected: 06-DEPLOY-RECORD.md is closed: both releases recorded (31a56df + deletion release), soak record, deletion evidence, final operator approval ("approved") present, RECORD CLOSED line committed.
result: pass
evidence: "Record-verified: §13 deletion-release deploy + smoke + closeout with second 'approved'; 'RECORD CLOSED — Phase 6 releases complete, evidenced, and operator-approved.' at line 476; commit b1fe108 ('docs(06-05): close Task 3 — deletion release deployed, smoked, phase record closed') present in git."

### 13. Daily maintenance real deletes (D-14/D-18)
expected: Daily maintenance scheduler runs real deletes (dryRun:false) with deleted-count logging and error-level failure logging
result: pass
source: automated
coverage_id: 06-04/D1

### 14. enqueue-maintenance.mjs bounded on unreachable Redis (WR-01/D-15)
expected: enqueue-maintenance.mjs exits non-zero within a bounded deadline on unreachable Redis; dry-run/apply flags preserved
result: pass
source: automated
coverage_id: 06-04/D2

### 15. Runbook §4b + §9 + .env.example entries (SEC-03)
expected: Runbook §4b feature-release choreography (four smoke legs, setWebhook inside the cutover, D-31 soak list) + §9 secret hygiene + .env.example TELEGRAM_WEBHOOK_SECRET / EMAIL_PROVIDER entries present
result: pass
source: automated
coverage_id: 06-04/D3

### 16. Deletion release atomic contract (SEC-06)
expected: cron routes, cron-logic/db-batcher/cleanup-logic/mail.ts, CRON_SECRET env entries, playwright CRON_MODE writer deleted; D-41 gate extended (routes + token + module imports + mail imports) — pnpm verify green, 441 files, RED-on-reintroduction spot-checks
result: pass
source: automated
coverage_id: 06-05/D2

### 17. Deleted pins mapped in 06-PIN-INVENTORY.md (SEC-06)
expected: 15 deleted-pin rows mapped to successor guarantees including the S-4 query-secret marker
result: pass
source: automated
coverage_id: 06-05/D3

### 18. Deletion release deployed + smoke legs green (SEC-06)
expected: Deletion release deployed worker-first readyz-gated; retired cron paths 404, check-now 202 + poll sub-2s, registration email rendered, scheduler tick + queue-drain observed (06-DEPLOY-RECORD.md §13)
result: pass
source: automated
coverage_id: 06-05/D4

## Summary

total: 18
passed: 15
issues: 2
pending: 0
skipped: 0
blocked: 1

## Gaps

<!-- YAML format for plan-phase --gaps consumption -->
- gap_id: G-06-2
  truth: "Check-now on an already-UP monitor returns 202 and the fresh result appears via polling within the documented latency (lastChecked > queuedAt, 30s window)"
  status: failed
  reason: "User reported: repeat check-now on an UP monitor times out — 202 body correct, first-check (transition) sub-second, but the repeat manual check persists NOTHING (applied:false, no Tier-2 staging); poll can never complete"
  severity: blocker
  test: 2
  root_cause: "Manual checks are hard-routed to the Tier-1 transition transaction (src/worker/engine/check.ts:263 'outcome.kind === \"down\" || monitor.status !== \"UP\" || manual' — Phase-04 design 31bb9b2), and the Tier-1 UPDATE is transition-guarded (src/worker/persist/tier1.ts:196-198 WHERE id = ... AND status <> target AND \"isActive\") — so an UP→UP manual result matches 0 rows: no check row, no lastChecked/responseTime/totalChecks update, and the job never reaches the Tier-2 routine-UP staging path (scheduler checks do). Client poll contract (D-01: lastChecked > queuedAt, 30s give-up) is unsatisfiable for repeat manual checks; the monitor row refreshes only at the next SCHEDULED check (interval minutes later). Live evidence: worker log 22:37:37.926 'check persisted — Tier 1 transition transaction' {m:4, tier:1, applied:false}; API lastChecked stayed 22:36:28.676Z / totalChecks 1 across the 30s poll and a 44s re-check."
  artifacts:
    - path: "src/worker/engine/check.ts"
      issue: "line 263: '|| manual' routes manual checks to Tier 1 unconditionally; the no-transition branch falls through applyTransition (applied:false) and returns without staging the routine result"
    - path: "src/worker/persist/tier1.ts"
      issue: "lines 196-198: transitionUpdateSql WHERE status <> target — correct for scheduler duplicates, drops manual UP→UP results entirely"
  missing:
    - "Persist manual non-transition results (route them to the Tier-2 stageResult path like scheduler checks, or un-guard lastChecked/responseTime/totalChecks for manual jobs, or flush in-job per the Phase-05 D-04 manual-flush intent)"
    - "End-to-end pin: repeat check-now on an UP monitor → lastChecked > queuedAt within the poll window (no such pin exists; unit suites pin route + client in isolation)"
  debug_session: ""

- gap_id: G-06-7
  truth: "Telegram webhook POST without the correct secret header is refused 401 (constant-time compare, wrong-length 401); flood past 30/min → 429"
  status: failed
  reason: "User reported: no-secret and wrong-length POSTs return 500 instead of 401 — web log: 'Telegram Webhook Error: TELEGRAM_WEBHOOK_SECRET is not configured'; rate-limit leg exact (429 from the 31st request)"
  severity: major
  test: 7
  root_cause: "Ops/env regression, not a code defect: the Phase-07 flip launch env contract (.snapshots/0707-prod-worker-env.sh — 14 keys) omits TELEGRAM_WEBHOOK_SECRET, so the web process (restarted through that contract since 2026-09-24) takes the route's DESIGNED loud config-error path (throw → logged 500, fail-closed, body never processed, no chat-binding write). The production mint was operator-attested at 06-05 §12 but the value never entered the 07-era launch env. Code is correct per 06-03 pins (unset→500 loud by design; wrong-secret correct-length→401; limiter-first ladder verified live)."
  artifacts:
    - path: ".snapshots/0707-prod-worker-env.sh"
      issue: "launch env contract missing TELEGRAM_WEBHOOK_SECRET (operator-owned value; §12-attested mint exists operator-side)"
    - path: "src/app/api/telegram/webhook/route.ts"
      issue: "none — behaves exactly as pinned; surfaces the missing config loudly"
  missing:
    - "Operator adds the minted TELEGRAM_WEBHOOK_SECRET to the launch env contract and restarts web (+worker harmless) — then the 401/429 ladder re-verifies green"
    - "Optional hardening: a boot-time env checklist (or healthz posture field) listing required-by-feature env so an omitted secret is visible without a probe"
  debug_session: ""
