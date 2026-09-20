# Phase 6: Thin API Routes & Email Abstraction - Research

**Researched:** 2026-09-20
**Domain:** API-route enqueue offloading (BullMQ producers in a Next.js 16 web process), transactional-email queue + provider abstraction, boundary security (webhook secret auth, per-user rate limiting, SSRF validate-at-create), legacy cron deletion
**Confidence:** HIGH (codebase facts verified by direct read; external facts verified against primary sources — Next.js v16.0.10 source, docs.bullmq.io, core.telegram.org)

## Summary

Phase 6 turns the web app into a stateless producer: every API route enqueues work (manual check → 202 + client poll; register/forgot-password → email job) and no route ever executes a check or an SMTP send. Nearly all machinery already exists from Phases 3–5: `enqueueManualCheck()` is live in `src/worker/queues.ts` with an injectable `checksQueue` dep, the `email-transactional` queue and `LANE_PRIORITY.email = 5` are declared, the Redis Lua limiter, `src/lib/ssrf.ts`, and the retention (maintenance) real-delete path are all built. The genuinely new code is small and well-bounded: a **web-side bounded BullMQ producer** (the single most load-bearing new finding — see below), the email lane worker + provider module, the check-route rewrite + client poll, Telegram webhook secret enforcement, and the deletion release.

The most important verified finding: **BullMQ's official docs state `maxRetriesPerRequest: null` is required only for Worker/QueueEvents (blocking) connections; for Queue producers used from request handlers they explicitly recommend a bounded value (default 20 or ~1) so callers "get a fast error"** [VERIFIED: docs.bullmq.io/guide/connections]. This means API-02's 503 does NOT need a Promise.race hack: a web producer on its own ioredis connection with `maxRetriesPerRequest: 1` + a small `connectTimeout` makes `queue.add()` reject promptly when Redis is down, and the route maps that rejection to 503. Conversely, reusing `workerConnection()` (the `null` profile) in the web process would reproduce WR-01's hang class inside an HTTP handler. Second key finding: D-09's retry schedule (30s/2m/8m/30m/2h ≈ 2.7h reach) is **not** producible by BullMQ's built-in exponential backoff (`2^(attempts-1) × delay` from 30s gives 30s/1m/2m/4m/8m); it requires the documented `settings.backoffStrategy` custom function on the email Worker [VERIFIED: docs.bullmq.io/guide/retrying-failing-jobs]. Third: D-22's delegated verification is complete — Next.js v16.0.10 stamps `x-forwarded-for` from the socket remote address **only when the header is absent** (`??=`), never appends, and never sets `x-real-ip` [VERIFIED: raw source, base-server.ts `handleRequestImpl`], which is exactly the semantics `getIP`'s rightmost-entry/TRUST_PROXY logic assumes.

All five researcher-verifications delegated by CONTEXT.md are complete (D-17 typo sweep, D-22 XFF verification + spoof analysis, D-28 force-path admission pin, D-34 metrics enumeration, getIP spoof behavior) — results in "Delegated Verification Results" below. No new packages are installed; the stack is entirely present (bullmq 6.3.4, ioredis ^6, nodemailer ^7.0.13, next ^16.0.10).

**Primary recommendation:** Build a `src/lib/queue-producer.ts` web-side module — ONE globalThis-cached ioredis (BullMQ-compatible but bounded: `maxRetriesPerRequest: 1`, `connectTimeout` ≈ 500–1000 ms) shared by checks + email Queue instances — then rewrite the check route to `enqueueManualCheck(id, { checksQueue: webProducer.checks })` → 202 `{ jobId, queuedAt }`, enqueue both email sites via render-at-enqueue payloads, wire a new `startEmailLaneWorker` with a table-driven custom `backoffStrategy` of exactly [30s, 2m, 8m, 30m, 2h], and sequence Feature release → ~24h soak → Deletion release exactly as D-26/D-31 pin.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Check-now UX & poll contract (API-01)

- **D-01: Poll monitor data, not job state.** The client reuses the monitor read the dashboard already has; completion = `lastChecked` advances past the enqueue timestamp. Zero new endpoints; web stays a pure Postgres reader and never couples to BullMQ job state. (Manual checks persist synchronously — DAT-01 Tier 1 — so completion is seconds, not the ≤60s Tier-2 window.)
- **D-02: Poll cadence 2s, give up after 30s.** Manual lane is priority 1; checks carry a 10s timeout, so steady-state completion is ~2–12s.
- **D-03: Row state + toast.** Check button disables with spinner/"Checking…" until `lastChecked` advances; toast confirms the fresh result (UP/DOWN + response time). Closest to today's UX.
- **D-04: Quiet handoff on give-up.** Info toast ("Still checking — the result will appear when ready"); polling stops; the dashboard's existing periodic refresh surfaces the result. Never an error state (the job may still be in flight); never auto re-enqueue.
- **D-05: 202 body is `{ jobId, queuedAt }`.** The poll doesn't need it, but jobId gives support/log correlation (04-02 shape: `check-manual:{monitorId}:{epochMs}`).
- **D-06: 429 + `Retry-After` header** (seconds to window reset) + friendly toast. Note: this route has NO rate limit today — 429s are new user-visible behavior, hence the friendly shape.

#### Email queue mechanics (EML-01/02/03/05)

- **D-07: Render at enqueue.** Route renders the final `{to, subject, html}` payload; the worker's email job transports bytes through the provider. Self-contained payloads, no web/worker template skew; Phase 7 Better Auth hooks reuse the queue unchanged. EML-05's "template relocated verbatim" = the HTML moves into the lib/email home byte-for-byte.
- **D-08: Both send sites enqueue** — register verification AND forgot-password reset. Same SMTP dependency/degradation story; leaving forgot-password in-request keeps a path where SMTP-down 500s a route.
- **D-09: 5 attempts, exponential from 30s** (~30s / 2m / 8m / 30m / 2h — exhausts ≈2.7h). Generous end of the pinned 3–5 retry convention: an hour-or-two SMTP outage still delivers "arrives once SMTP recovers".
- **D-10: Permanent failure = log + metric only.** Typed unrecoverable failure logs error + feeds a queue counter; no user-facing surface. Strictly better than today (SMTP failure currently 500s the register request).
- **D-11: `EMAIL_PROVIDER` unset/empty → smtp.** Missing var can never break email; `console` is an explicit dev opt-in; an unknown value fails loud at boot (throw-early convention).
- **D-12: Console provider prints the full dump** — recipient + subject + rendered HTML on one structured stdout line.
- **D-13: New `src/lib/email/` module** owns the provider interface, `EMAIL_PROVIDER` selection, render functions (template byte-verbatim from `mail.ts`), and the enqueue helper. `src/lib/mail.ts` is deleted; no in-request transport remains.

#### Autonomous retention & 05-REVIEW absorption (WR-03 and friends)

- **D-14: Flip the daily scheduler to real deletes** — `scheduler.ts` maintenance template becomes `dryRun:false` (hardcoded, stale comment fixed); daily 03:15 UTC executes real batched deletes (pings >30d, RESOLVED incidents >90d), restoring legacy daily-cleanup parity. The manual script keeps `--dry-run`/`--apply` flags for operator drills.
- **D-15: Fix WR-01 + WR-02 in Phase 6.** WR-01: bound `enqueue-maintenance.mjs` with a deadline (fail-loud per its own contract — it currently hangs forever on unreachable Redis). WR-02: quit the relay Redis singleton (`disposeRelayRedis`) in `drainAndTeardown` alongside the main client.
- **D-16: IN-04 — HTML-escape `& < >` in worker alert rendering** (monitor name/url interpolation), with D-48 byte-parity pins updated in the same change. Normal names/URLs stay byte-identical; special-char names stop dead-lettering as "permanent" Telegram failures.
- **D-17: Fix the three pinned route defects and flip their pins red→green** — GET `[id]` `findUnique`→`findFirst`; PATCH/DELETE bare-return→400; "Unauthirized"→"Unauthorized" (researcher sweeps client code for string-matching on the typo first). 02-05 pinned these as deliberate Phase-6 red/green markers.
- **D-18: Retention observability = log + metric.** Each real pass logs deleted-row counts and feeds existing worker metrics; failures log error-level. No new dead-man (worker heartbeat already covers a dead tick loop).
- **D-19: Absorb only IN-01 + IN-06** from the nine 05-REVIEW Info findings — IN-06 (cron-remnant gate counting comments; updated anyway when cron remnants die) and IN-01 (empty-string `WORKER_HEALTH_PORT` ephemeral-port guard). The rest stay with their owning changes.

#### Boundary security (SEC-03/05/06, WR-06)

