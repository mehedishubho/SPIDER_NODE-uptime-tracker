import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { Writable } from "node:stream";
import { Client } from "pg";
import Redis from "ioredis";
import bcrypt from "bcryptjs";
import pino from "pino";

// ---------------------------------------------------------------------------
// Bull Board gate-matrix suite (OBS-04/SEC-04, 07-05 Task 3) against the REAL
// docker test stack (Redis :6390 / Postgres :5453) — health.test.ts harness
// discipline: ephemeral ports, owned-client teardown, no behavior mocks. The
// ONLY mocked module is the web queue producer (tracer precedent — sign-ins
// never enqueue, so the mock is inert).
//
// The gate chain under proof (order enforced, D-17/D-18/D-19):
//   Gate 1: socket-source IP allowlist (health.ts) — keyed on
//           req.socket.remoteAddress ONLY (T-07-18: a spoofed
//           forwarded-for header never grants access).
//   Gate 2: Better Auth admin session (bull-board.ts, the SAME createAuth()
//           instance — A2) — session.user.role === "admin" (D-13).
//   Every hit (allowed or refused) emits the D-16 structured line
//   (userId, route, ip, timestamp); refusals are answered by OUR server
//   code, never by Bull Board (T-07-20); mutation verbs (POST) reach the
//   mount (D-19 — the delegation sits before health.ts's GET/HEAD 405).
//   Per-path source gating (T-07-19/Pitfall 8): on a non-loopback bind
//   (host "::" here), healthz answers LOOPBACK sources only while
//   /admin/queues answers its allowlisted sources — same port, per path.
// ---------------------------------------------------------------------------

// Env pins BEFORE the auth/route imports (tracer precedent — the module-scope
// auth singleton evaluates with them pinned; NODE_ENV=test never trips the
// production throw-early gate).
process.env.BETTER_AUTH_SECRET = `bullboard-secret-${randomUUID()}-${randomUUID()}`;
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.GOOGLE_CLIENT_ID = `fake-google-id-${randomUUID()}`;
process.env.GOOGLE_CLIENT_SECRET = `fake-google-secret-${randomUUID()}`;
process.env.GITHUB_CLIENT_ID = `fake-github-id-${randomUUID()}`;
process.env.GITHUB_CLIENT_SECRET = `fake-github-secret-${randomUUID()}`;

const producerMocks = vi.hoisted(() => ({
  emailAdd: vi.fn(async (_name: string, _data: unknown, _opts?: unknown) => ({
    id: "email-job-1",
  })),
}));

vi.mock("@/lib/queue-producer", () => ({
  webQueueProducer: () => ({
    ping: vi.fn(async () => "PONG"),
    email: { add: producerMocks.emailAdd },
    checks: { add: vi.fn() },
    close: async () => {},
  }),
}));

// Imported AFTER the env pins. The catch-all POST mints REAL sessions; the
// health server + handler + allowlist are the real surfaces under test.
const { POST } = await import("@/app/api/auth/[...all]/route");
const { startHealthServer } = await import("@/worker/health");
const { createBullBoardHandler } = await import("@/worker/bull-board");
const { parseIpAllowlist } = await import("@/lib/ip-allowlist");
const { auth } = await import("@/lib/auth");
const { createWorkerQueues } = await import("@/worker/queues");
const { workerPgPool } = await import("@/worker/db");

const RUN = randomUUID();
const PASSWORD = `gate-password-${RUN}`;
const ADMIN_ID = `gate-admin-${RUN}`;
const USER_ID = `gate-user-${RUN}`;
const ADMIN_EMAIL = `gate-admin-${RUN}@example.test`;
const USER_EMAIL = `gate-user-${RUN}@example.test`;
const ALL_IDS = [ADMIN_ID, USER_ID];

let pg: Client;
let gated: Awaited<ReturnType<typeof startHealthServer>>;
let emptyList: Awaited<ReturnType<typeof startHealthServer>>;
let queues: Awaited<ReturnType<typeof createWorkerQueues>> | undefined;
/** The non-loopback IPv4 source that ANSWERED (probe-picked in beforeAll). */
let nonLoopbackIp = "";
let adminCookie = "";
let userCookie = "";
let allowedHtml = "";

