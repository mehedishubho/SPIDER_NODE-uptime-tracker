import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  BREAKER_GATE_MARKER,
  BREAKER_OPEN_MS,
  BREAKER_THRESHOLD,
  BreakerOpenError,
  canEnqueue,
  probe,
  recordInfraFailure,
  recordResult,
  recordSuccess,
  resetBreaker,
  setBreakerClock,
  state,
} from "@/worker/breaker";

// ---------------------------------------------------------------------------
// Circuit-breaker proof suite (RES-01 / D-33 / Pattern 6) — the state machine
// is driven with the TEST-ONLY clock seam (the CheckRequest.denylist
// precedent); the HALF_OPEN probe case runs against the REAL docker test
// Postgres (:5453) because write_guards ON CONFLICT semantics are engine
// semantics. Seeds/hygiene go through raw SQL via TEST_DATABASE_URL only
// (02-02 rule); state isolation is resetBreaker() + setBreakerClock() — the
// module holds no Redis state at all (01-03: restart = CLOSED).
//
// Pins:
//   1. source form — D-33 constants, enqueue-gate-only surface (no pause, no
//      queues import — Pattern 6), reserved probe-key prefix, gate marker
//   2. CLOSED admits; sub-threshold failures never open (4 < 5)
//   3. success resets the CONSECUTIVE counter mid-run
//   4. the 5th consecutive failure opens — gate refuses within the window
//   5. HALF_OPEN probe against real Postgres: one write_guards row under the
//      reserved prefix, gate admits, breaker CLOSED after
//   6. failed probe re-opens with a FRESH 60 s window (§13.9); a later
//      successful probe closes
//   7. WRK-05 classification single-sourcing — pg-path connect/timeout/
//      server-shape errors are infra; target DNS / AbortError are target and
//      NEVER count; unclassifiable internal bugs are infra (§15.1 step 5)
//   8. HALF_OPEN admits exactly ONE probe — concurrent gates share it
//   9. recordSuccess: no-op inside a live OPEN window, closes in HALF_OPEN
//  10. resetBreaker = the simulated process restart (01-03)
// ---------------------------------------------------------------------------

/** Deterministic fake epoch (2027-01-15T00:00:00Z-ish); cases advance it. */
const BASE_MS = 1_800_000_000_000;

let pg: Client;
let now = BASE_MS;

function advance(ms: number): void {
  now += ms;
}

function tripClosedToOpen(): void {
  for (let i = 0; i < BREAKER_THRESHOLD; i += 1) recordInfraFailure();
}

function pgError(message: string, code?: string, extra?: Record<string, string>): Error {
  const err = new Error(message) as Error & { code?: string } & Record<string, string>;
  if (code) err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
});

beforeEach(() => {
  resetBreaker();
  setBreakerClock(() => now);
  now = BASE_MS;
});

afterAll(async () => {
  setBreakerClock(); // restore the real clock for any later suite consumer
  await pg.query("TRUNCATE write_guards");
  await pg.end();
});

