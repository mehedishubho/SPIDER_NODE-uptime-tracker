---
status: findings
phase: 07-better-auth-cutover-admin-gating-prisma-removal
review: 07-REVIEW.md
recorded_at: 2026-09-29
updated_at: 2026-09-29
severity:
  critical: 0
  warning: 1
  info: 2
  total: 3
open: 3
fixed: 4
skipped: 0
---

<!-- Ledger for the incremental re-review after the 07-10/07-11 gap-closure wave.
     CR-01/WR-01/WR-02/WR-04 are FIXED and re-review-verified (rows preserved for audit).
     WR-03 (WINDOWS #4) is deliberately NOT fixed in this phase — deferred to Phase 8 in plan
     frontmatter `deferred:`; the re-review confirmed no 07-10/07-11 work touched it.
     Hand-triage welcome: edit the Disposition column (open | fixed | skipped | deferred). -->

## Disposition Ledger

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| CR-01 | critical | fixed | fixed by 07-10 (`66b13a2`): iso() seam at all 8 response sites, poll compares ISO-parsed instant vs queuedAt epoch; re-review VERIFIED FIXED 2026-09-29. Original: Drizzle mode:'string' naive timestamps broke check-now-poll.ts:63 comparisons in UTC+/- and shifted display times |
| WR-01 | warning | fixed | fixed by 07-10: updatedAt restored on monitors PATCH (`monitors/[id]/route.ts:161`), profile PATCH (`:182`), telegram webhook (`:91`); re-review VERIFIED FIXED — full src/ sweep found no other .update sites |
| WR-02 | warning | fixed | fixed by 07-10: empty-set PATCH guard after ownership 404, Prisma-era `{message, monitor}` 200 shape pinned; re-review VERIFIED FIXED |
| WR-03 | warning | open | Profile password flow verifies/writes users.password while Better Auth authenticates account.password — WINDOWS #4, explicitly deferred to Phase 8 (plan frontmatter `deferred:`); NOT in this gap-closure scope |
| WR-04 | warning | fixed | fixed by 07-11 (`f71cbdc`): DEFAULT_ROOTS gains scripts/ (466-file perimeter), deleted-basename FILE-NAME check, 3 exact-filename token-only exemptions; re-review VERIFIED FIXED (a renamed file forfeits its exemption and trips — pin 5h) |
| IN-01 | info | open | .next NEXTAUTH_URL exemption not library-scoped; dist/worker.js asymmetry noted (documented conscious acceptance) |
| IN-02 | info | open | Rehearsal evidence renderer labels FATAL index removals as "sanctioned 0003" |
| IN-03 | info | open | Orphaned display data/unused imports left in TeamSwitch.tsx |
| WR-05 | warning | open | NEW (re-review 2026-09-29): tests/integration/wire-timestamps.test.ts WR-01 legs compare Date.now() against a hardcoded same-day seed (2026-09-29T15:00:00.789Z) — clock-skew false-RED risk; seed a fixed past instant |
| IN-04 | info | open | NEW (re-review): src/lib/serialize.ts:50 unparseable-passthrough untested — pin it and log once so the CR-01 failure shape cannot silently return on format drift |
| IN-05 | info | open | NEW (re-review): gate file-NAME check fails any future legitimate mail.*/tokens.* file — documented conscious-act escape hatch exists; no action now |
