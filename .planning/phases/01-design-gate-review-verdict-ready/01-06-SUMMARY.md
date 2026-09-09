---
phase: 01-design-gate-review-verdict-ready
plan: 06
subsystem: design-docs
tags: [architecture-audit, tier2-flush, exclusive-snapshot, staging-keys, write-guards, alert-dedup, gap-closure, fix-cycle]
requires: [01-05]
provides: [CR-01-closed, CR-02-closed, CR-03-closed, IN-02-closed, IN-03-closed, IN-04-closed, OBS-01-closed, verdict-record-git-tracked]
affects: []
tech-stack:
  added: []
  patterns:
    - "RENAMENX staging-key exclusive snapshot (live keys -> agg:flushing:{batchId} / pings:flushing:{batchId})"
    - "multi-row INSERT INTO pings inside the guarded flush transaction (id column omitted, DB default applies per D-3)"
    - "batchId = {epochMs-of-flush-pass}:{monitorId} pinned, carried in BullMQ job data (deterministic under redelivery)"
    - "monitor-scoped first_check dedup key + non-NULL incident_id contract with UnrecoverableError dead-letter"
key-files:
  created:
    - docs/ARCHITECTURE-REVIEW.md (git-tracked this plan; content unchanged — pre-existing NOT READY record)
  modified:
    - docs/ARCHITECTURE-AUDIT.md
requirements: [DSGN-01]
decisions:
  - "01-06: flush exclusivity is a two-part guarantee — same-transaction write_guards guard (flush:{batchId}) PLUS RENAMENX staging snapshot; plain RENAME rejected because it re-fails CR-02's over-delete case on crash-after-COMMIT redelivery"
  - "01-06: batchId pinned {epochMs-of-flush-pass}:{monitorId}, carried in BullMQ job data so staging key names and the guard key are deterministic across retries (IN-03, D-10 form)"
  - "01-06: alert dedup is one key per declared outbox event type — alert:{incidentId}:down / alert:{incidentId}:recovered / alert:{monitorId}:first_check; down/recovered rows REQUIRE non-NULL incident_id, violations dead-letter via UnrecoverableError (CR-03)"
metrics:
  duration: 490s (~8m)
  completed: 2026-09-09
status: complete
---

# Phase 1 Plan 6: Fix-Cycle Writer-Spec Criticals (CR-01/CR-02/CR-03) Summary

Exclusive-snapshot Tier 2 flush (RENAMENX staging keys + multi-row ping INSERT + pinned batchId) closing CR-01/CR-02, three-key alert-dedup vocabulary with a non-NULL incident_id contract closing CR-03, IN-02/IN-03/IN-04/OBS-01 residuals closed, and the NOT READY verdict record git-tracked byte-identical.

## What Was Done

| Task | Name | Commit | Key changes |
|------|------|--------|-------------|
| 1 | Rewrite §16.2 with exclusive-snapshot semantics + bulk ping INSERT (CR-01 + CR-02 + IN-03) | `577fc24` | §16.2 rewritten as step 0 (read-only write_guards pre-check + `RENAMENX` live→staging snapshot) / step 1 (guard INSERT → multi-row `INSERT INTO pings (monitor_id, status, response_time, error_class, status_code, created_at)` → unchanged additive monotonic UPDATE) / step 2 (post-COMMIT `DEL` of staging keys only); batchId pinned `{epochMs-of-flush-pass}:{monitorId}`; §16 Tier 2 prose + invariants 4/5 rewritten; header amendment note records the fix-cycle pass |
| 2 | Propagate the new flush semantics to every mirror | `dd9b672` | §13.1 live-buffers row + new staging-keys row (TTL "none — deleted by the owning flush job after COMMIT"); §14.1 absent-jobs paragraph rewritten (record-pings-bulk token removed file-wide) + flush-lane producer cell de-thresholded (IN-02); §16.1 step-2 IN-04 zero-rows dual-cause comment; §16.6 flush re-apply row restated + new dead-lettered-flush inspect-only row (OBS-01); §23 TC-FLUSH-GUARD-01/TC-MONOTONIC-01 rewritten for staging keys; §13/§14/§23 fix-cycle markers |
| 3 | Alert dedup vocabulary for all three outbox event types (CR-03) + git-track the review doc | `eb70e1e` | §16.4 retitled with three-key vocabulary + non-NULL incident_id contract (UnrecoverableError dead-letter); §16.3 relay-validation bullet; §13.1 dedup row mirrors all three key shapes verbatim; new TC-FIRST-CHECK-DEDUP-01 (cross-monitor non-suppression); docs/ARCHITECTURE-REVIEW.md committed byte-identical (blob `520c9409da45bd2c9ab9866fe124403ef6cb7ef3`, hash-verified before add and after commit) |

