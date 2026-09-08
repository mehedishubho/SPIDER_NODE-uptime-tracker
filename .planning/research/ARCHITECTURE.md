# Architecture Research — Next.js Web + Dedicated Worker + BullMQ Topology

**Domain:** Job-orchestration process topology for a live uptime-monitoring SaaS (brownfield modernization: Next.js 16 App Router web + dedicated Node worker + Redis/BullMQ + PostgreSQL source of truth)
**Researched:** 2026-09-08
**Confidence:** MEDIUM overall — core BullMQ/PM2/Neon/Next.js mechanics verified against official documentation today (fetched 2026-09-08); topology blueprint cross-checked against `docs/ARCHITECTURE-AUDIT.md` §13–§16, §22, §24 and `docs/ARCHITECTURE-REVIEW.md` issues J/D/R/M/P; individual LOW-confidence items flagged inline. Note: general web search was rate-limited during this session, so a few ecosystem claims rest on model knowledge corroborated only by the project's own design docs — those are marked LOW and are either non-load-bearing or independently verifiable at implementation time.

---

## Standard Architecture

### System Overview

The validated target topology (review §1: "mandated topology is correct and confirmed") is a **two-process, one-orchestrator, one-source-of-truth** system:

```
┌────────────────────────────────────────────────────────────────────────┐
│                         CLIENTS (browser, cron-less)                   │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ HTTPS (pages, REST)
┌──────────────▼─────────────────────────────────────────────────────────┐
│  WEB PROCESS  —  PM2 app "uptime-tracker", next start :3007            │
│  • App Router pages / RSC / client components (unchanged surface)      │
│  • proxy.ts session guard (cookie-presence; cheap)                     │
│  • API routes = PRODUCERS ONLY: validate auth → enqueue → 202/JSON     │
│    (no fetch of user URLs, no Telegram calls, no DELETE scans)         │
│  • Reads Postgres to serve; writes via Drizzle (CRUD, auth, feedback)  │
└───────┬──────────────────────────┬─────────────────────────────────────┘
        │ enqueue (ioredis,        │ SQL reads/writes
        │ bounded retries)         │ (pg Pool → Drizzle)
┌───────▼─────────────────┐  ┌────▼─────────────────────────────────────┐
│  REDIS (infrastructure  │  │  POSTGRESQL (Neon) — SOLE SOURCE OF      │
│  only, never truth)     │  │  TRUTH: users, monitors, pings,          │
│  • BullMQ queues        │  │  incidents, feedbacks, outbox,           │
│  • per-monitor locks    │  │  write_guards, auth tables               │
│  • scheduler leader lock│  │  Schema owned by drizzle-kit migrations; │
│  • agg buffer, idem keys│  │  ONE runner (deploy pipeline), never at  │
│  • rate limits, cache   │  │  web/worker boot (review M-1)            │
│  AOF + noeviction       │  └────▲─────────────────────────────────────┘
└───────┬─────────────────┘       │ SQL reads/writes + claim txn
        │ blocking consume        │ (FOR UPDATE SKIP LOCKED)
┌───────▼─────────────────────────┴─────────────────────────────────────┐
│  WORKER PROCESS  —  PM2 app "uptime-worker", node worker/dist/index.js │
│  ALL monitoring execution. Never inside next start.                    │
│  • scheduler   : upsertJobScheduler tick → claim due monitors (SQL)    │
│  • check pool  : SSRF-validate → fetch (10 s) → classify result/err    │
│  • persist     : Tier-1 transitions (1 txn + outbox) / Tier-2 flush    │
│  • alerts      : outbox relay → Telegram (queued, retries, dedup)      │
│  • maintenance : batched retention deletes, uptime recompute           │
│  • health.ts    : :9090 /healthz (liveness) + /readyz (Redis+DB ping)  │
│  Concurrency separated: checks ≠ persist ≠ alerts (slow SMTP/Telegram  │
│  never stalls checks)                                                  │
└───────┬──────────────────────────┬─────────────────────────────────────┘
        │ heartbeat each tick      │ HTTP alerts (queued, timed out)
┌───────▼──────────┐    ┌──────────▼──────────┐    ┌───────────────────┐
│ healthchecks.io  │    │ Telegram Bot API    │    │ SMTP/Resend via   │
│ (dead-man switch)│    │                     │    │ lib/email queue   │
└──────────────────┘    └─────────────────────┘    └───────────────────┘
```

