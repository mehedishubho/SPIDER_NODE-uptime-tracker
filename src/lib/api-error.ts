import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Uniform error-response construction for touched routes (D-32, FND-07).
//
// The wire shape stays byte-identical to the inline form every route uses
// today — NextResponse.json({ error: message }, { status }) — so the 02-05
// characterization pins hold unchanged; construction simply becomes uniform
// and leak-proof by construction (no stack traces, no internals, one place
// to audit). Touched routes only — no full-codebase sweep this phase.
// ---------------------------------------------------------------------------

export function apiError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
