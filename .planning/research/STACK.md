# Stack Research

**Domain:** Backend modernization of a live Next.js 16 uptime-monitoring SaaS (Drizzle ORM + Better Auth + Redis/BullMQ + dedicated worker)
**Researched:** 2026-09-08
**Confidence:** HIGH overall — every version number was pulled live from the npm registry (the package of record) and every API claim below was verified against the vendor's official docs during this session. Per the confidence seam, single-provider fetches classify LOW until cross-checked; every HIGH below is cross-checked across at least two primary sources (registry peer/engine metadata ↔ official docs). Genuinely single-source items are tagged MEDIUM/LOW explicitly.

## Executive verdict

The audit's target stack is current and internally compatible in 2026-09, with **four version-reality corrections** the roadmap must absorb:

1. **BullMQ 6 (Jul 2026) removed legacy repeatable jobs.** The `repeat` option on `Queue.add`, `getRepeatableJobs()`, and `removeRepeatable()` no longer exist. All recurring work (audit §14 scheduler tick, flusher, nightly maintenance) must use the **`upsertJobScheduler()`** API. Any design doc still describing "repeatable jobs" in the BullMQ-4/5 sense is describing a removed API.
2. **Better Auth 1.7.3 hard-pins `drizzle-orm ^0.45.2`.** Drizzle version selection is not free-floating: the ORM must be 0.45.2+ (and 0.45.2 is the current latest anyway), and drizzle-kit ≥ 0.31.4.
3. **ioredis 6 and BullMQ 6 shipped together (Jul 30–31, 2026)** and are compatible (BullMQ peer: `ioredis >=5`), but BullMQ 6 made ioredis an *optional peer* — it must be installed explicitly (the current codebase has none).
4. **Nodemailer 10, pnpm 12, Vitest 5 are all ≤ 5 weeks old.** All are viable, but the safe picks for a brownfield migration are pinned deliberately (see "Stack Patterns by Variant").

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Conf |
|------------|---------|---------|-----------------|------|
| Next.js | **16.3.4** (from `^16.0.10`) | Web app + thin API routes | Latest 16.3 patch; the repo already uses the 16.x `proxy.ts` convention. Requires Node ≥ 20.9. Minor-line bump, isolated in Phase 0 (audit M9). | HIGH |
| drizzle-orm | **0.45.2** (exact) | Sole ORM after cutover | Current latest; still 0.x (stable, widely deployed). **Pinned by Better Auth 1.7.3 peer (`^0.45.2`)** — going lower breaks the auth install. `pg` driver (`drizzle-orm/node-postgres`) keeps full transaction support in the worker (review N-10). | HIGH |
| drizzle-kit | **0.31.10** (dev) | Schema authority + migration runner | Current latest; satisfies Better Auth peer (`>=0.31.4`). Gives `pull` (introspect live DDL → schema.ts — the M-3 baseline), `generate`, `migrate`, `check` (collision detection), `export`. Replaces `prisma db push --accept-data-loss` with versioned SQL (M-1). | HIGH |
| pg (node-postgres) | **8.23.0** | Shared Postgres driver (web + worker + drizzle-kit) | Already a dependency (`^8.22`); one driver across Prisma-adapter, Drizzle, and CLI avoids double client stacks. Protocol-level prepared statements work through Neon's PgBouncer 1.22+ (verified). Peer-satisfied by both drizzle-orm (`>=8`) and bullmq (`>=8`). | HIGH |
| better-auth | **1.7.3** | Auth (email+password, OAuth, sessions, admin roles) | Current stable (1.7 line ~5 months old; 1.7.3 shipped 2026-09-06). Drizzle adapter is first-class; supports the three blocking review items directly: custom bcrypt `password.hash/verify` (A-1), `cookieCache` (A-2), `modelName`/`fields` mapping onto the existing `users` table + `admin()` plugin (A-3/S-3). Peer: `next ^16`, `react ^19` — matches. | HIGH |
| bullmq | **6.3.4** | Job orchestration (scheduler, checks, writes, alerts, maintenance) | Current major (6.x since 2026-07-30). Design docs must target v6 semantics: `upsertJobScheduler`, no `repeat` option, `UnrecoverableError` instead of `Job#discard()`, `deduplicationId` available for cheap in-flight dedupe. `Queue.pause()/resume()` supports the J-5 circuit breaker. Cron parsing (cron-parser 5.x) bundled. | HIGH |
| ioredis | **6.0.0** | Redis client (rate limiting, locks, aggregation buffer, BullMQ connection) | Current major, co-released with BullMQ 6 and within its peer range (`>=5.0.0`). Requires Node ≥ 20; defaults to RESP3 (`protocol: 2` reverts). **Must be installed explicitly — BullMQ 6 no longer bundles it.** Never set ioredis `keyPrefix` with BullMQ. | HIGH |
| nodemailer | **10.0.1** | SMTP provider behind the email abstraction | Current (shipped 2026-09-04). `createTransport({host,port,auth})` + `sendMail` API unchanged since v7 (verified changelog v8→v10); v10 requires Node ≥ 20 and ships its own TypeScript types. Safe behind the `lib/email` interface. | HIGH |
| resend | **6.26.0** | Second email provider (HTTP API) | Current; validates the provider abstraction cheaply. Only `Resend(apiKey).emails.send()` is needed. | MEDIUM (registry version HIGH; SDK API surface not doc-verified this session) |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| bcryptjs | **3.0.3** | bcrypt hash/verify for Better Auth `password.hash/verify` | Keeps every existing hash verifiable (A-1). Already a dep; v3 ships its own types (`umd/index.d.ts`) — drop `@types/bcryptjs`. Pure JS: no native build on VPS/Windows. `@node-rs/bcrypt` 1.10.8 is the faster native option, only if throughput ever matters. |
| @bull-board/express | **9.9.0** (+ `@bull-board/api`) | Queue inspection UI | Optional observability (audit §14). Mount in the **worker's** health server, behind Better Auth `admin()` role check + IP allowlist (review S-3). Express peer model changed across majors — verify at install time (MEDIUM). |
| next-themes | **0.4.6** | Theme infrastructure (Phase 1) | Small, App Router-native, no-FOUC via inline script; per audit §19. |
| tsx | **4.23.13** | Worker dev runner (TS, no build) | `tsx worker/index.ts` in dev; production build via `tsc`/`tsup` into `worker/dist` (P-1). |
| tsup | **8.5.1** | Worker prod bundling | Alternative to bare `tsc` for `worker/dist/index.js`; pick one — single-package repo (N-9) favors plain `tsc` with a separate `tsconfig.worker.json`. |
| pino | **10.3.1** | Structured worker logs | Optional but recommended for the worker (`monitorId` correlation, audit §15). JSON logs to stdout → PM2 files. |
| zod | **4.5.x** | Validation (shared with Better Auth, which already depends on zod 4) | Reuse for monitor-create and AI-assistant schemas; Better Auth 1.7.3 itself pulls `zod ^4.5.4` — align, don't downgrade. |

