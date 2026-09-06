import { test, expect, type Page } from "@playwright/test";

/**
 * Type the password and submit.
 *
 * The login form is a "use client" component inside <Suspense>, so the
 * server-rendered button ships with `disabled` (password state is ""). A bare
 * fill() writes the DOM value, but until React hydrates there is no onChange
 * listener to lift it into state, so the button stays disabled and the click
 * times out. Re-fill under toPass until hydration has attached the handler and
 * the button actually enables.
 */
async function signIn(page: Page, password: string): Promise<void> {
  const field = page.getByTestId("login-password");
  const submit = page.getByTestId("login-submit");
  await expect(async () => {
    await field.fill(password);
    await expect(submit).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await submit.click();
}

test.describe("dashboard smoke (no database, password auth)", () => {
  test("gated pages redirect to login, login works, pages render, /sync redirects", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, "test-pw");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator("h1").first()).toBeVisible();
    for (const path of ["/setup", "/routines", "/workouts", "/settings", "/history", "/mappings"]) {
      const res = await page.goto(path);
      expect(res?.status(), `${path} status`).toBeLessThan(500);
      await expect(page.locator("h1").first()).toBeVisible();
    }
    await page.goto("/sync");
    await expect(page).toHaveURL(/\/dashboard/);
  });
  test("every nav destination is reachable by clicking the nav", async ({ page }) => {
    // goto() proves a route renders; it says nothing about whether a user can
    // get there. Walk the nav itself so a broken Link, a wrong href or a nav
    // that fails to render is caught. Both bars carry the same seven items and
    // CSS shows exactly one, so scope to the visible nav to stay correct on the
    // desktop and mobile projects alike.
    await page.goto("/login");
    await signIn(page, "test-pw");
    await expect(page).toHaveURL(/\/dashboard/);

    const destinations: [label: string, path: string][] = [
      ["Workouts", "/workouts"],
      ["Routines", "/routines"],
      ["Mappings", "/mappings"],
      ["History", "/history"],
      ["Settings", "/settings"],
      ["Setup", "/setup"],
      ["Dashboard", "/dashboard"],
    ];

    for (const [label, path] of destinations) {
      // Not an exact name match: the mobile bar composes each link from an icon
      // span and a label span, so its accessible name is "≡ Workouts" while the
      // desktop bar's is "Workouts". Substring matching covers both, and no two
      // labels are substrings of one another.
      await page
        .locator("nav:visible")
        .getByRole("link", { name: label })
        .click();
      await expect(page, `nav "${label}" should land on ${path}`).toHaveURL(
        new RegExp(`${path}$`),
      );
      await expect(page.locator("h1").first()).toBeVisible();
    }
  });

  test("a wrong password stays on login with an error", async ({ page }) => {
    await page.goto("/login");
    await signIn(page, "nope");
    await expect(page.getByText("Incorrect password")).toBeVisible();   // (role=alert is shared with Next's route announcer)
    await expect(page).toHaveURL(/\/login/);
  });
});
