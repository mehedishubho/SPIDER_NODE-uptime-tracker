---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 02
subsystem: auth
tags: [better-auth, email-queue, render-at-enqueue, bullmq, announcement-blast, drizzle, nextauth-retirement]

# Dependency graph
requires:
  - phase: 06-thin-api-routes-email-abstraction
    provides: byte-frozen render module (src/lib/email/render.ts), enqueueTransactionalEmail with injectable deps seam, email lane worker
  - phase: "07 plan 01"
    provides: BETTER_AUTH_* env contract, migration 0002, Better Auth route scaffold ([...all] coexisting with [...nextauth])
provides:
  - render.ts domain source on BETTER_AUTH_URL with the legacy env fully gone from src/lib/email (Pitfall 5 closed early)
  - additive renderVerificationEmailFromUrl/renderPasswordResetEmailFromUrl for the Better Auth hooks (07-03 consumes these directly)
  - renderAnnouncementEmail with the D-06 drafted copy + AUTH_FLIP_DATE interpolation (07-04 documents the env)
  - scripts/send-relogin-blast.mjs — operator-ready delete-after-use blast on the enqueue-smoke fail-loud contract (07-08 extends the remnant gate to delete it)
  - tests/lib/relogin-blast.test.ts — fan-out unit suite proving one-job-per-registered-user including never-verified accounts
affects: [07-03 email hooks, 07-04 env docs, 07-07 notice strip + slip rule, 07-08 deletion release gate]

# Actuals (#2632) — pairs with the plan's estimate to calibrate future estimates.
actuals:
  tokens: 7500      # chars/4 over the realized diff (651 insertions + 12 deletions across 5 files)
  tasks: 3
  commits: 3        # MEASURED: git rev-list --count 3011d250fb68aaaab9ec57c4d690cefde60af4da..HEAD

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "FromUrl render variants: prebuilt-url email renders for framework hooks (no domain/token rebuild)"
    - "Exported fan-out + main-module guard in operator .mjs scripts — unit-testable without Redis"

key-files:
  created:
    - scripts/send-relogin-blast.mjs
    - tests/lib/relogin-blast.test.ts
  modified:
    - src/lib/email/render.ts
    - tests/lib/email-render.test.ts
    - tests/api/auth-shallow.handler.test.ts

key-decisions:
  - "render.ts domain source moved to BETTER_AUTH_URL with an rg gate keeping the legacy env token out of src/lib/email entirely (comments included) — queued links can never dangle on the deletion release"
  - "Hook-facing variants embed Better Auth's prebuilt url exactly (button href + copy-paste href + visible text all equal the passed url); token-based exports keep their signatures until 07-03 deletes their call sites"
  - "renderAnnouncementEmail reads AUTH_FLIP_DATE at render time and throws early when absent (06 D-11 lineage) — an 'undefined' date can never reach rendered bytes the operator signs off (D-06)"
  - "Blast script exports missingRequiredEnv/runBlast/enqueueAnnouncementForUsers behind a main-module guard — the unit suite drives the REAL render+enqueue against a captured fake queue, no Redis"
  - "No package.json script entry for the blast (pattern-map suggestion consciously skipped to keep the plan's file set intact) — banner documents `pnpm exec tsx scripts/send-relogin-blast.mjs`"

patterns-established:
  - "Prebuilt-url render variant: framework hooks hand the full url; render never rebuilds links from domain+token (RESEARCH Pattern 4)"
  - "Env-gate-first operator script ordering: required-env check before imports/pools/sockets, fail-loud with a names list"
  - "Importable script seams: pure exported helpers + main-module check so vitest imports are side-effect free"

requirements-completed: [EML-04, AUTH-06]

