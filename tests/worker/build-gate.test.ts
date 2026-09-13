import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Worker build-gate suite (WRK-14, D-06/D-08): proves the two build-side
// invariants `pnpm verify` leans on —
//   1. one `pnpm build` emits BOTH worker artifacts (dist/worker.js AND
//      dist/worker.js.map — the sourcemap is the D-04 SIGKILL-trace
//      contract). Skipped with a clear message when dist is absent
//      mid-wave (verify runs tests BEFORE build); a full verify run on a
//      built checkout asserts it.
//   2. scripts/check-worker-boundary.mjs exits NON-ZERO on a violating
//      fixture importing a forbidden module family (next/*, react, @/app/*)
//      and ZERO against src/worker — the D-08 invariant, not a habit.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const BOUNDARY_SCRIPT = path.join("scripts", "check-worker-boundary.mjs");
const DIST_BUNDLE = path.join("dist", "worker.js");
const DIST_MAP = path.join("dist", "worker.js.map");

describe("worker build gate — bundle artifacts + D-08 boundary (WRK-14)", () => {
  // Skipped (clearly, by name) when dist is absent mid-wave — verify runs
  // this file BEFORE its build step; a full verify on a built checkout
  // asserts the artifacts for real.
  const bundleIt = existsSync(DIST_BUNDLE)
    ? it
    : it.skip;

  bundleIt("1. dist/worker.js and dist/worker.js.map both exist (D-04/D-06 one-build-two-artifacts)", () => {
    expect(existsSync(DIST_BUNDLE)).toBe(true);
    expect(existsSync(DIST_MAP)).toBe(true);
  });

  it("2. boundary script exits NON-ZERO on a fixture importing a forbidden module family", async () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "worker-boundary-violation-"));
    try {
      writeFileSync(
        path.join(fixtureDir, "violating.ts"),
        [
          'import { NextResponse } from "next/server";',
          'import React from "react";',
          'import { handler } from "@/app/api/monitors/route";',
          "export const value = { NextResponse, React, handler };",
          "",
        ].join("\n")
      );
      // Non-zero exit rejects the promisified execFile — assert its code and
      // that the violation list (printed on stderr) names the offender.
      const failure = await execFileAsync("node", [BOUNDARY_SCRIPT, fixtureDir]).then(
        () => null,
        (error: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) => error
      );
      expect(failure).not.toBeNull();
      expect(Number(failure!.code)).not.toBe(0);
      expect(failure!.stderr ?? "").toContain("next/server");
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("3. boundary script exits ZERO against the repo's src/worker", async () => {
    const { stdout } = await execFileAsync("node", [BOUNDARY_SCRIPT, path.join("src", "worker")]);
    expect(stdout).toContain("green");
  });
});
