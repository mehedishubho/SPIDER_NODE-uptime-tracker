---
phase: 05-worker-cutover-operational-hardening
plan: 05
subsystem: worker
tags: [worker, cutover, gates, evidence, wrk-11, obs-05, verification, throwaway-tooling, d-14, d-41, d-27]
requires:
  - "05-03 /metrics exposition families spidernode_queue_depth / spidernode_queue_oldest_job_age_seconds (gate 2's parse targets, monitor-checks lane)"
  - "05-02 runbook §4a step 7 constants (120 s age bound, 4 h D-16 minimum) and the deploy-record evidence-append pattern"
  - "phase 03/04 schema ground truth: pings.\"createdAt\" naive UTC, outbox snake_case timestamptz + event_type trail, incidents_one_ongoing partial unique index"
  - "04-07 relay evidence shape (parity-evidence.json inputs) and the D-48 byte pins"
provides:
  - "scripts/gate-cutover.mjs — the D-14 typed 7-gate window evaluator (WRK-11's verification half): --offline-fixtures and live-DB modes over one canonical db-evidence shape, D-16 sub-4h pre-gate fail, evidence block appended to 05-DEPLOY-RECORD.md, and --capture-baseline (gate 4's window-open counters delta base)"
  - "scripts/check-cron-remnants.mjs — the D-41 cron-remnant gate: four finding classes (instrumentation.ts/js files, node-cron|instrumentation import specifiers, CRON_MODE tokens, package.json deps), --advisory (inert) until the 05-09 deletion release arms enforcement in pnpm verify"
  - "scripts/scrape-metrics.mjs — the D-27 throwaway window scraper: loopback /metrics polling into samples/sample-<n>.txt + summary.md, fail-loud after N consecutive failures, SIGINT/SIGTERM clean shutdown, entry-point main guard"
  - "the snapshot contract both 05-06 (rehearsal stand-ins) and 05-08 (live window) fill: DIR/samples/*.txt, recompute-report.json, parity-evidence.json, flips-heartbeat.json, legacy-observations.json, disposition.md, counters-baseline.json, db-evidence.json (offline stand-in only)"
affects:
  - "05-06 rehearsal invokes gate-cutover.mjs over stand-in snapshots and proves the snapshot contract end-to-end"
  - "05-08 live window: scrape-metrics at open + --capture-baseline, gate evaluation at close, evidence into the deploy record — WRK-11/OBS-05 proof"
  - "05-09 deletion release arms check-cron-remnants.mjs enforcement (verify-leg wiring + package.json dep removal happen THERE; this plan adds no package.json wiring)"
tech-stack:
  added: [] # zero new dependencies — plain ESM, node:* + already-installed pg (lazy) + global fetch only
  patterns:
    - "one canonical db-evidence shape consumed identically by online parameterized-pg queries and offline fixtures — fixture tests exercise the REAL gate comparison code paths"
    - "fail-toward-detection everywhere: -1 sentinel depth reads never count as a drain; missing/unreadable snapshot inputs become gate FAIL reasons, never crashes"
    - "evidence blocks carry UUIDs, counts, and verdicts only — keys and ping URLs never echoed (T-05-05-01)"
    - "entry-point main guard (import.meta.url vs resolved argv[1], win32 case-insensitive) so tooling modules import inert"
    - "fixture-testable scripts via explicit dir args (check-worker-boundary pattern) — no repo-path assumptions in tests"
key-files:
  created:
    - scripts/gate-cutover.mjs
    - scripts/check-cron-remnants.mjs
    - scripts/scrape-metrics.mjs
    - tests/worker/cutover-gates.test.ts
    - tests/worker/cron-remnant-gate.test.ts
  modified: [] # package.json / pnpm-lock.yaml deliberately untouched (prohibition 3)
