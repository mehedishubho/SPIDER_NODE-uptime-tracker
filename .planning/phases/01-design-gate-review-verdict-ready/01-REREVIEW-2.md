---
phase: 01-design-gate-review-verdict-ready
reviewed: 2026-09-09T15:43:04Z
cycle: 2
cycle_final: true
status: clean-pass-ratified-verdict-flipped
blocker_for: plan 01-09 Task 2 (D-16/D-18 human gate)
---

# Phase 01 Plan 09 — Adversarial Re-Review Report, Cycle 2 (final)

> **Date:** 2026-09-09
> **Reviewer:** Separate GSD executor session spawned for plan 01-09 (wave 8) via `/gsd-execute-phase`. Agent: `gsd-executor` (Claude Code agent runtime); model powering this session: **GLM-5.3**.
> **Cycle:** **2 of 2** — this is the D-18 final cycle. There is no third fix cycle and no READY-with-exceptions state; the outcome of this report plus the human ratification (Task 2) determines the verdict action (Task 3) terminally.
> **Independence attestation (D-15):** This session did **not** author any part of the design addenda or the fix cycle. Plans 01-01…01-08 were executed by earlier, distinct sessions — verified via `git log`: the original addenda commits (`1601c2b`…`b315fb4` and predecessors) and every fix-cycle commit (`577fc24`, `dd9b672`, `eb70e1e` — plan 01-06; `6e4d689`, `7560f2d`, `1d28836` — plan 01-07; `39233d7`, `88a8a07`, `932846a` — plan 01-08) predate this session's start (2026-09-09T15:43:04Z; fix-cycle commits land 21:05–21:39 the prior working day). No fix-cycle SUMMARY claim was trusted: **every closure row in §2 was re-derived in this session from the document text and the grep/read evidence quoted inline.** `docs/` was treated as read-only — SHA-256 before this review: audit `dfa3ea29…`, runbook `7b077dd5…`, review `5ae4a105…` (`git hash-object` of the review doc: `520c9409da45bd2c9ab9866fe124403ef6cb7ef3`, byte-identical to the tracked NOT READY blob); byte-identity re-verified at report completion.
> **Scope:** the post-fix-cycle design — `docs/ARCHITECTURE-AUDIT.md` (1425 lines; §11/§12/§13/§14/§15 incl. §15.4/§16 incl. §16.2/§16.4/§20/§22/§23/§24/§25 amended by the fix cycle) and `docs/DEPLOY-RUNBOOK.md` (180 lines; §1/§2/§3/§4/§4a/§5/§8/§10) — re-audited against `docs/ARCHITECTURE-REVIEW.md` §9 (25-item checklist), §10 (re-review criteria), and the six D-17 failure-scenario walkthroughs, PLUS a closure audit of every finding the fix cycle claimed to close (RR-01..RR-04 ratified; CR-01..CR-03 criticals; WR-01..WR-08 / IN-01..IN-05 / OBS-01/04/05 folded advisories) and a new-edit hunt over the fix-cycle changes themselves.
> **Inputs:** full reads (this session) of all three documents above, 01-CONTEXT.md (D-15/D-16/D-17/D-18), 01-REREVIEW.md (cycle-1 method + its findings/observations), 01-VERIFICATION.md (authoritative fix-scope list), 01-REVIEW.md (the full WR/IN list), and 01-06/01-07/01-08-SUMMARY.md — the last three **for orientation only; every claim in them was re-verified, never trusted**.

---

## 1. Verification method (what was re-run, not trusted)

| Check | Command (re-run here) | Result |
|---|---|---|
| §9 item traceability | `for id in J-1…P-1: grep -q "$id" docs/ARCHITECTURE-AUDIT.md docs/DEPLOY-RUNBOOK.md \|\| echo MISSING` | **Empty output — all 25 IDs found** (§3) |
| S-1 two-layer trace | read §15.1 step 4 + §15.4 + runbook §10; `grep -n "S-1"` both docs | **Engine layer + OS layer both present**; runbook §10 cites "S-1 layer 1 / audit §15.4" |
| Three-way denylist identity | token extraction (`grep -oE` over the 11 CIDR tokens) from §15.1 sub-step 2 (L826), §15.4 (L865), runbook §10 (L176) | **11/11 identical token sets in all three statements** (§6.1) |
| RR-02 residual | `grep -c "uptime recompute"` (space form) | **0 file-wide**; `recompute-uptime` (hyphen) survives only in the two sanctioned absent-job listings (§14.1 L724, §16.5 L1073) |
| RR-03 residual | `grep -c "Redis-down fallback write"` | **0 file-wide**; §23 item 5 rewritten to 503/pause/intact assertions (L1239) |
| RR-04 residual | `grep -niE "spike"` | **Exactly 1 occurrence — §12.2's own "gate, not a spike" sentence (L526)**; §20 M2 (L1167) and §24 step 7 (L1330) now use gate/canary language |
| Cycle-1 author stale sweep | `grep -nE "falls back to writing routine pings\|alert:sent:\|interval + slack\|repeatable"` + `grep -c scheduledAt` | **0 / 0** — still clean after the fix cycle |
| Extended contradiction sweep | `grep -niE "fallback"` full classification + the fix-cycle token set (§6) | 7 `fallback` hits, **all sanctioned** (§12.3 cookieCache DB fallback; §13.2 prohibitions ×2; §23 item-5 reference; M1 Prisma read-only fallback; M7; one §7 current-state description); runbook 0 |
| Fix-cycle token drift | greps over `agg:flushing:`/`pings:flushing:` (×12), `alert:{…}` shapes, `check:{monitorId}:manual:` (×2), `epochMs-of-flush-pass` (×2), `TC-SSRF-MAPPED-V6-01` (×2), `TC-FIRST-CHECK-DEDUP-01` (×2) | Consistent across every mirror (§6.2); **one orphan found** (`agg:pending`, RR2-01) |
| Fix-cycle marker integrity | `grep -cE "Amended 2026-\|Added 2026-"` / `grep -c "fix cycle"` | 25 amendment-marker lines / 16 fix-cycle mentions in the audit; runbook header note covers §1–§5/§4a/§10 |
| Read-only compliance | `git status --porcelain docs/` + `sha256sum` before/after + `git hash-object` review doc | docs/ clean; review doc still at blob `520c9409…` |

---

## 2. Closure audit — every fix-cycle claim re-derived

Status column is this reviewer's independent judgment from the quoted evidence, not a summary quote. Line numbers are from this session's read of the current files (evidence anchors cite section + quoted fragment, per the report contract).

### 2.1 Ratified cycle-1 gaps (RR-01..RR-04)

