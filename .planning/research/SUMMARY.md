# Project Research Summary

**Project:** SpiderNode — backend/infrastructure modernization (brownfield, live production uptime-monitoring SaaS)
**Domain:** Backend modernization: ORM + auth cutover, Redis/BullMQ job orchestration, dedicated worker extraction
**Researched:** 2026-09-08
**Confidence:** HIGH (stack) / MEDIUM (features, architecture, pitfalls)

## Executive Summary

SpiderNode is a live single-VPS uptime-monitoring SaaS whose current architecture embeds monitoring inside the Next.js web process via `node-cron` in `instrumentation.ts`, persists with Prisma `db push` (no migration history), authenticates with NextAuth v4, and stores idempotency/aggregation state in process-local paths. All four research dimensions converge on one validated blueprint: a **two-process topology** — the Next.js web app becomes a stateless producer (thin API routes that enqueue, never probe), a **dedicated PM2 worker process** owns all monitoring execution (scheduler, checks, persistence, alerts, maintenance), **Postgres (Neon) remains the sole source of truth**, and Redis/BullMQ holds only loss-tolerable orchestration state. The target stack is current and peer-compatible, with four version-reality corrections the roadmap must absorb: BullMQ 6 removed legacy repeatable jobs (all recurring work uses `upsertJobScheduler`), Better Auth 1.7.3 effectively pins drizzle-orm at `^0.45.2`, ioredis 6 must be installed explicitly (BullMQ 6 made it an optional peer), and nodemailer 10 / pnpm 11 / Vitest 5 are very fresh and should be pinned deliberately.

The dominant risk is not greenfield complexity — it is **cutting over a live production system without a monitoring gap, user lockout, or silent data corruption**. The research is unanimous on the mitigation sequence: characterization tests pinning current behavior *before* any rewrite (the "single most valuable safety investment"); Drizzle schema baselined from **live DDL** (`pg_dump --schema-only` + `drizzle-kit pull`) with an empty-diff CI gate — never from `schema.prisma`, which is known to drift; schema addenda (`next_check_at`, `write_guards`, `outbox`, partial unique index, ID defaults) landing as a *hard prerequisite* of the worker; a **dark-launch worker skeleton** (scheduler paused) to retire deploy-topology risk; then cutover via an **overlap window** where both cron paths run idempotently, with explicit gates (worker `readyz` green, heartbeat from worker, queue depth ~= 0, new-path ping rows appearing) before deleting `instrumentation.ts`. Auth cutover is gated on a bcrypt `password.hash/verify` config (Better Auth default scrypt would lock out every credentials user) plus a canary login against real migrated hashes.

Correctness inside the worker rests on defense in depth, not on any single mechanism: SQL transactional claims (`FOR UPDATE SKIP LOCKED` on `next_check_at`) make duplicate scheduling impossible; a strict **result-vs-error classification** (a DOWN website is a successful job carrying a result — only infra failures throw) prevents retry storms; Postgres-side write guards and conditional transition updates make at-least-once redelivery a no-op; a transactional outbox ties alert delivery to the state-change commit; a circuit breaker (`Queue.pause()`) plus a backlog cap bounds Postgres-outage damage. Redis outage means monitoring *pause by design* — no in-process fallback scheduler may be reintroduced; detection is external (healthchecks.io heartbeat on the worker tick) plus in-product staleness surfacing.

## Key Findings

### Recommended Stack

Full detail in `.planning/research/STACK.md` (all versions registry-verified 2026-09-08, HIGH confidence).

**Core technologies:**
- **Next.js 16.3.4** — minor-line bump from ^16.0.10; isolated in Phase 0; Node >= 20.9.
- **drizzle-orm 0.45.2 (exact) + drizzle-kit 0.31.10 + pg 8.23** — sole ORM post-cutover; version pinned by Better Auth peer; `node-postgres` driver keeps full transaction support in the worker; `pull`/`generate`/`migrate`/`check` replace `db push` with versioned SQL.
- **better-auth 1.7.3** — Drizzle adapter is first-class; custom bcrypt `password.hash/verify`, `cookieCache` (zero-DB proxy session checks), `modelName`/`fields` mapping onto the existing `users` table, `admin()` plugin for roles.
- **bullmq 6.3.4 + ioredis 6.0.0** — v6 semantics only: `upsertJobScheduler` (legacy `repeat` REMOVED), `UnrecoverableError` (replaces `Job#discard()`), workers require `maxRetriesPerRequest: null`, never set ioredis `keyPrefix`, install ioredis explicitly.
- **nodemailer 10 / resend 6** — behind a `lib/email` provider interface with queue offload.
- **bcryptjs 3.0.3** — keeps every existing hash verifiable; ships own types.
- **Dev:** pnpm 11.26 (pin; not 12 mid-migration), Vitest 5 (Node >=22.12 — pin Node 24 in CI, else Vitest 4.1), Playwright 1.63, docker-compose Postgres 17 + Redis 8.

