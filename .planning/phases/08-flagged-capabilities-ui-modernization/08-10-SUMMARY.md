---
phase: 08-flagged-capabilities-ui-modernization
plan: 10
subsystem: ai-route-leg
tags: [ai-sdk, streaming-route, guard-chain, rate-limit, remnant-gate, rule-15]
requires:
  - "08-06 (lib/ai getAiModel/aiEnabled seam this route consumes — never modified)"
  - "06 D-06 (429 + Retry-After shape) / 06-01 (Redis Lua limiter)"
  - "02-05 (tests/api/_harness.ts handler-test pattern)"
provides:
  - "runAiGuards() in src/lib/ai/guards.ts — the shared ordered /api/ai/* admission chain (flag-off 404 pre-body-read -> session 401 -> per-user bucket 429 + Retry-After -> input cap 413 -> JSON 400); the 08-07 assistant route reuses it with its own bucket"
  - "POST /api/ai/post-mortem — streaming incident post-mortem draft (UIMessage SSE, ownership-scoped evidence, D-14 sections, zero DB writes)"
  - "logAiRequest/logAiAbort in src/lib/ai/log.ts — the D-10 structured cost line + abort companion"
  - "AI-in-worker remnant-gate leg (check 14) — rule 15 / AI-05 machine-enforced"
  - "aiTimeoutMs() + AI_INPUT_MAX_CHARS — the A2/A4 seams (AI_TIMEOUT_MS optional, default 30 s; cap 2000 chars)"
affects:
  - "08-07 (AI UX consumes aiEnabled() propagation and mounts against this route; the assistant route reuses runAiGuards)"
  - "08-08 (Release C flips AI_ENABLED in production; D-38 dark-launch choreography)"
  - "scripts/check-cron-remnants.mjs (PHASE8 block gains leg 14)"
actuals:
  tokens: 17400
  tasks: 2
  commits: 5
tech-stack:
  added: []
  patterns:
    - "ordered guard chain as a shared helper returning a discriminated union (ok | response) — every /api/ai/* route runs the same admission sequence, flag check before ANY body read"
    - "v7 stateless streaming form: streamText({ instructions, prompt, maxRetries: 0, abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout()]), onEnd/onAbort }) + createUIMessageStreamResponse({ stream: toUIMessageStream({ stream }), consumeSseStream: consumeStream })"
    - "evidence-as-delimited-data prompt construction (<evidence>/<monitor>/<incident>/<pings> blocks) with instructions stating the untrusted-data discipline (T-08-15)"
tech-stack-note: "zero new packages — rides the 08-06 pinned AI SDK family"
key-files:
  created:
    - src/app/api/ai/post-mortem/route.ts
    - src/lib/ai/guards.ts
    - src/lib/ai/log.ts
    - tests/api/ai-routes.handler.test.ts
    - tests/api/ai-post-mortem.test.ts
    - tests/api/ai-stream.handler.test.ts
  modified:
    - scripts/check-cron-remnants.mjs
    - .planning/codebase/INTEGRATIONS.md
    - .planning/codebase/STRUCTURE.md
key-decisions:
  - "The shared runAiGuards chain (flag-off 404 before body read -> session 401 (identity before limiter, Pitfall 8) -> per-user ai_drafts_{userId} 10/h 429 + numeric Retry-After from resetSeconds -> 2000-char raw-body cap pinned at BOTH sides -> JSON parse 400) is the reusable /api/ai/* admission surface; 08-07's assistant route reuses it with its own bucket (D-08/D-21/A4)"
  - "ai@7.0.123's createUIMessageStreamResponse takes consumeSseStream (callback, wired to the SDK's exported consumeStream helper) — the plan Pattern-2 'consumeStream: true' boolean does not exist in the installed SDK (typecheck TS2561); the D-10 line rides streamText onEnd usage with V4 token shapes (totalTokens derived input+output)"
  - "Test-fixture liveness contract: an undici Request built in a test must stay strongly referenced for the streaming scenario — GC reclaims it after the handler returns and severs the init.signal->req.signal abort forwarding (observed flaky dead abort); production is immune (the framework holds the in-flight request)"
  - "Rule 15 (AI-05) is machine-enforced: remnant-gate leg 14 bans ai / @ai-sdk/* / @/lib/ai specifiers under src/worker/** (PATH-SCOPED — the web AI surface legitimately imports them; born ENFORCED beside the 08-02 siblings; RED spot-checked)"
  - "AI_TIMEOUT_MS is an OPTIONAL execution-discretion seam (non-numeric/zero/negative falls back to the 30 s default) — it exists so tests can prove the timeout composition without waiting 30 real seconds and operators can tighten the bound without a code change; it is NOT part of the D-02 env contract"
