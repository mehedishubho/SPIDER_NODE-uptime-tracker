import { defineConfig } from "drizzle-kit";

// DATABASE_URL is supplied by the invoking process (drizzle-kit pull / migrate /
// generate). Throw when missing — startup-validation discipline shared with
// vitest.config.ts and src/lib/redis.ts — and never log the value (secrets
// stay out of output).
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("Missing DATABASE_URL environment variable");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  // Emits '--> statement-breakpoint' between statements (kit default).
  breakpoints: true,
  // Non-negotiable (research Pitfall 4): the default ["*"] would introspect
  // the drizzle bookkeeping schema the migration runner creates, poisoning
  // every pull with __drizzle_migrations and permanently breaking the
  // empty-diff gate (03-07).
  schemaFilter: ["public"],
});
