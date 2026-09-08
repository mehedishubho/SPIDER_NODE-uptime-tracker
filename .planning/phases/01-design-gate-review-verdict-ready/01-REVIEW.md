---
phase: 01-design-gate-review-verdict-ready
reviewed: 2026-09-08T21:14:48Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - docs/ARCHITECTURE-AUDIT.md
  - docs/DEPLOY-RUNBOOK.md
findings:
  critical: 3
  warning: 8
  info: 5
  total: 16
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-09-08T21:14:48Z
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

This is a design-gate phase: the deliverables under review are engineering documents (the amended `ARCHITECTURE-AUDIT.md` and the new `DEPLOY-RUNBOOK.md`), so they were reviewed as specifications — internal consistency, SQL/DDL correctness, cross-document agreement, and completeness of the "literal SQL a Phase 4 implementer transcribes without interpretation" contract — rather than as executable code.

**What holds up well (verified, not assumed):**

- Every code citation I spot-checked against the repository is accurate: `db-batcher.ts` flush-drops batches (lines 108–112), `api/cron/check/route.ts` leaks `err.stack` (lines 44–47) and flushes inline (lines 34–37), `cron-logic.ts` alerts before persisting (lines 100–135), persists non-transactionally (lines 165–205), and runs cleanup every tick (lines 212–217), `deploy.yml:74` runs `prisma db push --accept-data-loss`, `telegram.ts` has no fetch timeout, `reset-password` silently sets `emailVerified`, `schema.prisma` has exactly 9 models, and the referenced `ARCHITECTURE-REVIEW.md` / `UPGRADE_PLAN.md` / `ADVANCED_MONITORING_PLAN.md` all exist. All "resolves X-n" amendment markers map to real issue IDs in ARCHITECTURE-REVIEW.md.
- The §14.3 claim transaction, the §11 partial unique index + `ON CONFLICT (monitor_id) WHERE status = 'ONGOING'` inference, and the §16.2 `GREATEST`-ignores-NULL semantics are all technically correct and well-cited.

**Where it fails:** the two-tier persistence design contains two data-integrity specification bugs (routine ping-row evidence is silently eliminated; the Tier 2 flush has no exclusive snapshot semantics, permitting double-applied and destroyed counters) and one alert-pipeline gap (the dedup key is undefined for one of the three declared outbox event types, with a cross-monitor alert-suppression failure mode). The runbook contains an instruction that cannot execute in part of its declared phase range, and pairs PM2 `wait_ready` with an HTTP endpoint where PM2 actually requires a process signal.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Tier 2 design eliminates routine ping-row persistence entirely — contradicts behavior compatibility, §16.5, and the public API contract

**File:** `docs/ARCHITECTURE-AUDIT.md:860` (§16 Tier 2), `docs/ARCHITECTURE-AUDIT.md:716` (§14.1), `docs/ARCHITECTURE-AUDIT.md:930-951` (§16.2 SQL), cf. `docs/ARCHITECTURE-AUDIT.md:998` (§16.5), `docs/ARCHITECTURE-AUDIT.md:111` (§2), `docs/ARCHITECTURE-AUDIT.md:389-392` (§11)

**Issue:** The Tier 2 path aggregates routine (status-unchanged) checks in Redis as counters only (`agg:results:{monitorId}` hash: `count, failedCount, sumResponseTime, lastResponseTime, lastStatus, lastCheckedAt` — §13.1 line 573), and §16.2's literal SQL is a single guarded `UPDATE monitors` with **no `INSERT INTO pings`**. §14.1 line 716 makes this explicit and deliberate: "`record-pings-bulk` … there is no bulk ping-row writer to schedule." But the current system (verified in `src/lib/db-batcher.ts:28-33,72-76`) writes **one ping row per routine check** via `ping.createMany` on flush. Consequences of the design as written:

