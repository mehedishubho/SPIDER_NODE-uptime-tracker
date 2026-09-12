---
phase: 03-redis-drizzle-schema-ownership
reviewed: 2026-09-13T00:00:00Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - docs/DEPLOY-RUNBOOK.md
  - drizzle/0000_baseline.sql
  - drizzle/0001_worker-prereqs.sql
  - drizzle/meta/0000_snapshot.json
  - drizzle/meta/0001_snapshot.json
  - drizzle/meta/_journal.json
  - prisma/schema.prisma
  - scripts/anonymize-snapshot.mjs
  - scripts/rehearse-migrations.mjs
  - scripts/schema-gate.mjs
  - scripts/stamp-baseline.mjs
  - src/app/api/auth/register/route.ts
  - src/app/api/monitors/route.ts
  - src/db/index.ts
  - src/db/schema.ts
  - src/lib/db-pool.ts
  - src/lib/prisma.ts
  - src/lib/rate-limit.ts
  - tests/api/auth-shallow.handler.test.ts
  - tests/api/monitors.handler.test.ts
  - tests/integration/db-client.test.ts
  - tests/integration/db-pool.test.ts
  - tests/setup/global-setup.ts
  - src/lib/redis.ts
findings:
  critical: 1
  warning: 6
  info: 4
  total: 11
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-09-13
**Depth:** standard
**Files Reviewed:** 24
**Status:** issues_found

## Summary

Phase 03 ships the schema-ownership toolchain (baseline + worker-prereqs migrations, stamp/rehearse/gate scripts, frozen Prisma schema), the shared neutral pg Pool with the Drizzle client attached, and the Redis-backed atomic rate limiter wired into the register/monitors routes.

The runtime-facing code is in good shape: the Lua INCR+EXPIRE fixed-window limiter is atomic and TTL-safe with a correct fail-open profile; the pool pinning matches audit §25.2; the baseline SQL is a faithful transcription of the live DDL; the stamp script's baseline-only boundary is correct; the rehearsal pipeline's digest carve-out is sound; and the test suites isolate Redis limiter state properly.

However, the migration **toolchain** carries one blocker: `drizzle/meta/0001_snapshot.json` does not describe the post-0001 schema — it is structurally a copy of the 0000 snapshot. Every object 0001 adds (write_guards, outbox, next_check_at, consecutive_failures, error_class, status_code, the gen_random_uuid() defaults, three indexes) is absent from it. Nothing in the shipped gate or runner detects this today, but the first future `drizzle-kit generate` — the exact command the gate's own failure output instructs the operator to run — will emit a duplicate of all of 0001's DDL and fail on any database that already ran 0001.

Secondary findings: the rehearsal container publishes un-anonymized production data on all network interfaces during the restore window; the schema authority file carries an opclass that cannot round-trip through `generate`; the runbook makes two operationally wrong claims (the REDIS_URL boot-crash-loop claim, and the unimplemented live-database empty-diff check); the rehearsal script hard-codes the journal row count it was explicitly built to reuse; and the limiter's client-controlled keying now feeds an unbounded Redis keyspace behind a pinned `noeviction` policy.

Note: `src/lib/redis.ts` was not in the supplied file list but is the direct dependency of the in-scope `src/lib/rate-limit.ts`; it was read and reviewed as an integration point (and is listed in `files_reviewed_list`).

## Critical Issues

### CR-01: 0001 meta snapshot does not contain any of 0001's changes — the documented generate path is broken

**File:** `drizzle/meta/0001_snapshot.json` (whole file); corroborating: `drizzle/0001_worker-prereqs.sql`, `src/db/schema.ts`, `scripts/schema-gate.mjs:377-379`
**Issue:** `0001_snapshot.json` is structurally identical to `0000_snapshot.json` (verified programmatically — only the `id`/`prevId` and JSON key order differ). It is missing everything migration 0001 introduces:

