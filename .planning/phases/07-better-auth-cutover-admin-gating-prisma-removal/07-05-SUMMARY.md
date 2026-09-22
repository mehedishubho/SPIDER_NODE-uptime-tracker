---
phase: 07-better-auth-cutover-admin-gating-prisma-removal
plan: 05
subsystem: infra
tags: [bull-board, hono, better-auth, admin-gating, ip-allowlist, cidr, pino, worker, observability]

# Dependency graph
requires:
  - phase: 07-better-auth-cutover-admin-gating-prisma-removal (07-03)
    provides: the shared Better Auth instance at src/lib/auth (createAuth, admin plugin role primitive, DB-backed sessions) the worker's session gate calls
  - phase: 04-worker-foundation (04-01)
    provides: the :9090 node:http health server with StartHealthServerOptions injectable-options convention (metricsRegistry precedent)
provides:
  - Bull Board mounted at /admin/queues on the worker's existing :9090 health server behind two independent gates — socket-source IP allowlist (Gate 1, health.ts) then Better Auth admin session (Gate 2, the shared createAuth instance), refusals answered by our server code with 403 JSON + a D-16 audit line, mutation powers kept (D-19)
  - src/lib/ip-allowlist.ts — fail-closed, CIDR-aware ADMIN_IP_ALLOWLIST parser/matcher (ipaddr.js), with mapped-IPv6 socket normalization and the isLoopbackRemote helper
  - Per-path source gating on a non-loopback bind (T-07-19/Pitfall 8): healthz/readyz/metrics answer loopback-source sockets only while /admin/queues answers allowlisted sources — the runbook §4c flip configuration
  - Gate-matrix integration suite (9 real-stack cases) proving the gate order, spoofed-header refusal, empty-allowlist fail-closed, D-16 audit lines, A5 static-asset bridging, and POST mutation reachability
affects: [07-06 (D-34 rehearsal exercises this mount on the stand-in), 07-07 (D-31 soak checklist Bull Board legs), 07-08/07-09 (deletion gates scan worker surface)]

# Actuals (#2632) — pairs with the plan's estimate (44000 tokens / 3 tasks) to calibrate future estimates.
actuals:
  tokens: 15081    # chars/4 over the realized diff (a1d2e87..a8841c7)
  tasks: 3
  commits: 3       # MEASURED: git rev-list --count a1d2e87..HEAD

# Tech tracking
tech-stack:
  added: ["@bull-board/api@9.10.1", "@bull-board/hono@9.10.1", "@bull-board/ui@9.10.1 (transitive)", "hono@4.13.8", "@hono/node-server@2.1.1", "ipaddr.js@2.5.0"]
  patterns: ["injectable-options health server fields (bullBoardHandler, allowlist) — metricsRegistry precedent", "gate chain: socket-source allowlist in the delegation branch, session gate in the mounted handler, refusals answered by our code never by Bull Board", "one injectable pino child owns the whole D-16 audit stream (refuseAndAudit unifies Gate 1 refusals)", "request-listener bridge: getRequestListener(app.fetch) mounts a fetch-style app on the existing node:http server"]

key-files:
  created:
    - src/worker/bull-board.ts
    - src/lib/ip-allowlist.ts
    - tests/lib/ip-allowlist.test.ts
    - tests/worker/bull-board-gate.test.ts
  modified:
    - src/worker/health.ts
    - src/worker/index.ts
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "Per-path source gating on a NON-loopback bind (operator sets host at flip per runbook §4c): healthz/readyz/metrics answer loopback-source sockets only, /admin/queues answers allowlisted sources; the loopback-bind default is behavior-identical to the pre-07-05 server (T-07-19/Pitfall 8)"
  - "The D-16 audit stream is ONE injectable pino child on the Bull Board handler — refuseAndAudit unifies Gate 1 refusals so every line carries marker/userId/route/ip/timestamp/allowed/reason from a single seam"
  - "A5 proven live: getRequestListener bridges the hono Bull Board mount onto :9090 with serveStatic assets 200 (serve() is itself built on the listener); static assets sit behind BOTH gates"
  - "Gate 1 stays in health.ts (it owns the socket and both named options fields shipped as planned); Gate 2 + allowed-audit + delegation live in bull-board.ts"

