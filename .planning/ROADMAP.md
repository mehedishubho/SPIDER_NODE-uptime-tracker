# Roadmap: SpiderNode Backend Modernization

## Overview

A brownfield modernization of a live production uptime-monitoring SaaS. The arc follows audit §24: make the design review-ready on paper first, then build the safety net (tests, CI gates, stable theme tokens), take ownership of the schema (Redis with no correctness dependence + Drizzle baselined from live DDL), move monitoring execution into a dedicated BullMQ worker (dark launch, then gated overlap cutover), thin the API boundary, cut auth over to Better Auth and delete Prisma, and only then land flagged capabilities (AI, windowed uptime) and the visual redesign. Every phase ships a complete, revertible increment — monitoring never stops, loses data, or locks users out.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Design Gate — Review Verdict READY** - All 8 review addenda incorporated, §9 checklist resolved, verdict flipped NOT READY → READY before any code — **complete 2026-09-09: cycle-2 re-review clean pass (zero blocking findings) human-ratified, verdict flipped to READY per D-16; RR2-01/02/03 recorded as advisory Phase 4/5 design-debt (01-09)**
- [x] **Phase 2: Foundations & Theme Infrastructure** - pnpm, CI gates, characterization tests on real Postgres/Redis; theme tokens land with zero behavior change — *round-2 verification 2026-09-12: both gaps independently confirmed closed (02-10), human_needed — 5 manual UAT tests pending (02-UAT.md)* (completed 2026-09-12)
- [x] **Phase 3: Redis & Drizzle Schema Ownership** - Redis with no correctness dependence; live-DDL Drizzle baseline plus worker schema addenda, rehearsed on a prod snapshot (completed 2026-09-12)
- [x] **Phase 4: Monitoring Worker — Build & Dark Launch** - Dedicated worker owns all monitoring on idempotent, resilient BullMQ machinery; dark-launched while cron still serves users (completed 2026-09-14)
- [x] **Phase 5: Worker Cutover & Operational Hardening** - Gated overlap cutover deletes the cron; heartbeat moves, observability, env transition, rehearsed rollback (completed 2026-09-19)
- [ ] **Phase 6: Thin API Routes & Email Abstraction** - Web becomes an enqueue-only producer; security fixes at the new boundary; email queued off the request path
- [x] **Phase 7: Better Auth Cutover, Admin Gating & Prisma Removal** - Canary-gated auth cutover onto existing tables; admin roles gate feedback and queue UI; Prisma deleted (completed 2026-09-30)
- [ ] **Phase 8: Flagged Capabilities & UI Modernization** - AI and windowed-uptime behind default-off flags; visual redesign on stable tokens and stable APIs

## Phase Details

### Phase 1: Design Gate — Review Verdict READY

**Goal**: The design documents are amended with every review addendum and the NOT READY verdict is flipped to READY, so no correctness mechanism is ever invented under pressure during implementation.
**Depends on**: Nothing (first phase)
**Requirements**: DSGN-01, DSGN-02
**Success Criteria** (what must be TRUE):

  1. A written design addendum exists for each of the 8 review §8 items — schema (`next_check_at`, write guards, outbox, partial unique ONGOING index, ID generation), scheduler claim spec (J-1), check job spec (J-3/J-4/S-1), writer specs (J-2/D-1/D-5), resilience spec (J-5/R-1), auth spec (A-1/A-2/A-3), connection budget (D-8), deploy runbook (P-1) — each citing the review issues it resolves
  2. Every review §9 pre-implementation checklist item traces to a design decision, and the verdict is re-recorded as READY (dated, reviewer identified) before any implementation code merges
  3. An operator can read the runbook addendum and know the exact production ordering (build → backup → migrate → worker restart → web restart → smoke check), the rollback action at each step, and the per-process connection budget — before any code exists

**Plans**: 9/9 plans complete

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Audit data-correctness amendments: DDL-precise §11 schema, literal-SQL §16 writer specs, §23 data test cases (DSGN-01)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Audit orchestration amendments: §14 scheduler + claim SQL + D-12 queue topology, §15 check job + SSRF pipeline, §23 SSRF/classification test cases (DSGN-01)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-03-PLAN.md — Audit platform amendments: §13 resilience rewrite (breaker/backlog/DLQ/Redis outage), §12 auth field maps, connection-budget section (DSGN-01)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-04-PLAN.md — Operator deliverable: NEW docs/DEPLOY-RUNBOOK.md (both topologies, per-step rollback), §22 pointer, §9 self-traceability check (DSGN-01, DSGN-02)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 01-05-PLAN.md — The gate: fresh adversarial re-review (D-15/D-17), human ratification checkpoint, verdict flip to READY per D-16 (DSGN-02) — *executed via the gap-path branch: ratified gaps RR-01..RR-04, verdict NOT flipped, D-18 cycle 1 of 2 (see 01-05-SUMMARY.md)*

**Wave 6** *(fix cycle — blocked on 01-05; parallel, no file overlap)*

