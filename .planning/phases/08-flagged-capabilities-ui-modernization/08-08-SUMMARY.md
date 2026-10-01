---
phase: 08-flagged-capabilities-ui-modernization
plan: 08
subsystem: infra
tags: [release-choreography, deploy-runbook, soak-window, ai-flag, dark-launch, pg_dump, rollback, windowed-uptime]
requires:
  - phase: 08-flagged-capabilities-ui-modernization
    provides: all Phase-8 plan deliverables completed on the live stack (08-01 windowed backend + migration 0004, 08-04/05/09 redesign + token substrate, 08-06/07/10 AI provider layer/routes/UX); Phase-7 runbook §4 release forms
provides:
  - Runbook §4f Phase-8 release section — three release tags, per-release deploy steps, AI flip procedure, per-step rollbacks (env-first AI rollback), D-37 soak requirements
  - Three executed releases with machine evidence in 08-DEPLOY-RECORD.md — dated pg_dump backups, single-runner migrates, readyz-gated restarts with tag-provenance healthz shas, synthetic smokes, nightly-recompute DB proof, soak windows per D-37
  - Git tags release-a (a569536), release-b (9372b26), release-c (3372424)
  - D-38 AI flip disposition — STAY-DARK at the AI-01 requirement default; ON-leg live smoke deferred OPEN with the full ~2-minute flip mechanics documented
affects: [verify-work/UAT (Phase 8 close), PROD-01 (v2 windowed display switch), Phase-999.1 backlog (AI ON-leg live smoke), future release choreography (the §4f form)]
actuals:
  tokens: 13000
  tasks: 5
  commits: 5
  plan_head_before: 337242443a75bd7caade9ac9fe1d4e99ed927f72
  plan_head_after: ea9e496
tech-stack:
  added: []
  patterns: [three-release soak choreography with tag-provenance healthz sha, stay-dark disposition for an unanswered blocking gate (requirement-default posture + tracked OPEN follow-up)]
key-files:
  created:
    - .planning/phases/08-flagged-capabilities-ui-modernization/08-DEPLOY-RECORD.md
  modified:
    - docs/DEPLOY-RUNBOOK.md
    - .planning/phases/08-flagged-capabilities-ui-modernization/deferred-items.md
key-decisions:
  - "Task-3 operator gate RESOLVED proceed-b (operator mehedishubho, 2026-10-01, response verbatim 'use recommand') — Release A soak ACCEPTED; Release B (redesign + dep deletions) deployed per D-37 (record §1.7)"
  - "Task-5 AI-flip gate dispositioned STAY-DARK (orchestrator judgment under operator non-response, 2026-10-01) — the phase closes at the AI-01 requirement-default posture (AI_ENABLED unset, zero keys); the ON-leg live smoke is deferred OPEN in deferred-items.md (08-08 session); the flip remains a ~2-minute operator action (AI_PROVIDER=glm + AI_MODEL + AI_API_KEY + web restart, mechanics in record §4 + runbook §4f), reversible by AI_ENABLED=false first"
  - "§1.6 topology provenance: Release A's worker/web restart legs were satisfied by the already-live post-08-05 stack — deploying release-a's older bundles would have reverted the live 06-07 WR-01 fix and visibly downgraded user-facing surfaces for the soak window; every other leg (tag, artifact verify, backup, single-runner migrate, smoke, nightly evidence, soak, record) executed fresh; the end state after Release C is identical to plan intent (HEAD deployed, tag-proven)"
  - "§1.8 Rule-3 restoration: a Docker Desktop bounce killed the process-hosted stack (~15-min monitoring gap, 14:47-14:55Z); worker+web restored from main-tree bundles (src/worker proven byte-identical to release-b/c via git diff), then Release B's own deploy legs restored clean tag provenance (healthz sha 9372b26)"
  - "Requirements AI-01/DAT-11/UI-05 marked complete per the requirements.ready-ids verdict (all three released) — AI-01 complete-except-deferred-ON-leg with the deferral noted here and in deferred-items.md; DAT-11 and UI-05 fully live-proven"
patterns-established:
  - "D-37 soak choreography per release: pnpm verify green on the tagged artifact + a short live window (heartbeat steady, queue depth ~0, pings flowing) recorded before the next release begins; healthz sha = the release tag"
  - "Stay-dark disposition form: an unanswered blocking-human gate resolves to the requirement-default posture, records the machine-proven default leg live, tracks the non-default leg OPEN in deferred-items.md, and documents the flip mechanics for a later ~2-minute operator action"
