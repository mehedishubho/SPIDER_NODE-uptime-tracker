---
phase: 04-monitoring-worker-build-dark-launch
plan: 07
subsystem: worker-engine
tags: [outbox-relay, telegram-parity, dedup, maintenance-lane, dry-run, consistency-audit, retention, dat-05, dat-06, dat-08, wrk-13, obs-01, d-37, d-44, d-45, d-47, d-48, dark-launch]

# Dependency graph
requires:
  - phase: 04-monitoring-worker-build-dark-launch
    provides: Tier 1 outbox writes (04-04 applyTransition — the exact row/payload shape the relay claims) + per-monitor locks vocabulary
  - phase: 04-monitoring-worker-build-dark-launch
    provides: six-lane queue topology + LANE_PRIORITY + enqueue discipline + startLaneWorker pattern (04-02/04-01) — extended with alerts/maintenance lane consumers and enqueueMaintenance
  - phase: 04-monitoring-worker-build-dark-launch
    provides: upsertSchedulersAtBoot D-16 gate + three existing schedulers (04-06 scheduler.ts) — extended with the relay-pass scheduler on the alerts lane
  - phase: 02-characterization
    provides: the pinned Telegram alert strings (tests/integration/cron-logic.test.ts lines 257/299/344) — the D-48 byte-parity oracle this relay transcribes