const redisAdmin = new Redis(process.env.REDIS_URL!);
const createdClients: Redis[] = [];
function trackClient(client: Redis): Redis {
  createdClients.push(client);
  return client;
}

/** Every non-127.0.0.1 IPv4 of this host, non-internal first (T-07-19 source). */
function nonLoopbackCandidates(): string[] {
  const internal: string[] = [];
  const external: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.address.startsWith("127.")) continue;
      if (addr.internal) internal.push(addr.address);
      else external.push(addr.address);
    }
  }
  const candidates = [...external, ...internal];
  if (candidates.length === 0) {
    throw new Error(
      "no non-loopback IPv4 on this host — the T-07-19 per-path gating cases cannot run"
    );
  }
  return candidates;
}

/** True when the address yields ANY HTTP answer (connectivity, not status). */
async function answers(ip: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${ip}:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false; // refused/filtered/firewalled — try the next candidate
  }
}

async function seedGateUser(
  id: string,
  email: string,
  role: "admin" | "user"
): Promise<void> {
  const hash = bcrypt.hashSync(PASSWORD, 10);
  await pg.query(
    `INSERT INTO users (id, name, email, "emailVerified", password, role, timezone, "createdAt", "updatedAt")
     VALUES ($1, 'Gate User', $2, '2026-03-01 09:00:00.000', $3, $4, 'UTC', now(), now())`,
    [id, email, hash, role]
  );
  // 0002 semantics: the credential account row beside users.password.
  await pg.query(
    `INSERT INTO account ("id", "userId", "providerId", "accountId", "password", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, 'credential', $1, $2, now(), now())`,
    [id, hash]
  );
  await pg.query(`UPDATE users SET "email_verified" = true WHERE id = $1`, [id]);
}

/** One real sign-in through the catch-all — returns the Cookie header value. */
async function signInCookie(email: string, ip: string): Promise<string> {
  const res = await POST(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  );
  expect(res.status).toBe(200);
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = headers.getSetCookie?.() ?? [];
  const cookies = list
    .map((cookie) => cookie.split(";")[0])
    .filter((cookie) => cookie.startsWith("better-auth."));
  expect(cookies.length).toBeGreaterThan(0);
  return cookies.join("; ");
}

async function flushBetterAuthKeys(): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await redisAdmin.scan(cursor, "MATCH", "better-auth:*", "COUNT", 100);
    if (batch.length > 0) await redisAdmin.del(...batch);
    cursor = next;
  } while (cursor !== "0");
}

/**
 * A pino instance writing into an in-memory capture (the handler's
 * `logger` injection seam) — the D-16 audit stream is asserted from here
 * deterministically (pino's default stdout destination bypasses a
 * process.stdout spy depending on when the logger was constructed).
 */
function makeCaptureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { logger: pino({ level: "info" }, stream), lines: parseLines(chunks) };
}

