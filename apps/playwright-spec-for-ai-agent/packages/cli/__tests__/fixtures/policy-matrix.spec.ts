// @qa-scenario: DASHBOARD_INACTIVE
test.describe("inactive dashboard", () => {
  // @qa-live-policy: mock-judgment
  test("renders localized empty state", async ({ page }) => {
    await expect(page.getByText("No active plans")).toBeVisible();
  });
  // @qa-live-policy: mock-judgment
  test("renders usage summary", async ({ page }) => {
    await expect(page.getByText("Usage")).toBeVisible();
  });
  // @qa-live-policy: readonly
  test("shows dashboard heading", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
  // @qa-live-policy: readonly
  test("shows metrics", async ({ page }) => {
    await expect(page.getByText("Metrics")).toBeVisible();
  });
  // @qa-live-policy: safe-interaction
  test("opens settings", async ({ page }) => {
    await page.getByTestId("settings").click();
    await expect(page.getByText("Settings Panel")).toBeVisible();
  });
});
