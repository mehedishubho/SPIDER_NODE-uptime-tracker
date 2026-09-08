# Phase 1: Design Gate — Review Verdict READY - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-09
**Phase:** 1-Design Gate — Review Verdict READY
**Areas discussed:** Addenda format & location, Specification depth, Parameter pinning, READY verdict mechanics

---

## Addenda format & location

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: audit + runbook | Amend ARCHITECTURE-AUDIT.md in place for the 7 design specs; extract deploy runbook as standalone docs/DEPLOY-RUNBOOK.md — operator-facing, followable mid-deploy | ✓ |
| Amend audit only | All 8 addenda in-place edits; single source of truth, matches review's literal framing — but operator deploys holding a 70-page architecture doc | |
| docs/design/ addenda | 8 numbered addendum files + pointers from audit; clean per-topic diffs but fragments the audit | |

**User's choice:** Hybrid: audit + runbook
**Notes:** Success criterion 3 targets an operator reader — different audience than the implementer reading architecture specs.

| Option | Description | Selected |
|--------|-------------|----------|
| Inline citations | Each amended/new section carries "Amended <date> (resolves J-x)" markers + dated amendment note at top; §9 coverage verifiable by scanning the audit | ✓ |
| Clean + matrix | Seamless integration; traceability only in a matrix appended to the review doc | |
| Both | Inline citations AND consolidated matrix; max auditability, some duplication | |

**User's choice:** Inline citations

| Option | Description | Selected |
|--------|-------------|----------|
| Audit spec + runbook table | Full connection-budget rationale/config in the audit; operational summary table (10/20/1) duplicated in the runbook | ✓ |
| Audit only | Budget lives only in audit; runbook links to it | |
| Runbook only | Runbook owns the budget entirely; audit references it | |

**User's choice:** Audit spec + runbook table

| Option | Description | Selected |
|--------|-------------|----------|
| Interim + target | One runbook with conditional worker step; interim ordering build → backup → migrate → web restart → smoke; Phase 4+ inserts worker restart + readyz gate | ✓ |
| Target topology only | Runbook specifies only end-state two-app topology; Phases 2–3 inherit today's informal practice | |
| Two runbooks | Separate interim and target runbook documents; explicit but doubles maintenance and risks drift | |

**User's choice:** Interim + target
**Notes:** Phases 2–3 deploy to production before the worker exists — every release this milestone needs an exact ordering.

---

## Specification depth

| Option | Description | Selected |
|--------|-------------|----------|
| DDL-precise spec | Column/type/default/nullability/index level incl. exact partial-index WHERE clause and pinned ID defaults, updating audit §11; Phase 3 transcribes against live DDL | ✓ |
| Complete Drizzle code | Full Drizzle TS definitions authored now; risks drifting from production reality and pre-empts live-DDL baseline (DRZ-01) | |
| Conceptual prose | Tables/purposes/relationships in prose; re-reviewer can't concretely verify D-1/D-3 — the blocking issues | |

**User's choice:** DDL-precise spec

| Option | Description | Selected |
|--------|-------------|----------|
| Literal SQL, all critical | Claim SELECT FOR UPDATE SKIP LOCKED, transition transaction, guarded flush UPDATE written as literal SQL; clause-by-clause verification | ✓ |
| SQL critical + pseudocode rest | Literal SQL only for the three critical statements; relay/dedup as pseudocode + invariants | |
| Pseudocode + invariants | All writer logic as pseudocode; clause-level semantics re-invented during implementation | |

**User's choice:** Literal SQL, all critical

| Option | Description | Selected |
|--------|-------------|----------|
| Algorithms + failure tables | Numbered step algorithms each with failure → detection → response → recovery table; every J/R/A issue maps to a step + failure row | ✓ |
| Scenario walkthroughs | End-to-end failure scenarios traced through the design; validates behavior, leaves step-level gaps | |
| Narrative + invariants | Prose + invariants list; lightest, weakest verification power | |

**User's choice:** Algorithms + failure tables

| Option | Description | Selected |
|--------|-------------|----------|
| Given/when/then specs | Concrete inputs and expected DB/queue effects; Phase 2/4 transcribe directly | ✓ |
| Named bullets | Named cases only; details fleshed out later | |

**User's choice:** Given/when/then specs

| Option | Description | Selected |
|--------|-------------|----------|
| Full map + known-unknowns | Field-by-field mapping tables now, unverifiable cells marked "confirm by Phase 7 dry-run" (e.g. providerId casing) | ✓ |
| Rules + constraints only | Mapping rules in design; field tables left to Phase 7 research | |
| Config-level only | Only A-1/A-2/A-3 literal scope; reshaping entirely Phase 7 | |

