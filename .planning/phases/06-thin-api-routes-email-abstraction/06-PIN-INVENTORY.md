# 06-PIN-INVENTORY — deleted characterization pins and their successor guarantees (D-27)

**Plan:** 06-05 Task 2 (deletion release) · **Date:** 2026-09-21 (UTC stamps in rows)
**Authority:** 06-CONTEXT D-26/D-27 · **Gate:** `scripts/check-cron-remnants.mjs` extended per D-41/D-27

The 02-03/02-05 characterization pins existed to hold behavior **pin-until-replaced**
until the worker owned the monitoring engine. Phase 4/5 built the replacements and
the 06-04 soak gate proved them under real traffic; **the pins' job is therefore
COMPLETE** — this inventory is the record that nothing was silently dropped. Every
deleted suite, describe-block, and individual pin is mapped below to where its
guarantee lives now.

## Deletion totals

| Deleted artifact | Pins removed |
| --- | --- |
| `tests/integration/cron-logic.test.ts` (suite: "runCronChecks — core transition characterization, audit §23.1 / FND-05") | 19 `it()` cases |
| `tests/integration/db-batcher.test.ts` (suite: "db-batcher — enqueue/flush math + failure-swallow, audit §23.2 / FND-06") | 7 `it()` cases |
| `tests/api/cron-and-webhook.handler.test.ts` — describe "GET /api/cron/check" | 6 `it()` cases |
| `tests/api/cron-and-webhook.handler.test.ts` — describe "GET /api/cron/cleanup" | 4 `it()` cases |
| `tests/api/auth-shallow.handler.test.ts` — the 06-02 `@/lib/mail` must-NOT-fire tripwire (`vi.mock` + 4 references) | 1 tripwire (register + forgot assertions) |
| `src/app/api/cron/check/route.ts`, `src/app/api/cron/cleanup/route.ts` | the pinned surface itself |
| `src/lib/cron-logic.ts`, `src/lib/db-batcher.ts`, `src/lib/cleanup-logic.ts`, `src/lib/mail.ts` | the pinned modules themselves |
| `playwright.config.ts` — the stale `CRON_MODE=vercel` writer + comment (Pitfall 9 / 05-REVIEW deferred item) | 1 writer |
| `.env.example` — `CRON_SECRET` entry + section (S-4 doc marker) | 1 env entry |

Kept intact: the `POST /api/telegram/webhook` describe block (10 `it()` cases, the
06-03 SEC-03/D-20/D-21/D-24 suite) in `cron-and-webhook.handler.test.ts`, and the
register/forgot queue-payload pins in `auth-shallow.handler.test.ts`.

## Inventory map — every deleted pin → successor guarantee

