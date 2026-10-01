import { aiEnabled } from "@/lib/ai";
import { MonitorDetails } from "@/components/Dashboard/MonitorDetails";

// 08-07 (AI-03): the AI flag crosses to the client tree as a SERVER-READ
// boolean (Pattern 6) — never an env read in client code, never key material
// (T-08-18). The page is force-dynamic so the boolean evaluates per REQUEST,
// not at build time: the D-38 flip (AI_ENABLED in the env) takes effect with
// a process restart, never a rebuild, and the flag-off default renders zero
// AI trace (D-21).
export const dynamic = "force-dynamic";

export default function MonitorDetailsPage() {
  return <MonitorDetails aiEnabled={aiEnabled()} />;
}
