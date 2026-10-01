---
status: complete
phase: 08-flagged-capabilities-ui-modernization
source: [08-VERIFICATION.md]
started: 2026-10-01T22:45:00Z
updated: 2026-10-01T23:35:00Z
---

# Phase 8 — UAT

## Current Test

[testing complete]

## Tests

### 1. AI ON-leg production smoke (the recorded stay-dark deferral)
expected: Set AI_PROVIDER=glm + AI_MODEL + AI_API_KEY + AI_ENABLED=true on the stack env, restart web, run runbook §4f flip legs — stream a post-mortem on a real incident and prefill Add Monitor from a plain-language description. Both features stream/prefill against real GLM; "Post-mortem draft — not saved" header, four sections, copy-only; rollback lever AI_ENABLED=false works first.
result: skipped
reason: "Deferred follow-up: the AI flip is the recorded stay-dark disposition (deploy record §4, runbook §4f) and requires operator-held Z.ai GLM credentials — machine-verified zero AI_* keys on this box (name-grepped stack env), so the agent cannot execute the flip. Flip remains available as a ~2-minute operator action (env triple + web restart). OFF-leg of AI-01 is machine-proven live."

### 2. Robustness walk-through (navigate-away mid-poll)
expected: Navigate away mid-poll on dashboard, monitor detail, /dashboard/status, and public status; watch the console — zero page errors / unhandled rejections on every exit; no stuck toasts.
result: pass
source: delegate-run (agent-executed against the live stack, 2026-10-01)
evidence: Playwright live walk logged in as the UAT probe account — dashboard dwelled 35s (crossing a 30s poll boundary) then navigated away mid-cycle; monitor detail (/dashboard/monitor/6), /dashboard/status, and /status/504caf24-7fee-4c3a-8161-f0d1836ae24b each dwelled 4s (mount poll in flight) then navigated away mid-poll. **0 console errors / 0 page errors across every surface and exit.** Results file: .planning/tmp/uat-screens/walk-results.json

### 3. Subjective both-theme visual pass
expected: The redesigned app looks intentional in BOTH dark (default) and light mode across dashboard, monitor detail, status pages, sidebar; light-safe brand assets render correctly; no contrast failures.
result: pass
source: delegate-run (agent-executed with screenshots; objective checks machine-verified, subjective judgment agent-attested — screenshots attached for operator review)
evidence: 7 screenshots captured on the live stack (.planning/tmp/uat-screens/): dashboard/monitor-detail/dashboard-status/public-status in dark (default) + dashboard/monitor-detail/public-status in light. Objective probes: light mode applies (html class="light"); text contrast on light dashboard **16.97:1** (WCAG AAA; body #fafafa vs text #18181b); the darkened light `--accent-cyan` variant (#0e7490, 5.13:1) renders on the AVG UPTIME metric; zero WR-02 remnants (no text-white headings, no slate-950 header). Dark renders the full Tier-1 redesign (stats summary header, denser list, cyan active nav). Operator may reopen if the screenshots disagree with their judgment.

### 4. AI streaming polish at real provider pacing
expected: With item 1's flip in place, streaming rendering (caret, inline card growth, Stop/Regenerate controls) feels right at real GLM pacing — no jank, no layout jumps.
result: skipped
reason: "Deferred follow-up: rides Test 1 — requires the same operator-held Z.ai credentials and the production flip. Streaming contract itself is machine-covered (stub-provider e2e: caret, Stop/Regenerate, four sections, partial-fill)."

## Summary

total: 4
passed: 2
issues: 0
pending: 0
skipped: 2
blocked: 0

## Deferred Follow-Ups

- test: 1
  idea: "AI ON-leg production smoke: flip AI_ENABLED=true with operator Z.ai GLM credentials (env triple + web restart per runbook §4f), stream a post-mortem on a real incident and prefill Add Monitor; then Test 4 streaming-polish judgment"
  deferred_at: 2026-10-01

## Gaps

*(none — verification scored 5/5 success criteria, 0 gaps; delegate-run found 0 issues)*

## Notes

- Delegate-run pattern per the operator's instruction ("run all the test for me") and the Phase-06 UAT precedent: the agent executed every test executable against the live stack and recorded the two credential-gated ones as deferred follow-ups per the recorded stay-dark disposition.
- Known environmental (standing disposition since Phase 3): `tests/worker/health.test.ts` IN-01 EADDRINUSE :9090 while the live production worker runs — not a regression, live worker never stopped.
