import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import Redis from "ioredis";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// TRACER canary (AUTH-01/AUTH-02/AUTH-09, 07-01 Task 5) — a stored LEGACY
// bcrypt hash authenticates through the REAL Better Auth handler against
// migrated docker-stack data. Real DB, real handler, no mocks
// (tests/worker/health.test.ts harness discipline; fileParallelism: false).
//
// The canary is seeded in 0002's exact semantics: a user row carrying a
// legacy $2a$ hash + a non-null legacy "emailVerified" timestamp, backfilled
// to the boolean, and a credential account row (providerId 'credential',
// accountId = user id) copied from users.password.
//
// Pins:
//   1. POST /api/auth/sign-in/email with the OLD password -> 200 + a session
//      cookie (better-auth.session_token) + a session row in the NEW table
//   2. wrong password -> 401 INVALID_EMAIL_OR_PASSWORD
//   3. unverified user (boolean false, correct password) -> 403
//      EMAIL_NOT_VERIFIED — the D-23 gate survives the engine swap
//   4. the lazy rehash fired on (1): the stored hash changed, and a SECOND
//      sign-in with the OLD password still verifies (AUTH-09 loop closed)
// ---------------------------------------------------------------------------

// 07-03 additions: the enqueue seam is MOCKED (capturing fake queue — no
// BullMQ/Redis lane connection) because the D-28 proof must read the reset
// token out of the rendered email bytes the sendResetPassword hook produced.
// Sign-ins never enqueue, so the mock is inert for the original tracer pins.

const producerMocks = vi.hoisted(() => ({
  emailAdd: vi.fn(async (_name: string, _data: unknown, _opts?: unknown) => ({
    id: "email-job-1",
  })),
}));

// 06-06 gap 2: async importOriginal factory spreading the REAL module and
// overriding ONLY webQueueProducer — the REAL withProducerDeadline wraps the
// email door's add (enqueueTransactionalEmail imports it from this module),
// so a locally-absent export must never silently skip the production wrap.
vi.mock("@/lib/queue-producer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queue-producer")>();
  return {
    ...actual,
    webQueueProducer: () => ({
      ping: vi.fn(async () => "PONG"),
      email: { add: producerMocks.emailAdd },
      checks: { add: vi.fn() },
      close: async () => {},
    }),
  };
});

process.env.BETTER_AUTH_SECRET = `tracer-secret-${randomUUID()}-${randomUUID()}`;
process.env.BETTER_AUTH_URL = "http://localhost:3000";
// Fake provider credentials (07-03): the D-26 leg drives the real
// sign-in/social initiation, and the engine throws on an undefined client id
// when building the authorize URL. The provider's HTTP surface itself is
// stubbed in the D-26 case below.
process.env.GOOGLE_CLIENT_ID = `fake-google-id-${randomUUID()}`;
process.env.GOOGLE_CLIENT_SECRET = `fake-google-secret-${randomUUID()}`;
process.env.GITHUB_CLIENT_ID = `fake-github-id-${randomUUID()}`;
process.env.GITHUB_CLIENT_SECRET = `fake-github-secret-${randomUUID()}`;

// Imported AFTER the env pins so the module-scope auth singleton evaluates
// with them pinned. The route module is the proof surface: every case drives
// the catch-all's own POST export (toNextJsHandler(auth).POST). GET is the
// callback leg's verb (D-26).
const { POST, GET } = await import("@/app/api/auth/[...all]/route");

const RUN = randomUUID();
const OLD_PASSWORD = `old-password-${RUN}`;
// Each canary gets its OWN salted hash (fresh hashSync call per user) —
// independent registrations never share a salted output, and the A-1
// upgrade UPDATE keys on hash equality (A1): a shared hash constant would
// make one account's upgrade rehash the other's row too.
const VERIFIED_LEGACY_HASH = bcrypt.hashSync(OLD_PASSWORD, 10);
const UNVERIFIED_LEGACY_HASH = bcrypt.hashSync(OLD_PASSWORD, 10);
const VERIFIED_USER_ID = `tracer-verified-${RUN}`;
const UNVERIFIED_USER_ID = `tracer-unverified-${RUN}`;
const VERIFIED_EMAIL = `tracer-verified-${RUN}@example.test`;
const UNVERIFIED_EMAIL = `tracer-unverified-${RUN}@example.test`;
const ALL_IDS = [VERIFIED_USER_ID, UNVERIFIED_USER_ID];

