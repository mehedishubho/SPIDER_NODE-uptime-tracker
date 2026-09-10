import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { assertLocalDatabaseUrl } from "./global-setup";

// E2E seed helpers (plan 02-02). Seeding goes through raw `pg` SQL — the
// PROJECT.md-sanctioned alternative to the prisma singleton — so these helpers
// work from any runner (Playwright workers, vitest, plain node) without
// depending on the `@/` alias or prisma-client transpilation.

export const E2E_EMAIL = "e2e-smoke@spidernode.test";
export const E2E_PASSWORD = "E2E-Smoke-Password-1";
export const E2E_MONITOR_NAME = "E2E Smoke Monitor";

// Matches the docker-compose.test.yml default used by vitest.config.ts and
// playwright.config.ts (.env.test, when present, overrides those configs —
// and playwright workers inherit TEST_DATABASE_URL from the config process).
const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5453/uptime_test";

function resolveTestDatabaseUrl(): string {
  // Deliberately never falls back to ambient DATABASE_URL: E2E seeding must
  // not silently target whatever shell the runner happened to inherit.
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  assertLocalDatabaseUrl(url);
  return url;
}

// Guarded at construction (connects lazily on first query).
const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });

/** Wipes every table the app writes (users cascade to their children). */
export async function resetE2EData(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE users, monitors, pings, incidents, feedbacks,
      accounts, sessions, verification_tokens, password_reset_tokens
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Creates a user with a bcryptjs-hashed known password.
 * emailVerified is set: src/lib/auth.ts refuses credentials login without it
 * (02-02-SUMMARY login quirk 1). Defaults reproduce the original smoke user;
 * 02-05's HTTP-level ownership tests pass distinct emails/passwords for two
 * users. Returns the new user id.
 */
export async function seedE2EUser(
  email: string = E2E_EMAIL,
  password: string = E2E_PASSWORD,
  name: string = "E2E Smoke User",
): Promise<string> {
  const passwordHash = await bcrypt.hash(password, 10);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, password, "emailVerified", "timezone", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'UTC', NOW(), NOW())`,
    [id, name, email, passwordHash, new Date()]
  );
  return id;
}

/**
 * Creates one UP monitor for the given user. Fresh timestamps only (minutes
 * old, never >30 days — the retention cleanup purges old rows, Pitfall 2).
 * The URL is never fetched: cron is suppressed in the test server
 * (CRON_MODE=vercel) and no spec drives a monitor check.
 */
export async function seedMonitor(userId: string, name: string): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO monitors (url, name, status, "isActive", interval, "lastChecked",
        "responseTime", "uptimePercent", "totalChecks", "failedChecks", "userId",
        "createdAt", "updatedAt")
     VALUES ($1, $2, 'UP', true, 5, $3, 42, 100.0, 1, 0, $4, NOW(), NOW())
     RETURNING id`,
    ["https://example.com/spidernode-e2e-seed", name, new Date(Date.now() - 60_000), userId]
  );
  return rows[0].id as number;
}

/**
 * Creates one ONGOING incident for a monitor (fresh timestamp — retention
 * cleanup only touches RESOLVED incidents older than 90 days, Pitfall 2).
 * Used by 02-05's HTTP tests to prove incidents-list ownership filtering.
 */
export async function seedOngoingIncident(
  monitorId: number,
  description: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO incidents (id, "monitorId", status, description, "startedAt")
     VALUES ($1, $2, 'ONGOING', $3, NOW())`,
    [id, monitorId, description]
  );
  return id;
}

/** Closes the seed pool so worker processes can exit cleanly. */
export async function closeSeedPool(): Promise<void> {
  await pool.end();
}
