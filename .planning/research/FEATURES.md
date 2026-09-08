# Feature Research

**Domain:** Backend/infrastructure modernization capabilities for a production uptime-monitoring SaaS (brownfield — no new user-facing features)
**Researched:** 2026-09-08
**Confidence:** MEDIUM overall

> **Confidence note (method):** All core mechanics below were verified by fetching primary sources (official BullMQ, Better Auth, Stripe, microservices.io, martinfowler.com, Kleppmann, healthchecks.io docs) and cross-checked against the project's own `docs/ARCHITECTURE-REVIEW.md` blocking issues — findings agree everywhere. The classify-confidence seam rates all web providers LOW (it is calibrated for package-registry lookups), so per-claim tags below are `LOW (fetched primary source)` for verified mechanics and `LOW (training knowledge)` for the few rows where competitor product pages were unreachable (rate-limited). Treat the verified mechanics as planning-grade; treat competitor-convention rows as directional.

**Scope note:** "Features" here are backend capabilities with expected production behavior — not product features. The binding question for each row: *if this is missing, does the modernization fail its own constraints (data loss, duplicate checks/alerts, silent blackout, user lockout)?* If yes → table stakes.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these = the migration ships a defect the current system doesn't have, or reproduces a known one. IDs in parentheses trace to `docs/ARCHITECTURE-REVIEW.md` §4 blocking issues and `docs/ARCHITECTURE-AUDIT.md` sections.

#### A. Job durability guarantees

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Claim-based due-selection in a single transaction (`FOR UPDATE SKIP LOCKED` CTE over `next_check_at`, claims advanced at selection) | At-least-once queueing + a lagging `last_checked` structurally guarantees duplicate checks on every tick otherwise; this is how Oban, River, Graphile Worker, pgmq all do it (J-1) | MEDIUM | Requires new `monitors.next_check_at` column + partial index `(is_active, next_check_at)`; idempotency key becomes `check:{monitorId}:{next_check_at epoch}`; tick period ≤ ½ min interval (30 s); failed-enqueue compensation (accept 1 missed check or roll back claims) |
| Bounded retries with exponential backoff + failed-set (DLQ) retention | Every production queue system bounds attempts; unbounded retry under outage = thundering herd + Redis memory growth (J-5) | LOW | BullMQ `attempts: 3–5`, `backoff: exponential` (+ jitter available), `removeOnFail: { age }` retention; never infinite attempts |
| Target outcome ≠ job failure (typed result classification) | The classic uptime-monitor/BullMQ bug: a DOWN website must be a *successful job carrying a result*; only infra failures (Postgres, Redis, bugs) throw — otherwise customer outages cause retry storms (J-4) | LOW | Strict processor classification + tests; this is the single cheapest correctness rule in the design |
| Graceful worker shutdown that drains jobs | Deploys otherwise manufacture "stalled" jobs and duplicate execution; `worker.close()` waits for in-flight jobs (no internal timeout) (J-3, P-1) | LOW | SIGTERM → `worker.close()`; PM2 `kill_timeout` ≥ max job duration (~20 s); wrap close in an external timeout as safety |
| Stalled-job configuration (`stalledInterval` default, `maxStalledCount` bounded) | BullMQ re-queues stalled jobs *while the original worker may still be running them* — the documented double-processing mechanism; unbounded stalls = unbounded duplicates (J-2, J-3) | LOW | Keep `stalledInterval` default; bound `maxStalledCount`; keep event loop responsive (no CPU-bound processors) |

