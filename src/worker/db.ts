import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";

// ---------------------------------------------------------------------------
// The worker's OWN pg pool + drizzle client (DAT-09 / audit §25).
//
// Pools are PER-PROCESS and never shared (D-06): the web process owns its
// max-10 pool (src/lib/db-pool.ts); this is the worker's dedicated pool
// with max raised to 20 (§25.1 worker budget). All other options copy the
// §25.2 pin block — connectionTimeoutMillis nonzero (pool exhaustion fails
// fast instead of hanging forever), statement_timeout and
// idle_in_transaction_session_timeout capped at 30 s (web+worker pools
// only; the migration runner deliberately stays unset — CONCURRENTLY and
// backfills legitimately run long).
//
// globalThis cache (same shape as src/lib/db-pool.ts) so vitest's
// resetModules/re-import discipline can dispose and rebuild the singleton
// between cases.
//
// The drizzle client attaches to the SAME pool — never drizzle(url) /
// drizzle({ connection }) here, those would mint a second pool. The §16
// writer transactions (later Phase-4 plans) run through this client.
// ---------------------------------------------------------------------------

const globalForWorkerDb = global as unknown as { workerPgPool?: Pool };

export const workerPgPool =
  globalForWorkerDb.workerPgPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20, // worker budget (§25.1)
    connectionTimeoutMillis: 10000, // default 0 = wait forever — pinned nonzero (§25.2)
    idleTimeoutMillis: 10000, // release idle server connections so the budget tracks load
    statement_timeout: 30000, // web+worker pools only; UNSET on the migration runner (§25.2)
    idle_in_transaction_session_timeout: 30000, // reap sessions stuck idle inside a transaction
  });

if (process.env.NODE_ENV !== "production") globalForWorkerDb.workerPgPool = workerPgPool;

export const workerDb = drizzle({ client: workerPgPool, schema });