## Coverage (plan must_haves → where closed)

- **CR-01 (routine ping-row evidence)** — §16.2 multi-row `INSERT INTO pings` sourced from the staged `pings:flushing:{batchId}` rows; §13.1 `pings:pending:{monitorId}` list row; §14.1 absent-jobs paragraph corrected; §15.1 step 6 Tier 2 dispatch names the `RPUSH`. Last-100-pings API contract and §16.5 windowed-uptime plan remain implementable as written.
- **CR-02 (exclusive snapshot semantics)** — step-0 `RENAMENX` snapshot + write_guards pre-check; invariant 5 two-part guarantee; TC-FLUSH-GUARD-01 pins the redelivered-flush no-op (counters AND ping rows change by zero; staging keys deleted on the exit path; live keys explicitly NOT deleted); §16.6 re-apply + dead-letter rows.
- **IN-03 (batchId scheme)** — pinned D-10 table row in §16.2 (`{epochMs-of-flush-pass}:{monitorId}`, non-negotiable shape, carried in job data).
- **IN-04 (zero-rows conflation)** — §16.1 step-2 comment: two causes (transition-made vs is_active-cleared), implementers must NOT branch, step-1 evidence ping accepted, retention cleans in 30 days.
- **CR-03 (dedup vocabulary)** — §16.4 three key formats; contract rule (down/recovered REQUIRE non-NULL incident_id; violation ⇒ `UnrecoverableError` dead-letter, never silent suppression); identical strings in §13.1 and §16.4; TC-FIRST-CHECK-DEDUP-01 asserts monitor 43's start alert sends while 42's redelivery is suppressed.
- **IN-02 (unpinned buffer threshold)** — §14.1 flush-lane cell now "purely time-based; no buffer threshold exists: §16 invariant 4 bounds the buffer by the 60 s window"; the old threshold phrase returns zero grep matches.
- **OBS-01 (dead-lettered flush ops note)** — §16.4 write-discipline bullet + §16.6 dead-lettered-flush row + §13.1 staging TTL cell: inspect-only, manual retry safe-no-op via the guard, unapplied deltas Tier 2 loss-tolerable, detection via DLQ/outbox-age.
- **Cross-section agreement** — every surface describing the Tier 2 flush (§13.1, §14.1, §15.1, §16, §16.2, §16.4, §16.6, §23) states the same staging-key + bulk-INSERT semantics; full grep sweep of `agg:results:` / `pings:pending:` / `agg:flushing:` / `pings:flushing:` / `alert:` occurrences confirmed consistent.
- **Verdict record tracked** — `git ls-files docs/ARCHITECTURE-REVIEW.md` returns the path; `git hash-object` still `520c9409da45bd2c9ab9866fe124403ef6cb7ef3`; content untouched (Task 3 committed it with the CR-03 amendments in `eb70e1e`).

## Verification Results

