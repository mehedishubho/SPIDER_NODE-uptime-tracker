import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import Redis from "ioredis";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  FLUSH_CADENCE_MS,
  disposeStagingRedis,
  flushDueMonitors,
  flushGuardKey,
  flushMonitor,
  flushStageKey,
  formatPgTimestamp,
  guardInsertSql,
  monitorFlushUpdateSql,
  pingsBulkInsertSql,
  stagingKey,
  stageResult,
} from "@/worker/persist/tier2";
import type { StagedPingRow, Tier2Outcome } from "@/worker/persist/tier2";

// ---------------------------------------------------------------------------
// Tier 2 staged-flush proof suite (DAT-02/03/07, audit §16.2) against the
// REAL docker test Postgres (:5453) + Redis (:6390) — RENAMENX atomicity,
// write_guards ON CONFLICT semantics, GREATEST/monotonic CASE behavior, and
// the in-UPDATE uptime derivation are engine semantics, only provable live.
// Seeds go through raw SQL via TEST_DATABASE_URL only (02-02 rule); the
// module under test runs through its own globalThis-cached pool + Redis
// singleton (workerDb / stagingRedis). Per case: write_guards TRUNCATE +
// SCAN/DEL of every stage:/flushstage: key on the admin client (03-01
// discipline — a flushdb would nuke BullMQ keys of concurrently running
// suites on the shared container).
//
// Pins (the plan's six mandated cases + the structural/source-form case 0):
//   1. source form — RENAMENX present / plain rename absent / SCAN sweep /
//      no blocking keyspace call; UPDATE never references status; guard ON
//      CONFLICT DO NOTHING + RETURNING; multi-row id-less ping INSERT;
//      D-36 exact-extraction constants; GREATEST + COALESCE; FLUSH_CADENCE_MS
//   2. staging math — three staged UP results aggregate in the hash exactly
//      as db-batcher's flush math consumes them (deltas derive from rows:
//      totalChecks +3, failedChecks +0, lastChecked = max, additive form)
//   3. flush applies — counters additive, uptimePercent = legacy rendering
//      for the new totals, lastChecked = staged max (and NOT regressed when
//      the row already holds a NEWER value — GREATEST), responseTime per the
//      monotonicity rule, 3 ping rows each with a DB UUID id + evidence
//   4. never-write-status — a sentinel monitors.status survives the flush
//      (and is re-asserted after every flush in this file)
//   5. ownership — two concurrent flushes over one staging key: exactly one
//      applies (counters AND ping count)
//   6. crash-after-COMMIT redelivery (CR-02) — same batchId re-run over a
//      recreated staging key: guard pre-exists, nothing re-applies, and the
//      fresh live staging key is NOT stolen/deleted
//   7. same-batchId concurrent flush — the in-transaction guard path applies
//      exactly once under true parallelism
//   8. misrouted DOWN outcome rejected loudly (never silently staged)
//   9. deleted monitor — FK-safe no-op that still commits the guard + cleans
//      the snapshot (no poison-job retry loop)
//  10. flushDueMonitors sweep — SCAN-based, deterministic batchIds, junk
//      stage:* keys untouched; empty-staging flush is a benign not-owner
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 2026-09-14 10:00:00.000 UTC — fixed wall-clock base for every case. */
const BASE = Date.UTC(2026, 8, 14, 10, 0, 0, 0);
const at = (minutes: number, seconds = 0): number => BASE + minutes * 60_000 + seconds * 1_000;

let pg: Client;
let admin: Redis;
let testUserId: string;

interface MonitorRow {
  status: string;
  "totalChecks": number;
  "failedChecks": number;
  "uptimePercent": number;
  "lastChecked": string | null;
  "responseTime": number | null;
}

interface PingRow {
  id: string;
  status: string;
  "responseTime": number;
  error_class: string | null;
  status_code: number | null;
  created: string;
}