This matches the common industry shape for any Node SaaS that outgrew "cron inside the web app" (dashboard apps, notification engines, webhook dispatchers): **web is a stateless producer + reader; a queue broker decouples execution; a worker owns all side effects; the relational DB remains authoritative**. Notably, the most popular open-source self-hosted uptime monitor (Uptime Kuma) still runs checks *in-process* in a single Node server under PM2 — the dedicated worker is a deliberate step beyond the common OSS pattern, taken here because the review found the single-process variant structurally unsafe for correctness (duplicate checks, batch loss) rather than merely unscalable [LOW: from Uptime Kuma README only; contrast point, not load-bearing].

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Web process (Next.js) | Auth, validation, CRUD, **enqueueing**, serving reads from Postgres | Route handlers + Drizzle; producer-side BullMQ `Queue` objects; Redis rate limiter; never executes checks |
| Scheduler (worker) | Decide *which* monitors are due and claim them exactly once | `upsertJobScheduler` tick job (≤ ½ min interval → 30 s) → single claim transaction (`FOR UPDATE SKIP LOCKED` on `monitors.next_check_at`) → enqueue `check` jobs; leader lock optional at 1 worker |
| Check engine (worker) | Perform the HTTP(S) probe, classify outcome, never write | fetch with `AbortController(10s)`, redirect-hop limit + private-IP denylist (SSRF, S-1), response-size cap |
| Persist writers (worker) | All Postgres writes for check results | Tier 1: transition transaction (conditional UPDATE + ping + incident + outbox row, one `db.transaction`); Tier 2: guarded aggregate flush (monotonic UPDATE) |
| Alert dispatcher (worker) | Deliver transition notifications | consumes `alerts` queue; Telegram with timeout + ≤3 attempts + incident-keyed dedup; future email via `lib/email` |
| Maintenance (worker) | Retention + recompute | batched `DELETE ... LIMIT` loop (D-7), nightly uptime recompute |
| Outbox relay (worker) | Make alert enqueue durable | repeatable job: `outbox` rows → `alerts` jobs, marked sent (D-2) |
| Health server (worker) | Deploy gates + crash observability | plain `http` server on `:9090`: `/healthz` liveness, `/readyz` Redis ping + DB ping |
| Redis | Orchestration only | BullMQ keys, locks, idempotency, aggregation, limits, cache — every key has a recovery story (audit §13) |
| PostgreSQL | Source of truth for everything durable | Neon; Drizzle schema as sole owner; versioned migrations run by exactly one pipeline step |

### Boundary Rules (the load-bearing invariants)

1. **Web never monitors; worker never serves.** The check engine is import-graph-reachable only from `worker/`; API routes only enqueue (review §3.1 also requires enqueue to fail loudly with 503 when Redis is unreachable — never a silent no-op).
2. **Postgres is the only authority.** Every Redis key is disposable or recoverable: queues re-created by scheduler claims, locks TTL-expire, aggregate buffers are loss-tolerable by design, rate-limit loss only loosens limits (audit §13).
3. **Transitions are synchronous-in-worker, routine results are buffered.** DOWN/RECOVERED/first-check/manual checks are committed in one transaction by the persist processor and never touch the buffer; routine UP results may aggregate ≤ 60 s (rules 8–9).
4. **`monitor.status` is written only by Tier 1**, and only via the conditional UPDATE (`WHERE status <> 'DOWN'`), with the partial unique index `incidents(monitor_id) WHERE status='ONGOING'` as the physical backstop (D-1).
5. **Deploy coupling:** web and worker are built from one git SHA and deploy together; migrations run between backup and restart (P-1).
6. **Redis outage = monitoring pause, by design.** No in-process fallback scheduler may be reintroduced — that recreates process-local monitoring state and violates the binding constraint. Detection is external: healthchecks.io heartbeat gap + `/readyz` + staleness surfaced in-product from `last_checked` (R-1).

---

## Recommended Project Structure

**Decision (review N-9): single package with a worker build target — not a pnpm workspace — for this milestone.**

pnpm is adopted in Phase 0 as planned, but the *workspace* mechanism (multi-package `pnpm-workspace.yaml`, `workspace:*` protocol, per-package manifests) is deferred: it buys hard package boundaries and independent versioning that a single-VPS, single-SHA deploy does not need, while costing a large mechanical churn (moving `src/` into `apps/web/`, rewriting imports/aliases, CI paths, PM2 scripts) that multiplies merge risk on a live system already absorbing ORM + auth + queue migrations. This matches audit §15 (worker lives in-repo at `worker/`) and audit §22 item 4 ("the whole deploy switches to a single pnpm build producing `.next` + `worker/dist`").

