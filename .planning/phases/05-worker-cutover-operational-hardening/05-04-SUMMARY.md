---
phase: 05-worker-cutover-operational-hardening
plan: 04
subsystem: docs
tags: [docs, cutover, runbook, audit-amendment, env-contract, gated-window]
requires:
  - "05-CONTEXT decisions D-01..D-46 (the ratified choreography being transcribed)"
  - "05-RESEARCH Pattern 1 (due-filter starvation, cron-logic.ts:33-46 verbatim) + Pitfalls 1/2/4/8"
  - "04-CONTEXT D-49 re-seed + D-50 GREATEST catch-up (already committed as runbook §4a step 4)"
provides:
  - "audit §20.1 GATED WINDOW procedure (D-08) — the design authority every later Phase-5 plan transcribes"
  - "runbook §4a steps 5-11 — the executable window choreography 05-06 encodes and the operator executes in 05-07/05-08 (D-38's one-story requirement)"
  - "runbook §3c worker-side memory dead-man (D-24; VPS-cron form superseded) and §9 Phase-6 death date + the GET curl emergency lever (D-38)"
  - ".env.example dated transition map (D-39/D-40): three active worker dead-man vars, commented Phase-6/7 placeholders, retirement annotations"
affects:
  - "05-02 lands the wiring that reads the three WORKER_*_HC_PING_URL vars documented here (same add-release)"
  - "05-06/05-07 transcribe §4a steps 5-8 into the rehearsal; gate-cutover.mjs emits the D-14 evidence §4a step 8 names"
  - "05-08 executes window day from §4a steps 5-9; 05-09 executes the deletion release (§4a step 10) and the D-46 reader-set-driven removals"
tech-stack:
  added: []
  patterns:
    - "dated-annotation env contract: future vars as commented placeholders carrying their arrival phase; retirements as RETIRES PHASE N notes (D-39/D-40; FND-07 names-only contract intact)"
    - "supersede-not-delete amendment style: §3c keeps the VPS-cron script under a clearly non-operative SUPERSEDED banner"
key-files:
  created: []
  modified:
    - docs/ARCHITECTURE-AUDIT.md
    - docs/DEPLOY-RUNBOOK.md
    - .env.example
    - .planning/PROJECT.md
decisions:
  - "§4a choreography appended as steps 5-11 with existing 1-4 kept verbatim as dark-launch history — an amendment blockquote marks the D-07 add-release → env-flip window → deletion-release arc"
  - "D-19 queue-age bound pinned at 120 s in §4a step 7 and framed as the documented worst-case check latency (WRK-12/J-6 number)"
  - "§3c operative procedure is provision-check-only (Period 1 min, Grace 30 min per D-25); the historical script steps are retained under a do-not-install banner"
  - "both cron routes verified GET-only (route source) before documenting the curl lever — an initially drafted POST form would 405"
metrics:
  duration: "~8 min (494s)"
  completed: 2026-09-15
status: complete
---

# Phase 05 Plan 04: Add-Release Doc Wave — Audit §M4 + Runbook §3c/§4a/§9 + Env Transition Map Summary

**One-liner:** The cutover story is now written once, in one place: audit §20.1 carries the four-mechanism GATED WINDOW safety argument (due-filter starvation carried in full, original ordering kept binding for ungated overlap), runbook §4a steps 5-11 are the executable choreography (re-seed → unpause → live abort drill → 4-6h window → 7-gate script → blocking operator approval → scheduler-only deletion with the Windows curl-flush and old-check pause), §3c/§9/§5 are amended to the D-24/D-38 forms, and `.env.example` shows every future variable with its date.

## What Was Built

### Task 1 — Audit §M4 amendment: the GATED WINDOW procedure (commit f5b7b74)

- `docs/ARCHITECTURE-AUDIT.md` §20 gains `### 20.1 M4 amendment — the GATED WINDOW procedure` (appended inside §20; zero section renumbering per the 01-03 decision) plus an italic amendment note under the §20 header and an inline note on the M4 table row itself (the M2 precedent).
- All four named mechanisms, argument carried not concluded: (1) **due-filter starvation bounds write overlap to the takeover minute** — worker claims via `next_check_at` (§14.3 GREATEST advance), both write tiers advance `last_checked` (§16.1 conditional UPDATE; §16.2 `GREATEST(last_checked, staged)` per TC-MONOTONIC-01), cron's due-filter re-reads `lastChecked + interval` every pass (`cron-logic.ts:33-46` cited) so cron self-suppresses within one interval — no coordination, no disable step — and the same mechanism reversed is why the abort restores zero-gap cron; (2) **idempotent/guarded write paths** (additive Tier-2 flush + write_guards/RENAMENX staging; unique-index-serialized Tier-1 per TC-DUP-INCIDENT-01), with the honest statement that the legacy batcher's unguarded read-modify-write counters are the surviving M4 hazard; (3) **typed detection** — pings-vs-counters reconciliation (05-CONTEXT D-02), alert-parity counts with D-48 bytes, and the D-37 dry-run recompute with its blind spot explained (clobbered counters carry self-consistent `uptime_percent`); (4) the **pre-committed re-pause abort rule** (05-CONTEXT D-06).
- The original M4 disable-before-first-flush ordering is stated binding for **UNGATED overlap** in both the table row and the opening paragraph (threat T-05-04-03 mitigated); the trailing note cites the CR-02 lineage (01-VERIFICATION design-debt register) in the audit's amendment style.
- The section defers execution steps to runbook §4a (gates D-13/D-17, approval D-18, scheduler-only deletion D-03/D-38) — design authority only.

