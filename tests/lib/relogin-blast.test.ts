import { describe, expect, it, vi } from "vitest";
import {
  enqueueAnnouncementForUsers,
  missingRequiredEnv,
  PROGRESS_LOG_EVERY,
  REQUIRED_ENV,
  runBlast,
} from "../../scripts/send-relogin-blast.mjs";
import { renderAnnouncementEmail } from "@/lib/email/render";
import { enqueueTransactionalEmail } from "@/lib/email/enqueue";

// ---------------------------------------------------------------------------
// Re-login announcement blast fan-out suite (07-02, AUTH-06/D-01/D-04).
//
// The blast script (scripts/send-relogin-blast.mjs — delete-after-use,
// D-05) exports its fan-out seams so THIS suite can prove the operator
// contract WITHOUT Redis: the real render + real enqueueTransactionalEmail
// are wired against a CAPTURED FAKE QUEUE injected through
// enqueue.ts's deps.emailQueue seam (the established injectable-producer
// precedent). Importing the script is side-effect free (main-module guard).
//
// Proven here (plan Task 3):
//   1. N seeded users -> exactly N enqueued jobs; one per user, no dups.
//   2. Never-verified users are included (D-01: ALL registered accounts)
//      and every payload email matches its enumerated user.
//   3. Missing required env aborts fail-loud BEFORE enumeration/enqueue.
//   4. An enqueue rejection propagates — never a silent partial blast.
// ---------------------------------------------------------------------------

// Render input for the REAL announcement render — module scope, fixed value.
process.env.AUTH_FLIP_DATE = "2099-01-01";

/** Seeded recipients: a mix of verified timestamps and never-verified (null). */
const SEED_USERS = [
  { email: "verified-1@blast.test", emailVerified: "2026-01-01 00:00:00.000" },
  { email: "never-verified@blast.test", emailVerified: null },
  { email: "verified-2@blast.test", emailVerified: "2026-02-01 00:00:00.000" },
  { email: "also-never-verified@blast.test", emailVerified: null },
  { email: "verified-3@blast.test", emailVerified: "2026-03-01 00:00:00.000" },
];

/** The queue seam shape the fan-out needs (structural — enqueue.ts's EmailQueueClient). */
type FakeQueue = { add: (name: string, payload: unknown, opts?: unknown) => Promise<unknown> };

/** A captured fake email queue — the EmailQueueClient seam, no Redis. */
function capturedQueue() {
  const added: Array<{ name: string; payload: { to: string; subject: string; html: string }; opts: unknown }> = [];
  const queue: FakeQueue = {
    add: async (name: string, payload: unknown, opts?: unknown) => {
      added.push({ name, payload: payload as { to: string; subject: string; html: string }, opts });
      return { id: `job-${added.length}` };
    },
  };
  const addSpy = vi.fn(queue.add);
  queue.add = addSpy;
  return { queue, added, addSpy };
}

/** Real deps wiring: the app's render + enqueue against the captured queue. */
function blastDeps(queue: FakeQueue) {
  return {
    renderAnnouncementEmail,
    enqueueTransactionalEmail,
    emailQueue: queue,
    log: vi.fn(),
  };
}

/**
 * Env literals for the gate functions — the script reads ONLY the four
 * REQUIRED_ENV names, but its JS signature infers Next's augmented
 * ProcessEnv (NODE_ENV required), so literals pass through this cast.
 */
