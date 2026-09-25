---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 07
subsystem: auth
tags: [better-auth, production-flip, canary, soak-gate, bullmq, admin-gating, deploy-record]

# Dependency graph
requires:
  - phase: 07-better-auth-cutover-admin-gating-prisma-removal (07-06)
    provides: full flip rehearsal + D-35 rollback drill, D-06 approved copy, runbook §4c, D-37 canary designation, D-40 snapshot token proof
provides:
  - Production flipped to Better Auth per runbook §4c (backup → 0002 migrate → seed 1 admin grant → readyz-gated worker → web) with the flip deploy ledger recorded (07-DEPLOY-RECORD §13.4)
  - D-38 production canary green on every exercisable leg; D-38 Google/GitHub + D-40 live assertion dispositioned not-exercisable and reserved for the server deploy (§13.3)
  - D-31 typed soak gate executed on production — final run PASS 6 pass / 7 attest / 0 fail, evidence appended to the deploy record (superseded first run kept and marked)
  - D-36 operator APPROVE (early close) recorded verbatim-form — the deletion release (07-08) is authorized (§14.4/§14.5)
  - scripts/auth-soak-gate.mjs — the D-31 typed gate command (13 legs: 6 machine + 7 attest, never-silently-pass semantics, evidence appends to the deploy record)
  - §15 deviations register: 7 operator-topology findings (incl. the rehash field mismatch queued for 07-08)
affects: [07-08 deletion release, server deploy (OAuth creds + nightly-pass observation + D-40 live assertion), phase verification/UAT]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 19376    # chars/4 over the realized diff (77505 chars, 4 files, ledger base 07ef38e)
  tasks: 3
  commits: 6       # MEASURED: git rev-list --count 07ef38e..HEAD incl. the metadata commit

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Typed soak-gate evidence append: gate runs append PASS/ATTEST/FAIL blocks to the deploy record; superseded runs are marked inline, never deleted (append-only record)"
    - "Machine-verified vs operator-attested split on production soak legs (06-§12 pattern): ATTEST-DISPOSITIONED is kept distinct from PASS"
    - "Disposition-not-exercisable: an unexercisable canary leg is named, reasoned, and routed to its owning future deploy instead of being dropped or faked green"

key-files:
  created:
    - scripts/auth-soak-gate.mjs
    - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-07-SUMMARY.md
    - .planning/WINDOWS.md (first commit; cross-phase broken-windows ledger)
  modified:
    - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-DEPLOY-RECORD.md (§12.3 blast evidence; §13.3/§13.4 flip+canary RECORDED; §14.4/§14.5 soak close + D-36; §15 deviations; two typed-gate evidence blocks)
    - .planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260923.md (pre-flight rehearsal refresh, §13.1)
    - docs/DEPLOY-RUNBOOK.md (§4c — authored by 07-06, executed as written here; NO change from 07-07)

key-decisions:
  - "FLIP EXECUTED EARLY by operator decision 2026-09-24 (announced date was 09-28): the sole real announcement recipient is the operator (4/5 recipients internal fixtures, console transport), so serving the announced days has no external audience to protect; the D-07 slip rule governs late slips only"
  - "D-38 legs b/c (Google/GitHub) + the D-40 live no-re-consent assertion DISPOSITIONED not-exercisable: standin OAuth creds + zero OAuth accounts have ever existed on this production; the verbatim assertion is reserved for the server deploy; token preservation stands on 07-06's D-40 snapshot pass"
  - "Operator early-close of the soak accepted via D-36 APPROVE: window 2026-09-24T19:00Z→2026-09-25T18:00Z (≈23h wall, SHORT-WINDOW note covered by the approval); the ~14.4h reboot outage recorded plainly; the nightly 03:15Z maintenance pass UNOBSERVED and deferred to the server deploy (PM2 supervision + 24/7 uptime is the form soak intent targets)"
  - "Rehash field mismatch NOT hot-fixed mid-soak: verify/hashPassword read users.password while the AUTH-09 rehash UPDATE targets account.password (0 rows matched when copies diverge; practical impact ~nil, bcrypt-10 both sides) — one-line fix + test queued in 07-08's plan, which already owns src/lib/auth-password.ts"
  - "No runbook change for the EMAIL_PROVIDER mis-boots: the runbook §4c command block already lists it; the plan's env contract is authoritative — the failure was operator execution, not documentation"
  - "Non-admin soak cookie minted by password-resetting the operator's own internal fixture ops-smoke@spidernode.internal (provenance recorded)"

