---
phase: 05-worker-cutover-operational-hardening
reviewed: 2026-09-19T21:08:33Z
depth: standard
files_reviewed: 25
files_reviewed_list:
  - docs/ARCHITECTURE-AUDIT.md
  - docs/DEPLOY-RUNBOOK.md
  - scripts/check-cron-remnants.mjs
  - scripts/enqueue-maintenance.mjs
  - scripts/gate-cutover.mjs
  - scripts/rehearse-cutover.mjs
  - scripts/scrape-metrics.mjs
  - scripts/seed-synthetic.sql
  - src/worker/db.ts
  - src/worker/health.ts
  - src/worker/index.ts
  - src/worker/metrics.ts
  - src/worker/persist/outbox.ts
  - src/worker/queues.ts
  - src/worker/scheduler.ts
  - tests/api/monitors-id.handler.test.ts
  - tests/worker/cron-remnant-gate.test.ts
  - tests/worker/cutover-gates.test.ts
  - tests/worker/health-metrics.test.ts
  - tests/worker/outbox-age-ping.test.ts
  - tests/worker/outbox-relay.test.ts
  - tests/worker/persist-tier1.test.ts
  - tests/worker/queues.test.ts
  - tests/worker/scheduler-flag.test.ts
  - tests/worker/scheduler-heartbeat.test.ts
findings:
  critical: 0
  warning: 3
  info: 9
  total: 12
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-09-19T21:08:33Z
**Depth:** standard
**Files Reviewed:** 25
**Status:** issues_found

## Summary

Adversarial review of the Phase 5 worker-cutover surface: the worker runtime (boot, db pool, health server, metrics registry, queues, scheduler, outbox relay), the operator tooling (cutover gates, rehearsal, maintenance enqueue, scraper, cron-remnant gate, synthetic seed), ten test suites, and the two phase-touched docs (reviewed via diff against `126b95e`). Cross-module contracts were verified against callers/callees outside the file list (`connection.ts`, `claim.ts`, `maintenance.ts`, `breaker.ts`, `tier2.ts`, `engine/check.ts`).

Overall assessment: the high-stakes machinery is sound. The outbox relay's per-row `FOR UPDATE SKIP LOCKED` claims, dedup-key-before-repeat-send ordering, permanent-vs-transient failure split, and in-transaction 10 s send abort (under the 30 s `idle_in_transaction` cap) check out; queue lane priorities, 3-segment jobIds, `upsertJobScheduler` idempotency, breaker-gated enqueues, and the J-1/TOCTOU dispositions all trace correctly; the seven cutover gates fail closed on every degrade path I could construct (-1 sentinels never satisfy a drain, missing baseline fails gate 4, sub-4 h windows are refused).

Security conclusions: no secrets leak anywhere in the reviewed payloads or logs — evidence blocks carry counts/verdicts/ids only, the hc.io API key is header-only and never echoed, the rehearsal token is a constructed non-secret dummy, and a test explicitly asserts connection strings never appear in `/metrics` output. The unauthenticated `/metrics` on the health server is bound to `127.0.0.1` by default and is an accepted design (T-04-01/T-04-02) — not flagged. SSRF handling is respected: TEST-NET-3 stand-ins exist specifically to stay outside the production denylist, and nothing reviewed bypasses `src/lib/ssrf.ts`. The deletion of `src/instrumentation.ts` is intentional (05-09 deletion release) and not flagged.

What did not hold up: three Warnings. The maintenance enqueue tool hangs forever on an unreachable Redis, directly contradicting its documented fail-loud contract; the relay's private Redis singleton is never closed during graceful shutdown; and the daily maintenance scheduler runs `dryRun: true` forever, which — now that the legacy cleanup cron is deleted and the cron routes sit dormant — means production has no autonomous retention at all. Nine Info items cover edge cases in the health/metrics port and error paths, collector query amplification, the Telegram HTML-escaping surface, gate-tool evidence traps, and documentation/comment inaccuracies.

## Critical Issues

None found. No security vulnerability, data-loss path, or incorrect-behavior blocker was provable in the reviewed files.

## Warnings

### WR-01: enqueue-maintenance.mjs hangs forever on an unreachable Redis, violating its own fail-loud contract

