# Deferred Items — Phase 05

Out-of-scope discoveries logged during execution. Not fixed per the scope boundary; revisit when the owning context arrives.

## 2026-09-15 (05-05): gsd-tools `roadmap update-plan-progress` cannot paint the ROADMAP summary Progress table on this layout

- **Found during:** 05-05 state updates.
- **Issue:** The handler builds its table-row regex non-globally (`^(\|\s*0*5\.?\s[^|]*(?:\|[^\n]*))$`, flag `im`). On this ROADMAP the FIRST matching line is the phase→requirements mapping row `| 5 Cutover & Ops | WRK-09/11, DEP-03/05, OBS-03/05 | 6 |` (~line 322), not the bottom Progress table row (~line 342). The 3-cell mapping row hits neither the 4- nor 5-column branch and is reconstructed unchanged, consuming the single replace; the real Progress row is never updated.
- **Blast radius:** Pre-existing for every phase 3-8 row — e.g. phase 4 shows `0/9 | Planned` in the Progress table despite its section/checklists showing real execution. Per-phase sections (`**Plans**: N/M plans executed`, wave checkboxes) update correctly and remain the authoritative record.
- **Handling here:** The phase 5 Progress row was corrected manually to `5/9 | In Progress` after the handler run; rows for phases 3, 4, 6, 7, 8 are left for their owning executors (phase 4's true count/completion status involves its UAT gates — not adjudicated here).
- **Fix location (when taken):** `~/.claude/gsd-core/bin/lib/roadmap.cjs` — anchor the table-row pattern to the Progress table section (or require the row to have >= 4 cells before claiming the match).