### Task 2 — Runbook amendments: §4a choreography, §3c memory form, §9 emergency lever (commit a16759c)

- **§4a**: an AMENDED blockquote frames the D-07 release arc (add-release soaks scheduler-off; the window is a pure env flip); steps 5-11 appended after the untouched steps 1-4 (dark-launch history + the D-49 re-seed, whose UPDATE stays verbatim and is referenced as mandatory immediately before unpause):
  - **step 5 unpause** — flag `true` + worker RESTART (boot-read flag, Pitfall 4), `readyz` + the `recurring scheduling ACTIVE` boot-log line as verification, three real hc.io checks provisioned per D-37 with their env vars, expected immediate relay/flush activity from the four simultaneously-activating schedulers;
  - **step 6 live abort drill (D-35)** — 10-15 min, re-pause, cron auto-resume zero-gap proof, unpause into the fresh window, kept under the heartbeat grace or with the check paused;
  - **step 7 window (D-12/D-16)** — 4-6 h dense, induced parity (D-11), manual maintenance enqueue (WRK-13), interruption restarts the clock, D-19's 120 s age bound + depth-0 drain (the WRK-12 number);
  - **step 8 gate evaluation (D-14)** — `node scripts/gate-cutover.mjs`, the 7 gates enumerated with D-17 flips evidence and BOTH counter gates (D-02 + D-37), evidence block into `05-DEPLOY-RECORD.md`, and the explicit statement that duplicate-alert suppression machinery is NOT built (D-05 verify + gate + disposition — prohibition 3);
  - **step 9 blocking operator approval (D-18)** — recorded with date + verdict;
  - **step 10 scheduler-only deletion release (D-03)** — deletes exactly `instrumentation.ts` + `CRON_MODE` (+ node-cron dep), engine/routes survive dormant as §9's lever, Windows `curl /api/cron/check` (Bearer, GET — both routes export GET only) immediately BEFORE stopping web timed just after a 15-min flush boundary (D-43/Pitfall 1), and the typed old-cron-check pause step (D-21);
  - **step 11 standing state** — `WORKER_SCHEDULER_ENABLED` as THE permanent emergency/maintenance pause (never `queue.pause`, D-09), the D-25 grace table (10/5/30 min → pages within ~11/~6/~36 min), and the D-20 tuning rule (constants stand absent concrete window evidence).
  - Step 3 amended to point forward at steps 5-10; no cross-reference to any deleted section.
- **§3c (D-24)**: retitled and rebuilt — the operative procedure is now *provision the dedicated check (Period 1 min, Grace 30 min) and set `WORKER_MEMORY_HC_PING_URL`; the worker does the rest* (tick reads INFO, pings only under 70%, 2 pings/min under the cap). The stale "OBS-03 Prometheus export supersedes this" claim is corrected to D-24's worker-side dead-man; the 03-UAT item-(b) forward-tracked debt is retired. The historical VPS-cron script + its steps are retained verbatim under a "SUPERSEDED … NO step in this block is operative" banner (amended, not deleted), and the retained script's internal comment now names D-24.
- **§9 (D-38)**: retirement of the endpoints + `CRON_SECRET` moved to a **Phase 6 death date** (API-01/SEC-06), with the amendment note quoting the superseded "Phase 5 overlap-verified cutover" phrasing (one story across REQUIREMENTS/CONTEXT/runbook). New **emergency lever** paragraph: the two GET routes named (`/api/cron/check` runs a pass and flushes the batcher in-request; `/api/cron/cleanup` the retention pass), the Bearer curl form documented, Bearer preferred, and `?secret=` kept as the pinned Phase-6 S-4 red/green marker (02-05 contract tests).
- **§5**: the heartbeat-fires-from-the-tick sentence annotated — the wiring lands with the Phase-5 add-release; from window-open the tick pings the NEW dedicated check behind `WORKER_HC_PING_URL` (D-21/D-22).

