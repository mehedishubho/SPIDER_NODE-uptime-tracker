---
phase: 06-thin-api-routes-email-abstraction (gap closure: 06-06 + 06-07)
reviewed: 2026-10-01T12:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/app/api/monitors/[id]/check/route.ts
  - src/lib/queue-producer.ts
  - src/lib/email/enqueue.ts
  - src/worker/engine/check.ts
  - tests/api/check-route.handler.test.ts
  - tests/lib/queue-producer-deadline.test.ts
  - tests/worker/engine-check.test.ts
  - scripts/probe-telegram-webhook-ladder.mjs
  - docs/DEPLOY-RUNBOOK.md
findings:
  critical: 1
  warning: 1
  info: 1
  total: 3
status: issues_found
---

# Phase 06 Gap Closure: Code Review Report (06-06 + 06-07)

**Reviewed:** 2026-10-01T12:00:00Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Reviewed the 9-file surface of the two gap-closure plans: 06-06 (enqueue-failure
compensating restore via a prior-capturing CTE + the 3s `withProducerDeadline`
producer backstop) and 06-07 (in-job manual non-transition persist via
`monitorFlushUpdateSql` + the Telegram webhook ladder probe + runbook §9
amendment). All 9 files were read in full and every load-bearing claim was
traced into the modules they depend on (`src/db/schema.ts`, `src/worker/claim.ts`,
`src/worker/persist/tier1.ts`, `src/worker/persist/tier2.ts`,
`src/worker/queues.ts`, `src/lib/rate-limit.ts`, the webhook route, and the
installed `pg-types`/`postgres-date` driver packages).

**The headline finding is CR-01: the 06-06 compensating restore is provably
inert against real production data.** The restore's equality guard compares a
microsecond-precision `timestamptz` column against a JavaScript `Date`
parameter that node-postgres truncates to milliseconds — so the guard matches
zero rows on virtually every real invocation, the monitor stays silently
postponed by one interval per failed enqueue (compounding via GREATEST across
503-invited retries — the exact failure 06-06 gap 1 exists to prevent), and the
log line misattributes the miss to a concurrent writer. The unit tests
structurally cannot catch this: they mock `db.execute` with exact-second fixture
Dates, bypassing the driver's type parsing entirely.

Everything else reviewed is sound. Specifically verified against the
coordinator's focus areas:

- **Restore failure paths (other than CR-01):** the WHERE-restated ownership +
  advanced-value guard is the right shape against concurrent-writer clobber;
  a restore that throws is logged with its own marker and the 503 still
  answers (no double-advance, no crash). The advance's `FOR UPDATE` on the CTE
  SELECT mirrors the proven `claim.ts` pattern. The `SET`-side ms truncation is
  folded into CR-01's fix.
- **Deadline vs BullMQ retries:** a timed-out enqueue CAN still apply later
  (deadline fires -> 503 -> the in-flight `add()` completes when Redis
  recovers). This is explicitly documented and accepted (route.ts:150-155), and
  the bounds hold up: `manualCheckJobId` is monotonic-unique per process
  (queues.ts:180-183), tier1's transition owns the schedule-slot write on
  transitions, and a late non-transition job persists counters once for a check
  that genuinely ran. Timer hygiene is correct — `clearTimeout` in `finally`,
  and `Promise.race` attaches handlers to the losing promise, so a late
  rejection of the underlying `add()` is absorbed (no `unhandledRejection`
  crash). No finding.
- **In-job manual persist guards:** `monitorFlushUpdateSql` structurally writes
  only `totalChecks`/`failedChecks`/`uptimePercent`/`lastChecked`/
  `responseTime` — never `status`, never `next_check_at`, never
  `consecutive_failures`. No double-count within a delivery: the follow-up runs
  only when `manual && !result.applied`, and applyTransition advances counters
  only on `applied:true` — mutually exclusive. Redelivery re-runs both halves
  symmetrically (documented at-least-once). One comment-vs-behavior mismatch on
  the deactivated-monitor race is WR-01.
