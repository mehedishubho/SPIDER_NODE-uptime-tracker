import { aiEnabled } from "@/lib/ai";
import { Dashboard } from "@/components/Dashboard/Dashboard";

// 08-07 (AI-04): the AI flag crosses to the client tree as a SERVER-READ
// boolean (Pattern 6) — never an env read in client code, never key material
// (T-08-18). force-dynamic evaluates it per REQUEST, so the D-38 flip takes
// effect with a restart and the flag-off default renders zero AI trace
// (D-21).
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return <Dashboard aiEnabled={aiEnabled()} />;
}
