import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  closeSeedPool,
  E2E_EMAIL,
  E2E_PASSWORD,
  resetE2EData,
  seedE2EUser,
  seedMonitor,
  seedOngoingIncident,
  seedResolvedIncident,
} from "../setup/seed";

// 08-05 light-mode pins (WR-02 discharge, D-26): every WR-02 surface renders
// token-driven in the LIGHT theme — computed colors resolve from the :root
// token variables (never raw white/slate), cyan-as-text and card borders meet
// WCAG on light surfaces, and no migrated element carries the retired raw
// utilities. 08-09 EXTENDS this spec with the tier-2/sidebar both-theme legs —
// helpers below are shared, so new legs compose (one describe per surface).

// Pin the OS preference (02-07 theme slice) so any "system" resolution is
// deterministic; the stored "light" below wins over the dark default anyway.
test.use({ colorScheme: "light" });

// The four retired raw utilities — the Task-1 sweep vocabulary, asserted at
// the DOM level inside the migrated containers.
const RETIRED_RAW_CLASSES = [
  "bg-slate-950/80",
  "text-white",
  "text-slate-300",
  "text-slate-400",
] as const;

// THM-01 wiring: next-themes attribute="class", defaultTheme="dark", storageKey
// default "theme" — a stored "light" opts this context into the light palette
// deterministically before first paint (no dark flash, no toggle needed).
async function forceLightTheme(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("theme", "light");
  });
}

// 08-09 both-theme legs: init scripts run in registration order, so a
// dark-setter registered inside a test overrides the beforeEach light-setter
// for every navigation afterwards (the dark default resolves through the
// same THM-01 class strategy — .dark on <html>).
async function forceDarkTheme(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("theme", "dark");
  });
}

// Token-resolved ALPHA background: Tailwind v4 /NNN utilities compute via
// color-mix and serialize as oklab(...) — not string-comparable to rgba().
// A probe element built with the SAME color-mix construction resolves the
// token in-engine, so the element assertion compares two engine-computed
// values: equal iff the surface really is the token at that alpha.
async function expectTokenBackgroundAlpha(
  page: Page,
  target: Locator,
  token: string,
  alphaPercent: number,
) {
  const expected = await page.evaluate(
    ({ name, pct }) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = `color-mix(in oklab, var(${name}) ${pct}%, transparent)`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    },
    { name: token, pct: alphaPercent },
  );
  await expect(target).toHaveCSS("background-color", expected);
}

// Token-resolved computed color: reads the :root CSS variable (#rrggbb form)
// and renders it into the rgb() string Chromium reports for computed element
// colors — assertions then prove the value flows from the token, never a
// raw utility.
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate(
    (name) => {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      const r = parseInt(raw.slice(1, 3), 16);
      const g = parseInt(raw.slice(3, 5), 16);
      const b = parseInt(raw.slice(5, 7), 16);
      return `rgb(${r}, ${g}, ${b})`;
    },
    token,
  );
}

async function expectTokenTextColor(page: Page, target: Locator, token: string) {
  const expected = await tokenColor(page, token);
  await expect(target).toHaveCSS("color", expected);
}

// Class-level sweep scoped to a migrated container: no element inside carries
// any retired raw utility. Scoped, not whole-page — other tier-3 marketing
// components (HeroSection, Footer, mockups) keep their raw utilities until
// the 08-09 sweep; only the WR-02 files claim zero here.
async function expectNoRetiredRawClasses(scope: Locator) {
  const offenders = await scope.evaluate((root, retired) => {
    const hits: string[] = [];
    for (const el of root.querySelectorAll("*")) {
      for (const cls of retired) {
        if (el.classList.contains(cls)) hits.push(`${el.tagName}.${cls}`);
      }
    }
    return hits;
  }, [...RETIRED_RAW_CLASSES]);
  expect(
    offenders,
    `retired raw utilities present: ${offenders.join(", ")}`,
  ).toEqual([]);
}

