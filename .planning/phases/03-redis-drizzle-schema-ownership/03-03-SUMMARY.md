---
phase: 03-redis-drizzle-schema-ownership
plan: "03"
subsystem: database
tags: [drizzle, drizzle-kit, postgresql, migrations, baseline-stamp, pg-dump, schema]

requires:
  - phase: 02-test-and-deploy-foundation
    provides: docker test stack conventions, vitest env-resolution discipline, port-collision history
provides:
  - src/db/schema.ts — the single Drizzle schema authority, generated from live production DDL (DRZ-01)
  - drizzle/0000_baseline.sql + meta journal — full canonical DDL baseline; fresh databases build from migrations alone (D-14 mechanism)
  - scripts/stamp-baseline.mjs — deterministic journal stamp; existing databases (rehearsal snapshot, production) skip the baseline forever
  - A4/A6 live-DDL facts for 03-04 (backfill types) and 03-07 (gate config)
  - Restore port 5460 recorded for 03-05's rehearsal container
affects: [03-04 (worker-prereqs migration 0001), 03-05 (rehearsal), 03-07 (empty-diff gate), Phase 4+ (all migrations)]

tech-stack:
  added: [drizzle-orm 0.45.2 (runtime), drizzle-kit 0.31.10 — installed in 03-01/03-02 sessions, first schema artifacts this plan]
  patterns: [drizzle-kit pull with schemaFilter ["public"] as the DDL source of truth, deterministic journal stamping (sha256 of .sql + journal when as created_at), LF-pinned hash-bearing artifacts]

key-files:
  created:
    - drizzle.config.ts
    - src/db/schema.ts
    - drizzle/0000_baseline.sql
    - drizzle/meta/_journal.json
    - drizzle/meta/0000_snapshot.json
    - scripts/stamp-baseline.mjs
    - .gitattributes
  modified:
    - .gitignore

key-decisions:
  - "Snapshot source DEVIATION: production data lives in local docker spidernode-dev-db (postgres:17-alpine, PostgreSQL 17.7), NOT Neon — dump taken via docker exec pg_dump -F c; PROJECT.md's Neon claim flagged stale"
  - "schema.ts preserves drizzle-kit pull formatting verbatim under a provenance header — byte-match with normalized pull output is the 03-07 gate's steady state"
  - "Journal when=1789218624104 committed to git is the fixed stamp timestamp (D-12); .gitattributes pins LF on hash-bearing drizzle artifacts"
  - "A4: _prisma_migrations ABSENT — 03-07 needs no tablesFilter exclusion; A6: all 14 time columns are naive timestamp(3)"
  - "Restore port 5460 verified free; 03-05 rehearsal reuses it"

patterns-established:
  - "Pattern: pull-generated schema is committed as-is (comments only added) so pull-vs-pull diffing converges — cosmetic repo reformatting of schema.ts is forbidden"
  - "Pattern: migration .sql bytes are a hash input — newline style is pinned via .gitattributes, never edited by hand or by formatters"

requirements-completed: [DRZ-01]

