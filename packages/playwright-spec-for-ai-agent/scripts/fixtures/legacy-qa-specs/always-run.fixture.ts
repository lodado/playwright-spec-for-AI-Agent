// @qa-scenario: GLOBAL_NAV
// @qa-always-run: true

// @qa-live-policy: readonly
test("always checks navigation shell", async ({ page }) => {
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});
