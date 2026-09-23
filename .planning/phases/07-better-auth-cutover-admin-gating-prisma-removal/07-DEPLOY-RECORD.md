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

## 3. Leg 1 — `pnpm rehearse:migrations` (0002 applies, WR-05 bookkeeping, digest inventory)

PENDING (Task 3).

## 4. Leg 2 — admin seeding + D-09 zero-match abort evidence

PENDING (Task 3).

## 5. Leg 3 — web AND worker booted on the stand-in (Pitfall 7 init validation)

PENDING (Task 3).

## 6. Leg 4 — canary old-password login through the live stand-in web app

PENDING (Task 3).

## 7. Leg 5 — admin gate matrix on `GET /api/feedback`

PENDING (Task 3).

## 8. Leg 6 — Bull Board matrix on :9090

PENDING (Task 3).

## 9. Leg 7 — email round-trips (console provider) + D-06 copy sign-off

PENDING (Task 3 — BLOCKING OPERATOR CHECKPOINT; rendered bytes attached at halt).

## 10. Leg 8 — D-40 snapshot token leg (per-provider pre/post reshaped counts)

PENDING (Task 3).

## 11. D-35 redeploy-rollback drill

PENDING (Task 3).
