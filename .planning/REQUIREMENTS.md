# Requirements: SpiderNode Backend Modernization

**Defined:** 2026-09-08
**Core Value:** Modernize the infrastructure without breaking existing monitoring functionality — the monitoring engine must never lose or corrupt uptime data, silently stop checking, or lock users out irrecoverably.

**Source documents:** `docs/ARCHITECTURE-AUDIT.md` (audit + target architecture), `docs/ARCHITECTURE-REVIEW.md` (blocking issues J/D/R/A/S/M/P), `.planning/research/` (verified ecosystem research).

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases. Review-issue traceability in parentheses.

### Design Gate

- [ ] **DSGN-01**: All 8 design addenda from review §8 incorporated into the design documents (amended audit or authored addendum): schema, scheduler spec, check job spec, writer specs, resilience spec, auth spec, connection budget, deploy runbook
- [ ] **DSGN-02**: Review §9 pre-implementation checklist fully resolved in design; verdict re-reviewed from NOT READY to READY before implementation code

### Foundations

- [ ] **FND-01**: Package manager migrated to pnpm (committed lockfile, npm artifacts removed, `onlyBuiltDependencies` configured)
- [ ] **FND-02**: Typecheck enforced (`ignoreBuildErrors` off) and lint/typecheck gates green in CI
- [ ] **FND-03**: Node version standardized across dev/CI before tooling version pins (BullMQ 6 major pinned)
- [ ] **FND-04**: Vitest + Playwright scaffolding wired with docker-compose Postgres/Redis for local dev and CI
- [ ] **FND-05**: Characterization tests pin `runCronChecks` behavior: due-time filtering, UP/DOWN classification, transition paths (PENDING→UP, UP→DOWN, DOWN→UP), incident open/resolve, Telegram message selection
- [ ] **FND-06**: Characterization tests pin db-batcher enqueue/flush math and per-route API contracts (auth required, ownership scoping, status codes)
- [ ] **FND-07**: Repo hygiene: ngrok binary/log removed, `.env.example` documenting the full variable set, error responses never include stack traces

### Theme Infrastructure

- [ ] **THM-01**: Light/dark theme infrastructure (`next-themes`, class strategy): real light `:root` palette, current dark values preserved as `.dark`, inline pre-paint script with no FOUC or hydration mismatch
- [ ] **THM-02**: Theme toggle (Light/Dark/System) in app header/nav; resolved theme passed to Sonner Toaster
- [ ] **THM-03**: Hardcoded hex classes migrated to semantic tokens (mechanical hygiene; no visual change)

### Redis Infrastructure

- [ ] **RDS-01**: Redis introduced (ioredis 6, explicit install for BullMQ 6) with correct client config: separate blocking + queue connections, `maxRetriesPerRequest: null`, no `keyPrefix`
- [ ] **RDS-02**: Redis-backed rate limiting replaces the in-memory Map (atomic INCR+EXPIRE per bucket)
- [ ] **RDS-03**: Redis hardening applied and documented: AOF `everysec`, `maxmemory-policy noeviction`, supervised restart, memory alerting at 70%

### Drizzle Migration

- [ ] **DRZ-01**: Drizzle schema authored from **live production DDL** (`pg_dump --schema-only`), not `schema.prisma`; equivalence proven by empty diff or explicitly reviewed delta
- [ ] **DRZ-02**: Versioned drizzle-kit migrations replace `prisma db push`; single migration runner in the deploy pipeline; `--accept-data-loss` deleted
- [ ] **DRZ-03**: Empty-diff CI gate (`drizzle-kit pull` diffed against committed schema) preventing silent schema drift
- [ ] **DRZ-04**: Schema addenda in the Drizzle schema: `monitors.next_check_at` + partial index `(is_active, next_check_at)`, `write_guards`, `outbox`, partial unique index `incidents(monitor_id) WHERE status='ONGOING'`, pinned ID-generation defaults, `error_class` metadata, `consecutive_failures` reserved
- [ ] **DRZ-05**: Drizzle adopted additively (new code uses Drizzle only) sharing one `pg` Pool with Prisma during transition; no dual-write
- [ ] **DRZ-06**: Migrations rehearsed against an anonymized local prod snapshot with row-count + checksum verification before production
- [ ] **DRZ-07**: Prisma fully removed after cutover: `prisma/`, generated client, `@prisma/*` deps, adapter config deleted

