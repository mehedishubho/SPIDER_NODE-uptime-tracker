import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import "./_harness";
import {
  buildRequest,
  dbLog,
  dbState,
  h,
  mockSession,
  resetDbMocks,
  sessionA,
  USER_A_ID,
  USER_B_ID,
} from "./_harness";
import { MockLanguageModelV4 } from "ai/test";

// ---------------------------------------------------------------------------
// Post-mortem evidence suite (08-10 Task 1 — AI-03 route slice):
//   1. IDOR (T-08-19) — a foreign monitorId answers 404 with ZERO evidence
//      queries; the ownership WHERE carries BOTH the monitor id and the
//      session userId (scoping proven at the value level).
//   2. D-15 incident-scoped evidence — monitor -> incident -> bounded pings
//      window, each chained through the ownership-verified monitor.
//   3. D-14 — the stub-captured instructions passed to streamText name the
//      four report sections verbatim IN ORDER: Summary, Timeline, Impact,
//      Possible causes.
//   4. D-13 — ZERO DB writes on every request path (dbLog has no
//      insert/update/delete op anywhere; the AI route has no write path).
//   5. D-10 — exactly one structured log line per request carrying
//      feature/userId/model/tokens/duration — NEVER prompt bodies or URLs
//      (V8 discipline, T-04-28 lineage).
//   6. T-08-15 — DB strings enter the prompt as DELIMITED DATA, never as
//      instructions.
//
// The model rides the @/lib/ai seam (getAiModel -> a MockLanguageModelV4
// stub fed through the REAL ai package's streamText), so no network or key
// is ever needed. Same seam layout as ai-routes.handler.test.ts (see that
// file's header for the mock discipline notes).
// ---------------------------------------------------------------------------

const seams = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  getAiModel: vi.fn(),
  streamTextCalls: [] as Array<Record<string, unknown>>,
  responseCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: seams.rateLimit }));

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  return { ...actual, getAiModel: seams.getAiModel };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (options: Parameters<typeof actual.streamText>[0]) => {
      seams.streamTextCalls.push(options as unknown as Record<string, unknown>);
      return actual.streamText(options);
    },
    createUIMessageStreamResponse: (
      options: Parameters<typeof actual.createUIMessageStreamResponse>[0],
    ) => {
      seams.responseCalls.push(options as unknown as Record<string, unknown>);
      return actual.createUIMessageStreamResponse(options);
    },
  };
});

const PATH = "/api/ai/post-mortem";
const MONITOR_ID = 7;
const INCIDENT_ID = "11111111-2222-4333-8444-555555555555";

const monitorRow = {
  id: MONITOR_ID,
  name: "Payments API prod",
  url: "https://payments.example.test/health",
  interval: 5,
  userId: USER_A_ID,
};

const incidentRow = {
  id: INCIDENT_ID,
  monitorId: MONITOR_ID,
  status: "RESOLVED",
  description: "Elevated 5xx rate after deploy 42",
  startedAt: "2026-09-30 10:00:00.000",
  resolvedAt: "2026-09-30 10:05:00.000",
};

const pingRows = [
  { status: "UP", responseTime: 120, statusCode: 200, errorClass: null, createdAt: "2026-09-30 09:58:00.000" },
  { status: "DOWN", responseTime: 0, statusCode: 503, errorClass: "http_5xx", createdAt: "2026-09-30 10:00:30.000" },
  { status: "DOWN", responseTime: 0, statusCode: 503, errorClass: "http_5xx", createdAt: "2026-09-30 10:01:30.000" },
  { status: "UP", responseTime: 130, statusCode: 200, errorClass: null, createdAt: "2026-09-30 10:05:10.000" },
];

function aiBody(): Record<string, unknown> {
  return { monitorId: MONITOR_ID, incidentId: INCIDENT_ID };
}

/**
 * A stub LanguageModel fed through the REAL streamText: emits one text part
 * with V4-spec usage so the onEnd -> D-10 log path carries real numbers.
 */
function makeStubModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Generated post-mortem text." });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: { total: 12 }, outputTokens: { total: 34 }, totalTokens: 46 },
          });
          controller.close();
        },
      }),
    }),
  });
}

/**
 * Recursively collects the RAW leaf values of a drizzle SQL object (params
 * are stored raw beside StringChunk template text — 06-06 finding), so a
 * WHERE clause's bound values are assertable: toContain(userId) etc.
 */
function deepSqlValues(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) deepSqlValues(child, out);
    return out;
  }
  if (node !== null && typeof node === "object") {
    if (node.constructor?.name === "StringChunk") return out; // template text, not a value
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) deepSqlValues(chunks, out);
    return out; // Column descriptors and SQL wrappers carry no bound values themselves
  }
  out.push(node);
  return out;
}