patterns-established:
  - "Deploy-record close-out: typed-gate blocks append below a closing rule; narrative sections are written around them without duplicating their tables"
  - "Canary dispositions carry their future-proofing venue: every not-exercisable leg names the deploy that will exercise it"

requirements-completed: [AUTH-02, AUTH-05, AUTH-06]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Announcement blast ran through the production queue for all 5 registered users with the D-06-approved bytes and drained 0-failed (console transport; 4/5 recipients internal fixtures, recorded)"
    requirement: AUTH-06
    verification:
      - kind: command
        ref: "rg -c \"blast\" .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-DEPLOY-RECORD.md"
        status: pass
      - kind: integration
        ref: "07-DEPLOY-RECORD.md §12.3 — queue counters 5 pending → 0, completed +5, 0 failed; 5/5 console bodies sha256-16 a27dbf56e44d6f35 = D-06-approved bytes"
        status: pass
    human_judgment: false
  - id: D2
    description: "Flip release deployed per runbook §4c: pre-flip pg_dump (145,254 B, restore-listed) → 0002 migrate (journal=3) → seed-admin-roles 1 grant → readyz-gated flip worker (:9090/admin/queues 403 unauth) → web /login 200 + notice strip live"
    requirement: AUTH-02
    verification:
      - kind: manual_procedural
        ref: "07-DEPLOY-RECORD.md §13.4 flip deploy ledger (operator-executed, timestamps recorded)"
        status: pass
      - kind: integration
        ref: "auth-soak-gate final run LEG 2 + LEG 3 (Bull Board 200 admin+loopback / 403 refusal captured at flip 2026-09-24 15:55Z)"
        status: pass
    human_judgment: true
    rationale: "The §4c deploy steps are operator wall-clock actions (autonomous: false plan); the executor cannot re-run them — the record's ledger is the attested evidence form"
  - id: D3
    description: "D-38 canary green on the credentials path — old-password login proven twice (real API: 200 + session cookie + authenticated /api/monitors 200 with live monitor data; operator browser session), admin matrix green, dead-error logs quiet"
    requirement: AUTH-02
    verification:
      - kind: manual_procedural
        ref: "07-DEPLOY-RECORD.md §13.3 legs a/e/h + gate LEG 7 attestation"
        status: pass
    human_judgment: true
    rationale: "Canary outcomes are attestation-form on production (the D-38 leg design); the machine legs of the same matrix (feedback 401/200/403, Bull Board, strip, logs) are gate-verified PASS in the final run"
  - id: D4
    description: "D-38 Google/GitHub legs + D-40 live no-re-consent assertion dispositioned not-exercisable and reserved for the server deploy; token preservation stands on 07-06's snapshot pass"
    requirement: AUTH-05
    verification:
      - kind: other
        ref: "07-DEPLOY-RECORD.md §13.3 legs b/c + D-40 row; 07-DEPLOY-RECORD.md §10 (pass B: google 2/1/2 incl. NULL-refresh, github 1/1/1)"
        status: pass
    human_judgment: true
    rationale: "A disposition (not a green run): no OAuth accounts/creds exist on this topology to exercise the flow; the record names the server deploy as the exercising venue"
  - id: D5
    description: "scripts/auth-soak-gate.mjs typed gate (6 machine + 7 attest legs, never-silently-pass) parses, evaluates, and appends evidence to the deploy record"
    requirement: AUTH-06
    verification:
      - kind: other
        ref: "node scripts/auth-soak-gate.mjs --dry-run (exit 0, 13 legs parsed — plan <verify> for Task 3)"
        status: pass
      - kind: integration
        ref: "Production final run 2026-09-25T11:59:55Z appended to 07-DEPLOY-RECORD.md: PASS (6 pass / 7 attest / 0 fail)"
        status: pass
    human_judgment: false
  - id: D6
    description: "D-31 soak evidence complete and the single D-36 operator approval recorded — deletion release (07-08) authorized via operator early close"
    requirement: AUTH-06
    verification: []
    human_judgment: true
    rationale: "D-36 is by design a human approval gate (the phase's only one); the verbatim-form record sits in §14.4 — automation cannot substitute the operator's decision"