| Finding | Status | Re-derived evidence |
|---|---|---|
| **RR-01** (HIGH — S-1 network-egress layer absent) | **CLOSED** | Audit §15.4 "Worker-host network egress control (S-1 layer 1)" exists (Added marker: "egress layer — resolves S-1 layer 1 / RR-01", L859–871) AND runbook §10 "Worker-host egress control (apply once — Phase 4 worker provisioning)" exists (L171–180). **Ranges identical in both AND in the engine list**: programmatic token diff over the 11 CIDR tokens (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, `64:ff9b::/96`) — 11/11 in §15.1 L826, §15.4 L865, runbook §10 L176. **Rules identical**: 80/443-only public egress + DNS + loopback/VPC 5432/6379 exceptions in both; same-change mandate stated in all three ("the three lists are one list", runbook L180; "extend both statements together, never one alone", §15.1 L826). Cross-citations both directions (§15.4 → runbook §10; runbook §10 → "audit §15.4 mirrors from the engine denylist"). Apply-once-at-§4a-provisioning stance + Action/Verification/Rollback triple present (runbook). |
| **RR-02** (MEDIUM — `uptime recompute` in §15 file tree) | **CLOSED** | `grep -c "uptime recompute"` = **0 file-wide**. The §15 file-tree comment now reads `maintenance.ts # cleanup (looped retention deletes, §13.7), ping-rollup, write_guards pruning` (L806) — all three are real maintenance-lane jobs: cleanup + ping-rollup appear in §14.1's `maintenance` lane row; write_guards pruning is pinned (§11 param table "prune rows older than 7 days", §13.7 "write_guards > 7 d"). Hyphenated `recompute-uptime` survivors (§14.1 L724 "Deliberately absent jobs", §16.5 L1073) are the sanctioned D-6 listings, not contradictions. |
| **RR-03** (MEDIUM — "Redis-down fallback write" test in §23 item 5) | **CLOSED** | `grep -c "Redis-down fallback write"` = **0 file-wide**. §23 item 5 (L1239) now states the real degradation assertions: "with Redis unavailable, the manual-check enqueue path returns **503**, never a silent no-op (§13.2 item 4); monitoring pauses by design; Postgres data stays intact — no fallback write path is exercised because none exists (§13.2 item 1)" — and explicitly complements ("not duplicating") item 6's failure-injection rows. Aligned with §13.2. |
| **RR-04** (LOW — "spike" vocabulary) | **CLOSED** | `grep -niE "spike"` = **exactly 1 match, L526**: §12.2's own "this is a **gate, not a spike**" sentence — the sanctioned survivor. The three flagged fragments were reworded: §12 constraints bullet (L453) now routes verification through "the §12.2 compatibility gate's hash-prefix routing step… not an ad-hoc investigation"; §20 M2 (L1167) reads "bcrypt compatibility gate (§12.2): canary login on the anonymized snapshot, then production, before any route flip"; §24 step 7 (L1330) carries the same gate ordering via §12.2; §20/§24 carry adjacent fix-cycle markers citing RR-04/WR-06. |

### 2.2 Post-review criticals (CR-01..CR-03)

| Finding | Status | Re-derived evidence |
|---|---|---|
| **CR-01** (Critical — Tier 2 eliminated routine ping rows) | **CLOSED** | §16.2 step 1 contains the **multi-row `INSERT INTO pings (monitor_id, status, response_time, error_class, status_code, created_at)` inside the guarded transaction** (L993–994), tuples sourced from the staged `pings:flushing:{batchId}` list (`LRANGE 0 -1`), id column omitted per D-3. Write side wired: §15.1 step 6 (L831) — "HINCRBY/HSET counter deltas **plus one `RPUSH` evidence row onto `pings:pending:{monitorId}`** (per-check evidence is carried, not discarded — CR-01)"; §13.1 live-buffers row (L575) mirrors it ("drained by the §16.2 multi-row INSERT INTO pings"); §16 Tier 2 prose (L884) mirrors it. §14.1's absent-jobs paragraph corrected: the "no bulk ping-row writer" claim is gone (`record-pings-bulk` = 0 matches) and replaced by "routine ping-row persistence rides the `flush-monitor-aggregate` job itself" (L724). Column contract: the §16.1 (L901) and §16.2 (L993) INSERT lists are identical and match §11's pings columns exactly (new `error_class`/`status_code` + existing four; `id` omitted). Consequences CR-01 named are restored: §2's last-100-pings API contract and §16.5's windowed-uptime-from-`pings` plan are implementable as written; `error_class` now populates for unchanged-DOWN checks; §5's B6 defect (routine DOWN evidence) is answered. |
| **CR-02** (Critical — flush had no exclusive snapshot semantics) | **CLOSED** | §16.2 rewritten as the three-step sequence: **step 0** read-only guard pre-check (`SELECT 1 FROM write_guards WHERE key = 'flush:{batchId}'` — a returned row ⇒ already committed ⇒ skip straight to cleanup, never touching live keys) + **`RENAMENX agg:results:{monitorId} agg:flushing:{batchId}` / `RENAMENX pings:pending:{monitorId} pings:flushing:{batchId}`** (L962–967); **step 1** guarded transaction (guard INSERT → bulk pings INSERT → additive monotonic UPDATE); **step 2** post-COMMIT **staging-only** `DEL` (L1010) with "The **live** keys … are never deleted by a flush job; they are only ever moved by the *next* pass's step-0 snapshot" (L1013). **batchId pinned** (L1019, D-10 table): `{epochMs-of-flush-pass}:{monitorId}`, carried in BullMQ job data — "a redelivery re-derives the identical staging key names and guard key". Invariant 5 (L891) states the two-part exactly-once guarantee. TC-FLUSH-GUARD-01 rewritten (L1263–1266): redelivery changes counters AND ping rows by zero, staging keys deleted on the exit path, live keys "explicitly NOT deleted". This reviewer independently re-derived both CR-02 failure modes against the amended text: (a) *double-apply* — pass-N and pass-(N+1) hold different batchIds, but RENAMENX gives one pass the whole live container and leaves the other a no-op (source absent), so the same deltas are never read by two passes; (b) *over-delete* — a redelivered job's exit path deletes only staging keys; the plain-RENAME trap is documented and forbidden (L970: "do not 'simplify' it"). Plan 01-06's Rule-1 deviation (RENAMENX + pre-check instead of plain RENAME) **strengthens** the spec — verified, not trusted. |
| **CR-03** (Critical — dedup key undefined for NULL-incident events) | **CLOSED** | §16.4 (L1057–1061) declares **one key per declared event type**: `incident.down` → `alert:{incidentId}:down`; `incident.recovered` → `alert:{incidentId}:recovered`; `monitor.first_check` → `alert:{monitorId}:first_check` "(monitor-scoped, not incident-scoped — the event has no incident)". **Non-NULL contract**: "incident.down and incident.recovered outbox rows **REQUIRE a non-NULL `incident_id`**. A violating row… throws `UnrecoverableError` so it dead-letters immediately… instead of silently suppressing alerts — interpolating a NULL incidentId would mint a shared `alert:null:*` key". Mirrors verified identical: §13.1 dedup row (L580) carries all three shapes with the same strings; §16.3 relay-validation bullet (L1048) makes the relay treat nullability as a consistency contract. **TC-FIRST-CHECK-DEDUP-01 present** (L1258–1261): monitor 43's fresh first-check alert SENDS while 42's redelivery is suppressed — the cross-monitor collision case pinned. The `alert:null` string appears only in the two explanations of the prevented failure mode. |

### 2.3 Folded advisories (WR-01..WR-08, IN-01..IN-05, OBS-01/04/05)

