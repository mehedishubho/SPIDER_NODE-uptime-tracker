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
//   1. the session door -> getAuthSession (@/lib/session — the 07-03
//      one-engine swap). The mock is `h.getServerSession` (its historical
//      name from the pre-cutover next-auth generation of the harness, kept so
//      the fixture vocabulary is stable across the cutover).
//   2. @/db -> the ONE Drizzle client (07-08 deletion release, DRZ-07): every
//      route's model access. The seam is a chainable thenable builder
//      (07-03's feedback-test pattern, generalized) — from/innerJoin/where/
//      orderBy/limit/values/set/returning all chain, every terminal await
//      resolves fixture rows, and each builder records its call chain in
//      dbLog so the suites can pin projections, insert values, and update
//      sets by value.
//
// Per-file extra seams (e.g. @/lib/telegram, @/lib/queue-producer, @/lib/ssrf)
// are declared in the test files that need them (D-16 hybrid split); the
// cron-era seams died with the 06-05 deletion release, and the next-auth +
// @/lib/prisma seams died with the 07-08 deletion release.
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

/** One recorded builder method invocation (e.g. values(...), where(...)). */
export interface DbCallRecord {
  method: string;
  args: unknown[];
}

/** One builder = one top-level query the route under test issued. */
export const dbLog: Array<{ op: string; calls: DbCallRecord[] }> = [];

/**
 * Fixture rows the seam resolves. `result` is the default for EVERY query;
 * `results` (when set) is a queue consumed one entry per top-level await, in
 * call order — multi-query routes (details, status, monitors POST) pin
 * per-query fixtures through it. `null` entries resolve [].
 */
export const dbState = {
  result: [] as Array<Record<string, unknown>>,
  results: null as Array<Array<Record<string, unknown>> | null> | null,
};

function makeBuilder(op: string) {
  const calls: DbCallRecord[] = [];
  dbLog.push({ op, calls });
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };
  const builder = {
    from: record("from"),
    innerJoin: record("innerJoin"),
    leftJoin: record("leftJoin"),
    where: record("where"),
    orderBy: record("orderBy"),
    limit: record("limit"),
    offset: record("offset"),
    values: record("values"),
    set: record("set"),
    returning: record("returning"),
    then: (
      resolve: (rows: Array<Record<string, unknown>>) => void,
      reject: (error: unknown) => void,
    ) => {
      const next =
        dbState.results && dbState.results.length > 0
          ? dbState.results.shift()
          : null;
      const rows = next ?? dbState.result;
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return builder;
}

export const h = {
  getServerSession: fn(),
  db: {
    select: vi.fn((..._args: unknown[]) => makeBuilder("select")),
    insert: vi.fn((..._args: unknown[]) => makeBuilder("insert")),
    update: vi.fn((..._args: unknown[]) => makeBuilder("update")),
    delete: vi.fn((..._args: unknown[]) => makeBuilder("delete")),
    execute: fn(),
  },
};

vi.mock("@/db", () => ({ db: h.db }));
// 07-03: the one-engine session door — mockSession(...) drives it.
vi.mock("@/lib/session", () => ({ getAuthSession: h.getServerSession }));

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

/** (Re)sets the shared session-door mock; defaults to unauthenticated. */
export function mockSession(session: unknown = null): void {
  h.getServerSession.mockReset();
  h.getServerSession.mockResolvedValue(session);
}

/** Clears every @/db mock's history + the fixture rows and the call log. */
export function resetDbMocks(): void {
  for (const mock of Object.values(h.db) as Mock[]) {
    // mockReset keeps the ORIGINAL builder-returning implementations (the
    // vi.fn bodies) while wiping history, queued once-implementations, and
    // per-test mockResolvedValue overrides.
    mock.mockReset();
  }
  dbState.result = [];
  dbState.results = null;
  dbLog.length = 0;
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
