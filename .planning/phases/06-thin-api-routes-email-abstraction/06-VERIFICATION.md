---
phase: 06-thin-api-routes-email-abstraction
verified: 2026-09-20T22:53:09Z
status: gaps_found
score: 10/12 must-haves verified
covered_files:
  - .planning/phases/06-thin-api-routes-email-abstraction/06-01-PLAN.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-01-SUMMARY.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-02-PLAN.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-02-SUMMARY.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-03-PLAN.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-03-SUMMARY.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-04-PLAN.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-04-SUMMARY.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-05-PLAN.md
  - .planning/phases/06-thin-api-routes-email-abstraction/06-05-SUMMARY.md
  - .env.example
  - docs/DEPLOY-RUNBOOK.md
  - playwright.config.ts
  - scripts/check-cron-remnants.mjs
  - scripts/enqueue-maintenance.mjs
  - src/app/api/auth/forgot-password/route.ts
  - src/app/api/auth/register/route.ts
  - src/app/api/monitors/[id]/check/route.ts
  - src/app/api/monitors/[id]/route.ts
  - src/app/api/monitors/route.ts
  - src/app/api/telegram/webhook/route.ts
  - src/components/Dashboard/Dashboard.tsx
  - src/lib/api-error.ts
  - src/lib/check-now-poll.ts
  - src/lib/email/enqueue.ts
  - src/lib/email/index.ts
  - src/lib/email/providers/console.ts
  - src/lib/email/providers/smtp.ts
  - src/lib/email/render.ts
  - src/lib/queue-producer.ts
  - src/lib/rate-limit.ts
  - src/lib/ssrf.ts
  - src/worker/email.ts
  - src/worker/health.ts
  - src/worker/index.ts
  - src/worker/maintenance.ts
  - src/worker/persist/outbox.ts
  - src/worker/queues.ts
  - src/worker/scheduler.ts
  - tests/api/auth-shallow.handler.test.ts
  - tests/api/check-route.handler.test.ts
  - tests/api/cron-and-webhook.handler.test.ts
  - tests/api/monitors-id.handler.test.ts
  - tests/api/monitors.handler.test.ts
  - tests/integration/rate-limit.test.ts
  - tests/lib/check-now-poll.test.ts
  - tests/lib/email-render.test.ts
  - tests/lib/ssrf.test.ts
  - tests/worker/cron-remnant-gate.test.ts
  - tests/worker/email-lane.test.ts
  - tests/worker/email-provider.test.ts
  - tests/worker/enqueue-maintenance-script.test.ts
  - tests/worker/health.test.ts
  - tests/worker/maintenance.test.ts
  - tests/worker/outbox-relay.test.ts
  - tests/worker/scheduler-flag.test.ts
covered_digest: "v1:sha256:7375b948e19cd51d94c2243a87b3eb285bb8eb53e9841df571516f129623600c"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "A failed check-now enqueue never silently delays the monitor's scheduled checking (milestone core value: the monitoring engine must never silently stop checking — API-01/API-02 semantics)"
    status: failed
    reason: "CR-01 (06-REVIEW.md), verified against source: src/app/api/monitors/[id]/check/route.ts commits the one-interval next_check_at advance (lines 87-97, GREATEST form) BEFORE the enqueue (107-111), and the enqueue-failure catch (112-122) returns 503 with NO compensation restore. src/worker/claim.ts:42 claims monitors on next_check_at <= now(), so the committed advance silently skips the monitor's next scheduled check (up to one interval; the GREATEST(now+interval, next_check_at+interval) form compounds by another interval on every user retry the 503 message invites). The legacy force-check never touched scheduling state — this silent-stop path is new with this phase. Impact is bounded and self-heals at the advanced slot, but it is silent and touches the project's #1 binding constraint."
    artifacts:
      - path: src/app/api/monitors/[id]/check/route.ts
        issue: "advance-then-enqueue with no rollback of next_check_at on enqueue failure (lines 87-122)"
    missing:
      - "Compensating restore of the pre-advance next_check_at in the enqueue-failure catch (RETURNING the prior value, restore in catch), OR enqueue-before-advance ordering, OR a single transaction spanning both writes — per 06-REVIEW.md CR-01 fix options"
      - "A test pinning that a rejected enqueue leaves next_check_at unchanged (no existing suite pins the failure path's scheduling side effect)"
  - truth: "With Redis unreachable the enqueue endpoints return 503 in bounded time (no request hang) — API-02 / roadmap SC-2"
    status: partial
    reason: "VERIFIED for actively-refusing Redis (test-pinned 503 in tests/api/check-route.handler.test.ts and tests/api/auth-shallow.handler.test.ts; bounded producer profile maxRetriesPerRequest 1 + 1s connect/command timeouts in src/lib/queue-producer.ts:48-51; register/forgot pre-flight pings precede durable writes). NOT satisfied for the silently-unreachable mode: the phase's own rehearsal diagnosis (deferred-items.md item 3, found during 06-04 leg-a) records that the check-now pre-flight ping (src/lib/queue-producer.ts:65 — bare connection.ping() with no deadline of its own) can hang indefinitely against a never-connectable Redis instead of 503'ing. Deferred as a design change, never fixed in this phase; no test exercises the silent-drop mode."
    artifacts:
      - path: src/lib/queue-producer.ts
        issue: "ping() is a bare connection.ping() — no producer-side deadline covers the connecting/offline-queue state (deferred-items.md item 3)"
    missing:
      - "A short deadline (2-3s) around the producer ping/enqueue mapping to 503, per the candidate fix recorded in deferred-items.md item 3"
      - "A behavioral test for the silently-unreachable (not actively-refusing) Redis mode"
