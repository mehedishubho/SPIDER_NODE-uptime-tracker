# SpiderNode Uptime Tracker — Backend Modernization

## What This Is

SpiderNode is a live, production uptime-monitoring SaaS (Next.js 16 App Router, single VPS under PM2) that checks user-defined URLs on cron schedules, records pings/incidents in PostgreSQL, and alerts via Telegram. This milestone is a **backend/infrastructure modernization — no new user-facing features** — migrating to Drizzle ORM, Better Auth, Redis + BullMQ job orchestration, and a dedicated monitoring worker process, followed by Redux pruning, an AI SDK integration (flagged off), and a final visual redesign.

Authoritative source documents: `docs/ARCHITECTURE-AUDIT.md` (audit + target architecture, §1–24) and `docs/ARCHITECTURE-REVIEW.md` (verdict **READY** since 2026-09-09 — flipped from NOT READY via the Phase 01 design gate; §9 pre-implementation checklist resolved, §8 addenda incorporated).

## Core Value

Modernize the infrastructure **without breaking existing monitoring functionality** — the monitoring engine must never lose or corrupt uptime data, silently stop checking, or lock users out irrecoverably. Every migration step ships revertibly with monitoring continuity preserved (audit M3 overlap window).

## Requirements

### Validated

Inferred from existing codebase (`.planning/codebase/` map) — current capabilities the migration must preserve:

- ✓ HTTP(S) uptime checks on minute-granularity intervals (default 5 min, 10s timeout) — existing
- ✓ Status lifecycle PENDING → UP/DOWN with incident tracking (ONGOING/RESOLVED) — existing
- ✓ Telegram alerts on DOWN / RECOVERED / first-check-started — existing
- ✓ Auth: email+password (bcrypt, email-verification gated), Google OAuth, GitHub OAuth — existing
- ✓ Email verification and password-reset flows via Hostinger SMTP — existing
- ✓ Monitor CRUD with 10-monitor free-tier cap and ownership checks — existing
- ✓ Dashboard: monitors list, monitor detail (pings/incidents), incidents page, polling UI — existing
- ✓ Public status page per user (`/status/[userId]`) — existing
- ✓ Manual "check now" per monitor — existing
- ✓ Retention cleanup: pings >30 days, resolved incidents >90 days — existing
- ✓ Telegram account linking via bot deep-link + webhook — existing
- ✓ Profile management with Cloudinary avatar upload — existing
- ✓ Feedback submission — existing
- ✓ Dual-cron trigger (internal node-cron or Vercel Cron HTTP) with healthchecks.io dead-man's switch — existing (replaced, not preserved)
- ✓ Design gate: all 8 §8 addenda incorporated into audit/runbook, 25/25 §9 checklist items resolved, review verdict flipped NOT READY → READY on a human-ratified D-18 cycle-2 clean pass — **Validated in Phase 01: design-gate-review-verdict-ready** (26/26 verification; design-debt register in `01-VERIFICATION.md` — CR-01/CR-02 must be consumed by Phase 4/5 planning)

### Active

The modernization. Binding hard constraints (treat as non-negotiable; audit rules 1–20):

- [ ] **PostgreSQL is always the source of truth; Redis is infrastructure only, never primary storage.**
- [ ] **Monitoring execution runs in a dedicated worker — Next.js API routes must never become the permanent monitoring worker.**
- [ ] **All process-local in-memory monitoring state and in-memory write batching removed; replaced with durable Redis/BullMQ strategy.**
- [ ] **DOWN and RECOVERED transitions processed immediately (transactional); routine UP results may batch/aggregate (≤60s window).**
- [ ] **Monitoring jobs are idempotent, support retries/backoff, and use distributed locks to prevent duplicate execution.**
- [ ] **Redis failure must never corrupt Postgres data; Postgres failure must produce retryable jobs, never silently lost results.**
- [ ] **Theme infrastructure (light/dark) built early; full visual redesign only in the final phase — no giant UI rewrite during backend migration.**
- [ ] **No Prisma "for compatibility" after Drizzle migration — full cutover and removal.**

