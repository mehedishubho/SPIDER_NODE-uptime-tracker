import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Characterization suite: src/lib/cron-logic.ts → runCronChecks (FND-05, 02-03)
//
// Pins TODAY'S behavior — defects included (D-15). Three interventions only;
// everything else runs for real, on the real docker test Postgres:
//   1. vi.mock("@/lib/telegram")  — no real alert can leave the process (T-02-09)
//   2. vi.stubGlobal("fetch")     — the monitored URL is never dialed (T-02-09)
//   3. prisma seeding             — real rows via the @/lib/prisma singleton
//
// runCronChecks is imported and driven AS-IS — no wrapper, no refactor.
// Assertions target actual database rows (specific columns, never whole-row
// snapshots); Telegram calls are asserted by template phrase, not blob.
// Every seed uses fresh (minutes-old) timestamps so the runCleanup side effect
// never eats them (Pitfall 2).
// ---------------------------------------------------------------------------

vi.mock("@/lib/telegram", () => ({
  // The real function POSTs to api.telegram.org — the mock makes alert
  // delivery observable without any network egress.
  sendTelegramAlert: vi.fn().mockResolvedValue(true),
}));

import { sendTelegramAlert } from "@/lib/telegram";
import { prisma } from "@/lib/prisma";
import { runCronChecks } from "@/lib/cron-logic";

const alertSpy = vi.mocked(sendTelegramAlert);
const CHAT_ID = "555000111";

/** 10 minutes ago — overdue for the default 5-minute interval (i.e. due). */
const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);

function okResponse(status = 200): Response {
  return new Response("ok", { status });
}

/** Drains the routine-check queue (the fast path defers writes to db-batcher). */
async function flushBatcher(): Promise<void> {
  const { flushBatches } = await import("@/lib/db-batcher");
  await flushBatches();
}

async function seedUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `cron-${crypto.randomUUID()}@test.local`,
      name: "Cron Characterization User",
      telegramChatId: CHAT_ID, // alert delivery observable in every case
      timezone: "UTC",
    },
  });
  return user.id;
}

interface MonitorSeed {
  url?: string;
  name?: string;
  status?: string;
  isActive?: boolean;
  interval?: number;
  lastChecked?: Date | null;
  responseTime?: number;
  uptimePercent?: number;
  totalChecks?: number;
  failedChecks?: number;
}

