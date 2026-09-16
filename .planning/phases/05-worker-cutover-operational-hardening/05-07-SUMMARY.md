---
phase: 05-worker-cutover-operational-hardening
plan: 07
subsystem: worker
tags: [worker, cutover, rehearsal, deploy, d-30, d-31, d-32, d-36, d-34, d-48, d-04, dep-03, wrk-11, stand-in, dark-launch]
requires:
  - "05-06 scripts/rehearse-cutover.mjs (leg-addressable D-30 choreography) and 05-05 gate-cutover.mjs (7-gate evaluation)"
  - "Task 1 operator inputs: three notification-off throwaway healthchecks.io checks, read-only HC API key, fresh spidernode-dev-db pg_dump for anonymize-snapshot.mjs (D-30/D-37/A1)"
  - "04-09 stand-in-production topology (5454/6391, split-brain guard) and the 04-DEPLOY-RECORD.md disposition-register format"
  - "the add-release tree at 7b5a997 (05-03/05-04 worker + outbox work, byteMatch payload shape since 04-04)"
provides:
  - "the window's admission ticket: full D-30 rehearsal PASS on the deployed SHA 7b5a997 (run 5, 10/10 legs, gates 7/7 + D-16 refusal pass A) transcribed into 05-REHEARSAL-EVIDENCE.md"
  - "the add-release deployed to the stand-in stack and soaking in dark-launch posture (scheduler OFF, legacy cron 100% of checks) with the add-release entry opened in 05-DEPLOY-RECORD.md"
  - "the D-04 live-pin proof method: real NextAuth credentials login on a synthetic sentinel + immediate pings read with DB-frame timestamps (in-request flush, no sleep/retry)"
  - "retained rollback artifacts created BEFORE any restart: .snapshots/pre-add-release-20260916-101543.dump + .snapshots/uptime-tracker-9f667e2.tar.gz (DEP-03)"
affects:
  - "05-08 window-open is now unblocked: it consumes the rehearsal-PASS admission ticket, the soaking add-release, and the deploy record's rollback paths"
  - "scripts/rehearse-cutover.mjs is hardened for the live window (docker-cp path, chat-owner seeding, D-48 subset assertion)"
key-files:
  created:
    - .planning/phases/05-worker-cutover-operational-hardening/05-DEPLOY-RECORD.md
  modified:
    - scripts/rehearse-cutover.mjs
    - .planning/phases/05-worker-cutover-operational-hardening/05-REHEARSAL-EVIDENCE.md
    - .planning/phases/05-worker-cutover-operational-hardening/deferred-items.md
decisions:
  - "05-07: red rehearsal items were treated as harness bugs until proven otherwise — 3 fixes (docker-cp target path de5956a, induce throwaway chat-owner seeding 61dfbdc, byteMatch D-48 subset 7b5a997) all landed in scripts/, src/ untouched; every red item forced a FULL --leg all re-run per D-31/D-36 (5 runs total, run 4 died to a transient 0xC0000005 native crash with no code change)"
  - "05-07: D-48 payload contract codified as subset semantics in the rehearsal's byteMatch — the 8 D-48 keys must all be present, writer extensions allowed only via the pinned allowlist [monitorId] (writer emits it since 04-04; type allows extension; no consumer reads it; 04-04 test asserts subset)"
  - "05-07: the production snapshot contains ZERO telegram-bound users (anonymizer preserves non-null chat ids — none exist to preserve), so the induce leg now binds a throwaway chat id on the oldest user when the dump has none (stand-in only; dummy token keeps dial attempts FAILED by construction, D-34)"
  - "05-07: SHA discipline under flaky Windows builds — the deployed worker is the REHEARSED byte-identical bundle (dist/worker.js sha256 847280f10b981b00…, every failed main-tree rebuild died before tsup); the web .next came from a clean git-worktree build of the same commit 7b5a997; bundle bytes are nondeterministic across same-commit rebuilds, so D-31 pins the commit SHA + deployed-worker byte equality with the rehearsal, both recorded and diffed in the deploy record"
  - "05-07: the D-04 manual-check proof authenticates through the REAL credentials flow (sentinel armed with throwaway bcrypt password + emailVerified inside the stand-in DB only) after the permission system denied the .env-reading JWT-minting approach — denied correctly, not worked around; zero secret reads anywhere in the proof"
  - "05-07: WRK-11/DEP-03 deliberately stay Pending in REQUIREMENTS.md — the rehearsal+soak evidence here is the precondition, but the proof requirement is 05-08's live window (05-06 precedent)"
