import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { startHealthServer } from "@/worker/health";
import type { HealthServer } from "@/worker/health";
import { workerPgPool } from "@/worker/db";

// ---------------------------------------------------------------------------
// Worker health-server suite (WRK-08, D-13) against the REAL docker test
// stack — Redis :6390 / Postgres :5453, wired by vitest.config.ts (never
// mocked: the readiness contract under test is the actual ping behavior).
//
// Pins:
//   1. /healthz 200 carrying sha + builtAt provenance (D-10)
//   2. /readyz 200 with redis AND db ok when both dependencies answer, and
//      onReady (the PM2-ready seam) fires
//   3. /metrics.json 200 — D-24/D-25 collector seed (provenance + one-INFO
//      Redis memory snapshot)
//   4. the FAILING half: injected Redis at an unreachable port -> /readyz
//      503 with per-dependency status, and onReady does NOT fire (the
//      two-signal contract — wiring only HTTP without the process signal
//      boot-crash-loops under wait_ready)
//
// The server binds an EPHEMERAL port (port 0) so parallel-safe runs never
// fight over the runbook's 9090; the actual port is read back from the
// resolved HealthServer.
// ---------------------------------------------------------------------------

/** A dead local port that nothing listens on (never 6390 — the test stack). */
const DEAD_PORT_URL = "redis://localhost:64444";

let healthy: HealthServer;
let deadRedis: Redis | undefined;
let deadServer: HealthServer | undefined;
/** Every real client the file created — injected clients are NOT owned (and never quit) by the health server. */
const createdClients: Redis[] = [];

function trackClient(client: Redis): Redis {
  createdClients.push(client);
  return client;
}

beforeAll(async () => {
  // Real dependency clients: the module-level ioredis singleton contract is
  // satisfied by vitest's env wiring (REDIS_URL -> :6390, DATABASE_URL ->
  // :5453), and the pool is the worker's own globalThis-cached instance.
  healthy = await startHealthServer({
    port: 0,
    redis: trackClient(new Redis(process.env.REDIS_URL!)),
    pool: workerPgPool,
  });
});

afterAll(async () => {
  await healthy.shutdown().catch(() => {});
  await deadServer?.shutdown().catch(() => {});
  for (const client of createdClients) await client.quit().catch(() => {});
  deadRedis?.disconnect();
});

describe("worker health server — :healthz/:readyz/:metrics.json (WRK-08, D-13)", () => {
  it("1. /healthz returns 200 with the D-10 provenance fields (sha, builtAt)", async () => {
    const res = await fetch(`http://127.0.0.1:${healthy.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.sha).toBe("string");
    expect(typeof body.builtAt).toBe("string");
    expect(typeof body.uptimeSeconds).toBe("number");
    // T-04-01: provenance/status only — no connection strings or env values.
    expect(JSON.stringify(body)).not.toContain(process.env.REDIS_URL!);
    expect(JSON.stringify(body)).not.toContain(process.env.DATABASE_URL!);
  });

  it("2. /readyz returns 200 with per-dependency status when Redis AND Postgres answer, and onReady fires", async () => {
    const readySpy = vi.fn();
    const server = await startHealthServer({
      port: 0,
      redis: trackClient(new Redis(process.env.REDIS_URL!)),
      pool: workerPgPool,
      onReady: readySpy,
    });
    try {
      const readiness = await server.bootReadiness;
      expect(readiness).toEqual({ redis: true, db: true });

      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; redis: { ok: boolean }; db: { ok: boolean } };
      expect(body).toEqual({ ok: true, redis: { ok: true }, db: { ok: true } });
      // The PM2-ready seam fired exactly once, only after BOTH pings passed.
      expect(readySpy).toHaveBeenCalledTimes(1);
    } finally {
      await server.shutdown().catch(() => {});
    }
  });

  it("3. /metrics.json returns 200 with the D-24/D-25 collector seed shape", async () => {
    const res = await fetch(`http://127.0.0.1:${healthy.port}/metrics.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      sha: string;
      builtAt: string;
      redis: { usedMemoryBytes: number | null; maxMemoryBytes: number | null; memoryPercent: number | null };
    };
    expect(body.ok).toBe(true);
    expect(typeof body.sha).toBe("string");
    // One-INFO memory snapshot: used_memory is always reported by Redis;
    // the test container sets no maxmemory, so percent degrades to null —
    // later plans extend this object with queue gauges (additive shape).
    expect(body.redis.usedMemoryBytes).toBeGreaterThan(0);
    expect(body.redis.maxMemoryBytes).toBeNull();
    expect(body.redis.memoryPercent).toBeNull();
  });

  it("4. failing Redis fake: /readyz returns 503 with redis:false, and onReady does NOT fire", async () => {
    const readySpy = vi.fn();
    deadRedis = new Redis(DEAD_PORT_URL, {
      connectTimeout: 250,
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
      // Returning nothing stops the reconnect loop — the command rejects
      // fast instead of backing off forever.
      retryStrategy: () => undefined,
    });
    deadRedis.on("error", () => {}); // unhandled "error" throws — fail quiet

    deadServer = await startHealthServer({
      port: 0,
      redis: deadRedis,
      pool: workerPgPool, // Postgres stays healthy — only Redis fails
      onReady: readySpy,
    });

    const readiness = await deadServer.bootReadiness;
    expect(readiness).toEqual({ redis: false, db: true });
    // WRK-08 two-signal contract: the PM2-ready seam must stay silent when
    // either dependency is down — this is what makes wait_ready restart the
    // process instead of serving traffic half-ready.
    expect(readySpy).not.toHaveBeenCalled();

    const res = await fetch(`http://127.0.0.1:${deadServer.port}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; redis: { ok: boolean }; db: { ok: boolean } };
    expect(body).toEqual({ ok: false, redis: { ok: false }, db: { ok: true } });
  });

  it("5. unknown paths return 404 and non-GET methods 405 (no hidden surface)", async () => {
    const notFound = await fetch(`http://127.0.0.1:${healthy.port}/nope`);
    expect(notFound.status).toBe(404);
    const post = await fetch(`http://127.0.0.1:${healthy.port}/healthz`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});

describe("WORKER_HEALTH_PORT resolution — IN-01 empty-string guard (06-02)", () => {
  it("empty string resolves to 9090 — never Number('') === 0 (ephemeral port)", async () => {
    const { resolveWorkerHealthPort } = await import("@/worker/health");
    expect(resolveWorkerHealthPort("")).toBe(9090);
    expect(resolveWorkerHealthPort(undefined)).toBe(9090);
    expect(resolveWorkerHealthPort("9099")).toBe(9099);
  });

  it("startHealthServer with WORKER_HEALTH_PORT set to the EMPTY STRING binds 9090", async () => {
    const previous = process.env.WORKER_HEALTH_PORT;
    process.env.WORKER_HEALTH_PORT = "";
    try {
      const server = await startHealthServer({
        // port option deliberately absent — the env path under test.
        redis: trackClient(new Redis(process.env.REDIS_URL!)),
        pool: workerPgPool,
      });
      try {
        expect(server.port).toBe(9090);
      } finally {
        await server.shutdown().catch(() => {});
      }
    } finally {
      if (previous === undefined) {
        delete process.env.WORKER_HEALTH_PORT;
      } else {
        process.env.WORKER_HEALTH_PORT = previous;
      }
    }
  });
});
