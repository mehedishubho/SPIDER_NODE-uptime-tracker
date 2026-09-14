---
phase: 04-monitoring-worker-build-dark-launch
verified: 2026-09-14T18:27:24Z
status: human_needed
score: 11/12 must-haves verified
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Decide the disposition of SC5's SEC-02 clause: 'OS-level egress rules active on the worker host'"
    expected: "Either (a) accept the documented deferral formally — add an override to this file's frontmatter: must_have 'OS-level egress rules active on the worker host', reason 'No worker host exists on the operator-ratified local stand-in topology (03-08); the deliverable possible this phase — concrete iptables/nftables rules in runbook §10, machine-enforced set-equality with the engine denylist by the D-40 gate in pnpm verify — is delivered and verified green; enforcement is a first-VPS-worker-deploy consumption point recorded in 04-DEPLOY-RECORD.md disposition 3 and REQUIREMENTS.md honestly tracks SEC-02 as Pending', accepted_by <name>, accepted_at <ISO> — or (b) hold SEC-02 open (as REQUIREMENTS.md does today) until the first VPS deploy applies and probes §10. No code action is possible or required this phase."
    why_human: "The deferral is operator-visible (deploy record disposition 3, runbook D-17 note, REQUIREMENTS Pending) but is not a formal verification override (no accepted_by/accepted_at); accepting a must-not-yet is a human decision, not a codebase fact. Mirrors the Phase 3 memory-alerting precedent (03-VERIFICATION.md human item 1)."
  - test: "Bookkeeping decision: ROADMAP.md marks Phase 4 'Mode: mvp' but the phase goal is not in User Story format (gsd-tools user-story.validate → false; backend-infrastructure goal, no 'As a … I want to … so that …' form)"
    expected: "Either reformat the goal via /gsd mvp-phase 4 or drop the Mode: mvp tag for this phase (Phase 3 dropped its tag after the same finding — 03-VERIFICATION.md). Verification proceeded standard goal-backward per Phase 2/3 precedent; no User Flow Coverage section was fabricated against a non-user-story goal."
    why_human: "Mode metadata preference; affects future MVP-mode UAT framing only, no codebase truth"
  - test: "Bookkeeping decision: OBS-02 stays Pending in REQUIREMENTS.md although the code delivers monitorId correlation on every check->persist->alert log line (jobLogger child bindings in src/worker/engine/check.ts:223; monitorId on every relay line in src/worker/persist/outbox.ts:497-561; live dark-launch worker log carries monitorId-correlated smoke lines)"
    expected: "Either keep OBS-02 Pending until the Phase 5 cutover exercises the full scheduler -> check -> persist -> alert chain with the scheduler ON (the scheduler leg has never emitted a per-monitor line in production — dark launch runs with schedulers upserted-away, so 'across scheduler' is genuinely unexercised), or mark it complete now on the code+live-log evidence. The project's conservative accounting is defensible; this is a tracking decision, not a gap."
    why_human: "Requirement-checkbox policy decision; the SC5 traceability clause itself is satisfied on evidence (see truth 12) — the pending checkbox reflects an abundance-of-caution call the operator owns"
re_verification:
  previous_status: none
---

# Phase 4: Monitoring Worker — Build & Dark Launch Verification Report

**Phase Goal:** All monitoring execution runs in a dedicated worker process on durable, idempotent, resilient BullMQ machinery — built, failure-injection-tested, and dark-launched while the existing cron still serves every user.
**Verified:** 2026-09-14T18:27:24Z
**Status:** human_needed (11/12 truths verified; 0 failed outright; 1 clause — SEC-02 OS-egress — is impossible on the stand-in topology, honestly tracked as Pending, and needs a formal accept-or-hold decision; 2 bookkeeping decisions)
**Re-verification:** No — initial verification

> **Verification posture.** Evidence was REPRODUCED, not read: this verifier re-ran the full unit suite (249/249 green, 21.4 s), re-ran the resilience injection suite (the exact `pnpm test:resilience` command exited 0 with 7/7 on two runs; one run of three showed a transient unhandled child-process error — see Anti-Patterns), ran the `worker:boundary` and `denylist:diff` gates (both exit 0), and probed the LIVE dark-launch steady state directly: `curl 127.0.0.1:9090/healthz` → `{"ok":true,"sha":"9f667e2",...,"pid":8056}`, `/readyz` → `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}`, `/metrics.json` → all six lanes depth 0, breaker CLOSED, outbox 0/0, plus a read-only psql query against the stand-in DB (`spidernode-dev-db`) confirming the legacy cron still serving (monitor id=2, 1-min interval, 483 pings, +225 since the deploy window — hours of continued 1-min checks after the 2026-09-14 launch). SUMMARY claims were cross-checked against source under `src/worker/` (16 files, ~4,400 lines read in the verification pass) and `src/lib/ssrf.ts`.

