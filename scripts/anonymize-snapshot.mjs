#!/usr/bin/env node
// anonymize-snapshot.mjs — deterministic snapshot anonymization (03-05, D-10).
//
// Purpose: mask every PII/secret column in a RESTORED, PRE-MIGRATION snapshot
// so the migration rehearsal (scripts/rehearse-migrations.mjs) never touches
// real personal data, while keeping the snapshot structurally and
// referentially identical to production (DRZ-06).
//
// Contract: node scripts/anonymize-snapshot.mjs with DATABASE_URL pointing at
// the restored snapshot database (the rehearsal pipeline invokes it as a child
// process at the right moment — see rehearse-migrations.mjs step 3).
//
// Column inventory (enumerated from src/db/schema.ts — the transcription
// source; live column names, camelCase quoted where the DDL spells them so):
//   users                  email, name, "telegramChatId"   (PII)
//   accounts               "providerAccountId"             (OAuth subject id)
//                          refresh_token, access_token, id_token  (secrets)
//   sessions               "sessionToken"                  (secret)
//   verification_tokens    email, token                    (PII + secret)
//   password_reset_tokens  email, token                    (PII + secret)
// Not masked, deliberately:
//   - users.password — bcrypt hashes stay REAL: Phase 7's canary-login
//     rehearsal must authenticate against production hashes (D-10). No
//     statement in this file modifies that column — except the D-37 canary
//     designation below, which REPLACES exactly one row's hash with a
//     rehearse-time one.
//
// D-37 CANARY DESIGNATION (07-06): with CANARY_EMAIL + CANARY_PASSWORD both
// set, exactly ONE designated account keeps its real email and receives a
// rehearse-time bcrypt hash (rounds 10 — the same primitive the app's A-1
// gate emits) INSIDE the same masking transaction. Every other row stays
// fully anonymized. The canary reconciles the anonymizer with the D-09
// zero-match abort: on the snapshot, ADMIN_EMAILS = the canary email, and
// the admin-gate + canary-login legs have their subject. The canary email
// MUST exist in the restored snapshot (exactly one match, case-insensitive)
// or the script fails loud BEFORE any masking — a typo'd canary can never
// silently produce a fully-anonymized (admin-less) snapshot. The password is
// read from the environment, never echoed, never logged, never written to
// any file this script touches; the evidence records the row id, the bcrypt
// parameters, and the post-write verification result only.
//   - primary keys / foreign keys (id, userId, monitorId, ...) — masking ids
//     would break FK integrity; they are anonymous opaque strings already
//     and are the md5 KEY MATERIAL, never the target.
//   - monitors/pings/incidents/feedbacks business data — not PII/secret per
//     the 03-05 plan's anonymization contract; the checksum comparison must
//     see them untouched.
//
// Determinism (D-10): every masked value derives from md5() of the row's own
// stable primary key — same input row always produces the same output value,
// on every run and every machine. No randomness, no clocks. Re-running the
// script is idempotent (the same md5 is rewritten).
//
// Row-count preservation: UPDATE-only. No INSERT/DELETE/WHERE-clause tricks —
// row counts per table are preserved by construction, which is what the
// rehearsal's BEFORE/AFTER count comparison relies on.
//
// NULL preservation: nullable columns keep NULL rows NULL (CASE WHEN guards),
// so the data SHAPE (non-null density) matches production too.
//
// Runtime contract: plain Node ESM + pg only (zero new deps, dev-machine
// tool). One-shot pg Client, no Pool. Fail-loud catches restate the cause;
// the connection string is never echoed (secrets stay out of logs).

import { Client } from "pg";
import bcrypt from "bcryptjs";

// D-37 canary knobs. Both envs or neither — a password-less canary email
// would designate an account nobody can log into; an email-less password is
// a leaking no-op.
const CANARY_EMAIL = process.env.CANARY_EMAIL;
const CANARY_PASSWORD = process.env.CANARY_PASSWORD;
const BCRYPT_ROUNDS = 10; // parity with the app's A-1 hash primitive (auth-password.ts)

function fail(context, error) {
  throw new Error(
    `anonymize-snapshot failed: ${context}. ` +
      `Cause: ${error instanceof Error ? error.message : String(error)}. ` +
      `Check that DATABASE_URL points at the RESTORED, PRE-MIGRATION snapshot ` +
      `(the rehearsal container), not at production or the vitest stack.`
  );
}

