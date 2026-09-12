import { defineConfig } from "drizzle-kit";

// The gate twin of drizzle.config.ts (03-07, D-13): identical dialect, schema,
// breakpoints and dbCredentials — but introspection output goes to the
// throwaway ./.tmp-gate folder, never the committed drizzle/ tree. Consumed
// only by scripts/schema-gate.mjs (`pnpm schema:gate`), which deletes
// ./.tmp-gate on every exit path (success and failure).
//
// DATABASE_URL is set by the gate script to the guarded docker TEST database
// URL (same resolution as vitest.config.ts). Throw when missing — startup
// validation shared with drizzle.config.ts — and never log the value
// (secrets stay out of output).
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("Missing DATABASE_URL environment variable");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./.tmp-gate",
  dbCredentials: { url },
  // Emits '--> statement-breakpoint' between statements (kit default).
  breakpoints: true,
  // Non-negotiable (research Pitfall 4): the default ["*"] would introspect
  // the drizzle bookkeeping schema the migration runner creates on the same
  // database, poisoning every pull with __drizzle_migrations and permanently
  // false-positiving the empty-diff gate. No tablesFilter exclusion is
  // needed: _prisma_migrations is ABSENT (03-03 fact A4 — the schema was
  // db-push'd, never migrate-deploy'd).
  schemaFilter: ["public"],
});