#### B. Duplicate-execution prevention (defense in depth — locks alone are not correctness)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Distributed lock with full spec: TTL = timeout + margin, renewal every TTL/3, owner-only Lua compare-and-delete release, **abort-on-lock-loss** (discard result, log `lock_lost`) | A lock that silently expires mid-job re-admits a duplicate executor; unspecified locks are theater (J-3) | MEDIUM | Kleppmann's analysis is definitive: Redis locks are *efficiency* guards; expiry mid-execution is unavoidable (GC pauses, network delays) — so correctness must NOT rest on them |
| Transactional write guards (`write_guards` table, guard insert + delta apply in the same Postgres transaction, `ON CONFLICT DO NOTHING` → skip on 0 rows) | Redis-side idempotency keys can be flushed/lost; at-least-once redelivery re-applies delta increments and double-counts uptime counters permanently (J-2) | LOW | Stripe-style stored-result replay generalizes to: guard row = "already applied"; flush key `flush:{batchId}`; correctness lives in Postgres, never Redis |
| Idempotency key per schedule-epoch on every check job | Deduplicates retries *and* cross-tick duplicates once tied to the claimed `next_check_at` (J-1) | LOW | 24 h ledger TTL is plenty at 1-minute minimum intervals |
| DB schema enforcement of invariants: conditional transition UPDATE (`WHERE status <> 'DOWN'`) + partial unique index `incidents(monitor_id) WHERE status='ONGOING'` | Locks are advisory; the schema must make duplicate ONGOING incidents *physically unviolable* regardless of any bug (D-1) | LOW | Both layers required (defense in depth); also `GREATEST()` monotonic flush for `last_checked`/`response_time`, additive counters, flush never writes `status` (D-5) |
| Deterministic ID generation pinned in Drizzle columns (`gen_random_uuid()::text` default or app-side cuid2) | Prisma generated IDs client-side; Drizzle generates nothing — silent `undefined` PKs in bulk-insert hot paths (D-3) | LOW | Decide before schema freeze; keep `text` PKs so existing IDs survive |

#### C. Alert delivery guarantees

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Transactional outbox for transition events (event row inserted inside the persist transaction; relay — repeatable job, `FOR UPDATE SKIP LOCKED`, batched — enqueues `alerts` and marks rows sent) | Enqueue-after-commit loses DOWN alerts permanently if the worker crashes in between (monitor later recovers; alert never fires). The outbox ties alert delivery to the durable event — this is *the* standard fix (D-2) | MEDIUM | microservices.io: guarantee is at-least-once tied to commit, ordering preserved; duplicates arise when the relay crashes post-publish/pre-mark — which is why D-4 exists |
| Incident/transition-keyed alert dedup (`SET NX EX alert:{incidentId}:down` written *after* confirmed send; retries check first) | State-keyed dedup can't distinguish recurring incidents; retry-after-actual-success duplicates notifications (D-4) | LOW | Document residual at-least-once duplicates as accepted behavior (rare, preferable to silence); retries ≤ 3; Redis dedup is best-effort collapse on top of the outbox |
| Alerts flow from a durable event source, not fire-and-forget enqueue | Table stakes across notification systems: the alert-of-record must survive worker restarts | LOW | Satisfied by the outbox; the `alerts` queue processor becomes a consumer of events, not the source of truth |

#### D. Two-tier persistence + resilience

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Two-tier persistence: transitions (DOWN/RECOVERED/incident/first-check/manual) in one synchronous Postgres transaction; routine-UP aggregated ≤ 60 s | Expected shape for monitoring engines: evidence for state *changes* is never lossy; volume evidence may be. Losing a Redis aggregate buffer must cost only a few routine pings, never a transition (audit §16, review §7.1 validated) | MEDIUM | Replaces `db-batcher.ts` entirely; aggregate flush is one guarded atomic UPDATE per monitor |
| Circuit breaker around Postgres: infra-vs-target failure classification → persist-failure rate over threshold → OPEN (`Queue.pause()`, stop enqueueing) → drain with bounded attempts → HALF_OPEN single probe → CLOSED | Without it, a 1-hour Postgres outage compounds backlog + retries until Redis memory hits `noeviction` and orchestration collapses; recovery is a thundering herd (J-5) | MEDIUM | BullMQ `Queue.pause()` is verified to stop pickup without interrupting in-flight jobs — the exact primitive needed; document bounded worst-case latency |
| Backlog cap: routine checks droppable (skip enqueue when `monitor-checks` depth > ~2× active monitors); **transitions never droppable** | The scheduler re-claims next tick anyway — dropping routine work is self-healing; dropping transition evidence is data loss (J-5) | LOW | The asymmetry is the point: document which tier is droppable |
| Redis degradation engineering: no fallback scheduler; external dead-man's switch (healthchecks.io heartbeat moves to worker tick); staleness surfaced in-product ("last checked Xm ago", visual degradation); AOF `appendfsync everysec`; `maxmemory-policy noeviction`; correct client config (blocking + queue connections, `maxRetriesPerRequest: null`); recovery procedure (repeatable-job upsert at boot, stale locks TTL-expire, next tick re-claims) | With BullMQ, no Redis = no jobs = monitoring silently stops while the UI shows stale statuses as current — the worst failure mode for an uptime monitor and invisible without an external watchdog (R-1) | MEDIUM | healthchecks.io confirms the mechanics: Up → Late (grace) → Down alerts; *absence* of the ping is the signal. Monitoring pause is accepted-by-design; detection is the requirement |
| Batched retention deletes (loop `DELETE ... LIMIT 5000` until dry; maintenance queue only) | Unbounded `deleteMany` on a grown `pings` table = long row locks + bloat + latency spikes on Neon (D-7) | LOW | 30/90-day rules unchanged |