- **D-20: Dedicated `TELEGRAM_WEBHOOK_SECRET` env** + a one-time `setWebhook` runbook step; requests without the correct `X-Telegram-Bot-Api-Secret-Token` header get 401 via constant-time compare. Rotation = re-run setWebhook.
- **D-21: Limiter coverage extends to forgot-password (~5/h per IP, register parity) and the telegram webhook (per-IP)** — both reuse the Redis Lua limiter.
- **D-22: Harden `getIP` this phase** (closes 03-REVIEW WR-06): trust only Next-stamped headers; researcher verifies the rightmost-entry logic against Next 16 behavior plus a spoof test.
- **D-23: SSRF validate-at-create using the full `src/lib/ssrf.ts` pipeline** (scheme allowlist + resolve-then-denylist, DNS-only, clear 400 message). The engine's per-hop validation stays as defense-in-depth.
- **D-24: Escape `user.name` in the webhook confirmation** (rides the same change as the webhook-secret work on that route).
- **D-25: PATCH re-validates the URL only when the request changes it** — legacy private-URL rows stay editable rather than bricked.
- **D-26: Release structure = Feature release → soak → Deletion release.** The deletion release removes: `/api/cron/*` routes, `cron-logic.ts`, `db-batcher.ts`, `cleanup-logic.ts`, `CRON_SECRET`, the stale playwright `CRON_MODE=vercel` writer, and extends the D-41 remnant gate.

#### Cron deletion & pin fate

- **D-27: Delete the 02-03/02-05 cron characterization pins with an inventory map.** The suites pinning cron-logic/db-batcher/cron-route HTTP contracts are deleted in the deletion release; the plan carries a written inventory mapping each deleted pin to where its guarantee now lives (worker suites from 04/05, D-48 alert pins in worker tests, D-41 gate extended to cover routes + `CRON_SECRET` + cron-logic/db-batcher/cleanup-logic imports). Their pin-until-replaced job is complete.

#### Enqueue admission edges

- **D-28: Preserve today's admission semantics for paused/inactive monitors.** The new enqueue route mirrors the old force path byte-for-byte; the researcher pins the current force-path `isActive` behavior first and the new route matches it. Zero new policy in a modernization phase.

#### Redis-down on register