# Coverage metadata (#1602) — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "Every queued email link derives from BETTER_AUTH_URL — the module-scope domain read no longer references the legacy URL env under src/lib/email"
    requirement: EML-04
    verification:
      - kind: unit
        ref: "tests/lib/email-render.test.ts#link forms: domain + /verify-email?token= and /reset-password?token= from BETTER_AUTH_URL"
        status: pass
      - kind: other
        ref: "command: { ! pnpm exec rg -n \"NEXTAUTH_URL\" src/lib/email; } exits 0 (zero matches, comments included)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Hook-facing renderVerificationEmailFromUrl/renderPasswordResetEmailFromUrl exist additively and embed the passed url EXACTLY; frozen template bytes unchanged"
    requirement: EML-04
    verification:
      - kind: unit
        ref: "tests/lib/email-render.test.ts#renderVerificationEmailFromUrl embeds the passed url EXACTLY — both hrefs and the copy-paste text"
        status: pass
      - kind: unit
        ref: "tests/lib/email-render.test.ts#renderPasswordResetEmailFromUrl embeds the passed url EXACTLY — both hrefs and the copy-paste text"
        status: pass
      - kind: unit
        ref: "tests/lib/email-render.test.ts#FromUrl variants are byte-identical to the token variants when handed the legacy-shaped link (additive-only proof)"
        status: pass
    human_judgment: false
  - id: D3
    description: "renderAnnouncementEmail produces the D-06-drafted announcement copy (all five points) with the AUTH_FLIP_DATE interpolation; throw-early when the env is absent"
    requirement: AUTH-06
    verification:
      - kind: other
        ref: "command: tsx probe asserting subject + all five copy points + 'The switch happens on <strong>{date}</strong>' + throw-early (exit 0 both legs)"
        status: pass
      - kind: unit
        ref: "tests/lib/relogin-blast.test.ts#includes never-verified users and matches each payload to its enumerated user (D-01)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Announcement copy WORDING/adequacy approved by the operator (D-06: inspect exact rendered bytes via console provider at the flip rehearsal)"
    requirement: AUTH-06
    verification: []
    human_judgment: true
    rationale: "D-06 explicitly designs copy sign-off as a rehearsal-time human inspection of rendered bytes (EMAIL_PROVIDER=console); content presence is proven (D3) but approval is a human act scheduled by the phase plan"
  - id: D5
    description: "Blast script is operator-ready on the fail-loud contract: syntax-valid, env-gated before ANY enqueue, Drizzle enumeration, app-queue-only enqueue path, counts-only logging, dispose-before-exit"
    requirement: AUTH-06
    verification:
      - kind: other
        ref: "command: node --check scripts/send-relogin-blast.mjs (exit 0)"
        status: pass
      - kind: other
        ref: "command: live fail-loud probe with BETTER_AUTH_URL/AUTH_FLIP_DATE emptied — exit 1 with the env-gate message before any import"
        status: pass
      - kind: unit
        ref: "tests/lib/relogin-blast.test.ts#missing required env aborts fail-loud BEFORE enumeration and BEFORE any enqueue"
        status: pass
      - kind: unit
        ref: "tests/lib/relogin-blast.test.ts#an enqueue rejection propagates — a partial blast never reports success"
        status: pass
    human_judgment: false
  - id: D6
    description: "Fan-out provably enqueues exactly one email-transactional job per registered user — including never-verified accounts — through enqueueTransactionalEmail (D-01/D-04)"
    requirement: AUTH-06
    verification:
      - kind: unit
        ref: "tests/lib/relogin-blast.test.ts#fans out exactly N jobs for N seeded users — one per user, no duplicates"
        status: pass
      - kind: unit
        ref: "tests/lib/relogin-blast.test.ts#includes never-verified users and matches each payload to its enumerated user (D-01)"
        status: pass
    human_judgment: false
  - id: D7
    description: "The blast runs end-to-end on a real stack (real Redis email lane, console-provider dry-run inspected, then a production send)"
    requirement: AUTH-06
    verification: []
    human_judgment: true
    rationale: "Requires the live flip-release topology and the D-04/D-06 operator dry-run-then-send sequence — by design an operator-executed step at the rehearsal/flip, not provable in the unit suite (no Redis by plan constraint)"

# Metrics
duration: 26 min
completed: 2026-09-22
status: complete
---

# Phase 7 Plan 02: Email-Queue Cutover Groundwork Summary

**Render links now derive from BETTER_AUTH_URL with additive Better Auth hook-facing variants and re-frozen byte-parity fixtures, plus a delete-after-use announcement blast script (D-06 copy, Drizzle fan-out, fail-loud env gate) proven one-job-per-registered-user including never-verified accounts**

## Performance

- **Duration:** 26 min
- **Started:** 2026-09-22T19:46:15Z
- **Completed:** 2026-09-22T20:12:39Z
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- Email link domain source swapped to BETTER_AUTH_URL (T-07-06/Pitfall 5) — template bytes frozen, legacy env token absent from all of src/lib/email (comments included, enforced by gate)
- Two ADDITIVE hook-facing renders (`renderVerificationEmailFromUrl`/`renderPasswordResetEmailFromUrl`) embed Better Auth's prebuilt url exactly — fixtures re-frozen with zero byte drift and three new variant cases pinning exact passed-url embedding
- `renderAnnouncementEmail` ships the D-06 drafted copy (five points + flip-date interpolation, throw-early env read, escaped interpolation)
- `scripts/send-relogin-blast.mjs` — delete-after-use operator blast (D-05) on the enqueue-smoke contract: fail-loud env gate before ANY enqueue, Drizzle `SELECT email FROM users` enumeration (never-verified included, D-01), one `enqueueTransactionalEmail` per user through the app queue (D-04, no direct SMTP), progress counter + final count, dispose-before-exit, counts-only logs (T-07-07)
- Fan-out unit suite (7 tests) proves the operator contract with the real render+enqueue wired to a captured fake queue — no Redis

## Task Commits

Each task was committed atomically:

1. **Task 1: Domain-source swap + hook-facing render variants + fixture re-freeze** - `19d9aa0` (feat)
2. **Task 2: Announcement copy + blast script (delete-after-use)** - `4016554` (feat)
3. **Task 3: Blast fan-out unit suite** - `fd7993e` (test)

**Plan metadata:** this commit (`docs(07-02): complete ...`)

## Files Created/Modified

