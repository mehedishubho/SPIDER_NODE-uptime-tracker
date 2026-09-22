import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// AUTH-06/D-02 default-off path: the verification/CI server boots WITHOUT
// AUTH_NOTICE_START/AUTH_NOTICE_END (the webServer env in
// playwright.config.ts pins the closed-window case) — so /login renders NO
// strip element at all (the component returns null, zero reserved space,
// self-cleaning per D-02) while the login form renders normally.
//
// The IN-WINDOW render (populated/long-text/overflow rows) is held as a
// rendered-strip check in the 07-06 rehearsal evidence via the console
// provider (D-06) — the plan's named backstop.
// ---------------------------------------------------------------------------

test("closed notice window renders no strip and a normal login form", async ({
  page,
}) => {
  await page.goto("/login");

  // role="status" exists ONLY on the notice strip — zero instances when the
  // window is closed (null render, no placeholder, no reserved space).
  await expect(page.getByRole("status")).toHaveCount(0);

  // The login form renders normally (selectors mirror smoke.spec.ts).
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  await expect(page.getByText("Welcome Back")).toBeVisible();
});
