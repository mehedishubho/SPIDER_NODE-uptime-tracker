# Roadmap: SpiderNode Backend Modernization

## Overview

A brownfield modernization of a live production uptime-monitoring SaaS. The arc follows audit §24: make the design review-ready on paper first, then build the safety net (tests, CI gates, stable theme tokens), take ownership of the schema (Redis with no correctness dependence + Drizzle baselined from live DDL), move monitoring execution into a dedicated BullMQ worker (dark launch, then gated overlap cutover), thin the API boundary, cut auth over to Better Auth and delete Prisma, and only then land flagged capabilities (AI, windowed uptime) and the visual redesign. Every phase ships a complete, revertible increment — monitoring never stops, loses data, or locks users out.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Design Gate — Review Verdict READY** - All 8 review addenda incorporated, §9 checklist resolved, verdict flipped NOT READY → READY before any code — **complete 2026-09-09: cycle-2 re-review clean pass (zero blocking findings) human-ratified, verdict flipped to READY per D-16; RR2-01/02/03 recorded as advisory Phase 4/5 design-debt (01-09)**
- [ ] **Phase 2: Foundations & Theme Infrastructure** - pnpm, CI gates, characterization tests on real Postgres/Redis; theme tokens land with zero behavior change
- [ ] **Phase 3: Redis & Drizzle Schema Ownership** - Redis with no correctness dependence; live-DDL Drizzle baseline plus worker schema addenda, rehearsed on a prod snapshot
- [ ] **Phase 4: Monitoring Worker — Build & Dark Launch** - Dedicated worker owns all monitoring on idempotent, resilient BullMQ machinery; dark-launched while cron still serves users
- [ ] **Phase 5: Worker Cutover & Operational Hardening** - Gated overlap cutover deletes the cron; heartbeat moves, observability, env transition, rehearsed rollback
- [ ] **Phase 6: Thin API Routes & Email Abstraction** - Web becomes an enqueue-only producer; security fixes at the new boundary; email queued off the request path
- [ ] **Phase 7: Better Auth Cutover, Admin Gating & Prisma Removal** - Canary-gated auth cutover onto existing tables; admin roles gate feedback and queue UI; Prisma deleted
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

**Plans**: 9 plans

Plans:
**Wave 1**

- [ ] 02-01-PLAN.md — Toolchain migration & repo hygiene: pnpm exact-freeze, Node 24 pin, deploy.yml/ngrok/test-script deletions, .env.example, error-leak fix (FND-01, FND-03, FND-07)

**Wave 2** *(blocked on 02-01)*

- [ ] 02-02-PLAN.md — Test scaffold: docker Postgres/Redis stack, Vitest + Playwright configs, localhost DB guard, ONE smoke E2E, pnpm verify chain (FND-04, DEP-04)

**Wave 3** *(blocked on 02-02; parallel, no file overlap)*

- [ ] 02-03-PLAN.md — Data-path characterization: cron-logic transitions + db-batcher flush math on real Postgres, audit §23 transcribed (FND-05, FND-06)
- [ ] 02-04-PLAN.md — Runbook amendments: manual-deploy steps, one-time VPS Node/pnpm switch, typed post-deploy checks (DEP-04; D-01..D-05/D-14/D-26)

**Wave 4** *(blocked on 02-02 + 02-03 — shared docker test stack)*

- [ ] 02-05-PLAN.md — API contract characterization: handler-import harness + pinned defects + HTTP-level core routes via Playwright api project (FND-06)

**Wave 5** *(blocked on 02-01 + 02-03 + 02-05 — flip gated on green suite per D-19)*

- [ ] 02-06-PLAN.md — Typecheck fix-all-then-flip: size pile (D-12 gate), minimal-churn fixes, ignoreBuildErrors off + stale configs deleted, canary proof (FND-02)

**Wave 6** *(blocked on 02-06)*

