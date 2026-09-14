import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { Client } from "pg";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Resilience-suite harness (plan 04-08 Task 1, D-29/D-30).
//
// spawnWorker() boots the REAL dist/worker.js bundle as a child process with
// env pointing at the exclusively-held 5453/6390 docker test stack, polls
// /readyz to readiness, and exposes a hard-kill (SIGKILL) capability — the
// kill-mid-job case proves the artifact, not a simulation (D-29).
//
// SIGNALS (Pitfall 8): on win32 SIGINT is NOT programmatically deliverable
// to a child; stop() is therefore a hard kill here too, documented as such.
// The graceful-drain HANDLER is proven in tests/worker/shutdown.test.ts and
// the signal-level drain in the 04-09 rehearsal's Linux-container leg.
//
// Fail-loud conventions (scripts/rehearse-migrations.mjs precedent): the
// bundle check refuses with instructions instead of silently skipping; every
// container op shells out with stdio inherit so failures surface verbatim.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKER_BUNDLE = path.join(REPO_ROOT, "dist", "worker.js");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "";

export const DOWN_BOUND_URL = "http://127.0.0.1:9/";

/** What a spawned worker exposes to its case (see spawnWorker). */
export interface WorkerHandle {
  readonly pid: number | undefined;
  /** The bound health port (the case's WORKER_HEALTH_PORT override). */
  readonly healthPort: number;
  /** Captured child stdout+stderr (bounded ring; BACKLOG_DROP/marker checks). */
  stdoutText(): string;
  /** Polls GET /readyz until 200 — fail-loud with the child's tail output. */
  waitReady(timeoutMs?: number): Promise<void>;
  /** GETs a JSON path on the health server (e.g. /metrics.json). */
  curl<T = unknown>(route: string, timeoutMs?: number): Promise<T>;
  /** True once the child has exited (any cause). */
  hasExited(): boolean;
  /** Resolves with the exit code/signal when the child exits. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /**
   * Hard kill (SIGKILL — natively deliverable on Windows, Pitfall 8) and
   * await exit. THE mid-job kill primitive for D-29.
   */
  kill(): Promise<{ code: number | null; signal: string | null }>;
  /**
   * Case teardown stop. Deliberately the same hard kill as kill(): SIGINT
   * cannot be delivered to a child on win32, and teardown does not need the
   * graceful path (proven handler-level in 04-01 + container-level in 04-09).
   */
  stop(): Promise<{ code: number | null; signal: string | null }>;
}

/** Reserves an ephemeral port by binding :0, then releases it for the child. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function getJson(port: number, route: string, timeoutMs: number): Promise<unknown> {
  return fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(timeoutMs) })
    .then((res) => res.json());
}

export async function spawnWorker(
  envOverrides: Record<string, string> = {}
): Promise<WorkerHandle> {
  if (!existsSync(WORKER_BUNDLE)) {
    throw new Error(
      `[resilience] ${WORKER_BUNDLE} not found — the resilience cases drive the REAL ` +
        `worker bundle. Run 'pnpm build' (or 'pnpm test:resilience', whose script ` +
        `rebuilds the bundle via tsup) first. Fail-loud by design: never a silent skip.`
    );
  }
  const healthPort = await freePort();
  const child: ChildProcess = spawn(process.execPath, [WORKER_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Explicit stack pins — dotenv in the child cannot override these.
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      WORKER_HEALTH_PORT: String(healthPort),
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Bounded output ring (~2 MB) for marker assertions and boot diagnostics.
  const chunks: string[] = [];
  let buffered = 0;
  const capture = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    buffered += text.length;
    chunks.push(text);
    while (buffered > 2_000_000 && chunks.length > 1) {
      buffered -= chunks[0].length;
      chunks.shift();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const stdoutText = (): string => chunks.join("");

  const exitInfo = { code: null as number | null, signal: null as string | null };
  let exitedFlag = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exitedFlag = true;
      exitInfo.code = code;
      exitInfo.signal = signal;
      resolve({ ...exitInfo });
    });
  });

  const hardKill = (): Promise<{ code: number | null; signal: string | null }> => {
    if (!exitedFlag) child.kill("SIGKILL");
    return exited;
  };

  const handle: WorkerHandle = {
    pid: child.pid,
    healthPort,
    stdoutText,
    exited,
    hasExited: () => exitedFlag,
    kill: hardKill,
    stop: hardKill,
    async waitReady(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      let lastError = "endpoint never answered";
      while (Date.now() < deadline) {
        if (exitedFlag) {
          throw new Error(
            `[resilience] worker child exited before readyz (code=${exitInfo.code} signal=${exitInfo.signal}). Output tail:\n${stdoutText().slice(-4000)}`
          );
        }
        try {
          const res = await fetch(`http://127.0.0.1:${healthPort}/readyz`, {
            signal: AbortSignal.timeout(1500),
          });
          if (res.status === 200) return;
          lastError = `readyz=${res.status}`;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(
        `[resilience] worker /readyz not ready within ${timeoutMs} ms (last: ${lastError}). Output tail:\n${stdoutText().slice(-4000)}`
      );
    },
    async curl<T = unknown>(route: string, timeoutMs = 5000): Promise<T> {
      return (await getJson(healthPort, route, timeoutMs)) as T;
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Shared case utilities (per-case unique suffixes, raw-SQL seeding, container
// control, queue-key hygiene, polling, D-33 observation capture)
// ---------------------------------------------------------------------------

/** crypto.randomUUID suffix discipline (rate-limit precedent): cases cannot bleed. */
export function caseSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