### Worker & Orchestration

- [ ] **WRK-01**: Dedicated worker process (second PM2 app; never inside `next start`) owns all monitoring execution
- [ ] **WRK-02**: BullMQ 6 queue topology (scheduler, checks, db-writes, alerts, maintenance, email) using `upsertJobScheduler` for recurring jobs (legacy repeatables removed in v6)
- [ ] **WRK-03**: Claim-based due-selection: single `FOR UPDATE SKIP LOCKED` transaction advancing `next_check_at`; idempotency key `check:{monitorId}:{next_check_at epoch}`; tick ≤ ½ minimum interval; failed-enqueue compensation (J-1)
- [ ] **WRK-04**: Per-monitor distributed lock: TTL = timeout + margin, renewal every TTL/3, owner-only Lua compare-and-delete, abort-on-lock-loss (J-3)
- [ ] **WRK-05**: Typed result-vs-error classification: target outcomes (UP/DOWN/timeout/DNS/TLS) are successful jobs; only infra failures throw (J-4)
- [ ] **WRK-06**: Retries with exponential backoff, bounded attempts (3–5), DLQ retention via `removeOnFail` age
- [ ] **WRK-07**: Graceful shutdown: SIGINT handler + `worker.close()` + PM2 `kill_timeout` ≥ max job duration (~20 s); `stalledInterval`/`maxStalledCount` bounded
- [ ] **WRK-08**: Worker health endpoints: `:9090/healthz` (process only) and `/readyz` (Redis + DB ping) gating releases
- [ ] **WRK-09**: healthchecks.io heartbeat moved to the worker scheduler tick (before any cron deletion)
- [ ] **WRK-10**: Worker dark launch: deployed with scheduler paused and deploy pipeline rehearsed while nothing depends on it, before cutover
- [ ] **WRK-11**: Overlap-window cutover: old cron and worker run idempotently together; `instrumentation.ts` cron + `CRON_MODE` deleted only after verification (heartbeat steady, queue depth ≈ 0, alert parity, counter deltas sane)
- [ ] **WRK-12**: Priority handling for manual checks and monitors in non-UP state (priorities or separate lane) with documented worst-case latency (J-6)
- [ ] **WRK-13**: Maintenance jobs support dry-run mode (report row counts without deleting)
- [ ] **WRK-14**: Web and worker share TypeScript from one repo and one build (single package + worker build target, or documented workspace)

### Data Correctness

- [ ] **DAT-01**: Two-tier persistence: DOWN/RECOVERED/first-check/manual transitions written in one synchronous Postgres transaction (monitor + ping + incident + outbox)
- [ ] **DAT-02**: Routine-UP aggregation ≤60 s in Redis applied via one guarded atomic UPDATE per monitor (additive counters, `GREATEST` last_checked, response_time monotonicity, never writes `status`)
- [ ] **DAT-03**: Transactional write guards: guard insert + delta apply in the same Postgres transaction; `ON CONFLICT DO NOTHING` skips re-application (J-2)
- [ ] **DAT-04**: Conditional transition UPDATE (`WHERE status <> target`) plus partial unique index enforcing one ONGOING incident per monitor (D-1)
- [ ] **DAT-05**: Transactional outbox for transition events; relay job (`FOR UPDATE SKIP LOCKED`, batched) enqueues alerts and marks rows sent (D-2)
- [ ] **DAT-06**: Incident-keyed alert dedup (`SET NX EX` after confirmed send; retries check first; ≤3 attempts) (D-4)
- [ ] **DAT-07**: Deterministic ID generation pinned in Drizzle columns; bulk-insert paths verified never to produce `undefined` PKs (D-3)
- [ ] **DAT-08**: Retention deletes batched (looped `LIMIT ~5000`) in the maintenance queue only (D-7)
- [ ] **DAT-09**: Connection budget enforced: web 10 / worker 20 / migration runner 1; shared pool during ORM transition; statement + idle timeouts set; pooled string for web reads, direct for migrations (D-8)
- [ ] **DAT-10**: `error_class` + status code metadata recorded on pings/incidents (N-5)
- [ ] **DAT-11**: Windowed uptime backend behind a flag: per-window columns + nightly recompute from pings; lifetime counters remain the displayed numbers