# Metrics
duration: ~26h elapsed across 3 sessions (scaffolding 2026-09-23/24; operator wall-clock flip+soak 09-24→09-25; close-out leg ~6 min active)
completed: 2026-09-25
status: complete
---

# Phase 7 Plan 07: Production Flip — blast, §4c deploy, D-38/D-40 canary, D-31 soak gate, D-36 approval Summary

**Production flipped to Better Auth per §4c with the canary green on every exercisable leg, the D-31 typed soak gate closed PASS 6/7/0, and the operator's D-36 APPROVE authorizes the 07-08 deletion release.**

## Performance

- **Duration:** ~26h elapsed (3 sessions; operator wall-clock flip + soak between scaffolding and close-out; close-out leg ~6 min active)
- **Started:** 2026-09-23T22:54Z (record opened by the Task 1-3 scaffolding session)
- **Completed:** 2026-09-25T12:1xZ (close-out commit)
- **Tasks:** 3
- **Files modified:** 4 (+ this SUMMARY)

## Accomplishments
- Production flipped to Better Auth per runbook §4c on 2026-09-24 (early, operator decision) — backup `pre-phase7-flip-20260924-2147.dump` (145,254 B, restore-listed) → 0002 migrate (journal=3) → seed 1 admin grant → flip worker readyz first-try with `:9090/admin/queues` answering 403 unauthenticated → web `/login` 200 with the notice strip live (window 2026-09-24..2026-10-08)
- D-38 canary green on every exercisable leg: old-password login proven twice (real API 200 + cookie + authenticated `/api/monitors` 200 with live monitor data; operator browser session), admin feedback matrix 401/200, Bull Board 200/403, strip live, reset round-trip console-delivered 2026-09-25T17:58Z with the D-06-approved bytes (token unconsumed); D-41 never triggered
- D-31 typed soak gate (`scripts/auth-soak-gate.mjs`) ran on production — final run **PASS 6 pass / 7 attest / 0 fail** appended to the deploy record; the earlier incomplete run (5/0/8, missing cookies + attestations) is kept and marked SUPERSEDED
- D-36 operator APPROVE recorded (early close): ≈23h wall window with the SHORT-WINDOW note covered, the ~14.4h reboot outage recorded plainly, the never-run nightly 03:15Z maintenance pass UNOBSERVED and deferred to the server deploy — **07-08 (deletion release) is authorized**
- §15 deviations register: 7 operator-topology findings, none auth-path; the rehash field mismatch queued for 07-08 and appended to the broken-windows ledger

## Task Commits

Each task was committed atomically (Tasks 1-3 by the scaffolding/evidence sessions; the close-out session wrote the narratives):

1. **Task 1: Announcement blast to all registered users** - `f8a817f` + `c19af31` (docs) — preparation + executed evidence (§12.3)
2. **Task 2: Flip release deploy + D-38 production canary** - `0de45fe` (docs) — pre-flight green + §4c sequence + canary/D-40/D-41 templates; close-out filled §13.3/§13.4 in `3497ae2`
3. **Task 3: 24h typed soak gate + D-36 operator approval** - `f42247c` (feat) — `scripts/auth-soak-gate.mjs` + stand-in live proof; production close in `3497ae2`
4. **Close-out: canary/soak narratives + D-36 + deviations** - `3497ae2` (docs)

