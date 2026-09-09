---
phase: 01-design-gate-review-verdict-ready
plan: 08
subsystem: design-docs
tags: [architecture-audit, deploy-runbook, gap-closure, fix-cycle, ssrf-egress, s-1-layering, denylist-canonicalization, manual-check-semantics, limiter-atomicity, connection-budget]
requires: [01-06, 01-07]
provides: [RR-01-closed, RR-02-closed, RR-03-closed, RR-04-closed, WR-01-closed, WR-02-closed, WR-07-closed, WR-08-closed, IN-01-closed, IN-05-closed, OBS-04-closed, OBS-05-closed, cycle-2-input-ready]
affects: [01-09]
tech-stack:
  added: []
  patterns:
    - "one-denylist-three-statements drift control: §15.1 engine denylist (11 CIDR tokens incl. ::ffff:0:0/96, 0.0.0.0/8, 64:ff9b::/96 + canonicalization rule) mirrored verbatim in §15.4 and runbook §10 — any future range change must touch all three in the same change"
    - "manual-lane claim semantics: enqueue-time advance of next_check_at via the §14.3-shaped atomic UPDATE + per-enqueue jobId check:{monitorId}:manual:{epochMs-of-enqueue} (admission via the D-13 limiter, never the jobId)"
    - "single-Lua INCR + EXPIRE-NX-on-first-increment limiter atomicity (stranded-counter prevention)"
    - "apply-once host hardening: egress rules provisioned at Phase 4 worker provisioning, not per release; verified via public-curl-succeeds / private-refused / readyz-green triple"
key-files:
  created:
    - .planning/phases/01-design-gate-review-verdict-ready/01-08-SUMMARY.md
  modified:
    - docs/ARCHITECTURE-AUDIT.md
    - docs/DEPLOY-RUNBOOK.md
requirements: [DSGN-01]
decisions:
  - "01-08: S-1 egress layer is one denylist in three statements — §15.1 engine list (post-WR-01), §15.4 OS mirror, runbook §10 operator rules; drift control is shared token set + same-change mandate (RR-01/WR-01)"
  - "01-08: manual checks advance next_check_at one interval at enqueue via the §14.3-shaped atomic UPDATE (WHERE id AND is_active, RETURNING); manual jobId check:{monitorId}:manual:{epochMs-of-enqueue} is unique per enqueue — admission is the D-13 limiter's job, never the jobId's (WR-02)"
  - "01-08: rate-limit atomicity pinned as one Lua script doing INCR + EXPIRE-with-NX on first increment — separate calls strand a TTL-less counter and permanently limit a user (IN-01/OBS-04)"
  - "01-08: steady-state Postgres total restated ≤ 30 (web 10 + worker 20), ≤ 31 only during deploys while the one-shot migration runner is connected; web process additionally budgets 2 Redis connections (queue producer + limiter/cache), separate from the worker's 2 (IN-05/OBS-05)"
metrics:
  duration: 602s (~10m)
  completed: 2026-09-09
status: complete
---

# Phase 1 Plan 8: Fix-Cycle Ratified Gaps + Advisory Hardening (RR-01..RR-04, WR-01/02/07/08, IN-01/05, OBS-04/05) Summary

S-1's missing network-egress layer added as audit §15.4 + runbook §10 over a shared 11-token denylist (with IPv4-mapped canonicalization closing the known SSRF bypass classes), all three residual contradictions removed file-wide, and every unpinned load-bearing claim (manual-lane semantics, priority default, limiter keys/atomicity, connection budgets) given a concrete default + rationale or an explicit Phase 4 verification marker.

## What Was Done

