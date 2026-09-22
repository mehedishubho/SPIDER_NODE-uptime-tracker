---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 04
subsystem: auth
tags: [better-auth, auth-client, client-swap, session-hook, notice-strip, env-window, playwright, d33-frozen-pixels]

# Dependency graph
requires:
  - phase: "07 plan 03"
    provides: src/lib/auth-client.ts (the single client source) + the live Better Auth engine at /api/auth/[...all] + the deleted legacy routes (the 404ing unswapped forms this plan fixes)
  - phase: "07 plan 02"
    provides: BETTER_AUTH_URL-sourced email links (the verification/reset emails whose links now carry framework urls)
provides:
  - every session-bearing component resolves through authClient — zero next-auth/react imports and zero bare useSession tokens across src/components, src/providers, src/app/layout.tsx (AUTH-08 client half)
  - six auth forms swapped with byte-frozen pixels and the D-33 error-code mapping table realized (401/403 EMAIL_NOT_VERIFIED/account_not_linked/duplicate-email-200)
  - legacy AuthProvider deleted; layout.tsx wrapper removed; sign-out sites on authClient.signOut() + per-site window.location
  - the D-02 login notice strip: server-rendered, env-window-gated, non-dismissible, zero client state, self-cleaning (AUTH-06 UI half)
  - src/lib/notice-window.ts noticeWindowActive predicate (12-case unit suite, inclusive boundaries) + tests/e2e/login-notice-strip.spec.ts default-off pin
  - AUTH_NOTICE_START/AUTH_NOTICE_END in .env.example (delete-after-use, D-05)
  - a bootable post-flip e2e harness (playwright webServer carries test-scoped BETTER_AUTH_*/OAuth envs)
affects: [07-05 Bull Board gate, 07-06 rehearsal (seed fixture + strip render evidence), 07-07 soak, 07-08 deletion gate]

# Actuals (#2632) — pairs with the plan's estimate to calibrate future estimates.
actuals:
  tokens: 9250       # chars/4 over the realized diff (24 files, 350 insertions + 94 deletions)
  tasks: 3
  commits: 3         # MEASURED: git rev-list --count c6054c00a0362a4dcb3840d56d0c37330958a916..HEAD

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "useAuthSession accessor: components consume a wrapper exported from src/lib/auth-client.ts and derive the legacy three-state status from isPending+data — every existing conditional render stays byte-identical and better-auth/react keeps exactly one importer"
    - "Provider-free client auth: Better Auth's react client needs no React context provider — the layout loses the SessionProvider wrapper entirely"
    - "Page-level column shell: new server-rendered elements mount beside a byte-frozen client component at matched column width instead of editing frozen JSX"

key-files:
  created:
    - src/lib/notice-window.ts
    - src/components/Auth/LoginNotice.tsx
    - tests/lib/notice-window.test.ts
    - tests/e2e/login-notice-strip.spec.ts
  modified:
    - src/components/Auth/{LoginForm,RegisterForm,ForgotPasswordForm,ResetPasswordForm,VerifyEmailForm}.tsx
    - src/components/common/Navbar/Navbar.tsx
    - src/components/Dashboard/{Dashboard,DashboardStatus,Incidents,MonitorDetails,ProfileComponent}.tsx
    - src/components/dashboardLayout/{NavUser,TeamSwitch}.tsx
    - src/components/home/HeroSection.tsx
    - src/app/layout.tsx
    - src/app/(authLayout)/login/page.tsx
    - src/lib/auth-client.ts (useAuthSession accessor)
    - playwright.config.ts (post-flip e2e boot envs)
    - .env.example (AUTH_NOTICE_START/END)
  deleted:
    - src/providers/AuthProvider.tsx