**File:** `scripts/enqueue-maintenance.mjs:155-158` (connection construction), `scripts/enqueue-maintenance.mjs:169-173` (`queue.add`), contract claim at `scripts/enqueue-maintenance.mjs:53-55`
**Issue:** The header states "Fail-loud: exits non-zero on a refused stack, an unreachable Redis, or (with --wait) a job that fails or exceeds its budget." The connection is built with `maxRetriesPerRequest: null` (the BullMQ-required profile) and no command/handshake timeout. Under that setting ioredis never rejects a pending command — if Redis is unreachable (wrong port, container down, firewall), `await queue.add(...)` at line 169 never settles and the script hangs indefinitely with no exit. The `--wait` loop's fail-loud timeout is never reached because execution never gets past the enqueue. The rehearsal calls this with `--wait 300`, so a dead stand-in Redis produces an operator-facing hang rather than the promised non-zero exit.
**Fix:** Bound the enqueue with a deadline and exit non-zero, keeping `maxRetriesPerRequest: null` for BullMQ compatibility:

```js
const ENQUEUE_TIMEOUT_MS = 15_000;
const job = await Promise.race([
  queue.add(MAINTENANCE_JOB_NAME, { dryRun }, { ...MAINTENANCE_JOB_OPTIONS, jobId }),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Redis unreachable: enqueue did not settle within 15 s")), ENQUEUE_TIMEOUT_MS).unref()
  ),
]).catch((error) => fail(`enqueue failed: ${error instanceof Error ? error.message : String(error)}`));
```

(Alternatively set `connectTimeout` plus a one-shot `PING` race before constructing the `Queue`.)

### WR-02: The outbox relay's Redis singleton is never quit during graceful shutdown

