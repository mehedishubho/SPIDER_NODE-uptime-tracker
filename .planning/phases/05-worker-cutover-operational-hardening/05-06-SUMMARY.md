---
phase: 05-worker-cutover-operational-hardening
plan: 06
subsystem: worker
tags: [worker, cutover, rehearsal, d-30, d-33, wrk-13, oq2, d-49, d-11, d-48, d-34, d-16, throwaway-tooling, test-net-3]
requires:
  - "05-05 gate-cutover.mjs (--capture-baseline, 7-gate evaluation, --start/--end epochs, --snapshots/--record/--db) and scrape-metrics.mjs (gate-2 samples layout)"
  - "runbook §4a steps 4-11 (docs/DEPLOY-RUNBOOK.md) — the choreography being rehearsed, incl. the D-49 re-seed UPDATE and the step-6 abort drill"
  - "03-05 anonymize-snapshot.mjs output (the --dump input) and the 03-03/03-05 throwaway-port discipline (5460/6460 lineage; never 5453/5454/6390/6391)"
  - "04-09 worker container-bundle machinery (skipNodeModulesBundle:false + noExternal:[/.*/], pg-native external) and the 04-02/04-07 job-id + relay contracts"
  - "src/worker/scheduler.ts pause/ACTIVE boot markers and src/worker/queues.ts MAINTENANCE_JOB_OPTIONS / enqueueManualCheck"
provides:
  - "scripts/rehearse-cutover.mjs — the D-30/D-33 leg-addressable cutover rehearsal: 10 legs + an 'all' sequence driving runbook §4a steps 4-8 on a throwaway anonymized-snapshot stand-in (docker TEST-NET-3 sibling containers + loopback-published PG/Redis + host web), with the egress sweep guard re-asserted before every leg and a 05-REHEARSAL-EVIDENCE-layout evidence writer"
  - "scripts/enqueue-maintenance.mjs — the OQ2/D-12/WRK-13 one-shot maintenance enqueue: dry-run default, --apply for real retention, --wait polls to the job's REPORT, production-port refusal (T-05-06-04)"
  - "scripts/seed-synthetic.sql corrected to status PENDING (04-REVIEW IN-01) so an UP smoke check derives monitor.first_check and the relay path stays exercised end-to-end"
  - "the induced-parity determinism recipe 05-07 reuses: interval 1440 + fresh lastChecked/next_check_at starves BOTH engines, manual enqueue is the sole check driver (Pitfall 2 race avoided), DOWN/RECOVERED flips via a controllable target"
affects:
  - "05-07 executes this rehearsal against the add-release SHA and transcribes the evidence file into 05-REHEARSAL-EVIDENCE.md (WRK-11/DEP-03 proof legs)"
  - "05-08 live window reuses the corun/gates leg patterns (baseline capture at open, snapshot inputs, disposition form letter) against production"
  - "the Linux VPS rehearsal (05-07 context) is where the win32 kill -INT limitation gets exercised live (here the web child is SIGKILLed + port-probe-verified, documented in-code)"
tech-stack:
  added: [] # zero new dependencies — node:* + already-installed pg + global fetch + docker CLI; no package.json/lockfile changes (prohibition)
  patterns:
    - "explicit-env discipline: every spawned command receives buildStandInEnv() — present-but-empty pins beat file-loaded values (loaders never override existing keys); no file-based env loading anywhere in the script"
    - "self-reference-proof source scans: self-test builds its scan tokens at runtime (wildcard bind literal, dotenv token) so the checks cannot match their own expressions"
    - "guard re-assertion before EVERY leg (runSweepGuard) — a leg can never run past a tripped prohibition, in 'all' mode or standalone"
    - "soft teardown on 'all' failure: stop the port-holding web child, LEAVE containers for diagnosis + leg re-entry; --leg teardown does the full cleanup once diagnosis is done"
    - "fail-loud bounded waits everywhere (waitFor) — every readiness/window/relay wait has a deadline and names its last observation"
    - "evidence hygiene: counts/verdicts/ids only; forbiddenPortIn returns the port token, never the URL; explicit --record paths inside the snapshot dir, never the default deploy record"
key-files:
  created:
    - scripts/rehearse-cutover.mjs
    - scripts/enqueue-maintenance.mjs
  modified:
    - scripts/seed-synthetic.sql
