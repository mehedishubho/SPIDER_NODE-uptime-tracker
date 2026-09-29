---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 11
subsystem: testing
tags: [remnant-gate, verify-chain, deletion-release, wr-04, gap-closure, file-name-trip, exemptions, vitest]

# Dependency graph
requires:
  - phase: 07 (07-08/07-09)
    provides: the armed Phase-7 remnant gate (PHASE7_ENFORCED=true) whose scope hole this plan closes, and the deleted-module basename sets it extends
  - phase: 07 (07-10)
    provides: the all-routes-on-the-iso()-seam state this plan's verify legs run against (wave-2 ordering)
provides:
  - scripts/check-cron-remnants.mjs default perimeter covers scripts/ — a re-created send-relogin-blast-named file (or any deleted-module-named code file under any scanned root) trips BY FILE NAME with zero imports
  - Deleted-module FILE-NAME check over BOTH basename sets (Phase-5 set plain / Phase-7 set phase7-marked, mirroring specifier severity discipline)
  - Three exact-filename retired-token exemptions with written rationale + scope pin (renamed copies still trip); token counting ONLY — imports/file names/route paths/deps still apply to all three
  - Real-repo scripts/ root permanently green under the extended armed perimeter (38 new code files inside the gate)
affects: [any future deletion release relying on the armed gate (08+), pnpm verify cron:remnants leg consumers]

# Actuals (#2632) — pairs with the plan's estimate to calibrate future estimates.
actuals:
  tokens: 4000     # chars/4 over the realized diff (15,983 diff chars), vs estimate 40k
  tasks: 3
  commits: 2       # MEASURED: git rev-list --count 133f94c..HEAD (production commits; docs commits follow)

# Tech tracking
tech-stack:
  added: []
  patterns: [exact-filename exemption sets with rename-trip scope pins, file-NAME-class remnant detection (basename-minus-extension over union of deleted-module sets), RED-originated real-repo pins (the in-tree tripping target becomes the green proof)]

key-files:
  created: []
  modified:
    - scripts/check-cron-remnants.mjs
    - tests/worker/cron-remnant-gate.test.ts

key-decisions:
  - "The exemption set covers TOKEN COUNTING only — both the CRON_MODE count and the RETIRED_ENV_TOKENS loop — because the plan's must-have truth enumerates the still-applied checks as imports/file names/deps/route paths and the default run cannot green otherwise (the gate body itself quotes CRON_MODE x7 as its own definitions; the self-scan paradox is explicit in the plan). Keyed by basename WITH extension so a renamed copy of exempt content trips (pin 5h)"
  - "File-name findings use distinct wording ('file NAME matches a deleted… module') vs the specifier messages ('imports a deleted… module') so the pins assert WHICH check fired — the plan's pin-assertability requirement"
  - "DEFAULT_ROOTS gains scripts/ unconditionally (plain push, an executable root always present in this repo) rather than an existsSync-guarded optional root — fail-loud if run from a cwd without it, per the plan's 'unconditionally' wording"
  - "Pin 5i targets the REAL repo scripts/ dir as its explicit argument: pre-implementation it tripped non-zero on the in-tree historical tools (the captured RED), post-implementation it is the permanent proof that the in-tree tooling stays green only behind the exact-name exemptions"

patterns-established:
  - "Exemption-scope proof shape: prove the exemption cannot be widened by rename (5h), the real-repo target that MOTIVATED the exemptions scans green (5i), and the exempt checks are enumerated in a header contract (token counting only)"

requirements-completed: [AUTH-07, DRZ-07]  # both were ALREADY [x] in REQUIREMENTS.md (07-08 closed AUTH-07; 07-10 closed DRZ-07 via the shared-ID gate) — this plan's ready-ids check returned them ready, marking was a verified no-op

