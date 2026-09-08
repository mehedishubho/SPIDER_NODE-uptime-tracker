---
phase: 01-design-gate-review-verdict-ready
plan: "02"
subsystem: infra
tags: [bullmq, job-schedulers, upsertJobScheduler, postgresql, skip-locked, ssrf, distributed-lock, queue-priority, design-doc]

# Dependency graph
requires:
  - phase: 01-design-gate-review-verdict-ready (planning)
    provides: 01-CONTEXT.md decisions D-01..D-18, 01-RESEARCH.md verified SQL/BullMQ semantics, 01-PATTERNS.md stale-sentence table + amendment conventions
  - phase: 01-design-gate-review-verdict-ready (plan 01-01)
    provides: §11 next_check_at column + idx_monitors_due predicate the claim WHERE matches; §16 Tier 1/Tier 2 contracts §15 dispatches to; §23 TC-DUP/TC-FLUSH/TC-MONOTONIC cases the new batch appends alongside
provides:
  - §14 scheduler spec — numbered tick algorithm (upsertJobScheduler idempotency, claim, per-id enqueue with jobId check:{monitorId}:{epoch}, J-5 backlog gate, healthchecks.io heartbeat, failed-enqueue compensation)
  - §14.3 literal claim SQL with FOR UPDATE SKIP LOCKED pinned inside the CTE (postgresql.org/docs citation, LIMIT interplay, READ COMMITTED ordering caution, idx_monitors_due alignment note)
  - §14.1 D-12 per-queue topology — every lane an explicit priority (manual/non-UP 1, tick/relay/alerts 1, maintenance/email 5, routine 10), concurrency, rate limits, removeOn*, stalled config, J-6 worst-case latency bound
  - §15 check job spec — execution-time monitor re-read, J-3 lock lifecycle (TTL = 10 s + 5 s margin, renewal TTL/3, owner-only Lua release, abort-on-lock-loss), S-1 layered SSRF pipeline, J-4 classification, §16 tier dispatch
  - §23 SSRF + classification test cases (TC-SSRF-REDIRECT-PRIVATE-01, TC-SSRF-DNS-REBIND-01, TC-SSRF-SCHEME-01, TC-SSRF-SIZE-CAP-01, TC-CLASSIFY-TIMEOUT-01, TC-CLASSIFY-DNS-01, TC-CLASSIFY-INFRA-01)
affects: [01-03 (§13 rewrite must honor §14's leader-lock/heartbeat/breaker cross-references and §15's lock-key contract), 01-05 (adversarial re-review verifies §9 items 1/3/4/5/6/18 and §10 criterion 3), Phase 4 (scheduler/check/queue implementation transcribes §14–§15), Phase 2 (characterization suite transcribes §23 cases)]

# Tech tracking
tech-stack:
  added: []  # documentation phase — no packages installed
  patterns:
    - "D-07 numbered algorithm + 4-column failure-mode table (Failure/Detection/Response/Recovery) for behavioral specs"
    - "Claim-epoch idempotency: jobId = check:{monitorId}:{epoch-of-next_check_at} — unique per monitor per schedule slot and per tick; BullMQ jobId dedup makes duplicate adds a no-op"
    - "Explicit priority on EVERY BullMQ lane — default priority 0 processes non-prioritized jobs BEFORE prioritized ones, so any unprioritized lane inverts J-6"
    - "Layered SSRF pipeline as ordered sub-steps: scheme allowlist pre-I/O → resolve-then-validate all A/AAAAs → connection-time set-membership re-validation (rebinding) → per-hop re-validation cap 5 → 2 MB body cap, all inside the 10 s timeout"
    - "J-4 classification contract: target outcomes are successful jobs with typed error_class; only infra failures throw"

key-files:
  created: []
  modified:
    - docs/ARCHITECTURE-AUDIT.md

key-decisions:
  - "Every BullMQ lane carries an explicit priority (manual/non-UP checks 1, tick/relay-pass/alerts 1, maintenance/email 5, routine 10) — BullMQ default 0 means non-prioritized jobs run BEFORE prioritized ones"
  - "Claim SQL RETURNING extended to (id, status, next_check_at) — J-6 lane assignment and the jobId epoch derive from the atomic claim; WHERE clause unchanged from the verified baseline"
  - "J-5 backlog gate drops only routine (priority-10) enqueues; the non-UP lane is never gated — transition writes are synchronous inside check jobs (§16.1) and thus never droppable"
  - "recompute-uptime and record-pings-bulk removed from §14 job lists — D-6/§16.5 lifetime counters are authoritative; Tier 2 persistence is the single §16.2 guarded flush"
  - "Worst-case J-6 latency documented as (priority-1 depth × 10 s) ÷ concurrency 10, with priority-1 depth bounded by non-UP monitor count + manual admissions (≤ 6/min/user, D-13)"

