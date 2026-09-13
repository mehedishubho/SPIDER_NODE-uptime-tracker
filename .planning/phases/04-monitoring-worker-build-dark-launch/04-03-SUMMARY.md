---
phase: 04-monitoring-worker-build-dark-launch
plan: 03
subsystem: security
tags: [ssrf, sec-01, dns-rebinding, connection-pinning, undici-agent, redirect-validation, streamed-cap, error-class-vocabulary, wrk-05, dat-10]

# Dependency graph
requires:
  - phase: 04-monitoring-worker-build-dark-launch
    provides: worker skeleton + undici 8.10.2 dep (04-01); six-lane queue topology + claim engine (04-02 — the lanes that will carry check jobs)
provides:
  - performCheck(req: CheckRequest): Promise<CheckOutcome> — the five-layer SSRF-hardened check pipeline (scheme allowlist → resolve-then-validate with canonicalization → undici Agent connection pinning → manual ≤5-hop validated redirect loop → streamed 2 MB cap inside the whole-exchange timeout)
  - DENYLIST export — exactly the 11 CIDR tokens (audit §15.1/§15.4 + runbook §10; the single source the 04-09 D-40 denylist-diff gate reads)
  - WRK-05 typed classification contract: target behavior (UP/DOWN/timeout/DNS/TLS/SSRF/5xx/network) returns CheckOutcome and NEVER throws; only infra failures (resolver outage, internal bugs) throw — consumed by the 04-06 engine and breaker
  - isInfraFailure(err) — the standalone infra-vs-target classifier for thrown errors (breaker input, 04-06)
  - ErrorClass vocabulary (timeout|dns|tls|ssrf_blocked|http_5xx|network) — the DAT-10 values the 04-04 Tier 1/Tier 2 writers record into pings.error_class / incidents metadata
  - CheckRequest { url, timeoutMs?, denylist? } / CheckOutcome types (D-38 single canonical module for Phase 6 web-side reuse)
  - tests/lib/helpers/check-target-server.ts — reusable local HTTP fixture (redirects/chains/oversized/hang + hit/connection/byte counters) for 04-06/04-08 suites
affects: [04-04, 04-06, 04-07, 04-08, 04-09, phase-06-better-auth-cutover]

# Tech tracking
tech-stack:
  added: [] # undici 8.10.2 landed in 04-01
  patterns:
    - "Connection pinning via undici Agent connect.lookup: the custom lookup answers ONLY from the validateHop-populated map — a DNS-rebinding answer between validation and connect cannot redirect the socket (TOCTOU); unpinned dials fail closed with ESSRF_PIN_VIOLATION → ssrf_blocked"
    - "Address canonicalization BEFORE CIDR testing: brackets stripped, zone ids dropped, IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96 low-32-bits extracted and tested against the IPv4 denylist as that address (WR-01)"
    - "Denylist tokens in the documented shorthand notation (10/8, 172.16/12, 169.254/16): the parser zero-pads the base — tokens are contract-fixed, the parser adapts"
    - "BigInt CIDR math via BigInt() constructor calls — the repo tsconfig targets ES2017 and BigInt literals (ES2020) fail typecheck; tsconfig is out of plan scope"
    - "WHATWG URL normalization is a free normalization layer: short/decimal IPv4 forms (127.1, 2130706433) arrive as dotted quads; IPv6 literals keep brackets in .hostname"
    - "Distinguish undici's wrapped errors: TypeError 'fetch failed' carries the real errno in .cause — classification and isInfraFailure walk rootCause() before reading codes"

key-files:
  created:
    - src/lib/ssrf.ts
    - tests/lib/ssrf.test.ts
    - tests/lib/helpers/check-target-server.ts

