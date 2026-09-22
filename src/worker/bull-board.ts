import type { IncomingMessage, ServerResponse } from "node:http";
import type pino from "pino";
import type { Queue } from "bullmq";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildLogger } from "./logger";
import type { WorkerQueueSet } from "./queues";

// ---------------------------------------------------------------------------
// The gated Bull Board mount (OBS-04/SEC-04, 07-05) — the operator's
// emergency queue lever (D-19) on the worker's EXISTING :9090 health server
// (D-18: no second port, no Express, and zero of this in the web bundle).
//
// Mount shape = bull-board's own with-hono example (07-RESEARCH Pattern 6,
// verbatim API): createBullBoard + a BullMQAdapter per queue lane +
// HonoAdapter(serveStatic), basePath "/admin/queues", the plugin routed on a
// Hono app — then bridged onto the node:http req/res pair via
// @hono/node-server's getRequestListener (A5: serve() itself is built on the
// same listener, so the static UI assets serve under the bridge too — proven
// by the static-asset case in tests/worker/bull-board-gate.test.ts).
//
// GATE CHAIN (enforced in order; refusals are answered by OUR server code —
// 403 JSON + the D-16 audit line — NEVER by Bull Board, which only ever sees
// a request past both gates, T-07-20):
//
//   Gate 1 (health.ts, the delegation branch): the socket-source IP
//     allowlist (D-17) — isIpAllowlisted(req.socket.remoteAddress) against
//     the parsed ADMIN_IP_ALLOWLIST. NEVER a forwarded-for style header
//     (spoofable — plan prohibition / T-07-18).
//   Gate 2 (here, before any bridging): a Better Auth ADMIN session —
//     auth.api.getSession({ headers }) on the SAME createAuth() instance the
//     web app uses (Assumption A2 — no hand-rolled token-hash lookup), with
//     session.user.role === "admin" (D-13's role primitive).
//
// Every hit — allowed or refused — emits ONE structured D-16 line (userId or
// "anonymous", route, ip, timestamp) via the worker pino child logger.
//
// Mutation powers stay ENABLED (D-19): no disableList/disableAdd/disableDrain
// options anywhere — the two gates ARE the controls. This is why the
// delegation branch must sit BEFORE health.ts's GET/HEAD-only 405 gate: the
// UI's retry/remove/drain actions are POST/DELETE.
// ---------------------------------------------------------------------------

/** The single mount path on the worker health server (D-18). */
export const BULL_BOARD_BASE_PATH = "/admin/queues";

/** The D-16 audit marker — grep anchor for the rehearsal/deploy evidence. */
export const BULL_BOARD_AUDIT_MARKER = "bull-board-access";

/**
 * The auth surface bull-board.ts needs (structural on purpose — the
 * metricsRegistry injection precedent): the real object is the shared
 * Better Auth instance from @/lib/auth; tests drive the same real instance.
 */
export interface BullBoardAuth {
  api: {
    getSession(args: { headers: Headers }): Promise<
      | {
          user?: {
            id?: string;
            role?: string | null;
          };
        }
      | null
    >;
  };
}

export interface BullBoardHandlerDeps {
  /**
   * The SHARED Better Auth instance (createAuth() from @/lib/auth — A2).
   * The worker boot injects the same singleton the web routes use.
   */
  auth: BullBoardAuth;
  /** Injectable pino logger (defaults to the worker base logger). */
  logger?: pino.Logger;
}

/**
 * The /admin/queues handler health.ts delegates to (after its Gate 1) — a
 * callable with one attached helper so the ENTIRE D-16 audit stream flows
 * through THIS handler's single (injectable) child logger: Gate 1 refusals
 * are still DECIDED by health.ts (the socket-source allowlist lives there),
 * but their refusal response + audit line are emitted here, keeping every
 * line's shape byte-identical regardless of which gate refused.
 */
export interface BullBoardHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * health.ts's Gate 1 refusal path: emits the D-16 line (userId
   * "anonymous" — the session is deliberately not consulted before the IP
   * gate) and answers 403 JSON. Never called by Bull Board.
   */
  refuseAndAudit(
    req: IncomingMessage,
    res: ServerResponse,
    reason: "ip_not_allowlisted"
  ): Promise<void>;
}