#### E. Queue-health observability

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Exported queue metrics: depth per queue, job age (not just depth), stalled count, transition→alert latency, Redis memory %, outbox age | Production queueing without visibility is unobservable; alert on backlog *age*, not just depth (N-7, J-5) | LOW–MEDIUM | BullMQ `QueueEvents` (Redis streams, delivery guaranteed across disconnects) + counters; healthchecks.io memory alerting at 70 % |
| Worker health surfaces wired to restart + external pager: `:9090/healthz` (process up), `/readyz` (Redis ping + DB ping), heartbeat on scheduler tick | PM2 and healthchecks.io need *something* to watch; without readyz, a crash-looping worker looks deployed (P-1, R-1) | LOW | readyz gates the deploy (release counts as good only after green) |
| Structured logs with `monitorId` correlation | Incidents are debugged across scheduler → check → persist → alert; uncorrelated logs make the queue opaque (audit §15) | LOW | Cheap at worker-authorship time, painful to retrofit |

#### F. Migration safety nets

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Characterization tests pinning `runCronChecks`, db-batcher math, and API contracts **before** any rewrite | The project has zero tests and a live production system; golden-master tests detect change (not correctness) and are the standard pre-rewrite net — review calls this "the single most valuable safety investment" (§23.1–3, review §7.9) | MEDIUM | Vitest + docker-compose Postgres/Redis; extend with SSRF, idempotency, and duplicate-incident cases per review §10 |
| Schema baseline from **live DDL** (`pg_dump --schema-only`) + empty-diff CI gate + single migration runner in the deploy pipeline | Production was built with `db push --accept-data-loss`; `schema.prisma` may drift from reality — baselining from the file bakes drift in; concurrent boot DDL corrupts (M-1, M-3) | MEDIUM | drizzle-kit diff vs live DB must be empty (or explicitly reviewed) before cutover and forever after in CI |
| Expand/contract discipline: additive-only migrations during each verification window; drops/renames/retypes deferred to the following release; old tables retained read-only one release | Rollback = old code on new schema; any non-additive step in the window strands the rollback tarball (M-2) | LOW (discipline, not code) | Fowler's Parallel Change: expand → migrate → contract; code releasable at every phase; never finishing contract leaves a worse state than start — schedule the contract steps |
| Overlap window with both cron paths idempotent before deleting `instrumentation.ts` | Zero-gap monitoring cutover; both paths idempotent means overlap wastes checks, never corrupts (M3, M-4) | MEDIUM | healthchecks.io + queue-depth ≈ 0 as the flip criteria |
| Pre-cutover `pg_dump` backup + anonymized-prod-snapshot local rehearsal | Rehearsal without staging infra; backup before every production cutover until the verification window closes (D-9, D-10) | LOW | Dry-run Drizzle baseline, auth cutover, data-diff locally |
| Canary login through the preserved hash path **before** flipping any auth route | The auth cutover is the one step that can lock every user out irrecoverably; a canary account proves the bcrypt verify path (A-1, §21-D3) | LOW | Store a canary hash through the migration, verify login on staging snapshot, then prod |
| Behavior-compatibility pins: 1-strike DOWN, lifetime uptime math, Telegram alert content, public API shapes | The modernization's core promise: semantics preserved through cutover; the characterization suite is what proves it | LOW | Q-1/Q-2 defaults recorded in PROJECT.md |

