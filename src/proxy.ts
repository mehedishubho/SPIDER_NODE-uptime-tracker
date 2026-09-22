import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  // Validate the request from the SIGNED session cookie via the Better Auth
  // session API (07-03 Task 2, AUTH-04/A-2). With cookieCache enabled the
  // valid-cache path answers from the cookie itself — no per-request DB hit;
  // revocation lag is bounded at 5 minutes (the accepted policy, T-07-13).
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    const loginUrl = new URL("/login", request.url);
    const callbackPath = request.nextUrl.pathname + request.nextUrl.search;
    loginUrl.searchParams.set("callbackUrl", callbackPath);
    return NextResponse.redirect(loginUrl);
  }

  // If authenticated, allow the request to proceed (proxy it through)
  return NextResponse.next();
}

export const config = {
  // Protect all routes under /dashboard
  matcher: ["/dashboard/:path*"],
};
