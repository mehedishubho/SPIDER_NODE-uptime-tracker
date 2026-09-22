import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth-password";

// ---------------------------------------------------------------------------
// The Better Auth instance (07-01 Task 5 tracer slice) — MINIMAL credentials
// core; 07-03 expands it with the full parity pin set (socialProviders,
// admin() plugin, emailVerification/sendResetPassword hooks -> the Phase-6
// queue, cookieCache, rateLimiter + secondaryStorage). This file is the
// phase skeleton's first production path: the legacy-bcrypt canary sign-in.
//
// Parity pins that ALREADY land here (the rest are 07-03's):
//   - A-1 gate (AUTH-01/AUTH-09): password.{hash,verify} = the prefix router
//     in ./auth-password — the engine's scrypt default would lock out every
//     existing user (audit §12.2).
//   - D-23: requireEmailVerification keeps the unverified-credentials gate
//     (the legacy authorize() throw at src/lib/auth.ts:47-49 becomes the
//     engine's 403 EMAIL_NOT_VERIFIED — mapped client-side in 07-04).
//   - D-25: autoSignIn: false — sign-up mints NO session until verified
//     (the engine default would bypass the verification gate).
//   - D-42: 30-day session expiry — parity with today's JWTs (sliding
//     renewal stays the engine default per D-43).
//   - AUTH-03: adapter bound to the EXISTING users table (A-3: zero renames)
//     with the new boolean mapped via user.fields (emailVerified ->
//     "email_verified"; the legacy timestamp column is never touched — D-30).
//   - §11/D-3: advanced.database.generateId: false — DB-side
//     gen_random_uuid()::text defaults mint every id.
//
// Throw-early env convention (06 D-11; queue-producer shape): production
// boots loud when BETTER_AUTH_SECRET/BETTER_AUTH_URL are missing — a silent
// fallback would mint unsigned cookies on the live system.
//
// ZERO next/* imports (worker boundary, D-18/A-2): the worker imports this
// same instance for the Bull Board session gate in 07-05; toNextJsHandler
// stays in the route file.
// ---------------------------------------------------------------------------

/** Production-only env validation (queue-producer throw-early convention). */
function requireProductionEnv(name: string): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env[name]) {
    throw new Error(`Environment variable ${name} is not set (required in production)`);
  }
}

export function createAuth() {
  requireProductionEnv("BETTER_AUTH_SECRET");
  requireProductionEnv("BETTER_AUTH_URL");

  return betterAuth({
    basePath: "/api/auth", // keeps the /api/auth/* shape — OAuth callbacks unchanged (research pin)
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        users: schema.users, // model user -> the EXISTING users table (A-3)
        account: schema.account,
        session: schema.session,
        verification: schema.verification,
      },
    }),
    user: {
      modelName: "users",
      fields: {
        // The new boolean (0002 backfilled it from the legacy timestamp's
        // truthiness, D-23) — the legacy "emailVerified" timestamp column is
        // never consulted again and never touched (D-30 rollback lever).
        emailVerified: "email_verified",
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true, // D-23 gate survives
      minPasswordLength: 6, // parity with today's register/reset rule (A3)
      autoSignIn: false, // D-25 PARITY PIN — engine default TRUE mints a session on sign-up
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // D-42: 30-day pin (engine default 7d)
    },
    advanced: {
      database: {
        generateId: false, // defer to the DB defaults (gen_random_uuid()::text) — §11 pin
      },
    },
  });
}

export const auth = createAuth();
