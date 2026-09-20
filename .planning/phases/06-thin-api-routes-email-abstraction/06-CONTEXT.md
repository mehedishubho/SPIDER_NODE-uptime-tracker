# Phase 6: Thin API Routes & Email Abstraction - Context

**Gathered:** 2026-09-20
**Status:** Ready for planning

## Phase Boundary

The web app becomes a **stateless producer**: every API route enqueues work and never executes it in-request. Concretely, Phase 6 delivers:

1. **Manual check = enqueue** — `/api/monitors/[id]/check` returns 202 immediately (job to the existing manual lane); the dashboard polls for the result; no API route ever probes a target itself (API-01).
2. **Email off the request path** — register verification + forgot-password render and enqueue onto the `email-transactional` queue; a new worker-side consumer transports bytes through an env-selected provider interface (SMTP default, console dev); `src/lib/mail.ts` dies (EML-01/02/03/05).
3. **Security at the new boundary** — Telegram webhook secret-token auth (SEC-03), per-user enqueue limiter (SEC-05), `CRON_SECRET` + cron routes retire (SEC-06), SSRF validation at monitor create/update, `getIP` hardening (03-REVIEW WR-06).
4. **Deletion release** — cron routes, `cron-logic.ts`, `db-batcher.ts`, `cleanup-logic.ts`, `CRON_SECRET`, and the stale playwright `CRON_MODE=vercel` writer are deleted after a soak, with the D-41 remnant gate extended to keep them out.
5. **Autonomous retention restored** (05-REVIEW WR-03) — daily maintenance flips to real deletes; WR-01/WR-02 and selected Info findings absorbed.

**Not in scope:** the monitoring engine's data path (Tier 1/Tier 2 writers, claim, relay logic beyond IN-04 escaping), any schema migration (Phase 6 ships **zero migrations**), new user-facing features, EML-04 (Better Auth hooks — Phase 7), admin gating (Phase 7), UI redesign (Phase 8).

## Implementation Decisions

### Check-now UX & poll contract (API-01)

- **D-01: Poll monitor data, not job state.** The client reuses the monitor read the dashboard already has; completion = `lastChecked` advances past the enqueue timestamp. Zero new endpoints; web stays a pure Postgres reader and never couples to BullMQ job state. (Manual checks persist synchronously — DAT-01 Tier 1 — so completion is seconds, not the ≤60s Tier-2 window.)
- **D-02: Poll cadence 2s, give up after 30s.** Manual lane is priority 1; checks carry a 10s timeout, so steady-state completion is ~2–12s.
- **D-03: Row state + toast.** Check button disables with spinner/"Checking…" until `lastChecked` advances; toast confirms the fresh result (UP/DOWN + response time). Closest to today's UX.
- **D-04: Quiet handoff on give-up.** Info toast ("Still checking — the result will appear when ready"); polling stops; the dashboard's existing periodic refresh surfaces the result. Never an error state (the job may still be in flight); never auto re-enqueue.
- **D-05: 202 body is `{ jobId, queuedAt }`.** The poll doesn't need it, but jobId gives support/log correlation (04-02 shape: `check-manual:{monitorId}:{epochMs}`).
- **D-06: 429 + `Retry-After` header** (seconds to window reset) + friendly toast. Note: this route has NO rate limit today — 429s are new user-visible behavior, hence the friendly shape.

### Email queue mechanics (EML-01/02/03/05)

- **D-07: Render at enqueue.** Route renders the final `{to, subject, html}` payload; the worker's email job transports bytes through the provider. Self-contained payloads, no web/worker template skew; Phase 7 Better Auth hooks reuse the queue unchanged. EML-05's "template relocated verbatim" = the HTML moves into the lib/email home byte-for-byte.
- **D-08: Both send sites enqueue** — register verification AND forgot-password reset. Same SMTP dependency/degradation story; leaving forgot-password in-request keeps a path where SMTP-down 500s a route.
- **D-09: 5 attempts, exponential from 30s** (~30s / 2m / 8m / 30m / 2h — exhausts ≈2.7h). Generous end of the pinned 3–5 retry convention: an hour-or-two SMTP outage still delivers "arrives once SMTP recovers".
- **D-10: Permanent failure = log + metric only.** Typed unrecoverable failure logs error + feeds a queue counter; no user-facing surface. Strictly better than today (SMTP failure currently 500s the register request).
- **D-11: `EMAIL_PROVIDER` unset/empty → smtp.** Missing var can never break email; `console` is an explicit dev opt-in; an unknown value fails loud at boot (throw-early convention).
- **D-12: Console provider prints the full dump** — recipient + subject + rendered HTML on one structured stdout line.
- **D-13: New `src/lib/email/` module** owns the provider interface, `EMAIL_PROVIDER` selection, render functions (template byte-verbatim from `mail.ts`), and the enqueue helper. `src/lib/mail.ts` is deleted; no in-request transport remains.

