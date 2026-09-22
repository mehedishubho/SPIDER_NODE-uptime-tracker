import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { Client } from "pg";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// EML-04 behavioral suite (07-03 Task 1): triggering sign-up and
// forget-password through the REAL Better Auth handler enqueues EXACTLY ONE
// email-transactional job each, carrying the framework's prebuilt url in the
// rendered bytes — with the queue as the ONLY outbound seam (zero in-request
// SMTP, 06 D-07; the transport lives in the worker and is unreachable from
// this path by construction: the queue mock below captures the enqueue and
// nothing else exists to call).
//
// Env-pinning discipline (tests/api/auth-shallow.handler.test.ts, the
// suite that characterized the now-deleted legacy routes): the auth
// singleton evaluates at module scope, so BETTER_AUTH_SECRET/BETTER_AUTH_URL
// are pinned BEFORE the dynamic route import.
//
// The enqueue seam: @/lib/queue-producer is mocked with a capturing
// email.add (the injectable-queue precedent of tests/lib/relogin-blast.test.ts)
// — BullMQ is never connected, no Redis queue state is touched. Better
// Auth's OWN secondary storage (rate limiter) DOES use the test Redis via
// @better-auth/redis-storage, so the better-auth:* keyspace is flushed per
// case to keep the 5/h custom rules deterministic across runs.
// ---------------------------------------------------------------------------

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

process.env.BETTER_AUTH_SECRET = `email-hooks-secret-${randomUUID()}-${randomUUID()}`;
process.env.BETTER_AUTH_URL = "https://route.spidernode.test";
// Fake provider credentials: the engine throws when building an authorize
// URL with an undefined client id — these tests prove the QUEUE hooks, not
// the OAuth flow, so deterministic fakes satisfy the socialProviders config.
process.env.GOOGLE_CLIENT_ID = `fake-google-id-${randomUUID()}`;
process.env.GOOGLE_CLIENT_SECRET = `fake-google-secret-${randomUUID()}`;
process.env.GITHUB_CLIENT_ID = `fake-github-id-${randomUUID()}`;
process.env.GITHUB_CLIENT_SECRET = `fake-github-secret-${randomUUID()}`;

// Imported AFTER the env pins + queue mock so the module-scope auth
// singleton evaluates with them pinned.
const { POST } = await import("@/app/api/auth/[...all]/route");

const RUN = randomUUID();
const SIGNUP_EMAIL = `hooks-signup-${RUN}@example.test`;
const RESET_EMAIL = `hooks-reset-${RUN}@example.test`;
const CREDENTIAL_PASSWORD = `credential-pass-${RUN}`;
const CREDENTIAL_HASH = bcrypt.hashSync(CREDENTIAL_PASSWORD, 10);
const ALL_EMAILS = [SIGNUP_EMAIL, RESET_EMAIL];

let pg: Client;
/** Dedicated admin client flushing the engine's own keyspace per case. */
const redisAdmin = new Redis(process.env.REDIS_URL!);

async function flushBetterAuthKeys(): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await redisAdmin.scan(cursor, "MATCH", "better-auth:*", "COUNT", 100);
    if (batch.length > 0) {
      await redisAdmin.del(...batch);
    }
    cursor = next;
  } while (cursor !== "0");
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
});

beforeEach(async () => {
  await flushBetterAuthKeys(); // engine rate-limit state must not leak across cases/runs
  producerMocks.emailAdd.mockClear();
});

afterAll(async () => {
  await redisAdmin.quit().catch(() => {});
  await pg
    .query(`DELETE FROM users WHERE email = ANY($1::text[])`, [ALL_EMAILS])
    .catch(() => {});
  await pg.end().catch(() => {});
});

function apiRequest(path: string, body: unknown): Request {
  return new Request(`https://route.spidernode.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Better Auth email hooks -> the Phase-6 queue (EML-04)", () => {
  it("sign-up enqueues EXACTLY ONE rendered verification email carrying the framework url", async () => {
    const res = await POST(
      apiRequest("/api/auth/sign-up/email", {
        name: "Hooks Signup",
        email: SIGNUP_EMAIL,
        password: "hooks-password-123",
      }),
    );
    expect([200, 201]).toContain(res.status);

    // Exactly one email-transactional enqueue — the ONLY outbound side effect.
    expect(producerMocks.emailAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = producerMocks.emailAdd.mock.calls[0];
    expect(jobName).toBe("send");
    const payload = jobData as { to: string; subject: string; html: string };
    expect(payload.to).toBe(SIGNUP_EMAIL);
    expect(payload.subject).toBe("Confirm your email - SpiderNode");
    // The rendered bytes carry Better Auth's prebuilt url (its API verify
    // endpoint, D-20's link-shape inversion) — never a domain+token rebuild.
    expect(payload.html).toContain(
      "https://route.spidernode.test/api/auth/verify-email?token=",
    );
  });

  it("request-password-reset enqueues EXACTLY ONE rendered reset email carrying the framework url", async () => {
    // Seed a credential user (the D-22 hooks.before guard lets accounts WITH
    // a credential-account password fall through to the normal reset flow).
    await pg.query(
      `INSERT INTO users (id, name, email, "emailVerified", password, timezone, "createdAt", "updatedAt")
       VALUES ($1, 'Hooks Reset', $2, now(), $3, 'UTC', now(), now())`,
      [`hooks-reset-${RUN}`, RESET_EMAIL, CREDENTIAL_HASH],
    );
    await pg.query(
      `INSERT INTO account ("id", "userId", "providerId", "accountId", "password", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'credential', $1, $2, now(), now())`,
      [`hooks-reset-${RUN}`, CREDENTIAL_HASH],
    );

    const res = await POST(
      apiRequest("/api/auth/request-password-reset", {
        email: RESET_EMAIL,
        redirectTo: "/reset-password",
      }),
    );
    expect(res.status).toBe(200);

    expect(producerMocks.emailAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = producerMocks.emailAdd.mock.calls[0];
    expect(jobName).toBe("send");
    const payload = jobData as { to: string; subject: string; html: string };
    expect(payload.to).toBe(RESET_EMAIL);
    expect(payload.subject).toBe("Reset your password - SpiderNode");
    // The engine's reset url (token path segment, D-20 link shape) — and it
    // is the D-21-pinned 1h-TTL token this flow exists to deliver.
    expect(payload.html).toContain(
      "https://route.spidernode.test/api/auth/reset-password/",
    );

    // The unknown-email case stays 200-neutral with ZERO enqueues is engine
    // behavior covered by the D-26/D-22 cutover pins; here the contract is
    // the single enqueue for a real account.
  });
});
