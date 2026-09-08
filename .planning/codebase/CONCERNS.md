# Codebase Concerns

**Analysis Date:** 2026-09-08

## Tech Debt

**No test suite:**
- Issue: Zero automated tests. Only ad-hoc manual scripts at repo root (`test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`). No jest/vitest config, no `*.test.*` files.
- Files: entire `src/`
- Impact: Any change to cron logic, auth, or API routes risks silent regressions in the core product (uptime detection, alerting).
- Fix approach: Add vitest + a test harness for `src/lib/cron-logic.ts`, `src/lib/db-batcher.ts`, `src/lib/tokens.ts` first (pure-ish logic, highest value). Delete or move root `test-*.js` scripts into `scripts/`.

**next-auth v4 with Next 16 / React 19:**
- Issue: `next-auth@^4.24.15` is not officially compatible with `next@^16.0.10` / `react@^19.2.3`. Version mismatches surface as session quirks.
- Files: `package.json`, `src/lib/auth.ts`
- Impact: Subtle auth bugs; the "perform full page reload on login to ensure session state updates" hack (commit `e7142ae`, login flow) is a symptom of session-state staleness being papered over client-side.
- Fix approach: Follow the existing `UPGRADE_PLAN.md` migration path to Auth.js v5 / better-auth. Remove the full-reload hack after upgrade.

**Dead/duplicate config files:**
- Issue: `next.config.js` and `next.config.mjs` are both empty (0 bytes) while `next.config.ts` holds real config. Confusing which one is active.
- Files: `next.config.js`, `next.config.mjs`, `next.config.ts`
- Impact: Config confusion; risk of editing the wrong file.
- Fix approach: Delete the two empty files.

**Committed artifacts in repo root:**
- Issue: 33MB `ngrok` binary, `ngrok.log`, and ad-hoc test scripts are committed to git.
- Files: `ngrok`, `ngrok.log`, `test-email.js`, `test-prisma.js`, `test-prisma-adapter.js`, `test-webhook.js`
- Impact: Repo bloat; ngrok log may leak tunnel URLs.
- Fix approach: `git rm --cached ngrok ngrok.log`, add to `.gitignore`, move test scripts to `scripts/`.

**Starter-package leftover identity:**
- Issue: `package.json` name is `next-redux-starter`; Redux Toolkit + redux-persist are dependencies but the app is auth/session driven — Redux appears vestigial for most flows.
- Files: `package.json`
- Impact: Dependency weight and confusion about state management approach.
- Fix approach: Audit Redux usage; remove if only used for session/client cache that could be server state.

**Giant components:**
- Issue: `src/components/Dashboard/Dashboard.tsx` (849 lines) and `src/components/Dashboard/ProfileComponent.tsx` (818 lines) are monolithic client components mixing data fetching, state, and UI.
- Files: `src/components/Dashboard/Dashboard.tsx`, `src/components/Dashboard/ProfileComponent.tsx`
- Impact: Hard to modify safely, no test coverage, repeated fetch patterns.
- Fix approach: Extract data-fetching hooks (e.g., `useMonitors`) and sub-components per section.

## Known Bugs

**`findUnique` with non-unique filter throws:**
- Symptoms: GET single monitor (`/api/monitors/[id]`) likely errors at runtime.
- Files: `src/app/api/monitors/[id]/route.ts:29-31`
- Trigger: Any GET of a monitor detail. `prisma.monitor.findUnique({ where: { id, userId } })` — `findUnique` only accepts unique fields; `userId` is not part of a unique constraint, so Prisma rejects the query.
- Workaround: None; users fall back to the list endpoint.
- Fix: Use `findFirst({ where: { id: monitorId, userId: session.user.id } })` like PATCH/DELETE already do.

**PATCH/DELETE return `undefined` on invalid ID:**
- Symptoms: Requests with a non-numeric monitor ID hang until client timeout — handler returns bare `return` with no `NextResponse`.
- Files: `src/app/api/monitors/[id]/route.ts:62` (PATCH), `src/app/api/monitors/[id]/route.ts:132` (DELETE)
- Trigger: `PATCH /api/monitors/abc`
- Fix: Return `NextResponse.json({ error: "Invalid monitor ID" }, { status: 400 })` as GET does.

**Typo in API response:**
- Symptoms: POST `/api/monitors` returns `"Unauthirized"`.
- Files: `src/app/api/monitors/route.ts:49`
- Fix: Correct spelling to `"Unauthorized"` (check client code for string matching before changing).

## Security Considerations

**SSRF via monitor URL (HIGH):**
- Risk: Users can create monitors pointing at internal/private endpoints (`http://169.254.169.254/`, `http://localhost:5432/`, internal service names). The server fetches the URL with full trust in both the cron loop and manual check.
- Files: `src/lib/cron-logic.ts:64` (fetch), `src/app/api/monitors/route.ts:77-84` (validation only checks URL parse — no scheme, host, or IP restriction)
- Current mitigation: None. Only `new URL(url)` format check.
- Recommendations: Reject non-`http(s)` schemes; resolve DNS and block private/loopback/link-local CIDRs; optionally egress via a proxy. Do this in both POST and PATCH (`src/app/api/monitors/[id]/route.ts:86-93`).