## Goal Achievement

### Observable Truths

Decomposed from the five ROADMAP success criteria (the contract). Plan-level must_haves across 04-01..04-09 were checked at the artifact level and are subsumed by the table below.

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1a — Worker is a second PM2 app built from the same repo/SHA as web (one build, two artifacts) | ✓ VERIFIED | `ecosystem.config.js` worker stanza (`wait_ready:true`, `listen_timeout:30000`, `kill_timeout:20000`); `pnpm build` chains `next build` + `tsup` (package.json); SHA embedded at bundle time and reported live by `/healthz` (`sha:"9f667e2"` = the deploy-record release SHA, probed by this verifier); tsup.config.ts define block verified |
| 2 | SC1b — Dark-launched with scheduler paused, pipeline rehearsed, cron still performs every check | ✓ VERIFIED | Live `/metrics.json`: all 6 lanes depth 0, `oldestWaitingJobAgeMs` null, zero scheduler state (deploy record additionally proves `ZCARD …:delayed`=0, `EXISTS …:repeat`=0 direct in Redis); `WORKER_SCHEDULER_ENABLED=false` skips upserts only (src/worker/scheduler.ts:162-168; scheduler-flag tests); rehearsal 13/13 GREEN (04-REHEARSAL-EVIDENCE-20260914.md, PASS verdict); `src/instrumentation.ts` cron untouched (internal mode primary); live DB proof of continued cron service (above) |
| 3 | SC1c — `/healthz` and `/readyz` respond on `:9090`; readyz fails when Redis or Postgres is down | ✓ VERIFIED | Live curls by this verifier: both 200 with correct bodies. 503-on-down behavior proven by tests in the 249 (health.test.ts fail-path with real clients on dead ports); src/worker/health.ts:180-191 returns 503 unless BOTH pings pass; loopback-only bind |
| 4 | SC1d — Restarting the web app never interrupts checking | ✓ VERIFIED (execution evidence; not re-injected — state-mutating) | Deploy record continuity table: web hard-stopped 14:00:40Z, relaunched 14:01:02Z; cron re-registered, ticks resumed at the first boundary (14:02), `lastChecked` advanced T1→T2 (13:59→14:14), pings 245→258. Honest caveat recorded: 1 of 23 tick pings lost to the Windows `taskkill` hard-stop (in-memory batcher); the PM2/SIGTERM graceful-flush path is forward-tracked to the first VPS deploy (disposition 2). Checking itself never stopped; worker/readyz stayed green throughout |
| 5 | SC2a — Duplicate delivery of a check job produces exactly one ping row (claim advance + epoch idempotency key + owner-only lock) | ✓ VERIFIED | `claimDueSql`: CTE `FOR UPDATE SKIP LOCKED` + `GREATEST` catch-up advance (src/worker/claim.ts:37-56); `claimedCheckJobId` = `check:{monitorId}:{epochSec}` (queues.ts:165-167); `acquireMonitorLock` SET NX PX + UUID token, owner-only Lua compare-and-delete, TTL/3 renewal, abort-on-loss (locks.ts). Injection `tests/resilience/duplicate-delivery.test.ts`: two enqueues of the same row → 1 admitted job → 1 ping / 1 counter bump / 1 ONGOING incident / 1 outbox row — reproduced GREEN in this verifier's 7/7 run. (Redelivery-after-crash evidence-parity pings x2 with exactly-once state effects is the SC3 contract — see truth 9; the SC wording pair is internally consistent with the design's documented 01-01 pin) |
| 6 | SC2b — DOWN/RECOVERED/first-check transitions commit monitor + ping + incident + outbox in ONE synchronous transaction; exactly one Telegram alert per incident | ✓ VERIFIED | `applyTransition` (tier1.ts:323-408): one `db.transaction` — context read → evidence ping → conditional UPDATE (`WHERE status <> target AND isActive`) → incident open/resolve (ON CONFLICT on the partial unique `incidents_one_ongoing`) → outbox insert; ids never supplied (DAT-07). One-alert: relay dedup `alert:{incidentId}:down/recovered` `SET NX EX` 604800 s AFTER confirmed send, every attempt checks EXISTS first, ≤3 attempts (outbox.ts:84-91, D-47); relay tests in the 249 |
| 7 | SC2c — Routine UP results flush within 60 s via a guarded atomic update that never writes `status` | ✓ VERIFIED | `FLUSH_CADENCE_MS = 60_000` + flush-sweep scheduler + per-check flush job enqueue (engine/check.ts:321); `monitorFlushUpdateSql` (tier2.ts:379-440) references no status column (structural), additive counters, `GREATEST` lastChecked, responseTime monotonicity; RENAMENX snapshot + `write_guards` `ON CONFLICT DO NOTHING` in the same transaction (DAT-03); persist-tier2 + engine-check tests in the 249 |
| 8 | SC2d — Manual checks and non-UP monitors prioritized with documented worst-case latency | ✓ VERIFIED | `LANE_PRIORITY`: manualCheck/nonUpCheck = 1, routineCheck = 10; `addCheckJob` REFUSES unprioritized enqueues (Pitfall 3); manual lane never backlog-gated (queues.ts:50-60, 208-231, 332-351); worst-case documented with formula and M=100 example (docs/ARCHITECTURE-AUDIT.md:721, J-6) |
| 9 | SC3 — SIGKILL mid-job then restart: no lost/double-applied writes, counters correct, no second ONGOING incident; retries bounded 3-5 exp backoff + DLQ; SIGINT drains within kill_timeout | ✓ VERIFIED (behavioral — suite re-run green) | `tests/resilience/kill-mid-job.test.ts`: REAL spawned `dist/worker.js` child SIGKILLed past the Tier-1 COMMIT (`WORKER_TEST_CRASH_AFTER=tier1_commit` seam), restarted, stalled-redelivered → counters exactly-once, no second ONGOING, evidence pings x2 — reproduced GREEN (7/7, twice). `CHECK_JOB_OPTIONS`: attempts 5, exponential 2000 ms, `removeOnFail` 14 d (queues.ts:63-68); retries.test.ts in the 249. Drain: `drainAndTeardown` order load-bearing (index.ts:63-68) + shutdown.test.ts + rehearsal step 12 Linux-container leg (node PID 1, SIGINT → exit 0 in 317 ms) |
| 10 | SC4 — Postgres down: jobs retry, breaker opens + pauses enqueueing, backlog cap drops routine but never transitions; Redis down: pause by design, PG intact, staleness visible to users | ✓ VERIFIED (behavioral — suite re-run green) | postgres-down / redis-down / redis-restart / backlog-flood injections all GREEN in this verifier's runs; breaker 5-fail/60 s + HALF_OPEN probe + enqueue-side gate (breaker.ts, Pattern 6 — no queue.pause anywhere); backlog gate ~2× active monitors, routine-only (backlog.ts); observations.json carries the 7-case dataset regenerated 2026-09-14T13:46:57Z. Staleness: D-34 pin (tests/staleness-display.test.ts, in the 249) — NOTE the pinned surface is a frozen raw clock timestamp (`toLocaleTimeString`), not a literal "Xm ago" string; documented verify-existing disposition, surfaces staleness by freezing — see Anti-Patterns INFO |
| 11 | SC5a — SSRF layering enforced with passing test cases; OS-level egress rules ACTIVE on the worker host | ⚠ SPLIT — SSRF ✓ VERIFIED; OS-egress clause NOT MET (impossible on stand-in; honest Pending; needs human disposition) | SSRF: src/lib/ssrf.ts layers scheme allowlist before any I/O, resolve-then-validate 11-CIDR denylist per redirect hop (manual redirects, ≤5), 2 MB streamed cap (Content-Length never trusted), strict 10 s whole-exchange budget; 14 vector tests (incl. TC-SSRF-REDIRECT-PRIVATE-01, MAPPED-V6-01, SCHEME-01, SIZE-CAP-01) passed in the 249; engine↔runbook §10 denylist set-equality machine-gated — `pnpm denylist:diff` re-run green by this verifier (11 tokens). OS-egress: NO worker host exists (Windows dev-machine stand-in, 03-08 ratified); runbook §10 carries the concrete iptables/nftables text; enforcement forward-tracked to first VPS deploy (04-DEPLOY-RECORD disposition 3); REQUIREMENTS.md honestly shows SEC-02 Pending. **This looks intentional — override suggestion in Human Verification #1** |
| 12 | SC5b — Operator can trace one check end-to-end via monitorId-correlated logs + queue metrics (depth, job age, stalled count); maintenance dry-run reports without deleting; pipeline orders build → backup → migrate → worker (waits readyz) → web → smoke producing a synthetic ping row | ✓ VERIFIED | `jobLogger` binds monitorId+jobId into every check/persist line (logger.ts:34-38, engine/check.ts:223); relay logs monitorId on every alert line; live dark-launch worker log contains monitorId-correlated smoke lines (`.snapshots/dark-launch-worker.log`, 2 lines monitorId=3). Queue metrics verified LIVE on `/metrics.json` (per-lane depth wait/prioritized/delayed/active, oldestWaitingJobAgeMs, stalledCount, breaker, outbox latency). Maintenance dry-run default-true, only explicit `false` deletes (maintenance.ts:371-373; WR--13 tests). Pipeline: runbook §4/§4a ACTIVATED + executed as the dark launch (build→backup→migrate no-op→worker+readyz→web→smoke); rehearsal 13-step GREEN; two smoke ping rows evidenced (`62ff7108…` 97 ms, `68f9bbc0…` 178 ms, the second correctly `applied:false` — the DAT-04 duplicate-safe path) |

