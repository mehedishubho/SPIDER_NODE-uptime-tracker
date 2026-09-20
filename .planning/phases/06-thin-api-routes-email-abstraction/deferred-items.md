# Deferred Items — Phase 06

## Vitest forks-pool worker crash flake (pre-existing, environment-level)

**Found during:** 06-01 plan-level verification (`pnpm test` full suite)

**Symptom:** Intermittently (roughly 1 in 3 runs on this Windows machine) the full
`pnpm test` run exits 1 with:

```
Error: [vitest-pool]: Worker forks emitted error.
Caused by: Error: Worker exited unexpectedly
 ❯ Process.ChildProcess._handle.onexit node:internal/child_process:295:12
```

One test file's tests are reported as never-executed (pending) — the victim varies
between runs (`tests/api/auth-shallow.handler.test.ts` observed once, a 9-test worker
file another time). Every test that actually runs passes; there are zero assertion
faililities. The next run is typically fully green (37/37 files, 316/316 tests).

**Evidence it is NOT caused by 06-01 changes:**
- Reproduced on the pre-plan tree (working tree reverted to the 274c5a8 content of
  all 06-01-touched files, new files removed): 1 failure in 5 runs, identical
  `[vitest-pool]` / `Worker exited unexpectedly` signature, 6 tests pending
  (291/297 passed).
- Victim file varies between failures — not correlated with any 06-01 file.
- All 06-01 suites (check-route 11, check-now-poll 6, rate-limit 12,
  monitors-id 18 tests) pass in every run, including the failing ones.
- Crash site is vitest's forks-pool child-process machinery (`cli-api.js`
  `emitUnexpectedExit`), not any project code.

**Scope decision:** Out of scope for 06-01 (pre-existing infrastructure flake, not
directly caused by the plan's changes — no auto-fix per executor scope boundary).
Candidate follow-ups if it interferes with CI gates: retry-once wrapper in CI, pin
`poolOptions.forks.execArgv` / isolate the flaky fork, or upgrade vitest when a fix
lands. Re-raise with the platform owner if it blocks the Phase 06 release gate.
