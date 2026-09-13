import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  LOCK_RELEASE_LUA,
  LOCK_RENEW_LUA,
  LOCK_TTL_MS,
  acquireMonitorLock,
  disposeLocksRedis,
  isStillOwner,
  lockKey,
  releaseMonitorLock,
  withLockRenewal,
} from "@/worker/locks";

// ---------------------------------------------------------------------------
// Per-monitor lock proof suite (WRK-04 / J-3, audit §15.1 + §15.3) against
// the REAL docker test Redis (:6390 wired by vitest.config.ts) — the Lua
// compare-and-delete, NX exclusion, TTL expiry, and renewal cadence are
// Redis server semantics, only provable on the real engine. ioredis is NEVER
// mocked. Monitor ids are unique per case (crypto.randomUUID-derived) so
// cases cannot bleed into each other through shared keys.
//
// Pins:
//   1. source form — release is ONE compare-and-delete Lua script and
//      renewal is ONE compare-and-extend script (never GET-then-DEL client
//      sequences that can delete a re-acquired key between the calls)
//   2. first acquire wins; a second acquire while held returns null
//   3. release by a NON-owner (wrong token) leaves the key untouched
//   4. release by the owner deletes the key
//   5. TTL expiry permits re-acquisition
//   6. renewal at TTL/3 keeps the lock alive past several raw TTLs
//   7. isStillOwner flips false after a forced DEL (the Tier 1 gate input)
//   8. renewal detects loss (forced DEL) and fires onLoss exactly once
// ---------------------------------------------------------------------------

/** Dedicated admin client for TTL/DEL inspection — separate from the lock's. */
let admin: Redis;

/** Unique monitor id per case so lock keys never collide across cases. */
function freshMonitorId(): number {
  // Positive int derived from a UUID — unique per call, shape-compatible with
  // the serial PK without needing any database.
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return parseInt(hex, 16);
}

/** Waits `ms`, real timers (short TTLs are the injected clock). */
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  admin = new Redis(process.env.REDIS_URL!);
});

afterAll(async () => {
  disposeLocksRedis();
  await admin.quit();
});