- **Probe secret handling:** clean. The script never reads
  `TELEGRAM_WEBHOOK_SECRET`; the only header value ever sent is the 8-char
  `deadbeef` constant (deliberately wrong-length, refusal-only); output is HTTP
  status codes, origin, and mode only; nothing is written to disk. The
  `--baseline` expectation (500/500/429) matches the real webhook route's
  ordering — the per-IP limiter (webhook route.ts:53-58) runs BEFORE
  `secretMatches` (line 61), so baseline-mode flood requests consume limiter
  entries and 429 arrives within the 35-request cap (2 legs + 29th flood
  request). No finding.
- **Runbook §9 amendment (line 613):** accurate — the G-06-7 lesson, the probe
  as the standing re-verification instrument, and the secret-hygiene restatement
  all match the code and the probe's actual behavior.
- **Producer/deadline module:** the bounded profile (3s deadline > 1s connect +
  1s command), the pinned `ProducerDeadlineError` name, the listener-once
  guard against HMR duplicate stacking, and the idempotent `close()` teardown
  are all coherent. `enqueueTransactionalEmail`'s deadline wrap and the
  `LANE_PRIORITY.email` / custom-backoff pairing with the worker's registered
  `emailBackoffDelay` table check out.

## Critical Issues

### CR-01: Compensating restore's equality guard can never match real `next_check_at` values — the restore is inert in production and every enqueue failure silently postpones the monitor

**File:** `src/app/api/monitors/[id]/check/route.ts:114` (RETURNING), `route.ts:116-125` (lossy destructure), `route.ts:182-189` (restore)

**Issue:** The 06-06 gap-1 compensation dead-loops on driver type precision:

1. `next_check_at` is `timestamptz` (`src/db/schema.ts:96`, `withTimezone: true`).
2. The advance anchors on `now()` (`route.ts:108-111`), which carries
   **microsecond** precision; `GREATEST(now() + interval, prior + interval)`
   preserves it. Essentially every real advanced value has non-zero µs.
3. The RETURNING values reach the route as JavaScript `Date`s — node-postgres
   parses `timestamptz` through `postgres-date`, which computes
   `ms = 1000 * parseFloat(fraction)` (postgres-date 1.0.7, index.js:32-33):
   the µs component is **irrecoverably dropped** (`.123456` becomes a `Date`
   with `.123`).
4. The restore passes those `Date`s back as parameters (route.ts:184, 187).
   node-postgres serializes `Date` at millisecond precision, so the guard
   `WHERE next_check_at = ${advancedNextCheckAt}` compares the stored
   `10:05:00.123456+06` against `10:05:00.123+06` — **never equal** — and the
   UPDATE matches zero rows on every real invocation.
5. The zero-row branch (route.ts:195-199) then logs "a concurrent writer moved
   the row; their value stands" — a false attribution. In reality no one else
   touched the row: the route's own parameter truncation defeated the guard.

Consequence: exactly when Redis is unreachable (the incident this compensation
was built for), the advanced `next_check_at` is left standing, postponing the
monitor's next scheduled check by one interval **per failed attempt**,
compounding through the GREATEST form across 503-invoked retries — the precise
failure mode route.ts:157-162 documents as unacceptable. Even in the ~0.1% of
cases where the guard would match (µs component `000`), the `SET` writes a
ms-truncated `prior` — a secondary distortion the same fix removes.

The unit suite passes only because it mocks `db.execute` with exact-second
fixture Dates (`tests/api/check-route.handler.test.ts:76-77, 304-333`),
bypassing the driver's parsing entirely; no integration test exercises the
advance+restore round trip against real Postgres.

**Fix:** Capture the two timestamps at full precision as text in the advance's
RETURNING, and pass the strings back into the restore. Postgres's `::text`
rendering of `timestamptz` carries µs + offset, and a string parameter cast
back to `timestamptz` is lossless:

```sql
-- Advance (route.ts:98-115) — return full-precision text, not driver Dates:
RETURNING m.id,
          prior.next_check_at::text AS prior_next_check_at,
          m.next_check_at::text     AS advanced_next_check_at
```

