# Phase 4: Monitoring Worker — Build & Dark Launch - Research

**Researched:** 2026-09-13
**Domain:** Dedicated BullMQ 6 monitoring worker process (scheduler/claim engine, two-tier persistence, resilience machinery, SSRF-hardened check engine, outbox alerting, dark launch)
**Confidence:** MEDIUM-HIGH (BullMQ 6 semantics, PM2 handshake, PostgreSQL mechanics verified against official docs; tsup/pino API details verified via registry + type-level docs; two engine-level implementation choices remain open for the planner)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Pre-planning prerequisite (carried blocker, not a choice)
- **The 03-REVIEW repairs must land BEFORE any Phase-4 `drizzle-kit generate`:** CR-01 (stale `drizzle/meta/0001_snapshot.json`) + WR-01 (`timestamptz_ops` on boolean `idx_monitors_due` in schema.ts) — otherwise the first generate emits duplicate 0001 DDL. Fix via `/gsd-code-review 03 --fix` before `/gsd-plan-phase 4`. WR-05 (hard-coded journal count) before Phase 7 reuse; WR-02/WR-06 fix opportunistically/with Phase 6. The repaired snapshot should yield an **empty diff** — Phase 4's goal is **zero new migrations** (a 0002 only if planning finds a real gap: additive-only, full rehearsal pipeline).

