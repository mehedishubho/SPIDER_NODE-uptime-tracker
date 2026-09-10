import { describe, expect, it } from "vitest";
import { assertLocalDatabaseUrl } from "./global-setup";

// Proves the test-database safety guard WITHOUT running global-setup itself
// (the guard takes its URL as an argument — no env-var manipulation needed).
describe("assertLocalDatabaseUrl — the production-database safety guard", () => {
  it("throws a non-local error for a production-style URL", () => {
    expect(() =>
      assertLocalDatabaseUrl(
        "postgresql://postgres:postgres@prod.example.com:5432/prod"
      )
    ).toThrow(/non-local/);
  });

  it("accepts localhost", () => {
    expect(() =>
      assertLocalDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5453/uptime_test"
      )
    ).not.toThrow();
  });

  it("accepts 127.0.0.1", () => {
    expect(() =>
      assertLocalDatabaseUrl(
        "postgresql://postgres:postgres@127.0.0.1:5453/uptime_test"
      )
    ).not.toThrow();
  });

  it("accepts host.docker.internal", () => {
    expect(() =>
      assertLocalDatabaseUrl(
        "postgresql://postgres:postgres@host.docker.internal:5432/uptime_test"
      )
    ).not.toThrow();
  });

  it("fails closed on an unparseable URL", () => {
    expect(() => assertLocalDatabaseUrl("")).toThrow(/non-local/);
    expect(() => assertLocalDatabaseUrl("not-a-url")).toThrow(/non-local/);
  });
});
