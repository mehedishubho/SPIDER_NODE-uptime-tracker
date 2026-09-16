# Phase 5 add-release — deploy record

> **Date:** 2026-09-16 · **Plan:** 05-07 · **Release SHA:** `7b5a997` (worker + web from this one commit) · **Prior release:** `9f667e2` (04-09 dark launch, retained per DEP-03)
> **What this is:** the D-36 pipeline's deploy+soak step — the rehearsal-PASS add-release (`7b5a997`, run 5, [05-REHEARSAL-EVIDENCE.md](./05-REHEARSAL-EVIDENCE.md)) deployed to the operator-ratified stand-in-production topology and soaking in **dark-launch posture (D-07/D-16): `WORKER_SCHEDULER_ENABLED=false`, legacy cron serving 100% of user checks**. The real cutover window is NOT opened here — that is 05-08, gated on this record.
> **Rollback is:** stop worker + web, restore the retained `9f667e2` tarball (data last resort: the pre-release dump below). All timestamps UTC.

## Topology — operator-ratified local stand-in (03-08, unchanged from 04-09)

Same table as the [04 deploy record](../04-monitoring-worker-build-dark-launch/04-DEPLOY-RECORD.md): `spidernode-dev-db` (postgres:17-alpine, 127.0.0.1:5454, db `uptime_dev`), `spidernode-prod-redis` (redis:7-alpine, 127.0.0.1:6391, requirepass — password only via `$(cat .snapshots/spidernode-prod-redis.pass)`, never echoed), web = `pnpm start` on :3007 (explicit `REDIS_URL` → 6391 per the 04 split-brain guard; ambient `.env` points at the TEST 6390 stack), worker = `node dist/worker.js`, health on :9090. Nothing here touches the 5453/6390 test stack.

## Pre-flight gates

| Gate | Result |
|---|---|
| Full D-30 rehearsal on the add-release SHA (D-31/D-32) | **PASS — run 5** (2026-09-16 08:46 → 09:34:32Z, ~49 min): 10/10 legs GREEN; gates pass A (D-16 refusal — scheduler flag cannot be flipped in-place) + pass B **7/7 PASS**; co-run 45 min / 181 samples / 63 pings / 0 incidents with cron + scheduler simultaneously live; induced incident (monitor 4, `513a3d60`) → 3 events, exactly 1 relay attempt each, rows FAILED under the dummy token (D-34); `seededChatOwner: true` (throwaway chat id bound — stand-in only); abort drill pings 776→777 with a natural cron pass inside the paused interval, re-unpause ACTIVE. Evidence: [05-REHEARSAL-EVIDENCE.md](./05-REHEARSAL-EVIDENCE.md) |
| `pnpm verify` at the release commit | non-browser chain GREEN (lint, typecheck, unit, schema:gate, worker:boundary, denylist:diff, build); e2e **API project 18/18 GREEN**; e2e **browser specs could not run** — machine-local Chromium spawn denial (appeared after the 2026-09-16 outage/reboot; revision 1228 spawns, 1243 gets `Permission denied` deterministically, identical suite was green on 04-09) — logged in [deferred-items.md](./deferred-items.md), **not a code finding** |
| Rehearsal fixes re-rehearsed in full (D-36) | 3 harness fixes (`de5956a` docker-cp path, `61dfbdc` induce chat-owner, `7b5a997` byteMatch subset) — each red item triggered a FULL `--leg all` re-run per D-31/D-32; no `src/` change at any point |

## D-31 same-SHA discipline (rehearsed artifact == deployed artifact)

| Surface | Value |
|---|---|
| Rehearsal build SHA (run 5, evidence file) | `7b5a997` |
| Rehearsal worker bundle sha256 | `847280f10b981b00…` (builtAt `2026-09-16T08:48:37.189Z`, journal 2) |
| Deployed `dist/worker.js` sha256 (main tree) | `847280f10b981b00…` — **byte-identical**: every failed main-tree rebuild attempt (transient `0xC0000005` native crashes) died before the tsup step, so the working-tree worker bundle remained the rehearsed bytes |
| Deployed worker boot log (live) | `"sha":"7b5a997","builtAt":"2026-09-16T08:48:37.189Z"` |
| Deployed web `.next` | clean-worktree build at `7b5a997` (BUILD_ID `U2bc8Q_qaWaG5D2_HDrlR`), swapped wholesale; the web exposes no sha endpoint — provenance is the commit checkout (D-06 form) |
| Diff | **none** — rehearsal SHA == deployed SHA == `git` HEAD at build |

