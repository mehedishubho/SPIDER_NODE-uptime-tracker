#!/usr/bin/env node
// check-cron-remnants.mjs — the D-41 remnant gate. From the Phase-5 deletion
// release (05-09) onward this script is a `pnpm verify` leg that fails the
// chain while ANY legacy scheduler remnant survives.
//
// D-41 amendment: ROADMAP criterion 2's "CI greps the build" is realized as
// a verify-chain grep per the 02-CONTEXT D-01 no-CI precedent — no CI
// system exists on this repo, so pnpm verify IS the build gate.
//
// What it flags (the remnant classes the deletion releases must remove):
//   1. any file named instrumentation.ts / instrumentation.js — the legacy
//      scheduler entrypoint (D-03's deletion target);
//   2. any import/require specifier ending in node-cron or .../instrumentation;
//   3. the CRON_MODE token in any scanned source or build artifact;
//   4. a package.json still declaring node-cron or @types/node-cron;
//   5. (D-27, 06-05 deletion release) any file recreating a deleted cron
//      route path (…/app/api/cron/…) — source OR build artifact;
//   6. (D-27) the retired CRON_SECRET env token in any scanned source,
//      build artifact, or repo-root config file;
//   7. (D-27) any import/require specifier resolving to one of the four
//      deleted legacy modules: cron-logic, db-batcher, cleanup-logic, mail;
//   8. (Phase-7 deletion release, 07-08 — AUTH-07/AUTH-08/DRZ-07/D-05) any
//      import/require specifier of the legacy auth framework (next-auth and
//      its @auth/prisma-adapter), the Prisma packages (@prisma/* scopes and
//      the CLI/internal-module basename "prisma"), or the js-cookie helper;
//   9. (Phase-7) any file named like a deleted Phase-7 module — the custom
//      token helper (tokens), the legacy auth config module (auth-legacy),
//      the Redux auth slice (authSlice), or the delete-after-use re-login
//      blast script (send-relogin-blast) — by BASENAME so "@/lib/tokens",
//      "../../auth-legacy" and script imports all trip;
//  10. (Phase-7) the retired NEXTAUTH_SECRET / NEXTAUTH_URL env tokens and
//      the delete-after-use notice-window env names (AUTH_NOTICE_START /
//      AUTH_NOTICE_END, D-05) in any scanned source, build artifact, or
//      repo-root config file;
//  11. (Phase-7) a package.json still declaring next-auth, @auth/prisma-
//      adapter, @prisma/client, @prisma/adapter-pg, prisma, js-cookie or
//      @types/js-cookie;
//  12. (07-11, WR-04/G-07-63) any walked CODE file whose basename-minus-
//      extension matches a deleted module basename (the four Phase-5 legacy
//      modules or the five Phase-7 basenames) — a remnant by FILE NAME,
//      import specifiers regardless: the D-05 blast script was invoked by
//      name and carried zero importers, so a clean-content recreation of it
//      must still trip. Phase-5-set hits land plain (always enforced);
//      Phase-7-set hits are phase7-marked, mirroring the specifier checks;
//  13. (Phase-8 deletion, 08-02 — UI-02, D-33/D-34) any import/require
//      specifier of react-icons or sweetalert2 (the icon/dialog remnants of
//      the two dependencies deleted at the redesign release), plus the
//      lucide-react insurance leg (exact specifier + banned dependency —
//      a never-present dep guarded so the stale components.json iconLibrary
//      can never silently re-introduce it via a registry add; Pitfall 1).
//      Phase-8-set hits are phase8-marked; PHASE8_ENFORCED is true from the
//      08-02 arming step (the deletions and the gate land in the same task).
//  14. (Phase-8 AI leg, 08-10 — AI-05/rule 15, belt-and-braces beside
//      worker:boundary) any ai / @ai-sdk/* / @/lib/ai import specifier under
//      src/worker/** — AI is web-process only; the check → transition →
//      alert pipeline must stay AI-free. PATH-SCOPED (the web AI surface
//      legitimately imports these). phase8-marked; born ENFORCED beside its
//      08-02 siblings.
//
// The Phase-7 extension (checks 8-11) ships in ADVISORY posture first — the
// 06-05 pre-arm lifecycle: findings are REPORTED (exit 0) while the Phase-7
// deletions land across the release, and PHASE7_ENFORCED flips to true (the
// 07-08 arming step) once the removals are complete. The Phase-5/6 classes
// (checks 1-7) stay ENFORCED throughout — arming the extension never relaxes
// the already-shipped gate.
//
// IN-06/D-19 asymmetry note (kept current with the D-27 + Phase-7
// extensions): the token checks (CRON_MODE, CRON_SECRET, NEXTAUTH_*,
// AUTH_NOTICE_*) count occurrences INCLUDING comment lines, while the import
// checks skip comment lines — a comment naming a retired token is still a
// remnant signal worth failing on; historical prose in the excluded prose
// homes (docs/, .planning/) is never scanned.
//
// Scan scope: src/ recursively, scripts/ (07-11 WR-04 — the executable-
// tooling root where the deleted D-05 blast script lived; leaving it
// unscanned holed the armed gate exactly where one of its named remnants
// resided), dist/worker.js and .next/server when present, plus the repo-root
// config files playwright.config.ts, next.config.ts and ecosystem.config.js
// (each when present — D-27 "src or config"; the playwright file is watched
// so the stale CRON_MODE writer deleted at 06-05 stays out per Pitfall 9) —
// or explicit dir/file arguments (fixture-testable, check-worker-boundary
// pattern). NEVER scanned, even when nested inside a scanned root: docs/,
// .planning/, node_modules/, .git/, .snapshots/ (and the .env.example file)
// — historical prose legitimately names the tokens.
//
// 07-11 retired-token exemptions (WR-04 companion — exact file names, ONE
// check class only): the token-count checks (CRON_MODE + the retired env
// tokens) skip exactly three in-tree historical tools whose bodies
// legitimately quote or read the retired tokens:
//   check-cron-remnants.mjs — this gate itself: its body quotes every
//     retired token as its own literal definitions (the self-scan paradox);
//   rehearse-cutover.mjs — the Phase-5 rehearsal tool: THROWAWAY_CRON_SECRET
//     and the CRON_MODE sweep pin ARE the retired pre-06-05 interface the
//     rehearsal exists to exercise;
//   auth-soak-gate.mjs — the recorded §14 soak window leg reads the retired
//     AUTH_NOTICE_* notice-window envs (cited by 07-DEPLOY-RECORD).
// The exemption applies ONLY to token counting. Imports, file names, route
// paths, and dependency checks still apply to all three, and a RENAMED copy
// of any exempt file's content trips (suite pin 5h).
//
// Usage: node scripts/check-cron-remnants.mjs [dir|file ...] [--advisory]
//   Enforcement (default): any Phase-5/6 finding, or any Phase-7 finding
//   once PHASE7_ENFORCED is true, exits 1 listing file + reason.
//   --advisory: list ALL findings, exit 0 — the whole-script override used
//               by fixture probes and pre-deletion posture checks.

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