patterns-established:
  - "Gated worker surface: gate chain BEFORE delegation, before the 405/404 gates — mutation-capable mounts must precede the GET/HEAD-only gate (D-19)"
  - "Fail-closed env surfaces: empty/missing ADMIN_IP_ALLOWLIST refuses EVERYTHING; unparsable entries throw at boot (never silently narrower)"

requirements-completed: [OBS-04, SEC-04]

coverage:
  - id: D1
    description: "Bull Board serves at /admin/queues on :9090 behind the ordered gate chain (allowlisted+admin → 200 HTML; allowlisted+non-admin → 403; non-allowlisted → 403; empty allowlist → 403 for everything; spoofed forwarded-for never grants access) with a D-16 audit line per hit and POST mutations reaching the mount"
    requirement: OBS-04
    verification:
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#1. allowlisted IPv4 source + valid admin session cookie -> 200 HTML (D-17 then D-13 pass)"
        status: pass
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#2. allowlisted source + NON-admin session -> 403"
        status: pass
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#3. non-allowlisted source + admin cookie -> refusal"
        status: pass
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#4. EMPTY allowlist refuses EVERYTHING"
        status: pass
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#5. a spoofed forwarded-for header STILL refuses (T-07-18)"
        status: pass
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#6. the D-16 structured line fires on allowed AND refused hits"
        status: pass
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#9. mutation verbs reach the mount (D-19)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fail-closed, CIDR-aware ADMIN_IP_ALLOWLIST util (parseIpAllowlist throws on garbage, empty refuses everything; isIpAllowlisted handles exact/CIDR/mapped-IPv6/IPv6)"
    requirement: SEC-04
    verification:
      - kind: unit
        ref: "tests/lib/ip-allowlist.test.ts (12/12 cases: exact, CIDR in/out, mapped normalization, empty fail-closed, garbage throws, IPv6, loopback classification)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Per-path source gating on a non-loopback bind: healthz 200 from loopback and 403 from a non-loopback source while /admin/queues answers the same non-loopback allowlisted source (T-07-19)"
    requirement: OBS-04
    verification:
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#7. per-path source gating on the non-loopback bind"
        status: pass
    human_judgment: false
  - id: D4
    description: "The A5 bridge serves the Bull Board UI through getRequestListener on the existing node:http server (entry HTML 200 + static asset 200 behind the gates)"
    requirement: OBS-04
    verification:
      - kind: integration
        ref: "tests/worker/bull-board-gate.test.ts#8. the static UI asset path serves through the getRequestListener bridge (A5 proof)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The hono-path Bull Board dependency set pinned exactly as researched; the web bundle gains zero BullMQ/Bull Board code (pnpm worker:boundary green)"
    requirement: SEC-04
    verification:
      - kind: other
        ref: "pnpm ls @bull-board/api @bull-board/hono hono @hono/node-server ipaddr.js (5/5 pins: 9.10.1/9.10.1/4.13.8/2.1.1/2.5.0) + pnpm worker:boundary green (19 files, no next/react/@app imports)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Bull Board console error state — gate failures render the refusal page, never a broken frame (must_haves backstop truth, UI Considerations 'error/Bull Board' row)"
    requirement: OBS-04
    verification: []
    human_judgment: true
    rationale: "Plan marks this verification=backstop: asserted by the D-31 soak checklist matrix (07-07) and rehearsed first on the stand-in (07-06); browser-side console behavior is not machine-assertable at this plan's level"

# Metrics
duration: 44 min
completed: 2026-09-22
status: complete
---

# Phase 7 Plan 05: Admin Queue UI (Bull Board on :9090) Summary