| Finding | Status | Re-derived evidence |
|---|---|---|
| **WR-01** (SSRF bypass classes) | **CLOSED** | §15.1 step 4 sub-step 2 (L826): canonicalization rule — "an IPv4-mapped IPv6 address… is canonicalized to its embedded IPv4 form and checked against the IPv4 denylist **as that address** (`::ffff:10.0.0.1` → `10.0.0.1` → denied by `10/8`)" + the three added ranges (`0.0.0.0/8` with rationale, `::ffff:0:0/96`, `64:ff9b::/96` NAT64 with embedded-IPv4 canonicalization). **TC-SSRF-MAPPED-V6-01** present (L1285–1288) with network/DB/queue effects. The same three ranges mirrored in §15.4 and runbook §10 (three-way check, §6.1). Canonicalization mentioned ×5 in the audit. |
| **WR-02** (manual-check/claim interaction) | **CLOSED** | §14.1 "Manual-lane claim semantics (WR-02)" paragraph (L722): enqueue-time advance "via the same atomic UPDATE shape as §14.3's claim" (literal `UPDATE monitors SET next_check_at = now() + (interval * interval '1 minute') WHERE id = $mid AND is_active RETURNING next_check_at`), D-10 rationale (double-sample elimination), manual jobId **`check:{monitorId}:manual:{epochMs-of-enqueue}`** unique per enqueue, admission governed by the D-13 limiter not the jobId. Both jobId forms mirrored in §13.1's idempotency row (L577) with the same `removeOnComplete` horizon (age 3600 s, matching §14.1's `{ age: 3600, count: 5000 }`). |
| **WR-03** (interim Migrate executability) | **CLOSED** | Runbook §3 step 3 retitled "Migrate (phase-conditional — check which phase you are releasing)": "**Phase 2 releases: run no migrate command in this step.** No migration runner exists yet — schema changes still flow through the existing CI schema step (`prisma db push`…), which the Phase 3 baseline PR removes (audit §24 step 3); do not run it ad hoc"; Phase 3+ branch retains single-runner/never-at-boot/no-op-exit-0 with per-branch Verification. §2's Migrate row carries the same conditional; §8 names the legacy CI step as "the acknowledged interim schema mechanism — already on its dated removal path". No surface prescribes `drizzle-kit migrate` unconditionally for Phase 2. |
| **WR-04** (PM2 wait_ready semantics) | **CLOSED** | Runbook §4 (L76): "Two distinct readiness signals exist, and PM2 watches only the first: the worker must emit the **PM2 ready signal** — a `process.send('ready')` call — once its Redis and DB pings pass… The HTTP `readyz` endpoint remains the operator/CI gate; the process ready signal is the PM2 gate (§5 `wait_ready`)" + the crash-loop consequence stated. §5 `wait_ready`/`listen_timeout` rows reference "the process ready signal from §4" (`process.send` ×3 in the runbook). |
| **WR-05** (first-worker-cutover path) | **CLOSED** | Runbook §4a "First worker release (Phase 4 cutover)" (L105–120): step 1 first registration via `pm2 start`/`startOrReload` ("**Never `pm2 restart uptime-worker`** on the first release: it errors on a name PM2 has never started") with web-only rollback (`pm2 delete`; old cron still live); step 2 M3 overlap window with five verification items (heartbeat steady, queue depth ≈ 0, pings flowing, Telegram alert parity, M4 counter-delta sanity) and "disable nothing" rollback; step 3 cutover completion as a separate follow-up release deleting `instrumentation.ts` cron + `CRON_MODE`, explicitly disambiguated from §9's later `CRON_SECRET` retirement. §4 step 4 carries the reciprocal pointer ("applies from the **second** worker release onward — the first registration… follows §4a"). §5–§9 headings unrenumbered; §10 appended after §9. |
| **WR-06** (folded into RR-04) | **CLOSED** | §20 M2 and §24 step 7 reworded to gate/canary language with adjacent fix-cycle markers citing RR-04/WR-06 (evidence under RR-04 above). |
| **WR-07** (priority-default claim single-sourced) | **CLOSED** | §14.1 priority paragraph (L718) carries the live-verification instruction ("verify against Phase 4 BullMQ 6 research with a live dequeue-order check: enqueue one prioritized and one unprioritized job, assert the order") AND the standalone invariant independent of the default-behavior claim: "**Invariant (WR-07…): every lane MUST set an explicit priority; cross-lane ordering relies on numeric priority among explicit values only**." `verify against Phase 4` markers ×8 in the audit; every one of the nine §14.1 lane rows carries a bold Priority cell. |
| **WR-08** (lock margin vs statement_timeout) | **CLOSED** | §15.1 step 3 (L823): "The renewal timer runs for the **entire job lifetime** — fetch, classification, and Tier 1 persistence (§16.1, which may legitimately take up to the 30 s `statement_timeout`, §25.2) — it does **not** stop when the fetch returns; the lock is released only in the step-7 `finally` (WR-08)" + the rationale (a slow transition would hand ownership mid-persist). §15.3's Lock TTL row (L855) mirrors the same lifetime semantics. |
| **IN-01** (per-user limiter key) | **CLOSED** | §13.1 rate-limit row (L579): "`rl:{bucket}:{ip}`, `rl:manual:{userId}:{monitorId}` (1 per monitor / 30 s), and **`rl:manual-user:{userId}`** (the §12.4 D-13 cross-monitor per-user counter — 6/min)" — the missing key shape now in the inventory §12.4 points to. |
| **IN-02** (unpinned buffer threshold) | **CLOSED** | §14.1 flush-lane producer cell (L705): "every 30 s — **purely time-based; no buffer threshold exists: §16 invariant 4 bounds the buffer by the 60 s window**". The old "buffer threshold checked each pass" phrase returns zero grep matches. |
| **IN-03** (batchId scheme) | **CLOSED** | Pinned as a D-10 table row inside §16.2 (L1019): `{epochMs-of-flush-pass}:{monitorId}`, class "non-negotiable (shape)", uniqueness argument stated (epoch separates passes, monitorId separates monitors, one job per monitor per pass), determinism-under-redelivery stated (rides job data). |
| **IN-04** (zero-rows conflation) | **CLOSED** | §16.1 step-2 comment (L907–911): "Zero rows has two causes and implementers must **NOT** branch on which one occurred (IN-04): (a) another executor already made this transition, or (b) `is_active` was cleared after the claim — same skip path for steps 3–4 either way. The step-1 evidence ping for a deactivated monitor is accepted (retention cleans it in 30 days)." |
| **IN-05** (≤ 31 steady-state imprecision) | **CLOSED** | Audit §25.1 (L1354): "Steady-state total ≤ **30** connections (web 10 + worker 20); ≤ **31** during deploys while the single migration runner is connected (IN-05…)" — mirrors runbook §1 (L20) verbatim in substance: "steady-state total ≤ 30 connections…, rising to ≤ 31 only during deploys". Numbers unchanged; precision fixed in both. |
| **OBS-01** (dead-lettered flush ops note) | **CLOSED** | §16.4 write-discipline bullet (L1066) + §16.6 dead-lettered-flush row (L1083) + §13.1 staging-key TTL cell (L576): "inspect-only — never auto-retried past the lane's attempt bound; a manual retry is a safe no-op if the batch ever applied (`write_guards` guard), and unapplied staged deltas are Tier 2 loss-tolerable (invariant 3)"; `inspect-only` ×2. Detection via DLQ/outbox-age named. |
| **OBS-04** (limiter atomicity) | **CLOSED** | §13.1 limiter row (L579): "each limit check runs as a **single Lua script**: `INCR` followed by `EXPIRE` with NX semantics on the first increment, never a bare `INCR` with a separate `EXPIRE` call (IN-01/OBS-04: a crash between the two strands a TTL-less counter and permanently rate-limits the user)". EXPIRE-NX semantics pinned ×2. |
| **OBS-05** (web-process Redis budget) | **CLOSED** | §13.8 (L646): "Web-process Redis budget (OBS-05 / IN-05): the web process holds **2 Redis connections** — one queue-producer connection for enqueues… and one limiter/cache client… — counted separately from the worker's two connections above; Redis total across both processes is therefore 4 steady-state." |

