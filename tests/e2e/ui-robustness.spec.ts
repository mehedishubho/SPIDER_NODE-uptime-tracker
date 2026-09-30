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

let userId: string;
let monitorId: number;

test.beforeAll(async () => {
  await resetE2EData();
  userId = await seedE2EUser();
  monitorId = await seedMonitor(userId, E2E_MONITOR_NAME);
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
  // 08-04 redesign: row actions live in the dropdown-menu overflow — open the
  // row menu first (same reconciliation as dialogs.spec).
  await page.getByRole("button", { name: "Row actions" }).first().click();
  await page.getByRole("menuitem", { name: "Re-check endpoint status" }).click();
  await page.waitForTimeout(2400);
  await page.getByRole("link", { name: "Incidents" }).click();
  await expect(page).toHaveURL(/\/dashboard\/incidents/, { timeout: 15_000 });
  await page.waitForTimeout(2500);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("monitor detail: navigate-away mid-fetch records zero pageerrors and console errors", async ({
  page,
}) => {
  await loginViaUi(page);
  await expect(page.getByText(E2E_MONITOR_NAME)).toBeVisible();

  // Hold the details response so the detail surface's load read is reliably
  // IN FLIGHT when we leave.
  await page.route("**/details", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  const { pageErrors, consoleErrors } = attachRobustnessListeners(page);

  // In (client-side): the monitor-name link swaps the React tree to the
  // detail surface; its load read hangs on the route hold.
  await page.getByText(E2E_MONITOR_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/monitor/${monitorId}`), {
    timeout: 15_000,
  });
  // Out (client-side): the history entries behind us are Next-router
  // managed (same document), so back is a client-side swap — the detail
  // surface unmounts under the in-flight fetch and the abort seam must
  // silence it (30s interval cleared, controller aborted).
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
  await page.waitForTimeout(2500);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("public status: navigate away mid-fetch records zero pageerrors and console errors", async ({
  page,
}) => {
  // Public surface — no session needed.
  await page.route("**/api/status/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  const { pageErrors, consoleErrors } = attachRobustnessListeners(page);
  await page.goto(`/status/${userId}`);

  // This surface renders no in-app links (bare root layout): leaving it is
  // a real document navigation — the realistic exit path. The load fetch is
  // held IN FLIGHT across the teardown; the shared abort-catch silence is
  // pinned on the three authenticated surfaces above plus the source sweep.
  await page.goto("/login");
  await page.waitForTimeout(2500);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("dashboard status: hydration-safe URL — zero hydration errors, copy value populates after mount", async ({
  page,
}) => {
  // Hydration listeners (smoke.spec convention) attach BEFORE the full
  // document load: any server/client markup disagreement on this surface
  // lands here.
  const hydrationProblems: string[] = [];
  page.on("pageerror", (error) => {
    if (/hydrat|did not match|server[- ]rendered|mismatch/i.test(error.message)) {
      hydrationProblems.push(error.message);
    }
  });
  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      /hydrat|did not match|server[- ]rendered|mismatch/i.test(msg.text())
    ) {
      hydrationProblems.push(msg.text());
    }
  });

  await loginViaUi(page);
  await page.goto("/dashboard/status");
  await expect(page.getByText("Your Status Page")).toBeVisible();

  // publicUrl derives post-mount (mounted guard + effect): the copy control
  // populates with the seeded user's public path instead of staying on the
  // "Loading..." fallback.
  await expect(page.locator("code")).toContainText(`/status/${userId}`, {
    timeout: 15_000,
  });

  expect(hydrationProblems).toEqual([]);
});

test("exactly one Toaster mounts app-wide (root ThemedToaster)", async ({
  page,
}) => {
  // The single-Toaster UI-04 criterion, asserted in this spec per the plan:
  // 08-02 deleted the duplicate dashboard-layout import and the root
  // ThemedToaster is the only mount. Sonner 2.0.7 renders its eager
  // <section aria-label="Notifications …"> container once per Toaster
  // mount — the per-position [data-sonner-toaster] lists only appear while
  // toasts are active, so the section is the stable mount census.
  await page.goto("/login");
  await expect(
    page.locator('section[aria-label*="Notifications"]'),
  ).toHaveCount(1);
});
