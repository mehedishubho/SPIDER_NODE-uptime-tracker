# Phase 7: Better Auth Cutover, Admin Gating & Prisma Removal - Pattern Map

**Mapped:** 2026-09-22
**Files analyzed:** 22 (13 flip-release source, 3 deletion-release, 9 test files — Auth forms grouped as one row)
**Analogs found:** 19 / 22 (exact or role-match); 3 partial/no-analog items flagged in `## No Analog Found`

**Tracked-source gate (#3645):** every analog path below was verified with `git ls-files` — all TRACKED. No gitignored mirrors named.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/auth.ts` (REWRITE) | service/config (auth engine instance) | request-response | `src/lib/queue-producer.ts` (factory + throw-early env) + own current file (behavior contract) | role-match |
| `src/lib/auth-password.ts` (NEW) | utility (crypto transform) | transform | `src/app/api/auth/register/route.ts:70` + `src/lib/auth.ts:52-55` (bcrypt primitives) | role-match |
| `src/lib/auth-client.ts` (NEW) | client provider/config | request-response | none in repo (RESEARCH.md client-swap example) | none |
| `src/app/api/auth/[...all]/route.ts` (NEW) | route (catch-all) | request-response | `src/app/api/auth/[...nextauth]/route.ts` (3-line re-export shape) | exact |
| `src/proxy.ts` (MOD) | middleware | request-response | `src/proxy.ts` itself (redirect shape preserved; only the token check swaps) | exact |
| `src/app/api/feedback/route.ts` (MOD) | route/controller | CRUD (request-response) | itself (`getServerSession` guard lines 43-48) + `src/lib/api-error.ts` | exact |
| `src/lib/email/render.ts` (MOD) | utility (render) | transform | itself (domain const line 15; render fns 86-110) | exact |
| `src/lib/email/enqueue.ts` (UNCHANGED) | service (enqueue door) | event-driven (queue) | — (delegation target; excerpt below for the hooks) | n/a |
| `src/db/schema.ts` (MOD) | model | schema (pull-format) | itself (`users` 46-59, `accounts` 169-189 — the pull-format contract) | exact |
| `drizzle/000X_better_auth_cutover.sql` (NEW) | migration | batch (DDL) | `drizzle/0001_worker-prereqs.sql` | exact |
| `src/worker/bull-board.ts` (NEW) | route/middleware (worker) | request-response | `src/worker/health.ts` (handler dispatch + JSON responses + injectable options) + `src/worker/logger.ts` (audit line) | role-match |
| `src/worker/health.ts` (MOD) | service (HTTP server) | request-response | itself (`handle()` dispatch chain 197-253 — new path before the 404) | exact |
| `scripts/send-relogin-blast.mjs` (NEW, delete-after-use) | utility script (operator) | batch (fan-out enqueue) | `scripts/enqueue-smoke.mjs` | exact |
| `scripts/rehearse-migrations.mjs` (MOD) | utility script (gate) | batch | itself (WR-05 target lines 505, 690-701) | exact |
| `scripts/check-cron-remnants.mjs` (MOD, deletion release) | utility script (grep gate) | batch | itself (extension points lines 65-68, 185-196, 203-220) | exact |
| `src/components/Auth/*.tsx` (MOD, 5 forms) | component (client) | request-response | `LoginForm.tsx` itself (handlers 35-73) | exact |
| `src/app/(authLayout)/login/page.tsx` (MOD) | component (server) | request-response | itself + `LoginForm.tsx` layout wrapper (Suspense pattern 249-255) | role-match |
| `src/components/dashboardLayout/TeamSwitch.tsx` (MOD, deletion) | component (client) | — | itself (`js-cookie` lines 9, 47 — the removal surface) | exact |
| `src/redux/features/auth/authSlice.ts` (DELETE, deletion) | store | — | no analog needed (deletion; typecheck is the gate) | n/a |
| `package.json` + build script (MOD, deletion) | config | — | RESEARCH.md removal list (`package.json:8,29-33,47,50,72,83`) | n/a |

Wave 0 test files:

| New/Modified Test File | Role | Data Flow | Closest Analog | Match Quality |
|------------------------|------|-----------|----------------|---------------|
| `tests/api/feedback-admin.handler.test.ts` (NEW) | test (handler) | request-response | `tests/api/_harness.ts` + existing `*.handler.test.ts` | exact |
| `tests/worker/bull-board-gate.test.ts` (NEW) | test (integration) | request-response | `tests/worker/health.test.ts` | exact |
| `tests/integration/better-auth-cutover.test.ts` (NEW) | test (integration) | request-response | `tests/worker/health.test.ts` (real-stack, no-mock harness discipline) | role-match |
| `tests/integration/cutover-migration.test.ts` (NEW) | test (integration) | batch | `tests/worker/health.test.ts` harness + `scripts/rehearse-migrations.mjs` assertions | role-match |
| `tests/lib/auth-password.test.ts` (NEW) | test (unit) | transform | `tests/lib/email-render.test.ts` (module-scope env pinning + focused suites) | partial |
| `tests/lib/proxy-auth.test.ts` (NEW) | test (unit) | request-response | `tests/api/_harness.ts` mock-the-seam style (auth seam instead of session seam) | partial |
| `tests/lib/relogin-blast.test.ts` (NEW) | test (unit) | batch | `enqueueTransactionalEmail`'s injectable `deps` seam (`src/lib/email/enqueue.ts:46-53`) | role-match |
| `tests/integration/auth-email-hooks.test.ts` (NEW) | test (integration) | event-driven | `tests/api/auth-shallow.handler.test.ts` (env pinning) + `_harness.ts` injectable-queue precedent | role-match |
| `tests/lib/email-render.test.ts` (MOD) | test (fixture parity) | transform | itself (re-freeze procedure in header lines 3-16) | exact |

---

## Pattern Assignments

### `src/lib/auth.ts` (service/config — REWRITE: NextAuth options → Better Auth instance)

**Analog (structural):** `src/lib/queue-producer.ts` — the repo's established shape for "singleton factory with throw-early env validation and globalThis caching".

**Throw-early env pattern** (`src/lib/queue-producer.ts:39-44`):
```typescript
export function webQueueProducer(): WebQueueProducerSet {
  if (!globalForProducer.webQueueProducer) {
    const connectionString = process.env.REDIS_URL;
    if (!connectionString) {
      throw new Error("Environment variable REDIS_URL is not set");
    }
```
Apply this convention to `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` (06 D-11 lineage; CONTEXT D-09 is the same convention for `ADMIN_EMAILS`). Note the file's own doc-comment discipline: a leading `// ---` banner block stating the decision lineage (queue-producer lines 5-20; every 03-07 file does this). The rewrite should keep that voice.

**Behavior contract to mirror** (the CURRENT `src/lib/auth.ts` — read-only reference for parity, not style):
- Email normalization before lookup (`src/lib/auth.ts:36`): `const normalizedEmail = credentials.email.toLowerCase().trim();`
- Verification gate surfaced message (`src/lib/auth.ts:47-49`): `throw new Error("Please verify your email address before logging in.");` — this exact string is the D-33 client-mapping target for Better Auth's 403 `EMAIL_NOT_VERIFIED`.
- Bcrypt compare (`src/lib/auth.ts:52-55`): `await bcrypt.compare(credentials.password, user.password)` — moves into `auth-password.ts`.
- OAuth providers by key (`src/lib/auth.ts:16-23`): `GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID || "", ... })` — env NAMES carry over to `socialProviders.google/github` (research recommends `!` assertions + throw-early over `|| ""`).
- Session identity fields (`src/lib/auth.ts:88-95`): session carries `id`/`image`/`name` — under Better Auth these come from the `users` row natively; no callback mirror needed.

**Target shape** (from RESEARCH.md Pattern 1 — the config pins ARE the plan; do not re-derive): `betterAuth({ basePath: "/api/auth", database: drizzleAdapter(db, { provider: "pg", schema: { user: schema.users, account, session, verification } }), user: { modelName: "users", fields: { emailVerified: "<new-boolean-column>" } }, account: { accountLinking: { disableImplicitLinking: true } }, emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 6, autoSignIn: false, revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: 3600, password: { hash, verify }, sendResetPassword }, emailVerification: { sendOnSignUp: true, sendOnSignIn: false, sendVerificationEmail }, socialProviders: { google, github }, session: { expiresIn: 60*60*24*30, cookieCache: { enabled: true, maxAge: 5*60, strategy: "jwt" } }, advanced: { database: { generateId: false } }, plugins: [admin({ adminRoles: ["admin"] })] })`. Keep the export Next-free (`createAuth()` factory + `export const auth`) so the worker can import it (D-18/A-2; anti-pattern list: zero `next/*` imports in this module).

---

### `src/lib/auth-password.ts` (NEW — utility, transform)

**Analogs (bcrypt primitives only):** `src/app/api/auth/register/route.ts:70` and `src/lib/auth.ts:52-55`:
```typescript
const hashPassword = await bcrypt.hash(password, 10);   // register route:70 — rounds=10 parity
const isPasswordValid = await bcrypt.compare(credentials.password, user.password); // auth.ts:52-53
```
`bcryptjs` import convention: `import bcrypt from "bcryptjs";` (both files).

**Core mechanism has NO in-repo analog** — copy RESEARCH.md Pattern 2 verbatim: `BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"]`; `verify` routes on prefix, fire-and-forget `upgradeHash` UPDATE keyed on hash equality (`UPDATE "account" SET "password" = ... WHERE "password" = <legacyHash>`). Follow the file conventions of `src/lib/email/enqueue.ts`: banner comment citing decision IDs (A-1, AUTH-01/09, audit §12.2), exported named functions, no default export.

---

### `src/lib/auth-client.ts` (NEW — client provider)

**No in-repo analog.** Use RESEARCH.md's client example: `import { createAuthClient } from "better-auth/react"; export const authClient = createAuthClient();` (basePath defaults to `/api/auth`). All five Auth forms import from this single module — never from `better-auth/react` directly (AUTH-08's "single client source").

