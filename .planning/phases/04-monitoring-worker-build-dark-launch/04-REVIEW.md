---
phase: 04-monitoring-worker-build-dark-launch
reviewed: 2026-09-15T00:15:00Z
depth: standard
files_reviewed: 52
files_reviewed_list:
  - src/worker/index.ts
  - src/worker/queues.ts
  - src/worker/engine/check.ts
  - src/worker/claim.ts
  - src/worker/persist/tier1.ts
  - src/worker/persist/tier2.ts
  - src/worker/persist/outbox.ts
  - src/worker/breaker.ts
  - src/worker/locks.ts
  - src/worker/scheduler.ts
  - src/worker/backlog.ts
  - src/worker/health.ts
  - src/worker/db.ts
  - src/worker/maintenance.ts
  - src/worker/logger.ts
  - src/lib/ssrf.ts
  - scripts/check-denylist-diff.mjs
  - scripts/check-worker-boundary.mjs
  - scripts/enqueue-smoke.mjs
  - scripts/redrive-outbox.mjs
  - scripts/rehearse-worker.mjs
  - scripts/seed-synthetic.sql
  - docs/DEPLOY-RUNBOOK.md
  - docs/ARCHITECTURE-AUDIT.md
  - tests/worker/claim.test.ts
  - tests/worker/queues.test.ts
  - tests/worker/persist-tier1.test.ts
  - tests/worker/persist-tier2.test.ts
  - tests/worker/engine-check.test.ts
  - tests/worker/outbox-relay.test.ts
  - tests/worker/retries.test.ts
  - tests/worker/build-gate.test.ts
  - tests/lib/helpers/check-target-server.ts
  - tests/lib/ssrf.test.ts
  - tests/resilience/backlog-flood.test.ts
  - tests/resilience/duplicate-delivery.test.ts
  - tests/resilience/helpers/worker-process.ts
  - tests/resilience/kill-mid-job.test.ts
  - tests/resilience/lock-loss.test.ts
  - tests/resilience/observations.json
  - tests/resilience/postgres-down.test.ts
  - tests/resilience/redis-down.test.ts
  - tests/resilience/redis-restart.test.ts
  - tests/staleness-display.test.ts
  - tests/worker/breaker.test.ts
  - tests/worker/health.test.ts
  - tests/worker/locks.test.ts
  - tests/worker/logger.test.ts
  - tests/worker/maintenance.test.ts
  - tests/worker/scheduler-flag.test.ts
  - tests/worker/shutdown.test.ts
  - tests/worker/uptime-parity.test.ts
findings:
  critical: 0
  warning: 5
  info: 3
  total: 8
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-09-15T00:15:00Z
**Depth:** standard
**Files Reviewed:** 52
**Status:** issues_found

## Summary

Reviewed the complete Phase 4 monitoring-worker deliverable at standard depth: the worker engine and persistence tiers (claim CTE, Tier-1 transition transaction, Tier-2 Redis staging/flush, outbox relay), queue topology and lane priorities, Postgres circuit breaker, per-monitor locks, scheduler/tick, backlog cap, health surface, maintenance lane, the SSRF check pipeline (`src/lib/ssrf.ts`), the six operator scripts, the deploy runbook and architecture audit, and all 28 test files (unit + resilience injection suite). Cross-references were checked against `docs/ARCHITECTURE-AUDIT.md` (§14, §15, §16) and `docs/DEPLOY-RUNBOOK.md` (§4/§4a/§5/§6a/§10).

Overall assessment: this is an unusually rigorous implementation. Exactly-once transitions are proven live (kill-mid-job, duplicate-delivery, lock-loss injections drive the real bundle against real Postgres/Redis), the uptime_percent derivation is pinned to byte parity with the legacy JS rendering across tie cases, the SSRF pipeline layers scheme/resolve/pin/redirect/cap defenses with real fixture servers, and no hardcoded secrets, injection surfaces, or authentication gaps exist in the reviewed worker code (health server is loopback-only and provenance-only; logs are ids-only; the denylist is machine-checked against the runbook).