patterns-established:
  - "Amendment marker format maintained: *Amended 2026-09-09 (resolves <issue-ids>; §9 items N)* under each amended heading (D-02)"
  - "Per-lane queue-topology row shape (9 columns incl. Priority) — the D-12 table pattern Phase 4 transcribes"
  - "Given/when/then §23 cases that name DB rows + queue state + network effect in every Then clause"

requirements-completed: []  # DSGN-01 remains Pending: shared by plans 01-01..01-04 (all 8 addenda); this plan delivered the orchestration slice (§14/§15/§23) only

coverage:
  - id: D1
    description: "§14 scheduler spec: D-02 marker (J-1, J-5, J-6), numbered tick algorithm, literal claim SQL with locking clause inside the CTE, failure-mode + parameter-pinning tables, stale vocabulary purged"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: 'grep -c upsertJobScheduler → 2 (≥2); grep -c "FOR UPDATE SKIP LOCKED" → 5 (≥2); grep -c "check:{monitorId}" → 4 (≥1); sed -n "/^## 14/,/^## 16/p" | grep -c repeatable → 0; same region grep -c scheduledAt → 0'
        status: pass
    human_judgment: false
  - id: D2
    description: "§14.1 D-12 queue topology: priority cell filled on every lane (manual 1 / non-UP 1 / routine 10 / relay 1 / alerts 1 / maintenance 5 / email 5 / tick 1), concurrency, rate limits, removeOnComplete/removeOnFail, stalled config with verify-against-Phase-4 flags, J-6 worst-case latency bound"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: 'manual read of §14.1 table — 9 rows, 0 empty Priority cells; J-6 bound paragraph present; per-lane attempts/backoff list present'
        status: pass
    human_judgment: false
  - id: D3
    description: "§15 check job spec: D-02 marker (J-3, J-4, S-1), numbered algorithm (re-read, lock acquire/renew/release with abort-on-loss, SSRF sub-steps, classification, §16 dispatch), 7-row failure-mode table, D-10 pinning (timeout/hop-cap/body-cap non-negotiable, margin 5 s default)"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: 'grep -ciE abort → 11 (≥2); grep -cE "TTL/3" → 2 (≥1); grep -cE ssrf_blocked → 10 (≥1); grep -cE "Amended 2026-" → 7 (≥6)'
        status: pass
    human_judgment: false
  - id: D4
    description: "§23 SSRF + classification given/when/then cases: all seven IDs exactly once; REDIRECT-PRIVATE asserts job-success AND no-network-reach; TIMEOUT/DNS assert no-retry; INFRA asserts bounded retry + Tier 1 atomicity; every Then names DB/queue/network effect"
    requirement: DSGN-01
    verification:
      - kind: other
        ref: 'grep -cE "TC-SSRF-REDIRECT-PRIVATE-01|TC-SSRF-DNS-REBIND-01|TC-SSRF-SCHEME-01|TC-SSRF-SIZE-CAP-01|TC-CLASSIFY-TIMEOUT-01|TC-CLASSIFY-DNS-01|TC-CLASSIFY-INFRA-01" → 7; per-ID grep → each exactly 1'
        status: pass
    human_judgment: false

# Metrics
duration: 4min
completed: 2026-09-09
status: complete
---

# Phase 01 Plan 02: Orchestration Design Slice Summary

**Audit §14/§15/§23 amended: SKIP LOCKED claim transaction + upsertJobScheduler tick, D-12 per-lane priority queue topology, J-3 lock lifecycle, J-4 classification, layered S-1 SSRF pipeline, and seven given/when/then SSRF/classification test cases**

## Performance

- **Duration:** 4 min (231 s)
- **Started:** 2026-09-08T20:15:36Z
- **Completed:** 2026-09-08T20:20:44Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments

- §14 now specifies the scheduler as a verifiable algorithm: one Job Scheduler tick (`upsertJobScheduler('scheduler-tick', { every: 30 s })`), a single-transaction claim returning `(id, status, next_check_at)`, per-id enqueue with `jobId = check:{monitorId}:{epoch}`, a J-5 backlog gate that drops only routine enqueues, a healthchecks.io heartbeat with `/fail` on exception, and documented failed-enqueue compensation (claims stay advanced; next tick re-claims).
- The literal claim SQL pins `FOR UPDATE SKIP LOCKED` inside the `WITH` query with the postgresql.org/docs citation (outer-level locking clauses do not reach into WITH queries), the LIMIT interplay note, the READ COMMITTED ordering caution, and the idx_monitors_due (§11) alignment note — two concurrent ticks provably cannot claim the same row (locks + advanced `next_check_at`, defense in depth).
- D-12 queue topology gives every lane an explicit priority (manual/non-UP 1, tick/relay/alerts 1, maintenance/email 5, routine 10) because BullMQ's default 0 processes non-prioritized jobs BEFORE prioritized ones; includes concurrency, rate limits, removeOn*, stalled config (with verify-against-Phase-4-BullMQ-6 flags), per-lane attempts/backoff, and the documented J-6 worst-case latency bound.
- §15 specifies the check job end-to-end: execution-time monitor re-read (deleted/inactive monitors complete as no-ops), lock lifecycle per J-3 (SET NX PX, TTL = 10 s timeout + 5 s margin, renewal every TTL/3, owner-only Lua compare-and-delete, explicit abort-on-lock-loss), the ordered S-1 SSRF pipeline (scheme allowlist pre-I/O, resolve-then-validate all A/AAAA IPs, connection-time re-validation against the resolve-time set, per-hop redirect re-validation capped at 5, 2 MB body cap, all within 10 s), J-4 classification (target outcomes are successful jobs; only infra failures throw), and §16 tier dispatch without restating the SQL.
- §23 gains the seven SSRF/classification cases in D-08 form — §10 re-review criterion 3's SSRF half is satisfied and J-4's contract is pinned as executable test intent.

## Task Commits

Each task was committed atomically:

1. **Task 1: §14 scheduler spec + D-12 queue-topology table** - `1b1040f` (docs)
2. **Task 2: §15 check job spec (lock lifecycle, classification, SSRF pipeline)** - `53794f6` (docs)
3. **Task 3: §23 SSRF + classification test cases (given/when/then)** - `36a8ad7` (docs)

**Plan metadata:** see final commit below (docs: complete plan)

## Files Created/Modified

- `docs/ARCHITECTURE-AUDIT.md` - §14 replaced (stale vocabulary purged: legacy recurring-job wording, last_checked-based due selection, old idempotency token); §15 amended (marker + §15.1–15.3 added, existing content preserved); §23 extended (7 new TC cases with subsection marker). §13 untouched (byte-identical, verified by hash) — plan 01-03 owns it.

## Decisions Made

