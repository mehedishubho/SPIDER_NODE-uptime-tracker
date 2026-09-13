import { randomUUID } from "node:crypto";
import IORedis from "ioredis";

// ---------------------------------------------------------------------------
// Per-monitor distributed lock (WRK-04 / audit §15.1 step 2-3/7, J-3).
//
// Scope: this is the APPLICATION lock — a performance guard against duplicate
// concurrent work on the same monitor — deliberately SEPARATE from BullMQ's
// own job lock (lockDuration covers stall detection, not mutual exclusion
// across differently-keyed jobs for the same monitor; Pitfall 5 two-layer
// locking). Correctness never rests on this lock: the J-1 claim, the J-2
// write guards, and the D-1 conditional transition are the correctness
// mechanisms; the lock only keeps two executors from racing on one monitor.
//
// Lifecycle contract (§15.3 pins, non-negotiable formula):
//   - TTL = check timeout (10 s) + margin (5 s) = 15 s default
//   - renewal every TTL/3 (5 s), armed for the ENTIRE job lifetime
//     (fetch + classification + Tier 1 persistence) — never stops at the
//     fetch return, or a legitimately slow §16.1 transaction (up to the 30 s
//     statement_timeout) would outlive the TTL mid-persist
//   - release is OWNER-ONLY via one Lua compare-and-delete (WR-08): a lock
//     you no longer own is never deleted
//   - renewal failure (key missing, value mismatch, Redis error) => the lock
//     may be lost => ABORT: stop writing, discard the classified result,
//     never race a possible new owner (§15.2 lock-lost row)
//
// Lua discipline (03-01 `rlIncr` precedent, one script per atomic op):
// release and renewal are each ONE server-side script — a GET-then-DEL
// client sequence can delete a key a new owner re-acquired between the two
// calls. defineCommand registers the scripts on the worker's lock client;
// ioredis 6 does not surface custom commands on the client type, so calls go
// through the typed view below (same cast as src/lib/rate-limit.ts).
//
// Connection profile: unlike the BullMQ factory (maxRetriesPerRequest: null,
// blocking commands must never time out), the lock client BOUNDS every
// command — J-3's abort-on-loss is only real if a Redis outage surfaces as a
// fast error instead of an infinite retry hang. One retry + 2 s command
// timeout keeps a dead Redis cheap while tolerating a transient blip.
// ---------------------------------------------------------------------------

/** §15.3: TTL = fetch timeout 10 s + margin 5 s (formula non-negotiable). */
export const LOCK_TTL_MS = 15_000;

/** §15.3: renewal cadence TTL/3 — three windows per TTL. */
export const LOCK_RENEWAL_DIVISOR = 3;

/** Lock key namespace: one key per monitor (§13.1 lock row). */
export function lockKey(monitorId: number): string {
  return `lock:check:${monitorId}`;
}

// One atomic op = one Lua script. Both scripts are exported only so the proof
// suite can pin the source form (compare-then-act, never blind DEL/EXPIRE).
export const LOCK_RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export const LOCK_RENEW_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

/** The worker's lock client with the two custom commands on its type. */
export type LockRedis = IORedis & {
  lockRelease(key: string, token: string): Promise<number>;
  lockRenew(key: string, token: string, ttlMs: number): Promise<number>;
};

// globalThis cache (same shape as src/lib/db-pool.ts) so vitest's
// resetModules/re-import discipline can dispose and rebuild the singleton
// between cases, and dev HMR never stacks connections.
const globalForLocks = global as unknown as { workerLocksRedis?: LockRedis };

function createLocksRedis(): LockRedis {
  const connectionString = process.env.REDIS_URL;
  if (!connectionString) {
    throw new Error("Environment variable REDIS_URL is not set");
  }
  const client = new IORedis(connectionString, {
    maxRetriesPerRequest: 1, // bounded — lock ops must fail fast (J-3 abort path)
    commandTimeout: 2000,
    connectTimeout: 1000,
    enableReadyCheck: true,
  });
  // defineCommand at creation, ONCE per instance — module re-evaluations that
  // hit the globalThis cache never re-register. Error listener attached inside
  // the factory so listeners never stack; err.message only (secrets rule).
  client.defineCommand("lockRelease", { numberOfKeys: 1, lua: LOCK_RELEASE_LUA });
  client.defineCommand("lockRenew", { numberOfKeys: 1, lua: LOCK_RENEW_LUA });
  client.on("error", (err) => {
    console.error("[worker-locks] connection error:", err.message);
  });
  return client as LockRedis;
}

/** The worker's lock Redis client (module singleton, lazily connected). */
export function locksRedis(): LockRedis {
  if (!globalForLocks.workerLocksRedis) {
    globalForLocks.workerLocksRedis = createLocksRedis();
  }
  return globalForLocks.workerLocksRedis;
}

/** Disposes the singleton (tests; mirrors rate-limit.test.ts discipline). */
export function disposeLocksRedis(): void {
  if (globalForLocks.workerLocksRedis) {
    globalForLocks.workerLocksRedis.disconnect();
    delete globalForLocks.workerLocksRedis;
  }
}

/** A held per-monitor lock. All methods are owner-scoped to `token`. */
export interface LockHandle {
  readonly monitorId: number;
  readonly key: string;
  readonly token: string;
  readonly ttlMs: number;
  /** Cheap ownership re-check — the Tier 1 pre-commit gate (J-3). */
  isStillOwner(): Promise<boolean>;
  /** Owner-only TTL extension (the same op the renewal timer fires). */
  renew(): Promise<boolean>;
  /** Owner-only release via the Lua compare-and-delete. True when deleted. */
  release(): Promise<boolean>;
}