**Score:** 11/12 truths verified (1 clause of truth 11 — OS-egress active on host — cannot be true on a non-existent host; delivered mitigation verified; awaiting formal disposition)

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Scheduler-tick healthchecks.io heartbeat (review WR-01; audit §14.2 step 5) — absent from `processTick` today; legacy cron covers it while it lives | Phase 5 (WRK-09) | REQUIREMENTS.md maps WRK-09 to Phase 5 Pending ("healthchecks.io heartbeat moved to the worker scheduler tick (before any cron deletion)"); review itself says "land it before the Phase 5 cutover release at the latest" |
| 2 | PM2 `wait_ready`/`kill_timeout` handshake driven by a real supervisor; web-restart graceful SIGTERM flush; systemd Redis supervision | First VPS worker deploy (operational event, not a roadmap phase) | 04-DEPLOY-RECORD.md N/A-locally dispositions 1/2/4 with named consumption points |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/worker/**` (16 files) | Engine, queues, claim, locks, tiers, outbox, breaker, backlog, scheduler, health, maintenance, logger, db, connection | ✓ VERIFIED | All exist, substantive (no stubs), all wired through `src/worker/index.ts` boot; zero debt markers |
| `src/lib/ssrf.ts` | Canonical SSRF pipeline + WRK-05 classification | ✓ VERIFIED | 681 lines, layered defenses, shared classifier consumed by breaker + engine |
| `src/lib/../instrumentation.ts` cron | Untouched legacy path (dark-launch precondition) | ✓ VERIFIED | node-cron internal mode intact; live DB shows it serving |
| `ecosystem.config.js` | Second PM2 app stanza | ✓ VERIFIED | wait_ready/listen_timeout/kill_timeout pins present |
| `tsup.config.ts`, `vitest.config.resilience.ts`, `docker-compose.test.yml` | Build/test infrastructure | ✓ VERIFIED | Present; one-build-two-artifacts chain confirmed in package.json |
| `scripts/rehearse-worker.mjs`, `enqueue-smoke.mjs`, `redrive-outbox.mjs`, `seed-synthetic.sql`, `check-denylist-diff.mjs`, `check-worker-boundary.mjs` | Operator deploy tooling | ✓ VERIFIED | All present and substantive; boundary + denylist gates re-run green by this verifier |
| `tests/resilience/*` (7 cases + helper) | Failure-injection suite | ✓ VERIFIED | 1,673 lines; real spawned worker children, real SIGKILL, real docker stop/start injections; re-run green |
| `04-DEPLOY-RECORD.md` | Dark-launch evidence + dispositions | ✓ VERIFIED | Cross-checked against live state; every live claim reproduced |
| `04-VALIDATION.md` | Per-phase validation strategy | ⚠ TEMPLATE-ONLY (INFO) | Unfilled placeholder (status: draft, brace templates); phase validation actually ran through PLAN verify blocks + the verify chain — informational, no code impact |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `src/worker/index.ts` boot | All lane workers + scheduler + health | `registerDrainable` + `upsertSchedulersAtBoot` | ✓ WIRED | index.ts:138-167 registers every lane; verified in source |
| Check processor | Lock → SSRF → classify → Tier1/Tier2 → flush | `processCheckJob` | ✓ WIRED | engine/check.ts:220-340 full assembly incl. isStillOwner pre-commit gate (T-04-21) |
| Scheduler tick | Claim → enqueue | `processTick` → `claimDue` → `enqueueClaimedCheck` | ✓ WIRED | scheduler.ts:81-113; D-16 flag gates upserts only |
| Tier 1 | Outbox → relay → Telegram | alerts lane `processRelayJob` | ✓ WIRED | index.ts:151; relay dedup + mark-sent verified |
| Web app (legacy) | Postgres via Prisma | instrumentation cron | ✓ WIRED | Untouched; live evidence of continued service |

### Data-Flow Trace (Level 4)

Not a UI phase; the equivalent check is the live end-to-end smoke path: enqueue (Redis/BullMQ) → worker consumer → Tier-1 transaction → Postgres ping row. Verified live twice in the deploy record (ping ids `62ff7108…`, `68f9bbc0…`) and reproduced structurally by the resilience suite against the real bundle and real Postgres. ✓ FLOWING.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full unit/integration suite | `pnpm test` | 30 files, 249/249 passed, 21.4 s | ✓ PASS |
| Resilience injection suite (exact gate command) | `pnpm test:resilience` | run 1: 6/7 + 1 transient child-process error (exit 1); runs 2-3: 7/7, exit 0 | ✓ PASS (with flake warning) |
| Worker boundary gate | `node scripts/check-worker-boundary.mjs` | green, 16 files, exit 0 | ✓ PASS |
| Denylist diff gate (D-40) | `node scripts/check-denylist-diff.mjs` | OK, 11 CIDR tokens agree, exit 0 | ✓ PASS |
| Live worker health | `curl 127.0.0.1:9090/healthz` + `/readyz` | 200/200, pid 8056, sha 9f667e2, redis+db ok | ✓ PASS |
| Live metrics surface | `curl 127.0.0.1:9090/metrics.json` | 6 lanes depth 0, breaker CLOSED, outbox 0/0 | ✓ PASS |
| Cron still serving (read-only DB) | `docker exec spidernode-dev-db psql … SELECT` | monitor 2: 483 pings, lastChecked 17:59 (batcher-flush cadence), web /login 200 | ✓ PASS |

Not re-run by this verifier: `pnpm lint`/`typecheck`/`build`/`test:e2e` (verify-chain evidence from the deploy record's pre-flight gate at the release SHA; the review at 9af088a also passed over this tree). No state mutations were performed beyond the standard test stacks (isolated 5453/6390; the live stand-in 5454/6391 was only read).

### Requirements Coverage

32 requirement IDs mapped to Phase 4 in ROADMAP.md and REQUIREMENTS.md (the caller's brief said 33 — actual count in both documents is 32; no discrepancy in coverage).

| Requirement | Source Plan | Status | Evidence |
|-------------|------------|--------|----------|
| WRK-01..08, 10, 12, 13, 14 (12) | 04-01..04-09 | ✓ SATISFIED | Truths 1-9, 12; WRK-10 dark launch operator-approved 2026-09-14 |
| DAT-01..08, 10 (9) | 04-03..04-07 | ✓ SATISFIED | Truths 5-7; tier1/tier2/outbox mechanics + tests |
| RES-01..05 (5) | 04-02, 04-06, 04-08 | ✓ SATISFIED | Truths 9-10; injection suite green |
| SEC-01 | 04-03 | ✓ SATISFIED | Truth 11 (SSRF half) |
| SEC-02 | 04-09 | ⚠ PENDING (deliberate, D-17) | Truth 11 (egress half) — Human Verification #1 |
| OBS-01 | 04-02, 04-07 | ✓ SATISFIED | Live /metrics.json queue + outbox sections |
| OBS-02 | 04-01 | ⚠ PENDING (conservative) | Truth 12 delivers the correlation in code + live log; scheduler leg unexercised in production (scheduler paused) — Human Verification #3 |
| DEP-01, DEP-02 | 04-01, 04-09 | ✓ SATISFIED | Truths 1, 12; §4/§4a executed |
| Orphaned requirements | — | NONE | REQUIREMENTS Phase-4 set == roadmap set (32) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| tests/resilience (suite-level) | — | One-of-three runs errored: unhandled `Process.ChildProcess._handle.onexit` error, 1 file failed teardown, 6/7 passed; identical command green twice after | ⚠ Warning | Transient teardown flake in the injection suite; does not falsify any truth (behaviors proven green twice + at 04-08 close + in the deploy pre-flight), but Phase 5's D-33 tuning should note the flake |
| 04-REVIEW.md WR-02/WR-04/WR-05 | queues.ts / outbox.ts / tier1+tier2 | TOCTOU breaker-gate race into J-1 rollback; unbounded Telegram fetch inside the relay row transaction; naive-timestamp clock-domain mixing (latent, stand-ins run UTC) | ⚠ Warning (advisory) | Review found 0 Critical; none block an SC truth; WR-02/03 and WR-04 are robustness/audit-posture items worth landing before Phase 5 cutover |
| tests/staleness-display.test.ts + D-34 | — | SC4's literal "last checked Xm ago" is delivered as a FROZEN raw clock timestamp (stops advancing), not a relative-age string | ℹ️ Info | Documented verify-existing disposition (04-08); staleness IS user-visible; wording deviation only |
| .planning/phases/04…/04-VALIDATION.md | — | Unfilled template (placeholder braces, status: draft) | ℹ️ Info | Planning artifact unused; actual validation ran via verify chain + PLAN verify blocks; no code impact |
| src/worker/**, src/lib/ssrf.ts, scripts/* | — | Zero TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER markers; no stub returns | ✓ Clean | Debt-marker gate: green |

### Human Verification Required

### 1. SEC-02 / SC5 egress clause — accept-or-hold decision

**Test:** Decide the disposition of "OS-level egress rules active on the worker host" (SC5, SEC-02).
**Expected:** Accept formally via a frontmatter override (suggested text in the frontmatter above), or hold SEC-02 Pending (as REQUIREMENTS.md does) until the first VPS deploy applies runbook §10 and runs the probe set (public 80/443 ok; private ranges + 169.254.169.254 refused; readyz stays green).
**Why human:** No worker host exists on the ratified stand-in; the phase-deliverable half (runbook §10 concrete rules + the D-40 machine gate, re-verified green here) is done, but accepting a deferred must-have is an operator decision. Precedent: Phase 3's memory-alerting clause.

### 2. MVP-mode tag vs non-User-Story goal (bookkeeping)

**Test:** `gsd-tools query user-story.validate` on the Phase 4 goal returns false.
**Expected:** Reformat via `/gsd mvp-phase 4` or drop the `Mode: mvp` tag (Phase 3 dropped its tag after the same finding).
**Why human:** Mode metadata only; standard goal-backward was applied per Phase 2/3 precedent.

### 3. OBS-02 checkbox policy (bookkeeping)

**Test:** Code + live log deliver monitorId correlation on check→persist→alert; REQUIREMENTS keeps OBS-02 Pending.
**Expected:** Keep Pending until the Phase 5 cutover exercises the scheduler leg live, or mark complete now.
**Why human:** Conservative-accounting policy call; the scheduler leg has never emitted production per-monitor lines (schedulers are paused by design in dark launch).

### Gaps Summary

No failed truths. The machinery the phase promised exists, is substantive, is wired, and — critically — is behaviorally proven: this verifier independently re-ran the 249-test unit suite and the 7-case failure-injection suite (real SIGKILL child, real Postgres/Redis outages) and reproduced GREEN, ran the boundary and denylist gates, and probed the live dark-launch worker and stand-in database directly. The dark launch is genuinely live (worker pid 8056 at sha 9f667e2, readyz green, zero scheduler state, cron having served 225+ additional 1-minute checks since the operator approval window).

The single clause that cannot be verified — OS-level egress rules ACTIVE on a worker host — is impossible on the current topology (no such host), is honestly tracked as SEC-02 Pending, has its deliverable half (runbook §10 text + D-40 gate) verified green, and carries a named consumption point at the first VPS deploy. It needs a formal accept-or-hold decision, not code work. Two further items are bookkeeping decisions (mvp tag, OBS-02 checkbox). Advisory review warnings (WR-02/WR-04/WR-05, heartbeat WR-01→Phase 5 WRK-09) and one transient resilience-suite flake are recorded for Phase 5 consumption.

---

_Verified: 2026-09-14T18:27:24Z_
_Verifier: Claude (gsd-verifier)_
