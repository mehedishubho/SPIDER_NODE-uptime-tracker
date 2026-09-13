# Phase 4: Monitoring Worker — Build & Dark Launch - Context

**Gathered:** 2026-09-13
**Status:** Ready for planning

<domain>
## Phase Boundary

All monitoring execution moves into a dedicated worker process on durable, idempotent, resilient BullMQ 6 machinery: the scheduler/claim engine, per-monitor locks, idempotency keys, retries/backoff/DLQ, two-tier persistence (synchronous Tier 1 transition transactions + ≤60 s guarded Tier 2 routine flush), the Postgres circuit breaker, backlog-cap drop policy, the SSRF-hardened check engine, outbox-based alerting with dedup, worker health endpoints (`:9090` healthz/readyz + metrics snapshot), `monitorId`-correlated structured logging, the maintenance queue with dry-run, and the two-PM2-app deploy form. Everything is proven by a seven-case failure-injection suite plus a full deploy-day rehearsal, then **dark-launched** on the local stand-in topology with the scheduler paused while the existing cron serves every user unchanged.

**Not in this phase:** cron deletion, heartbeat move, overlap-window cutover, outbox-age alerting, Prometheus export (all Phase 5); web-side enqueue/API thinning (Phase 6); any user-facing behavior change. `cron-logic.ts`, `db-batcher.ts`, and `instrumentation.ts` are untouched — they die at Phase 5 cutover, not before.

</domain>

<decisions>
## Implementation Decisions

### Pre-planning prerequisite (carried blocker, not a choice)
- **The 03-REVIEW repairs must land BEFORE any Phase-4 `drizzle-kit generate`:** CR-01 (stale `drizzle/meta/0001_snapshot.json`) + WR-01 (`timestamptz_ops` on boolean `idx_monitors_due` in schema.ts) — otherwise the first generate emits duplicate 0001 DDL. Fix via `/gsd-code-review 03 --fix` before `/gsd-plan-phase 4`. WR-05 (hard-coded journal count) before Phase 7 reuse; WR-02/WR-06 fix opportunistically/with Phase 6. The repaired snapshot should yield an **empty diff** — Phase 4's goal is **zero new migrations** (a 0002 only if planning finds a real gap: additive-only, full rehearsal pipeline).

### Worker build & repo topology (WRK-14)
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

### Dark launch on the local stand-in (WRK-10, DEP-01/02)
- **D-15:** **Plain processes + disposition register (03-08 pattern).** Web (`pnpm start`) and worker (`node dist/worker.js`) run as plain processes on the local stand-in; PM2-specific mechanics (wait_ready handshake, kill_timeout, crash-loop visibility) are dispositioned **N/A-locally** in `04-DEPLOY-RECORD.md`, forward-tracked to the first VPS deploy. What CAN be honestly tested locally (SIGINT drain, healthz/readyz HTTP, restart-recovery) IS tested — via process kill/restart. Real-PM2-on-Windows was rejected: Windows signal emulation makes the handshake a false-fidelity rehearsal.
- **D-16:** **Scheduler pause = `WORKER_SCHEDULER_ENABLED=false` env flag — the scheduler job is NOT upserted at boot.** Everything else (queue workers, health endpoints, relay, maintenance consumers) runs live so any enqueued job exercises real machinery. One flag gates ALL recurring scheduling (check tick + maintenance scheduler); retention cleanup keeps running via the old cron path until Phase 5. Maintenance jobs remain manually enqueuable for dry-run testing regardless of the flag. Phase 5 flips this flag as the cutover lever.
- **D-17:** **SEC-02 (OS-level egress) dispositioned to the first VPS deploy** (§3c precedent): runbook §10 iptables/nftables rules authored and verified as text, forward-tracked in the deploy record. SEC-01's engine-level SSRF layer IS built and test-proven this phase — it's the code defense; the OS layer is Ubuntu-host defense-in-depth.
- **D-18:** **Smoke check = enqueue one priority-1 check job** for a synthetic monitor via an operator script (the same enqueue path Phase 6 manual checks will use). Proves the full pipeline — claim, lock, check, Tier 1/Tier 2 persistence — with the scheduler paused. The ping row appearing IS the DEP-02 evidence.
- **D-19:** **Dedicated operator-owned synthetic monitor**, seeded once (long interval so the cron path ignores it), runbook-documented, reused by every future deploy's smoke check. During dark launch, worker-bound enqueues are **synthetic-only** — the operator script is the only enqueue path (no API route can enqueue until Phase 6); user monitors stay 100% cron-served until the Phase 5 overlap window.
- **D-20:** **`ecosystem.config.js` gains the worker app definition NOW** (worker entry, wait_ready, kill_timeout 20000ms per the 01-04 pins) — versioned and code-reviewed from day one, noted locally-unexercised in the deploy record. Same posture as the runbook's VPS sections.
- **D-21:** **Evidence lives in `04-DEPLOY-RECORD.md`** mirroring the 03-08 pattern: what ran, what was dispositioned N/A-locally, forward-tracked items with their VPS consumption points.
- **D-22:** **Dark-launch rollback = stop the worker process.** Cron never stopped, no schema changed, no user path touched — no code-level rollback to rehearse this phase. Documented as such; Phase 5 owns the real cutover rollback rehearsal (DEP-03).
- **D-23:** **DEP-02's ordering activates for the worker form this phase** (per the 01-07 phase-conditional runbook): build → backup → migrate (no-op if zero migrations) → worker start + readyz wait → web restart → smoke check (D-18 enqueue form). Runbook amended accordingly.

