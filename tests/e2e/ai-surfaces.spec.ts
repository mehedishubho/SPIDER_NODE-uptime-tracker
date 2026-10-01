import { expect, test, type Page } from "@playwright/test";
import {
  closeSeedPool,
  E2E_EMAIL,
  E2E_MONITOR_NAME,
  E2E_PASSWORD,
  resetE2EData,
  seedE2EUser,
  seedMonitor,
  seedOngoingIncident,
} from "../setup/seed";

// ---------------------------------------------------------------------------
// AI-surface e2e legs (08-07 — AI-03 UX + D-21 zero-trace; Task 2 extends
// this file with the monitor-assistant legs).
//
// Two flag postures, two runners (the 07-03 webServer env precedent):
//   - Flag-ON legs (stub provider): run ONLY under playwright.ai.config.ts —
//     that config starts the stub OpenAI-compatible server and boots the app
//     with the AI_* env triple pointed at it. Gated on the AI_E2E_STUB marker
//     the AI config sets; they SKIP in the default verify project so the
//     default run never depends on AI keys or the stub server (Task 3).
//   - Flag-OFF legs: run ONLY in the default project (no AI env — the exact
//     AI_ENABLED=false production default). They assert the D-21 zero-trace
//     contract: zero AI strings in the DOM, zero /api/ai requests, no
//     disabled AI affordances.
// ---------------------------------------------------------------------------

// Shared login flow — same convention as dashboard-redesign.spec.ts.
async function loginViaUi(page: Page) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(E2E_EMAIL);
    await page.locator('input[type="password"]').fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    try {
      await page.waitForURL(/\/dashboard/, { timeout: 8_000 });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      await page.waitForTimeout(11_000);
    }
  }
}

let incidentMonitorId: number;

