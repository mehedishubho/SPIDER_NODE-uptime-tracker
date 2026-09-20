import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { Response as UndiciResponse } from "undici";

// ---------------------------------------------------------------------------
// SSRF-hardened check pipeline — the D-38 canonical module (SEC-01 / WRK-05 /
// DAT-10).
//
// One exported check pipeline shared by the worker check engine (04-06) and,
// from Phase 6 on, by the web-side monitor create/update validation — no
// copy, no drift (D-38). Transcription sources: audit §15.1 step 4 (the five
// ordered sub-steps below), 04-RESEARCH Pattern 9, DEPLOY-RUNBOOK §10 (the
// operator-side mirror of DENYLIST — the three lists are ONE list; extend all
// three in the same change or the 04-09 D-40 diff gate fails).
//
// Layering (in execution order):
//   1. Scheme allowlist — http/https only, rejected BEFORE any network I/O.
//   2. Resolve-then-validate with canonicalization — dns.lookup({all:true}),
//      every returned address canonicalized (brackets stripped, lowercased,
//      zone ids dropped, ::ffff:0:0/96 and 64:ff9b::/96 embedded IPv4
//      extracted) before the 11-token CIDR denylist test; ANY denied
//      address denies the whole host.
//   3. Connection-time pinning — the dial goes through an undici Agent whose
//      custom lookup answers ONLY from the resolve-time validated address
//      map (DNS-rebinding / TOCTOU defense, §15.1 sub-step 3). Plain global
//      fetch is structurally absent from this module.
//   4. Manual redirect loop — redirect:"manual"; every Location target is
//      resolved against the current URL and re-runs layers 1-2 BEFORE the
//      hop is followed; max 5 redirects; no-validation-no-follow (D-41).
//   5. Streamed body cap + strict timeout — body bytes are counted as they
//      stream and the read aborts past 2 MB (Content-Length is NEVER
//      trusted, D-43); one AbortController enforces the whole exchange —
//      DNS, connect, redirects, capped read — inside the 10 s budget.
//
// Classification contract (WRK-05): target behavior NEVER throws. Timeouts,
// DNS failures, TLS failures, SSRF blocks, oversized bodies, 5xx — all are
// successful checks carrying a typed DOWN outcome. Only infrastructure
// failures (resolver outage, internal bugs) throw; isInfraFailure() is the
// classifier the circuit breaker (04-06) applies to thrown errors.
//
// Behavior parity with the legacy engine (src/lib/cron-logic.ts lines
// 56-94): GET, cache no-store, identical User-Agent/Accept headers,
// performance.now() timing at final-header arrival (redirects included),
// UP = statusCode >= 200 && < 400.
// ---------------------------------------------------------------------------

/** §15.1 step 4 sub-step 2 / §15.4 / runbook §10 — the one list in three statements. */
export const DENYLIST: string[] = [
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
];

/** §15.3 — strict whole-exchange budget (DNS + connect + redirects + capped read). */
export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** §15.3 — redirect chain bound; every hop is re-validated regardless. */
export const MAX_REDIRECT_HOPS = 5;

/** §15.3 — memory-exhaustion bound, enforced on the streamed body (D-43). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * §11 / §15.1 step 5 error_class vocabulary (DAT-10) — the exact values the
 * Tier 1/Tier 2 writers record into pings.error_class / incidents metadata.
 * Lowercase per the audit's vocabulary; ssrf_blocked covers every layer-1/2/4
 * validation refusal (scheme, denylist, cap, unpinnable hop).
 */
export type ErrorClass =
  | "timeout"
  | "dns"
  | "tls"
  | "ssrf_blocked"
  | "http_5xx"
  | "network";

export interface CheckRequest {
  url: string;
  /**
   * Whole-exchange budget override. Production callers use the 10 s default
   * (§15.3 non-negotiable); the seam exists so tests run in milliseconds.
   */
  timeoutMs?: number;
  /**
   * TEST-ONLY SEAM — defaults to DENYLIST and must stay unset in production
   * callers. Fixture-based tests run on a single machine where the fixture
   * server can only bind a loopback address the real denylist rightly blocks;
   * tests pass `DENYLIST.filter((t) => t !== "::1")` (or similar) so every
   * other token — and therefore every layer of the pipeline — stays active.
   * The 04-09 D-40 gate reads the DEFAULT DENYLIST export, never this field.
   */
  denylist?: string[];
}