---

### `src/app/api/auth/[...all]/route.ts` (NEW — route, catch-all)

**Analog:** `src/app/api/auth/[...nextauth]/route.ts` (verbatim, 4 lines):
```typescript
import NextAuth from "next-auth";
import { authOptions } "@/lib/auth";

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
```
The Better Auth replacement is the same shape with `import { toNextJsHandler } from "better-auth/next"; const handler = toNextJsHandler(auth);` — keep the re-export convention, keep the `@/lib/auth` import. (This file is ALSO the deletion-release target — the [...nextauth] version dies with NextAuth.)

---

### `src/proxy.ts` (MOD — middleware, request-response)

**Analog: itself** — the surrounding shape is preserved byte-for-byte; only the validation call swaps. Current file (`src/proxy.ts:5-26`):
```typescript
export async function proxy(request: NextRequest) {
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    const callbackPath = request.nextUrl.pathname + request.nextUrl.search;
    loginUrl.searchParams.set("callbackUrl", callbackPath);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}
export const config = { matcher: ["/dashboard/:path*"] };
```
Swap: `getToken({...})` → `await auth.api.getSession({ headers: request.headers })` (or `getCookieCache` from `better-auth/cookies`). Everything else — `/login` redirect, `callbackUrl` param construction, matcher — stays identical (research confirms matcher at lines 23-26; cookie name never string-literalized — Pitfall 10).