**Plan metadata:** this commit (docs: complete plan; SUMMARY + STATE + ROADMAP + REQUIREMENTS)

_Note: production state changes (blast, migrate, seed, restarts, canary, soak) are recorded in 07-DEPLOY-RECORD.md, not committed as code — the plan's only new code artifact is the gate script._

## Files Created/Modified
- `scripts/auth-soak-gate.mjs` - the D-31 typed gate command: 6 machine legs + 7 operator-attestation legs, PASS/ATTEST/FAIL with reasons, never silently passes, appends evidence to the deploy record
- `.planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-DEPLOY-RECORD.md` - §12.3 blast evidence; §13.3/§13.4 flip + canary RECORDED; §14.4/§14.5 soak close + D-36 APPROVE; §15 deviations register; two typed-gate evidence blocks (first marked SUPERSEDED)
- `.planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260923.md` - pre-flight rehearsal refresh (§13.1)
- `.planning/WINDOWS.md` - broken-windows ledger first commit; rehash mismatch appended as open deviation (fixed in 07-08)
- `docs/DEPLOY-RUNBOOK.md` - §4c was authored by 07-06 and executed as written; **no 07-07 change** (EMAIL_PROVIDER was already listed — deviation 2 was execution, not documentation)

## Decisions Made
See `key-decisions` frontmatter — the six load-bearing calls: early flip (operator), D-38 b/c + D-40 disposition (reserved for server deploy), soak early-close accepted (D-36 APPROVE), rehash fix queued to 07-08, no runbook edit for EMAIL_PROVIDER, fixture-reset cookie mint (provenance).

## Deviations from Plan