**Do NOT use:** Prisma past cutover, `drizzle-kit push` against prod, Upstash Redis (no blocking commands — BullMQ cannot run), serverless schedulers as check triggers, `@neondatabase/serverless` in the worker, ioredis `keyPrefix`, `pg_advisory_lock` behind the Neon transaction-mode pooler, any in-process fallback scheduler, Redlock.

### Expected Features

Full detail in `.planning/research/FEATURES.md`. "Features" = backend durability capabilities; missing any table stake = the migration ships a defect the current system doesn't have.

**Must have (table stakes):**
- Claim-based due-selection (single `FOR UPDATE SKIP LOCKED` transaction advancing `next_check_at`) + schedule-epoch idempotency keys — J-1
- Typed result classification (DOWN is not a job failure) — J-4; cheapest, most load-bearing correctness rule
- Postgres-side write guards + monotonic flush (`GREATEST`) — J-2/D-5; counter corruption is permanent otherwise
- Full lock spec (TTL, renewal, owner-only Lua release, abort-on-lock-loss) + bounded stalled config — J-3
- Transactional outbox + incident-keyed alert dedup — D-2/D-4
- Two-tier persistence (transitions sync in one txn; routine UP aggregated <=60 s)
- Circuit breaker + backlog cap + bounded retries/DLQ — J-5/J-6
- Schema invariants: conditional transition UPDATE + partial unique index on ONGOING incidents; ID defaults pinned — D-1/D-3
- Redis degradation engineering: noeviction + AOF, external heartbeat, staleness UI, boot re-upsert recovery — R-1
- Queue metrics + `:9090/healthz`/`readyz` + `monitorId`-correlated structured logs — N-7/P-1
- Characterization tests before any rewrite; live-DDL baseline + empty-diff CI; expand/contract discipline; overlap window; anonymized-snapshot rehearsal; bcrypt gate + canary login; SSRF layering (highest-severity security item, S-1)

**Should have (v1.x):** high-priority queue for transitions/manual checks, `error_class` metadata, outbox-age alerting, lazy rehash-on-login, admin-gated Bull Board, Prometheus export, AI features enabled behind flag.

**Defer (v2+):** windowed uptime (24h/7d/30d), N-consecutive-failure threshold, email alert channel, advanced monitor types, multi-instance scale-out exercise.

**Anti-features (explicitly rejected):** in-process fallback scheduler, dual-write Prisma+Drizzle period, AI in the alert path, exactly-once infrastructure, Redlock, Redis as authoritative state, migrations at process boot, unauthenticated queue UI.

### Architecture Approach

Full detail in `.planning/research/ARCHITECTURE.md`. Two-process, one-orchestrator, one-source-of-truth: web (PM2 `uptime-tracker`, `next start :3007`) is producer + reader only; worker (PM2 `uptime-worker`, `node worker/dist/index.js`) owns scheduler (30 s `upsertJobScheduler` tick — SQL claim), check pool (SSRF-validate — 10 s fetch — classify), persist (Tier-1 transition txns with outbox rows / Tier-2 guarded flushes), alerts (outbox relay — Telegram), maintenance (batched deletes), and a `:9090` health server. Single-package repo (no pnpm workspace this milestone) with `src/lib/core/` shared kernel, `worker/` built to its own `worker/dist`, and import direction lint-enforced.

**Load-bearing invariants:** web never monitors / worker never serves; Postgres is the only authority (every Redis key is disposable); `monitor.status` written only by Tier 1 via conditional UPDATE; web-worker communicate only via Redis (jobs) and Postgres (state); Redis outage = monitoring pause, detected externally.

**Connection budget (D-8):** web 10 (Neon pooled) / worker 20 (direct) / migrations 1 (direct); share one `pg.Pool` between Prisma and Drizzle during transition. Neon max_connections is only 104 at 0.25 CU.