provides:
  - processRelayJob(job, deps) (src/worker/persist/outbox.ts) — the DAT-05/DAT-06 relay pass: candidate batch over idx_outbox_unsent, per-row FOR UPDATE SKIP LOCKED claim transactions holding the row lock across send+mark, D-48 byte-parity rendering, D-47 incident-keyed SET NX EX dedup (604800 s) after confirmed send only, D-44/D-45 typed failure split with zero-migration FAILED state
  - renderAlertMessage / dedupKeyFor / telegramSend / isPermanentTelegramFailure / collectOutboxMetrics — individually exported relay building blocks (collectOutboxMetrics feeds /metrics.json via the index.ts provider)
  - processMaintenanceJob(job, deps) (src/worker/maintenance.ts) — WRK-13 dry-run-default audit (zero writes) + DAT-08 looped ≤5000-row retention deletes at the cleanup-logic 30/90-day horizons
  - runConsistencyAudit(db) — D-37 standalone export: stored uptime_percent vs the writers' D-36 absolute-form recomputation, discrepancy list (monitorId, stored, derived, delta) — Phase 5 reuses it during the two-writer overlap
  - enqueueMaintenance({dryRun}) (queues.ts) — manual maintenance enqueue regardless of WORKER_SCHEDULER_ENABLED (D-16); MAINTENANCE_JOB_OPTIONS mirrors the maintenance-cleanup scheduler template
  - startAlertsLaneWorker / startMaintenanceLaneWorker (concurrency 1/1) + OUTBOX_RELAY_SCHEDULER_ID "relay-pass" on the alerts lane (every RELAY_PASS_EVERY_MS = 5 s, D-16-gated)
  - /metrics.json outbox section: outbox.unsent, outbox.failed, outbox.latency (transition-to-alert created_at→sent_at distribution — D-24/D-25, the artifacts spec's alert.latency field realized as outbox.latency since it derives from outbox timestamps)
affects: [04-08, 04-09, 05-cutover-overlap]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-row SKIP LOCKED claiming for a synchronously-sending relay: the audit's whole-batch single transaction fits fast enqueue work, but a relay that dials Telegram per row cannot hold a batch lock across network I/O — so the pass reads candidates lock-free then claims EACH row in its own short transaction re-verifying eligibility under FOR UPDATE SKIP LOCKED (a locked row returns empty; concurrent relays partition the batch without double-sending)"
    - "Zero-migration derived FAILED state (D-44): a reserved _relayFailure jsonb key merged via payload || marker, plus attempts>=3 as the fallback predicate; attempts counts FAILED sends only (success sets sent_at without incrementing) so fail-twice-then-succeed records exactly 2 and permanent failures stop below the cap"
    - "Send-seam wrapping instead of call-site reuse (D-45): sendTelegramAlert swallows errors, so the relay performs the IDENTICAL sanctioned request but returns a typed {ok, status, description} — classification logic lives in the relay, the transport bytes stay pinned"
    - "Dry-run-default destructive-lane design (WRK-13): an absent dryRun flag means dry-run — only an explicit false ever deletes; the report object doubles as the operator audit artifact (ids/counts only, T-04-28)"

key-files:
  created:
    - src/worker/persist/outbox.ts
    - src/worker/maintenance.ts
    - tests/worker/outbox-relay.test.ts
    - tests/worker/maintenance.test.ts
  modified:
    - src/worker/queues.ts
    - src/worker/scheduler.ts
    - src/worker/index.ts
    - src/worker/health.ts

key-decisions:
  - "Relay pass shape: batch 50 / cadence 5 s (A3 discretion) — 50 rows keeps a pass inside the stalled-checker's 30 s lockDuration at ~100-300 ms per Telegram send; alerts-lane worker concurrency 1 (the pass self-spaces via the scheduler; SKIP LOCKED guards multi-process overlap)"
  - "attempts counts failed sends only: a clean send sets sent_at WITHOUT incrementing — the only semantics satisfying all three D-44 pinned behaviors (fail-twice-then-succeed => attempts 2; three transients => attempts 3 + FAILED; permanent 400 => FAILED with attempts < 3)"
  - "Dedup key written BEFORE markSent within the row transaction (SET NX EX then UPDATE): a crash between the two leaves the key held, so a re-drive skips the resend while still marking the row — the same never-double-send direction as a crash after send-before-key"
  - "no-telegramChatId rows are marked sent without a send (cron parity — cron-logic sends nothing for chatless owners); rows whose event arrived while the owner had no chat id are handled, not stuck"
  - "Retention scope = cleanup-logic parity exactly (pings 30d, RESOLVED incidents 90d with resolvedAt); write_guards >7d is OBSERVATION-ONLY in the report — their deletion is a later, explicitly scoped decision (deferred item, not scope creep)"
  - "D-37 audit uses the D-36 expression in ABSOLUTE form over current counters (not the in-UPDATE increments) — legacy-cron-written rows with raw float uptime_percent surface as discrepancies during the Phase-5 overlap window, which is the audit's entire purpose"

requirements-completed: [DAT-05, DAT-06, DAT-08, WRK-13, OBS-01]

# Coverage metadata (#1602)
coverage:
  - id: T1
    description: "DAT-05 relay claiming: two concurrent passes over the same rows, every row sent exactly once (FOR UPDATE SKIP LOCKED per-row claim)"
    requirement: DAT-05
    verification:
      - kind: integration
        ref: "tests/worker/outbox-relay.test.ts#4 (two parallel processRelayJob passes, 60 ms sends forcing contention, 6 distinct-incident rows)"
      status: pass
    human_judgment: false
  - id: T2
    description: "DAT-06 exactly-one-alert-per-incident: incident-keyed SET NX EX 7-day dedup set only after a confirmed send; pre-held key skips the send but still marks the row sent"
    requirement: DAT-06
    verification:
      - kind: integration
        ref: "tests/worker/outbox-relay.test.ts#1 (dedup vocabulary + TTL + SET-NX-after-send source pins), #3 (pre-held key: no send call, row marked sent, TTL 604800 asserted on the sent key)"
      status: pass
    human_judgment: false
  - id: T3
    description: "D-48 byte parity: all three rendered templates equal the Phase-2-pinned strings character-for-character, including the statusCode fallback and the user-timezone label"
    requirement: DAT-06
    verification:
      - kind: integration
        ref: "tests/worker/outbox-relay.test.ts#2 (full-string toContain against the cron-logic.ts:104-133 transcription + the pinned phrases from tests/integration/cron-logic.test.ts:257/299/344), #2b (statusCode null -> 'No Response / Timeout')"
      status: pass
    human_judgment: false
  - id: T4
    description: "D-44/D-45 typed failures: permanent 400/401/403 -> UnrecoverableError + immediate FAILED (attempts < 3); transient backoff to 3 attempts then FAILED + retain + one error-level line + gauge; CR-03 null-incident dead-letter"
    requirement: DAT-05
    verification:
      - kind: integration
        ref: "tests/worker/outbox-relay.test.ts#5 (fail-twice-then-succeed attempts=2), #6 (three transients -> attempts=3, _relayFailure marker, error log, failed gauge, never re-claimed), #7 (permanent: UnrecoverableError, attempts<3), #8 (CR-03 dead-letter, no alert:null:* key)"
      status: pass
    human_judgment: false
  - id: T5
    description: "WRK-13/D-37 dry-run: zero writes, correct per-monitor deletable counts, exactly the corrupted monitor flagged with stored/derived/delta; runConsistencyAudit standalone"
    requirement: WRK-13
    verification:
      - kind: integration
        ref: "tests/worker/maintenance.test.ts#2 (row counts + stored uptime_percent unchanged before/after; discrepancies === [{monitorId, stored: 75.5, derived: 50, delta: 25.5}])"
      status: pass
    human_judgment: false
  - id: T6
    description: "DAT-08 batched retention: real run deletes 5015 beyond-horizon pings in [5000, 15] statements (each ≤ RETENTION_BATCH), fresh rows and ONGOING incidents untouched; D-16 manual enqueue processes on the real lane worker with the flag off"
    requirement: DAT-08
    verification:
      - kind: integration
        ref: "tests/worker/maintenance.test.ts#3 (batches === [5000, 15], 3 fresh survivors, ONGOING + recent RESOLVED retained), #4 (upserted [] with flag false; enqueueMaintenance -> lane worker completes with returnvalue.dryRun true)"
      status: pass
    human_judgment: false
  - id: T7
    description: "OBS-01 completion: /metrics.json carries the outbox section (unsent, failed, transition-to-alert latency distribution) alongside the queue section and breaker state"
    requirement: OBS-01
    verification:
      - kind: integration
        ref: "tests/worker/outbox-relay.test.ts#10 (collectOutboxMetrics counts + 5 s latency sample percentiles; health endpoint outbox section via the outboxMetrics provider), tests/worker/maintenance.test.ts#1 (index.ts wiring pin: outbox: await collectOutboxMetrics())"
      status: pass
    human_judgment: false

# Metrics
duration: ~21 min (1285s) single session
completed: 2026-09-14
status: complete
---

# Phase 4 Plan 7: Outbox Relay + Maintenance Lane Summary

**The transactional-outbox relay (DAT-05/06) with character-for-character Telegram parity (D-48), incident-keyed 7-day dedup (D-47), and the typed permanent/transient failure split over a zero-migration FAILED state (D-44/D-45), plus the maintenance lane (WRK-13) with a zero-write dry-run audit, the D-37 uptime_percent consistency check, and ≤5000-row batched retention deletes (DAT-08) — 15 new proof cases green on the real docker stack, full verify chain green end-to-end (102.76 KB worker bundle, 18/18 e2e)**

## Session Notes

Single-session sequential execution. Task 1's suite needed two pre-commit fixes (the SKIP LOCKED case originally shared one incident across six rows — the dedup key collapsed rows 2-6 into skip-but-mark-sent, so the concurrency case now seeds six distinct incidents; the metrics case asserted a section shape the provider must wrap as `{outbox: ...}`). Task 2's first run failed two authoring issues (an id-IN source pin matching prose in a comment; BullMQ Job instances not live-refreshing `returnvalue`) and one typecheck-only failure (ioredis typings predate the `memory usage` command — MEMORY USAGE now rides the universal `call` surface). All fixed before any commit; both task suites and the full verify chain green.

## Performance

- **Duration:** ~21 min (1285s)
- **Started/Completed:** 2026-09-14T05:31:35Z → 2026-09-14T05:53:00Z
- **Tasks:** 2/2
- **Files:** 8 (4 created, 4 modified — scheduler.ts modified under a documented Rule-2 deviation, all others inside the plan's files_modified list)

## Parity String Provenance (D-48 — verification requirement)

The three expected strings are transcribed from `src/lib/cron-logic.ts` lines 104-133. Their Phase 2 characterization pins (the compatibility contract this relay must not break):

| Template | Phase 2 pin (tests/integration/cron-logic.test.ts) | Relay proof |
| --- | --- | --- |
| `🚀 MONITORING STARTED: Website is Online!` | line 257 (case 4) | tests/worker/outbox-relay.test.ts#2 (full-string equality, `userTimezone: "Asia/Dhaka"` zone label asserted) |
| `🚨 ALERT: Website Down!` | line 299 (case 5; the `500` status line at 303) | tests/worker/outbox-relay.test.ts#2 + #2b (statusCode null → `No Response / Timeout` fallback) |
| `✅ RECOVERY: Website Back Online!` | line 344 (case 6) | tests/worker/outbox-relay.test.ts#2 |

The relay comparisons are character-for-character full-string equalities (not `stringContaining`); the characterization phrases are additionally asserted present as the bridge to the Phase 2 pins.

## Accomplishments

- **DAT-05 (relay):** `processRelayJob` reads a 50-row candidate batch riding `idx_outbox_unsent`, then claims EACH row in its own short `FOR UPDATE SKIP LOCKED` transaction re-verifying eligibility under the lock — the row lock spans that row's send + mark, never the whole batch. Two parallel passes over six rows: exactly six sends, every row once, all marked sent
- **DAT-06 (exactly one alert per incident):** `dedupKeyFor` (§16.4/01-06 vocabulary: `alert:{incidentId}:down` / `:recovered` / `alert:{monitorId}:first_check`), `SET NX EX 604800` strictly after a confirmed send; a pre-held key skips the dial but still marks the row sent (re-drives can never double-send); chatless owners' rows are handled and marked sent (cron parity)
- **D-48 (byte parity):** the three cron-logic templates transcribed character-for-character — exact emojis (incl. the VS16 forms), `statusCode || "No Response / Timeout"`, and `toLocaleString("en-US", {timeZone: userTimezone || "UTC", timeZoneName: "short"})` over the Tier-1-captured `occurredAt`
- **D-44/D-45 (typed failures):** `telegramSend` performs the sanctioned telegram.ts request returning `{ok, status, description}`; `isPermanentTelegramFailure` (400/401/403 status or canonical description phrases) → terminal `_relayFailure` marker + `UnrecoverableError` with attempts < 3; everything else transient → attempts+1 and a plain throw for backoff until attempts=3 → FAILED + retain + exactly one error-level pino line. FAILED is a derived state (`payload ? '_relayFailure'` OR `attempts >= 3`) — zero migrations
- **CR-03:** null-incident down/recovered rows (and unknown event types) dead-letter via terminal marker + `UnrecoverableError` — never a minted `alert:null:*` collision key
- **WRK-13/D-37 (maintenance):** dry-run default reports per-monitor deletable pings (30-day cleanup-logic horizon), RESOLVED-only incident deletability (90-day), the D-37 audit (the writers' D-36 exact-extraction expression in absolute form — flags exactly the deliberately corrupted monitor with stored 75.5 / derived 50 / delta 25.5), BullMQ key-size observations (SCAN + MEMORY USAGE, Pitfall 6 watch) and write_guards >7d counts — all ZERO writes, proven by unchanged row counts and stored percentages
- **DAT-08 (bounded deletes):** real run loops `DELETE ... WHERE id IN (SELECT ... LIMIT 5000)` until drained — 5015 seeded old pings deleted as `[5000, 15]`, fresh rows and ONGOING incidents untouched; lane concurrency 1 (D-7)
- **D-16:** `enqueueMaintenance({dryRun})` works with the scheduler flag off and the always-live lane consumer processes it end-to-end on a real BullMQ Worker (returnvalue captured from the stored job)
- **OBS-01 completion:** `/metrics.json` now carries `outbox.unsent`, `outbox.failed`, and `outbox.latency` (sample/avg/p50/p95/max of created_at→sent_at deltas) via the index.ts provider, beside the queue section and breaker state

## Task Commits

1. **Task 1: outbox relay + gauges + proof suite** — `62a20a6` (feat)
2. **Task 2: maintenance lane + wiring + proof suite** — `6d8c6db` (feat)

## Files Created/Modified

- `src/worker/persist/outbox.ts` — constants (RELAY_BATCH_SIZE 50, RELAY_PASS_EVERY_MS 5000, DEDUP_TTL_SECONDS 604800, RELAY_MAX_ATTEMPTS 3, RELAY_FAILURE_KEY), OutboxEvent, renderAlertMessage, dedupKeyFor, RelaySendOutcome/telegramSend/isPermanentTelegramFailure, relayRedis singleton, processRelayJob (per-row claim transactions + pass-level throw semantics), collectOutboxMetrics
- `src/worker/maintenance.ts` — PING_RETENTION_DAYS 30, INCIDENT_RETENTION_DAYS 90, RETENTION_BATCH 5000, WRITE_GUARD_RETENTION_DAYS 7; runConsistencyAudit (D-36 absolute form), collectRedisObservations, deleteInBatches, processMaintenanceJob (dry-run default), maintenanceRedis singleton
- `src/worker/queues.ts` — ALERTS_LANE_CONCURRENCY/MAINTENANCE_LANE_CONCURRENCY (1/1), startAlertsLaneWorker/startMaintenanceLaneWorker, MAINTENANCE_JOB_OPTIONS, enqueueMaintenance
- `src/worker/scheduler.ts` — OUTBOX_RELAY_SCHEDULER_ID "relay-pass" + the alerts-lane upsert (every 5 s, removeOnComplete count cap 100) inside the D-16-gated branch
- `src/worker/index.ts` — alerts + maintenance lane workers registered as drainables; queueMetrics provider merges `outbox: await collectOutboxMetrics()`
- `src/worker/health.ts` — `outboxMetrics?: () => Promise<unknown>` provider option merged additively into /metrics.json (same fail-open shape as queueMetrics)
- `tests/worker/outbox-relay.test.ts` — 11 cases (source pins/classification matrix, three-template byte parity + fallback + tz, dedup TTL + skip-but-mark, SKIP LOCKED parallel passes, transient 2-then-success, terminal-3 + gauge + log, permanent fast-fail, CR-03, chatless, gauges + endpoint)
- `tests/worker/maintenance.test.ts` — 4 cases (source pins + dry-run default + loud unknown name + wiring pins, zero-write dry run with exact counts/audit, [5000,15] batching with survivors, D-16 manual enqueue on the real worker)

## Decisions Made

See key-decisions in the frontmatter. The load-bearing ones for downstream plans:

- 04-08 reads `/metrics.json` `outbox.unsent`/`outbox.failed`/`outbox.latency` additively — the section is `{outbox: {...}}` (the artifacts spec's `alert.latency` field is realized as `outbox.latency` because the transition-to-alert latency derives from outbox timestamps; documented as a naming resolution, not a behavior change)
- Phase 5's overlap-window writer-consistency check consumes `runConsistencyAudit()` exactly as exported; its discrepancy rows carry `{monitorId, stored, derived, delta}` with the D-36 derivation as the truth side
- The relay's FAILED rows are retained forever and carry `_relayFailure: {classification, lastError, failedAt}` in the payload — D-46's operator re-drive script is the only path back; `classification` ∈ {permanent, transient_exhausted, contract_violation}
- write_guards rows older than 7 days are REPORTED but never deleted by this lane — deferred to an explicit later decision (see Deferred Issues)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - missing critical functionality] relay-pass scheduler added to scheduler.ts (outside files_modified)**
- **Found during:** Task 2 — the plan pins the 5 s relay cadence (RELAY_PASS_EVERY_MS, batch/cadence "per the A3 discretion default") but lists no scheduler for it and keeps scheduler.ts out of files_modified
- **Issue:** without a recurring driver, outbox rows sit unsent until a manual enqueue — the relay lane would exist but never fire in production
- **Fix:** `OUTBOX_RELAY_SCHEDULER_ID` ("relay-pass") upserted on the ALERTS lane inside the existing D-16-gated `upsertSchedulersAtBoot` branch, `{every: RELAY_PASS_EVERY_MS}`, priority `LANE_PRIORITY.relayPass`, attempts 5 / exponential 5000 backoff, removeOnComplete `{age: 3600, count: 100}` (the count cap keeps a 5 s cadence from accumulating ~720 completed-job keys/hour against Pitfall 6's lazy eviction), removeOnFail 7 d. scheduler-flag.test.ts re-run green: its per-queue assertions pin only the scheduler + maintenance queues, and the source pins (`no .pause(`, `no jobId:`) hold
- **Files modified:** src/worker/scheduler.ts (one file outside files_modified, in-source documented)
- **Verification:** tests/worker/scheduler-flag.test.ts 5/5; maintenance.test.ts#1 pins the upsert's presence, lane, and cadence
- **Committed in:** 6d8c6db

**2. [Rule 3 - typing] MEMORY USAGE rides ioredis's universal call() surface**
- **Found during:** Task 2 verify (typecheck step)
- **Issue:** ioredis's bundled typings predate the `memory usage` command's dedicated method — `Pick<IORedis, "scan" | "memoryUsage">` does not typecheck even though the runtime supports it
- **Fix:** the observation seam is `Pick<IORedis, "scan" | "call">` and the probe is `redis.call("memory", "usage", key)` — identical wire command, typed surface
- **Files modified:** src/worker/maintenance.ts
- **Committed in:** 6d8c6db

---

**Total deviations:** 2 auto-fixed (1 Rule 2 missing driver, 1 Rule 3 typing blocker). One naming resolution (alert.latency → outbox.latency) documented under Decisions. scheduler.ts is the only file touched outside the plan's files_modified list, under the documented Rule-2 deviation.

## Issues Encountered

- Task 1 test-authoring (fixed pre-commit): the SKIP LOCKED concurrency case originally seeded six rows on ONE incident — the confirmed first send set the shared dedup key and rows 2-6 became dedup-skips (2 total sends); the case now seeds six distinct incidents so it proves contention, not dedup. The metrics case originally asserted a top-level merge; the provider wraps the snapshot as `{outbox: ...}` to match the artifacts spec's `outbox.*` field names
- Task 2 test-authoring (fixed pre-commit): the `WHERE id IN (` source pin also matched the module-header prose (now anchored to `DELETE FROM ... WHERE id IN (`); `Job.returnvalue` is a snapshot — the stored job is re-fetched for the processor's report
- `pnpm test -- <file>` passes `--` through and runs the whole suite — `npx vitest run <file>` used for isolation (standing 04-04/05/06 learning)

## Deferred Issues

- **write_guards retention:** rows older than 7 days are counted in the dry-run report only. Deleting them needs an explicitly scoped decision (they are write idempotency guards; premature deletion could unguard a redelivered flush). Candidate owner: a later ops/Phase-5 plan
- **outbox sent-row retention:** sent rows are never purged (D-44 retains FAILED rows forever by design; sent rows simply accumulate at ~3 rows per monitor transition). A future maintenance extension could prune sent rows older than the 7-day dedup TTL — not in this plan's scope

## User Setup Required

None.

## Threat Flags

None beyond the plan's threat_model. Register rows all mitigated in this plan's code/tests: T-04-25 (dedup after confirmed send + skip-but-mark + ≤3 cap + FAILED retain — proven live in relay cases 3/5/6), T-04-26 (dedup TTL makes re-sends impossible within 7 days; terminal FAILED stops retry storms), T-04-27 (cleanup-logic-parity horizons, dry-run default, ≤5000 batches, RESOLVED-only incidents — ONGOING survivor proven), T-04-28 (templates carry exactly today's alert content; reports carry ids/counts/sizes only; log bindings are ids/outcomes — no URLs, bodies, or tokens).

## Self-Check: PASSED

All four created files exist on disk (src/worker/persist/outbox.ts, src/worker/maintenance.ts, tests/worker/outbox-relay.test.ts, tests/worker/maintenance.test.ts); both task commits (62a20a6, 6d8c6db) present in git log.
