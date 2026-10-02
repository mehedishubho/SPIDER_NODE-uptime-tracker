# Phase 8: Flagged Capabilities & UI Modernization - Pattern Map

**Mapped:** 2026-09-30
**Files analyzed:** 29 (new + modified, across the three deliverable legs)
**Analogs found:** 26 / 29 (3 have no in-repo analog — streaming response body, AI SDK client hooks, and the alert-dialog primitive itself; all three are covered by RESEARCH.md Patterns 2/3 + the shadcn registry with `src/components/ui/sheet.tsx` as the delivery-verification precedent)

All analog paths below verified git-tracked (`git ls-files` non-empty for every cited path; 31/31 checked).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/ai/index.ts` (new) | service (lib) | request-response | `src/lib/email/index.ts` | exact (env-selected provider, throw-early, cached instance) |
| `src/lib/ai/providers/*.ts` (new, one per provider value) | service (lib) | request-response | `src/lib/email/providers/console.ts` + `smtp.ts` | exact (factory shape; lazy init in smtp.ts) |
| `src/app/api/ai/post-mortem/route.ts` (new) | route/controller | streaming | `src/app/api/monitors/route.ts` (guards) — see No Analog for the stream body | role-match |
| `src/app/api/ai/monitor-assistant/route.ts` (new) | route/controller | streaming | `src/app/api/monitors/route.ts` POST (validation = same create contract) | role-match |
| AI post-mortem inline card component (new, `src/components/Dashboard/`) | component | streaming | `src/components/Dashboard/MonitorDetails.tsx` incident block (lines 271-316) + `src/components/ui/skeleton.tsx` | partial (mount/UI shell analog; streaming hook is SDK) |
| `src/components/Dashboard/Dashboard.tsx` (mod) — assistant input + prefill | component | request-response | itself: Add Modal useState fields (lines 36-39, 757-761) — Pitfall 9: NOT react-hook-form | exact |
| `src/components/Dashboard/MonitorDetails.tsx` (mod) — post-mortem mount + poll abort | component | request-response | itself: 30s interval (lines 82-92); abort analog `Dashboard.tsx` 189-226 | exact |
| `src/db/schema.ts` (mod) — uptime24h/7d/30d columns | model | CRUD | itself: `monitors` table (lines 77-101) — gate-protected formatting | exact |
| `drizzle/0004_*.sql` (new) | migration | batch | `drizzle/0002_better_auth_cutover.sql` (additive `ALTER TABLE ... ADD COLUMN`) | exact |
| `src/worker/maintenance.ts` (mod) — `recompute-windowed-uptime` job | service (worker job) | batch | itself: `processMaintenanceJob` + D-36 SQL (lines 94-134, 355-376) | exact |
| `src/worker/scheduler.ts` (mod) — fifth upsertJobScheduler | config/scheduler | event-driven | itself: `MAINTENANCE_CLEANUP` upsert (lines 41-43, 374-388) | exact |
| `src/components/ui/dialog.tsx` (new, shadcn add) | component | request-response | `src/components/ui/sheet.tsx` (Radix dialog import + hugeicons X swap) | exact (verification precedent) |
| `src/components/ui/alert-dialog.tsx` (new, shadcn add) | component | request-response | `src/components/ui/sheet.tsx` | role-match (primitive is new to the repo) |
| `src/components/form/MyFormSelect.tsx` (mod) — FaChevron→hugeicons | component | — | itself line 4 + hugeicons alias-import convention (`Dashboard.tsx:8`) | exact |
| `src/components/form/MyFormInput.tsx` (mod) — FiEye→hugeicons | component | — | itself line 7 + `sheet.tsx:5` | exact |
| `src/components/dashboardLayout/TeamSwitch.tsx` (mod) — Swal→alert-dialog | component | request-response | itself: Swal.fire at lines 50-68 | exact (the migration site) |
| `src/components/Dashboard/Dashboard.tsx` (mod) — confirm→alert-dialog | component | request-response | itself: `handleDeleteMonitor` line 275 | exact |
| `src/components/Dashboard/TelegramSettings.tsx` (mod) — confirm→alert-dialog | component | request-response | itself: line 101 (same `if (!confirm(...)) return;` shape as Dashboard.tsx:275) | exact |
| `src/components/common/DeleteModal.tsx` (delete — dead file, 100% commented) | — | — | n/a (deletion; referenced by remnant gate) | n/a |
| `package.json` (mod) — dep deletions + verify legs | config | — | itself: scripts.verify chain (line 22); PHASE7 dep-gate precedent | exact |
| `scripts/check-cron-remnants.mjs` (mod) — new remnant legs | utility (gate) | batch | itself: PHASE7_* constants + `PHASE7_ENFORCED` (lines 118-180) | exact |
| `src/app/(dashboardLayout)/dashboard/layout.tsx` (mod) — drop unused Toaster import | config (layout) | — | itself: line 6 (unused import; root `ThemedToaster` at `src/app/layout.tsx:32` is the single mount) | exact |
| `src/components/Dashboard/DashboardStatus.tsx` (mod) — hydration-safe URL | component | request-response | itself: in-render `window` read (lines 58-60); `MonitorDetails.tsx:44-45` `useParams` hydration-safe param source | exact |
| `src/app/globals.css` (mod) — UI-03 token split, `.dark` freeze lift | config (styles) | — | itself: THM-03 same-value token block (lines ~94-110) + `:root`/`.dark` split | exact |
| WR-02 marketing surfaces: `src/components/common/Navbar/**`, `src/components/dashboardLayout/AppHeader.tsx`, `src/components/home/HowItWorks.tsx` (mod) — token-driven light mode | component | — | `globals.css` token vocabulary (replace `text-white`/`bg-slate-950/80`/`text-slate-300` with tokens) | role-match |
| `tests/lib/ai-provider.test.ts` (new) | test | — | `tests/worker/email-provider.test.ts` (selection matrix, resetModules env discipline) | exact |
| `tests/api/ai-*.handler.test.ts` (new) | test | — | `tests/api/_harness.ts` + `tests/api/monitors.handler.test.ts` | exact |
| `tests/worker/windowed-uptime.test.ts` + `maintenance-windowed.test.ts` (new) | test | — | `tests/worker/maintenance.test.ts` (injectable `MaintenanceDeps` db/logger fakes) | exact |
| `.env.example` (mod) — `AI_*` + `WINDOWED_UPTIME_ENABLED` | config | — | itself: `EMAIL_PROVIDER` block (lines 50-62) + `WORKER_SCHEDULER_ENABLED` (lines 93-98) — DEP-05 dated annotations | exact |

## Pattern Assignments

### `src/lib/ai/index.ts` (service, request-response)

**Analog:** `src/lib/email/index.ts` (61 lines — the D-01 mirror target, read in full)

**Selection + throw-early pattern** (`src/lib/email/index.ts:43-61`) — copy this discipline; the AI variant adds the `AI_ENABLED` master gate BEFORE any env read and requires the full triple (unset is never valid, unlike email where unset defaults to smtp):

```typescript
let cachedProvider: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  if (cachedProvider) {
    return cachedProvider;
  }
  const raw = process.env.EMAIL_PROVIDER;
  let provider: EmailProvider;
  if (raw === undefined || raw === "" || raw === "smtp") {
    provider = createSmtpEmailProvider();
  } else if (raw === "console") {
    provider = createConsoleEmailProvider();
  } else {
    throw new Error(
      `[lib/email] unknown EMAIL_PROVIDER '${raw}' — expected 'smtp' or 'console' ` +
        "(D-11 throw-early: unset defaults to smtp; a typo must fail loud, never silently no-op)"
    );
  }
  cachedProvider = provider;
  return provider;
}
```

**Provider-factory module pattern** (`src/lib/email/providers/console.ts:14-24`) — one named factory per provider value, bracketed-prefix structured logging:

```typescript
export function createConsoleEmailProvider(): EmailProvider {
  return {
    name: "console",
    async send(payload: EmailPayload): Promise<void> {
      console.log(
        `[email-console] ${JSON.stringify({ to: payload.to, subject: payload.subject, html: payload.html })}`
      );
    },
  };
}
```

**Lazy-init pattern** (`src/lib/email/providers/smtp.ts:18-34`) — the AI variant builds the `createOpenAICompatible(...)` provider instance lazily/cached, never at import time (no socket/eval on module load).

Header comment style: the banner comment block (email `index.ts:4-20`) documenting the selection table and throw-early lineage is the repo convention — replicate for `lib/ai`.

---

### `src/app/api/ai/post-mortem/route.ts` + `monitor-assistant/route.ts` (route, streaming)

**Analog:** `src/app/api/monitors/route.ts` (149 lines) for the guard chain, validation, and error handling. The streaming response body itself has NO in-repo analog — use RESEARCH.md Pattern 2/3 (`streamText` + `createUIMessageStreamResponse`/`createTextStreamResponse`, AI SDK 7 names: `instructions`, `onEnd`, `stream`).

**Imports pattern** (`src/app/api/monitors/route.ts:1-9`) — drizzle helpers, session door, limiter, api-error, SSRF gate, db, schema; single quotes, no semicolons in this file:

```typescript
import { count, desc, eq } from "drizzle-orm";
import { getAuthSession } from "@/lib/session";
import { NextResponse } from "next/server";
import { rateLimit, getIP } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { assertUrlAllowed, UrlNotAllowedError } from "@/lib/ssrf";
```

**Session guard pattern** (`src/app/api/monitors/route.ts:69-73`) — the AI routes run this FIRST (identity before limiter, per D-08 per-user keys):

```typescript
const session = await getAuthSession();
if (!session?.user?.id) {
  return apiError(401, "Unauthorized");
}
```

**Rate-limit call-site pattern** (`src/app/api/monitors/route.ts:59-67`) — AI variant substitutes `ai_drafts_${session.user.id}` / `ai_assistant_${session.user.id}` (per-USER, not `getIP` — Pitfall 8) and 429 + `Retry-After` from `rl.resetSeconds` (see Shared Patterns):

```typescript
const ip = getIP(req);
const { success, remaining } = await rateLimit(`monitors_${ip}`, { limit: 20, windowMs: 60000 });
if (!success) {
  return NextResponse.json(
    { error: "Too many requests. Please try again later." },
    { status: 429, headers: { "X-RateLimit-Remaining": remaining.toString() } }
  );
}
```

**Input-validation + typed-error pattern** (`src/app/api/monitors/route.ts:101-122`) — try/catch around `new URL(url)`, then the typed-error split (`UrlNotAllowedError` → 400 via `apiError`, infrastructure → rethrow to 500). The post-mortem route's monitor/incident id validation follows the same manual-check + typed-split shape.

**Error-handling wrapper** (`src/app/api/monitors/route.ts:144-147`):

```typescript
} catch (error) {
  console.error("Create Monitor Error", error);
  return apiError(500, "Failed to create monitor");
}
```

**Section-banner convention** (`src/app/api/monitors/route.ts:20-22`) — `// 1. GET ALL MONITORS ... (GET)` banners between handlers.

**Ownership scoping for evidence assembly** — mirror `GET`'s `where(eq(monitors.userId, session.user.id))` (line 33): the post-mortem route must prove `monitor.userId === session.user.id` before touching incidents/pings (IDOR row in RESEARCH Security Domain).

---

### `src/components/Dashboard/Dashboard.tsx` — assistant prefill + dialog/confirm migration + poll abort (mod)

**Analog:** itself. **Pitfall 9 is binding: the Add Monitor form is three useState fields, NOT react-hook-form.**

**Prefill target state** (lines 36-39):

```typescript
// Add Modal State
const [isAddModalOpen, setIsAddModalOpen] = useState(false);
const [newMonitorName, setNewMonitorName] = useState("");
const [newMonitorUrl, setNewMonitorUrl] = useState("");
const [newMonitorInterval, setNewMonitorInterval] = useState(5);
```

**Interval select + setState-by-value** (lines 757-761) — assistant partial-object prefill = guarded `set*` calls (`object.name` defined → `setNewMonitorName(object.name)`, etc. — D-19 partial fill):

```typescript
<select
  value={newMonitorInterval}
  onChange={(e) =>
    setNewMonitorInterval(Number(e.target.value))
  }
```

The assistant schema (interval enum 1/5/10/30/60) mirrors these exact option values (lines 764-768).

**window.confirm site to migrate** (line 275, inside `handleDeleteMonitor`):

```typescript
if (!confirm(`Are you sure you want to delete "${name}"?")) return;
```

**Existing abort discipline to extend to fetchMonitors** (lines 189-226) — the check-now poll already does ref-held AbortController + unmount abort + `aborted` re-check; `fetchMonitors` (line 61: bare `fetch("/api/monitors")` on the 30s `setInterval` at lines 92-96) gains the same `signal` treatment:

```typescript
const checkPollAbortRef = useRef<AbortController | null>(null);
useEffect(() => {
  return () => {
    checkPollAbortRef.current?.abort();
  };
}, []);
```

**Toast pattern** — `toast.error/success/info` from `sonner` (lines 6, 104, 126, 230); 429 Retry-After read at lines 209-212 is the client shape the AI 429s will hit.

**Icon import convention** (line 8) — hugeicons aliased imports in ONE line: `import { Activity01Icon as Activity, ..., Cancel01Icon as X, ... } from "hugeicons-react";`

---

### `src/components/Dashboard/MonitorDetails.tsx` — post-mortem card mount + poll abort (mod)

**Analog:** itself (324 lines, read in full).

**Incident block — the mount point** (lines 271-316): each incident row in `monitor.incidents.map(...)` renders inside `<div className="divide-y divide-slate-800/60">`; the post-mortem inline card mounts under this block (D-12). Evidence shapes already loaded: `Incident` interface (lines 17-23: `id/status/description/startedAt/resolvedAt`), `Ping` (lines 10-15: `id/status/responseTime/createdAt`), monitor identity (`name/url/interval`).

**30s interval to make abort-aware** (lines 82-92):

```typescript
useEffect(() => {
  if (status === "authenticated" && id) {
    fetchDetails();
    const interval = setInterval(() => {
      fetchDetails();
    }, 30000); // 30s refresh
    return () => clearInterval(interval);
  }
}, [status, id, fetchDetails]);
```

**Hydration-safe param source** (lines 44-45): `const params = useParams(); const id = params.id as string;` — no `window` reads.

**Session read** (line 41): `const { data: session, isPending } = useAuthSession();` — the AI UI's session accessor.

**Detail-fetch error ladder** (lines 57-80): 401 → redirect `/login`; 404 → toast + redirect `/dashboard`; else throw → catch → `toast.error` — the pattern the AI inline card's Retry state sits alongside.

---

### `src/db/schema.ts` — per-window columns (mod)

**Analog:** itself — the `monitors` table (lines 77-101). **Gate contract (lines 35-39) is binding:** the file keeps exact `drizzle-kit pull` formatting (single quotes, no semicolons, pull's ordering); only comments may differ freely; the schema:gate leg of `pnpm verify` diffs this file against a normalized pull — coordinate edits with the gate. New nullable `doublePrecision` columns (uptime windows) land in the pull-emitted style beside `uptimePercent` (line 86):

```typescript
uptimePercent: doublePrecision().default(100).notNull(),
totalChecks: integer().default(0).notNull(),
failedChecks: integer().default(0).notNull(),
```

Provenance-comment convention (lines 1-46): the header block records which migration added what — extend it with the 0004 note when adding columns.

### `drizzle/0004_*.sql` (new migration)

**Analog:** `drizzle/0002_better_auth_cutover.sql` (97 lines) — the additive-migration shape: banner comment block stating PURELY ADDITIVE + rollback basis (lines 1-25), then `--> statement-breakpoint`-separated statements. The additive-column form (lines 64-72):

```sql
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;
```

0004 is simpler than 0002 (columns only, no backfills — D-23 backfill happens in the nightly job, not the migration). Pipeline: `drizzle-kit generate` → extend the rehearse-migrations carve-out list → `pnpm rehearse:migrations` → single runner. `drizzle-kit push` FORBIDDEN.

---

### `src/worker/maintenance.ts` — `recompute-windowed-uptime` job (mod)

**Analog:** itself (476 lines, read in full).

**D-36 binary-extraction expression — copy VERBATIM with window-scoped counts substituted** (lines 94-134, `consistencyAuditSql()`): the `CASE WHEN (ratio >= 1) THEN floor(... 4503599627370496 ... half-adder ...) ELSE floor(... 1152921504606846976 ...) END)::double precision / 100.0` form over `("totalChecks" - "failedChecks") / "totalChecks"`. Never `round()` (Pitfall 6 — both suites pin the shipped form). The windowed variant substitutes `count(*) FILTER (WHERE status='DOWN')` and `count(*)` over `pings WHERE "monitorId" = $1 AND "createdAt" >= now() - interval` for the lifetime counters.

**Job-name dispatch to extend** (lines 364-370):

```typescript
if (job.name !== "cleanup") {
  // Loud, never a silent skip — an undeclared maintenance job name is a
  // contract violation (same discipline as the dbWrites lane's dispatcher).
  throw new Error(
    `processMaintenanceJob: unknown maintenance job name '${job.name}' (expected 'cleanup')`
  );
}
```

**Injectable-deps + report pattern** (lines 341-345, 403-418): `MaintenanceDeps { db?, redis?, logger? }` with `deps.db ?? workerDb` defaults; the returned report object (ids/counts only — T-04-28: never URLs or bodies) is what the job log captures. The windowed job's report mirrors this shape.

**Structured pino logging** (lines 421-433, 463-474): one `logger.info({ jobId, ...counts }, "message")` line per mode.

**Batched-write discipline** (lines 307-328, `deleteInBatches`) — relevant precedent if the recompute UPDATE loops monitors in batches; `RETENTION_BATCH = 5000` (line 55) bounds statements under the pool's 30s `statement_timeout`.

**Dry-run/write posture** (line 373): `const dryRun = data.dryRun !== false;` — but D-22 says the recompute runs unconditionally from ship, so its scheduler template carries the write posture (see scheduler pattern below; the manual enqueue script keeps explicit flags per the cleanup precedent).

### `src/worker/scheduler.ts` — fifth upsertJobScheduler (mod)

**Analog:** itself (438 lines, read in full).

**Constants + nightly-pattern precedent** (lines 41-43):

```typescript
export const MAINTENANCE_CLEANUP_SCHEDULER_ID = "maintenance-cleanup";
export const MAINTENANCE_CLEANUP_PATTERN = "15 3 * * *";
```

Add `RECOMPUTE_WINDOWED_SCHEDULER_ID` + its own cron pattern (separated from 03:15 — lane concurrency 1 serializes otherwise; research OQ2 recommends a separated time such as 04:00+ UTC).

**The upsert block to copy** (lines 374-388) — note `data: { dryRun: false }` is the autonomous-write posture precedent D-22's recompute template mirrors:

```typescript
await queues.maintenance.upsertJobScheduler(
  MAINTENANCE_CLEANUP_SCHEDULER_ID,
  { pattern: MAINTENANCE_CLEANUP_PATTERN },
  {
    name: "cleanup",
    data: { dryRun: false },
    opts: {
      priority: LANE_PRIORITY.maintenance,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    },
  }
);
```

Also extend the `upserted` summary array (lines 430-435) with the new scheduler — the flag suite (`tests/worker/scheduler-flag.test.ts`) pins scheduler counts, so update those pins deliberately.

**Lane wiring (no change needed — the lane already consumes):** `src/worker/index.ts:179`: `const maintenanceWorker = startMaintenanceLaneWorker((job) => processMaintenanceJob(job));` — the processor signature stays; extending the accepted-name set inside `processMaintenanceJob` requires no index.ts change. Lane constants: `QUEUE_NAMES.maintenance = "maintenance"` (`src/worker/queues.ts:38`), `LANE_PRIORITY.maintenance: 5` (line 54), lane concurrency 1 (`MAINTENANCE_LANE_CONCURRENCY`, queues.ts:487).

---

### `src/components/ui/dialog.tsx` + `alert-dialog.tsx` (new, shadcn add)

**Analog for delivery verification:** `src/components/ui/sheet.tsx` — the two-trap check after `pnpm dlx shadcn@latest add dialog alert-dialog` (Pitfall 1 + 2). Sheet's imports (lines 1-7) are the target shape — Radix primitive + hugeicons icon swap, NO lucide, NO `@base-ui-components/react`:

```typescript
"use client"

import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { Cancel01Icon as XIcon } from "hugeicons-react";

import { cn } from "@/lib/utils"
```

Also verify Radix idioms (`asChild`, not Base-UI's `render=`) and `data-slot` + `cn(...)` styling convention (sheet.tsx:31-45). `dialog` should reuse `@radix-ui/react-dialog` (already a dependency, package.json:35); `alert-dialog` needs `@radix-ui/react-alert-dialog` (or the `radix-ui` package). File style: no-semicolon in `src/components/ui/*` (matches sheet.tsx).

### Swal/confirm migration sites (3 + dead file)

**Swal site** — `src/components/dashboardLayout/TeamSwitch.tsx:50-68` (the only `sweetalert2` call in the repo):

```typescript
const handleLogoutClick = async () => {
  const result = await Swal.fire({
    title: "Are you sure?",
    text: "Do you want to log out?",
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Log Out",
    cancelButtonText: "Cancel",
    // THM-03: dialog tokens are same-value in both modes — dark rendering unchanged
    confirmButtonColor: "var(--primary)",
    cancelButtonColor: "var(--dialog-muted)",
    background: "var(--dialog-surface)",
    color: "var(--dialog-foreground)",
  });
  if (result.isConfirmed) {
    handleLogout();
  }
};
```

Migration: controlled shadcn `AlertDialog` (open state + onOpenChange, confirm calls `handleLogout()`); keep the token-driven surface intent (`--dialog-surface`/`--dialog-foreground`/`--dialog-muted` tokens already exist in globals.css). Import removal: TeamSwitch.tsx:14 `import Swal from "sweetalert2";`.

**confirm sites** (identical shape, both become alert-dialog with destructive styling):
- `src/components/Dashboard/Dashboard.tsx:275` — `if (!confirm(\`Are you sure you want to delete "${name}"?\`)) return;` at the top of `handleDeleteMonitor`; the DELETE fetch continues only on confirm.
- `src/components/Dashboard/TelegramSettings.tsx:101` — `if (!confirm("Are you sure you want to disconnect Telegram alerts?")) return;`

**Dead file:** `src/components/common/DeleteModal.tsx` — 102 lines, 100% commented out, references the deleted `@/components/ui/dialog` and redux slice; delete it outright (no behavior to preserve).

**Informational popups** (if any beyond these): sonner `toast.*` per the repo's primary toast API (CLAUDE.md Conventions; ~71 usages).

### react-icons migration sites (2 files, dep deleted)

| File:Line | Current | Replacement (verified export, hugeicons-react 0.4.0) |
|---|---|---|
| `src/components/form/MyFormSelect.tsx:4` | `import { FaChevronDown, FaChevronUp } from "react-icons/fa";` | `import { ArrowDown01Icon, ArrowUp01Icon } from "hugeicons-react";` — swap the two default-prop usages at lines 34-35 (`upIcon = <FaChevronUp />`, `downIcon = <FaChevronDown />`) |
| `src/components/form/MyFormInput.tsx:7` | `import { FiEye, FiEyeOff } from "react-icons/fi";` | `import { ViewIcon, ViewOffIcon } from "hugeicons-react";` — swap the password-visibility toggle usages |

Then remove `react-icons` (package.json:61) and `sweetalert2` (package.json:65) with remnant-gate legs (below).

### `scripts/check-cron-remnants.mjs` + `package.json` — remnant-gate extensions (mod)

**Analog:** the script's own Phase-7 extension block (lines 118-201, read this session) — the exact seam D-33/D-34 legs extend:

```javascript
const PHASE7_DELETED_MODULE_BASENAMES = new Set([
  "tokens", "auth-legacy", "authSlice", "send-relogin-blast", "prisma",
]);
const PHASE7_EXACT_SPECIFIERS = new Set(["next-auth", "js-cookie"]);
const PHASE7_SPECIFIER_PREFIXES = ["next-auth/", "@auth/prisma-adapter", "@prisma/", "js-cookie/"];
...
const PHASE7_BANNED_DEPENDENCIES = [
  "next-auth", "@auth/prisma-adapter", "@prisma/client", "@prisma/adapter-pg",
  "prisma", "js-cookie", "@types/js-cookie",
];
...
const PHASE7_ENFORCED = true;
```

Add a PHASE8 block in the same vocabulary: exact specifiers `react-icons`, `sweetalert2` (+ prefix `react-icons/`); banned dependencies `react-icons`, `sweetalert2`; optional `lucide-react` insurance; optional AI-in-worker rule (no `@/lib/ai` / `ai` / `@ai-sdk/*` specifier under `src/worker/**` — belt-and-braces beside `worker:boundary`). Scan roots already include `src`, `scripts`, build artifacts, and root config files (`DEFAULT_ROOTS`, lines 182-200); RED spot-checks per the 06-05 discipline (deliberately re-add an import, watch the leg fail, remove).

**package.json verify chain** (line 22) — the new legs ride `pnpm cron:remnants` already in the chain; no script additions needed unless the AI-in-worker rule lands as a separate `worker:boundary` extension (`scripts/check-worker-boundary.mjs`, script line 19).

### `src/components/Dashboard/DashboardStatus.tsx` — hydration-safe URL (mod)

**The exact site** (lines 58-60, in-render `window` read — server renders `""`, client renders origin → hydration mismatch):

```typescript
const publicUrl = typeof window !== "undefined" && session?.user?.id
  ? `${window.location.origin}/status/${session.user.id}`
  : "";
```

Fix pattern: derive in an effect with a mounted guard (02-07 precedent: `useSyncExternalStore(no-op subscribe, () => true, () => false)`) into state; the `copyLink` handler (lines 62-68) and `"Loading..."` fallback display (line 104) already tolerate a delayed value. `setTimeout(() => setCopied(false), 2000)` at line 67 is a timer to clear on unmount while touching this file (UI-04 cleared-timers criterion).

### `src/app/(dashboardLayout)/dashboard/layout.tsx` — single Toaster (mod)

Delete line 6: `import { Toaster } from "sonner";` — the import is unused in this 25-line file (verified: no `<Toaster` in its JSX). The single mount is root `src/app/layout.tsx:32` → `<ThemedToaster />` (`src/components/theme/ThemedToaster.tsx`: resolved-theme `Toaster` with `richColors` `top-right`, THM-02). Keep root only.

### `src/app/globals.css` + WR-02 surfaces — UI-03 token work (mod)

**Analog:** itself — the THM-03 same-value token block (lines ~93-110, read this session): `--foreground-invert`, `--highlight-purple`, `--accent-cyan`, `--muted-meta`, `--danger-strong`, `--surface-deep`, `--surface-raised`, `--accent-gold`, `--accent-gold-deep`, `--foreground-bright`, `--dialog-surface/foreground/muted` — with the header comment explicitly naming them "Phase 8 UI-03 review candidates". D-31 lifts the `.dark` freeze (the `.dark` block header reads `/* frozen — today's values, byte-identical (T-02-14 gate) */` — that gate note must be updated when the freeze lifts; dark default VALUES stay). The 11 same-value tokens may split per-mode where light legibility requires; the zero-hex gate in verify stays the substrate.

WR-02 surface list (D-26): `text-white` headings + `bg-slate-950/80` strip in `src/components/dashboardLayout/AppHeader.tsx` (line 12 vicinity; also `src/components/home/HowItWorks.tsx`, `src/components/Dashboard/ProfileComponent.tsx`), Navbar under `src/components/common/Navbar/`, TeamSwitch `text-white` heading (TeamSwitch.tsx:84) — replace raw slate/white classes with token classes (`text-foreground`, `bg-background/80`, `text-muted-foreground`) per the D-26/D-29 refine-don't-replace rule. Dashboard.tsx/MonitorDetails.tsx carry the same `text-white`/`text-slate-400` vocabulary throughout (e.g. Dashboard.tsx:362, 465) — the redesign sweep converts these on the tier-1 surfaces first (D-27 depth order).

---

### Tests (new files)

**`tests/lib/ai-provider.test.ts`** — analog `tests/worker/email-provider.test.ts` (128 lines, read in full): `beforeEach(() => { vi.resetModules(); delete process.env.EMAIL_PROVIDER; })` + dynamic `await import("@/lib/email")` per case + selection-matrix `it` blocks (unset/empty/explicit/unknown-throws, lines 23-53) + `expect(() => getX()).toThrow(/ENV_VAR/)` for the typo case. The AI matrix adds: `AI_ENABLED=false` → any getter throws; incomplete triple → throws; `custom` without `AI_BASE_URL` → throws.

**`tests/api/ai-*.handler.test.ts`** — analog `tests/api/_harness.ts` (211 lines, read in full). IMPORT ORDER CONTRACT (harness lines 9-17): the harness import MUST precede the route import (vi.mock registration order). Reuse: `mockSession(sessionA)` / `sessionB` / `sessionNoUserId` fixtures (lines 122-149), `buildRequest({ path, method, body, headers })` (lines 182-203), the chainable db seam with `dbLog`/`dbState` (lines 56-111) — the post-mortem evidence queries and the no-DB-writes assertion (D-13: assert zero insert/update/delete calls) both ride `dbLog`. Per-file extra seams (e.g. `@/lib/rate-limit`, `@/lib/ai`) are declared in the test file per the D-16 hybrid split (harness lines 32-35).

**`tests/worker/windowed-uptime.test.ts` + `maintenance-windowed.test.ts`** — analog `tests/worker/maintenance.test.ts` (479 lines): injectable `MaintenanceDeps { db, redis, logger }` fakes; pin the dispatcher's unknown-name throw shape with the new accepted name added; windowed-math characterization pins windowed-30d === lifetime derivation on identical inputs (research Pitfall 6 test).

---

## Shared Patterns

### Session guard (all `/api/ai/*` routes)
**Source:** `src/lib/session.ts:34-38` — the ONE session door (07-03), never `auth.api` direct:

```typescript
export async function getAuthSession(): Promise<AuthSession | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  return session as AuthSession;
}
```

Call-site: `monitors/route.ts:69-73` (`if (!session?.user?.id) return apiError(401, "Unauthorized")`). Client side: `useAuthSession()` from `@/lib/auth-client` (Dashboard.tsx:25, MonitorDetails.tsx:41).

### Rate limit + 429 Retry-After (06 D-06 shape)
**Source:** `src/lib/rate-limit.ts:45-67` — `rateLimit(identifier, { limit, windowMs })` → `{ success, remaining, resetSeconds? }`; the limiter prefixes `rl:` itself (line 51). AI call shape (research-verified against this source):

```typescript
const rl = await rateLimit(`ai_drafts_${session.user.id}`, { limit: 10, windowMs: 3_600_000 });
if (!rl.success) {
  return NextResponse.json(
    { error: "Too many AI requests — try again later." },
    { status: 429, headers: rl.resetSeconds !== undefined ? { "Retry-After": String(rl.resetSeconds) } : {} }
  );
}
```

Keys are per-USER (`session.user.id`), never `getIP` (Pitfall 8). Fail-open degraded path returns `success: true` without `resetSeconds` — the header is conditional for exactly that reason.

### Throw-early env validation (06 D-11 lineage)
**Source:** `src/lib/email/index.ts:54-57` (unknown value throws on EVERY call until fixed) + `.env.example:22-23` ("throw-early read"). `lib/ai` adds the master gate: `AI_ENABLED !== "true"` → getter throws (routes must gate first); `AI_ENABLED=true` + missing triple/unknown provider → loud error naming the exact env names. Never `NEXT_PUBLIC_*` for `AI_*` (only the boolean crosses to the client — Pattern 6).

### Error handling + logging
**Source:** `src/app/api/monitors/route.ts:44-49, 144-147` — whole-handler try/catch, `console.error("<Handler>:", error)`, generic `apiError(500, "...")` (no stack traces, FND-07). Worker side: structured pino lines via `buildLogger()` (`maintenance.ts:46, 421-433`) — the D-10 AI log line (feature, userId, model, tokens, duration; never prompt bodies) follows the `logger.info({...}, "message")` object-first shape. Console provider precedent for web-side structured lines: `[email-console] ${JSON.stringify({...})}` (console.ts:19-21).

### Toasts + destructive confirms
**Source:** `sonner` `toast.*` everywhere (~71 usages; Dashboard.tsx:104/126/230); destructive confirm migrates to shadcn alert-dialog (Radix variant verified against sheet.tsx imports); informational popups → sonner. Root `ThemedToaster` is the single mount.

### Client fetch robustness (UI-04)
**Source:** `src/components/Dashboard/Dashboard.tsx:189-226` (AbortController ref + unmount abort + post-await `aborted` re-check) and `src/lib/check-now-poll.ts:45-57` (abort-aware sleep — timer cleared on abort, listener removed on fire). Apply to `fetchMonitors` (Dashboard.tsx:61), `fetchDetails` (MonitorDetails.tsx:57-80 + interval 86-88), `fetchStatus` (DashboardStatus.tsx:39-52). Timer discipline: every `setInterval`/`setTimeout` in touched components gets a cleanup (Dashboard.tsx:96 and MonitorDetails.tsx:90 already clear; DashboardStatus.tsx:67 does not).

### Migration + schema gate (03-05 pipeline)
**Source:** `drizzle/0002_better_auth_cutover.sql` (additive statements + banner) + `src/db/schema.ts:35-39` (GATE CONTRACT: exact pull formatting; comments only may differ) + package.json scripts (`schema:gate`, `rehearse:migrations` in the verify chain, line 22). 0004 goes generate → carve-out list extension → rehearse → single runner. Never push.

## No Analog Found

| File | Role | Data Flow | Reason / Substitute |
|------|------|-----------|---------------------|
| `/api/ai/*` streaming response body | route | streaming | No streaming route exists in the repo (all routes are JSON `NextResponse.json`). Use RESEARCH.md Pattern 2/3 verbatim (AI SDK 7: `streamText` + `toUIMessageStream` + `createUIMessageStreamResponse` / `toTextStream` + `createTextStreamResponse`; `instructions`/`onEnd`/`stream`, `maxRetries: 0`, `abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(N)])`, `consumeStream: true`) — guard chain still copies the monitors-route analog above |
| AI client streaming hooks (`useCompletion`, `useObject`) | hook | streaming | No SDK streaming hooks in the repo. `@ai-sdk/react@4` per RESEARCH.md; the component shell (inline card under incident block, useState prefill) copies the Dashboard/MonitorDetails analogs above |
| `alert-dialog` primitive itself | component | — | Not among the 10 existing primitives (`src/components/ui/`: avatar, button, card, dropdown-menu, input, separator, sheet, sidebar, skeleton, tooltip). Delivered via `pnpm dlx shadcn@latest add dialog alert-dialog` with the sheet.tsx two-trap verification (Radix not Base-UI; hugeicons not lucide) |

## Metadata

**Analog search scope:** `src/lib/**` (email provider tree, rate-limit, session, check-now-poll), `src/app/api/**` (monitors route as guard/validation template), `src/worker/**` (maintenance, scheduler, index, queues), `src/db/schema.ts` + `drizzle/*.sql`, `src/components/**` (Dashboard, form, ui, dashboardLayout, common), `tests/**` (_harness, email-provider, maintenance suites), `scripts/check-cron-remnants.mjs`, `package.json`, `.env.example`, `src/app/globals.css`, layouts. Grep sweeps for `sweetalert2|Swal`, `confirm(`/`alert(`, `react-icons`, `Toaster`, `bg-slate-950/80` confirmed the exact migration-site inventory (3 dialog sites + 2 icon files + 1 dead file + 1 duplicate Toaster import — all verified in-repo this session).
**Files scanned/read:** 24 full-file reads + targeted greps across src/tests/scripts
**Tracked-source check:** 31/31 cited paths verified via `git ls-files` (all tracked; no capability-mirror paths involved)
**Pattern extraction date:** 2026-09-30