/** WRK-05: a check result — target outcomes are data, never exceptions. */
export type CheckOutcome =
  | { kind: "up"; statusCode: number; responseTimeMs: number }
  | {
      kind: "down";
      statusCode: number | null;
      /** Omitted when the status alone carries the classification (e.g. 4xx). */
      errorClass?: ErrorClass;
      responseTimeMs: number;
    };

// --- request parity (cron-logic.ts lines 63-74 — character-for-character) ---

const PARITY_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; UptimeTrackerBot/1.0)",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
} as const;

// --- CIDR machinery ----------------------------------------------------------

interface CidrBlock {
  family: 4 | 6;
  value: bigint;
  prefix: number;
  bits: 32 | 128;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIPv4(addr: string): bigint | null {
  const match = IPV4_RE.exec(addr);
  if (!match) return null;
  let value = BigInt(0);
  for (const part of match.slice(1)) {
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << BigInt(8)) | BigInt(octet);
  }
  return value;
}

interface IPv6Groups {
  groups: number[];
  /** Dotted-quad tail, when the textual form ends in one (e.g. ::ffff:10.0.0.1). */
  v4: bigint | null;
}

function parseIPv6Groups(side: string): IPv6Groups | null {
  if (side === "") return { groups: [], v4: null };
  const segments = side.split(":");
  const groups: number[] = [];
  let v4: bigint | null = null;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.includes(".")) {
      // Embedded dotted quad — only valid as the rightmost group of the tail.
      const quad = parseIPv4(segment);
      if (quad === null || i !== segments.length - 1) return null;
      v4 = quad;
      groups.push(
        Number((quad >> BigInt(16)) & BigInt("0xffff")),
        Number(quad & BigInt("0xffff"))
      );
    } else if (/^[0-9a-f]{1,4}$/.test(segment)) {
      groups.push(parseInt(segment, 16));
    } else {
      return null;
    }
  }
  return { groups, v4 };
}

// BigInt literals are unavailable below the repo's ES2017 tsconfig target, so
// every constant below uses the BigInt() constructor form instead.
const ZERO = BigInt(0);

/** Top 96 bits of ::ffff:0:0/96 — the IPv4-mapped prefix (bits 32..95 = ffff). */
const MAPPED_V6_TOP96 = BigInt("0xffff");
/** Top 96 bits of 64:ff9b::/96 — the NAT64 prefix. */
const NAT64_TOP96 = BigInt("0x0064ff9b000000000000");

function parseIPv6(addr: string): { value: bigint; embeddedV4: bigint | null } | null {
  const first = addr.indexOf("::");
  if (first !== addr.lastIndexOf("::")) return null;
  const hasEllipsis = first !== -1;
  const left = parseIPv6Groups(hasEllipsis ? addr.slice(0, first) : addr);
  const right = hasEllipsis
    ? parseIPv6Groups(addr.slice(first + 2))
    : { groups: [], v4: null };
  if (left === null || right === null) return null;
  if (left.v4 !== null) return null; // dotted quad belongs in the tail only
  const missing = 8 - left.groups.length - right.groups.length;
  if (hasEllipsis ? missing < 0 : missing !== 0) return null;
  const groups = [
    ...left.groups,
    ...new Array<number>(hasEllipsis ? missing : 0).fill(0),
    ...right.groups,
  ];
  let value = ZERO;
  for (const group of groups) value = (value << BigInt(16)) | BigInt(group);
  // Canonicalization (WR-01 / TC-SSRF-MAPPED-V6-01): inside the IPv4-mapped
  // and NAT64 /96 ranges the low 32 bits ARE an IPv4 address and must be
  // tested against the IPv4 denylist as that address — the raw mapped literal
  // matches none of the legacy IPv6 ranges.
  const top96 = value >> BigInt(32);
  const embeddedV4 =
    top96 === MAPPED_V6_TOP96 || top96 === NAT64_TOP96
      ? value & BigInt("0xffffffff")
      : null;
  return { value, embeddedV4 };
}

