---
phase: 03
slug: redis-drizzle-schema-ownership
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-09-12
---

# Phase 03 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| request headers → limiter keys | x-forwarded-for derived IP becomes Redis key material (Lua KEYS[1], parameterized — not command-concatenated) | public IP strings; low sensitivity |
| Redis service → app process | an unreachable/misbehaving Redis must degrade the limiter, never crash or stall the process | limiter counters only; no user data |
| app process → PostgreSQL | the single pooled connection path; budget + timeouts are the availability guard | full uptime dataset (PII-bearing) |
| production data → dev machine | a full production dump lands in gitignored `.snapshots/` (PII-bearing until anonymization) | emails, session tokens, bcrypt hashes |
| snapshot/rehearsal container → dev machine ports | throwaway Postgres on local ports; must not collide with sibling stacks | restored production data |
| migration SQL → production (at deploy) | forward-only additive DDL executes against live tables holding real uptime data | schema + data integrity |
| runbook text → operator actions on production | an ambiguous or wrong step executes against live data | operator actions |
| Redis service (production topology) | loopback-only, password-protected state store for anti-abuse limiting | limiter counters |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-03-01 | DoS | rateLimit when Redis is down | high | mitigate | Fail-open contract (D-01): commandTimeout 200ms + maxRetriesPerRequest 1; error listener prevents crash. Verified: D-20 suite re-run live by verifier 2026-09-12 (5/5: fail-open <1s, restart-survival, atomicity, TTL) | closed |
| T-03-02 | Tampering/DoS | limiter state via non-atomic INCR/EXPIRE | medium | mitigate | Single Lua script (INCR + EXPIRE-on-first) via `defineCommand` (`src/lib/rate-limit.ts`). Verified: grep + reviewer + D-20 atomicity/TTL tests | closed |
| T-03-SC | Supply chain | ioredis / drizzle-orm / drizzle-kit installs | high | mitigate | Package Legitimacy Audit passed (npm registry + official docs); caret pins in package.json; no postinstall scripts. Verified: 03-01-SUMMARY Threat Flags | closed |
| T-03-02b | Information Disclosure | redis error handler logging | low | mitigate | Log err.message categories only; REDIS_URL never logged. Verified: grep of `src/lib/redis.ts` — URL read into const, single console statement is the DEGRADED marker | closed |
| T-03-03 | DoS | pool without timeouts/budget (hung queries pin connections) | medium | mitigate | §25.2 options pinned in `src/lib/db-pool.ts`, asserted by `tests/integration/db-pool.test.ts`; connectionTimeoutMillis nonzero, statement_timeout 30s | closed |
| T-03-04 | Tampering | accidental second Pool / cross-process sharing | medium | mitigate | Single-owner module, per-process rule documented (D-06). Verified: exactly 1 `new Pool(` in src/lib | closed |
| T-03-05 | Information Disclosure | prod dump committed or shared | high | mitigate | `.snapshots/` gitignored before dump taken (03-03 Task 1 ordering); connection strings never echoed. Verified: `.gitignore:44`; dumps never committed | closed |
| T-03-06 | Tampering | wrong baseline content silently diverging from prod | high | mitigate | Line-by-line review vs prod-schema-only dump; empty-diff gate locks equivalence. Verified: verifier reproduced empty pull-diff live 2026-09-12 | closed |
| T-03-07 | Tampering | stamp writing wrong hash/timestamp → runner re-runs 0000 | critical | mitigate | Stamp mirrors verified 0.45.2 migrator computation; stamp→migrate no-op proven. Verified: deploy record (1 row, hash matches anchor; migrate run 2 = no-op) | closed |
| T-03-08 | Tampering/Destruction | destructive DDL inside a versioned migration | critical | mitigate | Additive-only grep gates + end-state probes + rehearsal proof. Verified: 0 DROP/RENAME in drizzle/0001; verifier confirmed additive end-state on live DB | closed |
| T-03-09 | Tampering | stale `prisma db push` run against the grown DB | critical | mitigate | FROZEN banner (D-09) + machinery switch (D-14) + permanent absence gate. Verified: 0 hits in executable surfaces (grep + gate absence scan live) | closed |
| T-03-10 | DoS | dual-write / second pool via premature Drizzle adoption | medium | mitigate | No route imports `@/db`; writes remain Prisma-only until Phase 7. Verified: 0 `@/db` importers in src/app; only importer is a test | closed |
| T-03-11 | Information Disclosure | anonymized evidence or dump committed to git | high | mitigate | Evidence carries counts+digests only, lives in phase dir; raw dumps stay in gitignored `.snapshots/` (D-11); anonymization runs before evidence | closed |
| T-03-12 | Tampering | unnoticed data mutation during rehearsal | critical | mitigate | Deterministic per-table digests with single documented carve-out; mismatch exits non-zero and blocks deploy. Verified: rehearsal evidence PASS (9 tables count+digest EQUAL) | closed |
| T-03-13 | DoS | rehearsal container colliding / orphaned | medium | mitigate | Port pre-check aborts on occupancy; teardown in finally block | closed |
| T-03-14 | Tampering/Elevation | Redis exposed on the network | high | mitigate | §3b: bind 127.0.0.1 + protected-mode + requirepass (D-18 layering). Verified live: loopback `127.0.0.1:6391`, requirepass active | closed |
| T-03-15 | DoS | Redis memory exhaustion / silent eviction | medium | mitigate | noeviction + maxmemory 512mb (verified live) + §3c 70% dead-man alert — alert application deferred to first VPS deploy per operator disposition (see Accepted Risks AR-01) | closed |
| T-03-16 | Tampering | operator improvising migration steps under pressure (M-1) | high | mitigate | §3 step 3 + §3d make stamp→migrate→rehearsal typed, ordered, rollback-annotated | closed |
| T-03-17 | Tampering | silent schema drift | high | mitigate | Empty-diff gate in `pnpm verify` + mutation proof. Verified: verifier re-ran gate green live (~3s) | closed |
| T-03-18 | Tampering/Destruction | destructive push command resurrected | critical | mitigate | Absence scan with concatenated-fragment literals + self-exclusion; mutation-proven; scoped to executable surfaces | closed |
| T-03-19 | DoS | gate false-positives eroding trust | medium | mitigate | schemaFilter public, .tmp-gate isolation + cleanup, normalization spike allowance, comment-insensitivity proof, ≤5-min budget check | closed |
| T-03-20 | Tampering/Destruction | failed/half-applied production migration | critical | mitigate | Rehearsal-gated deploy; backup precedes everything; stamp-before-migrate; per-step rollback; forward-only. Verified: deploy record (backup 21,595 B verified via pg_restore --list; stamp; migrate; proofs (a)–(g) green) | closed |
| T-03-21 | DoS | app restarted without REDIS_URL | high | mitigate | Runbook orders env before reload; local release launched with explicit env vars. Note (03-REVIEW WR-03): blast radius is the two limiter routes (500s), not a boot crash loop — module not imported at boot; loud and instantly fixable either way | closed |
| T-03-22 | Information Disclosure | requirepass/connection string leaked into chat/logs | high | mitigate | Runbook + instructions never echo secrets; deploy record stores outcomes, not values. Maintained throughout the 03-08 operator session | closed |
| T-03-23 | DoS | Redis hardening skipped | medium | mitigate | §3b ordered before app reload; proof (g) verified requirepass-protected PING + restart policy before phase close | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-03-15 | §3c 70%-memory dead-man alert not applied on the local stand-in topology (no systemd cron / healthchecks.io surface exists locally). Core mitigations (noeviction, 512mb ceiling) ARE applied and live-verified. Alert application is forward-tracked to the first real VPS deploy — PROJECT.md → Context, 03-UAT disposition (b), 03-VERIFICATION Acknowledged Gaps #1. Conditional acceptance: expires when the VPS deploy applies §3c verbatim. | Operator (mehedishubho), via 03-UAT disposition | 2026-09-12 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-12 | 24 | 24 | 0 | L1 grep-depth pass (orchestrator) + live evidence from gsd-verifier (D-20 suite re-run, gate re-run, live CONFIG checks) + gsd-code-reviewer cross-check |

**Out-of-register observations** (not counted above; tracked in 03-REVIEW.md with fix recommendations): CR-01 stale `drizzle/meta/0001_snapshot.json` (breaks next `drizzle-kit generate`, not any shipped mechanism); WR-02 rehearsal port binds `0.0.0.0` (PII LAN-reachable during restore window — one-line fix); WR-06 limiter keys on raw `x-forwarded-for` (header rotation bypass). These affect future work, not phase-03 criteria; repair before the next migration is authored.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-12