### Development Tools

| Tool | Version | Purpose | Notes |
|------|---------|---------|-------|
| pnpm | **11.26.0** (pin via `packageManager`) | Package manager | See rationale under "Stack Patterns by Variant". Migrate with `pnpm import` (reads `package-lock.json`), then delete `package-lock.json`. pnpm ≥ 10 requires explicit `onlyBuiltDependencies` approval for postinstall scripts (replaces the stray npm `allowScripts` block). |
| Vitest | **5.0.0** (dev) | Unit/integration/characterization tests | Engines: Node `^22.12 \|\| ^24 \|\| >=26`. Dev machine runs Node 24.15 — fine. **Pin Node 24 in GitHub Actions**, or fall back to Vitest 4.1.x (`^20 \|\| ^22 \|\| >=24`) if the VPS/CI must stay on Node 20/22.0–22.11. |
| @playwright/test | **1.63.0** (dev) | E2E smoke (register→monitor→incident→status page) | Node ≥ 20. Run against local docker-compose Postgres+Redis, not the prod DB. |
| docker compose | Postgres `postgres:17-alpine` + Redis `redis:8-alpine` | Local dev + CI integration DBs | Required by review P-1/§23. Postgres 17 matches current Neon-major behavior; tag choices MEDIUM — match to the Neon major at Phase 0. |
| @types/pg | latest 8.x | Types for pg | Keep; also a declared optional peer of drizzle-orm. |
| ~~@types/nodemailer, @types/bcryptjs~~ | remove | — | Both packages ship their own types as of nodemailer 10 / bcryptjs 3 (verified). |

## Installation

