import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Cron-remnant gate suite (D-41, WRK-11): proves scripts/check-cron-remnants.mjs
// — the verify-chain leg that keeps instrumentation/cron remnants out of the
// build from the deletion release (05-09) onward. Extended at the 06-05
// deletion release (D-27): the gate also fails on files recreating the
// deleted /api/cron route paths, the retired CRON_SECRET token, and imports
// of the four deleted legacy modules (cron-logic, db-batcher, cleanup-logic,
// mail). Fixture-driven via explicit dir args (check-worker-boundary
// pattern); docs/ and .planning/ prose naming the tokens is NEVER flagged
// (D-41 prohibition).
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
  // D-27 check 5: a file recreating a deleted cron route path.
  write(
    dir,
    path.join("src", "app", "api", "cron", "check", "route.ts"),
    ['export async function GET() { return new Response("ok"); }', ""].join("\n")
  );
  // D-27 check 6: the retired CRON_SECRET token.
  write(
    dir,
    path.join("src", "lib", "env-legacy.ts"),
    ['export const cronSecret = process.env.CRON_SECRET;', ""].join("\n")
  );
  // D-27 check 7: an import of a deleted legacy module.
  write(
    dir,
    path.join("src", "lib", "legacy-queue.ts"),
    ['import { flushBatches } from "@/lib/db-batcher";', "export { flushBatches };", ""].join("\n")
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
      // D-27 (06-05): deleted route path, retired secret token, deleted-module import.
      expect(out).toContain("recreates a deleted cron route path");
      expect(out).toContain("CRON_SECRET");
      expect(out).toContain("deleted legacy module");
      expect(out).toContain("db-batcher");
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

  it("5. the real repo SOURCE carries no Phase-5/6 remnant class (post 05-09/06-05; the Phase-7 extension ends its pre-arm advisory at the 07-08 arming step)", async () => {
    // 05-09/06-05 invariant: the enforced classes (instrumentation entrypoint,
    // node-cron, CRON_MODE/CRON_SECRET, deleted cron route paths, the four
    // deleted legacy modules) find nothing legitimate in the real source tree.
    // The scan targets src/ EXPLICITLY: since the 07-08 arming the DEFAULT
    // roots include .next/server, and inside the verify chain `pnpm test`
    // runs BEFORE `pnpm build` — the stale pre-build artifacts would false-fail
    // the now-enforced gate here. The full-repo default scan (package.json +
    // .next included) is the verify chain's own cron:remnants leg, which runs
    // after the build.
    const result = await runRemnants(["src"]);
    expect(result.code).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).not.toContain("instrumentation.ts");
    expect(out).not.toContain("node-cron");
    expect(out).not.toContain("CRON_MODE");
    expect(out).not.toContain("CRON_SECRET");
    expect(out).not.toContain("recreates a deleted cron route path");
    expect(out).not.toContain("deleted legacy module");
    expect(out).not.toContain("banned Phase-7 package");
    // The Phase-7 dependency ban on the real package.json (07-08, DRZ-07) —
    // asserted directly so the pin never depends on build-artifact freshness.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const banned of [
      "node-cron",
      "@types/node-cron",
      "next-auth",
      "@auth/prisma-adapter",
      "@prisma/client",
      "@prisma/adapter-pg",
      "prisma",
      "js-cookie",
      "@types/js-cookie",
    ]) {
      expect(declared, `banned dependency resurfaced: ${banned}`).not.toHaveProperty(banned);
    }
  });

  it("5d. Phase-7 classes are DETECTED on a fixture in --advisory posture (banned specifiers, deleted basenames, retired tokens — stable across the advisory→armed lifecycle)", async () => {
    // The 07-08 extension's RED-teeth proof as a permanent fixture pin (the
    // in-flight RED spot-check is recorded in 07-08-SUMMARY.md). --advisory
    // keeps exit 0 in BOTH postures, so this pin survives the arming step.
    const dir = makeDir();
    try {
      write(
        dir,
        path.join("src", "lib", "legacy-auth.ts"),
        [
          'import NextAuth from "next-auth";',
          'import { prisma } from "@/lib/prisma";',
          'import { PrismaAdapter } from "@auth/prisma-adapter";',
          "export const legacy = NextAuth({});",
          "void prisma;",
          "void PrismaAdapter;",
          "",
        ].join("\n")
      );
      write(
        dir,
        path.join("src", "lib", "blast-echo.ts"),
        ['import { runBlast } from "./send-relogin-blast";', "export { runBlast };", ""].join("\n")
      );
      write(
        dir,
        path.join("src", "lib", "env-legacy.ts"),
        ['export const secret = process.env.NEXTAUTH_SECRET;', ""].join("\n")
      );
      const result = await runRemnants(["--advisory", dir]);
      expect(result.code).toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      expect(out).toContain("next-auth");
      expect(out).toContain("@auth/prisma-adapter");
      expect(out).toContain("@/lib/prisma");
      expect(out).toContain("send-relogin-blast");
      expect(out).toContain("NEXTAUTH_SECRET");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5b. token asymmetry: CRON_SECRET inside a COMMENT still trips, a deleted-module mention in a comment does NOT", async () => {
    // IN-06/D-19 asymmetry pinned: token counts are comments-INCLUSIVE (a
    // comment naming the retired secret is still a remnant signal), while
    // import checks skip comment lines (historical provenance prose in
    // comments is legitimate — e.g. the email module's relocation notes).
    const dir = makeDir();
    try {
      write(
        dir,
        path.join("src", "lib", "noted.ts"),
        [
          "// Back in the day CRON_SECRET guarded the cron routes.",
          'export const fine = true;',
          "",
        ].join("\n")
      );
      write(
        dir,
        path.join("src", "lib", "provenance.ts"),
        [
          "// Render functions relocated BYTE-VERBATIM from src/lib/mail.ts.",
          'export const render = () => "html";',
          "",
        ].join("\n")
      );
      const result = await runRemnants([dir]);
      expect(result.code).not.toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      expect(out).toContain("CRON_SECRET");
      // The comment-only mail mention must NOT be flagged.
      expect(out).not.toContain("provenance.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5c. require-form import of a deleted module basename trips the gate", async () => {
    const dir = makeDir();
    try {
      write(
        dir,
        path.join("src", "lib", "sneaky.ts"),
        ['const { sendVerificationEmail } = require("./mail");', "export { sendVerificationEmail };", ""].join("\n")
      );
      const result = await runRemnants([dir]);
      expect(result.code).not.toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      expect(out).toContain("deleted legacy module");
      expect(out).toContain("./mail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5e. the better-auth client's bundled NEXTAUTH_URL read-form is exempt in .next artifacts only — any other occurrence still trips", async () => {
    // 07-08 armed-gate discovery: the kept better-auth client's baseURL
    // inference helper reads process.env.NEXTAUTH_URL as a legacy fallback and
    // is bundled into every .next SSR chunk — a third-party literal no repo
    // deletion can remove. The exemption subtracts ONLY the exact
    // `process.env.<TOKEN>` read-form occurrences inside .next/** files;
    // string literals, comments, and all occurrences in src/ or dist/ trip.
    const dir = makeDir();
    try {
      write(
        dir,
        path.join(".next", "server", "chunks", "ssr", "lib_bundle.js"),
        [
          'const a = process.env.NEXT_PUBLIC_AUTH_URL ?? (process.env.NEXTAUTH_URL ?? process.env.VERCEL_URL);',
          'const b = process.env.NEXTAUTH_URL;',
          "",
        ].join("\n")
      );
      write(
        dir,
        path.join(".next", "server", "chunks", "ssr", "auth_remnant.js"),
        ['export const legacy = "NEXTAUTH_URL";', ""].join("\n")
      );
      write(
        dir,
        path.join("src", "lib", "source-mention.ts"),
        ['// mentions NEXTAUTH_URL in a comment — source never exempts', 'export const x = 1;', ""].join("\n")
      );
      const result = await runRemnants([dir]);
      expect(result.code).not.toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      // The read-form occurrences in the bundle file are exempt...
      expect(out).not.toContain("lib_bundle.js");
      // ...the string literal in the same .next tree trips...
      expect(out).toContain("auth_remnant.js");
      // ...and the SOURCE comment never qualifies for the exemption.
      expect(out).toContain("source-mention.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // 07-11 (WR-04 gap closure, G-07-63): the armed gate's default perimeter
  // gains scripts/ — the D-05 delete-after-use blast script lived at
  // scripts/send-relogin-blast.mjs, so re-creating it (or any scripts/*.mjs
  // remnant) previously produced ZERO findings. Pins 5f/5g prove the new
  // FILE-NAME trip teeth, 5h pins the exemption scope (exact file names,
  // never content shapes), 5i is the real-repo scripts-root green pin whose
  // RED run proved the unextended gate tripped on the in-tree historical
  // tools (rehearse-cutover.mjs CRON_MODE/CRON_SECRET throwaway lever, the
  // gate body's own token definitions, auth-soak-gate.mjs AUTH_NOTICE_*).
  // -----------------------------------------------------------------------

  it("5f. WR-04: a send-relogin-blast-named file holding ONLY clean code (zero imports) trips by FILE NAME", async () => {
    // The D-05 remnant class: a file whose NAME matches a deleted module is
    // a remnant even with zero import specifiers — the original blast script
    // was invoked by name, not imported. Content stays clean so the finding
    // can ONLY come from the file-name check.
    const dir = makeDir();
    try {
      write(
        dir,
        path.join("scripts", "send-relogin-blast.mjs"),
        [
          "// re-created blast script fixture — clean code, the NAME is the signal",
          "export const recipients = [];",
          "export function blast(users) {",
          "  return users.map((u) => u.email);",
          "}",
          "",
        ].join("\n")
      );
      const result = await runRemnants([dir]);
      expect(result.code).not.toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      expect(out).toContain("send-relogin-blast.mjs");
      expect(out).toContain("file NAME matches a deleted Phase-7 module");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5g. WR-04: a Phase-5-set-named file (db-batcher) with clean content also trips by FILE NAME", async () => {
    // The file-name check covers BOTH basename sets: Phase-5-set hits land as
    // plain always-enforced findings (same severity discipline as the
    // specifier checks).
    const dir = makeDir();
    try {
      write(
        dir,
        path.join("scripts", "db-batcher.ts"),
        ["export const batchSize = 100;", "export function batch(items) { return items; }", ""].join("\n")
      );
      const result = await runRemnants([dir]);
      expect(result.code).not.toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      expect(out).toContain("db-batcher.ts");
      expect(out).toContain("file NAME matches a deleted legacy module");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5h. 07-11 exemption scope: a RENAMED copy of exempt-file content still trips — exemptions bind to EXACT file names, never content shapes", async () => {
    // The three 07-11 retired-token exemptions (check-cron-remnants.mjs /
    // rehearse-cutover.mjs / auth-soak-gate.mjs) are keyed by exact file
    // name. The soak gate's window-read line, copied under a different name,
    // must still trip — renaming can never smuggle exempt content past the
    // gate (the 5e read-form precedent, applied to the name dimension).
    // This pin is a scope GUARD, not a RED proof: it passes before and after
    // the 07-11 implementation.
    const dir = makeDir();
    try {
      write(
        dir,
        path.join("scripts", "soak-window-copy.mjs"),
        [
          "// renamed copy of auth-soak-gate.mjs's window-read line",
          "export const bounds = [process.env.AUTH_NOTICE_START, process.env.AUTH_NOTICE_END];",
          "",
        ].join("\n")
      );
      const result = await runRemnants([dir]);
      expect(result.code).not.toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      expect(out).toContain("soak-window-copy.mjs");
      expect(out).toContain("AUTH_NOTICE_START");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5i. WR-04: the REAL repo scripts/ root scans green — the three in-tree historical tools are exactly exempted (RED pre-07-11: the unextended gate tripped on the rehearsal tool + the gate body)", async () => {
    // The real-repo pin: scripts/ as an explicit target must be GREEN once
    // the 07-11 exemptions land. Pre-implementation this tripped non-zero
    // (rehearse-cutover.mjs THROWAWAY_CRON_SECRET + CRON_MODE sweep pin, the
    // gate's own token definitions, auth-soak-gate.mjs AUTH_NOTICE_* reads)
    // — the captured RED proving the exemption set is load-bearing, not
    // decorative. Like pin 5, this runs from the repo cwd.
    const result = await runRemnants([path.join("scripts")]);
    expect(result.code).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain("green");
    // The green line must report the scripts root so the pin cannot pass by
    // scanning nothing.
    expect(out).toContain("scripts");
  });

  it("6. --help prints usage and exits 0", async () => {
    const { stdout } = await execFileAsync("node", [REMNANT_SCRIPT, "--help"]);
    expect(stdout).toContain("Usage");
    expect(stdout).toContain("--advisory");
  });
});