// D-27 (06-05 deletion release): the deleted cron-route path, the four
// deleted legacy modules, and the retired secret token. The module set is
// BASENAME-matched so relative ("./mail"), alias ("@/lib/cron-logic") and
// deep ("../../lib/db-batcher") specifiers all trip the gate. A future
// module legitimately reusing one of these names is a conscious act —
// rename or amend DELETED_MODULE_BASENAMES deliberately.
const DELETED_CRON_ROUTE_PATH = /(^|[\\/])app[\\/]api[\\/]cron([\\/]|$)/;
const DELETED_MODULE_BASENAMES = new Set(["cron-logic", "db-batcher", "cleanup-logic", "mail"]);
// Phase-7 deletion release (07-08): the deleted legacy-auth/Prisma/blast
// module basenames. "prisma" covers the internal singleton ("@/lib/prisma"),
// the generated client ("../generated/prisma") AND the bare CLI package
// specifier; "send-relogin-blast" is the D-05 delete-after-use blast script.
const PHASE7_DELETED_MODULE_BASENAMES = new Set([
  "tokens",
  "auth-legacy",
  "authSlice",
  "send-relogin-blast",
  "prisma",
]);
// Phase-7 banned import specifiers: the legacy auth framework, its Prisma
// adapter, the Prisma client scopes, and the cookie helper. Exact + prefix
// forms so "next-auth/react" and "@prisma/client" subpaths all trip.
const PHASE7_EXACT_SPECIFIERS = new Set(["next-auth", "js-cookie"]);
const PHASE7_SPECIFIER_PREFIXES = ["next-auth/", "@auth/prisma-adapter", "@prisma/", "js-cookie/"];
// Retired env tokens, comments-INCLUSIVE (IN-06/D-19): the D-27 cron secret
// plus the Phase-7 pair — the legacy secret/URL names and the D-05
// delete-after-use notice-window env names.
const RETIRED_ENV_TOKENS = [
  "CRON_SECRET",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "AUTH_NOTICE_START",
  "AUTH_NOTICE_END",
];
const PHASE7_RETIRED_ENV_TOKENS = new Set([
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "AUTH_NOTICE_START",
  "AUTH_NOTICE_END",
]);
const BANNED_DEPENDENCIES = ["node-cron", "@types/node-cron"];
// 07-08: retired tokens whose bare property-read form occurs inside the
// bundled better-auth CLIENT code (its baseURL inference chain reads
// NEXT_PUBLIC_AUTH_URL, then NEXTAUTH_URL, then VERCEL_URL). Only the
// read-form occurrences in .next/** build artifacts are exempted — see the
// scanCodeFile comment at the token loop.
const BUNDLED_READFORM_TOKENS = new Set(["NEXTAUTH_URL"]);
// 07-11 (WR-04 gap closure): exact-FILENAME retired-token exemptions — the
// token-count checks in scanCodeFile skip these three in-tree historical
// tools (rationale per entry, mirrored in the header). Keyed by basename
// WITH extension so a renamed copy of exempt content still trips (suite pin
// 5h); every non-token check (imports, file names, route paths, dependency
// declarations) still applies to the exempt files.
const RETIRED_TOKEN_EXEMPT_FILE_NAMES = new Set([
  "check-cron-remnants.mjs", // self-scan paradox: this gate's body quotes every retired token as its own definitions
  "rehearse-cutover.mjs", // Phase-5 rehearsal tool: the throwaway CRON_SECRET/CRON_MODE lever IS the retired pre-06-05 interface it exercises
  "auth-soak-gate.mjs", // the recorded §14 soak window leg reads the retired AUTH_NOTICE_* envs (07-DEPLOY-RECORD)
]);
const PHASE7_BANNED_DEPENDENCIES = [
  "next-auth",
  "@auth/prisma-adapter",
  "@prisma/client",
  "@prisma/adapter-pg",
  "prisma",
  "js-cookie",
  "@types/js-cookie",
];
// Phase-8 deletion (08-02, UI-02 D-33/D-34): the two dependencies deleted at
// the redesign release — react-icons (icon consolidation to hugeicons) and
// sweetalert2 (dialog consolidation to shadcn alert-dialog + sonner) — plus
// the lucide-react INSURANCE leg: never a dependency of this repo, but
// components.json's stale iconLibrary value means a future `shadcn add`
// could silently import it (Pitfall 1), so specifier + dependency are both
// banned. Exact + prefix forms so "react-icons/fa" subpaths all trip.
const PHASE8_EXACT_SPECIFIERS = new Set(["react-icons", "sweetalert2", "lucide-react"]);
const PHASE8_SPECIFIER_PREFIXES = ["react-icons/", "sweetalert2/", "lucide-react/"];
const PHASE8_BANNED_DEPENDENCIES = ["react-icons", "sweetalert2", "lucide-react"];
const ROOT_CONFIG_FILES = ["playwright.config.ts", "next.config.ts", "ecosystem.config.js"];