### Task 3 — .env.example transition map + PROJECT.md residuals (commit 509f5e4)

- `.env.example` gains the three active worker dead-man variables — `WORKER_HC_PING_URL`, `WORKER_OUTBOX_HC_PING_URL`, `WORKER_MEMORY_HC_PING_URL` — uncommented with empty defaults and optional-read wording (ping skipped when unset; at most one ping per check per tick; wired by 05-02 in this same add-release, live at window-open). This is the one sanctioned exception to "uncommented = read today": the add-release artifact reads them (D-07 one-release rule).
- Commented arrival-phase placeholders per D-39: `# EMAIL_PROVIDER=smtp  # goes live Phase 6 (EML-01)` and `# BETTER_AUTH_SECRET=  # goes live Phase 7 (AUTH-01)` — each on a comment-prefixed line with its phase (prohibition 1's grep form).
- Dated retirements per D-40: `CRON_SECRET` annotated RETIRES PHASE 6 (SEC-06, with the emergency-lever note); `NEXTAUTH_SECRET`/`NEXTAUTH_URL` annotated RETIRES PHASE 7 (AUTH-07). `REDIS_URL` untouched; **nothing removed** (diff is 36 insertions, 0 deletions — removals are the deletion release's reader-set-driven step per D-46).
- `.planning/PROJECT.md` Context gains the residual-live-legs bullet: EMAIL_PROVIDER Phase 6; BETTER_AUTH_* live + NEXTAUTH_* retirement Phase 7; CRON_SECRET Phase 6; CRON_MODE at the deletion release (D-40).

## Deviations from Plan

None — the plan executed exactly as written. One accuracy-driven wording correction during drafting (not a plan deviation): the §4a step-10 curl was initially drafted as POST, then corrected to GET after reading both cron route sources (`src/app/api/cron/{check,cleanup}/route.ts` export GET only — a POST would 405). Recorded as a decision above.

## Verification Evidence

- Plan verify commands, run after each task:
  - `grep -c "GATED WINDOW" docs/ARCHITECTURE-AUDIT.md` → **4**; `grep -c "takeover minute"` → **1** (both were 0 before this plan)
  - `grep -c "emergency lever" docs/DEPLOY-RUNBOOK.md` → **4**; `grep -c "death date"` → **1** (both were 0 before)
  - `grep -c "WORKER_HC_PING_URL" .env.example` → **1** (was 0)
- Prohibition greps: `EMAIL_PROVIDER`/`BETTER_AUTH_SECRET` appear only on comment-prefixed lines with arrival-phase annotations (lines 29, 63); §9 retains the route inventory + the Phase-6 death-date sentence and nowhere claims Phase 5 deletes routes or `CRON_SECRET` (repo-wide grep: the only "Phase 5 overlap-verified cutover" match is inside §9's amendment note quoting the superseded text); §4a step 8 describes the alert-parity gate, not suppression.
- Section numbering: audit headings remain `## 20` → `### 20.1` → `## 21` (verified by heading grep — nothing renumbered); runbook keeps its §3c/§4/§4a/§5/§9 structure with §4a's existing step style extended 1-11.
- The D-49 UPDATE remains verbatim in §4a step 4 (grep-verified, including the `WHERE "isActive";` terminator).
- `git diff --stat` for Task 3: `.env.example` +36/-0 — additions only, nothing removed.

## Requirement Status

`DEP-05` and `WRK-11` (plan frontmatter) deliberately stay **Pending**: this plan is the add-release doc wave only — DEP-05 completes at phase end when the deletion release actually executes the dated paths (D-40's own language), and WRK-11 completes at the 05-08 overlap window (05-01's identical rationale; 02-03/03-02 false-signal precedent).

## Key Learnings

- Verify HTTP verbs against route sources before writing operator curl commands into a runbook — the check/cleanup routes are GET-only, and a documented POST lever would have been the first thing an operator hit during an emergency.
- The "amend, never delete" doc discipline composes well with supersession banners: §3c's operative procedure is now three steps while the historical five-step script block stays greppable for the record — no reader can mistake which block to execute.
- Anonymizing decision-ID collisions up front ("05-CONTEXT D-02" vs the audit's own review-addenda D-2) keeps cross-document citations unambiguous in the amended audit text.

## Self-Check: PASSED

- Files: docs/ARCHITECTURE-AUDIT.md, docs/DEPLOY-RUNBOOK.md, .env.example, .planning/PROJECT.md — all present, all modified in place (no new files, no deletions)
- Commits: f5b7b74 (Task 1), a16759c (Task 2), 509f5e4 (Task 3) — all in `git log`
- No tracked-file deletions in any task commit; no untracked artifacts left behind by this plan