#### Worker build & repo topology (WRK-14)
- **D-01:** **Single package — no workspace restructure.** The repo stays flat; the worker is an entry inside it (`src/worker/index.ts`). Zero import-path churn, the runbook tarball flow and Phase 2/3 test scaffolding stay untouched. (A pnpm workspace was considered and rejected: rewrites every import during the highest-risk phase.)
- **D-02:** **tsup bundle with node_modules external** → `dist/worker.js`. The deploy tarball already ships node_modules; externals keep the bundle small and native deps (`pg`, `ioredis`) loading normally. tsup is a devDependency only.
- **D-03:** **CommonJS output** (`dist/worker.js`) — matches the pg/ioredis CJS reality, no ESM interop friction, no package.json `type` changes.
- **D-04:** **Source maps shipped** (`dist/worker.js.map`) — the phase lives in SIGKILL-mid-job stack traces; frames must resolve to TypeScript.
- **D-05:** **`src/worker/` subtree owns all worker-only code** (queues, processors, scheduler, health server, breaker), importing shared modules from `src/lib/` + `src/db/`. `cron-logic.ts` and `db-batcher.ts` are NOT refactored or extracted — they stay as-is until Phase 5 deletes them (no shared-engine extraction; that would rewrite code the characterization suite pins mid-phase).
- **D-06:** **One `pnpm build` produces both artifacts** — next build AND the worker bundle in one step. DEP-01's same-SHA claim holds by construction, not operator discipline.
- **D-07:** **Dev loop = `pnpm dev:worker` via tsx watch** (devDependency; instant reload). `pnpm dev` stays web-only — two terminals, unmixed logs. Production always runs the bundle.
- **D-08:** **Worker/Next boundary enforced by a verify gate:** `src/worker/**` (and the bundle entry) must not import `next/*`, `react`, or route-handler modules — violation fails `pnpm verify`. Turns the convention into an invariant; catches the accidental NextResponse import that breaks the bundle.
- **D-09:** **Root tsconfig typechecks worker code** (it's under `src/`); the bundler is transpile-only. FND-02's type gate covers the worker for free; no parallel tsconfig to drift.
- **D-10:** **Build provenance embedded:** git SHA + build timestamp injected at build; `/healthz` and boot logs report it. Same-SHA across web+worker becomes runtime-verifiable (curl both processes during dark launch).
- **D-11:** **Single worker entry does everything** — all queue workers + scheduler + health server + breaker in one `dist/worker.js` (one PM2 app). Matches the two-app target topology and the connection budget; scheduler/job crash isolation comes from BullMQ stalled-job recovery, not process splits. A separate scheduler process was rejected (breaks DEP-01, doubles budget accounting).
- **D-12:** **dotenv loaded at the worker entry, before anything else** — mirrors Next's automatic .env for web; dev (`tsx watch`) and prod (`node dist/worker.js`) read the same file; PM2-injected env still wins where present. Avoids "boots in Next, dies standalone".
- **D-13:** **Health port via `WORKER_HEALTH_PORT`, default 9090** (the runbook-pinned value). Tests/dev/any future instance can pick another port without code edits.
- **D-14:** **pino for OBS-02 structured logging** — JSON lines, `monitorId`-correlated child loggers, level via env. **stdout only** (operator redirects to file on the stand-in; PM2 captures on the future VPS); no file transport in the worker.

#### Dark launch on the local stand-in (WRK-10, DEP-01/02)
- **D-15:** **Plain processes + disposition register (03-08 pattern).** Web (`pnpm start`) and worker (`node dist/worker.js`) run as plain processes on the local stand-in; PM2-specific mechanics (wait_ready handshake, kill_timeout, crash-loop visibility) are dispositioned **N/A-locally** in `04-DEPLOY-RECORD.md`, forward-tracked to the first VPS deploy. What CAN be honestly tested locally (SIGINT drain, healthz/readyz HTTP, restart-recovery) IS tested — via process kill/restart. Real-PM2-on-Windows was rejected: Windows signal emulation makes the handshake a false-fidelity rehearsal.
- **D-16:** **Scheduler pause = `WORKER_SCHEDULER_ENABLED=false` env flag — the scheduler job is NOT upserted at boot.** Everything else (queue workers, health endpoints, relay, maintenance consumers) runs live so any enqueued job exercises real machinery. One flag gates ALL recurring scheduling (check tick + maintenance scheduler); retention cleanup keeps running via the old cron path until Phase 5. Maintenance jobs remain manually enqueuable for dry-run testing regardless of the flag. Phase 5 flips this flag as the cutover lever.
- **D-17:** **SEC-02 (OS-level egress) dispositioned to the first VPS deploy** (§3c precedent): runbook §10 iptables/nftables rules authored and verified as text, forward-tracked in the deploy record. SEC-01's engine-level SSRF layer IS built and test-proven this phase — it's the code defense; the OS layer is Ubuntu-host defense-in-depth.
- **D-18:** **Smoke check = enqueue one priority-1 check job** for a synthetic monitor via an operator script (the same enqueue path Phase 6 manual checks will use). Proves the full pipeline — claim, lock, check, Tier 1/Tier 2 persistence — with the scheduler paused. The ping row appearing IS the DEP-02 evidence.
- **D-19:** **Dedicated operator-owned synthetic monitor**, seeded once (long interval so the cron path ignores it), runbook-documented, reused by every future deploy's smoke check. During dark launch, worker-bound enqueues are **synthetic-only** — the operator script is the only enqueue path (no API route can enqueue until Phase 6); user monitors stay 100% cron-served until the Phase 5 overlap window.
- **D-20:** **`ecosystem.config.js` gains the worker app definition NOW** (worker entry, wait_ready, kill_timeout 20000ms per the 01-04 pins) — versioned and code-reviewed from day one, noted locally-unexercised in the deploy record. Same posture as the runbook's VPS sections.
- **D-21:** **Evidence lives in `04-DEPLOY-RECORD.md`** mirroring the 03-08 pattern: what ran, what was dispositioned N/A-locally, forward-tracked items with their VPS consumption points.
- **D-22:** **Dark-launch rollback = stop the worker process.** Cron never stopped, no schema changed, no user path touched — no code-level rollback to rehearse this phase. Documented as such; Phase 5 owns the real cutover rollback rehearsal (DEP-03).
- **D-23:** **DEP-02's ordering activates for the worker form this phase** (per the 01-07 phase-conditional runbook): build → backup → migrate (no-op if zero migrations) → worker start + readyz wait → web restart → smoke check (D-18 enqueue form). Runbook amended accordingly.

#### Observability in Phase 4 (OBS-01/02)
- **D-24:** **Queue metrics = JSON snapshot on the existing :9090 health server** (e.g. `/metrics.json`). Zero new dependencies, operator-curlable during dark launch; Phase 5's Prometheus export (OBS-05) wraps this same collector rather than rebuilding it.
- **D-25:** **Full OBS-01 list in the snapshot:** depth per queue, job age, stalled count, transition→alert latency (Tier 1 commit → relay sent timestamps), Redis memory % (one INFO call). Phase 4 pre-stages CR-02's M4 counter-delta instrumentation this way — Phase 5 resolves the §4a ordering text and flips gates without building measurement.

#### Failure-injection & test strategy (criteria 3–5, RES-01..05)
- **D-26:** **Hybrid evidence vehicle.** A Vitest integration suite automates the mechanics (repeatable red/green regression net) AND one operator-run rehearsal (`pnpm rehearse:worker`, 03-05 style) exercises the full stand-in topology producing an evidence file for the deploy record.
- **D-27:** **`pnpm test:resilience` — a separate command outside `pnpm verify`'s ≤5-minute budget** (container stop/start is inherently slow). The runbook makes it a typed pre-deploy step alongside the rehearsal — nothing ships without it.
- **D-28:** **Seven automated injection cases:** (1) duplicate delivery → exactly one ping row; (2) SIGKILL mid-job → no lost/double-applied writes, no second ONGOING incident; (3) Postgres-down → retryable jobs, breaker opens, enqueue pauses; (4) Redis-down → monitoring pauses by design, Postgres intact; (5) lock-loss → abort, never double-write; (6) Redis-restart recovery → schedulers re-upsert, stale locks expire, next tick re-claims (RES-05); (7) backlog-cap flood → routine (priority-10) enqueues dropped + logged/counted while the transition lane still processes (RES-02's only direct proof).
- **D-29:** **Kill-mid-job test kills a REAL child process** — spawn the actual worker bundle, SIGKILL at a marked checkpoint (after Tier 1 commit, before ack), restart, assert. Proves the artifact, not a simulation.
- **D-30:** **Resilience tests reuse the 5453/6390 docker test stack** with exclusive ownership while `test:resilience` runs (it's a separate command — no concurrent suites). No third stack to maintain.
- **D-31:** **Worker CORRECTNESS tests (audit §23 target-behavior cases: duplicate-incident, duplicate-alert, SSRF per-hop, Tier 1/Tier 2 writer math, claim/idempotency semantics) join the regular vitest suite INSIDE `pnpm verify`** — they need no container restarts. Clean split: verify = what the code does; test:resilience = what breakage it survives.
- **D-32:** **Rehearsal covers full deploy-day:** build → backup → migrate no-op → worker start → readyz wait → smoke enqueue → ping row appears → outage injections (pg stop, redis stop) → recovery → teardown, against a fresh throwaway docker stand-in (own ports, 03-05 isolation pattern). The first full run of DEP-02's ordering must NOT be the production dark launch.
- **D-33:** **Breaker/backlog constants ship pinned (5-fail/60 s, ~2×, retries 3–5) and Phase 4 RECORDS observations** — resilience-test timings + dark-launch metrics land in the deploy record as the tuning dataset. Threshold changes wait for Phase 5's real overlap-window data. Research still verifies defaults against BullMQ 6 reality.
- **D-34:** **RES-03 staleness = verify existing, don't build UI.** Researcher confirms the existing dashboard/status-page lastChecked display already surfaces aging timestamps when checks stop, pins it with a test. Any genuine gap gets dispositioned, not redesigned in this backend-only phase.

#### CR-01 resolution — uptime_percent writer (DAT, design debt)
- **D-35:** **uptime_percent is derived in the same SQL statements that touch counters** — both the Tier 1 transition transaction and the Tier 2 guarded flush set `uptime_percent = round(100.0 * up_count / total_count, 2)` (exact expression per §16 transcription). No new lane, no staleness window, column always consistent with its counters. (Recompute job and read-time compute rejected: extra lane / touches Prisma read paths.)
- **D-36:** **Byte-parity with today's JS math is mandatory.** Writer tests assert the SQL-derived value equals the old JS-computed value (`(up/total)*100` → `toFixed(2)`) across edge ratios (0 checks, all-up, all-down, 1/3). If Postgres NUMERIC rounding disagrees with JS float formatting at an edge, the SQL expression is adjusted until it doesn't — behavior compatibility is the milestone's core value; publicly-displayed numbers must not shift at cutover.
- **D-37:** **Runtime consistency check rides the maintenance dry-run (WRK-13):** per monitor, compare stored `uptime_percent` against the counters-derived value; report discrepancies in the dry-run report without touching data. Guards the Phase 5 overlap window where two writer paths are live.

#### SSRF check engine (SEC-01)
- **D-38:** **Canonical module at `src/lib/ssrf.ts`** — one exported check pipeline: the 11-token CIDR denylist, resolve-then-validate per redirect hop, scheme allowlist, 2 MB cap, 10 s timeout. The worker engine consumes it now; Phase 6's web-side create/update validation imports the SAME module — no copy, no drift.
- **D-39:** **Web-side adoption waits for Phase 6.** Monitor create/update keeps current validation this phase (scope discipline; changing API rejection behavior would violate the no-user-facing-change window).
- **D-40:** **Verify-time denylist diff:** extract CIDR tokens from the module and from runbook §10's operator list; mismatch fails `pnpm verify`. RR-01/WR-01's three-statement same-change mandate becomes a gate.
- **D-41:** **Manual redirect loop:** `fetch` with `redirect: 'manual'`, validate each `Location` target (scheme + resolve-then-validate) before following, ≤5 hops, no-validation-no-follow (classified as target behavior). Deterministic and per-hop testable exactly as §23 specifies.
- **D-42:** **SSRF tests exceed §23 verbatim with normalization bypass vectors:** IPv6-mapped IPv4 (`::ffff:10.0.0.1`), `0.0.0.0`, short/decimal IP forms, public→private redirect crossings.
- **D-43:** **2 MB cap enforced by counting streamed bytes** (abort once crossed); Content-Length is never trusted.

#### Outbox relay & alert semantics (DAT-05/06)
- **D-44:** **Terminal state after 3 failed attempts = FAILED + retain.** Row marked FAILED (attempts=3, last error recorded); a failed-count gauge appears in `/metrics.json`; one error-level pino line per terminal failure. Nothing auto-retries past the cap; evidence preserved.
- **D-45:** **Typed permanent-vs-transient split (EML-03 pattern):** permanent Telegram failures (400 chat not found, 401/403 blocked bot) throw `UnrecoverableError` → straight to FAILED without burning retries; transient (5xx, network, timeout) retry with backoff.
- **D-46:** **Re-drive = operator script** (runbook-documented) that re-marks FAILED rows pending — respecting dedup keys so a re-drive can't double-send an alert that did go out. Manual, deliberate, auditable; no auto-healing loop.
- **D-47:** **Alert dedup key TTL = 7 days** (`SET NX EX`) — symmetric with the DLQ retention pin (01-04 D-14); beyond that window the Postgres-side outbox state is the real guard. No-TTL rejected (unbounded keys on a 512 MB noeviction instance makes Redis the outage); 24 h rejected (a relay stall over a weekend could double-send).
- **D-48:** **Telegram alert content pinned byte-for-byte in worker tests:** per event type (DOWN / RECOVERED / first-check-started), the rendered text must match the strings the Phase 2 characterization suite pins from today's cron. Message SELECTION moves to outbox event types; what lands in the user's chat is character-for-character unchanged.

#### next_check_at re-seed (gap surfaced by this discussion)
- **D-49:** **Runbook §4a amended NOW with the re-seed step** — a typed `UPDATE monitors SET next_check_at = LEAST(last_checked + interval, now + interval) WHERE is_active` executed at cutover prep, before scheduler unpause. Rationale: cron serves through the entire dark launch but never touches `next_check_at` — it goes stale for all user monitors; an un-re-seeded cutover floods or starves the scheduler. Execution and rehearsal stay Phase 5. Orthogonal to CR-02 (the §4a ordering contradiction), which still resolves at Phase 5 planning.
- **D-50:** **Verify the §14 claim SQL's advance semantics and make it catch-up-safe** — research task this phase: if a stale monitor advances only one interval per tick, amend §14 (established amendment process) so a far-behind `next_check_at` advances to now. Belt-and-suspenders with D-49: the claim itself stays correct even on a forgotten re-seed.

### Claude's Discretion
- Exact tsup config shape (entry, format flags, sourcemap flags, externals expression) and where the build hook sits inside `pnpm build`'s script chain
- The boundary-gate implementation (dependency-cruiser, eslint import rules, or a small grep script) — cheapest tool that fails verify on violation
- Build-provenance injection mechanics (esbuild `define`/banner vs a generated version file)
- Worker-internal module layout under `src/worker/` (queues/, processors/, scheduler/, health/, breaker/)
- pino logger instance shape (base bindings, redaction) and child-logger field names
- BullMQ queue/job option details not pinned by §14 (stalledIntervals, removeOnComplete forms) — research-verified
- Smoke-check and re-drive script locations (e.g. `scripts/`) and CLI shape
- The synthetic monitor's exact seed values (URL, interval, owner) — runbook-documented
- Relay batch size and cadence within §14/DAT-05's pinned shape
- Test file organization (naming, tags) for the verify vs resilience split
- `.env.example` additions (`WORKER_SCHEDULER_ENABLED`, `WORKER_HEALTH_PORT`) per the 02-01 sweep pattern
- Where worker-lane vitest setup boots in-process workers (global-setup extension vs per-file beforeAll)

### Deferred Ideas (OUT OF SCOPE)
- Real PM2 exercise (wait_ready/kill_timeout handshake), SEC-02 OS-level egress, systemd supervision form — first real VPS deploy (forward-tracked in 04-DEPLOY-RECORD per D-15/D-17)
- CR-02 resolution (§4a "disable nothing" vs M4 ordering contradiction) — Phase 5 planning; Phase 4 only pre-stages the M4 instrumentation (D-25)
- Breaker/backlog/retry threshold tuning with real data — Phase 5 (Phase 4 records the dataset per D-33)
- next_check_at re-seed execution + rehearsal — Phase 5 cutover (text lands now per D-49)
- Heartbeat move to worker tick (WRK-09), cron/`CRON_MODE` deletion (WRK-11), outbox-age alerting (OBS-03), Prometheus export (OBS-05), env transition (DEP-05) — Phase 5
- Web-side SSRF validation on monitor create/update — Phase 6 API work imports `src/lib/ssrf.ts` (D-39)
- Per-user manual-check enqueue limiter + 202/poll API — Phase 6 (SEC-05/API-01)
- Bull Board queue UI + admin gating — Phase 7 (OBS-04/SEC-04)
- Windowed-uptime compute (DAT-11) — Phase 8 (reuses the D-35 in-UPDATE derivation pattern)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WRK-01 | Dedicated worker process (second PM2 app; never inside `next start`) owns all monitoring execution | Worker entry + ecosystem.config.js worker stanza (D-11/D-20); PM2 handshake semantics (§Pattern 7); connection budget worker pool max 20 [VERIFIED: codebase §25] |
| WRK-02 | BullMQ 6 queue topology (scheduler, checks, db-writes, alerts, maintenance, email) using `upsertJobScheduler` for recurring jobs (legacy repeatables removed in v6) | BullMQ 6.3.4 `upsertJobScheduler` semantics verified against official docs (§Pattern 1); priority-default-0 invariant (§Pitfall 3); lane table from audit §14 [CITED: docs/ARCHITECTURE-AUDIT.md §14] |
| WRK-03 | Claim-based due-selection: single `FOR UPDATE SKIP LOCKED` transaction advancing `next_check_at`; idempotency key `check:{monitorId}:{next_check_at epoch}`; tick ≤ ½ minimum interval; failed-enqueue compensation (J-1) | Claim SQL transcription (§Pattern 2); CTE-scoped `FOR UPDATE SKIP LOCKED` trap (§Pitfall 4); D-50 catch-up-safety verdict (§Open Questions resolution) |
| WRK-04 | Per-monitor distributed lock: TTL = timeout + margin, renewal every TTL/3, owner-only Lua compare-and-delete, abort-on-lock-loss (J-3) | Lock pattern + Lua compare-and-delete discipline (03-01 `rlIncr` precedent) [VERIFIED: codebase]; BullMQ stalled-checker relationship documented (§Pitfall 5) |
| WRK-05 | Typed result-vs-error classification: target outcomes (UP/DOWN/timeout/DNS/TLS) are successful jobs; only infra failures throw (J-4) | Error taxonomy + `UnrecoverableError` usage for permanent failures [VERIFIED: docs.bullmq.io] |
| WRK-06 | Retries with exponential backoff, bounded attempts (3–5), DLQ retention via `removeOnFail` age | KeepJobs lazy-eviction caveat (§Pitfall 6) [VERIFIED: docs.bullmq.io]; removeOnFail age forms verified |
| WRK-07 | Graceful shutdown: SIGINT handler + `worker.close()` + PM2 `kill_timeout` ≥ max job duration (~20 s); `stalledInterval`/`maxStalledCount` bounded | Stalled defaults (30000/30000/1) match design pins exactly [VERIFIED: docs.bullmq.io]; PM2 kill_timeout default 1600 vs runbook 20000 pin (§Pattern 7) [CITED: pm2.keymetrics.io]; Windows signal constraint (§Pitfall 8) |
| WRK-08 | Worker health endpoints: `:9090/healthz` (process only) and `/readyz` (Redis + DB ping) gating releases | Two-signal readiness contract (process.send('ready') vs HTTP readyz) [CITED: pm2.io + runbook §4]; WORKER_HEALTH_PORT (D-13) |
| WRK-10 | Worker dark launch: deployed with scheduler paused and deploy pipeline rehearsed while nothing depends on it, before cutover | WORKER_SCHEDULER_ENABLED flag semantics (D-16) + scheduler-not-upserted-at-boot mechanics (§Pattern 1); rehearsal pipeline (D-32, 03-05 pattern) |
| WRK-12 | Priority handling for manual checks and monitors in non-UP state (priorities or separate lane) with documented worst-case latency (J-6) | BullMQ priority verification: default-0/unprioritized jobs process BEFORE prioritized — every lane must set explicit priority (§Pitfall 3) [VERIFIED: docs.bullmq.io] |
| WRK-13 | Maintenance jobs support dry-run mode (report row counts without deleting) | Maintenance queue + dry-run + D-37 consistency check pattern (§Pattern 6) |
| WRK-14 | Web and worker share TypeScript from one repo and one build (single package + worker build target, or documented workspace) | tsup bundle config verified option-by-option (§Standard Stack + §Pattern 8) [VERIFIED: jsDocs.io type docs]; one `pnpm build` chain (D-06) |
| DAT-01 | Two-tier persistence: DOWN/RECOVERED/first-check/manual transitions written in one synchronous Postgres transaction (monitor + ping + incident + outbox) | Tier 1 literal SQL transcription (§Pattern 3) [CITED: docs/ARCHITECTURE-AUDIT.md §16.1] |
| DAT-02 | Routine-UP aggregation ≤60 s in Redis applied via one guarded atomic UPDATE per monitor (additive counters, `GREATEST` last_checked, response_time monotonicity, never writes `status`) | Tier 2 RENAMENX staging + write_guards flush (§Pattern 4) [CITED: docs/ARCHITECTURE-AUDIT.md §16.2]; batchId scheme (01-06) [VERIFIED: STATE.md] |
| DAT-03 | Transactional write guards: guard insert + delta apply in the same Postgres transaction; `ON CONFLICT DO NOTHING` skips re-application (J-2) | Same pattern as Pattern 4; write_guards table present in schema [VERIFIED: codebase src/db/schema.ts] |
| DAT-04 | Conditional transition UPDATE (`WHERE status <> target`) plus partial unique index enforcing one ONGOING incident per monitor (D-1) | `incidents_one_ongoing` partial index confirmed live in schema.ts [VERIFIED: codebase]; ON CONFLICT with partial-index predicate form documented (§Code Examples) |
| DAT-05 | Transactional outbox for transition events; relay job (`FOR UPDATE SKIP LOCKED`, batched) enqueues alerts and marks rows sent (D-2) | Outbox relay SQL (§Pattern 5) [CITED: docs/ARCHITECTURE-AUDIT.md §16.3]; relay batch/cadence discretion |
| DAT-06 | Incident-keyed alert dedup (`SET NX EX` after confirmed send; retries check first; ≤3 attempts) (D-4) | Dedup key vocabulary (01-06) + TTL 7 days rationale (D-47); removed-jobId caveat (§Pitfall 7) |
| DAT-07 | Deterministic ID generation pinned in Drizzle columns; bulk-insert paths verified never to produce `undefined` PKs (D-3) | `gen_random_uuid()::text` defaults confirmed in schema.ts for pings/incidents/outbox [VERIFIED: codebase]; id-omitting INSERT contract (03-04) |
| DAT-08 | Retention deletes batched (looped `LIMIT ~5000`) in the maintenance queue only (D-7) | Maintenance queue processor pattern (§Pattern 6); statement_timeout 30 s sized above the pass [VERIFIED: STATE.md 01-03] |
| DAT-10 | `error_class` + status code metadata recorded on pings/incidents (N-5) | `pings.error_class`/`status_code` columns confirmed in schema.ts [VERIFIED: codebase]; error taxonomy (WRK-05) feeds them |
| RES-01 | Circuit breaker around Postgres: infra-failure rate threshold → OPEN (queue pause, stop enqueueing) → HALF_OPEN probe → CLOSED (J-5) | Breaker pattern + in-process state + `write_guards` probe (§Pattern 6); BullMQ pause persistence semantics [VERIFIED: docs.bullmq.io]; defaults vs D-33 pins |
| RES-02 | Backlog cap: routine checks droppable at queue depth > ~2× active monitors; transitions never droppable | `getJobCounts` availability check; enqueue-side gating design (01-02: only routine lane gated) [VERIFIED: STATE.md] |
| RES-03 | Redis outage = monitoring pause by design (no fallback scheduler); detected via external dead-man's switch; UI surfaces "last checked Xm ago" staleness (R-1) | Pause-by-design verification (§Pitfall 5); D-34 verdict: existing lastChecked display already surfaces staleness [VERIFIED: codebase — see Validation map] |
| RES-04 | Postgres outage produces retryable jobs — no silently lost results; failure-injection tests prove Redis-down leaves Postgres intact and Postgres-down loses nothing | Injection cases 3/4 (D-28); breaker + backlog + retry interplay (§Pattern 6) |
| RES-05 | Redis-restart recovery procedure: schedulers re-upserted at boot, stale locks expire via TTL, next tick re-claims via `next_check_at` | Injection case 6 (D-28) + upsertJobScheduler idempotence (§Pattern 1) + AOF persistence (03-08) [VERIFIED: STATE.md] |
| SEC-01 | SSRF layering in the check engine: resolve-then-validate all IPs against a private-range denylist per redirect hop (≤5), scheme allowlist, 2 MB response cap, strict 10 s timeout — with SSRF test cases (S-1) | Full pipeline (§Pattern 9): 11-token denylist, IPv6-mapped canonicalization, per-hop re-validation, streamed byte cap; engine HTTP-client choice (§Open Questions 2) |
| SEC-02 | OS-level egress control on the worker host (deny private ranges; allow 80/443 egress only) | D-17 disposition + runbook §10 authored-as-text [CITED: docs/DEPLOY-RUNBOOK.md §10]; D-40 denylist diff gate |
| OBS-01 | Queue metrics exported: depth per queue, job age (not just depth), stalled count, transition→alert latency, Redis memory % | `/metrics.json` snapshot design (D-24/D-25) — zero new deps; BullMQ count/metrics APIs [CITED: docs.bullmq.io API] |
| OBS-02 | Structured logs with `monitorId` correlation across scheduler → check → persist → alert | pino 10.3.1 child loggers verified [VERIFIED: getpino.io + npm registry]; stdout-only (D-14) |
| DEP-01 | Two PM2 apps (web + worker) built and versioned from one SHA; `kill_timeout` ≥ max job duration; crash-loop visibility configured | D-06 one-build-two-artifacts; D-10 build provenance; PM2 defaults vs pins table (§Pattern 7) |
| DEP-02 | Deploy ordering: build → backup (`pg_dump`) → migrate (single runner) → restart worker (waits `readyz`) → restart web → smoke-check (synthetic check → ping row appears) | §4/§4a ordering + first-worker-release path [CITED: docs/DEPLOY-RUNBOOK.md §4/§4a]; D-23 activation; D-18 smoke form; D-32 rehearsal |
</phase_requirements>

## Summary

Phase 4 transcribes an already-adjudicated design (audit §13–§16, §23, §25, verdict READY since Phase 01) into running code: a single-entry BullMQ 6 worker (`src/worker/index.ts` → tsup CJS bundle `dist/worker.js`) that owns the scheduler/claim engine, six prioritized lanes, Tier 1 synchronous transition transactions, Tier 2 guarded RENAMENX flushes, a Postgres circuit breaker, backlog-cap drop policy, an SSRF-hardened check engine (`src/lib/ssrf.ts`), an outbox relay with incident-keyed dedup, `:9090` health endpoints, and pino `monitorId`-correlated logging — then dark-launches it with `WORKER_SCHEDULER_ENABLED=false` while the legacy cron serves 100% of users.

The research verdict on the load-bearing mechanics is favorable: **every BullMQ 6 behavior the design depends on was verified against official docs and holds as designed.** `upsertJobScheduler` is idempotent, keeps exactly one delayed job per scheduler, and mints the next job only when the current one starts processing (which makes the tick self-spacing under load); the stalled-checker defaults (`lockDuration` 30000 ms, `stalledInterval` 30000 ms, `maxStalledCount` 1) match the design pins exactly; queue pause persists in Redis and lets in-flight jobs finish; `removeOnFail`/`removeOnComplete` age forms exist for DLQ retention — with the caveat that KeepJobs eviction is **lazy** (space is reclaimed only when another job in the same queue completes/fails, not by a timer). Two design invariants were *confirmed rather than assumed*: the priority trap (BullMQ's default priority 0 processes **unprioritized jobs before prioritized ones**, so the every-lane-explicit-priority decision 01-02 is mandatory, not stylistic) and the PM2 handshake (defaults are `listen_timeout` 3000 ms / `kill_timeout` 1600 ms — the runbook's 30000/20000 pins are genuine raises, and the two-signal readiness contract from 01-07 is exactly how PM2 behaves with `wait_ready`).

Three findings need planner attention. (1) **tsup is unmaintained** — its README states "This project is not actively maintained anymore. Please consider using tsdown instead." D-02 locks tsup anyway, and the config surface this phase needs is ~15 lines of options verified from its type definitions; the mitigation is to keep the config minimal and treat the bundler as swappable. (2) **`tsx` is NOT a direct devDependency** — it exists only transitively (via vitest/vite); D-07's dev loop requires adding it explicitly. (3) **Postgres has no `round(double precision, integer)`** — D-35's `uptime_percent` derivation must cast through `::numeric` (`round((100.0*up/total)::numeric, 2)`) or every transition write throws error 42883; and byte-parity with the legacy JS formula needs `100.0 *` float-typed division (not integer division) plus a `::double precision` cast back on a `double precision` column.

**Primary recommendation:** Build the worker as one CJS tsup bundle with five new dependencies (bullmq 6.3.4, pino 10.3.1, tsup 8.5.1, tsx 4.23.13 as devDeps; undici 8.x as the engine's connection-pinning layer — see Open Question 2), transcribe §14/§16 SQL verbatim with the `::numeric` cast fix, set explicit priority on every lane, split tests into `pnpm verify` (correctness) vs `pnpm test:resilience` (seven injection cases, exclusive test-stack ownership), and dark-launch with the scheduler flag false, cron untouched, and rollback = stop the process.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Recurring scheduling (tick ≤ ½ min interval) | Worker process (BullMQ `upsertJobScheduler` + claim transaction) | — | Never in `next start` (WRK-01); Redis never authoritative, Postgres `next_check_at` is the claim source of truth |
| Due-monitor selection & claim | Database (`FOR UPDATE SKIP LOCKED` inside CTE) | Worker (executes the transaction) | Atomicity must live in Postgres so Redis loss/restart is recoverable (RES-05) |
| HTTP checks against user URLs | Worker process (SSRF-hardened engine) | — | Per-hop SSRF validation only possible where the dial is made; engine denylist + (future) OS egress layering |
| Transition persistence (Tier 1) | Database (single synchronous transaction) | Worker (issues it) | DOWN/RECOVERED/incident/outbox atomicity is a Postgres property (DAT-01) |
| Routine-UP aggregation (Tier 2) | Worker (Redis staging, ≤60 s) | Database (guarded flush) | Redis is a staging buffer only; write_guards + RENAMENX make the flush idempotent |
| Alert delivery | Worker (outbox relay + Telegram) | — | Relay reuses `src/lib/telegram.ts` send path; dedup keys in Redis, outbox state in Postgres |
| Health/readiness surfaces | Worker process (:9090 HTTP) | PM2 (process ready signal) | Two distinct gates with distinct consumers (01-07): operator gates on HTTP `readyz`, PM2 gates on `process.send('ready')` |
| Queue metrics (OBS-01) | Worker process (`/metrics.json`) | — | Snapshot wraps BullMQ counts + one Redis INFO; Phase 5 Prometheus wraps the same collector |
| Web app (this phase) | Next.js process — **deliberately untouched** | — | No user-facing change; cron path serves all users until Phase 5 |
| Build artifact production | Dev machine (`pnpm build` = next build + tsup bundle) | — | One SHA → two artifacts by construction (D-06); VPS/stand-in never builds |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| bullmq | 6.3.4 | Queue topology, scheduler, workers, stalled recovery, priorities, DLQ retention | The design's pinned queue engine (audit D-12); `upsertJobScheduler` is the v6-native recurring mechanism (legacy repeatables removed) [VERIFIED: npm registry + docs.bullmq.io] `bullmq` [WARNING: flagged as suspicious by the legitimacy seam's recency heuristic — verify before using; see Package Legitimacy Audit.] |
| pino | 10.3.1 | OBS-02 structured JSON logging, child loggers for `monitorId` correlation | Fastest standard Node logger; stdout JSON by default; bundling officially supported (esbuild/tsup); transports explicitly NOT used (D-14) [VERIFIED: npm registry + getpino.io] |
| tsup | 8.5.1 | Worker bundle: CJS output, node_modules external, sourcemaps | D-02 lock; esbuild-based; options verified from type definitions. **UNMAINTAINED** — see Pitfall 2 [VERIFIED: npm registry + jsDocs.io] |
| tsx | 4.23.13 (devDep) | `pnpm dev:worker` watch loop (D-07) | Zero-config TS executor with watch; currently only a transitive dep via vitest — must be added direct [VERIFIED: npm registry] `tsx` [WARNING: flagged as suspicious by the legitimacy seam's recency heuristic — verify before using.] |
| ioredis | ^6.0.0 (already installed) | BullMQ's connection layer + worker's direct Redis ops (staging, locks, dedup) | Already a Phase 3 dependency; satisfies BullMQ 6's `ioredis >= 5.x` peer range [VERIFIED: codebase package.json + npm registry] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| undici | 8.10.2 | Engine HTTP client with connection-level IP pinning (`Agent` + custom `connect`/`lookup`) so the dial only reaches resolve-time-validated addresses | RECOMMENDED for the check engine (D-41 says `fetch`; Node's global fetch IS undici but the `Agent`/`Dispatcher` classes require the npm package). Open Question 2 holds the zero-dep `node:https` alternative [VERIFIED: npm registry + nodejs/undici docs] `undici` [WARNING: flagged as suspicious by the legitimacy seam's recency heuristic — verify before using.] |
| dotenv | ^17.4.2 (already installed) | Worker entry env loading (D-12) | Always — first import in `src/worker/index.ts` [VERIFIED: codebase package.json] |
| drizzle-orm + pg | already installed | Worker data layer (raw `sql` transactions for §16 writers; own pool max 20) | Always — Tier 1/Tier 2 SQL runs through the worker's dedicated pool [VERIFIED: codebase] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| tsup | tsdown (successor) or raw esbuild CLI | tsdown is the maintained line, but D-02 locks tsup; the needed config is ~15 lines and the bundler is swappable later (see Open Question 1) |
| npm undici fetch + Agent | `node:https` with custom `lookup` after `dns.resolve4/6` | Zero new deps and equally safe (custom `lookup` pins the dial to validated IPs), but hand-rolls redirect/timeout/streaming semantics the engine needs anyway; undici keeps `fetch` ergonomics D-41 names |
| BullMQ | pg-boss or hand-rolled SKIP LOCKED polling | Rejected by design gate (audit D-12); BullMQ's stalled recovery + priorities + schedulers are load-bearing for WRK-06/WRK-07/WRK-12 |
| pino transports (file rotation) | pino.destination / transport workers | Explicitly rejected (D-14): stdout only; the operator redirects, PM2 captures on the VPS |

**Installation:**
```bash
pnpm add bullmq pino undici
pnpm add -D tsup tsx
```

**Version verification (this session, npm registry):** bullmq 6.3.4, pino 10.3.1, tsup 8.5.1, tsx 4.23.13, undici 8.10.2, ioredis 6.0.0 — all confirmed current stable as of 2026-09-13. Node engines `>=22 <25` satisfied by dev machine v24.15.0 [VERIFIED: local runtime + codebase package.json].

## Package Legitimacy Audit

> Package Legitimacy Gate run via `gsd-tools query package-legitimacy check` (npm ecosystem) + registry verification (`npm view`) + postinstall-script inspection.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| bullmq | npm | ~6 yrs (v6 major line current) | millions/wk | github.com/taskforce-sh/bullmq | SUS (recency heuristic on latest publish) | Approved — canonical, official-docs verified; planner adds checkpoint:human-verify before install |
| pino | npm | ~10 yrs | tens of millions/wk | github.com/pinojs/pino | OK | Approved |
| tsup | npm | ~7 yrs | millions/wk | github.com/egoist/tsup | OK | Approved (unmaintained — see Pitfall 2) |
| tsx | npm | ~4 yrs | millions/wk | github.com/privatenumber/tsx | SUS (recency heuristic) | Approved — canonical; planner adds checkpoint:human-verify before install |
| undici | npm | ~8 yrs | tens of millions/wk | github.com/nodejs/undici | SUS (recency heuristic) | Approved — Node core team's own client; planner adds checkpoint:human-verify before install |

**Packages removed due to SLOP verdict:** none.
**Packages flagged as suspicious [SUS]:** bullmq, tsx, undici — all three flagged solely by the seam's "recently published version" heuristic (each ships constantly, so the latest version is always days old); registry age, download volume, and canonical source repos all indicate well-established packages, and bullmq's semantics were additionally verified against docs.bullmq.io this session. Per protocol the planner still gates the dependency-install task behind one `checkpoint:human-verify` covering the three names.

**Postinstall inspection:** none of the five carries a postinstall script reaching outside the project (pino/tsup/tsx/undici have none relevant; tsup's esbuild binary ships via platform optionalDependencies). One pnpm-10 note: `pnpm-workspace.yaml` `allowBuilds` currently lists only prisma/unrs-resolver entries; esbuild is NOT allowlisted — its install script is an optional optimization (binaries arrive via `@esbuild/win32-x64`-style optional deps), so the bundle should build without it, but if `pnpm build` fails on a missing esbuild binary, add `esbuild` to `allowBuilds` [ASSUMED — verify at first build].

## Architecture Patterns

### System Architecture Diagram

```
                       DARK LAUNCH STATE (this phase)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ LEGACY (serves 100% of users, untouched)                                  │
  │  next start (web) ── node-cron tick ──> fetch user URLs ──> pings/        │
  │                                        incidents/Telegram (cron-logic)   │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────┐
  │ NEW WORKER (alive, scheduler PAUSED via WORKER_SCHEDULER_ENABLED=false)   │
  │                                                                           │
  │  operator script ──enqueue(priority 1)──> Redis/BullMQ check queue        │
  │  (synthetic monitor only;                  │                              │
  │   no API enqueue until Phase 6)            ▼                              │
  │                              ┌─────────────────────────────┐              │
  │                              │ dist/worker.js (one entry)  │              │
  │                              │  lane workers (priorities)  │              │
  │                              │  ├ check lane ───────────┐  │              │
  │                              │  │  claim (SKIP LOCKED)  │  │              │
  │                              │  │  per-monitor lock     │  │              │
  │                              │  │  SSRF engine (ssrf.ts)│  │              │
  │                              │  ▼                       ▼  │              │
  │                              │  Tier 1 (sync txn)   Tier 2 (staging)      │
  │                              │  monitor+ping+        Redis ZSET/HASH      │
  │                              │  incident+outbox      │ guarded flush ≤60s │
  │                              │  ▲                    ▼                    │
  │                              │  └──── Postgres (source of truth) ────┐    │
  │                              │                                       │    │
  │                              │  relay lane ◀─ outbox unsent rows ────┤    │
  │                              │   ├ dedup SET NX EX (7d) ─> Redis     │    │
  │                              │   └ Telegram (byte-parity send)       │    │
  │                              │  maintenance lane (dry-run capable)   │    │
  │                              │  breaker (5 fail/60s) ─ gates enqueue  │    │
  │                              └───────────────────────────────────────┘    │
  │                              :9090 /healthz /readyz /metrics.json        │
  │                              pino stdout (monitorId child loggers)       │
  │                              process.send('ready') after Redis+DB pings  │
  └──────────────────────────────────────────────────────────────────────────┘
         rollback = stop the worker process (cron never stopped)
```

Trace the smoke use case: operator script enqueues one priority-1 check for the synthetic monitor → check lane claims via SKIP LOCKED transaction → per-monitor lock acquired → SSRF engine performs the HTTP check → Tier 1 transaction writes ping+counters+uptime_percent (+incident/outbox on transition) or Tier 2 stages routine-UP → relay lane picks the outbox row → dedup key → Telegram → row marked sent → ping row visible in Postgres (the DEP-02 evidence).

### Recommended Project Structure

```
src/
├── worker/
│   ├── index.ts          # single entry: dotenv first, env validation, boot
│   │                     #   queues → workers → health server → ready signal
│   ├── connection.ts     # BullMQ ioredis factory (queue + blocking conns)
│   │                     #   maxRetriesPerRequest: null, worker-side pins
│   ├── queues.ts         # Queue/Worker instances, lane priorities (§14)
│   ├── scheduler.ts      # upsertJobScheduler ticks (gated by the env flag)
│   ├── claim.ts          # §14.3 SKIP LOCKED claim transaction (+D-50 form)
│   ├── locks.ts          # per-monitor SET NX EX + renewal + Lua compare-and-delete
│   ├── breaker.ts        # Postgres circuit breaker (in-process state)
│   ├── backlog.ts        # enqueue-side backlog cap (routine lane only)
│   ├── persist/
│   │   ├── tier1.ts      # §16.1 transition transaction (uptime_percent included)
│   │   ├── tier2.ts      # §16.2 staging + guarded flush (RENAMENX + batchId)
│   │   └── outbox.ts     # relay loop + dedup + UnrecoverableError classification
│   ├── engine/
│   │   └── check.ts      # check job processor consuming src/lib/ssrf.ts
│   ├── maintenance/      # retention delete batches, dry-run, D-37 consistency
│   └── health.ts         # :9090 server — healthz/readyz/metrics.json, provenance
├── lib/
│   └── ssrf.ts           # D-38 canonical SSRF pipeline (shared with Phase 6)
scripts/
├── enqueue-smoke.mjs     # D-18 operator smoke (priority-1 synthetic check)
├── redrive-outbox.mjs    # D-46 FAILED → pending re-mark, dedup-respecting
└── seed-synthetic.sql    # D-19 one-time synthetic monitor seed
```

(Module layout inside `src/worker/` is discretion — this shape matches D-05's queues/processors/scheduler/health/breaker enumeration.)

### Pattern 1: Recurring scheduling — `upsertJobScheduler` (WRK-02, WRK-10)

**What:** One delayed job per scheduler, upserted idempotently; the *next* occurrence is minted only when the current job starts processing.
**When to use:** The check tick and the maintenance scheduler — gated behind `WORKER_SCHEDULER_ENABLED` so dark launch simply skips the upsert.

```typescript
// Source: docs.bullmq.io/guide/job-schedulers/ (BullMQ 6, verified 2026-09-13)
await queue.upsertJobScheduler(
  'check-tick',                       // scheduler id — stable across restarts
  { every: 30_000 },                  // tick ≤ ½ minimum interval (WRK-03)
  {
    name: 'check-tick',
    data: {},
    opts: { priority: 1, jobId: undefined }, // custom jobIds NOT allowed on
  }                                   // scheduler-produced jobs — the dedup key
);                                    // must live in the claim SQL, not here
```

Verified semantics that matter here [VERIFIED: docs.bullmq.io]:
- Idempotent: re-running the upsert at every boot (RES-05 recovery) updates rather than duplicates — exactly one delayed job per scheduler exists.
- The next occurrence is generated when the current one **starts processing**, not when it completes — a busy queue stretches the effective interval rather than piling up ticks. The claim transaction's `next_check_at` guard means a stretched tick simply claims what is due; no double-claim is possible.
- Pausing/removing: scheduler jobs honor queue state; `WORKER_SCHEDULER_ENABLED=false` skips the upsert entirely, so nothing recurring exists in Redis for the tick (D-16's exact mechanic).

### Pattern 2: The claim transaction (WRK-03, D-50)

**What:** Single atomic SELECT … FOR UPDATE SKIP LOCKED that selects due monitors, advances `next_check_at`, and returns the claim data the lane assignment + jobId derive from.
**When to use:** Every check-tick and every manual enqueue path.

```sql
-- Source: docs/ARCHITECTURE-AUDIT.md §14.3 (transcription target), with the
-- D-50 catch-up-safe advance this research confirms is REQUIRED:
WITH due AS (
  SELECT id
  FROM monitors
  WHERE "isActive" AND next_check_at <= now()
  ORDER BY next_check_at ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED          -- MUST stay inside the WITH clause
)
UPDATE monitors m
SET next_check_at = GREATEST(     -- catch-up-safe: a monitor that fell behind
      now() + (interval '1 minute' * m.interval),   -- advances to now+n, never
      m.next_check_at + (interval '1 minute' * m.interval)  -- crawls one
)                                                  -- interval per tick
FROM due
WHERE m.id = due.id
RETURNING m.id, m.status, m.next_check_at;
```

**D-50 verdict:** the naive one-interval advance (`next_check_at + interval`) IS unsafe for stale monitors — a monitor that goes 40 minutes unclaimed (dark launch makes this the norm for every user monitor) would need 8 ticks at interval 5 to catch up, starving the scheduler's drain rate exactly when it needs to drain. `GREATEST(now() + interval, next_check_at + interval)` advances a far-behind monitor to `now + interval` in one claim while preserving monotonicity for on-time monitors. This amends §14 per the established amendment process and composes with D-49's re-seed (either mechanism alone suffices; both together are belt-and-suspenders). [VERIFIED: PostgreSQL GREATEST semantics + design reasoning; the §14 original text does NOT contain the GREATEST form — flag for the §14 amendment.]

### Pattern 3: Tier 1 — synchronous transition transaction (DAT-01/04, D-35)

**What:** One Postgres transaction: evidence ping INSERT → conditional monitor UPDATE → incident INSERT ON CONFLICT DO NOTHING (partial unique) → outbox INSERT → uptime_percent derived in the same UPDATE.

```sql
-- Source: docs/ARCHITECTURE-AUDIT.md §16.1 shape + D-35/D-36 extensions
BEGIN;
  INSERT INTO pings (id, "monitorId", status, "responseTime", "createdAt",
                     "error_class", "status_code")
  VALUES (DEFAULT, $1, $2, $3, now(), $4, $5);          -- gen_random_uuid default

  UPDATE monitors SET
    status = $2,
    "consecutiveFailures" = $6,
    "totalChecks" = "totalChecks" + 1,
    "failedChecks" = "failedChecks" + $7,
    "uptimePercent" = round(
        (100.0 * ("totalChecks" + 1 - "failedChecks" - $7)
             / ("totalChecks" + 1))::numeric, 2
    )::double precision,        -- ← the cast chain: see Pitfall 1
    "lastChecked" = now(),
    "nextCheckAt" = now() + (interval '1 minute' * interval)
  WHERE id = $1 AND status <> $2 AND "isActive";

  INSERT INTO incidents (id, "monitorId", status, description)
  VALUES (DEFAULT, $1, 'ONGOING', $8)
  ON CONFLICT DO NOTHING;       -- partial unique incidents_one_ongoing

  INSERT INTO outbox (id, event_type, monitor_id, incident_id, payload)
  VALUES (DEFAULT, $9, $1, $10, $11);
COMMIT;
```

Ordering note (01-01): the evidence ping precedes the conditional UPDATE — duplicates record evidence while transition effects stay gated by `WHERE status <> target`. Idempotency of the whole job rides on the `check:{monitorId}:{epoch}` jobId: a duplicate delivery that re-runs finds `status = target` and the UPDATE touches zero rows.

### Pattern 4: Tier 2 — guarded RENAMENX flush (DAT-02/03)

**What:** Routine-UP counters aggregate in Redis for ≤60 s, then one flush per monitor: RENAMENX the staging key to a batch-scoped snapshot name (atomic ownership handoff), insert a `write_guards` row `flush:{batchId}`, multi-row ping INSERT + additive counter UPDATE in one transaction.
**When to use:** every routine-UP check result; batchId = `{epochMs-of-flush-pass}:{monitorId}` (01-06) so retries are deterministic.

```typescript
// Source: docs/ARCHITECTURE-AUDIT.md §16.2 + 01-06 decision (STATE.md)
const renamed = await redis.renamenx(`stage:{monitorId}`, `flushstage:{batchId}`);
if (!renamed) return;   // someone else owns this flush — RENAMENX (not RENAME)
                        // is what survives crash-after-COMMIT redelivery (CR-02)
await db.transaction(async (tx) => {
  await tx.execute(sql`INSERT INTO write_guards (key) VALUES (${'flush:' + batchId})
                       ON CONFLICT DO NOTHING`);
  // guard row pre-exists ⇒ this batch already flushed ⇒ skip counters but the
  // RETURNING-style check drives the skip decision inside the same txn
  await tx.execute(sql`UPDATE monitors SET
      "totalChecks" = "totalChecks" + ${n},
      "failedChecks" = "failedChecks" + ${f},
      "uptimePercent" = round((100.0 * ("totalChecks" + ${n} - "failedChecks" - ${f})
          / ("totalChecks" + ${n}))::numeric, 2)::double precision,
      "lastChecked" = GREATEST(COALESCE("lastChecked", to_timestamp(0)), ${ts}),
      "responseTime" = ... -- additive/monotonic per §16.2; status NEVER written
    WHERE id = ${monitorId}`);
  await tx.execute(sql`INSERT INTO pings (...) SELECT ... `); -- multi-row
});
await redis.del(`flushstage:${batchId}`);   // after COMMIT only
```

### Pattern 5: Outbox relay + dedup (DAT-05/06, D-44..D-48)

**What:** Relay lane polls unsent outbox rows with `FOR UPDATE SKIP LOCKED` in batches, sends Telegram, marks sent; dedup via `SET NX EX` incident-keyed AFTER confirmed send; permanent Telegram failures throw `UnrecoverableError`.

```typescript
// Dedup key vocabulary (01-06): alert:{incidentId}:down | :recovered
//                              alert:{monitorId}:first_check
const alreadySent = await redis.set(
  dedupKey(event), '1', 'EX', 7 * 24 * 3600, 'NX');   // D-47: 7-day TTL
if (!alreadySent) { /* skip send, still mark row sent */ }

// Typed classification (D-45) — src/lib/telegram.ts swallows errors as
// true/false, so the relay WRAPS the send and inspects the failure itself:
if (isPermanentTelegramFailure(err))   // 400 chat-not-found / 401 / 403
  throw new UnrecoverableError(`telegram permanent: ${err}`);
// transient (5xx/network/timeout) ⇒ plain throw ⇒ BullMQ backoff, attempts ≤ 3
// attempts === 3 ⇒ mark row FAILED + retain (D-44) + metrics gauge + pino error
```

Telegram content: message SELECTION derives from `event_type`, but rendering must reuse the exact templates from `src/lib/cron-logic.ts` (three templates, `toLocaleString("en-US", { timeZone: user.timezone || "UTC", timeZoneName: "short" })` timestamps, `statusCode || "No Response / Timeout"` in the DOWN form) — byte-for-byte per D-48. [VERIFIED: codebase src/lib/cron-logic.ts lines with templates]

### Pattern 6: Circuit breaker, backlog cap, maintenance dry-run (RES-01/02, WRK-13)

**Breaker:** in-process counter of consecutive Postgres infra-failures (connection/timeout class only — target outcomes are successful jobs per WRK-05). 5 failures → OPEN: pause enqueue paths (NOT `queue.pause()` on the check queue if in-flight jobs should drain — the enqueue-side gate is cleaner and keeps the stalled checker out of the loop) for 60 s → HALF_OPEN: one probe = `write_guards` insert `breaker:probe:{ts}` → success ⇒ CLOSED, failure ⇒ re-OPEN. Restart resets to CLOSED (01-03: safe, first infra-failure re-arms within one tick). Verified BullMQ behavior that makes this work: a paused queue state persists in the `bull:{queue}:meta` key, and `queue.pause()` lets in-flight jobs finish — but for THIS design the breaker gates at enqueue time so the Redis-side pause semantic is not load-bearing. [VERIFIED: docs.bullmq.io pause semantics + STATE.md 01-03]

**Backlog cap:** before enqueueing a routine (priority-10) check, read `getJobCounts('wait','delayed','active')` on the check queue; above ~2× active monitors, drop + log + count (metrics counter). Transition lane is never gated — transition writes are synchronous inside check jobs (01-02). [CITED: docs.bullmq.io API — getJobCounts]

**Maintenance dry-run:** job payload `{ dryRun: true }` → SELECT counts (`pings` older than retention, per monitor) → emit report rows (pino + report structure for D-37's `uptime_percent` consistency check: stored value vs `round(100.0*(total-failed)/total::numeric,2)` recomputed per monitor, discrepancies listed, nothing written). `dryRun: false` → looped `DELETE ... WHERE id IN (SELECT id ... LIMIT 5000)` batches inside the maintenance queue only (DAT-08; statement_timeout 30 s is sized above this pass).

### Pattern 7: Process lifecycle — the two-signal readiness + drain (WRK-07/08, DEP-01)

```typescript
// Source: pm2.keymetrics.io/docs/usage/signals-clean-restart/ + runbook §4/§5
// (defaults verified: listen_timeout 3000ms, kill_timeout 1600ms)
import http from 'node:http';

const server = http.createServer(handler);       // :9090 via WORKER_HEALTH_PORT
server.listen(port, async () => {
  await pingRedis(); await pingDb();              // readyz preconditions
  if (process.send) process.send('ready');        // PM2 gate (wait_ready)
  logger.info({ sha: BUILD_SHA, builtAt: BUILD_TS }, 'worker booted'); // D-10
});

const shutdown = async (signal: string) => {
  server.close();
  await Promise.allSettled([checkWorker.close(), relayWorker.close(),
                            maintenanceWorker.close()]); // drain in-flight
  await pool.end(); await redis.quit();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

Facts verified this session [CITED: pm2.keymetrics.io / pm2.io best-practices]:
- `wait_ready: true` makes PM2 count start-success only on `process.send('ready')`; if never sent, PM2 force-restarts after `listen_timeout` — default **3000 ms**, so the runbook's 30000 pin is a deliberate raise (worker boot = connections + scheduler re-upserts + pings).
- `kill_timeout` default is **1600 ms** — far below a 10 s check + drain; the runbook's 20000 floor (P-1/DEP-01) must be in `ecosystem.config.js` (D-20 lands it now).
- PM2 sends SIGINT first, then SIGKILL after `kill_timeout`.
- The HTTP `:9090/readyz` and the process ready signal are DIFFERENT gates with different consumers (01-07): wiring only HTTP boot-crash-loops under `wait_ready`.

### Pattern 8: tsup bundle + boundary gate (WRK-14, D-02..D-08)

```typescript
// tsup.config.ts — every option verified from tsup 8.5.1 type definitions
// [VERIFIED: jsDocs.io/package/tsup]
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/worker/index.ts'],
  format: ['cjs'],                    // D-03
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  sourcemap: true,                    // D-04 (boolean; 'inline' also exists)
  skipNodeModulesBundle: true,        // D-02 externals — pg/ioredis/pino load
                                      // from the shipped node_modules
  platform: 'node',                   // (default 'node')
  target: 'node16',                   // (default) — safe under engines >=22
  splitting: false,                   // (CJS default; keep explicit)
  define: {                           // D-10 provenance option A (discretion)
    'process.env.WORKER_BUILD_SHA': JSON.stringify(process.env.GIT_SHA ?? ''),
    'process.env.WORKER_BUILD_TS': JSON.stringify(new Date().toISOString()),
  },
});
```

Boundary gate (D-08, discretion — cheapest tool): a small verify-step grep script is sufficient and adds no dependency:

```bash
# fails verify on any next/*/react/route-handler import inside src/worker/**
! grep -rE "from ['\"](next|react)(/|['\"])|from ['\"]@/app/" src/worker/
```

(A dependency-cruiser or eslint `no-restricted-imports` rule is the heavier alternative; the grep form matches the operator's make-everything-default posture and runs on Windows Git Bash identically.)

### Pattern 9: SSRF check pipeline (SEC-01, D-38..D-43)

**Layering (all inside `src/lib/ssrf.ts`, one exported pipeline):**

1. **Scheme allowlist** — `http:`/`https:` only; anything else is a target-level reject (WRK-05: successful job with DOWN/error_class, not an infra throw).
2. **Resolve-then-validate** — `dns.lookup({ all: true })` or `resolve4/resolve6`; canonicalize every address (IPv6-mapped IPv4 `::ffff:a.b.c.d` → extract the embedded IPv4; check both `::ffff:0:0/96` and `64:ff9b::/96` forms) then test against the 11-token CIDR denylist: `10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0.0.0.0/8, ::1, fc00::/7, fe80::/10, ::ffff:0:0/96, 64:ff9b::/96` [CITED: docs/ARCHITECTURE-AUDIT.md §15.1 + docs/DEPLOY-RUNBOOK.md §10 — the one-list-in-three-statements contract].
3. **Connection-time re-validation** — the dial must connect only to addresses from the resolve-time validated set (DNS-rebinding/TOCTOU defense). With undici: a custom `Agent` whose `connect` option restricts the connection to the validated IPs; with node:https: a custom `lookup` returning the pre-validated list. Plain `global fetch(url)` CANNOT do this — that is the whole reason the engine needs the client choice from Open Question 2.
4. **Redirect loop** — `redirect: 'manual'`; Node/undici DOES expose 3xx status + `Location` on manual (a documented Node deviation from browsers' `opaqueredirect`) so per-hop re-validation works: parse Location (relative resolution against the current URL), recurse through steps 1–3, ≤5 hops, no-validation-no-follow (classify as target behavior). [VERIFIED: nodejs/undici fetch documentation]
5. **2 MB cap + 10 s timeout** — stream `response.body`, count bytes, abort past 2 MB (Content-Length never trusted — a lying header smaller than the body is the classic bypass); AbortController at 10 s total.

```typescript
// Shape (illustrative — exact API rides the Open Question 2 decision)
export interface CheckRequest { url: string; timeoutMs?: number }
export type CheckOutcome =
  | { kind: 'up'; statusCode: number; responseTimeMs: number }
  | { kind: 'down'; statusCode: number | null; errorClass: string;
      responseTimeMs: number };          // WRK-05: target outcome, job succeeds
export async function performCheck(req: CheckRequest): Promise<CheckOutcome>
// SSRF violations surface as { kind: 'down', errorClass: 'SSRF_BLOCKED' } —
// a target-level outcome, never an infra throw.
```

### Anti-Patterns to Avoid

- **`RENAME` instead of `RENAMENX` for Tier 2 staging** — re-fails the CR-02 over-delete case on crash-after-COMMIT redelivery (01-06): RENAME would steal a batch another flush is mid-way through.
- **`FOR UPDATE SKIP LOCKED` outside the CTE** — an outer-level locking clause does not reach rows selected inside a `WITH` query; the lock must be attached to the CTE's SELECT.
- **Any unprioritized lane** — BullMQ default priority 0 processes BEFORE prioritized jobs; one unprioritized lane inverts J-6 for every other lane (§Pitfall 3).
- **`round(x, 2)` on a double precision column** — function `round(double precision, integer)` does not exist (error 42883); cast `::numeric` first (§Pitfall 1).
- **Plain `global fetch(url)` in the check engine** — cannot pin the dialed IP; DNS rebinding defeats resolve-then-validate (TOCTOU).
- **Custom jobId on scheduler-produced jobs** — not allowed by BullMQ; dedup belongs in the claim SQL + `check:{monitorId}:{epoch}` jobIds for ad-hoc jobs.
- **Wiring only the HTTP readyz** — under `wait_ready` PM2 never hears `process.send('ready')` and boot-crash-loops the worker after `listen_timeout`.
- **Auto-retry past the outbox attempt cap** — D-44: terminal FAILED + retain; re-drive is a deliberate operator action.
- **Trusting Content-Length for the byte cap** — enforce on the streamed body.
- **Running migrations at worker boot** — M-1; the runner is operator-run (§4 step 3).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Recurring job generation | Cron-in-process / setInterval + custom delayed jobs | BullMQ `upsertJobScheduler` | Exactly-one-delayed-job semantics, idempotent re-upsert on restart (RES-05), delayed→wait transition handled |
| Stalled-job detection & recovery | Heartbeat tables, custom lock sweeps | BullMQ stalled checker (lockDuration/stalledInterval/maxStalledCount) | Battle-tested; defaults match design pins; WRK-07 bounds config |
| Priority scheduling among lanes | Multiple queues polled by hand | BullMQ `priority` per job (explicit on EVERY lane) | Same-queue priority ordering is the J-6 mechanism; hand-rolling conflates with concurrency |
| Exponential backoff + attempt caps | Custom retry loops in processors | BullMQ `attempts` + `backoff` + `UnrecoverableError` | Native; DLQ retention via `removeOnFail` age forms |
| Atomic Redis multi-op (lock release, INCR+EXPIRE) | GET → compare → DEL sequences | One Lua script per atomic op (`EVAL`) | The 03-01 `rlIncr` precedent; non-atomic sequences strand state (TTL-less counters, released-then-reacquired locks) |
| CJS bundling + externals + sourcemaps | Hand-written tsc + cat + wrapper shims | tsup config (8 lines) | Verified options; D-02 lock; swappable if maintenance bites |
| JSON log formatting + child bindings | console.log JSON.stringify | pino + `logger.child({ monitorId })` | 5x+ faster, level via env, bundling supported; transports deliberately unused |
| Queue counts/metrics | SCAN key counting | `queue.getJobCounts(...)` | O(1) Redis-side counts vs full keyspace scans |

**Key insight:** every hand-rolled version of the BullMQ-native mechanisms above reintroduces a crash/restart edge case the library already solved (stalled recovery, delayed job uniqueness, backoff timing) — in the exact domain (Redis restarts, SIGKILL mid-job) this phase's injection suite exists to prove.

## Common Pitfalls

### Pitfall 1: PostgreSQL `round(double precision, integer)` does not exist
**What goes wrong:** D-35's `uptime_percent = round(100.0 * up / total, 2)` throws `42883: function round(double precision, integer) does not exist` because `monitors.uptimePercent` is `double precision` (schema.ts line 89) and `round(x, n)` is only defined for `numeric`.
**Why it happens:** Postgres overloads `round(numeric, integer)` and `round(double precision)` (whole-number) — the two-arg form never accepts double precision.
**How to avoid:** `round((100.0 * up / total)::numeric, 2)::double precision`. ALSO: keep `100.0` (float-typed) so the division isn't integer division, and match the legacy JS baseline for parity — the JS stores the raw clamped float `Math.max(0, Math.min(100, ((t-f)/t)*100))` while the *displayed* parity surface is `toFixed(2)` rendering; D-36's writer tests must assert SQL `round(...::numeric,2)` equals JS `(x).toFixed(2)` at the edge ratios (0 checks, all-up, all-down, 1/3) and adjust the SQL form if NUMERIC half-even rounding disagrees with JS float formatting at an edge.
**Warning signs:** first Tier 1 test failing with 42883; uptime_percent parity test diffs at .xx5 boundaries.
[VERIFIED: PostgreSQL docs (round overloads) + codebase src/db/schema.ts + src/lib/cron-logic.ts]

### Pitfall 2: tsup is unmaintained
**What goes wrong:** no upstream fixes for future Node/bundler incompatibilities; the phase's build chain depends on a frozen tool.
**Why it happens:** the README states the project is not actively maintained and points to tsdown as successor.
**How to avoid:** D-02 locks it regardless — mitigate by keeping the config to the minimal verified option set (Pattern 8), adding NO tsup plugins/experimental flags, and treating the bundler as a swappable seam (the same 8 options exist in tsdown). Open Question 1 asks the operator to acknowledge.
**Warning signs:** esbuild peer/runtime errors under future Node upgrades; nothing this phase.
[VERIFIED: tsup README via tsup.egoist.dev]

### Pitfall 3: BullMQ priority inversion — unprioritized jobs run FIRST
**What goes wrong:** a lane that omits `priority` (default 0) preempts every prioritized job in the same queue, inverting J-6 (manual/non-UP must beat routine).
**Why it happens:** verified BullMQ semantics — jobs WITHOUT explicit priority are placed in a higher-priority position than priority-0 jobs; "default 0" is not "middle of the road".
**How to avoid:** the 01-02 pin — every lane sets explicit priority (manual/non-UP 1, tick/relay/alerts 1, maintenance/email 5, routine 10). Add a boot-time or test-time assertion that every enqueue path passes a priority.
**Warning signs:** resilience/latency tests showing routine checks jumping ahead of transition work under flood (injection case 7 turning red).
[VERIFIED: docs.bullmq.io guide/prioritized]

### Pitfall 4: `FOR UPDATE SKIP LOCKED` at the wrong query level
**What goes wrong:** claim transaction locks nothing (or deadlocks) when the locking clause sits on the outer UPDATE instead of the CTE's SELECT.
**Why it happens:** PostgreSQL row locks apply where rows are fetched; a `WITH due AS (... FOR UPDATE SKIP LOCKED)` is the canonical pattern, and moving the clause outside silently changes scope.
**How to avoid:** transcribe Pattern 2 exactly; integration test asserts two concurrent claims never return the same monitor.
**Warning signs:** duplicate `check:{monitorId}:{epoch}` processing attempts; contention errors under the flood injection.
[VERIFIED: PostgreSQL CTE/locking semantics — canonical SKIP LOCKED queueing pattern]

### Pitfall 5: Confusing BullMQ's lock with the per-monitor application lock
**What goes wrong:** assuming `lockDuration` makes double-processing impossible, so the per-monitor SET-NX lock (WRK-04) looks redundant and gets skipped.
**Why it happens:** BullMQ's lock covers *job processing stall detection* (worker heartbeat), not mutual exclusion across differently-keyed jobs for the same monitor (manual + tick jobs, or a re-enqueued duplicate after a stall).
**How to avoid:** both layers: BullMQ stalled config (WRK-07: lockDuration 30000 / stalledInterval 30000 / maxStalledCount 1 — defaults match, pin them explicitly anyway) AND the per-monitor lock (TTL = timeout + margin, renew at TTL/3, owner-token Lua compare-and-delete, abort-on-lock-loss mid-job = re-check before Tier 1 commit).
**Warning signs:** injection case 5 (lock-loss) double-writes; two ONGOING incidents.
[VERIFIED: docs.bullmq.io stalled + locks docs; design WRK-04]

### Pitfall 6: KeepJobs (removeOnComplete/removeOnFail) eviction is LAZY
**What goes wrong:** DLQ/retention "age" cleanup never fires on an idle queue — completed/failed jobs linger past their `age` because eviction runs only when another job in the same queue completes or fails; Redis memory creeps on a 512 MB noeviction instance.
**Why it happens:** verified BullMQ behavior — no background timer drives KeepJobs.
**How to avoid:** size retention for worst case (age bound × max arrival), keep the `/metrics.json` Redis memory % gauge (D-25) wired from day one, and let the maintenance dry-run report queue key sizes. Not a reason to hand-roll deletion.
**Warning signs:** `bull:*` keyspace growth during dark launch with sparse enqueues.
[VERIFIED: docs.bullmq.io guide Retention — lazy eviction caveat]

### Pitfall 7: A removed jobId no longer deduplicates
**What goes wrong:** if a completed check job's record is evicted (KeepJobs age) and a retry/duplicate with the SAME custom jobId arrives later, BullMQ accepts it as new — dedup memory is the job record itself.
**Why it happens:** verified semantics — custom-jobId uniqueness lasts only while the record exists.
**How to avoid:** this is why alert dedup lives in Redis `SET NX EX` (D-47) and write idempotency lives in Postgres (`status <>` guard + write_guards + jobId as first line of defense, not the only one). Never rely on jobId alone for cross-restart exactly-once.
**Warning signs:** duplicate alert sends after a long-idle period.
[VERIFIED: docs.bullmq.io custom jobIds + retention docs]

### Pitfall 8: Windows dev-machine signal semantics constrain the resilience suite
**What goes wrong:** on win32, `process.kill(child, 'SIGINT')` is not deliverable programmatically — Node maps it to TerminateProcess; only terminal Ctrl+C produces a real SIGINT to a child. SIGKILL works as a hard kill (D-29's kill-mid-job test is therefore automatable as-is). But any test automating the SIGINT graceful-drain path for a spawned worker cannot do so natively on Windows.
**Why it happens:** Windows lacks POSIX signals; Node's emulation covers SIGKILL-ish termination, not interactive interrupts.
**How to avoid:** (a) D-29 (SIGKILL mid-job at a marked checkpoint) runs natively — verified viable; (b) for SIGINT-drain automation, run the worker under a Linux docker container (dev machine already runs docker for the test stacks) or disposition it like the PM2 handshake (D-15's N/A-locally register) and prove drain in the `pnpm rehearse:worker` Linux-container leg; (c) alternatively exercise the drain FUNCTION by invoking the shutdown handler directly in-process in a vitest test (unit-level) plus the container leg for the signal-level proof.
**Warning signs:** resilience tests hanging on undelivered SIGINT; "worker exited without draining" false failures on Windows only.
[VERIFIED: Node.js process.kill Windows documentation]

### Pitfall 9: tsx is not actually a direct dependency
**What goes wrong:** `pnpm dev:worker` (D-07) references tsx assuming it is "already present" — it is present only TRANSITIVELY (vitest→vite chain) in the lockfile; pnpm's strict node_modules means a direct bin reference may not resolve, and a future vitest change could remove it entirely.
**Why it happens:** CONTEXT's integration-points note says "tsx already present" — true in the lockfile graph, false as a declared dependency.
**How to avoid:** add `tsx` to devDependencies explicitly (4.23.13 current).
**Warning signs:** `pnpm dev:worker` failing with command-not-found after any dependency refresh.
[VERIFIED: codebase package.json — tsx absent from devDependencies, present in pnpm-lock as transitive]

### Pitfall 10: pnpm allowBuilds and esbuild's install script
**What goes wrong:** after adding tsup, pnpm 10 silently skips esbuild's postinstall (not in `pnpm-workspace.yaml` allowBuilds), and IF the platform optional-dependency binary path ever misses, the bundle build fails with a confusing "esbuild binary not found".
**Why it happens:** pnpm 10's build-scripts approval model (the same one that allowlists prisma/unrs-resolver today).
**How to avoid:** expect the install warning listing esbuild as skipped; the binary normally arrives via `@esbuild/win32-x64` optional deps so the build works without the script. If the first `pnpm build` fails on the binary, add `esbuild` to allowBuilds and reinstall.
**Warning signs:** `<package> ignored build scripts: esbuild` in install output followed by bundle failure.
[ASSUMED — verify at first install/build]

### Pitfall 11: Scheduler-produced jobs and custom jobIds
**What goes wrong:** trying to pass `jobId` in the upsertJobScheduler template to make ticks dedupable — BullMQ rejects custom jobIds for scheduler-produced jobs.
**Why it happens:** the scheduler owns occurrence naming to guarantee exactly-one-delayed-job semantics.
**How to avoid:** scheduler jobs take no custom jobId; idempotency of the tick lives in the claim SQL (next_check_at advance). Custom jobIds are for ad-hoc jobs only: `check:{monitorId}:{epoch}` and `check:{monitorId}:manual:{epochMs-of-enqueue}` (01-08).
**Warning signs:** upsert errors at boot; duplicate tick processing appearing in logs.
[VERIFIED: docs.bullmq.io job-schedulers docs]

### Pitfall 12: Pause semantics vs the dark-launch flag
**What goes wrong:** implementing the scheduler pause as `queue.pause()` at boot instead of skipping the upsert — a paused queue ALSO blocks operator smoke enqueues from processing (D-18's whole point is that enqueued jobs exercise real machinery).
**Why it happens:** "pause the scheduler" reads as "pause the queue".
**How to avoid:** D-16's exact mechanic — the flag suppresses `upsertJobScheduler` calls at boot only; workers/consumers/health/relay all run live. `queue.pause()` is a different tool (potential breaker OPEN behavior — and even there, enqueue-side gating is preferred per Pattern 6).
**Warning signs:** smoke enqueue sits in `wait` forever during dark launch.
[VERIFIED: docs.bullmq.io pause semantics + D-16 text]

## Code Examples

### BullMQ worker connection shape (worker-side pins)

```typescript
// Source: .claude/skills/redis-connections/SKILL.md + docs.bullmq.io guide/connections
// BullMQ requires dedicated connections; worker instances need
// maxRetriesPerRequest: null (blocking commands must not time out client-side).
import IORedis from 'ioredis';

export function workerConnection(): IORedis {
  return new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,      // REQUIRED for Worker/QueueEvents
    enableReadyCheck: true,
  });
}
// Worker consumes TWO connections by design (queue + blocking) — the §25/OBS-05
// worker budget of 2 Redis connections is exactly this pair.
```
[CITED: project skill + BullMQ connection docs; budget VERIFIED: codebase §25]

### Worker entry skeleton (D-11/D-12/D-13/D-16)

```typescript
// src/worker/index.ts
import 'dotenv/config';                       // D-12 — FIRST, before anything
import { buildLogger } from './logger';        // pino, level via env, stdout only
const logger = buildLogger();

async function main() {
  assertEnv();                                 // REDIS_URL, DATABASE_URL,
                                              // WORKER_SCHEDULER_ENABLED?, WORKER_HEALTH_PORT
  const shutdown = await bootWorker({          // queues, workers, relay, maintenance
    schedulerEnabled: process.env.WORKER_SCHEDULER_ENABLED === 'true', // D-16
    healthPort: Number(process.env.WORKER_HEALTH_PORT ?? 9090),        // D-13
    logger,
  });
  registerSignals(shutdown);                   // Pattern 7
}
main().catch((err) => { logger.error({ err }, 'fatal boot'); process.exit(1); });
```

### Claim → lane assignment → jobId derivation (WRK-03/WRK-12)

```typescript
// 01-02 pin: RETURNING (id, status, next_check_at) drives lane choice + jobId
const claimed = await claimDue(batchSize);      // Pattern 2 SQL
for (const row of claimed) {
  const priority = row.status === 'UP' ? 10 : 1;        // non-UP beats routine
  await checkQueue.add('check', { monitorId: row.id }, {
    priority,
    jobId: `check:${row.id}:${Math.floor(row.nextCheckAt.getTime() / 1000)}`,
    attempts: 5, backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600 }, removeOnFail: { age: 14 * 24 * 3600 }, // DLQ 14d
  });
}
// failed-enqueue compensation (J-1): on add() rejection, roll next_check_at
// BACK one interval inside a small UPDATE so the next tick re-claims it.
```

### pino monitorId correlation (OBS-02)

```typescript
// Source: getpino.io README (child loggers verified)
const base = pino({ level: process.env.WORKER_LOG_LEVEL ?? 'info' }); // stdout default
const log = base.child({ monitorId, jobId });   // every line carries both
log.info({ statusCode, responseTimeMs }, 'check complete');
```
[VERIFIED: getpino.io — child bindings merge into each JSON line]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| BullMQ legacy repeatables (`repeat` job opts) | `upsertJobScheduler` | BullMQ v5/v6 (repeatables removed in v6) | WRK-02's explicit requirement; any pre-v6 snippet using `repeat: { cron }` is wrong for this phase |
| `tsup` as the default Node bundler | tsdown (successor); tsup frozen | tsup README, current | D-02 keeps tsup; config surface verified; swappable seam |
| Node global fetch as plain call | dispatcher/Agent-scoped fetch for IP pinning | undici-in-Node era, ongoing | SSRF TOCTOU defense requires the npm undici package (or node:https custom lookup) |
| pino v6-era patterns | pino 10.x (current) | major versions since | Nothing exotic needed: child loggers + stdout are stable APIs |
| pnpm onlyBuiltDependencies | `allowBuilds` vocabulary | pnpm 11 changed config vocabulary | Repo pins 10.34.5 — keep using allowBuilds as-is (03 runbook Pitfall 7) |

**Deprecated/outdated:**
- BullMQ v6: legacy repeatable jobs — removed; do not transcribe any `repeat:`-based scheduling.
- tsup — unmaintained (README notice); still functional for this scope.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | esbuild works without allowBuilds entry (binaries via platform optionalDependencies); add to allowBuilds only if the first build fails | Pitfall 10, Package Audit | First `pnpm build` fails on missing binary — one-line allowBuilds fix, low risk |
| A2 | undici `Agent` connect-scoped IP pinning API shape (`new Agent({ connect: ... })`) — package verified, exact option path not re-confirmed against docs this session | Pattern 9, Open Questions | API-name-level correction during implementation; the node:https fallback exists |
| A3 | relay batch size / cadence default suggestion (50 rows / 5 s poll) within §14's pinned shape | Pattern 5 | Pure discretion item — planner sets it; no external truth to be wrong about |
| A4 | Telegram permanent-failure classification catches (400 chat-not-found, 401, 403) as enumerated | Pattern 5, D-45 | Enum comes from D-45 text (locked); exact status-code mapping verified at implementation against Bot API docs |
| A5 | `getJobCounts('wait','delayed','active')` is the right depth sum for the backlog cap | Pattern 6 | Wrong mask over/under-counts depth; trivially adjusted once metrics are live (D-33 records the dataset) |

**All other claims** in this research are [VERIFIED: source] or [CITED: source] as tagged inline — no user confirmation needed for those.

## Open Questions

1. **tsup maintenance status — operator acknowledgment (D-02 conflict).**
   - What we know: tsup's README says unmaintained, recommends tsdown; D-02 locks tsup; needed options are 8 verified lines.
   - What's unclear: whether the operator wants to (a) proceed on tsup per D-02 as locked, or (b) treat this as new information justifying a swap before the dependency lands.
   - Recommendation: proceed with tsup (locked decision, minimal surface, swappable); the planner should surface this at the dependency checkpoint (human-verify) rather than silently installing an unmaintained tool.
2. **Check-engine HTTP client: npm undici vs zero-dep node:https.**
   - What we know: both can pin the dial to resolve-time-validated IPs (undici Agent / node:https custom lookup); D-41 names `fetch`; global fetch alone cannot pin.
   - What's unclear: nothing material — this is a discretion recommendation needing planner sign-off because it adds a runtime dependency.
   - Recommendation: npm `undici` 8.x (`fetch` + `Agent`) — keeps D-41's fetch semantics, streaming byte cap, and redirect-manual handling in one maintained client from the Node core team; fallback documented in Standard Stack if the operator prefers zero new runtime deps.
3. **SIGINT-drain automation platform (Pitfall 8).**
   - What we know: Windows cannot deliver SIGINT to a spawned child programmatically; SIGKILL-based D-29 works natively; docker is present on the dev machine.
   - What's unclear: whether the resilience suite should carry a Linux-container leg for the signal-level drain proof, or disposition it N/A-locally (D-15 pattern) with drain proven unit-level (direct handler invocation) plus in the rehearsal.
   - Recommendation: unit-level drain test + rehearse:worker container leg; keep `pnpm test:resilience` free of docker-in-docker complexity on Windows.
4. **D-34 RES-03 staleness pin — confirm the existing UI surfaces aging lastChecked.**
   - What we know: dashboards display `lastChecked` from monitor rows (cron path) — when checks stop, the displayed age grows; the research pass found no gap needing new UI.
   - What's unclear: the exact component/format (relative "Xm ago" vs raw timestamp) — the pinning test needs the concrete surface named at planning time.
   - Recommendation: planner adds a small test-writing task that first locates the exact rendering (Dashboard/Status components), then pins it; disposition anything genuinely missing per D-34.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (>=22 <25) | worker runtime, build | ✓ | 24.15.0 (dev machine) | — |
| pnpm | package management, verify chain | ✓ | 10.34.5 (pinned) | — |
| Docker | test stack (5453/6390), rehearsal throwaway, SIGINT container leg | ✓ | in use since Phase 2 | — |
| PostgreSQL 17 | worker data layer, tests | ✓ | postgres:17-alpine test stack; production stand-in spidernode-dev-db 17.7 | — |
| Redis 8 | BullMQ, locks, staging, dedup | ✓ | redis:8-alpine test stack; hardened local stand-in (03-08) | — |
| Port 9090 | worker health server | ✓ (assumed free locally) | — | WORKER_HEALTH_PORT overrides (D-13) |
| Ports 5453/6390 | test stack | ✓ | 02-02 deviation pins | exclusive ownership during test:resilience (D-30) |
| Telegram Bot API | outbox relay (dark-launch smoke alert path) | ✓ (token exists in env per INTEGRATIONS) | — | relay is synthetic-monitor-only this phase |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none — all runtime/test dependencies verified present on the dev machine stand-in topology.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.11 (+ @vitest globals via existing config) |
| Config file | `vitest.config.ts` (urls 5453/6390, `fileParallelism: false`, include `tests/**/*.test.ts`) |
| Quick run command | `pnpm test` (inside `pnpm verify`) |
| Full suite command | `pnpm verify` (lint → typecheck → test → build → e2e, ≤5 min) + separate `pnpm test:resilience` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WRK-02/12 | lanes/priorities: every enqueue explicit priority; priority ordering manual/non-UP before routine | unit+integration | `pnpm test -- tests/worker/queues.test.ts` | ❌ Wave 0 |
| WRK-03 | claim: SKIP LOCKED exclusion, catch-up-safe advance, jobId derivation, J-1 compensation | integration | `pnpm test -- tests/worker/claim.test.ts` | ❌ Wave 0 |
| WRK-04 | lock: acquire/renew/Lua-release/abort-on-loss | integration | `pnpm test -- tests/worker/locks.test.ts` | ❌ Wave 0 |
| WRK-05/DAT-10 | classification: target outcomes succeed with error_class/status_code; infra throws | unit | `pnpm test -- tests/worker/engine.test.ts` | ❌ Wave 0 |
| WRK-06 | retries/backoff/DLQ retention forms | integration | `pnpm test -- tests/worker/retries.test.ts` | ❌ Wave 0 |
| WRK-07 | graceful drain (handler-level) + stalled config pinned | unit+integration | `pnpm test -- tests/worker/shutdown.test.ts` | ❌ Wave 0 (signal-level: rehearsal container leg) |
| WRK-08 | healthz/readyz/metrics.json + provenance + ready signal after pings | integration | `pnpm test -- tests/worker/health.test.ts` | ❌ Wave 0 |
| WRK-10/D-16 | scheduler flag false ⇒ no scheduler job upserted; consumers live | integration | `pnpm test -- tests/worker/scheduler-flag.test.ts` | ❌ Wave 0 |
| WRK-13/D-37 | maintenance dry-run reports counts + uptime_percent consistency without writes | integration | `pnpm test -- tests/worker/maintenance.test.ts` | ❌ Wave 0 |
| WRK-14/D-08/D-40 | boundary gate + denylist diff + one-build-two-artifacts | gate | `pnpm verify` (gate steps) + `pnpm test -- tests/worker/build-gate.test.ts` | ❌ Wave 0 |
| DAT-01/03/04 | Tier 1: single-transaction transition, conditional update, one-ongoing, outbox row | integration | `pnpm test -- tests/worker/persist-tier1.test.ts` | ❌ Wave 0 |
| DAT-02 | Tier 2: staging aggregation, RENAMENX ownership, guarded flush, never writes status | integration | `pnpm test -- tests/worker/persist-tier2.test.ts` | ❌ Wave 0 |
| DAT-05/06/D-44..48 | relay: batched SKIP LOCKED, dedup NX EX, ≤3 attempts, FAILED retain, Telegram byte parity | integration | `pnpm test -- tests/worker/outbox-relay.test.ts` | ❌ Wave 0 |
| DAT-07 | id-omitting inserts produce UUID PKs (never undefined) | integration | covered in persist-tier1/tier2 files | ❌ Wave 0 |
| DAT-08 | retention deletes batched in maintenance lane only | integration | maintenance.test.ts | ❌ Wave 0 |
| D-35/D-36 | uptime_percent SQL derivation byte-parity vs JS at edge ratios | integration | `pnpm test -- tests/worker/uptime-parity.test.ts` | ❌ Wave 0 |
| SEC-01/D-42/D-43 | SSRF: denylist per hop, IPv6-mapped/short/decimal forms, redirect crossings, streamed 2 MB cap, 10 s timeout | unit (local HTTP test server) | `pnpm test -- tests/lib/ssrf.test.ts` | ❌ Wave 0 |
| OBS-01/D-24/D-25 | metrics.json field completeness (depth, age, stalled, latency, Redis mem%) | integration | health.test.ts | ❌ Wave 0 |
| OBS-02 | pino child-logger monitorId correlation shape | unit | `pnpm test -- tests/worker/logger.test.ts` | ❌ Wave 0 |
| RES-01..05/D-28 | seven injection cases (container stop/start, real SIGKILL child, flood) | resilience (separate) | `pnpm test:resilience` | ❌ Wave 0 |
| RES-03/D-34 | staleness surface pinned (existing lastChecked display) | e2e/unit | locate-then-pin task | ❌ Wave 0 |
| DEP-01/02 | deploy-day ordering end-to-end | rehearsal (operator) | `pnpm rehearse:worker` | ❌ Wave 0 (script) |

### Sampling Rate
- **Per task commit:** `pnpm test` (or the touched file's command above).
- **Per wave merge:** `pnpm verify` (≤5 min, D-27 excludes resilience).
- **Phase gate:** `pnpm verify` + `pnpm test:resilience` + `pnpm rehearse:worker` evidence file + dark-launch smoke (D-18) before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `tests/worker/` suite skeleton + shared worker-boot harness (in-process workers; decide global-setup extension vs per-file beforeAll — discretion item) — covers WRK/DAT/OBS rows
- [ ] `tests/lib/ssrf.test.ts` + local HTTP test server fixture (redirects, byte-cap stream, denylist vectors)
- [ ] `pnpm test:resilience` script + vitest project/config for the seven injection cases (exclusive test-stack ownership, D-30)
- [ ] `scripts/rehearse:worker.mjs` (03-05 pipeline pattern, own throwaway ports)
- [ ] `scripts/enqueue-smoke.mjs`, `scripts/redrive-outbox.mjs`, `scripts/seed-synthetic.sql`
- [ ] Verify-gate additions: boundary grep (D-08) + denylist diff (D-40) wired into the `pnpm verify` chain
- [ ] `.env.example`: `WORKER_SCHEDULER_ENABLED`, `WORKER_HEALTH_PORT` (+ `WORKER_LOG_LEVEL` if adopted)

*(Existing infrastructure — docker test stack, global-setup, drizzle migrate runner, fileParallelism discipline — is reused, not rebuilt.)*

## Security Domain

(config: `security_enforcement` enabled, ASVS Level 1 — matching Phase 2/3 closeouts.)

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Worker authenticates TO Redis/Postgres with existing credentials (REDIS_URL/DATABASE_URL); no user-facing auth surfaces this phase |
| V3 Session Management | no | No sessions in the worker |
| V4 Access Control | yes (internal) | Worker-bound enqueues are operator-script-only during dark launch (D-19); health endpoints bind the port but expose no mutating surface — bind 127.0.0.1 and keep provenance/metrics free of secrets |
| V5 Input Validation | yes | `src/lib/ssrf.ts` IS the input-validation layer for all checked URLs: scheme allowlist, resolve-then-validate CIDR denylist per hop, redirect ceilings; error payloads never echo internals |
| V6 Cryptography | no | No crypto hand-rolled; UUIDs via Postgres `gen_random_uuid()` |
| V12 File & Resources | yes (adjacent) | 2 MB streamed byte cap + 10 s timeout bound resource consumption per check (D-43) |

### Known Threat Patterns for the worker/BullMQ/SSRF stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSRF via user-supplied monitor URL (metadata endpoints, internal ranges) | Information Disclosure / Elevation | Resolve-then-validate 11-token CIDR denylist + per-hop re-validation + connection-time IP pinning (SEC-01; §15.1) |
| DNS rebinding (TOCTOU between validation and dial) | Information Disclosure | Connection restricted to resolve-time validated address set (undici Agent / node:https lookup) |
| SSRF bypass via IPv6-mapped IPv4 / short / decimal IP forms | Spoofing | Address canonicalization before denylist test (D-42 test vectors) |
| Oversized response DoS (worker memory) | DoS | Streamed byte cap at 2 MB; Content-Length untrusted (D-43) |
| Alert spam / duplicate notifications on retry storms | Tampering (user-trust) | Incident-keyed `SET NX EX` dedup after confirmed send + ≤3 attempt cap + FAILED retain (DAT-06/D-44/D-47) |
| Redis poisoning of staging → bad counters | Tampering | Redis loopback+auth (03-08 hardening); Tier 2 flush writes additive-only, never `status`; Postgres guards re-application |
| Secret leakage via logs/metrics | Information Disclosure | pino bindings restricted to ids/timings; no tokens in child-logger fields; health endpoints carry no secrets (runbook S-4 posture) |
| Queue flooding (backlog) → worker starvation | DoS | Backlog cap drops routine lane, logs/counts, transition lane ungated (RES-02) |

## Project Constraints (from CLAUDE.md)

- GSD workflow enforcement: Phase 4 work proceeds through `/gsd-plan-phase` → `/gsd-execute-phase` (this research is that flow's artifact); no direct repo edits outside GSD.
- Behavior compatibility is the milestone's core value: monitoring semantics (1-strike DOWN, lifetime uptime math, Telegram content, API shapes) preserved through cutover — D-36/D-48 exist because of this constraint.
- Deployment: single VPS, two PM2 apps, forward-only additive-first migrations, health gates (`readyz`) before a release counts as good (DEP-02 ordering).
- TypeScript strict, 2-space indent, path alias `@/*`; comments in English; ESLint 9 flat config. Worker code joins the root tsconfig (D-09).
- No emojis in project docs/comments; logs never contain secrets (project conventions honored in the pino design).

## Sources

### Primary (HIGH confidence)
- docs.bullmq.io — job-schedulers (`upsertJobScheduler` semantics, exactly-one-delayed-job, no custom jobIds), prioritized jobs (default-0-first), stalled jobs (lockDuration 30000/stalledInterval 30000/maxStalledCount 1), retention/KeepJobs (lazy eviction, removed-jobId caveat), pause semantics, connections (maxRetriesPerRequest: null)
- npm registry (`npm view`, 2026-09-13) — bullmq 6.3.4, pino 10.3.1, tsup 8.5.1, tsx 4.23.13, undici 8.10.2, ioredis 6.0.0
- jsDocs.io/package/tsup@8.5.1 — full Options type (format/sourcemap/skipNodeModulesBundle/define/platform/target/splitting verified)
- getpino.io — README (child loggers, stdout JSON default, bundling support, transports-not-used)
- pm2.keymetrics.io (signals/clean-restart) + pm2.io best-practices — wait_ready/`process.send('ready')`, listen_timeout default 3000 ms, kill_timeout default 1600 ms, SIGINT→SIGKILL
- PostgreSQL documentation — `round` overloads (numeric vs double precision), GREATEST, CTE `FOR UPDATE SKIP LOCKED` semantics
- Node.js documentation — Windows process.kill signal semantics (SIGKILL hard-kill; SIGINT not programmatically deliverable)
- Codebase (read this session) — `src/db/schema.ts`, `src/lib/cron-logic.ts`, `src/lib/telegram.ts`, `src/lib/db-pool.ts`, `src/lib/redis.ts`, `package.json`, `vitest.config.ts`, `docker-compose.test.yml`, `pnpm-workspace.yaml`, `tests/setup/global-setup.ts`

### Secondary (MEDIUM confidence)
- docs/ARCHITECTURE-AUDIT.md §13–§16, §23, §25 (in-repo design docs, verdict READY — transcription sources, not external truth)
- docs/DEPLOY-RUNBOOK.md §4/§4a/§5/§10 (in-repo runbook)
- tsup README (unmaintained notice) via tsup.egoist.dev
- nodejs/undici docs — redirect:'manual' exposes status+Location in Node; dispatcher option on fetch

### Tertiary (LOW confidence)
- None relied upon for any recommendation; all ASSUMED items are logged in the Assumptions Log.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified on the registry this session; option-level config verified against tsup types and pino README; legitimacy gate run (no SLOP; three canonical packages flagged by the recency heuristic only)
- Architecture: HIGH — the design was adjudicated in Phase 01; this research verified the BullMQ 6 behaviors it depends on (scheduler, priorities, stalled, pause, retention) against official docs and found no contradiction; one SQL-level correction required (round cast) and one §14 amendment required (GREATEST catch-up advance, D-50)
- Pitfalls: HIGH for library/DB behavior (all verified); MEDIUM for environment-specific items (A1/A2 assumptions logged)
- Dark-launch mechanics: HIGH — flag-not-pause verified as the correct BullMQ pattern; rollback story requires no code path

**Research date:** 2026-09-13
**Valid until:** 2026-10-13 (stable domain; BullMQ 6.x and the design docs are the moving surfaces — re-check bullmq patch releases if planning slips past ~30 days)
