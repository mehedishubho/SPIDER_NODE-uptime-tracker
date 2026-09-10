---
phase: 02-foundations-theme-infrastructure
plan: 05
subsystem: characterization-suite
tags: [characterization, api-contracts, vitest, playwright, handler-import, http-level, d-16, d-17, fnd-06]

requires:
  - phase: 02-02
  provides: vitest+playwright scaffolds, docker test stack (:5453), localhost DB guard, seed helpers, the seven NextAuth login quirks
  - phase: 02-03
  provides: characterization conventions (truncate harness, module isolation, rejecting fetch tripwire, assert style)
provides:
  - tests/api/_harness.ts — handler-import harness (NextRequest builder + getServerSession/prisma mock factories + two-user session fixtures + rate-limit reset discipline)
  - 71 handler-import cases pinning the D-17 route scope verbatim (guard bodies, ownership scoping, validation/limit/rate codes, cron+webhook defects)
  - tests/api/monitors.core.spec.ts — 12 HTTP-level contracts over the booted server with real seeded logins (the D-16 HTTP half)
  - The login-over-HTTP helper shape 02-09 and Phase 6/7 reuse
affects: [02-06 typecheck flip (tests must stay green), 02-09 mutation proof (D-21 ownership WHERE + template targets have named cases), Phase 6 thin-routes rewrite (every pin is the compatibility contract), Phase 7 auth cutover (401 bodies + session-guard template)]

tech-stack:
  added: []
  patterns: [harness-module-first mocking (vi.mock registered by importing _harness.ts before any route module; mocks survive vi.resetModules via module-instance closures), request-factory isolated cookie jars (playwright request.newContext per user), testMatch split enforced in playwright config (vitest owns .test.ts, playwright owns .spec.ts)]

key-files:
  created: [tests/api/_harness.ts, tests/api/monitors.handler.test.ts, tests/api/monitors-id.handler.test.ts, tests/api/incidents.handler.test.ts, tests/api/status.handler.test.ts, tests/api/cron-and-webhook.handler.test.ts, tests/api/auth-shallow.handler.test.ts, tests/api/monitors.core.spec.ts]
  modified: [tests/setup/seed.ts (seedE2EUser params + seedOngoingIncident), playwright.config.ts (testMatch on both projects), tests/api/.gitkeep removed implicitly by new files]

key-decisions:
  - "Harness mocks live as plain module-scope consts (NOT vi.hoisted — vitest 4 forbids exporting hoisted variables): mock factories are lazy and the harness is the first import of every test file, and factory closures over the harness module instance keep mock identity stable across vi.resetModules() + dynamic route re-imports"
  - "Rate-limit isolation (Pitfall 6) done the strong way: monitors + register files re-resolve the route via vi.resetModules() + dynamic import() per case, then prove it with a follow-up case that POSTs on the SAME IP the 429 case exhausted — passing in file order AND in isolation"
  - "next-auth AND next-auth/next both mocked to one shared fn — feedback/route.ts imports getServerSession from the 'next-auth/next' specifier (separate module id), a detail only visible by reading the route"
  - "Playwright projects got explicit testMatch /\\.spec\\.ts$/ — the default testMatch also claims *.test.ts, so the api project would have tried to run the vitest handler files once both existed"
  - "FND-06 marked complete: this plan delivered the API-contracts half on top of 02-03's batcher half"

requirements-completed: [FND-06]

coverage:
  - id: C1
    description: "Handler-import contracts for the monitors surface green: guard template, ownership scoping via prisma call args, validation/limit/rate codes, verbatim bodies (misspellings included), 02-01-fixed 500 shape"
    requirement: FND-06
    verification:
      - kind: test
      - ref: "pnpm vitest run tests/api/monitors.handler.test.ts tests/api/monitors-id.handler.test.ts → 2 files / 34 tests passed; rate-limit cases re-run with -t in isolation → 1 passed each"
      - status: pass
    human_judgment: false
  - id: C2
    description: "Remaining D-17 handler scope green (incidents, status ×2, feedback, cron ×2, telegram webhook, auth-shallow) with pinned defects commented by remediation phase; zero production changes; zero real network calls"
    requirement: FND-06
    verification:
      - kind: test
      - ref: "pnpm vitest run tests/api/ → 6 files / 71 tests passed; git diff --stat src/ empty; cron/webhook file mocks cron-logic/cleanup-logic/db-batcher/telegram and stubs global fetch to reject (UNSTUBBED FETCH tripwire)"
      - status: pass
    human_judgment: false
  - id: C3
    description: "HTTP-level core contracts green over the booted server: real seeded login (CSRF round-trip), ownership both directions, CRUD lifecycle, incidents/status/feedback shapes, unauthenticated sweep; smoke spec still green in the same run"
    requirement: FND-06
    verification:
      - kind: test
      - ref: "pnpm build && pnpm test:e2e → 13 passed (1 e2e smoke + 12 api); no HTTP test touches cron/check, cron/cleanup, or monitors/{id}/check (D-16 scope discipline)"
      - status: pass
    human_judgment: false
  - id: C4
    description: "Full vitest suite green with the new files (no regression in 02-02/02-03 coverage)"
    requirement: FND-06
    verification:
      - kind: test
      - ref: "pnpm test → 9 files / 102 tests passed"
      - status: pass
    human_judgment: false

