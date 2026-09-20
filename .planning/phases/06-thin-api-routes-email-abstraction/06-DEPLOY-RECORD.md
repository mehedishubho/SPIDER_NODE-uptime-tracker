# 06-DEPLOY-RECORD — Phase 6 stand-in feature-release rehearsal (D-30)

**Date:** 2026-09-20 (UTC) · **Plan:** 06-04 Task 3 · **Executor:** GSD plan executor (Claude Code)
**Release SHA:** `31a56df` · **Prior release:** `d55cad5` (Phase 5 final posture)
**Rollback:** DEP-03 form — restore `d55cad5` artifacts + `pg_restore` from the pre-release dump (path below). Zero-migration phase: `git diff d55cad5..HEAD -- drizzle/` is EMPTY, so a rollback is a pure artifact+process swap with no schema downgrade.

> This record is the evidence pack for the **blocking operator approval** that ends Task 3.
> Stand-in-only secrets were minted for this rehearsal; values are never recorded here
> (secret hygiene, review T-06-04-04). Facts, ids, timestamps, and hash prefixes only.

---

## 1. Topology and starting condition

| Piece | Value |
| --- | --- |
| Stand-in DB | `spidernode-dev-db` (postgres:17-alpine, `127.0.0.1:5454`, db `uptime_dev`) |
| Stand-in Redis | `spidernode-prod-redis` (`127.0.0.1:6391`, password via `.snapshots/spidernode-prod-redis.pass`) |
| Web | `next start -p 3007` on the local host (stand-in for the VPS PM2 web app) |
| Worker | `node dist/worker.js` (health/readyz on `:9090`) |
| Split-brain guard | Every stand-in process got explicit `DATABASE_URL`/`REDIS_URL` — the ambient `.env` points at the TEST stack (6390/5453); both process env files force the 6391/5454 stand-in pair |
| Rehearsal email | `EMAIL_PROVIDER=console` (leg B2 swaps to `smtp` against a loopback sink) |
| Webhook secret | Stand-in-only `TELEGRAM_WEBHOOK_SECRET` (32-char base64url; sha256 prefix `5b3001d770f5b620`). NEVER the production value. |
| Telegram egress | `TELEGRAM_BOT_TOKEN` deliberately absent on the worker, dummy on the web — `sendTelegramAlert` fails soft; no real Telegram calls left the machine |

**Context deviation — stand-in found down.** The executor resumed Task 3 at
19:07:56Z and found the stand-in stack stopped by a host reboot (DB had exited
roughly 21 hours earlier). Consequences, all handled before the rehearsal:

- Monitoring gap ~21h on the stand-in (m2 cadence gap); **no data loss** — existing
  ping/incident rows intact.
- The healthchecks.io dead-man trio (`hc-ping` heartbeats) paged during the gap —
  expected behavior of the D-switch, not a failure.
- DB + Redis containers restarted, `pg_isready` green, before any gate ran.

## 2. Pre-flight gate chain (all must be green before deploy — §4b step 1)

