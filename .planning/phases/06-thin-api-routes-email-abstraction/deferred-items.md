# Deferred Items — Phase 06

## Open operator confirmations riding into 06-05 Task 1 (from the 06-04 approval)

**Found during:** 06-04 Task 3 continuation (approval recorded 2026-09-20T20:00Z)

The operator's bare "approved" closed the release approval (D-30) but did not restate
the two §7 confirmations. Repo-side verification found **no contradicting evidence**
for either (full disposition in 06-DEPLOY-RECORD.md §8); the residuals MUST be closed
at the 06-05 Task 1 blocking checkpoint, before the deletion release:

1. **A3 answer** — production Telegram webhook registration state (the 06-05 frontmatter
   `user_setup` expected it "captured at the 06-04 checkpoint"; it was not). The
   setWebhook-with-secret step inside the 06-05 cutover is behavior-identical either
   way, but the answer belongs in the deploy record.
2. **Vercel-cron dashboard confirmation** — no live Vercel cron calls `/api/cron/*`
   (repo shows the config was removed in `56b2155`, 2026-08-06; dashboard state is not
   repo-verifiable). The deletion release (06-05 Task 2) breaks silently if a stray
   external cron survives.


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

## BoundPool error-listener warning during auth handler tests (test-only)

**Found during:** 06-02 plan-level verification (`tests/api/auth-shallow.handler.test.ts`)

**Symptom:** After 06-02, the auth handler file logs:

```
(node) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 error listeners added to [BoundPool]. MaxListeners is 10.
```

**Cause:** The register/forgot routes now import `@/lib/email/enqueue` ->
`@/worker/queues` -> `./breaker`/`./db`. `workerPgPool` is globalThis-cached, but
each `vi.resetModules()` case re-evaluates the importing module and attaches a
fresh `error` listener to the SAME cached pool — 13 cases cross the 10-listener
default within one file run. Production evaluates these modules exactly once, so
the warning cannot fire there; tests stay green (13/13).

**Scope decision:** Out of scope for 06-02 (warning-only, test-run artifact of the
pre-existing globalThis-singleton + resetModules discipline). Candidate follow-up:
a one-time listener guard or `setMaxListeners` in `src/worker/db.ts` when the test
suite grows further.

## 06-01 queue-producer latent: never-connected Redis hang instead of 503

**Found during:** 06-04 Task 3 rehearsal (leg-a first run diagnosis)

**Symptom:** The API-01 check-now route's pre-flight ping (`src/app/api/monitors/[id]/check/route.ts`
→ queue producer) can **hang indefinitely** against a never-connectable Redis instead
of failing fast with the designed 503. The 202 contract's failure path is only
exercised when Redis actively refuses; a silently unreachable endpoint (firewall drop)
leaves the route suspended. Rehearsal evidence path: the worker's breaker covers the
consumer side, but the producer side has no deadline of its own.

**Scope decision:** Out of scope for 06-04 (pre-existing 06-01 shape; the rehearsal
could not reproduce a 503 without breaking Redis in an active-refuse mode, and changing
queue-producer deadline semantics is a design change, not a bug fix). Candidate
follow-up: wrap the producer enqueue/ping in a short deadline (e.g. 2–3s) → 503;
candidate plan: next hardening phase or 06-05 follow-up.

**RESOLVED (06-06 gap closure, 2026-09-30):** fixed by the 06-06 gap 2 closure —
`PRODUCER_DEADLINE_MS = 3000` backstop in `src/lib/queue-producer.ts`
(`withProducerDeadline` races every web-side producer await; the recorded 2–3s
candidate realized at 3s, above the 1s connect + 1s command budget so the
fast-rejection path stays primary). Wraps at the three web-side await sites:
the producer set's `ping()`, the check-route `enqueueManualCheck` call, and the
email door's `queue.add` in `src/lib/email/enqueue.ts` (Better Auth
verification/reset hooks bounded through the door). Pins:
`tests/lib/queue-producer-deadline.test.ts` (pass-through, fake-timer hang
modes, custom-ms, email-door hang) + the check-route hang pin in
`tests/api/check-route.handler.test.ts` (never-settling enqueue → the fixed 503
by the deadline, with the gap-1 compensating restore also firing on the
deadline path). Deferred-items item 3 closed; the forks-pool flake, IN-01 9090
collision, and the other items below remain as recorded.

## Machine-local `.env` NEXT_PUBLIC drift (operator action)

**Found during:** 06-04 pre-flight (`pnpm verify` build leg failed at prerender)

**Symptom:** This machine's `.env` lost its `NEXT_PUBLIC_BASE_URL` /
`NEXT_PUBLIC_DEV_BASE_URL` entries, so `next build` crashed at module-load of
`src/redux/api/baseApi.ts`. The rehearsal worked around it with build-shell-only
overrides (see 06-DEPLOY-RECORD.md §2-D1); **no repo file was changed** and the
production VPS `.env` is unaffected. The last full `pnpm verify` before 06-04 was
05-09 — 06-01..06-03 ran narrower gates, which is how the drift went unnoticed.

**Operator action:** restore the two NEXT_PUBLIC entries in the local `.env`.
**Process follow-up (see item 4):** run full `pnpm verify` per phase gate.

## Manual check-now on an already-UP monitor does not advance `lastChecked`

