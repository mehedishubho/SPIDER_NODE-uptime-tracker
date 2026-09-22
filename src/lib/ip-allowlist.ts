import ipaddr from "ipaddr.js";
import type { IPv4, IPv6 } from "ipaddr.js";

// ---------------------------------------------------------------------------
// ADMIN_IP_ALLOWLIST parsing + matching (D-17, 07-05) — the socket-source
// allowlist in front of the worker's Bull Board mount (/admin/queues on
// :9090). Two named exports, one semantics pair:
//
//   parseIpAllowlist(raw)  — splits the env value on commas and parses each
//     entry into an exact-address or CIDR form via ipaddr.js (the research
//     "Don't Hand-Roll CIDR" row: a subnet bug here is an auth bypass). An
//     UNPARSABLE entry THROWS — fail-loud at boot (06 D-11 convention); a
//     silently narrower allowlist would read as an intermittent lockout.
//     An empty/undefined raw yields an EMPTY allowlist.
//
//   isIpAllowlisted(remoteAddress, list) — the socket-side check. The socket
//     address is NORMALIZED first: node reports IPv4 sources accepted on a
//     dual-stack socket in IPv4-mapped form ("::ffff:127.0.0.1"), which must
//     compare equal to the plain IPv4 entry the operator wrote. TRUE on
//     exact match or CIDR containment. An EMPTY allowlist refuses EVERYTHING
//     (fail-closed — the queue UI is unreachable until the operator
//     configures the env; D-17's "empty = allow nobody" .env.example pin).
//
// The caller keys on req.socket.remoteAddress ONLY — a forwarded-for style
// header is spoofable and never grants access (plan prohibition / T-07-18).
// ---------------------------------------------------------------------------

/** Either parsed address family (ipaddr.js's union). */
export type IPAddress = IPv4 | IPv6;

/** One allowlist entry: an exact address (prefixLength null) or a CIDR block. */
export interface IPAllowlistEntry {
  readonly addr: IPAddress;
  /** null = exact address entry; number = CIDR prefix length. */
  readonly prefixLength: number | null;
}

/** The parsed ADMIN_IP_ALLOWLIST — an immutable entry list. */
export interface IPAllowlist {
  readonly entries: readonly IPAllowlistEntry[];
}

/**
 * Normalizes a socket remote address into a comparable ipaddr.js object:
 * IPv4-mapped IPv6 ("::ffff:a.b.c.d" — how node reports IPv4 sources on a
 * dual-stack socket) converts to its IPv4 form; anything unparsable (empty
 * string, unix-socket placeholder, garbage) returns null — the caller
 * refuses (fail-closed).
 */
export function normalizeRemoteAddress(remoteAddress: string): IPAddress | null {
  const trimmed = remoteAddress.trim();
  if (trimmed === "") return null;
  try {
    const parsed = ipaddr.parse(trimmed);
    // instanceof (not the kind() string) — the class is what narrows the
    // union for toIPv4Address() below.
    if (parsed instanceof ipaddr.IPv6 && parsed.range() === "ipv4Mapped") {
      return parsed.toIPv4Address();
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Parses one comma-separated allowlist entry. Throws on garbage (fail-loud
 * at boot — never silently narrower).
 */
function parseAllowlistEntry(entry: string): IPAllowlistEntry {
  if (entry.includes("/")) {
    const [addr, prefixLength] = ipaddr.parseCIDR(entry);
    return { addr, prefixLength };
  }
  return { addr: ipaddr.parse(entry), prefixLength: null };
}

/**
 * Parses the ADMIN_IP_ALLOWLIST env value (IPs/CIDRs, comma-separated —
 * D-17). Empty/undefined yields an EMPTY allowlist (fail-closed at the
 * consumer); a malformed entry throws so the misconfiguration surfaces at
 * boot, not as an unexplained refusal later.
 */
export function parseIpAllowlist(raw: string | undefined): IPAllowlist {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { entries: [] };
  const entries: IPAllowlistEntry[] = [];
  for (const token of trimmed.split(",")) {
    const entry = token.trim();
    if (entry === "") continue; // tolerate ",," / trailing commas — no address text
    entries.push(parseAllowlistEntry(entry));
  }
  return { entries };
}

/**
 * The socket-source allowlist check (D-17): true when the remote address
 * exactly matches an entry or falls inside an entry's CIDR block. An EMPTY
 * allowlist returns false for EVERYTHING, and an unparsable remote address
 * never matches — both directions fail closed.
 */
export function isIpAllowlisted(remoteAddress: string, list: IPAllowlist): boolean {
  if (list.entries.length === 0) return false;
  const remote = normalizeRemoteAddress(remoteAddress);
  if (!remote) return false;
  return list.entries.some((entry) => {
    if (entry.addr.kind() !== remote.kind()) return false;
    if (entry.prefixLength === null) {
      return entry.addr.toString() === remote.toString();
    }
    return remote.match([entry.addr, entry.prefixLength]);
  });
}

/**
 * Loopback classification for the Pitfall-8 bind decision (T-07-19): true
 * for 127.0.0.0/8 and ::1 (an IPv4-mapped loopback source normalizes to its
 * IPv4 form first). The health server uses this to keep healthz/readyz/
 * metrics loopback-source-only when the port binds a non-loopback host for
 * /admin/queues.
 */
export function isLoopbackRemote(remoteAddress: string): boolean {
  const remote = normalizeRemoteAddress(remoteAddress);
  if (!remote) return false;
  return remote.range() === "loopback";
}
