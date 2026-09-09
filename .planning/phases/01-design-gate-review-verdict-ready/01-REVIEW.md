---
phase: 01-design-gate-review-verdict-ready
reviewed: 2026-09-09T17:17:11Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - docs/ARCHITECTURE-AUDIT.md
  - docs/ARCHITECTURE-REVIEW.md
  - docs/DEPLOY-RUNBOOK.md
findings:
  critical: 2
  warning: 5
  info: 7
  total: 14
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-09-09T17:17:11Z
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Design-gate phase: the three deliverables are engineering documents (amended target-architecture audit, adversarial design review with flipped verdict, deploy runbook), reviewed as specifications — internal consistency, correctness of the pinned SQL/Redis/BullMQ semantics against the documented invariants (1-strike DOWN, lifetime uptime math, Telegram alert content, guarded-flush durability), security posture of the egress rule set, and runbook executability.

**Prior-cycle closure verified.** Every finding from the previous review of these documents (CR-01..CR-03, WR-01..WR-08, IN-01..IN-05) is genuinely reflected in the current text: §16.2 now carries the staging-key exclusive snapshot (RENAMENX), the multi-row ping INSERT inside the guarded transaction, and the pinned batchId scheme; §15.1 carries IPv4-mapped canonicalization plus `0.0.0.0/8`/`::ffff:0:0/96`/`64:ff9b::/96`; §12.4/§13.1 carry the `rl:manual-user:{userId}` key with Lua INCR/EXPIRE-NX; the runbook has the phase-conditional Migrate step, the `process.send('ready')` handshake, §4a (first worker release), and §10 (egress). Spot-checked technical claims hold: the §14.3 claim transaction (FOR UPDATE SKIP LOCKED inside the CTE is required and correctly placed), partial-unique-index inference for `ON CONFLICT (monitor_id) WHERE status = 'ONGOING'`, `GREATEST` NULL-ignoring semantics and the CASE asymmetry note, `gen_random_uuid()` PG13+ availability, BullMQ 6 `UnrecoverableError`/lazy KeepJobs eviction, and the RENAMENX redelivery-safety argument. The GREATEST/monotonic flush, the outbox relay pattern, and the breaker classification are internally consistent across §13/§14/§15/§16.

**Where it fails now.** Two cross-section defects survived both adversarial re-review cycles and the fix cycles:

1. **`monitors.uptime_percent` has no writer and no specified read-time derivation** after the move to SQL-relative counters. §16.1's transition UPDATE and §16.2's flush UPDATE maintain `total_checks`/`failed_checks` only; §16.5 deletes the recompute job; §11 decision 5 says the value "stays derived lifetime math" without pinning by whom. A Phase 4 implementer transcribing §16 literally — the documents' own stated contract — freezes the displayed lifetime uptime at its cutover value forever, violating the behavior-compatibility hard constraint on the dashboard/status-page contract (CR-01).
2. **The Phase 4 overlap window contradicts the audit's own M4 mitigation and runs non-idempotent legacy code against a schema that now enforces invariants the legacy code was never written for.** Runbook §4a step 2 ("disable nothing … both paths are idempotent by design … never corrupts data") is false about the legacy path — §5's own defect catalogue documents B3 (stale-status write) and B4 (read-modify-write counters) — and M4's mitigation ("old path disabled before first new-path flush") is unexecutable simultaneously with it. Audit §22's "the runbook wins" tie-breaker resolves the contradiction toward the unsafe option (CR-02).

Three further warnings concern runbook executability at exactly the releases the runbook itself labels highest-risk (smoke check not executable at Phase 4; `kill_timeout` below the documented worst-case job duration), one concerns remaining gaps in the mirrored SSRF denylist, and two pin unspecified behavior-compat details of the classification/alert pipeline.

## Critical Issues

### CR-01: `monitors.uptime_percent` has no specified writer or read-path derivation — literal transcription freezes displayed lifetime uptime

**File:** `docs/ARCHITECTURE-AUDIT.md:912-921` (§16.1 step-2 UPDATE), `docs/ARCHITECTURE-AUDIT.md:996-1002` (§16.2 flush UPDATE), cf. `docs/ARCHITECTURE-AUDIT.md:1068-1074` (§16.5), `docs/ARCHITECTURE-AUDIT.md:419` (§11 decision 5), `docs/ARCHITECTURE-AUDIT.md:286` (§10 `uptimePercent Float`)

