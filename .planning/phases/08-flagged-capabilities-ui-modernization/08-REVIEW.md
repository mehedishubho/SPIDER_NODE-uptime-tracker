---
phase: 08-flagged-capabilities-ui-modernization
reviewed: 2026-10-01T16:21:50Z
depth: standard
files_reviewed: 71
files_reviewed_list:
  - .env.example
  - docs/DEPLOY-RUNBOOK.md
  - drizzle/0004_windowed_uptime.sql
  - drizzle/meta/0004_snapshot.json
  - drizzle/meta/_journal.json
  - package.json
  - playwright.ai.config.ts
  - pnpm-lock.yaml
  - scripts/ai-stub-server.mjs
  - scripts/check-cron-remnants.mjs
  - scripts/probe-telegram-webhook-ladder.mjs
  - scripts/rehearse-migrations.mjs
  - scripts/schema-gate.mjs
  - src/app/(dashboardLayout)/dashboard/layout.tsx
  - src/app/(dashboardLayout)/dashboard/monitor/[id]/page.tsx
  - src/app/(dashboardLayout)/dashboard/page.tsx
  - src/app/api/ai/monitor-assistant/route.ts
  - src/app/api/ai/post-mortem/route.ts
  - src/app/api/monitors/[id]/check/route.ts
  - src/app/globals.css
  - src/components/Dashboard/Dashboard.tsx
  - src/components/Dashboard/DashboardStatus.tsx
  - src/components/Dashboard/Incidents.tsx
  - src/components/Dashboard/MonitorDetails.tsx
  - src/components/Dashboard/PostMortemCard.tsx
  - src/components/Dashboard/ProfileComponent.tsx
  - src/components/Dashboard/StatsSummaryHeader.tsx
  - src/components/Dashboard/TelegramSettings.tsx
  - src/components/Others/Loader/Loading.tsx
  - src/components/Others/PageNotFound/PageNotFound.tsx
  - src/components/Status/PublicStatus.tsx
  - src/components/common/Navbar/Navbar.tsx
  - src/components/dashboardLayout/AppHeader.tsx
  - src/components/dashboardLayout/NavMain.tsx
  - src/components/dashboardLayout/TeamSwitch.tsx
  - src/components/form/MyFormInput.tsx
  - src/components/form/MyFormSelect.tsx
  - src/components/home/HowItWorks.tsx
  - src/components/ui/alert-dialog.tsx
  - src/components/ui/dialog.tsx
  - src/db/schema.ts
  - src/lib/ai/assistant-schema.ts
  - src/lib/ai/guards.ts
  - src/lib/ai/index.ts
  - src/lib/ai/log.ts
  - src/lib/ai/providers/anthropic.ts
  - src/lib/ai/providers/custom.ts
  - src/lib/ai/providers/glm.ts
  - src/lib/ai/providers/openai.ts
  - src/worker/engine/check.ts
  - src/worker/maintenance.ts
  - src/worker/persist/tier2.ts
  - src/worker/queues.ts
  - src/worker/scheduler.ts
  - tests/api/ai-assistant.test.ts
  - tests/api/ai-post-mortem.test.ts
  - tests/api/ai-routes.handler.test.ts
  - tests/api/ai-stream.handler.test.ts
  - tests/api/check-route.handler.test.ts
  - tests/e2e/ai-surfaces.spec.ts
  - tests/e2e/dashboard-redesign.spec.ts
  - tests/e2e/dialogs.spec.ts
  - tests/e2e/light-mode.spec.ts
  - tests/e2e/ui-robustness.spec.ts
  - tests/integration/check-route-restore.test.ts
  - tests/lib/ai-provider.test.ts
  - tests/setup/seed.ts
  - tests/worker/engine-check.test.ts
  - tests/worker/maintenance-windowed.test.ts
  - tests/worker/scheduler-flag.test.ts
  - tests/worker/windowed-uptime.test.ts
findings:
  critical: 0
  warning: 3
  info: 7
  total: 10
status: findings
---

# Phase 08: Code Review Report

**Reviewed:** 2026-10-01T16:21:50Z
**Depth:** standard
**Files Reviewed:** 71
**Status:** findings

## Summary