coverage:
  - id: D1
    description: "Gitignored .snapshots/ policy (D-11) + verified-free restore port + fresh production dump on disk"
    requirement: DRZ-01
    verification:
      - kind: manual_procedural
        ref: "operator checkpoint resolution ('dump ready') + commit a705aab (git check-ignore verified) + Task 2 successfully restored .snapshots/prod-20260912.dump (pg_restore exit 0)"
        status: pass
    human_judgment: false
  - id: D2
    description: "src/db/schema.ts — all 9 live public-schema tables generated from restored live DDL via drizzle-kit pull, hand-verified against prod-schema-only.sql and audit §11; zero worker-prereq objects"
    requirement: DRZ-01
    verification:
      - kind: other
        ref: "pnpm typecheck (exit 0) + table-count check schema.ts=9 dump=9 + grep worker-prereq tokens = 0 hits"
        status: pass
    human_judgment: false
  - id: D3
    description: "drizzle.config.ts — dialect postgresql, out ./drizzle, schemaFilter [\"public\"], DATABASE_URL throw-early, breakpoints"
    requirement: DRZ-01
    verification:
      - kind: other
        ref: "config file inspection (Task 2 acceptance criteria) + exercised by pull (9 tables, 0 non-public) and migrate runs"
        status: pass
    human_judgment: false
  - id: D4
    description: "drizzle/0000_baseline.sql + meta journal — exactly one entry tag 0000_baseline; full canonical DDL, no IF NOT EXISTS, line-by-line reviewed against prod-schema-only.sql"
    requirement: DRZ-01
    verification:
      - kind: other
        ref: "journal-ok check (entries.length===1, tag 0000_baseline) + grep 'IF NOT EXISTS' = 0 hits + line-by-line review logged in this SUMMARY"
        status: pass
    human_judgment: false
  - id: D5
    description: "scripts/stamp-baseline.mjs + two-direction proof: stamped snapshot skips baseline (migrate = 0-applied no-op, exit 0); fresh empty DB builds all 9 tables from 0000 alone; stamp hash byte-identical to runner hash"
    requirement: DRZ-01
    verification:
      - kind: other
        ref: "node --check + stamp-twice -> count(*)=1 + migrate exit 0 on stamped snapshot + fresh-container migrate -> 9 tables + hash equality 9b294622...5030 from stamp/runner/direct computation"
        status: pass
    human_judgment: false

duration: 476s this session (~8min; Tasks 2-3 continuation — Task 1 checkpoint + dump in prior session)
completed: 2026-09-12
status: complete
---

# Phase 03 Plan 03: Live-DDL Drizzle Schema + Baseline/Stamp Mechanism Summary

**Drizzle schema pulled from live production DDL (9 tables, 68 columns, 10 indexes, 6 FKs) plus a deterministic sha256 journal stamp proven in both directions — existing databases skip the baseline, fresh databases build everything from migration 0000 alone.**

## Performance

- **Duration:** 476s this continuation session (~8 min); Task 1 (checkpoint + dump) completed in the prior session
- **Started:** 2026-09-12T13:05:59Z (this session)
- **Completed:** 2026-09-12T13:13:55Z
- **Tasks:** 3 (Task 1 closed via operator checkpoint; Tasks 2-3 executed here)
- **Files modified:** 8 (7 created, 1 modified)

## Accomplishments