```ts
// route.ts:116-125 — types become string; priorLabel simplifies to the string itself.
const claimedRows = advanced.rows as Array<{
    id: number;
    prior_next_check_at: string;
    advanced_next_check_at: string;
}>;
```

```sql
-- Restore (route.ts:182-189) — explicit cast keeps the guard exact:
UPDATE monitors
   SET next_check_at = ${priorNextCheckAt}::timestamptz
 WHERE id = ${monitorId}
   AND "userId" = ${session.user.id}
   AND next_check_at = ${advancedNextCheckAt}::timestamptz
RETURNING id
```

Also add an integration test (the engine suite's real-docker pattern) that runs
the advance, forces an enqueue failure, executes the restore against real
Postgres with a `now()`-anchored (µs-bearing) value, and asserts the restore
returns 1 row and `next_check_at` equals the captured prior. The existing
mocked suite remains valuable for ordering/shape but cannot prove this fix.

## Warnings

### WR-01: Manual-follow-up comment claims the "deactivated race" is a benign no-op, but the persist actually writes to a paused monitor

**File:** `src/worker/engine/check.ts:317-333` (comment + guard), with `src/worker/persist/tier1.ts:201-202, 347` and `src/worker/persist/tier2.ts:437`

**Issue:** The 06-07 comment states: "Zero returned rows (the monitor vanished
mid-job, or the deactivated race) is the documented benign §16.2 no-op ...
do not branch on which cause fired (IN-04)." That is true only for the
vanished-monitor cause. For the deactivated race the behavior is different:

- tier1's transition guard includes `AND "isActive"` (tier1.ts:201-202), so a
  monitor deactivated between the engine's row load and `applyTransition`
  yields `applied:false` — while statement 1 has already committed an
  unconditional evidence ping (tier1.ts:347).
- The manual follow-up then runs `monitorFlushUpdateSql`, whose WHERE is
  `WHERE id = ${monitorId}` only (tier2.ts:437) — no `isActive` predicate — so
  it **writes** `totalChecks`/`failedChecks`/`uptimePercent`/`lastChecked`/
  `responseTime` on the now-paused monitor.

The write is small and arguably harmless (the user did request the check while
the monitor was active; the paused monitor is unscheduled so nothing reads the
stale schedule), but the guard's own documentation misdescribes its behavior on
a correctness-sensitive path, and no test pins the deactivated-manual
combination (the suite covers vanished and active cases only).

**Fix:** Either (a) correct the comment to state the two causes honestly —
vanished = no-op, deactivated = counters/stamp still written by design — or
(b) make the behavior match the comment, e.g. thread an opt-in
`requireActive` guard into `monitorFlushUpdateSql` (it is shared with Tier-2
flushes, so gate it per-call, not globally) and pass `true` from the manual
follow-up. Either way, add a test that deactivates the monitor at the
`beforeReverify` checkpoint seam with a manual job and pins which behavior is
intended.

## Info

### IN-01: Route-test parameter extractor couples to drizzle internals; the mocked `db.execute` seam cannot prove driver-precision behavior

**File:** `tests/api/check-route.handler.test.ts:86-96`

**Issue:** `paramValues` inspects `statement.queryChunks` and filters by
`chunk.constructor?.name === "StringChunk"` — a private drizzle-orm shape. Any
drizzle upgrade that renames or restructures chunk classes turns every
parameter assertion into a failed `toContain` (loud, so the failure mode is
acceptable), but the helper will need maintenance at each drizzle bump. More
importantly, the suite's `h.db.execute` mock means the advance/restore contract
is only ever tested with hand-built fixture values — this is exactly the blind
spot that let CR-01 ship green. The helper's own comment ("probe-verified chunk
types") shows the fragility was known.

**Fix:** Keep the helper but add a version-pinned integration test for the
advance+restore round trip (see CR-01's fix), and consider asserting on the
SQL text alongside chunk values so a chunk-model change degrades to a
diagnosable mismatch rather than a silent pass on unrelated params.

---

_Reviewed: 2026-10-01T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
