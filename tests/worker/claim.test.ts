import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { claimDue, claimDueSql, CLAIM_BATCH_LIMIT_DEFAULT } from "@/worker/claim";

// ---------------------------------------------------------------------------
// Claim-transaction proof suite (WRK-03 / D-50, audit §14.3) against the REAL
// docker test Postgres (:5453) — the SKIP LOCKED exclusion and the GREATEST
// catch-up advance are Postgres locking/arithmetic semantics, only provable
// on the real engine. Seeds go through raw SQL via TEST_DATABASE_URL only
// (02-02 rule); concurrency is two claimDue() calls racing on separate pool
// clients (the worker's own globalThis-cached pool, max 20).
//
// Pins:
//   1. source form — the locking clause sits INSIDE the CTE (Pitfall 4) and
//      the advance is the D-50 GREATEST form
//   2. an on-time monitor advances by exactly one interval
//   3. a 40-minutes-stale monitor (interval 5) advances to now+interval in
//      ONE claim — not a crawling one-interior advance
//   4. a NULL next_check_at monitor is claimed (NULLS FIRST) and advanced
//   5. an inactive monitor is never claimed, next_check_at untouched
//   6. LIMIT bounds the batch and oldest-due-first ordering holds
//   7. two PARALLEL claims return disjoint sets (SKIP LOCKED exclusion)
// ---------------------------------------------------------------------------

let pg: Client;
let testUserId: string;

interface MonitorRow {
  id: number;
  status: string;
  next_check_at: string | null;
}

async function seedMonitor(opts: {
  status?: string;
  interval?: number;
  isActive?: boolean;
  nextCheckAt: Date | null;
}): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval, next_check_at, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [
      "https://example.com",
      `claim-test-${crypto.randomUUID()}`,
      testUserId,
      opts.status ?? "UP",
      opts.isActive ?? true,
      opts.interval ?? 5,
      opts.nextCheckAt ? opts.nextCheckAt.toISOString() : null,
    ]
  );
  return result.rows[0].id as number;
}

async function fetchMonitor(id: number): Promise<MonitorRow> {
  const result = await pg.query(`SELECT id, status, next_check_at FROM monitors WHERE id = $1`, [id]);
  return result.rows[0] as MonitorRow;
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("TRUNCATE monitors CASCADE");
  await pg.query("TRUNCATE users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`claim-test-${crypto.randomUUID()}@example.test`]
  );
  testUserId = user.rows[0].id as string;
});

afterAll(async () => {
  await pg.end();
});