export interface AcquireLockOptions {
  /** Overrides the §15.3 default TTL (tests inject short TTLs for expiry). */
  ttlMs?: number;
  /** Overrides the client (test injection point). */
  client?: LockRedis;
}

/**
 * Acquires the per-monitor lock via SET NX PX with a fresh crypto.randomUUID
 * owner token. Returns null when the key is already held — another executor
 * owns the monitor; the caller completes the job without executing (§15.1
 * step 2), never retries the acquire in a loop.
 */
export async function acquireMonitorLock(
  monitorId: number,
  options: AcquireLockOptions = {}
): Promise<LockHandle | null> {
  const client = options.client ?? locksRedis();
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error(`acquireMonitorLock: ttlMs must be a positive integer (got ${ttlMs})`);
  }
  const key = lockKey(monitorId);
  const token = randomUUID();
  // "OK" = acquired; null = NX refused (held). One command, atomic.
  const result = await client.set(key, token, "PX", ttlMs, "NX");
  if (result !== "OK") return null;

  return {
    monitorId,
    key,
    token,
    ttlMs,
    async isStillOwner(): Promise<boolean> {
      return isStillOwner(monitorId, token, client);
    },
    async renew(): Promise<boolean> {
      return renewLock(key, token, ttlMs, client);
    },
    async release(): Promise<boolean> {
      return releaseMonitorLock(monitorId, token, client);
    },
  };
}

/**
 * Cheap ownership re-check the processor calls immediately before the Tier 1
 * commit: abort-on-lock-loss (J-3) — if ownership slipped, the executor must
 * NOT write. A plain GET compare; no mutation, so client-side comparison is
 * sufficient here (atomicity belongs to release/renew, not to a read).
 */
export async function isStillOwner(
  monitorId: number,
  token: string,
  client: LockRedis = locksRedis()
): Promise<boolean> {
  const current = await client.get(lockKey(monitorId));
  return current === token;
}

/** Owner-only release: the Lua compare-and-delete. Non-owner is a no-op. */
export async function releaseMonitorLock(
  monitorId: number,
  token: string,
  client: LockRedis = locksRedis()
): Promise<boolean> {
  const deleted = await client.lockRelease(lockKey(monitorId), token);
  return deleted === 1;
}

/** Owner-only TTL extension (compare-and-PEXPIRE, one atomic script). */
async function renewLock(
  key: string,
  token: string,
  ttlMs: number,
  client: LockRedis
): Promise<boolean> {
  const renewed = await client.lockRenew(key, token, ttlMs);
  return renewed === 1;
}

/** Why a renewal stopped — surfaced to the onLoss callback for logging. */
export type LockLossReason = "lock_lost" | "redis_error";

export interface RenewalController {
  /** Stops the renewal timer (call from the job's step-7 finally). */
  stop(): Promise<void>;
  /** True once renewal failed and the timer stopped (J-3 abort signal). */
  readonly lost: boolean;
  /** The loss reason once `lost` is true, null before. */
  readonly lossReason: LockLossReason | null;
}

export interface WithLockRenewalOptions {
  /** Overrides the TTL/3 interval (tests use short real timers). */
  intervalMs?: number;
  /**
   * Invoked exactly once when renewal fails (value mismatch/missing key, or a
   * Redis error) — the processor's abort hook: stop writing, discard the
   * classified result, complete without persisting (§15.2). Never rethrown.
   */
  onLoss?: (reason: LockLossReason, err?: Error) => void;
}

/**
 * Arms the TTL/3 renewal timer for the ENTIRE job lifetime (fetch,
 * classification, Tier 1 persistence — §15.3). Every tick re-extends the TTL
 * ONLY while the stored owner token still matches (compare-and-extend Lua);
 * the moment it does not — or Redis errors — the timer stops, `lost` flips
 * true, and `onLoss` fires. After a loss the lock is never re-acquired here:
 * never race a possible new owner.
 */
export function withLockRenewal(
  handle: LockHandle,
  options: WithLockRenewalOptions = {}
): RenewalController {
  const intervalMs =
    options.intervalMs ?? Math.max(1, Math.floor(handle.ttlMs / LOCK_RENEWAL_DIVISOR));

  const state: { lost: boolean; reason: LockLossReason | null; timer: NodeJS.Timeout | null } = {
    lost: false,
    reason: null,
    timer: null,
  };

  const fail = (reason: LockLossReason, err?: Error) => {
    if (state.lost) return;
    state.lost = true;
    state.reason = reason;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    try {
      options.onLoss?.(reason, err);
    } catch {
      // onLoss is an observability hook — its failure must never mask the loss.
    }
  };

  state.timer = setInterval(() => {
    handle
      .renew()
      .then((renewed) => {
        if (!renewed) fail("lock_lost");
      })
      .catch((err: Error) => fail("redis_error", err));
  }, intervalMs);
  // The renewal timer must never hold the process open on its own.
  state.timer.unref?.();

  return {
    stop(): Promise<void> {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      return Promise.resolve();
    },
    get lost() {
      return state.lost;
    },
    get lossReason() {
      return state.reason;
    },
  };
}