1. `GET /api/monitors/[id]/details` ("monitor + last 100 pings", §2 line 111) — the uptime-history timeline would only contain transition rows, gutting the monitor-details UI. This directly violates the project's hard "Behavior compatibility" constraint ("monitoring semantics preserved … public API shapes").
2. §16.5 line 998 is unimplementable: "Windowed uptime (24 h/7 d/30 d **computed from `pings`** via the `(monitor_id, created_at)` index)" cannot be computed from a table that only receives transition evidence.
3. The new `pings.error_class` / `pings.status_code` columns (§11, lines 389–392) are never populated for non-transition checks: a monitor that is already DOWN and times out again (Tier 2, unchanged DOWN) records no `error_class='timeout'` row, partially undermining the TC-CLASSIFY-* test cases and §13.7's retention design (pings volume collapses from per-check to per-transition).
4. §5's own defect table flags B6 ("Batching applies to routine DOWN checks — downtime evidence delayed/lossy") as something the redesign must eliminate; the new design makes routine DOWN evidence **absent**, not merely delayed.

**Fix:** Decide explicitly and reconcile the document. If per-check evidence must be preserved (behavior compatibility says it must), extend the §16.2 flush transaction with a bulk insert of the batch's ping rows, guarded by the same `write_guards` key:

```sql
BEGIN;
INSERT INTO write_guards(key) VALUES ('flush:{batchId}')
  ON CONFLICT DO NOTHING RETURNING key;
-- (0 rows => no-op exit, as today)

-- per-check evidence rows carried in the flush job payload (count-bounded by
-- the 60 s window × check rate):
INSERT INTO pings (monitor_id, status, response_time, error_class, status_code, created_at)
VALUES ($mid, $status, $rt, $errClass, $statusCode, $ts), ... ;  -- multi-row

UPDATE monitors SET ... ;  -- unchanged §16.2 UPDATE
COMMIT;
```

and delete the "Deliberately absent jobs: `record-pings-bulk`" paragraph. Alternatively, if dropping routine ping rows is an accepted product change, then §16.5's windowed-uptime plan, the details API contract, and the behavior-compatibility constraint must all be rewritten to say so — silently is not acceptable.

### CR-02: Tier 2 flush has no exclusive snapshot semantics — concurrent flushes double-apply deltas; a retried flush destroys newer deltas

**File:** `docs/ARCHITECTURE-AUDIT.md:941-951` (§16.2 SQL), `docs/ARCHITECTURE-AUDIT.md:860` (§16 Tier 2), `docs/ARCHITECTURE-AUDIT.md:1179-1182` (TC-FLUSH-GUARD-01), cf. `docs/ARCHITECTURE-AUDIT.md:699` (§14.1 flush lane)

**Issue:** The specified sequence is: read the hash → run the guarded transaction (key `flush:{batchId}`) → delete the hash after COMMIT. Two failure modes follow from the spec as written:

1. **Double-apply.** `flush-monitor-aggregate` jobs are produced every 30 s by the `flush-pass` scheduler with **fresh batchIds per pass**, and the writer pool has concurrency 5. A delayed pass-N job and a pass-(N+1) job for the same monitor can execute concurrently (or back-to-back before the delete); both read the same hash values and both apply the same deltas under *different* batchIds. `write_guards` only dedupes an identical `batchId`, so the counters are applied twice — silent `total_checks`/`failed_checks` inflation and `uptime_percent` drift. The old design's "snapshot + clear immediately" (§5, db-batcher.ts:63-68) closed this hole; the new design removed that step without replacing its exclusivity.
2. **Over-delete.** TC-FLUSH-GUARD-01 (lines 1180–1182) requires the redelivered flush job to "delete `agg:results:42` on the retry's exit path (cleanup proceeds despite the skip)". But the retry deletes the **live** hash, which by then may contain post-snapshot deltas accrued after the crashed attempt — those deltas are destroyed without ever being applied (silent counter loss, worse than the loss the guard exists to prevent).

**Fix:** Specify an exclusive, atomic snapshot keyed to the batch, e.g. at job start:

