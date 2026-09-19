import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Cron-remnant gate suite (D-41, WRK-11): proves scripts/check-cron-remnants.mjs
// — the verify-chain leg that keeps instrumentation/cron remnants out of the
// build from the deletion release (05-09) onward. Inert until then: this plan
// does NOT wire it into pnpm verify (it would fail while instrumentation.ts
// legitimately exists). Fixture-driven via explicit dir args
// (check-worker-boundary pattern); docs/ and .planning/ prose naming the
// tokens is NEVER flagged (D-41 prohibition).
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const REMNANT_SCRIPT = path.join("scripts", "check-cron-remnants.mjs");

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "cron-remnant-"));
}

function write(dir: string, rel: string, content: string): string {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

/** A src-like tree with every remnant class the gate must catch. */
function writeViolatingFixture(): string {
  const dir = makeDir();
  write(
    dir,
    path.join("src", "instrumentation.ts"),
    [
      'import cron from "node-cron";',
      "",
      "export async function register() {",
      '  const cronMode = process.env.CRON_MODE || "internal";',
      "  cron.schedule('* * * * *', async () => { /* ... */ });",
      "}",
      "",
    ].join("\n")
  );
  write(
    dir,
    path.join("src", "lib", "scheduler-legacy.ts"),
    ['import cron from "node-cron";', 'export const scheduled = cron;', ""].join("\n")
  );
  write(
    dir,
    path.join("src", "lib", "env.ts"),
    ['export const cronMode = process.env.CRON_MODE;', ""].join("\n")
  );
  write(
    dir,
    path.join("src", "app", "page.tsx"),
    ['export default function Page() { return null; }', ""].join("\n")
  );
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "fixture", dependencies: { "node-cron": "^4.6.0" } }, null, 2)
  );
  return dir;
}

function writeCleanFixture(): string {
  const dir = makeDir();
  write(
    dir,
    path.join("src", "worker", "index.ts"),
    ['import { startHealthServer } from "./health";', "startHealthServer();", ""].join("\n")
  );
  write(
    dir,
    path.join("src", "app", "page.tsx"),
    ['export default function Page() { return null; }', ""].join("\n")
  );
  write(dir, "package.json", JSON.stringify({ name: "fixture", dependencies: {} }, null, 2));
  return dir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runRemnants(args: string[] = []): Promise<RunResult> {
  const result = await execFileAsync("node", [REMNANT_SCRIPT, ...args]).then(
    (ok: { stdout?: string; stderr?: string }) => ({ code: 0, stdout: ok.stdout ?? "", stderr: ok.stderr ?? "" }),
    (error: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => ({
      code: Number(error.code) || 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    })
  );
  return result;
}

describe("cron-remnant gate — scripts/check-cron-remnants.mjs (D-41)", () => {
  it("1. violating fixture: enforcement exits non-zero listing every remnant class", async () => {
    const dir = writeViolatingFixture();
    try {
      const result = await runRemnants([dir]);
      expect(result.code).not.toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      // Check 1: the instrumentation entrypoint file itself.
      expect(out).toContain("instrumentation.ts");
      // Check 2: node-cron imports.
      expect(out).toContain("node-cron");
      // Check 3: the CRON_MODE env token.
      expect(out).toContain("CRON_MODE");
      // Check 4: the dependency declaration.
      expect(out).toContain("package.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. clean fixture: enforcement exits 0", async () => {
    const dir = writeCleanFixture();
    try {
      const result = await runRemnants([dir]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("green");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. docs-like directories carrying the tokens in prose are NOT scanned/flagged", async () => {
    const dir = makeDir();
    try {
      // Prose naming every token — plus an archived .ts copy of the legacy
      // entrypoint INSIDE docs/: the directory name is the exclusion, not
      // just the file extension (D-41 prohibition).
      write(
        dir,
        path.join("docs", "cutover-notes.md"),
        [
          "# Cutover notes",
          "",
          "We deleted instrumentation.ts and removed node-cron.",
          "CRON_MODE is gone; the worker scheduler owns checking now.",
          "",
        ].join("\n")
      );
      write(
        dir,
        path.join("docs", "archive", "instrumentation.ts"),
        ['import cron from "node-cron";', 'export const mode = process.env.CRON_MODE;', ""].join("\n")
      );
      write(
        dir,
        path.join("src", "worker", "index.ts"),
        ['export const healthy = true;', ""].join("\n")
      );
      const result = await runRemnants([dir]);
      expect(result.code).toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      expect(out).not.toContain("CRON_MODE");
      expect(out).not.toContain("node-cron");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4. --advisory on the violating fixture exits 0 while still listing findings", async () => {
    const dir = writeViolatingFixture();
    try {
      const result = await runRemnants(["--advisory", dir]);
      expect(result.code).toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      expect(out).toContain("advisory");
      expect(out).toContain("instrumentation.ts");
      expect(out).toContain("CRON_MODE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5. --advisory against today's real repo is green now that 05-09 removed instrumentation.ts", async () => {
    // Post-deletion-release invariant (05-09): src/instrumentation.ts no
    // longer exists, so advisory mode finds no legitimate remnants — the
    // gate is armed and the real repo must scan green.
    const result = await runRemnants(["--advisory"]);
    expect(result.code).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain("green");
    expect(out).not.toContain("instrumentation.ts");
  });

  it("6. --help prints usage and exits 0", async () => {
    const { stdout } = await execFileAsync("node", [REMNANT_SCRIPT, "--help"]);
    expect(stdout).toContain("Usage");
    expect(stdout).toContain("--advisory");
  });
});
