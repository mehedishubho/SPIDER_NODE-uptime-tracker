import { expect, request as requestFactory, test, type APIRequestContext } from "@playwright/test";
import {
  closeSeedPool,
  resetE2EData,
  seedE2EUser,
  seedMonitor,
  seedOngoingIncident,
} from "../setup/seed";

// ---------------------------------------------------------------------------
// HTTP-level core-route contracts (D-16 hybrid split — the HTTP half of FND-06).
// Runs in Playwright's `api` project against the webServer booted from the
// built artifact (no cron, no egress — the CRON_MODE=vercel writer was
// deleted with the legacy cron surface at the 06-05 deletion release).
//
// SCOPE DISCIPLINE (T-02-09): no HTTP test touches /api/monitors/{id}/check —
// it would enqueue a real check. (The /api/cron/* routes no longer exist:
// deleted at 06-05, their absence gate-enforced by check-cron-remnants.)
// Contracts live in the *.handler.test.ts files with the
// check seams mocked.
//
// Login follows the NextAuth quirks recorded in 02-02-SUMMARY: seeded
// emailVerified users, CSRF round-trip over raw HTTP, assert the SESSION
// (cookie state via /api/auth/session) — never a 3xx or an error message.
// ---------------------------------------------------------------------------

const USER_A = {
  email: "e2e-api-a@spidernode.test",
  password: "E2E-Api-Password-A-1",
  name: "E2E API User A",
  id: "",
  monitorId: 0,
  monitorName: "E2E API Monitor A",
};

const USER_B = {
  email: "e2e-api-b@spidernode.test",
  password: "E2E-Api-Password-B-1",
  name: "E2E API User B",
  id: "",
  monitorId: 0,
  monitorName: "E2E API Monitor B",
};

const B_INCIDENT_DESCRIPTION = "E2E API ongoing incident on B's monitor";

let ctxA: APIRequestContext;
let ctxB: APIRequestContext;
let ctxAnon: APIRequestContext;
let createdMonitorId = 0;

/** HTTP login per the 02-02-SUMMARY quirks (CSRF round-trip + session assert). */
async function loginOverHttp(ctx: APIRequestContext, email: string, password: string) {
  const csrfRes = await ctx.get("/api/auth/csrf");
  expect(csrfRes.status()).toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  // maxRedirects: 0 — whether today's callback answers 200 JSON or a 302, the
  // cookie jar has what we need; outcome is proven via the session endpoint.
  const loginRes = await ctx.post("/api/auth/callback/credentials", {
    form: { email, password, csrfToken },
    maxRedirects: 0,
  });
  expect(
    [200, 302].includes(loginRes.status()),
    `credentials login failed for ${email}: ${loginRes.status()} ${await loginRes.text()}`,
  ).toBeTruthy();

  const sessionRes = await ctx.get("/api/auth/session");
  expect(sessionRes.status()).toBe(200);
  const session = (await sessionRes.json()) as { user?: { email?: string } };
  expect(session.user?.email, `no session established for ${email}`).toBe(email);
}

test.beforeAll(async () => {
  await resetE2EData();
  USER_A.id = await seedE2EUser(USER_A.email, USER_A.password, USER_A.name);
  USER_B.id = await seedE2EUser(USER_B.email, USER_B.password, USER_B.name);
  USER_A.monitorId = await seedMonitor(USER_A.id, USER_A.monitorName);
  USER_B.monitorId = await seedMonitor(USER_B.id, USER_B.monitorName);
  // One ONGOING incident on B's monitor: proves A's incidents list excludes it.
  await seedOngoingIncident(USER_B.monitorId, B_INCIDENT_DESCRIPTION);

  // Three ISOLATED cookie jars (two logged-in users + anonymous) via the
  // request factory — each context keeps its own NextAuth session cookie.
  const baseURL = test.info().project.use.baseURL!;
  ctxA = await requestFactory.newContext({ baseURL });
  ctxB = await requestFactory.newContext({ baseURL });
  ctxAnon = await requestFactory.newContext({ baseURL });
  await loginOverHttp(ctxA, USER_A.email, USER_A.password);
  await loginOverHttp(ctxB, USER_B.email, USER_B.password);
});

test.afterAll(async () => {
  await ctxA?.dispose();
  await ctxB?.dispose();
  await ctxAnon?.dispose();
  await closeSeedPool();
});