coverage:
  - id: D1
    description: "The armed remnant gate's default scan covers scripts/ — pnpm cron:remnants runs the extended DEFAULT_ROOTS and its green line lists the scripts root (466 files, up from 426-428 pre-extension = the +38 scripts/ code files)"
    requirement: AUTH-07
    verification:
      - kind: other
        ref: "pnpm cron:remnants — '[cron-remnants] green — 466 code file(s) scanned across src, scripts, dist\\worker.js, .next\\server, playwright.config.ts, next.config.ts, ecosystem.config.js (+ package.json)'"
        status: pass
      - kind: unit
        ref: "tests/worker/cron-remnant-gate.test.ts#5i — the REAL repo scripts/ root as explicit target exits 0 green and the green line reports the scripts root"
        status: pass
    human_judgment: false
  - id: D2
    description: "Deleted-module FILE-NAME check: a clean-content code file whose basename-minus-extension matches a deleted module basename trips — Phase-5 set as plain always-enforced findings (db-batcher), Phase-7 set phase7-marked (send-relogin-blast), zero imports required"
    requirement: DRZ-07
    verification:
      - kind: unit
        ref: "tests/worker/cron-remnant-gate.test.ts#5f — send-relogin-blast.mjs fixture with ONLY clean code trips non-zero, output names the file and the FILE-NAME check class"
        status: pass
      - kind: unit
        ref: "tests/worker/cron-remnant-gate.test.ts#5g — db-batcher.ts fixture with clean content trips non-zero naming the FILE-NAME check class"
        status: pass
    human_judgment: false
  - id: D3
    description: "Three exact-filename retired-token exemptions (check-cron-remnants.mjs / rehearse-cutover.mjs / auth-soak-gate.mjs) hold on token counting ONLY, each with a written rationale; a renamed copy of exempt content still trips; the real-repo scripts root is green"
    requirement: DRZ-07
    verification:
      - kind: unit
        ref: "tests/worker/cron-remnant-gate.test.ts#5h — a RENAMED copy of the soak gate's window-read line trips non-zero (exemptions bind to exact file names, never content shapes)"
        status: pass
      - kind: unit
        ref: "tests/worker/cron-remnant-gate.test.ts#5i — real-repo scripts/ scan green (the three in-tree tools are exactly exempted)"
        status: pass
    human_judgment: false
  - id: D4
    description: "No pre-existing pin regressed: the whole gate suite (10 prior pins + 4 new) is green; the specifier, dependency, route-path, and instrumentation checks still apply to all three exempt files (the exemption consults only scanCodeFile's two token counters by construction; pin 1's violating-fixture sweep still lists every class)"
    requirement: DRZ-07
    verification:
      - kind: unit
        ref: "pnpm exec vitest run tests/worker/cron-remnant-gate.test.ts — 14 passed (14), including pin 1's every-class sweep and pin 5's real-src sweep"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full verify chain green modulo the single documented environmental exception (health.test.ts EADDRINUSE-:9090 — the production worker holds the port by design); every leg individually proven green; cron:remnants is the armed extended-perimeter leg"
    requirement: DRZ-07
    verification:
      - kind: other
        ref: "pnpm test leg — 411 passed / 2 skipped / 1 documented environmental fail; pnpm schema:gate (empty diff), pnpm worker:boundary (19 files), pnpm denylist:diff (11 CIDR tokens), pnpm build (Compiled successfully, dist/worker.js 140.53 KB), pnpm cron:remnants (466 files, scripts in roots), pnpm test:e2e (18/18) — all individually green"
        status: pass
    human_judgment: false

# Metrics
duration: 14 min
completed: 2026-09-29
status: complete
---

# Phase 07 Plan 11: Armed Remnant Gate scripts/ Perimeter (WR-04 Gap Closure) Summary

**Extended the armed remnant gate's default perimeter to scripts/ so a re-created D-05 blast script trips BY FILE NAME with zero imports, with the three in-tree historical tools exempted narrowly (exact filenames, token counting only) and pinned by RED-originated fixtures — verify green at 466 scanned files.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-09-29T20:45:12Z
- **Completed:** 2026-09-29T20:59:30Z
- **Tasks:** 3
- **Files modified:** 2 (gate script + gate suite)

