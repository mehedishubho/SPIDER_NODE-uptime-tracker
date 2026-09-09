# Phase 2: Foundations & Theme Infrastructure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-10
**Phase:** 2-Foundations & Theme Infrastructure
**Areas discussed:** Typecheck flip strategy, CI vs deploy gating, Characterization suite shape, Light palette & toggle UX, Suite vs. fixes sequencing, pnpm migration details, VPS cutover timing

---

## Typecheck flip strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Fix-all-then-flip (Recommended) | Run tsc, fix every error, then flip `ignoreBuildErrors` off in the same phase — one clean cutover | ✓ |
| Two-stage (gate first, flip later) | Add `tsc --noEmit` script now, burn errors down over time, flip when count hits zero | |
| Flip + suppress markers | Flip immediately, mark remaining errors with `@ts-expect-error` debt items | |

**User's choice:** Fix-all-then-flip
**Notes:** Error count is currently unknown — `node_modules` isn't fully installed on the dev machine, so tsc can't run until prisma client is generated. First task sizes the pile.

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal churn (Recommended) | Smallest diff that makes types honest — no refactors, no drive-by improvements | ✓ |
| Fix + tighten as encountered | Also tighten weak typing where met (any → unknown, null checks) | |
| Decide after sizing | Size pile first, then reconvene on policy | |

**User's choice:** Minimal churn
**Notes:** Behavior must not change — the characterization suite pins behavior, not type elegance.

| Option | Description | Selected |
|--------|-------------|----------|
| Escalate >100 (Recommended) | First task sizes the pile; >100 errors = stop, split fixes into dedicated plans | ✓ |
| Fix regardless of size | Whatever the count, fix them all — no mid-phase checkpoint | |
| Report-only, proceed | Executor reports count, proceeds unless truly extreme (>500) | |

**User's choice:** Escalate >100

| Option | Description | Selected |
|--------|-------------|----------|
| Early — first plans (Recommended) | Flip lands with pnpm/Node work so later tasks run under green typecheck | ✓ |
| Late — end of phase | Flip after tests and theme land | |

**User's choice:** Early — first plans
**Notes:** Later refined by the sequencing discussion (risk-tiered, D-19): monitored-logic fixes wait for their tests.

---

## CI vs deploy gating

Opening note: user stated *"I will use manual deployment system no github CI/CD"* when selecting areas — reframed the entire DEP-04 discussion. Facts gathered: `.github/workflows/deploy.yml` exists (push-to-main auto-deploy, zero gates, runs `prisma db push --accept-data-loss` every deploy, VPS loads Node via NVM, builds happened on GitHub runner with `NODE_OPTIONS max_old_space_size=2048`).

| Option | Description | Selected |
|--------|-------------|----------|
| Delete deploy.yml — fully manual | No GitHub Actions at all; removes the db-push-on-deploy hazard immediately | ✓ |
| CI-only workflow, no deploy | Keep Actions for lint/typecheck/test on PRs; deploy stays manual | |
| Disable now, delete later | Convert to workflow_dispatch, delete once manual process is proven | |

**User's choice:** Delete deploy.yml — fully manual

| Option | Description | Selected |
|--------|-------------|----------|
| Verify script + manual steps (Rec.) | `pnpm verify` holds the gates; deploy = typed manual steps in the runbook; deploy automation deferred to Phase 4/5 | ✓ |
| Full deploy script with gates | `pnpm deploy` runs verify then automates tar/SCP/PM2 | |
| Runbook-only, no scripts | All gate commands and deploy steps typed by hand in order | |

**User's choice:** Verify script + manual steps

| Option | Description | Selected |
|--------|-------------|----------|
| Node 20 — match current | Matches deploy.yml's build runner | |
| Node 22 — upgrade once (Rec.) | Active LTS runway; one-time NVM switch on VPS | |
| Match VPS exactly | User names the version via Other | |

**User's choice:** (freeform) *"as I use ubuntu 24.04 version so I would like to use 24 LTS with backard compitable with 22"*
**Notes:** Node 24 LTS pinned; Ubuntu 24.04 VPS; backward-compat floor 22 noted; BullMQ 6 / Next 16 both support it.