// The Phase-7 extension's advisory→armed lifecycle (06-05 pattern): the
// extension shipped ADVISORY while the 07-08 deletions landed (findings
// reported, exit 0); the 07-08 arming step flips this to true — every
// Phase-7 finding now fails the verify chain exactly like the Phase-5/6
// classes, permanently.
const PHASE7_ENFORCED = true;
// The Phase-8 extension (checks 13) arms in the SAME task that deletes the
// dependencies (08-02): the sweep proves zero specifiers before `pnpm
// remove`, so the gate is born ENFORCED — no advisory period is possible.
const PHASE8_ENFORCED = true;

const DEFAULT_ROOTS = () => {
  const roots = [path.join("src")];
  // 07-11 (WR-04/G-07-63): the executable-tooling root rides the default scan
  // unconditionally (an executable root, always present in this repo — NOT a
  // prose home; the docs/.planning exclusions stay). The D-05 delete-after-use
  // blast script this phase deleted lived at scripts/send-relogin-blast.mjs:
  // re-creating it (or any scripts/*.mjs remnant) previously produced ZERO
  // findings.
  roots.push(path.join("scripts"));
  if (existsSync(path.join("dist", "worker.js"))) roots.push(path.join("dist", "worker.js"));
  if (existsSync(path.join(".next", "server"))) roots.push(path.join(".next", "server"));
  // D-27: repo-root config files ride the default scan so the retired
  // playwright CRON_MODE writer (Pitfall 9) and any config-level
  // CRON_SECRET reference stay gate-enforced. Each is optional.
  for (const name of ROOT_CONFIG_FILES) {
    if (existsSync(name)) roots.push(name);
  }
  return roots;
};
const DEFAULT_PACKAGE_JSON = path.join("package.json");