## §7 retention — BEFORE any restart step (DEP-03, the ordering the record must show)

1. **Pre-release backup:** `docker exec spidernode-dev-db pg_dump -U postgres -F c uptime_dev > .snapshots/pre-add-release-20260916-101543.dump` — 36,521 bytes, custom format (PGDMP), taken **10:15:43Z**; path also recorded in `.snapshots/add-release-backup-path.txt`.
2. **Retained previous release (rollback target):** `.snapshots/uptime-tracker-9f667e2.tar.gz` — 140,385,907 bytes, rebuilt+packed from the pre-change tree (07:58Z) because the working copy had moved to the add-release; contains the 04-09 `.next` + `dist` + generated Prisma client; no `.env` inside.
3. **Add-release tarball:** `.snapshots/uptime-tracker-7b5a997.tar.gz` — 142,442,187 bytes, packed 10:15Z **after** syncing the worktree's `dist/worker.js` to the rehearsed bytes, so tarball == deployed == rehearsed worker artifact.

Both artifacts predate the 10:16:25Z worker restart. GREEN.

## §4 step 3 — Migrate (zero-pending assert)

`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5454/uptime_dev pnpm exec drizzle-kit migrate` → exit 0 ("migrations applied successfully" — the no-op path); journal unchanged at 2; no new `.sql` under `drizzle/` in this plan. GREEN.

## §4a step 1 — Worker restart + readyz gate (worker gates the release)

Started 10:16:25Z (pid 40020, `WORKER_SCHEDULER_ENABLED=false WORKER_HEALTH_PORT=9090 node dist/worker.js`, explicit stand-in DB/Redis env). Boot log (`.snapshots/add-release-worker.log`, quoted verbatim):

```json
{"level":30,"time":1789553785704,"pid":40020,"hostname":"DESKTOP-93PJ1VS","sha":"7b5a997","builtAt":"2026-09-16T08:48:37.189Z","healthPort":9090,"schedulerEnabled":false,"pid":40020,"msg":"worker booted"}
{"level":30,"time":1789553785706,"pid":40020,"hostname":"DESKTOP-93PJ1VS","msg":"scheduler flag OFF — skipping all Job Scheduler upserts (D-16 dark launch)"}
```

`readyz` 200 on the first poll — `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}` (re-verified 13:07:10Z). Consumers live; zero scheduler upserts. GREEN — the release proceeded to the web step only after `readyz` passed.

## Web restart

`pnpm start` :3007 ~10:16:40Z → `/login` 200 in ~3s; instrumentation banner: INTERNAL cron, 1-min checks, 15-min flush, daily cleanup. GREEN.

## Seed + smoke (D-19/D-18)

- **Seed (idempotency re-proven):** `scripts/seed-synthetic.sql` applied twice — `INSERT 0 0` both times; smoke monitor id=3 "SpiderNode Smoke Check (operator)" already present from 04-09.
- **Enqueue smoke (worker path):** jobId `check-manual:3:1789553820984` enqueued 10:17:00.984Z → worker Tier-1 persist line at 10:17:01.087Z (`durationMs: 91`, `applied: false` — correct: monitor 3 was already UP, so this is the duplicate-safe evidence-only path per DAT-04) → **ping row landed: status UP, responseTime 59ms**. GREEN — enqueue → Redis/BullMQ → worker consumer (scheduler OFF) → Tier-1 transaction → Postgres, on the deployed artifact.

## D-04 live pin — authenticated manual check lands IN-REQUEST (the route-level half)

Proof script (one-off, gitignored): real NextAuth credentials login as the synthetic sentinel `spidernode-ops-smoke` (armed inside the stand-in DB with a throwaway bcrypt password + `emailVerified` — synthetic values, no real user touched, no secret reads anywhere), then `POST /api/monitors/3/check` and an immediate pings read. The route awaits `flushBatches()` before responding, so a visible row equals an in-request flush — no sleep, no retry. Complements 05-01 Task 4's automated awaited-flush test.