## Accomplishments
- WR-04 closed: `DEFAULT_ROOTS` now includes `scripts/` unconditionally — the executable-tooling root where the deleted D-05 `send-relogin-blast.mjs` actually lived. A re-created blast script (or any `scripts/*.mjs` remnant) can no longer produce zero findings; the armed gate no longer has a hole exactly where one of its named remnants resided.
- New deleted-module FILE-NAME check (header item 12): every walked code file whose basename-minus-extension matches `DELETED_MODULE_BASENAMES` lands a plain always-enforced finding, `PHASE7_DELETED_MODULE_BASENAMES` lands phase7-marked — mirroring the specifier checks' severity discipline, with distinct "file NAME matches" wording so pins assert which check fired.
- Three exact-filename retired-token exemptions, token counting ONLY, each with a written rationale in the gate header: `check-cron-remnants.mjs` (self-scan paradox — its body quotes every retired token as its own definitions), `rehearse-cutover.mjs` (its throwaway CRON_SECRET/CRON_MODE lever IS the retired pre-06-05 interface the rehearsal exists to exercise), `auth-soak-gate.mjs` (its recorded §14 soak window leg reads the retired AUTH_NOTICE_* envs). Imports, file names, route paths, and dependency checks still apply to all three; pin 5h proves a renamed copy of exempt content trips.
- RED→GREEN discipline held: pins 5f/5g/5i were captured RED against the unextended gate (5f/5g exit 0 — no file-name check; 5i exit 1 — the in-tree rehearsal tool + gate body tripped the token counts) before any gate change; all 14 pins green after.

## Captured RED (Task 1 evidence)

`pnpm exec vitest run tests/worker/cron-remnant-gate.test.ts` at `652ddd0` state (gate script untouched): **3 failed | 11 passed (14)** with exactly the documented defect signatures —
- Pin 5f: `expected +0 not to be +0` — the send-relogin-blast-named fixture exits 0; no file-name check exists (WR-04's core hole);
- Pin 5g: `expected +0 not to be +0` — the db-batcher-named fixture exits 0 for the same reason;
- Pin 5i: `expected 1 to be +0` — the real-repo scripts/ scan exits 1: the unextended gate trips on `rehearse-cutover.mjs` (THROWAWAY_CRON_SECRET + CRON_MODE sweep pin), the gate body's own token definitions, and `auth-soak-gate.mjs` (AUTH_NOTICE_* reads).
- Pin 5h passed pre-fix by design (scope guard, not a RED proof); `node --check scripts/check-cron-remnants.mjs` exit 0 (script untouched).

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — fixture pins for the scripts/ scan hole** - `652ddd0` (test)
2. **Task 2: GREEN — extend DEFAULT_ROOTS to scripts/, add the file-name check, pin the token exemptions** - `f71cbdc` (feat)
3. **Task 3: Full verify green (with the single documented environmental exception)** - verification-only, no code changes (no commit)

## Files Created/Modified
- `scripts/check-cron-remnants.mjs` - DEFAULT_ROOTS gains `scripts` (plain push, WR-04 comment); RETIRED_TOKEN_EXEMPT_FILE_NAMES set next to the BUNDLED_READFORM_TOKENS precedent (basename-WITH-extension keys, per-entry rationale); scanCodeFile's CRON_MODE count + RETIRED_ENV_TOKENS loop honor the exemption; main() gains the deleted-module file-NAME check over the union basename sets; header check list gains item 12 + scan-scope/exemption rationale paragraphs; usage() default-targets and flagged-class text updated (green-line format unchanged — downstream greps unaffected)
- `tests/worker/cron-remnant-gate.test.ts` - four permanent pins in the established fixture style (mkdtemp dirs, explicit dir args, rmSync in finally): 5f blast-script file-name trip, 5g Phase-5-basename file-name trip, 5h exemption-scope (renamed copy trips), 5i real-repo scripts-root green

## Decisions Made
- The exemption covers BOTH token-count checks (the CRON_MODE count and the RETIRED_ENV_TOKENS loop), not just the retired-env loop: the plan's must-have truth enumerates the still-applied checks as "imports, file names, deps, route paths" (CRON_MODE absent), the self-scan paradox explicitly includes CRON_MODE ("quotes every retired token"), and the default run + pin 5i cannot go green otherwise (rehearse-cutover.mjs's CRON_MODE sweep pin is non-comment code). Documented in the header contract and here.
- Exemption keys are exact basenames WITH extension (e.g. `rehearse-cutover.mjs`) per the plan's "exact-filename" wording — a `rehearse-cutover.ts` copy would NOT be exempt, and pin 5h pins the rename-trip scope.
- File-name findings wording ("file NAME matches a deleted … module") kept deliberately distinct from specifier wording ("imports a deleted … module") so the pins assert which check fired, per the plan's action spec.
- Untracked GSD tooling files under `scripts/` (`scripts/changeset/`, `scripts/lib/`, `scripts/fix-slash-commands.cjs`, `scripts/gen-capability-registry.cjs`, `scripts/gen-loop-host-contract.cjs`) were left untracked per the environment briefing — and noted: the gate scans the filesystem, not git, so they ride the armed perimeter too; the token/basename sweep found them clean and the default run is green over them.

