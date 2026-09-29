import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { BCRYPT_PREFIXES, hashPassword, verifyPassword } from "@/lib/auth-password";

// ---------------------------------------------------------------------------
// A-1 hash-gate suite (AUTH-01/AUTH-09, 07-01 Task 5) — module-scope
// conventions of tests/lib/email-render.test.ts (pinned env/config at module
// scope, focused describes, no default exports under test).
//
// Pins:
//   1. prefix matrix: $2a$/$2b$/$2y$ verify TRUE on the correct password and
//      FALSE on a wrong one (the three bcrypt variants in the wild)
//   2. unknown prefix refuses (fail closed — no fallback acceptance)
//   3. hash() emits bcrypt at 10 rounds (register-route rounds parity)
//   4. AUTH-09 lazy rehash: a successful legacy verify upgrades the stored
//      credential hash copies (docker PG, real db.execute seam) and the
//      upgrade is still a verifying 10-round bcrypt hash; a failed verify
//      upgrades nothing. 07-08 (07-07 §15.3 fix): BOTH stored copies upgrade
//      — "account".password (the row the engine reads at sign-in) and the
//      legacy "users".password column — whenever they still hold the received
//      hash; an already-diverged copy is never rewritten by a hash it does
//      not hold.
// ---------------------------------------------------------------------------

const RUN = randomUUID();
const CORRECT_PASSWORD = `legacy-pass-${RUN}`;
const WRONG_PASSWORD = `wrong-pass-${RUN}`;
const CANARY_USER_ID = `authpw-user-${RUN}`;
const CANARY_EMAIL = `authpw-${RUN}@example.test`;

/**
 * bcryptjs 3.x emits "$2b$" hashes; the legacy corpus (and the plan's matrix)
 * carries all three bcrypt variant markers. The marker is 4 bytes and the
 * algorithm treats 2a/2b/2y identically, so the matrix is built by swapping
 * the marker over one real hash (slice — never String.replace, whose "$2b$"
 * replacement string would parse "$2" as a capture-group reference).
 */
const BASE_BCRYPT_HASH = bcrypt.hashSync(CORRECT_PASSWORD, 10); // "$2b$10$..."
function withPrefix(prefix: string): string {
  return prefix + BASE_BCRYPT_HASH.slice(4);
}
const VARIANT_HASHES = {
  "$2a$": withPrefix("$2a$"),
  "$2b$": withPrefix("$2b$"),
  "$2y$": withPrefix("$2y$"),
};
const A_PREFIX_HASH = VARIANT_HASHES["$2a$"];
const B_PREFIX_HASH = VARIANT_HASHES["$2b$"];

let pg: Client;

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  await pg.query(
    `INSERT INTO users (id, name, email, "emailVerified", password, timezone, "createdAt", "updatedAt")
     VALUES ($1, 'Auth Password Canari', $2, now(), $3, 'UTC', now(), now())`,
    [CANARY_USER_ID, CANARY_EMAIL, BASE_BCRYPT_HASH]
  );
  // The credential account row in 0002's exact shape.
  await pg.query(
    `INSERT INTO account ("id", "userId", "providerId", "accountId", "password", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, 'credential', $1, $2, now(), now())`,
    [CANARY_USER_ID, BASE_BCRYPT_HASH]
  );
});

afterAll(async () => {
  await pg.query(`DELETE FROM users WHERE id = $1`, [CANARY_USER_ID]).catch(() => {});
  await pg.end().catch(() => {});
});

/** Polls until the predicate holds (the upgrade UPDATE is fire-and-forget). */
async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 5000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function storedHash(): Promise<string | null> {
  const res = await pg.query(
    `SELECT "password" FROM account WHERE "userId" = $1 AND "providerId" = 'credential'`,
    [CANARY_USER_ID]
  );
  return res.rows[0]?.password ?? null;
}

/** The legacy users.password copy (read by the profile route's checks). */
async function storedUserHash(): Promise<string | null> {
  const res = await pg.query(`SELECT "password" FROM users WHERE "id" = $1`, [
    CANARY_USER_ID,
  ]);
  return res.rows[0]?.password ?? null;
}

describe("verifyPassword — A-1 prefix routing (AUTH-01)", () => {
  it("1. accepts the correct password for every legacy bcrypt prefix", async () => {
    for (const prefix of BCRYPT_PREFIXES) {
      const hash = VARIANT_HASHES[prefix];
      expect(hash.startsWith(prefix)).toBe(true);
      await expect(verifyPassword({ password: CORRECT_PASSWORD, hash })).resolves.toBe(true);
    }
  });

  it("2. rejects a wrong password for every legacy bcrypt prefix", async () => {
    for (const prefix of BCRYPT_PREFIXES) {
      await expect(
        verifyPassword({ password: WRONG_PASSWORD, hash: VARIANT_HASHES[prefix] })
      ).resolves.toBe(false);
    }
  });

  it("3. refuses unknown prefixes without throwing (fail closed)", async () => {
    for (const hash of [
      "scrypt$32768$8$1$salt$digest", // the engine default's scheme family
      "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$digest", // argon2
      "", // corrupted empty value
      "$2c$10$notarealvariant", // near-miss bcrypt-like prefix
    ]) {
      await expect(verifyPassword({ password: CORRECT_PASSWORD, hash })).resolves.toBe(false);
    }
  });
});