// 08-09 tier-2 sweep vocabulary: on the migrated tier-2 surfaces NO element
// carries a raw palette utility for status colors (emerald/rose) or the
// slate/white hardcodes (UI-SPEC Token Migration Rules 2 + 4). Regex over
// classList tokens so variant-prefixed forms (hover:bg-slate-800/50,
// focus:text-slate-200...) are caught too — the exact-class helper above
// stays scoped to the 08-05 WR-02 legs.
async function expectNoRawPaletteClasses(scope: Locator) {
  const offenders = await scope.evaluate((root) => {
    const pattern =
      /^(?:[a-z-]+:)?(?:bg|text|border|divide|ring|from|to|via|fill|stroke|shadow|outline|decoration|caret|accent)-(?:emerald|rose|slate)-/;
    const hits: string[] = [];
    for (const el of root.querySelectorAll("*")) {
      for (const cls of el.classList) {
        if (pattern.test(cls)) hits.push(`${el.tagName}.${cls}`);
        if (cls === "text-white") hits.push(`${el.tagName}.text-white`);
      }
    }
    return hits;
  });
  expect(
    offenders,
    `raw palette/white utilities present: ${offenders.join(", ")}`,
  ).toEqual([]);
}

// WCAG relative-luminance contrast between two computed rgb()/rgba() strings,
// computed in-page — proves the LIGHT token VALUES meet AA (the split's
// whole point), not just that a token resolved.
async function contrastRatio(
  page: Page,
  a: string,
  b: string,
): Promise<number> {
  return page.evaluate(
    ([x, y]) => {
      const parse = (s: string) =>
        (s.match(/[\d.]+/g) ?? [])
          .slice(0, 3)
          .map(Number)
          .map((v) => {
            const lin = v / 255;
            return lin <= 0.03928
              ? lin / 12.92
              : ((lin + 0.055) / 1.055) ** 2.4;
          });
      const lum = (s: string) => {
        const [r, g, b] = parse(s);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const [l1, l2] = [lum(x), lum(y)].sort((p, q) => q - p);
      return (l1 + 0.05) / (l2 + 0.05);
    },
    [a, b],
  );
}

// Shared login flow — same convention as dashboard-redesign.spec.ts (the
// sign-in limiter retry outlives the 429 window instead of disabling a
// production guard for tests).
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

test.beforeAll(async () => {
  await resetE2EData();
  await seedE2EUser();
});

test.afterAll(async () => {
  await closeSeedPool();
});

test.beforeEach(async ({ page }) => {
  await forceLightTheme(page);
});

test.describe("light theme applies (THM-01 wiring)", () => {
  test("resolved theme is light: no .dark class, body canvas from --background", async ({
    page,
  }) => {
    await page.goto("/");

    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(isDark).toBe(false);

    const expected = await tokenColor(page, "--background");
    await expect(page.locator("body")).toHaveCSS("background-color", expected);
  });
});

test.describe("marketing home — WR-02 surfaces are token-driven (D-26)", () => {
  test("Navbar brand heading and marketing copy resolve from tokens", async ({
    page,
  }) => {
    await page.goto("/");

    // Navbar text-white heading -> text-foreground (computed color equals the
    // :root token value — raw white/slate utilities are gone).
    await expectTokenTextColor(
      page,
      page.getByText("SpiderNode").first(),
      "--foreground",
    );

    // HowItWorks text-white heading -> text-foreground; text-slate-400 copy
    // -> text-muted-foreground (the intro + step descriptions).
    await expectTokenTextColor(
      page,
      page.getByRole("heading", { name: "From Zero to Monitored" }),
      "--foreground",
    );
    await expectTokenTextColor(
      page,
      page.getByText("No complex SDKs or messy configurations"),
      "--muted-foreground",
    );
    await expectTokenTextColor(
      page,
      page.getByText("Simply paste the URL"),
      "--muted-foreground",
    );
  });

  test("no migrated element carries the retired raw utilities", async ({
    page,
  }) => {
    await page.goto("/");

    // Navbar is the page's header element; HowItWorks is the py-24 section
    // anchoring the Quick Start guide heading.
    await expectNoRetiredRawClasses(page.locator("header").first());
    const howItWorks = page
      .getByRole("heading", { name: "From Zero to Monitored" })
      .locator("xpath=ancestor::div[contains(@class, 'py-24')][1]");
    await expectNoRetiredRawClasses(howItWorks);
  });
});

test.describe("dashboard chrome — header strip and sidebar are token-driven", () => {
  test("AppHeader renders bg-background/80 with border-border; sidebar brand is foreground", async ({
    page,
  }) => {
    await loginViaUi(page);

    const header = page.locator("header").first();
    await expect(header).toBeVisible();

    // bg-slate-950/80 -> bg-background/80: the translucent light canvas
    // (Tailwind v4 alpha — compared through the color-mix probe).
    await expectTokenBackgroundAlpha(page, header, "--background", 80);

    // border-slate-800 -> border-border (the 3:1 light border — asserted
    // numerically in the contrast leg below).
    const expectedBorder = await tokenColor(page, "--border");
    await expect(header).toHaveCSS("border-bottom-color", expectedBorder);

    // TeamSwitch text-white brand heading -> text-foreground (sidebar).
    await expectTokenTextColor(
      page,
      page.getByText("SpiderNode").first(),
      "--foreground",
    );

    // AppHeader text-slate-400 trigger -> text-muted-foreground.
    await expectTokenTextColor(
      page,
      page.locator("header").first().getByRole("button").first(),
      "--muted-foreground",
    );

    // Scoped sweep: header + the TeamSwitch block carry zero retired raw
    // utilities. Scoped to the WR-02 FILE surfaces — NavMain/NavUser inside
    // the same sidebar keep their raw utilities until the 08-09 sidebar
    // reconciliation, so the sweep must not cover the whole sidebar.
    await expectNoRetiredRawClasses(header);
    await expectNoRetiredRawClasses(
      page
        .getByText("SpiderNode")
        .first()
        .locator("xpath=ancestor::div[contains(@class, 'space-y-5')][1]"),
    );
  });
});

test.describe("login page renders token-resolved in light", () => {
  test("auth surface colors resolve from tokens", async ({ page }) => {
    await page.goto("/login");

    // The base layer routes body background/color through the tokens, and
    // the (authLayout) + LoginForm roots are bg-background text-foreground —
    // the page canvas and base text are token-driven in light. (LoginForm's
    // inner slate utilities are the byte-frozen D-33 auth surface — out of
    // this plan's sweep, untouched here.)
    const expectedBg = await tokenColor(page, "--background");
    await expect(page.locator("body")).toHaveCSS("background-color", expectedBg);
    await expectTokenTextColor(page, page.locator("body"), "--foreground");
  });
});

test.describe("light AA contrast — the 08-05 per-mode token splits", () => {
  test("cyan-as-text >= 4.5:1 vs card; card borders >= 3:1 vs surface (T-08-13)", async ({
    page,
  }) => {
    await loginViaUi(page);

    // The uptime stat's cyan emphasis (UI-SPEC reserved role) as TEXT on a
    // card surface — the light --accent-cyan variant must clear AA against
    // the card it renders on. #00E5FF stays valid only for non-text accents.
    const uptime = page.getByTestId("stat-uptime");
    await expect(uptime).toBeVisible();
    const cyanColor = await uptime.evaluate((el) => getComputedStyle(el).color);
    const cardBg = await uptime
      .locator(
        "xpath=ancestor::*[@data-slot='card'][1]",
      )
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const textContrast = await contrastRatio(page, cyanColor, cardBg);
    expect(textContrast).toBeGreaterThanOrEqual(4.5);

    // Light card borders meet 3:1 against their surface (02-UAT Test-4).
    const firstCard = page.locator("[data-slot='card']").first();
    const borderColor = await firstCard.evaluate((el) =>
      getComputedStyle(el).borderColor,
    );
    const surfaceBg = await firstCard.evaluate((el) =>
      getComputedStyle(el).backgroundColor,
    );
    const borderContrast = await contrastRatio(page, borderColor, surfaceBg);
    expect(borderContrast).toBeGreaterThanOrEqual(3);
  });
});

test.describe("brand assets — light-safe 404 (PageNotFound treatment)", () => {
  test("not-found heading is token-driven; the Lottie sits on its dark illustration plate", async ({
    page,
  }) => {
    await page.goto("/this-page-does-not-exist");

    const heading = page.getByRole("heading", { name: "Page Not Found" });
    await expect(heading).toBeVisible();
    await expectTokenTextColor(page, heading, "--foreground");

    // The 404 artwork's dark plate (bg-surface-deep) — the both-mode-safe
    // surface that keeps the asset's white/slate strokes visible in light.
    const plate = page.locator(".bg-surface-deep");
    await expect(plate).toBeVisible();
    const expectedPlate = await tokenColor(page, "--surface-deep");
    await expect(plate).toHaveCSS("background-color", expectedPlate);
  });
});

// 08-09 tier-2 legs (UI-03 part 2, D-27): the public status page — the only
// surface visitors see — renders on the token substrate in BOTH themes, with
// the emerald/rose ternaries migrated to status tokens and the cyan
// emphasis on the uptime/latency values (reserved accent item 2).
test.describe("public status page — tier-2 token substrate (both themes)", () => {
  test("populated: badges + cyan values resolve from tokens in light AND dark; no raw palette utilities", async ({
    page,
  }) => {
    // Dedicated visitor user so the primary e2e user's data stays clean for
    // the incidents legs below (declaration order = execution order).
    const statusUserId = await seedE2EUser(
      "e2e-pubstatus@spidernode.test",
      "E2E-PubStatus-Password-1",
      "E2E Pub Status User",
    );
    await seedMonitor(statusUserId, "E2E Pub Status Monitor", "DOWN");

    await page.goto(`/status/${statusUserId}`);

    // DOWN monitor -> "Down" badge flows from --status-down (the migrated
    // rose ternary), in the forced light theme first...
    const badge = page.getByTestId("public-status-badge").first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("Down");
    await expect(badge).toHaveCSS("color", await tokenColor(page, "--status-down"));

    // ...and the banner headline carries the same token (PARTIAL OUTAGE).
    await expectTokenTextColor(
      page,
      page.getByText("PARTIAL OUTAGE"),
      "--status-down",
    );

    // Uptime value emphasis is cyan through the token (reserved item 2 —
    // the light variant applies automatically; #00E5FF stays the dark value).
    const uptimeValue = page.getByTestId("public-uptime-value").first();
    await expect(uptimeValue).toHaveCSS(
      "color",
      await tokenColor(page, "--accent-cyan"),
    );

    // The page renders under the bare root layout (no marketing chrome), so
    // a whole-page sweep proves the surface carries zero raw palette
    // utilities in light.
    await expectNoRawPaletteClasses(page.locator("body"));

    // Dark leg: the same assertions hold with the .dark token values.
    await forceDarkTheme(page);
    await page.reload();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveCSS("color", await tokenColor(page, "--status-down"));
    await expect(uptimeValue).toHaveCSS(
      "color",
      await tokenColor(page, "--accent-cyan"),
    );
    await expectNoRawPaletteClasses(page.locator("body"));
  });

  test("404: contract heading + body render token-driven", async ({ page }) => {
    await page.goto("/status/does-not-exist-user-id");

    const heading = page.getByRole("heading", { name: "Status Page Not Found" });
    await expect(heading).toBeVisible();
    await expectTokenTextColor(page, heading, "--foreground");

    // Copywriting Contract row, verbatim.
    await expect(
      page.getByText("This status page does not exist or has been removed."),
    ).toBeVisible();
    await expectNoRawPaletteClasses(page.locator("body"));
  });

  test("loading: stalled API keeps the public status skeleton on screen (D-28)", async ({
    page,
  }) => {
    // Never-fulfilling route: the load fetch stays pending so the skeleton
    // state is observed deterministically (UI-SPEC loading row for the
    // public status surface).
    await page.route("**/api/status/**", () => new Promise(() => {}));
    await page.goto("/status/any-user-id");

    await expect(page.getByTestId("public-status-skeleton")).toBeVisible();
  });
});

// 08-09 tier-2 legs: /dashboard/incidents — skeleton loading (the plan's
// named tier-2 target), the empty-state copy, and both-theme status-token
// resolution on the ACTIVE/RESOLVED badges.
test.describe("incidents page — tier-2 token substrate (both themes)", () => {
  test("empty: All Clear state renders token-driven with zero raw palette utilities", async ({
    page,
  }) => {
    await loginViaUi(page);
    await page.goto("/dashboard/incidents");

    await expect(page.getByText("All Clear!")).toBeVisible();
    await expect(
      page.getByText("No incidents recorded yet. Your monitors are healthy and running smoothly."),
    ).toBeVisible();

    // Scoped to the Incidents root (the sidebar/header chrome belongs to
    // their own reconciliation legs).
    const incidentsRoot = page
      .getByRole("heading", { name: "Incident Log" })
      .locator("xpath=ancestor::div[contains(@class, 'min-h-screen')][1]");
    await expectNoRawPaletteClasses(incidentsRoot);

    // Headline is token-driven in the forced light theme.
    await expectTokenTextColor(
      page,
      page.getByRole("heading", { name: "Incident Log" }),
      "--foreground",
    );
  });

  test("populated: ACTIVE/RESOLVED badges resolve from status tokens in light AND dark", async ({
    page,
  }) => {
    const email = "e2e-incidents@spidernode.test";
    const password = "E2E-Incidents-Password-1";
    const userId = await seedE2EUser(email, password, "E2E Incidents User");
    const monitorId = await seedMonitor(userId, "E2E Incidents Monitor");
    await seedOngoingIncident(monitorId, "Seeded ongoing outage for the both-theme leg");
    await seedResolvedIncident(monitorId, "Seeded resolved incident for the both-theme leg");

    await loginViaUi(page, email, password);
    await page.goto("/dashboard/incidents");

    const activeBadge = page.getByTestId("incident-badge").filter({
      hasText: "ACTIVE",
    });
    const resolvedBadge = page.getByTestId("incident-badge").filter({
      hasText: "RESOLVED",
    });
    await expect(activeBadge).toBeVisible();
    await expect(resolvedBadge).toBeVisible();

    // Light: ONGOING -> --status-down, RESOLVED -> --status-up (the
    // migrated emerald/rose ternaries).
    await expect(activeBadge).toHaveCSS(
      "color",
      await tokenColor(page, "--status-down"),
    );
    await expect(resolvedBadge).toHaveCSS(
      "color",
      await tokenColor(page, "--status-up"),
    );

    const incidentsRoot = page
      .getByRole("heading", { name: "Incident Log" })
      .locator("xpath=ancestor::div[contains(@class, 'min-h-screen')][1]");
    await expectNoRawPaletteClasses(incidentsRoot);

    // Dark leg: same resolutions through the .dark token values.
    await forceDarkTheme(page);
    await page.reload();
    await expect(activeBadge).toHaveCSS(
      "color",
      await tokenColor(page, "--status-down"),
    );
    await expect(resolvedBadge).toHaveCSS(
      "color",
      await tokenColor(page, "--status-up"),
    );
  });

  test("loading: stalled API keeps the incidents skeleton on screen (D-28)", async ({
    page,
  }) => {
    await loginViaUi(page);
    await page.route("**/api/incidents", () => new Promise(() => {}));
    await page.goto("/dashboard/incidents");

    await expect(page.getByTestId("incidents-skeleton")).toBeVisible();
  });
});
