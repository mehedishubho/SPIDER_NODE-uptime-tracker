---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 06
current_phase_name: thin-api-routes-email-abstraction
status: executing
stopped_at: Completed 06-02-PLAN.md
last_updated: "2026-09-20T17:56:51.790Z"
last_activity: 2026-09-20
last_activity_desc: Phase 06 execution started
progress:
  total_phases: 8
  completed_phases: 5
  total_plans: 50
  completed_plans: 47
  percent: 63
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-19)

**Core value:** Modernize the infrastructure without breaking existing monitoring — never lose or corrupt uptime data, silently stop checking, or lock users out irrecoverably.
**Current focus:** Phase 06 — thin-api-routes-email-abstraction

## Current Position

Phase: 06 (thin-api-routes-email-abstraction) — EXECUTING
Plan: 3 of 5
Status: Ready to execute
Last activity: 2026-09-20 — Phase 06 execution started

Progress: [████████████████████] 45/45 plans (100%)

## Performance Metrics

**Velocity:**

- Total plans completed: 45
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 9 | - | - |
| 2 | 10 | - | - |
| 03 | 8 | - | - |
| 4 | 9 | - | - |
| 5 | 9 | - | - |

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
| Phase 02 P10 | 21min | 3 tasks | 9 files |
| Phase 03 P01 | ~40 min (2 sessions; continuation verified GREEN + closeout) | 3 tasks | 12 files |
| Phase 03 P02 | ~7min (352s) | 2 tasks | 3 files |
| Phase 03 P04 | 857s (~14 min) | 3 tasks | 8 files |
| Phase 03 P05 | 455s (~8 min; Task 3 continuation) | 3 tasks | 4 files |
| Phase 03 P06 | 474s (~8 min) | 3 tasks | 1 files |
| Phase 03 P03-07 | 218 minutes | 2 tasks | 5 files |
| Phase 03 P08 | ~40 min (checkpoint-gated; local deploy leg 9 min) | 3 tasks | 1 files |
| Phase 4 P1 | ~2 sessions (checkpoint-gated) | 3 tasks | 9 files |
| Phase 04 P02 | 2 sessions (Task 3 continuation after usage-limit cutoff; this leg ~35 min) | 3 tasks | 11 files |
| Phase 04 P03 | 987s (~16.5 min, single session) | 2 tasks | 3 files |
| Phase 04 P04 | 23.5m | 3 tasks | 5 files |
| Phase 04 P05 | 666s (~11 min, single session) | 2 tasks | 2 files |
| Phase 04 P06 | 900s (~15 min, single session) | 2 tasks | 5 files |
| Phase 04 P07 | 1285s | 2 tasks | 8 files |
| Phase 04 P08 | 2 sessions (Task 2-3 continuation after usage-limit cutoff; this leg ~75 min incl. two Rule-1 production fixes) | 3 tasks | 14 files |
| Phase 04 P09 | 1h5m + closeout continuation (Task 4 operator approval 2026-09-14) | 4 tasks | 9 files |
| Phase 05 P01 | ~11 min active (resumed session) | 4 tasks | 8 files |
| Phase 5 P4 | ~8 min (494s) | 3 tasks | 4 files |
| Phase 05 P02 | 547s (~9 min, single session) | 3 tasks | 4 files |
| Phase 05 P03 | ~14 min (single session) | 3 tasks | 6 files |
| Phase 05 P05 | 20min | 3 tasks | 5 files |
| Phase 05 P06 | 1998s (~33 min; single logical session across one compaction) | 3 tasks | 3 files |
| Phase 05 P07 | 15h 29m | 3 tasks | 4 files |
| Phase 05 P08 | ~19h | 5 tasks | 3 files |
| Phase 05 P09 | 3h20m | - tasks | - files |
| Phase 06 P01 | 34m | 3 tasks | 10 files |
| Phase 06 P02 | 26m | 3 tasks | 16 files |

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
- [Phase 02]: 02-10: hex gate exclusion extended by exactly one name (global-error.tsx frozen bg-[#121212] literal — .dark never applies on that surface) and the command form switched to filename-fragment exclusions: Windows rg emits backslash paths, so 02-08 full-path patterns (-e src/lib/mail.ts) silently fail to exclude
- [Phase 02]: UAT close 2026-09-12 — WR-02 dispositioned by operator: light-mode legibility of unmigrated marketing surfaces (Navbar/TeamSwitch `text-white`, `bg-slate-950/80` header, `text-slate-300/400` copy) + light-palette polish notes ACCEPTED as Phase-8 scope; dark mode (the default) unaffected (02-UAT.md Decision Record)
- [Phase 02]: security closeout 2026-09-12 — 02-SECURITY.md: 25/25 register rows closed at L1/ASVS-1 (grep-depth, plan-time register); one accepted risk AR-02-01 (unauthenticated telegram webhook S-2 + cron query-string secret S-4, pinned per D-17) rides to Phase 6 SEC-03/SEC-06
- [Phase 03]: 03-01: limiter atomicity realized as ONE Lua script INCR + EXPIRE-on-first-hit (current==1) via defineCommand('rlIncr') — key rl:{bucket}_{ip} keeps D-04 semantics byte-identical; fail-open catch returns success with DEGRADED marker, never rethrows, no in-memory fallback
- [Phase 03]: 03-01: ioredis 6 A9 — custom defineCommand commands are runtime-only in v6 types; typed-view cast (redis as typeof redis & { rlIncr(key,secs): Promise<number> }) instead of any
- [Phase 03]: 03-01: handler-suite reset discipline switched from fresh-Map-per-case to per-case rl:* SCAN+DEL flush on the test Redis (admin client); vi.resetModules retained for the route/prisma mock seams (Pitfall 3)
- [Phase 03]: 03-01: redis.ts error listener attached inside the singleton factory — globalThis cache hits on module re-eval (vitest/HMR) never stack duplicate listeners; local .env carries REDIS_URL=redis://localhost:6390; pnpm build on env-less checkout still needs NEXT_PUBLIC_DEV_BASE_URL injected (02-07 precedent)
- [Phase 03]: 03-02: pool extraction lands the §25.2 pins as NEW pool semantics (connect timeout 0-to-10s fail-fast, statement_timeout + idle_in_transaction 30s caps) on a previously bare-defaults Pool — behavior-neutral at the ORM layer, proven by 111/111 characterization green
- [Phase 03]: 03-02: DAT-09 NOT marked complete — only the code half (web pool max 10) exists; migration runner (03-03 direct one-shot) and worker pool max 20 (Phase 4) pending (02-03 false-signal precedent)
- [Phase 03]: 03-02: pg 8.22 quirk check — none: statement_timeout/idle_in_transaction_session_timeout are plain ClientConfig pass-through keys, stored on pool.options and forwarded to every pooled client; assertions target pool.options directly
- [Phase ?]: 03-04: §11 DDL transcribed against LIVE camelCase columns (isActive/lastChecked/createdAt/interval/monitorId) — new objects keep §11 snake_case names; backfill carries explicit AT TIME ZONE 'UTC' naive-to-tz conversion (A6), proven 300s-exact on a real row
- [Phase ?]: 03-04: gen_random_uuid()::text defaults included for existing text PKs (pings/incidents/users) per §11 ID-generation + schema.ts's committed 'arrive with migration 0001' contract + DRZ-04 — dormant for Prisma (client-side cuid still supplied), required by §16.1's id-omitting INSERTs in Phase 4
- [Phase ?]: 03-04: stamp-baseline.mjs fixed (aba9aa4) to stamp journal entry idx 0 ONLY — journal growth to 2 entries had made the stamp-everything loop mark 0001 applied without running it (fake-green rehearsal/deploy path); boundary proven on scratch 5460
- [Phase ?]: 03-04: DRZ-02 NOT marked complete — only the machinery half landed (test stack built by the single runner; zero push references in executable surfaces); deploy-pipeline + absence-gate legs are 03-07/03-08 (02-03 false-signal precedent)
- [Phase ?]: D-19: plain in-transaction indexes confirmed from rehearsal measurement (max build 0.841 ms on real anonymized prod data) — no out-of-runner CONCURRENTLY path needed for 0001
- [Phase ?]: 03-05 rehearsal digest = md5(string_agg(md5(ROW(pinned pre-migration column inventory)::text),'' ORDER BY id)); carve-out implemented AS the pinned inventory (0001's added columns outside by construction), labeled in evidence — Phase 7 extends the list, not the pipeline
- [Phase ?]: 03-05 per-statement DDL timing probe = pg_stat_statements (reset before the timed migrate; extension created before both structure snapshots so the additive-only diff stays clean) — server logs give one duration per query STRING and the migrator submits each migration file as one multi-statement string
- [Phase ?]: 03-06: restart-survival check corrected to the 6th window request 429 — plan's '5th' was off by one vs shipped register route (limit:5/h); 03-08 must follow the runbook arithmetic
- [Phase ?]: 03-06: RDS-03 left unchecked — documented half only; 03-08 (also carries RDS-03) executes the hardening live
- [Phase ?]: 03-06: §3c threshold carries both ~358 MB decimal and the exact 377,487,360 bytes (360 MiB); §3 step 3/§3d note the 03-03 spidernode-dev-db deviation instead of hard-asserting Neon
- [Phase ?]: 03-07: schema gate compares STRUCTURALLY not textually — pull's top-level order (imports, tables) is unstable run-to-run; imports as canonicalized sorted set, export blocks by name with internal lines ordered
- [Phase ?]: 03-07: gen_random_uuid defaults kept in canonical .default(sql`...`) form; gate rewrites .default((IDENT())) symmetrically on both diff sides
- [Phase ?]: 03-07: gate targets docker test DB only (5453), vitest-identical URL resolution + localhost guard; full verify 31s warm, gate adds ~2.4s
- [Phase 03]: [Phase 03]: 03-08: operator-ratified local-only release topology — DB leg on spidernode-dev-db (03-03 ground truth), dedicated hardened Redis stand-in container, app via pnpm start; VPS-only mechanisms (systemd/cron/healthchecks.io) dispositioned N/A-locally in 03-DEPLOY-RECORD.md
- [Phase 03]: [Phase 03]: 03-08: RDS-03 + DRZ-02 closed under the ratified topology — every applicable §3b directive proven live (requirepass/loopback/AOF-everysec/512mb/noeviction/restart) and the schema pipeline ran against the real production DB; limiter window survived app restart (6th request 429) AND counter survived Redis restart (AOF)
- [Phase 03]: verification 2026-09-12 — 11/12 must-haves verified live by gsd-verifier (D-20 suite re-run 5/5, empty pull-diff independently reproduced, 2 migration rows + all prereq DDL confirmed on the production DB, hardened Redis CONFIG checked); the 12th clause (SC5 memory-alert application) dispositioned, not failed
- [Phase 03]: UAT close 2026-09-12 — operator dispositions: (b) runbook §3c 70%-memory alert application deferred to the first real VPS deploy (forward-tracked in PROJECT.md Context; AR-01 in 03-SECURITY.md); mvp mode tag dropped from Phase 3 (standard goal-backward verification, Phase 2 precedent)
- [Phase 03]: security closeout 2026-09-12 — 03-SECURITY.md: 24/24 register rows closed at L1/ASVS-1; one conditional accepted risk AR-01 (§3c alert until VPS deploy); code-review findings (03-REVIEW.md: 1 Critical + 6 Warnings) judged non-blocking for phase-03 criteria but carried forward — see Blockers/Concerns
- [Phase 04]: 04-01: tsup 8.5.1 locked despite unmaintained status per D-02 — ~15-line verified config surface, bundler is a swappable seam (04-RESEARCH OQ1); operator approved the SUS-by-recency set (bullmq/tsx/undici) against registry pages at the blocking gate
- [Phase 04]: 04-01: global Read deny rule narrowed from .env.* to secret-bearing variants (.env/.env.local/.env.test) so .env.example stays writable — WORKER_* doc block landed as 18204fc; secret-bearing env files never read
- [Phase 04]: 04-02: manual-check jobId is check-manual:{monitorId}:{epochMs} (3 segments) — BullMQ 6 rejects 4-segment colon jobIds; 01-08 per-enqueue-unique semantics kept via a monotonic token
- [Phase 04]: 04-02: every BullMQ depth/age read counts the PRIORITIZED set (metrics gauge AND backlog gate) — bullmq 6.3 files priority-carrying jobs there, all check-lane jobs carry one; wait-only reads make RES-02 untrippable (pinned by real-queue test)
- [Phase 04]: 04-02: JobSchedulerJson identity is .key (bullmq 6) — optional .id is the delayed job id, absent until materialized; scheduler assertions key on it
- [Phase 04]: 04-02: OBS-01 and WRK-10 NOT marked complete — only the metrics subset (04-07 completes transition->alert latency) and the flag mechanic (04-09 deploys the dark launch) landed; 02-03/03-02 false-signal precedent
- [Phase Phase 04]: 04-03: errorClass vocabulary pinned lowercase per audit 11/15.1/23 (timeout|dns|tls|ssrf_blocked|http_5xx|network); plan prose mixed cases, the audit is the transcription authority and 04-04 writers consume exactly these tokens (4xx DOWN carries none)
- [Phase 04]: 04-03: CheckRequest.denylist is a documented TEST-ONLY seam defaulting to DENYLIST (single-machine fixtures can only bind denylisted addresses; tests omit exactly the ::1 token); production callers (04-06, Phase 6) must never set it; D-40 gate reads the DENYLIST export
- [Phase 04]: 04-03: connection pinning is structural — one undiciFetch call with dispatcher: agent whose custom connect.lookup answers only from the validateHop-populated map; literal-IP hosts skip DNS so validating the literal IS the pin; unpinned dials fail closed (ESSRF_PIN_VIOLATION -> ssrf_blocked)
- [Phase 04]: 04-03: undici empirics — a lying-small Content-Length is truncated by undici's parser at the declared length, so the streamed 2 MB cap is proven on a CHUNKED 3 MB body (fixture byte counter frozen below total) and the lying-header case asserts the outcome stays header-derived (D-43)
- [Phase 04]: 04-03: WRK-05 and DAT-10 NOT marked complete — the classification contract and vocabulary landed here, but WRK-05's successful-jobs exercise (04-06) and DAT-10's recording on pings/incidents (04-04 writers) are the completion legs; only SEC-01 closed (02-03/04-02 false-signal precedent)
- [Phase 04]: 04-04: D-36 final form — uptime rounding is exact binary extraction (power-of-two ::bigint shift, 2^52 for y>=1 / 2^60 for y<1, then floor((m*100 + 2^(s-1))/2^s)), NOT round(::numeric,2): every round form fails inexact .xx5 ties because PG float8::numeric collapses to the shortest round-trip decimal, landing exactly ON the tie (66.675) while the true expansion sits below; 73,210-ratio sweep byte-identical to legacy JS toFixed(2); never reintroduce round() — both suites pin the shipped form
- [Phase 04]: 04-04: Tier1Input defined locally with zero imports from 04-03's ssrf module (same-wave no-file-overlap); 04-06's processor joins CheckOutcome and Tier1Input structurally; outbox payload shape (monitorName/monitorUrl/statusCode/responseTimeMs/errorClass/occurredAt/userTimezone/claimEpoch) is what 04-08's relay renders from — extend, never rename
- [Phase ?]: 04-05: Tier-2 staging is ONE hash stage:{monitorId} (plan key pin) with row-derived deltas - dTotal/dFailed derive from the staged ping:{slot} evidence rows, never a parallel counter field, so counters can never account a check whose evidence row is absent
- [Phase ?]: 04-05: Redis RENAMENX semantics pinned - source-absent arrives as an ERROR reply (not 0) and is the benign nothing-staged no-op; target-exists (returns 0) under our deterministic batchId is our own pre-crash snapshot and IS applied; plain rename remains forbidden (CR-02)
- [Phase ?]: 04-05: stageResult accepts UP-class ONLY (throws on DOWN-class; 04-06 routes every non-UP outcome to Tier 1) and the flush job's batchId must be carried in job data, never minted inside the processor
- [Phase ?]: 04-07: relay claims per-row with FOR UPDATE SKIP LOCKED (batch 50, 5s cadence) instead of the audit's whole-batch lock — a synchronously-sending relay cannot hold a batch lock across Telegram I/O; concurrent passes partition rows without double-sends
- [Phase ?]: 04-07: outbox FAILED is a zero-migration derived state (payload ? '_relayFailure' jsonb marker OR attempts>=3); attempts counts failed sends only, so permanent 400/401/403 failures stop below the cap and fail-twice-then-succeed records exactly 2 (D-44/D-45)
- [Phase ?]: 04-07: maintenance dry-run is the DEFAULT (absent flag = zero writes); retention scope is cleanup-logic parity (pings 30d, RESOLVED incidents 90d) with write_guards >7d reported but never deleted (deferred); D-37 audit recomputes uptime_percent with the writers' D-36 expression in absolute form
- [Phase 04]: 04-08: resilience suite lives OUTSIDE pnpm verify as pnpm test:resilience (D-27) — vitest.config.ts excludes tests/resilience/**; verify = what the code does, test:resilience = what breakage it survives (D-31)
- [Phase 04]: 04-08: check.ts TEST-ONLY seams — env-gated WORKER_TEST_CRASH_AFTER=tier1_commit SIGKILL hook (D-29, inert without the env) + checkpoints.beforeReverify (deterministic lock-loss injection); both source-pinned by the cases (T-04-30)
- [Phase 04]: 04-08: breaker pg-classification is cause-chain-aware — drizzle's DrizzleQueryError hides the pg error at the top level; errno-class socket codes classify infra on the worker-DB call-context regardless of message form, EXCEPT ENOTFOUND (connect-message-gated — the WRK-05 target-NXDOMAIN pin holds)
- [Phase 04]: 04-08: two production defects found+fixed by injection — worker CRASHED on unlistened Pool 'error' (idle-client 57P01 termination) during a Postgres outage; breaker NEVER opened (cause-chain blindness) — both pinned green in unit + injection suites
- [Phase 04]: 04-08: test Redis runs redis:8-alpine STOCK (restart state indeterminate by design) — redis-restart proves the RES-05 recovery contract (boot re-upsert + TTL expiry + next_check_at re-claim), not persistence invariants the image cannot give
- [Phase 04]: 04-08: D-34 dispositioned, not built — no relative "Xm ago" surface exists; the staleness pin asserts the raw toLocaleTimeString surface + "Never" ternary on Dashboard/MonitorDetails/PublicStatus
- [Phase 04]: 04-09: dark launch approved by operator 2026-09-14 — worker live zero-schedulers ~4h, cron 100%, smoke PASS; fail-loud smoke contract validated by a wrong-env attempt; SEC-02 left pending by D-17 disposition (OS egress enforced at first VPS deploy)
- [Phase ?]: [Phase 04]: verification + UAT close 2026-09-15 — 11/12 must-haves verified live; 12th clause (SEC-02 OS egress) ACCEPTED as formal override (operator mehedishubho, mirrors 03 AR-01; REQUIREMENTS stays Pending until first VPS deploy); mvp tag dropped (Phase 3 precedent); OBS-02 kept Pending until Phase 5 scheduler-on; REVIEW 9af088a 0C/5W/3I advisory (WR-01 heartbeat = Phase 5 WRK-09 input)
- [Phase 05]: 05-01: WR-05 pin is behavioral + source-form — docker stand-in already spells UTC, so the options-pin assertion is what makes drift fail loudly
- [Phase 05]: 05-01: rollbackFailedClaim deleted — audit §14.4 claims-advanced is the only behavior (breaker refusal incl. WR-02 TOCTOU is a SKIP)
- [Phase 05]: 05-01: oldestUnsentSeconds convention — null when nothing unsent (queue-gauge precedent), -1 on query failure
- [Phase 05]: 05-01: WR-04 audit conclusion — Telegram send was the only internet-path await in the relay transaction; 10s AbortSignal bounds it, local PG/Redis awaits reaped by the 30s idle cap
- [Phase 05]: 05-01: WRK-11/OBS-03 deliberately left Pending — this plan lands their inputs only (WRK-11 completes at 05-08 window, OBS-03 at 05-02 dead-man)
- [Phase 5]: 05-04: §4a choreography appended as steps 5-11 (existing 1-4 kept as dark-launch history); D-19 age bound pinned 120 s; both cron routes verified GET-only before documenting the curl lever
- [Phase 5]: 05-04: DEP-05/WRK-11 deliberately left Pending — doc wave only; WRK-11 completes at the 05-08 window, DEP-05 at phase end when the deletion release executes the dated paths (D-40)
- [Phase ?]: [Phase 05]: 05-02: unknown outbox age (-1 sentinel or throwing read) withholds the ping — silence fails toward detection; the 5-min grace absorbs one transient read failure, a sustained gauge failure SHOULD page, and heartbeat /fail stays reserved for tick-level claim/enqueue exceptions
- [Phase ?]: [Phase 05]: 05-02: memory check has NO crossing /fail (D-24/D-25 silence + 30-min grace is the memory page); outbox-age crossing keeps its single /fail marker (D-23)
- [Phase ?]: [Phase 05]: 05-02: default memory provider reads ONE INFO on workerQueues().connection (the 25-budget shared producer) — production boot creates the queue set before the first tick, so no new connection is ever minted; route documented in-code
- [Phase ?]: [Phase 05]: 05-02: WRK-09/OBS-03 deliberately left Pending — code + tests landed but the real healthchecks.io checks are provisioned at window-open (D-37); live paging proves out at 05-08 window evidence (02-03/04-02 false-signal precedent)
- [Phase 05]: 05-03: gauge degradation is reset/remove FIRST then set — a failed collector yields ABSENT samples (never stale scrape values); unlabelled gauges clear via remove() because reset() renders a lying 0 (probe-verified)
- [Phase 05]: 05-03: no snapshot memoization between gauge families — every scrape reads the live collectors; a TTL cache masks collector failures within its window (caught by the RED suite)
- [Phase 05]: 05-03: /metrics stays 404 without an injected registry; health.ts takes the registry STRUCTURALLY (contentType + async metrics()) so the module stays package-free
- [Phase 05]: 05-03: @prometheus-io/client 0.16.1 legitimacy cleared (official org repo, prombot/nexucis/juliusv maintainers, no install scripts) under the plan-review-approved exact pin; deprecated prom-client never installed
- [Phase 05]: 05-03: OBS-05 deliberately left Pending — export surface + family contract landed, but 05-05's throwaway scraper (D-27) and window gate-2 consumption are the proof legs (05-01/05-02 false-signal precedent)
- [Phase ?]: 05-05: counters-baseline.json mechanism — gate 4's D-02 total_count delta needs a window-open baseline (--capture-baseline); lifetime reconcile is polluted by retention
- [Phase ?]: 05-05: gate 3 — duplicate relay rows per incident event FAIL; zero-alert cron-originated incidents and extraTransientAlerts listed for disposition, not failed (D-05)
- [Phase ?]: 05-05: check-cron-remnants.mjs ships INERT (advisory) — verify-leg wiring + dep removal belong to the 05-09 deletion release; this plan touches no package.json
- [Phase ?]: 05-05: gate-cutover degrades DB-backed gates to FAIL-with-reason on unreachable DB (never crashes); gate 1 without key/cache degrades to manual-evidence instructions
- [Phase ?]: 05-05: WRK-11/OBS-05 stay Pending — proof is the live >=4h window evidence 05-08 captures (false-signal precedent)
- [Phase 05]: 05-06: maintenance job contract — name 'cleanup' (processMaintenanceJob throws otherwise; the plan's 'named manual-maintenance' realized as jobId manual-maintenance:<mode>:<epoch-ms>, EXACTLY 3 colon segments — a 2-segment id throws 'Custom Id cannot contain :', caught live on a throwaway Redis)
- [Phase 05]: 05-06: induced-parity target = TEST-NET-3 sibling containers (203.0.113.0/24, RFC 5737) — the SSRF denylist blocks every loopback/private target so a loopback target is DOWN-only (ssrf_blocked) and can never produce the UP leg; 05-CONTEXT D-11 leaves the target form to execution
- [Phase 05]: 05-06: gates two-pass — pass A with TRUE bounds asserts the sub-4h D-16 refusal (the clock rule is part of what is rehearsed); pass B with extended bounds (end=now so induce/drill pings stay inside for gate 4) runs ONLINE against the throwaway DB — strictly more real than offline fixtures whose comparison contract 05-05's tests pin
- [Phase 05]: 05-06: induce determinism — interval 1440 + fresh lastChecked/next_check_at starves BOTH engines so manual enqueue is the sole check driver (Pitfall 2 race avoided); monitor created via INSERT mirroring the /api/monitors route's exact data shape (NextAuth session unmintable on the anonymized stand-in)
- [Phase 05]: 05-06: drill auto-resume proven via the §9 curl lever (Bearer CRON_SECRET runs due checks + in-request flush) — legacy cron's batcher makes raw ping-count polling lag; natural 1-min pass observational only
- [Phase 05]: 05-06: WRK-11/DEP-03 deliberately stay Pending — choreography encoded and self-tested, but proof is 05-07 executing the rehearsal + 05-08's live window evidence (false-signal precedent)
- [Phase 05]: 05-07: rehearsal red items are harness bugs until proven otherwise — 3 fixes (docker-cp path, induce throwaway chat-owner, byteMatch D-48 subset+allowlist) all in scripts/, src/ untouched; every red item forced a FULL --leg all re-run per D-31/D-36 (5 runs, run 4 = transient 0xC0000005)
- [Phase 05]: 05-07: D-48 payload contract codified as subset semantics in byteMatch — all 8 D-48 keys required, writer extensions only via pinned allowlist [monitorId] (writer emits it since 04-04; no consumer reads it)
- [Phase 05]: 05-07: production snapshot has ZERO telegram-bound users (anonymizer preserves non-null chat ids — none exist), so the induce leg seeds a throwaway chat id on the oldest user when the dump has none (stand-in only; dummy token keeps relay attempts FAILED, D-34)
- [Phase 05]: 05-07: deployed worker = the REHEARSED byte-identical bundle (dist/worker.js sha256 847280f10b981b00; failed main-tree rebuilds died pre-tsup); web .next from a clean worktree build of the same commit 7b5a997; D-31 pins commit SHA + deployed-worker byte equality — bundle bytes are nondeterministic across same-commit rebuilds
- [Phase 05]: 05-07: D-04 manual-check proof uses the REAL credentials flow (synthetic sentinel armed with throwaway bcrypt password + emailVerified, stand-in DB only) after the permission system correctly denied the .env-reading JWT-mint approach — no workaround attempted, zero secret reads
- [Phase 05]: 05-07: WRK-11/DEP-03 deliberately stay Pending in REQUIREMENTS.md — rehearsal+soak here is the precondition; the proof requirement is 05-08's live window (05-06 precedent)
- [Phase ?]: 05-08: Cutover gates PASS 7/7 on a continuous 18000s live window (byteMatch true, real-chat delivery, pings==delta exact); D-18 operator approval of the deletion release recorded APPROVED 2026-09-17T08:02Z
- [Phase ?]: 05-08: Every observed co-run hazard (batcher clobber class, over-check bursts, mixed-authorship transitions, dead lanes) is legacy-side; D-20 GREEN — worker engine fit to own 100% of checks
- [Phase ?]: 05-08: Tier-1 applied:false duplicate checks commit a ping without a counter by DAT-04 design (tier1.ts evidencePingSql) — gate-4 pings==delta audits are deterministic only for windows without Tier-1 no-ops
- [Phase ?]: 05-09: D-43 zero-loss drain executed via empty-batcher-window kill (18:45:00.111Z) after the curl-lever proved impossible on the stand-in (web never carried CRON_SECRET)
- [Phase ?]: 05-09: D-21 resolved-by-absence — operator's only hc.io project holds the worker trio + a never-pinged default check; second account deleted; no old-cron check can false-page
- [Phase ?]: 05-09: tier-2 rehearsal finding — the 9f667e2 tarball needs 2 node_modules junction shims on fresh install (Turbopack mangled instrumentation externals); current build immune; runbook §7 amended
- [Phase ?]: Manual check is a stateless producer: POST returns 202 {jobId, queuedAt}; the client polls GET /api/monitors until lastChecked > queuedAt — never BullMQ job state (06-01, D-01/D-05)
- [Phase ?]: Web-side BullMQ access goes through a globalThis-cached bounded producer (maxRetriesPerRequest 1, 1s connect/command timeouts): Redis-down rejects fast to a 503 instead of hanging the request (06-01, API-02)
- [Phase ?]: Rate limiter now returns resetSeconds from the atomic INCR+EXPIRE+PTTL Lua script; 429s carry a numeric Retry-After header (06-01, D-06/SEC-05)
- [Phase 06]: Email lane uses Worker settings.backoffStrategy with the exact D-09 table [30s,2m,8m,30m,2h]; EMAIL_JOB_OPTIONS lives only in src/lib/email/enqueue.ts (queues.ts re-export dropped — module-scope cycle)
- [Phase 06]: EML-03 conservative error taxonomy: only EAUTH/EENVELOPE/EMESSAGE/responseCode>=500 dead-letter via UnrecoverableError; timeouts/4xx/unknown retry per D-09
- [Phase 06]: Register/forgot pre-flight ping placed before the Redis-backed limiter so Redis-down deterministically yields the bounded 503 (D-29/Pitfall 6)

### Pending Todos

None yet.

### Blockers/Concerns

- Research flags requiring `--research-phase` during planning: Phase 7 (social `providerId` casing, token-flow cutover, cookieCache revocation lag) — Phase 3's flags were resolved in 03-RESEARCH.md (Pattern 4 journal/hash verification; D-19 in-transaction indexes) and Phase 4's in 04-RESEARCH.md (BullMQ 6 semantics verified against docs.bullmq.io)
- Live production system: every cutover step needs a full `pg_dump` backup and an anonymized-snapshot rehearsal first (D-9/D-10)
- [Phase 6/7] 03-REVIEW carry-forwards still open: WR-05 (hard-coded journal count 2 in rehearse-migrations.mjs) — fix before Phase 7 rehearsal reuse; WR-06 (limiter keys on raw `x-forwarded-for`) pairs with Phase 6's S-series security work. (CR-01 stale 0001_snapshot.json + WR-01 `bool_ops` on `idx_monitors_due` were repaired in Phase 3/4 — snapshot refreshed 2026-09-13, schema.ts:98 carries `bool_ops`; WR-02 rehearsal 0.0.0.0 bind was fixed by 05-06 D-45.) The 01-VERIFICATION design-debt register CR-01/CR-02 was consumed at Phase 4/5 planning (04-04 D-35 in-UPDATE `uptime_percent`; 05-04 D-08 gated-window §20.1 amendment)
- [Phase 6] Code-review inputs from 05-REVIEW.md (committed 5128d49): WR-01 (enqueue-maintenance.mjs hangs forever on unreachable Redis), WR-02 (relayRedis() second ioredis client never quit in drainAndTeardown), WR-03 (daily maintenance hardcoded dryRun:true — no autonomous retention post-cutover) + 9 Info findings; deferred-items.md (playwright.config.ts:63 stale CRON_MODE=vercel writer; stand-in CRON_SECRET mint; junction-shim procedure)
- [Phase 8] WR-02 accepted input: light-mode legibility of unmigrated marketing surfaces + light dashboard/toast polish notes are Phase-8 planning inputs (02-UAT.md Decision Record, 2026-09-12); mixed emerald/rose ternaries flagged for Phase 8 UI-03 review also ride along

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-09-20T17:56:51.784Z
Stopped at: Completed 06-02-PLAN.md
Resume file: None
