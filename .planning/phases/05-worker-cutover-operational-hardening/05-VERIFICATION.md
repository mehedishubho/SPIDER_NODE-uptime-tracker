---
phase: 05-worker-cutover-operational-hardening
verified: 2026-09-19T21:28:00Z
status: passed
score: 13/13 must-haves verified
behavior_unverified: 0
overrides_applied: 0
human_verification:

  - test: "LIVE OPS FINDING (highest priority, act first): the running deletion-release worker (sha d55cad5, PID 9252, :9090) reports the outbox collector's failure sentinel on every scrape — /metrics.json `outbox: {unsent:-1, failed:-1, latency sample 0, oldestUnsentSeconds:-1}` — sustained across ~10 minutes of verification probing, while /readyz stays green (`SELECT 1` on the same pool passes) and the alerts BullMQ lane accumulates delayed retry jobs (delayed 2 -> 5 -> 16 over ~4 min). Web /login is HTTP 200. Host context at probe time: Docker Desktop engine pipe absent (docker CLI dead) yet 6391/5432/3007/9090 serving; resilience suite regenerated tests/resilience/observations.json at 2026-09-19T21:01Z (~90 min after the 18:45Z release)."
    expected: "Diagnose why collectOutboxMetrics' SQL fails while pool-level SELECT 1 succeeds (leading hypotheses: worker's DATABASE_URL repointed at a DB without the outbox table after the post-release host churn, or outbox-query-level failure/timeout). Per the D-23 design, a sustained -1 withholds the worker-outbox-age ping, so the hc.io check should have flipped down ~5 min after the failures began — confirm on the healthchecks.io dashboard whether worker-outbox-age is DOWN and whether its page fired (that firing would itself be OBS-03 working as designed: operators see trouble before users do)."
    why_human: "Requires the operator's DB credentials / hc.io dashboard — programmatic verification cannot authenticate (probes returned password-auth failures, deliberately not pursued). This is post-phase live operational state on the operator host, not a code defect verdict: the deletion-release proofs at 18:56Z showed the trio lockstep-advancing and outbox 0/0."

  - test: "Confirm the three REAL healthchecks.io checks (worker-heartbeat 600 s, worker-outbox-age 300 s, worker-redis-memory 1800 s per D-25) have paging/notification integrations enabled so a stopped worker tick actually pages a human"
    expected: "All three checks show notification channels ON in the hc.io dashboard; a dead tick produces an operator-visible page within the grace window (the flips themselves are proven — heartbeat's first real firing 2026-09-16T22:25:28Z, outbox-age firings 20:40:28Z and 22:20:28Z — but the 05-08 record hedges page delivery with 'if the operator's hc.io channel has alerting enabled')"
    why_human: "hc.io notification-channel configuration is operator-dashboard state; the read-only API key used for gate evidence does not expose integration config"

  - test: "Decide the runbook §7 disposition: 05-09-SUMMARY 'provides' claims 'Runbook §7 amendment: tarball restore on fresh install needs 2 node_modules junction shims' and PROJECT.md says 'Rehearsal finding (runbook §7 amendment)' — but DEPLOY-RUNBOOK.md §7 (last amended in a16759c, the 05-04 wave) contains NO junction/mklink text; the finding lives only in 05-DEPLOY-RECORD.md's 05-09 tier-2 entry and deferred-items.md"
    expected: "Either (a) add the amendment to docs/DEPLOY-RUNBOOK.md §7 (a short paragraph: restoring the retained 9f667e2 tarball from scratch needs `mklink /J node-cron-5efbb29b9a4eb14a node-cron` + `mklink /J pg-4c0d8067d674414d pg` after install; current builds structurally immune), or (b) formally accept the deploy-record + deferred-items placement and correct the SUMMARY/PROJECT phrasing. An operator following only the runbook during a real rollback would otherwise miss the one operational caveat the rehearsal discovered"
    why_human: "Documentation-placement decision; the rehearsal itself PASSED and the knowledge is committed in two places — this is a SUMMARY-claim vs artifact mismatch, not a missing capability"

  - test: "Bookkeeping decision: ROADMAP.md marks Phase 5 'Mode: mvp' but the phase goal is not in User Story format (gsd-tools user-story.validate -> false; backend-infrastructure goal, no 'As a ... I want to ... so that ...' form)"
    expected: "Either reformat the goal via /gsd mvp-phase 5 or drop the Mode: mvp tag for this phase (Phase 3 dropped its tag and Phase 4 recorded the same finding — 04-VERIFICATION.md human item 2). Verification proceeded standard goal-backward per Phase 2/3/4 precedent; no User Flow Coverage section was fabricated against a non-user-story goal"
    why_human: "Mode metadata preference; affects future MVP-mode UAT framing only, no codebase truth"