### 2.4 Deliberately deferred observations (OBS-02/03/06) — rationale recorded, not silently dropped

| Obs | Deferral record (re-derived) |
|---|---|
| **OBS-02** (scheduler re-upsert is worker-boot-triggered; Redis-reconnect hook) | Deferred **with recorded rationale**: 01-08-PLAN success_criteria states "OBS-02, OBS-03, OBS-06 remain deliberately deferred to Phase 4/5 with the re-review's own non-blocking rationale recorded — they are §9-external observations, not checklist items"; 01-REREVIEW.md §6 OBS-02 carries the rationale and the Phase 4 recommendation (reconnect re-upsert hook) and the detection path (heartbeat gap pages the operator). Not a §9/§10 item — deferral is legitimate. |
| **OBS-03** (±1 routine-sample race class) | Same recorded deferral (01-08-PLAN + 01-REREVIEW §6: "Accept and document, or pin a note in Phase 4"). Cycle-2 note: under the amended Tier 2 the same narrow race can also duplicate one buffered **evidence row** — the same accuracy class, already covered by the design's documented "evidence is never deduplicated — deliberate" stance (TC-DUP-INCIDENT-01) and by invariant 3 (Tier 2 loss/duplication tolerable). No new mechanism, no escalation of the class. |
| **OBS-06** (pg_stat_activity monitoring note) | Same recorded deferral; the §9 D-8 item ("budget documented") is fully met by §25 — cycle 1 already judged this non-blocking and the ratification accepted that. |

---

## 3. §9 checklist re-run — 25/25 IDs trace, zero MISSING

Loop re-executed this session over BOTH documents (`grep -q` per ID): **empty MISSING output**. Per-item judgments below are fresh readings of the amended text; "unchanged" means cycle 1's resolving judgment still holds against text this session verified, "amended" means the fix cycle touched the incorporating text and the judgment was re-derived.

