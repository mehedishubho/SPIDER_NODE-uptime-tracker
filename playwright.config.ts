import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";

// Same env contract as vitest: .env.test is the single test env source when
// present (override: true beats ambient shell env); the docker-compose.test.yml
// default (Postgres :5453 — 5433 is taken by sibling stacks on this machine)
// is the canonical fallback for checkouts without the file. The Redis twin
// (:6390) keeps the booted server's rate limiter live against the test stack.
const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5453/uptime_test";
const DEFAULT_TEST_REDIS_URL = "redis://localhost:6390";

dotenv.config({ path: ".env.test", override: true });

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;

// Propagate to spec worker processes (seed helpers read it defensively too)
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.TEST_REDIS_URL = TEST_REDIS_URL;

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
      // Playwright's default testMatch also claims *.test.ts — which vitest
      // owns (see vitest.config.ts). Restrict Playwright to *.spec.ts.
      testMatch: /\.spec\.ts$/,
    },
    {
      // HTTP-level API contract tests (02-05, D-16 hybrid split)
      name: "api",
      testDir: "tests/api",
      testMatch: /\.spec\.ts$/,
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
      NODE_ENV: "production",
      DATABASE_URL: TEST_DATABASE_URL,
      // Server-side module-load validation in src/lib/redis.ts throws without
      // this — and the limiter stays REAL against the test Redis so the 429
      // characterization parity is exercised end-to-end.
      REDIS_URL: TEST_REDIS_URL,
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_SECRET: "test-secret",
      // 07-04: the flipped engine's throw-early gate (src/lib/auth.ts
      // requireProductionEnv) fails the production boot without the Better
      // Auth envs — the e2e server needs the same test-scoped values the
      // integration suites pin (deterministic fakes; OAuth flows are never
      // exercised here). OAuth credentials can stay fake: only NON-EMPTINESS
      // is validated at boot.
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: "test-secret-better-auth-0123456789abcdef",
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      GITHUB_CLIENT_ID: "test-github-client-id",
      GITHUB_CLIENT_SECRET: "test-github-client-secret",
      // Server-side module-load validation in src/redux/api/baseApi.ts
      // requires a non-empty base URL (client bundle gets it at build time)
      NEXT_PUBLIC_DEV_BASE_URL: baseURL,
    },
  },
});
