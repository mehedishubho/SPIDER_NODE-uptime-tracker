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
} from "./_harness";
import { MockLanguageModelV4 } from "ai/test";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Monitor-assistant suite (08-07 Task 2 — AI-04 route slice):
//   1. The shared 08-10 guard chain with the assistant's OWN bucket —
//      ai_assistant_{userId} at 20/h (D-08), 429 + Retry-After (06 D-06);
//      flag-off 404 BEFORE the body is read (D-21); 401 identity-first
//      (Pitfall 8 — never an IP key); input cap 413 (A4); malformed JSON 400.
//   2. The output schema mirrors the create-form field set EXACTLY (AI-04):
//      name string, url string, interval literal union 1|5|10|30|60.
//   3. The response is a TEXT stream of partial JSON (useObject-compatible —
//      the client parses chunked JSON text; never SSE here).
//   4. D-13: zero DB writes on EVERY path (the route has no write path);
//      D-10: the one structured log line with feature "assistant".
//
// Same seam layout as ai-routes.handler.test.ts / ai-stream.handler.test.ts
// (hoisted seams, lazy factories, per-case vi.resetModules + dynamic import).
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
    createTextStreamResponse: (
      options: Parameters<typeof actual.createTextStreamResponse>[0],
    ) => {
      seams.responseCalls.push(options as unknown as Record<string, unknown>);
      return actual.createTextStreamResponse(options);
    },
  };
});

const PATH = "/api/ai/monitor-assistant";

function assistantBody(description = "Watch my portfolio site every 5 minutes"): Record<string, unknown> {
  return { description };
}

/** Raw-string POST (the input-cap cases need exact byte control). */
function postRaw(raw: string): NextRequest {
  return new NextRequest(`http://localhost${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

/**
 * POST whose body is a read-tracking ReadableStream — proves the flag-off
 * 404 is issued BEFORE the body is read (D-21), mirroring the post-mortem
 * suite's pin. (Node webstreams prime one pull below HWM at construction;
 * only the SECOND pull — a real consumer draining — counts as a read.)
 */
function postWithTrackingBody(): { req: Request; wasRead: () => boolean } {
  let pulls = 0;
  let read = false;
  const chunk = new TextEncoder().encode(JSON.stringify(assistantBody()));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(chunk); // the priming pull — fills HWM, no consumer
        return;
      }
      read = true; // only reachable after a real consumer drained the chunk
      controller.close();
    },
  });
  const req = new Request(`http://localhost${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { req, wasRead: () => read };
}

/** A stub model streaming the assistant's partial JSON as text deltas. */
function makeAssistantModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: '{"name":"My Portfolio Site","url":"https://example.com/portfolio",' });
          controller.enqueue({ type: "text-delta", id: "t1", delta: '"interval":5}' });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 24, text: 24, reasoning: undefined },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

const AI_ENV_UNDER_TEST = ["AI_ENABLED", "AI_TIMEOUT_MS", "AI_MODEL"] as const;

let consoleInfo: MockInstance | undefined;
let consoleError: MockInstance | undefined;

