// @qa-scenario: AUTH_MOCK
// @qa-live-policy: auth-mock
test("redirects unauthenticated users", async ({ page }) => {
  await page.route("**/api/v1/auth/me", route => route.fulfill({ status: 401, body: "{}" }));
  await expect(page).toHaveURL(/\/login/);
});
