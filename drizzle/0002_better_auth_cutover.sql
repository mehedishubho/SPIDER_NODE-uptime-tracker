-- Migration 0002: Better Auth cutover (AUTH-03). PURELY ADDITIVE — the D-30
-- redeploy-only rollback rests on every legacy table/column surviving
-- untouched: no DROP, no RENAME, no rewrite of users/sessions/accounts/
-- verification_tokens/password_reset_tokens. The legacy "emailVerified"
-- timestamp column is NEVER touched — the new boolean is a separate column
-- backfilled from its truthiness (D-23).
--
-- New objects: Better Auth core tables account/session/verification
-- (audit §12.1 field map; admin-plugin columns role/banned/banReason/
-- banExpires on users and impersonatedBy on session exist from day one —
-- Better Auth validates mapped plugin columns at init, in production too —
-- and verification.createdAt is a core-schema requirement the init check
-- enforces the same way) plus users.role (D-08, one-way decision ratified at
-- the Task-3 checkpoint) and users.email_verified (D-23).
--
-- Backfills (idempotent, ON CONFLICT DO NOTHING — §21/D9 rule):
--   1. credential account rows from users.password (providerId 'credential',
--      accountId = user id — Better Auth core-schema contract);
--   2. OAuth reshape from the NextAuth accounts table (providerId = the
--      legacy provider value, lowercase google/github; refresh/access tokens
--      preserved per D-40);
--   3. the D-23 boolean backfill.
-- The D-08 admin grant is NOT literal SQL here: scripts/seed-admin-roles.mjs
-- reads ADMIN_EMAILS and aborts on missing/empty/zero-match (D-09), run at
-- migration time by the operator against the target stack.

CREATE TABLE "account" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"userId" text NOT NULL,
	"providerId" text NOT NULL,
	"accountId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"impersonatedBy" text
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banReason" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banExpires" timestamp;
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account" USING btree ("providerId" text_ops,"accountId" text_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_key" ON "session" USING btree ("token" text_ops);
--> statement-breakpoint
-- 1. Credential rows (audit §12.1: providerId 'credential', accountId = user id).
INSERT INTO "account" ("id", "userId", "providerId", "accountId", "password", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."id", 'credential', u."id", u."password", now(), now()
FROM "users" u
WHERE u."password" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 2. OAuth reshape — providerId = the legacy provider value (lowercase google/github),
--    refresh/access/id tokens + scope preserved, expires_at epoch -> timestamp.
INSERT INTO "account" ("id", "userId", "providerId", "accountId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "scope", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."userId", a."provider", a."providerAccountId", a."access_token", a."refresh_token", a."id_token", to_timestamp(a."expires_at"), a."scope", now(), now()
FROM "accounts" a
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 3. Boolean backfill (D-23): exact truthiness of the legacy timestamp.
UPDATE "users" SET "email_verified" = ("emailVerified" IS NOT NULL);