- [ ] 02-07-PLAN.md — Theme infrastructure vertical slice: RED e2e first, next-themes + toggle + toaster, palette split with frozen .dark (THM-01, THM-02)

**Wave 7** *(blocked on 02-07)*

- [ ] 02-08-PLAN.md — Hex→token mechanical migration, same dark values, status-token adoption, hex gate (THM-03)

**Wave 8** *(final — blocked on 02-03 + 02-05 + 02-08)*

- [ ] 02-09-PLAN.md — D-21 mutation spot-check: three deliberate behavior breaks proven red then reverted; final full pnpm verify (FND-05, FND-06)

**UI hint**: yes

### Phase 3: Redis & Drizzle Schema Ownership

**Goal**: Redis serves non-critical work with zero correctness dependence, and the database schema is owned by versioned Drizzle migrations baselined from live DDL, with every worker prerequisite landed and rehearsed against a production snapshot.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: RDS-01, RDS-02, RDS-03, DRZ-01, DRZ-02, DRZ-03, DRZ-04, DRZ-05, DRZ-06, DAT-09
**Success Criteria** (what must be TRUE):

  1. Rate limiting is Redis-backed and atomic (INCR+EXPIRE per bucket): restarting the app process mid-burst does not reset a limit window, and a Redis outage never corrupts Postgres data — the limiter degrades safely
  2. `drizzle-kit pull` against production yields an empty diff against the committed schema (or an explicitly reviewed delta), the empty-diff CI gate blocks silent drift, and new code reads/writes through Drizzle sharing one `pg` Pool with Prisma — never dual-write
  3. The migration history contains every worker prerequisite, applied additively (no drops/renames): `monitors.next_check_at` + partial index `(is_active, next_check_at)`, `write_guards`, `outbox`, partial unique `incidents(monitor_id) WHERE status='ONGOING'`, pinned ID-generation defaults, `error_class`, reserved `consecutive_failures`
  4. Migrations have been rehearsed against an anonymized production snapshot with row-count and checksum verification matching; the deploy pipeline runs the single migration runner, and `prisma db push --accept-data-loss` no longer exists anywhere
  5. Redis hardening is applied and documented (AOF `everysec`, `maxmemory-policy noeviction`, supervised restart, memory alert at 70%) and ioredis clients follow BullMQ 6 config — separate blocking + queue connections, `maxRetriesPerRequest: null` on the worker side, no `keyPrefix` — with the connection budget (web 10 / worker 20 / migrations 1) documented

**Plans**: TBD
**Research flag**: verify drizzle-kit baseline journal-stamping and transaction-wrapping vs `CREATE INDEX CONCURRENTLY` during the snapshot rehearsal (SUMMARY.md gaps)

### Phase 4: Monitoring Worker — Build & Dark Launch