- [x] 01-06-PLAN.md — Fix criticals in the audit writer specs: §16.2 exclusive-snapshot flush + bulk ping INSERT (CR-01/CR-02/IN-03/IN-04/OBS-01), dedup vocabulary for all three outbox event types (CR-03), git-track ARCHITECTURE-REVIEW.md (DSGN-01)
- [x] 01-07-PLAN.md — Fix runbook executability: phase-conditional Migrate step (WR-03), PM2 process-signal handshake (WR-04), NEW §4a first-worker-cutover path (WR-05), budget wording (IN-05) (DSGN-01)

**Wave 7** *(blocked on 01-06 + 01-07)*

- [x] 01-08-PLAN.md — Close ratified residuals + advisory hardening: S-1 egress layer in audit §15.4 + runbook §10 (RR-01), maintenance.ts comment (RR-02), §23 degradation assertions (RR-03), spike-vocabulary rewording (RR-04), WR-01/02/07/08 + IN-01/OBS-04/05 pins (DSGN-01)

**Wave 8** *(final gate — blocked on 01-06 + 01-07 + 01-08)*

- [x] 01-09-PLAN.md — D-18 cycle 2 of 2 (FINAL): fresh adversarial re-review of the amended docs, blocking human ratification, verdict flip to READY per D-16 or permanent escalation with verdict unchanged (DSGN-02) — *executed via the clean-pass branch: zero blocking findings ratified 2026-09-09, verdict flipped (see 01-09-SUMMARY.md)*

### Phase 2: Foundations & Theme Infrastructure

**Goal**: A safety net exists — pnpm, enforced CI gates, and characterization tests running against real Postgres/Redis — and stable theme tokens land, all with zero change to monitoring behavior.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: FND-01, FND-02, FND-03, FND-04, FND-05, FND-06, FND-07, THM-01, THM-02, THM-03, DEP-04
**Success Criteria** (what must be TRUE):

  1. A fresh clone installs and builds with pnpm; every PR runs lint → typecheck → unit/integration → build green, a typecheck failure blocks merge (`ignoreBuildErrors` off), and the Node version is pinned identically in dev and CI
     - *Amendment (2026-09-10, CONTEXT D-01/D-02): no GitHub Actions or PR-level CI in this phase — `.github/workflows/deploy.yml` is deleted; the "every PR runs" clause is superseded by the single local `pnpm verify` gate chain (docker up --wait → lint → typecheck → test → build → e2e), operator-run before every deploy, with Node pinned identically in dev and on the VPS. Evaluate this criterion against the manual verify contract, not a CI system.*
  2. `docker compose up` brings up Postgres + Redis locally, and the characterization suite proves current behavior: due-time filtering, PENDING→UP / UP→DOWN / DOWN→UP transitions, incident open/resolve, Telegram message selection, db-batcher enqueue/flush math, and API contracts (auth required, ownership scoping, status codes) — deliberately changing any pinned behavior turns the suite red
  3. A user can toggle Light/Dark/System in the header: theme applies before first paint (no flash of wrong theme, no hydration mismatch), dark mode is visually identical to today, toasts follow the resolved theme, and hardcoded hex classes now route through semantic tokens with no visual change
  4. The repo contains no ngrok binary or log, `.env.example` documents every variable the app reads, and error responses never include stack traces

**Plans**: 10/10 plans complete

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Toolchain migration & repo hygiene: pnpm exact-freeze, Node 24 pin, deploy.yml/ngrok/test-script deletions, .env.example, error-leak fix (FND-01, FND-03, FND-07)

**Wave 2** *(blocked on 02-01)*

- [x] 02-02-PLAN.md — Test scaffold: docker Postgres/Redis stack, Vitest + Playwright configs, localhost DB guard, ONE smoke E2E, pnpm verify chain (FND-04, DEP-04)

**Wave 3** *(blocked on 02-02; parallel, no file overlap)*

- [x] 02-03-PLAN.md — Data-path characterization: cron-logic transitions + db-batcher flush math on real Postgres, audit §23 transcribed (FND-05, FND-06)
- [x] 02-04-PLAN.md — Runbook amendments: manual-deploy steps, one-time VPS Node/pnpm switch, typed post-deploy checks (DEP-04; D-01..D-05/D-14/D-26)

**Wave 4** *(blocked on 02-02 + 02-03 — shared docker test stack)*

- [x] 02-05-PLAN.md — API contract characterization: handler-import harness + pinned defects + HTTP-level core routes via Playwright api project (FND-06)

**Wave 5** *(blocked on 02-01 + 02-03 + 02-05 — flip gated on green suite per D-19)*

- [x] 02-06-PLAN.md — Typecheck fix-all-then-flip: size pile (D-12 gate), minimal-churn fixes, ignoreBuildErrors off + stale configs deleted, canary proof (FND-02)

**Wave 6** *(blocked on 02-06)*

- [x] 02-07-PLAN.md — Theme infrastructure vertical slice: RED e2e first, next-themes + toggle + toaster, palette split with frozen .dark (THM-01, THM-02)

**Wave 7** *(blocked on 02-07)*

- [x] 02-08-PLAN.md — Hex→token mechanical migration, same dark values, status-token adoption, hex gate (THM-03)

**Wave 8** *(final — blocked on 02-03 + 02-05 + 02-08)*

- [x] 02-09-PLAN.md — D-21 mutation spot-check: three deliberate behavior breaks proven red then reverted; final full pnpm verify (FND-05, FND-06)

**Wave 9** *(gap closure — blocked on 02-08; from 02-VERIFICATION.md gaps)*

