
## 08-04 session (2026-10-01)

- **Zero-hex gate sanctioned-list staleness (pre-existing, out of scope):** `src/lib/email/render.ts` (Phase-7 07-02, commit 4016554) carries email-HTML inline `#hex` colors — same rationale as the sanctioned `src/lib/mail.ts` (email clients cannot use CSS vars) — but was never added to the 02-08 gate's exclusion list. Discovered running the 02-08-form zero-hex gate during 08-04 self-check; NOT introduced by 08-04 (no 08-04 diff touches it). Disposition for 08-05 (globals.css/token work): either add `render.ts` to the sanctioned exclusions or route the template through tokens where clients allow.