```
RENAME agg:results:{monitorId} agg:flushing:{batchId}
```

(or a Lua `HGETALL`+`DEL`). The job then reads only its staging key `agg:flushing:{batchId}`; new deltas accumulate in a fresh `agg:results:{monitorId}` hash untouched by the retry; after COMMIT, delete the staging key. A redelivery re-reads the same staging key, the guard no-ops, and the staging key is cleaned — both failure modes close. Also pin the `batchId` generation scheme (see IN-03).

### CR-03: Alert dedup key is undefined for outbox events with NULL `incident_id` — cross-monitor key collision suppresses legitimate alerts

**File:** `docs/ARCHITECTURE-AUDIT.md:986-987` (§16.4), `docs/ARCHITECTURE-AUDIT.md:349` (§11 outbox `event_type`), `docs/ARCHITECTURE-AUDIT.md:920-921` and `docs/ARCHITECTURE-AUDIT.md:909-915` (§16.1 steps 3b/4), cf. `docs/ARCHITECTURE-AUDIT.md:577` (§13.1 dedup row)

**Issue:** §16.4 defines exactly one key format: `alert:{incidentId}:{direction}` with `direction ∈ {down, recovered}`. But §11 declares three outbox event types, and the `outbox.incident_id` column is nullable. Two declared/common paths produce rows the key format cannot express:

1. **`monitor.first_check`** — for a PENDING→UP first check, step 3b's `UPDATE incidents … WHERE status='ONGOING'` matches nothing, so step 4 inserts the outbox row with `incident_id = NULL` (this is the event that carries today's "MONITORING STARTED" Telegram message, §3). Interpolating a NULL incidentId yields a shared key (`alert:null:…`) that **collides across all monitors**: after the first monitor's first-check alert, every other new monitor's start alert inside 24 h is suppressed by the `EXISTS` check.
2. **RECOVERED with no ONGOING incident** (edge: incident resolved out-of-band) — same NULL-incident collision suppresses real recovery alerts for other monitors for 24 h. Recovery alerts are exactly the J-6 case the design exists to protect.

**Fix:** Extend the dedup vocabulary to cover non-incident events, e.g. `alert:{monitorId}:first_check` (monitor-scoped, not incident-scoped), and state that `down`/`recovered` events require a non-NULL `incident_id` (reject or alert-and-skip at relay time otherwise). Mirror the change in the §13.1 key-inventory row.

## Warnings

### WR-01: SSRF denylist omits IPv4-mapped IPv6, unspecified-address, and NAT64 ranges; no canonicalization step is specified

**File:** `docs/ARCHITECTURE-AUDIT.md:817` (§15.1 step 4 sub-step 2)

**Issue:** The pinned denylist is `10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10`. A hostname with an AAAA record of `::ffff:10.0.0.1` (IPv4-mapped, in `::ffff:0:0/96`) is in none of the listed IPv6 ranges, yet connecting to it reaches 10.0.0.1 — a textbook SSRF-filter bypass. Similarly missing: `0.0.0.0/8` (connects to localhost on many stacks) and `64:ff9b::/96` (NAT64). The step says "validate every resolved IP … against the denylist" but never requires canonicalizing IPv4-mapped addresses to IPv4 before comparison.

**Fix:** Add to sub-step 2: "Canonicalize each address first: an IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is checked against the IPv4 denylist as `a.b.c.d`. Denylist additionally includes `::ffff:0:0/96`, `0.0.0.0/8`, and `64:ff9b::/96`." Add a TC-SSRF test case for the mapped form.

### WR-02: Manual-check interaction with the claim column is unspecified — deterministic duplicate samples per interval and an undefined manual-lane jobId

**File:** `docs/ARCHITECTURE-AUDIT.md:695` (§14.1 manual lane), `docs/ARCHITECTURE-AUDIT.md:722` (§14.2 step 3), `docs/ARCHITECTURE-AUDIT.md:574` (§13.1 idempotency row)