### Resilience

- [ ] **RES-01**: Circuit breaker around Postgres: infra-failure rate threshold → OPEN (queue pause, stop enqueueing) → HALF_OPEN probe → CLOSED (J-5)
- [ ] **RES-02**: Backlog cap: routine checks droppable at queue depth > ~2× active monitors; transitions never droppable
- [ ] **RES-03**: Redis outage = monitoring pause by design (no fallback scheduler); detected via external dead-man's switch; UI surfaces "last checked Xm ago" staleness (R-1)
- [ ] **RES-04**: Postgres outage produces retryable jobs — no silently lost results; failure-injection tests prove Redis-down leaves Postgres intact and Postgres-down loses nothing
- [ ] **RES-05**: Redis-restart recovery procedure: schedulers re-upserted at boot, stale locks expire via TTL, next tick re-claims via `next_check_at`

### Security

- [ ] **SEC-01**: SSRF layering in the check engine: resolve-then-validate all IPs against a private-range denylist per redirect hop (≤5), scheme allowlist, 2 MB response cap, strict 10 s timeout — with SSRF test cases (S-1)
- [ ] **SEC-02**: OS-level egress control on the worker host (deny private ranges; allow 80/443 egress only)
- [ ] **SEC-03**: Telegram webhook authenticated via `secret_token` (X-Telegram-Bot-Api-Secret-Token header check) (S-2)
- [ ] **SEC-04**: Admin role via Better Auth admin plugin; feedback listing admin-gated; any queue UI admin-gated + IP allowlist (S-3)
- [ ] **SEC-05**: Per-user enqueue rate limiter on the manual-check endpoint
- [ ] **SEC-06**: No secret accepted via query string; `CRON_SECRET` retires with the cron endpoints (S-4/R15)

### API Layer

- [ ] **API-01**: Manual check becomes enqueue + 202 + optimistic read + poll; API routes never execute checks (rule 4–6)
- [ ] **API-02**: API enqueue fails loudly (503) when Redis is unreachable — never silently no-ops

### Auth Migration

- [ ] **AUTH-01**: Better Auth configured with bcrypt-compatible `password.hash`/`verify` (gate, not spike) with hash-prefix routing (A-1)
- [ ] **AUTH-02**: Canary account login verified through the preserved hash path before any route flip — on the local snapshot, then production
- [ ] **AUTH-03**: Adapter bound to the existing `users` table (explicit table/column mapping, no renames; IDs preserved); `account`/`session`/`verification` added; boolean `emailVerified` backfilled from NextAuth timestamps
- [ ] **AUTH-04**: Session strategy: `cookieCache` (short TTL) so the proxy validates from the signed cookie without a per-request DB hit (A-2)
- [ ] **AUTH-05**: OAuth accounts reshaped to Better Auth's `account` table with a verified field map (`providerId` casing confirmed by dry-run); refresh tokens preserved
- [ ] **AUTH-06**: Forced re-login at cutover announced in-app/email (Q-4)
- [ ] **AUTH-07**: NextAuth deps and custom auth routes removed; legacy `sessions`/token tables retained read-only one release, then dropped
- [ ] **AUTH-08**: Duplicated client auth state removed (Redux `auth` slice, token mirror, `js-cookie`); Better Auth client is the single source; Redux retained for UI/domain state only
- [ ] **AUTH-09**: Lazy rehash-on-login: bcrypt verify upgrades the stored hash to the modern default

