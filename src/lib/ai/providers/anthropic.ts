import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { AiProviderInputs } from "./glm";

// ---------------------------------------------------------------------------
// The anthropic provider factory (D-02): Anthropic's Claude models behind
// the SDK's own @ai-sdk/anthropic package. Selected by AI_PROVIDER=anthropic
// — swap is an env edit, never a code change (research OQ1 resolution).
//
// SERVER-SIDE ONLY by contract (T-08-18): the API key is read exclusively
// inside src/lib/ai; never NEXT_PUBLIC_*, never under src/worker/**.
// ---------------------------------------------------------------------------

export function createAnthropicModel(inputs: AiProviderInputs): LanguageModel {
  const anthropic = createAnthropic({ apiKey: inputs.apiKey });
  return anthropic(inputs.model);
}