All per-task automated checks pass against `docs/ARCHITECTURE-AUDIT.md`: `agg:flushing:` ×10, `pings:flushing:` ×11, exact INSERT column list ×2 (§16.1 evidence ping + §16.2 bulk insert — and the list matches §11's pings columns exactly, id omitted per D-3), `epochMs-of-flush-pass` ×2, `fix cycle` ×7, `pings:pending:` ×7, `record-pings-bulk` ×0, old buffer-threshold phrase ×0, `TC-FIRST-CHECK-DEDUP-01` ×2, `alert:{monitorId}:first_check` ×2 (identical strings in §13.1 and §16.4), `inspect-only` ×2. Plan-level: review doc tracked at the pinned blob hash; `docs/ARCHITECTURE-AUDIT.md` fully committed (clean in `git status`); only pre-existing out-of-scope working-tree changes remain.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plain RENAME replaced with RENAMENX + write_guards pre-check + refined missing-key handling**
- **Found during:** Task 1 (§16.2 rewrite)
- **Issue:** The plan prescribed an atomic `RENAME` of live keys to staging. Plain `RENAME` fails the plan's own must-have truth and TC-FLUSH-GUARD-01 in the crash-after-COMMIT-before-DEL redelivery case: a retried flush would move post-snapshot live deltas into staging, and the guard's no-op exit would then `DEL` them — reintroducing exactly CR-02's over-delete failure mode the plan exists to close.
- **Fix:** (a) `RENAMENX` (destination-exists check) so a redelivered job whose staging keys still hold its earlier snapshot does not recapture live keys; (b) a read-only pre-check `SELECT 1 FROM write_guards WHERE key = 'flush:{batchId}'` before the rename (a returned row ⇒ batch already committed ⇒ skip straight to cleanup, never touching live keys); (c) missing-key handling refined to "neither live key exists AND neither staging key for this batch exists" so a staged-but-unapplied snapshot (crash-before-COMMIT redelivery) is applied rather than stranded. A "do not simplify back to RENAME" warning was written into the spec.
- **Files modified:** docs/ARCHITECTURE-AUDIT.md (§16.2 step 0 and bullet 2; §16.6 re-apply row's detection cell mentions the pre-check)
- **Commit:** `577fc24` (in-part `eb70e1e` for the §16.6 detection-cell echo)

**2. [Rule 2 - Missing critical] §15.1 step 6 Tier 2 dispatch names the RPUSH evidence row**
- **Found during:** Task 2 (mirror propagation)
- **Issue:** The plan's file scope named §13.1/§14.1/§16.1/§16.3/§16.6/§23 as mirrors but omitted §15.1 step 6 — the check-job algorithm that describes the Tier 2 write path. Left as-is it still described only `HINCRBY`/`HSET` counter deltas, so a Phase 4 implementer transcribing the check processor would never create `pings:pending:{monitorId}` rows: CR-01's write side would be unwired despite the flush-side INSERT existing.
- **Fix:** §15.1 step 6 now reads "…Redis `HINCRBY`/`HSET` counter deltas **plus one `RPUSH` evidence row onto `pings:pending:{monitorId}`** (per-check evidence is carried, not discarded — CR-01)".
- **Files modified:** docs/ARCHITECTURE-AUDIT.md (§15.1 step 6)
- **Commit:** `dd9b672`

### Process Notes

- **Task 3 commit amended (`4603cfd` → `eb70e1e`):** the initial Task-3 commit contained only `docs/ARCHITECTURE-REVIEW.md` (the audit file's Task-3 edits had not been staged). Corrected immediately with `git commit --amend --no-edit` after adding `docs/ARCHITECTURE-AUDIT.md`; the final commit contains both files (2 files changed, 342 insertions, 8 deletions). No other commits were amended.

## Auth Gates

None — docs-only plan, no authenticated systems touched.

## Known Stubs

None — no code was produced; the deliverable is the amended specification itself, and every amended section is complete (no TODO/placeholder markers introduced).

## Self-Check: PASSED

- Files: `docs/ARCHITECTURE-AUDIT.md` (committed, clean), `docs/ARCHITECTURE-REVIEW.md` (tracked at pinned blob `520c9409da45bd2c9ab9866fe124403ef6cb7ef3`) — both FOUND.
- Commits: `577fc24`, `dd9b672`, `eb70e1e` present in `git log` — all FOUND.