All 71 in-scope source files were read in full at standard depth, with cross-file tracing on the load-bearing contracts this phase pins: the windowed-uptime backend (drizzle 0004 + the nightly recompute), the AI guard chain and both AI routes, the manual-check route's advance/compensate envelope, the dialog/icon consolidation, and the gate extensions.

The core of the phase is sound. Verified directly against source and installed dependencies:

- **D-36 no-round() discipline holds** — the windowed recompute, the D-37 consistency audit, and tier2's in-UPDATE derivation all use the power-of-two `::bigint` extraction expression verbatim; the only `round()` calls in the worker are health/outbox metrics and comment text. `tests/worker/windowed-uptime.test.ts` pins byte-equality between the 30d window and the lifetime derivation.
- **Rule 15 (AI never in check → transition → alert)** — zero AI imports under `src/worker/**` (grep-verified; the cron-remnants gate leg enforces it path-scoped), no `NEXT_PUBLIC_*` AI env anywhere, AI key reads confined to `src/lib/ai`.
- **Ownership before evidence on the AI routes** — the post-mortem route scopes the monitor by `id + userId` first and answers 404 with zero evidence queries; the incident read is then scoped by `incidentId + monitorId`. Per-USER limiter keys (`ai_drafts_{userId}`, `ai_assistant_{userId}`) — no IP involvement post-auth.
- **AI SDK v7 usage is correct** — `instructions`, `onEnd`/`onAbort`, `Output.object`, `toUIMessageStream`/`createUIMessageStreamResponse({ consumeSseStream })`, `toTextStream` were all verified against the installed `ai@7.0.123` type declarations.
- **Migration 0004 is purely additive** (three nullable double precision columns, no backfill), the journal/snapshot are consistent, and the schema gate's canonicalization rules match the committed schema's intentional renderings.
- **Monitoring behavior/public API shapes unchanged** — the manual-check route keeps the 202 `{ jobId, queuedAt }` envelope with the µs-precision compensating restore, and both suites (handler-mocked and real-Postgres integration) pin it.

Findings below: 3 warnings (one real display-correctness defect that survived the redesign, one input-validation gap in the shared AI guard, one latent misclassification inside the remnant gate) and 7 info items. No critical issues — no injection, no auth bypass, no data-loss path, no AI-in-pipeline violation was provable.

## Warnings

### WR-01: 0% uptime renders as "100%" on the dashboard and monitor detail

**File:** `src/components/Dashboard/Dashboard.tsx:861-864` (same defect at `src/components/Dashboard/MonitorDetails.tsx:307`)
**Issue:** The uptime cell uses `{monitor.uptimePercent ? monitor.uptimePercent.toFixed(2) : 100}`. `0` is falsy, so a monitor whose every check failed (`failedChecks === totalChecks`, uptimePercent = 0.00 — reachable from day one via the tier1/tier2 writers) renders **"100%"** (in red, since the adjacent `uptimePercent < 95` color check evaluates correctly — value and color contradict each other). The pattern is legacy-inherited, but this phase rewrote exactly these display blocks and simultaneously introduced the correct idiom elsewhere: `DashboardStatus.tsx:288` and `PublicStatus.tsx:243` use `monitor.uptimePercent?.toFixed(2) ?? "100.00"`, which renders `0.00` correctly. The inconsistency proves the falsy-zero hazard was known and fixed in two of the four uptime displays — the other two were missed.
**Fix:**
```tsx
{monitor.uptimePercent?.toFixed(2) ?? "100.00"}%
```
in both `Dashboard.tsx` (uptime column) and `MonitorDetails.tsx` (OVERALL UPTIME card), matching the DashboardStatus/PublicStatus form.

### WR-02: AI guard caps input only AFTER buffering the entire request body