```json
{
  "verdict": "PASS",
  "auth": { "flow": "credentials (real NextAuth login)", "loginStatus": 200 },
  "request": { "monitorId": 3, "durationMs": 134 },
  "flushProof": {
    "pingsBefore": 19, "pingsAfter": 20,
    "dbClockPrePost": "2026-09-16 12:56:19.563665+00",
    "newestPingCreatedAt": "2026-09-16 12:56:19.689",
    "newestPingStatus": "UP", "newestPingResponseTimeMs": 34,
    "landedInRequest": true
  }
}
```

The row was created at 12:56:19.689 — after the pre-POST DB clock read (12:56:19.563665) and before the response completed (12:56:19.697). Web log corroborates the route-triggered flush: `[DB Batcher] Flushing 1 pings and 1 monitor updates… Flush completed successfully`. **GREEN — the ping row + monitor status were visible immediately, not deferred to the 15-minute batch flush.**

## Soak proofs — dark-launch posture (D-07/D-16)

| Proof | Observed (capture 13:04–13:07Z unless noted) |
|---|---|
| `/metrics` spidernode_ exposition (:9090) | 35 `spidernode_` sample lines across 8 families: `queue_depth`, `queue_oldest_job_age_seconds`, `queue_stalled_events`, `outbox_unsent`, `outbox_failed`, `outbox_oldest_age_seconds`, `outbox_alert_latency_seconds`, `redis_memory_percent` |
| `/metrics.json` carries `oldestUnsentSeconds` | present — `outbox: { unsent: 0, failed: 0, oldestUnsentSeconds: null }` (null = nothing unsent; healthy-empty), `gitSha: "7b5a997"` |
| Queue state | all six lanes (monitor-scheduler, monitor-checks, db-writes, alerts, maintenance, email-transactional) depth 0; `stalledCount` 0; no `oldestWaitingJobAgeMs` |
| Worker boot log scheduler-off | quoted above — `schedulerEnabled: false` + the D-16 skip line (prohibition check: `WORKER_SCHEDULER_ENABLED` stays false in the deployed env; heartbeat wiring rides inert) |
| `readyz` | `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}` |
| Legacy cron fires every minute | web log grows one full block (`🔄 Internal Cron Triggered` → `[Cleanup Job] … Deleted 0` → `✅ Cron check completed`) per minute — file mtimes **13:04:00Z** (556 lines) → **13:05:00Z** (559 lines), 70s apart |
| Recent pings landing from the cron path | monitor 2 "Test" (interval 1 min): **855 pings / newest 12:44:00.038** at 12:58:01Z → **870 pings / newest 12:59:00.042** at 13:05:48Z — exactly the 15 one-minute checks 12:45:00–12:59:00, landed by the wall-clock **13:00:00Z DB-batcher flush** (the batcher's designed 15-min in-memory window; mid-window DB reads legitimately show the previous boundary) |

**Resilience observation worth recording:** during the executor's quota-kill window (~12:30Z, machine blocking IO), node-cron WARNed two missed executions (12:30:02Z, 12:31:02Z — "Possible blocking IO or high CPU user"). The app self-recovered: the 12:45:00Z flush carried **29 pings (two windows merged), zero ping loss**, and per-minute ticks resumed immediately. That is the `db-batcher` + missed-tick semantics behaving exactly as designed under real machine stress.

## Rollback record (DEP-03)

- **Artifact rollback:** stop worker + web → untar `.snapshots/uptime-tracker-9f667e2.tar.gz` (previous release, self-contained: `.next` + `dist` + generated Prisma client) → restart per runbook §4.
- **Data last resort:** `.snapshots/pre-add-release-20260916-101543.dump` (pre-restart, 10:15:43Z).
- **In-place de-escalation (no rollback needed for scheduler risk):** the add-release runs scheduler-OFF; the 05-08 window is the only thing that flips it, and gate A of the rehearsal proved the flag refuses in-place flips (D-16).

## Deviations

1. **Local stand-in topology** (03-08 operator ratification, recurring from 04-09): VPS steps adapted — `docker exec` pg_dump, plain processes; the 04 record's N/A-locally dispositions (PM2 handshake, SIGTERM flush, OS egress, systemd Redis) carry forward unchanged.
2. **Build provenance via a clean git worktree at `7b5a997`:** transient Windows native crashes (`0xC0000005`) killed the main tree's post-rehearsal rebuild attempts before tsup ever ran, so the main-tree worker bundle stayed byte-identical to the rehearsed artifact (sha256-verified above) and was deployed as-is; the web `.next` came from a clean-worktree build of the same commit (worktree `dist/` was synced to the rehearsed bytes before packing the add-release tarball, making tarball == deployed == rehearsed for the worker). Bundle bytes are nondeterministic across rebuilds of the same commit (worktree's fresh worker bundle hashed `5da04f6a43f32125…`) — D-31 pins the commit SHA plus deployed-worker byte equality with the rehearsal, both of which hold. Worktree removed after packing.
3. **Sentinel armed for the authenticated proof:** the first proof approach (minting a session JWT by reading `NEXTAUTH_SECRET` from `.env`) was **denied by the permission system** (deny-rule circumvention) and was correctly NOT worked around; the replacement authenticates through the real credentials flow, which required setting a throwaway bcrypt password + `emailVerified` on the **synthetic sentinel user inside the stand-in DB only**. No real user row was modified; no secrets were read, echoed, or persisted.
4. **e2e browser specs blocked by a machine-local spawn denial** (see Pre-flight): not a code finding — identical suite green on 04-09; API-project e2e 18/18 at the release commit; tracked in deferred-items.md.
5. **Quota interruption mid-deploy soak:** the executor was killed by a provider 429 at ~12:31Z and resumed ~12:50Z; the deployed stack ran unattended through the gap (evidence above — the only visible effect is the two WARNed missed ticks, self-recovered with zero loss).