| Task | Name | Commit | Key changes |
|------|------|--------|-------------|
| 1 | S-1 network-egress layer (RR-01) + §15 cluster fixes (RR-02, WR-01, WR-08) | `39233d7` | NEW audit §15.4 "Worker-host network egress control (S-1 layer 1)" (Added fix-cycle marker citing S-1/RR-01; denylist mirrors §15.1 verbatim; 80/443-only egress; DNS + loopback/VPC 5432/6379 exceptions; rationale; apply-once-at-Phase-4 stance; points to runbook §10). NEW runbook §10 after §9 (no renumbering; Action/Verification/Rollback triple; denies private ranges incl. metadata-IP probe example, verifies public http/https succeed + non-80/443 refused + readyz green proving the DB/Redis exceptions; rollback notes engine layers remain enforced; cites audit §15.4 both directions). §15.1 step 4 sub-step 2 extended with the canonicalization rule (::ffff:a.b.c.d checked as a.b.c.d against the IPv4 list) + three ranges (::ffff:0:0/96, 0.0.0.0/8, 64:ff9b::/96). §23 new TC-SSRF-MAPPED-V6-01 after TC-SSRF-DNS-REBIND-01. §15 file-tree maintenance.ts comment corrected to cleanup (looped retention deletes, §13.7) / ping-rollup / write_guards pruning — "uptime recompute" now zero matches file-wide. §15.1 step 3 + §15.3 lock-TTL row: renewal spans the entire job lifetime incl. Tier 1 persistence (≤ 30 s statement_timeout), release only in step-7 finally. §15/§23 fix-cycle markers added |
| 2 | Remove the residual contradictions (RR-03, RR-04) | `88a8a07` | §23 item 5: "Redis-down fallback write" replaced with the real degradation assertions (Redis down ⇒ enqueue returns 503 never a silent no-op, pause by design, Postgres intact — worded to complement item 6's failure-injection rows); remaining entries kept with the staging/guard wording. RR-04 spike vocabulary: §12 constraints bullet → §12.2 gate's prefix-routing step reference; §20 M2 → "bcrypt compatibility gate (§12.2): canary login on the anonymized snapshot, then production, before any route flip" (rest of row unchanged); §24 step 7 → same gate ordering via §12.2 (rest of step + rules cell unchanged); §20/§24 carry adjacent one-line fix-cycle markers (RR-04/WR-06). §12.2's own sentence is now the document's only spike occurrence |
| 3 | Pin the unpinned (WR-02, WR-07, IN-01/OBS-04, IN-05/OBS-05) | `932846a` | §14.1 new "Manual-lane claim semantics" paragraph: enqueue-time advance via the §14.3-shaped atomic UPDATE + jobId `check:{monitorId}:manual:{epochMs-of-enqueue}` + D-10 rationale (double-sample elimination). §14.1 priority paragraph: processed-before claim carries "verify against Phase 4 BullMQ 6 research" + live dequeue-order check; standalone invariant "every lane MUST set an explicit priority; cross-lane ordering relies on numeric priority among explicit values only". §13.1 idempotency row: both jobId forms, same removeOnComplete horizon. §13.1 limiter row: third key `rl:manual-user:{userId}` (D-13 6/min) + single-Lua INCR + EXPIRE-NX atomicity with stranded-counter rationale. §25.1: ≤ 30 steady-state / ≤ 31 during deploys (mirrors runbook §1). §13.8: web-process Redis budget (2 connections — queue producer + limiter/cache client). §13/§14/§25 fix-cycle markers extended |

## Coverage (plan must_haves → where closed)

- **RR-01 (HIGH — S-1 network-egress layer)** — audit §15.4 + runbook §10, both carrying the identical 11-token CIDR set as §15.1 step 4 sub-step 2 (three-way token-set comparison passed programmatically); each cites the other by section number; 80/443-only rule, DNS/5432/6379 exceptions, S-1 rationale, and apply-once-at-Phase-4-worker-provisioning verification stance all stated.
- **RR-02 (MEDIUM — uptime recompute residual)** — §15 file tree now names only jobs that exist in §14.1's maintenance lane and §13.7's retention scope; the space-form phrase returns zero matches file-wide (`grep -cE "uptime recompute"` = 0).
- **RR-03 (MEDIUM — forbidden fallback-write test)** — the phrase returns zero matches; item 5 now names the 503/pause/intact assertions and complements (not duplicates) item 6.
- **RR-04 (LOW — spike vocabulary)** — exactly one occurrence remains in the whole document and it is §12.2's own gate-not-spike sentence (count = 1, survivor verified by grep).
- **WR-01 (SSRF bypass classes)** — canonicalization rule + three added ranges in §15.1; TC-SSRF-MAPPED-V6-01 with network/DB/queue effects; the same three ranges mirrored in §15.4 and runbook §10.
- **WR-02 (manual-check interaction)** — advance rule (atomic UPDATE mirroring §14.3), per-enqueue manual jobId, and both-form idempotency row all specified with rationale.
- **WR-07 (priority-default claim)** — Phase-4-verify marker (count 8 ≥ 6, baseline 7 + 1) + standalone invariant sentence; "explicit priority" occurrences 4 ≥ 4 (baseline 3).
- **WR-08 (renewal lifetime)** — sentence in §15.1 step 3 and mirrored in the §15.3 rationale; margin wording no longer implies renewal stops when the fetch returns.
- **IN-01/OBS-04 (limiter keys + atomicity)** — `rl:manual-user:{userId}` present; EXPIRE-NX semantics pinned with the stranded-counter rationale.
- **IN-05/OBS-05 (budget precision)** — §25.1 ≤ 30 / ≤ 31 wording agrees with runbook §1 (which plan 01-07 wrote); web-process Redis budget line in §13.8 (2 connections, producer + limiter/cache, separate from worker's 2).

## Key Links (verified)

- **audit §15.4 ↔ runbook §10** — identical range lists (11/11 tokens, three-way check), identical port rules (80/443 allow; 5432/6379 + DNS exceptions), each names the other's section number.
- **§15.4 denylist ↔ §15.1 step 4 sub-step 2 engine denylist** — `64:ff9b::/96` ×2 in audit, identical token sets; §15.1/§15.4/runbook §10 all declare the mirror relationship and the same-change mandate.
- **§14.1 manual-lane advance ↔ §14.3 claim UPDATE** — the manual enqueue advance is written as the same atomic `next_check_at` UPDATE shape (`next_check_at` pattern present in both).
- **§25.1 ↔ runbook §1** — both state ≤ 30 steady-state / ≤ 31 during deploys (numbers unchanged, precision fixed per IN-05).

## Verification Results

All per-task pinned assertions pass with the plan's recorded baselines reproduced before editing (egress word-boundary 0/0, uptime recompute 1, spike 4, explicit priority 3, EXPIRE NX 0, verify-markers 7). Final measured values — Task 1: audit egress 6 (≥4), runbook egress 5 (≥3), audit `64:ff9b::/96` 2 (≥2), `TC-SSRF-MAPPED-V6-01` 2 (≥1), `uptime recompute` 0, renewal/lifetime 2 (≥1), mirrored-range counts all pass in both documents. Task 2: `Redis-down fallback write` 0, spike count 1 (=1) with the survivor on the §12.2 gate line, 503 count 3 (≥3), `fix cycle` 13 (≥4). Task 3: `rl:manual-user:` 1 (≥1), `check:{monitorId}:manual:` 2 (≥2), EXPIRE-NX 2 (≥1), `≤ 30` 1 (≥1), verify-marker 8 (≥6), invariant sentence 1, `explicit priority` 4 (≥4 vs baseline 3).

Plan-level: §9 checklist ID loop — all 25 IDs present across audit + runbook (nothing dropped); the cycle-1 extended contradiction sweep (`uptime recompute|recompute-uptime|fallback|spike|scheduledAt`) returns 10 hits, each classified as sanctioned (§12.2 gate sentence; §12.3 cookieCache DB fallback; §13.2's prohibition statements ×3 incl. the new item-5 reference; §14.1/§16.5 absent-job listings; M1 Prisma read-only fallback; one pre-existing §7 current-state frontend description that is not a design mechanism); zero `scheduledAt`; amendment-marker count increased (25 Amended/Added lines, fix-cycle mentions 16 in audit); RENAMENX staging-key semantics from plan 01-06 untouched (×6); runbook §5–§9 headings byte-identical in number and title with §10 appended after §9 (no renumbering); `docs/ARCHITECTURE-REVIEW.md` remains byte-identical at blob `520c9409da45bd2c9ab9866fe124403ef6cb7ef3` (verified before Task-1 commit and after all tasks); no file deletions in any task commit; no new untracked files.

## Deviations from Plan

### Process Notes

**1. §23 fix-cycle marker scoped to §23's own changes rather than citing all four Task-1 IDs**
- **Found during:** Task 1, sub-action 6
- **Issue:** The plan instructed extending "the §15 and §23 fix-cycle markers to cite RR-01, RR-02, WR-01, WR-08". RR-01/RR-02/WR-08 are §15-scoped changes; a §23 marker citing them would assert §23 resolves findings it does not contain changes for — inaccurate traceability the cycle-2 adversarial review could flag (the exact Pitfall-1 class this phase is closing).
- **Resolution:** §15's fix-cycle marker cites all four (RR-01, RR-02, WR-01, WR-08); §23's fix-cycle marker cites WR-01 (Task 1 — TC-SSRF-MAPPED-V6-01) and RR-03 (Task 2 — item 5 rewrite). Every finding is cited at the section that actually changed for it.
- **Commit:** `39233d7`, `88a8a07`

**2. RR-03 added to the §23 marker in Task 2, not Task 1**
- **Found during:** Task 1
- **Issue:** An initially drafted §23 marker cited RR-03 before item 5 was rewritten, which would have made the Task-1 intermediate commit claim a resolution not yet applied.
- **Resolution:** The marker was scoped to WR-01 in the Task-1 commit and extended with RR-03 inside the Task-2 commit that performs the item-5 rewrite — every commit is self-consistent.
- **Commit:** `88a8a07`

## Auth Gates

None — documentation-only plan; no authenticated systems touched.

## Known Stubs

None — no code was produced; the deliverable is the amended specification itself, and every amended section is complete (no TODO/placeholder markers introduced).

## Threat Model Disposition

T-08-01 (SSRF mapped-IPv6/NAT64 bypass + missing OS layer) — mitigated: §15.1 canonicalization + extended denylist, TC-SSRF-MAPPED-V6-01, §15.4/runbook §10 layering. T-08-02 (spec contradictions misleading implementers) — mitigated: all three residuals removed with file-wide negative greps as acceptance; §20/§24 carry adjacent fix-cycle markers. T-08-03 (stranded limiter counter) — mitigated: Lua INCR+EXPIRE-NX pinned in §13.1. T-08-04 (manual double-sampling) — mitigated: enqueue-time advance + distinct manual jobId. T-08-05 (package installs) — accepted/N.A.: zero installs, docs-only.

## Self-Check: PASSED

- Files: `docs/ARCHITECTURE-AUDIT.md`, `docs/DEPLOY-RUNBOOK.md` (both committed, clean in git status), `.planning/phases/01-design-gate-review-verdict-ready/01-08-SUMMARY.md` — all FOUND.
- Commits: `39233d7`, `88a8a07`, `932846a` present in `git log` — all FOUND.
