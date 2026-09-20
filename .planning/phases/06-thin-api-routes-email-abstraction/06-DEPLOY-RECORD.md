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
