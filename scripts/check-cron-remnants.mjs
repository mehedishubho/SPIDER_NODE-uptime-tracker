#!/usr/bin/env node
// check-cron-remnants.mjs — the D-41 cron-remnant gate. From the deletion
// release (05-09) onward this script is a `pnpm verify` leg that fails the
// chain while ANY legacy scheduler remnant survives; until then it ships
// INERT (advisory) because src/instrumentation.ts legitimately exists
// through the overlap window. This plan does NOT wire it into package.json.
//
// D-41 amendment: ROADMAP criterion 2's "CI greps the build" is realized as
// a verify-chain grep per the 02-CONTEXT D-01 no-CI precedent — no CI
// system exists on this repo, so pnpm verify IS the build gate.
//
// What it flags (the remnant classes the deletion release must remove):
//   1. any file named instrumentation.ts / instrumentation.js — the legacy
//      scheduler entrypoint (D-03's deletion target);
//   2. any import/require specifier ending in node-cron or .../instrumentation;
//   3. the CRON_MODE token in any scanned source or build artifact;
//   4. a package.json still declaring node-cron or @types/node-cron.
//
// Scan scope: src/ recursively, dist/worker.js and .next/server when
// present (defaults) — or explicit dir/file arguments (fixture-testable,
// check-worker-boundary pattern). NEVER scanned, even when nested inside a
// scanned root: docs/, .planning/, node_modules/, .git/, .snapshots/ (and
// the .env.example file) — historical prose legitimately names the tokens.
//
// Usage: node scripts/check-cron-remnants.mjs [dir|file ...] [--advisory]
//   Enforcement (default): any finding exits 1 listing file + reason.
//   --advisory: list findings, exit 0 — the pre-deletion posture (and the
//               05-09 activation step flips the verify leg to enforcement).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SCRIPT_NAME = "check-cron-remnants.mjs";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
// Directory names excluded from every walk — prose homes that legitimately
// name the tokens (D-41). The exclusion is the NAME, not the path: a docs/
// dir nested anywhere inside a scanned root is skipped.
const EXCLUDED_DIR_NAMES = new Set(["docs", ".planning", "node_modules", ".git", ".snapshots"]);
const EXCLUDED_FILE_NAMES = new Set([".env.example"]);
const INSTRUMENTATION_FILE_NAMES = new Set(["instrumentation.ts", "instrumentation.js"]);

const DEFAULT_ROOTS = () => {
  const roots = [path.join("src")];
  if (existsSync(path.join("dist", "worker.js"))) roots.push(path.join("dist", "worker.js"));
  if (existsSync(path.join(".next", "server"))) roots.push(path.join(".next", "server"));
  return roots;
};
const DEFAULT_PACKAGE_JSON = path.join("package.json");

