# Phase 5: Worker Cutover & Operational Hardening - Pattern Map

**Mapped:** 2026-09-15
**Files analyzed:** 18 (new + modified + deleted)
**Analogs found:** 18 / 18 (this phase is almost entirely composition of existing Phase 2–4 machinery; every new file has a direct in-repo analog)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/worker/scheduler.ts` (heartbeat/outbox/memory ping wiring at end of `processTick` + catch paths) | hook/service | event-driven (tick) | `src/instrumentation.ts:37-52` (HC ping success + `/fail`) | exact (port of the same dead-man pattern into the worker tick) |
| `src/worker/health.ts` (+ `/metrics` branch) | service | request-response | `src/worker/health.ts:193-211` (`/metrics.json` branch — same handler, additive branch) | exact |
| `src/worker/metrics.ts` (NEW — prom-client registry + gauges) | service/utility | request-response (scrape-time collect) | `src/worker/health.ts:96-109,196-207` (lazy provider pattern) + `src/worker/persist/outbox.ts:655-697` (collector) | exact (wrap existing collectors, no new collection logic) |
| `src/worker/persist/outbox.ts` (WR-04 AbortSignal; + oldest-unsent age in `collectOutboxMetrics`) | service | CRUD/batch | itself: `telegramSend` :223-246; collector :655-697 | exact (additive edits at named sites) |
| `src/worker/queues.ts` (WR-02 TOCTOU skip; WR-03 remove `rollbackFailedClaim` call) | service | event-driven (queue) | itself: `enqueueClaimedCheck` :269-323 | exact |
| `src/worker/db.ts` (WR-05 `options: "-c timezone=UTC"`) | config | n/a (pool) | itself: Pool pin block :28-37 | exact |
| `scripts/gate-cutover.mjs` (NEW — 7-gate evaluator) | utility/script | batch (snapshot → verdict) | `scripts/check-worker-boundary.mjs` (plain ESM, zero deps, fail loud, exit non-zero listing violations) | exact |
| `scripts/scrape-metrics.mjs` (NEW — throwaway scraper) | utility/script | polling/batch | `scripts/enqueue-smoke.mjs` (local HTTP poll of worker surface) | role-match |
| `scripts/rehearse-cutover.mjs` (NEW or extension of `rehearse-worker.mjs`) | utility/script | batch (choreography) | `scripts/rehearse-worker.mjs` (13-step deploy-day rehearsal, evidence file) | exact (D-33 extends this pipeline) |
| `scripts/check-cron-remnants.mjs` (NEW — D-41 verify leg) | utility/script | batch (grep) | `scripts/check-worker-boundary.mjs` (dir scan + specifier extraction, fixture-testable via extra dir args) | exact |
| `tests/worker/scheduler-heartbeat.test.ts` (NEW) | test | unit | `tests/worker/scheduler-flag.test.ts` (flag/boot-gate assertions on scheduler) | exact |
| `tests/worker/outbox-age-ping.test.ts` (NEW) | test | unit | `tests/worker/health.test.ts` (injectable fake providers) | role-match |
| `tests/worker/health-metrics.test.ts` (NEW — /metrics endpoint) | test | unit/integration | `tests/worker/health.test.ts` (ephemeral port 0, real HTTP handler) | exact |
| `tests/worker/cutover-gates.test.ts` (NEW — gate logic over fixture snapshots) | test | unit | `tests/worker/build-gate.test.ts` (gate logic over fixtures — same fixture-dir-arg approach as check-worker-boundary) | exact |
| `tests/worker/cron-remnant-gate.test.ts` (NEW) | test | unit | `tests/worker/build-gate.test.ts` | exact |
| `tests/worker/queues.test.ts` (re-pin #4 at ~:187), `outbox-relay.test.ts` (extend), `persist-tier1.test.ts` (extend SHOW timezone) | test | integration (real PG+Redis) | themselves — existing pinned suites | exact |
| `.env.example` (D-39/D-40/D-46 annotations + removals) | config | n/a | existing `.env.example` conventions (93 lines, names-only FND-07 contract) | exact |
| `src/instrumentation.ts` (DELETED at deletion release) + `docs/DEPLOY-RUNBOOK.md` §3c/§4a/§9, `docs/ARCHITECTURE-AUDIT.md` §M4 amendments, `.planning/PROJECT.md` | doc/deletion | n/a | 04 disposition-register pattern (04-DEPLOY-RECORD.md) | exact (documented-amendment precedent) |

## Pattern Assignments

### `src/worker/scheduler.ts` — heartbeat + 3 dead-man pings (WRK-09/OBS-03/D-24)

**Analog:** `src/instrumentation.ts:37-52` — the exact success + `/fail` semantics being ported to the worker tick (D-22 parity).

**Port-from pattern** (instrumentation.ts lines 37-52):
```typescript
// success ping after the tick body completes
if (process.env.HC_PING_URL) {
  fetch(process.env.HC_PING_URL)
    .then(() => console.log("💓 Heartbeat sent to healthchecks.io"))
    .catch((e) => console.error("❌ Failed to send heartbeat:", e));
}
// catch path — explicit failure signal
if (process.env.HC_PING_URL) {
  fetch(`${process.env.HC_PING_URL}/fail`).catch(() => {});
}
```

**Worker-side adaptation (RESEARCH Pattern 2, audit §14.2 step 5):** one `pingDeadMan(base, fail)` helper — `AbortSignal.timeout(5_000)`, swallow errors (never fail the tick), no retries (5 pings/min/check cap; 30s tick = 2/min). Wire at the END of `processTick` (scheduler.ts:81-113) and in its error paths; pings read `WORKER_HC_PING_URL`, `WORKER_OUTBOX_HC_PING_URL`, `WORKER_MEMORY_HC_PING_URL`. Outbox/memory pings are conditional (only while outbox age < threshold / memory < 70%) — read the same values the metrics gauges read (outbox oldest-unsent age from the extended collector; `redisMemorySnapshot` from health.ts:96-109).

**Match the file's logging style:** `log.error({...}, "message")` via pino `buildLogger()` (scheduler.ts:33) — ids only, never URLs/tokens (ping URLs are secret-bearing env, same class as HC_PING_URL — never logged).

---

### `src/worker/health.ts` — `/metrics` branch (OBS-05/D-26)

**Analog:** itself — the `/metrics.json` branch, health.ts:193-211:
```typescript
if (path === "/metrics.json") {
  const memory = await redisMemorySnapshot(redis);
  const body: Record<string, unknown> = { ...provenance(), redis: memory };
  if (options.queueMetrics) {
    const queueSection = await options.queueMetrics().catch(() => null);
    if (queueSection && typeof queueSection === "object") Object.assign(body, queueSection);
  }
  // ... outboxMetrics same shape
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
  return;
}
```
Add a sibling `if (path === "/metrics")` branch: `res.writeHead(200, { "content-type": registry.contentType }); res.end(await registry.metrics());` (registry injected via a new `StartHealthServerOptions` field, mirroring `queueMetrics`/`outboxMetrics` provider injection — health.ts:135-144). Preserve: loopback-only bind (health.ts:160, T-04-01 — never 0.0.0.0), 405/404 branches, and the never-500 catch wrapper (health.ts:216-225).

---

### `src/worker/metrics.ts` (NEW) — prom-client registry

**Analog:** the lazy-provider philosophy in `health.ts:135-144` + the existing collectors (`collectOutboxMetrics` outbox.ts:655-697, queue collector in queues.ts). No new collection logic — gauges wrap the existing functions via scrape-time `collect()` (RESEARCH Pattern 3):
```typescript
new client.Gauge({
  name: "spidernode_queue_depth",
  help: "Jobs per lane by state",
  labelNames: ["queue", "state"],
  registers: [registry],
  async collect(this: any) { /* this.set({queue,state}, n) from existing snapshot */ },
});
```
Import `@prometheus-io/client` (NOT deprecated `prom-client` — install gated behind `checkpoint:human-verify`). `registry.metrics()` is async in 0.16.x. Metric families: queue depth/age/stalled, transition→alert latency (p50/p95/avg), Redis memory percent, outbox unsent/failed/oldest-age.

---

### `src/worker/persist/outbox.ts` — WR-04 + oldest-unsent age

**Analog/site 1 (WR-04):** `telegramSend`, outbox.ts:223-246 — add to the fetch options at :228:
```typescript
signal: AbortSignal.timeout(10_000),
```
Also tighten the relay FOR UPDATE transaction scope per 04-REVIEW (send outside the idle-in-transaction window).

**Analog/site 2 (OBS-03 gauge):** `collectOutboxMetrics`, outbox.ts:655-697 — extend ADDITIVELY with oldest-unsent age. Follow the exact existing SQL style (drizzle `sql` template, `EXTRACT(EPOCH FROM ...)`, failures map to `-1`, never fatal):
```typescript
// add to the counts query or a sibling bounded query:
SELECT (EXTRACT(EPOCH FROM (now() - created_at)))::double precision AS oldest_s
  FROM outbox
 WHERE sent_at IS NULL AND attempts < ${RELAY_MAX_ATTEMPTS}
   AND NOT (payload ? ${RELAY_FAILURE_KEY}::text)
 ORDER BY created_at ASC LIMIT 1
