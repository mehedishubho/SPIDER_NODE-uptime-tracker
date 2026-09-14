# Phase 5: Worker Cutover & Operational Hardening - Context

**Gathered:** 2026-09-15
**Status:** Ready for planning

<domain>
## Phase Boundary

The worker becomes the only monitoring path through a **gated overlap cutover**: a rehearsed window-open choreography unpauses the worker scheduler while cron keeps running as a self-suppressing hot fallback; a 4–6h dense co-run produces seven-gate evidence; operator approval gates a **scheduler-only deletion release** (`instrumentation.ts` + `CRON_MODE` — the cron engine, routes, and `CRON_SECRET` survive dormant until Phase 6). Around the window, Phase 5 ships the operational hardening ring: worker heartbeat (WRK-09), outbox-age + Redis-memory dead-man paging (OBS-03), Prometheus export via prom-client (OBS-05), the 04-REVIEW WR-02..05 fixes, a two-tier rehearsed rollback story (DEP-03), and the environment transition in its documentation form (DEP-05).

**Explicitly out of this phase:** cron route/`CRON_SECRET` deletion (Phase 6, API-01/SEC-06), permanent Prometheus/Grafana infrastructure (VPS era), `EMAIL_PROVIDER` going live (Phase 6), `BETTER_AUTH_*`/`NEXTAUTH_*` retirement (Phase 7), OS-egress enforcement (SEC-02, first VPS deploy).

Requirements: WRK-09, WRK-11, DEP-03, DEP-05, OBS-03, OBS-05.

</domain>

<decisions>
## Implementation Decisions

### Overlap write-path strategy (CR-02 resolution)

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

### Window duration & green gates

- **D-12 — Window is 4–6h dense:** every monitor cycles multiple times, induced parity events fire, maintenance/retention is observed via manual enqueue (WRK-13 dry-run/manual path) instead of waiting for midnight. Machine burden: one afternoon.
- **D-13 — Window closes only on the full 7-gate checklist:** (1) heartbeat steady, (2) queue health, (3) alert parity (exactly 1 alert/incident, D-48 bytes), (4) counter gates (pings-vs-counters + D-37), (5) continuity gap-scan (per-monitor max ping gap ≤ interval + tolerance), (6) zero duplicate ONGOING incidents, (7) legacy-path log disposition.
- **D-14 — One typed gate command evaluates all 7 gates** from captured snapshots, emits PASS/FAIL per gate, and writes evidence into `05-DEPLOY-RECORD.md` (03-08/04 disposition-register pattern). A repo script — not tooling infrastructure.
- **D-15 — Rollback rehearsal (DEP-03) is two-tier:** pre-window live abort-lever drill (unpause → 10–15 min → re-pause → verify cron auto-resumes zero-gap → unpause → fresh window, kept under heartbeat grace or with the check paused); post-green tarball-restore rehearsal on the throwaway stand-in (D-32 pattern, 04-CONTEXT).
- **D-16 — Interruption restarts the window clock:** gates evaluate only over the final continuous stretch (≥4h, no operator-caused gap). A reboot gap IS a monitoring gap and is never dispositioned away.
- **D-17 — Gate 1 (heartbeat steady) is measured by the healthchecks.io check's own uptime record** over the window — the dead-man switch IS the monitor; validates the external paging path end-to-end; no local tick-counting machinery.
- **D-18 — Operator approval sits between window-green and the deletion release:** operator reviews the gate-script PASS output + evidence and explicitly approves before cron deletion ships (04-09 Task 4 pattern); recorded in `05-DEPLOY-RECORD.md` with date + verdict.
- **D-19 — Queue-health gate is age-bounded + drain:** no check-lane job older than a bounded age at any sample, and depth returns to 0 between claim cycles. The age bound doubles as the WRK-12 documented worst-case check latency.
- **D-20 — D-33 breaker/backlog tuning closes disposition-driven:** pinned constants (5-fail/60s, ~2x backlog, retries 3–5) stay unless window data shows a concrete problem; any tuning change lands with its evidence in the deploy record.