**User's choice:** Full map + known-unknowns

---

## Parameter pinning

| Option | Description | Selected |
|--------|-------------|----------|
| Pin all + mark tunables | Every parameter gets default + rationale; correctness-critical non-negotiable, operational "tune in Phase 4/5" | ✓ |
| Ranges + tuning procedure | Ranges in design; values chosen during Phase 4/5 research | |
| Pin critical only | Only lock TTL, tick, idempotency key, retention batch; rest to Phase 4 | |

**User's choice:** Pin all + mark tunables

| Option | Description | Selected |
|--------|-------------|----------|
| Consecutive-failure breaker | e.g. 5 consecutive infra-failures → OPEN 60s → HALF_OPEN single probe; simple to reason/verify/alert | ✓ |
| Error-rate breaker | >50% of last N attempts within window; classical but needs window bookkeeping | |
| Defer to Phase 4 research | Pin state machine only; thresholds set by Phase 4 research | |

**User's choice:** Consecutive-failure breaker

| Option | Description | Selected |
|--------|-------------|----------|
| Full table + verify flags | Per-queue names/concurrency/priorities/limits/retention/stalled with defaults, flagged "verify against Phase 4 BullMQ 6 research" | ✓ |
| Shape only, numbers later | Queue set + dependencies + priority structure fixed; numbers wait for Phase 4 | |
| Invariants only | Topology left to Phase 4; design states only droppability invariants | |

**User's choice:** Full table + verify flags

| Option | Description | Selected |
|--------|-------------|----------|
| 1/monitor/30s, 6/min | Prevents hammering a just-checked target; "Check now" stays responsive | ✓ |
| 3/monitor/min, 10/min | Friendlier for debugging flapping monitors; more load | |
| 1/monitor/60s, 4/min | Most protective; nearly redundant with scheduler | |

**User's choice:** 1/monitor/30s, 6/min
**Notes:** User-facing limit — the one users will feel.

| Option | Description | Selected |
|--------|-------------|----------|
| 7 days | Weekend incident investigable Monday; bounded growth | ✓ |
| 24 hours | Smallest footprint; Friday-night incidents gone by Monday | |
| 30 days | Max forensic window; heaviest Redis commitment | |

**User's choice:** 7 days

---

## READY verdict mechanics

| Option | Description | Selected |
|--------|-------------|----------|
| Fresh adversarial pass | Separate session/agent that did NOT author the addenda re-checks §9/§10; symmetric rigor with original NOT READY review | ✓ |
| Self-certification | Authoring session records matrix and flips verdict; author grading own work | |
| You as human reviewer | Claude prepares evidence packet; user verifies and is recorded as reviewer | |

**User's choice:** Fresh adversarial pass

| Option | Description | Selected |
|--------|-------------|----------|
| Amend in place + history | §1 flips to ✅ READY (dated, reviewer identified); original verdict preserved in history subsection; appended Re-review section | ✓ |
| Separate re-review doc | Review doc frozen; new ARCHITECTURE-RE-REVIEW.md holds the flip | |
| Verdict flip only | Minimal §1 edit; no appended evidence section | |

**User's choice:** Amend in place + history

| Option | Description | Selected |
|--------|-------------|----------|
| Matrix + walkthroughs | §9 traceability AND failure-scenario walkthroughs re-run (Redis restart, PG down, dup delivery, kill mid-job, lock loss, auth cutover) | ✓ |
| Matrix only | Each §9 item traces; no scenario re-run | |
| Full second review | Re-validate everything §3–§7; mostly re-confirms validated sections | |

**User's choice:** Matrix + walkthroughs

| Option | Description | Selected |
|--------|-------------|----------|
| Fix loop, then escalate | Max 2 fix cycles; remaining gaps escalated with concrete list; verdict flips only on clean pass | ✓ |
| One cycle, READY-with-exceptions | Single fix cycle; unresolved recorded as gaps alongside verdict | |
| Loop until clean | No cycle cap, no escalation; unbounded duration | |

**User's choice:** Fix loop, then escalate

---

## Claude's Discretion

- Lock TTL margin and renewal interval specifics (derived with rationale under the non-negotiable formula TTL = timeout + margin, renewal every TTL/3)
- Exact defaults for operational tunables not explicitly pinned (per-queue concurrency, backlog multiplier refinement within ~2×, breaker count/duration refinements within the chosen shape)
- Audit section numbering/naming for new sections; runbook internal layout

## Deferred Ideas

None — discussion stayed within phase scope.