**Telegram webhook is unauthenticated (HIGH):**
- Risk: `POST /api/telegram/webhook` performs no Telegram signature validation (`X-Telegram-Bot-Api-Secret-Token`). Anyone can forge a `/start <userId>` message and link an arbitrary chat ID to any user account, receiving that user's up/down alerts (or spamming them).
- Files: `src/app/api/telegram/webhook/route.ts:5-42`
- Current mitigation: None.
- Recommendations: Set a webhook secret via `setWebhook` and verify the header. Also note the confirmation message interpolates `user.name` into HTML `parse_mode` — sanitize or escape user-provided names to prevent broken/markup-injected Telegram messages.

**Login error messages enable user enumeration (MEDIUM):**
- Risk: Credentials login returns distinct errors — "No user found with this email" vs "Invalid Password" — allowing account discovery.
- Files: `src/lib/auth.ts:44`, `src/lib/auth.ts:59`
- Current mitigation: Forgot-password route correctly returns 200 regardless (`src/app/api/auth/forgot-password/route.ts:19-22`), but login does not follow the same practice.
- Recommendations: Return a generic "Invalid email or password" for both cases.

**Cron secret accepted via query string (LOW-MEDIUM):**
- Risk: `GET /api/cron/check?secret=...` is accepted; secrets in query strings get logged by proxies/access logs.
- Files: `src/app/api/cron/check/route.ts:9`, `src/app/api/cron/check/route.ts:19-28`
- Recommendations: Only accept the `Authorization: Bearer` header.

**Stack trace leaked in API error response:**
- Risk: 500 response from the cron route includes `error: err.message, stack: err.stack`.
- Files: `src/app/api/cron/check/route.ts:45`
- Recommendations: Log server-side, return a generic message.

**Public status endpoint exposes monitor URLs:**
- Risk: `/api/status/[userId]` returns each monitor's full `url` with no auth. Internal/admin URLs users monitor become publicly enumerable by user ID.
- Files: `src/app/api/status/[userId]/route.ts:25-38`
- Current mitigation: Requires knowing the user's cuid.
- Recommendations: Return hostname only, or add a per-user "public status page enabled" flag.

**Rate limiting is in-memory and narrowly applied:**
- Risk: `src/lib/rate-limit.ts` uses a module-level Map — resets on deploy/restart and does not work across multiple instances. Also only applied to monitor creation (20/min). Auth-sensitive routes (`register`, `forgot-password`, `reset-password`, `verify-email`) and incident/feedback routes are unprotected — `forgot-password` drives outbound email (cost/abuse vector).
- Files: `src/lib/rate-limit.ts`, `src/app/api/monitors/route.ts:37-45`
- Recommendations: Add rate limits to all auth and email-sending routes; move to a persistent store (Redis) if the app ever scales horizontally.

**Weak password policy:**
- Risk: Password change only requires 6 characters (`src/app/api/user/profile/route.ts:120`); no complexity or breached-password checks. OAuth-only users can set a password without any current-password verification (by design, but means a stolen session can add credentials).
- Files: `src/app/api/user/profile/route.ts:119-152`
- Recommendations: Raise minimum length, add zod validation shared with the register route.

## Performance Bottlenecks

**Per-monitor sequential DB writes on status change:**
- Problem: Slow path performs monitor.update + ping.create + incident create/resolve as separate awaited calls per monitor inside the cron loop.
- Files: `src/lib/cron-logic.ts:165-205`
- Cause: No transaction or batching for the slow path; with many monitors changing status simultaneously this multiplies round trips.
- Improvement path: Wrap each monitor's slow-path writes in `prisma.$transaction`, or collect and batch like the routine path.

**Unbounded concurrent fetch fan-out:**
- Problem: All due monitors are fetched concurrently in one `Promise.allSettled` — with hundreds of monitors this spikes memory/sockets and can trip egress limits.
- Files: `src/lib/cron-logic.ts:55-56`
- Cause: No concurrency cap or chunking.
- Improvement path: Chunk into batches (e.g., 20-50) or use `p-limit`.

**Flush does N+1 reads:**
- Problem: `flushBatches` fetches each monitor individually before updating.
- Files: `src/lib/db-batcher.ts:80-104`
- Cause: Needs current counters to compute uptime; no single grouped query.
- Improvement path: Use `prisma.$transaction` with SQL-side increments (`{ increment: n }`) and compute uptimePercent in the same update.

