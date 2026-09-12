# Phase 3: Redis & Drizzle Schema Ownership - Research

**Researched:** 2026-09-12
**Domain:** Redis-backed rate limiting (ioredis 6) · Drizzle ORM/Kit adoption baselined from live production DDL · migration rehearsal tooling · VPS Redis hardening
**Confidence:** HIGH (core mechanics verified against shipped package source and official docs; see Sources)

## Summary

Phase 3 is an infrastructure-ownership phase with two halves. The Redis half replaces the in-memory `Map` limiter (`src/lib/rate-limit.ts`) with an atomic Redis-backed Lua limiter behind a fail-open contract (D-01..D-04, D-21), installs and hardens Redis on the VPS (D-15..D-18), and proves everything with a dedicated integration test set against docker Redis (D-20). The Drizzle half moves schema ownership from a frozen `schema.prisma` to versioned drizzle-kit migrations baselined from **live production DDL** (never `schema.prisma`), carrying every worker prerequisite from audit §11, rehearsed against an anonymized production snapshot (D-10..D-12), with an empty-diff gate joining `pnpm verify` (D-13) and the vitest global-setup switching off `prisma db push` (D-14).

**Both carried-over research flags are now resolved with source-level verification:**

1. **Journal-stamping (flag a) — RESOLVED.** drizzle-orm 0.45.2's migration bookkeeping is fully understood from the shipped source: applied-migrations live in `drizzle.__drizzle_migrations (id SERIAL PK, hash text, created_at bigint)`; a migration's `hash` is the **SHA-256 hex digest of its `.sql` file content**; `created_at` is the journal entry's `when` (folderMillis); and `migrate` decides what to apply by comparing `folderMillis > last applied created_at` — **timestamp-ordered, not hash-matched** [VERIFIED: drizzle-orm@0.45.2 source, `pg-core/dialect.js` + `migrator.js`]. An official baselining flag exists (`drizzle-kit pull --init` — "marks the pulled schema as an applied migration in your database") [CITED: orm.drizzle.team/docs/drizzle-kit-pull], but it is **non-deterministic across runs** (it generates its own journal tags/timestamps each time), which breaks D-12's repeatability requirement. The correct mechanism for this project is a **deterministic hand-stamp**: a small script that inserts `(hash, created_at)` rows for the committed baseline migration, using the exact sha256+folderMillis computation the migrator itself uses. See Pattern 4.
2. **Transaction wrapping vs `CREATE INDEX CONCURRENTLY` (flag b) — RESOLVED.** Verified from the shipped 0.45.2 `PgDialect.migrate`: **all pending migrations execute inside ONE `session.transaction`**, each statement via `tx.execute(sql.raw(stmt))`, with the bookkeeping insert in the same transaction [VERIFIED: drizzle-orm@0.45.2 `pg-core/dialect.js`]. `CREATE INDEX CONCURRENTLY` therefore **cannot run through the standard runner** (Postgres rejects it inside a transaction block; upstream issue drizzle-orm#860 has been open since 2023, PR #6133 still open) [CITED: github.com/drizzle-team/drizzle-orm/issues/860]. This **validates D-19's rehearsal-driven default**: plain in-transaction `CREATE INDEX` for sub-second builds (expected at this dataset size), and if any index proves slow in rehearsal it must be applied **outside the runner** (documented psql step in the runbook), not through `drizzle-kit migrate`. The `--> statement-breakpoint` comment splits statements but does **not** break the transaction wrapper — do not assume per-statement autocommit.

**Primary recommendation:** Build the phase around four artifacts — (1) `src/lib/redis.ts` singleton (throw-early `REDIS_URL`, `commandTimeout ≈ 200ms`, `maxRetriesPerRequest: 1`, `connectTimeout ≈ 500ms`, an attached `error` listener, and the limiter Lua via `defineCommand`); (2) the journal-stamped Drizzle baseline (baseline migration + deterministic stamp script + worker-prerequisite migration authored with `drizzle-kit generate --custom`); (3) the rehearsal pipeline (`pg_restore` via docker exec → stamp → migrate → row-count/checksum compare → evidence file); (4) the empty-diff verify gate with `schemaFilter: ["public"]`. Keep every existing observable behavior identical — the only visible change is that limit windows survive process restarts.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
Copied verbatim from `.planning/phases/03-redis-drizzle-schema-ownership/03-CONTEXT.md` §Implementation Decisions:

- **D-01:** **Fail-open on Redis outage** — requests pass through when Redis is unreachable. Redis is pure infrastructure (hard constraint #1); an infra outage must never become an app outage. No fail-closed, no in-memory fallback (that would re-import the process-local state pattern this migration deletes).
- **D-02:** **Log-marker visibility only** — degradation emits a distinctive `console.error` (e.g. `[redis-limiter] DEGRADED fail-open`), greppable in PM2 logs. Real metrics/alerting arrive with Phase 5 OBS-03. Do NOT wire limiter degradation into the healthchecks.io dead-man switch.
- **D-03:** **Fast degrade** — ioredis client tuned so a dead Redis costs each request milliseconds, not seconds: ~200 ms command timeout, `maxRetriesPerRequest: 1`, ~500 ms connectTimeout. Fail-open only works if degradation is fast.
- **D-04:** **Exact parameter parity** — 20/min per-IP on monitors, 5/hour per-IP on register, fixed-window semantics, same bucket identifiers. Only the backing store changes (Map → Redis via one atomic Lua script, INCR + EXPIRE-with-NX). Policy tuning stays out of this phase.
- **D-05:** **Runtime footprint = schema + client.** drizzle-kit config, `src/db/schema.ts`, the migrate runner, AND a `src/db` Drizzle client bound to the shared pg.Pool — importable and exercised by tests/smoke, but **no route consumes it yet**.
- **D-06:** **Neutral pool module** — the pg.Pool + sizing/timeout config moves out of `src/lib/prisma.ts` into a neutral module (e.g. `src/lib/db-pool.ts`); `prisma.ts` wraps it with PrismaPg, the Drizzle client consumes the same instance. Shape it so Phase 4's worker can create its own pool against its own budget (web 10 / worker 20 — per-process, never one shared pool across processes).
- **D-07:** **Single schema file** — `src/db/schema.ts` holds all ~10 tables transcribed DDL-precise from audit §11 against live `pg_dump`.
- **D-08:** **Migrate runner executes on the VPS** — drizzle-kit + schema + config ship in the prod install. Runbook Migrate step stays a typed single-host command in the pinned order: build → backup → migrate → restart.
- **D-09:** **`prisma/schema.prisma` is frozen** — add a "no longer authoritative" header, stop editing it entirely. Drizzle is the single schema authority from day one. **Consequence:** the test stack MUST switch off `prisma db push` this phase (D-13).
- **D-10:** **Repo anonymization script** — deterministically scrambles emails, names, telegram chat IDs, and OAuth/session tokens while PRESERVING row counts, structure, and bcrypt hashes. Repeatable for every future rehearsal.
- **D-11:** **Gitignored snapshots dir** (e.g. `.snapshots/prod-YYYYMMDD.dump`); the user takes a FRESH dump each time a rehearsal is scheduled. Never committed.
- **D-12:** **Scripted rehearsal + dedicated container** — a rehearsal command (e.g. `pnpm rehearse:migrations`) spins up its own throwaway docker Postgres (own port, fully isolated from the vitest stack at 5453), restores the snapshot, runs migrations, then compares per-table row counts + checksums before/after. Evidence written to a file. No typed-by-hand verification math.
- **D-13:** **Empty-diff gate joins `pnpm verify`** — after docker Postgres is up: apply migrations, introspect with `drizzle-kit pull`, diff against the committed schema; a non-empty diff fails verify. No CI revival.
- **D-14:** **Vitest global-setup switches to `drizzle-kit migrate`** this phase (replacing `prisma db push`, forced by D-09).
- **D-15:** **VPS Redis installed at Phase 3 deploy** — runbook documents install + hardening (AOF `everysec`, `maxmemory-policy noeviction`, supervised restart, 70% memory alert) and the limiter goes live against it immediately. No flag, no deferral to Phase 4.
- **D-16:** **70% memory alert = VPS cron + dedicated healthchecks.io check** — user provisions the check (manual step for the runbook).
- **D-17:** **apt + systemd install** — Ubuntu 24.04's native `redis-server` package; systemd supervision satisfies RDS-03's "supervised restart". No docker daemon in the monitoring-infra critical path on the 2 GB VPS.
- **D-18:** **`requirepass` + `bind 127.0.0.1`** (+ protected-mode) — REDIS_URL carries a generated password (`redis://:pass@127.0.0.1:6379`); runbook documents generation (`openssl rand`) and the `/etc/redis/redis.conf` lines. No ACL user.
- **D-19:** **Rehearsal-driven rule** — the snapshot rehearsal measures actual index build times: plain in-transaction `CREATE INDEX` where builds are sub-second on real data; `CREATE INDEX CONCURRENTLY` (with the researcher-verified no-transaction journal handling) only for any index that proves slow.
- **D-20:** **Full limiter integration test set** against docker Redis: window survives client re-creation (simulated process restart), limit enforced + window expiry resets, fail-open when Redis is unreachable (dead port), Lua atomicity under concurrent hammering, EXPIRE-with-NX leaves no TTL-less keys. These tests ARE success criterion 1's proof.
- **D-21:** **`src/lib/redis.ts` singleton, prisma-style** — ioredis client cached on `globalThis` for HMR survival, `REDIS_URL` validated at module load (throw-early). One connection this phase (the limiter); BullMQ's separate connections arrive Phase 4.
- **D-22:** **No cache this phase** — the researcher must not invent one.

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
- Keeping `pnpm verify` within Phase 2's ≤5-minute budget (02-CONTEXT D-20) as steps are added

### Deferred Ideas (OUT OF SCOPE)
- Any Redis cache (e.g. status-page read caching) — deliberately not this phase (D-22)
- BullMQ Redis connections (queue producer on web; blocking + queue connections on worker) — Phase 4 per the pinned connection budget
- Real Redis metrics/alerting (Prometheus export, memory/depth/stalled) — Phase 5 OBS-03 supersedes the cron + healthchecks.io memory alert (D-16)
- Drizzle read-path porting and Prisma removal — Phase 7 (DRZ-07)
- Per-user manual-check enqueue limiter — Phase 6 SEC-05
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RDS-01 | Redis introduced (ioredis 6) with correct client config: separate blocking + queue connections, `maxRetriesPerRequest: null`, no `keyPrefix` | ioredis 6.0.0 confirmed current `latest` on npm [VERIFIED: npm registry]; singleton pattern (Pattern 1); BullMQ connection law documented (Pitfall 5) so Phase 3's config never conflicts with Phase 4's worker connections. Note: the `maxRetriesPerRequest: null` blocking/queue connection requirement is exercised when BullMQ lands (Phase 4, per D-21/deferred); Phase 3 delivers the ioredis 6 install, singleton, `REDIS_URL`, and the no-`keyPrefix` discipline |
| RDS-02 | Redis-backed rate limiting replaces the in-memory Map (atomic INCR+EXPIRE per bucket) | Atomic Lua via `defineCommand` (Pattern 2, verified ioredis API); parameter parity with existing call sites verified in code; fail-open contract (D-01..D-03) mapped to verified ioredis options |
| RDS-03 | Redis hardening applied and documented: AOF `everysec`, `maxmemory-policy noeviction`, supervised restart, memory alerting at 70% | Verified semantics of `appendfsync everysec` (≤1s loss), `noeviction` (writes error, reads fine), Ubuntu `Type=notify` ↔ `supervised systemd` sync requirement (Pattern 6) |
| DRZ-01 | Drizzle schema authored from live production DDL, equivalence proven by empty diff or explicitly reviewed delta | `drizzle-kit pull` mechanics + `schemaFilter: ["public"]` gotcha + `--init` analysis (Pattern 3, Pitfall 4) |
| DRZ-02 | Versioned drizzle-kit migrations replace `prisma db push`; single migration runner; `--accept-data-loss` deleted | Journal/bookkeeping internals fully verified (Pattern 4); runbook Migrate step activation wording (D-08) |
| DRZ-03 | Empty-diff CI gate (`drizzle-kit pull` diffed against committed schema) | Gate design in Pattern 3: apply → pull → diff, plus complementary `drizzle-kit generate` no-change signal |
| DRZ-04 | Schema addenda in the Drizzle schema (`next_check_at` + partial index, `write_guards`, `outbox`, partial unique ONGOING index, pinned ID defaults, `error_class`, `consecutive_failures`) | Audit §11 DDL is the transcription source (canonical ref); Drizzle partial-index fragment syntax already pinned in §11; `generate --custom` is the documented route for hand-authored additive SQL |
| DRZ-05 | Drizzle adopted additively sharing one `pg` Pool with Prisma; no dual-write | `drizzle({ client: pool })` verified as the official existing-Pool binding (Pattern 5); neutral pool module design (D-06) |
| DRZ-06 | Migrations rehearsed against an anonymized local prod snapshot with row-count + checksum verification | Rehearsal pipeline design (Pattern 4 + Anonymization pattern); deterministic stamp is load-bearing; docker-exec restore path (Environment Availability) |
| DAT-09 | Connection budget enforced: web 10 / worker 20 / migration runner 1; shared pool during transition; statement + idle timeouts; pooled string for web reads, direct for migrations | Audit §25 is the spec (canonical ref); neutral pool module (D-06) is the code shape; §25.2 pinned pool options transcribe into it |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Extracted directives that bind this phase:

- **GSD workflow enforcement:** all file changes go through GSD entry points (`$gsd-execute-phase` for planned work). No direct repo edits outside a GSD workflow.
- **No new user-facing features** — backend/infrastructure modernization only. The limiter swap and schema work must be behavior-identical externally (monitoring semantics, API shapes preserved).
- **Live production system:** every migration step ships revertibly with monitoring continuity preserved; full `pg_dump` backup + anonymized-snapshot rehearsal before production (also D-9/D-10 in STATE.md).
- **Stack:** pnpm (Volta shim, `pnpm@10.34.5` via `packageManager`), Node `>=22 <25` (24 standard), TypeScript strict, ESLint 9 flat config, Tailwind v4. New deps: drizzle-orm, drizzle-kit, ioredis.
- **Conventions to honor:** `"use client"` for interactive components (n/a this phase); API route handlers server-side with try/catch → `NextResponse.json({ error }, { status })`; `console.error("<Context>:", error)` logging style; singleton-with-globalThis pattern for shared clients; always import `prisma` from `@/lib/prisma`; new comments in English (existing Bangla comments in `prisma.ts` are legacy); `@/*` path alias; match each file's quoting style.
- **Never log secrets/passwords.**
- **Project skills to apply:** `redis-core` (key naming: lowercase colon-separated, short but readable — informs the discretion item), `redis-connections` (explicit timeouts rule: connect < read; multiplexing), `redis-security` (requirepass + bind 127.0.0.1 + protected-mode backing D-17/D-18), `redis-observability` (`used_memory` / `INFO memory` for the 70% alert backing D-16).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Rate limiting (fixed-window, per-IP) | API / Backend (`src/lib/rate-limit.ts`, two route call sites) | Redis (backing store only) | Authorization decision stays in route handlers; Redis is pure state storage with zero correctness dependence (hard constraint #1) |
| Redis client lifecycle | API / Backend (`src/lib/redis.ts` singleton) | — | One ioredis instance per process this phase, globalThis-cached like `prisma`; connections are per-process, never shared across processes |
| Redis service (install/harden/run) | VPS OS layer (systemd, apt) | — | D-17: native package + systemd supervision; product code never manages the service |
| Redis memory alerting | VPS OS layer (cron) + healthchecks.io | — (Phase 5 OBS-03 supersedes) | D-16: ops alert stays out of the product's Telegram bot |
| Schema authority / DDL ownership | Persistence layer (`src/db/schema.ts` + `drizzle/` migrations + drizzle-kit) | Migration runner on VPS (one-shot, direct connection, `max=1`) | Audit M-1/M-3: single versioned authority, single runner; Prisma frozen (D-09) |
| pg Pool ownership | Persistence layer (neutral `src/lib/db-pool.ts`) | API (web budget 10) | D-06/DAT-09: budget counts pools not ORMs; Prisma + Drizzle consume one pool per process |
| Data reads/writes (existing routes) | API / Backend via Prisma (unchanged) | Drizzle (importable, unconsumed — D-05) | No dual-write (out-of-scope table); read-path porting is Phase 7 |
| Snapshot anonymization + rehearsal | Dev machine tooling (repo scripts + throwaway docker Postgres) | — | D-10..D-12: repeatable, isolated from the vitest stack, evidence to file |
| Migration history bookkeeping | Database (`drizzle.__drizzle_migrations`) | Migration runner | Verified table shape/hash/timestamp semantics (Pattern 4) |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ioredis` | 6.0.0 (`latest` dist-tag; install `^6.0.0`) | Redis client for the rate limiter (and BullMQ's client in Phase 4) | Maintained under the redis org (github.com/redis/ioredis); the client BullMQ is documented against; ~20.5M weekly downloads [VERIFIED: npm registry + package-legitimacy OK] |
| `drizzle-orm` | 0.45.2 (current stable `latest`; install `^0.45.2`) | TypeScript ORM; `src/db` client bound to the shared pg Pool; migrator internals | The design documents' pinned ORM (audit §11); 16.3M weekly downloads [VERIFIED: npm registry + package-legitimacy OK]. **Do NOT adopt the v1.0.0-beta** — it removes the top-level `meta/_journal.json` and restructures migration folders, invalidating the journal mechanics verified here [CITED: orm.drizzle.team/docs/latest-releases/drizzle-orm-v1beta2] |
| `drizzle-kit` | 0.31.10 (install `^0.31.10`; goes in `dependencies` per D-08 — the migrate runner executes on the VPS) | `generate` / `migrate` / `pull` CLI; ships in the prod install | 13.5M weekly downloads; same repo as drizzle-orm [VERIFIED: npm registry + package-legitimacy OK] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pg` | ^8.22.0 (already installed) | The Pool both ORMs share; `drizzle({ client: pool })` consumes it | Neutral pool module (D-06); no new install |
| `docker` (postgres:17-alpine, redis:8-alpine) | Docker 29.7.2 / Compose v5.5.0 on this machine | Test stack (5453/6390) + rehearsal throwaway container | `docker compose -f docker-compose.test.yml up -d --wait`; rehearsal spins its own instance on a separate port |
| `node:crypto` | built-in | sha256 for journal stamps and rehearsal checksums | The stamp script MUST use the same computation as the migrator (Pattern 4) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ioredis | node-redis | Rejected implicitly by the stack pin — BullMQ's connection law is documented against ioredis adapters; node-redis is viable only via BullMQ's adapter layer [CITED: docs.bullmq.io/guide/connections]. No reason to deviate |
| drizzle-kit migrate CLI | `migrate()` from `drizzle-orm/node-postgres/migrator` invoked from a script | Same engine underneath (CLI shells to the migrator). CLI keeps the runbook Migrate step a one-liner (D-08) and matches the global-setup switch (D-14). The programmatic form is worth knowing: it exposes `readMigrationFiles` whose output (hash, folderMillis) the stamp script mirrors |
| PostgreSQL Anonymizer extension | plain deterministic SQL UPDATEs | Extension adds a dependency to the rehearsal container and a Neon-compat consideration; plain id-derived UPDATEs in a repo script satisfy D-10 with zero deps [CITED: postgresql-anonymizer.readthedocs.io — standard pattern is dump → restore → mask]. Recommended: plain SQL |

**Installation:**
```bash
pnpm add ioredis@^6.0.0 drizzle-orm@^0.45.2
pnpm add drizzle-kit@^0.31.10 --save-prod   # prod dep per D-08 — runner executes on the VPS
```

**Version verification (2026-09-12, `npm view`):** `drizzle-orm` 0.45.2 · `drizzle-kit` 0.31.10 · `ioredis` 6.0.0 (dist-tags: `next: 5.0.4`, `latest: 6.0.0` — pin `^6.0.0`, do not float to `next`). All three re-verified clean by the legitimacy gate below.

## Package Legitimacy Audit

Gate run 2026-09-12 via `gsd-tools query package-legitimacy check --ecosystem npm` + `npm view` registry verification + `npm view <pkg> scripts.postinstall` (all empty/null — no install-script risk).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| ioredis | npm | latest publish 2026-07-31; project since 2011 | ~20.5M/wk | github.com/redis/ioredis | OK | Approved |
| drizzle-orm | npm | latest publish 2026-03-27; project since 2021 | ~16.3M/wk | github.com/drizzle-team/drizzle-orm | OK | Approved |
| drizzle-kit | npm | latest publish 2026-03-17; project since 2021 | ~13.5M/wk | github.com/drizzle-team/drizzle-orm (monorepo) | OK | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

All three were additionally confirmed against official documentation (orm.drizzle.team, redis/ioredis README + source, docs.bullmq.io naming ioredis) — so they carry `[VERIFIED: npm registry]` rather than `[ASSUMED]` per the provenance rule. No `checkpoint:human-verify` gates required for installs.

## Architecture Patterns

### System Architecture Diagram

```text
                       DEV MACHINE                                VPS (Ubuntu 24.04, PM2)
 ┌──────────────────────────────────────────────┐      ┌─────────────────────────────────────────────┐
 │                                              │      │                                             │
 │  pnpm verify                                 │      │   Deploy (runbook §3, M-step now ACTIVE)    │
 │  ├─ docker test stack up (PG 5453, R 6390)   │      │   build → tarball → ship → install(--prod)  │
 │  ├─ lint / typecheck                         │      │     │                                       │
 │  ├─ vitest (global-setup = drizzle-kit       │      │     ▼                                       │
 │  │   migrate ← drizzle/ migrations folder)   │      │   pg_dump backup (pre-release-<SHA>.dump)   │
 │  ├─ [NEW] empty-diff gate:                   │      │     │                                       │
 │  │   migrate fresh PG → drizzle-kit pull     │      │     ▼                                       │
 │  │   → diff vs src/db/schema.ts → fail≠∅     │      │   pnpm drizzle-kit migrate  (single runner, │
 │  ├─ build / e2e                              │      │     max=1, DIRECT string; first release     │
 │  │                                           │      │     ALSO stamps the baseline row — one-time)│
 │  pnpm rehearse:migrations                    │      │     │                                       │
 │  ├─ throwaway PG container (own port)        │      │     ▼                                       │
 │  ├─ pg_restore .snapshots/prod-*.dump        │      │   pm2 restart uptime-tracker (web)          │
 │  │   (via docker exec — no local pg_restore) │      │     ├─ src/lib/redis.ts → 127.0.0.1:6379    │
 │  ├─ anonymize (deterministic UPDATEs,        │      │     │   (requirepass; fail-open limiter)     │
 │  │   bcrypt hashes preserved)                │      │     └─ prisma (frozen schema) + drizzle    │
 │  ├─ stamp baseline row (sha256 + folderMillis)│     │        client — ONE shared pg.Pool (max 10)│
 │  ├─ drizzle-kit migrate (applies 0001+)      │      │                                             │
 │  └─ row counts + checksums before/after      │      │   redis-server (apt, systemd Type=notify,   │
 │      → evidence file                         │      │     supervised systemd; AOF everysec;       │
 │                                              │      │     noeviction; bind 127.0.0.1; requirepass)│
 └──────────────────────────────────────────────┘      │   cron: memory check → healthchecks.io      │
        ▲                                              └─────────────────────────────────────────────┘
        │ user takes FRESH pg_dump from Neon prod
        │ into .snapshots/ (gitignored) — manual step
 ┌──────┴───────────┐
 │ Neon PostgreSQL  │  ← source of truth, UNCHANGED data this phase
 │ (production)     │  ← schema grows additively at deploy (new columns/tables only)
 └──────────────────┘
```

Request path after the limiter swap (the only runtime behavior change):

```text
POST /api/monitors ──▶ rateLimit("monitors_"+ip, {20, 60s})
                          │  one Lua call: INCR rl:... + EXPIRE ... NX (first incr)
                          ├─ Redis up   → {success, remaining}   (identical semantics to the Map)
                          ├─ Redis down → commandTimeout/maxRetries reject in ≤~200ms
                          │               console.error("[redis-limiter] DEGRADED fail-open")
                          └─ fail-open: {success: true, remaining: limit-1}  ← D-01
```

### Recommended Project Structure
```
src/
├── lib/
│   ├── redis.ts          # NEW — ioredis singleton (globalThis, throw-early REDIS_URL) + limiter Lua
│   ├── rate-limit.ts     # REWRITTEN — same exported contract, Redis-backed, fail-open
│   ├── db-pool.ts        # NEW — neutral pg.Pool (§25.2 options, per-process budget via env)
│   └── prisma.ts         # AMENDED — wraps db-pool's Pool with PrismaPg (pattern unchanged)
├── db/
│   ├── schema.ts         # NEW — all ~10 tables, DDL-precise per audit §11 + live pg_dump (D-07)
│   └── index.ts          # NEW — drizzle({ client: pool-from-db-pool }) export (D-05, unconsumed by routes)
drizzle/                  # NEW — out dir: 0000_baseline/, 0001_worker_prereqs/, meta/_journal.json
scripts/
│   ├── anonymize-snapshot.ts   # NEW — deterministic masking (D-10)
│   └── stamp-baseline.ts       # NEW — journal stamping for rehearsal + one-time prod (Pattern 4)
tests/
├── integration/
│   └── rate-limit.test.ts      # NEW — D-20 limiter suite (docker Redis 6390)
├── setup/
│   └── global-setup.ts         # AMENDED — prisma db push → drizzle-kit migrate (D-14)
.snapshots/                     # NEW, gitignored — prod-YYYYMMDD.dump (D-11)
drizzle.config.ts               # NEW — dialect, schema path, out, dbCredentials from env
```

### Pattern 1: ioredis singleton with fail-open profile (D-21, D-03)
**What:** Prisma-style module-scope singleton with startup validation, tuned so a dead Redis costs milliseconds.
**When to use:** `src/lib/redis.ts` this phase; the shape is also the Phase 4 template (minus the fail-fast options on worker connections).
**Example:**
```typescript
// Source: pattern from src/lib/prisma.ts + src/redux/api/baseApi.ts (repo conventions);
// option semantics verified against ioredis v6 lib/redis/RedisOptions.ts and README.
import Redis from "ioredis";

const globalForRedis = global as unknown as { redis?: Redis };

const connectionString = process.env.REDIS_URL;
if (!connectionString) {
  // Startup validation: throw at module load (baseApi.ts convention, D-21)
  throw new Error("Missing REDIS_URL environment variable");
}

export const redis =
  globalForRedis.redis ||
  new Redis(connectionString, {
    commandTimeout: 200,        // hard wall: any command rejects in ≤200ms — the fail-open bound
    maxRetriesPerRequest: 1,    // default 20 would stall requests through long reconnect backoff
    connectTimeout: 500,        // default 10000 is 10x the D-03 budget
    // retryStrategy: default exponential (50ms..5s + jitter) is acceptable WITH the two caps above;
    // the client keeps background-reconnecting while requests fail open fast.
  });

// REQUIRED: ioredis emits 'error' on connection loss; an unhandled 'error'
// event throws and can crash the process. Fail-open needs this no-op logger.
redis.on("error", (err) => {
  console.error("[redis] connection error (limiter will fail-open):", err.message);
});

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
```
**Verified semantics [VERIFIED: ioredis source + README]:** `commandTimeout` has no default (disabled) and throws `"Command timed out"`; `connectTimeout` defaults to 10000; `maxRetriesPerRequest` defaults to 20 (null = wait forever — required later for BullMQ workers, wrong here); `enableOfflineQueue` defaults true (commands issued while disconnected queue, then reject after the retry cap or time out via `commandTimeout`); `lazyConnect` defaults false.

### Pattern 2: atomic fixed-window limiter via one Lua script (D-04, RDS-02)
**What:** INCR + EXPIRE-with-NX in a single Lua call — the Phase 01 IN-01/OBS-04 pin. Separate `INCR` then `EXPIRE` calls can strand a TTL-less counter and permanently limit a user.
**When to use:** the rewritten `rateLimit(identifier, { limit, windowMs })`.
**Example:**
```typescript
// Source: ioredis README (defineCommand) — verified API; window math mirrors src/lib/rate-limit.ts.
const WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
`;
redis.defineCommand("rlIncr", { numberOfKeys: 1, lua: WINDOW_LUA });

// Key naming (redis-core skill): lowercase, colon-separated, short.
// rl:{bucket}:{identifier}  e.g.  rl:monitors:203.0.113.77  /  rl:register:198.51.100.9
export async function rateLimit(identifier: string, options: RateLimitOptions) {
  const key = `rl:${identifier}`; // identifiers already carry the "monitors_"/"register_" bucket
  const windowSeconds = Math.ceil(options.windowMs / 1000);
  try {
    const count = await redis.rlIncr(key, windowSeconds);
    return { success: count <= options.limit, remaining: Math.max(0, options.limit - count) };
  } catch (err) {
    // D-01/D-02: fail-open, fast, with the greppable marker. Never rethrow.
    console.error("[redis-limiter] DEGRADED fail-open:", (err as Error).message);
    return { success: true, remaining: options.limit - 1 };
  }
}
```
Notes: `EXPIRE` fires only when `INCR` returns 1 (first hit of a window — equivalent to EXPIRE NX semantics for this counter shape); the whole script is atomic (single command execution). Call sites keep the exact identifiers `monitors_${ip}` / `register_${ip}` (D-04 — the underscore becomes part of the key; harmless, preserves parity). `defineCommand` handles EVALSHA caching automatically.

### Pattern 3: the empty-diff gate (D-13, DRZ-01/DRZ-03)
**What:** After `drizzle-kit migrate` prepares the test database, introspect it with `drizzle-kit pull` into a throwaway folder and diff against the committed `src/db/schema.ts`; non-empty normalized diff fails `pnpm verify`.
**When to use:** as a verify-chain step (and conceptually at every schema change).
**Mechanics [CITED: orm.drizzle.team/docs/drizzle-kit-pull, drizzle-kit-generate]:**
- `pull` reads `dialect`, `dbCredentials`, `out`, `tablesFilter` (default `"*"`), `schemaFilter` (default `["*"]`), `introspect-casing` (`preserve` — use it; keys mirror column names).
- **Set `schemaFilter: ["public"]` in the gate config.** The default `["*"]` introspects every non-system schema — including the `drizzle` bookkeeping schema the runner itself creates — polluting the pulled `schema.ts` with `__drizzle_migrations` and guaranteeing a false-positive diff (Pitfall 4).
- A second config file (e.g. `drizzle.gate.config.ts` with `out: ".tmp-gate"`) pointed at the same test DB keeps the gate's output out of the committed tree; delete the folder after diffing.
- Diff robustness: pull output is canonically formatted, but hand-transcribed `src/db/schema.ts` (D-07) may differ cosmetically (column ordering follows DB ordinal position — stable; property order/formatting may not be). Options in order of preference: (1) make the committed schema byte-match a normalized pull output at baseline time (generate the file from pull, then hand-finish per §11 — subsequent gates diff pull-vs-pull); (2) structural diff (parse both as TS via the same AST loader drizzle-kit uses). Recommend (1) — it is what D-07's "transcribed DDL-precise against live pg_dump" converges to anyway.
- Complementary signal: `drizzle-kit generate` on an unchanged schema prints `"No schema changes, nothing to migrate"` and creates no folder [CITED: community-verified + docs model] — cheap canary for schema-vs-snapshot drift (the inverse direction of the pull gate).

### Pattern 4: journal-stamped baseline + rehearsal pipeline (RESEARCH FLAG a — the load-bearing answer)
**What:** Deterministic baselining of the committed migration set against an existing database.
**Verified internals [VERIFIED: drizzle-orm@0.45.2 source — `migrator.js`, `pg-core/dialect.js`]:**
- Journal: `<out>/meta/_journal.json`, entries `{ idx, version, when, tag, breakpoints }`; the SQL file is `<out>/<tag>.sql`.
- Per-migration `hash` = `crypto.createHash("sha256").update(sqlFileContent).digest("hex")`.
- `folderMillis` = journal `when` (epoch ms).
- Bookkeeping table (created by the runner): `CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`.
- Selection: reads the newest row (`order by created_at desc limit 1`) and applies each journal migration where `folderMillis > that row's created_at` — **timestamps order history; hashes identify**.
- **All pending migrations run inside ONE transaction**, and the bookkeeping insert joins that transaction.

**Why `pull --init` is not the mechanism here:** it does mark "the pulled schema as an applied migration in your database" [CITED: orm.drizzle.team/docs/drizzle-kit-pull] — but it *generates* its own journal tags/timestamps at pull time, so repeated rehearsals produce different artifacts (breaks D-12 repeatability), it writes into `out` rather than the committed tree, and it cannot include the audit §11 prerequisite DDL that production does not yet have.

**The deterministic hand-stamp (recommended):**
```typescript
// scripts/stamp-baseline.ts — mirrors the migrator's own computation exactly.
// Community-documented technique (GH discussion #1604, SO 78576278); internals verified from source.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Client } from "pg";

const MIGRATIONS_DIR = "drizzle";
const journal = JSON.parse(readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8"));

const client = new Client({ connectionString: process.env.DATABASE_URL }); // DIRECT string, one-shot
await client.connect();
await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);

for (const entry of journal.entries) {
  const sql = readFileSync(`${MIGRATIONS_DIR}/${entry.tag}.sql`, "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  // idempotent: skip if this hash is already recorded
  const seen = await client.query(
    "SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1", [hash]);
  if (seen.rowCount === 0) {
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [hash, entry.when]);
  }
}
await client.end();
```
**Sequencing consequence (must appear in the plan):** the baseline migration (`0000_…`) contains prod's existing DDL or is intentionally empty-but-recorded (see below); the worker prerequisites are `0001_…` authored via `drizzle-kit generate --custom`. The stamp records `0000` (and only `0000`) as applied on (a) the rehearsal container after `pg_restore` and (b) production, one time, at the first Phase-3 deploy. Then `drizzle-kit migrate` applies `0001+` everywhere.

**Two viable baseline shapes — planner picks one:**
1. **Empty baseline (recommended):** `0000_baseline.sql` contains a comment (e.g. `-- baseline: production schema as of <date>, see docs/ARCHITECTURE-AUDIT.md §11; transcribed into src/db/schema.ts, never re-executed`). Stamped everywhere; nothing re-runs. Fresh test DBs then need the schema from somewhere — which is exactly the problem: `migrate` on an empty test DB would apply only `0001+` against no tables.
2. **Full-DDL baseline (recommended for D-14):** `0000_baseline.sql` contains the full `CREATE TABLE/INDEX` DDL transcribed from live `pg_dump --schema-only`. On fresh test containers `migrate` builds the whole schema from `0000` + `0001`; on the rehearsal snapshot and on production the stamp marks `0000` applied so it never re-executes. **This is the shape that makes the D-14 global-setup switch actually work** — the vitest DB has no other schema source once `prisma db push` is gone. Caveat: the DDL must be non-`IF NOT EXISTS` (canonical, matching what pull expects to introspect) and the stamp must be correct, or fresh test DBs and prod diverge — the empty-diff gate (Pattern 3) is precisely what proves they don't.

**Rehearsal pipeline (D-12) built on the stamp:**
```text
pnpm rehearse:migrations
1. docker run throwaway postgres:17-alpine (own port, e.g. 5460, isolated from 5453)
2. docker exec … pg_restore -U postgres -d uptime_rehearse .snapshots/prod-<date>.dump   (no local pg_restore — see Environment)
3. run scripts/anonymize-snapshot.ts (deterministic UPDATEs; bcrypt hashes and row counts untouched)
4. BEFORE metrics: per-table row counts + deterministic checksums (e.g. md5 of ordered concat of row touples — discretion item; must be stable/documented)
5. scripts/stamp-baseline.ts against the rehearsal DB        ← marks 0000 applied
6. pnpm drizzle-kit migrate (rehearsal config)               ← applies 0001+
7. AFTER metrics: row counts + checksums recomputed — MUST equal BEFORE (data untouched)
8. DDL delta inspected: additive-only assertion (no DROP/RENAME/ALTER COLUMN TYPE)
9. evidence written to file (e.g. .snapshots/rehearsal-<date>.md/json)          ← DRZ-06 proof
```

### Pattern 5: neutral pool module + shared-pool Drizzle client (D-05, D-06, DRZ-05, DAT-09)
**What:** One `pg.Pool` per process, owned by a module neither ORM owns; §25.2's pinned options live there.
**Verified binding [CITED: orm.drizzle.team/docs/get-started-postgresql]:** `drizzle({ client: pool })` is the documented way to hand Drizzle an **existing** Pool (`drizzle(url)` / `drizzle({ connection })` create their own — do not use them).
```typescript
// src/lib/db-pool.ts — transcribes audit §25.2 (node-postgres pinned options)
import { Pool } from "pg";
const globalForPool = global as unknown as { pgPool?: Pool };
export const pgPool =
  globalForPool.pgPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,                          // web budget (§25.1); Phase 4 worker creates its OWN pool (max 20)
    connectionTimeoutMillis: 10000,   // default 0 = wait forever — pinned nonzero (§25.2)
    idleTimeoutMillis: 10000,
    statement_timeout: 30000,          // web+worker pools; explicitly UNSET on the migration runner
    idle_in_transaction_session_timeout: 30000,
  });
if (process.env.NODE_ENV !== "production") globalForPool.pgPool = pgPool;
```
```typescript
// src/lib/prisma.ts (amended): const pool = pgPool; const adapter = new PrismaPg(pool); …unchanged
// src/db/index.ts:
import { drizzle } from "drizzle-orm/node-postgres";
import { pgPool } from "@/lib/db-pool";
import * as schema from "./schema";
export const db = drizzle({ client: pgPool, schema });   // ONE pool, two ORMs, no dual-write
```
**No route imports `@/db` yet** (D-05) — tests/smoke exercise it (`await db.execute(sql\`select 1\`)`) to prove the shared-pool arrangement before Phase 4 depends on it.

### Pattern 6: VPS Redis install + hardening (D-15, D-17, D-18, RDS-03)
**What:** Runbook section documenting the typed VPS steps. Verified specifics:
```text
apt install redis-server                     # Ubuntu 24.04 universe package (D-17)
# /etc/redis/redis.conf — the load-bearing lines:
#   supervised systemd        # MUST match the unit's Type=notify (Ubuntu ships this; changing either
#                             # alone causes restart loops until the start limit trips) [CITED: serverfault 893066,
#                             # redis-debian#2, redis#8443]
#   bind 127.0.0.1            # loopback only (D-18)
#   protected-mode yes
#   requirepass <openssl rand -hex 32>       # REDIS_URL = redis://:pass@127.0.0.1:6379
#   appendonly yes            # AOF on; Redis 7+ multi-part AOF lands under appenddirname [CITED: redis.io persistence]
#   appendfsync everysec      # ≤1 second of writes lost on disaster; the suggested default policy
#   maxmemory-policy noeviction  # writes error at the limit, reads keep working — correct for
#                             # correctness-relevant keys (BullMQ state); BullMQ docs recommend it explicitly
systemctl restart redis-server              # persistence config needs a restart, not a reload
systemctl enable redis-server               # boot survival = "supervised restart" (RDS-03)
```
**Memory alert (D-16):** VPS cron checks `redis-cli -a <pass> INFO memory` (`used_memory` vs the threshold — the `used_memory` / `maxmemory` metric the redis-observability skill flags) and curls the dedicated healthchecks.io check at ≥70%. User provisions the check (manual step). TLS is unnecessary on loopback (D-18 model: any compromised local process already has better attacks; documented rationale in the runbook).
**No ACL user** (D-18) — Phase 4's BullMQ needs broad keyspace access anyway; `requirepass` + loopback is the chosen layering (redis-security skill: auth + network restriction together).

### Anti-Patterns to Avoid
- **Separate INCR and EXPIRE calls** — strands TTL-less counters, permanently limiting users (IN-01). One Lua script, always.
- **In-memory fallback when Redis is down** — re-imports the process-local state this migration deletes; D-01 forbids it explicitly.
- **`maxRetriesPerRequest: null` on the limiter connection** — that is the BullMQ *worker* setting; on the web limiter it means every request hangs until Redis returns. Opposite settings for opposite purposes (Pitfall 5).
- **A single migration file mixing `0000` stamp semantics with `0001` DDL** — keep baseline and prerequisites as separate journal entries so the stamp boundary is exact.
- **Editing `prisma/schema.prisma` "just for one column"** — D-09: frozen. A stale `prisma db push` would DROP the new columns (that is why D-13/D-14 exist).
- **Running migrations from Next.js boot / two runners concurrently** — M-1 forbids; single typed command in the runbook.
- **Trusting `pull --init` for the rehearsal** — non-deterministic artifacts break repeatability (see Pattern 4).
- **Renaming/typing the `drizzle` bookkeeping schema or table** — the runner's defaults (`drizzle.__drizzle_migrations`) are what `drizzle-kit migrate` reads back; custom `migrationsSchema`/`migrationsTable` config exists but adds a divergence surface for zero benefit here.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic check-and-set with TTL | Multi-command INCR/EXPIRE/GET round-trips | One Lua script via `defineCommand` | Server-side atomicity; ioredis handles EVALSHA caching |
| Migration history tracking | Custom `applied_migrations` table | `drizzle.__drizzle_migrations` (runner-managed) | The runner creates/reads it in the same transaction as the DDL; a parallel table desyncs silently |
| Schema diffing | Regex/string-diff of `CREATE TABLE` text | `drizzle-kit pull` + `generate` (snapshot JSON diffs) | drizzle-kit diffs structured snapshots; text diffs break on formatting/ordering |
| Redis client retry/backoff logic | Hand-rolled reconnect loops | ioredis `retryStrategy` + `commandTimeout` + `maxRetriesPerRequest` | Battle-tested 20M-downloads/wk client; the options compose into the D-03 profile directly |
| Postgres dump/restore orchestration | Custom archive format handling | `pg_dump -Fc` / `pg_restore` via docker exec | Custom format is compressed, selective, and parallel-restorable; container binaries avoid local installs |
| Data anonymization framework | Extension install + policy DSL | Deterministic id-derived SQL UPDATEs (repo script) | Zero new deps; row counts preserved by construction; bcrypt hashes untouched (D-10) |

**Key insight:** every hand-roll temptation in this phase replaces something transactional (Lua atomicity, journal+DDL-in-one-transaction, snapshot diffing). Hand-rolled versions of those fail exactly during crashes and restarts — the moments this phase exists to harden.

## Runtime State Inventory

> This phase is a migration of schema *ownership* and limiter *backing store* — inventory included per the rename/refactor/migration trigger.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Production Neon Postgres: schema exists as `prisma db push --accept-data-loss` left it; **no `drizzle.__drizzle_migrations` table yet**; no `_prisma_migrations` table expected (db push never wrote one — verify in the pg_dump) [ASSUMED — see A4] | Code edit (migrations add columns/tables additively) + one-time **bookkeeping insert** (baseline stamp) at first deploy. No data migration of existing rows except the `next_check_at` backfill UPDATE inside migration 0001 |
| Stored data | Anonymized rehearsal snapshots (`.snapshots/prod-*.dump`, gitignored) + rehearsal evidence files | Created by the new scripts; retention/hygiene is a discretion item (D-11) |
| Live service config | VPS: Redis does not exist yet → new `/etc/redis/redis.conf` (requirepass, AOF, noeviction, bind); healthchecks.io: new dedicated memory check (user-provisioned) | Runbook-documented manual steps (D-15/D-16/D-18). Redis config lives on the VPS only, never in git — the runbook lines are the source of truth |
| Live service config | PM2 `uptime-tracker` unchanged this phase; `ecosystem.config.js` untouched (worker app is Phase 4) | None |
| OS-registered state | VPS systemd `redis-server.service` (apt-registered, enabled); VPS cron entry for the 70% memory check | Registered at deploy per runbook; `systemctl enable` makes restarts supervised (RDS-03) |
| Secrets/env vars | `REDIS_URL` (new; carries requirepass — code reads it, value lives in VPS `.env`); `DATABASE_URL` unchanged; test stack `TEST_DATABASE_URL` (5453) + new test Redis URL (6390) wired through vitest config | `.env.example` additions (discretion item); throw-early validation in `src/lib/redis.ts` |
| Build artifacts | `src/generated/prisma` still ships in the tarball (Prisma serves reads until Phase 7; `prisma generate` stays in `build`); **new**: `drizzle/` migrations folder + `drizzle.config.ts` must ship in the tarball (D-08) and drizzle-kit must be in `--prod` install (it is) | Verify the tarball include list still packs `drizzle/` (it packs repo root minus excludes — rides along by construction, same as `.next/`) |
| Build artifacts | Vitest test databases (throwaway containers) — recreated per run; after D-14 they are built by `drizzle-kit migrate` instead of `prisma db push` | None beyond the global-setup edit |

**Canonical question — after every repo file is updated, what still has the old state?** Production Postgres (schema + no journal table — handled by stamp+migrate at deploy); the VPS (no Redis — installed at deploy; `.env` needs `REDIS_URL` added manually); healthchecks.io (no memory check — user provisions). In-memory limiter windows die with the old process at deploy — accepted (windows reset once; D-04 parity is about steady-state semantics, and criterion 1 is about *future* restarts surviving).

## Common Pitfalls

### Pitfall 1: `CREATE INDEX CONCURRENTLY` inside the drizzle runner (RESEARCH FLAG b)
**What goes wrong:** `ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block` — the runner wraps ALL pending migrations in a single `session.transaction`.
**Why it happens:** Verified 0.45.2 behavior (Pattern 4); statement-breakpoint splitting does not create autocommit. Upstream issue #860 open since 2023.
**How to avoid:** Default to plain `CREATE INDEX` (D-19) — the rehearsal measures build time on real data. If an index proves slow, run it outside the runner (a typed psql step in the runbook, before `drizzle-kit migrate`) and keep the migration file's copy commented with a pointer, or split it into a post-runner step; document whichever path in the migration header.
**Warning signs:** rehearsal index build > ~1s on real data; any `CONCURRENTLY` token in a migration `.sql` file (grep gate candidate).

### Pitfall 2: baseline re-execution against the restored snapshot
**What goes wrong:** running `drizzle-kit migrate` on the rehearsal DB (a restored prod snapshot) without stamping first → the runner applies `0000` full-DDL against tables that already exist → duplicate-table errors, or worse, `IF NOT EXISTS`-softened DDL silently skipping drift.
**Why it happens:** the runner's selection is `folderMillis > last created_at`; a fresh restore has no `__drizzle_migrations` rows, so everything is "new".
**How to avoid:** the stamp step is mandatory in BOTH the rehearsal (after restore, before migrate) and the first production deploy. The stamp script is idempotent (hash-checked).
**Warning signs:** rehearsal failing with "relation already exists"; `__drizzle_migrations` empty after restore.

### Pitfall 3: existing 429 characterization tests break — `vi.resetModules()` no longer resets limiter state
**What goes wrong:** `tests/api/monitors.handler.test.ts` and `tests/api/auth-shallow.handler.test.ts` rely on `vi.resetModules()` giving each case a fresh in-memory Map. With Redis backing, limiter state **survives module resets** — the "limiter fires before session guard" 429 case exhausts a window that then bleeds into subsequent cases.
**How to avoid:** the handler-harness tests need one of: (a) `FLUSHDB` (or targeted `DEL rl:*` / `SCAN`-based delete — never `KEYS`) on the test Redis in `beforeEach` via a separate admin client; (b) per-case unique IPs; (c) mocking `@/lib/redis`. Prefer (a)+(b) combined — keep the limiter REAL in these characterization tests so parity is pinned. The dedicated D-20 suite additionally needs the 6390 Redis wired via env (`REDIS_URL` in vitest config env, mirroring the `DATABASE_URL` pattern in `vitest.config.ts`).
**Warning signs:** previously-green 429 tests failing in sequence-dependent ways; tests passing solo but failing in file order.

### Pitfall 4: `schemaFilter` default pollutes the pull gate
**What goes wrong:** the empty-diff gate's `drizzle-kit pull` uses default `schemaFilter: ["*"]` → introspects the `drizzle` bookkeeping schema (created by migrate on the same DB) → pulled `schema.ts` grows a `__drizzle_migrations` table → permanent false-positive diff.
**How to avoid:** `schemaFilter: ["public"]` in the gate config; also consider `tablesFilter` if the snapshot contains `_prisma_migrations` or other noise tables (verify in the pg_dump first).
**Warning signs:** gate diff showing exactly one unexpected table.

### Pitfall 5: `maxRetriesPerRequest` values are per-purpose, and mixing them breaks BullMQ later
**What goes wrong:** "tuning" the shared singleton to `null` (worker setting) makes web requests hang on Redis outages; conversely reusing the limiter's `1`-configured instance for a Phase 4 worker makes BullMQ throw on construction ("BullMQ will throw an exception if this setting is not set to null when it is passed into worker instances").
**How to avoid:** one connection per purpose, settings per connection (this phase: limiter = fail-fast; Phase 4: worker/blocking = `null`). Never `keyPrefix` on anything BullMQ will touch (BullMQ prefixes keys itself; documented incompatible).
**Warning signs:** any config spread/shared across future worker and web connections.

### Pitfall 6: unhandled `'error'` events crash the web process
**What goes wrong:** ioredis emits `'error'` on connection failure; with no listener, Node throws — the "fail-open" limiter takes the app down instead.
**How to avoid:** `redis.on("error", …)` in the singleton (Pattern 1). The D-20 fail-open test against a dead port only passes with this in place.
**Warning signs:** PM2 restart loops correlated with Redis stops.

### Pitfall 7: drizzle-orm v1 beta sneaks in
**What goes wrong:** installing `drizzle-orm@next` or accepting a beta → migration folder structure changed (journal.json removed, per-migration folders) → every verified mechanic in this research stops applying.
**How to avoid:** pin `^0.45.2` / `^0.31.10`; review lockfile drift in verify.
**Warning signs:** `meta/_journal.json` absent after generate; folder layout differing from Pattern 4's description.

### Pitfall 8: Prisma client meets grown columns (transition safety)
**What goes wrong:** (hypothesized failure) Prisma breaking when migrations add columns. In practice Prisma generates SELECTs enumerating only mapped columns, so additive columns are invisible to it [ASSUMED — A2; this is the audit M-1 transition rule's premise]. The actual risk is the inverse: anyone running `prisma db push` against the grown DB with the frozen (stale) `schema.prisma` triggers destructive diff prompts — or with `--accept-data-loss`, real drops.
**How to avoid:** D-09 freeze + D-13/D-14 (db push excised from all machinery). Add a grep gate in verify: no `db push` / `--accept-data-loss` anywhere in repo scripts (DRZ-02's "no longer exists anywhere").
**Warning signs:** any `prisma db push` reference surviving in scripts, docs, or CI YAML.

### Pitfall 9: verify budget blowout
**What goes wrong:** the empty-diff gate + migrated global-setup add minutes to `pnpm verify` (Phase 2 budget: ≤5 min warm).
**How to avoid:** the gate reuses the already-up test stack container (no second boot); pull+diff is seconds; `drizzle-kit migrate` on the test DB replaces `prisma db push` (comparable cost). Keep the rehearsal OUT of verify (it needs a snapshot — user-gated, run explicitly).
**Warning signs:** verify wall time crossing ~4 min in Phase 3 testing.

### Pitfall 10: Ubuntu systemd/redis supervision mismatch
**What goes wrong:** editing `supervised` or the unit Type independently → Redis restart-loops until systemd's start limit fails the unit.
**How to avoid:** keep Ubuntu's shipped pair (`Type=notify` unit ↔ `supervised systemd` conf); don't override the unit file.
**Warning signs:** `systemctl status redis-server` cycling activating→failed.

## Code Examples

### Limiter call sites (unchanged contracts — D-04)
```typescript
// src/app/api/monitors/route.ts:39 (today — stays textually identical after the swap)
const { success, remaining } = rateLimit(`monitors_${ip}`, { limit: 20, windowMs: 60000 });
// src/app/api/auth/register/route.ts:12
const { success, remaining } = rateLimit(`register_${ip}`, { limit: 5, windowMs: 3600000 });
```
Only the import semantics change: `rateLimit` becomes async → the two call sites add `await` (and the function returns the same `{ success, remaining }` shape). Source: repo, verified 2026-09-12.

### drizzle.config.ts (shape — specifics are a discretion item)
```typescript
// Source: orm.drizzle.team/docs/drizzle-kit-generate + drizzle-kit-pull config tables
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL! }, // test runs resolve TEST_DATABASE_URL first (vitest.config.ts)
  breakpoints: true, // default — emits '--> statement-breakpoint' between statements
});
```

### Worker-prerequisite migration authoring (D-07/DRZ-04)
```bash
pnpm drizzle-kit generate --custom --name=worker-prereqs
# → drizzle/<ts>_worker-prereqs/migration.sql — hand-fill with audit §11 DDL:
#   ALTER TABLE monitors ADD COLUMN next_check_at timestamptz NULL;
#   UPDATE monitors SET next_check_at = COALESCE(last_checked, created_at) + (interval * interval '1 minute') WHERE next_check_at IS NULL;
#   CREATE INDEX idx_monitors_due ON monitors (is_active, next_check_at) WHERE is_active;
#   ALTER TABLE monitors ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
#   CREATE TABLE write_guards (…); CREATE TABLE outbox (…); CREATE INDEX idx_outbox_unsent …;
#   CREATE UNIQUE INDEX incidents_one_ongoing ON incidents (monitor_id) WHERE status = 'ONGOING';
#   ALTER TABLE pings ADD COLUMN error_class text NULL; ALTER TABLE pings ADD COLUMN status_code integer NULL;
#   + pinned gen_random_uuid()::text defaults for text PKs (§11 ID-generation section)
```
Source: `--custom` behavior [CITED: orm.drizzle.team/docs/drizzle-kit-generate]; DDL text: audit §11 (canonical). The `incidents_one_ongoing` predicate must match §16.1's `ON CONFLICT (monitor_id) WHERE status = 'ONGOING'` target exactly (audit §11 caveat) — and since the Phase 4 writer does not exist yet, the "never create concurrently with the ON CONFLICT writer active" caveat is satisfied by construction (plain CREATE INDEX, writer arrives Phase 4).

### Anonymization sketch (D-10)
```sql
-- Deterministic, id-derived: same input → same output everywhere (FK-safe), row counts untouched.
UPDATE users SET
  email    = 'user_' || substr(md5(id::text), 1, 12) || '@anon.test',
  name     = 'anon-' || substr(md5(id::text), 1, 8)
  -- password (bcrypt) deliberately untouched — Phase 7 canary-login rehearsal needs real hashes
  -- telegram_chat_id, session/token tables: same md5-derived pattern
;
```
Source: standard dump→restore→mask pattern [CITED: dba.stackexchange 168023, postgresql-anonymizer docs]; script form is repo work (TypeScript, run via the rehearsal container).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `drizzle-kit pull` + manual journal fiddling only | `pull --init` flag (official baseline mark) | recent kit versions | Official path exists but is non-deterministic across runs — not suitable for D-12 repeatability; hand-stamp remains the right tool here |
| drizzle-orm 0.x migrations folder (`meta/_journal.json` + flat `.sql` files) | v1.0.0-beta removes journal.json, groups per-migration folders | v1 beta (2026) | Stay on 0.45.x stable; all mechanics in this research assume it |
| In-memory fixed-window limiter (`Map`) | Redis atomic Lua (INCR+EXPIRE NX) | this phase | Windows survive restarts; distributed across processes; fail-open contract |
| `prisma db push --accept-data-loss` as schema authority | versioned drizzle-kit migrations, single runner, empty-diff gate | this phase | Forward-only additive discipline; drift fails closed instead of silently wiping |

**Deprecated/outdated:**
- `--blank` generate flag: not documented on the current generate page — use `--custom` (verified present).
- Treating `maxRetriesPerRequest` as a global tuning knob: BullMQ's documented per-role requirements (null for workers, low/default for producers) make it a per-connection contract, not a preference.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Ubuntu 24.04 universe `redis-server` package ships Redis 7.2.x with `Type=notify` unit + `supervised systemd` default conf | Pattern 6, Pitfall 10 | Version only affects feature set (multi-part AOF is 7.0+; all pinned directives exist since ≤6). Runbook verify step should print `redis-server --version` at install. LOW risk |
| A2 | Prisma client is unaffected by additive columns (it enumerates only mapped columns in generated SQL) | Pitfall 8, DRZ-05 | If wrong, existing routes error on unknown columns — rehearsal + existing characterization suite would catch it immediately. This is also the audit M-1 transition premise. LOW-MEDIUM risk |
| A3 | Neon `max_connections` ≈ 104 at 0.25 CU (audit A4) — operator verifies tier | DAT-09 | Budget math only (31/104 headroom); no code impact. MEDIUM (documented as operator-verify in §25.4) |
| A4 | Production has no `_prisma_migrations` table (schema was `db push`'d, never `migrate deploy`'d) | Runtime State, Pattern 3 | If present, the baseline pull/gate needs a `tablesFilter` exclusion — one-line config. LOW risk, verify in the first pg_dump |
| A5 | `drizzle-kit pull` output is deterministic enough to text-diff after the committed schema is normalized to pull formatting at baseline | Pattern 3 | If formatting varies run-to-run, switch the gate to a structural/AST diff — an implementation detail of one task, flagged for the planner. MEDIUM risk (spike early) |
| A6 | Prod time columns may be `timestamp` not `timestamptz` (audit M-6 drift marker) | DRZ-01/DRZ-04 | §11 already mandates verify-against-pg_dump before transcription; new columns are `timestamptz` outright. LOW risk (procedure handles it) |
| A7 | Current VPS `DATABASE_URL` points at Neon's POOLED endpoint (web-process §25.1 requirement) | DAT-09, Pattern 5 | If it is direct, web sits outside §25.1's intent — a runbook/env correction, not code (the pool module reads env either way; worker gets its own direct string in Phase 4). MEDIUM risk — runbook verify line recommended |
| A8 | `maxmemory` unset (0) on a fresh Ubuntu Redis; `noeviction` is the shipped policy default | Pattern 6 | None functionally — the runbook pins `maxmemory-policy noeviction` explicitly regardless (do not rely on defaults). LOW risk |
| A9 | ioredis 6.0.0's documented option semantics match the verified main-branch source (README/RedisOptions.ts) | Patterns 1-2 | The fetch was from `main`; 6.0.0 is the latest release and no breaking option rename is indicated. LOW-MEDIUM risk; the D-20 tests verify the profile empirically |

## Open Questions (RESOLVED)

1. **Baseline migration shape (empty vs full-DDL)** — (RESOLVED → 03-03): full-DDL baseline (required for the D-14 global-setup switch, Pattern 4 analysis). The schema is generated by `drizzle-kit pull` against the restored LIVE snapshot and hand-finished against `pg_dump --schema-only` + audit §11 (03-03 Task 2), then committed as `0000_baseline` authored via `drizzle-kit generate` and reviewed line-by-line against the schema-only dump (03-03 Task 3) — the pull-generated-then-reviewed route, per the original recommendation.
2. **Gate diff normalization** (A5) — (RESOLVED → 03-07): textual normalization first (strip comments, trim trailing whitespace, collapse blank lines, both sides identically — the committed schema was pull-generated at baseline so post-normalization equality is the steady state); the sanctioned 15-minute structural spike is taken ONLY if normalization proves unstable, with the choice recorded in 03-07's SUMMARY (03-07 Task 1).
3. **Prod timestamp drift** (A6/A4) — (RESOLVED → 03-03): the fresh production dump is taken in 03-03 Task 1 BEFORE schema transcription begins (03-03 Task 2); the A4 (`_prisma_migrations` presence) and A6 (timestamp vs timestamptz) facts are read from the real dump and recorded in 03-03's SUMMARY for 03-04's backfill types and 03-07's gate config.
4. **`next_check_at` backfill inside migration 0001** — (RESOLVED → 03-05): the D-12 checksum spec carries an explicit sanctioned-write carve-out — the `monitors` table's backfilled columns are excluded from the digest comparison (structure-only compare for `monitors`), implemented in the rehearsal script's documented checksum helper (03-05 Task 2) and labeled in the evidence file.
5. **Rehearsal container port** — (RESOLVED → 03-03): port 5460 is probed (docker ps + TCP check) and the next free port chosen if a sibling stack holds it, recorded in 03-03's SUMMARY and reused consistently by 03-05 (03-03 Task 1 executor pre-work).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | runtime + toolchain | ✓ | v24.15.0 (engines `>=22 <25`) | — |
| pnpm | package manager | ✓ | 10.34.5 (matches `packageManager` pin) | — |
| Docker + Compose | test stack, rehearsal container | ✓ | Docker 29.7.2 / Compose v5.5.0 | — |
| `pg_dump` / `pg_restore` (local PATH) | snapshot handling, rehearsal | ✗ NOT on PATH | — | Run dump/restore via `docker exec` against the postgres container binaries (recommended); or document local Postgres client install as a manual prerequisite |
| `redis-cli` (local host) | ad-hoc inspection only | ✗ | — | Not required: tests use ioredis over 6390; the memory-alert cron runs on the VPS where redis-cli exists |
| Test Redis (docker, 6390) | D-20 limiter suite | ✓ (on demand) | redis:8-alpine in docker-compose.test.yml | `docker compose -f docker-compose.test.yml up -d --wait` |
| Test Postgres (docker, 5453) | global-setup migrate + gate | ✓ (on demand) | postgres:17-alpine | same |
| Neon production access | pg_dump (user-only), first prod migrate | ✗ (operator-gated by design) | — | All prod steps are runbook-documented manual steps (manual-deploy posture D-03/02-CONTEXT) |
| VPS (Ubuntu 24.04, PM2) | Redis install, deploy | ✗ (operator-gated) | — | Manual steps per runbook |

**Missing dependencies with no fallback:** none blocking — local `pg_dump`/`pg_restore` absence has the docker-exec fallback, and prod access is operator-gated by design, not a gap.

**Missing dependencies with fallback:** `pg_dump`/`pg_restore` → docker exec into the rehearsal/test container (keeps the dev machine install-free and version-matched to the container's Postgres major).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.11 (`vitest.config.ts` — `fileParallelism: false`, alias `@` → `./src`) + Playwright 1.63.0 (`.spec.ts` only) |
| Config file | `vitest.config.ts` (repo root), `tests/setup/global-setup.ts` |
| Quick run command | `pnpm vitest run tests/integration/rate-limit.test.ts` |
| Full suite command | `pnpm test` (vitest) · gate-level: `pnpm verify` (compose up → lint → typecheck → test → build → e2e) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RDS-02 | Window survives client re-creation (restart simulation) | integration | `pnpm vitest run tests/integration/rate-limit.test.ts -t "survives"` | ❌ Wave 0 |
| RDS-02 | Limit enforced; window expiry resets counter | integration | `pnpm vitest run tests/integration/rate-limit.test.ts -t "window"` | ❌ Wave 0 |
| RDS-02/D-01 | Fail-open on unreachable Redis (dead port), fast, with log marker | integration | `pnpm vitest run tests/integration/rate-limit.test.ts -t "fail-open"` | ❌ Wave 0 |
| RDS-02/D-04 | Lua atomicity under concurrent hammering; no TTL-less keys | integration | `pnpm vitest run tests/integration/rate-limit.test.ts -t "atomicity"` | ❌ Wave 0 |
| RDS-02/D-04 | Parity: 20/min + 5/hour parameters, `{success, remaining}` shape, 429 before session guard | integration (existing characterization, adapted per Pitfall 3) | `pnpm vitest run tests/api/monitors.handler.test.ts tests/api/auth-shallow.handler.test.ts` | ✅ (needs Redis-state reset adaptation) |
| DRZ-05/D-05 | Drizzle client executes through the shared pool | integration | `pnpm vitest run tests/integration/db-client.test.ts` | ❌ Wave 0 |
| DAT-09/D-06 | Pool options pinned (max 10, timeouts) | unit | `pnpm vitest run tests/integration/db-pool.test.ts` | ❌ Wave 0 |
| DRZ-02 | `db push` / `--accept-data-loss` excised | gate (grep) | `rg -n "db push\|accept-data-loss" scripts/ package.json .github/ tests/` → expect no hits | ❌ Wave 0 (verify-chain step) |
| DRZ-01/DRZ-03 | Empty diff: migrate → pull → diff vs committed schema | gate | part of `pnpm verify` (Pattern 3) | ❌ Wave 0 (verify-chain step) |
| DRZ-04 | Additive-only DDL in migrations | gate (grep on `.sql` files for DROP/RENAME/ALTER COLUMN) + rehearsal assertion | part of verify + rehearsal | ❌ Wave 0 |
| DRZ-06 | Rehearsal row-counts + checksums match; evidence file produced | manual-gated script | `pnpm rehearse:migrations` (needs user-provided snapshot — manual-only by design: requires prod data) | ❌ Wave 0 |
| RDS-03 | VPS hardening applied | manual-only | runbook checklist (systemd enabled, AOF/noeviction lines present, bind/requirepass, memory cron fires) | n/a — documented verification steps in the runbook amendment |
| D-14 | Test DB built by `drizzle-kit migrate` | implicit | every `pnpm test` run exercises the real migration files | ❌ Wave 0 (global-setup edit) |

### Sampling Rate
- **Per task commit:** `pnpm vitest run tests/integration/rate-limit.test.ts` (+ affected handler tests)
- **Per wave merge:** `pnpm test`
- **Phase gate:** `pnpm verify` green (now including the empty-diff gate) BEFORE the prod deploy; rehearsal evidence file exists BEFORE the prod migrate; full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/integration/rate-limit.test.ts` — covers RDS-02/D-20 (all five D-20 cases; docker Redis 6390 via `REDIS_URL` env wired in `vitest.config.ts` mirroring the `DATABASE_URL` pattern)
- [ ] `tests/integration/db-pool.test.ts` + `tests/integration/db-client.test.ts` — DAT-09/D-05
- [ ] Adaptation of `tests/api/monitors.handler.test.ts` + `tests/api/auth-shallow.handler.test.ts` for Redis-backed limiter state (Pitfall 3: FLUSHDB/unique-IP strategy — keep the limiter real)
- [ ] `tests/setup/global-setup.ts` amendment: `prisma db push` → `pnpm drizzle-kit migrate` (D-14) + rehearsal-safe guard wording update
- [ ] Verify-chain extension in `package.json` (`verify` script): empty-diff gate + db-push-absence grep, within the ≤5-min budget
- [ ] `scripts/anonymize-snapshot.ts`, `scripts/stamp-baseline.ts`, `pnpm rehearse:migrations` — DRZ-06 tooling

## Security Domain

`security_enforcement: true`, ASVS L1, block on high (config). This phase's security surface: the new Redis service, the snapshot/anonymization pipeline, and migration execution.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No auth-flow change this phase (NextAuth untouched; Better Auth is Phase 7) |
| V3 Session Management | no | JWT strategy unchanged |
| V4 Access Control | indirectly | Rate limiting is an availability control — its 429 contract is pinned by existing characterization tests and must survive the swap (parity tests above) |
| V5 Input Validation | yes (minimal) | Limiter identifier is header-derived IP fed into a Redis KEY and Lua KEYS[1] — binary-safe key material, never string-concatenated into commands (defineCommand parameterizes). No new user input surface |
| V6 Cryptography | yes (operational) | `requirepass` generated via `openssl rand -hex 32`; bcrypt hashes deliberately preserved through anonymization; snapshot dumps contain (anonymized) production data — `.snapshots/` gitignored (D-11) and retention documented |
| V14 Config | yes | Redis hardening = requirepass + bind 127.0.0.1 + protected-mode + AOF everysec + noeviction (redis-security skill's layered model: auth AND network restriction); `REDIS_URL` never logged; startup throw-early pattern surfaces misconfiguration at boot |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Redis exposed on network (classic breach vector) | Information Disclosure / Tampering | `bind 127.0.0.1` + `protected-mode yes` + `requirepass` (D-18); loopback-only means no TLS needed (documented rationale) |
| Anonymized snapshot leaking PII via git | Information Disclosure | `.snapshots/` gitignored (D-11); anonymization is deterministic and reviewed; evidence files exclude raw values |
| Password/secret in logs | Information Disclosure | Log only `err.message` categories in the redis error handler; never log `REDIS_URL` (repo rule: never log secrets) |
| Destructive schema action against prod | Tampering / Destruction | `prisma db push` excised entirely (DRZ-02 grep gate); single additive-only runner; pre-deploy `pg_dump` backup + rehearsal-first policy; forward-only rollback contract (§7) |
| Rate-limiter bypass via Redis outage | DoS-to-abuse | Accepted by design (D-01: fail-open); bounded by the 1-strike DOWN monitoring semantics being Postgres-side and the limiter being anti-abuse, not authn |
| Redis memory exhaustion on the 2 GB VPS | DoS | `noeviction` (fail loudly, never silently drop correctness keys) + 70% memory alert (D-16) + Phase 5 OBS-03 supersedes |
| Unvalidated IP header driving limiter keys | Spoofing (pre-existing) | `x-forwarded-for` trust is a pre-existing posture, unchanged this phase; key material is not command-injectable. Note for future hardening only |

## Sources

### Primary (HIGH confidence — shipped-package source & official docs read this session)
- drizzle-orm@0.45.2 shipped source via jsdelivr — `pg-core/dialect.js` (PgDialect.migrate: single `session.transaction`, `__drizzle_migrations` DDL, folderMillis selection, hash+folderMillis insert), `migrator.js` (readMigrationFiles: journal path/fields, sha256 hash, `--> statement-breakpoint` split), `node-postgres/migrator.js` (thin delegation) [VERIFIED]
- ioredis official README (github.com/redis/ioredis) + `lib/redis/RedisOptions.ts` (main) — option semantics/defaults, `defineCommand` Lua API, retryStrategy formula [VERIFIED]
- orm.drizzle.team/docs — get-started-postgresql (`drizzle({ client: pool })`), drizzle-kit-pull (workflow, config keys, `--init`), drizzle-kit-generate (snapshot diffing, `--custom`, breakpoints), migrations (generate-vs-migrate model, runtime migrator) [CITED]
- docs.bullmq.io/guide/connections — `maxRetriesPerRequest: null` worker requirement, blocking-connection duplication, keyPrefix incompatibility, `noeviction` recommendation [CITED]
- redis.io/docs/latest — persistence (appendfsync everysec semantics, multi-part AOF), eviction (policies, `noeviction` behavior, `maxmemory` default 0) [CITED]
- npm registry (`npm view`) + gsd-tools package-legitimacy — versions, dist-tags, download/age/repo signals for drizzle-orm/drizzle-kit/ioredis [VERIFIED: npm registry]

### Secondary (MEDIUM confidence)
- github.com/drizzle-team/drizzle-orm/discussions/1604 — journal-stamping community techniques (comment-out trick, scripted hash backfill, hardsync); consistent with shipped source
- github.com/drizzle-team/drizzle-orm/issues/860 (+PR #6133) — CONCURRENTLY-in-transaction limitation, still open
- Stack Overflow 78576278 — Prisma→Drizzle baselining question (fetch blocked; corroborated via search results + discussion 1604)
- serverfault 893066, redis-debian#2, redis#8443 — Ubuntu `Type=notify` ↔ `supervised systemd` coupling; redis-debian#96 — official-repo install hang on 24.04
- dba.stackexchange 168023, postgresql-anonymizer docs — dump→restore→mask pattern

### Tertiary (LOW confidence)
- "No schema changes, nothing to migrate" exact wording — community-verified (answeroverflow/Discord threads) rather than an official docs quote; behavior is consistent with the snapshot-diff model

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — three packages verified on registry + legitimacy gate + official docs
- Journal/transaction mechanics (both research flags): HIGH — read from the shipped 0.45.2 source itself, cross-checked against docs and community
- Redis hardening specifics: HIGH on directives (official docs), MEDIUM on Ubuntu package details (A1)
- Empty-diff gate normalization: MEDIUM — mechanics verified, text-diff robustness needs an implementation spike (A5)
- Test-infrastructure impact (Pitfall 3): HIGH — verified against the actual test files in-repo

**Research date:** 2026-09-12
**Valid until:** 2026-10-12 (stable tooling; re-check drizzle-orm/drizzle-kit if the v1 stable lands — see State of the Art)
