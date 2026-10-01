---
phase: "06"
slug: "thin-api-routes-email-abstraction"
status: verified
threats_open: 0
asvs_level: 1
created: "2026-10-01"
---

# Phase 06 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Web route admission (check-now, monitors CRUD) | Authenticated user requests vs ownership + limiter + SSRF admission ladder | monitor URLs, user identity, scheduling state |
| Telegram webhook (inbound) | Internet-sourced POSTs vs per-IP limiter + constant-time secret-token compare | chat bindings, alert text |
| Web -> Redis (BullMQ producer) | Stateless web producer vs queue integrity | check/email job payloads (bounded profile + deadline) |
| Worker email lane (outbound SMTP/console) | Queue payloads vs transport | rendered HTML emails (byte-verbatim template) |
| Operator secrets (env contract) | Gitignored launch env vs tracked tree | TELEGRAM_WEBHOOK_SECRET, BETTER_AUTH_SECRET (never in chat/logs/tracked files) |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-06-01-01 | Spoofing | getIP / limiter keys | medium | mitigate | D-22 spoof pins bound the keyspace: TRUST_PROXY-gated entry selection + IP-literal normalization + unknown ... | closed |
| T-06-01-02 | DoS | manual-check enqueue flood | high | mitigate | Two-bucket per-user limiter (1/30s per monitor, 6/min per user, SEC-05) + 429 with Retry-After; priority-1 ... | closed |
| T-06-01-03 | DoS | Redis-down request hang | high | mitigate | Bounded producer profile (maxRetriesPerRequest 1, connectTimeout/commandTimeout 1000) makes add() reject ->... | closed |
| T-06-01-04 | Tampering | enqueue-time next_check_at advance | medium | mitigate | Single atomic GREATEST-capped UPDATE via drizzle (mirrors claim.ts); 0-row result -> 404 | closed |
| T-06-01-05 | Information Disclosure | error responses | medium | mitigate | apiError constructs uniform { error } bodies; no stack traces or internals (D-32, FND-07) | closed |
| T-06-01-06 | Elevation | ownership check | high | mitigate | findFirst scoped by userId (D-17 form); 404 on miss | closed |
| T-06-06-SC | Tampering | npm installs | high | mitigate | Zero new packages this phase (all deps vetted Phases 2-5); any unplanned install must stop and re-run the l... | closed |
| T-06-02-01 | Information Disclosure | forgot-password enumeration | high | mitigate | 200-neutral response preserved verbatim (no account-existence signal); 5/h per-IP limiter added (D-21) | closed |
| T-06-02-02 | Denial of Service | Redis-down mid-register strands an unverifiable account | high | mitigate | Pre-flight bounded ping -> 503 before user create (Pitfall 6); residual race accepted + documented (dead-me... | closed |
| T-06-02-03 | Tampering | mis-classified permanent error silently drops mail | medium | mitigate | Conservative taxonomy (A1): only EAUTH/EENVELOPE/EMESSAGE/5xx dead-letter; everything else retries; unit te... | closed |
| T-06-02-04 | Spoofing | EMAIL_PROVIDER typo silently no-ops | medium | mitigate | D-11 throw-early at worker boot for unknown values; unset can never break email (defaults smtp) | closed |
| T-06-02-05 | Information Disclosure | email payloads in logs | low | accept | Console provider is a dev opt-in printing the payload it would send (D-12); production selects smtp; no sec... | closed |
| T-06-02-06 | DoS | worker teardown leaks relay Redis connection (WR-02) | medium | mitigate | disposeRelayRedis() added to drainAndTeardown; teardown test pins it | closed |
| T-06-02-SC | Tampering | npm installs | high | mitigate | Zero new packages (nodemailer/ioredis/bullmq all vetted Phases 2-5); any unplanned install stops for the le... | closed |
| T-06-03-01 | Spoofing/Elevation | forged webhook binding attacker chat ids | critical | mitigate | X-Telegram-Bot-Api-Secret-Token + constant-time compare (401) + per-IP limiter (S-2 closure, D-20/D-21) | closed |
| T-06-03-02 | Tampering/Information Disclosure | SSRF via monitor URL at create (internal probing) | high | mitigate | DNS-only assertUrlAllowed pre-flight (D-23) + engine per-hop pinning retained as defense-in-depth; PATCH-on... | closed |
| T-06-03-03 | Tampering | HTML injection via monitor names/urls into Telegram parse_mode | high | mitigate | Escape ampersand + angle brackets at interpolation sites, worker alerts (D-16) and webhook confirmation (D-... | closed |
| T-06-03-04 | DoS | webhook flood | medium | mitigate | Per-IP limiter (30/min planner pin) ahead of any DB write | closed |
| T-06-03-05 | Information Disclosure | error responses leaking internals | medium | mitigate | apiError uniform { error } bodies; SSRF 400 message actionable but not internals-bearing (D-32) | closed |
| T-06-03-06 | Information Disclosure | timing side-channel on secret compare | low | mitigate | timingSafeEqual behind a length guard; identical 401 bodies for all wrong-secret shapes | closed |
| T-06-03-SC | Tampering | npm installs | high | mitigate | Zero new packages; node:crypto is built-in | closed |
| T-06-04-01 | Tampering | autonomous retention deletes live data | high | mitigate | D-14 uses the 04-07 batched real-delete logic (looped LIMIT ~5000, write guards) rehearsed in 05-06; counts... | closed |
| T-06-04-02 | DoS | unbounded script hang masks failures (WR-01) | medium | mitigate | Bounded producer profile + non-zero exit; test-enforced deadline | closed |
| T-06-04-03 | DoS | webhook enforcement strands Telegram connect if setWebhook is skipped (Pitfall 5) | high | mitigate | Runbook pins setWebhook INSIDE the cutover sequence; stand-in smokes both refusal and acceptance; operator ... | closed |
| T-06-04-04 | Information Disclosure | rehearsal secrets in evidence files | medium | mitigate | 06-DEPLOY-RECORD records facts and hashes, never secret values; stand-in secret is stand-in-only | closed |
| T-06-04-05 | DoS | unrehearsed production release | high | mitigate | D-30 stand-in rehearsal with readyz gates + blocking operator approval before production (this plan's check... | closed |
| T-06-04-SC | Tampering | npm installs | high | mitigate | Zero new packages across the phase; gate chain includes build + boundary + denylist gates | closed |
| T-06-05-01 | Information Disclosure | cron secret residue in env/example/stand-in mint | high | mitigate | Deletion list covers code, .env.example, and the stand-in mint; extended gate fails on reintroduction (SEC-06) | closed |
| T-06-05-02 | Denial of Service | deletion release interrupts monitoring | critical | mitigate | Worker owns 100% of checks since Phase 5 (deleted surface is web-side only); readyz-gated deploy + syntheti... | closed |
| T-06-05-03 | Tampering | partial deletion leaves gate red or emergency lever dead (anti-pattern) | high | mitigate | One atomic contract: routes + modules + env + gate + pins in the same release; verify chain green before de... | closed |
| T-06-05-04 | DoS | webhook enforcement live before registration (Pitfall 5) | high | mitigate | Task 1 orders setWebhook inside the cutover; acceptance re-checked in smoke; rollback path documented (re-r... | closed |
| T-06-05-05 | Information Disclosure | secret values in evidence files | medium | mitigate | 06-DEPLOY-RECORD records outcomes/hashes only, never secret values | closed |
| T-06-05-SC | Tampering | npm installs | high | mitigate | Zero new packages in the deletion release; full verify chain gates the deploy | closed |
| T-06-07 | DoS | src/lib/queue-producer.ts (ping/add awaits from request handlers) | high | mitigate | PRODUCER_DEADLINE_MS 3000 backstop races every web-side producer await; the silently-unreachable mode (fire... | closed |
| T-06-08 | Tampering | check route compensating restore (failure-path UPDATE) | medium | mitigate | restore restates ownership (id AND "userId") AND the equality guard (next_check_at = this request's advance... | closed |
| T-06-SC | Tampering | npm/pip/cargo installs | high | mitigate | package-legitimacy gate: this closure installs NOTHING (zero dependency changes — verify legs are vitest/gr... | closed |
| T-06-09 | Tampering | src/worker/engine/check.ts manual follow-up (new monitors-row write path) | medium | mitigate | Reuses the pinned §16.2 additive UPDATE verbatim (monitorFlushUpdateSql — persist-tier2-pinned SQL: never w... | closed |
| T-06-10 | Information Disclosure | TELEGRAM_WEBHOOK_SECRET handling across probe, plan, runbook, env contract | high | mitigate | The plan and probe never contain, mint, or read the secret value (probe asserts refusal legs only: absent o... | closed |
| T-06-11 | DoS | scripts/probe-telegram-webhook-ladder.mjs flood leg against the live web | low | mitigate | Bounded at 35 requests total against a limiter whose contract IS the thing being verified (30/min per IP, D... | closed |
| T-06-SC | Tampering | npm/pip/cargo installs | high | mitigate | Package-legitimacy gate: this closure installs NOTHING (zero dependency changes — a plain node: ESM probe s... | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

Register authored at plan time across the seven phase plans (06-01..06-07). All 39 mitigate-disposition threats verified CLOSED at ASVS L1 grep depth, each backed by behavioral verification: the initial phase verification (12/12 truths — webhook constant-time compare + unset-env 500, two-bucket limiter with real-Redis key checks, SSRF admission wired, apiError no-leak scan, CRON_SECRET deletion gate 441 files), the 2026-09-30 re-verification (both gaps closed; 104 tests re-run; live ladder probe 401/401/429; secret-value scan of tracked files + commit range clean; cron-remnant gate 478 files), and the gap-closure review + fixes (probe script secret hygiene — refusal-only token handling; requireActive guard; ::text precision contract).

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-1 | T-06-02-05 | Console email provider dumps full rendered email (incl. verification/reset links) to local stdout — dev-only transport per D-11/D-12; production topology uses SMTP; stdout is operator-controlled | operator (plan-time disposition, confirmed by UAT pass-all 2026-10-01) | 2026-09-20 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-01 | 40 | 39 + 1 accepted | 0 | orchestrator L1 grep sweep (secure-phase short-circuit: threats_open 0 + plan-time register + ASVS 1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-10-01