**Goal**: All monitoring execution runs in a dedicated worker process on durable, idempotent, resilient BullMQ machinery — built, failure-injection-tested, and dark-launched while the existing cron still serves every user.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: WRK-01, WRK-02, WRK-03, WRK-04, WRK-05, WRK-06, WRK-07, WRK-08, WRK-10, WRK-12, WRK-13, WRK-14, DAT-01, DAT-02, DAT-03, DAT-04, DAT-05, DAT-06, DAT-07, DAT-08, DAT-10, RES-01, RES-02, RES-03, RES-04, RES-05, SEC-01, SEC-02, OBS-01, OBS-02, DEP-01, DEP-02
**Success Criteria** (what must be TRUE):

  1. The worker deploys as a second PM2 app built from the same repo/SHA as web, dark-launched with its scheduler paused while the deploy pipeline is rehearsed and the cron still performs every check; `/healthz` and `/readyz` respond on `:9090` (readyz fails when Redis or Postgres is down), and restarting the web app never interrupts checking
  2. Duplicate delivery of a check job produces exactly one ping row (SQL claim advancing `next_check_at` + schedule-epoch idempotency key + per-monitor lock with owner-only release); DOWN/RECOVERED/first-check transitions commit monitor + ping + incident + outbox in one synchronous transaction and yield exactly one Telegram alert per incident; routine UP results flush within 60 s via a guarded atomic update that never writes `status`; manual checks and non-UP monitors are prioritized with documented worst-case latency
  3. Killing the worker mid-job (SIGKILL past `kill_timeout`) then restarting neither loses nor double-applies writes — counter deltas stay correct and no second ONGOING incident appears; retries are bounded (3–5) with exponential backoff and DLQ retention; SIGINT drains in-flight jobs within `kill_timeout`
  4. Failure injection proves both outage directions: Postgres down → jobs retry (nothing silently lost), the circuit breaker opens and pauses enqueueing, and the backlog cap drops routine checks but never transitions; Redis down → monitoring pauses by design, Postgres stays intact, and in-product staleness ("last checked Xm ago") is visible to users
  5. The check engine enforces SSRF layering (per-redirect-hop private-range denial, scheme allowlist, 2 MB cap, strict 10 s timeout — test cases pass) with OS-level egress rules active on the worker host; an operator can trace one check end-to-end via `monitorId`-correlated structured logs and queue metrics (depth, job age, stalled count); the maintenance job has a dry-run that reports row counts without deleting; the pipeline orders build → backup → migrate → worker (waits readyz) → web → smoke check that produces a synthetic ping row

**Plans**: TBD
**Research flag**: needs `--research-phase` depth — BullMQ 6 `upsertJobScheduler` semantics, breaker/backlog tuning, PM2 `wait_ready`/`kill_timeout` handshake, overlap gate instrumentation (SUMMARY.md)

### Phase 5: Worker Cutover & Operational Hardening

**Goal**: The worker becomes the only monitoring path through a gated overlap window, and operators gain early-warning signals plus a rehearsed rollback story.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: WRK-09, WRK-11, DEP-03, DEP-05, OBS-03, OBS-05
**Success Criteria** (what must be TRUE):

  1. During the overlap window both paths run idempotently with zero monitoring gap: no monitor misses a scheduled check, the healthchecks.io heartbeat comes steadily from the worker scheduler tick, queue depth returns to ~0, and Telegram alert parity holds for a full verification window
  2. After cutover `instrumentation.ts` and `CRON_MODE` are deleted (CI greps the build to keep cron remnants out), the worker is the sole monitoring path, and the external dead-man's switch pages if the worker tick stops
  3. Operators see trouble before users do: outbox-age alerting fires when rows exceed the threshold, and Prometheus exports queue depth/age, stalled count, transition→alert latency, and Redis memory
  4. Rollback is rehearsed: restoring the previous tarball returns the prior release cleanly, expand/contract discipline holds (no drops or renames inside verification windows), and the environment transition is complete (`REDIS_URL`, `EMAIL_PROVIDER`, `BETTER_AUTH_*` documented; `NEXTAUTH_*`/`CRON_MODE` retired or on a dated retirement path in `.env.example`)

**Plans**: TBD

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

**Plans**: TBD

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

**Plans**: TBD
**Research flag**: needs `--research-phase` depth — social `providerId` casing per provider, verification/reset token-flow cutover, cookieCache revocation-lag policy (SUMMARY.md)

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

**Plans**: TBD
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
| 2. Foundations & Theme Infrastructure | 0/9 | Planned — 9 plans across 8 waves | - |
| 3. Redis & Drizzle Schema Ownership | 0/TBD | Not started | - |
| 4. Monitoring Worker — Build & Dark Launch | 0/TBD | Not started | - |
| 5. Worker Cutover & Operational Hardening | 0/TBD | Not started | - |
| 6. Thin API Routes & Email Abstraction | 0/TBD | Not started | - |
| 7. Better Auth Cutover, Admin Gating & Prisma Removal | 0/TBD | Not started | - |
| 8. Flagged Capabilities & UI Modernization | 0/TBD | Not started | - |