No Critical findings. Five Warnings, two of which are contradictions of the reviewed audit's stated posture (the missing scheduler-tick heartbeat and the claim-rollback deviation), one TOCTOU race in the enqueue gate, one missing network timeout that stalls the alert relay under a Telegram black-hole, and one latent naive-timestamp clock-domain hazard. Three Info items cover a seed/doc contradiction, over-broad CIDR shape heuristics in the drift gate, and an unlocked context read that can mislabel one outbox event during the legacy-cron overlap window.

## Warnings

### WR-01: Worker scheduler tick omits the healthchecks.io heartbeat (audit §14.2 step 5 / R-1)

**File:** `src/worker/scheduler.ts:81-113`
**Issue:** Audit §14.2 step 5 (`docs/ARCHITECTURE-AUDIT.md:733`) requires: "On tick completion, ping healthchecks.io (`HC_PING_URL`); on any exception caught in steps 2–4, ping `HC_PING_URL/fail` before surfacing the error." The audit's failure-mode table (lines 775–777) additionally requires `/fail` pings on enqueue rejection and on claim-transaction failure, and line 587 names the tick heartbeat "the *only* independent detection of the pause … it must keep firing when the failure is Redis itself." Grep confirms `HC_PING_URL` appears only in the legacy web cron (`src/instrumentation.ts:39-49`) and nowhere under `src/worker/` — `processTick` neither pings on completion nor `/fail`s on exceptions. The runbook also depends on it: §5 (line 345) states "The worker's heartbeat to healthchecks.io fires from the scheduler tick (R-1)," and §4a step 3's cutover verification (line 315) asserts the heartbeat is "now fired from the worker scheduler tick." During the Phase 4 dark launch the legacy cron still covers it, but the Phase 5 cutover release deletes `instrumentation.ts` — at that point the dead-man's switch goes silent, healthchecks.io pages, and the worker loses its only independent pause-detection signal.
**Fix:** Add the heartbeat to `processTick` in `src/worker/scheduler.ts`:

```ts
async function heartbeat(fail: boolean): Promise<void> {
  const base = process.env.HC_PING_URL;
  if (!base) return;
  try {
    await fetch(fail ? `${base}/fail` : base); // audit line 777: never rethrow
  } catch { /* heartbeat errors must never fail the tick */ }
}

// at the end of processTick, before return: await heartbeat(result.failed > 0 ? false : false) — see note
// simplest conforming form:
//   success path (tick completed): heartbeat(false)
//   catch around steps 2-4: heartbeat(true) before rethrow/logging
```

Land it before the Phase 5 cutover release at the latest; ideally now, since §14.2 is the Phase 4 spec.

### WR-02: TOCTOU between the two breaker gates routes `BreakerOpenError` into the J-1 rollback

**File:** `src/worker/queues.ts:282-288` (outer gate), `src/worker/queues.ts:219-225` (inner gate in `addCheckJob`), `src/worker/queues.ts:298-321` (catch → rollback → rethrow)
**Issue:** `enqueueClaimedCheck` checks `canEnqueue()` at line 282 and documents the contract inline (lines 278–281): "a refusal is a SKIP, not a failed enqueue — deliberately NO J-1 rollback (§14.4 posture: claims stay advanced … a rollback storm against a dead database would only add write pressure)." But `addCheckJob` re-checks `canEnqueue()` internally (line 219) and throws `BreakerOpenError` (line 224). Between the two checks the code performs the backlog gate (a Redis depth read plus an active-monitor count), so if the 5th consecutive infra failure lands in that window — from any lane, any worker in the process — the `BreakerOpenError` thrown by the inner gate is caught at line 300 and `rollbackFailedClaim` executes at line 310, violating the code's own stated §14.4 posture (writes against a dying database, claims rolled back during OPEN) and bypassing the `breakerGated: true` skip return at line 287.
**Fix:** Distinguish refusal from failure in the catch:

```ts
try {
  await addCheckJob(queue, row.id, { priority, jobId });
} catch (err) {
  if (err instanceof BreakerOpenError) {
    // gate tripped between the outer check and add() — still a SKIP (§14.4)
    return { jobId, priority, dropped: true, breakerGated: true };
  }
  log.error(/* … */);
  try { await rollbackFailedClaim(row.id); } catch { /* … */ }
  throw err;
}
```

### WR-03: `rollbackFailedClaim` contradicts the audit's accepted J-1 disposition ("leave claims advanced")

