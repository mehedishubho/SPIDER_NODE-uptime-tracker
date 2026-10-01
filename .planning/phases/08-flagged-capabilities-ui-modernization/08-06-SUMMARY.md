---
phase: 08-flagged-capabilities-ui-modernization
plan: 06
subsystem: ai-provider-foundation
tags: [ai-sdk, provider-selection, env-gated, lib-ai, deps]
requires:
  - "08-04 (UI substrate stable for the later AI UX)"
  - "08-05 (token substrate stable)"
  - "08-09 (final post-redesign surface that 08-07 mounts AI onto)"
provides:
  - "getAiModel() — env-gated, throw-early, lazily-cached LanguageModel resolution (glm/openai/anthropic/custom)"
  - "aiEnabled() — the D-04 master-flag boolean for 08-10 route guards and 08-07 server-page flag propagation"
  - "AI_* env contract documented in .env.example (GLM commented day-1 default per D-03)"
  - "pinned AI SDK v7 + zod dependency set for the whole AI leg"
affects:
  - "package.json / pnpm-lock.yaml (six new pinned dependencies)"
  - ".env.example (new dated Phase-8 AI_* block)"
  - "08-10 (builds the guarded /api/ai/* streaming routes on this foundation)"
  - "08-07 (consumes aiEnabled() for the AI UX surfaces)"
actuals:
  tokens: 9600
  tasks: 2
  commits: 5
tech-stack:
  added:
    - "ai@7.0.123 (exact pin)"
    - "@ai-sdk/react@4.0.126 (exact pin)"
    - "@ai-sdk/openai-compatible@3.0.60 (exact pin)"
    - "@ai-sdk/openai@4.0.82 (exact pin)"
    - "@ai-sdk/anthropic@4.0.69 (exact pin)"
    - "zod@4.6.5 (exact pin, current v4 line)"
  patterns:
    - "lib/ai provider selection mirrors src/lib/email/index.ts (cached instance, throw-early on unknown values) with the AI_ENABLED master gate added BEFORE any env read"
    - "provider-package factories mocked via in-file vi.hoisted seams so selection tests pin factory ARGUMENTS (name/baseURL/apiKey/includeUsage) while pnpm typecheck pins the real call shapes"
key-files:
  created:
    - src/lib/ai/index.ts
    - src/lib/ai/providers/glm.ts
    - src/lib/ai/providers/openai.ts
    - src/lib/ai/providers/anthropic.ts
    - src/lib/ai/providers/custom.ts
    - tests/lib/ai-provider.test.ts
  modified:
    - package.json
    - pnpm-lock.yaml
    - .env.example
key-decisions:
  - "OQ1 resolution executed: all five SDK packages installed at exact research-audit pins even though Task 1 wires only glm — the full env-value map ships so a provider swap is an env edit, never a code change (D-02)"
  - "zod legitimacy-check passed before install: latest 4.6.5 IS the current v4 line, repository colinhacks/zod, no postinstall/preinstall scripts, not deprecated — no blocking-human checkpoint needed"
  - "AI_BASE_URL is required ONLY for AI_PROVIDER=custom and the throw lives in providers/custom.ts naming the var (the factory owns its requirement); glm hard-pins the Z.ai base URL as GLM_BASE_URL"
  - "Master gate before cache: getAiModel() checks AI_ENABLED on EVERY call (a flipped-off flag invalidates even a cached resolution) — the flag-off default posture (AI-01) is authored here; route-level 404 proof lands in 08-10"
  - "The unknown-value error lists all four accepted values and was authored in Task 1 by plan (Task 2's RED therefore shows that one case green — expected, documented in the RED record notes)"
patterns-established:
  - "lib/ai selection matrix: AI_ENABLED gate -> env-triple validation naming exact missing vars -> factory dispatch -> lazy cache (the email-pattern mirror for the AI leg)"
  - "SDK-factory mock seams via vi.hoisted returning config-echoing callables — reusable for 08-10 handler tests that need provider isolation"
