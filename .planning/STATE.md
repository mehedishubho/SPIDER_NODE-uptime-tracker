---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 01
current_phase_name: design-gate-review-verdict-ready
status: executing
stopped_at: "Completed 01-02-PLAN.md (orchestration design slice: audit §14/§15/§23)"
last_updated: "2026-09-08T20:20:44.134Z"
last_activity: 2026-09-08
last_activity_desc: Phase 01 execution started
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 5
  completed_plans: 1
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-08)

**Core value:** Modernize the infrastructure without breaking existing monitoring — never lose or corrupt uptime data, silently stop checking, or lock users out irrecoverably.
**Current focus:** Phase 01 — design-gate-review-verdict-ready

## Current Position

Phase: 01 (design-gate-review-verdict-ready) — EXECUTING
Plan: 3 of 5
Status: Ready to execute
Last activity: 2026-09-08 — Phase 01 execution started

Progress: [░░░░░░░░░░] 0%

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

### Pending Todos

None yet.

### Blockers/Concerns

- Research flags requiring `--research-phase` during planning: Phase 4 (BullMQ 6 `upsertJobScheduler`, breaker/backlog tuning, PM2 handshake), Phase 7 (social `providerId` casing, token-flow cutover, cookieCache revocation lag), Phase 3 (drizzle-kit journal-stamping, `CREATE INDEX CONCURRENTLY` transaction wrapping)
- Live production system: every cutover step needs a full `pg_dump` backup and an anonymized-snapshot rehearsal first (D-9/D-10)

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-09-08T20:20:44.129Z
Stopped at: Completed 01-02-PLAN.md (orchestration design slice: audit §14/§15/§23)
Resume file: None
