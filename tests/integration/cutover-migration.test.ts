import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Cutover-migration suite (AUTH-03, 07-01 Task 4) against the REAL docker
// test stack — Postgres :5453 via vitest's env wiring, never mocked
// (tests/worker/health.test.ts harness discipline; fileParallelism: false).
//
// What is proven (the migration is ALREADY APPLIED on this database by the
// [BLOCKING] apply / global-setup — these cases re-run 0002's backfill
// statements VERBATIM over freshly seeded legacy rows, which is safe because
// every INSERT carries ON CONFLICT DO NOTHING, and scope every assertion to
// the seeded id set so pre-existing rows can never flake a count):
//   1. credential rows: one account row (providerId 'credential') per user
//      with a password, accountId = user id, password copied verbatim
//   2. OAuth reshape: per-provider account counts equal legacy accounts counts
//      — CONDITIONAL on the legacy substrate: cases 2-3 seed and read the
//      legacy `accounts` table, which the 07-09 drop release (migration 0003,
//      D-27/D-32) physically removed from every migrated database. The
//      cases self-skip (journal-derived) once 0003 is part of the committed
//      set; their proof role is fulfilled and recorded (07-06 D-40 snapshot
//      leg, record §10; production reshape, record §13.3/§16.6). The skip is
//      the drop working as designed, not a lost proof.
//   3. D-40 snapshot leg: per-provider NON-NULL refresh/access token counts
//      preserved exactly — same legacy-substrate condition as case 2
//   4. D-23 boolean backfill: email_verified === (emailVerified IS NOT NULL)
//      for every seeded row — both sides of the mapping
//   5. D-09 seed-script abort semantics: missing/empty/zero-match
//      ADMIN_EMAILS exits non-zero without granting; a one-match roster
//      grants role='admin' (case-insensitive per the D-12 parse contract)
//   6. additive-only source assertion: the comment-stripped 0002 SQL contains
//      no DROP and no RENAME anywhere (prohibition P1 / D-30) — 0003 is the
//      one sanctioned drop release (AUTH-07/D-32) and asserts its own list
// ---------------------------------------------------------------------------

const MIGRATION_PATH = path.resolve(process.cwd(), "drizzle", "0002_better_auth_cutover.sql");
const SEED_SCRIPT = path.resolve(process.cwd(), "scripts", "seed-admin-roles.mjs");

