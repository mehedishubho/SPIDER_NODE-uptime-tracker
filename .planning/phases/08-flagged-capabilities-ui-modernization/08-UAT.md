---
status: testing
phase: 08-flagged-capabilities-ui-modernization
source: [08-VERIFICATION.md]
started: 2026-10-01T22:45:00Z
updated: 2026-10-01T22:45:00Z
---

# Phase 8 — UAT

## Current Test

number: 1
name: AI ON-leg production smoke (the recorded stay-dark deferral)
expected: |
  Set AI_PROVIDER=glm + AI_MODEL + AI_API_KEY + AI_ENABLED=true on the stack env, restart web, run runbook §4f flip legs — stream a post-mortem on a real incident and prefill Add Monitor from a plain-language description. Both features stream/prefill against real GLM; "Post-mortem draft — not saved" header, four sections, copy-only; rollback lever AI_ENABLED=false works first.
awaiting: user response

## Tests

### 1. AI ON-leg production smoke (the recorded stay-dark deferral)
expected: Set AI_PROVIDER=glm + AI_MODEL + AI_API_KEY + AI_ENABLED=true on the stack env, restart web, run runbook §4f flip legs — stream a post-mortem on a real incident and prefill Add Monitor from a plain-language description. Both features stream/prefill against real GLM; "Post-mortem draft — not saved" header, four sections, copy-only; rollback lever AI_ENABLED=false works first.
result: [pending]

### 2. Robustness walk-through (navigate-away mid-poll)
expected: Navigate away mid-poll on dashboard, monitor detail, /dashboard/status, and public status; watch the console — zero page errors / unhandled rejections on every exit; no stuck toasts.
result: [pending]

### 3. Subjective both-theme visual pass
expected: The redesigned app looks intentional in BOTH dark (default) and light mode across dashboard, monitor detail, status pages, sidebar; light-safe brand assets render correctly; no contrast failures.
result: [pending]

### 4. AI streaming polish at real provider pacing
expected: With item 1's flip in place, streaming rendering (caret, inline card growth, Stop/Regenerate controls) feels right at real GLM pacing — no jank, no layout jumps.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps

*(none — verification scored 5/5 success criteria, 0 gaps; these 4 are the human-judgment/credential-gated items)*

## Notes

- Item 1 requires your Z.ai GLM credentials (`AI_PROVIDER=glm`, `AI_MODEL` — confirm the current model id, `AI_API_KEY` from the Z.ai console). Keys enter only the gitignored stack env, never the repo. Rollback: `AI_ENABLED=false` + web restart.
- The OFF-leg of AI-01 is machine-proven live (both `/api/ai/*` routes 404, zero keys on box, dark soak clean — deploy record §3).
- Known environmental: `tests/worker/health.test.ts` IN-01 EADDRINUSE :9090 while the live production worker runs — standing disposition since Phase 3, not a regression.
- If you defer item 1 again, mark it skipped-with-reason and the phase can still close on the recorded disposition (Phase-999.1 precedent).
