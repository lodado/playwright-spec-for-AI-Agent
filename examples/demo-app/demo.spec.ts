// @qa-page: demo
// @qa-scenario: ACTIVE
// @qa-always-run: true

/*
 * The spec behind `npx playwright-spec-for-ai-agent demo`. It is a real
 * Playwright spec — the demo serves index.html next to it and runs the whole
 * pipeline against it with the offline `fixture` adapter, so the command needs
 * no staging site, no credentials, and no network.
 */

import { expect, test } from "@playwright/test";

test.describe("Demo dashboard - Growth plan", () => {
  // @qa-live-policy: readonly
  test("shows the plan name in the header", async ({ page }) => {
    await expect(page.getByTestId("plan-name")).toBeVisible();
    await expect(page.getByTestId("plan-name")).toHaveText("Growth");
  });

  // @qa-live-policy: readonly
  test("shows an account health score", async ({ page }) => {
    await expect(page.getByTestId("health-score")).toBeVisible();
  });

  // @qa-live-policy: safe-interaction
  test("opens the plan details panel", async ({ page }) => {
    await page.getByTestId("plan-details-btn").click();
    await expect(page.getByTestId("plan-details")).toBeVisible();
  });

  // @qa-live-policy: auth-mock
  test("rejects an unknown email and password", async ({ page }) => {
    // Auth is mocked in CI; on live staging this would need a real account, so
    // the judge is told to skip it rather than guess.
    await page.getByTestId("email").fill("nobody@acme.test");
    await page.getByTestId("password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("login-error")).toBeVisible();
  });
});
