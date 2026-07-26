// @qa-scenario: LIVE_SKIP
// @qa-live-skip: true

test("is skipped from live QA", async ({ page }) => {
  await expect(page.getByText("Not safe for staging")).toBeVisible();
});
