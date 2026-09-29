---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 10
subsystem: api
tags: [drizzle, iso-8601, timestamps, serialization, timezone, nextjs, wire-contract, vitest]

# Dependency graph
requires:
  - phase: 07 (07-08/07-09)
    provides: the 11 Prisma-to-Drizzle route ports whose responses this plan re-normalizes, and the migrated single-client DB the wire suite drives
  - phase: 06 (06-01)
    provides: the manual-check completion poll (D-01/D-02) whose comparison this plan hardens
provides:
  - src/lib/serialize.ts — the ONE ISO-8601 UTC normalization seam (iso + isoRow) adopted by every ported route response boundary
  - tests/integration/wire-timestamps.test.ts — the real-DB wire regression suite (only the session door mocked; the handler-stub blind spot that let CR-01 through can never hide a wire-format drift again)
  - WR-01 restored: updatedAt advances on monitors PATCH, profile PATCH, and the telegram webhook deep-link
  - WR-02 restored: an empty monitors PATCH answers the Prisma-equivalent 200 no-op
  - Poll hardening: the completion comparison normalizes through iso() — completes in any browser timezone
affects: [phase-08 (windowed-uptime UI consumes correct instants), any future route touching timestamp responses]

# Actuals (#2632) — pairs with the plan's estimate to calibrate future estimates.
actuals:
  tokens: 10000    # chars/4 over the realized diff (39,996 diff chars), vs estimate 96k
  tasks: 3
  commits: 2       # MEASURED: git rev-list --count 8deebdd..HEAD (production commits; docs commit follows)

# Tech tracking
tech-stack:
  added: []
  patterns: [single-seam response serialization (iso/isoRow at every API boundary), real-DB wire regression suite (session-door-only mock)]

key-files:
  created:
    - src/lib/serialize.ts
    - tests/lib/serialize.test.ts
    - tests/integration/wire-timestamps.test.ts
  modified:
    - src/app/api/monitors/route.ts
    - src/app/api/monitors/[id]/route.ts
    - src/app/api/monitors/[id]/details/route.ts
    - src/app/api/incidents/route.ts
    - src/app/api/status/route.ts
    - src/app/api/status/[userId]/route.ts
    - src/app/api/user/profile/route.ts
    - src/app/api/feedback/route.ts
    - src/app/api/telegram/webhook/route.ts
    - src/lib/check-now-poll.ts
    - tests/api/monitors-id.handler.test.ts
    - tests/api/feedback-admin.handler.test.ts
    - tests/api/cron-and-webhook.handler.test.ts
    - tests/lib/check-now-poll.test.ts

key-decisions:
  - "iso() canonicalizes before parsing (space→T, bare +HH→+HH:00) instead of the review's raw `value + 'Z'` draft — the drafted form threw Invalid Date on ISO-Z passthrough and relied on the lenient space-form parse; the canonical form is spec-defined and TZ-deterministic (naive→Z appended, offset text→parsed, ISO-Z→round-trip, null→null, unparseable→passthrough)"
  - "isoRow(row, keys) added to the same seam — spread-and-overwrite keeps JSON key order and shape byte-stable apart from the timestamp FORMAT, and skips absent keys/non-string values so fixture-only suites and projections are untouched"
  - "Wire suite seeds instants as ISO-Z strings and proves the round-trip to millisecond equality — the DB-stores-UTC convention (A6 backfill, UTC-pinned sessions) proven live, not by assertion"
  - "Build leg on this env-less checkout used the documented 07-06 deviation-2 pattern (gitignored .env.production with the two non-secret keys, deleted immediately after the build) — identical to the DEPLOY-RUNBOOK §492/§529 rehearsal/flip build form"

patterns-established:
  - "Wire-contract regression: tests/integration/wire-timestamps.test.ts is the template for anything the @/db-stubbing handler suites structurally cannot see (driver text forms, real driver behavior)"
  - "Response boundary rule: every timestamp a route emits goes through @/lib/serialize — no per-route date logic"

requirements-completed: [DRZ-07]