let pg: Client;
/** Dedicated admin client flushing the engine's own keyspace per test. */
const redisAdmin = new Redis(process.env.REDIS_URL!);

/**
 * Flushes Better Auth's secondary-storage keyspace (rate-limit counters +
 * session cache). Required since 07-03 enabled the engine limiter: the
 * sensitive-route default (3 per 10s on /sign-in/*) would otherwise trip on
 * the tracer suite's back-to-back sign-ins, and the custom 5/h rules would
 * leak counters across test runs (the test Redis persists between runs).
 */
async function flushBetterAuthKeys(): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await redisAdmin.scan(cursor, "MATCH", "better-auth:*", "COUNT", 100);
    if (batch.length > 0) {
      await redisAdmin.del(...batch);
    }
    cursor = next;
  } while (cursor !== "0");
}

beforeEach(async () => {
  await flushBetterAuthKeys();
});

async function seedCanary(id: string, email: string, verified: boolean, legacyHash: string): Promise<void> {
  await pg.query(
    `INSERT INTO users (id, name, email, "emailVerified", password, timezone, "createdAt", "updatedAt")
     VALUES ($1, 'Tracer Canary', $2, $3, $4, 'UTC', now(), now())`,
    [id, email, verified ? "2026-03-01 09:00:00.000" : null, legacyHash]
  );
  // 0002 semantics: credential account row copied from users.password, and
  // the D-23 truthiness backfill.
  await pg.query(
    `INSERT INTO account ("id", "userId", "providerId", "accountId", "password", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, 'credential', $1, $2, now(), now())`,
    [id, legacyHash]
  );
  await pg.query(`UPDATE users SET "email_verified" = ("emailVerified" IS NOT NULL) WHERE id = $1`, [id]);
}

function signInRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  await seedCanary(VERIFIED_USER_ID, VERIFIED_EMAIL, true, VERIFIED_LEGACY_HASH);
  await seedCanary(UNVERIFIED_USER_ID, UNVERIFIED_EMAIL, false, UNVERIFIED_LEGACY_HASH);
});

afterAll(async () => {
  // session/account rows cascade with the users (onDelete cascade).
  await pg
    .query(`DELETE FROM users WHERE id = ANY($1::text[])`, [...ALL_IDS, ...EXTRA_IDS])
    .catch(() => {});
  await redisAdmin.quit().catch(() => {});
  await pg.end().catch(() => {});
});