- `src/lib/email/render.ts` — domain const now reads BETTER_AUTH_URL; banner lineage line; additive `renderVerificationEmailFromUrl`/`renderPasswordResetEmailFromUrl`; new `renderAnnouncementEmail` + `ANNOUNCEMENT_SUBJECT` + module-local escapeHtml
- `tests/lib/email-render.test.ts` — fixture re-freeze (env pin moved to BETTER_AUTH_URL, same value → zero byte drift); new describe with 3 variant cases
- `tests/api/auth-shallow.handler.test.ts` — env pin + save/restore + comments follow the domain source to BETTER_AUTH_URL (Pitfall 5-named file)
- `scripts/send-relogin-blast.mjs` — NEW: operator blast script with exported testable seams and main-module guard
- `tests/lib/relogin-blast.test.ts` — NEW: 7-test fan-out suite through the injectable queue seam

## Decisions Made

- Domain swap gated by `rg "NEXTAUTH_URL" src/lib/email` being comments-INCLUSIVE — the banner lineage note was reworded so even the comment never carries the retired token (mirrors the check-cron-remnants comments-inclusive convention)
- The two FromUrl variants reuse the token variants' content/subject/footer strings byte-identically, giving a free additive-only proof: the variant fed the legacy-shaped link reproduces the frozen fixture bytes exactly
- AUTH_FLIP_DATE is read at render time (not module scope) and throws early when absent — the blast script's requireEnv is the first net, the render throw the second; an "undefined" date can never reach D-06 sign-off bytes
- Fan-out deps are fully injected (render, enqueue, queue client, logger) — the suite exercises the REAL render + REAL enqueueTransactionalEmail against a fake queue, proving payload composition, not just loop mechanics
- No package.json `blast:relogin` entry (PATTERNS.md suggestion): the plan's file set is binding; the banner documents direct tsx invocation, and 07-08's gate extension deletes the script by path regardless

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tests/api/auth-shallow.handler.test.ts env pin followed the domain source**
- **Found during:** Task 1 (fixture re-freeze)
- **Issue:** The file pins the render domain env at module scope and asserts rendered links contain `https://route.spidernode.test/...` — after the render.ts swap its NEXTAUTH_URL pin went dead and both link assertions would fail (RESEARCH Pitfall 5 named exactly this file; it is outside the plan's `files_modified`)
- **Fix:** Pin + save/restore + three comments moved to BETTER_AUTH_URL (same deterministic value, so the pinned assertions remain valid)
- **Files modified:** tests/api/auth-shallow.handler.test.ts
- **Verification:** full unit suite green after the change (375/375 across 43 files)
- **Committed in:** 19d9aa0 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The fix is the exact companion edit RESEARCH Pitfall 5 prescribes for the domain-source swap; no scope creep.

## Issues Encountered

- One full-suite run hit a transient vitest worker-fork crash ("Worker exited unexpectedly" taking one file's results with it) — the known Windows transient recorded in 05-07 (run 4 = transient 0xC0000005). Two subsequent clean full runs: 43 files / 375 tests / 375 passed, exit 0. Not caused by this plan's changes.
- `pnpm test -- <file>` passes `--` through as a literal filter on this pnpm/vitest pairing, so the "single-file" gates effectively ran the whole unit suite — strictly stronger evidence; all gates judged on their stated fails_when conditions.
- TypeScript infers the .mjs script's env-gate parameter as Next's augmented `ProcessEnv` (NODE_ENV required); the suite bridges it with a documented `envWith` cast — runtime semantics unchanged.

## User Setup Required

None - no external service configuration required. (AUTH_FLIP_DATE/BETTER_AUTH_URL are documented in .env.example by 07-04 per the plan's artifact note.)

## Next Phase Readiness

- 07-03 can wire `sendVerificationEmail`/`sendResetPassword` to `renderVerificationEmailFromUrl`/`renderPasswordResetEmailFromUrl` + `enqueueTransactionalEmail` immediately — the call sites and fixtures it needs are frozen and pinned
- 07-04 documents AUTH_FLIP_DATE in .env.example (this plan's script + render already consume it)
- 07-08's deletion-release gate must catch `scripts/send-relogin-blast.mjs` by path (D-05 delete-after-use) and the notice-window envs
- EML-04/AUTH-06 deliberately NOT flipped to Complete in REQUIREMENTS.md yet — the #2388 shared-ID gate blocks both until 07-03 (EML-04) and 07-04/07-07 (AUTH-06) produce summaries
- Operator actions scheduled by design (not blockers): D-06 copy sign-off and the D-04 console-provider dry-run happen at the flip rehearsal (07 deploy record)

## Self-Check: PASSED

- Created/modified files exist on disk: render.ts, email-render.test.ts, relogin-blast.test.ts, send-relogin-blast.mjs, auth-shallow.handler.test.ts — all FOUND
- Commits exist: 19d9aa0, 4016554, fd7993e — all FOUND
- All task acceptance gates re-run green: email-render suite (9/9), relogin-blast suite (7/7), full unit suite 375/375 across 43 files, `pnpm typecheck` clean, rg legacy-env gate clean, `node --check` clean
- Plan-level `<verification>`: all three lines PASS (details above)

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-22*