---

# Phase 6: Thin API Routes & Email Abstraction — Verification Report

**Phase Goal:** The web app becomes a stateless producer — routes enqueue and never probe — and transactional email leaves the request path behind a provider interface.
**Verified:** 2026-09-20T22:53:09Z
**Status:** gaps_found (10/12 truths verified; 2 enqueue-path degradation gaps on the check route — one source-verified defect, one phase-diagnosed latent hang left deferred)
**Re-verification:** No — initial verification

> **Verification posture.** Evidence was REPRODUCED wherever the environment allows: the D-41 cron-remnant gate was EXECUTED by this verifier (exit 0, 441 code files across `src`, `dist/worker.js`, `.next/server`, root configs + package.json), and 168 tests across 15 phase-owned vitest suites were RUN on HEAD (test stack already up: spidernode-test-db/redis, healthy — no services started): check-route handler 13, email-lane, check-now-poll 6, cron-and-webhook, ssrf, rate-limit integration 12, auth-shallow 13, email-render (byte-parity), email-provider, monitors.handler, monitors-id.handler, outbox-relay, scheduler-flag, maintenance, enqueue-maintenance-script — **all green (27 + 49 + 92)**. Zero code drift exists since the deletion tree (`git log 51a9fbb..HEAD -- src scripts tests playwright.config.ts package.json .env.example docs` is empty; HEAD 54dc247 is docs-only), so the orchestrator-attested full `pnpm verify` + resilience 7/7 + e2e 18/18 results remain valid for this tree. The two Critical findings from 06-REVIEW.md were both checked against source: CR-01 confirmed, CR-02's irrecoverability claim REFUTED (see Critical Findings Assessment). `gsd-tools query verify.artifacts` returned 0/0-unparseable for these plans' plain-path `artifacts:` lists — all artifact checks below are manual three-level checks instead.

