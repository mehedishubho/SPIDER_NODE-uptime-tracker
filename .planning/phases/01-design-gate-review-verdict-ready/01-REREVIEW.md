# Phase 01 Plan 05 — Adversarial Re-Review Report

> **Date:** 2026-09-09
> **Reviewer:** Separate GSD executor session spawned for plan 01-05 (wave 5) via `/gsd-execute-phase`. Agent: `gsd-executor` (Claude Code agent runtime); model powering this session: **GLM-5.3** (configured executor profile `adaptive`/`gpt-5.4` — actual runtime model recorded here for accuracy).
> **Independence attestation (D-15):** This session did **not** author any part of the design addenda. Plans 01-01…01-04 were executed by earlier, distinct executor sessions (commits `a21aa8c`, `7c086ac`, `b9b6166`, and predecessors predate this session; verified via `git log`). This task was verify-and-report only: `docs/ARCHITECTURE-AUDIT.md` and `docs/DEPLOY-RUNBOOK.md` were treated as read-only (byte-identity confirmed before and after this review — SHA-256 recorded in §1).
> **Scope:** the amended design — `docs/ARCHITECTURE-AUDIT.md` (11 amendment markers, §11/§12/§13/§14/§15/§16/§22/§23/§25 + header note), `docs/DEPLOY-RUNBOOK.md` — checked against `docs/ARCHITECTURE-REVIEW.md` §9 (pre-implementation checklist) and §10 (re-review criteria), with the six D-17 failure-scenario walkthroughs re-run per review §3.1's method.
> **Inputs:** full reads of all three documents above plus 01-CONTEXT.md (D-15/D-16/D-17/D-18), 01-RESEARCH.md (Pitfalls 1–8, Open Question 1), 01-PATTERNS.md. 01-04-SUMMARY.md was read for orientation only; **every check below was re-derived in this session, not trusted** from the author's self-check.

---

## 1. Verification method (what was re-run, not trusted)

