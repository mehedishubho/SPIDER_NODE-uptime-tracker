import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Shared-pool Drizzle client proof (03-04, D-05 / DRZ-05, audit §25.3).
//
// src/db/index.ts binds drizzle({ client: pgPool, schema }) onto the SAME
// pg.Pool Prisma wraps (src/lib/db-pool.ts → src/lib/prisma.ts). These tests
// are the module's only consumers until Phase 7 read-path porting — no route
// imports @/db, and nothing here writes through Drizzle (no dual-write: write
// paths remain Prisma-only until Prisma is deleted, audit M-1).
//
// The database is the real docker test Postgres prepared by global-setup's
// drizzle-kit migrate — the same migrated state production reaches at deploy.
// ---------------------------------------------------------------------------

import { db } from "@/db";
import { monitors } from "@/db/schema";
import { pgPool } from "@/lib/db-pool";
import { prisma } from "@/lib/prisma";

describe("db client — one pool, two ORMs (03-04, D-05/DRZ-05)", () => {
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

  it("3. pool identity: the Drizzle client rides the same pgPool instance Prisma wraps", () => {
    expect(db.$client).toBe(pgPool);
    // The other ORM on the same pool: importing the singleton constructs
    // PrismaPg(pgPool) — one pool, two ORMs, no second connection source.
    expect(prisma).toBeDefined();
  });
});
