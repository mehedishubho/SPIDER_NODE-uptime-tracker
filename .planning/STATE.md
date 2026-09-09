---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 01
current_phase_name: design-gate-review-verdict-ready
status: executing
stopped_at: Completed 01-06-PLAN.md (CR-01/CR-02/CR-03 + IN-02/03/04 + OBS-01 closed as audit amendments; NOT READY verdict record git-tracked)
last_updated: "2026-09-09T15:15:08.926Z"
last_activity: 2026-09-09
last_activity_desc: Phase 01 execution started
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 9
  completed_plans: 6
  percent: 67
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-08)

**Core value:** Modernize the infrastructure without breaking existing monitoring — never lose or corrupt uptime data, silently stop checking, or lock users out irrecoverably.
**Current focus:** Phase 01 — design-gate-review-verdict-ready

## Current Position

Phase: 01 (design-gate-review-verdict-ready) — EXECUTING
Plan: 7 of 9
Status: Ready to execute
Last activity: 2026-09-09 — Phase 01 execution started

Progress: [███████░░░] 67%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01 P01 | 984s | 3 tasks | 1 files |
| Phase 01 P02 | 4min | 3 tasks | 1 files |
| Phase 01 P03 | 9m 20s | 3 tasks | 1 files |
| Phase 01 P04 | 5min | 3 tasks | 2 files |
| Phase 01 P05 | 10m (Tasks 2-3 continuation; Task 1 prior session) | 3 tasks | 1 files |
| Phase 01 P06 | 8m (490s) | 3 tasks | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Roadmap: audit §24 order chosen, compressed to 8 phases at standard granularity (design gate first; dark launch split from overlap cutover)
- WRK-09/WRK-11 placed in Phase 5 — heartbeat parity and overlap gates are only verifiable once the worker scheduler unpauses
- EML-04 placed in Phase 7 — Better Auth hooks cannot delegate to the email queue before Better Auth exists (Phase 6 builds the queue)
- DAT-11 (windowed-uptime backend) placed in Phase 8 — flagged feature work kept out of the highest-risk migration phase
- OBS-04/SEC-04 placed in Phase 7 — Bull Board admin gating requires the Better Auth admin plugin
- [Phase 01]: 01-01: outbox.monitor_id integer (not uuid) — FK must match integer serial monitors.id (M-5); outbox.incident_id added for the alert dedup key
- [Phase 01]: 01-01: Tier 1 transaction inserts the evidence ping BEFORE the conditional UPDATE — duplicates record evidence but count/gate transition effects once (TC-DUP-INCIDENT-01)
- [Phase 01]: 01-01: ID generation pinned DB-side gen_random_uuid()::text; spec SQL omits id columns so defaults apply
- [Phase 01]: 01-02: every BullMQ lane carries an explicit priority (manual/non-UP checks 1, tick/relay/alerts 1, maintenance/email 5, routine 10) — BullMQ default 0 processes non-prioritized jobs BEFORE prioritized ones, so any unprioritized lane inverts J-6
- [Phase 01]: 01-02: claim SQL RETURNING extended to (id, status, next_check_at) — J-6 lane assignment and the check:{monitorId}:{epoch} jobId derive from the atomic claim; WHERE clause unchanged from the verified research baseline
- [Phase 01]: 01-02: J-5 backlog gate drops only routine (priority-10) enqueues; the non-UP lane is never gated — transition writes are synchronous inside check jobs (§16.1) and thus never droppable
- [Phase 01]: 01-02: recompute-uptime and record-pings-bulk removed from §14 job lists — D-6/§16.5 lifetime counters are authoritative and Tier 2 persistence is the single §16.2 guarded flush
- [Phase ?]: [Phase 01]: 01-03: audit §25 (connection budget) placed as a new top-level section after §24 instead of between §16/§17 — mid-numbering insertion would renumber §17–§24 and break cross-references committed by 01-01/01-02
- [Phase ?]: [Phase 01]: 01-03: Postgres breaker state lives in the worker process; restart resets to CLOSED — safe (first infra-failure re-arms within one tick), and the pause never depends on Redis state surviving a restart
- [Phase ?]: [Phase 01]: 01-03: statement_timeout 30 s on web+worker pools (sized above the 5000-row retention-delete pass), explicitly UNSET on the migration runner — CONCURRENTLY/backfills run long
- [Phase ?]: [Phase 01]: 01-03: §9 marker item numbers use the plan's prescribed citation scheme verbatim; issue IDs are the load-bearing traceability tokens and all trace greps pass
- [Phase 01]: 01-04: runbook PM2 values pinned — kill_timeout 20000 ms non-negotiable floor (P-1/DEP-01); wait_ready/listen_timeout/max_restarts/min_uptime marked default-tune-with-data (D-10)
- [Phase 01]: 01-04: interim smoke check = web-serving check (no worker until Phase 4); synthetic-check smoke is the target-topology form; migrate step is a no-op when nothing is pending so one interim ordering covers Phases 2-3
- [Phase ?]: 01-05: gap path taken on user ratification (ratify gaps) — verdict stays NOT READY; DSGN-02 pending a clean cycle-2 pass; no READY-with-exceptions (D-16/D-18)
- [Phase ?]: 01-05: criterion-2 interpretation user-ratified (D-05/DRZ-01) — DDL-precise §11 + Phase 3 live-DDL transcription contract + M-3 empty-diff gate = reflected in the target Drizzle schema
- [Phase ?]: 01-05: DSGN-02 deliberately not marked complete — requirement text (verdict to READY) not yet true; plan completed via its legitimate gap-path branch
- [Phase 01]: 01-06: flush exclusivity is a two-part guarantee — same-transaction write_guards guard (flush:{batchId}) PLUS RENAMENX staging snapshot; plain RENAME rejected because it re-fails CR-02's over-delete case on crash-after-COMMIT redelivery
- [Phase 01]: 01-06: batchId pinned {epochMs-of-flush-pass}:{monitorId}, carried in BullMQ job data so staging key names and the guard key are deterministic across retries (IN-03, D-10 form)
- [Phase 01]: 01-06: alert dedup is one key per declared outbox event type — alert:{incidentId}:down / alert:{incidentId}:recovered / alert:{monitorId}:first_check; down/recovered rows REQUIRE non-NULL incident_id, violations dead-letter via UnrecoverableError (CR-03)

### Pending Todos

None yet.

### Blockers/Concerns

- Research flags requiring `--research-phase` during planning: Phase 4 (BullMQ 6 `upsertJobScheduler`, breaker/backlog tuning, PM2 handshake), Phase 7 (social `providerId` casing, token-flow cutover, cookieCache revocation lag), Phase 3 (drizzle-kit journal-stamping, `CREATE INDEX CONCURRENTLY` transaction wrapping)
- Live production system: every cutover step needs a full `pg_dump` backup and an anonymized-snapshot rehearsal first (D-9/D-10)
- Phase 01 design gate: re-review cycle 1 found ratified gaps RR-01 (S-1 network-egress layer missing, HIGH), RR-02 (uptime recompute residual, MEDIUM), RR-03 (Redis-down fallback-write test residual, MEDIUM), RR-04 (spike wording, LOW) — verdict stays NOT READY; one fix cycle remains (fresh-agent follow-up plan + cycle-2 re-review per D-18) before any implementation phase

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-09-09T15:15:08.921Z
Stopped at: Completed 01-06-PLAN.md (CR-01/CR-02/CR-03 + IN-02/03/04 + OBS-01 closed as audit amendments; NOT READY verdict record git-tracked)
Resume file: None
