# Phase 8: Flagged Capabilities & UI Modernization - Research

**Researched:** 2026-09-30
**Domain:** Vercel AI SDK 7 integration (flagged, streaming, rate-limited) · windowed-uptime backend on the worker maintenance lane · shadcn/Tailwind v4 UI modernization with dep deletions
**Confidence:** HIGH (stack verified against official docs + npm registry this session; AI SDK major-version drift from training knowledge caught and corrected)

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

*Copied verbatim from `.planning/phases/08-flagged-capabilities-ui-modernization/08-CONTEXT.md` §Implementation Decisions (D-01..D-38). The full verbatim text lives in 08-CONTEXT.md; the load-bearing anchors per area:*

**AI provider abstraction (AI-01/AI-02):** D-01 universal env-swappable provider layer in `lib/ai` under the Vercel AI SDK mirroring the Phase-6 email provider-interface pattern · D-02 single env triple `AI_PROVIDER` + `AI_MODEL` + `AI_API_KEY` (+ `AI_BASE_URL` when `AI_PROVIDER=custom`), throw-early at boot when `AI_ENABLED=true` and config incomplete/unknown · D-03 Z.ai GLM is the documented day-1 default in `.env.example` · D-04 single `AI_ENABLED` flag governs both features, no per-feature sub-flags · D-05 one `AI_MODEL` for both features · D-06 all authenticated users see AI when enabled (env flag is the only gate; AI-02 session guard + rate limits still apply).

**AI endpoint behavior (AI-02):** D-07 streams via AI SDK primitives (`streamText` server + SDK streaming hooks client; no custom ReadableStream chunk parsing) · D-08 per-feature rate-limit buckets reusing the Redis Lua limiter — drafts ~10/h per user, assistant ~20/h per user, 429s carry `Retry-After` in the 06 D-06 shape · D-09 provider failure/timeout → clean inline error + user-initiated Retry; no silent auto-retry loops; no hidden-degradation probing · D-10 one structured log line per AI request (feature, userId, model, tokens in/out, duration).

**Incident post-mortem draft (AI-03):** D-11 generated from the incident blocks on the monitor detail page · D-12 inline streaming card under the incident, markdown as it arrives, Copy at completion, no modal · D-13 copy-only, nothing ever written to the DB · D-14 sections verbatim: Summary, Timeline, Impact, Possible causes · D-15 evidence incident-scoped (this incident + its pings window + monitor identity) · D-16 Regenerate on both features + Stop while streaming on the draft.

**Monitor-setup assistant (AI-04):** D-17 prefill inside the existing Add Monitor form; normal form submit is the confirmation; same-schema validation for free · D-18 create-only · D-19 partial fill + "fill manually" hint on invalid fields; never all-or-nothing; schema stays the single gate · D-20 placeholder "e.g. Watch my portfolio site every 5 minutes" · D-21 flag off = zero AI trace in the UI (no disabled buttons, no tooltips).

**Windowed-uptime backend (DAT-11):** D-22 nightly recompute runs unconditionally from ship; `WINDOWED_UPTIME_ENABLED` gates only reads and nothing reads in v1; columns land via an additive Drizzle migration through the 03-05 rehearsal pipeline · D-23 first run backfills all three windows (24h/7d/30d) from retained ping history (30-day retention) · D-24 no v1 surface reads the windowed values; verification is tests + direct DB checks only; no admin probe endpoint.

**Visual redesign (UI-01/UI-03/UI-05):** D-25 refresh + targeted layout improvements (stats header, denser list, cleaner detail) · D-26 light mode intentional everywhere incl. WR-02 marketing surfaces (`text-white` Navbar/TeamSwitch headings, `bg-slate-950/80` header, `text-slate-300/400` copy) · D-27 depth order: dashboard + monitor detail deepest, public status behind, auth + marketing palette/motion pass only · D-28 micro-interactions only via installed `motion` v12 · D-29 keep and refine the cyan-forward accent; no new brand palette · D-30 same font family, refined type scale · D-31 both modes redesigned on the same token set; dark stays default; the migration-era `.dark` byte-freeze lifts.

**Icon & dialog consolidation (UI-02):** D-32 Hugeicons wins · D-33 full react-icons sweep + dep deletion + remnant-gate verify check (D-41 lineage) · D-34 full dialog consolidation (sweetalert2 + window.confirm → shadcn alert-dialog / sonner; `sweetalert2` dep deleted with verify-gate extension) · D-35 shadcn adoption sweeps the redesign surfaces only.

**Release sequencing:** D-36 build/ship order windowed-uptime backend → UI redesign → AI last · D-37 one release per deliverable (three feature releases), each soaked with `pnpm verify` + live window; dep deletions ride the redesign release · D-38 AI ships dark (`AI_ENABLED=false`), soaks fully AI-less, then the env flips and both features are smoke-tested live.

### Claude's Discretion

AI prompt wording/system prompts, exact token + input-size caps, post-mortem ping-window lead-in size · AI route paths (`/api/ai/*` shape) and `lib/ai` module layout · exact rate-limit values within D-08 anchors · `@ai-sdk/*` provider package selection per provider value incl. the Z.ai OpenAI-compatible endpoint wiring · verify-gate grep patterns for the icon/dialog remnant gates · windowed-uptime column shapes, recompute scheduling within the maintenance lane, backfill query form (03-05 rehearsal pipeline applies) · E2E posture (functional Playwright e2e + manual UAT; characterization/contract suites stay green) · soak durations, 08 deploy-record structure, 02-08 follow-ups (11 same-value token review, mixed emerald/rose ternary migration) · skeleton placement, stagger choreography, status-transition specifics within D-28.

### Deferred Ideas (OUT OF SCOPE)