### Critical Pitfalls

Full detail in `.planning/research/PITFALLS.md`. Top five:

1. **Baselining Drizzle from `schema.prisma` instead of live DDL** — bakes unknown drift into the new source of truth; first diff emits destructive SQL. Prevent: `pg_dump --schema-only` + `drizzle-kit pull`, empty-diff CI gate.
2. **Password-hash lockout at the auth flip** — Better Auth defaults to scrypt; all existing hashes are bcrypt; hashes must also move into `account` rows (`providerId: "credential"`). Prevent: bcrypt config as a gate, credential-row backfill, canary login on real migrated data before any route flips.
3. **At-least-once redelivery double-writes** — PM2 default `kill_timeout` is 1.6 s (deploys SIGKILL mid-job, manufacturing stalled jobs); re-runs of non-idempotent delta writers corrupt counters permanently. Prevent: Postgres-transaction write guards, `kill_timeout: 20000`, SIGINT — `worker.close()`, bounded stalled config.
4. **DOWN targets treated as failed jobs** — customer outages become retry storms; during a Postgres outage Redis grows toward `noeviction` collapse. Prevent: result-vs-error classification, circuit breaker, backlog cap (routine droppable, transitions never).
5. **Monitoring blackout during cutover, unnoticed** — stale statuses render as current; heartbeat can lie; `instrumentation.ts` register() survives stale builds/edge runtime. Prevent: overlap window with explicit gates, staleness query alert, CI grep of `.next/` for cron remnants.

Also significant: timestamp/timestamptz drift (pin `withTimezone`, verify from live DDL); Prisma client-side `cuid()` with no Drizzle equivalent (pin ID defaults before schema freeze); repeatable-job loss on Redis restart (re-upsert at boot; `next_check_at` claims are the real recovery path); the Neon transition connection budget; ioredis client misconfiguration (two factories: worker null retries, producer capped/fail-fast 503).

## Implications for Roadmap

The audit §24 order is validated by all four research dimensions. The architecture research adds one structural change: split audit step 4 into **worker skeleton (dark launch)** and **cutover via overlap window** — deploy-topology risk is retired while nothing depends on the new worker, and the overlap makes the worst case duplicate checks, never zero checks. Schema addenda are a hard prerequisite of the worker, not parallel work.

### Phase 0: Foundations & Characterization Tests
**Rationale:** The single most valuable safety investment (review §7.9); every later phase's changes are proven non-breaking by golden-master tests.
**Delivers:** pnpm migration, typecheck gate, Vitest/Playwright scaffolding, docker-compose Postgres+Redis, characterization tests pinning `runCronChecks`, db-batcher math, and API contracts; Next.js 16.3.4 bump; dependency pins (BullMQ major, Node 24 in CI); lint/grep guards.
**Addresses:** Characterization tests (FEATURES §F); tooling pins.
**Avoids:** Pitfalls 9, 15.

### Phase 1: Theme Infrastructure (small, early, no redesign)
**Rationale:** Stable tokens must precede the final UI phase; doing it mid-backend-migration churns every component.
**Delivers:** `next-themes`, real light `:root` tokens, today's dark values as `.dark`, toggle, token hygiene (hex — semantic tokens).
**Avoids:** Token-mismatch UX risk.

### Phase 2: Redis Introduction (no correctness dependence)
**Rationale:** Redis lands with zero behavior dependence — the system runs fine if Redis is empty; client factories, budget, and staleness query exist before the worker needs them.
**Delivers:** ioredis clients (two factories), Redis rate limiter + cache, AOF + noeviction, Postgres connection budget documented, `last_checked` staleness alert query.
**Addresses:** R-1 foundations, D-8 budget.
**Avoids:** Pitfalls 11, 14.

### Phase 3: Drizzle Additive Baseline (schema ownership)
**Rationale:** Schema must be owned by versioned migrations before the worker exists — claims and guards are schema.
**Delivers:** Live-DDL baseline (`pg_dump` + `drizzle-kit pull`), empty-diff CI gate, single migration runner in deploy, additive schema addenda (`next_check_at` + partial index, `write_guards`, `outbox`, partial unique ONGOING index, ID defaults, `withTimezone` pinning, `error_class` if cheap), anonymized-prod-snapshot rehearsal (D-9), `CREATE INDEX CONCURRENTLY` runbook step.
**Addresses:** Live-DDL baseline + empty-diff gate; schema addenda; ID pinning.
**Avoids:** Pitfalls 1, 2, 3, 4, 14. **Research flag:** verify drizzle-kit transaction-wrapping vs CONCURRENTLY and journal-stamping in the rehearsal.

