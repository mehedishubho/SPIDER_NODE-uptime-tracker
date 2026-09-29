---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
verified: 2026-09-29T21:22:22Z
status: human_needed
score: 5/5 roadmap success criteria verified (1 sub-claim present, behavior-unverified)
behavior_unverified: 1
overrides_applied: 0
covered_files:
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-01-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-01-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-02-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-02-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-03-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-03-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-04-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-04-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-05-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-05-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-06-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-06-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-07-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-07-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-08-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-08-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-09-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-09-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-10-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-10-SUMMARY.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-11-PLAN.md
  - .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-11-SUMMARY.md
  - package.json
  - scripts/check-cron-remnants.mjs
  - src/app/api/feedback/route.ts
  - src/app/api/incidents/route.ts
  - src/app/api/monitors/[id]/details/route.ts
  - src/app/api/monitors/[id]/route.ts
  - src/app/api/monitors/route.ts
  - src/app/api/status/[userId]/route.ts
  - src/app/api/status/route.ts
  - src/app/api/telegram/webhook/route.ts
  - src/app/api/user/profile/route.ts
  - src/db/schema.ts
  - src/lib/auth-password.ts
  - src/lib/auth.ts
  - src/lib/check-now-poll.ts
  - src/lib/serialize.ts
  - tests/integration/wire-timestamps.test.ts
  - tests/lib/check-now-poll.test.ts
  - tests/lib/serialize.test.ts
  - tests/worker/cron-remnant-gate.test.ts
covered_digest: "v2:sha256:35c57d12970c138763c27664f5fd5e4bd5e8ae4d7c8bfd2bfcf43e3e277387c9"
re_verification:
  previous_status: human_needed
  previous_score: 5/5 (1 sub-claim present, behavior-unverified; 0 gaps)
  gaps_closed:
    - "CR-01 (review critical): ISO-8601 UTC wire contract restored on all 8 response routes via src/lib/serialize.ts; poll normalizes through iso() before the completion comparison (07-10, commits df421c7 RED / 66b13a2 GREEN) — regression-pinned by the real-DB wire suite (4/4 GREEN this run)"
    - "WR-01 (review warning): updatedAt restored on all 3 UPDATE paths (monitors/[id]:161, profile:182, webhook:91); full src sweep confirms exactly 3 .update() sites; wire-suite legs prove strictly-later re-reads (GREEN this run)"
    - "WR-02 (review warning): empty-set monitors PATCH answers the Prisma-era 200 no-op with the existing normalized row; guard sits after the ownership 404 and before the UPDATE; wire-suite leg GREEN this run"
    - "WR-04 (review warning): armed remnant gate DEFAULT_ROOTS gains scripts/ unconditionally (466-file perimeter), deleted-module FILE-NAME check added, 3 exact-filename token-only exemptions with rename-trip pin; gate suite 14/14 and armed default run GREEN 466 files exit 0 this run"
    - "Prior human item 3 (check-now poll + non-UTC display) is now MACHINE-COVERED — re-assessed and removed from human_verification: the CR-01 defect class is regression-pinned at the only seam that could see it (real-driver wire suite), the poll completion comparison is unit-proven incl. the legacy naive-text case (7/7), and the strict ISO-Z wire form makes the display leg deterministic (components parse via spec-defined new Date(...).toLocale*())"
  gaps_remaining: []
  regressions: []
behavior_unverified_items:
  - truth: "SC2 leg: real Google and GitHub logins complete post-cutover WITHOUT a re-consent screen (live provider round-trip on production)"
    test: "After the server deploy gives the stack real OAuth credentials, complete one real Google login and one real GitHub login with an existing OAuth-linked account"
    expected: "Both logins complete, dashboard loads, NO consent screen appears (D-40 verbatim assertion — its absence is the production proof that live refresh tokens survived the reshape)"
    why_human: "External provider round-trip with browser consent UI. This production topology has zero OAuth accounts and standin credentials, so no test or probe can exercise it; the deploy record dispositions the leg not-exercisable and reserves it for the server deploy (§13.3, §18.2 AUTH-05). Data-layer token preservation IS proven (07-06 D-40 snapshot pass B: google 2/1/2 incl. NULL-refresh, github 1/1/1). Unchanged by the gap-closure wave (07-10/07-11 touched no auth code)."