test("GET /api/monitors is ownership-filtered over the wire: A sees only A's monitor", async () => {
  const res = await ctxA.get("/api/monitors");
  expect(res.status()).toBe(200);
  const { monitors } = (await res.json()) as { monitors: Array<{ id: number; name: string }> };
  expect(Array.isArray(monitors)).toBe(true);
  expect(monitors.some((m) => m.name === USER_A.monitorName)).toBe(true);
  expect(monitors.some((m) => m.name === USER_B.monitorName)).toBe(false);
});

test("GET /api/monitors as B sees only B's monitor (both directions of the scoping)", async () => {
  const res = await ctxB.get("/api/monitors");
  expect(res.status()).toBe(200);
  const { monitors } = (await res.json()) as { monitors: Array<{ id: number; name: string }> };
  expect(monitors.some((m) => m.name === USER_B.monitorName)).toBe(true);
  expect(monitors.some((m) => m.name === USER_A.monitorName)).toBe(false);
});

test("POST /api/monitors valid → 201 with the route's real response shape", async () => {
  const res = await ctxA.post("/api/monitors", {
    data: {
      name: "E2E API Created Monitor",
      // Must RESOLVE: the 06-03 DNS-only admission (assertUrlAllowed,
      // fail-closed) refuses NXDOMAIN hosts with a 400 before the create.
      // example.com is the IANA documentation host — resolvable, never
      // dialed by this suite (the monitor is renamed and deleted unchecked).
      url: "https://example.com/",
      interval: "10",
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as {
    message: string;
    monitor: { id: number; name: string; url: string; interval: number; status: string };
  };
  expect(body.message).toBe("Monitor listed successfully");
  expect(body.monitor.name).toBe("E2E API Created Monitor");
  expect(body.monitor.url).toBe("https://example.com/");
  expect(body.monitor.interval).toBe(10);
  // API-created monitors start PENDING (first UP sends "MONITORING STARTED").
  expect(body.monitor.status).toBe("PENDING");
  createdMonitorId = body.monitor.id;
});

test("POST /api/monitors invalid URL → 400 with today's exact error body", async () => {
  const res = await ctxA.post("/api/monitors", {
    data: { name: "Bad URL", url: "not-a-valid-url" },
  });
  expect(res.status()).toBe(400);
  await expect(res.json()).resolves.toEqual({
    error: "Invalid URL format (e.g., https://example.com)",
  });
});

test("created monitor lifecycle over HTTP: PATCH 200 → GET 200 renamed → DELETE 200 → absent from list", async () => {
  expect(createdMonitorId).toBeGreaterThan(0);

  const patched = await ctxA.patch(`/api/monitors/${createdMonitorId}`, {
    data: { name: "E2E API Created Monitor (renamed)" },
  });
  expect(patched.status()).toBe(200);
  const patchBody = (await patched.json()) as { message: string };
  expect(patchBody.message).toBe("Monitor updated successfully");

  const fetched = await ctxA.get(`/api/monitors/${createdMonitorId}`);
  expect(fetched.status()).toBe(200);
  const { monitor } = (await fetched.json()) as { monitor: { name: string } };
  expect(monitor.name).toBe("E2E API Created Monitor (renamed)");

  const deleted = await ctxA.delete(`/api/monitors/${createdMonitorId}`);
  expect(deleted.status()).toBe(200);
  await expect(deleted.json()).resolves.toEqual({ message: "Monitor deleted successfully" });

  const list = await ctxA.get("/api/monitors");
  const { monitors } = (await list.json()) as { monitors: Array<{ id: number }> };
  expect(monitors.some((m) => m.id === createdMonitorId)).toBe(false);
});

test("cross-user access with A's session against B's monitor id → the route's real not-found behavior", async () => {
  // GET / PATCH / DELETE all 404 with "Monitor not found" — B's monitor is
  // invisible to A, proven over real HTTP.
  const got = await ctxA.get(`/api/monitors/${USER_B.monitorId}`);
  expect(got.status()).toBe(404);
  await expect(got.json()).resolves.toEqual({ error: "Monitor not found" });

  const patched = await ctxA.patch(`/api/monitors/${USER_B.monitorId}`, {
    data: { name: "Hijack Attempt" },
  });
  expect(patched.status()).toBe(404);
  await expect(patched.json()).resolves.toEqual({ error: "Monitor not found" });

  const deleted = await ctxA.delete(`/api/monitors/${USER_B.monitorId}`);
  expect(deleted.status()).toBe(404);
  await expect(deleted.json()).resolves.toEqual({ error: "Monitor not found" });
});

test("GET /api/incidents is ownership-filtered: A gets an empty list while B's ONGOING incident exists", async () => {
  const resA = await ctxA.get("/api/incidents");
  expect(resA.status()).toBe(200);
  const aBody = (await resA.json()) as { incidents: unknown[] };
  expect(aBody.incidents).toEqual([]);

  const resB = await ctxB.get("/api/incidents");
  expect(resB.status()).toBe(200);
  const bBody = (await resB.json()) as {
    incidents: Array<{ description: string | null; monitor: { name: string } }>;
  };
  expect(bBody.incidents).toHaveLength(1);
  expect(bBody.incidents[0].description).toBe(B_INCIDENT_DESCRIPTION);
  expect(bBody.incidents[0].monitor.name).toBe(USER_B.monitorName);
});

test("GET /api/status with A's session → A's user + active monitors only", async () => {
  const res = await ctxA.get("/api/status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    user: { id: string; name: string };
    monitors: Array<{ name: string }>;
  };
  expect(body.user.id).toBe(USER_A.id);
  expect(body.user.name).toBe(USER_A.name);
  expect(body.monitors.some((m) => m.name === USER_A.monitorName)).toBe(true);
  expect(body.monitors.some((m) => m.name === USER_B.monitorName)).toBe(false);
});

test("GET /api/status/[userId] is genuinely public: anonymous context gets B's page shape", async () => {
  const res = await ctxAnon.get(`/api/status/${USER_B.id}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    user: { id: string; name: string };
    monitors: Array<{ name: string }>;
    recentIncidents: Array<{ description: string | null; monitor: { name: string } }>;
  };
  expect(body.user.id).toBe(USER_B.id);
  expect(body.monitors.some((m) => m.name === USER_B.monitorName)).toBe(true);
  expect(body.recentIncidents).toHaveLength(1);
  expect(body.recentIncidents[0].description).toBe(B_INCIDENT_DESCRIPTION);
});

test("GET /api/status/[unknownId] → 404 'Page not found'", async () => {
  const res = await ctxAnon.get("/api/status/00000000-0000-4000-8000-000000000000");
  expect(res.status()).toBe(404);
  await expect(res.json()).resolves.toEqual({ error: "Page not found" });
});

test("POST /api/feedback: anonymous 401 → invalid 400 → valid 201 (bare object)", async () => {
  const anon = await ctxAnon.post("/api/feedback", {
    data: { type: "BUG", title: "t", description: "d" },
  });
  expect(anon.status()).toBe(401);
  await expect(anon.json()).resolves.toEqual({ error: "Unauthorized" });

  const invalid = await ctxA.post("/api/feedback", { data: { title: "only title" } });
  expect(invalid.status()).toBe(400);
  await expect(invalid.json()).resolves.toEqual({
    error: "Missing required fields: title, description, and type are required",
  });

  const valid = await ctxA.post("/api/feedback", {
    data: { type: "BUG", title: "E2E API feedback", description: "from the api project" },
  });
  expect(valid.status()).toBe(201);
  const created = (await valid.json()) as { id: string; title: string; type: string };
  expect(created.id).toBeTruthy();
  expect(created.title).toBe("E2E API feedback");
  expect(created.type).toBe("BUG");
});

test("unauthenticated sweep: session-guarded routes 401; the public status page 200", async () => {
  const monitors = await ctxAnon.get("/api/monitors");
  expect(monitors.status()).toBe(401);
  await expect(monitors.json()).resolves.toEqual({ error: "Unauthorized" });

  const incidents = await ctxAnon.get("/api/incidents");
  expect(incidents.status()).toBe(401);
  await expect(incidents.json()).resolves.toEqual({ error: "Unauthorized" });

  // Pinned ACTUAL behavior: /api/status requires a session despite the
  // in-code comment claiming "no auth needed" — /api/status/[userId] is the
  // genuinely public one.
  const status = await ctxAnon.get("/api/status");
  expect(status.status()).toBe(401);
  await expect(status.json()).resolves.toEqual({ error: "Unauthorized" });

  const publicStatus = await ctxAnon.get(`/api/status/${USER_B.id}`);
  expect(publicStatus.status()).toBe(200);

  const feedback = await ctxAnon.get("/api/feedback");
  expect(feedback.status()).toBe(401);
  await expect(feedback.json()).resolves.toEqual({ error: "Unauthorized" });
});
