import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyTransition } from "@/worker/persist/tier1";
import type { Tier1Input } from "@/worker/persist/tier1";

// ---------------------------------------------------------------------------
// uptime_percent byte-parity suite (D-36 / CR-01, audit §16.5 D-6).
//
// The worker's SQL-derived uptimePercent must equal the LEGACY JS rendering
// — Math.max(0, Math.min(100, ((total - failed) / total) * 100)) displayed
// via toFixed(2), src/lib/cron-logic.ts lines 149-154 — CHARACTER-COMPARED,
// never tolerance-based: publicly-displayed numbers must not shift at
// cutover (behavior compatibility is the milestone's core value).
//
// Load-bearing ratios and WHY each is in the table:
//   - 0 prior checks, both first-check directions: the 1/1 and 0/1 corners
//     (division-by-total+1 is what makes the SQL safe at 0-checks).
//   - all-up (100.00) / all-down (0.00): the clamp corners; in valid states
//     failed <= total so the unclamped SQL expression must still land on the
//     clamped JS value.
//   - 1-of-3 (33.33) and 2-of-3 (66.67): the plan's repeating-third edges.
//   - 1/7 (14.285714...): inexact non-terminating ratio that is NOT a tie —
//     both engines must truncate-round identically.
//   - 1/8 (12.50), 3/8 (37.50), 1/16 (6.25): terminating decimals through
//     powers of two — exactly representable as doubles.
//   - 1/32 (3.125), 5/32 (15.625): EXACT .xx5 ties in decimal that are also
//     exact doubles — the SQL round must break them the same way JS toFixed
//     does (ties to the larger n for positive values).
//   - 2667/4000 (66.675) and 3/20000 (0.015): exact .xx5 decimal ties whose
//     double approximations are NOT exact (denominators carry 5^3) — the
//     class where EVERY round()-based SQL disagrees with JS float formatting.
//     They DID disagree (round stored 66.68 / 0.02 vs the legacy "66.67" /
//     "0.01"; PG's float8::numeric collapses onto the shortest round-trip
//     decimal, landing exactly ON the tie), so per D-36 the SQL was adjusted
//     through the documented cast/round lever — never the test. The shipped
//     expression extracts the computed double's EXACT binary value as a
//     bigint via a power-of-two shift (multiplying a double by 2^k only
//     bumps the exponent — exact; an integral float8 <= 2^63 casts to bigint
//     exactly) and rounds half-up in arbitrary-precision integer arithmetic:
//     n = floor((m*100 + 2^(s-1)) / 2^s). Two shifts cover [0, 100]: 2^52
//     for y >= 1, 2^60 for y < 1 (exact down to 2^-8; below that the value
//     renders "0.00" with margin). 1/20000 (0.005) rides the same low branch
//     from the OTHER side of its tie (its double sits above it).
// ---------------------------------------------------------------------------

/** cron-logic.ts lines 149-154 + the toFixed(2) display rendering. */
function legacyRendering(totalAfter: number, failedAfter: number): string {
  const uptimePercent = Math.max(
    0,
    Math.min(100, ((totalAfter - failedAfter) / totalAfter) * 100)
  );
  return uptimePercent.toFixed(2);
}

interface ParityCase {
  name: string;
  /** Seeded counters BEFORE the transition. */
  priorTotal: number;
  priorFailed: number;
  target: "UP" | "DOWN";
}

const CASES: ParityCase[] = [
  { name: "zero prior checks, first check UP (1/1)", priorTotal: 0, priorFailed: 0, target: "UP" },
  { name: "zero prior checks, first check DOWN (0/1)", priorTotal: 0, priorFailed: 0, target: "DOWN" },
  { name: "all-up stays all-up (10/10)", priorTotal: 9, priorFailed: 0, target: "UP" },
  { name: "all-down stays all-down (0/10)", priorTotal: 9, priorFailed: 9, target: "DOWN" },
  { name: "1-of-3 up (33.33)", priorTotal: 2, priorFailed: 1, target: "DOWN" },
  { name: "2-of-3 up (66.67)", priorTotal: 2, priorFailed: 0, target: "DOWN" },
  { name: "1-of-7 up, non-terminating non-tie (14.29)", priorTotal: 6, priorFailed: 5, target: "DOWN" },
  { name: "1-of-8 up, terminating (12.50)", priorTotal: 7, priorFailed: 6, target: "DOWN" },
  { name: "3-of-8 up, terminating (37.50)", priorTotal: 7, priorFailed: 4, target: "DOWN" },
  { name: "1-of-16 up, terminating (6.25)", priorTotal: 15, priorFailed: 14, target: "DOWN" },
  { name: "1-of-32 up, EXACT .xx5 tie also exact in double (3.125)", priorTotal: 31, priorFailed: 30, target: "DOWN" },
  { name: "5-of-32 up, EXACT .xx5 tie also exact in double (15.625)", priorTotal: 31, priorFailed: 26, target: "DOWN" },
  { name: "2667-of-4000 up, .xx5 tie INEXACT in double (66.675) — load-bearing", priorTotal: 3999, priorFailed: 1332, target: "DOWN" },
  { name: "1-of-20000 up, low .xx5 tie from ABOVE in double (0.005)", priorTotal: 19999, priorFailed: 19998, target: "DOWN" },
  { name: "3-of-20000 up, low .xx5 tie from BELOW in double (0.015)", priorTotal: 19999, priorFailed: 19996, target: "DOWN" },
];