```
repo root (single package.json, pnpm-lock.yaml)
├── src/                          # Next.js app — location unchanged (zero churn)
│   ├── app/api/**/route.ts       # thin routes: auth-check → enqueue → 202 / read Postgres
│   ├── lib/
│   │   ├── core/                 # SHARED KERNEL (imported by worker, not a package):
│   │   │   ├── db/               #   Drizzle client, pg Pool factory, schema, enums
│   │   │   ├── check-engine/     #   HTTP probe, SSRF validation pipeline, classification
│   │   │   └── contracts/        #   queue names, job payload zod schemas, TS types
│   │   ├── queues/               # producers only (web-safe): queue factories + enqueue helpers
│   │   ├── email/                # provider abstraction (§17)
│   │   └── ...                   # existing auth/mail/telegram modules (migrated per audit)
│   ├── instrumentation.ts        # DELETED at cutover (after overlap window, M3)
│   └── proxy.ts
├── worker/                       # separate tsconfig + tsup entry → worker/dist/
│   ├── index.ts                  # bootstrap: env validation, signals, process.send('ready')
│   ├── health.ts                 # :9090 /healthz + /readyz
│   ├── queues.ts                 # Worker instances, concurrency, stalled config
│   └── processors/
│       ├── scheduler.ts          # upsertJobScheduler tick + claim transaction
│       ├── check-http.ts         # check engine invocation + result classification
│       ├── persist.ts            # Tier-1 transaction / Tier-2 guarded flush
│       ├── alerts.ts             # Telegram (+future email) dispatch + dedup
│       ├── outbox-relay.ts       # outbox rows → alerts jobs
│       └── maintenance.ts        # batched retention, recompute
├── drizzle/                      # versioned SQL migrations (only schema authority, M-1)
├── ecosystem.config.js           # two PM2 apps (web + worker)
├── docker-compose.yml            # local/CI Postgres + Redis (test suites, D-9 rehearsal)
└── .github/workflows/            # lint → typecheck → test → migrate → deploy (P-1 order)
```

**Structure rationale**

- **`src/lib/core/`:** the sharing mechanism for a single-package layout is the import graph itself. Web imports `core/contracts` + producers; worker imports the full kernel including the check engine. The direction is enforced mechanically (ESLint `no-restricted-imports` forbidding `src/**` from importing `worker/**` or `worker`-only deps, and a CI import-graph check), which is the same guarantee a workspace would give without the file moves. If a second non-Next consumer ever appears (CLI, separate migration service), promote `core/` to a workspace package then — the seam is already drawn.
- **`worker/` with its own build target:** Next's compiler never sees it; `tsup` (or `tsc -p worker`) emits plain CJS/ESM to `worker/dist/` in the same `pnpm build`. Runners differ by construction: `next start` vs `node worker/dist/index.js`.
- **Bundling caveat (verify at implementation):** only API routes touch `bullmq`/`ioredis` on the web side; if Next's bundler chokes on them, add them to `serverExternalPackages` in `next.config.ts` [MEDIUM: standard Next.js knob, not re-verified this session].
- **`drizzle/` at root:** one runner, one location; CI empty-diff gate (M-3) compares schema↔live DDL.

---

## Architectural Patterns

### Pattern 1: Scheduler-as-SQL-query with transactional claims (fixes J-1, R4, R5)

**What:** Cadence logic lives in one SQL statement, not in per-process timers. A tick job claims due monitors by advancing `next_check_at` transactionally; only claimed monitors are enqueued, making duplicate execution impossible rather than unlikely.
**When:** Any "N recurring duties at per-item intervals" workload where the item table is already in Postgres.
**Trade-offs:** One more column + index; the claim is "spend now, deliver later" — a Redis failure mid-batch leaves claims advanced (acceptable: one missed check, next tick recovers).

**Example (J-1 as specified):**
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
Idempotency key becomes `check:{monitorId}:{next_check_at epoch}` — unique per schedule *and* per tick (the naive `{monitorId}:{scheduledAt}` from the audit draft deduplicated retries only, not cross-tick duplication). The tick schedule itself is declared with `queue.upsertJobScheduler("scheduler-tick", { pattern: "*/30 * * * * *" }, template)` at worker boot — the v5.16+/v6 Job Scheduler API (the audit's "repeatable job" wording predates the API rename; upsert semantics are exactly the re-declare-after-Redis-restart behavior the audit's M8 assumed).

### Pattern 2: Two-tier write split + transactional outbox (fixes B1–B6, R1–R3, R8–R10, D-2, J-2, D-5)

**What:** Writes split by criticality. Tier 1 (transitions, incidents, manual, first-check) is a single transaction including an `outbox` row so the alert enqueue can never be lost. Tier 2 (routine UP) mutates a Redis aggregate hash and is applied by a flusher job whose transaction is guarded against re-application and monotonic against regression.
**When:** Any pipeline where a small subset of events must be durable+immediate and the bulk is loss-tolerable telemetry.
**Trade-offs:** Two code paths; the guard table and outbox are one more schema surface — but they are what makes "at-least-once" safe instead of corrupting.