#### G. Auth, email, AI, theme (migration-adjacent capabilities)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Better Auth configured with custom bcrypt `password.hash`/`verify` **as a gate, not a spike** | Verified: Better Auth's default is **scrypt**; every existing user has bcrypt — without the override, all credentials users are locked out at cutover. `verify({ password, hash })` also enables prefix-routing ($2 → bcrypt) and lazy rehash later (A-1) | LOW | Official docs confirm the exact config shape; wire before any route flips |
| Adapter bound to the existing `users` table (explicit table/column mapping); `account`/`session`/`verification` added new; roles via admin plugin | Naive adoption creates a second user table and fractures FKs (A-3) | MEDIUM | Legacy `sessions`/token tables retained read-only one release, then dropped (contract step) |
| Session strategy decision: cookieCache (short TTL) or layout-guard, accepting announced forced re-login | Per-request DB session checks in proxy against Neon's connection limits; cutover invalidates sessions regardless (A-2) | LOW | Announcement (Q-4) is part of the feature |
| Email behind a provider interface (`send()`), env-selected provider, **queue offload** (5 attempts, backoff), typed retryable-vs-permanent errors, degradation path when Redis is down | SMTP latency/outage must not fail signup; hopeless sends must not retry forever; a user that can never verify is a silent account loss (audit §17, N-6) | LOW–MEDIUM | Callers depend only on `send()`; Better Auth hooks delegate to the same queue |
| AI strictly feature-flagged (`AI_ENABLED=false`) and outside the monitoring critical path | Expected hygiene for any AI addition to an infra product: AI outage must be invisible to uptime accuracy (§18, rule 15) | LOW (flag + boundaries) | Endpoints auth-gated, rate-limited, size-capped, timeouts, streaming |
| Theme infrastructure early: `next-themes`, real light `:root` tokens, today's dark values as `.dark`, toggle, resolved-theme to Toaster — separate from any redesign | Sequencing requirement: stable tokens before the final redesign phase; changing palettes mid-backend-migration churns every component (§19, rules 17–19) | LOW–MEDIUM | Plus mechanical token hygiene (hardcoded hex → semantic tokens) as prerequisite, not redesign |
| SSRF layering in the check engine: OS/network egress denylist, resolve-then-validate all IPs per hop, redirect revalidation (≤5 hops), scheme allowlist, 2 MB response cap, strict 10 s timeout | The worker is an internal-network prober running user-supplied URLs from inside the trust boundary — the review's highest-severity security item (S-1) | HIGH | Network layer + engine enforcement + response caps + tests (loopback/private/redirect-to-private/metadata) |

### Differentiators (Competitive Advantage)

Not required by the constraints, but valuable robustness or DX beyond minimum. Sequenced only after table stakes in each area.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| High-priority queue (or explicit priorities) for manual checks and monitors currently in non-UP state | Recovery alerts arrive fastest precisely during incidents, when the backlog is deepest (J-6) | MEDIUM | J-6's minimum is *documented worst-case latency*; a separate queue is the upgrade beyond it |
| `error_class` check metadata on pings/incidents (timeout/DNS/TLS/5xx + status code) | Cheap column, high product value; enables better incident summaries later (N-5) | LOW | Decide before schema freeze; pairs with future AI incident summarization quality |
| Outbox age + dead-letter alerting (alert on `outbox` rows older than N seconds) | Turns the alert-delivery guarantee into a monitored one; catches a dead relay independently of queue depth | LOW | Natural extension of N-7 + D-2 |
| Prometheus export (BullMQ telemetry + custom gauges) + dashboard | Beyond log/heartbeat minimum; trends backlog age, lock losses, breaker state changes over time | MEDIUM | BullMQ has a Prometheus guide + OpenTelemetry traces; optional infra dependency — only if operator appetite exists |
| Admin-gated queue inspection UI (Bull Board behind admin auth + IP allowlist) | Operational DX for a solo operator; S-3 requires the gate if added | LOW | Differentiator only *because* the secure version needs roles first |
| Lazy rehash-on-login (bcrypt verify → upgrade hash to scrypt/argon2 on successful login) | Progressive security modernization with zero lockout risk — `verify` receives the hash, so prefix-routing is trivial (A-1 new-hash policy option) | LOW | Pure win; not required for migration correctness |
| Windowed uptime backend built behind a flag early (per-window columns + nightly recompute from pings) | De-risks the final UI phase by landing the D-6 algorithm and nightly job while behavior compatibility still holds lifetime counters | MEDIUM | Q-1 default defers this; building it early is optional insurance |
| Flagged AI capabilities: incident summarization (post-mortem draft), monitor-setup assistant (NL → validated config JSON) | The milestone's only forward-looking product surface; safely isolated and off by default (§18) | MEDIUM | Schema validates AI output with the same zod schema as the manual form; never auto-executed |
| Dry-run/diagnostic mode for maintenance jobs (retention deletes report row counts without deleting) | Operational confidence during the first weeks the cleanup job runs in the worker (D-7) | LOW | Cheap to add while writing the processor |