requirements-completed: [AI-01, DAT-11, UI-05]
coverage:
  - id: D1
    description: "Runbook §4f Phase-8 release section — three release tags, per-release deploy steps, AI flip procedure, per-step rollbacks (env-first AI rollback), D-37 soak requirements"
    verification:
      - kind: other
        ref: "pnpm exec rg -c 'release-a|release-b|release-c|AI_ENABLED' docs/DEPLOY-RUNBOOK.md -> 9 hits; rg -n 'drizzle-kit push' -> zero occurrences (single-runner migrate form only); AI_ENABLED=false named as the FIRST rollback step (runbook line 576)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Release A — windowed backend live from tag release-a: 0004 applied via single runner (true no-op, journal 5 rows), recompute populated all three windows from retained ping history, lifetime counters byte-unchanged"
    requirement: DAT-11
    verification:
      - kind: other
        ref: "node record check (Release A/release-a/backup/0004/nightly all present) + 08-DEPLOY-RECORD §1.3-§1.5: recompute job log monitorsRecomputed=3, per-window values populated, T0->T1 counter deltas 0, soak window 14:01-14:22Z clean"
        status: pass
    human_judgment: false
  - id: D3
    description: "Release B — redesign live from tag release-b with the D-37 dep deletions (react-icons + sweetalert2); remnant gates green on the shipped artifact; both themes machine-verified"
    requirement: UI-05
    verification:
      - kind: e2e
        ref: "release-b artifact: pnpm test:e2e 50 passed incl. dashboard-redesign.spec.ts + light-mode.spec.ts (token-resolved computed colors + in-page WCAG contrast in forced light) — 08-DEPLOY-RECORD §2.1; soak §2.4 clean"
        status: pass
      - kind: other
        ref: "pnpm cron:remnants on the shipped tree -> green, 508 files, no Phase-8 icon/dialog remnants (dep deletions proven out)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Release B subjective visual spot-check — does the redesign look intentional in both themes on real pages"
    requirement: UI-05
    verification: []
    human_judgment: true
    rationale: "Subjective visual quality on live pages is inherently human judgment; recorded as the machine/human split per the 06-05 §12 precedent (08-DEPLOY-RECORD §2.3) — public surfaces answer 200 and the e2e suites prove tokens/contrast, but the 'looks intentional' pass is the operator's at UAT"
  - id: D5
    description: "Release C — AI dark ship from tag release-c with AI_ENABLED unset: zero AI_* env on the stack, both /api/ai/* routes 404 pre-body-read, zero AI trace on served pages, dark soak window clean"
    requirement: AI-01
    verification:
      - kind: e2e
        ref: "release-c artifact: the 2 flag-OFF zero-trace e2e legs ran green (D-21 machine-pinned) within the 52-passed/5-skipped run — 08-DEPLOY-RECORD §3.1; live probes §3.3/§3.4 (404s, zero AI_* env name-grep, dark soak 15:34-15:50Z clean)"
        status: pass
    human_judgment: false
  - id: D6
    description: "D-38 AI flip ON-leg — AI_ENABLED=true with real GLM credentials + live smoke of both AI features (streaming post-mortem, assistant prefill)"
    requirement: AI-01
    verification: []
    human_judgment: true
    rationale: "Operator-gated and operator-supplied (real GLM credentials per user_setup); dispositioned STAY-DARK 2026-10-01 under operator non-response at the Task-5 blocking gate — deferred OPEN in deferred-items.md (08-08 session) with full flip mechanics in record §4 + runbook §4f; cannot be automated by the executor"
duration: ~2h 13m elapsed (3 sessions; Tasks 1-2 session 1, Task 4 + both gates session 2, Task-5 disposition + closeout this leg)
completed: 2026-10-01
status: complete
---

# Phase 8 Plan 08: Release Choreography Summary

**Three soaked releases shipped from pinned tags (windowed backend → full redesign + dep deletions → AI dark) with the D-38 AI flip dispositioned stay-dark at the requirement-default posture — Phase 8 closes 10/10.**

## Performance