| # | Deleted pin (file · describe · pinned behavior) | Successor guarantee |
| --- | --- | --- |
| 1 | `cron-logic.test.ts` · due-time filtering (`findMany` due select; paused/inactive exclusion; interval arithmetic) | `tests/worker/engine-check.test.ts` — the worker claim/due contract (SQL `next_check_at` claim, 04-01/05 forms); due-time semantics are enforced at claim time, not select time |
| 2 | `cron-logic.test.ts` · transition semantics (UP↔DOWN, 1-strike DOWN, UP→UP no-op) | `tests/worker/persist-tier1.test.ts` (transition persistence, first-check-down is NOT `first_check`, DAT-04 dedup) + `tests/worker/engine-check.test.ts` (outcome classification → transition intent) |
| 3 | `cron-logic.test.ts` · lifetime uptime/counter math (toFixed(2) legacy form, `cron-logic.ts` lines 149–154) | `tests/worker/uptime-parity.test.ts` — CHARACTER-COMPARED against the transcribed legacy expression (04-04 D-36 exact binary extraction), 73,210-ratio sweep byte-identical |
| 4 | `cron-logic.test.ts` · alert enqueue on transitions (incident create/resolve → alert payload) | `tests/worker/persist-tier1.test.ts` (incident lifecycle rows) + `tests/worker/outbox-relay.test.ts` (D-48 byte-parity: the three alert templates transcribed character-for-character from `cron-logic.ts` lines 104–133) |
| 5 | `cron-logic.test.ts` · failure-swallow fast path (zero-synchronous-footprint checks) | `tests/worker/engine-check.test.ts` (04-08: breaker classification, crash-only-on-injection posture) + `tests/resilience/*` (what breakage the engine survives) |
| 6 | `cron-logic.test.ts` · the `runCleanup` side-effect drain pinned as a second engine behavior | `tests/worker/maintenance.test.ts` — retention is the worker's own scheduled job (D-14): 30/90-day `cleanup-logic` parity constants, real-delete counts, 5000-row batches |
| 7 | `db-batcher.test.ts` · enqueue/flush math (routine-ping aggregation, delta accounting, idempotent second flush) | `tests/worker/persist-tier2.test.ts` — "staging math: three staged UP results aggregate exactly as db-batcher's flush math consumes them" (row-derived deltas, `stage:{monitorId}` hash, RENAMENX semantics, guarded flush) |
| 8 | `db-batcher.test.ts` · failure-swallow (`flushBatches` never throws) | Superseded deliberately: the Tier-2 flush FAILS LOUD through the breaker (`tests/worker/breaker.test.ts`, 04-08 injection-proved) — silent swallow was the legacy defect class the worker removed (tier2.ts header) |
| 9 | `cron-and-webhook.handler.test.ts` · "GET /api/cron/check" — 500 unset-secret message, 401 wrong secret (query + Bearer header), S-4 query-string acceptance PIN, Bearer form + in-request `flushBatches`, `force` forwarding, S-4 stack-echo 500 PIN | The deleted surface IS the guarantee: the route 404s in production (Task 3 deploy smoke), its absence is gate-enforced (gate check 5: any file recreating `app/api/cron/*` fails; check 6: the retired `CRON_SECRET` token fails), and checking is worker-owned (`tests/worker/engine-check.test.ts` + scheduler suites). SEC-06 closure = deleted surface + extended gate + production 404s |
| 10 | `cron-and-webhook.handler.test.ts` · "GET /api/cron/cleanup" — unset-secret 500, 401 wrong secret, S-4 query acceptance PIN, "runCleanup FAILURE still yields 200" | Same absence guarantee as #9 for the HTTP surface; the retention behavior itself lives on worker-side in `tests/worker/maintenance.test.ts` (row 6) |
| 11 | S-4 marker — the query-string secret contract (`.env.example` `CRON_SECRET` entry + `?secret=` doc line; `monitors.core.spec.ts` scope notes) | Extended gate check 6 (`CRON_SECRET` token, comments-inclusive per the IN-06/D-19 asymmetry) across src, build artifacts, and repo-root config files; `.env.example` cleaned in the same change |
| 12 | `auth-shallow.handler.test.ts` · the 06-02 `@/lib/mail` must-NOT-fire tripwire (auth routes make ZERO direct transport calls) | Structural + gate-enforced: `src/lib/mail.ts` is deleted, so any direct transport import fails `pnpm typecheck`; the extended gate (check 7) fails on any `mail` module import. The queue-payload pins (`email` lane `add()` with `{to, subject, html}`) remain in the suite, unchanged |
| 13 | `playwright.config.ts` · the stale `CRON_MODE=vercel` writer (Pitfall 9; instrumentation.ts was deleted at 05-09, the env did nothing) | The writer is deleted; `playwright.config.ts` now rides the gate's default scan (D-27 "src or config"), so a reintroduced `CRON_MODE` token fails `pnpm cron:remnants` before e2e boots |
| 14 | The deleted modules themselves (`cron-logic.ts`, `db-batcher.ts`, `cleanup-logic.ts`, `mail.ts`) as import targets | `pnpm typecheck` (dangling imports fail the verify chain) + gate check 7 (specifier-basename match: `@/lib/cron-logic`, `../lib/db-batcher`, `./cleanup-logic`, `./mail` — any depth, any import form incl. `require()`/dynamic `import()`) |
| 15 | The cron route PATHS as URL surface (`/api/cron/check`, `/api/cron/cleanup`) | Gate check 5 — any walked file (source OR build artifact) under `…/app/api/cron/…` fails the chain; production 404 confirmation is Task 3's deploy smoke leg |

## Post-deletion sweep results (this change)

- Repo-wide search for imports of `cron-logic`, `db-batcher`, `cleanup-logic`, `mail`
  in `src/` or `tests/`: **zero** (typecheck enforces it going forward).
- `tests/e2e/`: no references to the deleted routes/modules (verified clean, nothing
  to remove).
- Comment-only provenance prose (e.g. `src/worker/persist/*` "cron-logic parity"
  notes, `src/lib/email/*` "relocated from src/lib/mail.ts") is retained
  deliberately: the gate's import checks skip comment lines, and the transcribed
  lines are the D-48/parity evidence trail (rows 3–4).
- Out of scope by plan (retained, not pinned): `scripts/rehearse-cutover.mjs`
  (historical Phase-5 rehearsal choreography, not gate-scanned), root docs
  (`README.md`, `UPGRADE_PLAN.md`, `ADVANCED_MONITORING_PLAN.md` — legacy prose),
  `tests/worker/health-metrics.test.ts:255` (a defensive "secret never leaks into
  metrics" pin that reads, never writes, the env name in a test-only context).