describe("per-monitor lock — SET NX EX + owner-only Lua release (WRK-04)", () => {
  it(
    "1. source form: release and renewal are single compare-and-act Lua scripts (03-01 discipline)",
    () => {
      // Release: GET == ARGV[1] gates the DEL — one script, one atomic op.
      expect(LOCK_RELEASE_LUA).toMatch(/redis\.call\("GET", KEYS\[1\]\)\s*==\s*ARGV\[1\]/);
      expect(LOCK_RELEASE_LUA).toContain('redis.call("DEL", KEYS[1])');
      // The DEL is INSIDE the compare branch (an unconditional DEL after a
      // client-side GET compare would be the sequence this lock forbids).
      const releaseLines = LOCK_RELEASE_LUA.split("\n").map((l) => l.trim()).filter(Boolean);
      const delIndex = releaseLines.findIndex((l) => l.startsWith("return redis.call(\"DEL\""));
      const compareIndex = releaseLines.findIndex((l) => l.startsWith("if redis.call(\"GET\""));
      expect(delIndex).toBeGreaterThan(compareIndex);
      expect(delIndex).toBeGreaterThan(-1);

      // Renewal: same discipline, PEXPIRE instead of DEL.
      expect(LOCK_RENEW_LUA).toMatch(/redis\.call\("GET", KEYS\[1\]\)\s*==\s*ARGV\[1\]/);
      expect(LOCK_RENEW_LUA).toContain('redis.call("PEXPIRE", KEYS[1], ARGV[2])');

      // §15.3 defaults: TTL 15 s (10 s timeout + 5 s margin), renewal TTL/3.
      expect(LOCK_TTL_MS).toBe(15_000);
    },
    10_000
  );

  it(
    "2. first acquire wins; a second acquire while held returns null",
    async () => {
      const monitorId = freshMonitorId();
      const key = lockKey(monitorId);

      const handle = await acquireMonitorLock(monitorId);
      expect(handle).not.toBeNull();
      expect(handle!.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      ); // owner token is a UUID
      expect(handle!.ttlMs).toBe(LOCK_TTL_MS);

      // Key exists, carries the owner token, and has a TTL.
      expect(await admin.get(key)).toBe(handle!.token);
      expect(await admin.pttl(key)).toBeGreaterThan(0);

      // Second acquire while held: null — another executor owns the monitor.
      expect(await acquireMonitorLock(monitorId)).toBeNull();

      await handle!.release();
    },
    10_000
  );

  it(
    "3. release by a NON-owner (wrong token) leaves the key",
    async () => {
      const monitorId = freshMonitorId();
      const key = lockKey(monitorId);
      const handle = await acquireMonitorLock(monitorId);
      expect(handle).not.toBeNull();

      const strangerToken = crypto.randomUUID();
      const deleted = await releaseMonitorLock(monitorId, strangerToken);
      expect(deleted).toBe(false); // compare failed — no-op
      expect(await admin.get(key)).toBe(handle!.token); // key survived

      await handle!.release();
    },
    10_000
  );

  it(
    "4. release by the owner deletes the key",
    async () => {
      const monitorId = freshMonitorId();
      const key = lockKey(monitorId);
      const handle = await acquireMonitorLock(monitorId);
      expect(handle).not.toBeNull();

      const deleted = await handle!.release();
      expect(deleted).toBe(true);
      expect(await admin.exists(key)).toBe(0);
      // And the monitor is re-acquirable immediately after the release.
      const reacquired = await acquireMonitorLock(monitorId);
      expect(reacquired).not.toBeNull();
      expect(reacquired!.token).not.toBe(handle!.token); // fresh owner token
      await reacquired!.release();
    },
    10_000
  );

  it(
    "5. TTL expiry permits re-acquisition",
    async () => {
      const monitorId = freshMonitorId();
      const key = lockKey(monitorId);
      const handle = await acquireMonitorLock(monitorId, { ttlMs: 150 });
      expect(handle).not.toBeNull();

      // Without renewal the key dies at the TTL; a new executor may take over.
      await wait(400);
      expect(await admin.exists(key)).toBe(0);
      const reacquired = await acquireMonitorLock(monitorId, { ttlMs: 150 });
      expect(reacquired).not.toBeNull();
      await reacquired!.release();
    },
    10_000
  );

  it(
    "6. renewal at TTL/3 keeps the lock alive past several raw TTLs",
    async () => {
      const monitorId = freshMonitorId();
      const key = lockKey(monitorId);
      const handle = await acquireMonitorLock(monitorId, { ttlMs: 250 });
      expect(handle).not.toBeNull();

      const renewal = withLockRenewal(handle!, { intervalMs: 60 });
      try {
        // 900 ms = 3.6x the raw TTL — only renewal explains survival.
        await wait(900);
        expect(renewal.lost).toBe(false);
        expect(await handle!.isStillOwner()).toBe(true);
        expect(await admin.get(key)).toBe(handle!.token);
      } finally {
        await renewal.stop();
      }

      // After stop() the TTL is no longer extended — the key expires.
      await wait(450);
      expect(await admin.exists(key)).toBe(0);
    },
    10_000
  );

  it(
    "7. isStillOwner flips false after a forced DEL (Tier 1 pre-commit gate input, J-3)",
    async () => {
      const monitorId = freshMonitorId();
      const handle = await acquireMonitorLock(monitorId);
      expect(handle).not.toBeNull();
      expect(await isStillOwner(monitorId, handle!.token)).toBe(true);

      // Simulated ownership loss (expiry / eviction / external delete).
      await admin.del(lockKey(monitorId));
      expect(await isStillOwner(monitorId, handle!.token)).toBe(false);

      // A stranger now owning the key also reads as not-owner for the old token.
      const stranger = await acquireMonitorLock(monitorId);
      expect(stranger).not.toBeNull();
      expect(await isStillOwner(monitorId, handle!.token)).toBe(false);
      expect(await isStillOwner(monitorId, stranger!.token)).toBe(true);
      await stranger!.release();
    },
    10_000
  );

  it(
    "8. renewal detects loss and fires onLoss exactly once (abort-on-lock-loss)",
    async () => {
      const monitorId = freshMonitorId();
      const handle = await acquireMonitorLock(monitorId, { ttlMs: 500 });
      expect(handle).not.toBeNull();

      const losses: Array<{ reason: string; message?: string }> = [];
      const renewal = withLockRenewal(handle!, {
        intervalMs: 60,
        onLoss: (reason, err) => losses.push({ reason, message: err?.message }),
      });

      // Kill ownership mid-renewal; the next tick must observe the mismatch.
      await wait(120);
      await admin.del(lockKey(monitorId));
      await wait(300);

      expect(renewal.lost).toBe(true);
      expect(renewal.lossReason).toBe("lock_lost");
      expect(losses).toHaveLength(1);
      expect(losses[0].reason).toBe("lock_lost");

      // The timer stopped — no further onLoss fires however long we wait.
      await wait(200);
      expect(losses).toHaveLength(1);

      // A late manual renew() also reports not-owner (never re-acquires).
      expect(await handle!.renew()).toBe(false);
      await renewal.stop();
    },
    10_000
  );
});