/**
 * The §15.1/runbook §10 notation writes IPv4 bases in shorthand — `10/8`,
 * `172.16/12`, `169.254/16` — zero-padding to `10.0.0.0`, `172.16.0.0`,
 * `169.254.0.0`. Tokens are contract-fixed, so the parser honors the
 * documented form rather than demanding full quads.
 */
function expandIPv4Shorthand(part: string): string {
  if (part.includes(":")) return part;
  const groups = part.split(".");
  if (groups.length === 0 || groups.length > 4) return part;
  if (groups.some((g) => g === "" || !/^\d{1,3}$/.test(g))) return part;
  while (groups.length < 4) groups.push("0");
  return groups.join(".");
}

function parseCidr(token: string): CidrBlock | null {
  const slash = token.indexOf("/");
  let ipPart = slash === -1 ? token : token.slice(0, slash);
  let family = isIP(ipPart);
  if (family === 0) {
    const expanded = expandIPv4Shorthand(ipPart);
    if (expanded !== ipPart && isIP(expanded) === 4) {
      ipPart = expanded;
      family = 4;
    }
  }
  if (family !== 4 && family !== 6) return null;
  const value = family === 4 ? parseIPv4(ipPart) : parseIPv6(ipPart)?.value ?? null;
  if (value === null) return null;
  const bits = family === 4 ? 32 : 128;
  const prefix = slash === -1 ? bits : Number(token.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const networkMask =
    prefix === 0
      ? ZERO
      : ((BigInt(1) << BigInt(prefix)) - BigInt(1)) << BigInt(bits - prefix);
  return { family, value: value & networkMask, prefix, bits };
}

function parseDenylist(tokens: string[]): CidrBlock[] {
  const blocks = tokens.map(parseCidr).filter((b): b is CidrBlock => b !== null);
  if (blocks.length !== tokens.length) {
    // Fail closed: an unparseable token means the denylist itself is broken —
    // that is a deployment error, not a per-target outcome.
    throw new Error(
      "[ssrf] denylist contains unparseable CIDR tokens — refusing to run"
    );
  }
  return blocks;
}

function matchesBlock(block: CidrBlock, family: 4 | 6, value: bigint): boolean {
  if (block.family !== family) return false;
  const shift = BigInt(block.bits - block.prefix);
  return value >> shift === block.value >> shift;
}

/**
 * Canonicalize `addr` (strip brackets, lowercase, drop the zone id) and test
 * every legal form of it — raw IPv4, raw IPv6, and the embedded IPv4 of a
 * mapped/NAT64 address — against the denylist. Unparseable address-shaped
 * input fails CLOSED (denied): it can never come from a real resolver or URL
 * literal, so treating it as denied is the only safe reading.
 */
function addressIsDenied(addr: string, blocks: CidrBlock[]): boolean {
  let host = addr.trim().toLowerCase();
  host = host.replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
  if (host === "") return true;
  const asV4 = parseIPv4(host);
  if (asV4 !== null) {
    return blocks.some((b) => matchesBlock(b, 4, asV4));
  }
  if (host.includes(":")) {
    const parsed = parseIPv6(host);
    if (parsed === null) return true; // fail closed on unparseable
    if (blocks.some((b) => matchesBlock(b, 6, parsed.value))) return true;
    if (
      parsed.embeddedV4 !== null &&
      blocks.some((b) => matchesBlock(b, 4, parsed.embeddedV4 as bigint))
    ) {
      return true;
    }
    return false;
  }
  // A plain name never reaches this function from the resolve path (addresses
  // only); from the literal path isIP() already routed real literals above.
  return true; // fail closed: name-shaped "address" input is a bug
}

// --- error classification ----------------------------------------------------

const TARGET_DNS_CODES = new Set(["ENOTFOUND", "ENODATA", "EAI_NODATA", "EAI_NONAME"]);
const RESOLVER_OUTAGE_CODES = new Set(["EAI_AGAIN", "EAI_FAIL", "EAI_MEMORY"]);
const TARGET_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EPROTO",
]);