coverage:
  - id: D1
    description: "Every timestamp in every ported-route JSON response is ISO-8601 UTC Z via the single serialize seam (monitors GET/POST, monitors/[id] GET/PATCH incl. the no-op echo, monitors/[id]/details incl. pings/incidents, incidents, status, status/[userId], profile GET/PATCH, feedback GET/POST); nullable keys stay present-with-null"
    requirement: DRZ-07
    verification:
      - kind: integration
        ref: "tests/integration/wire-timestamps.test.ts#GET /api/monitors — every full-row timestamp matches the strict Z form and round-trips to the seeded instant"
        status: pass
      - kind: unit
        ref: "tests/lib/serialize.test.ts#iso — driver timestamp text → ISO-8601 UTC (7-case matrix, literal expected strings)"
        status: pass
      - kind: other
        ref: "pnpm exec rg -l '@/lib/serialize' src/app/api src/lib/check-now-poll.ts — all 8 response routes + poll listed"
        status: pass
    human_judgment: false
  - id: D2
    description: "Manual-check completion poll resolves in ANY browser timezone — the completion comparison normalizes the polled value through iso() before comparing to queuedAt; null stays a skip"
    requirement: DRZ-07
    verification:
      - kind: unit
        ref: "tests/lib/check-now-poll.test.ts#G-07-63: a legacy naive Postgres lastChecked text (space, no designator) still completes — normalized as UTC"
        status: pass
      - kind: integration
        ref: "tests/integration/wire-timestamps.test.ts#GET leg (the wire the poll reads now carries ISO-Z, millisecond-equal to the stored instant)"
        status: pass
    human_judgment: false
  - id: D3
    description: "WR-01: updatedAt advances on every UPDATE write path — monitors PATCH, profile PATCH, telegram webhook /start deep-link (fresh toISOString, mirroring the POST insert's explicit-supply rationale)"
    requirement: DRZ-07
    verification:
      - kind: integration
        ref: "tests/integration/wire-timestamps.test.ts#WR-01 legs (stored row re-read: strictly later than seed; response ISO-Z) — 2 legs"
        status: pass
      - kind: unit
        ref: "tests/api/monitors-id.handler.test.ts + cron-and-webhook.handler.test.ts set pins (updatedAt in every UPDATE set)"
        status: pass
    human_judgment: false
  - id: D4
    description: "WR-02: monitors PATCH with an empty update set answers the Prisma-equivalent 200 no-op carrying the existing (normalized) row — never the .set({}) 500; ownership 404 wins; vanished-row 500 untouched for non-empty sets"
    requirement: DRZ-07
    verification:
      - kind: integration
        ref: "tests/integration/wire-timestamps.test.ts#WR-02 leg (200 + ISO-Z echo + DB row byte-unchanged)"
        status: pass
      - kind: unit
        ref: "tests/api/monitors-id.handler.test.ts#WR-02 case (update builder never invoked via dbLog)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full verify chain green modulo the single documented environmental exception (health.test.ts EADDRINUSE-:9090 — the production worker holds the port by design); schema:gate untouched-green; armed remnant gate green over the new code"
    requirement: DRZ-07
    verification:
      - kind: other
        ref: "pnpm verify (stack up, lint 0 errors, typecheck clean, suite 407 pass/2 skip/1 documented environmental fail) + individually green legs: pnpm schema:gate, pnpm worker:boundary, pnpm denylist:diff, pnpm build, pnpm cron:remnants (428 files), pnpm test:e2e (18/18)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Zero consumer edits: Dashboard/MonitorDetails/PublicStatus/Incidents parse the restored ISO strings correctly with their existing new-Date call sites (the fix lives entirely at the API boundary)"
    requirement: DRZ-07
    verification:
      - kind: e2e
        ref: "pnpm test:e2e — 18/18 passed (the dashboard/status/incident surfaces render through the restored wire format)"
        status: pass
      - kind: integration
        ref: "tests/integration/wire-timestamps.test.ts (parsed values round-trip to millisecond equality — the instants consumers compute with are unchanged)"
        status: pass
    human_judgment: false

# Metrics
duration: 30 min
completed: 2026-09-29
status: complete
---

# Phase 07 Plan 10: Wire-Timestamp Gap Closure Summary

**Restored the ISO-8601 UTC wire contract on all 8 ported routes through one serialize seam (G-07-63/CR-01), fixed the timezone-blind manual-check poll, and restored WR-01 updatedAt + WR-02 empty-PATCH semantics — pinned by a real-DB wire regression suite captured RED then GREEN.**

## Performance

- **Duration:** 30 min
- **Started:** 2026-09-29T20:07:24Z
- **Completed:** 2026-09-29T20:37:02Z
- **Tasks:** 3
- **Files modified:** 17 (3 created, 14 modified)

