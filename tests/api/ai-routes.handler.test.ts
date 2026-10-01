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
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// AI guard-chain suite (08-10 Task 1 — the /api/ai/* route contract):
//   1. D-21 flag-off posture — AI_ENABLED unset/"false" -> 404 BEFORE the
//      body is read, before identity, before any AI package touch (no
//      surface to probe).
//   2. AI-02 session guard — 401 without a session; identity precedes the
//      limiter (getAuthSession FIRST, never getIP — Pitfall 8).
//   3. D-08 per-user bucket — rateLimit(ai_drafts_{userId}, 10/h) with the
//      06 D-06 429 shape: numeric Retry-After from resetSeconds.
//   4. A4 input cap both sides — a body exactly at the cap passes the
//      guard; one character over answers the documented 413.
//
// Seams (02-05 discipline — hoisted consts, lazy factories, never exported):
//   - @/lib/rate-limit -> rateLimit only (the REAL limiter semantics live in
//     tests/integration/rate-limit.test.ts; no Redis is touched here).
//   - @/lib/ai -> getAiModel stubbed; aiEnabled stays REAL so the flag
//     cases exercise the actual env read (D-04).
//   - "ai" -> streamText + createUIMessageStreamResponse wrapped with
//     argument recorders delegating to the REAL SDK (the stub-capture
//     surface the D-14/order pins read).
// The route module is imported DYNAMICALLY per case (loadRoute) so the
// vi.resetModules registry swap stays effective (Pitfall 6).
// ---------------------------------------------------------------------------

const seams = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  getAiModel: vi.fn(),
  streamTextCalls: [] as Array<Record<string, unknown>>,
  responseCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: seams.rateLimit }));

