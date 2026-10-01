import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AiProviderInputs } from "./glm";

// ---------------------------------------------------------------------------
// The custom provider factory (D-02): any OpenAI-compatible endpoint
// (gateways, proxies, self-hosted relays) over AI_BASE_URL, wired through
// the same SDK package as the GLM default. Selected by AI_PROVIDER=custom.
//
// AI_BASE_URL is REQUIRED for this value and only this value: absent/empty
// throws naming the var (throw-early, 06 D-11 lineage) — a custom provider
// with no endpoint must fail loud at first use, never guess a default.
//
// SERVER-SIDE ONLY by contract (T-08-18): the API key is read exclusively
// inside src/lib/ai; never NEXT_PUBLIC_*, never under src/worker/**.
// ---------------------------------------------------------------------------

export function createCustomModel(inputs: AiProviderInputs): LanguageModel {
  const baseURL = process.env.AI_BASE_URL;
  if (!baseURL) {
    throw new Error(
      "[lib/ai] AI_PROVIDER=custom requires AI_BASE_URL (D-02: the custom value points an " +
        "OpenAI-compatible factory at your endpoint — an absent base URL fails loud, never guesses)"
    );
  }
  const custom = createOpenAICompatible({
    name: "custom",
    baseURL,
    apiKey: inputs.apiKey,
  });
  return custom(inputs.model);
}
