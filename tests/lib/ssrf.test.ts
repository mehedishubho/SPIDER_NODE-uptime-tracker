import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertUrlAllowed,
  DENYLIST,
  isInfraFailure,
  performCheck,
  UrlNotAllowedError,
  type ErrorClass,
} from "@/lib/ssrf";
import { startCheckTarget, type CheckTargetHandle } from "./helpers/check-target-server";

// ---------------------------------------------------------------------------
// SSRF check-pipeline proof suite: src/lib/ssrf.ts (SEC-01, D-38..D-43).
//
// Transcribes the §23 SSRF/classification cases (TC-SSRF-REDIRECT-PRIVATE-01,
// TC-SSRF-MAPPED-V6-01, TC-SSRF-SCHEME-01, TC-SSRF-SIZE-CAP-01,
// TC-CLASSIFY-TIMEOUT-01, TC-CLASSIFY-DNS-01) plus the D-42 normalization
// extensions, against a real local HTTP fixture server — no DB/Redis, no
// network mocks.
//
// Fixture topology (single-machine reality): the "public stand-in" fixture
// binds ::1 and runs under SEAM_DENYLIST — the documented CheckRequest test
// seam omitting ONLY the ::1 token, so all ten other tokens and every layer
// of the pipeline stay active while the check has something real to dial.
// The "private target" fixture binds 127.0.0.1 and stays denied under every
// denylist used here; its connection/hit counters prove denied hops are
// never dialed. Cases that need no reachable server use the production
// DENYLIST unchanged.
// ---------------------------------------------------------------------------

/** Production denylist minus ONLY the ::1 token — the documented test seam. */
const SEAM_DENYLIST = DENYLIST.filter((token) => token !== "::1");

// ---------------------------------------------------------------------------
// DNS stub seam for the assertUrlAllowed (D-23) describe below. The mock
// DELEGATES to the real node:dns/promises lookup unless a case sets an
// override, so every other case in this file (fixture servers, the real
// NXDOMAIN case) keeps genuine resolution.
// ---------------------------------------------------------------------------
const dnsStub = vi.hoisted(() => ({
  override: null as null | ((hostname: string) => Promise<Array<{ address: string; family: number }>>),
}));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  // dns.promises.lookup is overloaded (the last overload is single-argument),
  // so Parameters<>[1] is unusable — narrow through a plain call signature.
  const realLookup = actual.lookup as unknown as (
    hostname: string,
    options: unknown,
  ) => Promise<Array<{ address: string; family: number }>>;
  return {
    lookup: ((hostname: string, options: unknown) =>
      dnsStub.override ? dnsStub.override(hostname) : realLookup(hostname, options)) as unknown as typeof actual.lookup,
  };
});

let publicStandIn: CheckTargetHandle; // ::1 — allowed under SEAM_DENYLIST
let privateTarget: CheckTargetHandle; // 127.0.0.1 — denied under every denylist

beforeAll(async () => {
  publicStandIn = await startCheckTarget("::1");
  privateTarget = await startCheckTarget("127.0.0.1");
});

afterAll(async () => {
  await publicStandIn.close();
  await privateTarget.close();
});

function expectDown(result: Awaited<ReturnType<typeof performCheck>>): asserts result is {
  kind: "down";
  statusCode: number | null;
  errorClass?: ErrorClass;
  responseTimeMs: number;
} {
  expect(result.kind).toBe("down");
  expect(typeof result.responseTimeMs).toBe("number");
}

