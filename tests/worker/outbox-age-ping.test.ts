import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { processTick } from "@/worker/scheduler";
import type { OutboxMetricsSnapshot } from "@/worker/persist/outbox";
import type { WorkerQueueSet } from "@/worker/queues";

// ---------------------------------------------------------------------------
// Conditional dead-man proof suite (OBS-03 / D-23 / D-24): the outbox-age and
// Redis-memory healthchecks.io checks hang off the tick AFTER the heartbeat.
//
//   outbox-age: pinged only while the oldest unsent non-FAILED row is younger
//     than 90 s (OUTBOX_AGE_ALERT_THRESHOLD_SECONDS); at threshold crossing a
//     single /fail marker fires, then SILENCE — the 5-minute grace pages
//     (D-23/D-25). Read failures (-1 sentinel or a throw) degrade visibly
//     (warn log marker) without throwing and without pinging.
//   memory: pinged only while memoryPercent stays under 70
//     (MEMORY_ALERT_PERCENT); null counts as unknown-but-healthy; at 70 or
//     above the ping is withheld (30-minute grace pages, D-24/D-25).
//
// Providers are injected through processTick's deps seams (04-08 TEST-ONLY
// discipline — no env tricks); the claim runs against the real docker test
// Postgres with an empty monitors table (zero claims — the ping side is the
// subject); global fetch is stubbed for pure observation.
//
// Crossing-marker state is module-level and shared across the cases in this
// file BY DESIGN — every case that depends on it first drives the state to a
// known point with a healthy tick, so case order never matters.
// ---------------------------------------------------------------------------

const HEARTBEAT_URL = "https://hc.example.test/worker-heartbeat-mock";
const OUTBOX_URL = "https://hc.example.test/worker-outbox-mock";
const MEMORY_URL = "https://hc.example.test/worker-memory-mock";

let pg: Client;
let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv: Record<string, string | undefined> = {};

function fakeQueues(): WorkerQueueSet {
  const checks = {
    add: vi.fn(async () => ({})),
    getJobCounts: vi.fn(async () => ({ wait: 0, prioritized: 0, delayed: 0, active: 0 })),
  };
  return { checks } as unknown as WorkerQueueSet;
}

const outboxSnap = (oldestUnsentSeconds: number | null): OutboxMetricsSnapshot => ({
  unsent: 0,
  failed: 0,
  latency: { sample: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
  oldestUnsentSeconds,
});

const memorySnap = (memoryPercent: number | null) => ({
  usedMemoryBytes: memoryPercent === null ? null : 1000,
  maxMemoryBytes: memoryPercent === null ? null : 100_000,
  memoryPercent,
});

/** Runs one tick over the injected providers (monitors table empty: zero claims). */
function tickWith(providers: {
  oldestUnsentSeconds?: number | null;
  outboxThrows?: boolean;
  memoryPercent?: number | null;
}) {
  return processTick({
    queues: fakeQueues(),
    outboxMetrics: providers.outboxThrows
      ? async () => {
          throw new Error("outbox metrics query failed");
        }
      : async () => outboxSnap(providers.oldestUnsentSeconds ?? null),
    memorySnapshot: async () => memorySnap(providers.memoryPercent ?? null),
  });
}

function callsTo(url: string): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0])).filter((u) => u.startsWith(url));
}

function failCalls(url: string): string[] {
  return callsTo(url).filter((u) => u.endsWith("/fail"));
}

function successCalls(url: string): string[] {
  return callsTo(url).filter((u) => !u.endsWith("/fail"));
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
});

afterAll(async () => {
  await pg.end();
});