### Anti-Features (Commonly Requested, Often Problematic)

Deliberately NOT built — each is either explicitly rejected by the review/audit or contradicts a hard constraint.

| Feature | Why Requested / Tempting | Why Problematic | Alternative |
|---------|--------------------------|-----------------|-------------|
| In-process fallback scheduler when Redis is down ("keep monitoring through the outage") | Sounds like higher availability; the audit §13 originally proposed it | Incoherent with BullMQ: no Redis = no jobs = nothing to run; recreates process-local monitoring state, violating the hard constraint — and hides the outage instead of surfacing it (R-1) | Accept monitoring pause as designed; detect via external heartbeat gap; surface staleness in-product |
| Dual-write period (Prisma + Drizzle writing the same tables "for safety") | Feels safer during ORM migration | Two ORMs, two type systems, one schema → divergence and double-writes; the exact corruption M1 warns about | Cutover by module; Drizzle owns schema from day one; share one `pg` Pool during transition; Prisma deleted at the end |
| AI in the check → transition → alert path ("smart alerting now") | Product appeal | AI outage/degradation would corrupt uptime accuracy — a monitoring product whose alerts depend on an LLM (rule 15) | AI only in user-initiated, flagged, async endpoints |
| Exactly-once delivery infrastructure ("eliminate duplicate alerts/checks completely") | Stakeholder request; sounds strictly better | Exactly-once across independent systems is impossible (relay crash post-publish/pre-mark); building for it produces fragile, unprovable machinery | At-least-once (outbox) + transactional guards + incident-keyed dedup + documented residual duplicates |
| Redlock / multi-node distributed consensus for locks | "Stronger locks" | Kleppmann: Redlock lacks fencing tokens, depends on a synchronous system model real systems don't satisfy; wrong at single-VPS scale | Single Redis `SET NX PX` + owner-release + renewal + abort-on-loss; correctness from DB guards (J-1/J-2/D-1) |
| Redis as authoritative state (pending jobs, "the queue is the truth") | Natural when Redis runs the scheduler | One `FLUSHALL`/failover away from losing monitoring state; violates "Postgres is always the source of truth" | Claims live in Postgres (`next_check_at`); Redis holds only lossy-tolerable buffers, locks, caches |
| Windowed uptime (24h/7d/30d) display now | Industry standard; users ask for it | Changes public numbers mid-migration; the D-6 algorithm is undefined until written down; collides with the final UI phase | Lifetime counters preserved through v1; windowed lands with the final UI phase |
| Incident alert emails this milestone | Obvious next feature | Expands the alert surface mid-migration; Telegram-only is the compatibility contract | Email abstraction built now, alert channel reused from it later (UPGRADE_PLAN phase 7) |
| N-consecutive-failure DOWN threshold now | Reduces flapping alerts | Changes alerting semantics the characterization tests pin; masked flapping vs missed outage is a product decision (Q-2) | Keep 1-strike DOWN; reserve `consecutive_failures` column |
| Synchronous manual check in the web process (status quo UX) | "Feels faster" | Web process executes checks → the thing rule 4 forbids; unbounded load straight into the queue | Enqueue + optimistic read + poll, per-user rate limited (Q-5) |
| Dropping transitions under backlog ("shed load fairly") | Simple load shedding | DOWN/RECOVERED evidence is the product; dropping it = silent data loss during the worst moments (J-5 asymmetry) | Shed routine checks only; transitions written synchronously inside check jobs |
| Migrations running at web/worker boot | Convenient | Concurrent boot = concurrent DDL; crash-loop boot loops against a half-migrated schema | Single runner in the deploy pipeline, before restarts (M-1) |
| Unauthenticated queue-inspection UI (naive Bull Board) | Fast to add | Another unauthenticated surface exposing monitor IDs, payloads, infrastructure shape (S-3) | Admin gate + IP allowlist, or logs/metrics only |

---

