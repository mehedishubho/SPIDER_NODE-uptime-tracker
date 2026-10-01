---
phase: "08"
slug: "flagged-capabilities-ui-modernization"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-10-01"
---

# Phase 8 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Register authored at plan time (`<threat_model>` blocks in 08-01..08-10); auditor verified every
> mitigation at its cited location on the shipped release-c (3372424) tree, 2026-10-01.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Browser ↔ `/api/ai/*` routes | New authenticated streaming surface (session-guarded, flag-gated) | Session cookie, incident/monitor ids, NL description, streamed AI output (copy-only) |
| Web ↔ AI provider (Z.ai GLM et al.) | Server-side only via `src/lib/ai` (env-triple) | Delimited evidence prompts, API key (env-only, never client/log) |
| Worker maintenance lane ↔ Postgres | Nightly windowed recompute (adds 3 columns) | Windowed uptime values — lifetime counters never touched |
| App ↔ deleted deps | sweetalert2/react-icons removal; shadcn dialog/alert-dialog + react-markdown additions | UI rendering surface (markdown rendered without rehype-raw) |

---

## Threat Register

Full per-threat evidence (file:line) in the 2026-10-01 audit run (gsd-security-auditor). 39 STRIDE rows audited: 31 numbered threats + 8 supply-chain declarations (T-08-SC per plan). Dispositions: all `mitigate` except T-08-11 (`accept`).

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-08-01 | Tampering | windowed recompute | high | mitigate | UPDATE sets exactly uptime24h/7d/30d (maintenance.ts:276-282); lifetime untouched | closed |
| T-08-02 | Tampering | windowed math | high | mitigate | D-36 binary extraction verbatim; no `round()` (maintenance.ts:224-232) | closed |
| T-08-03 | Tampering | migration 0004 | high | mitigate | Additive migration + journal; schema:gate + rehearse:migrations in verify chain | closed |
| T-08-04 | Tampering | confirm dialogs | medium | mitigate | AlertDialog migrations ×3 + dialogs.spec.ts e2e | closed |
| T-08-05 | Elevation | alert-dialog primitive | low | mitigate | Official Radix package, legitimacy recorded (08-02-SUMMARY) | closed |
| T-08-06 | Tampering | dep deletions | medium | mitigate | Zero swal/react-icons specifiers under src/; PHASE8 remnant gate in pnpm verify | closed |
| T-08-07 | DoS | polling surfaces | low | mitigate | AbortController all 4 surfaces + ui-robustness.spec.ts | closed |
| T-08-08 | Tampering | hydration | medium | mitigate | useSyncExternalStore mounted guard (DashboardStatus.tsx:105-112) | closed |
| T-08-09 | Tampering | monitoring behavior | critical | mitigate | Contract suites in pnpm verify; redesign e2e; review 0 critical | closed |
| T-08-10 | DoS | motion | low | mitigate | useReducedMotion fallback (StatsSummaryHeader) | closed |
| T-08-11 | Information Disclosure | monitor URL display | low | accept | Full URL on hover via `title` attr (Dashboard.tsx:848) — accepted-risk log below | closed (accepted) |
| T-08-12 | Tampering | token freeze lift | high | mitigate | D-31 split discipline in globals.css; both-theme e2e legs | closed |
| T-08-13 | DoS | light contrast | medium | mitigate | Light cyan + border contrast pins in light-mode.spec.ts | closed |
| T-08-14 | Information Disclosure | --dialog-* tokens | low | mitigate | Trio retired; zero references under src/ | closed |
| T-08-15 | Tampering | prompt injection | high | mitigate | Evidence in delimiters + untrusted-data instruction (post-mortem route:53-68); copy-only output | closed |
| T-08-16 | DoS | AI cost abuse | high | mitigate | Per-user 10/h bucket, 2000-char cap (413 at-cap pins), maxRetries:0, timeout, D-10 logs | closed |
| T-08-17 | Spoofing | unauthenticated AI access | high | mitigate | aiEnabled() 404 pre-body-read + 401 pre-limiter; live dark-soak 404 proof | closed |
| T-08-18 | Information Disclosure | AI key leakage | high | mitigate | Env read server-only in lib/ai; errors name vars not values; boolean-only client crossing | closed |
| T-08-19 | Elevation | IDOR on evidence | high | mitigate | `WHERE id AND userId = session.user.id` before evidence query; 404 zero-read test pin | closed |
| T-08-20 | Spoofing | limiter bypass | medium | mitigate | Per-USER keys post-auth (`ai_{bucket}_{userId}`); no getIP in AI chain | closed |
| T-08-21 | Tampering | assistant-created URL | high | mitigate | Prefill-only; create route re-runs assertUrlAllowed; e2e real-route submission pin | closed |
| T-08-22 | Tampering | AI→DB writes | high | mitigate | Zero write paths (select-only / no db import); zero-write test pins | closed |
| T-08-23 | Tampering | markdown XSS | high | mitigate | ReactMarkdown without rehype-raw (never installed); no dangerouslySetInnerHTML in card | closed |
| T-08-24 | Tampering | assistant SSRF | high | mitigate | Server-side assertUrlAllowed on submit; schema prefill only | closed |
| T-08-25 | DoS | assistant abuse | medium | mitigate | 20/h bucket + cap + maxRetries:0 + timeout + D-10 logs | closed |
| T-08-26 | Information Disclosure | flag propagation | medium | mitigate | Server-rendered boolean; no AI_* names client-side; flag-off zero-trace e2e | closed |
| T-08-27 | DoS | deploy disruption | high | mitigate | Runbook §4f: backup → migrate → readyz-gated restarts → smoke per release | closed |
| T-08-28 | Information Disclosure | keys in env/repo | high | mitigate | Zero AI_* on box (name-grepped); .env.example empty; flip = blocking operator gate | closed |
| T-08-29 | DoS | runaway spend | medium | mitigate | Guard-chain cost controls + D-10 visibility; env-flip rollback; stay-dark posture | closed |
| T-08-30 | Tampering | tier-2 tokens | medium | mitigate | Structural class swaps + both-theme e2e legs; contract suites untouched | closed |
| T-08-31 | Tampering | sidebar accent | medium | mitigate | Reserved cyan active-nav classes intact (NavMain.tsx:52) | closed |
| T-08-SC (×8) | Tampering | supply chain | high | mitigate | Exact pins + legitimacy protocols: ai@7.0.123, @ai-sdk/* (3 pkgs), zod@4.6.5, @radix-ui/react-alert-dialog, react-markdown@10.1.0; no unplanned installs | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-08-01 | T-08-11 | Monitor target URL is shown in full on row-hover via the `title` attribute (Dashboard.tsx:848). The URL belongs to the authenticated owner's own monitor list (ownership-scoped reads); exposure is to the same user, and the visible column truncates it. Low-severity convenience affordance retained deliberately. | gsd-security-auditor verdict + orchestrator disposition | 2026-10-01 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-01 | 39 rows (31 numbered + 8 SC declarations) | 31/32 distinct IDs fully closed (T-08-11 closed-via-accepted-risk) | 0 (T-08-11 was accept-dispositioned, below high threshold; closed by AR-08-01) | gsd-security-auditor (ASVS L1) |

**Out-of-register observation (awareness only, pre-existing code, not a phase-08 threat):** `src/components/form/MyFormCheckbox.tsx:55` uses `dangerouslySetInnerHTML` with static consent text — flagged for a future hygiene pass.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-10-01 (gsd-security-auditor verdict `## SECURED`; orchestrator persisted accepted risk AR-08-01)