```bash
# package manager (Phase 0)
corepack enable && corepack prepare pnpm@11.26.0 --activate
pnpm import && rm package-lock.json

# runtime deps
pnpm add next@16.3.4 \
  drizzle-orm@0.45.2 pg@8.23.0 \
  better-auth@1.7.3 \
  bullmq@6.3.4 ioredis@6.0.0 \
  nodemailer@10.0.1 resend@6.26.0 \
  bcryptjs@3.0.3 next-themes@0.4.6

# worker tooling (optional: pino for logs)
pnpm add tsx@4.23.13 pino@10.3.1

# dev deps
pnpm add -D drizzle-kit@0.31.10 vitest@5.0.0 @playwright/test@1.63.0 tsup@8.5.1 @types/pg

# optional queue UI (worker-facing, admin-gated)
pnpm add @bull-board/express@9.9.0 @bull-board/api

# after install: approve build scripts (pnpm >=10 behavior)
pnpm approve-builds
```

## Load-bearing API facts (verified, drive implementation)

### Drizzle baseline from live DDL (audit §21/D1, review M-3)

`drizzle-kit` commands (current docs): **`pull`** = introspect DB → `schema.ts`; **`generate`** = diff schema vs previous snapshot → `migration.sql` + `snapshot.json`; **`migrate`** = apply unapplied SQL files, record in DB history table; **`check`** = detect colliding migration branches; **`export`** = schema.ts → raw DDL. `push` exists but is the thing this migration is *eliminating*.

```ts
// drizzle.config.ts
export default {
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DIRECT_DATABASE_URL! }, // Neon DIRECT string, not -pooler
};
```

**Baseline recipe** (docs document `pull`/`generate`/`migrate` but not journal-stamping; the stamp step is community-established — MEDIUM, verify in the D-9 rehearsal):
1. `pg_dump --schema-only` prod → inspect real column types (timestamp vs timestamptz is the expected drift).
2. `drizzle-kit pull` → author `src/db/schema.ts` from actual DDL; hand-adjust naming/indexes.
3. `drizzle-kit generate` → produces the full initial `migration.sql` (tables already exist in prod).
4. Stamp it applied: insert the migration's hash/timestamp from `drizzle/meta/_journal.json` into the kit's history table (`migrations.table`, default `drizzle.__drizzle_migrations`) **in prod and in the rehearsal copy**. Equivalent: run `drizzle-kit migrate` with the initial file temporarily emptied. Either way, prove with a data-diff + row-count check.
5. **CI empty-diff gate:** `drizzle-kit pull` into a temp dir and diff the generated schema against the committed `schema.ts` (plus `drizzle-kit check` for journal collisions). Note `drizzle-kit generate` alone does NOT detect live-DB drift — it diffs schema vs last local snapshot — so the CI gate must pull from the live DB.

### Better Auth (A-1 / A-2 / A-3)

- **Default hashing is scrypt — configuring bcrypt is mandatory, not optional.** Exact config shape (verified):
```ts
import bcrypt from "bcryptjs";
betterAuth({
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    password: {
      hash: (pw) => bcrypt.hash(pw, 10),
      verify: ({ password, hash }) => bcrypt.compare(password, hash),
    },
  },
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } }, // signed compact cookie; proxy skips DB
});
```
  `cookieCache` uses an HMAC-SHA256 signed cookie so `proxy.ts` validates sessions with **zero DB queries** (A-2 resolved); pass `disableCookieCache: true` on sensitive endpoints. Revocations lag ≤ maxAge on other devices.