**Issue:** In the current system, every write path recomputes `uptimePercent` and stores it (§3, §5); the API and dashboards read the stored column — that is part of the "public API shapes" behavior-compatibility constraint. In the target design:

- §16.1's transition UPDATE sets `status, last_checked, response_time, total_checks, failed_checks` — not `uptime_percent`.
- §16.2's guarded flush UPDATE sets `total_checks, failed_checks, last_checked, response_time` — not `uptime_percent`.
- §16.5 kills the `recompute-uptime` job ("lifetime counters are authoritative; the job has no algorithm and no purpose in v1") and asserts "the dashboard/status-page contract is untouched" — but never says the read path computes `(total_checks − failed_checks) / total_checks` on the fly.
- §11 decision 5 says only "`uptime_percent` stays derived lifetime math per the D-6 decision recorded in §16" — "derived" by whom is never pinned.

The documents set their own bar: §16 is "literal SQL a Phase 4 implementer transcribes without interpretation." Transcribed literally, no writer ever touches `uptime_percent` after cutover, the column freezes at its migration-time value, and the dashboard and public status pages display a stale lifetime uptime percentage indefinitely — a silent, user-visible behavior regression of exactly the kind the "monitoring semantics preserved" hard constraint forbids. This is not the Phase 8 windowed-uptime question (§16.5 defers that correctly); it is the *lifetime* display path for the entire compatibility window, and it is unspecified.

**Fix:** Pin one of two mechanisms explicitly:

```sql
-- Option A (preferred — keeps the stored column and the public API shape unchanged):
-- both §16.1 step 2 and §16.2 extend their UPDATEs with the derived expression:
UPDATE monitors SET
  ...
  total_checks  = total_checks + $dTotal,
  failed_checks = failed_checks + $dFailed,
  uptime_percent = CASE WHEN total_checks + $dTotal > 0
                        THEN round(100.0 * ((total_checks + $dTotal) - (failed_checks + $dFailed))
                                         / (total_checks + $dTotal), 2)
                        ELSE uptime_percent END,
  ...
```

or Option B: state in §16.5 that reads derive uptime from the counters (`(total_checks − failed_checks)/total_checks`) at query time, that the stored column becomes derived/dead (excluded from API responses or computed in the read query), and reconcile §10/§11 accordingly. Add a Phase 4 test asserting `uptime_percent` (or its read-path equivalent) changes after a recorded check.

### CR-02: Overlap window contradicts M4 — "disable nothing" runs non-idempotent legacy code (B3/B4) against the new schema and the new worker's writers

**File:** `docs/DEPLOY-RUNBOOK.md:113-116` (§4a step 2), `docs/ARCHITECTURE-AUDIT.md:1168-1169` (M3 vs M4), cf. `docs/ARCHITECTURE-AUDIT.md:163-176` (§5 flush algorithm, B3/B4), `docs/ARCHITECTURE-AUDIT.md:373` (§11 `incidents_one_ongoing` at the Phase 3 baseline), `docs/ARCHITECTURE-AUDIT.md:1204` (§22 "the runbook wins")

**Issue:** Three mutually inconsistent statements govern the Phase 4 first-worker overlap window:

- M3 / runbook §4a step 2: keep the old `instrumentation.ts` cron running while the new worker serves — "both paths are idempotent by design, so the overlap only wastes duplicate checks, never corrupts data."
- M4's mitigation: "**old path disabled before first new-path flush**" — but the new worker's `flush-pass` runs every 30 s from the moment it starts, so this is unexecutable simultaneously with "disable nothing."
- §22: "where any ordering statement here and the runbook could be read differently, the runbook wins" — which resolves the tie toward the "disable nothing" option.

The claim that both paths are idempotent is false for the legacy path, per the audit's own §5 defect catalogue, and the overlap window reactivates both catalogued defects against the new writers:

1. **B3 state regression, cross-path:** the legacy flusher's `pendingMonitorUpdates` carries a stale in-memory `status` and writes it on flush (`monitor.update` includes `status`). Legacy routine UP delta queued at 09:58; new-path Tier 1 DOWN transition at 10:00 (status=DOWN, incident ONGOING, alert sent); legacy 15-min flush at 10:00:15 writes `status='UP'` back. Result: monitor displays UP while down (the cardinal sin for an uptime monitor), a dangling ONGOING incident, and a spurious re-DOWN transition at the next new-path check.
2. **B4 lost increments, cross-path:** the legacy flusher is find-then-update (read counters → compute → write absolute values). Any new-path SQL-relative increment committed between the legacy read and write is silently lost — permanent drift in the lifetime counters that CR-01's uptime display is computed from.
3. **Legacy code against a schema it has never seen:** `incidents_one_ongoing` (partial unique index) lands at the Phase 3 baseline, *before* the Phase 4 overlap. The legacy `incident.create({status:"ONGOING"})` has no `ON CONFLICT` handling; whenever the new worker opens the incident first, the legacy insert throws a unique-violation inside its non-transactional slow path (§5: "three-plus separate statements, not a transaction") — a partial write plus an unhandled error in the fallback path, during the release the runbook itself calls "the highest-risk release of the milestone."