### Email

- [ ] **EML-01**: Provider interface (`send()`) with env-selected providers: SMTP (Nodemailer, current Hostinger behavior), console (dev); extensible to Resend
- [ ] **EML-02**: Email sends off the request path via queue (bounded attempts, backoff); registration succeeds when SMTP is down (degradation path defined) (N-6)
- [ ] **EML-03**: Typed retryable-vs-permanent errors — hopeless sends do not retry (`UnrecoverableError`)
- [ ] **EML-04**: Better Auth hooks (`sendVerificationEmail`, `sendResetPassword`) delegate to the same queue
- [ ] **EML-05**: Existing HTML template preserved verbatim through the migration (relocated, not redesigned)

### Observability

- [ ] **OBS-01**: Queue metrics exported: depth per queue, job age (not just depth), stalled count, transition→alert latency, Redis memory %
- [ ] **OBS-02**: Structured logs with `monitorId` correlation across scheduler → check → persist → alert
- [ ] **OBS-03**: Outbox-age alerting (rows older than N seconds page the operator)
- [ ] **OBS-04**: Bull Board queue inspection behind admin auth + IP allowlist
- [ ] **OBS-05**: Prometheus export (BullMQ telemetry + custom gauges) with optional dashboard

### AI Integration

- [ ] **AI-01**: `AI_ENABLED` flag, off by default; the app runs fully without any AI keys
- [ ] **AI-02**: AI endpoints are streaming, session-guarded, rate-limited (Redis limiter), input-size-capped, and timeout-bound; provider/model centralized in `lib/ai`
- [ ] **AI-03**: Incident summarization: post-mortem draft from an incident + pings window; output never auto-written to `incidents`
- [ ] **AI-04**: Monitor-setup assistant: natural language → config JSON validated by the same schema as the manual form; never executed without user confirmation
- [ ] **AI-05**: Zero AI calls in the check → transition → alert pipeline (rule 15)

### UI Modernization (final phase only)

- [ ] **UI-01**: shadcn/ui primitives adopted for dashboard feature components (replacing hand-rolled Tailwind where sensible)
- [ ] **UI-02**: Dialog consolidation (`sweetalert2`/`window.confirm` → shadcn alert-dialog) and icon consolidation to a single system
- [ ] **UI-03**: Light palette refinement + light-safe brand assets (Lottie overlays, sidebar token reconciliation)
- [ ] **UI-04**: Client robustness fixes: AbortController on polling fetches, cleared timers, hydration-safe URL derivation, removed duplicate Toaster
- [ ] **UI-05**: Full visual redesign executed only on stable tokens + stable APIs after backend migration completes

### Deployment

- [ ] **DEP-01**: Two PM2 apps (web + worker) built and versioned from one SHA; `kill_timeout` ≥ max job duration; crash-loop visibility configured
- [ ] **DEP-02**: Deploy ordering: build → backup (`pg_dump`) → migrate (single runner) → restart worker (waits `readyz`) → restart web → smoke-check (synthetic check → ping row appears)
- [ ] **DEP-03**: Rollback story: previous tarball retained; expand/contract discipline (additive-only migrations during verification windows; drops deferred to a following release)
- [ ] **DEP-04**: CI gates on PRs: lint → typecheck → unit/integration → build; deploy only from `main` after green
- [ ] **DEP-05**: Environment transition complete: `REDIS_URL`, `EMAIL_PROVIDER`, `BETTER_AUTH_*` added; `NEXTAUTH_*`, `CRON_MODE` retired; `.env.example` kept current

## v2 Requirements

