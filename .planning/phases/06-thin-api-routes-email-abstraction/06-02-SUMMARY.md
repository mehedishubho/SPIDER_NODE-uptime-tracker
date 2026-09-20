---
phase: 06
plan: 02
subsystem: email-queue
tags: [email, bullmq, worker, api-routes, backoff, resilience]
requires:
  - 06-01 (webQueueProducer bounded producer, apiError, check-now poll slice)
provides:
  - "src/lib/email/* — EmailProvider interface, byte-verbatim render, enqueue door (EMAIL_JOB_OPTIONS)"
  - "src/worker/email.ts — processEmailJob with EML-03 typed error split"
  - "email lane worker with exact D-09 backoff table (EMAIL_BACKOFF_MS + settings.backoffStrategy)"
  - "queue-backed register + forgot-password routes with 503 degradation"
  - "@/lib/mail now importer-free in src/app (deletion lands in 06-05)"
affects:
  - src/worker/index.ts (email lane wiring, WR-02 teardown, IN-01 health port)
  - src/worker/health.ts (shared resolveWorkerHealthPort)
  - src/worker/queues.ts (email lane + failure counter)
tech-stack:
  added: []
  patterns:
    - "render-at-enqueue / transport-in-worker (D-07) — self-contained {to,subject,html} payloads"
    - "BullMQ settings.backoffStrategy custom table (Pitfall 2 — built-in exponential fails D-09 reach)"
    - "pre-flight producer ping -> 503 before durable writes (D-29 / Pitfall 6)"
    - "typed permanent/transient SMTP error split (EML-03, research A1 conservative taxonomy)"
key-files:
  created:
    - src/lib/email/index.ts
    - src/lib/email/render.ts
    - src/lib/email/enqueue.ts
    - src/lib/email/providers/smtp.ts
    - src/lib/email/providers/console.ts
    - src/worker/email.ts
    - tests/lib/email-render.test.ts
    - tests/worker/email-provider.test.ts
    - tests/worker/email-lane.test.ts
  modified:
    - src/worker/queues.ts
    - src/worker/index.ts
    - src/worker/health.ts
    - src/app/api/auth/register/route.ts
    - src/app/api/auth/forgot-password/route.ts
    - tests/worker/health.test.ts
    - tests/api/auth-shallow.handler.test.ts
decisions:
  - "D-09 backoff via Worker settings.backoffStrategy + job backoff {type:\"custom\"} — exact table [30s,2m,8m,30m,2h], never BullMQ exponential (Pitfall 2)"
  - "EML-03 conservative taxonomy: only EAUTH/EENVELOPE/EMESSAGE/responseCode>=500 dead-letter via UnrecoverableError; everything else (timeouts, 4xx, unknown) retries (A1)"
  - "Pre-flight ping placed at the very top of both routes — BEFORE the Redis-backed limiter — so a Redis outage yields the bounded 503 rather than a limiter error path"
  - "EMAIL_JOB_OPTIONS lives only in src/lib/email/enqueue.ts — NO re-export from queues.ts (module-scope cycle, see Deviation 1)"
metrics:
  duration: 26 min
  completed: 2026-09-20
status: complete
---

# Phase 6 Plan 2: Email Queue Slice Summary

Off-request transactional email: byte-verbatim template relocation behind a provider interface (smtp/console per D-11), an email-lane worker with the exact D-09 retry table (30s/2m/8m/30m/2h) and conservative typed error split, plus queue-backed register and forgot-password routes with bounded pre-flight pings, a 5/h forgot limiter, and the 200-neutral anti-enumeration body preserved verbatim.

## What Was Built

### Task 1 — Provider interface, byte-verbatim render, enqueue helper (EML-01/EML-05)