- [x] 02-10-PLAN.md — THM-03 gap closure: revert the 33 CR-01 emerald-500 utility swaps across 8 files + restore the CR-02 frozen literal in global-error.tsx; both theme gates + full pnpm verify re-run (THM-03)

**UI hint**: yes

### Phase 3: Redis & Drizzle Schema Ownership

**Goal**: Redis serves non-critical work with zero correctness dependence, and the database schema is owned by versioned Drizzle migrations baselined from live DDL, with every worker prerequisite landed and rehearsed against a production snapshot.
**Depends on**: Phase 2
**Requirements**: RDS-01, RDS-02, RDS-03, DRZ-01, DRZ-02, DRZ-03, DRZ-04, DRZ-05, DRZ-06, DAT-09
**Success Criteria** (what must be TRUE):

  1. Rate limiting is Redis-backed and atomic (INCR+EXPIRE per bucket): restarting the app process mid-burst does not reset a limit window, and a Redis outage never corrupts Postgres data — the limiter degrades safely
  2. `drizzle-kit pull` against production yields an empty diff against the committed schema (or an explicitly reviewed delta), the empty-diff CI gate blocks silent drift, and new code reads/writes through Drizzle sharing one `pg` Pool with Prisma — never dual-write
  3. The migration history contains every worker prerequisite, applied additively (no drops/renames): `monitors.next_check_at` + partial index `(is_active, next_check_at)`, `write_guards`, `outbox`, partial unique `incidents(monitor_id) WHERE status='ONGOING'`, pinned ID-generation defaults, `error_class`, reserved `consecutive_failures`
  4. Migrations have been rehearsed against an anonymized production snapshot with row-count and checksum verification matching; the deploy pipeline runs the single migration runner, and `prisma db push --accept-data-loss` no longer exists anywhere
  5. Redis hardening is applied and documented (AOF `everysec`, `maxmemory-policy noeviction`, supervised restart, memory alert at 70%) and ioredis clients follow BullMQ 6 config — separate blocking + queue connections, `maxRetriesPerRequest: null` on the worker side, no `keyPrefix` — with the connection budget (web 10 / worker 20 / migrations 1) documented

**Plans**: 8/8 plans complete

Plans:
**Wave 1** *(parallel, no file overlap)*

- [x] 03-01-PLAN.md — Redis rate limiter vertical slice: ioredis 6 + phase deps install, fail-open singleton, atomic Lua limiter (INCR+EXPIRE), D-20 integration suite, 429 characterization adaptation (RDS-01, RDS-02)
- [x] 03-02-PLAN.md — Neutral pg pool module with §25.2 pinned options shared by Prisma (DAT-09, D-06)

**Wave 2** *(blocked on 03-01 — drizzle-kit installed)*

- [x] 03-03-PLAN.md — Live-DDL schema ownership: fresh prod dump (operator), restore container, drizzle-kit pull → src/db/schema.ts, full-DDL baseline 0000 + deterministic stamp script (DRZ-01)

**Wave 3** *(blocked on 03-02 + 03-03)*

- [x] 03-04-PLAN.md — Worker-prereqs migration 0001 from audit §11, shared-pool Drizzle client, prisma freeze, global-setup switch to the single runner, [BLOCKING] apply + prove (DRZ-02, DRZ-04, DRZ-05)

**Wave 4** *(blocked on 03-04; parallel pair, no file overlap)*

- [x] 03-05-PLAN.md — Rehearsal tooling + execution: anonymization script, pnpm rehearse:migrations pipeline, evidence file, D-19 timing decision (DRZ-06)
- [x] 03-06-PLAN.md — Runbook amendments: VPS Redis install/hardening (§3b), 70% memory alert (§3c), rehearsal procedure + Migrate-step activation (§3d), limiter-live post-deploy checks (RDS-03)

**Wave 5** *(blocked on 03-05 — package.json ordering)*

- [x] 03-07-PLAN.md — Verify gates: empty-diff gate (migrate → pull → diff) + destructive-push absence scan join pnpm verify; mutation-proof + ≤5-min budget (DRZ-03, DRZ-02)

**Wave 6** *(final — blocked on 03-05 + 03-06 + 03-07)*

- [x] 03-08-PLAN.md — Production release execution: backup → one-time stamp → single-runner migrate → ship → Redis hardening → post-deploy proofs (restart-survival 429, hardened Redis, schema owned) + deploy record (RDS-03, DRZ-02)

