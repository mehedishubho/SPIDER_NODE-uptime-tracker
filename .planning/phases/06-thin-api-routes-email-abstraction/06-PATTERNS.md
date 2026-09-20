# Phase 6: Thin API Routes & Email Abstraction - Pattern Map

**Mapped:** 2026-09-20
**Files analyzed:** 16 new/modified (+6 new test suites)
**Analogs found:** 16 / 16 (this phase mostly rewires existing, already-modernized code — nearly every target file is its own best analog)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/queue-producer.ts` (NEW) | utility/provider | event-driven (enqueue) | `src/lib/redis.ts` + `src/worker/queues.ts:106-152` | exact (globalThis singleton + shared-connection Queue set) |
| `src/lib/email/index.ts` (NEW) | config/provider | request-response | `src/lib/mail.ts:1-13` (transporter config) + `src/lib/redis.ts:14-17` (throw-early env) | exact |
| `src/lib/email/providers/smtp.ts` (NEW) | service | request-response | `src/lib/mail.ts:5-13, 83-88` | exact (wraps the same transporter + sendMail shape) |
| `src/lib/email/providers/console.ts` (NEW) | service | transform | `src/lib/email/providers/smtp.ts` (new sibling) + worker logger style | role-match (new file type; stdout dump follows pino/console.error conventions) |
| `src/lib/email/render.ts` (NEW) | utility | transform | `src/lib/mail.ts:15-103` | exact (byte-verbatim relocation source) |
| `src/lib/email/enqueue.ts` (NEW) | service | event-driven | `src/worker/queues.ts:583-591` (`enqueueMaintenance`) | exact (enqueue-helper shape) |
| `src/worker/email.ts` (NEW) | service (lane processor) | event-driven | `src/worker/persist/outbox.ts` processor style + `src/worker/maintenance.ts` (`processMaintenanceJob`) | exact (worker lane processor + typed error mapping) |
| `src/app/api/monitors/[id]/check/route.ts` (REWRITE) | controller | request-response | itself (`route.ts:12-51`) + `src/app/api/auth/register/route.ts:10-18` (rate-limit admission) | exact |
| `src/app/api/auth/register/route.ts` (EDIT) | controller | request-response | itself | exact |
| `src/app/api/auth/forgot-password/route.ts` (EDIT) | controller | request-response | itself + register route (limiter block) | exact |
| `src/app/api/telegram/webhook/route.ts` (EDIT) | controller | event-driven (webhook) | itself | exact |
| `src/lib/rate-limit.ts` (EXTEND) | middleware | request-response | itself (`:12-44` Lua limiter) | exact |
| `src/worker/queues.ts` (EXTEND) | utility | event-driven | itself (`:488-557` `startLaneWorker` family) | exact |
| `src/worker/index.ts` (EDIT) | config | event-driven | itself (`:146-162` lane-wiring block, `:64-69` teardown) | exact |
| `src/worker/scheduler.ts` (EDIT) | config | batch | itself (`:374` `data: { dryRun: true }`) | exact |
| `src/worker/persist/outbox.ts` (EDIT) | service | transform | itself (`:134-170` `renderAlertMessage`) | exact |
| `src/components/Dashboard/Dashboard.tsx` (EDIT) | component | request-response (poll) | itself (`:184-206` `handleCheckMonitor`) | exact |
| `scripts/enqueue-maintenance.mjs` (EDIT) | script | event-driven | itself (`:155-179` unbounded add) | exact |
| `scripts/check-cron-remnants.mjs` (EXTEND) | config/gate | batch | itself | exact |
| New/extended test suites (6) | test | — | `tests/api/*.handler.test.ts`, `tests/integration/rate-limit.test.ts`, `tests/worker/outbox-relay.test.ts` | exact |

## Pattern Assignments

### `src/lib/queue-producer.ts` (utility, enqueue)

**Analog:** `src/lib/redis.ts` (globalThis singleton discipline) + `src/worker/queues.ts:106-152` (one shared connection across Queue instances)

**Singleton + throw-early pattern** (`src/lib/redis.ts:12-26, 39-41`):
```typescript
const globalForRedis = global as unknown as { redis?: Redis };
const connectionString = process.env.REDIS_URL;
if (!connectionString) {
  throw new Error("Environment variable REDIS_URL is not set");
}
export const redis =
  globalForRedis.redis ||
  (() => {
    const client = new Redis(connectionString, {
      commandTimeout: 200,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
    });
    client.on("error", (err) => {
      console.error("[redis] connection error (limiter will fail-open):", err.message);
    });
    return client;
  })();
if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
```
Copy this shape exactly for the producer (bounded `maxRetriesPerRequest: 1`, small `connectTimeout`, error listener attached INSIDE the factory, `globalThis` cache gated on non-production). RESEARCH's full code example (06-RESEARCH.md lines 420-453) is the ready-to-use synthesis.

**Shared-connection Queue set pattern** (`src/worker/queues.ts:106-132`):
```typescript
export function createWorkerQueues(connection?: IORedis): WorkerQueueSet {
  const ownsConnection = connection === undefined;
  const conn = connection ?? workerConnection();
  const queues = {
    checks: new Queue(QUEUE_NAMES.checks, { connection: conn }),
    email: new Queue(QUEUE_NAMES.email, { connection: conn }),
    // ...
  };
  return {
    ...queues, connection: conn,
    async close(): Promise<void> {
      await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
      if (ownsConnection) { await conn.quit().catch(() => {}); }
    },
  };
}
```
The producer module mirrors this but with only `checks` + `email` over its own bounded connection. Also copy the dispose discipline (`queues.ts:145-151` `disposeWorkerQueues`) for vitest resetModules.

**Import discipline:** import ONLY the pure exports (`QUEUE_NAMES`, `LANE_PRIORITY`, `CHECK_JOB_OPTIONS`, `enqueueManualCheck`) from `@/worker/queues` — never call `workerQueues()` or `workerConnection()` from the web process (both live in `src/worker/connection.ts` with the `null`-retry profile).

---

### `src/lib/email/*` (D-13 module)

**Analog:** `src/lib/mail.ts` (the module being relocated and deleted)

**Transporter config to preserve byte-compatibly** (`src/lib/mail.ts:1-13`):
```typescript
import nodemailer from "nodemailer";
const domain = process.env.NEXTAUTH_URL;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
```

**Render functions — byte-verbatim relocation** (`src/lib/mail.ts:15-75` `generateEmailTemplate`, `:77-89` `sendVerificationEmail` link/content strings, `:91-103` `sendPasswordResetEmail`). The render module keeps the exact strings (subjects `"Confirm your email - SpiderNode"` / `"Reset your password - SpiderNode"`, `from: \`"SpiderNode" <${process.env.SMTP_USER}>\``, link forms `${domain}/verify-email?token=${token}` / `${domain}/reset-password?token=${token}`) but returns `{to, subject, html}` instead of sending (D-07). Pin with `tests/lib/email-render.test.ts`.

**Provider selection throw-early** — follow `src/lib/redis.ts:14-17` env assertion style: `EMAIL_PROVIDER` unset/empty → smtp; `"console"` explicit; anything else throws at boot.

---

### `src/worker/queues.ts` extension — `startEmailLaneWorker`

**Analog:** `src/worker/queues.ts:488-511` (`startLaneWorker`) and `:552-557` (`startMaintenanceLaneWorker`)

```typescript
export function startMaintenanceLaneWorker(
  processor: LaneProcessor,
  opts: { concurrency?: number } = {}
): LaneWorkerHandle {
  return startLaneWorker(QUEUE_NAMES.maintenance, processor, opts.concurrency ?? MAINTENANCE_LANE_CONCURRENCY);
}
```
Copy this exact factory shape for `startEmailLaneWorker(QUEUE_NAMES.email, ...)`. Deviation: the shared `startLaneWorker` does NOT pass `settings` — the email worker needs the custom `backoffStrategy` (D-09 table `[30_000, 120_000, 480_000, 1_800_000, 7_200_000]`), so either extend `startLaneWorker` with an optional settings param or create the Worker directly following the same config block (`lockDuration: 30_000, stalledInterval: 30_000, maxStalledCount: 1`, `worker.on("stalled"/"error")` handlers, `connection: workerConnection()`). Also copy the concurrency-constant pattern (`:470-471` `MAINTENANCE_LANE_CONCURRENCY = 1`).

**Failed-attempts counter precedent:** the in-process `stalledEvents` Map + `noteStalledEvent`/`stalledEventCount` (`queues.ts:355-364`) is the model for the D-10 email failure counter.

---

### `src/worker/email.ts` (lane processor, NEW)

**Analog:** `src/worker/index.ts:159-162` wiring + `src/worker/persist/outbox.ts` processor error discipline

Processor signature convention (as wired in index.ts):
```typescript
const maintenanceWorker = startMaintenanceLaneWorker((job) => processMaintenanceJob(job));
registerDrainable(maintenanceWorker);
```
The email processor takes the `LaneJob`-shaped job, dispatches `{to, subject, html}` through the selected provider, maps transient errors to rethrow and permanent (EAUTH/EENVELOPE/EMESSAGE/5xx) to `throw new UnrecoverableError(...)`, incrementing the D-10 counter. Logging via the module's `buildLogger()` pattern (`queues.ts:30`).

---

### `src/app/api/monitors/[id]/check/route.ts` (REWRITE)

**Analog:** itself + `src/app/api/auth/register/route.ts:10-18`

**Current admission ladder to preserve** (`check/route.ts:14-32`): session 401 → `parseInt` NaN 400 → ownership lookup → 404 `"Monitor not found or unauthorized"`. Changes per decisions: `findUnique` → `findFirst({ where: { id: monitorId, userId } })` (D-17), limiter admission before enqueue (D-21/SEC-05), `enqueueManualCheck(monitorId, { checksQueue: webQueueProducer().checks })` → 202 `{ jobId, queuedAt }` (D-05), `BreakerOpenError`/add-rejection → 503 (API-02).

**Rate-limit admission block to copy** (`src/app/api/auth/register/route.ts:10-18`):
```typescript
const ip = getIP(req);
const { success, remaining } = await rateLimit(`register_${ip}`, { limit: 5, windowMs: 3600000 });
if (!success) {
  return NextResponse.json(
    { error: "Too many registration attempts. Please try again later." },
    { status: 429, headers: { "X-RateLimit-Remaining": remaining.toString() } }
  );
}
```
The manual-check route uses the same block with the two ratified buckets (`rl:manual:{userId}:{monitorId}` 1/30s, `rl:manual-user:{userId}` 6/min) and adds `Retry-After` (D-06 — requires the limiter TTL extension below).

---

### `src/lib/rate-limit.ts` (EXTEND)

**Analog:** itself (`:12-44`)

The Lua script currently returns only the count:
```typescript
const WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
`;
```
Extend it to also return `redis.call("PTTL", KEYS[1])` (one atomic command preserved — Phase 01 IN-01 pin), update `limiterRedis.rlIncr` typing and the two existing call sites' destructuring, and return `{ success, remaining, resetSeconds }`. Keep the fail-open catch block verbatim (`:37-43`). `getIP` (`:91-107`) needs no logic change — only the spoof-test trio pins (D-22).

---

### `src/app/api/auth/register/route.ts` / `forgot-password/route.ts` (EDIT)

**Analogs:** themselves

- Register (`register/route.ts:69-71`): replace `await sendVerificationEmail(...)` with render + `enqueueTransactionalEmail(...)`; keep the 201 body byte-identical; add pre-flight Redis liveness → 503-before-write (Pitfall 6 disposition). Keep the existing limiter block (`:10-18`) untouched.
- Forgot-password (`forgot-password/route.ts:19-27`): preserve the 200-neutral anti-enumeration response verbatim; ADD the register-style limiter block (D-21, `forgot_${ip}` 5/h) above the body parse; replace `sendPasswordResetEmail` (`:25`) with render + enqueue; 503 on enqueue rejection.

---

### `src/app/api/telegram/webhook/route.ts` (EDIT)

**Analog:** itself (`:5-42`)

Insert at the top of POST: per-IP limiter (register block pattern) then the constant-time secret check (`timingSafeEqual` with length guard — 06-RESEARCH Pattern 5). Escape `user.name` before the HTML interpolation at `:30-31`:
```typescript
`🎉 <b>Account Connected!</b>\n\nHello <b>${user.name || 'User'}</b>, ...`
```
(escape `& < >`; normal names stay byte-identical per D-24/D-48 discipline). Keep the try/catch → `console.error('Telegram Webhook Error:', error)` → `{ error: 'Webhook Handler Failed' }` 500 shape.

---

### `src/worker/index.ts` (EDIT)

**Analog:** itself (`:146-162` lane-wiring, `:64-69` teardown)

Wire the email lane exactly like the others:
```typescript
const maintenanceWorker = startMaintenanceLaneWorker((job) => processMaintenanceJob(job));
registerDrainable(maintenanceWorker);
```
WR-02 fix: add `disposeRelayRedis()` (exported at `src/worker/persist/outbox.ts:292`) to `drainAndTeardown` (`:64-69`) alongside `deps.quitRedis()`.

---

### `src/worker/scheduler.ts` (EDIT — D-14)

**Analog:** itself — flip `data: { dryRun: true }` at `scheduler.ts:374` to `dryRun: false`, fix the stale comment. The manual `enqueueMaintenance` path (`queues.ts:583-591`) keeps `--dry-run`/`--apply` script flags.

### `src/worker/persist/outbox.ts` (EDIT — D-16/IN-04)

**Analog:** itself — HTML-escape `& < >` at the `renderAlertMessage` interpolation sites (`outbox.ts:134-170`); normal names/URLs byte-identical; update D-48 pins in the same change.

### `src/components/Dashboard/Dashboard.tsx` (EDIT — D-01..D-04)

**Analog:** itself (`:184-206` `handleCheckMonitor`, `:29` `checkingId` state, `:603-618` spinner button)

Current handler to evolve into enqueue+poll (keep the `setCheckingId`/`finally` frame and the `toast.error(data.error || ...)` fallback):
```typescript
const handleCheckMonitor = async (id: number) => {
  setCheckingId(id);
  try {
    const res = await fetch(`/api/monitors/${id}/check`, { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      toast.success(`Check triggered manually`);
      fetchMonitors();
    } else {
      toast.error(data.error || "Failed to ping monitor.");
    }
  } catch (err) { ... } finally { setCheckingId(null); }
};
```
New shape per 06-RESEARCH lines 487-514: 429 branch reads `Retry-After`; poll `fetchMonitors()` every 2s up to 30s comparing `lastChecked > queuedAt`; success/fresh-result toast, quiet-handoff info toast on give-up. Extract the poll loop into a testable helper (`tests/lib/check-now-poll.test.ts`). Use `sonner` (`toast.*`) — never `sweetalert2`.

### `scripts/enqueue-maintenance.mjs` (EDIT — WR-01)

**Analog:** itself (`:155-179` unbounded add) — bound the enqueue with a deadline or bounded-retry connection per 06-RESEARCH Pitfall 1; script must exit non-zero on unreachable Redis.

## Shared Patterns

### globalThis-cached singleton
**Source:** `src/lib/redis.ts:12-41`, `src/worker/queues.ts:134-151`
**Apply to:** `src/lib/queue-producer.ts` (and any new long-lived client). Includes the error-listener-inside-factory discipline and the non-production-only cache write.

### Throw-early env validation
**Source:** `src/lib/redis.ts:14-17`, `src/worker/index.ts:71-78` (`assertRequiredEnv`)
**Apply to:** `src/lib/email/index.ts` (`EMAIL_PROVIDER` unknown value), webhook route (`TELEGRAM_WEBHOOK_SECRET` unset → loud config error).

### Route error handling
**Source:** `src/app/api/monitors/[id]/check/route.ts:44-50`
**Apply to:** all touched routes:
```typescript
} catch (error) {
  console.error("Check Monitor Error:", error);
  return NextResponse.json({ error: "Failed to check monitor" }, { status: 500 });
}
```
Wire shape stays `{ error }` byte-identical (D-32 `apiError` helper only changes construction). Status ladder: 401 session / 400 validation / 404 ownership / 429 limiter (+`Retry-After`) / 503 Redis-down / 500 catch-all.

### Rate-limit admission block
**Source:** `src/app/api/auth/register/route.ts:10-18`
**Apply to:** manual-check route (two buckets), forgot-password, telegram webhook.

### Enqueue helper with injectable queue
**Source:** `src/worker/queues.ts:324-343` (`enqueueManualCheck`), `:583-591` (`enqueueMaintenance`)
**Apply to:** `src/lib/email/enqueue.ts` — same `(opts, deps?)` shape with an injectable queue client for tests. Omit `jobId` on email jobs (Pitfall 3).

### Lane worker + registerDrainable wiring
**Source:** `src/worker/index.ts:146-162`, `src/worker/queues.ts:488-557`
**Apply to:** email lane. Note BullMQ 6 jobId 3-segment rule and the explicit-priority invariant (`addCheckJob`, `queues.ts:206-229`).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/lib/email/providers/console.ts` | service | transform | No existing provider-interface file; use D-12 (one structured stdout line) + console.error prefix convention (`"[redis] ..."` style) |
| `src/lib/api-error.ts` (if extracted, D-32) | utility | — | No shared route helper exists today; trivial `NextResponse.json({ error: message }, { status })` wrapper — keep wire shape identical |

All other files have exact in-repo analogs (mostly themselves — Phase 6 rewires Phase 3–5 machinery).

## Metadata

**Analog search scope:** `src/lib/`, `src/worker/`, `src/app/api/`, `src/components/Dashboard/`, `scripts/`
**Files read:** 9 core analogs (check route, mail.ts, register, forgot-password, webhook, redis.ts, rate-limit.ts, queues.ts, worker/index.ts) + targeted greps in Dashboard.tsx, scheduler.ts, outbox.ts
**Pattern extraction date:** 2026-09-20
