---
schema_version: 1
open_count: 2
waived_count: 0
fixed_count: 0
total_count: 2
last_updated: 2026-09-25T12:08:11.766Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 07 | unrun-verify | playwright.config.ts |  | 07-07 pre-flight e2e leg skipped environmental: port 3100 held by unrelated live project (deshioplatform); operator may free 3100 and re-run pnpm test:e2e before the flip | open |  | 2026-09-23T23:08:40.606Z |  |
| 2 | 07 | deviation | src/lib/auth-password.ts |  | 07-07 soak finding: lazy-rehash UPDATE targets account.password while verify/hashPassword read users.password (adapter mapping) — rehash matches 0 rows when the copies diverge; practical impact ~nil (bcrypt-10 both sides); one-line fix + test queued in 07-08 plan | open |  | 2026-09-25T12:08:11.766Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "07",
    "file": "playwright.config.ts",
    "line": null,
    "description": "07-07 pre-flight e2e leg skipped environmental: port 3100 held by unrelated live project (deshioplatform); operator may free 3100 and re-run pnpm test:e2e before the flip",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-23T23:08:40.606Z",
    "resolved_at": null,
    "milestone": "v1.0"
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "07",
    "file": "src/lib/auth-password.ts",
    "line": null,
    "description": "07-07 soak finding: lazy-rehash UPDATE targets account.password while verify/hashPassword read users.password (adapter mapping) — rehash matches 0 rows when the copies diverge; practical impact ~nil (bcrypt-10 both sides); one-line fix + test queued in 07-08 plan",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-25T12:08:11.766Z",
    "resolved_at": null,
    "milestone": "v1.0"
  }
]
````
