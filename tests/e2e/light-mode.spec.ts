import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  closeSeedPool,
  E2E_EMAIL,
  E2E_PASSWORD,
  resetE2EData,
  seedE2EUser,
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

// WCAG contrast between two computed rgb()/rgba() strings, computed in-page —
// proves the LIGHT token VALUES meet AA (the split's whole point), not just
// that a token resolved.
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
