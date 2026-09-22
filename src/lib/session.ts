import { headers } from "next/headers";
import { auth } from "@/lib/auth";

// ---------------------------------------------------------------------------
// The ONE server-side session door (07-03 Task 2): every authenticated route
// handler resolves its session through getAuthSession() — never through the
// legacy engine (the rg gate on src/app/api enforces it; authOptions stops
// existing as a server surface in this plan) and never by calling auth.api
// directly with ad-hoc headers.
//
// Shape: { user: { id, email, name, image, role } } | null. `role` comes
// from the admin plugin's role primitive (D-13) seeded on users.role
// (07-01 migration 0002) — it feeds the GET /api/feedback admin gate
// (D-14/R17). Reads ride the engine's cookieCache when the request carries a
// valid cached session (no per-request DB hit; revocation lag bounded at
// 5 min, T-07-13).
//
// next/headers is web-only: route handlers and server components are the
// consumers. 07-05's worker gate (Bull Board) builds its own Headers from
// node:req and calls auth.api.getSession directly instead (D-18).
// ---------------------------------------------------------------------------

/** The session shape every guarded server surface consumes. */
export interface AuthSession {
  user: {
    id: string;
    email: string;
    name: string;
    image: string | null;
    role: string;
  };
}

export async function getAuthSession(): Promise<AuthSession | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  return session as AuthSession;
}
