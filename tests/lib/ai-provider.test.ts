import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// lib/ai selection-matrix suite (08-06 Task 1 — the day-1 matrix):
//   1. D-04 master gate — AI_ENABLED unset/"false" (or any non-"true" value)
//      -> getAiModel() THROWS on every call. Routes must gate first; the
//      flag-off default posture is authored here, its route-level 404 proof
//      lands in 08-10.
//   2. D-02 env triple — AI_ENABLED=true with any of AI_PROVIDER/AI_MODEL/
//      AI_API_KEY missing -> THROWS naming the EXACT missing env vars
//      (throw-early, 06 D-11 lineage — incomplete config fails loud).
//   3. D-03 glm day-1 default -> a model wired through
//      @ai-sdk/openai-compatible at the Z.ai base URL with includeUsage.
//   4. Lazy cached resolution — the provider factory runs ONCE per module
//      instance and NEVER at import time (the src/lib/email/index.ts
//      cached-instance discipline mirrored).
//   5. aiEnabled() — the boolean helper routes/UI gate on; only the literal
//      "true" enables (the WINDOWED_UPTIME_ENABLED parse discipline).
//
// The @ai-sdk/openai-compatible seam is mocked via in-file vi.hoisted (the
// 02-05 mock discipline: hoisted values are fine while not exported) so the
// suite pins the ARGUMENTS our factory passes (name/baseURL/apiKey/
// includeUsage). The package's own behavior is the SDK's concern; pnpm
// typecheck pins the real call shape against the installed package types.
// ---------------------------------------------------------------------------

const openAICompatibleMocks = vi.hoisted(() => ({
  createOpenAICompatible: vi.fn((options: Record<string, unknown>) => {
    // The real factory returns a provider callable as provider(modelId); the
    // fake echoes the captured config so the suite can pin the wiring.
    const provider = (modelId: string) => ({
      provider: options.name,
      modelId,
      factoryConfig: options,
    });
    return provider;
  }),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: openAICompatibleMocks.createOpenAICompatible,
}));

const AI_ENV_KEYS = [
  "AI_ENABLED",
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_API_KEY",
  "AI_BASE_URL",
] as const;

function clearAiEnv(): void {
  for (const key of AI_ENV_KEYS) {
    delete process.env[key];
  }
}

function setValidGlmTriple(): void {
  process.env.AI_ENABLED = "true";
  process.env.AI_PROVIDER = "glm";
  process.env.AI_MODEL = "glm-4.6";
  process.env.AI_API_KEY = "test-zai-key";
}

beforeEach(() => {
  vi.resetModules();
  clearAiEnv();
  openAICompatibleMocks.createOpenAICompatible.mockClear();
});

describe("aiEnabled — the D-04 master-flag boolean", () => {
  it("unset -> false; only the literal \"true\" enables", async () => {
    const { aiEnabled } = await import("@/lib/ai");
    expect(aiEnabled()).toBe(false);
  });

  it("\"true\" -> true", async () => {
    process.env.AI_ENABLED = "true";
    const { aiEnabled } = await import("@/lib/ai");
    expect(aiEnabled()).toBe(true);
  });

  it("\"false\" / \"TRUE\" / garbage -> false (never a truthy leak)", async () => {
    const { aiEnabled } = await import("@/lib/ai");
    for (const value of ["false", "TRUE", "1", "yes"]) {
      process.env.AI_ENABLED = value;
      expect(aiEnabled()).toBe(false);
    }
  });
});

describe("getAiModel — AI_ENABLED master gate (D-02/D-04: routes gate first)", () => {
  it("AI_ENABLED unset -> THROWS naming AI_ENABLED", async () => {
    const { getAiModel } = await import("@/lib/ai");
    expect(() => getAiModel()).toThrow(/AI_ENABLED/);
  });

  it("AI_ENABLED \"false\" -> THROWS naming AI_ENABLED", async () => {
    process.env.AI_ENABLED = "false";
    const { getAiModel } = await import("@/lib/ai");
    expect(() => getAiModel()).toThrow(/AI_ENABLED/);
  });
});

describe("getAiModel — incomplete env triple throws naming the exact missing vars (D-02)", () => {
  it("all three of AI_PROVIDER/AI_MODEL/AI_API_KEY missing -> names all three", async () => {
    process.env.AI_ENABLED = "true";
    const { getAiModel } = await import("@/lib/ai");
    let message = "";
    try {
      getAiModel();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("AI_PROVIDER");
    expect(message).toContain("AI_MODEL");
    expect(message).toContain("AI_API_KEY");
  });

  it("AI_MODEL missing only -> names AI_MODEL and neither present var", async () => {
    process.env.AI_ENABLED = "true";
    process.env.AI_PROVIDER = "glm";
    process.env.AI_API_KEY = "test-zai-key";
    const { getAiModel } = await import("@/lib/ai");
    let message = "";
    try {
      getAiModel();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("AI_MODEL");
    expect(message).not.toContain("AI_PROVIDER");
    expect(message).not.toContain("AI_API_KEY");
  });
});

describe("getAiModel — glm day-1 default (D-03, wired via @ai-sdk/openai-compatible)", () => {
  it("resolves a model at the Z.ai base URL with includeUsage and the env model id", async () => {
    setValidGlmTriple();
    const { getAiModel } = await import("@/lib/ai");
    const model = getAiModel() as unknown as {
      provider: string;
      modelId: string;
    };

    expect(openAICompatibleMocks.createOpenAICompatible).toHaveBeenCalledTimes(1);
    const config = openAICompatibleMocks.createOpenAICompatible.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(config).toMatchObject({
      name: "glm",
      baseURL: "https://api.z.ai/api/paas/v4",
      apiKey: "test-zai-key",
      includeUsage: true,
    });
    expect(model.provider).toBe("glm");
    expect(model.modelId).toBe("glm-4.6");
  });
});

describe("getAiModel — lazy cached resolution (email-pattern discipline)", () => {
  it("second call returns the SAME instance; the factory runs exactly once", async () => {
    setValidGlmTriple();
    const { getAiModel } = await import("@/lib/ai");
    const first = getAiModel();
    const second = getAiModel();
    expect(second).toBe(first);
    expect(openAICompatibleMocks.createOpenAICompatible).toHaveBeenCalledTimes(1);
  });

  it("importing the module NEVER resolves the provider (no import-time construction)", async () => {
    setValidGlmTriple();
    await import("@/lib/ai");
    expect(openAICompatibleMocks.createOpenAICompatible).not.toHaveBeenCalled();
  });

  it("importing with NO AI env at all never throws (module import is inert)", async () => {
    await expect(import("@/lib/ai")).resolves.toBeDefined();
    expect(openAICompatibleMocks.createOpenAICompatible).not.toHaveBeenCalled();
  });
});