describe("Better Auth cutover tracer — legacy-bcrypt canary through the catch-all handler", () => {
  it("1. the OLD password signs in through POST /api/auth/sign-in/email (200 + session cookie)", async () => {
    const res = await POST(signInRequest({ email: VERIFIED_EMAIL, password: OLD_PASSWORD }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("better-auth.session_token");
    const body = (await res.json()) as { user?: { id: string; email: string } };
    expect(body.user?.id).toBe(VERIFIED_USER_ID);
    expect(body.user?.email).toBe(VERIFIED_EMAIL.toLowerCase());

    // The session lives in the NEW session table (engine swap is real).
    const sessionRows = await pg.query(
      `SELECT count(*)::int AS n FROM session WHERE "userId" = $1`,
      [VERIFIED_USER_ID]
    );
    expect(sessionRows.rows[0].n).toBeGreaterThan(0);
  });

  it("2. the lazy rehash fired on the first login, and a SECOND sign-in with the OLD password still verifies (AUTH-09)", async () => {
    const deadline = Date.now() + 5000;
    let upgraded: string | null = null;
    while (Date.now() < deadline) {
      const res = await pg.query(
        `SELECT "password" FROM account WHERE "userId" = $1 AND "providerId" = 'credential'`,
        [VERIFIED_USER_ID]
      );
      const stored = res.rows[0]?.password as string | undefined;
      if (stored && stored !== VERIFIED_LEGACY_HASH) {
        upgraded = stored;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(upgraded).not.toBeNull();
    expect(upgraded!).toMatch(/^\$2[aby]\$10\$/);
    await expect(bcrypt.compare(OLD_PASSWORD, upgraded!)).resolves.toBe(true);

    // The upgrade still verifies through the engine (AUTH-09 loop closed).
    const second = await POST(signInRequest({ email: VERIFIED_EMAIL, password: OLD_PASSWORD }));
    expect(second.status).toBe(200);
  });

  it("3. a wrong password is a 401 INVALID_EMAIL_OR_PASSWORD (no hash upgrade)", async () => {
    const before = await pg.query(
      `SELECT "password" FROM account WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [UNVERIFIED_USER_ID]
    );
    const storedBefore = before.rows[0].password as string;

    const res = await POST(signInRequest({ email: VERIFIED_EMAIL, password: `wrong-${RUN}` }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_EMAIL_OR_PASSWORD");

    // The unverified user's hash is untouched (its verify never ran).
    const after = await pg.query(
      `SELECT "password" FROM account WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [UNVERIFIED_USER_ID]
    );
    expect(after.rows[0].password).toBe(storedBefore);
  });

  it("4. an unverified user with the CORRECT password is a 403 EMAIL_NOT_VERIFIED (D-23 gate survives)", async () => {
    const res = await POST(signInRequest({ email: UNVERIFIED_EMAIL, password: OLD_PASSWORD }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");

    // No session row for the unverified canary — the gate held.
    const sessionRows = await pg.query(
      `SELECT count(*)::int AS n FROM session WHERE "userId" = $1`,
      [UNVERIFIED_USER_ID]
    );
    expect(sessionRows.rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 07-03 behavioral parity pins (Task 1) — the locked session/linking/reset
// decisions proven through the REAL handler on real docker-stack data:
//
//   D-25: sign-up mints NO session until the verification link is clicked
//         (the engine default WOULD mint one — the pin is load-bearing).
//   D-28: a password reset revokes the user's other sessions — the phase's
//         ONE deliberate session-behavior delta (engine default keeps them).
//   D-26: a GitHub sign-in for an email that already exists under Google is
//         refused with the not-linked error and merges NOTHING — driven to
//         the real callback with the provider's HTTP surface stubbed.
//   D-22: request-password-reset for an OAuth-only account returns the clear
//         message; reset-of-record (D-28's user) succeeds through the same
//         hooks.before guard the other way (credential row present).
//
// Requests carry an x-forwarded-for header (unique per case) — the
// advanced.ipAddress.ipAddressHeaders pin is what makes the engine limiter
// key per-case, and the flush above keeps counters deterministic.
// ---------------------------------------------------------------------------

const RUN2 = randomUUID();
const EXTRA_IDS: string[] = [];
const SIGNUP_EMAIL = `parity-signup-${RUN2}@example.test`;
const RESET_USER_ID = `parity-reset-${RUN2}`;
const RESET_EMAIL = `parity-reset-${RUN2}@example.test`;
const RESET_OLD_PASSWORD = `parity-old-${RUN2}`;
const RESET_NEW_PASSWORD = `parity-new-${RUN2}`;
const RESET_HASH = bcrypt.hashSync(RESET_OLD_PASSWORD, 10);
const OAUTH_ONLY_USER_ID = `parity-oauthonly-${RUN2}`;
const OAUTH_ONLY_EMAIL = `parity-oauthonly-${RUN2}@example.test`;
const CROSS_USER_ID = `parity-cross-${RUN2}`;
const CROSS_EMAIL = `parity-cross-${RUN2}@example.test`;
const GOOGLE_ACCOUNT_ID = `google-${RUN2}`;

function apiRequest(path: string, body: unknown, ip: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function callbackRequest(path: string, ip: string, cookie?: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": ip,
      ...(cookie ? { cookie } : {}),
    },
  });
}

/** The reset token is only ever observable inside the hook's rendered bytes. */
function extractResetToken(html: string): string {
  // The rendered url carries a trailing ?callbackURL=... — stop at ? too.
  const match = html.match(/\/api\/auth\/reset-password\/([^"'\s<?]+)/);
  if (!match) throw new Error(`no reset url in rendered bytes: ${html.slice(0, 200)}`);
  return match[1];
}

describe("07-03 behavioral parity pins through the real handler", () => {
  it("D-25: sign-up mints NO session — no session cookie and no session row", async () => {
    const res = await POST(
      apiRequest(
        "/api/auth/sign-up/email",
        { name: "Parity Signup", email: SIGNUP_EMAIL, password: "parity-password-123" },
        "203.0.113.10",
      ),
    );
    expect([200, 201]).toContain(res.status);

    // NO session cookie on the sign-up response (autoSignIn: false).
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain("better-auth.session_token");

    // The user exists but holds ZERO session rows.
    const signedUp = await pg.query(`SELECT id FROM users WHERE email = $1`, [SIGNUP_EMAIL]);
    expect(signedUp.rows).toHaveLength(1);
    EXTRA_IDS.push(signedUp.rows[0].id as string);
    const sessionRows = await pg.query(
      `SELECT count(*)::int AS n FROM session WHERE "userId" = $1`,
      [signedUp.rows[0].id],
    );
    expect(sessionRows.rows[0].n).toBe(0);
  });

  it("D-28: a password reset revokes the user's other sessions (the ONE deliberate delta)", async () => {
    await seedCanary(RESET_USER_ID, RESET_EMAIL, true, RESET_HASH);
    EXTRA_IDS.push(RESET_USER_ID);

    // Two independent sessions for the user (two devices, parity with D-44).
    const first = await POST(
      signInRequest({ email: RESET_EMAIL, password: RESET_OLD_PASSWORD }),
    );
    expect(first.status).toBe(200);
    const second = await POST(
      apiRequest(
        "/api/auth/sign-in/email",
        { email: RESET_EMAIL, password: RESET_OLD_PASSWORD },
        "203.0.113.11",
      ),
    );
    expect(second.status).toBe(200);
    const before = await pg.query(
      `SELECT count(*)::int AS n FROM session WHERE "userId" = $1`,
      [RESET_USER_ID],
    );
    expect(before.rows[0].n).toBe(2);

    // Trigger request-password-reset; the reset token arrives via the (mocked) queue
    // inside the hook's rendered email bytes.
    producerMocks.emailAdd.mockClear();
    const forgot = await POST(
      apiRequest(
        "/api/auth/request-password-reset",
        { email: RESET_EMAIL, redirectTo: "/reset-password" },
        "203.0.113.12",
      ),
    );
    expect(forgot.status).toBe(200);
    expect(producerMocks.emailAdd).toHaveBeenCalledTimes(1);
    const [, jobData] = producerMocks.emailAdd.mock.calls[0];
    const token = extractResetToken((jobData as { html: string }).html);

    const reset = await POST(
      apiRequest(
        "/api/auth/reset-password",
        { newPassword: RESET_NEW_PASSWORD, token },
        "203.0.113.13",
      ),
    );
    expect(reset.status).toBe(200);

    // EVERY pre-reset session is gone — the engine revoked them (D-28).
    const after = await pg.query(
      `SELECT count(*)::int AS n FROM session WHERE "userId" = $1`,
      [RESET_USER_ID],
    );
    expect(after.rows[0].n).toBe(0);

    // The new password verifies, the old one no longer does (the reset was
    // real, not just a revocation).
    const relogin = await POST(
      apiRequest(
        "/api/auth/sign-in/email",
        { email: RESET_EMAIL, password: RESET_NEW_PASSWORD },
        "203.0.113.14",
      ),
    );
    expect(relogin.status).toBe(200);
    const oldPassword = await POST(
      apiRequest(
        "/api/auth/sign-in/email",
        { email: RESET_EMAIL, password: RESET_OLD_PASSWORD },
        "203.0.113.15",
      ),
    );
    expect(oldPassword.status).toBe(401);
  });

  it("D-22: request-password-reset for an OAuth-only account returns the clear Google/GitHub message", async () => {
    // Seed a user with ONLY a google-shaped account row — no credential row
    // with a password anywhere.
    await pg.query(
      `INSERT INTO users (id, name, email, "emailVerified", timezone, "createdAt", "updatedAt")
       VALUES ($1, 'Parity OAuthOnly', $2, now(), 'UTC', now(), now())`,
      [OAUTH_ONLY_USER_ID, OAUTH_ONLY_EMAIL],
    );
    await pg.query(`UPDATE users SET "email_verified" = true WHERE id = $1`, [OAUTH_ONLY_USER_ID]);
    await pg.query(
      `INSERT INTO account ("id", "userId", "providerId", "accountId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'google', $2, now(), now())`,
      [OAUTH_ONLY_USER_ID, GOOGLE_ACCOUNT_ID],
    );
    EXTRA_IDS.push(OAUTH_ONLY_USER_ID);

    producerMocks.emailAdd.mockClear();
    const res = await POST(
      apiRequest(
        "/api/auth/request-password-reset",
        { email: OAUTH_ONLY_EMAIL, redirectTo: "/reset-password" },
        "203.0.113.16",
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toBe("This account signs in with Google or GitHub.");

    // The refusal happened at the guard — NOTHING was enqueued.
    expect(producerMocks.emailAdd).not.toHaveBeenCalled();
  });

  it("D-26: a GitHub sign-in for a Google-held email is refused with account_not_linked and merges nothing", async () => {
    // The email already exists under Google (own google account row).
    await pg.query(
      `INSERT INTO users (id, name, email, "emailVerified", timezone, "createdAt", "updatedAt")
       VALUES ($1, 'Parity Cross', $2, now(), 'UTC', now(), now())`,
      [CROSS_USER_ID, CROSS_EMAIL],
    );
    await pg.query(`UPDATE users SET "email_verified" = true WHERE id = $1`, [CROSS_USER_ID]);
    await pg.query(
      `INSERT INTO account ("id", "userId", "providerId", "accountId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'google', $2, now(), now())`,
      [CROSS_USER_ID, `google-cross-${RUN2}`],
    );
    EXTRA_IDS.push(CROSS_USER_ID);

    // The provider's HTTP surface is stubbed (token exchange + profile):
    // GitHub answers with a verified profile whose email is the Google-held
    // one. Everything else fetches normally.
    const realFetch = globalThis.fetch;
    const githubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({ access_token: `gh-token-${RUN2}`, token_type: "bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({
            id: 987654,
            login: "parity-cross",
            name: "Parity Cross GH",
            email: CROSS_EMAIL,
            avatar_url: "https://avatars.githubusercontent.com/u/987654",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/user/emails") {
        return new Response(
          JSON.stringify([{ email: CROSS_EMAIL, primary: true, verified: true }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input as Request, init);
    }) as typeof fetch;
    globalThis.fetch = githubFetch;
    try {
      // Initiate the GitHub sign-in for the Google-held email.
      const initiate = await POST(
        apiRequest(
          "/api/auth/sign-in/social",
          { provider: "github", callbackURL: "/dashboard", errorCallbackURL: "/login" },
          "203.0.113.17",
        ),
      );
      expect(initiate.status).toBe(200);
      const initiated = (await initiate.json()) as { url?: string };
      expect(initiated.url).toContain("state=");

      // The initiation sets the SIGNED state cookie (the CSRF guard the
      // engine re-checks at callback) — a real browser would carry it, so
      // the callback request forwards it verbatim.
      const stateCookie = initiate.headers.get("set-cookie") ?? "";
      expect(stateCookie).toContain("better-auth.state=");

      // Drive the REAL callback leg with the minted state + a fake code.
      const state = new URL(initiated.url!).searchParams.get("state");
      expect(state).toBeTruthy();
      const callback = await GET(
        callbackRequest(
          `/api/auth/callback/github?code=fake-code&state=${encodeURIComponent(state!)}`,
          "203.0.113.18",
          stateCookie.split(";")[0],
        ),
      );

      // The refusal redirects with the not-linked error (NextAuth's
      // OAuthAccountNotLinked parity).
      const location = callback.headers.get("location") ?? "";
      expect(location).toContain("account_not_linked");

      // NOTHING merged: still exactly ONE account row (google) for the user,
      // and no second user row was created for the email.
      const accounts = await pg.query(
        `SELECT count(*)::int AS n FROM account WHERE "userId" = $1`,
        [CROSS_USER_ID],
      );
      expect(accounts.rows[0].n).toBe(1);
      const providers = await pg.query(
        `SELECT "providerId" FROM account WHERE "userId" = $1`,
        [CROSS_USER_ID],
      );
      expect(providers.rows.map((r) => r.providerId)).toEqual(["google"]);
      const userRows = await pg.query(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [
        CROSS_EMAIL,
      ]);
      expect(userRows.rows[0].n).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
