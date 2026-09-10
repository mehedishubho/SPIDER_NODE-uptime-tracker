---
phase: 02-foundations-theme-infrastructure
plan: 04
subsystem: deployment-docs
tags: [deploy-runbook, manual-deployment, pnpm, node-24, vps-switch, dep-04, d-01-d-26]

requires:
  - phase: 02-01
    provides: deleted deploy workflow, pnpm 10.34.5 toolchain, .nvmrc 24 pin, packageManager field
  - phase: 02-02
    provides: pnpm verify gate chain (docker test stack + lint/typecheck/test/build/e2e)
provides:
  - docs/DEPLOY-RUNBOOK.md as the complete manual-era deployment interface — typed-by-hand steps, zero workflow-era instructions
  - §3a one-time VPS Node 24 + pnpm switch the operator executes at their next real deploy (D-26)
  - pnpm verify documented as the pre-deploy gate with the ≤5-minute warm budget and operator-discipline statement (D-02/D-20)
affects: [every deploy until Phase 4 (§3 interim topology), phase-04+ target topology (§4 build step now cites the same dev-machine gate), phase-03 baseline (Migrate step contract unchanged: no schema command until then)]

tech-stack:
  added: []
  patterns: [tarball-ships-build-outputs (repo-root tar minus node_modules/.git/.env* so gitignored .next + src/generated/prisma ride along and .env can never ship), dev-machine-builds-vps-extracts (VPS never runs next build or prisma generate, D-14), placeholder-only infra detail (no hostnames/IPs/secrets)]

key-files:
  created: []
  modified: [docs/DEPLOY-RUNBOOK.md]

key-decisions:
  - "02-04: tarball packs the repo root with excludes (node_modules, .git, .env*, test artifacts) instead of enumerating includes — the two gitignored build outputs (.next, src/generated/prisma) ride along automatically and .env can never enter a tarball by construction (T-02-17)"
  - "02-04: VPS install command is `pnpm install --frozen-lockfile --prod` (plan said plain --frozen-lockfile) — --prod keeps the toolchain (typescript/vitest/playwright/eslint/prisma CLI) off the 2 GB-class VPS; the CLI is unneeded there because the client ships pre-generated (D-14)"
  - "02-04: ecosystem.config.js npm→pnpm edit documented as: edit the extracted VPS copy during the switch AND make the identical repo edit committed with that switch — resolves the packing-order ambiguity (the tarball is packed in §3 step 1, before the switch edit exists) while honoring Open Question 3 (edit belongs to the switch, never a standalone earlier commit)"
  - "02-04: every CI-era claim in the runbook was rewritten, not just the three grep-gated strings — 'CI pipeline', 'deploy pipeline', 'legacy CI schema step', and 'Empty-diff CI gate' all described deleted machinery and would have sent an operator looking for a pipeline that does not exist (accuracy over prose for a live-VPS doc)"

patterns-established:
  - "Decision-ID citation in runbook prose: every amended step cites the D-xx it implements (D-01..D-05, D-14, D-20, D-26) so the doc stays traceable to 02-CONTEXT"

requirements-completed: [DEP-04]

coverage:
  - id: D1
    description: "Runbook fully manual-deploy section: verify gate -> dev-machine build -> tarball with shipped prisma client -> pg_dump backup -> no-migrate-this-phase -> ship/install/reload -> typed post-deploy checks (curl, pm2 status, pm2 logs), zero GitHub-Actions/deploy.yml/.github-workflows references"
    requirement: DEP-04
    verification:
      - kind: other
        ref: "grep -c 'pnpm verify' docs/DEPLOY-RUNBOOK.md -> 6; grep -ci 'github actions|deploy.yml|.github/workflows' -> 0; grep -c 'pg_dump' -> 6"
        status: pass
    human_judgment: false
  - id: D2
    description: "One-time VPS switch section (§3a): nvm install 24 + alias, corepack enable with standalone-script fallback and the hard 10.34.5 version check, npm node_modules removal, frozen-lockfile install, ecosystem.config.js npm->pnpm edit inside the switch"
    requirement: DEP-04
    verification:
      - kind: other
        ref: "grep counts in docs/DEPLOY-RUNBOOK.md: 'nvm install 24' 1, 'corepack enable' 1, 'pnpm install --frozen-lockfile' 3, 'ecosystem.config.js' 6, '10.34.5' 4"
        status: pass
    human_judgment: false
  - id: D3
    description: "Decision traceability + hygiene gates: all seven decision IDs present, no private IPv4 literals, placeholders-only infra detail, VPS steps POSIX-only"
    requirement: DEP-04
    verification:
      - kind: other
        ref: "for d in D-01 D-02 D-03 D-04 D-05 D-14 D-26 -> ALL_DECISIONS_TRACED; grep -cE private-IP pattern -> 0 (PASS)"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-09-10
