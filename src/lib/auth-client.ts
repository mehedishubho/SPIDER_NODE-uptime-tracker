import { createAuthClient } from "better-auth/react";

// ---------------------------------------------------------------------------
// The SINGLE Better Auth client entry (07-03 Task 3, AUTH-08 invariant).
// basePath defaults to /api/auth — matching the server's basePath pin, so
// no URL configuration is needed (RESEARCH client-swap example).
//
// 07-04 points EVERY client component at this module — nothing else may
// import "better-auth/react" directly (single client source; the deletion
// release's 07-08 gate enforces the invariant alongside the legacy auth
// stack removal). D-33: the client swap is plumbing-only — pages keep their
// exact pixels, error codes map onto the frozen surfaced strings in the
// 07-UI-SPEC Copywriting Contract.
// ---------------------------------------------------------------------------

export const authClient = createAuthClient();

// ---------------------------------------------------------------------------
// The session accessor the swapped components consume (07-04 Task 2). It
// wraps authClient's reactive session hook and returns Better Auth's
// { data, error, isPending, isRefetching, refetch } where data is
// { session, user } | null — user carries id/email/name/image natively from
// the users row. Components derive the legacy three-state shape from
// isPending + data, keeping every existing status check byte-identical.
// Defined HERE so the component tree never references the underlying hook
// by name and better-auth/react keeps exactly one importer (AUTH-08).
// ---------------------------------------------------------------------------
export function useAuthSession() {
  return authClient.useSession();
}
