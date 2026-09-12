import { drizzle } from "drizzle-orm/node-postgres";
import { pgPool } from "@/lib/db-pool";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Drizzle client on the ONE shared pg.Pool (D-05 / DRZ-05, audit §25.3).
//
// `drizzle({ client: pgPool, schema })` hands Drizzle the existing pool that
// Prisma already wraps (src/lib/prisma.ts → PrismaPg(pgPool)) — one pool per
// process carries both ORMs through the transition; the budget counts pools,
// not ORMs (DAT-09/D-06). Never `drizzle(url)` / `drizzle({ connection })`
// here: those create a SECOND pool (research Pattern 5).
//
// CONSUMED BY NO ROUTE until Phase 7 (D-05). This module exists so tests can
// prove the shared-pool arrangement now; read-path porting begins in Phase 7.
// NO DUAL-WRITE EVER: write paths remain Prisma-only until Prisma is deleted —
// Drizzle is additive-only until then (audit M-1 transition premise).
// ---------------------------------------------------------------------------

export const db = drizzle({ client: pgPool, schema });
