# Phase 6: Thin API Routes & Email Abstraction - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-20
**Phase:** 6-Thin API Routes & Email Abstraction
**Areas discussed:** Check-now UX & poll contract, Email queue mechanics, Autonomous retention (WR-03), Boundary security scope, Cron deletion & pin fate, Enqueue admission edges, Redis-down on register, Rehearsal & evidence, Error-response shapes, Create-validation breadth, Email-lane observability

---

## Check-now UX & poll contract

### What does the client poll to detect completion?

| Option | Description | Selected |
|--------|-------------|----------|
| Poll monitor data (Recommended) | Reuse the monitor read the dashboard already uses; completion = lastChecked advances past enqueue timestamp; zero new endpoints; web never couples to BullMQ job state | ✓ |
| Job-status endpoint | New endpoint exposing BullMQ job state to the client | |
| You decide | Researcher/planner choose | |

**User's choice:** Poll monitor data
**Notes:** Manual checks persist synchronously (DAT-01 Tier 1), so completion is seconds — the poll contract never needs the ≤60s Tier-2 window.

### Polling cadence and give-up timeout?

| Option | Description | Selected |
|--------|-------------|----------|
| 2s / 30s (Recommended) | Manual lane is priority 1; checks carry 10s timeout, steady-state ~2-12s | ✓ |
| 3s / 60s | Longer budget for degraded states | |
| You decide | | |

**User's choice:** 2s / 30s

### What does the user see while queued/running?

| Option | Description | Selected |
|--------|-------------|----------|
| Row state + toast (Recommended) | Button disables with spinner/"Checking…"; toast confirms fresh result (UP/DOWN + response time) | ✓ |
| Toast only | No row-level state | |
| You decide | | |

**User's choice:** Row state + toast

### What happens when the 30s budget runs out?

| Option | Description | Selected |
|--------|-------------|----------|
| Quiet handoff (Recommended) | Info toast; polling stops; existing periodic refresh surfaces the result; never error, never auto re-enqueue | ✓ |
| Timeout error | Error toast on timeout | |
| You decide | | |

**User's choice:** Quiet handoff

### What does the 202 return?

| Option | Description | Selected |
|--------|-------------|----------|
| jobId + queuedAt (Recommended) | Poll doesn't need it; jobId = support/log correlation (check-manual:{id}:{epoch}) | ✓ |
| Message only | Minimal body | |
| You decide | | |

**User's choice:** jobId + queuedAt

### 429 response shape (new user-visible behavior — route is unlimited today)?

| Option | Description | Selected |
|--------|-------------|----------|
| 429 + Retry-After (Recommended) | Header with seconds to window reset + friendly toast | ✓ |
| Plain 429, current shape | Match generic limiter responses | |
| You decide | | |

**User's choice:** 429 + Retry-After

---

## Email queue mechanics

### Where does the template render?

| Option | Description | Selected |
|--------|-------------|----------|
| Render at enqueue (Recommended) | Route renders final {to, subject, html}; worker transports bytes; Phase 7 hooks reuse queue unchanged | ✓ |
| Render in worker | Payload carries template inputs | |
| You decide | | |

**User's choice:** Render at enqueue
**Notes:** EML-05 relocation = template moves into the lib/email home byte-verbatim.

### Which send sites move onto the queue?

| Option | Description | Selected |
|--------|-------------|----------|
| Both sites (Recommended) | Register verification + forgot-password reset | ✓ |
| Register only | EML-02's criterion names registration only | |
| You decide | | |

**User's choice:** Both sites
**Notes:** Leaving forgot-password in-request keeps a path where SMTP-down 500s a route.

### Retry budget?

| Option | Description | Selected |
|--------|-------------|----------|
| 5 tries, ~3h reach (Recommended) | Exponential from 30s: ~30s/2m/8m/30m/2h (≈2.7h) | ✓ |
| 5 tries, ~10h reach | Longer final backoff | |
| You decide | | |

**User's choice:** 5 tries, ~3h reach

### Permanent failure visibility?

| Option | Description | Selected |
|--------|-------------|----------|
| Log + metric only (Recommended) | Typed unrecoverable failure logs + queue counter; no user-facing surface | ✓ |
| Surface at login | Banner/nag for unverified senders | |
| You decide | | |

**User's choice:** Log + metric only
**Notes:** Strictly better than today — SMTP failure currently 500s the register request.

### EMAIL_PROVIDER defaulting?

| Option | Description | Selected |
|--------|-------------|----------|
| Default smtp (Recommended) | Unset/empty → SMTP; console = explicit dev opt-in; unknown fails loud at boot | ✓ |
| Required, fail-loud | Missing var breaks boot | |
| You decide | | |

