-- Migration 0003: legacy auth table drop release (AUTH-07/D-32). The
-- additive-inverse of 0002's expand half: the four legacy NextAuth-era
-- tables — sessions, verification_tokens, password_reset_tokens, accounts —
-- are dropped WITH their data (D-27: expired tokens are worthless and the
-- accounts rows were reshaped into Better Auth's `account` at 0002; the
-- one-release read-only window was the protection — NO export/archive step).
--
-- SANCTIONED DROP LIST (T-07-32): these four tables and NOTHING else. The
-- surviving auth substrate is untouched: users (all columns — users.password
-- stays INERT, never dropped this milestone) and the Better Auth tables
-- account/session/verification are not referenced by any statement below.
-- Nothing outside the four legacy tables is touched — no DROP/ALTER on any
-- other object, no data rewrite. Rehearsed on the anonymized production
-- snapshot (pnpm rehearse:migrations, 03d/DRZ-06 discipline) before ever
-- reaching production; the rehearsal's DDL delta sanctions exactly these
-- removals and fails on anything else.
--
-- Rollback: there is NO un-drop migration — the ONLY revert is restoring the
-- pre-drop pg_dump backup (docs/DEPLOY-RUNBOOK.md §4e step 1 is the sole
-- rollback artifact; §7's redeploy lever died with the legacy tables by
-- design — that is what "dropped in an explicit drop release" means).

DROP TABLE IF EXISTS "sessions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "verification_tokens" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "password_reset_tokens" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "accounts" CASCADE;