### Observability in Phase 4 (OBS-01/02)
- **D-24:** **Queue metrics = JSON snapshot on the existing :9090 health server** (e.g. `/metrics.json`). Zero new dependencies, operator-curlable during dark launch; Phase 5's Prometheus export (OBS-05) wraps this same collector rather than rebuilding it.
- **D-25:** **Full OBS-01 list in the snapshot:** depth per queue, job age, stalled count, transition→alert latency (Tier 1 commit → relay sent timestamps), Redis memory % (one INFO call). Phase 4 pre-stages CR-02's M4 counter-delta instrumentation this way — Phase 5 resolves the §4a ordering text and flips gates without building measurement.

### Failure-injection & test strategy (criteria 3–5, RES-01..05)
- **D-26:** **Hybrid evidence vehicle.** A Vitest integration suite automates the mechanics (repeatable red/green regression net) AND one operator-run rehearsal (`pnpm rehearse:worker`, 03-05 style) exercises the full stand-in topology producing an evidence file for the deploy record.
- **D-27:** **`pnpm test:resilience` — a separate command outside `pnpm verify`'s ≤5-minute budget** (container stop/start is inherently slow). The runbook makes it a typed pre-deploy step alongside the rehearsal — nothing ships without it.
- **D-28:** **Seven automated injection cases:** (1) duplicate delivery → exactly one ping row; (2) SIGKILL mid-job → no lost/double-applied writes, no second ONGOING incident; (3) Postgres-down → retryable jobs, breaker opens, enqueue pauses; (4) Redis-down → monitoring pauses by design, Postgres intact; (5) lock-loss → abort, never double-write; (6) Redis-restart recovery → schedulers re-upsert, stale locks expire, next tick re-claims (RES-05); (7) backlog-cap flood → routine (priority-10) enqueues dropped + logged/counted while the transition lane still processes (RES-02's only direct proof).
- **D-29:** **Kill-mid-job test kills a REAL child process** — spawn the actual worker bundle, SIGKILL at a marked checkpoint (after Tier 1 commit, before ack), restart, assert. Proves the artifact, not a simulation.
- **D-30:** **Resilience tests reuse the 5453/6390 docker test stack** with exclusive ownership while `test:resilience` runs (it's a separate command — no concurrent suites). No third stack to maintain.
- **D-31:** **Worker CORRECTNESS tests (audit §23 target-behavior cases: duplicate-incident, duplicate-alert, SSRF per-hop, Tier 1/Tier 2 writer math, claim/idempotency semantics) join the regular vitest suite INSIDE `pnpm verify`** — they need no container restarts. Clean split: verify = what the code does; test:resilience = what breakage it survives.
- **D-32:** **Rehearsal covers full deploy-day:** build → backup → migrate no-op → worker start → readyz wait → smoke enqueue → ping row appears → outage injections (pg stop, redis stop) → recovery → teardown, against a fresh throwaway docker stand-in (own ports, 03-05 isolation pattern). The first full run of DEP-02's ordering must NOT be the production dark launch.
- **D-33:** **Breaker/backlog constants ship pinned (5-fail/60 s, ~2×, retries 3–5) and Phase 4 RECORDS observations** — resilience-test timings + dark-launch metrics land in the deploy record as the tuning dataset. Threshold changes wait for Phase 5's real overlap-window data. Research still verifies defaults against BullMQ 6 reality.
- **D-34:** **RES-03 staleness = verify existing, don't build UI.** Researcher confirms the existing dashboard/status-page lastChecked display already surfaces aging timestamps when checks stop, pins it with a test. Any genuine gap gets dispositioned, not redesigned in this backend-only phase.

### CR-01 resolution — uptime_percent writer (DAT, design debt)
- **D-35:** **uptime_percent is derived in the same SQL statements that touch counters** — both the Tier 1 transition transaction and the Tier 2 guarded flush set `uptime_percent = round(100.0 * up_count / total_count, 2)` (exact expression per §16 transcription). No new lane, no staleness window, column always consistent with its counters. (Recompute job and read-time compute rejected: extra lane / touches Prisma read paths.)
- **D-36:** **Byte-parity with today's JS math is mandatory.** Writer tests assert the SQL-derived value equals the old JS-computed value (`(up/total)*100` → `toFixed(2)`) across edge ratios (0 checks, all-up, all-down, 1/3). If Postgres NUMERIC rounding disagrees with JS float formatting at an edge, the SQL expression is adjusted until it doesn't — behavior compatibility is the milestone's core value; publicly-displayed numbers must not shift at cutover.
- **D-37:** **Runtime consistency check rides the maintenance dry-run (WRK-13):** per monitor, compare stored `uptime_percent` against the counters-derived value; report discrepancies in the dry-run report without touching data. Guards the Phase 5 overlap window where two writer paths are live.

### SSRF check engine (SEC-01)
- **D-38:** **Canonical module at `src/lib/ssrf.ts`** — one exported check pipeline: the 11-token CIDR denylist, resolve-then-validate per redirect hop, scheme allowlist, 2 MB cap, 10 s timeout. The worker engine consumes it now; Phase 6's web-side create/update validation imports the SAME module — no copy, no drift.
- **D-39:** **Web-side adoption waits for Phase 6.** Monitor create/update keeps current validation this phase (scope discipline; changing API rejection behavior would violate the no-user-facing-change window).
- **D-40:** **Verify-time denylist diff:** extract CIDR tokens from the module and from runbook §10's operator list; mismatch fails `pnpm verify`. RR-01/WR-01's three-statement same-change mandate becomes a gate.
- **D-41:** **Manual redirect loop:** `fetch` with `redirect: 'manual'`, validate each `Location` target (scheme + resolve-then-validate) before following, ≤5 hops, no-validation-no-follow (classified as target behavior). Deterministic and per-hop testable exactly as §23 specifies.
- **D-42:** **SSRF tests exceed §23 verbatim with normalization bypass vectors:** IPv6-mapped IPv4 (`::ffff:10.0.0.1`), `0.0.0.0`, short/decimal IP forms, public→private redirect crossings.
- **D-43:** **2 MB cap enforced by counting streamed bytes** (abort once crossed); Content-Length is never trusted.

### Outbox relay & alert semantics (DAT-05/06)
- **D-44:** **Terminal state after 3 failed attempts = FAILED + retain.** Row marked FAILED (attempts=3, last error recorded); a failed-count gauge appears in `/metrics.json`; one error-level pino line per terminal failure. Nothing auto-retries past the cap; evidence preserved.
- **D-45:** **Typed permanent-vs-transient split (EML-03 pattern):** permanent Telegram failures (400 chat not found, 401/403 blocked bot) throw `UnrecoverableError` → straight to FAILED without burning retries; transient (5xx, network, timeout) retry with backoff.
- **D-46:** **Re-drive = operator script** (runbook-documented) that re-marks FAILED rows pending — respecting dedup keys so a re-drive can't double-send an alert that did go out. Manual, deliberate, auditable; no auto-healing loop.
- **D-47:** **Alert dedup key TTL = 7 days** (`SET NX EX`) — symmetric with the DLQ retention pin (01-04 D-14); beyond that window the Postgres-side outbox state is the real guard. No-TTL rejected (unbounded keys on a 512 MB noeviction instance makes Redis the outage); 24 h rejected (a relay stall over a weekend could double-send).
- **D-48:** **Telegram alert content pinned byte-for-byte in worker tests:** per event type (DOWN / RECOVERED / first-check-started), the rendered text must match the strings the Phase 2 characterization suite pins from today's cron. Message SELECTION moves to outbox event types; what lands in the user's chat is character-for-character unchanged.

### next_check_at re-seed (gap surfaced by this discussion)
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design source documents (amended by Phase 01, verdict READY)
- `docs/ARCHITECTURE-AUDIT.md` §14 — scheduler + claim SQL (RETURNING shape, J-6 lanes, D-12 queue topology with priorities): THE transcription source for the scheduler/queue build; D-50 amends the advance semantics if not catch-up-safe
- `docs/ARCHITECTURE-AUDIT.md` §15 — check job spec + SSRF pipeline (§15.1 engine denylist, §15.4 OS mirror): transcription source for the check engine + `src/lib/ssrf.ts`
- `docs/ARCHITECTURE-AUDIT.md` §16 — literal-SQL writer specs: Tier 1 transition transaction + Tier 2 guarded flush (RENAMENX staging, batchIds); D-35/D-36 extend with the uptime_percent derivation
- `docs/ARCHITECTURE-AUDIT.md` §13 — resilience spec (breaker states, backlog cap, DLQ, Redis-outage pause semantics)
- `docs/ARCHITECTURE-AUDIT.md` §11 — schema addendum (already landed as migration 0001 — Phase 4 consumes, does not re-author)
- `docs/ARCHITECTURE-AUDIT.md` §23 — test-plan cases (given/when/then) the worker correctness suite transcribes (D-31) + SSRF bypass extensions (D-42)
- `docs/ARCHITECTURE-AUDIT.md` §25 — connection budget (worker pool max 20, statement/idle timeouts)
- `docs/ARCHITECTURE-AUDIT.md` Appendix B — the 20 architectural rules (hard constraints)
- `docs/ARCHITECTURE-REVIEW.md` — issue vocabulary (J/D/R/A/S/M/P IDs); verdict READY since 2026-09-09

### Runbook (amended this phase per D-23/D-40/D-49)
- `docs/DEPLOY-RUNBOOK.md` — §4a first-worker-cutover path (gets the next_check_at re-seed step); §10 operator egress rules (denylist diff target); P-1 ordering activates the worker form; worker-restart + readyz-wait + smoke-check steps; interim local-stand-in deviations live in the 03-DEPLOY-RECORD pattern

### Design-debt registers (must-consume inputs)
- `.planning/phases/01-design-gate-review-verdict-ready/01-VERIFICATION.md` — CR-01 (uptime_percent writer — resolved HERE as D-35..D-37) + CR-02 (§4a vs M4 ordering — Phase 5 input, instrumentation pre-staged as D-25) + advisory register WR/IN/RR2
- `.planning/phases/03-redis-drizzle-schema-ownership/03-REVIEW.md` — code-review carry-forwards: CR-01 stale `0001_snapshot.json` + WR-01 `timestamptz_ops` (BLOCKING pre-planning repair — see decisions preamble); WR-05 journal count; WR-02/WR-06 opportunistic

### Planning artifacts
- `.planning/REQUIREMENTS.md` — Phase 4's 32 requirements (WRK-01..08/10/12/13/14, DAT-01..08/10, RES-01..05, SEC-01/02, OBS-01/02, DEP-01/02) with pinned bounds
- `.planning/PROJECT.md` — locked defaults Q-1..Q-5, behavior-compatibility constraint, connection budget, Key Decisions table
- `.planning/ROADMAP.md` §Phase 4 — goal + 5 success criteria (the contract this context serves) + research flag (BullMQ 6 `upsertJobScheduler`, breaker/backlog tuning, PM2 handshake)
- `.planning/phases/01-design-gate-review-verdict-ready/01-CONTEXT.md` — the Phase-01 pins this phase transcribes (parameter table, topology, priorities, dedup vocabulary)
- `.planning/phases/02-foundations-theme-infrastructure/02-CONTEXT.md` — manual-deploy posture, `pnpm verify` chain + ≤5-min budget, test-stack decisions (5453/6390, fileParallelism:false, raw-SQL seeding)
- `.planning/phases/03-redis-drizzle-schema-ownership/03-CONTEXT.md` — schema ownership, neutral pool (D-06 shape the worker consumes), rehearsal pipeline pattern, fail-open limiter philosophy
- `.planning/phases/03-redis-drizzle-schema-ownership/03-DEPLOY-RECORD.md` — the local stand-in topology ground truth + the N/A-disposition pattern D-15/D-17/D-21 mirror

### Codebase maps (pre-Phase-02 on tooling; architecture still accurate)
- `.planning/codebase/ARCHITECTURE.md` — data-flow and layer map (check path the worker replaces)
- `.planning/codebase/INTEGRATIONS.md` — Telegram/healthchecks.io/env inventory the relay and health work integrate with
- `.planning/codebase/CONCERNS.md` — SSRF surface, alert-before-persist ordering, batcher fragility — the defects this phase's machinery fixes

### Project skills
- `.claude/skills/redis-connections/SKILL.md` — BullMQ's separate blocking + queue connections, `maxRetriesPerRequest: null` worker-side config

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/db-pool.ts` — neutral pool module (03-02) shaped exactly for the worker to instantiate its own budgeted pool (max 20, §25.2 pins already in it)
- `src/db/schema.ts` + the Drizzle client (03-04) — the worker's data layer; migration 0001 already carries every prerequisite (`next_check_at` + partial index, `write_guards`, `outbox`, ongoing-incident unique index, `gen_random_uuid()` defaults for id-omitting INSERTs, `error_class`)
- `src/lib/redis.ts` — ioredis singleton pattern (globalThis cache, throw-early env validation) the worker's connection factory mirrors (with BullMQ's two-connection shape instead)
- `src/lib/telegram.ts` — the send path the outbox relay reuses (byte-parity target per D-48)
- `docker-compose.dev.yml` — test stack (Postgres 5453 / Redis 6390) the resilience suite owns exclusively (D-30)
- Vitest global-setup (drizzle-kit migrate via the single runner) + `fileParallelism: false` discipline — new worker tests join both
- Phase 2 characterization suites — cron/batcher/API pins stay green all phase (cron untouched); alert-content strings are the D-48 parity source
- `scripts/` rehearsal tooling from 03-05 (anonymization, rehearse:migrations pipeline, stamp-baseline) — the pattern `pnpm rehearse:worker` mirrors; WR-05 (journal count) noted before reuse
- `ecosystem.config.js` — PM2 web app; gains the worker app definition (D-20)
- `.env.example` — the 02-01 documented sweep; gains `WORKER_SCHEDULER_ENABLED`, `WORKER_HEALTH_PORT`

### Established Patterns
- Global-cached singleton + module-load env validation (`src/lib/prisma.ts`, `src/lib/redis.ts`, `src/redux/api/baseApi.ts`) — the worker's Redis/queue factory follows it
- One Lua script = one atomic op (`rlIncr` in the limiter, 03-01) — the same discipline for lock compare-and-delete and any multi-key worker Lua
- Deploy-record evidence pattern (03-08): what ran / what was dispositioned / forward-tracking — D-15/D-17/D-21 reuse it verbatim
- Failure-swallow + zero-synchronous-footprint fast paths are PINNED as current-behavior red/green markers (db-5, cron 1/2/13) — the worker is what makes the fixed behavior real; old pins stay green until Phase 5 deletes the legacy path

### Integration Points
- `package.json` — `build` gains the worker bundle step (D-06); new scripts `dev:worker`, `test:resilience`, `rehearse:worker`; deps: tsup + pino (tsx already present)
- `pnpm verify` chain — worker correctness tests join `test` (D-31); boundary gate (D-08) + denylist diff (D-40) join as gates
- `docs/DEPLOY-RUNBOOK.md` — §4a re-seed amendment (D-49), worker-form ordering activation (D-23), smoke-check enqueue form (D-18)
- `next.config.ts` / web app — deliberately untouched (no user-facing change this phase)
- The web process keeps its Prisma reads and cron execution exactly as-is; the worker is additive infrastructure until Phase 5

</code_context>

<specifics>
## Specific Ideas

- The operator's standing posture (Phase 02 quote): *"I will deploy it manually, no readymade system, make everything default"* — every Phase 4 tooling choice honors it (tsup over build frameworks, plain processes over process managers locally, typed runbook steps over automation)
- The dark launch must be boring: cron serves everyone; the worker sits paused-but-alive; the ONLY worker activity is operator-initiated smoke enqueues on the synthetic monitor — boring is the success condition
- Byte-parity is philosophy, not tactic: displayed numbers (uptime_percent), Telegram text, and API shapes are the compatibility surface — if a test can't prove character-for-character parity, the default answer is to adjust the new code, not the test
- Two-proof discipline: every resilience claim needs BOTH an automated regression test AND a deploy-shaped rehearsal/evidence trail — "the suite is green" and "we watched it on the real topology" are different sentences
- The disposition register is a feature: honestly recording what the local stand-in cannot prove (PM2 handshake, OS egress) is what makes the eventual VPS deploy's forward-tracked items trustworthy

</specifics>

<deferred>
## Deferred Ideas

- Real PM2 exercise (wait_ready/kill_timeout handshake), SEC-02 OS-level egress, systemd supervision form — first real VPS deploy (forward-tracked in 04-DEPLOY-RECORD per D-15/D-17)
- CR-02 resolution (§4a "disable nothing" vs M4 ordering contradiction) — Phase 5 planning; Phase 4 only pre-stages the M4 instrumentation (D-25)
- Breaker/backlog/retry threshold tuning with real data — Phase 5 (Phase 4 records the dataset per D-33)
- next_check_at re-seed execution + rehearsal — Phase 5 cutover (text lands now per D-49)
- Heartbeat move to worker tick (WRK-09), cron/`CRON_MODE` deletion (WRK-11), outbox-age alerting (OBS-03), Prometheus export (OBS-05), env transition (DEP-05) — Phase 5
- Web-side SSRF validation on monitor create/update — Phase 6 API work imports `src/lib/ssrf.ts` (D-39)
- Per-user manual-check enqueue limiter + 202/poll API — Phase 6 (SEC-05/API-01)
- Bull Board queue UI + admin gating — Phase 7 (OBS-04/SEC-04)
- Windowed-uptime compute (DAT-11) — Phase 8 (reuses the D-35 in-UPDATE derivation pattern)

</deferred>

---

*Phase: 4-Monitoring Worker — Build & Dark Launch*
*Context gathered: 2026-09-13*