describe("claim transaction — §14.3 + D-50 catch-up-safe advance (WRK-03)", () => {
  it(
    "1. source form: FOR UPDATE SKIP LOCKED sits INSIDE the CTE; the advance is the GREATEST catch-up form",
    () => {
      const compiled = new PgDialect().sqlToQuery(claimDueSql(CLAIM_BATCH_LIMIT_DEFAULT)).sql;

      // Pitfall 4: the locking clause must live inside the WITH subquery...
      const cteBody = compiled.slice(
        compiled.indexOf("WITH due AS ("),
        compiled.indexOf(") UPDATE") >= 0 ? compiled.indexOf("UPDATE monitors m") : compiled.length
      );
      expect(cteBody).toContain("FOR UPDATE SKIP LOCKED");
      // ...never on the outer UPDATE (an outer clause locks nothing from "due").
      const afterUpdate = compiled.slice(compiled.indexOf("UPDATE monitors m"));
      expect(afterUpdate).not.toContain("FOR UPDATE");

      // D-50: the catch-up-safe advance form.
      expect(compiled).toContain("GREATEST(");
      expect(compiled).toMatch(
        /GREATEST\(\s*now\(\) \+ \(m\.interval \* interval '1 minute'\),\s*m\.next_check_at \+ \(m\.interval \* interval '1 minute'\)/
      );
      // The 01-02 RETURNING shape the lane assignment + jobId derive from.
      expect(compiled).toContain("RETURNING m.id, m.status, m.next_check_at");
      // Only-due-and-active gating.
      expect(compiled).toContain('"isActive"');
    },
    15_000
  );

  it(
    "2. an on-time monitor advances by exactly one interval",
    async () => {
      const dueAt = new Date(Date.now() - 2_000);
      const monitorId = await seedMonitor({ status: "UP", interval: 5, nextCheckAt: dueAt });

      const before = Date.now();
      const claimed = await claimDue(10);
      const after = Date.now();

      const row = claimed.find((r) => r.id === monitorId);
      expect(row).toBeDefined();
      expect(row!.status).toBe("UP");
      expect(row!.nextCheckAt).toBeInstanceOf(Date);

      const stored = new Date((await fetchMonitor(monitorId)).next_check_at!).getTime();
      // GREATEST picks now()+5m for a just-due monitor (nca+5m is ~2s behind):
      // exactly one interval from the claim instant, +/- statement latency.
      expect(stored).toBeGreaterThan(before + 5 * 60_000 - 3_000);
      expect(stored).toBeLessThan(after + 5 * 60_000 + 3_000);
      // Not claimed again: the advanced slot excludes it from the next claim.
      expect((await claimDue(10)).find((r) => r.id === monitorId)).toBeUndefined();
    },
    15_000
  );

  it(
    "3. a monitor 40 minutes behind advances to now+interval in ONE claim (not one interval per tick)",
    async () => {
      const staleAt = new Date(Date.now() - 40 * 60_000); // interval 5 => 8 ticks naive
      const monitorId = await seedMonitor({ status: "DOWN", interval: 5, nextCheckAt: staleAt });

      const before = Date.now();
      const claimed = await claimDue(10);
      const after = Date.now();

      expect(claimed.find((r) => r.id === monitorId)).toBeDefined();
      const stored = new Date((await fetchMonitor(monitorId)).next_check_at!).getTime();
      // The naive advance would leave it at now()-35m (still due, starving);
      // GREATEST jumps it to now()+5m in this single claim.
      expect(stored).toBeGreaterThan(before + 5 * 60_000 - 3_000);
      expect(stored).toBeLessThan(after + 5 * 60_000 + 3_000);
      expect((await claimDue(10)).find((r) => r.id === monitorId)).toBeUndefined();
    },
    15_000
  );

  it(
    "4. a NULL next_check_at monitor is claimed (NULLS FIRST) and advanced to now+interval",
    async () => {
      const monitorId = await seedMonitor({ status: "UNKNOWN", interval: 10, nextCheckAt: null });

      const before = Date.now();
      const claimed = await claimDue(10);
      const after = Date.now();

      expect(claimed.find((r) => r.id === monitorId)).toBeDefined();
      const stored = new Date((await fetchMonitor(monitorId)).next_check_at!).getTime();
      // GREATEST(now()+10m, NULL+10m=NULL) = now()+10m — NULLs never win.
      expect(stored).toBeGreaterThan(before + 10 * 60_000 - 3_000);
      expect(stored).toBeLessThan(after + 10 * 60_000 + 3_000);
    },
    15_000
  );

  it(
    "5. an inactive monitor is NEVER claimed and its next_check_at is untouched",
    async () => {
      const dueAt = new Date(Date.now() - 60_000);
      const monitorId = await seedMonitor({ status: "UP", interval: 5, isActive: false, nextCheckAt: dueAt });

      const claimed = await claimDue(10);
      expect(claimed.find((r) => r.id === monitorId)).toBeUndefined();
      const stored = (await fetchMonitor(monitorId)).next_check_at;
      expect(Math.abs(new Date(stored!).getTime() - dueAt.getTime())).toBeLessThan(3_000);
    },
    15_000
  );

  it(
    "6. LIMIT bounds the batch; oldest-due-first ordering holds (fairness preference, §14.3 notes)",
    async () => {
      const oldest = await seedMonitor({ interval: 5, nextCheckAt: new Date(Date.now() - 60_000) });
      const middle = await seedMonitor({ interval: 5, nextCheckAt: new Date(Date.now() - 30_000) });
      await seedMonitor({ interval: 5, nextCheckAt: new Date(Date.now() - 5_000) });

      const claimed = await claimDue(2);
      expect(claimed).toHaveLength(2);
      const ids = claimed.map((r) => r.id);
      expect(ids).toContain(oldest);
      expect(ids).toContain(middle);
    },
    15_000
  );

  it(
    "7. two PARALLEL claims never return the same monitor (SKIP LOCKED exclusion, T-04-06)",
    async () => {
      // Re-due everything claimed so far plus a fresh surplus.
      for (let i = 0; i < 3; i++) {
        await seedMonitor({ interval: 5, nextCheckAt: new Date(Date.now() - 15_000) });
      }
      await pg.query(
        `UPDATE monitors SET next_check_at = now() - interval '15 seconds' WHERE "isActive"`
      );

      const [first, second] = await Promise.all([claimDue(15), claimDue(15)]);
      expect(first.length + second.length).toBeGreaterThan(0);

      const firstIds = new Set(first.map((r) => r.id));
      const secondIds = new Set(second.map((r) => r.id));
      for (const id of firstIds) {
        expect(secondIds.has(id)).toBe(false); // disjoint — no double-claim
      }
      // Every claimed monitor advanced past now (no due row left behind by
      // the two claims that took it).
      for (const row of [...first, ...second]) {
        expect(row.nextCheckAt.getTime()).toBeGreaterThan(Date.now() - 3_000);
      }
    },
    15_000
  );

  it(
    "8. invalid batchSize refuses to run (fail-closed input validation)",
    async () => {
      await expect(claimDue(0)).rejects.toThrow(/positive integer/i);
      await expect(claimDue(-5)).rejects.toThrow(/positive integer/i);
      await expect(claimDue(1.5)).rejects.toThrow(/positive integer/i);
    },
    15_000
  );
});