const envWith = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("relogin blast fan-out (07-02, AUTH-06/D-01 — enqueue seams, no Redis)", () => {
  it("fans out exactly N jobs for N seeded users — one per user, no duplicates", async () => {
    const { queue, added } = capturedQueue();

    const enqueued = await enqueueAnnouncementForUsers(SEED_USERS, blastDeps(queue));

    expect(enqueued).toBe(SEED_USERS.length);
    expect(queue.add).toHaveBeenCalledTimes(SEED_USERS.length);
    const emails = added.map((a) => a.payload.to);
    expect(new Set(emails).size).toBe(SEED_USERS.length);
    // Every job rides the email lane's "send" job name (the enqueue contract).
    for (const a of added) {
      expect(a.name).toBe("send");
    }
  });

  it("includes never-verified users and matches each payload to its enumerated user (D-01)", async () => {
    const { queue, added } = capturedQueue();

    await enqueueAnnouncementForUsers(SEED_USERS, blastDeps(queue));

    const byEmail = new Map(added.map((a) => [a.payload.to, a]));
    // EVERY enumerated user got a job — including the never-verified rows.
    for (const user of SEED_USERS) {
      expect(byEmail.has(user.email)).toBe(true);
    }
    expect(byEmail.has("never-verified@blast.test")).toBe(true);
    expect(byEmail.has("also-never-verified@blast.test")).toBe(true);
    // The payload IS the D-06 announcement (subject pin), rendered per recipient.
    for (const a of added) {
      expect(a.payload.subject).toBe("SpiderNode is moving to a new sign-in system");
      expect(a.payload.html).toContain("The switch happens on");
    }
  });

  it("logs the per-batch progress counter and the final enqueued count", async () => {
    const { queue } = capturedQueue();
    const bigFanout = Array.from({ length: PROGRESS_LOG_EVERY + 20 }, (_, i) => ({
      email: `bulk-${i}@blast.test`,
    }));
    const deps = { ...blastDeps(queue) };

    const enqueued = await enqueueAnnouncementForUsers(bigFanout, deps);

    expect(enqueued).toBe(bigFanout.length);
    const logged = deps.log.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`[blast] progress: ${PROGRESS_LOG_EVERY}/${bigFanout.length} announcement job(s) enqueued`);
    expect(logged).toContain(
      `[blast] fan-out complete: ${bigFanout.length} announcement job(s) enqueued for ${bigFanout.length} registered user(s)`
    );
    // Counts only — a blast log line must never carry an address (T-07-07).
    for (const line of logged) {
      expect(line).not.toContain("@");
    }
  });

  it("missingRequiredEnv lists exactly the unset/empty names", () => {
    expect(missingRequiredEnv(envWith({}))).toEqual([
      "BETTER_AUTH_URL",
      "AUTH_FLIP_DATE",
      "DATABASE_URL",
      "REDIS_URL",
    ]);
    expect(
      missingRequiredEnv(
        envWith({
          BETTER_AUTH_URL: "https://blast.test",
          AUTH_FLIP_DATE: "2099-01-01",
          DATABASE_URL: "postgresql://",
          REDIS_URL: "redis://",
        })
      )
    ).toEqual([]);
    // Empty string counts as missing (fail-loud, never a silent pass).
    expect(missingRequiredEnv(envWith({ BETTER_AUTH_URL: "" }))).toContain("BETTER_AUTH_URL");
    expect(REQUIRED_ENV).toHaveLength(4);
  });

  it("missing required env aborts fail-loud BEFORE enumeration and BEFORE any enqueue", async () => {
    const { queue, added } = capturedQueue();
    const fail = vi.fn((message: string) => {
      throw new Error(`[blast-gate] ${message}`);
    });

    await expect(
      runBlast({
        env: envWith({ BETTER_AUTH_URL: "https://blast.test" }), // AUTH_FLIP_DATE/DATABASE_URL/REDIS_URL missing
        fail,
        listUsers: async () => {
          throw new Error("listUsers must NEVER run when required env is missing");
        },
        ...blastDeps(queue),
      })
    ).rejects.toThrow("AUTH_FLIP_DATE, DATABASE_URL, REDIS_URL");

    expect(fail).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(added).toHaveLength(0);
  });

  it("zero registered users aborts fail-loud — never success on an empty fan-out", async () => {
    const { queue, added } = capturedQueue();
    const fail = vi.fn((message: string) => {
      throw new Error(`[blast-gate] ${message}`);
    });

    await expect(
      runBlast({
        env: envWith({
          BETTER_AUTH_URL: "https://blast.test",
          AUTH_FLIP_DATE: "2099-01-01",
          DATABASE_URL: "postgresql://",
          REDIS_URL: "redis://",
        }),
        fail,
        listUsers: async () => [],
        ...blastDeps(queue),
      })
    ).rejects.toThrow("no registered users");

    expect(fail).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(added).toHaveLength(0);
  });

  it("an enqueue rejection propagates — a partial blast never reports success", async () => {
    const pushed: unknown[] = [];
    const failingQueue: FakeQueue = {
      add: async (name: string, payload: unknown) => {
        pushed.push({ name, payload });
        if (pushed.length === 2) {
          throw new Error("redis dropped mid-blast");
        }
        return { id: `job-${pushed.length}` };
      },
    };

    await expect(
      enqueueAnnouncementForUsers(SEED_USERS, blastDeps(failingQueue))
    ).rejects.toThrow("redis dropped mid-blast");

    expect(pushed).toHaveLength(2);
  });
});