// ---------------------------------------------------------------------------
// Flag-ON legs — stub-provider runner only (AI_E2E_STUB).
// ---------------------------------------------------------------------------
test.describe("AI surfaces — flag ON (stub provider)", () => {
  // Skip unless running under the AI stub config: the default verify e2e
  // project has no AI env and no stub server — these legs must degrade to a
  // clean skip there (D-21 default posture).
  test.skip(
    process.env.AI_E2E_STUB !== "1",
    "requires the AI stub e2e config (playwright.ai.config.ts)",
  );

  // Copy asserts navigator.clipboard.writeText — grant it to the context.
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test.beforeAll(async () => {
    await resetE2EData();
    const userId = await seedE2EUser();
    await seedMonitor(userId, E2E_MONITOR_NAME);
    incidentMonitorId = await seedMonitor(userId, "E2E Incident Monitor");
    await seedOngoingIncident(incidentMonitorId, "E2E seeded connection timeout");
  });

  test.afterAll(async () => {
    await closeSeedPool();
  });

  test("post-mortem streams inline with all four D-14 sections and completes with Copy + Regenerate", async ({
    page,
  }) => {
    await loginViaUi(page);
    await page.goto(`/dashboard/monitor/${incidentMonitorId}`);

    // The card trigger mounts under the incident block (D-11/D-12 — inline,
    // never a modal) with the contract trigger copy.
    const trigger = page.getByRole("button", { name: "Generate post-mortem" });
    await expect(trigger).toBeVisible();

    // Begin the stream against the stub provider.
    await trigger.click();

    // Stop is honest while streaming (D-16) — available mid-stream.
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();

    const card = page.getByTestId("post-mortem-card");
    await expect(card).toBeVisible();

    // The card header makes the D-13 copy-only contract visible.
    await expect(
      card.getByText("Post-mortem draft — not saved"),
    ).toBeVisible();

    // The four D-14 sections render AS HEADINGS from the streamed markdown
    // (D-14 pinned at the UI layer; the stub stream carries them).
    await expect(
      card.getByRole("heading", { name: "Summary", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      card.getByRole("heading", { name: "Timeline", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      card.getByRole("heading", { name: "Impact", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      card.getByRole("heading", { name: "Possible causes", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // Completion swaps the controls to Copy + Regenerate (D-16).
    const copy = page.getByRole("button", { name: "Copy", exact: true });
    const regenerate = page.getByRole("button", { name: "Regenerate" });
    await expect(copy).toBeVisible({ timeout: 20_000 });
    await expect(regenerate).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);

    // Copy-only: the success toast fires from navigator.clipboard.writeText;
    // no save-to-incident affordance exists anywhere on the surface (D-13).
    await copy.click();
    await expect(
      page.getByText("Post-mortem copied to clipboard"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /save/i }),
    ).toHaveCount(0);
  });

  test("Stop interrupts the stream and returns to Copy + Regenerate", async ({
    page,
  }) => {
    await loginViaUi(page);
    await page.goto(`/dashboard/monitor/${incidentMonitorId}`);

    await page.getByRole("button", { name: "Generate post-mortem" }).click();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();

    // Wait for the FIRST streamed delta (the card mounts on it) so Stop
    // interrupts a genuinely in-flight stream with partial text retained —
    // stopping before any text would legitimately return to the idle state.
    await expect(page.getByTestId("post-mortem-card")).toBeVisible();

    // Press Stop while the stub is still streaming (90ms/chunk cadence).
    await stop.click();

    // Streaming state ends: no Stop control; the completed-state controls
    // return (partial text retained per the SDK Stop contract).
    await expect(stop).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Copy", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Regenerate" }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Flag-OFF legs — default project only (AI_ENABLED unset/false is the exact
// production default posture). Assert the D-21 zero-trace contract.
// ---------------------------------------------------------------------------
test.describe("AI surfaces — flag OFF (zero trace)", () => {
  // Inverted gate: under the AI stub config the server boots with the flag
  // ON — these legs would assert against the wrong posture there.
  test.skip(
    process.env.AI_E2E_STUB === "1",
    "runs in the default (AI_ENABLED off) e2e project",
  );

  test.beforeAll(async () => {
    await resetE2EData();
    const userId = await seedE2EUser();
    await seedMonitor(userId, E2E_MONITOR_NAME);
    incidentMonitorId = await seedMonitor(userId, "E2E Incident Monitor");
    await seedOngoingIncident(incidentMonitorId, "E2E seeded connection timeout");
  });

  test.afterAll(async () => {
    await closeSeedPool();
  });

  test("no AI affordances, copy, or /api/ai requests on the dashboard and Add Monitor dialog", async ({
    page,
  }) => {
    const aiRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/ai/")) aiRequests.push(request.url());
    });

    await loginViaUi(page);

    // Zero AI copy in the dashboard DOM (D-21: no disabled buttons, no
    // tooltips — the affordances do not exist at all).
    await expect(
      page.getByText("Describe it in plain words"),
    ).toHaveCount(0);

    // The Add Monitor dialog renders the plain three-field form only.
    await page.getByRole("button", { name: "Add Monitor" }).first().click();
    await expect(page.getByRole("heading", { name: "Add New Monitor" })).toBeVisible();
    await expect(
      page.getByText("Describe it in plain words"),
    ).toHaveCount(0);
    await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // No /api/ai request was ever fired.
    expect(aiRequests).toEqual([]);
  });

  test("no post-mortem surface or /api/ai requests on the monitor detail page", async ({
    page,
  }) => {
    const aiRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/ai/")) aiRequests.push(request.url());
    });

    await loginViaUi(page);
    await page.goto(`/dashboard/monitor/${incidentMonitorId}`);

    // The incident block renders — and carries zero post-mortem surface.
    const block = page.getByTestId("incident-block");
    await expect(block).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Generate post-mortem" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("post-mortem-card")).toHaveCount(0);
    await expect(page.getByText(/post-mortem/i)).toHaveCount(0);

    expect(aiRequests).toEqual([]);
  });
});
