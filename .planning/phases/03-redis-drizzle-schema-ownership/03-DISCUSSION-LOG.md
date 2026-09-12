# Phase 3: Redis & Drizzle Schema Ownership - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-12
**Phase:** 3-Redis & Drizzle Schema Ownership
**Areas discussed:** Redis-down limiter behavior, Drizzle runtime footprint, Prod snapshot logistics, Gates/test stack/rollout, Limiter test coverage, Redis auth & binding, Redis client module shape, Index-build risk posture, Cache scope, VPS Redis install method

---

## Redis-down limiter behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Fail-open | Allow requests through, log an error; infra outage never becomes an app outage | ✓ |
| Fail-closed | Reject rate-limited routes with 503 while Redis is down | |
| In-memory fallback | Degrade to the current per-process Map during outage | |

**User's choice:** Fail-open
**Notes:** Follow-ups resolved: visibility = distinctive log marker only (`[redis-limiter] DEGRADED fail-open`), greppable in PM2 logs — real alerting is Phase 5 OBS-03, dead-man switch deliberately NOT conflated; degrade speed = short timeouts (~200 ms command, `maxRetriesPerRequest: 1`, ~500 ms connect); parameters = exact parity (20/min monitors, 5/hr register, fixed-window, per-IP — only the backing store changes).

## Drizzle runtime footprint

| Option | Description | Selected |
|--------|-------------|----------|
| Schema + client | drizzle-kit + schema + runner + src/db client on the shared pool, exercised by tests/smoke, no route uses it yet | ✓ |
| Migrations only | Zero runtime Drizzle; client and pool-sharing happen in Phase 4 | |
| Client + proof route | Also port one low-risk read route (e.g. public status) as production proof | |

**User's choice:** Schema + client
**Notes:** Follow-ups resolved: pool lives in a neutral module (extracted from prisma.ts; prisma.ts re-wraps with PrismaPg; factory-shaped so Phase 4 worker gets its own pool); schema = single `src/db/schema.ts`; production migrate runner executes **on the VPS** (drizzle-kit ships in prod install; single-host runbook order preserved — alternatives "from dev machine" and "raw SQL via psql" rejected); `prisma/schema.prisma` **frozen** with a non-authoritative header (alternative "dual-fidelity lockstep updates" rejected — one source of truth from day one; consequence: test stack must switch off `prisma db push` this phase).

## Prod snapshot logistics

| Option | Description | Selected |
|--------|-------------|----------|
| Repo script | Deterministic scramble of emails/names/chat IDs/tokens; keeps row counts, structure, bcrypt hashes | ✓ |
| Manual SQL pass | Runbook UPDATE statements executed by hand after each restore | |
| Skip anonymization | Restore raw dump locally | |

**User's choice:** Repo script
**Notes:** bcrypt hashes preserved because Phase 7's canary-login rehearsal needs them. Follow-ups resolved: storage = gitignored `.snapshots/` dir, fresh dump per scheduled rehearsal (vs one-time snapshot kept for the milestone); verification = scripted rehearsal command with per-table row-count + checksum comparison (vs typed psql checks); rehearsal runs in a dedicated throwaway docker Postgres isolated from the vitest stack (vs reusing the 5453 test DB).

## Gates, test stack & rollout

| Option | Description | Selected |
|--------|-------------|----------|
| Join pnpm verify | Migrations applied → drizzle-kit pull → diff vs committed schema; non-empty fails verify | ✓ |
| Separate command | pnpm schema:check run only when schema changed | |
| Revive minimal CI | GitHub Actions just for the schema gate | |

**User's choice:** Join pnpm verify
**Notes:** Follow-ups resolved: Vitest global-setup switches `prisma db push` → `drizzle-kit migrate` now (forced by the prisma schema freeze); VPS Redis installed + hardened at Phase 3 deploy with the limiter live immediately (vs deferring to Phase 4 or flagging); 70% memory alert = VPS cron + dedicated healthchecks.io check (vs Telegram DM — ops alerts stay out of the product bot — or deferring to Phase 5, which would leave RDS-03 partially unmet).

