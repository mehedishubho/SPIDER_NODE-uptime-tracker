---
phase: 03-redis-drizzle-schema-ownership
plan: "04"
subsystem: database
tags: [drizzle, drizzle-kit, postgresql, migrations, worker-schema, shared-pool, pg-pool]

requires:
  - phase: 03-redis-drizzle-schema-ownership (03-03)
    provides: src/db/schema.ts + drizzle/0000_baseline + meta journal (stamp anchor when=1789218624104) + A4/A6 live-DDL facts
  - phase: 03-redis-drizzle-schema-ownership (03-02)
    provides: src/lib/db-pool.ts — the neutral §25.2-pinned pg.Pool both ORMs share
provides:
  - drizzle/0001_worker-prereqs.sql — every audit §11 worker prerequisite as additive versioned DDL (DRZ-04), applied and proven
  - src/db/index.ts — shared-pool Drizzle client (drizzle({ client: pgPool, schema })), exercised by tests, consumed by no route (DRZ-05/D-05)
  - Test machinery on the single migration runner — prisma db push gone from global-setup (D-14); every test run exercises the real migrations
  - prisma/schema.prisma frozen behind a not-authoritative banner (D-09)
  - scripts/stamp-baseline.mjs fixed to stamp entry idx 0 ONLY (journal growth made the old loop a fake-green deploy path)
  - Recorded facts for 03-05/03-07/03-08: index names, runner hashes, journal when, migrate wall-time, status_code answer
affects: [03-05 (rehearsal), 03-07 (empty-diff gate — schema.ts reconciliation), 03-08 (deploy probes), Phase 4 (worker consumes every object in 0001)]

tech-stack:
  added: []  # drizzle-orm 0.45.2 / drizzle-kit 0.31.10 already installed in 03-01/03-02; no new dependencies
  patterns: [custom-migration authoring (drizzle-kit generate --custom + hand-filled §11 DDL adapted to live camelCase identifiers), shared-pool ORM binding (drizzle({ client }) over drizzle(url)), per-migration forbidden-token grep gates]

key-files:
  created:
    - drizzle/0001_worker-prereqs.sql
    - drizzle/meta/0001_snapshot.json
    - src/db/index.ts
    - tests/integration/db-client.test.ts
  modified:
    - drizzle/meta/_journal.json
    - tests/setup/global-setup.ts
    - prisma/schema.prisma
    - scripts/stamp-baseline.mjs

key-decisions:
  - "§11 DDL transcribed against LIVE camelCase columns (\"isActive\"/\"lastChecked\"/\"createdAt\"/\"interval\"/\"monitorId\") — new objects keep §11 snake_case names; backfill carries explicit AT TIME ZONE 'UTC' naive→tz conversion (A6)"
  - "gen_random_uuid()::text defaults added for existing text PKs (pings/incidents/users) per §11 ID-generation + schema.ts's committed 'arrive with migration 0001' contract + DRZ-04 — dormant for Prisma, required by §16.1's id-omitting INSERTs in Phase 4"
  - "stamp-baseline.mjs fixed to stamp journal entry idx 0 ONLY — the journal growing to 2 entries had made its stamp-everything loop silently skip applying 0001 on rehearsal/prod"
  - "DRZ-02 NOT marked complete — machinery half only landed; deploy-pipeline + absence-gate legs are 03-07/03-08 (02-03 false-signal precedent)"

patterns-established:
  - "Pattern: migrations touching pre-existing objects reference the live introspected identifiers (camelCase here); brand-new objects carry their §11 canonical names — introspected reality beats inventory spelling"
  - "Pattern: every migration .sql is grep-gated — zero occurrences of the concurrent-index token, DROP/RENAME/ALTER-TYPE statements, and IF NOT EXISTS softening (T-03-08 discipline, reusable per migration)"

requirements-completed: [DRZ-04, DRZ-05]  # DRZ-02 deliberately deferred: machinery half landed here; deploy-pipeline (03-08) + repo-wide absence gate (03-07) still pending