// One UPDATE per table; every masked value is a pure function of md5(id).
// Determinism is visible in the SQL itself (research "Anonymization sketch",
// D-10): substr(md5(<key>::text), 1, N) — same key, same output, every run.
const MASKING_STATEMENTS = [
  {
    table: "users",
    sql: `UPDATE users SET
      email = 'user_' || substr(md5(id::text), 1, 12) || '@anon.test',
      name = CASE WHEN name IS NULL THEN NULL
                  ELSE 'anon-' || substr(md5(id::text), 1, 8) END,
      "telegramChatId" = CASE WHEN "telegramChatId" IS NULL THEN NULL
                              ELSE 'tg-' || substr(md5(id::text), 1, 16) END`,
  },
  {
    table: "accounts",
    sql: `UPDATE accounts SET
      "providerAccountId" = 'acct-' || substr(md5(id::text), 1, 16),
      refresh_token = CASE WHEN refresh_token IS NULL THEN NULL
                           ELSE 'rt-' || substr(md5(id::text), 1, 24) END,
      access_token = CASE WHEN access_token IS NULL THEN NULL
                          ELSE 'at-' || substr(md5(id::text), 1, 24) END,
      id_token = CASE WHEN id_token IS NULL THEN NULL
                      ELSE 'idt-' || substr(md5(id::text), 1, 24) END`,
  },
  {
    table: "sessions",
    sql: `UPDATE sessions SET
      "sessionToken" = 'sess-' || substr(md5(id::text), 1, 24)`,
  },
  {
    table: "verification_tokens",
    sql: `UPDATE verification_tokens SET
      email = 'vt_' || substr(md5(id::text), 1, 12) || '@anon.test',
      token = 'vtok-' || substr(md5(id::text), 1, 24)`,
  },
  {
    table: "password_reset_tokens",
    sql: `UPDATE password_reset_tokens SET
      email = 'prt_' || substr(md5(id::text), 1, 12) || '@anon.test',
      token = 'prtok-' || substr(md5(id::text), 1, 24)`,
  },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail("DATABASE_URL is not set", new Error("missing env"));
  }
  if ((CANARY_EMAIL && !CANARY_PASSWORD) || (!CANARY_EMAIL && CANARY_PASSWORD)) {
    fail(
      "canary designation misconfigured",
      new Error("CANARY_EMAIL and CANARY_PASSWORD must be set TOGETHER (D-37) — one is missing")
    );
  }

  const client = new Client({ connectionString }); // one-shot, no Pool
  try {
    await client.connect();

    // D-37: resolve the canary BEFORE any masking (masking rewrites every
    // email, so the real email is only findable pre-mask). Exactly one
    // match, case-insensitive; absence or ambiguity fails loud BEFORE any
    // masking and OUTSIDE the transaction wrapper (a designation-config
    // error is not a "database error while masking").
    let canary = null;
    if (CANARY_EMAIL) {
      const found = await client.query(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        [CANARY_EMAIL]
      );
      if (found.rowCount !== 1) {
        fail(
          "canary designation failed",
          new Error(
            `CANARY_EMAIL matched ${found.rowCount} user(s) in the restored snapshot — ` +
              `exactly 1 required (D-37). Designation aborted before any masking.`
          )
        );
      }
      canary = { id: found.rows[0].id };
    }

    // All-or-nothing: a half-masked snapshot must never be treated as done.
    // The canary designation rides the SAME transaction (a half-canaried
    // snapshot — real email, no rehearse-time hash, or vice versa — must
    // never be treated as done either).
    await client.query("BEGIN");

    for (const { table, sql } of MASKING_STATEMENTS) {
      const result = await client.query(sql);
      console.log(`masked ${table}: ${result.rowCount} row(s) affected`);
    }

    if (canary) {
      const hash = await bcrypt.hash(CANARY_PASSWORD, BCRYPT_ROUNDS);
      await client.query(`UPDATE users SET email = $1, password = $2 WHERE id = $3`, [
        CANARY_EMAIL,
        hash,
        canary.id,
      ]);
      // Post-write verification INSIDE the transaction: the kept email and
      // the rehearse-time hash must round-trip through bcrypt.compare before
      // this snapshot may count as designated.
      const after = await client.query(`SELECT email, password FROM users WHERE id = $1`, [
        canary.id,
      ]);
      const emailOk = after.rows[0].email === CANARY_EMAIL;
      const hashOk = await bcrypt.compare(CANARY_PASSWORD, after.rows[0].password);
      if (!emailOk || !hashOk) {
        fail(
          "canary post-write verification failed",
          new Error(
            `email kept: ${emailOk}; rehearse-time hash verifies: ${hashOk} — transaction rolled back`
          )
        );
      }
      console.log(
        `canary designated (D-37): row id ${canary.id}; real email kept; ` +
          `rehearse-time bcrypt hash (rounds ${BCRYPT_ROUNDS}) written; ` +
          `post-write hash verification: OK; every other row anonymized`
      );
    }

    await client.query("COMMIT");
    console.log(
      "anonymization complete — deterministic md5-derived values; " +
        "row counts and bcrypt password hashes preserved (D-10)" +
        (canary ? "; exactly one D-37 canary designated" : "")
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    fail("database error while masking", error);
  } finally {
    await client.end().catch(() => {});
  }
}

await main();
