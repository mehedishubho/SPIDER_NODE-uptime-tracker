# Pitfalls Research

**Domain:** Brownfield backend modernization of a live uptime-monitoring SaaS — Prisma→Drizzle cutover on a `db push`-built schema, NextAuth v4→Better Auth cutover, BullMQ/Redis job orchestration, dedicated worker extraction, Next.js 16 App Router traps
**Researched:** 2026-09-08
**Confidence:** MEDIUM overall — every pitfall is grounded in this repo's own audit (`docs/ARCHITECTURE-AUDIT.md`, `docs/ARCHITECTURE-REVIEW.md`) and/or official library docs fetched and read today (Better Auth, BullMQ, Drizzle Kit, PM2, Neon, Next.js — URLs in Sources). The GSD confidence seam classifies all web providers as LOW for this session, so per-claim evidentiary status is annotated inline; items backed only by training data or unverified model summaries are explicitly marked **UNVERIFIED — confirm in phase**.

Scope note: the research search backend was rate-limited this session; findings therefore rest on (a) direct official-docs fetches (highest quality available), (b) the project's two architecture documents (grounded in the actual codebase), and (c) clearly-flagged training-data knowledge.

---

## Critical Pitfalls

### Pitfall 1: Baselining the Drizzle schema from `schema.prisma` instead of the live database

**What goes wrong:**
Production was built with `prisma db push --accept-data-loss` and has zero migration history. The `.prisma` file and the live DDL are two different schema sources, and nobody knows where they diverge. Authoring the Drizzle schema from `schema.prisma` bakes any drift into the new source of truth: the first `drizzle-kit` diff against production then emits destructive statements ("fixing" columns/defaults/indexes that actually exist), or silently omits objects the app depends on.

**Why it happens:**
The schema file *looks* authoritative — it is versioned, readable, and was good enough for `db push` all along. Teams reach for it because reading it is easier than dumping DDL.

**How to avoid:**
- Baseline from reality: `pg_dump --schema-only` of production **plus** `drizzle-kit pull` (introspection — officially supported, verified from orm.drizzle.team) to generate the TS schema from the live DB.
- Prove equivalence before any cutover: `drizzle-kit` diff against the live DB must be empty (or an explicitly reviewed delta list), and that empty-diff check becomes a CI gate so drift can never silently reappear.
- Keep `monitors.id` as integer `serial` and keep table/column names (audit M-5/§11.1) so the baseline stays additive.

**Warning signs:**
- `pg_dump --schema-only` output disagrees with `schema.prisma` on *any* column type, default, or index (check `timestamp` vs `timestamptz`, `responseTime` default 0, missing `monitors(is_active,last_checked)` index).
- The generated baseline migration contains `DROP`, `ALTER TYPE`, or `DROP DEFAULT` statements — a baseline should be a no-op against the DB it was derived from.
- Row-count or checksum mismatches in the D-9 rehearsal data-diff report.

**Phase to address:** Design-addenda + Drizzle adoption phase (audit §24 step 3). The empty-diff CI gate must land in the same PR that deletes `prisma db push` from CI (review M-1).

**Sources:** audit D1/M-3/M-6/M-5; verified: orm.drizzle.team/docs/migrations (`pull`/`push`/`generate`/`migrate` semantics).

---

### Pitfall 2: `timestamp` vs `timestamptz` drift silently shifting every stored time

**What goes wrong:**
Prisma `DateTime` historically maps to PostgreSQL `timestamp` (without time zone) by default; Drizzle's `timestamp()` is also TZ-free unless `withTimezone: true` is set. If the live columns are one type and the new schema declares the other, either the migration rewrites columns (table rewrite + lock) or — worse — the mismatch survives and every `last_checked` comparison in scheduler SQL (`last_checked + interval <= now()`) crosses a TZ conversion boundary. Checks then fire at shifted times, uptime windows drift by the server-TZ offset, and DST boundaries produce one-off surprises that look like "random missed checks."

**Why it happens:**
Both ORMs default to the TZ-less type, so naive porting produces no error — only subtly wrong behavior. `now()` in Postgres is `timestamptz`; comparing it to a TZ-less column implicitly converts using the session timezone.

**How to avoid:**
- Inspect actual live column types from `pg_dump --schema-only` *before* writing the Drizzle schema (audit M-6) — do not assume either default.
- Pin `withTimezone: true` explicitly in the Drizzle schema for all time columns (as sketched in audit §11) and migrate the column type once, deliberately, during a low-traffic window.
- Write the data-diff verification script (audit D-9) to compare timestamp values *as rendered in a fixed TZ*, not as raw strings.

**Warning signs:**
- Data-diff shows all timestamps shifted by a constant offset (often exactly the server UTC offset or 1h at DST).
- Post-cutover, monitors check consistently N hours early/late relative to `interval`.
- `drizzle-kit` diff emits `ALTER COLUMN ... TYPE timestamp WITH TIME ZONE` you did not intend.

**Phase to address:** Drizzle adoption phase (step 3); the live-DDL inspection is a gate inside the design-addenda phase (M-3).

**Sources:** audit M-6/§11.2; the Prisma `timestamp(3)`-without-TZ default itself is **UNVERIFIED this session (training data)** — the audit already mandates live verification, which is the correct prevention regardless.

---

### Pitfall 3: ID-generation gap — Prisma's client-side `cuid()` has no Drizzle equivalent

**What goes wrong:**
Prisma generated `cuid()` IDs *in the client* for `pings`, `incidents`, `users`, and both token tables. Drizzle generates nothing. The moment a write path ports to Drizzle, inserts either fail (NOT NULL violation) or silently insert `undefined`-derived empty IDs. The bulk ping insert — the hottest write path in the system — breaks first. A second-order effect: old rows have cuid-shaped IDs, new rows get a different format, and any code assuming a format (or sorting by ID) misbehaves.

**Why it happens:**
The schema *looks* identical after porting (`text("id").primaryKey()`), and single-row inserts in dev may even succeed if a generator is accidentally still in scope — the failure only shows under the real bulk path.

**How to avoid:**
- Decide once, document it (review D-3): either a DB default (`DEFAULT gen_random_uuid()::text`) on the Drizzle column, or an app-side generator (cuid2/nanoid) *pinned in the Drizzle column definition* so it is impossible to import the table without it.
- Keep existing IDs byte-identical (no regeneration) and keep `monitors.id` as `serial`.
- Add a bulk-insert test to the characterization suite that asserts every inserted ping has a non-empty PK and that old/new IDs coexist.