beforeEach(() => {
  vi.resetModules();
  for (const key of AI_ENV_UNDER_TEST) delete process.env[key]; // flag OFF is the default posture
  mockSession(null);
  resetDbMocks();
  seams.rateLimit.mockReset();
  seams.rateLimit.mockResolvedValue({ success: true, remaining: 19, resetSeconds: 30 });
  seams.getAiModel.mockReset();
  seams.getAiModel.mockReturnValue(makeAssistantModel()); // guarded streams never touch a real provider
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
  return import("@/app/api/ai/monitor-assistant/route");
}

function assertZeroDbWrites() {
  expect(dbLog.filter((entry) => entry.op !== "select")).toEqual([]);
  expect(h.db.insert).not.toHaveBeenCalled();
  expect(h.db.update).not.toHaveBeenCalled();
  expect(h.db.delete).not.toHaveBeenCalled();
}

describe("POST /api/ai/monitor-assistant — guard chain with the assistant bucket", () => {
  it("flag off (AI_ENABLED unset) -> 404 BEFORE the body is read — zero surface to probe (D-21)", async () => {
    const { POST } = await loadRoute();

    const { req, wasRead } = postWithTrackingBody();
    const res = await POST(req);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not Found" });
    expect(wasRead()).toBe(false);
    expect(h.getServerSession).not.toHaveBeenCalled();
    expect(seams.rateLimit).not.toHaveBeenCalled();
    expect(seams.getAiModel).not.toHaveBeenCalled();
    assertZeroDbWrites();
  });

  it("flag on + no session -> 401 (identity BEFORE the limiter — Pitfall 8)", async () => {
    process.env.AI_ENABLED = "true";
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: assistantBody() }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(seams.rateLimit).not.toHaveBeenCalled();
    assertZeroDbWrites();
  });

  it("over-limit user -> 429 with the numeric Retry-After from resetSeconds (06 D-06 shape)", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    seams.rateLimit.mockResolvedValue({ success: false, remaining: 0, resetSeconds: 45 });
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: assistantBody() }));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "Too many AI requests — try again later." });
    expect(res.headers.get("Retry-After")).toBe("45");
    assertZeroDbWrites();
  });

  it("limiter key is the assistant's OWN per-user bucket (ai_assistant_{userId}, 20/h — D-08), never the IP", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    const { POST } = await loadRoute();

    const res = await POST(
      buildRequest({ path: PATH, method: "POST", body: assistantBody(), ip: "203.0.113.9" }),
    );

    expect(seams.rateLimit).toHaveBeenCalledTimes(1);
    const [identifier, options] = seams.rateLimit.mock.calls[0];
    expect(identifier).toBe(`ai_assistant_${USER_A_ID}`);
    expect(identifier).not.toContain("203.0.113.9");
    expect(options).toEqual({ limit: 20, windowMs: 3_600_000 });
    // The stub model's stream is consumed to completion by res.text() below.
    await res.text();
  });

  it("input cap pinned at BOTH sides (A4): exactly at the cap passes; one char over -> the documented 413", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    const { AI_INPUT_MAX_CHARS } = await import("@/lib/ai/guards");
    const { POST } = await loadRoute();

    const base = JSON.stringify(assistantBody());
    const padTo = (n: number) => base + " ".repeat(n - base.length); // trailing whitespace is valid JSON

    dbState.results = [[]];
    const atCap = await POST(postRaw(padTo(AI_INPUT_MAX_CHARS)));
    expect(atCap.status).toBe(200); // guard passed; the route streamed
    await atCap.text();

    const over = await POST(postRaw(padTo(AI_INPUT_MAX_CHARS + 1)));
    expect(over.status).toBe(413);
    const body = (await over.json()) as { error: string };
    expect(body.error).toContain("too large");
    expect(body.error).toContain(String(AI_INPUT_MAX_CHARS));
    assertZeroDbWrites();
  });

  it("malformed JSON body -> 400; a missing/empty description -> 400 before ANY AI work", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    const { POST } = await loadRoute();

    const malformed = await POST(postRaw("{not json"));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "Invalid JSON body" });

    const missing = await POST(buildRequest({ path: PATH, method: "POST", body: {} }));
    expect(missing.status).toBe(400);

    const empty = await POST(
      buildRequest({ path: PATH, method: "POST", body: assistantBody("   ") }),
    );
    expect(empty.status).toBe(400);

    expect(seams.getAiModel).not.toHaveBeenCalled();
    assertZeroDbWrites();
  });
});