Derived scope (audit §24 order — the chosen sequence):

- [x] Design addenda phase: amend the audit/incorporate all 8 review addenda (§8) — schema (`next_check_at`, `write_guards`, `outbox`, partial unique index on ongoing incidents, ID-generation), scheduler spec (J-1 claims), check job spec (J-3/J-4/S-1), writer specs (J-2/D-1/D-5), resilience spec (J-5/R-1), auth spec (A-1/A-2/A-3), connection budget (D-8), deploy runbook (P-1) — flipping the review verdict to READY before implementation — **done (Phase 01)**
- [ ] Phase 0 foundations: pnpm migration, typecheck gate (`ignoreBuildErrors` off), Vitest + Playwright scaffolding, characterization tests for cron/batcher/API contracts, repo hygiene (remove ngrok binary/log, `.env.example`)
- [ ] Theme infrastructure early (`next-themes`, light palette tokens, toggle; no visual redesign)
- [ ] Redis introduction (ioredis, Redis-backed rate limiting + cache; AOF + `noeviction` documented)
- [ ] Drizzle adoption: baseline from **live DDL** (not schema.prisma), versioned drizzle-kit migrations replacing `db push --accept-data-loss`, empty-diff CI gate, rehearsed against local prod snapshot
- [ ] BullMQ + dedicated worker process (PM2 app #2): scheduler with claim-based due-selection, per-monitor locks, idempotency keys, retries/backoff, two-tier persistence, circuit breaker, outbox-based alerting; delete `instrumentation.ts` cron + `CRON_MODE` after overlap-window verification
- [ ] Thin API routes: manual check → enqueue + poll, Redis rate limits (incl. per-user enqueue limiter), security fixes (S-2 webhook secret, S-3 admin gating, S-4 no stack traces/secrets-in-query, R19/S-1 SSRF validation)
- [ ] Multi-provider transactional email abstraction (`lib/email`, env-selected provider, queue offload, typed retryable-vs-permanent errors)
- [ ] Better Auth cutover: bcrypt hash/verify config + canary login before flip, adapter bound to existing `users` table, cookieCache sessions, admin plugin (roles), OAuth account reshaping, announced forced re-login, NextAuth deps deleted
- [ ] Prisma removal: all remaining read paths ported; `prisma/`, generated client, deps deleted
- [ ] Redux state pruning: dead `auth` slice + token mirror + `js-cookie` removed; Redux kept for genuine UI/domain state only
- [ ] Vercel AI SDK integration — flagged off by default (`AI_ENABLED=false`), strictly outside the monitoring critical path (incident summarization, monitor-setup assistant)
- [ ] Final visual redesign: shadcn expansion, dialog/icon consolidation, light palette refinement, motion polish — on top of stable tokens and stable APIs

### Out of Scope

- Advanced monitor types (keyword, TCP, SSL checks — `UPGRADE_PLAN.md`/`ADVANCED_MONITORING_PLAN.md`) — frozen per audit M12; Drizzle schema reserves columns only
- Incident email notifications (alert emails) — Telegram-only alerting this milestone (UPGRADE_PLAN phase 7)
- Windowed uptime display (24h/7d/30d) — Q-1 default: lifetime counters now; windowed lands with the final UI phase
- N-consecutive-failure DOWN threshold — Q-2 default: keep 1-strike DOWN for behavior compatibility; `consecutive_failures` column reserved for later
- Managed Redis hosting — Q-3 default: self-host on the VPS with AOF + external heartbeat
- New user-facing product features of any kind — this is modernization only
- Multi-instance/horizontal scale-out beyond what the worker architecture safely permits by construction (scale-out *path* preserved, not exercised)

## Context

- **Live production system** with real users, real monitors, and Telegram alerts wired — migration risk is operational, not theoretical.
- **Deployment:** GitHub Actions → SCP → VPS (`/var/www/uptime-tracker`), PM2 app `uptime-tracker`, port 3007. Postgres is Neon (low connection limits — see D-8 budget). Becomes two PM2 apps (web + worker) with a revised pipeline (P-1 ordering: migrate → restart worker → restart web → smoke-check).
- **No tests, no migration history today:** production schema was built with `prisma db push --accept-data-loss`; live DDL may drift from `schema.prisma` (M-3/D-1) — baseline must come from `pg_dump --schema-only`.
- **Rehearsal strategy:** local docker-compose Postgres/Redis in dev + CI; restore an anonymized `pg_dump` of production locally to dry-run the Drizzle baseline, auth cutover, and data-diff verification before touching production (D-9). Full `pg_dump` backup immediately before each production cutover (D-10).
- **Migration discipline:** expand/contract — additive-only migrations during each verification window; no drops/renames until the following release (M-2). Old cron and new worker overlap briefly before deletion (M3); both paths idempotent.
- **Known current-state defects the migration fixes** (audit §5 B1–B6, §9 R1–R22): batch-loss data loss, state regression, lost counter updates, no locks/idempotency, alerts-before-persistence, SSRF surface, unauthenticated Telegram webhook, feedback exposure, no admin roles.
- **Frontend state:** Redux `auth` slice is dead code (nothing populates it); NextAuth `useSession` is the real client auth source; RTK Query has zero endpoints. Theme is permanently dark (`:root` and `.dark` byte-identical; `.dark` hardcoded).

## Constraints

- **Tech stack (target):** Next.js 16.3 App Router · Drizzle ORM · Better Auth · PostgreSQL (unchanged, source of truth) · Redis + BullMQ · dedicated Node worker process · Redux Toolkit + Redux Persist (pruned) · Tailwind v4, shadcn/ui, Hugeicons, Sonner, Radix UI, Framer Motion · Vercel AI SDK (off critical path) · multi-provider email abstraction · pnpm
- **Hard constraints:** the eight binding requirements listed under Active above (audit rules 1–20 traceable in audit Appendix B)
- **Review gate:** all §9 checklist items resolved in design before implementation (verdict READY) — ✅ satisfied 2026-09-09 (Phase 01); post-ratification design debt (CR-01 `uptime_percent` writer, CR-02 §4a/M4 overlap contradiction) is registered in `01-VERIFICATION.md` with a hard consumption point at Phase 4/5 planning
- **Behavior compatibility:** monitoring semantics preserved through cutover — 1-strike DOWN, lifetime uptime math, Telegram alert content, public API shapes
- **Deployment:** single VPS, two PM2 apps, forward-only additive-first migrations, health gates (`readyz`) before a release counts as good
- **Forced re-login at auth cutover:** accepted consequence (M2/D6), announced (Q-4)
- **Manual check UX:** becomes enqueue + optimistic read + poll, per-user rate limited (Q-5)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Follow audit §24 migration order (worker core move before Better Auth) | Reviewed dependency-engineered sequence; highest-risk core move lands with foundations in place | — Pending |
| Dedicated design-amendment phase before any implementation | Review verdict is NOT READY; §8 addenda cheap on paper, expensive in production | ✓ Done (Phase 01 — verdict READY 2026-09-09) |
| Full phase 0 incl. characterization tests | Review §7.9: "the single most valuable safety investment" — pins current behavior before rewrite | — Pending |
| All 5 product defaults accepted (Q-1 lifetime uptime, Q-2 1-strike DOWN, Q-3 self-host Redis, Q-4 announced re-login, Q-5 enqueue+poll) | Behavior compatibility + lowest operational change during migration | — Pending |
| v1 spans the full sequence through AI SDK and visual redesign | One coherent arc; AI flagged-off makes it safe to include | — Pending |
| Telegram-only alerting in v1 | Preserve current behavior; email alert channel is UPGRADE_PLAN phase 7 | — Pending |
| Local rehearsal with anonymized prod snapshot (no staging infra) | D-9 dry-run requirement met without new infrastructure spend | — Pending |
| Keep `monitors.id` as integer serial; keep table/column names | Public status-page URLs and ping/incident FKs depend on them (audit §11.1, M-5) | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-09 after Phase 01 completion (design gate READY; implementation phases 2–8 next)*