### Heartbeat & paging channels

- **D-21 — Worker heartbeat pings a NEW dedicated healthchecks.io check** (`WORKER_HC_PING_URL`): clean attribution during the window (both dead-men alive independently); the runbook gains a typed operator step to pause/delete the old cron check at the deletion release (else it false-pages when its pings stop).
- **D-22 — Heartbeat keeps success + `/fail` signals** — behavior parity with today's cron; immediate explicit failure signal instead of waiting out the grace period.
- **D-23 — Outbox-age paging (OBS-03) is a third dead-man check:** the worker pings each tick only while the outbox is healthy (threshold ~60–120s, planner tunes vs the 5s relay cadence); a backed-up outbox stops pings → page after short grace; optional single `/fail` marker at threshold crossing. D-16-compliant: never the product Telegram bot.
- **D-24 — Redis 70%-memory alert moves to a worker-side dead-man now:** fourth check pinged each tick while memory < 70% (the worker already reads INFO for the metrics gauge). SUPERSEDES runbook §3c's VPS-cron form — amend §3c to "provision the check, the worker does the rest". Retires the forward-tracked VPS debt item and works on the stand-in today.
- **D-25 — Graces are 10/5/30 min** (heartbeat/outbox/memory): heartbeat 10 absorbs deploy restarts and pages within ~11 min of a dead worker; outbox 5 pages within ~6 min; memory 30 avoids flapping on spikes. Runbook-typed. (Three checks total with D-24's memory check; D-23's outbox check; D-21's heartbeat.)

### Prometheus scope + WR-02..05 pack

- **D-26 — OBS-05 ships as prom-client `/metrics` on the worker's existing :9090 HTTP server:** no new port, no separate exporter process; gauges wrap the existing metrics collector (03-CONTEXT D-24/D-25 lineage).
- **D-27 — Window scraping is a throwaway scraper:** a minimal script curling `:9090/metrics` on an interval, writing samples to files — window evidence + gate input; deleted/archived after cutover.
- **D-28 — Grafana/dashboards are deferred to the VPS era:** Phase 5 ships export + throwaway scraping only; OBS-05's "optional dashboard" clause is satisfied by an explicit deferral note.
- **D-29 — All four 04-REVIEW warnings are fixed in Phase 5, toward the audit's intent:** WR-02 breaker TOCTOU window closed; WR-03 `rollbackFailedClaim` reconciled with audit claim semantics (tests/worker/queues.test.ts re-pinned); WR-04 telegramSend AbortSignal timeout + relay FOR-UPDATE transaction scope (idle_in_transaction); WR-05 clock domains unified via the `-c timezone=UTC` pool option. Each lands as its own verifiable change with tests.

### Window-open rehearsal (D-32 pattern)

- **D-30 — Full stand-in dry-run before the real window:** fresh anonymized snapshot on throwaway containers (03-05 pipeline); the whole sequence abbreviated — re-seed → unpause → 30–60 min real co-run (the first time cron + worker scheduler EVER run together; the dark launch ran scheduler-off) → induced DOWN/RECOVERED → gate script evaluates → abort drill → teardown. Stand-in env neutralizes real egress: dummy `TELEGRAM_BOT_TOKEN`, throwaway HC checks; researcher sweeps for any other real-side-effect (alerts, egress) before the rehearsal runs.
- **D-31 — The rehearsal runs the add-release build:** D-32 same-SHA discipline (04-CONTEXT); rehearsal failure blocks the release — fix, rebuild, re-rehearse.
- **D-32 — Green rehearsal is a hard precondition for opening the real window:** gate-script PASS on the stand-in co-run + abort drill executed + evidence recorded before the real window may open; failure blocks window-open until fixed and re-rehearsed.
- **D-33 — The rehearsal is encoded by extending the 04-09 operator-script pipeline** (seed/smoke/re-drive/rehearse pattern) with the cutover legs (re-seed/unpause/co-run/gates/drill), writing an evidence file; tier-2's post-green tarball rehearsal reuses the same stand-in rebuild.
- **D-34 — Rehearsal alert parity is proven at the payload boundary:** with the dummy token, real sends fail; the gate script asserts the outbox row payload (D-48 characterization shape) + exactly one relay attempt per incident; rows land FAILED as expected (a live FAILED-state exercise). Real delivery parity stays a real-window gate.
- **D-35 — The live pre-window abort drill still runs verbatim:** the stand-in proves mechanics; the live drill (10–15 min, D-15) proves the real lever on the real stack — env-wiring mistakes are only caught by a live pull (the 04 split-brain guard exists because exactly that happened), and the first real abort should never be under incident stress. Ends by rolling straight into the fresh window.
- **D-36 — Rehearse before deploying the add-release:** finalize code → build → rehearse that exact SHA on the stand-in → deploy to production → scheduler-off soak → window day. A rehearsal finding never means fixing code already live.
- **D-37 — The healthchecks.io legs run in the rehearsal via throwaway real checks** with notifications disabled: proves URL/grace config + the ping code path against the real service with zero page risk; deleted after; the real checks are provisioned at window-open.

### Env transition & runbook §9 conflict (DEP-05)

- **D-38 — Runbook §9 conflict is ratified toward Phase 6:** §9 (line 386: endpoints + `CRON_SECRET` "deleted at the Phase 5 overlap-verified cutover") is amended in the add-release doc wave — deletion moves to Phase 6 (API-01/SEC-06); scheduler-only deletion stands; §9 documents the surviving curl-the-route emergency lever and its Phase-6 death date. One story across REQUIREMENTS, this decision, and the runbook.
- **D-39 — Future vars appear in `.env.example` as commented placeholders with arrival-phase annotations:** e.g. `# EMAIL_PROVIDER=smtp  # goes live Phase 6 (EML-01)`, `# BETTER_AUTH_SECRET=  # goes live Phase 7 (AUTH-01)` — satisfies criterion 4's "documented" clause; names + dates visible without implying the app reads them yet (the FND-07 "documents what the app reads" contract stays intact).
- **D-40 — DEP-05 marks Complete at Phase-5 end via dated paths:** criterion 4's own language ("documented … retired or on a dated retirement path") blesses the documentation form — `CRON_MODE` actually retired at the deletion release; `REDIS_URL` already present; `CRON_SECRET` annotated retired-Phase-6; `NEXTAUTH_*` annotated retired-Phase-7 (AUTH-07). PROJECT.md notes the residual live legs (EMAIL_PROVIDER Phase 6; BETTER_AUTH_*/NEXTAUTH_* retirement Phase 7).

### Standing pins (no-ask decisions)

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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design authority
- `docs/ARCHITECTURE-AUDIT.md` §M3/§M4 — overlap window + the disable-ordering rule being amended per D-08; §16 writer specs (Tier-1/Tier-2 semantics the gates verify); §14 scheduler spec (claim/due-filter mechanics underpinning D-01); §13 resilience (breaker/backlog constants referenced by D-20); §22 (runbook-wins resolution)
- `docs/ARCHITECTURE-AUDIT.md` §4a-equivalent + `docs/DEPLOY-RUNBOOK.md` §4a — the first-worker-release overlap path Phase 5 executes (re-seed step, window, cutover-completion release)
- `docs/DEPLOY-RUNBOOK.md` §9 (line ~386) — the endpoint/CRON_SECRET deletion-timing conflict amended per D-38; §3c — memory-alert form superseded per D-24; §4 — restart form applying to the add/deletion releases; §10 — egress rules the stand-in env must respect

### Phase planning inputs
- `.planning/REQUIREMENTS.md` — Phase 5 rows (WRK-09, WRK-11, DEP-03, DEP-05, OBS-03, OBS-05) + Phase 6 boundary (API-01, SEC-06 own the route/secret deletion)
- `.planning/ROADMAP.md` — Phase 5 success criteria 1–4 (criterion 2's grep realized per D-41; criterion 4's env form per D-39/D-40)
- `.planning/phases/01-design-gate/01-VERIFICATION.md` — design-debt register (CR-02 consumed by this context; CR-01 already consumed in Phase 4)
- `.planning/phases/04-monitoring-worker-build-dark-launch/04-REVIEW.md` — WR-02..05 full findings fixed per D-29
- `.planning/phases/04-monitoring-worker-build-dark-launch/04-CONTEXT.md` — D-32 (rehearsal pattern), D-48 (alert byte-parity pins), D-49 (re-seed), D-50 (GREATEST catch-up), dark-launch state Phase 5 starts from
- `.planning/phases/04-monitoring-worker-build-dark-launch/04-DEPLOY-RECORD.md` — stand-in topology ground truth, REDIS_URL split-brain guard (explicit env for stand-in work), disposition-register pattern
- `.planning/phases/03-redis-drizzle-schema/03-CONTEXT.md` — D-24/D-25 (metrics collector D-26 wraps), D-33 (tuning deferral closed by D-20); `03-VERIFICATION.md`/`03-DEPLOY-RECORD.md` — §3c deferral being retired by D-24, local-only topology deviations
- `.planning/phases/02-foundations-theme/02-CONTEXT.md` — D-01 amendment (pnpm verify replaces CI) grounding D-41

### Code touch-points
- `src/instrumentation.ts` — the deletion target (D-03); its CRON_MODE early-return, HC ping wiring, and SIGTERM flush inform D-04/D-43
- `src/lib/cron-logic.ts`, `src/lib/db-batcher.ts`, `src/app/api/cron/**` — surviving-dormant engine + emergency lever (D-03/D-38); flushBatches for D-04
- `src/worker/queues.ts` (WR-02/WR-03 sites: ~219–225, 238–244, 282, 298–321), `src/worker/outbox.ts` (WR-04: 223–246, 451–574), `src/worker/tier1.ts`/`tier2.ts`/`maintenance.ts` (WR-05 clock-domain sites) — D-29 fix sites
- `src/db/schema.ts` — `idx_monitors_due` (repaired), `next_check_at` (D-10 onboarding), partial unique ONGOING index (D-05's natural dup block)
- `src/app/api/monitors/route.ts` (create path) + manual-check route — D-04/D-10 touch-points
- Worker `:9090` health server — D-26 `/metrics` mount point
- `tests/worker/queues.test.ts` — WR-03 pins to re-pin; `tests/resilience/` — D-31 injection suite lineage
- `.env.example` — D-39/D-46 target file

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **04-09 operator scripts** (seed/smoke/re-drive/rehearse): the pipeline D-33 extends with cutover legs.
- **03-05 rehearsal machinery** (anonymization script, throwaway-container restore, row-count/checksum verify): the stand-in builder for D-30/D-15-tier-2.
- **Metrics collector** (04-02, OBS-01: depth/age/stalled/latency/Redis-memory gauges): D-26's prom-client registry wraps these gauges — no new collection logic.
- **Worker :9090 HTTP server** (healthz/readyz): `/metrics` is another handler on the existing listener.
- **Outbox FAILED derived state + D-48 byte-parity pins** (04-07): D-34's payload-at-boundary proof reads the same surfaces.
- **D-37 maintenance dry-run recompute** (04-07): the window counter gate runs it in dry-run form over window data.
- **`WORKER_SCHEDULER_ENABLED` flag + `WORKER_TEST_*` seams** (04-02/04-08): the pause lever D-06/D-09 formalizes.

### Established Patterns
- **Expand/contract releases** (M-2): D-07's three-step structure; additive add-release → env flip → separate deletion.
- **Disposition register** (03-08/04 DEPLOY-RECORD): gate evidence + operator verdicts land in `05-DEPLOY-RECORD.md` (D-14/D-18).
- **Two-proof discipline** (automated suite + watched rehearsal): D-30 continues D-32's precedent.
- **pnpm verify gates** (02-CONTEXT D-01): D-41 adds the cron-remnant grep as another leg.
- **Dead-man paging via healthchecks.io, never the product bot** (03 D-16): D-21/D-23/D-24 instantiate it three more times.
- **TEST-ONLY seams, env-gated and source-pinned** (04-08): any rehearsal seam follows this shape.

### Integration Points
- **Worker tick loop**: heartbeat ping (D-21/22), outbox-health ping (D-23), memory ping (D-24) all hook the scheduler tick — which only runs once the scheduler unpauses; the add-release therefore carries the wiring inert until window-open (researcher confirms what, if anything, pings while paused — a paused scheduler means no tick, so all three checks go live at window-open, D-37 real-check provisioning aligns).
- **`.env`/REDIS_URL split-brain guard** (04-DEPLOY-RECORD): all stand-in/rehearsal work requires explicit env pointing at the TEST stack — D-30 inherits this rule.
- **PM2/process management on the stand-in**: plain processes (`pnpm start` web + `node dist/worker.js`); the runbook's §4 restart form applies to add/deletion releases on this topology.

</code_context>

<specifics>
## Specific Ideas

- **The due-filter starvation analysis is the load-bearing safety argument** (D-01/D-08): worker claims advance `next_check_at` and Tier-2's guarded UPDATE advances `last_checked` via GREATEST; cron's due-filter (`lastChecked + interval`) therefore starves automatically once the worker takes a monitor — no coordination, no disable step. Duplicate exposure is bounded to the takeover-sweep minute per monitor, and the mechanism makes cron a *self-suppressing* hot fallback whose re-pause abort restores full cron coverage within one interval. The M4 amendment (D-08) must carry this argument, not just the conclusion.
- **D-37 alone cannot detect the M4 lost-update class**: a clobbered counter carries a self-consistent `uptime_percent` (both counters written by the same stale read-modify-write). Only the pings-vs-counters reconcile (D-02) sees it. The gate script implements both, and the difference is why.
- **The window is the first co-run in the project's history** — the dark launch verified the worker with the scheduler off, so takeover-sweep dynamics, dup-alert behavior, and due-filter starvation have never been observed live anywhere. That fact is the justification for D-30's full dry-run.
- **Zero co-run minutes exist today** also means OBS-02's scheduler→check→persist→alert correlation (D-42) and gate 1's heartbeat record (D-17) can only be produced by this window — they are Phase-5-completion evidence by construction.
- **The emergency-lever framing** (D-03/D-38): keeping `/api/cron/check` + `CRON_SECRET` alive until Phase 6 converts a doc conflict into an operational feature — post-cutover, an operator can curl a full cron pass if the worker is ever down hard. §9 should document the lever and its death date, not just defer the deletion.

</specifics>

<deferred>
## Deferred Ideas

- Cron routes + `CRON_SECRET` deletion — Phase 6 (API-01/SEC-06; D-38).
- `EMAIL_PROVIDER` live — Phase 6 (EML-01; D-39/D-40).
- `BETTER_AUTH_*` live + `NEXTAUTH_*` retirement — Phase 7 (AUTH-01/AUTH-07; D-40).
- Grafana / persistent Prometheus — VPS era (D-28).
- SEC-02 OS-egress enforcement — first VPS deploy (formal override already accepted 2026-09-15).
- WR-05 sibling (03-REVIEW): rehearse-migrations.mjs journal-count hard-code — fix before Phase 7 rehearsal reuse (not Phase 5 work).
- WR-06 sibling (03-REVIEW): limiter keys on raw `x-forwarded-for` — pairs with Phase 6 S-series security work.
- OBS-04 Bull Board — Phase 7 (requires Better Auth admin plugin).

</deferred>

---

*Phase: 5-Worker Cutover & Operational Hardening*
*Context gathered: 2026-09-15*