/** Custom errno for the pinned-dial refusal (§15.1 sub-step 3 → ssrf_blocked). */
const PIN_VIOLATION_CODE = "ESSRF_PIN_VIOLATION";

function rootCause(err: unknown): unknown {
  let current: unknown = err;
  const seen = new Set<unknown>([current]);
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === null || seen.has(cause)) break;
    seen.add(cause);
    current = cause;
  }
  return current;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

/**
 * Infra-vs-target classifier for THROWN errors (WRK-05 — consumed by the 04-06
 * circuit breaker). performCheck throws only for infrastructure failures;
 * this function is the standalone equivalent for errors escaping any caller
 * path:
 *   - resolver outage (EAI_AGAIN / EAI_FAIL / EAI_MEMORY) → infra
 *   - target NXDOMAIN, socket-layer, TLS, and target-timeout aborts → target
 *   - anything unclassifiable (TypeErrors, internal bugs) → infra (§15.1
 *     step 5: "internal exceptions/bugs" are the infra class)
 */
export function isInfraFailure(err: unknown): boolean {
  const cause = rootCause(err) ?? err;
  const code = errorCode(cause);
  if (RESOLVER_OUTAGE_CODES.has(code)) return true;
  if (TARGET_DNS_CODES.has(code)) return false;
  if (
    (cause as { name?: unknown } | null | undefined)?.name === "AbortError" ||
    code === "UND_ERR_ABORTED" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return false;
  }
  if (TARGET_SOCKET_CODES.has(code)) return false;
  if (/SSL|TLS|CERT/i.test(code)) return false;
  if (code.startsWith("UND_ERR_")) return false;
  return true;
}

// --- hop validation (layers 1-2) ----------------------------------------------

type HopValidation =
  | {
      ok: true;
      url: URL;
      host: string;
      addresses: { address: string; family: number }[];
    }
  | { ok: false; errorClass: "ssrf_blocked" | "dns" | "timeout" };

function abortError(): Error {
  const err = new Error("check aborted: whole-exchange timeout") as Error & {
    name: string;
  };
  err.name = "AbortError";
  return err;
}

