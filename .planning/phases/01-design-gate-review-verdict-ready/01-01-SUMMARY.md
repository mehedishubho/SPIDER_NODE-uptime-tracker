---
phase: 01-design-gate-review-verdict-ready
plan: "01"
subsystem: database
tags: [postgresql, ddl, drizzle, write-guards, outbox, partial-index, sql, design-doc]

# Dependency graph
requires:
  - phase: 01-design-gate-review-verdict-ready (planning)
    provides: 01-CONTEXT.md decisions D-01..D-18, 01-RESEARCH.md verified SQL semantics, 01-PATTERNS.md amendment conventions
provides:
  - DDL-precise §11 schema addendum (next_check_at + idx_monitors_due, write_guards, outbox + idx_outbox_unsent, incidents_one_ongoing, pings.error_class/status_code, consecutive_failures, pinned ID defaults)
  - Literal-SQL §16 writer specs (Tier 1 transition transaction, guarded monotonic flush, outbox relay, incident-keyed alert dedup, D-6/Q-1 uptime-semantics decision)
  - §23 data-correctness test cases (TC-DUP-INCIDENT-01, TC-DUP-ALERT-01, TC-FLUSH-GUARD-01, TC-MONOTONIC-01)
  - D-02 amendment marker machinery (header note + inline markers on §11, §16, §23)
affects: [01-02 (scheduler/queue spec cites §11 claim column), 01-03 (breaker probes reuse write_guards), 01-05 (adversarial re-review verifies §9 items 1/2/8-12), Phase 3 (Drizzle transcription), Phase 4 (writer implementation)]

# Tech tracking
tech-stack:
  added: []  # documentation phase — no packages installed
  patterns:
    - "D-02 inline amendment markers: *Amended YYYY-MM-DD (resolves <issue-ids>)* immediately under each amended heading"
    - "D-05 DDL-precision spec: new/changed objects as fenced sql DDL; existing column types carry verify-against-live-pg_dump (M-6/DRZ-01) markers; Drizzle fragments only for subtle index semantics"
    - "D-10 parameter pinning: every schema-level parameter gets Default/Rationale/Class (non-negotiable vs tune-in-Phase-4/5)"
    - "Tier classification rule: result changes status → Tier 1 transaction; result matches status (routine or manual) → Tier 2 aggregate"

key-files:
  created: []
  modified:
    - docs/ARCHITECTURE-AUDIT.md

key-decisions:
  - "outbox.monitor_id is integer (not uuid) — FK must match the integer serial monitors.id per locked M-5 decision"
  - "outbox.incident_id text NULL added — required by §16 transition SQL and the alert dedup key alert:{incidentId}:{direction}"
  - "Evidence ping INSERT precedes the conditional UPDATE in the Tier 1 transaction — satisfies TC-DUP-INCIDENT-01 (both evidence rows, single gated transition); counters ride the conditional UPDATE so duplicates count once"
  - "ID generation pinned DB-side gen_random_uuid()::text; spec SQL omits id columns on INSERT so defaults apply"
  - "DSGN-01 intentionally NOT marked complete — shared by plans 01-01..01-04; this plan delivered only the data-correctness slice of the 8 addenda"

patterns-established:
  - "Amendment marker format + header blockquote note (D-02) — all later audit amendments in this phase must follow it"
  - "Parameter-pinning table shape (Parameter/Default/Rationale/Class) for D-10"

requirements-completed: []  # DSGN-01 remains Pending in REQUIREMENTS.md: shared by plans 01-01..01-04 (all 8 addenda); this plan covers the schema/writer/tests slice only

coverage:
  - id: D1
    description: "D-02 marker machinery: dated audit-header amendment note + inline markers on §11, §16, §23"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: 'grep -cE "Amended 2026-" docs/ARCHITECTURE-AUDIT.md → 4 (≥2 required)'
        status: pass
    human_judgment: false
  - id: D2
    description: "§11 DDL-precise schema addendum: next_check_at + idx_monitors_due, consecutive_failures, write_guards, outbox + idx_outbox_unsent, incidents_one_ongoing, pings.error_class/status_code, pinned ID defaults, parameter table"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: 'grep -c next_check_at → 8 (≥4); grep -c write_guards → 5 (≥3); grep -c "WHERE status = ''ONGOING''" → 2 (≥1); grep -c error_class → 2 (≥2); grep -c "pgTable(" → 0'
        status: pass
    human_judgment: false
  - id: D3
    description: "§16 literal-SQL writer specs: transition transaction, guarded monotonic flush, outbox relay, incident-keyed dedup, D-6/Q-1 decision note, failure-mode table"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: 'grep -c "FOR UPDATE SKIP LOCKED" → 3 (≥1); grep -c GREATEST → 4 (≥1); grep -c "ON CONFLICT" → 8 (≥3)'
        status: pass
    human_judgment: false
  - id: D4
    description: "§23 data-correctness given/when/then test cases TC-DUP-INCIDENT-01 / TC-DUP-ALERT-01 / TC-FLUSH-GUARD-01 / TC-MONOTONIC-01 with concrete DB/Redis/queue effects"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: 'grep -cE "TC-DUP-INCIDENT-01|TC-DUP-ALERT-01|TC-FLUSH-GUARD-01|TC-MONOTONIC-01" → 7 lines, each ID ≥1; grep -ciE "given.*when.*then|Given:" → 5 (≥4)'
        status: pass
    human_judgment: false