| Check | Command (re-run here) | Result |
|---|---|---|
| §9 item traceability | `for id in J-1 … P-1: grep -q "$id" docs/ARCHITECTURE-AUDIT.md docs/DEPLOY-RUNBOOK.md \|\| echo MISSING` | **Empty output — all 25 IDs found** (matches, independently reproduced, the author-side claim) |
| Author's stale sweep | `grep -nE "falls back to writing routine pings\|alert:sent:\|interval \+ slack\|repeatable" docs/ARCHITECTURE-AUDIT.md` | **Zero matches** — the six enumerated stale strings are gone |
| Extended contradiction sweep (this reviewer's own) | `grep -nE "uptime recompute\|recompute-uptime\|fallback\|spike\|scheduledAt"` + manual full-read cross-checking | **4 findings** (RR-02, RR-03, RR-04 below; see §6) |
| S-1 layer-1 presence | `grep -niE "egress\|iptables\|firewall\|network.level\|OS.level"` over audit + runbook, then filtering out `regress(ion)` substring false positives | **No genuine match** — the OS/network egress layer is absent (RR-01) |
| §8 addendum coverage | marker grep + full read | 11 `Amended/Added 2026-09-09` markers; all 8 addendum topics have a home (§3, criterion 1) |
| D-10 parameter cells | full-read audit of §11 / §13.10 / §14.1 / §14.5 / §15.3 / §25.4 / runbook §5 tables | **No empty cells** — every cell carries a value + rationale + class; "none — <reason>" rate-limit cells are pinned decisions, not omissions |
| Read-only compliance | SHA-256 before/after: audit `5597003b…`, runbook `790655cf…` | Byte-identical at report commit time |

---

## 2. §9 checklist — per-item results

Locations are section + the amendment marker line (audit line numbers from this session's read). "Judgment" is this reviewer's independent assessment that the design decision **actually resolves the issue**, not a marker echo.

| §9 ID | Verified location(s) | Independent judgment |
|---|---|---|
| **J-1** claim scheduling + `next_check_at`; idem keys redefined | §11 `monitors.next_check_at` DDL + `idx_monitors_due` partial index (marker L299); §14.2 steps 2–3; §14.3 claim SQL (marker L686); §14.5 tick 30 s non-negotiable | **Resolves.** The claim advances `next_check_at` inside the selecting transaction; `FOR UPDATE SKIP LOCKED` sits inside the CTE with a load-bearing comment citing the PostgreSQL WITH-query locking rule (the exact Pitfall-4 trap); idempotency key is now `check:{monitorId}:{epoch-of-claim}` — unique per schedule slot *and* per tick, replacing the rejected `{scheduledAt}` token (grep: zero `scheduledAt` survivors); tick 30 s ≤ ½ the 1-minute minimum interval; monitor-deletion no-op is §15.1 step 1's execution-time re-read. |
| **J-2** transactional write guards; flush SQL per D-5 | §11 `write_guards` DDL (L299 marker); §16.2 guarded flush (L854 marker) | **Resolves.** Guard insert and delta apply share one transaction; the spec explicitly states a Redis-side guard alone is insufficient. Flush UPDATE is additive counters + `GREATEST`/`CASE` monotonicity, never `status`, with the verified NULL-semantics note (no `COALESCE` "fix"). |
| **J-3** lock spec (TTL, renewal, owner-release, lock-loss abort, stalled config) | §15.1 steps 2–3 and 7 (L783 marker); §13.1 lock key row; §14.1 stalled cells; §15.1 stall hygiene; runbook §5 `kill_timeout` 20000 | **Resolves.** TTL 15 s = 10 s timeout + 5 s margin (formula marked non-negotiable), renewal every TTL/3 via owner compare-and-expire, Lua owner-only release, abort-on-renewal-failure with result discard, and the required explicit statement that the lock is a performance guard with correctness resting on J-1/J-2/D-1. Graceful close + PM2 `kill_timeout ≥ 20 s` cover deploy-manufactured stalls. |
| **J-4** result-vs-error classification + tests | §15.1 step 5 (L783 marker); §23 TC-CLASSIFY-TIMEOUT-01 / TC-CLASSIFY-DNS-01 / TC-CLASSIFY-INFRA-01 | **Resolves.** Target outcomes (UP, DOWN, timeout, DNS, TLS failure) are typed successful-job results; only infra failures throw and retry. The three given/when/then cases pin queue success/retry behavior and DB effects. |
| **J-5** circuit breaker + backlog cap + DLQ policy | §13.3 breaker (L562 marker); §13.4 + §14.2 step 4 backlog gate; §13.5 DLQ; §13.10 pins | **Resolves.** Three-state breaker with 5-consecutive-infra threshold, 60 s OPEN pausing enqueue + `Queue.pause()` on the two queues (heartbeat explicitly never paused), synthetic `breaker:probe:{ts}` write_guards probe, routine-only backlog shedding at ~2× active monitors with transitions non-droppable by construction (synchronous inside check jobs), bounded attempts + `removeOnFail {age: 604800}` worded as best-effort per the verified BullMQ lazy-eviction semantics. |
| **J-6** transition priority policy documented | §14.1 priority column on **all nine lanes** + the "why every lane carries an explicit priority" paragraph + lane-assignment and worst-case-latency paragraphs (L686 marker) | **Resolves** — and the design goes beyond the checklist: it encodes the verified BullMQ inversion (default priority 0 = no priority, and non-prioritized jobs run *before* prioritized ones), assigns non-UP monitors priority 1 with the J-6 rationale, and documents the bounded worst case `(priority-1 depth × 10 s) / 10`. |
| **D-1** conditional transition UPDATE + partial unique index + tests | §16.1 step 2 + step 3a `ON CONFLICT … WHERE status='ONGOING'` (L854 marker); §11 `incidents_one_ongoing` with exact predicate + inference caveat (L299 marker); §23 TC-DUP-INCIDENT-01 | **Resolves.** Conditional UPDATE gates incident creation and carries the counters (duplicates count once); the partial unique index pins the one-ONGOING invariant physically, with the index_predicate/CREATE-INDEX-format matching requirement and the CONCURRENTLY migration-window caveat recorded. |
| **D-2** outbox table + relay | §11 `outbox` DDL + `idx_outbox_unsent` (L299 marker); §16.1 step 4; §16.3 relay SQL (L854 marker) | **Resolves.** Outbox row inserted inside the Tier 1 transaction (crash-between-commit-and-enqueue made impossible by construction); relay uses `FOR UPDATE SKIP LOCKED`, batch 100, `sent_at` set exactly once, `attempts` crash-counter. |
| **D-3** ID generation decided | §11 ID-generation subsection (L299 marker): DB-side `gen_random_uuid()::text` pinned; bulk inserts never bind NULL/undefined; Phase 4 assertion (DAT-07) | **Resolves at design level.** The decision and its Drizzle-column transcription contract are pinned; the actual column defaults land in the Phase 3 baseline — the same D-05/DRZ-01 reading recorded for §10 criterion 2 (§3 below). |
| **D-4** incident-keyed alert dedup | §16.4 (L854 marker); §13.1 `alert:{incidentId}:{direction}` key row | **Resolves.** Keyed to the incident event (not monitor state), `SET NX EX 86400` only after confirmed send, check-before-retry, ≤ 3 attempts, residual at-least-once duplicates documented as accepted. |
| **D-6** uptime semantics (Q-1) recorded | §16.5 locked decision (L854 marker); §14.1 "Deliberately absent jobs" names `recompute-uptime` | **Resolves** — lifetime counters remain displayed; windowed uptime flagged to Phase 8 (DAT-11). **But** a contradictory fragment survives in §15's file tree (`maintenance.ts # cleanup, uptime recompute`, audit L797) — see RR-02. |
| **D-7** batched retention deletes | §13.7 looped `DELETE … LIMIT 5000` in the maintenance queue only, dry-run mandatory (L562 marker); §11 parameter row 5000 | **Resolves.** Loop-until-under-batch semantics, maintenance-queue-only constraint, dry-run mode pinned. |
| **D-8** connection budget documented | §25 (Added marker L1252): per-process max 10/20/1, POOLED vs DIRECT, `connectionTimeoutMillis` 10000 pinned against the dangerous default 0, statement/idle timeouts, migration-runner timeout unset, single-pool ORM transition rule, A4 assumption flagged | **Resolves.** Minor observation only: the review prose's "monitor `pg_stat_activity`" is not restated (OBS-06) — the checklist item itself ("budget documented") is fully met. |
| **R-1** Redis hardening, heartbeat migration, staleness UI | §13.2 pause-by-design with heartbeat + staleness as hard requirement + web 503 (L562 marker); §13.8 AOF everysec, `noeviction` + 70 % alert, two connections, `maxRetriesPerRequest: null`, no `keyPrefix`, supervised restart; §13.6 recovery procedure | **Resolves.** The incoherent fallback sentence is gone (grep-verified); detection, in-product staleness, hardening, and the five-step recovery procedure are all specified. |
| **A-1** bcrypt config + canary gate | §12.2 (L434 marker): hash-prefix routing `$2a$/$2b$/$2y$` → bcrypt, `hash` always modern default; canary ordering snapshot → production → flip, non-negotiable; lazy rehash (AUTH-09) | **Resolves.** Specified as a gate with a failed-production-canary abort. **But** the word "spike" survives in §12's own constraints bullet (L453) and in §20 M2 / §24 step 7 — see RR-04. |
| **A-2** cookieCache decision | §12.3 (L434 marker): server sessions + cookieCache TTL 5 min, `disableCookieCache` on sensitive endpoints, DB fallback, revocation latency bounded | **Resolves.** |
| **A-3** adapter mapped to existing `users`; roles for S-3 | §12.1 field-map tables bound to the existing `users` table — no renames, ids preserved verbatim; `role` column via admin plugin; `account`/`session`/`verification` shapes from the verified Better Auth 1.7 core schema; FK schema-key warning (#8111); `generateId` defers to the DB default | **Resolves.** Known-unknowns carry the D-09 `confirm by Phase 7 dry-run` marker (`providerId` casing; two pg_dump-verify cells) rather than being silently assumed. |
| **S-1** SSRF layers + tests | §15.1 step 4 sub-steps 1–5 (L783 marker): scheme allowlist pre-I/O, resolve-then-validate all A/AAAA records against the full denylist, connection-time re-validation (DNS-rebinding countermeasure), per-hop redirect re-validation ≤ 5, 2 MB cap inside the 10 s budget; §23 TC-SSRF-REDIRECT-PRIVATE-01 / TC-SSRF-DNS-REBIND-01 / TC-SSRF-SCHEME-01 / TC-SSRF-SIZE-CAP-01 | **Partial — gap found.** Engine enforcement, caps, and tests are present and strong. **The network-egress layer is absent**: review S-1 layer 1 ("Egress control at the OS/network level on the worker host: deny private ranges …, allow only 80/443 egress") appears nowhere in the audit or runbook (grep over `egress|iptables|firewall|network-level|OS-level` yields only `regression`-substring false positives). The §9 item text itself names "network egress" first among the layers. → **RR-01**. |
| **S-2** Telegram webhook secret_token | §12.5 (L434 marker): `secret_token` charset/length constraints, `X-Telegram-Bot-Api-Secret-Token` validated by constant-time compare before payload access | **Resolves** (decision note; implementation Phase 6 as the research mapping prescribes). |
| **S-3** admin gating + per-user check limiter | §12.4 (L434 marker): admin plugin `role`; feedback listing admin-only (fixes R17); Bull Board admin + IP allowlist; D-13 limiter 1/monitor/30 s + 6/min/user enforced at the API before enqueue | **Resolves.** Observation: §13.1's limiter cell says `INCR + EXPIRE` without pinning atomicity (review prose asked for atomic Lua `INCR`+`EXPIRE NX` or sliding window) — OBS-04, non-blocking (the checklist item's substance is present). |
| **S-4** repo hygiene | §22 item 8 (L1125 marker); runbook §9: ngrok removal, `.env.example`, no stack traces, no-secrets-in-query design rule, CRON_SECRET retirement path (Phase 2 FND-07 → Phase 5 deletion) | **Resolves.** |
| **M-1** single migration runner | §22 item 3 (L1125 marker); runbook §8: versioned SQL files sole authority, migrations never at boot, `prisma db push` deleted from CI in the same PR as the baseline | **Resolves.** |
| **M-2** expand/contract rule | §22 item 7 (L1125 marker); runbook §7: additive-only verification windows, `CONCURRENTLY` indexes, drops deferred one release, documented down-path before destructive releases, `readyz` + smoke as the release gate | **Resolves.** |
| **M-3** empty-diff CI gate | §11 baseline rule (L299 marker); runbook §8: baseline authored from `pg_dump --schema-only`, empty `drizzle-kit` diff (or reviewed intentional delta) before cutover, gate runs in CI every release | **Resolves.** |
| **P-1** deploy runbook | `docs/DEPLOY-RUNBOOK.md` §3/§4 (both topologies; migrate → worker restart → `readyz` gate → web restart → smoke), §5 PM2 checklist (`kill_timeout` 20000 non-negotiable floor), §6 normative synthetic-check smoke; §22 pointer paragraph (L1125 marker) | **Resolves.** Operator audience holds: every step is Action/Verification/Rollback (11/11 triples — re-counted this session); docker-compose/Testcontainers for the §23 suites appears in §23's stack line as P-1 required. |

---

## 3. §10 re-review criteria — per-criterion results

| §10 criterion | Result | Evidence |
|---|---|---|
| **(1) Every §9 checklist item incorporated into the design documents** | **Incorporated — 25/25 items trace to resolving design decisions** (§2 table); all 8 §8 addenda have homes: schema §11, scheduler §14, check job §15, writers §16, resilience §13, auth §12, connection budget §25, runbook = `DEPLOY-RUNBOOK.md` + §22 pointer; 11 markers, header note covers both marker forms. **Caveat:** incorporation is not yet *contradiction-free* — three residual fragments inside amended sections contradict the incorporating text (RR-02, RR-03, RR-04), and one checklist item (S-1) is missing its first named layer (RR-01). |
| **(2) Schema addenda reflected in the target Drizzle schema** | **Satisfied under the recorded interpretation below.** |
| **(3) SSRF and duplicate-incident/duplicate-alert test cases in §23** | **Present** — TC-SSRF-REDIRECT-PRIVATE-01, TC-SSRF-DNS-REBIND-01, TC-SSRF-SCHEME-01, TC-SSRF-SIZE-CAP-01, TC-CLASSIFY-TIMEOUT/DNS/INFRA-01, TC-DUP-INCIDENT-01, TC-DUP-ALERT-01, plus TC-FLUSH-GUARD-01 and TC-MONOTONIC-01; all given/when/then with concrete DB/Redis/queue/network effects. **Caveat:** §23 item 5's own prose still names a "Redis-down fallback write" test — a mechanism §13.2 forbids (RR-03). |

**Criterion 2 interpretation — recorded explicitly (per research Open Question 1, D-05/DRZ-01):**

> §10 criterion (2) reads *"the schema addenda are reflected in the target Drizzle schema."* Decision **D-05** (phase CONTEXT.md) deliberately forbids authoring full Drizzle table code in Phase 1 because it would pre-empt the Phase 3 live-DDL baseline (**DRZ-01**: production was built with `prisma db push`; live DDL may drift from `schema.prisma` — audit M-6). §10 was written before that decision. This re-review therefore reads criterion (2) as: **the DDL-precise §11 sketch (every new/changed object at column/type/default/nullability/index precision, including the exact partial-index predicate, `write_guards`/`outbox` columns, and pinned ID-generation defaults) plus the Phase 3 transcription contract (baseline authored from live `pg_dump --schema-only`, empty `drizzle-kit` diff proven, only then transcribed — audit §11 baseline rule and runbook §8) together satisfy "reflected in the target Drizzle schema."** Under this reading the criterion is met: §11 specifies the addenda at transcription-ready precision, the two subtle-semantics Drizzle fragments (partial unique index, claim index) are authored, existing-column types carry verify-against-live-DDL markers instead of false certainty, and M-3's empty-diff CI gate makes post-transcription reflection *provable* rather than asserted. The reading is recorded here so the ratifier decides on it explicitly rather than by implication.

---

## 4. Failure-scenario walkthroughs (D-17 — six transcripts, §3.1 method)

Method per review §2/§3.1: adversarial step-through of the amended design, hunting for the state where two mechanisms interact badly. Summary first, transcripts after.

| # | Scenario | Observable end state | Undefined behavior found | Result |
|---|---|---|---|---|
| W1 | Redis restart mid-operation | Postgres consistent throughout; monitoring resumes ≤ ~60–90 s; duplicates absorbed by guards | Scheduler re-upsert is worker-boot-triggered (AOF covers Redis-only restarts) — OBS-02 | Defined |
| W2 | Postgres down during checks | Zero partial writes; queues paused; heartbeat `/fail` pages; alerts for committed events still deliver; recovery via probe | DLQ manual-retry of a dead-lettered flush job could double-apply — OBS-01 | Defined |
| W3 | Duplicate check-job delivery | One ONGOING incident, one outbox row, one alert, counters +1, two evidence pings (documented) | Routine (Tier 2) duplicate in the lock-expiry race ± 1 sample — OBS-03 | Defined |
| W4 | Worker SIGKILL past kill_timeout, then restarted | Open transactions roll back; stall detection re-runs in-flight jobs; missed checks bounded to the in-flight claimed set; release gated on `readyz` + smoke | Same ±1 routine-sample class as W3 | Defined |
| W5 | Per-monitor lock loss mid-check | Abort path leaves no writes; new owner's execution is the recorded one; persist-window overlap gated by the conditional UPDATE | None beyond W3's race class | Defined |
| W6 | Auth cutover day (credentials + social user) | Both user classes log in again; monitor data untouched; rollback window open for one release | `providerId` casing is the marked D-09 known-unknown (Phase 7 dry-run — by design) | Defined |

### Walkthrough W1 — Redis restart mid-operation

Setup: worker mid-flight on check jobs; Redis process dies and is restarted by the supervisor (§13.8).

1. Detection — worker ioredis clients error; worker `:9090/readyz` Redis ping fails (§15 health surfaces). No data was mid-write to Postgres at this instant unless a Tier 1 transaction was open — if so, it commits or rolls back on its own Postgres connection, independent of Redis.
2. Monitoring pauses by design (§13.2): with BullMQ as orchestrator, no Redis = no jobs; nothing is half-written ("transitions that cannot be recorded are not half-recorded").
3. Web behavior (§13.2 item 4): dashboards serve cache-miss rebuilds from Postgres; manual-check enqueue fails loudly with 503; the status page shows "last checked Xm ago" staleness degradation (RES-03 requirement).
4. In-flight jobs: their BullMQ job locks expire (`lockDuration` 30 s); `stalledInterval` 30000 / `maxStalledCount` 1 (§13.6 step 3, §14.1) move them back to `wait` after restart — re-run at-least-once.
5. Re-run absorption: Tier 1 duplicates are near-no-ops (conditional UPDATE + `incidents_one_ongoing` — TC-DUP-INCIDENT-01); Tier 2 flush re-application exits on the `write_guards` 0-row check (TC-FLUSH-GUARD-01).
6. Scheduler continuity: Job Scheduler keys persist via AOF `everysec` (≤ 1 s tail loss); schedulers are re-upserted idempotently at every worker boot (§13.6 step 1).
7. The tick resumes; claims are safe because `next_check_at` was advanced at selection (J-1) — no en-masse re-claim storm (§13.6 step 4).

**End state:** Postgres row state identical to pre-restart except at-least-once duplicates already absorbed by the §16 writers; monitoring cadence resumes within one stall interval + tick period. **UB found (recorded, not undefined):** if AOF loss ever extended to scheduler state (or the dataset were lost wholesale) *without* a worker restart, re-declaration waits for the next worker boot — the pause remains detected via the heartbeat gap and the operator restarts the worker. See OBS-02 for the recommended Phase 4 hardening (reconnect re-upsert hook).

### Walkthrough W2 — Postgres down during checks

1. Check jobs mid-flight fetch successfully (target reachable — independent of PG), classify, then hit persist: Tier 1 transaction or Tier 2 flush errors → **infra-failure throw** per §15.1 step 5 (only infra failures throw) → BullMQ retry, attempts 3, exponential from 5 s.
2. Every Postgres operation reports to the breaker (§13.3): after **5 consecutive infra-failures** → **OPEN**: the tick's enqueue steps (§14.2 steps 3–4) pause and `Queue.pause()` halts `monitor-checks` + `db-writes`; in-flight jobs finish their bounded attempts and dead-letter into BullMQ `failed` (≥ ~7 d best-effort, §13.5). The healthchecks.io heartbeat **keeps firing** — a PG outage stays distinguishable from a Redis outage or dead worker.
3. The tick itself fails at the claim (§14.3 errors in §14.2 step 2) → abort tick, ping `HC_PING_URL/fail` (§14.4 row 2) → operator paged on the gap.
4. Alert lane (not paused): already-enqueued alert jobs deliver — Telegram send + Redis dedup require no Postgres. The relay (`db-writes` lane) is paused, so new outbox rows wait with `sent_at IS NULL`; outbox-age alerting (OBS-03 reference in §13.5) is their detection path.
5. Tier 2 buffers: flush jobs fail as infra; the Redis hash is **not** deleted (delete only after COMMIT — §16.2), so deltas are retained; the buffer cannot grow unboundedly because no new checks run while the queues are paused (§16 invariant 4) — the J-5 storm spiral is broken.
6. Recovery: after 60 s OPEN → HALF_OPEN probe `INSERT INTO write_guards(key) VALUES ('breaker:probe:{ts}') ON CONFLICT DO NOTHING` (§13.3, §11 key reservation) → success → CLOSED, `Queue.resume()`, counter reset. The next tick claims normally; monitors whose jobs dead-lettered during the outage are re-claimed at their next due slots (claims were advanced at selection — J-1's accepted consequence).

**End state:** no partial writes survive anywhere (Tier 1 atomicity — TC-CLASSIFY-INFRA-01's Then); counters move only for committed results; every committed event eventually alerts; Redis memory stays bounded; the outage window is visible as heartbeat `/fail`s, DLQ counts, and outbox age. **UB found (recorded):** a dead-lettered flush job that never committed, whose buffer was later flushed by a subsequent pass under a *different* `batchId`, would double-apply its stale deltas if an operator manually retried it — the `write_guards` key is per-batch and was never inserted. Automatic recovery does not take this path; see OBS-01.

### Walkthrough W3 — Duplicate check-job delivery

Setup: monitor 42 `status='UP'`, `is_active=true`; job `check:42:{epoch}` delivered twice (stall recovery after a slow first executor).

1. Executor A passes step 1 re-read (row present, active), acquires `lock:check:42` (`SET NX PX`, §15.1 step 2), arms renewal (step 3).
2. Executor B (redelivered job) reaches step 2: `NX` fails while A holds the lock → **B completes successfully without executing** (§15.1 step 2). Single execution — the common case.
3. Slow-A variant: A's per-monitor lock expires (event-loop stall > TTL 15 s without a successful renewal); B acquires the lock, fetches, classifies DOWN, and runs the §16.1 transaction: evidence ping `ping-b`, conditional UPDATE flips UP→DOWN (counters +1 ride the statement), `INSERT … ON CONFLICT (monitor_id) WHERE status='ONGOING' DO NOTHING` opens the incident, outbox row inserted, COMMIT, lock released in `finally` (step 7).
4. A wakes: its renewal compare-and-expire returns mismatch → **abort immediately**, discard the classified result, log `lock_lost`, complete without persisting (§15.1 step 3; §15.2 rows 1–2). A writes nothing.
5. Pathological overlap (A's Tier 1 commits in the window before A notices loss, B also executing): B's conditional UPDATE returns 0 rows → B skips incident + outbox; both evidence pings exist (evidence is never deduplicated — deliberate); counters advanced exactly once; exactly one alert via the single outbox row. A redelivered alert job checks `EXISTS alert:{incidentId}:down` → skips the send, completes successfully (§16.4; TC-DUP-ALERT-01).

**End state:** exactly one ONGOING incident, one outbox row, one Telegram alert, `total_checks`/`failed_checks` +1 each, two DOWN evidence pings — precisely TC-DUP-INCIDENT-01's Then clause, re-derived here against the amended SQL. **UB found (recorded):** in the same narrow race, a *routine* (Tier 2) duplicate can `HINCRBY` the buffer twice — a ±1 lifetime-sample accuracy effect on counters only; no transition, incident, or alert can double (OBS-03).

### Walkthrough W4 — Worker killed mid-job (SIGKILL past `kill_timeout`), then restarted

1. Deploy path: PM2 SIGTERM → graceful `worker.close()` drains (§15.1 stall hygiene); a job still running past `kill_timeout` 20000 ms (runbook §5) takes the SIGKILL.
2. Killed mid-Tier-1-transaction: the open Postgres transaction rolls back at connection death — atomic, nothing persisted. The job's BullMQ lock expires after 30 s; post-restart stall detection re-runs it (§13.6 step 3) → clean re-application (guards + conditional UPDATE).
3. Killed mid-fetch: nothing written; the re-run fetches fresh.
4. Killed after a Tier 2 `HINCRBY` but before job completion: the buffer holds that sample; the stall re-run adds one more — the ±1 class of OBS-03 again, bounded to the in-flight set.
5. Restart: boot re-upserts every Job Scheduler idempotently (§13.6 step 1); the release is gated on `:9090/readyz` (Redis + DB pings — runbook §4 step 4) before the web restart; breaker state resets CLOSED in-process — safe because the first infra-failure re-arms it within one tick (§13.3).
6. Claims: monitors claimed by the lost jobs keep their advanced `next_check_at` → exactly those checks are missed (the accepted J-1 consequence, §14.2 step 6); each monitor self-heals at its next due slot; no re-claim storm (§13.6 step 4).
7. Alerts: outbox rows committed before the kill are picked up after restart (`sent_at IS NULL` selection, §16.3).

**End state:** zero partial transactions; missed checks bounded to the killed in-flight claimed set; the release counts as good only when `readyz` stayed green and the synthetic-check smoke ping row appears (runbook §4 step 6). **UB found:** none beyond the OBS-03 class.

### Walkthrough W5 — Per-monitor lock loss mid-check

1. A executing; the TTL/3 renewal (owner compare-and-expire, §15.1 step 3) fails at some tick — key missing, value mismatch, or Redis error.
2. Response is pinned: **abort immediately** — stop writing, discard the classified result, log `lock_lost`, complete the job without persisting. Never race a possible new owner.
3. Timing sanity: TTL 15 s = 10 s fetch budget + 5 s margin (§15.3, non-negotiable formula) — a healthy fetch fits inside the TTL; genuine loss implies renewal failures (Redis blip) or an event-loop stall, both of which the abort path treats conservatively.
4. New owner B (whose `SET NX` succeeded): executes and records; B's persist cannot collide with A's because A wrote nothing. If A had already committed a Tier 1 transition before noticing the loss, B's conditional UPDATE returns 0 rows and B records evidence only (counters/incident/alert effects exactly once) — the D-1 gate is the correctness mechanism, exactly as §13.1/§15.2 state ("correctness never depended on the lock").
5. Abort during an open Tier 1 transaction: transaction rollback leaves no partial state; if it had committed, step 4's gate applies.

**End state:** exactly one recorded transition per schedule slot; the aborted executor leaves no writes; the stale lock itself can never delay the next check beyond its TTL (§13.6 step 2). **UB found:** none blocking.

### Walkthrough W6 — Auth cutover day (existing credentials user, existing social user)

Preconditions: Phase 7; additive schema in place (`role` column; new `account`/`session`/`verification` tables); legacy `sessions`/`verification_tokens`/`password_reset_tokens` retained read-only; canary already green on the anonymized snapshot **and** in production before any route flip (§12.2 ordering — non-negotiable; a failed production canary aborts).

1. **Credentials user U1** (bcrypt `$2a$` hash migrated into a `providerId:'credential'` account row, `accountId` = user id — §12.1 accounts table last row): the cutover invalidated old sessions (announced per Q-4, §12.6). U1 submits the login form → Better Auth `emailAndPassword.password.verify` routes on the stored hash prefix `$2a$` → bcrypt compare → **success** → server-side session created, cookieCache TTL 5 min (§12.3). On success the lazy rehash re-stores through `password.hash`'s modern default (AUTH-09) — gradual upgrade, no forced resets. User id unchanged ⇒ monitors/FKs intact (§12.1 users row 1).
2. **Social user U2** (Google): the NextAuth `accounts` row was reshaped — `providerAccountId`→`accountId`, `provider`→`providerId` (lowercase `google` assumed — the D-09 `confirm by Phase 7 dry-run` cell), `refresh_token`→`refreshToken` preserved verbatim (the §12.1 row marks preservation as mandatory). U2 clicks "Continue with Google" → Better Auth resolves the account by `(providerId, accountId)` → finds the reshaped row → session created. Re-linking is needed only if a provider secret rotated (§21 D4 — accepted).
3. **Unverified user U3** (`emailVerified` NULL → `false` via the truthiness backfill, §12.1): password login is blocked by `requireEmailVerification: true` → U3 re-requests verification through the `emailVerification` flow → verifies → logs in. Defined, not a lockout (the lockout A-1 exists to prevent is the *hash* mismatch, which the prefix routing removes).
4. Failure path: production canary fails → cutover aborts before the flip (old NextAuth surface still live; tables intact — M-2 rollback). Post-flip incident → restore the previous tarball pair (runbook §7); legacy tables remain the rollback window for one release (AUTH-07).

**End state:** both user classes regain access on first re-login; zero monitor-data impact; forced re-login was announced; rollback stays available. **UB found:** none beyond the deliberately marked `providerId`-casing unknown, which D-09 scopes to the Phase 7 dry-run.

---

## 5. Contradiction hunt + D-10 parameter-cell audit

**Pitfall 1 hunt (two true-looking statements about the same mechanism).** The author's four-string sweep is genuinely clean (re-run: zero matches). This reviewer's extended sweep (full-read cross-checking + `uptime recompute|recompute-uptime|fallback|spike|scheduledAt`) found **four** residuals the author's grep list did not cover:

| # | Location | Fragment | Contradicts |
|---|---|---|---|
| RR-02 | audit §15 file tree, L797 | `maintenance.ts # cleanup, uptime recompute` | §14.1 L716 ("Deliberately absent jobs: `recompute-uptime` … no purpose in v1") and §16.5 L997 ("v1 job lists must not include it") |
| RR-03 | audit §23 item 5, L1160 | "Redis-down fallback write" (as a test to write) | §13.2 L583 ("No fallback write path or fallback scheduler exists") — R-1's core decision |
| RR-04 | audit §12 constraints bullet L453; §20 M2 L1090; §24 step 7 L1241 | "verify hash prefix compatibility during a spike" / "Password-hash compatibility spike first" / "Password-hash spike → migrate" | §12.2 L526 ("this is a **gate, not a spike**") — A-1's entire point |
| RR-01 | absent everywhere | (missing network-egress layer, not a residual string) | review S-1 layer 1 and §9 item S-1's own "network egress" clause |

Legitimate uses were excluded by hand: "DB fallback" (§12.3 cookieCache) and "Prisma read-only fallback" (M1) are different, sanctioned mechanisms; "regression" merely contains the substring `egress`.

**D-10 parameter-cell audit.** Every parameter table cell carries a concrete value, a rationale, and a class: §11 (4 rows), §13.10 (7), §14.1 (9 lanes × 9 columns, incl. explicit priorities everywhere), §14.5 (5), §15.3 (6), §25.4 (8), runbook §5 (5, with the tune-with-data flags per the 01-04 decision). Rate-limit cells reading "none — <reason>" are reasoned decisions, not gaps; BullMQ-v6-sensitive cells carry the required "verify against Phase 4 research" flags. **No unpinned cells found.**

---

## 6. Findings (numbered for the checkpoint and any fix loop)

**RR-01 — HIGH (blocking). S-1's network-egress layer is missing from the design.**
- **Section:** should live in §15 (S-1 amendment) and/or the runbook's worker-topology provisioning; currently absent from both documents (grep-verified — no genuine `egress`/`firewall`/`iptables`/OS-level mention).
- **What is missing:** review S-1's layer 1 — OS/network egress control on the worker host: deny private ranges (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`), allow only 80/443 egress. The §9 item text itself lists "network egress" as the first of the four layers; three layers + tests exist, this one does not. The engine layers are strong, but the review called S-1 the highest-severity security item and specified layered defense precisely because engine-only validation has residual bypass classes (e.g., a future engine refactor or a non-HTTP check type added by UPGRADE_PLAN phases).
- **Fix required:** add the egress-control specification — a design paragraph in §15 under the existing S-1 marker, plus operator steps (host firewall commands/principles) in `DEPLOY-RUNBOOK.md`'s target-topology section. Documentation only; no architecture change.

**RR-02 — MEDIUM (blocking). Residual contradiction: `uptime recompute` in §15's worker file tree.**
- **Section:** audit §15, line 797 (`maintenance.ts # cleanup, uptime recompute`), inside the amended S-1/J-3/J-4 section.
- **What is wrong:** contradicts §14.1's "Deliberately absent jobs" list and §16.5's locked D-6 decision. A Phase 4 implementer scaffolding `worker/processors/maintenance.ts` from this sketch would believe a recompute job is in scope — the exact "trap a Phase 4 implementer will follow" the phase research (Pitfall 1) defines a finding as.
- **Fix required:** replace the comment with the actual maintenance-lane jobs (cleanup, ping-rollup, `write_guards` pruning — §14.1/§13.7/§11 retention row).

**RR-03 — MEDIUM (blocking). Residual contradiction: "Redis-down fallback write" in §23's test list.**
- **Section:** audit §23, item 5, line 1160, inside the amended §23 (§10 criterion 3) section.
- **What is wrong:** the aggregation-test list instructs writing a test for a fallback write path that §13.2 (R-1) explicitly forbids and that exists nowhere in the amended design. A Phase 2/4 test author inherits undefined scope; the amendment's own section carries the rejected mechanism.
- **Fix required:** replace the phrase with the real degradation assertions (Redis down ⇒ enqueue returns 503, monitoring pauses, Postgres intact — aligned with item 6's failure-injection rows) or delete it and rely on item 6.

**RR-04 — LOW (fix in the same cycle). "Spike" vocabulary survives where A-1 mandates a gate.**
- **Sections:** audit §12 constraints bullet (L453, inside the amended A-1 section that itself says "a gate, not a spike" at L526); §20 M2 row (L1090); §24 step 7 (L1241).
- **What is wrong:** three stale "spike" wordings invite the deferral-to-a-spike pattern A-1 was written to kill; the substantive gate is fully specified in §12.2, so this is vocabulary drift, but it sits *inside* an amended section and in two design-level tables.
- **Fix required:** reword the three fragments to "compatibility gate / canary" language. (§20/§24 are unamended sections — minimal-edit discipline permits a targeted wording fix under a small amendment marker or the existing §12 marker's scope note.)

**Non-blocking observations (recorded for Phase 4/5 and ops docs; none contradicts §9/§10 resolution):**

- **OBS-01:** A dead-lettered flush job (never committed) whose Redis hash was later flushed under a new `batchId` would double-apply stale deltas if manually retried — the guard is keyed per batch and was never inserted. Automatic recovery never takes this path. Recommend one ops-doc line: "dead-lettered flush jobs are inspect-only; buffer recovery is automatic via the next flush pass."
- **OBS-02:** Job Scheduler re-declaration is worker-boot-triggered; Redis-only restarts rely on AOF persistence of scheduler keys. Wholesale dataset loss without a worker restart delays recovery until an operator restarts the worker (detected via heartbeat gap). Consider a Redis-reconnect re-upsert hook in Phase 4.
- **OBS-03:** In the narrow lock-expiry/stall-overlap race, a routine (Tier 2) duplicate execution can double-increment one buffered sample — a ±1 lifetime-counter accuracy effect; transitions, incidents, and alerts cannot double (conditional UPDATE + outbox + dedup). Accept and document, or pin a note in Phase 4.
- **OBS-04:** §13.1's limiter cell (`INCR` + `EXPIRE`) does not pin atomicity; the review's S-3 prose asked for atomic Lua `INCR`+`EXPIRE NX` (or sliding window). A crash between INCR and EXPIRE leaves a TTL-less counter (permanent limit). Pin `EXPIRE NX` on first increment at implementation time (Phase 4/6).
- **OBS-05:** §13.8 budgets two connections per *worker* process but does not budget the web process's Redis connections (queue-producer + limiter/cache client). One line in Phase 2 would close it.
- **OBS-06:** §25 omits the review prose's "monitor `pg_stat_activity`" operational note. Non-blocking — the §9 item ("budget documented") is met.

---

## 7. D-18 cycle accounting

This execution is **re-review cycle 1 of the maximum 2**. No verdict is recorded on this cycle. Per D-18: the numbered findings above go to a fix cycle — a follow-up plan authored by a **fresh agent** (never this reviewer, never the original authoring session) applying RR-01…RR-04; this re-review then re-runs (cycle 2). If cycle 2 is clean, the verdict flip (plan 01-05 Task 3, D-16) proceeds after a new ratification checkpoint. If gaps persist after cycle 2, the remaining list escalates to the user and the verdict stays as-is.

---

## 8. Recommendation

**GAPS FOUND — the verdict must NOT flip on this cycle.**

Four numbered findings (§6), all documentation-scope fixes requiring no architectural change:

| Finding | Severity | One-line fix |
|---|---|---|
| RR-01 | HIGH | Add the S-1 network-egress layer spec (audit §15 + runbook worker-host steps) |
| RR-02 | MEDIUM | Remove "uptime recompute" from §15's `maintenance.ts` comment |
| RR-03 | MEDIUM | Remove/replace "Redis-down fallback write" in §23 item 5 |
| RR-04 | LOW | Replace the three "spike" wordings with gate/canary language |

Everything else the gate depends on held up under adversarial pressure: all 25 §9 items trace to resolving design decisions (24 fully, 1 — S-1 — minus its first layer), all three §10 criteria are satisfied under the explicitly recorded criterion-2 interpretation (D-05/DRZ-01), all six D-17 walkthroughs end in defined, observable states with Postgres consistency preserved in every one, and the parameter tables are fully pinned. One fix cycle is expected to clear all four findings.

---

*Report: 01-REREVIEW.md · Reviewer session: plan 01-05 wave 5 executor · 2026-09-09*