**Example (Tier 1 shape):**
```ts
await db.transaction(async (tx) => {
  const flipped = await tx.execute(sql`
    UPDATE monitors SET status='DOWN', failed_checks = failed_checks + 1,
           total_checks = total_checks + 1, last_checked = now()
    WHERE id = ${id} AND status <> 'DOWN' AND is_active
    RETURNING id`);
  if (flipped.rows.length === 0) return;            // not the transition writer → skip
  await tx.insert(pings).values({ monitorId: id, status: "DOWN", ... });
  await tx.insert(incidents).values({ monitorId: id, status: "ONGOING" }); // partial unique index backstops
  await tx.insert(outbox).values({ eventType: "monitor.down", monitorId: id, payload });
});
// relay (separate repeatable job) turns outbox rows into `alerts` jobs — crash-safe
```

**Example (Tier 2 flush, J-2 + D-5):**
```ts
await db.transaction(async (tx) => {
  const guard = await tx.execute(sql`
    INSERT INTO write_guards(key) VALUES (${`flush:${batchId}`})
    ON CONFLICT DO NOTHING RETURNING key`);
  if (guard.rows.length === 0) return;              // already applied — retry is a no-op
  await tx.execute(sql`UPDATE monitors SET
      total_checks  = total_checks + ${dTotal},
      failed_checks = failed_checks + ${dFailed},
      last_checked  = GREATEST(last_checked, ${lastTs}),
      response_time = CASE WHEN ${lastTs} > last_checked THEN ${lastRt} ELSE response_time END
    WHERE id = ${mid}`);                              // never touches status
});
// delete the Redis agg hash only AFTER this commit
```

### Pattern 3: Result-vs-error classification in check jobs (fixes J-4 — "the classic uptime-monitor/BullMQ bug")

**What:** A DOWN website is a *successful job carrying a result*; only infrastructure failures (Postgres unreachable, Redis error, bug) throw. Otherwise every customer outage becomes a failing job → attempts × backoff → delayed transitions and a retry storm coupled to queue health.
**When:** Any checker/probe worker. Non-negotiable.
**Trade-offs:** Requires a typed result union and tests; alerting on "job failed" is then meaningful (it means *our* infra, not the target).

```ts
type CheckResult =
  | { outcome: "UP";   responseTime: number; status: number }
  | { outcome: "DOWN"; errorClass: "timeout"|"dns"|"tls"|"http_5xx"|"refused"|"size_cap"; detail?: string };
// only DB/Redis/bug failures throw → BullMQ retries; DOWN never retries
```

### Pattern 4: Circuit breaker on global queue pause + droppable routine load (fixes J-5, J-6)

