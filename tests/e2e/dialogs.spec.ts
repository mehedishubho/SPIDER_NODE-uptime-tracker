import { expect, test, type Page } from "@playwright/test";
import {
  closeSeedPool,
  E2E_EMAIL,
  E2E_MONITOR_NAME,
  E2E_PASSWORD,
  resetE2EData,
  seedE2EUser,
  seedMonitor,
  seedTelegramChatId,
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
  // The disconnect-confirm leg needs the connected profile surface.
  await seedTelegramChatId(userId, "123456789");
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

  // 08-04 redesign: row actions live in the dropdown-menu overflow — open the
  // row menu, then the destructive item opens the confirm alert-dialog.
  await page.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Delete Monitor" }).click();
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

  await page.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Delete Monitor" }).click();
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

  await page.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Delete Monitor" }).click();
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

// ---------------------------------------------------------------------------
// Log out confirm (TeamSwitch sidebar — the ex-Swal site). Same T-08-04
// shape: cancel aborts (session survives), confirm executes sign-out.
// ---------------------------------------------------------------------------

test("logout dialog: cancel aborts — session survives, still on the dashboard", async ({
  page,
}) => {
  await loginViaUi(page);

  await page.getByRole("button", { name: "Log out" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Do you want to log out?"),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  // Still authenticated: the dashboard shell is still rendered.
  await expect(page.getByText("Monitored Services")).toBeVisible();
});

test("logout dialog: confirm executes — sign-out completes and redirects to login", async ({
  page,
}) => {
  await loginViaUi(page);

  await page.getByRole("button", { name: "Log out" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Log Out" }).click();

  await page.waitForURL(/\/login/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/login/);
});

// ---------------------------------------------------------------------------
// Disconnect Telegram confirm (profile page). Same T-08-04 shape.
// ---------------------------------------------------------------------------

test("telegram disconnect dialog: cancel aborts — no PATCH, chat stays connected", async ({
  page,
}) => {
  await loginViaUi(page);
  await page.goto("/dashboard/profile");

  // The connected state renders the Disconnect button.
  const disconnectButton = page.getByRole("button", { name: "Disconnect" });
  await expect(disconnectButton).toBeVisible();

  const patchRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/user/profile")) {
      patchRequests.push(request.url());
    }
  });

  await disconnectButton.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      "You'll stop receiving DOWN and recovery alerts on Telegram. You can reconnect anytime.",
    ),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  // Still connected: the connected-state surface (and its Disconnect
  // affordance) remains rendered.
  await expect(disconnectButton).toBeVisible();
  expect(patchRequests).toEqual([]);
});

test("telegram disconnect dialog: confirm executes — PATCH fires and the badge flips", async ({
  page,
}) => {
  await loginViaUi(page);
  await page.goto("/dashboard/profile");

  const patchFired = new Promise<string>((resolve) => {
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().includes("/api/user/profile")) {
        resolve(request.url());
      }
    });
  });

  await page.getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Disconnect" }).click();

  expect(await patchFired).toContain("/api/user/profile");
  await expect(
    page.getByText("Telegram disconnected successfully"),
  ).toBeVisible();
  await expect(page.getByText("Not Connected")).toBeVisible();
});