**File:** `src/lib/ai/guards.ts:114-125`
**Issue:** The 2000-char cap (A4) is enforced by `const raw = await req.text()` and then measuring `raw.length`. The full body is read into memory before the cap is ever consulted, so the cap bounds provider cost but not server memory: any authenticated user can POST an arbitrarily large body to `/api/ai/post-mortem` or `/api/ai/monitor-assistant` and force the web process to buffer it whole (App Router route handlers impose no default body-size limit). Mitigations exist — the route is authenticated and the per-user limiter (10–20 req/h) runs first — but a multi-user abuse pattern still converts N authenticated accounts into unbounded per-request memory spikes, which is the exact class the A4 cap exists to prevent. The post-429/413 semantics (oversized bodies consume a bucket slot) are preserved by any fix that aborts the read at the cap.
**Fix:**
```ts
// Cheap pre-check before reading, then a bounded read:
const declared = Number(req.headers.get("content-length"));
if (Number.isFinite(declared) && declared > AI_INPUT_MAX_CHARS) {
  return { ok: false, response: apiError(413, `Request body too large — AI input is capped at ${AI_INPUT_MAX_CHARS} characters.`) };
}
// Then read with a bounded reader that aborts once cumulative length
// exceeds the cap instead of buffering the rest of the stream.
```
(Keep the exact-at-cap-passes and 413-body contract pinned by `tests/api/ai-routes.handler.test.ts`.)

### WR-03: Remnant gate silently re-labels Phase-8 findings as Phase-7

**File:** `scripts/check-cron-remnants.mjs:568-576` (same collapse at `578-584` for package.json findings)
**Issue:** `scanCodeFile` (lines 401-424) and `checkPackageJson` (473-488) return object findings tagged `{ phase7: true, text }` OR `{ phase8: true, text }`, but both push sites re-tag every object finding as `findings.push({ file, reason: reason.text, phase7: true })` — the `phase8` marker is dropped. Consequence: the Phase-8 legs added in 08-02/08-10 (react-icons/sweetalert2/lucide-react specifiers and dependency declarations, plus the AI-in-worker import leg) are not actually "phase8-marked" as the header documents; they are Phase-7-marked. Behavior is correct today only because `PHASE7_ENFORCED` and `PHASE8_ENFORCED` are both `const true`, so `isEnforced` yields the same verdict either way — but the moment either flag's posture ever diverges (the advisory-first lifecycle this gate deliberately built for Phase-7), a Phase-8 finding would be enforced/advisory under the wrong phase's lever, and the finding output misattributes which deletion class tripped. The file-NAME check (lines 552-567) tags correctly; only the object-finding push sites are wrong.
**Fix:**
```ts
for (const reason of scanCodeFile(file)) {
  if (typeof reason === "string") {
    findings.push({ file, reason });
  } else {
    findings.push({ file, reason: reason.text, phase7: !!reason.phase7, phase8: !!reason.phase8 });
  }
}
```
(Identical change at the package.json loop.) Add a pin asserting a phase8 object finding carries `phase8: true` and `phase7: undefined` — the existing suite cannot see this because both flags are true.

## Info

### IN-01: Custom provider factory omits `includeUsage`, so D-10 cost lines read zero tokens for AI_PROVIDER=custom