---

# Phase 5: Worker Cutover & Operational Hardening — Verification Report

**Phase Goal:** The worker becomes the only monitoring path through a gated overlap window, and operators gain early-warning signals plus a rehearsed rollback story.
**Verified:** 2026-09-19T21:28:00Z
**Status:** human_needed (13/13 truths verified, 0 failed; 1 live-operations finding on the running system needs operator eyes, plus 3 confirmation/bookkeeping decisions)
**Re-verification:** No — initial verification

> **Verification posture.** Evidence was REPRODUCED, not read, wherever the system allows it: this verifier EXECUTED the D-41 cron-remnant gate (`node scripts/check-cutover... check-cron-remnants.mjs` -> exit 0, 444 code files scanned across `src`, `dist/worker.js`, `.next/server` + package.json), probed the LIVE deletion-release worker on :9090 (`/healthz` -> `{"ok":true,"sha":"d55cad5","builtAt":"2026-09-19T18:14:35.277Z","pid":9252}` — the running build is exactly commit d55cad5), scraped the LIVE Prometheus exposition at `/metrics` (all required families present, `spidernode_redis_memory_percent 1.2`), fetched `/readyz` (redis + db ok, every lane wait/active depth 0, stalled 0), and curl'd web `/login` (HTTP 200). Migration discipline was git-verified independently (`git log -- drizzle/` -> last change 279fe14, Phase 3; working tree clean = zero Phase-5 migrations). The vitest suite could NOT be re-run in this environment (Docker Desktop engine down; the vitest global-setup requires the docker test stack — recorded below), so behavioral truths rest on the committed evidence the orchestrator designated as authoritative for gitignored snapshots, cross-corroborated by the machine-readable `tests/resilience/observations.json` (structured live-window entries match the deploy-record narrative), plus the live probes above. Plan-level must_haves across 05-01..05-09 were checked at the artifact level and are subsumed by the truth table.

## Goal Achievement

### Observable Truths