**Pings table growth:**
- Problem: 10 monitors at 1-min intervals = ~14k rows/monitor/day between 30-day cleanups; `Ping` has only a `monitorId` index, and cleanup deletes with `createdAt` filter (`src/lib/cleanup-logic.ts:12-18`) — full scans on large tables.
- Files: `prisma/schema.prisma:87-98`, `src/lib/cleanup-logic.ts`
- Improvement path: Add index on `createdAt` (or composite `[monitorId, createdAt]`); use `deleteMany` in chunks to avoid long transactions.

## Fragile Areas

**In-memory db-batcher state:**
- Files: `src/lib/db-batcher.ts`
- Why fragile: Queued pings/stats live only in process memory. A crash loses up to 15 minutes of routine check data (acknowledged in code comment at `db-batcher.ts:108-112`). On multi-instance/serverless deployments each instance has its own queue, and the serverless-style immediate flush in `src/app/api/cron/check/route.ts:35-36` can race with the internal cron flush in `src/instrumentation.ts:56-64`.
- Safe modification: Any change to queue/flush semantics must consider both flush call sites (cron route + instrumentation schedule + SIGTERM/SIGINT handlers).
- Test coverage: None.

**Dual-cron strategy:**
- Files: `src/instrumentation.ts:6-27`, `src/app/api/cron/check/route.ts`
- Why fragile: Correctness depends entirely on the `CRON_MODE` env var being set correctly per environment. Misconfiguration (unset on Vercel) causes duplicate checks — duplicate alerts and double-counted stats. Interval-due filtering in `cron-logic.ts:33-46` mitigates but relies on `lastChecked` being fresh.
- Safe modification: Read `src/instrumentation.ts` before touching any cron behavior; document required env per deploy target.

**Alert-before-persist ordering:**
- Files: `src/lib/cron-logic.ts:102-135` vs `:165-177`
- Why fragile: Telegram alerts are sent before the DB write confirms the status change. If the DB write fails, users got an alert for a change that never recorded; incident records can diverge from alert history.
- Safe modification: Consider moving alert dispatch after successful persistence.

**`any`-typed update payloads:**
- Files: `src/lib/cron-logic.ts:156` (`updateData: any`), `src/app/api/user/profile/route.ts:93`, `src/app/api/monitors/[id]/route.ts:65,83`
- Why fragile: No type checking on dynamic field updates — typos in field names compile fine and silently write wrong/no data.
- Test coverage: None.

## Scaling Limits

**Single-instance architecture:**
- Current capacity: One PM2 process (`ecosystem.config.js`) on a VPS; in-memory rate limiter and batcher.
- Limit: Horizontal scaling or serverless breaks rate limiting (bypass) and batching (data loss/races) immediately.
- Scaling path: Externalize rate limit + batch queue (Redis), then the app can run multi-instance.

**Monitor count limits:**
- Current capacity: 10 monitors/user enforced in `src/app/api/monitors/route.ts:57`; no global monitor ceiling.
- Limit: Every active monitor adds a fetch + possible DB writes per minute in a single tick; runtime per tick grows linearly.
- Scaling path: Concurrency caps (above) then a real queue (BullMQ) if the global monitor count grows.

## Dependencies at Risk

**Prisma 7 preview feature `driverAdapters`:**
- Risk: `previewFeatures = ["driverAdapters"]` with `@prisma/adapter-pg` — preview APIs can change between Prisma versions; migrations may be required on upgrade.
- Impact: Build breaks on Prisma upgrades until adapter API is updated.
- Migration plan: Track Prisma GA of driver adapters; pin exact Prisma versions (currently `^7.9.1`).

**next-auth v4 (see Tech Debt above):**
- Risk: EOL-ish major version against Next 16.
- Impact: Auth regressions; blocks adopting server components-based auth.
- Migration plan: Already outlined in `UPGRADE_PLAN.md`.

## Missing Critical Features

**No pagination on monitor/incident listings:**
- Problem: `GET /api/monitors` returns all monitors; `MonitorDetails`/`Incidents` fetch full ping/incident sets per monitor.
- Blocks: Scaling to realistic ping volumes; page loads degrade as history grows (30-day retention helps, but 30 days of 1-min pings is still ~43k rows per monitor).
- Files: `src/app/api/monitors/route.ts:16-19`, `src/app/api/monitors/[id]/details/route.ts`

**No CSRF/origin checks on webhook:**
- Problem: See Security — Telegram webhook lacks secret-token verification.
- Blocks: Safe operation of Telegram integration.

## Test Coverage Gaps

**Everything:**
- What's not tested: All API routes, cron logic, batcher, cleanup, tokens, auth callbacks, frontend components. No framework installed, no CI.
- Files: `src/` (entire tree)
- Risk: The highest-risk logic in the product — status-change detection, incident open/resolve, uptime math (`src/lib/cron-logic.ts:149-154`, `src/lib/db-batcher.ts:89-91`) — is untested and duplicated in two places (slow path and flush), so they can drift apart silently.
- Priority: High. Start with unit tests for `cron-logic.ts` status-transition matrix (PENDING/UP/DOWN combinations) and `db-batcher.ts` counter math.

---

*Concerns audit: 2026-09-08*
