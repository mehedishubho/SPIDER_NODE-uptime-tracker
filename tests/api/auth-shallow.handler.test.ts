import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import "./_harness";
import bcrypt from "bcryptjs";
import { buildRequest, h, resetPrismaMocks } from "./_harness";

// ---------------------------------------------------------------------------
// SHALLOW characterization: src/app/api/auth/register/route.ts (POST) plus,
// since 06-02, src/app/api/auth/forgot-password/route.ts (POST) — validation
// status codes and the success shape ONLY (D-17). Nothing deeper: NextAuth
// internals are Phase 7's rewrite target and will be deleted, so deep
// contracts here would be wasted effort.
//
// The register route is rate-limited (5/hour per IP) — REAL, never mocked:
// since Phase 3 (03-01) @/lib/rate-limit is Redis-backed (atomic Lua
// INCR+EXPIRE) against the docker test Redis via REDIS_URL, so limiter state
// now survives module resets. The per-case reset is a flush of the rl:*
// keyspace (SCAN+DEL via the admin client below — never KEYS) in
// beforeEach; vi.resetModules() is RETAINED for the route/prisma mock seams
// (Pitfall 6 / 03-01 Pitfall 3) — same discipline as
// monitors.handler.test.ts.
//
// 06-02: @/lib/mail stays mocked ONLY as a must-NOT-fire tripwire (the
// queue-backed routes must make ZERO direct transport calls); the enqueue
// path goes through @/lib/queue-producer, mocked via producerMocks below —
// the route's pre-flight ping() and the email lane's add() both ride it.
// NEXTAUTH_URL is pinned to a deterministic value because render.ts reads it
// at module scope (render-at-enqueue, D-07).
// ---------------------------------------------------------------------------

const authMocks = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("@/lib/mail", () => ({
  sendVerificationEmail: authMocks.sendVerificationEmail,
  sendPasswordResetEmail: authMocks.sendPasswordResetEmail,
}));

const producerMocks = vi.hoisted(() => ({
  ping: vi.fn(),
  emailAdd: vi.fn(
    async (_name: string, _data: unknown, _opts?: unknown) => ({ id: "email-job-1" })
  ),
}));

vi.mock("@/lib/queue-producer", () => ({
  webQueueProducer: () => ({
    ping: producerMocks.ping,
    email: { add: producerMocks.emailAdd },
    checks: { add: vi.fn() },
    close: async () => {},
  }),
}));

/** Dedicated admin client for the per-case rl:* flush (separate from the limiter's). */
const redisAdmin = new Redis(process.env.REDIS_URL!);

/** Flushes limiter keys on the test Redis — the fresh-state reset per case. */
async function flushLimiterKeys(): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await redisAdmin.scan(cursor, "MATCH", "rl:*", "COUNT", 100);
    if (batch.length > 0) {
      await redisAdmin.del(...batch);
    }
    cursor = next;
  } while (cursor !== "0");
}

afterAll(async () => {
  await redisAdmin.quit();
  // Drop the limiter singleton's socket so the worker process can exit cleanly.
  const globalForRedis = global as unknown as { redis?: Redis };
  globalForRedis.redis?.disconnect();
  delete globalForRedis.redis;
  if (previousNextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL;
  } else {
    process.env.NEXTAUTH_URL = previousNextAuthUrl;
  }
});

// render.ts reads NEXTAUTH_URL at module scope — pin it so rendered links
// are deterministic under vi.resetModules re-evaluations (D-07).
const previousNextAuthUrl = process.env.NEXTAUTH_URL;
process.env.NEXTAUTH_URL = "https://route.spidernode.test";

beforeEach(async () => {
  vi.resetModules(); // fresh route-module registry per case (mock seams — Pitfall 6)
  await flushLimiterKeys(); // limiter state lives in Redis now — flush rl:* per case
  resetPrismaMocks();
  authMocks.sendVerificationEmail.mockReset();
  authMocks.sendPasswordResetEmail.mockReset();
  // Happy-path producer defaults per case; individual cases flip to reject.
  producerMocks.ping.mockReset();
  producerMocks.ping.mockResolvedValue("PONG");
  producerMocks.emailAdd.mockReset();
  producerMocks.emailAdd.mockResolvedValue({ id: "email-job-1" });
});

async function loadRoute() {
  return import("@/app/api/auth/register/route");
}

async function loadForgotRoute() {
  return import("@/app/api/auth/forgot-password/route");
}

