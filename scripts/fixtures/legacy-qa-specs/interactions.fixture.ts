// @qa-scenario: DASHBOARD_INTERACTIONS
// @qa-live-policy: safe-interaction
test.describe("dashboard interactions", () => {
  test("opens subscription history", async ({ page }) => {
    await page.getByTestId("subscription-history-button").click();
    await expect(page.getByText("Subscription History")).toBeVisible();
  });

  // @qa-live-policy: safe-interaction-no-confirm
  test("stops before destructive confirmation", async ({ page }) => {
    await page.getByTestId("cancel-subscription-button").click();
    await expect(page.getByRole("button", { name: "Confirm cancellation" })).toBeVisible();
  });

  // @qa-live-policy: mock-judgment
  test("uses mocked credits response", async ({ page }) => {
    await page.route("**/api/v1/credits", route => route.fulfill({ status: 200, body: "{}" }));
    await expect(page.getByTestId("credit-remaining")).toContainText("Credit 0");
  });

  // @qa-live-policy: subscription-mutation
  test("resumes subscription with mocked post", async ({ page }) => {
    await page.route("**/api/v1/plans/subscription/resume", route => route.fulfill({ status: 204 }));
    await page.getByRole("button", { name: "Resume subscription" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
  });
});
