-- Migration 0004: windowed uptime columns (DAT-11). PURELY ADDITIVE — three
-- nullable double precision columns on monitors (uptime24h/uptime7d/
-- uptime30d); no DROP, no RENAME, no change to any existing column, no
-- backfill here. D-23: the backfill is the FIRST nightly run of the
-- 'recompute-windowed-uptime' maintenance job over the retained 30-day ping
-- history, never migration-time SQL. D-22 reversibility (one-way): undoing
-- these columns is a follow-up drop migration plus re-planning; they persist
-- harmlessly if the v2 display switch never reads them (nothing reads the
-- windowed values in v1, D-24). Applied through the single runner
-- (drizzle-kit migrate); drizzle-kit push is forbidden (DRZ-02).

ALTER TABLE "monitors" ADD COLUMN "uptime24h" double precision;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "uptime7d" double precision;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "uptime30d" double precision;