beforeEach(async () => {
  // Empty monitors table: every tick claims zero rows, so the ping wiring is
  // the only thing under observation.
  await pg.query("TRUNCATE monitors CASCADE");
  fetchMock = vi.fn(async () => new Response("OK"));
  vi.stubGlobal("fetch", fetchMock);
  for (const key of [
    "WORKER_HC_PING_URL",
    "WORKER_OUTBOX_HC_PING_URL",
    "WORKER_MEMORY_HC_PING_URL",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.WORKER_HC_PING_URL = HEARTBEAT_URL;
  process.env.WORKER_OUTBOX_HC_PING_URL = OUTBOX_URL;
  process.env.WORKER_MEMORY_HC_PING_URL = MEMORY_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("outbox-age + memory dead-man pings (OBS-03 / D-23 / D-24)", () => {
  it(
    "1. healthy outbox (oldest below 90) pings the outbox check once per tick — one ping per check total",
    async () => {
      const result = await tickWith({ oldestUnsentSeconds: 10, memoryPercent: 42.5 });

      expect(result).toMatchObject({ claimed: 0, enqueued: 0, failed: 0 });
      expect(successCalls(OUTBOX_URL)).toEqual([OUTBOX_URL]);
      expect(failCalls(OUTBOX_URL)).toEqual([]);
      // Pitfall 3: exactly one ping PER CHECK per tick — three checks, three
      // fetches, nothing more.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
    15_000
  );

  it(
    "2. threshold crossing: one /fail marker, then silence; recovery re-arms the marker",
    async () => {
      // Drive the crossing state to a known point: a healthy tick resets it.
      await tickWith({ oldestUnsentSeconds: 10 });
      fetchMock.mockClear();

      // Crossing tick at exactly 90 s: success withheld, exactly one /fail.
      await tickWith({ oldestUnsentSeconds: 90 });
      expect(successCalls(OUTBOX_URL)).toEqual([]);
      expect(failCalls(OUTBOX_URL)).toEqual([`${OUTBOX_URL}/fail`]);

      // Subsequent over-threshold ticks: NO ping at all — silence pages via
      // the 5-minute grace (D-23/D-25), and repeated pings would trip the
      // 5/min cap (Pitfall 3).
      fetchMock.mockClear();
      await tickWith({ oldestUnsentSeconds: 120 });
      await tickWith({ oldestUnsentSeconds: 200 });
      expect(callsTo(OUTBOX_URL)).toEqual([]);

      // Recovery: healthy again -> success pings resume.
      fetchMock.mockClear();
      await tickWith({ oldestUnsentSeconds: 5 });
      expect(successCalls(OUTBOX_URL)).toEqual([OUTBOX_URL]);

      // Re-arm: a later crossing fires the /fail marker again (the reset is
      // real, not a one-shot latch).
      fetchMock.mockClear();
      await tickWith({ oldestUnsentSeconds: 95 });
      expect(failCalls(OUTBOX_URL)).toEqual([`${OUTBOX_URL}/fail`]);
    },
    15_000
  );

  it(
    "3. read failure (throw) and the -1 sentinel degrade visibly without throwing — and without pinging",
    async () => {
      // Known point: healthy.
      await tickWith({ oldestUnsentSeconds: 10 });
      fetchMock.mockClear();

      // Provider throws: the tick still returns its TickResult, no outbox
      // ping (silence fails toward detection — the 5-min grace absorbs a
      // transient read failure, a sustained one pages), heartbeat unaffected.
      const thrown = await tickWith({ outboxThrows: true });
      expect(thrown).toMatchObject({ claimed: 0, failed: 0 });
      expect(callsTo(OUTBOX_URL)).toEqual([]);
      expect(successCalls(HEARTBEAT_URL)).toEqual([HEARTBEAT_URL]);

      // -1 failure sentinel: same posture — no throw, no ping.
      const sentinel = await tickWith({ oldestUnsentSeconds: -1 });
      expect(sentinel.claimed).toBe(0);
      expect(callsTo(OUTBOX_URL)).toEqual([]);

      // Crossing state survived the unknowns unchanged (still armed from
      // false): the next over-threshold tick fires its /fail marker.
      fetchMock.mockClear();
      await tickWith({ oldestUnsentSeconds: 95 });
      expect(failCalls(OUTBOX_URL)).toEqual([`${OUTBOX_URL}/fail`]);
    },
    15_000
  );

  it(
    "4. memory: pinged while under 70 (null = unknown-but-healthy); withheld at 70 or above",
    async () => {
      await tickWith({ oldestUnsentSeconds: null, memoryPercent: 69.9 });
      expect(successCalls(MEMORY_URL)).toEqual([MEMORY_URL]);

      fetchMock.mockClear();
      await tickWith({ oldestUnsentSeconds: null, memoryPercent: null });
      expect(successCalls(MEMORY_URL)).toEqual([MEMORY_URL]);

      fetchMock.mockClear();
      await tickWith({ oldestUnsentSeconds: null, memoryPercent: 70 });
      expect(callsTo(MEMORY_URL)).toEqual([]);

      fetchMock.mockClear();
      await tickWith({ oldestUnsentSeconds: null, memoryPercent: 99.9 });
      expect(callsTo(MEMORY_URL)).toEqual([]);
      // Withheld means withheld — no /fail form either (the 30-min grace
      // pages on silence; D-24 defines no explicit fail marker for memory).
      expect(failCalls(MEMORY_URL)).toEqual([]);
    },
    15_000
  );

  it(
    "5. unset URLs produce zero fetches for the respective check",
    async () => {
      delete process.env.WORKER_OUTBOX_HC_PING_URL;
      await tickWith({ oldestUnsentSeconds: 10, memoryPercent: 50 });
      expect(callsTo(OUTBOX_URL)).toEqual([]);
      expect(successCalls(HEARTBEAT_URL)).toEqual([HEARTBEAT_URL]);
      expect(successCalls(MEMORY_URL)).toEqual([MEMORY_URL]);

      fetchMock.mockClear();
      delete process.env.WORKER_MEMORY_HC_PING_URL;
      await tickWith({ oldestUnsentSeconds: 10, memoryPercent: 50 });
      expect(callsTo(MEMORY_URL)).toEqual([]);
      expect(successCalls(HEARTBEAT_URL)).toEqual([HEARTBEAT_URL]);

      fetchMock.mockClear();
      delete process.env.WORKER_HC_PING_URL;
      await tickWith({ oldestUnsentSeconds: 10, memoryPercent: 50 });
      expect(fetchMock).not.toHaveBeenCalled();
    },
    15_000
  );

  it("6. source form: pinned thresholds + degrade markers + no ping URL in a log call", () => {
    const source = readFileSync("src/worker/scheduler.ts", "utf8");

    // D-23 band midpoint pinned (OQ1 resolution); D-24 percent.
    expect(source).toContain("OUTBOX_AGE_ALERT_THRESHOLD_SECONDS = 90");
    expect(source).toContain("MEMORY_ALERT_PERCENT = 70");

    // The degrade path is visible: greppable warn markers exist.
    expect(source).toContain("OUTBOX_METRICS_READ_FAILED");

    // pino ids-only rule (secret-bearing env class): no log call carries a
    // ping URL/env reference.
    const offending = source
      .split("\n")
      .filter((line) => /\blog\.(info|warn|error)\(/.test(line) && line.includes("PING_URL"));
    expect(offending).toEqual([]);
  });
});
