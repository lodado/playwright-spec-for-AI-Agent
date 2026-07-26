// @qa-scenario: DASHBOARD_READONLY
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png
test.describe("dashboard readonly", () => {
  // @qa-live-policy: readonly
  test("shows stable dashboard copy", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByTestId("credit-remaining")).toContainText("Credit 42,835");
  });

  // @qa-fixture: invoice=tests/fixtures/invoice.pdf
  // @qa-live-policy: safe-interaction
  test("uploads avatar fixture", async ({ page }) => {
    await page.getByTestId("avatar-input").setInputFiles("tests/fixtures/qa-avatar.png");
    await expect(page.getByText("Avatar uploaded")).toBeVisible();
  });
});
