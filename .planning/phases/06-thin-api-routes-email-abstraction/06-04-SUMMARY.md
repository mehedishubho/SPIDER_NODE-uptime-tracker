---
phase: 06-thin-api-routes-email-abstraction
plan: 04
subsystem: infra
tags: [bullmq, worker, retention, telegram-webhook, deploy-runbook, release-choreography, drizzle, nextjs]

# Dependency graph
requires:
  - phase: 06-03
    provides: webhook secret enforcement + SSRF admission + pinned-defect fixes that this plan's release packages
  - phase: 06-02
    provides: queue-backed email provider interface (EMAIL_PROVIDER) exercised by rehearsal leg (b)
  - phase: 06-01
    provides: enqueue-only check-now (202 + poll) exercised by rehearsal leg (a)
  - phase: 05-worker-cutover-operational-hardening
    provides: batched real-delete maintenance processor (04-07/05-06), stand-in topology, deploy-record format
provides:
  - Autonomous daily retention (scheduler dryRun:false, D-14) with D-18 deleted-count + error-level logging
  - Bounded enqueue-maintenance script (WR-01/D-15): non-zero exit in seconds on unreachable Redis, dry-run/apply flags preserved
  - Runbook §4b feature-release choreography (pre-flight → stand-in rehearsal + blocking approval → cutover with setWebhook INSIDE → D-31 soak → deletion release) + amended §9 secret hygiene
  - .env.example with TELEGRAM_WEBHOOK_SECRET and live EMAIL_PROVIDER documentation
  - 06-DEPLOY-RECORD.md: six green gates, four D-30 smoke legs with evidence, operator approval recorded, D-31 soak window OPENED
affects: [06-05, phase-7-verification, deploy-operations]

# Tech tracking
tech-stack:
  added: [] # zero new packages across the plan (phase lock T-06-04-SC)
  patterns:
    - "Bounded-rejection producer profile for operator scripts (maxRetriesPerRequest 1, connectTimeout/command timeout, non-zero exit)"
    - "Append-only deploy-record evidence sections (§n) closed by an approval section + soak-window record"

key-files:
  created:
    - tests/worker/enqueue-maintenance-script.test.ts
    - .planning/phases/06-thin-api-routes-email-abstraction/06-DEPLOY-RECORD.md
    - .planning/phases/06-thin-api-routes-email-abstraction/06-04-SUMMARY.md
  modified:
    - src/worker/scheduler.ts
    - src/worker/maintenance.ts
    - scripts/enqueue-maintenance.mjs
    - tests/worker/scheduler-flag.test.ts
    - tests/worker/maintenance.test.ts
    - docs/DEPLOY-RUNBOOK.md
    - .env.example
    - tests/api/monitors.create.spec.ts (e2e fixture admission-contract fix, 31a56df)
    - .planning/phases/06-thin-api-routes-email-abstraction/deferred-items.md

key-decisions:
  - "Scheduler daily maintenance template hardcoded dryRun:false; the manual script keeps explicit --apply — autonomous retention and operator drills no longer share a default (D-14)"
  - "Leg (d) retention proof pivoted to the script-sanctioned TEST stack after the permission system denied the --allow-prod invocation; same release bundle, evidence recorded, monitor-3 stand-in seed left for the 03:15 UTC autonomous pass"
  - "Operator approval recorded from the bare 'approved' reply under the 05-08 D-18 precedent; A3 + Vercel-cron residuals verified repo-side (no contradicting evidence) and routed to 06-05 Task 1's user_setup/checkpoint"
  - "setWebhook with the production secret remains 06-05 Task 1 by plan (operator-provided value; not executable from the loopback topology) — the approval-continuation records cutover state instead of re-deploying live bytes"
  - "D-31 soak window OPENED 2026-09-20T20:00Z on release 31a56df (live since 19:28:22Z); gate enforcement delegated to the 06-05 Task 1 blocking checkpoint — this plan does not block on the clock"

patterns-established:
  - "Feature-release evidence pack: gates → same-SHA provenance → per-leg smoke evidence → approval → soak record, all in one deploy record"
  - "Repo-side verifiable-then-route-residual pattern for partially-answered operator checkpoints"

requirements-completed: [API-01, API-02, SEC-03, EML-02]

