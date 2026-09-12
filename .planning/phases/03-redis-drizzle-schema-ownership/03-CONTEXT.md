# Phase 3: Redis & Drizzle Schema Ownership - Context

**Gathered:** 2026-09-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Redis enters the stack as pure non-correctness infrastructure — an ioredis client wired prisma-style, the in-memory rate limiter replaced by an atomic Redis-backed one, VPS Redis installed + hardened at this phase's deploy — and the database schema changes ownership: versioned Drizzle migrations baselined from **live production DDL** (never `schema.prisma`), carrying every worker prerequisite addendum (`monitors.next_check_at` + partial index, `write_guards`, `outbox`, partial unique `incidents(monitor_id) WHERE status='ONGOING'`, pinned ID-generation defaults, `error_class`, reserved `consecutive_failures`), rehearsed end-to-end against an anonymized production snapshot before production. `prisma db push --accept-data-loss` dies here. No monitoring-behavior change, no dual-write, no cache, no read-path porting.

</domain>

<decisions>
## Implementation Decisions

### Redis rate limiter (RDS-02)
- **D-01:** **Fail-open on Redis outage** — requests pass through when Redis is unreachable. Redis is pure infrastructure (hard constraint #1); an infra outage must never become an app outage. No fail-closed, no in-memory fallback (that would re-import the process-local state pattern this migration deletes).
- **D-02:** **Log-marker visibility only** — degradation emits a distinctive `console.error` (e.g. `[redis-limiter] DEGRADED fail-open`), greppable in PM2 logs. Real metrics/alerting arrive with Phase 5 OBS-03. Do NOT wire limiter degradation into the healthchecks.io dead-man switch (that signal means "cron broken" — conflating them invites false pages).
- **D-03:** **Fast degrade** — ioredis client tuned so a dead Redis costs each request milliseconds, not seconds: ~200 ms command timeout, `maxRetriesPerRequest: 1`, ~500 ms connectTimeout. Fail-open only works if degradation is fast.
- **D-04:** **Exact parameter parity** — 20/min per-IP on monitors, 5/hour per-IP on register, fixed-window semantics, same bucket identifiers. Only the backing store changes (Map → Redis via one atomic Lua script, INCR + EXPIRE-with-NX — locked from Phase 01 IN-01/OBS-04). Policy tuning stays out of this phase.

### Drizzle adoption (DRZ-01..05, DAT-09)
- **D-05:** **Runtime footprint = schema + client.** drizzle-kit config, `src/db/schema.ts`, the migrate runner, AND a `src/db` Drizzle client bound to the shared pg.Pool — importable and exercised by tests/smoke, but **no route consumes it yet** (read-path porting is Phase 7). This proves DAT-09's shared-pool arrangement in production before Phase 4's worker depends on it.
- **D-06:** **Neutral pool module** — the pg.Pool + sizing/timeout config moves out of `src/lib/prisma.ts` into a neutral module (e.g. `src/lib/db-pool.ts`); `prisma.ts` wraps it with PrismaPg, the Drizzle client consumes the same instance. Nothing depends on the module Phase 7 deletes. Shape it so Phase 4's worker can create its own pool against its own budget (web 10 / worker 20 — per-process, never one shared pool across processes).
- **D-07:** **Single schema file** — `src/db/schema.ts` holds all ~10 tables (users, accounts, sessions, verification tokens, monitors, pings, incidents, feedback, write_guards, outbox) transcribed DDL-precise from audit §11 against live `pg_dump`.
- **D-08:** **Migrate runner executes on the VPS** — drizzle-kit + schema + config ship in the prod install (a small dependency, not a toolchain). The runbook's Migrate step stays a typed single-host command in the pinned order: build → backup → migrate → restart (activates this phase per 01-07/WR-03).
- **D-09:** **`prisma/schema.prisma` is frozen** — add a "no longer authoritative" header, stop editing it entirely. The Prisma client keeps serving existing reads/writes of known columns against the grown DB. Drizzle is the single schema authority from day one. **Consequence:** the test stack MUST switch off `prisma db push` this phase (D-13) — a stale push would DROP the new columns.

### Prod snapshot rehearsal (DRZ-06)
- **D-10:** **Repo anonymization script** — deterministically scrambles emails, names, telegram chat IDs, and OAuth/session tokens while PRESERVING row counts, structure, and bcrypt hashes (Phase 7's canary-login rehearsal needs real hashes). Repeatable for every future rehearsal.
- **D-11:** **Gitignored snapshots dir** (e.g. `.snapshots/prod-YYYYMMDD.dump`); the user takes a FRESH dump each time a rehearsal is scheduled (Phase 3 baseline now, Phase 7 auth cutover later) so rehearsal always reflects current prod drift. Never committed.
- **D-12:** **Scripted rehearsal + dedicated container** — a rehearsal command (e.g. `pnpm rehearse:migrations`) spins up its own throwaway docker Postgres (own port, fully isolated from the vitest stack at 5453), restores the snapshot, runs migrations, then compares per-table row counts + checksums before/after: data must be untouched, only additive DDL may appear. Evidence written to a file. No typed-by-hand verification math.

### Gates & test stack (DRZ-03, DRZ-02)
- **D-13:** **Empty-diff gate joins `pnpm verify`** — after docker Postgres is up: apply migrations, introspect with `drizzle-kit pull`, diff against the committed schema; a non-empty diff fails verify. Carries the Phase 2 no-CI posture (02-CONTEXT D-01/D-02). No CI revival.
- **D-14:** **Vitest global-setup switches to `drizzle-kit migrate`** this phase (replacing `prisma db push`, forced by D-09). Every test run then exercises the real migration files — journal/ordering issues surface continuously.

### Rollout & VPS
- **D-15:** **VPS Redis installed at Phase 3 deploy** — the runbook documents install + hardening (AOF `everysec`, `maxmemory-policy noeviction`, supervised restart, 70% memory alert) and the limiter goes live against it immediately. No flag, no deferral to Phase 4. Redis is non-correctness, so risk stays low, and Phase 4 needs it anyway.
- **D-16:** **70% memory alert = VPS cron + dedicated healthchecks.io check** — a tiny cron job checks `redis-cli INFO` memory against the threshold and pings a dedicated check (user provisions the check — manual step for the runbook). Ops alerts stay out of the product's Telegram bot. Phase 5 observability supersedes it.
- **D-17:** **apt + systemd install** — Ubuntu 24.04's native `redis-server` package; systemd supervision satisfies RDS-03's "supervised restart" directly. No docker daemon in the monitoring-infra critical path on the 2 GB VPS.
- **D-18:** **`requirepass` + `bind 127.0.0.1`** (+ protected-mode) — REDIS_URL carries a generated password (`redis://:pass@127.0.0.1:6379`); the runbook documents generation (`openssl rand`) and the `/etc/redis/redis.conf` lines. Any compromised local process still can't touch Redis. No ACL user — BullMQ (Phase 4) needs broad keyspace access anyway.

### Index builds (research-flag adjacent)
- **D-19:** **Rehearsal-driven rule** — the snapshot rehearsal measures actual index build times: plain in-transaction `CREATE INDEX` where builds are sub-second on real data; `CREATE INDEX CONCURRENTLY` (with the researcher-verified no-transaction journal handling — the flagged research item) only for any index that proves slow. The rehearsal earns its keep as the decision-maker.

### Test coverage (criterion 1's proof)
- **D-20:** **Full limiter integration test set** against docker Redis: window survives client re-creation (simulated process restart), limit enforced + window expiry resets, fail-open when Redis is unreachable (dead port), Lua atomicity under concurrent hammering, EXPIRE-with-NX leaves no TTL-less keys. These tests ARE success criterion 1's proof.

### Client shape & cache
- **D-21:** **`src/lib/redis.ts` singleton, prisma-style** — ioredis client cached on `globalThis` for HMR survival, `REDIS_URL` validated at module load (throw-early, like `baseApi.ts`). One connection this phase (the limiter); BullMQ's separate blocking/queue connections arrive Phase 4 per the pinned budget.
- **D-22:** **No cache this phase** — PROJECT.md's "+ cache" is aspirational; the 01-08 budget line merely reserves connection headroom. Any real cache need (e.g. status-page reads) gets its own future justification. The researcher must not invent one.

### Claude's Discretion
- Dump format (`-Fc` vs plain SQL) and post-rehearsal retention/hygiene of anonymized dumps
- Checksum implementation (per-table deterministic digest) — must be documented and stable
- Redis key naming (colon-separated convention, e.g. `rl:{bucket}:{ip}`)
- `prisma/schema.prisma` deprecation header wording
- `.env.example` additions (`REDIS_URL`, any rehearsal/test vars) per the 02-01 sweep pattern
- Runbook amendment layout: new sections for VPS Redis install/hardening, memory-alert cron, rehearsal procedure; Migrate-step activation wording
- Rehearsal container's Postgres major version (match Neon's)
- `drizzle.config.ts` specifics (out dir, migrations folder location)
- Exact neutral pool module filename (D-06) and export shape
- Keeping `pnpm verify` within Phase 2's ≤5-minute budget (D-20 of 02-CONTEXT) as steps are added

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design source documents (amended by Phase 01, verdict READY)
- `docs/ARCHITECTURE-AUDIT.md` §11 — DDL-precise schema addendum: THE transcription source for `src/db/schema.ts` (column-level types/defaults/nullability, partial-index predicates, `write_guards`/`outbox` columns, pinned ID-generation defaults)
- `docs/ARCHITECTURE-AUDIT.md` §25 — connection budget (web 10 / worker 20 / migrations 1; statement/idle timeouts; pooled-vs-direct strings)
- `docs/ARCHITECTURE-AUDIT.md` Appendix B — the 20 architectural rules traceability (hard constraints live here)
- `docs/ARCHITECTURE-REVIEW.md` — issue vocabulary (J/D/R/A/S/M/P IDs); verdict READY since 2026-09-09
- `docs/DEPLOY-RUNBOOK.md` — phase-conditional Migrate step (activates THIS phase per WR-03/01-07); this phase amends it: VPS Redis install + hardening (D-15/D-17/D-18), memory-alert cron (D-16), snapshot rehearsal procedure (D-10..D-12)

### Planning artifacts
- `.planning/REQUIREMENTS.md` — RDS-01..03, DRZ-01..06, DAT-09 (this phase's 10 requirements with pinned bounds)
- `.planning/PROJECT.md` — locked defaults Q-1..Q-5 (esp. Q-3 self-hosted Redis), rehearsal strategy D-9/D-10, Key Decisions table
- `.planning/ROADMAP.md` §Phase 3 — goal + 5 success criteria (the contract this context serves) + research flag (drizzle-kit journal-stamping, `CREATE INDEX CONCURRENTLY` transaction-wrapping)
- `.planning/phases/01-design-gate-review-verdict-ready/01-CONTEXT.md` — DDL-precision decisions (D-05), literal-SQL writer specs (D-06), parameter pins (D-10..D-14) that Phase 3 transcribes
- `.planning/phases/02-foundations-theme-infrastructure/02-CONTEXT.md` — manual-deploy posture (D-01..D-05), `pnpm verify` chain + ≤5 min budget (D-02/D-20), test-stack decisions (D-15/D-16: real-Postgres integration, seeded via raw SQL, ports 5453/6390)

### Codebase maps (pre-Phase-02 on tooling — pnpm/Vitest landed after; architecture still accurate)
- `.planning/codebase/ARCHITECTURE.md` — data-flow and layer map the limiter/pool work integrates into
- `.planning/codebase/INTEGRATIONS.md` — current Postgres/Prisma + external-service inventory
- `.planning/codebase/STACK.md` — dependency state before this phase's additions

### Project skills (implementation guidance for this phase's Redis work)
- `.claude/skills/redis-connections/SKILL.md` — client lifecycle/multiplexing (informs D-21)
- `.claude/skills/redis-core/SKILL.md` — key naming conventions (discretion item)
- `.claude/skills/redis-security/SKILL.md` — hardening checklist backing D-17/D-18
- `.claude/skills/redis-observability/SKILL.md` — memory monitoring context for D-16

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/rate-limit.ts` — the module being replaced; its call-site contract (`rateLimit(identifier, { limit, windowMs })` → `{ success, remaining }`, plus `getIP(req)`) is worth preserving so the two routes change minimally
- `src/lib/prisma.ts` — the global-cached singleton pattern (globalThis + module-load validation) that both `src/lib/redis.ts` (D-21) and the pool extraction (D-06) mirror
- `docker-compose.dev.yml` — test stack already runs Postgres (5453) AND Redis (6390); the Redis container has been unused by app code since Phase 2 — this phase wires it
- Vitest global-setup (currently `prisma db push` per 02-02) — the switch target for D-14
- `.env.example` — the 24-var documented sweep from 02-01; `REDIS_URL` joins it
- `ecosystem.config.js` — PM2 web app; unchanged this phase (worker app arrives Phase 4)

### Established Patterns
- Startup validation: throw at module load if env is missing (`src/redux/api/baseApi.ts` convention) — applies to `REDIS_URL` (D-21)
- Handler-import test harness with two mock seams (`getServerSession`, `@/lib/prisma`) — the limiter swap must not break the Phase 2 characterization suite (04 API contracts pin 429 behavior)
- `fileParallelism: false` for DB-backed integration tests (shared Postgres, TRUNCATE per case) — new limiter tests join this discipline

### Integration Points
- `src/app/api/monitors/route.ts:39` — limiter call site #1 (`monitors_${ip}`, 20/min)
- `src/app/api/auth/register/route.ts:12` — limiter call site #2 (`register_${ip}`, 5/hour)
- `src/lib/prisma.ts` — pool extraction origin (D-06); PrismaPg adapter re-wraps the neutral pool
- `package.json` — `verify` chain extension (empty-diff gate, migrated global-setup), prodDeps addition (drizzle-kit per D-08), new scripts (rehearse:migrations per D-12)
- `docs/DEPLOY-RUNBOOK.md` — amendments enumerated in canonical refs

</code_context>

<specifics>
## Specific Ideas

- The fail-open choice is a philosophy statement, not just a tactic: **Redis is pure infrastructure — an infra outage never becomes an app outage.** Every Redis-touching decision in later phases should be tested against it.
- Parameter parity is the compatibility anchor: the ONLY observable change from the limiter swap is that windows survive process restarts (which is criterion 1 — the point of the change).
- The user holds all prod access: pg_dump production, anonymize locally, provision the healthchecks.io memory check, install/harden Redis on the VPS — all their manual steps, all runbook-documented.

</specifics>

<deferred>
## Deferred Ideas

- Any Redis cache (e.g. status-page read caching) — deliberately not this phase (D-22); needs its own justification in a future phase
- BullMQ Redis connections (queue producer on web; blocking + queue connections on worker) — Phase 4 per the pinned connection budget
- Real Redis metrics/alerting (Prometheus export, memory/depth/stalled) — Phase 5 OBS-03 supersedes the cron + healthchecks.io memory alert (D-16)
- Drizzle read-path porting and Prisma removal — Phase 7 (DRZ-07)
- Per-user manual-check enqueue limiter (D-13 of Phase 01: 1/monitor/30s, 6/min) — Phase 6 SEC-05

</deferred>

---

*Phase: 3-Redis & Drizzle Schema Ownership*
*Context gathered: 2026-09-12*
