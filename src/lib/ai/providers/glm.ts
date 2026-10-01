import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// ---------------------------------------------------------------------------
// The glm provider factory (D-03 — the documented day-1 default): Z.ai's GLM
// models behind the SDK's own OpenAI-compatible package. No third-party
// community provider, no second selection mechanism — the env triple plus
// this factory covers GLM (08-RESEARCH "Don't Hand-Roll").
//
// The base URL is the official Z.ai OpenAI-compatible endpoint pinned by the
// AI SDK provider docs; includeUsage: true surfaces token usage in streaming
// responses so the D-10 cost-visibility log line can read it.
//
// SERVER-SIDE ONLY by contract (T-08-18): AI_* env values — the API key in
// particular — are read exclusively inside src/lib/ai, never NEXT_PUBLIC_*,
// never imported under src/worker/** (rule 15: zero AI in the check ->
// transition -> alert pipeline).
// ---------------------------------------------------------------------------

/** Z.ai's OpenAI-compatible endpoint (08-RESEARCH Pattern 1 / D-03). */
export const GLM_BASE_URL = "https://api.z.ai/api/paas/v4";

/** The resolved selection inputs src/lib/ai hands a provider factory. */
export interface AiProviderInputs {
  apiKey: string;
  model: string;
}

export function createGlmModel(inputs: AiProviderInputs): LanguageModel {
  const glm = createOpenAICompatible({
    name: "glm",
    baseURL: GLM_BASE_URL,
    apiKey: inputs.apiKey,
    includeUsage: true,
  });
  return glm(inputs.model);
}