key-decisions:
  - "errorClass vocabulary is LOWERCASE (timeout|dns|tls|ssrf_blocked|http_5xx|network) per audit §11/§15.1/§23 ('ssrf_blocked') — plan prose mixed cases (SSRF_BLOCKED/timeout), the audit is the transcription authority and the DAT-10 vocabulary the 04-04 writers consume"
  - "CheckRequest.denylist is a documented TEST-ONLY seam defaulting to DENYLIST — a single-machine fixture can only bind denylisted addresses, so the reachable-fixture cases run under DENYLIST minus exactly one token (::1) while all ten others and every pipeline layer stay active; production callers never set it and the D-40 gate reads the DENYLIST export (Rule 3, Deviation 1)"
  - "Literal-IP URL hosts never touch DNS at all (net/tls skip lookup for literals): validating the literal IS the pin; only hostname dials go through the pinned Agent lookup"
  - "responseTimeMs is measured at FINAL-header arrival (cron parity: the legacy single follow-mode fetch resolved after all redirects); denial/timeout paths report elapsed-at-event instead"
  - "4xx DOWN carries NO errorClass (statusCode explains it; the DAT-10 vocabulary has no http_4xx token — inventing one would drift §11); 3xx-without-Location terminals (304) count as UP exactly like legacy follow mode"
  - "Body read is classification-neutral EXCEPT on timeout: a mid-body transport reset after headers keeps the header-derived outcome (the legacy engine never read bodies — parity), while a body hang past the budget is DOWN timeout (§15.3 whole-exchange rule)"
  - "Undici empirics: a lying-small Content-Length is truncated by undici's parser at the declared length (client never receives the excess) — so the streamed cap is proven on a CHUNKED 3 MB body and the lying-header case asserts the outcome stays header-derived and bounded (Deviations 3)"
  - "SEC-01 marked complete; WRK-05 and DAT-10 deliberately NOT — the classification CONTRACT and vocabulary landed here, but WRK-05's 'successful jobs' exercise (04-06 processor) and DAT-10's recording on pings/incidents (04-04 writers) are the completion legs (ROADMAP maps both reqs to those plans too; 02-03/03-02/04-02 false-signal precedent)"

patterns-established:
  - "Pattern: fail-closed validation — unparseable URL/scheme/Location hop and unparseable denylist tokens all deny/throw rather than pass through"
  - "Pattern: single-map pinning — one Map<hostname, validatedAddresses> per performCheck; the Agent's lookup is the only name→address path undici sees"
  - "Pattern: fixture counters as dial proofs — hits()/totalConnections() on a genuinely-listening private-bound listener prove a denied hop was never followed (§23 network-effect assertions)"

requirements-completed: [SEC-01] # WRK-05 contract-only (04-06 completes); DAT-10 vocabulary-only (04-04 completes) — see key-decisions

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Direct private-range targets (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0.0.0.0/8) and normalization vectors (mapped v6, NAT64, short/decimal IPv4) denied as returned DOWN ssrf_blocked outcomes without a dial (SEC-01, D-42)"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "tests/lib/ssrf.test.ts#2-3 (private-target connection counter stays 0 on the listening fixture)"
        status: pass
  - id: D2
    description: "Per-hop redirect re-validation: public→private crossing and link-local metadata Location denied before following; ≤5 hops followed, 6th refused; relative Locations resolved (D-41, TC-SSRF-REDIRECT-PRIVATE-01)"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "tests/lib/ssrf.test.ts#5-8 (private fixture hits/connections 0; first hop DID execute; chain/0 reached at 5 hops)"
        status: pass
  - id: D3
    description: "Scheme allowlist before any network I/O; 2 MB streamed cap on a 3 MB body; lying Content-Length never trusted; strict injectable timeout on a never-responding socket (D-43, TC-SSRF-SCHEME-01/SIZE-CAP-01/CLASSIFY-TIMEOUT-01)"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "tests/lib/ssrf.test.ts#4,10-12 (fixture byte counter frozen below 3 MB; outcome stays header-derived; timeout within the injected budget)"
        status: pass
  - id: D4
    description: "WRK-05 typed result-vs-error contract: target DNS failure is a successful DOWN check; isInfraFailure separates resolver outage (infra) from target DNS/socket/timeout/abort (target); DENYLIST integrity 11 tokens"
    requirement: WRK-05
    verification:
      - kind: unit
        ref: "tests/lib/ssrf.test.ts#1,13-14 (real NXDOMAIN via .invalid; synthetic errno shapes)"
        status: pass
    human_judgment: false