**File:** `src/worker/queues.ts:238-244` (helper), `src/worker/queues.ts:300-321` (call site); pinned as intended behavior in `tests/worker/queues.test.ts`
**Issue:** The audit's failure-mode table (`docs/ARCHITECTURE-AUDIT.md:775`) is explicit for the Redis-down-mid-batch case: "stop enqueuing; ping `HC_PING_URL/fail`; **leave claims advanced** (one missed check per un-enqueued monitor — the accepted J-1 consequence); next tick re-claims each monitor when due." The implementation instead rolls `next_check_at` back one interval on every `add()` rejection. Consequences: (a) under a sustained Redis outage with Postgres up, every 30 s tick claims the due monitors, fails each enqueue, and issues one rollback UPDATE per monitor — a per-tick claim/rollback churn loop that runs for the whole outage and never lets claims advance past it; (b) each rolled-back monitor is re-claimed by the very next tick rather than missing one check per interval as the reviewed design accepts; (c) the deviation is enshrined by a test pin, so the audit and the code now disagree about what J-1 means. Note the interplay with WR-02: the rollback path is also the wrong handler for breaker refusals.
**Fix:** Either restore the audited behavior (drop the rollback; log the missed check and let the next tick re-claim at the advanced slot — this also removes the WR-02 special case) or, if the rollback is genuinely wanted, amend audit §14.3/§14.4 (`docs/ARCHITECTURE-AUDIT.md:775`) in the same change and document why the churn loop under Redis outage is acceptable. Do not leave the two statements in conflict.

### WR-04: `telegramSend` has no timeout while the relay holds the row's FOR UPDATE transaction across the send

**File:** `src/worker/persist/outbox.ts:223-246` (fetch without signal), `src/worker/persist/outbox.ts:451-574` (per-row transaction; send awaited at line 520), `src/worker/db.ts:36` (`idle_in_transaction_session_timeout: 30000`)
**Issue:** The per-row relay transaction opens at line 451, claims the outbox row FOR UPDATE (line 452), and awaits the Telegram send inside the transaction (line 520). `telegramSend`'s `fetch` (lines 228–239) passes no `AbortSignal`, so a black-holed connection to `api.telegram.org` hangs on undici's default ~300 s headers/body timeout. The worker pool pins `idle_in_transaction_session_timeout: 30000` (`db.ts:36`), so after 30 s Postgres kills the session mid-transaction; when the send eventually resolves, `markSentSql`/`markFailureSql` throws, the whole relay pass fails, and BullMQ backoff retries the pass — which re-claims the same row and hangs again. While Telegram black-holes, the relay stalls indefinitely and `attempts` never advances (every failure transaction rolls back). The dedup-key-before-markSent ordering (lines 571–572) does prevent a double-send on the late-success path, so this is delay/robustness, not alert loss — but the stall is unbounded and invisible to the attempts accounting.
**Fix:** Bound the exchange:

```ts
const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ /* unchanged */ }),
  signal: AbortSignal.timeout(10_000), // transient on timeout — already handled at lines 521-539
});
```

### WR-05: Naive-timestamp clock domains are mixed across Tier 1, Tier 2, and maintenance

**File:** `src/worker/persist/tier1.ts:125` (evidence ping `now()`), `src/worker/persist/tier1.ts:153` (`"lastChecked" = now()`), `src/worker/persist/tier2.ts:202-204` (`formatPgTimestamp` — UTC wall-clock), `src/worker/maintenance.ts:167,179,189` (`now() AT TIME ZONE 'utc'` horizons)
**Issue:** `pings."createdAt"` and `monitors."lastChecked"` are `timestamp(3)` without time zone (audit A6). Tier 1 writes them with session-timezone `now()`; Tier 2 writes UTC wall-clock strings (`toISOString()`-derived); maintenance's retention horizon compares against `now() AT TIME ZONE 'utc'`. If any deploy topology's Postgres session TimeZone is not UTC, Tier-1-written rows land offset from Tier-2-written rows in the same columns: retention deletes shift by the tz offset (deleting up to N hours early or late), and Tier 2's `GREATEST("lastChecked", …)` merge misorders values coming from the two writer paths. Current stand-ins run UTC, so nothing observes the defect today — it is a latent deploy-topology hazard, not an active bug. (Scheduling columns are self-consistent: claim, Tier-1 advance, and the D-49 re-seed all use session `now()`.)
**Fix:** Pin one clock domain. Cheapest: force UTC on the worker pool —