- `src/lib/email/index.ts` — `EmailProvider` interface (`name` + `send(payload)`) and `getEmailProvider()` implementing the D-11 matrix: unset/empty/"smtp" -> smtp, "console" -> console dump, anything else throws at call time (worker boot) with the value named.
- `src/lib/email/render.ts` — `generateEmailTemplate` + `renderVerificationEmail`/`renderPasswordResetEmail` relocated BYTE-VERBATIM from `src/lib/mail.ts` (oracle capture frozen as fixtures; byte-parity proven programmatically, CRLF-on-disk vs LF-at-transform normalized). Only delta: functions RETURN `{to, subject, html}` instead of sending; the `from` header moved into the smtp provider.
- `src/lib/email/providers/smtp.ts` — lazy transporter (created on first send), identical host/port/secure/auth config, `from: "SpiderNode" <SMTP_USER>`.
- `src/lib/email/providers/console.ts` — ONE structured stdout line `[email-console] {to,subject,html}` (JSON-escaped newlines keep it single-line).
- `src/lib/email/enqueue.ts` — `enqueueTransactionalEmail(payload, deps?)` over `webQueueProducer().email`; `EMAIL_JOB_OPTIONS`: priority `LANE_PRIORITY.email`, attempts 5, `backoff {type:"custom"}`, removeOnComplete 1h / removeOnFail 14d. NO jobId ever (Pitfall 3).
- Tests: `tests/lib/email-render.test.ts` (byte-parity vs frozen oracle fixtures, link forms, from-header payload, lazy transporter, exact transporter option keys), `tests/worker/email-provider.test.ts` (D-11 matrix, console one-line dump, enqueue contract incl. no-jobId, add() rejection propagation).

### Task 2 — Email lane worker: exact D-09 table, typed split, WR-02/IN-01 (EML-02/EML-03)