### Autonomous retention & 05-REVIEW absorption (WR-03 and friends)

- **D-14: Flip the daily scheduler to real deletes** — `scheduler.ts` maintenance template becomes `dryRun:false` (hardcoded, stale comment fixed); daily 03:15 UTC executes real batched deletes (pings >30d, RESOLVED incidents >90d), restoring legacy daily-cleanup parity. The manual script keeps `--dry-run`/`--apply` flags for operator drills.
- **D-15: Fix WR-01 + WR-02 in Phase 6.** WR-01: bound `enqueue-maintenance.mjs` with a deadline (fail-loud per its own contract — it currently hangs forever on unreachable Redis). WR-02: quit the relay Redis singleton (`disposeRelayRedis`) in `drainAndTeardown` alongside the main client.
- **D-16: IN-04 — HTML-escape `& < >` in worker alert rendering** (monitor name/url interpolation), with D-48 byte-parity pins updated in the same change. Normal names/URLs stay byte-identical; special-char names stop dead-lettering as "permanent" Telegram failures.
- **D-17: Fix the three pinned route defects and flip their pins red→green** — GET `[id]` `findUnique`→`findFirst`; PATCH/DELETE bare-return→400; "Unauthirized"→"Unauthorized" (researcher sweeps client code for string-matching on the typo first). 02-05 pinned these as deliberate Phase-6 red/green markers.
- **D-18: Retention observability = log + metric.** Each real pass logs deleted-row counts and feeds existing worker metrics; failures log error-level. No new dead-man (worker heartbeat already covers a dead tick loop).
- **D-19: Absorb only IN-01 + IN-06** from the nine 05-REVIEW Info findings — IN-06 (cron-remnant gate counting comments; updated anyway when cron remnants die) and IN-01 (empty-string `WORKER_HEALTH_PORT` ephemeral-port guard). The rest stay with their owning changes.

### Boundary security (SEC-03/05/06, WR-06)

- **D-20: Dedicated `TELEGRAM_WEBHOOK_SECRET` env** + a one-time `setWebhook` runbook step; requests without the correct `X-Telegram-Bot-Api-Secret-Token` header get 401 via constant-time compare. Rotation = re-run setWebhook.
- **D-21: Limiter coverage extends to forgot-password (~5/h per IP, register parity) and the telegram webhook (per-IP)** — both reuse the Redis Lua limiter.
- **D-22: Harden `getIP` this phase** (closes 03-REVIEW WR-06): trust only Next-stamped headers; researcher verifies the rightmost-entry logic against Next 16 behavior plus a spoof test.
- **D-23: SSRF validate-at-create using the full `src/lib/ssrf.ts` pipeline** (scheme allowlist + resolve-then-denylist, DNS-only, clear 400 message). The engine's per-hop validation stays as defense-in-depth.
- **D-24: Escape `user.name` in the webhook confirmation** (rides the same change as the webhook-secret work on that route).
- **D-25: PATCH re-validates the URL only when the request changes it** — legacy private-URL rows stay editable rather than bricked.
- **D-26: Release structure = Feature release → soak → Deletion release.** The deletion release removes: `/api/cron/*` routes, `cron-logic.ts`, `db-batcher.ts`, `cleanup-logic.ts`, `CRON_SECRET`, the stale playwright `CRON_MODE=vercel` writer, and extends the D-41 remnant gate.

### Cron deletion & pin fate

- **D-27: Delete the 02-03/02-05 cron characterization pins with an inventory map.** The suites pinning cron-logic/db-batcher/cron-route HTTP contracts are deleted in the deletion release; the plan carries a written inventory mapping each deleted pin to where its guarantee now lives (worker suites from 04/05, D-48 alert pins in worker tests, D-41 gate extended to cover routes + `CRON_SECRET` + cron-logic/db-batcher/cleanup-logic imports). Their pin-until-replaced job is complete.

