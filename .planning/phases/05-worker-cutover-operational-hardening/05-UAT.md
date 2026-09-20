---
status: testing
phase: 05-worker-cutover-operational-hardening
source: [05-VERIFICATION.md (human_verification items 1–4)]
started: 2026-09-19T21:35:00Z
updated: 2026-09-19T21:35:00Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

Test 2 — confirm the three REAL healthchecks.io checks (worker-heartbeat, worker-outbox-age, worker-redis-memory) have paging/notification integrations enabled in the hc.io dashboard.

## Tests

### 1. Live outbox -1 sentinel — RESOLVED by orchestrator host recovery; human confirms the hc.io flip record
expected: The deletion-release worker's outbox collector failure sentinel (`unsent: -1`) seen during 2026-09-19T~21:05–21:15Z verification probing was diagnosed, the underlying fault fixed, and the worker back to real outbox metrics. Per D-23, the sustained -1 withheld the worker-outbox-age ping, so hc.io should have flipped that check down and back up — that firing is OBS-03 working as designed (operators see trouble before users).
result: pass (pending human ack)
source: orchestrator resolution — live host recovery
coverage_id: 05-VERIF/H1
evidence: Root cause: the host's 4th Docker Desktop death of the window week (engine pipe absent, docker CLI dead) starved the Postgres container mid-scrape — the pool-level `SELECT 1` survived while the outbox query's connection failed, producing the -1 sentinel. Orchestrator recovery: killed zombie Docker processes, relaunched Docker Desktop, `docker start spidernode-dev-db`; worker PID 9252 never died and self-healed — `readyz` 200, `/metrics.json` green (`spidernode_outbox_unsent 0`, queues normal, redis 1.3%), web `/login` 200. Human leg: on the hc.io dashboard confirm worker-outbox-age shows a down→up transition around 21:05–21:25Z (the page that fired was real and resolved) and the trio is green now. Any recent Telegram alert from this window was this dead-man firing — resolved, no action.

### 2. Confirm paging integrations are ON for the three real hc.io checks (D-25 trio)
expected: All three checks (worker-heartbeat grace 10 min, worker-outbox-age grace 5 min, worker-redis-memory grace 30 min) show notification channels/integrations enabled in the hc.io dashboard, so a dead tick actually pages a human. The flips themselves are proven (heartbeat's first real firing 2026-09-16T22:25:28Z; outbox-age firings 20:40:28Z and 22:20:28Z) — only page delivery is unproven, because the read-only API key does not expose integration config.
how: hc.io dashboard → the one remaining project → each of the three worker checks → Integrations/channels tab → confirm at least one channel (e.g. email/Telegram) is connected and enabled.
result: pending
source: manual
coverage_id: 05-VERIF/H2

### 3. Runbook §7 disposition — RESOLVED by amendment commit dd5db7b
expected: The junction-shim rehearsal finding (fresh-install restore of the pre-cutover tarball needs 2 node_modules junctions: `mklink /J node_modules\node-cron-5efbb29b9a4eb14a node_modules\node-cron` + `mklink /J node_modules\pg-4c0d8067d674414d node_modules\pg`) lives in docs/DEPLOY-RUNBOOK.md §7 where 05-09-SUMMARY claims it, not only in the deploy record + deferred-items.
result: pass
source: commit dd5db7b (verifier's option (a) — matches the SUMMARY/PROJECT claim)
coverage_id: 05-VERIF/H3
evidence: §7 now carries the "Tier-2 restore-from-scratch amendment (05-09 rehearsal finding)" bullet: the two mklink commands, why fresh installs fail (pnpm-hash-mangled Turbopack externals bare-imported by the pre-cutover `.next` server-root chunk), structural immunity of the current deletion-release build, and the real-VPS-rollback distinction (reused node_modules needs no junctions).

### 4. mvp-mode goal-format bookkeeping decision
expected: A recorded decision: either reformat the Phase 5 goal into User Story format (`/gsd mvp-phase 5`) or drop the `Mode: mvp` tag from Phase 5 in ROADMAP.md. The goal is backend-infrastructure phrased and fails user-story validation; Phase 3 dropped its tag and Phase 4 recorded the identical finding (04-VERIFICATION human item 2) — dropping the tag is the established precedent. Informational: affects future MVP-mode UAT framing only, no codebase truth.
result: pending
source: manual decision
coverage_id: 05-VERIF/H4

## Summary

total: 4
passed: 2
issues: 0
pending: 2
skipped: 0

## Notes

- All programmatic gates are green: 13/13 truths verified (05-VERIFICATION.md), zero migrations authored (D-44), code review 0 Critical / 3 Warnings (recorded Phase-6 inputs WR-01/02/03) / 9 Info, main suite 297/297, resilience suite 7/7 against post-deletion code.
- Items 1 and 3 were resolved during verification routing (host recovery; runbook amendment commit dd5db7b) and need only the cheap human confirms noted above; items 2 and 4 are genuinely operator-only (dashboard state; mode-tag preference).
- After all 4 pass (or are explicitly dispositioned), re-run the verification step to flip `human_needed` → `passed` and close Phase 5.