# Metrics
duration: 11min
completed: 2026-09-09
status: complete
---

# Phase 1 Plan 1: Data-Correctness Design Slice Summary

**DDL-precise schema addendum (§11) + literal-SQL writer specs (§16: guarded flush, transition transaction, outbox relay, incident-keyed dedup) + four given/when/then data-correctness test cases (§23), with D-02 amendment markers throughout**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-09-08T19:48:33Z
- **Completed:** 2026-09-09 (local)
- **Tasks:** 3/3
- **Files modified:** 1 (docs/ARCHITECTURE-AUDIT.md)

## Accomplishments

- Audit header blockquote now carries the dated amendment note; §11, §16, §23 each carry an inline `*Amended 2026-09-09 (resolves …)*` marker — the D-02 greppability machinery the §9 re-review scan depends on
- §11 specifies every new/changed object at column/type/default/nullability/index precision: `monitors.next_check_at timestamptz NULL` + backfill + `idx_monitors_due ON (is_active, next_check_at) WHERE is_active` (supersedes the `(is_active, last_checked)` sketch), `consecutive_failures integer NOT NULL DEFAULT 0`, `write_guards(key text PK, created_at)`, `outbox` with `idx_outbox_unsent ON (created_at) WHERE sent_at IS NULL`, `incidents_one_ongoing UNIQUE ON (monitor_id) WHERE status = 'ONGOING'` with the ON CONFLICT inference + CONCURRENTLY caveat, `pings.error_class`/`status_code`, DB-side `gen_random_uuid()::text` ID defaults; existing column types carry verify-against-live-pg_dump markers and the full pgTable sketch was removed (only the two partial-index Drizzle fragments remain)
- §16 rewritten as the two-tier writer spec in literal SQL: evidence-ping-first Tier 1 transition transaction (conditional UPDATE gate + ON CONFLICT incident backstop + in-transaction outbox INSERT), guarded monotonic flush with the pinned GREATEST NULL-ignoring / CASE NULL asymmetry semantics (postgresql.org citations, reachability note), FOR UPDATE SKIP LOCKED outbox relay, `alert:{incidentId}:{direction}` SET NX EX dedup (≤3 attempts, check-before-retry), the D-6/Q-1 lifetime-counters decision, and a 4-row writer failure-mode table
- §23 extended with the four data-correctness cases in given/when/then form with concrete timestamps, counters, and key names; each Then names expected DB rows / Redis keys / queue state
- §11↔§16 column contract verified: every column the §16 SQL reads/writes exists in the §11 DDL; no orphan columns, no missing columns

## Task Commits

Each task was committed atomically:

1. **Task 1: Audit header amendment note + §11 schema addendum (DDL-precise)** — `1601c2b` (docs)
2. **Task 2: §16 writer specs as literal SQL (transition, flush, relay, dedup)** — `2a640eb` (docs)
3. **Task 3: §23 data-correctness test cases (given/when/then)** — `b6e9694` (docs)

**Plan metadata:** see final commit below

## Files Created/Modified

- `docs/ARCHITECTURE-AUDIT.md` — authoritative design doc: §11 schema addendum, §16 writer specs, §23 test cases, header amendment note (file was previously untracked; first commit also brought it under version control)

## Decisions Made