coverage:
  - id: D1
    description: "Daily maintenance scheduler runs real deletes (dryRun:false) with deleted-count logging and error-level failure logging (D-14/D-18)"
    requirement: API-01
    verification:
      - kind: unit
        ref: "tests/worker/scheduler-flag.test.ts#daily maintenance template dryRun:false pin"
        status: pass
      - kind: unit
        ref: "tests/worker/maintenance.test.ts#real pass count logging + error-level failure"
        status: pass
    human_judgment: false
  - id: D2
    description: "enqueue-maintenance.mjs exits non-zero within a bounded deadline on unreachable Redis; dry-run/apply flags preserved (WR-01/D-15)"
    requirement: API-02
    verification:
      - kind: unit
        ref: "tests/worker/enqueue-maintenance-script.test.ts#unreachable Redis bounded non-zero exit"
        status: pass
    human_judgment: false
  - id: D3
    description: "Runbook §4b feature-release choreography (four smoke legs, setWebhook inside the cutover, D-31 soak list) + §9 secret hygiene + .env.example TELEGRAM_WEBHOOK_SECRET / EMAIL_PROVIDER entries"
    requirement: SEC-03
    verification:
      - kind: other
        ref: "pnpm exec rg -n \"4b. Phase-6 feature release|setWebhook|TELEGRAM_WEBHOOK_SECRET|EMAIL_PROVIDER\" docs/DEPLOY-RUNBOOK.md .env.example"
        status: pass
    human_judgment: false
  - id: D4
    description: "Stand-in feature-release rehearsal: six green gates, four D-30 smoke legs with concrete evidence, same-SHA provenance, steady posture"
    requirement: EML-02
    verification:
      - kind: manual_procedural
        ref: ".planning/phases/06-thin-api-routes-email-abstraction/06-DEPLOY-RECORD.md §2–§6 (legs a/b1/b2/c/d)"
        status: pass
    human_judgment: true
    rationale: "Rehearsal legs are live-stack observations (SMTP fail-then-recover timing, webhook ladder, real-delete counts) recorded as evidence prose, not automatable assertions in this repo"
  - id: D5
    description: "Blocking operator approval of the production feature release recorded + D-31 soak window opened on release 31a56df"
    verification:
      - kind: manual_procedural
        ref: ".planning/phases/06-thin-api-routes-email-abstraction/06-DEPLOY-RECORD.md §8–§10"
        status: pass
    human_judgment: true
    rationale: "Operator sign-off is inherently a human decision; soak-gate enforcement belongs to the 06-05 Task 1 blocking checkpoint by plan"

# Metrics
duration: ~30min (approval-continuation leg; rehearsal leg was the prior session, 19:07Z–20:00Z)
completed: 2026-09-20
status: complete
---

# Phase 6 Plan 4: Worker Hardening + Runbook + Stand-In Feature-Release Rehearsal Summary

**Autonomous retention restored (dryRun:false + count logging), WR-01 bounded maintenance script, runbook §4b release choreography, four-leg stand-in rehearsal green, operator approval recorded, and the D-31 soak window opened on release `31a56df`.**

## Performance

- **Duration:** ~30 min (approval-continuation leg; Task 1–3 rehearsal executed in the prior session — rehearsal-day leg 19:07Z–20:00Z per the deploy record)
- **Started:** 2026-09-20T19:44Z (continuation resume; rehearsal leg resumed 19:07:56Z)
- **Completed:** 2026-09-20T20:10Z
- **Tasks:** 3 (Task 3 closed via operator approval continuation)
- **Files modified:** 12