---

### `src/app/api/feedback/route.ts` (MOD — route, CRUD; the SEC-04/R17 gate)

**Analog: itself.** The session-guard template the admin gate extends (`src/app/api/feedback/route.ts:43-48`):
```typescript
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
```
**Swap:** `getServerSession(authOptions)` → `auth.api.getSession({ headers: await headers() })` (both GET and POST). **Insert after the 401** (RESEARCH Pattern 5):
```typescript
if (session.user.role !== "admin") return apiError(403, "Forbidden");
```
**Error construction convention** (`src/lib/api-error.ts:13-15`) — use `apiError` for NEW responses; existing `NextResponse.json({ error }, { status })` inline forms may stay (D-32 "touched routes only" precedent — but this route IS touched, so converting its responses to `apiError` is consistent with the 06-era convention):
```typescript
export function apiError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
```
POST stays authenticated-for-all (D-14); GET's Drizzle read replaces the Prisma `findMany` with the equivalent join (preserve the `user: { name, email, image }` projection shape from lines 56-70). **D-16 audit line:** one structured log line (userId, route, IP, timestamp) on admin-surface hits — on the web side use `console` JSON consistent with route-file convention (`console.error` style at lines 35, 74); on the worker side use pino (below).

---

### `src/lib/email/render.ts` (MOD — utility, transform)