status: complete
---

# Phase 2 Plan 4: Deploy-Runbook Manual-Era Amendment Summary

**Runbook rewritten as the operator's only deployment interface: typed manual sequence with the pnpm verify gate, tarball-shipped build outputs, and the one-time VPS Node 24 + pnpm switch — zero workflow-era instructions remain**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-09-10T18:06:14Z
- **Completed:** 2026-09-10T18:09:30Z
- **Tasks:** 3
- **Files modified:** 1 (docs/DEPLOY-RUNBOOK.md, +74/−23 net across three commits)

## Accomplishments
- §3 (interim topology) rewritten as the typed manual sequence: `pnpm verify` gate → dev-machine build + tarball (ships `.next` and `src/generated/prisma`, excludes `.env*`) → `pg_dump` backup (unchanged) → no-schema-command-this-phase (D-05) → ship/extract/`pnpm install --frozen-lockfile --prod`/`pm2 restart` → typed post-deploy checks (curl 200, `pm2 status`, `pm2 logs` glance; no `readyz` until Phase 4)
- §3a added: the one-time VPS switch (D-26) — `nvm install 24` + alias, `corepack enable` with the standalone-script fallback and the hard `pnpm --version` = 10.34.5 check (Pitfall 7), npm `node_modules` removal, frozen-lockfile install, `ecosystem.config.js` npm→pnpm edit as part of the switch with the `pm2 startOrReload` re-read note
- Pre-deploy gate fully documented (D-02/D-20): the five-stage chain, the ≤5-minute warm budget, and the operator-discipline statement — no CI exists to enforce the gate (D-01)
- Every workflow-era claim purged beyond the grep-gated strings: §1 connection table, §2 topology row, §4 build step + "operator/CI gate", §6 interim-check wording, §8 migration discipline (empty-diff check is now operator-run)

## Task Commits

Each task was committed atomically:

1. **Task 1: Manual deployment section replaces deploy.yml mechanics** - `59b629d` (docs)
2. **Task 2: One-time VPS Node/pnpm switch section** - `8f483df` (docs)
3. **Task 3: Verify-gate documentation + decision traceability cross-check** - `c9345c9` (docs)

**Plan metadata:** see final commit below (docs: complete plan)

## Files Created/Modified
- `docs/DEPLOY-RUNBOOK.md` — the manual-era deployment interface: §3 rewrite, §3a addition, gate documentation, CI-era cleanup in §1/§2/§4/§6/§8, §10 example hygiene

## Sections Amended and Where Each Decision Landed

| Decision | Location in docs/DEPLOY-RUNBOOK.md |
|---|---|
| D-01 (no Actions) | header amendment line; §2 table row 3; §3 gate blockquote; §3 step 3 action + secrets note; §8 bullets 2/4 |
| D-02 (verify gate) | §3 gate blockquote (chain + discipline statement); §8 empty-diff bullet |
| D-03 (manual, no tooling) | §3 intro blockquote (assumed tooling: pnpm/ssh-scp/pm2 only) |
| D-04 (typed checks) | §3 step 5 (curl / `pm2 status` / `pm2 logs`, no readyz until Phase 4); §6 interim wording |
| D-05 (no migrate this phase) | §2 table row 3; §3 step 3 action + verification; §8 bullet 2 |
| D-14 (client shipped, no VPS generate) | §3 intro blockquote; §3 step 1 action + tarball contents; §3 step 4 `--prod` rationale; §3a step 3 |
| D-26 (one-time switch, repo-only phase) | §3a header blockquote + all five steps |
| D-20 (≤5 min budget) | §3 gate blockquote |
| D-06 (Node 24 pin) | §3a intro paragraph + step 1 |

## Existing-Runbook Conflicts with the Manual Reframe (and resolution)

