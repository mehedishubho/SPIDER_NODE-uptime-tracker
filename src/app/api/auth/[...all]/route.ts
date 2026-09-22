import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// The Better Auth catch-all at /api/auth/* (07-01 Task 5) — same path as the
// [...nextauth] route it replaces (research: the provider consoles' callback
// URLs keep working unchanged, basePath pin).
// NOTE: better-auth 1.7.5 ships the Next handler as the "./next-js" export
// (the docs' "better-auth/next" path does not exist at this pin), and
// toNextJsHandler returns a per-VERB handler map — unlike NextAuth()'s single
// function — so the route exports destructure the map instead of re-exporting
// one handler as GET/POST.
export const { GET, POST } = toNextJsHandler(auth);