### Phase 4: Worker — Skeleton (dark launch), then Cutover (overlap window)
**Rationale:** All deploy-topology risk retired with the scheduler paused; the overlap window makes a monitoring gap impossible by construction. This is the milestone's highest-risk phase and should probably be split into two roadmap phases.
**Delivers:** Worker process (PM2 app, health server, queue wiring), all processors (scheduler, check, persist, alerts, outbox-relay, maintenance), J-1..J-6 + D-1/D-2/D-4/D-5 machinery, SSRF pipeline in the check engine, heartbeat moved to worker tick; then gates-proven cutover and deletion of the `instrumentation.ts` cron.
**Addresses:** The bulk of the FEATURES table stakes (§A–E).
**Avoids:** Pitfalls 9, 10, 12, 13, 15. **Research flag:** needs `--research-phase` depth (BullMQ 6 scheduler semantics, breaker tuning, PM2 handshake).

### Phase 5: Thin API Routes
**Rationale:** Routes can only enqueue once the worker exists; the new boundary forces the security fixes naturally.
**Delivers:** Manual check — enqueue + 202 + poll with optimistic UX, Redis per-user limiter, Telegram webhook secret, loud 503 on Redis down, no secrets in query strings, error sanitization.
**Addresses:** S-2/S-3/S-4; Q-5 manual-check flow.
**Avoids:** Synchronous-check anti-pattern.

### Phase 6: Email Abstraction
**Rationale:** Deliberately ordered *before* Better Auth so its hooks delegate to the queue, never to in-request SMTP.
**Delivers:** `lib/email` provider interface (nodemailer/Resend), `email-transactional` queue offload with backoff, typed retryable-vs-permanent errors (`UnrecoverableError`), loud degradation.
**Addresses:** §17/N-6.

### Phase 7: Better Auth Cutover
**Rationale:** Depends on Drizzle schema and email queue; the one step that can lock every user out — gated by canary login.
**Delivers:** bcrypt hash/verify gate, adapter bound to the existing `users` table, credential account-row backfill, OAuth reshape script (rehearsed on snapshot), `cookieCache` + proxy decision, admin plugin, register-verify-login E2E, per-provider canary OAuth logins, re-login announcement.
**Addresses:** A-1/A-2/A-3; auth table stakes.
**Avoids:** Pitfalls 5, 6, 7, 8. **Research flag:** providerId casing and token-flow cutover deserve focused research.

### Phase 8: Prisma Removal
**Rationale:** Only after all read paths are ported and one release of stability; the second ORM is the connection-budget killer.
**Delivers:** Shared-pool transition ended, Prisma deleted, contract (drop) steps for legacy tables scheduled.
**Avoids:** Anti-feature "compatibility shim"; pitfall 14.

### Phase 9–10: Flagged AI Skeletons; Final UI (incl. windowed uptime)
**Rationale:** AI strictly off-critical-path behind `AI_ENABLED=false`; visual redesign last, on stable APIs and stable tokens; windowed uptime lands here per Q-1.
**Addresses:** §18, §19, D-6.

### Phase Ordering Rationale

- **Dependency direction is one-way:** characterization tests — schema ownership — schema addenda — worker — cutover — thin routes — email — auth — Prisma removal. Every step reverts to the still-present previous path.
- **Schema before worker** because claims (`next_check_at`), guards, outbox, and the ONGOING unique index are load-bearing from the first job.
- **Email before auth** so Better Auth hooks never reintroduce in-request SMTP.
- **Overlap before deletion** and **dark launch before cutover** are the two structural additions research makes to the audit plan.
- **Characterization tests conflict with semantic changes** — any phase wanting different behavior must change pins deliberately (post-milestone).

### Research Flags

Needs `--research-phase` during planning:
- **Phase 4 (Worker + cutover):** BullMQ 6 `upsertJobScheduler` semantics, breaker/backlog tuning, PM2 `wait_ready`/`kill_timeout` handshake, overlap gate instrumentation.
- **Phase 7 (Better Auth):** `providerId` casing per provider, verification/reset token-flow cutover, cookieCache revocation-lag policy, R18 decision.
- **Phase 3 (Drizzle):** journal-stamping the baseline migration, drizzle-kit transaction wrapping vs `CREATE INDEX CONCURRENTLY` (both MEDIUM/UNVERIFIED).