## Accomplishments
- Retention autonomy restored: the daily 03:15 UTC `maintenance-cleanup` scheduler now carries `dryRun:false` (legacy daily-cleanup parity, WR-03 closure) and real passes log deleted-row counts with error-level failure logs (D-18) — verified live in rehearsal leg (d) with exact 40-ping + 1-incident deletes.
- `scripts/enqueue-maintenance.mjs` fails loud and bounded on unreachable Redis (non-zero exit in seconds, test-enforced) while keeping explicit `--apply` operator intent (WR-01/D-15/D-14).
- Runbook §4b pins the Phase-6 release choreography — pre-flight gates, four D-30 stand-in smoke legs, `setWebhook` INSIDE the production cutover (Pitfall 5), D-31 soak criteria, §7 rollback form — and §9 carries the S-4 retirement path + webhook-secret rotation note; `.env.example` documents `TELEGRAM_WEBHOOK_SECRET` and a live `EMAIL_PROVIDER` line.
- Stand-in rehearsal executed and evidenced in `06-DEPLOY-RECORD.md` (six gates green incl. full `pnpm verify` + resilience 7/7 + e2e 18/18; same-SHA provenance; all four legs with concrete outcomes incl. the D-09 30-second first-retry proof).
- Operator approval recorded (§8, verdict APPROVED) with A3/Vercel dispositions; §4b cutover state mapped on the executing topology (§9); D-31 soak window OPENED on release `31a56df` (§10).

## Task Commits

Each task was committed atomically:

1. **Task 1: Retention autonomy (D-14/D-18) + WR-01 bounded enqueue script (TDD)**
   - `8ebf67f` (test: RED — failing pins for dryRun:false, count/error logging, bounded script exit)
   - `d2d2b5f` (feat: GREEN — scheduler flip, D-18 logging, bounded producer profile)
2. **Task 2: Runbook §4b + env documentation** - `ccc8afd` (docs)
3. **Task 3: Stand-in feature-release rehearsal + operator approval**
   - `31a56df` (test: e2e fixture aligned with the 06-03 DNS admission contract — Rule 3 test-only fix, release SHA)
   - `06881d9` (docs: rehearsal deploy record + deferred items)
   - `37ed2b0` (docs: approval recorded + §4b cutover state + D-31 soak window open — this continuation)

**Plan metadata:** committed with the final docs commit (see below)

_Note: Task 1 followed the TDD flow (test commit → feat commit)._

## Files Created/Modified
- `src/worker/scheduler.ts` - daily maintenance template `dryRun:false`, stale comment removed (D-14)
- `src/worker/maintenance.ts` - real-pass structured count logging + error-level failure logs (D-18)
- `scripts/enqueue-maintenance.mjs` - bounded-rejection producer profile, non-zero exit, flags preserved (WR-01/D-15)
- `tests/worker/enqueue-maintenance-script.test.ts` - created: bounded-exit harness vs unreachable Redis
- `tests/worker/scheduler-flag.test.ts`, `tests/worker/maintenance.test.ts` - extended pins
- `docs/DEPLOY-RUNBOOK.md` - §4b choreography + §9 secret-hygiene amendments
- `.env.example` - `TELEGRAM_WEBHOOK_SECRET` + live `EMAIL_PROVIDER` documentation
- `tests/api/monitors.create.spec.ts` - e2e fixture fix (resolvable host per the 06-03 admission contract)
- `.planning/phases/06-thin-api-routes-email-abstraction/06-DEPLOY-RECORD.md` - created: full evidence pack (§1–§10)
- `.planning/phases/06-thin-api-routes-email-abstraction/deferred-items.md` - rehearsal findings + open confirmations for 06-05

## Decisions Made
- Scheduler template hardcoded to real deletes while the manual script keeps dry-run default — autonomous retention and operator drills no longer share a default (D-14, prohibition resolved).
- Leg (d) pivoted to the script-sanctioned TEST stack (same release bundle) after the permission system denied the `--allow-prod` invocation; the denial is recorded, not worked around; the stand-in monitor-3 seed was left for the 03:15 UTC autonomous pass as operator-visible D-14 soak evidence.
- Approval continuation: the operator's bare "approved" closes the release approval under the 05-08 precedent; A3 and Vercel-cron residuals were verified to repo-side depth (no contradicting evidence: no production setWebhook record; `vercel.json` removed 2026-08-06 in `56b2155`, no `.vercel/`) and routed to 06-05 Task 1's user_setup + blocking checkpoint.
- No redeploy for the approval — the approved release already is the live bytes on the stand-in-production topology (posture re-verified 19:58:56Z: readyz green, web 200); `setWebhook` with the operator-provided production secret remains 06-05 Task 1 by plan (loopback URL unreachable by Telegram; no real bot token on the worker by design).
- D-31 soak window opened without blocking: soak-open 2026-09-20T20:00Z, release `31a56df`, live-since 19:28:22Z; gate enforcement delegated to 06-05 Task 1's blocking checkpoint.