**File:** `src/lib/ai/providers/custom.ts:26-31`
**Issue:** The glm factory passes `includeUsage: true` so streamed usage reaches the D-10 log line (`log.ts` / the routes' `onEnd`). The custom factory (same `createOpenAICompatible` package) does not, so with the documented env-swapped OpenAI-compatible endpoint the `[ai-request]` line logs `promptTokens/completionTokens/totalTokens: 0` — cost visibility silently degrades for exactly the bring-your-own-endpoint case the custom provider exists for.
**Fix:** Pass `includeUsage: true` in `createCustomModel`, mirroring `glm.ts:30-35` (endpoints that don't emit the usage chunk simply leave the fields at 0 as today; endpoints that do now report).

### IN-02: TeamSwitcher dead code — unused `user` prop, computed-but-unrendered display locals, commented-out icon block

**File:** `src/components/dashboardLayout/TeamSwitch.tsx:26-52, 77-79`
**Issue:** `displayName`/`displayEmail`/`displayAvatar`/`displayFallback` are computed but never rendered; the `user` prop exists only to feed them; `teams` is used solely for the `activeTeam` null-check; the `Activity` icon import is referenced only inside a commented-out block (77-79). The comment says the locals "stay for the 08-09 sidebar reconciliation to re-wire" — but 08-09 is in this same reviewed state and did not re-wire them.
**Fix:** Delete the display locals and the commented block; drop the `user` prop (or render it — the sidebar currently shows no identity, which may itself be the intent to confirm).

### IN-03: Incidents page lacks the UI-04 abort discipline applied to every other polled surface

**File:** `src/components/Dashboard/Incidents.tsx:44-64`
**Issue:** Every other fetched surface this phase touched (Dashboard, MonitorDetails, DashboardStatus, PublicStatus) got the controller-per-pass + unmount-abort + post-await aborted re-check pattern; `fetchIncidents` passes no signal and holds no ref, so navigating away mid-fetch can still surface a `console.error` + "Failed to load incidents." toast after unmount — the exact noise class the UI-04 spec pins to zero (the e2e robustness suite tests the other four surfaces, not this one).
**Fix:** Mirror `DashboardStatus.fetchStatus`: `AbortController` per pass in a ref, `signal` on the fetch, aborted re-check before each `setState`, abort in the unmount cleanup.

### IN-04: Clipboard writes without rejection handling (two surfaces)

**File:** `src/components/Dashboard/DashboardStatus.tsx:116`, `src/components/Dashboard/ProfileComponent.tsx:196`
**Issue:** `navigator.clipboard.writeText(...)` returns a promise that is neither awaited nor `.catch`ed; on a denied permission or non-secure context this is an unhandled promise rejection and the UI still shows the success toast/copy state. `PostMortemCard.handleCopy` (PostMortemCard.tsx:104-109) does it correctly with `.then/.catch`.
**Fix:** Add a `.catch(() => toast.error("Couldn't copy..."))` to both, mirroring PostMortemCard.

### IN-05: Profile delete-account confirmation is still a hand-rolled modal while UI-02 consolidated destructive confirmations onto AlertDialog

**File:** `src/components/Dashboard/ProfileComponent.tsx:784-824`
**Issue:** The phase's stated UI-02 contract ("one dialog system") converted delete-monitor (Dashboard), disconnect-Telegram (TelegramSettings), and logout (TeamSwitch) to the shared `AlertDialog`; the profile Danger Zone retains a bespoke fixed-position backdrop modal with its own focus/escape behavior.
**Fix:** Port to `AlertDialog` + `AlertDialogAction variant="destructive"` like the other three surfaces (no behavioral change; the confirm handler is already dialog-confirmation-gated).

### IN-06: Overlapping `fetchMonitors` passes never abort the prior pass — a slow stale response can overwrite fresher data

**File:** `src/components/Dashboard/Dashboard.tsx:274-310`
**Issue:** Each pass replaces `monitorsPollAbortRef.current` without aborting the previous controller, so a manual refresh fired while the 30 s poll pass is still in flight leaves both running; if the earlier request resolves last, `setMonitors` applies the older snapshot until the next poll corrects it (≤30 s). Same shape in `MonitorDetails.fetchDetails` (90-123). Self-healing, low impact — noting for completeness since the abort seam exists precisely to sequence these.
**Fix:** At the top of each pass, `monitorsPollAbortRef.current?.abort()` before installing the new controller.

### IN-07: Maintenance dispatcher resolves a Redis client before the unknown-job-name guard

**File:** `src/worker/maintenance.ts:559-567`
**Issue:** `const redis = deps.redis ?? maintenanceRedis()` runs before the `job.name !== "cleanup"` throw, so an undeclared maintenance job name constructs (and starts connecting) a Redis singleton before failing loudly. Harmless in the worker process (the client already exists at boot), but the loud-contract-violation check is cheaper and side-effect-free if it runs first.
**Fix:** Move the unknown-name throw above the `redis` resolution (the recompute branch above it is already correctly ordered).

---

_Project-contract checks (all verified green, no findings):_ D-36 exact-extraction SQL everywhere in the uptime paths (no `round()`); rule-15 AI/web-process separation (grep + gate leg); `AI_*` server-only with no `NEXT_PUBLIC_*` variants; ownership scoping before evidence assembly on both AI routes; per-USER limiter keys on all post-auth AI and manual-check routes; migration 0004 purely additive with the journal/snapshot consistent; public check-route envelope and characterization surfaces pinned by both mock and real-Postgres suites.

_No source files were modified during this review._

---

_Reviewed: 2026-10-01T16:21:50Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