// The committed migration set defines the schema the test DB was built with
// (global-setup's single runner). When the journal carries the 0003 drop
// release, the legacy `accounts` table no longer exists on ANY migrated
// database — the legacy-substrate cases cannot seed or read it.
const LEGACY_SUBSTRATE_DROPPED = (
  JSON.parse(readFileSync(path.resolve(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  }
).entries.some((e) => e.tag === "0003_drop_legacy_auth_tables");

// Legacy-substrate cases (2-3) are SKIPPED, not deleted, when 0003 is in the
// committed set: `it.skip` keeps the proofs listed and visibly skipped rather
// than silently vanished. The substrate they seed/read (the legacy `accounts`
// table) is physically gone from every migrated database BY DESIGN (07-09
// drop release, D-27/D-32); their historical proof lives in the deploy
// record (07-06 D-40 snapshot leg §10; production reshape §13.3/§16.6).
const itWithLegacySubstrate = LEGACY_SUBSTRATE_DROPPED ? it.skip : it;

const RUN = randomUUID();
const U_PWD_VERIFIED = `mig-user-a-${RUN}`;
const U_PWD_UNVERIFIED = `mig-user-b-${RUN}`;
const U_OAUTH_VERIFIED = `mig-user-c-${RUN}`;
const U_OAUTH_UNVERIFIED = `mig-user-d-${RUN}`;
// Mixed-case on purpose: proves the seed script's lowercase matching (D-12).
const ADMIN_EMAIL = `Admin@${RUN}.example.test`;
const ALL_USER_IDS = [U_PWD_VERIFIED, U_PWD_UNVERIFIED, U_OAUTH_VERIFIED, U_OAUTH_UNVERIFIED];

// A stored legacy bcrypt hash (shape only — never verified here; the
// auth suites own the verify path). $2a$ prefix = the dominant legacy form.
const LEGACY_HASH = `$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy`;

let pg: Client;

/** Verbatim copies of drizzle/0002_better_auth_cutover.sql's backfill statements. */
const CREDENTIAL_BACKFILL_SQL = `
INSERT INTO "account" ("id", "userId", "providerId", "accountId", "password", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."id", 'credential', u."id", u."password", now(), now()
FROM "users" u
WHERE u."password" IS NOT NULL
ON CONFLICT DO NOTHING;`;
const OAUTH_BACKFILL_SQL = `
INSERT INTO "account" ("id", "userId", "providerId", "accountId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "scope", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."userId", a."provider", a."providerAccountId", a."access_token", a."refresh_token", a."id_token", to_timestamp(a."expires_at"), a."scope", now(), now()
FROM "accounts" a
ON CONFLICT DO NOTHING;`;
const BOOLEAN_BACKFILL_SQL = `UPDATE "users" SET "email_verified" = ("emailVerified" IS NOT NULL);`;

async function seedUser(id: string, opts: { password: string | null; emailVerified: string | null; email: string }): Promise<void> {
  await pg.query(
    `INSERT INTO users (id, name, email, "emailVerified", password, timezone, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'UTC', now(), now())`,
    [id, `Migration Test ${id.slice(0, 12)}`, opts.email, opts.emailVerified, opts.password]
  );
}

async function seedLegacyAccount(
  id: string,
  userId: string,
  provider: string,
  tokens: { refreshToken: string | null; accessToken: string | null }
): Promise<void> {
  await pg.query(
    `INSERT INTO accounts (id, "userId", type, provider, "providerAccountId", refresh_token, access_token, expires_at, token_type, scope, id_token, session_state)
     VALUES ($1, $2, 'oauth', $3, $4, $5, $6, 1790103811, 'bearer', 'read write', NULL, NULL)`,
    [id, userId, provider, `acct-${id}`, tokens.refreshToken, tokens.accessToken]
  );
}

/** Scoped count helper — every assertion keys on the seeded id set. */
async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pg.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

function runSeedScript(adminEmails: string | undefined): { status: number; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: process.env.DATABASE_URL };
  if (adminEmails === undefined) {
    delete env.ADMIN_EMAILS;
  } else {
    env.ADMIN_EMAILS = adminEmails;
  }
  try {
    const out = execFileSync(process.execPath, [SEED_SCRIPT], { env, stdio: "pipe", encoding: "utf8" });
    return { status: 0, output: out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  await seedUser(U_PWD_VERIFIED, { password: LEGACY_HASH, emailVerified: "2026-01-15 10:00:00.000", email: `verified-pwd-${RUN}@example.test` });
  await seedUser(U_PWD_UNVERIFIED, { password: LEGACY_HASH, emailVerified: null, email: `unverified-pwd-${RUN}@example.test` });
  await seedUser(U_OAUTH_VERIFIED, { password: null, emailVerified: "2026-02-20 08:30:00.000", email: ADMIN_EMAIL.toLowerCase() });
  await seedUser(U_OAUTH_UNVERIFIED, { password: null, emailVerified: null, email: `unverified-oauth-${RUN}@example.test` });

  // google: refresh AND access non-null. github: access non-null, refresh NULL
  // — proves the D-40 token-count preservation distinguishes null from value.
  // Legacy-substrate seeding is conditional on the substrate existing (the
  // 07-09 0003 drop release removes it from every migrated database —
  // cases 2-3 skip with it; see the header note).
  if (!LEGACY_SUBSTRATE_DROPPED) {
    await seedLegacyAccount(`acc-g-${RUN}`, U_OAUTH_VERIFIED, "google", { refreshToken: `rt-google-${RUN}`, accessToken: `at-google-${RUN}` });
    await seedLegacyAccount(`acc-h-${RUN}`, U_OAUTH_VERIFIED, "github", { refreshToken: null, accessToken: `at-github-${RUN}` });

    // Re-run 0002's backfills verbatim over the seeded legacy rows (idempotent).
    await pg.query(OAUTH_BACKFILL_SQL);
  }
  await pg.query(CREDENTIAL_BACKFILL_SQL);
  await pg.query(BOOLEAN_BACKFILL_SQL);
});

afterAll(async () => {
  // FKs are ON DELETE CASCADE — removing the users removes the seeded account
  // rows (Better Auth + legacy). Scoped to this run's ids only.
  await pg.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ALL_USER_IDS]).catch(() => {});
  await pg.end().catch(() => {});
});