All deviations are recorded in full in **07-DEPLOY-RECORD.md §15** (the deploy record is this plan's primary artifact). Summary:

### Operator-topology deviations (none auth-path)

**1. [Operator decision] Early flip (2026-09-24, announced 09-28)**
- **Found during:** Task 2 · **Issue:** flip ran 4 days before the announced date · **Fix/decision:** recorded rationale — the sole real announcement recipient is the operator (4/5 recipients internal fixtures, console transport); D-07 slip rule governs late only · **Recorded:** §13.3/§13.4

**2. [Rule 1 - execution error] `EMAIL_PROVIDER` omitted from worker boots, TWICE**
- **Found during:** Task 1 (blast eve) + soak restore boot · **Issue:** (a) blast-eve boot used smtp without creds — caught before any retry fired, all 5 blast jobs `attemptsMade=0`; (b) the 2026-09-25 11:45Z restore boot repeated it — 2 jobs stuck in D-09 backoff (`ECONNREFUSED ::1:587`), caught same session via the reset round-trip leg · **Fix:** worker re-booted console-mode both times; jobs drained **0-failed** · **Verification:** queue counters 0 failed; §12.3 + §15 · **Runbook change: NONE** (the plan's env contract is authoritative)

**3. [Rule 1 - bug, fix queued] REHASH FIELD MISMATCH**
- **Found during:** soak window · **Issue:** `verifyPassword`/`hashPassword` run against `users.password` (adapter mapping) while the AUTH-09 lazy-rehash UPDATE targets `account.password` — rehash matches 0 rows when the copies diverge (masked while identical) · **Impact:** ~nil (`hash()` is bcrypt-10 by A-1 parity — a fresh salt, not a scheme change) · **Fix:** one-line fix + test queued in **07-08's plan** (it already owns `src/lib/auth-password.ts`); open entry in `.planning/WINDOWS.md` · **Deliberately not hot-fixed mid-soak**

**4. [Operator action - recovery, not defect] Canary credential recovery via direct DB write** (users + account kept in sync) after a forgotten password; explains the single harmless WARN in the dead-error-quiet scan

**5. [Operator decision] OAuth creds remain standin dummies** — server-deploy item; consequence dispositioned at §13.3 legs b/c + D-40

**6. [Operator action - provenance] Non-admin soak cookie minted by password-resetting the internal fixture `ops-smoke@spidernode.internal`** (the operator's own fixture)

**7. [Topology finding] No process supervision in the executing topology** — bare background processes; the ~21:08Z Sep-24 machine reboot killed the pair + Docker engine for ~14.4h (dead-men paged by design). Positive: the runbook restart procedure (worker-first readyz-gated, then web) worked as documented on both restarts

---

**Total deviations:** 7 (1 operator scheduling decision, 2 execution-error recurrences auto-recovered, 1 bug queued to 07-08, 3 recorded operator actions/dispositions). **Impact on plan:** zero auth-path regressions; the flip, canary, and soak evidence are complete; one code defect (rehash mismatch) is consciously deferred to 07-08 where the file is already owned.

## Issues Encountered
- The ~14.4h reboot outage split the soak window (2.1h + 6.2h green inside ≈23h wall); recorded plainly in §14.5 and accepted by the operator's D-36 early close rather than re-run — a second 24h wall would have re-announced nothing and protected no external user (there is none).
- The nightly 03:15Z maintenance pass never ran under the flipped stack (worker dead at that hour) — UNOBSERVED, accepted, deferred to the server deploy (§14.4/§14.5).
- An earlier incomplete gate run (5 pass/8 fail) is superseded by the final run; both blocks remain in the record with inline markers (append-only).

## User Setup Required
None - no external service configuration required by this plan. (The flip-time env contract items — BETTER_AUTH_SECRET/URL, ADMIN_EMAILS/ADMIN_IP_ALLOWLIST, AUTH_NOTICE_*, OAuth creds — were consumed at flip; real OAuth creds + real SMTP are server-deploy items per §15 deviation 5 and §12.3's recipient-composition finding.)

## Next Phase Readiness
- **07-08 (deletion release) is authorized by the recorded D-36 APPROVE** and may start.
- 07-08 owns the rehash field-mismatch fix (one line + test in `src/lib/auth-password.ts`) alongside its legacy deletions — fold it into its plan.
- Server-deploy carry-forwards recorded for the eventual VPS form: real Google/GitHub OAuth creds (exercises the reserved D-40 live no-re-consent assertion), real SMTP (re-blast form + nightly-pass observation under PM2 supervision + 24/7 uptime).
- Standin OAuth dummies + zero production OAuth rows remain the standing topology facts (07-06 §10 + §13.3 dispositions).

## Self-Check: PASSED

Plan `<verification>` lines + task `<verify>` automated lines, re-run at close-out:

1. **Task 1 verify** — `pnpm exec rg -c "blast" 07-DEPLOY-RECORD.md` → **24** (non-zero; blast evidence present, §12.3 dated 2026-09-24)
2. **Task 2 verify** — `pnpm exec rg -c "D-38|D-40|re-consent" 07-DEPLOY-RECORD.md` → **23** (non-zero; canary + no-re-consent assertions present, §13.3 dated)
3. **Task 3 verify** — `node scripts/auth-soak-gate.mjs --dry-run` → **exit 0**, 13 legs (6 machine + 7 attest) parsed and evaluated
4. **Plan verification: blast evidence + flip-deploy record + canary transcript + soak gate output + D-36 approval all present and dated** — grep counts: blast-evidence heading 1, "Flip deploy ledger — RECORDED" 1, "13.3 … — RECORDED" 1, dated gate blocks 2 (superseded + final), final verdict "PASS (6 pass / 7 attest / 0 fail)" present, D-36 "operator APPROVE, early close" 1, **zero `PENDING` strings remain in the record**
5. **Plan verification: on any canary red → D-41 redeploy recorded and halt** — N/A-by-success: no canary leg went red; D-41 explicitly dispositioned NOT-triggered (§13.3)
6. Commits exist: 5 plan commits from ledger base `07ef38e` + this metadata commit (measured `git rev-list --count 07ef38e..HEAD`)

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-25*