vi.mock("@/lib/ai", async (importOriginal) => {
  // aiEnabled stays real (env-driven — the D-04 master flag this suite
  // proves the route honors); only the model getter is stubbed so no key
  // or network is ever needed.
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

function aiBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { monitorId: MONITOR_ID, incidentId: INCIDENT_ID, ...extra };
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
 * 404 is issued BEFORE the body is read (D-21). Node's webstreams PRIME the
 * queue with one pull below the high-water mark at construction (no reader
 * involved), so only the SECOND pull — the one that happens because a
 * consumer actually took the chunk out — counts as a read.
 */
function postWithTrackingBody(): { req: Request; wasRead: () => boolean } {
  let pulls = 0;
  let read = false;
  const chunk = new TextEncoder().encode(JSON.stringify(aiBody()));
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

const AI_ENV_UNDER_TEST = ["AI_ENABLED", "AI_TIMEOUT_MS", "AI_MODEL"] as const;

let consoleInfo: MockInstance | undefined;
let consoleError: MockInstance | undefined;

beforeEach(() => {
  vi.resetModules(); // fresh route-module registry per case (mock seams — Pitfall 6)
  for (const key of AI_ENV_UNDER_TEST) delete process.env[key]; // flag OFF is the default posture
  mockSession(null);
  resetDbMocks();
  seams.rateLimit.mockReset();
  // Admit-by-default limiter; the 429 cases override per call.
  seams.rateLimit.mockResolvedValue({ success: true, remaining: 9, resetSeconds: 30 });
  seams.getAiModel.mockReset();
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

describe("POST /api/ai/post-mortem — guard chain (flag, session, limiter, cap)", () => {
  it("flag off (AI_ENABLED unset) -> 404 BEFORE the body is read — zero surface to probe (D-21)", async () => {
    const { POST } = await loadRoute();

    const { req, wasRead } = postWithTrackingBody();
    const res = await POST(req);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not Found" });
    // The refusal precedes EVERY downstream concern: no body read, no
    // identity resolution, no limiter, no AI package touch.
    expect(wasRead()).toBe(false);
    expect(h.getServerSession).not.toHaveBeenCalled();
    expect(seams.rateLimit).not.toHaveBeenCalled();
    expect(seams.getAiModel).not.toHaveBeenCalled();
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it("flag off (AI_ENABLED=\"false\") -> the same pre-body 404 (only the literal \"true\" enables)", async () => {
    process.env.AI_ENABLED = "false";
    const { POST } = await loadRoute();

    const { req, wasRead } = postWithTrackingBody();
    const res = await POST(req);

    expect(res.status).toBe(404);
    expect(wasRead()).toBe(false);
    expect(h.getServerSession).not.toHaveBeenCalled();
  });

  it("flag on + no session -> 401 (identity BEFORE the limiter — AI-02/Pitfall 8)", async () => {
    process.env.AI_ENABLED = "true";
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(seams.rateLimit).not.toHaveBeenCalled(); // identity established the bucket first
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it("over-limit user -> 429 with the numeric Retry-After from resetSeconds (06 D-06 shape)", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    seams.rateLimit.mockResolvedValue({ success: false, remaining: 0, resetSeconds: 30 });
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "Too many AI requests — try again later." });
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(h.db.select).not.toHaveBeenCalled();
    expect(seams.getAiModel).not.toHaveBeenCalled();
  });

  it("429 WITHOUT resetSeconds -> no Retry-After header (the degraded-path conditional)", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    seams.rateLimit.mockResolvedValue({ success: false, remaining: 0 });
    const { POST } = await loadRoute();

    const res = await POST(buildRequest({ path: PATH, method: "POST", body: aiBody() }));

    expect(res.status).toBe(429);
    expect(res.headers.has("Retry-After")).toBe(false);
  });

  it("limiter key is PER-USER (ai_drafts_{userId}, 10/h — D-08), never derived from the IP (Pitfall 8)", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    dbState.results = [[]]; // monitor miss downstream is irrelevant to this pin
    const { POST } = await loadRoute();

    // A spoofable forwarding header rides the request — it must never reach
    // the bucket key.
    const res = await POST(
      buildRequest({ path: PATH, method: "POST", body: aiBody(), ip: "203.0.113.9" }),
    );

    expect(seams.rateLimit).toHaveBeenCalledTimes(1);
    const [identifier, options] = seams.rateLimit.mock.calls[0];
    expect(identifier).toBe(`ai_drafts_${USER_A_ID}`);
    expect(identifier).not.toContain("203.0.113.9");
    expect(identifier).not.toContain("127.0.0.1");
    expect(options).toEqual({ limit: 10, windowMs: 3_600_000 });
    expect(res.status).toBe(404); // drained into the ownership read's fixture
  });

  it("input cap pinned at BOTH sides (A4): exactly at the cap passes the guard; one char over -> the documented 413", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    const { AI_INPUT_MAX_CHARS } = await import("@/lib/ai/guards");
    const { POST } = await loadRoute();

    const base = JSON.stringify(aiBody());
    expect(base.length).toBeLessThan(AI_INPUT_MAX_CHARS);
    const padTo = (n: number) => base + " ".repeat(n - base.length); // trailing whitespace is valid JSON

    // Exactly AT the cap: the guard PASSES — proven by the ownership query
    // firing (the empty fixture answers its 404).
    dbState.results = [[]];
    const atCap = await POST(postRaw(padTo(AI_INPUT_MAX_CHARS)));
    expect(atCap.status).toBe(404);
    expect(h.db.select).toHaveBeenCalledTimes(1);
    expect(dbLog[0].op).toBe("select");

    // One unit OVER the cap: rejected before any DB work with the
    // documented 4xx + cap value.
    resetDbMocks();
    dbState.results = [[]];
    const over = await POST(postRaw(padTo(AI_INPUT_MAX_CHARS + 1)));
    expect(over.status).toBe(413);
    const body = (await over.json()) as { error: string };
    expect(body.error).toContain("too large");
    expect(body.error).toContain(String(AI_INPUT_MAX_CHARS));
    expect(h.db.select).not.toHaveBeenCalled();
    expect(seams.getAiModel).not.toHaveBeenCalled();
  });

  it("malformed JSON body -> 400 (manual validation, no internals echoed)", async () => {
    process.env.AI_ENABLED = "true";
    mockSession(sessionA);
    const { POST } = await loadRoute();

    const res = await POST(postRaw("{not json"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(h.db.select).not.toHaveBeenCalled();
  });
});
