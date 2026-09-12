---
phase: 03-redis-drizzle-schema-ownership
plan: 02
subsystem: database
tags: [postgres, pg, connection-pool, prisma, drizzle, dat-09]

# Dependency graph
requires:
  - phase: 02-foundations
    provides: Vitest integration discipline + docker test Postgres (:5453) wired via vitest.config.ts; characterization suites that pin Prisma behavior
provides:
  - Neutral per-process pg.Pool at src/lib/db-pool.ts exporting pgPool with the audit §25.2 pinned options — the ONE pool Prisma rides today and the 03-04 Drizzle client attaches to via drizzle({ client: pgPool })
  - Integration proof (tests/integration/db-pool.test.ts) that the pinned options are live, the globalThis cache makes the module HMR-safe, and prisma.$queryRaw resolves through the shared instance
affects: [03-04-drizzle-client, 03-03-migration-runner, phase-04-worker-pool]

# Tech tracking
tech-stack:
  added: []  # pg 8.22.0 already present; no new dependencies
  patterns:
  - "Neutral pool module: one pg.Pool per process owned by a module neither ORM owns (D-06); globalThis-cached off-production for HMR survival"
  - "§25.2 pinned options transcribed in code and asserted by tests — connection budget is enforceable, not documented-only (DAT-09)"

key-files:
  created:
  - src/lib/db-pool.ts
  - tests/integration/db-pool.test.ts
  modified:
  - src/lib/prisma.ts

key-decisions:
  - "The §25.2 pins are NEW pool semantics, not a no-op move: the old inline Pool ran bare defaults (connectionTimeoutMillis 0 = wait forever, no statement/idle-in-transaction caps); the extraction pins them — behavior-neutral at the ORM layer, proven by 111/111 characterization green"
  - "DAT-09 deliberately NOT marked complete in REQUIREMENTS.md — this plan lands the code half (web pool max 10) only; the migration runner (03-03, direct one-shot, statement_timeout UNSET) and the worker pool max 20 (Phase 4) are still pending (02-03 false-signal precedent)"
  - "prisma.ts's globalForPrisma cache drops its pool key — db-pool.ts owns pool identity now; the prisma client cache itself is kept verbatim"

patterns-established:
  - "Pattern: single new Pool( site in src/lib lives in db-pool.ts only (T-03-04 grep-level guard); a worker-pool factory (max 20) may be ADDED there in Phase 4 — deliberately not built now"

requirements-completed: []  # DAT-09 intentionally NOT listed — only the web-pool code half shipped; runner (03-03) + worker pool (Phase 4) pending

coverage:
  - id: D1
    description: "Neutral pg.Pool module (src/lib/db-pool.ts) exporting pgPool with the five audit §25.2 pinned options, globalThis-cached off-production"
    requirement: DAT-09
    verification:
      - kind: integration
        ref: "tests/integration/db-pool.test.ts#1. exposes the five audit §25.2 pinned options on pgPool.options (web budget)"
        status: pass
      - kind: integration
        ref: "tests/integration/db-pool.test.ts#2. yields the SAME pool instance across module re-imports via the globalThis cache"
        status: pass
      - kind: integration
        ref: "tests/integration/db-pool.test.ts#3. connects to the docker test Postgres: a trivial query resolves through the pool"
        status: pass
    human_judgment: false
  - id: D2
    description: "Prisma re-wraps the neutral pool (PrismaPg(pgPool), no Pool ownership) with zero behavior change — full Phase 2 characterization suite green through the extracted pool"
    requirement: DAT-09
    verification:
      - kind: integration
        ref: "tests/integration/db-pool.test.ts#4. Prisma still queries through the shared pool (prisma.$queryRaw select 1, no own Pool)"
        status: pass
      - kind: command
        ref: "pnpm test (full suite) — 11 files, 111/111 tests, exit 0, two consecutive clean runs"
        status: pass
      - kind: command
        ref: "grep -rn 'new Pool(' src/lib → exactly one hit, src/lib/db-pool.ts:31; prisma.ts has zero"
        status: pass
    human_judgment: false

# Metrics
duration: ~7min (352s)
completed: 2026-09-12
status: complete
---

# Phase 3 Plan 2: Neutral pg Pool Module Summary

**One budgeted pg.Pool (max 10, §25.2 timeouts pinned) extracted to a neutral module both ORMs share — Prisma re-wraps it with zero behavior change (111/111 characterization green)**

## Performance

- **Duration:** ~7 min (352 s) — start 2026-09-12T09:54:30Z, close ~10:01Z
- **Tasks:** 2 (Task 1 TDD: RED → GREEN; Task 2: refactor + full-suite proof)
- **Files modified:** 3 (2 created, 1 amended)

## Accomplishments

- `src/lib/db-pool.ts` created: exports `pgPool` (named const) carrying the audit §25.2 pinned options — `max: 10` (web §25.1 budget), `connectionTimeoutMillis: 10000` (default 0 = wait forever — pinned nonzero), `idleTimeoutMillis: 10000`, `statement_timeout: 30000`, `idle_in_transaction_session_timeout: 30000` — globalThis-cached off-production for HMR survival, per the verified RESEARCH Pattern 5 template verbatim
- `src/lib/prisma.ts` amended minimally: imports `pgPool` from `./db-pool`, constructs `PrismaPg(pgPool)`; the `pool` key left prisma's globalThis cache; PrismaClient instantiation, log config, and the prisma HMR cache kept verbatim; the legacy Bangla pool comment died with the extraction (English replacement)
- `tests/integration/db-pool.test.ts` (4 cases, real docker Postgres): pins all five option values on `pgPool.options`, proves singleton identity across `vi.resetModules()` + dynamic re-import via the globalThis cache, a trivial select-1 through the pool, and `prisma.$queryRaw` select-1 resolving through the shared instance
- Full `pnpm test`: 11 files, 111/111 tests green through the extracted pool — the Phase 2 characterization net (cron-logic, db-batcher, all handler suites, contracts) confirms the extraction is behavior-neutral