async function seedMonitor(userId: string, overrides: MonitorSeed = {}) {
  return prisma.monitor.create({
    data: {
      userId,
      url: "https://target.test.example.com/probe",
      name: "characterized-monitor",
      status: "UP",
      isActive: true,
      interval: 5,
      lastChecked: TEN_MINUTES_AGO(),
      responseTime: 0,
      uptimePercent: 100,
      totalChecks: 0,
      failedChecks: 0,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE users, monitors, pings, incidents, feedbacks,
       accounts, sessions, verification_tokens, password_reset_tokens
     RESTART IDENTITY CASCADE`
  );
  // Default fetch stub: a case that forgets to stub its target fails LOUDLY
  // instead of performing real network egress (T-02-09).
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.reject(
        new Error("UNSTUBBED FETCH — real network egress is forbidden in tests")
      )
    )
  );
});

afterEach(async () => {
  // Drain whatever the fast path queued so module-level batcher state cannot
  // bleed into the next case (Pitfall 3); the next beforeEach truncates.
  await flushBatcher();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("runCronChecks — core transition characterization (audit §23.1, FND-05)", () => {
  it(
    "1. due-time filtering: only monitors past next-due are checked; undue monitors produce no ping",
    async () => {
      const userId = await seedUser();
      const due = await seedMonitor(userId, { name: "overdue" });
      await seedMonitor(userId, {
        name: "freshly-checked",
        lastChecked: new Date(Date.now() - 30_000), // next check due in 4.5 min
      });

      const fetchSpy = vi.fn(async () => okResponse(200));
      vi.stubGlobal("fetch", fetchSpy);

      const ret = await runCronChecks();

      // Return contract: exactly one settled result — for the due monitor
      expect(ret.message).toBe("Successfully checked all monitors");
      expect(ret.result).toHaveLength(1);
      expect(ret.result[0]).toMatchObject({ status: "fulfilled", value: due.id });
      expect(fetchSpy).toHaveBeenCalledTimes(1); // only the due monitor was probed

      // UP→UP is the FAST PATH: the routine check is only queued in memory —
      // zero synchronous database writes (today's in-memory batching, pinned)
      expect(await prisma.ping.count()).toBe(0);

      await flushBatcher();

      const pings = await prisma.ping.findMany();
      expect(pings).toHaveLength(1); // exactly one new ping — the due one
      expect(pings[0].monitorId).toBe(due.id);
      expect(pings[0].status).toBe("UP");
    },
    30_000
  );

  it(
    "2. UP classification: HTTP 200 and the 399 boundary classify UP — ping UP, monitor stays UP, no Telegram",
    async () => {
      const userId = await seedUser();
      const m200 = await seedMonitor(userId, { name: "ok-200" });
      const m399 = await seedMonitor(userId, {
        name: "edge-399",
        url: "https://target.test.example.com/edge-399",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes("edge-399") ? okResponse(399) : okResponse(200)
        )
      );

      await runCronChecks();

      // Fast path (no status change): monitor rows are untouched synchronously
      for (const m of await prisma.monitor.findMany()) {
        expect(m.status).toBe("UP");
        expect(m.totalChecks).toBe(0);
      }

      await flushBatcher();

      const pings = await prisma.ping.findMany();
      expect(pings).toHaveLength(2);
      expect(pings.every((p) => p.status === "UP")).toBe(true);
      expect(new Set(pings.map((p) => p.monitorId))).toEqual(
        new Set([m200.id, m399.id])
      );

      for (const m of await prisma.monitor.findMany()) {
        expect(m.status).toBe("UP"); // monitor stays UP
        expect(m.totalChecks).toBe(1);
        expect(m.failedChecks).toBe(0);
      }
      expect(alertSpy).not.toHaveBeenCalled(); // no transition → no Telegram
    },
    30_000
  );

  it(
    "2b. classification boundary: HTTP 400 is already DOWN (the UP window is 200–399)",
    async () => {
      const userId = await seedUser();
      await seedMonitor(userId);

      vi.stubGlobal("fetch", vi.fn(async () => okResponse(400)));

      await runCronChecks();

      const after = await prisma.monitor.findFirstOrThrow();
      expect(after.status).toBe("DOWN");
      expect(after.failedChecks).toBe(1);
      const incident = await prisma.incident.findFirstOrThrow();
      expect(incident.status).toBe("ONGOING");
      expect(incident.description).toBe("Monitor went down. Status code: 400");
    },
    30_000
  );

  it(
    "3. DOWN classification + 1-strike: UP monitor + HTTP 500 → DOWN on the FIRST failure (no N-strike buffer)",
    async () => {
      const userId = await seedUser();
      await seedMonitor(userId); // status UP, totalChecks 0, failedChecks 0

      vi.stubGlobal("fetch", vi.fn(async () => okResponse(500)));

      await runCronChecks();

      const after = await prisma.monitor.findFirstOrThrow();
      expect(after.status).toBe("DOWN"); // DOWN immediately — first failure
      expect(after.failedChecks).toBe(1); // failedChecks hits 1 on the FIRST strike
      expect(after.totalChecks).toBe(1);

      const ping = await prisma.ping.findFirstOrThrow();
      expect(ping.status).toBe("DOWN");
    },
    30_000
  );

  it(
    "4. PENDING→UP (API-created shape): first UP sends the MONITORING STARTED Telegram message",
    async () => {
      const userId = await seedUser();
      const m = await seedMonitor(userId, { status: "PENDING", lastChecked: null });

      vi.stubGlobal("fetch", vi.fn(async () => okResponse(200)));

      await runCronChecks();

      const after = await prisma.monitor.findFirstOrThrow();
      expect(after.status).toBe("UP");
      expect(after.totalChecks).toBe(1);
      expect(after.failedChecks).toBe(0);
      expect(after.uptimePercent).toBe(100);
      expect(await prisma.ping.count()).toBe(1); // slow path writes synchronously
      expect(await prisma.incident.count()).toBe(0); // first UP opens no incident

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("MONITORING STARTED: Website is Online!")
      );
      expect(alertSpy).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining(m.name)
      );
      expect(alertSpy).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining(m.url)
      );
    },
    30_000
  );

  it(
    "5. UP→DOWN: sends the ALERT message and opens an ONGOING incident whose description embeds the status code",
    async () => {
      const userId = await seedUser();
      await seedMonitor(userId, {
        totalChecks: 10,
        failedChecks: 2,
        uptimePercent: 80,
      });

      vi.stubGlobal("fetch", vi.fn(async () => okResponse(500)));

      await runCronChecks();

      const after = await prisma.monitor.findFirstOrThrow();
      expect(after.status).toBe("DOWN");
      expect(after.totalChecks).toBe(11); // 10 + 1
      expect(after.failedChecks).toBe(3); // 2 + 1
      expect(after.uptimePercent).toBeCloseTo(((11 - 3) / 11) * 100, 6);

      const incident = await prisma.incident.findFirstOrThrow();
      expect(incident.status).toBe("ONGOING");
      expect(incident.resolvedAt).toBeNull();
      expect(incident.description).toBe("Monitor went down. Status code: 500");

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("ALERT: Website Down!")
      );
      expect(alertSpy).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("500")
      );
    },
    30_000
  );

  it(
    "6. DOWN→UP: sends the RECOVERY message and resolves the ONGOING incident",
    async () => {
      const userId = await seedUser();
      const m = await seedMonitor(userId, {
        status: "DOWN",
        totalChecks: 10,
        failedChecks: 2,
      });
      await prisma.incident.create({
        data: {
          monitorId: m.id,
          status: "ONGOING",
          description: "Monitor went down. Status code: 500",
          startedAt: new Date(Date.now() - 5 * 60_000),
        },
      });

      vi.stubGlobal("fetch", vi.fn(async () => okResponse(200)));

      await runCronChecks();

      const after = await prisma.monitor.findFirstOrThrow();
      expect(after.status).toBe("UP");
      expect(after.totalChecks).toBe(11);
      expect(after.failedChecks).toBe(2); // recovery adds no failure
      expect(after.uptimePercent).toBeCloseTo(((11 - 2) / 11) * 100, 6);

      const incident = await prisma.incident.findFirstOrThrow();
      expect(incident.status).toBe("RESOLVED");
      expect(incident.resolvedAt).not.toBeNull();

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("RECOVERY: Website Back Online!")
      );
    },
    30_000
  );

  it(
    "7. UNKNOWN→UP (schema-default shape): first UP sends NO Telegram message — the accidental asymmetry (Pitfall 4)",
    async () => {
      const userId = await seedUser();
      // UNKNOWN is the schema default; only the monitors POST route creates
      // PENDING. Two different first-check behaviors for the same outcome.
      await seedMonitor(userId, { status: "UNKNOWN", lastChecked: null });

      vi.stubGlobal("fetch", vi.fn(async () => okResponse(200)));

      await runCronChecks();

      const after = await prisma.monitor.findFirstOrThrow();
      expect(after.status).toBe("UP"); // still a status CHANGE → slow path…
      expect(after.totalChecks).toBe(1);
      expect(await prisma.ping.count()).toBe(1); // …ping written synchronously
      expect(await prisma.incident.count()).toBe(0);

      // …but no message template matches UNKNOWN as the previous status:
      // PENDING gets "MONITORING STARTED", UNKNOWN gets silence. Pinned as-is.
      expect(alertSpy).not.toHaveBeenCalled();
    },
    30_000
  );

  it(
    "8. full cycle UP→DOWN→UP: one incident opened then resolved; counter deltas correct across both runs",
    async () => {
      const userId = await seedUser();
      const m = await seedMonitor(userId, {
        totalChecks: 10,
        failedChecks: 0,
        uptimePercent: 100,
      });

      // Run 1: UP → DOWN
      vi.stubGlobal("fetch", vi.fn(async () => okResponse(500)));
      await runCronChecks();

      let after = await prisma.monitor.findFirstOrThrow();
      expect(after.status).toBe("DOWN");
      expect(after.totalChecks).toBe(11);
      expect(after.failedChecks).toBe(1);
      expect((await prisma.incident.findMany()).map((i) => i.status)).toEqual([
        "ONGOING",
      ]);

      // Time passes: make the monitor due again without force
      await prisma.monitor.update({
        where: { id: m.id },
        data: { lastChecked: TEN_MINUTES_AGO() },
      });

      // Run 2: DOWN → UP
      vi.stubGlobal("fetch", vi.fn(async () => okResponse(200)));
      await runCronChecks();

      after = await prisma.monitor.findFirstOrThrow();
      expect(after.status).toBe("UP");
      expect(after.totalChecks).toBe(12); // 10 + DOWN run + UP run
      expect(after.failedChecks).toBe(1);
      expect(after.uptimePercent).toBeCloseTo(((12 - 1) / 12) * 100, 6);

      const incidents = await prisma.incident.findMany();
      expect(incidents).toHaveLength(1); // one incident, opened then resolved
      expect(incidents[0].status).toBe("RESOLVED");
      expect(incidents[0].resolvedAt).not.toBeNull();

      const pings = await prisma.ping.findMany({ orderBy: { createdAt: "asc" } });
      expect(pings.map((p) => p.status)).toEqual(["DOWN", "UP"]); // both slow-path writes

      expect(alertSpy).toHaveBeenCalledTimes(2);
      expect(alertSpy).toHaveBeenNthCalledWith(
        1,
        CHAT_ID,
        expect.stringContaining("ALERT: Website Down!")
      );
      expect(alertSpy).toHaveBeenNthCalledWith(
        2,
        CHAT_ID,
        expect.stringContaining("RECOVERY: Website Back Online!")
      );
    },
    30_000
  );
});