Per-feature AI model overrides (`AI_MODEL_SUMMARIZE`/`AI_MODEL_ASSISTANT`) · edit-flow AI assistance · save-to-incident for post-mortem drafts · admin-only probe for windowed values · admin feedback viewer UI + Better Auth management endpoints + resend-verification · windowed-uptime display switch (PROD-01, v2).

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description (REQUIREMENTS.md) | Research Support |
|----|-------------|------------------|
| AI-01 | `AI_ENABLED` flag, off by default; app runs fully without any AI keys | `lib/ai` env-gate pattern mirroring `src/lib/email/index.ts` (verified); server-render flag propagation pattern (§AI flag-off mechanics) |
| AI-02 | AI endpoints streaming, session-guarded, rate-limited (Redis limiter), input-size-capped, timeout-bound; provider/model centralized in `lib/ai` | AI SDK 7 `streamText` + `createUIMessageStreamResponse`/`createTextStreamResponse` (CITED); `getAuthSession()` guard (VERIFIED in-repo); `rateLimit()` reuse (VERIFIED); `maxRetries:0` + `abortSignal` composition (CITED) |
| AI-03 | Post-mortem draft from incident + pings window; never auto-written to incidents | `useCompletion` + UIMessage stream (CITED); incident/pings evidence query shapes from `src/db/schema.ts` (VERIFIED); copy-only card per UI-SPEC |
| AI-04 | NL → config JSON validated by same schema as manual form; never executed without confirmation | `useObject` + `Output.object({schema})` partial-object streaming (CITED) maps 1:1 onto D-19 partial-fill; Add Monitor form is useState-based (VERIFIED — see Pitfall 9) |
| AI-05 | Zero AI calls in check → transition → alert pipeline (rule 15) | `src/worker/**` has zero AI imports today (VERIFIED); worker-boundary gate extension pattern (§Don't Hand-Roll / gates) |
| DAT-11 | Windowed uptime backend behind a flag: per-window columns + nightly recompute from pings; lifetime counters remain displayed | Additive columns on `monitors` (schema VERIFIED); maintenance-lane dispatcher + `upsertJobScheduler` pattern (VERIFIED); D-36 binary-extraction SQL verbatim in `src/worker/maintenance.ts:94-134` (VERIFIED) |
| UI-01 | shadcn/ui primitives adopted for dashboard feature components | `pnpm dlx shadcn@latest add dialog alert-dialog` (CITED); Base-UI-default trap + Radix-variant verification step (CITED + search) |
| UI-02 | Dialog + icon consolidation to single systems | Consolidation map sites verified in-repo (Dashboard.tsx:275, TelegramSettings.tsx:101, TeamSwitch.tsx:51, MyFormInput/MyFormSelect); hugeicons 0.4.0 replacement exports verified by importing the installed package |
| UI-03 | Light palette refinement + light-safe brand assets + sidebar token reconciliation | 11 same-value token set verified in `src/app/globals.css:94-104` (VERIFIED); WR-02 surface list from UI-SPEC |
| UI-04 | AbortController on polling fetches, cleared timers, hydration-safe URL derivation, single Toaster | Concrete sites verified: `fetchMonitors` (no signal), `MonitorDetails.tsx:86` interval, `DashboardStatus.tsx:57-59` in-render `window` read, duplicate `Toaster` import at `src/app/(dashboardLayout)/dashboard/layout.tsx:6`; existing abort pattern at Dashboard.tsx:194-226 |
| UI-05 | Full visual redesign only on stable tokens + stable APIs | UI-SPEC is the binding design contract (07 dimensions PASS); token/motion/typography rules summarized in §Architecture Patterns |

</phase_requirements>

## Project Constraints (from CLAUDE.md)

`CLAUDE.md` resolves to `.claude/CLAUDE.md` (read this session). Actionable directives binding this phase:

- **Tech stack (target)** names "Vercel AI SDK (off critical path)", Tailwind v4, shadcn/ui, Hugeicons, Sonner, Radix UI, Framer Motion (`motion`), Drizzle, Better Auth, Redis + BullMQ, pnpm — D-01..D-38 operate inside this stack. [VERIFIED: .claude/CLAUDE.md §Constraints]
- **Behavior compatibility:** monitoring semantics preserved — 1-strike DOWN, lifetime uptime math, Telegram alert content, public API shapes (criterion 5's characterization/contract suites). [VERIFIED: .claude/CLAUDE.md §Constraints]
- **Deployment:** single VPS, two PM2 apps, forward-only additive-first migrations, `readyz` health gate before a release counts good. [VERIFIED: .claude/CLAUDE.md §Constraints]
- **Conventions:** `sonner` (`toast.*`) is the primary toast API; prefer composing existing `src/components/ui` primitives before writing new ones; `"use client"` first line for interactive components; shadcn kebab-case primitives; `@/*` path alias; no barrel files; match file quoting style; section-banner comments in route files. [VERIFIED: .claude/CLAUDE.md §Conventions]
- **GSD workflow enforcement:** no direct repo edits outside a GSD workflow. [VERIFIED: .claude/CLAUDE.md §GSD Workflow Enforcement]
- House rules from STATE.md bind: PostgreSQL always source of truth; `drizzle-kit push` FORBIDDEN (versioned migrations through single-runner `pnpm db:migrate`-equivalent + `rehearse:migrations`); expand/contract releases; `pnpm verify` gate chain; throw-early env validation; 06 D-06 429+`Retry-After` shape; rule 15 (AI never in check→transition→alert). [VERIFIED: .planning/STATE.md accumulated decisions]

---

## Summary

Phase 8 lands three revertible deliverables on the now-stable substrate. The **AI leg** rides the Vercel AI SDK, whose current major is **7** (ai@7.0.123, @ai-sdk/react@4.0.126 — npm dist-tags verified 2026-09-30), one and arguably two majors ahead of common training knowledge: `system`→`instructions`, `onFinish`→`onEnd`, `fullStream`→`stream`, and result-level response helpers replaced by stateless `toUIMessageStream`/`createUIMessageStreamResponse`/`createTextStreamResponse`. The two features map cleanly onto SDK primitives with zero custom stream parsing (D-07): the post-mortem draft is `useCompletion` over a UIMessage stream; the assistant prefill is `useObject` + `Output.object({schema})` whose partial-object semantics are exactly D-19's partial fill. GLM wires through `@ai-sdk/openai-compatible` at `https://api.z.ai/api/paas/v4` (base URL pinned by the official AI SDK provider docs; exact current model id — glm-4.6 in secondary sources — should be confirmed at flip time). The **DAT-11 leg** adds three per-window columns to `monitors` via additive migration 0004 through the rehearsal pipeline and a nightly maintenance-lane job whose recompute SQL must reuse the D-36 binary-extraction expression (verbatim in `src/worker/maintenance.ts:94-134`) — `round()` is banned. The **UI leg** adds exactly two shadcn primitives (`dialog`, `alert-dialog`) into a July-2026 ecosystem where shadcn's registry default flipped to Base UI — the delivered files must be verified Radix variants — and sweeps react-icons/sweetalert2 out with remnant-gate extensions; hugeicons 0.4.0 replacement exports for all four icon call sites were verified by importing the installed package.

**Primary recommendation:** Build in D-36 order (windowed backend → UI → AI). Pin `ai@7`/`@ai-sdk/react@4`/`@ai-sdk/openai-compatible@3` (+ `@ai-sdk/openai@4`, `@ai-sdk/anthropic@4` only if those provider branches ship); wire GLM via `createOpenAICompatible({ name: 'glm', baseURL: 'https://api.z.ai/api/paas/v4', includeUsage: true })`; gate every `/api/ai/*` route on `AI_ENABLED` + `getAuthSession()` + per-user Redis limiter buckets before touching the SDK; and treat the shadcn add as a two-trap operation (Base-UI variant check + lucide→hugeicons swap).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| AI endpoints (streaming, guards, limits) | Web/API (`src/app/api/ai/*`) | — | Rule 4–6 lineage: API routes never execute checks; AI is request-path only, never worker |
| AI provider selection/config | Web lib (`src/lib/ai`) | — | Mirrors `src/lib/email/index.ts` provider-interface; env-read at module/boot, throw-early |
| AI streaming client state | Browser (hooks from `@ai-sdk/react`) | — | D-12 inline card / D-17 prefill are client components |
| AI enabled-flag propagation to UI | Frontend server (page/layout props) | Browser | D-21 zero-trace when off requires server-render decision, not a runtime fetch |
| Windowed-uptime columns + migration | Database (Drizzle schema + migration 0004) | — | PostgreSQL is source of truth; additive expand-phase migration |
| Nightly windowed recompute | Worker (maintenance lane) | Database | Worker owns all monitoring-adjacent compute; lane concurrency 1; never web |
| Lifetime uptime display (unchanged) | Browser (existing components) | API | DAT-11 changes nothing displayed in v1 (D-24) |
| Dialog/alert-dialog primitives | Browser (Radix via shadcn) | — | D-34 one dialog system |
| Icon system | Browser (hugeicons-react) | — | D-32/D-33 single system, dep deleted |
| Rate limiting (AI buckets) | API + Redis (existing Lua limiter) | — | D-08 reuses `rateLimit()` verbatim; per-user keys, not IP |
| Token/cost logging (D-10) | Web lib (structured console/pino line) | — | One log line per request; no new metric machinery |

## Standard Stack

### Core (AI leg — new installs)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ai` | 7.0.123 | `streamText`, `Output.object`, `toUIMessageStream`/`createUIMessageStreamResponse`, `toTextStream`/`createTextStreamResponse` | The Vercel AI SDK core; D-01's substrate [VERIFIED: npm registry 2026-09-30] |
| `@ai-sdk/react` | 4.0.126 | `useCompletion` (post-mortem), `useObject` (assistant prefill) | The SDK's React streaming hooks; D-07 forbids custom chunk parsing [VERIFIED: npm registry] |
| `@ai-sdk/openai-compatible` | 3.0.60 | GLM/Z.ai + custom providers via `createOpenAICompatible` | D-02's `custom` branch and D-03's GLM default both ride it [VERIFIED: npm registry; API CITED: ai-sdk.dev] |

### Supporting (install only if the provider branch ships)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@ai-sdk/openai` | 4.0.82 | `createOpenAI` for `AI_PROVIDER=openai` | D-02 allows OpenAI as a provider value — ship the branch or leave for later; the map must still throw-early on unknown values |
| `@ai-sdk/anthropic` | 4.0.69 | `createAnthropic` for `AI_PROVIDER=anthropic` | Same conditional-install consideration |

### Already installed (UI + backend legs — zero new deps)

| Library | Version | Purpose | Note |
|---------|---------|---------|-------|
| `@radix-ui/react-dialog` | ^1.1.15 (+ `radix-ui` ^1.6.2) | Dialog/alert-dialog primitive base | `sheet.tsx` precedent imports `@radix-ui/react-dialog` [VERIFIED: src/components/ui/sheet.tsx:3] |
| `hugeicons-react` | ^0.4.0 | Single icon system (D-32) | 4654 exports; replacements verified (see UI-02 section) [VERIFIED: package import this session] |
| `motion` | ^12.23.24 | All D-28 micro-interactions | `useReducedMotion` for prefers-reduced-motion |
| `sonner` | 2.0.7 | Single toast system; absorbs informational Swals | Root `ThemedToaster` is the single mount |
| `drizzle-orm` / `drizzle-kit` | 0.45.2 / 0.31.10 | Windowed columns + migration 0004 | `push` FORBIDDEN; generate + rehearse + single runner |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@ai-sdk/openai-compatible` for GLM | `zhipu-ai-provider` (community provider, official docs page exists) | Community package adds a third-party dep and a second selection mechanism; D-01/D-02's env-triple + OpenAI-compatible endpoint covers GLM with the SDK's own package — recommended |
| `useCompletion` for post-mortem | `useChat` | Chat framing (message list) is wrong for a single-prompt draft; completion is the minimal primitive |
| `useObject` for assistant | plain `useCompletion` + client JSON.parse | Loses streaming partial fill and schema-invalid safety; parse failures would break D-19 partial fill |
| Separate AI route queue via BullMQ | direct route streaming | D-07/D-12 want live streaming in the response; queueing would kill the UX and is out of scope |

**Installation:**
```bash
pnpm add ai@7 @ai-sdk/react@4 @ai-sdk/openai-compatible@3
# only if shipping the openai/anthropic provider branches in this phase:
pnpm add @ai-sdk/openai@4 @ai-sdk/anthropic@4
# UI primitives are added via the shadcn registry, not pnpm:
pnpm dlx shadcn@latest add dialog alert-dialog
```

**Version verification (npm registry, 2026-09-30):** `ai` 7.0.123 (latest, modified 2026-09-30) · `@ai-sdk/react` 4.0.126 · `@ai-sdk/openai` 4.0.82 · `@ai-sdk/anthropic` 4.0.69 · `@ai-sdk/openai-compatible` 3.0.60 — all five verified via `npm view` this session. These packages publish patches continuously (all modified within hours of research time).

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `ai` | npm | ~5 yrs (v7 line current) | 31.6M/wk | github.com/vercel/ai | SUS ("too-new") | Approved — see note |
| `@ai-sdk/react` | npm | ~4 yrs | 10.0M/wk | github.com/vercel/ai | SUS ("too-new") | Approved — see note |
| `@ai-sdk/openai-compatible` | npm | ~3 yrs | 9.6M/wk | github.com/vercel/ai | SUS ("too-new") | Approved — see note |
| `@ai-sdk/openai` | npm | ~4 yrs | 16.5M/wk | github.com/vercel/ai | SUS ("too-new") | Approved — see note |
| `@ai-sdk/anthropic` | npm | ~4 yrs | 15.7M/wk | github.com/vercel/ai | SUS ("too-new") | Approved — see note |
| `zhipu-ai-provider` | npm | — | — | community | not checked | NOT recommended (avoided; GLM rides `@ai-sdk/openai-compatible`) |

**Note on the SUS verdicts:** the seam's `too-new` reason fires because each package's *latest patch* was published hours before this research (they release continuously). The legitimacy signals themselves — all from the single official `vercel/ai` monorepo, 9.6–31.6M weekly downloads, no postinstall scripts, not deprecated — are the canonical Vercel AI SDK distribution. [VERIFIED: package-legitimacy check output + npm view, this session]. Confidence that these are the intended packages is HIGH; the planner does not need a human-verify checkpoint for them, but SHOULD pin exact versions at install time as always.

**Packages removed this phase (per D-33/D-34):** `react-icons` (exactly 2 call-site files), `sweetalert2` (1 call-site file + dead `DeleteModal.tsx`).
**Never install:** `lucide-react` (components.json `iconLibrary` is stale — see Pitfall 1); `@base-ui-components/react` (project is Radix-based — see Pitfall 2).

## Architecture Patterns

### System Architecture Diagram

```
                            ┌───────────────────────────────────────────────┐
                            │                    WEB (PM2)                  │
  Browser ── session ──────▶│  /dashboard, /status/[id]  (server render)   │
   │                        │     │ AI_ENABLED prop (flag-off = zero trace)│
   │ 30s polling fetch      │     ▼                                          │
   │ (AbortController)      │  Client components (hooks: useCompletion /    │
   │                        │  useObject; shadcn dialog/alert-dialog;       │
   │                        │  sonner toasts; motion micro-interactions)    │
   │                        └───────┬─────────────────────┬─────────────────┘
   │ POST /api/ai/post-mortem       │                     │ POST /api/ai/assistant
   │ POST /api/ai/monitor-assistant │                     │ (flag→session→limiter→cap→timeout)
   ▼                                ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ /api/ai/* route handler (web)                                           │
│  1 AI_ENABLED? → 404 when off        4 rateLimit(ai_{feature}_{userId}) │
│  2 getAuthSession() → 401            5 input-size cap → 413/400         │
│  3 (guards above)                    6 streamText{maxRetries:0,         │
│                                        abortSignal:any(req.signal,       │
│                                        AbortSignal.timeout(N))}          │
│  post-mortem: evidence = incident + bounded pings window (DB reads)     │
│  assistant: Output.object({schema}) — same schema as the create route   │
│  response: createUIMessageStreamResponse / createTextStreamResponse     │
│  logging: onEnd/onAbort → one structured line (feature,userId,model,    │
│           tokens,duration) — D-10                                      │
└────────┬────────────────────────────────────────────────┬───────────────┘
         │                                                │
         ▼                                                ▼
┌─────────────────┐                            ┌────────────────────┐
│ lib/ai (web)    │                            │ Redis (limiter)    │
│ env triple +    │─ provider instances ──▶    │ rl:ai_drafts_{uid} │
│ throw-early     │  glm → openai-compatible   │ rl:ai_assist_{uid} │
│ (email pattern) │  openai/anthropic/custom   └────────────────────┘
└──────┬──────────┘
       │ HTTPS (streaming chat/completions)
       ▼
┌────────────────────────────┐      ┌────────────────────────────────────┐
│ Z.ai GLM (api.z.ai/paas/v4)│      │ WORKER (PM2) — ZERO AI IMPORTS     │
│ or OpenAI/Anthropic/custom │      │ maintenance lane (concurrency 1):  │
└────────────────────────────┘      │  'cleanup' @ 03:15 UTC (retention) │
                                    │  'recompute-windowed-uptime' @     │
  ┌──────────────────────────┐      │   nightly pattern (new scheduler)  │
  │ PostgreSQL (source of     │◀────▶│  backfill/recompute from pings:    │
  │ truth)                   │      │   per-window (total, down) counts  │
  │ monitors + uptime24h/7d/ │      │   → D-36 binary extraction (no     │
  │ 30d (migration 0004,     │      │   round()) → UPDATE monitors        │
  │ additive, rehearsed)     │      └────────────────────────────────────┘
  │ pings (30d retention)    │      lifetime counters/writers UNCHANGED;
  └──────────────────────────┘      dashboard/status keep displaying them
```

Trace the primary use cases: an authorized user clicks "Generate post-mortem" → flag+session+limiter pass → evidence assembled server-side → markdown streams into the inline card → Stop/Copy/Regenerate; nothing is written back. The worker's nightly pass computes windowed uptime from pings into new columns that no v1 surface reads.

### Recommended Project Structure

```
src/
├── lib/
│   └── ai/                        # D-01 provider layer (mirrors lib/email)
│       ├── index.ts               # env triple + throw-early selection + cached instance
│       └── providers/             # one factory per provider value (glm/openai/anthropic/custom)
├── app/api/ai/
│   ├── post-mortem/route.ts       # useCompletion target (UIMessage stream)
│   └── monitor-assistant/route.ts # useObject target (text stream of partial JSON)
├── components/
│   ├── ui/dialog.tsx              # ADDED this phase (Radix variant verified)
│   ├── ui/alert-dialog.tsx        # ADDED this phase (Radix variant verified)
│   ├── Dashboard/                 # tier-1 redesign + AI surfaces mount here
│   └── (form/, Status/, common/ unchanged paths)
├── db/schema.ts                   # + uptime24h/uptime7d/uptime30d (gate-protected)
├── worker/
│   ├── maintenance.ts             # + 'recompute-windowed-uptime' job + windowed SQL
│   └── scheduler.ts               # + nightly upsertJobScheduler for the recompute
└── drizzle/0004_windowed_uptime.sql  # additive, rehearsed via 03-05 pipeline
```

### Pattern 1: `lib/ai` provider selection (D-01/D-02 — email-pattern mirror)

**What:** env-selected provider with throw-early validation, cached instance, web-process only.
**When to use:** the single resolution point both AI routes consume. [VERIFIED: src/lib/email/index.ts:43-61 — the exact pattern mirrored; the AI variant adds the `AI_ENABLED` master gate before any env read]

```typescript
// Shape mirroring src/lib/email/index.ts (verbatim selection discipline):
//   unknown value THROWS on every call until fixed; unset is never a valid
//   "enabled" state — D-02: incomplete/unknown config fails loud at boot
//   when AI_ENABLED=true.
export function getAiModel(): LanguageModel {
  if (process.env.AI_ENABLED !== "true") {
    throw new Error("[lib/ai] getAiModel called with AI_ENABLED off — routes must gate first");
  }
  const provider = process.env.AI_PROVIDER;      // glm | openai | anthropic | custom
  const model = process.env.AI_MODEL;            // e.g. glm-4.6 (confirm at flip)
  const apiKey = process.env.AI_API_KEY;
  if (!provider || !model || !apiKey) throw new Error(/* throw-early, 06 D-11 lineage */);
  switch (provider) {
    case "glm":
      return createOpenAICompatible({
        name: "glm",
        baseURL: "https://api.z.ai/api/paas/v4",
        apiKey,
        includeUsage: true, // token usage in streaming responses (D-10)
      })(model);
    // openai/anthropic/custom branches per D-02; default: throw (unknown value)
  }
}
```
`createOpenAICompatible({ name, apiKey, baseURL, includeUsage })` returns a provider callable as `provider('model-id')`. [CITED: https://ai-sdk.dev/providers/openai-compatible-providers]

### Pattern 2: Streaming route handler (D-07 — post-mortem)

**What:** SDK-primitive streaming with the full guard chain. AI SDK 7 form (stateless helpers, not result-level `toUIMessageStreamResponse`):
```typescript
// Source: https://ai-sdk.dev/docs/ai-sdk-ui/completion (v7 form)
import { createUIMessageStreamResponse, streamText, toUIMessageStream } from "ai";