## Accomplishments
- One shared seam (`src/lib/serialize.ts`: `iso` + `isoRow`) now normalizes every timestamp every ported route emits — the driver's raw naive Postgres text (`"2026-09-29 15:00:00.789"`, which ECMAScript parses as LOCAL time) is restored to the Prisma-era ISO-8601 UTC Z wire form; nullable timestamp keys stay present-with-null; JSON key order/shape unchanged apart from the format.
- `check-now-poll.ts` normalizes the polled value through `iso()` before the completion comparison — the D-01 poll can no longer never-complete (UTC+ browsers) or false-complete on stale values (UTC−). The client bundle gains only the isomorphic pure helper.
- WR-01: `updatedAt` (fresh `toISOString()`) rides all three UPDATE sets (monitors PATCH, profile PATCH, webhook deep-link), restoring the lost client-side auto-bump semantics; proven on the real DB (strictly-later re-reads).
- WR-02: an empty monitors PATCH answers the Prisma-equivalent 200 no-op with the existing row before any UPDATE runs (`.set({})` was a 500); ownership 404 wins; vanished-row 500 semantics untouched for non-empty sets.
- `tests/integration/wire-timestamps.test.ts` permanently pins the wire contract through the REAL drizzle-orm/node-postgres driver with only the session door mocked — the machine check the @/db-stubbing handler suites structurally cannot provide.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — serialize helper + real-DB wire regression suite** - `df421c7` (test)
2. **Task 2: GREEN — normalize every ported-route response; restore WR-01/WR-02; harden the poll** - `66b13a2` (feat)
3. **Task 3: Full verify green (with the single documented environmental exception)** - verification-only, no code changes (no commit)

## Captured RED (Task 1 evidence)

`pnpm exec vitest run tests/integration/wire-timestamps.test.ts` at `df421c7^` state: **4 failed / 4** with exactly the documented defect signatures —
- CR-01 GET leg: `expected '2026-09-29 15:00:00.789' to match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` (raw naive driver text on the wire);
- WR-01 monitors + profile legs: the same raw form on the response's stale `updatedAt`;
- WR-02 leg: `expected 500 to be 200` with `Update Monitor Error: Error: No values to set` at `mapUpdateSet` (drizzle-orm 0.45.2) — the exact 500 the empty-set PATCH produced.

`tests/lib/serialize.test.ts` was GREEN 7/7 in the same task (helper exists and is pure-correct before route adoption), per the plan's TDD shape.

