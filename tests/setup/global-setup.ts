import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Test-database safety guard (T-02-05)
//
// This is a LIVE production system's repo: a misdirected DATABASE_URL would
// point `prisma db push --force-reset` (and the suite's TRUNCATE seeds) at a
// real database and destroy data. The guard refuses to let any test machinery
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

  // Interim schema authority until Phase 3 (runbook M-step contract, 01-07):
  // apply prisma/schema.prisma to the guarded, local docker test database.
  //
  // No --force-reset (deviation from plan wording, see 02-02-SUMMARY):
  // - Prisma 7 removed --skip-generate (db push never generates the client).
  // - --force-reset trips Prisma's AI-agent dangerous-action consent gate,
  //   breaking agent-run sessions; the target is a volume-less throwaway
  //   container anyway — recreate it with `docker compose down && up -d --wait`.
  // - Plain push on a fresh container creates the schema; on schema drift it
  //   FAILS CLOSED (demands explicit --accept-data-loss) instead of silently
  //   wiping data — the safer default even behind the localhost guard.
  try {
    execSync("pnpm exec prisma db push", {
      stdio: "inherit",
    });
  } catch {
    // Command output was already inherited to the console; restate the cause.
    throw new Error(
      "global-setup failed: prisma db push could not prepare the test database. " +
        "Is the docker test stack up? (docker compose -f docker-compose.test.yml up -d --wait) " +
        "If the schema drifted, recreate the stack: docker compose -f docker-compose.test.yml down && up -d --wait."
    );
  }
}
