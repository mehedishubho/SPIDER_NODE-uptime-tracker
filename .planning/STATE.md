---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 2
current_phase_name: Foundations & Theme Infrastructure
status: verifying
stopped_at: Completed 02-09-PLAN.md
last_updated: "2026-09-10T20:52:27.407Z"
last_activity: 2026-09-09
last_activity_desc: Phase 2 execution started
progress:
  total_phases: 8
  completed_phases: 2
  total_plans: 18
  completed_plans: 18
  percent: 25
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-09)

**Core value:** Modernize the infrastructure without breaking existing monitoring — never lose or corrupt uptime data, silently stop checking, or lock users out irrecoverably.
**Current focus:** Phase 2 — Foundations & Theme Infrastructure

## Current Position

Phase: 2 (Foundations & Theme Infrastructure) — EXECUTING
Plan: 9 of 9
Status: Phase complete — ready for verification
Last activity: 2026-09-09 — Phase 2 execution started

Progress: [████████████████████] 9/9 plans (100%)

## Performance Metrics

**Velocity:**

- Total plans completed: 9
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 9 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01 P01 | 984s | 3 tasks | 1 files |
| Phase 01 P02 | 4min | 3 tasks | 1 files |
| Phase 01 P03 | 9m 20s | 3 tasks | 1 files |
| Phase 01 P04 | 5min | 3 tasks | 2 files |
| Phase 01 P05 | 10m (Tasks 2-3 continuation; Task 1 prior session) | 3 tasks | 1 files |
| Phase 01 P06 | 8m (490s) | 3 tasks | 2 files |
| Phase 01 P07 | 213s (~4m) | 3 tasks | 1 files |
| Phase 01 P08 | 602s (~10m) | 3 tasks | 2 files |
| Phase 01 P09 | 7m (Task 3 continuation; Tasks 1-2 prior session + checkpoint) | 3 tasks | 5 files |
| Phase 02 P01 | 25min | 3 tasks | 17 files |
| Phase 02 P02 | 34min | 3 tasks | 10 files |
| Phase 02 P03 | 403s (~7min) | 3 tasks | 3 files |
| Phase 02 P04 | 3min | 3 tasks | 1 files |
| Phase 02 P05 | 19min (1111s) | 3 tasks | 11 files |
| Phase 02 P06 | 86min | 3 tasks | 25 files |
| Phase 02 P07 | 16min (928s) | 3 tasks | 12 files |
| Phase 02 P08 | 796s (~13min) | 2 tasks | 39 files |
| Phase 02 P09 | ~6min (387s) | 3 tasks | 1 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Roadmap: audit §24 order chosen, compressed to 8 phases at standard granularity (design gate first; dark launch split from overlap cutover)
- WRK-09/WRK-11 placed in Phase 5 — heartbeat parity and overlap gates are only verifiable once the worker scheduler unpauses
- EML-04 placed in Phase 7 — Better Auth hooks cannot delegate to the email queue before Better Auth exists (Phase 6 builds the queue)
- DAT-11 (windowed-uptime backend) placed in Phase 8 — flagged feature work kept out of the highest-risk migration phase
- OBS-04/SEC-04 placed in Phase 7 — Bull Board admin gating requires the Better Auth admin plugin
- [Phase 01]: 01-01: outbox.monitor_id integer (not uuid) — FK must match integer serial monitors.id (M-5); outbox.incident_id added for the alert dedup key
- [Phase 01]: 01-01: Tier 1 transaction inserts the evidence ping BEFORE the conditional UPDATE — duplicates record evidence but count/gate transition effects once (TC-DUP-INCIDENT-01)
- [Phase 01]: 01-01: ID generation pinned DB-side gen_random_uuid()::text; spec SQL omits id columns so defaults apply
- [Phase 01]: 01-02: every BullMQ lane carries an explicit priority (manual/non-UP checks 1, tick/relay/alerts 1, maintenance/email 5, routine 10) — BullMQ default 0 processes non-prioritized jobs BEFORE prioritized ones, so any unprioritized lane inverts J-6
- [Phase 01]: 01-02: claim SQL RETURNING extended to (id, status, next_check_at) — J-6 lane assignment and the check:{monitorId}:{epoch} jobId derive from the atomic claim; WHERE clause unchanged from the verified research baseline
- [Phase 01]: 01-02: J-5 backlog gate drops only routine (priority-10) enqueues; the non-UP lane is never gated — transition writes are synchronous inside check jobs (§16.1) and thus never droppable
- [Phase 01]: 01-02: recompute-uptime and record-pings-bulk removed from §14 job lists — D-6/§16.5 lifetime counters are authoritative and Tier 2 persistence is the single §16.2 guarded flush
- [Phase ?]: [Phase 01]: 01-03: audit §25 (connection budget) placed as a new top-level section after §24 instead of between §16/§17 — mid-numbering insertion would renumber §17–§24 and break cross-references committed by 01-01/01-02
- [Phase ?]: [Phase 01]: 01-03: Postgres breaker state lives in the worker process; restart resets to CLOSED — safe (first infra-failure re-arms within one tick), and the pause never depends on Redis state surviving a restart
- [Phase ?]: [Phase 01]: 01-03: statement_timeout 30 s on web+worker pools (sized above the 5000-row retention-delete pass), explicitly UNSET on the migration runner — CONCURRENTLY/backfills run long
- [Phase ?]: [Phase 01]: 01-03: §9 marker item numbers use the plan's prescribed citation scheme verbatim; issue IDs are the load-bearing traceability tokens and all trace greps pass
- [Phase 01]: 01-04: runbook PM2 values pinned — kill_timeout 20000 ms non-negotiable floor (P-1/DEP-01); wait_ready/listen_timeout/max_restarts/min_uptime marked default-tune-with-data (D-10)
- [Phase 01]: 01-04: interim smoke check = web-serving check (no worker until Phase 4); synthetic-check smoke is the target-topology form; migrate step is a no-op when nothing is pending so one interim ordering covers Phases 2-3
- [Phase ?]: 01-05: gap path taken on user ratification (ratify gaps) — verdict stays NOT READY; DSGN-02 pending a clean cycle-2 pass; no READY-with-exceptions (D-16/D-18)
- [Phase ?]: 01-05: criterion-2 interpretation user-ratified (D-05/DRZ-01) — DDL-precise §11 + Phase 3 live-DDL transcription contract + M-3 empty-diff gate = reflected in the target Drizzle schema
- [Phase ?]: 01-05: DSGN-02 deliberately not marked complete — requirement text (verdict to READY) not yet true; plan completed via its legitimate gap-path branch
- [Phase 01]: 01-06: flush exclusivity is a two-part guarantee — same-transaction write_guards guard (flush:{batchId}) PLUS RENAMENX staging snapshot; plain RENAME rejected because it re-fails CR-02's over-delete case on crash-after-COMMIT redelivery
- [Phase 01]: 01-06: batchId pinned {epochMs-of-flush-pass}:{monitorId}, carried in BullMQ job data so staging key names and the guard key are deterministic across retries (IN-03, D-10 form)
- [Phase 01]: 01-06: alert dedup is one key per declared outbox event type — alert:{incidentId}:down / alert:{incidentId}:recovered / alert:{monitorId}:first_check; down/recovered rows REQUIRE non-NULL incident_id, violations dead-letter via UnrecoverableError (CR-03)
- [Phase 01]: 01-07: interim-topology Migrate step is phase-conditional keyed on the Phase 3 baseline PR (same switchover event as audit §24 step 3) — Phase 2 runs no migrate command (legacy CI prisma db push is the interim schema authority on its dated removal path), Phase 3+ runs the single drizzle-kit migrate runner (WR-03)
- [Phase 01]: 01-07: PM2 readiness is two signals with distinct consumers — process.send('ready') is the PM2 gate (wait_ready/listen_timeout), HTTP :9090/readyz is the operator/CI gate; wiring only the HTTP endpoint boot-crash-loops the worker (WR-04)
- [Phase 01]: 01-07: first worker release is its own §4a path — pm2 start/startOrReload (never restart on an unregistered name), M3 overlap window verifying continuity (heartbeat, queue depth ≈ 0, ping flow, alert parity, M4 counters) before anything is disabled, cutover completion as a separate release deleting instrumentation.ts cron + CRON_MODE; §4 restart form applies from the second release onward (WR-05)
- [Phase 01]: 01-08: S-1 egress layer is one denylist in three statements — §15.1 engine list (post-WR-01), §15.4 OS mirror, runbook §10 operator rules; drift control is shared 11-token CIDR set + same-change mandate (RR-01/WR-01)
- [Phase 01]: 01-08: manual checks advance next_check_at one interval at enqueue via the §14.3-shaped atomic UPDATE; manual jobId check:{monitorId}:manual:{epochMs-of-enqueue} is unique per enqueue — admission is the D-13 limiter's job, never the jobId's (WR-02)
- [Phase 01]: 01-08: rate-limit atomicity pinned as one Lua script doing INCR + EXPIRE-with-NX on first increment — separate calls strand a TTL-less counter and permanently limit a user (IN-01/OBS-04)
- [Phase 01]: 01-08: steady-state Postgres total restated ≤ 30 (web 10 + worker 20), ≤ 31 only during deploys; web process budgets 2 Redis connections (queue producer + limiter/cache) separate from the worker's 2 (IN-05/OBS-05)
- [Phase ?]: [Phase 01]: 01-09: cycle-2 re-review clean pass (zero blocking findings) human-ratified — verdict flipped to READY per D-16; RR2-01/02/03 recorded as advisory Phase 4/5 design-debt notes, not verdict-gating
- [Phase ?]: [Phase 01]: 01-09: Phase-1-only Mode:mvp marker deleted from ROADMAP per 01-VERIFICATION round-2 disposition — documentation-gate phase has no vertical-slice deliverables; Phases 2-8 keep theirs
- [Phase 02]: 02-01: pnpm resolves via Volta shim honoring packageManager -> 10.34.5 wins in-repo (Pitfall 7); corepack enable itself unneeded (EPERM without admin)
- [Phase 02]: 02-01: .env.example carries the 24 vars app code reads; gitignored src/generated/prisma excluded from the sweep (7 library toggles are not app config); Appendix A deltas +NODE_ENV/+NEXT_RUNTIME, NEXT_PUBLIC_APP_URL excluded (unread)
- [Phase ?]: [Phase 02]: 02-02: test stack ports moved 5433/6380 -> 5453/6390 — planned ports held by LIVE sibling stacks (devsroom_personal_tracker_db / devsroom-license-manager-redis); ours moved, theirs untouched
- [Phase ?]: [Phase 02]: 02-02: .env.test honored override-first when present but cannot be committed from env-denied checkouts — runner configs carry the localhost-docker default constant as canonical fallback
- [Phase ?]: [Phase 02]: 02-02: global-setup runs plain prisma db push — Prisma 7 removed --skip-generate and --force-reset trips its AI-agent consent gate (honored, not evaded); drift now fails closed on the throwaway container
- [Phase ?]: [Phase 02]: 02-02: E2E seeds go through raw pg SQL (PROJECT.md-sanctioned) with TEST_DATABASE_URL-only resolution — never ambient DATABASE_URL
- [Phase ?]: [Phase 02]: 02-03: only FND-05 marked complete — FND-06 spans this plan (batcher half) and 02-05 (API contracts); marking it early would falsely signal done
- [Phase ?]: [Phase 02]: 02-03: vitest fileParallelism:false — DB-backed integration files share one Postgres and TRUNCATE whole tables per case; parallel forks race seeds
- [Phase ?]: [Phase 02]: 02-03: failure-swallow + zero-synchronous-footprint fast path pinned verbatim (db-5, cron 1/2/13) as Phase 4 red/green markers; batcher writes monitor.status (not counter-neutral)
- [Phase 02]: 02-04: runbook tarball packs repo root minus excludes (node_modules/.git/.env*/test artifacts) — gitignored .next + src/generated/prisma ride along by construction and .env can never ship (T-02-17)
- [Phase 02]: 02-04: VPS install is pnpm install --frozen-lockfile --prod (plan said plain frozen-lockfile) — toolchain stays off the 2 GB VPS; prisma CLI unneeded since the client ships pre-generated (D-14)
- [Phase 02]: 02-04: ecosystem.config.js npm-to-pnpm edit = edit the extracted VPS copy during the D-26 switch + identical repo commit (tarball is packed before the edit exists; Open Question 3 honored — never a standalone earlier commit)
- [Phase 02]: 02-05: handler-harness mocks as plain exported consts (vitest 4 forbids exporting vi.hoisted values) — lazy factories + harness-first import keep mock identity stable across vi.resetModules + dynamic re-imports (Pitfall 6)
- [Phase 02]: 02-05: playwright projects pinned to testMatch .spec.ts — the default testMatch would claim vitest-owned *.handler.test.ts files once the api project filled
- [Phase 02]: 02-05: FND-06 complete — 71 handler-import + 12 HTTP-level contracts pin the D-17 route scope verbatim; query-string CRON_SECRET (S-4), 500 stack echo, and unauthenticated telegram webhook (S-2) pinned as deliberate Phase-6 red/green markers
- [Phase 02]: 02-07: hugeicons-react@0.4.0 predates the UI-SPEC icon names - Sun03Icon/ComputerIcon are the 0.4.x exports for the sunlight/monitor glyphs (Moon02Icon named); zero new UI deps preserved
- [Phase 02]: 02-07: mounted guard expressed as useSyncExternalStore(no-op subscribe, ()=>true, ()=>false) - repo react-hooks lint forbids synchronous setState in effects; identical isHydrated semantics
- [Phase 02]: 02-07: dark byte-identity gate run as comm -23 subset check (empty = no pre-change token changed/removed); literal diff shows exactly the two sanctioned status-token additions
- [Phase 02]: 02-08: 11 extra same-value tokens added beyond the UI-SPEC pair (accent-cyan, muted-meta, danger-strong, surface-deep/raised, accent-gold/-deep, foreground-bright, dialog-*) — the zero-hex gate forbids orphans and byte-identity forbids nearest-token fits; all 13 identical in :root/.dark, Phase 8 UI-03 reviews
- [Phase 02]: 02-08: DOWN branches that use rose-* stay rose (D-25) — rose-400 != #ef4444 so a status-down swap would change dark values; emerald UP branches migrated to status-up, mixed ternaries flagged for Phase 8
- [Phase 02]: 02-08: sweetalert2 config colors became var(--primary)/var(--dialog-*) references — dialog trio tokens keep the Swal popup white-in-both-modes exactly as today
- [Phase ?]: [Phase 02]: 02-09: mutation 1 realized as true 2-consecutive-failure gate (DOWN only when monitor.status already DOWN) - the failedChecks>=2 example leaves the seeded failedChecks=2 UP-to-DOWN case green; consecutive form turns BOTH plan-named cases red
- [Phase ?]: [Phase 02]: 02-09: HTTP-layer mutation proof requires rebuild-between (playwright api project runs the built artifact) - mutate, build, RED e2e, revert, rebuild, GREEN; per-task evidence as --allow-empty commits since mutations are never committed (T-02-19)

### Pending Todos

None yet.

### Blockers/Concerns

- Research flags requiring `--research-phase` during planning: Phase 4 (BullMQ 6 `upsertJobScheduler`, breaker/backlog tuning, PM2 handshake), Phase 7 (social `providerId` casing, token-flow cutover, cookieCache revocation lag), Phase 3 (drizzle-kit journal-stamping, `CREATE INDEX CONCURRENTLY` transaction wrapping)
- Live production system: every cutover step needs a full `pg_dump` backup and an anonymized-snapshot rehearsal first (D-9/D-10)
- [Phase 4/5] Design-debt register (01-VERIFICATION.md): CR-01 (`uptime_percent` has no writer — displayed lifetime uptime would freeze at cutover) and CR-02 (runbook §4a "disable nothing" vs audit M4 ordering) are must-resolve inputs at Phase 4/5 planning, before any plan transcribes §16 or the §4a overlap path; advisory register WR-01..05 / IN-01..07 / RR2-01..03 rides along

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-09-10T20:52:27.402Z
Stopped at: Completed 02-09-PLAN.md
Resume file: None