**Research flag**: verify drizzle-kit baseline journal-stamping and transaction-wrapping vs `CREATE INDEX CONCURRENTLY` during the snapshot rehearsal (SUMMARY.md gaps) — *RESOLVED in 03-RESEARCH.md Pattern 4 (journal/hash/folderMillis verified from shipped drizzle-orm 0.45.2 source; CONCURRENTLY cannot run inside the runner's single transaction → D-19 rehearsal-driven rule)*

### Phase 4: Monitoring Worker — Build & Dark Launch

**Goal**: All monitoring execution runs in a dedicated worker process on durable, idempotent, resilient BullMQ machinery — built, failure-injection-tested, and dark-launched while the existing cron still serves every user.
**Depends on**: Phase 3
**Requirements**: WRK-01, WRK-02, WRK-03, WRK-04, WRK-05, WRK-06, WRK-07, WRK-08, WRK-10, WRK-12, WRK-13, WRK-14, DAT-01, DAT-02, DAT-03, DAT-04, DAT-05, DAT-06, DAT-07, DAT-08, DAT-10, RES-01, RES-02, RES-03, RES-04, RES-05, SEC-01, SEC-02, OBS-01, OBS-02, DEP-01, DEP-02
**Success Criteria** (what must be TRUE):

  1. The worker deploys as a second PM2 app built from the same repo/SHA as web, dark-launched with its scheduler paused while the deploy pipeline is rehearsed and the cron still performs every check; `/healthz` and `/readyz` respond on `:9090` (readyz fails when Redis or Postgres is down), and restarting the web app never interrupts checking
  2. Duplicate delivery of a check job produces exactly one ping row (SQL claim advancing `next_check_at` + schedule-epoch idempotency key + per-monitor lock with owner-only release); DOWN/RECOVERED/first-check transitions commit monitor + ping + incident + outbox in one synchronous transaction and yield exactly one Telegram alert per incident; routine UP results flush within 60 s via a guarded atomic update that never writes `status`; manual checks and non-UP monitors are prioritized with documented worst-case latency
  3. Killing the worker mid-job (SIGKILL past `kill_timeout`) then restarting neither loses nor double-applies writes — counter deltas stay correct and no second ONGOING incident appears; retries are bounded (3–5) with exponential backoff and DLQ retention; SIGINT drains in-flight jobs within `kill_timeout`
  4. Failure injection proves both outage directions: Postgres down → jobs retry (nothing silently lost), the circuit breaker opens and pauses enqueueing, and the backlog cap drops routine checks but never transitions; Redis down → monitoring pauses by design, Postgres stays intact, and in-product staleness ("last checked Xm ago") is visible to users
  5. The check engine enforces SSRF layering (per-redirect-hop private-range denial, scheme allowlist, 2 MB cap, strict 10 s timeout — test cases pass) with OS-level egress rules active on the worker host; an operator can trace one check end-to-end via `monitorId`-correlated structured logs and queue metrics (depth, job age, stalled count); the maintenance job has a dry-run that reports row counts without deleting; the pipeline orders build → backup → migrate → worker (waits readyz) → web → smoke check that produces a synthetic ping row

**Plans**: 9/9 plans complete

Plans:
**Wave 1**

- [x] 04-01-PLAN.md — Worker process boot slice: deps checkpoint (bullmq/pino/undici/tsup/tsx), tsup one-build-two-artifacts, entry/connection/logger/health(:9090)/db pool, boundary gate in verify, PM2 worker stanza (WRK-01, WRK-08, WRK-14, OBS-02, DEP-01)

**Wave 2** *(parallel, no file overlap — all depend on 04-01)*

- [x] 04-02-PLAN.md — Queue topology + priorities/retry-DLQ + claim (D-50 GREATEST catch-up) + scheduler-behind-flag + backlog cap + queue metrics (WRK-02, WRK-03, WRK-06, WRK-10, WRK-12, RES-02, OBS-01)
- [x] 04-03-PLAN.md — Canonical SSRF pipeline src/lib/ssrf.ts + WRK-05 classification + error_class vocabulary, §23 + D-42 vector tests (SEC-01, WRK-05, DAT-10)
- [x] 04-04-PLAN.md — Per-monitor Lua locks + Tier 1 §16.1 transition transaction with in-UPDATE uptime_percent (D-35) + byte-parity suite D-36 (WRK-04, DAT-01, DAT-04, DAT-07, DAT-10)
- [x] 04-05-PLAN.md — Tier 2 §16.2 Redis staging + RENAMENX guarded flush + write_guards idempotency (DAT-02, DAT-03, DAT-07)

**Wave 3** *(blocked on 04-02..04-05)*

- [x] 04-06-PLAN.md — Check job processor assembly (lock→SSRF→classify→Tier1/Tier2→flush) + Postgres circuit breaker 5-fail/60s (WRK-01, WRK-05, WRK-12, RES-01)

**Wave 4** *(blocked on 04-06)*

- [x] 04-07-PLAN.md — Outbox relay with byte-parity Telegram + 7-day dedup + typed FAILED retain, maintenance dry-run + D-37 consistency + batched retention, metrics completion (DAT-05, DAT-06, DAT-08, WRK-13, OBS-01)

**Wave 5** *(blocked on 04-06 + 04-07)*

- [x] 04-08-PLAN.md — Seven-case resilience injection suite (pnpm test:resilience, real SIGKILL child, outage both directions) + staleness pin D-34 + D-33 dataset (RES-01..05, WRK-07)

**Wave 6** *(final — blocked on 04-08)*

- [x] 04-09-PLAN.md — Operator scripts (seed/smoke/re-drive/rehearse), runbook amendments (§4a re-seed D-49, worker-form D-23, §10 egress D-17, denylist gate D-40), full deploy-day rehearsal D-32, dark launch + 04-DEPLOY-RECORD (WRK-10, DEP-01, DEP-02, SEC-02)

**Research flag**: needs `--research-phase` depth — BullMQ 6 `upsertJobScheduler` semantics, breaker/backlog tuning, PM2 `wait_ready`/`kill_timeout` handshake, overlap gate instrumentation (SUMMARY.md) — *RESOLVED in 04-RESEARCH.md (all BullMQ 6 behaviors verified against docs.bullmq.io: scheduler idempotence, priority default-0 inversion, stalled defaults 30000/30000/1, pause semantics; PM2 defaults 3000/1600 confirmed; two findings: Postgres round-cast Pitfall 1 + D-50 GREATEST catch-up amendment)*

### Phase 5: Worker Cutover & Operational Hardening

**Goal**: The worker becomes the only monitoring path through a gated overlap window, and operators gain early-warning signals plus a rehearsed rollback story.
**Depends on**: Phase 4
**Requirements**: WRK-09, WRK-11, DEP-03, DEP-05, OBS-03, OBS-05
**Success Criteria** (what must be TRUE):

  1. During the overlap window both paths run idempotently with zero monitoring gap: no monitor misses a scheduled check, the healthchecks.io heartbeat comes steadily from the worker scheduler tick, queue depth returns to ~0, and Telegram alert parity holds for a full verification window
  2. After cutover `instrumentation.ts` and `CRON_MODE` are deleted (CI greps the build to keep cron remnants out), the worker is the sole monitoring path, and the external dead-man's switch pages if the worker tick stops
  3. Operators see trouble before users do: outbox-age alerting fires when rows exceed the threshold, and Prometheus exports queue depth/age, stalled count, transition→alert latency, and Redis memory
  4. Rollback is rehearsed: restoring the previous tarball returns the prior release cleanly, expand/contract discipline holds (no drops or renames inside verification windows), and the environment transition is complete (`REDIS_URL`, `EMAIL_PROVIDER`, `BETTER_AUTH_*` documented; `NEXTAUTH_*`/`CRON_MODE` retired or on a dated retirement path in `.env.example`)

**Plans**: 9/9 plans complete

Plans:
**Wave 1** *(parallel, no file overlap)*

- [x] 05-01-PLAN.md — D-29 WR-02..05 fix pack (breaker-skip/claim-posture/send-timeout/UTC-clock) + OBS-03 oldest-unsent-age collector (WRK-11, OBS-03)
- [x] 05-04-PLAN.md — Add-release doc wave: audit §M4 gated-window amendment (D-08), runbook §3c/§4a/§9 (D-24/D-38 + choreography), .env.example dated transition map (D-39/D-40) (DEP-05, WRK-11)

**Wave 2** *(blocked on 05-01; parallel, no file overlap)*

- [x] 05-02-PLAN.md — WRK-09 heartbeat + OBS-03 outbox-age/memory dead-man pings on the worker tick, inert while scheduler-off (WRK-09, OBS-03)
- [x] 05-03-PLAN.md — OBS-05 Prometheus /metrics on :9090 via legitimacy-gated @prometheus-io/client (OBS-05)

**Wave 3** *(blocked on 05-02 + 05-03)*

- [x] 05-05-PLAN.md — 7-gate evaluator (D-14/D-16/D-17), cron-remnant gate (D-41, inert), throwaway scraper (D-27) (WRK-11, OBS-05)

**Wave 4** *(blocked on 05-05)*

- [x] 05-06-PLAN.md — D-33 rehearsal machinery: egress-neutral localhost stand-in, re-seed/unpause/co-run/induce/gates/drill legs + one-shot maintenance enqueue + IN-01 seed fix (WRK-11, DEP-03)

**Wave 5** *(blocked on 05-06)*

- [x] 05-07-PLAN.md — Stand-in rehearsal execution (D-30/D-31/D-32 hard precondition) + add-release deploy + scheduler-off soak (WRK-11, DEP-03)

**Wave 6** *(blocked on 05-07)*

- [x] 05-08-PLAN.md — Live window: re-seed → unpause → D-35 abort drill → 4-6h dense co-run → induced parity (D-11) → 7-gate PASS → D-18 operator approval (WRK-09, WRK-11, DEP-03)

**Wave 7** *(final — blocked on 05-08 approval)*

- [x] 05-09-PLAN.md — Scheduler-only deletion release (D-03/D-41/D-46), old-check retirement (D-21), tier-2 tarball-restore rehearsal (D-15), env transition closeout (D-40) (WRK-11, DEP-03, DEP-05)

### Phase 6: Thin API Routes & Email Abstraction

**Goal**: The web app becomes a stateless producer — routes enqueue and never probe — and transactional email leaves the request path behind a provider interface.
**Mode:** mvp
**Depends on**: Phase 4 (worker and queues must exist to receive jobs; may run in parallel with Phase 5)
**Requirements**: API-01, API-02, SEC-03, SEC-05, SEC-06, EML-01, EML-02, EML-03, EML-05
**Success Criteria** (what must be TRUE):

  1. "Check now" returns 202 immediately and the fresh result appears via polling within the documented latency; no API route ever executes a check against a target itself
  2. Degradation is loud and bounded: Redis unreachable → the enqueue endpoint returns 503 (never a silent no-op); a user over their per-user enqueue limit is rejected; a Telegram webhook POST without the correct secret header is refused
  3. No endpoint accepts a secret via query string and no `CRON_SECRET` reference remains in the codebase; error responses never leak stack traces or internals
  4. With SMTP down, account registration still completes and the verification email arrives once SMTP recovers (queued, bounded attempts, backoff); a permanently undeliverable address stops retrying via a typed unrecoverable error; the existing HTML template renders unchanged from its new location

**Plans**: 6/7 plans executed + 2 gap-closure plans (06-VERIFICATION: 2 enqueue-failure-path gaps; 06-UAT: G-06-2 manual non-transition persist + G-06-7 webhook secret env posture)

Plans:
**Wave 1** *(no dependencies)*

- [x] 06-01-PLAN.md — Check-now enqueue slice: RED tests, web bounded queue producer + limiter TTL/Retry-After + apiError, check route 202 + next_check_at advance, Dashboard poll UX (API-01, API-02, SEC-05)

**Wave 2** *(blocked on 06-01 — queue producer + api-error helper; parallel, no file overlap)*

- [x] 06-02-PLAN.md — Email queue slice: lib/email module (byte-verbatim template, provider selection), email lane worker with exact D-09 backoff + typed dead-lettering, register/forgot enqueue + 503, WR-02 + IN-01 (EML-01, EML-02, EML-03, EML-05, API-02)
- [x] 06-03-PLAN.md — Boundary security: webhook secret-token constant-time auth + limiter + name escape, SSRF validate-at-create, D-17 pinned-defect flips, IN-04 alert escaping (SEC-03)

**Wave 3** *(blocked on 06-01 + 06-02 + 06-03)*

- [x] 06-04-PLAN.md — Worker hardening (retention real deletes D-14/D-18, WR-01 script deadline) + runbook §4b + env + stand-in feature-release rehearsal + operator approval (API-01, API-02, SEC-03, EML-02)

**Wave 4** *(final — blocked on 06-04 approval)*

- [x] 06-05-PLAN.md — Production feature release + setWebhook cutover + 24h soak gate, then deletion release: cron routes/modules/secret/playwright writer deleted, D-41 gate extended, D-27 pin inventory (SEC-06)

**Wave 5** *(gap closure — blocked on 06-01 + 06-02; from 06-VERIFICATION gaps_found)*

- [x] 06-06-PLAN.md — Enqueue-failure-path closure: compensating next_check_at restore on failed check-now enqueue (CR-01/gap 1) + producer-side 3s deadline bounding every web-side producer await for the silently-unreachable Redis mode (gap 2) (API-01, API-02)

**Wave 6** *(gap closure — blocked on 06-06: shared deferred-items.md; from 06-UAT G-06-2/G-06-7)*

- [ ] 06-07-PLAN.md — UAT gap closure: manual non-transition check-now results persist in-job via the §16.2 additive follow-up UPDATE + the missing engine end-to-end repeat-check pin (G-06-2), and the TELEGRAM_WEBHOOK_SECRET operator env fix with a tracked 401/401/429 ladder probe (G-06-7) (API-01, SEC-03)

### Phase 7: Better Auth Cutover, Admin Gating & Prisma Removal

**Goal**: Users authenticate through Better Auth against the existing tables without a single lockout, admin surfaces are gated by role, and Prisma is fully removed.
**Mode:** mvp
**Depends on**: Phase 3 (Drizzle schema), Phase 6 (email queue for auth hooks)
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07, AUTH-08, AUTH-09, DRZ-07, EML-04, SEC-04, OBS-04
**Success Criteria** (what must be TRUE):

  1. Every existing credentials user can log in with their old password after the flip — proven by a canary login through the preserved bcrypt hash path on the anonymized snapshot, then in production; stored hashes upgrade to the modern default on next login (lazy rehash) without breaking anyone
  2. Google and GitHub users log in post-cutover with their accounts and refresh tokens intact (reshaped `account` rows, providerId casing confirmed by dry-run); session checks validate from the signed cookie (`cookieCache`) without a per-request DB hit; boolean `emailVerified` is backfilled and legacy `sessions`/token tables remain read-only
  3. The announced forced re-login happens: after the flip unauthenticated users land on login with an in-app/email notice, and verification/reset emails flow through the email queue (never in-request SMTP)
  4. Admin gating works end-to-end: roles via the Better Auth admin plugin, feedback listing admin-only, and the Bull Board queue UI reachable only for admins from allowlisted IPs
  5. Removal is complete: no NextAuth deps or custom auth routes, no Redux `auth` slice / token mirror / `js-cookie` (the Better Auth client is the single auth source), and no `prisma/` directory, generated client, or `@prisma/*` deps — every read path runs on Drizzle with the test suite green

**Plans**: 11/11 plans complete

Plans:
- [x] 07-10-PLAN.md
- [x] 07-11-PLAN.md

**Wave 1** *(parallel, no file overlap)*

- [x] 07-01-PLAN.md — TRACER cutover foundation: package legitimacy gate + better-auth pin, additive 0002 migration (account/session/verification + role + boolean backfill) with D-08/D-09 admin seed, A-1 hash-prefix router + lazy rehash, minimal Better Auth instance + canary login (AUTH-01, AUTH-02, AUTH-03, AUTH-09)
- [x] 07-02-PLAN.md — Email-queue cutover groundwork: BETTER_AUTH_URL domain source + hook-facing render variants + fixture re-freeze, announcement blast script + copy (D-01/D-04/D-06) (EML-04, AUTH-06)

**Wave 2** *(blocked on 07-01 + 07-02)*

- [x] 07-03-PLAN.md — Flip engine: full-parity Better Auth config (all D-pins incl. D-28 delta), email hooks → queue, proxy cookieCache swap, ten-route session sweep, feedback admin gate (R17), single client entry (AUTH-02, AUTH-03, AUTH-04, EML-04, SEC-04)

**Wave 3** *(blocked on 07-03; parallel, no file overlap)*

- [x] 07-04-PLAN.md — Client session swap (D-33 same pixels, frozen toast strings) + provider deletion + login notice strip (D-02) (AUTH-06, AUTH-08)
- [x] 07-05-PLAN.md — Bull Board on worker :9090 behind socket-source IP allowlist + admin session, D-16 audit lines, mutation kept (D-17..D-19) (OBS-04, SEC-04)

**Wave 4** *(blocked on 07-01..07-05)*

- [x] 07-06-PLAN.md — Rehearsal: WR-05 machinery fix, refreshed snapshot + D-37 canary, full D-34 stand-in flip rehearsal + D-35 redeploy-rollback drill + D-06 copy sign-off, runbook §4c (AUTH-02, AUTH-05)

**Wave 5** *(blocked on 07-06)*

- [x] 07-07-PLAN.md — Production blast + flip release per §4c + D-38/D-40 canary (D-41 pre-committed abort) + 24h typed soak gate + D-36 approval (AUTH-02, AUTH-05, AUTH-06)

**Wave 6** *(blocked on 07-07 approval)*

- [x] 07-08-PLAN.md — Deletion release: NextAuth/Prisma/Redux-auth/js-cookie removal, extended remnant gate armed, §4d deploy (AUTH-07, AUTH-08, DRZ-07)

**Wave 7** *(blocked on 07-08)*

- [x] 07-09-PLAN.md — Drop release: 0003 drops the four legacy tables with data (D-27), rehearsed first, §4e deploy, DRZ-07 final proof + phase closeout (AUTH-07, DRZ-07)

**Research flag**: needs `--research-phase` depth — social `providerId` casing per provider, verification/reset token-flow cutover, cookieCache revocation-lag policy (SUMMARY.md) — *RESOLVED in 07-RESEARCH.md (providerId = lowercase provider config key `google`/`github`, verified from two official pages + dry-run; token TTLs at Better Auth defaults 3600s, legacy tokens never copied; cookieCache 5-min maxAge + disableCookieCache = the accepted revocation-lag policy)*

### Phase 8: Flagged Capabilities & UI Modernization

**Goal**: Post-migration value lands safely on stable tokens and stable APIs: AI behind a default-off flag, windowed-uptime compute behind a flag, and the full visual redesign.
**Mode:** mvp
**Depends on**: Phase 7
**Requirements**: AI-01, AI-02, AI-03, AI-04, AI-05, DAT-11, UI-01, UI-02, UI-03, UI-04, UI-05
**Success Criteria** (what must be TRUE):

  1. With `AI_ENABLED=false` (the default) the app runs fully with no AI keys, and zero AI calls exist anywhere in the check → transition → alert pipeline
  2. With the flag on: an authorized user gets a streaming incident post-mortem draft that is never auto-written to `incidents`, and can turn a natural-language description into monitor config validated by the same schema as the manual form that never executes without user confirmation; oversized, unauthenticated, rate-limited, and timeout-bound requests are rejected
  3. The nightly windowed-uptime recompute populates per-window columns from pings while the dashboard and status pages keep displaying lifetime counters — flag off changes nothing visible
  4. Dashboard components use shadcn primitives with one dialog system and one icon system; every polling fetch is abortable (AbortController), timers clear on unmount, URL derivation is hydration-safe, and there is a single Toaster
  5. The visual redesign ships with light mode looking intentional (light-safe brand assets, sidebar token reconciliation) while monitoring behavior and public API shapes stay unchanged — characterization and contract tests still green

**Plans**: 2/10 plans executed

Plans:
**Wave 1** *(release-a tag after completion)*

- [x] 08-01-PLAN.md — DAT-11 windowed-uptime backend: migration 0004 + nightly recompute job + scheduler + env entry, D-22 one-way decision gate, [BLOCKING] single-runner apply + rehearsal with carve-out extension (DAT-11)

**Wave 2** *(blocked on 08-01 — release-tag composition per D-37)*

- [x] 08-02-PLAN.md — UI-02 dialog + icon consolidation: shadcn dialog/alert-dialog (two-trap verified), 3 confirm-site + modal migrations, react-icons/sweetalert2 deletions with PHASE8 remnant gates, single Toaster (UI-02)

**Wave 3** *(blocked on 08-02 — shared Dashboard.tsx)*

- [ ] 08-03-PLAN.md — UI-04 client robustness: AbortController on all polling fetches, cleared timers, hydration-safe URL derivation, robustness e2e spec (UI-04)

**Wave 4** *(blocked on 08-03; parallel pair, no file overlap — sequence the two full-verify legs against the singleton test stack)*

- [ ] 08-04-PLAN.md — Tier-1 redesign: dashboard stats header + denser list + cleaner monitor detail on shadcn primitives, typography scale, tier-1 token migration, motion micro-interactions, skeleton loaders (UI-01, UI-05)
- [ ] 08-05-PLAN.md — UI-03 light mode (part 1 of the revision split): WR-02 marketing surfaces, 11-token review + per-mode splits, --dialog-* retirement, light-safe Lottie + light contrast/toast aesthetics (UI-03)

**Wave 5** *(blocked on 08-05 — release-b tag after completion)*

- [ ] 08-09-PLAN.md — UI-03 light mode (part 2 of the revision split): tier-2 sweep (public status, incidents, dashboard status, profile) + sidebar token reconciliation, emerald/rose ternary migration (UI-03)

**Wave 6** *(blocked on 08-04 + 08-05 + 08-09 — D-36 AI last)*

- [ ] 08-06-PLAN.md — AI provider foundation (part 1 of the revision split): AI SDK pins + zod, lib/ai env-swappable layer (GLM day-1 default + openai/anthropic/custom factories), aiEnabled helper, AI_* env entries (AI-01, AI-02)

**Wave 7** *(blocked on 08-06)*

- [ ] 08-10-PLAN.md — AI post-mortem route (part 2 of the revision split): shared guard chain (flag-off 404 / 401 / 429 Retry-After / input cap both sides), ownership-scoped evidence with the D-14 report sections, UIMessage streaming + D-10 log + zero DB writes, AI-in-worker gate leg, zero-key verify (AI-01, AI-02)

**Wave 8** *(blocked on 08-10)*

- [ ] 08-07-PLAN.md — AI feature UX: post-mortem inline streaming card (D-14 sections rendered) + monitor-assistant route/prefill (partial fill, submit-as-confirmation, D-16 regenerate on both features), server-side flag propagation, stub-provider e2e + D-21 zero-trace spec (AI-03, AI-04, AI-05)

**Wave 9** *(final — blocked on 08-07 — release-c tag; release-b cuts at post-08-09)*

- [ ] 08-08-PLAN.md — D-37/D-38 release choreography: runbook Phase-8 section, three soaked releases from pinned tags (windowed backend / redesign post-08-09 / AI dark), AI flip with live smoke, 08-DEPLOY-RECORD (AI-01, DAT-11, UI-05 production proof legs)

**UI hint**: yes

## Requirement Coverage

| Phase | Categories covered | Reqs |
|-------|--------------------|------|
| 1 Design Gate | DSGN | 2 |
| 2 Foundations & Theme | FND, THM, DEP-04 | 11 |
| 3 Redis & Drizzle Schema | RDS, DRZ-01..06, DAT-09 | 10 |
| 4 Worker Build & Dark Launch | WRK (excl. 09/11), DAT-01..08/10, RES, SEC-01/02, OBS-01/02, DEP-01/02 | 32 |
| 5 Cutover & Ops | WRK-09/11, DEP-03/05, OBS-03/05 | 6 |
| 6 Thin API & Email | API, SEC-03/05/06, EML-01..03/05 | 9 |
| 7 Auth & Prisma Removal | AUTH, DRZ-07, EML-04, SEC-04, OBS-04 | 13 |
| 8 Flagged Capabilities & UI | AI, DAT-11, UI | 11 |
| **Total** | | **94/94** |

Every v1 requirement maps to exactly one phase — no orphans, no duplicates. Full requirement-level traceability lives in `.planning/REQUIREMENTS.md`.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.
Phase 6 may execute in parallel with Phase 5 (both depend only on Phase 4); Phase 7 additionally requires Phase 6.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Design Gate — Review Verdict READY | 9/9 | Complete — cycle-2 clean pass ratified 2026-09-09, verdict flipped to READY (RR2-01/02/03 advisory Phase 4/5 design-debt) | 2026-09-09 |
| 2. Foundations & Theme Infrastructure | 10/10 | Gaps closed (02-10); round-2 verification human_needed — 5 UAT tests pending (02-UAT.md) | - |
| 3. Redis & Drizzle Schema Ownership | 0/TBD | Not started | - |
| 4. Monitoring Worker — Build & Dark Launch | 0/9 | Planned — research resolved, 9 plans across 6 waves | - |
| 5. Worker Cutover & Operational Hardening | 9/9 | Complete — deletion release d55cad5 shipped (worker owns 100% of checks, legacy cron deleted); D-18 approved, D-21 resolved-by-absence, tier-2 rollback rehearsed | 2026-09-19 |
| 6. Thin API Routes & Email Abstraction | 6/7 | In Progress|  |
| 7. Better Auth Cutover, Admin Gating & Prisma Removal | 11/11 | Complete    | 2026-09-30 |
| 8. Flagged Capabilities & UI Modernization | 2/10 | In Progress|  |

## Backlog

### Phase 999.1: Follow-up — Phase 07 deferred UAT follow-up: Test 61 (BACKLOG)

**Goal:** Exercise the live Google/GitHub OAuth no-re-consent proof (D-40) when the stack first deploys with real OAuth credentials
**Source phase:** 07
**Deferred at:** 2026-09-30 during /gsd-verify-work 07 session completion
**Follow-ups:**
- [ ] Test 61: Live Google/GitHub OAuth no-re-consent proof (D-40) at the live server deploy (deferred 2026-09-30)
