import { expect, test, type Page } from "@playwright/test";
import {
  closeSeedPool,
  E2E_EMAIL,
  E2E_MONITOR_NAME,
  E2E_PASSWORD,
  resetE2EData,
  seedE2EUser,
  seedMonitor,
} from "../setup/seed";

// UI-04: the client-robustness suite — the standing regression net the
// redesign plans keep honest. The polling surfaces must survive navigation
// without pageerrors (uncaught exceptions / unhandled rejections) or console
// errors: every polling fetch carries the 06-01 abort discipline (controller
// held in a ref, signal passed to fetch, abort on unmount, aborted re-check
// after each await) and every touched timer clears on unmount.

// 02-07 theme slice: pin the OS preference so "system" resolves to light
// deterministically (Playwright contexts start with no stored preference).
test.use({ colorScheme: "light" });

test.beforeAll(async () => {
  await resetE2EData();
  const userId = await seedE2EUser();
  await seedMonitor(userId, E2E_MONITOR_NAME);
});

test.afterAll(async () => {
  await closeSeedPool();
});

// Shared login flow — same convention as smoke.spec.ts (LoginForm does
// redirect: false + client-side redirect; selectors read from
// src/components/Auth/LoginForm.tsx). The sign-in limiter retry mirrors the
// smoke suite's loop (3 per 10s — retry outlives the window instead of
// disabling a production guard for tests).
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

// Robustness listeners — attached BEFORE navigation. pageerror captures
// uncaught exceptions (an unhandled rejection surfaces here); console
// messages of type "error" capture logged failures (an aborted rejection
// reaching an error toast path surfaces as console.error).
function attachRobustnessListeners(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  return { pageErrors, consoleErrors };
}

test("dashboard: navigate-away mid-poll records zero pageerrors and console errors", async ({
  page,
}) => {
  await loginViaUi(page);
  await expect(page.getByText(E2E_MONITOR_NAME)).toBeVisible();

  // Hold every /api/monitors response so a poll pass is reliably IN FLIGHT
  // when the surface unmounts — the abort seam must silence the aborted
  // rejection (no toast/console noise) and no late setState may surface.
  await page.route("**/api/monitors", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  const { pageErrors, consoleErrors } = attachRobustnessListeners(page);

  // Force an immediate poll pass (Refresh) and leave the surface while the
  // read is still hanging — inside the 30s poll window. The sidebar link is
  // a client-side navigation: the dashboard unmounts under the in-flight
  // fetch (a full document load would destroy the context and prove
  // nothing).
  await page.getByTitle("Refresh List").click();
  await page.getByRole("link", { name: "Incidents" }).click();
  await expect(page).toHaveURL(/\/dashboard\/incidents/, { timeout: 15_000 });
  // Settle past the route hold so any post-abort noise would have surfaced.
  await page.waitForTimeout(2500);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("dashboard: navigate-away with the check-now poll running records zero pageerrors and console errors", async ({
  page,
}) => {
  await loginViaUi(page);
  await expect(page.getByText(E2E_MONITOR_NAME)).toBeVisible();

  // SCOPE DISCIPLINE (T-02-09): no test may let a real POST
  // /api/monitors/{id}/check reach the server (it enqueues a real check).
  // The "forced check-now" leg therefore fulfills the enqueue at the network
  // layer with a faithful 202 — the real client machinery (enqueue handler +
  // 2s pollMonitorCheckResult loop over fetchMonitors) runs exactly as in
  // production, with zero real enqueues.
  await page.route("**/api/monitors/*/check", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "e2e-fake-job", queuedAt: Date.now() }),
    });
  });
  // Keep the poll loop's monitors reads in flight across navigation.
  await page.route("**/api/monitors", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });

  const { pageErrors, consoleErrors } = attachRobustnessListeners(page);

  // Force a check-now (fake 202 + real poll loop), land inside the loop's
  // first delayed read (~2s cadence + 800ms hold), then leave — the loop's
  // fetchMonitors pass aborts cleanly on unmount.
  await page.getByTitle("Re-check endpoint status").click();
  await page.waitForTimeout(2400);
  await page.getByRole("link", { name: "Incidents" }).click();
  await expect(page).toHaveURL(/\/dashboard\/incidents/, { timeout: 15_000 });
  await page.waitForTimeout(2500);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
