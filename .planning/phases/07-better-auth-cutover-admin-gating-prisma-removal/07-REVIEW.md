---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
reviewed: 2026-09-29T20:30:00Z
depth: standard
files_reviewed: 29
files_reviewed_list:
  - .env.example
  - docs/DEPLOY-RUNBOOK.md
  - drizzle/0003_drop_legacy_auth_tables.sql
  - drizzle/meta/0003_snapshot.json
  - drizzle/meta/_journal.json
  - package.json
  - scripts/check-cron-remnants.mjs
  - scripts/rehearse-migrations.mjs
  - scripts/schema-gate.mjs
  - src/app/(authLayout)/login/page.tsx
  - src/app/api/feedback/route.ts
  - src/app/api/incidents/route.ts
  - src/app/api/monitors/[id]/check/route.ts
  - src/app/api/monitors/[id]/details/route.ts
  - src/app/api/monitors/[id]/route.ts
  - src/app/api/monitors/route.ts
  - src/app/api/status/[userId]/route.ts
  - src/app/api/status/route.ts
  - src/app/api/telegram/test/route.ts
  - src/app/api/telegram/webhook/route.ts
  - src/app/api/user/profile/route.ts
  - src/components/dashboardLayout/AppSidebar.tsx
  - src/components/dashboardLayout/TeamSwitch.tsx
  - src/db/schema.ts
  - src/lib/auth-client.ts
  - src/lib/auth-password.ts
  - src/redux/api/baseApi.ts
  - src/redux/features/rootReducer.ts
  - src/redux/store.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 07: Code Review Report

**Reviewed:** 2026-09-29T20:30:00Z
**Depth:** standard
**Files Reviewed:** 29 (of 36 in scope; 7 paths were deleted by design per D-29/D-32/D-05 and verified absent — skipped, not findings)
**Status:** issues_found

## Summary

Reviewed the phase-07 window (8c974d25..HEAD): the 11 Prisma→Drizzle route ports, the AUTH-09 lazy-rehash both-copies fix, the armed remnant gate, the 0003 drop migration (+ journal/snapshot chain), the Redux/baseApi token-mirror removal, and the runbook §4d/§4e choreography. Deleted-by-design paths (src/lib/prisma.ts, src/lib/auth-legacy.ts, authSlice.ts, next-auth.d.ts, send-relogin-blast.mjs, LoginNotice.tsx, notice-window.ts) were confirmed absent on disk and NOT flagged.

Per-focus verdicts:

1. **Route ports (11 routes):** ownership scoping, projections, orderings, bounds, and vanished-row 500 guards are faithful to the Prisma originals (verified against the pre-window diff). However, ONE systematic wire-contract break was found: every timestamp field in every ported response changed format because drizzle-orm/node-postgres returns raw Postgres text for timestamp columns while Prisma returned ISO-8601 UTC — **CR-01**. Two smaller drifts: `updatedAt` no longer advances on UPDATE (**WR-01**) and an empty-set PATCH now 500s where Prisma returned 200 (**WR-02**). No N+1, no missing transactions introduced (details route's 3 sequential queries match Prisma's relation load shape; monitor count+insert race is pre-existing, semantics preserved).
2. **Rehash fix (src/lib/auth-password.ts):** correct. Both stored copies are upgraded keyed on the received hash; a diverged copy is never rewritten by a hash it does not hold; SQL is parameterized; fire-and-forget failure is logged not thrown. The two UPDATEs are not in one transaction, but a partial application only re-creates the tolerated divergence state and the next sign-in retries — benign by design.
3. **Armed gate (scripts/check-cron-remnants.mjs):** detection logic is sound (specifier forms, comments-inclusive token counts, arming flag, sanctioned exemptions). Two scope weaknesses: the scan never covers `scripts/` or any source outside `src/`, so the exact D-05 class this phase armed against (a re-created `scripts/send-relogin-blast.mjs`) would slip through undetected (**WR-04**); and the `.next` NEXTAUTH_URL read-form exemption is not library-scoped (**IN-01**).
4. **Drop migration (drizzle/0003):** verified exactly the four sanctioned drops; programmatic diff of 0002→0003 snapshots shows 14→10 tables with zero other changes; no surviving table holds an FK into the dropped set (nothing silently CASCADE-dropped); `users.password` retained; journal (idx 0-3) and snapshot prevId chain intact; irreversibility documented in the SQL header and §4e. Clean.
5. **Cookie-credentials posture (baseApi.ts, auth-client.ts, TeamSwitch.tsx):** no Authorization header is minted anywhere in src/; `credentials: "include"` carries the Better Auth session cookie; sign-out is the single `authClient.signOut()` call; stale persisted `auth` redux key is dropped harmlessly by combineReducers. Clean.

## Critical Issues

### CR-01: Drizzle port changed every API timestamp from ISO-8601 UTC to raw Postgres text — breaks the manual-check completion poll in all non-UTC timezones