## Deviations from Plan

None - plan executed exactly as written. (The `.env.production` build-env dance in Task 3 is the documented 07-06 deviation-2 pattern the plan itself cites, not a deviation of this execution: gitignored file, two non-secret DEPLOY-RECORD keys, deleted immediately after the build.)

## Issues Encountered
- The full `pnpm verify` chain stopped at the test leg with TWO failures: the single documented environmental exception (`tests/worker/health.test.ts` EADDRINUSE `127.0.0.1:9090` — the PRODUCTION worker holds the port by design, per 07-VERIFICATION.md / 07-09 §17.2) PLUS `tests/worker/shutdown.test.ts` test 1 timing out at 5000ms — not a documented exception. Investigation: the shutdown test imports `src/worker/index`, which this plan's diff does not touch (the gate script is in no src/ import graph); it passes 3/3 in isolation (test 1 in 792ms) and the FULL test leg re-run came back 411 passed / 2 skipped / the one documented EADDRINUSE fail. Verdict: load-dependent flake under full-chain parallel import contention (chain log showed 18.9s of import time), unrelated to this plan. Per the plan protocol the remaining legs were then run individually and each is green. The production stack (:3007/:9090/:5454/:6391) was never stopped, restarted, or reconfigured.

## Verification

- Gate suite: `pnpm exec vitest run tests/worker/cron-remnant-gate.test.ts` — 14/14 GREEN post-implementation (RED-originated 5f/5g/5i flipped; all 10 pre-existing pins unchanged-green)
- `node --check scripts/check-cron-remnants.mjs` exit 0
- `pnpm cron:remnants` — green, **466 code file(s) scanned across src, scripts, dist\worker.js, .next\server, playwright.config.ts, next.config.ts, ecosystem.config.js (+ package.json)** (pre-extension runs: 426-428; delta = the +38 scripts/ code files now inside the armed perimeter)
- Full verify: lint (0 errors), typecheck (clean), test leg (411 pass / 2 skip / 1 documented environmental fail), schema:gate (empty diff), worker:boundary (19 files), denylist:diff (11 CIDR tokens), build (Compiled successfully, dist/worker.js 140.53 KB), cron:remnants (above), test:e2e (18/18)
- Exemption-scope assertion (plan Task 3): the exemption set is three exact basenames consulted ONLY inside scanCodeFile's token counting (`isRetiredTokenExempt` gates the CRON_MODE count and the RETIRED_ENV_TOKENS loop; no other check reads it) — the specifier, dependency, route-path, and instrumentation checks still apply to all three exempt files, and pin 1's violating-fixture sweep still lists every class.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 07's gap-closure wave is complete (11 of 11): CR-01 wire contract (07-10) and the WR-04 gate-scope hole (this plan) — the two G-07-63 fix-list items — are closed and regression-pinned. The phase returns to `/gsd-verify-work 07`.
- The armed gate is now the reintroduction blocker across src/ AND scripts/ with proven teeth; WINDOWS ledger WR-04 (gate scan scope) is closed by this plan. Remaining open items ride their planned dispositions (WR-03 = WINDOWS #4, Phase-8 scope).

## Self-Check: PASSED

- `scripts/check-cron-remnants.mjs`, `tests/worker/cron-remnant-gate.test.ts`, `07-11-SUMMARY.md` — all FOUND on disk
- Commits FOUND: `652ddd0` (test RED), `f71cbdc` (feat GREEN)
- Acceptance re-run: gate suite 14/14; cron:remnants default run exit 0 with scripts in the roots line (466 files); node --check exit 0; remaining verify legs individually green (schema:gate / worker:boundary / denylist:diff / build / test:e2e 18/18)
- Dirty residue untouched and uncommitted as instructed: `skills-lock.json`, `tests/resilience/observations.json`; untracked tooling dirs left untracked

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-29*