# Metrics
duration: ~16.5 min single session (987s)
completed: 2026-09-14
status: complete
---

# Phase 4 Plan 3: SSRF-Hardened Check Pipeline Summary

**Canonical five-layer SSRF pipeline at src/lib/ssrf.ts (scheme allowlist, canonicalizing resolve-then-validate over the 11-token CIDR denylist, undici-Agent connection pinning, ≤5-hop validated redirects, streamed 2 MB cap in a strict timeout) with the WRK-05 typed classification and DAT-10 error_class vocabulary, proven by a 14-case fixture suite**

## Session Notes

Single-session sequential execution, both tasks green on first full run after two inline fixes (shorthand CIDR parser, BigInt literal form). Full `pnpm verify` re-run green end-to-end (167 vitest + 18 e2e).

## Performance

- **Duration:** ~16.5 min (987s)
- **Started/Completed:** 2026-09-13T20:38Z → 2026-09-13T20:55Z
- **Tasks:** 2/2
- **Files created:** 3 (all inside the plan's files_modified list)

## Accomplishments
- The D-38 canonical module exists: `performCheck` implements audit §15.1 step 4's five ordered sub-steps, and every SSRF violation surfaces as `{ kind: "down", errorClass: "ssrf_blocked" }` — never a throw (WRK-05)
- Connection pinning is STRUCTURAL: the module contains exactly one fetch call, `undiciFetch(url, { dispatcher: agent })`, and the Agent's custom `connect.lookup` answers only from the per-check validated-address map — plain global fetch cannot appear (T-04-09 mitigated)
- Every documented bypass vector denied and pinned by test: IPv6-mapped (`::ffff:10.0.0.1`, `::ffff:127.0.0.1`), NAT64-embedded (`64:ff9b::10.0.0.1`), short (`127.1`) and decimal (`2130706433`) IPv4 forms, `0.0.0.0/8`, and public→private redirect crossings proven un-dialed via a zeroed connection counter on a genuinely listening private-bound fixture (D-42, T-04-10/T-04-08 mitigated)
- The 2 MB cap counts STREAMED bytes: the 3 MB chunked probe aborts with the fixture's byte counter frozen well below total, and the lying-Content-Length case stays header-derived (D-43, T-04-11 mitigated)
- Cron parity transcribed character-for-character: GET, `cache: no-store`, the exact `User-Agent: Mozilla/5.0 (compatible; UptimeTrackerBot/1.0)` + `Accept` headers, `performance.now()` timing at final-header arrival, UP = 200–399
- Down outcomes carry errorClass vocabulary only — no stacks, no URLs, no internals (T-04-12 mitigated)

## Task Commits

1. **Task 1: SSRF check pipeline module** — `11bc75f` (feat)
2. **Rule 1 fix: shorthand IPv4 CIDR bases** — `2e77492` (fix, found by Task 2 verification)
3. **Task 2: fixture server + §23/D-42 proof suite** — `629ecd0` (test)

## Files Created/Modified
- `src/lib/ssrf.ts` — DENYLIST (11 tokens), performCheck, CheckRequest/CheckOutcome/ErrorClass types, isInfraFailure, CIDR/canonicalization machinery, pinned Agent builder, capped reader
- `tests/lib/helpers/check-target-server.ts` — bind-host-parameterized fixture: /ok, /notfound, /error500, /canary, /redirect?to=, /chain/N, /oversized (chunked 3 MB), /lying-length (Content-Length: 1024 vs 3 MB written), /hang; hits()/totalConnections()/oversizedBytesWritten() counters; closeAllConnections teardown
- `tests/lib/ssrf.test.ts` — 14 cases: DENYLIST integrity, direct private denials (with dial-proof counters), D-42 normalization vectors, scheme denial, public→private redirect crossing, metadata redirect, relative redirect follow, 5-hop cap, classification parity (200/404/500), streamed cap, lying Content-Length, timeout, NXDOMAIN, isInfraFailure

## Decisions Made
See key-decisions in the frontmatter — the load-bearing ones for downstream plans:
- errorClass values are lowercase audit-form; 04-04 writers consume exactly `timeout|dns|tls|ssrf_blocked|http_5xx|network` (4xx carries no errorClass)
- The `denylist` request field is test-only; 04-06's engine must never set it
- `timeoutMs` stays injectable so engine-level tests can shrink the budget (the 10 s default is the §15.3 non-negotiable in production)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] CheckRequest gained a documented TEST-ONLY `denylist` seam**
- **Found during:** Task 2 design — the plan demands fixture-reachable "public" hops, but a single-machine fixture can only bind loopback/private addresses, ALL of which the production denylist blocks; no OS-level trick (hosts-file edits, extra bindable addresses) is available without admin rights
- **Fix:** `CheckRequest.denylist?: string[]` defaulting to `DENYLIST`; tests pass `DENYLIST.filter(t => t !== "::1")` so exactly one token is omitted and every other protection stays live. Documented in-code as test-only; production callers (04-06, Phase 6) must not set it
- **Files modified:** src/lib/ssrf.ts (within files_modified)
- **Verification:** all 14 cases green; DENYLIST export itself asserted untouched (case 1)
- **Committed in:** 11bc75f