**Analog: itself.** The module-scope domain read that must move (`src/lib/email/render.ts:15`):
```typescript
const domain = process.env.NEXTAUTH_URL;
```
→ becomes `BETTER_AUTH_URL` (or — per RESEARCH Pattern 4 — the hook-facing variants accept Better Auth's prebuilt `url` instead of rebuilding `token` links). The link-construction sites (`render.ts:87,100`):
```typescript
const confirmLink = `${domain}/verify-email?token=${token}`;   // :87
const resetLink = `${domain}/reset-password?token=${token}`;   // :100
```
**Template bytes stay frozen (EML-05)** — the header banner (`render.ts:1-13`) documents the byte-parity discipline; new functions are ADDITIVE (`renderVerificationEmailFromUrl(email, url)` variants), existing exports keep their signatures until the deletion release removes the custom routes' call sites. Tests pin bytes — see `tests/lib/email-render.test.ts` below.

---

### Email hooks delegation target (UNCHANGED — excerpt for the new hook bodies)

**Source:** `src/lib/email/enqueue.ts:46-53` — the exact call both Better Auth hooks make:
```typescript
export async function enqueueTransactionalEmail(
  payload: EmailPayload,
  deps: { emailQueue?: EmailQueueClient } = {}
): Promise<{ job: unknown }> {
  const queue = deps.emailQueue ?? webQueueProducer().email;
  const job = await queue.add("send", payload, { ...EMAIL_JOB_OPTIONS });
  return { job };
}
```
Hook shape (RESEARCH EML-04): `sendVerificationEmail: async ({ user, url, token }, request) => { await enqueueTransactionalEmail(renderVerificationEmailFromUrl(user.email, url)); }` — render-at-enqueue, never SMTP in-request (06 D-07).

---

### `src/db/schema.ts` (MOD — model, pull-format schema)

**Analog: itself.** Two constraints govern every new table/column:

1. **Formatting gate** (header, `src/db/schema.ts:29-33`): *"the code below keeps the exact formatting drizzle-kit pull emits (single quotes, no semicolons, pull's column and table ordering). The empty-diff gate diffs this file against a normalized pull of a migrated database — cosmetic reformatting here would break the gate."* Workflow (Pitfall 6): author → `drizzle-kit generate` → migrate on docker test DB → `drizzle-kit pull` → reconcile to pull output (only the two sanctioned rewrites: `gen_random_uuid()` default form, `bool_ops`).

2. **The style to match** — `users` (`src/db/schema.ts:46-59`) gains `role` + the new boolean; new tables copy the existing row shapes:
```typescript
export const users = pgTable("users", {
	id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
	...
	emailVerified: timestamp({ precision: 3, mode: 'string' }),
```
Foreign-key + index block convention (`accounts`, `src/db/schema.ts:169-189` — the NextAuth table being reshaped; its `refreshToken: text("refresh_token")` snake-mapped columns are the field-map source for the cutover SQL):
```typescript
}, (table) => [
	uniqueIndex("accounts_provider_providerAccountId_key").using("btree", table.provider.asc().nullsLast().op("text_ops"), ...),
	foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "accounts_userId_fkey" }).onUpdate("cascade").onDelete("cascade"),
]);
```
Include admin-plugin columns even though unused (`banned`/`banReason`/`banExpires` on user; `impersonatedBy` on session — Pitfall 7: Better Auth validates plugin columns at init, in production too).

---

### `drizzle/000X_better_auth_cutover.sql` (NEW — migration, batch DDL)

**Analog:** `drizzle/0001_worker-prereqs.sql` — the house migration format:
```sql
-- Migration 0001: Phase 4 worker prerequisites transcribed from
-- docs/ARCHITECTURE-AUDIT.md §11 (DRZ-04). Additive-only DDL; ...
ALTER TABLE monitors ADD COLUMN next_check_at timestamptz NULL;
--> statement-breakpoint
UPDATE "monitors" SET next_check_at = ...
--> statement-breakpoint
CREATE TABLE outbox (
  id          text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ...
);
```
Copy: header comment citing decision IDs; `--> statement-breakpoint` between every statement; additive-only DDL (D-30's redeploy-only rollback depends on zero renames/drops of legacy objects); `gen_random_uuid()::text` PK defaults; idempotent inserts (`ON CONFLICT DO NOTHING` — §21/D9 rule per RESEARCH Pattern 3). The ADMIN_EMAILS seed step (D-08/D-09 throw-on-zero-match) is parameterized at the migration-runner level, not as literal SQL — rehearse on the snapshot first (D-34), extending `rehearse-migrations.mjs` inventory.

---

### `src/worker/bull-board.ts` (NEW — route/middleware on the worker) + `src/worker/health.ts` (MOD)

**Analog (structure):** `src/worker/health.ts` — the dispatch + guarded-response + injectable-options house style. The delegation point is inside `handle()` before the 404 (`src/worker/health.ts:197-253`; key excerpts):
```typescript
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    return;
  }
  ...
  if (path === "/metrics" && options.metricsRegistry) { ... }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
}
```
`/admin/queues` slots in as a sibling `if (path.startsWith("/admin/queues"))` branch — gate chain FIRST (refusals answered by health.ts itself with 403 + audit line, never by Bull Board), then delegate per RESEARCH Pattern 6 (`HonoAdapter` + `createBullBoard` + `getRequestListener(app.fetch)(req, res)` bridge; mutation powers stay enabled per D-19). Options-injection convention (`StartHealthServerOptions`, `health.ts:131-164`): every new dependency (auth instance, allowlist parser) enters as an optional injectable field with a documented default — the `metricsRegistry` field (lines 154-161) is the exact structural-injection precedent that keeps a package import out of the module signature.

**Bind/security context** (`health.ts:134, 189`): `/** Defaults to 127.0.0.1 (T-04-01 — loopback bind, never 0.0.0.0). */ const host = options.host ?? "127.0.0.1";` — Pitfall 8: D-17's "reachable from allowlisted IP" needs the per-path-source-gating decision (health/metrics stay loopback-only; `/admin/queues` allowlist keyed on `req.socket.remoteAddress`, NOT spoofable headers).

**Audit line (D-16):** `src/worker/logger.ts:16-38` is the structured-log convention — pino JSON on stdout, secrets never interpolated:
```typescript
export function buildLogger(): pino.Logger {
  return pino({ level: process.env.WORKER_LOG_LEVEL ?? "info" });
}
export function jobLogger(base: pino.Logger, fields: JobLogFields): pino.Logger {
  ... base.child(bindings);
}
```
Emit one line per Bull Board hit (allowed or refused) with userId/route/IP/timestamp fields via a child logger.

---

### `scripts/send-relogin-blast.mjs` (NEW — operator script, batch fan-out; delete-after-use D-05)

**Analog:** `scripts/enqueue-smoke.mjs` — the house operator-script contract. Excerpts to copy:
- Header + fail-loud (`enqueue-smoke.mjs:1-22, 33-36`): banner documenting usage/env/exit contract; `function fail(message) { console.error(...); process.exit(1); }`
- Explicit-stack env discipline (`:46-53`): `function requireEnv(name) { const value = process.env[name]; if (!value) fail(`${name} is not set — pass the target stack explicitly (never guess a stack)`); return value; }`
- dotenv + tsx TS-module import (`:23, 61-72`): `import "dotenv/config";` … `queues = await import("../src/worker/queues.ts");` — the blast script imports the email render/enqueue modules the same way (SAME enqueue path the app uses, D-04).
- Teardown discipline (`:131-137`): dispose queue clients before exit so ioredis connections never hold the process open.
- Recipient enumeration: REPLACE enqueue-smoke's raw `pg` natural-key query with a Drizzle `SELECT email FROM users` fan-out (one `enqueueTransactionalEmail` per user); console-provider dry-run locally first (D-04/D-06). Never print connection strings (contract line 21).
- Package.json script entry pattern: `"smoke:enqueue": "tsx scripts/enqueue-smoke.mjs"` → e.g. `"blast:relogin"`.

---

### `scripts/rehearse-migrations.mjs` (MOD — WR-05 fix + inventory extension)

**Analog: itself.** The exact stale line to make count-agnostic (`scripts/rehearse-migrations.mjs:505`):
```javascript
lines.push(`- Bookkeeping rows after migrate (drizzle.__drizzle_migrations): ${e.bookkeeping.journalRows} (1 stamped baseline + 1 runner-applied 0001 — the runner applied 0001 exactly once)`);
```
The ALREADY-correct derived form to imitate (`:690-701`) — journal count derived from `drizzle/meta/_journal.json`, never hard-coded; Phase 7's fix generalizes the :505 prose the same way and extends the digest's pinned table/column inventory with `account`/`session`/`verification` + `users.role`/boolean column ("extends the list, not the pipeline" — 03-05).

---

### `scripts/check-cron-remnants.mjs` (MOD — deletion-release gate extension)

**Analog: itself.** Extension points for the Phase-7 remnant classes (next-auth, `@auth/*`, `@prisma/*`, `prisma/` dir, `js-cookie`, Redux authSlice, `NEXTAUTH_*` env tokens, the blast script + notice-window envs — AUTH-07/08, DRZ-07, D-05):
- Token lists (`:65-68`): `const DELETED_MODULE_BASENAMES = new Set(["cron-logic", "db-batcher", "cleanup-logic", "mail"]); const RETIRED_SECRET_TOKEN = "CRON_SECRET";` → add the Phase-7 basename set + retired tokens in the same constants block.
- Token-counting check (`:185-196`): comments-INCLUSIVE `content.split(TOKEN).length - 1` pattern for retired env tokens.
- Import-specifier check (`:110-135`): comments-skipped, all four specifier forms (static/bare/dynamic/require) — add `next-auth`, `@auth/prisma-adapter`, `@prisma/*` specifiers here.
- Dependency check (`:203-220`): `checkPackageJson` loops `["dependencies", "devDependencies"]` against a name list — add the removal list (`next-auth`, `@auth/prisma-adapter`, `@prisma/client`, `@prisma/adapter-pg`, `prisma`, `js-cookie`, `@types/js-cookie`).
- Advisory→enforcement lifecycle (`:1-10, 286-292`): ships inert/advisory until the deletion release arms it in `pnpm verify` — same posture applies to any Phase-7 gate added before its deletion release.

---

### `src/components/Auth/*.tsx` (MOD — component plumbing swap, D-33 same-pixels)

**Analog: LoginForm.tsx itself** — handler bodies swap; JSX/classes byte-identical. Current credentials + social handlers (`src/components/Auth/LoginForm.tsx:44-55, 64-73`):
```typescript
const res = await signIn("credentials", { email, password, redirect: false });
if (res?.error) { toast.error(res.error || "Invalid email or password."); }
else if (res?.ok) { toast.success("Welcome back! Redirecting to dashboard..."); window.location.href = callbackUrl; }
...
await signIn(provider, { callbackUrl });
```
Swaps (RESEARCH client example): `signIn("credentials", ...)` → `authClient.signIn.email({ email, password })`; `signIn(provider, { callbackUrl })` → `authClient.signIn.social({ provider, callbackURL: callbackUrl })`. Error mapping for D-33 parity: 401 → existing "Invalid email or password."; 403 EMAIL_NOT_VERIFIED → the exact string from `src/lib/auth.ts:48`. Import line changes: `import { signIn } from "next-auth/react";` (line 8) → `import { authClient } from "@/lib/auth-client";`. The other four forms get the same treatment (`signUp.email`, `requestPasswordReset`, `resetPassword`, verify via URL visit). CallbackUrl sanitization block (lines 15-27) stays.

---

### `src/app/(authLayout)/login/page.tsx` (MOD — notice strip host, D-02)

**Analog: itself** (currently a 5-line wrapper: `import { LoginForm } ...; return <LoginForm />;`). The env-dated notice strip renders above `<LoginForm />` from `process.env` window vars — zero client state, non-dismissible, self-cleaning outside the window (`null` when closed). **No in-repo strip/banner analog exists** — the layout-wrapper precedent (Suspense boundary in `LoginForm.tsx:249-255`) shows the composition style; copy comes from 07-UI-SPEC (D-06: drafted in-plan, operator-approved at rehearsal).

---

### `tests/api/feedback-admin.handler.test.ts` (NEW — handler test, SEC-04)

**Analog (exact):** `tests/api/_harness.ts` — import-order contract (harness FIRST, lines 9-17), seam mocks (`:83-85`):
```typescript
vi.mock("next-auth", () => ({ getServerSession: h.getServerSession }));
vi.mock("next-auth/next", () => ({ getServerSession: h.getServerSession }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
```
Phase-7 deltas: the session seam becomes `@/lib/auth` (`auth.api.getSession` — mock BOTH the module and its return shape `{ user: { id, role } }`); the prisma seam becomes the Drizzle/`@/lib/db` seam (or keep whatever the rewritten route injects). Reuse the fixture discipline verbatim — two distinct user ids (`USER_A_ID`/`USER_B_ID`, `:92-103`) become admin/non-admin fixtures with `role` added; `mockSession()` default-null covers the anon-401 case. Matrix: admin 200 / non-admin 403 / anon 401 on GET; POST 200-for-all-authed (D-14).

---

### `tests/worker/bull-board-gate.test.ts` (NEW — worker integration, OBS-04) and `tests/integration/better-auth-cutover.test.ts`, `tests/integration/cutover-migration.test.ts` (NEW)

**Analog (exact for bull-board; harness discipline for the integrations):** `tests/worker/health.test.ts` — real docker test stack, never mocked; ephemeral ports; owned-client teardown. Excerpts (`:42-58, 62-72`):
```typescript
beforeAll(async () => {
  healthy = await startHealthServer({ port: 0, redis: trackClient(new Redis(process.env.REDIS_URL!)), pool: workerPgPool });
});
afterAll(async () => { await healthy.shutdown().catch(() => {}); ... });
it("1. /healthz returns 200 ...", async () => {
  const res = await fetch(`http://127.0.0.1:${healthy.port}/healthz`);
  expect(res.status).toBe(200);
```
Bull-board gate tests: same harness against the extended server — allowlisted-source + admin cookie → 200; non-admin → 403; non-allowlisted source → refusal; audit-line emitted (D-16). The cutover/migration integrations reuse the real-stack discipline (canary login through the framework; migration count/abort semantics against docker PG :5453 — vitest env wiring per `tests/worker/health.test.ts:43-45`).

---

### `tests/lib/email-render.test.ts` (MOD — fixture re-freeze) and remaining Wave-0 tests

**Analog: itself.** The re-freeze procedure is documented in its header (`tests/lib/email-render.test.ts:3-16`): fixtures frozen from a live oracle for a fixed env tuple; env pinned at module scope (`:18-22`: `process.env.NEXTAUTH_URL = "https://parity.spidernode.test";`) — this pinned env must move to `BETTER_AUTH_URL` when render.ts's domain source swaps (Pitfall 5).

- `tests/lib/auth-password.test.ts` (NEW): follow email-render.test.ts's unit conventions (module-scope env/config, focused describes); mechanics have no analog — test RESEARCH Pattern 2 directly (prefix matrix, rehash UPDATE, unknown-prefix refusal).
- `tests/lib/proxy-auth.test.ts` (NEW): mock-the-seam style of `_harness.ts` applied to `@/lib/auth` (no existing proxy test — partial match).
- `tests/lib/relogin-blast.test.ts` (NEW): unit-test the fan-out via `enqueueTransactionalEmail`'s injectable `deps` seam (`enqueue.ts:46-53` — "Injectable queue for tests" is the established convention).
- `tests/integration/auth-email-hooks.test.ts` (NEW): `tests/api/auth-shallow.handler.test.ts` precedent for env-sensitive handler tests (it pins the render env today at :36-38) + injectable-queue seam.

---

## Shared Patterns

### Session guard (all server-side authed surfaces)
**Source:** `src/app/api/feedback/route.ts:43-48` (shape) → `auth.api.getSession({ headers })` after cutover
**Apply to:** `feedback/route.ts`, `src/proxy.ts`, worker Bull Board gate (via a `Headers` object built from `node:req`).
```typescript
const session = await getServerSession(authOptions);
if (!session || !session.user) { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
```

### Admin role check (SEC-04, D-13/D-14)
**Source:** RESEARCH Pattern 5 (no in-repo analog — this phase introduces it)
**Apply to:** feedback GET + Bull Board gate chain.
```typescript
if (session.user.role !== "admin") return apiError(403, "Forbidden");
```

### Uniform error responses
**Source:** `src/lib/api-error.ts:13-15`
**Apply to:** every touched route's new/changed responses (feedback gate, retained auth routes until deletion).
```typescript
export function apiError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
```

### Throw-early env validation (06 D-11 lineage)
**Source:** `src/lib/queue-producer.ts:41-44`; CONTEXT D-09 (`ADMIN_EMAILS` zero-match abort)
**Apply to:** `src/lib/auth.ts` (`BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`), blast script (`requireEnv` from enqueue-smoke), migration runner (ADMIN_EMAILS).

### Injectable-deps test seam
**Source:** `src/lib/email/enqueue.ts:23-26, 46-53` (`EmailQueueClient` interface + `deps` param)
**Apply to:** auth hooks tests, blast-script fan-out test, any new module the planner wants unit-testable without Redis.

### Byte-frozen rendering + fixture pinning (EML-05)
**Source:** `src/lib/email/render.ts:1-13` (banner discipline) + `tests/lib/email-render.test.ts:3-22` (oracle-capture + module-scope env pin)
**Apply to:** render.ts hook-facing variants (additive; template untouched); fixture re-capture for new link shapes.

### Pull-format schema + migration rehearsal gates (03-07)
**Source:** `src/db/schema.ts:29-33` (gate contract) + `drizzle/0001_worker-prereqs.sql` (format) + `scripts/rehearse-migrations.mjs:690-701` (derived-assertion style)
**Apply to:** every new table/column and the cutover migration; extend the digest inventory, never the pipeline.

### Structured logging, secrets never interpolated (OBS-02, T-04-03)
**Source:** `src/worker/logger.ts:16-38`
**Apply to:** D-16 admin-surface audit lines (worker side via pino child logger; web side consistent with route-file console convention).

### Remnant-gate lifecycle (D-41 pattern: advisory → armed at deletion)
**Source:** `scripts/check-cron-remnants.mjs:1-10, 65-68, 203-220`
**Apply to:** the Phase-7 gate extension (next-auth/prisma/js-cookie/NEXTAUTH_* remnants + blast script + notice-window envs).

### Operator-script fail-loud contract
**Source:** `scripts/enqueue-smoke.mjs:33-53, 131-137`
**Apply to:** `send-relogin-blast.mjs` (explicit-stack envs, watchdog, teardown before exit, never print connection strings).

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/lib/auth-client.ts` | client provider | request-response | First Better Auth client in the repo — RESEARCH.md client example is the source; trivially small |
| `/login` notice strip UI | component | request-response | No banner/strip precedent in the app; pixels governed by 07-UI-SPEC, env-window logic is new (D-02) |
| `src/lib/auth-password.ts` core (prefix router + lazy rehash) | utility | transform | Mechanism is new this phase (RESEARCH Pattern 2, Assumption A1); only the bcrypt primitives have analogs |

Everything else maps to a tracked in-repo analog. Note for the planner: three Better Auth config mechanisms (cookieCache, admin plugin, rateLimiter) likewise have no in-repo precedent — RESEARCH.md Patterns 1/5 + Pitfall 9 are authoritative there.

## Metadata

**Analog search scope:** `src/lib/`, `src/worker/`, `src/app/api/**`, `src/app/(authLayout)/`, `src/components/Auth/`, `src/components/dashboardLayout/`, `src/db/`, `src/redux/`, `scripts/`, `drizzle/`, `tests/api/`, `tests/worker/`, `tests/lib/`, `tests/integration/`
**Files scanned:** 25 read in full or in targeted sections; all 21 named analog paths verified git-tracked via `git ls-files`
**Pattern extraction date:** 2026-09-22