**Warning signs:**
- `pings.id` values switch format (e.g., cuid → uuid) in the data-diff report.
- Intermittent `null value in column "id"` errors on flush; FK violations from pings/incidents.
- Any code path that built URLs or dedup keys from ID prefixes.

**Phase to address:** Schema addendum decision in the design phase; implementation and tests in the Drizzle phase (step 3), exercised by the worker's bulk write in step 4.

**Sources:** review D-3; audit §10/§11; consistent with verified Drizzle docs (schema declares columns; no implicit default generation).

---

### Pitfall 4: Lost defaults/indexes — `drizzle-kit` will happily drop what your schema forgot to declare

**What goes wrong:**
The live DB contains objects the app depends on but that are absent or mis-declared in the authored Drizzle schema: `isActive`/`lastChecked` defaults, `uptimePercent` default 100.0, the (missing!) hot-path indexes that *should* exist. A `generate`/`push` run treats "not in schema" as "drop it." Conversely, adding the new composite indexes (`pings(monitor_id, created_at)`, `monitors(is_active,last_checked)`, `incidents(monitor_id,status)`) as plain `CREATE INDEX` on a production-sized `pings` table takes a lock that stalls all monitoring writes.

**Why it happens:**
Code-first diffing is only as good as the schema file; and Drizzle's convenience commands are optimized for dev iteration, not production discipline.

**How to avoid:**
- Human-review every generated migration SQL before it is committed — no blind `push` in production, ever (delete `db push --accept-data-loss` from CI in the same PR that introduces `drizzle-kit migrate`, review M-1).
- Enforce expand/contract: during each verification window, additive-only migrations; no drops/renames/retypes until the following release (M-2).
- For the big `pings` index, use `CREATE INDEX CONCURRENTLY` — **note: `CONCURRENTLY` cannot run inside a transaction and drizzle-kit's runner wraps migrations in transactions by default (UNVERIFIED this session)** — plan a custom (empty-statements) migration plus a manual/scripted `CONCURRENTLY` step in the deploy runbook, and verify the exact runner behavior during the Drizzle phase rehearsal.
- Also batch the retention `DELETE`s (review D-7): unbounded deletes on `pings` are the same lock/latency hazard in reverse.

**Warning signs:**
- A generated migration contains `DROP INDEX`, `DROP DEFAULT`, `ALTER ... SET NOT NULL` without a table rewrite plan.
- Deploy log shows the migrate step hanging; `pg_stat_activity` shows a long-running `CREATE INDEX` or `ALTER TABLE` with blocked writers behind it.
- CI empty-diff gate suddenly non-empty after an innocuous schema edit.

**Phase to address:** Drizzle phase (step 3) for the baseline discipline; deploy-runbook work (P-1) owns CONCURRENTLY and batched-delete specifics.

**Sources:** review D-7/M-1/M-2, audit §11.4; verified: orm.drizzle.team/docs/migrations (diff-driven `generate`/`push`); transaction-wrapping detail UNVERIFIED — confirm in phase.

---

### Pitfall 5: Password-hash lockout at the Better Auth flip

**What goes wrong:**
Better Auth's default password hashing is **scrypt** (verified). Every existing user's hash is bcrypt. Without explicit bcrypt-compatible `emailAndPassword.password.hash` / `.verify` functions wired *before* the flip, 100% of credentials users fail to log in at cutover — and because password verification failure and "no such account" look identical, the first signal may be a support-ticket spike, not an error log.

**Why it happens:**
The default works perfectly in a greenfield dev app, so the config gap is invisible until real (old) hashes meet the new verifier. A second, independent landmine: Better Auth stores passwords in the **`account` table with `providerId: "credential"` and `accountId` = user id** (verified) — hashes left in `users.password` with no account row are equally fatal even with correct hashing config ("Without this record, password-based sign-ins will fail").

**How to avoid:**
- Treat this as a **gate, not a spike** (review A-1): configure custom hash/verify wired to bcryptjs up front; decide the new-hash policy (keep bcrypt, or lazy rehash-on-login to scrypt).
- Migrate every non-null `users.password` into a `credential` account row; assert migrated-account count == count of users with a password.
- Canary login: store a known test account's hash through the *actual* migration path and verify login against production data **before** flipping any route (audit D-3).

**Warning signs:**
- Canary login fails on the anonymized prod snapshot during the D-9 rehearsal.
- Count mismatch: credential account rows < users with password hashes.
- Post-flip: credentials logins fail while OAuth logins succeed — the classic signature of this exact pitfall.

**Phase to address:** Better Auth cutover phase (step 7); hash/config decision recorded in the auth design addendum (A-1) before implementation starts.

**Sources:** verified: better-auth.com/docs/authentication/email-password (scrypt default; `emailAndPassword.password.{hash,verify}`; `providerId: "credential"` in account table); better-auth.com/docs/guides/next-auth-migration-guide; review A-1, audit D-3/M-2.

---

### Pitfall 6: OAuth account reshaping done wrong → broken logins or silently duplicated users

**What goes wrong:**
NextAuth `accounts` rows must be reshaped into Better Auth's `account` table with verified renames: `provider`→`providerId`, `providerAccountId`→`accountId`, snake_case token columns→camelCase (`accessToken`, `refreshToken`, `idToken`), `expires_at` (epoch number)→`accessTokenExpiresAt` (timestamptz), `type`/`token_type` dropped. Two failure modes: (a) a mapping miss makes OAuth sign-in fail outright; (b) a subtly wrong `providerId` value makes sign-in *create a brand-new account row and user* instead of matching — the user "succeeds" at logging in and discovers an empty dashboard. Also: Better Auth's `emailVerified` is a **boolean** while NextAuth's is a timestamp (verified) — a type reshape, not a rename.

**Why it happens:**
Column names are deceptively similar (`provider` vs `providerId`), and casing conventions for provider IDs are easy to get wrong — official docs show lowercase `"credential"`; **the widely-repeated claim that social provider IDs must be capitalized (`"Google"`, `"GitHub"`) was seen only in an unverified model summary this session — UNVERIFIED: confirm exact `providerId` casing per provider from the library source or a dry-run login during the Drizzle/auth rehearsal.**