coverage:
  - id: D1
    description: "Migration 0001 carries every audit §11 worker prerequisite as additive-only DDL with plain in-transaction indexes"
    requirement: DRZ-04
    verification:
      - kind: other
        ref: "grep gates: 12 statement-breakpoints, zero concurrently/DROP/RENAME/ALTER-TYPE/IF-NOT-EXISTS hits; 13/13 required §11 tokens present; journal entries.length===2 with tag 0001_worker-prereqs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Schema APPLIED and verified through the single runner on a fresh database (blocking gate): exit 0, 2 bookkeeping rows, all SQL probes, idempotent second run"
    requirement: DRZ-04
    verification:
      - kind: other
        ref: "fresh-stack docker down/up → timed drizzle-kit migrate exit 0 (0.78s); psql probes: count(*)=2 journal rows, monitors.next_check_at+consecutive_failures, pings.error_class+status_code, write_guards+outbox non-null, all 3 indexes with predicates via pg_get_indexdef; second migrate no-op exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Shared-pool Drizzle client bound to the one pg.Pool, exercised by tests, consumed by no route (DRZ-05/D-05)"
    requirement: DRZ-05
    verification:
      - kind: unit
        ref: "tests/integration/db-client.test.ts#1-3 (select-1 through pool, full-row monitors select via schema mappings, db.$client === pgPool with @/lib/prisma loaded) — 3/3 pass"
        status: pass
      - kind: other
        ref: "grep -rn 'from \"@/db\"' src/app → zero hits"
        status: pass
    human_judgment: false
  - id: D4
    description: "Prisma schema frozen (D-09) and test machinery switched to the single migration runner (D-14)"
    requirement: DRZ-05
    verification:
      - kind: other
        ref: "prisma/schema.prisma diff = banner-only (+17/-0); global-setup contains execSync(\"pnpm exec drizzle-kit migrate\"), zero push references, assertLocalDatabaseUrl body byte-identical; tests/setup/db-guard.test.ts green untouched"
        status: pass
    human_judgment: false
  - id: D5
    description: "Transition safety proven empirically: full Phase 2 characterization suite green against the grown schema (A2 / audit M-1 premise)"
    requirement: DRZ-04
    verification:
      - kind: integration
        ref: "pnpm test on the drizzle-migrated docker DB — 12 files / 114 tests passed in 5.81s (111 prior characterization + 3 db-client)"
        status: pass
    human_judgment: false

duration: 857s (~14 min)
completed: 2026-09-12
status: complete
---

# Phase 03 Plan 04: Worker-Prereq Migration 0001 + Shared-Pool Drizzle Client Summary

**Every audit §11 worker prerequisite landed as additive versioned DDL (next_check_at + naive→tz backfill, write_guards, outbox, partial indexes, pinned gen_random_uuid()::text ID defaults) and was APPLIED and proven end-to-end through the single runner on a fresh database — with Drizzle bound to the shared pg.Pool, Prisma's schema frozen, and the vitest stack now built by the real migrations.**

## Performance

- **Duration:** 857s (~14 min)
- **Started:** 2026-09-12T13:21:22Z
- **Completed:** 2026-09-12T13:35:39Z
- **Tasks:** 3 (all type=auto; Task 3 was the blocking apply gate)
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- **Migration 0001 authored from audit §11 and APPLIED (DRZ-04):** generated via `drizzle-kit generate --custom --name=worker-prereqs`, hand-filled with the §11 DDL, then applied through the sanctioned runner on a fresh database — the phase's schema-apply gate is closed (types green AND database proven)
- **Shared-pool Drizzle adoption (DRZ-05/D-05):** `src/db/index.ts` binds `drizzle({ client: pgPool, schema })` onto the same §25.2-pinned pool Prisma wraps; proven by identity test; no route imports `@/db`; zero dual-write
- **Single-runner test machinery (D-14/D-09):** global-setup now runs `pnpm exec drizzle-kit migrate`; `prisma db push` is gone from every executable surface (grep-verified); `prisma/schema.prisma` carries the not-authoritative freeze banner
- **Transition safety proven empirically (A2 / audit M-1):** the full characterization suite — cron-logic transitions, db-batcher flush math, handler contracts, the 03-01 limiter suite — runs green against the grown schema: Prisma is blind to additive columns, exactly as the transition premise requires
- **Rule 1 fix protecting 03-05/03-08:** the journal growing to 2 entries turned `stamp-baseline.mjs`'s stamp-everything loop into a fake-green path (it would have marked 0001 applied without running it); fixed to stamp entry idx 0 only and proven on a scratch container

