import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  applyTransition,
  evidencePingSql,
  transitionUpdateSql,
} from "@/worker/persist/tier1";
import type { Tier1Input } from "@/worker/persist/tier1";
import { workerPgPool } from "@/worker/db";

// ---------------------------------------------------------------------------
// Tier 1 transition proof suite (DAT-01/03-partial/04/07/10, audit §16.1)
// against the REAL docker test Postgres (:5453) — the conditional UPDATE, the
// partial-unique ON CONFLICT no-op, and the in-UPDATE uptime derivation are
// Postgres semantics, only provable on the real engine. Seeds go through raw
// SQL via TEST_DATABASE_URL only (02-02 rule); applyTransition runs through
// the worker's own globalThis-cached pool (workerDb, max 20).
//
// Pins (the four transition paths + idempotency + evidence-first ordering):
//   1. source form — the D-36 exact-extraction round (power-of-two ::bigint
//      shift + integer floor arithmetic, no round() call anywhere), the
//      conditional WHERE, additive counters, and NO INSERT ever supplies an
//      id (DAT-07)
//   2. PENDING->UP: ping + counters + first_check outbox row, NO incident
//   3. UP->DOWN: ping + ONGOING incident (cron-parity description) + down
//      outbox row + failedChecks/consecutiveFailures increment (1-strike)
//   4. DOWN->UP: resolves the ONGOING incident + recovered outbox row
//   5. PENDING->DOWN: incident + down event from the very first check
//      (first check down is NOT first_check — cron-logic parity)
//   6. DUPLICATE delivery: second evidence ping, ZERO-row UPDATE, exactly
//      one ONGOING incident, one outbox row, counters advanced ONCE
//   7. deactivated monitor: same zero-row skip path, ping still commits
//   8. deleted monitor: nothing written, no throw (§15.1 step-1 no-op)
//   9. every inserted row carries a non-null DB-generated text UUID id
//  10. WR-05 clock domain: every workerPgPool session reports TimeZone UTC
//      exactly — the one clock domain Tier-1 naive now() writes, Tier-2 UTC
//      strings, and maintenance AT TIME ZONE horizons all share (D-29)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pg: Client;
let testUserId: string;

interface MonitorRow {
  id: number;
  status: string;
  "totalChecks": number;
  "failedChecks": number;
  consecutive_failures: number;
  "uptimePercent": number;
  "lastChecked": string | null;
  "responseTime": number | null;
  next_check_at: string | null;
}

