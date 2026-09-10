import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "vitest/config";

// The docker-compose.test.yml test database (Postgres :5453, offset from the
// common local default 5432 — 5453, not the planned 5433, because sibling
// project stacks occupy 5433+ on this machine). This constant is the canonical
// fallback so the scaffold works on checkouts without a .env.test file; when
// .env.test exists it wins (override: true — the test contract beats any
// ambient shell env).
export const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5453/uptime_test";

dotenv.config({ path: ".env.test", override: true });

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

// Set on the main process BEFORE global-setup runs, and inherited by worker
// processes — any test module importing @/lib/prisma sees the right DATABASE_URL
// at its module scope (Pitfall 5).
process.env.DATABASE_URL = testDatabaseUrl;
process.env.TEST_DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/setup/global-setup.ts"],
    // vitest owns .test.ts; Playwright owns .spec.ts
    testMatch: ["tests/**/*.test.ts"],
    // Explicit worker env (same value) so the prisma singleton never sees an
    // unrelated ambient value even if a worker's env differs.
    env: {
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
    },
  },
  resolve: {
    // Manual alias — no extra plugin needed for this single-alias repo
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