**Bull Board mounted at /admin/queues on the worker's existing :9090 health server behind a socket-source IP allowlist and a Better Auth admin session gate, with a D-16 audit line per hit, mutation powers kept, and zero Bull Board code in the web bundle.**

## Performance

- **Duration:** 44 min
- **Started:** 2026-09-22T21:47:04Z
- **Completed:** 2026-09-22T22:31:27Z
- **Tasks:** 3
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- Bull Board (the hono-path mount, Pattern 6 shape) lives on the worker's EXISTING :9090 node:http server — no second port, no Express; the web bundle gains zero BullMQ/Bull Board code (worker:boundary green)
- Two independent gates enforced in order: the ADMIN_IP_ALLOWLIST socket-source gate (never a forwarded-for header) then `auth.api.getSession` on the SAME createAuth() instance requiring `role === "admin"`; refusals are answered by our server code (403 JSON + D-16 line), never by Bull Board
- Every hit — allowed or refused — emits the D-16 structured line (userId/route/ip/timestamp/allowed/reason) through one injectable pino child; mutation powers (retry/remove/drain) stay enabled and provably reach the mount
- Per-path source gating (the Pitfall-8 resolution): on a non-loopback bind healthz/readyz/metrics answer loopback sources only while /admin/queues answers its allowlisted sources — proven on a real dual-stack bind with a probe-picked non-loopback source
- A5 assumption PROVEN live: the getRequestListener bridge serves the UI entry HTML and its static assets (200) — the documented fallback (serve()) was not needed

## Task Commits

Each task was committed atomically:

1. **Task 1: Install Bull Board + hono bridge set** - `da084fa` (chore) — @bull-board/api@9.10.1, @bull-board/hono@9.10.1, hono@4.13.8, @hono/node-server@2.1.1, ipaddr.js@2.5.0; @bull-board/ui@9.10.1 transitively
2. **Task 2: IP allowlist util (fail-closed, CIDR-aware)** - `a3acedc` (feat) — parser/matcher + 12 unit cases
3. **Task 3: Gated Bull Board mount on :9090 + gate-matrix suite** - `a8841c7` (feat) — bull-board.ts, health.ts delegation + per-path gating, boot wiring, 9 real-stack cases

**Plan metadata:** committed with STATE/ROADMAP/REQUIREMENTS (docs commit, hash in the completion report)

## Files Created/Modified

- `src/worker/bull-board.ts` (NEW) — the gated mount: Pattern-6 wiring over the worker's six queue lanes, Gate 2 (admin session) + D-16 audit + getRequestListener bridge; `refuseAndAudit` unifies Gate 1 refusal emission through the same injectable child logger
- `src/lib/ip-allowlist.ts` (NEW) — parseIpAllowlist (comma-split, ipaddr.js exact/CIDR, throws on garbage, empty→fail-closed), isIpAllowlisted (mapped-IPv6 normalization, kind-matched containment), isLoopbackRemote (T-07-19 helper)
- `tests/lib/ip-allowlist.test.ts` (NEW) — 12 pure-unit cases pinning the fail-closed/fail-loud semantics
- `tests/worker/bull-board-gate.test.ts` (NEW) — the gate-matrix suite on the health.test.ts real-stack harness (ephemeral dual-stack bind, real Better Auth sessions minted through the catch-all, owned-client teardown)
- `src/worker/health.ts` (MOD) — `/admin/queues` delegation branch before the 405/404 gates; Gate 1 allowlist check with the two new injectable options fields (bullBoardHandler, allowlist — env-parsed default); T-07-19 loopback-source gating for the health surface on a non-loopback bind
- `src/worker/index.ts` (MOD) — boot injects the handler built from the real queue set + the shared auth singleton (the D-18/D-17 wiring point)
- `package.json` / `pnpm-lock.yaml` (MOD) — the five researched pins

## Decisions Made

