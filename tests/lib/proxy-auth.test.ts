import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Proxy auth contract (07-03 Task 3, AUTH-04/A-2) — mock-the-seam style
// (tests/api/_harness.ts discipline, auth seam instead of session seam):
// @/lib/auth is mocked at auth.api.getSession so the proxy's validation call
// is observed without a Better Auth instance.
//
// Pins (RESEARCH proxy-swap example; matcher verified at src/proxy.ts):
//   1. a request WITH a valid session passes through (NextResponse.next())
//   2. a request WITHOUT one redirects to /login with
//      callbackUrl = pathname + search (D-33/D-03 byte-identical shape)
//   3. getSession receives the REQUEST's headers (cookieCache path — the
//      signed cookie travels; no per-request DB hit by config)
//   4. the exported config still pins matcher ["/dashboard/:path*"]
// ---------------------------------------------------------------------------

const getSessionMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: (args: { headers: Headers }) => getSessionMock(args),
    },
  },
}));

// Imported AFTER the mock registration (vitest hoists vi.mock above imports).
import { proxy, config } from "@/proxy";

function dashboardRequest(path = "/dashboard/monitors?sort=asc"): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

beforeEach(() => {
  getSessionMock.mockReset();
});

describe("src/proxy.ts — Better Auth cookie validation (AUTH-04)", () => {
  it("a valid session passes through — NextResponse.next(), never a redirect", async () => {
    getSessionMock.mockResolvedValue({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "u@x.test", name: "U", role: "user" },
    });

    const request = dashboardRequest();
    const res = await proxy(request);

    // NextResponse.next() — 200-style continuation with NO location header.
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.headers.get("location")).toBeNull();
    // The validation rode the REQUEST's headers (the cookie cache path).
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    const callArg = (getSessionMock as Mock).mock.calls[0][0] as { headers: Headers };
    expect(callArg.headers).toBe(request.headers);
  });

  it("no session redirects to /login with callbackUrl = pathname + search (byte-identical shape)", async () => {
    getSessionMock.mockResolvedValue(null);

    const res = await proxy(dashboardRequest("/dashboard/monitors?sort=asc"));

    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    const loginUrl = new URL(location);
    expect(loginUrl.pathname).toBe("/login");
    expect(loginUrl.searchParams.get("callbackUrl")).toBe("/dashboard/monitors?sort=asc");
  });

  it("a dashboard path without a query carries no callbackUrl separator noise", async () => {
    getSessionMock.mockResolvedValue(null);

    const res = await proxy(dashboardRequest("/dashboard"));

    const loginUrl = new URL(res.headers.get("location") ?? "");
    expect(loginUrl.searchParams.get("callbackUrl")).toBe("/dashboard");
  });

  it("the matcher still pins /dashboard/:path* only", () => {
    expect(config).toEqual({ matcher: ["/dashboard/:path*"] });
  });
});