- **Snapshot provenance secured (DRZ-01's authoring half):** the production dump was restored into throwaway `spidernode-snapshot-restore` (port 5460, postgres:17-alpine), and `src/db/schema.ts` was generated from that live DDL via `drizzle-kit pull` — never from `prisma/schema.prisma` (D-07)
- **Baseline + stamp mechanism proven (research Pattern 4):** stamp-twice on the restored snapshot leaves exactly 1 bookkeeping row; `drizzle-kit migrate` on the stamped snapshot is a 0-applied no-op exiting 0; migrate on a fresh empty container applies 0000 and builds all 9 tables; the stamp's (hash, created_at) is byte-identical to what the shipped 0.45.2 runner itself writes
- **Facts for downstream plans recorded:** A4 (`_prisma_migrations` ABSENT), A6 (all time columns naive `timestamp(3)`), source Postgres 17.7, restore port 5460

## Task Commits

1. **Task 1: Snapshot plumbing + fresh production dump (operator-gated)** - `a705aab` (prior session: .gitignore D-11 entry, port probe) + operator dump `prod-20260912.dump`
2. **Task 2: Restore container + drizzle-kit pull → src/db/schema.ts** - `4c7a344` (feat)
3. **Task 3: Baseline 0000 + deterministic stamp script** - `4520383` (feat)
4. **Rule 2 auto-fix: .gitattributes LF pin for hash-bearing artifacts** - `84802e8` (fix)

**Plan metadata:** (see final docs commit below)

## Facts Recorded for Downstream Plans

### Source database (IMPORTANT DEVIATION — see Deviations)

- **No Neon involved.** Production SpiderNode data lives on the operator's local machine in docker container `spidernode-dev-db` (docker-compose.dev.yml, postgres:17-alpine, port 5454, db `uptime_dev`). The dump was taken by the orchestrator: `docker exec spidernode-dev-db pg_dump -U postgres -F c uptime_dev > .snapshots/prod-20260912.dump` (21,595 bytes, custom format, `pg_restore --list` exit 0)
- **PostgreSQL major seen in the dump: 17** (17.7, x86_64-pc-linux-musl). 03-05's rehearsal container matches at postgres:17-alpine — no discretion check needed
- Data profile: 1 user / 1 monitor / 234 pings / 0 incidents (early-stage dataset; the schema is what matters for this plan)

### Restore port

- **5460** — probed free (docker ps + TCP), used for `spidernode-snapshot-restore`. **03-05's rehearsal must reuse port 5460** (fallbacks if taken then: 5461, 5462). Both throwaway containers (restore + fresh-migrate proof) were torn down (`docker rm -f`) after proof — 03-05 spins its own from the dump

### Tables in src/db/schema.ts (9 — count matches prod-schema-only.sql exactly)

accounts, feedbacks, incidents, monitors, password_reset_tokens, pings, sessions, users, verification_tokens

Pull stats: 9 tables / 68 columns / 10 indexes (7 unique + 3 plain) / 6 FKs (all `ON UPDATE CASCADE ON DELETE CASCADE`) / 0 enums / 0 policies / 0 partial indexes (the §11 partial indexes do NOT exist in production — correct, they are migration 0001)

### A4 answer (for 03-07's gate)

`_prisma_migrations` is **ABSENT** from the public schema (schema was `db push`'d, never `migrate deploy`'d — research assumption A4 confirmed). **03-07's empty-diff gate needs NO `tablesFilter` exclusion.** The only non-public artifact the runner adds is `drizzle.__drizzle_migrations`, handled by `schemaFilter: ["public"]`

### A6 answer (for 03-04's backfill types)

**ALL 14 time columns are `timestamp(3) without time zone` (naive — NOT timestamptz).** Full list: feedbacks.createdAt/updatedAt, incidents.startedAt/resolvedAt, monitors.createdAt/lastChecked/updatedAt, password_reset_tokens.expires, pings.createdAt, sessions.expires, users.createdAt/emailVerified/updatedAt, verification_tokens.expires. Defaults are `CURRENT_TIMESTAMP` (Prisma db-push spelling, precision 3). **Consequence for 03-04:** `next_check_at` is NEW and lands as `timestamptz` per §11, but the backfill `COALESCE(last_checked, created_at) + interval` reads naive columns — 03-04 must handle the naive→tz conversion explicitly (server-timezone assumption), and §11's "verify against live pg_dump" marker is now satisfied with this answer

### Stamp identity (for 03-04/03-05/first prod deploy)

- Journal: exactly one entry — idx 0, tag `0000_baseline`, when = `1789218624104` (committed to git; the fixed stamp timestamp, D-12)
- Hash (sha256 of drizzle/0000_baseline.sql content): `9b294622ecf0e9c41d53fed5d6437b6febde9ce11dcf28e5f84ba5cb15dd5030` — verified identical from three sources: stamp script, runner-written row on the fresh container, direct node computation

## Files Created/Modified

- `drizzle.config.ts` - postgresql dialect, schema ./src/db/schema.ts, out ./drizzle, schemaFilter ["public"] (Pitfall 4), DATABASE_URL throw-early (never logged), breakpoints true
- `src/db/schema.ts` - all 9 tables as drizzle-orm/pg-core declarations; provenance header documents DRZ-01 source, the 03-07 byte-match gate contract, and the A4/A6 facts; pull formatting preserved verbatim
- `drizzle/0000_baseline.sql` - full canonical CREATE TABLE/INDEX DDL, no IF NOT EXISTS, statement-breakpoints between statements
- `drizzle/meta/_journal.json` + `drizzle/meta/0000_snapshot.json` - journal entry 0 + kit snapshot
- `scripts/stamp-baseline.mjs` - plain Node ESM, one-shot pg Client (no Pool, no statement_timeout), sha256+journal-when inserts, idempotent (hash-checked), fail-loud restating catches, never logs the connection string
- `.gitattributes` (created) - LF pin on drizzle/** and the stamp script (hash-bearing artifacts)
- `.gitignore` (modified, prior session commit a705aab) - `.snapshots/` entry with D-11 comment

## Pull-output quirks the hand-finish had to handle

1. **pull wrote a full migration-authoring state into out dir** (`0000_productive_joystick.sql` — non-deterministic random name — plus schema.ts, relations.ts, meta/ journal). All of it was removed after copying schema.ts to src/db, so `generate --name=baseline` could author a clean, deterministic journal entry 0. Lesson for future pulls: pull's out-dir side effects always need cleanup before generate
2. **pull renders `timestamp({ precision: 3, mode: 'string' })`** — mode 'string' (values as strings) is pull's default rendering; kept verbatim because the 03-07 gate diffs pull-vs-pull. Consumer phases decide handling at query time
3. **Header comment initially contained the literal worker-prereq token names** (next_check_at, outbox, ...) — reworded to descriptive phrasing so the file contains ZERO occurrences of the acceptance-criterion tokens (grep-verifiable absence for 03-04's "not in baseline" check)
4. **Formatting deliberately NOT converted to repo quote/semicolon conventions** — single quotes / no semicolons kept because the gate's textual normalization strips comments and whitespace but not quote style; byte-match with pull output is the steady state

## Baseline vs prod-schema-only.sql — cosmetic (functionally identical) deltas, reviewed line-by-line

- Inline `"id" text PRIMARY KEY` / `"id" serial PRIMARY KEY` in CREATE TABLE vs the dump's separate `ALTER TABLE ... ADD CONSTRAINT <table>_pkey` — PG names both forms `<table>_pkey`; introspect identically
- `serial` inline vs the dump's separate `CREATE SEQUENCE monitors_id_seq` + `SET DEFAULT nextval(...)` — identical semantics (sequence `monitors_id_seq` owned by `monitors.id`)
- FK clause order `ON DELETE cascade ON UPDATE cascade` vs the dump's `ON UPDATE CASCADE ON DELETE CASCADE` — swapped order, identical semantics
- Explicit default opclasses in index DDL (`text_ops`, `int4_ops`) — these are the defaults; no-op
- Alphabetical table creation order with all FKs added after every table exists (the dump uses dependency order) — no forward-reference risk
- Every default value, NOT NULL flag, nullability, precision, index name, and FK name matches the dump exactly; nothing extra exists in 0000

The empty-diff gate (03-07) is the permanent proof that these renderings converge under introspection.

## Decisions Made

- **Snapshot source deviation accepted** (see Deviations #1) — the plan's Neon assumption was wrong for reality; local `spidernode-dev-db` is the production data location today
- **schema.ts keeps pull formatting** under a provenance header — gate convergence beats cosmetic repo-style conformance for this one file
- **when=1789218624104 is now load-bearing** — any regeneration of the journal (e.g. accidental `drizzle-kit generate` re-run) changes `when` and invalidates stamps already written; the committed journal is the deterministic anchor (idempotence check is hash-based, but `created_at` ordering uses `when`)
- **USER-SETUP.md not generated** — the plan frontmatter's `user_setup` entry described the operator supplying a Neon connection string for the dump; that step is complete (superseded by the local-container dump), nothing remains to configure

## Deviations from Plan

### Operator-Ratified Deviation (carried from checkpoint resolution)

**1. [Snapshot source] Production data is local docker `spidernode-dev-db`, not Neon**
- **Found during:** Task 1 (prior session checkpoint; user confirmed "dump ready")
- **Issue:** Plan assumed a Neon-hosted production database (Neon dashboard, Neon connection string, "record the Neon Postgres major version"). The real monitoring data lives in the operator's local docker container `spidernode-dev-db` (postgres:17-alpine, port 5454, db `uptime_dev`)
- **Fix:** The orchestrator took the dump directly (`docker exec spidernode-dev-db pg_dump -U postgres -F c uptime_dev`); all Neon-specific steps are satisfied/moot; the recorded "major version seen in the dump" is PostgreSQL 17 (17.7) from the local container
- **Files modified:** none (dump is gitignored data)
- **Verification:** `pg_restore --list` exit 0; full restore + pull + 2-proof cycle succeeded against it
- **Committed in:** n/a (data only)
- **FLAG FOR USER:** `.planning/PROJECT.md` claims "Postgres is Neon (low connection limits — D-8 budget)" — this is now suspect/stale. The D-8/§25 connection-budget math and DAT-09 assumptions (Neon max_connections ≈ 104 at 0.25 CU, pooled vs direct endpoints) may not describe the actual production topology. PROJECT.md was NOT edited in this plan (out of scope); user should confirm the real production hosting story before Phase 4/8 planning leans on Neon-specific constraints

### Auto-fixed Issues

**2. [Rule 2 - Missing Critical] .gitattributes LF pin for hash-bearing migration artifacts**
- **Found during:** Task 3 commit (git CRLF warnings on drizzle/*.sql)
- **Issue:** `core.autocrlf=true` on this Windows machine converts LF→CRLF on future checkouts of `drizzle/0000_baseline.sql`. The stamp script and the drizzle migrator both compute sha256 over raw file bytes — newline drift between machines (dev Windows vs VPS Linux vs tarball deploys) would silently change the hash and break D-12's deterministic-stamp repeatability
- **Fix:** `.gitattributes` pinning `drizzle/**` and `scripts/stamp-baseline.mjs` to `text eol=lf`; verified via `git check-attr`
- **Files modified:** .gitattributes
- **Verification:** `git check-attr text eol -- drizzle/0000_baseline.sql scripts/stamp-baseline.mjs` → both `eol: lf`
- **Committed in:** 84802e8

**3. [Rule 1 - Bug] Provenance comment violated the zero-token acceptance criterion**
- **Found during:** Task 2 acceptance verification
- **Issue:** The schema.ts provenance header listed the §11 worker-prereq object names literally (next_check_at, write_guards, outbox, ...) — the acceptance criterion requires the file to contain NONE of those tokens (03-04 greps baseline/schema for their absence)
- **Fix:** Reworded the comment to descriptive phrasing ("claim column + due index, guards table, alert event table, ..."); re-ran grep → 0 hits
- **Files modified:** src/db/schema.ts (comment only, same commit)
- **Verification:** `grep -cE "next_check_at|write_guards|outbox|consecutive_failures|error_class|incidents_one_ongoing" src/db/schema.ts` → 0
- **Committed in:** 4c7a344

---

**Total deviations:** 3 (1 operator-ratified source deviation, 1 Rule 2 auto-fix, 1 Rule 1 auto-fix)
**Impact on plan:** No scope creep. The source deviation changes provenance labeling only — every mechanism (pull, baseline, stamp, two-direction proof) executed exactly as planned against the real data.

## Issues Encountered

None beyond the deviations above. Both proof directions passed first try; no "relation already exists" errors (the exact failure mode the stamp exists to prevent never occurred — T-03-07 mitigated).

## User Setup Required

None — the operator-gated dump step was completed at the checkpoint ("dump ready"). No external service configuration remains.

## Next Phase Readiness

- **03-04 (worker-prereqs migration 0001):** ready. Inputs delivered: A6 answer (naive timestamps — backfill must convert), the journal anchor (when=1789218624104, entry count 1), §11 DDL to transcribe, and the `generate --custom` authoring route. DAT-09's migration-runner half (direct one-shot Client, max=1) now has its reference implementation in stamp-baseline.mjs
- **03-05 (rehearsal):** ready. Restore port 5460 recorded; dump on disk; stamp script takes the rehearsal DATABASE_URL; anonymization + checksum script land in 03-05
- **03-07 (empty-diff gate):** ready. schemaFilter ["public"] already in the config; A4 says no tablesFilter needed; the schema's byte-match contract is documented in its header
- **Caution for all:** never re-run `drizzle-kit generate` against a modified journal state without checking `when` — the committed `when` is the stamp anchor

## Self-Check: PASSED

All 8 created/modified files exist on disk; all 5 commit hashes verified in git log (a705aab, 4c7a344, 4520383, 84802e8, 2b8bfcf); no stray untracked files beyond the pre-existing hygiene exclusions.

---
*Phase: 03-redis-drizzle-schema-ownership*
*Completed: 2026-09-12*
