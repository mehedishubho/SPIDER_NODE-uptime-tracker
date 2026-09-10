---
phase: 02-foundations-theme-infrastructure
plan: 06
subsystem: type-gate
tags: [typecheck-flip, fnd-02, d-10, d-11, d-12, lint-gate, ignore-build-errors, canary-proof]

requires:
  - phase: 02-01
  provides: pnpm toolchain + Node 24 pin (@types/node alignment target)
  - phase: 02-03
  provides: characterization suite for monitored logic (cron-logic/db-batcher integration tests)
  - phase: 02-05
  provides: API handler contracts (71 handler-import + 12 HTTP-level) re-run green after this plan's fixes
provides:
  - `pnpm typecheck` exit 0 and load-bearing — every later plan compiles under a real gate (D-13)
  - `pnpm build` type-gated, canary-proven in both directions (A6 closed empirically)
  - `pnpm lint` exit 0 — FND-02's "lint/typecheck gates green" fully delivered (397 errors fixed honestly, zero suppression directives)
  - First fully-green `pnpm verify` chain (22 s vs the 300 s D-20 budget) — the DEP-04 gate operators run before every deploy from now on
affects: [02-07/02-08/02-09 (run under green typecheck + lint), Phase 3+ migrations (type gate enforced at build), every future plan (verify chain now expects green at every step)]

