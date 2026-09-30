---
phase: 06-thin-api-routes-email-abstraction (gap closure: 06-06 + 06-07)
fixed_at: 2026-09-30T22:01:01Z
review_path: .planning/phases/06-thin-api-routes-email-abstraction/06-REVIEW-GAPCLOSURE.md
iteration: 1
findings_in_scope: 2
fixed: 2
skipped: 0
status: partial_convention_note
scope_note: CR-01 (critical) + WR-01 (warning) fixed; IN-01 (info) explicitly out of scope and untouched.
---

# Phase 06 Gap Closure: Code Review Fix Report

**Fixed at:** 2026-09-30T22:01:01Z
**Source review:** 06-REVIEW-GAPCLOSURE.md
**Iteration:** 1
**Scope:** CR-01 + WR-01 (IN-01 out of scope per coordinator)

**Summary:**
- Findings in scope: 2
- Fixed: 2
- Skipped: 0

## READ THIS FIRST — CR-01 premise correction (empirical)

The review's central claim — *"the compensating restore is provably inert
against real production data"* — **does not reproduce on this repo's actual
stack**. Before applying any fix, the requested real-Postgres integration test
was run against the UNFIXED route and **PASSED**: the compensate log printed
`[check-route-compensate] monitorId=6 restored next_check_at to its
pre-advance value (prior=2026-09-30 10:00:00.123456+00)` — a full-microsecond
TEXT string, not a ms-truncated Date.

Root cause of the discrepancy: the reviewer traced node-postgres's default
type parsing (postgres-date, ms truncation), but the route's queries ride the
**drizzle-orm client**, and drizzle-orm 0.45.x's node-postgres session
(`node_modules/drizzle-orm/node-postgres/session.js:24-57`) installs a custom
`types.getTypeParser` on EVERY query that returns the raw server text for
TIMESTAMPTZ (1184), TIMESTAMP (1114), DATE, INTERVAL and their array twins.
So `db.execute` RETURNING values already reached the route as full-microsecond
strings, the string parameter was implicitly cast losslessly, and the guard
matched. A strict RED-then-GREEN demonstration is therefore **impossible** and
was not fabricated.

The review's fix was **still applied** (see CR-01 below): it moves the
precision guarantee into the SQL contract itself, removing the dependency on a
drizzle-internal parser behavior — if a future drizzle upgrade ever drops that
override, the old Date-plumbing would have silently recreated exactly the
inert-restore failure the review predicted. The genuine defect the review DID
prove is test-fidelity: the mocked unit suite fed the route exact-second JS
Dates, misrepresenting the real wire format — also fixed.

## Fixed Issues

### CR-01: Compensating restore's equality guard can never match real `next_check_at` values

**Files changed:**
- `src/app/api/monitors/[id]/check/route.ts` — the fix
- `tests/integration/check-route-restore.test.ts` — new real-PG integration suite
- `tests/api/check-route.handler.test.ts` — fixture fidelity + µs-text pins

**Commit:** `f050cab` (`fix(06): restore next_check_at via an explicit ::text round trip at full precision (CR-01)`)

**Mechanism:**
1. Advance `RETURNING` now casts both captured timestamps to text:
   `prior.next_check_at::text AS prior_next_check_at, m.next_check_at::text AS advanced_next_check_at` — precision is fixed at the SQL layer, independent of any driver parser.
2. The restore re-casts with explicit `::timestamptz`:
   `SET next_check_at = ${priorNextCheckAt}::timestamptz` and the guard
   `AND next_check_at = ${advancedNextCheckAt}::timestamptz` — Postgres text
   rendering of `timestamptz` is µs+offset and re-parses losslessly, so the
   equality guard is exact by construction.
3. `claimedRows` typed as `string` (was `Date | string`); the dead
   `instanceof Date` `priorLabel` branch is removed (values are strings by
   construction); comments document the parser finding and the lossless
   round trip.
4. Unit-suite fixtures are now µs-bearing timestamptz text
   (`"2026-09-30 10:00:00.123456+00"`), matching the real wire format the
   route actually receives; the restore-parameter identity assertions
   (`toContain`) now pin the string round trip.

**Test evidence (new integration suite `tests/integration/check-route-restore.test.ts`):**
- Runs the REAL route handler over the REAL drizzle client (`@/db`) against
  the docker test Postgres (`:5453`, `TEST_DATABASE_URL`); only the session
  door, limiter, and enqueue path are seam-mocked; the enqueue seam is forced
  to reject to reach the compensation catch.
