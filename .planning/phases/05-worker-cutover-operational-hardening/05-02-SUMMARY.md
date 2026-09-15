---
phase: 05-worker-cutover-operational-hardening
plan: 02
subsystem: worker
tags: [worker, scheduler, healthchecks-io, dead-man-switch, heartbeat, observability, wrk-09, obs-03]
requires:
  - "05-01 collectOutboxMetrics().oldestUnsentSeconds (the outbox ping decision input)"
  - "05-01 redisMemorySnapshot export from src/worker/health.ts (the memory ping decision input)"
  - "04-08 TEST-ONLY injectable-seam discipline (TickDeps providers)"
  - "04-02 queue topology (processTick claim/enqueue path the wiring rides on)"
provides:
  - "pingDeadMan wiring on the worker tick: heartbeat success/fail semantics identical to instrumentation.ts (WRK-09, D-21/D-22) — hard precondition of cron deletion"
  - "OUTBOX_AGE_ALERT_THRESHOLD_SECONDS = 90 (D-23) and MEMORY_ALERT_PERCENT = 70 (D-24) exported pins in src/worker/scheduler.ts"
  - "OBS-03 paging semantics live on the tick: healthy outbox pings, backed-up outbox goes silent after one crossing /fail and pages through the 5-minute grace"
  - "TickDeps.outboxMetrics / TickDeps.memorySnapshot injectable seams (05-03 Prometheus gauges can wrap the same providers)"
  - "Flag-off boot proven ping-free (dark-launch posture preserved by test, D-37 alignment)"
affects:
  - "05-03 memory gauge / outbox gauge read the same collectors (no second INFO/query path)"
  - "05-08 window gate 1 (heartbeat steady) consumes the WORKER_HC_PING_URL check's flips record (D-17)"
  - "05-04 documents WORKER_HC_PING_URL / WORKER_OUTBOX_HC_PING_URL / WORKER_MEMORY_HC_PING_URL in .env.example"
tech-stack:
  added: []
  patterns:
    - "one-ping-per-check-per-tick via a single shared pingDeadMan helper (Pitfall 3 rate-cap discipline: /fail replaces success, zero retries)"
    - "crossing-marker module state: one /fail at threshold crossing, then silence — dead-man semantics where silence IS the page signal"
    - "default provider over the queue set's shared producer connection (§25 budget holds by construction, route documented in-code)"
    - "behavioral + source-form pins where behavior alone is environment-vacuous (log-marker + threshold constants pinned by readFileSync assertions)"
key-files:
  created:
    - tests/worker/scheduler-heartbeat.test.ts
    - tests/worker/outbox-age-ping.test.ts
  modified:
    - src/worker/scheduler.ts
    - tests/worker/scheduler-flag.test.ts
decisions:
  - "Unknown outbox age (the -1 sentinel or a throwing read) withholds the ping (silence fails toward detection) rather than pinging success — the 5-minute grace absorbs one transient read failure and a sustained gauge failure SHOULD page; heartbeat /fail stays reserved for tick-level claim/enqueue exceptions"
  - "Memory read keeps redisMemorySnapshot's nulls-as-unknown-BUT-HEALTHY contract (null pings) because D-24's default provider cannot throw; a throwing memory provider (beyond contract) is caught, logged, and withheld"
  - "Memory check has NO crossing /fail marker — D-24/D-25 define silence + the 30-minute grace as the memory page (avoids flapping on transient spikes); only the outbox check carries D-23's optional single /fail"
  - "Default memory provider = ONE INFO call on workerQueues().connection (the §25 shared producer), not a one-shot workerConnection() client — the production boot creates the queue set before the first tick, so the handle exists and no new connection is ever minted; deps.queues fakes never reach the default because memory-URL tests inject the provider"
  - "Crossing state is per-process module state with NO test-reset export — every case drives the state to a known point through ticks (healthy tick resets, over tick arms), which doubles as the recovery/re-arm behavioral pin"
metrics:
  duration: "~9 min (547s, single session)"
  completed: 2026-09-15
status: complete
---

# Phase 05 Plan 02: Worker Dead-Man Switches (Heartbeat / Outbox-Age / Memory) Summary

**One-liner:** Three healthchecks.io dead-man checks wired onto the worker's scheduler tick through one shared pingDeadMan helper — heartbeat with audit-faithful success/fail-replaces-success semantics (WRK-09), a 90 s outbox-age check whose crossing fires one /fail then goes silent (OBS-03/D-23), and a 70% Redis-memory check (D-24) — all failure-isolated, one ping per check per tick, and proven ping-free under the dark-launch flag.

