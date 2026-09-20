---
phase: 5
slug: worker-cutover-operational-hardening
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-09-20
---

# Phase 5 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| worker → Postgres | pooled DB sessions; UTC pin changes session GUC only | monitoring data, counters, outbox rows |
| worker → api.telegram.org | outbound alert send; timeout-bounded | alert payloads (monitor name/status) |
| worker tick → healthchecks.io URLs | operator-controlled env; SSRF-class trust identical to today's HC_PING_URL | dead-man ping URLs (secret-bearing) |
| env secrets → logs | ping URLs are secret-bearing; leakage class is information disclosure | none permitted (ids-only logging) |
| scraper / operator → worker :9090 | loopback-only, unauthenticated-by-design health surface (T-04-02 precedent) | numeric metrics, provenance SHA |
| npm registry → node_modules | supply chain; the one [SUS] package of the phase (@prometheus-io/client) | package code |
| repo docs → operator actions | runbook steps are executed against live systems; ambiguity is the threat | operator commands |
| .env.example → developers | names-only contract; uncommented vars imply readers that do not exist | variable names only |
| gate/scraper scripts → Postgres + hc.io API | operator-run local tools; parameterized SQL; read-only key in env | window bounds, check flips |
| rehearsal processes → throwaway DB/Redis + external services | anonymized snapshot data (still sensitive); egress neutralized by sweep gate | anonymized rows; dummy token |
| deploy / deletion restart → live monitoring | real user data; every step revertible; flush discipline is the data-integrity boundary | pings, counters, alerts |
| window co-run → live user monitoring data | the highest-stakes trust boundary of the milestone (M3) | everything monitoring touches |
| dormant emergency lever → unauthenticated trigger | CRON_SECRET-gated route survives (S-4 query-string form pinned Phase 6) | full cron pass trigger |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-05-01-01 | Tampering | telegramSend under black-hole | high | mitigate | AbortSignal.timeout(10_000) bounds the exchange inside the FOR UPDATE transaction (WR-04) — `src/worker/persist/outbox.ts:244` | closed |
| T-05-01-02 | DoS | claim/rollback churn loop against a dying database | medium | mitigate | WR-03 removes the rollback; claims stay advanced per audit §14.4 — shipped 05-01, suite-pinned | closed |
| T-05-01-03 | Tampering | mixed clock domains across writer tiers | medium | mitigate | WR-05 UTC pool option unifies Tier-1/Tier-2/maintenance horizons — `src/worker/db.ts:48` | closed |
| T-05-01-04 | Information Disclosure | outbox age query | low | accept | Parameterized single-row aggregate; no new data leaves the process (plan-time accept, see Accepted Risks) | closed |
| T-05-02-01 | Spoofing/Tampering | SSRF via ping URL | medium | mitigate | URLs from operator-controlled env only, no user input; 5 s abort (`scheduler.ts:100`); identical trust class to HC_PING_URL | closed |
| T-05-02-02 | Information Disclosure | ping URLs in logs | high | mitigate | pino ids-only rule; tests + review assert no env interpolation in log calls (05-02 Threat Surface: source-pinned twice) | closed |
| T-05-02-03 | DoS | ping storm tripping the 5/min cap | medium | mitigate | one ping per check per tick, zero retries, /fail replaces success — asserted by exact call counts on every path | closed |
| T-05-02-04 | DoS | heartbeat error failing the tick | high | mitigate | pingDeadMan swallows all errors (audit §14.2 step 5); pinned by test (rejecting-fetch case) | closed |
| T-05-SC | Tampering | npm install (@prometheus-io/client) | high | mitigate | blocking-human legitimacy checkpoint; exact pin `0.16.1` (package.json:33); official-org provenance verified; never auto-approvable | closed |
| T-05-03-01 | Information Disclosure | /metrics exposition | medium | mitigate | loopback bind (T-04-01), numeric gauges + provenance only, no-secrets test case 5, scraper deleted post-cutover (D-27) | closed |
| T-05-03-02 | DoS | slow collector stalling scrapes | low | mitigate | collect() failures degrade to missing families; health handler never-500 wrapper preserved (case 4) | closed |
| T-05-03-02b | Tampering | deprecated-name install out of habit | medium | mitigate | Prohibition + pin assertion in Task 2 verify (Pitfall 6) | closed |
| T-05-04-01 | Repudiation | runbook §9 vs REQUIREMENTS story divergence | high | mitigate | D-38 one-story amendment; §9 explicitly names Phase 6 and the emergency lever — verified in 05-VERIFICATION truth 13 | closed |
| T-05-04-02 | Information Disclosure | .env.example implying secret handling | low | mitigate | Names-only contract preserved; placeholders stay commented (D-39) | closed |
| T-05-04-03 | Tampering | M4 amendment weakening the ungated rule | medium | mitigate | Amendment states original ordering remains binding for ungated overlap (D-08; audit §20.1, commit f5b7b74) | closed |
| T-05-05-01 | Information Disclosure | HC API key / ping URL in evidence files | high | mitigate | Evidence blocks carry UUIDs, counts, verdicts — never ping URLs or keys; test 10 asserts no key substrings in the record | closed |
| T-05-05-02 | Tampering | SQL injection via gate inputs | medium | mitigate | All DB access parameterized pg; window bounds validated as integers at entry (V5; 05-05 Threat Surface) | closed |
| T-05-05-03 | Repudiation | gates evaluated across a gap | high | mitigate | Hard 4-hour minimum (14400 s D-16, test-pinned before any gate runs) + explicit start/end args; window #4b PASS proves live | closed |
| T-05-05-04 | Information Disclosure | scraper bound to a non-loopback target | low | mitigate | URL defaults to 127.0.0.1; Pitfall 5 documented in header | closed |
| T-05-06-01 | Tampering/Side-effect | rehearsal paging real users or hitting real Telegram | critical | mitigate | buildStandInEnv() empty-pins + dummy token; sweepEgressChannels(); runSweepGuard() before EVERY leg; production-port refusal guard (D-30) | closed |
| T-05-06-02 | Information Disclosure | PII LAN exposure of the stand-in | high | mitigate | 127.0.0.1-only / explicit container-IP binds everywhere (D-45); grep + assertion pinned (05-06 Threat Surface table) | closed |
| T-05-06-03 | Information Disclosure | snapshot data in evidence files | medium | mitigate | Evidence carries counts/verdicts/ids only; no payload contents beyond the parity shape check | closed |
| T-05-06-04 | DoS | rehearsal against production stack by env accident | high | mitigate | Explicit env on every command + FORBIDDEN_PORT_TOKENS sweep + assertSiblingStackIsolation() (04-DEPLOY-RECORD lineage) | closed |
| T-05-07-01 | Side-effect | rehearsal paging real users | critical | mitigate | Task 1 verification + sweep leg + dummy token (D-30) — rehearsal PASS run 5 evidence, all rows FAILED under dummy token (D-34) | closed |
| T-05-07-02 | DoS | deploy step breaking live monitoring | high | mitigate | Runbook §4 ordering with readyz gate, pre-release backup, retained tarball (DEP-03) — add-release + deletion release both executed cleanly | closed |
| T-05-07-03 | Repudiation | stale-SHA rehearsal certifying different code | high | mitigate | Same-SHA assertion leg + recorded SHA diff vs deployed SHA (D-31) — deploy record D-30 entry | closed |
| T-05-07-04 | Information Disclosure | throwaway ping URLs / API key mishandled | medium | mitigate | Secret-bearing env only; never pasted into persistent chat or evidence files (standing rule, honored across window evidence) | closed |
| T-05-08-01 | DoS | lost monitoring continuity mid-window | critical | mitigate | D-06 pre-committed abort + proven drill + gap-scanning gate 5 + D-16 clock reset — 4 window attempts, only continuous ≥4 h evaluated; 7/7 PASS on #4b | closed |
| T-05-08-02 | Tampering | lost-update counter clobber in the takeover minute | high | mitigate | Gate 4 D-02 reconciliation (the only detector for this class) PASS — m2 pings == delta, recompute discrepancies [] — + guarded/serialized writers | closed |
| T-05-08-03 | Spoofing | duplicate user-facing alerts | high | mitigate | Gate 3 parity (1 alert/incident) PASS + starvation-timed induction (Pitfall 2; 3 events, exactly 1 relay attempt each) + transient disposition | closed |
| T-05-08-04 | DoS | false page during the abort drill | medium | mitigate | Drill kept under the 10-min heartbeat grace or check paused during it (D-35) — both drill executions clean, no false page | closed |
| T-05-09-01 | Tampering | batcher data loss at the Windows hard-stop | high | mitigate | curl-flush-before-stop step (D-43/Pitfall 1) superseded in execution by the empty-window kill: flush-completion watcher taskkilled at 18:45:00.111Z, zero pings buffered at kill, zero lost by construction (deploy record) | closed |
| T-05-09-02 | DoS | false page from the orphaned old cron check | medium | mitigate | D-21 typed pause/delete step; resolved-by-absence — the check's account was deleted by the operator, cannot false-page (commit c1203aa) | closed |
| T-05-09-03 | Spoofing | emergency lever invoked by unauthorized party | medium | accept | Existing CRON_SECRET gate (Bearer form documented + 401 negative control proven); S-4 hardening is Phase 6's pinned marker — no new exposure (plan-time accept) | closed |
| T-05-09-04 | Repudiation | remnant gate green-but-cron-present | medium | mitigate | `cron:remnants` script wired into pnpm verify post-deletion; fixture tests pin both directions; case 5 asserts the real repo scans green post-05-09 (commit 85ba85c) | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-05-01 | T-05-01-04 | Outbox age query information disclosure — parameterized single-row aggregate, no new data leaves the process | Plan ratification (05-01-PLAN) | 2026-09-15 |
| AR-05-02 | T-05-09-03 | Emergency lever CRON_SECRET exposure — pre-existing gate unchanged this phase; S-4 query-string hardening is Phase 6's pinned red/green marker (SEC-06) | Plan ratification (05-09-PLAN) | 2026-09-15 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-20 | 35 | 35 | 0 | Orchestrator (L1 grep-depth short-circuit: register_authored_at_plan_time=true, asvs_level=1, threats_open=0) |

Method note: verification combined plan-time registers (9/9 PLANs with `<threat_model>` blocks), SUMMARY threat-surface confirmations (05-02/03/05/06/09), L1 code greps (AbortSignal pins, UTC pool option, exact package pins, verify-chain wiring), and live evidence from 05-DEPLOY-RECORD.md (D-30 rehearsal PASS, 7/7 window gates, empty-window kill, lever 200/401 proofs).

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-20