- `src/worker/queues.ts` — `EMAIL_BACKOFF_MS = [30_000, 120_000, 480_000, 1_800_000, 7_200_000]` with clamped `emailBackoffDelay(attemptsMade)` resolver; `startEmailLaneWorker` wires it as `settings.backoffStrategy` (the ONE lane-family deviation — email jobs use `backoff {type:"custom"}`; BullMQ's built-in exponential yields 30s/1m/2m/4m/8m and fails the hour-or-two SMTP-outage reach, Pitfall 2), concurrency 1, lane stalled config (lockDuration/stalledInterval 30s, maxStalledCount 1). Plus `emailFailures` in-process counter (`stalledEvents` precedent, D-34).
- `src/worker/email.ts` — `processEmailJob(job, deps?)`: name/payload contract validation dead-letters via `UnrecoverableError` (can never succeed on retry) without calling send; EML-03 A1 split — `EAUTH`/`EENVELOPE`/`EMESSAGE`/`responseCode>=500` -> `UnrecoverableError` + failure counter + error-level log; timeouts/socket/4xx/unknown rethrow the ORIGINAL error for D-09 retry. Injectable provider/logger.
- `src/worker/index.ts` — email lane wired like its siblings + `registerDrainable`; `drainAndTeardown` now also calls `disposeRelayRedis()` (WR-02, before pool end — queueing resources down before persistence); health port via the shared resolver.
- `src/worker/health.ts` — exported `resolveWorkerHealthPort`: empty-string/unset WORKER_HEALTH_PORT -> 9090 (never `Number("") === 0` ephemeral port, IN-01); used by both health.ts option resolution and index.ts boot.
- Tests: `tests/worker/email-lane.test.ts` (exact table values, identity wiring of `settings.backoffStrategy`, happy path, both error directions across the full code matrix, malformed payload, WR-02 teardown with planted relay singleton, monotonic counter); `tests/worker/health.test.ts` extended with the IN-01 resolution + empty-string integration case.

### Task 3 — Route integration: register + forgot-password enqueue with 503 degradation

- `src/app/api/auth/register/route.ts` — bounded `webQueueProducer().ping()` at the top (before the Redis-backed limiter): failure -> 503 `Service temporarily unavailable — try again shortly` BEFORE `prisma.user.create` (no stranded unverifiable account, Pitfall 6; residual ping->add race accepted and documented in a code comment). `sendVerificationEmail` replaced by `renderVerificationEmail` + `enqueueTransactionalEmail`; enqueue rejection after create -> 503; 201 body byte-identical; `apiError` adopted on touched paths (D-32).
- `src/app/api/auth/forgot-password/route.ts` — same ping pre-flight -> 503; `forgot_{ip}` 5/h limiter above the body parse (register parity, D-21); `renderPasswordResetEmail` + enqueue with rejection-after-token-write accepted (idempotent re-request) but loud 503; the 200-neutral `{ success: "Reset email sent!" }` anti-enumeration body preserved VERBATIM (T-06-02-01).
- `src/app` no longer imports `@/lib/mail` anywhere (gate verified; the module's file deletion happens in 06-05).
- Tests (`tests/api/auth-shallow.handler.test.ts`): producer mocked via `vi.hoisted` (ping + email.add); `@/lib/mail` kept as a must-NOT-fire tripwire; NEXTAUTH_URL pinned for deterministic render. New pins: register ping-reject 503-before-create, register happy 201 + exactly-one rendered enqueue (the old mail pin flipped per Pitfall 7 — body pins untouched), register enqueue-reject-after-create 503; forgot 400 preserved, forgot 429 limiter, forgot 200-neutral-not-found with zero enqueues, forgot happy one-enqueue, forgot ping 503.

## Commits

| Task | Type | Hash | Subject |
| ---- | ---- | ---- | ------- |
| 1 | test (RED) | d1a7576 | pin email render byte-parity, provider matrix, console dump, enqueue contract |
| 1 | feat (GREEN) | 6ff8c29 | lib/email module — provider interface, byte-verbatim render, enqueue helper |
| 2 | test (RED) | c623e4d | pin email-lane backoff table, typed error split, WR-02 teardown, IN-01 port guard |
| 2 | feat (GREEN) | 25c7e97 | email lane worker — D-09 backoff table, EML-03 typed split, WR-02/IN-01 |
| 3 | test (RED) | 523877b | pin route enqueue contract — 503 degradation, forgot limiter, zero mail calls |
| 3 | feat (GREEN) | d014f71 | queue-backed register + forgot-password — ping pre-flight, 503 degradation |

## Verification Results

- `pnpm exec vitest run tests/worker/email-lane.test.ts tests/worker/health.test.ts` — 23 passed.
- `pnpm exec vitest run tests/api/auth-shallow.handler.test.ts` — 13 passed (6 new/changed pins RED before implementation, GREEN after).
- Full `pnpm test` — 40 files, 355 tests, ALL PASSED (the previously documented forks-pool worker-crash flake did not occur this run).
- `pnpm typecheck` — clean.
- `pnpm lint` — 0 errors, 60 warnings (all pre-existing unused-var warnings, out of scope).
- `pnpm worker:boundary` — green (18 files, no next/react/@app imports; the web->worker pure-export imports pass by design).
- Mail-import gate: zero `@/lib/mail` matches under `src/app` (see Deviation 3 for the tool substitution).

## TDD Gate Compliance

All three tasks followed RED -> GREEN with per-task commits:

1. `test(06-02)` d1a7576 precedes `feat(06-02)` 6ff8c29 (RED run failed against absent modules).
2. `test(06-02)` c623e4d precedes `feat(06-02)` 25c7e97 (RED run: 16 failures incl. the live IN-01 reproduction — empty-string port bound an ephemeral port instead of 9090).
3. `test(06-02)` 523877b precedes `feat(06-02)` d014f71 (RED run: 6 failed / 7 passed — exactly the new behavior pins failed, all characterization pins passed).

No REFACTOR commits were needed — implementations landed at their final form.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Dropped the planned EMAIL_JOB_OPTIONS re-export from src/worker/queues.ts**
- **Found during:** Task 2 GREEN verification
- **Issue:** The plan listed EMAIL_JOB_OPTIONS among queues.ts's additions. Implementing it as `export { EMAIL_JOB_OPTIONS } from "@/lib/email/enqueue"` makes enqueue.ts a dependency of queues.ts, while enqueue.ts reads `LANE_PRIORITY` at module scope from queues.ts — the cycle evaluated enqueue BEFORE queues' body ran, throwing `Cannot read properties of undefined (reading 'email')` at import time (suite failed to load in vitest; any bundler reordering would be equally fragile).
- **Fix:** The re-export was removed with an explanatory comment; EMAIL_JOB_OPTIONS lives only in `src/lib/email/enqueue.ts`. No consumer imported it from queues (tests pin it at the enqueue module), so nothing else changed. The lone safe direction (enqueue -> queues, function-body-only references) is preserved.
- **Files modified:** src/worker/queues.ts
- **Commit:** 25c7e97

**2. [Rule 1 - Bug] Tuple-type fix in tests/worker/email-provider.test.ts**
- **Found during:** Task 2 GREEN typecheck
- **Issue:** `vi.fn(async () => ({ id: "job-1" }))` types `mock.calls[0]` as a zero-length tuple — TS2493 on the `[name, data, opts]` destructure.
- **Fix:** Typed the fake add implementation's parameters (`(_name: string, _data: unknown, _opts?: unknown)`).
- **Files modified:** tests/worker/email-provider.test.ts
- **Commit:** 25c7e97

**3. [Rule 3 - Tooling] `pnpm exec rg` unavailable on this machine**
- **Found during:** Task 3 verification
- **Issue:** The plan's verify chain uses `pnpm exec rg -l "@/lib/mail" src/app`; ripgrep's `rg` binary is not resolvable through pnpm exec here ("Command rg not found").
- **Fix:** Ran the identical check through the Grep tool (ripgrep) with pattern `@/lib/mail` over `src/app` — zero matches. Gate satisfied; no code impact.
- **Files modified:** none

**4. [Judgment within plan scope] Ping placed before the limiter in both routes**
- **Found during:** Task 3 GREEN
- **Issue:** The plan says ping "at the top" and (for register) "keep the existing limiter block untouched"; it does not fix ping-vs-limiter order. Since the limiter is itself Redis-backed, a Redis-down request hitting the limiter first could surface as a limiter error path (500) instead of the intended bounded 503.
- **Fix:** Ping is the first statement inside `try` in both routes — a Redis outage now deterministically yields the 503 regardless of limiter behavior under outage. The register limiter block itself is byte-identical and still precedes body parse; forgot's limiter also sits above its body parse (D-21 satisfied).
- **Files modified:** src/app/api/auth/register/route.ts, src/app/api/auth/forgot-password/route.ts
- **Commit:** d014f71

## Auth Gates

None — no authentication-restricted resources were touched.

## Known Stubs

None — all paths are wired to real implementations (provider selection, render, enqueue, lane worker, teardown).

## Deferred Issues (out of scope)

- `MaxListenersExceededWarning: 11 error listeners on [BoundPool]` fires during `tests/api/auth-shallow.handler.test.ts` only: the new import chain route -> `@/lib/email/enqueue` -> `@/worker/queues` -> breaker/db re-evaluates a module per `vi.resetModules()` case, each attaching a listener to the globalThis-cached pool. Test-run artifact only (production evaluates modules once); same class as the pre-existing prisma/HMR singleton pattern. Logged in `deferred-items.md` if a future pass wants a listener-guard in worker/db.ts.
- 60 pre-existing ESLint unused-var warnings — untouched (scope boundary).

## Self-Check: PASSED

All 15 created/modified files exist on disk and all 6 task commits verified present in `git log` (d1a7576, 6ff8c29, c623e4d, 25c7e97, 523877b, d014f71).