**Issue:** Only the scheduler claim (§14.3) advances `next_check_at`; the manual lane (API enqueue) never does, and nothing in §15.1 or §16 says otherwise. So a manual "check now" at 10:04:50 followed by the scheduled claim at 10:05 executes **two** checks in one interval window, both counted (Tier 2 additive counters) — a deterministic double-sample the current system only exhibits incidentally (when `lastChecked` is still batch-buffered). Additionally, the idempotency-key scheme `check:{monitorId}:{epoch}` is defined only for scheduler claims; the manual lane's jobId is never specified (reusing the current `next_check_at` epoch would silently dedupe a user's second manual check within one epoch window, contradicting the 1-per-30 s limit that should *allow* it).

**Fix:** Specify: (a) whether a manual check advances `next_check_at` (recommended: yes — the check happened, the next due slot should move, matching the user-visible semantics); (b) the manual-lane jobId format, e.g. `check:{monitorId}:manual:{epochMs-of-enqueue}` with its own `removeOnComplete` horizon.

### WR-03: Runbook interim-topology Migrate step cannot execute for Phase 2 releases; interim schema authority (`prisma db push`) is absent from the runbook

**File:** `docs/DEPLOY-RUNBOOK.md:54-57` (§3 step 3), cf. `docs/DEPLOY-RUNBOOK.md:42` (§3 header "Phases 2–3"), `docs/DEPLOY-RUNBOOK.md:132-138` (§8), `docs/ARCHITECTURE-AUDIT.md:1237` (§24 step 3)

**Issue:** §3 is scoped "Interim topology (Phases 2–3)" and its step 3 mandates `pnpm drizzle-kit migrate` with the note "If no migrations are pending, the command is a no-op that exits 0." But drizzle-kit, the migration runner, and versioned migrations only come into existence at the Phase 3 baseline (audit §24 step 3; runbook §8 "after the Phase 3 baseline"). A Phase 2 release following the runbook verbatim — the runbook's explicit operating contract ("written to be followed mid-deploy, without reading any other document first") — hits a command/deployment step that does not exist. Conversely, until the baseline PR deletes it, `prisma db push` is still the live schema step in CI (deploy.yml:74) and appears nowhere in the runbook's interim sequence.

**Fix:** Scope the step: "Phase 2 releases: no migrate step (or 'run the existing schema step — `prisma db push` — until the Phase 3 baseline PR removes it)'. From Phase 3: `pnpm drizzle-kit migrate` (no-op when nothing is pending)." Adjust the §2 topology table's Migrate row accordingly.

### WR-04: PM2 `wait_ready: true` requires `process.send('ready')` — the runbook pairs it only with the HTTP `readyz` endpoint, which PM2 does not watch

**File:** `docs/DEPLOY-RUNBOOK.md:107` (§5 wait_ready row), cf. `docs/DEPLOY-RUNBOOK.md:73` (§4 health surfaces)

**Issue:** PM2's `wait_ready` mechanism waits for the child process to emit the ready signal via `process.send('ready')` — not for an HTTP endpoint. The runbook defines only the `:9090/healthz|readyz` HTTP surfaces and says `wait_ready` "pairs with the `readyz` gate." As written, an implementer who wires only the HTTP server never sends the signal; PM2 force-restarts the worker after `listen_timeout` (30 s), producing a crash loop on every boot — in the process that gates every Phase 4+ release.

**Fix:** Add to §4/§5: "The worker must call `process.send('ready')` after its Redis + DB pings pass (i.e., when `readyz` would return success). The HTTP `readyz` endpoint remains the operator/CI gate; `process.send('ready')` is the PM2 gate."

### WR-05: The runbook has no first-worker-cutover path — `pm2 restart` on a nonexistent app, and the M3 overlap-window verification step is missing

**File:** `docs/DEPLOY-RUNBOOK.md:87-90` (§4 step 4), cf. `docs/ARCHITECTURE-AUDIT.md:1091` (M3), `docs/ARCHITECTURE-AUDIT.md:1238` (§24 step 4)