- tables `write_guards` and `outbox`
- columns `monitors.next_check_at`, `monitors.consecutive_failures`, `pings.error_class`, `pings.status_code`
- the `gen_random_uuid()::text` defaults on `users.id`, `pings.id`, `incidents.id` (and `outbox.id`)
- indexes `idx_monitors_due`, `idx_outbox_unsent`, `incidents_one_ongoing`

A snapshot is what `drizzle-kit generate` diffs `src/db/schema.ts` against to produce the NEXT migration. Because the latest snapshot describes the pre-0001 state while `src/db/schema.ts` describes the post-0001 state, the next `generate` will emit a migration that re-creates every 0001 object (duplicate `CREATE TABLE write_guards`, duplicate columns, duplicate indexes) — which fails on application against any database that already ran 0001, i.e. production and every rehearsed/test database. This is exactly the path the phase's own tooling prescribes: `schema-gate.mjs` prints "schema changes belong in a NEW drizzle migration (drizzle-kit generate)" on every drift, and runbook §8 makes versioned generate output the only schema authority going forward.

Nothing currently catches this: `drizzle-kit migrate` ignores snapshots (journal + hash only), `drizzle-kit check` only detects journal hash collisions (the id/prevId chain here is valid), and the schema gate compares `src/db/schema.ts` against a *pull of the migrated database* — never the snapshots against the SQL.

**Fix:** Rebuild the 0001 snapshot from the true post-0001 state, e.g.:

1. In a scratch directory, stage `meta/0000_snapshot.json` + a journal containing only the baseline entry.
2. Run `pnpm exec drizzle-kit generate` with `schema: ./src/db/schema.ts` and `out:` pointed at the scratch dir — the diff (all 0001 objects) reproduces 0001's DDL and produces a correct post-state snapshot.
3. Replace `drizzle/meta/0001_snapshot.json` with that generated snapshot, restoring `"id": "a3c3b8b8-7356-4481-b481-b49a9c08d944"` and `"prevId": "a00fb629-b4f1-45e6-9b0d-e95d27546c05"` so the committed journal chain stays intact; delete the scratch artifacts.
4. Verify `pnpm exec drizzle-kit check` is clean, `pnpm schema:gate` stays green, and re-run `pnpm rehearse:migrations` (the journal hash of 0001 is over the .sql file only, so it is unchanged).

Then add a regression guard so this cannot recur silently, e.g. a gate step that re-generates into a scratch `out` from `src/db/schema.ts` and fails if the produced SQL is non-empty while the journal has no pending entry (i.e. snapshot ≠ schema ≠ migrations).

## Warnings

### WR-01: `src/db/schema.ts` carries an invalid opclass for the boolean index column — cannot round-trip through generate