| §9 ID | Location(s) re-verified | Cycle-2 judgment |
|---|---|---|
| **J-1** | §11 `next_check_at` DDL + `idx_monitors_due`; §14.2 steps 2–3; §14.3 claim SQL; §14.5 tick 30 s; **§14.1 manual-lane paragraph (amended)** | **Resolves.** Unchanged core (claim-advances-inside-CTE, `FOR UPDATE SKIP LOCKED` load-bearing placement, `check:{monitorId}:{epoch}` key, tick ≤ ½ min interval) plus the fix cycle's WR-02 addition making the manual lane share claim semantics — both lanes now advance `next_check_at` atomically, and §13.1 mirrors both jobId forms. |
| **J-2** | §11 `write_guards`; §16.2 (amended) | **Resolves.** Guard insert + delta apply + (new) bulk ping INSERT share one transaction; the §16.2 rewrite preserves the "Redis-side guard alone is insufficient" requirement. |
| **J-3** | §15.1 steps 2–3/7; §13.1 lock row; §14.1 stalled cells; §15.3; runbook §5 | **Resolves.** TTL formula, TTL/3 owner-compare-and-expire renewal, Lua owner-only release, abort-on-loss — all unchanged and now with WR-08's renewal-through-persist lifetime pin closing the 30 s-statement_timeout gap. |
| **J-4** | §15.1 step 5; §23 TC-CLASSIFY-* (plus new TC-SSRF-MAPPED-V6-01) | **Resolves.** Target outcomes typed successful results; only infra throws/retries; test battery extended, not weakened. |
| **J-5** | §13.3/§13.4/§13.5/§13.10; §14.2 step 4 | **Resolves.** Unchanged; §16.2's new staging keys interact safely (W2 transcript §5). |
| **J-6** | §14.1 all nine lanes + priority paragraph (amended) + manual-lane paragraph | **Resolves.** Explicit priority on every lane, worst-case bound, plus the WR-07 invariant and Phase-4 verify marker. |
| **D-1** | §16.1 step 2/3a; §11 `incidents_one_ongoing`; §23 TC-DUP-INCIDENT-01 | **Resolves.** Unchanged; re-checked against the amended §16.1 comment (IN-04 dual-cause). |
| **D-2** | §11 `outbox`; §16.1 step 4; §16.3 | **Resolves.** Unchanged; relay now also carries the CR-03 validation contract. |
| **D-3** | §11 ID-generation subsection | **Resolves at design level** (same D-05/DRZ-01 reading as cycle 1 — §4 criterion 2 below); the §16.2 bulk INSERT omits id exactly as the pin requires. |
| **D-4** | §16.4 (amended); §13.1 dedup row (amended) | **Resolves.** Dedup keyed per event type with the full three-key vocabulary and the non-NULL contract (CR-03 closure). |
| **D-6** | §16.5; §14.1 absent-jobs (amended) | **Resolves.** Lifetime counters locked; absent-jobs paragraph now consistent with the CR-01 flush-side INSERT (the contradiction CR-01 flagged inside it is gone). |
| **D-7** | §13.7; §11 param row | **Resolves.** Unchanged; per-check ping volume restored by CR-01 keeps the 5000-batch assumption honest. |
| **D-8** | §25; runbook §1 (amended) | **Resolves.** Full budget spec + the IN-05 precision fix (≤ 30 / ≤ 31) agreed across both documents. |
| **R-1** | §13.2/§13.8/§13.6; **§23 item 5 (amended)** | **Resolves.** Pause-by-design, hardening, recovery procedure; the RR-03 rewrite removed the last fragment contradicting it. |
| **A-1** | §12.2; §12 constraints bullet, §20 M2, §24 step 7 (all amended) | **Resolves.** The gate ordering is now cited consistently everywhere the word "spike" used to appear (RR-04 closure). |
| **A-2** | §12.3 | **Resolves.** Unchanged from cycle 1's verified state. |
| **A-3** | §12.1 field maps | **Resolves.** Unchanged; D-09 Phase-7 markers intact. |
| **S-1** | §15.1 step 4 (amended); **§15.4 (NEW)**; **runbook §10 (NEW)** | **Resolves — now at BOTH layers.** Engine layer (scheme allowlist, resolve-then-validate + canonicalization, connect-time re-validation, hop cap, 2 MB cap, test battery incl. TC-SSRF-MAPPED-V6-01) plus the OS/network egress layer (RR-01 closure): identical 11-token denylist in all three statements, 80/443-only rule, DNS/5432/6379 exceptions, apply-once verification stance, operator triple in the runbook. Cycle 1's "Partial — gap found" is cured. |
| **S-2** | §12.5 | **Resolves.** Unchanged (decision note; implementation Phase 6). |
| **S-3** | §12.4; §13.1 limiter row (amended) | **Resolves.** Admin plugin, feedback admin-only, Bull Board admin+IP; D-13 limiter now with the full three-key inventory and Lua atomicity (IN-01/OBS-04). |
| **S-4** | §22 item 8; runbook §9 | **Resolves.** Unchanged. |
| **M-1** | §22 item 3; runbook §8 (amended) | **Resolves.** Single-runner rule; the WR-03 phase-conditional made the interim phase honest about the legacy CI mechanism without weakening the target rule. |
| **M-2** | §22 item 7; runbook §7 | **Resolves.** Unchanged. |
| **M-3** | §11 baseline rule; runbook §8 (amended) | **Resolves.** Empty-diff gate; Phase 2 no-migrate branch verified by CI-exit-0 rather than a nonexistent journal — consistent. |
| **P-1** | runbook §3/§4/§4a/§5/§6/§10; audit §22 pointer | **Resolves.** Both topologies with Action/Verification/Rollback on every numbered step (re-counted across §3's 5, §4's 6, §4a's 3); §4a extends coverage to the first worker release; §10 adds the egress operator path. |

---

## 4. §10 re-review criteria — per-criterion results

| §10 criterion | Result | Evidence |
|---|---|---|
| **(1) Every §9 checklist item incorporated into the design documents** | **Incorporated — 25/25, and now contradiction-free** | §3 table; all four cycle-1 residuals removed with file-wide negative greps (§1); all three criticals closed (§2.2); the one checklist item cycle 1 scored Partial (S-1) now traces to two layers. No §9 item's incorporating text contradicts any other section — the extended sweep (§6) found only advisory-grade residuals, none touching a checklist item. |
| **(2) Schema addenda reflected in the target Drizzle schema** | **Satisfied under the recorded interpretation — now user-ratified** | The cycle-1 interpretation (D-05/DRZ-01: the DDL-precise §11 sketch + Phase 3 live-`pg_dump` transcription contract + M-3 empty-diff CI gate together constitute "reflected in the target Drizzle schema") is carried forward unchanged. 01-REREVIEW.md §9 records the human **explicitly accepted this interpretation** at the cycle-1 ratification; cycle 2 re-applies it without re-litigating. §11 remains DDL-precise (write_guards/outbox DDL, partial-index predicate text, pinned ID defaults); §16.2's INSERT column list matches §11's pings columns exactly. |
| **(3) SSRF and duplicate-incident/duplicate-alert test cases in §23** | **Present and extended** | SSRF: TC-SSRF-REDIRECT-PRIVATE-01, TC-SSRF-DNS-REBIND-01, **TC-SSRF-MAPPED-V6-01 (new)**, TC-SSRF-SCHEME-01, TC-SSRF-SIZE-CAP-01. Classification: TC-CLASSIFY-TIMEOUT/DNS/INFRA-01. Duplicates: TC-DUP-INCIDENT-01, TC-DUP-ALERT-01, **TC-FIRST-CHECK-DEDUP-01 (new)**, TC-FLUSH-GUARD-01 (rewritten for staging keys), TC-MONOTONIC-01 (rewritten). All given/when/then with concrete DB/Redis/queue/network effects. §23 item 5 no longer names a forbidden mechanism (RR-03). |

---

## 5. Failure-scenario walkthroughs (D-17 — six transcripts REPLAYED on the amended specs)

Method per review §2/§3.1, replayed with the fix-cycle mechanics (staging keys, batchId, guard pre-check, renewal-through-persist, egress layer, three-key dedup). These are fresh transcripts, not copies of cycle 1.

| # | Scenario | Observable end state | Undefined behavior found | Result |
|---|---|---|---|---|
| W1 | Redis restart mid-operation | Postgres consistent; cadence resumes ≤ ~60–90 s; staging keys survive or are cleanly re-derived | OBS-02 (deferred, rationale recorded) | Defined |
| W2 | Postgres down during checks | Zero partial writes; queues paused; heartbeat `/fail` pages; outbox accumulates then drains; buffers bounded | None new | Defined |
| W3 | Duplicate check-job delivery | One ONGOING incident, one outbox row, one alert, counters +1, two evidence pings (documented) | OBS-03 class (deferred, recorded) — now also covers a duplicate buffered evidence row | Defined |
| W4 | Worker SIGKILL past kill_timeout, then restart | Open transactions roll back; stall detection re-runs; missed checks bounded to in-flight claimed set; release gated on `readyz` + smoke | None beyond OBS-03's class | Defined |
| W5 | Lock loss mid-check | Abort path leaves no writes; new owner's execution is the recorded one; slow persists no longer expire the lock | None | Defined |
| W6 | Auth cutover day (credentials + social user) | Both user classes log in again; monitor data untouched; rollback window open one release | `providerId` casing — the marked D-09 Phase-7 known-unknown (by design) | Defined |

### Walkthrough W1 — Redis restart mid-operation (replayed)

Setup: worker executing check jobs and a flush job for monitor 42 (batchId `1770890760000:42`); the Redis process dies and is restarted by the supervisor (§13.8).

1. Detection — worker ioredis clients error; `:9090/readyz` Redis ping fails (§15 health surfaces). Any open Postgres transaction commits or rolls back on its own connection, independent of Redis.
2. Pause by design (§13.2): no Redis = no jobs; nothing half-written; enqueue surfaces fail loudly (503), never silently.
3. **Flush job interrupted mid-pass (new mechanics):** three sub-cases re-derived —
   a. *Killed before the RENAMENX:* live keys untouched; deltas intact; the redelivered job snapshots fresh.
   b. *Killed after RENAMENX, before COMMIT:* the staging keys `agg:flushing:1770890760000:42` / `pings:flushing:1770890760000:42` persist in Redis (TTL none; AOF `everysec` covers the restart with ≤ 1 s tail loss). The redelivered job's step-0 guard pre-check (a Postgres read — unaffected by the Redis restart) returns no row, its `RENAMENX` **NX-fails** because the staging keys still exist, and it applies the staged snapshot; post-snapshot deltas waited in freshly created live keys the whole time.
   c. *Killed after COMMIT, before the staging DEL:* pre-check returns the `write_guards` row ⇒ skip straight to cleanup; live keys never touched.
4. In-flight check jobs: BullMQ locks expire (30 s); stalled config (`stalledInterval` 30000, `maxStalledCount` 1) re-runs them at-least-once; §16 writers absorb duplicates (conditional UPDATE + guards + dedup).
5. Scheduler continuity: AOF persists scheduler keys; re-upsert is worker-boot-triggered — the recorded OBS-02 residual (wholesale dataset loss without a worker restart waits for the heartbeat-gap-paged operator restart); rationale recorded, non-blocking.
6. Claims safe (J-1): `next_check_at` advanced at selection — no re-claim storm (§13.6 step 4).

**End state:** Postgres row state identical to pre-restart except absorbed at-least-once duplicates; monitoring cadence resumes within one stall interval + tick. Defined.

### Walkthrough W2 — Postgres down during checks (replayed)

1. Check jobs mid-flight fetch fine (target path independent of PG), classify, then hit persist: Tier 1 transaction errors ⇒ **infra-failure throw** (§15.1 step 5) ⇒ BullMQ retry, attempts 3, exponential from 5 s.
2. Breaker: 5 consecutive infra-failures ⇒ OPEN (§13.3): tick enqueue paused (§14.2 steps 3–4), `Queue.pause()` on `monitor-checks` + `db-writes`; heartbeat keeps firing (the outage stays distinguishable from a Redis outage).
3. **Flush jobs under the new step 0:** the guard pre-check is the FIRST Postgres touch — if PG is already down the job throws *before any `RENAMENX`*, so live keys are never moved and no snapshot is stranded in staging. If PG dies in the window after the snapshot, the transaction fails, retries, and the NX-semantics path from W1-b applies. Either way deltas are retained-or-reapplied, never lost to a misplaced delete.
4. Tick fails at the claim (§14.3) ⇒ abort, `HC_PING_URL/fail` (§14.4 row 2).
5. Alert lane (not paused): committed outbox events deliver; new rows wait `sent_at IS NULL`; outbox-age observability is the detection path (§13.5).
6. Buffers bounded (invariant 4): no new checks run while queues are paused — the J-5 spiral stays broken.
7. Recovery: 60 s OPEN ⇒ HALF_OPEN probe `INSERT INTO write_guards(key) VALUES ('breaker:probe:{ts}') ON CONFLICT DO NOTHING` ⇒ CLOSED ⇒ `Queue.resume()`; skipped monitors self-heal at their next due slot (claims advanced — the accepted J-1 consequence).

**End state:** zero partial writes (Tier 1 atomicity); counters move only for committed results; Redis bounded; the outage visible as heartbeat `/fail`s, DLQ counts, and outbox age. Defined; no new UB.

### Walkthrough W3 — duplicate check-job delivery (replayed under the new batchId/dedup scheme)

Setup: monitor 42 `status='UP'`; job `check:42:{epoch}` delivered twice after a slow first executor.

1. Executor A passes the step-1 re-read, acquires `lock:check:42` (`SET NX PX`), arms renewal (now spanning the whole job lifetime — WR-08).
2. Executor B: `NX` fails while A holds the lock ⇒ B completes successfully without executing. Common case.
3. Slow-A variant: A's lock expires (renewal failures); B acquires, classifies DOWN, runs §16.1: evidence `ping-b`, conditional UPDATE flips UP→DOWN with counters riding the statement, `INSERT … ON CONFLICT (monitor_id) WHERE status='ONGOING'` opens incident `inc-7`, outbox row `incident.down` with non-NULL `incident_id` (the CR-03 contract satisfied by construction — step 3a's RETURNING feeds it, with the SELECT fallback for the swallowed-insert case), COMMIT, release in `finally`.
4. A wakes: renewal compare-and-expire mismatches ⇒ abort immediately, discard, log `lock_lost`, complete without persisting. A writes nothing.
5. Pathological overlap (A committed in the window before noticing): B's conditional UPDATE returns 0 rows ⇒ B records evidence only; counters advanced exactly once; exactly one alert via the single outbox row and `alert:inc-7:down` (`EXISTS` short-circuits the redelivered alert job — TC-DUP-ALERT-01). For a first-check event the key is `alert:{monitorId}:first_check` — monitor-scoped, so monitor 43's simultaneous start alert is NOT suppressed (TC-FIRST-CHECK-DEDUP-01 re-derived: the CR-03 cross-monitor failure mode is structurally gone).
6. Routine (Tier 2) duplicate: both executions `HINCRBY` and `RPUSH` — one duplicate counter delta and one duplicate evidence row, flushed once by the next staging snapshot. Same ±1 accuracy class as cycle 1's OBS-03 (deferred with recorded rationale); transitions/incidents/alerts still cannot double.

