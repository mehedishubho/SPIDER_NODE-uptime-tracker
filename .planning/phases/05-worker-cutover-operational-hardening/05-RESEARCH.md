# Phase 5: Worker Cutover & Operational Hardening - Research

**Researched:** 2026-09-15
**Domain:** Gated overlap cutover (BullMQ worker vs legacy node-cron), dead-man's-switch paging (healthchecks.io), Prometheus export, operational rollback rehearsal
**Confidence:** HIGH (codebase-verified cutover mechanics; official-docs-verified external services; one flagged package)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Overlap write-path strategy (CR-02 resolution)

- **D-01 — Co-run the whole window:** cron stays live the entire window as the hot fallback; "disable nothing" (runbook §4a) wins over audit M4's disable-before-first-flush ordering, which is amended (D-08). The co-run is safe because the due-filter starves cron of work: the worker claims via `next_check_at` and updates `last_checked`, while cron's due-filter is `lastChecked + interval` — once the worker checks a monitor, cron naturally stops finding it due. Duplicate checks are transient (bounded to the takeover-sweep minute per monitor). Rollback all window = re-pause (D-06), no code rollback needed.
- **D-02 — Lost-update detection is pings-vs-counters reconciliation:** the counter gate compares per-monitor pings rows created in the window vs the `total_count` delta — a direct detector for the legacy-batcher read-modify-write clobbering a worker Tier-2 additive flush. D-37 (dry-run recompute) alone is blind to this class (clobbered counters carry self-consistent percent); both run.
- **D-03 — Deletion release is scheduler-only:** deletes `instrumentation.ts` + `CRON_MODE`. `cron-logic.ts`, `db-batcher.ts`, and the `/api/cron/*` routes stay dormant until Phase 6 deletes them with API-01/SEC-06. Corrects the 04-CONTEXT D-05-era belief that the whole engine could go at cutover. Bonus: the surviving `/api/cron/check` + `CRON_SECRET` is a manual emergency lever (operator can trigger a full cron pass by curl) until Phase 6.
- **D-04 — Manual-check flush is pinned now (route-level):** the add-release adds an explicit `flushBatches()` to the manual-check route so manual results keep landing after instrumentation.ts (the batcher's flusher host) is deleted; researcher verifies force-path semantics as belt-and-suspenders. The flush dies with the route in Phase 6.
- **D-05 — Duplicate-alert handling is verify + gate, no machinery:** researcher verifies cron-logic's alert-after-incident-create ordering (the partial unique ONGOING index may block duplicate incident creates, and thus duplicate alerts, naturally); the alert-parity gate asserts exactly 1 alert per incident; any transient takeover-minute duplicate is dispositioned in the deploy record.
- **D-06 — Pre-committed abort rule:** on any red gate, re-pause the scheduler (`WORKER_SCHEDULER_ENABLED=false` + worker restart); cron auto-resumes via the due-filter within one interval (zero-gap). Tarball restore is reserved for code-level breakage only.
- **D-07 — Release structure is 1 add-release → env-flip window → 1 deletion release:** all additions (heartbeat wiring, OBS-03/05, WR fixes, gate scripts, env docs) ship in one add-release and soak scheduler-off (dark-launch posture); the window itself is a pure `WORKER_SCHEDULER_ENABLED=true` flip; deletion is a separate release. Textbook expand/contract.
- **D-08 — Audit M4 amendment is full-analytical:** M4 is amended to describe the GATED WINDOW procedure with four named safety mechanisms — (1) due-filter starvation bounds write overlap to the takeover minute, (2) additive/guarded Tier-2 + unique-index-serialized Tier-1, (3) typed detection (D-02 + parity counts + D-37), (4) the re-pause abort rule. The original M4 ordering remains binding for UNGATED overlap.
- **D-09 — `WORKER_SCHEDULER_ENABLED` survives cutover as the permanent operator emergency/maintenance pause:** gentler than process-stop (consumers drain, health endpoints stay up, in-flight jobs finish); the runbook documents it as THE emergency action.
- **D-10 — New-monitor onboarding is pinned in the add-release:** the create route (or a claim-side fresh-monitor rule) sets `next_check_at` so post-cutover monitors are always claimable; researcher first verifies today's column default/INSERT behavior; the window test creates a monitor with the worker live and observes the first check + `first_check` outbox event (this doubles as the onboarding proof).
- **D-11 — Alert-parity evidence is induced, not awaited:** DOWN/RECOVERED is induced on an operator-owned monitor against a controllable target mid-window — exercising the real create path at the same time; asserted relayed bytes match the D-48 characterization pins (04-CONTEXT). Natural incidents count as bonus evidence only.

#### Window duration & green gates

- **D-12 — Window is 4–6h dense:** every monitor cycles multiple times, induced parity events fire, maintenance/retention is observed via manual enqueue (WRK-13 dry-run/manual path) instead of waiting for midnight. Machine burden: one afternoon.
- **D-13 — Window closes only on the full 7-gate checklist:** (1) heartbeat steady, (2) queue health, (3) alert parity (exactly 1 alert/incident, D-48 bytes), (4) counter gates (pings-vs-counters + D-37), (5) continuity gap-scan (per-monitor max ping gap ≤ interval + tolerance), (6) zero duplicate ONGOING incidents, (7) legacy-path log disposition.
- **D-14 — One typed gate command evaluates all 7 gates** from captured snapshots, emits PASS/FAIL per gate, and writes evidence into `05-DEPLOY-RECORD.md` (03-08/04 disposition-register pattern). A repo script — not tooling infrastructure.
- **D-15 — Rollback rehearsal (DEP-03) is two-tier:** pre-window live abort-lever drill (unpause → 10–15 min → re-pause → verify cron auto-resumes zero-gap → unpause → fresh window, kept under heartbeat grace or with the check paused); post-green tarball-restore rehearsal on the throwaway stand-in (D-32 pattern, 04-CONTEXT).
- **D-16 — Interruption restarts the window clock:** gates evaluate only over the final continuous stretch (≥4h, no operator-caused gap). A reboot gap IS a monitoring gap and is never dispositioned away.
- **D-17 — Gate 1 (heartbeat steady) is measured by the healthchecks.io check's own uptime record** over the window — the dead-man switch IS the monitor; validates the external paging path end-to-end; no local tick-counting machinery.
- **D-18 — Operator approval sits between window-green and the deletion release:** operator reviews the gate-script PASS output + evidence and explicitly approves before cron deletion ships (04-09 Task 4 pattern); recorded in `05-DEPLOY-RECORD.md` with date + verdict.
- **D-19 — Queue-health gate is age-bounded + drain:** no check-lane job older than a bounded age at any sample, and depth returns to 0 between claim cycles. The age bound doubles as the WRK-12 documented worst-case check latency.
- **D-20 — D-33 breaker/backlog tuning closes disposition-driven:** pinned constants (5-fail/60s, ~2x backlog, retries 3–5) stay unless window data shows a concrete problem; any tuning change lands with its evidence in the deploy record.

#### Heartbeat & paging channels

- **D-21 — Worker heartbeat pings a NEW dedicated healthchecks.io check** (`WORKER_HC_PING_URL`): clean attribution during the window (both dead-men alive independently); the runbook gains a typed operator step to pause/delete the old cron check at the deletion release (else it false-pages when its pings stop).
- **D-22 — Heartbeat keeps success + `/fail` signals** — behavior parity with today's cron; immediate explicit failure signal instead of waiting out the grace period.
- **D-23 — Outbox-age paging (OBS-03) is a third dead-man check:** the worker pings each tick only while the outbox is healthy (threshold ~60–120s, planner tunes vs the 5s relay cadence); a backed-up outbox stops pings → page after short grace; optional single `/fail` marker at threshold crossing. D-16-compliant: never the product Telegram bot.
- **D-24 — Redis 70%-memory alert moves to a worker-side dead-man now:** fourth check pinged each tick while memory < 70% (the worker already reads INFO for the metrics gauge). SUPERSEDES runbook §3c's VPS-cron form — amend §3c to "provision the check, the worker does the rest". Retires the forward-tracked VPS debt item and works on the stand-in today.
- **D-25 — Graces are 10/5/30 min** (heartbeat/outbox/memory): heartbeat 10 absorbs deploy restarts and pages within ~11 min of a dead worker; outbox 5 pages within ~6 min; memory 30 avoids flapping on spikes. Runbook-typed. (Three checks total with D-24's memory check; D-23's outbox check; D-21's heartbeat.)

#### Prometheus scope + WR-02..05 pack

- **D-26 — OBS-05 ships as prom-client `/metrics` on the worker's existing :9090 HTTP server:** no new port, no separate exporter process; gauges wrap the existing metrics collector (03-CONTEXT D-24/D-25 lineage).
- **D-27 — Window scraping is a throwaway scraper:** a minimal script curling `:9090/metrics` on an interval, writing samples to files — window evidence + gate input; deleted/archived after cutover.
- **D-28 — Grafana/dashboards are deferred to the VPS era:** Phase 5 ships export + throwaway scraping only; OBS-05's "optional dashboard" clause is satisfied by an explicit deferral note.
- **D-29 — All four 04-REVIEW warnings are fixed in Phase 5, toward the audit's intent:** WR-02 breaker TOCTOU window closed; WR-03 `rollbackFailedClaim` reconciled with audit claim semantics (tests/worker/queues.test.ts re-pinned); WR-04 telegramSend AbortSignal timeout + relay FOR UPDATE transaction scope (idle_in_transaction); WR-05 clock domains unified via the `-c timezone=UTC` pool option. Each lands as its own verifiable change with tests.

#### Window-open rehearsal (D-32 pattern)

- **D-30 — Full stand-in dry-run before the real window:** fresh anonymized snapshot on throwaway containers (03-05 pipeline); the whole sequence abbreviated — re-seed → unpause → 30–60 min real co-run (the first time cron + worker scheduler EVER run together; the dark launch ran scheduler-off) → induced DOWN/RECOVERED → gate script evaluates → abort drill → teardown. Stand-in env neutralizes real egress: dummy `TELEGRAM_BOT_TOKEN`, throwaway HC checks; researcher sweeps for any other real-side-effect (alerts, egress) before the rehearsal runs.
- **D-31 — The rehearsal runs the add-release build:** D-32 same-SHA discipline (04-CONTEXT); rehearsal failure blocks the release — fix, rebuild, re-rehearse.
- **D-32 — Green rehearsal is a hard precondition for opening the real window:** gate-script PASS on the stand-in co-run + abort drill executed + evidence recorded before the real window may open; failure blocks window-open until fixed and re-rehearsed.
- **D-33 — The rehearsal is encoded by extending the 04-09 operator-script pipeline** (seed/smoke/re-drive/rehearse pattern) with the cutover legs (re-seed/unpause/co-run/gates/drill), writing an evidence file; tier-2's post-green tarball rehearsal reuses the same stand-in rebuild.
- **D-34 — Rehearsal alert parity is proven at the payload boundary:** with the dummy token, real sends fail; the gate script asserts the outbox row payload (D-48 characterization shape) + exactly one relay attempt per incident; rows land FAILED as expected (a live FAILED-state exercise). Real delivery parity stays a real-window gate.
- **D-35 — The live pre-window abort drill still runs verbatim:** the stand-in proves mechanics; the live drill (10–15 min, D-15) proves the real lever on the real stack — env-wiring mistakes are only caught by a live pull (the 04 split-brain guard exists because exactly that happened), and the first real abort should never be under incident stress. Ends by rolling straight into the fresh window.
- **D-36 — Rehearse before deploying the add-release:** finalize code → build → rehearse that exact SHA on the stand-in → deploy to production → scheduler-off soak → window day. A rehearsal finding never means fixing code already live.
- **D-37 — The healthchecks.io legs run in the rehearsal via throwaway real checks** with notifications disabled: proves URL/grace config + the ping code path against the real service with zero page risk; deleted after; the real checks are provisioned at window-open.

#### Env transition & runbook §9 conflict (DEP-05)

- **D-38 — Runbook §9 conflict is ratified toward Phase 6:** §9 (line 386: endpoints + `CRON_SECRET` "deleted at the Phase 5 overlap-verified cutover") is amended in the add-release doc wave — deletion moves to Phase 6 (API-01/SEC-06); scheduler-only deletion stands; §9 documents the surviving curl-the-route emergency lever and its Phase-6 death date. One story across REQUIREMENTS, this decision, and the runbook.
- **D-39 — Future vars appear in `.env.example` as commented placeholders with arrival-phase annotations:** e.g. `# EMAIL_PROVIDER=smtp  # goes live Phase 6 (EML-01)`, `# BETTER_AUTH_SECRET=  # goes live Phase 7 (AUTH-01)` — satisfies criterion 4's "documented" clause; names + dates visible without implying the app reads them yet (the FND-07 "documents what the app reads" contract stays intact).
- **D-40 — DEP-05 marks Complete at Phase-5 end via dated paths:** criterion 4's own language ("documented … retired or on a dated retirement path") blesses the documentation form — `CRON_MODE` actually retired at the deletion release; `REDIS_URL` already present; `CRON_SECRET` annotated retired-Phase-6; `NEXTAUTH_*` annotated retired-Phase-7 (AUTH-07). PROJECT.md notes the residual live legs (EMAIL_PROVIDER Phase 6; BETTER_AUTH_*/NEXTAUTH_* retirement Phase 7).

#### Standing pins (no-ask decisions)

- **D-41 — The cron-remnant gate is a pnpm verify leg, not CI:** ROADMAP criterion 2's "CI greps the build" is realized per the 02-CONTEXT D-01 amendment precedent (no CI system exists) — a verify-chain grep keeps `instrumentation`/cron remnants out of the build from the deletion release onward.
- **D-42 — OBS-02 closes during the window:** monitorId-correlated structured logs across scheduler → check → persist → alert are observed as window evidence (gate 7 disposition family); the requirement stays Pending until that evidence exists (02-03/03-02 false-signal precedent).
- **D-43 — Batcher drain at cutover is covered, not built:** the pre-delete artifact's SIGTERM flush drains in-memory batches on the old code at deletion-release restart; D-04's route-level flush covers manual checks thereafter; the batcher arrays die with the Phase-6 route deletion.
- **D-44 — No schema-repair blocker; target zero new migrations:** 03-REVIEW CR-01 (stale `drizzle/meta/0001_snapshot.json`) and WR-01 (`bool_ops` on `idx_monitors_due`) are verified repaired (commit 279fe14; schema.ts:98 with explanatory comment). Like Phase 4, Phase 5 aims for zero new migrations; a 0002 ships only if planning finds a real gap — additive-only, full 03-05 rehearsal pipeline.
- **D-45 — 03-REVIEW WR-02 (rehearsal port binds 0.0.0.0, PII LAN-reachable) is fixed inside the rehearsal work:** the D-33 stand-in binds localhost.
- **D-46 — Deletion-release `.env.example` removals are reader-set-driven:** `CRON_MODE` removed; `HC_PING_URL` removed iff no surviving reader (researcher verifies whether cron-logic.ts reads it for `/fail` — it survives until Phase 6); `CRON_SECRET` + `NEXTAUTH_*` stay with dated annotations (D-40).

### Claude's Discretion

- Env-var naming for the new checks (`WORKER_HC_PING_URL` is pinned; the outbox/memory check var names are planner's choice — one var family).
- Gate-script CLI shape, snapshot capture format, and evidence-file layout (only the 7 gates + PASS/FAIL + record integration are pinned).
- Rehearsal script decomposition inside the 04-09 pipeline (which legs are separate scripts vs flags).
- Exact grep patterns for the D-41 cron-remnant gate.
- M4/§9/§3c amendment placement and wording (only the substance of D-08/D-38/D-24 is pinned).
- Outbox-age threshold exact value within the D-23 band (60–120s), tuned against the 5s relay cadence.
- Induced-parity monitor mechanics (controllable target form) per D-11.

### Deferred Ideas (OUT OF SCOPE)

- Cron routes + `CRON_SECRET` deletion — Phase 6 (API-01/SEC-06; D-38).
- `EMAIL_PROVIDER` live — Phase 6 (EML-01; D-39/D-40).
- `BETTER_AUTH_*` live + `NEXTAUTH_*` retirement — Phase 7 (AUTH-01/AUTH-07; D-40).
- Grafana / persistent Prometheus — VPS era (D-28).
- SEC-02 OS-egress enforcement — first VPS deploy (formal override already accepted 2026-09-15).
- WR-05 sibling (03-REVIEW): rehearse-migrations.mjs journal-count hard-code — fix before Phase 7 rehearsal reuse (not Phase 5 work).
- WR-06 sibling (03-REVIEW): limiter keys on raw `x-forwarded-for` — pairs with Phase 6 S-series security work.
- OBS-04 Bull Board — Phase 7 (requires Better Auth admin plugin).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WRK-09 | healthchecks.io heartbeat moved to the worker scheduler tick (before any cron deletion) | Worker tick has NO heartbeat today (verified: `src/worker/scheduler.ts` has zero HC references — WR-01 open); wiring point is `processTick`; hc.io ping API verified (success + `/fail`, 5 pings/min cap — 30s tick = 2/min, safe); new dedicated check per D-21/D-22 |
| WRK-11 | Overlap-window cutover: cron + worker run idempotently together; `instrumentation.ts` cron + `CRON_MODE` deleted only after verification | Due-filter starvation argument verified against real code (cron-logic.ts:33-46 due-filter; Tier-1/Tier-2 advance `last_checked`); takeover-minute race mechanics fully mapped (see Pitfall 4); sole-reader deletion surface verified (node-cron + CRON_MODE read only by instrumentation.ts); 7-gate evidence sources identified (hc.io flips API, metrics.json, outbox/DB snapshots) |
| DEP-03 | Rollback story: previous tarball retained; expand/contract discipline; rehearsed restore | Two-tier rehearsal (D-15/D-33) mapped onto existing rehearse-worker.mjs + 03-05 snapshot machinery; Windows no-SIGTERM caveat found for the batcher-drain leg (Pitfall 1); zero-migration posture (D-44) keeps contract discipline trivially true |
| DEP-05 | Environment transition: `REDIS_URL`, `EMAIL_PROVIDER`, `BETTER_AUTH_*` documented; `NEXTAUTH_*`/`CRON_MODE` retired or dated | Current `.env.example` inventory taken (93 lines, no WORKER_HC_PING_URL/email/auth placeholders yet); HC_PING_URL sole reader = instrumentation.ts (verified by grep) → removable at deletion release per D-46; D-39/D-40 annotation forms specified |
| OBS-03 | Outbox-age alerting (rows older than N seconds page the operator) | Third dead-man check per D-23; GAP FOUND: `collectOutboxMetrics` (outbox.ts:655) reports counts + latency but NOT oldest-unsent age — must be extended (additive) for the threshold; outbox.created_at is timestamptz so `now() - created_at` is clock-safe |
| OBS-05 | Prometheus export (BullMQ telemetry + custom gauges), optional dashboard | prom-client is DEPRECATED on npm — successor `@prometheus-io/client` 0.16.1 (official prometheus/client_js) verified + flagged SUS (too-new); scrape-time `collect()` gauges wrap the existing collector; `/metrics` is a new branch on the loopback :9090 handler; dashboard deferred (D-28) |
</phase_requirements>

## Summary

Phase 5 is an operations choreography phase built almost entirely from machinery that already exists: the dark-launched worker (scheduler off since 2026-09-14), the 04-09 operator-script pipeline, the 03-05 snapshot/rehearsal tooling, and the metrics collector feeding `/metrics.json`. The genuinely new code is small and additive: heartbeat/outbox-age/memory ping wiring in the worker tick, a prom-client `/metrics` endpoint on the existing :9090 health server, the four 04-REVIEW warning fixes (WR-02..05), an outbox-age gauge, and two repo scripts (gate evaluator + throwaway scraper). The hard part is not the code — it is the window itself, because **zero co-run minutes have ever existed**: the dark launch verified the worker with the scheduler off, so takeover-sweep dynamics, duplicate-alert behavior, and due-filter starvation have never been observed live anywhere (CONTEXT "Specifics").

Codebase verification confirmed every load-bearing safety claim with one important correction and several sharp edges. The due-filter starvation argument (D-01/D-08) holds exactly as stated: cron's due-filter is `lastChecked + interval` (cron-logic.ts:33-46) and both worker write tiers advance `last_checked`. But the D-05 hypothesis is only half-true: cron-logic sends its Telegram alert BEFORE the incident create and BEFORE any DB write (cron-logic.ts:102-135 vs :172-195), from a stale in-memory status read with an UNGUARDED monitor update — so the partial unique ONGOING index blocks duplicate incidents (by throwing — `prisma.incident.create` has no ON CONFLICT) but cannot block duplicate alerts or the counter clobber. Duplicate-alert exposure in the takeover minute is real, bounded, and disposition-only (D-05) — and induced-parity mechanics (D-11) can avoid the race entirely by inducing transitions on a monitor the worker just made not-due. D-04's route-level flush already exists (manual-check route line 38) — the add-release pins, not adds. D-10's create-path concern is already satisfied: `next_check_at` is nullable with no default and NULL means due, so new monitors are claimable within one tick today; setting a non-NULL value at create would actually DELAY the first check versus cron's immediate-first-check parity — the correct pin is "leave NULL + test-pin the claimability."

The one external-package decision is forced: **`prom-client` is deprecated on npm** ("replaced by `@prometheus-io/client`") — the official Prometheus client_js continues under the `@prometheus-io/client` scope, v0.16.1 (2026-08-27), repo github.com/prometheus/client_js, maintained by the Prometheus team. It is registry-flagged SUS only for recency; the trust chain is strong (the deprecation pointer comes from prom-client itself), but per protocol the planner must gate the install behind a `checkpoint:human-verify`. Its scrape-time `collect()` gauge model maps one-to-one onto the existing lazy `/metrics.json` provider pattern, and its Node support (22/24/26) matches the project pin (`>=22 <25`, local 24.15.0). healthchecks.io mechanics are verified for all three new dead-man checks: success + `/fail` ping forms, 5-pings-per-minute-per-check cap (a 30s tick = 2/min — safe), and — key for D-17 — the Management API v3 `flips/` endpoint returns timestamped up/down events filterable by window start/end, which is the gate-1 "heartbeat steady" evidence source with no local tick-counting machinery.

**Primary recommendation:** Structure the phase as D-07's three releases around one rehearsed choreography — add-release (heartbeat wiring inert scheduler-off + OBS-03/05 + WR fixes + gate/scraper scripts + docs), stand-in rehearsal of that exact SHA (D-30/D-31/D-32), then the live window (D-49 re-seed → unpause → abort drill → 4-6h co-run → 7-gate script → operator approval), then the scheduler-only deletion release (with the Windows curl-flush substitution before web stop, the old-check pause step, and node-cron dependency removal). Pin D-04/D-10 as tests, not code changes.

## Project Constraints (from CLAUDE.md)

- **GSD workflow enforcement:** all file changes through GSD entry points (`$gsd-quick`, `$gsd-debug`, `$gsd-execute-phase`) — this research runs under that workflow.
- **Behavior compatibility is the core constraint:** monitoring semantics preserved through cutover — 1-strike DOWN, lifetime uptime math, Telegram alert content, public API shapes. Every gate in this phase exists to prove it.
- **Deployment shape:** single VPS target (currently the operator-ratified local stand-in: spidernode-dev-db :5454 + spidernode-prod-redis :6391), two PM2 apps (currently plain processes), forward-only additive-first migrations, `readyz` health gates.
- **PostgreSQL is the source of truth; Redis is infrastructure only** — never hand-roll state into Redis.
- **Dead-man paging via healthchecks.io, never the product Telegram bot** (03 D-16) — D-21/D-23/D-24 instantiate it three more times.
- **Conventions that bind new Phase-5 code:** `@/*` imports; 2-space indent; English comments only; match file quoting style; worker code stays inside the D-08 boundary (no `next/*`, `react`, `@/app/*` imports under `src/worker/**` — machine-gated by `pnpm worker:boundary`); pino logs carry ids only, never secrets/connection strings; error handling via try/catch + `console.error("<Context>:", error)` on the web side, structured pino on the worker side; explicit `select` to avoid field leaks; shadcn/sonner conventions for any UI (none expected this phase).
- **Prisma freeze:** legacy Prisma paths (cron-logic, db-batcher, monitors routes) stay frozen as-is — Phase 5 does not migrate them; they die in Phase 6/7.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Monitor scheduling & checking | Worker process (BullMQ claim + check lanes) | Legacy node-cron in web process (fallback through window; deleted at cutover) | WRK-01/WRK-11: worker owns execution; cron is the self-suppressing hot fallback during the gated window only |
| Monitoring-pause detection (dead-man) | External: healthchecks.io (4 checks) | Worker tick (ping emission only) | R-1/D-17: external detection must survive the worker itself dying; the tick only emits pings, never judges health |
| Alert delivery | Worker outbox relay lane | — | DAT-05: outbox-driven, dedup-guarded; cron's direct-send path is the legacy form, parity-gated this phase |
| Queue/runtime metrics collection | Worker process (collectQueueMetrics + collectOutboxMetrics + breaker state) | Throwaway scraper (window evidence only) | OBS-01 lineage; D-26: prom-client wraps the collector, adds no collection logic |
| Prometheus exposition | Worker health server (:9090, loopback) | — | D-26: `/metrics` joins /healthz, /readyz, /metrics.json on the existing node:http handler |
| Gate evaluation (7 gates) | Repo script (operator-run, typed snapshots) | 05-DEPLOY-RECORD.md (evidence persistence) | D-14: a script, not infrastructure; evidence lands in the disposition register |
| Cutover release mechanics | Operator (runbook §4/§4a + gate script) | PM2/process restarts | The window is an env flip + restart choreography, not application logic |
| Env contract documentation | `.env.example` (repo) | Runbook (provisioning steps) | FND-07 contract: document what the app reads; D-39 annotations for future vars |
| Data correctness under overlap | PostgreSQL constraints (partial unique ONGOING, write guards) + Tier-1 conditional UPDATE | Gate 4/6 detectors (D-02 pings-vs-counters, D-37 recompute) | Defense in depth already shipped in Phase 4; Phase 5 proves it holds under the first real co-run |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@prometheus-io/client` [WARNING: flagged as suspicious by the legitimacy gate — too-new (0.16.1 published 2026-08-27). Trust chain is strong: official repo github.com/prometheus/client_js, maintainers include prombot (Prometheus team); the pointer comes from prom-client's own deprecation notice. Planner MUST add `checkpoint:human-verify` before install.] | 0.16.1 | Prometheus exposition: Gauge with labels, scrape-time `collect()`, `registry.metrics()` text format for `/metrics` | The official continuation of `prom-client` (6.6M dl/wk, now DEPRECATED on npm: "prom-client has been replaced by @prometheus-io/client") [VERIFIED: npm registry] |
| bullmq | 6.3.4 (installed) | Queue topology being cut over to | Unchanged from Phase 4 — pinned exact |
| ioredis | ^6.0.0 (installed) | Redis client (INFO for memory gauge) | Unchanged |
| pg | ^8.22.0 (installed) | Pool; carries the WR-05 `options: "-c timezone=UTC"` fix | `ClientConfig.options?: string` typed pass-through verified in shipped @types/pg [VERIFIED: codebase] |
| node-cron | ^4.6.0 (installed — REMOVE at deletion release) | Legacy scheduler, dies with instrumentation.ts | Sole reader is instrumentation.ts (verified by grep) — dep + @types/node-cron removable in the deletion release [VERIFIED: codebase] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| undici/fetch (global) | Node 24.15.0 global fetch | Heartbeat pings + WR-04 `AbortSignal.timeout(10_000)` | All worker-side HTTP (verified locally) [VERIFIED: local runtime] |
| healthchecks.io (external service) | — | 4 dead-man checks (heartbeat, outbox-age, memory, legacy cron until deletion) | Pinging API + Management API v3 (flips) [CITED: healthchecks.io/docs] |
| tsup / tsx / vitest / playwright | installed | Build + test gates unchanged | pnpm verify chain + test:resilience |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@prometheus-io/client` | deprecated `prom-client` 15.1.3 | Rejected: registry-deprecated; installing a deprecated name in new code invites a forced migration later; API is compatible enough that the switch is just the import name |
| Custom text-exposition formatter (zero deps) | `@prometheus-io/client` | Rejected: hand-rolling the Prometheus exposition format (escaping, HELP/TYPE lines, metric family ordering) is a Don't-Hand-Roll item; the library is one small import |
| statsd / OpenTelemetry export | prom-client /metrics | Out of scope: OBS-05 names Prometheus; D-26 pins the form |

**Installation:**
```bash
pnpm add @prometheus-io/client   # gated behind checkpoint:human-verify (SUS: too-new)
# at the deletion release only:
pnpm remove node-cron && pnpm remove -D @types/node-cron
```

**Version verification (this session):** `@prometheus-io/client` 0.16.1 (published 2026-08-27), `prom-client` 15.1.3 (2024-06-27, deprecated), both via `npm view` [VERIFIED: npm registry].

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@prometheus-io/client` | npm | 0.16.1 published 2026-08-27 (scope rename; lineage back to prom-client 15.x/2024 and client_js 0.x before that) | 83,869/wk and growing | github.com/prometheus/client_js (official Prometheus org) | SUS ("too-new") | Flagged — planner inserts `checkpoint:human-verify` before install |
| `prom-client` | npm | ~10 yrs (as prom-client) | 6.6M/wk | github.com/siimon/prom-client | SUS ("deprecated") | AVOID — deprecated: "prom-client has been replaced by @prometheus-io/client" |
| `node-cron` (removal) | npm | — | — | — | OK (existing dep) | Removed at deletion release (sole reader deleted) |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** `@prometheus-io/client` (reason: recency of the scope rename — provenance verified: official Prometheus org repo, prombot/nexucis/juliusv maintainers, deprecation pointer from the old package itself; no postinstall scripts on either package).

*`@prometheus-io/client` was discovered via `npm view prom-client deprecated` (registry-driven), so it carries no [ASSUMED] tag; the SUS flag stands until the checkpoint clears it.*

## Architecture Patterns

### System Architecture Diagram — the gated cutover

```
ADD-RELEASE (scheduler-off soak, dark-launch posture)
  heartbeat wiring (inert: no ticks fire) + /metrics + outbox-age gauge
  + WR-02..05 fixes + gate/scraper scripts + M4/§9/§3c/runbook amendments + .env.example docs
        |
        v
D-30 STAND-IN REHEARSAL (throwaway 5460/6460/9460-class stack, same SHA, dummy TELEGRAM_BOT_TOKEN,
  throwaway hc.io checks w/ notifications off)
  re-seed (D-49 SQL) -> unpause -> 30-60 min REAL co-run (first in project history)
  -> induced DOWN/RECOVERED (payload-boundary parity, D-34) -> gate script -> abort drill -> teardown
        |  PASS = hard precondition (D-32)
        v
LIVE WINDOW-OPEN (stand-in prod: 5454/6391, real hc.io checks provisioned per D-37)
  D-49 re-seed UPDATE -> WORKER_SCHEDULER_ENABLED=true + WORKER RESTART (flag is boot-read)
  -> D-35 live abort drill (unpause 10-15 min -> re-pause -> cron auto-resumes zero-gap -> unpause)
        |
        v
4-6h DENSE CO-RUN WINDOW (D-12/D-13)
  cron (1-min, self-suppressing via due-filter lastChecked+interval)   WORKER SCHEDULER (30s tick)
     |  takeover-minute overlap only                                      claim FOR UPDATE SKIP LOCKED
     |                                                                    advances next_check_at (GREATEST, D-50)
     |                                                                    + Tier-1/Tier-2 advance last_checked
     |                                                                    ==> cron starves within one interval
     |                                                                      +--> heartbeat ping -> hc.io #1 (WORKER_HC_PING_URL)
     |                                                                      +--> outbox-age healthy ping -> hc.io #2 (stop = page)
     |                                                                      +--> Redis memory <70% ping -> hc.io #3
     +--> legacy HC_PING_URL (old check, alive until deletion release)     +--> checks -> Tier1 (transitions+outbox) / Tier2 (routine)
     +--> legacy alerts (direct send, stale-read gated)                    +--> relay (5s) -> Telegram (D-48 byte parity)
                                                                            +--> :9090/metrics <-- throwaway scraper (D-27)
        |
        v
GATE SCRIPT (D-14): 7 gates from snapshots -> PASS/FAIL -> 05-DEPLOY-RECORD.md
  [1] hc.io flips zero-down over window (D-17)  [2] queue age+drain (D-19)  [3] alert parity 1/incident
  [4] pings-vs-counters + D-37 recompute        [5] per-monitor max ping gap  [6] zero dup ONGOING
  [7] legacy-path log disposition
        |  all PASS -> operator approval (D-18)
        v
DELETION RELEASE (scheduler-only, D-03)
  rm src/instrumentation.ts + CRON_MODE + node-cron dep | curl /api/cron/check (flush) BEFORE web stop (Windows)
  .env.example: -CRON_MODE -HC_PING_URL, dated annotations (D-39/D-40/D-46) | pause/delete old cron hc.io check (D-21)
        |
        v
STEADY STATE: worker = sole monitoring path; /api/cron/check + CRON_SECRET = dormant emergency lever (dies Phase 6)
  WORKER_SCHEDULER_ENABLED = permanent operator pause lever (D-09)
```

### Recommended Project Structure (Phase-5 additions)

```
src/worker/scheduler.ts        # + heartbeat/ping wiring at end of processTick + catch paths (WR-01/D-21..24)
src/worker/health.ts           # + /metrics branch (prom-client registry) beside /metrics.json
src/worker/metrics.ts          # NEW (suggested): prom-client registry + gauges wrapping existing collectors
src/worker/persist/outbox.ts   # telegramSend AbortSignal.timeout (WR-04); + oldest-unsent-age in collector
src/worker/queues.ts           # WR-02/WR-03 fix sites (219-225, 238-244, 282-321)
src/worker/db.ts               # WR-05: options: "-c timezone=UTC" on the Pool
scripts/gate-cutover.mjs       # NEW: 7-gate evaluator over snapshots -> PASS/FAIL + record evidence (D-14)
scripts/scrape-metrics.mjs     # NEW: throwaway window scraper (D-27; archived after cutover)
scripts/rehearse-cutover.mjs   # NEW or rehearse-worker.mjs extension: D-33 cutover legs
scripts/check-cron-remnants.mjs# NEW: D-41 verify leg (activates at deletion release)
tests/worker/*                 # new: heartbeat, /metrics, gates logic, re-pinned queues tests
```

### Pattern 1: Due-filter starvation (the load-bearing co-run safety argument)

**What:** Two independent write paths coexist safely because the worker's claim advances `next_check_at` (atomic, `GREATEST` catch-up) AND both worker write tiers advance `last_checked` — while cron's due-filter is a pure read of `lastChecked + interval` (cron-logic.ts:33-46). Once the worker checks a monitor, the next cron pass stops finding it due. No coordination protocol, no disable step.

**When to use:** The M4 amendment (D-08) must carry the full argument (verified against real code):
1. Worker Tier-1 writes `last_checked = now()` inside the conditional UPDATE (tier1); Tier-2 flush writes `GREATEST(last_checked, staged)` — both advance it.
2. Cron's filter re-reads `lastChecked` per pass — starvation within one interval of the worker's check.
3. Worst-case overlap: cron fetched the monitor row just before the worker's write landed → one duplicate check that window (bounded to the takeover-sweep minute per monitor).
4. Routine-UP results land via Tier-2 flush (≤60s) — the starvation lag is therefore up to ~1 interval + flush cadence for routine checks, still bounded.

**Example (the due filter being starved):**
```typescript
// Source: src/lib/cron-logic.ts:33-46 (verbatim behavior)
const monitorsToCheck = force
  ? monitors
  : monitors.filter((monitor) => {
      if (!monitor.lastChecked) return true;           // never checked -> due now
      const nextCheckTime = new Date(
        monitor.lastChecked.getTime() + monitor.interval * 60 * 1000,
      );
      return now >= nextCheckTime;                      // worker advanced lastChecked -> false
    });
```

### Pattern 2: Dead-man checks — one check, one meaning (×3 instantiations)

**What:** The worker tick pings a dedicated healthchecks.io check per signal; health = pinging, silence = page. Success ping on tick completion; optional `/fail` on explicit failure (D-22 parity with instrumentation.ts:39-51).

**When to use:** All three window checks (heartbeat, outbox-age, memory) follow one shape — one URL env var each (one var family, planner names them), pinged from `processTick`, never rethrowing (audit §14.2 step 5: heartbeat errors must never fail the tick).

**Example:**
```typescript
// Source: docs/ARCHITECTURE-AUDIT.md §14.2 step 5 + verified hc.io ping forms
async function pingDeadMan(base: string | undefined, fail = false): Promise<void> {
  if (!base) return;
  try {
    await fetch(fail ? `${base}/fail` : base, { signal: AbortSignal.timeout(5_000) });
  } catch { /* never fail the tick on heartbeat errors (audit §14.4 row 3) */ }
}
// processTick end: await pingDeadMan(process.env.WORKER_HC_PING_URL);
// catch paths:    await pingDeadMan(process.env.WORKER_HC_PING_URL, true);
```

Rate-limit note [CITED: healthchecks.io/docs/http_api]: do not exceed 5 pings/minute per check — a 30s tick emits 2/min per check; keep exactly one ping per check per tick (no retry loops).

### Pattern 3: prom-client gauges wrapping the existing collector (D-26)

**What:** Gauges with a scrape-time `collect()` function pull from the existing collectors — identical philosophy to `/metrics.json`'s lazy providers (health.ts:122-147). No new collection logic, no background intervals.

**Example:**
```typescript
// Source: github.com/prometheus/client_js README (fetched this session) [CITED]
import client from "@prometheus-io/client";

const registry = new client.Registry();
new client.Gauge({
  name: "spidernode_queue_depth",
  help: "Jobs per lane by state",
  labelNames: ["queue", "state"],
  registers: [registry],
  async collect(this: any) {           // NOT an arrow fn — `this` must bind (README note)
    const snap = await collectQueueMetrics(queues);
    for (const [lane, m] of Object.entries(snap.queues))
      for (const [state, n] of Object.entries(m.depth))
        this.set({ queue: lane, state }, n);
  },
});
// health.ts handler: if (path === "/metrics") {
//   res.writeHead(200, { "content-type": registry.contentType });
//   res.end(await registry.metrics()); }
```
Metric families required by criterion 3: queue depth (per lane/state), job age (`oldestWaitingJobAgeMs`), stalled count, transition→alert latency (wrap the existing p50/p95/avg computation as gauges), Redis memory percent (from `redisMemorySnapshot`), plus outbox unsent/failed/oldest-age. Prefix (e.g. `spidernode_`) is planner's choice. 0.16.x note: `registry.metrics()` is async (await it); `MetricType` is a string union; cluster/IPC features unused here (single process) [CITED: client_js CHANGELOG].

### Pattern 4: Expand/contract release trio (D-07) + the typed gate script (D-14)

**What:** One add-release (all additions, scheduler-off soak) → pure env-flip window → one scheduler-only deletion release. The gate script is a plain repo Node script in the check-worker-boundary.mjs mold (plain ESM, zero deps, fail loud, exit non-zero listing violations): captures snapshots (DB queries, metrics samples, hc.io flips), evaluates 7 gates, emits PASS/FAIL, appends evidence to 05-DEPLOY-RECORD.md.

**Gate input sources (verified to exist):** per-monitor ping rows + counters + incidents (Postgres, parameterized via pg); `/metrics.json` + scraper samples (local HTTP); hc.io Management API v3 `GET /api/v3/checks/<uuid>/flips/?start=&end=` with a read-only `X-Api-Key` [CITED: healthchecks.io/docs/api]; worker logs (gate 7 disposition family).

### Pattern 5: Rehearsal pipeline extension (D-33)

**What:** The 04-09 scripts (rehearse-worker.mjs: 13-step deploy-day rehearsal incl. Linux-container SIGINT leg; enqueue-smoke.mjs; seed-synthetic.sql) plus the 03-05 snapshot machinery (anonymize-snapshot.mjs, rehearse-migrations.mjs, stamp-baseline.mjs) are extended with cutover legs: re-seed → unpause → co-run → induced parity → gates → abort drill → teardown, writing an evidence file. Same-SHA discipline (D-31); stand-in binds localhost (D-45); explicit stand-in env per the 04 split-brain guard (local `.env` REDIS_URL points at the 6390 TEST stack — always pass stand-in env explicitly).

### Anti-Patterns to Avoid

- **Building duplicate-alert suppression machinery for the takeover minute** — D-05 explicitly rejects it: verify + gate + disposition. The worker side already cannot double-alert (conditional UPDATE gates the outbox row; dedup key after confirmed send).
- **Setting `next_check_at` to a non-NULL value at monitor create** — would delay the worker's first check by up to one interval versus cron's immediate-first-check; NULL-as-due (NULLS FIRST) is today's behavior and preserves parity (verified: schema.ts:95 no default; create route never sets it).
- **Pinging hc.io more than once per check per tick** (retries) — the 5/min cap is silently enforced; a retry loop can eat the real ping.
- **Local tick-counting for gate 1** — D-17 forbids it: the hc.io check's own flips record is the monitor.
- **Deleting more than instrumentation.ts + CRON_MODE at cutover** — cron-logic/db-batcher/routes survive dormant (D-03); they are the emergency lever until Phase 6.
- **Pausing queues to pause the scheduler** — Pitfall 12 stands: `WORKER_SCHEDULER_ENABLED` is the only lever (D-09).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Prometheus exposition format | Manual HELP/TYPE/escaping/label rendering | `@prometheus-io/client` `registry.metrics()` | Format has escaping rules, family ordering, contentType headers — the library exists for exactly this |
| External pause detection | In-app self-monitoring, tick counters persisted anywhere | healthchecks.io flips record (D-17) | The detector must survive the detected process dying |
| Uptime-over-window measurement | Local ping-count math | hc.io check uptime/flips over the window | "The dead-man switch IS the monitor" (D-17); zero local machinery to corrupt |
| Overlap coordination protocol | Locks/discovery between cron and worker | Due-filter starvation + Postgres constraints (D-01/D-08) | No coordination exists by design; the write paths are already idempotent/guarded |
| Rollback machinery | Custom restore tooling | Existing tarball-restore runbook §7 + 03-05 snapshot pipeline | Already rehearsed twice (03-08, 04-09) |

**Key insight:** everything expensive in this phase was already built in Phases 2-4 (characterization suites, snapshot rehearsals, idempotent writers, constraints, metrics collector, operator scripts). Phase 5 composes them; the only new runtime code is ping wiring, one HTTP branch, one gauge module, and four warning fixes.

## Runtime State Inventory

> Trigger: this phase is a cutover/deletion phase — inventory completed across all 5 categories.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `monitors.next_check_at` is stale for every pre-existing user monitor (dark launch never advanced it; claim is the only writer) [VERIFIED: codebase + runbook §4a step 4] | **Data migration** (one UPDATE, not a drizzle migration): D-49 re-seed `LEAST(lastChecked + interval, now() + interval)` immediately before unpause — SQL already committed in runbook §4a |
| Stored data | `write_guards` rows accumulate (7d retention via maintenance); outbox rows (FAILED retained, dedup keys 7d TTL in Redis) | None — existing retention; window evidence only |
| Live service config | healthchecks.io dashboard (NOT in git): the existing cron-typed check behind `HC_PING_URL` (alive in live env) must be **paused/deleted at the deletion release** or it false-pages when instrumentation.ts dies (D-21 runbook step) | Operator dashboard action + runbook typed step |
| Live service config | 3 new hc.io checks (heartbeat 10m grace, outbox 5m, memory 30m — D-25) + D-37 throwaway rehearsal checks (notifications off, deleted after) | Provision at window-open (real) / rehearsal (throwaway); record ping URLs in stand-in env |
| OS-registered state | None — verified: no Windows Task Scheduler/cron entries exist for SpiderNode locally (03-08 N/A-locally disposition; the §3c VPS-cron script was never installed — it is superseded by D-24 before ever being applied) | None |
| Secrets/env vars | Stand-in env is passed on the command line (04-DEPLOY-RECORD — `.env` unreadable in deploy context); local `.env` `REDIS_URL` points at the TEST stack 6390 (split-brain guard: explicit env for ALL stand-in work) | Window legs must export full stand-in env explicitly; new ping URLs enter stand-in env only |
| Secrets/env vars | `CRON_MODE` (retired at deletion), `HC_PING_URL` (sole reader instrumentation.ts — removable at deletion per D-46 [VERIFIED: grep, zero other src/ readers]), `CRON_SECRET` stays until Phase 6, `WORKER_HC_PING_URL` + 2 more check URLs added | `.env.example` edits per D-39/D-40/D-46; live `.env` untouched beyond additions |
| Build artifacts | `.next` + `dist/worker.js` from the add-release SHA; **previous release tarball must be retained** (DEP-03 rehearsal target); `.snapshots/*.dump` pre-release backups | Keep tarball pair per runbook §7; rehearse restore on the stand-in (D-15 tier 2) |
| Build artifacts | Legacy batcher in-memory arrays (web process): pending pings die with a hard stop — SIGTERM flush only fires on Linux/PM2 (Pitfall 1) | curl `/api/cron/check` (flushes in-request, route line 35-36) BEFORE stopping web at the deletion release on Windows |

**Canonical question answer:** after the repo is fully updated, the systems still holding the old string are: the live `.env`/command-line env on the stand-in (CRON_MODE/HC_PING_URL harmless once readers die), the hc.io dashboard (old check — must be paused or it pages), and the previous tarball (intentionally retained). Nothing else caches cron identity.

## Common Pitfalls

### Pitfall 1: Windows stand-in cannot deliver SIGTERM — the D-43 batcher drain never fires

**What goes wrong:** D-43 relies on instrumentation.ts's SIGTERM handler flushing the in-memory batcher at the deletion-release web restart. The stand-in runs on Windows (`taskkill /T /F` — no SIGTERM); the 04 dark launch already lost exactly one batched ping this way (04-DEPLOY-RECORD deviation 2).
**Why it happens:** gracefulShutdown is wired to SIGTERM/SIGINT only (instrumentation.ts:83-95); PM2 on Linux delivers them, Windows hard-stops do not.
**How to avoid:** Insert an explicit `curl /api/cron/check` (Bearer secret) immediately BEFORE stopping web at the deletion release — the route runs checks due AND flushes in-request (route lines 30-36), draining the batcher deterministically regardless of signal semantics. Time it just after a 15-min flush boundary for minimal residue (04 precedent).
**Warning signs:** ping-count delta off by a few rows across the deletion restart; "Flushing database batches" log line absent before process exit.

### Pitfall 2: cron's alert fires BEFORE its incident create — the "natural dup block" is only half-true (D-05 verification result)

**What goes wrong:** The D-05 hypothesis assumed alert-after-incident-create ordering. Actual code: alert send (cron-logic.ts:102-135) precedes the DB writes (:149-195), gated only on a stale in-memory `previousStatus`. In the takeover minute, cron can send a duplicate DOWN/RECOVERED alert even though its subsequent `incident.create` is blocked by the partial unique index (it THROWS — prisma create has no ON CONFLICT; the allSettled swallows it AFTER monitor/ping writes landed). Additionally cron's `monitor.update` is UNGUARDED (no `status <> target` condition) and read-modify-writes counters from the pass-start read — the exact clobber class D-02's pings-vs-counters gate detects.
**Why it happens:** legacy sequencing predates the outbox; the alert decision never consults current DB state.
**How to avoid:** (a) alert-parity gate asserts 1 alert per incident and dispositions transients (D-05 — no machinery); (b) design D-11's induced-parity induction to exploit due-filter starvation: induce the transition on a monitor the worker JUST checked (manual enqueue → Tier-1 advances `lastChecked` → cron not due for a full interval) — the race is then avoided by construction, not by luck; (c) gate 4 (D-02) is the detector for the clobber class — never skip it in favor of D-37 alone (clobbered counters carry self-consistent `uptime_percent`).
**Warning signs:** two Telegram messages for one incident during the window's first sweep; `total_checks` delta ≠ pings count per monitor.

### Pitfall 3: healthchecks.io per-check ping rate cap (5/min)

**What goes wrong:** pings silently dropped beyond 5/minute/check — a retry loop or double-ping per tick can eat the real success ping and manufacture a false page (or mask a real one).
**How to avoid:** exactly one ping per check per tick (30s tick = 2/min); no ping retries; `/fail` replaces (not accompanies) the success ping on failure ticks.
**Warning signs:** hc.io check showing gaps with the worker demonstrably alive.

### Pitfall 4: `WORKER_SCHEDULER_ENABLED` is boot-read — flip requires a worker restart, and unpause activates FOUR schedulers at once

**What goes wrong:** setting the env on a running worker does nothing (index.ts:86 reads it once; upsertSchedulersAtBoot runs at boot only). Also at unpause, check-tick (30s), maintenance-cleanup (daily 03:15), tier2-flush-sweep (30s), and relay-pass (5s) ALL activate simultaneously — the first relay pass and flush sweep fire immediately alongside the first tick.
**How to avoid:** choreograph window-open as re-seed → restart worker with flag true → verify `readyz` + boot log "recurring scheduling ACTIVE"; expect the immediate relay/flush activity in the first samples (harmless; note in gate evidence). Abort (D-06) is likewise flag-false + restart.
**Warning signs:** boot log still says `schedulerEnabled: false` after the "flip"; gates see zero tick activity.

### Pitfall 5: /metrics is loopback-bound (127.0.0.1) — scraper must be co-located

**What goes wrong:** a scraper pointed at the wrong host/interface gets connection refused; someone "fixes" it by binding 0.0.0.0 — reopening the 03-REVIEW WR-02 LAN-exposure class on a new port.
**How to avoid:** the D-27 throwaway scraper runs on the same machine as the worker (it already does on the stand-in); keep the health server bind untouched; if a default-metrics family is added, note fd/memory collectors are Linux-only — some will be absent on the Windows stand-in (custom gauges unaffected).

### Pitfall 6: installing deprecated `prom-client` out of habit

**What goes wrong:** docs/tutorials overwhelmingly still say `npm install prom-client`; the name resolves fine (6.6M dl/wk) and works — but it is registry-deprecated with the maintainers pointing at `@prometheus-io/client`.
**How to avoid:** install `@prometheus-io/client` behind the human-verify checkpoint; imports change accordingly; `registry.metrics()` is async; skip cluster/IPC APIs (single process).

### Pitfall 7: outage-age gauge needs a NEW collector field

**What goes wrong:** assuming `/metrics.json` already exposes outbox age — it exposes counts + latency only (outbox.ts:655-697). OBS-03's threshold has nothing to read.
**How to avoid:** extend `collectOutboxMetrics` additively with oldest-unsent age (`EXTRACT(EPOCH FROM (now() - created_at))` over the unsent-non-failed set; `created_at` is timestamptz so the comparison is tz-safe); the dead-man ping decision reads the same value.

### Pitfall 8: window clock reset on interruption (D-16)

**What goes wrong:** dispositioning a reboot/restart gap as "still green" — gates evaluated across a gap are invalid.
**How to avoid:** the gate script takes window start/end timestamps as explicit args and only the final continuous ≥4h stretch counts; any earlier stretch is recorded as aborted-window evidence, not gate input.

## Code Examples

### WR-04: bounding the Telegram send inside the relay transaction

```typescript
// Source: WR-04 fix shape (04-REVIEW) + verified runtime (Node 24.15.0)
// src/worker/persist/outbox.ts:228 — add the signal
const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ /* unchanged */ }),
  signal: AbortSignal.timeout(10_000), // transient on timeout — existing 521-539 handling classifies
});
```
[VERIFIED: local runtime — AbortSignal.timeout works on the project's Node 24.15.0; engines pin >=22 <25]

### WR-05: one clock domain for all worker DB sessions

```typescript
// Source: src/worker/db.ts:30-37 (fix site) — shipped @types/pg ClientConfig.options?: string
new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
  statement_timeout: 30000,
  idle_in_transaction_session_timeout: 30000,
  options: "-c timezone=UTC", // WR-05: session now() == UTC wall clock — aligns Tier-1 naive
                              // timestamp writes with Tier-2 UTC strings and maintenance horizons
});
```
[VERIFIED: codebase — @types/pg/index.d.ts:31 `options?: string | undefined`, inherited by PoolConfig]

### WR-02/WR-03: breaker refusal is a SKIP, never a rollback

```typescript
// Source: src/worker/queues.ts:298-321 (fix site) + audit §14.4 "leave claims advanced"
try {
  await addCheckJob(queue, row.id, { priority, jobId });
} catch (err) {
  if (err instanceof BreakerOpenError) {
    // gate tripped between the outer check and add() — still a SKIP (§14.4):
    // claims stay advanced; the next tick re-claims when Postgres recovers
    return { jobId, priority, dropped: true, breakerGated: true };
  }
  log.error({ monitorId: row.id, jobId, /* … */ }, "check enqueue failed");
  // WR-03 fix: NO rollbackFailedClaim — audit J-1 disposition is "leave claims advanced";
  // re-pin tests/worker/queues.test.ts #4 (line ~187) to assert the claim stays advanced
  throw err;
}
```
[VERIFIED: codebase — current rollback at queues.ts:309-310 contradicts audit §14.4 row 1; the pin is tests/worker/queues.test.ts:187]

### D-49 re-seed (already committed in the runbook — execute at window-open, before unpause)

```sql
-- Source: docs/DEPLOY-RUNBOOK.md §4a step 4 (verbatim)
UPDATE monitors
   SET next_check_at = LEAST(
         "lastChecked" + ("interval" * interval '1 minute'),
         now()         + ("interval" * interval '1 minute'))
 WHERE "isActive";
