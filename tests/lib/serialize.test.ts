import { describe, expect, it } from "vitest";
import { iso, isoRow } from "@/lib/serialize";

// ---------------------------------------------------------------------------
// Unit matrix for the ONE API-boundary timestamp seam (07-10, G-07-63/CR-01).
// TZ-independent BY CONSTRUCTION: every expected value is a literal string —
// no expectation is derived from this machine's timezone — so the matrix
// passes identically in any TZ. That TZ-independence is the point: the defect
// class being closed is a timezone-dependent parse.
// ---------------------------------------------------------------------------

describe("iso — driver timestamp text → ISO-8601 UTC (G-07-63/CR-01)", () => {
  it("naive timestamp(3) text (space separator, no designator) normalizes as UTC", () => {
    expect(iso("2026-09-29 15:00:00.789")).toBe("2026-09-29T15:00:00.789Z");
  });

  it("naive text without a fraction gains the Z designator at the same instant", () => {
    expect(iso("2026-09-29 15:00:00")).toBe("2026-09-29T15:00:00.000Z");
  });

  it("timestamptz text with a +00 offset parses directly to the same instant", () => {
    expect(iso("2026-09-29 15:00:00.789+00")).toBe("2026-09-29T15:00:00.789Z");
  });

  it("an already-ISO-Z string round-trips unchanged", () => {
    expect(iso("2026-09-29T15:00:00.789Z")).toBe("2026-09-29T15:00:00.789Z");
  });

  it("null passes through unchanged — nullable columns stay present-with-null", () => {
    expect(iso(null)).toBeNull();
  });
});

describe("isoRow — response-row mapping through the seam", () => {
  it("overwrites only the named keys, preserving key order and shape", () => {
    const row = {
      id: 1,
      lastChecked: "2026-09-29 15:00:00.789",
      name: "mon",
      resolvedAt: "2026-09-29 16:00:00.000+00",
    };
    const mapped = isoRow(row, ["lastChecked", "resolvedAt"]);

    expect(mapped).toEqual({
      id: 1,
      lastChecked: "2026-09-29T15:00:00.789Z",
      name: "mon",
      resolvedAt: "2026-09-29T16:00:00.000Z",
    });
    expect(Object.keys(mapped)).toEqual(Object.keys(row));
  });

  it("absent keys are not added and null values stay null (present-with-null contract)", () => {
    const row: { id: number; name: string; lastChecked: string | null; createdAt?: string } = {
      id: 2,
      name: "mon",
      lastChecked: null,
    };
    const mapped = isoRow(row, ["lastChecked", "createdAt"]);

    expect(mapped).toEqual({ id: 2, name: "mon", lastChecked: null });
    expect(Object.keys(mapped)).toEqual(["id", "name", "lastChecked"]);
  });
});