**End state:** exactly one ONGOING incident, one outbox row, one alert, counters +1, two evidence pings. Defined.

### Walkthrough W4 — worker SIGKILL past `kill_timeout`, then restarted (replayed)

1. Deploy path: PM2 SIGTERM drains via `worker.close()`; a job past `kill_timeout` 20000 (runbook §5) takes the SIGKILL.
2. Killed mid-Tier-1: the open transaction rolls back at connection death; BullMQ lock expires (30 s); stall detection re-runs; guards + conditional UPDATE make the re-run a near-no-op.
3. Killed mid-flush: W1-b/W1-c sub-cases apply verbatim (staged snapshot re-applied, or cleanup-only) — no path deletes live keys.
4. Killed mid-fetch: nothing written; the re-run fetches fresh.
5. Restart: boot re-upserts every Job Scheduler idempotently (§13.6 step 1); schedulers and the tick resume; breaker resets CLOSED in-process (safe — first infra failure re-arms within a tick). Release gated: first worker release follows §4a (register via `pm2 start`, overlap window with the old cron, M3 continuity verification, web-only rollback); later releases follow §4 (worker restart → poll `:9090/readyz` → only then web restart → synthetic-check smoke asserting the ping row).
6. **Egress layer through a restart (new §15.4/runbook §10):** the host firewall was applied once at Phase 4 provisioning and persists across reboots ("Make the rules survive a reboot") — a worker crash/restart cannot strip it, and `readyz`'s Redis+DB pings re-prove the 6379/5432 exceptions on every boot.
7. Claims: monitors claimed by lost jobs keep advanced `next_check_at` ⇒ exactly those checks are missed (accepted J-1 consequence); each self-heals at its next due slot.

**End state:** zero partial transactions; missed checks bounded to the killed in-flight set; the release counts as good only when `readyz` stayed green and the smoke ping row appears. Defined.

### Walkthrough W5 — per-monitor lock loss mid-check (replayed)

1. A executing; the TTL/3 renewal (owner compare-and-expire) fails — key missing, value mismatch, or Redis error.
2. Response pinned: abort immediately — stop writing, discard the classified result, log `lock_lost`, complete without persisting. Never race a possible new owner.
3. **Timing re-derived with WR-08:** TTL 15 s covers fetch+margin *for the lock alone*; renewal now spans the entire job lifetime including a Tier 1 persist legitimately lasting up to the 30 s `statement_timeout` — so the cycle-1/WR-08 hazard (a slow persist expiring the lock mid-transaction) is closed by design, not by luck. §15.3's row states the same.
4. New owner B: executes and records; if A had already committed before noticing loss, B's conditional UPDATE returns 0 rows and B records evidence only — the D-1 gate remains the correctness mechanism ("correctness never depended on the lock").
5. A discovering loss *after* its own commit: nothing left to abort; the D-1 gate has already handled the overlap — the failure table's abort row applies to the not-yet-persisted case, and no undefined state exists in between.

**End state:** exactly one recorded transition per schedule slot; no undefined window. Defined.

### Walkthrough W6 — auth cutover day (replayed with the amended gate citations)

Preconditions: Phase 7; additive schema in place; canary green on the anonymized snapshot AND in production before any route flip (§12.2 ordering — non-negotiable).

1. **Credentials user U1** (`$2a$` hash in a `providerId:'credential'` account row): `emailAndPassword.password.verify` routes on the hash prefix → bcrypt compare → success → server session + cookieCache TTL 5 min (§12.3); lazy rehash re-stores the modern default (AUTH-09). User id unchanged ⇒ monitors/FKs intact.
2. **Social user U2** (Google): reshaped `account` row resolved by `(providerId, accountId)`; `refreshToken` preserved verbatim; re-linking only if a provider secret rotated (§21-D4). The `providerId`-casing cell remains the deliberately marked D-09 Phase-7 known-unknown.
3. **Unverified user U3**: `requireEmailVerification: true` blocks login; re-request → verify → login. Defined, not a lockout (the lockout A-1 exists to prevent is hash mismatch, removed by prefix routing).
4. Failure path: production canary fails ⇒ abort before the flip; old surface live; legacy tables retained read-only one release (AUTH-07) and the previous tarball pair restorable (runbook §7).
5. **New this cycle:** the gate's ordering is now cited from every planning surface — §12's constraints bullet routes verification through §12.2's hash-prefix routing step; §20 M2 reads "bcrypt compatibility gate (§12.2): canary login on the anonymized snapshot, then production, before any route flip"; §24 step 7 carries the same ordering. A Phase 7 planner reading §20 or §24 (the migration-order table an implementer actually plans from) now sees a blocking ordered gate, not a discretionary pre-investigation — the RR-04/WR-06 failure mode is closed at exactly the surfaces that produced it.