**Issue:** The target topology says `pm2 restart uptime-worker` and "restore the previous worker tarball" — but on the first Phase 4 release there is no previous worker, no previous worker tarball, and `pm2 restart` on an unregistered app fails (the first deploy needs `pm2 start` / `pm2 startOrReload`). That first release is also the highest-risk one (audit M3: the old `instrumentation.ts` cron must overlap-run while the worker proves continuity — "healthchecks.io + queue depth ≈ 0" — *before* the old cron is disabled), yet no runbook step expresses the overlap verification or the follow-up release that deletes the old cron path (`CRON_MODE`).

**Fix:** Add a §4a "First worker release (Phase 4 cutover)" subsection: `pm2 start` (not restart) for the new app; both old cron and new worker run during the overlap window with the M3 verification (heartbeat green, queue depth ≈ 0, pings still flowing); a subsequent release deletes `instrumentation.ts` cron + `CRON_MODE`; rollback restores web-only monitoring.

### WR-06: Password-hash "spike" vs "gate" terminology contradiction — §12.2 was amended but §20 M2 and §24 step 7 still describe the obsolete sequencing

**File:** `docs/ARCHITECTURE-AUDIT.md:526-529` (§12.2), vs `docs/ARCHITECTURE-AUDIT.md:1090` (M2), `docs/ARCHITECTURE-AUDIT.md:1241` (§24 step 7)

**Issue:** §12.2 explicitly reclassifies the bcrypt-compatibility work: "this is a **gate, not a spike**," with the non-negotiable ordering snapshot-canary → production-canary → route flip. But §20 M2 still says "Password-hash **spike** first (§12)" and §24 step 7 still reads "Password-hash **spike** → migrate." An implementer planning from §24 could treat the canary gate as an optional pre-investigation rather than a blocking, ordered gate — the exact failure §12.2 was amended to prevent.

**Fix:** Reword M2 to "bcrypt compatibility gate (§12.2): canary login on anonymized snapshot, then production, before any route flip" and §24 step 7 to "Better Auth cutover: bcrypt compatibility **gate** (§12.2) → migrate …".

### WR-07: The BullMQ priority-default claim is load-bearing and single-sourced — pin it with a live test instead of prose

**File:** `docs/ARCHITECTURE-AUDIT.md:712` (§14.1 "Why every lane carries an explicit priority")

**Issue:** The paragraph asserts as verified fact that "jobs without an explicit priority are processed **before** jobs that have one." The design happens to be robust to the claim being wrong (every lane carries an explicit priority, so ordering among lanes follows numeric priority either way), but the stated rationale would mislead future lane authors in the opposite direction, and the claim is not covered by any of the "verify against Phase 4 BullMQ 6 research" markers that other BullMQ-behavior claims carry (e.g., stalled-config rows).

**Fix:** Either add this specific claim to the Phase 4 verification list as a mandatory live check (enqueue one prioritized + one unprioritized job, assert dequeue order), or drop the default-behavior assertion and state only the invariant that matters: "every lane MUST set an explicit priority; cross-lane ordering relies on numeric priority among explicit values only."

### WR-08: Lock-TTL margin (5 s) is smaller than the Tier 1 persist budget (statement_timeout 30 s) — renewal-through-persist is not explicitly required

**File:** `docs/ARCHITECTURE-AUDIT.md:846` (§15.3 Lock TTL row), cf. `docs/ARCHITECTURE-AUDIT.md:1273` (§25.2 statement_timeout 30000), `docs/ARCHITECTURE-AUDIT.md:813-814` (§15.1 steps 2–3)

**Issue:** §15.3 says the 5 s margin "absorbs scheduler jitter and the persist-start window after the fetch returns," and step 3 arms renewal "every TTL/3 (5 s)" — but nothing states the renewal timer keeps running **during** the Tier 1 transaction. A slow transition transaction (legitimately up to 30 s under the worker's `statement_timeout`) outlives the 15 s TTL if renewal stopped at fetch end; the lock then expires mid-persist, a manual check takes ownership, and both executors persist (guards make it safe-but-wasteful — yet §15.2's "lock lost mid-check → abort without persisting" then applies to the *original* owner after it already committed, which the failure table does not model).

