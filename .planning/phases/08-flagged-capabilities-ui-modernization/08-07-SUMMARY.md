---
phase: 08-flagged-capabilities-ui-modernization
plan: 07
subsystem: ai-ux-leg
tags: [ai-sdk, streaming-ui, post-mortem-card, assistant-prefill, flag-propagation, stub-provider-e2e, use-completion, use-object]
requires:
  - "08-10 (runAiGuards chain + POST /api/ai/post-mortem — consumed, never modified; the assistant route reuses the chain with its own bucket)"
  - "08-06 (lib/ai aiEnabled()/getAiModel() seam — the flag-propagation source)"
  - "08-04 (the redesigned tier-1 surfaces this UX mounts on: incident blocks + Add Monitor dialog)"
  - "08-02 (stable field ids new-monitor-name/url/interval in the shadcn Add Monitor dialog)"
provides:
  - "PostMortemCard (src/components/Dashboard/PostMortemCard.tsx) — the inline streaming post-mortem card under every incident row (D-12/D-14/D-16/D-13)"
  - "POST /api/ai/monitor-assistant — the guarded Output.object suggestion route (assistant bucket ai_assistant_{userId} 20/h, useObject text-stream wire contract)"
  - "src/lib/ai/assistant-schema.ts — the client-safe create-form-mirroring zod schema shared by the route and the dialog"
  - "Server-rendered flag seam: aiEnabled() → force-dynamic dashboard + monitor-detail pages → boolean prop into both client trees (D-21/P-attern 6)"
  - "The AI e2e rig: playwright.ai.config.ts (stub server :4599 + app :3110 with the AI_* env triple) + scripts/ai-stub-server.mjs — the stub-provider legs run ONLY there; the default project runs the flag-off legs"
affects:
  - "08-08 (Release C flips AI_ENABLED in production; with force-dynamic pages the flip is a restart, never a rebuild)"
  - "AI-01's UI zero-trace clause (satisfied by the flag-off e2e legs; the production-flip proof stays 08-08)"
  - "phase-close UAT (streaming visual polish — caret accent, cyan border — rides manual review)"
actuals:
  tokens: 29800
  tasks: 3
  commits: 5
tech-stack:
  added:
    - "react-markdown@10.1.0 (exact pin; legitimacy protocol passed — remarkjs/react-markdown, 42.3M weekly downloads, no postinstall; rehype-raw deliberately never installed)"
  patterns:
    - "useCompletion's default streamProtocol 'data' parses UIMessage SSE chunks (callCompletionApi -> parseJsonEventStream with uiMessageChunkSchema) — the 08-10 route's createUIMessageStreamResponse is consumed verbatim by the hook; zero custom chunk parsing (D-07)"
    - "Retry-After surfacing for SDK hooks: the hooks' error objects carry status/body but never headers, so a fetch-wrapper header read at the response boundary captures Retry-After and the D-08 toast renders the exact seconds"
    - "force-dynamic server pages for the flag seam: aiEnabled() evaluates per REQUEST so the D-38 env flip is a restart, never a rebuild (a statically-rendered page would bake the flag at build time)"
    - "guarded partial fill: only schema-valid streamed values drive their setState (per-field zod probe), dirty flags set on user input / cleared per prefill / never reset at re-run start — pre-Regenerate edits survive (D-16/D-19)"
tech-stack-note: "one new dependency (react-markdown); rides the 08-06 pinned AI SDK family for everything else"
key-files:
  created:
    - src/components/Dashboard/PostMortemCard.tsx
    - src/app/api/ai/monitor-assistant/route.ts
    - src/lib/ai/assistant-schema.ts
    - tests/api/ai-assistant.test.ts
    - tests/e2e/ai-surfaces.spec.ts
    - scripts/ai-stub-server.mjs
    - playwright.ai.config.ts
  modified:
    - src/components/Dashboard/MonitorDetails.tsx
    - src/app/(dashboardLayout)/dashboard/monitor/[id]/page.tsx
    - src/app/(dashboardLayout)/dashboard/page.tsx
    - package.json
    - pnpm-lock.yaml
