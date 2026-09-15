import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { startHealthServer } from "@/worker/health";
import type { HealthServer } from "@/worker/health";
import { createMetricsRegistry } from "@/worker/metrics";
import { recordInfraFailure, resetBreaker } from "@/worker/breaker";
import { QUEUE_NAMES, collectQueueMetrics } from "@/worker/queues";
import type { WorkerQueueSet } from "@/worker/queues";
import { collectOutboxMetrics } from "@/worker/persist/outbox";
import { workerPgPool } from "@/worker/db";

// ---------------------------------------------------------------------------
// OBS-05 / D-26: the /metrics Prometheus exposition on the worker's existing
// loopback health server. The registry is created by createMetricsRegistry
// over INJECTED fixtures (fake queue set, fake INFO client, breaker driven
// through its real state machine, outbox snapshots mocked at the collector
// boundary) so every asserted value proves the collect() wiring reads the
// providers — not hardcoded numbers.
//
// The two collector modules are mocked WITH delegation to their real
// implementations: the happy-path cases run the real collectQueueMetrics over
// the fake queue set, while the degrade case flips the spies to reject — the
// only way to exercise the gauges' own catch (the real collectors swallow
// internally, so a raw fake can never throw).
//
// Pins:
//   1. GET /metrics -> 200, registry contentType, every spidernode_ family,
//      and fixture-true values on the depth/age/stalled/outbox/latency/
//      memory/breaker gauges (the 05-05 scraper + gate-2 contract).
//   2. GET /metrics.json unchanged (sibling-branch regression).
//   3. /metrics without an injected registry stays 404 (no hidden surface).
//   4. Throwing collectors degrade to ABSENT samples — never a 500, and never
//      STALE values from a previous scrape (reset-first collect semantics).
//   5. The exposition carries no connection strings or tokens (T-05-03-01).
// ---------------------------------------------------------------------------

vi.mock("@/worker/queues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/worker/queues")>();
  return { ...actual, collectQueueMetrics: vi.fn(actual.collectQueueMetrics) };
});

vi.mock("@/worker/persist/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/worker/persist/outbox")>();
  return { ...actual, collectOutboxMetrics: vi.fn(actual.collectOutboxMetrics) };
});

/** used_memory 256 MiB / maxmemory 512 MiB -> exactly 50.0 percent. */
const INFO_TEXT = "# Memory\r\nused_memory:268435456\r\nmaxmemory:536870912\r\n";
const fakeInfoRedis = { info: async () => INFO_TEXT } as unknown as Pick<Redis, "info">;

interface LaneFixture {
  depth: { wait: number; prioritized: number; delayed: number; active: number };
  waitingStamps: number[];
  prioritizedStamps: number[];
}

/**
 * A minimal WorkerQueueSet stand-in: exactly the surface collectQueueMetrics
 * reads (getJobCounts + the bounded wait/prioritized head scans) per lane.
 */
function fakeQueueSet(lanes: Partial<Record<keyof typeof QUEUE_NAMES, LaneFixture>>): WorkerQueueSet {
  const empty: LaneFixture = {
    depth: { wait: 0, prioritized: 0, delayed: 0, active: 0 },
    waitingStamps: [],
    prioritizedStamps: [],
  };
  const mkLane = (fx: LaneFixture) => ({
    getJobCounts: async () => ({ ...fx.depth }),
    getWaiting: async () => fx.waitingStamps.map((timestamp) => ({ timestamp })),
    getPrioritized: async () => fx.prioritizedStamps.map((timestamp) => ({ timestamp })),
  });
  const set: Record<string, unknown> = { close: async () => {} };
  for (const lane of Object.keys(QUEUE_NAMES)) {
    set[lane] = mkLane(lanes[lane as keyof typeof QUEUE_NAMES] ?? empty);
  }
  return set as unknown as WorkerQueueSet;
}

