import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// ---------------------------------------------------------------------------
// The A-1 hash gate (audit §12.2) — AUTH-01/AUTH-09, 07-01 Task 5 tracer.
//
// Better Auth's default hash is scrypt; every stored SpiderNode hash is
// bcrypt. Wiring these hooks into emailAndPassword.password.{hash,verify}
// keeps EVERY legacy hash verifiable through the engine swap (the lockout
// risk is killed here, not argued):
//
//   - hash(): emits bcrypt at 10 rounds — byte-compatible with today's
//     register-route primitive (rounds parity; the "modern default" stays
//     bcrypt until a future migration changes it — the prefix router below
//     is what makes that future change non-breaking).
//   - verify(): routes on the stored hash's prefix. $2a$/$2b$/$2y$ are the
//     three bcrypt variants in the wild; anything else FAILS CLOSED (no
//     fallback acceptance — an unknown prefix must never admit a login).
//
//   - Lazy rehash (AUTH-09): a successful legacy-prefix verify upgrades that
//     account's stored password to a fresh 10-round hash. The verify()
//     closure has no account identity, so the LEGACY HASH ITSELF is the
//     practical key (bcrypt output is salted, hence unique per user in
//     practice — Assumption A1). Fire-and-forget: the rehash is opportunistic
//     and must never delay or fail a successful sign-in; a missed upgrade is
//     benign (the legacy hash still verifies), so failures are logged, never
//     rethrown. No bulk rehash job — that is a lockout amplifier (audit).
//
// Consumers: src/lib/auth.ts (Better Auth emailAndPassword.password hooks).
// ---------------------------------------------------------------------------

/** The bcrypt variants that can exist in the stored users.password corpus. */
export const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"] as const;

/** 10-round bcrypt — parity with the register route's exact primitive. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

/**
 * A-1 verify: legacy bcrypt -> bcrypt.compare (+ lazy rehash on success);
 * any other prefix refuses without throwing (fail closed).
 */
export async function verifyPassword({
  password,
  hash,
}: {
  password: string;
  hash: string;
}): Promise<boolean> {
  const isLegacyBcrypt = BCRYPT_PREFIXES.some((prefix) => hash.startsWith(prefix));
  if (!isLegacyBcrypt) {
    // Unknown prefix (future scrypt rows, corrupted value, foreign scheme):
    // refuse. Never fall back to any other comparison.
    return false;
  }
  const ok = await bcrypt.compare(password, hash);
  if (ok) {
    // AUTH-09 lazy rehash — fire-and-forget (see banner: benign failure).
    void upgradeHash(hash, password);
  }
  return ok;
}

/** Rehashes the password and swaps both stored copies of the legacy hash. */
async function upgradeHash(legacyHash: string, password: string): Promise<void> {
  try {
    const modern = await hashPassword(password);
    // The salted legacy hash is the practical per-account key (A1): the
    // equality predicate can never cross accounts' rows in practice, and a
    // concurrent duplicate sign-in re-updates the same row idempotently.
    //
    // 07-08 rehash fix (07-07 §15.3 / WINDOWS.md #2): the credential hash
    // lives in TWO stored copies — "account".password (the credential row the
    // engine reads at sign-in: sign-in resolves credentialAccount.password
    // from the account table) and the legacy "users".password column (the
    // pre-cutover corpus; still read by the profile route's hasPassword /
    // current-password check). The rehash upgrades BOTH copies keyed on the
    // received hash, so the recorded 0-row-match hazard — a rehash UPDATE
    // missing the copy its hash actually came from once the copies diverge —
    // is structurally gone: whichever copy the verify hash represented gets
    // upgraded, and the still-identical sibling copy follows. A copy that
    // already diverged (e.g. post-cutover reset wrote account only) is never
    // rewritten by a hash it does not hold; that path stays reconciled by the
    // profile route's own password write.
    await db.execute(
      sql`UPDATE "account" SET "password" = ${modern} WHERE "password" = ${legacyHash}`
    );
    await db.execute(
      sql`UPDATE "users" SET "password" = ${modern} WHERE "password" = ${legacyHash}`
    );
  } catch (err) {
    console.error(
      "[auth-password] lazy rehash failed (sign-in unaffected):",
      err instanceof Error ? err.message : String(err)
    );
  }
}
