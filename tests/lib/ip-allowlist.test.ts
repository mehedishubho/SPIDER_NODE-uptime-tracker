import { describe, expect, it } from "vitest";
import { isIpAllowlisted, isLoopbackRemote, normalizeRemoteAddress, parseIpAllowlist } from "@/lib/ip-allowlist";

// ---------------------------------------------------------------------------
// ADMIN_IP_ALLOWLIST parser + matcher suite (D-17, 07-05 Task 2). Pure-unit —
// no docker stack needed; the security posture pins are:
//   1. exact-IP match, 2. CIDR containment in/out of range,
//   3. IPv4-mapped-IPv6 socket normalization (::ffff:a.b.c.d — how node
//      reports IPv4 sources on a dual-stack socket),
//   4. EMPTY allowlist refuses EVERYTHING (fail-closed — D-17 "empty = allow
//      nobody"),
//   5. unparsable config THROWS at boot (fail-loud — never silently
//      narrower),
//   6. IPv6 entries match native IPv6 socket addresses.
// The prohibition behind it all: the caller keys on req.socket.remoteAddress
// only — forwarded-for headers are never consulted (T-07-18).
// ---------------------------------------------------------------------------

describe("parseIpAllowlist — D-17 env parsing", () => {
  it("parses comma-separated exact IPs and CIDRs, trimming whitespace", () => {
    const list = parseIpAllowlist(" 203.0.113.7 , 10.0.0.0/8 , 2001:db8::/32 ");
    expect(list.entries).toHaveLength(3);
    expect(list.entries[0]).toMatchObject({ prefixLength: null });
    expect(list.entries[0].addr.toString()).toBe("203.0.113.7");
    expect(list.entries[1]).toMatchObject({ prefixLength: 8 });
    expect(list.entries[1].addr.toString()).toBe("10.0.0.0");
    expect(list.entries[2]).toMatchObject({ prefixLength: 32 });
  });

  it("empty string and undefined both yield an EMPTY allowlist", () => {
    expect(parseIpAllowlist("").entries).toHaveLength(0);
    expect(parseIpAllowlist(undefined).entries).toHaveLength(0);
    expect(parseIpAllowlist("   ").entries).toHaveLength(0);
  });

  it("THROWS on an unparsable entry (fail-loud at boot, never silently narrower)", () => {
    expect(() => parseIpAllowlist("203.0.113.7,not-an-ip")).toThrow();
    expect(() => parseIpAllowlist("10.0.0.999")).toThrow();
    expect(() => parseIpAllowlist("10.0.0.0/33")).toThrow();
  });

  it("tolerates empty tokens between commas (no address text to misparse)", () => {
    const list = parseIpAllowlist("203.0.113.7,,10.0.0.0/8,");
    expect(list.entries).toHaveLength(2);
  });
});

describe("isIpAllowlisted — socket-source gate", () => {
  const list = parseIpAllowlist("203.0.113.7, 10.0.0.0/8, 2001:db8::/32");

  it("exact-IP match: allowlisted source passes, a different one refuses", () => {
    expect(isIpAllowlisted("203.0.113.7", list)).toBe(true);
    expect(isIpAllowlisted("203.0.113.8", list)).toBe(false);
  });

  it("CIDR containment: inside the range passes, outside refuses", () => {
    expect(isIpAllowlisted("10.1.2.3", list)).toBe(true); // inside 10.0.0.0/8
    expect(isIpAllowlisted("10.255.255.255", list)).toBe(true);
    expect(isIpAllowlisted("11.0.0.1", list)).toBe(false); // one step outside
    expect(isIpAllowlisted("9.255.255.255", list)).toBe(false);
  });

  it("IPv4-mapped-IPv6 socket address normalizes to its IPv4 form before matching", () => {
    // node reports IPv4 sources accepted on a dual-stack socket like this —
    // the raw string form would never match a plain IPv4 entry.
    expect(normalizeRemoteAddress("::ffff:203.0.113.7")?.toString()).toBe("203.0.113.7");
    expect(isIpAllowlisted("::ffff:203.0.113.7", list)).toBe(true);
    expect(isIpAllowlisted("::ffff:10.1.2.3", list)).toBe(true);
    expect(isIpAllowlisted("::ffff:192.168.50.9", list)).toBe(false);
  });

  it("IPv6 entry matches a native IPv6 socket address", () => {
    expect(isIpAllowlisted("2001:db8::1234", list)).toBe(true);
    expect(isIpAllowlisted("2001:db9::1234", list)).toBe(false);
    expect(isIpAllowlisted("::1", list)).toBe(false); // not in 2001:db8::/32
  });

  it("EMPTY allowlist refuses EVERYTHING (fail-closed, D-17)", () => {
    const empty = parseIpAllowlist(undefined);
    expect(isIpAllowlisted("203.0.113.7", empty)).toBe(false);
    expect(isIpAllowlisted("127.0.0.1", empty)).toBe(false);
    expect(isIpAllowlisted("::1", empty)).toBe(false);
  });

  it("an unparsable socket address never matches (fail-closed)", () => {
    expect(isIpAllowlisted("", list)).toBe(false);
    expect(isIpAllowlisted("garbage", list)).toBe(false);
  });
});

describe("isLoopbackRemote — the T-07-19 per-path bind gate helper", () => {
  it("classifies 127.0.0.1, 127.x.x.x, ::1 and the mapped forms as loopback", () => {
    expect(isLoopbackRemote("127.0.0.1")).toBe(true);
    expect(isLoopbackRemote("127.8.8.8")).toBe(true);
    expect(isLoopbackRemote("::1")).toBe(true);
    expect(isLoopbackRemote("::ffff:127.0.0.1")).toBe(true);
  });

  it("classifies LAN/test addresses and garbage as non-loopback", () => {
    expect(isLoopbackRemote("192.168.50.243")).toBe(false);
    expect(isLoopbackRemote("::ffff:192.168.50.243")).toBe(false);
    expect(isLoopbackRemote("203.0.113.10")).toBe(false);
    expect(isLoopbackRemote("")).toBe(false);
  });
});