describe("Postgres circuit breaker — RES-01/D-33 (audit §13.3, Pattern 6)", () => {
  it(
    "1. source form: D-33 pins, enqueue-gate-only surface (no pause, no queue reference), reserved probe prefix",
    () => {
      expect(BREAKER_THRESHOLD).toBe(5);
      expect(BREAKER_OPEN_MS).toBe(60_000);
      expect(BREAKER_GATE_MARKER).toBe("BREAKER_GATE");
      expect(new BreakerOpenError("test context")).toBeInstanceOf(Error);
      expect(new BreakerOpenError("test context").name).toBe("BreakerOpenError");

      const source = readFileSync(new URL("../../src/worker/breaker.ts", import.meta.url), "utf8");
      // Pattern 6 structural pin: the breaker gates ENQUEUES only. No
      // queue.pause anywhere, and no coupling to the queues module (a paused
      // queue would also block operator smoke enqueues — Pitfall 12).
      expect(source).not.toMatch(/\.pause\(/);
      expect(source).not.toMatch(/from\s+"\.\/queues"/);
      expect(source).not.toMatch(/from\s+"@\/worker\/queues"/);
      // §13.3's reserved probe traffic: identifiable, never double-applies.
      expect(source).toContain("breaker:probe:");
      expect(source).toContain("ON CONFLICT DO NOTHING");
      expect(source).toContain("write_guards");
      // Enqueue-side gate marker present for the refusal logs (RES-01).
      expect(source).toContain(BREAKER_GATE_MARKER);
    },
    10_000
  );

  it("2. CLOSED admits everything; 4 consecutive infra failures keep it CLOSED", async () => {
    expect(state()).toEqual({
      state: "CLOSED",
      consecutiveFailures: 0,
      openSince: null,
    });
    expect(await canEnqueue()).toBe(true);

    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) {
      recordInfraFailure();
      expect(state().state).toBe("CLOSED"); // never opens below the threshold
    }
    expect(state().consecutiveFailures).toBe(4);
    expect(await canEnqueue()).toBe(true);
  });

  it("3. success resets the CONSECUTIVE counter mid-run (flapping never accumulates)", () => {
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) recordInfraFailure();
    recordSuccess();
    expect(state().consecutiveFailures).toBe(0);

    // 4 more after the reset: still one below the threshold — the 5-in-a-row
    // requirement is consecutive, not cumulative.
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) recordInfraFailure();
    expect(state().state).toBe("CLOSED");
    expect(state().consecutiveFailures).toBe(4);
  });

  it("4. the 5th consecutive failure opens; the gate refuses within the 60 s window", async () => {
    tripClosedToOpen();

    const openedAt = state();
    expect(openedAt.state).toBe("OPEN");
    expect(openedAt.consecutiveFailures).toBe(5);
    expect(openedAt.openSince).toBe(BASE_MS);

    // Inside the window: refused, state stays OPEN (no probe runs).
    advance(10_000);
    expect(await canEnqueue()).toBe(false);
    expect(state().state).toBe("OPEN");
    expect(state().openSince).toBe(BASE_MS); // window pinned, never extended

    // One ms before the boundary is still OPEN; at the boundary it is HALF_OPEN.
    advance(BREAKER_OPEN_MS - 10_000 - 1);
    expect(state().state).toBe("OPEN");
    advance(1);
    expect(state().state).toBe("HALF_OPEN");
  });

  it(
    "5. HALF_OPEN probe against real Postgres: one write_guards row under the reserved prefix, gate admits, breaker CLOSED",
    async () => {
      await pg.query("TRUNCATE write_guards");
      tripClosedToOpen();
      advance(BREAKER_OPEN_MS + 1); // window elapsed -> HALF_OPEN
      expect(state().state).toBe("HALF_OPEN");

      // Default db = the module's own workerDb (the real docker test Postgres).
      expect(await canEnqueue()).toBe(true);

      const rows = await pg.query(`SELECT key FROM write_guards WHERE key LIKE 'breaker:probe:%'`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].key).toBe(`breaker:probe:${BASE_MS + BREAKER_OPEN_MS + 1}`);

      // Probe success closes; the gate reopens unconditionally.
      expect(state()).toEqual({
        state: "CLOSED",
        consecutiveFailures: 0,
        openSince: null,
      });
      expect(await canEnqueue()).toBe(true);
      await pg.query("TRUNCATE write_guards");
    },
    15_000
  );

  it("6. a failed probe re-opens with a FRESH 60 s window (§13.9); a later success closes", async () => {
    tripClosedToOpen();
    const firstOpenSince = state().openSince!;
    advance(BREAKER_OPEN_MS + 1); // HALF_OPEN

    const failingDb = {
      execute: () => Promise.reject(pgError("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")),
    };
    expect(await canEnqueue(failingDb)).toBe(false);

    const reopened = state();
    expect(reopened.state).toBe("OPEN");
    expect(reopened.openSince).toBeGreaterThan(firstOpenSince); // fresh window

    // The fresh window is a full one — refusing long after the first opened.
    advance(BREAKER_OPEN_MS - 1);
    expect(await canEnqueue(failingDb)).toBe(false);
    expect(state().state).toBe("OPEN");

    // Next HALF_OPEN with a healthy Postgres closes it for real.
    advance(1);
    expect(await canEnqueue()).toBe(true);
    expect(state().state).toBe("CLOSED");
  });

  it("7. WRK-05 classification: pg-path errors are infra; target-class and abort errors NEVER count; internal bugs are infra (§15.1 step 5)", () => {
    // The worker Postgres-path shapes — the same errno codes isInfraFailure
    // rightly treats as TARGET on the HTTP path are infra HERE because the
    // call-context contract feeds recordResult only worker-DB escapes.
    const infraCases: Array<[string, Error]> = [
      ["connect-phase refusal", pgError("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")],
      ["connect-phase timeout", pgError("connect ETIMEDOUT 10.0.0.5:5432", "ETIMEDOUT")],
      [
        "pool termination phrase",
        pgError("Connection terminated unexpectedly"),
      ],
      ["pool timeout phrase", pgError("timeout expired")],
      [
        "server-sent error shape",
        pgError("relation does not exist", undefined, { severity: "ERROR", routine: "parser" }),
      ],
      ["resolver outage (shared infra class)", pgError("getaddrinfo EAI_AGAIN db.internal", "EAI_AGAIN")],
      ["unclassifiable internal bug", new TypeError("cannot read properties of undefined")],
    ];
    for (const [label, err] of infraCases) {
      resetBreaker();
      expect(recordResult(err), label).toBe("infra");
      expect(state().consecutiveFailures, label).toBe(1);
    }

    // Target-class escapes NEVER increment — the WRK-05 contract that keeps
    // DOWN outcomes from arming the breaker.
    const targetCases: Array<[string, Error]> = [
      ["target NXDOMAIN", pgError("getaddrinfo ENOTFOUND no-such.example.test", "ENOTFOUND")],
      ["target-timeout abort", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
    ];
    for (const [label, err] of targetCases) {
      resetBreaker();
      expect(recordResult(err), label).toBe("target");
      expect(state().consecutiveFailures, label).toBe(0);
      expect(state().state, label).toBe("CLOSED");
    }

    // And a full trip purely through recordResult (the processor's real path).
    resetBreaker();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      expect(recordResult(pgError("connect ECONNREFUSED", "ECONNREFUSED"))).toBe("infra");
    }
    expect(state().state).toBe("OPEN");
  });

  it("8. HALF_OPEN admits exactly ONE probe: concurrent gate calls share the single in-flight write", async () => {
    tripClosedToOpen();
    advance(BREAKER_OPEN_MS + 1);

    let calls = 0;
    let release!: (value: unknown) => void;
    const slowDb = {
      execute: () => {
        calls += 1;
        return new Promise<unknown>((resolve) => {
          release = resolve;
        });
      },
    };

    const gate1 = canEnqueue(slowDb);
    const gate2 = canEnqueue(slowDb);
    const gate3 = canEnqueue(slowDb);
    await new Promise((resolve) => setImmediate(resolve)); // let the first probe start
    expect(calls).toBe(1); // ONE probe write, shared — not three

    release({ rows: [] });
    expect(await gate1).toBe(true);
    expect(await gate2).toBe(true);
    expect(await gate3).toBe(true);
    expect(calls).toBe(1);
    expect(state().state).toBe("CLOSED");
  });

  it("9. recordSuccess: a no-op inside a live OPEN window; de-facto probe evidence in HALF_OPEN closes", () => {
    tripClosedToOpen();

    // In-flight jobs draining while OPEN succeed — that must NOT reopen the
    // gate (recovery is the probe's pinned job).
    recordSuccess();
    expect(state().state).toBe("OPEN");
    expect(state().openSince).toBe(BASE_MS);

    // After the window (HALF_OPEN), a successful real write closes.
    advance(BREAKER_OPEN_MS + 1);
    recordSuccess();
    expect(state()).toEqual({
      state: "CLOSED",
      consecutiveFailures: 0,
      openSince: null,
    });
  });

  it("10. resetBreaker is the simulated process restart: an OPEN breaker returns to CLOSED (01-03)", async () => {
    tripClosedToOpen();
    advance(5_000); // still inside the window
    expect(state().state).toBe("OPEN");

    resetBreaker();
    expect(state()).toEqual({
      state: "CLOSED",
      consecutiveFailures: 0,
      openSince: null,
    });
    expect(await canEnqueue()).toBe(true); // restart never wedges the gate shut
  });

  it("11. probe() resolves false (not throw) on a failing db — callers gate on the verdict", async () => {
    tripClosedToOpen();
    advance(BREAKER_OPEN_MS + 1);
    const failingDb = { execute: () => Promise.reject(new Error("Connection terminated unexpectedly")) };
    await expect(probe(failingDb)).resolves.toBe(false);
    expect(state().state).toBe("OPEN");
  });
});