key-decisions:
  - "useAuthSession accessor lives in src/lib/auth-client.ts — the Task 2 gate forbids the bare useSession token inside the component dirs, so the wrapper (and the only better-auth/react import) stays in the single client source; components derive status = isPending ? loading : data ? authenticated : unauthenticated so every status check remains byte-identical"
  - "Sign-out sites keep each site's ACTUAL redirect target (Navbar x2 -> /, NavUser -> /login, Dashboard -> /login, ProfileComponent -> /register, TeamSwitch -> /login) — the plan's parenthetical gloss misquoted today's code; the binding rule 'SAME callback target each site uses today' wins, zero behavior change"
  - "The notice strip mounts from page.tsx in a column-width centered shell: the in-DOM 'first child of the max-w-md column' lives inside LoginForm.tsx, whose JSX is byte-frozen by the harder D-33 contract — and true in-column placement would clip on short viewports (items-center + overflow-hidden); the shell reproduces column width, centering, ThemeToggle-safety, and never overlaps"
  - "playwright.config.ts webServer gained test-scoped BETTER_AUTH_URL/SECRET + fake OAuth credentials — the 07-03 requireProductionEnv throw-early gate made every post-flip e2e boot impossible (the 07-03 verification never ran the e2e leg)"
  - "ProfileComponent session refresh swaps NextAuth update() for authClient.updateUser() — the user row updates and the reactive hook re-renders the navbar immediately"
  - "RegisterForm keeps the success toast on the engine's duplicate-email synthetic 200 (enumeration protection — the accepted A4 delta, surfaced for UAT awareness)"

patterns-established:
  - "Derive-don't-rewrite status: swap one hook shape, derive the legacy enum, keep all conditional renders byte-identical"
  - "Test-harness env parity: whenever a throw-early production gate lands, the e2e webServer env block must gain test-scoped values in the same plan or the e2e leg goes dark"

requirements-completed: [AUTH-06, AUTH-08]