**How to avoid:**
- Write the reshape as an idempotent, re-runnable script (audit D-9): `INSERT ... ON CONFLICT DO NOTHING`, guard columns, run against the anonymized prod snapshot first.
- Preserve refresh tokens verbatim (audit D-4); verify with a canary OAuth login for *each* provider (Google + GitHub) on the rehearsal snapshot and again on prod.
- Reconcile `emailVerified` explicitly: timestamp→boolean conversion with a decided rule (e.g., non-null ⇒ true), and fix the R18 quirk (password reset silently verifying accounts) as a *conscious* decision, not an accident of the reshape.
- Keep user IDs unchanged (text PK is supported; FKs from monitors/feedbacks depend on it).

**Warning signs:**
- OAuth canary login produces a *new* user row (count of users increases) — providerId mismatch.
- Post-cutover dashboards "empty" while login works — user ID drift.
- Refresh-dependent provider flows failing days later (token column mapping miss — refresh tokens only surface when Google/GitHub expire the access token).

**Phase to address:** Better Auth cutover phase (step 7); reshape script rehearsed in the D-9 snapshot rehearsal, which belongs to the Drizzle/foundations work.

**Sources:** verified: better-auth.com/docs/guides/next-auth-migration-guide (full field map incl. emailVerified Date→boolean); review A-3/D-4, audit §12/§21.

---

### Pitfall 7: Session invalidation blast radius — and cookie-cache revocation lag

**What goes wrong:**
Cutover invalidates every session (new session table, new token format, new cookie name `better-auth.session_token`) — accepted (Q-4) but operationally messy. Less obvious, verified gotchas: (a) with `cookieCache` enabled, "revoked sessions may remain active on other devices until the cookie cache expires" — role downgrades and account deletions lag up to the cache TTL; (b) without `cookieCache`, the `proxy.ts` guard calling `auth.api.getSession` costs a DB round-trip per dashboard navigation — and Next.js's own docs (quoted in Better Auth's migration guide) warn that middleware "is not intended for slow data fetching."

**Why it happens:**
The design doc's "DB sessions + cookieCache" line compresses three decisions (session store, cache TTL, proxy behavior) that each have failure modes.

**How to avoid:**
- Enable `session.cookieCache` with a short `maxAge` (e.g., 300s, `strategy: "compact"` — all verified option names) so the proxy validates from the signed cookie with DB fallback; or move route protection into the dashboard layout server component and keep the proxy as a cheap cookie-presence check (review A-2).
- Use `cookieCache.version` bump (verified mechanism) as the deliberate "invalidate everything" lever at cutover rather than an accident.
- Announce the forced re-login (Q-4) *and* keep old NextAuth tables read-only for one release for rollback (audit M-2/D-6).

**Warning signs:**
- Dashboard TTFB regresses measurably right after auth cutover (proxy doing per-request DB session loads).
- Revoked/deleted account still shows dashboard content for minutes (cache TTL) — decide if that's acceptable for account *deletion* specifically; sensitive routes should pass `disableCookieCache: true` (verified query option).
- Users report being logged out twice (stale cookie + new session table).

**Phase to address:** Better Auth cutover phase (step 7); cookieCache/proxy decision is addendum A-2 in the design phase.

**Sources:** verified: better-auth.com/docs/concepts/session-management (cookieCache shape, revocation caveat, `version` bump, `disableCookieCache`, defaults 7d/1d/1d) and better-auth.com/docs/adapters/drizzle; review A-2, audit §12.

---

### Pitfall 8: In-flight verification/reset links and token-flow divergence at cutover

**What goes wrong:**
This app's `verification_tokens` and `password_reset_tokens` tables are *custom* (not consumed by NextAuth). Better Auth brings its own `verification` table and flows. After cutover: every unclicked verification or reset link in users' inboxes points at old routes backed by tables you're about to truncate (D5) — dead links; users who registered 10 minutes before cutover can never verify, and `requireEmailVerification: true` (audit §12) then locks them out entirely. And the current quirk that password reset silently sets `emailVerified` (audit R18) either silently persists or silently *changes* behavior depending on how the flows are ported.

**Why it happens:**
Token flows are "temporary" data, so they get deleted at cutover without anyone tracing which live emails are outstanding.

**How to avoid:**
- Truncate token tables at cutover as planned (D5) **and** point old auth routes at their Better Auth equivalents (or at least a friendly "request a new link" page) for one release.
- Decide R18 explicitly: does the Better Auth reset flow verify-on-reset or not? Write the decision into the auth addendum.
- Since `requireEmailVerification` gates login, make the registration → verification loop the first E2E test (register → verify → login) in the cutover checklist — audit §23.9 already specifies this; keep it in the *deploy* runbook, not just CI.

**Warning signs:**
- Support contacts: "my verification link says invalid" clustered within hours of cutover.
- Registration count vs verified count diverges post-cutover.
- Old token tables still receiving writes after cutover (a route was missed).

**Phase to address:** Better Auth cutover phase (step 7); route-redirect decision in the design phase; E2E smoke in the phase-0 Playwright scaffolding.

**Sources:** audit §6/§12/§21-D5/R18; verified: better-auth.com next-auth-migration-guide (VerificationToken→Verification reshape: composite (identifier,token) PK → single id, token→value, expires→expiresAt).

---

### Pitfall 9: At-least-once redelivery double-writes — stalled jobs meet non-idempotent delta writers

**What goes wrong:**
BullMQ is at-least-once. Verified mechanics: a worker whose event loop is blocked fails to renew its job lock → the job is marked **stalled** → put back in waiting → processed again *while the original may still be running*; after `maxStalledCount` stalls it lands in failed. Separately, PM2's stop/restart sends **SIGINT first and SIGKILLs after `kill_timeout`, whose default is 1600ms** (verified) — a deploy therefore hard-kills workers mid-job by default, manufacturing stalled jobs on every release. When either redelivery path re-runs a non-idempotent writer — the aggregate flush applying `total_checks += δ` — counters inflate permanently and `uptimePercent` drifts.

**Why it happens:**
Two defaults conspire: PM2's 1.6s kill window (deploy = kill field) and BullMQ's stall-and-redeliver semantics (redelivery = correctness hazard). Idempotency stored *only in Redis* doesn't survive Redis loss, so a Redis-side idempotency ledger alone is not a guard.

