import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { redisStorage } from "@better-auth/redis-storage";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { account, users } from "@/db/schema";
import { redis } from "@/lib/redis";
import { hashPassword, verifyPassword } from "@/lib/auth-password";
import { enqueueTransactionalEmail } from "@/lib/email/enqueue";
import {
  renderPasswordResetEmailFromUrl,
  renderVerificationEmailFromUrl,
} from "@/lib/email/render";

// ---------------------------------------------------------------------------
// The Better Auth instance — FULL PARITY CONFIG (07-03, the engine flip).
// Every locked parity decision appears as an explicit pin or proven behavior;
// three engine defaults are INVERTED vs our parity and must never be trusted
// (auto-linking ON, autoSignIn ON, revoke-on-reset OFF — RESEARCH pitfalls
// 2/3). Decision lineage per pin:
//
//   A-1 (AUTH-01/09): password.{hash,verify} = the bcrypt prefix router in
//     ./auth-password — the engine's scrypt default would lock out every
//     existing user (audit §12.2).
//   D-21: verification/reset TTLs = engine defaults 3600 (today was 24h for
//     verification; defaults win). resetPasswordTokenExpiresIn: 3600 equals
//     today's reset TTL exactly.
//   D-22 (mirror-the-intent, resolved in 07-RESEARCH OQ2): the hooks.before
//     guard on the engine's forget-password path returns the clear OAuth-only
//     message when the user has NO credential account row with a password;
//     reset succeeds regardless of verified status, and the engine never
//     flips any verified timestamp (documented delta vs today's route, which
//     silently set emailVerified — Pitfall 12).
//   D-23: requireEmailVerification keeps the unverified-credentials gate
//     (the legacy authorize() throw becomes the engine's 403
//     EMAIL_NOT_VERIFIED — mapped client-side in 07-04).
//   D-24: rateLimit = the engine limiter with Redis secondaryStorage (limits
//     survive deploys; memory would reset on every PM2 restart) +
//     customRules pinning register/forgot at 5/h per IP (today's parity);
//     sign-in additionally gains the engine's sensitive-route default — a
//     documented improvement delta. NOTE the engine's spelling
//     "/forget-password" for the custom rule key.
//   D-25: autoSignIn: false — sign-up mints NO session until the verification
//     link is clicked (engine default TRUE would bypass the gate).
//   D-26: account.accountLinking.disableImplicitLinking: true — the engine
//     default is AUTO-LINK (inverted!); this reproduces NextAuth's
//     OAuthAccountNotLinked refusal for same-email cross-provider sign-ins.
//   D-28: revokeSessionsOnPasswordReset: true — the phase's ONE deliberate
//     session-behavior delta (engine default false); reset revokes the
//     user's other sessions.
//   D-42/D-43/D-44: expiresIn 30 days (parity with today's JWTs), sliding
//     renewal via the engine default updateAge, freshAge default, and NO
//     concurrent-session cap (the engine has none by default).
//   AUTH-04/A-2: cookieCache { enabled, maxAge 5 min, strategy "jwt" } — the
//     proxy validates /dashboard/* from the signed cookie with no per-request
//     DB hit; revocation lag is bounded at 5 min (the audit's own accepted
//     policy) and sensitive checks can force a DB read via the engine's
//     disableCookieCache.
//   D-13: the admin() plugin is enabled for the ROLE PRIMITIVE ONLY
//     (users.role + server-side role checks for the gates). Its management
//     endpoints (ban/unban, impersonate, user listing) are deliberately
//     UNUSED — no surface may wire them (plan prohibition).
//   D-14/R17: the role feeds GET /api/feedback's admin gate (07-03 Task 2).
//   EML-04 (06 D-07): both email hooks render-at-enqueue through the
//     Phase-6 queue — zero in-request SMTP. The *FromUrl render variants
//     (07-02) embed Better Auth's prebuilt url exactly.
//   T-07-10 (WR-06 pairing): advanced.ipAddress.ipAddressHeaders pinned to
//     the single reverse-proxy header — the limiter's IP derives from
//     x-forwarded-for only.
//   AUTH-03/§11: adapter bound to the EXISTING users table (A-3: zero
//     renames), new boolean mapped via user.fields, DB-side id defaults via
//     advanced.database.generateId: false.
//
// Throw-early env convention (06 D-11; queue-producer shape): production
// boots loud when BETTER_AUTH_SECRET/BETTER_AUTH_URL or any OAuth credential
// is missing — a silent fallback would mint unsigned cookies or a broken
// provider on the live system (the legacy config's `|| ""` form is NOT
// carried over). Env NAMES carry over from the legacy config unchanged.
//
// ZERO next/* imports (worker boundary, D-18/A-2): the worker imports this
// same instance for the Bull Board session gate in 07-05; toNextJsHandler
// stays in the route file. `auth.options` is the audit surface for the
// parity pins (tests assert them).
// ---------------------------------------------------------------------------