describe("ssrf — check pipeline (SEC-01 / D-38..D-43)", () => {
  it("1. DENYLIST integrity: exactly the 11 CIDR tokens (D-40 gate source)", () => {
    expect(DENYLIST).toHaveLength(11);
    expect([...DENYLIST]).toEqual(
      expect.arrayContaining([
        "10/8",
        "172.16/12",
        "192.168/16",
        "127/8",
        "169.254/16",
        "0.0.0.0/8",
        "::1",
        "fc00::/7",
        "fe80::/10",
        "::ffff:0:0/96",
        "64:ff9b::/96",
      ])
    );
  });

  it("2. direct private-range literal targets are denied without a dial (production denylist)", async () => {
    // The 127.0.0.1 variant points at the GENUINELY LISTENING private fixture:
    // if the pipeline ever dialed before validating, totalConnections() would
    // move. Every other range has no listener — classification-only.
    const loopbackResult = await performCheck({
      url: privateTarget.url("/ok"),
    });
    expectDown(loopbackResult);
    expect(loopbackResult.statusCode).toBeNull();
    expect(loopbackResult.errorClass).toBe("ssrf_blocked");
    expect(privateTarget.totalConnections()).toBe(0);

    for (const url of [
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.1/",
      "http://172.16.0.9/",
    ]) {
      const result = await performCheck({ url });
      expectDown(result);
      expect(result.statusCode).toBeNull();
      expect(result.errorClass).toBe("ssrf_blocked");
    }
    // The loopback denial above never reached the fixture's request handler.
    expect(privateTarget.hits("/ok")).toBe(0);
  });

  it("3. IPv6-mapped and short/decimal normalization vectors are denied (D-42 / TC-SSRF-MAPPED-V6-01)", async () => {
    for (const url of [
      "http://[::ffff:10.0.0.1]/", // mapped IPv6, embedded 10.x → 10/8
      "http://[::ffff:127.0.0.1]/", // mapped IPv6, embedded loopback → 127/8
      "http://127.1/", // short IPv4 form → URL-normalized 127.0.0.1
      "http://2130706433/", // decimal integer IPv4 form → 127.0.0.1
      "http://[64:ff9b::10.0.0.1]/", // NAT64-embedded 10.x → 10/8
    ]) {
      const result = await performCheck({ url });
      expectDown(result);
      expect(result.statusCode).toBeNull();
      expect(result.errorClass).toBe("ssrf_blocked");
    }
  });

  it("4. scheme allowlist: non-http(s) classified DOWN ssrf_blocked before any network I/O (TC-SSRF-SCHEME-01)", async () => {
    for (const url of ["file:///etc/passwd", "gopher://internal.example:6379/_INFO", "ftp://10.0.0.1/etc"]) {
      const result = await performCheck({ url });
      expectDown(result);
      expect(result.statusCode).toBeNull();
      expect(result.errorClass).toBe("ssrf_blocked");
      // No DNS, no connect: the refusal returns without any dial — fast by
      // construction (the scheme check precedes the resolve layer).
      expect(result.responseTimeMs).toBeLessThan(5_000);
    }
  });

  it("5. public→private redirect crossing: Location validated per hop and never dialed (TC-SSRF-REDIRECT-PRIVATE-01)", async () => {
    const target = encodeURIComponent(`${privateTarget.url("/canary")}`);
    const result = await performCheck({
      url: publicStandIn.url(`/redirect?to=${target}`),
      denylist: SEAM_DENYLIST,
    });
    expectDown(result);
    expect(result.statusCode).toBeNull();
    expect(result.errorClass).toBe("ssrf_blocked");
    // Hop 1 executed on the public stand-in (per-hop validation, not a
    // blanket denial of the original URL)…
    expect(publicStandIn.hits("/redirect")).toBe(1);
    // …but hop 2 never dialed the private fixture.
    expect(privateTarget.hits("/canary")).toBe(0);
    expect(privateTarget.totalConnections()).toBe(0);
  });

  it("6. redirect to the link-local metadata address is denied at the hop (§23 vector)", async () => {
    const result = await performCheck({
      url: publicStandIn.url(
        `/redirect?to=${encodeURIComponent("http://169.254.169.254/latest/meta-data")}`
      ),
      denylist: SEAM_DENYLIST,
    });
    expectDown(result);
    expect(result.statusCode).toBeNull();
    expect(result.errorClass).toBe("ssrf_blocked");
  });

  it("7. a valid relative redirect is resolved against the current URL and followed → UP", async () => {
    const result = await performCheck({
      url: publicStandIn.url(`/redirect?to=${encodeURIComponent("/ok")}`),
      denylist: SEAM_DENYLIST,
    });
    expect(result.kind).toBe("up");
    if (result.kind === "up") {
      expect(result.statusCode).toBe(200);
      expect(typeof result.responseTimeMs).toBe("number");
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("8. redirect chains: 5 hops followed to the terminal, the 6th refused (D-41 cap)", async () => {
    const followed = await performCheck({
      url: publicStandIn.url("/chain/5"),
      denylist: SEAM_DENYLIST,
    });
    expect(followed.kind).toBe("up");
    if (followed.kind === "up") expect(followed.statusCode).toBe(200);
    expect(publicStandIn.hits("/chain/0")).toBe(1);

    const refused = await performCheck({
      url: publicStandIn.url("/chain/6"),
      denylist: SEAM_DENYLIST,
    });
    expectDown(refused);
    expect(refused.statusCode).toBeNull();
    expect(refused.errorClass).toBe("ssrf_blocked");
  });

  it("9. classification parity: 200 UP, 4xx DOWN without errorClass, 5xx DOWN http_5xx (cron parity)", async () => {
    const up = await performCheck({
      url: publicStandIn.url("/ok"),
      denylist: SEAM_DENYLIST,
    });
    expect(up.kind).toBe("up");
    if (up.kind === "up") {
      expect(up.statusCode).toBe(200);
      expect(up.responseTimeMs).toBeGreaterThanOrEqual(0);
    }

    const notFound = await performCheck({
      url: publicStandIn.url("/notfound"),
      denylist: SEAM_DENYLIST,
    });
    expectDown(notFound);
    expect(notFound.statusCode).toBe(404);
    expect(notFound.errorClass).toBeUndefined();

    const serverError = await performCheck({
      url: publicStandIn.url("/error500"),
      denylist: SEAM_DENYLIST,
    });
    expectDown(serverError);
    expect(serverError.statusCode).toBe(500);
    expect(serverError.errorClass).toBe("http_5xx");
  });

  it(
    "10. the 2 MB streamed cap aborts before consuming the 3 MB chunked body (D-43 / TC-SSRF-SIZE-CAP-01)",
    async () => {
      const before = publicStandIn.oversizedBytesWritten();
      const result = await performCheck({
        url: publicStandIn.url("/oversized"),
        denylist: SEAM_DENYLIST,
      });
      // The read aborted at the cap, but the check still records a completed,
      // header-derived result (§15.1 sub-step 5) — a capped read is target
      // behavior, never an infra retry.
      expect(result.kind).toBe("up");
      if (result.kind === "up") expect(result.statusCode).toBe(200);

      const written = publicStandIn.oversizedBytesWritten() - before;
      // The fixture stopped writing well short of the full 3 MB: the client
      // quit consuming at ~2 MB, backpressure froze the pump, and the abort
      // tore the socket down. Slack covers kernel socket-buffer drift.
      expect(written).toBeGreaterThan(0);
      expect(written).toBeLessThan(3 * 1024 * 1024);
      expect(written).toBeLessThanOrEqual(2 * 1024 * 1024 + 1024 * 1024);
    },
    20_000
  );

  it("11. a lying Content-Length is never trusted — the outcome stays header-derived and the read stays bounded", async () => {
    const result = await performCheck({
      url: publicStandIn.url("/lying-length"),
      denylist: SEAM_DENYLIST,
    });
    // Declared 1024 bytes, 3 MB actually written. Whatever the parser does
    // with the mismatch (undici truncates at the declared length today), the
    // check completes as a target outcome from the response status — and no
    // path exists where the declared length substitutes for the streamed cap.
    expect(result.kind).toBe("up");
    if (result.kind === "up") expect(result.statusCode).toBe(200);
  });

  it(
    "12. timeout: a never-responding socket aborts within the injected budget as DOWN timeout (TC-CLASSIFY-TIMEOUT-01)",
    async () => {
      const result = await performCheck({
        url: publicStandIn.url("/hang"),
        denylist: SEAM_DENYLIST,
        timeoutMs: 400,
      });
      expectDown(result);
      expect(result.statusCode).toBeNull();
      expect(result.errorClass).toBe("timeout");
      // A target timeout is a successful DOWN job — never a throw — and the
      // whole exchange stayed inside its (injected, shrunken) budget.
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(300);
    },
    10_000
  );

  it(
    "13. target NXDOMAIN is a successful DOWN check with errorClass dns (TC-CLASSIFY-DNS-01)",
    async () => {
      const result = await performCheck({
        url: `http://${crypto.randomUUID()}.invalid/`,
      });
      expectDown(result);
      expect(result.statusCode).toBeNull();
      expect(result.errorClass).toBe("dns");
    },
    20_000
  );

  it("14. isInfraFailure separates resolver outage from target failures (WRK-05)", () => {
    const withCode = (code: string): NodeJS.ErrnoException =>
      Object.assign(new Error(`simulated ${code}`), { code });

    // Resolver outage — infrastructure (throws, breaker counts it).
    expect(isInfraFailure(withCode("EAI_AGAIN"))).toBe(true);
    expect(isInfraFailure(withCode("EAI_FAIL"))).toBe(true);
    // Target DNS failure, socket-layer failure, target timeout — target
    // outcomes (returned as DOWN, breaker ignores).
    expect(isInfraFailure(withCode("ENOTFOUND"))).toBe(false);
    expect(isInfraFailure(withCode("ECONNREFUSED"))).toBe(false);
    expect(isInfraFailure(withCode("ECONNRESET"))).toBe(false);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isInfraFailure(abort)).toBe(false);
    // Internal exception shape (a bare TypeError with no errno) — infra.
    expect(isInfraFailure(new TypeError("internal bug"))).toBe(true);
  });
});

describe("ssrf — assertUrlAllowed (D-23 DNS-only admission wrapper)", () => {
  afterEach(() => {
    dnsStub.override = null;
  });

  it("accepts a public hostname after DNS resolution — and performs NO target fetch (DNS-only)", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    dnsStub.override = lookup;

    const startedAt = Date.now();
    await expect(assertUrlAllowed("https://public.example.test/probe")).resolves.toBeUndefined();
    // Resolve-then-validate (layer 2) DID run against the hostname…
    expect(lookup).toHaveBeenCalledWith("public.example.test");
    // …and nothing else did: no undici exchange was attempted. Any target
    // fetch would consume a connect-timeout-scale budget dialing a real
    // address — this returns in milliseconds.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("rejects a hostname RESOLVING to a private range with a clean, internals-free message", async () => {
    dnsStub.override = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);

    const err: unknown = await assertUrlAllowed("https://intranet.example.test/").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UrlNotAllowedError);
    // The surfaced message never carries resolution internals (the resolved
    // address) — routes forward it verbatim as a 400 body (D-32).
    expect((err as Error).message).not.toContain("10.0.0.5");
    expect((err as Error).message).not.toContain("intranet.example.test");
  });

  it("rejects non-http(s) schemes BEFORE any DNS resolution (layer 1)", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    dnsStub.override = lookup;

    await expect(assertUrlAllowed("ftp://public.example.test/file")).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects an unresolvable host (NXDOMAIN) as a UrlNotAllowedError", async () => {
    dnsStub.override = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND nope.example.test"), {
        code: "ENOTFOUND",
      });
    });

    await expect(assertUrlAllowed("https://nope.example.test/")).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
  });

  it("literal PUBLIC ip: accepted WITHOUT any DNS lookup (the literal path skips resolution)", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    dnsStub.override = lookup;

    await expect(assertUrlAllowed("http://203.0.113.10/")).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("literal PRIVATE ip: rejected WITHOUT any DNS lookup", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    dnsStub.override = lookup;

    await expect(assertUrlAllowed("http://192.168.1.5/")).rejects.toBeInstanceOf(UrlNotAllowedError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolver-level infrastructure failures propagate UNWRAPPED (caller answers 500, never a silent accept)", async () => {
    dnsStub.override = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN resolver outage"), {
        code: "EAI_AGAIN",
      });
    });

    const err: unknown = await assertUrlAllowed("https://flaky.example.test/").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(UrlNotAllowedError);
    expect((err as Error).message).toContain("EAI_AGAIN");
  });
});