Standard patterns (skip research-phase):
- **Phases 0, 1, 2, 5, 6:** pnpm migration, next-themes, ioredis client setup, thin route handlers, email provider interface — well-documented, established patterns.
- **Phases 8, 9:** mechanical removal and flag-gated endpoints.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Every version registry-verified live; every API claim cross-checked against official docs. Single-source items explicitly tagged. |
| Features | MEDIUM | Core mechanics verified from primary sources and cross-checked against the project review docs with full agreement; competitor rows directional. |
| Architecture | MEDIUM | BullMQ/PM2/Neon/Next mechanics verified from official docs today; a few ecosystem claims rest on model knowledge (marked LOW, non-load-bearing). |
| Pitfalls | MEDIUM | Every pitfall grounded in the repo own audit/review plus fetched official docs; four items explicitly UNVERIFIED with assigned confirmation phases. |

**Overall confidence:** MEDIUM-HIGH. Stack facts are as solid as research gets; behavioral/mechanics claims are planning-grade with a small, explicitly-listed unverified tail.

### Gaps to Address

- **drizzle-kit baseline journal-stamping** and **transaction-wrapping vs `CREATE INDEX CONCURRENTLY`** — verify in the Phase 3 snapshot rehearsal; plan a scripted CONCURRENTLY runbook step regardless.
- **Better Auth social `providerId` casing** — confirm from library source or dry-run login in the Phase 7 rehearsal.
- **Prisma `DateTime` to timestamp-without-TZ default** — confirm via live `pg_dump` in Phase 3 (audit M-6 mandates this anyway).
- **`serverExternalPackages` for bullmq/ioredis on the web side** and exact worker `tsup`/`tsc` build config — verify during Phases 4–5.
- **`@bull-board/express@9` install shape and Resend SDK surface** — verify at install time if adopted (v1.x differentiators).
- **Redis rate-limiter Lua atomicity** — use a reviewed atomic script, not an ad-hoc one.
- **Ecosystem production write-ups unavailable** (search rate-limited) — BullMQ-at-scale operational claims rest on official docs; Phase 4 planning should sanity-check against current community guidance.

## Sources

### Primary (HIGH confidence)
- npm registry (live `npm view`, 2026-09-08) — versions, engines, peerDependencies for all packages in STACK.md
- BullMQ official docs — connections, workers/stalled jobs, graceful shutdown, pausing, retrying, events, repeatable-to-job-schedulers; v6.0.0 release notes
- Better Auth official docs — email-password, session management (`cookieCache`), Drizzle adapter, admin plugin, NextAuth migration guide
- Drizzle ORM/Kit docs — migrations (`pull`/`generate`/`migrate`/`check`), node-postgres driver
- Neon docs — connection pooling (transaction mode, limits, direct endpoint)
- PM2 docs — application declaration (`kill_timeout`, `wait_ready`), signals & clean restart
- Next.js docs — instrumentation, middleware caveat
- Project design authority: `docs/ARCHITECTURE-AUDIT.md` (§13–§19, §21–§24), `docs/ARCHITECTURE-REVIEW.md` (§4 blocking issues, §8 addenda, §9 checklist), `.planning/PROJECT.md`

### Secondary (MEDIUM confidence)
- microservices.io — transactional outbox
- Martin Fowler — Parallel Change (expand/migrate/contract)
- Martin Kleppmann — How to do distributed locking
- healthchecks.io docs — dead man's switch mechanics
- Stripe docs — idempotency keys
- pnpm blog — pnpm 12 release (tooling-pin decision)
- Kubernetes docs — liveness vs readiness semantics

### Tertiary (LOW confidence — validate in-phase)
- Competitor feature conventions (UptimeRobot/Better Stack/Checkly) — pages unreachable; directional only
- Uptime Kuma README — single-process contrast point
- `FOR UPDATE SKIP LOCKED` claim-pattern adopters (Oban/River/Graphile/pgmq) — search-rate-limited; verifiable in a Phase 0/3 spike

---
*Research completed: 2026-09-08*
*Ready for roadmap: yes*