tech-stack:
  added: []
  patterns: [catch-cast error narrowing ((err as Error).message — runtime byte-identical to the old any-access), generated-code exclusion at the LINTER level (eslint globalIgnores src/generated/** mirroring the tsconfig-exclude discretion), React-Compiler-era hooks rules satisfied by restructure not suppression]

key-files:
  created: []
  modified: [package.json, pnpm-lock.yaml, eslint.config.mjs, global.d.ts, next.config.ts, src/app/(commonLayout)/docs/page.tsx, src/app/api/cron/check/route.ts, src/app/api/cron/cleanup/route.ts, src/app/api/monitors/[id]/route.ts, src/app/api/user/profile/route.ts, src/components/Auth/ForgotPasswordForm.tsx, src/components/Auth/VerifyEmailForm.tsx, src/components/Auth/VerifyEmailSent.tsx, src/components/Dashboard/ProfileComponent.tsx, src/components/Dashboard/TelegramSettings.tsx, src/components/Features/UptimeMonitoringContent.tsx, src/components/Pages/TermsContent.tsx, src/components/home/HowItWorks.tsx, src/components/ui/sidebar.tsx, src/lib/auth.ts, src/lib/cleanup-logic.ts, src/lib/cron-logic.ts, src/lib/db-batcher.ts]
  deleted: [next.config.js, next.config.mjs]

key-decisions:
  - "The expected typecheck pile did not exist: tsc --noEmit (cache-free, --incremental false, 134 src files + .next/types validators, prisma generate first) measured 0 errors — D-12 gate trivially passed; the plan author's 'red by expectation' assumption was wrong at execution time. The REAL gate debt was lint (397 errors), which 02-02's deferred-items log had explicitly routed to this plan ('FND-02 lint gates green needs a lint pass beyond the typecheck flip') — fixed here under deviation Rule 2"
  - "eslint globalIgnores extended to src/generated/** — 367 of the 397 lint errors were in the regenerated Prisma client (index.d.ts 151, runtime/client.d.ts 130, runtime/*.js 86); generated code is not ours to fix, the same rationale as the plan's tsconfig-exclude discretion (which was NOT needed: zero tsc errors originate under src/generated)"
  - "tsconfig.json untouched — exclude decision recorded as NOT applied with evidence (generated client participates in the tsc program only via .d.ts entry points, skipLibCheck covers them, 0 errors)"
  - "auth.ts 'as any' was DEAD and removed outright — @auth/prisma-adapter's return type (@auth/core Adapter) is assignable to NextAuthOptions.adapter as-is; minimal-churn hierarchy: removal > precise assertion > double assertion"
  - "React-Compiler hooks rules fixed by restructure, not suppression: VerifyEmailForm's no-token branch moved inside the async fn (identical synchronous sequence — rule stops flagging, render sequence unchanged); sidebar skeleton width useMemo([]) -> useState lazy initializer (computed once per mount under BOTH forms, and useState is strictly MORE stable — React may discard a useMemo cache but never re-runs an initializer)"
  - "Pinned defects preserved byte-for-byte through the fixes: cron/check + cron/cleanup 500 bodies still echo error.message AND error.stack (the S-4/Phase-6 red/green marker) via (err as Error).x casts — cast changes types, never runtime values"
  - "Commit boundary correction mid-plan: the earlier 'git rm' staged deletions rode into the Task 2 commit; split via git reset --soft (working tree untouched) so Pitfall 11's same-commit mandate holds — deletions + flip live in 02d88a8 together"

requirements-completed: [FND-02]

metrics:
  duration: 5124s wall (~86 min, includes a mid-run provider usage-limit interruption after Task 1; effective work ~35 min)
  completed: "2026-09-10T20:02:34Z"
  tasks: 3
  files: 25
  status: complete
---

# Phase 2 Plan 6: Fix-All-Then-Flip Typecheck Cutover Summary

**One-liner:** The type gate is real — pile sized at 0 type errors (D-12 trivially passed), the actual debt was 397 lint errors (routed here by 02-02's deferred log) fixed with honest types and zero suppression, ignoreBuildErrors flipped off with canary proof both directions, and the first fully-green `pnpm verify` ran in 22 s.

## Task 1 — Pile sizing + environment alignment (D-12 gate)

- `pnpm exec prisma generate && pnpm typecheck`: **0 errors** — verified three ways (script run, cache-free `tsc --noEmit --incremental false`, program audit via `--listFilesOnly`: 134 src files + `.next/types` route validators + generated client d.ts entry points all in the program). D-12 gate: 0 <= ~100 → proceed, no fix wave needed.
- Per-file distribution: **empty** (the expected src/ type debt did not exist).
- `@types/node` ^20.19.26 -> **^24.13.4** (research-sanctioned Node 24 pin alignment); re-check after upgrade: still 0 errors.
- tsconfig exclude decision: **NOT applied** — evidence: `src/generated/prisma` enters the tsc program only through 6 `.d.ts` files (skipLibCheck applies) and produces 0 errors.
- Commit: c45a691.

## Task 2 — Fix every error (D-11/D-19)

The typecheck fix set was empty; the task's real work became the **lint gate** (Rule 2 deviation, see below). Inventory of the 397 lint errors:

| Rule | Count | Where |
|---|---|---|
| no-empty-object-type | 113 | generated d.ts (281 of these + no-require-imports 62 + others in src/generated) |
| no-explicit-any | 181 | 160 generated / **21 real src** |
| no-require-imports | 62 | generated runtime js |
| no-this-alias | 21 | generated |
| no-unescaped-entities | 7 | real src (6 files) |
| no-unsafe-function-type | 4 | generated |
| set-state-in-effect / purity | 1 + 1 | real src |
| others (5 rules) | 7 | generated + real src |

Fixes applied (one line each):

- **eslint.config.mjs** — globalIgnores += `src/generated/**` (removes 367 generated-code errors; regenerated by every build, not hand-editable).
- **global.d.ts** — 4x `const value: any` -> `string` (imports are consumed only as next/image `src`, which accepts string).
- **src/app/api/cron/check/route.ts** — `catch (err: any)` -> `catch (err)` + `(err as Error).message/.stack`; the pinned 500 stack-echo body preserved byte-for-byte.
- **src/app/api/cron/cleanup/route.ts** — same catch-cast fix, pinned body preserved.
- **src/app/api/monitors/[id]/route.ts** — `body: any` -> `{ name?/url?/interval?: string; isActive?: boolean }`; `updateData: Record<string,any>` -> precise `{name?/url?: string; interval?: number; isActive?: boolean}` (prisma UpdateInput accepts).
- **src/app/api/user/profile/route.ts** — `updateData` -> `{ name?/telegramChatId?/timezone?/image?/password?: string }` (exact key set incl. password branch).
- **src/lib/cron-logic.ts** — catch-cast for the fetch-failure log (`(error as Error)?.message ?? String(error)` — identical for Error, DOMException, and non-object throws); `updateData: any` -> explicit 6-field shape (schema fields all String/Int/Float/DateTime — no enums).
- **src/lib/db-batcher.ts** — `pendingPings: any[]` -> `PendingPing[]` interface (monitorId/status/responseTime/createdAt), createMany-compatible.
- **src/lib/cleanup-logic.ts** — catch-cast in the failure return.
- **src/lib/auth.ts** — `PrismaAdapter(prisma) as any` -> cast removed entirely (assignable as-is).
- **src/components/Dashboard/ProfileComponent.tsx** — 3x catch-cast; `payload: any` -> `Partial<Record<"name"|"telegramChatId"|"timezone"|"currentPassword"|"newPassword"|"image", string>>`.
- **src/components/Dashboard/TelegramSettings.tsx** — 3x catch-cast.
- **src/components/Auth/VerifyEmailForm.tsx** — no-token branch moved inside `verifyEmail()` (rule satisfied; the setStatus/setMessage sequence still runs synchronously in the same effect tick — render sequence unchanged).
- **src/components/ui/sidebar.tsx** — skeleton width `useMemo([])` -> `useState` lazy initializer (once per mount either way; purity rule satisfied).
- **6 JSX files** (docs/page, ForgotPasswordForm, VerifyEmailSent, UptimeMonitoringContent, TermsContent, HowItWorks) — 7 entity escapes (`&quot;`/`&apos;`; rendered text identical).

Gates: `pnpm typecheck` exit 0 · `pnpm lint` exit 0 (0 errors, 37 pre-existing warnings remain — non-gating, no --max-warnings in the chain) · `pnpm test` **102/102 green** (monitored logic re-run per D-19) · diff scan: **0** added `@ts-*`/`eslint-disable` directives.
- Commit: 7fbcf01.

## Task 3 — The flip + canary proof + first-green verify

- `next.config.ts`: `typescript: { ignoreBuildErrors: true }` block deleted (reactCompiler kept).
- `next.config.js` + `next.config.mjs` deleted (both were empty shadowing hazards; Pitfall 11 — same commit as the flip).
- **Canary proof, direction 1:** `src/canary-type-gate.ts` with `export const canary: number = "this is not a number";` -> `pnpm build` **FAILED**, exit 1, `src/canary-type-gate.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.`
- **Canary proof, direction 2:** canary deleted -> `pnpm build` **PASSED**, exit 0 ("Compiled successfully", 39/39 static pages). Assumption A6 closed empirically.
- **`pnpm verify` (first fully-green): exit 0 in 22 s** — docker up -> lint (0 errors) -> typecheck (0) -> vitest (9 files / 102 tests) -> build (green under the real gate) -> playwright (13 passed). Budget: 300 s warm (D-20) — used 7%.
- Commit: 02d88a8.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Lint gate fixed in-plan (397 pre-existing errors)**
- **Found during:** Task 3 (`pnpm verify` failed at the lint step — 397 errors)
- **Issue:** The plan's must-have #6 ("`pnpm verify` fully green") and FND-02 ("lint/typecheck gates green") are unsatisfiable with lint red; 02-02's deferred-items.md had explicitly routed the lint pass to 02-06 planning ("fold into 02-06 planning or a dedicated plan") but the plan text only carried the typecheck flip.
- **Fix:** Honest lint-fix wave (21 any-eliminations, 7 entity escapes, 2 hooks-rule restructures, generated-code ignore) with zero suppression directives; behavior proven unchanged by the 102-test suite. The expected typecheck pile was empty, so the fix budget went where the debt actually was.
- **Files modified:** 20 (listed in key-files)
- **Commit:** 7fbcf01

**2. [Rule 3 - Blocking issue] Commit boundary correction**
- **Found during:** Task 2 commit — the Task 3 `git rm` staged deletions rode into the Task 2 commit
- **Fix:** `git reset --soft HEAD~1` (working tree untouched), re-committed with correct boundaries so Pitfall 11's same-commit mandate holds (deletions + flip together in 02d88a8)
- **Commits:** 7fbcf01 (fixes), 02d88a8 (flip)

## Flagged-for-Review Errors

None — no fix required a runtime-logic change (D-11 halt condition never triggered).

## Known Stubs

None.

## Threat Register Dispositions

| Threat | Outcome |
|---|---|
| T-02-11 (fixes silently changing behavior) | Mitigated — 102/102 green after every monitored-logic edit; all casts runtime-identical; pinned defect bodies (500 stack echo) byte-preserved |
| T-02-12 (stale configs no-op the flip) | Mitigated — same-commit deletion + canary FAILED/PASSED proof both directions |
| T-02-13 (suppression directives) | Mitigated — diff scan 0 for @ts-* AND eslint-disable; no rule severities lowered; the only config relief is the generated-code ignore (regenerated artifacts, not source) |

## Self-Check: PASSED

- Commits exist: c45a691, 7fbcf01, 02d88a8 (git log verified)
- `next.config.js`/`next.config.mjs` absent; `ignoreBuildErrors` grep on next.config.ts: 0 matches
- `pnpm verify` exit 0 recorded above; package.json shows `"@types/node": "^24.13.4"`
