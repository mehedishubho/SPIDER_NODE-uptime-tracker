# Phase 1: Design Gate — Review Verdict READY - Research

**Researched:** 2026-09-09
**Domain:** Design-documentation amendment (SQL/BullMQ/Better Auth/PM2/Neon spec authoring) + adversarial re-review mechanics
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Addenda format & location**
- **D-01:** Hybrid delivery — the 7 design specs (schema, scheduler, check job, writers, resilience, auth, connection budget) amend `docs/ARCHITECTURE-AUDIT.md` **in place**; the deploy runbook is extracted as a standalone **`docs/DEPLOY-RUNBOOK.md`** written for the operator reading it mid-deploy (success criterion 3's audience).
- **D-02:** Amendment marking via **inline citations** — every amended/new audit section carries a marker like `Amended 2026-09-XX (resolves J-1, §9 item 1)`, plus a dated amendment note at the top of the audit. The re-reviewer verifies §9 coverage by scanning the audit itself; no separate matrix document is required (the re-review section in the review doc records the verified traceability).
- **D-03:** Connection budget (D-8): full spec (rationale, pool configs, timeouts, pooled-vs-direct strings, Neon limits) lives in the audit; the runbook carries only the operational summary table (web 10 / worker 20 / migrations 1).
- **D-04:** The runbook covers **both deploy topologies** with a conditional worker step — interim releases (Phases 2–3, single PM2 app): build → backup → migrate → web restart → smoke check; target (Phase 4+): worker restart + `readyz` gate inserted before web restart. Every release this milestone has an exact ordering, not just the final shape.

**Specification depth**
- **D-05:** Schema addendum is **DDL-precise**: every new/changed table specified at column-name/type/default/nullability/index level — including the exact partial-index `WHERE status='ONGOING'` predicate, `write_guards`/`outbox` columns, and pinned ID-generation defaults — updating audit §11's Drizzle mapping. Phase 3 transcribes to Drizzle against live `pg_dump` DDL. Drizzle snippets appear only where semantics are subtle; no full Drizzle code authored in Phase 1 (would pre-empt the live-DDL baseline, DRZ-01).
- **D-06:** Writer specs expressed as **literal SQL**: the claim `SELECT ... FOR UPDATE SKIP LOCKED` (advancing `next_check_at`), the transition transaction (conditional UPDATE + incident + ping + outbox), and the guarded flush UPDATE (guard insert + additive counters + `GREATEST`/monotonic clauses). The re-reviewer verifies clause-by-clause; Phase 4 transcribes.
- **D-07:** Behavioral specs (scheduler tick, check job, lock lifecycle, breaker, auth flows) written as **numbered step algorithms, each with a failure-mode table** (failure → detection → response → recovery). Every J/R/A review issue maps to a step + a failure row.
- **D-08:** New §23 test-plan cases (SSRF, duplicate-incident, duplicate-alert) specified as **given/when/then** with concrete inputs and expected DB/queue effects — transcribable directly by Phase 2's characterization suite and Phase 4's failure-injection tests.
- **D-09:** Auth spec includes **full field-mapping tables** (users/account/session/verification → Better Auth shapes, boolean `emailVerified` backfill, admin role column), with cells the design cannot yet guarantee explicitly marked `confirm by Phase 7 dry-run` (e.g. `providerId` casing). Phase 7 research fills only the marked gaps.

**Parameter pinning**
- **D-10:** **Every parameter gets a concrete default value + rationale.** Correctness-critical ones (lock TTL formula, tick period, idempotency key format, retention batch size) marked non-negotiable; operational ones (breaker thresholds, DLQ retention, concurrency) marked `default — tune in Phase 4/5 with data`. Implementation never picks a number from thin air.
- **D-11:** Postgres circuit breaker (J-5) takes the **consecutive-failure shape**: e.g. 5 consecutive infra-failures → OPEN (pause enqueueing + queue) 60 s → HALF_OPEN single probe write → CLOSED on success / re-OPEN on failure. The state machine (states, transitions, what OPEN pauses) is pinned as design.
- **D-12:** BullMQ queue topology ships as a **full per-queue table** — names, concurrency, priorities, rate limits, `removeOnComplete`/`removeOnFail`, stalled config — with defaults, each cell flagged `verify against Phase 4 BullMQ 6 research` where v6 semantics could shift it. WRK-12's manual-check priority and the backlog-cap drop policy get concrete lane assignments.
- **D-13:** Per-user manual-check rate limit (SEC-05) pinned at **1 per monitor per 30 s, 6 total per minute** across monitors (user-facing choice).
- **D-14:** DLQ retention (WRK-06) pinned at **7 days** via BullMQ `removeOnFail` age.

**READY verdict mechanics**
- **D-15:** The re-review is a **fresh adversarial pass** run by a separate session/agent that did NOT author the addenda — re-checking every §9 item and §10 criterion against the amended docs, hunting for gaps the author would miss.
- **D-16:** Verdict recorded by **amending ARCHITECTURE-REVIEW.md in place**: §1 flips to ✅ READY (dated, re-reviewer identified); the original NOT READY verdict and findings are preserved in a history subsection; a new "Re-review" section is appended with per-criterion results.
- **D-17:** The adversarial re-review verifies the **§9 traceability matrix AND re-runs the failure-scenario walkthroughs** (Redis restart, Postgres down, duplicate job delivery, worker killed mid-job, lock loss, auth cutover) against the amended design — the same mandated-flow method review §3.1 used to find the original blockers.
- **D-18:** Gap handling: **fix loop with max 2 cycles** (findings → author fixes → re-review re-runs), then remaining gaps escalate to the user with a concrete list before any verdict is recorded. The verdict flips only on a clean pass — no READY-with-exceptions.

### Claude's Discretion
- Lock TTL margin and renewal interval specifics (derive with rationale under D-10's non-negotiable formula: TTL = timeout + margin, renewal every TTL/3 per WRK-04)
- Exact default values for operational tunables not pinned above (worker concurrency per queue, backlog-cap multiplier refinement within the ~2× bound, breaker count/duration refinements within the D-11 shape)
- Section numbering/naming for new audit sections; runbook internal layout (checklist vs table presentation)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

## Summary

Phase 1 is a pure documentation phase: amend `docs/ARCHITECTURE-AUDIT.md` in place with 7 design addenda, extract `docs/DEPLOY-RUNBOOK.md` as a new standalone operator document, make every review §9 checklist item trace to an amendment, and flip `docs/ARCHITECTURE-REVIEW.md` §1 from ❌ NOT READY to ✅ READY via a fresh adversarial re-review run by a session that did not author the addenda (D-15). No application code is written; the only files touched are two existing docs plus one new one.

The research problem for this phase is not stack selection (locked by `.planning/research/STACK.md`, registry-verified 2026-09-08) but **specification correctness at the level the re-reviewer will verify**: CONTEXT.md decisions D-05/D-06 demand DDL-precise schema and literal SQL that Phase 3/4 transcribe mechanically. The prior project research explicitly marked `FOR UPDATE SKIP LOCKED` claim semantics and outbox details as LOW-confidence; this session closed those gaps against primary sources (PostgreSQL official docs, BullMQ and Better Auth source code on GitHub, Telegram Bot API reference, node-postgres docs) and surfaced **four spec-level subtleties the addenda must encode**: (1) the J-1 claim SQL's `FOR UPDATE SKIP LOCKED` must stay *inside* the CTE — Postgres documents that outer-level locking clauses do not reach into WITH queries — and the given shape is correct [VERIFIED: postgresql.org/docs/sql-select]; (2) PostgreSQL's `GREATEST` *ignores* NULL arguments (a documented deviation from the SQL standard), so the D-5 monotonic flush needs no `COALESCE`, while the `CASE WHEN $ts > last_checked` comparison guard *does* yield NULL on a never-checked row — an asymmetry the writer spec must pin [VERIFIED: postgresql.org/docs/functions-conditional]; (3) BullMQ's default priority `0` means *no explicit priority* and **non-prioritized jobs are processed before prioritized jobs** — so D-12's per-queue table must assign an explicit priority to every lane or routine checks will outrank manual/transition checks, inverting J-6 [VERIFIED: BullMQ source, src/interfaces/base-job-options.ts]; (4) `removeOnFail: { age }` eviction is best-effort (no background timer — aged jobs are removed only when another job fails afterwards), so D-14's 7-day DLQ retention is approximate, not a hard SLA [VERIFIED: BullMQ source].

A second research finding shapes the whole plan: the audit currently contains **sentences the review explicitly rejects** (§13's "worker falls back to writing routine pings straight to Postgres" — called *incoherent* by R-1; §13's alert dedup key `alert:sent:{monitorId}:{state}` — superseded by D-4 incident-keyed dedup; §14's legacy "repeatable job" wording — removed in BullMQ 6; §14's idempotency key `{monitorId}:{scheduledAt}` — superseded by the claim-epoch key; §13's lock TTL "interval + slack" — superseded by timeout+margin+renewal). Amendments must **replace** these, not append beside them; every stale sentence surviving into READY is a trap a Phase 4 implementer will follow. The §9 traceability check and the adversarial re-review should specifically hunt for residual contradictions.

**Primary recommendation:** Structure the plan as: (a) audit §11 schema amendment (DDL-precise), (b) scheduler + queue-topology amendments (§14/§15, with the D-12 per-queue table giving every lane an explicit priority), (c) check-job + writer-spec amendments (literal SQL with the verified NULL/priority/index-inference semantics), (d) resilience + Redis-architecture rewrite (§13 + new section), (e) auth-spec amendment (§12, D-09 field-map tables against the verified Better Auth core schema), (f) connection-budget section, (g) `DEPLOY-RUNBOOK.md` (both topologies per D-04), (h) §23 test cases as given/when/then, then (i) §9 self-traceability, (j) fresh-agent adversarial re-review with the D-18 fix loop, (k) verdict flip per D-16.

## Project Constraints (from CLAUDE.md)

| # | Directive | Impact on this phase |
|---|-----------|----------------------|
| 1 | GSD workflow enforcement — no direct repo edits outside a GSD entry point | This phase IS a GSD workflow; docs edits happen under the phase plan |
| 2 | `docs/ARCHITECTURE-AUDIT.md` and `docs/ARCHITECTURE-REVIEW.md` are the authoritative source documents | Amendments must keep them authoritative; do not create parallel design docs |
| 3 | Review gate: all §9 checklist items resolved in design before implementation (verdict READY) | Restates DSGN-02 — the phase's entire purpose |
| 4 | Behavior compatibility: 1-strike DOWN, lifetime uptime math, Telegram alert content, public API shapes preserved | Addenda may not change monitoring semantics — only mechanisms |
| 5 | Deployment: single VPS, two PM2 apps, forward-only additive-first migrations, `readyz` health gates | Constrains the runbook (D-04) and schema addendum (additive-only) |
| 6 | Forced re-login at auth cutover accepted (M2/D6), announced (Q-4) | Auth spec records this as decided, not open |
| 7 | New comments in English (Bangla comments exist in code) | Addenda prose is English |
| 8 | Monitoring must never lose/corrupt data, silently stop checking, or lock users out irrecoverably | Every failure-mode table (D-07) tests against this core value |

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DSGN-01 | All 8 design addenda from review §8 incorporated into the design documents (amended audit or authored addendum): schema, scheduler spec, check job spec, writer specs, resilience spec, auth spec, connection budget, deploy runbook | §8→amendment-location map (below); verified SQL/BullMQ/Better-Auth semantics to make D-05/D-06 specifications correct; audit-sections-requiring-replacement inventory (stale sentences the review rejects); D-10 parameter-pinning table format |
| DSGN-02 | Review §9 pre-implementation checklist fully resolved in design; verdict re-reviewed from NOT READY to READY before implementation code | Full §9→addendum-home mapping (below); D-15/D-16/D-17/D-18 re-review mechanics; structural grep checks for traceability validation |
</phase_requirements>

## Architectural Responsibility Map

Capability→tier ownership of the **designed system** (what the addenda specify, not what this phase builds). The planner uses this to keep each addendum's statements in the right tier.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Due-monitor selection & claims (`next_check_at`) | Database | Worker (scheduler tick) | Correctness lives in the SQL transaction; the worker merely invokes it (J-1) |
| Check execution (fetch, classify, SSRF pipeline) | Worker | — | Monitoring execution never in web (rules 4–6); SSRF enforcement at the engine, plus OS egress on worker host (S-1) |
| Transition persistence (monitor+ping+incident+outbox txn) | Database | Worker (persist processor) | One synchronous Postgres transaction is the durability unit (DAT-01/D-2) |
| Routine-UP aggregation (≤60 s buffer) | Redis (infrastructure) | Worker (flusher) | Loss-tolerable by design; applied via guarded monotonic UPDATE (D-5) |
| Alert delivery & dedup | Worker (alerts queue) | Redis (best-effort dedup keys) | Outbox is the durable event source; Redis dedup only collapses at-least-once duplicates (D-2/D-4) |
| Auth (sessions, password verify, roles) | Web (API routes + proxy) | Database (users/session/account) | cookieCache makes proxy validation cookie-side; DB fallback (A-2) |
| Rate limiting (incl. manual-check per-user) | Redis | Web (route guard) | Atomic INCR+EXPIRE replaces in-memory Map (RDS-02/SEC-05) |
| Connection budget enforcement | Infra (pool config per process) | Database (Neon limits) | web 10 pooled / worker 20 direct / migrations 1 direct (D-8) |
| Deploy ordering, health gates, rollback | Infra (PM2 + pipeline) | Worker (`readyz` gates release) | Migrations never at process boot; single runner (M-1/P-1) |
| Resilience (breaker, backlog cap, DLQ) | Worker (orchestration) | Redis (queue pause) | `Queue.pause()` is global; OPEN pauses enqueueing + queue (D-11/J-5) |

## Standard Stack

### Core — documentation targets only, NOTHING is installed in Phase 1

| Library | Version | Purpose in the addenda | Why this version |
|---------|---------|------------------------|------------------|
| bullmq | 6.3.4 | Queue-topology table (D-12) must use v6 semantics: `upsertJobScheduler`, `UnrecoverableError`, explicit per-lane priorities | Legacy repeatables removed in v6; defaults verified from source this session [VERIFIED: BullMQ source + .planning/research/STACK.md] |
| better-auth | 1.7.3 | Auth-spec field-map tables (D-09) target the verified core schema | Core schema field lists extracted from source this session [VERIFIED: better-auth get-tables.ts] |
| drizzle-orm / drizzle-kit | 0.45.2 / 0.31.10 | Schema addendum (D-05) updates §11's Drizzle *sketch* only; Phase 3 transcribes against live DDL | Pinned by better-auth peer `^0.45.2` [VERIFIED: npm registry, STACK.md] |
| pg (node-postgres) | 8.23.0 | Connection-budget spec (D-8) pool options: `max`, timeouts | Pool defaults verified from official docs [VERIFIED: node-postgres.com/apis/pool] |
| ioredis | 6.0.0 | Resilience spec client config (two connections, `maxRetriesPerRequest: null`, no `keyPrefix`) | [VERIFIED: BullMQ docs + STACK.md] |
| PostgreSQL (Neon) | 17-compatible | Literal SQL must match verified PG semantics (SKIP LOCKED, GREATEST/NULL, ON CONFLICT partial inference) | Verified against current official docs [VERIFIED: postgresql.org] |
| PM2 | current | Runbook: `kill_timeout`, `wait_ready`, `listen_timeout`, `max_restarts`, `min_uptime` | [VERIFIED: pm2.keymetrics.io, fetched 2026-09-08 in project research] |

**Installation:**
```bash
# NOTHING — Phase 1 installs no packages. Versions above are spec targets only.
```

**Version verification:** performed 2026-09-08 in `.planning/research/STACK.md` via live `npm view` against the npm registry (all HIGH confidence there); semantics re-verified this session against package source code for bullmq and better-auth.

## Package Legitimacy Audit

> Phase 1 installs **zero** external packages — this section records that fact.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (none) | — | — | — | — | — | No installs this phase |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

*All versions cited in addenda content were previously verified in project research (`.planning/research/STACK.md`, npm registry, 2026-09-08).*

## Architecture Patterns

### System Architecture Diagram

The "system" this phase builds is a **document pipeline with a review gate**:

```
Inputs                          Authoring (this phase)                Gate
──────                          ─────────────────────                ────
docs/ARCHITECTURE-AUDIT.md ──┐
docs/ARCHITECTURE-REVIEW.md ─┼─► 7 in-place audit amendments (D-01)
.planning/REQUIREMENTS.md  ──┤    §11 schema (D-05 DDL-precise)
.planning/PROJECT.md Q-1..5 ─┤    §14/§15 scheduler+queues (D-12 table)
.planning/research/*.md ─────┘    §15/§16 check job + writer SQL (D-06/D-07)
                                  §13 rewrite + resilience spec (D-11)
                                  §12 auth field maps (D-09)
                                  connection budget (D-03)
                             ──► docs/DEPLOY-RUNBOOK.md (NEW, D-01/D-04)
                             ──► §23 test cases given/when/then (D-08)
                                        │
                                        ▼
                          Self-check: every §9 item ID appears in an
                          amendment marker; no stale rejected sentences
                                        │
                                        ▼
                     Fresh adversarial re-review (D-15: separate agent,
                     did NOT author) — §9 traceability + §10 criteria +
                     failure walkthroughs (D-17: Redis restart, PG down,
                     duplicate delivery, worker killed mid-job, lock
                     loss, auth cutover)
                                        │
                          ┌─── clean pass ───┐  gaps found
                          ▼                  ▼
                  Flip §1 → ✅ READY    Fix loop (max 2 cycles, D-18)
                  (D-16: dated, reviewer  │ still failing after 2
                   identified; NOT READY   ▼
                   preserved in history)  Escalate concrete gap list
                                         to user — verdict stays NOT READY
```

### Recommended Project Structure

Files touched (complete list — nothing else changes):

```
docs/
├── ARCHITECTURE-AUDIT.md     # amended IN PLACE (7 addenda, D-02 markers, top-of-file amendment note)
├── ARCHITECTURE-REVIEW.md    # amended at flip time only (D-16: §1 verdict, history subsection, Re-review section)
└── DEPLOY-RUNBOOK.md         # NEW (D-01) — operator-facing, both topologies (D-04)
```

### §8 → amendment-location map (drives task structure)

| Review §8 addendum | Audit section(s) to amend | Review issues resolved |
|--------------------|---------------------------|------------------------|
| 1. Schema | §11 (rewrite the sketch DDL-precisely); §10 corrections where prisma inventory is the baseline | J-1 (next_check_at), J-2 (write_guards), D-1 (partial unique ONGOING index), D-2 (outbox), D-3 (ID defaults), N-5 (error_class) |
| 2. Scheduler spec | §14 scheduler queue row + new scheduler algorithm (D-07 numbered steps) | J-1, J-5 (backlog gate), J-6 (lane assignment) |
| 3. Check job spec | §15 worker section + new check algorithm | J-3 (lock lifecycle), J-4 (classification), S-1 (SSRF pipeline) |
| 4. Writer specs | §16 rewrite (two-tier + literal SQL) | J-2, D-1, D-2, D-4, D-5 |
| 5. Resilience spec | §13 REWRITE (fallback sentence must go) + new resilience section | J-5 (breaker D-11), J-6, R-1 (hardening/recovery), D-7 (batched deletes) |
| 6. Auth spec | §12 expansion (field-map tables D-09) | A-1, A-2, A-3, S-3 (roles), S-2 decision note |
| 7. Connection budget | New section (or extends §11/§13 ops notes) | D-8 |
| 8. Deploy runbook | NEW `docs/DEPLOY-RUNBOOK.md` + pointer from audit §22 | P-1, M-1, M-2, M-3, S-4 decision note |
| (§23 test cases — §10 criterion 3) | §23 extension | S-1, D-1, D-4, J-2, J-4 cases |

### §9 → addendum-home mapping (the traceability contract)

Every checklist item must land in at least one amendment marker. Complete map:

| §9 item | Home(s) |
|---------|---------|
| J-1 claims + idem keys | Schema (§11) + Scheduler spec |
| J-2 guards + flush SQL | Writer specs |
| J-3 lock spec | Check job spec |
| J-4 classification + tests | Check job spec + §23 cases |
| J-5 breaker + backlog + DLQ | Resilience spec |
| J-6 priority policy | Queue-topology table (D-12) in Scheduler/§14 amendment |
| D-1 conditional UPDATE + index + tests | Schema + Writer specs + §23 cases |
| D-2 outbox + relay | Schema + Writer specs |
| D-3 ID generation | Schema |
| D-4 incident-keyed dedup | Writer/alert specs |
| D-6 uptime semantics (Q-1) | Schema/§16 note recording the locked decision: lifetime counters displayed; windowed backend flagged (DAT-11, Phase 8) |
| D-7 batched deletes | Resilience/maintenance spec |
| D-8 connection budget | Connection-budget section |
| R-1 hardening + heartbeat + staleness | Resilience spec (§13 rewrite) |
| A-1 bcrypt + canary | Auth spec |
| A-2 cookieCache | Auth spec |
| A-3 adapter mapping + roles | Auth spec |
| S-1 SSRF layers + tests | Check job spec + §23 cases |
| S-2 webhook secret_token | Auth-spec security note (decision) — implementation Phase 6 |
| S-3 admin gating + per-user limiter | Auth spec (roles) + queue/rate-limit note (D-13) — implementation Phases 6/7 |
| S-4 repo hygiene | Runbook/§22 decision note — implementation Phase 2 (FND-07) |
| M-1/M-2/M-3 migration discipline | Runbook + Schema (baseline process: live DDL, empty-diff gate) |
| P-1 runbook | DEPLOY-RUNBOOK.md |

Note the pattern: **S-2/S-3/S-4 and parts of M-* are design-decision records whose implementation lives in later phases** — §9 asks that each item "trace to a design decision", not that it be implemented. The amendment markers make that traceability greppable (D-02).

### Pattern 1: Inline amendment marker (D-02)

**What:** Every amended/new audit section carries a marker plus a dated note at the top of the audit.
**When to use:** Every single amendment, without exception — the re-reviewer's §9 scan depends on greppability.

```markdown
<!-- audit top-of-file -->
> **Amendment note:** This document was amended on 2026-09-XX to incorporate the
> required design addenda from ARCHITECTURE-REVIEW.md §8 (re-review verdict: see
> ARCHITECTURE-REVIEW.md §1). Amendment markers appear inline as
> "Amended 2026-09-XX (resolves <issue-ids>)".

<!-- section level -->
### 11.x Scheduler claim column
*Amended 2026-09-XX (resolves J-1, §9 item 1)*
...
```

### Pattern 2: Numbered algorithm + failure-mode table (D-07)

**What:** Behavioral specs as numbered steps; each step backed by a failure table.
**When to use:** scheduler tick, check job, lock lifecycle, breaker, auth flows.

```markdown
#### Scheduler tick algorithm
1. Acquire tick idempotency (Job Scheduler guarantees single delayed job per id)
2. Run claim transaction (literal SQL, below) → claimed ids
3. For each claimed id: enqueue check job (idem key `check:{monitorId}:{next_check_at epoch}`)
4. Heartbeat healthchecks.io; on exception ping `/fail`
5. ...

| Failure | Detection | Response | Recovery |
|---------|-----------|----------|----------|
| Redis down mid-batch (step 3) | enqueue throws | leave claims advanced (one missed check) | next tick re-claims via next_check_at |
| ...     | ...       | ...      | ...      |
```

### Pattern 3: Parameter-pinning table (D-10)

**What:** Every parameter gets default + rationale + mutability class.

```markdown
| Parameter | Default | Rationale | Class |
|-----------|---------|-----------|-------|
| Tick period | 30 s | ≤ ½ minimum interval (1 min) per J-1 | non-negotiable |
| Lock TTL | 10 s timeout + 5 s margin | covers fetch worst case + persist start | non-negotiable formula |
| Lock renewal | TTL/3 | WRK-04 | non-negotiable |
| Check concurrency | 10 | worker pool sizing baseline | default — tune in Phase 4/5 |
| Breaker threshold | 5 consecutive infra-failures / 60 s OPEN | D-11 shape | default — tune in Phase 4/5 |
```

### Pattern 4: Given/when/then test cases (D-08)

**What:** §23 additions with concrete inputs and expected DB/queue effects.

```markdown
**TC-SSRF-redirect-private**
- Given: monitor url `https://good.example/redirect` returning 302 → `http://169.254.169.254/latest/meta-data`
- When: check job executes
- Then: job completes (success) carrying result DOWN/error_class `ssrf_blocked`;
        no HTTP request reaches 169.254.169.254; no ping row status UP;
        pings.error_class = 'ssrf_blocked'
```

### Pattern 5: Known-unknown marker (D-09)

**What:** Auth field-map cells that cannot be guaranteed yet are explicitly marked.
**When to use:** `providerId` casing per provider, token-flow cutover details.

```markdown
| NextAuth `accounts.provider` | Better Auth `account.providerId` | `google` | confirm by Phase 7 dry-run |
```

### Anti-Patterns to Avoid

- **Appending instead of replacing:** §13's fallback sentence, §13's dedup key shape, §14's repeatable-job wording/idempotency key/lock TTL are *rejected by the review*. Leaving them beside the new text creates two true-looking contradictions. Replace, then grep for the stale strings.
- **Authoring full Drizzle code:** D-05 forbids it — it would pre-empt the Phase 3 live-DDL baseline (DRZ-01). Drizzle snippets only where semantics are subtle.
- **Inventing new tracking vocabulary:** the J/D/R/A/S/M/P/N IDs are the shared language (D-02, CONTEXT.md "Established Patterns"). No new scheme, no renaming.
- **A separate traceability matrix doc:** explicitly rejected by D-02 — traceability lives in amendment markers + the re-review section.
- **Un-numbered prose specs:** "the worker should handle lock loss carefully" is unverifiable. Numbered steps + failure rows (D-07) are the re-review unit.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| §9 coverage proof | A bespoke matrix document | Inline amendment markers + grep (D-02) | Decision D-02; markers are the greppable evidence the re-reviewer scans |
| SQL semantics | Intuition about GREATEST/NULL, SKIP LOCKED placement, ON CONFLICT inference | The verified semantics in "Code Examples" below | PG deviates from the SQL standard on GREATEST/NULL; outer locking clauses don't reach WITH queries; partial-index inference needs the index_predicate |
| Queue priority scheme | Priority only on manual/transition lanes | Explicit priority on EVERY lane (D-12 table) | BullMQ default priority 0 = *no* priority, and non-prioritized jobs run BEFORE prioritized ones [VERIFIED: BullMQ source] |
| Re-review | Self-review by the authoring session | Fresh adversarial pass by a separate agent (D-15) | Author-blind review is the entire value; D-15 is a locked decision |
| Field-map authoring | Guessing Better Auth column shapes | The verified core schema table below (D-09) | Field lists extracted from `get-tables.ts` this session; remaining unknowns get the Phase-7 marker |

**Key insight:** In a design-gate phase the "library" is the verified semantics of the systems being specified. A spec that is 95% correct but wrong about `GREATEST`/NULL or priority ordering will pass a casual read, fail in Phase 4 production, and cost exactly the kind of under-pressure invention this phase exists to prevent.

## Common Pitfalls

### Pitfall 1: Residual contradictions in the audit
**What goes wrong:** An amendment adds the correct spec but the rejected sentence stays a paragraph above it.
**Why it happens:** Append-only editing feels safer; the stale sentences are plausible-sounding.
**How to avoid:** The audit sections requiring replacement are enumerable now (see list in Summary). After authoring, grep the audit for the stale strings: `falls back to writing routine pings`, `alert:sent:`, `{monitorId}:{scheduledAt}`, `interval + slack`, `repeatable job` (in the BullMQ-4/5 sense).
**Warning signs:** Re-reviewer finds two contradictory statements for the same mechanism.

### Pitfall 2: Priority inversion in the D-12 lane table
**What goes wrong:** Routine checks get no priority (default 0) → they are processed *before* prioritized manual/transition checks, the exact opposite of J-6.
**Why it happens:** "Lower number = higher priority" is widely known; "absence of priority outranks all explicit priorities" is not.
**How to avoid:** Every lane in the per-queue table gets an explicit `priority` cell (e.g. manual/transition 1, maintenance 5, routine 10).
**Warning signs:** Any queue row with an empty priority cell. [VERIFIED: BullMQ source, base-job-options.ts]

### Pitfall 3: GREATEST/CASE NULL asymmetry in the flush SQL
**What goes wrong:** The spec "fixes" `GREATEST(last_checked, $ts)` with a COALESCE that changes nothing, or misses that the `CASE WHEN $ts > last_checked` response_time guard goes to the ELSE branch on a NULL last_checked.
**Why it happens:** PostgreSQL ignores NULLs in GREATEST (documented deviation from the SQL standard) while NULL comparisons behave standardly.
**How to avoid:** Pin both behaviors in the writer spec with the doc citation; state the reachable edge (flush against a never-checked monitor) and why it cannot occur (first check is always Tier 1) plus the defensive outcome if it did.
**Warning signs:** Re-reviewer walks the "monitor created, first check routine" path and finds undefined behavior. [VERIFIED: postgresql.org/docs/functions-conditional]

### Pitfall 4: Locking clause drifting outside the CTE during refactoring
**What goes wrong:** A "cleanup" of the J-1 claim SQL moves FOR UPDATE to the outer statement — where it locks nothing from the CTE — silently breaking claim exclusivity.
**Why it happens:** Outer-level locking looks more natural; Postgres only documents the WITH-query exception in a note.
**How to avoid:** The literal SQL pins the shape; add a one-line comment citing the doc rule ("locking clauses do not apply to WITH queries; specify within the WITH query").
**Warning signs:** Re-reviewer asks "what stops two ticks claiming the same row?" [VERIFIED: postgresql.org/docs/sql-select]

### Pitfall 5: Treating removeOnFail age as a hard retention SLA
**What goes wrong:** The runbook/resilience spec promises "failed jobs retained exactly 7 days".
**Why it happens:** KeepJobs `{age}` reads like a timer.
**How to avoid:** Word D-14 as "≥ ~7 days, best-effort cleanup on subsequent activity" per the source comment.
**Warning signs:** Operational dashboards assuming deterministic eviction. [VERIFIED: BullMQ source]

### Pitfall 6: Re-review contamination
**What goes wrong:** The authoring session re-reviews its own addenda; the verdict flips without the adversarial pass D-15 mandates.
**Why it happens:** It's one command away and the author "knows the docs best".
**How to avoid:** Plan the re-review as a separate task executed by a different agent invocation, with the walkthrough list (D-17) as its script; the verdict flip is a *following* task that consumes the re-review output.
**Warning signs:** Re-review notes that only restate amendment markers, no walkthrough transcripts.

### Pitfall 7: Over-specification into Phase 3's territory
**What goes wrong:** The schema addendum authors full Drizzle table code or declares existing column types as fact (timestamp vs timestamptz).
**Why it happens:** DDL-precision feels like it demands complete code.
**How to avoid:** D-05's line: new/changed objects get full DDL precision; existing-column types carry a "verify against live pg_dump (M-6/DRZ-01)" marker; Drizzle snippets only where semantics are subtle.
**Warning signs:** Any `pgTable(` block beyond a fragment in the audit.

### Pitfall 8: Losing the runbook's audience
**What goes wrong:** DEPLOY-RUNBOOK.md reads like a design rationale essay, not a mid-deploy checklist.
**Why it happens:** Authoring context is the audit, where rationale belongs.
**How to avoid:** D-01/D-03 split: rationale in the audit; the runbook is ordering + per-step rollback + connection budget summary table, per D-04's two topologies. Success criterion 3's test: an operator mid-incident can follow it.
**Warning signs:** Runbook paragraphs without an imperative step.

## Code Examples

Verified facts the addenda transcribe. All sources fetched this session unless noted.

### Claim transaction (J-1) — shape verified against PostgreSQL docs
```sql
-- Source: postgresql.org/docs/current/sql-select.html (locking clause semantics)
WITH due AS (
  SELECT id FROM monitors
   WHERE is_active AND (next_check_at IS NULL OR next_check_at <= now())
   ORDER BY next_check_at NULLS FIRST
   LIMIT 500
   FOR UPDATE SKIP LOCKED          -- MUST stay inside the WITH query: outer-level
)                                  -- locking clauses do not reach INTO WITH queries
UPDATE monitors m
   SET next_check_at = now() + (m.interval * interval '1 minute')
 FROM due WHERE m.id = due.id
RETURNING m.id;
```
Verified properties [VERIFIED: postgresql.org/docs/sql-select]:
- "With `SKIP LOCKED`, any selected rows that cannot be immediately locked are skipped… can be used to avoid lock contention with multiple consumers accessing a queue-like table" — the docs bless exactly this pattern.
- "If a `LIMIT` is used, locking stops once enough rows have been returned to satisfy the limit."
- READ COMMITTED caution: ORDER BY + locking can return rows out of order (ORDER BY runs before lock waits). For claim purposes this is harmless — order is a fairness preference, not a correctness requirement. Worth one spec sentence.

### Guarded monotonic flush (J-2 + D-5) — NULL semantics verified
```sql
-- Source: postgresql.org/docs/current/functions-conditional.html
BEGIN;
INSERT INTO write_guards(key) VALUES ('flush:{batchId}')
  ON CONFLICT DO NOTHING RETURNING key;
-- 0 rows returned ⇒ already applied ⇒ COMMIT and exit (retry is a no-op)
UPDATE monitors SET
  total_checks  = total_checks + $dTotal,
  failed_checks = failed_checks + $dFailed,
  last_checked  = GREATEST(last_checked, $lastTs),
  response_time = CASE WHEN $lastTs > last_checked THEN $lastRt ELSE response_time END
WHERE id = $mid;
COMMIT;
```
Verified properties [VERIFIED: postgresql.org/docs/functions-conditional]:
- "NULL values in the argument list are ignored. The result will be NULL only if all the expressions evaluate to NULL. (This is a deviation from the SQL standard.)" ⇒ `GREATEST(NULL, $ts)` = `$ts` — **no COALESCE needed** (contrary to SQL-standard intuition).
- Asymmetry: `$lastTs > NULL` is NULL (not true) ⇒ the CASE takes the ELSE branch on a never-checked monitor. Spec should note the edge is unreachable by construction (first check is Tier 1) and benign if reached.

### Duplicate-incident backstop (D-1) — partial index + inference verified
```sql
-- Source: postgresql.org/docs/current/sql-insert.html
CREATE UNIQUE INDEX incidents_one_ongoing
  ON incidents (monitor_id) WHERE status = 'ONGOING';

-- transition path: conditional UPDATE first; the index is the physical backstop
INSERT INTO incidents (id, monitor_id, status, started_at)
VALUES ($id, $mid, 'ONGOING', now())
ON CONFLICT (monitor_id) WHERE status = 'ONGOING' DO NOTHING;
-- index_predicate "Used to allow inference of partial unique indexes… Follows
-- CREATE INDEX format" — verified inference example in the docs
```
Caveat to record [VERIFIED: postgresql.org/docs/sql-insert]: "While `CREATE INDEX CONCURRENTLY`… is running on a unique index, `INSERT … ON CONFLICT` statements on the same table may unexpectedly fail" — a Phase 3 migration-window ordering note.

### BullMQ per-queue defaults (D-12 table seed) — verified from source
```text
Source: github.com/taskforcesh/bullmq master src/interfaces/{base-job-options,worker-options}.ts
priority:      range 0–2097151; 0 = no explicit priority; jobs with NO explicit
               priority are processed BEFORE prioritized jobs; lower numbers
               first among prioritized; slight performance cost ⇒ EVERY lane
               needs an explicit priority (else routine outranks manual — J-6 inverted)
attempts:      default 1
removeOnComplete/removeOnFail: boolean | number | { age, count };
               eviction is best-effort — no background timer; aged jobs removed
               only when another job completes/fails afterwards
Worker defaults: concurrency 1; stalledInterval 30000 ms; maxStalledCount 1;
               lockDuration 30000 ms; lockRenewTime = lockDuration/2
```

### Better Auth core schema (D-09 field-map source) — verified from source
```text
Source: github.com/better-auth/better-auth main packages/core/src/db/get-tables.ts
user:        name*(sortable), email*(unique), emailVerified*(boolean, default false,
             not input-accepted), image, createdAt*, updatedAt*
session:     expiresAt*, token*(unique), createdAt*, updatedAt*, ipAddress,
             userAgent, userId*(FK user, cascade, indexed)
account:     accountId*, providerId*, userId*(FK user, cascade, indexed),
             accessToken, refreshToken, idToken, accessTokenExpiresAt,
             refreshTokenExpiresAt, scope, password (token fields never returned),
             createdAt*, updatedAt*
verification: identifier*(indexed), value*, expiresAt*, createdAt*, updatedAt*
Mapping surface: user:{modelName:"users", fields:{...}}; FKs reference the schema
key "user" even when modelName is aliased (upstream issue #8111) — note for the
Drizzle FK definitions in Phase 7. advanced.database.generateId: false|"serial"|"uuid"|fn.
```

### Telegram webhook verification (S-2) — verified
```text
Source: core.telegram.org/bots/api#setWebhook
secret_token: 1–256 chars, ONLY [A-Z a-z 0-9 _ -]
setWebhook sends header "X-Telegram-Bot-Api-Secret-Token" with every update:
"The header is useful to ensure that the request comes from a webhook set by you."
Validation = constant-time comparison of header vs configured secret; reject otherwise.
```

### pg Pool budget config (D-8) — verified
```text
Source: node-postgres.com/apis/pool
max default 10; idleTimeoutMillis default 10000 (0 disables); connectionTimeoutMillis
default 0 (NO timeout — pin it, e.g. 10s, in the budget spec); statement_timeout /
idle_in_transaction_session_timeout are client-level options the Pool accepts via
pass-through ("All valid client config options are also valid here").
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact on addenda |
|--------------|------------------|--------------|-------------------|
| BullMQ repeatable jobs (`repeat` option, `getRepeatableJobs`) | `upsertJobScheduler` Job Schedulers | v6, 2026-07 | Audit §14 wording "repeatable job" must be modernized wherever it survives |
| `Job#discard()` | `UnrecoverableError` throw | v6 | Email/alert permanent-error spec uses the throw, not the method |
| ioredis bundled with BullMQ | optional peer — install explicitly | v6, 2026-07 | Resilience spec names ioredis 6.0.0 explicitly |
| NextAuth JWT sessions + PrismaAdapter | Better Auth DB sessions + cookieCache | migration target | Auth spec (A-2): proxy validates signed cookie, zero DB hits |
| `prisma db push` | drizzle-kit versioned migrations | migration target | Schema addendum + runbook: single runner, live-DDL baseline, empty-diff gate |

**Deprecated/outdated:**
- Audit §13 "worker falls back to writing routine pings straight to Postgres" — rejected by review R-1 as incoherent under BullMQ (no Redis = no jobs). Replace with pause-by-design + heartbeat detection + staleness UI.
- Audit §13 lock TTL "interval + slack" — replaced by J-3 (timeout + margin + renewal + abort-on-loss).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Better Auth social `providerId` values are lowercase `google` / `github` | Auth spec content | Field-map row wrong; D-09 already mandates the `confirm by Phase 7 dry-run` marker, so the design self-contains this assumption |
| A2 | Existing-column types in §10/§11 of the audit (from `schema.prisma`) reflect production | Schema addendum baseline | Known drift risk (timestamp vs timestamptz — audit M-6); mitigated by the "verify against live pg_dump" markers per D-05/DRZ-01; Phase 3 proves equivalence |
| A3 | The D-17 walkthrough list plus §10's three criteria are sufficient re-review scope | READY mechanics | A hidden criterion could flip READY prematurely; mitigated by D-15 fresh-agent pass re-reading the full review, not just the list |
| A4 | Neon `max_connections` ≈ 104 at 0.25 CU (project's current tier) | Connection budget | Budget headroom math changes if the tier differs; carried as [CITED: neon.com/docs via project research]; runbook tells the operator to verify tier |

**All other claims were verified this session from primary sources (see Sources) or copied from locked decisions (CONTEXT.md) / project-authoritative documents.**

## Open Questions

1. **§10 criterion (2) interpretation — "schema addenda are reflected in the target Drizzle schema"**
   - What we know: D-05 forbids authoring full Drizzle code in Phase 1 (it would pre-empt the Phase 3 live-DDL baseline, DRZ-01). §10 was written before that decision.
   - What's unclear: whether the re-reviewer should read criterion (2) as "the amended §11 DDL-precise sketch + Phase 3 transcription contract satisfies it".
   - Recommendation: the re-review section should record this interpretation explicitly when granting READY, citing D-05/DRZ-01 — prevents a wasted fix-loop cycle on an unimplementable reading.
2. **Mechanics of the "separate session/agent" re-review (D-15) inside GSD**
   - What we know: D-15 requires author-blind review; the verdict flip consumes its output.
   - What's unclear: exact spawning mechanism (subagent vs `gsd-review` vs fresh conversation) — a planner detail.
   - Recommendation: plan the re-review as its own task with an explicit instruction block that the executing agent must not have authored the addenda, and give it the D-17 walkthrough script; the verdict flip is a separate downstream task.
3. **Breaker probe target under HALF_OPEN (D-11)**
   - What we know: shape is pinned (5 consecutive → OPEN 60 s → single probe write → CLOSED/re-OPEN).
   - What's unclear: whether the probe is a synthetic `write_guards` insert or a replay of the failed write — both defensible.
   - Recommendation (Claude's discretion area): specify a dedicated probe (`INSERT INTO write_guards(key) VALUES ('breaker:probe:{ts}') ON CONFLICT DO NOTHING`) so probe traffic is identifiable in logs and never double-applies real data.

## Environment Availability

Step 2.6: SKIPPED — pure documentation phase; no external tools, services, or runtimes are required beyond git and the repo's existing tooling.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | none — documentation phase; validation is structural (grep/read) + the adversarial re-review |
| Config file | none — see Wave 0 gaps |
| Quick run command | `grep -cE "Amended 2026-09" docs/ARCHITECTURE-AUDIT.md` |
| Full suite command | the §9 trace check + verdict checks below (single bash invocation, < 30 s) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DSGN-01 | Every §8 addendum present with D-02 markers in the audit + runbook file exists | structural | `test -f docs/DEPLOY-RUNBOOK.md && grep -c "Amended 2026-" docs/ARCHITECTURE-AUDIT.md` (expect ≥ 7 markers across the 8 addendum topics) | n/a — run in task verification |
| DSGN-01 | Every §9 item ID traces to an amendment marker | structural | `for id in J-1 J-2 J-3 J-4 J-5 J-6 D-1 D-2 D-3 D-4 D-6 D-7 D-8 R-1 A-1 A-2 A-3 S-1 S-2 S-3 S-4 M-1 M-2 M-3 P-1; do grep -q "resolves.*$id\|D-6\|$id" docs/ARCHITECTURE-AUDIT.md docs/DEPLOY-RUNBOOK.md \|\| echo "MISSING: $id"; done` (empty output = pass) | n/a — Wave 0 |
| DSGN-01 | No stale rejected sentences survive | structural | `grep -nE "falls back to writing routine pings\|alert:sent:\|interval \+ slack" docs/ARCHITECTURE-AUDIT.md` (expect no matches) | n/a — Wave 0 |
| DSGN-02 | Verdict flipped: §1 shows READY, dated, reviewer identified; history preserved; Re-review section exists | structural | `grep -n "READY" docs/ARCHITECTURE-REVIEW.md` + manual read of §1/Re-review section | n/a — final task |
| DSGN-02 | Re-review ran clean (or fix-loop ≤ 2 documented) | manual-only (justified: adversarial judgment — D-15/D-17/D-18) | — | n/a |

### Sampling Rate
- **Per task commit:** the grep structural checks for the sections that task touched
- **Per wave merge:** full §9 trace check + stale-sentence grep
- **Phase gate:** verdict-flip checks + re-review section present, before `/gsd-verify-work`

### Wave 0 Gaps
None — no test infrastructure is needed for a documentation phase; the commands above are self-contained shell one-liners (the planner may inline them into task verification steps).

## Security Domain

This phase *specifies* security controls rather than implementing them. The addenda are where ASVS L1 coverage is designed.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control (specified this phase, implemented later) |
|---------------|---------|-----------------------------------------------------------|
| V2 Authentication | yes | Auth spec (A-1): bcrypt `password.hash/verify` config, canary login gate — Phase 7 |
| V3 Session Management | yes | Auth spec (A-2): `cookieCache` 5-min TTL signed cookie, `disableCookieCache` on sensitive endpoints; forced re-login announced (Q-4) — Phase 7 |
| V4 Access Control | yes | Auth spec (A-3): admin plugin `role` column design; feedback admin-gated; queue UI admin + IP allowlist (S-3) — Phase 7 |
| V5 Input Validation | yes | Check-job spec (S-1): resolve-then-validate IP denylist per redirect hop (≤5), scheme allowlist http/https, 2 MB cap, 10 s timeout; zod schemas for monitor config — Phase 4/6 |
| V6 Cryptography | partial | Secret handling design: `BETTER_AUTH_SECRET`; Telegram `secret_token` (1–256 chars `[A-Za-z0-9_-]`); no secrets via query string (S-4) |
| V12 Files & Resources | yes | Response-size caps + strict timeouts in the SSRF pipeline (S-1.3) |

### Known Threat Patterns for worker + queue + auth-cutover stack

| Pattern | STRIDE | Standard Mitigation (design content this phase) |
|---------|--------|---------------------|
| SSRF via user-supplied URLs (DNS rebinding, redirect-to-private, IPv6/decimal literals, metadata endpoints) | Tampering / Information Disclosure | Layered: OS egress deny private ranges (worker host) + engine resolve-then-validate every hop + scheme allowlist + size/timeout caps; §23 test cases TC-SSRF-* (S-1 — highest-severity review item) |
| Forged Telegram webhook payloads | Spoofing | `secret_token` set at `setWebhook`; reject wrong/missing `X-Telegram-Bot-Api-Secret-Token` (S-2) |
| Unauthenticated queue inspection (Bull Board) | Information Disclosure | Admin role + IP allowlist, mounted on worker `:9090` only (S-3/OBS-04) |
| Stack traces / internals in error responses | Information Disclosure | Sanitized error contract; no `err.stack` (S-4, R16) — runbook + §22 note |
| Secret leakage via query strings (current `?secret=` cron acceptance) | Information Disclosure | Design rule: no endpoint accepts secrets via query; `CRON_SECRET` retires with cron routes (S-4/R15) |
| Duplicate/lost alerts via at-least-once redelivery | Tampering | Transactional outbox (D-2) + incident-keyed `SET NX EX` dedup (D-4); residual duplicates documented as accepted behavior |
| Counter corruption via re-applied deltas | Tampering | `write_guards` same-transaction guard (J-2); `GREATEST`/CASE monotonicity (D-5) |

## Sources

### Primary (HIGH confidence — fetched this session, 2026-09-09)
- postgresql.org/docs/current/sql-select.html — SKIP LOCKED queue pattern, locking-clause/WITH-query rule, LIMIT interplay, READ COMMITTED ordering caution
- postgresql.org/docs/current/functions-conditional.html — GREATEST/LEAST NULL-ignoring behavior (documented SQL-standard deviation)
- postgresql.org/docs/current/sql-insert.html — ON CONFLICT conflict_target + index_predicate partial-index inference; CONCURRENTLY caveat
- github.com/taskforcesh/bullmq (master) src/interfaces/base-job-options.ts + worker-options.ts — priority 0 semantics (non-prioritized first), attempts default, KeepJobs best-effort eviction, worker lock/stall defaults
- github.com/better-auth/better-auth (main) packages/core/src/db/get-tables.ts — core schema field lists (user/session/account/verification); FK/schema-key note (#8111)
- core.telegram.org/bots/api#setwebhook — secret_token constraints + X-Telegram-Bot-Api-Secret-Token header
- node-postgres.com/apis/pool — pool defaults (max 10, idle 10000, connectionTimeout 0), client-option pass-through

### Primary (project-authoritative)
- `docs/ARCHITECTURE-AUDIT.md` §1–24 + Appendix B — the patch target; all section references
- `docs/ARCHITECTURE-REVIEW.md` §1/§3.1/§4/§8/§9/§10 — blocking issues, addenda list, checklist, re-review criteria
- `.planning/phases/01-design-gate-review-verdict-ready/01-CONTEXT.md` — decisions D-01…D-18
- `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/PROJECT.md`

### Secondary (MEDIUM confidence — project research, verified 2026-09-08)
- `.planning/research/STACK.md` — all package versions (npm registry, live), Better Auth config shapes, BullMQ v6 semantics, Neon pooling/limits, drizzle-kit command semantics
- `.planning/research/ARCHITECTURE.md` — topology, boundary rules, connection budget, health endpoints, PM2 handshake (pm2.keymetrics.io, docs.bullmq.io, neon.com/docs fetched that session)
- `.planning/research/FEATURES.md`, `.planning/research/PITFALLS.md` — table-stakes checklist and pitfall grounding

### Tertiary (LOW confidence — flagged)
- WebSearch was rate-limited this session; the one training-knowledge answer it returned (BullMQ priority "default 1") was **superseded by source verification** (default 0, non-prioritized-first) — no training-only claim survives untagged
- Assumptions A1–A4 in the Assumptions Log

## Metadata

**Confidence breakdown:**
- Standard stack (documentation targets): HIGH — versions registry-verified 2026-09-08 (STACK.md); bullmq/better-auth semantics re-verified from source code this session
- Architecture (amendment structure, §8/§9 mappings): HIGH — derived entirely from project-authoritative documents plus locked CONTEXT.md decisions
- Pitfalls: HIGH for verified-semantics pitfalls (1–5); MEDIUM for process pitfalls (6–8) — craft guidance grounded in D-02/D-05/D-15
- Validation architecture: MEDIUM — structural grep checks are sound but the load-bearing validation is the adversarial re-review, which is judgment-based by design

**Research date:** 2026-09-09
**Valid until:** 2026-10-09 (docs and locked decisions are stable; external semantics are of slow-moving software)