/** DNS resolution raced against the check budget (§15.3: DNS counts). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function validateHop(
  urlString: string,
  blocks: CidrBlock[],
  signal: AbortSignal
): Promise<HopValidation> {
  // Layer 1 — scheme allowlist, before ANY network I/O (TC-SSRF-SCHEME-01).
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, errorClass: "ssrf_blocked" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, errorClass: "ssrf_blocked" };
  }
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (host === "") return { ok: false, errorClass: "ssrf_blocked" };

  // Literal-IP hosts never touch DNS; the literal IS the dial target, so
  // validating it directly pins the connection (WHATWG URL parsing has
  // already normalized short/decimal/hex IPv4 forms like 127.1 / 2130706433
  // down to dotted quads before we ever see them — D-42).
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    if (addressIsDenied(host, blocks)) {
      return { ok: false, errorClass: "ssrf_blocked" };
    }
    return { ok: true, url, host, addresses: [{ address: host, family: literalFamily }] };
  }

  // Layer 2 — resolve-then-validate; ANY denied address denies the host.
  let entries: LookupAddress[];
  try {
    entries = await raceAbort(dnsLookup(host, { all: true }), signal);
  } catch (err) {
    if (signal.aborted) return { ok: false, errorClass: "timeout" };
    const code = errorCode(rootCause(err) ?? err);
    if (TARGET_DNS_CODES.has(code)) {
      return { ok: false, errorClass: "dns" }; // target NXDOMAIN (§15.2)
    }
    throw err; // resolver outage (EAI_AGAIN/...) — infrastructure failure
  }
  for (const entry of entries) {
    if (addressIsDenied(entry.address, blocks)) {
      return { ok: false, errorClass: "ssrf_blocked" };
    }
  }
  return {
    ok: true,
    url,
    host,
    addresses: entries.map((e) => ({ address: e.address, family: e.family })),
  };
}

// --- layer 3 — connection pinning ----------------------------------------------

function buildPinnedAgent(
  pinnedHosts: Map<string, { address: string; family: number }[]>
): Agent {
  const pinnedLookup: LookupFunction = (hostname, options, callback) => {
    const pinned = pinnedHosts.get(hostname.toLowerCase());
    if (!pinned || pinned.length === 0) {
      // §15.1 sub-step 3: a dial to anything outside the resolve-time
      // validated set aborts the connection → DOWN ssrf_blocked. This can
      // only fire on an internal wiring bug (every fetch is preceded by a
      // validateHop registration), so failing closed here is the backstop.
      const err = new Error("refused dial outside the validated address set");
      (err as NodeJS.ErrnoException).code = PIN_VIOLATION_CODE;
      callback(err, "");
      return;
    }
    if (options.all) {
      callback(
        null,
        pinned.map((e) => ({ address: e.address, family: e.family }))
      );
    } else {
      callback(null, pinned[0].address, pinned[0].family);
    }
  };
  return new Agent({ connect: { lookup: pinnedLookup } });
}

// --- layer 5 — streamed body cap ------------------------------------------------

type ReadOutcome = "complete" | "capped" | "timeout" | "reset";

async function readCapped(
  response: UndiciResponse,
  signal: AbortSignal
): Promise<ReadOutcome> {
  const body = response.body;
  if (!body) return "complete";
  const reader = body.getReader();
  let counted = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return "complete";
      if (value) counted += value.byteLength;
      if (counted > MAX_BODY_BYTES) {
        // D-43 / TC-SSRF-SIZE-CAP-01: abort the read at the cap; the outcome
        // stays header-derived. Content-Length was never consulted.
        await reader.cancel().catch(() => {});
        return "capped";
      }
    }
  } catch {
    if (signal.aborted) return "timeout"; // body hung past the budget → DOWN timeout
    // Mid-body transport failure AFTER headers: the legacy engine never read
    // bodies, so classification stays header-derived — parity preserved.
    return "reset";
  }
}

// --- transport error classification ---------------------------------------------

function classifyTransportError(
  err: unknown,
  signal: AbortSignal,
  elapsed: () => number
): CheckOutcome {
  const down = (errorClass: ErrorClass): CheckOutcome => ({
    kind: "down",
    statusCode: null,
    errorClass,
    responseTimeMs: elapsed(),
  });
  if (signal.aborted) return down("timeout");
  const cause = rootCause(err) ?? err;
  const code = errorCode(cause);
  if (code === PIN_VIOLATION_CODE) return down("ssrf_blocked");
  if (/SSL|TLS|CERT/i.test(code)) return down("tls");
  return down("network");
}

// --- the pipeline ----------------------------------------------------------------

/**
 * Perform one SSRF-hardened uptime check (§15.1 step 4). Target behavior —
 * including every SSRF refusal — returns a CheckOutcome and NEVER throws
 * (WRK-05). Throws only for infrastructure failures (resolver outage,
 * internal bugs); pair with isInfraFailure for breaker accounting.
 */