**User's choice:** Default smtp

### Console provider output?

| Option | Description | Selected |
|--------|-------------|----------|
| Full dump (Recommended) | to + subject + rendered HTML on one structured stdout line | ✓ |
| Metadata only | Recipient + subject | |

**User's choice:** Full dump

### Where does the interface/template live?

| Option | Description | Selected |
|--------|-------------|----------|
| src/lib/email/ (Recommended) | New module: provider interface, selection, render functions, enqueue helper; mail.ts deleted | ✓ |
| Wrap mail.ts | Keep module, swap internals | |
| You decide | | |

**User's choice:** src/lib/email/

---

## Autonomous retention (WR-03)

### Flip the daily scheduler to real deletes?

| Option | Description | Selected |
|--------|-------------|----------|
| Flip to real deletes (Recommended) | scheduler.ts dryRun:false; daily 03:15 UTC real batched deletes | ✓ |
| Keep manual + runbook | Operator-driven retention | |
| You decide | | |

**User's choice:** Flip to real deletes

### Absorb WR-01/WR-02?

| Option | Description | Selected |
|--------|-------------|----------|
| Fix both in Phase 6 (Recommended) | WR-01 enqueue deadline (fail-loud); WR-02 disposeRelayRedis in drainAndTeardown | ✓ |
| Defer both | | |
| WR-02 only | | |

**User's choice:** Fix both in Phase 6

### IN-04 HTML-escape alert interpolation?

| Option | Description | Selected |
|--------|-------------|----------|
| Escape now (Recommended) | Escape & < > in worker alert rendering; D-48 pins updated same change | ✓ |
| Strict parity, defer | Keep byte-parity, defer escaping | |
| Escape + audit pins | Also audit all interpolation sites | |

**User's choice:** Escape now

### Fix the three pinned route defects?

| Option | Description | Selected |
|--------|-------------|----------|
| Fix + flip pins (Recommended) | findUnique→findFirst; bare-return→400; typo fix with client string-match sweep | ✓ |
| Leave pinned | Keep as documented defects | |
| Only touched files | Fix only where Phase 6 touches anyway | |

**User's choice:** Fix + flip pins
**Notes:** 02-05 pinned these as deliberate Phase-6 red/green markers.

### Retention observability?

| Option | Description | Selected |
|--------|-------------|----------|
| Log + metric (Recommended) | Deleted-row counts logged + existing metrics; no new dead-man | ✓ |
| Add dead-man check | Fourth healthchecks.io check | |
| Log now, defer dead-man | | |

**User's choice:** Log + metric

### Absorb 05-REVIEW Info findings?

| Option | Description | Selected |
|--------|-------------|----------|
| IN-01 + IN-06 (Recommended) | WORKER_HEALTH_PORT empty-string guard + cron-remnant gate comment counting | ✓ |
| All nine | | |
| None | | |

**User's choice:** IN-01 + IN-06 only

### How does the dryRun flip ship?

| Option | Description | Selected |
|--------|-------------|----------|
| Hardcoded (Recommended) | scheduler.ts template dryRun:false; manual script keeps flags | ✓ |
| Env-gated, default real | | |

**User's choice:** Hardcoded

---

## Boundary security scope

### SEC-03 webhook authentication?

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated env + 401 (Recommended) | TELEGRAM_WEBHOOK_SECRET + one-time setWebhook runbook step + constant-time 401; rotation = re-run setWebhook | ✓ |
| Shared secret reuse | Reuse an existing secret | |
| You decide | | |

**User's choice:** Dedicated env + 401

### Limiter coverage extension?

| Option | Description | Selected |
|--------|-------------|----------|
| Forgot-password + webhook (Recommended) | ~5/h per IP (register parity) + webhook per-IP via Redis Lua limiter | ✓ |
| Webhook only | | |
| You decide | | |

**User's choice:** Forgot-password + webhook

### Harden getIP (WR-06)?

| Option | Description | Selected |
|--------|-------------|----------|
| Harden now (Recommended) | Trust only Next-stamped headers; researcher verifies rightmost-entry vs Next 16 + spoof test | ✓ |
| Defer | | |
| You decide | | |

**User's choice:** Harden now

### SSRF validation at create — how much?

| Option | Description | Selected |
|--------|-------------|----------|
| Full pipeline at create (Recommended) | Full src/lib/ssrf.ts (scheme allowlist + resolve-then-denylist, DNS-only, clear 400); engine per-hop stays defense-in-depth | ✓ |
| Scheme-check only | Cheap check at create | |
| You decide | | |

**User's choice:** Full pipeline at create

### Unescaped user.name in webhook confirmation?

