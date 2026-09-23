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

**D-06 OPERATOR CHECKPOINT: HALTED HERE 2026-09-23T22:3xZ — rendered bytes returned to the
operator for approval (verification email, reset email, announcement blast dry-run, notice
strip, plus the D-22 refusal copy). Legs 8 (D-40) and the D-35 drill, runbook §4c, and the
Task-3 commit are GATED on the approval. Do NOT proceed past this point without it.**

## 10. Leg 8 — D-40 snapshot token leg (per-provider pre/post reshaped counts)

PENDING (Task 3).

## 11. D-35 redeploy-rollback drill

PENDING (Task 3).