describe("POST /api/ai/monitor-assistant — schema + streaming contract (AI-04/D-07)", () => {
  it("the output schema mirrors the create-form field set EXACTLY (AI-04)", async () => {
    const { ASSISTANT_SCHEMA } = await loadRoute();

    // Exactly the three create-form fields — nothing more, nothing less.
    expect(Object.keys(ASSISTANT_SCHEMA.shape).sort()).toEqual(["interval", "name", "url"]);

    // name/url: strings (the create route re-validates them on submit).
    expect(ASSISTANT_SCHEMA.shape.name.safeParse("My Site").success).toBe(true);
    expect(ASSISTANT_SCHEMA.shape.name.safeParse(42).success).toBe(false);
    expect(ASSISTANT_SCHEMA.shape.url.safeParse("https://example.com").success).toBe(true);
    expect(ASSISTANT_SCHEMA.shape.url.safeParse(undefined).success).toBe(false);

    // interval: the literal union of the form's option values — 7 never
    // validates (the D-19 manual-entry hint path), nor "5" (type-strict).
    for (const value of [1, 5, 10, 30, 60]) {
      expect(ASSISTANT_SCHEMA.shape.interval.safeParse(value).success).toBe(true);
    }
    for (const value of [0, 2, 7, 15, 120, "5", null]) {
      expect(ASSISTANT_SCHEMA.shape.interval.safeParse(value).success).toBe(false);
    }

    // The whole valid object parses; the invalid-interval variant does not.
    expect(
      ASSISTANT_SCHEMA.safeParse({ name: "A", url: "https://example.com", interval: 5 }).success,
    ).toBe(true);
    expect(
      ASSISTANT_SCHEMA.safeParse({ name: "A", url: "https://example.com", interval: 7 }).success,
    ).toBe(false);
  });

  it("happy path: streams the partial JSON as a TEXT stream (useObject-compatible, never SSE)", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    seams.getAiModel.mockReturnValue(makeAssistantModel());
    const { POST } = await loadRoute();

    const res = await POST(
      buildRequest({ path: PATH, method: "POST", body: assistantBody() }),
    );

    expect(res.status).toBe(200);
    // A plain text stream — the useObject contract ("stream JSON ... as
    // chunked text"); NOT the UIMessage SSE the post-mortem route speaks.
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
    const text = await res.text();
    expect(text.startsWith("data:")).toBe(false);
    expect(text).toContain('{"name":"My Portfolio Site"');
    expect(text.endsWith('"interval":5}')).toBe(true);

    // The response was built by the v7 stateless createTextStreamResponse +
    // toTextStream pair (D-07 — no custom chunk parsing anywhere).
    expect(seams.responseCalls).toHaveLength(1);
    expect(seams.responseCalls[0].stream).toBeDefined();
  });

  it("streamText carries the Output.object schema, the description prompt, maxRetries 0, a composed abortSignal, and logs the D-10 assistant line", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    seams.getAiModel.mockReturnValue(makeAssistantModel());
    const { POST } = await loadRoute();

    const res = await POST(
      buildRequest({
        path: PATH,
        method: "POST",
        body: assistantBody("Watch my portfolio site every 5 minutes"),
      }),
    );
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let onEnd flush

    expect(seams.streamTextCalls).toHaveLength(1);
    const options = seams.streamTextCalls[0];
    // The structured output rides the SDK's Output.object (D-07) — never a
    // hand-rolled "respond in JSON" hope with client-side repair.
    expect(options.output).toBeDefined();
    // maxRetries: 0 (D-09 — never the silent-retry default 2); the timeout
    // composition bounds a hung provider (A2).
    expect(options.maxRetries).toBe(0);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    // The description enters the prompt as DELIMITED DATA (T-08-15 lineage).
    const prompt = String(options.prompt);
    expect(prompt).toContain("<description>");
    expect(prompt).toContain("Watch my portfolio site every 5 minutes");
    expect(String(options.instructions)).toContain("untrusted");

    // D-10: exactly one structured line — feature "assistant", tokens,
    // duration; never the prompt body.
    const requestLines = consoleInfo!.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[ai-request]"));
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]).toContain('"feature":"assistant"');
    expect(requestLines[0]).toContain(USER_A_ID);
    expect(requestLines[0]).toContain('"totalTokens":34');
    expect(requestLines[0]).not.toContain("portfolio");

    assertZeroDbWrites();
  });
});