**End state:** both user classes regain access on first re-login; zero monitor-data impact; rollback available. Defined beyond the marked D-09 unknown.

---

## 6. Contradiction sweep + new-edit hunt

### 6.1 Extended sweep (cycle-1 token set)

`uptime recompute` 0; `recompute-uptime` 2 (both sanctioned absent-job listings); `scheduledAt` 0; `spike` 1 (the sanctioned §12.2 gate sentence); `fallback` 7 hits — **each classified by hand**: §12.3 cookieCache DB-session fallback (sanctioned, different mechanism), §13.2's two prohibition statements + §23 item 5's "no fallback write path is exercised because none exists" (the RR-03 fix itself), M1 "Prisma remains read-only fallback" (sanctioned), M7 "no fallback write path exists" (sanctioned), one §7 current-state frontend description (not a design mechanism). Runbook: 0. **No residual contradiction.**

### 6.2 Fix-cycle token drift sweep

| Token | Surfaces stating it | Drift |
|---|---|---|
| `agg:flushing:` / `pings:flushing:` staging keys | §13.1 (L576), §16 Tier 2 prose (L884), invariant 5 (L891), §16.2 (L965–971, L1010–1013), §16.6 (L1082–1083), TC-FLUSH-GUARD-01, TC-MONOTONIC-01 | None — semantics identical everywhere (RENAMENX-created, post-COMMIT staging-only DEL, live keys never deleted) |
| `batchId` / `{epochMs-of-flush-pass}` | §13.1 (L576), §14.1 flush lane, §16.2 pin (L1019), TC-FLUSH-GUARD-01's `flush:1770890760000:42` | None — same shape, same job-data determinism claim |
| Alert key shapes (3) | §13.1 (L580), §16.4 (L1057–1061), TC-DUP-ALERT-01, TC-FIRST-CHECK-DEDUP-01 | None — identical strings, identical NX-EX-86400-after-confirmed-send discipline |
| Egress denylist (11 tokens) + port rules | §15.1 sub-step 2, §15.4, runbook §10 | None — three-way programmatic identity; same-change mandate in all three |
| `check:{monitorId}:manual:{epochMs-of-enqueue}` | §14.1 (L722), §13.1 (L577) | None — same form, same removeOnComplete horizon |
| `TC-SSRF-MAPPED-V6-01` / `TC-FIRST-CHECK-DEDUP-01` | §23 + their marker citations | None |
| Budget wording (≤ 30 / ≤ 31) | §25.1, runbook §1 | None — mirror pair |
| **`agg:pending`** | §13.1 (L575) **only** | **Orphan — RR2-01** |

### 6.3 New-edit hunt (sections carrying fix-cycle markers)

Checked pairs the plan named, plus this reviewer's own:

- **§15.4 port rules vs §15.1 fetch behavior** — no contradiction on ranges (identical) but a classification consequence is unpinned for host-firewall-refused connects: advisory **RR2-02**.
- **§14.1 manual-advance vs §14.2 step 3 / §14.3 claim** — consistent: the manual advance is the same atomic UPDATE shape, both jobId forms mirrored in §13.1, and advancing from `now()` can only pull a drifted future due-slot *earlier* (more checks, never fewer); the scheduled claim remains the only due-selection path.
- **§16.2 bulk INSERT vs §11 column contract** — identical column lists (L901/L993), id omitted per the D-3 pin; **vs §13.7 retention volume** — per-check ping volume restored, batch-5000 loop unchanged, the §16.2 natural-row-bound note (1–2 rows/pass at 1-min interval) consistent with the 30 s flush cadence.
- **§16.2 UPDATE (unconditional `WHERE id`) vs monitor deletion mid-window** — a monitor deleted after checks staged but before flush makes the bulk INSERT fail the FK deterministically; the dead-letter disposition (§16.6 inspect-only) already covers the outcome but the retry classification is unpinned: advisory **RR2-03**.
- §13.1 staging/dedup/limiter rows vs §16.2/§16.4/§12.4 — identical. §25.1 vs runbook §1 — identical. §13.8's new web-Redis budget — conflicts with nothing (no other surface budgets Redis connections). Runbook §3 step 3 vs §2 row 3 vs §8 — identical phase-conditional; §4a vs §4 step 4 vs §9 — reciprocal pointers, no overlap in retirement scope. §20 M2 / §24 step 7 vs §12.2 — gate ordering now cited identically. No new blocking contradiction introduced by the fix cycle.

### 6.4 D-10 parameter-cell re-audit

Every parameter table cell re-read carries a concrete value + rationale + class: §11 (4 rows), §13.10 (7), §14.1 (nine lanes, explicit Priority on every row), §14.5 (5), §15.3 (6), §16.2 batchId (1, new), §25.4 (8), runbook §5 (5, with Why cells). "none — <reason>" rate-limit cells are pinned decisions. **No unpinned cells.**

---

## 7. Findings (numbered for the ratification checkpoint)

**Zero blocking findings. Three advisory observations**, all transcription-completeness notes outside the §9/§10 battery — the same class cycle 1 recorded as non-blocking observations (OBS-01..06) while still numbering its real gaps RR-01..04. None contradicts a checklist item, a criterion, or a locked decision; each carries a one-line fix consumable by Phase 4/5 without reopening the design.

**RR2-01 — ADVISORY (non-blocking). `agg:pending` is an orphan key-inventory entry.**
- **Anchor:** audit §13.1, live-buffers row — "+ `agg:pending` (set of monitor ids with unflushed deltas)" (L575); zero other occurrences in either document (grep-verified).
- **What is open:** no section specifies the set's writer or reader — §15.1 step 6 writes only the hash + list; §16.2 reads only live/staging hash + list; §14.1 says the flush-pass scheduler "creates one job per monitor per pass" without saying which monitors (all active vs `agg:pending` members). Not a correctness gap: §16.2's missing-key no-op path ("neither live key exists and neither staging key for this batch exists → complete successfully without opening a transaction") makes either selection strategy well-defined and safe. The token predates the fix cycle entirely (introduced with the original addenda in commit `1601c2b`, plan 01-01) — missed by cycle 1 and the code review, not a fix-cycle regression; surfaced now because the fix cycle made the surrounding row load-bearing.
- **One-line fix:** either delete the `agg:pending` token from §13.1 or state its consumer (e.g., "flush-pass iterates `agg:pending` to select monitors with unflushed deltas"). Phase 4 transcription settles it either way.

**RR2-02 — ADVISORY (non-blocking). Host-egress port rule's classification consequence is unpinned.**
- **Anchor:** audit §15.4 — "Egress to the public internet is allowed on ports 80/443 only" (L866) and runbook §10 rule (b); cf. §15.1 step 4 sub-step 1 (scheme allowlist admits `http`/`https` on any port) and step 5's `error_class` vocabulary.
- **What is open:** a monitor URL such as `https://example.com:8443` passes engine validation (scheme https, public IP) but the dial is refused at the host boundary ⇒ result DOWN. No section states this consequence or pins the `error_class` for a firewall-refused connect (`network` is the natural bucket; `ssrf_blocked` would misclassify — the address set matched). The behavior itself is **mandated by review S-1 layer 1's own text** ("allow only 80/443 egress"), so this is a missing consequence note, not a contradiction; but a Phase 4/5 operator will see monitors on non-standard ports flip DOWN at worker cutover with no documented explanation — worth one sentence before that surprises someone mid-incident.
- **One-line fix:** add to §15.4 (or §15.1 step 5): "Connections refused by the host egress layer classify as DOWN with `error_class='network'`; monitors on non-80/443 ports read DOWN by design from Phase 4 (S-1 layer 1)."