decisions:
  - "05-05: counters-baseline.json mechanism — gate 4's D-02 total_count delta needs a window-open baseline (--capture-baseline); lifetime reconcile is polluted by retention and a post-hoc delta is impossible without it"
  - "05-05: gate 3 semantics — duplicate relay rows per incident event FAIL; zero-alert incidents (the cron-originated direct-send class that never writes outbox rows) and extraTransientAlerts are listed for DISPOSITION, not failed (D-05 verify+gate+disposition)"
  - "05-05: check-cron-remnants.mjs ships INERT (--advisory posture) — src/instrumentation.ts legitimately exists through the overlap window; wiring the verify leg + removing the deps belong to the 05-09 deletion release (D-01 no-CI precedent: pnpm verify IS the build gate)"
  - "05-05: gate-cutover degrades DB-backed gates to FAIL-with-reason on an unreachable DB (never a crash) and gate 1 without key/cache degrades to manual-evidence instructions (A1 fallback) — a partial verdict is still an honest verdict"
  - "05-05: WRK-11/OBS-05 deliberately stay Pending — the gate tooling is built and test-pinned, but each requirement's proof is the live >=4h window evidence that 05-08 captures (05-01/05-02 false-signal precedent)"
metrics:
  duration: "~20 min (single session)"
  completed: 2026-09-15
status: complete
---

# Phase 05 Plan 05: Cutover Gate + Remnant Gate + Window Scraper (WRK-11/OBS-05 tooling) Summary