key-decisions:
  - "The e2e runner split with INVERTED describe-level skip gates keyed on the AI_E2E_STUB marker: flag-ON stub legs run only under playwright.ai.config.ts (stub OpenAI-compatible server :4599 + built app :3110 carrying the AI_* env triple — server process only, T-08-18); flag-OFF zero-trace legs run only in the default project. The default verify run never needs the stub (Task 3's degrade-safely posture, proven: full e2e run exits 0 with the 5 stub legs skipped)"
  - "The stub discriminates responses by the SYSTEM message (post-mortem instructions vs assistant) and streams the D-14 markdown / the assistant JSON in slow chunks; a description containing the marker 'unreliable' selects the schema-invalid variant (interval 7) so the D-19 hint path is pinned end-to-end at the network layer (research A3/OQ4 — stub the provider, never the route)"
  - "PostMortemCard surfaces 429 Retry-After seconds via a fetch-wrapper header read (useCompletion's APICallError carries statusCode but not headers); the assistant toasts in the same wrapper (its hook throws a plain Error from the JSON body with no status at all)"
  - "ASSISTANT_SCHEMA lives in its own client-safe module (no route/db imports) because BOTH sides import it — importing the route module from a client component would pull server code into the browser bundle; the route re-exports it as its public output contract"
  - "force-dynamic on BOTH server pages: the flag boolean is a per-REQUEST server read (Pattern 6), which is what makes D-38's flip choreography a restart-only operation and keeps the flag-off default at zero AI trace"
  - "Completion-state controls keep ONE Regenerate affordance (the relabeled trigger) — a second Regenerate button would duplicate the accessible name and break Playwright strict mode"
patterns-established:
  - "AI e2e grammar: two-config runner split with an env marker + inverted skips; network-layer provider stub discriminating by system-message; data-truth assertions (created monitor appears in the list) behind the UI action"
  - "Guarded-partial-fill hook wiring for useObject over a useState form: object-mirror ref for onFinish hint computation, per-field validity probe (schema.shape[field].safeParse), dirty refs cleared per prefill"
requirements-completed:
  - AI-03
  - AI-04
  - AI-05
