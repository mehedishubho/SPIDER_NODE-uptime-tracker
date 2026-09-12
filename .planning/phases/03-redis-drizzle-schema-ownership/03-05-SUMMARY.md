---
phase: 03-redis-drizzle-schema-ownership
plan: "05"
subsystem: database
tags: [drizzle, drizzle-kit, postgresql, migrations, rehearsal, pg-dump, anonymization, pg-stat-statements]

requires:
  - phase: 03-redis-drizzle-schema-ownership (03-03)
    provides: src/db/schema.ts (column inventory), stamp-baseline.mjs, dump on disk, port 5460
  - phase: 03-redis-drizzle-schema-ownership (03-04)
    provides: drizzle/0001_worker-prereqs.sql (the migration under rehearsal), fixed stamp boundary (0000 only), 0001 additive inventory
provides:
  - scripts/anonymize-snapshot.mjs — deterministic md5-of-PK masking, UPDATE-only, NULL-preserving, bcrypt hashes untouched (D-10), PROVEN on live data
  - scripts/rehearse-migrations.mjs + pnpm rehearse:migrations — one command: throwaway postgres:17-alpine → pg_restore → anonymize → BEFORE metrics → stamp → timed migrate → AFTER metrics → additive-only assert → evidence → teardown (D-12)
  - .planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260912.md — the DRZ-06 proof artifact: 9 tables, counts+digests all EQUAL, additive-only delta, journal rows 2
  - D-19 resolved from measured data: plain in-transaction indexes confirmed (max build 0.841 ms on real data)
  - Repeatability proven: two independent runs on the same dump produced byte-identical digests (D-10's repeatability requirement, demonstrated)
affects: [03-08 (deploy gate — rehearsal PASS is its precondition), Phase 7 (auth-cutover rehearsal reuses this exact pipeline), 03-07 (empty-diff gate)]

tech-stack:
  added: []  # pg_stat_statements is a built-in contrib extension of the official postgres image — no new dependency
  patterns: [pg_stat_statements as a per-statement DDL timing probe (stats reset immediately before the measured window; extension created before both structure snapshots so it never pollutes an additive-only diff), pinned pre-migration column inventory as the sanctioned-write carve-out mechanism]

key-files:
  created:
    - scripts/anonymize-snapshot.mjs
    - scripts/rehearse-migrations.mjs
    - .planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260912.md
  modified:
    - package.json (rehearse:migrations script)

key-decisions:
  - "D-19: plain in-transaction CREATE INDEX confirmed, no concurrent path needed — measured on real anonymized prod data: idx_monitors_due 0.841 ms, incidents_one_ongoing 0.506 ms, idx_outbox_unsent 0.376 ms (max 0.841 ms << 1000 ms threshold); migrate wall 715 ms"
  - "Digest = md5(string_agg(md5(ROW(<pinned pre-migration column inventory>)::text), '' ORDER BY id)) with '<empty>' for zero rows — the carve-out is implemented AS the pinned inventory (0001's added columns are outside the digest by construction), labeled in the evidence (Open Question 4)"
  - "Per-statement D-19 timing probe = pg_stat_statements (server-side, per statement inside the real migrate) — the docker server log cannot do it: the migrator submits the whole migration file as ONE multi-statement query string and postgres logs one duration per string"
  - "pg_stat_statements extension is created BEFORE both structure snapshots so its view is symmetric in the additive-only diff; stats are reset immediately before the timed migrate so timings cover that migrate only"

patterns-established:
  - "Pattern: rehearsals run one command (pnpm rehearse:migrations) against the NEWEST .snapshots/prod-*.dump; Phase 7's auth-cutover rehearsal extends the carve-out list (documented in the script header) rather than writing a new pipeline"
  - "Pattern: server-flag arguments to docker run go AFTER the image name (container command) — before it, docker consumes them itself (-c means --cpu-shares)"

requirements-completed: [DRZ-06]

coverage:
  - id: D1
    description: "Deterministic anonymization (D-10): md5-of-PK masking over the schema.ts-enumerated PII/secret columns, UPDATE-only, NULL-preserving, bcrypt hashes untouched"
    requirement: DRZ-06
    verification:
      - kind: other
        ref: "live rehearsal runs: masked users 1 / verification_tokens 1 rows; sanity probe 0 non-@anon.test users.email; digests byte-identical across two independent runs of the same dump; zero password-modifying statements (grep)"
        status: pass
    human_judgment: false
  - id: D2
    description: "One-command orchestrated rehearsal pipeline (D-12): port pre-check → throwaway container → pg_restore --exit-on-error → anonymize → BEFORE metrics → stamp 0000-only → timed migrate → AFTER metrics → additive-only assert → evidence files → teardown in finally"
    requirement: DRZ-06
    verification:
      - kind: other
        ref: "pnpm rehearse:migrations exit 0 (twice); docker ps shows no spidernode-rehearse after success AND after the two mid-run failures (teardown verified on all paths)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Executed rehearsal against fresh prod dump prod-20260912-b with committed evidence (DRZ-06): 9 tables counts+digests EQUAL, additive-only delta == 03-04's 0001 inventory, journal rows 2, D-19 decision recorded"
    requirement: DRZ-06
    verification:
      - kind: other
        ref: "03-REHEARSAL-EVIDENCE-20260912.md verdict PASS, failures: [] — commit fa1a4b6; script exits non-zero on any mismatch (T-03-12 fail-loud contract)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Operator review of the committed evidence (checkpoint:human-verify tail of Task 3)"
    verification: []
    human_judgment: true
    rationale: "The checkpoint's resume-signal requires the operator to review the evidence summary and confirm ('approved') or describe a mismatch — a human sign-off on the DRZ-06 proof artifact that gates 03-08's production deploy"

duration: 455s this session (~8 min; Task 3 continuation — Tasks 1-2 in prior session + checkpoint)
completed: 2026-09-12
status: complete
---

# Phase 03 Plan 05: Migration Rehearsal Pipeline + DRZ-06 Execution Summary

**The full production migration path replayed against a fresh anonymized production snapshot in one command — 9 tables, 237 rows, every count and digest surviving the migrate byte-identical (sanctioned carve-out labeled), an additive-only DDL delta matching 03-04's 0001 inventory exactly, and D-19 resolved from measured per-index timings (max 0.841 ms: plain in-transaction indexes stand).**

## Performance

- **Duration:** 455s this continuation session (~8 min); Tasks 1-2 (scripts + smoke) committed in the prior session, Task 3 paused at the dump checkpoint
- **Started:** 2026-09-12T13:55:53Z (this session)
- **Completed:** 2026-09-12T14:03:28Z
- **Tasks:** 3 (Tasks 1-2 prior session; Task 3 = checkpoint + rehearsal execution, this session)
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments

- **DRZ-06 executed and proven:** `pnpm rehearse:migrations` discovered the fresh dump (`.snapshots/prod-20260912-b.dump`, 21,595 bytes, taken by the operator at the checkpoint per D-11), restored it into throwaway `spidernode-rehearse` (postgres:17-alpine, port 5460), anonymized it, stamped the baseline, migrated, re-measured, asserted — exit 0, verdict PASS
- **Zero data movement outside the sanctioned carve-out:** all 9 tables' row counts BEFORE==AFTER; all 9 digests BEFORE==AFTER (digest computed over the pinned pre-migration column inventory — 0001's added columns are outside by construction, labeled in the evidence; Open Question 4 resolved as designed)
- **Additive-only DDL delta — exactly 03-04's 0001 inventory:** +tables outbox/write_guards, +14 columns (monitors.next_check_at/consecutive_failures, pings.error_class/status_code, the outbox/write_guards sets), +5 indexes (3 partial + 2 new-table pkeys), 3 recorded sanctioned default changes (gen_random_uuid()::text on pings/incidents/users.id), nothing removed/renamed/retyped; pg_dump schema-only delta +7/-0
- **D-19 resolved from measurement, not assumption:** every index build sub-millisecond on real data — `idx_monitors_due` 0.841 ms, `incidents_one_ongoing` 0.506 ms, `idx_outbox_unsent` 0.376 ms; migrate wall 715 ms; journal rows 2 (stamp wrote the baseline row, the runner applied 0001 exactly once)
- **Repeatability demonstrated (D-10's Phase-7 requirement):** two independent full runs against the same dump produced byte-identical digests for all 9 tables — the anonymization is deterministic in practice, not just in intent

## Task Commits

1. **Task 1: scripts/anonymize-snapshot.mjs — deterministic masking (D-10)** - `c5a681a` (feat, prior session)
2. **Task 2: scripts/rehearse-migrations.mjs + pnpm rehearse:migrations (D-12)** - `aa75c18` (feat, prior session)
3. **Task 3: run rehearsal vs fresh snapshot + evidence (DRZ-06)** - `fa1a4b6` (docs: evidence copy)
4. **Rule 1 auto-fix: quote camelCase sessionToken** - `e7fca6e` (fix)
5. **Rule 1 auto-fix: pg_stat_statements per-statement timing probe** - `c316c2e` (fix)

**Plan metadata:** (final docs commit below)

## Headline Numbers (the plan's required record)

- **Evidence file:** `.planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260912.md` (committed `fa1a4b6`; local copy `.snapshots/rehearsal-20260912.md` + `.json` stays uncommitted per .snapshots hygiene)
- **Dump:** `prod-20260912-b.dump` (21,595 bytes — byte-size equal to 03-03's dump; data unchanged between dumps, expected at this dataset size)
- **Tables verified:** 9 · **total rows:** 237 (users 1, monitors 1, pings 234, verification_tokens 1; accounts/feedbacks/incidents/password_reset_tokens/sessions empty)
- **Migrate wall time:** 715 ms · **journal rows:** 2
- **Per-index builds (D-19):** idx_monitors_due 0.841 ms · incidents_one_ongoing 0.506 ms · idx_outbox_unsent 0.376 ms
- **D-19 decision:** plain indexes confirmed, no concurrent path needed (max build 0.841 ms < 1000 ms threshold on real data)
- **Digest definition:** `digest(table) = md5( string_agg( md5( ROW(<pinned pre-migration column inventory from src/db/schema.ts>)::text ), '' ORDER BY id ) )`, `'<empty>'` substituted for zero rows. Carve-out (labeled in evidence): the pinned inventory excludes 0001's added columns — monitors.next_check_at + consecutive_failures (backfill/catalog writes), pings.error_class + status_code (additive NULLs); their additive-only arrival is asserted by the DDL delta instead
- **Rehearsal port:** 5460 (docker-published; isolated from the 5453 vitest stack)
- **Anonymized columns (schema.ts enumeration, recorded per Task 1 criteria):** users.email/name/"telegramChatId"; accounts."providerAccountId"/refresh_token/access_token/id_token; sessions."sessionToken"; verification_tokens.email/token; password_reset_tokens.email/token — bcrypt users.password deliberately untouched

## Restore Quirks (Phase 7's rehearsal inputs)

- **pg_restore was clean:** exit 0 with `--exit-on-error`, no index-am or extension warnings on the 17.7 dump restored into 17-alpine (same major — no discretion check needed)
- **Probe artifacts must precede structure snapshots:** `pg_stat_statements` is created BEFORE the BEFORE-snapshot so its view appears symmetrically in both pg_dump inventories — creating it between the snapshots would pollute the additive-only delta (documented in the script)
- **Per-statement timing needs pg_stat_statements:** the migrator submits each migration file as ONE multi-statement simple-protocol string; postgres logs one duration per string, so server logs alone cannot give per-index timings
- **Determinism across runs is observable:** identical digests from two full runs — a cheap invariant Phase 7's rehearsal can re-assert for free

## Files Created/Modified

- `scripts/anonymize-snapshot.mjs` - deterministic UPDATE-only masking; all masked values derive from md5 of stable row key material; fail-loud; never logs the connection string
- `scripts/rehearse-migrations.mjs` - the 10-step pipeline (see header); port/name pre-checks refuse to touch sibling stacks; teardown in finally on success AND failure
- `package.json` - `"rehearse:migrations": "node scripts/rehearse-migrations.mjs"`
- `.planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260912.md` - counts + digests only, zero PII by construction (T-03-11)

## Decisions Made

- **D-19: plain in-transaction CREATE INDEX stands** — measured, sub-millisecond on real data; no out-of-runner psql step needed for 0001. If a future migration's index proves slow in rehearsal, the script's evidence already derives and records the exact runbook-note path (research Pitfall 1)
- **pg_stat_statements chosen as the per-statement probe** after the docker-log approach proved structurally unable to split multi-statement durations (see Deviation 2)
- **Operator evidence review remains the checkpoint's human tail** — the evidence is committed and surfaced here; the deploy gate (03-08) additionally requires it

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Unquoted camelCase identifier in sessions masking UPDATE**
- **Found during:** Task 3 (first live rehearsal run)
- **Issue:** Task 1's script wrote unquoted `sessionToken = ...`; Postgres folds unquoted identifiers to lowercase, and the live column is camelCase `"sessionToken"` — anonymization failed mid-transaction (`column "sessiontoken" of relation "sessions" does not exist`). The sibling camelCase columns ("telegramChatId", "providerAccountId") were correctly quoted, which is why users/accounts masking had already succeeded. Task 1's verification (`node --check` + grep) cannot catch a runtime identifier mismatch — the first live restore was the exposing event
- **Fix:** quoted `"sessionToken"` (and aligned the header inventory comment); the script's BEGIN/ROLLBACK had already discarded the half-masked state; container torn down by the finally block; re-ran clean
- **Files modified:** scripts/anonymize-snapshot.mjs
- **Verification:** second run masked sessions (0 rows in this dump — statement now parses and applies); full rehearsal PASS
- **Committed in:** e7fca6e

**2. [Rule 1 - Bug] D-19 timing probe captured zero per-index timings**
- **Found during:** Task 3 evidence review (first PASS run)
- **Issue:** the probe parsed docker server logs for `duration: X ms statement: CREATE INDEX...`, but the migrator submits the whole migration file as ONE multi-statement simple-protocol query string — postgres logs a single duration line whose statement text begins with the migration's header comment. The filter matched nothing and the D-19 derivation degenerated to "max index build 0 ms" — an empty-measurement artifact, not evidence. The plan requires per-statement index-build timings
- **Fix:** pg_stat_statements as the per-statement probe (utility hook fires per statement inside the real migrate): preload at `docker run` (flag AFTER the image name — before it docker consumes `-c` as `--cpu-shares`, caught by the fail-loud path on the first attempt), `CREATE EXTENSION` before both structure snapshots (symmetric in the diff), `pg_stat_statements_reset()` immediately before the timed migrate; zero-capture now fails loud instead of deriving D-19 from nothing; docker-log durations kept as an auxiliary probe
- **Files modified:** scripts/rehearse-migrations.mjs
- **Verification:** re-run captured all 3 index builds individually (0.841/0.506/0.376 ms); evidence Timing section now carries them
- **Committed in:** c316c2e

---

**Total deviations:** 2 auto-fixed (2 Rule 1 bugs — both in scripts authored by this plan, both exposed by the first live execution, which is precisely what a rehearsal is for)
**Impact on plan:** No scope creep. Both fixes harden the repeatability contract Phase 7 inherits; neither changed any migration artifact or verification rule.

## Issues Encountered

None beyond the two deviations. Notably the fail-loud + teardown-in-finally design held under real failure: both mid-run aborts left zero orphaned containers (`docker ps -a` clean) and no half-masked state (transaction rollback), and the port pre-check never fired because 5460 stayed free throughout.

## Authentication Gates

None — the operator-supplied dump landed before this session (checkpoint resolution "dump ready"); no credentials were needed by the executor.

## User Setup Required

None — the checkpoint's operator step (fresh dump) is complete; the pipeline takes no persisted configuration.

## Next Phase Readiness

- **03-08 (deploy):** the DRZ-06 gate artifact exists and PASSES — rehearsed counts/digests/additive-only/timings all green against a fresh snapshot; its post-deploy probes can reuse the recorded index names and hashes from 03-04 plus this plan's timing baseline (migrate 715 ms)
- **Phase 7 (auth cutover):** the pipeline is the reusable rehearsal engine — one command, fresh dump each time (D-11), extend the carve-out list when a new migration writes data into a new column (header documents the mechanism); anonymization repeatability is proven (byte-identical digests across runs) and bcrypt hashes survive for the canary login
- **03-07 (empty-diff gate):** unaffected by this plan; note the rehearsal's AFTER structure again confirms the migrated shape (0000+0001) the gate will diff against
- **Caution:** `pnpm rehearse:migrations` requires Docker Desktop running and port 5460 free; it never touches the 5453/6390 test stack or any sibling container (pre-checks abort on collision)

## Self-Check: PASSED

All 4 created/modified files exist on disk; all 5 commits verified in git log (c5a681a, aa75c18, e7fca6e, c316c2e, fa1a4b6); evidence file committed at the plan-specified path; `docker ps -a` shows no spidernode-rehearse; no stray untracked files beyond the pre-existing hygiene exclusions (skills-lock.json, .claude/skills/*, .planning/research/.cache/*, .playwright-mcp/, docker-compose.dev.yml — untouched; .snapshots/rehearsal-* intentionally uncommitted).

---
*Phase: 03-redis-drizzle-schema-ownership*
*Completed: 2026-09-12*