# Coverage metadata (#1602) — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "Single client source: zero next-auth/react imports across src/components, src/providers, src/app/layout.tsx, and zero bare useSession tokens in the component dirs — every session/sign-out call resolves through authClient (AUTH-08 client half)"
    requirement: AUTH-08
    verification:
      - kind: other
        ref: "command: { ! pnpm exec rg -l 'next-auth/react' src/components src/providers src/app/layout.tsx; } exits 0 (zero matches)"
        status: pass
      - kind: other
        ref: "command: { ! pnpm exec rg -l 'next-auth/react|useSession' src/components/common src/components/Dashboard src/components/dashboardLayout src/components/home src/app/layout.tsx; } exits 0 (zero matches)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Six auth forms swapped onto authClient with byte-frozen pixels (import-line + handler-body diffs only) and the D-33 mapping realized: 401 -> 'Invalid email or password.'; 403 EMAIL_NOT_VERIFIED -> 'Please verify your email address before logging in.'; provider-initiate/account_not_linked -> frozen ${provider} toast; RegisterForm duplicate-email synthetic 200 keeps the success toast (A4); dead pre-flip tokens land on the existing error state (D-20)"
    requirement: AUTH-08
    verification:
      - kind: other
        ref: "command: git diff -U0 <plan-base>..HEAD over the six forms filtered to className/JSX lines -> empty (zero pixel diffs, VerifyEmailSent untouched)"
        status: pass
      - kind: other
        ref: "command: pnpm exec rg -c authClient LoginForm/RegisterForm -> 3/3; pnpm typecheck exit 0"
        status: pass
    human_judgment: true
    rationale: "The frozen strings are in code and the diff contract is command-proven, but the runtime toasts (real 401/403 through the new engine, browser-observed) have no automated test — UAT should drive one failed login and one social initiation"
  - id: D3
    description: "Nine dashboard/common components on authClient with existing conditional-render semantics intact; AuthProvider deleted and layout wrapper removed; ProfileComponent refresh via authClient.updateUser; TeamSwitch js-cookie/Redux lines untouched (07-08 scope)"
    verification:
      - kind: other
        ref: "command: pnpm typecheck exit 0; NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007 pnpm build exit 0 (Next route table + worker bundle)"
        status: pass
    human_judgment: true
    rationale: "Sign-out redirect targets are code-inspection-verified against each site's pre-plan onClick (no test drives the flows); mid-session 401 -> /login-with-strip behavior (D-03) is accepted-blip UX, not automatable"
  - id: D4
    description: "noticeWindowActive predicate: inclusive [start,end] window; missing/invalid/empty bounds and inverted windows all fail toward no-strip (T-07-15)"
    verification:
      - kind: unit
        ref: "tests/lib/notice-window.test.ts#12 cases (in-window/before/after/exact-start/exact-end/missing/invalid/empty/inverted)"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-02 notice strip on /login: server-rendered, role=status, frozen tokens (bg-card/border-border/rounded-xl, muted w-4 h-4 icon aria-hidden, text-foreground 14px), frozen D-02 sentence, non-dismissible zero client state, renders null outside the AUTH_NOTICE_START..END window with zero reserved space"
    requirement: AUTH-06
    verification:
      - kind: e2e
        ref: "tests/e2e/login-notice-strip.spec.ts#closed notice window renders no strip and a normal login form (role=status count 0 + form renders; playwright --project=e2e, 1/1)"
        status: pass
    human_judgment: true
    rationale: "The populated/long-text in-window render is the plan's named backstop — held as a rendered-strip check in the 07-06 rehearsal evidence via the console provider (D-06 operator copy sign-off); the default-off path is e2e-proven here"
  - id: D6
    description: "AUTH_NOTICE_START/AUTH_NOTICE_END documented in .env.example as delete-after-use (D-05 annotation; 07-08 extends the remnant gate)"
    verification:
      - kind: other
        ref: "command: grep -A3 'AUTH_NOTICE_START' .env.example shows the D-05 delete-after-use annotation"
        status: pass
    human_judgment: false
  - id: D7
    description: "Post-flip e2e harness bootable: playwright webServer env carries test-scoped BETTER_AUTH_*/OAuth credentials satisfying the 07-03 requireProductionEnv gate"
    verification:
      - kind: e2e
        ref: "tests/e2e/login-notice-strip.spec.ts run boots next start under NODE_ENV=production past the throw-early gate (pre-fix the webServer timed out on the boot throw)"
        status: pass
    human_judgment: false

# Metrics
duration: 26min
completed: 2026-09-22
status: complete
---

# Phase 7 Plan 4: CLIENT SWAP + login notice strip Summary

**Every session-bearing component now runs on authClient with byte-frozen pixels and the D-33 error mapping; the legacy AuthProvider is deleted; the env-dated non-dismissible D-02 login notice strip ships with a boundary-proven window predicate — 24 files, three atomic commits.**

## Performance

- **Duration:** 26 min
- **Started:** 2026-09-22T21:13:46Z
- **Completed:** 2026-09-22T21:40:29Z
- **Tasks:** 3
- **Files modified:** 24 (4 created, 1 deleted, 19 modified; VerifyEmailSent.tsx intentionally untouched — no auth plumbing to swap)

## Accomplishments