coverage:
  - id: "08-07 Task 1 verify (tracer)"
    description: "e2e both flag legs green + react-markdown installed + typecheck"
    verification:
      - kind: test
        ref: "pnpm exec playwright test --config=playwright.ai.config.ts — 2 passed / 2 skipped (flag-ON stub legs); pnpm exec playwright test tests/e2e/ai-surfaces.spec.ts — 2 passed / 2 skipped (flag-OFF legs); both exit 0 (re-run at the tracer gate after the Stop-race fix)"
        status: pass
      - kind: command
        ref: "pnpm ls react-markdown (10.1.0, not missing) + pnpm typecheck (0 errors)"
        status: pass
  - id: "08-07 Task 1 acceptance criteria"
    description: "Contract copy verbatim, flag-gated mount, no save affordance, AI_ENABLED in no client component, e2e covers both flag states (four D-14 headings rendered; flag-off zero trace)"
    verification:
      - kind: test
        ref: "flag-ON legs assert: Generate post-mortem trigger under the incident block, streaming card with 'Post-mortem draft — not saved' header, all four D-14 headings AS HEADINGS (Summary/Timeline/Impact/Possible causes), Stop mid-stream, Copy + Regenerate on completion, 'Post-mortem copied to clipboard' toast, zero save buttons; flag-OFF legs assert zero 'post-mortem'/'Describe it in plain words' strings, zero assistant/post-mortem surfaces, zero /api/ai requests"
        status: pass
      - kind: command
        ref: "grep sweeps: no AI_ENABLED token in src/components; no save affordance in PostMortemCard; react-markdown imported WITHOUT rehype-raw (T-08-23)"
        status: pass
  - id: "tracer feedback gate (Task 1)"
    description: "End-to-end verify re-run after the tracer slice (end-of-phase mode, automated-only -> re-run and continue)"
    verification:
      - kind: command
        ref: "all Task-1 <verify> checks re-run green post-commit: typecheck 0, pnpm ls green, AI-config e2e 2 passed / 2 skipped, default-config e2e 2 passed / 2 skipped"
        status: pass
  - id: "08-07 Task 2 verify (tdd)"
    description: "Handler suite + e2e assistant legs green"
    verification:
      - kind: test
        ref: "pnpm vitest run tests/api/ai-assistant.test.ts — 9/9 passed (guard chain, bucket key/limits, cap both sides, 400s, schema mirror pins, text-stream contract, D-10 line, zero writes)"
        status: pass
      - kind: test
        ref: "e2e flag-ON 5/5 (post-mortem x2 + assistant x3 incl. the partial-fill backstop submitting through the REAL create route and the dirty-guard Regenerate leg); flag-OFF 2/2"
        status: pass
  - id: "08-07 Task 2 acceptance criteria"
    description: "Shared guard chain reuse with own bucket; schema field set matches the create form; setState prefill (no react-hook-form); verbatim manual-entry hints; D-16 Regenerate on both features; UI-SPEC backstop end-to-end"
    verification:
      - kind: command
        ref: "rg: no setValue/react-hook-form usage in Dashboard.tsx (comment mention only); ASSISTANT_SCHEMA.shape pinned to exactly [interval, name, url] with the 1|5|10|30|60 literal union in the handler suite"
        status: pass
  - id: "08-07 Task 3 verify (gate + audit)"
    description: "Flag-prop audit, client/worker sweeps, full verify with zero AI env, stub-absent degrade posture"
    verification:
      - kind: command
        ref: "pnpm exec rg -n 'AI_API_KEY|AI_MODEL|AI_PROVIDER|AI_BASE_URL' src/components/ -> no matches; rg -l 'from \"ai\"|from \"@ai-sdk/|@/lib/ai' src/worker/ -> no matches; AI_ENABLED literal only in src/lib/ai/index.ts (the read) + server-side comments"
        status: pass
      - kind: command
        ref: "pnpm verify legs with zero AI_* env: lint 0 errors, typecheck 0, vitest 476 passed / 479 (2 skipped by design) with the single pre-documented IN-01 EADDRINUSE :9090 failure (LIVE production worker — never stopped, 06-07/08-10 disposition), schema:gate OK, worker:boundary OK, denylist:diff OK, build OK, cron:remnants OK (508 files incl. the AI-in-worker leg), test:e2e FULL suite 52 passed / 5 skipped (the 5 AI stub legs skipping cleanly without the stub env — exit 0)"
        status: pass
  - id: "TDD gate compliance"
    description: "Both tasks RED-validated before GREEN; plan-level commit greps"
    verification:
      - kind: command
        ref: "node gsd-core/bin/gsd-tools.cjs check tdd-red-evidence -> RED_EVIDENCE_OK for .planning/tmp/tdd-red-evidence-08-07-task1.json (e2e projection) and -task2.json (vitest tap-flat + executor trailer); git log -E greps: ^test\\(08-07\\): x2 (85c240e, e2f7393), ^feat\\(08-07\\): x2 (3daf040, d27e488)"
        status: pass
human_judgment: true
rationale: "Every functional behavior is machine-verified (streaming mechanics, four D-14 sections rendered, honest Stop, copy-only, partial fill + hints, dirty-guard Regenerate, flag-off zero trace, guard chain, schema mirror). NOT automated: the streaming visual polish (caret accent feel, cyan border accent while streaming, inline card aesthetics against real provider pacing) — deferred to phase-close manual UAT per the phase plan; the stub's 90ms chunk cadence approximates but cannot prove live-provider streaming aesthetics."
duration: "40 min (single session, 2026-10-01T12:49:54Z -> 13:30:53Z)"
completed: 2026-10-01
status: complete
plan_head_before: d94a34d4e0faac7792f6e097b5d5cdb78ea76eeb
plan_head_after: d27e48893e2c1e6513468b336565261ec92516ba
---