/** One D-16 audit line's bindings (userId, route, ip, timestamp + outcome). */
function emitAccessAudit(
  log: pino.Logger,
  fields: {
    userId: string;
    route: string;
    ip: string;
    allowed: boolean;
    reason: "allowed" | "no_session" | "not_admin" | "ip_not_allowlisted";
  }
): void {
  log[fields.allowed ? "info" : "warn"](
    {
      marker: BULL_BOARD_AUDIT_MARKER,
      userId: fields.userId,
      route: fields.route,
      ip: fields.ip,
      timestamp: new Date().toISOString(),
      allowed: fields.allowed,
      reason: fields.reason,
    },
    `admin queue surface access (D-16) — ${fields.reason}`
  );
}

function respond403(res: ServerResponse): void {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "forbidden" }));
}

/** Builds a Fetch-API Headers from the node:req header map (house pattern). */
function headersFromNodeRequest(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.append(key, value);
    }
  }
  return headers;
}

/**
 * Mounts Bull Board over the worker's queue set and returns the handler that
 * runs Gate 2 (admin session), emits the D-16 audit line, and only then
 * bridges the request into the hono app. Gate 1 (the D-17 socket-source
 * allowlist) runs in health.ts's delegation branch BEFORE this handler —
 * the refuser there is health.ts itself (403 + audit line), never Bull Board.
 */
export function createBullBoardHandler(
  queues: WorkerQueueSet,
  deps: BullBoardHandlerDeps
): BullBoardHandler {
  const log = (deps.logger ?? buildLogger()).child({ component: "bull-board" });

  // The mount (Pattern 6, verbatim shape). Mutation powers are Bull Board
  // defaults — deliberately untouched (D-19). One adapter per queue lane —
  // the worker's existing six-lane set (§14.1), never new Queue instances.
  const lanes = [
    queues.scheduler,
    queues.checks,
    queues.dbWrites,
    queues.alerts,
    queues.maintenance,
    queues.email,
  ];
  const app = new Hono();
  const serverAdapter = new HonoAdapter(serveStatic);
  createBullBoard({
    queues: lanes.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });
  serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);
  app.route(BULL_BOARD_BASE_PATH, serverAdapter.registerPlugin());
  const listener = getRequestListener(app.fetch);

  async function auditAndRefuse(
    req: IncomingMessage,
    res: ServerResponse,
    reason: "no_session" | "not_admin" | "ip_not_allowlisted",
    userId: string
  ): Promise<void> {
    emitAccessAudit(log, {
      userId,
      route: (req.url ?? BULL_BOARD_BASE_PATH).split("?")[0],
      ip: req.socket.remoteAddress ?? "",
      allowed: false,
      reason,
    });
    respond403(res);
  }

  const handler = async function bullBoardHandler(req, res) {
    const route = (req.url ?? BULL_BOARD_BASE_PATH).split("?")[0];
    const ip = req.socket.remoteAddress ?? "";

    // ---- Gate 2: the Better Auth admin session (A2) ----
    let session: Awaited<ReturnType<BullBoardAuth["api"]["getSession"]>> = null;
    try {
      session = await deps.auth.api.getSession({ headers: headersFromNodeRequest(req) });
    } catch {
      session = null; // a broken auth backend refuses — it never admits
    }
    if (!session?.user) {
      await auditAndRefuse(req, res, "no_session", "anonymous");
      return;
    }
    const userId = session.user.id ?? "anonymous";
    if (session.user.role !== "admin") {
      await auditAndRefuse(req, res, "not_admin", userId);
      return;
    }

    // ---- Allowed: the D-16 line, THEN the bridge (A5) ----
    emitAccessAudit(log, { userId, route, ip, allowed: true, reason: "allowed" });
    await new Promise<void>((resolve) => {
      res.once("finish", resolve);
      listener(req, res);
    });
  } as BullBoardHandler;

  handler.refuseAndAudit = (req, res, reason) => auditAndRefuse(req, res, reason, "anonymous");
  return handler;
}