requirements-completed: []
coverage:
  - id: "08-06 Task 1 verify"
    description: "Day-1 matrix green + six pinned packages + five AI_* env entries + typecheck"
    verification:
      - kind: test
        ref: "pnpm vitest run tests/lib/ai-provider.test.ts (11/11 at task close; tracer gate re-ran all four checks end-to-end)"
        status: pass
      - kind: command
        ref: "pnpm ls ai @ai-sdk/react @ai-sdk/openai-compatible @ai-sdk/openai @ai-sdk/anthropic zod (0 missing, exact pins)"
        status: pass
      - kind: command
        ref: "grep -c \"^AI_ENABLED=\" .env.example (= 1)"
        status: pass
      - kind: command
        ref: "pnpm typecheck (0 errors)"
        status: pass
  - id: "08-06 Task 2 verify"
    description: "Full selection matrix green + typecheck"
    verification:
      - kind: test
        ref: "pnpm vitest run tests/lib/ai-provider.test.ts (16/16 — full env-triple matrix: flag-off, incomplete triple, glm/openai/anthropic/custom, custom-without-base-URL, unknown value, caching, no import-time resolution)"
        status: pass
      - kind: command
        ref: "pnpm typecheck (0 errors)"
        status: pass
  - id: "plan verification sweep"
    description: "Post-plan re-run of every plan-level criterion + TDD gate"
    verification:
      - kind: command
        ref: "git log -E --grep '^test\\(08-06\\):' (>=1: 8372e8b, 9e81051) and '^feat\\(08-06\\):' (>=1: a4f8ed5, 4af1b12)"
        status: pass
  - id: "TDD RED gates"
    description: "Both tasks validated RED_EVIDENCE_OK before GREEN"
    verification:
      - kind: command
        ref: "node gsd-core/bin/gsd-tools.cjs check tdd-red-evidence .git/tdd-red-evidence-08-06-task{1,2}.json"
        status: pass
  - id: "tracer feedback gate (Task 1)"
    description: "End-to-end verify re-run after the tracer slice (end-of-phase mode, automated-only verify -> re-run and continue)"
    verification:
      - kind: command
        ref: "all four Task-1 <verify> checks re-run green (vitest 11/11, pnpm ls 0 missing, grep = 1, typecheck clean)"
        status: pass
  human_judgment: false
  rationale: "Every acceptance criterion is command/test-verified this session; no visual or manual surface exists in this plan (routes/UI land in 08-10/08-07)."
duration: 11 min
completed: 2026-10-01
status: complete
plan_head_before: 5f78295bde9b32288ac72b7b8e0ae131848102da
plan_head_after: 8f23827f9264d52699d9d48a8136f42f5477b5e0
---

# Phase 8 Plan 06: AI Provider Foundation Summary

**One-liner:** Pinned Vercel AI SDK v7 foundation: an env-gated `lib/ai` provider layer (GLM day-1 default via `@ai-sdk/openai-compatible` at the Z.ai endpoint, throw-early env-triple validation, full glm/openai/anthropic/custom matrix, lazily cached) plus the `AI_*` env contract — 16 selection-matrix tests, zero routes/UI.

## Performance

