# Phase 5: Worker Cutover & Operational Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-15
**Phase:** 5-Worker Cutover & Operational Hardening
**Areas discussed:** Overlap write-path strategy (CR-02), Window duration & green gates, Heartbeat & paging channels, Prometheus scope + WR-02..05 pack, Window-open rehearsal (D-32 pattern), DEP-05 env transition & runbook §9 conflict

**Pattern note:** the operator selected the Recommended option on every question (consistent with prior phases' dense-discussion style), extended every area with at least one "more questions" round, and opted to explore two additional gray areas beyond the four originally presented.

---

## Overlap write-path strategy (CR-02)

| # | Question | Options | Selected |
|---|----------|---------|----------|
| 1 | How does the window open (§4a "disable nothing" vs audit M4)? | Co-run whole window · Brief overlap then solo soak · M4-strict flip | ✓ Co-run whole window |
| 2 | What gates the M4 counter-corruption (lost-update) risk? | Pings-vs-counters reconcile · D-37 dry-run alone · Metrics snapshots only | ✓ Pings-vs-counters reconcile |
| 3 | What does the cutover-completion release delete? | Scheduler-only · Delete engine + routes now · Engine gone, routes stubbed | ✓ Scheduler-only |
| 4 | How do manual-check results land after the batcher's flushers are deleted? | Route flush pinned now · Defer to research · Accept staleness gap | ✓ Route flush pinned now |
| 5 | Duplicate Telegram alerts during the takeover-sweep minute? | Verify + gate, no machinery · Cron-off takeover sweep · Accept transient dupes | ✓ Verify + gate, no machinery |
| 6 | Pre-committed abort rule when a gate goes red? | Re-pause scheduler · Always full rollback · Judgment call | ✓ Re-pause scheduler |
| 7 | Release structure around the window? | 1 add-release + flip + 1 delete · Split hardening first · Single combined release | ✓ 1 add-release + flip + 1 delete |
| 8 | Shape of the audit M4 amendment? | Full analytical · Minimal erratum · Detection-rule rewrite | ✓ Full analytical |
| 9 | Does WORKER_SCHEDULER_ENABLED survive cutover? | Keep as permanent pause · Retire after grace · Defer | ✓ Keep as permanent pause |
| 10 | Monitors created after cutover still get checked? | Pin onboarding in add-release · Assume handled · Pure research item | ✓ Pin onboarding in add-release |
| 11 | Vehicle for DOWN/RECOVERED alert-parity evidence? | Induced on own monitor · Synthetic monitor reuse · Natural incidents only | ✓ Induced on own monitor |

**Notes:** The CR-02 contradiction resolved via the due-filter starvation analysis — cron's due-filter (`lastChecked + interval`) starves automatically once the worker takes a monitor, so co-run exposure is bounded to the takeover minute per monitor; cron becomes a self-suppressing hot fallback and re-pause restores it within one interval.

---

## Window duration & green gates

| # | Question | Options | Selected |
|---|----------|---------|----------|
| 1 | Window duration before the deletion release is allowed? | 4–6h dense · 24h incl. midnight · 48–72h | ✓ 4–6h dense |
| 2 | What must be green to close the window? | Full 7-gate checklist · Core four · Minimal three | ✓ Full 7-gate checklist |
| 3 | How are gates evaluated/evidenced? | Gate script + record · Typed manual checklist · Script only | ✓ Gate script + record |
| 4 | What does the rollback rehearsal (DEP-03) execute? | Both tiers, pre/post window · Tarball only · Tabletop only | ✓ Both tiers, pre/post window |
| 5 | Stand-in interruption mid-window? | Interruption resets clock · Cumulative + dispositions · Decide at time | ✓ Interruption resets clock |
| 6 | Gate 1 (heartbeat steady) measured by? | HC record is the gate · Local tick counter · Both must agree | ✓ HC record is the gate |
| 7 | Operator-approval checkpoint before deletion? | Operator approves delete · Gates green = authority | ✓ Operator approves delete |
| 8 | Queue-health gate definition? | Age-bounded + drain · Depth-zero per interval · Average depth only | ✓ Age-bounded + drain |
| 9 | Closing the D-33 breaker/backlog tuning deferral? | Disposition-driven · Proactive tuning pass · Record only | ✓ Disposition-driven |

---

## Heartbeat & paging channels

| # | Question | Options | Selected |
|---|----------|---------|----------|
| 1 | Worker tick pings new or existing healthchecks.io check? | New dedicated check · Same existing · Same, renamed | ✓ New dedicated check |
| 2 | Heartbeat keeps /fail on tick failure? | Keep success + /fail · Success-only | ✓ Keep success + /fail |
| 3 | What pages on outbox age (OBS-03)? | HC dead-man check · Telegram to operator · Metric + log only | ✓ HC dead-man check |
| 4 | Redis 70%-memory alert (§3c deferral) moves worker-side? | Worker-side dead-man · Keep §3c deferral | ✓ Worker-side dead-man |
| 5 | Grace periods for the checks? | 10/5/30 min · Tighter (5/2/15) · Planner discretion | ✓ 10/5/30 min |

**Notes:** All paging stays on healthchecks.io dead-men — never the product Telegram bot (03 D-16). D-24 supersedes runbook §3c's VPS-cron form.

---

## Prometheus scope + WR-02..05 pack

| # | Question | Options | Selected |
|---|----------|---------|----------|
| 1 | OBS-05 export vehicle? | prom-client /metrics · Standalone exporter · JSON only | ✓ prom-client /metrics |
| 2 | Scraping during the window (no Prometheus server)? | Throwaway scraper · Manual spot samples · Skip | ✓ Throwaway scraper |
| 3 | Grafana/dashboard layer? | Defer to VPS era · Minimal Grafana now · Prometheus server now | ✓ Defer to VPS era |
| 4 | 04-REVIEW WR-02..05 handling? | All four, toward audit · Fix WR-03/04 only · Document, defer all | ✓ All four, toward audit |

---

## Window-open rehearsal (D-32 pattern) — surfaced mid-discussion

| # | Question | Options | Selected |
|---|----------|---------|----------|
| 1 | Full window-open choreography dry-run? | Full stand-in dry-run · Gate script only · No extra rehearsal | ✓ Full stand-in dry-run |
| 2 | Which artifact does the rehearsal run? | The add-release build · Working tree | ✓ The add-release build |
| 3 | Green rehearsal as precondition? | Hard precondition · Advisory only | ✓ Hard precondition |
| 4 | How is the rehearsal encoded (tier-2 reuse)? | Extend 04-09 pipeline · Runbook manual procedure · One-off | ✓ Extend 04-09 pipeline |
| 5 | Parity proof without real Telegram sends? | Payload-at-boundary · Mock Telegram seam · Skip parity | ✓ Payload-at-boundary |
| 6 | Live pre-window abort drill still runs? | Keep verbatim · Simplify · Drop | ✓ Keep verbatim |
| 7 | Rehearsal vs add-release deploy ordering? | Rehearse before deploy · Deploy first | ✓ Rehearse before deploy |
| 8 | healthchecks.io legs in the rehearsal? | Throwaway checks · Skip HC legs · Local mock | ✓ Throwaway checks |

**Notes:** Motivating fact: the dark launch ran scheduler-off — zero co-run minutes have ever existed; the gate script, re-seed, and takeover dynamics would all be first-observed live without the dry-run. Stand-in env must neutralize real egress (dummy TELEGRAM_BOT_TOKEN; researcher sweeps for other real side effects).

---

## DEP-05 env transition & runbook §9 conflict — surfaced mid-discussion

| # | Question | Options | Selected |
|---|----------|---------|----------|
| 1 | §9 "deleted at Phase 5 cutover" vs scheduler-only decision? | Ratify Phase-6 move · Delete endpoints in Phase 5 · Leave conflict | ✓ Ratify Phase-6 move |
| 2 | Future vars (EMAIL_PROVIDER, BETTER_AUTH_*) in .env.example? | Commented placeholders · Prose block only · Nothing until live | ✓ Commented placeholders |
| 3 | When does DEP-05 count Complete? | Complete via dated paths · Pending until Phase 7 | ✓ Complete via dated paths |

**Notes:** Keeping the routes until Phase 6 preserves a curl-the-route emergency lever post-cutover; §9 documents the lever and its death date rather than just deferring the deletion.

---

## Standing pins (no-ask decisions recorded directly)

- Cron-remnant grep realized as a pnpm verify leg (no CI system — 02-CONTEXT D-01 amendment precedent).
- OBS-02 closes on window evidence (scheduler→check→persist→alert correlation observed live).
- Batcher drain at cutover covered by old-artifact SIGTERM flush + D-04 route flush — nothing new built.
- 03-REVIEW CR-01/WR-01 verified repaired (commit 279fe14, schema.ts:98) — no schema-repair blocker; zero-new-migration target.
- 03-REVIEW WR-02 (0.0.0.0 rehearsal bind) folds into the D-33 rehearsal pipeline extension (localhost bind).
- Deletion-release .env.example removals are reader-set-driven (researcher verifies HC_PING_URL's surviving readers).

## Claude's Discretion

- HC env-var naming (beyond the pinned WORKER_HC_PING_URL); gate-script CLI/evidence formats; rehearsal script decomposition; exact grep patterns for the cron-remnant gate; amendment placement/wording for M4/§9/§3c; outbox-age threshold within 60–120s; induced-parity monitor mechanics.

## Deferred Ideas

- Cron routes + CRON_SECRET deletion → Phase 6 (API-01/SEC-06)
- EMAIL_PROVIDER live → Phase 6; BETTER_AUTH_*/NEXTAUTH_* → Phase 7
- Grafana/persistent Prometheus → VPS era; SEC-02 OS egress → first VPS deploy
- rehearse-migrations journal hard-code (03-REVIEW WR-05 sibling) → Phase 7 reuse; limiter x-forwarded-for (WR-06 sibling) → Phase 6; OBS-04 Bull Board → Phase 7