/** The deterministic outbox snapshot injected at the collector boundary. */
const OUTBOX_FIXTURE = {
  unsent: 2,
  failed: 1,
  latency: { sample: 2, avgMs: 2000, p50Ms: 1000, p95Ms: 3000, maxMs: 3000 },
  oldestUnsentSeconds: 120,
};

/**
 * Reads one exposition sample's numeric value by exact sample-line prefix
 * (label rendering order is the library's business — full-line matching is
 * not). Throws when the sample line is absent, so absence is itself testable
 * via expect(() => sampleValue(...)).toThrow().
 */
function sampleValue(body: string, prefix: string): number {
  const line = body.split("\n").find((l) => l.startsWith(prefix));
  if (line === undefined) throw new Error(`missing sample line: ${prefix}`);
  return Number(line.slice(prefix.length).trim());
}

let server: HealthServer;
const createdClients: Redis[] = [];
/** The factory's delegation target — restored in beforeEach after the degrade case replaces it. */
let realQueueCollector: typeof collectQueueMetrics;

function trackClient(client: Redis): Redis {
  createdClients.push(client);
  return client;
}

beforeAll(async () => {
  realQueueCollector = vi.mocked(collectQueueMetrics).getMockImplementation()!;
  const queues = fakeQueueSet({
    checks: {
      depth: { wait: 2, prioritized: 1, delayed: 0, active: 1 },
      waitingStamps: [Date.now() - 30_000, Date.now() - 15_000],
      prioritizedStamps: [Date.now() - 450_000],
    },
  });
  server = await startHealthServer({
    port: 0,
    redis: trackClient(new Redis(process.env.REDIS_URL!)),
    pool: workerPgPool,
    metricsRegistry: createMetricsRegistry({ queues, redis: fakeInfoRedis }),
  });
});

afterAll(async () => {
  await server.shutdown().catch(() => {});
  for (const client of createdClients) await client.quit().catch(() => {});
});

beforeEach(() => {
  resetBreaker();
  recordInfraFailure(); // CLOSED with consecutiveFailures = 2 -> the fixture
  recordInfraFailure();
  vi.mocked(collectOutboxMetrics).mockReset();
  vi.mocked(collectOutboxMetrics).mockImplementation(
    async () => OUTBOX_FIXTURE as Awaited<ReturnType<typeof collectOutboxMetrics>>
  );
  // Restore the REAL-collector delegation after any standing rejection the
  // degrade case installed (mockClear alone does not bring it back).
  vi.mocked(collectQueueMetrics).mockReset().mockImplementation(realQueueCollector);
});

afterEach(() => {
  resetBreaker();
});

