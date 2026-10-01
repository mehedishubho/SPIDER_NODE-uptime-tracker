// ---------------------------------------------------------------------------
// The D-10 cost-visibility log line (08-10): exactly ONE structured line per
// AI request — feature, userId, model, tokens in/out (total), duration —
// and NOTHING else. Never prompt bodies, never URLs, never monitor names
// (V8 discipline, T-04-28 lineage: the maintenance logger's
// ids-and-counts-only rule applied to the AI leg).
//
// Shape: bracketed-prefix JSON on console.info — the console-provider
// precedent ("[redis-limiter] DEGRADED fail-open: …" in src/lib/rate-limit)
// with a JSON payload so a log shipper can parse fields without regexes.
// No new metric machinery (D-10); the provider wiring's includeUsage makes
// the token counts available on the stream's onEnd.
// ---------------------------------------------------------------------------

/** The usage fields the D-10 line carries (SDK LanguageModelUsage subset). */
export interface AiUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AiRequestLogInput {
  feature: string;
  userId: string;
  model: string;
  usage?: AiUsageLike;
  durationMs: number;
}

/** One structured line per completed AI request (D-10). */
export function logAiRequest(input: AiRequestLogInput): void {
  console.info(
    `[ai-request] ${JSON.stringify({
      feature: input.feature,
      userId: input.userId,
      model: input.model,
      promptTokens: input.usage?.inputTokens ?? 0,
      completionTokens: input.usage?.outputTokens ?? 0,
      totalTokens: input.usage?.totalTokens ?? 0,
      durationMs: input.durationMs,
    })}`,
  );
}

export interface AiAbortLogInput {
  feature: string;
  userId: string;
  model: string;
  durationMs: number;
}

/** The abort companion line (Stop pressed or the timeout bound fired). */
export function logAiAbort(input: AiAbortLogInput): void {
  console.info(
    `[ai-request-abort] ${JSON.stringify({
      feature: input.feature,
      userId: input.userId,
      model: input.model,
      durationMs: input.durationMs,
    })}`,
  );
}
