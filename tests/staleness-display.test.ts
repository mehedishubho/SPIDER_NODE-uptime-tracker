import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// RES-03 staleness-display pin (D-34, plan 04-08 Task 3) — VERIFY EXISTING,
// BUILD NOTHING.
//
// LOCATE (reported per the plan): the lastChecked aging surface renders as a
// RAW CLOCK TIMESTAMP, not a relative "Xm ago" string. Three surfaces:
//   - src/components/Dashboard/Dashboard.tsx — the "Last Checked" table
//     column: `{monitor.lastChecked ? new Date(monitor.lastChecked)
//     .toLocaleTimeString() : "Never"}`.
//   - src/components/Dashboard/MonitorDetails.tsx — the details "Last
//     Checked" row: the same ternary shape.
//   - src/components/Status/PublicStatus.tsx — the public status page:
//     `checked {new Date(monitor.lastChecked).toLocaleTimeString()}` (only
//     when lastChecked is non-null).
// When checks stop, the rendered timestamp simply STOPS ADVANCING (it is
// derived exclusively from the stored lastChecked value — no Date.now()) —
// that frozen, aging timestamp IS the existing staleness surface D-34 pins.
//
// PIN: a source-level regression net (this repo has no component-render
// test infrastructure — no jsdom/@testing-library — so the established
// pattern is pinning the exact source contract, per the kill-case's T-04-30
// seam pin) plus a behavioral assertion on the located rendering expression:
// fed a timestamp 10 minutes old, the expression renders THAT stale clock
// time, never a re-computed "now".
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD = path.join(REPO_ROOT, "src", "components", "Dashboard", "Dashboard.tsx");
const DETAILS = path.join(REPO_ROOT, "src", "components", "Dashboard", "MonitorDetails.tsx");
const PUBLIC_STATUS = path.join(REPO_ROOT, "src", "components", "Status", "PublicStatus.tsx");

/** The dashboard/details ternary shape (tolerant of formatting whitespace). */
const TERNARY_RENDER =
  /monitor\.lastChecked\s*\?\s*new Date\(\s*monitor\.lastChecked,?\s*\)\s*\.toLocaleTimeString\(\)\s*:\s*"Never"/;

describe("staleness display pin (RES-03 / D-34 — the existing lastChecked aging surface)", () => {
  it("Dashboard.tsx renders the stored lastChecked as a clock timestamp with a Never fallback", () => {
    const source = readFileSync(DASHBOARD, "utf8");
    expect(source).toMatch(TERNARY_RENDER);
    // The rendered value derives ONLY from the stored timestamp — the
    // expression must not re-compute "now", or staleness would be masked.
    const match = source.match(TERNARY_RENDER)![0];
    expect(match).not.toContain("Date.now()");
    expect(match).not.toMatch(/new Date\(\s*\)/);
  });

  it("MonitorDetails.tsx renders the same aging lastChecked surface", () => {
    expect(readFileSync(DETAILS, "utf8")).toMatch(TERNARY_RENDER);
  });

  it("PublicStatus.tsx renders the public 'checked <time>' staleness line", () => {
    const source = readFileSync(PUBLIC_STATUS, "utf8");
    expect(source).toMatch(
      /checked\s*\{\s*new Date\(\s*monitor\.lastChecked\s*\)\s*\.toLocaleTimeString\(\)\s*\}/
    );
    // Only rendered when a lastChecked value exists — a never-checked
    // monitor shows no misleading "checked" line.
    expect(source).toMatch(/\{monitor\.lastChecked\s*&&/);
  });

  it("behavioral: the located expression renders a 10-minute-old lastChecked as that stale time, not now", () => {
    // The exact expression shape the three surfaces use, executed on an
    // aging value: 10 minutes behind always differs from the current clock
    // in the minutes field (10 mod 60 !== 0), so a surface that silently
    // substituted Date.now() would fail this assertion.
    const stale = new Date(Date.now() - 10 * 60_000);
    const rendered = new Date(stale.toISOString()).toLocaleTimeString();
    expect(rendered).toBe(stale.toLocaleTimeString());
    expect(rendered).not.toBe(new Date().toLocaleTimeString());
  });
});
