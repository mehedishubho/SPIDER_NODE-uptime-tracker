import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import Redis from "ioredis";
import {
  collectOutboxMetrics,
  dedupKeyFor,
  DEDUP_TTL_SECONDS,
  isPermanentTelegramFailure,
  processRelayJob,
  RELAY_BATCH_SIZE,
  RELAY_FAILURE_KEY,
  RELAY_MAX_ATTEMPTS,
  RELAY_PASS_EVERY_MS,
  renderAlertMessage,
  telegramSend,
} from "@/worker/persist/outbox";
import type { RelaySendOutcome } from "@/worker/persist/outbox";
import { startHealthServer } from "@/worker/health";

// ---------------------------------------------------------------------------
// Outbox relay proof suite (DAT-05/DAT-06, audit §16.3/§16.4 + D-44..D-48)
// against the REAL docker test Postgres (:5453) + Redis (:6390) — SKIP LOCKED
// exclusion, jsonb terminal markers, and the latency SQL are engine
// semantics, only provable live. The Telegram boundary is MOCKED at the
// send-function seam (configurable outcomes — no real egress; the global
// fetch stub makes any accidental egress fail LOUDLY, T-02-09 discipline).
// Seeds go through raw SQL via TEST_DATABASE_URL only (02-02 rule); the
// relay runs through its own globalThis-cached pool (workerDb).
//
// BYTE-PARITY SOURCES (D-48): the three expected strings transcribe
// src/lib/cron-logic.ts lines 104-133 character-for-character; the Phase 2
// characterization pins live at tests/integration/cron-logic.test.ts:
//   - "MONITORING STARTED: Website is Online!"  — line 257 (case 4)
//   - "ALERT: Website Down!"                     — line 299 (case 5)
//   - "RECOVERY: Website Back Online!"           — line 344 (case 6)
// and the pinned incident description ("Monitor went down. Status code:")
// at line 210/294. The toBe comparisons below are character-for-character,
// not contains.
//
// Pins:
//   1. source/constants — batch 50, 5 s cadence, 7-day TTL (D-47), attempt
//      cap 3 (D-44), permanent classification matrix (D-45), SKIP LOCKED on
//      the claim, sanctioned request shape (parse_mode HTML,
//      disable_notification false), no queue pausing
//   2. byte parity — all three rendered messages equal the transcribed
//      templates exactly (D-48), incl. the statusCode fallback and tz label
//   3. dedup — pre-held key: no send, row still marked sent; confirmed send
//      sets the key with the 7-day TTL (D-47)
//   4. SKIP LOCKED — two passes in parallel: every row sent exactly once
//   5. transient fail-twice-then-succeed: sent with attempts=2
//   6. three transient failures: FAILED + retained (attempts=3, marker),
//      error-level log line, failed gauge, pass does NOT re-claim (D-44)
//   7. permanent 400: immediate FAILED with attempts < 3 +
//      UnrecoverableError, no retries burned (D-45)
//   8. CR-03: null-incident down row dead-lettered (UnrecoverableError)
//   9. no telegramChatId: row handled + marked sent, no send (cron parity)
//  10. gauges — unsent/failed counts + created_at->sent_at latency (D-24/
//      D-25/D-44) on collectOutboxMetrics AND the /metrics.json endpoint
//  11. WR-04 — telegramSend aborts a black-holed connection at ~10 s
//      (well under the 30 s idle_in_transaction cap); a timed-out send is
//      TRANSIENT inside the relay: attempts advance, the per-row claim
//      transaction completes its mark-failure path, and the next pass can
//      still claim the row (no orphaned FOR UPDATE row)
//  12. OBS-03 gauge — oldestUnsentSeconds: the age of the oldest unsent
//      non-FAILED row; null when nothing is unsent; -1 on query failure
//      with the rest of the snapshot still resolving (Pitfall 7)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fixed transition instant — keeps the 🕒 Time segment deterministic. */
const OCCURRED_AT = "2026-09-14T10:00:00.000Z";

let pg: Client;
let admin: Redis;
let testUserId: string;
let chatlessUserId: string;

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const OK_SEND: RelaySendOutcome = { ok: true, status: 200 };

/** An always-succeeding send mock (the seam's happy path). */
function okSendMock() {
  return vi.fn(async (_chatId: string, _message: string): Promise<RelaySendOutcome> => ({ ...OK_SEND }));
}

const job = () => ({ id: `relay-test-${crypto.randomUUID().slice(0, 8)}`, name: "relay-pass", data: {} });

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    monitorName: "relay-parity-monitor",
    monitorUrl: "https://target.test.example.com/probe",
    statusCode: 500,
    responseTimeMs: 123,
    errorClass: "http_5xx",
    occurredAt: OCCURRED_AT,
    userTimezone: "UTC",
    claimEpoch: 1760000000,
    ...overrides,
  };
}