- **Bind to the existing `users` table (A-3):** `user: { modelName: "users", fields: { ... } }`, or remap keys in the adapter schema (`schema: { ...schema, user: schema.users }`). Adapter: `drizzleAdapter(db, { provider: "pg", schema })`. New Better Auth tables (`session`, `account`, `verification`) are added via `npx @better-auth/cli generate` → drizzle-kit migrations — **not** the CLI `migrate` command (that only works with Better Auth's built-in Kysely adapter).
- **Schema mapping reality (NextAuth → Better Auth, from the official guide):** `Account.provider`→`account.providerId`, `providerAccountId`→`accountId`, OAuth token snake_case→camelCase; credentials users need `account` rows with `providerId: "credential"`, `accountId = user.id`, and the **`password` column on `account`** (move the bcrypt hash off `users.password`). There is **no official SQL script** — the data migration is hand-written SQL (as audit §12/§21 already assumes).
- **`emailVerified` type break:** NextAuth's `emailVerified` is a timestamp; Better Auth's `user.emailVerified` is **boolean**. Add a new `email_verified boolean not null default false` column, backfill `set email_verified = (email_verified is not null)` style from the old timestamp, map it via `fields`. Keep the old column one release (expand/contract, M-2).
- **IDs:** keep existing cuid strings; new-entity IDs can stay Better Auth defaults (string) or be pinned via `advanced.database.generateId` (`false`/`"uuid"`/function returning `false` to defer to DB default). Business tables (`pings`, `incidents`) take the review D-3 route: DB default `gen_random_uuid()::text`.
- **Admin roles (S-3):** `plugins: [admin()]` adds `role`, `banned`, `banReason`, `banExpires` to the user model; `defaultRole: "user"` + DB default on the column covers existing users at migration. Client plugin `adminClient()` optional.

### BullMQ 6 (J-1…J-6, R-1)

- **Recurring work → `upsertJobScheduler`** (verified; legacy `repeat` REMOVED in v6):
```ts
// scheduler tick every 30s — idempotent upsert, safe to re-declare at worker boot (audit M8)
await schedulerQueue.upsertJobScheduler("scheduler-tick", { every: 30_000 },
  { name: "tick", opts: { removeOnComplete: { age: 3600, count: 5000 } } });
// cron pattern form: { pattern: "0 5 * * *", tz: "UTC" }  // legacy `utc: true` removed
```
  Semantics that matter for J-1: exactly one `delayed` job exists per scheduler id; new jobs are produced only when the last one starts processing (a busy queue self-throttles rather than piling up).
- **Connections (R-1.4):** workers *require* `maxRetriesPerRequest: null` (BullMQ throws otherwise); each Worker duplicates its connection internally for blocking commands. Producers (web API routes) should keep a low `maxRetriesPerRequest` (e.g. 1–default 20) so enqueue fails fast → 503. Use one shared connection for all Queues, a dedicated null-retries connection for Workers. BullMQ 6 note: high-level classes no longer expose `.client` internals; ioredis instances are wrapped.
- **Typed failures (J-4 + audit §17):** target DOWN is a *result*, not a throw. Permanent email errors throw **`UnrecoverableError`** (v6 removed `Job#discard()`), which stops retries — this is the mechanism for "retryable-vs-permanent" email classification.
- **Circuit breaker (J-5):** `Queue.pause()` / `await worker.resume()` (v6: `resume()` is async). `deduplicationId` gives free per-monitor in-flight dedupe as a second layer under the `next_check_at` claim.
- **FlowProducer** exists and is atomic (`flowProducer.add({...children})`, parent waits in `waiting-children`, children readable via `getChildrenValues()`); audit's "optional later" stance is right — plain chains suffice for v1.

### Neon + node-postgres (D-8)

- **Two connection strings, same credentials:** direct `ep-xxx.region.aws.neon.tech` vs pooled `ep-xxx-pooler...` (PgBouncer, `pool_mode=transaction`, `max_client_conn=10000`, `default_pool_size ≈ 0.9 × max_connections`).
- **Direct connection for:** `drizzle-kit migrate` (DDL), `pg_dump` (relies on `SET`), anything session-scoped. **Pooled for:** web-app reads/writes.
- **Transaction-mode pooler does NOT support:** `SET`/`RESET`, `LISTEN/NOTIFY`, `WITH HOLD` cursors, SQL-level `PREPARE`, temp tables, **session-level advisory locks** (the design uses Redis locks — good; do not "simplify" to `pg_advisory_lock` behind the pooler). Protocol-level prepared statements (what `pg` uses) are fine via PgBouncer 1.22+.
- **Budget math (verified):** smallest Neon compute (0.25 CU) → `max_connections = 104`, ~97 usable. Fits the D-8 budget (web 10 + worker 20 + migration runner 1) with headroom; during the Prisma↔Drizzle overlap, share the **same** `pg` Pool instance between both ORMs so the budget doesn't double.
- **Do not** use `@neondatabase/serverless` (HTTP/websocket driver) in the worker — it exists for serverless runtimes; a long-lived VPS worker wants real `pg` sockets with transactions.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| drizzle-orm 0.45.2 | Staying on Prisma 7 | Never, per binding rule 20. Prisma's generated-client output dir + `db push` model is precisely what M-1/M-3 remove; dual-ORM is transitional only. |
| drizzle-kit `migrate` (versioned SQL, one runner in deploy) | `drizzle-kit push` (diff-and-apply) | `push` only for throwaway local branches — it's `db push` under a new name and reintroduces M-1. |
| ioredis 6.0.0 | `node-redis` (BullMQ's `createNodeRedisClient`, needs redis ≥5) | Only if ioredis 6 + RESP3 misbehaves with BullMQ; ioredis is BullMQ's default and best-tested path. |
| ioredis 6 | ioredis 5.x (last 5.6.x) | If RESP3-by-default causes issues with the VPS Redis build, `protocol: 2` on v6 achieves the same without a downgrade. |
| pnpm 11.26 (pin) | pnpm 12.3.4 | pnpm 12 is the stable Rust rewrite (2 weeks old, "upgrading should not feel like a migration", keeps pnpm-11 lockfile format). Choose 12 when not mid-migration; M9 says don't churn tooling in the same milestone. |
| Vitest 5 (Node ≥22.12) | Vitest 4.1.x | If CI/VPS Node is pinned to 20.x or 22.0–22.11 — 4.1 supports `^20 \|\| ^22 \|\| >=24` and is API-compatible for this suite. |
| nodemailer 10 | nodemailer ^7 (current) | Entirely acceptable — SMTP API unchanged v7→v10; the `lib/email` abstraction makes this a one-file swap. v7 has no Node-20 floor. |
| Resend HTTP provider | AWS SES SDK | Only if volume/pricing demands; adds IAM surface the VPS doesn't need yet. |
| Better Auth Drizzle adapter | Better Auth Kysely (default) adapter | Never here: Kysely tables would fight Drizzle's schema ownership (M-1), and CLI `migrate` only works under Kysely — use `generate` + drizzle-kit instead. |
| Self-hosted Redis on the VPS (Q-3 default) | Managed Redis/Valkey | If/when the heartbeat gap shows Redis flakiness; managed must support blocking commands (BullMQ requirement, review R-1). Upstash is NOT this (see below). |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Prisma past step 8 (any "compatibility shim") | Binding rule 20; dual schema authorities violate M-1; generated client bloats build | Drizzle everywhere; during overlap share the single `pg` Pool |
| `drizzle-kit push` against prod | Unreviewed diff-and-apply = `db push --accept-data-loss` reincarnated (the exact defect M-1 deletes) | `generate` → committed SQL → `migrate` from one runner |
| Upstash Redis (REST) | REST per-command pricing/latency; **no blocking commands** → BullMQ workers cannot run on it; also a serverless posture the review explicitly rejects for orchestration | Self-hosted Redis 7.4+/8 on the VPS with AOF `everysec` + `noeviction` (Q-3) |
| Serverless schedulers (Vercel Cron, QStash, Inngest) as the check trigger | Audit rules 4–6: API/serverless must never be the monitoring worker; external triggers duplicate execution and die with CRON_MODE | BullMQ `upsertJobScheduler` tick inside the dedicated PM2 worker; healthchecks.io as dead-man's switch |
| `node-cron`/`instrumentation.ts` (retained) | Process-local scheduling is defect R4/R5 | Deleted at worker cutover (M3 overlap window then remove) |
| ioredis `keyPrefix` option | Explicitly incompatible with BullMQ's own key prefixing (verified) | BullMQ `prefix` option on Queue/Worker |
| `pg_advisory_lock` / session `SET` behind Neon `-pooler` | Transaction-mode PgBouncer breaks session-level state | Redis `SET NX PX` locks (audit §13); direct string for migrations |
| NextAuth v4 (or its Better-Auth "bridge" patterns) | v4 is maintenance-mode on Next 16 (R22); forced re-login already accepted (M2/D6) | Better Auth cutover with canary bcrypt login gate (A-1) |
| `@neondatabase/serverless` driver in web/worker | Designed for edge/serverless HTTP runtimes; adds a second driver to the budget | `pg` Pool everywhere (N-10) |
| Reintroducing a process-local fallback scheduler when Redis is down | Recreates process-local monitoring state — violates hard constraint; review R-1.1 rejects it | Monitoring *pause* + healthchecks.io heartbeat gap + "last checked X ago" staleness UI |

## Stack Patterns by Variant

**If the VPS/CI Node is 20.x:** Next 16.3 still works (≥20.9) but Vitest must drop to 4.1.x; nodemailer 10 → 7/9; ioredis 6 → 5.6.x. Strongly prefer standardizing on Node 24 (dev machine already 24.15) in Phase 0 — one engine constraint beats six.
**If Prisma↔Drizzle overlap windows stretch past a few days:** share one `pg` Pool instance between both ORMs (constructed once on `globalThis`), or the Neon connection budget doubles (D-8).
**If Bull Board is adopted:** mount it on the worker's `:9090` health server only, gated by Better Auth `admin()` role + IP allowlist — never on the public web app (S-3).
**If pnpm workspace (N-9) is chosen over single-package:** `packages/web` + `packages/worker` + `packages/shared` (check engine + queue types); otherwise single package with `tsconfig.worker.json` and a `build:worker` target — simpler, and adequate at this scale.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| better-auth@1.7.3 | drizzle-orm **^0.45.2 exactly**, drizzle-kit ≥0.31.4, next ^14/15/16, react 18/19, pg ^8, zod ^4.5 | Registry-verified peers. Drizzle is effectively pinned — check this peer on every better-auth upgrade. |
| bullmq@6.3.4 | ioredis **>=5.0.0** (6.0.0 OK, optional peer — install it), pg >=8 (optional), Node ≥14.17 | v6 removed `repeat`-style repeatables, `Job#discard`, `Queue#client`; `resume()` now async |
| ioredis@6.0.0 | Node ≥20; RESP3 default (`protocol: 2` reverts) | Shipped in lockstep with BullMQ 6 (2026-07-30/31) |
| nodemailer@10 | Node ≥20; ships own types (drop `@types/nodemailer`) | v8 renamed error `NoAuth`→`ENOAUTH`; v9 enforces TLS validation on remote content; SMTP core API unchanged v7→v10 |
| vitest@5 | Node ^22.12 / ^24 / ≥26 | Vitest 4.1.x is the fallback for Node 20/22.0–22.11 |
| @playwright/test@1.63 | Node ≥20 | — |
| next@16.3.4 | Node ≥20.9; React 19.2.x; React Compiler already enabled in repo | `proxy.ts` convention unchanged |
| pg@8.23 | Neon pooled (PgBouncer transaction mode) and direct strings; drizzle `node-postgres` driver | Protocol-level prepared statements OK via pooler; session-level features are not |

## Sources

- npm registry (`npm view`, live 2026-09-08): exact `latest` versions, `engines`, `peerDependencies`, release timestamps for next, drizzle-orm/-kit, better-auth, bullmq, ioredis, vitest, playwright, pnpm, nodemailer, resend, pg, bcryptjs, @bull-board/express, tsx, tsup, pino — **HIGH** (package of record)
- drizzle-kit docs — kit-overview + migrations pages (`pull`/`generate`/`migrate`/`check`/`export` semantics; baseline-stamping step is community practice, MEDIUM) — **HIGH** for commands
- Better Auth docs — email-password (scrypt default + `password.hash/verify` verbatim), session-management (`cookieCache` verbatim), admin plugin, Drizzle adapter (`modelName`/`fields`), database concepts (`generateId`), NextAuth migration guide (schema mapping, `account.password`, boolean `emailVerified`) — **HIGH**
- BullMQ docs — connections (`maxRetriesPerRequest: null` enforced; worker connection duplication; `keyPrefix` ban), job schedulers (`upsertJobScheduler` verbatim), flows; BullMQ v6.0.0 release notes (removed APIs) — **HIGH**
- ioredis v6.0.0 release notes (Node ≥20, RESP3 default) — **HIGH**
- Nodemailer CHANGELOG v8→v10 — **HIGH**
- Neon docs — connection-pooling page (pooled/direct strings, transaction-mode restrictions, `max_connections` per CU) — **HIGH**
- pnpm blog (12.0 Rust rewrite, lockfile compatibility with 11, release cadence) — **MEDIUM** (headlines verified; `packageManager`/corepack behavior not re-verified this session)
- Not verified this session (flag for phase-level research): `@bull-board/express@9` peer/install shape, Better Auth `databaseHooks.user.create.before` snippet (page moved; `defaultRole` covers the need), Resend SDK API surface, docker image tag choices

---
*Stack research for: SpiderNode backend modernization (Next.js 16.3 / Drizzle / Better Auth / Redis+BullMQ 6 / dedicated worker)*
*Researched: 2026-09-08*