async function seedMonitor(opts: {
  status: string;
  totalChecks?: number;
  failedChecks?: number;
  isActive?: boolean;
  interval?: number;
}): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval,
       "totalChecks", "failedChecks", "uptimePercent", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 100, now()) RETURNING id`,
    [
      "https://example.com",
      `tier1-test-${crypto.randomUUID().slice(0, 8)}`,
      testUserId,
      opts.status,
      opts.isActive ?? true,
      opts.interval ?? 5,
      opts.totalChecks ?? 0,
      opts.failedChecks ?? 0,
    ]
  );
  return result.rows[0].id as number;
}

async function seedOngoingIncident(monitorId: number): Promise<string> {
  const result = await pg.query(
    `INSERT INTO incidents ("monitorId", status, description)
     VALUES ($1, 'ONGOING', 'Monitor went down. Status code: Timeout') RETURNING id`,
    [monitorId]
  );
  return result.rows[0].id as string;
}

async function fetchMonitor(id: number): Promise<MonitorRow | undefined> {
  const result = await pg.query(`SELECT * FROM monitors WHERE id = $1`, [id]);
  return result.rows[0] as MonitorRow | undefined;
}

async function fetchPings(monitorId: number) {
  const result = await pg.query(
    `SELECT * FROM pings WHERE "monitorId" = $1 ORDER BY "createdAt" ASC, id ASC`,
    [monitorId]
  );
  return result.rows as Array<{
    id: string;
    status: string;
    "responseTime": number;
    "error_class": string | null;
    "status_code": number | null;
  }>;
}

async function fetchIncidents(monitorId: number) {
  const result = await pg.query(`SELECT * FROM incidents WHERE "monitorId" = $1`, [monitorId]);
  return result.rows as Array<{
    id: string;
    status: string;
    description: string | null;
    "resolvedAt": string | null;
  }>;
}

async function fetchOutbox(monitorId: number) {
  const result = await pg.query(`SELECT * FROM outbox WHERE monitor_id = $1`, [monitorId]);
  return result.rows as Array<{
    id: string;
    event_type: string;
    incident_id: string | null;
    payload: Record<string, unknown>;
    sent_at: string | null;
    attempts: number;
  }>;
}

function makeInput(
  monitorId: number,
  targetStatus: "UP" | "DOWN",
  overrides: Partial<Tier1Input> = {}
): Tier1Input {
  return {
    monitorId,
    epoch: Math.floor(Date.now() / 1000),
    targetStatus,
    responseTimeMs: 123,
    errorClass: targetStatus === "DOWN" ? "http_5xx" : null,
    statusCode: targetStatus === "DOWN" ? 500 : 200,
    interval: 5,
    ...overrides,
  };
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("TRUNCATE outbox, incidents, pings, monitors, users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`tier1-test-${crypto.randomUUID()}@example.test`]
  );
  testUserId = user.rows[0].id as string;
});

afterAll(async () => {
  await pg.end();
});

describe("Tier 1 transition transaction — §16.1 + D-35 (DAT-01/04)", () => {
  it(
    "1. source form: Pitfall 1 cast chain, conditional WHERE, additive counters, id-less INSERTs",
    () => {
      const input = makeInput(1, "DOWN");
      const update = new PgDialect().sqlToQuery(transitionUpdateSql(input)).sql;

      // D-36 exact-extraction form: no round() anywhere (a bare
      // round(double precision, 2) would throw 42883, and rounding the
      // decimalized value fails byte parity at 2667/4000). The computed
      // double's exact value is extracted via power-of-two shifts (::bigint)
      // and rounded by arbitrary-precision integer floor arithmetic.
      expect(update).toContain(")::bigint");
      expect(update).toContain("* 4503599627370496::double precision"); // 2^52 (y >= 1)
      expect(update).toContain("* 1152921504606846976::double precision"); // 2^60 (y < 1)
      expect(update).toContain("floor(");
      // The legacy JS op order is preserved inside: division in double
      // precision FIRST, * 100.0 after — the y whose exact expansion the
      // round consumes (proven load-bearing at 2667/4000 = 66.675).
      expect(update).toContain(")::double precision");
      expect(update).toContain("* 100.0::double precision");
      // D-1 conditional gate + additive counters + RETURNING.
      expect(update).toContain("AND status <>");
      expect(update).toContain('"isActive"');
      expect(update).toContain('"totalChecks" = "totalChecks" + 1');
      expect(update).toContain("RETURNING id");

      const ping = new PgDialect().sqlToQuery(evidencePingSql(input)).sql;
      // DAT-07: the ping INSERT never supplies an id.
      expect(ping).toMatch(/INSERT INTO pings \("[^)]*"\)/);
      const pingColumns = ping.match(/INSERT INTO pings \(([^)]*)\)/)![1];
      expect(pingColumns).not.toContain("id");
      // DAT-10: error_class + status_code ride the evidence row.
      expect(pingColumns).toContain('error_class');
      expect(pingColumns).toContain('status_code');
    },
    10_000
  );

  it(
    "2. PENDING->UP: ping + counters + first_check outbox row, NO incident",
    async () => {
      const monitorId = await seedMonitor({ status: "PENDING" });
      const before = Date.now();

      const result = await applyTransition(makeInput(monitorId, "UP", { statusCode: 200, errorClass: null }));
      const after = Date.now();

      expect(result.applied).toBe(true);
      expect(result.eventType).toBe("monitor.first_check");
      expect(result.incidentId).toBeNull();

      // Evidence ping: one row, DB-generated id, DAT-10 metadata.
      const pings = await fetchPings(monitorId);
      expect(pings).toHaveLength(1);
      expect(pings[0].id).toMatch(UUID_RE);
      expect(pings[0].status).toBe("UP");
      expect(pings[0].responseTime).toBe(123);
      expect(pings[0].status_code).toBe(200);
      expect(pings[0].error_class).toBeNull();

      // Counters: first check up.
      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.status).toBe("UP");
      expect(monitor.totalChecks).toBe(1);
      expect(monitor.failedChecks).toBe(0);
      expect(monitor.consecutive_failures).toBe(0);
      expect(monitor.lastChecked).not.toBeNull();
      expect(monitor.responseTime).toBe(123);
      expect(monitor.uptimePercent.toFixed(2)).toBe("100.00"); // 1/1 up
      // Schedule slot advanced: now + interval minutes.
      const next = new Date(monitor.next_check_at!).getTime();
      expect(next).toBeGreaterThan(before + 5 * 60_000 - 5_000);
      expect(next).toBeLessThan(after + 5 * 60_000 + 5_000);

      // Outbox: exactly one monitor.first_check row, incident_id NULL by design.
      const outbox = await fetchOutbox(monitorId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].event_type).toBe("monitor.first_check");
      expect(outbox[0].incident_id).toBeNull();
      expect(outbox[0].sent_at).toBeNull();
      expect(outbox[0].attempts).toBe(0);
      // Payload carries the relay's rendering needs (identity, code, timezone).
      expect(outbox[0].payload.monitorName).toContain("tier1-test-");
      expect(outbox[0].payload.monitorUrl).toBe("https://example.com");
      expect(outbox[0].payload.statusCode).toBe(200);
      expect(outbox[0].payload.userTimezone).toBe("UTC");
      expect(typeof outbox[0].payload.occurredAt).toBe("string");

      // No incident on a first check up.
      expect(await fetchIncidents(monitorId)).toHaveLength(0);
    },
    15_000
  );

  it(
    "3. UP->DOWN: ping + ONGOING incident (cron-parity description) + down outbox + increments",
    async () => {
      const monitorId = await seedMonitor({ status: "UP", totalChecks: 5, failedChecks: 0 });

      const result = await applyTransition(
        makeInput(monitorId, "DOWN", { statusCode: 503, errorClass: "http_5xx", responseTimeMs: 250 })
      );

      expect(result.applied).toBe(true);
      expect(result.eventType).toBe("incident.down");
      expect(result.incidentId).toMatch(UUID_RE);

      const pings = await fetchPings(monitorId);
      expect(pings).toHaveLength(1);
      expect(pings[0].status).toBe("DOWN");
      expect(pings[0].status_code).toBe(503);
      expect(pings[0].error_class).toBe("http_5xx");

      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.status).toBe("DOWN");
      expect(monitor.totalChecks).toBe(6);
      expect(monitor.failedChecks).toBe(1);
      expect(monitor.consecutive_failures).toBe(1); // 1-strike: incremented on the FIRST failure
      expect(monitor.responseTime).toBe(250);
      // 5 up of 6 total = 83.33 (legacy JS rendering).
      expect(monitor.uptimePercent.toFixed(2)).toBe("83.33");

      // One ONGOING incident with the cron-logic parity description.
      const incidents = await fetchIncidents(monitorId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].status).toBe("ONGOING");
      expect(incidents[0].description).toBe("Monitor went down. Status code: 503");
      expect(incidents[0].resolvedAt).toBeNull();

      // One down outbox row riding the incident id (CR-03 non-null).
      const outbox = await fetchOutbox(monitorId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].event_type).toBe("incident.down");
      expect(outbox[0].incident_id).toBe(incidents[0].id);
      expect(outbox[0].payload.statusCode).toBe(503);
    },
    15_000
  );

  it(
    "4. DOWN->UP: resolves the ONGOING incident + recovered outbox row",
    async () => {
      const monitorId = await seedMonitor({ status: "DOWN", totalChecks: 10, failedChecks: 2 });
      const incidentId = await seedOngoingIncident(monitorId);

      const result = await applyTransition(makeInput(monitorId, "UP"));

      expect(result.applied).toBe(true);
      expect(result.eventType).toBe("incident.recovered");
      expect(result.incidentId).toBe(incidentId);

      const incidents = await fetchIncidents(monitorId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].status).toBe("RESOLVED");
      expect(incidents[0].resolvedAt).not.toBeNull();

      const outbox = await fetchOutbox(monitorId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].event_type).toBe("incident.recovered");
      expect(outbox[0].incident_id).toBe(incidentId); // CR-03: non-null

      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.status).toBe("UP");
      expect(monitor.totalChecks).toBe(11);
      expect(monitor.failedChecks).toBe(2); // unchanged by an UP check
      expect(monitor.consecutive_failures).toBe(0); // reset on UP
      // 9 up of 11 total = 81.82.
      expect(monitor.uptimePercent.toFixed(2)).toBe("81.82");
    },
    15_000
  );

  it(
    "5. PENDING->DOWN: incident + down event from the very first check (NOT first_check)",
    async () => {
      const monitorId = await seedMonitor({ status: "PENDING" });

      const result = await applyTransition(
        makeInput(monitorId, "DOWN", { statusCode: null, errorClass: "timeout", responseTimeMs: 10_012 })
      );

      expect(result.applied).toBe(true);
      expect(result.eventType).toBe("incident.down");
      expect(result.incidentId).toMatch(UUID_RE);

      // No-response fallback in the description parity string.
      const incidents = await fetchIncidents(monitorId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].description).toBe("Monitor went down. Status code: Timeout");

      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.status).toBe("DOWN");
      expect(monitor.totalChecks).toBe(1);
      expect(monitor.failedChecks).toBe(1);
      expect(monitor.uptimePercent.toFixed(2)).toBe("0.00");
    },
    15_000
  );

  it(
    "6. DUPLICATE delivery: second evidence ping, zero-row UPDATE, one incident, one outbox row, counters ONCE",
    async () => {
      const monitorId = await seedMonitor({ status: "UP", totalChecks: 5, failedChecks: 1 });
      const input = makeInput(monitorId, "DOWN", { statusCode: 500, errorClass: "http_5xx" });

      const first = await applyTransition(input);
      expect(first.applied).toBe(true);
      expect(first.eventType).toBe("incident.down");

      // Redelivery of the SAME claimed check (same epoch/target).
      const second = await applyTransition(input);
      expect(second.applied).toBe(false);
      expect(second.eventType).toBeNull();
      expect(second.incidentId).toBeNull();

      // Evidence is never deduplicated: two pings...
      const pings = await fetchPings(monitorId);
      expect(pings).toHaveLength(2);
      for (const ping of pings) {
        expect(ping.status).toBe("DOWN");
        expect(ping.id).toMatch(UUID_RE); // distinct DB-generated ids
      }
      expect(pings[0].id).not.toBe(pings[1].id);

      // ...but exactly one ONGOING incident...
      const incidents = await fetchIncidents(monitorId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].status).toBe("ONGOING");

      // ...exactly one outbox row (no duplicate alert)...
      const outbox = await fetchOutbox(monitorId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].event_type).toBe("incident.down");
      expect(outbox[0].incident_id).toBe(incidents[0].id);

      // ...and counters advanced exactly once: +1/+1, NOT +2/+2.
      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.totalChecks).toBe(6);
      expect(monitor.failedChecks).toBe(2);
      expect(monitor.consecutive_failures).toBe(1);
      expect(monitor.uptimePercent.toFixed(2)).toBe("66.67"); // 4 up of 6
    },
    15_000
  );

  it(
    "7. deactivated monitor: same zero-row skip path, evidence ping still commits (IN-04)",
    async () => {
      const monitorId = await seedMonitor({ status: "UP", isActive: false, totalChecks: 3 });

      const result = await applyTransition(makeInput(monitorId, "DOWN"));

      expect(result.applied).toBe(false);
      expect(result.eventType).toBeNull();

      // The evidence ping for a deactivated monitor is accepted (IN-04).
      expect(await fetchPings(monitorId)).toHaveLength(1);
      // Transition effects skipped entirely.
      expect(await fetchIncidents(monitorId)).toHaveLength(0);
      expect(await fetchOutbox(monitorId)).toHaveLength(0);
      const monitor = (await fetchMonitor(monitorId))!;
      expect(monitor.status).toBe("UP");
      expect(monitor.totalChecks).toBe(3); // counters untouched
    },
    15_000
  );

  it(
    "8. deleted monitor: nothing written, no throw (§15.1 step-1 no-op)",
    async () => {
      const monitorId = await seedMonitor({ status: "PENDING" });
      await pg.query(`DELETE FROM monitors WHERE id = $1`, [monitorId]);

      const result = await applyTransition(makeInput(monitorId, "UP"));
      expect(result).toEqual({ applied: false, eventType: null, incidentId: null });
      // No orphan evidence row (the FK would have made this impossible).
      expect(await fetchPings(monitorId)).toHaveLength(0);
    },
    15_000
  );

  it(
    "9. DAT-07: every inserted row carries a non-null DB-generated text UUID id",
    async () => {
      // Rows accumulated across the cases above (pings, incidents, outbox).
      const pings = (await pg.query(`SELECT id FROM pings`)).rows as Array<{ id: string }>;
      const incidents = (await pg.query(`SELECT id FROM incidents`)).rows as Array<{ id: string }>;
      const outbox = (await pg.query(`SELECT id FROM outbox`)).rows as Array<{ id: string }>;

      expect(pings.length).toBeGreaterThan(0);
      expect(incidents.length).toBeGreaterThan(0);
      expect(outbox.length).toBeGreaterThan(0);
      for (const row of [...pings, ...incidents, ...outbox]) {
        expect(row.id).toMatch(UUID_RE); // never null, never "undefined"
      }
    },
    10_000
  );

  it(
    "10. WR-05: a client acquired from workerPgPool answers SHOW timezone with exactly UTC (D-29 — one clock domain for all writer tiers)",
    async () => {
      // The pool option (-c timezone=UTC) must reach EVERY session the pool
      // mints, not just the drizzle client's: pings."createdAt" and
      // monitors."lastChecked" are naive timestamp columns (audit A6) written
      // by Tier 1 with session now(), by Tier 2 with UTC wall-clock strings,
      // and compared by maintenance against now() AT TIME ZONE 'utc' — any
      // session TimeZone other than exactly "UTC" (e.g. the server default
      // "Etc/UTC" spelling, or an offset zone) offsets Tier-1 rows from
      // Tier-2 rows in the same columns. The assertion is toBe("UTC"), not
      // a UTC-equivalence check: the pin is the pool option verbatim.
      const client = await workerPgPool.connect();
      try {
        const result = await client.query("SHOW timezone");
        expect(result.rows[0].TimeZone).toBe("UTC");
      } finally {
        client.release();
      }

      // The OPTION is load-bearing even where the server default already
      // spells UTC (this docker stack does — WR-05 is a latent deploy-topology
      // hazard, not an active bug): without it, a container/host TZ change or
      // a different server default silently drifts the clock domain, so the
      // pin guards the option itself (outbox-relay case 1's source-pin
      // precedent) — and that the option rides the worker pool block only,
      // never the web pool or the migration runner (prohibition 2).
      const source = readFileSync("src/worker/db.ts", "utf8");
      expect(source).toContain('options: "-c timezone=UTC"');
      expect(source.match(/new Pool\(/g)).toHaveLength(1); // the worker pool is this file's only Pool
    },
    10_000
  );
});
