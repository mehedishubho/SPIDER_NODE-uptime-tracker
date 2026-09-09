# SpiderNode — Architecture Review

> **Reviewer role:** Principal Backend / Platform Engineer
> **Date:** 2026-09-08
> **Inputs reviewed:** Full repository (current implementation) and [docs/ARCHITECTURE-AUDIT.md](./ARCHITECTURE-AUDIT.md)
> **Scope:** Validation of the proposed modernization — Next.js 16.3, PostgreSQL, Drizzle, Better Auth, Redis, BullMQ, dedicated monitoring worker, Redux Toolkit + Redux Persist, Tailwind v4 + shadcn/ui, Vercel AI SDK, multi-provider email abstraction.
> **Code changes:** None. This document only.

---

## 1. Verdict

# ❌ NOT READY

**The architectural direction is validated. The written design is not yet implementable.**

The mandated topology is correct and confirmed:

```
Next.js (API routes)  →  enqueue jobs only
Redis / BullMQ        →  orchestration, locks, aggregation
Dedicated Worker      →  performs all monitoring execution
PostgreSQL            →  sole source of truth
```

The proposed design already satisfies the hard constraint that **the old in-memory queue must not remain a required source of monitoring state** — `db-batcher.ts` is deleted, transitions are written immediately, and the only buffered state (routine-UP aggregation) lives in Redis, is lossy-tolerable, and nothing depends on it for correctness. PostgreSQL remains authoritative in every scenario examined.

However, the review found **14 blocking issues** in the design as written — several of which would cause *duplicate monitoring jobs*, *duplicate incidents*, *lost or duplicated alerts*, *corrupted counters*, or a *silent monitoring blackout* in realistic failure scenarios. Every blocking issue below has a concrete required resolution. Once the design is amended to incorporate them (all are incremental to the current proposal — none change the target stack), the verdict becomes READY. See §10 for re-review criteria.

---

## 2. What was reviewed and how

- **Current implementation:** every API route, `cron-logic`, `db-batcher`, `instrumentation`, auth/mail/telegram/token/cleanup modules, Prisma schema, deploy workflow, proxy, Redux store, and frontend data-flow patterns.
- **Proposed design:** all 24 sections of ARCHITECTURE-AUDIT.md, with adversarial walkthroughs of: scheduler tick × interval races, worker crash mid-job, BullMQ at-least-once redelivery, retry/backoff storms during a Postgres outage, Redis restarts, multi-worker scale-out, manual-check vs scheduled-check collisions, aggregate-flush vs transition interleavings, and deployment rollback.

---

## 3. Validation of the target architecture

### 3.1 Mandated flow compliance

| Requirement | Status | Notes |
|---|---|---|
| Next.js → enqueue jobs only | ✅ Compliant (post step-5) | Manual check becomes enqueue + read-from-Postgres; `instrumentation.ts` cron deleted at worker cutover. **Required:** API enqueue must fail loudly (503) when Redis is unreachable — never silently no-op. |
| Redis/BullMQ → orchestration only | ✅ Compliant | Locks, aggregation, queues. Redis holds no authoritative state (§13 of audit). |
| Dedicated worker performs monitoring | ✅ Compliant | Check engine lives in worker process only; web never executes checks. |
| PostgreSQL source of truth | ✅ Compliant | Transitions transactional; counters additive; Redis buffers lossy-tolerable. |
| In-memory queue not a required source of monitoring state | ✅ Compliant | Verified: no design element *requires* the Redis aggregate buffer for correctness — losing it costs only a few routine pings, never a transition. |
| AI never in critical path | ✅ Compliant | §18 keeps AI out of check/persist/alert processors, feature-flagged. |
| Email behind provider abstraction, off request path | ✅ Compliant | §17. Note: enqueue failure with Redis down must degrade registration gracefully (see N-6). |
| Rules 1–20 traceability | ✅ | Appendix B of audit holds under review, with the amendments in this document. |

### 3.2 Stack choices — validation notes