## Task Commits

1. **Task 1: Author 0001_worker-prereqs from audit §11** - `943e7bc` (feat)
2. **Task 2: Shared-pool Drizzle client + prisma freeze + global-setup switch** - `23e6dcd` (feat)
3. **Task 3: [BLOCKING] Apply through the single runner and prove the end state** - no files (verification-only gate; proofs recorded here and reproducible via the Task 3 verify command)
4. **Rule 1 auto-fix: stamp-baseline baseline-only stamping** - `aba9aa4` (fix)

**Plan metadata:** (final docs commit below)

## Facts Recorded for Downstream Plans

### Exact index names as committed (03-08's post-deploy probes reuse these)

| Index | Definition (pg_get_indexdef output) |
|---|---|
| `idx_monitors_due` | `CREATE INDEX ... ON public.monitors USING btree ("isActive", next_check_at) WHERE "isActive"` |
| `idx_outbox_unsent` | `CREATE INDEX ... ON public.outbox USING btree (created_at) WHERE sent_at IS NULL` |
| `incidents_one_ongoing` | `CREATE UNIQUE INDEX ... ON public.incidents USING btree ("monitorId") WHERE (status = 'ONGOING'::text)` |

The `incidents_one_ongoing` predicate matches §16.1's `ON CONFLICT ... WHERE status = 'ONGOING'` inference target (Phase 4's conflict target column will be the live camelCase `"monitorId"`).

### pings.status_code answer (A2/A6 follow-up)

**Did NOT pre-exist.** The live baseline (0000) has only id/monitorId/status/responseTime/createdAt — production never carried status_code, so 0001 ADDs it (`integer NULL`) alongside `error_class text NULL` exactly per §11.

### Runner hashes + journal anchors

- 0000_baseline: `9b294622ecf0e9c41d53fed5d6437b6febde9ce11dcf28e5f84ba5cb15dd5030` @ when 1789218624104 — byte-identical to 03-03's committed stamp (baseline untouched by this plan)
- 0001_worker-prereqs: `04fb27a3d4a51ee09870a0412b2d76c5e605a8edd05d6b9183089c885319c85c` @ when 1789219566417 (journal entry idx 1)
- The fresh-DB runner wrote both rows itself — hash equality with the committed files proves the LF pin + authoring bytes are the canonical artifact

### Timing (D-19 baseline data points)

- **Migrate wall-time on fresh test DB: 0.78s** (0000 + 0001, one transaction, all plain index builds — sub-second as D-19 predicted at this dataset size)
- **Full characterization suite: 5.81s vitest / 6.4s wall** — 12 files, 114 tests, on the drizzle-migrated DB

### Backfill semantics proof (de-risks 03-05)

A real-row probe on the test DB (lastChecked = now()-7min, interval = 5) produced `next_check_at - lastChecked = exactly 300.000000s` with correct timestamptz rendering — the `COALESCE("lastChecked","createdAt") + ("interval" * interval '1 minute') AT TIME ZONE 'UTC'` arithmetic is exact, and the naive→tz conversion is explicit (A6: all live time columns are naive timestamp(3); UTC is the server-timezone assumption, matching the docker Postgres session zone that wrote them).

## Files Created/Modified

