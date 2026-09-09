---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 2
current_phase_name: Foundations & Theme Infrastructure
status: verifying
stopped_at: Completed 01-09-PLAN.md (cycle-2 clean pass ratified — verdict flipped to READY; Phase 01 complete 9/9)
last_updated: "2026-09-09T17:28:26.170Z"
last_activity: 2026-09-09
last_activity_desc: Phase 01 complete, transitioned to Phase 2
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 9
  completed_plans: 9
  percent: 13
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-08)

**Core value:** Modernize the infrastructure without breaking existing monitoring — never lose or corrupt uptime data, silently stop checking, or lock users out irrecoverably.
**Current focus:** Phase 01 — design-gate-review-verdict-ready

## Current Position

Phase: 2 — Foundations & Theme Infrastructure
Plan: Not started
Status: Phase complete — ready for verification
Last activity: 2026-09-09 — Phase 01 complete, transitioned to Phase 2

Progress: [███████░░░] 67%

## Performance Metrics

**Velocity:**

- Total plans completed: 9
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 9 | - | - |

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
| Phase 01 P07 | 213s (~4m) | 3 tasks | 1 files |
| Phase 01 P08 | 602s (~10m) | 3 tasks | 2 files |
| Phase 01 P09 | 7m (Task 3 continuation; Tasks 1-2 prior session + checkpoint) | 3 tasks | 5 files |

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
- [Phase 01]: 01-07: interim-topology Migrate step is phase-conditional keyed on the Phase 3 baseline PR (same switchover event as audit §24 step 3) — Phase 2 runs no migrate command (legacy CI prisma db push is the interim schema authority on its dated removal path), Phase 3+ runs the single drizzle-kit migrate runner (WR-03)
- [Phase 01]: 01-07: PM2 readiness is two signals with distinct consumers — process.send('ready') is the PM2 gate (wait_ready/listen_timeout), HTTP :9090/readyz is the operator/CI gate; wiring only the HTTP endpoint boot-crash-loops the worker (WR-04)
- [Phase 01]: 01-07: first worker release is its own §4a path — pm2 start/startOrReload (never restart on an unregistered name), M3 overlap window verifying continuity (heartbeat, queue depth ≈ 0, ping flow, alert parity, M4 counters) before anything is disabled, cutover completion as a separate release deleting instrumentation.ts cron + CRON_MODE; §4 restart form applies from the second release onward (WR-05)
- [Phase 01]: 01-08: S-1 egress layer is one denylist in three statements — §15.1 engine list (post-WR-01), §15.4 OS mirror, runbook §10 operator rules; drift control is shared 11-token CIDR set + same-change mandate (RR-01/WR-01)
- [Phase 01]: 01-08: manual checks advance next_check_at one interval at enqueue via the §14.3-shaped atomic UPDATE; manual jobId check:{monitorId}:manual:{epochMs-of-enqueue} is unique per enqueue — admission is the D-13 limiter's job, never the jobId's (WR-02)
- [Phase 01]: 01-08: rate-limit atomicity pinned as one Lua script doing INCR + EXPIRE-with-NX on first increment — separate calls strand a TTL-less counter and permanently limit a user (IN-01/OBS-04)
- [Phase 01]: 01-08: steady-state Postgres total restated ≤ 30 (web 10 + worker 20), ≤ 31 only during deploys; web process budgets 2 Redis connections (queue producer + limiter/cache) separate from the worker's 2 (IN-05/OBS-05)
- [Phase ?]: [Phase 01]: 01-09: cycle-2 re-review clean pass (zero blocking findings) human-ratified — verdict flipped to READY per D-16; RR2-01/02/03 recorded as advisory Phase 4/5 design-debt notes, not verdict-gating
- [Phase ?]: [Phase 01]: 01-09: Phase-1-only Mode:mvp marker deleted from ROADMAP per 01-VERIFICATION round-2 disposition — documentation-gate phase has no vertical-slice deliverables; Phases 2-8 keep theirs

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

Last session: 2026-09-09T17:05:50.845Z
Stopped at: Completed 01-09-PLAN.md (cycle-2 clean pass ratified — verdict flipped to READY; Phase 01 complete 9/9)
Resume file: None
