import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Shared-pool Drizzle client proof (03-04, D-05 / DRZ-05, audit §25.3).
//
// src/db/index.ts binds drizzle({ client: pgPool, schema }) onto the ONE
// pg.Pool this process owns (src/lib/db-pool.ts). 07-08 (deletion release,
// DRZ-07) deleted the Prisma singleton that used to share this pool — the
// Drizzle client is now the only ORM consumer, and the module contract is
// unchanged: same pool, same schema mappings, no second connection source.
//
// The database is the real docker test Postgres prepared by global-setup's
// drizzle-kit migrate — the same migrated state production reaches at deploy.
// ---------------------------------------------------------------------------

import { db } from "@/db";
import { monitors } from "@/db/schema";
import { pgPool } from "@/lib/db-pool";

describe("db client — one pool, one ORM (03-04, D-05/DRZ-05; 07-08 DRZ-07)", () => {
  it("1. select 1 resolves through the shared pool", async () => {
    const result = await db.execute(sql`select 1`);
    expect(result.rowCount).toBe(1);
  });

  it("2. real table query through the Drizzle client proves the schema mappings line up with the migrated database", async () => {
    // Enumerates every mapped monitors column — any drift between
    // src/db/schema.ts and what the migrations actually built errors here.
    const rows = await db.select().from(monitors).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("3. pool identity: the Drizzle client rides the process's ONE pgPool instance", () => {
    expect(db.$client).toBe(pgPool);
  });
});