**Fix:** One sentence in §15.1 step 3 or §15.3: "The renewal timer runs for the entire job lifetime, including classification and Tier 1 persistence; the lock is released only in the step-7 `finally`." Adjust the margin rationale accordingly.

## Info

### IN-01: Per-user aggregate rate-limit key missing from the §13.1 inventory

**File:** `docs/ARCHITECTURE-AUDIT.md:576` (§13.1 rate-limit row), cf. `docs/ARCHITECTURE-AUDIT.md:544` (§12.4)

**Issue:** §12.4 pins two limits — "1 per monitor per 30 s **and** 6 total per minute per user across monitors" — but §13.1 lists only `rl:{bucket}:{ip}` and `rl:manual:{userId}:{monitorId}`. The cross-monitor per-user counter key (e.g. `rl:manual-user:{userId}`) is absent from the key inventory that §12.4 points to.

**Fix:** Add the second key shape to the §13.1 rate-limiting row.

### IN-02: Flush "buffer threshold" value is never pinned

**File:** `docs/ARCHITECTURE-AUDIT.md:699` (§14.1 flush lane: "buffer threshold checked each pass")

**Issue:** The flush-pass scheduler checks a buffer threshold each pass, but no §14.5/§16/§13 parameter table pins its value (or says "none — time-based only"). §16 invariant 4 bounds the buffer by the 60 s window, which suggests the threshold is redundant, leaving the reader to guess.

**Fix:** Either delete "buffer threshold checked each pass" or pin the threshold in the §14.5 parameter table.

### IN-03: `batchId` generation scheme is unspecified

**File:** `docs/ARCHITECTURE-AUDIT.md:937` (§16.2 guard key), cf. CR-02

**Issue:** The exactly-once guarantee keys on `flush:{batchId}`, but nothing specifies how batchIds are generated (uuid? scheduler-tick + monitorId?). After the CR-02 fix (staging keys named by batchId), the generation scheme becomes load-bearing for uniqueness and must be pinned.

**Fix:** Pin it, e.g. "batchId = `{schedulerTickEpochMs}:{monitorId}` (or uuid v4); unique per flush-job creation."

### IN-04: §16.1 conflates "another executor made the transition" with "monitor deactivated" — and writes an evidence ping for an inactive monitor

**File:** `docs/ARCHITECTURE-AUDIT.md:884-895` (§16.1 step 2 and its comment)

**Issue:** The conditional UPDATE guards on `status <> $target AND is_active`; zero rows returned is documented as "another executor already made this transition," but it is also returned when `is_active` was flipped false between claim and persist. Benign (steps 3–4 skip either way) except that step 1's evidence ping is still inserted for the now-inactive monitor — an orphaned row the retention job will clean in 30 days. Worth one clarifying sentence so implementers don't "fix" the ambiguity by branching on the wrong cause.

**Fix:** Add to the step-2 comment: "0 rows also occurs when `is_active` was cleared after the claim — same skip path; the step-1 evidence ping for a deactivated monitor is accepted."

### IN-05: "Steady-state total ≤ 31 connections" counts a one-shot deploy-time process

**File:** `docs/ARCHITECTURE-AUDIT.md:1264` (§25.1), `docs/DEPLOY-RUNBOOK.md:19` (§1)

**Issue:** Web 10 + worker 20 = 30 steady-state; the migration runner (1) exists only during deploys. The number is conservative in the safe direction, but calling 31 the "steady-state total" is imprecise in the one section whose purpose is precision.

**Fix:** "Steady-state total ≤ 30 (web + worker); ≤ 31 during deploys while the single migration runner is connected."

---

_Reviewed: 2026-09-08T21:14:48Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