patterns-established:
  - "/api/ai/* guard-chain test grammar: read-tracking Request body for the pre-body-read 404 pin; limiter-key value assertions; cap-pinned-at-both-sides via padding to AI_INPUT_MAX_CHARS"
  - "drizzle WHERE-scoping assertions via deepSqlValues() (Param-wrapper aware, 06-06 queryChunks finding) + structural table identification by column keys (uptimePercent/resolvedAt/errorClass) — survives per-case vi.resetModules registry swaps"
  - "MockLanguageModelV4 stubs fed through the REAL streamText via the @/lib/ai seam: completing model (D-10 tokens), hanging model (abort/timeout propagation with the liveness pin)"
requirements-completed:
  - AI-02
coverage:
  - id: "08-10 Task 1 verify (tracer, tdd)"
    description: "Three AI suites green + typecheck"
    verification:
      - kind: test
        ref: "pnpm vitest run tests/api/ai-routes.handler.test.ts tests/api/ai-post-mortem.test.ts tests/api/ai-stream.handler.test.ts — 21/21 passed (final run + tracer-gate re-run; stream suite additionally 5/5 consecutive solo runs after the liveness fix)"
        status: pass
      - kind: command
        ref: "pnpm typecheck (0 errors)"
        status: pass
  - id: "08-10 Task 1 acceptance criteria"
    description: "404/401/429+Retry-After/cap-both-sides, per-user keys, ownership scoping, zero DB writes, UIMessage stream shape, abort propagation, D-10 fields; D-14 four sections in order on the stub-captured instructions; no result-level helpers; no implicit retry default"
    verification:
      - kind: test
        ref: "ai-routes: flag-off 404 pre-body (tracking body), 401, 429+Retry-After=30, no-Retry-After degraded path, ai_drafts_{userId} key + never-IP, cap at/over both sides (413 names the cap), malformed-JSON 400; ai-post-mortem: foreign-monitor 404 with exactly ONE query, WHERE values contain monitorId+userId (never USER_B), 3 selects in ownership order with bounded pings (limit 50), incident-miss 404, malformed-ids 400, D-14 order (Summary<Timeline<Impact<Possible causes + gloss tokens), delimited <evidence> data + 'untrusted data' instructions, ZERO write ops across five request paths, one [ai-request] line with feature/userId/model/promptTokens/completionTokens/totalTokens/duration and no prompt/URL content; ai-stream: UIMessage SSE frames + consumeSseStream drain wired, maxRetries 0 + AbortSignal present, req.signal abort reaches doStream + [ai-request-abort] line + zero writes, AI_TIMEOUT_MS=60 timeout path + zero writes"
        status: pass
      - kind: command
        ref: "grep of route for result-level helpers — only the stateless toUIMessageStream/createUIMessageStreamResponse form present; maxRetries: 0 explicit"
        status: pass
  - id: "08-10 Task 2 verify (AI-05 gate + flag-off posture)"
    description: "Scratch-probe RED spot-check, rg sweep, full verify with zero AI_* env"
    verification:
      - kind: command
        ref: "plan's compound probe: scratch src/worker/scratch-ai-probe.ts with `import { streamText } from \"ai\"` -> cron:remnants exit 1 with the AI-in-worker finding; scratch removed -> exit 0 green (GATE MISSED PROBE not printed)"
        status: pass
      - kind: command
        ref: "pnpm exec rg -l 'from \"ai\"|from \"@ai-sdk/|@/lib/ai' src/worker/ -> no matches (sweep clean)"
        status: pass
      - kind: command
        ref: "pnpm verify legs with zero AI_* env: lint OK, typecheck OK, vitest 467 passed / 470 (2 skipped by design; 1 FAILURE = tests/worker/health.test.ts IN-01 EADDRINUSE 127.0.0.1:9090 — the LIVE PRODUCTION WORKER holds the port, documented environmental per 06-07 + dispatch, never stopped), schema:gate OK, worker:boundary OK, denylist:diff OK, build OK (/api/ai/post-mortem registered), cron:remnants green (486 files incl. new leg), test:e2e 50/50 passed"
        status: pass
  - id: "TDD gate compliance"
    description: "RED validated before GREEN; plan-level commit greps"
    verification:
      - kind: command
        ref: "node gsd-core/bin/gsd-tools.cjs check tdd-red-evidence .planning/tmp/tdd-red-evidence-08-10-task1.json -> RED_EVIDENCE_OK (21/21 failing at the exact 05fa973 tree, target test failing on the missing route module)"
        status: pass
      - kind: command
        ref: "git log -E --grep '^test\\(08-10\\):' -> 05fa973 (>=1); '^feat\\(08-10\\):' -> f60b04f + 71d68f3 (>=1)"
        status: pass
  - id: "tracer feedback gate (Task 1)"
    description: "End-to-end verify re-run after the tracer slice (end-of-phase mode, automated-only verify -> re-run and continue)"
    verification:
      - kind: command
        ref: "all Task-1 <verify> checks re-run green post-commit (21/21 + typecheck 0)"
        status: pass