## Timings (UTC)

| Step | Time |
|---|---|
| Previous-release tarball rebuilt + packed | 07:58Z |
| Rehearsal run 5 (full `--leg all`) PASS | 08:46 → 09:34:32Z (~49 min) |
| Add-release tarball packed (worktree dist synced first) | 10:15Z |
| Pre-release `pg_dump` backup | 10:15:43Z |
| Migrate no-op (journal 2) | ~10:16Z |
| Worker start → `readyz` 200 | 10:16:25Z, first poll |
| Web start → `/login` 200 | ~10:16:40Z (~3s) |
| Seed applied (×2, `INSERT 0 0`) | ~10:16:50Z |
| Enqueue smoke → ping row | 10:17:00.984Z → 10:17:01.087Z (Tier-1 91ms) |
| D-04 manual-check live pin (in-request flush) | 12:56:19Z (134ms) |
| Soak captures (metrics/readyz/cron observation) | 13:04 → 13:07:10Z |

## Verdict

**GREEN — the add-release is live and soaking in the exact posture the dark launch proved.** Same-SHA rehearsal PASS on the deployed artifact (D-31/D-32), rollback target retained before anything changed (DEP-03), worker `readyz`-gated ahead of the web restart, scheduler inert with the boot log to show for it, legacy cron serving 100% of checks with pings landing on cadence, the D-04 in-request flush pin landed through a real authenticated request, and the queue/outbox surfaces are all zeros. **Window day (05-08) can be scheduled.**

---

## 05-08 window — Task 1 pre-window verification (2026-09-16 ~15:05Z)

> **Status: BLOCKED at the Task 1 operator gate — the real-check URLs are NOT yet in the live worker env.** The window may not open until they are (D-37: the wiring is inert before it, which is exactly why provisioning aligns with window-open).

**Soak state re-verified alive before anything was touched:** worker `readyz` green (pid 40020, `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}`), web `/login` 200 on :3007, `spidernode-dev-db` (:5454) + `spidernode-prod-redis` (:6391) up ~7 h — the 05-07 dark-launch posture is intact.

**Carry-forward re-verification (deferred-items.md):** the Playwright browser-spec spawn denial has **self-resolved** — browser project **6/6 passed (13.9 s)**, API project **12/12 passed (3.0 s)** at the release commit, with no reinstall, ACL change, or code change. Deferred item closed before window day as required.

**Task 1 verification (masked output only — var names, UUIDs, counts; never values, keys, or ping URLs):**