## Files Created/Modified
- `src/lib/serialize.ts` (NEW) - the ONE API-boundary timestamp seam: `iso()` (naive→Z-appended UTC, offset text→parsed, ISO-Z→round-trip, null→null) + `isoRow()` (spread-and-overwrite row mapping)
- `tests/lib/serialize.test.ts` (NEW) - TZ-independent unit matrix (literal expected strings) + isoRow shape/order/null-contract pins
- `tests/integration/wire-timestamps.test.ts` (NEW) - real-DB wire regression suite: session-door-only mock, whole-table TRUNCATE per case (02-03), ISO-Z seed instants proven to round-trip at millisecond equality, WR-01/WR-02 behavioral legs
- `src/app/api/monitors/route.ts` - GET + POST responses through `isoRow` (full-row timestamps)
- `src/app/api/monitors/[id]/route.ts` - GET/PATCH responses through `isoRow` (incl. the WR-02 no-op echo); WR-02 empty-set guard; WR-01 updatedAt in the PATCH set
- `src/app/api/monitors/[id]/details/route.ts` - monitor row + `pings[].createdAt` + `incidents[].startedAt/resolvedAt` through `isoRow`
- `src/app/api/incidents/route.ts` - projection `startedAt/resolvedAt` through `isoRow`
- `src/app/api/status/route.ts`, `src/app/api/status/[userId]/route.ts` - monitor `lastChecked` (public page also incident `startedAt/resolvedAt`) through `isoRow`
- `src/app/api/user/profile/route.ts` - GET/returning rows through `isoRow`; WR-01 updatedAt in the PATCH set (password branch untouched — WR-03 is WINDOWS #4, Phase-8 scope)
- `src/app/api/feedback/route.ts` - GET projection + POST returning through `isoRow`
- `src/app/api/telegram/webhook/route.ts` - WR-01 updatedAt in the deep-link set (no timestamp-bearing response body)
- `src/lib/check-now-poll.ts` - completion comparison through `iso()`; `new Date(monitor.lastChecked)` raw parse eliminated (grep-pinned)
- `tests/api/monitors-id.handler.test.ts` - three UPDATE-set pins gain `updatedAt`; new WR-02 empty-body no-op case (update builder never invoked)
- `tests/api/feedback-admin.handler.test.ts` - naive-form fixture expectations became the ISO forms (stubbed rows flow through the route's normalizer)
- `tests/api/cron-and-webhook.handler.test.ts` - webhook set pin gains `updatedAt`
- `tests/lib/check-now-poll.test.ts` - new G-07-63 case: naive-text lastChecked AFTER queuedAt completes on the first read

## Decisions Made
- `iso()` canonicalizes before parsing (space→`T`, bare `+HH`→`+HH:00`) rather than adopting the review's drafted `value + "Z"` verbatim — the draft threw Invalid Date on ISO-Z passthrough (`"...789Z".slice(-3)` misses the designator) and relied on the lenient space-form parse; the canonical form is spec-defined, and the plan's behavior spec explicitly requires ISO-Z round-trip. The unit matrix pins it.
- `isoRow()` lives on the same seam (not per-route spreads) — one adoption line per response boundary, absent keys skipped, shape/order preserved.
- Wire-suite seeds use ISO-Z input strings so the suite proves the full DB round-trip (DB-stores-UTC convention live, not asserted).
- The profile PATCH password branch was deliberately NOT touched (review WR-03 = WINDOWS ledger #4, Phase-8 scope, out of this plan's scope) — annotated in the route header.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Build leg needed the documented env-file pattern on this env-less checkout**
- **Found during:** Task 3 (full verify, build leg)
- **Issue:** `pnpm build` failed prerendering `/_not-found`: `Error: Environment variable NEXT_PUBLIC_BASE_URL is not set` (src/redux/api/baseApi.ts:9) — the local `.env` carries none of the NEXT_PUBLIC/BETTER_AUTH keys (presence-only probe, no values read).
- **Fix:** The documented 07-06 deviation-2 pattern (DEPLOY-RUNBOOK §492/§529, DEPLOY-RECORD §412/§834): wrote the gitignored `.env.production` with the two non-secret values already committed in DEPLOY-RECORD prose (`NEXT_PUBLIC_ENV=production`, `NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3007`), ran the build (exit 0), deleted the file immediately after (teardown honored). No production service was touched.
- **Files modified:** none persisted (`.env.production` created then deleted; gitignored throughout)
- **Verification:** build leg exit 0 (`Compiled successfully`, Route (app) generated, `dist/worker.js` 140.53 KB)
- **Committed in:** n/a (no repo change)

---

**Total deviations:** 1 auto-fixed (1 blocking, via an established documented precedent).
**Impact on plan:** No scope creep — the plan's own Task 3 anticipated per-leg execution; the env-file pattern is the repo's recorded build procedure.

**Scope notes (not deviations):**
- `tests/api/monitors.handler.test.ts` and `tests/api/status.handler.test.ts` were in the plan's files list but needed NO edits: their fixtures carry no timestamp keys, and the normalizer is a verified no-op on them (both suites pass unchanged).
- The WR-02 no-op echo initially returned the raw `existingMonitor`; the wire suite caught the naive-form echo during Task 2's own verification run (before commit) and the guard now normalizes through `isoRow` — the TDD loop working as designed, fixed within the task.
- `src/lib/serialize.ts` received a typecheck-driven spread cast (`tsc --noEmit` clean), folded into the Task 2 commit.

## Issues Encountered
- None beyond the documented environmental exception: `tests/worker/health.test.ts` "binds 9090" fails with `EADDRINUSE: address already in use 127.0.0.1:9090` because the PRODUCTION worker holds that port by design (documented in 07-VERIFICATION.md and 07-09 §17.2). Per the plan, the chain stopped there and the remaining legs were proven individually green: schema:gate (untouched-green, empty diff), worker:boundary, denylist:diff, build, cron:remnants (428 files, armed gate green over the new code), test:e2e (18/18). The production stack (:3007/:9090/:5454/:6391) was never stopped or reconfigured.

## Verification

- Wire suite RED→GREEN: `tests/integration/wire-timestamps.test.ts` 4/4 GREEN after Task 2 (RED capture above)
- Touched suites: 99/99 tests GREEN across wire + serialize + poll + tests/api (10 files)
- `pnpm typecheck` exit 0; seam-adoption grep lists all 8 response routes + poll; raw-parse grep (`new Date(monitor.lastChecked)` in the poll) matches nothing
- Full verify: green modulo the single documented `health.test.ts` EADDRINUSE-:9090 environmental exception, all remaining legs individually green

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- The CR-01 wire contract is regression-pinned at the only seam that could see it; phase-08's windowed-uptime UI can trust every API timestamp as a spec-parseable instant.
- WINDOWS ledger: this plan closes gap G-07-63 (CR-01) and rides WR-01/WR-02 closed; WR-03 (profile password flow, #4) and WR-04 (gate scan scope) remain open for their planned dispositions.

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-29*