export async function POST(req: Request) {
  // 1-5: flag gate → session guard → limiter → cap (omitted here)
  const result = streamText({
    model,                                  // from lib/ai
    instructions: "...",                    // v7: system → instructions
    prompt,
    maxRetries: 0,                          // D-09: no silent auto-retry (default is 2)
    abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    onEnd: ({ usage }) => logAiRequest({ feature, userId, model, tokens: usage.totalTokens, ... }),
    onAbort: () => logAiAbort({ feature, userId }),
  });
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),  // v7: fullStream → stream
    consumeStream: true,   // avoids hanging connections when the client aborts (Stop)
  });
}
```
[CITED: https://ai-sdk.dev/docs/ai-sdk-ui/completion · https://ai-sdk.dev/docs/advanced/stopping-streams · https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0] Client: `useCompletion({ api: "/api/ai/post-mortem", credentials: "same-origin" })`; `stop()` aborts the fetch and — because the route forwards `req.signal` — cancels the upstream call; `error`/`onError` render the D-09 inline error + Retry.

### Pattern 3: Assistant structured streaming (D-17/D-19 — `useObject`)

**What:** natural language → partial form-field JSON, schema-validated.
```typescript
// Source: https://ai-sdk.dev/docs/ai-sdk-ui/object-generation (v7 form)
import { Output } from "ai"; // Output.object({ schema }) — v7 uses streamText + Output