- Operator reports the three REAL dead-man checks provisioned (paging ON, graces 10/5/30 min per D-25) and the window scheduled.
- The only env file carrying the `WORKER_*_HC_PING_URL` family is `.snapshots/rehearsal-hc-env.sh` (created for the D-37 throwaway rehearsal checks). All three URLs in it resolve (hc.io flips endpoint HTTP 200 for each derived UUID) — but the account's check list shows exactly 4 checks: `rehearsal-heartbeat` / `rehearsal-outbox` / `rehearsal-memory` (grace 3600 s, **0 channels**, 4 pings each — the throwaways) and the account-default `My First Check` (new, 0 pings). **None match the D-25 real profile (grace 600/300/1800 s, paging channels > 0)** — the file still points at the throwaway checks, which page nobody. (If the real checks were created in a non-default hc.io project, the list call cannot see them — moot until the URLs are placed.)
- `HC_READ_ONLY_API_KEY` present alongside (length 32) — reused for gate-1 flips evidence per the operator note.

**Action handed to the operator (blocking):** paste the three real ping URLs **and the real `TELEGRAM_BOT_TOKEN`** (required for the D-11 real-delivery parity leg) into `.snapshots/live-worker-hc-env.sh` (template created, gitignored; values never transit chat or evidence files), and name the induced-parity monitor plan (owner account with real Telegram binding + target form, 05-06's TEST-NET-3 sibling-container precedent). On resume: masked re-verification (var name + length + hc.io check profile), then Task 2 window-open choreography.

**Throwaway-check note:** the three `rehearsal-*` checks (D-37: "deleted after") still exist — inert; delete at leisure post-window (logged in deferred-items.md).

### Task 1 re-verification after the operator's "checks provisioned" reply (2026-09-16 ~15:20Z) — STILL NON-CONFORMING, window NOT opened

The operator saved `.snapshots/live-worker-hc-env.sh` and replied "checks provisioned". Masked re-verification (var names, UUIDs, counts — never values):

- All four vars present with sane shapes: the three ping URLs (lengths 56/56/57, host `hc-ping.com`) and `TELEGRAM_BOT_TOKEN` (length 46 — Telegram bot-token shape).
- **The three derived UUIDs are byte-identical to the rehearsal throwaway checks** (`3a39dd76…` heartbeat, `3a6054f8…` outbox, `9f6fb0b4…` memory — the same UUIDs `.snapshots/rehearsal-hc-env.sh` carries). The account check list is unchanged: 4 checks total — `rehearsal-heartbeat`/`rehearsal-outbox`/`rehearsal-memory` (grace **3600 s**, **0 channels**, 4 pings each) + `My First Check` (new). **No check matches the D-25 real profile (grace 600/300/1800 s, paging channels > 0).**
- Minor paste artifact: the memory URL carries one stray character (57 vs 56 chars, same UUID tail — likely a mid-path double slash), which would mis-shape the `/fail` ping form.

**Verdict: the pasted values appear copied from `rehearsal-hc-env.sh` (the throwaway checks), not from the newly provisioned real checks.** Either the real checks were provisioned in a different healthchecks.io account/project than the one the read-only key sees, or the wrong URLs were copied. Per the pre-committed rule the window is NOT opened on non-conforming checks — a paging dead-man that pages nobody defeats gate 1's entire premise (D-17: the dead-man switch IS the monitor). Operator directed to re-paste the three REAL check ping URLs (from the real checks' pages — names/graces per D-25, integrations ON) into `.snapshots/live-worker-hc-env.sh`.

### Task 1 verification round 3 (2026-09-16 ~15:35Z) — URLs now NEW and resolvable, but the D-25 profile is UNVERIFIABLE with this key; window still NOT opened

The operator re-pasted. Masked verification:

- **File shapes now clean:** three ping URLs all length 56, host `hc-ping.com`, no trailing/extra slashes; `TELEGRAM_BOT_TOKEN` present (length 46).
- **The three UUIDs are NEW** (`7434b1d4…` heartbeat, `831d2ecf…` outbox, `aa6be726…` memory) — not the throwaway set, and all three resolve on the flips endpoint (HTTP 200). A negative control (random valid-format UUID) returns 404, so the endpoint discriminates: checks with these UUIDs genuinely exist.
- **But the read-only key's check list still shows only the 4 old checks** (the three `rehearsal-*` + `My First Check`) — unchanged by the `?project=` probe (0–5 all return the same set; the parameter is not honored by this key). The three new checks are therefore outside this key's visible scope: a different project in the account, or a different account entirely (the flips-by-uuid path resolves regardless, which is why gate 1's endpoint answers 200).
- Consequence: **graces (600/300/1800 s) and paging channels (> 0) cannot be confirmed via the API** with the current key — and per the pre-committed rule the window does not open on an unverified dead-man. Notably the `rehearsal-*` checks now show `status=new, pings=0` (pings were cleared between rounds) — they remain inert non-paging checks regardless.

**Operator directed to one of two mechanical fixes (either makes verification complete):** (1) move the three real checks into the project this read-only key reads (dashboard move), or (2) paste a read-only API key FROM the project/account holding the real checks into `.snapshots/live-worker-hc-env.sh` as `export HC_REAL_CHECKS_API_KEY=…`. On the next resume the same masked verification must show the three checks by name with the D-25 graces and channels > 0 before Task 2 runs.

### Task 1 verification round 4 (2026-09-16 ~15:50Z) — `HC_REAL_CHECKS_API_KEY` added, but its scope is the SAME project as the old key; window still NOT opened

The operator chose fix (2) and saved `HC_REAL_CHECKS_API_KEY` into `.snapshots/live-worker-hc-env.sh`. Masked verification:

- **File shapes re-confirmed clean:** three ping URLs all length 56, host `hc-ping.com`, no trailing slash, UUID tails `7434b1d4…` / `831d2ecf…` / `aa6be726…` (unchanged from round 3); `TELEGRAM_BOT_TOKEN` present (length 46); `HC_REAL_CHECKS_API_KEY` present (length 32, hc.io read-only-key shape).
- **Flips with the NEW key: HTTP 200 for all three real UUIDs; negative control (random valid-format UUID) returns 404.** Same as with the old key — the flips-by-uuid endpoint resolves existence regardless of key scope; it is not membership evidence.
- **The NEW key's check list shows the identical 4 checks as the old key:** `rehearsal-heartbeat` / `rehearsal-memory` / `My First Check` / `rehearsal-outbox` — all grace **3600 s**, **0 channels**, `status=new`, 0 pings. **Zero checks match the D-25 profile (grace 600/300/1800 s, paging channels > 0), and the three real UUIDs appear nowhere by name.**

**Verdict: the new key was created in the same hc.io project that holds the rehearsal throwaways, not in the project/account holding the real checks.** Both keys now demonstrably read the same scope; re-pasting another key from that project cannot fix this. Operator must either (1) move the three real checks into the project both keys read (dashboard move — the checks will then appear by name with D-25 graces and channels), or (2) create the read-only key while viewing the hc.io project that actually contains the three real checks (the tell-tale of success: the list under `HC_REAL_CHECKS_API_KEY` shows the real checks by name with grace 600/300/1800 s and channels > 0, and no longer shows the `rehearsal-*` throwaways). The window remains closed — gate 1's dead-man premise (D-17) requires the paging profile verified before the first unpause.

### Task 1 verification round 5 (2026-09-16 ~16:05Z) — checks recreated FRESH, but in the WRONG hc.io ACCOUNT (flips 403); window still NOT opened

The operator recreated the three real checks fresh and the file now carries three NEW ping URLs (derived UUIDs `c714c362…` heartbeat, `4435f8da…` outbox, `6f24368c…` memory); round-3/4 UUIDs orphaned. `TELEGRAM_BOT_TOKEN` (46) and `HC_REAL_CHECKS_API_KEY` (32) unchanged. Masked verification:

- **File shapes clean:** three URLs length 56/56/56, host `hc-ping.com`, no trailing slash.
- **Both keys' check lists are IDENTICAL to round 4:** exactly 4 checks — `rehearsal-heartbeat` / `rehearsal-memory` / `My First Check` / `rehearsal-outbox`, all grace 3600 s, channels 0, `status=new`, 0 pings. **The names `worker-heartbeat` / `worker-outbox-age` / `worker-redis-memory` appear NOWHERE; no readable check carries the D-25 profile.**
- **Flips discrimination this round is decisive:** the three NEW UUIDs return **HTTP 403** with the real key, while the negative control (random valid-format UUID) returns 404 — so the new checks EXIST but are FORBIDDEN to this key. Meanwhile the three ORPHANED round-3/4 UUIDs still return **HTTP 200**. Since the flips endpoint answers 200 for same-account checks even outside the key's project (the orphans prove this), 403 on the new UUIDs means they were created under a **different healthchecks.io account** than the one both API keys belong to.

**Root cause established across rounds 3–5:** the operator's hc.io login context keeps drifting — rounds 3/4 produced checks in the right account's other project (flips 200, list-hidden); round 5 produced checks in a different account entirely (flips 403). The keys we hold have never been the constraint; the checks' LOCATION has been.

**Required fix (one pass, then verification completes):** create the three checks INSIDE the account whose dashboard shows `rehearsal-heartbeat` / `rehearsal-memory` / `rehearsal-outbox` / `My First Check` — ideally directly in that default project (Add Check there: `worker-heartbeat` grace 10 min, `worker-outbox-age` grace 5 min, `worker-redis-memory` grace 30 min, paging integrations ON for each) — then copy each new ping URL into `.snapshots/live-worker-hc-env.sh`. This also satisfies gate 1 at window end, which queries flips with `HC_READ_ONLY_API_KEY`: the heartbeat check must be readable by THAT account's key or gate-1 evidence fails. Tell-tale of success on the next resume: the check list under either key shows the three names with graces 600/300/1800 s and channels > 0, and flips on the derived UUIDs returns 200. The window remains closed until then (D-17).

### Task 1 verification round 6 (2026-09-16 ~16:25Z) — CONFORMING: D-25 profile verified via API; Task 1 operator gate PASSED

The operator moved the round-3/4 checks into the readable project (dashboard paste: names + corrected graces 10/5/30 min, integrations ON), the live env file was re-pointed at those three UUIDs (`7434b1d4…` / `831d2ecf…` / `aa6be726…` — the round-5 wrong-account checks `c714c362…`/`4435f8da…`/`6f24368c…` abandoned), and the API was trusted over the paste. Masked verification results:

- **File shapes clean:** three ping URLs length 56/56/56, host `hc-ping.com`, no trailing slash; `TELEGRAM_BOT_TOKEN` (46) and `HC_REAL_CHECKS_API_KEY` (32) unchanged.
- **Check list under BOTH keys now shows the three checks BY NAME in the readable project:** `worker-heartbeat` grace **600 s**, `worker-outbox-age` grace **300 s**, `worker-redis-memory` grace **1800 s** — exactly D-25. `channels=1` on each under `HC_REAL_CHECKS_API_KEY` (paging binding visible to that key; the older key hides channel bindings but agrees on graces — the real key is the authoritative view for paging). All three `status=new`, 0 pings (never pinged — fresh window will advance them).
- **Flips HTTP 200 for all three derived UUIDs under BOTH keys** — including `HC_READ_ONLY_API_KEY`, the key gate 1 uses at window end, so gate-1 evidence collection is unblocked. (Round-5's 403-vs-200 discrimination is what made the account mismatch provable; with the checks moved, everything resolves.)
- Housekeeping notes: `My First Check` changed grace 3600→300 at some point (account default check, not ours, inert). The round-5 wrong-account checks are abandoned; the `rehearsal-*` throwaways + orphans remain for post-window cleanup (deferred-items.md).

**Verdict: CONFORMING — the pre-committed condition for opening the window is met.** The dead-man profile (D-25) is API-verified, paging channels are bound, and both evaluation keys can read the checks. Task 1 (operator gate) is COMPLETE; Task 2 window-open choreography begins immediately.

## 05-08 window — Task 2 window-open choreography (2026-09-16, 17:45Z–18:02Z) — EXECUTED AS STAGED

Stack pre-state verified before any change: worker `readyz` green (soak PID 40020, scheduler off), web `/login` 200 on :3007 (PID 33388), `spidernode-dev-db` + `spidernode-prod-redis` Up 10 h. All times UTC.

**1. D-49 re-seed (run once, 17:45:32Z, `UPDATE 2`):** before — 2 active monitors, 2 due, max overdue 6 466 min; after — 1 due now, max overdue 1 min, max future 1 151 min. Due-filter horizon bounded exactly as designed.

**2. Drill-phase scraper A:** `.snapshots/gates-0508-drill-20260916T174600Z/` — 15 s cadence from 17:46:00Z, gapless `ok` samples (34+), captures the pre-unpause baseline, the transition, and the drill.

**3. First unpause (17:46:56Z, worker PID 15684, sha 5411026):** `schedulerEnabled: true`; all four schedulers upserted (`check-tick`, `maintenance-cleanup`, `tier2-flush-sweep`, `relay-pass`); boot log line **"recurring scheduling ACTIVE"**; `readyz` green. Immediate relay/flush activity in first samples — expected at unpause, recorded not alarmed. Monitor 2 checked every ~60 s on the Tier-2 lane (`check:2:<epoch>` + routine-UP flush staging).

**4. First heartbeat pings at hc.io:** all three real checks flipped `new → up` within ~70 s of unpause; counters advancing 1→3 by 17:48:07Z on `worker-heartbeat`/`worker-outbox-age`/`worker-redis-memory` (functional proof that the env-file UUIDs bind to the named checks — the ping counters move on exactly the names the API list shows).

**5. Co-run ~12 min (17:46:56Z→17:58:46Z):** legacy cron per-minute blocks continuous (457 by 17:54:46Z) with the due-filter visibly sharing load — mix of "No monitors are due for a check right now" (worker's fresh `lastChecked` starves cron — WRK-11 bounded overlap working as designed) and "Successfully checked all monitors". Worker metrics: all lanes depth 0 except normal delayed repeatables; `outbox_unsent 0`; `redis_memory_percent 0.5`; pg breaker closed; zero stalls.

**6. D-35 live abort drill — RE-PAUSE 17:58:48Z (epoch 1789581528, worker PID 36340):** abort lever = scheduler flag + restart ONLY (queues never touched). Boot log: `schedulerEnabled: false`, "scheduler flag OFF — skipping all Job Scheduler upserts", NO "recurring scheduling ACTIVE" line, `readyz` green throughout. **Pause duration 2 m 13 s** (well under the 6–7 min budget / 10-min heartbeat grace). Coverage during pause: cron blocks continuous per-minute with "Successfully checked all monitors" — zero-gap. **Honest observation (recorded, not a gate):** the Redis-persisted `check-tick` chain fired twice more during the pause (17:58:56, 17:59:56 — monitor 2 staged, then quiesced as the pause ended): flag-off boots skip NEW scheduler upserts but do not sever already-persisted repeatable chains. Full worker-side stop on a live Redis would need scheduler removal (never queue pause); on a fresh Redis (true rollback scenario) the flag alone yields the dark-launch posture. The safety property D-35 exists to prove held: lever safe to pull, zero missed checks, instant recovery. All three hc.io checks kept pinging through the pause (health loop is scheduler-independent — 27 pings/up at 18:00:22Z), confirming D-17's process-level dead-man semantics.

**7. RE-UNPAUSE into the FRESH WINDOW — 18:01:01Z, epoch 1789581661, worker PID 55168:** boot log again `schedulerEnabled: true` + all four schedulers + "recurring scheduling ACTIVE"; `readyz` green; heartbeat resumed immediately (31 pings/up by 18:02:26Z).

**8. Window scraper B + gate-4 baseline:** scraper A stopped, scraper B → `.snapshots/gates-0508-window-20260916T180144Z/` from 18:01:44Z (15 s cadence, gapless). `counters-baseline.json` captured 18:02:03Z at fresh window start (2 monitors) — gate 4's `totalCountDelta` base is window-bounded as required.

**Window ledger:** start epoch **1789581661** (18:01:01Z). Minimum gate-eligible end: **+14 400 s = ~22:01:10Z**. Target counted stretch 4–6 h (end 22:01Z–00:01Z). Gates evaluate ONLY this continuous stretch (D-16); any interruption restarts the clock. Known operational facts entering the stretch: monitor 2 is the only frequently-due monitor (interval ~1 min); monitor 1 next due ~19.2 h out (re-seed horizon).
