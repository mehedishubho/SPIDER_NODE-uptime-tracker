import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Local HTTP fixture target for the SSRF check-pipeline suite (04-03) and the
// worker engine/persistence suites that follow (04-06/04-08 reuse).
//
// A plain node:http server — no DB, no Redis. The caller picks the bind host:
//   "::1"      — the "public stand-in": tests run it under a denylist that
//                omits ONLY the ::1 token (the documented CheckRequest test
//                seam in src/lib/ssrf.ts), so every other protection stays
//                active while the pipeline has something real to dial.
//   "127.0.0.1" — the "private target": stays denied under every denylist the
//                suite uses; its connection/hit counters prove that a denied
//                hop was never dialed.
//
// Routes served:
//   GET /ok                    → 200 text/html
//   GET /notfound              → 404
//   GET /error500              → 500
//   GET /canary                → 200 (assert-zero probe for redirect cases)
//   GET /redirect?to=<enc>     → 302 with Location: <to> (absolute or relative)
//   GET /chain/<n>             → 302 to /chain/<n-1>; /chain/0 → 200
//   GET /oversized             → 3 MB CHUNKED body (no Content-Length) — the
//                                streamed-cap probe (D-43)
//   GET /lying-length          → Content-Length: 1024 but writes 3 MB — the
//                                lying-header probe (D-43; undici's parser
//                                truncates at the declared length, proving
//                                the declared length is never a bypass)
//   GET /hang                  → accepts the request, never responds
// ---------------------------------------------------------------------------

const OVERSIZED_TOTAL_BYTES = 3 * 1024 * 1024;
const OVERSIZED_CHUNK_BYTES = 64 * 1024;

export interface CheckTargetHandle {
  readonly host: string;
  readonly port: number;
  /** `http://[::1]:<port>` or `http://127.0.0.1:<port>`. */
  readonly origin: string;
  url(path: string): string;
  /** Requests received for an exact pathname (query-free). */
  hits(path: string): number;
  /** TCP connections accepted since startup. */
  totalConnections(): number;
  /** Cumulative bytes handed to the socket by the oversized-body routes. */
  oversizedBytesWritten(): number;
  close(): Promise<void>;
}

export async function startCheckTarget(
  host: "::1" | "127.0.0.1"
): Promise<CheckTargetHandle> {
  const hits = new Map<string, number>();
  let connections = 0;
  let oversizedBytes = 0;

  function streamOversized(res: http.ServerResponse, declareLength: boolean): void {
    const chunk = Buffer.alloc(OVERSIZED_CHUNK_BYTES, 0x78);
    if (declareLength) res.setHeader("Content-Length", "1024"); // the lie
    res.on("error", () => {
      /* client abort mid-write — the counter simply freezes */
    });
    let sent = 0;
    const pump = (): void => {
      // Stop once the client goes away: writes throw (or drain never fires)
      // after the aborted socket is torn down, so the counter cannot run to
      // the full 3 MB when the pipeline stops consuming at its cap.
      while (sent < OVERSIZED_TOTAL_BYTES) {
        sent += chunk.length;
        oversizedBytes += chunk.length;
        let writable = true;
        try {
          writable = res.write(chunk);
        } catch {
          return; // socket already destroyed
        }
        if (!writable) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
  }

  const server = http.createServer((req, res) => {
    const pathname = req.url?.split("?")[0] ?? "/";
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);

    if (pathname === "/ok") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>fixture ok page</body></html>");
      return;
    }
    if (pathname === "/canary") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("canary");
      return;
    }
    if (pathname === "/notfound") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    if (pathname === "/error500") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("fixture failure");
      return;
    }
    if (pathname === "/redirect") {
      const target = new URL(req.url ?? "/", "http://fixture.invalid")
        .searchParams.get("to");
      if (!target) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("missing ?to=");
        return;
      }
      res.writeHead(302, { Location: target });
      res.end();
      return;
    }
    const chainMatch = /^\/chain\/(\d+)$/.exec(pathname);
    if (chainMatch) {
      const remaining = Number(chainMatch[1]);
      if (remaining === 0) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("chain end");
        return;
      }
      res.writeHead(302, { Location: `/chain/${remaining - 1}` });
      res.end();
      return;
    }
    if (pathname === "/oversized") {
      streamOversized(res, false);
      return;
    }
    if (pathname === "/lying-length") {
      streamOversized(res, true);
      return;
    }
    if (pathname === "/hang") {
      // Intentionally never respond — the caller's injected timeoutMs is the
      // behavior under test; close() tears the socket down via
      // closeAllConnections().
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("unknown route");
  });

  server.on("connection", () => {
    connections += 1;
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const origin = host === "::1" ? `http://[::1]:${port}` : `http://${host}:${port}`;

  return {
    host,
    port,
    origin,
    url(path: string): string {
      return `${origin}${path}`;
    },
    hits(path: string): number {
      return hits.get(path) ?? 0;
    },
    totalConnections(): number {
      return connections;
    },
    oversizedBytesWritten(): number {
      return oversizedBytes;
    },
    async close(): Promise<void> {
      server.closeAllConnections(); // kill /hang sockets and stalled pumps
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
