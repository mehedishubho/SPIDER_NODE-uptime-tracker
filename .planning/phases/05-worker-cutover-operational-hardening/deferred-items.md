# Deferred Items — Phase 05

Out-of-scope discoveries logged during execution. Not fixed per the scope boundary; revisit when the owning context arrives.

## 2026-09-15 (05-05): gsd-tools `roadmap update-plan-progress` cannot paint the ROADMAP summary Progress table on this layout

- **Found during:** 05-05 state updates.
- **Issue:** The handler builds its table-row regex non-globally (`^(\|\s*0*5\.?\s[^|]*(?:\|[^\n]*))$`, flag `im`). On this ROADMAP the FIRST matching line is the phase→requirements mapping row `| 5 Cutover & Ops | WRK-09/11, DEP-03/05, OBS-03/05 | 6 |` (~line 322), not the bottom Progress table row (~line 342). The 3-cell mapping row hits neither the 4- nor 5-column branch and is reconstructed unchanged, consuming the single replace; the real Progress row is never updated.
- **Blast radius:** Pre-existing for every phase 3-8 row — e.g. phase 4 shows `0/9 | Planned` in the Progress table despite its section/checklists showing real execution. Per-phase sections (`**Plans**: N/M plans executed`, wave checkboxes) update correctly and remain the authoritative record.
- **Handling here:** The phase 5 Progress row was corrected manually to `5/9 | In Progress` after the handler run; rows for phases 3, 4, 6, 7, 8 are left for their owning executors (phase 4's true count/completion status involves its UAT gates — not adjudicated here).
- **Fix location (when taken):** `~/.claude/gsd-core/bin/lib/roadmap.cjs` — anchor the table-row pattern to the Progress table section (or require the row to have >= 4 cells before claiming the match).

## 2026-09-16 (05-07): Playwright browser specs blocked by machine-local Chromium spawn denial

- **Found during:** 05-07 Task 3 pre-flight (`pnpm verify` at the release commit `7b5a997`).
- **Issue:** Every browser-project spec fails at launch with `browserType.launch: spawn UNKNOWN`; executing the downloaded `chromium_headless_shell-1243` binary directly returns `Permission denied` deterministically (fresh re-download reproduces; identical ACLs on working revision 1228's binary; no Mark-of-the-Web; valid PE; full `chrome.exe` from the same cache spawns fine). Appeared after the 2026-09-16 machine outage/reboot that also killed the rehearsal containers. The identical suite was green on 04-09.
- **Blast radius:** e2e API project still 18/18 GREEN; all non-browser verify stages green. Only browser-headed specs are affected, on this machine, at the OS level.
- **Handling here:** Documented as an environment fault, not a code finding; deploy proceeded with the browser project blocked (05-DEPLOY-RECORD.md Pre-flight). No workaround attempted beyond the re-download.
- **Fix location (when taken):** Machine-level — re-run `pnpm exec playwright install chromium` after checking Windows Defender/AV quarantine history and the user's ACLs on `%LOCALAPPDATA%\ms-playwright`; if the denial persists, reinstall the Playwright browsers under a fresh cache dir. Re-run `pnpm test:e2e` to confirm before 05-08's window day.
