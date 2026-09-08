# Phase 1: Design Gate — Review Verdict READY - Context

**Gathered:** 2026-09-09
**Status:** Ready for planning

<domain>
## Phase Boundary

A pure documentation/design phase — no implementation code. Author or amend every one of the 8 review §8 design addenda (schema, scheduler spec, check job spec, writer specs, resilience spec, auth spec, connection budget, deploy runbook), make every review §9 pre-implementation checklist item trace to a design decision, and flip the ARCHITECTURE-REVIEW verdict from NOT READY to READY (dated, reviewer identified) via a fresh adversarial re-review. No code merges before READY (DSGN-01, DSGN-02).

</domain>

<decisions>
## Implementation Decisions

### Addenda format & location
- **D-01:** Hybrid delivery — the 7 design specs (schema, scheduler, check job, writers, resilience, auth, connection budget) amend `docs/ARCHITECTURE-AUDIT.md` **in place**; the deploy runbook is extracted as a standalone **`docs/DEPLOY-RUNBOOK.md`** written for the operator reading it mid-deploy (success criterion 3's audience).
- **D-02:** Amendment marking via **inline citations** — every amended/new audit section carries a marker like `Amended 2026-09-XX (resolves J-1, §9 item 1)`, plus a dated amendment note at the top of the audit. The re-reviewer verifies §9 coverage by scanning the audit itself; no separate matrix document is required (the re-review section in the review doc records the verified traceability).
- **D-03:** Connection budget (D-8): full spec (rationale, pool configs, timeouts, pooled-vs-direct strings, Neon limits) lives in the audit; the runbook carries only the operational summary table (web 10 / worker 20 / migrations 1).
- **D-04:** The runbook covers **both deploy topologies** with a conditional worker step — interim releases (Phases 2–3, single PM2 app): build → backup → migrate → web restart → smoke check; target (Phase 4+): worker restart + `readyz` gate inserted before web restart. Every release this milestone has an exact ordering, not just the final shape.

### Specification depth
- **D-05:** Schema addendum is **DDL-precise**: every new/changed table specified at column-name/type/default/nullability/index level — including the exact partial-index `WHERE status='ONGOING'` predicate, `write_guards`/`outbox` columns, and pinned ID-generation defaults — updating audit §11's Drizzle mapping. Phase 3 transcribes to Drizzle against live `pg_dump` DDL. Drizzle snippets appear only where semantics are subtle; no full Drizzle code authored in Phase 1 (would pre-empt the live-DDL baseline, DRZ-01).
- **D-06:** Writer specs expressed as **literal SQL**: the claim `SELECT ... FOR UPDATE SKIP LOCKED` (advancing `next_check_at`), the transition transaction (conditional UPDATE + incident + ping + outbox), and the guarded flush UPDATE (guard insert + additive counters + `GREATEST`/monotonic clauses). The re-reviewer verifies clause-by-clause; Phase 4 transcribes.
- **D-07:** Behavioral specs (scheduler tick, check job, lock lifecycle, breaker, auth flows) written as **numbered step algorithms, each with a failure-mode table** (failure → detection → response → recovery). Every J/R/A review issue maps to a step + a failure row.
- **D-08:** New §23 test-plan cases (SSRF, duplicate-incident, duplicate-alert) specified as **given/when/then** with concrete inputs and expected DB/queue effects — transcribable directly by Phase 2's characterization suite and Phase 4's failure-injection tests.
- **D-09:** Auth spec includes **full field-mapping tables** (users/account/session/verification → Better Auth shapes, boolean `emailVerified` backfill, admin role column), with cells the design cannot yet guarantee explicitly marked `confirm by Phase 7 dry-run` (e.g. `providerId` casing). Phase 7 research fills only the marked gaps.

### Parameter pinning
- **D-10:** **Every parameter gets a concrete default value + rationale.** Correctness-critical ones (lock TTL formula, tick period, idempotency key format, retention batch size) marked non-negotiable; operational ones (breaker thresholds, DLQ retention, concurrency) marked `default — tune in Phase 4/5 with data`. Implementation never picks a number from thin air.
- **D-11:** Postgres circuit breaker (J-5) takes the **consecutive-failure shape**: e.g. 5 consecutive infra-failures → OPEN (pause enqueueing + queue) 60 s → HALF_OPEN single probe write → CLOSED on success / re-OPEN on failure. The state machine (states, transitions, what OPEN pauses) is pinned as design.
- **D-12:** BullMQ queue topology ships as a **full per-queue table** — names, concurrency, priorities, rate limits, `removeOnComplete`/`removeOnFail`, stalled config — with defaults, each cell flagged `verify against Phase 4 BullMQ 6 research` where v6 semantics could shift it. WRK-12's manual-check priority and the backlog-cap drop policy get concrete lane assignments.
- **D-13:** Per-user manual-check rate limit (SEC-05) pinned at **1 per monitor per 30 s, 6 total per minute** across monitors (user-facing choice).
- **D-14:** DLQ retention (WRK-06) pinned at **7 days** via BullMQ `removeOnFail` age.

### READY verdict mechanics
- **D-15:** The re-review is a **fresh adversarial pass** run by a separate session/agent that did NOT author the addenda — re-checking every §9 item and §10 criterion against the amended docs, hunting for gaps the author would miss.
- **D-16:** Verdict recorded by **amending ARCHITECTURE-REVIEW.md in place**: §1 flips to ✅ READY (dated, re-reviewer identified); the original NOT READY verdict and findings are preserved in a history subsection; a new "Re-review" section is appended with per-criterion results.
- **D-17:** The adversarial re-review verifies the **§9 traceability matrix AND re-runs the failure-scenario walkthroughs** (Redis restart, Postgres down, duplicate job delivery, worker killed mid-job, lock loss, auth cutover) against the amended design — the same mandated-flow method review §3.1 used to find the original blockers.
- **D-18:** Gap handling: **fix loop with max 2 cycles** (findings → author fixes → re-review re-runs), then remaining gaps escalate to the user with a concrete list before any verdict is recorded. The verdict flips only on a clean pass — no READY-with-exceptions.

### Claude's Discretion
- Lock TTL margin and renewal interval specifics (derive with rationale under D-10's non-negotiable formula: TTL = timeout + margin, renewal every TTL/3 per WRK-04)
- Exact default values for operational tunables not pinned above (worker concurrency per queue, backlog-cap multiplier refinement within the ~2× bound, breaker count/duration refinements within the D-11 shape)
- Section numbering/naming for new audit sections; runbook internal layout (checklist vs table presentation)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Authoritative source documents
- `docs/ARCHITECTURE-AUDIT.md` — the patch target for 7 of 8 addenda; §11 Proposed Drizzle Schema Mapping (schema addendum updates it); §22 Deployment Changes; §23 Testing Requirements (test cases added here); Appendix B rules traceability
- `docs/ARCHITECTURE-REVIEW.md` — §8 required-addenda list (the work items); §9 pre-implementation checklist (traceability source); §10 re-review criteria (the READY flip conditions); §1 verdict block (flip target per D-16); §3.1 walkthrough method (re-used per D-17)

### Planning artifacts
- `.planning/REQUIREMENTS.md` — DSGN-01/02 (this phase's requirements); parameter bounds already pinned (attempts 3–5, backlog ~2× active monitors, flush ≤60 s, tick ≤ ½ min interval, budget web 10 / worker 20 / migrations 1)
- `.planning/PROJECT.md` — locked product defaults Q-1..Q-5 and Key Decisions (do not re-litigate)
- `.planning/ROADMAP.md` §Phase 1 — goal and 3 success criteria
- `.planning/research/SUMMARY.md` — verified ecosystem research (BullMQ 6, Drizzle, Better Auth findings) feeding addenda content

</canonical_refs>

<code_context>
## Existing Code Insights

This phase produces documents, not code. The current codebase matters only as the referenced current-state baseline the addenda describe replacing:

### Reusable Assets
- `docs/ARCHITECTURE-AUDIT.md` §1–9 already documents the current code (`src/lib/cron-logic.ts`, `src/lib/db-batcher.ts`, `src/instrumentation.ts`, `src/lib/auth.ts`, `src/proxy.ts`) — addenda build on those descriptions; re-auditing the code from scratch is unnecessary
- Audit §10–24 section structure maps ~1:1 onto addenda topics (§11 schema, §14 BullMQ, §15 worker, §16 batching, §17 email, §22 deploy) — amendments extend existing sections rather than inventing parallel ones

### Established Patterns
- The review doc's issue IDs (J-x, D-x, R-x, A-x, S-x, M-x, P-x) are the shared vocabulary — every amendment cites them (D-02); do not invent a new tracking scheme
- Audit Appendix B already traces 20 architectural rules — new rules/constraints extend this table

### Integration Points
- `docs/DEPLOY-RUNBOOK.md` is a NEW file (D-01); nothing references it yet — audit §22 should point to it
- The review doc's §1 verdict block and §9 checklist are edited in place at flip time (D-16) — keep edits surgical so git history shows the arc

</code_context>

<specifics>
## Specific Ideas

- The runbook's operator-readability is a success criterion in itself: "an operator can read the runbook addendum and know the exact production ordering, the rollback action at each step, and the per-process connection budget — before any code exists" (ROADMAP success criterion 3)
- The auth field map's known-unknown markers (D-09) are the contract for Phase 7's flagged research (`providerId` casing, token-flow cutover) — Phase 7 research should find those markers, not re-derive the whole mapping

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 1-Design Gate — Review Verdict READY*
*Context gathered: 2026-09-09*