export async function connectPg(): Promise<Client> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  // When a case stops the db container, every IDLE client's server-side
  // termination (57P01) is emitted as a Client 'error' event — unlistened,
  // that is an uncaught exception (crashes a bare node process; vitest flags
  // the run). These clients are query-only: a dead idle connection surfaces
  // loudly on the next query, so the no-op listener is the correct shield.
  client.on("error", () => {});
  await client.connect();
  return client;
}

export async function connectAdminRedis(): Promise<Redis> {
  return new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
}

export async function seedUser(pg: Client): Promise<string> {
  const result = await pg.query(
    `INSERT INTO users (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
    [`resilience-${caseSuffix()}@example.test`]
  );
  return result.rows[0].id as string;
}

export interface SeedMonitorOptions {
  userId: string;
  url?: string;
  name?: string;
  status?: string;
  interval?: number;
  isActive?: boolean;
  /** Due-slot override: leave undefined for "not due soon". */
  nextCheckAt?: Date | null;
  totalChecks?: number;
  failedChecks?: number;
}

export async function seedMonitor(pg: Client, opts: SeedMonitorOptions): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval,
        "totalChecks", "failedChecks", "updatedAt", next_check_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9) RETURNING id`,
    [
      opts.url ?? DOWN_BOUND_URL,
      opts.name ?? `resilience-${caseSuffix()}`,
      opts.userId,
      opts.status ?? "PENDING",
      opts.isActive ?? true,
      opts.interval ?? 30,
      opts.totalChecks ?? 0,
      opts.failedChecks ?? 0,
      opts.nextCheckAt ?? null,
    ]
  );
  return result.rows[0].id as number;
}

/** docker compose passthrough on the test stack — fail-loud (stdio inherit). */
export function dockerCompose(action: string): void {
  execSync(`docker compose -f docker-compose.test.yml ${action}`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

/** Restores BOTH containers to healthy — the fail-loud finally-block op. */
export function ensureStackUp(): void {
  dockerCompose("up -d --wait");
}

const QUEUE_KEY_PATTERNS = [
  // Glob patterns need the trailing '*' — a bare 'bull:monitor-checks:'
  // matches only a key literally named that (a no-op). The wildcard form
  // clears job hashes AND the wait/prioritized/delayed/active/meta member
  // sets, so a crashed prior run's stale 'active' job cannot leak into the
  // next case's depth reads (found via a leftover check:51 job hash).
  "bull:monitor-scheduler:*",
  "bull:monitor-checks:*",
  "bull:db-writes:*",
  "bull:alerts:*",
  "bull:maintenance:*",
  "bull:email-transactional:*",
  "*stage:*", // matches both stage:{monitorId} and flushstage:{batchId}
  "lock:check:*",
  "alert:*",
];

/** SCAN+DEL hygiene for every bull/staging/lock/dedup key the cases touch. */
export async function flushWorkerKeys(admin: Redis): Promise<void> {
  for (const pattern of QUEUE_KEY_PATTERNS) {
    let cursor = "0";
    do {
      const [next, keys] = await admin.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      if (keys.length > 0) await admin.del(...keys);
    } while (cursor !== "0");
  }
}

/** Shared poll helper — every wait is bounded (T-04-31 fail-loud timeouts). */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
  intervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`[resilience] waitFor timed out after ${timeoutMs} ms: ${label}`);
}

// ---------------------------------------------------------------------------
// D-33 observation capture — the tuning dataset the deploy record cites.
// Cases append per-run measurements here; the file lands at
// tests/resilience/observations.json (sequential files, no write races).
// ---------------------------------------------------------------------------

const OBSERVATIONS_FILE = path.join(REPO_ROOT, "tests", "resilience", "observations.json");

export function recordObservations(
  caseName: string,
  data: Record<string, unknown>
): void {
  let doc: { generatedAt?: string; cases?: Record<string, Array<Record<string, unknown>>> } = {};
  if (existsSync(OBSERVATIONS_FILE)) {
    try {
      doc = JSON.parse(readFileSync(OBSERVATIONS_FILE, "utf8"));
    } catch {
      doc = {};
    }
  }
  doc.cases ??= {};
  doc.cases[caseName] ??= [];
  doc.cases[caseName].push({ ...data, recordedAt: new Date().toISOString() });
  doc.generatedAt = new Date().toISOString();
  writeFileSync(OBSERVATIONS_FILE, JSON.stringify(doc, null, 2) + "\n");
}

export { TEST_DATABASE_URL, TEST_REDIS_URL };