```ts
// src/worker/db.ts — workerPgPool options
new Pool({ /* existing */, options: "-c timezone=UTC" });
```

— or switch Tier 1's three statements to `(now() AT TIME ZONE 'utc')` so all paths share Tier 2's convention.

## Info

### IN-01: Synthetic smoke seed's `UNKNOWN` status contradicts the seed header's "relay path stays exercised" claim

**File:** `scripts/seed-synthetic.sql:48` (status `'UNKNOWN'`), `src/worker/persist/tier1.ts:295-300` (`deriveEventType`)
**Issue:** `deriveEventType` returns no event for UP-from-UNKNOWN (the legacy-parity branch), so a successful (UP) smoke check against the seeded monitor produces zero outbox rows and zero dedup keys. The seed header (lines 5–7) claims any outbox row its checks produce takes the no-chat skip path so "the relay path itself stays exercised end-to-end" — that only holds when `example.com` is DOWN. Seeding `'PENDING'` instead would derive `monitor.first_check` on the first UP smoke and genuinely exercise outbox → relay → no-chat skip → dedup-key write (still never paging a human).
**Fix:** Seed `status 'PENDING'` (line 48), or correct the header comment to say the relay path is exercised only on a DOWN smoke.

### IN-02: Denylist-diff CIDR shape heuristics admit time-shaped and invalid-prefix tokens

**File:** `scripts/check-denylist-diff.mjs:55-61`
**Issue:** `V6_SHAPE` (`/^[0-9a-fA-F:]*:[0-9a-fA-F:]*$/` applied to the prefix-stripped body) matches any hex-and-colon token — a backticked wall-clock time like `` `03:15` `` in future runbook §10 prose would enter the set comparison and fail `pnpm verify` as phantom "only in runbook" drift. `V4_SHAPE`'s `\/\d{1,2}` accepts invalid prefixes (e.g. `/99`). Latent only: no such token exists in §10 today and the gate is green.
**Fix:** Require the prefix for the v6 branch (all five v6 tokens carry one) and bound prefix range, e.g.:

```js
const V6_PREFIX = /^[0-9a-fA-F:]*:[0-9a-fA-F:]*\/(12[0-8]|1[01]\d|\d{1,2})$/;
```

### IN-03: Unlocked context read can derive the wrong event type under the legacy-cron overlap window

**File:** `src/worker/persist/tier1.ts:204-216` (`monitorContextSql` — plain SELECT), `src/worker/persist/tier1.ts:329-354`
**Issue:** `applyTransition` reads `prev_status` without a row lock, then gates the incident/outbox work on the conditional UPDATE. A concurrent status flip between the read and the UPDATE can make the derived event disagree with the actual transition — e.g. `prev_status` read as `PENDING` while the row was concurrently flipped to `DOWN` yields `monitor.first_check` instead of `incident.recovered`, producing a differently-keyed dedup key and a mislabeled alert. Worker-vs-worker is serialized by the per-monitor Redis lock, but the legacy cron path (live for the entire M3 dark-launch overlap, and again during any future overlap) takes no such lock, so the window is practically reachable during Phase 4–5. Counters and incidents stay consistent (partial unique + conditional UPDATE); only the event label can drift, in a milliseconds-wide window.
**Fix:** Lock the row for the transaction's duration — the row is updated in this same transaction anyway:

```ts
SELECT m.status AS prev_status, /* … */ , now() AS occurred_at
  FROM monitors m JOIN users u ON u.id = m."userId"
 WHERE m.id = ${monitorId}
   FOR UPDATE OF m
```

---

Considered and deliberately not flagged: the D-36 power-of-two uptime derivation (pinned byte-parity, load-bearing); the NULL-`lastChecked` responseTime asymmetry (legacy-shaped); the per-tick cached backlog verdict (fail-open by design, documented); epoch-seconds claimed jobIds (BullMQ contract honored); the smoke script's count-delta race (benign, operator-facing); `Queue.pause()` absence vs. audit line 658 (superseded by Pattern 6/D-33, consistently documented); epoch-zero COALESCE improvements over the audit literal.

_Reviewed: 2026-09-15T00:15:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
