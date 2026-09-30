# Phase 8: Flagged Capabilities & UI Modernization - Context

**Gathered:** 2026-09-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Post-migration value lands on stable tokens and stable APIs — three deliverables, each revertible:

1. **AI behind a default-off flag** (AI-01..05) — a universal env-swappable provider layer in `lib/ai` under the Vercel AI SDK; two features: streaming incident post-mortem drafts (copy-only, never written to the DB) and a monitor-setup assistant that prefills the existing Add Monitor form; endpoints streaming, session-guarded, Redis rate-limited, input-capped, timeout-bound; zero AI anywhere in the check → transition → alert pipeline (rule 15).
2. **Windowed-uptime backend behind a read gate** (DAT-11) — per-window columns (24h/7d/30d) + nightly recompute from pings riding the worker's maintenance lane; lifetime counters remain the displayed numbers; nothing reads the windowed values in v1 (display switch is v2/PROD-01).
3. **UI modernization** (UI-01..05) — refresh + targeted layout improvements (not a ground-up relayout); shadcn adoption on redesign surfaces; full icon consolidation to Hugeicons (react-icons deleted); full dialog consolidation (sweetalert2 + window.confirm → shadcn alert-dialog + sonner, dep deleted); light mode intentional everywhere including WR-02 marketing surfaces; client robustness fixes (AbortController on polling fetches, cleared timers, hydration-safe URL derivation, single Toaster); both light and dark modes redesigned on the stable token set.

**Not in scope:** the windowed-uptime *display* switch (PROD-01, v2), any AI in the monitoring critical path, new admin UIs (feedback viewer — stays deferred), new user-facing product features of any kind (milestone is modernization only), brand/palette replacement, new font family, OAuth live-proof follow-up (Phase 999.1 backlog item).

Requirements: AI-01, AI-02, AI-03, AI-04, AI-05, DAT-11, UI-01, UI-02, UI-03, UI-04, UI-05.

</domain>

<decisions>
## Implementation Decisions

### AI provider abstraction (AI-01 / AI-02)

- **D-01: Universal env-swappable provider layer.** `lib/ai` exposes one provider abstraction under the Vercel AI SDK that can point at OpenAI, Anthropic, GLM (Z.ai), OpenRouter, or any custom OpenAI-compatible endpoint — mirroring the Phase-6 email provider-interface pattern (EML-01 lineage: env-selected, extensible).
- **D-02: Single env triple config.** `AI_PROVIDER` + `AI_MODEL` + `AI_API_KEY`, plus `AI_BASE_URL` when `AI_PROVIDER=custom`. One active provider at a time; swap = edit env. Incomplete/unknown config fails loud at boot when `AI_ENABLED=true` (throw-early, 06 D-11 lineage). No per-provider key blocks.
- **D-03: Z.ai GLM is the documented day-1 default** in `.env.example` (provider=glm + a GLM model id as the commented example) — the operator already holds a Z.ai account; zero new signup.
- **D-04: Single `AI_ENABLED` flag governs both features** (AI-01 verbatim). No per-feature sub-flags.
- **D-05: One `AI_MODEL` serves both features.** Per-feature overrides (AI_MODEL_SUMMARIZE / AI_MODEL_ASSISTANT) only if a real need appears (deferred).
- **D-06: All authenticated users see AI when enabled.** The env flag is the only gate — AI-02's session guard + rate limits still apply. No admin-first rollout stage.

### AI endpoint behavior (AI-02)

- **D-07: Streams via AI SDK primitives** — `streamText` server-side + the SDK's streaming hooks client-side. No custom ReadableStream chunk parsing.
- **D-08: Per-feature rate-limit buckets** reusing the Redis Lua limiter — drafts ~10/h per user, assistant ~20/h per user (exact values tunable in-plan); 429s carry `Retry-After` in the 06 D-06 shape.
- **D-09: Provider failure/timeout → clean inline error + user-initiated Retry.** No silent auto-retry loops (cost control); no hidden-degradation health probing.
- **D-10: One structured log line per AI request** (feature, userId, model, tokens in/out, duration) for cost visibility — no new metric machinery.

### Incident post-mortem draft (AI-03)

- **D-11: Generated from the incident blocks on the monitor detail page** — the evidence (pings) is already loaded there. The global incidents page is untouched.
- **D-12: Renders as an inline streaming card under the incident** — markdown as it arrives, Copy button at completion; no modal overlay hiding the evidence.
- **D-13: Copy-only.** Nothing is ever written to the DB — AI-03's "never auto-written to incidents" becomes never-written-at-all. No save-to-incident affordance (deferred).
- **D-14: Structured report sections:** Summary, Timeline (down detection → duration → recovery), Impact, Possible causes.
- **D-15: Evidence is incident-scoped:** this incident + its pings window + monitor identity (name/URL/interval). No cross-incident history or trend analysis.
- **D-16: Regenerate affordance** on both features, plus Stop while streaming on the draft.