```
`created_at` is timestamptz — clock-safe once WR-05's UTC pool option lands. Add `oldestUnsentSeconds` to `OutboxMetricsSnapshot` (additive shape, health.ts:26-32 comment mandates this).

---

### `src/worker/queues.ts` — WR-02/WR-03

**Site:** `enqueueClaimedCheck` :298-321 and `addCheckJob` :208-231.

- **WR-02 (TOCTOU):** the inner `addCheckJob` call (:299) re-checks the breaker and can throw `BreakerOpenError` after the outer check at :282 passed. Catch `BreakerOpenError` at :300 and return `{ jobId, priority, dropped: true, breakerGated: true }` — a SKIP, mirroring the :282-288 skip shape verbatim.
- **WR-03:** delete the `rollbackFailedClaim(row.id)` call at :309-319 (audit §14.4: "leave claims advanced"); rethrow the error for the tick to log. Keep the function exported only if tests still need it; re-pin `tests/worker/queues.test.ts` #4 (~line 187) to assert the claim STAYS advanced.

---

### `src/worker/db.ts` — WR-05

**Site:** Pool pin block :28-37. Add one option (typing verified: `PoolConfig.options?: string`):
```typescript
options: "-c timezone=UTC", // WR-05: one clock domain for all worker sessions
```
Test assertion (extend `tests/worker/persist-tier1.test.ts`): `SHOW timezone` returns `UTC`.

---

### `scripts/gate-cutover.mjs`, `scripts/check-cron-remnants.mjs`, `scripts/scrape-metrics.mjs`, `scripts/rehearse-cutover.mjs`

**Analog:** `scripts/check-worker-boundary.mjs:1-80` — the house style for all repo scripts:
- Header comment: purpose, verify-chain position, conventions, usage line
- `#!/usr/bin/env node`, plain ESM, **zero new deps** (`node:fs`/`node:path`/global fetch only)
- Fail loud on every error path; exit non-zero listing violations
- Fixture-testable: accept extra dir/arg paths so tests prove the gate on a violating fixture without touching real code (boundary script usage line 16-18)
- Gate inputs via env + explicit args (parameterized `pg` for DB snapshots — 02-02 raw-SQL-with-explicit-env precedent; hc.io flips via `X-Api-Key`)

