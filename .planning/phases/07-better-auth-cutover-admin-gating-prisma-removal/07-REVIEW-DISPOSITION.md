---
status: findings
phase: 07-better-auth-cutover-admin-gating-prisma-removal
review: 07-REVIEW.md
recorded_at: 2026-09-29
severity:
  critical: 1
  warning: 4
  info: 3
  total: 8
open: 8
fixed: 0
skipped: 0
---

<!-- Ledger written by the execute-phase code_review_gate disposition step (cmd.exe adaptation).
     Hand-triage welcome: edit the Disposition column (open | fixed | skipped | deferred) and add
     your reason in the Source column. `--auto`/`--fix` runs reconcile against this file. -->

## Disposition Ledger

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| CR-01 | critical | open | Drizzle `mode:'string'` timestamps return naive Postgres text, not ISO-8601 UTC — check-now poll date comparisons break (never completes in UTC+, false-completes in UTC−) and dashboard displays shift by UTC offset (src/lib/check-now-poll.ts:63; ported routes) |
| WR-01 | warning | open | Prisma `@updatedAt` semantics lost on UPDATE — monitors PATCH, profile PATCH, telegram webhook never advance updatedAt (stale responses) |
| WR-02 | warning | open | monitors PATCH with empty update set 500s (Drizzle `.set({})` throws) where Prisma returned 200; profile route has the guard this one lacks |
| WR-03 | warning | open | Profile password flow verifies/writes users.password while Better Auth authenticates account.password — profile-set password never changes login credential (already open as WINDOWS #4, Phase-8 scope) |
| WR-04 | warning | open | Armed remnant gate never scans scripts/ or anything outside src/ — a re-created send-relogin-blast.mjs produces zero findings |
| IN-01 | info | open | .next NEXTAUTH_URL exemption not library-scoped; dist/worker.js asymmetry noted |
| IN-02 | info | open | Rehearsal evidence renderer labels FATAL index removals as "sanctioned 0003" |
| IN-03 | info | open | Orphaned display data/unused imports left in TeamSwitch.tsx |
