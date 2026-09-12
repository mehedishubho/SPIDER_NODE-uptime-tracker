import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Test-database safety guard (T-02-05)
//
// This is a LIVE production system's repo: a misdirected DATABASE_URL would
// point the migration runner (and the suite's TRUNCATE seeds) at a real
// database and destroy data. The guard refuses to let any test machinery
// run against a host that is not local. It is exported so
// tests/setup/db-guard.test.ts can prove it directly.
// ---------------------------------------------------------------------------

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    /^[a-z0-9-]+\.docker\.internal$/i.test(hostname)
  );
}

/**
 * Throws when the given database URL points at a non-local host.
 * Accepts exactly: localhost, 127.0.0.1, and *.docker.internal.
 * Unparseable/empty URLs are treated as non-local (fail closed).
 */
export function assertLocalDatabaseUrl(url: string): void {
  let hostname: string | null = null;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = null;
  }

  if (!hostname || !isLocalHostname(hostname)) {
    const shown = hostname ?? `(unparseable URL: ${JSON.stringify(url)})`;
    throw new Error(
      `Refusing to run tests against non-local database host: ${shown}. ` +
        `Point DATABASE_URL at the docker test stack (docker-compose.test.yml) and try again.`
    );
  }
}

export default function globalSetup(): void {
  // DATABASE_URL is resolved by vitest.config.ts (.env.test override, else the
  // docker default) before this runs — but guard it here too, so the invariant
  // holds no matter which process invokes the setup.
  assertLocalDatabaseUrl(process.env.DATABASE_URL ?? "");

  // Schema authority since Phase 3 (D-14, runbook M-step contract 01-07):
  // the guarded, local docker test database is built by the SINGLE migration
  // runner from the committed drizzle/ files — every test run exercises the
  // real migrations (baseline 0000 + additive 0001+), the exact artifacts
  // production runs at deploy (03-08). The retired push-from-Prisma-schema
  // command is gone from all test machinery (D-09/D-14): the frozen
  // prisma/schema.prisma no longer describes the grown database.
  try {
    execSync("pnpm exec drizzle-kit migrate", {
      stdio: "inherit",
    });
  } catch {
    // Command output was already inherited to the console; restate the causes.
    throw new Error(
      "global-setup failed: drizzle-kit migrate could not prepare the test database. " +
        "Likely causes: the docker test stack is down " +
        "(docker compose -f docker-compose.test.yml up -d --wait), the drizzle journal " +
        "is corrupted (drizzle/meta/_journal.json), or a migration file is broken. " +
        "A container still holding a pre-drizzle schema must be recreated: " +
        "docker compose -f docker-compose.test.yml down && up -d --wait."
    );
  }
}