- Every BullMQ lane carries an explicit priority; reference assignment manual/transition 1, maintenance 5, routine 10, refined with rationale (cadence/transition-critical lanes 1, user-facing non-monitoring 5, routine droppable 10); priority orders within a queue only.
- Claim SQL `RETURNING` extended to `(id, status, next_check_at)` so the tick assigns the J-6 lane and computes the jobId epoch from the atomic claim without a second query; WHERE clause unchanged from the research baseline (documented inline in §14.3).
- Backlog gate semantics pinned: routine enqueues are droppable (self-heal next interval); the non-UP lane is never gated; transition writes are never droppable because they run synchronously inside check jobs (§16.1).
- `recompute-uptime` and `record-pings-bulk` removed from the job lists (contradicted amended §16.5/§16.2); `send-alert` producer changed to the outbox relay with `{ incidentId, eventType, channels[] }` payload (D-2/D-4 consistency).
- Amendment markers cite §9 item 18 for S-1 (see Deviations #1).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] §9 item number corrected: 19 → 18 for S-1 in amendment markers**
- **Found during:** Task 2 / Task 3 (marker authoring)
- **Issue:** The plan instructed markers citing "S-1 … §9 items 3, 4, 19" / "§9 items 4, 19", but in ARCHITECTURE-REVIEW.md's §9 checklist S-1 is the **18th** bullet; item 19 is S-2 (Telegram webhook secret_token), which belongs to plan 01-04's auth spec. A marker citing item 19 for S-1 content would be a factually wrong citation for the re-reviewer.
- **Fix:** §15 marker reads `(resolves J-3, J-4, S-1; §9 items 3, 4, 18)` and the §23 batch marker reads `(resolves S-1, J-4; §9 items 4, 18; §10 criterion 3)`. Issue IDs cited exactly as planned.
- **Files modified:** docs/ARCHITECTURE-AUDIT.md
- **Verification:** manual count of the §9 checklist bullets (S-1 = 18th, S-2 = 19th); markers present via `grep -n "Amended 2026-"`.
- **Committed in:** 53794f6, 36a8ad7

**2. [Rule 2 - Missing critical functionality] Claim SQL RETURNING extended beyond the research baseline**
- **Found during:** Task 1 (tick algorithm authoring)
- **Issue:** The research Code Examples claim returns `m.id` only, but the tick's step 3 must assign the J-6 priority lane (`status <> 'UP'` → 1) and compute the jobId epoch from the claim's advanced `next_check_at`. Without the extension, §14 would need a second query per tick or an unspecified status source.
- **Fix:** `RETURNING m.id, m.status, m.next_check_at`, documented inline in §14.3 as a deliberate deviation; the WHERE clause (the load-bearing, verified part) is byte-identical to the baseline.
- **Files modified:** docs/ARCHITECTURE-AUDIT.md
- **Verification:** §14.3 fenced SQL matches the research SQL except the RETURNING line; WHERE matches §11's idx_monitors_due predicate.
- **Committed in:** 1b1040f

**3. [Rule 1 - Bug] Consistency replacements required by amended §16 (replace-not-append mandate)**
- **Found during:** Task 1 (queue-table rewrite)
- **Issue:** The old §14 queue table contradicted 01-01's amended §16: alerts were produced by the check handler (D-2 moves alerting behind the outbox relay), the maintenance lane listed `recompute-uptime` (D-6/§16.5 forbids it in v1 job lists), and `record-pings-bulk` described a bulk ping writer that no longer exists (Tier 2 is the single §16.2 guarded flush UPDATE).
- **Fix:** alerts producer → outbox relay (§16.3) with `send-alert { incidentId, eventType, channels[] }` payload (D-4 keying); `recompute-uptime` and `record-pings-bulk` removed and listed under "Deliberately absent jobs" with rationale.
- **Files modified:** docs/ARCHITECTURE-AUDIT.md
- **Verification:** §14 contains no contradiction with §16.3/§16.5/§16.2; cross-references resolve.
- **Committed in:** 1b1040f

---

**Total deviations:** 3 auto-fixed (2 bug, 1 missing critical)
**Impact on plan:** All fixes serve factual accuracy and cross-section consistency; no scope creep. The plan's verify greps and acceptance criteria all pass unchanged.

## Issues Encountered

- gsd-tools state handlers require flag-style arguments (`state add-decision --summary "…" --phase N`), not positional/JSON; two decisions initially recorded with a doubled `[Phase 01]:` prefix were corrected in STATE.md. No impact on artifacts.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- §14/§15/§23 carry D-02 markers resolving J-1, J-3, J-4, J-5, J-6, S-1 — the §9 items 1/3/4/5/6/18 halves and §10 criterion 3's SSRF half are now traceable in the audit itself.
- Plan 01-03 owns the §13 rewrite (breaker J-5 resilience spec, R-1 hardening): §14 already cross-references "the §13 circuit breaker (J-5)" and "Redis memory alerting at 70% (§13)", and §15 references §13's lock row — 01-03 must make those references true (its own scope per the §8→amendment map).
- §13 still contains its pre-rewrite text (byte-identical, verified by hash) — expected; plan 03 owns it.
- The stale-sentence greps for §13's rows (`falls back to writing routine pings`, `alert:sent:`, `interval + slack`, `repeatable`) still match — expected until plan 01-03 lands.
- The adversarial re-review (01-05) can walk one check end-to-end: claim (§14.3) → enqueue with jobId `check:{monitorId}:{epoch}` (§14.2 step 3) → re-read/lock/fetch/classify/persist (§15.1) → tier SQL (§16) → alerting (§16.3/16.4), with failure modes at every hop.

## Self-Check: PASSED

- All three task verify commands pass from the repo root (battery re-run post-commit: upsertJobScheduler 2, FOR UPDATE SKIP LOCKED 5, check:{monitorId} 4, region repeatable 0, region scheduledAt 0, ssrf_blocked 10, abort 11, TTL/3 2, Amended 2026- 7, TC IDs 7).
- Commits 1b1040f, 53794f6, 36a8ad7 present on main; docs/ARCHITECTURE-AUDIT.md is the only code-tree file touched.
- §13 region byte-identical to pre-plan state (md5 compared against 1b1040f~1).

---
*Phase: 01-design-gate-review-verdict-ready*
*Completed: 2026-09-09*
