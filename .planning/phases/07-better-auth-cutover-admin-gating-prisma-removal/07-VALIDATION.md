---
phase: "7"
slug: "better-auth-cutover-admin-gating-prisma-removal"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-22"
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `07-RESEARCH.md` §"Validation Architecture" (2026-09-22).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.11 (unit/integration/worker) + Playwright 1.63.0 (e2e) |
| **Config file** | vitest.config.ts (+ vitest.config.resilience.ts), playwright.config.ts, docker-compose.test.yml |
| **Quick run command** | `pnpm test` (docker test stack up first) |
| **Full suite command** | `pnpm verify` (lint → typecheck → test → schema:gate → worker:boundary → denylist:diff → build → cron:remnants → test:e2e) |
| **Estimated runtime** | ~120 seconds (quick), ~8 minutes (full) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test` + `pnpm typecheck`
- **After every plan wave:** Run `pnpm verify`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (assigned at planning) | TBD | 0 | AUTH-01 | — | Hash-prefix routing: `$2a$/$2b$/$2y$` verify via bcrypt; unknown prefix refuses; hash() emits the pinned default | unit | `pnpm test -- tests/lib/auth-password.test.ts` | ❌ W0 | ⬜ pending |
| (assigned at planning) | TBD | 0 | AUTH-02 | — | Canary login through preserved hash path (framework-level; flip-night canary is manual per D-37/D-38) | integration | `pnpm test -- tests/integration/better-auth-cutover.test.ts` | ❌ W0 | ⬜ pending |
| (assigned at planning) | TBD | 0 | AUTH-03 | — | Cutover migration: ids preserved, boolean backfill counts match, credential rows = users-with-password, role seed + zero-match abort (D-09) | integration + rehearsal-scripted | `pnpm test -- tests/integration/cutover-migration.test.ts` + `pnpm rehearse:migrations` | ❌ W0 (script exists; WR-05 fix + inventory extension first) | ⬜ pending |
| (assigned at planning) | TBD | 0 | AUTH-04 | — | cookieCache: proxy passes valid cookie w/o DB; redirects absent cookie to /login with callbackUrl | unit/integration | `pnpm test -- tests/lib/proxy-auth.test.ts` | ❌ W0 | ⬜ pending |
| (assigned at planning) | TBD | 0 | AUTH-05 | — | Reshape preserves tokens: pre/post non-null refresh/access counts per provider (D-40) | rehearsal-scripted + unit transform test | `pnpm rehearse:migrations` (evidence block) | ❌ W0 | ⬜ pending |
| (assigned at planning) | TBD | 0 | AUTH-06 | — | Notice strip renders inside env window / `null` outside; blast enqueues N queue jobs (console-provider dry-run at rehearsal per D-06) | e2e + unit | `pnpm test:e2e` + `pnpm test -- tests/lib/relogin-blast.test.ts` | ❌ W0 | ⬜ pending |
| (assigned at planning) | TBD | del | AUTH-07 | — | No `next-auth`/`@auth/*`/custom-auth-route remnants after deletion | grep gate (extend `scripts/check-cron-remnants.mjs` — 06-05 precedent) + build green | `pnpm cron:remnants` (extended gate) | ⚠️ gate exists; extension ships with deletion release | ⬜ pending |
| (assigned at planning) | TBD | del | AUTH-08 | — | No Redux auth slice / token mirror / js-cookie imports | grep gate + typecheck red on leftovers | `pnpm cron:remnants` + `pnpm typecheck` | ⚠️ same | ⬜ pending |
| (assigned at planning) | TBD | 0 | AUTH-09 | — | Login with legacy hash upgrades `account.password` (prefix changes); second login verifies | unit (verify-closure + UPDATE, docker PG) | `pnpm test -- tests/lib/auth-password.test.ts` | ❌ W0 (same file as AUTH-01) | ⬜ pending |
| (assigned at planning) | TBD | del | DRZ-07 | — | Zero `@prisma/*` imports/deps; `prisma/` dir absent; build script clean; schema:gate green | grep gate + schema gate + build | `pnpm schema:gate` + `pnpm cron:remnants` (extended) | ⚠️ schema:gate exists; absence-gate is deletion-release | ⬜ pending |
| (assigned at planning) | TBD | 0 | EML-04 | — | sign-up/reset enqueue `email-transactional` jobs with rendered bytes; no in-request transport | integration (injectable queue producer — 06-02 harness) | `pnpm test -- tests/integration/auth-email-hooks.test.ts` | ❌ W0 (render fixtures re-captured in tests/lib/email-render.test.ts) | ⬜ pending |
| (assigned at planning) | TBD | 0 | SEC-04 | — | feedback GET: admin 200 / non-admin 403 / anon 401; POST stays 200-for-all-authed | integration (handler harness — tests/api/_harness.ts precedent) | `pnpm test -- tests/api/feedback-admin.handler.test.ts` | ❌ W0 | ⬜ pending |
| (assigned at planning) | TBD | 0 | OBS-04 | — | Bull Board: allowlisted IP + admin cookie → 200; non-admin → 403; non-allowlisted IP → refusal; D-16 audit line emitted | integration (worker health-server harness — tests/worker/health.test.ts precedent) | `pnpm test -- tests/worker/bull-board-gate.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/lib/auth-password.test.ts` — AUTH-01/AUTH-09 (prefix routing + lazy rehash)
- [ ] `tests/integration/better-auth-cutover.test.ts` — AUTH-02 (canary through the framework on docker PG)
- [ ] `tests/integration/cutover-migration.test.ts` — AUTH-03 (counts/abort semantics) + rehearse-migrations WR-05 fix (03-REVIEW carry-forward: hard-coded journal count at `rehearse-migrations.mjs:505`)
- [ ] `tests/lib/proxy-auth.test.ts` — AUTH-04
- [ ] `tests/lib/relogin-blast.test.ts` — AUTH-06 fan-out
- [ ] `tests/api/feedback-admin.handler.test.ts` — SEC-04
- [ ] `tests/worker/bull-board-gate.test.ts` — OBS-04 (extends tests/worker/health.test.ts harness)
- [ ] `tests/integration/auth-email-hooks.test.ts` — EML-04 (fixtures re-capture in tests/lib/email-render.test.ts)
- [ ] Extended remnant gate (AUTH-07/AUTH-08/DRZ-07) — ships with the deletion release's own plan per D-29

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Flip-night canary: credentials login (old password) + one Google + one GitHub login with NO re-consent screen | AUTH-02, AUTH-05 | Requires real production OAuth accounts and the actual flip (D-37/D-38/D-40) | After the flip deploy: operator logs in with old password; completes Google then GitHub login asserting no consent screen; record in `07-DEPLOY-RECORD.md` before the soak clock starts |
| Rehearsal redeploy-rollback drill (flip stand-in → verify → redeploy previous artifact → verify NextAuth → re-flip) | AUTH-02 (D-35) | Requires the anonymized-snapshot stand-in topology and both release artifacts | Per D-35 during the full flip rehearsal; evidence into `07-DEPLOY-RECORD.md` |
| Console-provider email round-trips (verification + reset + blast dry-run with exact rendered bytes) | EML-04, AUTH-06 (D-06) | Byte inspection is a human sign-off step at rehearsal | Rehearsal: inspect console-provider stdout dumps; operator approves copy per D-06 |
| 24h soak typed-gate checklist (dead errors quiet, admin gate matrix, notice strip, queue round-trips) | AUTH-06, SEC-04, OBS-04 (D-31) | Live production observation over 24h | Run the typed gate command; PASS output + evidence into `07-DEPLOY-RECORD.md` before the deletion release |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
