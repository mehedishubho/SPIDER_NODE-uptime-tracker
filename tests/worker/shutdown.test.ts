import { describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { startHealthServer } from "@/worker/health";

// ---------------------------------------------------------------------------
// Worker graceful-shutdown suite (WRK-07, handler level).
//
// Windows cannot deliver SIGINT to a spawned child programmatically (RESEARCH
// Pitfall 8 — Node maps it to TerminateProcess), so the drain FUNCTION is
// invoked DIRECTLY in-process; the signal-level proof runs in the
// rehearsal's Linux-container leg (resolved Open Question 3).
//
// Pins:
//   1. importing src/worker/index does NOT boot the worker (entry guard)
//   2. drainAndTeardown closes the health server FIRST, awaits every
//      registered drainable (slow stub must COMPLETE before pool teardown),
//      then ends the pool, then quits Redis — order is load-bearing
//   3. a real health server actually stops listening after shutdown
//   4. pool.end and redis.quit are invoked exactly once each
//
// The health server is REAL (loopback, ephemeral port, real test-stack
// Redis injected); pool/redis teardown use recording fakes so the shared
// globalThis-cached worker pool is never ended inside the suite.
// ---------------------------------------------------------------------------

describe("worker shutdown — drain function (WRK-07, Pitfall 8)", () => {
  it("1. importing src/worker/index is side-effect free (no boot, no signal handlers)", async () => {
    const onSpy = vi.spyOn(process, "on");
    try {
      await import("@/worker/index");
      // main() never ran: no SIGINT/SIGTERM listeners were registered by
      // the import itself.
      const registered = onSpy.mock.calls.filter(([event]) => event === "SIGINT" || event === "SIGTERM");
      expect(registered.length).toBe(0);
    } finally {
      onSpy.mockRestore();
    }
  });

  it("2. drainAndTeardown: health closed, drainables AWAITED, then pool.end, then redis.quit", async () => {
    // Fresh module registry so this file's registered stubs are exactly the
    // ones asserted here (index.ts keeps a module-level drain list).
    vi.resetModules();
    const { drainAndTeardown: drain, registerDrainable: register } = await import("@/worker/index");

    const order: string[] = [];
    let stubCompleted = false;
    // A SLOW drainable: if teardown does not await it, endPool would run
    // before stubCompleted flips true.
    register({
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        stubCompleted = true;
        order.push("drainable");
      },
    });

    const endPool = vi.fn(async () => {
      order.push("pool");
    });
    const quitRedis = vi.fn(async () => {
      order.push("redis");
    });
    const closeHealth = vi.fn(async () => {
      order.push("health");
    });

    await drain({ closeHealth, endPool, quitRedis });

    expect(order).toEqual(["health", "drainable", "pool", "redis"]);
    // The drainable fully completed BEFORE pool teardown began (awaited,
    // not fire-and-forgotten).
    expect(stubCompleted).toBe(true);
    expect(endPool).toHaveBeenCalledTimes(1);
    expect(quitRedis).toHaveBeenCalledTimes(1);
    expect(closeHealth).toHaveBeenCalledTimes(1);
  });

  it("3. a real health server stops listening after shutdown runs through drainAndTeardown", async () => {
    vi.resetModules();
    const { drainAndTeardown: drain } = await import("@/worker/index");

    const redis = new Redis(process.env.REDIS_URL!);
    const health = await startHealthServer({
      port: 0,
      redis, // injected -> the health server does NOT own (never quits it)
      pool: { query: async () => ({ rows: [] }) },
    });
    // The server answers before shutdown.
    const before = await fetch(`http://127.0.0.1:${health.port}/healthz`);
    expect(before.status).toBe(200);

    await drain({
      closeHealth: () => health.shutdown(),
      endPool: async () => {},
      quitRedis: () => redis.quit(),
    });

    expect(health.server.listening).toBe(false);
    await expect(fetch(`http://127.0.0.1:${health.port}/healthz`)).rejects.toThrow();
  });
});