| Option | Description | Selected |
|--------|-------------|----------|
| Escape in this phase (Recommended) | Rides the webhook-secret change on that route | ✓ |
| Defer | | |

**User's choice:** Escape in this phase

### Legacy private-URL rows on PATCH?

| Option | Description | Selected |
|--------|-------------|----------|
| Re-validate on change only (Recommended) | PATCH validates URL only when the request changes it | ✓ |
| Validate every PATCH | Would brick legacy rows | |
| You decide | | |

**User's choice:** Re-validate on change only

### Release structure?

| Option | Description | Selected |
|--------|-------------|----------|
| Feature → soak → delete (Recommended) | Deletion release removes cron routes/cron-logic/db-batcher/cleanup-logic/CRON_SECRET/playwright writer; D-41 gate extension | ✓ |
| Single release | Everything at once | |

**User's choice:** Feature → soak → delete

---

## Cron deletion & pin fate

### What happens to the Phase-2 characterization pins?

| Option | Description | Selected |
|--------|-------------|----------|
| Delete + inventory map (Recommended) | Delete 02-03/02-05 cron pins with a written map to where each guarantee now lives (worker suites, D-48 pins, D-41 gate) | ✓ |
| Port equivalents first | Re-pin onto worker/email paths before deleting | |
| You decide | | |

**User's choice:** Delete + inventory map

---

## Enqueue admission edges

### Manual check on paused/inactive monitor?

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve today (Recommended) | New route mirrors old force-path admission byte-for-byte; researcher pins current isActive semantics first | ✓ |
| Reject 409 | Cleaner semantics but new policy | |
| You decide | | |

**User's choice:** Preserve today

---

## Redis-down on register

### Register can't enqueue verification email when Redis is down?

| Option | Description | Selected |
|--------|-------------|----------|
| 503 refuse (Recommended) | Loud degradation; outage already pages via dead-men; login keeps working | ✓ |
| Complete, log loss | Registration succeeds, email silently lost (no outbox) | |
| You decide | Weigh write-through outbox vs 503 | |

**User's choice:** 503 refuse
**Notes:** Same policy applies to forgot-password.

---

## Rehearsal & evidence

### Pre-production proof shape?

| Option | Description | Selected |
|--------|-------------|----------|
| Stand-in live smoke (Recommended) | No snapshot restore (zero migrations); built artifact on localhost stand-in; live-smoke check-now, email round-trip + SMTP-fail-recover, webhook refusal, retention pass | ✓ |
| Full snapshot rehearsal | D-30-style anonymized restore + all legs | |
| Suites only | pnpm verify + test:resilience | |

**User's choice:** Stand-in live smoke

### Soak before deletion release?

| Option | Description | Selected |
|--------|-------------|----------|
| ~24h soak (Recommended) | Real users, ≥1 real registration, 03:15 UTC retention observed, dead-men quiet | ✓ |
| Same-day pair | Faster but unobserved retention pass | |
| You decide | Planner sets from wave structure | |

**User's choice:** ~24h soak

---

## Error-response shapes

| Option | Description | Selected |
|--------|-------------|----------|
| Helper in touched routes (Recommended) | apiError(status, message); wire shape byte-identical; leak-proof by construction | ✓ |
| Ad-hoc, no helper | Manual leak pass per route | |
| Full sweep all routes | ~20 routes converted | |

**User's choice:** Helper in touched routes

---

## Create-validation breadth

| Option | Description | Selected |
|--------|-------------|----------|
| URL-only (Recommended) | SSRF URL check is the only new validation; gaps documented as deferred ideas | ✓ |
| URL + obvious gaps | Name length, interval bounds tightened too | |

**User's choice:** URL-only

---

## Email-lane observability

| Option | Description | Selected |
|--------|-------------|----------|
| Gauges + counter, no dead-man (Recommended) | Join existing per-queue depth/age gauges + failed-attempts counter; dead worker already pages | ✓ |
| Add email dead-man | Fourth healthchecks.io check | |

**User's choice:** Gauges + counter, no dead-man

---

## Claude's Discretion

None — every question received an explicit user choice (all recommended options selected). Only verification tasks are delegated to the researcher (force-path semantics pin, XFF logic vs Next 16, typo string-match sweep, metrics enumeration, spoof test).

## Deferred Ideas

- Monitor create/update non-URL validation tightening (name length cap, interval bounds) — deferred hardening pass
- Email-lane dead-man check (fourth healthchecks.io check) — declined for Phase 6; revisit if email lanes grow
- EML-04 (Better Auth hooks on the email queue) — Phase 7 by ROADMAP
- Remaining seven 05-REVIEW Info findings — stay with their owning changes
