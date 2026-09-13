import { execSync } from "node:child_process";
import { defineConfig } from "tsup";

// ---------------------------------------------------------------------------
// Worker bundle config (WRK-14, D-02..D-06, D-10).
//
// One `pnpm build` runs `next build` AND this config (D-06) — web and
// worker artifacts come from the SAME SHA by construction, the DEP-01
// claim made runtime-verifiable via /healthz provenance (D-10). The bundler
// is a swappable seam: this is the minimal verified option set, no plugins,
// no experimental flags (tsup is unmaintained per its README — D-02 locks
// it anyway; tsdown carries the same options if it ever must be swapped).
//
//   format cjs               — D-03: matches the pg/ioredis CJS reality, no
//                              package.json "type" churn, no ESM interop.
//   sourcemap true           — D-04: SIGKILL-mid-job stack traces must
//                              resolve to TypeScript frames; the .map ships
//                              beside the bundle in the deploy tarball.
//   skipNodeModulesBundle    — D-02: externals. The tarball ships
//                              node_modules; native deps (pg, ioredis) load
//                              normally and the bundle stays small.
//   define block             — D-10: embeds WORKER_BUILD_SHA (git
//                              rev-parse --short HEAD at config load,
//                              fallback empty string) and WORKER_BUILD_TS;
//                              src/worker/health.ts reads both constants.
// ---------------------------------------------------------------------------

function resolveBuildSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return ""; // no git (exotic CI) — provenance degrades, never blocks
  }
}

export default defineConfig({
  // Map form (not the bare string/array form): tsup names bundle outputs
  // after the entry FILE by default, which would emit dist/index.js — the
  // runbook, ecosystem.config.js args, and DEP-01 all pin dist/worker.js.
  entry: { worker: "src/worker/index.ts" },
  format: ["cjs"], // D-03
  outDir: "dist",
  sourcemap: true, // D-04 — emits dist/worker.js.map beside the bundle
  skipNodeModulesBundle: true, // D-02 — node_modules ship in the tarball
  platform: "node",
  target: "node16", // safe under engines >=22
  splitting: false, // CJS default; kept explicit — one single-file entry (D-11)
  define: {
    // D-10 provenance chain: tsup embeds, health.ts + the boot log consume.
    "process.env.WORKER_BUILD_SHA": JSON.stringify(resolveBuildSha()),
    "process.env.WORKER_BUILD_TS": JSON.stringify(new Date().toISOString()),
  },
});
