import { vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Handler-import harness (02-RESEARCH Pattern 3) — pins the per-route API
// contracts of D-17's scope by importing route handlers directly and invoking
// them with constructed NextRequests.
//
// IMPORT ORDER CONTRACT: this module MUST be the first import of every
// *.handler.test.ts file that uses it:
//
//   import { h, buildRequest, sessionA, ... } from "./_harness";
//   // ... only after the harness import:
//   import { GET } from "@/app/api/monitors/route";
//
// The vi.mock registrations below run when THIS module evaluates, so it must
// come before any route module for the mocks to apply.
//
// Mocks exactly the two seams of the session-guard template (02-PATTERNS):
//   1. next-auth    -> getServerSession (the session guard)
//   2. @/lib/prisma -> prisma           (all model access)
// "next-auth/next" is additionally mocked because feedback/route.ts imports
// getServerSession from that specifier (a separate module id); both share one
// underlying fn so a single mockSession() call covers every route shape.
// Per-file extra seams (e.g. @/lib/telegram) are declared in the test files
// that need them (D-16 hybrid split); the cron-era seams (cron-logic,
// cleanup-logic, db-batcher, mail) died with the 06-05 deletion release.
//
// Mock instances are plain module-scope consts (NOT vi.hoisted — vitest
// forbids exporting hoisted variables). This is safe on two counts:
//   1. vi.mock factories are LAZY — they run on first import of the mocked
//      module, which is always after this module has fully evaluated (the
//      harness is the first import of every test file that uses it).
//   2. Even when a file combines vi.resetModules() with dynamic route imports
//      for @/lib/rate-limit isolation (Pitfall 6), a re-run factory still
//      closes over THIS module instance — the test's `h` references can never
//      diverge from the mocks the route receives.
// ---------------------------------------------------------------------------
const fn = () => vi.fn();

export const h = {
  getServerSession: fn(),
  prisma: {
    monitor: {
      findMany: fn(),
      count: fn(),
      findUnique: fn(),
      findFirst: fn(),
      create: fn(),
      update: fn(),
      delete: fn(),
    },
    user: {
      findUnique: fn(),
      findFirst: fn(),
      update: fn(),
      create: fn(),
    },
    incident: {
      findMany: fn(),
      deleteMany: fn(),
    },
    feedback: {
      create: fn(),
      findMany: fn(),
    },
    ping: {
      deleteMany: fn(),
    },
    verificationToken: {
      findFirst: fn(),
      delete: fn(),
      create: fn(),
    },
    passwordResetToken: {
      findFirst: fn(),
      delete: fn(),
      create: fn(),
    },
  },
};

vi.mock("next-auth", () => ({ getServerSession: h.getServerSession }));
vi.mock("next-auth/next", () => ({ getServerSession: h.getServerSession }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));

// ---------------------------------------------------------------------------
// Session fixtures — two distinct user ids so ownership cases can prove the
// scoping WHERE clause routes by session identity (D-21 mutation target).
// ---------------------------------------------------------------------------

export const USER_A_ID = "11111111-1111-4111-8111-111111111111";
export const USER_B_ID = "22222222-2222-4222-8222-222222222222";

export const sessionA = {
  user: { id: USER_A_ID, name: "User A", email: "user-a@owner.test" },
  expires: "2100-01-01T00:00:00.000Z",
};

export const sessionB = {
  user: { id: USER_B_ID, name: "User B", email: "user-b@owner.test" },
  expires: "2100-01-01T00:00:00.000Z",
};

/**
 * Session where `session.user` exists but `user.id` is missing — pins the
 * WEAKER guard shape (feedback checks `!session || !session.user`, not the
 * id) against the canonical template's `!session?.user?.id`.
 */
export const sessionNoUserId = {
  user: { name: "No Id User", email: "no-id@owner.test" },
  expires: "2100-01-01T00:00:00.000Z",
};

/** (Re)sets the shared getServerSession mock; defaults to unauthenticated. */
export function mockSession(session: unknown = null): void {
  h.getServerSession.mockReset();
  h.getServerSession.mockResolvedValue(session);
}

/** Clears every prisma model fn (implementations + call history). */
export function resetPrismaMocks(): void {
  for (const model of Object.values(h.prisma)) {
    for (const fn of Object.values(model) as Mock[]) {
      fn.mockReset();
    }
  }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

export interface BuildRequestOptions {
  /** Path (with optional query string), e.g. "/api/monitors?page=2". */
  path: string;
  /** HTTP method, default "GET". */
  method?: string;
  /** JSON-serializable body (sets content-type: application/json). */
  body?: unknown;
  /** Value for x-forwarded-for — the rate-limit key input (getIP). */
  ip?: string;
  /** Extra headers (e.g. authorization for the cron Bearer form). */
  headers?: Record<string, string>;
}

/** Builds a NextRequest for direct handler invocation. */
export function buildRequest({
  path,
  method = "GET",
  body,
  ip,
  headers = {},
}: BuildRequestOptions): NextRequest {
  const headerRecord: Record<string, string> = { ...headers };
  if (ip !== undefined) {
    headerRecord["x-forwarded-for"] = ip;
  }
  if (body !== undefined) {
    headerRecord["content-type"] = "application/json";
  }
  // Plain literal (not a DOM RequestInit): next/server's RequestInit is
  // stricter about `signal` nullability than the lib.dom type.
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: headerRecord,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Route context carrying resolved dynamic params, e.g. routeParams({ id: "5" }). */
export function routeParams<T extends Record<string, string>>(
  params: T,
): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}
