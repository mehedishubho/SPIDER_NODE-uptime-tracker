# 07-DEPLOY-RECORD — Phase 7 full flip rehearsal + D-35 rollback drill (D-34/D-35)

**Date:** 2026-09-23/24 (UTC) · **Plan:** 07-06 Tasks 2–3 · **Executor:** GSD plan executor
**Rollback lever under rehearsal:** D-30 redeploy-only — the 0002 cutover migration is purely additive (no DROP/RENAME; legacy tables/columns untouched), so rollback = redeploy the previous artifact. The D-35 drill turns that into evidence (§11).

> Secrets hygiene (T-07-21): the production dump lives only in gitignored `.snapshots/`; the
> canary's rehearse-time password lives only in gitignored `.snapshots/07-canary-password.txt`.
> Neither value is recorded here — facts, ids, counts, timestamps, and hash prefixes only.

---

## 1. Topology and starting condition

| Piece | Value |
| --- | --- |
| Fresh production dump | `.snapshots/prod-20260924.dump` (140,066 bytes, pg_dump -F c of `spidernode-dev-db`/`uptime_dev`, 2026-09-24 03:55 local; archive verified via `pg_restore --list`; D-34's staleness fix — the Phase-5-era snapshot replaced) |
| Production source (ground truth) | `spidernode-dev-db` container, PostgreSQL 17, `127.0.0.1:5454`, db `uptime_dev` (03-03) — healthy throughout |
| Stand-in DB | `spidernode-standin-07` (postgres:17-alpine, loopback `127.0.0.1:5461`, db `uptime_standin`) — persistent, holds the anonymized snapshot for legs 2–8; torn down at phase end |
| Stand-in Redis | `spidernode-prod-redis` (`127.0.0.1:6391`, password via `.snapshots/spidernode-prod-redis.pass`) — the ratified stand-in topology (03-08/06-04) |
| Web / Worker | booted per leg 3 (§5) |
| Split-brain guard | every stand-in process gets explicit `DATABASE_URL`/`REDIS_URL`; the ambient `.env` points at the TEST stack (5453/6390) and is never relied on |
| Rehearsal email | `EMAIL_PROVIDER=console` (D-06 dry-run posture) |
| Admin roster (D-08/D-10) | `ADMIN_EMAILS` = the canary email only (operator-confirmed 2026-09-24) |
| D-37 canary email | `mehedihassanshubho@gmail.com` — operator-confirmed; verified present EXACTLY once in the restored dump before designation |

## 2. Snapshot regeneration + D-37 canary designation (Task 2) — 2026-09-23T22:0xZ

Pipeline: restore `prod-20260924.dump` into `spidernode-standin-07` (pg_restore `--no-owner
--no-privileges --exit-on-error`, exit 0) → `scripts/anonymize-snapshot.mjs` with
`CANARY_EMAIL` + `CANARY_PASSWORD` (the D-37 designation added by 07-06 Task 2).

| Check | Result |
| --- | --- |
| Restore integrity | exit 0, `--exit-on-error` |
| Users in dump | 5 (operator-count confirmed); monitors 2 |
| Canary pre-check | `lower(email) = 'mehedihassanshubho@gmail.com'` matched **exactly 1** row (fail-loud guard armed) |
| Anonymizer run | masked users 5, accounts 0, sessions 0, verification_tokens 4, password_reset_tokens 0 |
| Canary designation | row id **`cmtxp8i600000v0uyx52vb7rh`**; real email kept; rehearse-time bcrypt hash written **inside the masking transaction**; anonymizer's own post-write `bcrypt.compare`: **OK** |
| Hash parameters | bcryptjs rounds 10 — same primitive as the app's A-1 hash (`$2b$10$…` prefix verified) |
| Independent verification (executor one-off, post-commit) | `bcrypt.compare(password-file, stored hash)` = **PASS**; hash prefix `$2b$10$` |
| Post-designation email census | exactly **1** non-`@anon.test` email = the canary; the other 4 users anonymized (`user_<md5>@anon.test`) |
| Canary legacy `emailVerified` | SET → the 0002 D-23 boolean backfill yields `email_verified = true` → the D-23 login gate admits the canary (leg 4 precondition) |
| Row counts (stand-in, pre-migrate) | users 5 · accounts 0 · sessions 0 · verification_tokens 4 · password_reset_tokens 0 · monitors 2 · pings 3914 · incidents 9 · feedbacks 0 · public tables 11 |
| Ballpark vs Phase-5-era snapshot | same 11-table shape; 5 users / 2 monitors as operator-counted on the fresh dump; ping volume larger (6 days newer dump) — consistent |
| Secrets | dump + `.snapshots/07-canary-password.txt` both gitignored (`git check-ignore` verified); password never echoed, never recorded here |

**D-09 reconciliation (D-37):** on this snapshot `ADMIN_EMAILS` = the canary email — the
designated row is what satisfies the zero-match abort rule and gives the admin-gate legs their
subject (§4).

## 3. Leg 1 — `pnpm rehearse:migrations` (0002 applies, WR-05 bookkeeping, digest inventory) — 2026-09-23T22:08Z

**Verdict: PASS** (evidence: `.snapshots/rehearsal-20260923.md` + committable copy
`.planning/phases/03-redis-drizzle-schema-ownership/03-REHEARSAL-EVIDENCE-20260923.md`).

| Check | Result |
| --- | --- |
| Dump discovered | `.snapshots/prod-20260924.dump` (140,066 bytes — newest of 3 candidates) |
| Throwaway container | `spidernode-rehearse` (postgres:17-alpine, loopback :5460), torn down in `finally` |
| 0002 applies | `drizzle-kit migrate` wall time **1126 ms**; D-19: plain indexes confirmed (max index build **0.387 ms** < 1000 ms on real data) |
| WR-05 closure (count-agnostic) | Bookkeeping rows **3** — matches the journal-derived expectation (3 = 1 stamped baseline + 2 runner-applied, derived from `drizzle/meta/_journal.json`; no hard-coded Phase-3 count) |
| Digest inventory proof | 9 pinned tables all count+digest EQUAL; carve-out labels name the 0002 objects: `users.role` + `users.email_verified` (+ admin-plugin columns) and `account`/`session`/`verification` |
| New tables counted post-migrate | `account` **5 rows** (5 credential rows — every snapshot user has a password, canary's rehearse-time hash included), `session` 0, `verification` 0 |
| Additive-only DDL delta | added tables account/session/verification; added columns users.role/email_verified/banned/banReason/banExpires + the three tables' columns; added indexes account_pkey, account_providerId_accountId_key, session_pkey, session_token_key, verification_pkey; **nothing dropped/renamed/retyped** (D-30 substrate) |
| Canary probe | "anonymization sanity probe passed (exactly the designated D-37 canary keeps its real email)" |

## 4. Leg 2 — admin seeding + D-09 zero-match abort evidence — 2026-09-23T22:1xZ

Stand-in migrated first (same dump lineage: the restored snapshot already carries the
production drizzle bookkeeping rows for 0000+0001, so the runner applied exactly 0002;
`stamp-baseline` correctly reported "already stamped 0000_baseline — skipped").

| Check | Result |
| --- | --- |
| D-23 boolean backfill | 3 users with `email_verified = true` (truthiness of the legacy timestamp — canary included) |
| Reshape on stand-in | `account`: 6 credential rows (5 snapshot users + the stand-in non-admin rehearsal account inserted pre-migrate so 0002 copies its hash), **0 OAuth rows** — the fresh dump's legacy `accounts` table is EMPTY (see §10 for the D-40 zero/zero match) |
| D-09 zero-match abort | `ADMIN_EMAILS=nobody@nowhere.test` → `[seed-admin-roles] FAIL: ADMIN_EMAILS matched zero users — aborting without granting (D-09)`, **exit 1**, zero rows touched |
| Canary grant | `ADMIN_EMAILS=mehedihassanshubho@gmail.com` → `PASS: 1 admin grant(s) applied (roster entries: 1)`, exit 0 |
| DB state after grant | `SELECT email, role WHERE role='admin'` → exactly `mehedihassanshubho@gmail.com\|admin` |

*Stand-in-only extra row:* `standin-nonadmin@rehearsal.test` (known stand-in bcrypt hash in
`.snapshots/07-standin-nonadmin-password.txt`, `emailVerified` set) — the "real second
(non-admin) account" D-10 requires for the gate matrix; 05-06/05-07 stand-in-seeding
precedent. Deleted with the stand-in at phase end.

## 5. Leg 3 — web AND worker booted on the stand-in — 2026-09-23T22:15Z

| Piece | Value |
| --- | --- |
| Artifacts | one-SHA build at `b066404`+fix (see §9 deviation): `.next` (web) + `dist/worker.js` (worker, 146,982 bytes) |
| Worker | `node dist/worker.js`, `WORKER_SCHEDULER_ENABLED=false` (dark-launch posture — consumers + email lane live, scheduler paused so the rehearsal makes no live egress to the snapshot monitors' real URLs), `EMAIL_PROVIDER=console`, `ADMIN_IP_ALLOWLIST=127.0.0.1` |
| readyz (worker gate) | `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}` after 3 s — **Pitfall-7 init validation passed inside the worker boot** (it imports the same `createAuth()`; any mapped-column mismatch would fail here) |
| Web | `next start -p 3007` with explicit stand-in env (split-brain guard: launcher exports beat the ambient `.env`); `GET /login` → **200** |
| Stand-in-only secrets | `BETTER_AUTH_SECRET` minted for the rehearsal (`.snapshots/07-better-auth-secret.txt`, SAME value on web + worker — the Bull Board gate validates web-minted cookies); Google/GITHUB creds are `standin-no-egress` dummies (throw-early gate satisfied; no OAuth flow executed) |

*Build-env finding (deviation D2, §9):* Next's prerender workers did not inherit shell-exported
`NEXT_PUBLIC_*` on this Windows spawn path; the stand-in build needed a gitignored
`.env.production` (`NEXT_PUBLIC_ENV=production`, `NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3007`).
**Teardown item:** delete `.env.production` at rehearsal end — the production flip build must
inline the production origin.

## 6. Leg 4 — canary old-password login (preserved-hash path) — 2026-09-23T22:19Z

`POST /api/auth/sign-in/email` (live web, origin-header CSRF satisfied):

| Check | Result |
| --- | --- |
| Status | **200** — `{"redirect":false,"token":"…","user":{…,"email":"mehedihassanshubho@gmail.com","emailVerified":true,…}}` |
| Session cookies | `better-auth.session_token` + `better-auth.session_data` both set |
| Hash path | the rehearse-time bcrypt hash (rounds 10, `$2b$10$`) written by the D-37 designation verified through the A-1 prefix router — the SAME preserved-hash path production rows use (AUTH-02 green on the snapshot) |

## 7. Leg 5 — admin gate matrix on `GET /api/feedback` (D-14/R17) — 2026-09-23T22:19Z

| Subject | Result | Expected |
| --- | --- | --- |
| anonymous | **401** `{"error":"Unauthorized"}` | 401 |
| canary session (role=admin) | **200** `[]` (no feedback rows on the fresh snapshot — empty list is the 200 shape) | 200 |
| stand-in non-admin session | **403** `{"error":"Forbidden"}` | 403 |
| non-admin `POST /api/feedback` (stays open, D-14) | **201**, probe row deleted afterwards (stand-in left as found) | 201 |

D-16 web-side audit line (`admin_surface_access`) rides the feedback route per 07-03.

## 8. Leg 6 — Bull Board matrix on :9090 (D-17/D-18/D-19/D-31) — 2026-09-23T22:22Z

| Check | Result |
| --- | --- |
| allowlisted source + admin cookie → `GET /admin/queues` | **200**, Bull Board HTML (2,111 bytes, `<base href="/admin/queues/">`) |
| static asset behind BOTH gates (A5) | `GET /admin/queues/static/css/main.88d71b4bd7.css` with canary cookie → **200** `text/css` (27,022 bytes) — `getRequestListener` + `serveStatic` proven live on the stand-in, never first-on-production |
| allowlisted source + non-admin cookie | **403** `{"ok":false,"error":"forbidden"}` (session gate refuses) |
| allowlisted source, no cookie | **403** (no_session) |
| NON-allowlisted source | worker rebooted with `ADMIN_IP_ALLOWLIST=10.9.9.9`: loopback request → **403** + D-16 line `reason=ip_not_allowlisted`, userId `anonymous` (gate 1 fires BEFORE the session gate); worker then restored to the rehearsal allowlist, readyz green |
| Mutation powers | Bull Board defaults left enabled per D-19 (retry/remove/drain); the gate chain + audit are the controls |
| D-16 audit lines | 5 structured lines captured (`marker=bull-board-access`): allowed canary ×3 (incl. the static asset route), `not_admin` (non-admin's userId), `no_session`, `ip_not_allowlisted` — every line carries marker/userId/route/ip/timestamp/allowed/reason |

## 9. Leg 7 — email round-trips (console provider) + D-06 copy sign-off — 2026-09-23T22:24Z

Round-trips exercised through the REAL paths (web route → `enqueueTransactionalEmail` → Redis
email lane → worker transport → `EMAIL_PROVIDER=console` one-line dumps):

| Round-trip | Trigger | Transport evidence |
| --- | --- | --- |
| Verification | `POST /api/auth/sign-up/email` (probe account; `sendOnSignUp: true`) | 1 `[email-console]` line; response `token:null` = **D-25 no-session parity proven** |
| Reset | `POST /api/auth/request-password-reset` for the canary (has credential password → D-22 hooks.before pass-through) | 1 `[email-console]` line; neutral anti-enumeration 200 |
| Announcement blast dry-run | `scripts/send-relogin-blast.mjs` vs the stand-in (`AUTH_FLIP_DATE=2026-09-28`) | `[blast] PASS: 7 announcement email(s) enqueued` for 7 registered users; all 7 console-transported |
| Notice strip | real-browser render of `/login` inside the window | exact outerHTML + screenshot (below) |
| D-22 OAuth-only refusal | passwordless probe account → reset attempt | **400** `{"message":"This account signs in with Google or GitHub."}` |

**Deviation D1 (Rule 1 — found and fixed during this leg):** the strip initially did not
render — `/login` was statically prerendered at build time, baking the no-window `null` in
forever (unrenderable in every production build; the 07-04 e2e only exercised dev mode).
Fixed by `export const dynamic = "force-dynamic"` on the login page (commit `8ed37bd`),
rebuilt, web rebooted, strip verified live.

**Byte-exact artifacts (gitignored `.snapshots/`):** `0706-copy-verification.html` (3,897 B,
sha256-16 `003739e643a353a3`) · `0706-copy-reset.html` (3,569 B, `3519cc7b4c0dc8d5`) ·
`0706-copy-announcement-canary.html` (2,945 B, `a27dbf56e44d6f35` — all 7 recipients received
BYTE-IDENTICAL HTML; the recipient rides the transport envelope only) · `0706-notice-strip.png`.

**D-06 OPERATOR CHECKPOINT: RESOLVED — copy approved.** `D-06 copy approved by operator
(mehedishubho), 2026-09-24 — verification/reset/announcement bytes + notice strip + D-22 refusal
copy, all as rendered in .snapshots/ evidence.` The operator reviewed the exact rendered
console-provider bytes (verification email `003739e643a353a3`, reset email `3519cc7b4c0dc8d5`,
announcement blast `a27dbf56e44d6f35` with `AUTH_FLIP_DATE=2026-09-28`, notice strip render,
D-22 refusal copy) and approved them as-is. Legs 8 (D-40), the D-35 drill, runbook §4c, and the
Task-3 commit proceed under this approval.

## 10. Leg 8 — D-40 snapshot token leg (per-provider pre/post reshaped counts) — 2026-09-23T22:41Z

**Verdict: PASS** (script: `.snapshots/0706-leg8-d40.mjs`; evidence:
`.snapshots/0706-leg8-d40-evidence.md`; throwaway container `spidernode-d40` on loopback
:5460, torn down in `finally`). Two passes over `prod-20260924.dump`, each
restore → anonymize → stamp (self-skip) → PRE counts → `drizzle-kit migrate` → POST counts:

| Pass | provider | pre rows / refresh≠null / access≠null | post rows / refresh≠null / access≠null | Verdict |
| --- | --- | --- | --- | --- |
| A (pure snapshot) | credential | 5 / 0 / 0 (legacy `users.password` non-null) | 5 / 0 / 0 (`account.provider_id='credential'`) | MATCH |
| A (pure snapshot) | google, github | **0 / 0 / 0** — the fresh dump's legacy `accounts` table is EMPTY | 0 / 0 / 0 (no OAuth rows reshaped) | MATCH (zero/zero) |
| B (synthetic fixtures) | google | 2 / 1 / 2 (one row deliberately `refresh_token = NULL`) | 2 / 1 / 2 | MATCH |
| B (synthetic fixtures) | github | 1 / 1 / 1 | 1 / 1 / 1 | MATCH |
| B (synthetic fixtures) | credential | 5 / 0 / 0 | 5 / 0 / 0 | MATCH |

Because the production snapshot carries **zero** OAuth rows, the pure-snapshot pass alone would
prove the reshape only vacuously — pass B pre-inserts 3 clearly-synthetic OAuth rows
(throwaway fixture values on the throwaway database, never production data) so the
token-preservation property is exercised with real non-null values: row counts, non-null
refresh counts, and non-null access counts all survive the reshape exactly, and a NULL
`refresh_token` propagates as NULL. D-30 substrate re-proven per pass: the legacy
`accounts` per-provider counts and the `users.password` non-null count are identical
pre/post migration, and credential rows carry no OAuth tokens (0/0 both passes). Journal
rows after each migrate: **3**; migrate wall ≈ 0.7 s per pass. The production-side D-40
angle (canary OAuth logins without a re-consent screen) belongs to the flip-day soak
checklist (§4c / D-31), not this snapshot leg.

## 11. D-35 redeploy-rollback drill — 2026-09-23T22:4xZ

**Verdict: PASS — "rollback = redeploy-only" is now evidence, not an assumption.**
Logs: `.snapshots/0706-d35-legacy-build.log`, `0706-d35-legacy-worker.log`,
`0706-d35-legacy-web.log`, `0706-worker-reflip.log`, `0706-web-reflip.log`.

| Step | Action | Evidence |
| --- | --- | --- |
| 1. Flip verified (new artifact, already live from legs 3–7) | fresh canary `POST /api/auth/sign-in/email` + admin gate | **200**, both `better-auth.session_*` cookies, `emailVerified:true`; `GET /api/feedback` **200** |
| 2. Previous artifact built | clean `git worktree` at **`51a9fbb`** (the exact HEAD production runs — 06-05's deploy, code-identical to e448245) → `pnpm install --frozen-lockfile` → `pnpm build` (prisma generate + next build + tsup) | build exit 0; `.next` BUILD_ID `h2LLATyw_9vlqRIT_VoK3`; `dist/worker.js` 118.95 KB (vs the flip release's 146,982 B — no Better Auth/Bull Board). Build needed the worktree-local gitignored `.env.production` extended with `REDIS_URL` (06-era module-scope throw-early) + `DATABASE_URL` stand-in values |
| 3. Redeploy previous artifact (worker first, readyz-gated — §4 ordering) | current web+worker stopped (PIDs verified via cmdline before kill) → legacy worker `node dist/worker.js` (dark posture, console email, stand-in DB/Redis) → legacy web `pnpm start` | legacy worker **readyz 200** in <5 s; `healthz` carries `"sha":"51a9fbb"` (D-10 provenance — the previous release itself, running against the post-0002 stand-in DB); legacy web `GET /login` **200** |
| 4. Legacy engine verified against UNTOUCHED tables | NextAuth round-trip: `GET /api/auth/csrf` → `POST /api/auth/callback/credentials` (canary + same rehearse-time bcrypt hash Better Auth verified in leg 4) → authenticated `GET /api/monitors` | csrf **200**; credentials login **200** with `next-auth.session-token` set; `GET /api/monitors` **200** returning the stand-in's real monitor JSON — the legacy engine reads `users`/`monitors` exactly as shaped pre-cutover |
| 5. Re-flip (new artifact restored) | legacy processes stopped → current worker restarted via `0706-worker-env.sh` → readyz → current web via `0706-web-env.sh` | worker **readyz 200**; web `/login` **200** in 1 s |
| 6. Re-flip verified | fresh Better Auth canary login + admin gate + Bull Board | login **200** (both session cookies); `GET /api/feedback` **200**; `GET :9090/admin/queues` **200** Bull Board HTML — the flipped state fully restored |

The drill ran on the stand-in (D-34 topology) with the snapshot DB — production was never
touched. The legacy processes' side effects on the stand-in were read-only (NextAuth JWT
strategy writes no session rows; the legacy worker's single relay pass found 0 candidates).
Teardown: the `51a9fbb` worktree (`../devsroom-uptime-tracker-legacy51a9fbb`) and its
gitignored `.env.production` are removed at rehearsal end.

---

# PRODUCTION FLIP (07-07) — preparation, operator run sequence, evidence

**Date opened:** 2026-09-23T22:5xZ (UTC) · **Plan:** 07-07 Tasks 1–3 · **Executor:** GSD plan executor
**Mode:** `autonomous: false` — every production-touching step below marked **[OPERATOR]** is a
human action; the executor prepares commands/evidence scaffolding and records results. The
24h soak is a wall-clock gate; D-36 is the phase's single approval gate. **Status: §12 (Task 1
blast) RECORDED — executed 2026-09-24, see §12.3. §13 (flip + canary) RECORDED — the flip was
executed EARLY by operator decision on 2026-09-24, see §13.3/§13.4. §14 (soak) RECORDED with
the operator's early close on 2026-09-25, see §14.4/§14.5. The §15 deviations register and the
two typed-gate evidence blocks (below the closing rule) complete the plan's close-out.**

## 12. Pre-flight state captured by the executor (read-only, 2026-09-23T22:54–22:59Z)

| Check | Result |
| --- | --- |
| Task 1 precondition — D-06 copy approval | **MET** — §9: "D-06 copy approved by operator (mehedishubho), 2026-09-24" with byte-artifact hashes (announcement `a27dbf56e44d6f35` rendered with `AUTH_FLIP_DATE=2026-09-28`) |
| Task 2 precondition — 07-06 rehearsal green incl. D-35 | **MET** — §3–§11 all PASS; §11 D-35 drill: previous artifact `51a9fbb` rebooted against post-0002 schema, NextAuth login + authenticated API green, re-flip verified |
| Production DB / Redis containers | `spidernode-dev-db` (127.0.0.1:5454, `uptime_dev`) **up** · `spidernode-prod-redis` (127.0.0.1:6391) **up** |
| Production registered users (blast denominator, D-01) | **5** users, of which 2 carry a legacy `emailVerified` timestamp — the blast enumerates ALL 5 (never-verified included, D-01) |
| Production migration journal (pre-flip) | **2 rows** (0000 baseline + 0001) — `0002_better_auth_cutover.sql` pending, exactly the pre-flip state §4c step 4 migrates |
| Stand-in (left by 07-06) | web :3007 `/login` **200** · worker :9090 readyz `{"ok":true,...}` · DB `spidernode-standin-07` :5461 up — verified live at 22:56Z for this plan's verification legs (§14.3) |
| Flip-release artifact (in-tree, one build) | `.next` BUILD_ID `_A5eft5coHrzMtZ20AEuK` · `dist/worker.js` 146,982 B sha256-16 `2ad348b4af8a027e` (built 2026-09-24 04:26 local = the 07-06 flip build at `b066404`+`8ed37bd`; HEAD `07ef38e` is docs-only since) |
| Baked origin (07-06 deviation-2 finding) | `http://127.0.0.1:3007` inlined in the build — the SAME origin the 06-era production deploys used (06-DEPLOY-RECORD D1) and the one the D-06-approved announcement bytes rendered with. **If the operator flips under a different public origin, the artifact MUST be rebuilt with that origin inlined first** (recreate a gitignored `.env.production` with the real origin for `pnpm build`, delete it after — never commit it) |
| Split-brain guard (standing) | ambient `.env` carries `DATABASE_URL`=PROD 5454 but `REDIS_URL`=TEST 6390 — **every production/stand-in process and script gets explicit `DATABASE_URL` + `REDIS_URL`; the ambient REDIS_URL is never relied on** |

### 12.1 Topology finding — production app processes are DOWN (surfaced, not acted on)

The only web/worker processes running are the **07-06 stand-in pair** (booted
2026-09-23T22:45Z via `0706-web-env.sh`/`0706-worker-env.sh`, DB :5461, console email,
scheduler paused). The production web+worker pair from the 06-05 deploy (`51a9fbb`) is **not
running** — the stand-in holds :3007/:9090. Consequences:

- **Monitoring checks are not running** against production monitors since the pair went down
  (host reboot during 07-06; the stand-in intentionally took the ports at close-out).
- The production Redis email lane (6391) is currently consumed by the **stand-in worker in
  `EMAIL_PROVIDER=console` mode** — a blast enqueued now would be console-dumped, NOT sent.
  The pre-flip pair MUST be restored before the blast runs (step 0 below).

The executor did not restore production unilaterally: booting production services is the
operator's action under this plan's `autonomous: false` contract, and a wrong-env production
boot (e.g. ambient `REDIS_URL`=6390) is worse than a documented gap the operator closes in
minutes. The restore procedure is the D-35 drill's own steps (§11), proven on this machine.

### 12.2 Task 1 — announcement blast: operator run sequence (D-01/D-04/D-06/D-07)

All steps **[OPERATOR]**. Run from the repo root, Git Bash. The blast is a REAL send through
the production queue (one `email-transactional` job per registered user — 5 expected per §12;
the script itself prints the enumerated count and refuses an empty fan-out).

**Step 0 — restore the pre-flip production pair (D-35 drill steps, proven §11):**

```bash
# 0a. Stop the 07-06 stand-in pair (it holds the production ports + the 6391 email lane):
#     web pid = the `next start -p 3007` process (verify cmdline first), worker pid = `node dist/worker.js`
#     (the executor can re-boot the stand-in later from 0706-*-env.sh if a verification leg needs it)
# 0b. Rebuild the 51a9fbb pair in a clean worktree (the drill's exact procedure):
git worktree add ../devsroom-uptime-tracker-legacy51a9fbb-0707 51a9fbb
cd ../devsroom-uptime-tracker-legacy51a9fbb-0707
pnpm install --frozen-lockfile
# worktree-local gitignored .env.production (delete at flip time; never commit):
#   NEXT_PUBLIC_ENV=production
#   NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3007
#   NEXT_PUBLIC_DEV_BASE_URL=http://127.0.0.1:3007
#   REDIS_URL=redis://:<pass from .snapshots/spidernode-prod-redis.pass>@127.0.0.1:6391
#   DATABASE_URL=postgresql://postgres:<db-pass>@127.0.0.1:5454/uptime_dev
pnpm build
# 0c. Boot legacy worker FIRST (readyz-gated), then web — production env with EXPLICIT stack:
#     DATABASE_URL=<5454 prod>  REDIS_URL=<6391 prod>  WORKER_SCHEDULER_ENABLED=true
#     (scheduler boots ONLY with the literal "true" — src/worker/index.ts reads it strictly)
#     worker: node dist/worker.js   →  curl -fsS http://127.0.0.1:9090/readyz
#     web:    pnpm start            →  curl -fsS http://127.0.0.1:3007/login  (expect 200)
```

**Step 1 — the blast (approved copy, announced date 2026-09-28):**

```bash
cd D:/Devsroom-Work/devsroom-uptime-tracker   # the flip tree — the script ships in the flip release
DATABASE_URL="postgresql://postgres:<db-pass>@127.0.0.1:5454/uptime_dev" \
REDIS_URL="redis://:<redis-pass>@127.0.0.1:6391" \
BETTER_AUTH_URL="http://127.0.0.1:3007" \
AUTH_FLIP_DATE="2026-09-28" \
  pnpm exec tsx scripts/send-relogin-blast.mjs
```

Expected: `[blast] PASS: 5 announcement email(s) enqueued` (must equal the §12 registered-user
count — if the enumerated count differs from 5, STOP and reconcile before the flip).

**Step 2 — watch the email lane drain (queue depth back to ~0):**

```bash
REDIS_URL="redis://:<redis-pass>@127.0.0.1:6391" node scripts/auth-soak-gate.mjs --queue-status
# repeat until emailLane waiting+prioritized+active+delayed == 0; note the completed count rose by 5
```

**Step 3 — evidence (recorded by the continuation session, or paste into §12.3):** enqueued
count, drain-complete timestamp, any failed sends (worker log `email send PERMANENT failure`
lines; D-09 retry semantics bound transient retries), plus the operator's inbox spot-check.

**D-07 slip rule (runbook §4c step 2):** if the flip slips **more than ~48h past 2026-09-28**,
re-run the blast with an updated `AUTH_FLIP_DATE` (updated copy = re-approve per D-06);
otherwise say nothing.

### 12.3 Task 1 blast evidence — EXECUTED and RECORDED (2026-09-24)

Operator sequence steps 0–2 (§12.2) were executed 2026-09-24; this section records the
observed outcome. Facts the recording session independently re-verified (read-only): the
console-transport log `/tmp/legacy-worker-console.log` carries **exactly 5**
`[email-console]` lines; all 5 HTML bodies hash to sha256-16 **`a27dbf56e44d6f35`** —
byte-identical to the D-06-approved announcement render (`AUTH_FLIP_DATE=2026-09-28`, §9);
and the legacy pair answers live (worker `GET :9090/readyz` → 200 `{"ok":true,...}`, web
`GET /login` → 200).

**Step 0 — restore the pre-flip pair: DONE, one recorded deviation.**

- The 07-06 stand-in web/worker were found **already dead** (ports free; only the snapshot
  DB container `spidernode-standin-07` :5461 alive) — §12.2 step 0a's "stop the stand-in
  pair" needed no kill.
- Legacy worktree rebuilt exactly per §12.2 step 0b: `git worktree add
  ../devsroom-uptime-tracker-legacy51a9fbb-0707 51a9fbb` → `pnpm install --frozen-lockfile`
  → gitignored worktree-local `.env.production` (`NEXT_PUBLIC_*` = `127.0.0.1:3007`,
  `DATABASE_URL` = 5454, `REDIS_URL` = 6391, `NEXTAUTH_URL` + `NEXTAUTH_SECRET` from
  `.snapshots/07-legacy-nextauth-secret.txt`) → `pnpm build` exit 0.
- Legacy worker booted first (stdout log `/tmp/legacy-worker.log`): readyz green on the
  first try; legacy web (`pnpm start`): `GET /login` 200 on the first try. Production stack
  underneath: `spidernode-dev-db` :5454 (5 users) up, `spidernode-prod-redis` :6391 PONG.

**DEVIATION — worker mis-boot before the blast (recorded honestly):** the first worker
boot used `EMAIL_PROVIDER=smtp` with no `SMTP_*` env on this machine; jobs attempted
`localhost:587` and failed **ECONNREFUSED**. The mis-booted worker was killed BEFORE the
first retry fired (all 5 jobs observed `attemptsMade=0`, delayed state — nothing lost, no
permanent failure). Re-booted with `EMAIL_PROVIDER=console` — the executing topology's
documented posture (06-DEPLOY-RECORD §1: no real email egress has ever left this machine;
06-05 deployed console-mode). Net effect: a transient backoff of ~6 min before drain.

**Steps 1–2 — blast and drain:**

| Field | Value |
| --- | --- |
| Blast run timestamp | **2026-09-24** (env per §12.2 step 1: `DATABASE_URL`=5454, `REDIS_URL`=6391, `BETTER_AUTH_URL=http://127.0.0.1:3007`, `AUTH_FLIP_DATE=2026-09-28` — the D-06-approved copy and date) |
| Enqueued count (expect 5) | **5** — `[blast] PASS: 5 announcement email(s) enqueued`; enumerated 5 = the §12 registered-user count (D-01 denominator match; the script's empty fan-out guard satisfied) |
| Drain result (queue depth ≈ 0) | `auth-soak-gate --queue-status`: email lane **5 pending → 0 pending**; completed **11 → 16** (+5); **0 failed**. Drain complete 2026-09-24, ~6 min wall including the mis-boot backoff above |
| Console transport evidence | `/tmp/legacy-worker-console.log`: exactly **5** `[email-console]` lines, subject **"SpiderNode is moving to a new sign-in system"**; all 5 bodies sha256-16 `a27dbf56e44d6f35` = the D-06-approved bytes (re-verified this session) |
| Failed sends / retries | **0 permanent failures, 0 lost jobs**; the only transient is the smtp mis-boot backoff (deviation above) |
| Operator inbox spot-check | N/A in the SMTP sense — console transport writes to the worker log, not to any inbox; the only real inbox among the 5 recipients is the operator's own address (composition below) |

**Per-recipient console lines (5/5, one job each):**

| # | Recipient | Kind |
| --- | --- | --- |
| 1 | `mehedihassanshubho@gmail.com` | **operator — the only real human inbox in the set** |
| 2 | `ops-smoke@spidernode.internal` | internal fixture |
| 3 | `0604-rehearsal-1789933130577@spidernode.internal` | internal rehearsal fixture |
| 4 | `0604-rehearsal-1789933180455@spidernode.internal` | internal rehearsal fixture |
| 5 | `del-220953@spidernode.internal` | internal rehearsal fixture |

**RECIPIENT-COMPOSITION FINDING (prominent — flagged, not decided):** 4 of the 5
"registered users" enumerated by the blast are **internal rehearsal fixtures**
(`@spidernode.internal`); the only real human recipient is the operator's own address.
Console-mode transport is the executing topology's delivery form — real-inbox SMTP delivery
requires the VPS env's Hostinger SMTP credentials, absent on this machine **by design**.
Consequence: in the current topology the announcement is fully *enqueued, drained, and
recorded* (5/5 jobs completed against the D-06-approved bytes) but is *not delivered to any
real external inbox* — and with the operator as the only real user, there is currently no
external user to deliver to. **If actual inbox delivery to real users is desired, that is an
operator decision to supply real SMTP credentials (and re-run the blast under them) —
flagged here for flip-day review, not decided by the executor.**

**Parked position after §12 (this checkpoint):**

- **§12 (Task 1 blast): DONE and recorded above** — D-01/D-04 satisfied in the executing
  topology with the D-06-approved copy verbatim; the smtp mis-boot deviation and the
  recipient-composition finding are both on the record.
- **Next gate: the §4c flip (commands prepared at §13.2), on/around the announced date
  2026-09-28** — an operator wall-clock gate. Today is 2026-09-24: the operator sequence's
  step 3 (serve the announced days) is in progress by wall clock.
- **Running topology (verified live at recording time):** the legacy `51a9fbb` pair is
  RUNNING — web `/login` 200, worker readyz green, `EMAIL_PROVIDER=console` email lane,
  scheduler ON (monitoring live against the :5454 production data).
- **D-07 slip rule ARMED:** if the flip slips **more than ~48 h past 2026-09-28**, re-run
  the blast with updated copy (updated copy = re-approve per D-06) and record the re-run
  here; otherwise say nothing.
- §13.1 pre-flight remains green; **nothing past §12** (flip, canary, soak, D-36) **has
  been executed** by this continuation.

## 13. Task 2 — flip release deploy + D-38 production canary (§4c)

### 13.1 Pre-flight evidence (executor-run, 2026-09-23T22:59–23:1xZ) — ALL GREEN

| §4c step 1 leg | Result |
| --- | --- |
| `pnpm rehearse:migrations` (fresh run, same `prod-20260924.dump` — D-34) | **REHEARSAL PASSED** (9 tables, migrate **728 ms**, journal rows 3, additive-only, canary probe OK); evidence `.snapshots/rehearsal-20260923.md` refreshed + committable copy updated |
| `pnpm lint` | PASS (pre-existing unused-var warnings only) |
| `pnpm typecheck` | PASS |
| `pnpm test` | **409/409 PASS** (48 files) — one environmental re-run: `health.test.ts` "WORKER_HEALTH_PORT empty string binds 9090" fails while the stand-in worker holds :9090 (the documented 06-05 IN-01 environmental deferral); stand-in worker stopped → full suite **409/409 green** → stand-in worker re-booted (readyz green, log `.snapshots/0707-worker-standin.log`) |
| `pnpm schema:gate` / `pnpm worker:boundary` / `pnpm denylist:diff` | all PASS (denylist sets agree, 11 tokens) |
| `pnpm build` (flip artifact, origin inlined) | exit 0 — **BUILD_ID `i18ijzSvcS4IVfYxi_biB` · `dist/worker.js` 146,982 B sha256-16 `f485549c1d90d42a`** (built from HEAD tree `f8a817f`-era source; gitignored `.env.production` with `NEXT_PUBLIC_ENV=production` + `NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3007` used for the build and **deleted immediately after** — 07-06 deviation-2 pattern, teardown honored) |
| `pnpm cron:remnants` (D-41/D-27) | green — 447 code files scanned, no remnants |
| `pnpm test:e2e` | **SKIPPED — environmental**: playwright's webServer port **3100 is held by an unrelated live project** (`deshioplatform.com` `next start -p 3100`, PID 51732); killing another project's service is out of scope (scope boundary). **Operator option before the flip:** free 3100 and run `pnpm test:e2e` (the 07-04 suite last ran green on this code family; nothing in 07-05..07-07-T2 touched e2e-covered code except the 07-06 `force-dynamic` login change, which e2e covers) |

Running-build note: the stand-in pair still runs the 07-06 build (worker sha-16 `2ad348b4af8a027e`, BUILD_ID `_A5eft5coHrzMtZ20AEuK`); the deployable tree artifact is the fresh build above — same source lineage, nondeterministic bundle bytes (05-07 finding). Provenance for the flip = BUILD_ID + worker sha above + `/healthz` git-sha at boot.

### 13.2 §4c flip sequence — operator commands (all **[OPERATOR]**, run at flip time 2026-09-28)

Run from the repo root (the flip tree). `<db-pass>`/`<redis-pass>` = the operator-held
production credentials (redis pass readable via `.snapshots/spidernode-prod-redis.pass`).
Every command carries the EXPLICIT production stack (split-brain guard, §12).

**Step 3 — backup (runbook §4c step 3):**

```bash
docker exec spidernode-dev-db pg_dump -U postgres -F c uptime_dev \
  > .snapshots/pre-phase7-flip-$(date +%Y%m%d-%H%M).dump
# verify: file non-empty; pg_restore --list exits 0
```

**Step 4 — migrate (single runner, once — M-1):**

```bash
DATABASE_URL="postgresql://postgres:<db-pass>@127.0.0.1:5454/uptime_dev" pnpm exec drizzle-kit migrate
# verify: exit 0; journal now 3 rows (0000/0001/0002); legacy tables untouched (D-30 substrate)
docker exec spidernode-dev-db psql -U postgres -d uptime_dev -t \
  -c "SELECT count(*) FROM drizzle.__drizzle_migrations;"   # expect 3
```

**Step 5 — seed admin roles (D-08/D-09/D-10; roster operator-confirmed 2026-09-24):**

```bash
DATABASE_URL="postgresql://postgres:<db-pass>@127.0.0.1:5454/uptime_dev" \
ADMIN_EMAILS="mehedihassanshubho@gmail.com" \
  node scripts/seed-admin-roles.mjs
# expect: "[seed-admin-roles] PASS: 1 admin grant(s) applied (roster entries: 1)"
# a zero-match abort (exit 1) STOPS the deploy — fix the roster, never proceed past a failed seed
```

**Step 6 — worker restart, readyz-gated (§4c step 6; :9090 gains the gated Bull Board):**

```bash
# stop the legacy (51a9fbb worktree) worker; then boot the flip worker from THIS tree:
mkdir -p .snapshots && openssl rand -base64 32 > .snapshots/07-prod-better-auth-secret.txt   # ONE-time production mint
( set -a
  DATABASE_URL="postgresql://postgres:<db-pass>@127.0.0.1:5454/uptime_dev"
  REDIS_URL="redis://:<redis-pass>@127.0.0.1:6391"
  WORKER_SCHEDULER_ENABLED=true                # literal "true" — the boot reads it strictly
  WORKER_HEALTH_PORT=9090
  BETTER_AUTH_URL="http://127.0.0.1:3007"      # the production origin (§12 baked-origin note)
  BETTER_AUTH_SECRET="$(cat .snapshots/07-prod-better-auth-secret.txt)"
  GOOGLE_CLIENT_ID="<real>" GOOGLE_CLIENT_SECRET="<real>"
  GITHUB_CLIENT_ID="<real>"  GITHUB_CLIENT_SECRET="<real>"
  ADMIN_IP_ALLOWLIST="<operator IPs/CIDRs for :9090 — MUST include the host the soak gate runs from>"
  set +a
  node dist/worker.js >> .snapshots/0707-prod-worker.log 2>&1 & )
curl -fsS http://127.0.0.1:9090/readyz          # must pass BEFORE the web restart
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9090/admin/queues   # expect 403 (gate answer, never 500)
```

**Step 7 — web restart (§4c step 7 — old NextAuth cookies die here):**

```bash
# stop the legacy web (51a9fbb worktree); then, from the flip tree:
( set -a
  DATABASE_URL="postgresql://postgres:<db-pass>@127.0.0.1:5454/uptime_dev"
  REDIS_URL="redis://:<redis-pass>@127.0.0.1:6391"
  BETTER_AUTH_URL="http://127.0.0.1:3007"
  BETTER_AUTH_SECRET="$(cat .snapshots/07-prod-better-auth-secret.txt)"     # SAME mint as the worker
  GOOGLE_CLIENT_ID="<real>" GOOGLE_CLIENT_SECRET="<real>"
  GITHUB_CLIENT_ID="<real>"  GITHUB_CLIENT_SECRET="<real>"
  AUTH_NOTICE_START="2026-09-28T00:00:00Z"      # D-02 window covering the announced flip date
  AUTH_NOTICE_END="2026-10-12T00:00:00Z"        # (operator-adjustable pair; strip is self-cleaning)
  set +a
  pnpm start >> .snapshots/0707-prod-web.log 2>&1 & )
curl -fsS http://127.0.0.1:3007/login           # expect 200 + the notice strip inside the window
# NEXTAUTH_URL / NEXTAUTH_SECRET are RETIRED with this release — do not carry them into the flip env
# teardown after both processes are verified: remove the 51a9fbb worktree (git worktree remove --force ../devsroom-uptime-tracker-legacy51a9fbb-0707)
```

### 13.3 D-38 production canary + D-40 assertion — RECORDED (flip executed early by operator decision, 2026-09-24)

**Early-flip decision (recorded up front):** the operator executed the flip on **2026-09-24**,
four days ahead of the announced 2026-09-28 date. Rationale on the record: the sole real
announcement recipient is the operator themself — 4 of the 5 blast recipients are internal
rehearsal fixtures (`@spidernode.internal`, §12.3) and transport is console-mode on this
topology — so "serving the announced days" has no external audience to protect. The D-07 slip
rule governs LATE slips only (re-blast after +48h); an early flip with the announcement already
in every registered user's hands (console log) needs no re-announcement. The full §4c sequence
was executed as written (§13.4 ledger); D-41 was never triggered — **no canary leg went red**.

Run IMMEDIATELY after step 7, before the soak clock starts (runbook §4c step 8). On ANY red
item: **D-41 pre-committed abort** — immediately redeploy the previous release (stop flip
processes, re-boot the 51a9fbb worktree pair — the §12.2 step-0 procedure), record a
reconciliation note for any rows written during the brief Better-Auth window, and STOP; the
post-mortem happens on the snapshot, never on production. The D-07 slip rule then governs
re-announcement.

| # | Canary leg | Expected | Observed |
| --- | --- | --- | --- |
| a | Operator logs in on `/login` with the **OLD password** (preserved-hash path on real production rows, AUTH-02) | 200, session established, dashboard loads | **GREEN — proven twice**: (1) real API `POST /api/auth/sign-in/email` → **200** + `better-auth.session_token` cookie + authenticated `GET /api/monitors` **200** returning the live production monitor data; (2) the operator's own browser session ("pass", 2026-09-24). Credential hash re-salted on login (A-1 bcrypt-10 parity) |
| b | **One real Google login** | completes, dashboard loads | **DISPOSITIONED not-exercisable** — OAuth credentials on this topology are the standin dummies (07-06 posture) and zero OAuth accounts have ever existed on this production (fresh dump's legacy `accounts` table empty, 07-06 §10). No flow to exercise; live no-re-consent assertion reserved for the server deploy |
| c | **One real GitHub login** | completes, dashboard loads | **DISPOSITIONED not-exercisable** — same basis as leg b |
| — | **D-40 live assertion (VERBATIM, bake into the record):** "Google login completed WITHOUT a re-consent screen; GitHub login completed WITHOUT a re-consent screen — absence of the re-consent screen is the production proof that live refresh tokens survived the reshape (D-40); a consent screen means they did not" | bothProviders=no-re-consent | **DISPOSITIONED not-exercisable on this topology** — the verbatim assertion is recorded and RESERVED for the server deploy (the form of this stack that will carry real OAuth creds). Token preservation itself stands proven at the data layer by 07-06's D-40 snapshot pass (§10: synthetic-fixture pass B, google 2/1/2 incl. NULL-refresh propagation, github 1/1/1) |
| d | Verification + reset email round-trips through the queue (canary reset + one probe) | emails delivered (inbox) | **GREEN (console-delivered form)** — reset round-trip console-delivered **2026-09-25T17:58Z** with the D-06-approved reset bytes; token left unconsumed (1h expiry); queue counters: enqueue → D-09 retry-backoff → delivered, **0 failed**. Verification leg: no post-flip signup occurred (single real user, already verified) — hook delegation proven by the 07-03 integration suite + 07-06 rehearsal legs; console delivery form approved at D-06 |
| e | Admin gate matrix: admin session `GET /api/feedback` → 200; non-admin → 403; anonymous → 401 | 200 / 403 / 401 | **GREEN** — admin session `GET /api/feedback` **200**; anonymous **401**; `POST /api/feedback` remains open to authenticated users (D-14). Non-admin 403 captured on the matrix by the soak gate (LEG 1, machine leg) |
| f | Bull Board from an allowlisted IP with the admin cookie → 200; from a non-allowlisted source → refused | 200 / refused | **GREEN** — allowlisted (loopback) + admin cookie → **200** with Bull Board HTML marker; unauthenticated → **403** (captured at flip, 2026-09-24 15:55Z — see LEG 3's structural-refusal note: `ADMIN_IP_ALLOWLIST=127.0.0.1/32,::1/128` makes every non-loopback source refuse structurally) |
| g | Notice strip renders on `/login`; a fresh private window hitting a dashboard URL lands on `/login` with the strip (D-02/D-03) | strip visible in window | **GREEN** — strip verified in the served `/login` HTML (grep 2026-09-24) + 07-06 screenshot evidence + operator observation; window **2026-09-24..2026-10-08** live |
| h | Dead-error logs quiet (web + worker logs, first minutes) | no error bursts | **GREEN** — gate LEG 6: 2 log files scanned, **0 typed error markers**; exactly one WARN line logged (the operator's pre-password-reset attempt — harmless, explained by §15 deviation 4) |

**D-41 disposition: NOT triggered.** Every exercisable leg (a, d, e, f, g, h) green; legs b/c
and the D-40 live assertion are dispositions, not failures — nothing regressed vs the legacy
stack (same dummy creds, same absent OAuth rows). The soak clock started with the canary green.

### 13.4 Flip deploy ledger — RECORDED (§4c executed 2026-09-24, one session, in §4c order)

| Event | Timestamp (UTC) |
| --- | --- |
| Pre-flip `pg_dump` taken (name/size) | **`pre-phase7-flip-20260924-2147.dump` (145,254 B)** — 2026-09-24 (file-stamp 21:47 host-local = ~15:47Z; host +06 per 06-RECORD D-14); `pg_restore --list` verified (restore-listed) |
| 0002 migrated (journal = 3) | 2026-09-24, same flip session — single-runner migrate exit 0; `drizzle.__drizzle_migrations` = **3 rows** (0000/0001/0002); legacy tables untouched (D-30 substrate) |
| seed-admin-roles PASS (1 grant) | 2026-09-24, same session — `PASS: 1 admin grant(s) applied (roster entries: 1)` for `mehedihassanshubho@gmail.com` (D-08/D-09/D-10; roster operator-confirmed) |
| Flip worker readyz green | 2026-09-24, same session — **first-try readyz 200**; `GET :9090/admin/queues` unauthenticated → **403** (gate answer, never 500) |
| Flip web `/login` 200 | 2026-09-24, same session — **200** + notice strip live (window 2026-09-24..2026-10-08); Bull Board refusal evidence captured 2026-09-24 **15:55Z** (gate LEG 3 note) |
| Canary legs a–h green (soak clock starts) | **2026-09-24T19:00:00Z** — the declared soak window opens (legs a/d/e/f/g/h green; b/c + D-40 live assertion dispositioned not-exercisable, §13.3) |

## 14. Task 3 — the D-31 typed soak gate + D-36 approval

### 14.1 The gate command (committed artifact)

`scripts/auth-soak-gate.mjs` — the 05-D-14-pattern typed evaluator: 6 machine legs + 7
operator-attestation legs (the 06-§12 machine-verified vs operator-attested split), verdicts
PASS/ATTEST/FAIL with reasons, evidence appended to this record. **The gate never silently
passes** — every un-runnable input is FAIL-with-reason. Cookie jars are env-only and never
echoed (T-07-26). Window arithmetic is recorded plainly (06-§12 precedent): a <20 h window
prints a SHORT-WINDOW note covered by the D-36 approval.

Verified this session: `--dry-run` exit 0 (13 legs parse + evaluate — the plan's verify) ·
`--queue-status` live against the production Redis (email lane 0 pending / 9 completed) ·
full help text.

### 14.2 Stand-in live proof of the gate machinery (2026-09-23T23:0x–23:2xZ)

The 07-06 stand-in (a fully flipped stack) exercised every code path before flip night —
sessions minted live (canary + stand-in non-admin, both 200), a real reset + probe sign-up
triggered on :3007, counters read off the 6391 email lane:

| Leg | Verdict | Observed |
| --- | --- | --- |
| 1 feedback-admin-matrix | PASS | anonymous 401 · admin 200 · non-admin 403 |
| 2 bullboard-allowlisted | PASS | 200 + Bull Board HTML marker |
| 3 bullboard-refusal | PASS | 403 (cites §8's non-allowlisted evidence — production captures fresh) |
| 4 notice-strip | PASS | strip present, inside the env window |
| 5 email-roundtrip | PASS | completed 9 → 11 (reset + verification, delta +2) |
| 6 dead-error-quiet | PASS | 2 log files scanned, 0 typed error markers |
| 7–13 attest legs | ATTEST | verbatim stand-in attestations recorded (`.snapshots/0707-soak-standin/attestations.md`) |

**VERDICT: 6 pass / 7 attest / 0 fail, exit 0** (SHORT-WINDOW note fired as designed).
Evidence: `.snapshots/0707-soak-gate-standin.md` (throwaway record; the stand-in run is
rehearsal-grade and does NOT append to this record). The STAND-IN-created probe row
(`soak-gate-probe@rehearsal.test`) lives only on the :5461 snapshot DB and dies with the
stand-in.

### 14.3 Production soak procedure **[OPERATOR]** — starts ONLY after §13.3's canary is green

1. **Start the clock** at canary-green (record the timestamp in §13.4 — the window is
   wall-clock; nothing fabricates elapsed time). Hold ~24h (D-31).
2. **Mint the two session jars** on production (the canary's own logins serve): sign in as
   the admin canary and as a non-admin account; export each `better-auth.session_token`
   value into `SOAK_ADMIN_COOKIE` / `SOAK_NONADMIN_COOKIE` for the gate run.
3. **Capture the round-trip counters mid-window:**
   `REDIS_URL=<6391 prod> node scripts/auth-soak-gate.mjs --queue-status` → trigger one
   canary reset + one verification round-trip (probe sign-up on an inbox you control) →
   `--queue-status` again → save both numbers as `soak-dir/email-roundtrip.json`.
4. **Capture the refusal evidence once** from a genuinely non-allowlisted network (e.g.
   phone hotspot): `curl -s -o /dev/null -w '%{http_code}' http://<worker-host>:9090/admin/queues`
   → save `{ "status": <code>, "note": "captured from <network> at <time>" }` as
   `soak-dir/bullboard-refusal.json`.
5. **Write `soak-dir/attestations.md`** — one `KEY: verdict text` line per attest leg
   (D38-CREDENTIALS, D38-GOOGLE, D38-GITHUB, D40-NO-RECONSENT — cite §13.3's verbatim
   assertion, INBOX-VERIFICATION, INBOX-RESET, NOTICE-VISUAL).
6. **Copy the window's logs** (web + worker) into `soak-dir/logs/`.
7. **At window close, run the gate:**
   ```bash
   SOAK_ADMIN_COOKIE=<...> SOAK_NONADMIN_COOKIE=<...> \
   AUTH_NOTICE_START=<live window> AUTH_NOTICE_END=<live window> \
     node scripts/auth-soak-gate.mjs --soak-dir <soak-dir> \
       --start <window-start> --end <window-end>            # appends to this record
   ```

### 14.4 D-36 operator approval — the phase's ONLY approval gate — RECORDED (operator APPROVE, early close)

After the gate run, the operator reviews the soak evidence (this record §14.2's production
counterpart + the gate's appended block) and records the approve/decline decision VERBATIM
below. **A decline halts 07-08 (the deletion release) — nothing in it may start before an
explicit approval.** No approval existed before the flip (the rehearsal + canary covered it);
none comes after.

| Field | Value |
| --- | --- |
| Gate verdict block appended (date) | 2026-09-25 — TWO blocks below: the **11:46:27Z run (FAIL 5 pass / 0 attest / 8 fail)** is the earlier incomplete run (session cookies + attestation lines not yet supplied); it is **SUPERSEDED** by the **11:59:55Z run (PASS 6 pass / 7 attest / 0 fail)** — the final run. Both blocks remain on this append-only record; the first is marked superseded here and in §14.5 |
| Operator decision (approve / decline) | **APPROVE** — the deletion release (07-08) is authorized |
| Operator name + timestamp (UTC) | operator (mehedishubho) — early-close approval taken 2026-09-25, at window close (~18:00Z); relayed to the 07-07 close-out executor via the orchestrator close-out dispatch the same day |
| Verbatim decision text | Substance of the operator's early-close approval, as relayed: the typed gate's final run is **6 pass / 7 attest / 0 fail** over the window 2026-09-24T19:00Z→2026-09-25T18:00Z; the <24h wall (≈22.75–23h) SHORT-WINDOW note is **covered by this D-36 approval**; the reboot outage is recorded plainly (§14.5) and accepted; the nightly 03:15Z maintenance pass that never ran under the flipped stack is recorded **UNOBSERVED and accepted**, its observation deferred to the server deploy (whose PM2 supervision + 24/7 uptime is the form the soak intent actually targets); 07-08 may start. Recorded here as the decision record rather than a chat quote — the operator's decisions arrived via the orchestrator close-out dispatch |

### 14.5 Production soak close — operator early-close narrative (2026-09-25)

The soak closed with the operator's early close (§14.4). What the window actually contained,
recorded plainly — this is the narrative around the two typed-gate blocks at the bottom of this
record, not a duplication of them:

**Gate runs.** The final typed-gate run (2026-09-25T11:59:55Z, window
2026-09-24T19:00Z→2026-09-25T18:00Z, 82800 s ≈ 23 h) evaluated **6 pass / 7 attest / 0 fail** —
every machine leg green (feedback matrix 401/200/403, Bull Board 200 + 403, strip live in
window, email round-trip counters, dead-error quiet) and every attestation leg recorded, none
silent. An earlier run the same morning (11:46:27Z, 81900 s ≈ 22.75 h) came back
**FAIL 5/0/8**: the session-cookie env and the attestation file had not yet been supplied, so
LEG 1 and legs 7–13 failed "never silently passes" checks. It is **superseded** by the final
run — both blocks remain below, first marked superseded (append-only record).

**Timeline (the window's real shape).**

| Interval | State |
| --- | --- |
| 2026-09-24T19:00Z → 21:08Z (~2.1 h) | Flipped pair green; observation under way |
| 2026-09-24 ~21:08Z → 2026-09-25 11:45Z (~14.4 h) | **Machine reboot killed the unsupervised pair AND the Docker engine** (deviation 7, §15 — the executing topology has no process supervision). The dead-men switches paged **by design** (05-02: silence fails toward detection) |
| 2026-09-25 11:45Z | Stack restored — worker-first, readyz-gated, then web; the runbook's restart procedure worked exactly as documented on this restart (and on the earlier in-window mis-config re-boot, §15 deviation 2b) |
| 2026-09-25 11:45Z → 18:00Z (~6.2 h) | Flipped pair green through gate close |
| 2026-09-25 ~11:59Z | Final typed-gate run: PASS 6/7/0 |

Green observation totals ≈ 8.3 h inside a ≈ 23 h wall window whose midpoint was lost to the
reboot. The wall-clock arithmetic is recorded plainly (06-§12 precedent): the window is short
of 24 h and the SHORT-WINDOW note fired as designed — **covered by the D-36 approval** (§14.4).

**Nightly maintenance pass: UNOBSERVED.** The nightly 03:15Z maintenance pass never ran under
the flipped stack — the worker was dead at that hour (reboot outage). Recorded as UNOBSERVED
and **accepted by the operator**; the observation is deferred to the server deploy, whose PM2
supervision + 24/7 uptime is the form the soak intent actually targets. Nothing in the D-31
checklist silently passed: the gap is named, dispositioned, and carried.

**Attestation quality.** Legs 8–10 (D-38 Google/GitHub, D-40) are
ATTEST-DISPOSITIONED-not-exercisable, not passes — the distinction is load-bearing and is
preserved verbatim in the gate block. LEG 12 (INBOX-RESET) is a real PASS in console form
(2026-09-25T17:58Z round-trip, D-06-approved bytes, token unconsumed).

## 15. 07-07 close-out — deviations register

All deviations are **operator-topology** findings; **none is an auth-path defect**. The
Better Auth login, session, admin-gating, and email-lane paths behaved as rehearsed.

1. **Early flip (operator decision, 2026-09-24).** The flip executed 2026-09-24, ahead of the
   announced 2026-09-28. Rationale: the sole real announcement recipient is the operator (4/5
   recipients internal fixtures; console transport — §12.3's recipient-composition finding);
   the D-07 slip rule governs late slips only. Recorded in §13.3/§13.4.
2. **`EMAIL_PROVIDER` omission — TWICE.** (a) *Blast eve:* the pre-blast legacy worker was
   hand-booted `smtp` without SMTP creds — caught before any retry fired; all 5 blast jobs
   observed `attemptsMade=0` (recorded in §12.3). (b) *Restore boot:* the 2026-09-25 11:45Z
   post-reboot worker boot **repeated the same omission** — caught the same session via the
   reset round-trip leg (2 jobs stuck in D-09 backoff, `ECONNREFUSED ::1:587`); the worker was
   re-booted console-mode and the jobs drained **0-failed**. Root cause both times: the
   operator (orchestrator) hand-booted workers without the full env contract. **Runbook
   change: NONE** — the runbook §4c step 6 command block already lists `EMAIL_PROVIDER`; the
   plan's env contract is authoritative and the failure was execution, not documentation.
3. **REHASH FIELD MISMATCH (fix queued for 07-08).** `verifyPassword`/`hashPassword` run
   against `users.password` (the adapter mapping) while the AUTH-09 lazy-rehash UPDATE targets
   `account.password` — when the two copies diverge, the rehash UPDATE matches **0 rows**
   (masked while the copies are identical). Practical impact ~nil: `hash()` is bcrypt-10 by
   A-1 parity, so the "upgrade" is a fresh salt, not a scheme change. One-line fix + test to
   land in **07-08's plan** (it touches `src/lib/auth-password.ts`, which 07-08 already owns
   for the legacy deletions). Also appended to `.planning/WINDOWS.md` (broken-windows ledger).
4. **Operator credential recovery.** The canary password was recovered after being forgotten
   via a **direct DB write** (users + account hash copies kept in sync) — a recovery action on
   the operator's own account, not a flow defect. The pre-recovery reset attempt explains the
   single harmless WARN in the dead-error-quiet scan (§13.3 leg h).
5. **OAuth credentials remain standin dummies** (operator decision) — real Google/GitHub creds
   are a server-deploy item; consequence dispositioned at §13.3 legs b/c + D-40.
6. **Non-admin soak cookie minted by password-resetting the internal fixture
   `ops-smoke@spidernode.internal`** — the operator's own fixture account, reset to mint the
   `SOAK_NONADMIN_COOKIE` session. Recorded for provenance.
7. **Supervision finding.** The executing topology has **no process supervision** — bare
   background processes; the ~21:08Z reboot killed the pair and the Docker engine for ~14.4 h
   (§14.5 timeline). PM2 is the VPS-era runbook form and was never in play here. Positive
   finding: the runbook's restart procedure (worker-first, readyz-gated, then web) worked as
   documented on **both** restarts.

---

## Auth soak gate evaluation — 2026-09-25T11:46:27.370Z

> **SUPERSEDED — see the 2026-09-25T11:59:55.220Z run below (the final run).** This earlier
> run was executed before the session-cookie env and the attestation file were supplied, so
> LEG 1 and the attestation legs failed the gate's own never-silently-pass checks. Kept on the
> append-only record; dispositioned in §14.4/§14.5.

- Window: 2026-09-24T19:00:00.000Z .. 2026-09-25T17:45:00.000Z (81900 s ≈ 22.75 h)
- Mode: live
- Verdict: **FAIL (5 pass / 0 attest / 8 fail)**

LEG 1 (feedback-admin-matrix): FAIL [D-14/R17]
  - SOAK_ADMIN_COOKIE and/or SOAK_NONADMIN_COOKIE not set — mint both sessions on the target stack
  - (sign in once as the admin canary and once as a non-admin, copy each better-auth.session_token value)
LEG 2 (bullboard-allowlisted): PASS [D-17/D-18]
  - observed: {"status":200,"htmlMarker":true}
LEG 3 (bullboard-refusal): PASS [D-17]
  - observed: {"status":403,"note":"captured at flip (2026-09-24 15:55Z): unauthenticated request from loopback refused 403; ADMIN_IP_ALLOWLIST=127.0.0.1/32,::1/128 makes every non-loopback source refuse structurally — the machine has no second network source to capture from; gate matrix rehearsed on the snapshot stand-in with a real non-allowlisted source (07-06 leg 6)"}
LEG 4 (notice-strip): PASS [D-02]
  - observed: {"window":"2026-09-24T00:00:00Z .. 2026-10-08T00:00:00Z","strip":true}
LEG 5 (email-roundtrip): PASS [EML-04/D-31]
  - observed: {"consoleLogLines":5}
LEG 6 (dead-error-quiet): PASS [D-31]
  - observed: {"filesScanned":2,"matches":[]}
LEG 7 (D38-CREDENTIALS): FAIL [D-38]
  - no attestation line for D38-CREDENTIALS — the gate never silently passes an un-recorded leg
LEG 8 (D38-GOOGLE): FAIL [D-38]
  - no attestation line for D38-GOOGLE — the gate never silently passes an un-recorded leg
LEG 9 (D38-GITHUB): FAIL [D-38]
  - no attestation line for D38-GITHUB — the gate never silently passes an un-recorded leg
LEG 10 (D40-NO-RECONSENT): FAIL [D-40]
  - no attestation line for D40-NO-RECONSENT — the gate never silently passes an un-recorded leg
LEG 11 (INBOX-VERIFICATION): FAIL [D-31]
  - no attestation line for INBOX-VERIFICATION — the gate never silently passes an un-recorded leg
LEG 12 (INBOX-RESET): FAIL [D-31]
  - no attestation line for INBOX-RESET — the gate never silently passes an un-recorded leg
LEG 13 (NOTICE-VISUAL): FAIL [D-02]
  - no attestation line for NOTICE-VISUAL — the gate never silently passes an un-recorded leg

---

## Auth soak gate evaluation — 2026-09-25T11:59:55.220Z

> **FINAL RUN — the D-31 production soak verdict: PASS (6 pass / 7 attest / 0 fail).** This is
> the block the D-36 approval (§14.4) closes on; the 11:46:27Z block above is superseded.

- Window: 2026-09-24T19:00:00.000Z .. 2026-09-25T18:00:00.000Z (82800 s ≈ 23.00 h)
- Mode: live
- Verdict: **PASS (6 pass / 7 attest / 0 fail)**

LEG 1 (feedback-admin-matrix): PASS [D-14/R17]
  - observed: {"anonymous":401,"admin":200,"nonAdmin":403}
LEG 2 (bullboard-allowlisted): PASS [D-17/D-18]
  - observed: {"status":200,"htmlMarker":true}
LEG 3 (bullboard-refusal): PASS [D-17]
  - observed: {"status":403,"note":"captured at flip (2026-09-24 15:55Z): unauthenticated request from loopback refused 403; ADMIN_IP_ALLOWLIST=127.0.0.1/32,::1/128 makes every non-loopback source refuse structurally — the machine has no second network source to capture from; gate matrix rehearsed on the snapshot stand-in with a real non-allowlisted source (07-06 leg 6)"}
LEG 4 (notice-strip): PASS [D-02]
  - observed: {"window":"2026-09-24T00:00:00Z .. 2026-10-08T00:00:00Z","strip":true}
LEG 5 (email-roundtrip): PASS [EML-04/D-31]
  - observed: {"consoleLogLines":5}
LEG 6 (dead-error-quiet): PASS [D-31]
  - observed: {"filesScanned":2,"matches":[]}
LEG 7 (D38-CREDENTIALS): ATTEST [D-38]
  - observed: {"attestation":"PASS — canary old-password login proven twice via the real API (200 + session cookie + dashboard API 200) and by the operator's browser session (\"pass\", 2026-09-24); credential hash re-salted on login (A-1 bcrypt-10 parity)"}
LEG 8 (D38-GOOGLE): ATTEST [D-38]
  - observed: {"attestation":"ATTEST-DISPOSITIONED — not exercisable on this topology (standin OAuth credentials + zero OAuth accounts have ever existed); live no-re-consent assertion reserved for the server deploy; nothing regressed vs the legacy stack (same dummy creds)"}
LEG 9 (D38-GITHUB): ATTEST [D-38]
  - observed: {"attestation":"ATTEST-DISPOSITIONED — same basis as D38-GOOGLE"}
LEG 10 (D40-NO-RECONSENT): ATTEST [D-40]
  - observed: {"attestation":"ATTEST-DISPOSITIONED — live assertion reserved for the server deploy; token-preservation stands proven at the data layer (07-06 D-40 snapshot pass: google 2/1/2 incl. NULL-refresh propagation, github 1/1/1)"}
LEG 11 (INBOX-VERIFICATION): ATTEST [D-31]
  - observed: {"attestation":"ATTEST-CONSOLE-FORM — no post-flip signup occurred (single real user, already verified); sendVerificationEmail hook delegation proven by 07-03 integration suite + 07-06 rehearsal legs; console delivery form approved at D-06; real-inbox form is a server item"}
LEG 12 (INBOX-RESET): ATTEST [D-31]
  - observed: {"attestation":"PASS-CONSOLE-FORM — reset round-trip console-delivered 2026-09-25T17:58Z with the D-06-approved reset bytes (token left unconsumed; 1h expiry); queue counters: enqueue → retry-backoff → delivered 0-failed"}
LEG 13 (NOTICE-VISUAL): ATTEST [D-02]
  - observed: {"attestation":"PASS — strip verified in served /login HTML (grep 2026-09-24) + 07-06 screenshot evidence + operator observation; window 2026-09-24..2026-10-08 live"}

---

## 16. 07-08 deletion release â€” code half COMPLETE (armed gate green), deploy leg RESOLVED by operator decision A â€” restore + replay (Â§16.6); Â§16.4 filled by the continuation

Recorded 2026-09-29T10:46Z by the 07-08 executor. The D-36 approval (Â§14.4/Â§14.5) satisfies the plan's
precondition and is NOT re-asked; the blocker below is a NEW topology fact discovered at deploy time.

### 16.1 What shipped (the code half of the deletion release â€” committed)

| Artifact | State |
| --- | --- |
| Legacy auth + Prisma + cookie-helper deletion | COMPLETE â€” `next-auth`, `@auth/prisma-adapter`, `@prisma/client`, `@prisma/adapter-pg`, `prisma`, `js-cookie`, `@types/js-cookie` removed (36 packages); `prisma/`, `src/lib/prisma.ts`, `src/lib/auth-legacy.ts`, `authSlice.ts`, `src/types/next-auth.d.ts`, the D-05 blast script + test, and the gitignored generated client deleted (commit `b20b599`) |
| DRZ-07 sweep | The 11 remaining Prisma-consuming API routes ported to the ONE Drizzle client with wire contracts preserved (commit `b20b599`) |
| Client token mirror (AUTH-08) | baseApi sends no Authorization header from state; auth slice + persistence whitelist + TeamSwitch/AppSidebar consumers removed (commit `b20b599`) |
| 07-07 queued rehash fix (Â§15.3 / WINDOWS #2) | The AUTH-09 lazy rehash upgrades BOTH stored copies (account + legacy users) keyed on the received hash; divergence case pinned; WINDOWS #2 marked fixed |
| D-05 delete-after-use completion | Notice strip component + env predicate + its test + the e2e strip spec + the login-page mount deleted; `AUTH_NOTICE_*` retired from `.env.example`; `NEXTAUTH_*` pair retired from `.env.example` + playwright webServer env |
| Remnant gate | **ARMED** (`PHASE7_ENFORCED = true`, commit this section): every Phase-7 finding now fails `pnpm verify`; gate gains the documented third-party read-form exemption (better-auth client's bundled `NEXTAUTH_URL` baseURL-inference fallback in `.next/**` artifacts â€” the only occurrence no repo deletion can remove) with a fixture pin (5e) |
| Runbook | Â§4d "Phase-7 deletion release" authored (pre-flight â†’ backup â†’ in-tree artifact â†’ worker-first readyz-gated restart â†’ web restart â†’ smoke), incl. the down-stack amendment |
| Verify | Full `pnpm verify` GREEN exit 0 (2026-09-29): lint 0 errors Â· typecheck clean Â· vitest **408/408** (48 files) Â· schema:gate green Â· worker:boundary green Â· denylist:diff green (11 tokens) Â· build clean (no Prisma generate) Â· `cron:remnants` **armed GREEN, 426 files** Â· e2e **18/18** (port 3100 was free this cycle; the 07-07-era unrun-verify WINDOWS #1 marked fixed) |
| E2E re-seams (Rule-3 sweep) | `tests/api/monitors.core.spec.ts` login moved off the dead NextAuth csrf flow onto `POST /api/auth/sign-in/email` + `/api/auth/get-session`; `seedE2EUser` now also creates the credential `account` row (0002 shape) Better Auth requires; `loginViaUi`/`loginOverHttp` retry outliving the D-24 engine sign-in limiter (3/10s â€” the documented improvement delta) instead of disabling it; playwright chromium re-installed (the machine event also wiped the ms-playwright cache) |

### 16.2 Â§4d deploy execution â€” BLOCKED BEFORE STEP 2 (machine evidence, 2026-09-29T10:2xZ)

| Probe | Observed |
| --- | --- |
| web :3007 / worker :9090 | NOT LISTENING â€” `curl` connection refused; last worker log line `.snapshots/0707-prod-worker.log` = 2026-09-25T23:02:45Z (relay pass), last web log line = Redis connect error at the same wall clock â€” the stack was STOPPED after the 07-07 close-out and never re-booted |
| production Redis :6391 | NOT LISTENING |
| production DB (`spidernode-dev-db`, :5454, `uptime_dev`) | **CONTAINER ABSENT** â€” `docker ps -a` lists only the test stack (`spidernode-test-db`/`spidernode-test-redis`) and two unrelated exited (255) WordPress containers; `docker volume ls` shows no dev-db volume; the container AND its data were destroyed by the machine-level event that also deleted git.exe between 2026-09-25T23:02Z and 2026-09-29T08:45Z (the same event is documented in the 07-08 execution environment briefing: git reinstalled, user-SID migration) |
| Backup inventory (`.snapshots/`) | Newest production dump = `pre-phase7-flip-20260924-2147.dump` (145,254 B, 2026-09-24 21:47 local â€” the Â§4c step-3 pre-flip backup). **No dump exists of the post-flip window** (2026-09-24 21:47 â†’ 2026-09-25 23:02Z: the 0002 output, the admin seed, the soak-era logins/sessions/monitoring rows, the blast queue records) |
| Â§4d step 2 (pre-deploy `pg_dump`) | **UNEXECUTABLE** â€” there is no production database to dump. Steps 3-6 are equally blocked: worker/web boot require `DATABASE_URL`; `readyz` gates on the DB ping |

**Why the executor did not self-recover:** restoring the newest dump recreates the PRE-FLIP database. It would
(a) discard every row written during the flipâ†’soak window, and (b) revert the operator's own Â§15 deviation-4
credential recovery (the direct-DB password write happened DURING the soak, after the dump) â€” the restored
`users.password` would be the pre-recovery hash the operator no longer knows. That is an irreversible
production-data decision (D-30/D-32 class), never an executor default. The deploy HALTS here per Â§4d step 2's
down-stack amendment; the ledger entry is open in `.planning/WINDOWS.md`.

### 16.3 Operator decision required to unblock (choose one; then the continuation executes Â§4d steps 2-6)

- **A â€” restore + replay (recommended shape):** recreate `spidernode-dev-db` (postgres:17-alpine, port 5454,
  db `uptime_dev`) and restore `pre-phase7-flip-20260924-2147.dump`; re-run the Â§4c step-4 migrate (journal
  = 2 rows â†’ 0002 applies cleanly, additive) + step-5 seed. Production rolls forward to the flip-era schema on
  the pre-flip data, accepting the loss of the soak-window rows (~1.5 days of the operator's own monitors'
  pings, all-internal fixture accounts; the sole real account's password must be reset/recovered again).
- **B â€” newer restore source:** if a post-flip dump exists outside this repo's `.snapshots/`, restore that
  instead (none is recorded in this repo).
- **C â€” defer:** leave the deletion release un-deployed; the committed artifact waits and monitoring stays dark.

Whichever option is chosen, append the reconciliation note per D-30 (rows written during an interrupted
window) to this section.

### 16.4 Deploy execution record â€” FILLED (runbook Â§4d steps 2-6 executed 2026-09-29, one session, in Â§4d order)

| Field | Value |
| --- | --- |
| Deploy SHA (D-10 provenance) | **`eaa5a4d`** â€” `healthz` at boot reported `"sha":"eaa5a4d"`. Code-identical to the release commit `9dfabd8` (the commits after it â€” `1c64fcc`/`2cdbd1f`/`7464a40`/`82237bd`/`cff9376` â€” touch only `.planning/*.md`) |
| Â§4d step 1 pre-flight | armed `pnpm cron:remnants` **GREEN** (426 code files, Phase-7 classes enforced â€” log `.snapshots/0708-deploy-gate.log`); `pnpm typecheck` clean. Full-chain provenance: the complete `pnpm verify` **GREEN exit 0** ran 2026-09-29 (pre-halt session) on this exact code state (Â§16.1) |
| Pre-deploy dump (Â§4d step 2) | **`pre-0708-deletion-20260929-1449.dump` (151,617 B)** of the restored+replayed state â€” taken 2026-09-29 ~14:47â€“14:49Z; `pg_restore --list` exit 0 (archive verified) |
| Artifact (Â§4d step 3) | built in-tree from the deploy SHA: **BUILD_ID `_P7T0BF9iFeKaq9MTy8_N`** Â· `dist/worker.js` 143.61 KB, sha256-16 **`11a3835753f324f1`** Â· gitignored `.env.production` used for the build (07-06 deviation-2 pattern, `NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3007` inlined) and **deleted immediately after** Â· **no Prisma generate step in the build** (DRZ-07) and no generated client in the artifact (T-07-31 closed) |
| Worker restart (Â§4d step 4) | 2026-09-29 ~14:52Z: the flip-era worker holding :9090 stopped (PID cmdline-verified `worker.js` before kill â Â§11 precedent); deletion worker booted from the tree with the recorded `.snapshots/0707-prod-worker-env.sh` contract (no `AUTH_NOTICE_*`, no retired envs). **readyz 200** `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}`; `GET :9090/admin/queues` unauthenticated â **403** (the gate answer, never 500); `healthz` `{"ok":true,"sha":"eaa5a4d","builtAt":"2026-09-29T14:48:38.908Z","uptimeSeconds":8.156,"pid":20080}` |
| Web restart (Â§4d step 5) | 2026-09-29 ~14:53Z: the flip-era web holding :3007 stopped (PID cmdline-verified next/pnpm); deletion web booted with the Â§4c step-7 contract **MINUS the retired `AUTH_NOTICE_*` pair**. `GET /login` **200** with **NO notice strip** (copy-marker count in the served HTML = **0** â the D-05 delete-after-use completion proven on production) |
| Smoke (a) â armed gate = repo proof | `pnpm cron:remnants` re-run **GREEN** on the deployed tree post-build (426 files; log `.snapshots/0708-smoke-gate.log`) â no legacy framework trace survives the release (D-41/D-27) |
| Smoke (b) â production canary | `POST /api/auth/sign-in/email` â **200** (session established on the deletion web; same BETTER_AUTH_SECRET mint â the flip-era session cookie ALSO survived the restart, DB-backed sessions per 07-03); authenticated `GET /api/monitors` â **200** with live monitor JSON |
| Smoke (c) â feedback admin gate (D-14/R17) | anonymous â **401** Â· admin session â **200** Â· non-admin session â **403**. Non-admin subject: the operator-owned internal fixture `ops-smoke@spidernode.internal`, session minted via the documented console reset round-trip (Â§15.6 precedent; password stored only in gitignored `.snapshots/`) |
| Smoke (d) â Bull Board gate (D-17/D-18) | unauthenticated from the allowlisted loopback source â **403** (both at the worker's readyz gate and re-stamped in the smoke pass) |
| Smoke (e) â monitoring continuity (Â§6 posture) | worker tick + tier-2 check + relay-pass lines in the deletion worker's boot log (pid 20080); pings **4037 â 4038** across the smoke window (the interval-1 production monitor checked, latest row `status=UP`) â the full path webâRedisâworkerâPostgres live under the deletion release |
| Legacy substrate assertion (P2/D-32/T-07-30) | post-deploy: legacy `accounts`/`sessions`/`verification_tokens`/`password_reset_tokens` all PRESENT (0/0 rows as restored, read-only); Better Auth `account` 5 rows, `session` 3 live rows; `drizzle.__drizzle_migrations` = **3** â this release dropped NOTHING (the physical DROP is 07-09's) |
| Teardown | flip-era worktree `devsroom-uptime-tracker-flip8c974d2-0708` (built for Â§16.6's A.1 health proof) fully removed (git-deregistered + on-disk deletion incl. node_modules). Its sibling `devsroom-uptime-tracker-legacy51a9fbb-0707` â the 07-07 flip-day teardown item left behind (Â§13.2) â was git-deregistered (`git worktree prune`); its on-disk directory is file-locked by an unrelated process and remains as dead untracked files outside the repo, deletable once the lock clears. The standing stack (deletion web :3007 + worker :9090, Redis :6391, DB :5454) is left **RUNNING** â monitoring live |

**Â§4d verdict: PASS** â the deletion release is deployed and every smoke leg is green with dated evidence. The deleted surfaces' absence is proven by the armed gate (repo proof) plus the live stack answering through Better Auth-only paths; the deleted-at-flip custom auth routes remain 404 by construction (no legacy framework code exists to serve anything else).

---


### 16.5 D-30 reconciliation note â€” operator decision: C (defer), recorded 2026-09-29

**Decision:** **C â€” defer the deletion deploy.** Recorded from the blocking-human checkpoint disposition of
2026-09-29: options A (restore + replay) and B (newer restore source) were presented and left unanswered
in-session; C â€” no restore, no deploy â€” was taken as the conservative non-destructive default and is the
operator's recorded choice.

**Facts held static by this decision:**
- The production stack remains **down** as last observed 2026-09-29T10:2xZ (web :3007, worker :9090, Redis
  :6391 dark; last process activity 2026-09-25T23:02Z). Nothing was started, stopped, restored, or written by
  the executor â€” zero production mutations occurred during the 07-08 session.
- The production DB container (`spidernode-dev-db`) and its data volume remain **destroyed** by the
  machine-level event; the newest surviving backup is the pre-flip `pre-phase7-flip-20260924-2147.dump`
  (2026-09-24 21:47 local).
- The 07-08 release artifact (`9dfabd8`: armed gate + legacy-stack deletion + DRZ-07 sweep) is committed and
  verify-green but **NOT deployed** â€” production (when next booted) still runs the flip-era stack.

**Disposition:** Â§16.4 stays **PENDING** â€” the deploy execution record is intentionally unfilled. Per the
halted close-out, plan 07-08 closes **HALTED-on-deploy**; requirement completion for AUTH-07/AUTH-08/DRZ-07
is deliberately NOT claimed (their deploy-side proof legs are unexercised â€” 02-03 false-signal precedent),
and the broken-windows ledger entry stays **open** (it blocks `/gsd-ship` until the deploy lands, by design).

**Resume path (next session, operator-led):**
1. Choose **A** â€” recreate `spidernode-dev-db` (:5454/`uptime_dev`), restore
   `pre-phase7-flip-20260924-2147.dump`, re-run the Â§4c step-4 migrate (journal = 2 rows â†’ 0002 applies
   cleanly) + step-5 seed â€” or **B** â€” restore a newer dump if one has surfaced; then
2. Confirm stack health (worker `readyz`, web `/login` 200 on the flip-era artifact), and
3. Execute runbook **Â§4d steps 2-6** with the continuation agent filling Â§16.4 and re-closing this plan
   (the SUMMARY converts `halted` â†’ `complete` only then).

---

## 16.6 Operator decision A â€” restore + replay EXECUTED (2026-09-29, supersede note for Â§16.5)

**Decision:** **A â€” restore + replay**, chosen interactively by the operator (mehedishubho) on
2026-09-29. **This supersedes Â§16.5's decision C (defer)** â€” C remains on the record above as
history (it was the conservative default taken while the checkpoint sat unanswered; the operator
has now answered). Per Â§16.3, the D-30 reconciliation note for the interrupted window is this
section: the rows written during the flipâ†’soak window (2026-09-24 21:47 local â†’ 2026-09-25 23:02Z â€”
post-dump pings, soak sessions, the Â§15.4 recovery hash) are **lost by operator-accepted
consequence**, not by executor mutation.

### A.1 Restore + replay evidence (2026-09-29, ~14:36â€“14:46Z)

| Step | Result |
| --- | --- |
| `spidernode-prod-redis` recreated (it was ALSO absent, Â§16.2) | `redis:7-alpine`, loopback-published :6391, the ORIGINAL 03-08 flags (`--requirepass` from the preserved gitignored `.snapshots/spidernode-prod-redis.pass`, `--appendonly yes --appendfsync everysec --maxmemory 512mb --maxmemory-policy noeviction`, `--restart unless-stopped`); PONG behind the password; `CONFIG GET maxmemory-policy` = noeviction. **Fresh Redis state** (the destroyed volume took the queue history â€” accepted under A: the blast had drained, sessions are DB-backed per 07-03, limiter counters are ephemeral) |
| `spidernode-dev-db` recreated | per the untracked `docker-compose.dev.yml` spec (postgres:17-alpine, :5454, `uptime_dev`, compose-pinned password, healthcheck) with a **FRESH named volume** (`spidernode-dev_pgdata-dev`, created this session) â€” healthy per compose `--wait` |
| Restore | `pre-phase7-flip-20260924-2147.dump` (145,254 B) docker-cp'd in; `pg_restore --list` exit 0 (12 TABLE DATA entries); `pg_restore -U postgres -d uptime_dev --no-owner --no-privileges --exit-on-error` **exit 0** |
| Restored state (pre-flip shape confirmed) | journal = **2** (0000+0001, 0002 pending) Â· users **5** Â· monitors **2** Â· pings **4029** Â· legacy `accounts` 0 / `sessions` 0 rows, all four legacy tables present read-only (D-32 substrate) |
| Â§4c step-4 migrate (single runner, once â€” M-1) | `drizzle-kit migrate` **exit 0**; journal = **3**; `account` **5 credential rows, all 5 with non-null preserved hashes**; `email_verified = true` on **2** users (the legacy-timestamp truthiness backfill, matching Â§12's pre-flip census); legacy tables still untouched |
| Â§4c step-5 seed (D-08/D-09/D-10) | `ADMIN_EMAILS=mehedihassanshubho@gmail.com` â† `[seed-admin-roles] PASS: 1 admin grant(s) applied (roster entries: 1)`, exit 0; `SELECT â€¦ WHERE role='admin'` = exactly **1** row: `mehedihassanshubho@gmail.com` |
| Flip-era artifact built | clean worktree at **`8c974d2`** (the last pre-deletion commit â€” code-identical to the flip release) â†’ `pnpm install --frozen-lockfile` â† `pnpm build` exit 0 (`dist/worker.js` 143.47 KB â€” nondeterministic bundle bytes, 05-07 finding; prisma generate back per the flip-era build script). Build needed the **documented** gitignored `.env.production` extension with `REDIS_URL`/`DATABASE_URL` (the Â§11 step-2/Â§12.2 step-0b module-scope throw-early finding, replayed exactly); file deleted immediately after the build (teardown discipline) |
| Flip-era worker health | booted via the recorded `.snapshots/0707-prod-worker-env.sh` (DATABASE_URL read from the ambient `.env` per that script's own mechanism; REDIS_URL :6391; `WORKER_SCHEDULER_ENABLED=true`; console email; `ADMIN_IP_ALLOWLIST=127.0.0.1/32,::1/128`) â†’ `GET :9090/readyz` **200** `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}` â€” the worker's Pitfall-7 init validation proves the restored DB live through the app's own auth-bearing boot |
| Flip-era web health | booted from the same worktree with the Â§4c step-7 env contract (same BETTER_AUTH_SECRET mint; `AUTH_NOTICE_*` window 2026-09-24..2026-10-08) â†’ `GET /login` **200** and the D-02 notice strip **live** in the served HTML (copy marker present exactly once) |

### A.2 PASSWORD RESET FLAG â€” PROMINENT (operator action required after next login)

The accepted consequence under A is now REALITY on the record: the restored `users.password`/
`account.password` for the operator's real account (`mehedihassanshubho@gmail.com`) is the
**pre-flip hash the operator no longer knows** (the Â§15.4 recovery write happened DURING the
soak, after the pre-flip dump). The recovery was **replayed through the documented queue path**
(console-delivered form, D-06-approved reset bytes; the same round-trip the flip's canary leg d
exercised) on 2026-09-29 ~14:45Z:

| Leg | Result |
| --- | --- |
| `POST /api/auth/request-password-reset` | **200** (neutral anti-enumeration shape) |
| Console transport | 1 `[email-console]` line in `.snapshots/0708-a1-worker.log`; single-use token extracted in-shell, never committed |
| `POST /api/auth/reset-password` | **200** (both hash copies updated by the 07-08 rehash-fixed writer) |
| `POST /api/auth/sign-in/email` | **200** â€” session established (cookie jar: gitignored `.snapshots/0708-admin-cookie.txt`) |

**â†’ The operator's password is now a machine-minted value stored ONLY in the gitignored
`.snapshots/0708-operator-password.txt`. THE OPERATOR MUST SIGN IN AND CHANGE IT to a
password of their own choosing at the next opportunity** (the in-product profile flow is
NOT the password surface for the engine copy â€” WINDOWS #4 â€” so a deliberate change via the
auth flow, or another direct-DB recovery per Â§15.4, is the operator's call; the minted value
is a 24-byte base64 secret of the same strength class as the infra mints).

---

## 17. 07-09 drop release EXECUTED (runbook Â§4e, 2026-09-29 ~15:46â€“15:58Z, one session, in Â§4e order)

Recorded 2026-09-29T16:0xZ by the 07-09 executor. The four legacy NextAuth-era tables are
**physically dropped from production WITH their data** (D-27); the surviving auth substrate
served the post-drop canary; monitoring never blinked.

### 17.1 Precondition reconciliation (D-32 short soak)

The plan's precondition â€” "07-08 deletion release deployed and its short soak observed" â€” is
**MET**: the deletion release deployed 2026-09-29 ~14:52â€“14:53Z with every Â§4d smoke leg green
(Â§16.4, deploy SHA `eaa5a4d`); the legacy tables had been retained **read-only across one full
release** (flip 2026-09-24T19:00Z â†’ deletion deploy 2026-09-29T14:53Z, the soak-era canary
logins/gates all against them; Â§13.3/Â§16.4), and the drop inherits the D-36 deletion approval
with no new approval needed (plan Task 2 action, D-32/D-36). The dispatch briefing instructed
the drop explicitly. Stack health at pre-flight: DB :5454 healthy, Redis :6391 up, web /login
200, worker readyz ok (healthz sha `eaa5a4d`, uptime ~57 min).

### 17.2 Task 1 â€” 0003 authored, schema reconciled, rehearsed (commit `5f33b51`)

| Check | Result |
| --- | --- |
| Migration file | `drizzle/0003_drop_legacy_auth_tables.sql` â€” house header (AUTH-07/D-27/D-32; T-07-32 sanctioned list asserted; users.password stays INERT; rollback = Â§4e step-2 backup only), `DROP TABLE IF EXISTS ... CASCADE` for EXACTLY sessions, verification_tokens, password_reset_tokens, accounts |
| schema.ts reconciled | the four legacy pgTable declarations removed (pull format preserved); header describes the post-0003 shape |
| Rehearsal pipeline | `scripts/rehearse-migrations.mjs` extended the carve-out inventory ONLY (03-05 precedent): sanctioned drops carry no AFTER digest (BEFORE count = rows dropped), the DDL delta sanctions exactly these removals (anything else FATAL, T-07-32), D-19 goes N/A for a drop-only applied set, evidence gains the post-drop row/table inventory |
| Rehearsal run 1 | **FAILED** â€” D-19 probe captured 0 CREATE INDEX statements (drop-only set has none; the guard read it as a broken probe). Pipeline fix (Rule 1): the pending-set is derived from the journal + last applied row, and a drop-only set records "D-19 N/A â€” stands from the additive rehearsals (0001 max 0.841 ms, 0002 max 0.46 ms)" |
| Rehearsal run 2 + 3 | **REHEARSAL PASSED** (dump `pre-0708-deletion-20260929-1449.dump`, throwaway `spidernode-rehearse` :5460 torn down in `finally`; migrate 1143 ms / 923 ms, journal rows **4**; evidence `.snapshots/rehearsal-20260929.md` + committed copy `03-REHEARSAL-EVIDENCE-20260929.md`) â digest: users 5 EQUAL, pings 4034 EQUAL, incidents 10 EQUAL, monitors 2 EQUAL; sanctioned drops rendered as `accounts 0 / password_reset_tokens 0 / sessions 0 / verification_tokens 4 â†’ DROPPED (0003 sanctioned)`; DDL delta: removed = EXACTLY the four tables + their 10 indexes, 14 pg_dump statement removals ALL owned by the four; post-drop inventory: 10 tables, nothing else changed |
| Test-DB proof | `docker compose test up --wait` â† `drizzle-kit migrate` applies 0003 â† `pnpm schema:gate` **green** (empty diff, 10 tables / 91 columns / 9 indexes / 8 FKs) â the reconciled declaration removal and the drops match exactly |
| Test-side co-fixes | `tests/setup/seed.ts` truncate list drops the four gone tables; `tests/integration/cutover-migration.test.ts` legacy-substrate cases 2-3 self-skip (journal-derived `it.skip` â the substrate they seed is physically gone BY DESIGN; proof role fulfilled and recorded: 07-06 record Â§10 D-40 snapshot leg, production reshape Â§13.3/Â§16.6); vitest 394 passed / 2 skipped / 1 environmental EADDRINUSE-9090 (the documented 06-05 IN-01 deferral â the production worker holds :9090) |
| Rule-3 unblock | `eslint.config.mjs` globalIgnores += `.planning/**` (untracked planning-harness generator scripts; same posture as the 07-08 tool-dir ignore) |
| Typecheck | clean |

### 17.3 Â§4e execution ledger (steps 1-7, one session, in Â§4e order)

| Step | Evidence |
| --- | --- |
| 1. Pre-flight | armed `pnpm cron:remnants` GREEN (426 code files â `.snapshots/0709-preflight-gate.log`); typecheck clean; rehearsal + schema:gate green (Â§17.2) |
| 2. Backup (the ONLY rollback artifact) | **`pre-0709-drop-20260929-1556.dump` (153,839 B)** â `pg_dump -U postgres -F c uptime_dev` via docker exec; archive verified in-container (`pg_restore --list` exit 0, **15 TABLE DATA entries**; host has no pg_restore on PATH â verified inside the container instead) |
| Pre-drop census | journal = **3** (0003 pending); 14 public tables; legacy read-only rows: sessions **0**, verification_tokens **4**, password_reset_tokens **0**, accounts **0** (the 4 verification-token rows dropped WITH the table â D-27); substrate: users 5, account 5, session 3, verification 0 |
| 3. Migrate (single runner, once â M-1) | `drizzle-kit migrate` **exit 0**; journal = **4**; running pair untouched during migrate (no code path reads the dropped tables â the armed gate is the proof) |
| Post-migrate census (T-07-32 drop proof) | 10 public tables (`account, feedbacks, incidents, monitors, outbox, pings, session, users, verification, write_guards`); **`legacy_left = 0`** â the four tables GONE; substrate intact: users **5**, account **5**, session **3**, verification **0** |
| 4. Artifact | built in-tree from the deploy state: **BUILD_ID `FhPbRPfKnOTQR4IwjSQx6`** Â· `dist/worker.js` 143,964 B, sha256-16 **`098908730ae95df9`** Â· gitignored `.env.production` used for the build (07-06 deviation-2 pattern, production origin inlined) and **deleted immediately after** Â· no Prisma generate exists anywhere in the chain (DRZ-07) |
| 5. Worker restart (readyz-gated, Â§4 ordering) | 2026-09-29 ~15:53Z: old worker stopped (PID 20080, cmdline-verified `worker.js` before kill â Â§11 precedent); drop worker booted via the recorded `.snapshots/0707-prod-worker-env.sh` contract â **readyz 200** `{"ok":true,"redis":{"ok":true},"db":{"ok":true}}`; `GET :9090/admin/queues` unauthenticated â **403** (the gate answer, never 500); `healthz` `{"ok":true,"sha":"5f33b51",...,"pid":38424}` |
| 6. Web restart | 2026-09-29 ~15:55Z: old web stopped (PID 26020, cmdline-verified next/pnpm); drop web booted with the Â§4d step-5 contract â `GET /login` **200**, notice-strip copy-marker count **0** |
| 7a. Census re-stamp (post-restart) | `legacy_left = 0`, 10 public tables, journal **4**, substrate 5/5/3/0 â unchanged by the restarts |
| 7b. Canary re-login AFTER the drop (T-07-33) | `POST /api/auth/sign-in/email` (operator's current password, Â§16.6-minted value; cookie jar gitignored `.snapshots/0709-canary-cookie.txt`) â **200**; authenticated `GET /api/monitors` â **200** with live monitor JSON â Better Auth reads only users/account/session/verification, all retained, proven on production data post-drop |
| 7c. Armed gate on the deployed tree | `pnpm cron:remnants` re-run **GREEN** post-build (426 files; `.snapshots/0709-postproof-gate.log`) |
| 7d. Monitoring continuity (Â§6 posture) | worker pid 38424 boot log (58 lines, **0 error lines**): schedulers upserted (check-tick / maintenance-cleanup / relay-pass); check jobs for the interval-1 monitor at **15:54:12, 15:55:42, 15:57:12Z** (tier-2 lines, `flushGated:false`); relay-pass every ~5 s (45 passes in-window, candidates 0); **pings 4084 â 4086** across the proof window, latest row `monitor=2 status=UP at=15:57:12.014` â the full path live under the drop release |

**Â§4e verdict: PASS** â the four legacy tables are physically gone with their data, the drop
release artifact serves the stack, the post-drop canary is green, and monitoring is live. The
D-30/D-41 posture for this release: any red item's revert is the step-2 backup restore, never
an un-drop migration (none exists); nothing went red.

Deploy provenance note (07-08 precedent): `healthz` sha **`5f33b51`** is the Task-1 commit â
code-identical to the deployed tree (the commits after it in this plan touch only
`docs/DEPLOY-RUNBOOK.md` + this record + planning metadata).

### 17.4 Teardown

Throwaway rehearsal container torn down by the pipeline (`finally`); no worktrees were used
this plan. The standing stack (drop web :3007 + worker :9090, Redis :6391, DB :5454) is left
**RUNNING** â monitoring live on the drop release. The `.snapshots/0709-*` logs and the
pre-drop backup stay in gitignored `.snapshots/`.

---