**Found during:** 06-04 leg (a), first run (documented, working-as-designed)

**Behavior:** `POST /api/monitors/[id]/check` on a monitor whose status equals the
check result (UP→UP) inserts the evidence ping but the Tier-1 dedup guard
(`src/worker/persist/tier1.ts`, `AND status <> targetStatus`) leaves `lastChecked`
and counters untouched (DAT-04). A user clicking "Check now" on a healthy monitor
sees the spinner resolve without the "last checked" stamp moving (D-04 quiet handoff
covers the UX pause, not the stamp).

**Scope decision:** Correct per the pinned DAT-04 semantics — recorded as a product
observation for the operator/planner, not a defect. Candidate follow-up: decide
whether manual checks should bypass the dedup guard for `lastChecked` only.

## Full `pnpm verify` gap across 06-01..06-03 executions

**Found during:** 06-04 pre-flight

**Symptom:** Plans 06-01..06-03 each ran their own plan-level suites, but the full
`pnpm verify` chain (including the build leg and e2e) did not run between 05-09 and
06-04. The drift compound effect: machine `.env` rot went unseen (item above) and the
stale e2e fixture (`created.test.example.com`) survived two plans until 06-04's hard
pre-condition forced a full run (fixed in `31a56df`).

**Process follow-up:** executors should run the full `pnpm verify` as the phase-gate
pre-condition whenever a plan's verification section names it — and planners should
keep naming it at least once per phase.

## e2e fixtures must respect the 06-03 DNS-only admission contract

**Found during:** 06-04 e2e run 1 (16/18)

**Rule going forward:** e2e create-monitor fixtures must use **resolvable** hosts
(e.g. `https://example.com/`), because 06-03 admission (`assertUrlAllowed`) is
fail-closed on NXDOMAIN by design and returns 400 before the create. `.test.example.com`-
style synthetic hosts belong only in unit tests that mock the DNS probe.

## IN-01 test binds the real default port 9090 — collides with any live worker

**Found during:** Wave-3 post-merge test gate (orchestrator run, post-06-04 cutover
continuation)

**Symptom:** `tests/worker/health.test.ts` — "startHealthServer with
WORKER_HEALTH_PORT set to the EMPTY STRING binds 9090" fails with
`EADDRINUSE 127.0.0.1:9090` whenever a worker is running locally. The D-31 soak
posture (worker pid on release `31a56df`, health server on 9090) now occupies the
port for the soak window's duration, so full-suite runs fail this one test while
the soak worker is up (379/380 passed; zero assertion regressions).

**Fix direction:** keep the unit-level pin (`resolveWorkerHealthPort("") === 9090`)
and make the bind-path test port-configurable (or skip-with-reason when 9090 is
held by a healthy `/readyz` responder), so the suite is green on machines running
the steady-posture worker.

**Decision:** wave gate continued per operator choice — environmental, soak worker
intentionally untouched. Suite was fully green in every executor run while the
port was free (06-02: 40/355+; 06-03: 40/376; 06-04 pre-flight resilience 7/7).

**06-05 Task 2 occurrence:** full-verify run on the deletion tree saw the same
single failure (379/380, `EADDRINUSE 127.0.0.1:9090`, zero assertion
regressions); deferral disposition unchanged. All other verify legs green —
including the extended D-41/D-27 remnant gate (441 files) and e2e 18/18. The
gate re-checks for real once the soak worker retires at the Task 3 deletion
deploy (worker restart frees 9090).

**Related resilience flake occurrence (same window):** the 06-05 Task 2
`pnpm test:resilience` run lost 1/7 (`redis-down`) to a native worker-child
crash before readyz (`code=3221226505` = 0xC0000409 fail-fast; output tail
empty). Same machine-native-crash class as the forks-pool flake above and the
documented 0xC0000005 Turbopack build transient; the harness assigns a free
health port (`freePort()`), so this is NOT the 9090 collision, and six sibling
cases booted the identical fresh bundle green. Single retry: GREEN (7/7 across
the two runs).

## Boot-time env checklist / healthz required-by-feature posture field (DEFERRED)

**Found during:** 06-07 (G-06-7 closure, 2026-09-30)

**Item:** 06-UAT G-06-7 missing-item 2 — the optional hardening: a boot-time env
checklist (or a healthz `required-by-feature` posture field) listing the env keys each
feature requires, so an omitted secret (the G-06-7 class: a launch env contract missing
`TELEGRAM_WEBHOOK_SECRET`) is visible without a probe.

**Status: DEFERRED to the backlog — deliberately not built in 06-07.**

**Rationale:** it would extend the 07-05-owned healthz/readyz surface and needs its own
design pass — which keys are required-by-feature (and for whom: operator vs CI vs
readiness semantics), and whether a missing optional-by-deployment key (this topology
runs `EMAIL_PROVIDER=console`, stand-in OAuth creds) should report `posture` rather than
flip readiness. Conflating that with the gap closure would change a pinned health
surface without its design gate.

**What shipped instead (the non-speculative pieces):** the tracked ladder probe
`scripts/probe-telegram-webhook-ladder.mjs` (default 401/401/429 + `--baseline`
500/500/429 RED instrument, never reads the secret) and the runbook §9 env-contract
omission lesson naming the 0707 contract's missing key. The deferral is a forward-tracked
backlog input, NOT a closure of this item.