- The transitional 404 state from 07-03 is resolved: register/forgot/verify/reset forms now call `authClient.signUp.email` / `requestPasswordReset` / `resetPassword` / `verifyEmail` against the live engine, and login runs `authClient.signIn.email` with the D-33 mapping (401 → frozen invalid-credentials string; 403 EMAIL_NOT_VERIFIED → the exact legacy verify string; provider-initiate/refusal → the frozen `${provider}` toast).
- All nine dashboard/common components resolve sessions through the new `useAuthSession` accessor (single client source preserved); the legacy three-state `status` is derived so every existing conditional render stayed byte-identical; sign-out sites use `authClient.signOut()` + `window.location.href` to each site's own pre-plan target; `src/providers/AuthProvider.tsx` is deleted with its layout wrapper.
- The phase's single new UI element — the D-02 login notice strip — is server-rendered, env-window-gated, non-dismissible, zero-client-state, and self-cleaning; the window predicate is unit-proven inclusive-boundary (12/12) and the closed-window /login render is e2e-proven (no `role="status"` element, form normal). In-window render evidence is held at the 07-06 rehearsal per the plan's backstop.
- `pnpm build` green end-to-end (Next route table + worker bundle); `pnpm typecheck` clean; full vitest suite green (46 files / 388 tests, including the new 12-case suite).
- The e2e harness is post-flip bootable again: the playwright webServer env now satisfies 07-03's throw-early gate (pre-fix, every `pnpm test:e2e` boot died on the missing BETTER_AUTH_SECRET — the leg had silently gone dark since 07-03).

## Task Commits

Each task was committed atomically:

1. **Task 1: Six auth forms — plumbing swap, frozen pixels, error mapping** - `8cacbe5` (feat)
2. **Task 2: Dashboard/common session swap + provider deletion** - `01d3623` (feat)
3. **Task 3: Login notice strip — env window, tokens, e2e + unit coverage** - `a84c0e3` (feat)

**Plan metadata:** `PLAN_HEAD_BEFORE=c6054c0` → 3 commits measured (see actuals).

## Files Created/Modified

- `src/components/Auth/{LoginForm,RegisterForm,ForgotPasswordForm,ResetPasswordForm,VerifyEmailForm}.tsx` — handler bodies + import lines only (zero className/JSX diffs); VerifyEmailSent.tsx untouched (static screen, nothing to swap)
- `src/lib/auth-client.ts` — gains the `useAuthSession()` accessor (the wrapper keeps `better-auth/react` as a single-import module)
- `src/components/common/Navbar/Navbar.tsx`, `src/components/dashboardLayout/{NavUser,TeamSwitch}.tsx`, `src/components/Dashboard/{Dashboard,DashboardStatus,Incidents,MonitorDetails,ProfileComponent}.tsx`, `src/components/home/HeroSection.tsx` — hook + sign-out swaps, status derivation line added, conditional renders untouched
- `src/app/layout.tsx` — AuthProvider import + wrapper removed (Redux/Theme/Toaster untouched)
- `src/lib/notice-window.ts` (NEW) — the inclusive-window predicate, fail-toward-no-strip
- `src/components/Auth/LoginNotice.tsx` (NEW) — the server-rendered strip, UI-SPEC token recipe verbatim, frozen D-02 sentence
- `src/app/(authLayout)/login/page.tsx` — mounts the strip in a column-width centered page-level shell
- `tests/lib/notice-window.test.ts` (NEW), `tests/e2e/login-notice-strip.spec.ts` (NEW)
- `playwright.config.ts` — webServer env gains test-scoped BETTER_AUTH_*/OAuth values (Rule 3 harness fix)
- `.env.example` — AUTH_NOTICE_START/AUTH_NOTICE_END with the D-05 delete-after-use annotation
- Deleted: `src/providers/AuthProvider.tsx`

## Decisions Made