## Feature Dependencies

```
[Phase 0 characterization tests] ──pins──> [all rewritten behavior]

[Drizzle baseline from live DDL] ──requires──> [empty-diff CI gate]
        └──requires──> [schema addenda: next_check_at, write_guards,
                        partial unique index, outbox, ID defaults]

[Redis introduction] ──requires before──> [BullMQ worker]
[BullMQ worker] ──requires──> [claim-based scheduler (J-1)]
        └──requires──> [typed result classification (J-4)]
                 └──enables──> [circuit breaker (J-5)]
        └──requires──> [locks + guards (J-2/J-3)] ──enables──> [scale-out path]
        └──requires──> [two-tier persistence] ──requires──> [outbox (D-2)]
                                   └──requires──> [incident-keyed dedup (D-4)]
[Worker] ──requires──> [healthz/readyz + heartbeat] ──enables──> [cron deletion]
[Thin API routes] ──requires──> [worker exists] + [Redis rate limits]
[Email queue offload] ──requires before──> [Better Auth hooks] (audit §24: 6 → 7)
[Auth cutover] ──requires──> [bcrypt hash/verify config] + [canary login] + [characterized auth contracts]
[Prisma removal] ──requires──> [all read paths ported] + [one release of stability]
[AI flagged endpoints] ──requires──> [Redis limiter] + [stable Drizzle read paths]
[Theme infra] ──requires before──> [final visual redesign]
[Visual redesign] ──requires──> [stable APIs] (post Prisma removal)
[Windowed uptime (v2)] ──requires──> [D-6 algorithm written] + [final UI phase]
[Email alert channel (v2)] ──requires──> [email abstraction] + [outbox (D-2)]
```

### Dependency Notes

- **Circuit breaker requires result-vs-error classification:** the breaker can only trip on *infrastructure* failure rates; without J-4's typed classification, a customer's website going down would trip it and pause all monitoring.
- **Outbox requires transitions-in-one-transaction:** the event row is only atomic with the state change if both are in the same transaction; adding the outbox after-the-fact to a split writer is a rewrite.
- **Cron deletion requires the heartbeat:** the external dead-man's switch must first watch the worker's tick, or deleting `instrumentation.ts` removes the only independent liveness signal.
- **Characterization tests conflict with behavior changes in the same phase:** they pin 1-strike DOWN, lifetime uptime, Telegram content, and API shapes — any phase that wants to change semantics must change the pins deliberately (post-milestone).
- **Better Auth hooks require the email queue:** wiring `sendVerificationEmail` to a synchronous SMTP call would reintroduce the in-request email defect the abstraction removes.

---

## MVP Definition

For a brownfield modernization, "MVP" = the modernization complete with every hard constraint satisfied. The launch gate is the review's READY-flip plus all table stakes above.

### Launch With (v1)

- [ ] Claim-based scheduler + `next_check_at` + redefined idempotency keys — J-1; duplicate checks are otherwise structural
- [ ] Transactional write guards + monotonic flush — J-2/D-5; counter corruption is permanent otherwise
- [ ] Lock spec (TTL, renewal, owner-release, abort-on-loss) + stalled config — J-3
- [ ] Result-vs-error classification + tests — J-4; cheap and load-bearing
- [ ] Circuit breaker + backlog cap + bounded attempts/DLQ — J-5/J-6
- [ ] Conditional transition UPDATE + partial unique index — D-1
- [ ] Transactional outbox + incident-keyed dedup — D-2/D-4
- [ ] ID generation pinned in Drizzle columns — D-3
- [ ] Batched retention deletes; connection budget — D-7/D-8
- [ ] Redis hardening + external heartbeat + staleness UI + recovery procedure — R-1
- [ ] Queue metrics export + healthz/readyz + correlated logs — N-7/P-1
- [ ] Characterization tests (cron/batcher/API) before any rewrite — §23
- [ ] Live-DDL baseline + empty-diff CI + single migration runner — M-1/M-3
- [ ] Expand/contract discipline + overlap window + backups + rehearsal — M-2/M3/D-9/D-10
- [ ] bcrypt-compatible Better Auth + canary login + adapter mapping + cookieCache + admin plugin — A-1/A-2/A-3
- [ ] Email abstraction + queue offload + degradation path — §17/N-6
- [ ] SSRF layering + webhook secret + admin gating + secret hygiene — S-1..S-4
- [ ] AI flag-off skeleton boundaries; theme infra with real light tokens — §18/§19