function parseLines(chunks: string[]): () => Record<string, unknown>[] {
  return () =>
    chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Waits until the predicate holds (pino's buffered stdout flush is async). */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The handler's D-16 audit capture (injected logger seam — see beforeAll). */
let auditLines: () => Record<string, unknown>[] = () => [];

beforeEach(async () => {
  await flushBetterAuthKeys();
});

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  await flushBetterAuthKeys();
  await seedGateUser(ADMIN_ID, ADMIN_EMAIL, "admin");
  await seedGateUser(USER_ID, USER_EMAIL, "user");

  // Real sessions minted through the real handler (unique limiter IPs).
  adminCookie = await signInCookie(ADMIN_EMAIL, "203.0.113.101");
  userCookie = await signInCookie(USER_EMAIL, "203.0.113.102");

  // The worker's REAL queue set — Bull Board adapters wrap these lanes; the
  // shared producer connection rides the test Redis (owned-client teardown).
  const connection = trackClient(new Redis(process.env.REDIS_URL!));
  queues = createWorkerQueues(connection);

  // The gate-2 handler over the shared auth instance (A2); its pino child
  // logger is INJECTED so the whole D-16 audit stream (Gate 1 refusals
  // included, via refuseAndAudit) is capturable deterministically.
  const auditCapture = makeCaptureLogger();
  auditLines = auditCapture.lines;
  const handler = createBullBoardHandler(queues, { auth, logger: auditCapture.logger });

  // Pick a non-loopback source that ANSWERS (LAN first, TEST-NET alias
  // fallback — a firewalled candidate yields no answer and is skipped).
  const candidates = nonLoopbackCandidates();

  // Server A: the NON-loopback bind (host "::" — dual-stack, Pitfall-8 flip
  // configuration). Allowlist = loopback + every candidate (the probe picks
  // one that answers; it is allowlisted by construction).
  gated = await startHealthServer({
    port: 0,
    host: "::",
    redis: trackClient(new Redis(process.env.REDIS_URL!)),
    pool: workerPgPool,
    bullBoardHandler: handler,
    allowlist: parseIpAllowlist(["127.0.0.1", ...candidates].join(",")),
  });
  for (const candidate of candidates) {
    if (await answers(candidate, gated.port)) {
      nonLoopbackIp = candidate;
      break;
    }
  }
  expect(nonLoopbackIp).not.toBe("");

  // Server B: same handler, EMPTY allowlist — the fail-closed default.
  emptyList = await startHealthServer({
    port: 0,
    host: "127.0.0.1",
    redis: trackClient(new Redis(process.env.REDIS_URL!)),
    pool: workerPgPool,
    bullBoardHandler: handler,
    allowlist: parseIpAllowlist(undefined),
  });
});

afterAll(async () => {
  await gated?.shutdown().catch(() => {});
  await emptyList?.shutdown().catch(() => {});
  await queues?.close().catch(() => {});
  for (const client of createdClients) await client.quit().catch(() => {});
  await pg
    .query(`DELETE FROM users WHERE id = ANY($1::text[])`, ALL_IDS)
    .catch(() => {});
  await redisAdmin.quit().catch(() => {});
  await pg.end().catch(() => {});
});

const gatedBase = () => `http://127.0.0.1:${gated.port}`;
const gatedV6Base = () => `http://[::1]:${gated.port}`;