## What Was Built

### Task 1 — Heartbeat: pingDeadMan + tick-end/catch wiring (commit 85e7e4a RED, abe1295 GREEN)

- `src/worker/scheduler.ts`: module-local `pingDeadMan(base, fail)` — early-return when the URL is unset, exactly one `fetch(fail ? base + "/fail" : base)` with `AbortSignal.timeout(5_000)`, every error swallowed, zero retries.
- `processTick` body wrapped in try/catch (audit §14.2 step 5 / §14.4 rows 1-3): a completed tick pings `WORKER_HC_PING_URL` at the END; `result.failed > 0` (enqueue rejections) pings `/fail` INSTEAD of success; backlog-gated drops are documented in-code as deliberate J-5 skips that never trigger `/fail`; any tick-level exception awaits the `/fail` ping before rethrowing.
- Pings deliberately NOT gated on the D-16 flag — inertness is structural (flag off = no schedulers = no ticks); an in-code comment tells the next reader not to add a redundant guard.
- `tests/worker/scheduler-heartbeat.test.ts` (8 cases): exactly-one success ping; claim-throw → one `/fail` + rethrow (driven by `batchSize: 0`, claimDue's own validation — deterministic without DB mocks); failed enqueues → `/fail`; rejecting fetch never fails the tick and never retries; unset URL → zero fetches; AbortSignal presence; drops-only tick → success ping; source pins (helper + env wired; no line containing a `log.*` call carries `PING_URL`).
- Tests use the real docker test Postgres for the claim (scheduler-flag suite convention), a plain fake for the checks queue (CheckQueueClient's documented injection seam), and `vi.stubGlobal("fetch", ...)`.

### Task 2 — Conditional outbox-age + memory pings (commit b16b0ed RED, f427028 GREEN)

- `OUTBOX_AGE_ALERT_THRESHOLD_SECONDS = 90` (D-23 band midpoint, research OQ1) and `MEMORY_ALERT_PERCENT = 70` (D-24) exported; both pinned by a source-form test (acceptance criterion).
- `TickDeps` extended with `outboxMetrics` / `memorySnapshot` providers (04-08 TEST-ONLY-seam discipline) defaulting to `collectOutboxMetrics` and `redisMemorySnapshot(workerQueues().connection)` — the shared §25 producer connection, so the memory read mints zero new connections (route + rationale documented in-code).
- Outbox semantics: ping success while `oldestUnsentSeconds < 90` (null = nothing unsent = healthy); at crossing, exactly ONE `/fail` then silence (the 5-minute grace pages — and repeated pings would trip healthchecks.io's silent 5/min cap, Pitfall 3); recovery resumes success pings and re-arms the marker (pinned by a re-crossing assertion). Read failures (throw or the -1 sentinel) log the greppable `OUTBOX_METRICS_READ_FAILED` warn marker, never throw, never ping, and leave the crossing state unchanged — all pinned behaviorally.
- Memory semantics: ping while `memoryPercent < 70` or null (unknown-but-healthy); withheld at 70+ with NO `/fail` form (D-24/D-25: silence + 30-minute grace is the memory page).
- `pingConditionalDeadMans` runs after the heartbeat ping on every completed tick and swallows everything internally — a broken gauge can never masquerade as a tick failure and trigger the heartbeat `/fail`.
- `tests/worker/outbox-age-ping.test.ts` (6 cases) drives the crossing state through ticks (no test-reset export needed — the state-driving doubles as the recovery pin).

### Task 3 — Paused-inert proof + suite closeout (commit 00a06bb)

- `tests/worker/scheduler-flag.test.ts` case 6: a flag-off boot of the module's exported surface (`upsertSchedulersAtBoot({ schedulerEnabled: false })`) with all three ping URLs armed produces zero schedulers and ZERO global-fetch calls — the dark-launch posture is preserved by proof. The case documents the D-37 alignment: the real healthchecks.io checks are provisioned at window-open precisely because the add-release soak is scheduler-off (early provisioning would false-page through the graces).
- Targeted trio green: scheduler-flag + scheduler-heartbeat + outbox-age-ping = 20/20.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Stale rollback message in the processTick catch**
- **Found during:** Task 1 GREEN (visible in the suite's log output)
- **Issue:** The per-monitor enqueue-failure log line still said "J-1 rollback already applied inside the enqueue helper" — factually wrong since 05-01 deleted `rollbackFailedClaim` (claims stay advanced, §14.4).
- **Fix:** Message corrected to "claim stays advanced, the next tick re-claims when due (J-1 / §14.4)" — same function this task owns, one line.
- **Files modified:** src/worker/scheduler.ts
- **Commit:** abe1295

**2. [Scope addition, within Task 1's behavior list] Extra pin: drops-only tick pings success**
- **Found during:** Task 1 test authoring
- **Issue:** The plan's six behavior cases assert the `/fail`-on-failed-enqueues rule but nothing pins the inverse distinction (dropped-without-failure must NOT trigger `/fail`) that truth 5 and prohibition 3 make load-bearing.
- **Fix:** Case 7 seeds an UP monitor with an inflated depth read (gate trips → dropped, add never dialed) and asserts the success ping — the J-5 distinction is now test-pinned, not comment-only.
- **Files modified:** tests/worker/scheduler-heartbeat.test.ts
- **Commit:** 85e7e4a

Otherwise the plan executed exactly as written.

## Verification Evidence

- `pnpm exec vitest run tests/worker/scheduler-heartbeat.test.ts` — 8/8 green (after RED: 7 failed / 1 vacuous pass)
- `pnpm exec vitest run tests/worker/outbox-age-ping.test.ts tests/worker/scheduler-heartbeat.test.ts` (Task 2 verify) — 14/14 green (after RED: 6/6 failed)
- `pnpm exec vitest run tests/worker/scheduler-flag.test.ts tests/worker/scheduler-heartbeat.test.ts tests/worker/outbox-age-ping.test.ts` (Task 3 verify) — 20/20 green
- Full suite `pnpm test` — **269/269 green (32 files)**, up from 254 — zero cross-suite fallout
- `pnpm typecheck` — 0 errors; `pnpm lint` — 0 errors, **zero warnings in plan-touched files** (55 pre-existing elsewhere)
- `pnpm worker:boundary` — green (16 files, no next/react/@app imports under src/worker)
- Grep of `PING_URL` in src/worker/scheduler.ts: five sites — two comments, three `process.env` reads feeding pingDeadMan; none reach a log call (also pinned by two source-form tests)
- `git diff` on Task 1/2 commits: no lines touching `upsertSchedulersAtBoot` gating, `schedulerEnabled`, or `.pause(` (prohibition 3 verified)

## TDD Gate Compliance

Both implementation tasks followed RED→GREEN with per-gate commits: `test(...)` 85e7e4a precedes `feat(...)` abe1295; `test(...)` b16b0ed precedes `feat(...)` f427028. Task 3 is a pin task (tests-only, no source change required) and lands as a single `test(...)` commit 00a06bb. RED runs genuinely failed before each GREEN.

## Requirement Status

`WRK-09` and `OBS-03` (plan frontmatter): the wiring now exists and is pinned — but both stay **Pending** in REQUIREMENTS per the 02-03/03-02/04-02 false-signal precedent: the real healthchecks.io checks do not exist until window-open provisioning (D-37), so live paging is unproven until 05-08's window evidence (heartbeat steady = gate 1 via the check's own flips record, D-17). This summary records the code-side completion only.

## Key Learnings

- A tick-level try/catch that pings `/fail` on ANY exception makes gauge-read placement load-bearing: the conditional checks MUST swallow their own read failures inside `pingConditionalDeadMans`, or a broken outbox gauge would false-page the heartbeat. Failure isolation composes only when each layer owns its swallow.
- Driving module-level crossing state through ticks (healthy tick resets, over tick arms) is a stronger test than a reset export — it pins the reset/re-arm behavior itself instead of working around it.
- `batchSize: 0` is a clean deterministic claim-side failure: claimDue's own argument validation throws before any SQL, no database mocking needed.

## Threat Surface

No new surface beyond the plan's `<threat_model>`: all four register rows mitigated as planned — T-05-02-01 (operator-env URLs only, 5 s abort), T-05-02-02 (ids-only logging, source-pinned twice), T-05-02-03 (one ping per check per tick, zero retries, `/fail` replaces success — asserted by exact call counts on every path), T-05-02-04 (pingDeadMan swallows everything; rejecting-fetch case pins it).

## Self-Check: PASSED

- Files: src/worker/scheduler.ts, tests/worker/scheduler-heartbeat.test.ts, tests/worker/outbox-age-ping.test.ts, tests/worker/scheduler-flag.test.ts — all present
- Commits: 85e7e4a, abe1295, b16b0ed, f427028, 00a06bb — all in `git log`
- No tracked-file deletions in any task commit; no untracked artifacts left behind by this plan