- `drizzle/0001_worker-prereqs.sql` - 13 additive statements: next_check_at + backfill + consecutive_failures, pings error_class/status_code, gen_random_uuid()::text defaults (pings/incidents/users id), write_guards, outbox, three partial indexes; header cites §11/D-19
- `drizzle/meta/_journal.json` - entry idx 1 appended by generate --custom; entry 0 (stamp anchor) untouched
- `drizzle/meta/0001_snapshot.json` - kit snapshot chain copy for the custom entry
- `src/db/index.ts` - `export const db = drizzle({ client: pgPool, schema })`; header documents D-05 no-route/no-dual-write contract
- `tests/integration/db-client.test.ts` - select-1, full-row monitors select (schema-mapping proof), pool-identity proof (`db.$client === pgPool` with prisma loaded)
- `tests/setup/global-setup.ts` - schema prep switched to `pnpm exec drizzle-kit migrate`; guard function byte-identical; catch restates stack-down/journal-corruption/bad-migration causes
- `prisma/schema.prisma` - freeze banner prepended (+17/-0); model bodies untouched
- `scripts/stamp-baseline.mjs` - Rule 1 fix: stamps journal entry idx 0 only, logs what stays pending

## Decisions Made

- **Live-identifier adaptation:** §11's SQL spells Prisma-inventory names (is_active, last_checked, monitor_id...); the live DDL 03-03 pulled has camelCase columns. Statements touching existing objects use the real quoted identifiers; new objects carry §11's canonical names. This is what the plan's "using the live column types confirmed by 03-03's A6 answer" required in practice
- **ID defaults on existing text PKs (see Deviation 1):** included on the strength of §11's own pinning, the committed schema.ts header contract, DRZ-04's wording, and §16.1's id-omitting INSERTs
- **DRZ-02 left unchecked** in REQUIREMENTS.md until 03-07 (repo-wide absence gate) and 03-08 (deploy-pipeline leg) land — this plan delivered the machinery half only
- **No schema.ts update in this plan** — 03-04's files_modified excludes it; the committed schema.ts intentionally describes the pre-0001 state (see Next Phase Readiness for the 03-07 consequence)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] gen_random_uuid()::text defaults on existing text PKs**
- **Found during:** Task 1 (migration authoring)
- **Issue:** Plan Task 1's enumeration attached the "pinned DB-side ID default" phrase to CREATE TABLE outbox only, but audit §11's ID-generation section also pins the default for existing text PKs (pings.id, incidents.id, users.id) "in the Phase 3 baseline" — and 03-03's committed schema.ts header states these defaults "arrive with migration 0001 per §11". Phase 4's §16.1 Tier-1 INSERTs omit the id column and REQUIRE these defaults; without them the worker's core write path breaks and a later unplanned migration would be needed
- **Fix:** three `ALTER TABLE ... ALTER COLUMN id SET DEFAULT gen_random_uuid()::text` statements added (additive, catalog-only; not ALTER-TYPE, passes the forbidden-token gates)
- **Files modified:** drizzle/0001_worker-prereqs.sql
- **Verification:** information_schema probe shows all four defaults (outbox/pings/incidents/users); full characterization suite green (Prisma still supplies client-side cuid — the DB default is dormant for it)
- **Committed in:** 943e7bc

**2. [Rule 1 - Bug] stamp-baseline.mjs would have silently skipped 0001 on rehearsal/production**
- **Found during:** post-Task-3 cross-plan review of the stamp script
- **Issue:** the script stamped EVERY journal entry. With one entry (03-03) that was exactly "stamp the baseline". This plan's journal growth to 2 entries changed its behavior: 03-05's rehearsal and 03-08's production stamp would have marked 0001 applied WITHOUT running it — migrate would then apply nothing while reporting success, fabricating the D-19 timing evidence and the "runner applies 0001 exactly once" proof. Research Pattern 4 pins the opposite: "the stamp records 0000 — and only 0000 — as applied; then drizzle-kit migrate applies 0001+ everywhere"
- **Fix:** script now stamps journal entry idx 0 only, and logs what stays pending for the runner; header updated to state the boundary
- **Files modified:** scripts/stamp-baseline.mjs
- **Verification:** scratch container (port 5460): stamp → exactly 1 row ("left pending: 0001_worker-prereqs"); migrate → exit 1 attempting 0001 only (relation "monitors" does not exist on the empty DB; bookkeeping stayed 1 via transaction rollback — had 0000 been pending it would have built the 9 tables and succeeded); stamp re-run → idempotent skip. Scratch container torn down
- **Committed in:** aba9aa4