> **MVP-mode note.** ROADMAP.md declares `Mode: mvp` for this phase, but the goal is not in User Story format (`user-story.validate` → false). Per the Phase 3/4/5 precedent recorded in 05-VERIFICATION.md, verification proceeded **standard goal-backward** against the roadmap success criteria; no User Flow Coverage section was fabricated against a non-user-story goal. The metadata discrepancy is routed to human decision (Human Verification item 1).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | "Check now" returns 202 {jobId, queuedAt} immediately and the fresh result appears via polling; no API route ever executes a check against a target (SC-1, API-01) | ✓ VERIFIED | Route source: admission ladder → advance → `enqueueManualCheck` → 202; zero target-dialing code (only Redis enqueue). Behavioral: check-route handler 13/13 (202 body, never-touches-raw-queue pin), check-now-poll 6/6; Dashboard wired (Dashboard.tsx:200-231 → POST → pollMonitorCheckResult → toasts) |
| 2 | Inactive/paused monitor gets the legacy success-shaped 200 mirror with empty result, no enqueue, limiter not consumed (D-28) | ✓ VERIFIED | route.ts:50-55; pinned in the check-route suite (ran green) |
| 3 | With Redis unreachable the enqueue endpoints return 503 in bounded time (no request hang) (SC-2, API-02) | ⚠️ PARTIAL → gap | Active-refusal mode: VERIFIED (bounded producer profile queue-producer.ts:48-51; check-route 503 pinned; register/forgot pre-flight ping BEFORE durable writes — register/route.ts:22-26, forgot-password/route.ts:15-19; auth-shallow 13/13). Silent-unreachable mode: phase's own rehearsal diagnosis (deferred-items.md item 3) records the pre-flight ping can hang indefinitely; deferred unfixed, untested |
| 4 | A user over a per-user enqueue limit is rejected with 429 + numeric Retry-After (SC-2, SEC-05, D-06) | ✓ VERIFIED | route.ts:60-78 (two buckets, first-failing bucket's resetSeconds); rate-limit integration 12/12 incl. real-Redis key checks; Dashboard reads Retry-After into the toast |
| 5 | A Telegram webhook POST without the correct secret header is refused — constant-time compare behind a length guard; unset env fails loud 500, never accept (SC-2, SEC-03, D-20) | ✓ VERIFIED | webhook/route.ts:29-42 (`secretMatches`: length guard → `timingSafeEqual`; unset → throw → 500), per-IP 30/min limiter first (lines 51-56); cron-and-webhook suite green |
| 6 | No endpoint accepts a secret via query string; no `CRON_SECRET` reference remains; error responses never leak stack traces (SC-3, SEC-06) | ✓ VERIFIED | grep: zero query-string secret reads in src/app/api; gate probe PASS (441 files — src, build artifacts, root configs, package.json); production 404s machine-verified (06-DEPLOY-RECORD.md §13:429,461); `apiError` fixed-string bodies, no `error.message` leaks found. Warning: 3 inert CRON_SECRET refs in retained `scripts/rehearse-cutover.mjs` (throwaway value, Phase-5 rehearsal choreography; documented out-of-scope retention in 06-PIN-INVENTORY.md:61; gate does not scan scripts/) |
| 7 | With SMTP down, registration still completes and the verification email arrives once SMTP recovers — queued, exact 30s/2m/8m/30m/2h backoff (SC-4, EML-02, D-09) | ✓ VERIFIED | register 201 + render-at-enqueue (nodemailer only under src/lib/email/providers + worker — grep); `EMAIL_BACKOFF_MS = [30000,120000,480000,1800000,7200000]` wired as `settings.backoffStrategy` (queues.ts:592-619); email-lane suite green (exact table + wiring pins) |
| 8 | A permanently undeliverable address stops retrying via a typed unrecoverable error (SC-4, EML-03) | ✓ VERIFIED | worker/email.ts: EAUTH/EENVELOPE/EMESSAGE/responseCode>=500 → `UnrecoverableError` + failure counter + error log; observed live in this verification's run (dead-letter log lines emitted during the email-lane suite) |
| 9 | The existing HTML template renders unchanged from its new location (SC-4, EML-05) | ✓ VERIFIED | render.ts relocated byte-verbatim; byte-parity suite vs frozen oracle fixtures green (run in the 92-test batch) |
| 10 | Provider interface with env-selected providers: smtp default, console opt-in, unknown value throws at worker boot (EML-01, D-11/D-12) | ✓ VERIFIED | lib/email/index.ts:43-55 matrix; email-provider suite green (ran); no custom jobId on email jobs (enqueue.ts:14) |
| 11 | next_check_at advances one interval atomically at enqueue so a scheduler tick cannot double-claim (Pitfall 8) | ✓ VERIFIED | route.ts:87-97 GREATEST form with ownership+isActive restated in WHERE; advance-before-enqueue ordering pinned via invocationCallOrder in the check-route suite (ran green). The advance's FAILURE-path side effect is gap 1 below |
| 12 | A failed check-now enqueue never silently delays the monitor's scheduled checking (milestone core value: never silently stop checking) | ✗ FAILED | **Gap 1 (CR-01, source-verified):** advance commits (route.ts:87-97) before enqueue (107-111); failure catch (112-122) returns 503 with no compensation; claim.ts:42 claims on `next_check_at <= now()`; GREATEST form compounds per retry. See gaps frontmatter |

**Score:** 10/12 truths verified (0 present-but-behavior-unverified; 1 partial, 1 failed — both on the check route's enqueue-failure path)

### Critical Findings Assessment (06-REVIEW.md, both verified against source)

**CR-01 (check-route advance-then-enqueue, no compensation) — CONFIRMED, graded a gap.**
The review's claim chain is mechanically accurate: (a) the advance UPDATE commits at route.ts:87-97 before the enqueue at 107-111; (b) the catch at 112-122 returns 503 with no restore; (c) `src/worker/claim.ts:42` claims on `next_check_at IS NULL OR next_check_at <= now()`, so the committed advance silently postpones the next scheduled claim by up to one interval; (d) the `GREATEST(now()+interval, next_check_at+interval)` form pushes the slot out another interval on each retried attempt. The legacy force-check never touched scheduling state — this silent-stop path is introduced by this phase. Bounded (self-heals at the advanced slot; no data corruption), but silent and adverse to the milestone's #1 binding constraint ("the monitoring engine must never … silently stop checking"). Graded BLOCKER by the in-repo review; graded a gap here.

**CR-02 (register create-before-enqueue lockout) — mechanism CONFIRMED, irrecoverability claim REFUTED, downgraded to warning.**
Accurate parts: the user is created (register/route.ts:72-85) before the enqueue (94); on enqueue rejection the route returns 503 with the user durable; retry registration hits 409 (lines 63-68); credentials login refuses unverified users (src/lib/auth.ts:47). **The review's central claim is wrong:** it asserted no recovery path exists ("a password-reset email is not a verification email, so the pointed recovery does not unstrand the account … nothing in the reviewed files supports"). `src/app/api/auth/reset-password/route.ts:38-44` — a file outside the review's 49-file set — sets `emailVerified: new Date()` when the reset completes. The documented recovery in the route's own header comment (forgot-password → fresh email → reset → login) therefore genuinely unstrands the account, self-service, with no DB intervention. Residual (warning-level, not a never-lock-out violation): the stranded user receives a password-reset template rather than a verification email, the recovery UX is indirect, and the narrow ping→add race window is accepted-and-documented by design. No gap entry; recommend fixing the comment and/or adding a resend-verification path in a later phase.

### Deferred Items

None — no failed/partial item is covered by a later phase's goal or success criteria (Phase 7 is auth cutover; Phase 8 is flags/UI; neither names the check-route enqueue failure path).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/lib/queue-producer.ts` | Bounded web producer (checks+email queues) | ✓ VERIFIED | exists, substantive, wired (check route + register + forgot); bounded profile lines 48-51; ping() deadline gap noted in gap 2 |
| `src/lib/api-error.ts` | Uniform leak-proof `{error}` helper | ✓ VERIFIED | exists; adopted across touched routes (grep) |
| `src/lib/check-now-poll.ts` | Abortable 2s/30s poll over monitor reads | ✓ VERIFIED | exists; deadline/abort/null semantics at lines 53-67; suite 6/6 green (ran); wired from Dashboard |
| `src/app/api/monitors/[id]/check/route.ts` | Stateless producer route (202) | ✓ VERIFIED (with gap 1 on failure path) | rewritten; ladder + advance + enqueue + 202; never dials target |
| `src/lib/rate-limit.ts` | TTL/Retry-After extension, atomic Lua | ✓ VERIFIED | INCR+EXPIRE+PTTL single script; resetSeconds; integration suite 12/12 (ran) |
| `src/lib/email/index.ts` + `render.ts` + `enqueue.ts` + `providers/{smtp,console}.ts` | Provider interface, byte-verbatim render, enqueue door | ✓ VERIFIED | all exist; D-11 matrix; byte-parity suite green (ran); nodemailer confined to providers |
| `src/worker/email.ts` | processEmailJob with typed split | ✓ VERIFIED | exists; dead-lettering observed live during this verification |
| `src/worker/queues.ts` | Email lane, D-09 table, backoffStrategy | ✓ VERIFIED | lines 592-619; email-lane suite green (ran) |
| `src/app/api/auth/register/route.ts` + `forgot-password/route.ts` | Enqueue + 503 pre-flight; 200-neutral forgot | ✓ VERIFIED | read in full; auth-shallow 13/13 (ran) |
| `src/app/api/telegram/webhook/route.ts` | Secret-token auth ladder | ✓ VERIFIED | read in full; cron-and-webhook suite green (ran) |
| `src/lib/ssrf.ts` + monitors routes | DNS-only admission (assertUrlAllowed) | ✓ VERIFIED | wired at POST:95 and PATCH:107 (conditional per D-25); ssrf + monitors suites green (ran) |
| `src/worker/persist/outbox.ts` | HTML-escaped alert renders | ✓ VERIFIED | escapeHtml at all 6 interpolation sites (lines 151-171); outbox-relay suite green (ran) |
| `src/worker/scheduler.ts` + `maintenance.ts` + `scripts/enqueue-maintenance.mjs` | Real deletes dryRun:false + count logging; bounded script | ✓ VERIFIED | scheduler-flag + maintenance + script suites green (ran) |
| `scripts/check-cron-remnants.mjs` | Extended D-41/D-27 gate, wired into verify | ✓ VERIFIED | EXECUTED by this verifier: exit 0, 441 files; `cron:remnants` is the final `pnpm verify` leg (package.json:22) |
| Deletions: `src/app/api/cron/{check,cleanup}/route.ts`, `cron-logic.ts`, `db-batcher.ts`, `cleanup-logic.ts`, `mail.ts`, playwright CRON_MODE writer, CRON_SECRET env | All gone | ✓ VERIFIED | all absent from tree; no `src/app/api/cron` directory; `.env.example` clean (TELEGRAM_WEBHOOK_SECRET + EMAIL_PROVIDER present instead); `src/instrumentation.ts` also absent (retired in Phase 5, gate-enforced) |
| `.planning/.../06-PIN-INVENTORY.md` | 15 deleted-pin rows mapped to successors | ✓ VERIFIED | exists, 28 table rows incl. the retention note for `scripts/rehearse-cutover.mjs` |
| `.planning/.../06-DEPLOY-RECORD.md` §10–§13 | Soak + cutover + deletion evidence | ✓ VERIFIED | sections present and substantive: §10 soak opened (31a56df), §11-§12 Task-1 cutover/approval with machine-verified vs operator-attested split, §13 deletion deploy + smoke (404s, 202+poll, registration render, queue drain) + RECORD CLOSED |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| check route | checks queue lane | `enqueueManualCheck(monitorId, { checksQueue: webQueueProducer().checks })` | ✓ WIRED | route.ts:108-110; priority-1 lane; jobId `check-manual:{id}:{epochMs}` pattern pinned in suite |
| check route | drizzle db | one-interval advance (GREATEST, mirrors claim.ts) | ✓ WIRED | route.ts:87-97 |
| Dashboard | poll module | `pollMonitorCheckResult({ fetchMonitors, signal })` | ✓ WIRED | Dashboard.tsx:219-224; completion `lastChecked > queuedAt`; give-up → info toast, never error/re-enqueue (D-04) |
| register/forgot | render → enqueue → email lane | `renderVerificationEmail`/`renderPasswordResetEmail` → `enqueueTransactionalEmail` | ✓ WIRED | both routes read in full; render-at-enqueue (D-07); auth-shallow suite green |
| worker boot | email provider | `startEmailLaneWorker` → `getEmailProvider()` → smtp\|console | ✓ WIRED | queues.ts:608-619 + index.ts:43-55 |
| webhook POST | secretMatches → limiter | header read → length guard → timingSafeEqual | ✓ WIRED | webhook/route.ts:51-61 |
| monitors POST/PATCH | assertUrlAllowed | DNS-only admission on trimmed url | ✓ WIRED | monitors/route.ts:95; monitors/[id]/route.ts:107 (url-branch only, D-25) |
| outbox renderAlertMessage | escape helper | `escapeHtml` at 6 interpolation sites | ✓ WIRED | outbox.ts:151-171 |
| remnant gate | pnpm verify | `cron:remnants` leg | ✓ WIRED | package.json:22 (final leg of verify chain) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| check route 202 body | jobId, queuedAt | real BullMQ `add()` + pre-enqueue clock | Yes | ✓ FLOWING |
| Dashboard toasts | monitor status/responseTime | `fetchMonitors()` real API read | Yes | ✓ FLOWING |
| register/forgot 503 | pre-flight `ping()` result | real Redis connection | Yes | ✓ FLOWING (active-refusal mode) |
| email payloads | {to, subject, html} | real render from request data + tokens | Yes | ✓ FLOWING |
| deletion 404s | production route absence | live smoke probes (§13, machine-verified) | Yes | ✓ FLOWING |

No hardcoded-empty or mock-fed render paths found in phase artifacts.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Check-route admission ladder (202/401/404/400/D-28/429+Retry-After/advance-before-enqueue/503) | `pnpm exec vitest run tests/api/check-route.handler.test.ts` | 13/13 pass (1.87s batch) | ✓ PASS |
| Email lane D-09 table + EML-03 dead-lettering + WR-02 teardown | `pnpm exec vitest run tests/worker/email-lane.test.ts` | green; live dead-letter log lines observed | ✓ PASS |
| Poll give-up/abort/deadline | `tests/lib/check-now-poll.test.ts` | 6/6 pass | ✓ PASS |
| Webhook refusal ladder + SSRF admission + limiter Retry-After/spoof trio | `tests/api/cron-and-webhook.handler.test.ts` + `tests/lib/ssrf.test.ts` + `tests/integration/rate-limit.test.ts` | 49/49 pass (4.82s batch) | ✓ PASS |
| Register/forgot enqueue contract + byte-parity render + provider matrix + monitors D-17 + outbox escape + retention/scheduler/script | 9 named suites (auth-shallow, email-render, email-provider, monitors.handler, monitors-id.handler, outbox-relay, scheduler-flag, maintenance, enqueue-maintenance-script) | 92/92 pass (26.35s) | ✓ PASS |
| Cron remnant gate | `node scripts/check-cron-remnants.mjs` | exit 0, 441 files, no remnants | ✓ PASS |

Total this verification: 168 tests across 15 phase-owned suites, all green on HEAD; no services started (test stack was already up).

### Probe Execution

| Probe | Command | Result | Status |
| ----- | ------- | ------ | ------ |
| `scripts/check-cron-remnants.mjs` (D-41/D-27 extended gate) | `node scripts/check-cron-remnants.mjs` | exit 0 — 441 code files scanned across src, dist/worker.js, .next/server, playwright.config.ts, next.config.ts, ecosystem.config.js (+ package.json); no cron remnants | PASS |

Full `pnpm verify` / `pnpm test:resilience` / e2e were NOT re-run in full by this verifier (orchestrator-attested green as of the deletion tree; zero code drift since — verified via `git log 51a9fbb..HEAD`). The vitest forks-pool crash flake (documented pre-existing, deferred-items.md) can drop ~1 file per ~3 full-suite runs; all targeted suites here passed outright.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| API-01 | 06-01, 06-04 | Manual check = enqueue + 202 + optimistic read + poll; routes never execute checks | ✓ SATISFIED | truth 1 (gap 1 concerns the failure path's side effect, not the enqueue contract itself) |
| API-02 | 06-01, 06-02, 06-04 | Enqueue fails loudly (503) when Redis unreachable — never silently no-ops | ⚠️ PARTIAL | active-refusal mode verified; silent-unreachable hang documented deferred (gap 2) |
| SEC-03 | 06-03, 06-04 | Webhook authenticated via X-Telegram-Bot-Api-Secret-Token | ✓ SATISFIED | truth 5 |
| SEC-05 | 06-01 | Per-user enqueue rate limiter on manual-check endpoint | ✓ SATISFIED | truth 4 |
| SEC-06 | 06-05 | No secret via query string; CRON_SECRET retires with cron endpoints | ✓ SATISFIED | truth 6 (warning: inert refs in retained rehearsal script) |
| EML-01 | 06-02 | Provider interface, env-selected smtp/console | ✓ SATISFIED | truth 10 |
| EML-02 | 06-02, 06-04 | Email off request path via queue; registration succeeds when SMTP down | ✓ SATISFIED | truth 7 |
| EML-03 | 06-02 | Typed retryable-vs-permanent; hopeless sends don't retry | ✓ SATISFIED | truth 8 |
| EML-05 | 06-02 | HTML template preserved verbatim through relocation | ✓ SATISFIED | truth 9 |

All 9 requirement IDs mapped to Phase 6 in REQUIREMENTS.md (lines 258-266) are claimed across the five plans' `requirements:` frontmatter; no orphaned requirements. All are marked Complete in REQUIREMENTS.md.

### Test Quality Audit

| Test File | Linked Req | Active | Skipped | Circular | Assertion Level | Verdict |
| --------- | ---------- | ------ | ------- | -------- | --------------- | ------- |
| tests/api/check-route.handler.test.ts | API-01/02, SEC-05 | 13 | 0 | none | Behavioral (order, body shape, 503/429) | SUFFICIENT |
| tests/lib/check-now-poll.test.ts | API-01 (D-01..D-04) | 6 | 0 | none | Behavioral (fake-timer transitions) | SUFFICIENT |
| tests/api/auth-shallow.handler.test.ts | EML-02, API-02 | 13 | 0 | none | Behavioral (503-before-create, enqueue counts) | SUFFICIENT |
| tests/worker/email-lane.test.ts | EML-02/03 | green | 0 | none | Value/behavioral (exact ms table, error matrix) | SUFFICIENT |
| tests/lib/email-render.test.ts | EML-05 | green | 0 | none | Value (byte-parity vs frozen oracle — provenance VALID: oracle was the pre-migration module, frozen before rewrite) | SUFFICIENT |
| tests/api/cron-and-webhook.handler.test.ts | SEC-03 | green | 0 | none | Behavioral (refusal ladder) | SUFFICIENT |
| tests/integration/rate-limit.test.ts | SEC-05 | 12 | 0 | none | Value (real Redis keys, resetSeconds countdown) | SUFFICIENT |
| tests/lib/ssrf.test.ts + monitors suites | SEC-03/D-23 | green | 0 | none | Behavioral (fail-closed 500, escaped 400) | SUFFICIENT |
| tests/worker/enqueue-maintenance-script.test.ts | API-02/WR-01 | green | 0 | none | Behavioral (bounded non-zero exit) | SUFFICIENT |
| tests/worker/build-gate.test.ts | WRK-14 (not phase req) | partial | conditional `it.skip` when dist/ absent | none | Existence+boundary | ACCEPTABLE — documented pre-build skip; dist/worker.js exists on this tree and the gate asserts it for real during verify |

**Disabled tests on requirements:** 0 (the one conditional skip is environment-guarded, named, and not the sole proof of any phase requirement)
**Circular patterns detected:** 0
**Insufficient assertions:** 0

### Decision Coverage

All trackable CONTEXT.md decisions are honored by shipped artifacts: 34/34 honored, 0 not honored (gsd-tools check.decision-coverage-verify).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| src/app/api/monitors/[id]/check/route.ts | 87-122 | failure path leaves committed state advance unreversed (CR-01) | 🛑 Blocker | gap 1 — silent one-interval scheduled-check delay, compounding on retry |
| src/lib/queue-producer.ts | 65 | producer ping with no own deadline (deferred-items item 3) | ⚠️ Warning | gap 2 — possible hang vs 503 in silent-unreachable mode |
| scripts/rehearse-cutover.mjs | 169, 967, 1753 | retired CRON_SECRET token references (throwaway value, retained Phase-5 rehearsal choreography) | ⚠️ Warning | none at runtime (routes deleted; value throwaway); gate does not scan scripts/; retention documented in 06-PIN-INVENTORY.md:61 — consider deleting the throwaway leg or extending the gate scope |
| src/app/api/auth/register/route.ts | 16-21 | recovery comment imprecise (recovery works, but via the reset-password flow flipping emailVerified, not a re-sent verification email) | ⚠️ Warning | UX indirection only — see CR-02 assessment |
| src/components/Dashboard/Dashboard.tsx | 190-203 | concurrent check-now polls: only latest AbortController aborted on unmount (review WR-01, spot-corroborated) | ℹ️ Info | stale poll loop can run to its 30s deadline after unmount in a two-click window |
| src/components/Dashboard/Dashboard.tsx | 218-231 | inactive-monitor legacy 200 (no queuedAt) triggers a futile 30s poll (review WR-02, spot-corroborated; mitigated by disabled button) | ℹ️ Info | misleading "still checking" toast on stale isActive |
| 06-REVIEW.md WR-03/WR-04/WR-05, IN-01..IN-06 | — | review warnings/info (NEXTAUTH_URL unvalidated, parseInt interval, timing side-channel, webhook 500-on-unknown-id, stale db comment, metrics seam, count-then-create, `::` denylist, dead details branch) | ℹ️ Info | carried in 06-REVIEW.md; none is a phase must-have failure |

Debt-marker gate: zero TBD/FIXME/XXX markers in any phase-modified file. "placeholder" hits are HTML input attributes (legitimate UI).

### Human Verification Required

### 1. Phase mode metadata: `Mode: mvp` with a non-User-Story goal

**Test:** Decide the roadmap metadata for this phase: either reformat the goal via `/gsd mvp-phase 6` into User Story form, or drop the `Mode: mvp` tag for Phase 6 (Phase 3 dropped its tag; Phases 4 and 5 recorded the same finding).
**Expected:** Roadmap mode and goal format agree, so a future re-verification can correctly choose MVP User Flow Coverage or standard goal-backward framing.
**Why human:** Metadata preference only — affects future MVP-mode UAT framing; no codebase truth. Verification proceeded standard goal-backward per the Phase 2/3/4/5 precedent.

### 2. Operator-attested (not machine-verified) release observables

**Test:** Confirm operator-side: the real Telegram webhook accepts updates under the registered production `secret_token` (setWebhook ran with the operator-minted secret); dead-man dashboards (healthchecks.io) stayed quiet through the cutover/deletion window; the Vercel-cron dashboard confirmation (no external cron calling /api/cron/*) is true; the D-31 soak criteria #1-#4 (real-user check-now, real registration delivery, retention-count observation, dead-men quiet) were observed during the elected window.
**Expected:** All confirmed, consistent with 06-DEPLOY-RECORD.md §12's machine-verified vs operator-attested split and the bare-approval record.
**Why human:** These live outside the repo's reachable topology (Telegram's side, external dashboards, the soak window clock); only attestation exists.

### 3. Dashboard check-now UX contract

**Test:** In a browser: click re-check on a monitor → observe "Checking…" button state; result toasts UP (success) / DOWN (error) with name + response time; trigger a rate-limited second click → "You're checking too often — try again in Ns"; let a poll hit 30s → info toast "Still checking…", never an error toast, no auto re-enqueue.
**Expected:** Matches UI-SPEC copy contract (D-01..D-04) as pinned by tests.
**Why human:** Toast copy/visual behavior is user-perceived; the e2e suite covers mechanics (18/18 attested) but not perceived UX quality.

### Gaps Summary

The phase's headline transformation is real and behaviorally proven: routes enqueue and never probe (202 + poll, verified green across 168 tests this verification ran), email is off the request path behind a provider interface with the exact D-09 backoff and typed dead-lettering (observed live), the webhook is secret-enforced, SSRF admission is wired, the legacy cron path is deleted with a green, verify-wired remnant gate, and the deletion release carries machine-verified production 404s. All 9 requirements are satisfied at their letter except the failure-path qualifier of API-02.

Two gaps remain, both on the check route's enqueue-failure path — the one path the milestone's core constraint ("never silently stop checking") cares most about:

1. **Failed-enqueue scheduling side effect (CR-01, gap 1, FAILED).** The one-interval `next_check_at` advance commits before the enqueue and is never restored on enqueue failure; `claim.ts` claims on `next_check_at <= now()`, so each failed attempt (and each invited retry) silently postpones the monitor's next scheduled check. The legacy force-check never touched scheduling state. Fix is small and well-specified (compensating restore via RETURNING, or reorder, or single transaction) and needs one new failure-path pin.
2. **Silent-unreachable Redis hang (gap 2, PARTIAL).** The 503-bounded degradation is test-proven for actively-refusing Redis but the phase's own rehearsal diagnosis records that a never-connectable Redis can hang the pre-flight ping indefinitely (no producer-side deadline); it was deferred as a design change and never fixed or tested.

CR-02 from the code review was investigated and **downgraded**: its irrecoverable-lockout claim is factually wrong — `src/app/api/auth/reset-password/route.ts:42` flips `emailVerified` on reset completion, so the stranded unverified account is self-service recoverable through forgot-password → reset → login. What remains is a comment/UX wart (warning).

If the developer consciously accepts the bounded one-interval delay of gap 1 as tolerable (and the deferred hang of gap 2), the alternative to a closure plan is overrides in this file's frontmatter — but given both sit on the milestone's most protected semantics and both fixes are small, a `/gsd-plan-phase --gaps` closure round is the recommended route.

---

_Verified: 2026-09-20T22:53:09Z_
_Verifier: Claude (gsd-verifier)_