describe("hashPassword — rounds parity", () => {
  it("4. emits bcrypt at 10 rounds, byte-shaped like the register primitive", async () => {
    const hash = await hashPassword(CORRECT_PASSWORD);
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    await expect(bcrypt.compare(CORRECT_PASSWORD, hash)).resolves.toBe(true);
    // Round-trips through the verify router (the "modern" row form today).
    await expect(verifyPassword({ password: CORRECT_PASSWORD, hash })).resolves.toBe(true);
  });
});

describe("lazy rehash — AUTH-09 upgrade on the real db.execute seam (docker PG)", () => {
  it("5. upgrades BOTH stored copies on a successful verify; the upgrades still verify", async () => {
    // Re-pin BOTH stored copies to the exact legacy hash (other cases in this
    // file may have raced the upgrade first) — the 07-08 fix upgrades the
    // account row AND the legacy users copy whenever they hold the hash.
    await pg.query(`UPDATE account SET "password" = $2 WHERE "userId" = $1 AND "providerId" = 'credential'`, [
      CANARY_USER_ID,
      A_PREFIX_HASH,
    ]);
    await pg.query(`UPDATE users SET "password" = $2 WHERE "id" = $1`, [
      CANARY_USER_ID,
      A_PREFIX_HASH,
    ]);

    const verified = await verifyPassword({ password: CORRECT_PASSWORD, hash: A_PREFIX_HASH });
    expect(verified).toBe(true);

    const upgraded = await waitFor(async () => {
      const hash = await storedHash();
      return hash && hash !== A_PREFIX_HASH ? hash : null;
    });
    expect(upgraded).not.toBeNull();
    expect(upgraded!).toMatch(/^\$2[aby]\$10\$/); // fresh 10-round bcrypt, NOT the legacy value
    await expect(bcrypt.compare(CORRECT_PASSWORD, upgraded!)).resolves.toBe(true);
    // The upgraded hash routes through the router again (second sign-in leg).
    await expect(verifyPassword({ password: CORRECT_PASSWORD, hash: upgraded! })).resolves.toBe(true);

    // 07-08: the legacy users copy upgraded WITH the account row — the copies
    // can never diverge through the rehash path (07-07 §15.3).
    const upgradedUserCopy = await waitFor(async () => {
      const hash = await storedUserHash();
      return hash && hash !== A_PREFIX_HASH ? hash : null;
    });
    expect(upgradedUserCopy).toBe(upgraded);
  });

  it("6. a failed verify leaves both stored copies untouched", async () => {
    await pg.query(`UPDATE account SET "password" = $2 WHERE "userId" = $1 AND "providerId" = 'credential'`, [
      CANARY_USER_ID,
      B_PREFIX_HASH,
    ]);
    await pg.query(`UPDATE users SET "password" = $2 WHERE "id" = $1`, [
      CANARY_USER_ID,
      B_PREFIX_HASH,
    ]);
    const before = await storedHash();

    const verified = await verifyPassword({ password: WRONG_PASSWORD, hash: B_PREFIX_HASH });
    expect(verified).toBe(false);

    // No upgrade window: assert directly (a false verify never schedules work).
    expect(await storedHash()).toBe(before);
    expect(await storedHash()).toBe(B_PREFIX_HASH);
    expect(await storedUserHash()).toBe(B_PREFIX_HASH);
  });

  it("7. a DIVERGED users copy is never rewritten by a hash it does not hold (07-08 contract)", async () => {
    // Divergence shape recorded by the 07-07 soak finding: the engine wrote
    // account.password (e.g. a post-cutover reset) while the legacy users
    // copy still holds an older hash. The rehash upgrades the copy the
    // received hash came from (account) and never rewrites the diverged
    // sibling — that reconciliation belongs to the profile route's own
    // password write.
    await pg.query(`UPDATE account SET "password" = $2 WHERE "userId" = $1 AND "providerId" = 'credential'`, [
      CANARY_USER_ID,
      A_PREFIX_HASH,
    ]);
    await pg.query(`UPDATE users SET "password" = $2 WHERE "id" = $1`, [
      CANARY_USER_ID,
      B_PREFIX_HASH,
    ]);

    const verified = await verifyPassword({ password: CORRECT_PASSWORD, hash: A_PREFIX_HASH });
    expect(verified).toBe(true);

    const upgraded = await waitFor(async () => {
      const hash = await storedHash();
      return hash && hash !== A_PREFIX_HASH ? hash : null;
    });
    expect(upgraded).not.toBeNull();
    expect(await storedUserHash()).toBe(B_PREFIX_HASH); // untouched
  });
});
