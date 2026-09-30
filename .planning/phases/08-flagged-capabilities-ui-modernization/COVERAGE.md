# API Coverage — AI provider surface (Vercel AI SDK over OpenAI-compatible providers)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
>
> Phase 8 integrates external AI provider APIs behind the `lib/ai` env-swappable layer (CONTEXT D-01/D-02/D-03): the day-1 default is Z.ai GLM via `@ai-sdk/openai-compatible` (`https://api.z.ai/api/paas/v4`), with OpenAI / Anthropic / custom OpenAI-compatible endpoints selectable by env. The matrix below covers the provider-API capability surface the SDK exposes; it is provider-agnostic because the abstraction makes every provider value consume the same two capabilities.

| capability | decision | reason |
|---|---|---|
| chat/completions streaming (streamText -> UIMessage/text stream) | INTEGRATE | both features ride it: post-mortem draft (AI-03) and monitor-setup assistant (AI-04) |
| usage / token reporting in streaming responses (includeUsage, onEnd usage) | INTEGRATE | D-10 cost-visibility log line consumes tokens in/out per request |
| structured/partial JSON output (Output.object over the chat surface) | INTEGRATE | assistant prefill partial-object semantics (D-19) — same chat capability, schema-constrained |
| embeddings | OPT-OUT | no semantic-search or vector feature exists in this milestone |
| tool/function calling | OPT-OUT | both features are single-prompt generation; the assistant never executes anything (AI-04 confirmation contract) |
| multi-step / agent loops (multi-step streamText, stopWhen) | OPT-OUT | D-09 forbids hidden retry/degradation loops; single-shot generation only |
| image generation | OPT-OUT | no image surface in scope |
| audio (speech-to-text, text-to-speech) | OPT-OUT | no audio surface in scope |
| batch/completions APIs | OPT-OUT | both features are interactive streaming endpoints (D-07); batch is not consumed |
| files API | OPT-OUT | no file upload surface; evidence is DB-sourced and size-capped |
| fine-tuning / model management APIs | OPT-OUT | provider accounts are used inference-only; model selection is an env var (D-02) |
| moderation API | OPT-OUT | no user-generated-content publication surface; output is copy-only to the requesting user (D-13) |
| provider admin / usage-dashboard / billing APIs | OPT-OUT | cost visibility is served by the D-10 structured log line; no dashboard integration in scope |
| responses API (OpenAI-specific alternate surface) | OPT-OUT | the SDK chat/completions surface covers both features; the OpenAI branch exists only for env-swap parity (D-02) |
| message batches (Anthropic-specific) | OPT-OUT | same reasoning as batch/completions above |

*Maintained per the api-coverage gate (verify:pre). A future phase extending this integration starts from this matrix rather than from zero.*