describe("cutover migration 0002 — backfill semantics on real PG (AUTH-03)", () => {
  it("1. creates one credential account row per user with a password, accountId = user id, password copied verbatim", async () => {
    const withPassword = await scalar(
      `SELECT count(*) FROM users WHERE "password" IS NOT NULL AND id = ANY($1::text[])`,
      [ALL_USER_IDS]
    );
    const credentialRows = await scalar(
      `SELECT count(*) FROM account WHERE "providerId" = 'credential' AND "userId" = ANY($1::text[])`,
      [ALL_USER_IDS]
    );
    expect(credentialRows).toBe(withPassword);
    expect(withPassword).toBe(2); // exactly the two password-bearing seeds

    const mismatches = await scalar(
      `SELECT count(*) FROM account a JOIN users u ON u.id = a."userId"
       WHERE a."providerId" = 'credential' AND a."accountId" <> a."userId"
         AND a."password" IS DISTINCT FROM u."password" AND a."userId" = ANY($1::text[])`,
      [ALL_USER_IDS]
    );
    expect(mismatches).toBe(0);
  });

  itWithLegacySubstrate("2. reshapes OAuth rows so per-provider account counts equal legacy accounts counts", async () => {
    for (const provider of ["google", "github"]) {
      const legacy = await scalar(
        `SELECT count(*) FROM accounts WHERE provider = $1 AND "userId" = ANY($2::text[])`,
        [provider, ALL_USER_IDS]
      );
      const reshaped = await scalar(
        `SELECT count(*) FROM account WHERE "providerId" = $1 AND "userId" = ANY($2::text[])`,
        [provider, ALL_USER_IDS]
      );
      expect(reshaped).toBe(legacy);
    }
    // providerId carries the legacy provider VALUE (lowercase google/github).
    const badProviderIds = await scalar(
      `SELECT count(*) FROM account WHERE "providerId" = ANY($1::text[]) AND "providerId" NOT IN ('google','github','credential')`,
      [ALL_USER_IDS]
    );
    expect(badProviderIds).toBe(0);
  });

  itWithLegacySubstrate("3. preserves per-provider NON-NULL refresh/access token counts exactly (D-40 snapshot leg)", async () => {
    for (const provider of ["google", "github"]) {
      const legacyRefresh = await scalar(
        `SELECT count(*) FROM accounts WHERE provider = $1 AND refresh_token IS NOT NULL AND "userId" = ANY($2::text[])`,
        [provider, ALL_USER_IDS]
      );
      const reshapedRefresh = await scalar(
        `SELECT count(*) FROM account WHERE "providerId" = $1 AND "refreshToken" IS NOT NULL AND "userId" = ANY($2::text[])`,
        [provider, ALL_USER_IDS]
      );
      expect(reshapedRefresh).toBe(legacyRefresh);

      const legacyAccess = await scalar(
        `SELECT count(*) FROM accounts WHERE provider = $1 AND access_token IS NOT NULL AND "userId" = ANY($2::text[])`,
        [provider, ALL_USER_IDS]
      );
      const reshapedAccess = await scalar(
        `SELECT count(*) FROM account WHERE "providerId" = $1 AND "accessToken" IS NOT NULL AND "userId" = ANY($2::text[])`,
        [provider, ALL_USER_IDS]
      );
      expect(reshapedAccess).toBe(legacyAccess);
    }
    // The seeded nulls stayed null: the github row had refresh_token NULL.
    const githubNullRefresh = await scalar(
      `SELECT count(*) FROM account WHERE "providerId" = 'github' AND "refreshToken" IS NULL AND "userId" = ANY($1::text[])`,
      [ALL_USER_IDS]
    );
    expect(githubNullRefresh).toBe(1);
  });

  it("4. backfills email_verified to the EXACT truthiness of the legacy timestamp, both sides (D-23)", async () => {
    const res = await pg.query(
      `SELECT id, "emailVerified" AS ts, "email_verified" AS flag FROM users WHERE id = ANY($1::text[])`,
      [ALL_USER_IDS]
    );
    expect(res.rows).toHaveLength(4);
    for (const row of res.rows) {
      expect(row.flag).toBe(row.ts !== null); // both directions of the mapping
    }
    // Explicit anchors: timestamp set -> true (pwd + oauth), null -> false.
    const trueCount = res.rows.filter((r: { flag: boolean }) => r.flag === true).length;
    expect(trueCount).toBe(2);
  });
});

