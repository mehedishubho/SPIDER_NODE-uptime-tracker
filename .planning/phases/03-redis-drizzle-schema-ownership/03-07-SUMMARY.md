---
phase: "03"
plan: "03-07"
subsystem: schema-ownership-gates
tags: [drizzle, drizzle-kit, schema-gate, verify-chain, drz-03, drz-02]
requires:
  - "03-03: src/db/schema.ts as the single Drizzle schema authority"
  - "03-04: committed migration set 0000+0001 through the single runner"
  - "03-05: docker test stack (5453/6390) + vitest global-setup migrate"
provides:
  - "pnpm schema:gate — the operator's single typed gate command (empty-diff gate + destructive-push absence scan)"
  - "verify chain with schema:gate wired between test and build"
  - "order-insensitive structural schema comparison (stable across pull runs)"
affects:
  - package.json
  - scripts/schema-gate.mjs
  - drizzle.gate.config.ts
  - src/db/schema.ts
tech-stack:
  added: []
  patterns:
    - "empty-diff gate: migrate -> pull (schemaFilter public) -> normalized structural diff vs committed schema"
    - "absence scan with fragment-built literals (scanner must not contain its own search tokens)"
    - "symmetric canonicalization: .default((IDENT())) -> .default(sql`IDENT()`) on BOTH sides"
key-files:
  created:
    - scripts/schema-gate.mjs
    - drizzle.gate.config.ts
  modified:
    - package.json
    - src/db/schema.ts
    - .gitignore
decisions:
  - "A5 resolved STRUCTURALLY, not textually: pull's top-level ordering is unstable run-to-run, so imports compare as a sorted set and export blocks compare by name"
  - "gen_random_uuid defaults kept in canonical .default(sql`...`) form with a symmetric rewrite rule on both diff sides"
  - "gate targets the docker TEST database only, URL resolution mirroring vitest.config.ts with the T-02-05 localhost guard"
metrics:
  duration: "3h 38m (wall, includes a provider usage-limit interruption)"
  completed: "2026-09-12T18:02:50Z"
  tasks: 2
  files_changed: 5
status: complete
---

# Phase 03 Plan 07: Schema-Drift Gate + Destructive-Push Absence Scan Summary

Two DRZ gates behind one typed command (`pnpm schema:gate`), wired into `pnpm verify`: an empty-diff gate that migrates the docker test DB, introspects it back with drizzle-kit pull, and structurally diffs the result against the committed `src/db/schema.ts`; and an absence scan that fails if the retired destructive prisma push command form or its data-loss flag reappears in any executable surface.

## What Was Built

### Task 1 — the two gates (87b2bba)