**File:** `src/worker/persist/outbox.ts:277-289` (`relayRedis()` singleton), `src/worker/index.ts:177-193` (`drainAndTeardown` call site quits only the main redis + pool + drainables)
**Issue:** `relayRedis()` lazily mints a second ioredis client (cached on `globalThis`; `workerConnection()` returns a NEW client per call, so this is a distinct connection from the worker's main one) the first time a relay pass runs without an injected `deps.redis` — which is exactly the production wiring in `index.ts` (`startAlertsLaneWorker((job) => processRelayJob(job))`). `drainAndTeardown({ quitRedis })` in `index.ts` quits only the main connection; the relay singleton is never registered as a drainable and never quit. Today this is masked by `process.exit(0)` immediately after, but any future change that removes the hard exit (or code between teardown and exit that awaits) leaves a live connection holding the event loop; in tests the only disposal path is the dedicated `disposeRelayRedis` helper. The shutdown contract "drain everything we registered" silently excludes a real connection.
**Fix:** In `src/worker/index.ts` shutdown, quit the relay singleton alongside the main client:

```ts
import { disposeRelayRedis } from "./persist/outbox";
// inside drainAndTeardown, next to the redis quit:
if (options.quitRedis) await disposeRelayRedis().catch(() => {});
```

(or expose `relayRedis()` and register it via `registerDrainable` so the drain loop owns it like every other resource).

### WR-03: Daily maintenance scheduler is pinned to dry-run forever — post-cutover production has no autonomous retention

**File:** `src/worker/scheduler.ts:366-374` (comment "dry-run until its processor lands (04-07)" + `data: { dryRun: true }`), default at `src/worker/maintenance.ts:373` (`data.dryRun !== false`)
**Issue:** The recurring `maintenance-cleanup` scheduler (daily 03:15 UTC) enqueues its job with `dryRun: true` hardcoded, justified by a comment saying this lasts "until its processor lands (04-07)". The processor has landed (Phase 04-07 complete; `processMaintenanceJob` runs real looped deletes when `dryRun: false`), yet the template still pins the dry run — the stated condition is satisfied but the code was never flipped, leaving the comment stale and the behavior permanent. Consequence after the 05-09 deletion release: `src/instrumentation.ts` (which scheduled the legacy daily cleanup) is gone, the surviving `/api/cron/cleanup` route is explicitly dormant ("nothing schedules them anymore" — runbook §9), so nothing anywhere executes real retention deletes. Production `pings` (high-frequency, batched writes every 60 s) and RESOLVED `incidents` grow unboundedly until an operator manually runs `node scripts/enqueue-maintenance.mjs --apply` — and no runbook step establishes that cadence. The legacy system performed daily cleanup; this is a silent behavioral regression in data retention, not just a style issue.
**Fix:** Either flip the scheduler template to the real run now that the processor exists (`data: { dryRun: false }` in `scheduler.ts:374`, updating the comment), or — if operator-manual retention is the deliberate posture until Phase 6 — keep `dryRun: true` but (a) fix the stale comment and (b) add an explicit cadence step to `docs/DEPLOY-RUNBOOK.md` post-cutover standing state (e.g. "run `enqueue-maintenance --apply` weekly; the daily 03:15 slot reports only"). Do not leave both the comment and the retention gap unaddressed.

## Info

### IN-01: Empty-string WORKER_HEALTH_PORT silently binds an ephemeral port

**File:** `src/worker/health.ts:178`, `src/worker/index.ts:88`
**Issue:** `Number(process.env.WORKER_HEALTH_PORT ?? 9090)` — if the var is set to an empty string (common when env plumbing writes `WORKER_HEALTH_PORT=`), `Number("")` is `0` and Node binds an ephemeral port. The worker reports healthy while every scrape to the intended port fails; `scripts/scrape-metrics.mjs:47-49` correctly treats empty as unset (defaults 9090), so the two disagree. A non-numeric value yields `NaN`, which `listen` rejects (fail-loud but with a cryptic error).
**Fix:** Mirror the scraper's truthiness check plus a finite/non-zero guard: `const port = options.port ?? (process.env.WORKER_HEALTH_PORT && Number.isFinite(Number(process.env.WORKER_HEALTH_PORT)) && Number(process.env.WORKER_HEALTH_PORT) > 0 ? Number(process.env.WORKER_HEALTH_PORT) : 9090);` — or validate in `assertRequiredEnv` and exit loudly.

### IN-02: /metrics can still 500 if registry serialization itself throws

**File:** `src/worker/health.ts:229-252`
**Issue:** Collector failures degrade to absent samples inside `createMetricsRegistry` (good), but the `/metrics` handler awaits `metricsRegistry.metrics()`; if that promise rejects (registry-level serialization error), the outer catch returns 500 — contradicting the metrics module's "never a failed scrape" commentary. `scripts/scrape-metrics.mjs` then counts consecutive failures and aborts the evidence run (fail-loud downstream, so not silent, but the endpoint contract is softer than documented).
**Fix:** Wrap the exposition render and serve the last-good or an empty exposition with a `# scrape-degraded` comment and 200, reserving 503 only for the deliberately-unready case.

### IN-03: Metrics collectors re-query the same sources once per gauge per scrape

**File:** `src/worker/metrics.ts:47-165`
**Issue:** Three gauges each call `collectQueueMetrics(deps.queues)` and four gauges each call `collectOutboxMetrics()` — roughly 3 queue snapshots and 12 SQL round-trips (outbox collector = 3 queries) per `/metrics` or `/metrics.json` scrape, plus the same again for each. Performance itself is out of v1 scope, but this also multiplies the transient-failure surface (each independent query can independently degrade a different gauge within one scrape, producing mutually inconsistent samples the gate tool then parses).
**Fix:** Take one snapshot per collect cycle and share it across the gauges (a memoized `getSnapshot()` invalidated by `reset()`/`remove()`), so a scrape observes a coherent instant.

### IN-04: Monitor name/url are interpolated unescaped into parse_mode "HTML" Telegram messages

**File:** `src/worker/persist/outbox.ts:134-173` (`renderAlertMessage`)
**Issue:** `monitorName`/`monitorUrl` are user-controlled strings interpolated raw into HTML-mode messages. A name containing `<`/`&` either corrupts rendering or triggers Telegram 400 "can't parse entities", which `isPermanentTelegramFailure` classifies as permanent → the row is dead-lettered after one attempt and the alert is lost until a manual re-drive. This is deliberate D-48 byte-parity with the legacy template (fixing it would change alert bytes), so not a Warning — but it should be on Phase 6's hardening list alongside the route rewrite.
**Fix:** In Phase 6, HTML-escape interpolations (`&`, `<`, `>`) in both the worker template and the legacy one in the same change, or switch the send to non-HTML parse mode on both sides simultaneously.

### IN-05: Cutover-gate evidence edges — cache-over-live precedence, lexicographic sample sort, null interval

**File:** `scripts/gate-cutover.mjs:219-243` (flips cache precedence), `scripts/gate-cutover.mjs:286` (`.sort()`), `scripts/gate-cutover.mjs:459,465` (`Number(row.interval_seconds) * 60`)
**Issue:** Three small traps in a safety-critical tool: (1) a stale `flips-heartbeat.json` in the snapshot dir silently overrides the live hc.io fetch — re-running the gates over a NEW window with an old cache file present yields "zero down-flips in window" and a gate-1 PASS built on stale evidence; (2) sample files are sorted lexicographically, so `sample-10.txt` orders before `sample-2.txt` (only affects log ordering/first-last bookkeeping, not the verdicts, since age violations are checked per-sample); (3) a monitor with NULL `interval` produces `intervalSeconds: 0`, making the `age > interval + 120s` continuity bound trivially violated — a false gate-5 reason pointing at a data anomaly rather than a monitoring gap.
**Fix:** (1) When live mode is possible, prefer the fetch and treat the cache as fallback (or stamp/invalidate the cache per window and warn when reused); (2) sort with a numeric collator on the sample index; (3) guard `interval_seconds IS NULL` rows into an explicit "unmeasurable (null interval)" reason class instead of a fake 0.

### IN-06: Cron-remnant gate counts CRON_MODE inside comments while import checks skip comments; package.json scanned per-target-root only

**File:** `scripts/check-cron-remnants.mjs:93,129` (comment skip for imports), `scripts/check-cron-remnants.mjs:136` (token count over full content), `scripts/check-cron-remnants.mjs:49,154` (package.json handling)
**Issue:** Check 2 (node-cron imports) skips comment lines; check 3 (CRON_MODE token) counts matches in the FULL file including comments. A file whose only CRON_MODE reference is in a commented-out line fails the gate while an equivalent commented-out `import cron` passes. Arguably intentional (the env token is more dangerous in any form), but the asymmetry is undocumented and will confuse the next editor. Also the dependency check reads `<target>/package.json` per target root — fine for the repo layout, worth a comment that nested workspaces would escape it.
**Fix:** Either apply the comment skip uniformly or add one line to the header comment stating the asymmetry is deliberate ("the CRON_MODE token is flagged even in comments; import specifiers are not").

### IN-07: rehearse-cutover --minutes accepts NaN

**File:** `scripts/rehearse-cutover.mjs:1930-1932`
**Issue:** `args.minutes = Number(argv[++i])` with no validation — `--minutes` with a missing/non-numeric value yields NaN; `--leg corun --minutes` then runs a zero-iteration window loop and fails later on `sampleCount < minSamples` (`Math.max(1, Math.floor(NaN) - 3)` → `NaN` comparison → `1 < NaN` is false, so it can actually PASS the sample check with 1 sample and an empty window). The failure is loud downstream but misleading, and the NaN comparison can wrongly pass.
**Fix:** Validate after parsing: `if (!Number.isFinite(args.minutes) || args.minutes <= 0) fail("--minutes must be a positive number", ...)`.

### IN-08: seed-synthetic.sql comment claims a dedup key is written on the no-chat path; the relay does not write one

**File:** `scripts/seed-synthetic.sql:5-11` (comment), `src/worker/persist/outbox.ts:505-522` (`no_chat_skipped` branch)
**Issue:** The seed header says an UP smoke check "resolves to the no-chat skip path (alert dedup key written, the relay path exercised end-to-end)". In `processRelayJob`, the `no_chat_skipped` branch executes `markSentSql` and returns WITHOUT writing the Redis dedup key (dedup keys are only written after a confirmed send). Functionally harmless — the row is marked sent and never revisited — but the comment asserts behavior the code does not have, which matters because the dedup-key write is the D-47 double-send guard being "exercised".
**Fix:** Correct the comment to "the relay claim/mark-sent path exercised end-to-end; no dedup key is written on the no-chat skip (it guards confirmed sends only)".

### IN-09: monitors-id characterization test deliberately pins the PATCH/DELETE bare-return defect

**File:** `tests/api/monitors-id.handler.test.ts:117-131, 208-218`
**Issue:** The suite pins that PATCH and DELETE handlers `return;` bare (resolving `undefined`) on validation failure instead of returning a `NextResponse`, producing a runtime 500 in the real route. This is documented as an intentional characterization for the Phase 6 route rewrite, and the route file itself is outside this review's scope — recorded here so the defect is visible in the phase review trail and Phase 6 actually fixes it rather than inheriting the pin.
**Fix:** Phase 6: change the handlers to `return NextResponse.json({ error: "..." }, { status: 400 })` and update the pinned expectations from `undefined` to the real 400 responses in the same change.

---

_Reviewed: 2026-09-19T21:08:33Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
