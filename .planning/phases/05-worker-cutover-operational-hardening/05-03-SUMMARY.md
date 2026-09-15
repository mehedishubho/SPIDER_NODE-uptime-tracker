---
phase: 05-worker-cutover-operational-hardening
plan: 03
subsystem: worker
tags: [worker, observability, prometheus, metrics, obs-05, health-server]
requires:
  - "05-01 collectOutboxMetrics().oldestUnsentSeconds (outbox-age gauge input)"
  - "05-01 redisMemorySnapshot export from src/worker/health.ts (memory gauge input)"
  - "04-02 collectQueueMetrics queue gauge collector (per-lane depth/age/stalls)"
  - "05-01/04-08 breaker state export (breakerState) and never-fail-the-surface health-handler pattern"
provides:
  - "GET /metrics on the worker's existing loopback :9090 server: Prometheus text exposition (registry contentType) with the ten spidernode_ families — the stable contract 05-05's scraper and gate 2 parse"
  - "src/worker/metrics.ts createMetricsRegistry({ queues, redis }) — gauges wrap the existing collectors at scrape time via collect(); zero new collection logic, zero new connections (§25)"
  - "StartHealthServerOptions.metricsRegistry structural field (contentType + async metrics()) — health.ts stays free of the package import"
  - "package.json dependency @prometheus-io/client pinned EXACT 0.16.1 (official continuation; deprecated prom-client name never installed)"
affects:
  - "05-05 throwaway scraper + gate 2 consume the pinned family names (spidernode_queue_depth, _queue_oldest_job_age_seconds, _queue_stalled_events, _outbox_unsent, _outbox_failed, _outbox_oldest_age_seconds, _outbox_alert_latency_seconds, _redis_memory_percent, _pg_breaker_failures, _pg_breaker_state)"
  - "05-08 window evidence samples the exposition (D-27/D-14 gate inputs)"
tech-stack:
  added:
    - "@prometheus-io/client 0.16.1 (exact) — official Prometheus org continuation of the deprecated prom-client name"
  patterns:
    - "scrape-time collect() gauges over the existing collectors (regular-function this-binding per the client_js README note)"
    - "reset()/remove()-first collect semantics: collector failure => ABSENT samples, never stale values; remove() (not reset()) on unlabelled gauges so null cannot render a lying 0"
    - "structural registry injection (contentType + async metrics()) keeps the health module package-free — the queueMetrics/outboxMetrics provider precedent"
key-files:
  created:
    - src/worker/metrics.ts
    - tests/worker/health-metrics.test.ts
  modified:
    - package.json
    - pnpm-lock.yaml
    - src/worker/health.ts
    - src/worker/index.ts
decisions:
  - "05-03: gauge degradation is reset/remove FIRST then set — a failed collector yields ABSENT samples (never stale values from a previous scrape); unlabelled gauges clear via remove() because reset() renders a lying 0 (probe-verified against the library)"
  - "05-03: no snapshot memoization between gauge families — every scrape reads the live collectors; a TTL cache (tried, then removed) masks collector failures within its window and contradicts the pull-at-scrape-time pin"
  - "05-03: /metrics stays 404 when no registry is injected — the surface exists only when createMetricsRegistry wired it (no hidden half-surface)"
  - "05-03: @prometheus-io/client 0.16.1 legitimacy gate cleared — registry re-verification confirmed official org repo, prombot/nexucis/juliusv maintainers, and zero install scripts; the pin was approved through plan review (deprecated prom-client name absent from dependencies and devDependencies)"
metrics:
  duration: "~14 min (single session)"
  completed: 2026-09-15
status: complete
---

# Phase 05 Plan 03: Prometheus /metrics on the Worker Health Server (OBS-05) Summary

**One-liner:** A legitimacy-cleared @prometheus-io/client 0.16.1 (exact pin) registry mounted at /metrics on the existing loopback :9090 health server — ten spidernode_ gauge families wrapping the existing queue/outbox/breaker/memory collectors at scrape time via collect(), degrading to absent samples (never 500s, never stale values) when a collector fails.

## What Was Built

### Task 1 — Package legitimacy checkpoint (gate resolved, no code)