describe("POST /api/auth/register (shallow — validation codes only, D-17)", () => {
  it("400 when email or password is missing", async () => {
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: "/api/auth/register", method: "POST", body: {} }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Email and password are required" });
    expect(h.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("400 when the password is shorter than 6 characters", async () => {
    const { POST } = await loadRoute();

    const res = await POST(
      buildRequest({
        path: "/api/auth/register",
        method: "POST",
        body: { email: "short@pw.test", password: "12345" },
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Password must be at least 6 characters long",
    });
  });

  it("409 when the email already exists — looked up LOWERCASED+TRIMMED", async () => {
    h.prisma.user.findUnique.mockResolvedValue({ id: "existing" });

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/auth/register",
        method: "POST",
        body: { email: "  Mix@Case.TEST ", password: "longenough" },
      }),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "An account with this email already exists",
    });
    expect(h.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "mix@case.test" },
    });
    expect(h.prisma.user.create).not.toHaveBeenCalled();
  });

  it("201 on success — normalized email, bcrypt-10 hash, trimmed name, selected user shape, verification email out", async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);
    // createdAt as the ISO string the JSON body actually carries.
    const createdUser = { id: "new-user", name: "New User", email: "new@user.test", image: null, createdAt: "1970-01-01T00:00:00.000Z" };
    h.prisma.user.create.mockResolvedValue(createdUser);
    h.prisma.verificationToken.findFirst.mockResolvedValue(null);
    h.prisma.verificationToken.create.mockResolvedValue({
      id: "vt-1",
      email: "new@user.test",
      token: "generated-token-value",
      expires: new Date(Date.now() + 86_400_000),
    });
    authMocks.sendVerificationEmail.mockResolvedValue(undefined);

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/auth/register",
        method: "POST",
        body: { name: "  New User  ", email: "  NEW@User.test ", password: "longenough" },
      }),
    );

    expect(res.status).toBe(201);

    // The stored user: normalized email, trimmed name, bcrypt-hashed password.
    expect(h.prisma.user.create).toHaveBeenCalledTimes(1);
    const createArgs = h.prisma.user.create.mock.calls[0][0];
    expect(createArgs.data.email).toBe("new@user.test");
    expect(createArgs.data.name).toBe("New User");
    expect(await bcrypt.compare("longenough", createArgs.data.password)).toBe(true);
    expect(createArgs.select).toEqual({
      id: true,
      name: true,
      email: true,
      image: true,
      createdAt: true,
    });

    // 06-02 (D-07 render-at-enqueue): the verification email is RENDERED at
    // request time and ONE "send" job is enqueued with the rendered payload —
    // zero direct transport calls (Pitfall 7 flip of the old mail pin).
    expect(producerMocks.emailAdd).toHaveBeenCalledTimes(1);
    const [emailJobName, emailJobData] = producerMocks.emailAdd.mock.calls[0];
    expect(emailJobName).toBe("send");
    expect(emailJobData).toMatchObject({
      to: "new@user.test",
      subject: "Confirm your email - SpiderNode",
    });
    expect((emailJobData as { html: string }).html).toContain(
      "https://route.spidernode.test/verify-email?token=generated-token-value"
    );
    expect(authMocks.sendVerificationEmail).not.toHaveBeenCalled();

    await expect(res.json()).resolves.toEqual({
      message: "User registered. Please check your email to verify your account.",
      user: createdUser,
    });
  });

  it("503 when the producer ping rejects — BEFORE prisma.user.create (no stranded account, D-29/Pitfall 6)", async () => {
    producerMocks.ping.mockRejectedValue(new Error("simulated redis unreachable"));
    h.prisma.user.findUnique.mockResolvedValue(null);

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/auth/register",
        method: "POST",
        body: { email: "stranded@user.test", password: "longenough" },
      }),
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Service temporarily unavailable — try again shortly",
    });
    // The durable write NEVER happened — no unverifiable account is stranded.
    expect(h.prisma.user.create).not.toHaveBeenCalled();
    expect(producerMocks.emailAdd).not.toHaveBeenCalled();
  });

  it("503 when enqueue add() rejects AFTER the create (residual race — accepted + documented)", async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);
    h.prisma.user.create.mockResolvedValue({ id: "created-anyway" });
    h.prisma.verificationToken.findFirst.mockResolvedValue(null);
    h.prisma.verificationToken.create.mockResolvedValue({
      email: "race@user.test",
      token: "tok",
      expires: new Date(),
    });
    producerMocks.emailAdd.mockRejectedValue(new Error("redis dropped mid-request"));

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/auth/register",
        method: "POST",
        body: { email: "race@user.test", password: "longenough" },
      }),
    );

    // The user WAS created (the ping passed) — the enqueue failure surfaces
    // as a loud 503, never a silent no-op (D-29).
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Service temporarily unavailable — try again shortly",
    });
    expect(h.prisma.user.create).toHaveBeenCalledTimes(1);
    expect(producerMocks.emailAdd).toHaveBeenCalledTimes(1);
  });

  it("429 when the 5/hour per-IP limiter trips — fires before any validation", async () => {
    const { POST } = await loadRoute();

    const ip = "198.51.100.9";
    for (let i = 1; i <= 5; i++) {
      const res = await POST(
        buildRequest({ path: "/api/auth/register", method: "POST", body: {}, ip }),
      );
      expect(res.status).toBe(400); // limiter pass + missing fields
    }

    const res = await POST(
      buildRequest({ path: "/api/auth/register", method: "POST", body: {}, ip }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    await expect(res.json()).resolves.toEqual({
      error: "Too many registration attempts. Please try again later.",
    });
  });

  it("after a reset (next case), the same IP starts from a clean limiter", async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);
    h.prisma.user.create.mockResolvedValue({ id: "fresh" });
    h.prisma.verificationToken.findFirst.mockResolvedValue(null);
    h.prisma.verificationToken.create.mockResolvedValue({
      email: "fresh@window.test",
      token: "tok",
      expires: new Date(),
    });

    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        path: "/api/auth/register",
        method: "POST",
        ip: "198.51.100.9", // the SAME IP the 429 case exhausted
        body: { email: "fresh@window.test", password: "longenough" },
      }),
    );

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password — 06-02 queue-backed rewrite pins (D-21
// limiter, D-29 503 degradation, 200-neutral anti-enumeration verbatim).
// ---------------------------------------------------------------------------

describe("POST /api/auth/forgot-password (06-02 — limiter + enqueue + 503 degradation)", () => {
  it("400 when email is missing (pre-existing shape, preserved)", async () => {
    const { POST } = await loadForgotRoute();

    const res = await POST(
      buildRequest({ path: "/api/auth/forgot-password", method: "POST", body: {} }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Email is required" });
  });

  it("429 when the 5/hour per-IP limiter trips — fires above the body parse (D-21)", async () => {
    const { POST } = await loadForgotRoute();

    const ip = "198.51.100.77";
    for (let i = 1; i <= 5; i++) {
      const res = await POST(
        buildRequest({ path: "/api/auth/forgot-password", method: "POST", body: {}, ip }),
      );
      expect(res.status).toBe(400); // limiter pass + missing email
    }

    const res = await POST(
      buildRequest({ path: "/api/auth/forgot-password", method: "POST", body: {}, ip }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    await expect(res.json()).resolves.toEqual({
      error: "Too many password reset requests. Please try again later.",
    });
  });

  it("200-neutral VERBATIM when the user does not exist — and ZERO enqueues (anti-enumeration, T-06-02-01)", async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);

    const { POST } = await loadForgotRoute();
    const res = await POST(
      buildRequest({
        path: "/api/auth/forgot-password",
        method: "POST",
        body: { email: "nobody@enumeration.test" },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: "Reset email sent!" });
    expect(producerMocks.emailAdd).not.toHaveBeenCalled();
    expect(h.prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it("200-neutral happy path with exactly ONE enqueued rendered reset email — zero direct mail calls", async () => {
    h.prisma.user.findUnique.mockResolvedValue({ id: "u1", email: "user@forgot.test" });
    h.prisma.passwordResetToken.findFirst.mockResolvedValue(null);
    h.prisma.passwordResetToken.create.mockResolvedValue({
      email: "user@forgot.test",
      token: "reset-token-value",
      expires: new Date(Date.now() + 3_600_000),
    });

    const { POST } = await loadForgotRoute();
    const res = await POST(
      buildRequest({
        path: "/api/auth/forgot-password",
        method: "POST",
        body: { email: "User@Forgot.test " },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: "Reset email sent!" });

    expect(producerMocks.emailAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = producerMocks.emailAdd.mock.calls[0];
    expect(jobName).toBe("send");
    expect(jobData).toMatchObject({
      to: "user@forgot.test",
      subject: "Reset your password - SpiderNode",
    });
    expect((jobData as { html: string }).html).toContain(
      "https://route.spidernode.test/reset-password?token=reset-token-value"
    );
    expect(authMocks.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("503 when the producer ping rejects (Redis down — bounded, loud, D-29)", async () => {
    producerMocks.ping.mockRejectedValue(new Error("simulated redis unreachable"));

    const { POST } = await loadForgotRoute();
    const res = await POST(
      buildRequest({
        path: "/api/auth/forgot-password",
        method: "POST",
        body: { email: "who@knows.test" },
      }),
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Service temporarily unavailable — try again shortly",
    });
    expect(producerMocks.emailAdd).not.toHaveBeenCalled();
  });
});