const AI_ENV_UNDER_TEST = ["AI_ENABLED", "AI_TIMEOUT_MS", "AI_MODEL"] as const;

let consoleInfo: MockInstance | undefined;
let consoleError: MockInstance | undefined;

beforeEach(() => {
  vi.resetModules();
  for (const key of AI_ENV_UNDER_TEST) delete process.env[key];
  process.env.AI_ENABLED = "true"; // this suite is the flag-ON evidence leg
  process.env.AI_MODEL = "glm-4.6-test"; // deterministic D-10 model field
  mockSession(sessionA);
  resetDbMocks();
  seams.rateLimit.mockReset();
  seams.rateLimit.mockResolvedValue({ success: true, remaining: 9, resetSeconds: 30 });
  seams.getAiModel.mockReset();
  seams.getAiModel.mockReturnValue(makeStubModel());
  seams.streamTextCalls.length = 0;
  seams.responseCalls.length = 0;
  consoleInfo?.mockRestore();
  consoleError?.mockRestore();
  consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleInfo?.mockRestore();
  consoleError?.mockRestore();
  for (const key of AI_ENV_UNDER_TEST) delete process.env[key];
});

/** Re-imports the route against the freshly reset module registry. */
async function loadRoute() {
  return import("@/app/api/ai/post-mortem/route");
}

/** Queues the happy-path evidence fixtures (monitor, incident, pings). */
function queueHappyPath() {
  dbState.results = [[monitorRow], [incidentRow], [pingRows]];
}