duration: ~19min (1111s, 2026-09-10T18:14:30Z → 18:33:11Z)
completed: 2026-09-10
status: complete
---

# Phase 2 Plan 5: API Characterization Suite Summary

**71 handler-import cases + 12 HTTP-level contracts pin the D-17 route scope verbatim — guard bodies with today's misspellings, ownership scoping (the D-21 mutation target), validation/limit/rate codes, and the two scheduled security defects (query-string CRON_SECRET, unauthenticated Telegram webhook) documented as deliberate red→green pins for Phase 6.**

## Performance

- **Duration:** ~19 min (1111s)
- **Tasks:** 3/3
- **Files:** 8 created + 3 modified (test-only; `src/` untouched — zero production changes)

## Task Commits

1. **Task 1: Handler harness + monitors CRUD contracts** — `438b22b` (34 cases)
2. **Task 2: Incidents/status/feedback + pinned-defect cron/webhook + auth-shallow** — `3b1ec2a` (37 cases)
3. **Task 3: HTTP-level core-route contracts via Playwright request context** — `1164dc2` (12 tests; + seed/config/type fixes)

## Per-route case counts (D-17 scope coverage)

| Route | Handler cases | HTTP cases | Notes |
|---|---|---|---|
| GET /api/monitors (list) | 4 | 2 | 401 verbatim, A/B scoping, 500 fixed shape |
| POST /api/monitors (create) | 8 | 2 | 429 loop + reset proof, 403 limit, 400 ×2, 201 ×2 |
| GET /api/monitors/[id] | 4 | (lifecycle) | 404 ownership via findUnique args |
| PATCH /api/monitors/[id] | 5 | (lifecycle) | bare-return-undefined defect pinned |
| DELETE /api/monitors/[id] | 4 | (lifecycle) | same defect; delete where { id } unscoped |
| GET /api/monitors/[id]/details | 5 | — | include shape, distinct 500 body |
| POST /api/monitors/[id]/check | 4 | — (excluded by design) | mocked cron-logic/db-batcher seams (D-16) |
| GET /api/incidents | 4 | 1 | relation-scoped where.monitor.userId |
| GET /api/status | 3 | 1 + sweep | session REQUIRED (comment says public) |
| GET /api/status/[userId] | 3 | 2 + sweep | the genuinely public route |
| POST /api/feedback | 4 | 1 | weaker guard (no id check) pinned |
| GET /api/feedback | 3 | (sweep) | NOT ownership-scoped — pinned as-is |
| GET /api/cron/check | 6 | — (excluded) | query-string secret + stack-leak pins |
| GET /api/cron/cleanup | 4 | — (excluded) | query-string secret pin; body = runCleanup return |
| POST /api/telegram/webhook | 4 | — | S-2 unauthenticated-processing pin |
| POST /api/auth/register | 6 | — | shallow only (D-17): validation codes + success shape |
| **Total** | **71** | **12** | |

## Exact misspelled/quirky strings pinned (future "fix the typo" PRs go red deliberately)

- **`{ error: "Unauthirized" }`** — POST /api/monitors 401 (GET on the same route spells it `"Unauthorized"`; both pinned). File: `tests/api/monitors.handler.test.ts`.
- `"Featch Monitors Error:"` — console-only (log line, not a response body); noted in comments.
- PATCH vs POST URL-validation divergence: PATCH returns `'Invalid URL format'`, POST returns `'Invalid URL format (e.g., https://example.com)'` — both pinned verbatim.
- Check route's distinct 404: `"Monitor not found or unauthorized"` (every other 404 is `"Monitor not found"`).
- Details route's distinct 500: `"Internal Server Error"` (vs `"Failed to fetch monitors"` / `"Failed to fetch incidents"` / `"Failed to fetch status data"`).
- Register 400s: `"Email and password are required"` and `'Password must be at least 6 characters long'`.

## Pinned defects (documented in-test, remediation phase named)

1. **S-4 / Phase 6 SEC-06** — both cron routes accept `CRON_SECRET` via `?secret=` query string (`cron-and-webhook.handler.test.ts`, two "PINNED DEFECT" cases).
2. **S-4 family** — cron/check 500 body echoes `err.message` AND the full `err.stack`.
3. **S-2 / Phase 6 SEC-03** — Telegram webhook processes `/start <userId>` deep-links with NO authentication at all (links any user id to any chat).
4. **Bare-return-undefined** — PATCH/DELETE on a non-numeric id resolve to `undefined` (surfaces as a runtime 500 over the wire).
5. **Feedback weaker guard** — checks `!session || !session.user` (no id), so a session without id passes and creates with `userId: undefined`.
6. **Feedback list not ownership-scoped** — any authenticated user sees every user's feedback (with author name/email/image).
7. **/api/status is session-guarded** despite its "no auth needed" comment — `/api/status/[userId]` is the genuinely public one.
8. **Rate limit precedes the session guard** on POST /api/monitors — unauthenticated callers can burn/bounce on the limiter.

