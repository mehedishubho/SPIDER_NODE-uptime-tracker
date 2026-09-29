---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 3
total_count: 4
last_updated: 2026-09-29T14:58:43.300Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 07 | unrun-verify | playwright.config.ts |  | 07-07 pre-flight e2e leg skipped environmental: port 3100 held by unrelated live project (deshioplatform); operator may free 3100 and re-run pnpm test:e2e before the flip | fixed |  | 2026-09-23T23:08:40.606Z | 2026-09-29T10:42:19.780Z |
| 2 | 07 | deviation | src/lib/auth-password.ts |  | 07-07 soak finding: lazy-rehash UPDATE targets account.password while verify/hashPassword read users.password (adapter mapping) — rehash matches 0 rows when the copies diverge; practical impact ~nil (bcrypt-10 both sides); one-line fix + test queued in 07-08 plan | fixed |  | 2026-09-25T12:08:11.766Z | 2026-09-29T10:42:19.438Z |
| 3 | 07 | unmet-truth | .planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-DEPLOY-RECORD.md |  | 07-08 deletion deploy BLOCKED at runbook 4d step 2: the production DB (spidernode-dev-db container + volume) was destroyed by the machine-level event that also deleted git.exe (stack dark since 2026-09-25T23:02Z); newest surviving backup is the pre-flip pre-phase7-flip-20260924-2147.dump — restore-vs-wait is an irreversible production-data decision reserved to the operator (record section 16) | fixed |  | 2026-09-29T10:42:43.566Z | 2026-09-29T14:58:43.300Z |
| 4 | 07 | deviation | src/app/api/user/profile/route.ts |  | Discovered during the 07-08 DRZ-07 conversion sweep: the profile PATCH password flow verifies/writes the legacy users.password copy while the Better Auth engine reads/writes account.password — a profile-set password never changes the login password (pre-existing since the flip, preserved behavior-neutral through the conversion); the real fix routes the flow through better-auth changePassword — Phase-8 scope, operator to prioritize | open |  | 2026-09-29T10:42:43.932Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "07",
    "file": "playwright.config.ts",
    "line": null,
    "description": "07-07 pre-flight e2e leg skipped environmental: port 3100 held by unrelated live project (deshioplatform); operator may free 3100 and re-run pnpm test:e2e before the flip",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-09-23T23:08:40.606Z",
    "resolved_at": "2026-09-29T10:42:19.780Z",
    "milestone": "v1.0"
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "07",
    "file": "src/lib/auth-password.ts",
    "line": null,
    "description": "07-07 soak finding: lazy-rehash UPDATE targets account.password while verify/hashPassword read users.password (adapter mapping) — rehash matches 0 rows when the copies diverge; practical impact ~nil (bcrypt-10 both sides); one-line fix + test queued in 07-08 plan",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-09-25T12:08:11.766Z",
    "resolved_at": "2026-09-29T10:42:19.438Z",
    "milestone": "v1.0"
  },
  {
    "id": 3,
    "kind": "unmet-truth",
    "phase": "07",
    "file": ".planning/phases/07-better-auth-cutover-admin-gating-prisma-removal/07-DEPLOY-RECORD.md",
    "line": null,
    "description": "07-08 deletion deploy BLOCKED at runbook 4d step 2: the production DB (spidernode-dev-db container + volume) was destroyed by the machine-level event that also deleted git.exe (stack dark since 2026-09-25T23:02Z); newest surviving backup is the pre-flip pre-phase7-flip-20260924-2147.dump — restore-vs-wait is an irreversible production-data decision reserved to the operator (record section 16)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-09-29T10:42:43.566Z",
    "resolved_at": "2026-09-29T14:58:43.300Z",
    "milestone": "v1.0"
  },
  {
    "id": 4,
    "kind": "deviation",
    "phase": "07",
    "file": "src/app/api/user/profile/route.ts",
    "line": null,
    "description": "Discovered during the 07-08 DRZ-07 conversion sweep: the profile PATCH password flow verifies/writes the legacy users.password copy while the Better Auth engine reads/writes account.password — a profile-set password never changes the login password (pre-existing since the flip, preserved behavior-neutral through the conversion); the real fix routes the flow through better-auth changePassword — Phase-8 scope, operator to prioritize",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-29T10:42:43.932Z",
    "resolved_at": null,
    "milestone": "v1.0"
  }
]
````