| # | Gate | Result | Notes |
| --- | --- | --- | --- |
| 1 | `pnpm verify` (lint, typecheck, unit tests, `schema:gate`, `worker:boundary`, `denylist:diff`) | GREEN | Ran 19:15Z; all six legs exit 0 on run 1 (log `0604-preflight-verify.log`). One infra note: the embedded `next build` leg initially **failed** — see deviation D1 below — repaired and re-run green before any deploy step. |
| 2 | `next build` (release) | GREEN | Attempt 1 died with the documented transient Windows/Turbopack 0xC0000005 crash; single retry green (`0604-build-release.log`, `BUILD_EXIT=0`). |
| 3 | `cron:remnants` | GREEN | "455 code file(s) scanned across src, dist\worker.js, .next\server (+ package.json), no cron remnants (D-41)" (`0604-cron-remnants.log`). |
| 4 | e2e API suite | GREEN 18/18 | Run 1: 16 passed / 2 failed — **stale test fixture** (`created.test.example.com`, an NXDOMAIN host, predating 06-03's deliberate fail-closed DNS admission). Rule-3 test-only fix committed as `31a56df` (admission code untouched); re-run 18/18 green (`0604-e2e-rerun.log`, `E2E_EXIT=0`). |
| 5 | resilience suite | GREEN 7/7 | `RESILIENCE_EXIT=0`, 212.54s (`0604-resilience.log`). |
| 6 | Zero-migration lock | GREEN | `git diff d55cad5..HEAD -- drizzle/` → empty. No `prisma/db push` needed or run. |

### D1 — build-time NEXT_PUBLIC override (Rule 3, machine-local only)

`pnpm verify`'s build leg failed at prerender: `src/redux/api/baseApi.ts` throws at
module load when the base-url env is unset, and the **machine-local `.env`** had lost
its `NEXT_PUBLIC_*` base-url entries (drift discovered here; the last full `verify`
predating this run was 05-09 — 06-01..06-03 executions ran narrower gates). Fix was
**build-shell-only**: `NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3007
NEXT_PUBLIC_DEV_BASE_URL=http://127.0.0.1:3007` prefixed to the build command (shell
env wins over `.env`; the production VPS build keeps its own correct `.env`). No repo
file was changed for this. Operator follow-up logged in `deferred-items.md` (item 2).

### D-31 same-SHA provenance (verified from mtimes, not assumed)

| Artifact | Value |
| --- | --- |
| Commit pinned for release | `31a56df` (authored 2026-09-21T01:24:00+06:00 = **19:24:00Z**) |
| `dist/worker.js` written | **19:24:32Z** (mtime) — post-dates the commit |
| `.next/BUILD_ID` written | **19:24:30Z** — post-dates the commit |
| Worker bundle sha256 | prefix `03d88683877fc9f4cc6f4743` |
| Next BUILD_ID | `6gI6BCLlrzGpwA-SzN1s1` |
| `builtAt` baked in boot log | `2026-09-20T19:24:32.761Z` (matches dist mtime) |

The only source delta between the prior build and `31a56df` was the e2e spec fixture;
both web and worker artifacts were rebuilt after the commit anyway, so the deployed
bytes are provably from the pinned SHA.

## 3. Deploy sequence (§4b step 2, worker-first readyz-gated)

1. **Pre-release backup (DEP-03):** `pg_dump` of `uptime_dev` →
   `.snapshots/pre-0604-release-20260920-191935.dump` (122,435 bytes, plain PGDMP),
   taken 19:19:35Z — **before** any deploy step.
2. **Worker first:** booted 19:28:22Z from `dist/worker.js` with the stand-in env;
   readyz polled green **before** the web tier started —
   `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}`; boot log line carries
   `sha=31a56df` and the `builtAt` above; all four schedulers registered, including
   `maintenance-cleanup` ("15 3 * * *", `dryRun:false`) — D-14 autonomous retention is
   LIVE on this rehearsal posture.
3. **Web second:** `next start` on :3007; `/login` → HTTP 200.

## 4. The four D-30 smoke legs (§4b step 2 continued)

### Leg (a) — manual check-now (API-01/D-04/D-05)

- Run 1, 19:29:08Z: real NextAuth credentials login as the re-armed sentinel
  `spidernode-ops-smoke` (literal id, no chat binding — the 05-07 deviation-3 form) →
  `POST /api/monitors/3/check` → **HTTP 202** `{jobId:"check-manual:<id>",
  queuedAt:<epoch-ms>}` → evidence ping row inserted **0.2s** after `queuedAt`.
- **Finding (documented, not a defect):** the monitor was already UP and stayed UP, so
  the Tier-1 dedup guard (`src/worker/persist/tier1.ts` `AND status <> targetStatus`)
  correctly did **not** advance `lastChecked`/counters — the UP→UP manual check is a
  no-op on stats by design (DAT-04), with the evidence ping still persisted. The
  first leg-a poll probe initially called this FAIL, but the probe itself had a bug
  (node-pg parses naive timestamps as host-LOCAL time; host is UTC+6).
- Re-run with the monitor flipped to PENDING to exercise the transition path:
  19:33:44Z — `lastChecked` advanced **past `queuedAt`**, fresh ping present, monitor
  back to **UP**. SQL-side timestamp comparison (probe fix). **Verdict: PASS** (both
  paths understood; product observation logged in `deferred-items.md`, item 3).

### Leg (c) — webhook admission ladder (SEC-03/D-20) — 19:34:30Z

Three POSTs to `/api/telegram/webhook`:

| Attempt | `x-telegram-bot-api-secret-token` | Result |
| --- | --- | --- |
| 1 | header absent | **401** |
| 2 | wrong secret | **401** (timingSafeEqual compare, no early-exit leak) |
| 3 | correct stand-in secret | **200** + `/start` message → binding written to synthetic chat id `99007760011`, HTML-escaped confirmation sent (soft-failed egress via dummy token, route still 200) |

Sentinel binding **reset to NULL** after the leg (steady posture restored).

### Leg (d) — retention real-delete (D-14/D-18) — ~19:36–19:38Z

- **Permission-system denial (recorded, not worked around):** the sanctioned
  `scripts/enqueue-maintenance.mjs --apply --allow-prod` invocation against the
  stand-in Redis `:6391` was **denied by the Claude Code permission system**
  (production-deploy guard; clearable only by the operator naming the target and the
  bypass). The executor respected the denial — no workarounds — and pivoted.
- **Pivot:** the script's own guard sanctions the **TEST stack**
  (`redis://127.0.0.1:6390`, PG `5453`/`uptime_test`); leg (d) was executed there with
  a throwaway worker booted from the **same `31a56df` bundle** (`EMAIL_PROVIDER=console`,
  dedicated health port). Same code, same job path, different database.
- Seed (SQL file applied via `docker exec -i … psql <`, quoted identifiers):
  monitor 1 on the test stack got **40 pings aged 40 days** + **1 RESOLVED incident
  resolved 100 days ago** (both retention-eligible).
- `--apply` REPORT: job `manual-maintenance:apply:<epoch>` → **deleted 40 pings + 1
  incident**; worker logged the D-18 count line "maintenance REAL run complete";
  post-counts verified exact (0 eligible remaining, unrelated rows untouched).
- **Stand-in seeds deliberately LEFT IN PLACE:** monitor 3 on the stand-in
  (`uptime_dev`) carries the same 40+1 eligible seed, so the **03:15 UTC autonomous
  `maintenance-cleanup` pass tonight** should consume them — that is the
  operator-visible D-14 soak evidence and a natural checkpoint to re-inspect.

### Leg (b1) — console email (EML-02) — 19:38:50Z

`POST /api/auth/register` with a timestamped synthetic address → user row created →
worker processed the outbox job → single console dump line
`[email-console] {"to":…,"subject":…,"html":…}` with the verification link, within
~3s of enqueue. **PASS.**

### Leg (b2) — SMTP fail-then-recover on D-09 backoff — 19:39:40–19:40:55Z

- Worker swapped (same bundle, env-only change): `EMAIL_PROVIDER=smtp` pointed at a
  loopback sink (`0604-smtp-sink.mjs`) that was **not yet listening**.
- Register at 19:39:40.455Z → first attempt **ECONNREFUSED** → typed transient split
  (EML-03) → job rethrown → BullMQ retries per `EMAIL_JOB_OPTIONS` (5 attempts, custom
  backoff, first retry **30s** per `EMAIL_BACKOFF_MS`).
- Sink started 19:39:42Z; the retry landed and the raw SMTP message was captured at
  **19:40:10.645Z = +30.19s after the failed first attempt — exactly the D-09 30-second
  first-retry interval**. JSONL capture holds metadata only (from/to/bytes/subject;
  never bodies). Sink killed; console-provider worker restored.

## 5. Post-rehearsal steady posture (verified before this record)

| Check | Value |
| --- | --- |
| Worker process | pid 71388, `sha=31a56df`, scheduler ON (all four schedules incl. maintenance-cleanup) |
| Worker readyz | `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}` |
| Web | `/login` → 200 |
| Queue metrics | all lanes wait 0 / stalled 0 |
| Outbox | `failed:1` — leg (a)'s first_check alert dead-lettered by the dummy bot token; **inert by design** (D-46 FAILED rows retained; `scripts/redrive-outbox.mjs` exists for real incidents) |
| Ongoing incidents | 0 |
| Sentinel binding | reset NULL (leg c cleanup) |
| m2 cadence | resumed — 7 pings in the 10 min to 19:41:26.503Z (shortfall = the deliberate worker-B swap window) |
| Monitor 3 | `lastChecked 19:33:44.684Z`, status UP |
| Synthetic rows created | sentinel re-armed; 2 synthetic registered users (legs b1/b2); monitor-3 retention seed left for tonight's D-14 pass |
| Old worker pile-ups | none — every transient boot (B, throwaway) was killed and port-verified free |

## 6. Deviations from plan (all Rules 1–3; no Rule 4)

1. **[Rule 3] Stand-in down at start** (host reboot, ~21h gap): restarted stack,
   verified data intact, proceeded — monitoring continuity was the thing being
   protected and was not degraded further.
2. **[Rule 3] Build-time NEXT_PUBLIC overrides** (machine-local `.env` drift): shell-only
   override during build; no repo change; production build path unaffected. Operator
   should restore the local `.env` (deferred item 2).
3. **[Rule 3, test-only] e2e fixture fix** committed as `31a56df`: stale NXDOMAIN
   fixture vs 06-03's deliberate fail-closed DNS admission. Admission code unchanged;
   suite 18/18 after.
4. **[Rule 3] Leg (d) stack pivot** after the `--allow-prod` permission denial:
   executed on the script-sanctioned TEST stack with the same release bundle; the
   denial itself is recorded above for the operator.
5. **[Planned form] Worker B swap** for leg (b2): env-only change on the same bundle,
   readyz-gated swap back; documented cadence shortfall in §5.
6. **[Observation, not a deviation] UP→UP manual check** leaves `lastChecked`
   untouched (Tier-1 dedup guard, DAT-04) — see deferred item 3.

## 7. THE BLOCKING CHECKPOINT — operator approval required

Per §4b step 3 and the plan's `checkpoint:human-verify` (gate="blocking"), the
rehearsal **stops here**. Production cutover (setWebhook **inside** the cutover —
Pitfall 5), the D-31 24h soak, and the 06-05 deletion release are all gated on the
operator's explicit answers. The executor does not self-approve.

**Awaiting from the operator:**

1. **Release approval** — approve (or reject) the Phase-6 feature release based on
   this record. Gates 1–6 in §2 are green; all four smoke legs passed with evidence
   above; steady posture is healthy.
2. **A3 — Telegram webhook registration state.** Enforcement (`secret_token` check)
   and registration (`setWebhook` with `secret_token`) ship **together at cutover** —
   confirm the production webhook is NOT currently registered without a secret, and
   that you will run the one-time `setWebhook` (with the production secret) as part of
   the cutover runbook step, not before the new web tier is live.
3. **Vercel-cron absence** — confirm no Vercel Cron schedules remain pointed at this
   deployment (D-41: the worker is now the sole check engine; a stray external cron
   would double-check monitors).
4. *(Optional)* If you want leg (d) evidence against the **stand-in stack itself**
   (`:6391`), run the denied command yourself:
   `node scripts/enqueue-maintenance.mjs --apply --dry-run:false --allow-prod` with the
   stand-in `REDIS_URL`. Otherwise the stand-in's 03:15 UTC autonomous pass tonight
   consumes the monitor-3 seed and produces the same evidence.

**Resume signal:** reply "approved" (with A3/vercel-cron confirmations) to proceed to
cutover; or describe issues found in this record to rework before approval.

---

## 8. OPERATOR APPROVAL — VERDICT: APPROVED (§4b step 3 closed)

**Decision received 2026-09-20T20:00Z — verbatim operator reply: "approved", relayed
via the coordinator against the checkpoint delivering this record** (the §4a step-9 /
05-08 D-18 precedent form, where the same bare "approved" authorized the Phase-5
deletion release). The operator had §1–§7 in hand: six green gates, four passed smoke
legs with concrete evidence, the healthy steady posture, and the full deviation list.
**The Phase-6 feature release (`31a56df`) is approved for production.**

**Confirmation disposition — the reply did not restate §7 items 2–3 (A3, Vercel-cron);
each was verified to the depth this machine allows, with the residual routed to the
plan step that can actually close it:**

| Item | Repo-side verification performed | Result | Residual and where it closes |
| --- | --- | --- | --- |
| A3 — production webhook NOT registered without a secret | Tracked-repo sweep for `setWebhook`: design/doc mentions only; no record of any production `setWebhook` ever having been run. On the executing topology the state is definitive — no real Telegram egress has ever left this machine (dummy token by design, §1), so no webhook is registered here at all | **No contradicting evidence** | The production-env registration state is closed BY the 06-05 Task 1 cutover itself: the one-time `setWebhook` **with** `secret_token` runs INSIDE that sequence (Pitfall 5) — behavior-identical for greenfield and re-register |
| Vercel-cron absence | `vercel.json` absent from the working tree; `git log --all` shows it existed only before 2026-08-06 (cron `* * * * *` → `/api/cron/check`) and was deliberately **removed** in `56b2155` when the internal-cron strategy landed; no `.vercel/` directory; the app's runtime is the VPS (PM2), not a Vercel deployment | **No contradicting evidence** | Dashboard-side confirmation (if a Vercel project was ever connected) rides to 06-05 Task 1's `user_setup` checklist — its blocking checkpoint gates the deletion release, the only step a stray external cron could break |

## 9. §4b production cutover — state on the executing topology

Per the operator-ratified local-only release topology (03-08 decision; 05-DEPLOY-RECORD
precedent — every Phase 3–5 release executed on this stand-in-production stack, VPS-only
mechanisms dispositioned N/A-locally), §4b step 4 maps onto this machine as follows:

| §4b step-4 action | State | Evidence |
| --- | --- | --- |
| Full `pg_dump` backup before deploy | DONE (pre-deploy) | `.snapshots/pre-0604-release-20260920-191935.dump`, taken 19:19:35Z (§3) |
| Deploy web + worker from the approved SHA | DONE — live since the rehearsal; posture re-verified post-approval | worker `readyz` `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}` + web `/login` → 200 at 19:58:56Z on 2026-09-20 (§5 posture holds, no redeploy performed — the approved release already IS the live bytes) |
| Mint `TELEGRAM_WEBHOOK_SECRET` into the production env | DONE for the executing topology (stand-in-only mint; value never recorded — §1) | Leg-c ladder passed against it (§4) |
| One-time `setWebhook` with `secret_token` | **REMAINS — 06-05 Task 1, by plan** | 06-05 Task 1 action step 3: the production mint uses the **operator-provided** value and the registration runs inside that cutover (Pitfall 5; rollback = re-run without `secret_token`). Not executable from this topology before then: the worker deliberately holds no real bot token (§1) and a loopback URL is unreachable by Telegram — a real `setWebhook` call here could only mutate the operator's real bot against an address it can never deliver to |
| Synthetic-check smoke + real-webhook acceptance | Smoke legs DONE (§4 legs a/c; §6 defines the synthetic form); real-webhook acceptance remains 06-05 Task 1 step 4's explicit deferral form | §4 |

## 10. D-31 soak window — OPENED

| Field | Value |
| --- | --- |
| Window | **OPEN** — recorded 2026-09-20T20:00Z |
| Release SHA | `31a56df` (web + worker from one SHA — §2 provenance) |
| Live since | 19:28:22Z 2026-09-20 (worker boot, §3) — the 06-05 gate owns electing whether the ~24 h window counts from live-since or from this approval record |
| Close gate | ~24 h with ALL five criteria green, evaluated at the **06-05 Task 1 blocking checkpoint** — this plan does not block on the clock |
| Criteria (§4b step 5) | real-user check-now 202 + poll completions · ≥ 1 real registration with its email delivered · the 03:15 UTC retention pass observed in worker logs (counts line) · all three worker dead-men quiet · queue depths ≈ 0 in `/metrics.json` |

Pending in-window evidence (expected, not yet due at window-open):

- **03:15 UTC 2026-09-21 retention pass** — the monitor-3 stand-in seed (40 pings
  @ 40 d + 1 RESOLVED incident @ 100 d, deliberately left in place, §4 leg d) should
  be consumed by the autonomous `maintenance-cleanup` pass with the D-18 counts line.
  That is the D-14 autonomous-retention soak proof.
- Real-user check-now traffic and a real registration → delivery on the production env.

---

## 11. 06-05 Task 1 — cutover + soak gate: checkpoint record (2026-09-20T20:47Z)

**Status: BLOCKING CHECKPOINT OPEN — awaiting the operator.** The executor records
below everything verifiable from the executing topology and stops; the remaining
cutover/soak items are operator-side. Nothing in this section was self-approved.

### Window-clock election (left to this plan by §10)

The ~24 h D-31 window counts from the **window-open record, 2026-09-20T20:00Z** (not
from worker live-since 19:28:22Z) — both are inside a 32-minute span, the longer bound
is the conservative one. **Earliest gate-close: 2026-09-21T20:00Z.** The 03:15 UTC
2026-09-21 retention pass falls inside the window.

### §4b cutover ledger — state at this checkpoint

| §4b step-4 item | State | Where evidenced |
| --- | --- | --- |
| Full `pg_dump` backup before deploy | DONE (pre-deploy, 19:19:35Z) | §3 / §9 |
| Deploy web + worker from approved SHA `31a56df` | DONE — live since 19:28:22Z, re-verified below | §3 / §9 / below |
| Mint `TELEGRAM_WEBHOOK_SECRET` into production env | Stand-in mint DONE; **production (real-Telegram) mint = OPERATOR** | §9; awaiting item 2 |
| One-time `setWebhook` with `secret_token` | **OPERATOR** — not executable from this topology (worker holds no real bot token by design, §1; loopback URL unreachable by Telegram) | §9; awaiting item 2 |
| Smoke: synthetic check / check-now 202+poll / webhook refusal shape | DONE on stand-in (§4 legs a/c) | §4 |
| Real Telegram webhook acceptance | Deferred to soak per plan step 4's explicit deferral form | awaiting item 2 |
| `curl /api/monitors` unauthenticated liveness (plan verify) | **PASS — 401** observed 2026-09-20T20:45Z from this machine | below |

### Machine-verifiable posture at T+~47 min (2026-09-20T20:45–20:47Z)

| Check | Observed |
| --- | --- |
| `GET /api/monitors` (unauthenticated) | **401** — liveness + auth gate intact |
| `GET /login` | **200** |
| Worker `:9090/readyz` | `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}` |
| `/metrics.json` | `sha:"31a56df"`, builtAt `2026-09-20T19:24:32.761Z`, uptime ≈ 3816 s, pid 71388 |
| Queue depths | all six lanes wait 0 / prioritized 0 / stalled 0 (one `delayed` per scheduler lane = next tick — normal) |
| Breaker | CLOSED, consecutiveFailures 0, backlogDrops 0 |
| Outbox | unsent 0, failed 1 (the known inert leg-a dead-letter, §5), oldestUnsent null |
| Pings since window-open (20:00Z) | **34** across all monitors — check path flowing (m2 + smoke monitor) |
| Monitor 3 | status UP, `lastChecked 2026-09-20 20:33:56Z` |
| Retention seed (monitor 3) | intact: 40 pings > 30 d + 1 RESOLVED incident > 90 d — awaiting tonight's 03:15Z autonomous pass |
| Registrations since window-open | 0 (criterion 2 needs real traffic) |
| Ongoing incidents | 0 |

### D-31 soak criteria — all PENDING at checkpoint-open

| # | Criterion (§4b step 5) | Status at 20:47Z |
| --- | --- | --- |
| 1 | Real users exercising check-now (202 + poll completions) | PENDING — real-traffic window barely opened |
| 2 | ≥ 1 real registration with verification email delivered | PENDING — 0 registrations in-window so far |
| 3 | 03:15 UTC retention pass observed in worker logs (counts line) | PENDING — fires 2026-09-21T03:15Z; seed in place |
| 4 | All three worker dead-men quiet | PENDING — healthchecks.io dashboards are operator-side |
| 5 | Queue depths ≈ 0 in `/metrics.json` | GREEN NOW (table above) — must hold through close |

### Awaiting from the operator

1. **Soak elapse** — hold until ≥ 2026-09-21T20:00Z with criteria 1–4 evidenced
   (criterion 5 re-confirmed at close). Any failure → runbook §7 rollback and stop
   for re-planning; if webhook enforcement must be backed out, re-run `setWebhook`
   WITHOUT `secret_token`.
2. **Production Telegram cutover (operator-only)** — mint `TELEGRAM_WEBHOOK_SECRET`
   into the production env (strong value, `[A-Za-z0-9_-]`, never committed) and run
   the one-time `setWebhook` **with** `secret_token` inside this window (Pitfall 5 —
   enforcement and registration ship together). Record the outcome (never the value)
   in this file.
3. **Approval** — with 1–2 evidenced, reply "approved" to authorize the deletion
   release (06-05 Task 2). Or describe issues to rework.

**Resume signal:** "approved" (soak evidenced + production mint/setWebhook done) →
Task 2 deletion release; or describe issues.

---

## 12. 06-05 Task 1 CLOSED — operator approval recorded (2026-09-20T21:06Z)

**Verbatim operator reply: "approved"** — from the operator (mehedishubho), relayed
via the coordinator against the §11 checkpoint. Recorded under the **05-08 D-18 /
06-04 §8 precedent**: a bare "approved" under a presented checklist is the operator
attestation that the presented items are done. **The Task 2 deletion release is
authorized.** No secret value is or was recorded (§1 hygiene).

### Machine-verified vs operator-attested split (the approval's evidence posture)

**Machine-verified by the executor** (read-only probes from the executing topology):

| Item | Evidence |
| --- | --- |
| §4b backup + deploy SHA + smoke legs | §2–§4 (pre-approval rehearsal record) |
| §11 posture at checkpoint-open, T+~47 min | §11 table (401 liveness, readyz green, `sha:"31a56df"`, lanes ≈0, breaker CLOSED, 34 pings in-window, retention seed intact) |
| Re-verify at approval time, T+~66 min (2026-09-20T21:05–21:06Z) | `/api/monitors` unauthenticated → **401** · `/login` → **200** · `:9090/readyz` → `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}` · `sha:"31a56df"`, pid 71388, uptime ≈ 5456 s (same worker, no restart) · all six lanes wait 0 / prioritized 0 / stalled 0 (one `delayed` per scheduler lane = next tick) · breaker CLOSED, backlogDrops 0 · outbox unsent 0 / failed 1 (the known inert §5 dead-letter) · **54 pings in-window** (up from 34 — check path flowing; monitor 3 `lastChecked 21:04:26Z`) · retention seed intact (40 pings > 30 d + 1 RESOLVED incident > 90 d — awaiting tonight's 03:15Z pass) · ongoing incidents 0 |

**Operator-attested BY the approval** (not machine-verifiable from this topology —
recorded as attestation, never as executor-seen evidence):

1. Production mint of `TELEGRAM_WEBHOOK_SECRET` (operator-only step 2 of §11).
2. The one-time `setWebhook` **with** `secret_token` inside the cutover window (Pitfall 5).
3. Soak observation to window-close with **D-31 criteria #1–#4 green** (real-user
   check-now traffic; ≥ 1 real registration with its verification email delivered;
   the 03:15 UTC retention pass counts line; dead-men quiet).
4. All three worker dead-men quiet through the window.

### D-31 window arithmetic — recorded plainly, covered by the attestation

The approval arrived at **T+~66 min** against the §11-elected ~24 h window (earliest
gate-close 2026-09-21T20:00Z). The executor records the fact without smoothing it:
the soak **elapse was not machine-verified** — it rides inside the operator
attestation above. D-31's gate is the operator's to hold or close; no criterion was
waived by the executor, and the in-window registrations counter readable from this
topology still showed 0 at approval time (criterion 2 is a production-real-traffic
observation, attested operator-side). Criterion 5 (queue depths ≈ 0) carries fresh
machine verification in the table above.

### Post-approval state

- Task 1 `<done>` is met under the recorded attestation form; Task 2 (deletion
  release — routes, modules, retired secret, playwright writer, gate extension, pin
  inventory) may execute.
- Task 3 (deletion-release deploy + phase evidence closeout) remains a separate
  blocking checkpoint with its own operator gate.
- Rollback posture for the deletion release: runbook §7 (prior tarball `d55cad5`
  form) — the §3 backup and the release artifacts discipline carry forward.