let pg: Client;
let testUserId: string;

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("TRUNCATE outbox, incidents, pings, monitors, users CASCADE");
  const user = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`parity-test-${crypto.randomUUID()}@example.test`]
  );
  testUserId = user.rows[0].id as string;
});

afterAll(async () => {
  await pg.end();
});

describe("uptime_percent SQL derivation vs legacy JS rendering (D-36 byte parity)", () => {
  for (const testCase of CASES) {
    it(
      testCase.name,
      async () => {
        // Seed the monitor at the given prior counters; the transition adds
        // exactly one check (total+1, failed+1 when DOWN). UP-target cases
        // seed PENDING — the conditional UPDATE requires status <> target.
        const seeded = await pg.query(
          `INSERT INTO monitors (url, name, "userId", status, "isActive", interval,
             "totalChecks", "failedChecks", "uptimePercent", "updatedAt")
           VALUES ($1, $2, $3, $4, true, 5, $5, $6, 100, now()) RETURNING id`,
          [
            "https://example.com",
            `parity-${crypto.randomUUID().slice(0, 8)}`,
            testUserId,
            testCase.target === "DOWN" ? "UP" : "PENDING",
            testCase.priorTotal,
            testCase.priorFailed,
          ]
        );
        const monitorId = seeded.rows[0].id as number;

        const input: Tier1Input = {
          monitorId,
          epoch: Math.floor(Date.now() / 1000),
          targetStatus: testCase.target,
          responseTimeMs: 100,
          errorClass: testCase.target === "DOWN" ? "http_5xx" : null,
          statusCode: testCase.target === "DOWN" ? 500 : 200,
          interval: 5,
        };
        const result = await applyTransition(input);
        expect(result.applied).toBe(true); // seeded 'UP' -> target always differs

        const row = (
          await pg.query(`SELECT "uptimePercent", "totalChecks", "failedChecks" FROM monitors WHERE id = $1`, [
            monitorId,
          ])
        ).rows[0] as { uptimePercent: number; totalChecks: number; failedChecks: number };

        // The counters landed where the case intended (guards a bad seed).
        const totalAfter = testCase.priorTotal + 1;
        const failedAfter = testCase.priorFailed + (testCase.target === "DOWN" ? 1 : 0);
        expect(row.totalChecks).toBe(totalAfter);
        expect(row.failedChecks).toBe(failedAfter);

        // CHARACTER comparison — the SQL-derived value rendered at 2 places
        // must equal the legacy clamped-float toFixed(2) rendering exactly.
        const expected = legacyRendering(totalAfter, failedAfter);
        const actual = row.uptimePercent.toFixed(2);
        expect(actual).toBe(expected);
      },
      15_000
    );
  }

  it(
    "documented adjustment lever stays applied: the expression is the exact-extraction round (source-form pin)",
    async () => {
      // The parity surface above is behavioral; this pins that the shipped
      // expression remains the D-36 adjusted form — the power-of-two ::bigint
      // extraction with integer floor rounding (every round()-based variant,
      // including a bare two-arg round on the double column that would throw
      // 42883, was rejected by the tie cases above).
      const { transitionUpdateSql } = await import("@/worker/persist/tier1");
      const { PgDialect } = await import("drizzle-orm/pg-core");
      const compiled = new PgDialect().sqlToQuery(
        transitionUpdateSql({
          monitorId: 1,
          epoch: 0,
          targetStatus: "DOWN",
          responseTimeMs: 0,
          errorClass: null,
          statusCode: null,
          interval: 1,
        })
      ).sql;
      expect(compiled).toContain(")::bigint");
      expect(compiled).toContain("* 4503599627370496::double precision"); // 2^52 (y >= 1)
      expect(compiled).toContain("* 1152921504606846976::double precision"); // 2^60 (y < 1)
      expect(compiled).toContain("floor(");
      // ...plus the legacy JS op order inside: double-precision division
      // FIRST, * 100.0 after — the y whose exact expansion is extracted.
      expect(compiled).toContain("* 100.0::double precision");
    },
    10_000
  );
});