## Task Commits

1. **Task 1 RED:** failing db-pool suite (module does not exist) - `dca3ac9` (test)
2. **Task 1 GREEN:** neutral pool module with §25.2 pinned options - `75b6bc8` (feat)
3. **Task 2:** prisma re-wraps the neutral pg pool (no Pool ownership) + case 4 shared-pool proof - `85bfa5f` (refactor)

**Plan metadata:** (this commit) (docs: complete plan)

## TDD Gate Compliance

Task 1 was `tdd="true"`: RED (`dca3ac9`) → GREEN (`75b6bc8`) sequence present in git log; RED failed for the right reason (`Cannot find package '@/lib/db-pool'` — all 3 cases); GREEN passed 3/3. No refactor needed — the module is the verified minimal template. Plan frontmatter `type: execute`, so per-task TDD applied (not plan-level gating).

## Files Created/Modified

- `src/lib/db-pool.ts` - the ONE pg.Pool this web process owns; §25.2 options; English comments pin the per-process rule (Phase 4 worker gets its OWN max-20 pool, factory deliberately deferred) and the migration-runner carve-out (statement_timeout UNSET on the runner)
- `src/lib/prisma.ts` - PrismaPg(pgPool) wrapper; no Pool ownership; everything else verbatim
- `tests/integration/db-pool.test.ts` - integration suite described above

## Decisions Made

- **The §25.2 pins are new pool semantics** — the old inline Pool ran bare defaults (connect timeout 0, no statement caps); pinning them is the point of DAT-09, and the characterization suite proves no observable ORM-layer change. Recorded in STATE.md.
- **DAT-09 not marked complete** — only the web-pool code half exists; 03-03's runner (direct one-shot, statement_timeout deliberately UNSET) and Phase 4's worker pool (max 20) remain. Mirrors the 02-03 decision (FND-06) about not falsely signalling done. `requirements-completed` is therefore empty.
- **prisma.ts cache shape** — dropped only the `pool` key from `globalForPrisma`; pool identity moved to db-pool's own `pgPool` globalThis key.

## Deviations from Plan

None - plan executed exactly as written.

*(Scope notes, not deviations: `pnpm typecheck` and `pnpm lint` were run in addition to the plan's verify commands — both clean for the new/modified files; the 37 pre-existing lint warnings elsewhere are out of scope. `requirements.mark-complete` was intentionally not invoked, per the DAT-09 decision above.)*

## Issues Encountered

- First full-suite run reported `10 passed (11)` files / `106 passed (111)` tests with 1 worker-process error (`Process.ChildProcess._handle.onexit` — a vitest child crash, zero assertion failures). Two consecutive re-runs with identical source: 11 files / 111/111, exit 0 both times. Transient Windows child-process flake, not related to the pool change (even the errored run had no failing test). Recorded here for the verify-budget picture.

## Plan-Output Records (asked for by the plan's `<output>`)

- **Final db-pool.ts export shape (03-04 consumes this):** `export const pgPool: Pool` — named const from `pg`, constructed with `{ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, statement_timeout: 30000, idle_in_transaction_session_timeout: 30000 }`, cached as `pgPool` on globalThis when `NODE_ENV !== "production"`. 03-04 binds `drizzle({ client: pgPool, schema })` — never `drizzle(url)`/`drizzle({ connection })`.
- **pg version quirks with statement_timeout as a Pool option:** none observed. Installed `pg@8.22.0` (audit cites 8.23 docs — same option surface). `statement_timeout` and `idle_in_transaction_session_timeout` are plain `ClientConfig` pass-through keys: Pool stores them on `pool.options` (which is what the tests assert) and forwards its config to every client it creates. TS types accept both keys on `PoolConfig` (`number | false`) — no casts needed.
- **Full-suite runtime:** ~4-6 s wall (`pnpm test`, 11 files / 111 tests, fileParallelism: false, containers already up). Well inside the phase verify budget.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `pgPool` is the attachment point for 03-04's shared-pool Drizzle client (Wave 3, blocked on 03-02 + 03-03 — this plan clears its half)
- 03-03's migration runner must use a DIRECT one-shot connection with statement_timeout deliberately UNSET (documented in db-pool.ts header comments + audit §25.2) — the runner never touches this pool
- Phase 4 adds the worker's OWN pool (max 20, DIRECT string) — a factory may be added to db-pool.ts then; grep guard today: exactly one `new Pool(` in src/lib (db-pool.ts:31)
- DAT-09 stays open until 03-03 (runner) and Phase 4 (worker pool) land

## Self-Check: PASSED

- `src/lib/db-pool.ts`, `src/lib/prisma.ts`, `tests/integration/db-pool.test.ts` all exist on disk
- Commits `dca3ac9`, `75b6bc8`, `85bfa5f` present in git log
- Plan verification re-run post-commit: db-pool suite 4/4, full suite 111/111 exit 0, no `new Pool(` in prisma.ts

---
*Phase: 03-redis-drizzle-schema-ownership*
*Completed: 2026-09-12*
