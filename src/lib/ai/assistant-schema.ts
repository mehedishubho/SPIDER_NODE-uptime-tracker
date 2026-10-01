import { z } from "zod";

// ---------------------------------------------------------------------------
// The monitor-setup assistant's output schema (08-07, AI-04) — the zod object
// the /api/ai/monitor-assistant route streams toward (Output.object) and the
// Add Monitor dialog's useObject consumes for the D-19 partial fill.
//
// It lives in its OWN client-safe module (no route/db imports) because BOTH
// sides import it: the route (server) and Dashboard.tsx (client bundle).
// The field set mirrors the create form / POST /api/monitors contract exactly
// — name (string), url (string), interval (one of the form's option values
// 1/5/10/30/60) — the "same schema as the manual form" AI-04 pins. The form's
// submit remains the ONLY validation gate: this schema shapes the suggestion;
// the create route re-runs its own trimmed-input + URL + assertUrlAllowed
// admission on submit (D-17/D-19, T-08-24).
// ---------------------------------------------------------------------------

/** The form's check-interval option values — the assistant may suggest only these. */
export const ASSISTANT_INTERVALS = [1, 5, 10, 30, 60] as const;

export const ASSISTANT_SCHEMA = z.object({
  name: z.string().describe("Monitor name"),
  url: z.string().describe("Target URL to watch"),
  interval: z
    .union([
      z.literal(1),
      z.literal(5),
      z.literal(10),
      z.literal(30),
      z.literal(60),
    ])
    .describe("Check interval in minutes: one of 1, 5, 10, 30, 60"),
});

export type AssistantFields = z.infer<typeof ASSISTANT_SCHEMA>;

/**
 * Per-field validity probe for the D-19 guarded partial fill: a streamed
 * value may drive its setState call only when it is schema-valid for THAT
 * field (e.g. interval 7 — outside the literal union — never lands in the
 * select; the field keeps its current value and earns the manual-entry hint).
 */
export function isFieldValid<K extends keyof AssistantFields>(
  field: K,
  value: unknown,
): value is AssistantFields[K] {
  const fieldSchema = ASSISTANT_SCHEMA.shape[field];
  return fieldSchema.safeParse(value).success;
}