| Option | Description | Selected |
|--------|-------------|----------|
| Build locally, ship (Rec.) | Dev machine builds; VPS extracts, installs prod deps, PM2 reloads — deploy.yml's shape minus GitHub | |
| Build on the VPS | git pull + build on server — slow and memory-tight on small VPS | |

**User's choice:** (freeform) *"I will deploy it menually no readymade system make everything default"*
**Notes:** Reflected back and confirmed: no deploy scripts/artifact tooling from us at all; runbook documents typed steps only; everything default (pnpm build as-is, pm2/ecosystem.config.js unchanged, corepack for pnpm); local-build-and-ship is the documented default safe path.

| Option | Description | Selected |
|--------|-------------|----------|
| Typed checks in runbook (Rec.) | curl the app, pm2 status, logs — by hand, documented | ✓ |
| One-command smoke script | `pnpm smoke` curls app root, fails on non-200 | |

**User's choice:** Typed checks in runbook
**Notes:** No readyz endpoint exists until Phase 4's worker.

---

## Characterization suite shape

Facts gathered: `runCronChecks` is a single 220-line export; `db-batcher` holds module-level queues behind `queueRoutineCheck`/`flushBatches`; 19 API routes exist. Consequence pinned: tests drive code **as-is** — no refactor-before-pin.

| Option | Description | Selected |
|--------|-------------|----------|
| Real Postgres integration (Rec.) | docker PG, seed via SQL, stub fetch/Telegram, call functions, assert rows — matches audit §23 given/when/then | ✓ |
| Unit tests with mocked prisma | Fast but characterizes the mock, not the DB | |
| Integration + unit hybrid | Both layers, more maintenance | |

**User's choice:** Real Postgres integration

| Option | Description | Selected |
|--------|-------------|----------|
| HTTP-level via real server | Boot Next, hit real endpoints; pins status codes + middleware | |
| Handler-import, mocked session | Import handlers, construct requests; fast, boundary invisible | |
| Hybrid: HTTP core + handler rest (Rec.) | HTTP for boundary-critical routes, handler-import for breadth | ✓ |

**User's choice:** Hybrid

| Option | Description | Selected |
|--------|-------------|----------|
| Rewrite-touched core ~10 (Rec.) | Monitors CRUD ×4, incidents, status ×2, cron/check, cron/cleanup, feedback; Telegram webhook as-is incl. defect; auth shallow | ✓ |
| All 19 routes | Maximum safety, much of it soon dead (NextAuth replaced Phase 7) | |
| Planner judgment, floored at 10 | Executor discretion above a mandatory floor | |

**User's choice:** Rewrite-touched core ~10

| Option | Description | Selected |
|--------|-------------|----------|
| Scaffold + 1 smoke E2E (Rec.) | Config + webServer wiring + one login/dashboard test proving the scaffold runs | ✓ |
| Scaffold only, no tests | Cheapest; unverifiable until first test exists | |
| Scaffold + 2 E2Es | Adds monitor-detail pings render | |

**User's choice:** Scaffold + 1 smoke E2E

| Option | Description | Selected |
|--------|-------------|----------|
| ≤5 min budget (Rec.) | Cut scope/parallelize rather than ship a slow manual gate | ✓ |
| No budget — thoroughness first | Correctness outranks convenience | |
| Measure now, budget later | Set from data at Phase 3 | |

**User's choice:** ≤5 min budget

| Option | Description | Selected |
|--------|-------------|----------|
| Mutation spot-check task (Rec.) | Explicitly break pinned behaviors, record red, revert — success criterion 2 as verified task | ✓ |
| Green-run only, no mutation pass | Trust the assertions via review | |

**User's choice:** Mutation spot-check task

---

## Light palette & toggle UX

Facts gathered: dark palette = #121212 bg, zinc-800 cards, red #ef4444 accent, green #10a34b sidebar-primary; `:root` and `.dark` byte-identical; `@custom-variant dark` already wired; 237 hardcoded hexes in tsx files.

