---
phase: 02
slug: foundations-theme-infrastructure
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-09-12
---

# Phase 02 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| npm registry → lockfile | pnpm import + install fetch packages; drift changes runtime behavior invisibly | package tarballs / resolved versions |
| repo → operator environment | `.env.example` is the documented contract for secret handling | variable names + purposes (no values) |
| tests → production database | live production Postgres; a misdirected DATABASE_URL would TRUNCATE production data | DDL/DML against prod schema |
| booted test server → internet | instrumentation.ts registers node-cron + healthchecks.io heartbeat on boot unless suppressed | monitor probes, Telegram alerts, heartbeat pings |
| tests → external services | fetch and Telegram must be stubbed/mocked — real egress would send real alerts | outbound HTTP / Bot API calls |
| runbook → operator actions | wrong or ambiguous steps become production incidents at next deploy | shell commands run by operator on VPS |
| docs → repository | new prose must not leak real infrastructure details | hostnames / IPs / secrets |
| type fixes → runtime behavior | assertions can hide real bugs; a "fix" that changes behavior breaks the compatibility core value | src/lib control flow |
| client theme state → DOM | class writes happen pre-paint and on toggle; wrong wiring = FOUC or hydration mismatch | theme class + CSS vars |
| palette split → every styled surface | elements outside `.dark` descendant scope get light values | computed color values |
| temporary mutations → repository | a mutation accidentally committed or left in place IS a behavior change to a live system's code | mutated src files |

---

## Threat Register

