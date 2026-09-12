import { Pool } from "pg";

// ---------------------------------------------------------------------------
// The ONE pg.Pool this web process owns (DAT-09 / D-06, audit §25).
//
// This module is deliberately neutral: neither ORM owns the pool. Prisma
// wraps it via PrismaPg (src/lib/prisma.ts) today; the Drizzle client
// attaches to the SAME instance via drizzle({ client: pgPool }) from Phase 3
// (03-04). The budget counts pools, not ORMs — one pool per process carries
// both through the Prisma->Drizzle transition (§25.3, DRZ-05/M-1).
//
// max: 10 is the web-process connection budget (§25.1). Pools are
// PER-PROCESS and never shared across processes (D-06): Phase 4's worker
// creates its OWN pool against its own budget (max 20, DIRECT connection
// string). A worker-pool factory can be added to this module later — it is
// intentionally NOT built in this plan.
//
// statement_timeout is deliberately UNSET on the migration runner (§25.2):
// CREATE INDEX CONCURRENTLY and backfill DDL legitimately run long, so the
// 30s cap applies to web+worker pools only. The runner (03-03) uses a DIRECT
// one-shot connection, not this pool.
// ---------------------------------------------------------------------------

const globalForPool = global as unknown as { pgPool?: Pool };

// Audit §25.2 pinned options (node-postgres). The dangerous default is
// connectionTimeoutMillis 0 — a client waits FOREVER for a pool slot; pinned
// nonzero so pool exhaustion fails fast instead of hanging requests.
export const pgPool =
  globalForPool.pgPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10, // web budget (§25.1); the Phase 4 worker gets its OWN pool (max 20)
    connectionTimeoutMillis: 10000, // default 0 = wait forever — pinned nonzero (§25.2)
    idleTimeoutMillis: 10000, // release idle server connections so the budget tracks load
    statement_timeout: 30000, // web+worker pools only; UNSET on the migration runner (§25.2)
    idle_in_transaction_session_timeout: 30000, // reap sessions stuck idle inside a transaction
  });

// HMR/module re-eval survival — same caching shape as src/lib/prisma.ts.
if (process.env.NODE_ENV !== "production") globalForPool.pgPool = pgPool;
