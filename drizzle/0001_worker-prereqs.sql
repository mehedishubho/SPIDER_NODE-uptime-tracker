-- Migration 0001: Phase 4 worker prerequisites transcribed from
-- docs/ARCHITECTURE-AUDIT.md §11 (DRZ-04). Additive-only DDL; plain
-- in-transaction index builds per D-19 (sub-second at current dataset size).
-- Existing columns keep their live camelCase names ("isActive", "lastChecked",
-- "createdAt", "interval", "monitorId" — 03-03 pull facts, naive timestamp(3)
-- per A6); every NEW object carries the exact §11 name.

ALTER TABLE monitors ADD COLUMN next_check_at timestamptz NULL;
--> statement-breakpoint
UPDATE "monitors"
   SET next_check_at = (COALESCE("lastChecked", "createdAt") + ("interval" * interval '1 minute')) AT TIME ZONE 'UTC'
 WHERE next_check_at IS NULL;
--> statement-breakpoint
ALTER TABLE monitors ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE pings ADD COLUMN error_class text NULL;
--> statement-breakpoint
ALTER TABLE pings ADD COLUMN status_code integer NULL;
--> statement-breakpoint
ALTER TABLE pings ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
--> statement-breakpoint
ALTER TABLE incidents ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
--> statement-breakpoint
CREATE TABLE write_guards (
  key        text        PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE outbox (
  id          text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_type  text        NOT NULL,
  monitor_id  integer     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  incident_id text        NULL REFERENCES incidents(id) ON DELETE CASCADE,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz NULL,
  attempts    integer     NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX idx_monitors_due ON monitors ("isActive", next_check_at) WHERE "isActive";
--> statement-breakpoint
CREATE INDEX idx_outbox_unsent ON outbox (created_at) WHERE sent_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX incidents_one_ongoing ON incidents ("monitorId") WHERE status = 'ONGOING';
