import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type Redis from "ioredis";
import { workerConnection } from "./connection";
import { workerPgPool } from "./db";

// ---------------------------------------------------------------------------
// Worker health surface (WRK-08, D-13) — loopback HTTP on WORKER_HEALTH_PORT
// (default 9090), node:http only (zero Next imports — the D-08 boundary).
//
// THE TWO-SIGNAL READINESS CONTRACT (01-07): HTTP /readyz is the
// operator/CI gate; process.send('ready') is the PM2 gate (wait_ready).
// They are wired together here — onReady fires ONLY after BOTH boot pings
// (Redis + Postgres) succeed, and index.ts points that callback at the PM2
// signal. Wiring only the HTTP endpoint boot-crash-loops the worker under
// wait_ready after listen_timeout.
//
// Endpoints:
//   GET /healthz      200 — provenance only (D-10): ok, sha, builtAt, uptime.
//   GET /readyz       200 when Redis AND Postgres answer, else 503 — with
//                     per-dependency status in the body.
//   GET /metrics.json 200 — the D-24/D-25 collector seed: provenance plus
//                     Redis memory percent from ONE INFO call, and (when a
//                     queueMetrics provider is registered, 04-02) the queue
//                     section: per-queue depth, head-waiting age, stalled
//                     count, and the backlog drop counter (OBS-01). Later
//                     plans extend the same object further — additive shape.
//
// Security (T-04-01): bound to 127.0.0.1 only; payloads carry
// provenance/status exclusively — no connection strings, tokens, or env
// values. Unauthenticated by design on a dedicated loopback port (T-04-02,
// accepted). Ping clients are injectable so tests can pass failing fakes.
// ---------------------------------------------------------------------------

// Build provenance (D-10) — replaced at bundle time by the tsup define
// block (tsup.config.ts resolves the git SHA there); empty strings under
// tsx dev, where no build step has embedded them yet.
export const WORKER_BUILD_SHA = process.env.WORKER_BUILD_SHA ?? "";
export const WORKER_BUILD_TS = process.env.WORKER_BUILD_TS ?? "";

/**
 * The minimum surface health.ts needs from a pg pool (injectable — tests
 * pass the real worker pool from the docker test stack).
 */
export interface PoolHealthClient {
  query(text: string): Promise<unknown>;
}

export interface ReadinessResult {
  redis: boolean;
  db: boolean;
}

/**
 * Pings both dependencies; never throws — failures map to false. The Redis
 * client is the real ioredis instance type: ioredis 6's overloaded method
 * signatures (callback + promise forms) defeat narrow structural
 * interfaces, and the fail-path tests use real clients pointed at dead
 * ports anyway (same typed-instance approach as the 03-01 A9 precedent).
 */
export async function checkReadiness(
  redis: Pick<Redis, "ping">,
  pool: PoolHealthClient
): Promise<ReadinessResult> {
  const [redisOk, dbOk] = await Promise.all([
    redis.ping().then(
      () => true,
      () => false
    ),
    pool.query("SELECT 1").then(
      () => true,
      () => false
    ),
  ]);
  return { redis: redisOk, db: dbOk };
}

/** Parses an INFO response body (`key:value` lines, `# section` comments). */
function parseInfoSection(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    map.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return map;
}

/** Redis memory snapshot from ONE INFO call (D-25); failures map to nulls. */
async function redisMemorySnapshot(redis: Pick<Redis, "info">) {
  try {
    const info = parseInfoSection(await redis.info("memory"));
    const usedMemoryBytes = Number(info.get("used_memory")) || null;
    const maxMemoryBytes = Number(info.get("maxmemory")) || null;
    const memoryPercent =
      usedMemoryBytes !== null && maxMemoryBytes !== null && maxMemoryBytes > 0
        ? Math.round((usedMemoryBytes / maxMemoryBytes) * 1000) / 10
        : null;
    return { usedMemoryBytes, maxMemoryBytes, memoryPercent };
  } catch {
    return { usedMemoryBytes: null, maxMemoryBytes: null, memoryPercent: null };
  }
}

/** Provenance payload shared by /healthz and /metrics.json (D-10). */
function provenance() {
  return {
    ok: true,
    sha: WORKER_BUILD_SHA,
    builtAt: WORKER_BUILD_TS,
    uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
    pid: process.pid,
  };
}

export interface StartHealthServerOptions {
  /** Defaults to WORKER_HEALTH_PORT, then 9090 (D-13). Pass 0 for ephemeral. */
  port?: number;
  /** Defaults to 127.0.0.1 (T-04-01 — loopback bind, never 0.0.0.0). */
  host?: string;
  /** Defaults to a fresh workerConnection() client (owns it for shutdown). */
  redis?: Redis;
  /** Defaults to the worker pool from src/worker/db.ts. */
  pool?: PoolHealthClient;
  /**
   * Queue-gauge provider for /metrics.json (OBS-01, 04-02): its resolved
   * object's keys are merged into the payload (queues, backlogDrops). A
   * throwing provider degrades to no queue keys — never a 500.
   */
  queueMetrics?: () => Promise<unknown>;
  /** Fired ONCE, only when both boot pings pass (WRK-08 two-signal contract). */
  onReady?: () => void;
}

export interface HealthServer {
  server: Server;
  /** The ACTUAL bound port (supports ephemeral port 0). */
  port: number;
  /** The boot-ping result; onReady fires only on full success. */
  bootReadiness: Promise<ReadinessResult>;
  checkReady(): Promise<ReadinessResult>;
  shutdown(): Promise<void>;
}

export function startHealthServer(options: StartHealthServerOptions = {}): Promise<HealthServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.WORKER_HEALTH_PORT ?? 9090);
  const pool = options.pool ?? workerPgPool;
  // Default client comes from the worker factory (throw-early REDIS_URL);
  // ownership is tracked so shutdown only quits what it created.
  const redis = options.redis ?? workerConnection();
  const ownsRedis = options.redis === undefined;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(provenance()));
      return;
    }
    if (path === "/readyz") {
      const readiness = await checkReadiness(redis, pool);
      const ok = readiness.redis && readiness.db;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok,
          redis: { ok: readiness.redis },
          db: { ok: readiness.db },
        })
      );
      return;
    }
    if (path === "/metrics.json") {
      const memory = await redisMemorySnapshot(redis);
      const body: Record<string, unknown> = { ...provenance(), redis: memory };
      if (options.queueMetrics) {
        const queueSection = await options.queueMetrics().catch(() => null);
        if (queueSection && typeof queueSection === "object") {
          Object.assign(body, queueSection);
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "internal error" }));
      } else {
        res.end();
      }
    });
  });

  return new Promise<HealthServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actualPort = (server.address() as AddressInfo).port;

      // Boot pings + the PM2 ready gate (WRK-08): onReady fires ONLY when
      // both dependencies answer — never on partial or total failure.
      const bootReadiness = checkReadiness(redis, pool).then((result) => {
        if (result.redis && result.db) options.onReady?.();
        return result;
      });

      resolve({
        server,
        port: actualPort,
        bootReadiness,
        checkReady: () => checkReadiness(redis, pool),
        shutdown: async () => {
          await new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
            // Undici keep-alive sockets would otherwise hold the listener
            // open past drain — the health surface has no long-lived
            // connections by design, so force-drop the rest.
            server.closeAllConnections();
          });
          if (ownsRedis) {
            await redis.quit().catch(() => {
              /* already gone — shutdown must stay idempotent */
            });
          }
        },
      });
    });
  });
}
