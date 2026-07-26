// @qa-scenario: ACTIVE
// File-level annotation: this spec targets the ACTIVE subscription state.
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png
// @qa-live-skip: true on a file means Hermes skips it entirely on live staging.
// @qa-always-run: true means Hermes runs this file regardless of plan/status.

import { expect, test } from "@playwright/test";

test.describe("Dashboard - Active subscription", () => {
  // @qa-live-policy: readonly
  test("shows the user plan name in the header", async ({ page }) => {
    await expect(page.getByTestId("plan-name")).toBeVisible();
  });

  // @qa-live-policy: safe-interaction — safe UI action; Hermes replays steps and verifies on live staging
  test.describe("when 'View full subscription history' button is clicked", () => {
    test("opens the subscription history dialog", async ({ page }) => {
      await page.getByTestId("subscription-history-btn").click();
      await expect(page.getByRole("dialog")).toBeVisible();
    });
  });

  // @qa-live-policy: safe-interaction
  // @qa-fixture: avatar=tests/fixtures/qa-avatar.png
  test("uploads a profile image", async ({ page }) => {
    await page
      .getByTestId("avatar-input")
      .setInputFiles("tests/fixtures/qa-avatar.png");
    await expect(page.getByTestId("avatar-preview")).toBeVisible();
  });

  // @qa-live-policy: subscription-mutation
  test("cancels subscription", async ({ page }) => {
    // This test mutates subscription state — blocked on live staging.
    // Hermes will skip this test and note why in the judgment report.
    await page.getByTestId("cancel-btn").click();
    await page.getByRole("button", { name: "Confirm" }).click();
  });
});
