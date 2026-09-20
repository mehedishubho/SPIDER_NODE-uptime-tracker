---
phase: "06"
plan: "03"
subsystem: boundary-security
tags: [ssrf, webhook-auth, telegram, rate-limiting, html-escaping, thin-routes]
requires:
  - "D-38 SSRF check pipeline (src/lib/ssrf.ts, 04-06)"
  - "Redis rate limiter (03-01, @/lib/rate-limit)"
  - "apiError helper (06-01, @/lib/api-error)"
  - "Outbox relay renderAlertMessage (05-xx, src/worker/persist/outbox.ts)"
provides:
  - "assertUrlAllowed(url) + UrlNotAllowedError — DNS-only admission export from @/lib/ssrf (D-23)"
  - "SSRF admission wired at POST /api/monitors and PATCH /api/monitors/[id] (conditional, D-25)"
  - "Telegram webhook secret-token auth: constant-time compare, unset env = loud 500 (SEC-03/D-20)"
  - "Per-IP 30/min limiter on the Telegram webhook ahead of any DB write (D-21)"
  - "HTML-escaped user.name in the webhook confirmation (D-24) and monitorName/monitorUrl in alert renders (D-16/IN-04)"
affects:
  - "src/app/api/telegram/webhook/route.ts"
  - "src/lib/ssrf.ts"
  - "src/app/api/monitors/route.ts"
  - "src/app/api/monitors/[id]/route.ts"
  - "src/worker/persist/outbox.ts"
tech-stack:
  added: []
  patterns:
    - "DNS-only admission wrapper reusing pipeline layers 1-2 (scheme allowlist + resolve-then-denylist), no target fetch"
    - "Typed admission error (UrlNotAllowedError) with user-actionable internals-free messages; infra failures propagate unwrapped → 500 fail-closed"
    - "timingSafeEqual behind a length guard (RangeError → 500 on spoofed requests, Pitfall 4)"
    - "escapeHtml trio (& < >) at parse_mode HTML interpolation sites — byte-neutral for plain values (D-48 discipline)"
key-files:
  created: []
  modified:
    - src/app/api/telegram/webhook/route.ts
    - src/lib/ssrf.ts
    - src/app/api/monitors/route.ts
    - "src/app/api/monitors/[id]/route.ts"
    - src/worker/persist/outbox.ts
    - tests/api/cron-and-webhook.handler.test.ts
    - tests/api/monitors.handler.test.ts
    - tests/api/monitors-id.handler.test.ts
    - tests/lib/ssrf.test.ts
    - tests/worker/outbox-relay.test.ts
decisions:
  - "assertUrlAllowed is DNS-only: reuses validateHop layers 1-2 of the D-38 pipeline and performs no fetch/redirect/body read — admission resolves, it never dials"
  - "Admission runs on the TRIMMED url (the exact string stored) at POST, and at PATCH only when the request carries a url field (D-25) — name/interval-only patches never re-validate a stored private URL"
  - "UrlNotAllowedError messages: ssrf_blocked/dns/timeout actionable strings carrying no resolution internals; resolver outages (EAI_AGAIN/...) propagate unwrapped so routes answer 500 (fail closed, never laundered into 400 or a silent accept)"
  - "Webhook admission ladder: 30/min per-IP limiter (D-21) FIRST, secret-token check (D-20) second — spoofed traffic burns the window before touching the DB"
  - "Webhook + alert renders share the D-24 escape set (& < > only): Telegram parse_mode HTML needs exactly that trio, and characters outside it render byte-identically (D-48 pins stayed green untouched)"
metrics:
  duration: 20m 30s
  completed: 2026-09-21
status: complete
---

# Phase 06 Plan 03: Boundary Security & Route Hygiene Summary

One-liner: Constant-time secret-token auth + per-IP limiter on the Telegram webhook, DNS-only SSRF admission (assertUrlAllowed) wired into monitor create/update with the D-17 route-defect fixes (findFirst scoping, 400s on bad ids, typo), and HTML-escaping at every parse_mode HTML interpolation site.

## What Was Built

### Task 1 — Telegram webhook secret-token auth (SEC-03 / S-2 closure) — f6f5861

`src/app/api/telegram/webhook/route.ts` rewritten with a three-rung admission ladder:

1. **Per-IP rate limit (D-21)** — 30 req/min via the Redis Lua limiter, generous for Telegram's server-side retries, ahead of any DB write. Spoofed no-secret traffic burns the window (pinned: 30 fillers 401, the 31st — WITH the correct secret — 429).
2. **Secret-token auth (D-20)** — `X-Telegram-Bot-Api-Secret-Token` compared with `crypto.timingSafeEqual` behind an explicit length guard (an unguarded compare RangeErrors into a 500 on the exact spoofed request it exists to refuse — Pitfall 4; pinned with a wrong-length 401 case). An unset `TELEGRAM_WEBHOOK_SECRET` throws a loud config error surfacing as a logged 500 — never a fail-open accept (pinned: unset env → 500, body never processed, `TELEGRAM_WEBHOOK_SECRET` named in the log).
3. **Payload handling** — `/start <userId>` deep-link binding unchanged; `user.name` now HTML-escaped before entering the parse_mode HTML confirmation (D-24). Plain names render byte-identically (pinned character-for-character).

The flipped S-2 marker (previously "unauthenticated /start processed end-to-end") now pins the enforced contract: no secret header → 401, the chat-binding write NEVER runs. The one-time `setWebhook` registration that makes Telegram send the header is a runbook step (06-04) — enforcement is code-complete here.