## Login-over-HTTP helper shape (reused by 02-09 and later phases)

```ts
async function loginOverHttp(ctx: APIRequestContext, email: string, password: string) {
  const csrfRes = await ctx.get("/api/auth/csrf");            // cookie jar gets csrf cookie
  const { csrfToken } = await csrfRes.json();
  await ctx.post("/api/auth/callback/credentials", {
    form: { email, password, csrfToken },                     // form-encoded (quirk 5)
    maxRedirects: 0,                                          // works for 200-JSON or 302 answers
  });
  const session = await ctx.get("/api/auth/session");         // assert outcome, never a 3xx (quirk 4)
  expect((await session.json()).user?.email).toBe(email);
}
```

Isolated cookie jars per user via `request.newContext({ baseURL: test.info().project.use.baseURL })` from the `@playwright/test` `request` factory export (NOT the fixture's `newContext` — that method does not exist on an APIRequestContext).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] vitest forbids exporting vi.hoisted values**
- **Found during:** Task 1 (first run: "Cannot export hoisted variable")
- **Issue:** The harness design put the shared mock instances in an exported `vi.hoisted(() => ...)` — vitest 4's transform rejects exporting hoisted variables.
- **Fix:** Plain module-scope consts in `_harness.ts`. Safe because mock factories are lazy (run on first import of the mocked module, always after the harness module evaluates — the harness is the first import of every test file) and factory closures over the harness module instance keep mock identity stable across `vi.resetModules()` + dynamic route re-imports.
- **Files modified:** tests/api/_harness.ts
- **Committed in:** 438b22b

**2. [Rule 3 - Blocking] Playwright would have claimed the vitest handler files**
- **Found during:** Task 3 (design)
- **Issue:** Playwright's default testMatch includes `*.test.ts`; once the api project's testDir contained the handler files, `pnpm test:e2e` would load them in the Playwright runner.
- **Fix:** `testMatch: /\.spec\.ts$/` on both projects in playwright.config.ts — enforcing the ownership split the 02-02 config comment already claimed.
- **Files modified:** playwright.config.ts
- **Committed in:** 1164dc2

**3. [Rule 3 - Blocking] Two-user seeding needed generalized helpers**
- **Found during:** Task 3
- **Issue:** `seedE2EUser()` was hardcoded to the single smoke user; the plan's ownership cases need two seeded users, and one raw-SQL incident seed.
- **Fix:** `seedE2EUser(email?, password?, name?)` with defaults preserving the original smoke contract, plus `seedOngoingIncident(monitorId, description)`.
- **Files modified:** tests/setup/seed.ts
- **Committed in:** 1164dc2

**4. [Rule 1 - Bug] Build-gate strict-TS errors in new test files**
- **Found during:** Task 3 verification (`pnpm build`)
- **Issue:** Root test files are type-checked by the build (02-02's known behavior): `next/server`'s RequestInit rejects DOM-typed inits (`signal` nullability); PATCH/DELETE handlers legitimately resolve `undefined`, making every `res.status` read possibly-undefined; `test.info().config` has no `use` (it lives on `.project`).
- **Fix:** Plain literal NextRequest init; `mustRespond()` guard that asserts defined-ness (the pin stays — undefined IS the characterized behavior); `test.info().project.use.baseURL`.
- **Files modified:** tests/api/_harness.ts, tests/api/monitors-id.handler.test.ts, tests/api/monitors.core.spec.ts
- **Committed in:** 1164dc2

---

**Total deviations:** 4 auto-fixed (3 blocking test-infra accommodations, 1 type-correctness fix) — all in test infrastructure, zero production changes.

## Issues Encountered

None remaining. All suites green on the final run; no flakiness observed.

## User Setup Required

None.

## Next Phase Readiness

- 02-06 (typecheck flip): the full suite (9 files / 102 tests) is the behavior net; lint/typecheck stay red until then by design
- 02-09 (mutation proof): named targets ready — ownership WHERE (monitors/incidents scoping cases), 401 template bodies (verbatim pins), cron/webhook defect pins (go green only if the mutation "fixes" a defect it should not)
- Phase 6 (thin routes): every handler pin is the compatibility contract; the three PINNED DEFECT cases are the red→green acceptance tests for SEC-03/SEC-06
- Phase 7 (auth cutover): the 401 bodies + login-over-HTTP helper define the session-guard surface Better Auth must reproduce (or deliberately change)

## Self-Check: PASSED

All 8 created artifacts exist on disk (tests/api/_harness.ts, monitors.handler.test.ts, monitors-id.handler.test.ts, incidents.handler.test.ts, status.handler.test.ts, cron-and-webhook.handler.test.ts, auth-shallow.handler.test.ts, monitors.core.spec.ts); all 3 commits found in git log (438b22b, 3b1ec2a, 1164dc2); `git diff --stat src/` empty; `pnpm test` → 9 files / 102 tests; `pnpm test:e2e` → 13 passed.

---
*Phase: 02-foundations-theme-infrastructure*
*Completed: 2026-09-10*
