import { expect, test } from "@playwright/test";
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

test.beforeAll(async () => {
  await resetE2EData();
  const userId = await seedE2EUser();
  await seedMonitor(userId, E2E_MONITOR_NAME);
});

test.afterAll(async () => {
  await closeSeedPool();
});

test("seeded user logs in and the dashboard renders the seeded monitor", async ({
  page,
}) => {
  await page.goto("/login");

  // Selectors read from src/components/Auth/LoginForm.tsx
  await page.locator('input[type="email"]').fill(E2E_EMAIL);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  // Successful credentials login sets window.location to the dashboard
  // (LoginForm does redirect: false + client-side redirect).
  await expect(page).toHaveURL(/\/dashboard/);

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
