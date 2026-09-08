---
phase: 01-design-gate-review-verdict-ready
plan: 04
subsystem: docs
tags: [deploy-runbook, operator-docs, traceability, review-gate]
requires:
  - "01-03 (audit §13/§12/§25 amendments this plan builds on; connection-budget numbers)"
provides:
  - "docs/DEPLOY-RUNBOOK.md — standalone operator runbook, both deploy topologies, per-step rollback, PM2 settings, smoke check (resolves P-1 design slice)"
  - "audit §22 pointer to the runbook + amendment marker resolving P-1, M-1, M-2, M-3, S-4"
  - "author-side §9 self-traceability evidence (this file) consumed by plan 01-05's adversarial re-review"
affects:
  - "docs/ARCHITECTURE-AUDIT.md (§22 + header amendment note only)"
tech-stack:
  added: []
  patterns:
    - "imperative operator step format: Action / Verification / Rollback per numbered step (Pitfall 8, D-01/D-04)"
    - "§24-style topology comparison table + per-topology numbered step lists"
key-files:
  created:
    - docs/DEPLOY-RUNBOOK.md
  modified:
    - docs/ARCHITECTURE-AUDIT.md
decisions:
  - "Runbook PM2 values pinned: kill_timeout 20000 ms (non-negotiable floor per P-1/DEP-01), wait_ready true + listen_timeout 30000 + max_restarts 10 + min_uptime 60000 marked default-tune-with-data (D-10 discipline)"
  - "Interim smoke check defined as web-serving check (HTTP 200 + heartbeat green) since no worker exists in Phases 2-3; synthetic-check smoke is the target-topology form from Phase 4"
  - "Migrate step worded as no-op-when-no-pending so the single interim ordering (Phases 2-3) stays exact even for Phase 2 releases that carry no migrations"
metrics:
  duration: 5m
  completed: 2026-09-09
  tasks: 3
  files: 2
status: complete
---

# Phase 01 Plan 04: Deploy Runbook + §22 Pointer + §9 Self-Check Summary

Operator-facing deploy runbook covering both milestone topologies with per-step verification and rollback, audit §22 cross-pointer resolving P-1/M-1/M-2/M-3/S-4, and a clean author-side §9 traceability check — the input state plan 01-05's adversarial re-review requires.

## What Was Built

### Task 1 — docs/DEPLOY-RUNBOOK.md (NEW) [a21aa8c]

- Header blockquote: date 2026-09-09, audience (operator mid-deploy), scope (every release this milestone), status (design-stage, verified live from Phase 2 onward), companion-doc pointer.
- Connection-budget summary table only (web 10 POOLED / worker 20 DIRECT / migrations 1 DIRECT, steady-state ≤ 31) with pointer to audit §25 for the full spec (D-03).
- §2 topology comparison table (§24-style): interim Phases 2–3 vs target Phase 4+, worker step + `readyz` gate inserted before web restart.
- §3 interim topology, 5 ordered steps: build → backup (`pg_dump` + anonymized-snapshot rehearsal rule) → migrate (single runner, never at boot) → web restart → smoke check.
- §4 target topology, 6 ordered steps: same sequence with worker restart + `readyz` wait before web restart; `healthz` = process only, `readyz` = Redis + DB; release gated on worker readiness.
- Every step carries an explicit Action / Verification / Rollback triple (11/11 — verified programmatically).
- §5 PM2 settings checklist per P-1/DEP-01: `kill_timeout` 20000 ms (≥ 20 s, non-negotiable), `wait_ready`, `listen_timeout` 30000, `max_restarts` 10, `min_uptime` 60000, each with a one-line reason.
- §6 normative smoke-check definition: enqueue one synthetic check against a known-good target, assert the ping row appears.
- §7 rollback compatibility rule (M-2/DEP-03): retained previous tarball as the rollback action, expand/contract discipline, drops deferred to a following release, documented down-path for destructive steps.
- §8 migration discipline (M-1/M-3): single runner only, baseline from live DDL, empty-diff CI gate.
- §9 S-4 decision note: no endpoint accepts secrets via query strings; CRON_SECRET retires with the cron endpoints (Phase 2 FND-07 repo hygiene, Phase 5 overlap-verified deletion).

### Task 2 — audit §22 pointer + consistency [7c086ac]

- Marker under §22 heading: `*Amended 2026-09-09 (resolves P-1, M-1, M-2, M-3, S-4; §9 items 21, 22)*` (citation scheme verbatim per the 01-03 precedent — issue IDs are the load-bearing tokens).
- Pointer paragraph with relative link `./DEPLOY-RUNBOOK.md` naming it the authoritative operator runbook; §22 keeps design-level content, notes the interim ordering exists, and defers to the runbook on any differing read (D-01 split, no step-list duplication).
- §22 item 8 tagged `S-4` and extended with the no-secrets-in-query design rule + CRON_SECRET retirement pointer.