- **D-29: 503 refuse when Redis is unreachable** — register AND forgot-password return 503 (API-02's loud-degradation philosophy extended to email enqueue). Redis down is a full infra outage already paging via the worker dead-men; a brief honest refusal beats a silently-swallowed email with no durable outbox to resurrect it from. Login (JWT, no Redis write) keeps working.

#### Rehearsal & evidence

- **D-30: Stand-in live smoke, no snapshot restore.** Phase 6 has zero migrations and never touches the monitoring engine's data path, so no D-30-style anonymized-snapshot rehearsal. Rehearsal = deploy the built feature-release artifact to the localhost stand-in (SHA pinning per the 05-07 precedent, `readyz` gates) and live-smoke: check-now 202→poll completion, email round-trip on the console provider + SMTP-fail-then-recover, webhook secret refusal, retention real-delete pass on seeded rows.
- **D-31: ~24h soak between releases.** Real users exercising check-now, at least one real registration, the 03:15 UTC retention pass observed, dead-men quiet — then the deletion release. Matches the M-2 expand/contract precedent and gives rollback its window.

#### Route hygiene (minor areas)

- **D-32: `apiError(status, message)` helper in touched routes only.** Wire shape stays byte-identical `{ error }` (characterization pins untouched); construction becomes uniform and leak-proof by construction. No full-codebase sweep; untouched routes keep their current code.
- **D-33: URL-only validation tightening.** SSRF URL validation is the only new validation; name/interval/etc. keep today's exact acceptance behavior. Researcher documents any unvalidated-field gaps as deferred ideas, not new rejections.
- **D-34: Email lane = existing per-queue depth/age gauges + a failed-attempts counter, no dead-man.** Researcher verifies the metrics loop enumerates the email queue once a consumer exists. A dead worker already pages via the heartbeat dead-man; permanent-failure handling is already log+metric-only (D-10).

### Claude's Discretion

None — every question was answered with an explicit choice (all recommended options accepted). The researcher retains only the verification tasks explicitly delegated above (pin current force-path admission semantics, verify rightmost-XFF logic vs Next 16, sweep for typo string-matching, verify metrics-loop enumeration, verify getIP spoof behavior).

### Deferred Ideas (OUT OF SCOPE)

- Monitor create/update non-URL validation tightening (name length cap, interval bounds) — documented as a deferred hardening pass if the researcher finds unvalidated-field gaps (D-33).
- Email-lane dead-man check (fourth healthchecks.io check for a wedged email queue) — declined for Phase 6; revisit if email lanes grow beyond transactional auth mail (D-34).
- EML-04 (Better Auth hooks delegating to the email queue) — Phase 7 by ROADMAP.
- The remaining seven 05-REVIEW Info findings — stay with their owning changes (D-19).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| API-01 | Manual check becomes enqueue + 202 + optimistic read + poll; API routes never execute checks (rule 4–6) | `enqueueManualCheck` exists with injectable queue; manual jobs always take Tier 1 (synchronous `lastChecked` write — poll basis verified); client poll design (D-01..D-05) mapped onto `fetchMonitors`/`checkingId`; audit rules 4–6 = "Dedicated worker; API ≠ worker" (§15, §24 steps 4–5) |
| API-02 | API enqueue fails loudly (503) when Redis is unreachable — never silently no-ops | BullMQ docs: producers should use bounded `maxRetriesPerRequest` so `add()` errors fast; web producer module design + route mapping to 503; D-29 extends to register/forgot-password (with the create-before-503 ordering hazard documented in Pitfall 6) |
| SEC-03 | Telegram webhook authenticated via `secret_token` (X-Telegram-Bot-Api-Secret-Token header check) (S-2) | Official Telegram API verified: `setWebhook` `secret_token` (1–256 chars, `A-Z a-z 0-9 _ -`), header on every request; constant-time compare pattern with `crypto.timingSafeEqual` (equal-length requirement) |
| SEC-05 | Per-user enqueue rate limiter on the manual-check endpoint | Phase-01 ratified key shapes pinned: `rl:manual:{userId}:{monitorId}` (1/30s) + `rl:manual-user:{userId}` (6/min); existing Lua limiter lacks a TTL return — extension needed for `Retry-After` (D-06) |
| SEC-06 | No secret accepted via query string; `CRON_SECRET` retires with the cron endpoints (S-4/R15) | Deletion-release inventory complete (routes, env, `.env.example`, stand-in mint, playwright writer, D-41 gate extension, 02-03/02-05 pin deletions with inventory map) |
| EML-01 | Provider interface (`send()`) with env-selected providers: SMTP (Nodemailer, current Hostinger behavior), console (dev); extensible to Resend | `src/lib/email/` module design (audit §17 structure); `EMAIL_PROVIDER` unset→smtp, unknown→boot-throw (D-11); SMTP provider wraps existing transporter config byte-compatibly |
| EML-02 | Email sends off the request path via queue (bounded attempts, backoff); registration succeeds when SMTP is down (degradation path defined) (N-6) | Render-at-enqueue payload design (D-07); custom `backoffStrategy` verified as required for D-09's schedule; both send sites enumerated (exactly two `@/lib/mail` importers) |
| EML-03 | Typed retryable-vs-permanent errors — hopeless sends do not retry (`UnrecoverableError`) | BullMQ `UnrecoverableError` semantics verified (moves to failed set, overrides attempts); Nodemailer error taxonomy (EAUTH/EENVELOPE/EMESSAGE + 5xx = permanent; ETIMEOUT/ECONNECTION/ESOCKET + 4xx = retryable) at MEDIUM confidence |
| EML-05 | Existing HTML template preserved verbatim through the migration (relocated, not redesigned) | Template body mapped (`generateEmailTemplate` in `src/lib/mail.ts:15-75`, two call sites with exact strings); byte-verbatim relocation strategy + pinning approach documented |
</phase_requirements>

## Delegated Verification Results (researcher tasks from CONTEXT.md)

All five delegated verifications were executed this session. Each is a load-bearing input to the plan.

### 1. D-17 typo sweep — "Unauthirized"
Repo-wide grep finds the typo in exactly **one production site**: `src/app/api/monitors/route.ts:49` (POST handler's 401). The only other occurrences are its deliberate characterization pin (`tests/api/monitors.handler.test.ts:135-137`) and planning docs. **No client-side string-matching on the typo exists** (zero hits in `src/components/**`, `src/redux/**`, `src/app/**` beyond the route itself) — the fix is safe to make red→green in one change (route + pinned test together). [VERIFIED: repo grep]

### 2. D-22 — rightmost-XFF logic vs Next 16 behavior (+ spoof analysis)
Verified against the actual **next v16.0.10** source, `packages/next/src/server/base-server.ts`, `handleRequestImpl`:
```typescript
req.headers['x-forwarded-host'] ??= req.headers['host'] ?? this.hostname
req.headers['x-forwarded-port'] ??= ...
req.headers['x-forwarded-proto'] ??= ...
req.headers['x-forwarded-for'] ??= originalRequest?.socket?.remoteAddress
```
[VERIFIED: raw.githubusercontent.com/vercel/next.js v16.0.10 base-server.ts]
- `x-forwarded-for` is stamped **only when absent** (`??=`), the socket address is a **fallback only — never appended** to an existing list, and **`x-real-ip` is never set** by Next.
- Consequence for `getIP` (`src/lib/rate-limit.ts:91-107`): its documented model is exactly correct. Direct connection with no client header → single-entry XFF = the Next-stamped socket peer (leftmost == rightmost — key semantics unchanged for today's direct topology). Client-supplied XFF on a direct connection survives **verbatim** — attacker-controlled whether you read leftmost or rightmost; the existing IP-literal normalization bounds the spoofed keyspace, and the code's documented residual risk (valid-literal rotation minting fresh counters) stands until a proxy fronts the app.
- Spoof test for the plan (D-22's second leg): (a) request without XFF → key derives from socket peer (127.0.0.1 loopback fallback in the harness); (b) request with `x-forwarded-for: 1.2.3.4, 5.6.7.8` and TRUST_PROXY unset → key uses first entry (1.2.3.4); with TRUST_PROXY=true → last entry (5.6.7.8); (c) unparseable value → "unknown" shared bucket. Assert these three in the limiter suite. The rightmost choice is correct **only** when a sanitizing proxy appends the real client — which is precisely what TRUST_PROXY=true declares; no code change to the selection logic is required by this verification beyond the spoof pins.

### 3. D-28 — current force-path admission semantics (pinned)
`src/app/api/monitors/[id]/check/route.ts` + `src/lib/cron-logic.ts:8-27`:
- Route: session 401 → NaN id 400 → `findUnique({ where: { id, userId } })` → 404 "Monitor not found or unauthorized" → `runCronChecks(true, monitorId)` + `flushBatches()` → **200** `{ message: "Monitor checked successfully", result }`.
- Force path fetches `where: { isActive: true, ...(id ? { id } : {}) }` — **an inactive/paused monitor matches nothing**: `runCronChecks` returns `{ message: "No active monitors found", result: [] }` and the route still returns **200** with `result: []`. No check executes; the client toasts "Check triggered manually" and nothing happens.
- The worker engine independently no-ops inactive monitors at job time (`src/worker/engine/check.ts:238` — `if (!monitor || !monitor.is_active)` → `noop-monitor-missing`), so an enqueued-but-inactive job can never corrupt anything — it just never advances `lastChecked` (the client poll would hit D-04's quiet handoff).
- **Pin for the new route:** refuse-or-mirror the inactive case without introducing new policy (D-28) — e.g. admission check mirroring the old outcome (success-shaped response, no enqueue). The plan decides the exact shape; the pinned facts above are the contract. [VERIFIED: repo read]

### 4. D-34 — metrics loop enumerates the email queue
`src/worker/queues.ts:403-444` — `collectQueueMetrics` iterates **all six** `QUEUE_NAMES` lanes (`email: "email-transactional"` included) and `src/worker/metrics.ts` exposes them as `spidernode_queue_depth` / `spidernode_queue_oldest_job_age_seconds` / `spidernode_queue_stalled_events` with a `queue` label. The email lane's gauge surface **already exists**; a consumer is not required for enumeration (zero-job lanes report depth 0). The only new observability is the **failed-attempts counter** (D-10/D-34) — precedent pattern: the in-process monotonic counters `stalledEvents` Map + `backlogDropCount()` in queues.ts. [VERIFIED: repo read]

### 5. getIP spoof behavior
Covered by (2): the selection logic already matches verified Next 16 semantics; normalization (`normalizeClientAddress`, 45-char cap, IP-literal validation, `unknown` bucket) already bounds the spoofed keyspace. The Phase-6 deliverable is the **spoof test trio** from (2), not a rewrite. [VERIFIED: repo read + next source]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Manual-check admission + 202 response | API / Backend (route) | — | Route owns session auth, ownership check, limiter admission, 202 body; it never executes the check (rules 4–6) |
| Check execution (fetch + classification) | Worker process (check lane) | — | Already owns it since Phase 4/5; manual jobs ride `check-manual:` priority 1, always Tier 1 |
| Job enqueue transport | API / Backend (web-side bounded producer) | — | Web mints jobs over its own bounded ioredis; queue TOPOLOGY constants shared from `@/worker/queues` (pure exports, no module-level connections) |
| Email rendering | API / Backend (route, at enqueue) | — | D-07 render-at-enqueue: `{to, subject, html}` is self-contained; web/worker never share template state |
| Email transport | Worker process (email lane consumer) | — | Provider interface executes only in the worker; web never opens an SMTP socket |
| Provider selection (`EMAIL_PROVIDER`) | Worker process (boot) | — | Throw-early env validation lives where the consumer boots (D-11) |
| Poll completion signal | Database (monitors.lastChecked via existing GET) | Browser (poll loop) | D-01: web stays a pure Postgres reader; the browser polls the existing monitor read, never BullMQ state |
| Webhook secret enforcement | API / Backend (route) | External (Telegram setWebhook) | Constant-time header compare in the route; the secret is registered with Telegram out-of-band (runbook step) |
| Per-user enqueue limiter | API / Backend (Redis Lua) | — | Route-side admission via the existing `rlIncr` limiter; keys pinned by Phase-01 design |
| SSRF validation at create/update | API / Backend (route) | Worker (per-hop, defense-in-depth) | D-23: DNS-only pre-flight in the route; engine keeps full per-hop pinning |
| Retention deletes | Worker process (maintenance lane) | — | DAT-08: only the maintenance lane deletes in bulk; D-14 flips the daily scheduler to real deletes |

## Project Constraints (from CLAUDE.md)

- **GSD workflow enforcement:** file-changing work goes through GSD entry points — Phase 6 executes via the plan files this research feeds.
- **Modernization-only milestone:** no new user-facing features; behavior compatibility is the contract (1-strike DOWN, lifetime uptime math, Telegram alert content, public API shapes).
- **Deployment topology:** single VPS, two PM2 apps (web :3007 + worker), forward-only additive-first migrations — Phase 6 ships **zero migrations** (locked in CONTEXT §Not-in-scope).
- **Conventions:** `@/*` path alias; `"use client"` first line; route handlers uppercase verb exports; try/catch → `console.error("<Context> Error:", error)` → `{ error }` JSON (D-32 keeps the wire shape); new comments in English; sonner for toasts; no barrel files.
- **ErrorHandling discipline:** 401 missing session / 400 validation / 403 monitor-limit / 429 rate limit; error responses never include stack traces (FND-07; the 02-05-pinned stack-echo marker rides in a touched route if one exists — verify during planning).
- **Singleton pattern:** globalThis-cached clients (`src/lib/prisma.ts`, `src/lib/redis.ts`, worker queues) — the new web producer follows it.
- **Skills available:** `.claude/skills/redis-*` (connections/core/security/observability), `better-auth-*` (Phase 7 — not this phase), `shadcn`/`tailwind-design-system` (Phase 8). The redis-connections skill's guidance (pooling, avoid per-request connections, timeouts) is directly applicable to the web producer design.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| bullmq | 6.3.4 (installed) | Queue producer (web) + email lane Worker | Already the orchestration backbone (WRK-02); producer/worker connection semantics verified against official docs this session |
| ioredis | ^6.0.0 (installed) | Web-side bounded producer connection + existing limiter | Established in Phases 3–5; v6 typing quirk (custom `defineCommand` runtime-only) already handled in repo |
| nodemailer | ^7.0.13 (installed) | SMTP provider behind the new interface | Current Hostinger behavior preserved byte-compatibly (EML-01); v7 in production today |
| next | ^16.0.10 (installed) | Route handlers (check rewrite, register/forgot-password, webhook) | Existing framework; XFF stamping behavior verified against v16.0.10 source |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:crypto` (timingSafeEqual) | built-in (Node 24.15.0) | Constant-time webhook secret compare | D-20 — equal-length Buffers required, see Pitfall 4 |
| @prometheus-io/client | 0.16.1 (installed) | Email failed-attempts counter | D-10/D-34 — extend the existing registry, in-process counter precedent |
| pino | 10.3.1 (installed) | Email/retention structured logs | D-10/D-18 log+metric posture; worker logger already pino |
| vitest | ^4.1.11 (installed) | All new suites | Existing test stack (`pnpm test`) |
| playwright | via `@playwright/test` (installed) | e2e api-project check-now flow | Existing `pnpm test:e2e`; browser project machine-fault self-resolved 2026-09-16 |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Web-side bounded Queue producer | Import `workerQueues()`/`workerConnection()` into the web process | REJECTED: `maxRetriesPerRequest: null` makes `add()` hang on Redis-down (WR-01 class, inside an HTTP handler) and mints a third web connection profile; BullMQ docs explicitly recommend bounded retries for producers |
| Custom `backoffStrategy` table | Built-in `exponential` from 30s | REJECTED for D-09: built-in gives 30s/1m/2m/4m/8m (~11.5m reach) — fails "hour-or-two SMTP outage still delivers"; the ×4-style table matches 30s/2m/8m/30m/2h (≈2.7h) exactly |
| BullMQ job state polling (getJob/getState) | Monitor-row polling (D-01) | REJECTED by locked decision: web must never couple to BullMQ job state; zero new endpoints |
| Resend provider now | SMTP-only + console | Deferred by design: interface is extensible (EML-01 lists it) but only smtp/console ship this phase |

**Installation:**
```bash
# NONE — Phase 6 installs zero new packages (all dependencies already present)
```

**Version verification:** Versions read from `package.json` (lockfile-backed, pnpm 10.34.5): bullmq 6.3.4, ioredis ^6.0.0, nodemailer ^7.0.13, next ^16.0.10, @prometheus-io/client 0.16.1, pino 10.3.1, vitest ^4.1.11. External behavior verified against docs.bullmq.io (current), core.telegram.org/bots/api (current), raw next.js v16.0.10 source. [VERIFIED: package.json + cited docs]

## Package Legitimacy Audit

> Phase 6 installs **zero external packages**. The gate was run conceptually against the existing dependency set (all previously vetted in Phases 2–5, several with documented legitimacy checks: bullmq/tsx/undici operator-approved 04-01; @prometheus-io/client cleared 05-03). No registry checks were needed this session because no new names enter `package.json`.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| bullmq | npm | mature (v6 line) | high | github.com/taskforcesh/bullmq | OK (04-01 precedent) | In use — no install |
| ioredis | npm | mature | high | github.com/redis/ioredis | OK | In use — no install |
| nodemailer | npm | mature | high | github.com/nodemailer/nodemailer | OK | In use — no install |
| @prometheus-io/client | npm | mature | high | github.com/siimon/prom-client (org) | OK (05-03 check) | In use — no install |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

*No packages discovered via WebSearch or training data are recommended for installation; nothing requires `checkpoint:human-verify` gating on package grounds.*

## Architecture Patterns

### System Architecture Diagram

```
                         WEB PROCESS (next start :3007)                    WORKER PROCESS (PM2 app 2)
                                                                                               
 Browser ──POST /api/monitors/[id]/check──►  route: session → ownership → limiter               
                                             │  (rl:manual:{uid}:{mid} 1/30s                            
                                             │   rl:manual-user:{uid} 6/min)                             
                                             ▼                                                           
                                    web queue producer (src/lib/queue-producer.ts)              
                                    ONE bounded ioredis (retries=1, fast connectTimeout)         
                                    Queue(checks) + Queue(email) over that connection            
                                             │                                                           
                                             ├── add check-manual:{mid}:{epochMs} (pr.1) ──────►  check lane Worker (exists)
                                             │       202 { jobId, queuedAt } ◄─ immediate           │ manual ⇒ always Tier 1
                                             │                                                    │ synchronous ping + monitor
                                             │                                                    ▼ lastChecked=now(), next_check_at
 Browser ◄──poll GET /api/monitors (2s)──── (existing read — D-01: poll monitor row,               
           completion: lastChecked > queuedAt    never BullMQ job state)                          
                                                                                               
 Browser ──POST /api/auth/register─────────►  route: create user + token row                      
 Browser ──POST /api/auth/forgot-password──►  route: create token row (200-neutral)              
                                             │  render {to, subject, html} at enqueue (D-07)      
                                             │  Redis unreachable ⇒ add() rejects ⇒ 503 (API-02/D-29)
                                             ▼                                                           
                                    web producer ── add send-email (pr.5) ─────────────►  NEW email lane Worker
                                                                                                    │ EMAIL_PROVIDER select
                                                                                                    ├─ smtp: nodemailer send
                                                                                                    └─ console: stdout dump
                                                                                                    │ retry: custom backoff
                                                                                                    │ [30s,2m,8m,30m,2h] (D-09)
                                                                                                    │ typed permanent (EAUTH/
                                                                                                    │ EENVELOPE/5xx) ⇒ throw
                                                                                                    │ UnrecoverableError ⇒
                                                                                                    │   failed set + counter (D-10)
                                                                                               
 Telegram ──POST /api/telegram/webhook────►  route: constant-time header check (401)            
                                             │ per-IP limiter (D-21) → /start link handling        
                                             │ escape user.name (D-24)                              
                                                                                               
 scheduler (exists) ── daily 03:15 UTC ─────────────────────────────────────────────────►  maintenance lane: D-14 flip
                                                                                            dryRun:false → real batched
                                                                                            deletes (pings>30d, RESOLVED>90d)
```

Trace the primary use case: user clicks "Check now" → POST → admission (session, ownership, limiter) → producer adds a priority-1 manual job → 202 returns in milliseconds → browser polls the existing monitor list every 2s → the worker's check lane (which always routes manual jobs through Tier 1) writes `lastChecked = now()` synchronously → the next poll sees `lastChecked > queuedAt` → toast with the fresh result.

### Recommended Project Structure
```
src/
├── lib/
│   ├── queue-producer.ts      # NEW — web-side bounded BullMQ producer (checks + email queues)
│   ├── email/                 # NEW — D-13 module home
│   │   ├── index.ts           # provider interface + getEmailProvider() + EMAIL_PROVIDER boot-throw
│   │   ├── providers/
│   │   │   ├── smtp.ts        # wraps the existing nodemailer transporter config
│   │   │   └── console.ts     # D-12 one-line structured stdout dump
│   │   ├── render.ts          # generateEmailTemplate + the two render fns (byte-verbatim from mail.ts)
│   │   └── enqueue.ts         # enqueueTransactionalEmail({to,subject,html}) via the web producer
│   ├── mail.ts                # DELETED (deletion release; zero importers remain after feature release)
│   ├── rate-limit.ts          # EXTEND — TTL return for Retry-After; spoof pins (D-06/D-21/D-22)
│   └── ssrf.ts                # EXTEND — exported DNS-only assertUrlAllowed for create/update (D-23)
├── worker/
│   ├── queues.ts              # EXTEND — startEmailLaneWorker + EMAIL_LANE_CONCURRENCY + email job opts
│   ├── email.ts               # NEW — email lane processor (provider dispatch + typed error mapping)
│   ├── index.ts               # EXTEND — wire email worker; drainAndTeardown + disposeRelayRedis (D-15/WR-02)
│   ├── scheduler.ts           # EDIT — maintenance template dryRun:false + comment fix (D-14)
│   └── persist/outbox.ts      # EDIT — HTML-escape monitorName/monitorUrl in renderAlertMessage (D-16/IN-04)
├── app/api/
│   ├── monitors/[id]/check/route.ts   # REWRITE — enqueue + 202 (API-01)
│   ├── auth/register/route.ts         # EDIT — render + enqueue; 503 on Redis-down (D-29)
│   ├── auth/forgot-password/route.ts  # EDIT — limiter (D-21) + render + enqueue; 503 (D-29)
│   └── telegram/webhook/route.ts      # EDIT — secret-token auth + limiter + name escape (D-20/21/24)
└── components/Dashboard/Dashboard.tsx # EDIT — handleCheckMonitor → enqueue + poll (D-01..D-04)
scripts/
├── enqueue-maintenance.mjs    # EDIT — WR-01 enqueue deadline
└── check-cron-remnants.mjs    # EXTEND (deletion release) — D-41 gate: routes + CRON_SECRET + module imports
```

### Pattern 1: Web-side bounded queue producer (the API-02 mechanism)
**What:** One module, `globalThis`-cached, owning a single ioredis connection created with `maxRetriesPerRequest: 1` and a small `connectTimeout` — deliberately NOT `workerConnection()`'s `null` profile — plus `Queue` instances for the checks and email lanes over that shared connection.
**When to use:** Every web-process enqueue (manual check, both email sites).
**Why (verified):** docs.bullmq.io/guide/connections — the `null` requirement applies to Worker/QueueEvents (blocking) only; for producers used from request handlers the docs recommend bounded retries so callers "get a fast error". Sharing one connection across Queue instances is the documented producer pattern. An unreachable Redis then makes `add()` reject in bounded time → the route maps to 503. [VERIFIED: docs.bullmq.io]

### Pattern 2: Injected-queue reuse of the existing enqueue helper
**What:** `enqueueManualCheck(monitorId, { checksQueue })` already accepts an injected queue client (`CheckQueueClient`) — the web producer's checks Queue satisfies it. The jobId shape, priority discipline, and the breaker gate (a web-process-local no-op by construction) all ride the existing helper; zero duplication.
**When to use:** The check-route rewrite. Import the **pure** exports from `@/worker/queues` (`manualCheckJobId`, `LANE_PRIORITY`, `CHECK_JOB_OPTIONS`, `QUEUE_NAMES`) — the module has no module-level connection side effects (verified: `workerConnection()` is only called inside lazy factories). Do NOT call `workerQueues()` from the web process (it mints the `null`-profile connection).
**Caveat:** `next build` will compile `src/worker/queues.ts` into the web bundle (pulls bullmq + pino — both server-safe). The one-directional boundary gate (`check-worker-boundary.mjs`) only forbids worker→web imports, so web→worker imports pass the gate; if the planner prefers isolation, extract the pure jobId/priority constants into a shared `src/lib/queue-contracts.ts` instead.

### Pattern 3: Render-at-enqueue email payloads (D-07)
**What:** The route renders the final `{to, subject, html}` (render functions byte-verbatim from `mail.ts`) and enqueues a self-contained job; the worker's processor only transports bytes through the selected provider.
**When to use:** Both send sites. Phase 7's Better Auth hooks reuse the same enqueue helper unchanged.
**Why:** No web/worker template skew; the SMTP-down story is purely queue-side; EML-05's byte-parity is testable as a pure-function assertion.

### Pattern 4: Table-driven custom backoff (D-09)
**What:** The email lane Worker is created with `settings: { backoffStrategy: (attemptsMade) => EMAIL_BACKOFF_MS[attemptsMade - 1] ?? last }` and email jobs carry `backoff: { type: "custom" }`. Table: `[30_000, 120_000, 480_000, 1_800_000, 7_200_000]` — exactly 30s/2m/8m/30m/2h.
**When to use:** Email lane only (check/maintenance lanes keep their existing backoffs).
**Why (verified):** BullMQ's built-in exponential is `2^(attempts-1) × delay` — from 30s that yields 30s/1m/2m/4m/8m, which cannot satisfy "SMTP-down-for-an-hour still delivers". Custom strategies are registered on the Worker per official docs. [VERIFIED: docs.bullmq.io/guide/retrying-failing-jobs]

### Pattern 5: Constant-time webhook secret (D-20/SEC-03)
**What:** Read `X-Telegram-Bot-Api-Secret-Token`; if `TELEGRAM_WEBHOOK_SECRET` is unset → fail loud (500-style config error, never accept); compare with a length check first (a mismatch is 401 either way) then `crypto.timingSafeEqual` on equal-length buffers. One-time `setWebhook` with `secret_token` is a runbook step (rotation = re-run).
**Why (verified):** Telegram sends the header on every webhook request only when `secret_token` was passed to `setWebhook`; token charset `A-Z a-z 0-9 _ -`, 1–256 chars. `timingSafeEqual` throws `RangeError` on length mismatch — hence the explicit length guard. [CITED: core.telegram.org/bots/api; CITED: nodejs.org/api/crypto.html]

### Pattern 6: Characterization pin flip (in-wave, same change)
**What:** Every deliberately-pinned defect this phase fixes (S-2 unauth webhook, S-4 query secret, "Unauthirized", PATCH/DELETE bare-return, findUnique) is flipped red→green **in the same change as the fix** — the pin's expectation is updated in the same commit so the suite never asserts removed behavior.
**When to use:** D-17, D-27, and the 02-05 cron pins in the deletion release (deleted suites + written inventory map).

### Anti-Patterns to Avoid
- **Awaiting transport inside a route** (SMTP send, target fetch, Telegram API): exactly what this phase deletes; the register route's in-request `sendVerificationEmail` and the check route's `runCronChecks` are the two remaining instances.
- **Using `workerConnection()`'s `null` retry profile in the web process:** reproduces WR-01's indefinite hang inside an HTTP handler — the direct opposite of API-02.
- **Polling BullMQ job state from the web:** couples the web process to Redis as a job-state reader and needs a new endpoint; D-01 forbids both.
- **Custom jobIds on email jobs:** any colon-containing custom id MUST split into exactly 3 segments (BullMQ 6 throws "Custom Id cannot contain :" otherwise — twice learned in 04-02/05-06). Email jobs need no custom id at all; omit it.
- **Flushing cron remnants piecemeal:** the deletion release is one atomic contract (routes + modules + env + gate + pins) — a partial deletion leaves the D-41 gate red or the runbook §9 lever dead.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|------|
| Fast-fail enqueue on Redis-down | Promise.race deadlines around `add()` (WR-01-style) on a `null`-retry connection | Bounded `maxRetriesPerRequest` on the web producer connection | Documented producer profile; rejection is native, deadline-free, no timer leaks |
| Retry scheduling | Per-attempt setTimeout/re-enqueue logic | BullMQ `attempts` + custom `backoffStrategy` | BullMQ owns delayed retries, stalled handling, and the failed set; hand-rolled timers lose jobs on restart |
| Permanent-failure dead-lettering | try/catch → discard / flag-in-DB | `throw new UnrecoverableError(...)` from the processor | Moves the job to the failed set overriding attempts — the documented pattern; DLQ retention via existing `removeOnFail` age |
| Webhook origin auth | IP allowlist of Telegram ranges / HMAC scheme | `setWebhook secret_token` + timing-safe header compare | First-party mechanism, zero crypto surface, rotation is one API call |
| Client IP extraction | Read raw `x-forwarded-for` leftmost blindly | Existing `getIP` + verified Next-16 semantics + TRUST_PROXY | Already normalized/bounded; this session verified the exact Next stamping behavior it relies on |
| SSRF validation at create | New URL-parser + IP-range checker | `src/lib/ssrf.ts` pipeline (exported DNS-only wrapper) | 04-03 built and tested the scheme allowlist + resolve-then-denylist + canonicalization edge cases (IPv6-mapped, hostnames, redirects) |
| Rate-limit window math | Second Redis call for TTL / client-side estimate | Extend the existing ONE Lua script to also return PTTL | Keeps the single-atomic-command pin (Phase 01 IN-01); one round trip, no INCR/EXPIRE split regression |
| Monitor-list polling | New job-status endpoint / websocket | Existing `GET /api/monitors` + `lastChecked` comparison | D-01 locked; zero new endpoints, zero new coupling |
| Email HTML template | Redesign "while we're in there" | Byte-verbatim relocation of `generateEmailTemplate` | EML-05 pins it; rule 19 (no redesign) |

**Key insight:** every deceptively complex problem in this phase (retries, dead-lettering, SSRF, rate limiting, IP trust) already has a built, tested, in-repo or in-library solution — the phase's risk is concentrated in *wiring and sequencing*, not invention.

## Runtime State Inventory

> Phase 6 includes a deletion release (env vars, routes, external registration) — inventory below. "None found" is stated explicitly per category.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — Phase 6 ships zero migrations and never alters table data (CONTEXT §Not-in-scope). Verification-token rows created by register/forgot-password keep their existing shape and TTL cleanup. | None — verified by CONTEXT lock + schema read |
| Live service config | **Telegram webhook registration**: production's current webhook (if set) was registered WITHOUT a secret_token. After enforcement ships, incoming Telegram posts 401 until `setWebhook` is re-run with `secret_token` (D-20 runbook step — must be part of the feature-release cutover, not deferred past it). **Vercel Cron (if ever configured in the dashboard)**: any external schedule still calling `/api/cron/check` 404s after the deletion release — dormant per CLAUDE.md ("optionally used"), verify none exists at window-open. | One-time `setWebhook` call (operator, runbook §amended); confirm Vercel dashboard has no live cron |
| OS-registered state | None — PM2 apps keep their names/ports; no Task Scheduler/systemd units reference cron routes or CRON_SECRET (verified: `ecosystem.config.js` carries app config only; healthchecks.io trio unchanged, D-34 declines a fourth check). | None |
| Secrets/env vars | `CRON_SECRET` lives in production `.env`, `.env.example` (annotated retiring Phase 6), and the gitignored stand-in mint `.snapshots/standin-web-env.sh` (05-09 note) — all three retire with SEC-06. **New**: `TELEGRAM_WEBHOOK_SECRET` (D-20) added to `.env.example` + both stand-in and production env; `EMAIL_PROVIDER` line goes live in `.env.example` (currently a dated comment). | Code edit + env file updates + operator secret mint; no key renames |
| Build artifacts | None blocking — web `.next` and worker `dist/worker.js` rebuild per release (SHA-pinned per 05-07/D-31 precedent); the retained 9f667e2 tarball's junction-shim procedure is documented in runbook §7 and unaffected (instrumentation.ts already gone; current builds immune). | Standard rebuild; no artifact migration |

## Common Pitfalls

### Pitfall 1: BullMQ `add()` hangs forever on an unreachable `null`-retry connection
**What goes wrong:** With `maxRetriesPerRequest: null`, ioredis never rejects pending commands — `queue.add()` (and the connection handshake) settle only when Redis returns. In an HTTP handler this is an unbounded request hang (the exact WR-01 defect class, currently live in `scripts/enqueue-maintenance.mjs:155-179`).
**Why it happens:** Copying the worker connection profile (where `null` is mandatory for blocking connections) into the producer side.
**How to avoid:** Web producer uses `maxRetriesPerRequest: 1` + `connectTimeout` ≈ 500–1000 ms (bounded rejection — docs-recommended producer profile); map the rejection to 503. WR-01's fix in enqueue-maintenance.mjs can use the same bounded-rejection or the 05-REVIEW-suggested Promise.race (the script must keep `null` only if it keeps BullMQ Worker semantics — it doesn't, it's producer-only, so bounded retries are correct there too).
**Warning signs:** request latency == TCP connect timeout × retries; e2e register suite stalls when the test Redis is down.

### Pitfall 2: D-09's schedule is NOT BullMQ's built-in exponential
**What goes wrong:** `{ type: "exponential", delay: 30_000 }` yields 30s/1m/2m/4m/8m (formula `2^(attempts-1) × delay`), silently failing "SMTP-down-for-an-hour still delivers" (≈11.5m reach vs the required ≈2.7h).
**Why it happens:** "exponential from 30s" reads like a config line; the pinned schedule is ×4-shaped.
**How to avoid:** `backoff: { type: "custom" }` + `settings.backoffStrategy` on the email Worker with the exact table [30s, 2m, 8m, 30m, 2h]; pin the table in a unit test (delay per attemptMade).
**Warning signs:** A green "retries with backoff" test that only asserts monotonic growth, not the exact values.

### Pitfall 3: Email jobs with colon-containing custom jobIds throw at enqueue
**What goes wrong:** BullMQ 6 rejects custom jobIds that don't split into exactly 3 colon segments ("Custom Id cannot contain :") — hit twice already (04-02, 05-06).
**How to avoid:** Omit `jobId` for email jobs entirely (auto-generated ids; uniqueness per send is fine, and at-least-once redelivery of a verification link is harmless). If an id is ever wanted, reuse the 3-segment discipline.
**Warning signs:** Any `jobId:` option on a new enqueue path.

### Pitfall 4: `timingSafeEqual` throws on length mismatch
**What goes wrong:** Passing header and secret buffers of different byte lengths throws `RangeError` — a 500 on the very spoofed request the check exists to refuse.
**How to avoid:** Compare lengths first (a mismatch is 401 regardless — length is not secret-sensitive here since the response is identical), then `timingSafeEqual` on equal-length buffers. Also handle the unset-`TELEGRAM_WEBHOOK_SECRET` case as a loud config error, never as accept.
**Warning signs:** Webhook tests only covering the equal-length paths.

### Pitfall 5: Enforcing the webhook secret before `setWebhook` runs strands Telegram connect
**What goes wrong:** Feature release adds 401-without-header enforcement; production's existing webhook was registered without `secret_token`, so every real Telegram POST 401s until the operator re-runs setWebhook.
**How to avoid:** The runbook step (one-time `setWebhook` with the new secret) is part of the feature-release cutover sequence; smoke it on the stand-in (D-30 includes "webhook secret refusal" — also smoke acceptance AFTER setWebhook).
**Warning signs:** Deploy plan ordering that lists enforcement before registration.

### Pitfall 6: Register's 503-after-user-create strands an unverifiable account
**What goes wrong:** D-29 makes register 503 on Redis-down — but today's route creates the user (and token row) BEFORE the email step. A 503 after the row exists leaves an account that can never re-register (409 "already exists") and never receives verification (no resend route exists — only two `@/lib/mail` importers were ever present).
**Why it happens:** Enqueue failure surfaces after the durable write.
**How to avoid (planner decision, flagged):** pre-flight Redis liveness (bounded `PING` on the producer connection) at route top, before `prisma.user.create` — making the common outage path 503-before-write. The residual race (Redis dies between PING and add) is small; disposition it explicitly (e.g. accept + document, since Redis-down already pages via dead-men and forgot-password remains a later recovery path once Redis returns — its email is enqueued fresh per request).
**Warning signs:** e2e "register with Redis down" asserting only the status code, not the side-effect state.

### Pitfall 7: 02-05 characterization pins asserting removed behavior
**What goes wrong:** The check-route rewrite changes status/body (200→202), the typo fix changes a pinned string, PATCH/DELETE bare-returns become 400s — every affected pin must flip in the SAME change or `pnpm verify` goes red mid-wave (02-05's pins exist precisely to force this).
**How to avoid:** Plan each pin flip adjacent to its fix; D-27's inventory map lands with the deletion release.
**Warning signs:** A plan task that fixes a route without touching its handler test.

### Pitfall 8: Forgetting the enqueue-time `next_check_at` advance (01-08)
**What goes wrong:** Without it, a scheduler tick firing while the manual job is in flight claims the same monitor and runs a second check. Not corrupting (the per-monitor lock no-ops the loser; Tier 1 advances `next_check_at` on completion — tier1.ts:195) but wasteful and off-pin.
**How to avoid:** The route performs the §14.3-shaped atomic advance (one interval) at enqueue — explicitly assigned to "the caller" by `enqueueManualCheck`'s contract comment; Phase 6's route is its first production caller. Implement or disposition deliberately.
**Warning signs:** Double pings around manual checks in soak metrics.

### Pitfall 9: Stale playwright `CRON_MODE=vercel` writer resurrecting the token
**What goes wrong:** The e2e harness still writes `CRON_MODE` into the booted test web's env (playwright.config.ts:63, with a comment referencing the deleted `src/instrumentation.ts`) — the D-41 gate counts CRON_MODE tokens including in comments (IN-06) and could go red, or the writer survives as dead config.
**How to avoid:** Delete the writer + its comment in the deletion release (already on D-26's list); IN-06's one-line asymmetry note lands with the gate extension.

### Pitfall 10: `EMAIL_PROVIDER` selection failing silent instead of loud
**What goes wrong:** An unknown provider string falling back to smtp hides operator typos (`smtpp` silently sends via smtp — or worse, via nothing).
**How to avoid:** D-11 exactly: unset/empty → smtp; `console` explicit; anything else throws at worker boot (throw-early precedent: `src/redux/api/baseApi.ts`, `src/lib/redis.ts`).

## Code Examples

### Web-side bounded producer (Pattern 1 + 2)
```typescript
// Source: pattern synthesized from docs.bullmq.io/guide/connections + repo singletons (src/lib/redis.ts)
// src/lib/queue-producer.ts
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@/worker/queues";

const globalForProducer = global as unknown as {
  webQueueProducer?: { checks: Queue; email: Queue; connection: IORedis; close(): Promise<void> };
};

export function webQueueProducer() {
  if (!globalForProducer.webQueueProducer) {
    // Producer profile (NOT workerConnection's null): bounded retries so an
    // unreachable Redis rejects add() fast -> route maps to 503 (API-02).
    const connection = new IORedis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      enableReadyCheck: true,
    });
    connection.on("error", (err) => console.error("[web-queue-producer] connection error:", err.message));
    const checks = new Queue(QUEUE_NAMES.checks, { connection });
    const email = new Queue(QUEUE_NAMES.email, { connection });
    globalForProducer.webQueueProducer = {
      checks, email, connection,
      async close() {
        await Promise.allSettled([checks.close(), email.close()]);
        await connection.quit().catch(() => {});
      },
    };
  }
  return globalForProducer.webQueueProducer;
}
```

### Check route → 202 (API-01, D-05/D-06/D-28)
```typescript
// Source: synthesized from src/app/api/monitors/[id]/check/route.ts (current) + 06-CONTEXT D-01..D-06
export async function POST(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  const { id } = await params;
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const monitorId = parseInt(id, 10);
  if (isNaN(monitorId)) return apiError(400, "Invalid monitor ID");
  const monitor = await prisma.monitor.findFirst({ where: { id: monitorId, userId: session.user.id } }); // D-17 form
  if (!monitor) return apiError(404, "Monitor not found or unauthorized");
  // D-28: mirror the old force-path admission (isActive filter) — no new policy
  // D-21/SEC-05: rl:manual:{userId}:{monitorId} 1/30s  +  rl:manual-user:{userId} 6/min
  const perMonitor = await rateLimit(`manual_${session.user.id}_${monitorId}`, { limit: 1, windowMs: 30_000 });
  const perUser = await rateLimit(`manual-user_${session.user.id}`, { limit: 6, windowMs: 60_000 });
  if (!perMonitor.success || !perUser.success) {
    return NextResponse.json({ error: "You're checking too often — try again shortly." },
      { status: 429, headers: { "Retry-After": String(resetSeconds) } }); // D-06 — needs limiter TTL return
  }
  try {
    const queuedAt = Date.now();
    const { jobId } = await enqueueManualCheck(monitorId, { checksQueue: webQueueProducer().checks });
    return NextResponse.json({ jobId, queuedAt }, { status: 202 }); // D-05
  } catch (err) {
    if (err instanceof BreakerOpenError) return apiError(503, "Service temporarily unavailable — try again shortly");
    // ioredis/BullMQ add() rejection (bounded producer profile) => 503 (API-02)
    return apiError(503, "Service temporarily unavailable — try again shortly");
  }
}
```

### Client poll (D-01..D-04)
```typescript
// Source: synthesized from src/components/Dashboard/Dashboard.tsx handleCheckMonitor (current)
const handleCheckMonitor = async (id: number) => {
  setCheckingId(id);
  try {
    const res = await fetch(`/api/monitors/${id}/check`, { method: "POST" });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "30");
      toast.error(`You're checking too often — try again in ${retryAfter}s`); // D-06 friendly shape
      return;
    }
    if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed to ping monitor."); return; }
    const { queuedAt } = await res.json();                              // D-05
    const deadline = Date.now() + 30_000;                               // D-02 give up after 30s
    const started = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));                   // D-02 cadence 2s
      const list = await fetchMonitors();                               // D-01 existing read
      const m = list.find((x) => x.id === id);
      if (m?.lastChecked && new Date(m.lastChecked).getTime() > queuedAt) {
        toast.success(`${m.name}: ${m.status} (${m.responseTime}ms)`);  // D-03 fresh result
        return;
      }
    }
    toast.info("Still checking — the result will appear when ready");   // D-04 quiet handoff
  } finally { setCheckingId(null); }
};
```

### Email lane worker with table backoff + typed errors (D-09/D-10, EML-02/03)
```typescript
// Source: docs.bullmq.io/guide/retrying-failing-jobs (custom backoff + UnrecoverableError pattern)
export const EMAIL_BACKOFF_MS = [30_000, 120_000, 480_000, 1_800_000, 7_200_000]; // 30s/2m/8m/30m/2h (D-09)