# Phase 8 Plan 07: AI UX Summary

**One-liner:** The AI UX leg end-to-end: an inline streaming post-mortem card under every incident row (useCompletion over the 08-10 UIMessage route — honest Stop, Copy-only with the "not saved" header, D-14 four-section markdown via a legitimacy-checked react-markdown, Retry-After-aware 429 toast) plus a monitor-setup assistant that streams schema-mirrored partial prefills into the Add Monitor dialog (useObject + Output.object over the shared 20/h assistant bucket, D-19 manual-entry hints, D-16 Regenerate with a dirty-field guard) — both dark by the server-rendered flag seam (force-dynamic pages), pinned by a two-config stub-provider/flag-off e2e rig and a 9-test handler suite.

## Performance

| Metric | Value |
|--------|-------|
| Duration | 40 min (single session, 12:49:54Z → 13:30:53Z, 2026-10-01) |
| Tasks | 3 / 3 |
| Files | 12 touched (7 created, 5 modified) |
| Actual tokens (diff chars / 4 over the plan range) | ~29,800 vs 68,000 estimate (the 08-06 SDK foundation + 08-10 route/guard leg absorbed most of the plan's mass; this plan was wiring, components, and test rigs) |
| Commits | 5 from the plan ledger (cd6c9b9 chore install · 85c240e Task-1 RED · 3daf040 Task-1 GREEN · e2f7393 Task-2 RED · d27e488 Task-2 GREEN) |

## Accomplishments

- **Task 1 (tracer):** `PostMortemCard.tsx` — the inline streaming card mounted under EVERY incident row of the redesigned monitor detail (D-12, never a modal): the contract controls verbatim ("Generate post-mortem" → "Stop" → "Copy" + "Regenerate"), the "Post-mortem draft — not saved" header (D-13 visible), copy success toast, D-09 inline error + user-initiated Retry, the 429 toast carrying Retry-After seconds, markdown streamed as it arrives through react-markdown WITHOUT rehype-raw (T-08-23), internal scroll past ~40 lines, cyan caret + border accent while streaming. The monitor-detail server page reads `aiEnabled()` per REQUEST (force-dynamic) and drills the boolean; with the flag off the card renders nothing (D-21). RED validated (both flag-ON e2e legs failing on the missing trigger), tracer gate re-ran all four checks end-to-end green.
- **Task 2 (TDD):** `POST /api/ai/monitor-assistant` — the SHARED 08-10 `runAiGuards` chain with its own bucket (`ai_assistant_{userId}` at 20/h, D-08 — zero duplicated guard code), `Output.object({ schema: ASSISTANT_SCHEMA })` mirroring the create-form field set exactly (name/url strings + the 1|5|10|30|60 literal union), and the `toTextStream`/`createTextStreamResponse` plain-text wire contract useObject parses. `Dashboard.tsx` gains the "Describe it in plain words" input (D-20 placeholder verbatim) above the three useState fields (Pitfall 9): streamed partial values drive guarded per-field setStates (only schema-valid values land — interval 7 never touches the select), schema-invalid fields earn the verbatim "{field} needs manual entry — the description didn't include a valid value." hint, fields stay editable mid-stream, the control relabels to "Regenerate" after a completed run and re-streams from the current description without ever overwriting a user-edited field (D-16 dirty-field guard). Edit flows untouched (D-18). The e2e backstop submits the prefilled form through the REAL create route (trim + URL + assertUrlAllowed re-run, T-08-24) and asserts the monitor appears in the list.
- **Task 3 (gate):** flag-prop audit (the AI_ENABLED read lives only in src/lib/ai; only booleans cross to clients; no runtime enabled-fetch), both sweeps print nothing (no AI_* names in client components; no AI specifiers under src/worker), and the full verify chain ran green with zero AI_* env — the AI e2e stub legs degrade to clean skips in the default run (5 skipped, exit 0), proving the flag-off default posture (criterion 1) and the untouched-green characterization/contract suites (criterion 5), with the single pre-documented IN-01 environmental exception below.
- **Requirements:** AI-03, AI-04, AI-05 marked complete (ready-ids released all three). AI-01's remaining clause is the 08-08 production flip; AI-02 closed at 08-10.

## Task Commits

| Task | Commit | Type | Subject |
|------|--------|------|---------|
| 1 | cd6c9b9 | chore | install react-markdown 10.1.0 (exact pin, legitimacy-checked) |
| 1 | 85c240e | test (RED) | add failing e2e specs for the AI post-mortem surface (stub + flag-off legs) |
| 1 | 3daf040 | feat (GREEN) | implement the inline post-mortem card (AI-03 UX, tracer slice) |
| 2 | e2f7393 | test (RED) | add failing monitor-assistant tests (handler suite + assistant e2e legs) |
| 2 | d27e488 | feat (GREEN) | implement the monitor-assistant route + Add Monitor prefill (AI-04) |

Task 3 is the audit/gate task — it introduces no diff (the spec's env-gating was designed in at Task 1 and is proven by the Task-3 runs); its evidence lives in the coverage block above.

## Files Created / Modified

**Created:** `src/components/Dashboard/PostMortemCard.tsx`, `src/app/api/ai/monitor-assistant/route.ts`, `src/lib/ai/assistant-schema.ts`, `tests/api/ai-assistant.test.ts`, `tests/e2e/ai-surfaces.spec.ts`, `scripts/ai-stub-server.mjs`, `playwright.ai.config.ts`

**Modified:** `src/components/Dashboard/MonitorDetails.tsx` (aiEnabled prop + per-incident card mount), `src/app/(dashboardLayout)/dashboard/monitor/[id]/page.tsx` + `src/app/(dashboardLayout)/dashboard/page.tsx` (force-dynamic flag seams), `package.json` + `pnpm-lock.yaml` (react-markdown)

## Decisions Made

See frontmatter `key-decisions`. Highlights: the two-config e2e runner split with inverted env-marker skips (the default verify never needs the stub), the system-message-discriminated network-layer stub with the "unreliable" invalid-variant marker, Retry-After surfacing via fetch-wrapper header reads (SDK hook errors carry no headers), the client-safe shared schema module, force-dynamic flag pages (D-38 flip = restart, not rebuild), and the single-Regenerate-affordance rule.

## Deviations from Plan

**1. [Rule 1 - Bug] ASSISTANT_SCHEMA was not reachable from the contract test**
- **Found during:** Task 2 GREEN (schema-mirror test: `Cannot read properties of undefined (reading 'shape')`)
- **Issue:** the route imported the schema without re-exporting it; the test imports `{ ASSISTANT_SCHEMA }` from the route module and got `undefined`.
- **Fix:** `export { ASSISTANT_SCHEMA };` in the route (the create-form-mirroring field set is the route's public output contract).
- **Files modified:** src/app/api/ai/monitor-assistant/route.ts
- **Verification:** 9/9 handler tests green.
- **Commit:** d27e488

**2. [Rule 1 - Bug] Stop e2e leg raced the first streamed delta**
- **Found during:** Task 1 GREEN (first AI-config run: Stop landed before any text arrived; an empty completion legitimately returns the card to the idle state, so the Copy control never appeared)
- **Issue:** the test pressed Stop after only the Stop button became visible (~50ms), inside the stub's 90ms first-chunk delay.
- **Fix:** the test waits for the first streamed delta (the card mounts on it) before pressing Stop — the leg now interrupts a genuinely in-flight stream; the component's empty-completion behavior is correct as designed.
- **Files modified:** tests/e2e/ai-surfaces.spec.ts
- **Verification:** AI-config run 2/2 green (and again at the tracer gate).
- **Commit:** 3daf040

**3. [Process — RED-evidence reporter projection] Playwright emits no TAP**
- The plan's RED gate validates through a TAP-parsing checker; Playwright 1.63 ships list/JSON reporters only. The Task-1 RED record carries a faithful mechanical projection of the `--reporter=json` run (per-spec ok/not-ok lines, `# SKIP` directives preserved, executor-appended node:test summary trailer, projections documented in the record `notes`) — the 08-10 tap-flat trailer precedent. The validator classified it RED_EVIDENCE_OK on the genuine per-test failures. Task 2's RED used vitest's native tap-flat directly (trailer appended, same precedent).
- **Commits:** 85c240e (record at .planning/tmp/tdd-red-evidence-08-07-task1.json), e2f7393 (-task2.json)

**4. [Environmental — IN-01, pre-documented] `tests/worker/health.test.ts` EADDRINUSE 127.0.0.1:9090 in the verify chain's vitest leg**
- **Found during:** Task 3 full verify (the empty-string-guard case binds 9090)
- **Issue:** the LIVE PRODUCTION WORKER holds 127.0.0.1:9090 — the dispatch explicitly forbids stopping it; 06-07 documents IN-01 as environmental while a steady worker holds the port.
- **Fix:** NOT fixed (out of scope + forbidden). Every remaining chain leg was run individually to complete the proof: lint ✓ (0 errors), typecheck ✓, vitest 476/479 (2 skipped by design; the single IN-01 failure), schema:gate ✓, worker:boundary ✓, denylist:diff ✓, build ✓, cron:remnants ✓ (508 files, AI-in-worker leg green), full test:e2e ✓ (52 passed / 5 skipped, exit 0) — all with zero AI_* env.
- **Files modified:** none
- **Verification:** logs under .planning/tmp/08-07-verify.log, 08-07-e2e-full.log
- **Commit:** n/a

**Total deviations:** 4 (2 Rule-1 fixes, 1 process/reporter note, 1 environmental pre-documented).
**Impact:** none on scope or contracts — every acceptance criterion and plan verification item is green; the AI-04 partial-fill backstop runs against the real create route end-to-end.

## Issues Encountered

None beyond the deviations above.

## User Setup Required

None (`user_setup: []`). Flip-time operator action stays with 08-08 (D-38): set the AI_* triple in the production env when enabling AI — with the force-dynamic flag pages, the flip takes effect on process restart, no rebuild.

## Next Phase Readiness

- **08-08 (Release C, the last incomplete plan):** everything it flips is now dark-shipped — routes (08-10) + UX (this plan) + flag seams proven in both postures; the e2e rig (`pnpm exec playwright test --config=playwright.ai.config.ts`) doubles as the live-smoke harness shape once AI_BASE_URL points at the real provider.
- **AI-01:** its UI zero-trace clause is now machine-pinned (flag-off e2e legs); the production-flip proof remains 08-08's.
- **Rule 15:** still machine-enforced twice (worker:boundary + remnant-gate leg 14, both re-run green this plan).
- **Phase-close UAT inputs:** the streaming visual polish (caret/border accents, real-provider pacing) is the flagged human_judgment item for the phase UAT gate.

## Self-Check: PASSED

- Files exist: all 7 created + 5 modified paths verified on disk (FOUND on every check).
- Commits exist: cd6c9b9, 85c240e, 3daf040, e2f7393, d27e488 — all in `git log` within the plan ledger range d94a34d..d27e488 (5 commits measured via rev-list).
- Plan verification re-run this session: handler suite 9/9; e2e AI-config 5 passed / 2 skipped and default-config 2 passed / 5 skipped (both exit 0, multiple runs); typecheck 0 errors; lint 0 errors; both rg sweeps empty; verify chain legs green with the single documented IN-01 exception; TDD greps ≥1 `test(08-07)` + ≥1 `feat(08-07)`; both RED records RED_EVIDENCE_OK.