coincidental_reliance_items:
  - truth: "WR-01 truth: updatedAt advances on every UPDATE write path (the wire-suite strictly-later legs are the real-DB proof)"
    reason: undeclared-precondition
    harden: "tests/integration/wire-timestamps.test.ts:46 seeds a hardcoded same-day instant (2026-09-29T15:00:00.789Z) and the WR-01 legs assert Date.now()-based updatedAt toBeGreaterThan(SEED_MS) — green only when the wall clock is past that instant (review WR-05, open). Harden exactly as the review prescribes: seed a fixed past instant (e.g. 2020-01-01T00:00:00.000Z) so the permanent pin is clock-independent. The truth itself also holds via clock-independent handler-suite set-pins (updatedAt in every .set()), so this is advisory — not a score or status change."
advisory:
  - finding: "WR-05 (open warning, 07-REVIEW-DISPOSITION): wire-suite WR-01 legs clock-dependent — hardcoded same-day seed false-REDs any run before 15:00Z (incl. skewed/backdated CI clocks); self-healing after 2026-09-29"
    category: other
    reason: "New-scope test-robustness concern on the fix wave's own regression suite; this verification ran 21:17Z (past the seed) and the suite is GREEN. Resolves by seeding a fixed past instant per the review's prescribed one-line fix."
    evidence_status: "none provided"
  - finding: "IN-04 (open info): iso() unparseable-passthrough branch (serialize.ts:50) untested — a future driver format drift could silently restore the CR-01 shape"
    category: other
    reason: "Documented design choice ('a serializer never fabricates a date') with a sound rationale; the known driver forms are wire-suite-pinned. Resolves by pinning the passthrough contract in tests/lib/serialize.test.ts per the review."
    evidence_status: "none provided"
  - finding: "IN-05 (open info): gate file-NAME check gives generic basenames mail.*/tokens.* a build-failing blast radius on any future legitimate file of those names"
    category: other
    reason: "Documented-by-design friction with a written escape hatch in the gate header (rename or deliberately amend DELETED_MODULE_BASENAMES); no action now per the review itself."
    evidence_status: "none provided"
human_verification:
  - test: "Live Google + GitHub login round-trip on the post-cutover engine (the server-deploy-reserved D-40 assertion)"
    expected: "Each login completes to the dashboard with no re-consent screen; account rows keep providerId casing google/github; refresh tokens still present"
    why_human: "Real external OAuth providers + browser consent flow; not exercisable on this topology (no OAuth accounts/creds exist). The record's own disposition names the server deploy as the venue. Unchanged by the fix wave."
  - test: "Operator password change (record §16.6 A.2 PROMINENT flag — the restored credential is a machine-minted value stored only in gitignored .snapshots/0708-operator-password.txt)"
    expected: "Operator signs in with the minted value and changes it to a secret of their own choosing via the auth flow (WINDOWS #4: the profile route is NOT a valid password surface); the new password signs in, the minted value is refused afterward"
    why_human: "Operator-owned secret action on the live account; automation cannot (and must not) perform or verify it."
deferred:
  - truth: "Profile-route password flow verifies/writes users.password while the engine authenticates account.password (WR-03 / WINDOWS ledger #4)"
    addressed_in: "Phase 8"
    evidence: "WINDOWS.md entry #4 (open): 'the real fix routes the flow through better-auth changePassword — Phase-8 scope, operator to prioritize'; /gsd-ship blocks while open; the re-review confirmed no 07-10/07-11 work touched it (07-10 annotated the password branch out of scope in the route header)"
gaps: [] # no must-have truth failed; no artifact missing/stub; no key link unwired
---

# Phase 7: Better Auth Cutover, Admin Gating & Prisma Removal — Verification Report (Re-verification after Gap-Closure Wave)

**Phase Goal:** Users authenticate through Better Auth against the existing tables without a single lockout, admin surfaces are gated by role, and Prisma is fully removed.
**Verified:** 2026-09-29T21:22:22Z
**Status:** human_needed (all must-haves verified including the gap-closure wave; 2 genuine human-verification items remain — the third was re-assessed and is now machine-covered; 0 gaps)
**Re-verification:** Yes — after gap closure (07-10 wire-timestamp fix + 07-11 gate-perimeter fix; incremental re-review commit 52d0254)