`rehearse-cutover.mjs` extends `scripts/rehearse-worker.mjs` (13-step deploy-day rehearsal writing an evidence file) with the D-33 cutover legs; reuse 03-05 machinery (`anonymize-snapshot.mjs`, `stamp-baseline.mjs`, `seed-synthetic.sql`). Stand-in binds localhost (D-45); explicit stand-in env on every command line (REDIS_URL split-brain guard). `scrape-metrics.mjs` polls `http://127.0.0.1:9090/metrics` on an interval into `.snapshots/gates-<timestamp>/` JSON files + markdown summary appended to `05-DEPLOY-RECORD.md`.

---

### Tests (all new/extended)

**Analog conventions:** `tests/worker/scheduler-flag.test.ts` (flag/boot behavior), `tests/worker/health.test.ts` (ephemeral port 0, injectable fakes, never-500 assertions), `tests/worker/queues.test.ts` (real PG+Redis docker stack, numbered pinned cases), `tests/worker/build-gate.test.ts` (gate logic over fixture dirs). Follow: Vitest, injectable seams (`WORKER_TEST_*` env-gated per 04-08), English comments, ids-only logs. Heartbeat tests mock global `fetch` and assert success/`/fail`/never-throws/paused-inert cases.

---

## Shared Patterns

### Dead-man paging (applies to scheduler.ts wiring + rehearsal + runbook)
**Source:** `src/instrumentation.ts:37-52` + RESEARCH Pattern 2. One check = one meaning; exactly one ping per check per tick; `/fail` replaces success on failure ticks; ping URLs never logged; never the product Telegram bot (03 D-16).