function usage() {
  return [
    `Usage: node scripts/${SCRIPT_NAME} [dir|file ...] [--advisory]`,
    "",
    "D-41/D-27 remnant gate. Flags instrumentation.ts/js files,",
    "node-cron / .../instrumentation imports, CRON_MODE and the retired",
    "CRON_SECRET tokens, deleted cron route paths (app/api/cron/*), imports",
    "of the four deleted legacy modules (cron-logic, db-batcher,",
    "cleanup-logic, mail), and node-cron dependency declarations. The",
    "Phase-7 extension (07-08) additionally flags next-auth / @auth/* /",
    "@prisma/* / js-cookie specifiers, the deleted Phase-7 module basenames",
    "(tokens, auth-legacy, authSlice, send-relogin-blast, prisma), the",
    "retired NEXTAUTH_SECRET/NEXTAUTH_URL + AUTH_NOTICE_* env tokens, and",
    "the Phase-7 banned dependencies. The 07-11 WR-04 extension flags any",
    "code file NAMED like a deleted module from either basename set (a",
    "remnant by file name, import specifiers regardless). The Phase-8",
    "extension (08-02) flags react-icons / sweetalert2 specifiers and the",
    "lucide-react insurance leg, plus their dependency declarations",
    "(UI-02, D-33/D-34), and flags any AI module specifier (ai, @ai-sdk/*,",
    "@/lib/ai) under src/worker/** (08-10, AI-05/rule 15, path-scoped — the",
    "web AI surface is exempt by design). Default targets:",
    "src/, scripts/ (07-11), dist/worker.js, .next/server, and the repo-root",
    "config files playwright.config.ts / next.config.ts / ecosystem.config.js",
    "(each when present) plus ./package.json. docs/, .planning/,",
    "node_modules/, .git/, .snapshots/ and .env.example are NEVER scanned.",
    "Retired-token counting (CRON_MODE + the retired env tokens) is exempt",
    "for exactly three in-tree historical tools by exact file name",
    "(check-cron-remnants.mjs, rehearse-cutover.mjs, auth-soak-gate.mjs —",
    "see the header); every other check still applies to them.",
    "",
    "  --advisory  list ALL findings but exit 0 (whole-script override for",
    "              fixture probes; the Phase-7 extension itself reports",
    "              advisory-with-exit-0 until PHASE7_ENFORCED flips at the",
    "              07-08 arming step)",
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

// D-27: basename match so "@/lib/cron-logic", "../lib/db-batcher",
// "./cleanup-logic" and "./mail" (at any depth) are all caught.
function deletedModuleImport(specifier) {
  const base = specifier.split("/").pop() ?? "";
  return DELETED_MODULE_BASENAMES.has(base);
}

// Phase-7 (07-08): banned auth/Prisma/cookie specifiers. Exact forms for
// the bare package names, prefix forms for subpaths ("next-auth/react",
// "@prisma/client"); the "prisma" internal/CLI basename is handled by
// PHASE7_DELETED_MODULE_BASENAMES above.
function phase7BannedImport(specifier) {
  if (PHASE7_EXACT_SPECIFIERS.has(specifier)) return true;
  for (const prefix of PHASE7_SPECIFIER_PREFIXES) {
    if (specifier.startsWith(prefix)) return true;
  }
  return false;
}

function phase7DeletedModuleImport(specifier) {
  const base = specifier.split("/").pop() ?? "";
  return PHASE7_DELETED_MODULE_BASENAMES.has(base);
}

// Phase-8 (08-02): the deleted icon/dialog dependency specifiers plus the
// lucide-react insurance leg. Exact forms for the bare package names,
// prefix forms for subpaths ("react-icons/fa", "sweetalert2/dist/...").
function phase8BannedImport(specifier) {
  if (PHASE8_EXACT_SPECIFIERS.has(specifier)) return true;
  for (const prefix of PHASE8_SPECIFIER_PREFIXES) {
    if (specifier.startsWith(prefix)) return true;
  }
  return false;
}

// Phase-8 AI-in-worker leg (08-10, AI-05 / rule 15 — belt-and-braces beside
// worker:boundary): no AI module specifier may appear under src/worker/**.
// Unlike every other specifier check in this gate this one is PATH-SCOPED —
// the web AI surface (src/lib/ai/**, src/app/api/ai/**, tests) legitimately
// imports these specifiers; only the worker tree may never. Findings are
// phase8-marked (the leg is born ENFORCED beside its 08-02 siblings).
// Gate-leg constants legitimately name the specifiers
// (planner-discipline-allow: LIT).
const PHASE8_AI_IN_WORKER_EXACT_SPECIFIERS = new Set(["ai"]);
const PHASE8_AI_IN_WORKER_SPECIFIER_PREFIXES = ["@ai-sdk/", "@/lib/ai"];

function isWorkerPath(file) {
  const segments = file.split(/[\\/]/);
  return segments[0] === "src" && segments[1] === "worker";
}

function phase8AiInWorkerImport(file, specifier) {
  if (!isWorkerPath(file)) return false;
  if (PHASE8_AI_IN_WORKER_EXACT_SPECIFIERS.has(specifier)) return true;
  for (const prefix of PHASE8_AI_IN_WORKER_SPECIFIER_PREFIXES) {
    if (specifier.startsWith(prefix)) return true;
  }
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
      if (deletedModuleImport(specifier)) {
        reasons.push(
          `imports a deleted legacy module ("${specifier}") at line ${index + 1} (D-27)`
        );
      }
      if (phase7BannedImport(specifier)) {
        reasons.push({
          phase7: true,
          text: `imports a banned Phase-7 package ("${specifier}") at line ${index + 1} (AUTH-07/DRZ-07)`,
        });
      }
      if (phase7DeletedModuleImport(specifier)) {
        reasons.push({
          phase7: true,
          text: `imports a deleted Phase-7 module ("${specifier}") at line ${index + 1} (AUTH-07/08, DRZ-07, D-05)`,
        });
      }
      if (phase8BannedImport(specifier)) {
        reasons.push({
          phase8: true,
          text: `imports a banned Phase-8 package ("${specifier}") at line ${index + 1} (UI-02, D-33/D-34)`,
        });
      }
      if (phase8AiInWorkerImport(file, specifier)) {
        reasons.push({
          phase8: true,
          text: `imports an AI module under src/worker ("${specifier}") at line ${index + 1} (AI-05, rule 15 — AI is web-process only)`,
        });
      }
    }
  });
  // 07-11 (WR-04 gap closure): the three exact-file-name historical tools are
  // exempt from TOKEN COUNTING only (header + RETIRED_TOKEN_EXEMPT_FILE_NAMES
  // for the per-entry rationale). Imports, file names, route paths, and
  // dependency checks above/below still run on them.
  const isRetiredTokenExempt = RETIRED_TOKEN_EXEMPT_FILE_NAMES.has(path.basename(file));
  const cronModeHits = isRetiredTokenExempt ? 0 : content.split("CRON_MODE").length - 1;
  if (cronModeHits > 0) {
    reasons.push(`references the CRON_MODE env token (${tokenHitText(cronModeHits)})`);
  }
  // Comments-inclusive by design (IN-06/D-19 asymmetry — see header).
  // 07-08 exemption (armed-gate discovery): inside the WEB build artifact
  // bundle (.next/**) the kept better-auth client's own baseURL-inference
  // helper reads `process.env.NEXTAUTH_URL` as a legacy fallback — a
  // third-party literal this repo cannot delete and that no repo-authored
  // remnant requires. For those files, occurrences in the exact
  // `process.env.<TOKEN>` property-read form are subtracted from the count;
  // every other occurrence (our comments, string literals, assignments) still
  // trips. Source scans (src/) stay fully comments-inclusive and never exempt.
  const isWebBuildArtifact = file.split(/[\\/]/).includes(".next");
  for (const token of RETIRED_ENV_TOKENS) {
    let hits = isRetiredTokenExempt ? 0 : content.split(token).length - 1;
    if (isWebBuildArtifact && BUNDLED_READFORM_TOKENS.has(token)) {
      hits -= content.split(`process.env.${token}`).length - 1;
    }
    if (hits > 0) {
      const reason = `references the retired ${token} env token (${tokenHitText(hits)})`;
      reasons.push(PHASE7_RETIRED_ENV_TOKENS.has(token) ? { phase7: true, text: reason } : reason);
    }
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
      for (const name of BANNED_DEPENDENCIES) {
        if (name in deps) reasons.push(`${section} still declares ${name}`);
      }
      for (const name of PHASE7_BANNED_DEPENDENCIES) {
        if (name in deps) {
          reasons.push({
            phase7: true,
            text: `${section} still declares ${name} (Phase-7 deletion release, AUTH-07/DRZ-07)`,
          });
        }
      }
      for (const name of PHASE8_BANNED_DEPENDENCIES) {
        if (name in deps) {
          reasons.push({
            phase8: true,
            text: `${section} still declares ${name} (Phase-8 dialog/icon consolidation, UI-02, D-33/D-34)`,
          });
        }
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
  // D-27 check 5: the deleted cron route path applies to EVERY walked file
  // (source or build artifact) by path shape, content regardless.
  const seenPathChecked = new Set();
  for (const file of [...entrypointFiles, ...codeFiles]) {
    if (seenPathChecked.has(file)) continue;
    seenPathChecked.add(file);
    if (DELETED_CRON_ROUTE_PATH.test(file)) {
      findings.push({
        file,
        reason:
          "recreates a deleted cron route path (app/api/cron/*) — retired at the 06-05 deletion release (SEC-06, D-27)",
      });
    }
  }
  for (const file of entrypointFiles) {
    findings.push({ file, reason: "legacy scheduler entrypoint file (instrumentation.ts/js) still present" });
  }
  // 07-11 (WR-04/G-07-63) deleted-module FILE-NAME check: a clean-content
  // code file whose basename-minus-extension matches a deleted module
  // basename is a remnant by NAME — import specifiers regardless (the D-05
  // blast script was invoked by name and carried zero importers). Phase-5-set
  // hits land plain (always enforced); Phase-7-set hits are phase7-marked —
  // exactly mirroring the specifier checks' severity discipline. The wording
  // is distinct from the import-specifier messages so the pins can assert
  // which check fired.
  for (const file of codeFiles) {
    const base = path.basename(file, path.extname(file));
    if (DELETED_MODULE_BASENAMES.has(base)) {
      findings.push({
        file,
        reason: `file NAME matches a deleted legacy module ("${base}") — the D-27 remnant class recreated by file name`,
      });
    }
    if (PHASE7_DELETED_MODULE_BASENAMES.has(base)) {
      findings.push({
        file,
        reason: `file NAME matches a deleted Phase-7 module ("${base}") — the AUTH-07/08, DRZ-07, D-05 remnant class recreated by file name`,
        phase7: true,
      });
    }
  }
  for (const file of codeFiles) {
    for (const reason of scanCodeFile(file)) {
      if (typeof reason === "string") {
        findings.push({ file, reason });
      } else {
        findings.push({ file, reason: reason.text, phase7: true });
      }
    }
  }
  const packageJsonRelative = packageJsonPath ? path.relative(".", packageJsonPath) || "." : null;
  for (const reason of checkPackageJson(packageJsonPath)) {
    if (typeof reason === "string") {
      findings.push({ file: packageJsonRelative, reason });
    } else {
      findings.push({ file: packageJsonRelative, reason: reason.text, phase7: true });
    }
  }

  // Phase split: the Phase-5/6 classes stay enforced; each phased extension
  // (Phase-7, Phase-8) is enforced once its arming flag flips true — arming
  // an extension never relaxes the classes already armed before it.
  const isEnforced = (f) =>
    (!f.phase7 || PHASE7_ENFORCED) && (!f.phase8 || PHASE8_ENFORCED);
  const enforcedFindings = findings.filter(isEnforced);
  const advisoryFindings = findings.filter((f) => !isEnforced(f));

  const scannedCount = codeFiles.length + entrypointFiles.length;
  if (enforcedFindings.length > 0) {
    const banner =
      `[cron-remnants] ${advisory ? "ADVISORY" : "VIOLATIONS"}: ${enforcedFindings.length} finding(s) ` +
      `— D-41 remnant gate${advisory ? " (whole-script --advisory override: findings listed, exit 0)" : " (the legacy scheduler/auth/Prisma stack must be fully deleted)"}:`;
    const lines = [banner];
    for (const finding of enforcedFindings) {
      lines.push(`  ${finding.file}: ${finding.reason}`);
    }
    if (advisory) {
      console.log(lines.join("\n"));
      return 0;
    }
    console.error(lines.join("\n"));
    return 1;
  }
  if (advisoryFindings.length > 0) {
    const lines = [
      `[cron-remnants] ADVISORY (pre-arm extension): ${advisoryFindings.length} finding(s) ` +
        `— exit 0 until that phase's deletions land and its arming flag flips:`,
    ];
    for (const finding of advisoryFindings) {
      lines.push(`  ${finding.file}: ${finding.reason}`);
    }
    console.log(lines.join("\n"));
    return 0;
  }

  console.log(
    `[cron-remnants] green — ${scannedCount} code file(s) scanned across ${roots.join(", ")}` +
      (packageJsonRelative ? ` (+ ${packageJsonRelative})` : "") +
      ", no cron remnants (D-41/D-27), no Phase-7 auth/Prisma remnants, " +
      "no Phase-8 icon/dialog remnants, and no AI imports under src/worker " +
      "(AI-05/rule 15)"
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