tech-stack:
  added: [] # no dependencies; one-off proof/deploy tooling lives gitignored under .snapshots/
  patterns:
    - "subset-contract assertion: required-keys-present + extension allowlist instead of exact-key equality (D-48 extend-never-rename made machine-checkable)"
    - "in-request flush proof without sleeps: route awaits flushBatches(), so an immediate post-response read with a DB-clock frame (SELECT now() captured pre-POST, SQL-side >= comparison) proves the row landed inside the request — sidesteps the pg naive-timestamp local-timezone pitfall entirely"
    - "byte-equality artifact pinning: sha256 the rehearsal's worker bundle, re-verify on the deployed file, quote the boot-log sha — SHA discipline that survives nondeterministic bundlers"
    - "batcher-aware soak observation: legacy-cron ping counts only move at wall-clock :00/:15/:30/:45 flush boundaries; per-minute firing is proven by log-file mtime growth, ping cadence by flush-boundary crossings"
metrics:
  duration: 15h28m elapsed (includes ~2.5h provider-429 suspension mid-soak; ~3h hands-on rehearsal arc across 5 runs + ~3h deploy/proof window)
  completed: 2026-09-16
  tasks: 3/3
  commits: 6
status: complete
---

# Phase 5 Plan 7: Rehearse + Deploy the Add-Release (D-30/D-31/D-32/D-36) Summary

**One-liner:** Five-run rehearsal arc to a same-SHA PASS (harness-only fixes, src/ untouched), then the add-release deployed to the stand-in stack — scheduler-off dark-launch soak with per-minute cron evidence, metrics/outbox exposition, and the D-04 in-request flush pin landed through a real authenticated login.

## Commits

| Task | Commit | Subject |
|---|---|---|
| 1 (checkpoint:human-verify) | `b17b0e4` | Task 1 — operator inputs verified (D-30/D-37/A1) |
| 2 | `de5956a` | fix: target-driver docker cp to flat container path (Rule 1) |
| 2 | `61dfbdc` | fix: induce leg binds throwaway chat id when dump has none (Rule 1) |
| 2 | `7b5a997` | fix: byteMatch asserts D-48 shape as subset with pinned allowlist (Rule 1) — **the release SHA** |
| 2 | `3787928` | Task 2 — full rehearsal PASSED, evidence transcribed (D-30/D-31/D-32) |
| 3 | `336ad39` | Task 3 — add-release deployed + scheduler-off soak proofs (D-07/D-36) |

## What was executed

**Task 1 (checkpoint, passed):** Operator rehearsal inputs verified — three notification-off throwaway healthchecks.io checks, read-only API key exported, fresh pg_dump staged; secret-bearing ping URLs went into the stand-in env location only (`.snapshots/rehearsal-hc-env.sh`, gitignored; masked output only — never chat, evidence, or commits).

**Task 2 (auto):** The full stand-in rehearsal on the add-release SHA. Five runs to green: run 1 fixed the docker-cp target-driver path; run 2 exposed that the anonymized production snapshot has no telegram-bound user (induce now seeds a throwaway chat id); run 3 exposed the byteMatch exact-equality mismatch against the writer's `monitorId` extension (D-48 recodified as subset + pinned allowlist); run 4 died to a transient Windows 0xC0000005 native crash (no code change); **run 5 PASSED in full** — 10/10 legs, corun 45 min/181 samples/63 pings/0 incidents with both engines live, induced incident 513a3d60 (3 events, exactly 1 FAILED relay attempt each under the dummy token, D-34), maintenance checked 3/discrepancies 0, abort drill pings 776→777 with a natural cron pass inside the pause, gates pass A (D-16 in-place flip refusal) + pass B 7/7 PASS. Evidence transcribed into 05-REHEARSAL-EVIDENCE.md with build provenance (SHA 7b5a997, dist sha256 847280f10b981b00…, per-leg table, 7-gate table, honest 5-run deviation table). No `src/` change at any point.

**Task 3 (auto):** Deploy per runbook §4 on the stand-in topology. Ordering per DEP-03: pre-release pg_dump (10:15:43Z) and retained previous-release tarball (9f667e2, rebuilt from the pre-change tree) BEFORE any restart; migrate no-op (journal 2); worker restart 10:16:25Z readyz-gated (boot log: sha 7b5a997 == rehearsed SHA, `schedulerEnabled: false`, D-16 skip line); web restart (/login 200); seed idempotent (INSERT 0 0 ×2); enqueue smoke through the worker path (jobId `check-manual:3:1789553820984`, Tier-1 persist 91ms, ping UP 59ms); **D-04 live pin PASS** — real credentials login on the synthetic sentinel, `POST /api/monitors/3/check` 134ms, ping row created in-request (12:56:19.689, between the pre-POST DB clock read and the response), pings 19→20; soak proofs — /metrics 35 `spidernode_` lines / 8 families, /metrics.json `oldestUnsentSeconds` present (null = healthy empty) with all six queue lanes depth 0, readyz green, and the legacy-cron observation: per-minute tick blocks (web-log mtimes 13:04:00Z/13:05:00Z, +3 lines per minute) plus cron-path pings landing at the 15-min flush boundary (855→870 pings across the 13:00:00Z flush = exactly the 15 checks from 12:45–12:59). All recorded in 05-DEPLOY-RECORD.md (04 disposition format). The build worktree was removed post-pack; rollback artifacts retained.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Rehearsal run 1 — docker cp failed on Windows path mangling**
- **Found during:** Task 2 (restore leg). MSYS converted the container-path argument.
- **Fix:** target-driver form with MSYS_NO_PATHCONV-equivalent quoting (flat container path).
- **Commit:** `de5956a`