**How to avoid:**
- Put the guard in the same Postgres transaction as the write: `write_guards(key TEXT PRIMARY KEY)` + `INSERT ... ON CONFLICT DO NOTHING`, skip if 0 rows (review J-2). Delta apply and guard insert commit or roll back together.
- Deploy hygiene (review J-3/P-1): `kill_timeout` ≥ max job duration (e.g., 20s), handle **SIGINT** in the worker (PM2's first signal — verified), call `await worker.close()` (verified: stops fetching, waits for current jobs, *never times out by itself* — so bound the drain yourself), tune `stalledInterval`/`maxStalledCount`, and size concurrency so event-loop blocks are rare.
- Locks are a performance guard; correctness rests on J-1 claims + J-2 guards + D-1 conditional transitions — state this in the design and test it (§23.6 duplicate-check test).

**Warning signs:**
- BullMQ stalled count > 0 after any deploy (check `getEvents`/metrics or the failed set) — with default `kill_timeout` this is guaranteed, not possible.
- `totalChecks` > actual `pings` row count for a monitor; uptimePercent creeping up across restarts.
- Two workers processing the same jobId in logs (`lock_lost` absent).

**Phase to address:** Worker phase (step 4) implements guards, lock spec, and shutdown; PM2 `kill_timeout` + signal handling land in the deploy runbook (P-1) in the same phase; regression tests from §23.6.

**Sources:** verified: docs.bullmq.io/guide/workers (stall mechanics, duplicate processing), docs.bullmq.io/guide/workers/graceful-shutdown (`worker.close()` no self-timeout), pm2.keymetrics.io signals-clean-restart (SIGINT-first, `kill_timeout` default 1600ms, SIGKILL); review J-2/J-3, audit §5 B4.

---

### Pitfall 10: DOWN results treated as job failures → retry storms and unbounded backlog during outages

**What goes wrong:**
The classic uptime-monitor/BullMQ bug (review J-4/J-5): if a downed website's check throws inside the processor, every customer outage becomes 3 attempts × exponential backoff of *failing jobs*. During a *Postgres* outage it compounds: the scheduler keeps ticking and enqueueing, every job fails its attempts, Redis memory grows toward `noeviction` (verified as a hard BullMQ requirement — eviction corrupts BullMQ), Redis writes start failing, orchestration collapses; on PG recovery a thundering herd drains into the DB. Meanwhile RECOVERED alerts sit behind the backlog of stale routine checks — alerts arrive late exactly when incidents are largest (J-6).

**Why it happens:**
"Retry on error" is the default mental model for queues; the domain inversion — *a down target is a successful job carrying a DOWN result; only infrastructure failure throws* — is counterintuitive and is never stated in generic BullMQ material.

**How to avoid:**
- Strict result-vs-error classification in the check processor (J-4): UP/DOWN/timeout/DNS/TLS = typed result; Postgres/Redis/bug = throw. Unit-test the classifier.
- Circuit breaker (J-5): persist-failure rate over threshold ⇒ `Queue.pause()` the scheduler; HALF_OPEN probe; bounded attempts (3–5) then dead-letter; routine checks are droppable under backlog (depth > ~2× active monitors — next tick re-claims anyway via `next_check_at`); transitions never drop (they're written synchronously in the check job).
- Priorities or a high-priority queue for transitions/manual checks so recovery alerts don't queue behind routine work (J-6).

**Warning signs:**
- Failed-job count correlates with *customer* websites going down (the ironic early signal).
- Redis used-memory trending up during a PG outage; alerts at 70% (review J-5).
- Alert latency (incident start → Telegram send) widening during backlog events.

**Phase to address:** Worker phase (step 4) — classification, breaker, DLQ policy in the resilience addendum (J-5); verified `noeviction` config lands in the Redis phase (step 2).

**Sources:** review J-4/J-5/J-6; verified: docs.bullmq.io/guide/connections (`maxmemory-policy noeviction` required), docs.bullmq.io/guide/workers (retry/stall mechanics).

---

### Pitfall 11: Blocking-connection misconfiguration — the wrong ioredis config crashes workers or hangs API routes

**What goes wrong:**
Verified BullMQ requirements that fail loudly or hang silently: (a) a Worker handed a manually-created ioredis client **throws at construction** unless `maxRetriesPerRequest: null`; (b) Workers and `QueueEvents` internally **duplicate** the client for blocking commands — the client must support `duplicate()`; (c) ioredis `keyPrefix` is **incompatible** with BullMQ; (d) producers (your API routes) should keep a *capped* retry count so enqueue fails fast with 503 instead of hanging the request when Redis is down. Plus multiplicity: every Queue/Worker/QueueEvents consumes ≥1 connection each — five queues plus worker pools multiply fast on a single self-hosted Redis.

**Why it happens:**
The web process and the worker need *opposite* retry semantics (fail-fast vs never-give-up) but share one mental model of "the Redis client." Copy-pasting the worker's client config into route handlers (or vice versa) produces either hung requests or crash-looping producers.

**How to avoid:**
- Two explicit client factories in shared code: worker client (`maxRetriesPerRequest: null`) and producer/API client (cap retries ~1–3 so the route returns 503 loudly — review §3.1 requires enqueue to fail loudly, never silently no-op).
- Let BullMQ duplicate for blocking consumers; never set `keyPrefix`; document expected total connection count in the connection-budget addendum alongside the Postgres budget (D-8).
- `readyz` must ping Redis *with the producer client* and the worker must verify it can construct all Workers at boot (config errors surface at startup, verified).

**Warning signs:**
- Worker crash-loops at boot with a config assertion (the `maxRetriesPerRequest` exception).
- `POST /api/monitors/[id]/check` latency spikes exactly when Redis restarts (producer waiting on a capped-retries connection... or an unbounded one).
- `Redis maxclients` or socket-count growth after adding queues/QueueEvents.

**Phase to address:** Redis introduction phase (step 2) for client factories; worker phase (step 4) consumes them; connection budget documented in the design addenda (D-8).

**Sources:** verified: docs.bullmq.io/guide/connections (all four facts, exact option names); review §3.1/D-8/R-1.

---

### Pitfall 12: Repeatable-job drift after Redis restart — plus the v5→v6 API cutover

**What goes wrong:**
Three verified facts combine: (a) repeatable/scheduler config lives **in Redis** — a flush/restart loses it, so the tick silently stops; (b) missed runs are **not backfilled** ("if there are no workers running, repeatable jobs will not accumulate") — downtime during deploys is simply skipped, which is fine for the tick design but catastrophic if you assume catch-up; (c) the next iteration is enqueued **when the current job starts processing**, so a tick job slower than its period makes the schedule fall permanently behind on a single worker. Separately, the `repeat` option was **deprecated in BullMQ 5.16.0 and removed in v6**, replaced by Job Schedulers (`upsertJobScheduler`, `getJobSchedulers`, `removeJobScheduler`) — old tutorials/StackOverflow answers no longer compile, and a v5→v6 bump mid-migration would break the scheduler at the worst time.

**Why it happens:**
"Repeatable jobs are declarative and upserted at boot" (audit M-8) is only true if the boot upsert actually runs on every worker start, uses a stable scheduler key, and the major-version pin is deliberate.

**How to avoid:**
- Re-declare schedulers idempotently at worker boot with `upsertJobScheduler` under a fixed key (verified: same key = update, not duplicate) — this is the M-8 mitigation made concrete.
- Do **not** rely on the repeatable tick as the durability story: the J-1 `next_check_at` claim column makes cadence recoverable from Postgres — a missed tick self-heals on the next tick; state that in the resilience addendum.
- Pin the BullMQ major version at project start and record it (v5 with `upsertJobScheduler`, or v6); never bump it in the same release as any other migration step.
- Size the tick period ≤ ½ the minimum monitor interval (J-1) and keep tick jobs trivially fast (they only claim + enqueue), so the "falls behind" trap can't bite.

**Warning signs:**
- healthchecks.io heartbeat gap right after a Redis restart or VPS reboot (heartbeat moved to the worker tick — R-1).
- Two ticks firing back-to-back after a restart (double upsert under different keys), or tick timestamps drifting apart over days.
- Type errors or missing `repeat` option after a dependency bump.

**Phase to address:** Worker phase (step 4); BullMQ version pinning in Phase 0 (step 0) when the dependency tree is first touched.

**Sources:** verified: docs.bullmq.io/guide/jobs/repeatable (deprecation 5.16→v6, scheduler APIs, no backfill, enqueue-at-start, key upsert semantics); review R-1/J-1/M-8.

---

### Pitfall 13: Monitoring blackout during worker cutover — nobody notices the heartbeat is lying

**What goes wrong:**
The cutover moves the healthchecks.io heartbeat from the web cron to the worker's scheduler tick and deletes `instrumentation.ts` cron after an overlap window. Failure modes: (a) the new worker never actually runs but the *old* heartbeat is still green (or the new one was wired to something trivially alive, like `healthz` process-liveness instead of `readyz` Redis+DB checks); (b) the overlap window runs both paths *without* the new path's increments being SQL-atomic first → lost counter updates (audit M-4); (c) `instrumentation.ts` is "deleted" from the source but still registered because `register()` runs **once per server instance in both nodejs and edge runtimes** (verified) — a stale build, a second PM2 instance, or the edge branch keeps the old cron alive and double-checking.

**Why it happens:**
"Monitoring is fine" is judged by the dashboard, which shows *stale* statuses as current. The only truth is freshness of `last_checked` and who is emitting the heartbeat.

**How to avoid:**
- Overlap window with explicit gates (M3): worker live, `readyz` = Redis ping + DB ping (not just process-up), queue depth ≈ 0, **new-path ping rows visibly appearing** — *then* disable the old cron.
- Make both paths idempotent and make the new path's increments SQL-atomic *before* the first overlap flush (M-4).
- Delete `instrumentation.ts` cron + `CRON_MODE` in the same release that ends the overlap; grep the built output (`.next/`) in CI to assert no cron registration remains.
- Add a staleness monitor: alert when any active monitor's `last_checked` exceeds 2× its interval — the single query that catches every version of this pitfall.

**Warning signs:**
- Heartbeat green but `SELECT count(*) FROM monitors WHERE is_active AND last_checked < now() - (interval * 2)` > 0.
- Cron log lines originating from the web process after the "cutover complete" release.
- Double-frequency checks (each URL checked twice per interval) during overlap — expected, but must return to 1× after.

**Phase to address:** Worker phase (step 4) owns the overlap window and deletion; the staleness query ships in the Redis/observability work (step 2) so it exists *before* the cutover.

**Sources:** verified: nextjs.org instrumentation reference (`register()` once per server instance, both runtimes, must complete before requests); review M-3/M-4/P-1/R-1, audit §8/§24.

---

### Pitfall 14: Two ORMs, one Neon database — the transition connection budget blows up

**What goes wrong:**
During the Prisma↔Drizzle transition, up to five connection consumers exist simultaneously: web (Prisma + Drizzle if not shared), worker (checks + flush + alerts pools), migration runner, `pg_dump` backups. Against Neon, verified limits: `max_connections` 104 at 0.25 CU (7 reserved ⇒ 97 usable), PgBouncer in **transaction mode only**; pooled connections don't support session advisory locks, session `SET`, or SQL-level prepared statements; migrations and `pg_dump` must use the **direct** endpoint. Unmanaged, this surfaces as intermittent `too many clients` / `remaining connection slots are reserved` — typically *during an incident*, when every pool is busiest.

**Why it happens:**
Each library instantiates its own pool by default (the current `prisma.ts` even caches its Pool on `globalThis`); nobody sums them.

**How to avoid:**
- Write the connection budget down (D-8): web 10 / worker 20 / migration runner 1, one shared `pg` Pool instance passed to **both** Prisma adapter and Drizzle during the transition.
- Pooled (`-pooler`) endpoint for web reads; direct endpoint for migrations, `pg_dump`, and anything needing session state.
- Keep transaction-scope locks (Redis per J-3, not Postgres advisory locks) so nothing needs session-level features over the pooled path.
- Set `statement_timeout` and `idle_in_transaction_session_timeout`; watch `pg_stat_activity` count per process during the rehearsal.

**Warning signs:**
- Connection errors that correlate with deploys (migration runner overlapping restarts) or with incidents.
- `pg_stat_activity` showing >60–70 connections from a "small" app.
- Worker pool exhaustion: checks waiting on `query_wait_timeout` (120s, verified, non-configurable) — looks like "queue slow" but is DB-side.

**Phase to address:** Redis/BullMQ phase (step 2) documents the budget; Drizzle phase (step 3) implements the shared pool; deploy runbook (P-1) pins the direct-endpoint rule for migrations/backups.

**Sources:** verified: neon.com/docs/connect/connection-pooling (transaction mode, unsupported features, 104/209/419 limits, direct-endpoint requirement for migrations and pg_dump, `query_wait_timeout=120`); review D-8, audit §22.

---

### Pitfall 15: Next.js process-local leftovers — HMR-cached clients, double cron in dev, and slow middleware

**What goes wrong:**
Three App-Router-specific residues of the old architecture: (a) the `globalThis`-cached Prisma Pool / future Redis clients get imported by *both* the Next server and the worker — in the worker that's a second full pool; in dev, HMR re-executes module scope so `register()`-style bootstrap (and any client construction at module scope) re-runs per rebuild; (b) any cron/scheduler code left in `instrumentation.ts` runs once **per server instance** — a stray dev server pointed at prod DB double-checks every monitor (audit R4 scenario, unchanged by the migration if leftovers exist); (c) after Better Auth, `proxy.ts` calling `auth.api.getSession` per navigation costs a DB hit per request unless `cookieCache` is on — Next.js docs themselves warn middleware isn't for slow data fetching.

**Why it happens:**
Module-scope singletons are idiomatic Next.js for ORMs; the codebase already uses the `globalThis` pattern, and it *works* — until a second process imports the same module.

**How to avoid:**
- Worker code imports from a worker-shared module that constructs its own clients; never import `src/lib/prisma.ts` (web singleton) from `worker/`. Document the boundary (review N-9/N-10).
- CI grep: no `node-cron`/scheduler imports outside `worker/`; no `instrumentation.ts` after cutover (extends pitfall 13's check).
- Keep the proxy's check cheap (cookie presence or cookieCache-backed) per A-2; move real authorization into layouts/route handlers.
- Dev guard: refuse to run monitoring bootstrap when `NODE_ENV=development` and `DATABASE_URL` points at production (cheap env assertion).

**Warning signs:**
- Two sets of check logs in dev after one save (HMR re-register).
- Worker memory/connections ≈ 2× expectation (imported web pool).
- Dashboard TTFB regression localized to `/dashboard/*` navigations after auth cutover.

**Phase to address:** Phase 0 foundations (lint/grep guards, typecheck gate) + worker phase (module boundary); auth phase for the proxy decision.

**Sources:** verified: nextjs.org instrumentation reference (per-instance `register()`, runtimes, `NEXT_RUNTIME` guard); better-auth.com migration guide quoting Next.js middleware caveat; review A-2/N-9/N-10, audit §2/R4.

---

## Technical Debt Patterns

Shortcuts that seem reasonable during this migration but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Keeping Prisma as a "compatibility" read path instead of porting per-module | Faster apparent progress | Two schemas drift; rule 20 violated; the second ORM is the connection-budget killer (pitfall 14) | Never — project explicitly forbids it (audit rule 20) |
| Storing idempotency guards only in Redis | One less table | Guards evaporate on Redis flush; double-applies follow (pitfall 9) | Never — guards must live in the write transaction |
| `drizzle-kit push` for "quick" prod fixes after Drizzle lands | Saves 5 minutes | Recreates the no-migration-history situation this milestone exists to fix | Never in prod; fine in local dev only |
| Keeping manual-check synchronous "one more release" after the queue exists | No UX change to communicate | Two execution paths race the scheduler; per-user enqueue limiter has nothing to limit | Only during the explicit overlap window, behind the J-1 claim guard |
| Hardcoded `kill_timeout` in the deploy script but not in `ecosystem.config.js` | Works today | Next person deploys with defaults (1600ms) and reintroduces pitfall 9 | Never — config lives in the ecosystem file, reviewed in P-1 |
| Skipping the anonymized prod-snapshot rehearsal ("CI tests cover it") | Faster phase 3/7 | CI tests run against schema.prisma-shaped fresh DBs — exactly the wrong schema source (pitfall 1) | Never — D-9 rehearsal is the gate for both Drizzle and auth cutovers |
| Lifetime `uptimePercent` recomputed ad hoc after counter corruption instead of from `pings` | Quick unblock | D-6 semantics question ("recompute from what window?") stays unanswered and recurs | Once, as the *defined* D-6 recovery algorithm — write it down, then automate |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Neon + drizzle-kit | Running `migrate` over the `-pooler` endpoint (transaction mode breaks DDL session assumptions) | Direct endpoint for migrations; `pg_dump` likewise (both verified on Neon docs) |
| BullMQ + ioredis | Setting `keyPrefix` on the shared client; sharing one `maxRetriesPerRequest: null` client between worker and API routes | No `keyPrefix`; two client factories — worker (null retries) vs producer (capped, fail-fast) (verified) |
| BullMQ repeatables | Treating the repeat config as durable and self-healing | `upsertJobScheduler` at worker boot + `next_check_at` claims as the real recovery path; pin BullMQ major (verified deprecation/removal timeline) |
| Better Auth + existing `users` table | Letting `npx @better-auth/cli generate` create a second `user` table | Map the adapter onto the existing table (`user: schema.users` / `modelName` / `fields` — verified adapter options); `account`/`session`/`verification` added new |
| Telegram alerts | Keeping the webhook unauthenticated through the rewrite (S-2) and deduplic alerts by state key instead of incident/transition (D-4) | `secret_token` header check; dedup key `alert:{incidentId}:down` set after confirmed send |
| healthchecks.io | Re-pointing the heartbeat to the worker but leaving the old web-cron ping active | One heartbeat, one owner; the switch happens in the same release as cron deletion (pitfall 13) |
| Hostinger SMTP → email abstraction | Preserving the "await send in request" behavior when wrapping in the abstraction | Enqueue `email-transactional` jobs; degrade loudly (503) when Redis is down (review N-6) |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Scheduler selects all active monitors every tick and filters in JS (current behavior ported forward) | Tick time grows linearly with monitor count; DB round-trips per tick | SQL-side claim (`FOR UPDATE SKIP LOCKED` on `next_check_at`, J-1) with LIMIT | ~a few thousand active monitors on the current 0.25–0.5 CU Neon compute |
| Unbounded retention `DELETE` on `pings` | Cleanup job runs minutes; lock queues block new pings; Neon latency spikes | Batched deletes `LIMIT 5000` in a loop, maintenance queue only (D-7) | When `pings` reaches tens of millions of rows (30-day retention at scale) |
| Creating the new composite indexes as blocking DDL on prod `pings` | Deploy hangs; monitoring writes stall behind the index build | `CREATE INDEX CONCURRENTLY` outside the transactional migration runner (verify runner behavior in rehearsal — pitfall 4) | Immediately on first prod index creation |
| Check worker concurrency sized without the 10s timeout budget | Event-loop saturation → lock renewals missed → stalled jobs (verified stall mechanism) | `concurrency × 10s` budget; start at 10 (audit §15); separate alert/persist pools | First incident wave with many slow/down targets |
| Tick job slower than its period (repeatable "falls behind" semantics) | Scheduler drift, checks perpetually late | Tick only claims + enqueues (fast by construction); keep period ≤ ½ min interval (J-1) | As soon as claim batch size or queue latency grows |

## Security Mistakes

Domain-specific to this migration — the worker extraction changes the threat surface.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Moving URL checking into the worker without SSRF re-validation (S-1) | Worker becomes an internal prober: Redis, Postgres, metadata, loopback all reachable from user URLs; `new URL()` at the API stops nothing (DNS rebinding, redirects, IPv6/decimal literals) | Layered: OS egress denylist for private ranges + resolve-then-validate all IPs per hop (≤5 redirects) + 2 MB response cap + 10s total timeout; SSRF cases in the test suite |
| Trusting the Telegram webhook body through the rewrite (S-2) | Anyone forges `/start {userId}` to link/unlink alert channels | `secret_token` + `X-Telegram-Bot-Api-Secret-Token` header check |
| Adding Bull Board / queue UI without an auth gate (S-3) | Queue contents (URLs, payload data) exposed publicly | Better Auth `admin` plugin role; admin gate + IP allowlist |
| Retiring `NEXTAUTH_SECRET` but keeping `CRON_SECRET`-style secrets in query strings in new endpoints (S-4/R15) | Secret leakage via logs/referrers | Header-only secrets; no replacements accept `?secret=`; strip `err.stack` from all error responses |
| Manual-check endpoint feeding the queue with no per-user limiter (S-3/Q-5) | One user enqueues thousands of checks; queue and egress abused | Redis atomic limiter (Lua `INCR`+`EXPIRE` — pattern UNVERIFIED, use a reviewed atomic script) + per-user enqueue cap |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Silent forced re-login at auth cutover | Users mid-session hit opaque errors; OAuth users re-auth fine but credentials users fear their account broke | Announce (Q-4): banner + email before the flip; login page copy explains "we upgraded sign-in" |
| Manual check flips from instant to enqueue+poll without UI affordance | "Check now" button appears broken (no immediate result) | Optimistic "checking…" state + poll; Q-5 pattern; respect per-user limiter with a clear toast |
| Stale statuses after a Redis outage rendered as current | Users trust green badges while nothing has checked for 10 minutes | "Last checked Xm ago" + visual degradation on staleness (R-1 requirement) |
| Alert semantics change silently (dedup keyed to incidents) | Duplicate or missing DOWN/RECOVERED notifications confuse the incident history | Document at-least-once alerting as known behavior (D-4); surface incident-linked alerts in the UI |
| Light theme infra lands early but token mismatch (sidebar green vs brand red) shows through | Users toggle to light and see broken/inconsistent surfaces | Token hygiene pass (hex → semantic tokens) is prerequisite work in the theme phase, redesign only last (§19) |

## "Looks Done But Isn't" Checklist

- [ ] **Drizzle baseline:** often "generated" but not proven — verify `drizzle-kit` diff against prod is *empty* in CI, not just locally
- [ ] **Auth cutover:** often tested with OAuth only — verify a bcrypt **canary login** against a real migrated hash, plus register→verify→login E2E
- [ ] **OAuth reshape:** often verified for *login*, not for *refresh* — verify refresh-token columns survived mapping (they only matter days later)
- [ ] **Worker deploy:** often "running" without draining — verify `kill_timeout` in `ecosystem.config.js`, SIGINT handler, `worker.close()`, and zero stalled jobs after a deliberate deploy
- [ ] **Idempotency:** often "has a lock" — verify duplicate `check` job delivery produces exactly one ping row and one incident (injection test, §23.6)
- [ ] **Redis config:** often defaults — verify `CONFIG GET maxmemory-policy` = `noeviction`, AOF on, and the producer client fails fast (503) when Redis is down
- [ ] **Cron removal:** often source-deleted but build-stale — verify grep of `.next/` build output shows no scheduler registration; verify single heartbeat owner
- [ ] **Overlap window:** often "briefly overlapped" without gates — verify new-path ping rows appearing + SQL-atomic increments *before* disabling old cron
- [ ] **readyz:** often checks process liveness only — verify it pings Redis (producer client) *and* Postgres before PM2 counts the app up
- [ ] **Rehearsal (D-9):** often run against a fresh docker DB — verify it was run against the *restored anonymized prod snapshot* (the only DB with real drift, real hash formats, real data volume)
- [ ] **Migrations:** often "applied" without a rollback story — verify previous-release web+worker still boots against the migrated (additive) schema

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Credentials lockout post-flip (pitfall 5) | LOW–MEDIUM | Hashes remain intact in `users.password`; fix `password.verify` config + backfill `credential` account rows; users retry — no data loss; communicate |
| Counter/uptime corruption from double-applied deltas (pitfall 9) | MEDIUM | Recompute `totalChecks`/`failedChecks` from `pings` counts; recompute `uptimePercent` per the (pre-decided) D-6 algorithm; run inside maintenance queue |
| Duplicate ONGOING incidents (D-1) | LOW | Dedupe script keeps earliest, resolves the rest; partial unique index prevents recurrence |
| Monitoring blackout after cron deletion (pitfall 13) | LOW | Roll back to the retained previous tarball (P-1 rollback story) or re-enable old cron path; additive schema guarantees old code runs on new schema |
| Redis flush loses queues/schedulers (pitfall 12) | LOW | By design: worker boot re-upserts schedulers; `next_check_at` re-claims on next tick; at most one missed interval per monitor |
| OAuth users locked out by providerId casing mismatch (pitfall 6) | MEDIUM | Update `account.providerId` values in place (case normalization script); no user data harmed; re-run canary logins per provider |
| Migration DDL stuck on a lock (pitfall 4) | MEDIUM | Terminate the migration statement; apply the CONCURRENTLY variant manually; resume pipeline; document in runbook |
| write_guards table itself lost/corrupted | LOW | Guards are derivable: recompute which flush batches landed from `pings`/`monitors` state; guards exist to make double-apply *impossible*, not to be authoritative |

## Pitfall-to-Phase Mapping

Phase numbers follow audit §24 (0 foundations · 1 theme · 2 Redis · 3 Drizzle · 4 BullMQ+worker · 5 thin API · 6 email · 7 Better Auth · 8 Prisma removal · 9 AI · 10 UI). The design-addenda phase (§8 checklist, before step 0) is where each pitfall's *decision* is written down; the phases below are where its *prevention* is built and verified.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1 Baseline from live DDL + empty-diff CI gate | Design addenda (M-1/M-3) → step 3 | CI empty-diff check green; baseline migration is a no-op against prod snapshot |
| 2 timestamp/timestamptz pinned | Design addenda (M-6) → step 3 | Data-diff script: zero timestamp drift on snapshot rehearsal |
| 3 ID generation decided + bulk-insert test | Design addenda (D-3) → step 3/4 | Bulk flush test: every ping has a PK; old/new ID formats coexist |
| 4 Migration review discipline, additive-only, CONCURRENTLY plan | Steps 3 + P-1 runbook | No destructive statements in any migration during window; index creation lock-free on snapshot |
| 5 bcrypt hash/verify gate + canary login | Design addenda (A-1) → step 7 | Canary login green on prod data *before* route flip; credential account count == password user count |
| 6 OAuth reshape + providerId casing verified | Step 7 (script rehearsed in step 3 D-9) | Canary Google + GitHub logins on snapshot and prod; user-count unchanged post-login |
| 7 cookieCache + proxy decision | Design addenda (A-2) → step 7 | Dashboard TTFB unchanged; revocation lag ≤ TTL documented and accepted |
| 8 Token-flow cutover, R18 decision | Design addenda → step 7 | Register→verify→login E2E green post-cutover; no writes to old token tables |
| 9 write guards, kill_timeout, SIGINT, worker.close | Steps 0 (PM2 config) + 4 | Duplicate-delivery injection test: exactly one write; zero stalls after a deploy |
| 10 Result-vs-error classification + circuit breaker | Step 4 (resilience addendum J-5) | Failure-injection tests: PG down ⇒ jobs retry then DLQ; DOWN target ⇒ zero failed jobs |
| 11 Two Redis client factories + connection budget | Step 2 → step 4 | Worker boots cleanly; API returns 503 (not hang) with Redis stopped; `readyz` red |
| 12 Scheduler upsert at boot + BullMQ version pin | Step 0 (pin) + step 4 | Redis restart drill: schedulers reappear, ≤1 missed interval, heartbeat recovers |
| 13 Overlap gates, staleness query, build-output grep | Step 2 (staleness query) → step 4 | Gates green before cron deletion; `last_checked` staleness alert armed; no cron strings in `.next/` |
| 14 Connection budget + shared pool + direct endpoint | Step 2 (budget) → step 3 | `pg_stat_activity` within budget during snapshot rehearsal incl. migration runner overlap |
| 15 Module boundary + HMR/middleware guards | Step 0 (lint/grep gates) → steps 4/7 | No scheduler imports outside `worker/`; proxy latency profile unchanged post-auth |

## Sources

**Project documents (grounded in the actual codebase — highest relevance):**
- `docs/ARCHITECTURE-AUDIT.md` — §5 B1–B6 batcher defects, §9 R1–R22 risks, §20 M1–M12 migration risks, §21 D1–D10 data-migration risks, §24 migration order
- `docs/ARCHITECTURE-REVIEW.md` — §4 blocking issues J-1…J-6, D-1…D-8, R-1, A-1…A-3, S-1…S-4, M-1…M-3, P-1 (each with failure scenarios), §8 required addenda, §9 pre-implementation checklist
- `.planning/PROJECT.md` — binding hard constraints and accepted defaults Q-1…Q-5

**Official documentation fetched and read 2026-09-08 (evidentiary quality high; session seam classifies web providers LOW — treat per-claim annotations as controlling):**
- [Better Auth — Email & Password](https://better-auth.com/docs/authentication/email-password) — scrypt default, `emailAndPassword.password.{hash,verify}`, `providerId: "credential"` in account table
- [Better Auth — NextAuth migration guide](https://better-auth.com/docs/guides/next-auth-migration-guide) — full field mapping incl. `emailVerified` Date→boolean, account/session/verification reshapes, middleware caveat
- [Better Auth — Drizzle adapter](https://better-auth.com/docs/adapters/drizzle) — `provider`/`schema`/`usePlural`/`schemaName`, `user: schema.users` remapping, `modelName`/`fields`
- [Better Auth — Session management](https://better-auth.com/docs/concepts/session-management) — `cookieCache` shape/strategies, revocation-lag caveat, `version` bump, defaults
- [BullMQ — Workers](https://docs.bullmq.io/guide/workers) — stalled-job mechanics, duplicate processing, `stalledInterval`
- [BullMQ — Graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown) — `worker.close()` semantics, no self-timeout
- [BullMQ — Connections](https://docs.bullmq.io/guide/connections) — `maxRetriesPerRequest: null` worker requirement, connection duplication, `keyPrefix` incompatibility, `noeviction`
- [BullMQ — Repeatable jobs](https://docs.bullmq.io/guide/jobs/repeatable) — 5.16 deprecation / v6 removal, Job Schedulers API, no backfill, enqueue-at-start
- [Drizzle ORM — Migrations](https://orm.drizzle.team/docs/migrations) — `generate`/`migrate`/`push`/`pull`/`export`, runtime `migrate(db)`
- [PM2 — Signals and clean restart](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/) — SIGINT-first, `kill_timeout` default 1600ms + SIGKILL, `PM2_KILL_SIGNAL`, `wait_ready`
- [Neon — Connection pooling](https://neon.com/docs/connect/connection-pooling) — transaction-mode PgBouncer, unsupported features, per-compute `max_connections`, direct endpoint for migrations/pg_dump
- [Next.js — instrumentation.js](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation) — `register()` once per server instance, both runtimes, `NEXT_RUNTIME` guard

**Explicitly unverified items flagged in-text (confirm during the indicated phase):**
- Prisma `DateTime` → `timestamp`-without-TZ default (verify via live `pg_dump`; audit M-6 already mandates this)
- Social-provider `providerId` capitalization in Better Auth (verify via library source or dry-run login)
- drizzle-kit migration runner transaction wrapping vs `CREATE INDEX CONCURRENTLY` (verify in rehearsal)
- Redis rate-limiter Lua atomicity pattern (use a reviewed atomic script)

---
*Pitfalls research for: SpiderNode uptime-tracker backend modernization (Prisma→Drizzle · NextAuth→Better Auth · Redis/BullMQ · dedicated worker · Next.js 16)*
*Researched: 2026-09-08*
