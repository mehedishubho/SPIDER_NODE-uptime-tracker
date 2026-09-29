---
phase: "07"
slug: "better-auth-cutover-admin-gating-prisma-removal"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-09-30"
---

# Phase 07 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| package legitimacy → dependency tree | npm registry packages entering the build (pins + operator approval) | supply-chain integrity |
| Better Auth engine → existing users/tables | credential hash routing, lazy rehash, session minting | password hashes, session tokens |
| client session source → authenticated fetches | cookie-credentials-only posture (no token mirror) | session cookies |
| worker :9090 health/Bull Board server → operators | socket-source IP allowlist → Better Auth admin session (two gates) | admin UI, audit lines |
| deploy pipeline → production | runbook §4c/§4d/§4e choreography, pg_dump backups, readyz gates | live DB rows, artifacts |
| remnant gate → CI (pnpm verify) | armed gate over deleted auth/Prisma remnant classes (src/, scripts/, dist, .next/server) | repo tree |
| anonymization → rehearsal snapshots | D-37 single-canary anonymizer before any stand-in flip | PII (email, tokens) |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-07-SC | Tampering | dependency pins | high | mitigate | exact pins in package.json:29-50 (better-auth 1.7.5 et al) + operator approval recorded 07-01-SUMMARY:142 | closed |
| T-07-01 | DoS | legacy hash login | critical | mitigate | BCRYPT_PREFIXES fail-closed router auth-password.ts:34,52-57; hooks auth.ts:158-161; both-copies rehash fix :74-92 | closed |
| T-07-02 | Tampering | 0002 migration | critical | mitigate | zero DROP/RENAME asserted by cutover-migration.test.ts:300-307 | closed |
| T-07-03 | Elevation | admin seed | high | mitigate | seed-admin-roles.mjs:34-45,74-76 abort-on-ambiguity; :59 exact lowercase grant | closed |
| T-07-04 | Information Disclosure | seed output | medium | mitigate | counts-only logging :17-18,78; env throw-early auth.ts:90-115 | closed |
| T-07-05 | DoS | announcement blast | medium | mitigate | queue-only run (record §12.3, 0-failed); script deleted per D-05, basename gate-blocked | closed |
| T-07-06 | Tampering | email domain source | high | mitigate | render.ts:25 BETTER_AUTH_URL only; zero NEXTAUTH_URL under src/lib/email | closed |
| T-07-07 | Information Disclosure | blast logging | medium | mitigate | counts-only proven (07-02 D5); script deleted b20b599 | closed |
| T-07-08 | Elevation | account linking | high | mitigate | auth.ts:148 disableImplicitLinking: true | closed |
| T-07-09 | Information Disclosure | feedback admin gate | high | mitigate | route.ts:94-96 403 post-401; D-16 line both ways :28-38,91 | closed |
| T-07-10 | Spoofing | IP attribution | medium | mitigate | auth.ts:227 ipAddressHeaders x-forwarded-for | closed |
| T-07-11 | DoS | auth rate limits | medium | mitigate | auth.ts:206-220 rateLimit + Redis storage + customRules 5/h | closed |
| T-07-12 | Tampering | legacy route surface | high | mitigate | src/app/api/auth has only [...all]; deleted modules absent; armed gate enforces | closed |
| T-07-13 | Information Disclosure | cookieCache revocation lag | low | accept | policy in code auth.ts:197-204 (maxAge 300s, lag ≤5 min) — accepted risk below threshold | open — below high threshold (non-blocking) |
| T-07-14 | Spoofing | origin trust | medium | mitigate | auth.ts:120 trustedOrigins from BETTER_AUTH_URL | closed |
| T-07-15 | Tampering | notice-strip markers | low | mitigate | fail-toward-no-strip predicate shipped, then surface deleted at D-05 (§18.3) | closed |
| T-07-16 | Repudiation | copy approval trail | low | accept | D-06 sign-off + blast exercised live (§12.3, §13.3 leg g) — accepted risk below threshold | open — below high threshold (non-blocking) |
| T-07-17 | Elevation | Bull Board access | high | mitigate | two-gate chain health.ts:241-251 → bull-board.ts:198-225 (:214 role check); D-16 on every hit | closed |
| T-07-18 | Spoofing | allowlist source IP | high | mitigate | health.ts:242 socket.remoteAddress only; spoofed header refused (gate suite) | closed |
| T-07-19 | Information Disclosure | health endpoints | medium | mitigate | health.ts:257-263 non-loopback bind answers loopback sources only; ip-allowlist.ts:122-126 | closed |
| T-07-20 | DoS | empty allowlist | medium | mitigate | ip-allowlist.ts:102-105 refuse-everything; gates precede Bull Board code | closed |
| T-07-21 | Information Disclosure | snapshot PII | critical | mitigate | anonymize-snapshot.mjs:28-40,65-210 (single D-37 canary, fail-loud, hash round-trip); .snapshots gitignored | closed |
| T-07-22 | Repudiation | deploy evidence | medium | mitigate | record §2-§11 dated per-leg evidence; D-35 rollback drill §11 | closed |
| T-07-23 | DoS | wrong-stack scripts | medium | mitigate | requireEnv explicit-stack (seed :34, soak-gate :228) | closed |
| T-07-24 | DoS (availability) | flip lockout | critical | mitigate | D-38 canary proven twice §13.3; D-41 pre-committed never triggered; additive 0002 substrate | closed |
| T-07-25 | Repudiation | deletion approval | medium | mitigate | verbatim D-36 APPROVE §14.4; superseded FAIL run kept append-only §14.5 | closed |
| T-07-26 | Information Disclosure | soak-gate secrets | high | mitigate | auth-soak-gate.mjs:57-61,204-206,448 — tokens env-only, never echoed | closed |
| T-07-27 | Tampering | admin roster drift | high | mitigate | D-09 zero-match abort stopped-the-deploy armed (§13.2 step 5) | closed |
| T-07-28 | Tampering | remnant reintroduction | high | mitigate | PHASE7_ENFORCED check-cron-remnants.mjs:180 in pnpm verify (package.json:22); RED-proven, GREEN on deployed tree | closed |
| T-07-29 | DoS | token-mirror removal | high | mitigate | baseApi.ts:13-14,21 cookie-only; full verify GREEN + production canary smoke §16.4 | closed |
| T-07-30 | Tampering | premature table drop | critical | mitigate | deletion release dropped NOTHING (§16.4 read-only assertion); drop only in explicit 0003 after retention (§17) | closed |
| T-07-31 | Information Disclosure | Prisma artifacts in tarball | low | mitigate | build has no prisma generate (package.json:8); zero banned deps | closed |
| T-07-32 | Tampering | 0003 drop scope | critical | mitigate | exactly 4 sanctioned DROP TABLE statements, asserted in-header :8-12; rehearsed twice before production; schema:gate green | closed |
| T-07-33 | DoS (availability) | post-drop substrate | high | mitigate | census users 5/account 5/session 3 retained (§17.3); canary re-login 200 post-drop | closed |
| T-07-34 | Repudiation | drop rollback | medium | mitigate | pre-drop backup pre-0709-drop-20260929-1556.dump archive-verified; D-32/D-36 inheritance §17.1 | closed |
| T-07-35 | Tampering | timestamp wire format | high | mitigate | serialize.ts:33,60 iso/isoRow on all 8 routes + poll :22,74-75; real-DB wire suite; re-review CR-01 VERIFIED FIXED | closed |
| T-07-36 | Repudiation | update timestamps | medium | mitigate | updatedAt on all three write paths (monitors/[id]:161, profile:182, webhook:91) | closed |
| T-07-37 | Tampering | scripts/ scan hole | high | mitigate | DEFAULT_ROOTS += scripts/ (gate :190); file-NAME check :463-478; re-review WR-04 VERIFIED FIXED | closed |
| T-07-38 | Tampering | exemption bypass | medium | mitigate | 3 exact-basename token-only exemptions :159-163 consulted only in token loop :347-350; renamed copy trips (pin 5h) | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-1 | T-07-13 | cookieCache 5-min revocation lag is the documented, accepted policy (auth.ts:197-204); bounded and engine-documented | operator (via D-22 policy approval) | 2026-09-23 |
| AR-2 | T-07-16 | copy-approval repudiation surface bounded by D-06 sign-off + append-only deploy record; both mitigations exercised live | operator (via D-06) | 2026-09-23 |

---

## Audit Trail

## Security Audit 2026-09-30
| Metric | Count |
|--------|-------|
| Threats found | 39 |
| Closed | 37 |
| Open (below high threshold, accepted) | 2 |
| threats_open | 0 |

Audit basis: gsd-security-auditor verification of the plan-authored register (T-07-SC, T-07-01..T-07-38) against implementation + deploy-record proofs, ASVS L1, block_on: high. Related code-review findings tracked separately in 07-REVIEW-DISPOSITION.md (WR-05/IN-04/IN-05 open advisories; WR-03/WINDOWS #4 operator-deferred to Phase 8) — none voids a declared mitigation.