const upOutcome = (responseTimeMs: number, statusCode = 200): Tier2Outcome => ({
  status: "UP",
  responseTimeMs,
  errorClass: null,
  statusCode,
});

async function seedMonitor(opts: {
  status?: string;
  totalChecks?: number;
  failedChecks?: number;
  /** Naive wall-clock seed (formatPgTimestamp output) or null. */
  lastChecked?: string | null;
  responseTime?: number;
}): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval,
       "totalChecks", "failedChecks", "uptimePercent", "lastChecked", "responseTime", "updatedAt")
     VALUES ($1, $2, $3, $4, true, 5, $5, $6, 100, $7::timestamp, $8, now()) RETURNING id`,
    [
      "https://example.com",
      `tier2-test-${crypto.randomUUID().slice(0, 8)}`,
      testUserId,
      opts.status ?? "UP",
      opts.totalChecks ?? 0,
      opts.failedChecks ?? 0,
      opts.lastChecked ?? null,
      opts.responseTime ?? 0,
    ]
  );
  return result.rows[0].id as number;
}

async function fetchMonitor(id: number): Promise<MonitorRow | undefined> {
  const result = await pg.query(
    `SELECT status, "totalChecks", "failedChecks", "uptimePercent",
            to_char("lastChecked", 'YYYY-MM-DD HH24:MI:SS.MS') AS "lastChecked",
            "responseTime"
     FROM monitors WHERE id = $1`,
    [id]
  );
  return result.rows[0] as MonitorRow | undefined;
}

async function fetchPings(monitorId: number): Promise<PingRow[]> {
  const result = await pg.query(
    `SELECT id, status, "responseTime", error_class, status_code,
            to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS created
     FROM pings WHERE "monitorId" = $1 ORDER BY "createdAt" ASC, id ASC`,
    [monitorId]
  );
  return result.rows as PingRow[];
}

async function guardRowExists(batchId: string): Promise<boolean> {
  const result = await pg.query(`SELECT key FROM write_guards WHERE key = $1`, [
    flushGuardKey(batchId),
  ]);
  return result.rows.length > 0;
}

/** The never-write-status proof, re-applied after every flush below. */
async function expectStatusUnchanged(monitorId: number, seeded: string): Promise<void> {
  const row = (await fetchMonitor(monitorId))!;
  expect(row.status).toBe(seeded);
}

/** Deletes every stage:/flushstage: key on the admin client (SCAN, never a
 *  blocking keyspace call — same discipline the module itself follows). */
async function flushTier2Keys(): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await admin.scan(cursor, "MATCH", "*stage:*", "COUNT", 100);
    cursor = next;
    if (keys.length > 0) await admin.del(...keys);
  } while (cursor !== "0");
}

async function readStaging(monitorId: number): Promise<Record<string, string>> {
  return admin.hgetall(stagingKey(monitorId));
}

function stagedRows(fields: Record<string, string>): StagedPingRow[] {
  return Object.keys(fields)
    .filter((field) => field.startsWith("ping:"))
    .sort((a, b) => Number.parseInt(a.slice(5), 10) - Number.parseInt(b.slice(5), 10))
    .map((field) => JSON.parse(fields[field]) as StagedPingRow);
}

/** Stages the canonical 3-UP batch: ts at(1)/at(2)/at(4,500), rt 111/222/333. */
async function stageThreeUps(monitorId: number): Promise<void> {
  await stageResult(monitorId, upOutcome(111), new Date(at(1)));
  await stageResult(monitorId, upOutcome(222), new Date(at(2)));
  await stageResult(monitorId, upOutcome(333), new Date(at(4, 500)));
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  admin = new Redis(process.env.REDIS_URL!);
  await pg.connect();
  await pg.query("TRUNCATE write_guards, outbox, incidents, pings, monitors, users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`tier2-test-${crypto.randomUUID()}@example.test`]
  );
  testUserId = user.rows[0].id as string;
});

beforeEach(async () => {
  await pg.query("TRUNCATE write_guards");
  await flushTier2Keys();
});

afterAll(async () => {
  disposeStagingRedis();
  await admin.quit();
  await pg.end();
});

describe("Tier 2 guarded staged flush — S16.2 (DAT-02/03/07)", () => {
  it(
    "1. source form: RENAMENX not plain rename, SCAN not blocking keyspace, never-status UPDATE, guard + D-36 derivation, id-less multi-row INSERT",
    () => {
      // Redis command surface, pinned on the module source (acceptance
      // criteria: the rename-with-NX command present, the plain rename
      // command absent, SCAN-based sweep, no KEYS-style blocking call).
      const moduleSource = readFileSync(
        new URL("../../src/worker/persist/tier2.ts", import.meta.url),
        "utf8"
      );
      expect(moduleSource).toMatch(/\.renamenx\(/);
      expect(moduleSource).not.toMatch(/\.rename\(/); // renamenx( does NOT match this
      expect(moduleSource).toMatch(/\.scan\(/);
      // Object.keys is not a Redis call — strip it before the no-KEYS pin.
      const sourceSansObjectKeys = moduleSource.replace(/Object\.keys\(/g, "");
      expect(sourceSansObjectKeys).not.toMatch(/\.keys\(/);
      // Key namespaces: guard flush:{batchId}; staging stage:{monitorId};
      // snapshot flushstage:{batchId} (behavioral pins on the builders).
      expect(stagingKey(42)).toBe("stage:42");
      expect(flushStageKey("1757800000000:42")).toBe("flushstage:1757800000000:42");
      expect(flushGuardKey("1757800000000:42")).toBe("flush:1757800000000:42");
      // Rule 9: the flush window upper bound.
      expect(FLUSH_CADENCE_MS).toBeGreaterThan(0);
      expect(FLUSH_CADENCE_MS).toBeLessThanOrEqual(60_000);

      // Guard: same-transaction write guard with the skip-driving RETURNING.
      const guard = new PgDialect().sqlToQuery(guardInsertSql("flush:1757800000000:42")).sql;
      expect(guard).toContain("INSERT INTO write_guards (key)");
      expect(guard).toContain("ON CONFLICT DO NOTHING");
      expect(guard).toContain("RETURNING key");

      // UPDATE: additive counters, GREATEST+COALESCE lastChecked, monotonic
      // responseTime CASE, the D-36 exact-extraction constants — and the
      // never-write-status rule as a STRUCTURAL absence.
      const update = new PgDialect().sqlToQuery(
        monitorFlushUpdateSql(42, 3, 0, at(4, 500), 333)
      ).sql;
      expect(update).not.toMatch(/\bstatus\b/i); // B3 fix: no status column anywhere
      expect(update).toContain('"totalChecks" = "totalChecks" +');
      expect(update).toContain('"failedChecks" = "failedChecks" +');
      expect(update).toContain("GREATEST(");
      expect(update).toContain("COALESCE(");
      expect(update).toMatch(/CASE WHEN \$\d+::timestamp > "lastChecked"/);
      expect(update).toContain(")::bigint");
      expect(update).toContain("* 4503599627370496::double precision"); // 2^52 (y >= 1)
      expect(update).toContain("* 1152921504606846976::double precision"); // 2^60 (y < 1)
      expect(update).toContain("floor(");
      expect(update).toContain("* 100.0::double precision");
      expect(update).toMatch(/WHERE id = \$\d+$/m);
      expect(update).toContain("RETURNING id");

      // Ping INSERT: id omitted (DAT-07), DAT-10 metadata, multi-row VALUES.
      const rows: StagedPingRow[] = [
        { status: "UP", responseTime: 111, errorClass: null, statusCode: 200, createdAtMs: at(1) },
        { status: "UP", responseTime: 222, errorClass: null, statusCode: 200, createdAtMs: at(2) },
      ];
      const pings = new PgDialect().sqlToQuery(pingsBulkInsertSql(42, rows)).sql;
      const columns = pings.match(/INSERT INTO pings \(([^)]*)\)/)![1];
      expect(columns).not.toContain("id");
      expect(columns).toContain("error_class");
      expect(columns).toContain("status_code");
      expect(pings).toMatch(/\), \(/); // one tuple per staged check
    },
    10_000
  );

  it(
    "2. staging math: three staged UP results aggregate exactly as db-batcher's flush math consumes them",
    async () => {
      const monitorId = 424242; // staging is Redis-only — no DB row needed

      await stageThreeUps(monitorId);

      const fields = await readStaging(monitorId);
      // The staged record: slot allocator + one complete evidence row per
      // check (no parallel counter field — deltas derive from the rows, so
      // the counters can never account a check whose evidence is absent).
      expect(Object.keys(fields).sort()).toEqual(["ping:1", "ping:2", "ping:3", "pingSeq"]);

      const rows = stagedRows(fields);
      expect(rows).toHaveLength(3);
      // db-batcher flush math, tier2 form: totalChecks delta = row count (+3),
      // failedChecks delta = non-UP rows (+0 — UP-class only, by contract).
      expect(rows.filter((r) => r.status === "UP")).toHaveLength(3);
      // Evidence fields ride every row for the bulk INSERT.
      expect(rows[0]).toEqual({
        status: "UP",
        responseTime: 111,
        errorClass: null,
        statusCode: 200,
        createdAtMs: at(1),
      });
      expect(rows[1].responseTime).toBe(222);
      expect(rows[2].createdAtMs).toBe(at(4, 500)); // lastChecked = max staged ts
      // Additive form: staging a fourth result extends, never replaces.
      await stageResult(monitorId, upOutcome(444), new Date(at(5)));
      const after = stagedRows(await readStaging(monitorId));
      expect(after).toHaveLength(4);
      expect(after[3].responseTime).toBe(444);
    },
    10_000
  );

  it(
    "3. flush applies: additive counters, parity uptime, lastChecked max via GREATEST, monotonic responseTime, 3 UUID evidence rows",
    async () => {
      // 3a: staged max is NEWER than the row's lastChecked — everything advances.
      const m1 = await seedMonitor({
        status: "UP",
        totalChecks: 10,
        failedChecks: 2,
        lastChecked: formatPgTimestamp(at(0)), // 10:00 — older than every staged ts
        responseTime: 999,
      });
      await stageThreeUps(m1);
      const batch1 = `${Date.now()}:${m1}`;

      const result = await flushMonitor(m1, batch1);
      expect(result).toEqual({ applied: true, skipped: null, pingsInserted: 3 });

      const monitor = (await fetchMonitor(m1))!;
      expect(monitor.totalChecks).toBe(13); // 10 + 3, additive
      expect(monitor.failedChecks).toBe(2); // +0 routine UP
      expect(monitor.uptimePercent.toFixed(2)).toBe((((13 - 2) / 13) * 100).toFixed(2)); // "84.62"
      expect(monitor.lastChecked).toBe(formatPgTimestamp(at(4, 500))); // staged max
      expect(monitor.responseTime).toBe(333); // rt paired with the newest ts
      await expectStatusUnchanged(m1, "UP");

      const pings = await fetchPings(m1);
      expect(pings).toHaveLength(3);
      for (const ping of pings) {
        expect(ping.id).toMatch(UUID_RE); // DAT-07: DB-generated, never bound
        expect(ping.status).toBe("UP");
        expect(ping.error_class).toBeNull();
        expect(ping.status_code).toBe(200);
      }
      expect(pings[0].responseTime).toBe(111);
      expect(pings[1].responseTime).toBe(222);
      expect(pings[2].responseTime).toBe(333);
      expect(pings[0].created).toBe(formatPgTimestamp(at(1)));
      expect(pings[1].created).toBe(formatPgTimestamp(at(2)));
      expect(pings[2].created).toBe(formatPgTimestamp(at(4, 500)));

      // Guard row committed with the batch-scoped key; both Redis keys gone.
      expect(await guardRowExists(batch1)).toBe(true);
      expect(await admin.exists(stagingKey(m1))).toBe(0);
      expect(await admin.exists(flushStageKey(batch1))).toBe(0);

      // 3b: the row already holds a NEWER lastChecked — GREATEST never
      // regresses it and the monotonic CASE keeps the paired responseTime.
      const m2 = await seedMonitor({
        status: "UP",
        totalChecks: 0,
        failedChecks: 0,
        lastChecked: formatPgTimestamp(at(30)), // 10:30 — NEWER than staged
        responseTime: 555,
      });
      await stageResult(m2, upOutcome(111), new Date(at(1)));
      await stageResult(m2, upOutcome(222), new Date(at(2)));
      const batch2 = `${Date.now()}:${m2}`;

      expect(await flushMonitor(m2, batch2)).toEqual({
        applied: true,
        skipped: null,
        pingsInserted: 2,
      });

      const monitor2 = (await fetchMonitor(m2))!;
      expect(monitor2.totalChecks).toBe(2);
      expect(monitor2.uptimePercent.toFixed(2)).toBe("100.00");
      expect(monitor2.lastChecked).toBe(formatPgTimestamp(at(30))); // NOT regressed
      expect(monitor2.responseTime).toBe(555); // ELSE branch — kept
      await expectStatusUnchanged(m2, "UP");
    },
    15_000
  );

  it(
    "4. never-write-status: a sentinel monitors.status survives the flush (the B3 fix)",
    async () => {
      // 'UNKNOWN' — the schema default, distinct from both UP and DOWN: any
      // status write (the legacy db-batcher defect) would surface here.
      const monitorId = await seedMonitor({
        status: "UNKNOWN",
        totalChecks: 4,
        failedChecks: 1,
      });
      await stageResult(monitorId, upOutcome(120), new Date(at(1)));
      await stageResult(monitorId, upOutcome(130), new Date(at(2)));

      await flushMonitor(monitorId, `${Date.now()}:${monitorId}`);

      await expectStatusUnchanged(monitorId, "UNKNOWN");
      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.totalChecks).toBe(6);
      expect(monitor.failedChecks).toBe(1);
      expect(monitor.uptimePercent.toFixed(2)).toBe((((6 - 1) / 6) * 100).toFixed(2)); // "83.33"
      expect(await fetchPings(monitorId)).toHaveLength(2);
    },
    10_000
  );

  it(
    "5. ownership: two concurrent flushes over one staging key — exactly one applies (RENAMENX)",
    async () => {
      const monitorId = await seedMonitor({ status: "UP", totalChecks: 0, failedChecks: 0 });
      await stageThreeUps(monitorId);
      const epoch = Date.now();
      const batchA = `${epoch}:${monitorId}`;
      const batchB = `${epoch + 1}:${monitorId}`;

      const [a, b] = await Promise.all([
        flushMonitor(monitorId, batchA),
        flushMonitor(monitorId, batchB),
      ]);

      const winners = [a, b].filter((r) => r.applied);
      const losers = [a, b].filter((r) => !r.applied);
      expect(winners).toHaveLength(1);
      expect(winners[0].pingsInserted).toBe(3);
      expect(losers).toHaveLength(1);
      expect(losers[0].skipped).toBe("not-owner");
      expect(losers[0].pingsInserted).toBe(0);

      // Applied exactly once — counters AND ping count.
      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.totalChecks).toBe(3);
      expect(monitor.failedChecks).toBe(0);
      expect(await fetchPings(monitorId)).toHaveLength(3);
      await expectStatusUnchanged(monitorId, "UP");
      // Only the winner's guard exists; the loser wrote nothing. Either call
      // may win the rename — resolve the winner's batchId dynamically.
      const winnerBatch = a.applied ? batchA : batchB;
      const loserBatch = a.applied ? batchB : batchA;
      expect(await guardRowExists(winnerBatch)).toBe(true);
      expect(await guardRowExists(loserBatch)).toBe(false);
    },
    15_000
  );

  it(
    "6. crash-after-COMMIT redelivery (CR-02): same batchId re-run applies nothing and never steals the fresh staging key",
    async () => {
      const monitorId = await seedMonitor({ status: "UP", totalChecks: 5, failedChecks: 1 });
      const batchId = `${Date.now()}:${monitorId}`;
      await stageThreeUps(monitorId);

      // First delivery applies and cleans up (the crash happened after this).
      expect(await flushMonitor(monitorId, batchId)).toEqual({
        applied: true,
        skipped: null,
        pingsInserted: 3,
      });
      await stageThreeUps(monitorId); // deltas accrued AFTER the commit

      // Redelivery of the SAME job: identical batchId, staging recreated.
      const redelivered = await flushMonitor(monitorId, batchId);
      expect(redelivered.applied).toBe(false);
      expect(redelivered.skipped).toBe("guard-preexists");
      expect(redelivered.pingsInserted).toBe(0);

      // Nothing re-applied: counters unchanged, no new pings.
      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.totalChecks).toBe(8); // 5 + 3 once, NOT + 6
      expect(monitor.failedChecks).toBe(1);
      expect(await fetchPings(monitorId)).toHaveLength(3);
      await expectStatusUnchanged(monitorId, "UP");

      // CR-02 core: the fresh live staging key SURVIVES the redelivery —
      // the guard pre-check exited before any rename could drag it into the
      // deleted snapshot path (a plain RENAME would have destroyed it).
      const fields = await readStaging(monitorId);
      expect(stagedRows(fields)).toHaveLength(3);
      expect(await admin.exists(flushStageKey(batchId))).toBe(0);

      // The next pass (new batchId) flushes those stragglers normally.
      const next = await flushMonitor(monitorId, `${Date.now() + 1}:${monitorId}`);
      expect(next).toEqual({ applied: true, skipped: null, pingsInserted: 3 });
      expect(((await fetchMonitor(monitorId))!).totalChecks).toBe(11);
      expect(await fetchPings(monitorId)).toHaveLength(6);
    },
    15_000
  );

  it(
    "7. same-batchId concurrent flush: the in-transaction guard applies exactly once under parallelism",
    async () => {
      const monitorId = await seedMonitor({ status: "UP", totalChecks: 0, failedChecks: 0 });
      await stageThreeUps(monitorId);
      const batchId = `${Date.now()}:${monitorId}`;

      // Both pass the pre-check; both may even read the snapshot — the
      // ON CONFLICT DO NOTHING inside the transaction is the dedupe layer.
      const results = await Promise.all([
        flushMonitor(monitorId, batchId),
        flushMonitor(monitorId, batchId),
      ]);

      expect(results.filter((r) => r.applied)).toHaveLength(1);
      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.totalChecks).toBe(3); // once, not twice
      expect(monitor.uptimePercent.toFixed(2)).toBe("100.00");
      expect(await fetchPings(monitorId)).toHaveLength(3);
      await expectStatusUnchanged(monitorId, "UP");
      expect(await admin.exists(flushStageKey(batchId))).toBe(0);
    },
    15_000
  );

  it(
    "8. misrouted transition result rejected loudly: DOWN never stages (Tier 1 owns it)",
    async () => {
      const monitorId = 777001;

      await expect(
        stageResult(monitorId, { status: "DOWN", responseTimeMs: 10012, errorClass: "timeout", statusCode: null }, new Date(at(1)))
      ).rejects.toThrow(/UP-class/);
      expect(await admin.exists(stagingKey(monitorId))).toBe(0);

      // An existing staging hash is NOT corrupted by the rejected write.
      await stageResult(monitorId, upOutcome(111), new Date(at(2)));
      await expect(
        stageResult(monitorId, { status: "DOWN", responseTimeMs: 500, errorClass: "http_5xx", statusCode: 500 }, new Date(at(3)))
      ).rejects.toThrow(/UP-class/);
      expect(stagedRows(await readStaging(monitorId))).toHaveLength(1);
    },
    10_000
  );

  it(
    "9. deleted monitor: FK-safe no-op — guard commits, snapshot cleans, no throw, no poison loop",
    async () => {
      const monitorId = await seedMonitor({ status: "UP" });
      await pg.query(`DELETE FROM monitors WHERE id = $1`, [monitorId]);
      await stageThreeUps(monitorId);
      const batchId = `${Date.now()}:${monitorId}`;

      const result = await flushMonitor(monitorId, batchId);
      expect(result.applied).toBe(false);
      expect(result.skipped).toBe("monitor-missing");
      // The guard row marks the batch applied so a redelivery cannot retry
      // forever against the dead FK target.
      expect(await guardRowExists(batchId)).toBe(true);
      expect(await admin.exists(flushStageKey(batchId))).toBe(0);
      expect(await admin.exists(stagingKey(monitorId))).toBe(0);
      expect(await fetchPings(monitorId)).toHaveLength(0); // no orphan rows
    },
    10_000
  );

  it(
    "10. flushDueMonitors sweep: SCAN-based, deterministic batchIds, junk keys untouched, empty staging benign",
    async () => {
      const m1 = await seedMonitor({ status: "UP", totalChecks: 1, failedChecks: 0 });
      const m2 = await seedMonitor({ status: "DOWN", totalChecks: 2, failedChecks: 2 });
      await stageResult(m1, upOutcome(100), new Date(at(1)));
      await stageResult(m1, upOutcome(110), new Date(at(2)));
      await stageResult(m2, upOutcome(210), new Date(at(1)));
      // A malformed stage:* key is skipped, never deleted.
      await admin.set("stage:notanumber", "junk");

      const outcomes = await flushDueMonitors();
      const flushedIds = outcomes.map((o) => o.monitorId).sort((a, b) => a - b);
      expect(flushedIds).toEqual([m1, m2].sort((a, b) => a - b));
      for (const outcome of outcomes) {
        expect(outcome.applied).toBe(true);
        expect(outcome.batchId).toMatch(/^\d+:\d+$/); // {epochMs}:{monitorId} pin
        expect(outcome.pingsInserted).toBeGreaterThan(0);
      }

      const monitor1 = (await fetchMonitor(m1))!;
      expect(monitor1.totalChecks).toBe(3);
      expect(monitor1.uptimePercent.toFixed(2)).toBe("100.00");
      await expectStatusUnchanged(m1, "UP");

      // m2's row is DOWN (post-transition): tier2 counters still apply, the
      // status is still never touched.
      const monitor2 = (await fetchMonitor(m2))!;
      expect(monitor2.totalChecks).toBe(3);
      expect(monitor2.failedChecks).toBe(2); // routine UP adds no failures
      await expectStatusUnchanged(m2, "DOWN");

      expect(await fetchPings(m1)).toHaveLength(2);
      expect(await fetchPings(m2)).toHaveLength(1);
      expect(await admin.exists("stage:notanumber")).toBe(1); // untouched
      expect(await admin.exists(stagingKey(m1))).toBe(0);
      expect(await admin.exists(stagingKey(m2))).toBe(0);

      // Nothing staged anywhere: benign not-owner, no transaction side effects.
      const empty = await flushMonitor(m1, `${Date.now()}:${m1}`);
      expect(empty).toEqual({ applied: false, skipped: "not-owner", pingsInserted: 0 });
      expect(await guardRowExists(`${Date.now()}:${m1}`)).toBe(false);
    },
    15_000
  );
});