**File:** `src/db/schema.ts:93`
**Issue:** `index("idx_monitors_due").using("btree", table.isActive.asc().nullsLast().op("timestamptz_ops"), table.nextCheckAt.asc().nullsLast().op("timestamptz_ops"))` — `isActive` is a boolean column but carries `timestamptz_ops`. PostgreSQL cannot create an index with that opclass on a boolean (error 42804), and migration 0001 correctly creates the index with default opclasses. This is a drizzle-kit pull serializer artifact faithfully transcribed (the gate stays green because both sides of its diff come from pull), but the committed "single schema authority" file now contains SQL-shape information that `drizzle-kit generate` would emit invalidly. Combined with CR-01 (the stale snapshot guarantees this index appears in the next generate diff), the next generated migration is doubly broken.
**Fix:** Correct the transcription to `.op("bool_ops")` on `isActive` AND normalize the same pull quirk in the gate (a rule in `canonicalizeDefaultRenderings`' style that rewrites the opclass of a boolean column to `bool_ops` on BOTH sides), so the authority file is generate-safe without false-positiving the pull-vs-committed diff.

### WR-02: Rehearsal container publishes restored, un-anonymized production data on all interfaces

**File:** `scripts/rehearse-migrations.mjs:548`
**Issue:** `docker run -d --name ... -p ${PORT}:5432` binds `0.0.0.0:5460`. The full production dump is restored (step 2) BEFORE anonymization runs (step 3), so for the restore+anonymize window — potentially minutes — real PII and secrets (emails, telegram chat ids, session tokens, bcrypt password hashes) sit in a Postgres reachable from the whole LAN with the well-known credentials `postgres:postgres`. The pre-flight `probePortFree` only probes `127.0.0.1`, which does not protect the published interface.
**Fix:** Bind loopback only: `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=${DB} -p 127.0.0.1:${PORT}:5432 ...`. All subsequent access (docker exec, REHEARSAL_URL on localhost) keeps working unchanged.

### WR-03: Runbook claim "missing REDIS_URL is a boot crash loop" is false — the failure is silent route 500s

**File:** `docs/DEPLOY-RUNBOOK.md:167` (and `:98`)
**Issue:** §3b step 4 states "`src/lib/redis.ts` throws at module load when the variable is missing: restarting without it is a boot crash loop, not a degraded app", and §3 step 4 repeats "the app throws at module load without it". Verified against the code: `@/lib/redis` is imported only by `src/lib/rate-limit.ts`, which is imported only by the two route modules (`src/app/api/auth/register/route.ts`, `src/app/api/monitors/route.ts`); nothing in the startup graph (`src/instrumentation.ts`) touches it. Next.js evaluates route modules lazily, so with `REDIS_URL` missing the process boots fine, `pm2 status` shows `online`, and the login smoke check returns 200 — only `POST /api/auth/register` and `POST /api/monitors` begin returning 500s. Worse, post-deploy check (d) greps for `[redis-limiter] DEGRADED`, which never prints (the throw precedes any limiter call), so the documented detection paths all pass on a misconfigured release.
**Fix:** Correct the runbook wording ("register/monitor-creation routes 500; the app itself stays online") and make the failure loud for real: validate `REDIS_URL` presence in `src/instrumentation.ts` startup (Phase 3+ code is live there), or extend check (d)/(e) to assert the register probe returns 400/429 — not 500 — after every Phase 3+ release.

### WR-04: Runbook §3 step 3 verification cites a live-database empty-diff check that no tooling or command implements

**File:** `docs/DEPLOY-RUNBOOK.md:81` (and `:350`, §8)
**Issue:** The migrate step's verification requires "the empty-diff check (`drizzle-kit` diff against the live database) reports no drift (M-3)". The shipped gate (`scripts/schema-gate.mjs`) explicitly never consults production ("the gate always targets the test stack, never a dev or production database" — schema-gate.mjs:85-87), and no operator command for a production-side diff exists anywhere in the runbook. As written, M-3 is an unverifiable step: an operator cannot execute it, and drift introduced directly in production (e.g. by a stray push from the frozen Prisma schema — exactly the hazard `prisma/schema.prisma:11-15` warns about) is invisible to every green check in the release path.
**Fix:** Either document the exact typed procedure (e.g. from the VPS: `DATABASE_URL="<DIRECT>" pnpm exec drizzle-kit pull --config=drizzle.gate.config.ts` into a temp dir, then the gate's normalize/compare against `src/db/schema.ts`, with the temp dir removed after) and reference it from §3 step 3, or strike the live-diff claim and state plainly that M-3 is enforced only against the migrated test database plus the rehearsal.

### WR-05: Rehearsal hard-codes `journalRows !== 2` — breaks on the first migration added after this phase

**File:** `scripts/rehearse-migrations.mjs:686-689`
**Issue:** The bookkeeping proof asserts `drizzle.__drizzle_migrations` holds exactly 2 rows ("1 stamped baseline + 1 runner-applied 0001"). The header explicitly promises reuse ("Phase 7's rehearsal reuses this script — D-10 repeatability"), but the moment any 0002+ migration is committed, a fully clean rehearsal FAILS this check with a misleading error, and the operator must edit the script mid-release-cycle.
**Fix:** Derive the expectation from the committed journal: `const expected = JSON.parse(readFileSync("drizzle/meta/_journal.json","utf8")).entries.length;` (1 stamped baseline + entries.length - 1 runner-applied), and assert `journalRows === expected`.

### WR-06: Limiter keys on attacker-controlled `x-forwarded-for` — bypass plus unbounded Redis keyspace behind pinned `noeviction`

**File:** `src/lib/rate-limit.ts:47-53` (with `src/lib/redis.ts`, runbook §3b `maxmemory 512mb` / `maxmemory-policy noeviction`)
**Issue:** `getIP` returns the first `x-forwarded-for` value verbatim; the limiter then mints `rl:register_<value>` / `rl:monitors_<value>` keys in the shared Redis. Two phase-03-specific consequences beyond the pre-existing spoofability: (1) rotating the header gives every request a fresh counter, i.e. the 5/hour and 20/min limits are bypassable outright by any client not behind a sanitizing proxy; (2) each spoofed value creates a new TTL'd key (1h for register) — with the runbook's pinned `noeviction` policy and 512 MB ceiling, a sustained spoofing campaign grows the keyspace until Redis returns OOM errors, at which point the limiter fails open for everyone (and Phase 4's BullMQ writes start failing). The in-memory Map this phase deleted had bounded, per-process blast radius; the Redis migration widens it.
**Fix:** Key on an address the attacker does not control: when not behind a trusted proxy, use the socket peer address (Next: `req.headers` only when a configured proxy set it — e.g. gate on a `TRUST_PROXY` env), and fall back to `x-real-ip`/peer otherwise; additionally consider a periodic `rl:*` TTL sweep or a shared bucket for unparseable values so cardinality cannot grow without bound.

## Info

### IN-01: Drift-print truncation uses `problems.indexOf(problem)` object lookup

**File:** `scripts/schema-gate.mjs:362`
**Issue:** The truncation message finds the current problem's index via `problems.indexOf(problem)` inside the loop — works (object identity), but O(n²) in total and fragile if the array ever holds structural clones.
**Fix:** Iterate with `for (let p = 0; p < problems.length; p++)` and slice from `p`.

### IN-02: Rehearsal evidence files collide on same-day re-runs

**File:** `scripts/rehearse-migrations.mjs:430-437`
**Issue:** Evidence is named `rehearsal-YYYYMMDD.md/.json` and the phase copy `03-REHEARSAL-EVIDENCE-YYYYMMDD.md`. The runbook's own §3d step 4 loop ("fix the migration, commit, re-rehearse") makes two rehearsals on one day the expected pattern; the second run silently overwrites the first's evidence, destroying the FAIL record.
**Fix:** Append a time component (`rehearsal-YYYYMMDD-HHMMSS`) or a counter suffix for the local artifacts; keep the dated phase copy pointing at the latest PASS.

### IN-03: Shared pool imported via two different specifiers (`@/lib/db-pool` vs `./db-pool`)

**File:** `src/db/index.ts:2` vs `src/lib/prisma.ts:3`
**Issue:** Both resolve to the same file today and the globalThis cache backstops duplication in non-production, but the cache is disabled under `NODE_ENV=production` (`src/lib/db-pool.ts:41`), so the single-pool invariant in production rests entirely on the bundler deduping an alias import and a relative import to one module instance. Any future bundler/turbopack alias-resolution divergence silently doubles the connection budget (two pools of 10).
**Fix:** Use one specifier everywhere (the `@/lib/db-pool` alias) and add a comment in `db-pool.ts` noting the production cache-off caveat.

### IN-04: Runbook check (f) exhausts the shared 127.0.0.1 register window — re-running it within the hour fails spuriously

**File:** `docs/DEPLOY-RUNBOOK.md:102`
**Issue:** Check (f) burns six requests in the `rl:register_127.0.0.1` bucket (plus one more if (e) ran first). Re-running (f) — or (e) — inside the same hour from the VPS makes the very first POST return 429, so the check fails (or trivially "passes" its 429 expectation) without proving anything about restart survival.
**Fix:** Document that (e)/(f) share the window (wait an hour between re-runs), or FLUSHDB the single key between checks (`redis-cli -a ... --no-auth-warning DEL rl:register_127.0.0.1`).

---

_Reviewed: 2026-09-13_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