**Mode note (mvp):** ROADMAP declares `Mode: mvp`, but the phase goal is outcome-shaped, not a canonical user story (`As a…, I want to…, so that….` — the goal does not match; the `gsd_run user-story.validate` query is unavailable in this environment). Following the executor's 07-01 precedent (surfaced and recorded), this verification maps the goal's three outcome clauses instead of refusing. `gsd_run` remains unavailable throughout; all verification below was performed by direct codebase inspection, targeted test runs, and read-only production probes (live stack untouched — :3007/:9090/:5454/:6391 never stopped or reconfigured).

## Re-Verification Scope

Prior report (2026-09-29T16:45:00Z): `human_needed`, **0 gaps**, 3 human items, 1 behavior-unverified leg. Per re-verification procedure: no frontmatter `gaps` existed, so the passed must-haves got quick regression checks (existence + basic sanity — all clean, see below), and the gap-closure wave's changes got full three-level verification (the wave's files are all new/modified since the prior `verified:` timestamp):

- **07-10** (CR-01 + WR-01 + WR-02): `src/lib/serialize.ts` (new), 8 response routes + `check-now-poll.ts` + telegram webhook normalized/guarded, `tests/integration/wire-timestamps.test.ts` (new real-DB wire suite), plus 5 touched test files.
- **07-11** (WR-04): `scripts/check-cron-remnants.mjs` perimeter/exemptions/file-name check, `tests/worker/cron-remnant-gate.test.ts` 4 new pins.

## User Flow Coverage (goal clauses → evidence)

| # | Goal clause (outcome) | Expected | Evidence in codebase / production | Status |
|---|----------------------|----------|-----------------------------------|--------|
| 1 | Users authenticate through Better Auth against the existing tables without a single lockout | Old password works post-flip; lazy rehash upgrades hashes without breaking anyone; canary proven on snapshot then production | Quick regression this run: `src/lib/auth-password.ts` prefix router + both-copies rehash present (grep: `$2`-prefix routing, "rehash upgrades BOTH copies"); auth.ts parity pins 9 hits (cookieCache/secondaryStorage/rateLimit/trustedOrigins); live stack answering (login page 200 this run). Full chain carried from prior report: auth-password 7/7, cutover 8/8, canary §6/§13.3 (twice)/§16.4/§17.3 | VERIFIED |
| 2 | Admin surfaces are gated by role | Feedback listing admin-only; Bull Board only for admins from allowlisted IPs; no admin management surface | Untouched by the wave (prior full verification carried: gate chain in code, 9/9 matrix, 401/403 live probes, production matrix §13.3 e/f, §16.4 c/d); feedback route re-inspected this run during the CR-01 pass — gate intact, responses now via isoRow | VERIFIED |
| 3 | Prisma is fully removed | No `prisma/`, generated client, `@prisma/*` deps; every read path on Drizzle; suite green | Re-checked this run: 0/7 banned deps in package.json (node assertion); prisma/, src/lib/prisma.ts, src/generated, auth-legacy, authSlice, next-auth.d.ts, AuthProvider all ABSENT (fs probe); schema.ts legacy declarations absent (only the historical comment at line 18); armed gate GREEN 466 files incl. scripts/ (extended perimeter, exit 0 this run); the wave additionally hardened the wire contract (serialize seam) | VERIFIED |

## Goal Achievement

### Observable Truths (roadmap Success Criteria = the contract)

| # | Truth (SC) | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Every existing credentials user can log in with their old password after the flip; canary through preserved bcrypt hash path on snapshot then production; lazy rehash upgrades without breaking anyone | ✓ VERIFIED | Quick regression clean (prefix router + both-copies rehash in code this run); behavioral tests 7/7 + 8/8 (prior run, suites unchanged since — git log shows no commits touching src/lib/auth-password.ts or the auth suites after the prior verification except none); production canary record §6/§13.3/§16.4/§17.3 carried as evidence |
| 2 | Google/GitHub users log in post-cutover with accounts + refresh tokens intact; cookieCache session checks; boolean emailVerified backfilled; legacy tables read-only through the window | ✓ VERIFIED (one leg PRESENT_BEHAVIOR_UNVERIFIED) | Data layer + machinery carried from prior report (D-40 pass B, D5 callback test, cookieCache pins 9 hits re-grepped this run, §16.6 A.1 replay). NOT exercised: the live real-provider round-trip — dispositioned not-exercisable (zero OAuth accounts on this production), reserved for the server deploy → behavior_unverified_items + Human Verification. The wave touched no auth code (07-REVIEW file list confirms) |
| 3 | Announced forced re-login happens: in-app/email notice at flip; verification/reset emails flow through the queue, never in-request SMTP | ✓ VERIFIED | Carried from prior report (blast 5/5, drained 0-failed, §12.3/§13.3 g/h); hooks → enqueueTransactionalEmail wiring untouched by the wave; blast script stays deleted with its basename now gate-enforced across src AND scripts/ (extended perimeter GREEN this run) |
| 4 | Admin gating end-to-end: roles via Better Auth admin plugin, feedback admin-only, Bull Board reachable only for admins from allowlisted IPs | ✓ VERIFIED | Carried from prior report (9/9 gate matrix, production matrix, live 401/403 probes); feedback route re-read this run — 401/403 gate + D-16 audit line intact |
| 5 | Removal complete: no NextAuth deps/routes, no Redux auth slice / token mirror / js-cookie; no prisma dir/client/deps; every read path on Drizzle with suite green | ✓ VERIFIED | Re-checked this run: 0/7 banned deps (node assertion); all deleted artifacts absent (fs probe); typecheck/typelevel integrity witnessed by the wire suite's compile-time `keyof T` key pinning (re-review) and the wave's own verify chain (typecheck exit 0); armed gate GREEN 466 files exit 0 (this run, extended perimeter); suite green modulo the single documented environmental `health.test.ts` EADDRINUSE-:9090 (production worker holds the port by design — recorded deferral, unchanged) |