decisions:
  - "05-06: the plan's 'named manual-maintenance' job is realized as jobId manual-maintenance:<mode>:<epoch-ms> with name 'cleanup' — processMaintenanceJob throws on any other name, so the NAME is the processor's dispatch contract and the jobId carries the manual marker (exactly 3 colon segments: a 2-segment id throws 'Custom Id cannot contain :', caught live on a throwaway Redis)"
  - "05-06: induced-parity target = TEST-NET-3 sibling containers (203.0.113.0/24, RFC 5737) — the production SSRF denylist blocks every loopback/private target, so a loopback target is DOWN-only (ssrf_blocked) and can never produce the UP leg; 05-CONTEXT D-11 leaves the target form to execution"
  - "05-06: monitor creation via INSERT mirroring the /api/monitors route's exact data shape — the HTTP route requires a NextAuth session the anonymized stand-in cannot mint"
  - "05-06: gates run TWO passes — pass A with TRUE rehearsal bounds asserts the sub-4h D-16 refusal (the clock rule is part of what is rehearsed); pass B with extended bounds (>= 4h + 600s pad, end = now at gates time so induce/drill pings stay inside for gate 4) runs ONLINE against the throwaway DB — strictly more real than the plan's --offline-fixtures mode, whose comparison contract 05-05's 23 tests already pin; gate 5 may FAIL only with /continuity unmeasurable/ sparse-monitor reasons"
  - "05-06: drill auto-resume proven via the §9 curl lever (GET /api/cron/check with Bearer) which runs due checks AND flushes in-request — legacy cron's 15-min batcher makes raw ping-count polling lag; the natural 1-min internal-cron pass is observational only"
  - "05-06: induce determinism — interval 1440 + fresh lastChecked/next_check_at starves BOTH engines so the manual enqueue is the only check driver; the DOWN/RECOVERED pair can never be raced by cron (Pitfall 2)"
  - "05-06: synthetic flips-heartbeat.json fixture labeled as such — provisioning the real healthchecks.io checks is runbook §4a step 5's live leg (05-08's window, D-17); gate 1 machinery is what the rehearsal exercises"
  - "05-06: WRK-11/DEP-03 deliberately stay Pending — the choreography is encoded and self-tested, but the proof is 05-07 executing the rehearsal + 05-08's live window evidence (05-01/05-02/05-05 false-signal precedent)"
metrics:
  duration: "1998s (~33 min; single logical session across one compaction)"
  completed: 2026-09-16
status: complete
---

# Phase 05 Plan 06: Cutover Rehearsal Choreography (D-30/D-33) Summary

**One-liner:** Two plain-ESM zero-dependency scripts — a leg-addressable rehearsal driver (10 legs + `all`) that stages runbook §4a steps 4-8 on a throwaway anonymized-snapshot stand-in (TEST-NET-3 docker sibling containers, egress sweep guard re-asserted before every leg, D-49 re-seed string-compared against the runbook, induced DOWN/RECOVERED parity with D-48 byteMatch + one FAILED relay attempt per event, two-pass gate evaluation incl. the expected D-16 refusal, abort drill via the §9 cron lever) — plus a one-shot maintenance enqueue whose jobId/name/options contract was proven live against a throwaway Redis, and the IN-01 seed fix that makes an UP smoke derive `monitor.first_check`.

## What Was Built

### Task 1 — scripts/rehearse-cutover.mjs (commit 8cdd5ba; lint cleanup 2707030)

The D-30/D-33 choreography as one re-enterable script. Header documents usage, the leg list, the stand-in topology, the induced-parity target form, and the egress posture. Legs:

- **rebuild** — zero-new-migrations assertion (D-44, journal vs on-disk vs git-tracked + clean `drizzle/` status), `pnpm build` under the stand-in env, dist-staleness assert vs newest `src/**/*.ts(x)` mtime (D-31), build SHA + dist sha256 + .next BUILD_ID recorded to state.
- **restore** — refuses orphaned container names / occupied ports / non-docker listeners (probes 5460/6460/3460), `assertSiblingStackIsolation()` over every stand-in URL, docker network `spidernode-rehearse-net` (subnet 203.0.113.0/24) with pinned container IPs, postgres:17-alpine (pub 127.0.0.1:5460) + redis:8-alpine (pub 127.0.0.1:6460), 2-consecutive pg_isready (Docker Desktop first-accept quirk), dump via docker cp + `pg_restore --no-owner --no-privileges`, row counts (users/monitors/pings/incidents/outbox) + monitors md5 checksum + drizzle journal observation, snapshot dir created.
- **sweep** — `runSweepGuard()` recorded green: dummy token, empty channel pins, telemetry off.
- **reseed** — extracts the D-49 block from docs/DEPLOY-RUNBOOK.md between the `-- D-49 re-seed` marker and `WHERE "isActive";`, whitespace-normalized string-compare against the encoded `RESEED_SQL` (byte-equal semantics), executes the UPDATE, asserts rowCount == active-monitor count.
- **unpause** — worker container bundle via a temporary tsup config (04-09 machinery: `skipNodeModulesBundle:false` + `noExternal:[/.*/]`, pg-native external, WORKER_BUILD_SHA/TS define-injected); target container (plain-node driver binding its explicit container IP, `/probe` 200|503 + `/__flip?state=` lever); worker container with `WORKER_SCHEDULER_ENABLED=true`, readyz via docker exec, boot log MUST contain "recurring scheduling ACTIVE" (Pitfall 4); web child (`next start -p 3460`) with throwaway CRON_SECRET, readiness = cron route answers 401; windowStart recorded. The four-schedulers-at-once note is encoded in the leg state.
- **corun** — gate-cutover `--capture-baseline` at window open (gate 4's delta base); scrape-metrics docker-cp'd INTO the worker container and run `docker exec -d` (the health server binds in-container loopback only — no env seam), samples docker-cp'd out to `snapDir/samples/` (gate-2 contract), per-minute liveness asserts (worker Running, web alive, /metrics.json breaker snapshots appended), sample-count floor assert, pings-created count, cron-originated incidents (startedAt in window, no outbox rows) → `legacy-observations.json`; windowEnd recorded.
- **induce** — owner = first user with non-null telegramChatId; INSERT mirroring the /api/monitors create data shape with interval 1440 + fresh lastChecked/next_check_at (starves BOTH engines — manual enqueue is the sole driver); UP (PENDING→UP derives `monitor.first_check`) → DOWN (1-strike incident) → RECOVERED flips with waitForCheck; relay-wait until every row has attempts >= 1; `evaluateByteMatch` proves the D-48 8-key payload shape (excluding `_relayFailure`), exactly one row per event, down/recovered share incident_id, attempts===1 + `_relayFailure` present on every row (D-34 FAILED under the dummy token); `parity-evidence.json` written.
- **maintenance** — enqueue-maintenance.mjs `--wait 300`; final `REPORT <json>` line parsed, audit → `recompute-report.json` (gate 4 D-37 input).
- **gates** — two passes (see decision 4): pass A true bounds asserting the D-16 refusal (exit 1 + "shorter than" + "D-16"); pass B extended bounds ONLINE with `--db`, verdict parser asserting 7 gate lines, gates 1-4/6/7 must PASS, gate 5 allowed FAIL only on `/continuity unmeasurable/` sparse-monitor reasons; synthetic labeled `flips-heartbeat.json`; rehearsal form-letter `disposition.md` per LO; explicit `--record` paths inside snapDir (never the default deploy record).
- **drill** — re-pause via container recreate (flag=false; boot-read semantics) asserting "scheduler flag OFF" and NO ACTIVE marker; §9 lever fetch (Bearer throwaway secret) runs due checks + in-request flush → pings must increase (due-filter zero-gap auto-resume, D-16); 90s natural-pass observation; re-unpause into a fresh window asserting ACTIVE.
- **teardown** — evidence file (the 05-REHEARSAL-EVIDENCE layout: counts/verdicts/ids only), web child killed + port freed (win32 taskkill fallback), all four containers + network removed, work dir + state file removed, snapshot dir kept.

`all` runs the 10-leg sequence with the sweep guard re-asserted before EVERY leg, PASS → full teardown, failure → SOFT teardown (web child stopped, containers left for diagnosis with a `--leg teardown` hint). Standalone legs load their own state and reap their own web child at process exit (top-level finally). `--self-test` runs 5 guard checks without docker; `--help` prints the legs.

### Task 2 — scripts/enqueue-maintenance.mjs (commit 1df337f)

One-shot enqueue through the REAL lane: bullmq `Queue` constructed directly on the workerConnection profile (maxRetriesPerRequest:null, enableReadyCheck — src/worker/connection.ts). Job contract cross-checked against queues.ts/maintenance.ts and proven LIVE on a throwaway Redis: lane `maintenance`, name `cleanup` (the processor throws otherwise), data `{dryRun}`, jobId `manual-maintenance:<mode>:<epoch-ms>` (exactly 3 colon segments — BullMQ 6 rejects other shapes; the header documents the live-caught rejection), options mirroring MAINTENANCE_JOB_OPTIONS verbatim (priority 5, attempts 5, exponential backoff 5000ms, removeOnComplete age 86400, removeOnFail age 604800). Dry-run is the DEFAULT (zero writes); `--apply` is warned in the header (real retention deletes); `--wait [seconds]` polls to completion printing the job's `REPORT <json>` (the MaintenanceReport whose audit feeds gate 4) and fails loud on job failure or budget exhaustion; refuses Redis URLs matching :6391/:5454 without explicit `--allow-prod` (T-05-06-04); never prints connection strings.

### Task 3 — scripts/seed-synthetic.sql (commit cec0bf8)

Seed status 'UNKNOWN' → 'PENDING' (04-REVIEW IN-01): deriveEventType maps PENDING→UP to `monitor.first_check`, so an UP smoke check now produces exactly one outbox row (no-chat skip path — relay exercised end-to-end, human never paged) instead of NO event; a DOWN smoke still exercises the full alert render. Header comment rewritten to document the derivation and the IN-01 rationale. 8 insertions / 4 deletions, nothing else touched.

## Deviations from Plan

### Auto-fixed / resolved inline

**1. [Rule 3 - Blocking] Maintenance job name contract**
- **Found during:** Task 2 implementation (cross-checking processMaintenanceJob).
- **Issue:** Plan specified a job "named manual-maintenance"; processMaintenanceJob THROWS on any name but "cleanup" — the name is the processor's dispatch contract.
- **Fix:** Name "cleanup"; the manual marker realized as jobId `manual-maintenance:<mode>:<epoch-ms>` (reads in Bull Board). Documented in the script header.
- **Commit:** 1df337f

**2. [Rule 1 - Bug] BullMQ jobId colon-segment count**
- **Found during:** Task 2 live smoke on a throwaway Redis (docker redis:8-alpine, not a sibling stack).
- **Issue:** The 2-segment `manual-maintenance:<epoch>` form threw "Custom Id cannot contain :" — bullmq 6.3.4 requires EXACTLY 3 colon segments (the 04-02 lesson generalized).
- **Fix:** `manual-maintenance:<mode>:<epoch-ms>`; re-smoked green (job hash present with name/data/opts proving the full contract; the hmget evidence captured). Header documents the rule.
- **Commit:** 1df337f (Rule 1 noted in the commit message)

**3. [Rule 3 - Blocking] Induced-parity target form (SSRF denylist)**
- **Found during:** Task 1 design (target reachability analysis).
- **Issue:** The production check engine's SSRF denylist (src/lib/ssrf.ts) blocks ALL loopback/private targets, so a loopback target can only classify ssrf_blocked (DOWN-only) — the UP leg of the DOWN/RECOVERED pair is impossible; tests/lib/helpers/check-target-server.ts also hardcodes loopback binds (unusable cross-container).
- **Fix:** Worker + a minimal plain-node controllable-target driver run as sibling containers on a user-defined docker network in TEST-NET-3 (203.0.113.0/24, RFC 5737 documentation space): outside the denylist, unreachable from host/LAN, no real host can occupy it, literal-IP URLs skip DNS. 05-CONTEXT D-11 leaves the target form to execution. Documented in the script header + evidence file.
- **Commit:** 8cdd5ba

**4. [Rule 3 - Blocking] Monitor creation path**
- **Issue:** /api/monitors requires a NextAuth session the anonymized stand-in cannot mint.
- **Fix:** INSERT mirroring the route's exact data shape (url/name/status/isActive/interval/userId/timestamps/lastChecked/next_check_at/counters), documented as a deviation in-script and in the evidence file.
- **Commit:** 8cdd5ba

**5. [Deviation - design] Gates two-pass online mode (replaces the plan's --offline-fixtures)**
- **Issue:** The 45-min rehearsal window is sub-4h — gate-cutover's D-16 clock rule refuses it before any gate evaluates; the plan's offline-fixture mode would also skip the live DB the rehearsal uniquely has.
- **Fix:** Pass A with TRUE bounds asserts the refusal ITSELF (exit 1 + reason match — the clock rule is part of what is rehearsed); pass B with extended bounds (4h + 600s pad; end = now at gates time so induce/drill pings stay inside the window for gate 4's delta reconcile) runs ONLINE against the throwaway DB. The offline comparison contract remains pinned by 05-05's 23 tests. Gate 5 sparse-monitor allowance restricted to `/continuity unmeasurable/` reasons only.
- **Commit:** 8cdd5ba

**6. [Rule 3 - Blocking] Drill auto-resume proof mechanism**
- **Issue:** Legacy cron batches ping writes (db-batcher flush cadence), so raw ping-count polling after the lever could lag and false-fail the drill.
- **Fix:** The §9 curl lever (GET /api/cron/check with Bearer CRON_SECRET) runs due checks AND flushes in-request — the pings-increase assert is immediate; the natural 1-min internal-cron pass is observational only (90s window).
- **Commit:** 8cdd5ba

**7. [Rule 1 - Bug] Self-test self-reference false-positives**
- **Issue:** The source-scan checks ("no wildcard bind literal", "no file-based env loader") matched their own scan expressions.
- **Fix:** Scan tokens built at runtime (`["0",".","0",".","0",".","0"].join("")`, `["dot","env"].join("")`) — the source never contains the literals. Self-test now 5/5.
- **Commit:** 8cdd5ba

**8. [Rule 1 - Bug] Lint warnings in the plan file**
- **Issue:** 4 `no-unused-vars` warnings surfaced on post-write review (unused destructure, stale eslint-disable in the driver template string, unused legDrill/runLeg params).
- **Fix:** All removed; plan files now lint-clean (0 errors, 0 warnings) matching the 05-05 precedent; self-test re-verified 5/5.
- **Commit:** 2707030

## Verification Evidence

- `node --check` green on both new scripts.
- `--help` prints the full leg list + usage for rehearse-cutover.mjs; usage + flag docs for enqueue-maintenance.mjs.
- `--self-test`: 5/5 checks green, exit 0 — sweep refuses a real-looking TELEGRAM_BOT_TOKEN naming the channel; sweep refuses the production Redis URL (port 6391); clean stand-in env passes; no wildcard bind literal in source (D-45); no file-based env loading.
- `grep -c "'PENDING'" scripts/seed-synthetic.sql` == 1; `'UNKNOWN'` == 0.
- Prohibition greps: no `0.0.0.0` bind literal and no dotenv loader reference in either script (self-test scans + manual grep).
- Prohibition diff: `git diff --name-only 75b5dc2..HEAD` == exactly the three plan files; no `drizzle/`, no `package.json`/`pnpm-lock.yaml`, no deletions in any plan commit.
- Live enqueue smoke (throwaway Redis, no sibling stacks touched): `JOB` line printed with jobId `manual-maintenance:dryrun:<epoch>` / lane maintenance / name cleanup / dryRun true / priority 5; redis hmget of the job hash proved name=cleanup, data={"dryRun":true}, opts = priority 5, attempts 5, exponential backoff 5000, removeOnComplete 86400, removeOnFail 604800 (MAINTENANCE_JOB_OPTIONS verbatim); `--wait` on the consumer-less throwaway timed out fail-loud exit 1 as designed.
- `pnpm lint`: 0 errors, 0 warnings in plan files (59 pre-existing warnings elsewhere, out of scope per the scope boundary).

## Requirement Status

- **WRK-11 / DEP-03 deliberately stay Pending.** This plan encodes and self-tests the choreography; the proof is 05-07 executing the rehearsal against the add-release SHA + 05-08's live window evidence (05-01/05-02/05-05 false-signal precedent — never mark a requirement complete on its inputs alone). `requirements.mark-complete` was NOT run.
- The plan frontmatter carries no `requirements:` array of its own to mark.

## Live-Run Note (encoded vs executed)

The rehearsal script is fully encoded and self-tested, but its full live docker run belongs to 05-07 (per the plan's own division: 05-06 delivers the choreography, 05-07 executes it against the add-release SHA and transcribes the evidence into 05-REHEARSAL-EVIDENCE.md). This plan's automated verifies are the --help/self-test/grep/smoke set above — all green. This is the plan's intended shape, not a stub.

## Threat Surface

All four register rows mitigated as planned; no new surface beyond the plan's threat model:

| Register row | Mitigation shipped |
|---|---|
| T-05-06-01 (real egress channels) | buildStandInEnv() empty-pins + dummy token; sweepEgressChannels(); runSweepGuard() re-asserted before EVERY leg; self-test checks 1-3 |
| T-05-06-02 (wildcard binds) | explicit binds only (container IPs / 127.0.0.1 publishes); self-test source scan |
| T-05-06-03 (secrets in evidence) | evidence carries counts/verdicts/ids only; forbiddenPortIn returns the port token, never the URL; throwaway credentials by construction |
| T-05-06-04 (sibling stacks) | FORBIDDEN_PORT_TOKENS sweep on DATABASE_URL/REDIS_URL; assertSiblingStackIsolation() over every stand-in URL; enqueue-maintenance port refusal (--allow-prod escape hatch) |

## Self-Check: PASSED

All 4 files verified present on disk; all 4 commits (8cdd5ba, 1df337f, cec0bf8, 2707030) verified in git log.