## Deviations from Plan

### Auto-fixed Issues (Tasks 1–3, prior session — full detail in 06-DEPLOY-RECORD.md §2/§6)

**1. [Rule 3, test-only] e2e create-monitor fixture vs 06-03 DNS admission**
- **Found during:** Task 3 (pre-flight e2e run 1: 16/18)
- **Issue:** stale NXDOMAIN fixture (`created.test.example.com`) predating 06-03's deliberate fail-closed DNS admission
- **Fix:** fixture uses a resolvable host; admission code untouched; suite 18/18
- **Committed in:** `31a56df` (became the release SHA)

**2. [Rule 3] Build-time NEXT_PUBLIC override (machine-local `.env` drift)**
- **Found during:** Task 3 (pre-flight `pnpm verify` build leg)
- **Issue:** local `.env` lost `NEXT_PUBLIC_BASE_URL`/`NEXT_PUBLIC_DEV_BASE_URL`; `baseApi.ts` throws at module load
- **Fix:** shell-only override during the rehearsal build; no repo change; operator follow-up in deferred-items (item 4)

**3. [Rule 3] Stand-in stack down at rehearsal start (host reboot, ~21 h gap)**
- **Found during:** Task 3 (resume at 19:07:56Z)
- **Fix:** DB + Redis restarted, data verified intact, dead-man paging acknowledged as expected D-switch behavior

**4. [Rule 3] Leg (d) stack pivot after permission denial**
- **Found during:** Task 3 (retention leg)
- **Fix:** executed on the TEST stack with the same `31a56df` bundle; denial recorded for the operator

---

**Total deviations:** 4 auto-fixed (all Rule 3 blocking/test-only; no Rule 1/2/4) + 1 planned-form worker swap (leg b2) + 1 documented product observation (UP→UP manual check leaves `lastChecked`, DAT-04 — deferred item 5)
**Impact on plan:** All deviations were environment/infrastructure repairs or test-only fixes; the release code path followed the plan exactly. No scope creep; zero new packages; zero migrations (phase lock verified: `git diff d55cad5..HEAD -- drizzle/` empty).

## Issues Encountered
- Queue-producer latent (pre-existing 06-01 shape): a never-connectable Redis can hang the check-now pre-flight instead of the designed 503 — unreproducible safely in rehearsal; deferred with a candidate fix (deferred-items item 3).
- Two operator confirmations (A3 answer, Vercel-cron dashboard) were not restated in the bare approval; verified repo-side with no contradiction and pinned for 06-05 Task 1 (deferred-items entry + deploy record §8).

## User Setup Required

No USER-SETUP.md generated for this plan. Operator actions riding forward:
- **06-05 Task 1 (its frontmatter `user_setup`):** provide the production `TELEGRAM_WEBHOOK_SECRET` (charset `[A-Za-z0-9_-]`, 1–256 chars) for the cutover mint + `setWebhook`; answer the Vercel-cron dashboard confirmation before the deletion release.
- **Deferred-items operator actions:** restore `NEXT_PUBLIC_*` entries in the machine-local `.env`; optional leg (d) re-run against the stand-in (`:6391`) via the `--allow-prod` form.

## Next Phase Readiness
- **06-05 is unblocked:** the approved release is live on the stand-in-production topology, the D-31 soak window is open with pending evidence identified (03:15 UTC retention pass over the monitor-3 seed, real-user check-now, real registration delivery), and 06-05 Task 1's blocking checkpoint owns soak enforcement, the production secret mint + `setWebhook`, then the deletion release (Task 2) and its deploy closeout (Task 3).
- **Concerns carried:** queue-producer latent hang (deferred), vitest forks-pool flake (pre-existing), machine-local `.env` rot (operator action).

## Self-Check: PASSED

- All 7 claimed key-files exist on disk (verified).
- All 6 task/continuation commits exist on `main`: `8ebf67f`, `d2d2b5f`, `ccc8afd`, `31a56df`, `06881d9`, `37ed2b0`.
- Zero-migration phase lock re-verified at close: `git diff d55cad5..HEAD -- drizzle/` is empty.

---
*Phase: 06-thin-api-routes-email-abstraction*
*Completed: 2026-09-20*
