# Phase 8: Flagged Capabilities & UI Modernization - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-30
**Phase:** 8-Flagged Capabilities & UI Modernization
**Areas discussed:** AI provider & model, AI feature UX, Redesign ambition, Icon & dialog consolidation, Windowed-uptime semantics, Phase sequencing, Brand & typography

---

## Gray-area selection (round 1)

All four offered areas selected: AI provider & model, AI feature UX, Redesign ambition, Icon & dialog consolidation.

## AI provider & model

**Q: Which LLM provider sits behind the Vercel AI SDK?**

| Option | Description | Selected |
|--------|-------------|----------|
| OpenAI | Most mature AI SDK integration; broad model range; needs an OpenAI API key | |
| Anthropic | Claude models via @ai-sdk/anthropic; strong long-form drafting | |
| OpenRouter | One API key, hundreds of models incl. GLM; middleman dependency | |
| Z.ai GLM direct | GLM via OpenAI-compatible z.ai endpoint; existing Z.ai account | |

**User's choice:** Freeform — "Universal system where I can use/change AI provider with OpenAI/Anthropic/GLM/Openrouter or custom"
**Notes:** Became D-01: env-swappable provider abstraction in `lib/ai` (email-provider pattern).

**Q: How should the universal provider system be configured in env?**

| Option | Description | Selected |
|--------|-------------|----------|
| Single env triple | AI_PROVIDER + AI_MODEL + AI_API_KEY (+ AI_BASE_URL for custom); throw-early when enabled | ✓ |
| Per-provider keys | OPENAI_API_KEY / ANTHROPIC_API_KEY… coexist; AI_PROVIDER picks active | |
| Base-URL only | One OpenAI-compatible base URL + key + model; native adapters unused | |

**Q: Which provider ships as the documented day-1 default in .env.example?**

| Option | Description | Selected |
|--------|-------------|----------|
| Z.ai GLM | Existing Z.ai account; OpenAI-compatible endpoint; zero new signup | ✓ |
| OpenAI | Most battle-tested path; new account if not already held | |
| OpenRouter | One key, many models; routing middleman | |
| No single default | All four examples documented equally | |

**Q: Who sees the AI features when the flag is on?**

| Option | Description | Selected |
|--------|-------------|----------|
| All users | Env flag is the gate; session guard + rate limits still apply | ✓ |
| Admin-only first | Dogfood via Better Auth role before wider exposure | |

**Q: What happens when the AI provider fails or times out mid-request?**

| Option | Description | Selected |
|--------|-------------|----------|
| Error + retry | Clean inline error + user-initiated Retry; no silent loops | ✓ |
| Auto-retry once | Friendlier; doubles worst-case cost/latency | |
| Degrade to hidden | Hide buttons until recovery; hides breakage + health-probe machinery | |

**Q: One model for both AI features, or per-feature model overrides?**

| Option | Description | Selected |
|--------|-------------|----------|
| One model | Single AI_MODEL; both tasks are light; overrides deferred | ✓ |
| Per-feature override | AI_MODEL + optional SUMMARIZE/ASSISTANT vars | |

**Q: How do streams reach the client?**

| Option | Description | Selected |
|--------|-------------|----------|
| AI SDK primitives | streamText server-side + SDK streaming hooks client-side | ✓ |
| Custom stream | Plain ReadableStream + fetch reader; more code to own | |

**Q: How should the per-user AI rate limits be bucketed?**

| Option | Description | Selected |
|--------|-------------|----------|
| Per-feature buckets | drafts ~10/h/user, assistant ~20/h/user; no starvation across features | ✓ |
| Shared bucket | One AI budget per user; fewer knobs; features compete | |

**Q: One AI_ENABLED flag for both features, or per-feature sub-flags?**

| Option | Description | Selected |
|--------|-------------|----------|
| Single flag | AI-01 verbatim; per-feature disabling is a future env | ✓ |
| Per-feature flags | Master + sub-flags; more surface than asked | |

**Q: Should AI requests log token usage for cost visibility?**

| Option | Description | Selected |
|--------|-------------|----------|
| Log per request | One structured line: feature, userId, model, tokens in/out, duration | ✓ |
| Log + metric | Also a cumulative counter/gauge; more wiring | |
| None | Provider billing dashboards only | |

## AI feature UX

**Q: Where does the incident post-mortem draft get generated from?**

| Option | Description | Selected |
|--------|-------------|----------|
| Monitor detail | Incident blocks on monitor detail; evidence already loaded | ✓ |
| Incidents page | Global list rows; ping context needs second fetch | |
| Both surfaces | Widest reach; two integration points | |

**Q: How does the streaming draft render?**