**3. [Rule 1 - Bug] stale push reference in global-setup module header**
- **Found during:** Task 2 acceptance verification
- **Issue:** the acceptance criterion requires ZERO push references in tests/setup/global-setup.ts, but the module-header comment above assertLocalDatabaseUrl still described the danger as "would point `prisma db push --force-reset`..." — a textual reference that would also trip 03-07's absence scan
- **Fix:** reworded that one sentence to "the migration runner"; the assertLocalDatabaseUrl function itself (JSDoc + body) is byte-identical and tests/setup/db-guard.test.ts is untouched
- **Files modified:** tests/setup/global-setup.ts
- **Verification:** grep "prisma db push" tests/setup/global-setup.ts → zero hits; db-guard tests green
- **Committed in:** 23e6dcd

---

**Total deviations:** 3 auto-fixed (1 Rule 2 missing-critical, 2 Rule 1 bugs)
**Impact on plan:** No scope creep — each fix is additive correctness directly caused by or required by this plan's changes. Deviation 2 in particular converts a silent future deploy failure into a proven boundary.

## Issues Encountered

One execution hiccup, no repo impact: the first stamp-boundary proof piped migrate output through `tail`, masking the real exit code (reported tail's 0). Re-run with output captured to a file — migrate exit 1 as expected. No other issues: fresh-DB apply, all SQL probes, the second-run no-op, and the full suite all passed first try.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **03-05 (rehearsal):** ready, de-risked further than planned — the backfill arithmetic is already proven exact on a real row (300s delta), the stamp script now provably leaves 0001 pending, port 5460 is free again (both scratch proof containers torn down), and the migrate wall-time baseline (0.78s fresh) gives the D-19 comparison anchor. Note for the checksum carve-out: only `next_check_at` is data-writing (backfill); `consecutive_failures integer NOT NULL DEFAULT 0` is a catalog-only change in PG 11+ (no table rewrite, no row rewrites)
- **03-07 (empty-diff gate):** ready with one expected first-green step — the committed src/db/schema.ts still describes the PRE-0001 database (this plan deliberately did not touch it; 03-04's files_modified excludes it). A pull of the migrated test DB now includes next_check_at/consecutive_failures/error_class/status_code, write_guards, outbox, the three partial indexes, and the gen_random_uuid()::text defaults on pings/incidents/users.id. The gate's first green run therefore requires adopting the pulled schema.ts (regenerate from the migrated DB, preserving the provenance header) — exactly the gate's own contract ("schema.ts must equal what migrations build")
- **03-08 (deploy):** index names and hashes recorded above for the post-deploy probes. One wording caution for its executor: 03-08's step-3 verification "the bookkeeping table shows one row per committed migration" must be read AFTER the full sequence (stamp adds the baseline row; migrate adds 0001's row) — immediately after the stamp there must be exactly ONE row (the baseline), per the fixed script and the plan's own must_have ("the runner applies 0001 exactly once")
- **Phase 4 (worker):** every §11 object the worker touches exists and is proven: claim column + due index, one-ongoing physical backstop with the exact ON CONFLICT inference predicate, outbox + unsent index, write_guards, pinned ID defaults for id-omitting INSERTs, error_class/status_code evidence columns

## Self-Check: PASSED

All 8 created/modified files exist on disk; all 3 task commits verified in git log (943e7bc, 23e6dcd, aba9aa4); journal intact (2 entries, baseline anchor unchanged); no stray untracked files beyond the pre-existing hygiene exclusions (skills-lock.json, .claude/skills/*, .planning/research/.cache/*, .playwright-mcp/, docker-compose.dev.yml — untouched).

---
*Phase: 03-redis-drizzle-schema-ownership*
*Completed: 2026-09-12*
