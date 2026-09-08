# Phase 1: Design Gate — Review Verdict READY - Pattern Map

**Mapped:** 2026-09-09
**Files analyzed:** 3 (2 amended, 1 new)
**Analogs found:** 3 / 3 (this is a documentation phase — the "analogs" are the target documents themselves and their established formatting conventions)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `docs/ARCHITECTURE-AUDIT.md` (amend in place, 7 addenda) | design doc | N/A (documentation) | itself — §11–§16, §22, §23 structure | exact |
| `docs/DEPLOY-RUNBOOK.md` (NEW) | runbook / ops doc | N/A (documentation) | audit §22 "Deployment Changes" + §24 migration-order table | partial (new doc type in repo) |
| `docs/ARCHITECTURE-REVIEW.md` (amend at flip time) | review verdict doc | N/A (documentation) | itself — §1 verdict block, §9 checklist, §3.1 walkthrough table | exact |

No code files are created or modified in this phase (CONTEXT.md domain: "a pure documentation/design phase — no implementation code").

## Pattern Assignments

### `docs/ARCHITECTURE-AUDIT.md` — 7 in-place amendments

**Analog:** the audit itself. Its existing conventions are the patterns to follow.

**Document header / where the amendment note goes** (lines 1–8): the file opens with a `>` blockquote metadata header (`Repository`, `Audit date`, `Scope`, `Status`). Per D-02, add the dated amendment note to this header block, not a new top section:

```markdown
> **Repository:** SPIDER_NODE-uptime-tracker
> **Audit date:** 2026-09-08
> ...
> **Amendment note:** Amended 2026-09-XX to incorporate the design addenda required by
> ARCHITECTURE-REVIEW.md §8. Amendment markers appear inline as
> "Amended 2026-09-XX (resolves <issue-ids>)".
```

**Section-format pattern to copy for each addendum** — the audit already uses exactly the shapes D-05..D-09 require; extend, don't invent:

| Required addendum shape | Existing audit precedent to copy |
|---|---|
| DDL/schema precision (D-05) | §11 (lines 296–370): fenced ```ts block with per-column inline comments (`// bcrypt hash (Better Auth compatible column, §12)`), followed by a numbered "Mapping decisions to record now" list. New/changed columns (`next_check_at`, `write_guards`, `outbox`, `pings.error_class`) get inline comments citing the review ID; use ```sql DDL for new precision per D-05 (Drizzle snippets only where semantics are subtle) |
| SQL writer specs (D-06) | §16 invariant list (lines 483–488) + the review's own fenced SQL blocks (review lines 80–92, 123–126, 144–152) — copy the review's literal SQL verbatim into the amended §16, adding the doc-citation comments from RESEARCH.md Code Examples (SKIP LOCKED inside CTE, GREATEST/NULL asymmetry) |
| Numbered algorithm + failure table (D-07) | §14 "Key mechanics" bullet list (lines 436–444) and §22 numbered list (lines 610–618) — upgrade to numbered steps; failure tables follow the audit's existing 4-column table style (e.g. §13 key table, lines 405–414) |
| Parameter-pinning table (D-10) | §13's `Use / Key shape / TTL / Recovery story` table (lines 405–414) — same markdown table style with a new `Parameter / Default / Rationale / Class` header |
| Queue topology table (D-12) | §14 queue table (lines 428–434: `Queue / Producer / Consumer / Jobs`) — extend columns with concurrency/priority/rate-limit/removeOnComplete/removeOnFail/stalled; every lane gets an explicit priority cell |
| Auth field-map tables (D-09) | §12's two-column mapping table (lines 378–389) + numbered "Migration constraints" list (lines 391–397) — add the per-table field-map tables (users/session/account/verification → Better Auth core schema per RESEARCH.md) |
| Given/when/then test cases (D-08) | §23's numbered test list (lines 629–640) — append new cases (TC-SSRF-*, duplicate-incident, duplicate-alert) in given/when/then form |

**Stale sentences that must be REPLACED, not appended beside** (RESEARCH.md Pitfall 1 — enumerable now with line numbers):

| Stale text | Location | Rejected by | Replacement source |
|---|---|---|---|
| "the worker falls back to writing routine pings straight to Postgres (unbatched)" | §13 line 418 | R-1 | pause-by-design + heartbeat + staleness UI |
| `alert:sent:{monitorId}:{state}` dedup key | §13 line 414 | D-4 | incident-keyed `SET NX EX alert:{incidentId}:down` |
| lock TTL "interval + slack" | §13 line 408 | J-3 | timeout (10 s) + margin (5 s) + renewal TTL/3 + abort-on-loss |
| idempotency key `{monitorId}:{scheduledAt}` | §13 line 411, §14 line 439 | J-1 | claim-epoch key `check:{monitorId}:{next_check_at epoch}` |
| "repeatable job" (BullMQ 4/5 sense) | §14 lines 430, 434; §13 line 407 | BullMQ 6 | `upsertJobScheduler` Job Scheduler wording |
| scheduler SELECT `last_checked + interval <= now` | §14 line 430 | J-1 | claim transaction on `next_check_at` |