### Enqueue admission edges

- **D-28: Preserve today's admission semantics for paused/inactive monitors.** The new enqueue route mirrors the old force path byte-for-byte; the researcher pins the current force-path `isActive` behavior first and the new route matches it. Zero new policy in a modernization phase.

### Redis-down on register

- **D-29: 503 refuse when Redis is unreachable** — register AND forgot-password return 503 (API-02's loud-degradation philosophy extended to email enqueue). Redis down is a full infra outage already paging via the worker dead-men; a brief honest refusal beats a silently-swallowed email with no durable outbox to resurrect it from. Login (JWT, no Redis write) keeps working.

### Rehearsal & evidence

- **D-30: Stand-in live smoke, no snapshot restore.** Phase 6 has zero migrations and never touches the monitoring engine's data path, so no D-30-style anonymized-snapshot rehearsal. Rehearsal = deploy the built feature-release artifact to the localhost stand-in (SHA pinning per the 05-07 precedent, `readyz` gates) and live-smoke: check-now 202→poll completion, email round-trip on the console provider + SMTP-fail-then-recover, webhook secret refusal, retention real-delete pass on seeded rows.
- **D-31: ~24h soak between releases.** Real users exercising check-now, at least one real registration, the 03:15 UTC retention pass observed, dead-men quiet — then the deletion release. Matches the M-2 expand/contract precedent and gives rollback its window.

### Route hygiene (minor areas)

- **D-32: `apiError(status, message)` helper in touched routes only.** Wire shape stays byte-identical `{ error }` (characterization pins untouched); construction becomes uniform and leak-proof by construction. No full-codebase sweep; untouched routes keep their current code.
- **D-33: URL-only validation tightening.** SSRF URL validation is the only new validation; name/interval/etc. keep today's exact acceptance behavior. Researcher documents any unvalidated-field gaps as deferred ideas, not new rejections.
- **D-34: Email lane = existing per-queue depth/age gauges + a failed-attempts counter, no dead-man.** Researcher verifies the metrics loop enumerates the email queue once a consumer exists. A dead worker already pages via the heartbeat dead-man; permanent-failure handling is already log+metric-only (D-10).

### Claude's Discretion

None — every question was answered with an explicit choice (all recommended options accepted). The researcher retains only the verification tasks explicitly delegated above (pin current force-path admission semantics, verify rightmost-XFF logic vs Next 16, sweep for typo string-matching, verify metrics-loop enumeration, verify getIP spoof behavior).

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase planning context
- `.planning/REQUIREMENTS.md` — API-01/02, SEC-03/05/06, EML-01/02/03/05 requirement texts (Phase 6 rows)
- `.planning/ROADMAP.md` §"Phase 6" — goal ("stateless producer"), 4 success criteria, Mode: mvp
- `.planning/PROJECT.md` — hard constraints, live-system context, env transition state

### Prior phase decisions (locked — do not re-litigate)
- `.planning/phases/03-redis-drizzle-schema-ownership/03-CONTEXT.md` — Redis limiter design (D-01 fail-open, D-04 key semantics, D-13 limiter params), WR-06 origin
- `.planning/phases/04-monitoring-worker-build-dark-launch/04-CONTEXT.md` — queue topology, D-18 manual lane, D-39 SSRF sharing, D-48 Telegram byte-parity pins, Q-5 enqueue+poll
- `.planning/phases/05-worker-cutover-operational-hardening/05-CONTEXT.md` — D-03/D-38 cron deletion ownership, D-39 env map, D-40 dated paths, D-41 remnant gate

### Review inputs (Phase 6 inputs per STATE.md)
- `.planning/phases/05-worker-cutover-operational-hardening/05-REVIEW.md` — WR-01/02/03 (file/line specifics + suggested fixes), IN-01..IN-09, pinned route defects
- `.planning/phases/05-worker-cutover-operational-hardening/deferred-items.md` — stale playwright writer, stand-in CRON_SECRET mint, junction-shim procedure

### Design & operations
- `docs/ARCHITECTURE-AUDIT.md` — §14 (job/queue specs incl. manual lane), §15 (SSRF pipeline), §23 (test cases); rules 4–6 (routes never execute checks)
- `docs/DEPLOY-RUNBOOK.md` — §4 release ordering, §7 rollback/tarball, §9 emergency lever (amended this phase), §3d rehearsal procedure

## Existing Code Insights

### Reusable Assets
- `src/worker/queues.ts` — `enqueueManualCheck(monitorId)` already exists (jobId `check-manual:{monitorId}:{epochMs}`, priority 1); `QUEUE_NAMES.email = "email-transactional"` + `LANE_PRIORITY.email = 5` already declared — **no email consumer is wired in `src/worker/index.ts` yet**
- `src/lib/rate-limit.ts` — Redis Lua limiter (`rateLimit(identifier, {limit, windowMs})` via `rlIncr`) and `getIP(req)` (currently reads rightmost `x-forwarded-for` — D-22 hardening target); call sites today: register (5/h) + monitors (20/min)
- `src/lib/ssrf.ts` — the full 04-03 pipeline (scheme allowlist, resolve-then-denylist, per-hop pinning) — D-23 reuses it DNS-only at create/update
- `src/lib/mail.ts` — the two exports (`sendVerificationEmail`, `sendPasswordResetEmail`) and the inline HTML template; EML-05's verbatim relocation source; deleted by D-13
- `src/worker/maintenance.ts` (05-06 form) — the real-delete batched logic the scheduler flips onto (D-14)

### Established Patterns
- Throw-early env validation at module load (e.g. `src/redux/api/baseApi.ts`) — D-11's unknown-provider boot failure follows it
- Characterization pin-flipping: 02-05 pinned defects as deliberate Phase-6 red/green markers (D-17); D-48 byte-parity pins updated in-wave with IN-04 escaping (D-16)
- Redis singleton via `globalThis` caching (`src/lib/redis.ts`) — the email enqueue helper and limiter share the web-side connection budget (2 connections)
- Disposition-register/deploy-record evidence files per release (03/04/05 precedent) — D-30/D-31 evidence lands in `06-DEPLOY-RECORD.md`

### Integration Points
- `src/app/api/monitors/[id]/check/route.ts` — rewrite target: currently `runCronChecks(true, monitorId)` + `flushBatches()` awaited in-request
- `src/app/api/auth/register/route.ts` (:71) and `src/app/api/auth/forgot-password/route.ts` (:25) — both await `sendVerificationEmail`/`sendPasswordResetEmail` in-request today
- `src/app/api/telegram/webhook/route.ts` — zero auth today; raw `user.name` interpolation; gets D-20/D-21/D-24
- `src/worker/index.ts` — email consumer wiring point; `drainAndTeardown` gets `disposeRelayRedis` (D-15)
- `scripts/enqueue-maintenance.mjs` — WR-01 deadline fix target
- `playwright.config.ts:63` — stale `CRON_MODE=vercel` writer deleted in the deletion release
- `check-cron-remnants` gate (D-41) — extended in the deletion release to the new deletion set (D-26/D-27)

## Specific Ideas

- Quiet-handoff toast wording: "Still checking — the result will appear when ready" (info-level, never error).
- 429 toast wording: friendly "You're checking too often — try again in Ns" driven by the `Retry-After` value.
- Email retry schedule is exactly ~30s / 2m / 8m / 30m / 2h (5 attempts, ≈2.7h reach).
- D-13 module shape: `src/lib/email/` contains provider interface, `EMAIL_PROVIDER` selection, render functions, enqueue helper — no transport call anywhere in the web process.
- Deletion-release deletion list (verbatim): `/api/cron/*` routes, `cron-logic.ts`, `db-batcher.ts`, `cleanup-logic.ts`, `CRON_SECRET` (code + `.env.example`), playwright `CRON_MODE=vercel` writer, D-41 gate extension, 02-03/02-05 cron pins.

## Deferred Ideas

- Monitor create/update non-URL validation tightening (name length cap, interval bounds) — documented as a deferred hardening pass if the researcher finds unvalidated-field gaps (D-33).
- Email-lane dead-man check (fourth healthchecks.io check for a wedged email queue) — declined for Phase 6; revisit if email lanes grow beyond transactional auth mail (D-34).
- EML-04 (Better Auth hooks delegating to the email queue) — Phase 7 by ROADMAP.
- The remaining seven 05-REVIEW Info findings — stay with their owning changes (D-19).

---

*Phase: 6-Thin API Routes & Email Abstraction*
*Context gathered: 2026-09-20*
