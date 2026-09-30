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

// Tier-1 redesign pins (08-04): the stats summary header renders real
// aggregates of the seeded monitors (no new API — same GET /api/monitors
// data), monitor rows use the denser 12px rhythm with sticky column headers,
// the staggered entrance honors prefers-reduced-motion, and the zero-monitor
// account renders the UI-SPEC empty-state copy verbatim. Extended across the
// plan's Tasks 2-3 (detail composition, typography contract, skeletons).

// 02-07 theme slice: pin the OS preference so "system" resolves to light
// deterministically (Playwright contexts start with no stored preference).
test.use({ colorScheme: "light" });

// A second account with NO monitors drives the empty-state leg.
const EMPTY_EMAIL = "e2e-empty@spidernode.test";
const EMPTY_PASSWORD = "E2E-Empty-Password-1";

// Monitor ids captured by beforeAll (workers:1 — one worker process runs
// every test in this file, so module scope carries them to the tests).
let cleanMonitorId: number;
let incidentMonitorId: number;

test.beforeAll(async () => {
  await resetE2EData();
  const userId = await seedE2EUser();
  // The seeded monitor stays incident-free — the detail Clean-History leg.
  cleanMonitorId = await seedMonitor(userId, E2E_MONITOR_NAME);
  // A second monitor carries one ONGOING incident — the incident-block
  // composition leg (Card composition + ACTIVE badge on status tokens).
  incidentMonitorId = await seedMonitor(userId, "E2E Incident Monitor");
  await seedOngoingIncident(
    incidentMonitorId,
    "E2E seeded connection timeout",
  );
  await seedE2EUser(EMPTY_EMAIL, EMPTY_PASSWORD, "E2E Empty User");
});

test.afterAll(async () => {
  await closeSeedPool();
});

// Shared login flow — same convention as smoke.spec.ts (LoginForm does
// redirect: false + client-side redirect; selectors read from
// src/components/Auth/LoginForm.tsx). The sign-in limiter retry mirrors the
// smoke suite's loop (3 per 10s — retry outlives the window instead of
// disabling a production guard for tests).
async function loginViaUi(
  page: Page,
  email: string = E2E_EMAIL,
  password: string = E2E_PASSWORD,
) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
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

test("stats summary header renders real aggregates of the seeded monitor", async ({
  page,
}) => {
  await loginViaUi(page);

  // Seed shape: 2 active UP monitors (the clean one + the incident one), each
  // uptimePercent 100.0 and responseTime 42ms. The header aggregates the SAME
  // data the list shows — no new endpoint.
  await expect(page.getByTestId("stat-total")).toHaveText("2");
  await expect(page.getByText("Total 2 listed")).toBeVisible();
  await expect(page.getByTestId("stat-status")).toHaveText("ALL OPERATIONAL");
  await expect(page.getByText("2 UP • 0 DOWN")).toBeVisible();
  await expect(page.getByTestId("stat-uptime")).toHaveText("100.00%");
  await expect(page.getByTestId("stat-latency")).toHaveText("42ms");
});

test("monitor rows render the denser 12px rhythm with sticky column headers", async ({
  page,
}) => {
  await loginViaUi(page);

  // Newest-first list: filter to the row under test instead of .first().
  const row = page
    .getByTestId("monitor-row")
    .filter({ hasText: E2E_MONITOR_NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText(E2E_MONITOR_NAME);

  // Denser rhythm: py-3 (12px) replaced py-4 on the row cells (UI-SPEC
  // spacing exception for the denser monitor list).
  const cellClass = await row.locator("td").first().getAttribute("class");
  expect(cellClass).toContain("py-3");
  expect(cellClass).not.toContain("py-4");

  // Sticky column headers within the list card (the th pins below the
  // h-16 AppHeader while the page scrolls).
  const headClass = await page.locator("th").first().getAttribute("class");
  expect(headClass).toContain("sticky");
  expect(headClass).toContain("top-16");
});

test("staggered entrance honors prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loginViaUi(page);

  // With reduced motion the rows mount directly in their final state (the
  // useReducedMotion static fallback) — visible without waiting out a
  // stagger delay.
  await expect(page.getByTestId("monitor-row").first()).toBeVisible();
  const rowClass = await page
    .getByTestId("monitor-row")
    .first()
    .getAttribute("class");
  expect(rowClass).toBeTruthy();
});

test("zero-monitor account renders the empty-state copy verbatim", async ({
  page,
}) => {
  await loginViaUi(page, EMPTY_EMAIL, EMPTY_PASSWORD);

  await expect(
    page.getByRole("heading", { name: "No Monitors Found" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'You haven\'t added any endpoints yet. Click "Add Monitor" above to start tracking your website or API.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "+ Add Your First Monitor" }),
  ).toBeVisible();

  // And the empty account's stats header reads the zero-one-many count form.
  await expect(page.getByText("Total 0 listed")).toBeVisible();
});

test("monitor detail renders incident blocks on the Card composition with status tokens", async ({
  page,
}) => {
  await loginViaUi(page);
  await page.goto(`/dashboard/monitor/${incidentMonitorId}`);

  // Incident history rides Card primitives (08-07's post-mortem mount):
  // icon + title + description + started/resolved timestamps + badge.
  const block = page.getByTestId("incident-block");
  await expect(block).toBeVisible();
  await expect(block).toContainText("Downtime Ongoing");
  await expect(block).toContainText("E2E seeded connection timeout");
  await expect(block).toContainText("Started:");

  // The ACTIVE/RESOLVED badge flows through the status tokens (UI-SPEC Token
  // Migration Rule 2 — the 02-08 mixed-ternary carry-forward is gone).
  const badge = page.getByTestId("incident-status-badge");
  await expect(badge).toHaveText("ACTIVE");
  const badgeClass = await badge.getAttribute("class");
  expect(badgeClass).toContain("text-status-down");
  expect(badgeClass).not.toContain("rose-");

  // The detail status badge rides status tokens too (seeded monitor is UP).
  const statusBadge = page.getByTestId("detail-status-badge");
  await expect(statusBadge).toHaveText("UP");
  const statusClass = await statusBadge.getAttribute("class");
  expect(statusClass).toContain("text-status-up");
});

test("incident-free monitor detail renders the Clean History copy verbatim with the declared type roles", async ({
  page,
}) => {
  await loginViaUi(page);
  await page.goto(`/dashboard/monitor/${cleanMonitorId}`);

  // UI-SPEC copywriting contract, verbatim.
  await expect(
    page.getByRole("heading", { name: "Clean History" }),
  ).toBeVisible();
  await expect(
    page.getByText("No incidents recorded for this monitor."),
  ).toBeVisible();

  // Typography contract (D-30), asserted via computed classes exactly like
  // the Task-1 rhythm assertions: Display role = text-[28px] 600 in mono,
  // Heading role = text-lg 600, Label role = text-xs.
  const displayClass = await page.getByTestId("detail-uptime").getAttribute("class");
  expect(displayClass).toContain("text-[28px]");
  expect(displayClass).toContain("font-semibold");
  expect(displayClass).toContain("font-mono");

  const headingClass = await page
    .locator('[data-slot="card-title"]', { hasText: "Incident History" })
    .getAttribute("class");
  expect(headingClass).toContain("text-lg");
  expect(headingClass).toContain("font-semibold");

  const labelClass = await page
    .locator('[data-slot="card-description"]', {
      hasText: "Recent downtime events",
    })
    .getAttribute("class");
  expect(labelClass).toContain("text-xs");
});