| Option | Description | Selected |
|--------|-------------|----------|
| Neutral zinc mirror (Rec.) | zinc/white light family, same red brand; Phase 8 refines | ✓ |
| Warm stone tint | stone/warm-white backgrounds, paper-like | |
| Slate + red-600 for contrast | slate palette, deeper red for 4.5:1 text contrast | |

**User's choice:** Neutral zinc mirror

| Option | Description | Selected |
|--------|-------------|----------|
| Cycle icon button (Rec.) | sun/moon/monitor icon cycling Light→Dark→System in dashboard header + auth layout | ✓ |
| Dropdown with three entries | shadcn dropdown with check marks | |
| Sidebar footer control | Segmented control in sidebar footer; auth pages excluded | |

**User's choice:** Cycle icon button

| Option | Description | Selected |
|--------|-------------|----------|
| Default dark (Rec.) | Existing users see exactly today's app until they opt in | ✓ |
| Default system | Standard next-themes practice; light-OS users get light immediately | |

**User's choice:** Default dark

| Option | Description | Selected |
|--------|-------------|----------|
| Curated status variants (Rec.) | UP/DOWN greens/reds get light-safe variants (green-600/red-600); rest same-value tokens | ✓ |
| Same values everywhere | Only structural palette differs between themes | |
| Full per-hex review now | All 237 individually reviewed — Phase 8 work pulled forward | |

**User's choice:** Curated status variants

---

## Suite vs. fixes sequencing

| Option | Description | Selected |
|--------|-------------|----------|
| Risk-tiered (Rec.) | Monitored-logic fixes wait for green tests; UI/type-only fixes proceed; suite core lands in same early wave | ✓ |
| Strict suite-first | Full suite green before any fixes | |
| Flip-first regardless | All fixes land immediately, suite arrives after | |

**User's choice:** Risk-tiered

---

## pnpm migration details

| Option | Description | Selected |
|--------|-------------|----------|
| pnpm import — exact freeze (Rec.) | Convert lockfile preserving every resolved version; zero drift during pin-the-behavior phase | ✓ |
| Fresh resolve — current versions | Latest-in-range immediately; behavior diffs become ambiguous | |

**User's choice:** pnpm import — exact freeze

| Option | Description | Selected |
|--------|-------------|----------|
| Delete all four (Rec.) | Root test-*.js scripts removed; superseded by suite; git history preserves | ✓ |
| Relocate to scripts/manual/ | Kept as credential-requiring dev conveniences | |

**User's choice:** Delete all four

---

## VPS cutover timing

Wart discovered: deploy.yml ran `npm ci --omit=dev` then `npx prisma generate` on the VPS — npx was fetching prisma from the registry at deploy time. With generated client shipped in the tarball, the VPS never runs generate.

| Option | Description | Selected |
|--------|-------------|----------|
| Repo-only, runbook docs (Rec.) | No VPS access during execution; one-time switch documented for user to run at next deploy | ✓ |
| Include a guided real deploy | Phase includes walking through a real VPS switch + deploy together | |
| Repo + local rehearsal | Docker 'VPS simulation' proves the runbook steps | |

**User's choice:** Repo-only, runbook docs

---

## Claude's Discretion

- `.env.example` contents (names + purpose, no values)
- ngrok binary/log removal details
- db-batcher module-reset test isolation mechanics
- Redis container wired-but-unused until Phase 3
- Sonner Toaster theme prop wiring
- Pre-paint/FOUC mechanics via next-themes defaults
- tsconfig exclude for generated prisma code
- engines field documenting the Node 22 floor while .nvmrc pins 24
- Exact zinc light-palette token values within the mirror character
- Seed-data shapes and test-DB reset strategy
- Telegram assertion style (spy vs payload fixtures)

## Deferred Ideas

- Deploy automation with embedded gates — Phase 4/5 P-1 pipeline revision
- Light palette refinement + light-safe brand assets — Phase 8 UI-03
- Full per-hex light-mode review — Phase 8 UI-03
- Feature-level E2E browser tests — Phase 8 UI-04
- Dependency upgrades post-import — deliberate future work
- `readyz` endpoint — Phase 4 worker (WRK-08)