- **useAuthSession accessor in the single client source.** The Task 2 gate forbids the literal `useSession` token inside the gated component dirs (it cannot distinguish next-auth's hook from authClient's), so the accessor wraps `authClient.useSession()` in `src/lib/auth-client.ts` — AUTH-08's "nothing else imports better-auth/react" invariant survives intact, and components derive the legacy status enum to keep every `status === "..."` check byte-identical.
- **Sign-out targets follow the code, not the plan's gloss.** The plan's truth-table parenthetical claimed NavUser/Dashboard/ProfileComponent redirect to `/`; today's code says `/login`, `/login`, `/register`. The binding rule — "the SAME callback target each site uses today" — was followed, preserving behavior exactly.
- **Page-level strip mount.** The in-DOM "first child of the max-w-md column" is inside LoginForm.tsx, byte-frozen by D-33 (the harder, verified contract). The page-level shell reproduces every load-bearing placement property (column width, centered, non-banner, ThemeToggle-safe, in-flow so it can never overlap), and avoids a real defect of true in-column placement: `items-center` + `overflow-hidden` would clip the strip on short viewports.
- **Test-scoped boot envs for the e2e server.** 07-03's requireProductionEnv correctly fails a production boot without auth envs — and had therefore made the whole e2e leg unbootable since the flip. The webServer env block now pins deterministic fakes (only non-emptiness is boot-validated; OAuth flows aren't exercised).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 2's gate forbids the string its own action text prescribes**
- **Found during:** Task 2 (gate analysis before editing)
- **Issue:** `rg "next-auth/react|useSession"` cannot distinguish the dead hook from `authClient.useSession()` — following the action text literally would fail the task's own verify gate
- **Fix:** exported `useAuthSession()` from `src/lib/auth-client.ts` (the sanctioned single source); components consume the accessor and derive the legacy status enum
- **Files modified:** src/lib/auth-client.ts
- **Verification:** Task 2 gate exits 0; typecheck green
- **Committed in:** 01d3623

**2. [Rule 3 - Blocking] The 07-03 throw-early gate made every post-flip e2e boot impossible**
- **Found during:** Task 3 (first e2e run: webServer timeout on `BETTER_AUTH_SECRET is not set`)
- **Issue:** playwright.config.ts's webServer env predates the engine flip; `requireProductionEnv` throws at `next start` under NODE_ENV=production, so the e2e leg had been dark since 07-03 (whose verification never ran it)
- **Fix:** test-scoped BETTER_AUTH_URL/BETTER_AUTH_SECRET + fake OAuth credentials added to the webServer env block (mirrors the existing `NEXTAUTH_SECRET: "test-secret"` pattern)
- **Files modified:** playwright.config.ts
- **Verification:** the notice-strip spec boots the server and passes 1/1
- **Committed in:** a84c0e3

**3. [Rule 3 - Blocking] The plan's lowercase component path collides case-insensitively on Windows**
- **Found during:** Task 3 (typecheck: TS1261 forceConsistentCasingInFileNames)
- **Issue:** `src/components/auth/LoginNotice.tsx` merges into the existing `src/components/Auth/` directory on a case-insensitive FS — the lowercase import can never typecheck here, and a git-index path the working tree cannot satisfy would diverge across platforms
- **Fix:** realized at `src/components/Auth/LoginNotice.tsx` with the matching import (one physical directory, consistent on case-sensitive platforms too)
- **Files modified:** src/components/Auth/LoginNotice.tsx (path), src/app/(authLayout)/login/page.tsx, .env.example (comment)
- **Verification:** pnpm typecheck exit 0
- **Committed in:** a84c0e3

**4. [Rule 1 - Plan-constraint] Strip mount point realized as a page-level column shell**
- **Found during:** Task 3 (mount design)
- **Issue:** "first child of the centered max-w-md column" requires editing byte-frozen LoginForm JSX (a D-33 violation, the harder contract); true in-DOM placement would additionally clip on short viewports (items-center + overflow-hidden)
- **Fix:** page.tsx renders the strip in a `flex justify-center px-4` / `w-full max-w-md` shell — column width, centered, above the brand header, ThemeToggle-safe, never overlapping
- **Files modified:** src/app/(authLayout)/login/page.tsx
- **Verification:** e2e asserts the closed-window null render; in-window placement evidence at 07-06
- **Committed in:** a84c0e3