**Score:** 5/5 success criteria verified (1 sub-claim present + wired but behavior-unverified: the live OAuth round-trip — unchanged by the wave)

### Fix-Wave Truths (07-10 / 07-11 — full three-level verification this run)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| F1 | Every timestamp every ported route emits is ISO-8601 UTC Z via the single `@/lib/serialize` seam; nullable keys stay present-with-null (CR-01 fix) | ✓ VERIFIED | `src/lib/serialize.ts` substantive (iso canonicalize-then-parse: space→T, naive→Z, bare +HH→+HH:00, ISO-Z round-trip, null passthrough; isoRow spread-and-overwrite). WIRED: git grep lists exactly the 8 response routes + poll importing `@/lib/serialize`. Behavioral: wire suite CR-01 leg GREEN this run (real driver, real handlers, strict Z regex + millisecond round-trip on all 4 monitor timestamp keys); serialize unit matrix 7/7 |
| F2 | The manual-check completion poll resolves in ANY browser timezone — comparison normalizes through iso() before comparing to queuedAt; null stays a skip | ✓ VERIFIED | `src/lib/check-now-poll.ts:74-75` in code (read this run); poll suite 7/7 GREEN this run incl. the G-07-63 legacy naive-text case (naive lastChecked AFTER queuedAt completes on first read); the wire the poll reads is pinned ISO-Z by F1 |
| F3 | updatedAt advances on every UPDATE write path — monitors PATCH, profile PATCH, telegram webhook deep-link (WR-01) | ✓ VERIFIED | All 3 `.set()` carry `updatedAt: new Date().toISOString()` ([id]/route.ts:161, profile:182, webhook:91 — read this run); git sweep: exactly 3 `.update(` sites in src/ — no others; wire-suite WR-01 legs GREEN this run (stored row re-read strictly later than seed) — see coincidental_reliance_items for the clock-seed caveat (WR-05, advisory) |
| F4 | An empty monitors PATCH answers the Prisma-equivalent 200 no-op carrying the existing normalized row — never the `.set({})` 500; ownership 404 wins (WR-02) | ✓ VERIFIED | Guard in code at [id]/route.ts:145-153 (after ownership 404, before UPDATE — read this run); wire-suite WR-02 leg GREEN this run (200 + `{message, monitor}` shape + DB row byte-unchanged); handler pin: update builder never invoked |
| F5 | The armed remnant gate's default scan covers scripts/ — a re-created deleted-module-named file trips BY FILE NAME with zero imports; 3 exact-filename token-only exemptions; renamed copy still trips (WR-04) | ✓ VERIFIED | Gate script read this run: DEFAULT_ROOTS pushes `scripts` unconditionally (line 190), file-NAME check at 465-471 over both basename sets, exemptions at 159-163 consulted ONLY in scanCodeFile's token counters (347-350), PHASE7_ENFORCED=true (180). Behavioral: gate suite 14/14 GREEN (incl. 5f/5g/5h/5i) and armed default run GREEN **466 files** exit 0 **this run** |

### Plan-Level Must-Haves (prior 67 truths + the wave's plans)