export function startEmailLaneWorker(processor: LaneProcessor): LaneWorkerHandle {
  const worker = new Worker(QUEUE_NAMES.email, async (job) => processor({ id: job.id, name: job.name, data: job.data }), {
    connection: workerConnection(),
    concurrency: EMAIL_LANE_CONCURRENCY,
    lockDuration: 30_000, stalledInterval: 30_000, maxStalledCount: 1,
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        attemptsMade <= EMAIL_BACKOFF_MS.length ? EMAIL_BACKOFF_MS[attemptsMade - 1] : EMAIL_BACKOFF_MS.at(-1)!,
    },
  });
  return { close: () => worker.close() };
}
// Processor (src/worker/email.ts) — typed failure split:
//   transient (ETIMEOUT/ECONNECTION/ESOCKET/4xx)  -> rethrow        => BullMQ retries per backoff
//   permanent (EAUTH/EENVELOPE/EMESSAGE/5xx)      -> throw new UnrecoverableError(...) => failed set,
//                                                     counter++, error log (D-10)
```

### Webhook constant-time auth (D-20/D-24, SEC-03)
```typescript
// Source: core.telegram.org/bots/api (header contract) + nodejs.org/api/crypto.html (timingSafeEqual)
import { timingSafeEqual } from "node:crypto";