**5. [Rule 1 - Plan-text] The plan's e2e invocation names a nonexistent Playwright project**
- **Found during:** Task 3 (verify run)
- **Issue:** `--project=chromium` — the config's projects are `e2e` and `api`; the pinned command fails with "Project not found"
- **Fix:** ran `--project=e2e` (the config's browser project, same intent)
- **Files modified:** none (invocation only)
- **Verification:** spec passes 1/1
- **Committed in:** n/a

---

**Total deviations:** 5 auto-fixed (3 Rule 3 blocking, 2 Rule 1 plan-text/constraint). **Impact on plan:** all fixes were forced by the plan's own machine gates, the installed engine's verified boot contract, or the Windows filesystem reality; none expanded product scope. The 23-file touch set grew by exactly 2 files (src/lib/auth-client.ts accessor, playwright.config.ts harness envs), both Rule-3-necessary and documented above.

## Issues Encountered

- `pnpm build` on this checkout needs `NEXT_PUBLIC_DEV_BASE_URL` injected (documented 02-07/03-01 deviation; used for both build runs).
- **e2e smoke/api suites are stale for the flipped engine (NOT fixed here — outside the accepted file set; 07-06 input):** 6 pre-existing failures (smoke seeded-login + Theme-cycle specs, one api ownership spec). Root cause: `tests/setup/seed.ts:56` inserts the LEGACY `"emailVerified"` timestamp, so freshly seeded users have the new `email_verified` boolean at its false default and the engine 403s their logins. These failures pre-date this plan (post-07-03 the login POST hit the deleted `[...nextauth]` route) — the seed fixture must learn the boolean before the 07-06 rehearsal's e2e legs.
- A duplicate-email sign-up now shows the success toast (engine enumeration protection — the sanctioned A4 delta): harmless, but UAT should know the "account created" toast no longer implies the email was new.

## User Setup Required

None - no external service configuration required. (Flip-time operator duties — AUTH_NOTICE_START/END values, D-06 copy sign-off at the 07-06 rehearsal — are already documented in .env.example and the plan.)

## Next Phase Readiness

- 07-05 can build the worker Bull Board gate on the unchanged `createAuth()`/`auth` instance; the client side of this plan is invisible to it.
- 07-06 rehearsal inputs from this plan: (1) the seed fixture must write `email_verified` (or re-run migration 0002's backfill semantics) before any e2e/login leg; (2) the notice strip's in-window rendered-bytes evidence (populated + long-text rows) is owed here per D-06; (3) the e2e harness now boots — smoke repairs should land on top of the new webServer envs.
- 07-08's deletion gate inherits: zero `next-auth/react` imports (rg-proven), zero bare `useSession` tokens in the component dirs, and the `AUTH_NOTICE_*` env names as delete-after-use targets (D-05).
- The transitional dual-stack is now CLIENT-idle too: next-auth remains installed (D-29) but no route, server guard, or component resolves a session through it.

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-22*

## Self-Check: PASSED

- All 4 created files verified on disk (notice-window.ts, LoginNotice.tsx, notice-window.test.ts, login-notice-strip.spec.ts); AuthProvider.tsx verified deleted
- All 3 plan commits verified in history: 8cacbe5, 01d3623, a84c0e3 (3 measured from ledger base c6054c0)
- Plan `<verification>` re-run: rg gates zero matches (components + providers + layout); pnpm typecheck green; NEXT_PUBLIC_DEV_BASE_URL build green; notice-window unit suite 12/12 (full suite 46 files / 388 tests green in the same run); notice-strip e2e 1/1 via `--project=e2e`
- D-33 frozen-pixel re-check over the final plan diff: zero className/JSX changes on the six auth forms
- STATE.md advanced (Plan 5 of 9, metrics + decisions + session recorded); ROADMAP.md progress row updated; REQUIREMENTS.md flips governed by the ready-ids shared-ID gate (AUTH-06/AUTH-08 stay Pending until 07-07/07-08 finish — marked only if ready)
- Pre-existing working-tree artifacts (skills-lock.json, observations.json, untracked .claude/skills/*, .env.test, research caches) left unstaged throughout — only task-owned files committed