The blocking-human gate on @prometheus-io/client [SUS: too-new] was resolved per the plan-review-approved exact pin (orchestrator checkpoint_notice): before installing, the registry provenance was re-verified live — `npm view` confirms 0.16.1, repository github.com/prometheus/client_js (official Prometheus org), maintainers prombot/nexucis/juliusv, no postinstall/preinstall scripts in the shipped package, and prom-client 15.1.3 carries the exact deprecation pointer ("prom-client has been replaced by @prometheus-io/client"). Nothing was uninstallable or conflicting, so the approved disposition stood (T-05-SC mitigated).

### Task 2 — Install (commit e46bcb1)

`pnpm add --save-exact @prometheus-io/client@0.16.1` — package.json carries the exact version (no caret/tilde), pnpm-lock.yaml updated, and the plan's automated pin check passes (`pin ok`: dependencies contain @prometheus-io/client 0.16.1 and no prom-client entry in dependencies or devDependencies — Pitfall 6).

### Task 3 — metrics.ts registry + /metrics branch + boot wiring (commits 939c207 RED, ec05c8f GREEN)

- `src/worker/metrics.ts` — `createMetricsRegistry(deps)` where deps carries ONLY the queues set and the boot Redis client (§25: no new connections; index.ts passes the already-created handles). One `client.Registry` with ten Gauge families, all `spidernode_`-prefixed: `queue_depth{queue,state}`, `queue_oldest_job_age_seconds{queue}` (ms→s from the collector), `queue_stalled_events{queue}`, `outbox_unsent`, `outbox_failed`, `outbox_oldest_age_seconds`, `outbox_alert_latency_seconds{stat=p50|p95|avg}` (ms→s), `redis_memory_percent`, `pg_breaker_failures`, and `pg_breaker_state` (0 closed / 1 half-open / 2 open from `breakerState()`). Every gauge is a scrape-time `collect()` declared as a regular function (README this-binding note); imports are only `@prometheus-io/client` and sibling worker modules (worker boundary green).
- Degradation semantics: each collect() clears its gauge FIRST (labeled: `reset()`; unlabelled: `remove()` — probe-verified that `reset()` renders a lying 0 while `remove()` renders absence) and sets nothing when its collector throws — absent samples, never a 500, never stale values. The library's rendering of HELP/TYPE for sample-less families keeps family names visible to scrapers.
- `src/worker/health.ts` — `StartHealthServerOptions.metricsRegistry` is STRUCTURAL (`{ contentType: string; metrics(): Promise<string> }`), mirroring the queueMetrics/outboxMetrics provider-injection precedent so the module stays package-free. The `/metrics` branch is a sibling of `/metrics.json` inside the existing never-500 wrapper: 200 + registry contentType + awaited body; without a registry the path falls through to 404. Loopback 127.0.0.1 default, 405/404 branches, and the shutdown path are untouched.
- `src/worker/index.ts` — the registry is built from the already-created `redis` and `queues` handles and injected into `startHealthServer` (three-line wiring; no new client instantiations).
- `tests/worker/health-metrics.test.ts` (5 cases, ephemeral port 0): (1) GET /metrics → 200 + `text/plain; version=0.0.4` content type + all ten family names + fixture-true values on every family (queue depth 2/1, oldest age ≥450s from a 450s-old stamp, outbox trio 2/1/120, latency p50/p95/avg = 1/3/2 s, memory 50% from a 256/512 MiB INFO fake, breaker 2 failures/CLOSED) — proving collect() actually reads the providers; (2) /metrics.json sibling regression; (3) /metrics without a registry stays 404; (4) standing collector rejections degrade to ABSENT samples with a 200 (and no stale values from the prior healthy scrape) while redis/breaker families keep serving; (5) the exposition contains no REDIS_URL/DATABASE_URL/token substrings (T-05-03-01). Collector modules are mocked WITH delegation so the happy path runs the real `collectQueueMetrics` over the injected fake queue set.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Degrade test could not exercise the gauges' catch with one-shot rejections**
- **Found during:** Task 3 GREEN run (test 4 initially failed)
- **Issue:** The degrade case used `mockRejectedValueOnce` over a first implementation that memoized collector snapshots for 1 s (a cross-family coherence optimization); the memo served the cached snapshot so the injected rejection never surfaced, and with once-rejections only the first gauge's collect would have seen the failure anyway.
- **Fix:** Removed the memo entirely — every scrape now reads the live collectors (which is also the plan's literal "gauges pull at scrape time" pin) — and hardened the test to standing `mockRejectedValue` for both collectors with beforeEach restoration of the real delegation. All 5 cases green.
- **Files modified:** src/worker/metrics.ts, tests/worker/health-metrics.test.ts
- **Commit:** ec05c8f

Otherwise the plan executed exactly as written; the Task 1 checkpoint was resolved through the approved plan pin rather than a mid-execution pause (recorded above, not a deviation in outcome).

## Verification Evidence

- `pnpm exec vitest run tests/worker/health-metrics.test.ts tests/worker/health.test.ts` — **10/10 green** (5 new + 5 health regression)
- Full suite `pnpm test` — **274/274 green (33 files)**, up from 269/32 — zero cross-suite fallout
- `pnpm worker:boundary` — green (17 files, no next/react/@app imports under src/worker)
- `pnpm typecheck` — 0 errors; `pnpm lint` — 0 errors, zero warnings in plan-touched files (55 pre-existing elsewhere)
- `pnpm exec tsup` — build success; `dist/worker.js` (112.66 KB) contains the spidernode_ families and the bundled library code (the new dependency bundles cleanly — the wave-merge `pnpm verify` build concern pre-proven)
- Pin check: `node -e` verification prints `pin ok`; no `prom-client` entry anywhere in direct dependencies
- Probes against the installed package (before implementation): `reset()` vs `remove()` rendering for unlabelled gauges, labeled-family HELP/TYPE rendering with zero samples, and `CollectFunction<T> = (this: T) => void | Promise<void>` contextual this-typing

## TDD Gate Compliance

Task 3 followed RED→GREEN with per-gate commits: `test(...)` 939c207 (suite failed on the missing `@/worker/metrics` module) precedes `feat(...)` ec05c8f (5/5 green). Tasks 1-2 are gate/install tasks with no test surface of their own.

## Requirement Status

`OBS-05` (plan frontmatter) deliberately stays **Pending**: the export surface and its stable family contract are now built and test-pinned, but 05-05's throwaway scraper (D-27) and the window's gate-2 consumption are the requirement's proof legs — the ROADMAP itself carries OBS-05 on 05-05, and the 05-01/05-02 false-signal precedent (mark complete only when the consuming evidence exists) applies. Dashboards remain explicitly deferred to the VPS era (D-28), satisfying the requirement's "optional dashboard" clause by documented deferral.

## Key Learnings

- prom-client's `reset()` on an unlabelled gauge renders 0, not absence — for null-meaningful unlabelled gauges (memory percent with maxmemory unset), `remove()` is the only honest clear. Probe the library before trusting degradation semantics.
- A scrape-coherence memo and honest degradation are mutually exclusive at small TTLs: the RED suite caught the cache masking injected failures. "Pull at scrape time" is also the simpler implementation — the optimization was not worth the contract break.
- Mocking collector modules WITH delegation gives both directions cheaply: happy paths run the real collector over injected fixtures (one more real layer), while standing rejections reach the gauges' own catch — impossible through the collectors' internal swallows otherwise.

## Threat Surface

No new surface beyond the plan's `<threat_model>`; all four register rows mitigated as planned — T-05-SC (legitimacy gate + exact pin + registry re-verification), T-05-03-01 (loopback bind untouched, numeric gauges only, no-secrets test case 5), T-05-03-02 (degrade-to-absent collect semantics, never-500 wrapper preserved, case 4), T-05-03-02b (deprecated-name prohibition pinned by the Task 2 verify).

## Self-Check: PASSED

- Files: src/worker/metrics.ts, tests/worker/health-metrics.test.ts created; package.json, pnpm-lock.yaml, src/worker/health.ts, src/worker/index.ts modified — all present
- Commits: e46bcb1, 939c207, ec05c8f — all in `git log`
- No tracked-file deletions in any task commit; no untracked artifacts left behind by this plan
