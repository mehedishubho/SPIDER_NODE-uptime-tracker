import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
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

process.env.BETTER_AUTH_SECRET = `tracer-secret-${randomUUID()}-${randomUUID()}`;
process.env.BETTER_AUTH_URL = "http://localhost:3000";

// Imported AFTER the env pins so the module-scope auth singleton evaluates
// with them pinned. The route module is the proof surface: every case drives
// the catch-all's own POST export (toNextJsHandler(auth).POST).
const { POST } = await import("@/app/api/auth/[...all]/route");

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
  await pg.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ALL_IDS]).catch(() => {});
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