### Never-fail-the-surface / additive degradation (applies to health.ts, metrics.ts, outbox.ts collector)
**Source:** `health.ts:196-207` (throwing provider → degrade to missing keys, never 500) and `outbox.ts:690-696` (collector failure → `-1`/nulls). Every new gauge/ping must follow: collection failures are visible, never fatal.

### Worker boundary (applies to ALL new `src/worker/**` code)
**Source:** `scripts/check-worker-boundary.mjs`. No `next/*`, `react*`, or `@/app/*` imports under `src/worker/**` — `pnpm worker:boundary` enforces it. `metrics.ts` must import only `@prometheus-io/client` + sibling worker modules.

### Repo-script style (applies to all 4 new scripts)
**Source:** `scripts/check-worker-boundary.mjs`. Plain ESM, zero deps, header comment block, fail loud + non-zero exit listing violations, fixture-testable arg paths.

### Error handling / logging (applies to all worker edits)
Structured pino (`log.error({ monitorId, err: err.message }, "context")` — scheduler.ts:97-106); err.message only, never secrets/connection strings/ping URLs.

### Deletion-release discipline (applies to instrumentation.ts removal)
`src/instrumentation.ts` is the sole reader of `CRON_MODE` and `HC_PING_URL` (verified by grep). Delete the file + `node-cron`/`@types/node-cron` deps together; `.env.example` removals are reader-set-driven (D-46: `HC_PING_URL` removable, `CRON_SECRET`/`NEXTAUTH_*` stay with dated annotations per D-39/D-40).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| (none) | — | — | Every Phase-5 file has an in-repo analog; the only novel API surface is `@prometheus-io/client` itself (RESEARCH Pattern 3 carries the verified README example; `registry.metrics()` async + `collect()` non-arrow binding are the two 0.16.x gotchas) |

## Metadata

**Analog search scope:** `src/worker/**`, `src/instrumentation.ts`, `src/lib/cron-logic.ts` (due-filter starvation, not modified this phase), `src/lib/db-batcher.ts`, `scripts/`, `tests/worker/`, `.env.example`, `docs/DEPLOY-RUNBOOK.md`
**Files scanned:** ~25 (9 read in full/targeted this session; rest verified by prior research with line citations)
**Pattern extraction date:** 2026-09-15
