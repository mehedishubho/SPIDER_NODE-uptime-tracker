import path from "node:path";
import { defineConfig } from "vitest/config";
import { DEFAULT_TEST_DATABASE_URL, DEFAULT_TEST_REDIS_URL } from "./vitest.config";

// ---------------------------------------------------------------------------
// Resilience-injection suite config (D-27 / D-30, plan 04-08 Task 1).
//
// D-27 — SEPARATE COMMAND, OUTSIDE pnpm verify: `pnpm test:resilience` runs
// this config; the verify chain never references it. Container stop/start,
// real SIGKILL child processes, and stalled-checker redelivery waits make the
// run inherently slow — it must never compete with verify's <=5-minute
// budget. The main vitest.config.ts is UNTOUCHED (correctness suites keep
// running inside verify, D-31).
//
// D-30 — EXCLUSIVE TEST-STACK OWNERSHIP: the suite stops and starts the
// 5453/6390 docker containers (docker-compose.test.yml). While this command
// runs, NOTHING else may touch that stack — the global setup refuses to
// start when the stack appears in use (lockfile + unexpected-connection
// check in tests/setup/resilience-global-setup.ts). No third stack exists;
// this is the same stack verify uses, just never concurrently.
//
// SIGNAL CONSTRAINTS (Pitfall 8, Windows dev machine): SIGINT CANNOT be
// delivered programmatically to a spawned child on win32 — Node maps it to
// TerminateProcess, so no case here automates graceful SIGINT drain. That
// proof lives where it already belongs: the drain HANDLER is proven
// in-process in tests/worker/shutdown.test.ts (04-01), and the SIGNAL-level
// drain runs in the 04-09 rehearsal's Linux-container leg. This suite's
// kill case uses SIGKILL only — natively deliverable on Windows.
// ---------------------------------------------------------------------------

// Importing ./vitest.config runs its module top-level (.env.test
// override-first dotenv + the process.env DATABASE_URL/REDIS_URL pins), so
// the URL contract here is byte-identical to the correctness suite's.
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
const testRedisUrl = process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;

process.env.DATABASE_URL = testDatabaseUrl;
process.env.TEST_DATABASE_URL = testDatabaseUrl;
process.env.REDIS_URL = testRedisUrl;
process.env.TEST_REDIS_URL = testRedisUrl;

export default defineConfig({
  test: {
    environment: "node",
    // D-30 guard + the SAME drizzle migrate runner discipline as the main
    // suite (the setup imports and calls the existing global-setup logic).
    globalSetup: ["./tests/setup/resilience-global-setup.ts"],
    // Only the seven injection case files — never the correctness suites.
    include: ["tests/resilience/**/*.test.ts"],
    // Explicit worker env (same discipline as vitest.config.ts).
    env: {
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
      REDIS_URL: testRedisUrl,
      TEST_REDIS_URL: testRedisUrl,
    },
    // Container stop/start is slow and cases poll DB/queue/metrics across
    // multi-second windows; each case file boots its own clients. Sequential
    // files, sequential cases — the D-30 ownership makes parallelism wrong.
    fileParallelism: false,
    // Generous per-test budget: stalled-checker redelivery (~30-60 s),
    // breaker OPEN windows (60 s), container stop/start (~5-15 s each).
    testTimeout: 300_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
