import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";

// playwright.ai.config.ts — the STUB-PROVIDER e2e config for the AI surfaces
// (08-07, research A3 / OQ4: the AI happy-path legs run against a local stub
// OpenAI-compatible server, wired via the 07-03 webServer env-injection
// precedent). The default playwright.config.ts e2e project NEVER needs the
// stub: the AI specs' stub-dependent describes skip at describe level unless
// the AI_E2E_STUB marker this config sets is present (Task 3's degrade-safely
// posture — the default verify run stays zero-AI-keys, zero-stub).
//
// Two webServers (Playwright array form):
//   1. scripts/ai-stub-server.mjs on :4599 — the OpenAI-compatible stub.
//   2. the built app on :3110 (offset from the default config's 3100 so the
//      two projects can never collide) with the env triple pointed AT the
//      stub — AI_PROVIDER=custom requires AI_BASE_URL (08-06 custom factory),
//      which is exactly the env-swappable-provider contract (D-02) under test.
//
// The env triple rides the SERVER process only (Pattern 6 / T-08-18): no
// NEXT_PUBLIC_* AI value ever exists.

const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5453/uptime_test";
const DEFAULT_TEST_REDIS_URL = "redis://localhost:6390";

dotenv.config({ path: ".env.test", override: true });

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.TEST_REDIS_URL = TEST_REDIS_URL;

// The marker the AI specs' stub-dependent describes gate on. Config-level
// process.env mutations propagate to spec worker processes (the same
// mechanism playwright.config.ts uses for TEST_DATABASE_URL).
process.env.AI_E2E_STUB = "1";

const PORT = 3110; // offset from the default config's 3100
const STUB_PORT = 4599;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL,
  },
  projects: [
    {
      name: "e2e-ai",
      testDir: "tests/e2e",
      testMatch: /ai-surfaces\.spec\.ts$/,
    },
  ],
  webServer: [
    {
      command: `node scripts/ai-stub-server.mjs`,
      url: `http://localhost:${STUB_PORT}/healthz`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        AI_STUB_PORT: String(STUB_PORT),
      },
    },
    {
      command: `pnpm exec next start -p ${PORT}`,
      url: `http://localhost:${PORT}/login`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        NODE_ENV: "production",
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL: TEST_REDIS_URL,
        BETTER_AUTH_URL: baseURL,
        BETTER_AUTH_SECRET: "test-secret-better-auth-0123456789abcdef",
        GOOGLE_CLIENT_ID: "test-google-client-id",
        GOOGLE_CLIENT_SECRET: "test-google-client-secret",
        GITHUB_CLIENT_ID: "test-github-client-id",
        GITHUB_CLIENT_SECRET: "test-github-client-secret",
        NEXT_PUBLIC_DEV_BASE_URL: baseURL,
        // The flag-ON posture (D-04) with the provider pointed at the stub
        // (D-02: custom = AI_BASE_URL-bearing OpenAI-compatible endpoint).
        AI_ENABLED: "true",
        AI_PROVIDER: "custom",
        AI_MODEL: "stub-model",
        AI_API_KEY: "stub-key-not-a-real-credential",
        AI_BASE_URL: `http://localhost:${STUB_PORT}/v1`,
      },
    },
  ],
});