export async function performCheck(req: CheckRequest): Promise<CheckOutcome> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const blocks = parseDenylist(req.denylist ?? DENYLIST);
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Layer 3 — the ONLY name→address path undici may dial through. It answers
  // exclusively from the map that validateHop populates after layers 1-2
  // pass, so a rebound DNS answer between validation and connect cannot
  // redirect the socket (TOCTOU defense, T-04-09).
  const pinnedHosts = new Map<string, { address: string; family: number }[]>();
  const agent = buildPinnedAgent(pinnedHosts);

  try {
    let currentUrl = req.url;
    let redirects = 0;
    let response: UndiciResponse | null = null;
    let terminalAt: number | null = null;

    // Layer 4 — manual redirect loop, ≤ MAX_REDIRECT_HOPS followed hops.
    while (true) {
      const hop = await validateHop(currentUrl, blocks, controller.signal);
      if (!hop.ok) {
        return {
          kind: "down",
          statusCode: null,
          errorClass: hop.errorClass,
          responseTimeMs: elapsed(),
        };
      }
      pinnedHosts.set(hop.host.toLowerCase(), hop.addresses);

      let pending: UndiciResponse;
      try {
        pending = await undiciFetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          cache: "no-store",
          headers: PARITY_HEADERS,
          signal: controller.signal,
          dispatcher: agent,
        });
      } catch (err) {
        return classifyTransportError(err, controller.signal, elapsed);
      }

      const location = pending.headers.get("location");
      const isRedirect =
        pending.status >= 300 &&
        pending.status < 400 &&
        location !== null &&
        location !== "";

      if (!isRedirect) {
        response = pending;
        terminalAt = elapsed(); // parity: timing at final-header arrival
        break;
      }

      // Validate the Location target BEFORE following it (D-41): resolve the
      // header against the current URL, then let the next loop iteration run
      // layers 1-2 on the absolute target. Cap refusal is ssrf_blocked
      // (§15.1 sub-step 4); an unresolvable/unparseable hop is NOT followed.
      if (redirects >= MAX_REDIRECT_HOPS) {
        await pending.body?.cancel().catch(() => {});
        return {
          kind: "down",
          statusCode: null,
          errorClass: "ssrf_blocked",
          responseTimeMs: elapsed(),
        };
      }
      let next: URL;
      try {
        next = new URL(location, hop.url);
      } catch {
        await pending.body?.cancel().catch(() => {});
        return {
          kind: "down",
          statusCode: null,
          errorClass: "ssrf_blocked",
          responseTimeMs: elapsed(),
        };
      }
      await pending.body?.cancel().catch(() => {}); // release the 3xx socket
      currentUrl = next.toString();
      redirects++;
    }

    // Layer 5 — streamed cap inside the whole-exchange budget.
    const read = await readCapped(response as UndiciResponse, controller.signal);
    if (read === "timeout") {
      return {
        kind: "down",
        statusCode: (response as UndiciResponse).status,
        errorClass: "timeout",
        responseTimeMs: elapsed(),
      };
    }
    const statusCode = (response as UndiciResponse).status;
    const responseTimeMs = terminalAt as number;
    // Parity: 200-399 is UP (3xx terminals like 304 Not Modified included —
    // the legacy follow-mode fetch counted them the same way).
    if (statusCode >= 200 && statusCode < 400) {
      return { kind: "up", statusCode, responseTimeMs };
    }
    return {
      kind: "down",
      statusCode,
      errorClass: statusCode >= 500 ? "http_5xx" : undefined,
      responseTimeMs,
    };
  } finally {
    clearTimeout(timer);
    agent.close().catch(() => {
      /* teardown must never mask the outcome */
    });
  }
}

// --- DNS-only admission (Phase 6 / D-23) ---------------------------------------

/**
 * D-32/D-23: the typed admission refusal. The message is the user-actionable
 * body routes forward VERBATIM as a 400 — it must never carry resolution
 * internals (resolved addresses, the queried hostname, denylist tokens).
 */
export class UrlNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlNotAllowedError";
  }
}

/** User-facing refusal message per admission failure class (D-32). */
const ADMISSION_MESSAGES: Record<"ssrf_blocked" | "dns" | "timeout", string> = {
  ssrf_blocked: "URL is not allowed: only public http(s) targets are permitted",
  dns: "URL host could not be found — check the address and try again",
  timeout: "URL could not be verified in time — please try again",
};

/**
 * D-23: DNS-only admission for user-supplied monitor URLs at create/update.
 * Runs layers 1-2 of the check pipeline — scheme allowlist, then
 * resolve-then-denylist — and NOTHING else: admission never dials the target,
 * it only resolves the name (no fetch, no redirect walk, no body read).
 * Literal-IP hosts skip resolution entirely (the literal is validated as-is).
 *
 * Rejects with UrlNotAllowedError for every target-side refusal — private
 * range, forbidden scheme, NXDOMAIN, admission timeout. Resolver-level
 * infrastructure failures (EAI_AGAIN/...) propagate UNWRAPPED so the caller
 * answers 500: admission fails closed and is never laundered into a pass or
 * a user-error 400.
 */
export async function assertUrlAllowed(url: string): Promise<void> {
  const blocks = parseDenylist(DENYLIST);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_CHECK_TIMEOUT_MS);
  try {
    const hop = await validateHop(url, blocks, controller.signal);
    if (!hop.ok) {
      throw new UrlNotAllowedError(ADMISSION_MESSAGES[hop.errorClass]);
    }
  } finally {
    clearTimeout(timer);
  }
}