§4a step 2's verification ("counter deltas sane … no doubling", citing M4) checks for doubling but not for the under-counting B3/B4 actually produce, and cites M4 as if its sequencing were satisfied.

**Fix:** Amend both documents to a single consistent rule. Either (a) during the overlap window the legacy path's *write side* is disabled (flag the legacy cron read-only / verification-only so it never persists, keeping it only as a cold-standby check path if the worker fails its window), or (b) keep "disable nothing" but (i) correct M3/§4a to state the legacy path is not idempotent and name the accepted corruption surface, (ii) make the §4a step-2 verification detect under-count drift, not just doubling, and (iii) add a mandatory post-overlap reconciliation release that repairs counters from the per-check evidence (`SELECT count(*), count(*) FILTER (WHERE status='DOWN') FROM pings WHERE monitor_id=$mid` — every new-path check leaves a ping row) and re-derives `status` from the latest transition. Additionally reconcile M4's mitigation text with whichever rule is chosen, and delete or qualify §22's blanket "the runbook wins" for this specific conflict.

## Warnings

### WR-01: The smoke check is not executable at Phase 4 — §4a step-1 verification cites it prematurely, and the "web enqueue" leg does not exist yet

**File:** `docs/DEPLOY-RUNBOOK.md:110-111` (§4a step 1 verification), `docs/DEPLOY-RUNBOOK.md:140` (§6 smoke definition), cf. `docs/ARCHITECTURE-AUDIT.md:812` (§15 "API routes never execute checks — they enqueue"), `docs/ARCHITECTURE-AUDIT.md:1327-1328` (§24 steps 4–5)

**Issue:** §6 defines the target smoke check as proving "web enqueue → Redis/BullMQ → worker check → Postgres persist." Two problems at Phase 4:

1. §4a step 1's verification list includes "the §4 step 6 synthetic-check smoke passes" — but §4a replaces §4 step 4 and runs *before* §4 step 5 (web restart), and at first-worker-release time the deployed web is still the old build with no enqueue capability. The operator is told to verify, at step 1, a check that cannot run until after step 5 (or ever — see 2).
2. Per §24, the enqueue-based manual-check route lands at step 5 (Phase 5), *after* the worker (step 4). So no web enqueue surface exists at any Phase 4 release, and the smoke as defined cannot prove its "web enqueue" leg. §15's ownership statement ("API routes never execute checks — they enqueue") reads as if the route flips with the worker, contradicting §24's sequencing — the two sections disagree on when the route flips.

**Fix:** Specify the Phase 4 interim smoke mechanism (a pinned enqueue script / `redis-cli`-based BullMQ add against the smoke-test monitor, asserting the ping row), move the smoke verification in §4a step 1 to after §4 step 5, and reconcile §15 vs §24 on when `monitors/[id]/check` flips to enqueue+202 (state it explicitly in §24 step 4 or 5, in one place only).

### WR-02: `kill_timeout` 20000 is pinned as "≥ max job duration" but the audit's own worst-case check job is ~40 s

**File:** `docs/DEPLOY-RUNBOOK.md:128` (§5 kill_timeout row), cf. `docs/ARCHITECTURE-AUDIT.md:823` (§15.1 step 3: renewal spans "Tier 1 persistence (§16.1, which may legitimately take up to the 30 s `statement_timeout`)"), `docs/ARCHITECTURE-AUDIT.md:855` (§15.3 lock-TTL row, same statement), `docs/ARCHITECTURE-AUDIT.md:1363` (§25.2 statement_timeout 30000)