### Monitor-setup assistant (AI-04)

- **D-17: Prefill inside the existing Add Monitor form.** An optional "describe it in plain words" input above the fields; the suggestion streams into the form fields; the normal form submit is the confirmation — same-schema validation happens for free, exactly AI-04's contract.
- **D-18: Create-only.** Edit flows keep their plain form (AI-04's "monitor-setup assistant" read verbatim); edit-assistance is deferred.
- **D-19: Partial fill + hint on validation failure.** Valid fields prefill; invalid fields stay empty with an inline "fill manually" hint. The schema remains the single gate at submit — never all-or-nothing.
- **D-20: Placeholder examples guide the input** (e.g. "Watch my portfolio site every 5 minutes").
- **D-21: Flag off = fully hidden.** With `AI_ENABLED=false` there is zero AI trace in the UI — no disabled buttons, no tooltips.

### Windowed-uptime backend (DAT-11)

- **D-22: The nightly recompute runs unconditionally from ship.** `WINDOWED_UPTIME_ENABLED` gates only reads (and nothing reads in v1) — columns populate silently every night, so the v2 display switch will find complete data. "Flag off changes nothing visible" holds trivially. — **Reversibility:** one-way — the per-window columns land via an additive Drizzle migration through the 03-05 rehearsal pipeline; undoing them is another migration plus re-planning.
- **D-23: First run backfills all three windows from retained ping history.** Retention keeps 30 days of pings — 24h/7d/30d windows are computable from night one (the whole point of "recompute from pings").
- **D-24: No v1 surface reads the windowed values.** Verification is tests + direct DB checks only; the display switch is v2 (PROD-01). No admin probe endpoint.

### Visual redesign (UI-01 / UI-03 / UI-05)

- **D-25: Refresh + targeted layout improvements.** Stats summary header on the dashboard, denser monitor list, cleaner monitor detail — page structure stays recognizable; no ground-up relayout.
- **D-26: Light mode becomes intentional everywhere.** WR-02's marketing surfaces (`text-white` Navbar/TeamSwitch headings, `bg-slate-950/80` header, `text-slate-300/400` copy — 02-UAT Decision Record 2026-09-12) become token-driven and light-legible, alongside the light dashboard/toast polish notes from the same record.
- **D-27: Depth order: dashboard + monitor detail deepest, public status page right behind** (visitors see it); auth + marketing get the palette/motion pass only.
- **D-28: Micro-interactions only** — staggered list entrances, status-change transitions, skeleton loaders via the already-installed `motion` v12. No page-transition theatrics, no heavier Lottie usage.
- **D-29: Refine the current visual identity** — the cyan-forward accent personality is kept and refined (contrast, semantic status colors, both modes); no new brand palette.
- **D-30: Same font family, refined type scale** — sizes, weights, line-heights, heading hierarchy. No new font wiring.
- **D-31: Both modes get the redesign on the same token set.** The migration-era dark freeze (byte-identical `.dark`) lifts with stable tokens and stable APIs (UI-05's premise). Dark remains the default.

### Icon & dialog consolidation (UI-02)

- **D-32: Hugeicons wins the icon consolidation** — the system named in PROJECT.md's target stack and the majority in newer components.
- **D-33: Full icon sweep + dep deletion.** Every `react-icons` site migrates to hugeicons equivalents; `react-icons` is removed from package.json; a remnant-gate-style verify check (D-41 lineage) keeps it out. — **Reversibility:** costly — undo means re-adding the dep and re-migrating every call site back past the verify gate.
- **D-34: Full dialog consolidation + dep deletion.** Every `sweetalert2` Swal call and every `window.confirm`/`window.alert` is replaced: destructive confirms → shadcn alert-dialog (primitive to be added — only Radix `dialog` exists today), informational popups → sonner toasts; `sweetalert2` is removed from package.json with the same verify-gate extension. — **Reversibility:** costly — same shape as D-33.
- **D-35: shadcn adoption sweeps the redesign surfaces only** (UI-01's "where sensible" = the surfaces the redesign opens); untouched pages are not mechanically restyled onto primitives.

### Release sequencing

- **D-36: Build/ship order: windowed-uptime backend → UI redesign → AI last.** The backend has no UI dependency; AI UX is built once on the final post-redesign primitives (inline cards, alert-dialog, prefill form all exist by then); each step de-risks the next.
- **D-37: One release per deliverable (three feature releases),** each soaked with `pnpm verify` + a short live window before the next — the house expand/contract discipline. The dep deletions (react-icons, sweetalert2) ride the redesign release with the remnant-gate extension.
- **D-38: AI ships dark, then flips.** The AI release deploys with `AI_ENABLED=false`; the app soaks fully AI-less; then the env flips and both features are smoke-tested live (Phase-4 dark-launch pattern; the flag is proven both ways in production).

### Claude's Discretion

- AI prompt wording/system prompts, exact token + input-size caps, and the post-mortem ping-window lead-in size (within AI-02's bounds).
- AI route paths (expected `/api/ai/*` shape) and `lib/ai` module layout.
- Exact rate-limit values within the D-08 anchors (~10/h drafts, ~20/h assistant).
- `@ai-sdk/*` provider package selection per provider value, incl. the Z.ai OpenAI-compatible endpoint wiring.
- Verify-gate grep patterns for the icon/dialog remnant gates (05 D-41 lineage).
- Windowed-uptime column shapes, the recompute job's exact scheduling within the maintenance lane, and the backfill query form (03-05 rehearsal pipeline applies to the migration).
- E2E posture for the redesign (functional Playwright e2e + manual UAT; characterization/contract suites stay green per criterion 5).
- Soak durations per release, deploy-record structure for 08, and the 02-08 follow-ups (11 same-value token review, mixed emerald/rose ternary migration) inside UI-03.
- Skeleton-loader placement, stagger choreography, and status-transition animation specifics within D-28.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase planning context
- `.planning/REQUIREMENTS.md` — AI-01..05, DAT-11, UI-01..05 requirement texts; PROD-01 (windowed display = v2); Out-of-Scope rows (AI in the monitoring path, windowed display switch mid-migration, new user-facing features)
- `.planning/ROADMAP.md` §"Phase 8" — goal, 5 success criteria, Mode: mvp, UI hint: yes
- `.planning/PROJECT.md` — hard constraints (rule 15: AI off the critical path; theme rule: redesign only in the final phase), target tech stack, deployment context

### Design authority
- `docs/ARCHITECTURE-AUDIT.md` — rules 4–6 & 15 (routes/AI boundaries), §16 (writer specs + lifetime uptime math the windowed recompute must agree with), §14 (job/queue topology — where the nightly recompute lands), §11/§21 (schema addenda the per-window columns extend)
- `docs/ARCHITECTURE-REVIEW.md` — verdict READY + §8 addenda lineage

### Prior phase decisions (locked — do not re-litigate)
- `.planning/phases/02-foundations-theme-infrastructure/02-UAT.md` — WR-02 Decision Record 2026-09-12 (marketing light-mode + dashboard/toast polish = Phase-8 scope — the D-26 input list)
- `.planning/phases/02-foundations-theme-infrastructure/02-CONTEXT.md` — theme token system, zero-hex gate, frozen-`.dark` history (lifted by D-31)
- `.planning/phases/06-thin-api-routes-email-abstraction/06-CONTEXT.md` — D-06 (429 + Retry-After shape), D-11 (throw-early env selection), D-21 (limiter coverage), D-29 (loud degradation), the email provider-interface pattern D-01 mirrors
- `.planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-CONTEXT.md` — D-33 (auth pages = same pixels until now), the `useAuthSession` accessor pattern (AI UI session reads), release discipline precedent
- `.planning/phases/05-worker-cutover-operational-hardening/05-CONTEXT.md` — D-41 (remnant-gate verify pattern D-33/D-34 extend), D-07 (expand/contract release structure D-37 follows)

### Codebase anchors (from scout)
- `src/components/ui/` — the 10 existing shadcn primitives (button, card, sheet, sidebar, dialog, dropdown, input, skeleton, tooltip, avatar, separator); alert-dialog must be added (D-34)
- `src/components/Dashboard/`, `src/components/Status/`, `src/components/common/DeleteModal.tsx` — the redesign surfaces + the Swal confirm pattern to migrate
- `src/app/globals.css` — `:root`/`.dark` token split (Phase-2 form); zero-hex gate lives in pnpm verify
- `src/lib/rate-limit.ts` — the Redis Lua limiter D-08 reuses
- `src/worker/queues.ts` + `src/worker/maintenance.ts` — the maintenance lane the nightly recompute rides (D-22/D-23)
- `src/db/schema.ts` — gate-protected Drizzle schema the per-window columns extend (single-runner migrations; 03-05 rehearsal pipeline applies)
- `src/lib/email/` — the provider-interface shape `lib/ai` mirrors (D-01)
- `src/components/form/` + Add Monitor form (`react-hook-form`) — the assistant's prefill target (D-17)
- `package.json` — `sweetalert2` / `react-icons` deletions (D-33/D-34); `motion`, `sonner`, `hugeicons-react` stay
- `.env.example` — `AI_*` + `WINDOWED_UPTIME_ENABLED` additions with DEP-05-style annotations

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/ui/*` shadcn primitives — the base D-35 adopts; `skeleton.tsx` already exists for D-28 loaders.
- `motion` v12 (installed) — all D-28 micro-interactions; no new animation dep.
- `sonner` (~71 usages, the primary toast API) — absorbs every informational Swal popup (D-34).
- `src/lib/rate-limit.ts` Redis Lua limiter — AI per-feature buckets (D-08) reuse it verbatim.
- `src/lib/email/` provider-interface + throw-early selection — the exact pattern `lib/ai` mirrors (D-01/D-02).
- Worker maintenance lane (`queues.ts`/`maintenance.ts`, dry-run + batched patterns) — the nightly windowed recompute rides it (D-22).
- `useAuthSession` accessor (`src/lib/auth-client`) — the AI UI's session read, single-importer rule intact.
- The 03-05 migration rehearsal pipeline — the per-window-column migration must go through it.

### Established Patterns
- Expand/contract releases with soak windows (05 D-07 / 06 D-26 / 07 D-29) — D-37's three-release structure.
- Dark-launch then env-flip (Phase 4 worker; 06 D-31 soak) — D-38's AI flip choreography.
- Remnant-gate verify legs (05 D-41, extended 06/07) — the icon/dialog deletion gates.
- Throw-early env validation (06 D-11) — AI env triple (D-02).
- 429 + `Retry-After` response shape (06 D-06) — AI rate-limit responses.
- Token discipline: zero-hex gate, byte-frozen `.dark` (now lifted by D-31 but the token *system* stays the redesign's substrate).

### Integration Points
- Add Monitor form (`src/components/form/`, react-hook-form) — assistant prefill target; the create-route schema is the validation gate (D-17/D-19).
- Monitor detail incident blocks — post-mortem inline card mount (D-11/D-12).
- `src/app/globals.css` tokens + `next-themes` — both-mode redesign substrate (D-31).
- Worker scheduler/maintenance queue — nightly recompute job registration.
- `src/db/schema.ts` + drizzle migrations — per-window columns (additive, rehearsed).
- New `/api/ai/*` routes — session-guarded streaming endpoints; web process only, never the worker's check path.

</code_context>

<specifics>
## Specific Ideas

- Assistant placeholder example: "e.g. Watch my portfolio site every 5 minutes" (D-20).
- Post-mortem sections verbatim: Summary, Timeline, Impact, Possible causes (D-14).
- Rate-limit anchors: drafts ~10/h per user, assistant ~20/h per user (D-08).
- `.env.example` day-1 default: `AI_PROVIDER=glm` + a GLM model id as the commented example (D-03).
- The WR-02 surface list (D-26 input): Navbar/TeamSwitch `text-white` headings, `bg-slate-950/80` header strip, `text-slate-300/400` marketing copy + the 02-UAT Test-4 polish notes (light dashboard contrast, light toast aesthetics).
- Dashboard targeted-layout candidates: stats summary header, denser monitor list, cleaner monitor detail (D-25).

</specifics>

<deferred>
## Deferred Ideas

- Per-feature AI model overrides (`AI_MODEL_SUMMARIZE` / `AI_MODEL_ASSISTANT`) — only if a real need appears (D-05).
- Edit-flow AI assistance for existing monitors — new capability beyond AI-04's wording (D-18).
- Optional save-to-incident for post-mortem drafts (user-initiated persistence) — declined for zero-schema-change (D-13).
- Admin-only probe for windowed values — declined; no v1 surface (D-24).
- Admin feedback viewer UI + Better Auth management endpoints + resend-verification affordance (deferred in 07-CONTEXT as "Phase 8 redesign territory") — remain deferred: new user-facing capabilities sit outside this milestone's modernization-only scope; revisit post-milestone.
- Windowed-uptime display switch (24h/7d/30d in dashboard/status UI) — v2 product decision (PROD-01).

</deferred>

---

*Phase: 8-Flagged Capabilities & UI Modernization*
*Context gathered: 2026-09-30*
