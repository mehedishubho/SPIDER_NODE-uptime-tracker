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

// D-18: exactly ONE smoke E2E proving the scaffold runs a real Next server
// against the docker stack — seeded login over real HTTP, dashboard renders
// the seeded monitor, theme class is dark. Feature-E2E is Phase 8 (UI-04).

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

// Shared login flow — LoginForm does redirect: false + client-side redirect
// (selectors read from src/components/Auth/LoginForm.tsx).
async function loginViaUi(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(E2E_EMAIL);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test("seeded user logs in and the dashboard renders the seeded monitor", async ({
  page,
}) => {
  await loginViaUi(page);

  // The dashboard lists the seeded monitor's name (Dashboard.tsx renders
  // {monitor.name} from GET /api/monitors).
  await expect(page.getByText(E2E_MONITOR_NAME)).toBeVisible();

  // Theme is dark today via the hardcoded html class; after plan 02-07 the
  // same assertion holds via next-themes defaultTheme="dark" (D-24).
  const htmlClass = await page.evaluate(
    () => document.documentElement.className
  );
  expect(htmlClass).toContain("dark");
});

// ---------------------------------------------------------------------------
// 02-07: THM-01/THM-02 theme assertions (UI-SPEC Behavior-Compatibility
// Invariants 1/2/3/6 + Copywriting Contract). Titles are prefixed "Theme:"
// so Playwright's numbered failure list stays greppable by title.
// ---------------------------------------------------------------------------

test("Theme: default theme is dark on first load with no stored preference", async ({
  page,
}) => {
  // Fresh context = no stored preference; defaultTheme="dark" (D-24) means
  // the pre-paint script sets html.dark BEFORE first paint — no light flash.
  await page.goto("/login");
  const htmlClass = await page.evaluate(
    () => document.documentElement.className
  );
  expect(htmlClass).toContain("dark");
});

test("Theme: toggle button exists in the dashboard header", async ({ page }) => {
  await loginViaUi(page);

  // Accessible name from the UI-SPEC copy contract — the aria-label carries
  // the state (tooltips are not accessible names). Default theme is dark.
  await expect(
    page.getByRole("button", { name: "Switch theme (current: Dark)" })
  ).toBeVisible();
});

test("Theme: clicking cycles Dark → System → Light and rewrites the html class", async ({
  page,
}) => {
  await loginViaUi(page);

  const darkToggle = page.getByRole("button", {
    name: "Switch theme (current: Dark)",
  });
  await expect(darkToggle).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.className)
  ).toContain("dark");

  // Click 1 (dark → system): selected state becomes System; with the OS
  // preference pinned to light, the system theme resolves to the light
  // palette (html class swaps dark → light).
  await darkToggle.click();
  await expect(
    page.getByRole("button", { name: "Switch theme (current: System)" })
  ).toBeVisible();
  const afterSystem = await page.evaluate(
    () => document.documentElement.className
  );
  expect(afterSystem).toContain("light");
  expect(afterSystem).not.toContain("dark");

  // Click 2 (system → light): selected state becomes Light.
  await page
    .getByRole("button", { name: "Switch theme (current: System)" })
    .click();
  await expect(
    page.getByRole("button", { name: "Switch theme (current: Light)" })
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.className)
  ).toContain("light");

  // Click 3 (light → dark): the cycle closes back to dark.
  await page
    .getByRole("button", { name: "Switch theme (current: Light)" })
    .click();
  await expect(darkToggle).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.className)
  ).toContain("dark");
});

test("Theme: selected light theme persists across reload", async ({ page }) => {
  await loginViaUi(page);

  // From default dark, two clicks select light (dark → system → light).
  await page
    .getByRole("button", { name: "Switch theme (current: Dark)" })
    .click();
  await page
    .getByRole("button", { name: "Switch theme (current: System)" })
    .click();
  await expect(
    page.getByRole("button", { name: "Switch theme (current: Light)" })
  ).toBeVisible();

  await page.reload();

  // next-themes reads the stored "theme" value pre-paint: light stays light
  // and the dark class never comes back (UI-SPEC invariant 6).
  const htmlClass = await page.evaluate(
    () => document.documentElement.className
  );
  expect(htmlClass).toContain("light");
  expect(htmlClass).not.toContain("dark");
  await expect(
    page.getByRole("button", { name: "Switch theme (current: Light)" })
  ).toBeVisible();
});

test("Theme: zero hydration warnings during load and toggle cycling", async ({
  page,
}) => {
  const hydrationProblems: string[] = [];

  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      /hydrat|did not match|server[- ]rendered|mismatch/i.test(msg.text())
    ) {
      hydrationProblems.push(msg.text());
    }
  });
  page.on("pageerror", (error) => {
    if (/hydrat|did not match|server[- ]rendered|mismatch/i.test(error.message)) {
      hydrationProblems.push(error.message);
    }
  });

  await loginViaUi(page);

  // Click through a full cycle so the toggle re-renders cannot mismatch
  // either — not just the initial load.
  for (const state of ["Dark", "System", "Light"] as const) {
    await page
      .getByRole("button", { name: `Switch theme (current: ${state})` })
      .click();
  }

  expect(hydrationProblems).toEqual([]);
});