async function seedUser(telegramChatId: string | null, timezone = "UTC"): Promise<string> {
  const result = await pg.query(
    `INSERT INTO users (email, "telegramChatId", timezone, "updatedAt")
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [`relay-test-${crypto.randomUUID()}@example.test`, telegramChatId, timezone]
  );
  return result.rows[0].id as string;
}

async function seedMonitor(userId: string, name: string): Promise<number> {
  const result = await pg.query(
    `INSERT INTO monitors (url, name, "userId", status, "isActive", interval, "updatedAt")
     VALUES ('https://target.test.example.com/probe', $1, $2, 'UP', true, 5, now()) RETURNING id`,
    [name, userId]
  );
  return result.rows[0].id as number;
}

/** Second+ incidents on one monitor must be RESOLVED (incidents_one_ongoing). */
async function seedIncident(monitorId: number, status: "ONGOING" | "RESOLVED" = "ONGOING"): Promise<string> {
  const result = await pg.query(
    `INSERT INTO incidents ("monitorId", status, description, "startedAt", "resolvedAt")
     VALUES ($1, $2, 'Monitor went down. Status code: 500', now(),
             CASE WHEN $2 = 'RESOLVED' THEN now() ELSE NULL END)
     RETURNING id`,
    [monitorId, status]
  );
  return result.rows[0].id as string;
}

async function seedOutbox(opts: {
  monitorId: number;
  eventType: string;
  incidentId?: string | null;
  payload?: Record<string, unknown>;
  attempts?: number;
  sentAt?: string | null;
  createdAt?: string | null;
}): Promise<string> {
  const result = await pg.query(
    `INSERT INTO outbox (event_type, monitor_id, incident_id, payload, attempts, sent_at, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, COALESCE($7, now())) RETURNING id`,
    [
      opts.eventType,
      opts.monitorId,
      opts.incidentId ?? null,
      JSON.stringify(makePayload(opts.payload ?? {})),
      opts.attempts ?? 0,
      opts.sentAt ?? null,
      opts.createdAt ?? null,
    ]
  );
  return result.rows[0].id as string;
}

interface OutboxRow {
  id: string;
  event_type: string;
  incident_id: string | null;
  payload: Record<string, unknown>;
  sent_at: string | null;
  attempts: number;
}

async function fetchOutboxRow(id: string): Promise<OutboxRow | undefined> {
  const result = await pg.query(`SELECT * FROM outbox WHERE id = $1`, [id]);
  return result.rows[0] as OutboxRow | undefined;
}

async function runPass(
  send: (chatId: string, message: string) => Promise<RelaySendOutcome>,
  logger = fakeLogger()
) {
  return processRelayJob(job(), { redis: admin, send, logger });
}

/** Per-case Redis hygiene: only this suite's alert:* dedup keys (03-01 rule). */
async function flushAlertKeys(): Promise<void> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await admin.scan(cursor, "MATCH", "alert:*", "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length > 0) await admin.del(...keys);
}

/**
 * The cron-logic template (lines 104-133) transcribed character-for-character
 * for the pinned inputs — the D-48 parity oracle. The 🕒 Time value uses the
 * SAME pinned formatting call cron-logic applied (en-US, user tz, short tz
 * name) over the fixed transition instant.
 */
function expectedMessage(kind: "started" | "down" | "recovered", p: ReturnType<typeof makePayload>): string {
  const time = new Date(p.occurredAt).toLocaleString("en-US", {
    timeZone: p.userTimezone || "UTC",
    timeZoneName: "short",
  });
  if (kind === "started") {
    return `
🚀 <b>MONITORING STARTED: Website is Online!</b>

📌 <b>Name:</b> ${p.monitorName}
🌐 <b>URL:</b> ${p.monitorUrl}
⚡ <b>Response Time:</b> ${p.responseTimeMs}ms
🕒 <b>Time:</b> ${time}
          `.trim();
  }
  if (kind === "down") {
    return `
🚨 <b>ALERT: Website Down!</b>

📌 <b>Name:</b> ${p.monitorName}
🌐 <b>URL:</b> ${p.monitorUrl}
⚠️ <b>Status Code:</b> ${p.statusCode || "No Response / Timeout"}
⏱️ <b>Response Time:</b> ${p.responseTimeMs}ms
🕒 <b>Time:</b> ${time}
          `.trim();
  }
  return `
✅ <b>RECOVERY: Website Back Online!</b>

📌 <b>Name:</b> ${p.monitorName}
🌐 <b>URL:</b> ${p.monitorUrl}
⚡ <b>Response Time:</b> ${p.responseTimeMs}ms
🕒 <b>Time:</b> ${time}
          `.trim();
}

beforeAll(async () => {
  admin = new Redis(process.env.REDIS_URL!);
  pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("TRUNCATE outbox, incidents, pings, monitors, users CASCADE");
  testUserId = await seedUser("555000111");
  chatlessUserId = await seedUser(null);
});

afterAll(async () => {
  await pg.query("TRUNCATE outbox, incidents, pings, monitors, users CASCADE");
  await pg.end();
  await admin.quit();
});

beforeEach(async () => {
  await pg.query("TRUNCATE outbox, incidents, pings, monitors CASCADE");
  await flushAlertKeys();
  // Default fetch stub: a case that forgets to mock the send seam fails
  // LOUDLY instead of performing real network egress (T-02-09).
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("UNSTUBBED FETCH — real network egress is forbidden in tests")))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs(); // case 11 stubs TELEGRAM_BOT_TOKEN for the direct telegramSend call
  vi.clearAllMocks();
});

describe("outbox relay — DAT-05/DAT-06 + D-44..D-48", () => {
  it(
    "1. source pins: constants, permanent classification matrix, SKIP LOCKED claim, sanctioned request shape, no pausing",
    () => {
      expect(RELAY_BATCH_SIZE).toBe(50); // A3 discretion default
      expect(RELAY_PASS_EVERY_MS).toBe(5_000);
      expect(DEDUP_TTL_SECONDS).toBe(604800); // D-47: 7 days, named constant
      expect(RELAY_MAX_ATTEMPTS).toBe(3); // D-44 attempt cap
      expect(RELAY_FAILURE_KEY).toBe("_relayFailure");

      // D-45 classification matrix.
      expect(isPermanentTelegramFailure({ ok: false, status: 400, description: "Bad Request: chat not found" })).toBe(true);
      expect(isPermanentTelegramFailure({ ok: false, status: 401, description: "Unauthorized" })).toBe(true);
      expect(isPermanentTelegramFailure({ ok: false, status: 403, description: "Forbidden: bot was blocked by the user" })).toBe(true);
      expect(isPermanentTelegramFailure({ ok: false, status: 429, description: "Too Many Requests: retry after 3" })).toBe(false);
      expect(isPermanentTelegramFailure({ ok: false, status: 500, description: "Internal Server Error" })).toBe(false);
      expect(isPermanentTelegramFailure({ ok: false, description: "Bad Request: chat not found" })).toBe(true);
      expect(isPermanentTelegramFailure({ ok: false, description: "Forbidden: bot was blocked" })).toBe(true);

      // Dedup vocabulary (§16.4 / 01-06).
      expect(dedupKeyFor({ eventType: "incident.down", monitorId: 7, incidentId: "abc" })).toBe("alert:abc:down");
      expect(dedupKeyFor({ eventType: "incident.recovered", monitorId: 7, incidentId: "abc" })).toBe("alert:abc:recovered");
      expect(dedupKeyFor({ eventType: "monitor.first_check", monitorId: 7, incidentId: null })).toBe("alert:7:first_check");

      const source = readFileSync("src/worker/persist/outbox.ts", "utf8");
      // The per-row claim carries the locking clause (Pitfall 4 discipline).
      expect(source).toContain("FOR UPDATE SKIP LOCKED");
      // The sanctioned request shape, copied verbatim from src/lib/telegram.ts.
      expect(source).toContain('parse_mode: "HTML"');
      expect(source).toContain("disable_notification: false");
      expect(source).toContain("api.telegram.org/bot${token}/sendMessage");
      // Dedup written AFTER a confirmed send only — the SET NX EX call sits
      // on the success path, below the send outcome check.
      expect(source).toContain('await redis.set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX")');
      // WR-04: the Telegram exchange is abort-bounded at 10 s inside the
      // per-row FOR UPDATE transaction (undici's default would hang ~300 s
      // on a black-holed connection, past the 30 s idle_in_transaction cap).
      expect(source).toContain("signal: AbortSignal.timeout(10_000)");
      // Never queue pausing anywhere in the relay.
      expect(source).not.toMatch(/\.pause\s*\(/);
    },
    10_000
  );

  it(
    "2. byte parity: all three rendered messages equal the transcribed cron-logic templates character-for-character (D-48)",
    async () => {
      const monitorId = await seedMonitor(testUserId, "relay-parity-monitor");
      const incidentId = await seedIncident(monitorId);
      const downPayload = makePayload();
      const recoveredPayload = makePayload({
        statusCode: 200,
        responseTimeMs: 87,
        errorClass: null,
        monitorName: "relay-parity-monitor",
      });
      const startedPayload = makePayload({
        statusCode: 200,
        responseTimeMs: 42,
        errorClass: null,
        userTimezone: "Asia/Dhaka",
      });
      const ids = [
        await seedOutbox({ monitorId, eventType: "incident.down", incidentId, payload: downPayload }),
        await seedOutbox({ monitorId, eventType: "incident.recovered", incidentId, payload: recoveredPayload }),
        await seedOutbox({ monitorId, eventType: "monitor.first_check", incidentId: null, payload: startedPayload }),
      ];

      const send = okSendMock();
      const result = await runPass(send);
      expect(result.sent).toBe(3);
      expect(send).toHaveBeenCalledTimes(3); // mock seam — zero real Telegram calls

      const sentMessages = send.mock.calls.map((call) => call[1] as string);
      // Character-for-character (toContain of the full string, not
      // stringContaining fragments) against the transcription of
      // cron-logic.ts lines 104-133:
      expect(sentMessages).toContain(expectedMessage("down", downPayload));
      expect(sentMessages).toContain(expectedMessage("recovered", recoveredPayload));
      expect(sentMessages).toContain(expectedMessage("started", startedPayload));

      // The Phase 2 characterization phrases (tests/integration/cron-logic.test.ts
      // lines 257 / 299 / 344) are all present — the bridge to the pinned pins.
      expect(sentMessages.some((m) => m.includes("ALERT: Website Down!"))).toBe(true);
      expect(sentMessages.some((m) => m.includes("RECOVERY: Website Back Online!"))).toBe(true);
      expect(sentMessages.some((m) => m.includes("MONITORING STARTED: Website is Online!"))).toBe(true);

      // All three rows are marked sent, attempts untouched by a clean send.
      for (const id of ids) {
        const row = await fetchOutboxRow(id);
        expect(row?.sent_at).not.toBeNull();
        expect(row?.attempts).toBe(0);
      }

      // The Asia/Dhaka row's Time segment carries that zone's label — the
      // pinned user-timezone routing (cron-logic's monitor.user.timezone).
      const dhakaTime = new Date(OCCURRED_AT).toLocaleString("en-US", {
        timeZone: "Asia/Dhaka",
        timeZoneName: "short",
      });
      expect(sentMessages.some((m) => m.includes(dhakaTime))).toBe(true);
    },
    20_000
  );

  it(
    "2b. byte parity edge: statusCode null renders the No Response / Timeout fallback (D-48)",
    async () => {
      const monitorId = await seedMonitor(testUserId, "relay-parity-monitor");
      const incidentId = await seedIncident(monitorId);
      const payload = makePayload({ statusCode: null, errorClass: "timeout" });
      await seedOutbox({ monitorId, eventType: "incident.down", incidentId, payload });

      // Direct render + full-pass render both pin the fallback line.
      const direct = renderAlertMessage({ eventType: "incident.down", monitorId, incidentId, payload: payload as never });
      expect(direct).toContain('⚠️ <b>Status Code:</b> No Response / Timeout');
      expect(direct).toBe(expectedMessage("down", payload));

      const send = okSendMock();
      await runPass(send);
      expect(send.mock.calls[0][1]).toBe(expectedMessage("down", payload));
    },
    20_000
  );

  it(
    "3. dedup: pre-held key skips the send but still marks the row sent; a confirmed send sets the key with the 7-day TTL (D-47)",
    async () => {
      const monitorId = await seedMonitor(testUserId, "relay-parity-monitor");
      const incidentId = await seedIncident(monitorId);
      const preHeldId = await seedOutbox({ monitorId, eventType: "incident.down", incidentId });
      await admin.set(`alert:${incidentId}:down`, "1", "EX", 3600); // already sent once

      const freshIncidentId = await seedIncident(monitorId, "RESOLVED");
      const freshId = await seedOutbox({ monitorId, eventType: "incident.down", incidentId: freshIncidentId });

      const send = okSendMock();
      const result = await runPass(send);
      expect(result.dedupSkipped).toBe(1);
      expect(result.sent).toBe(1);
      expect(send).toHaveBeenCalledTimes(1); // the pre-held row NEVER dials

      const preHeld = await fetchOutboxRow(preHeldId);
      expect(preHeld?.sent_at).not.toBeNull(); // still marked sent
      expect(preHeld?.attempts).toBe(0);
      const fresh = await fetchOutboxRow(freshId);
      expect(fresh?.sent_at).not.toBeNull();

      // Confirmed send wrote the dedup key with D-47's TTL (7 days).
      const ttl = await admin.ttl(`alert:${freshIncidentId}:down`);
      expect(ttl).toBeGreaterThan(604_000);
      expect(ttl).toBeLessThanOrEqual(604_800);
    },
    20_000
  );

  it(
    "4. SKIP LOCKED: two relay passes in parallel over the same rows — every row sent exactly once (DAT-05)",
    async () => {
      const monitorId = await seedMonitor(testUserId, "shared-batch-monitor");
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        // Each row gets its OWN incident — six rows on one incident would
        // collapse onto one dedup key, and rows 2-6 would prove dedup, not
        // SKIP LOCKED (that IS case 3's job).
        const incidentId = await seedIncident(monitorId, i === 0 ? "ONGOING" : "RESOLVED");
        ids.push(
          await seedOutbox({
            monitorId,
            eventType: "incident.down",
            incidentId,
            payload: makePayload({ monitorName: `row-${i}` }),
          })
        );
      }

      // Slow sends force the two passes to contend for the same rows.
      const sendA = vi.fn(async (_chatId: string, message: string) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { ...OK_SEND };
      });
      const sendB = vi.fn(async (_chatId: string, message: string) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { ...OK_SEND };
      });
      const [passA, passB] = await Promise.allSettled([
        processRelayJob(job(), { redis: admin, send: sendA, logger: fakeLogger() }),
        processRelayJob(job(), { redis: admin, send: sendB, logger: fakeLogger() }),
      ]);
      expect(passA.status).toBe("fulfilled");
      expect(passB.status).toBe("fulfilled");

      // Exactly six sends total; each row's distinct name appears exactly once.
      const allMessages = [...sendA.mock.calls, ...sendB.mock.calls].map((c) => c[1] as string);
      expect(allMessages).toHaveLength(6);
      for (let i = 0; i < 6; i += 1) {
        const hits = allMessages.filter((m) => m.includes(`row-${i}\n`)).length;
        expect(hits).toBe(1);
      }
      // And every row is marked sent.
      for (const id of ids) {
        const row = await fetchOutboxRow(id);
        expect(row?.sent_at).not.toBeNull();
      }
    },
    20_000
  );

  it(
    "5. transient: fail twice then succeed — row sent with attempts recorded 2",
    async () => {
      const monitorId = await seedMonitor(testUserId, "relay-transient-monitor");
      const incidentId = await seedIncident(monitorId);
      const rowId = await seedOutbox({ monitorId, eventType: "incident.down", incidentId });

      const send = vi.fn();
      send.mockResolvedValueOnce({ ok: false, status: 502, description: "Bad Gateway" });
      send.mockResolvedValueOnce({ ok: false, status: 503, description: "Service Unavailable" });
      send.mockResolvedValueOnce({ ...OK_SEND });

      // Pass 1 and 2 fail transiently — the pass throws for BullMQ backoff.
      await expect(runPass(send)).rejects.toThrow(/transient send failure/);
      await expect(runPass(send)).rejects.toThrow(/transient send failure/);
      const midRow = await fetchOutboxRow(rowId);
      expect(midRow?.sent_at).toBeNull();
      expect(midRow?.attempts).toBe(2);

      // Pass 3 succeeds: sent, attempts stays 2, no terminal marker.
      const result = await runPass(send);
      expect(result.sent).toBe(1);
      const row = await fetchOutboxRow(rowId);
      expect(row?.sent_at).not.toBeNull();
      expect(row?.attempts).toBe(2);
      expect(row?.payload).not.toHaveProperty(RELAY_FAILURE_KEY);
      expect(send).toHaveBeenCalledTimes(3);
    },
    20_000
  );

  it(
    "6. three transient failures — FAILED + retained (attempts=3, marker), error log, failed gauge, never re-claimed (D-44)",
    async () => {
      const monitorId = await seedMonitor(testUserId, "relay-terminal-monitor");
      const incidentId = await seedIncident(monitorId);
      const rowId = await seedOutbox({ monitorId, eventType: "incident.down", incidentId });

      const send = vi.fn(async () => ({ ok: false, status: 500, description: "Internal Server Error" }));
      const logger = fakeLogger();

      // Two retryable failures, then the terminal third.
      await expect(runPass(send, logger)).rejects.toThrow(/transient send failure/);
      await expect(runPass(send, logger)).rejects.toThrow(/transient send failure/);
      // The third failure is TERMINAL: the row is dead, so the pass itself
      // completes — nothing is left to retry (D-44: no auto-retry past cap).
      const terminalResult = await runPass(send, logger);
      expect(terminalResult.transientFailed).toBe(1);
      expect(terminalResult.terminalFailed).toBe(1);

      const row = await fetchOutboxRow(rowId);
      expect(row).toBeDefined(); // retained, never deleted
      expect(UUID_RE.test(row!.id)).toBe(true);
      expect(row!.sent_at).toBeNull();
      expect(row!.attempts).toBe(3);
      const marker = row!.payload[RELAY_FAILURE_KEY] as { classification?: string; lastError?: string };
      expect(marker.classification).toBe("transient_exhausted");
      expect(marker.lastError).toContain("Internal Server Error");

      // Exactly one error-level line per terminal failure (D-44).
      const errorLines = logger.error.mock.calls.filter((c) => String(c[1]).includes("FAILED after exhausting attempts"));
      expect(errorLines).toHaveLength(1);

      // The failed-count gauge sees it.
      const metrics = await collectOutboxMetrics();
      expect(metrics.failed).toBe(1);
      expect(metrics.unsent).toBe(0);

      // A fourth pass never re-claims the dead row.
      const fourth = await runPass(send, logger);
      expect(fourth.candidates).toBe(0);
      expect(send).toHaveBeenCalledTimes(3);
    },
    20_000
  );

  it(
    "7. permanent 400 — immediate FAILED with attempts < 3, UnrecoverableError, no retries burned (D-45)",
    async () => {
      const monitorId = await seedMonitor(testUserId, "relay-permanent-monitor");
      const incidentId = await seedIncident(monitorId);
      const rowId = await seedOutbox({ monitorId, eventType: "incident.down", incidentId });

      const send = vi.fn(async (_chatId: string, _message: string): Promise<RelaySendOutcome> => ({
        ok: false,
        status: 400,
        description: "Bad Request: chat not found",
      }));
      const logger = fakeLogger();

      // The pass itself throws UnrecoverableError — straight to the DLQ,
      // never a backoff (D-45).
      await expect(runPass(send, logger)).rejects.toMatchObject({ name: "UnrecoverableError" });

      const row = await fetchOutboxRow(rowId);
      expect(row?.sent_at).toBeNull();
      expect(row!.attempts).toBeLessThan(3); // failed FAST — retries not burned
      const marker = row!.payload[RELAY_FAILURE_KEY] as { classification?: string };
      expect(marker.classification).toBe("permanent");

      // Exactly one error-level line (D-44).
      const errorLines = logger.error.mock.calls.filter((c) => String(c[1]).includes("PERMANENT telegram failure"));
      expect(errorLines).toHaveLength(1);

      // A fresh 403-class row dead-letters through the same UnrecoverableError
      // door (the status-only classification path).
      const row2Id = await seedOutbox({
        monitorId,
        eventType: "incident.down",
        incidentId: await seedIncident(monitorId, "RESOLVED"),
      });
      await expect(
        runPass(
          vi.fn(async (_chatId: string, _message: string): Promise<RelaySendOutcome> => ({
            ok: false,
            status: 403,
            description: "Forbidden: bot was blocked by the user",
          })),
          fakeLogger()
        )
      ).rejects.toMatchObject({ name: "UnrecoverableError" });
      const row2 = await fetchOutboxRow(row2Id);
      expect(row2!.attempts).toBeLessThan(3);
      expect((row2!.payload[RELAY_FAILURE_KEY] as { classification?: string }).classification).toBe("permanent");
    },
    20_000
  );

  it(
    "8. CR-03: a down row with NULL incident_id is dead-lettered, never interpolated into a collision key",
    async () => {
      const monitorId = await seedMonitor(testUserId, "relay-cr03-monitor");
      const rowId = await seedOutbox({ monitorId, eventType: "incident.down", incidentId: null });

      const send = okSendMock();
      const logger = fakeLogger();
      await expect(runPass(send, logger)).rejects.toMatchObject({ name: "UnrecoverableError" });

      expect(send).not.toHaveBeenCalled(); // never dialed, never a alert:null:* key
      expect(await admin.exists("alert:null:down")).toBe(0);
      const row = await fetchOutboxRow(rowId);
      expect(row?.sent_at).toBeNull();
      const marker = row!.payload[RELAY_FAILURE_KEY] as { classification?: string; lastError?: string };
      expect(marker.classification).toBe("contract_violation");
      expect(marker.lastError).toContain("CR-03");
      expect(row!.attempts).toBe(1);
    },
    20_000
  );

  it(
    "9. no telegramChatId on the owner — row handled and marked sent with no send (cron parity)",
    async () => {
      const monitorId = await seedMonitor(chatlessUserId, "relay-chatless-monitor");
      const rowId = await seedOutbox({ monitorId, eventType: "incident.down", incidentId: await seedIncident(monitorId) });

      const send = okSendMock();
      const result = await runPass(send);
      expect(result.noChatSkipped).toBe(1);
      expect(send).not.toHaveBeenCalled();
      const row = await fetchOutboxRow(rowId);
      expect(row?.sent_at).not.toBeNull();
    },
    20_000
  );

  it(
    "10. gauges: unsent/failed counts + transition-to-alert latency on collectOutboxMetrics AND /metrics.json (D-24/D-25/D-44)",
    async () => {
      const monitorId = await seedMonitor(testUserId, "relay-metrics-monitor");
      const incidentId = await seedIncident(monitorId);
      // One sent row: created 10 s ago, sent 5 s ago -> a 5 s latency sample.
      await seedOutbox({
        monitorId,
        eventType: "incident.down",
        incidentId,
        sentAt: new Date(Date.now() - 5_000).toISOString(),
        createdAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await seedOutbox({ monitorId, eventType: "incident.recovered", incidentId });
      await seedOutbox({
        monitorId,
        eventType: "incident.down",
        incidentId: await seedIncident(monitorId, "RESOLVED"),
        attempts: 3,
        payload: { [RELAY_FAILURE_KEY]: { classification: "transient_exhausted", lastError: "x", failedAt: "2026-09-14T00:00:00Z" } },
      });

      const metrics = await collectOutboxMetrics();
      expect(metrics.unsent).toBe(1); // the pending recovered row only
      expect(metrics.failed).toBe(1);
      expect(metrics.latency.sample).toBe(1);
      expect(metrics.latency.avgMs).toBeGreaterThanOrEqual(4_900);
      expect(metrics.latency.avgMs).toBeLessThanOrEqual(5_100);
      expect(metrics.latency.p50Ms).toBe(metrics.latency.avgMs);
      expect(metrics.latency.maxMs).toBe(metrics.latency.avgMs);
      // OBS-03 gauge input: the one pending row's age (seeded created_at
      // ~now, so a small non-negative double).
      expect(metrics.oldestUnsentSeconds).not.toBeNull();
      expect(metrics.oldestUnsentSeconds!).toBeGreaterThanOrEqual(0);
      expect(metrics.oldestUnsentSeconds!).toBeLessThan(10);

      // The health surface: /metrics.json carries the outbox section via the
      // 04-07 outboxMetrics provider (additive merge, same as queueMetrics).
      // Restore the REAL fetch first — this case's assertions hit the health
      // endpoint over loopback HTTP (no Telegram egress is possible anyway:
      // the relay is not run in this case).
      vi.unstubAllGlobals();
      const healthRedis = new Redis(process.env.REDIS_URL!);
      const server = await startHealthServer({
        port: 0,
        redis: healthRedis,
        pool: { query: (text: string) => pg.query(text) },
        // Same wrapping index.ts applies (Task 2): the provider returns the
        // SECTION object — {outbox: {...}} — and the endpoint merges its keys.
        outboxMetrics: async () => ({ outbox: await collectOutboxMetrics() }),
      });
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/metrics.json`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { outbox: typeof metrics };
        expect(body.outbox.unsent).toBe(1);
        expect(body.outbox.failed).toBe(1);
        expect(body.outbox.latency.sample).toBe(1);
        // The health surface carries the OBS-03 gauge input additively.
        expect(typeof body.outbox.oldestUnsentSeconds).toBe("number");
        expect(body.outbox.oldestUnsentSeconds as number).toBeGreaterThanOrEqual(0);
      } finally {
        await server.shutdown();
        await healthRedis.quit(); // passed explicitly => NOT owned by the server
      }
    },
    20_000
  );

  it(
    "11. WR-04: telegramSend aborts a black-holed connection at ~10 s; the relay classifies the timeout TRANSIENT — attempts advance, claim transaction completes, row re-claimable",
    async () => {
      // (a) The send seam itself, dialed directly: a server that accepts the
      // connection and never responds. The stub honors ONLY the abort signal
      // — the exact black-hole undici would sit on for its ~300 s default
      // without WR-04's bound (the relay holds the row's FOR UPDATE
      // transaction across this await; the 30 s idle_in_transaction cap is
      // the hard ceiling the 10 s bound must stay well under).
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: unknown, init: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(new Error("The operation was aborted due to timeout"))
              );
            })
        )
      );
      const startedAt = Date.now();
      await expect(telegramSend("555000111", "⏳ black-hole probe")).rejects.toThrow(/abort/i);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(9_000); // it genuinely waited for the bound...
      expect(elapsed).toBeLessThan(15_000); // ...which fires at ~10 s (slack for CI jitter)

      // (b) Relay-level: a timed-out send is TRANSIENT (D-45 — timeout is
      // not in the permanent enumeration). The send mock rejects immediately
      // with the timeout-shaped error the real path now throws; the pass must
      // complete the per-row mark-failure path (attempts advance — WR-04's
      // "invisible to the attempts accounting" complaint) and release the
      // row's FOR UPDATE lock so the NEXT pass can claim it.
      const monitorId = await seedMonitor(testUserId, "relay-wr04-monitor");
      const incidentId = await seedIncident(monitorId);
      const rowId = await seedOutbox({ monitorId, eventType: "incident.down", incidentId });

      const timedOut = vi.fn(async (): Promise<RelaySendOutcome> => {
        throw new Error("The operation was aborted due to timeout");
      });
      const logger = fakeLogger();
      await expect(runPass(timedOut, logger)).rejects.toThrow(/transient send failure/);

      const row = await fetchOutboxRow(rowId);
      expect(row?.sent_at).toBeNull();
      expect(row?.attempts).toBe(1); // the timeout ADVANCED attempts
      expect(row?.payload).not.toHaveProperty(RELAY_FAILURE_KEY); // not terminal
      expect(logger.warn).toHaveBeenCalled(); // transient warn line, not the terminal error line

      // No orphaned FOR UPDATE row: a follow-up pass with a healthy send
      // claims the same row and delivers — proof the failed transaction
      // committed its mark-failure and released the lock.
      const send = okSendMock();
      const result = await runPass(send);
      expect(result.sent).toBe(1);
      const sent = await fetchOutboxRow(rowId);
      expect(sent?.sent_at).not.toBeNull();
      expect(sent?.attempts).toBe(1); // the clean send does not increment
    },
    30_000
  );

  it(
    "12. OBS-03 gauge: oldestUnsentSeconds — oldest unsent non-FAILED age; null when none; -1 on query failure (Pitfall 7)",
    async () => {
      // Nothing unsent: null (the queue gauge's oldestWaitingJobAgeMs
      // convention — "no pending work" is null, not 0).
      const empty = await collectOutboxMetrics();
      expect(empty.unsent).toBe(0);
      expect(empty.oldestUnsentSeconds).toBeNull();

      // Three rows, only ONE of which the gauge may read: a FAILED row 10
      // minutes old (attempts at cap — excluded), a sent row 5 minutes old
      // (sent_at set — excluded), and a pending row 90 s old (THE input).
      const monitorId = await seedMonitor(testUserId, "relay-age-monitor");
      const failedRowIncident = await seedIncident(monitorId, "RESOLVED");
      const sentRowIncident = await seedIncident(monitorId, "RESOLVED");
      const pendingIncident = await seedIncident(monitorId); // ONGOING — the monitor's first
      await seedOutbox({
        monitorId,
        eventType: "incident.down",
        incidentId: failedRowIncident,
        attempts: RELAY_MAX_ATTEMPTS, // derived FAILED — excluded from the gauge
        createdAt: new Date(Date.now() - 600_000).toISOString(),
      });
      await seedOutbox({
        monitorId,
        eventType: "incident.down",
        incidentId: sentRowIncident,
        sentAt: new Date(Date.now() - 290_000).toISOString(),
        createdAt: new Date(Date.now() - 300_000).toISOString(),
      });
      await seedOutbox({
        monitorId,
        eventType: "incident.down",
        incidentId: pendingIncident,
        createdAt: new Date(Date.now() - 90_000).toISOString(),
      });

      const metrics = await collectOutboxMetrics();
      expect(metrics.unsent).toBe(1);
      expect(metrics.oldestUnsentSeconds).not.toBeNull();
      expect(metrics.oldestUnsentSeconds!).toBeGreaterThanOrEqual(89); // tolerance ±1 s
      expect(metrics.oldestUnsentSeconds!).toBeLessThanOrEqual(95);

      // Query failure: -1 (visible, never fatal — the 690-696 degradation
      // pattern), with the rest of the snapshot still resolving.
      const failingDb = {
        execute: async () => {
          throw new Error("simulated collector outage");
        },
      } as unknown as Parameters<typeof collectOutboxMetrics>[0];
      const degraded = await collectOutboxMetrics(failingDb);
      expect(degraded.unsent).toBe(-1);
      expect(degraded.failed).toBe(-1);
      expect(degraded.oldestUnsentSeconds).toBe(-1);
      expect(degraded.latency.sample).toBe(0);
      expect(degraded.latency.avgMs).toBeNull();
    },
    20_000
  );
});
