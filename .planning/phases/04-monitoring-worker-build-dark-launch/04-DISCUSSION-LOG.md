# Phase 4: Monitoring Worker — Build & Dark Launch - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-13
**Phase:** 4-Monitoring Worker — Build & Dark Launch
**Areas discussed:** Worker build topology, Dark-launch form locally, Failure-injection proofs, CR-01 uptime_percent writer, SSRF module scope, Outbox relay failures, next_check_at re-seed

---

## Worker build topology

### How should one repo/one SHA produce both the web app and the worker?

| Option | Description | Selected |
|--------|-------------|----------|
| Single package | No pnpm workspace restructure; worker entry inside the existing flat repo | ✓ |
| pnpm workspace | Split apps/web + apps/worker with shared packages | |
| Defer to research | Let the phase researcher recommend | |

### What form should the worker's runnable artifact take?

| Option | Description | Selected |
|--------|-------------|----------|
| Bundled, externals | tsup bundle with node_modules external → dist/worker.js | ✓ |
| Plain tsc output | tsc --outDir, no bundler | |
| tsx from source | Run TypeScript directly in production | |

### How strictly should worker code be separated from the legacy cron code it replaces?

| Option | Description | Selected |
|--------|-------------|----------|
| src/worker/ subtree | New subtree importing shared src/lib + src/db; cron-logic.ts and db-batcher.ts stay untouched until Phase 5 cutover deletes them | ✓ |
| Shared engine extraction | Extract common check logic now for both cron and worker | |

### Should pnpm build produce both artifacts in one command?

| Option | Description | Selected |
|--------|-------------|----------|
| One pnpm build | next build + worker bundle in one step (DEP-01 one-SHA by construction) | ✓ |
| Separate build:worker | Second command for the worker artifact | |

### How should the worker run during development?

| Option | Description | Selected |
|--------|-------------|----------|
| tsx watch in dev | pnpm dev:worker with tsx as devDependency (instant reload) | ✓ |
| Bundle in dev too | Run the tsup bundle during development | |

### Enforce the worker/Next boundary with a gate, or by convention?

