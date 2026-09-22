import { createAuthClient } from "better-auth/react";

// ---------------------------------------------------------------------------
// The SINGLE Better Auth client entry (07-03 Task 3, AUTH-08 invariant).
// basePath defaults to /api/auth — matching the server's basePath pin, so
// no URL configuration is needed (RESEARCH client-swap example).
//
// 07-04 points EVERY client component at this module — nothing else may
// import "better-auth/react" directly (single client source; the deletion
// release's 07-08 gate enforces the invariant alongside the next-auth
// removal). D-33: the client swap is plumbing-only — pages keep their exact
// pixels, error codes map onto the frozen surfaced strings in the
// 07-UI-SPEC Copywriting Contract.
// ---------------------------------------------------------------------------

export const authClient = createAuthClient();
