import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import "./_harness";
import {
  dbLog,
  dbState,
  h,
  mockSession,
  resetDbMocks,
  sessionA,
  USER_A_ID,
} from "./_harness";
import { MockLanguageModelV4 } from "ai/test";

// ---------------------------------------------------------------------------
// AI streaming suite (08-10 Task 1 — the D-07 route contract over the REAL
// ai package):
//   1. The response IS a UIMessage stream built with the v7 stateless
//      helpers — SSE frames, text deltas, consumeStream: true (Pitfall 5).
//   2. D-09 — maxRetries: 0 (never the silent-retry default 2) and a
//      composed abortSignal on the streamText call.
//   3. Pitfall 5 — aborting req.signal aborts the UPSTREAM provider call
//      (the doStream abort listener fires; D-16's Stop is honest) and
//      emits the abort log line.
//   4. The timeout bound — the composed signal fires when the configured
//      timeout elapses (AI_TIMEOUT_MS seam), without any client abort.
//   5. D-13 on the abort/timeout paths too — zero DB writes.
//
// The model rides the @/lib/ai seam (a hanging MockLanguageModelV4 fed
// through the REAL streamText). Signal-carrying requests are built on plain
// Request — undici wires init.signal to req.signal (verified), which is
// exactly what the route forwards into AbortSignal.any.
// Same seam layout as ai-routes.handler.test.ts (see that header).
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
  status: "ONGOING",
  description: "Elevated 5xx rate",
  startedAt: "2026-09-30 10:00:00.000",
  resolvedAt: null,
};

const pingRows = [
  { status: "DOWN", responseTime: 0, statusCode: 503, errorClass: "http_5xx", createdAt: "2026-09-30 10:00:30.000" },
];

function aiBody(): Record<string, unknown> {
  return { monitorId: MONITOR_ID, incidentId: INCIDENT_ID };
}

/** A stub model that emits one complete text part with V4 usage. */
function makeCompletingModel() {
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
 * An IN-FLIGHT provider call: emits a partial delta, then stays open until
 * the abortSignal it received from streamText fires — the stand-in for a
 * real provider mid-stream. Records the signal so the abort/timeout cases
 * can prove the route's composition reached the upstream call.
 */
function makeHangingModel() {
  const seen: { abortSignal?: AbortSignal; aborted: boolean } = { aborted: false };
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      seen.abortSignal = abortSignal ?? undefined;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "partial draft" });
            abortSignal?.addEventListener("abort", () => {
              seen.aborted = true;
              try {
                controller.close();
              } catch {
                // already closed — the abort raced the drain
              }
            });
          },
        }),
      };
    },
  });
  return { model, seen };
}

/** POST Request with a wired AbortSignal (plain Request — verified wiring). */
function postWithSignal(body: unknown, signal?: AbortSignal): Request {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  return new Request(`http://localhost${PATH}`, init);
}

const AI_ENV_UNDER_TEST = ["AI_ENABLED", "AI_TIMEOUT_MS", "AI_MODEL"] as const;

let consoleInfo: MockInstance | undefined;
let consoleError: MockInstance | undefined;

beforeEach(() => {
  vi.resetModules();
  for (const key of AI_ENV_UNDER_TEST) delete process.env[key];
  process.env.AI_ENABLED = "true"; // this suite is the flag-ON streaming leg
  process.env.AI_MODEL = "glm-4.6-test";
  mockSession(sessionA);
  resetDbMocks();
  dbState.results = [[monitorRow], [incidentRow], [pingRows]];
  seams.rateLimit.mockReset();
  seams.rateLimit.mockResolvedValue({ success: true, remaining: 9, resetSeconds: 30 });
  seams.getAiModel.mockReset();
  seams.getAiModel.mockReturnValue(makeCompletingModel());
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

describe("POST /api/ai/post-mortem — streaming contract (D-07/D-09/Pitfall 5)", () => {
  it("returns a UIMessage SSE stream via the v7 stateless helpers with consumeStream: true", async () => {
    const { POST } = await loadRoute();

    const res = await POST(postWithSignal(aiBody()));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // UIMessage stream frames (start/step/text), not a custom chunk format.
    expect(text).toContain('data: {"type":"start"}');
    expect(text).toContain("text-delta");
    expect(text).toContain("Generated post-mortem text.");

    // The response was built by createUIMessageStreamResponse with
    // consumeStream: true — client Stop drains instead of hanging (Pitfall 5).
    expect(seams.responseCalls).toHaveLength(1);
    expect(seams.responseCalls[0].consumeStream).toBe(true);
    expect(seams.responseCalls[0].stream).toBeDefined();
  });

  it("D-09: the streamText call pins maxRetries 0 and carries a composed abortSignal (no silent retry default)", async () => {
    const { POST } = await loadRoute();

    const res = await POST(postWithSignal(aiBody()));
    await res.text();

    expect(seams.streamTextCalls).toHaveLength(1);
    const options = seams.streamTextCalls[0];
    expect(options.maxRetries).toBe(0);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("aborting req.signal aborts the UPSTREAM provider call (Stop is honest — Pitfall 5) and logs the abort", async () => {
    const hanging = makeHangingModel();
    seams.getAiModel.mockReturnValue(hanging.model);
    const controller = new AbortController();
    const { POST } = await loadRoute();

    const res = await POST(postWithSignal(aiBody(), controller.signal));
    const drained = res.text();
    await new Promise((resolve) => setTimeout(resolve, 40)); // let the upstream call start
    controller.abort(); // the client presses Stop
    await drained;
    await new Promise((resolve) => setTimeout(resolve, 40)); // let onAbort flush

    // The abort reached the provider call itself, not just the browser fetch.
    expect(hanging.seen.abortSignal).toBeInstanceOf(AbortSignal);
    expect(hanging.seen.aborted).toBe(true);

    // The abort log line identifies feature + user (never prompt content).
    const abortLines = consoleInfo!.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[ai-request-abort]"));
    expect(abortLines).toHaveLength(1);
    expect(abortLines[0]).toContain(USER_A_ID);
    expect(abortLines[0]).toContain("post-mortem");

    // D-13 on the abort path: still zero DB writes.
    expect(dbLog.filter((entry) => entry.op !== "select")).toEqual([]);
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  it("timeout composition: the composed signal fires when the bound elapses — no client abort needed (A2)", async () => {
    const hanging = makeHangingModel();
    seams.getAiModel.mockReturnValue(hanging.model);
    process.env.AI_TIMEOUT_MS = "60"; // the execution-discretion timeout seam
    const { POST } = await loadRoute();

    const res = await POST(postWithSignal(aiBody())); // request signal never aborts
    await res.text(); // resolves when the timeout closes the hanging stream
    await new Promise((resolve) => setTimeout(resolve, 40)); // let callbacks flush

    expect(hanging.seen.abortSignal).toBeInstanceOf(AbortSignal);
    expect(hanging.seen.aborted).toBe(true);

    // D-13 on the timeout path: zero DB writes.
    expect(dbLog.filter((entry) => entry.op !== "select")).toEqual([]);
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.db.delete).not.toHaveBeenCalled();
  });
});