/** Production-only env validation (queue-producer throw-early convention). */
function requireProductionEnv(name: string): void {
  if (process.env.NODE_ENV !== "production") return;
  // `next build` collects page data by EVALUATING route modules under
  // NODE_ENV=production — before the operator's env exists on any build
  // host. The throw-early gate is a production RUNTIME boot guarantee (PM2
  // runs without NEXT_PHASE), not a build gate: skip it during
  // phase-production-build so an env-less checkout still builds.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (!process.env[name]) {
    throw new Error(`Environment variable ${name} is not set (required in production)`);
  }
}

/**
 * The D-22 OAuth-only reset refusal — the exact string the operator approves
 * at the rehearsal (D-06 copy sign-off) and 07-04 maps client-side (D-33).
 */
export const OAUTH_ONLY_RESET_MESSAGE = "This account signs in with Google or GitHub.";

export function createAuth() {
  requireProductionEnv("BETTER_AUTH_SECRET");
  requireProductionEnv("BETTER_AUTH_URL");
  requireProductionEnv("GOOGLE_CLIENT_ID");
  requireProductionEnv("GOOGLE_CLIENT_SECRET");
  requireProductionEnv("GITHUB_CLIENT_ID");
  requireProductionEnv("GITHUB_CLIENT_SECRET");

  return betterAuth({
    basePath: "/api/auth", // keeps the /api/auth/* shape — OAuth callbacks unchanged (research pin)
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [process.env.BETTER_AUTH_URL!],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        users: schema.users, // model user -> the EXISTING users table (A-3)
        account: schema.account,
        session: schema.session,
        verification: schema.verification,
      },
    }),
    // D-24: Redis-backed secondary storage (version-locked @better-auth/redis-
    // storage) — the rate limiter's counters survive deploys, and the engine
    // may cache session data beside them.
    secondaryStorage: redisStorage({ client: redis }),
    user: {
      modelName: "users",
      fields: {
        // The new boolean (0002 backfilled it from the legacy timestamp's
        // truthiness, D-23) — the legacy "emailVerified" timestamp column is
        // never consulted again and never touched (D-30 rollback lever).
        emailVerified: "email_verified",
      },
    },
    account: {
      accountLinking: {
        // D-26 PARITY PIN — engine default is AUTO-LINK (inverted). Same-email
        // cross-provider sign-ins are refused (account_not_linked), never
        // silently merged.
        disableImplicitLinking: true,
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true, // D-23 gate survives
      minPasswordLength: 6, // parity with today's register/reset rule (A3)
      autoSignIn: false, // D-25 PARITY PIN — engine default TRUE mints a session on sign-up
      revokeSessionsOnPasswordReset: true, // D-28 — the ONE deliberate delta (engine default false)
      resetPasswordTokenExpiresIn: 3600, // D-21: engine default = today's reset TTL
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
      sendResetPassword: async ({ user, url }) => {
        // EML-04 / 06 D-07: render-at-enqueue, zero in-request SMTP. The
        // FromUrl variant (07-02) embeds Better Auth's prebuilt url exactly.
        await enqueueTransactionalEmail(renderPasswordResetEmailFromUrl(user.email, url));
      },
    },
    emailVerification: {
      expiresIn: 3600, // D-21: engine default (today was 24h — defaults win)
      sendOnSignUp: true, // registration still emails (replaces the deleted register route's send)
      sendOnSignIn: false, // D-23 PARITY PIN (Pitfall 4: verified against installed 1.7.5 types) — no new email on blocked login attempts
      sendVerificationEmail: async ({ user, url }) => {
        await enqueueTransactionalEmail(renderVerificationEmailFromUrl(user.email, url));
      },
    },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
      github: {
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // D-42: 30-day pin (engine default 7d)
      updateAge: 60 * 60 * 24, // D-43: engine-default 1-day sliding renewal — pinned explicitly
      freshAge: 300, // engine default (5 min freshness window for sensitive ops)
      // With secondaryStorage present the engine's default is Redis-ONLY
      // sessions (reads always from secondary storage). The phase design is
      // DB-backed sessions (D-44: "session rows expire naturally"; the
      // redeploy-rollback substrate must not depend on Redis contents), so
      // rows are ALSO persisted — reads still come from the secondary
      // storage, so the cookieCache/proxy path is unchanged.
      storeSessionInDatabase: true,
      cookieCache: {
        // AUTH-04 / A-2: the proxy validates from the signed cookie with no
        // per-request DB hit; revocation lag bounded at 5 min (T-07-13, the
        // accepted policy).
        enabled: true,
        maxAge: 5 * 60,
        strategy: "jwt",
      },
    },
    rateLimit: {
      enabled: true, // D-24: engine limiter (the house Lua limiter stays for non-auth routes)
      window: 60,
      max: 100,
      storage: "secondary-storage", // Redis via secondaryStorage — survives deploys (Pitfall 9)
      customRules: {
        // Today's 5/h-per-IP parity (D-24). The real endpoint path is
        // "/request-password-reset" (verified against the installed 1.7.5
        // routes — the research note's "/forget-password" spelling is the
        // docs' legacy alias; POSTing /forget-password 404s). Sign-in keeps
        // the engine's sensitive-route default (3 per 10s — the D-24
        // documented improvement delta).
        "/sign-up/email": { window: 3600, max: 5 },
        "/request-password-reset": { window: 3600, max: 5 },
      },
    },
    advanced: {
      database: {
        generateId: false, // defer to the DB defaults (gen_random_uuid()::text) — §11 pin
      },
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for"], // T-07-10: the ONE reverse-proxy header (WR-06 pairing)
      },
    },
    plugins: [
      admin({ adminRoles: ["admin"] }), // D-13: role primitive ONLY — management endpoints unused
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // D-22 (mirror-the-intent): the engine's request-password-reset path
        // for an account with NO credential-account password returns the
        // clear OAuth-only message. Unknown emails fall through to the
        // engine's neutral 200 (anti-enumeration preserved); accounts WITH a
        // credential row fall through to the normal reset flow.
        if (ctx.path !== "/request-password-reset") return;
        const email = (ctx.body as { email?: string } | undefined)?.email;
        if (!email) return;
        const rows = await db
          .select({ hasCredentialPassword: account.password })
          .from(users)
          .leftJoin(
            account,
            and(eq(account.userId, users.id), eq(account.providerId, "credential")),
          )
          .where(eq(users.email, email.toLowerCase().trim()));
        if (rows.length > 0 && rows.every((row) => row.hasCredentialPassword == null)) {
          throw new APIError("BAD_REQUEST", { message: OAUTH_ONLY_RESET_MESSAGE });
        }
      }),
    },
  });
}

export const auth = createAuth();
