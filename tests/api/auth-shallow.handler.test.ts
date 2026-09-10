import { beforeEach, describe, expect, it, vi } from "vitest";
import "./_harness";
import bcrypt from "bcryptjs";
import { buildRequest, h, resetPrismaMocks } from "./_harness";

// ---------------------------------------------------------------------------
// SHALLOW characterization: src/app/api/auth/register/route.ts (POST) —
// validation status codes and the success shape ONLY (D-17). Nothing deeper:
// NextAuth internals are Phase 7's rewrite target and will be deleted, so
// deep contracts here would be wasted effort.
//
// The register route is rate-limited (5/hour per IP, in-memory Map), so this
// file uses the same vi.resetModules() + dynamic-import discipline as
// monitors.handler.test.ts (Pitfall 6). @/lib/mail is mocked (the success
// path would otherwise send a real SMTP email); @/lib/tokens runs against the
// mocked prisma. bcrypt is REAL — the 10-round hash is part of the contract.
// ---------------------------------------------------------------------------

const authMocks = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(),
}));

vi.mock("@/lib/mail", () => ({ sendVerificationEmail: authMocks.sendVerificationEmail }));

beforeEach(() => {
  vi.resetModules(); // fresh @/lib/rate-limit Map per case (Pitfall 6)
  resetPrismaMocks();
  authMocks.sendVerificationEmail.mockReset();
});

async function loadRoute() {
  return import("@/app/api/auth/register/route");
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

    // Verification email sent to the normalized address with the created token.
    expect(authMocks.sendVerificationEmail).toHaveBeenCalledWith(
      "new@user.test",
      "generated-token-value",
    );

    await expect(res.json()).resolves.toEqual({
      message: "User registered. Please check your email to verify your account.",
      user: createdUser,
    });
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
    authMocks.sendVerificationEmail.mockResolvedValue(undefined);

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