function usage() {
  return [
    `Usage: node scripts/${SCRIPT_NAME} [dir|file ...] [--advisory]`,
    "",
    "D-41 cron-remnant gate. Flags instrumentation.ts/js files, node-cron /",
    ".../instrumentation imports, CRON_MODE tokens, and node-cron dependency",
    "declarations. Default targets: src/, dist/worker.js, .next/server (each",
    "when present) plus ./package.json. docs/, .planning/, node_modules/,",
    ".git/, .snapshots/ and .env.example are NEVER scanned.",
    "",
    "  --advisory  list findings but exit 0 (pre-deletion posture; the",
    "              deletion release 05-09 arms enforcement in pnpm verify)",
    "  --help      this usage text",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Specifier extraction — the check-worker-boundary.mjs forms (static import,
// bare side-effect import, dynamic import, require) so esbuild-lowered code
// cannot smuggle a specifier past the gate.
// ---------------------------------------------------------------------------

function extractSpecifiers(line) {
  const specifiers = [];
  for (const match of line.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specifiers.push(match[1]);
  for (const match of line.matchAll(/\bimport\s+["']([^"']+)["']/g)) specifiers.push(match[1]);
  for (const match of line.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]);
  }
  for (const match of line.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function legacySchedulerImport(specifier) {
  if (specifier === "node-cron" || specifier.endsWith("/node-cron")) return true;
  // "./instrumentation", "../instrumentation", "@/instrumentation", ...
  if (specifier.endsWith("/instrumentation")) return true;
  return false;
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

// ---------------------------------------------------------------------------
// Walk — collecting code files (checks 2+3) and instrumentation-named files
// (check 1) under each root, honoring the exclusion names.
// ---------------------------------------------------------------------------

function collectFiles(root, codeFiles, entrypointFiles) {
  if (!existsSync(root)) {
    throw new Error(`${SCRIPT_NAME} failed: target not found: ${root}`);
  }
  const stats = statSync(root);
  const base = path.basename(root);
  if (stats.isDirectory()) {
    if (EXCLUDED_DIR_NAMES.has(base)) return; // never descend into prose homes
    for (const entry of readdirSync(root)) {
      if (EXCLUDED_DIR_NAMES.has(entry) || EXCLUDED_FILE_NAMES.has(entry)) continue;
      collectFiles(path.join(root, entry), codeFiles, entrypointFiles);
    }
    return;
  }
  if (EXCLUDED_FILE_NAMES.has(base)) return;
  // Check 1 is by FILE NAME and applies to every walked file.
  if (INSTRUMENTATION_FILE_NAMES.has(base)) entrypointFiles.push(root);
  // Checks 2+3 are content checks on code files.
  if (CODE_EXTENSIONS.has(path.extname(root))) codeFiles.push(root);
}

function scanCodeFile(file) {
  const reasons = [];
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    for (const specifier of extractSpecifiers(line)) {
      if (legacySchedulerImport(specifier)) {
        reasons.push(`imports the legacy scheduler ("${specifier}") at line ${index + 1}`);
      }
    }
  });
  const tokenHits = content.split("CRON_MODE").length - 1;
  if (tokenHits > 0) {
    reasons.push(`references the CRON_MODE env token (${tokenHitText(tokenHits)})`);
  }
  return reasons;
}

function tokenHitText(hits) {
  return `${hits} occurrence${hits === 1 ? "" : "s"}`;
}

function checkPackageJson(packageJsonPath) {
  if (!packageJsonPath || !existsSync(packageJsonPath)) return [];
  const reasons = [];
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    for (const section of ["dependencies", "devDependencies"]) {
      const deps = pkg?.[section] ?? {};
      for (const name of ["node-cron", "@types/node-cron"]) {
        if (name in deps) reasons.push(`${section} still declares ${name}`);
      }
    }
  } catch (error) {
    throw new Error(
      `${SCRIPT_NAME} failed: ${packageJsonPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const advisory = argv.includes("--advisory");
  if (argv.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const targets = argv.filter((a) => !a.startsWith("--"));
  const roots = targets.length > 0 ? targets : DEFAULT_ROOTS();
  // Default runs audit the repo's own package.json; fixture runs audit the
  // fixture's package.json when the fixture carries one (absent = nothing to
  // check — the fixture proves checks 1-3 in isolation).
  const packageJsonPath =
    targets.length > 0
      ? existsSync(path.join(targets[0], "package.json"))
        ? path.join(targets[0], "package.json")
        : null
      : DEFAULT_PACKAGE_JSON;

  const codeFiles = [];
  const entrypointFiles = [];
  for (const root of roots) {
    collectFiles(root, codeFiles, entrypointFiles);
  }

  const findings = [];
  for (const file of entrypointFiles) {
    findings.push({ file, reason: "legacy scheduler entrypoint file (instrumentation.ts/js) still present" });
  }
  for (const file of codeFiles) {
    for (const reason of scanCodeFile(file)) {
      findings.push({ file, reason });
    }
  }
  const packageJsonRelative = packageJsonPath ? path.relative(".", packageJsonPath) || "." : null;
  for (const reason of checkPackageJson(packageJsonPath)) {
    findings.push({ file: packageJsonRelative, reason });
  }

  const scannedCount = codeFiles.length + entrypointFiles.length;
  if (findings.length > 0) {
    const banner =
      `[cron-remnants] ${advisory ? "ADVISORY" : "VIOLATIONS"}: ${findings.length} finding(s) ` +
      `— D-41 cron-remnant gate (${advisory ? "advisory mode: pre-deletion remnants listed, exit 0" : "the legacy scheduler must be fully deleted"}):`;
    const lines = [banner];
    for (const finding of findings) {
      lines.push(`  ${finding.file}: ${finding.reason}`);
    }
    if (advisory) {
      console.log(lines.join("\n"));
      return 0;
    }
    console.error(lines.join("\n"));
    return 1;
  }

  console.log(
    `[cron-remnants] green — ${scannedCount} code file(s) scanned across ${roots.join(", ")}` +
      (packageJsonRelative ? ` (+ ${packageJsonRelative})` : "") +
      ", no cron remnants (D-41)"
  );
  return 0;
}

try {
  const exitCode = main(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