describe("POST /api/ai/post-mortem — ownership + evidence assembly", () => {
  it("foreign monitor -> 404 with ZERO evidence queries (IDOR, T-08-19)", async () => {
    dbState.results = [[]]; // the ownership read finds nothing for this user
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Monitor not found" });
    // Exactly ONE query ran — the ownership read. No incident, no pings.
    expect(dbLog).toHaveLength(1);
    expect(dbLog[0].op).toBe("select");
    expect(seams.getAiModel).not.toHaveBeenCalled();
  });

  it("the ownership WHERE carries BOTH the monitor id and the session userId (value-level scoping)", async () => {
    dbState.results = [[], null, null];
    const { POST } = await loadRoute();

    await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    expect(dbLog[0].calls.map((c) => c.method)).toEqual(["from", "where"]);
    const whereArg = dbLog[0].calls.find((c) => c.method === "where")?.args[0];
    const values = deepSqlValues(whereArg);
    expect(values).toContain(MONITOR_ID);
    expect(values).toContain(USER_A_ID);
    expect(values).not.toContain(USER_B_ID);
  });

  it("happy path: incident-scoped evidence (D-15) — monitor, then incident by id+monitorId, then the bounded pings window", async () => {
    queueHappyPath();
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    expect(res.status).toBe(200);
    await res.text(); // drain the stream so callbacks flush

    // Three reads, all selects, in the ownership-first order.
    expect(dbLog.map((e) => e.op)).toEqual(["select", "select", "select"]);
    expect(dbLog[0].calls[0].args[0]).toHaveProperty("name", "monitors"); // monitor identity read first

    // The incident read is scoped by BOTH the requested incidentId AND the
    // ownership-verified monitorId — never by incidentId alone.
    const incidentWhere = dbLog[1].calls.find((c) => c.method === "where")?.args[0];
    const incidentValues = deepSqlValues(incidentWhere);
    expect(incidentValues).toContain(INCIDENT_ID);
    expect(incidentValues).toContain(MONITOR_ID);

    // The pings read is the bounded window: scoped to the monitor, ordered
    // oldest-first, hard-capped (lead-in + window bounds live in SQL).
    const pingsChain = dbLog[2].calls.map((c) => c.method);
    expect(pingsChain).toEqual(["from", "where", "orderBy", "limit"]);
    const pingsWhere = dbLog[2].calls.find((c) => c.method === "where")?.args[0];
    expect(deepSqlValues(pingsWhere)).toContain(MONITOR_ID);
    const pingsLimit = dbLog[2].calls.find((c) => c.method === "limit")?.args[0];
    expect(pingsLimit).toBe(50);
  });

  it("incident not found for this monitor -> 404 (evidence is incident-scoped, never cross-monitor)", async () => {
    dbState.results = [[monitorRow], []];
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Incident not found" });
    expect(dbLog).toHaveLength(2); // no pings query after the incident miss
    expect(seams.getAiModel).not.toHaveBeenCalled();
  });

  it("malformed ids -> 400 before ANY query (manual validation, typed-error split discipline)", async () => {
    const { POST } = await loadRoute();

    for (const body of [
      { monitorId: "not-a-number", incidentId: INCIDENT_ID },
      { monitorId: MONITOR_ID },
      { incidentId: INCIDENT_ID },
      { monitorId: -1, incidentId: INCIDENT_ID },
      { monitorId: 1.5, incidentId: INCIDENT_ID },
    ]) {
      const res = await POST(buildRequest({ path: PATH, method: "POST", body }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "monitorId (number) and incidentId (string) are required",
      });
    }
    expect(h.db.select).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/post-mortem — D-14 report structure + D-13/D-10 discipline", () => {
  it("the stub-captured instructions name the four D-14 sections verbatim IN ORDER", async () => {
    queueHappyPath();
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));
    await res.text();

    expect(seams.streamTextCalls).toHaveLength(1);
    const options = seams.streamTextCalls[0];
    expect(typeof options.instructions).toBe("string");
    const instructions = options.instructions as string;
    const summaryIdx = instructions.indexOf("Summary");
    const timelineIdx = instructions.indexOf("Timeline");
    const impactIdx = instructions.indexOf("Impact");
    const causesIdx = instructions.indexOf("Possible causes");
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(timelineIdx).toBeGreaterThan(summaryIdx);
    expect(impactIdx).toBeGreaterThan(timelineIdx);
    expect(causesIdx).toBeGreaterThan(impactIdx);
    // The D-14 Timeline gloss: down detection -> duration -> recovery.
    expect(instructions).toContain("down detection");
    expect(instructions).toContain("duration");
    expect(instructions).toContain("recovery");
  });

  it("DB strings enter the prompt as DELIMITED DATA, never as instructions (T-08-15)", async () => {
    queueHappyPath();
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));
    await res.text();

    const options = seams.streamTextCalls[0];
    const prompt = options.prompt as string;
    expect(typeof prompt).toBe("string");
    expect(prompt).not.toBe(options.instructions); // evidence and rules never merge
    // Delimited evidence blocks carrying the real monitor/incident/ping data.
    expect(prompt).toContain("<evidence>");
    expect(prompt).toContain("</evidence>");
    expect(prompt).toContain(monitorRow.name);
    expect(prompt).toContain(monitorRow.url);
    expect(prompt).toContain(String(monitorRow.interval));
    expect(prompt).toContain(incidentRow.description);
    expect(prompt).toContain("http_5xx"); // ping rows render their error classes
    // The instructions side states the data discipline.
    expect((options.instructions as string).toLowerCase()).toContain("untrusted data");
  });

  it("D-13: ZERO DB writes on every request path (the AI route has no write path at all)", async () => {
    const { POST } = await loadRoute();

    // Happy path (drains the stream).
    queueHappyPath();
    await (await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }))).text();

    // 401 path.
    mockSession(null);
    await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    // Foreign-monitor 404 path.
    mockSession(sessionA);
    dbState.results = [[]];
    await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    // 429 path.
    seams.rateLimit.mockResolvedValue({ success: false, remaining: 0, resetSeconds: 30 });
    await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    // 413 over-cap path.
    seams.rateLimit.mockResolvedValue({ success: true, remaining: 9, resetSeconds: 30 });
    await POST(
      buildRequest({
        path: PATH,
        method: "POST",
        body: "x".repeat(4000), // raw oversized body as a JSON string value
      }),
    );

    const writeOps = dbLog.filter((entry) => entry.op !== "select");
    expect(writeOps).toEqual([]);
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  it("D-10: exactly one structured log line — feature/userId/model/tokens/duration; NEVER prompt bodies or URLs", async () => {
    queueHappyPath();
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 30)); // let onEnd flush

    const requestLines = consoleInfo!.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[ai-request]"));
    expect(requestLines).toHaveLength(1);

    const payload = JSON.parse(requestLines[0].slice("[ai-request] ".length));
    expect(payload).toMatchObject({
      feature: "post-mortem",
      userId: USER_A_ID,
      model: "glm-4.6-test",
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    });
    expect(typeof payload.durationMs).toBe("number");

    // V8 discipline (T-04-28 lineage): the line carries ids/counts/tokens
    // only — no prompt bodies, no URLs, no monitor names.
    expect(requestLines[0]).not.toContain(monitorRow.name);
    expect(requestLines[0]).not.toContain(monitorRow.url);
    expect(requestLines[0]).not.toContain("https://");
    expect(requestLines[0]).not.toContain(incidentRow.description);
  });
});