All prior plan truths re-checked at quick-regression depth (existence + basic sanity) — none regressed (see Re-Verification Scope). 07-01..07-09 evidence chains are carried forward verbatim from the prior report's tables below (Required Artifacts / Key Links / Data-Flow), and the two wave plans (07-10, 07-11) received the full three-level verification recorded as F1–F5. Deploy-record production proofs (§13–§18) are treated as evidence per the dispatch and were not re-run; the cheap continuity probe (login page 200 this run) confirms the live stack still answers.

### Advisory (New Scope, Unevidenced)

| # | Finding | Category | Why Advisory |
|---|---------|----------|--------------|
| 1 | WR-05: wire-suite WR-01 legs clock-dependent (hardcoded same-day seed) | other | New-scope, open in review ledger; this run's evidence is valid (ran 21:17Z > 15:00Z seed); one-line prescribed fix; self-healing after today |
| 2 | IN-04: iso() unparseable-passthrough untested | other | New-scope, open; sound documented rationale; known forms wire-pinned |
| 3 | IN-05: gate file-NAME check's mail.*/tokens.* blast radius | other | New-scope, open; documented-by-design friction; "no action now" per the reviewer |

(IN-01..03 are pre-existing info items from the first review, already documented conscious acceptances — not new scope of this wave.)

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/lib/serialize.ts` | The ONE ISO-8601 UTC seam (NEW in wave) | ✓ VERIFIED | Present, substantive (both helpers + rationale docs); imported by exactly 8 response routes + poll (git grep this run); typecheck-enforced keyof key lists (re-review) |
| `src/lib/check-now-poll.ts` | Timezone-blind-proof completion poll | ✓ VERIFIED | iso() normalization at lines 74-75 (read this run); 7/7 unit tests GREEN incl. legacy naive case |
| `tests/integration/wire-timestamps.test.ts` | Real-DB wire regression suite (NEW in wave) | ✓ VERIFIED | Real drizzle-orm/node-postgres driver, session-door-only mock, whole-table TRUNCATE discipline; 4/4 GREEN this run on the docker test PG |
| `scripts/check-cron-remnants.mjs` | Armed gate with extended perimeter | ✓ VERIFIED | scripts/ root (line 190), file-NAME check (465-471), 3 exact-filename token-only exemptions (159-163); `node scripts/check-cron-remnants.mjs` GREEN 466 files exit 0 this run |
| `src/app/api/monitors/[id]/route.ts` | isoRow responses + WR-01 set + WR-02 guard | ✓ VERIFIED | Lines 57/149/174 isoRow, 161 updatedAt set, 145-153 guard — all read this run |
| `src/lib/auth.ts` / `src/lib/auth-password.ts` / `src/lib/session.ts` | Full-parity engine, A-1 router, single session door | ✓ VERIFIED (quick regression) | Pins 9 grep hits; prefix router + both-copies rehash present; suites unchanged since prior green runs |
| `src/worker/bull-board.ts` + `health.ts` + `src/lib/ip-allowlist.ts` | Gated Bull Board mount | ✓ VERIFIED (quick regression, untouched by wave) | Prior evidence carried: gate chain, 9/9 matrix, live 403 |
| `drizzle/0002` / `0003` + `src/db/schema.ts` | Additive expand / sanctioned drop / post-drop shape | ✓ VERIFIED (quick regression) | schema.ts legacy declarations absent (only historical comment line 18); journal=4 + census legacy_left=0 carried from record §17.3/§18.1 |
| `prisma/`, `src/lib/prisma.ts`, `src/generated`, `src/lib/auth-legacy.ts`, `src/redux/features/auth/authSlice.ts`, `src/types/next-auth.d.ts`, `AuthProvider.tsx` | Deleted | ✓ VERIFIED (absent) | fs probe this run: all absent; 0/7 banned deps in package.json (node assertion this run) |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| 8 response routes | serialize seam | `import { iso/isoRow } from "@/lib/serialize"` | WIRED | git grep -l this run: monitors, monitors/[id], monitors/[id]/details, incidents, status, status/[userId], user/profile, feedback — exactly 8 |
| check-now-poll.ts | serialize seam | `import { iso }` + line 74-75 normalization | WIRED | Read this run; raw `new Date(monitor.lastChecked)` eliminated (poll suite + re-review concur) |
| wire suite | real driver + real handlers | only `@/lib/session` mocked; real `@/db` client | WIRED | File read this run: vi.mock targets ONLY getAuthSession; no `_harness` import (would have stubbed @/db) |
| gate DEFAULT_ROOTS | scripts/ tree | unconditional push (line 190) | WIRED | Armed run GREEN 466 files = 428 pre-wave + 38 scripts/ files (root named in green line this run) |
| exemptions | token counters only | `isRetiredTokenExempt` gates CRON_MODE count + RETIRED_ENV_TOKENS loop (scanCodeFile 347-350) | WIRED | Read this run; imports/file-names/route-paths/deps still apply (pin 5h proves rename-trip) |
| auth.ts hooks | email queue | enqueueTransactionalEmail + render From-Url variants | WIRED (carried) | Untouched by wave; prior verification lines 12-15/165/173 |
| feedback route | users.role gate | getAuthSession → session.user.role → 401/403 | WIRED (carried) | Re-read this run during CR-01 pass — gate intact |
| bull-board.ts | createAuth() instance | shared @/lib/auth import | WIRED (carried) | Untouched by wave |
| baseApi | cookie credentials | no Authorization header | WIRED (carried) | Untouched by wave |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `/api/monitors` GET (wire leg) | monitors rows | Real docker PG via real Drizzle client | Yes — seeded instant round-trips at millisecond equality through the real driver (4/4 GREEN this run) | ✓ FLOWING |
| `/api/monitors/[id]` PATCH | updated row | Real PG UPDATE + re-read | Yes — strictly-later updatedAt re-read from the DB (wire leg GREEN this run) | ✓ FLOWING |
| check-now-poll | lastChecked | Route response (iso()-normalized) | Yes — unit-proven on legacy naive driver text + the wire form pinned ISO-Z | ✓ FLOWING |
| `/api/feedback` GET | feedbacks + users join | Drizzle | Yes — carried (admin 200 in production matrix §13.3 e); route re-read this run | ✓ FLOWING |
| `/login` | authClient → engine | Better Auth | Yes — live login page 200 this run; full canary chain carried | ✓ FLOWING |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| CR-01 wire contract + WR-01/WR-02 legs on the REAL driver | `pnpm exec vitest run tests/integration/wire-timestamps.test.ts` (in 4-file run) | 4/4 pass (real docker PG; migrations applied; ran 21:17Z, past the WR-05 seed — see coincidental_reliance_items) | ✓ PASS |
| iso() canonicalization matrix + isoRow shape contract | `tests/lib/serialize.test.ts` (same run) | 7/7 pass | ✓ PASS |
| Poll completion incl. legacy naive-text case (G-07-63) | `tests/lib/check-now-poll.test.ts` (same run) | 7/7 pass | ✓ PASS |
| Extended gate teeth (file-NAME trip, rename-trip exemption scope, real scripts/ root) | `tests/worker/cron-remnant-gate.test.ts` (same run) | 14/14 pass | ✓ PASS |
| Armed gate over the extended 466-file perimeter | `node scripts/check-cron-remnants.mjs` | green, roots line names scripts/, exit 0 | ✓ PASS |
| WR-01 completeness (no missed UPDATE path) | git grep `.update(` over src/ | exactly 3 sites, all with updatedAt in set | ✓ PASS |
| CR-01 adoption completeness | git grep `@/lib/serialize` over src/ | exactly 8 routes + poll | ✓ PASS |
| Removal persistence (banned deps, deleted artifacts) | node assertions + fs probes | 0/7 deps; all 7 paths absent | ✓ PASS |
| Live stack continuity | curl :3007/login | 200 | ✓ PASS |
| Debt markers in wave files | git grep TBD/FIXME/XXX/HACK/PLACEHOLDER over 15 wave files | no matches | ✓ PASS |

Full-suite note: not re-run this verification (single-run constraint; the wave's own full verify is recorded green in both wave summaries — 411 pass / 2 skip / 1 documented environmental EADDRINUSE-:9090 fail — and this verification's targeted 32-test run plus the armed gate re-run cover every behavior the wave changed).

## Probe Execution

No `scripts/*/tests/probe-*.sh` conventional probes exist for this phase. The typed soak gate (`scripts/auth-soak-gate.mjs`) production run remains recorded deploy-record evidence (§14, PASS 6/7/0) — not re-run. The armed remnant gate (the phase's own enforcement probe) WAS re-run this verification: GREEN 466 files, exit 0.

## Requirements Coverage (13/13 accounted — plan union == roadmap list, no orphans)

| Requirement | Source Plans | Description | Status | Evidence |
| ----------- | ------------ | ----------- | ------ | -------- |
| AUTH-01 | 07-01, 07-03 | bcrypt-compatible hash/verify with prefix routing | ✓ SATISFIED | src/lib/auth-password.ts (re-grepped this run); 7/7 tests; canary §6/§13.3 |
| AUTH-02 | 07-01, 07-03, 07-06, 07-07 | Canary login through preserved hash path, snapshot then production | ✓ SATISFIED | §6, §13.3 leg a (twice), §16.4, §17.3 7b |
| AUTH-03 | 07-01, 07-03 | Adapter bound to existing users; account/session/verification; boolean backfill | ✓ SATISFIED | 0002 + schema.ts; D-23 tests; §16.6 A.1 restore replay census |
| AUTH-04 | 07-03 | cookieCache session strategy | ✓ SATISFIED | auth.ts pins re-grepped this run (9 hits); proxy validation; §18.2 note |
| AUTH-05 | 07-06, 07-07 | OAuth reshaped to account, providerId casing dry-run, refresh tokens preserved | ✓ SATISFIED (live leg reserved) | §10 D-40 pass B; §13.3 b/c + D-40 dispositioned → human item (unchanged by wave) |
| AUTH-06 | 07-02, 07-04, 07-07 | Forced re-login announced in-app/email | ✓ SATISFIED | §12.3 blast; §13.3 legs g/h; D-05 completion §18.3; basename now gate-enforced incl. scripts/ |
| AUTH-07 | 07-08, 07-09, 07-11 | NextAuth deps/routes removed; legacy tables read-only one release then dropped | ✓ SATISFIED | Deletions re-verified absent this run; §16.4 substrate assertion; §17.3 drop + census; gate extended + armed GREEN this run (07-11 closed the WR-04 scope hole — the gate now guards the tooling root where its own deleted remnant lived) |
| AUTH-08 | 07-04, 07-08 | Duplicated client auth state removed; Better Auth client single source | ✓ SATISFIED | authSlice/AuthProvider/token mirror absent (fs probe this run); baseApi cookie-only |
| AUTH-09 | 07-01, 07-08 | Lazy rehash-on-login upgrades stored hash | ✓ SATISFIED | both-copies upgrade in code (re-grepped this run); 7/7 tests; production canary re-salt §13.3 |
| DRZ-07 | 07-08, 07-09, 07-10, 07-11 | Prisma fully removed | ✓ SATISFIED | §18.1 final proof; this run: 0/7 banned deps, dirs absent, gate GREEN 466 files; the wave additionally restored the Drizzle wire contract to Prisma-era parity (serialize seam) — the last parity gap the review found is closed and regression-pinned |
| EML-04 | 07-02, 07-03 | Better Auth hooks delegate to the queue | ✓ SATISFIED | Hook wiring untouched (carried); §9/§13.3 round-trips 0-failed |
| SEC-04 | 07-03, 07-05 | Admin role via plugin; feedback admin-gated; queue UI admin-gated + IP allowlist | ✓ SATISFIED | Gate chain carried; feedback gate re-read this run; live 401/403 probes (prior run) |
| OBS-04 | 07-05 | Bull Board behind admin auth + IP allowlist | ✓ SATISFIED | 9/9 gate tests; §13.3 leg f; live 403 unauth (prior run) |

REQUIREMENTS.md cross-check this run: all 13 IDs marked `[x]` and mapped `Phase 7 | Complete` (traceability table lines 267-279); no requirement maps to Phase 7 that any plan left unclaimed.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| tests/integration/wire-timestamps.test.ts | 46-47,128,145 | WR-05 (re-review): WR-01 legs compare Date.now()-based updatedAt against hardcoded same-day seed | ⚠️ Warning (advisory — test robustness, not phase code) | Open in review ledger; this run green (21:17Z > seed); one-line prescribed fix; self-healing after 2026-09-29 |
| src/lib/serialize.ts | 50 | IN-04 (re-review): unparseable-passthrough branch untested — future format drift could silently restore the CR-01 shape | ℹ️ Info | Open in review ledger; known driver forms wire-pinned; rationale documented |
| scripts/check-cron-remnants.mjs | 113,463-478 | IN-05 (re-review): file-NAME check gives generic `mail.*`/`tokens.*` basenames a build-failing blast radius | ℹ️ Info | Documented-by-design friction with written escape hatch in gate header |
| src/app/api/user/profile/route.ts | 128-161 | WR-03: profile password flow writes users.password, engine reads account.password (= WINDOWS #4) | ⚠️ Warning | Deferred to Phase 8 (frontmatter `deferred:`); confirmed untouched by the wave (route header annotates the scope exclusion) |
| (prior CR-01 / WR-01 / WR-02 / WR-04 rows) | — | **CLOSED this wave** — all four verified fixed correctly and completely by the independent re-review (07-REVIEW.md Fix Verification section) and re-verified by this report's F1-F5 behavioral runs | ✗ resolved | Removed from the open-findings impact on this verdict |
| — | — | Debt markers (TBD/FIXME/XXX/HACK/PLACEHOLDER) in wave files | ℹ️ Info | None found (git grep over 15 files this run) |

**The re-review (07-REVIEW.md, 0 Critical / 1 Warning / 2 Info, ledgered in 07-REVIEW-DISPOSITION.md) is advisory to this verdict.** All four targeted findings from the first review are fixed and independently re-review-verified; the three new findings are test-robustness / hardening suggestions that fail no must-have truth.

## Human Verification Required

See frontmatter `human_verification` (2 items — down from 3) and `behavior_unverified_items` (1 item):

1. **Live Google + GitHub login round-trip** — reserved by the deploy record itself for the server deploy (D-40 verbatim assertion). Expected: both logins complete, no re-consent screen. Unchanged by the wave (no auth code touched).
2. **Operator password change** — record §16.6 A.2 PROMINENT flag: the live operator credential is a machine-minted value; must be changed via the auth flow (not the profile route — WINDOWS #4).

**Prior item 3 (check-now poll + non-UTC timestamp display) — REMOVED, now machine-covered.** Re-assessment: the CR-01 fix ships exactly the machine check the prior report said was missing ("Machine-verifiable only after the CR-01 fix lands with a real-DB regression test"). `tests/integration/wire-timestamps.test.ts` drives the REAL drizzle-orm/node-postgres driver with only the session door mocked — the blind spot that let CR-01 through 408 green tests — and pins every emitted timestamp to strict ISO-Z with millisecond round-trip (4/4 GREEN this run). The poll's completion comparison is unit-proven on the legacy naive driver text (7/7 GREEN this run, incl. the G-07-63 case). The display leg is deterministic from there: Dashboard/MonitorDetails/PublicStatus/Profile render via spec-defined `new Date(<ISO-Z>).toLocale*()` call sites (grep-verified this run), which parse UTC-designated text identically in every browser timezone. The specific failure modes the human leg guarded (poll never completing in UTC+, offset-shifted displays) cannot recur without breaking a pinned test. Residual pixel-level visual QA remains ordinary user activity, not a phase verification item.

## Gaps Summary

**No gaps.** The gap-closure wave is complete and verified: CR-01 (the one Critical the first review found — the only real user-facing defect) is fixed via a single well-typed serialization seam adopted by every response boundary and regression-pinned by the repo's first real-driver wire suite; WR-01/WR-02 restore the lost Prisma write semantics; WR-04 closes the armed gate's last scope hole (scripts/ now inside the 466-file perimeter with proven teeth). This verification independently re-ran the wave's behavioral evidence: 32/32 tests green across the four touched suites, armed gate green exit 0, adoption/sweep greps exact, removal state persisted, live stack answering. Every roadmap success criterion is verified in the codebase, in the test suite, and (where production-relevant) in the recorded production proofs. The status remains `human_needed` solely for the two genuinely non-machine-checkable items above — both reserved by the deploy record itself for the server deploy / operator action, and neither reachable by any code this phase could ship.

Recorded deviations already dispositioned on the record (not gaps): operator early flip 2026-09-24 vs announced 09-28 (§13.3 preamble); D-30 interrupted-window rows lost with the destroyed volume, accepted under decision A (§16.6); soak ≈23 h wall with a 14.4 h reboot outage, accepted by the D-36 APPROVE (§14.4-14.5); sanctioned deltas A4/D-24/D-28 (§18.4); the single documented environmental suite exception (health.test.ts EADDRINUSE-:9090 — the deployed production worker holds the port by design).

---

_Verified: 2026-09-29T21:22:22Z_
_Verifier: Claude (gsd-verifier)_
_Re-verification: gap-closure wave 07-10/07-11 (commits df421c7, 66b13a2, 652ddd0, f71cbdc; re-review 52d0254)_