Deferred. Tracked, not in the current roadmap.

### Alerting Extensions
- **ALRT-01**: Incident email notifications via the email abstraction (UPGRADE_PLAN phase 7)
- **ALRT-02**: N-consecutive-failure DOWN threshold (`consecutive_failures` column reserved in v1)

### Product Extensions
- **PROD-01**: Windowed uptime display (24 h/7 d/30 d) in dashboard/status pages (backend ships flagged in v1; display switch is a post-milestone product decision)
- **PROD-02**: Advanced monitor types — keyword, TCP, SSL checks (frozen per M12; schema reserves columns)
- **PROD-03**: Multi-instance worker scale-out exercise (path is safe by construction in v1; not exercised)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep. Each is an anti-feature validated by research or a hard-constraint consequence.

| Feature | Reason |
|---------|--------|
| In-process fallback scheduler when Redis is down | Incoherent with BullMQ (no Redis = no jobs); recreates forbidden process-local monitoring state; hides the outage (R-1) |
| Dual-write Prisma + Drizzle period | Two ORMs writing one schema diverge and corrupt; cutover is by module (M1) |
| AI in the check → transition → alert path | AI outage would corrupt uptime accuracy (rule 15) |
| Exactly-once delivery infrastructure | Impossible across independent systems; at-least-once + guards + dedup is the correct ceiling |
| Redlock / multi-node lock consensus | No fencing tokens, wrong system model, wrong scale (Kleppmann) |
| Redis as authoritative state | Hard constraint: PostgreSQL is always the source of truth |
| Windowed uptime display switch mid-migration | Changes public numbers during behavior-compatibility window (D-6/Q-1) |
| Incident alert emails in v1 | Telegram-only is the compatibility contract; email channel lands in v2 |
| Flapping threshold change in v1 | Characterization tests pin 1-strike DOWN; semantics changes are post-milestone (Q-2/N-4) |
| Synchronous manual check in the web process | Web process executing checks is exactly what the worker extraction forbids (Q-5) |
| Dropping transitions under backlog | Transition evidence is the product; only routine checks are droppable (J-5 asymmetry) |
| Migrations at web/worker boot | Concurrent boot = concurrent DDL; single runner only (M-1) |
| Unauthenticated queue-inspection UI | New unauthenticated surface (S-3) |
| New user-facing product features | This milestone is modernization only |
| Managed Redis hosting | Self-host on VPS chosen (Q-3); revisit only if operational burden demands |

## Traceability

Which phases cover which requirements. Updated during roadmap creation (2026-09-08).

