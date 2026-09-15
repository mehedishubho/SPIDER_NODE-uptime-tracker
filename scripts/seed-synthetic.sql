-- seed-synthetic.sql — the operator-owned synthetic smoke monitor (D-19).
-- Applied AFTER migrate on every deploy topology (rehearsal throwaway, local
-- production stand-in, and the first VPS deploy) — it is the target the D-18
-- smoke check enqueues against, and it must NEVER page a human:
--   * the seed status is PENDING, so an UP smoke check derives
--     monitor.first_check (deriveEventType) — exactly one outbox row, which
--     resolves to the no-chat skip path (alert dedup key written, the relay
--     path exercised end-to-end, a human never paged); a DOWN smoke
--     exercises the full alert render. (04-REVIEW IN-01: the previous
--     UNKNOWN seed derived NO event on an UP smoke, so the relay path only
--     stayed exercised while example.com happened to be DOWN.)
--   * the URL is https://example.com/ (IANA-reserved documentation host —
--     stable, publicly reachable, answers fast);
--   * interval 1440 (once-a-day cadence) keeps BOTH engines off its back
--     between operator smokes:
--       - legacy cron (cron-logic.ts) treats lastChecked IS NULL as "check
--         immediately", so the seed sets "lastChecked" = now() — the cron's
--         due filter (lastChecked + interval minutes) then ignores it;
--       - the worker tick claims rows with next_check_at IS NULL as due
--         (NULLS FIRST), so the seed sets next_check_at one interval ahead.
-- Every smoke check updates lastChecked (Tier 1 always writes the evidence
-- ping + row update), which keeps the 24 h quiet window rolling.
--
-- IDEMPOTENT: the sentinel user is inserted ON CONFLICT (email) DO NOTHING;
-- the monitor is inserted only when the (userId, url) natural key is absent.
-- Re-running on a seeded database is a no-op and never resets lastChecked.
--
-- The natural-key literals here are mirrored as constants in
-- scripts/enqueue-smoke.mjs (SMOKE_OWNER_ID / SMOKE_MONITOR_URL) — change
-- both together.

BEGIN;

INSERT INTO users (id, email, name, "createdAt", "updatedAt")
VALUES (
  'spidernode-ops-smoke',
  'ops-smoke@spidernode.internal',
  'SpiderNode Operator Smoke (sentinel)',
  now(),
  now()
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO monitors (
  url, name, status, "isActive", interval,
  "userId", "createdAt", "updatedAt", "lastChecked",
  next_check_at, "totalChecks", "failedChecks"
)
SELECT
  'https://example.com/',
  'SpiderNode Smoke Check (operator)',
  'PENDING',
  true,
  1440,
  'spidernode-ops-smoke',
  now(),
  now(),
  now(),
  now() + (1440 * interval '1 minute'),
  0,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM monitors
  WHERE "userId" = 'spidernode-ops-smoke' AND url = 'https://example.com/'
);

COMMIT;