Post-authoring grep (from RESEARCH.md validation section): `grep -nE "falls back to writing routine pings|alert:sent:|interval \+ slack|repeatable" docs/ARCHITECTURE-AUDIT.md` must return nothing conflicting.

**Amendment marker pattern (D-02)** — place immediately under each amended heading:

```markdown
## 13. Proposed Redis Architecture
*Amended 2026-09-XX (resolves J-5, R-1, §9 items 5, 13)*
```

The issue-ID vocabulary (J/D/R/A/S/M/P/N) comes from review §4–§6 — never invent new IDs.

### `docs/DEPLOY-RUNBOOK.md` (NEW file)

**Analog:** audit §22 "Deployment Changes" (lines 604–618) for content, and §24's migration-order table (lines 648–662) for step-presentation style. No operator-facing runbook exists in the repo — this is the one genuinely new document *type*.

**Patterns to carry over:**
- §22's numbered-list step style, but rewritten imperatively for an operator mid-deploy (D-04/Pitfall 8): each step = action → verification → rollback action.
- §24's table format for the two-topology ordering (interim Phases 2–3 vs target Phase 4+).
- Include the connection-budget summary table only (web 10 / worker 20 / migrations 1) — rationale stays in the audit (D-03).
- Audit §22 must gain a pointer line to the runbook (CONTEXT.md Integration Points).

**Structure skeleton (D-01/D-04):** header blockquote (date, audience: operator mid-deploy, scope) → connection-budget summary table → interim topology ordering → target topology ordering (worker restart + `readyz` gate before web restart) → per-step rollback → PM2 settings (`kill_timeout` ≥ 20 s, `wait_ready`, `max_restarts`/`min_uptime` per review P-1) → smoke check (enqueue synthetic check, assert ping row).

### `docs/ARCHITECTURE-REVIEW.md` — verdict flip (final task)

**Analog:** the review doc itself.

**Edit targets (surgical, per D-16):**
- §1 (lines 11–28): the `# ❌ NOT READY` block flips to `# ✅ READY` — dated, re-reviewer identified. The "14 blocking issues" paragraph (line 28) moves to a history subsection; the mandated-topology ASCII diagram (lines 19–24) and the compliance statements stay.
- Append a new `## 11. Re-review (2026-09-XX)` section: per-§10-criterion results, the verified §9 traceability list, and the D-17 walkthrough transcripts (Redis restart, PG down, duplicate delivery, worker killed mid-job, lock loss, auth cutover) — reuse §3.1's table format (lines 43–52) for per-criterion results.
- §9 checklist (lines 295–317): check the boxes only at flip time (or leave unchecked and let the Re-review section record verification — either is fine; keep edits minimal so git history shows the arc).

**Constraint (D-15/Pitfall 6):** the re-review must be executed by a separate agent invocation that did not author the addenda; the verdict-flip task consumes its output as a downstream task.

## Shared Patterns

### Amendment markers (D-02)
**Apply to:** every audit section touched, without exception.
`*Amended 2026-09-XX (resolves J-x, D-x, §9 item N)*` under the heading + dated note in the header blockquote (lines 1–8). The §9 trace grep depends on greppability of these markers.

### Issue-ID vocabulary
**Apply to:** all three files. Only existing IDs from review §4 (J/D/R/A/S/M/P) and §5 (N-x); decisions D-01..D-18 from CONTEXT.md are cited as such. No new tracking scheme.

### Doc formatting conventions
**Apply to:** all amendments. Fenced code blocks with language tags (```ts, ```sql, ```text — see audit §11/§15 and review §4); markdown tables with bold first-column emphasis where load-bearing; `---` horizontal rules between `##` sections; blockquote metadata headers at document top. English prose only.

### Replacement-not-appendition
**Apply to:** every audit section named in the stale-sentence table above. After each amendment task, grep for the stale strings (validation commands in RESEARCH.md "Validation Architecture").

## No Analog Found

| File | Role | Reason |
|------|------|--------|
| `docs/DEPLOY-RUNBOOK.md` | operator runbook | No operator-facing runbook exists in the repo; closest content analog is audit §22 (design-rationale shaped, wrong audience). Use RESEARCH.md Pitfall 8 + D-01/D-03/D-04 as the pattern source; audit §24's table style for presentation. |

## Metadata

**Analog search scope:** `docs/`, `.planning/` (REQUIREMENTS/ROADMAP/PROJECT/research read via CONTEXT/RESEARCH synthesis)
**Files scanned:** `docs/ARCHITECTURE-AUDIT.md` (703 lines — header, §11–§16, §22–§24 read), `docs/ARCHITECTURE-REVIEW.md` (321 lines — full read)
**Pattern extraction date:** 2026-09-09