**2. [Rule 1 - Bug] CIDR parser rejected the contract's shorthand IPv4 bases**
- **Found during:** Task 2 first run — all 12 fixture cases failed the fail-closed guard: `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16` bases are not dotted quads and `net.isIP("10")` is 0
- **Fix:** `expandIPv4Shorthand` zero-pads the base (10 → 10.0.0.0) before family detection; tokens are contract-fixed so the parser adapts to the §15.1/runbook §10 notation
- **Files modified:** src/lib/ssrf.ts
- **Verification:** full suite 167/167
- **Committed in:** 2e77492

**3. [Rule 1 - Test design] Lying-small Content-Length cannot itself cross the 2 MB cap through undici**
- **Found during:** Task 2 pre-implementation probe — undici's HTTP parser truncates a body at the DECLARED Content-Length (1024), so the client never receives the excess 3 MB through a lying header; the plan's single "3 MB body with lying small Content-Length" case could not exercise the streamed counter
- **Fix:** the fixture serves TWO oversized routes — `/oversized` (3 MB CHUNKED, no Content-Length: the true streamed-cap probe with byte-counter assertions) and `/lying-length` (declared 1024, writes 3 MB: asserts the outcome stays header-derived and the read stays bounded). Both D-43 properties proven; neither trusts the header
- **Files modified:** tests/lib/helpers/check-target-server.ts, tests/lib/ssrf.test.ts
- **Verification:** cases 10-11 green
- **Committed in:** 629ecd0

---

**Total deviations:** 3 auto-fixed (1 Rule 3 test-infrastructure seam, 2 Rule 1 — one parser bug, one empirically-driven test redesign). No scope creep: every change lands inside the plan's files_modified list; production behavior of the pipeline is unchanged by all three.

## DENYLIST — verbatim record for the 04-09 D-40 gate

Cross-checked token-by-token against `docs/DEPLOY-RUNBOOK.md` §10 step 1(a) and audit §15.1 step 4 sub-step 2 / §15.4 (the one list in three statements):

```
10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0.0.0.0/8,
::1, fc00::/7, fe80::/10, ::ffff:0:0/96, 64:ff9b::/96
```

The test suite asserts `DENYLIST.length === 11` and full token membership (case 1), guarding the gate's extraction source.

## Issues Encountered
- tsconfig targets ES2017 → BigInt literals unavailable (TS2737); rewritten as `BigInt()` constructor calls rather than touching out-of-scope tsconfig.json
- `pnpm test -- <file>` passes a literal `--` through to vitest, which then runs the whole suite — a superset of the plan's targeted verify, so acceptance held (167/167)

## User Setup Required

None.

## Threat Flags

None — no security-relevant surface beyond the plan's own threat_model. All five register rows (T-04-08..T-04-12) carry their mitigations in this plan's code/tests.

## Self-Check: PASSED

All 4 created files exist on disk; all 3 task commits (11bc75f, 2e77492, 629ecd0) present in git log.