**Issue:** §5 sets `kill_timeout` to 20000 with "Must be ≥ max job duration." The fix-cycle WR-08 amendment (renewal-through-persist) explicitly acknowledges a legitimate check-job lifetime of 10 s fetch + up to 30 s Tier 1 persistence ≈ 40 s — a figure that post-dates and invalidates the 20 s constant without anyone re-deriving it. On every deploy that drains a slow-persisting check job, PM2 SIGKILLs mid-Tier-1-transaction. The transaction rolls back (no corruption), but with `maxStalledCount: 1` a job stalled twice — e.g., killed on two consecutive deploys — moves to the failed set permanently: a DOWN/RECOVERED transition silently dead-lettered. The same drift applies to the BullMQ `lockDuration` 30000 vs the 40 s worst case (BullMQ auto-renews while the process lives, so this is masked — but the runbook's own stated rule is violated by its pinned value).

**Fix:** Either raise `kill_timeout` to ≥ 45000 (and say the budget is 10 s fetch + 30 s persist + margin), or bound the check-job persist path (`SET LOCAL statement_timeout` below the §16.1 transaction, e.g. 10 s) and keep 20 s — pick one and make §5, §15.1 step 3, and §15.3 state the same number.

### WR-03: Mirrored SSRF denylist still omits `::/128` and `100.64.0.0/10`

**File:** `docs/ARCHITECTURE-AUDIT.md:826` (§15.1 step 4 sub-step 2), `docs/ARCHITECTURE-AUDIT.md:865` (§15.4), `docs/DEPLOY-RUNBOOK.md:176` (§10)

**Issue:** The 11-CIDR list adds `0.0.0.0/8` with the rationale "many stacks connect it to localhost" — but omits the IPv6 unspecified address `::/128`, which has exactly that property on the same stacks (`http://[::]/` reaches localhost on Linux). It also omits `100.64.0.0/10` (CGNAT — Tailscale and overlay networks live here; the host layer would otherwise permit 80/443 to that space). Because the list is pinned as "one list in three places," each addition is a coordinated three-file change — the cheap moment to extend it is now, before Phase 4 freezes it. The engine's resolve-then-validate design correctly neutralizes integer/decimal IP encodings and DNS-rebinding, so these two ranges are the remaining classes the list itself does not cover.

**Fix:** Add `::/128` and `100.64.0.0/10` to all three mirrors (audit §15.1 sub-step 2, audit §15.4, runbook §10) in one change, and add `TC-SSRF-UNSPECIFIED-V6-01` (AAAA `::` → denied) alongside TC-SSRF-MAPPED-V6-01.

### WR-04: Outbox event-type selection for a PENDING→DOWN first check is unspecified — alert-content compatibility is at risk

**File:** `docs/ARCHITECTURE-AUDIT.md:945-949` (§16.1 step 4), `docs/ARCHITECTURE-AUDIT.md:349` (§11 event types), cf. `docs/ARCHITECTURE-AUDIT.md:1055-1061` (§16.4), `docs/ARCHITECTURE-AUDIT.md:133` (§3 current alert behavior)

**Issue:** §11 declares exactly three event types; §16.1 step 4 inserts `$eventType` without a dispatch table. TC-FIRST-CHECK-DEDUP-01 pins only the PENDING→**UP** case ("a PENDING→UP first check opens no incident"). For a monitor whose very first check is DOWN (the 1-strike DOWN invariant applies from check one), the doc never says whether the transaction emits `monitor.first_check`, `incident.down`, or both. Current behavior (§3): PENDING→DOWN sends one message — "ALERT: Website Down" — and no "MONITORING STARTED". If the implementation emits both rows, users get two Telegram messages where today they get one (alert-content incompatibility); if it emits only `incident.down`, then "MONITORING STARTED" semantics for later-recovering monitors need an explicit statement (today a first-UP-after-never-being-up still gets MONITORING STARTED). Telegram alert content is a named behavior-compat invariant; this dispatch cell is missing.

**Fix:** Add the dispatch table to §16.1 step 4: PENDING→UP ⇒ `monitor.first_check` only; PENDING→DOWN ⇒ `incident.down` only (matching today's single "ALERT: Website Down" message, no start message); UP→DOWN ⇒ `incident.down`; DOWN→UP ⇒ `incident.recovered`. Mirror in §16.4 and add the PENDING→DOWN case to the §23 test battery.

### WR-05: New-engine classification never restates the UP ⇔ 200–399 rule; redirect-cap-exceeded is mislabeled `ssrf_blocked`; plain-status DOWN has no `error_class` slot

**File:** `docs/ARCHITECTURE-AUDIT.md:828-830` (§15.1 step 4 sub-steps 4–5, step 5), cf. `docs/ARCHITECTURE-AUDIT.md:132` (§3 "UP ⇔ status 200–399"), `docs/ARCHITECTURE-AUDIT.md:390` (§11 `error_class` vocabulary)

**Issue:** Three unpinned classification details, each a behavior-compat or taxonomy hazard for a spec meant to be transcribed without interpretation:

1. §3 records the current rule "UP ⇔ status 200–399", but §15.1's classify step never restates the UP status range for the new engine. An implementer would plausibly ship the industry-default 2xx-only-UP, silently changing semantics for every monitor whose final response is a 3xx.
2. §15.1 sub-step 4 classifies "exceeding the [5-hop redirect] cap → DOWN with `error_class = 'ssrf_blocked'`". A legitimate site with a 6-hop chain is not an SSRF block; the current engine follows up to ~20 hops (fetch `redirect: "follow"`) and would report UP — this is both a behavior change and an error-taxonomy lie that pollutes any future `ssrf_blocked`-driven security reporting.
3. The `error_class` vocabulary (`timeout|dns|tls|ssrf_blocked|http_5xx|network`) has no slot for a plain HTTP-status DOWN such as a 404 (4xx): `http_5xx` is wrong, `network` is wrong; whether `error_class` stays NULL for those (with `status_code` carrying the truth) is never stated.

**Fix:** In §15.1 step 5: pin "UP ⇔ final HTTP status 200–399 (unchanged from current behavior)"; classify redirect-cap-exceeded as DOWN with a distinct label (e.g. `error_class = 'network'` with a note, or add `too_many_redirects` to the §11 vocabulary); state that HTTP-status-level DOWNs carry `error_class = NULL` with `status_code` populated (or add `http_error`). Add TC cases for a 3xx-final-status monitor (UP) and a 404 (DOWN, `status_code=404`).

## Info

### IN-01: §16.2 zero-tuple edge — staging that vanishes between step 0 and step 1 yields an invalid `INSERT … VALUES ()`

**File:** `docs/ARCHITECTURE-AUDIT.md:962-994` (§16.2 steps 0–1)

**Issue:** Step 0's missing-key handling covers "neither live nor staging exists *at step 0*." In the narrow window where a redelivered flush passes the guard pre-check (staging exists, no guard row) and a completing sibling then DELs the staging keys before this run's step-1 `HGETALL`/`LRANGE`, the multi-row INSERT is built from zero tuples — a SQL syntax error (`VALUES ;`) that burns all 5 attempts into the DLQ. No corruption (the guard in the sibling's transaction exits this run before the INSERT executes in the normal ordering), but the spec should pin the short-circuit explicitly given its transcribe-literally contract.

**Fix:** One sentence in step 1: "If the staged list/hash reads empty, complete successfully without executing the INSERT (zero-tuple short-circuit) and proceed to step 2."

### IN-02: `agg:pending` is an orphan key and the flush fan-out's monitor-enumeration source is unspecified (confirms RR2-01)

**File:** `docs/ARCHITECTURE-AUDIT.md:575` (§13.1), `docs/ARCHITECTURE-AUDIT.md:1019` (§16.2 batchId rationale)

**Issue:** §13.1 lists `agg:pending` (set of monitor ids with unflushed deltas) but no writer or reader is specified anywhere; conversely §16.2 says "the `flush-pass` scheduler creates one job per monitor per pass" without saying which monitors (all active? members of `agg:pending`?) or what mechanism fans one scheduler job out into per-monitor jobs. These two gaps are each other's answer: either delete `agg:pending` and enumerate active monitors (no-op completions for empty ones), or make `agg:pending` the enumeration source and specify its maintenance (SMEMBER on flush enqueue, SREM-equivalent via the snapshot rename). Must be pinned at Phase 4; recorded here as advisory consistent with RR2-01's disposition.

**Fix:** Pick one enumeration design and wire §13.1's key row and §16.2's fan-out description to it.

### IN-03: Runbook §10 carries no firewall commands despite audit §15.4's "commands belong to the runbook" split, and does not verify reboot persistence

**File:** `docs/DEPLOY-RUNBOOK.md:175-178` (§10 step 1), cf. `docs/ARCHITECTURE-AUDIT.md:871` (§15.4 "no shell commands live here (D-01 scope split: commands belong to the runbook)")

**Issue:** Audit §15.4 assigns the concrete commands to the runbook; runbook §10's action is descriptive ("apply and persist outbound firewall rules that …"), leaving tool choice (ufw/nftables/iptables), rule ordering (deny-before-allow), and persistence method to the mid-deploy operator — for a section the runbook says is followed "without reading any other document first." The action demands "make the rules survive a reboot" but the verification never tests it.

**Fix:** Add the concrete command sequence for the chosen tool (or a named provisioning script in the repo), and add a verification item confirming persistence (e.g., rules present after a reboot, or `iptables-persistent`/`nft -f` service check).

### IN-04: "The dedicated smoke-test monitor" has no creation or ownership step anywhere

**File:** `docs/DEPLOY-RUNBOOK.md:99` (§4 step 6), `docs/DEPLOY-RUNBOOK.md:140` (§6)

**Issue:** The smoke check depends on a pre-existing dedicated monitor ("known-good target"), but no step in either document creates it, owns it, or says which user/account it belongs to (relevant once feedback/admin gating and ownership checks exist). First Phase 4 operator discovers the dependency at step 6.

**Fix:** One line in §4 step 6 (or a §6 preamble): the smoke monitor is created once at Phase 4 provisioning (owner, URL, interval), and how it is excluded from user-facing aggregates if desired.

### IN-05: ARCHITECTURE-REVIEW.md gate-artifact state — §4 header and §9 checkboxes read as open under a READY verdict

**File:** `docs/ARCHITECTURE-REVIEW.md:84` (§4 "BLOCKING ISSUES — must be resolved…"), `docs/ARCHITECTURE-REVIEW.md:307-331` (§9 checklist, all boxes unchecked)

**Issue:** The verdict is READY and the Re-review section records 25/25 traced, but §9 renders 25 unchecked `- [ ]` boxes and §4's header still demands resolution — preserved-record intent (D-16) is clear in prose, but any reader or tooling consuming checkbox/header state concludes the gate failed. Gate documents should be self-consistent under mechanical reading.

**Fix:** Keep the original text verbatim per D-16 but annotate: a resolution banner atop §4 ("all issues below are resolved — see Re-review section") and a note at §9 ("all 25 items verified closed at cycle 2; boxes left unchecked to preserve the 2026-09-08 record") — or tick the boxes with a dated marker.

### IN-06: §12 Better Auth mapping omits trusted-origins/CSRF and auth-endpoint rate-limit decisions

**File:** `docs/ARCHITECTURE-AUDIT.md:434-460` (§12), cf. `docs/ARCHITECTURE-AUDIT.md:457` (env renames only)

**Issue:** §12 pins hashing, sessions, table mapping, and the admin plugin, but never mentions `trustedOrigins` (cookie-based auth makes origin checking the CSRF boundary), Better Auth's built-in rate-limit configuration (the current register route's 5/IP/hour limiter must have a stated successor), or secret-size/generation guidance for `BETTER_AUTH_SECRET`. Better Auth's defaults are safe, and Phase 7 research exists — but the repo carries `better-auth-security-best-practices` as a project skill, and the design-gate standard applied elsewhere in these documents would state the defaults are being relied upon.

**Fix:** Add to §12: pin `trustedOrigins` (production origin only), state whether Better Auth default rate limits are accepted or tuned for register/login/forgot, and reference the security skill checklist for Phase 7.

### IN-07: §16.3 relay holds the DB transaction open across up to 100 external enqueues — interplay with `idle_in_transaction_session_timeout` unstated

**File:** `docs/ARCHITECTURE-AUDIT.md:1029-1049` (§16.3), cf. `docs/ARCHITECTURE-AUDIT.md:1364` (§25.2 `idle_in_transaction_session_timeout` 30000)

**Issue:** The relay selects up to 100 rows `FOR UPDATE SKIP LOCKED`, then enqueues one BullMQ job per row (network I/O) before COMMIT — the standard queue-table pattern, but the worker pool also pins `idle_in_transaction_session_timeout: 30000`. A relay pass whose enqueue phase stalls >30 s between statements is killed mid-transaction after some jobs were enqueued; rows stay unsent and re-select next pass, producing duplicate alert jobs (collapsed by §16.4 dedup, which is written only after a confirmed send — so containment holds). Behavior is at-least-once and documented, but the timeout interplay and the expectation (each relay pass should stay well under 30 s; a kill is recoverable, not an incident) deserve one sentence so a Phase 5 operator seeing relay-kill logs doesn't misdiagnose.

**Fix:** Add to §16.3: "Each relay pass must complete its enqueue phase well inside the worker's 30 s `idle_in_transaction_session_timeout`; a pass killed mid-flight is recoverable — enqueued-but-unmarked rows are re-selected and their duplicate alert jobs collapsed by §16.4 dedup."

---

_Reviewed: 2026-09-09T17:17:11Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