**`drizzle.gate.config.ts`** — the gate twin of `drizzle.config.ts`: same dialect/schema/credentials, but `out: "./.tmp-gate"` and `schemaFilter: ["public"]` (Pitfall 4 — the runner's own `drizzle.__drizzle_migrations` bookkeeping schema must never pollute the pull; no tablesFilter needed, A4 confirmed `_prisma_migrations` is absent). Throws early when DATABASE_URL is missing.

**`scripts/schema-gate.mjs`** — plain Node ESM, zero new deps:
- **URL resolution mirroring vitest.config.ts**: `.env.test` override-first (TEST_DATABASE_URL key only), else the canonical `postgresql://postgres:postgres@localhost:5453/uptime_test`; ambient DATABASE_URL deliberately not consulted — the gate can never target a dev/production database. The T-02-05 localhost guard (localhost / 127.0.0.1 / *.docker.internal only, fail-closed on unparseable) runs before anything writes.
- **Gate 1 (empty-diff, T-03-17/T-03-19)**: (a) idempotent `drizzle-kit migrate` against the test DB; (b) `drizzle-kit pull --config=drizzle.gate.config.ts` into `./.tmp-gate`; (c) normalized **structural** diff vs `src/db/schema.ts`; (d) drift printed and exit 1.
- **Gate 2 (absence scan, T-03-18)**: scans package.json, src/, tests/, .github/, scripts/ (skip node_modules/generated/.tmp-gate) for the retired destructive push command form and its data-loss flag — both literals built from concatenated fragments so the scanner never contains them verbatim; self-exclusion via resolved path. docs/ out of scope by design (the runbook narrates the deletion). Fires only after the diff half passes.
- `./.tmp-gate` deleted at pull start AND in a finally block — never survives any exit path. Per-step wall times printed on green.

**`src/db/schema.ts` reconciliation** (the 03-04 handoff item): the file is now a pull of the docker test database after the full committed migration set (0000 baseline + 0001 worker-prereqs) ran through the single runner — the state it must always describe. 11 tables, pull formatting verbatim (single quotes, no semicolons, tabs), provenance header updated. Typecheck green; db-client/db-guard suites green (8/8).

**`.gitignore`**: `/.tmp-gate/` added (Rule 2 — a killed run must never leak generated artifacts into a commit).

### Task 2 — verify wiring + structural hardening (4555bdb)

`package.json`: `"schema:gate": "node scripts/schema-gate.mjs"`, and verify is now:

```
docker compose -f docker-compose.test.yml up -d --wait && pnpm lint && pnpm typecheck && pnpm test && pnpm schema:gate && pnpm build && pnpm test:e2e
```

## The A5 Resolution: Structural, Not Textual (Open Question 2 spike, exercised)

The plan sanctioned a 15-minute structural spike if textual diffing proved unstable. It did — empirically, mid-chain:

1. **Pull's expression-default rendering is not adoptable TypeScript.** drizzle-kit 0.31.x renders a `(gen_random_uuid())::text` column default as `.default((gen_random_uuid()))` — a bare call to an identifier drizzle-orm/pg-core does NOT export (verified against runtime exports; it would throw ReferenceError). Resolution: the committed schema keeps the canonical `.default(sql\`gen_random_uuid()\`)` form and the gate's normalization applies the SAME rewrite `.default((IDENT())) -> .default(sql\`IDENT()\`)` to BOTH sides symmetrically — a genuinely changed default still drifts; only the rendering is unified. Argument-less calls only; anything weirder stays red for a human.

2. **Pull's top-level ordering is not stable run-to-run.** The gate went green standalone, then RED inside the timed chain immediately after `pnpm test` — the pull emitted a different import specifier order and table statement order. Root cause: the serializer follows introspection query row order, which Postgres returns in an order that TRUNCATE/seed activity perturbs. Raw line-order diffing would false-positive after every test run. Resolution (the spike): both sides are parsed into structure — import lines compared as a **sorted set** (with specifier order canonicalized within each import), and each `export const <name> = ...` block compared **by name** with its internal lines still ordered, so column/index drift inside a single table is still caught. Any top-level line that is neither import nor export is keyed by its own content — nothing can silently vanish from the comparison.

3. **Terminator regex bug found and fixed during the spike** (Rule 1): the block-close pattern `^\];$` matched `];` but the pgTable closer is `]);` — the missing `\)` made the first `]);`-terminated block run to EOF. Corrected to `^\]\);$|^\}\);$|^\);$`; verified by charCode probe (93,41,59) before fixing.

## Mutation Proofs (final code; mutations never committed)

**Empty-diff gate — catches intra-table drift:**
- Stray column `gateProbe: text(),` added to the users table in schema.ts → RED, exit 1, scoped output:
  `[users]` / `- gateProbe: text(),`
- Reverted (`git checkout -- src/db/schema.ts`, byte-identical to HEAD) → GREEN, exit 0.

**Empty-diff gate — tolerant of cosmetic-only differences:**
- Comment-only edits (full-line and trailing inline) → GREEN (comments stripped identically on both sides before comparison).
- Import specifier order differing between pull runs → GREEN (canonicalized set comparison) — this is the perturbed-DB-state green, proven end-to-end inside `pnpm verify` itself.

**Absence scan — catches the forbidden tokens:**
- `tests/gate-probe.tmp.ts` containing the prisma push command with its data-loss flag → RED, exit 1, after the diff half passed:
  `tests\gate-probe.tmp.ts:1: retired destructive push command form`
  `tests\gate-probe.tmp.ts:1: destructive data-loss flag`
- Probe deleted → GREEN, exit 0.

## Budget Evidence (D-20: verify ≤ 5 min warm; gate ≤ ~15s)

Full `pnpm verify` (with the documented 02-10 env-less-checkout injection `NEXT_PUBLIC_DEV_BASE_URL=http://localhost:3007`): **exit 0, 31s total wall** — 114 vitest tests passed, gate green, build compiled, 18 e2e tests passed (4.8s).

Warm per-stage timings:

| Stage | Wall |
|---|---|
| docker compose up -d --wait (warm stack) | ~1s |
| pnpm lint | ~4s |
| pnpm typecheck | ~2s |
| pnpm test (vitest, 114 tests) | ~6s |
| pnpm schema:gate (migrate 0.77 · pull 1.60 · diff 0.00 · scan 0.01) | ~2.4s |
| pnpm build | ~6s |
| pnpm test:e2e (18 tests) | ~14s |

The gate adds ~2.4s warm — well inside the ~15s target; the whole chain is 31s against the 5-minute budget.

## Deviations from Plan

**1. [Sanctioned spike — research A5 / Open Question 2] Structural comparison instead of textual line diff**
- **Found during:** Task 2 timed chain (gate RED after `pnpm test`)
- **Issue:** pull's top-level ordering (imports, table statements) varies with DB catalog state — textual diff false-positives
- **Fix:** order-insensitive structural comparison (imports as canonicalized sorted set; export blocks by name, internal lines ordered) — details above
- **Files modified:** scripts/schema-gate.mjs
- **Commit:** 4555bdb

**2. [Rule 1 - Bug] Terminator regex missed the `]);` pgTable closer**
- **Found during:** the structural spike (gate crashed "unterminated export block")
- **Issue:** `^\];$` matches `];` not `]);` — first `]);`-closed block swallowed the rest of the file
- **Fix:** `^\]\);$|^\}\);$|^\);$`, verified by charCode probe
- **Files modified:** scripts/schema-gate.mjs
- **Commit:** 4555bdb

**3. [03-04 handoff, planned] src/db/schema.ts reconciled to the fully-migrated shape**
- Pull of the test DB after migrations 0000+0001 through the single runner; provenance header documents the one non-verbatim adaptation (gen_random_uuid canonical form, symmetric in the gate)
- **Commit:** 87b2bba

**4. [Rule 2 - Correctness] .gitignore entry for /.tmp-gate/**
- A killed gate run must never leak generated introspection output into a commit
- **Commit:** 87b2bba

**5. [Pre-existing, documented — not fixed] pnpm build needs NEXT_PUBLIC_DEV_BASE_URL on this env-less checkout**
- `src/redux/api/baseApi.ts` (untouched) throws at module load without it — intended startup validation per 02-01/02-07/03-01 precedent; verify run with the documented shell injection. Out of scope per the scope boundary.

## Auth Gates

None.

## Known Stubs

None — both gates are fully functional and mutation-proven.

## Self-Check: PASSED

All 6 created/modified files present on disk; commits 87b2bba, 4555bdb, eccc4f0 present in git log; working tree clean for all plan-owned files (only pre-existing hygiene files — skills-lock.json, .claude/skills/*, .planning/research/.cache/*, .playwright-mcp/, docker-compose.dev.yml, .env.test — remain untouched, per the working-tree-hygiene contract).