### Task 2 — SSRF admission + D-17 route-defect fixes — 2bb9a75

**`src/lib/ssrf.ts`** — new DNS-only admission section (D-23):
- `UrlNotAllowedError` — the typed refusal; its message is the user-actionable 400 body, never carrying resolution internals (pinned: message contains neither the resolved address nor the queried hostname).
- `assertUrlAllowed(url)` — reuses `validateHop` (layers 1-2: scheme allowlist, resolve-then-denylist with canonicalization) with a 10 s AbortController budget and performs NO target fetch (pinned: resolves in milliseconds with the lookup stub recording the hostname call). Literal-IP hosts validate without any DNS (pinned both directions). Refusal classes map to actionable messages (`ssrf_blocked` / `dns` / `timeout`); resolver-level infra failures (EAI_AGAIN) propagate UNWRAPPED so the route answers 500 — admission fails closed (pinned at both the lib and route level).

**`src/app/api/monitors/route.ts` (POST)** — after the existing URL format check, `await assertUrlAllowed(url.trim())`: deny → 400 with the typed message verbatim; infra → rethrow → 500 "Failed to create monitor" with `create` never called (pinned). The 401 "Unauthirized" typo fixed to "Unauthorized" (D-17; the pin flipped in the same change — research verified exactly one production site and zero client string-matching). `apiError` adopted on touched responses (D-32); the 429 keeps `NextResponse.json` for its `X-RateLimit-Remaining` header.

**`src/app/api/monitors/[id]/route.ts`** — GET `findUnique` → `findFirst` for the compound `{ id, userId }` ownership scope (findUnique cannot express non-unique compound scoping — D-17); PATCH/DELETE bare `return` on non-numeric ids → 400 "Invalid monitor ID" (was a 500 over the wire — D-17); PATCH url branch restructured: format check → admission on the trimmed url → store (D-25 conditional — a name/interval-only patch on a stored private-URL monitor performs zero validation, pinned).

Acceptance check: no production caller assigns the `CheckRequest.denylist` test seam — the only `denylist` occurrences in `src/` are the type declaration and comments in `ssrf.ts` itself; the routes reach the pipeline solely through `assertUrlAllowed`.

### Task 3 — HTML-escaped alert renders (D-16 / IN-04) — 083d08f

`src/worker/persist/outbox.ts` — module-local `escapeHtml` (the D-24 trio: & < >) applied at all six `monitorName`/`monitorUrl` interpolation sites across the three `renderAlertMessage` templates. Byte-neutral for plain values: the pinned D-48 character-for-character renders (cases 2, 2b) stayed green UNTOUCHED. New cases: 2c pins the escaped form on all three templates (and that raw metacharacters never survive), 2d pins the relay-level path — a hostile name completes the send (`sent=1`, no failure marker) with the delivered body carrying the escaped form (a raw `<Beta>` would be a Telegram 400-class parse failure in production).

## Verification

- Task suites GREEN per task; full suite after Task 3: **40 files / 376 tests passed** (`pnpm test`), `pnpm typecheck` clean.
- TDD gates respected: each task has a RED `test(...)` commit followed by its GREEN `feat(...)` commit (see below).
- The cron-route pinned defects (S-4 query-string secret, stack echo) were NOT touched — they are 06-04+ scope; their describe blocks are byte-identical.

## TDD Gate Compliance

| Task | RED | GREEN |
| ---- | --- | ----- |
| 1 | c57835c | f6f5861 |
| 2 | e280087 | 2bb9a75 |
| 3 | 2fbf252 | 083d08f |

All three RED runs failed for the intended reasons before any implementation existed (Task 2's RED included the missing-export failure mode: `UrlNotAllowedError`/`assertUrlAllowed` did not exist; Task 1's RED is documented in its commit).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TDZ ReferenceError in the ssrf vi.mock seam**
- **Found during:** Task 2 RED run
- **Issue:** The mock factory closed over plain `const ssrfMocks` / `let ssrfActual` — `vi.mock` hoists the factory above the module body, so both bindings were in the temporal dead zone at link time ("Cannot access 'ssrfActual' before initialization"), failing both API suites for the wrong reason.
- **Fix:** Moved the mock state into a single `vi.hoisted(() => ({ assertUrlAllowed: vi.fn(), actual: null }))` container (the repo's established cron-suite pattern). No production impact.
- **Files modified:** tests/api/monitors.handler.test.ts, tests/api/monitors-id.handler.test.ts
- **Commit:** e280087

**2. [Rule 1 - Bug] Overload-unsafe cast in the DNS stub passthrough**
- **Found during:** Task 2 typecheck
- **Issue:** `Parameters<typeof actual.lookup>[1]` indexes past the last overload of `dns.promises.lookup` (single-argument), producing two TS errors (TS2769/TS2493).
- **Fix:** Narrowed the real lookup through a plain `(hostname: string, options: unknown) => Promise<...>` call signature instead of the tuple cast.
- **Files modified:** tests/lib/ssrf.test.ts
- **Commit:** 2bb9a75

Otherwise the plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no security-relevant surface beyond the plan's own threat model was introduced. (The new `assertUrlAllowed` admission and webhook secret enforcement ARE the planned SEC-03 mitigations.)

## Self-Check: PASSED

All 10 modified files exist on disk; all 6 task commits (c57835c, f6f5861, e280087, 2bb9a75, 2fbf252, 083d08f) verified in git log. Full suite 376/376 green; typecheck clean.
