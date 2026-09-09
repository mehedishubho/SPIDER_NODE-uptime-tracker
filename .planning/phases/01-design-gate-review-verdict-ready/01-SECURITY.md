---
phase: 01
slug: design-gate-review-verdict-ready
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-09-10
---

# Phase 01 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

**Phase nature:** documentation/design phase — zero implementation code, zero package installs. All "mitigate" dispositions resolve to authored, committed specification content in `docs/ARCHITECTURE-AUDIT.md`, `docs/ARCHITECTURE-REVIEW.md`, `docs/DEPLOY-RUNBOOK.md`, and the phase's adversarial-review artifacts. Mitigations marked *implementation Phase N* are deferred by design to later phases and are pinned in the spec now.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| design doc → future implementation | Phase 3/4 executors transcribe §11/§14/§15/§16 mechanically; ambiguity here becomes production data corruption | spec text → production SQL/config |
| user-supplied monitor URL → worker fetch (spec) | check-engine SSRF surface (S-1) specified at §15 | attacker-controllable targets |
| auth cutover → every existing user | Better Auth flip can lock out all users (A-1/A-3) | credential/session continuity |
| Redis/Postgres failure → monitoring continuity | mis-specified resilience hides outages or corrupts data (R-1) | uptime data integrity |
| runbook → production operations | operator under incident pressure executes steps verbatim (P-1) | production Postgres/PM2 state |
| authoring agents → verdict record | self-review contamination would flip the gate without adversarial value (D-15) | verdict record integrity |
| AI verdict recommendation → human ratification → verdict flip | flip is a two-key operation: adversarial evidence AND human consent (D-18) | gate decision integrity |
| public internet → worker host (spec) | OS egress layer backs up engine SSRF validation (§15.4) | egress traffic |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-01-01 | Tampering | §16 flush SQL re-applied deltas | high | mitigate | write_guards same-transaction guard + TC-FLUSH-GUARD-01 + TC-MONOTONIC-01 in audit §16 | closed |
| T-01-02 | Tampering | §16 duplicate ONGOING incidents | high | mitigate | conditional UPDATE + `incidents_one_ongoing` partial unique index (audit L373) + TC-DUP-INCIDENT-01 | closed |
| T-01-03 | Tampering | duplicate Telegram sends | medium | mitigate | incident-keyed dedup keys + TC-DUP-ALERT-01 in audit | closed |
| T-01-04 | Info Disclosure | §11 sketch treated as live-truth | low | accept | verify-against-live-pg_dump markers bound to Phase 3 baseline (DRZ-01); drift is caught, not silent | closed |
| T-01-05 | Supply chain | package installs | high | accept | zero installs (all 9 plans' Package Legitimacy Gates; no dependency-manifest commits) | closed |
| T-02-01 | Tampering/Info Disclosure | §15 SSRF pipeline | high | mitigate | resolve-then-validate every hop ≤5, scheme allowlist, 2 MB cap, 10 s timeout + TC-SSRF-* cases; §15.4 + runbook §10 egress layer | closed |
| T-02-02 | Tampering | §14 claim SQL duplicate checks | high | mitigate | FOR UPDATE SKIP LOCKED inside the CTE, doc-citation comment (J-1) | closed |
| T-02-03 | DoS | §14 lane starvation | medium | mitigate | explicit priority on every lane in D-12 table + worst-case latency bound (J-6) | closed |
| T-02-04 | DoS | §15 dead lock blocks monitor | medium | mitigate | TTL = timeout + margin, renewal TTL/3, expiry auto-release, abort-on-loss (J-3) | closed |
| T-02-05 | Supply chain | package installs | high | accept | zero installs | closed |
| T-03-01 | Spoofing | §12 auth cutover mass lockout | high | mitigate | field maps + hash-prefix routing + canary-login gate, snapshot → production → flip (A-1/A-3) | closed |
| T-03-02 | Spoofing | Telegram webhook forgery | medium | mitigate | secret_token at setWebhook + constant-time X-Telegram-Bot-Api-Secret-Token comparison (S-2; implementation Phase 6) | closed |
| T-03-03 | Info Disclosure/Tampering | admin surfaces open | medium | mitigate | admin plugin role column + admin-only feedback/queue UI + IP allowlist (S-3; implementation Phase 7) | closed |
| T-03-04 | DoS | silent blackout on Redis loss | high | mitigate | pause-by-design + dead-man's-switch + UI staleness; fallback path removed from §13 (R-1) | closed |
| T-03-05 | Tampering | breaker pauses heartbeat | medium | mitigate | §13 pins OPEN-pause scope — heartbeat never pauses (D-11) | closed |
| T-03-06 | DoS | connection exhaustion | medium | mitigate | §25 per-process max + statement_timeout + idle reaping (D-8) | closed |
| T-03-07 | Supply chain | package installs | high | accept | zero installs | closed |
| T-04-01 | DoS/Tampering | runbook ordering | high | mitigate | D-04 exact orderings, backup-before-migrate, single-runner rule, readyz gate (P-1/M-1) | closed |
| T-04-02 | Info Disclosure | secrets via query strings | medium | mitigate | S-4 note: no endpoint accepts secrets via query; CRON_SECRET dated retirement (runbook §9) | closed |
| T-04-03 | Tampering | unrecoverable rollback | high | mitigate | M-2 expand/contract + retained previous tarball as rollback (DEP-03) | closed |
| T-04-04 | Tampering | silent §9 trace gap | medium | mitigate | author-side §9 ID loop; independently reproduced all-25-IDs-found in 01-REREVIEW.md | closed |
| T-04-05 | Supply chain | package installs | high | accept | zero installs | closed |
| T-05-01 | Elevation of Privilege | re-review self-contamination | high | mitigate | D-15 independence attestation (01-REREVIEW.md L5, commit-verified) + read-only byte-identity SHA-256 | closed |
| T-05-02 | Tampering | verdict flipped on non-clean pass | high | mitigate | flip only after blocking human checkpoint ratifies CLEAN PASS; gap path leaves §1 untouched (D-18) | closed |
| T-05-03 | Repudiation | READY without reviewer/evidence | medium | mitigate | §1 carries date 2026-09-09 + reviewer identification; Re-review section points to full report (D-16) | closed |
| T-05-04 | Info Disclosure | §10 criterion ambiguity | low | mitigate | criterion-2 interpretation recorded in report + Re-review section (D-05/DRZ-01) | closed |
| T-05-05 | Supply chain | package installs | high | accept | zero installs | closed |
| T-06-01 | Tampering | §16.2 flush double-apply/over-delete | high | mitigate | RENAMENX staging exclusivity + write_guards guard + post-COMMIT staging-only DEL + TC-FLUSH-GUARD-01 | closed |
| T-06-02 | Tampering/Info Disclosure | routine ping evidence dropped | high | mitigate | bulk INSERT INTO pings inside guarded flush transaction; absent-jobs paragraph corrected | closed |
| T-06-03 | DoS/Info Disclosure | NULL-incident dedup collision | high | mitigate | monitor-scoped first_check key + non-NULL incident_id contract + UnrecoverableError dead-letter + TC-FIRST-CHECK-DEDUP-01 | closed |
| T-06-04 | Repudiation | verdict record untracked in git | medium | mitigate | review doc under VCS, hash-pinned (blob 520c9409… asserted pre-flip) | closed |
| T-06-05 | Supply chain | package installs | high | accept | zero installs | closed |
| T-07-01 | DoS | worker boot crash-loop (WR-04) | high | mitigate | runbook names process.send('ready') as PM2 gate + states crash-loop consequence | closed |
| T-07-02 | Tampering | operator runs nonexistent migrate step (WR-03) | medium | mitigate | phase-conditional Migrate step; legacy CI schema step named interim authority | closed |
| T-07-03 | DoS | first worker cutover disables monitoring (WR-05/M3/M4) | high | mitigate | runbook §4a overlap window + continuity verification before cron deletion + web-only rollback (see advisory note 2) | closed |
| T-07-04 | Supply chain | package installs | high | accept | zero installs | closed |
| T-08-01 | Info Disclosure/SSRF | mapped-IPv6/NAT64 bypass, no OS backstop (WR-01/RR-01) | high | mitigate | denylist extension + canonicalization + TC-SSRF-MAPPED-V6-01; §15.4 + runbook §10 egress layering (see advisory note 3) | closed |
| T-08-02 | Tampering | spec contradictions mislead Phase 4 (RR-02..04) | medium | mitigate | residual removal with file-wide negative greps as acceptance; §20/§24 fix-cycle markers | closed |
| T-08-03 | DoS | limiter stranded counter (OBS-04/IN-01) | medium | mitigate | atomic Lua INCR + EXPIRE NX pinned in §13.1 | closed |
| T-08-04 | Tampering | double-sampling from manual checks (WR-02) | low | mitigate | manual enqueue advances claim column via §14.3-shaped atomic UPDATE + distinct manual jobId | closed |
| T-08-05 | Supply chain | package installs | high | accept | zero installs | closed |
| T-09-01 | Tampering | verdict flipped without ratified clean pass | critical | mitigate | blocking human-verify gate before any edit; flip only on ratified clean-pass branch; pre-flip hash-equality check | closed |
| T-09-02 | Repudiation | verdict decision untraceable | high | mitigate | verbatim ratification line + date (01-REREVIEW-2.md §10); reviewer ID in §1; cycle-2-of-2 accounting | closed |
| T-09-03 | Tampering | reviewer trusts summaries (closure theater) | high | mitigate | D-15 attestation + inline re-derived grep/read evidence in every closure-audit row; docs read-only | closed |
| T-09-04 | Tampering | fix-cycle edits introduce new contradiction | medium | mitigate | cycle-2 new-edit hunt + fix-token drift sweep (01-REREVIEW-2.md) | closed |
| T-09-05 | Supply chain | package installs | high | accept | zero installs | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

### Advisory notes (non-gating, cross-referenced design debt)

1. **CR-01 (01-REVIEW.md / 01-VERIFICATION.md):** `monitors.uptime_percent` has no writer in the transcribed spec. Not an open threat against this register — no register threat promised a writer — but registered with a hard consumption point at Phase 4/5 planning (before §16 transcription).
2. **CR-02:** runbook §4a "disable nothing" vs audit M4 "old path disabled before first new-path flush". The §4a overlap-window mitigation (T-07-03) exists as specified; the cross-doc contradiction is registered design debt for Phase 4/5 overlap planning (WRK-10/WRK-11).
3. **Denylist completeness (01-REVIEW.md warning):** §15.4 egress denylist omits `::/128` and `100.64.0.0/10`. The layered mitigation exists; token set completion is Phase 4 implementation detail.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01-01 | T-01-04 | §11 sketch drift is caught (not silent) by pg_dump baseline markers at Phase 3 (DRZ-01) | plan 01-01 | 2026-09-08 |
| AR-01-02 | T-01-05, T-02-05, T-03-07, T-04-05, T-05-05, T-06-05, T-07-04, T-08-05, T-09-05 | Phase 1 installs zero packages — no supply-chain surface; corroborated by absence of dependency-manifest commits 2026-09-01→10 | all 9 plans (Package Legitimacy Gate) | 2026-09-08 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-10 | 46 | 46 | 0 | execute-phase orchestrator — L1 grep verification of every mitigation token in committed docs (ASVS L1 short-circuit: threats_open 0, register authored at plan time) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-10
