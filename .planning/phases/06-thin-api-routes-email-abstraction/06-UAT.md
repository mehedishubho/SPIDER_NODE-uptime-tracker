---
status: partial
phase: 06-thin-api-routes-email-abstraction
source: [06-01-SUMMARY.md, 06-02-SUMMARY.md, 06-03-SUMMARY.md, 06-04-SUMMARY.md, 06-05-SUMMARY.md, 06-VERIFICATION.md]
started: 2026-09-29T22:24:06Z
updated: 2026-09-30T22:15:56Z
---

## Current Test

[testing paused — 7 re-verification items outstanding]

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
resolution: "FIXED by 06-07 Task 1 (commits 2117249 RED + 2b0b218 GREEN): manual non-transition results persist in-job via the §16.2 additive follow-up (manualFlushed, requireActive-guarded). Engine tests 10-12 prove the contract on real PG/Redis (12/12). Source-level fix verified by the 2026-09-30 re-verification (G-06-2 CLOSED); live-worker proof pending the next release rebuild — see Test 19."

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
resolution: "FIXED 2026-10-01: operator set TELEGRAM_WEBHOOK_SECRET in the launch env contract; web restarted through it. Tracked probe (scripts/probe-telegram-webhook-ladder.mjs) recorded the before/after in 06-07-SUMMARY: baseline 500/500/429 → after 401/401/429 + login 200, exit 0. Independently re-run by the 2026-09-30 re-verifier: 401/401/429 exit 0 (G-06-7 CLOSED)."

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

### 19. Live re-run: repeat check-now persists (post-rebuild)
expected: On the live stack, after the next release rebuild + worker restart carries the G-06-2 fix (dist/worker.js beyond sha f71cbdc): repeat check-now on an already-UP monitor → fresh lastChecked > queuedAt within the poll window (no timeout toast). Superseded as source-level proof by engine tests 10-12 (12/12); this is the live-worker confirmation.
result: [pending]

### 20. CR-01 correction-of-record acceptance
expected: Operator acknowledges the record: the gap-closure review's "restore inert in production" premise did NOT reproduce (drizzle's node-postgres session already returns full-µs timestamptz text — fixer proved GREEN-before-fix on real PG); the ::text/::timestamptz fix was retained as a strictly-safer explicit SQL contract, honestly documented in 06-REVIEW-GAPCLOSURE-DISPOSITION.md.
result: [pending]

### 21. Phase mode metadata: Mode mvp with non-User-Story goal (carried)
expected: Decision on the carried metadata discrepancy — ROADMAP declares Mode: mvp but the goal is not User-Story format; verification proceeded standard goal-backward per Phase 3/4/5 precedent.
result: [pending]

### 22. Operator-attested release observables (carried)
expected: Operator re-acknowledges the attested items from the initial round (production mint/setWebhook, soak observations, dead-men quiet) — unchanged from 06-DEPLOY-RECORD.md §12's attestation split.
result: [pending]

### 23. Dashboard check-now UX contract (carried)
expected: Carried manual item — Dashboard check-now button/toast contract observed in the browser (202 → "Checking…" → fresh toast; 429 Retry-After toast; timeout info toast).
result: [pending]

### 24. 06-06 backstop truth: late-delivery race
expected: Backstop-tagged truth — deadline fires but the enqueue add later succeeds (late delivery); planner-tagged verification:backstop with no held-out test; the verifier abstained per the honest-verifier rule. Human acceptance that the bounded late-apply window (monotonic-unique jobIds; tier1 owns the slot write on transitions) is acceptable.
result: [pending]

### 25. Flagged prohibition: no Redis URL in failure logs
expected: Prohibition "no Redis URL in failure logs" (06-06 P3) currently inspection-clean (failure logs carry only literal strings, µs timestamps, error.message) but has no standing test — flagged fail-closed. Recommend a log-content pin in a follow-up; human acceptance of the interim state.
result: [pending]

## Summary

total: 25
passed: 15
issues: 2
pending: 7
skipped: 0
blocked: 1

## Gaps

<!-- YAML format for plan-phase --gaps consumption -->
- gap_id: G-06-2
  status: resolved
  resolved_by: 06-07-PLAN
  resolved_at: 2026-09-30
  truth: "Check-now on an already-UP monitor returns 202 and the fresh result appears via polling within the documented latency (lastChecked > queuedAt, 30s window)"
  reason: "User reported: repeat check-now on an UP monitor times out — 202 body correct, first-check (transition) sub-second, but the repeat manual check persists NOTHING (applied:false, no Tier-2 staging); poll can never complete"
  severity: blocker
  test: 2
  root_cause: "Manual checks were hard-routed to the Tier-1 transition transaction (src/worker/engine/check.ts:263 '|| manual' — Phase-04 design 31bb9b2), and the Tier-1 UPDATE is transition-guarded (src/worker/persist/tier1.ts:196-198 WHERE id = ... AND status <> target AND \"isActive\") — so an UP→UP manual result matched 0 rows: no check row, no lastChecked/responseTime/totalChecks update, and the job never reached the Tier-2 routine-UP staging path."
  resolution: "06-07 Task 1: when a manual job's applyTransition returns applied:false, ONE in-job follow-up runs the §16.2 additive UPDATE (monitorFlushUpdateSql with requireActive) — synchronous per D-01, no status/scheduling writes (Pitfall 8). Engine tests 10-12 (12/12 on real PG/Redis) pin it; re-verification 2026-09-30 CLOSED the gap at source level. Live-worker proof deferred to Test 19 (next release rebuild)."

- gap_id: G-06-7
  status: resolved
  resolved_by: 06-07-PLAN
  resolved_at: 2026-10-01
  truth: "Telegram webhook POST without the correct secret header is refused 401 (constant-time compare, wrong-length 401); flood past 30/min → 429"
  reason: "User reported: no-secret and wrong-length POSTs return 500 instead of 401 — web log: 'TELEGRAM_WEBHOOK_SECRET is not configured'; rate-limit leg exact (429 from the 31st request)"
  severity: major
  test: 7
  root_cause: "Ops/env regression, not a code defect: the Phase-07 flip launch env contract omitted TELEGRAM_WEBHOOK_SECRET, so the route took its designed loud config-error path (fail-closed 500). Code was correct per 06-03 pins."
  resolution: "Operator set the minted secret in .snapshots/0707-prod-worker-env.sh; web restarted through it (0709 script). Tracked probe recorded before 500/500/429 → after 401/401/429 + login 200 (06-07-SUMMARY, verbatim); re-verifier independently re-ran: 401/401/429 exit 0. CLOSED."