| Choice | Verdict | Notes |
|---|---|---|
| Next.js 16.3 App Router | ✅ Sound | `proxy.ts` convention already in use. Caveat: session checks in proxy hit the DB per request under Better Auth DB sessions — see A-2. |
| PostgreSQL + Drizzle | ✅ Sound | Migration mechanics are the risk, not the target — see D-1..D-3, M-1..M-3. |
| Better Auth | ✅ Sound | **Blocking config issue** — password hashing (A-1) and session mode (A-2). |
| Redis + BullMQ | ✅ Sound | Correct tool for the job. Availability and storm behavior must be designed for — R-1..R-3, J-4..J-6. |
| Dedicated worker (PM2 app #2) | ✅ Sound | Correct for single-VPS; scale-out safe once J-1/J-2/D-2 are incorporated. |
| Redux Toolkit + Redux Persist | ⚠️ Keep, but prune | Mandated stack retained; current `auth` slice is dead code and must go. Persist only genuine UI/domain state. Not blocking. |
| Tailwind v4 + shadcn/ui | ✅ Sound | Theme infra plan (audit §19) is correct; class strategy already present. |
| Vercel AI SDK | ✅ Sound | Greenfield, correctly isolated. |
| Multi-provider email abstraction | ✅ Sound | Interface + env selection + queue offload is right. |

---

## 4. BLOCKING ISSUES — must be resolved in the design before implementation

Each issue: the flaw, a concrete failure scenario, and the required resolution. IDs are stable for checklist reference (§9).

### A. Job orchestration & concurrency

**J-1 — Scheduler due-selection race: duplicate checks are structurally guaranteed as designed.**
- *Flaw:* The audit's scheduler tick selects due monitors in SQL (`last_checked + interval <= now`) and enqueues a `check` per monitor. But routine-UP results flow through the ≤60 s aggregation buffer, so `last_checked` in Postgres lags reality by up to ~60 s + flush latency. The next tick (30–60 s later) re-selects the same monitor as "due" and enqueues a second check while the first is in flight or unflushed. Worse, the proposed idempotency key `{monitorId}:{scheduledAt}` changes every tick — it deduplicates retries, **not** cross-tick duplication.
- *Failure scenario:* monitor with 1-minute interval; tick every 60 s; `last_checked` advances on flush → every monitor is re-enqueued each tick regardless of actual check cadence → 2–3× the intended check volume, doubled alert evaluation, wasted egress.
- *Required resolution:* **Claim at selection time, transactionally.** Introduce `monitors.next_check_at` (distinct from `last_checked` — the claim column is missing from the audit's §11 schema). Tick = single transaction:
  ```sql
  WITH due AS (
    SELECT id FROM monitors
     WHERE is_active AND (next_check_at IS NULL OR next_check_at <= now())
     ORDER BY next_check_at NULLS FIRST
     LIMIT 500
     FOR UPDATE SKIP LOCKED
  )
  UPDATE monitors m
     SET next_check_at = now() + (m.interval * interval '1 minute')
   FROM due WHERE m.id = due.id
  RETURNING m.id;
  ```
  Only claimed monitors are enqueued. A failed enqueue (Redis down mid-batch) leaves the claim advanced — acceptable (one missed check) or compensated by rolling back claims for un-enqueued IDs. Idempotency key becomes `check:{monitorId}:{next_check_at epoch}`, which is now unique per schedule *and* per tick. Tick period must be ≤ ½ the minimum supported interval (i.e., 30 s for 1-minute monitors).
- *Also required:* monitor deletion while claimed/queued → job re-reads monitor at execution and no-ops if missing.

**J-2 — BullMQ at-least-once redelivery vs non-idempotent writers.**
- *Flaw:* Worker crash mid-job (or stalled-job detection) re-runs the job. The audit relies on the Redis lock + idempotency key, but the actual DB writers are not idempotent: aggregate flush applies **delta increments** (`total_checks += δ`) which double-count on re-application; alerts re-enqueue.
- *Failure scenario:* worker crashes after the flush transaction commits but before deleting the Redis aggregate hash → retry re-applies the same deltas → counters inflated; uptime percent drifts permanently.
- *Required resolution:* every non-natural idempotent write gets a **transactional guard**: a `write_guards(key TEXT PRIMARY KEY, created_at timestamptz DEFAULT now())` table (or per-purpose equivalent); the flush transaction does `INSERT INTO write_guards(key) VALUES ('flush:{batchId}') ON CONFLICT DO NOTHING` and skips if 0 rows affected. Guard insert and delta apply are in the *same transaction* — a Redis-side guard alone is insufficient (Redis keys can be flushed/lost). Routine ping `createMany` is naturally idempotent only with deterministic ping IDs — see D-3.

**J-3 — Distributed lock spec is incomplete (TTL, renewal, loss semantics).**
- *Flaw:* `SET NX PX` + owner-release is named, but TTL sizing, renewal, and lock-loss behavior are unspecified. Check jobs can exceed any static TTL under load (queue lag doesn't, but slow targets + retry inside the job can); a lock that expires mid-job re-admits a duplicate executor.
- *Required resolution:* lock `lock:check:{monitorId}` with value `{workerId}:{jobId}`; TTL = check timeout (10 s) + 5 s margin; for jobs that can exceed it, renew every TTL/3; on renewal failure the worker **aborts the job** (logs `lock_lost`, discards result) rather than racing. Release only via Lua compare-and-delete by owner. The lock is a performance guard; correctness rests on J-1 claims + J-2 guards + D-2 transition guards — state this explicitly. Configure BullMQ `stalledInterval`/`maxStalledCount` and ensure graceful shutdown (`worker.close()` + PM2 `kill_timeout` ≥ max job duration) so deploys don't manufacture "stalled" jobs.

**J-4 — DOWN results must never be job failures.**
- *Flaw:* Not stated explicitly anywhere in the audit, and it is the classic uptime-monitor/BullMQ bug: if a downed website throws inside the check job, every outage becomes a failing job → 3 attempts × backoff → delayed transitions, retry-storm coupling between customer outages and our queue health.
- *Required resolution:* strict classification in the check processor: **target outcome** (UP, DOWN, timeout, DNS failure, TLS failure) = a *successful job* carrying a result; **infrastructure failure** (Postgres unreachable, Redis error, bug) = the *only* things that throw. Encode as typed result vs thrown error with tests (§23).

**J-5 — Retry storms and unbounded queue growth under a Postgres outage.**
- *Flaw:* The audit specifies retries + backoff but nothing bounds the system when Postgres is down for an hour: the scheduler keeps ticking (each tick fails or enqueues more work), every job fails ×attempts, the backlog compounds, Redis memory grows toward `maxmemory: noeviction` → Redis writes start failing → orchestration collapses. On PG recovery, a thundering herd drains into the DB.
- *Required resolution:* **circuit breaker with three states** — (a) scheduler and check jobs distinguish infra failure from target failure (J-4); (b) on a persist-failure rate above threshold within a window → **OPEN**: pause the scheduler queue and stop enqueueing (`Queue.pause()`), keep draining with bounded attempts; (c) HALF_OPEN: probe with a single job; on success → CLOSED, resume. Bounded attempts (3–5) then dead-letter (BullMQ `failed` retention), never infinite. **Routine checks are droppable under backlog** (skip enqueue when `monitor-checks` depth > ~2× active-monitor count — the next tick re-checks anyway); transitions are not droppable (they're written synchronously inside check jobs). Redis memory alerting at 70 %.

**J-6 — Transition vs routine-write priority is inverted under load.**
- *Flaw:* Transitions are handled inside `check` jobs (correct), but a RECOVERED check can sit behind a deep backlog of stale routine checks → recovery alerts arrive minutes late precisely during incidents, when the backlog is largest.
- *Required resolution:* with J-5's backlog cap the window stays small; additionally use job **priorities** (transitions/manual checks priority > routine) or a separate high-priority check queue for manual checks and for monitors currently in a non-UP state. Document the bounded worst-case latency (queue depth × per-job time ÷ concurrency).

### B. Data correctness & PostgreSQL

**D-1 — Duplicate incidents are possible under concurrency; the schema must enforce the invariant.**
- *Flaw:* The audit prevents duplicate execution via locks, but locks are advisory and BullMQ is at-least-once. Nothing in the schema prevents two executors from both creating an `ONGOING` incident (e.g., stalled-job re-run racing the original), and nothing prevents a monitor from having two `ONGOING` incidents after any bug.
- *Required resolution (both, defense in depth):*
  1. **Conditional transition write** — only the status-flipper proceeds to incident creation:
     ```sql
     UPDATE monitors SET status='DOWN', ... WHERE id=$1 AND status <> 'DOWN' AND is_active RETURNING id;
     -- insert incident/ping/outbox only if a row was returned
     ```
  2. **Partial unique index** — `CREATE UNIQUE INDEX incidents_one_ongoing ON incidents (monitor_id) WHERE status = 'ONGOING';` — makes the invariant physically unviolable.
  Add to the §11 Drizzle schema and the characterization tests.

**D-2 — Transition transaction and alert enqueue atomicity (lost DOWN alerts).**
- *Flaw:* The audit enqueues the alert *after* the persist transaction commits. A crash in between commits the DOWN state but loses the DOWN alert **permanently** (the monitor later recovers; no further alert ever fires). The current system has the mirror-image flaw (alerts before persistence); the proposal must not inherit it.
- *Required resolution:* **transactional outbox** for transition events: inside the persist transaction, insert `outbox(event_type, monitor_id, incident_id, payload, created_at)`; a small relay (BullMQ repeatable job, `FOR UPDATE SKIP LOCKED`, batch) enqueues `alerts` jobs and marks rows sent. This gives at-least-once alerting tied to the durable event. Combined with **D-4 dedup**, duplicates are collapsed.

**D-3 — ID generation is unspecified (silent Drizzle migration trap).**
- *Flaw:* Prisma generated `cuid()` client-side for `pings`/`incidents`/`users`/tokens. Drizzle generates nothing. Bulk ping inserts (the flush hot path) need IDs, and nothing in the audit decides the strategy.
- *Required resolution:* keep `text` PKs (existing IDs preserved); new rows use a DB default (`DEFAULT gen_random_uuid()::text`) or an app-side generator (`nanoid`/cuid2) pinned in the Drizzle column definition — pick one, document it, and verify bulk-insert paths don't rely on client-side generation silently returning `undefined`.

**D-4 — Duplicate alerts and retry-after-success.**
- *Flaw:* Alert queue retries after a send that actually succeeded (response lost, worker crashed post-send) duplicate notifications; state-keyed dedup (`alert:sent:{monitorId}:{state}`) can't distinguish incidents that recur.
- *Required resolution:* dedup keyed to the **incident/transition event**, not the state: `SET NX EX alert:{incidentId}:down` written *after* a confirmed send; retries check the key first. Accept residual at-least-once duplicates as documented behavior (rare, and preferable to silence). Retry count small (≤3). The outbox (D-2) is the event source; Redis dedup is best-effort collapse on top.

**D-5 — Aggregate flush must not be able to regress monitor display fields.**
- *Flaw:* The audit fixes `status` regression (flush never writes status — good) but leaves `response_time` and `last_checked` unguarded. A delayed flush could overwrite a newer response time recorded by a transition.
- *Required resolution:* the flush is one atomic UPDATE per monitor with monotonicity:
  ```sql
  UPDATE monitors SET
    total_checks  = total_checks + $dTotal,
    failed_checks = failed_checks + $dFailed,
    last_checked  = GREATEST(last_checked, $lastTs),
    response_time = CASE WHEN $lastTs > last_checked THEN $lastRt ELSE response_time END
  WHERE id = $mid;
  ```
  Never `status`. Wrapped in the J-2 guard transaction. Counters move to SQL-relative increments everywhere (also in the transition UPDATE).

**D-6 — Uptime semantics: undefined and internally inconsistent.**
- *Flaw:* `uptimePercent` is lifetime counters, but retention deletes pings after 30 days — the number and its evidence diverge, and the nightly `recompute-uptime` job mentioned in the audit has no defined algorithm (recompute from what window? into which field?).
- *Required resolution:* decide (product decision, §6) between lifetime counters (current behavior preserved) vs windowed uptime (24 h/7 d/30 d, industry standard for status pages). If windowed: compute from `pings` using the new `(monitor_id, created_at)` index, store per-window columns, recompute nightly — and keep the lifetime counter as a legacy field until the frontend (final phase) switches. Either way, write the algorithm down before schema freeze.

**D-7 — Ping retention deletes must be batched.**
- *Flaw:* Current `deleteMany` over 30-day-old pings (and the new daily job) is unbounded; on a grown `pings` table this produces long row locks, bloat, and replication/latency spikes on Neon.
- *Required resolution:* batched deletes in a loop (e.g., `DELETE ... WHERE id IN (SELECT id FROM pings WHERE created_at < $cutoff LIMIT 5000)`) until <batch rows; run in the `maintenance` queue only (never inside a check tick — audit already removes the per-tick invocation; keep it that way).

**D-8 — PostgreSQL connection budget is undefined.**
- *Flaw:* Three processes need connections (web, worker, migration runner) plus a transitional second pool (Prisma alongside Drizzle) — against provider limits (Neon's are low, and pooling modes matter). Unmanaged, this surfaces as intermittent `too many clients` during incidents.
- *Required resolution:* explicit budget: one shared `pg` Pool per process with stated `max` (e.g., web 10, worker 20 — worker concurrency 10 ⇒ 20 covers transition-txn + flush overlap; migration runner 1). During the Prisma↔Drizzle transition, share the **same** `pg` Pool instance between both ORMs. Set `statement_timeout`, `idle_in_transaction_session_timeout`, and `pool idleTimeout`; monitor `pg_stat_activity`; use the provider's pooled connection string for web reads; keep direct connections for migrations (DDL over PgBouncer transaction mode is unsafe).

### C. Redis availability & failure modes

**R-1 — Redis is a single point of failure for *monitoring availability*, and the design hand-waves it.**
- *Flaw:* The audit's §13 fallback ("if Redis is unreachable, the worker falls back to writing routine pings straight to Postgres") is incoherent: with BullMQ as orchestrator, **no jobs exist without Redis** — there is nothing to write. A Redis outage silently stops all monitoring: no checks, no transitions, no alerts, while the UI keeps showing the last known (stale) statuses as current. That is the worst possible failure mode for an uptime monitor and it is currently invisible.
- *Required resolution:* accept and engineer for it explicitly:
  1. **No in-process fallback scheduler** — reintroducing one would recreate process-local monitoring state (violates the hard constraint). Redis outage = monitoring pause, by design.
  2. **External dead-man's switch** — the worker's scheduler tick heartbeats healthchecks.io (moved from web cron); a heartbeat gap pages the operator. This is the only independent detection.
  3. **Staleness surfaced in-product** — status page/dashboard render "last checked Xm ago" from `last_checked` and visually degrade stale monitors (already implied by `PublicStatus`; make it a requirement).
  4. **Redis hardening:** AOF (`appendfsync everysec`), supervised auto-restart, `maxmemory-policy noeviction` + memory alerting, and BullMQ-correct client config (two connections: blocking worker connection and queue connection, both `maxRetriesPerRequest: null`; wrong values cause crashes/retry loops).
  5. **Recovery behavior defined:** after Redis restart, repeatable jobs are re-declared (idempotent upsert at worker boot); stale locks expire via TTL; in-flight jobs were lost — the next tick re-claims via `next_check_at` (J-1 makes this safe).
- *Decision needed:* self-hosted Redis on the same VPS (correlated failure with app) vs managed Redis — see §6; managed providers must support blocking commands (BullMQ requirement).

### D. Auth migration (Better Auth)

**A-1 — Password verification config is a blocking pre-migration item, not a spike.**
- *Flaw:* Better Auth's **default password hashing is scrypt**; all existing users have bcrypt hashes. Without explicit custom `password.hash/verify` functions wired to bcrypt, every credentials user is locked out at cutover. The audit defers this to a "spike"; it must be a gate.
- *Required resolution:* configure Better Auth with bcrypt-compatible hash/verify functions up front; store a canary test account's hash through the migration path and verify login **before** flipping any route; new-hash policy decided (keep bcrypt, or lazy rehash-on-login to Better Auth default).

**A-2 — Session architecture: per-request DB hits in proxy + forced re-login.**
- *Flaw:* The audit recommends DB sessions; the `proxy.ts` guard calling `auth.api.getSession` on every `/dashboard` request then costs a DB round-trip per navigation — and cutover invalidates all sessions regardless.
- *Required resolution:* enable Better Auth **cookieCache** (short TTL, e.g., 5 min) so the proxy validates from the signed cookie, with DB as fallback; or move route protection into the dashboard layout (server component) and keep the proxy as a cheap cookie-presence check. Announce forced re-login at cutover (already accepted in audit M2/Migration §21-D6).

**A-3 — Adapter must bind Better Auth to the existing `users` table — no renames.**
- *Flaw:* Better Auth's canonical table names/shapes (`user`, `session`, `account`, `verification`) will not match the existing `users` table out of the box; naive adoption creates a second user table and fractures FKs.
- *Required resolution:* configure the Drizzle adapter with explicit table/model mapping onto **existing** tables and columns (`users` with `id`, `email`, `name`, `image`, `emailVerified`, plus Better Auth-required additions); Better Auth `account` table added new (OAuth rows reshaped per audit §12/§21-D4); `verification`/`session` added new; legacy `sessions`/token tables retained read-only for one release, then dropped. Add Better Auth `admin` plugin (role on user) at the same time — it is the fix vehicle for S-3.

### E. Security

**S-1 — SSRF: the worker becomes an internal-network prober unless explicitly constrained.**
- *Flaw:* The worker executes user-supplied URLs *from inside the trust boundary* — it can reach Redis, Postgres, cloud metadata endpoints, and localhost. The audit flags SSRF as risk R19 but the target design places no enforcement anywhere. `new URL()` validation at the API is insufficient (DNS rebinding, redirects, IPv6 literals, decimal IP encodings).
- *Required resolution (layered):*
  1. **Egress control at the OS/network level** on the worker host: deny private ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10), allow only 80/443 egress.
  2. **Check-engine enforcement:** resolve host → validate ALL resolved IPs against the same denylist *before connecting*; re-validate on every redirect hop (limit hops, e.g., ≤5); allow only `http`/`https` schemes.
  3. **Response caps:** max response size read (e.g., 2 MB) to prevent memory exhaustion/zip-bomb-style attacks; strict 10 s timeout including body drain.
  4. Tests: the §23 suite must include SSRF cases (loopback, private IP, redirect-to-private, metadata IP).
- This is the highest-severity security item in the review.

**S-2 — Telegram webhook remains unauthenticated.**
- *Flaw:* `/api/telegram/webhook` trusts the POST body; anyone can forge `/start {userId}` payloads to link/unlink chat IDs (userId is a guessable-in-scope cuid). Telegram supports `secret_token` webhook verification — unused.
- *Required resolution:* set the webhook with `secret_token` and reject requests whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match; move the handler behind the same validation in the new stack.

**S-3 — Authorization gaps carried into the new design.**
- *Flaw:* `/api/feedback` GET exposes all users' names/emails to any authenticated user (R17); there is no role model; Bull Board (audit §14) would be another unauthenticated surface if added naively.
- *Required resolution:* Better Auth `admin` plugin with `role` on `users`; feedback listing gated to `admin`; any queue-inspection UI behind admin auth + IP allowlist. Rate limiting moves to Redis (R14) — implement with an atomic Lua `INCR`+`EXPIRE NX` (or sliding window) per bucket, and add a **per-user enqueue limiter** on the manual-check endpoint (it currently has none and directly feeds the queue).

**S-4 — Operational secret hygiene.**
- Required (mechanical, phase 0): remove `ngrok` binary + `ngrok.log` from the repo; add `.env.example` (audit lists variables but nothing on disk); error responses must never include stack traces (currently they do); `CRON_SECRET` retires with the cron endpoints — ensure no replacement accepts secrets via query string.

### F. Schema ownership & migration mechanics

**M-1 — Schema ownership and single migration runner must be explicit.**
- *Required resolution:* drizzle-kit versioned SQL files committed to the repo are the **only** schema authority after cutover; exactly one runner applies them (deploy pipeline step), never at web or worker boot (concurrent boot = concurrent DDL). `prisma db push` is deleted from CI in the same PR that lands the baseline. Rule 20 (Prisma removal) is confirmed — no compatibility shim survives step 8.

**M-2 — Rollback compatibility policy absent.**
- *Flaw:* Deploys roll back by redeploying the previous tarball, but migrations are forward-only. If a migration lands and the new web/worker crash-loop, the rollback runs **old code on a new schema**.
- *Required resolution:* adopt **expand/contract** discipline: migrations during the stabilization window are additive-only (new columns nullable/defaulted, new indexes `CONCURRENTLY`); no column drops/renames/retypes until the next release after verification. Verify `readyz` (web + worker) post-deploy before the release is considered good; document the manual `drizzle-kit` down-path for destructive steps.

**M-3 — Baseline from live DDL must be a verified gate, not a step.**
- *Flaw:* Production was built with `db push` — `schema.prisma` may not match reality (most likely drift: `timestamp` vs `timestamptz`, defaults, index differences). Generating the Drizzle schema from the .prisma file instead of the live DB would bake the drift in.
- *Required resolution:* `pg_dump --schema-only` → author Drizzle schema from actual DDL → prove equivalence: `drizzle-kit` diff against the live DB must be **empty** (or an explicitly reviewed, intentional delta list) *before* any application cutover. Add that empty-diff check to CI so schema ownership can't silently drift again.

### G. Deployment topology

**P-1 — Deploy ordering, health gates, and worker shutdown are unspecified.**
- *Required resolution:* pipeline = build (web + worker from one SHA) → backup (`pg_dump`) → `drizzle-kit migrate` (single runner, M-1) → restart **worker** first (`pm2 restart uptime-worker`, waits `readyz`: Redis ping + DB ping) → restart web → smoke-check (enqueue a synthetic check; assert a ping row appears). PM2: `kill_timeout` ≥ max check duration (e.g., 20 s) so workers drain (J-3); `max_restarts`/`min_uptime` for crash-loop visibility; heartbeat + `readyz` wired to PM2 restart and healthchecks.io (R-1). Local dev + CI get docker-compose (Postgres + Redis) — required for the §23 test suites.

---

## 5. Non-blocking issues (fix during implementation, tracked)

| ID | Issue | Where |
|---|---|---|
| N-1 | Frontend dead code: Redux `auth` slice + redux-persist whitelist, `js-cookie` token cookie, RTK Query shell with zero endpoints — prune in phase 0/7; keep Redux for real UI/domain state only | Audit §7/§12 |
| N-2 | Duplicate `<Toaster>` (root + dashboard layout); undeclared `framer-motion` dependency; three dialog systems; three icon libraries — consolidate in final UI phase (rule 19) | Audit §7/§9 |
| N-3 | Client fetch robustness: no `AbortController` on polling fetches; uncleared timers; `window.location.origin` during render (hydration); static "Last updated" timestamp | Audit §7 |
| N-4 | Flapping policy: preserve 1-strike DOWN for behavior compatibility; reserve `consecutive_failures` column for a future threshold — decide in §6, implement later | Audit R6 |
| N-5 | Store richer check metadata (`error_class`: timeout/DNS/TLS/5xx, status code) on pings/incidents now — cheap column, high product value; decide before schema freeze | — |
| N-6 | Email enqueue degradation: if Redis is down, registration email can't enqueue — return a clear 503-style error (or sync-send fallback) instead of a user that can never verify | Audit §17 |
| N-7 | Observability: export BullMQ queue depths, job ages, transition→alert latency; alert on backlog age, not just depth | Audit §15 |
| N-8 | `uptimePercent` double-precision formatting (frontend rounding) once windowed uptime lands | Audit D-6 |
| N-9 | pnpm workspace layout (web + worker sharing types/check engine) or single-package with build targets — pick one and document imports | Audit §15 |
| N-10 | Keep `node-postgres` driver for Drizzle in worker (full transaction support); pooled connection string for web reads on Neon | Audit §11 |

---

## 6. Decisions required from the product owner (before or during implementation)

| # | Decision | Options | Default if unowned |
|---|---|---|---|
| Q-1 | Uptime semantics | Lifetime counters (current) vs windowed 24 h/7 d/30 d | Lifetime now; windowed in final UI phase (D-6) |
| Q-2 | Flapping policy | Keep 1-strike DOWN vs N-consecutive-failures threshold | Keep 1-strike (behavior compatibility) |
| Q-3 | Redis hosting | Self-host on VPS vs managed (must support blocking commands for BullMQ) | Self-host + AOF + external heartbeat |
| Q-4 | Auth cutover comms | Forced re-login announced in-app/email vs silent | Announced (audit M2) |
| Q-5 | Manual check UX | Enqueue + poll result (eventual) vs keep synchronous feel | Enqueue + optimistic read + poll; must respect per-user limiter (S-3) |

---

## 7. Aspects validated as sound (no changes required)

1. **Two-tier batching split** (transitions transactional & immediate; routine UP aggregated ≤60 s with bounded buffers) — correct, with J-2/D-5 guards added.
2. **Postgres-first write ordering** for all critical state — satisfies rules 1 and 13 in every walkthrough scenario.
3. **Scheduler-as-query** (cadence logic in SQL, not per-process timers) — the right call; with J-1 claims it is scale-safe.
4. **Worker concurrency separation** (checks vs alerts vs persistence) — slow Telegram/SMTP can't stall checks; correct.
5. **Email provider abstraction + queue offload** — correct shape; N-6 adds the degradation path.
6. **AI isolation** (flagged, async, user-initiated, outside check/persist/alert) — rule 15 fully honored.
7. **Theme plan** (class strategy exists; identical `:root`/`.dark` palettes today; `next-themes` + token hygiene now, redesign last) — correct sequencing per rules 17–19.
8. **Better Auth table reshaping plan** (§12/§21) — sound once A-1/A-2/A-3 constraints are added.
9. **Characterization-tests-first (§23.1–3)** — the single most valuable safety investment; extend the suite with the SSRF, idempotency, and duplicate-incident cases listed above.

---

## 8. Required design addenda (patch list for ARCHITECTURE-AUDIT.md)

Implement these as amendments before coding begins:

1. **Schema:** add `monitors.next_check_at` (+ index `(is_active, next_check_at)`); add `write_guards` (or equivalent) table; add partial unique index `incidents(monitor_id) WHERE status='ONGOING'`; add `outbox` table (D-2); pin ID-generation defaults (D-3); optionally `pings.error_class` (N-5).
2. **Scheduler spec:** claim transaction (J-1), tick period ≤ ½ min interval, batch limit, failed-claim compensation, backlog threshold gating (J-5).
3. **Check job spec:** result-vs-error classification (J-4), lock algorithm incl. renewal and lock-loss abort (J-3), monitor re-read at execution, SSRF validation pipeline (S-1).
4. **Writer specs:** transition SQL (conditional UPDATE + incident + ping + outbox, one transaction), flush SQL (J-2 guard + D-5 monotonic UPDATE), alert outbox relay + incident-keyed dedup (D-2/D-4).
5. **Resilience spec:** circuit breaker states and thresholds (J-5), bounded attempts + DLQ retention, Redis client configuration and AOF/noeviction (R-1), recovery-after-Redis-restart procedure.
6. **Auth spec:** bcrypt hash/verify config (A-1), cookieCache decision (A-2), adapter table mapping + admin plugin (A-3).
7. **Connection budget:** per-process pool `max`, shared pool during transition, timeouts, pooled vs direct strings (D-8).
8. **Deploy runbook:** ordering, health gates, kill_timeout, backup step, rollback compatibility rule (P-1, M-2, M-3).

---

## 9. Pre-implementation checklist

- [ ] J-1 claim-based scheduling + `next_check_at` in schema; idempotency keys redefined
- [ ] J-2 transactional write guards for flush batches; flush SQL per D-5
- [ ] J-3 lock spec (TTL, renewal, owner-release, lock-loss abort, stalled config)
- [ ] J-4 result-vs-error classification in check processor + tests
- [ ] J-5 circuit breaker + backlog cap + DLQ policy
- [ ] J-6 transition priority policy documented
- [ ] D-1 conditional transition UPDATE + partial unique index + tests
- [ ] D-2 outbox table + relay for alerts
- [ ] D-3 ID generation decided and implemented in Drizzle columns
- [ ] D-4 incident-keyed alert dedup
- [ ] D-6 uptime semantics decision (Q-1) recorded
- [ ] D-7 batched retention deletes
- [ ] D-8 connection budget documented
- [ ] R-1 Redis hardening (AOF, noeviction, client config), heartbeat migration, staleness UI requirement
- [ ] A-1 bcrypt config + canary login test green before auth cutover
- [ ] A-2 cookieCache (or layout-guard) decision
- [ ] A-3 adapter mapped to existing `users`; roles added for S-3
- [ ] S-1 SSRF layers (network egress + resolver checks + redirect revalidation + size caps) + tests
- [ ] S-2 Telegram webhook secret_token
- [ ] S-3 admin gating (feedback, queue UI) + per-user check limiter
- [ ] S-4 repo hygiene (ngrok removal, `.env.example`, no stack traces)
- [ ] M-1 single migration runner; M-2 expand/contract rule; M-3 empty-diff CI gate
- [ ] P-1 deploy runbook with ordering, health gates, kill_timeout, backups

## 10. Re-review criteria (what flips the verdict to READY)

READY is granted when: (1) every checklist item above is incorporated into the design documents (audit amended, or a design-spec addendum authored), (2) the schema addenda are reflected in the target Drizzle schema, and (3) the SSRF and duplicate-incident/duplicate-alert test cases are added to the §23 test plan. No code needs to exist for READY — this is a design-gate review; the issues above are cheap to fix on paper and expensive to discover in production.