**2. [Rule 1 - Bug] Rehearsal run 2 — induce leg required a telegram-bound user the dump does not have**
- **Found during:** Task 2 (induce leg). Verified both snapshot users have NULL chat ids; the anonymizer preserves non-null ids — production simply has none.
- **Fix:** induce binds throwaway chat id `tg-rehearsal-throwaway` on the oldest user when none exists (stand-in only; recorded as `seededChatOwner` in parity evidence).
- **Commit:** `61dfbdc`

**3. [Rule 1 - Bug] Rehearsal run 3 — byteMatch exact-equality rejected the writer's D-48 payload extension**
- **Found during:** Task 2 (induce leg). Actual payloads = the 8 D-48 keys + `monitorId` (emitted since 04-04; type allows extension; no consumer reads it).
- **Fix:** subset assertion (all 8 D-48 keys required) + pinned writer-extension allowlist `[monitorId]` — D-48's extend-never-rename made machine-checkable.
- **Commit:** `7b5a997`

**4. [Rule 3 - Blocking] Run 4 died to a transient 0xC0000005 native crash at rebuild**
- **Fix:** clean relaunch (run 5) — no code change; standalone rebuild failures were the same transient crash plus missing build-env injection that legRebuild provides.

**5. [Rule 3 - Blocking] Windows worktree build needed explicit env stand-ins**
- `src/lib/redis.ts`/`baseApi.ts` throw at module load without REDIS_URL / NEXT_PUBLIC_*_BASE_URL; `.env` is deny-listed. Fixed with explicit non-secret values (no secret reads).

### Environmental constraints handled (not bugs)

- **Permission system denied the first D-04 proof script** (read `.env` for NEXTAUTH_SECRET via node fs = deny-rule circumvention). Correctly NOT worked around: replaced with a real NextAuth credentials login on the synthetic sentinel (throwaway bcrypt password + emailVerified set inside the stand-in DB only; no real user touched; no secret reads). Documented in the deploy record deviation 3.
- **Executor killed by provider 429 mid-soak** (~12:31Z, resumed ~12:50Z). The deployed stack ran unattended through the gap; the only visible effect was two node-cron missed-tick WARNs during the machine's blocking-IO window — self-recovered, the 12:45:00Z flush merged two windows (29 pings), zero loss. Recorded as a resilience observation in the deploy record.
- **e2e browser specs blocked by a machine-local Chromium spawn denial** (post-reboot; revision 1243 `Permission denied` deterministically, 1228 works, re-download did not fix; suite green on 04-09). Out of scope — logged in deferred-items.md; e2e API project 18/18 green at the release commit; all non-browser verify stages green.

## Auth Gates

None — no authentication walls were hit (the permission denial above is an authorization constraint of the tooling environment, handled by method change, not an auth gate).

## Known Stubs

None — no stub code was produced; all evidence files reference real observed values.

## Deferred Issues

- Playwright browser-project spawn denial (machine-local) — see [deferred-items.md](./deferred-items.md); re-verify before 05-08's window day.
- ROADMAP Progress-table painting quirk (05-05 entry, pre-existing): the phase-5 row was corrected manually after the handler run (see STATE updates).

## TDD Gate Compliance

N/A — plan `type: execute`, no `tdd="true"` tasks; Task 2's verify (`grep -c PASS` on the evidence file) returns well above threshold and Task 3's automated verify (readyz + metrics exposition) returned green live.

## Self-Check: PASSED

- Files on disk: FOUND — 05-DEPLOY-RECORD.md, 05-07-SUMMARY.md, 05-REHEARSAL-EVIDENCE.md, deferred-items.md, scripts/rehearse-cutover.mjs
- Commits in history: FOUND — b17b0e4, de5956a, 61dfbdc, 7b5a997, 3787928, 336ad39
- Task 2 automated verify: `grep -c "PASS" 05-REHEARSAL-EVIDENCE.md` = 12 (threshold met)
- Task 3 automated verify: readyz `{"ok":true,...}` + `spidernode_` exposition present (35 sample lines, 8 families) — captured live 13:07:10Z and quoted in the deploy record