describe("seed-admin-roles.mjs — D-08/D-09 abort semantics", () => {
  it("5. exits non-zero when ADMIN_EMAILS is missing entirely", () => {
    const run = runSeedScript(undefined);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("ADMIN_EMAILS");
  });

  it("6. exits non-zero when ADMIN_EMAILS is empty after parsing", () => {
    for (const empty of ["", "   ", ",,"]) {
      const run = runSeedScript(empty);
      expect(run.status).not.toBe(0);
      // D-09: the abort names the variable and never reports a grant (the
      // "" form trips requireEnv's missing-env guard, the others the empty-
      // after-parsing guard — both are the D-09 abort).
      expect(run.output).toContain("ADMIN_EMAILS");
      expect(run.output).not.toContain("PASS");
    }
  });

  it("7. exits non-zero WITHOUT granting when the roster matches zero users", () => {
    const run = runSeedScript(`nobody-${RUN}@example.test`);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("matched zero users");
    const granted = run.output.match(/PASS/);
    expect(granted).toBeNull(); // the abort path must not report a grant
  });

  it("8. grants role='admin' on a one-match roster (case-insensitive, D-10 form)", async () => {
    const run = runSeedScript(ADMIN_EMAIL.toUpperCase()); // stored lowercase — parse contract lowercases it back
    expect(run.status).toBe(0);
    expect(run.output).toContain("PASS");

    const role = await pg.query(`SELECT "role" FROM users WHERE email = $1`, [ADMIN_EMAIL.toLowerCase()]);
    expect(role.rows[0].role).toBe("admin");

    // Non-roster users are untouched.
    const others = await pg.query(
      `SELECT count(*) AS n FROM users WHERE id = ANY($1::text[]) AND "role" = 'admin'`,
      [ALL_USER_IDS.filter((id) => id !== U_OAUTH_VERIFIED)]
    );
    expect(Number(others.rows[0].n)).toBe(0);
  });
});

describe("migration source — additive-only contract (prohibition P1 / D-30)", () => {
  it("9. the comment-stripped 0002 SQL contains no DROP and no RENAME anywhere", () => {
    const raw = readFileSync(MIGRATION_PATH, "utf8");
    const sqlOnly = raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--")) // header/prose comments may NAME the rule
      .join("\n");
    expect(sqlOnly).not.toMatch(/\bDROP\b/i);
    expect(sqlOnly).not.toMatch(/\bRENAME\b/i);
  });
});