### Add After Validation (v1.x)

- [ ] High-priority transition/manual-check queue — once real backlog data shows worst-case alert latency (J-6 upgrade)
- [ ] `error_class` metadata — before schema freeze if cheap, else first additive migration after cutover
- [ ] Outbox-age and dead-letter alerting — after one week of production outbox operation
- [ ] Lazy rehash-on-login — any time post-cutover; zero risk
- [ ] Admin-gated Bull Board — after roles (admin plugin) are live
- [ ] Prometheus/Grafana export — if operator appetite exists after a month on logs + heartbeat
- [ ] AI features enabled per-user behind the flag — after the pipeline is stable for a release cycle

### Future Consideration (v2+)

- [ ] Windowed uptime 24h/7d/30d — with the final UI phase (D-6/Q-1)
- [ ] N-consecutive-failure flapping threshold — after windowed uptime reframes alert semantics (Q-2/N-4)
- [ ] Incident alert emails via the abstraction — UPGRADE_PLAN phase 7
- [ ] Advanced monitor types (keyword/TCP/SSL) — frozen until after migration (M12); reserved columns only
- [ ] Multi-instance scale-out exercise — the path is safe by construction (J-1/J-2/D-2); not exercised in v1

---

## Feature Prioritization Matrix

| Feature | User Value (operator/user impact) | Implementation Cost | Priority |
|---------|-----------------------------------|---------------------|----------|
| Claim-based scheduling (J-1) | HIGH | MEDIUM | P1 |
| Result-vs-error classification (J-4) | HIGH | LOW | P1 |
| Write guards + monotonic flush (J-2/D-5) | HIGH | LOW | P1 |
| Schema invariants (D-1/D-3) | HIGH | LOW | P1 |
| Transactional outbox + dedup (D-2/D-4) | HIGH | MEDIUM | P1 |
| Circuit breaker + backlog cap (J-5/J-6) | HIGH | MEDIUM | P1 |
| Redis degradation + heartbeat (R-1) | HIGH | MEDIUM | P1 |
| Characterization tests | HIGH | MEDIUM | P1 |
| Live-DDL baseline + empty-diff gate | HIGH | MEDIUM | P1 |
| bcrypt Better Auth + canary login | HIGH | LOW | P1 |
| SSRF layering (S-1) | HIGH | HIGH | P1 |
| Lock spec + stalled config (J-3) | MEDIUM | MEDIUM | P1 |
| Queue metrics + health surfaces | MEDIUM | LOW–MEDIUM | P1 |
| Expand/contract + overlap window | HIGH | LOW (discipline) | P1 |
| Email queue offload | MEDIUM | LOW–MEDIUM | P1 |
| Theme infra (tokens, no redesign) | MEDIUM | LOW–MEDIUM | P1 |
| AI flag-off boundaries | LOW (now) / HIGH (later) | LOW | P2 |
| High-priority queue | MEDIUM | MEDIUM | P2 |
| `error_class` metadata | MEDIUM | LOW | P2 |
| Outbox-age alerting | MEDIUM | LOW | P2 |
| Lazy rehash-on-login | LOW | LOW | P2 |
| Admin-gated Bull Board | MEDIUM | LOW | P2 |
| Prometheus export | MEDIUM | MEDIUM | P3 |
| Windowed uptime backend | MEDIUM | MEDIUM | P3 |
| AI features enabled | MEDIUM | MEDIUM | P3 |
| Email alert channel / flapping threshold | MEDIUM | MEDIUM | P3 |

**Priority key:** P1 = must have for launch (constraint-satisfying modernization) · P2 = should have, add when possible · P3 = future consideration

---

## Competitor Feature Analysis

How production uptime monitors handle the relevant behaviors. **Confidence LOW (training knowledge):** competitor pages were unreachable during research (search quota exhausted, product-page URLs 404); rows reflect well-established industry conventions, directional only.