| Option | Description | Selected |
|--------|-------------|----------|
| Verify gate | src/worker/** must not import next/*, react, or route-handler modules; violation fails pnpm verify | ✓ |
| Convention only | Code-review discipline, no automated gate | |

### How should worker code be typechecked?

| Option | Description | Selected |
|--------|-------------|----------|
| Root tsc covers it | Worker sits under src/, root typecheck picks it up; bundler transpile-only | ✓ |
| Separate tsconfig | Dedicated worker tsconfig | |

### Embed build provenance in the worker artifact?

| Option | Description | Selected |
|--------|-------------|----------|
| Embed SHA + ts | git SHA + build timestamp injected at build; reported by /healthz and boot logs | ✓ |
| No stamp | Rely on the tarball name for provenance | |

### Which bundler should own the worker build target?

| Option | Description | Selected |
|--------|-------------|----------|
| tsup | ~10-line config, devDependency only | ✓ |
| Raw esbuild | Hand-rolled esbuild script | |
| Rolldown | Newer Rust bundler | |

### Should pnpm dev boot the worker too?

| Option | Description | Selected |
|--------|-------------|----------|
| Two terminals | pnpm dev (web only) + pnpm dev:worker separately | ✓ |
| One command | Combined dev runner for both processes | |

### Ship source maps with the production worker bundle?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, ship maps | dist/worker.js.map for stack-trace triage in failure-injection evidence | ✓ |
| No maps | Smaller artifact, unresolved frames | |

### Module format for the worker bundle?

| Option | Description | Selected |
|--------|-------------|----------|
| CJS | CommonJS dist/worker.js (matches pg/ioredis CJS reality) | ✓ |
| ESM .mjs | ES module output | |

### One worker process for everything, or a separate scheduler process?

| Option | Description | Selected |
|--------|-------------|----------|
| Single entry | All queue workers + scheduler + health server + breaker in one dist/worker.js | ✓ |
| Split scheduler | Separate scheduler process | |

### How should the standalone worker load environment variables?

| Option | Description | Selected |
|--------|-------------|----------|
| dotenv at entry | Loaded before anything else; mirrors Next's auto .env; PM2 env still wins | ✓ |
| Process env only | No dotenv dependency in the worker | |

### How should the :9090 health server port be configured?

| Option | Description | Selected |
|--------|-------------|----------|
| Env, default 9090 | WORKER_HEALTH_PORT env var, default 9090 (runbook value) | ✓ |
| Hardcode 9090 | Fixed constant | |

### Structured logging library for OBS-02?

| Option | Description | Selected |
|--------|-------------|----------|
| pino | JSON lines, monitorId-correlated child loggers, level via env | ✓ |
| Hand-rolled JSON | console.log with JSON.stringify wrapper | |
| Defer to research | Let the researcher compare options | |

**User's choice:** All Recommended options (single package, tsup bundle with externals, CJS + sourcemaps, src/worker subtree, one pnpm build, tsx watch dev, verify gate, root tsc, embedded provenance, two terminals, single entry, dotenv at entry, env-configured port, pino)
**Notes:** No workspace restructure — import-path churn during the highest-risk phase rejected.

---

## Dark-launch form locally

### How should the two processes run on the local stand-in for the dark launch?

| Option | Description | Selected |
|--------|-------------|----------|
| Plain processes + register | pnpm start / node dist/worker.js; PM2 mechanics dispositioned N/A-locally in 04-DEPLOY-RECORD, forward-tracked to first VPS deploy (03-08 pattern) | ✓ |
| Real PM2 on Windows | Install PM2 locally and exercise the handshake now | |

### How should scheduler-paused be expressed in the dark-launched worker?

| Option | Description | Selected |
|--------|-------------|----------|
| Env flag, no upsert | WORKER_SCHEDULER_ENABLED=false — scheduler job NOT upserted at boot; queue workers/health/relay/maintenance run live | ✓ |
| Upsert + BullMQ pause | Upsert the scheduler then pause it via BullMQ | |

### How to handle SEC-02 (OS-level egress control) on this host?

| Option | Description | Selected |
|--------|-------------|----------|
| Disposition to VPS | Runbook §10 iptables/nftables rules authored + verified as text, forward-tracked (§3c precedent); SEC-01 engine layer built now | ✓ |
| Windows Firewall now | Configure the local host's firewall | |

### How does the DEP-02 smoke check run with the scheduler paused?

| Option | Description | Selected |
|--------|-------------|----------|
| Enqueue one check | Operator script enqueues ONE priority-1 check job via the same enqueue path Phase 6 manual checks use | ✓ |
| Defer smoke to Phase 5 | No smoke check until the scheduler runs | |

### Where should the smoke check's synthetic ping land?

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated synthetic | Operator-owned synthetic monitor seeded once (long interval so cron ignores it), runbook-documented, reused every deploy | ✓ |
| Real monitor | Use an existing user monitor | |
| Throwaway row | Create and delete a monitor per smoke run | |

### Which monitors may receive worker-enqueued checks during dark launch?

| Option | Description | Selected |
|--------|-------------|----------|
| Synthetic-only | Operator script is the only enqueue path; user monitors 100% cron-served until Phase 5 overlap | ✓ |
| Any monitor | Allow enqueues against arbitrary monitors | |

### Should ecosystem.config.js gain the worker app definition this phase?

| Option | Description | Selected |
|--------|-------------|----------|
| Author now | Second app (worker entry, wait_ready, kill_timeout 20000ms per 01-04 pins), noted locally-unexercised | ✓ |
| Defer to Phase 5 | Write it when the VPS deploy is real | |

### Where does the dark-launch evidence + disposition register live?

| Option | Description | Selected |
|--------|-------------|----------|
| Deploy-record | 04-DEPLOY-RECORD.md mirroring the 03-08 pattern | ✓ |
| Runbook annotations | Add disposition notes to DEPLOY-RUNBOOK.md sections | |

### What migration activity should Phase 4's deploy expect?

| Option | Description | Selected |
|--------|-------------|----------|
| Zero, ideally | 0001 carries all worker prerequisites; the 03-REVIEW repair should yield an empty diff; 0002 only for a real gap (additive-only) | ✓ |
| Plan for a 0002 | Expect and author a second migration | |

### What is the dark launch's rollback story?

| Option | Description | Selected |
|--------|-------------|----------|
| Stop-process only | Cron never stopped, no schema change, no user path touched; Phase 5 owns the real cutover rehearsal (DEP-03) | ✓ |
| Rehearse Redis cleanup | Practice draining queues/keys for the dark launch | |

### Does the scheduler-pause flag cover the maintenance scheduler too?

| Option | Description | Selected |
|--------|-------------|----------|
| One flag, all schedulers | Gates check tick + maintenance scheduler; retention via old cron until Phase 5; maintenance manually enqueuable regardless | ✓ |
| Separate flags | WORKER_CHECK_SCHEDULER / WORKER_MAINTENANCE_SCHEDULER | |

### Where should OBS-01 queue metrics surface in Phase 4?

| Option | Description | Selected |
|--------|-------------|----------|
| JSON on :9090 | /metrics.json on the existing health server; Phase 5 Prometheus wraps the same collector | ✓ |
| Log lines only | Periodic metrics in pino output | |
| Defer to Phase 5 | No metrics until OBS-05 | |

### How much of the OBS-01 metric list ships in the Phase 4 snapshot?

| Option | Description | Selected |
|--------|-------------|----------|
| Full OBS-01 list | Depth per queue, job age, stalled count, transition→alert latency, Redis memory % | ✓ |
| Depth + stalled only | Minimal subset | |

### Where do worker logs go on the plain-process stand-in?

| Option | Description | Selected |
|--------|-------------|----------|
| stdout only | Operator redirects to file when wanted; PM2 captures on the future VPS | ✓ |
| File transport too | pino-file transport in the worker | |

**User's choice:** All Recommended options (plain processes + register, env-flag pause, SEC-02 dispositioned, enqueue-one smoke, dedicated synthetic, synthetic-only, ecosystem worker app now, deploy-record evidence, zero migrations goal, stop-process rollback, one flag, JSON metrics with full list, stdout-only logs)
**Notes:** Real-PM2-on-Windows rejected — Windows signal emulation makes the wait_ready handshake a false-fidelity rehearsal.

---

## Failure-injection proofs

### What carries the failure-injection evidence?

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid | Vitest integration suite for mechanics + one operator rehearsal (pnpm rehearse:worker, 03-05 style) with evidence file | ✓ |
| Automated only | Vitest suite alone | |
| Rehearsal only | Operator-run script alone | |

### Where do the resilience tests run relative to pnpm verify?

| Option | Description | Selected |
|--------|-------------|----------|
| Separate command | pnpm test:resilience outside the ≤5-minute verify budget; typed pre-deploy step in the runbook | ✓ |
| Inside pnpm verify | Extend the verify chain (breaks the time budget) | |

### How should the kill-mid-job test kill the worker?

| Option | Description | Selected |
|--------|-------------|----------|
| Real child process | Spawn the actual worker bundle, SIGKILL at a marked checkpoint (after Tier 1 commit, before ack), restart, assert | ✓ |
| In-process simulation | Mock the process boundary inside vitest | |

### RES-03 staleness — how far does Phase 4 go?

| Option | Description | Selected |
|--------|-------------|----------|
| Verify existing | Confirm lastChecked display surfaces staleness; pin with a test; zero UI work; gaps dispositioned | ✓ |
| New staleness UI | Build indicator UI for stale checks | |

### Which failure-injection cases must be automated?

| Option | Description | Selected |
|--------|-------------|----------|
| All six + seventh | Duplicate delivery, SIGKILL mid-job, Postgres-down, Redis-down, lock-loss, Redis-restart recovery + backlog-cap flood | ✓ |
| Four core cases | Duplicate, kill-mid-job, PG-down, Redis-down | |

### What should pnpm rehearse:worker cover?

| Option | Description | Selected |
|--------|-------------|----------|
| Full deploy-day | build → backup → migrate no-op → worker start → readyz wait → smoke enqueue → ping row → outage injections → recovery → teardown on a fresh throwaway stand-in | ✓ |
| Outages only | Just the injection sequence | |

### Which containers do the resilience tests run against?

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse 5453/6390 | Existing docker test stack, exclusive ownership while test:resilience runs | ✓ |
| Dedicated stack | A third docker-compose for resilience | |

### Are breaker/backlog constants tuned this phase or observed for Phase 5?

| Option | Description | Selected |
|--------|-------------|----------|
| Defaults + observe | Ship pinned defaults; record timings/metrics as the tuning dataset; changes wait for Phase 5 data | ✓ |
| Tune in Phase 4 | Calibrate thresholds from resilience runs now | |

### Where do worker correctness tests (§23 target-behavior) run?

| Option | Description | Selected |
|--------|-------------|----------|
| Verify + resilience split | Correctness cases join pnpm verify's regular vitest suite; only stop/start-heavy injection cases live in test:resilience | ✓ |
| All in resilience cmd | Everything in the separate command | |

### Does the backlog-cap drop policy (RES-02) get its own automated proof?

| Option | Description | Selected |
|--------|-------------|----------|
| Seventh case | Flood routine lane past ~2× cap → drops logged/counted, transition lane still processes | ✓ |
| Observe indirectly | Infer from queue-depth metrics | |

**User's choice:** All Recommended options (hybrid vehicle, separate command, real child process, verify-existing RES-03, all seven cases, full deploy-day rehearsal, reuse 5453/6390, defaults+observe, verify/resilience split, dedicated backlog case)
**Notes:** Clean split pinned: verify = what the code does; test:resilience = what breakage it survives.

---

## CR-01 uptime_percent writer

### Where does the uptime_percent write live?

| Option | Description | Selected |
|--------|-------------|----------|
| In the UPDATEs | Both Tier 1 transaction and Tier 2 guarded flush derive uptime_percent in the same SQL as counters; no new lane, no staleness window | ✓ |
| Recompute job | Nightly maintenance job recomputes | |
| Read-time compute | Compute on read in the query layer | |

### Must the SQL-derived percentage match today's JS math exactly?

| Option | Description | Selected |
|--------|-------------|----------|
| Byte-parity | Tests assert SQL value = old JS value across edge ratios (0 checks, all-up, all-down, 1/3); adjust SQL until it matches | ✓ |
| Accept divergence | Allow rounding differences | |

### Add a runtime consistency check for uptime_percent?

| Option | Description | Selected |
|--------|-------------|----------|
| Dry-run check | Maintenance dry-run (WRK-13) compares stored vs counters-derived per monitor, report-only | ✓ |
| Tests only | No runtime check | |

### How does Phase 4 handle CR-02 (Phase-5 design debt)?

| Option | Description | Selected |
|--------|-------------|----------|
| Instrument now | Metrics snapshot provides M4 counter-delta observability from dark launch; Phase 5 resolves ordering text and flips gates | ✓ |
| All Phase 5 | No instrumentation until CR-02 resolves | |

**User's choice:** All Recommended options (in-UPDATE derivation, byte-parity, dry-run consistency check, instrument-now for CR-02)
**Notes:** Behavior compatibility is the milestone's core value — displayed numbers must not shift at cutover.

---

## SSRF module scope

### Where does the canonical SSRF validation module live?

| Option | Description | Selected |
|--------|-------------|----------|
| src/lib/ssrf.ts | Single canonical module (11-token CIDR denylist, per-hop resolve-then-validate, scheme allowlist, 2 MB cap, 10 s timeout); Phase 6 web imports the same | ✓ |
| Worker-owned | Module inside src/worker/, extracted later | |

### Does web-side create/update validation adopt the SSRF module this phase?

| Option | Description | Selected |
|--------|-------------|----------|
| Worker-only now | Web keeps current validation; Phase 6 API rewrite wires create/update to the same module | ✓ |
| Wire web now too | Add validation to monitor create/update routes this phase | |

### Enforce denylist consistency between module and runbook §10?

| Option | Description | Selected |
|--------|-------------|----------|
| Verify-time diff | Extract CIDR tokens from module and runbook §10; mismatch fails pnpm verify (RR-01/WR-01 mandate becomes a gate) | ✓ |
| Prose mandate only | Documentation states the requirement | |

### How should per-redirect-hop validation be implemented?

| Option | Description | Selected |
|--------|-------------|----------|
| Manual redirect loop | fetch redirect:'manual', validate each Location target before following, ≤5 hops; deterministic per-hop testing per §23 | ✓ |
| Connect-time agent | Undici Agent with lookup interception | |
| Loop + research flag | Manual loop now, flag research to confirm | |

### Should the SSRF tests exceed §23's case list?

| Option | Description | Selected |
|--------|-------------|----------|
| Add bypass vectors | IPv6-mapped IPv4 (::ffff:10.0.0.1), 0.0.0.0, short/decimal IP forms, public→private redirect crossing | ✓ |
| §23 verbatim only | Transcribe the audit's case list only | |

### How is the 2 MB response cap enforced?

| Option | Description | Selected |
|--------|-------------|----------|
| Stream-counted cap | Abort body once streamed bytes cross 2 MB; never trust Content-Length | ✓ |
| Header check only | Read Content-Length and decide | |

**User's choice:** All Recommended options (canonical src/lib/ssrf.ts, worker-only adoption, verify-time diff, manual redirect loop, added bypass vectors, stream-counted cap)

---

## Outbox relay failures

### What happens to an outbox row after 3 failed Telegram attempts?

| Option | Description | Selected |
|--------|-------------|----------|
| FAILED + retain | attempts=3, last error recorded; failed-count gauge in /metrics.json; error-level pino line; no auto-retry past cap | ✓ |
| DLQ lane | Move to a dead-letter outbox lane | |
| Drop after log | Delete and log | |

### Distinguish permanent vs transient Telegram failures?

| Option | Description | Selected |
|--------|-------------|----------|
| Typed split | Permanent (400 chat-not-found, 401/403 blocked bot) → UnrecoverableError → straight to FAILED; transient (5xx/network/timeout) → retry with backoff | ✓ |
| Retry all ×3 | No classification | |

### How are FAILED outbox rows re-driven?

| Option | Description | Selected |
|--------|-------------|----------|
| Operator script | Runbook-documented script re-marks FAILED rows pending, respecting dedup keys; manual, deliberate, auditable | ✓ |
| Maintenance subcommand | Hook re-drive into the maintenance queue | |
| No re-drive | FAILED is terminal | |

### TTL for the alert dedup keys (SET NX EX)?

| Option | Description | Selected |
|--------|-------------|----------|
| 7 days | Symmetric with DLQ retention pin (01-04 D-14); Postgres outbox state guards beyond | ✓ |
| No TTL | Keys persist forever | |
| 24 hours | Short window | |

### How strictly is Telegram alert content pinned in worker tests?

| Option | Description | Selected |
|--------|-------------|----------|
| Byte-parity tests | Byte-identical rendered text per event type vs Phase 2 characterization strings | ✓ |
| Semantic parity | Same meaning, allow formatting drift | |

**User's choice:** All Recommended options (FAILED+retain, typed split, operator re-drive script, 7-day TTL, byte-parity tests)
**Notes:** No-TTL rejected (unbounded keys on 512 MB noeviction Redis makes Redis the outage); 24 h rejected (weekend relay stall could double-send).

---

## next_check_at re-seed

### Where does the stale-next_check_at re-seed responsibility land?

| Option | Description | Selected |
|--------|-------------|----------|
| Amend runbook now | §4a gains the typed UPDATE (LEAST(lastChecked + interval, now + interval) for active monitors, before unpause); execution/rehearsal stay Phase 5 | ✓ |
| Phase 5 input only | Leave it to Phase 5 planning | |

### Beyond re-seeding, should the claim SQL itself be verified catch-up-safe?

| Option | Description | Selected |
|--------|-------------|----------|
| Verify + catch-up | Phase 4 research verifies §14 claim advance semantics; amend §14 if a stale monitor only advances one-interval-per-tick | ✓ |
| Re-seed only | Trust the re-seed step | |

**User's choice:** All Recommended options (amend runbook now, verify + catch-up)
**Notes:** Gap surfaced during discussion: cron serves through the entire dark launch but never touches next_check_at — it goes stale for all user monitors.

---

## Claude's Discretion

- Exact tsup config shape and the build hook's position in the `pnpm build` script chain
- Boundary-gate implementation tool (dependency-cruiser vs eslint import rules vs grep script)
- Build-provenance injection mechanics (esbuild define/banner vs generated version file)
- Worker-internal module layout under `src/worker/`
- pino logger instance shape (base bindings, redaction) and child-logger field names
- BullMQ queue/job option details not pinned by §14 (stalledIntervals, removeOnComplete forms)
- Smoke-check and re-drive script locations and CLI shape
- Synthetic monitor's exact seed values (URL, interval, owner)
- Relay batch size and cadence within §14/DAT-05's pinned shape
- Test file organization for the verify vs resilience split
- `.env.example` additions layout per the 02-01 sweep pattern
- Worker-lane vitest setup boot strategy (global-setup extension vs per-file beforeAll)

## Deferred Ideas

- Real PM2 exercise (wait_ready/kill_timeout), SEC-02 OS egress, systemd supervision — first VPS deploy
- CR-02 ordering-text resolution, breaker/backlog threshold tuning, re-seed execution + rehearsal, heartbeat move (WRK-09), cron deletion (WRK-11), outbox-age alerting (OBS-03), Prometheus export (OBS-05) — Phase 5
- Web-side SSRF validation on create/update, per-user enqueue limiter, 202/poll API — Phase 6
- Bull Board queue UI + admin gating (OBS-04/SEC-04) — Phase 7
- Windowed-uptime compute (DAT-11) — Phase 8
