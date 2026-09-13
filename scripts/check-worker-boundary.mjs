#!/usr/bin/env node
// check-worker-boundary.mjs — the worker/Next boundary gate behind
// `pnpm worker:boundary` (D-08), inserted into `pnpm verify` between
// schema:gate and build. Plain Node ESM, zero new deps (the cheapest tool
// that fails verify on violation — discretion item), same conventions as
// scripts/schema-gate.mjs: run from the repo root, fail loud on every
// error path, exit non-zero listing violations.
//
// The rule (D-08): any file under src/worker/** must not import
//   - next-namespace packages ("next", "next/*"),
//   - react ("react", "react-dom", "react/*", "react-dom/*"),
//   - web route-handler modules ("@/app/*").
// A violation fails verify — the boundary is an invariant, not a habit
// (it catches the accidental NextResponse import that breaks the bundle).
//
// Usage: node scripts/check-worker-boundary.mjs [dir ...]
//   Default dir: src/worker. Extra dir arguments let tests prove the gate
//   on a violating fixture without ever touching src/worker.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_ROOTS = [path.join("src", "worker")];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// The D-08 forbidden module families. Shared code under src/lib and src/db
// stays importable — only the web-coupled families are boundary violations.
function forbiddenReason(specifier) {
  if (specifier === "next" || specifier.startsWith("next/")) {
    return "next-namespace package";
  }
  if (
    specifier === "react" ||
    specifier === "react-dom" ||
    specifier.startsWith("react/") ||
    specifier.startsWith("react-dom/")
  ) {
    return "react family package";
  }
  if (specifier.startsWith("@/app/")) {
    return "web route-module path";
  }
  return null;
}

// Extract every module specifier a single source line can carry: static
// import/export ... from "x", bare side-effect imports ("dotenv/config"),
// dynamic import("x"), and require("x"). The bundle is CommonJS, so all
// four forms must be caught before esbuild lowers them.
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

// Commented-out imports ("// import x from \"next/link\"") must not
// false-positive — a real import line never starts with a comment marker.
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function collectSourceFiles(root, files) {
  if (!existsSync(root)) {
    throw new Error(`check-worker-boundary failed: directory not found: ${root}`);
  }
  const stats = statSync(root);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(root)) {
      collectSourceFiles(path.join(root, entry), files);
    }
  } else if (SCAN_EXTENSIONS.has(path.extname(root))) {
    files.push(root);
  }
}

function scanRoot(root) {
  const files = [];
  collectSourceFiles(root, files);
  const violations = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      for (const specifier of extractSpecifiers(line)) {
        const reason = forbiddenReason(specifier);
        if (reason) {
          violations.push({ file, line: index + 1, specifier, reason });
        }
      }
    });
  }
  return { files, violations };
}

function main() {
  const roots = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_ROOTS;
  let totalFiles = 0;
  const allViolations = [];
  for (const root of roots) {
    const { files, violations } = scanRoot(root);
    totalFiles += files.length;
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(
      `[worker-boundary] VIOLATIONS: ${allViolations.length} forbidden import(s) — ` +
        `src/worker/** must not import next/*, react, or @/app/* modules (D-08):`
    );
    for (const violation of allViolations) {
      console.error(
        `  ${violation.file}:${violation.line}: ${violation.reason} "${violation.specifier}"`
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `[worker-boundary] green — ${totalFiles} file(s) scanned across ` +
      `${roots.join(", ")}, no next/react/@app imports (D-08)`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
