import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { AiProviderInputs } from "./glm";

// ---------------------------------------------------------------------------
// The openai provider factory (D-02): the official OpenAI endpoint behind
// the SDK's own @ai-sdk/openai package. Selected by AI_PROVIDER=openai —
// swap is an env edit, never a code change (the full env-value map ships so
// no factory is missing at swap time; research OQ1 resolution).
//
// SERVER-SIDE ONLY by contract (T-08-18): the API key is read exclusively
// inside src/lib/ai; never NEXT_PUBLIC_*, never under src/worker/**.
// ---------------------------------------------------------------------------

export function createOpenAiModel(inputs: AiProviderInputs): LanguageModel {
  const openai = createOpenAI({ apiKey: inputs.apiKey });
  return openai(inputs.model);
}