| Requirement | Phase | Status |
|-------------|-------|--------|
| DSGN-01 | Phase 1 | Pending |
| DSGN-02 | Phase 1 | Pending |
| FND-01 | Phase 2 | Pending |
| FND-02 | Phase 2 | Pending |
| FND-03 | Phase 2 | Pending |
| FND-04 | Phase 2 | Pending |
| FND-05 | Phase 2 | Pending |
| FND-06 | Phase 2 | Pending |
| FND-07 | Phase 2 | Pending |
| THM-01 | Phase 2 | Pending |
| THM-02 | Phase 2 | Pending |
| THM-03 | Phase 2 | Pending |
| DEP-04 | Phase 2 | Pending |
| RDS-01 | Phase 3 | Pending |
| RDS-02 | Phase 3 | Pending |
| RDS-03 | Phase 3 | Pending |
| DRZ-01 | Phase 3 | Pending |
| DRZ-02 | Phase 3 | Pending |
| DRZ-03 | Phase 3 | Pending |
| DRZ-04 | Phase 3 | Pending |
| DRZ-05 | Phase 3 | Pending |
| DRZ-06 | Phase 3 | Pending |
| DAT-09 | Phase 3 | Pending |
| WRK-01 | Phase 4 | Pending |
| WRK-02 | Phase 4 | Pending |
| WRK-03 | Phase 4 | Pending |
| WRK-04 | Phase 4 | Pending |
| WRK-05 | Phase 4 | Pending |
| WRK-06 | Phase 4 | Pending |
| WRK-07 | Phase 4 | Pending |
| WRK-08 | Phase 4 | Pending |
| WRK-10 | Phase 4 | Pending |
| WRK-12 | Phase 4 | Pending |
| WRK-13 | Phase 4 | Pending |
| WRK-14 | Phase 4 | Pending |
| DAT-01 | Phase 4 | Pending |
| DAT-02 | Phase 4 | Pending |
| DAT-03 | Phase 4 | Pending |
| DAT-04 | Phase 4 | Pending |
| DAT-05 | Phase 4 | Pending |
| DAT-06 | Phase 4 | Pending |
| DAT-07 | Phase 4 | Pending |
| DAT-08 | Phase 4 | Pending |
| DAT-10 | Phase 4 | Pending |
| RES-01 | Phase 4 | Pending |
| RES-02 | Phase 4 | Pending |
| RES-03 | Phase 4 | Pending |
| RES-04 | Phase 4 | Pending |
| RES-05 | Phase 4 | Pending |
| SEC-01 | Phase 4 | Pending |
| SEC-02 | Phase 4 | Pending |
| OBS-01 | Phase 4 | Pending |
| OBS-02 | Phase 4 | Pending |
| DEP-01 | Phase 4 | Pending |
| DEP-02 | Phase 4 | Pending |
| WRK-09 | Phase 5 | Pending |
| WRK-11 | Phase 5 | Pending |
| DEP-03 | Phase 5 | Pending |
| DEP-05 | Phase 5 | Pending |
| OBS-03 | Phase 5 | Pending |
| OBS-05 | Phase 5 | Pending |
| API-01 | Phase 6 | Pending |
| API-02 | Phase 6 | Pending |
| SEC-03 | Phase 6 | Pending |
| SEC-05 | Phase 6 | Pending |
| SEC-06 | Phase 6 | Pending |
| EML-01 | Phase 6 | Pending |
| EML-02 | Phase 6 | Pending |
| EML-03 | Phase 6 | Pending |
| EML-05 | Phase 6 | Pending |
| AUTH-01 | Phase 7 | Pending |
| AUTH-02 | Phase 7 | Pending |
| AUTH-03 | Phase 7 | Pending |
| AUTH-04 | Phase 7 | Pending |
| AUTH-05 | Phase 7 | Pending |
| AUTH-06 | Phase 7 | Pending |
| AUTH-07 | Phase 7 | Pending |
| AUTH-08 | Phase 7 | Pending |
| AUTH-09 | Phase 7 | Pending |
| DRZ-07 | Phase 7 | Pending |
| EML-04 | Phase 7 | Pending |
| SEC-04 | Phase 7 | Pending |
| OBS-04 | Phase 7 | Pending |
| AI-01 | Phase 8 | Pending |
| AI-02 | Phase 8 | Pending |
| AI-03 | Phase 8 | Pending |
| AI-04 | Phase 8 | Pending |
| AI-05 | Phase 8 | Pending |
| DAT-11 | Phase 8 | Pending |
| UI-01 | Phase 8 | Pending |
| UI-02 | Phase 8 | Pending |
| UI-03 | Phase 8 | Pending |
| UI-04 | Phase 8 | Pending |
| UI-05 | Phase 8 | Pending |

**Coverage:**
- v1 requirements: 94 total
- Mapped to phases: 94
- Unmapped: 0 ✓

**Coverage by phase:** Phase 1: 2 · Phase 2: 11 · Phase 3: 10 · Phase 4: 32 · Phase 5: 6 · Phase 6: 9 · Phase 7: 13 · Phase 8: 11

---
*Requirements defined: 2026-09-08*
*Last updated: 2026-09-08 — traceability populated by roadmap creation (94/94 mapped)*