- Case 1: failed enqueue → 503, and the row carries its EXACT pre-advance
  value — byte-identical `next_check_at::text` in one UTC session AND exact
  `timestamptz` equality (`(next_check_at = $2::timestamptz) AS restored` →
  true), seeded µs-bearing (`2026-09-30 10:00:00.123456+00`).
- Case 2: successful enqueue → 202, the µs-bearing advance stands, no
  compensation.
- **Pre-fix run: GREEN (2/2) — this is the documented proof that the
  "inert restore" premise does not reproduce** (drizzle parser override, see
  the correction section and the suite header). Post-fix: GREEN (2/2).

### WR-01: Manual-follow-up comment claims the "deactivated race" is a benign no-op, but the persist writes to a paused monitor

**Files changed:**
- `src/worker/persist/tier2.ts` — opt-in `requireActive` guard
- `src/worker/engine/check.ts` — gated call site + honest contract comment
- `tests/worker/engine-check.test.ts` — pin test (engine case 12)

**Commits:** `61a6425` (`test(06): pin the deactivated-monitor manual-follow-up contract (WR-01)`) → `0e6e805` (`fix(06): gate the manual follow-up with a requireActive isActive guard (WR-01)`)

**Mechanism (the review's option b — the guard):** the codebase elsewhere
treats deactivated monitors as fully inert (engine step-1 no-op, tier1's
`AND "isActive"` transition guard, the route's D-28 paused-monitor posture),
so the guard was chosen over fixing the comment.
1. `monitorFlushUpdateSql` gains an opt-in 6th param `requireActive = false`
   appending ` AND "isActive"` to the WHERE — gated PER CALL so the shared
   Tier-2 flushes keep the ungated form (their SQL is byte-identical; the
   persist-tier2 SQL-shape pins pass unchanged).
2. The manual in-job follow-up passes `requireActive: true` — a monitor
   deactivated mid-job records NOTHING beyond its statement-1 evidence ping
   (01-01 pin preserved); a vanished monitor matches zero rows identically —
   one shared no-write outcome, no branching on which cause fired (IN-04).
3. `manualFlushed` is now set only when the follow-up actually WROTE rows;
   the zero-row outcome is logged explicitly instead of claiming a persist
   that did not happen. The check.ts comment now states the two causes
   honestly (WR-01's option a satisfied as a byproduct).

**Test evidence (engine case 12, `tests/worker/engine-check.test.ts`):**
- Deactivates the monitor at the `beforeReverify` checkpoint seam of a MANUAL
  job (real Postgres + real fixture target server).
- RED (run against pre-fix engine, commit `61a6425` message): the ungated
  follow-up wrote the paused monitor — `manualFlushed: true` surfaced in the
  result, counters advanced 3→4. Failure output pinned in the commit body.
- GREEN (post-fix): result equals exactly
  `{ outcome: "tier1", targetStatus: "UP", applied: false, eventType: null, incidentId: null }`
  (`manualFlushed` absent), `totalChecks` stays 3, `lastChecked` stays NULL,
  exactly ONE ping row (the evidence ping), status never transitioned.

## Verification

All commands run in the MAIN checkout on `main` (sequential agent; no
worktree), docker test stack `spidernode-test-db`/`-redis` up and healthy
(:5453/:6390). Production stack untouched.

| Suite | Result |
|---|---|
| `tests/api/check-route.handler.test.ts` | 15/15 passed |
| `tests/integration/check-route-restore.test.ts` (new) | 2/2 passed |
| `tests/worker/persist-tier2.test.ts` (SQL-shape pins on the changed builder) | 10/10 passed |
| `tests/worker/engine-check.test.ts` (incl. new case 12) | 12/12 passed |
| `pnpm typecheck` | exit 0 |

**Commits (atomic per finding, hooks clean):**
1. `f050cab` — fix(06): restore next_check_at via an explicit ::text round trip at full precision (CR-01)
2. `61a6425` — test(06): pin the deactivated-monitor manual-follow-up contract (WR-01) [RED evidence]
3. `0e6e805` — fix(06): gate the manual follow-up with a requireActive isActive guard (WR-01)

**Out of scope (untouched):** IN-01 (info) per coordinator instruction; the
pre-existing dirty files (`skills-lock.json`, `tests/resilience/observations.json`,
Dashboard .tsx work from the concurrent session) were never staged.

**Human-verification note:** CR-01's shipped change is a strictly-safer
reformulation (explicit casts; behavior verified identical end-to-end on real
Postgres), but because the review's inertness premise did not reproduce, a
human should confirm they accept the correction-of-record above — the
production incident risk CR-01 described was not live on this stack.

---

_Fixed: 2026-09-30T22:01:01Z_
_Fixer: ZCode (gsd-code-fixer)_
_Iteration: 1_