function secretMatches(provided: string | null): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured"); // loud, never accept
  if (!provided || provided.length !== expected.length) return false;           // 401 either way
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
// In POST: if (!secretMatches(req.headers.get("x-telegram-bot-api-secret-token")))
//   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
// D-24: escape user.name before interpolating into the HTML confirmation:
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| In-request SMTP send (register 500s on SMTP failure) | Render-at-enqueue + queue + bounded backoff (EML-02) | This phase | Registration survives SMTP outages; email arrives on recovery |
| Synchronous manual check (route awaits fetch + flush) | Enqueue + 202 + row poll (API-01) | This phase | Sub-50ms route; web never fetches targets |
| `CRON_SECRET` query/Bearer + `/api/cron/*` | Deleted; worker owns all scheduling (WRK-11 done Phase 5) | This phase (deletion release) | Secret-in-query surface eliminated (SEC-06) |
| Unauthenticated Telegram webhook | secret_token header + timing-safe compare (SEC-03) | This phase | Closes S-2 / AR-02-01 |
| Daily maintenance dryRun:true (WR-03) | Real deletes at 03:15 UTC (D-14) | This phase | Autonomous retention parity restored |

**Deprecated/outdated:**
- `next-auth` v4 patterns (getServerSession) — untouched this phase; Phase 7 replaces them (AUTH-*).
- BullMQ legacy repeatables — already replaced by `upsertJobScheduler` (WRK-02, v6).
- `sweetalert2` — prefer `sonner` per CLAUDE.md (D-03/D-04 toasts use sonner).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Nodemailer error taxonomy: EAUTH/EENVELOPE/EMESSAGE + 5xx `responseCode` = permanent; ETIMEOUT/ECONNECTION/ESOCKET + 4xx = transient (errors expose `.code`/`.responseCode`) | EML-03, Code Examples | MEDIUM impact — a mis-classified transient as permanent loses one email (log+metric only per D-10); a permanent-as-transient wastes ≤4 retries. Conservative default: only the obvious permanents dead-letter |
| A2 | `crypto.timingSafeEqual` throws `RangeError` on length mismatch (Node docs page truncated in fetch; behavior supplied from well-established documentation knowledge) | Pattern 5, Pitfall 4 | Low — the guarded compare pattern is correct under either behavior; tests pin it |
| A3 | Production Telegram webhook is currently registered (users connect via `/start` deep link) but without `secret_token` | Runtime State Inventory, Pitfall 5 | If NO webhook is registered in production, the setWebhook step is greenfield (simpler); if registered, ordering matters — either way the runbook step covers it. Operator confirms at feature release |
| A4 | Email lane concurrency of 1 is appropriate (SMTP pool default; one send at a time) — not pinned by CONTEXT | Architecture Patterns | Low — concurrency constant is trivially tunable; audit §14.1 gave the lane concurrency 5 but that referred to the notifier pool generally; planner pins the value |
| A5 | Web bundling of `src/worker/queues.ts` exports into `.next` via `@/worker/queues` import is acceptable (server-safe deps only: bullmq, ioredis, pino, dotenv) | Pattern 2 | Low — if bundling misbehaves, extract pure constants to `src/lib/queue-contracts.ts` (documented fallback) |