| Option | Description | Selected |
|--------|-------------|----------|
| Inline card | Streaming markdown card under the incident + Copy; stays in context | ✓ |
| Modal dialog | Roomier; hides evidence behind overlay; dialog lifecycle | |

**Q: After a post-mortem draft streams in, what can the user do with it?**

| Option | Description | Selected |
|--------|-------------|----------|
| Copy only | Nothing written to DB; zero schema change; regenerate anytime | ✓ |
| Optional save | Copy + user-initiated save to incident (new storage + edit/delete story) | |

**Q: How does the monitor-setup assistant integrate?**

| Option | Description | Selected |
|--------|-------------|----------|
| Prefill in form | Describe-in-words input above fields; streams into form; submit = confirmation | ✓ |
| Separate page | Dedicated assistant page → prefilled form handoff; extra hop | |
| Chat panel | Conversational side panel + Confirm; most code, furthest from AI-04 | |

**Q: Does the setup assistant cover creation only, or also editing?**

| Option | Description | Selected |
|--------|-------------|----------|
| Create-only | AI-04 verbatim; edit flows keep plain form | ✓ |
| Also edit flows | Doubles integration surface; stretches requirement | |

**Q: What shape should the generated post-mortem draft take?**

| Option | Description | Selected |
|--------|-------------|----------|
| Report sections | Summary, Timeline, Impact, Possible causes (markdown) | ✓ |
| Narrative summary | Tight 2–3 paragraphs; faster read, less structure | |

**Q: Can the user re-roll a generation they didn't like?**

| Option | Description | Selected |
|--------|-------------|----------|
| Regenerate button | Regenerate on both features + Stop while streaming | ✓ |
| Single-shot only | One generation per click | |

**Q: When the AI flag is off, what does the UI show?**

| Option | Description | Selected |
|--------|-------------|----------|
| Fully hidden | No AI trace; zero support questions; AI-01 spirit | ✓ |
| Visible-disabled | Greyed buttons + "Not enabled" tooltip; advertises feature | |

**Q: When the assistant's suggested config partially fails validation, what happens?**

| Option | Description | Selected |
|--------|-------------|----------|
| Partial fill + hint | Valid fields prefill; invalid flagged "fill manually"; schema gates at submit | ✓ |
| All-or-nothing | Whole prefill rejected on any invalid field | |

**Q: What evidence feeds the post-mortem draft?**

| Option | Description | Selected |
|--------|-------------|----------|
| Incident-scoped | This incident + its pings window + monitor identity | ✓ |
| Include history | Prior incidents + lifetime uptime for trend narrative | |

**Q: Should the assistant input include example placeholders?**

| Option | Description | Selected |
|--------|-------------|----------|
| Placeholder examples | "e.g. Watch my portfolio site every 5 minutes" | ✓ |
| Bare input | Neutral label only | |

## Redesign ambition

**Q: How far should the visual redesign go?**

| Option | Description | Selected |
|--------|-------------|----------|
| Polish current layouts | Visual layer only; lowest risk | |
| Refresh + targeted layouts | Visual refresh + stats header, denser list, cleaner detail; recognizable structure | ✓ |
| Ground-up redesign | New layout language; highest regression surface in final phase | |

**Q: Do marketing/landing pages get real light mode, or stay dark-only?**

| Option | Description | Selected |
|--------|-------------|----------|
| Light everywhere | WR-02 surfaces token-driven; criterion 5 read fully | ✓ |
| App-only light | Marketing stays dark-only; "intentional" is a stretch | |

**Q: Which surfaces get the deepest design attention?**

| Option | Description | Selected |
|--------|-------------|----------|
| Dashboard + status | Deepest on dashboard/detail; status right behind; auth+marketing palette pass | ✓ |
| Equal everywhere | Uniform depth across all surfaces | |
| Dashboard only | Others ride global palette only | |

**Q: How much motion polish ships with the redesign?**

| Option | Description | Selected |
|--------|-------------|----------|
| Micro-interactions | Staggered entrances, status transitions, skeletons (motion v12 installed) | ✓ |
| Richer motion | + animated hero/Lottie prominence; more to tune | |
| Minimal motion | Existing component motion only | |

## Icon & dialog consolidation

**Q: Which icon system wins the consolidation?**

| Option | Description | Selected |
|--------|-------------|----------|
| Hugeicons | PROJECT.md-named; majority in newer components | ✓ |
| react-icons | Bigger library; migrate hugeicons the other way | |
| lucide (new dep) | shadcn-native but a THIRD system; most churn | |

**Q: How complete is the icon migration?**

| Option | Description | Selected |
|--------|-------------|----------|
| Full sweep + delete | Every react-icons site migrates; dep removed; verify gate | ✓ |
| High-visibility only | Long-tail sites stay; two systems remain | |