### Task 3 — §9 self-traceability check + final stale sweep [b9b6166]

- Clerical header fix: the amendment note now covers the "Added" marker form (§25) in addition to "Amended" and points to the runbook.
- Full check output recorded below for the plan-05 re-reviewer.

## §9 Self-Check Output (author-side gate evidence — consumed by plan 01-05)

**1. §9 item loop** — `for id in J-1 … P-1: grep -q "$id" docs/ARCHITECTURE-AUDIT.md docs/DEPLOY-RUNBOOK.md || echo MISSING`. **Output: empty — zero MISSING lines.** All 25 IDs confirmed:

| IDs | Status |
|---|---|
| J-1 J-2 J-3 J-4 J-5 J-6 | FOUND (audit §11/§13/§14/§15/§16/§23 markers + bodies) |
| D-1 D-2 D-3 D-4 D-6 D-7 D-8 | FOUND (audit §11/§13/§16/§23/§25 + runbook §1/§7/§8) |
| R-1 | FOUND (audit §13 marker; runbook §5 heartbeat note) |
| A-1 A-2 A-3 | FOUND (audit §12 marker) |
| S-1 S-2 S-3 | FOUND (audit §15/§12 markers) |
| S-4 | FOUND (audit §22 marker + item 8; runbook §9 decision note) — was MISSING before this plan |
| M-1 M-2 M-3 | FOUND (audit §11/§22/§25; runbook §7/§8) — M-2 was MISSING before this plan |
| P-1 | FOUND (audit §22 marker; runbook §4/§5) — was MISSING before this plan |

**2. Addendum coverage** — 11 `Amended/Added 2026-` lines total; 9 section-level markers spanning all 8 §8 addendum topics: schema (§11), scheduler (§14), check job (§15), writers (§16), resilience (§13), auth (§12), connection budget (§25, Added), runbook (§22 pointer + `docs/DEPLOY-RUNBOOK.md` existence). The 8-topic threshold (≥ 8 markers) passes: 11 ≥ 8.

**3. Final stale sweep** — `grep -nE "falls back to writing routine pings|alert:sent:|interval \+ slack|repeatable job" docs/ARCHITECTURE-AUDIT.md` → **zero output** (exit 1).

**4. D-02 header check** — audit header blockquote amendment note exists, matches the inline marker format, and now covers both marker forms (Amended/Added).

## Verification Results

- Task 1 automated: file exists; `readyz` ×16 (≥3), `pg_dump` ×6 (≥1), `kill_timeout` ×2 (≥1), `[Rr]ollback` ×15 (≥6), `worker 20|migrations 1` ×2 (≥2). PASS.
- Task 2 automated: `DEPLOY-RUNBOOK.md` refs in audit ×2 (≥1); `Amended 2026-` ×10 (≥10). PASS.
- Task 3 automated: ID loop empty; stale sweep empty; markers ×11 (≥8). PASS.
- Manual spot-check (plan `<verification>`): 11/11 numbered steps across both topologies carry imperative Action → Verification → Rollback triples (`grep -c` shows 11/11/11); no rationale paragraph exists without an accompanying imperative step — rationale lives in the audit per D-03.

## Deviations from Plan

None material. Two in-plan clerical additions, both permitted by Task 3's "clerical completion of markers is allowed":

1. **[Rule 3 - clerical] Header amendment note extended** to cover the "Added" marker form used by §25 and to carry the runbook pointer — the note previously described only "Amended" markers, a D-02 header-check mismatch. Commit b9b6166.
2. **[in-scope addition] §22 item 8 tagged S-4** with the no-secrets-in-query rule, making the new §22 marker's S-4 citation substantive inside §22 itself. Commit 7c086ac.

## Auth Gates

None — no authentication-gated operations in this plan.

## Known Stubs

None — documentation-only plan; no code, data wiring, or placeholder values.

## TDD Gate Compliance

Not applicable — `type: execute` plan, no `tdd="true"` tasks (documentation phase).

## Threat Flags

None. Threat-register dispositions all honored: T-04-01 (ordering/backup/single-runner/readyz gate — runbook §3/§4), T-04-02 (S-4 decision note — runbook §9), T-04-03 (expand/contract + retained tarball — runbook §7), T-04-04 (this self-check record), T-04-05 accepted (zero installs). No security-relevant surface beyond the plan's threat model.

## Self-Check: PASSED

Files: docs/DEPLOY-RUNBOOK.md FOUND · docs/ARCHITECTURE-AUDIT.md FOUND · 01-04-SUMMARY.md FOUND. Commits: a21aa8c FOUND · 7c086ac FOUND · b9b6166 FOUND.
