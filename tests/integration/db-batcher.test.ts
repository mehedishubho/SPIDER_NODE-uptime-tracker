import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Characterization suite: src/lib/db-batcher.ts (FND-06 data-path half, 02-03)
//
// Pins TODAY'S enqueue/flush arithmetic and the failure-swallow behavior —
// defects included (D-15). The batcher keeps module-level mutable state
// (`pendingPings` array + `pendingMonitorUpdates` Map), so this file has NO
// static import of @/lib/db-batcher: vi.resetModules() in beforeEach +
// dynamic import() per case gives every case fresh queues (Pitfall 3).
//
// The database is the real docker test Postgres, driven through the
// @/lib/prisma singleton (never mocked — mocking the ORM would characterize
// the mock, not the system). No fetch or Telegram stubs needed: the batcher's
// entire external surface is Postgres.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";

/** Fresh module state per case (Pitfall 3). */
async function freshBatcher() {
  return import("@/lib/db-batcher");
}

interface MonitorSeed {
  status?: string;
  responseTime?: number;
  uptimePercent?: number;
  totalChecks?: number;
  failedChecks?: number;
}

async function seedMonitor(overrides: MonitorSeed = {}) {
  const user = await prisma.user.create({
    data: {
      email: `batcher-${crypto.randomUUID()}@test.local`,
      name: "Batcher Characterization User",
      telegramChatId: "1",
      timezone: "UTC",
    },
  });
  return prisma.monitor.create({
    data: {
      userId: user.id,
      url: "https://target.test.example.com/probe",
      name: "batcher-monitor",
      status: "UP",
      isActive: true,
      interval: 5,
      lastChecked: new Date(Date.now() - 60_000),
      responseTime: 100,
      uptimePercent: 80,
      totalChecks: 10,
      failedChecks: 2,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  vi.resetModules(); // re-evaluate @/lib/db-batcher on the next dynamic import
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE users, monitors, pings, incidents, feedbacks,
       accounts, sessions, verification_tokens, password_reset_tokens
     RESTART IDENTITY CASCADE`
  );
});

describe("db-batcher — enqueue/flush math + failure-swallow (audit §23.2, FND-06)", () => {
  it(
    "1. aggregation: two queued checks for one monitor flush to 2 ping rows and ONE additive monitor update",
    async () => {
      const m = await seedMonitor(); // totalChecks 10, failedChecks 2
      const { queueRoutineCheck, flushBatches } = await freshBatcher();

      queueRoutineCheck(m.id, "UP", 120);
      queueRoutineCheck(m.id, "UP", 140);
      await flushBatches();

      const pings = await prisma.ping.findMany({
        where: { monitorId: m.id },
        orderBy: { createdAt: "asc" },
      });
      expect(pings).toHaveLength(2); // both queued checks became ping rows
      expect(pings.map((p) => p.responseTime)).toEqual([120, 140]);
      expect(pings.map((p) => p.status)).toEqual(["UP", "UP"]);

      const after = await prisma.monitor.findFirstOrThrow({ where: { id: m.id } });
      expect(after.totalChecks).toBe(12); // 10 + both deltas, ONE update
      expect(after.failedChecks).toBe(2); // UP queues add no failures
    },
    30_000
  );

  it(
    "2. flush math: latest queued status/responseTime win; lastChecked takes the latest queue timestamp",
    async () => {
      const m = await seedMonitor({ responseTime: 999 }); // stale monitor value
      const { queueRoutineCheck, flushBatches } = await freshBatcher();

      const t0 = Date.now();
      queueRoutineCheck(m.id, "UP", 120);
      await new Promise((r) => setTimeout(r, 25)); // distinct queue timestamps
      queueRoutineCheck(m.id, "UP", 140);
      await flushBatches();

      const after = await prisma.monitor.findFirstOrThrow({ where: { id: m.id } });
      expect(after.responseTime).toBe(140); // LATEST queued value wins (not 999, not 120)
      expect(after.status).toBe("UP"); // latest queued status wins
      expect(after.totalChecks).toBe(12);
      // lastChecked = the greatest (latest) queued timestamp, not flush time
      expect(after.lastChecked?.getTime()).toBeGreaterThanOrEqual(t0 + 20);
      expect(after.lastChecked?.getTime()).toBeLessThanOrEqual(Date.now());
    },
    30_000
  );

  it(
    "3. DOWN-counts-as-failure: every queued DOWN increments failedChecks AND totalChecks, and the queued status is written",
    async () => {
      const m = await seedMonitor({ status: "DOWN" }); // totalChecks 10, failedChecks 2
      const { queueRoutineCheck, flushBatches } = await freshBatcher();

      queueRoutineCheck(m.id, "DOWN", 500);
      queueRoutineCheck(m.id, "DOWN", 600);
      await flushBatches();

      const after = await prisma.monitor.findFirstOrThrow({ where: { id: m.id } });
      expect(after.totalChecks).toBe(12); // every queued check counts toward total
      expect(after.failedChecks).toBe(4); // AND each DOWN counts as a failure
      expect(after.status).toBe("DOWN"); // the batcher writes the queued status too
      expect(after.responseTime).toBe(600);
      expect(after.uptimePercent).toBeCloseTo(((12 - 4) / 12) * 100, 6);

      const pings = await prisma.ping.findMany({ where: { monitorId: m.id } });
      expect(pings).toHaveLength(2);
      expect(pings.every((p) => p.status === "DOWN")).toBe(true);
    },
    30_000
  );

  it(
    "4. uptime clamp: the flush UPDATE's Math.max(0, Math.min(100, …)) keeps recomputed uptime at exactly 0 for corrupt counters",
    async () => {
      const m = await seedMonitor({
        totalChecks: 5,
        failedChecks: 10, // corrupt: more failures than checks
        uptimePercent: 0,
      });
      const { queueRoutineCheck, flushBatches } = await freshBatcher();

      queueRoutineCheck(m.id, "UP", 50);
      await flushBatches();

      const after = await prisma.monitor.findFirstOrThrow({ where: { id: m.id } });
      expect(after.totalChecks).toBe(6);
      expect(after.failedChecks).toBe(10);
      // Raw: ((6 - 10) / 6) * 100 = -66.67 → clamped to exactly 0.
      // (The upper clamp at 100 is mathematically unreachable: (t-f)/t ≤ 100.)
      expect(after.uptimePercent).toBe(0);
    },
    30_000
  );

  it(
    "5. failure-swallow (today's defect, pinned verbatim): a failed flush resolves WITHOUT throwing and the whole batch is silently, PERMANENTLY lost",
    async () => {
      const m = await seedMonitor();
      const { queueRoutineCheck, flushBatches } = await freshBatcher();

      // Keep the console.error noise out of the run while still pinning that
      // the failure is logged (the only observable trace of the loss).
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      queueRoutineCheck(m.id, "UP", 120); // a perfectly VALID routine check…
      queueRoutineCheck(999_999, "UP", 999); // …shares the batch with an FK-violating monitorId

      // flushBatches NEVER throws — the catch block swallows the error
      await expect(flushBatches()).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled(); // it is logged, and that is all
      errSpy.mockRestore();

      // The WHOLE batch is lost: createMany is one bulk insert, so the valid
      // ping died with the invalid one — zero ping rows were written
      expect(await prisma.ping.count()).toBe(0);
      // Monitor updates never ran either (createMany threw first)
      const after = await prisma.monitor.findFirstOrThrow({ where: { id: m.id } });
      expect(after.totalChecks).toBe(10);

      // …and the loss is PERMANENT: the queues were snapshotted and cleared
      // BEFORE the write, so a retry flush has nothing left to apply.
      // (Phase 4 replaces this lossy behavior with a guarded flush — this
      // assertion is the red/green marker for that change.)
      await flushBatches();
      expect(await prisma.ping.count()).toBe(0);
      const after2 = await prisma.monitor.findFirstOrThrow({ where: { id: m.id } });
      expect(after2.totalChecks).toBe(10);
    },
    30_000
  );

  it(
    "6. queue cleared: after a successful flush a second flush writes nothing (queues emptied, no double-apply)",
    async () => {
      const m = await seedMonitor();
      const { queueRoutineCheck, flushBatches } = await freshBatcher();

      queueRoutineCheck(m.id, "UP", 120);
      await flushBatches();

      expect(await prisma.ping.count()).toBe(1);
      let after = await prisma.monitor.findFirstOrThrow({ where: { id: m.id } });
      expect(after.totalChecks).toBe(11);

      await flushBatches(); // second flush: nothing queued — no duplicate writes

      expect(await prisma.ping.count()).toBe(1);
      after = await prisma.monitor.findFirstOrThrow({ where: { id: m.id } });
      expect(after.totalChecks).toBe(11); // counters applied exactly once
    },
    30_000
  );

  it(
    "6b. empty flush is a no-op: flushing a fresh module with nothing queued writes nothing",
    async () => {
      await seedMonitor(); // gives the DB something that COULD be written to
      const { flushBatches } = await freshBatcher();

      await expect(flushBatches()).resolves.toBeUndefined();
      expect(await prisma.ping.count()).toBe(0);

      const monitors = await prisma.monitor.findMany();
      expect(monitors).toHaveLength(1);
      expect(monitors[0].totalChecks).toBe(10);
    },
    30_000
  );
});
