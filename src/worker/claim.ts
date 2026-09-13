import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { workerDb } from "./db";
import type { ClaimedMonitor } from "./queues";
import type * as schema from "@/db/schema";

// ---------------------------------------------------------------------------
// The claim transaction (WRK-03, audit §14.3) with the D-50 catch-up-safe
// advance. One round trip: the CTE selects due active monitors with
// FOR UPDATE SKIP LOCKED (the locking clause MUST sit on the CTE's SELECT —
// outer-level locking clauses do not reach into WITH queries, Pitfall 4),
// the UPDATE advances next_check_at, and RETURNING carries (id, status,
// next_check_at) — the shape the J-6 lane assignment and the
// check:{monitorId}:{epoch} jobId derive from (01-02), never a second read.
//
// D-50 (amended into §14 2026-09-13): the advance is GREATEST(now() +
// interval, next_check_at + interval). The naive one-interval advance starves
// stale monitors — a monitor 40 minutes behind at interval 5 would need 8
// ticks to catch up, and dark launch makes staleness the norm for every user
// monitor. GREATEST jumps a far-behind monitor to now+interval in ONE claim
// while on-time monitors keep their exact slot (monotonicity preserved).
// Interval is minutes per §14; the column reference is qualified (m.interval)
// so the type keyword in `interval '1 minute'` never collides.
// ---------------------------------------------------------------------------

/** §14.5: claim batch LIMIT 500 rows per tick (bounds the enqueue burst). */
export const CLAIM_BATCH_LIMIT_DEFAULT = 500;

type WorkerDb = NodePgDatabase<typeof schema>;

/**
 * Builds the §14.3 claim statement for a batch size. Exported so the source
 * assertion compiles it and proves the locking clause sits INSIDE the CTE
 * (Pitfall 4) — the executor passes the compiled form, never string-built SQL.
 */
export function claimDueSql(batchSize: number): SQL {
  return sql`
WITH due AS (
  SELECT id
  FROM monitors
  WHERE "isActive" AND (next_check_at IS NULL OR next_check_at <= now())
  ORDER BY next_check_at NULLS FIRST
  LIMIT ${batchSize}
  FOR UPDATE SKIP LOCKED
)
UPDATE monitors m
   SET next_check_at = GREATEST(
        now() + (m.interval * interval '1 minute'),
        m.next_check_at + (m.interval * interval '1 minute')
       )
  FROM due
 WHERE m.id = due.id
RETURNING m.id, m.status, m.next_check_at
`;
}

/**
 * Claims up to `batchSize` due monitors atomically. Two concurrent executions
 * never return the same monitor: the first claimant's row locks are taken
 * inside the CTE, the second's SKIP LOCKED skips them, and after commit the
 * advanced next_check_at excludes the rows from the WHERE clause anyway
 * (defense in depth, §14.3 notes). Inactive monitors are never selected.
 */
export async function claimDue(
  batchSize: number = CLAIM_BATCH_LIMIT_DEFAULT,
  db: WorkerDb = workerDb
): Promise<ClaimedMonitor[]> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`claimDue: batchSize must be a positive integer (got ${batchSize})`);
  }
  const result = await db.execute(claimDueSql(batchSize));
  const rows = result.rows as Array<{ id: number; status: string; next_check_at: string | Date }>;
  return rows.map((row) => ({
    id: Number(row.id),
    status: row.status,
    nextCheckAt: new Date(row.next_check_at),
  }));
}
