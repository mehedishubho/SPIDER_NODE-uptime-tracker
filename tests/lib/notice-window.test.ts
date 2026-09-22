import { describe, expect, it } from "vitest";
import { noticeWindowActive } from "@/lib/notice-window";

// ---------------------------------------------------------------------------
// Contract suite: src/lib/notice-window.ts — the /login notice strip's env
// window predicate (07-04 Task 3, AUTH-06/D-02/T-07-15).
//
//   - inclusive [start, end] window: exactly-start and exactly-end are
//     INSIDE (boundary instants pinned)
//   - any missing bound → false (fail toward no-strip)
//   - any invalid date string → false (a misconfigured window can never pin
//     a stale notice onto the login page; the window self-cleans, D-02)
// ---------------------------------------------------------------------------

const START = "2026-09-01T00:00:00.000Z";
const END = "2026-09-30T23:59:59.999Z";
const INSIDE = new Date("2026-09-15T12:00:00.000Z");

describe("noticeWindowActive", () => {
  it("returns true inside the window", () => {
    expect(noticeWindowActive(INSIDE, START, END)).toBe(true);
  });

  it("returns false before the window opens", () => {
    expect(noticeWindowActive(new Date("2026-08-31T23:59:59.999Z"), START, END)).toBe(
      false,
    );
  });

  it("returns false after the window closes", () => {
    expect(noticeWindowActive(new Date("2026-10-01T00:00:00.000Z"), START, END)).toBe(
      false,
    );
  });

  it("is inclusive at the exact start instant", () => {
    expect(noticeWindowActive(new Date(START), START, END)).toBe(true);
  });

  it("is inclusive at the exact end instant", () => {
    expect(noticeWindowActive(new Date(END), START, END)).toBe(true);
  });

  it("returns false when start is missing", () => {
    expect(noticeWindowActive(INSIDE, undefined, END)).toBe(false);
  });

  it("returns false when end is missing", () => {
    expect(noticeWindowActive(INSIDE, START, undefined)).toBe(false);
  });

  it("returns false when both bounds are missing", () => {
    expect(noticeWindowActive(INSIDE, undefined, undefined)).toBe(false);
  });

  it("returns false for an invalid start string", () => {
    expect(noticeWindowActive(INSIDE, "not-a-date", END)).toBe(false);
  });

  it("returns false for an invalid end string", () => {
    expect(noticeWindowActive(INSIDE, START, "also-not-a-date")).toBe(false);
  });

  it("returns false for empty-string bounds", () => {
    expect(noticeWindowActive(INSIDE, "", "")).toBe(false);
  });

  it("returns false when start is after end (inverted window)", () => {
    expect(noticeWindowActive(INSIDE, END, START)).toBe(false);
  });
});
