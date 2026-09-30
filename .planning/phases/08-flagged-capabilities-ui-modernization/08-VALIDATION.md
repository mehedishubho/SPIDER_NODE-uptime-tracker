---
phase: "8"
slug: flagged-capabilities-ui-modernization
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-30"
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `08-RESEARCH.md` §Validation Architecture (2026-09-30). Task IDs attach during planning.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4 (unit/integration/handler) + Playwright 1.63 (e2e/api projects) |
| **Config file** | `vitest.config.ts` (+ `vitest.config.resilience.ts` for test:resilience); `playwright.config.ts` |
| **Quick run command** | `pnpm vitest run tests/<file>` (single file) |
| **Full suite command** | `pnpm verify` (lint → typecheck → test → schema:gate → worker:boundary → denylist:diff → build → cron:remnants → e2e) |
| **Estimated runtime** | ~30–40s unit/integration per file; full verify minutes-scale (02-07 precedent: ~31s warm + build + e2e) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run <touched-suite>` (+ `pnpm lint && pnpm typecheck` fast loop)
- **After every plan wave:** Run `pnpm verify`
- **Before `/gsd-verify-work`:** Full suite must be green; three release soaks per CONTEXT D-37 with deploy-record evidence; AI flip smoke per D-38
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

Task IDs attach during planning; the requirement-level map below is binding (source: 08-RESEARCH.md).

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-06-T2 | 08-06 | 5 | AI-01 | T-08-17 | flag off → routes 404/inert; verify green with zero AI keys | unit (handler) | `pnpm vitest run tests/api/ai-routes.handler.test.ts -t "flag off"` | ❌ W0 | ⬜ pending |
| 08-07-T1 | 08-07 | 6 | AI-01 | T-08-26 | UI renders zero AI trace when off (D-21) | e2e | `pnpm test:e2e -- --grep "AI flag off"` | ❌ W0 | ⬜ pending |
| 08-06-T2 | 08-06 | 5 | AI-02 | T-08-16..20 | 401 without session; 429 + Retry-After per-user buckets; input cap; timeout path | unit (handler) | `pnpm vitest run tests/api/ai-routes.handler.test.ts` | ❌ W0 | ⬜ pending |
| 08-06-T1 | 08-06 | 5 | AI-02 | T-08-18 | provider selection throw-early (each env-triple state) | unit | `pnpm vitest run tests/lib/ai-provider.test.ts` | ❌ W0 | ⬜ pending |
| 08-06-T2 | 08-06 | 5 | AI-02/03 | T-08-15/22 | streaming route returns UIMessage/text stream (stub model) | unit + e2e stub | `pnpm vitest run tests/api/ai-stream.handler.test.ts` | ❌ W0 | ⬜ pending |
| 08-06-T2 | 08-06 | 5 | AI-03 | T-08-19/22 | post-mortem composes incident+pings evidence; zero DB writes from AI routes | unit | `pnpm vitest run tests/api/ai-post-mortem.test.ts` | ❌ W0 | ⬜ pending |
| 08-07-T2 | 08-07 | 6 | AI-04 | T-08-21/24 | assistant output validates against create-route schema; partial-fill mapping | unit | `pnpm vitest run tests/api/ai-assistant.test.ts` | ❌ W0 | ⬜ pending |
| 08-06-T3 | 08-06 | 5 | AI-05 | T-08-SC | no `lib/ai`/`ai-sdk` import under `src/worker/**` | gate | `pnpm cron:remnants` (PHASE8 AI-in-worker leg, belt-and-braces beside `pnpm worker:boundary`) | ✓ (extend) | ⬜ pending |
| 08-01-T1 | 08-01 | 1 | DAT-11 | T-08-02 | windowed SQL math agrees with D-36 derivation on identical inputs | integration (test DB) | `pnpm vitest run tests/worker/windowed-uptime.test.ts` | ❌ W0 | ⬜ pending |
| 08-01-T2 | 08-01 | 1 | DAT-11 | T-08-01 | maintenance dispatcher accepts new job name; scheduler upserted | unit | `pnpm vitest run tests/worker/maintenance-windowed.test.ts` | ❌ W0 | ⬜ pending |
| 08-01-T4 | 08-01 | 1 | DAT-11 | T-08-03 | migration additive + rehearsed (carve-out list extended) | rehearsal | `pnpm rehearse:migrations` | ✓ (extend) | ⬜ pending |
| 08-02-T3 | 08-02 | 2 | UI-02/D-33 | T-08-06 | react-icons/sweetalert2 remnant gates RED on re-introduction | gate | `pnpm verify` (extended gate legs) | ✓ (extend) | ⬜ pending |
| 08-03-T1..T3 | 08-03 | 3 | UI-04 | T-08-07/08 | polling fetches abort on unmount; timers clear; single Toaster; hydration-safe URL | unit/e2e | `pnpm test:e2e -- tests/e2e/ui-robustness.spec.ts` | ❌ W0 | ⬜ pending |
| 08-04-T3 | 08-04 | 4 | UI-05 | T-08-09 | characterization + contract suites stay green (criterion 5) | regression | `pnpm test && pnpm test:e2e` | ✓ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/api/ai-*.handler.test.ts` — AI route contracts (session/flag/limiter/cap/streaming) — created by 08-06 (ai-routes/ai-stream/ai-post-mortem) and 08-07 (ai-assistant)
- [ ] `tests/lib/ai-provider.test.ts` — env-triple selection matrix (mirrors email provider tests) — created by 08-06 Task 1
- [ ] `tests/worker/windowed-uptime.test.ts` + `tests/worker/maintenance-windowed.test.ts` — recompute math + dispatcher — created by 08-01 Tasks 1-2
- [ ] Extended gate legs: react-icons/sweetalert2 remnants (+ lucide-react insurance, AI-in-worker rule) in the cron-remnants family, wired into `pnpm verify` — 08-02 Task 3 (deps) + 08-06 Task 3 (AI rule)
- [ ] E2E: stub-provider AI specs + flag-off zero-trace spec (08-07, tests/e2e/ai-surfaces.spec.ts); UI robustness specs (08-03, tests/e2e/ui-robustness.spec.ts); redesign specs (08-04/08-05)
- [ ] Characterization/contract suites stay untouched-green — the regression net for criterion 5 (asserted in 08-04/08-05/08-07 full-verify tasks)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Release soaks ×3 (windowed backend / redesign / AI) | D-37 | Live-system soak windows with deploy-record evidence | Follow runbook §4 per release; record in `08-DEPLOY-RECORD.md` |
| AI flip smoke (flag on in production) | D-38 | Live provider keys + real streaming | Flip `AI_ENABLED=true` after soak; smoke post-mortem + assistant on real data |
| Visual redesign acceptance (light intentional, both modes) | UI-03/UI-05 | Perception judgment | Manual UAT pass per phase close (02-UAT precedent) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