**One-liner:** Three plain-ESM, zero-dependency repo scripts — the D-14 7-gate window evaluator (offline-fixture + live-DB modes over one canonical evidence shape, D-16 pre-gate clock rule, deploy-record evidence appends), the D-41 cron-remnant gate (advisory until the 05-09 deletion release arms it in pnpm verify), and the D-27 throwaway loopback /metrics scraper whose samples/*.txt output gate 2 parses — 23 fixture tests plus a live stub-server smoke proving the scraper->gate contract end-to-end (7/7 PASS over smoke output).

## What Was Built

### Task 1 — scripts/gate-cutover.mjs + tests/worker/cutover-gates.test.ts (commits fb8ea0e RED, 16e6592 GREEN)

The D-13 seven-gate checklist as one typed command. `--start/--end` integer epochs validated at entry (T-05-05-02); a sub-4h window fails BEFORE any gate runs with the D-16 clock-reset reason (interruption restarts the clock, never dispositioned away). Gates: 1 heartbeat steady via hc.io Management-API flips (check UUID = tail segment of WORKER_HC_PING_URL, X-Api-Key, cache file flips-heartbeat.json, zero down-flips in window, D-17); 2 queue health from the scraper samples (check-lane age <= 120 s at every sample + a depth-0 drain, -1 sentinel reads never a drain, D-19/WRK-12); 3 alert parity (D-48 byteMatch + exactly one relayed alert row per incident event via the outbox trail; zero-alert cron-class incidents listed for disposition, D-05); 4 BOTH counter gates (D-02 pings-vs-total_count delta from the window-open counters-baseline.json AND D-37 dry-run recompute drift — the clobber class carries self-consistent uptime_percent, so either leg alone is blind); 5 per-monitor continuity gap-scan (max LAG gap <= interval + 120 s tolerance); 6 zero duplicate ONGOING (defense in depth over the partial unique index); 7 every legacy-observations.json entry has a disposition.md line with id-at-delimiter matching (LO-1 never matches LO-10). Online mode runs parameterized pg queries (naive-UTC pings bounds via `to_timestamp($1) AT TIME ZONE 'utc'`, LAG window function joined to active monitors) behind a lazy `import("pg")`; offline mode reads db-evidence.json — the SAME shape the queries produce, so the fixture suite exercises the real comparisons. Unreachable DB degrades gates 3-6 to FAIL-with-reason while snapshot-driven gates still evaluate. The evidence block appends to 05-DEPLOY-RECORD.md (03-08/04 disposition pattern) carrying verdicts/counts/UUIDs only. 17 tests: green 7/7, one red per gate (plus sub-cases: out-of-window flips ignored, D-02 blind-spot with clean recompute, non-integer epochs, --help, evidence writer content, unreachable-DB degrade with no stack dump).

### Task 2 — scripts/check-cron-remnants.mjs + tests/worker/cron-remnant-gate.test.ts (commits 59f320b RED, 806229f GREEN)

The D-41 verify leg: four finding classes — instrumentation.ts/js file names, node-cron / `.../instrumentation` import specifiers (all four import forms, the check-worker-boundary extractor, comment lines skipped), CRON_MODE tokens in code, and node-cron/@types/node-cron in package.json. Default roots src/ + dist/worker.js + .next/server (each when present); docs/, .planning/, node_modules/, .git/, .snapshots/ are NEVER scanned even when nested inside a scanned root (historical prose legitimately names the tokens — proven by a fixture with a remnant .ts archived under docs/). Enforcement exits 1 listing findings; --advisory exits 0 — the pre-deletion posture, since src/instrumentation.ts legitimately exists until the 05-09 deletion release. Against today's real repo the advisory run lists exactly the expected baseline: the instrumentation entrypoint, its node-cron import, five CRON_MODE references, the .next build artifacts, and both dependency declarations — exit 0. 6 tests: violating fixture (all four classes listed), clean fixture, docs-exclusion fixture, advisory-on-violating, advisory-on-real-repo, --help.

### Task 3 — scripts/scrape-metrics.mjs (commit 6544f37)

The D-27 throwaway window scraper: polls the loopback /metrics (default `http://127.0.0.1:9090/metrics`, WORKER_HEALTH_PORT-aware, --url override) every --interval seconds (default 15), writing `samples/sample-<n>.txt` (a `# scraped_at <iso> (<epoch-ms>)` header line + the raw exposition) and a per-attempt summary.md under --out (default `.snapshots/gates-<run-timestamp>/`). Fail-loud: after --max-consecutive-failures (default 3) refused scrapes it exits 1 — a dead worker must never silently yield an empty evidence set. SIGINT/SIGTERM set a stop flag checked between scrapes and in the sleep loop; shutdown appends a final summary line and exits 0. Main guard: the loop starts only when the module is the entry point (import.meta.url vs pathToFileURL(resolved argv[1]), win32 case-insensitive) or --run is explicit — bare import() resolves exports and starts nothing (machine-verified). Verified live against a stub loopback HTTP server: two OK samples written with the exact layout, then the stub exits and the third/fourth/fifth refused scrapes trip the fail-loud bail-out (exit 1, ABORTED summary line, no partial sample files). Contract proof: gate-cutover over a fixture whose samples/ IS the smoke output returns VERDICT: PASS (7/7).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RED suites initially had vacuous/incorrect assertions**
- **Found during:** Tasks 1-2 RED/GREEN cycles
- **Issue:** (a) the non-integer-epochs case asserted on "--start", which a module-not-found stack trace also contains (vacuous pass); (b) the runGate helper returned empty stdout on the success path; (c) the evidence-record assertion chopped the final character off each gate-line pin.
- **Fix:** (a) assert on the word "integer" (a stack trace never says it) and make the script's usage error state the integer-epochs contract; (b) capture stdout/stderr from both resolve and reject paths; (c) assert the full `GATE n (name): PASS` string. All folded into the RED/GREEN commits.
- **Files modified:** tests/worker/cutover-gates.test.ts, scripts/gate-cutover.mjs
- **Commits:** fb8ea0e, 16e6592

**2. [Rule 1 - Bug] Gate 7 id matcher could cross-match LO-1 against LO-10**
- **Found during:** Task 1 GREEN
- **Issue:** The suffix test regex could match a shorter id inside a longer id's disposition line.
- **Fix:** Delimiter check — the line must start with the id and the remainder must be empty or start with whitespace/colon.
- **Files modified:** scripts/gate-cutover.mjs
- **Commit:** 16e6592

**3. [Rule 1 - Bug] Test 11 polluted the real deploy record via the default --record path**
- **Found during:** Task 1 GREEN (test run left a stray 05-DEPLOY-RECORD.md)
- **Issue:** The online-degrade test ran without an explicit --record, so the script's default appended evidence into the repo's .planning tree.
- **Fix:** The test passes an explicit tmp --record; the script also never appends to the default record in offline mode unless --record is explicit; the polluted file was deleted.
- **Files modified:** tests/worker/cutover-gates.test.ts
- **Commit:** 16e6592

**4. [Rule 3 - Blocking] Sub-4h verdict printed to stderr while the test read stdout**
- **Found during:** Task 1 GREEN
- **Issue:** The window-too-short D-16 verdict is a verdict, not a crash — the test asserted it on stdout.
- **Fix:** The verdict + D-16 reason go to stdout (console.log); only the aborted-window evidence note stays on stderr.
- **Files modified:** scripts/gate-cutover.mjs
- **Commit:** 16e6592

**5. [Rule 1 - Bug] Remnant gate's fixture package.json lookup could pick an unrelated parent manifest**
- **Found during:** Task 2 implementation
- **Issue:** The initial `[targets[0]/package.json, targets[0]/../package.json].find(...)` chain could resolve a fixture's parent dir manifest.
- **Fix:** Only `targets[0]/package.json` — a fixture without a manifest simply has nothing to check (checks 1-3 prove in isolation).
- **Files modified:** scripts/check-cron-remnants.mjs
- **Commit:** 806229f

Otherwise the plan executed exactly as written. Prohibition 3 verified: `git diff` confirms package.json and pnpm-lock.yaml untouched by every plan commit.

## Verification Evidence

- `pnpm exec vitest run tests/worker/cutover-gates.test.ts tests/worker/cron-remnant-gate.test.ts` — **23/23 green** (17 + 6)
- `node scripts/check-cron-remnants.mjs --advisory` — exit 0, listing the expected 7-finding pre-deletion baseline (instrumentation entrypoint, node-cron import, CRON_MODE x5, .next artifacts, both dep declarations)
- `pnpm typecheck` — 0 errors; `pnpm lint` — 0 errors, 55 pre-existing warnings (zero in plan files)
- scrape-metrics automated verify: bare `import()` exits 0 touching nothing (main guard), `--help` prints usage exit 0
- scrape-metrics live smoke (stub loopback server): 2 OK samples with the `# scraped_at` header + parseable exposition, per-attempt summary rows, fail-loud exit 1 after 3 consecutive refused scrapes, no partial sample files; gate-cutover over the smoke samples as gate-2 input returns **VERDICT: PASS (7/7)** — the scraper->gate contract proven end-to-end
- Smoke limitation (win32 only): msys `kill -INT` cannot deliver SIGINT to a native Windows process, so the clean-shutdown path was verified by code review + the loop/poll behavior (8 samples over 2.4 s); the 05-06 rehearsal on the Linux VPS exercises the real signal path
- pnpm verify belongs to the wave merge (this plan adds no verify legs — D-41 arming is 05-09's)

## TDD Gate Compliance

Both TDD tasks followed RED->GREEN with per-gate commits: Task 1 `test(05-05)` fb8ea0e (suite failed on the missing script) precedes `feat(05-05)` 16e6592 (17/17 green); Task 2 `test(05-05)` 59f320b precedes `feat(05-05)` 806229f (6/6 green). Task 3 is non-TDD by plan (verification via the automated bare-import/--help checks + live stub-server smoke, all green).

## Requirement Status

`WRK-11` and `OBS-05` (plan frontmatter) deliberately stay **Pending**: this plan lands the gate/scraper tooling and its tests, but each requirement's proof is the live >=4h window evidence — the 7/7 gate verdict over the real overlap window captured by 05-08 (the 05-01/05-02 false-signal precedent: mark complete only when the consuming evidence exists). OBS-05's scraper leg now exists end-to-end (exposition -> scraper -> gate 2), with dashboards still deferred to the VPS era (D-28).

## Key Learnings

- Asserting on a substring that also appears in crash output makes RED vacuous — pin the one token a failure mode can never emit (e.g. "integer" from a usage error vs a module-not-found stack).
- A shared canonical evidence JSON lets fixture tests run the REAL comparison logic: online queries and offline fixtures differ only in the producer, never in the gate code.
- The D-02 counter reconcile cannot be reconstructed post-hoc — the baseline capture at window open IS the gate. Design evidence collection backward from the gate that consumes it.
- On win32, bash `kill -INT` never reaches native Node children; plan signal-path verification for operator tooling where it actually runs (the Linux VPS rehearsal).

## Threat Surface

No new surface beyond the plan's `<threat_model>`; all four register rows mitigated as planned — T-05-05-01 (evidence blocks carry UUIDs/counts/verdicts only; test 10 asserts no ping-URL/key substrings in the record), T-05-05-02 (integer-epoch validation at entry, parameterized pg queries throughout), T-05-05-03 (the 14400 s D-16 minimum is test-pinned before any gate runs), T-05-05-04 (scraper defaults to 127.0.0.1 loopback; Pitfall 5 note in the header).

## Self-Check: PASSED

- Files: scripts/gate-cutover.mjs, scripts/check-cron-remnants.mjs, scripts/scrape-metrics.mjs, tests/worker/cutover-gates.test.ts, tests/worker/cron-remnant-gate.test.ts — all created and present
- Commits: fb8ea0e, 16e6592, 59f320b, 806229f, 6544f37 — all in `git log`
- Zero tracked-file deletions across plan commits; no untracked artifacts left by this plan (smoke dirs were tmp-dir-only and removed; leftover stub servers killed by port)