**RR2-03 — ADVISORY (non-blocking). Flush FK-violation retry classification unpinned.**
- **Anchor:** audit §16.2 step 1's bulk INSERT (L993) + the unconditional `WHERE id = $mid` UPDATE; cf. §13.5's permanent-vs-retryable rule and §16.6's dead-lettered-flush row.
- **What is open:** a monitor deleted between a routine check and its flush leaves staged evidence rows whose INSERT fails the `pings → monitors` FK **deterministically**. The outcome is fully specified (bounded attempts ⇒ dead-letter ⇒ §16.6 inspect-only, zero data impact — the monitor is gone), but the spec does not say a deterministic FK violation should throw `UnrecoverableError` per §13.5's permanent-failure pattern, so a literal transcription burns 5 attempts on a can-never-succeed job — ops noise only.
- **One-line fix:** one clause in §16.2 or §16.6: "a bulk-INSERT FK violation (monitor deleted mid-window) is a permanent failure — throw `UnrecoverableError`; disposition stays the §16.6 inspect-only row."

**Blocking vs advisory split: blocking — none; advisory — RR2-01, RR2-02, RR2-03.**

---

## 8. D-18 cycle accounting

This execution is **re-review cycle 2 of 2 (final)**. Cycle 1 (01-REREVIEW.md) found RR-01..RR-04; the human ratified gaps; the fix cycle ran as plans 01-06 (CR-01/02/03 + IN/OBS residuals + git-tracking the verdict record), 01-07 (WR-03/04/05 + IN-05 runbook half), 01-08 (RR-01..04 + WR-01/02/07/08 + IN-01/05 + OBS-04/05). This cycle re-derived every closure (§2), re-ran the full §9/§10/walkthrough battery (§3–§5), and swept the fix-cycle edits themselves for new contradictions (§6). Per D-18: on a **ratified clean pass** the verdict flips per D-16 (plan 01-09 Task 3); on **ratified gaps** the verdict stands NOT READY with the findings permanently escalated — no third cycle and no READY-with-exceptions state exists. The three §7 advisories are recorded observations in the cycle-1 OBS class, consumed by Phase 4/5 as design-debt notes; they are not verdict-gating findings.

---

## 9. Verdict recommendation (input to the Task 2 ratification gate)

**CLEAN PASS — zero blocking findings.**

Everything the gate depends on held up under this cycle's adversarial re-derivation:

- All 7 fix-cycle finding families verified **actually closed in the document text** (§2): the four ratified gaps (egress layer present and identical three-way; all three residual contradictions removed with file-wide negative greps), and the three criticals (bulk ping INSERT inside the guarded transaction; RENAMENX staging exclusivity + staging-only DEL + pinned batchId — both CR-02 failure modes independently re-derived as closed; three-key dedup + non-NULL contract + cross-monitor test).
- All 16 folded advisories closed at their named surfaces; the three deferred observations carry recorded rationale, not silence.
- §9: 25/25 trace; S-1 now two-layer. §10: 3/3 satisfied, criterion 2 under the interpretation the human already ratified at cycle 1.
- All six walkthroughs end in defined, observable states on the amended specs — including the three crash-window sub-cases the new staging-key flush creates, each of which this cycle stepped through concretely.
- The fix cycle introduced no new blocking contradiction; three advisory notes remain (§7), each a one-line Phase 4/5 consumable.

Recommendation to the human: ratify the **clean pass**, enabling the D-16 verdict flip in Task 3. If the human instead judges any §7 advisory (or any new consideration) verdict-gating, the canonical gaps response selects the permanent-escalation branch — D-18 admits no middle state.

---

## 10. Ratification record (plan 01-09 Task 2 — closed 2026-09-09)

**Decision line (verbatim, 2026-09-09):**

> ratify clean pass

- **Canonical classification:** the reply carries the canonical token unparaphrased — no bracketed annotation required. Executed branch: **clean pass**.
- **Interpretation:** the human accepts this report's §9 recommendation as-is — zero blocking findings; the three §7 advisories (RR2-01, RR2-02, RR2-03) are recorded as non-gating design-debt notes consumed by Phases 4–5; the D-16 verdict flip is authorized.
- **Scope:** the ratification binds the cycle-2 outcome as a whole — the §2 closure audit, the §3–§5 battery (§9 checklist, §10 criteria, walkthroughs W1–W6), and the §6 sweeps. It is the FINAL D-18 gate (cycle 2 of 2): no further review cycle exists between this decision and the implementation phases.
- **Downstream action:** plan 01-09 Task 3 executes the D-16 flip — recorded in §11 below.

## 11. Verdict record (plan 01-09 Task 3 — executed 2026-09-09, clean-pass branch)

**Verdict flipped to READY per D-16. D-18 accounting: cycle 2 of 2 (final) — the loop terminates in the clean-pass terminal state; no third cycle and no READY-with-exceptions state exists.**

- **Pre-flip integrity (passed):** `git hash-object docs/ARCHITECTURE-REVIEW.md` re-verified equal to `520c9409da45bd2c9ab9866fe124403ef6cb7ef3` (the tracked NOT READY blob) immediately before the edit — no drift since Task 1's read-only review.
- **Flip action:** §1's first H1 replaced in place (`❌ NOT READY` → `✅ READY`), carrying the flip date (2026-09-09) and reviewer identification (this cycle-2 adversarial re-review + the §10 human ratification). A history subsection preserves the original NOT READY heading, date, and reasoning block verbatim, with the flip reason (cycle-2 clean pass ratified per D-16/D-18). An appended end-of-document Re-review section narrates both cycles end-to-end. The §9 checklist boxes and §8 addenda are untouched — they are the reviewer's record, not the verdict's.
- **Advisory design-debt carried forward (non-gating):** RR2-01 — `agg:pending` orphan key-inventory token (delete it or state its consumer; audit §13.1 L575); RR2-02 — host-egress 80/443 refusal classification consequence unpinned (one sentence: firewall-refused connects classify DOWN with `error_class='network'`; audit §15.4 / §15.1 step 5); RR2-03 — flush bulk-INSERT FK violation on a monitor deleted mid-window should throw `UnrecoverableError` (permanent failure), not burn retries (audit §16.2 / §16.6). **Consumed by Phases 4–5** at transcription time; each one-line fix is restated in §7 above.
- **Tracking truth:** ROADMAP.md Phase 1 checkbox checked with a dated completion note (and the Phase-1-only `**Mode:** mvp` marker deleted per the 01-VERIFICATION round-2 disposition); REQUIREMENTS.md DSGN-02 marked Complete (checkbox + traceability row); STATE.md design-gate blocker cleared. The flip is a single reviewable commit against the tracked NOT READY blob.

---

*Report: 01-REREVIEW-2.md · Reviewer session: plan 01-09 wave 8 executor · 2026-09-09 · D-18 cycle 2 of 2 (final)*
