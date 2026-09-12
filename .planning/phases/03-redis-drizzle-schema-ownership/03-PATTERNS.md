# Phase 3: Redis & Drizzle Schema Ownership - Pattern Map

**Mapped:** 2026-09-12
**Files analyzed:** 26 (14 new, 12 modified)
**Analogs found:** 22 / 26 (4 have no codebase analog — Drizzle-specific artifacts; RESEARCH.md Patterns 3–5 supply their templates)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/redis.ts` (NEW) | utility / infra client | request-response | `src/lib/prisma.ts` + `src/redux/api/baseApi.ts` | exact (singleton + throw-early) |
| `src/lib/rate-limit.ts` (REWRITE) | utility | request-response | itself (contract preserved) + RESEARCH Pattern 2 | exact |
| `src/lib/db-pool.ts` (NEW) | config / infra | request-response | `src/lib/prisma.ts` lines 3–13 (pool portion) | exact |
| `src/lib/prisma.ts` (MODIFY) | utility / ORM client | CRUD | itself (wraps db-pool instead of owning Pool) | exact |
| `src/db/schema.ts` (NEW) | model | — | `prisma/schema.prisma` (table inventory) + audit §11 (DDL source) | partial (no Drizzle schema exists) |
| `src/db/index.ts` (NEW) | model / client export | CRUD | `src/lib/prisma.ts` (named-export singleton consumer) | role-match |
| `drizzle.config.ts` (NEW) | config | — | `vitest.config.ts` (env-resolution discipline) | role-match |
| `drizzle.gate.config.ts` (NEW) | config | batch | `drizzle.config.ts` (sibling, this phase) | none — RESEARCH Pattern 3 |
| `drizzle/0000_baseline/` + `drizzle/0001_worker-prereqs/` + `meta/_journal.json` (NEW) | migration | batch | none in repo | none — RESEARCH Pattern 4 |
| `scripts/stamp-baseline.ts` (NEW) | utility script | batch | `tests/setup/global-setup.ts` (execSync + guard pattern) | role-match |
| `scripts/anonymize-snapshot.ts` (NEW) | utility script | batch / transform | none (no `scripts/` dir exists; root `test-*.js` are ad-hoc, not a pattern) | none — RESEARCH Code Examples |
| `scripts/rehearse-migrations.ts` (+ `pnpm rehearse:migrations`) (NEW) | utility script | batch | `tests/setup/global-setup.ts` (orchestration + fail-loud catch) | role-match |
| `tests/integration/rate-limit.test.ts` (NEW) | test | request-response | `tests/integration/db-batcher.test.ts` | exact (integration discipline) |
| `tests/integration/db-pool.test.ts`, `tests/integration/db-client.test.ts` (NEW) | test | request-response | `tests/integration/db-batcher.test.ts` | exact |
| `tests/setup/global-setup.ts` (MODIFY) | test infra | batch | itself (swap `prisma db push` → `drizzle-kit migrate`) | exact |
| `tests/api/monitors.handler.test.ts` (MODIFY) | test | request-response | itself + `tests/api/_harness.ts` | exact |
| `tests/api/auth-shallow.handler.test.ts` (MODIFY) | test | request-response | itself + `tests/api/_harness.ts` | exact |
| `src/app/api/monitors/route.ts` (MODIFY — `await` only) | route | request-response | itself | exact |
| `src/app/api/auth/register/route.ts` (MODIFY — `await` only) | route | request-response | itself | exact |
| `package.json` (MODIFY) | config | — | itself (`verify` chain, scripts) | exact |
| `vitest.config.ts` (MODIFY) | config | — | itself (DATABASE_URL env wiring → mirror for REDIS_URL) | exact |
| `prisma/schema.prisma` (MODIFY — header) | model | — | itself lines 1–4 (comment header) | exact |
| `docs/DEPLOY-RUNBOOK.md` (MODIFY) | docs / runbook | — | itself §3 step 3 (phase-conditional Migrate wording) + §3a (typed one-time-section layout) | exact |
| `.env.example` (MODIFY) | config | — | itself (02-01 sweep format; file not readable by tooling — planner follows existing per-var comment style) | exact |
| `.gitignore` + `.snapshots/` (NEW) | config | file-I/O | `.gitignore` lines 35–39 (`!.env.example` opt-out pattern) | exact |

## Pattern Assignments

### `src/lib/redis.ts` (utility, request-response)

**Analog:** `src/lib/prisma.ts` (globalThis singleton) + `src/redux/api/baseApi.ts` (throw-early env validation)

**Singleton pattern** (`src/lib/prisma.ts` lines 5–13, 23–26 — mirror this shape exactly):
```typescript
const globalForPrisma = global as unknown as {
  prisma?: PrismaClient;
  pool?: Pool;
};
const pool = globalForPrisma.pool || new Pool({ connectionString });
// ...
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
  globalForPrisma.pool = pool;
}
```

**Throw-early validation** (`src/redux/api/baseApi.ts` lines 9–11):
```typescript
if (!baseUrl) {
  throw new Error("Environment variable NEXT_PUBLIC_BASE_URL is not set");
}
```
Apply as: `if (!process.env.REDIS_URL) throw new Error("Environment variable REDIS_URL is not set");` at module load (D-21).

**Body:** RESEARCH.md Pattern 1 is the verified template — copy it verbatim (ioredis options: `commandTimeout: 200`, `maxRetriesPerRequest: 1`, `connectTimeout: 500`) plus the MANDATORY `redis.on("error", ...)` no-op logger (Pitfall 6 — unhandled `error` events crash the process). Use double quotes + semicolons (lib-file style per CLAUDE.md). Attach the limiter Lua via `defineCommand` here or in `rate-limit.ts` (RESEARCH Pattern 2).

---

### `src/lib/rate-limit.ts` (REWRITE — utility, request-response)

**Analog:** itself — the exported contract is the compatibility anchor

**Contract to preserve verbatim** (`src/lib/rate-limit.ts` lines 1–4, 8, 46–52):
```typescript
export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}
export function rateLimit(identifier: string, options: RateLimitOptions) { ... }
export function getIP(req: Request) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0] ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}
```
Only changes: `rateLimit` becomes `async`, body swaps the Map for the atomic Lua call (RESEARCH Pattern 2), fail-open catch returns `{ success: true, remaining: options.limit - 1 }` with the greppable `console.error("[redis-limiter] DEGRADED fail-open:", ...)` marker (D-01/D-02). Never rethrow. `getIP` untouched. Key shape `rl:${identifier}` (identifier already carries `monitors_`/`register_` bucket — D-04 parity).

**Call sites — the ONLY textual change is adding `await`** (`src/app/api/monitors/route.ts` line 39, `src/app/api/auth/register/route.ts` line 12):
```typescript
const { success, remaining } = rateLimit(`monitors_${ip}`, { limit: 20, windowMs: 60000 });
const { success, remaining } = rateLimit(`register_${ip}`, { limit: 5, windowMs: 3600000 });
```
Response shape `{ success, remaining }`, 429 + `X-RateLimit-Remaining` header behavior, and limiter-before-session-guard ordering all stay identical (pinned by characterization tests).

---

### `src/lib/db-pool.ts` (NEW — config/infra) + `src/lib/prisma.ts` (MODIFY)

**Analog:** `src/lib/prisma.ts` lines 3–13 — the Pool creation moves out; PrismaPg re-wraps it

**Extraction origin** (current):
```typescript
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
const globalForPrisma = global as unknown as { prisma?: PrismaClient; pool?: Pool; };
const pool = globalForPrisma.pool || new Pool({ connectionString });
const adapter = new PrismaPg(pool);
```
After (D-06): `db-pool.ts` owns `new Pool({ ...§25.2 pinned options })` with the `globalForPool` globalThis cache (RESEARCH Pattern 5 body is the template — `max: 10`, `connectionTimeoutMillis`, `idleTimeoutMillis`, `statement_timeout`, `idle_in_transaction_session_timeout`); `prisma.ts` becomes `import { pgPool } from './db-pool'` + `new PrismaPg(pgPool)` + the existing PrismaClient/log config, changing nothing else. Keep `prisma.ts` single quotes (match file). Shape the pool factory so Phase 4's worker can build its own pool (max 20) — per-process, never shared.

### `src/db/index.ts` (NEW) and `src/db/schema.ts` (NEW)

**Analog for `index.ts`:** `src/lib/prisma.ts` (named export consumed everywhere; no route imports `@/db` yet — D-05). Body = RESEARCH Pattern 5: `drizzle({ client: pgPool, schema })`.

**Analog for `schema.ts`:** no Drizzle schema exists in the repo. Source material: `prisma/schema.prisma` (table/column inventory: User, Account, Session, VerificationToken?, Monitor, Ping, Incident, Feedback — confirm full list against the file) transcribed DDL-precise from audit §11 + live `pg_dump`. Prefer generating the baseline from `drizzle-kit pull` against the anonymized snapshot, then hand-finishing (RESEARCH Open Question 1 recommendation — makes the empty-diff gate pull-vs-pull).

### `drizzle.config.ts` / `drizzle.gate.config.ts` (NEW — config)

**Analog:** `vitest.config.ts` (env-resolution discipline). Copy RESEARCH's drizzle.config shape; gate config adds `schemaFilter: ["public"]` (Pitfall 4) and `out: ".tmp-gate"`.

### `scripts/*.ts` (NEW — utility scripts; no `scripts/` dir exists yet)

**Analog:** `tests/setup/global-setup.ts` — the repo's precedent for a TypeScript orchestration script with fail-loud error handling:

**execSync + restated-cause catch** (lines 60–72):
```typescript
try {
  execSync("pnpm exec prisma db push", { stdio: "inherit" });
} catch {
  throw new Error(
    "global-setup failed: prisma db push could not prepare the test database. " + ...
  );
}
```
Apply the same shape to `rehearse:migrations` (docker run → pg_restore via docker exec → anonymize → stamp → migrate → compare → evidence file, per RESEARCH Pattern 4 pipeline). `stamp-baseline.ts` body = RESEARCH Pattern 4 script (sha256 + journal `when`, idempotent hash check). `anonymize-snapshot.ts` = RESEARCH Code Examples SQL (deterministic md5-derived UPDATEs; bcrypt untouched).

### `tests/setup/global-setup.ts` (MODIFY — D-14)

**Analog:** itself. Keep: the `assertLocalDatabaseUrl` guard and its exported test (lines 13–41) untouched. Replace only the `execSync("pnpm exec prisma db push", ...)` block (lines 60–63) with `execSync("pnpm drizzle-kit migrate", ...)` and update the comment block (lines 49–59) + catch message. This requires the full-DDL baseline shape (RESEARCH Pattern 4, shape 2) so fresh test containers get the whole schema from `0000` + `0001`.

### `tests/integration/rate-limit.test.ts`, `db-pool.test.ts`, `db-client.test.ts` (NEW — D-20)

**Analog:** `tests/integration/db-batcher.test.ts`

**Header-comment + real-infrastructure discipline** (lines 1–18):
```typescript
// ---------------------------------------------------------------------------
// Characterization suite: src/lib/db-batcher.ts ...
// The database is the real docker test Postgres, driven through the
// @/lib/prisma singleton (never mocked — mocking the ORM would characterize
// the mock, not the system).
// ---------------------------------------------------------------------------
```
Apply: real docker Redis (6390) via `REDIS_URL` wired in `vitest.config.ts` env — mirror this exact block from `vitest.config.ts` lines 11–34:
```typescript
export const DEFAULT_TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5453/uptime_test";
dotenv.config({ path: ".env.test", override: true });
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
process.env.DATABASE_URL = testDatabaseUrl;
// env: { DATABASE_URL: testDatabaseUrl, ... }
```
Add the Redis twin: `DEFAULT_TEST_REDIS_URL = "redis://localhost:6390"` (no auth on the test container), same override/inherit chain. `fileParallelism: false` already set — new files join that discipline. For "window survives client re-creation": note `vi.resetModules()` + dynamic import gives a fresh `src/lib/redis.ts` module — but the globalThis cache defeats this in non-production NODE_ENV; the test must bypass/clear the global cache when simulating restart (flag for planner).

### `tests/api/monitors.handler.test.ts` + `auth-shallow.handler.test.ts` (MODIFY — Pitfall 3)

**Analog:** themselves + `tests/api/_harness.ts`. Current reset discipline (monitors.handler.test.ts lines 29–38):
```typescript
beforeEach(() => {
  vi.resetModules(); // fresh @/lib/rate-limit Map per case (Pitfall 6)
  mockSession(null);
  resetPrismaMocks();
});
```
The comment's premise dies with the Map swap. Adaptation (RESEARCH Pitfall 3): keep the limiter REAL; add `FLUSHDB` (or targeted SCAN+DEL of `rl:*` — never `KEYS`) on the 6390 Redis in `beforeEach` via a separate admin client, and/or per-case unique IPs. Update the header comment blocks to state the new reset mechanism.

### `package.json` (MODIFY)

**Analog:** itself. Extend the existing chain (line 13):
```json
"verify": "docker compose -f docker-compose.test.yml up -d --wait && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e"
```
Insert empty-diff gate + db-push-absence grep after `pnpm test` (order + ≤5-min budget per Pitfall 9 — gate reuses the already-up container). Add `"rehearse:migrations"` script. Deps: `ioredis@^6.0.0`, `drizzle-orm@^0.45.2` in dependencies; `drizzle-kit@^0.31.10` also in **dependencies** (not devDependencies — D-08, runs on VPS via `--prod` install).

### `prisma/schema.prisma` (MODIFY — freeze header)

**Analog:** its own header block (lines 1–4). Prepend a deprecation banner before the existing comments; change nothing else (D-09).

### `docs/DEPLOY-RUNBOOK.md` (MODIFY)

**Analogs:** §3 step 3 (lines 70–75) already carries the phase-conditional Migrate wording ("Phase 3 onward: run the single migration runner — `pnpm drizzle-kit migrate`") — the amendment activates it and adds the one-time baseline-stamp step. §3a (lines 97–117) is the layout template for the new typed one-time sections: VPS Redis install/hardening (D-15/D-17/D-18, RESEARCH Pattern 6 config lines), memory-alert cron (D-16), rehearsal procedure (D-10..D-12). Follow its numbered Action/Verification/Rollback structure exactly.

### `.gitignore` / `.snapshots/` (NEW)

**Analog:** `.gitignore` lines 35–39 deny-then-opt-out pattern. Add `.snapshots/` (plain ignore — never committed, D-11).

## Shared Patterns

### Singleton-with-globalThis (all shared clients)
**Source:** `src/lib/prisma.ts` lines 5–13, 23–26
**Apply to:** `src/lib/redis.ts`, `src/lib/db-pool.ts` — cache on `globalThis` only when `NODE_ENV !== "production"`; module-level named export; never instantiate per-call.

### Throw-early env validation
**Source:** `src/redux/api/baseApi.ts` lines 9–11
**Apply to:** `src/lib/redis.ts` (`REDIS_URL`), optionally `drizzle.config.ts` (`DATABASE_URL!`). Never log the value.

### Fail-open error containment (Redis only)
**Source:** RESEARCH Pattern 2 (new — no existing analog; closest spirit: cron-logic's failure-swallow + HC ping, but do NOT wire to healthchecks.io per D-02)
**Apply to:** `rateLimit` only. `console.error("[redis-limiter] DEGRADED fail-open:", err.message)` → return success. Distinct from the API-route pattern (`NextResponse.json({ error }, { status: 500 })`) — the limiter never surfaces errors to callers.

### Fail-loud script errors
**Source:** `tests/setup/global-setup.ts` lines 60–72 (catch → restate cause → throw)
**Apply to:** all `scripts/*.ts` orchestration steps.

### Test env wiring
**Source:** `vitest.config.ts` lines 11–22, 32–35
**Apply to:** `REDIS_URL`/`TEST_REDIS_URL` twin of the `DATABASE_URL` chain.

## No Analog Found

| File | Role | Data Flow | Reason / Template Source |
|------|------|-----------|--------------------------|
| `drizzle/` migrations (0000 + 0001 + journal) | migration | batch | No versioned migrations exist (`prisma db push` repo). Use RESEARCH Pattern 4 (full-DDL baseline recommended) + Code Examples worker-prereqs DDL from audit §11 |
| `drizzle.gate.config.ts` | config | batch | Use RESEARCH Pattern 3 (`schemaFilter: ["public"]`, throwaway out dir) |
| `scripts/anonymize-snapshot.ts` | utility | transform | Use RESEARCH Code Examples anonymization SQL |
| `src/db/schema.ts` (Drizzle declarations) | model | — | No Drizzle code in repo; generate from `drizzle-kit pull` against snapshot, hand-finish per audit §11 |

## Metadata

**Analog search scope:** `src/lib/`, `src/db/` (absent), `src/app/api/`, `src/redux/api/`, `tests/**`, root configs (`package.json`, `vitest.config.ts`, `docker-compose.test.yml`, `.gitignore`), `prisma/schema.prisma`, `docs/DEPLOY-RUNBOOK.md`
**Files scanned:** ~20 (all read this session; `.env.example` blocked by permissions — pattern taken from 02-CONTEXT/03-CONTEXT descriptions)
**Pattern extraction date:** 2026-09-12
