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

// The docker-compose.test.yml test Redis (:6390, offset from the common local
// default 6379 — see the db comment above for the sibling-stack rationale).
// Same contract as the database twin: .env.test override-first when present,
// this constant as the canonical fallback otherwise.
export const DEFAULT_TEST_REDIS_URL = "redis://localhost:6390";

dotenv.config({ path: ".env.test", override: true });

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
const testRedisUrl = process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;

// Set on the main process BEFORE global-setup runs, and inherited by worker
// processes — any test module importing @/lib/prisma sees the right DATABASE_URL
// at its module scope (Pitfall 5). The Redis twin keeps @/lib/redis pointed at
// the test container (its module-load REDIS_URL validation would otherwise
// throw).
process.env.DATABASE_URL = testDatabaseUrl;
process.env.TEST_DATABASE_URL = testDatabaseUrl;
process.env.REDIS_URL = testRedisUrl;
process.env.TEST_REDIS_URL = testRedisUrl;

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/setup/global-setup.ts"],
    // vitest owns .test.ts; Playwright owns .spec.ts. The resilience
    // injection cases (tests/resilience/**) are EXCLUDED here on purpose:
    // they stop/start the docker stack and spawn real worker children, so
    // they live in the separate `pnpm test:resilience` command OUTSIDE this
    // suite's verify budget (D-27) and take exclusive stack ownership (D-30).
    // vitest.config.resilience.ts is their runner. Overriding `exclude`
    // replaces vitest's defaults, so the default node_modules/dist patterns
    // are restated.
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/resilience/**"],
    // Explicit worker env (same value) so the prisma singleton never sees an
    // unrelated ambient value even if a worker's env differs.
    env: {
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
      REDIS_URL: testRedisUrl,
      TEST_REDIS_URL: testRedisUrl,
    },
    // DB-backed integration files share one Postgres database and TRUNCATE
    // whole tables in beforeEach — running files in parallel forks would make
    // them race each other's seeds. Files run sequentially instead (02-03).
    fileParallelism: false,
  },
  resolve: {
    // Manual alias — no extra plugin needed for this single-alias repo
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