1. **§2/§3/§8 claimed the CI `prisma db push` step was still the live interim schema mechanism** — false since 02-01 deleted the workflow. Resolved: Phase 2 now runs no schema command anywhere; production schema stays as the last workflow-driven deploy left it until Phase 3's baseline (the push-with-`--accept-data-loss` hazard explicitly called out as having left the deploy path).
2. **§3 step 1 said "run the CI pipeline: `pnpm install --frozen-lockfile` → lint → …"** — that pipeline no longer exists. Resolved: dev-machine sequence is now `pnpm verify` then `pnpm build` then a typed tar command.
3. **§4 step 1 (Phase 4+ topology) also said "run the CI pipeline"** and §4's intro called `readyz` the "operator/CI gate" — resolved to the same dev-machine gate wording; the future topology now agrees with the manual era.
4. **§8's "Empty-diff CI gate … runs in CI on every release"** — nothing runs in CI. Resolved: the drift check becomes an operator-run typed step from Phase 3 on, enforcement = operator discipline (same stance as D-02).
5. **§1 connection table labelled the migration runner "(deploy pipeline, one-shot)"** — resolved to "(operator-run, one-shot)".

## Decisions Made
- Tarball = repo root minus excludes rather than enumerated includes (see frontmatter key-decisions: correctness by construction for both D-14 outputs and .env exclusion)
- `--prod` added to the VPS install (lean 2 GB VPS; toolchain never installs there)
- ecosystem.config.js edit sequence fixed to "edit extracted VPS copy + identical repo commit inside the switch" (tarball is packed before the edit exists)
- Cleanup went beyond the three grep-gated strings to every "CI pipeline"-class claim (accuracy for a live-VPS doc)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking verification] Pre-existing §10 example tripped the plan's private-IP gate**
- **Found during:** Task 3 (decision traceability cross-check)
- **Issue:** §10's verification step (Phase 1 text, untouched by this plan's scope) contained the literal example `http://10.0.0.1/`; the plan's threat-mitigation gate (`grep -cE "\b(10|172|192)\.[0-9]+\.[0-9]+\.[0-9]+\b" → 0`) applies to the whole file and would have failed
- **Fix:** reworded the example to described ranges (`10.x.x.x`, `172.16.x.x`–`172.31.x.x`, `192.168.x.x`) keeping the link-local metadata canary `169.254.169.254` (not matched by the gate); no information lost — the CIDR denylist is enumerated verbatim one sentence above
- **Files modified:** docs/DEPLOY-RUNBOOK.md (§10 step 1 verification)
- **Verification:** IP-GATE: PASS (0 private IP literals)
- **Committed in:** c9345c9 (Task 3 commit)

**2. [Rule 1 - Accuracy] §3a step 4 sequencing contradiction**
- **Found during:** Task 3 (sanity pass)
- **Issue:** the step said "ship the edited file with this deploy's tarball", but the tarball is packed in §3 step 1 — before the switch edit exists — so the instruction was unexecutable as written
- **Fix:** edit `/var/www/uptime-tracker/ecosystem.config.js` on the already-extracted VPS copy (step 3) and make the identical edit in the repo, committed as part of the switch
- **Files modified:** docs/DEPLOY-RUNBOOK.md (§3a step 4 action)
- **Verification:** re-read of §3a confirms step order (extract → edit → startOrReload) is now internally consistent
- **Committed in:** c9345c9 (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking verification gate, 1 accuracy bug)
**Impact on plan:** both fixes required for the plan's own gates to pass and for the doc to be executable. No scope creep — D-03 honored (zero code, zero tooling, one file amended).

## Issues Encountered
- The plan's grep gate for "no GitHub Actions mention" cannot be satisfied while *naming* what was deleted, so the deletion notes use "the (deleted) deploy workflow" phrasing throughout — content preserved, gate green.

## User Setup Required
None - no external service configuration required. (The §3a switch itself is user-executed documentation by design, D-26 — it is run at the next real deploy, not now.)

## Next Phase Readiness
- DEP-04 documentation side complete: the local gate chain is the documented pre-deploy gate
- Runbook now describes the manual era accurately for every deploy until Phase 4; §4 (target topology) build step cites the same dev-machine gate, so Phase 4 planning inherits a consistent doc
- Reminder for Phase 3 planning: §3 step 3's Phase 3+ branch (single `drizzle-kit migrate` runner + operator-run empty-diff check) is already typed — no runbook work needed there beyond live verification

## Self-Check: PASSED

- 02-04-SUMMARY.md exists on disk
- Task commits 59b629d, 8f483df, c9345c9 present in git log
- docs/DEPLOY-RUNBOOK.md present with all gates green (decisions traced, zero CI-era refs, zero private IP literals)

---
*Phase: 02-foundations-theme-infrastructure*
*Completed: 2026-09-10*
