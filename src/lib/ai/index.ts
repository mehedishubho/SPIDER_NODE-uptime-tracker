import type { LanguageModel } from "ai";
import { createAnthropicModel } from "./providers/anthropic";
import { createCustomModel } from "./providers/custom";
import { createGlmModel } from "./providers/glm";
import { createOpenAiModel } from "./providers/openai";

// ---------------------------------------------------------------------------
// The D-01/D-02 lib/ai module: the AI provider abstraction and AI_* env
// selection for the flagged AI features (incident post-mortem drafts +
// monitor-setup assistant), mirroring the Phase-6 email provider-interface
// pattern (src/lib/email/index.ts lineage).
//
// Selection (throw-early convention — 06 D-11, src/lib/redis.ts precedent):
//   AI_ENABLED not the literal "true"  -> getAiModel() THROWS on every call
//                                         (routes must gate on aiEnabled()
//                                         first — the flag-off default
//                                         posture; route-level 404s land in
//                                         08-10)
//   AI_ENABLED "true" + complete triple -> resolves + caches the model
//   AI_ENABLED "true" + incomplete triple -> THROWS naming the exact missing
//                                         env vars (unset is never a valid
//                                         "enabled" state)
//   AI_PROVIDER unknown value          -> THROWS listing the accepted set
//                                         (glm | openai | anthropic | custom
//                                         — a typo must fail loud, never
//                                         silently no-op)
//   AI_PROVIDER "custom"               -> additionally requires AI_BASE_URL
//                                         (providers/custom.ts throws naming
//                                         the var when it is absent)
//
// The selected model is cached per module instance and constructed LAZILY —
// importing this module never reads env or builds a provider. aiEnabled()
// is the boolean helper routes/UI gate on (only the enabled boolean ever
// crosses to the client — Pattern 6/T-08-18: API keys stay server-side).
//
// WEB-PROCESS ONLY by contract: zero AI imports under src/worker/** (rule
// 15 — AI never touches the check -> transition -> alert pipeline).
// ---------------------------------------------------------------------------

/** True only when AI_ENABLED is the literal "true" (D-04 master flag). */
export function aiEnabled(): boolean {
  return process.env.AI_ENABLED === "true";
}

let cachedModel: LanguageModel | undefined;

/**
 * Resolves the AI_PROVIDER/AI_MODEL/AI_API_KEY selection (D-02). The
 * selected model is cached per module instance (factories are lazy — module
 * import never constructs anything); an unknown or incomplete config throws
 * on EVERY call until fixed.
 */
export function getAiModel(): LanguageModel {
  if (process.env.AI_ENABLED !== "true") {
    throw new Error(
      "[lib/ai] getAiModel called with AI_ENABLED off — routes must gate on aiEnabled() first " +
        "(D-04: unset/\"false\" is the default posture; the app runs fully without AI keys)"
    );
  }
  if (cachedModel) {
    return cachedModel;
  }
  const provider = process.env.AI_PROVIDER;
  const model = process.env.AI_MODEL;
  const apiKey = process.env.AI_API_KEY;
  if (!provider || !model || !apiKey) {
    // Names EVERY missing var in one loud error (empty string counts as
    // missing — unset is never a valid "enabled" state).
    const missing: string[] = [];
    if (!provider) missing.push("AI_PROVIDER");
    if (!model) missing.push("AI_MODEL");
    if (!apiKey) missing.push("AI_API_KEY");
    throw new Error(
      `[lib/ai] AI_ENABLED=true but the env triple is incomplete — missing ${missing.join(", ")} ` +
        "(D-02 throw-early, 06 D-11 lineage: incomplete config fails loud, never silently no-ops)"
    );
  }
  let resolved: LanguageModel;
  switch (provider) {
    case "glm":
      resolved = createGlmModel({ apiKey, model });
      break;
    case "openai":
      resolved = createOpenAiModel({ apiKey, model });
      break;
    case "anthropic":
      resolved = createAnthropicModel({ apiKey, model });
      break;
    case "custom":
      resolved = createCustomModel({ apiKey, model });
      break;
    default:
      throw new Error(
        `[lib/ai] unknown AI_PROVIDER '${provider}' — expected 'glm', 'openai', 'anthropic' or 'custom' ` +
          "(D-02 throw-early: unset is never a valid enabled state; a typo must fail loud)"
      );
  }
  cachedModel = resolved;
  return cachedModel;
}