human_judgment: false
rationale: "Every acceptance criterion is command/test-verified this session; the single verify-test failure is the pre-documented IN-01 environmental condition (live production worker on :9090), machine-diagnosed and never auto-'fixed' by stopping production."
duration: "44 min resume session (2026-10-01T11:58:42Z -> 12:43:37Z); plan spans 2 sessions (prior usage-limit-terminated leg authored the RED commit + partial GREEN)"
completed: 2026-10-01
status: complete
plan_head_before: f6af476423c9c98044f644bd341413578e65970a
plan_head_after: 9f1c1667d141f5adbbdd3c7b0cd3daa3c229f76d
---

# Phase 8 Plan 10: AI Route Leg Summary

**One-liner:** The guarded streaming AI route leg: a shared `/api/ai/*` guard chain (flag-off 404 before body read → session 401 → per-user `ai_drafts` 10/h 429 + `Retry-After` → 2000-char input cap pinned at both sides), the `POST /api/ai/post-mortem` UIMessage streaming route with ownership-scoped incident evidence and the D-14 four-section report structure, the D-10 structured cost log, and the AI-in-worker remnant-gate leg — 21 handler tests, RED-validated, over the untouched 08-06 `lib/ai` layer.

## Performance

| Metric | Value |
|--------|-------|
| Duration | 44 min resume session (11:58:42Z → 12:43:37Z, 2026-10-01); plan spans 2 sessions (prior leg quota-terminated at 11:31Z after the RED commit + partial GREEN) |
| Tasks | 2 / 2 |
| Files | 9 touched (6 created, 3 modified) |
| Actual tokens (diff chars / 4 over the plan range) | ~17,400 vs 38,000 estimate (the dead session had already authored ~60% of the code surface; this session's work was salvage verification, RED re-validation, three Rule-1 fixes, the gate leg, and close-out) |
| Commits | 5 from the plan ledger (05fa973 RED · cacbf56 prior-session state-pause record · f60b04f Task 1 GREEN · 71d68f3 Task 2 gate leg · 9f1c166 codebase maps) |

## Accomplishments

- **Task 1 (tracer, TDD):** `src/app/api/ai/post-mortem/route.ts` + `src/lib/ai/guards.ts` + `src/lib/ai/log.ts` — the full guarded post-mortem path: `runAiGuards` ordered chain (D-21 flag-off 404 BEFORE the body is read — proven with a read-tracking Request body; 401 with identity BEFORE the limiter; per-USER `ai_drafts_{userId}` 10/h bucket with the 06 D-06 numeric `Retry-After` and the degraded no-header path; 2000-char cap accepted exactly-at / rejected one-over with a 413 naming the cap; malformed-JSON 400), IDOR-scoped evidence (the monitor loads only WHERE id AND userId — a foreign monitorId answers 404 with exactly ONE query, T-08-19), incident-scoped pings window (15-min lead-in, 50-row cap, D-15), D-14 instructions demanding Summary → Timeline (down detection/duration/recovery) → Impact → Possible causes verbatim in order over `<evidence>`-delimited untrusted data (T-08-15), v7 streaming (`instructions`/`prompt`, `maxRetries: 0` per D-09, `AbortSignal.any([req.signal, AbortSignal.timeout(aiTimeoutMs())])`, `consumeSseStream: consumeStream` drain per Pitfall 5), onEnd/onAbort → the ONE D-10 log line (feature/userId/model/tokens in-out/duration — never prompt bodies or URLs), ZERO DB writes on every request path (D-13), whole-handler 500 without stack traces (FND-07).
- **Task 2 (auto):** remnant-gate check 14 — any `ai` / `@ai-sdk/*` / `@/lib/ai` specifier under `src/worker/**` fails `pnpm verify` (path-scoped, phase8-marked, born ENFORCED). RED spot-check proven (scratch import trips the gate; removal restores green, 486 files scanned); rg sweep clean. Full verify run with ZERO `AI_*` env: lint, typecheck, schema:gate, worker:boundary, denylist:diff, build (`/api/ai/post-mortem` registered), cron:remnants, e2e 50/50 — the flag-off posture (criterion 1) is proven; the single test failure is the pre-documented IN-01 environmental condition (below).
- **AI-02 marked complete** (endpoint guard chain, streaming, caps, timeout, D-10 logging). **AI-01 deliberately left Pending** — its closure clause spans the 08-07 UI zero-trace leg and the 08-08 production flip (ready-ids released exactly AI-02; 02-03 false-signal precedent).

## Task Commits

| Task | Commit | Type | Subject |
|------|--------|------|---------|
| 1 (prior session) | 05fa973 | test (RED) | add failing tests for the guarded AI post-mortem route |
| 1 | f60b04f | feat (GREEN) | implement guarded AI post-mortem route (guard chain, D-14 instructions, streaming) |
| 2 | 71d68f3 | feat | add AI-in-worker leg to the remnant gate (AI-05, rule 15) |
| — | 9f1c166 | docs | register the /api/ai/post-mortem route surface in the codebase maps |

## Files Created / Modified

**Created:** `src/app/api/ai/post-mortem/route.ts`, `src/lib/ai/guards.ts`, `src/lib/ai/log.ts`, `tests/api/ai-routes.handler.test.ts`, `tests/api/ai-post-mortem.test.ts`, `tests/api/ai-stream.handler.test.ts` (the route/libs/tests were authored by the quota-terminated prior session and salvaged — see Deviations 1)

**Modified:** `scripts/check-cron-remnants.mjs` (PHASE8 leg 14 + header/usage/banner), `.planning/codebase/INTEGRATIONS.md` + `.planning/codebase/STRUCTURE.md` (route surface registered)

## Decisions Made

See frontmatter `key-decisions`. Highlights: the reusable guard-chain surface for 08-07, the v7 `consumeSseStream` correction, the test-fixture GC-liveness contract, rule 15 machine-enforcement, and the `AI_TIMEOUT_MS` optional-seam framing.

## Deviations from Plan

**1. [Process — usage-limit interruption, salvage, and RED re-validation] Prior session terminated mid-plan**
- **Found during:** resume dispatch (continuation_state)
- **Issue:** the authoring session died on a provider usage limit after committing RED (05fa973) and leaving UNCOMMITTED: 3 modified test files + 3 untracked source files (guards.ts, log.ts, route.ts). No `tdd-red-evidence` record existed for 08-10.
- **Fix:** salvaged ALL of it after verification — the implementation files were sound; the test modifications were legitimate debugging fixes (Node webstream priming-pull accounting, Param-wrapper-aware `deepSqlValues`, per-query fixture queue shape, structural drizzle-table identification); the leftover `[dbg]`/PROMPT-dump scaffolding was stripped. RED was re-validated at the EXACT 05fa973 tree (tests checked out, implementation moved aside): all 21 suites failed on the missing target modules → RED_EVIDENCE_OK → GREEN proceeded. Salvage copies + the RED record live under `.planning/tmp/`.
- **Verification:** RED record validated (RED_EVIDENCE_OK); 21/21 green after restore.
- **Commits:** 05fa973 (already in history), f60b04f

**2. [Rule 1 - Bug] `consumeStream: true` does not exist in ai@7.0.123 — v7 option is `consumeSseStream`**
- **Found during:** Task 1 GREEN (pnpm typecheck: TS2561 on the route; the dead session never reached a clean typecheck)
- **Issue:** the plan's Pattern 2 (research-derived) shows `createUIMessageStreamResponse({ stream, consumeStream: true })`; the installed SDK signature takes `consumeSseStream?: (options: { stream }) => void | PromiseLike<void>` — the boolean was silently ignored at runtime, weakening the Pitfall-5 drain guarantee.
- **Fix:** route wires `consumeSseStream: consumeStream` (the SDK's exported drain helper); the stream test pins `typeof responseCalls[0].consumeSseStream === "function"`; the acceptance-criteria wording maps to the v7 form.
- **Files modified:** src/app/api/ai/post-mortem/route.ts, tests/api/ai-stream.handler.test.ts
- **Verification:** typecheck clean; UIMessage SSE + drain assertions green.
- **Commit:** f60b04f

**3. [Rule 1 - Bug] MockLanguageModelV4 stubs used pre-V4 shapes (finishReason string, partial usage)**
- **Found during:** Task 1 GREEN (pnpm typecheck: TS2322/TS2739 in both stub-model test files)
- **Issue:** `finishReason: "stop"` and `usage: { inputTokens: { total }, outputTokens: { total }, totalTokens }` are not V4 types (finishReason is `{ unified, raw }`; usage needs `{ total, noCache, cacheRead, cacheWrite }` / `{ total, text, reasoning }`).
- **Fix:** stubs emit the V4 shapes; the SDK derives public `totalTokens` as input+output (verified: the D-10 assertions 12/34/46 stayed green unchanged).
- **Files modified:** tests/api/ai-post-mortem.test.ts, tests/api/ai-stream.handler.test.ts
- **Verification:** typecheck clean; D-10 pins green.
- **Commit:** f60b04f

**4. [Rule 1 - Bug] Flaky dead abort: GC severs the undici Request signal forwarding when the fixture drops its reference**
- **Found during:** Task 1 GREEN (the abort-propagation test hung 5 s in every full run while passing in isolation — the exact test the dead session was debugging when it died)
- **Issue:** `postWithSignal(...)` returned the Request inline into `POST(...)`; after the handler returned the Response, nothing held the Request, and a GC pass reclaimed it — severing undici's internal init.signal→req.signal forwarding, so `controller.abort()` never reached the route's composed signal (bisected via an `AbortSignal.any` spy: sources stayed un-aborted 50 ms after `abort()`).
- **Fix:** the test keeps the Request strongly referenced for the scenario (`inflightRequests` liveness registry, cleared per test) with the contract documented on `postWithSignal`; production is immune (the framework holds the in-flight request).
- **Files modified:** tests/api/ai-stream.handler.test.ts
- **Verification:** 5/5 consecutive solo suite runs green (previously failing in ~9 consecutive runs); full verify green.
- **Commit:** f60b04f

**5. [Environmental — IN-01, pre-documented] `tests/worker/health.test.ts` EADDRINUSE 127.0.0.1:9090 in the full verify's test phase**
- **Found during:** Task 2 flag-off posture proof (both verify runs; the empty-string-guard case binds 9090)
- **Issue:** the LIVE PRODUCTION WORKER (PID 14180, node.exe) holds 127.0.0.1:9090 — the dispatch explicitly forbids stopping it. The 06-07 disposition already records IN-01 as environmental "while a steady worker holds 9090" (green only in a deploy restart window).
- **Fix:** NOT fixed (out of scope + forbidden). The remaining chain legs were run individually to complete the proof: lint ✓, typecheck ✓, vitest 467/470 (2 skipped by design) with the single IN-01 failure, schema:gate ✓, worker:boundary ✓, denylist:diff ✓, build ✓, cron:remnants ✓, e2e 50/50 ✓ — all with zero AI_* env. A `tests/worker/shutdown.test.ts` timeout in verify run 1 passed in isolation and in run 2 (transient contention, no action).
- **Files modified:** none
- **Verification:** per-leg exits + logs under `.planning/tmp/08-10-verify*.log` / `08-10-legs.log` / `08-10-build.log` / `08-10-e2e.log`
- **Commit:** n/a

**Total deviations:** 5 (2 Rule-1 SDK-shape fixes, 1 Rule-1 flaky-fixture fix, 1 environmental pre-documented, 1 process/interruption note).
**Impact:** none on scope or contracts — all Task acceptance criteria and plan verification items are green (IN-01 documented per its standing disposition); 08-07 can consume `runAiGuards` as planned.

## Issues Encountered

- The dead session's debugging state included the abort-test hang (Deviations 1+4) — root-caused to the GC-liveness interaction, not the SDK or the route; the route's abort wiring was verified correct end-to-end (composed signal → SDK merged signal → doStream listener → onAbort).
- vitest 4 removed the `basic` reporter (used once for the RED capture; `tap-flat` used instead, matching the 08-01 RED record precedent).

## User Setup Required

None (`user_setup: []`). Flip-time operator action stays with 08-08 (D-38): set the `AI_*` triple in the production env when enabling AI.

## Next Phase Readiness

- **08-07 (AI UX):** consumes `aiEnabled()` for the server-render flag prop (only the boolean crosses); the assistant route reuses `runAiGuards(req, { bucket: "assist", limit: 20, windowMs: 3_600_000 })`; the post-mortem card mounts against `POST /api/ai/post-mortem` (UIMessage SSE, Stop honest via abort forwarding + drain).
- **08-08 (Release C):** AI ships dark per D-38; the flag-off posture is proven at the route layer here (404 pre-body-read + zero-key verify), the UI zero-trace leg (AI-01's remaining clause) lands in 08-07.
- **Rule 15:** now machine-enforced twice (worker:boundary + remnant-gate leg 14); zero AI imports under `src/worker/**`.

## Self-Check: PASSED

- Files exist: src/app/api/ai/post-mortem/route.ts, src/lib/ai/guards.ts, src/lib/ai/log.ts, tests/api/ai-{routes.handler,post-mortem,stream.handler}.test.ts, extended scripts/check-cron-remnants.mjs — verified on disk.
- Commits exist: 05fa973, f60b04f, 71d68f3, 9f1c166 (plus cacbf56 from the prior session) — all in `git log` within the plan range f6af476..9f1c166 (5 commits measured).
- Plan verification re-run: 21/21 AI handler tests (multiple runs incl. tracer gate), typecheck 0 errors, scratch-probe gate RED→green, rg sweep clean, full verify legs green (single IN-01 environmental exception documented), e2e 50/50, TDD greps ≥1 test + ≥2 feat, RED_EVIDENCE_OK on record.
