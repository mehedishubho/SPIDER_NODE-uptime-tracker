# Phase 4: Monitoring Worker — Build & Dark Launch - Pattern Map

**Mapped:** 2026-09-13
**Files analyzed:** 24 (new/modified)
**Analogs found:** 21 / 24 (3 no-analog: BullMQ machinery, tsup config, pino — covered by RESEARCH.md Patterns 1/8 + Code Examples)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/worker/index.ts` | entry/bootstrap | event-driven | `src/instrumentation.ts` | role-match (lifecycle + shutdown shape) |
| `src/worker/connection.ts` | utility (connection factory) | request-response | `src/lib/redis.ts` | exact (singleton + throw-early env) |
| `src/worker/queues.ts` | service (queue topology) | pub-sub | none (BullMQ new) | none — RESEARCH Pattern 1/Code Examples |
| `src/worker/scheduler.ts` | service | event-driven | `src/instrumentation.ts` (cron.schedule shape) | role-match |
| `src/worker/claim.ts` | service (claim transaction) | CRUD | `src/lib/db-pool.ts` + drizzle `sql` usage | role-match |
| `src/worker/locks.ts` | utility (distributed lock) | request-response | `src/lib/rate-limit.ts` | exact (Lua atomic-op discipline) |
| `src/worker/breaker.ts` | service (circuit breaker) | event-driven | `src/lib/rate-limit.ts` (fail-open/degraded shape) | partial |
| `src/worker/backlog.ts` | utility (enqueue gate) | request-response | `src/lib/rate-limit.ts` (drop/fail-open philosophy) | partial |
| `src/worker/persist/tier1.ts` | service (transition txn) | CRUD | `src/lib/cron-logic.ts` slow path (lines 147–213) | exact (behavior parity target) |
| `src/worker/persist/tier2.ts` | service (staged flush) | batch | `src/lib/db-batcher.ts` | exact (Tier 1 analog of Tier 2) |
| `src/worker/persist/outbox.ts` | service (relay) | pub-sub | `src/lib/telegram.ts` + cron-logic templates | exact (byte-parity target) |
| `src/worker/engine/check.ts` | service (check processor) | request-response | `src/lib/cron-logic.ts` (lines 56–94) | exact (fetch/timeout/status shape) |
| `src/worker/maintenance/*` | service | batch | `src/lib/cleanup-logic.ts` + db-batcher flush loop | role-match |
| `src/worker/health.ts` | service (HTTP server) | request-response | none in-repo (route handlers are Next-coupled) | none — RESEARCH Pattern 7 |
| `src/worker/logger.ts` | utility | — | none | none — RESEARCH Code Examples (pino) |
| `src/lib/ssrf.ts` | utility (validation pipeline) | request-response | `src/lib/rate-limit.ts` (canonicalize-then-validate, lines 75–107) | partial (address normalization directly reusable) |
| `tsup.config.ts` | config | — | none | none — RESEARCH Pattern 8 (verbatim) |
| `scripts/enqueue-smoke.mjs` / `redrive-outbox.mjs` / `seed-synthetic.sql` / `rehearse-worker.mjs` | script | batch | `scripts/rehearse-migrations.mjs` | exact (03-05 operator-script pattern) |
| `tests/worker/*.test.ts`, `tests/lib/ssrf.test.ts` | test | — | `tests/integration/rate-limit.test.ts` | exact (real-container integration discipline) |
| resilience suite (`pnpm test:resilience`) | test | — | same + `vitest.config.ts` env wiring | exact |
| `package.json` (modify) | config | — | existing scripts chain | exact |
| `ecosystem.config.js` (modify) | config | — | current single-app shape | exact |
| `.env.example` (modify) | config | — | 02-01 sweep (file unreadable in this session — env dir permission-denied) | cited |
| `docs/DEPLOY-RUNBOOK.md`, audit §14 amendment, `04-DEPLOY-RECORD.md` | doc | — | `03-DEPLOY-RECORD.md` disposition pattern | exact |

## Pattern Assignments

### `src/worker/connection.ts` (connection factory)

**Analog:** `src/lib/redis.ts` (42 lines, read in full)

The worker's BullMQ connection factory mirrors this module's shape — but per RESEARCH Code Examples the worker connections use `maxRetriesPerRequest: null` (NOT the web limiter's fail-open `1`), and BullMQ needs TWO connections (queue + blocking). Keep the analog's conventions: throw-early env validation, error listener attached inside the factory, never log the URL.

**Throw-early env + factory shape** (`src/lib/redis.ts` lines 12–17, 22–36):
```typescript
const globalForRedis = global as unknown as { redis?: Redis };
const connectionString = process.env.REDIS_URL;
if (!connectionString) {
  throw new Error("Environment variable REDIS_URL is not set");
}
// factory attaches client.on("error", ...) INSIDE so module re-evaluations
// never stack duplicate listeners. Never log the URL itself (secrets rule).
```
Worker version (RESEARCH Code Examples, verified against project skill):
```typescript
export function workerConnection(): IORedis {
  return new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,      // REQUIRED for Worker/QueueEvents
    enableReadyCheck: true,
  });
}
```

### `src/worker/locks.ts` (per-monitor lock)

**Analog:** `src/lib/rate-limit.ts` — one Lua script = one atomic op

The lock's owner-token compare-and-delete follows the `rlIncr` precedent exactly: `redis.defineCommand` with the Lua source at module scope, plus the typed-view cast (ioredis 6 does not surface custom commands on the client type).

**Lua atomic-op pattern** (`src/lib/rate-limit.ts` lines 12–27):
```typescript
const WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
`;
redis.defineCommand("rlIncr", { numberOfKeys: 1, lua: WINDOW_LUA });
const limiterRedis = redis as typeof redis & {
  rlIncr(key: string, windowSeconds: number): Promise<number>;
};
```
Lock release Lua is the same discipline: `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1])`.

**Address normalization** (`src/lib/rate-limit.ts` lines 75–88) is directly reusable in `src/lib/ssrf.ts` for the IPv6-mapped/short-form bypass vectors (D-42) — `normalizeClientAddress` already lowercases, strips brackets, and shape-checks both families.

### `src/worker/index.ts` + `scheduler.ts` (entry, lifecycle)

**Analog:** `src/instrumentation.ts` (97 lines, read in full)

Copy the lifecycle shape, not the implementation: gated registration at boot (CRON_MODE gate → WORKER_SCHEDULER_ENABLED gate, D-16: skip the upsert entirely, never `queue.pause()`), try/catch around each scheduled fire, and the SIGTERM/SIGINT graceful-shutdown registration (lines 82–95). Note the analog's shutdown does a final flush before `process.exit(0)` — the worker version becomes `worker.close()` drain + pool/redis teardown per RESEARCH Pattern 7. Entry skeleton itself is RESEARCH Code Examples ("Worker entry skeleton"): `import 'dotenv/config'` FIRST (D-12), `main().catch(...)` fatal boot.

### `src/worker/engine/check.ts` (check processor)

**Analog:** `src/lib/cron-logic.ts` lines 56–94 — the behavior being replaced

The check engine must produce identical outcome semantics: 10 s AbortController timeout, `performance.now()` response timing, 200–399 = UP, and the exact request headers:
```typescript
// cron-logic.ts lines 63–74 (parity targets)
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS); // TIMEOUT_MS = 10_000
const response = await fetch(monitor.url, {
  method: "GET",
  signal: controller.signal,
  redirect: "follow",           // engine changes to "manual" per-hop loop (D-41)
  cache: "no-store",
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; UptimeTrackerBot/1.0)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});
// statusCode >= 200 && statusCode < 400 → UP
```
The engine swaps `redirect: "follow"` for the manual ≤5-hop validated loop and the undici Agent IP pinning (RESEARCH Pattern 9) — everything else (timeout, timing, status classification) is transcription.

### `src/worker/persist/tier1.ts` (transition transaction)

**Analog:** `src/lib/cron-logic.ts` lines 147–213 — the slow path being replaced

Behavior contract to preserve: 1-strike DOWN (no consecutive-failure window), PENDING→UP sends "monitoring started", DOWN creates ONGOING incident with description `Monitor went down. Status code: ${statusCode || "Timeout"}`, UP-after-DOWN resolves via latest-ONGOING. The SQL form is RESEARCH Pattern 3; the JS math parity baseline (D-36) is lines 149–154:
```typescript
const totalChecks = (monitor.totalChecks || 0) + 1;
const failedChecks = (monitor.failedChecks || 0) + (!isUp ? 1 : 0);
const uptimePercent = Math.max(0, Math.min(100, ((totalChecks - failedChecks) / totalChecks) * 100));
```
Remember Pitfall 1: SQL side must be `round((100.0 * up / total)::numeric, 2)::double precision` and writer tests assert equality with `(x).toFixed(2)` at the edge ratios.

### `src/worker/persist/tier2.ts` (routine-UP staging flush)

**Analog:** `src/lib/db-batcher.ts` (120 lines, read in full)

The Tier 2 Redis-staged flush is the durable rewrite of this module's exact aggregation semantics — keep the counter math identical:
```typescript
// db-batcher.ts lines 96–98 — the flush math Tier 2 reproduces additively
const newTotalChecks = monitor.totalChecks + stats.totalChecks;
const newFailedChecks = monitor.failedChecks + stats.failedChecks;
const uptimePercent = Math.max(0, Math.min(100,
  ((newTotalChecks - newFailedChecks) / newTotalChecks) * 100));
```
Differences pinned by design: staging moves from in-memory arrays/Map to Redis (RENAMENX handoff, RESEARCH Pattern 4), never writes `status` (the analog's line 108 writes it — that defect is what write_guards fix), and flush cadence ≤60 s not 15 min. The analog's snapshot-then-clear (lines 70–75) maps to the RENAMENX ownership handoff.

### `src/worker/persist/outbox.ts` (relay + Telegram)

**Analog:** `src/lib/telegram.ts` (35 lines, read in full) + cron-logic templates

`sendTelegramAlert` swallows errors as `true/false` — the relay must WRAP it and classify failures itself (D-45): the function returns `false` on `data.ok === false` (parse `data.description` for 400/401/403 → permanent → `UnrecoverableError`) and returns `undefined` on throw (network → transient). Copy the request verbatim (URL shape, `parse_mode: "HTML"`, `disable_notification: false`).

**Byte-parity message templates** (`src/lib/cron-logic.ts` lines 104–133) — D-48 pins these character-for-character; transcribe all three (MONITORING STARTED / ALERT DOWN / RECOVERY), including `toLocaleString("en-US", { timeZone: monitor.user.timezone || "UTC", timeZoneName: "short" })` and `statusCode || "No Response / Timeout"`.

### `src/lib/ssrf.ts` (SSRF pipeline)

No direct analog — this is new validation surface. Partial analogs: `rate-limit.ts` address normalization (lines 75–88, reuse for D-42 vectors) and cron-logic's fetch call (headers/timeout parity). Transcription source is audit §15 + RESEARCH Pattern 9 (denylist tokens, canonicalization, per-hop loop, streamed byte cap). The D-40 denylist-diff gate extracts the 11 CIDR tokens from this module and runbook §10.

### `scripts/enqueue-smoke.mjs`, `redrive-outbox.mjs`, `rehearse-worker.mjs`, `seed-synthetic.sql`

**Analog:** `scripts/rehearse-migrations.mjs` — the 03-05 operator-script pattern

Copy its conventions: `#!/usr/bin/env node` shebang, header comment block numbering the pipeline steps with decision IDs, fail-loud on every step, teardown in `finally`, evidence file output (`.snapshots/` + committable copy under `.planning/phases/04-.../`), plain Node ESM + existing deps only (pg/ioredis), never echo secrets/dump paths. `rehearse:worker` mirrors the throwaway-container isolation (own ports, never the 5453/6390 vitest stack, sibling-stack pre-check).

### Worker/resilience tests (`tests/worker/**`, `tests/lib/ssrf.test.ts`, resilience project)

**Analog:** `tests/integration/rate-limit.test.ts` — integration discipline

Copy verbatim: real docker containers never mocked (Redis 6390 wired by vitest.config.ts); DEAD_PORT_URL constant for dead-endpoint cases; `crypto.randomUUID()` suffixes so cases cannot bleed; the `disposeSingleton()` + `vi.resetModules()` + dynamic-import restart simulation (lines 40–50) — needed again for the worker's globalThis-cached connections; `beforeAll` admin client + `afterAll` quit. Suite config joins `vitest.config.ts` (`include: tests/**/*.test.ts`, `fileParallelism: false`, alias `@` → src, `.env.test` override-first env wiring). The resilience project (D-27/D-30) is a separate vitest invocation reusing the same 5453/6390 stack with exclusive ownership. New tests must respect `tests/setup/global-setup.ts`: DB built only by `drizzle-kit migrate` (never push), and `assertLocalDatabaseUrl` fail-closed guard applies to any new DB URL a resilience/rehearsal script constructs.

### `src/worker/breaker.ts` / `backlog.ts`

Partial analog: `rate-limit.ts` lines 37–43 — the degraded-path philosophy (greppable marker, never rethrow into the hot path, bounded fallback). Breaker state machine, probe key, and `getJobCounts` gating are RESEARCH Pattern 6; constants pinned per D-33.

## Shared Patterns

### Global-cached singleton + throw-early env validation
**Sources:** `src/lib/redis.ts` (lines 12–17, 39–41), `src/lib/db-pool.ts` (lines 24, 41)
**Apply to:** `src/worker/connection.ts`, the worker's pg pool (max 20 — `db-pool.ts` lines 33–38 carry the §25.2 pin block to copy with max raised), any module-scoped Redis client.
```typescript
// db-pool.ts lines 29–38 — worker pool copies this with max: 20
new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                          // worker budget (§25.1)
  connectionTimeoutMillis: 10000,   // default 0 = wait forever — pinned nonzero
  idleTimeoutMillis: 10000,
  statement_timeout: 30000,
  idle_in_transaction_session_timeout: 30000,
});
```
Note: the worker runs standalone (no HMR) — keep the globalThis cache for vitest resetModules compatibility (see rate-limit.test.ts disposeSingleton), same as the analogs.

### Error handling / logging
**Source:** `src/lib/redis.ts` line 34, `rate-limit.ts` line 41, `instrumentation.ts` catch blocks
**Apply to:** all worker modules. Convention: `[<module-tag>] <context>:` prefix, `err.message` only (never full URL/token), fail-open where a dependency death must not stall the lane. Worker upgrades this to pino child loggers (`logger.child({ monitorId, jobId })` — RESEARCH Code Examples); keep the greppable DEGRADED marker style for breaker/backlog drop lines.

### Secrets rule
Never log connection strings or tokens (`redis.ts` line 32 comment; `telegram.ts` token handling). Health/metrics endpoints carry no secrets (RESEARCH Security Domain).

### Schema consumption (read, do not modify)
`src/db/schema.ts` already carries every prerequisite: `nextCheckAt` + `idx_monitors_due` partial index (line 98), `writeGuards` table (line 75), `outbox` + `idx_outbox_unsent` (lines 201–211), `incidents_one_ongoing` partial unique (line 151), `pings.errorClass` (line 112), `uptimePercent: doublePrecision` (line 89 — the Pitfall 1 column driving the `::numeric` cast). Phase 4 targets zero new migrations.

### Config edits
- `package.json`: scripts follow the existing chain style — add `dev:worker`, `test:resilience`, `rehearse:worker`; `build` gains the tsup step inside the existing `"build"` string chain (D-06). Deps per RESEARCH Standard Stack (bullmq, pino, undici + tsup, tsx devDeps; tsx must be added explicitly — Pitfall 9).
- `ecosystem.config.js`: current single-app object (read in full, 13 lines) gains a second `apps[]` entry: `script: "node"`, `args: "dist/worker.js"`, `wait_ready: true`, `listen_timeout: 30000`, `kill_timeout: 20000` (D-20/Pattern 7).
- `.env.example`: adds `WORKER_SCHEDULER_ENABLED`, `WORKER_HEALTH_PORT` (file unreadable this session — env dir permission-denied; planner follows the 02-01 sweep pattern already in that file).

## No Analog Found

| File | Role | Data Flow | Reason | Planner Source |
|------|------|-----------|--------|----------------|
| `src/worker/queues.ts`, `scheduler.ts` internals | service | pub-sub | No BullMQ exists in-repo yet | RESEARCH Pattern 1 + Code Examples (claim→lane→jobId) |
| `src/worker/health.ts` (http server) | service | request-response | All existing HTTP handlers are Next-coupled (NextResponse) — D-08 forbids importing them | RESEARCH Pattern 7 (node:http skeleton verbatim) |
| `tsup.config.ts` | config | — | No bundler config exists | RESEARCH Pattern 8 (verbatim, verified options) |
| `src/worker/logger.ts` | utility | — | No pino in-repo | RESEARCH Code Examples (pino child loggers) |

## Metadata

**Analog search scope:** `src/lib/`, `src/`, `src/db/`, `scripts/`, `tests/`, root configs (`package.json`, `ecosystem.config.js`, `vitest.config.ts`)
**Files scanned:** 12 analog files read in full or targeted; schema via targeted grep
**Pattern extraction date:** 2026-09-13
**Note:** `.env.example` and `docs/ARCHITECTURE-AUDIT.md` §14/§15/§16 were not (re)read in this session — the audit sections are transcription sources the planner must read directly (per CONTEXT canonical_refs); they are design text, not codebase analogs.
