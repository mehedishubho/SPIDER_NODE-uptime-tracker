import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";

// Same env contract as vitest: .env.test is the single test env source when
// present (override: true beats ambient shell env); the docker-compose.test.yml
// default (Postgres :5453 — 5433 is taken by sibling stacks on this machine)
// is the canonical fallback for checkouts without the file.
const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5453/uptime_test";

dotenv.config({ path: ".env.test", override: true });

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

// Propagate to spec worker processes (seed helpers read it defensively too)
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;

const PORT = 3100; // offset from the app's dev/prod port 3007
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  timeout: 120_000,
  // Tests share one seeded database — a single worker prevents races
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL,
  },
  projects: [
    {
      name: "e2e",
      testDir: "tests/e2e",
    },
    {
      // Filled by plan 02-05 (HTTP-level API contract tests)
      name: "api",
      testDir: "tests/api",
    },
  ],
  webServer: {
    // Runs the just-built artifact — `pnpm build` precedes `pnpm test:e2e`
    // in the verify chain (D-02).
    command: `pnpm exec next start -p ${PORT}`,
    // Readiness probe accepts 2xx/3xx (and 400/401/402/403)
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      // CRITICAL (Pitfall 1): CRON_MODE=vercel makes src/instrumentation.ts
      // return before any cron registration — the booted test server must
      // never make real Telegram or monitor-URL calls.
      CRON_MODE: "vercel",
      NODE_ENV: "production",
      DATABASE_URL: TEST_DATABASE_URL,
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_SECRET: "test-secret",
      // Server-side module-load validation in src/redux/api/baseApi.ts
      // requires a non-empty base URL (client bundle gets it at build time)
      NEXT_PUBLIC_DEV_BASE_URL: baseURL,
    },
  },
});