## Limiter test coverage

| Option | Description | Selected |
|--------|-------------|----------|
| Full set | Window persistence across client re-creation, enforcement + expiry, fail-open on dead Redis, Lua atomicity under concurrency, no TTL-less keys | ✓ |
| Smoke only | One happy-path enforcement test | |
| Defer to Phase 6 | No limiter tests until the per-user limiter lands | |

**User's choice:** Full set
**Notes:** These tests are success criterion 1's proof instrument; Phase 2's docker-Redis infrastructure exists precisely for this.

## Redis auth & binding

| Option | Description | Selected |
|--------|-------------|----------|
| requirepass + bind | Generated password in REDIS_URL, 127.0.0.1 only, protected-mode on | ✓ |
| Bind only, no auth | Localhost-only, no password | |
| ACL user | Named least-privilege user on top of requirepass | |

**User's choice:** requirepass + bind
**Notes:** ACL rejected — BullMQ (Phase 4) needs broad keyspace access anyway, so it adds ops weight without real gain now.

## Redis client module shape

| Option | Description | Selected |
|--------|-------------|----------|
| Singleton, prisma-style | src/lib/redis.ts global-cached on globalThis, REDIS_URL validated at module load | ✓ |
| Client factory | Clients created per consumer | |
| You decide | Planning picks layout per repo conventions | |

**User's choice:** Singleton, prisma-style
**Notes:** One connection this phase (limiter); BullMQ's separate connections arrive Phase 4 per the pinned budget.

## Index-build risk posture

| Option | Description | Selected |
|--------|-------------|----------|
| Rehearsal-driven rule | Plain in-transaction builds where rehearsal shows sub-second; CONCURRENTLY only where slow | ✓ |
| Always CONCURRENTLY | Zero-lock doctrine regardless of table size | |
| Always plain | In-transaction everywhere, low-traffic-hour deploy documented | |

**User's choice:** Rehearsal-driven rule
**Notes:** The research flag (journal-stamping, CONCURRENTLY transaction-wrapping) stays live — the researcher verifies the no-transaction journal handling for whichever indexes end up CONCURRENTLY.

## Cache scope

| Option | Description | Selected |
|--------|-------------|----------|
| No cache this phase | Budget line reserves headroom only; PROJECT.md's "+ cache" is aspirational | ✓ |
| Minimal cache now | e.g. status-page payloads with short TTL using the reserved connection | |

**User's choice:** No cache this phase
**Notes:** Explicitly closing the ambiguity so the researcher/planner doesn't invent a cache nobody required.

## VPS Redis install method

| Option | Description | Selected |
|--------|-------------|----------|
| apt + systemd | Ubuntu 24.04 native redis-server; systemd supervision matches RDS-03 | ✓ |
| Docker on VPS | Container mirroring the local compose stack | |

**User's choice:** apt + systemd
**Notes:** No docker daemon in the monitoring-infra critical path on the 2 GB VPS.

---

## Claude's Discretion

- Dump format and post-rehearsal retention/hygiene of anonymized dumps
- Checksum implementation (deterministic per-table digest)
- Redis key naming convention
- prisma/schema.prisma deprecation header wording
- .env.example additions per the 02-01 sweep pattern
- Runbook amendment layout/section structure
- Rehearsal container Postgres major version (match Neon)
- drizzle.config.ts specifics (out dir, migrations folder)
- Neutral pool module filename/export shape
- Keeping pnpm verify within the ≤5-minute budget as steps are added

## Deferred Ideas

- Redis cache of any kind — future phase with its own justification
- BullMQ Redis connections — Phase 4
- Real Redis metrics/alerting (Prometheus) — Phase 5 OBS-03
- Drizzle read-path porting + Prisma removal — Phase 7
- Per-user manual-check enqueue limiter — Phase 6 SEC-05