describe("Bull Board gate matrix — /admin/queues on the worker health server", () => {
  it("1. allowlisted IPv4 source + valid admin session cookie -> 200 HTML (D-17 then D-13 pass)", async () => {
    const res = await fetch(`${gatedBase()}/admin/queues`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    allowedHtml = await res.text();
    expect(allowedHtml.length).toBeGreaterThan(0);
  });

  it("2. allowlisted source + NON-admin session -> 403 answered by our server, not Bull Board", async () => {
    const res = await fetch(`${gatedBase()}/admin/queues`, {
      headers: { cookie: userCookie },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "forbidden" });
  });

  it("3. non-allowlisted source + admin cookie -> refusal (Gate 1 wins even for admins)", async () => {
    // ::1 is a loopback-address source that is NOT in the allowlist (only
    // 127.0.0.1 + the LAN candidate are) — the gate keys on the SOCKET.
    const res = await fetch(`${gatedV6Base()}/admin/queues`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "forbidden" });
  });

  it("4. EMPTY allowlist refuses EVERYTHING (fail-closed default, D-17)", async () => {
    const admin = await fetch(`http://127.0.0.1:${emptyList.port}/admin/queues`, {
      headers: { cookie: adminCookie },
    });
    expect(admin.status).toBe(403);
    const anonymous = await fetch(`http://127.0.0.1:${emptyList.port}/admin/queues`);
    expect(anonymous.status).toBe(403);
  });

  it("5. a spoofed forwarded-for header on a non-allowlisted socket STILL refuses (T-07-18)", async () => {
    const res = await fetch(`${gatedV6Base()}/admin/queues`, {
      headers: { cookie: adminCookie, "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(403);
  });

  it("6. the D-16 structured line (userId, route, ip, timestamp) fires on allowed AND refused hits", async () => {
    const before = auditLines().length;
    const allowed = await fetch(`${gatedBase()}/admin/queues`, {
      headers: { cookie: adminCookie },
    });
    expect(allowed.status).toBe(200);
    const refusedGate1 = await fetch(`${gatedV6Base()}/admin/queues`, {
      headers: { cookie: adminCookie },
    });
    expect(refusedGate1.status).toBe(403);
    const refusedGate2 = await fetch(`${gatedBase()}/admin/queues`);
    expect(refusedGate2.status).toBe(403);
    // pino's destination flushes asynchronously — poll until the three new
    // audit lines land (the contract under proof is one D-16 line per hit,
    // not the transport's buffering behavior).
    await waitFor(() => auditLines().length >= before + 3);
    const audit = auditLines().slice(before);

    const allowedLine = audit.find((line) => line.allowed === true);
    expect(allowedLine).toBeTruthy();
    expect(allowedLine!.userId).toBe(ADMIN_ID);
    expect(allowedLine!.route).toBe("/admin/queues");
    expect(String(allowedLine!.ip)).toContain("127");
    expect(typeof allowedLine!.timestamp).toBe("string");

    const gate1Line = audit.find((line) => line.reason === "ip_not_allowlisted");
    expect(gate1Line).toBeTruthy();
    expect(gate1Line!.userId).toBe("anonymous");
    expect(gate1Line!.route).toBe("/admin/queues");
    expect(String(gate1Line!.ip)).toContain("::1");
    expect(typeof gate1Line!.timestamp).toBe("string");

    const gate2Line = audit.find((line) => line.reason === "no_session");
    expect(gate2Line).toBeTruthy();
    expect(gate2Line!.userId).toBe("anonymous");
  });

  it("7. per-path source gating on the non-loopback bind (T-07-19): healthz loopback-only, /admin/queues allowlisted", async () => {
    // healthz from a loopback source: unchanged (mapped-normalized loopback).
    const healthzLoopback = await fetch(`${gatedBase()}/healthz`);
    expect(healthzLoopback.status).toBe(200);
    // healthz from the NON-loopback source: refused on the same port.
    const healthzRemote = await fetch(`http://${nonLoopbackIp}:${gated.port}/healthz`);
    expect(healthzRemote.status).toBe(403);
    // /admin/queues from the SAME non-loopback source: allowed (it is in the
    // allowlist) + admin cookie — the per-path split is the Pitfall-8 answer.
    const queuesRemote = await fetch(`http://${nonLoopbackIp}:${gated.port}/admin/queues`, {
      headers: { cookie: adminCookie },
    });
    expect(queuesRemote.status).toBe(200);
    expect(queuesRemote.headers.get("content-type") ?? "").toContain("text/html");
  });

  it("8. the static UI asset path serves through the getRequestListener bridge (A5 proof)", async () => {
    if (!allowedHtml) {
      const res = await fetch(`${gatedBase()}/admin/queues`, {
        headers: { cookie: adminCookie },
      });
      allowedHtml = await res.text();
    }
    // The entry HTML references its assets RELATIVE (static/css/...,
    // static/js/...) and resolves them against <base href="/admin/queues/">.
    const assetRef = allowedHtml.match(/"(static\/(?:css|js)\/[^"']+\.(?:css|js))"/)?.[1];
    expect(assetRef).toBeTruthy();
    // The static assets sit BEHIND the gate chain like every other
    // /admin/queues path — the fetch carries the admin cookie (a browser
    // would send it automatically).
    const asset = await fetch(`${gatedBase()}/admin/queues/${assetRef}`, {
      headers: { cookie: adminCookie },
    });
    expect(asset.status).toBe(200);
    const body = await asset.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("9. mutation verbs reach the mount (D-19): POST is not health.ts's 405 envelope", async () => {
    const res = await fetch(`${gatedBase()}/admin/queues/api/queues`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // Any answer EXCEPT the health server's GET/HEAD-only envelope proves
    // the POST passed the delegation (Bull Board owns the verb now).
    expect(res.status).not.toBe(405);
    const text = await res.text();
    expect(text).not.toContain("method not allowed");
  });
});