**What:** Sustained persist failures trip a breaker: the scheduler queue is paused (`queue.pause()` — BullMQ's documented *global* pause: no worker anywhere picks up jobs, in-flight jobs finish, workers idle until resume) and producers stop enqueueing; routine checks are additionally droppable when backlog exceeds ~2× active monitors (the next tick re-claims them anyway), while transitions are never droppable (they are written synchronously inside check jobs). Recovery: HALF_OPEN single-job probe → resume; backlog cap keeps the worst-case transition latency bounded (depth × job time ÷ concurrency).
**When:** Whenever a queue's consumers write to a dependency that can go down harder/faster than the queue drains.
**Trade-offs:** Under a breaker, checks pause — but that is already the Redis-outage behavior class (R-1), detected by the same heartbeat, and Postgres data stays consistent.

### Pattern 5: Graceful-shutdown handshake (fixes J-3 stalled-job manufacturing, P-1)

**What:** PM2 stop/restart sends SIGINT (default kill signal, configurable via `PM2_KILL_SIGNAL`), then SIGKILL after `kill_timeout` (default a mere 1.6 s). The worker handles SIGINT by stopping intake (`worker.close()` — documented to stop picking up new jobs and wait for active ones, *never timing out by itself*), flushing aggregates, closing pools, then exiting. Therefore `kill_timeout` must exceed the worst job duration (~ check timeout + retries + flush ≈ 20 s) or deploys will manufacture "stalled" jobs that another worker re-runs. At boot, `wait_ready: true` + `process.send("ready")` after Redis/DB pings pass gives PM2 a real readiness gate (`listen_timeout` covers the wait).
**When:** Every long-running consumer process under PM2/systemd.
**Trade-offs:** Longer deploy window per worker restart (seconds); irrelevant at this scale.

---

## Data Flow

### Scheduled check flow (the main loop)

```
upsertJobScheduler tick (worker, every 30 s)
    ↓
claim txn in Postgres (FOR UPDATE SKIP LOCKED → advance next_check_at, RETURNING ids)
    ↓
enqueue check{monitorId, next_check_at, idemKey}  ── backlog > 2×active? → DROP routine jobs
    ↓
check worker: lock:check:{id} (SET NX PX = 10 s + margin, renew at TTL/3, Lua owner-release)
    ↓
re-read monitor (deleted? → no-op) → SSRF pipeline (denylist resolved IPs, re-check per hop)
    ↓
fetch(url, 10 s AbortController, ≤5 hops, ≤2 MB body) → CheckResult (never throws on DOWN)
    ↓
┌─ transition (PENDING→*, UP↔DOWN, first, manual) ──► Tier-1 txn (+ outbox row) ─┐
│                                                                               │
└─ routine UP ──► HINCRBY agg:{monitorId} ──► flusher (≥N or 60 s) ──► Tier-2    │
                                              guarded monotonic flush            │
                                                                                 ▼
                                              outbox relay → alerts queue → Telegram
                                              (timeout, ≤3 attempts, incident-keyed dedup)
    ↓
dashboard/status reads: web GET routes read Postgres (cache:status:{userId}, TTL 15–60 s)
```

### Manual check flow (Q-5)

```
POST /api/monitors/[id]/check
    → session check → Redis per-user enqueue limiter (atomic INCR+EXPIRE)
    → queue.add("check", {..., force: true}, { priority: high })   (503 if Redis down — loud)
    → 202 { checkQueuedAt }  → client optimistically shows "checking…" → polls GET details
Manual/transition checks ride high priority so a RECOVERED never queues behind stale routine work (J-6).
```

### State management

Server state lives in Postgres and flows one way: worker writes → web reads → client polls (existing 30 s `setInterval` polling pattern is unchanged this milestone). Redux remains for genuine UI/domain state only after the dead `auth` slice is pruned; client auth source becomes Better Auth `useSession` + `cookieCache`. There is no client-visible job state — the job system is an implementation detail behind the 202+poll contract.

### Recovery flows (the failure matrix, verified against rules 13–14)

| Failure | Behavior | Detection |
|---|---|---|
| Redis restarts | Schedules re-upserted at worker boot (idempotent); in-flight jobs lost; next tick re-claims via `next_check_at`; stale locks TTL-expire; agg-buffer loss costs a few routine pings only | `/readyz` fails during outage; heartbeat gap |
| Redis down (extended) | Monitoring pauses by design (no jobs exist); web serves stale-but-consistent data with "last checked Xm ago" staleness | healthchecks.io heartbeat gap (the only independent detector), R-1 |
| Postgres down | Check jobs' writes fail → bounded attempts → backoff → dead-letter retention; persist-failure rate trips breaker → scheduler paused; nothing dropped or corrupted | `/readyz` DB ping, breaker metrics, queue age alerting (N-7) |
| Worker crash mid-job | PM2 restarts; stalled-job detection redelivers; J-2 guards make the re-run a no-op if the flush committed | PM2 `max_restarts`/`min_uptime` crash-loop visibility |
| Duplicate check delivery | Idempotency key short-circuit + claim column + conditional transition UPDATE + write_guards — defense in depth | duplicate-write tests (§23.6) |

### Heartbeat

The healthchecks.io ping moves from the web cron to the worker's scheduler tick (success ping; `/fail` on tick exception). This is the single most important operational relocation: it makes "monitoring stopped" detectable independently of both app processes.

---

## Connection Budget (review D-8, verified against Neon documentation)

Neon runs PgBouncer in transaction mode on `-pooler` endpoints; session-level features (SET, LISTEN/NOTIFY, session advisory locks, SQL-level PREPARE) do not survive transaction pooling, and DDL/migrations should use direct connections. `max_connections` is compute-bound (e.g., 104 at 0.25 CU, 209 at 0.5 CU, 419 at 1 CU, with 7 reserved for the superuser) — small enough at this project's tier that per-process budgets matter.

| Consumer | Endpoint | Pool `max` | Notes |
|---|---|---|---|
| Web (Drizzle reads + CRUD) | Neon **pooled** (`-pooler`) | 10 | reads/short writes only; transaction pooling is fine |
| Worker (transitions, flushes, claims) | **direct** (no `-pooler`) | 20 | ≥ 2 × check concurrency (10): transition txn + flush overlap; needs real transactions/session semantics |
| Migration runner (deploy step) | **direct** | 1 | DDL is unsafe over transaction pooling; exactly one runner (M-1) |
| Prisma (transitional only) | shares the **same `pg.Pool` instance** as Drizzle | (shared) | Verified feasible: Drizzle accepts an existing Pool (`drizzle({ client: pool })`), and the repo's existing `lib/prisma.ts` already constructs the `pg.Pool` the `PrismaPg` adapter wraps — point both ORMs at one pool so the transition doesn't double the footprint |
| BullMQ (worker) | — | — | Redis, not Postgres: worker needs a *blocking* connection with `maxRetriesPerRequest: null` plus its duplicated internal connection; producer connections keep bounded retries so enqueue fails fast |
| Set always | — | — | `statement_timeout`, `idle_in_transaction_session_timeout`, pool `idleTimeout`; watch `pg_stat_activity` |

---

## Health Endpoints

Semantics adopted from liveness/readiness doctrine (Kubernetes docs, applied to PM2):

| Endpoint | Checks | On failure | Wired to |
|---|---|---|---|
| `GET :9090/healthz` (liveness) | Process is up and its event loop responds — **never** checks DB/Redis (an external dependency failing must not trigger restart loops; restart only fixes self-state) | PM2 restarts the app | PM2 autorestart |
| `GET :9090/readyz` (readiness) | Redis ping **and** Postgres ping; worker has claimed its schedulers | Release is not considered good; deploy gate fails | P-1 deploy pipeline: restart worker → wait `readyz` → restart web → smoke-check; also surfaced to healthchecks.io |

The same split applies to the web app (`readyz` gates releases); the worker's `readyz` is the one the pipeline *blocks* on, because a web release with a dead worker is a silent monitoring outage.

---

## Scaling Considerations

| Scale | Architecture adjustments |
|---|---|
| Now (~1 web + 1 worker, hundreds of monitors) | As designed: worker concurrency 10, one Redis with AOF, Neon 0.25–0.5 CU. Nothing to optimize. |
| ~10k monitors / busy alerts | Raise check concurrency; separate `monitor-checks` into routine vs high-priority queues (manual + non-UP monitors); add queue-depth/age metrics (N-7); Bull Board behind admin gate; consider `ping-rollup` maintenance job |
| Multi-worker scale-out | Safe *by construction* already — SQL claims (J-1), per-monitor locks (J-3), write guards (J-2), and conditional transitions (D-1) make duplicate execution impossible across N workers. First extras: stagger boots (M-1: migrations still run once), per-worker health ports. |
| Later (not this milestone) | Redis managed hosting (must support blocking commands), FlowProducer for check→persist→alerts chains, windowed uptime rollups in `maintenance` |

**First bottleneck:** not CPU — it is the Postgres write path under incident bursts (transition txns + flushes) against a small Neon compute; the connection budget and breaker exist precisely for this. **Second:** Redis memory (noeviction + 70% alert) if backlogs are unbounded — hence the backlog cap.

---

## Anti-Patterns

### Anti-Pattern 1: Monitoring cron inside the web process (the current state)
**What people do:** register `node-cron` in `instrumentation.ts` so the web server checks monitors.
**Why it's wrong:** per-process state (buffer, locks) duplicates with every instance; heavy fetches stall the event loop serving users; `register()` runs in every server instance and all runtimes (Next docs), so scaling multiplies the problem.
**Do this instead:** dedicated worker process; web routes only enqueue; delete `instrumentation.ts` cron after the overlap window.

### Anti-Pattern 2: Alerts enqueued after commit (or sent before it)
**What people do:** `db.commit(); await alertsQueue.add(...)` — or the current code's send-then-persist.
**Why it's wrong:** crash between the two steps permanently loses the DOWN alert (the monitor later recovers; nothing ever fires), or records downtime that was never alerted.
**Do this instead:** transactional outbox row inside the persist transaction; relay turns rows into alert jobs; incident-keyed dedup collapses at-least-once duplicates (D-2/D-4).

### Anti-Pattern 3: Delta flushes without a transactional guard
**What people do:** apply `total_checks += δ` on every job attempt, trusting a Redis-side marker.
**Why it's wrong:** BullMQ is at-least-once; a crash after commit but before Redis cleanup re-applies deltas — counters (and uptime %) drift forever; Redis markers can be flushed independently of Postgres.
**Do this instead:** `write_guards` insert + delta apply in the *same* Postgres transaction (J-2); monotonic `GREATEST`/CASE updates for `last_checked`/`response_time` (D-5).

### Anti-Pattern 4: Treating a DOWN target as a failed job
**What people do:** let the check processor throw on non-2xx/timeout.
**Why it's wrong:** outages multiply into attempts × backoff failures; transitions are delayed by exactly the mechanism meant to report them; Postgres outages and customer outages become indistinguishable.
**Do this instead:** result-vs-error classification (Pattern 3); alerts then fire on *result*, jobs fail only on *infra*.

### Anti-Pattern 5: `kill_timeout` shorter than the longest job
**What people do:** leave PM2's default 1.6 s grace period on a worker whose checks take up to ~10 s+.
**Why it's wrong:** every deploy SIGKILLs mid-job; stalled-job redelivery re-runs them (safe only because of guards, wasteful always) and pollutes metrics.
**Do this instead:** `kill_timeout: 20000` (≥ max check duration + flush margin), SIGINT handler → `worker.close()` → flush → exit; `wait_ready` + `process.send("ready")` at boot.

### Anti-Pattern 6: In-process fallback scheduler "so Redis outages don't stop monitoring"
**What people do:** keep a node-cron path in the web/worker process as a backup when Redis is unreachable.
**Why it's wrong:** recreates process-local monitoring state — the exact defect this migration removes — and silently double-executes against the queue path.
**Do this instead:** accept pause-by-design; make it visible (heartbeat gap, `/readyz`, in-product staleness from `last_checked`); engineer Redis for availability (AOF, auto-restart, noeviction).

---

## Integration Points

### External Services

| Service | Integration pattern | Notes / gotchas |
|---|---|---|
| Neon PostgreSQL | pooled string for web reads; direct for worker + migrations; one shared Pool instance during the Prisma↔Drizzle transition | transaction pooling breaks session features; `pg_dump`/DDL always direct; `max_connections` small at low compute tiers |
| Redis (self-hosted, same VPS) | ioredis; worker gets a blocking connection (`maxRetriesPerRequest: null`) + BullMQ's duplicated internal connection; producers bounded | `noeviction` + AOF `appendfsync everysec`; never use ioredis `keyPrefix` (incompatible with BullMQ prefixing) |
| Telegram Bot API | `alerts` queue processor; strict timeout; ≤3 attempts; incident-keyed dedup key | webhook handler gets `secret_token` verification (S-2); slow sends must never stall the check pool |
| SMTP / email providers | `lib/email` interface, env-selected provider, `email-transactional` queue offload; typed retryable-vs-permanent errors | if Redis is down, enqueue fails → registration must degrade loudly (N-6), not silently skip verification mail |
| healthchecks.io | worker scheduler tick heartbeat; `/fail` on tick exception | the only detector independent of both app processes (R-1) |
| Cloudinary | unchanged profile-avatar upload | out of scope for the worker |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Web → Redis | producer `Queue.add` only | 503 on Redis failure (loud); per-user enqueue limiter on manual check (S-3) |
| Worker → Postgres | Drizzle (node-postgres driver — full transaction support, N-10) | all monitoring writes; web reads the same tables concurrently |
| Web ↔ worker | **none directly** — only Redis (jobs) and Postgres (state) | this decoupling is what makes either process restartable independently |
| `src/lib/core` ← `worker/` | direct imports (single package) | import direction lint-enforced; promote to a workspace package if a third consumer appears |
| Scheduler → check queue | claimed IDs only | claims advanced even if enqueue fails (accepted: one missed check; next tick recovers) |

---

## Safest Build Order (migrating a live system without a monitoring gap)

Dependencies between components dictate the order; each step ships revertibly and keeps checks running. (Numbers align with audit §24; the sub-steps within step 4 are the architecture-dimension contribution.)

```
0. Foundations ──► 1. Shared-kernel extraction ──► 2. Redis (no behavior dependence)
        │                        │                     │
        └──► 3. Drizzle additive baseline (schema owner, empty-diff gate)
                                     │
                                     ▼
                  4. Worker skeleton → cutover with OVERLAP WINDOW
                                     │
                                     ▼
                  5. Thin API routes ──► 6. Email abstraction ──► 7. Better Auth
                                     ──► 8. Prisma removal ──► (9. AI flagged, 10. UI)
```

1. **Foundations (no behavior change):** pnpm, typecheck on, Vitest/Playwright, docker-compose Postgres+Redis, characterization tests pinning `runCronChecks`/batcher/API contracts (review §7.9: the single most valuable safety investment).
2. **Shared-kernel extraction:** move the check engine, db client, and job contracts into `src/lib/core`; the old cron path still runs — it just now imports from `core`. Establishes the import boundary and makes step 4 a *move*, not a rewrite.
3. **Redis introduction:** ioredis client, Redis rate limiter + cache, AOF/noeviction documented. No correctness dependence yet — the system runs fine if Redis is empty.
4. **Drizzle additive baseline:** schema authored from live DDL (`pg_dump --schema-only`), empty-diff CI gate (M-3), `next_check_at`, `write_guards`, `outbox`, partial unique index, ID-generation defaults pinned (D-3) — the schema addenda must exist *before* the worker, because claims and guards are load-bearing.
5. **Worker skeleton (dark launch):** build the process, health server, queue wiring, processors — with the scheduler **paused**. Verify: `readyz` green, PM2 app stable under `kill_timeout`, Bull Board (admin-gated) shows queues, deploy pipeline runs the new P-1 ordering end-to-end against staging data. All deploy-topology risk is retired here, while monitoring still runs on the old path.
6. **Cutover via overlap window (M3):** enable the scheduler; old cron and new worker both run briefly. Both paths are idempotent (claims + guards + conditional transitions), so overlap wastes checks but cannot corrupt state. Cutover is *proven*, not hoped for: heartbeat steady from the worker, queue depth ≈ 0, alert parity observed, counter deltas match — **then** delete `instrumentation.ts` cron and `CRON_MODE`. This is the only step where a monitoring gap is even possible, and the overlap makes the worst case *duplicate checks*, never *no checks*.
7. **Thin API routes:** manual check → enqueue + 202 + poll; Redis rate limits; the security fixes that fall out of the new boundary (S-2 webhook secret, S-3 admin gating + per-user limiter, S-4 no stack traces/secrets, R19/S-1 SSRF pipeline — the last one already lives in the worker's check engine from step 5).
8. **Email abstraction → Better Auth → Prisma removal:** per audit §24 steps 6–8 (auth/data dimensions covered by the sibling research files; architecturally they change *who writes the auth tables*, not the process topology).

**Why this order:** every component has exactly one dependency direction — schema before workers (claims/guards are schema), worker skeleton before cutover (deploy risk retired while nothing depends on it), overlap before deletion (gap impossible by construction), API thinning *after* the worker exists (a route can't enqueue to nothing). Reverting any step before its successor lands means re-enabling the previous still-present path.

**Migration-order flags for the roadmap:**
- Phase "worker skeleton (dark launch)" is new relative to the audit's step-4 wording and is where P-1/M-2/P-1 rollback should be rehearsed — recommend making it explicit in the phase plan.
- The schema addenda (J-1/D-1/D-2/J-2/D-3 columns and indexes) are a *hard prerequisite* of the worker phase, not parallel work.
- `serverExternalPackages` for bullmq/ioredis on the web side: verify during the thin-routes phase [MEDIUM].

---

## Sources

Official documentation fetched 2026-09-08 (WebFetch of primary docs; general web search was rate-limited this session):

- BullMQ — Graceful shutdown (`worker.close()`, stalled handling): https://docs.bullmq.io/guide/workers/graceful-shutdown
- BullMQ — Connections (`maxRetriesPerRequest: null` for workers, connection counts, `noeviction`, `keyPrefix` caveat): https://docs.bullmq.io/guide/connections
- BullMQ — Repeatable jobs deprecation → Job Schedulers (`upsertJobScheduler`): https://docs.bullmq.io/guide/jobs/repeatable and https://docs.bullmq.io/guide/job-schedulers
- BullMQ — Pausing queues (global `queue.pause()` vs local `worker.pause()`): https://docs.bullmq.io/guide/workers/pausing-queues
- PM2 — Application declaration (`kill_timeout`, `wait_ready`, `listen_timeout`, `max_restarts`, `min_uptime`): https://pm2.keymetrics.io/docs/usage/application-declaration/
- PM2 — Signals and clean restart (SIGINT → SIGKILL after `kill_timeout`, `PM2_KILL_SIGNAL`, `process.send('ready')`): https://pm2.keymetrics.io/docs/usage/signals-clean-restart/
- Neon — Connection pooling (pooled vs direct, transaction-mode limitations, `max_connections` by compute): https://neon.com/docs/connect/connection-pooling
- Kubernetes — Liveness vs readiness probe semantics (basis for `/healthz` vs `/readyz`): https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
- Next.js — Instrumentation (`register()` once per server instance, runtime gating — why cron-in-web cannot scale): https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
- pnpm — Workspaces (`workspace:` protocol, shared lockfile; basis for the deferred-workspace rationale): https://pnpm.io/workspaces
- Drizzle — PostgreSQL connection via node-postgres (`drizzle({ client: pool })` — basis for shared-Pool transition): https://orm.drizzle.team/docs/get-started-postgresql
- Uptime Kuma — README (single-process OSS contrast): https://github.com/louislam/uptime-kuma
- Project design authority: `docs/ARCHITECTURE-AUDIT.md` §13–§16, §22, §24; `docs/ARCHITECTURE-REVIEW.md` §4 (J-1..J-6, D-1..D-8, R-1, S-1..S-4, M-1..M-3, P-1), §8 addenda, §9 checklist — HIGH confidence as the project's binding design (reviewed, issue-tracked), though implementation must resolve the review's NOT-READY verdict via the §8 addenda first.

**Honest gaps:** (1) live ecosystem search was unavailable — third-party production write-ups (e.g., engineering blogs on BullMQ at scale) were not consulted; the BullMQ official docs carry the claims above. (2) The `serverExternalPackages` bundling detail and exact tsup config for the worker build were not verified this session. (3) `FOR UPDATE SKIP LOCKED` and outbox digests are model-knowledge corroborated by the project's own J-1/D-2 specs (LOW-marked in the research cache) — both are verifiable in a Phase-0 spike against the docker-compose Postgres.

---
*Architecture research for: SpiderNode uptime-tracker — web + dedicated worker + BullMQ topology (brownfield)*
*Researched: 2026-09-08*
