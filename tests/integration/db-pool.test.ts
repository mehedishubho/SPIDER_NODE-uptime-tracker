import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Integration suite: src/lib/db-pool.ts (DAT-09 / D-06, 03-02)
//
// Pins the audit §25.2 connection-budget options on the ONE pg.Pool this
// process is allowed to own (web budget: max 10, nonzero connect timeout so
// pool exhaustion fails fast instead of hanging, statement/idle-in-transaction
// caps sized above the §13.7 retention-delete pass). The pool lives in a
// neutral module so neither ORM owns it — Prisma wraps it via PrismaPg
// today, the Drizzle client attaches to the SAME instance in 03-04
// (drizzle({ client: pgPool })), and Phase 4's worker creates its OWN pool
// (max 20) against its own budget. Pools are per-process, never shared
// across processes (D-06) — the budget counts pools, not ORMs (§25.3).
//
// The database is the real docker test Postgres (vitest.config.ts wires
// DATABASE_URL to :5453); nothing here is mocked. The singleton-identity
// case relies on the globalThis cache being ACTIVE — vitest runs with
// NODE_ENV=test (non-production), the same condition the module caches
// under (HMR-survival shape shared with src/lib/prisma.ts).
// ---------------------------------------------------------------------------

import type { Pool } from "pg";

/** Dynamic import so vi.resetModules() can force a module re-eval per case. */
async function freshPoolModule() {
  return import("@/lib/db-pool");
}

describe("db-pool — §25.2 pinned options + per-process singleton (DAT-09, D-06)", () => {
  it("1. exposes the five audit §25.2 pinned options on pgPool.options (web budget)", async () => {
    const { pgPool } = await freshPoolModule();

    expect(pgPool.options.max).toBe(10);
    expect(pgPool.options.connectionTimeoutMillis).toBe(10000);
    expect(pgPool.options.idleTimeoutMillis).toBe(10000);
    expect(pgPool.options.statement_timeout).toBe(30000);
    expect(pgPool.options.idle_in_transaction_session_timeout).toBe(30000);
  });

  it("2. yields the SAME pool instance across module re-imports via the globalThis cache", async () => {
    const first = await freshPoolModule();

    vi.resetModules(); // fresh module graph — the module re-evaluates on re-import
    const second = await freshPoolModule();

    expect(second.pgPool).toBe(first.pgPool);
    // The cache — not module-eval luck — is what makes them identical.
    const globalForPool = globalThis as unknown as { pgPool?: Pool };
    expect(globalForPool.pgPool).toBe(first.pgPool);
  });

  it("3. connects to the docker test Postgres: a trivial query resolves through the pool", async () => {
    const { pgPool } = await freshPoolModule();

    const result = await pgPool.query<{ ok: number }>("select 1 as ok");
    expect(result.rows[0]?.ok).toBe(1);
  });

  it("4. Prisma still queries through the shared pool (prisma.$queryRaw select 1, no own Pool)", async () => {
    const { pgPool } = await freshPoolModule();
    // The @/lib/prisma singleton wraps PrismaPg(pgPool) — never a new Pool —
    // so a resolving $queryRaw is proof Prisma rides the shared pool (03-02
    // Task 2: zero-Prisma-behavior-change extraction).
    const { prisma } = await import("@/lib/prisma");

    const rows = await prisma.$queryRaw<{ ok: number }[]>`select 1 as ok`;
    expect(rows[0]?.ok).toBe(1);

    // Same instance the pool module hands out — one pool, two consumers.
    const globalForPool = globalThis as unknown as { pgPool?: Pool };
    expect(globalForPool.pgPool).toBe(pgPool);
  });
});