**Q: How far does the dialog consolidation go?**

| Option | Description | Selected |
|--------|-------------|----------|
| Full consolidation | Swal + window.confirm/alert → alert-dialog + sonner; dep deleted + gate | ✓ |
| Confirms only | Destructive confirms migrate; Swal popups stay; dep stays | |

**Q: How wide does the shadcn primitive adoption (UI-01) sweep?**

| Option | Description | Selected |
|--------|-------------|----------|
| Redesign surfaces | "Where sensible" = surfaces the redesign opens | ✓ |
| Everywhere possible | Every hand-rolled component restyled; max diff surface | |

## Gray-area selection (round 2 — after the wrap-up check)

All three offered areas selected: Windowed-uptime semantics, Phase sequencing, Brand & typography.

## Windowed-uptime semantics

**Q: Does the nightly recompute run even when the flag is off?**

| Option | Description | Selected |
|--------|-------------|----------|
| Compute always runs | Columns populate silently; flag gates reads; v2 finds complete data | ✓ |
| Job is flagged | Nothing computes until enabled; windows fill from enable-night | |

**Q: Does the first run backfill windows from retained ping history?**

| Option | Description | Selected |
|--------|-------------|----------|
| Backfill from history | 30-day retention fills 24h/7d/30d from night one | ✓ |
| Accumulate fresh | Windows complete only after full span elapses | |

**Q: Is there any way to SEE windowed values in v1?**

| Option | Description | Selected |
|--------|-------------|----------|
| No surface | Tests + direct DB verification; display switch is v2 PROD-01 | ✓ |
| Admin probe | Admin-gated read endpoint; small new gated surface | |

## Phase sequencing

**Q: In what order do the three deliverables build and ship?**

| Option | Description | Selected |
|--------|-------------|----------|
| Backend → UI → AI | Windowed backend first (no UI dep); redesign; AI last on final primitives | ✓ |
| AI first | Value earliest; AI surfaces restyled twice | |
| Backend+AI, then UI | Both flag-off early; redesign wraps everything last | |

**Q: How do the deliverables package into releases?**

| Option | Description | Selected |
|--------|-------------|----------|
| Release per deliverable | 3 feature releases, each soaked; dep deletions ride the redesign release | ✓ |
| Single big release | One giant diff on the live system; against house discipline | |

**Q: When does AI_ENABLED flip to true in production?**

| Option | Description | Selected |
|--------|-------------|----------|
| Dark, then flip | Ship flag-off, soak AI-less, flip env + smoke (Phase-4 pattern) | ✓ |
| Flip on deploy | Features live with the release; first key/streaming exercise is the deploy | |

## Brand & typography

**Q: Does the redesign keep the current visual identity or change it?**

| Option | Description | Selected |
|--------|-------------|----------|
| Refine current | Keep cyan-forward personality; refine application in both modes | ✓ |
| New palette | New accent direction; every token + brand asset re-authored | |

**Q: Typography — same family with a refined scale, or a new font?**

| Option | Description | Selected |
|--------|-------------|----------|
| Same font, new scale | Sizes/weights/hierarchy refined; no new font wiring | ✓ |
| New font family | New next/font wiring + metric rechecks everywhere | |

**Q: Does dark mode get the redesign too, or does only light mode change?**

| Option | Description | Selected |
|--------|-------------|----------|
| Both modes | Same token set; migration-era freeze lifts (UI-05 premise) | ✓ |
| Dark frozen | Only light changes; redesign invisible to most users | |

---

## Claude's Discretion

- AI prompt wording, token/input caps, ping-window lead-in size, route paths, `lib/ai` layout, `@ai-sdk/*` package selection per provider.
- Exact rate-limit values within the D-08 anchors; verify-gate grep patterns for the icon/dialog gates.
- Windowed-uptime column shapes, maintenance-lane scheduling, backfill query form (03-05 rehearsal pipeline applies).
- E2E posture for the redesign; soak durations; 08 deploy-record structure; 02-08 follow-ups (11-token review, mixed ternaries) inside UI-03.
- Skeleton/stagger/transition choreography within D-28.

## Deferred Ideas

- Per-feature AI model overrides (`AI_MODEL_SUMMARIZE` / `AI_MODEL_ASSISTANT`) — if a real need appears.
- Edit-flow AI assistance for existing monitors.
- Optional save-to-incident for post-mortem drafts.
- Admin-only probe endpoint for windowed values.
- Admin feedback viewer UI / Better Auth management endpoints / resend-verification affordance (07-CONTEXT deferrals) — remain deferred beyond this milestone.
- Windowed-uptime display switch (PROD-01) — v2.
