---
phase: 08
status: recorded
recorded: 2026-10-01
source: 08-REVIEW.md (0 critical / 3 warning / 7 info, standard depth, 71 files)
---

# Phase 8 — Review Dispositions Ledger

One row per finding from `08-REVIEW.md`. Default disposition is `open`; edit the Disposition
cell to record a decision (`fixed` / `skipped` / `deferred`) with the reason in Source.
A row marked *(carried — not in the current review)* was seen by an earlier review and never triaged.

| ID | Severity | Disposition | Source |
|----|----------|-------------|--------|
| WR-01 | warning | open | Uptime 0% renders "100%" on Dashboard.tsx:861-864 + MonitorDetails.tsx:307 (`? toFixed(2) : 100` idiom) |
| WR-02 | warning | open | AI input cap enforced after `req.text()` full-body buffer — bounds provider cost, not server memory (src/lib/ai/guards.ts:114-125) |
| WR-03 | warning | open | Phase-8 remnant-gate object findings re-tagged `phase7: true` — phase8 marker dropped (scripts/check-cron-remnants.mjs:568-584) |
| IN-01 | info | open | Custom AI provider missing `includeUsage` — D-10 logs 0 tokens for AI_PROVIDER=custom |
| IN-02 | info | open | TeamSwitcher dead `user` prop/display locals + commented icon block |
| IN-03 | info | open | Incidents.tsx missing the UI-04 abort discipline other polled surfaces carry |
| IN-04 | info | open | Uncaught clipboard promises in DashboardStatus/ProfileComponent |
| IN-05 | info | open | ProfileComponent still uses the hand-rolled delete modal (UI-02 one-dialog contract) |
| IN-06 | info | open | Overlapping fetchMonitors passes never abort the prior pass |
| IN-07 | info | open | Maintenance dispatcher resolves Redis before the unknown-job-name throw |

*Recorded by execute-phase code_review_gate, 2026-10-01.*