Decomposed from the four ROADMAP success criteria (the contract).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: During the overlap window both paths ran idempotently with zero monitoring gap — no monitor missed a scheduled check | ✓ VERIFIED | 05-DEPLOY-RECORD window #4b: GATE 5 (continuity gap-scan) PASS on a continuous 5 h window (2026-09-17 00:08Z–05:01Z); D-16 discipline honestly applied across windows #1–#4 (interruptions re-epoched the clock, gate runs 1–2 recorded FAIL on gate 4 — never dispositioned away); `tests/resilience/observations.json` carries the structured live corroboration (`legacy-batcher-overlap-clobber`, `legacy-batcher-deferral-overcheck` with second-precision timestamps matching the record); co-run due-filter behavior visible in both engines' logs |
| 2 | SC1: The healthchecks.io heartbeat came steadily from the worker scheduler tick through the window | ✓ VERIFIED | GATE 1 PASS via the hc.io flips record (D-17 — the dead-man switch IS the monitor); `src/worker/scheduler.ts:274` pings `WORKER_HC_PING_URL` at every completed tick, `/fail` on tick-level exception (line 287) before rethrow; post-deletion proof: trio lockstep-advancing 3117→3118→3120 across reads 40 s apart |
| 3 | SC1: Queue depth returned to ~0 | ✓ VERIFIED | GATE 2 (age-bounded queues + depth-0 drain between cycles) PASS [D-19]; LIVE NOW (verifier scrape 2026-09-19T21:2xZ): every lane wait/active depth 0, stalledCount 0 on all six lanes; co-run snapshot recorded "all lanes depth 0, outbox_unsent 0" |
| 4 | SC1: Telegram alert parity held for the full verification window | ✓ VERIFIED | GATE 3 PASS [D-48+D-05]: exactly one relayed alert per incident, `parity-evidence.json byteMatch: true` (windows #3 and #4), alerts DELIVERED to the operator's real chat (`sent:1` each, timestamps recorded); induced DOWN/RECOVERED executed through the real create path per D-11 |
| 5 | SC2: `instrumentation.ts` and `CRON_MODE` are deleted | ✓ VERIFIED | `src/instrumentation.ts` absent; zero `CRON_MODE` readers anywhere under `src/` (verifier grep); `node-cron`/`@types/node-cron` absent from package.json; deletion commit d55cad5 touches exactly 4 files (`.env.example`, `package.json`, `pnpm-lock.yaml`, `src/instrumentation.ts` −98 lines) — inside D-03's scheduler-only scope, no engine file |
| 6 | SC2: The build is grepped to keep cron remnants out | ✓ VERIFIED | `pnpm verify` chain: `... pnpm build && pnpm cron:remnants && pnpm test:e2e` — post-build, pre-e2e, enforcement mode (no `--advisory`); EXECUTED by this verifier: exit 0, 444 code files scanned across `src`, `dist/worker.js`, `.next/server` + package.json. ROADMAP's "CI greps the build" is realized as the verify-chain gate per the documented 02-CONTEXT D-01 no-CI precedent (script header records the amendment). ℹ️ Residual: `playwright.config.ts:63` still WRITES `CRON_MODE=vercel` into the e2e web env — an inert writer with zero readers, outside the gate's src/+build scan scope by design, logged in deferred-items.md for Phase-6 cleanup (see Deferred) |
| 7 | SC2: The worker is the sole monitoring path | ✓ VERIFIED | Nothing schedules the legacy engine (instrumentation.ts gone; `cron-logic.ts`/`db-batcher.ts`/`/api/cron/*` verified present-but-dormant per D-03); deletion-release boot log "recurring scheduling ACTIVE" + readyz green; web boot with zero cron lines; LIVE: the process answering on :9090 right now is sha d55cad5 (the deletion commit), PID 9252, uptime consistent with the 18:45Z restart; emergency lever proven answering post-deletion (HTTP 200 with Bearer secret, 401 negative control) |
| 8 | SC2: The external dead-man's switch pages if the worker tick stops | ✓ VERIFIED | Code: heartbeat pings on completed tick, `/fail` replaces success on enqueue failures/errors, all pings failure-isolated (Pitfall 3: one ping/check/tick, zero retries); three REAL hc.io checks graces 600/300/1800 s (D-25); REAL firings on genuine host outages recorded: worker-outbox-age flipped down 20:40:28Z and 22:20:28Z, worker-heartbeat's first real firing 22:25:28Z (2026-09-16) — flips proven on the hc.io record; page-delivery channel confirmation routed to human verification |
| 9 | SC3: Outbox-age alerting fires when rows exceed the threshold | ✓ VERIFIED | `scheduler.ts:163-199`: ping only while oldest unsent non-FAILED row < 90 s (`OUTBOX_AGE_ALERT_THRESHOLD_SECONDS = 90`), single crossing `/fail` marker then silence (grace pages), re-arm on recovery, -1-sentinel withholds with a warn log; input = `collectOutboxMetrics().oldestUnsentSeconds` (outbox.ts:673-746); REAL firings ×2 on 2026-09-16 genuine ~8-min health-loop outages (down→up transitions recorded; REQUIREMENTS OBS-03 cites this evidence). ⚠️ CURRENTLY: the live collector reports -1 — see Human Verification item 1 |
| 10 | SC3: Prometheus exports queue depth/age, stalled count, transition→alert latency, and Redis memory | ✓ VERIFIED | LIVE `/metrics` scrape by this verifier returned the full exposition: `spidernode_queue_depth` per lane/state, `spidernode_queue_oldest_job_age_seconds`, `spidernode_queue_stalled_events` (0 across lanes), `spidernode_outbox_unsent/failed/oldest_age_seconds`, `spidernode_outbox_alert_latency_seconds{stat=p50/p95/avg}`, `spidernode_redis_memory_percent 1.2`, breaker gauges; registry built from the boot-owned queue set + redis (no new connections, §25); `@prometheus-io/client` pinned exact 0.16.1, no deprecated prom-client; health server bind 127.0.0.1 only |
| 11 | SC4: Rollback is rehearsed — restoring the previous tarball returns the prior release cleanly | ✓ VERIFIED | Tier-2 rehearsal 2026-09-19 20:00–20:50Z on the retained pair (tarball 9f667e2 + pre-add-release dump): prior worker boots readyz green in dark-launch posture, web serves /login 200, legacy cron banner + per-minute passes, pings 710→740 with scheduled 28-ping flush, emergency lever 200/401; teardown clean; retention confirmed post-rehearsal (140 MB tarball + dump still present). Rehearsal FINDING (fresh-install restore needs 2 node_modules junction shims for pnpm-hash-mangled Turbopack externals; current build structurally immune) recorded in deploy record + deferred-items — ⚠️ but the claimed "runbook §7 amendment" is NOT in the runbook (see Human Verification item 3) |
| 12 | SC4: Expand/contract discipline holds — no drops or renames inside verification windows | ✓ VERIFIED | ZERO migrations authored in Phase 5 (D-44): `git log -- drizzle/` last change 279fe14 (Phase-3 CR-01, 2026-09-13); `git status --porcelain -- drizzle/ src/db/schema.ts` empty; only 2 migrations exist repo-wide (0000 baseline, 0001 worker-prereqs, both Phase 3/4); deletion release changed code and packaging only |
| 13 | SC4: Environment transition complete in `.env.example` (`REDIS_URL`, `EMAIL_PROVIDER`, `BETTER_AUTH_*` documented; `NEXTAUTH_*`/`CRON_MODE` retired or on a dated retirement path) | ✓ VERIFIED | Verifier read `.env.example` in full: `REDIS_URL` live-documented; `# EMAIL_PROVIDER=smtp  # goes live Phase 6 (EML-01)` and `# BETTER_AUTH_SECRET=  # goes live Phase 7 (AUTH-01)` commented placeholders (FND-07 contract kept); `NEXTAUTH_SECRET`/`NEXTAUTH_URL` carry "RETIRES PHASE 7 (AUTH-07)"; `CRON_MODE` entry absent (removed at d55cad5); `CRON_SECRET` annotated dormant §9 emergency lever "RETIRES PHASE 6" (SEC-06); three `WORKER_*_HC_PING_URL` vars documented with grace table. ℹ️ `BETTER_AUTH_URL` appears only via the NEXTAUTH_URL replacement note rather than its own placeholder line — minor wording nuance, dated path still unambiguous |

**Score:** 13/13 truths verified (0 present-but-behavior-unverified — every behavior-dependent truth carries live-executed, live-scraped, or real-firing evidence beyond symbol presence)

### Deferred Items

Informational — residuals with explicit later-phase owners (already recorded in PROJECT.md D-40 residuals and deferred-items.md; not actionable gaps).

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | `playwright.config.ts` still writes `CRON_MODE=vercel` (inert writer, zero readers) | Phase 6 | deferred-items.md 05-09 entry: "Clean up with the Phase-6 /api/cron/* route removal (SEC-06)"; runbook §9 Phase-6 death date |
| 2 | `EMAIL_PROVIDER` goes live; `BETTER_AUTH_*` arrives; `NEXTAUTH_*` retires | Phases 6/7 | `.env.example` dated annotations (EML-01, AUTH-01/AUTH-07); PROJECT.md residual legs |
| 3 | Grafana dashboards / persistent Prometheus | VPS era (post-milestone) | D-40 closeout; OBS-05's dashboard clause was "optional dashboard" — the export itself is delivered and live |
| 4 | Tier-2 tarball junction shims note | Runbook §7 amendment decision (human item 3) | deferred-items.md + deploy-record 05-09 tier-2 entry |

### Required Artifacts

Plan must_haves artifacts use prose strings (gsd-tools verify.artifacts parsed 0 structured entries), so all artifacts were verified manually — exists / substantive / wired.

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/worker/scheduler.ts` | pingDeadMan + tick-end/catch wiring, 90 s/70 % pins, injectable seams | ✓ VERIFIED | Lines 97-219: all three checks wired; thresholds exported; seams present |
| `src/worker/metrics.ts` | Prometheus registry, spidernode_ families wrapping existing collectors | ✓ VERIFIED | 203 lines, 11 Gauge families, collect()-time reads only |
| `src/worker/health.ts` | `/metrics` branch, 127.0.0.1 default bind, `redisMemorySnapshot` export | ✓ VERIFIED | Lines 133-235; loopback default confirmed |
| `src/worker/persist/outbox.ts` | `oldestUnsentSeconds`, 10 s telegram abort | ✓ VERIFIED | Lines 244, 673-746 |
| `src/worker/queues.ts` | BreakerOpenError skip, no claim rollback | ✓ VERIFIED | Lines 276-299; `rollbackFailedClaim` absent |
| `src/worker/db.ts` | `-c timezone=UTC` pool pin | ✓ VERIFIED | Line 48 |
| `src/app/api/monitors/[id]/check/route.ts` | awaited `flushBatches()` (D-04 pin) | ✓ VERIFIED | Line 38 `await flushBatches()` after `runCronChecks` |
| `scripts/gate-cutover.mjs` | 7-gate evaluator, D-16 sub-4 h pre-gate fail, evidence-block writer | ✓ VERIFIED | 820 lines; `MIN_WINDOW_SECONDS = 4*3600` enforced at line 748 BEFORE gate evaluation |
| `scripts/check-cron-remnants.mjs` | 4 finding classes, src/+build scope, docs/.planning excluded | ✓ VERIFIED | 240 lines; EXECUTED green by verifier |
| `scripts/rehearse-cutover.mjs` | leg-addressable choreography, egress sweep, evidence writer | ✓ VERIFIED | 2052 lines |
| `scripts/scrape-metrics.mjs` | D-27 throwaway scraper, marked for deletion | ✓ VERIFIED | Header: "THROWAWAY (D-27): deleted or archived after cutover — do not build on it" |
| `docs/ARCHITECTURE-AUDIT.md` §M4/§20.1 | gated-window amendment, four mechanisms, ungated ordering still binding | ✓ VERIFIED | Lines 1169-1203 |
| `docs/DEPLOY-RUNBOOK.md` §3c/§4a/§9 | choreography, memory dead-man, emergency lever + Phase-6 death date | ✓ VERIFIED | §3c line 180+, §4a steps 5-11 (lines 322-376), §9 lines 440-448 |
| `.env.example` | dated transition map | ✓ VERIFIED | Read in full — see truth 13 |
| `05-DEPLOY-RECORD.md` | window/deletion evidence, D-18/D-20 | ✓ VERIFIED | 78 KB; gate tables, approvals, post-deletion proofs, tier-2 rehearsal |
| `05-REHEARSAL-EVIDENCE.md` | per-leg rehearsal statuses | ✓ VERIFIED | 7/7 gate table, run 5 PASS (2026-09-16) |
| Tests (scheduler-heartbeat, outbox-age-ping, scheduler-flag, health-metrics, cutover-gates, cron-remnant-gate, monitors-id handler) | behavioral pins | ✓ EXISTS / ⚠️ NOT RE-RUN | All files present and substantive; vitest could not execute in this environment (docker test stack down — see Behavioral Spot-Checks) |
| `docs/DEPLOY-RUNBOOK.md` §7 junction amendment | claimed by 05-09-SUMMARY provides + PROJECT.md | ✗ MISSING (WARNING) | No junction/mklink text anywhere in the runbook (last runbook commit a16759c predates the rehearsal); content exists only in deploy record + deferred-items — human item 3 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| scheduler tick | healthchecks.io | `pingDeadMan(WORKER_HC_PING_URL)` on completed tick + catch path | ✓ WIRED | scheduler.ts:274, 287; env vars documented in .env.example |
| scheduler tick | outbox-age decision | `collectOutboxMetrics().oldestUnsentSeconds` via TickDeps seam | ✓ WIRED | scheduler.ts:169; same collector feeds /metrics.json (no second query path) |
| worker boot | metrics registry | `createMetricsRegistry({queues, redis})` → `startHealthServer` | ✓ WIRED | index.ts:98-100; live /metrics serving confirms |
| pnpm verify | remnant gate | `pnpm build && pnpm cron:remnants && pnpm test:e2e` | ✓ WIRED | package.json verify chain; executed green post-build |
| gate 1 | hc.io flips API | UUID from `WORKER_HC_PING_URL` tail + `X-Api-Key` from `HC_READ_ONLY_API_KEY` | ✓ WIRED | gate-cutover.mjs; flips evidence recorded in deploy record |
| operator approval | deletion release | D-18 APPROVED 2026-09-17T08:02Z → release d55cad5 2026-09-19 | ✓ WIRED | Deploy record + commit chain (8a7577d → d55cad5) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `/metrics` exposition | 11 gauge families | live BullMQ queues + Postgres outbox + Redis INFO | ✓ live scrape returned real values (depths, memory 1.2 %, stalled 0) | ✓ FLOWING |
| `/metrics.json` | outbox gauges | `collectOutboxMetrics()` SQL | ⚠️ currently -1 sentinel (query failure) — historically real (0/0 at deletion proofs, oldest age during window) | ⚠️ DEGRADED NOW (human item 1) |
| outbox-age ping decision | `oldestUnsentSeconds` | same collector | ✓ produced real firings ×2 on 2026-09-16 | ✓ FLOWING (mechanism) |
| manual check route | ping rows | `runCronChecks` + awaited `flushBatches()` | ✓ D-04 live pin in deploy record (in-request ping row, DB-frame timestamps) | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| D-41 cron-remnant gate enforcement over build outputs | `node scripts/check-cron-remnants.mjs` | `[cron-remnants] green — 444 code file(s) scanned across src, dist\worker.js, .next\server (+ package.json)` exit 0 | ✓ PASS |
| Worker sole path — live build identity | `curl 127.0.0.1:9090/healthz` | `{"ok":true,"sha":"d55cad5","builtAt":"2026-09-19T18:14:35.277Z","pid":9252}` | ✓ PASS (running build == deletion commit) |
| Queue depth ~0 / stalled 0 — live | `curl 127.0.0.1:9090/readyz` | every lane wait/active 0, stalledCount 0, redis ok, db ok | ✓ PASS |
| Prometheus exposition — live | `curl 127.0.0.1:9090/metrics` | all required families incl. latency p50/p95/avg + redis memory 1.2 | ✓ PASS |
| Web serving post-deletion | `curl 127.0.0.1:3007/login` | HTTP 200 | ✓ PASS |
| Outbox collector — live | `/metrics.json` outbox block | `-1` failure sentinel, sustained; alerts-lane delayed growing 2→16 | ✗ LIVE FINDING (human item 1; not a phase-artifact failure — see report) |
| vitest suite (scheduler-heartbeat, outbox-age-ping, health-metrics, cutover-gates, cron-remnant-gate) | `npx vitest run <file>` | global-setup fails: docker test stack down (`dockerDesktopLinuxEngine` pipe absent) | ? SKIP (environment — Docker Desktop not running; verifier did not start host services) |

### Probe Execution

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| `scripts/check-cron-remnants.mjs` | `node scripts/check-cron-remnants.mjs` | exit 0, 444 files, zero findings | PASS |
| Read-only DB probes (5454/5432) | node `pg` client | 5454 ECONNREFUSED; 5432 password-auth failed (credentials deliberately not pursued) | SKIP (no creds — operator environment) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| WRK-09 | 05-02, 05-08 | healthchecks.io heartbeat moved to the worker scheduler tick before any cron deletion | ✓ SATISFIED | scheduler.ts wiring landed in the add-release (before deletion); window gate 1 PASS; REQUIREMENTS marked Complete with evidence |
| WRK-11 | 05-01, 05-04..05-09 | Overlap-window cutover; deletion only after verification (heartbeat steady, queue depth ≈ 0, parity, counter deltas sane) | ✓ SATISFIED | 7/7 gates on a continuous 5 h window + D-20 GREEN + D-18 APPROVED precede d55cad5; ordering verifiable in the commit/evidence chain |
| DEP-03 | 05-06, 05-07, 05-08, 05-09 | Rollback story: tarball retained; expand/contract discipline | ✓ SATISFIED | Tier-2 rehearsal proof table; zero Phase-5 migrations; retention confirmed post-rehearsal |
| DEP-05 | 05-04, 05-09 | Environment transition complete; `.env.example` current | ✓ SATISFIED | Truth 13; REQUIREMENTS evidence cites D-40's dated-paths form |
| OBS-03 | 05-01, 05-02, 05-04 | Outbox-age alerting pages the operator | ✓ SATISFIED | Threshold wiring + real firings ×2; live -1 currently exercising the withhold-and-page path — human item 1 |
| OBS-05 | 05-03, 05-05 | Prometheus export with optional dashboard | ✓ SATISFIED | Live /metrics exposition verified by verifier scrape; optional dashboard deferred to VPS era per D-40 (within the "optional" clause) |
| OBS-02 (Phase-4 tag, bonus) | 05-08 | monitorId-correlated logs across scheduler→check→persist→alert | ✓ SATISFIED (early) | `obs-02-monitor2-correlated-logs.json` captured in windows #3/#4 per D-42; REQUIREMENTS updated |

No orphaned requirements: the REQUIREMENTS phase-5 set (WRK-09/11, DEP-03/05, OBS-03/05) exactly matches the union of plan `requirements` fields.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| docs/DEPLOY-RUNBOOK.md (§7) | — | Claimed amendment absent: 05-09-SUMMARY "provides" + PROJECT.md reference a "runbook §7 amendment" (junction shims) that does not exist in the runbook | ⚠️ Warning | Operator following only the runbook on a from-scratch rollback misses the junction step; content exists in deploy record + deferred-items — human item 3 |
| playwright.config.ts | 60-63 | Stale writer: sets `CRON_MODE=vercel` for e2e web env; comment still references the deleted `src/instrumentation.ts` | ℹ️ Info | Inert (zero readers), outside remnant-gate scope by design, deferred to Phase 6 |
| src/worker/scheduler.ts (maintenance upsert) | ~369-374 | WR-03 (05-REVIEW): maintenance cleanup scheduler pinned `dryRun: true` — no autonomous retention post-cutover | ⚠️ Warning | Recorded in 05-REVIEW.md; retention is currently the dormant §9 lever / manual; not a Phase-5 SC — operator decision |
| scripts/gate-cutover.mjs | — | IN-05/IN-06 (05-REVIEW): stale flips-cache precedence, lexicographic sample sort, CRON_MODE counted in comments | ℹ️ Info | Advisory review findings on edge cases; gate output for the real window cross-checked against live hc.io reads in the record |
| tests + src worker files | — | Debt markers (TBD/FIXME/XXX/TODO/PLACEHOLDER) | ✓ NONE | Scanned all phase-modified files — clean |

### Human Verification Required

Four items — see frontmatter `human_verification` for full detail. Priority order:

1. **LIVE OPS FINDING — outbox collector failing on the running deletion-release worker** (act first). `/metrics.json` outbox block reads -1 (sustained), readyz green, alerts-lane delayed jobs accumulating. Diagnose; confirm whether worker-outbox-age has flipped DOWN on healthchecks.io and paged (OBS-03 working as designed if so).
2. **Confirm hc.io paging integrations are ON** for the three real checks so a stopped tick pages a human.
3. **Runbook §7 junction-amendment decision** — claimed in SUMMARY/PROJECT, absent from the runbook; amend or accept current placement.
4. **MVP-mode tag bookkeeping** — goal is not User Story format (Phase 3/4 precedent).

### Gaps Summary

No ROADMAP success-criterion truth failed. The phase goal — worker as sole monitoring path through a gated, evidence-approved overlap window, with early-warning signals and a rehearsed rollback — is achieved and substantially reproducible: the deletion-release build (d55cad5) is the process live on :9090 at verification time, the remnant gate executes green over the build outputs, the Prometheus exposition serves every required family live, zero Phase-5 migrations exist, and the window/deletion/rehearsal evidence chain is internally consistent and machine-corroborated.

Three matters need a human: (a) a live operational degradation discovered during verification on the operator's host (outbox collector -1 with growing alerts-lane retries — post-phase host state, possibly linked to the Docker Desktop closure and post-release test activity around 21:01Z, and precisely the condition the phase's outbox-age dead-man is designed to surface); (b) the runbook §7 documentation-placement mismatch (a SUMMARY-claimed artifact that was never written into the runbook); (c) two bookkeeping confirmations (hc.io paging channels, mvp tag). Unit tests could not be re-run in this environment (docker test stack down) — the behavioral truths instead rest on live-scraped, live-executed, and real-firing evidence, which is stronger evidence than unit tests for this phase's operational claims.

---

_Verified: 2026-09-19T21:28:00Z_
_Verifier: Claude (gsd-verifier)_