| Metric | Value |
|--------|-------|
| Duration | 11 min (single session, 2026-10-01T10:46:57Z → 10:57:33Z) |
| Tasks | 2 / 2 |
| Files | 9 (6 created, 3 modified) |
| Actual tokens (diff chars / 4) | ~9,600 vs 32,000 estimate (the estimate covered the full research-audit reading; the plan's code surface was compact and the email pattern was mirrored directly) |
| Commits | 5 (1 chore + 2 test/RED + 2 feat/GREEN) |

## Accomplishments

- **Dependencies (T-08-SC mitigated):** all six packages installed at EXACT research-audit pins — ai@7.0.123, @ai-sdk/react@4.0.126, @ai-sdk/openai-compatible@3.0.60, @ai-sdk/openai@4.0.82, @ai-sdk/anthropic@4.0.69 (all github.com/vercel/ai, dev-only scripts, no postinstall) + zod@4.6.5 (legitimacy-checked: colinhacks/zod, no postinstall, not deprecated, latest == current v4 line). All signals matched the plan — no blocking-human checkpoint fired.
- **Task 1 (tracer, TDD):** `src/lib/ai/index.ts` (getAiModel + aiEnabled) + `providers/glm.ts` + the `.env.example` AI_* block, proven by the 11-case day-1 matrix. RED validated (RED_EVIDENCE_OK, module-absent failures, 11 test-named), then GREEN; tracer feedback gate re-ran all four `<verify>` checks end-to-end green (end-of-phase mode → continue).
- **Task 2 (auto, TDD):** the remaining three factories (`openai.ts`, `anthropic.ts`, `custom.ts`) completing the selection matrix. RED validated (RED_EVIDENCE_OK, 4 target failures on assertion; the unknown-value case was expected-green because Task 1 authored the accepted-set error by plan), then GREEN 16/16.
- **Selection contract (D-01/D-02/D-03/D-04):** AI_ENABLED master gate throws when not literally "true" (routes gate first); incomplete triple throws naming the exact missing vars; unknown provider throws listing glm/openai/anthropic/custom; custom without AI_BASE_URL throws naming the var; glm wires createOpenAICompatible({ name: "glm", baseURL: "https://api.z.ai/api/paas/v4", includeUsage: true }); resolution is lazily cached per module instance and never runs at import time.
- **T-08-18 respected:** AI_* (including the API key) is read exclusively inside `src/lib/ai/**`, server-side; no NEXT_PUBLIC_* variants; error messages name variables and never echo the key; `aiEnabled()` exports only the boolean that may cross to the client.

## Task Commits

| Task | Commit | Type | Subject |
|------|--------|------|---------|
| 1 | 23f7a2f | chore | install pinned AI SDK + zod dependencies |
| 1 | 8372e8b | test (RED) | add failing test for lib/ai provider selection (day-1 matrix) |
| 1 | a4f8ed5 | feat (GREEN) | implement lib/ai glm day-1 provider path (env-gated selection) |
| 2 | 9e81051 | test (RED) | add failing tests for openai/anthropic/custom factories |
| 2 | 4af1b12 | feat (GREEN) | implement openai/anthropic/custom factories completing the selection matrix |

## Files Created / Modified

**Created:** `src/lib/ai/index.ts`, `src/lib/ai/providers/glm.ts`, `src/lib/ai/providers/openai.ts`, `src/lib/ai/providers/anthropic.ts`, `src/lib/ai/providers/custom.ts`, `tests/lib/ai-provider.test.ts`

**Modified:** `package.json` + `pnpm-lock.yaml` (six pinned deps), `.env.example` (dated Phase-8 2026-10-01 AI_* block: AI_ENABLED empty default, AI_PROVIDER/AI_MODEL/AI_API_KEY/AI_BASE_URL, commented GLM example with the flip-time model-id note per research A1)

## Decisions Made

See frontmatter `key-decisions`. Highlights: full package set installed now (OQ1 — swap stays env-only), AI_BASE_URL ownership in the custom factory, master-gate-before-cache ordering, and the Task-1-authored unknown-value error (which made one Task-2 RED case expected-green by design).

## Deviations from Plan

**1. [Rule 1 - Bug] TypeScript narrowing gap in the missing-vars guard**
- **Found during:** Task 1 GREEN (pnpm typecheck)
- **Issue:** The first guard form (`provider === undefined || provider === ""` pushed into a `missing` array) does not narrow `string | undefined` at the dispatch site — two TS2322 errors at the `createGlmModel` call.
- **Fix:** Restructured to `if (!provider || !model || !apiKey) { build+throw missing list }` — identical error text/behavior (empty string still counts as missing), and control-flow narrowing makes the triple `string` afterwards.
- **Files modified:** `src/lib/ai/index.ts`
- **Verification:** `pnpm typecheck` green; 11/11 tests green (incl. the missing-vars cases).
- **Commit:** a4f8ed5 (fix folded into the Task 1 GREEN commit it blocked)

**2. [Process - expected-green RED case] Task 2's unknown-value test passed at RED**
- Not a defect: the plan's Task 1 action explicitly authors the accepted-set error ("the accepted-set error is authored here even though the remaining factories land in Task 2"), so that pin was already green. The Task-2 RED record documents it (`notes` field) and the target test (openai factory) failed on an assertion — RED_EVIDENCE_OK.

**3. [Environmental - transient] First `pnpm add` invocation completed without output or effect**
- Re-ran the identical command; it installed normally (all six packages). No package substitution attempted, no ambiguity — the plan's exact pins were used both times.

**Total deviations:** 3 (1 Rule-1 auto-fix, 1 documented-by-plan process note, 1 environmental transient).
**Impact:** None on scope, contracts, or verification — all acceptance criteria green.

## Issues Encountered

- **Concurrent operator commits (informational, no impact):** the operator concurrently committed phase-06 UAT closeout work to the same checkout during this plan (5f78295, 6a0747a, 8997885 — files: `06-UAT.md`, `06-VERIFICATION.md` working copy, `ROADMAP.md`). Zero file overlap with this plan; all five 08-06 commits are intact and linear. The `commits:` frontmatter counts only `(08-06)` commits (5) for this reason; `plan_head_before`/`plan_head_after` bracket includes the operator's interleaved commits by construction.
- The pre-existing modified files `skills-lock.json` and `tests/resilience/observations.json` were left untouched (scope boundary).

## User Setup Required

None (`user_setup: []`). Flip-time operator action (documented in `.env.example`, NOT this plan): set the AI_* triple with a confirmed GLM model id when AI is enabled (08-08 Release C / D-38).

## Next Phase Readiness

- **08-10 (routes):** `getAiModel()` + `aiEnabled()` are the consumption seams — route guards gate on `aiEnabled()` BEFORE importing/calling the model getter; the D-10 usage line can rely on `includeUsage: true` from the glm wiring.
- **08-07 (AI UX):** flag propagation is `aiEnabled()` → server page prop → client tree (only the boolean crosses).
- **Rule 15 / AI-05:** no AI import exists under `src/worker/**`; the worker-boundary gate stays green.
- **Shared requirements AI-01/AI-02:** deliberately NOT marked complete here — they span 08-10/08-08 (route 404s when off, flag proven both ways in production). `requirements-completed: []` per the false-signal precedent.

## Self-Check: PASSED

- Files exist: src/lib/ai/index.ts, src/lib/ai/providers/{glm,openai,anthropic,custom}.ts, tests/lib/ai-provider.test.ts, .env.example AI_* block — all verified on disk.
- Commits exist: 23f7a2f, 8372e8b, a4f8ed5, 9e81051, 4af1b12 — all in `git log`.
- All plan verification re-run post-plan: 16/16 matrix tests, six exact pins in package.json, 5 AI_* entries + GLM commented example in .env.example, typecheck green, TDD gate greps ≥1 test + ≥1 feat commit, both RED records RED_EVIDENCE_OK.
- Tracer feedback gate re-verified end-to-end (passed; continued per end-of-phase mode).
