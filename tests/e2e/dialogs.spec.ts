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

// UI-02 / D-34: the dialog consolidation suite. Every destructive confirm on
// the dashboard renders as a shadcn alert-dialog (one dialog system) — the
// T-08-04 tampering pin lives here: cancel ALWAYS aborts (no destructive
// request leaves the browser), confirm ALWAYS executes it.

// 02-07 theme slice: pin the OS preference so "system" resolves to light
// deterministically (Playwright contexts start with no stored preference).
test.use({ colorScheme: "light" });

let monitorId: number;

test.beforeAll(async () => {
  await resetE2EData();
  const userId = await seedE2EUser();
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

test("delete monitor dialog: copy matches the UI-SPEC destructive contract", async ({
  page,
}) => {
  await loginViaUi(page);

  await page.getByTitle("Delete Monitor").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      `This permanently deletes "${E2E_MONITOR_NAME}" and its check history. This can't be undone.`,
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Delete monitor" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Delete Monitor" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("delete monitor dialog: cancel aborts — no DELETE request, monitor stays listed", async ({
  page,
}) => {
  await loginViaUi(page);

  const deleteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes("/api/monitors")) {
      deleteRequests.push(request.url());
    }
  });

  await page.getByTitle("Delete Monitor").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).not.toBeVisible();
  // Cancel must leave the monitor listed and fire no destructive request
  // (T-08-04: a broken dialog must never auto-confirm).
  await expect(page.getByText(E2E_MONITOR_NAME)).toBeVisible();
  expect(deleteRequests).toEqual([]);
});

test("delete monitor dialog: confirm executes — DELETE fires, monitor removed, toast shown", async ({
  page,
}) => {
  await loginViaUi(page);

  const deleteFired = new Promise<string>((resolve) => {
    page.on("request", (request) => {
      if (
        request.method() === "DELETE" &&
        request.url().includes(`/api/monitors/${monitorId}`)
      ) {
        resolve(request.url());
      }
    });
  });

  await page.getByTitle("Delete Monitor").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete Monitor" }).click();

  expect(await deleteFired).toContain(`/api/monitors/${monitorId}`);
  await expect(
    page.getByText(`Monitor "${E2E_MONITOR_NAME}" deleted.`),
  ).toBeVisible();
  // The list re-renders the UI-SPEC empty state once the row is gone (the
  // toast text also carries the monitor name, so the empty-state heading is
  // the unambiguous gone-signal).
  await expect(page.getByText("No Monitors Found")).toBeVisible();
});