describe("worker /metrics Prometheus exposition (OBS-05, D-26)", () => {
  it("1. GET /metrics returns 200, the registry contentType, and every spidernode_ family with fixture-true values", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(res.status).toBe(200);
    // The registry's own exposition content type (0.16.x text format).
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
    const body = await res.text();

    // Every family the 05-05 scraper and gate 2 consume (stable contract).
    for (const family of [
      "spidernode_queue_depth",
      "spidernode_queue_oldest_job_age_seconds",
      "spidernode_queue_stalled_events",
      "spidernode_outbox_unsent",
      "spidernode_outbox_failed",
      "spidernode_outbox_oldest_age_seconds",
      "spidernode_outbox_alert_latency_seconds",
      "spidernode_redis_memory_percent",
      "spidernode_pg_breaker_failures",
      "spidernode_pg_breaker_state",
    ]) {
      expect(body).toContain(family);
    }

    // Queue gauges — real collectQueueMetrics over the injected fake set.
    expect(sampleValue(body, 'spidernode_queue_depth{queue="monitor-checks",state="wait"} ')).toBe(2);
    expect(sampleValue(body, 'spidernode_queue_depth{queue="monitor-checks",state="active"} ')).toBe(1);
    // 450 s-old prioritized stamp (ms->s; sub-second scrape drift tolerated).
    const oldestAge = sampleValue(body, 'spidernode_queue_oldest_job_age_seconds{queue="monitor-checks"} ');
    expect(oldestAge).toBeGreaterThanOrEqual(450);
    expect(oldestAge).toBeLessThan(460);
    expect(sampleValue(body, 'spidernode_queue_stalled_events{queue="monitor-checks"} ')).toBe(0);

    // Outbox gauges — the injected snapshot, verbatim (ms -> seconds).
    expect(sampleValue(body, "spidernode_outbox_unsent ")).toBe(2);
    expect(sampleValue(body, "spidernode_outbox_failed ")).toBe(1);
    expect(sampleValue(body, "spidernode_outbox_oldest_age_seconds ")).toBe(120);
    expect(sampleValue(body, 'spidernode_outbox_alert_latency_seconds{stat="p50"} ')).toBe(1);
    expect(sampleValue(body, 'spidernode_outbox_alert_latency_seconds{stat="p95"} ')).toBe(3);
    expect(sampleValue(body, 'spidernode_outbox_alert_latency_seconds{stat="avg"} ')).toBe(2);

    // Memory (256/512 MiB -> 50) and breaker (CLOSED, 2 consecutive failures).
    expect(sampleValue(body, "spidernode_redis_memory_percent ")).toBe(50);
    expect(sampleValue(body, "spidernode_pg_breaker_failures ")).toBe(2);
    expect(sampleValue(body, "spidernode_pg_breaker_state ")).toBe(0);

    // collect() actually read the providers at scrape time.
    expect(collectQueueMetrics).toHaveBeenCalled();
    expect(collectOutboxMetrics).toHaveBeenCalled();
  });

  it("2. GET /metrics.json still returns the JSON payload unchanged (sibling branch regression)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/metrics.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { ok: boolean; redis: unknown };
    expect(body.ok).toBe(true);
    expect(body.redis).toBeDefined();
  });

  it("3. /metrics without an injected registry stays 404 (no hidden surface)", async () => {
    const bare = await startHealthServer({
      port: 0,
      redis: trackClient(new Redis(process.env.REDIS_URL!)),
      pool: workerPgPool,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/metrics`);
      expect(res.status).toBe(404);
    } finally {
      await bare.shutdown().catch(() => {});
    }
  });

  it("4. throwing collectors degrade to ABSENT samples — never a 500, never stale values", async () => {
    // First scrape: healthy, so the queue/outbox families carry values.
    const healthy = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(healthy.status).toBe(200);
    const healthyBody = await healthy.text();
    expect(() => sampleValue(healthyBody, "spidernode_outbox_unsent ")).not.toThrow();

    // Flip BOTH collectors to standing rejections — the only way past their
    // internal swallows, and every family's collect() must see the failure
    // (beforeEach restores the real delegation afterward).
    vi.mocked(collectQueueMetrics).mockRejectedValue(new Error("collector boom"));
    vi.mocked(collectOutboxMetrics).mockRejectedValue(new Error("collector boom"));
    const degraded = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(degraded.status).toBe(200); // never-fail-the-surface
    const body = await degraded.text();

    // Degraded families: absent samples (not the stale previous values).
    expect(() => sampleValue(body, "spidernode_queue_depth{")).toThrow();
    expect(() => sampleValue(body, "spidernode_outbox_unsent ")).toThrow();
    expect(() => sampleValue(body, "spidernode_outbox_alert_latency_seconds{")).toThrow();

    // Non-degraded families keep serving — the scrape stays useful.
    expect(sampleValue(body, "spidernode_redis_memory_percent ")).toBe(50);
    expect(sampleValue(body, "spidernode_pg_breaker_failures ")).toBe(2);
  });

  it("5. the exposition carries no connection strings or tokens (T-05-03-01)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    const body = await res.text();
    expect(body).not.toContain(process.env.REDIS_URL!);
    expect(body).not.toContain(process.env.DATABASE_URL!);
    if (process.env.TELEGRAM_BOT_TOKEN) expect(body).not.toContain(process.env.TELEGRAM_BOT_TOKEN);
    if (process.env.CRON_SECRET) expect(body).not.toContain(process.env.CRON_SECRET);
  });
});