*ID reuse note: 02-05 reuses T-02-10, and 02-08/02-10 reuse T-02-16/T-02-17/T-02-18/T-02-19 from earlier plans for different components; rows are disambiguated by plan suffix.*

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-02-01 | Tampering | pnpm migration (lockfile conversion + node_modules rebuild) | high | mitigate | `pnpm import` preserved resolved versions (D-07); frozen-lockfile install + build green gates; verified: `pnpm-lock.yaml` tracked (304,523 B), `package-lock.json`/`ngrok.log` untracked | closed |
| T-02-02 | Information Disclosure | .env.example | medium | mitigate | names + purpose comments only; UAT Test 1 (2026-09-12): human-pasted file cross-checked — 24 keys set-equal with codebase `process.env.*` reads, all values empty, zero token-shaped strings | closed |
| T-02-03 | Information Disclosure | ngrok.log historical tunnel URLs | low | mitigate | `git rm`'d — `git ls-files` shows no ngrok.log; history rewrite documented out of scope in 02-01-SUMMARY | closed |
| T-02-04 | Information Disclosure | monitors GET 500 payload | medium | mitigate | echoing field deleted; src/app/api/monitors/route.ts:22–25 catch returns fixed `{ error: "Failed to fetch monitors" }` (details to console.error server-side only); contract pinned by 02-05 | closed |
| T-02-05 | Tampering/Destruction | test suite writing to production Postgres | critical | mitigate | tests/setup/global-setup.ts localhost hard-fail, unit-proven by tests/setup/db-guard.test.ts (02-02-SUMMARY); .env.test localhost-only; docker ports offset (5453/6390) | closed |
| T-02-06 | Spoofing/Side-effect | test server node-cron making real Telegram/monitor calls | high | mitigate | playwright.config.ts:58 webServer env `CRON_MODE: "vercel"` (early-return in instrumentation.ts); smoke spec drives UI only | closed |
| T-02-07 | Supply chain | vitest/@playwright/test recency-flagged | medium | mitigate | human-legitimacy-confirmed versions pinned: `@playwright/test 1.63.0` exact; vitest 4.1.11 resolved and frozen by pnpm-lock (frozen-lockfile gate, T-02-01) | closed |
| T-02-08 | Tampering/Destruction | integration + API tests vs production Postgres | critical | mitigate | 02-02 global-setup guard inherited as hard dependency (02-03, 02-05); no DATABASE_URL mutation in test files; HTTP tests only against docker-connected booted server | closed |
| T-02-09 | Spoofing | tests sending real Telegram alerts / monitor probes | high | mitigate | per-case `vi.mock("@/lib/telegram")` + `vi.stubGlobal fetch`; default REJECTING fetch stub installed in beforeEach as egress tripwire (02-03-SUMMARY); cron/check + manual-check routes excluded from HTTP scope (02-05) | closed |
| T-02-10 (02-03) | Tampering | "helpful" refactors of monitored code during test authoring | high | mitigate | D-15 prohibition enforced: git diff under src/lib/ empty across the suite's authoring (02-03 gates); suite drives the monolith as-is | closed |
| T-02-10 (02-05) | Elevation | telegram webhook unauthenticated (S-2) + cron query-string secret (S-4) — pinned as-is | medium | accept | D-17 deliberate pin with in-test comments; remediation scheduled Phase 6 (SEC-03/SEC-06); tests make the future fix a visible red→green | closed |
| T-02-11 | Tampering | type fixes silently changing runtime behavior | high | mitigate | D-11 minimal-churn; 102/102 characterization green after every monitored-logic edit; pinned defect bodies byte-preserved (02-06-SUMMARY dispositions) | closed |
| T-02-12 | Tampering | stale next.config duplicates make the flip a no-op | medium | mitigate | same-commit deletion + canary build-failure proof in both directions (02-06-SUMMARY) | closed |
| T-02-13 | Tampering | suppression directives reintroduced later | medium | mitigate | diff scan 0 for `@ts-*` and eslint-disable; no rule severities lowered (02-06-SUMMARY) | closed |
| T-02-14 | Tampering | palette split changes dark values | high | mitigate | automated .dark byte-identity diff vs pre-change snapshot (02-07-SUMMARY gate section) + default-dark e2e + UAT Test 2 human no-change confirm (2026-09-12) | closed |
| T-02-15 | Tampering | elements outside .dark scope render light unexpectedly | medium | mitigate | body IS a .dark descendant via bg-background/text-foreground — verified at src/app/layout.tsx:27; utility audit per UI-SPEC; UAT Test 4 both-mode cycling clean | closed |
| T-02-16 / T-02-16b | Supply chain / Tampering | next-themes dep · mechanical replacements changing dark computed values | low / high | mitigate | next-themes pinned ^0.4.6, legitimacy-audited, only new UI dep (package.json); replacements followed same-value mapping per occurrence with full `pnpm verify` green + UAT Test 2 human visual no-change | closed |
| T-02-17 (02-04) | Information Disclosure | runbook leaking hostnames/IPs/secrets | medium | mitigate | placeholder-only rule; gate re-run 2026-09-12: 0 private IP literals in docs/DEPLOY-RUNBOOK.md (the pre-existing §10 `10.0.0.1` example was auto-fixed in c9345c9) | closed |
| T-02-17b | Tampering | email HTML accidentally migrated (breaks email rendering) | medium | mitigate | mail.ts on exclusion list in action AND gate; verified untouched — last commit touching src/lib/mail.ts is pre-phase 4baba58 | closed |
| T-02-18 (02-04) | Tampering | wrong documented sequence → operator error during deploy | medium | mitigate | every step cites decision IDs (D-01..D-26 present in runbook); §3a sequencing contradiction caught and fixed in c9345c9 | closed |
| T-02-18 (02-10) | Tampering | the 8 reverted component files (mis-scoped revert risk) | medium | mitigate | per-file multiset diff gate vs bebd879~; untouched-globals.css scope assertion; .dark byte-identity gate; full pnpm verify chain (02-10-SUMMARY) | closed |
| T-02-19 (02-09) | Tampering | mutated code accidentally committed or left behind | high | mitigate | one-file-per-mutation with immediate `git checkout --` revert; gates assert diff/status clean per mutated path; final full verify green | closed |
| T-02-19 (02-10) | Tampering | hex-gate exclusion list widened to hide violations | low | mitigate | exclusion pinned to exactly five names; raw rg list inspected pre-gate — contains nothing else (02-10-SUMMARY:125,189) | closed |
| T-02-20 | Tampering | mutation runs hitting production DB | critical | mitigate | all mutation test runs through the 02-02 scaffold (localhost guard + docker DATABASE_URL); no manual DB connections | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-02-01 | T-02-10 (02-05) | Telegram webhook unauthenticated + cron query-string secret are pre-existing production defects (audit S-2/S-4) deliberately pinned as-is (D-17) so characterization tests lock current behavior; remediation owned by Phase 6 (SEC-03/SEC-06) where auth cutover lands | operator via D-17 decision record | 2026-09-12 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-12 | 25 | 25 | 0 | orchestrator (L1 grep-depth, ASVS 1 short-circuit — register authored at plan time, threats_open 0) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-12