| Behavior | UptimeRobot-class | Better Stack / Checkly-class | SpiderNode (this milestone) |
|----------|-------------------|------------------------------|------------------------------|
| Scheduling | Multi-region cron probes, fixed intervals from 1 min | Distributed probes, intervals from 10–30 s | Single worker, claim-based tick, 1-min minimum interval preserved |
| Duplicate/outage detection | Managed infra, no visible dedup story | Managed, with multi-region quorum | Explicit: claims + guards + locks + schema invariants (review-grade, unusually rigorous for a single-VPS deployment) |
| Alert delivery | Retry + integration fan-out, occasional duplicates accepted | At-least-once with incident dedup/escalation policies | Outbox at-least-once + incident-keyed dedup; duplicates documented as residual behavior |
| Queue health | Internal; users see check latency | Exposed as status/telemetry; Checkly surfaces private-runners health | Self-hosted: metrics export + heartbeat + readyz (operator-facing) |
| Uptime reporting | 24h/7d/30d windows | Windowed + SLA reports | Lifetime counters in v1 (compatibility); windowed in final UI phase |
| DOWN threshold | Configurable N consecutive failures | Configurable + flapping suppression | 1-strike DOWN preserved; `consecutive_failures` reserved |
| AI assistance | Emerging (root-cause summaries) | Checkly/Better Stack experimenting | Flagged-off incident summarization + setup assistant, off critical path |

**Positioning takeaway:** this milestone does not chase competitor features (out of scope by design); it builds the *durability machinery* those products run invisibly on managed infrastructure, at single-VPS scale, with the guarantees made explicit and testable.

---

## Sources

Fetched primary sources (classify-confidence seam tier: LOW for web providers — calibrated for package lookups; cross-checked against each other and against `docs/ARCHITECTURE-REVIEW.md` with full agreement):

- BullMQ official docs — retrying failing jobs (at-least-once, attempts, backoff/jitter, maxStalledCount): https://docs.bullmq.io/guide/retrying-failing-jobs
- BullMQ official docs — stalled jobs (double-processing mechanism, event-loop guidance): https://docs.bullmq.io/guide/workers/stalled-jobs
- BullMQ official docs — events/observability (QueueEvents, Redis streams, Prometheus/telemetry guides): https://docs.bullmq.io/guide/events
- BullMQ official docs — pausing queues (global pause, in-flight jobs uninterrupted): https://docs.bullmq.io/guide/workers/pausing-queues
- BullMQ official docs — graceful shutdown (`worker.close()`, stalled safety net): https://docs.bullmq.io/guide/workers/graceful-shutdown
- microservices.io — transactional outbox (at-least-once, relay crash duplicates, polling vs CDC): https://microservices.io/patterns/data/transactional-outbox.html
- Better Auth official docs — email & password (scrypt default, custom `password.hash`/`verify`): https://www.better-auth.com/docs/authentication/email-password
- Martin Fowler — Parallel Change (expand/migrate/contract): https://martinfowler.com/bliki/ParallelChange.html
- Wikipedia — Characterization test / golden master (Michael Feathers): https://en.wikipedia.org/wiki/Characterization_test
- Martin Kleppmann — How to do distributed locking (lock expiry, fencing tokens, efficiency-vs-correctness): https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
- healthchecks.io docs — dead man's switch mechanics (Up → Late → Down, grace, start pings): https://healthchecks.io/docs/
- Stripe docs — idempotency keys (stored-result replay, 24 h retention): https://docs.stripe.com/idempotency
- WebSearch summary (provider quota-limited; corroborates training knowledge) — `FOR UPDATE SKIP LOCKED` claim pattern and adopters (Oban, River, Graphile Worker, pgmq; 2ndQuadrant/EDB origin article)

Local design authorities (primary context, highest practical authority for this milestone):

- `docs/ARCHITECTURE-REVIEW.md` §4 (J-1..J-6, D-1..D-8, R-1, A-1..A-3, S-1..S-4, M-1..M-3, P-1), §8 addenda, §9 checklist
- `docs/ARCHITECTURE-AUDIT.md` §13–§19 (Redis, BullMQ, worker, batching, email, AI, theme), §23 (testing), §24 (order)
- `.planning/PROJECT.md` (hard constraints, Q-1..Q-5 defaults, out-of-scope list)

Training knowledge, unverified by fetch (LOW): competitor product conventions (UptimeRobot/Better Stack/Checkly feature sets), `next-themes` implementation details (prescribed locally by audit §19).

---
*Feature research for: backend modernization capabilities of an uptime-monitoring SaaS (SpiderNode)*
*Researched: 2026-09-08*
