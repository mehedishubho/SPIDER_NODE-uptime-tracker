// ---------------------------------------------------------------------------
// src/lib/serialize.ts — the ONE API-boundary timestamp seam (07-10, gap
// closure G-07-63 / review CR-01).
//
// The Drizzle driver (drizzle-orm/node-postgres) overrides the pg type
// parsers and returns raw Postgres wire text for timestamp columns: for the
// naive timestamp(3) columns that is "2026-09-29 15:00:00.789" — a space
// separator and NO timezone designator. ECMAScript parses that form as LOCAL
// time, not UTC, which shifted every rendered time by the UTC offset and
// made the manual-check completion poll never complete in UTC+ browsers
// (false-complete in UTC−). The stored convention is UTC wall-clock (the A6
// backfill carried AT TIME ZONE 'UTC'; DB sessions are pinned UTC), so naive
// text normalizes by appending the Z designator before parsing.
//
// iso() converts one driver text to ISO-8601 UTC; isoRow() maps a response
// row's named timestamp keys through it (spread-and-overwrite keeps JSON key
// order and shape stable apart from the FORMAT, which is the restoration of
// the Prisma-era wire contract). Every ported route response boundary goes
// through THIS module — one seam, no per-route date logic.
// ---------------------------------------------------------------------------

/**
 * Converts the driver's Postgres timestamp text to ISO-8601 UTC.
 *
 * Naive text ("2026-09-29 15:00:00.789") is UTC wall-clock per the stored
 * convention → the Z designator is appended before parsing. Offset-carrying
 * timestamptz text ("...+00") already names its instant → parsed directly
 * (a bare +HH tail is widened to the spec's +HH:00 form). An already-ISO-Z
 * string round-trips unchanged. Null/empty passes through unchanged so
 * nullable columns stay present-with-null in responses; an unparseable value
 * passes through unchanged too — a serializer never fabricates a date.
 */
export function iso(value: string | null): string | null {
  if (!value) return value;

  // The ECMAScript date-time format uses T as the separator; the lenient
  // space form is implementation-defined, so canonicalize first.
  let candidate = value.trim().replace(" ", "T");
  const endsWithZ = /[zZ]$/.test(candidate);
  const endsWithOffset = /[+-]\d{2}(:\d{2})?$/.test(candidate);
  if (!endsWithZ && !endsWithOffset) {
    // Naive text: UTC wall-clock per the stored convention.
    candidate = `${candidate}Z`;
  } else if (!endsWithZ && /[+-]\d{2}$/.test(candidate)) {
    // Widen a bare +HH offset tail (+00) to the spec's +HH:00 form.
    candidate = `${candidate}:00`;
  }

  const instant = new Date(candidate);
  if (Number.isNaN(instant.getTime())) return value;
  return instant.toISOString();
}

/**
 * Returns a copy of `row` with each named timestamp key normalized through
 * iso(). Keys holding a string or null are overwritten in place (key order
 * and shape preserved — only the timestamp FORMAT changes); absent keys and
 * non-timestamp values are left untouched.
 */
export function isoRow<T extends object>(row: T, keys: ReadonlyArray<keyof T>): T {
  const out = { ...(row as Record<string, unknown>) };
  for (const key of keys) {
    const current = out[key as string];
    if (typeof current === "string" || current === null) {
      out[key as string] = iso(current);
    }
  }
  return out as T;
}