**All other claims in this research were verified (repo read, package.json, or cited primary documentation) or are locked decisions quoted verbatim from CONTEXT.md.**

## Open Questions (RESOLVED)

All four questions are dispositioned by the phase plans:

1. **Is a Telegram webhook actually registered in production today, and with what URL?**
   - What we know: the `/start {userId}` deep-link flow and the webhook route exist; users have connected (production has telegram-bound users per 05-07's "ZERO telegram-bound users" snapshot note — that was the ANONYMIZED snapshot; live prod state unverified).
   - What's unclear: whether `setWebhook` was ever called against production, and with which URL.
   - Recommendation: operator confirms at feature-release window-open; the runbook step (re-)registers with `secret_token` regardless — making the answer non-blocking either way.
   - Resolution: 06-04 Task 3 checkpoint captures the operator's A3 answer (registration state); the runbook §4b setWebhook step — executed inside the 06-05 Task 1 cutover — (re-)registers with `secret_token` regardless, so both possible answers are non-blocking.
2. **Exact 503-before-write shape for register (Pitfall 6).**
   - What we know: D-29 locks 503-on-Redis-unreachable; today's route writes the user before the email step; no resend-verification route exists.
   - What's unclear: pre-flight PING vs accepting the small post-create race.
   - Recommendation: pre-flight PING on the producer connection at route top (bounded, ~1ms when healthy); disposition the residual race in the plan. Planner decides.
   - Resolution: 06-02 Task 3 — pre-flight `webQueueProducer().ping()` at the route top returns 503 BEFORE `prisma.user.create`; the small residual post-create race is accepted and documented in a code comment (dead-men already page Redis outages; forgot-password re-requests enqueue fresh).
3. **Limiter TTL return shape for `Retry-After` (D-06).**
   - What we know: `WINDOW_LUA` returns only the count; the window-reset seconds need PTTL from the same key.
   - What's unclear: none conceptually — extend the script to return `{count, ttl}` (or two KEYS-free returns) and update the two existing call sites' destructuring.
   - Recommendation: extend the script in the same change as the manual-check route; pin with a limiter unit test (count + ttl semantics under first-hit/repeat).
   - Resolution: 06-01 Task 2 — `WINDOW_LUA` extended to also return the key's PTTL in the same atomic command; `rateLimit` returns `{ success, remaining, resetSeconds }` with existing call-site destructuring unchanged (no register/monitors edits in 06-01); pinned by the extended `tests/integration/rate-limit.test.ts` (first-hit vs repeat-hit semantics).
4. **Does the check route keep a `BreakerOpenError` → 503 mapping?**
   - What we know: `enqueueManualCheck` throws `BreakerOpenError` when the breaker is open; in the web process the breaker module is a separate instance whose state is always CLOSED (nothing feeds it), so the gate is inert — Postgres-down surfaces via the route's own prisma read (500 today).
   - Recommendation: keep the catch branch (correct if ever wired) but don't rely on it; the prisma-read failure path governs. Planner disposition, zero code risk.
   - Resolution: 06-01 Task 2 (check-route catch) — the `BreakerOpenError` → 503 branch is kept (correct if ever wired) but not relied upon; the prisma-read failure path governs the 500. Zero code risk, as recommended.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | runtime/build | ✓ | 24.15.0 | — |
| pnpm | package mgmt | ✓ | 10.34.5 | — |
| Docker (+ compose) | test stack (Postgres 5453 / Redis 6390), stand-in rehearsal | ✓ | 29.8.0 | — |
| Test Redis (docker-compose.test.yml) | limiter suites, queue tests | ✓ (via `pnpm verify` bring-up; not running now) | redis:8-alpine (per 04-08 note) | — |
| Playwright browsers | e2e browser project | ✓ (self-resolved 2026-09-16 per deferred-items closure) | @playwright/test | api project unaffected |
| Redis local dev (6390) | web producer local testing | ✓ (docker-compose.dev.yml present; `REDIS_URL=redis://localhost:6390` in local env per 03-01 note) | — | fail-open limiter; producer 503 path is the behavior under test |
| Telegram Bot API | webhook secret round-trip (stand-in smoke) | external service | — | D-30 stand-in smoke uses the refusal path (401) — no live Telegram needed for the negative leg |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none currently missing; the Chromium spawn fault documented 2026-09-16 self-resolved and was closed in deferred-items.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.11 (+ @playwright/test e2e) |
| Config file | `vitest.config.ts` (fileParallelism:false — DB suites share one Postgres), `vitest.config.resilience.ts` (separate) |
| Quick run command | `pnpm test` (vitest run) |
| Full suite command | `pnpm verify` (docker up → lint → typecheck → test → schema:gate → worker:boundary → denylist:diff → build → cron:remnants → e2e) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| API-01 | Check route returns 202 `{jobId, queuedAt}` without executing a check | unit (handler harness) | `pnpm test -- tests/api/monitors-id.handler.test.ts` (extended) + new check-route suite | Partial — monitors-id suite exists; check-route 202 assertions are new (Wave 0) |
| API-01 | Poll completion via lastChecked (client logic) | unit (extracted poll helper) | `pnpm test -- tests/lib/check-now-poll.test.ts` | ❌ Wave 0 |
| API-02 / D-29 | Enqueue rejection → 503 (check, register, forgot-password) | unit + integration | `pnpm test -- tests/api/` (producer fake rejecting) | ❌ Wave 0 |
| SEC-03 / D-20 | Webhook 401 without/with wrong header; 200 with correct (timing-safe) | unit | `pnpm test -- tests/api/cron-and-webhook.handler.test.ts` (webhook half rewritten) | Partial — suite exists with the S-2 red marker to flip |
| SEC-05 / D-06 | Limiter buckets 1/30s + 6/min; 429 carries Retry-After | unit (Redis test stack) | `pnpm test -- tests/integration/rate-limit.test.ts` (extended) | Partial — suite exists; TTL return + manual keys are new |
| SEC-06 | No CRON_SECRET/query-secret remains; D-41 gate extended green | gate | `pnpm cron:remnants` (inside `pnpm verify`) | Partial — gate exists; extension is Wave-0 (deletion release) |
| EML-01 / D-11/D-12 | Provider selection (unset→smtp, console, unknown→throw); console dump shape | unit | `pnpm test -- tests/worker/email-provider.test.ts` | ❌ Wave 0 |
| EML-02 / D-07/D-09 | Render-at-enqueue payload byte-parity (EML-05); backoff table exact values | unit | `pnpm test -- tests/worker/email-lane.test.ts` + `tests/lib/email-render.test.ts` | ❌ Wave 0 |
| EML-03 | Transient rethrow vs UnrecoverableError mapping | unit | `pnpm test -- tests/worker/email-lane.test.ts` | ❌ Wave 0 |
| D-14 / D-18 | Scheduler template dryRun:false; real-pass log/counter | unit | `pnpm test -- tests/worker/scheduler-flag.test.ts` (extended) + `maintenance.test.ts` | Exists — extend assertions |
| D-15 / WR-01 | enqueue-maintenance exits non-zero on unreachable Redis within deadline | integration (script) | `pnpm test --` script smoke or manual stand-in leg | ❌ Wave 0 (script harness) |
| D-16 / IN-04 | renderAlertMessage escapes `& < >`; D-48 pins updated for normal names (byte-identical) | unit | `pnpm test -- tests/worker/outbox-relay.test.ts` (extended) | Exists — extend |
| D-17 | findUnique→findFirst, bare-return→400, typo fix | unit | `pnpm test -- tests/api/monitors-id.handler.test.ts tests/api/monitors.handler.test.ts` (pin flips) | Exists — flip |
| D-22 | getIP spoof trio (no header / multi-entry / unparseable) | unit | `pnpm test -- tests/integration/rate-limit.test.ts` (extended) | Partial |

### Sampling Rate
- **Per task commit:** `pnpm test` (fast subset relevant to touched suites)
- **Per wave merge:** `pnpm verify` (full gate chain incl. build + boundary gates)
- **Phase gate:** full `pnpm verify` green + `pnpm test:resilience` (04-08 discipline) + stand-in live smoke (D-30) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/api/check-route.handler.test.ts` — 202 body, admission semantics (D-28 mirror), 429/Retry-After, 503 mapping (API-01/02, SEC-05)
- [ ] `tests/lib/check-now-poll.test.ts` — extracted poll helper: completion, 30s give-up, quiet handoff (D-01..D-04)
- [ ] `tests/worker/email-lane.test.ts` — processor typed-error split, backoff table, console dump (EML-01..03, D-09/D-10/D-12)
- [ ] `tests/lib/email-render.test.ts` — byte-verbatim template pins vs captured `mail.ts` output (EML-05)
- [ ] `tests/worker/email-provider.test.ts` — EMAIL_PROVIDER selection matrix (D-11)
- [ ] Extended: `tests/integration/rate-limit.test.ts` (TTL return + manual keys + spoof trio), `tests/worker/scheduler-flag.test.ts` (dryRun:false), `tests/worker/outbox-relay.test.ts` (IN-04 escape + D-48 parity), `tests/api/cron-and-webhook.handler.test.ts` (S-2 flip), `tests/api/monitors-id.handler.test.ts` + `tests/api/monitors.handler.test.ts` (D-17 flips)
- [ ] Deletion-release: deleted-suite inventory map (D-27) as a plan artifact; D-41 gate extension cases

*(Framework and infrastructure fully present — no install needed; the gaps are new/extended files only)*

## Security Domain

### Applicable ASVS Categories (Level 1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (unchanged — NextAuth JWT until Phase 7) | Existing `getServerSession` per-route gate preserved on rewritten routes |
| V3 Session Management | no | Unchanged |
| V4 Access Control | yes | Ownership scoping (`findFirst({ id, userId })` per D-17) on the rewritten check route; webhook route's chat-binding write stays keyed to the `/start` userId token |
| V5 Input Validation | yes | SSRF validate-at-create (D-23, `ssrf.ts` pipeline); webhook payload remains shape-checked (`body.message?.text`); URL-only tightening (D-33) |
| V6 Cryptography | yes (compare) | `crypto.timingSafeEqual` for the webhook secret (D-20) — never a hand-rolled constant-time loop |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Secret leakage via query strings (access logs) | Information Disclosure | SEC-06: `?secret=` form + `CRON_SECRET` + cron routes deleted; D-41 gate extended to fail on any reintroduction |
| Webhook spoofing (forged Telegram POSTs binding attacker chat ids) | Spoofing/Elevation | `X-Telegram-Bot-Api-Secret-Token` + timing-safe compare (401); per-IP limiter (D-21) |
| SSRF via monitor URL at create/update (internal network probing) | Tampering/Information Disclosure | `ssrf.ts` DNS-only pre-flight at admission (D-23) + engine per-hop pinning as defense-in-depth; legacy rows editable but never re-validated retroactively (D-25) |
| Rate-limit bypass via XFF rotation | Spoofing | Verified Next-16 stamping semantics + TRUST_PROXY-gated rightmost entry + IP-literal normalization bounding the keyspace (D-22; spoof pins) |
| Enqueue-flood on the manual lane (DoS against the queue/worker) | DoS | Two-bucket per-user limiter (1/30s per monitor, 6/min per user) + priority-1 lane bounded by admission; 429 + Retry-After |
| Email enumeration via forgot-password | Information Disclosure | Existing 200-neutral response preserved verbatim in the rewrite |
| Error-response stack/internal leakage | Information Disclosure | `apiError` helper construction in touched routes (D-32); wire shape `{ error }` byte-identical |
| HTML injection via monitor names/urls into Telegram parse_mode HTML | Tampering | IN-04/D-16: escape `& < >` at the interpolation sites (worker templates + webhook confirmation D-24); D-48 pins updated in-wave |
| Account stranding via degraded register (Redis-down mid-flow) | Denial of Service | Pre-flight Redis liveness → 503 before user creation (Pitfall 6 — planner disposition); D-29 lock honored |

## Sources

### Primary (HIGH confidence)
- Raw source `github.com/vercel/next.js` tag v16.0.10, `packages/next/src/server/base-server.ts` — `x-forwarded-for ??= socket.remoteAddress` stamping semantics (D-22 verification)
- docs.bullmq.io/guide/connections — producer vs blocking connection retry requirements; connection sharing; unreachable-Redis command behavior
- docs.bullmq.io/guide/retrying-failing-jobs — backoff types, `2^(attempts-1)` exponential formula, `settings.backoffStrategy` custom strategies, `-1` semantics
- docs.bullmq.io/patterns/stop-retrying-jobs — `UnrecoverableError` import + overrides-attempts semantics
- core.telegram.org/bots/api — `setWebhook` `secret_token` (1–256 chars, `A-Z a-z 0-9 _ -`) and the `X-Telegram-Bot-Api-Secret-Token` header contract
- Repo reads (all cited with file:line in-body): check route, mail.ts, register/forgot-password/webhook routes, monitors/[id] route, queues.ts, scheduler.ts, maintenance.ts, index.ts (worker), engine/check.ts, persist/outbox.ts + tier1.ts, rate-limit.ts, ssrf.ts, connection.ts (worker + web redis), Dashboard.tsx, playwright.config.ts, check-cron-remnants.mjs, check-worker-boundary.mjs, enqueue-maintenance.mjs, .env.example, 05-REVIEW.md, deferred-items.md, package.json, 03-CONTEXT.md, 01-DISCUSSION-LOG.md (limiter param ratification)

### Secondary (MEDIUM confidence)
- [Vercel docs / GitHub issues via search](https://github.com/vercel/next.js/discussions/49730) — corroborating XFF/population behavior behind proxies
- [Courier: 535 5.7.8 EAUTH](https://www.courier.com) + community sources — Nodemailer error taxonomy corroboration (A1)
- [nodejs.org/api/crypto.html](https://nodejs.org/api/crypto.html) — timingSafeEqual (page truncated during fetch; behavior flagged A2)

### Tertiary (LOW confidence)
- None — no claim in this research rests on uncorroborated tertiary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new packages; every dependency version read from package.json; external semantics verified against official docs
- Architecture: HIGH — all integration points read in-repo with line references; the one novel component (web producer) follows a docs-verified pattern
- Pitfalls: HIGH — WR-01/04-02/05-06 in-repo precedents plus verified doc behavior; MEDIUM only on the Nodemailer taxonomy (A1) and one truncated doc page (A2)

**Research date:** 2026-09-20
**Valid until:** 2026-10-20 (stable domain — pinned library versions; re-check BullMQ docs only if bullmq major bumps)