- `outbox.monitor_id` declared `integer REFERENCES monitors(id)` — the plan text said "uuid", but a uuid FK cannot reference the integer `serial` PK that locked decision M-5/§11.1 keeps; integer is the only type-correct shape
- `outbox.incident_id text NULL REFERENCES incidents(id) ON DELETE CASCADE` added to the DDL — the alerts processor derives the dedup key from it; without the column the §16 SQL would reference a non-existent column
- Evidence ping INSERT placed **before** the conditional UPDATE in the Tier 1 transaction (the review's sketch listed it after) — the plan's own TC-DUP-INCIDENT-01 requires "pings contains both evidence rows" while the second run's UPDATE returns zero rows; counters ride the conditional UPDATE so duplicate deliveries count a check exactly once
- Tier classification stated explicitly (result changes status → Tier 1; result matches status, manual or scheduled → Tier 2) so manual non-transition checks still advance counters/last_checked via the flush — closing a counter-undercount gap in the review sketch
- `write_guards` retention pinned at 7 days (daily, maintenance queue) to bound table growth — not specified by plan/review; D-10 requires every parameter pinned
- DSGN-01 left Pending in REQUIREMENTS.md — it spans all 8 addenda and is shared by plans 01-01..01-04; marking it complete after 1 of 4 contributing plans would falsify the traceability table

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] outbox.monitor_id type corrected from uuid to integer**
- **Found during:** Task 1 (§11 addendum authoring)
- **Issue:** Plan specified "`monitor_id` uuid referencing monitors", but `monitors.id` is integer `serial` (locked M-5 decision, §11 mapping decision 1) — a uuid FK to an integer PK is invalid DDL the re-reviewer would reject and Phase 3 could not transcribe
- **Fix:** `monitor_id integer NOT NULL REFERENCES monitors(id) ON DELETE CASCADE`, with an explanatory bullet in §11
- **Files modified:** docs/ARCHITECTURE-AUDIT.md (§11 outbox subsection)
- **Verification:** §11 DDL is internally consistent with M-5; noted in key-decisions
- **Committed in:** 1601c2b (Task 1 commit)

**2. [Rule 2 - Missing critical functionality] outbox.incident_id column added**
- **Found during:** Task 1/2 cross-check (plan key_links verification)
- **Issue:** Plan's §11 outbox column list omitted `incident_id`, but §16's transition INSERT and the `alert:{incidentId}:{direction}` dedup key require it; the plan's own verification ("§16 SQL reads/writes every column §11 creates — no orphan columns") would fail
- **Fix:** Added `incident_id text NULL REFERENCES incidents(id) ON DELETE CASCADE` with a live-type verify marker
- **Files modified:** docs/ARCHITECTURE-AUDIT.md (§11 outbox subsection)
- **Verification:** Column cross-check grep — §16.1/§16.3 SQL columns all present in §11 DDL
- **Committed in:** 1601c2b (Task 1 commit)

**3. [Rule 2 - Missing critical functionality] Tier 1 statement ordering + tier classification rule**
- **Found during:** Task 2 (§16 rewrite)
- **Issue:** Review's single-sketch ordering (UPDATE gates everything incl. ping) contradicts TC-DUP-INCIDENT-01's "pings contains both evidence rows"; also, manual checks with unchanged status would have skipped counter increments entirely (uptime-math behavior regression)
- **Fix:** Evidence ping INSERT first (unconditional); conditional UPDATE carries counters + status; incident/outbox effects gated on RETURNING; explicit classification rule routes unchanged-status results (manual or routine) to Tier 2
- **Files modified:** docs/ARCHITECTURE-AUDIT.md (§16 intro + 16.1)
- **Verification:** TC-DUP-INCIDENT-01 Then-clause matches §16.1 statement semantics exactly
- **Committed in:** 2a640eb (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 bug, 2 missing-critical)
**Impact on plan:** All three were correctness requirements derived from the plan's own must_haves, locked decisions, and key_links contract. No scope creep; no §13/§14 content touched (explicitly out of scope — plans 01-02/01-03 own those rewrites).

## Issues Encountered

- The injection-scanner hook flagged `?secret=` while reading the audit — false positive (documented R15 security-issue description), no action needed
- Stale §13 sentences (`falls back to writing routine pings`, `alert:sent:{monitorId}:{state}`, `interval + slack`) still grep in the audit — intentional: §13/§14 are owned by plans 01-02/01-03 per the phase's §8→amendment-location map; this plan was instructed not to edit them

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- §11/§16/§23 amendments are in place with markers; plans 01-02 (scheduler spec + queue topology, §14/§15) and 01-03 (resilience/Redis rewrite, §13) build on `next_check_at`, `write_guards` (breaker probe keys), and the tier classification rule established here
- The §13/§14 stale sentences remain until those plans land — the phase-level stale-string grep (research validation) will pass only after plan 01-03
- The adversarial re-review (plan 01-05) can verify §9 items 1, 2, 8, 9, 10, 11, 12 (schema part) and §10 criterion 3's duplicate-incident/duplicate-alert halves against greppable content

## Known Stubs

None — documentation deliverable; every specified mechanism is complete on paper (no placeholder values).

## Threat Flags

None — no new security-relevant surface beyond the plan's threat model (documentation only; T-01-01..T-01-04 mitigations authored as specified).

## Self-Check: PASSED

- docs/ARCHITECTURE-AUDIT.md — FOUND
- .planning/phases/01-design-gate-review-verdict-ready/01-01-SUMMARY.md — FOUND
- Commits 1601c2b, 2a640eb, b6e9694 — FOUND in git log
- Re-ran coverage greps from a clean shell: Amended 2026- = 4; all task verification counts reproduced as claimed

---
*Phase: 01-design-gate-review-verdict-ready, Plan 01*
*Completed: 2026-09-09*