- **Duration:** ~2h 13m elapsed across 3 sessions (13:52Z → 16:10Z; this closeout leg ~20 min)
- **Started:** 2026-10-01T13:52:09Z (first task commit `a6a505e`)
- **Completed:** 2026-10-01 (final task commit `ea9e496` + closeout)
- **Tasks:** 5
- **Files modified:** 3 (+ `08-08-SUMMARY.md` created)

## Accomplishments

- Runbook §4f authored: three-release choreography (tags release-a/b/c), per-release steps in the backup → single-runner migrate → readyz-gated restart → smoke pattern, the D-38 AI flip procedure with AI_ENABLED=false as the FIRST rollback lever, and D-37 soak requirements.
- Release A (tag `release-a` @ a569536): dated pg_dump backup, single-runner migrate (true no-op — 0004 already applied), synthetic smoke PASS, nightly-recompute evidence — all three per-window columns populated from retained history on every monitor with pings, lifetime counters byte-unchanged (T0→T1 deltas 0) — then a CLEAN ~20-min soak.
- Release B (tag `release-b` @ 9372b26): full redesign live with the D-37 dep deletions (react-icons + sweetalert2), remnant gates green on the shipped artifact (456 files), both themes machine-verified (50 e2e incl. dashboard-redesign + light-mode specs), CLEAN ~21-min soak.
- Release C (tag `release-c` @ 3372424): AI dark ship with AI_ENABLED unset — zero AI_* keys on the box, both /api/ai/* routes 404 pre-body-read, zero AI trace on served pages, CLEAN ~16-min dark soak.
- Task-3 operator gate RESOLVED proceed-b (mehedishubho, "use recommand"); Task-5 AI-flip gate dispositioned STAY-DARK under operator non-response — off-leg live-proven, ON-leg deferred OPEN with the flip documented as a ~2-minute operator action.
- 08-DEPLOY-RECORD.md completed: four sections (topology/provenance, releases A/B/C with per-leg evidence, the flip disposition) — facts and hashes only, no secrets (T-08-28).

## Task Commits

Each task was committed atomically:

1. **Task 1: Runbook Phase-8 release section (§4f)** - `a6a505e` (docs)
2. **Task 2: Release A — windowed backend live + soak + nightly-recompute evidence** - `b8dc338` (feat)
3. **Task 3: Operator gate — Release A soak accepted** - RESOLVED `proceed-b` (no commit; verdict recorded in 08-DEPLOY-RECORD §1.7)
4. **Task 4: Release B (redesign + dep deletions)** - `04747b2` (feat); **Release C (AI dark ship)** - `d9603cd` (feat)
5. **Task 5: AI-flip gate stay-dark disposition (D-38 deferral)** - `ea9e496` (feat)

Tags created/executed this plan: `release-a` → a569536, `release-b` → 9372b26, `release-c` → 3372424.

**Plan metadata:** the `docs(08-08): complete release choreography plan` commit carrying this SUMMARY + STATE/ROADMAP/REQUIREMENTS updates (immediately follows `ea9e496`).

## Files Created/Modified

- `docs/DEPLOY-RUNBOOK.md` — Phase-8 §4f release section (tags, choreography, flip procedure, rollbacks, soak requirements)
- `.planning/phases/08-flagged-capabilities-ui-modernization/08-DEPLOY-RECORD.md` — created: the four-section release record (§1 Release A incl. topology provenance + interlude, §2 Release B, §3 Release C, §4 flip disposition)
- `.planning/phases/08-flagged-capabilities-ui-modernization/deferred-items.md` — 08-08 session entry: AI_ENABLED production flip tracked OPEN

## Decisions Made

See `key-decisions` in frontmatter — the three gate resolutions (proceed-b, stay-dark, §1.6 topology provenance) plus the §1.8 Rule-3 restoration and the ready-ids-based requirement markings.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1/3 — no production regression] Release A restart legs satisfied by the already-live post-08-05 stack**
- **Found during:** Task 2 (Release A deploy)
- **Issue:** The plan assumed a 07-09-era live stack; the 06-UAT re-verification had already applied 0004 and restarted both processes. Deploying release-a's worker bundle would have reverted the shipped 06-07 WR-01 fix; its pre-redesign web would have visibly downgraded surfaces for the soak window only to re-upgrade an hour later.
- **Fix:** Skipped only the two restart legs (already-live, readyz-green, superset code); every other leg executed fresh; end state after Release C identical to plan intent (HEAD deployed).
- **Files modified:** 08-DEPLOY-RECORD.md §1.6
- **Verification:** `git diff e9d557f 3372424 -- src/worker` empty (live worker = release-c code); healthz shas tag-proven at B (9372b26) and C (3372424)
- **Committed in:** `b8dc338`

**2. [Rule 3 — blocking] Stack-down interlude restored before Release B**
- **Found during:** Task 4 (between releases, 14:47-14:55Z)
- **Issue:** Docker Desktop bounce killed the process-hosted stack — zero node processes, ~15-min monitoring gap; no release artifact implicated (Release A soak had closed clean).
- **Fix:** Restored worker (readyz-green, healthz sha e2f7393) + web (/login 200) from main-tree bundles whose src/worker is byte-identical to release-b/c; Release B's own deploy legs then restored clean tag provenance.
- **Files modified:** 08-DEPLOY-RECORD.md §1.8
- **Verification:** pings resumed 14:54:22Z; Release B healthz sha 9372b26
- **Committed in:** `04747b2`

---

**Total deviations:** 2 auto-fixed (1 no-regression judgment, 1 blocking restoration) + 2 environmental (release-a worktree build needed the gitignored .env staged for page-data collection, deleted after; IN-01 EADDRINUSE 9090 pre-documented exception while the live worker runs — never stopped for a test).
**Impact on plan:** None on intent — all three releases executed with machine evidence; end state identical to the plan's target topology.

## Issues Encountered

- Operator non-response at the Task-5 blocking gate → stay-dark disposition (a recorded decision, not a failure; see key-decisions + record §4).
- The §1.8 stack-down interlude (above) — monitoring interrupted ~15 min, machine-side continuity unprovable for the gap; healthchecks.io dead-men flips are operator-dashboard-visible.
- The 2026-10-01 06-UAT session had already moved production past the plan's assumed baseline — reconciled in §1.1 and folded into the §1.6 deviation.

## User Setup Required

None consumed this plan. The plan's user_setup (AI_PROVIDER / AI_MODEL / AI_API_KEY for the flip smoke) is deliberately NOT consumed — the stay-dark disposition defers the flip. When the operator elects to flip: set the env triple on the stack env (Z.ai console for the key; model id confirmed at flip), restart web, run the runbook §4f flip smoke legs. Mechanics: 08-DEPLOY-RECORD §4 + runbook §4f.

## Next Phase Readiness

- **Phase 8 is 10/10 — ready for /gsd:verify-work.**
- PROD-01 (v2 windowed display switch) is unblocked: per-window columns are populated nightly in production (D-23/D-24 posture holds — nothing reads them in v1).
- Open follow-up: AI_ENABLED production flip (deferred-items.md, 08-08 session — status OPEN).
- Open UI sweep candidates remain in deferred-items.md (08-09 session): NavUser.tsx tokens, Navbar rose-400, Pagination dead component, app-wide emerald/rose survey.

## Self-Check: PASSED

All acceptance criteria + plan verification re-run at closeout:

- Task 1 verify: `rg -c "release-a|release-b|release-c|AI_ENABLED" docs/DEPLOY-RUNBOOK.md` → **9** (expected >0); `rg -n "drizzle-kit push"` → **zero occurrences** (single-runner migrate form only). Acceptance: all three tags, per-release steps, flip procedure, and per-step rollbacks incl. the env-first AI rollback (runbook line 576) — present.
- Task 2 verify: node record check → **OK** (Release A, release-a, backup, 0004, nightly all present). Acceptance: single-runner migrate only; lifetime counters unchanged (§1.4 T0→T1 deltas 0).
- Task 4 verify: node record check → **OK** (Release B, Release C, AI_ENABLED, dark all present); `pnpm cron:remnants` → **green, 508 files** incl. the AI-05/rule-15 worker leg. Acceptance: both releases recorded with tag/backup/smoke/soak boundaries; dark soak ran with zero AI_* env, monitoring stable.
- Task 5 acceptance: stay-dark disposition recorded in record §4 (STAY-DARK, ON-leg deferral, Phase-999.1 precedent, reversibility, state-at-close) + deferred-items.md (08-08 session, OPEN) + this SUMMARY (key-decisions, D6 coverage).
- Plan verification: both node record checks green; cron:remnants green on the shipped tree; AI-01 dark leg live-proven and the on-leg explicitly dispositioned stay-dark with a tracked follow-up.
- File/commit existence: all five task commits + three release tags verified via `git log`/`git tag` at closeout.