**File:** `src/app/api/monitors/route.ts:26-30` (representative; systemic across all 11 ported routes — monitors GET/POST, monitors/[id] GET/PATCH/DELETE, monitors/[id]/details, monitors/[id]/check, incidents, status, status/[userId], telegram/test, user/profile GET/PATCH, feedback POST)
**Issue:** The ports claim "byte-identical wire contracts", but the response serialization changed. Prisma returned JS `Date` objects, which `NextResponse.json` serializes as ISO-8601 UTC (`"2026-09-29T15:00:00.789Z"`). The Drizzle schema declares these columns `timestamp({ mode: 'string' })`, and the installed `drizzle-orm/node-postgres` driver (0.45.2, `node_modules/drizzle-orm/node-postgres/session.js:26-56`) overrides the pg type parsers so TIMESTAMP/TIMESTAMPTZ values are returned as **raw Postgres wire text** — for the naive `timestamp(3)` columns exposed by these routes that is `"2026-09-29 15:00:00.789"` (space separator, **no timezone designator**). Per ECMAScript, that form is parsed as **local time**, not UTC. Consequences, all verified in the consumers:

- `src/lib/check-now-poll.ts:63` — `new Date(monitor.lastChecked).getTime() > opts.queuedAt` compares against `Date.now()`-based `queuedAt`. In any browser **ahead of UTC** (e.g. the operator's UTC+6) the parsed `lastChecked` lands hours in the past, so the D-01 completion test can never pass within the 30s deadline — the "check now" poll ALWAYS times out and resolves null. In any browser **behind UTC**, stale pre-check values satisfy the test immediately — false-positive completion. The poll was built pre-window (`c031e72`, 06-01) against the Prisma ISO format; this phase silently broke it.
- Display shifts: `src/components/Dashboard/Dashboard.tsx:610-613`, `src/components/Dashboard/MonitorDetails.tsx:171`, `src/components/Status/PublicStatus.tsx:208` all render `new Date(monitor.lastChecked).toLocaleTimeString()` — the UTC wall-clock is now relabeled local, shifting every shown time by the UTC offset.
- The handler tests cannot catch this (they stub the `@/db` seam with hand-built rows), which is why 408/408 stayed green.

**Fix:** Normalize at the API boundary — convert the driver's naive UTC text to ISO-8601 before responding, via one shared helper used by every ported route (confirm the stored convention first: DB session TZ is UTC, so naive values are UTC wall-clock):

```ts
// src/lib/serialize.ts
export function iso(value: string | null): string | null {
  if (!value) return value;
  // timestamptz text already carries an offset; naive timestamp text is UTC.
  return /[z+Z]/.test(value.slice(-3)) ? new Date(value).toISOString() : new Date(value + "Z").toISOString();
}
```

Apply to `createdAt`, `updatedAt`, `lastChecked`, `startedAt`, `resolvedAt` (and `emailVerified` where exposed) in each route's response mapping, then add a regression test on the real DB asserting the JSON timestamp matches `/^\d{4}-\d{2}-\d{2}T.*Z$/`. Alternative (larger): switch the schema columns to `mode: 'date'` and map at the boundary — but that re-touches the gate-protected schema file; the route-level mapper is the minimal fix.

## Warnings

### WR-01: `updatedAt` no longer advances on UPDATE in the ported write paths (Prisma @updatedAt lost)

**File:** `src/app/api/monitors/[id]/route.ts:130-134`; also `src/app/api/user/profile/route.ts:170-182` and `src/app/api/telegram/webhook/route.ts:84-88`
**Issue:** Prisma's client-side `@updatedAt` auto-bumped the column on every `update`; the ports were aware of this on INSERT (monitors POST and feedback POST supply `updatedAt` explicitly, with an explanatory comment) but the UPDATE paths `.set(updateData)` without it. `updatedAt` is NOT NULL with no DB default, so the UPDATE succeeds but silently leaves the stale value — and the responses (`returning({ ... updatedAt: users.updatedAt })`) now return outdated `updatedAt` to clients. Directly contradicts the routes' own "identical projections and wire contracts" claim.
**Fix:** Add `updatedAt: new Date().toISOString()` to each `.set()` (or a shared `withUpdatedAt(updateData)` helper) in monitors PATCH, profile PATCH, and the telegram webhook user update.

### WR-02: monitors PATCH with an empty update set now 500s where Prisma returned 200

**File:** `src/app/api/monitors/[id]/route.ts:81-86,101-134`
**Issue:** The route deliberately tolerates an empty body (`// Ignore JSON parse error if body is empty (manual ping)`), but with `body = {}` the built `updateData` is empty and Drizzle's `.set({})` throws ("No values to set"), surfacing as the catch-all 500 "Failed to update monitor". Prisma's `update({ data: {} })` was a no-op success returning the row (200). An edge-case wire-contract drift on a request shape the code explicitly anticipates. (The profile PATCH guards this case with its own "No fields provided" 400 — the monitors PATCH has no equivalent guard.)
**Fix:** Before the UPDATE: `if (Object.keys(updateData).length === 0) { return NextResponse.json({ message: "Monitor updated successfully", monitor: existingMonitor }, { status: 200 }); }` (no-op success, Prisma-equivalent), or return a descriptive 400 if the no-op contract is consciously retired.

### WR-03: Profile-route password flow verifies/writes `users.password` while the engine authenticates `account.password` — a profile-set password never changes the login credential

**File:** `src/app/api/user/profile/route.ts:128-161`
**Issue:** PATCH's password branch bcrypt-compares `currentPassword` against `existingUser.password` (the legacy `users` copy) and writes the new hash back to the same column. Better Auth signs in against `account.password`, so: (a) after a "successful" password change the OLD password keeps working at sign-in — a password rotation that fails to revoke the compromised credential; (b) the NEW password fails at sign-in; (c) for post-cutover users (no `users.password` row) the whole flow is inert yet flips `hasPassword` to true. This is recorded as open WINDOWS ledger entry #4 (Phase-8 scope) — listed here so the adversarial record carries it: it is a live security-relevant defect in a reviewed file, not merely a UX quirk.
**Fix:** Route the flow through Better Auth's server API (`auth.api.changePassword({ body: { currentPassword, newPassword }, headers })`) so both the verification and the write hit the engine's credential — that also keeps the rehash/divergence machinery in one place. Until Phase 8, minimally reject password changes in this route (501 with a "use the reset flow" message) rather than writing a credential that does not take effect.

### WR-04: Armed remnant gate never scans `scripts/` (or any source outside `src/`) — a re-created D-05 blast script is invisible

**File:** `scripts/check-cron-remnants.mjs:147-158` (`DEFAULT_ROOTS`) and `94-100,233-236` (deleted-basename checks apply only to import specifiers inside scanned roots)
**Issue:** The default scan roots are `src/`, `dist/worker.js`, `.next/server`, three root config files, and package.json (dependencies only). The D-05 delete-after-use blast script this phase deleted lived at `scripts/send-relogin-blast.mjs`; re-creating that file (or any `scripts/*.mjs` remnant, or a root-level `instrumentation.ts`) produces zero findings — the basename rules trip only on import specifiers inside scanned roots, and package.json's `scripts` block is never inspected. T-07-28's "armed gate is the permanent reintroduction blocker" has a hole exactly where one of its named remnants lived. (A live demonstration exists in-tree: `scripts/auth-soak-gate.mjs:75` still names the deleted `LoginNotice.tsx` in a comment, unflagged because `scripts/` is out of scope.)
**Fix:** Add `scripts` to `DEFAULT_ROOTS()` (and `check-worker-boundary`-style root config files as needed), keeping the existing prose-home exclusions; add a fixture pin asserting a `send-relogin-blast`-named file under a scanned root trips check 9 by file name, not only by import specifier.

## Info

### IN-01: `.next` NEXTAUTH_URL read-form exemption is not library-scoped

**File:** `scripts/check-cron-remnants.mjs:311-316`
**Issue:** For any `.next/**` artifact, ALL exact `process.env.NEXTAUTH_URL` property-read occurrences are subtracted — not just better-auth's bundled helper. A third-party (or injected) dependency whose only .next trace is that read form is silently exempted. Documented and fixture-pinned, and any real framework reintroduction still trips the src/ + package.json checks first, so residual risk is narrow. Note the asymmetry: the same bundled read in `dist/worker.js` would NOT be exempted (currently green, but a future worker-side better-auth bundle change could red the gate from this inconsistency).
**Fix:** When convenient, scope the exemption to chunks whose content also matches a better-auth fingerprint, or extend it to `dist/worker.js` symmetrically with its own pin; otherwise leave documented as-is.

### IN-02: Rehearsal evidence renderer labels FATAL removals as sanctioned

**File:** `scripts/rehearse-migrations.mjs:586`
**Issue:** The DDL-delta evidence line appends "(0003 sanctioned drops of the four legacy tables)" to "Removed/changed indexes" unconditionally — including when a removal was NOT in `SANCTIONED_DROPS_0003` (which correctly fails the rehearsal). The verdict stays correct (exit non-zero), but the committed evidence markdown would mislabel a fatal, unsanctioned index drop as sanctioned — evidence-truthfulness wart in a file whose output is cited as proof.
**Fix:** Render the sanction tag per-name via the existing `tagRemoved` helper instead of the unconditional suffix.

### IN-03: Orphaned display data and unused imports left in TeamSwitch after the authSlice removal

**File:** `src/components/dashboardLayout/TeamSwitch.tsx:2,8,30-39`
**Issue:** `Avatar/AvatarImage/AvatarFallback` imports, the `Activity` icon alias, and `displayName/displayEmail/displayAvatar/displayFallback` are consumed only by commented-out JSX blocks (pre-existing dead code, now fully orphaned since AppSidebar passes user data that nothing renders). Harmless, but dead weight in a file this phase modified.
**Fix:** Delete the commented-out blocks and the imports/derived values they uniquely feed, or extract the profile-chip into a real component when it returns.

---

_Reviewed: 2026-09-29T20:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