- **Gate split exactly as planned, with one audit seam:** Gate 1 (allowlist) stays in health.ts — it owns the socket and the delegation branch, and both named options fields shipped; the whole D-16 emission flows through the handler's single injectable pino child (`refuseAndAudit`), so every refusal line has an identical shape from one seam (discovered: pino's stdout destination bypasses write-spies depending on logger construction timing — an injected capture logger is the deterministic test seam)
- **Delegation precedes the 405 gate:** Bull Board's retry/remove/drain are POST/DELETE (D-19) — the mount branch must sit before health.ts's GET/HEAD-only gate; case 9 proves POST reaches the mount, not the 405 envelope
- **Non-loopback-bind semantics shipped inert:** the default loopback bind keeps today's behavior byte-identical (existing health suites untouched-green); the operator arms reachability at flip with the `host` option per runbook §4c

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Boot wiring added `src/worker/index.ts` to the touched set**
- **Found during:** Task 3 (wiring the mount)
- **Issue:** the plan's `files_modified` list did not name index.ts, but the injectable-options convention it mandates requires SOMEONE to inject `bullBoardHandler` — without boot wiring the mount would never exist and D-17/D-18 would be unsatisfiable
- **Fix:** index.ts passes `createBullBoardHandler(queues, { auth })` (real queue set + the shared auth singleton, A2) into `startHealthServer`
- **Files modified:** src/worker/index.ts
- **Verification:** the gate-matrix suite drives the same construction path; worker:boundary green with the new imports
- **Committed in:** a8841c7 (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — required wiring, zero behavior beyond the plan's own spec)
**Impact on plan:** No scope creep; the mount is armed exactly as the plan's artifacts section describes.

## Issues Encountered

- `pnpm test -- <file>` runs the WHOLE suite under vitest 4 (the `--` filter doesn't reach the runner) — per-file verification used `pnpm exec vitest run <file>` instead; the plan's verify semantics (exit 0, non-zero passed count) unchanged
- pino's default stdout destination is not reliably capturable by a `process.stdout.write` spy when the logger was constructed before the spy — resolved by injecting the capture logger through the handler's existing `logger` dep (test-only seam, production default unchanged)
- One full-suite run showed transient unhandled-error noise (2 errors, 409-test total) while suites shared the docker stack; a clean re-run passed 48 files / 409 tests with exit 0 — the plan's own suites were green in both runs

## User Setup Required

None - no external service configuration required. The operator-facing arm is the existing `.env.example` annotation: `ADMIN_IP_ALLOWLIST` stays EMPTY (fail-closed — the queue UI refuses everyone) until the flip release sets it together with the non-loopback `host` option (runbook §4c); rehearsed first at the D-34 stand-in (07-06).

## Next Phase Readiness

- 07-06 (D-34 rehearsal): the mount is live in the worker boot — the stand-in leg sets `ADMIN_IP_ALLOWLIST` + `host` and exercises allowlisted-admin / non-allowlisted reachability against this exact gate chain; the D-16 lines give the rehearsal its audit evidence
- 07-07 (D-31 soak): the backstop console-error truth (D6 above) rides the soak checklist matrix; the gate matrix here is its machine-proven substrate
- No blockers. OBS-04/SEC-04 marked complete (shared-ID gate checked: SEC-04's other declarer 07-03 has its SUMMARY)

---
*Phase: 07-better-auth-cutover-admin-gating-prisma-removal*
*Completed: 2026-09-22*

## Self-Check: PASSED

- Created files verified on disk: src/worker/bull-board.ts, src/lib/ip-allowlist.ts, tests/lib/ip-allowlist.test.ts, tests/worker/bull-board-gate.test.ts — all FOUND
- Commits verified in history: da084fa, a3acedc, a8841c7 — all FOUND
- Plan verification re-run at close-out: tests/lib/ip-allowlist.test.ts + tests/worker/bull-board-gate.test.ts 21/21 pass; pnpm worker:boundary green (19 files, no next/react/@app imports); pnpm typecheck green; full suite 48 files / 409 tests pass (exit 0)