const assistantSchema = z.object({
  name: z.string().describe("Monitor name"),
  url: z.string().describe("Target URL to watch"),
  interval: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(30), z.literal(60)])
    .describe("Check interval in minutes: one of 1, 5, 10, 30, 60"),
});

const result = streamText({
  model, output: Output.object({ schema: assistantSchema }), prompt, /* guards as Pattern 2 */
});
return createTextStreamResponse({ stream: toTextStream({ stream: result.stream }) });
```
Client: `const { object, submit, isLoading, stop, error, onFinish } = useObject({ api: "/api/ai/monitor-assistant", schema: assistantSchema })` — `object` is the **partial** object (fields undefined until streamed), which IS D-19's partial fill; `onFinish({ object, error })` flags schema-invalid fields for the "fill manually" hint. The form's own submit validation remains the single gate (AI-04). [CITED: https://ai-sdk.dev/docs/ai-sdk-ui/object-generation]

### Pattern 4: Nightly windowed recompute on the maintenance lane (DAT-11)

**What:** second named job on the existing lane; unconditional from ship (D-22).
- Dispatcher: `processMaintenanceJob` currently throws on any name except `"cleanup"` — quote verbatim: `` `processMaintenanceJob: unknown maintenance job name '${job.name}' (expected 'cleanup')` `` [VERIFIED: src/worker/maintenance.ts:367-369]. Extend the accepted-name set (or dispatch to a sibling processor registered on the same lane worker — the lane wiring is `startMaintenanceLaneWorker((job) => processMaintenanceJob(job))` [VERIFIED: src/worker/index.ts:179]).
- Scheduler: add a fifth `upsertJobScheduler` beside the existing four [VERIFIED: src/worker/scheduler.ts:339-438 — existing pattern: `MAINTENANCE_CLEANUP_PATTERN = "15 3 * * *"` at scheduler.ts:43] with its own cron pattern; maintenance lane runs at concurrency 1 (D-7 lineage) so a pattern near 03:15 serializes behind cleanup — pick a separated time (e.g. 04:00+ UTC) or accept the queueing.
- Compute: windowed counts from pings — `pings.status` carries `'UP' | 'DOWN'` [VERIFIED: src/worker/persist/tier1.ts:95 `targetStatus: "UP" | "DOWN"`; src/worker/persist/tier2.ts:118 `status: "UP" | "DOWN"`]. Window semantics mirror the lifetime writers: failure = `status='DOWN'`; uptime = (total − down)/total over `createdAt >= now() - interval`.
- **Rounding:** reuse the D-36 exact binary-extraction expression verbatim from the audit SQL [VERIFIED: src/worker/maintenance.ts:94-134 — the `::bigint` power-of-two shift, half-adder, integer floor division form]. Never `round()` (04-04 D-36 pin; both suites pin the shipped form).
- Dry-run discipline (WRK-13): the recompute job's report should follow the cleanup job's shape (report row counts; the scheduler template for the new job chooses the autonomous posture — cleanup runs `data: { dryRun: false }` [VERIFIED: src/worker/scheduler.ts:379]; D-22 says the recompute runs unconditionally from ship, so its template carries the write posture, with the manual enqueue script keeping explicit flags per the cleanup precedent).

### Pattern 5: Remnant-gate verify extensions (D-33/D-34)

**What:** the 05 D-41 lineage — `scripts/check-cron-remnants.mjs` was extended at the 06-05 deletion release [VERIFIED: .planning/STATE.md 06-05 decision]. The planner extends the same gate family with new legs: (a) `react-icons` absence (import specifier + dependency + the two file names), (b) `sweetalert2`/`Swal` absence, (c) optional but recommended: `lucide-react` absence (Pitfall 1 insurance), (d) optional rule-15 insurance: no `lib/ai` / `ai-sdk` import under `src/worker/**` (doubles AI-05 enforcement alongside `worker:boundary`). Wire into the `pnpm verify` chain (package.json scripts.verify) with RED spot-checks per the 06-05 discipline.

### Pattern 6: AI flag-off mechanics (D-21 zero trace)

**What:** with `AI_ENABLED=false` there must be zero AI trace in DOM, network, or copy.
- Route side: every `/api/ai/*` handler returns 404 (or equivalently inert) before reading the body — no AI package evaluation on the request path.
- Client side: the enabled bit must arrive from the server render (page/layout reads `process.env.AI_ENABLED` and passes a prop into the client tree). A runtime "is AI enabled?" fetch would itself be network trace when off — forbidden by D-21. Server components can read non-`NEXT_PUBLIC` env directly; the dashboard pages are server `page.tsx` files wrapping client components [VERIFIED: project route-group structure in .claude/CLAUDE.md §Conventions], so the prop drill exists without exposing the key material (only the boolean).
- `.env.example` gains `AI_ENABLED=` (default off), `AI_PROVIDER=`, `AI_MODEL=`, `AI_API_KEY=`, `AI_BASE_URL=` with DEP-05-style dated annotations; the commented GLM example per D-03.

### Anti-Patterns to Avoid

- **Result-level response helpers** (`result.toUIMessageStreamResponse()`) — deprecated in v7; use stateless `toUIMessageStream` + `createUIMessageStreamResponse`. [CITED: migration-guide-7-0]
- **`system:` option / `onFinish` / `fullStream`** — v7 renames (`instructions`, `onEnd`, `stream`) with deprecated fallbacks; write v7 names. [CITED: migration-guide-7-0]
- **Default `maxRetries` (2)** — silently retries on 429/5xx; violates D-09 cost control. Set 0.
- **`round()` anywhere near uptime math** — 04-04 D-36 pinned the exact binary-extraction form; both suites pin it.
- **Per-IP limiter keys for AI routes** — D-08 buckets are **per user** (`rl:ai_drafts_{userId}`); the session guard already established identity, which is also the WR-06-hardening direction.
- **Installing `lucide-react` or letting registry icon imports survive** — swap to hugeicons on add (sheet.tsx precedent: `import { Cancel01Icon as XIcon } from "hugeicons-react"` [VERIFIED: src/components/ui/sheet.tsx:4]).
- **`drizzle-kit push`** — forbidden; migration 0004 is generated, rehearsed (`rehearse:migrations`), and applied by the single runner.
- **Mechanically restyling untouched pages onto primitives** (D-35: redesign surfaces only).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Streaming transport + client state | Custom ReadableStream/fetch chunk parsing | `streamText` + `useCompletion`/`useObject` | D-07 explicitly; SDK handles backpressure, abort, partial JSON, error frames |
| Partial-object streaming for prefill | Manual JSON buffer + repair | `Output.object` + `useObject` | Invalid partial JSON is the SDK's problem; D-19 semantics fall out for free |
| Provider HTTP clients | Per-provider fetch wrappers | `@ai-sdk/*` factories + `createOpenAICompatible` | Auth headers, usage extraction, retry/abort semantics |
| Rate limiting | New limiter code | `rateLimit(identifier, {limit, windowMs})` + `resetSeconds` → 429 + `Retry-After` | D-08 reuses the Redis Lua limiter verbatim [VERIFIED: src/lib/rate-limit.ts:45-67] |
| Uptime rounding | `round(x, 2)` / JS toFixed | The D-36 SQL expression (maintenance.ts:94-134 form) | Tie-breaking float8/numeric collapse — the exact bug 04-04 fixed |
| Nightly scheduling | node-cron / setInterval in worker | `upsertJobScheduler` on the maintenance queue | Idempotent at boot (RES-05), existing lane priorities/telemetry |
| Confirm dialogs | New modal components | shadcn `alert-dialog` (Radix variant) | D-34; a11y/focus semantics included |
| Icons | Mixed imports / icon wrappers | `hugeicons-react` only | D-32/D-33 |
| Motion | New animation dep / CSS keyframe systems | installed `motion` v12 (+ `useReducedMotion`) | D-28 |

**Key insight:** every "clever" hand-roll in this phase's domains (stream parsing, JSON repair, rounding, retry loops) is already pinned by a locked decision to an existing library or an in-repo verified pattern.

## Runtime State Inventory

> Phase includes dep deletions (react-icons, sweetalert2) and a DB migration — refactor-adjacent categories audited.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Windowed columns do not exist yet; migration 0004 adds them (additive). No existing keys/collections reference deleted deps. Backfill target: pings retained 30 days [VERIFIED: src/worker/maintenance.ts:49 `PING_RETENTION_DAYS = 30`] | Migration + nightly backfill (code); no data migration of existing records |
| Live service config | PM2 ecosystem apps (web + worker); `.env` on the VPS gains `AI_*` + `WINDOWED_UPTIME_ENABLED` at the AI release/flip (D-38); Redis limiter keyspace grows `rl:ai_*` buckets (bounded by `noeviction` + 512 MB pin) | Runbook env additions dated per DEP-05; flip choreography documented |
| OS-registered state | None — no scheduled tasks/service names reference `react-icons`/`sweetalert2` (browser-only deps) | None — verified by scope: both deps are client-bundle libraries, no OS surface |
| Secrets/env vars | New: `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, `AI_BASE_URL`, `AI_ENABLED`, `WINDOWED_UPTIME_ENABLED` — all documented in `.env.example` with names/purposes only [VERIFIED: .env.example read this session; FND-07 contract] | `.env.example` additions; `.env` never committed |
| Build artifacts | `.next` client bundles re-embed on rebuild — deleted deps vanish from the bundle automatically; drizzle journal grows to 5 entries (0000-0003 exist [VERIFIED: drizzle/ listing]); rehearse-migrations carve-out inventory may need the new columns appended (Phase-7 rule: extend the list, not the pipeline) | Rebuild + rehearsal with extended carve-out list |

**Canonical question answer:** after the repo sweep, no runtime system holds old strings — the two deleted deps are browser-side only, and the DB change is purely additive columns.

## Common Pitfalls

### Pitfall 1: components.json `iconLibrary` staleness (lucide)
**What goes wrong:** `pnpm dlx shadcn@latest add dialog alert-dialog` delivers files importing `lucide-react`.
**Why:** `components.json` line 13 reads `"iconLibrary": "lucide"` [VERIFIED: components.json:13 — verbatim: `"iconLibrary": "lucide"`] while zero lucide usage exists.
**How to avoid:** On add, swap every lucide import to a hugeicons equivalent in the same edit (sheet.tsx precedent at src/components/ui/sheet.tsx:4). NEVER install `lucide-react`. Optionally add a remnant-gate leg for `lucide-react` (cheap insurance).
**Warning signs:** `pnpm add lucide-react` appearing in any task; unswapped `lucide-react` imports in `src/components/ui/dialog.tsx`/`alert-dialog.tsx`.

### Pitfall 2: shadcn's Base-UI default (July 2026)
**What goes wrong:** the added dialog/alert-dialog are built on `@base-ui-components/react` (Base UI became shadcn's default library in July 2026 [CITED: https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default]) — a second primitive substrate incompatible with the project's 10 Radix primitives.
**Why:** this project's `components.json` has **no explicit library/base field**; `shadcn info` resolved base `radix` on 2026-09-30 (UI-SPEC), but that resolution is inferred, not declared.
**How to avoid:** after `add`, verify the delivered files import `radix-ui` / `@radix-ui/react-dialog` / `@radix-ui/react-alert-dialog` (sheet.tsx imports `@radix-ui/react-dialog` [VERIFIED: src/components/ui/sheet.tsx:3]) and NOT `@base-ui-components/react`; if the Base variant arrives, re-run with explicit radix selection or hand-port from the Radix docs tab. Also expect API-shape tells: the Base docs' `AlertDialogTrigger render={<Button/>}` prop is a Base-UI idiom; the Radix variant uses `asChild`.
**Warning signs:** `@base-ui-components/react` in the install plan; `render=` props in the delivered files.

### Pitfall 3: Writing AI SDK 5-era API from training memory
**What goes wrong:** code uses `system`, `onFinish`, `fullStream`, `result.toUIMessageStreamResponse()` — deprecated aliases at best in v7; some (stateless-helper expectations) break patterns.
**Why:** AI SDK moved two majors since common training data; v6 and v7 migration guides exist [CITED: https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0].
**How to avoid:** executor tasks reference Pattern 2/3 shapes in this doc; typecheck (`pnpm typecheck` in verify) catches wrong names where aliases don't exist.
**Warning signs:** deprecated-alias lint/console notes; `totalUsage` references (removed concept).

### Pitfall 4: ESM-only SDK vs worker/tooling
**What goes wrong:** `require()` of `ai` fails; worker bundle or scripts importing AI packages break at build.
**Why:** AI SDK 7 packages are ESM-only [CITED: migration-guide-7-0 "all packages are ESM-only"].
**How to avoid:** keep AI imports web-route-only (which rule 15 demands anyway); tsup worker target never sees them; Node pin `>=22 <25` satisfies the SDK's Node 22+ requirement. A `lib/ai` import under `src/worker/**` would fail the boundary gate (Pattern 5d).
**Warning signs:** worker build errors resolving `ai`.

### Pitfall 5: Client "Stop" not cancelling the upstream call
**What goes wrong:** `stop()` aborts the browser fetch but the provider stream (and billing) continues server-side.
**Why:** the route must forward the request signal: `abortSignal: req.signal` (composed with the timeout) [CITED: https://ai-sdk.dev/docs/advanced/stopping-streams]; also pass `consumeStream: true` so an aborted stream still drains (memory/hanging-connection protection).
**How to avoid:** Pattern 2 verbatim; D-16's Stop affordance is only honest if the server honours it.
**Warning signs:** token logs continuing after a Stop in the D-10 log line.

### Pitfall 6: Reintroducing `round()` in windowed uptime
**What goes wrong:** `.xx5` ties round wrong (float8→numeric shortest-round-trip collapse) — the exact 04-04 defect class.
**Why:** The lifetime writers and the D-37 audit use the power-of-two `::bigint` extraction [VERIFIED: src/worker/maintenance.ts:94-134].
**How to avoid:** the windowed recompute SQL is the D-36 expression with window-scoped counts substituted; a characterization-style test pins windowed values against the lifetime derivation on identical inputs.
**Warning signs:** any `round(` in the new SQL; disagreement between windowed 30d and lifetime on a young monitor with full retention.

### Pitfall 7: Migration without the rehearsal pipeline / schema-gate drift
**What goes wrong:** hand-authored SQL drifts from schema.ts; the structural pull-diff gate fails; or the migration lands un-rehearsed against prod.
**Why:** `drizzle-kit push` is forbidden; changes ship as versioned migrations through the single runner with `rehearse:migrations` (03-05 pipeline) — Phase 7 extended the carve-out inventory rather than the pipeline [VERIFIED: STATE.md 07 drop-release decision].
**How to avoid:** edit `src/db/schema.ts` (gate-protected file — coordinate with the gate), `drizzle-kit generate`, extend the rehearsal carve-out list with the new columns, rehearse, deploy expand-phase.
**Warning signs:** schema:gate red in verify; journal count mismatches in rehearse-migrations.

### Pitfall 8: Rate-limit key design (per-user, not per-IP)
**What goes wrong:** AI buckets keyed on `getIP(req)` — shared-NAT users collide and spoofable headers mint counters (the WR-06 concern).
**Why:** D-08 pins **per-user** buckets; the session guard runs first so `session.user.id` is available.
**How to avoid:** `rateLimit(`ai_drafts_${session.user.id}`, { limit: 10, windowMs: 3_600_000 })` — the limiter prefixes `rl:` itself [VERIFIED: src/lib/rate-limit.ts:51 `const key = `rl:${identifier}``]; 429 responses carry `Retry-After: ${resetSeconds}` (06 D-06 shape; `resetSeconds` exists exactly for this [VERIFIED: src/lib/rate-limit.ts:8-17]).
**Warning signs:** `getIP` appearing in AI routes; 429s without Retry-After.

### Pitfall 9: The Add Monitor form is useState, NOT react-hook-form
**What goes wrong:** the assistant prefill is planned against `setValue()` from react-hook-form that doesn't exist on this form.
**Why:** 08-CONTEXT's anchor says "Add Monitor form (`src/components/form/`, react-hook-form)" but the actual Add Monitor UI is three `useState` fields inside Dashboard.tsx — `newMonitorName`, `newMonitorUrl` (`newMonitorInterval` with `setNewMonitorInterval(Number(e.target.value))` [VERIFIED: src/components/Dashboard/Dashboard.tsx:37-39, 758-760]); `react-hook-form` is used only by `src/components/form/MyForm*` (used elsewhere, e.g. auth flows) [VERIFIED: src/components/form/MyFormSelect.tsx:2 `import { Controller, useFormContext } from "react-hook-form"`].
**How to avoid:** prefill = setState calls from the streamed partial object (or the form's re-host inside a shadcn dialog keeps the same state model). The "same schema as the manual form" (AI-04) is the create-route's POST validation (`/api/monitors` trimmed inputs + SSRF admission + interval enum), which the normal submit already exercises [VERIFIED: src/app/api/monitors/route.ts POST section].
**Warning signs:** tasks referencing `useForm`/`setValue` for the Add Monitor dialog.

### Pitfall 10: Hydration-unsafe URL derivation (the concrete site)
**What goes wrong:** server HTML renders `""`, client first render renders the origin — React 19 hydration mismatch.
**Why:** `src/components/Dashboard/DashboardStatus.tsx:57-59` computes `publicUrl` with `typeof window !== "undefined"` inline in render — verbatim: `` const publicUrl = typeof window !== "undefined" && session?.user?.id ? `${window.location.origin}/status/${session.user.id}` : ""; `` [VERIFIED: src/components/Dashboard/DashboardStatus.tsx:57-59].
**How to avoid:** derive in an effect with a mounted guard (02-07 precedent: mounted via `useSyncExternalStore(no-op subscribe, ()=>true, ()=>false)` [VERIFIED: STATE.md 02-07 decision]) or compute from a stable env base; `useParams()` (already used by MonitorDetails [VERIFIED: src/components/Dashboard/MonitorDetails.tsx:44-45]) is the hydration-safe param source; note `useSearchParams()` requires a Suspense boundary on prerendered routes or the production build fails [CITED: https://nextjs.org/docs/app/api-reference/functions/use-search-params].
**Warning signs:** hydration mismatch errors in dev console on `/dashboard/status`; `window.` reads at render top-level.

### Pitfall 11: Polling fetches without abort + interval leaks
**What goes wrong:** unmount during an in-flight 30s fetch setState-after-unmount or overlapping requests.
**Why:** `fetchMonitors` is a bare `fetch("/api/monitors")` [VERIFIED: src/components/Dashboard/Dashboard.tsx:61] on a 30s `setInterval` (clearInterval exists — the clear discipline is already a gate; the abort is missing); MonitorDetails has the same shape at its interval [VERIFIED: src/components/Dashboard/MonitorDetails.tsx:86].
**How to avoid:** mirror the existing check-now poll discipline — `checkPollAbortRef` + `new AbortController()` + `signal` on fetch + `aborted` re-check [VERIFIED: src/components/Dashboard/Dashboard.tsx:194-226] and the abort-aware sleep in `src/lib/check-now-poll.ts:45-57`.
**Warning signs:** fetches without `signal:`; `setInterval` without cleanup in touched components.

### Pitfall 12: Duplicate Toaster
**What goes wrong:** two toast mounts → double toasts.
**Why:** `src/app/(dashboardLayout)/dashboard/layout.tsx:6` keeps an unused `import { Toaster } from "sonner"` while the root layout mounts `<ThemedToaster />` [VERIFIED: src/app/layout.tsx:7,32; src/components/theme/ThemedToaster.tsx].
**How to avoid:** delete the dashboard-layout import (UI-SPEC dialog map already pins this); keep root `ThemedToaster` with `richColors`/`top-right` + resolved theme (UI-03 token rule 5).

## Code Examples

### UI-02: verified icon replacements (installed package, this session)

`react-icons` call sites and their hugeicons-react@0.4.0 replacements — replacement exports verified by importing the installed package (4654 exports):

| File | Current import [VERIFIED] | hugeicons replacement [VERIFIED: package import] |
|------|---------------------------|--------------------------------------------------|
| `src/components/form/MyFormSelect.tsx:4` | `import { FaChevronDown, FaChevronUp } from "react-icons/fa"` | `import { ArrowDown01Icon, ArrowUp01Icon } from "hugeicons-react"` |
| `src/components/form/MyFormInput.tsx:7` | `import { FiEye, FiEyeOff } from "react-icons/fi"` | `import { ViewIcon, ViewOffIcon } from "hugeicons-react"` |

### DAT-11: windowed recompute SQL shape (sketch — counts substituted into the D-36 expression)

```sql
-- Windowed counts mirror the lifetime writers: failure = status='DOWN'
-- (tier1/tier2 ping status vocabulary: 'UP' | 'DOWN').
-- THEN feed (total, down) through the D-36 binary-extraction expression
-- from src/worker/maintenance.ts:94-134 (power-of-two ::bigint shift,
-- half-adder, floor division) — never round().
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'DOWN')::int AS down
  FROM pings
 WHERE "monitorId" = $1
   AND "createdAt" >= (now() - make_interval(days => $2));
```

### 429 response (06 D-06 shape, reused for AI)

```typescript
const rl = await rateLimit(`ai_drafts_${session.user.id}`, { limit: 10, windowMs: 3_600_000 });
if (!rl.success) {
  return NextResponse.json(
    { error: "Too many AI requests — try again later." },
    { status: 429, headers: rl.resetSeconds !== undefined ? { "Retry-After": String(rl.resetSeconds) } : {} }
  );
}
```
[VERIFIED: src/lib/rate-limit.ts — `rateLimit(identifier, options)` signature and `resetSeconds` semantics; the limiter prefixes `rl:` itself]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| AI SDK 5 (`system`, `onFinish`, `fullStream`, `result.toUIMessageStreamResponse()`) | AI SDK 7 (`instructions`, `onEnd`, `stream`, stateless `toUIMessageStream` + `createUIMessageStreamResponse`) | v6 then v7 releases (migration guides live) | All AI code this phase writes v7 names |
| Radix as shadcn's only base | Base UI default; Radix still supported/served | 2026-07 (shadcn changelog) | Variant verification on every `add` |
| Sweetalert/window.confirm dialogs | shadcn alert-dialog + sonner | this phase (D-34) | One dialog system, dep deleted |
| react-icons alongside hugeicons | hugeicons only | this phase (D-33) | One icon system, dep deleted |
| `.dark` byte-freeze (migration era) | both-mode redesign on the same tokens | this phase (D-31 lifts the freeze; dark default values unchanged) | 11 same-value tokens may split per-mode where light legibility requires |

**Deprecated/outdated to avoid:** deprecated v7 aliases (`system`, `onFinish`, `onStepFinish`, `fullStream`, `totalUsage`), `round()` in uptime math, `sweetalert2`, `react-icons`, `lucide-react` (never present).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | GLM model id for the `.env.example` commented example — `glm-4.6` recommended; secondary sources also name `glm-4.5`, `glm-4.5-air`; `glm-5.x` mentions are unverified | Standard Stack / Pattern 1 | Wrong id = provider 4xx at first flip; trivially fixed by editing `AI_MODEL` (env, not code). Confirm on Z.ai docs/pricing at flip time |
| A2 | `AbortSignal.any([req.signal, AbortSignal.timeout(N)])` composes the two bounds in Node 22 | Pattern 2 | Fallback: manual listener composition. Node ≥20.3 supports `AbortSignal.any` per web-standards knowledge — not verified against Node docs this session |
| A3 | Playwright can drive the AI UI against a stub provider (`AI_PROVIDER=custom` + `AI_BASE_URL` → local stub server) — webServer env-injection precedent exists (07-03) | Validation Architecture | If streaming stubbing proves brittle, e2e falls back to flag-off assertions + handler-level streaming unit tests |
| A4 | Exact token caps (e.g. prompt ≤ 2000 chars, ping-window lead-in ≤ N rows) — left to planner within AI-02 bounds | Discretion areas | None — explicitly discretion |
| A5 | Windowed column nullability (recommended nullable, NULL = no pings in window) — CONTEXT leaves "column shapes" to discretion | Pattern 4 | v2 display decision; either shape is additive and reversible by later migration |
| A6 | `@ai-sdk/openai`/`@ai-sdk/anthropic` may be deferred (install only when their provider branches ship) while the selection map still throw-early enumerates them | Standard Stack | Unknown-value throw requires the value set decided at build time; deferring packages means their env values throw "not built" — acceptable but must be documented in `.env.example` |

## Open Questions

1. **Ship openai/anthropic provider branches now or GLM+custom only?**
   - What we know: D-02 enumerates OpenAI/Anthropic/GLM/OpenRouter/custom as swappable targets; only GLM is the day-1 default.
   - What's unclear: whether the release installs `@ai-sdk/openai`/`@ai-sdk/anthropic` or the map throw-earlies on those values until needed.
   - Recommendation: implement the full env-value map with packages installed (they're tiny; avoids a code change at swap time), but this is planner discretion per D-02's "swap = edit env".
2. **Recompute scheduler time relative to the 03:15 cleanup** — serialize behind cleanup on the concurrency-1 lane or schedule separately (e.g. 04:00 UTC)? Discretion; recommend a separated pattern so retention deletes never delay the recompute.
3. **`WINDOWED_UPTIME_ENABLED` with zero v1 readers** — ship as a documented `.env.example` entry + tiny read-helper consumed only by tests (recommended), or defer the env var entirely to v2? D-22 says the flag gates reads and nothing reads; planner picks the honest minimal form.
4. **E2E depth for AI surfaces** — functional Playwright with a stub provider (A3) vs handler-level only. Discretion per CONTEXT; recommend stub-based happy-path e2e for the partial-fill backstop (UI-SPEC marks it 🧪).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node (>=22 <25) | AI SDK 7 ESM/Node 22+ | ✓ (engines pinned) | per engines | — |
| pnpm 10.34.5 | installs | ✓ | 10.34.5 | — |
| Redis (test stack :6390) | limiter tests, verify | ✓ (docker-compose.test.yml in verify chain) | redis:8-alpine | — |
| PostgreSQL (test stack :5453) | migration recompute tests, schema:gate | ✓ (docker-compose.test.yml) | — | — |
| Z.ai API key | live AI smoke at flip (D-38) | operator-held (D-03 premise) | — | flip-time gate; not needed for build/tests |
| shadcn CLI | `pnpm dlx shadcn@latest add dialog alert-dialog` | ✓ (dlx; 4.21.0 proven 2026-09-30 per UI-SPEC) | latest | — |

**Missing dependencies with no fallback:** none — all execution-time deps are present; the only external credential (Z.ai key) is needed solely at the post-flip live smoke, by design (D-38).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4 (unit/integration/handler) + Playwright 1.63 (e2e/api projects) [VERIFIED: package.json devDependencies; playwright.config.ts projects `e2e` + `api`, testMatch `/\.spec\.ts$/`] |
| Config file | `vitest.config.ts` (+ `vitest.config.resilience.ts` for test:resilience); `playwright.config.ts` |
| Quick run command | `pnpm vitest run tests/<file>` (single file) |
| Full suite command | `pnpm verify` (lint → typecheck → test → schema:gate → worker:boundary → denylist:diff → build → cron:remnants → e2e) [VERIFIED: package.json scripts.verify] |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AI-01 | flag off → routes 404/inert; zero AI keys needed for verify green | unit (handler harness) | `pnpm vitest run tests/api/ai-routes.handler.test.ts -t "flag off"` | ❌ Wave 0 |
| AI-01 | UI renders zero AI trace when off (D-21) | e2e | `pnpm test:e2e -- --grep "AI flag off"` | ❌ Wave 0 |
| AI-02 | 401 without session; 429 + Retry-After per-user buckets; input cap; timeout path | unit (handler harness, tests/api/_harness.ts pattern) | `pnpm vitest run tests/api/ai-routes.handler.test.ts` | ❌ Wave 0 |
| AI-02 | provider selection throw-early (each env triple state) | unit | `pnpm vitest run tests/lib/ai-provider.test.ts` | ❌ Wave 0 |
| AI-02/09 | streaming route returns UIMessage/text stream (stub model) | unit + e2e stub | `pnpm vitest run tests/api/ai-stream.handler.test.ts` | ❌ Wave 0 |
| AI-03 | post-mortem composes incident+pings evidence; nothing written (no DB writes) | unit | `pnpm vitest run tests/api/ai-post-mortem.test.ts` | ❌ Wave 0 |
| AI-04 | assistant output validates against the create-route schema; partial-fill mapping | unit | `pnpm vitest run tests/api/ai-assistant.test.ts` | ❌ Wave 0 |
| AI-05 | no `lib/ai`/`ai-sdk` import under `src/worker/**` | gate | `pnpm worker:boundary` (extended) | ✓ (extend) |
| DAT-11 | windowed SQL math agrees with D-36 derivation on identical inputs | integration (test DB) | `pnpm vitest run tests/worker/windowed-uptime.test.ts` | ❌ Wave 0 |
| DAT-11 | maintenance dispatcher accepts new job name; scheduler upserted | unit | `pnpm vitest run tests/worker/maintenance-windowed.test.ts` | ❌ Wave 0 |
| DAT-11 | migration 0004 additive + rehearsed (carve-out list extended) | rehearsal | `pnpm rehearse:migrations` | ✓ (extend list) |
| UI-02/D-33 | react-icons/sweetalert2 remnant gates RED on re-introduction | gate | `pnpm verify` (extended gate legs) | ✓ (extend) |
| UI-04 | polling fetches abort on unmount; timers clear; single Toaster; hydration-safe URL | unit/e2e | `pnpm test:e2e` + component tests | ❌ Wave 0 |
| UI-05 | characterization + contract suites stay green (criterion 5) | regression | `pnpm test && pnpm test:e2e` | ✓ |

### Sampling Rate
- **Per task commit:** `pnpm vitest run <touched-suite>` (+ `pnpm lint && pnpm typecheck` fast loop)
- **Per wave merge:** `pnpm verify`
- **Phase gate:** full verify green before `/gsd:verify-work`; three release soaks per D-37 with deploy-record evidence; AI flip smoke per D-38.

### Wave 0 Gaps
- `tests/api/ai-*.handler.test.ts` — AI route contracts (session/flag/limiter/cap/streaming)
- `tests/lib/ai-provider.test.ts` — env-triple selection matrix (mirrors email provider tests)
- `tests/worker/windowed-uptime.test.ts` + `maintenance-windowed.test.ts` — recompute math + dispatcher
- Extended gate legs: react-icons/sweetalert2 remnants (+ optional lucide-react, AI-in-worker) in the cron-remnants family, wired into `pnpm verify`
- E2E: stub-provider AI specs + flag-off zero-trace spec; UI robustness specs (Playwright `api`/`e2e` projects)
- Characterization/contract suites (tests/api/*, tests/worker/*, characterization lineage) must remain untouched-green — the regression net for criterion 5

## Security Domain

`security_enforcement: true`, ASVS level 1, block on high (config). Phase surfaces: new authenticated streaming endpoints, provider key handling, dep deletions, DB migration.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | yes (AI routes) | Better Auth server session via existing `getAuthSession()` (`src/lib/session`) — no new auth surface [VERIFIED: src/app/api/monitors/route.ts:27-30 precedent] |
| V3 Session Management | yes (inherited) | Existing Better Auth cookie sessions; AI routes add no cookies/tokens |
| V4 Access Control | yes | `AI_ENABLED` master gate (D-04/D-21) + per-user data scoping: post-mortem evidence must verify monitor ownership (`userId`) before assembly — monitor id comes from the request; incidents/pings join through the user's monitor |
| V5 Input Validation | yes | JSON body caps (prompt/description length), incident/monitor id shape validation, assistant output re-validated by the create-route schema (AI-04); zod for the assistant schema (SDK-native) |
| V6 Cryptography | no new | Keys transit via env only; no new crypto |
| V7 Error Handling | yes | No stack traces in AI error responses (FND-07 lineage); D-09 inline error + Retry; stream errors never echo provider internals |
| V8 Data Protection | yes | `AI_API_KEY` never client-exposed (only the enabled boolean crosses to the client — Pattern 6); D-10 log lines carry ids/counts/tokens only, never prompt bodies or URLs (T-04-28 discipline in maintenance.ts) |

### Known Threat Patterns for AI-endpoint + streaming stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt/evidence injection via monitor names/URLs into post-mortem prompt | Tampering | Treat DB strings as data in prompts (delimit evidence sections); output is copy-only markdown rendered safely (never dangerouslySetInnerHTML without sanitization); nothing executes from output (D-13) |
| Cost abuse / DoS on provider | DoS (availability/financial) | Per-user Redis buckets (D-08), input caps, `maxRetries: 0`, timeout bounds, D-10 per-request token line for anomaly visibility |
| Unauthenticated streaming access | Spoofing/Elevation | Session guard before limiter/provider; flag-off = 404 (no surface to probe, D-21) |
| Key leakage via env or client bundle | Information Disclosure | `AI_*` read only in `lib/ai` (server); never `NEXT_PUBLIC_`; enabled-flag propagation is boolean-only |
| IDOR on incident/monitor evidence | Elevation | Ownership scoping (`session.user.id` ↔ monitor.userId) before evidence assembly — mirror the `/api/monitors` scoping precedent |
| Rate-limit bypass via key spoofing | Spoofing | Per-USER keys (not IP) post-auth — spoofing surface removed (Pitfall 8) |
| SSRF via assistant-generated URLs | Tampering | Assistant output is prefill only; the create route re-runs `assertUrlAllowed` (SSRF admission) on submit — AI-04's "same schema as the manual form" includes the existing SSRF gate [VERIFIED: src/app/api/monitors/route.ts imports assertUrlAllowed] |
| Rowhammer of the AI stream into DB writes | Tampering | D-13: no write path exists from AI routes (assert in tests: zero DB write calls on AI routes) |

## Sources

### Primary (HIGH confidence)
- npm registry (`npm view`) — ai@7.0.123, @ai-sdk/react@4.0.126, @ai-sdk/openai@4.0.82, @ai-sdk/anthropic@4.0.69, @ai-sdk/openai-compatible@3.0.60 (2026-09-30)
- ai-sdk.dev — `/docs/migration-guides/migration-guide-7-0` (v7 breaking changes), `/docs/ai-sdk-ui/completion` (useCompletion + route form), `/docs/ai-sdk-ui/object-generation` (useObject + Output.object), `/docs/advanced/stopping-streams` (abortSignal/onAbort/consumeStream), `/docs/ai-sdk-core/lifecycle-callbacks` (onEnd/usage), `/providers/openai-compatible-providers` (createOpenAICompatible), `/providers/community-providers/zhipu` (Z.ai baseURL pin)
- In-repo verified sources (Read this session): src/lib/rate-limit.ts, src/lib/email/index.ts, src/lib/check-now-poll.ts, src/lib/auth-client.ts, src/worker/maintenance.ts, src/worker/scheduler.ts, src/worker/index.ts (grep), src/db/schema.ts, src/components/ui/sheet.tsx, src/components/form/MyFormSelect.tsx, components.json, .env.example, package.json, src/app/api/monitors/route.ts, src/components/Dashboard/Dashboard.tsx (targeted), DashboardStatus.tsx (targeted), MonitorDetails.tsx (targeted), src/app/layout.tsx + dashboard layout (grep)
- hugeicons-react@0.4.0 export surface — verified by importing the installed package

### Secondary (MEDIUM confidence)
- ui.shadcn.com — dialog + alert-dialog component docs (Base-UI-era pages; Radix variants exist behind tabs)
- shadcn changelog "Base UI as the Default" (2026-07) + OpenReplay radix/base analysis — existing-Radix projects keep receiving Radix variants (via WebSearch)
- Z.ai model ids (glm-4.6/4.5/4.5-air) — secondary sources (Models5/inference.sh/gateway docs) via WebSearch; base URL corroborated by the AI SDK Zhipu provider docs (primary-adjacent)
- AI SDK streamText maxRetries default 2 / retryable status codes — docs summary + vercel/ai source reference via WebSearch

### Tertiary (LOW confidence)
- Node `AbortSignal.any` availability in Node 22 (web-standards training knowledge — A2)
- glm-5.x mentions (unverified speculation — ignored for recommendations)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every package version checked against npm this session; every API shape checked against ai-sdk.dev/shadcn docs; the one major-version drift (AI SDK 7 vs training-era 5) caught and corrected
- Architecture: HIGH — all integration points verified in-repo (rate limiter, session guard, maintenance lane, scheduler, schema, forms, dialog/icon sites); flag-propagation pattern derived from server-component structure
- Pitfalls: HIGH — 9 of 12 pitfalls verified against concrete file/line evidence this session; the 3 doc-sourced ones cite official pages

**Research date:** 2026-09-30
**Valid until:** 2026-10-30 (stack is fast-moving — AI SDK patches weekly; re-verify `ai` major and shadcn base-resolution behavior if planning slips past ~2 weeks)