```

### D-17 gate-1 evidence: hc.io flips over the window

```bash
# Source: healthchecks.io Management API v3 [CITED: healthchecks.io/docs/api]
curl -s -H "X-Api-Key: $HC_READ_ONLY_KEY" \
  "https://healthchecks.io/api/v3/checks/$WORKER_HEARTBEAT_UUID/flips/?start=$WINDOW_START_EPOCH&end=$WINDOW_END_EPOCH"
# → [{"timestamp": "...", "up": 1}, ...] — gate 1 PASS = no "up":0 flips inside the window
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `prom-client` (npm name) | `@prometheus-io/client` (official Prometheus org scope) | 0.16.0, 2026-08-24; deprecation notice on prom-client | New code must import the new name; registry-deprecated old name; breaking: async-only registry methods, MetricType string union, Node <22 dropped |
| Runbook §3c VPS-cron memory script | Worker-side dead-man ping (D-24) | This phase | §3c amended to "provision the check, the worker does the rest"; works on the stand-in today |
| `HC_PING_URL` on the web cron | `WORKER_HC_PING_URL` on the worker tick (WRK-09) | This phase | Old check paused at deletion release; new check is the sole worker-liveness signal |

**Deprecated/outdated:**
- `prom-client` npm name — deprecated by its own maintainers; do not install.
- Runbook §4a step 3's implied whole-engine deletion — corrected by D-03 (scheduler-only) + D-38 (routes/secret die Phase 6).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The operator's healthchecks.io account can create 3 real + throwaway checks and a read-only API key for the gate script (account demonstrably exists — today's cron pings it) | Gates / D-17/D-37 | Gate 1 falls back to dashboard screenshots (manual evidence); confirm before planning the gate-script CLI |
| A2 | `@prometheus-io/client` 0.16.x API remains stable through this phase (0.x versioning; official org, active releases) | Standard Stack | Low: single-file usage surface (Registry/Gauge/metrics()); pin exact version in package.json |
| A3 | An operator-owned controllable target exists for D-11 induced parity (e.g. a local fixture server the rehearsal already uses — tests/lib/helpers/check-target-server.ts) and an operator-owned monitor on the real stack | D-11 mechanics | Parity induction needs a different controllable target; confirm at planning |
| A4 | The dark-launch steady state (worker + web plain processes on the stand-in) is still running or trivially restartable — recorded running 2026-09-14; not re-verified this session | Environment | Add-release deploy restarts everything anyway; verify `curl :9090/healthz` first |
| A5 | Stand-in Postgres session TimeZone is UTC today (03-08 topology), so WR-05 is latent-hazard removal, not active-bug fix (04-REVIEW states this) | WR-05 | None — the pool option makes it topology-proof either way |
| A6 | The hc.io free plan suffices (flips retained 3 months; ping-body 100 kB) for gate evidence | Gates | Paid plan or manual dashboard evidence; flips (not pings) are the gate source, retention is sufficient |

**All other claims in this research were verified against the codebase, the local runtime, the npm registry, or official documentation this session.**

## Open Questions

1. **Outbox-age threshold exact value (D-23 band 60–120s)**
   - What we know: relay cadence is 5s; healthy age ≈ <10s; grace 5 min (D-25).
   - What's unclear: the exact threshold — 90s is the natural midpoint (~18 missed passes).
   - Recommendation: pin 90s in the add-release; revisit only with window data (D-20 discipline).
2. **Maintenance manual-enqueue leg for the window (D-12)**
   - What we know: no existing script enqueues a maintenance job (scripts/ has smoke/re-drive/rehearse only); the maintenance scheduler is daily-03:15, outside any window.
   - Recommendation: the D-33 rehearsal extension adds a one-shot maintenance enqueue (dry-run default) — trivial `Queue.add` on the maintenance lane; window evidence observes it.
3. **Env-var family naming for the two extra checks (discretion)**
   - Recommendation: `WORKER_OUTBOX_HC_PING_URL` / `WORKER_MEMORY_HC_PING_URL` (keeps the `WORKER_*` family and self-describes); or a single JSON env — rejected (one string per check matches `WORKER_HC_PING_URL` precedent).
4. **Gate-script snapshot capture format (discretion)**
   - Recommendation: JSON files under `.snapshots/gates-<timestamp>/` (one per gate input) + a markdown summary appended to 05-DEPLOY-RECORD.md — mirrors the 03-05 evidence layout.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | rehearsal/test/stand-in containers | ✓ | running (spidernode-dev-db healthy, spidernode-prod-redis up 9h, test stack healthy) | — |
| Node | runtime + AbortSignal.timeout | ✓ | 24.15.0 (pin >=22 <25) | — |
| pnpm | all gates | ✓ | 10.34.5 (matches packageManager) | — |
| PostgreSQL (stand-in, "production") | window, gates | ✓ | spidernode-dev-db :5454, healthy | — |
| Redis (hardened stand-in) | worker queues, memory gauge | ✓ | spidernode-prod-redis :6391, up | — |
| healthchecks.io account | D-21/23/24 checks + D-17 flips | ✓ (account exists — cron pings it today) | — | dashboard screenshots for gate 1 if no API key (A1) |
| hc.io read-only API key | gate-script flips evidence | ✗ (not known to exist) | — | operator creates one (one dashboard step) |
| Worker + web processes (dark-launch steady state) | add-release baseline | ? (running 2026-09-14; not re-verified) | — | restart per runbook §4 (plain-process form) |

**Missing dependencies with no fallback:** none blocking.
**Missing dependencies with fallback:** hc.io API key (fallback: manual dashboard evidence; recommend provisioning the key at window-open).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.11 (unit/integration) · Playwright 1.63.0 (e2e) · Vitest-resilience config for injections |
| Config file | `vitest.config.ts` (excludes tests/resilience) · `vitest.config.resilience.ts` |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm verify` (docker up → lint → typecheck → test → schema:gate → worker:boundary → denylist:diff → build → e2e); `pnpm test:resilience` for the injection suite |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WRK-09 | Tick pings success + `/fail`; ping errors never fail the tick; no ping while scheduler paused (inert wiring) | unit | `pnpm test tests/worker/scheduler-heartbeat.test.ts -t heartbeat` | ❌ Wave 0 |
| WRK-09 | Paused scheduler produces zero ticks/heartbeats (flag boot-gate) | unit | `pnpm test tests/worker/scheduler-flag.test.ts` | ✅ extend |
| OBS-03 | Outbox age above threshold stops the ping; below pings; `/fail` on crossing | unit | `pnpm test tests/worker/outbox-age-ping.test.ts` | ❌ Wave 0 |
| OBS-05 | `/metrics` returns exposition text with depth/age/stalled/latency/memory families | unit | `pnpm test tests/worker/health-metrics.test.ts` | ❌ Wave 0 |
| WRK-11 | Gate logic: each of the 7 gates PASS/FAIL over fixture snapshots | unit | `pnpm test tests/worker/cutover-gates.test.ts` | ❌ Wave 0 |
| WRK-11 (D-41) | Cron-remnant gate fails on fixture containing instrumentation/CRON_MODE/node-cron remnants | unit | `pnpm test tests/worker/cron-remnant-gate.test.ts` | ❌ Wave 0 (activates at deletion release) |
| D-29 WR-02/03 | Breaker-open add() rejection is a SKIP (claims stay advanced); rollback removed; queues tests re-pinned | integration (real PG+Redis) | `pnpm test tests/worker/queues.test.ts` | ✅ re-pin (#4 at :187) |
| D-29 WR-04 | telegramSend aborts at 10s under a black-hole server; relay transaction survives | integration | `pnpm test tests/worker/outbox-relay.test.ts` | ✅ extend |
| D-29 WR-05 | Worker pool session timezone is UTC (`SHOW timezone`); Tier-1/Tier-2 timestamps agree | integration | `pnpm test tests/worker/persist-tier1.test.ts` (add assertion) | ✅ extend |
| DEP-05 | `.env.example` carries the annotated placeholder set; CRON_MODE/HC_PING_URL absent post-deletion | script/grep | `pnpm verify` (D-41 leg) | ❌ Wave 0 |
| DEP-03 | Abort drill + tarball restore rehearsed | manual+script | `node scripts/rehearse-cutover.mjs` (evidence file) | ❌ Wave 0 (manual-only: the live drill, justified — real stack required by D-35) |

### Sampling Rate
- **Per task commit:** `pnpm test` (+ targeted file)
- **Per wave merge:** `pnpm verify` (+ `pnpm test:resilience` for WR-fix waves touching worker runtime)
- **Phase gate:** full `pnpm verify` + `test:resilience` + rehearsal evidence before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/worker/scheduler-heartbeat.test.ts` — WRK-09 (mock fetch; success/fail/inert-paused cases)
- [ ] `tests/worker/outbox-age-ping.test.ts` — OBS-03 threshold gating
- [ ] `tests/worker/health-metrics.test.ts` — OBS-05 /metrics endpoint
- [ ] `tests/worker/cutover-gates.test.ts` — D-14 gate logic over snapshots
- [ ] `tests/worker/cron-remnant-gate.test.ts` — D-41 fixture proof
- [ ] `@prometheus-io/client` install (checkpoint:human-verify first)

## Security Domain

`security_enforcement: true`, ASVS level 1, block_on: high.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No auth surfaces change this phase (routes keep getServerSession; gate/scraper scripts are operator-run local tools) |
| V3 Session Management | no | Untouched |
| V4 Access Control | no | Untouched (cron routes keep CRON_SECRET until Phase 6 — pinned S-4 marker) |
| V5 Input Validation | yes (minimal) | Gate/scraper scripts consume env + explicit args only — validate URLs/epochs at entry; SQL via parameterized pg (02-02 raw-SQL-with-explicit-env precedent); no user input anywhere new |
| V6 Cryptography | no | None new |
| V14 Config | yes | `/metrics` joins the loopback-only, unauthenticated-by-design health surface (T-04-02 accepted precedent); payload = numeric gauges + provenance only — extend the existing "no connection strings, tokens, or env values" rule to the exposition format; hc.io ping URLs are secret-bearing env vars (same class as HC_PING_URL) — never logged (pino ids-only rule) |

### Known Threat Patterns for this phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Information disclosure via metrics endpoint | Information Disclosure | Loopback bind (127.0.0.1, T-04-01), numeric-only gauges, throwaway scraper deleted after cutover (D-27) |
| SSRF via ping URL | Tampering/Spoofing | Ping URLs come from operator-controlled env only (no user input); fetch has AbortSignal timeout; trust class identical to today's HC_PING_URL |
| Secret leakage into logs/evidence | Information Disclosure | pino ids-only rule; deploy record carries UUIDs and counts, never URLs/tokens (04-DEPLOY-RECORD precedent); `.env.example` names-only contract |
| Rehearsal egress side-effects (D-30 sweep) | Repudiation/Side-effect | Dummy TELEGRAM_BOT_TOKEN, throwaway hc.io checks (notifications off), explicit stand-in env (split-brain guard), localhost binds (D-45) |
| Query-string secret on surviving cron route (S-4) | Spoofing | Known, pinned Phase-6 red/green marker (02-05); Phase 5 documents the Bearer-preferred form in §9 (D-38) — no new exposure |

## Sources

### Primary (HIGH confidence)
- Codebase reads (this session): `src/instrumentation.ts`, `src/lib/cron-logic.ts`, `src/lib/db-batcher.ts`, `src/app/api/monitors/[id]/check/route.ts`, `src/app/api/cron/check/route.ts`, `src/app/api/monitors/route.ts`, `src/db/schema.ts`, `src/worker/{index,scheduler,health,db,queues}.ts`, `src/worker/persist/outbox.ts`, `tests/worker/queues.test.ts`, `.env.example`, `package.json`, `scripts/` inventory — every D-04/D-05/D-10/D-46/tick-while-paused verification claim cites these directly
- npm registry (this session): `npm view prom-client deprecated/version`, `npm view @prometheus-io/client version/repository/maintainers/time` — deprecation + successor provenance
- Local runtime (this session): Node 24.15.0 AbortSignal.timeout check; shipped `@types/pg` options typing; docker/stand-in container status
- `docs/ARCHITECTURE-AUDIT.md` §13/§14/§16/§20(M3/M4)/§24; `docs/DEPLOY-RUNBOOK.md` §3c/§4/§4a/§5-§10 — design authority
- `.planning/phases/04-*/04-REVIEW.md` (WR-01..05 + IN-01..03), `04-CONTEXT.md` (D-44..D-50), `04-DEPLOY-RECORD.md` (stand-in topology, split-brain guard, N/A-locally dispositions)

### Secondary (MEDIUM confidence)
- github.com/prometheus/client_js README + CHANGELOG (fetched this session) — @prometheus-io/client API + 0.16.0 breaking changes
- healthchecks.io/docs/http_api + healthchecks.io/docs/api (fetched this session) — ping forms, 5/min cap, Management API v3 flips endpoint

### Tertiary (LOW confidence)
- None — no claim in this document rests on unverified training knowledge.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — one new package, registry + official-repo verified, SUS-flagged with checkpoint per protocol
- Architecture (cutover mechanics): HIGH — every load-bearing claim verified against real code this session; one hypothesis corrected (D-05 half-true) with the correction documented
- Pitfalls: HIGH — derived from verified code paths + the 04-REVIEW/deploy-record record + official external-service docs
- External services (healthchecks.io): MEDIUM-HIGH — official docs fetched this session; account/API-key specifics flagged as assumptions A1/A6

**Research date:** 2026-09-15
**Valid until:** 2026-10-15 (stable domain; the @prometheus-io/client 0.x line is the fastest-moving item — re-check version before install)
