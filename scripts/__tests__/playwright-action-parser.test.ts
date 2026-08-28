import { describe, expect, it } from "vitest";
import { parseDashboardSpecFile, parseSafeActions } from "../dashboard-spec-parser.mjs";

describe("Playwright actions as ordered static QA steps", () => {
  it("to preserve fill click and navigation source order", () => {
    const body = `
      await page.getByLabel("Email").fill("qa@example.com");
      await page.getByRole("button", { name: "Save" }).click();
      await page.goto("/dashboard");
    `;
    expect(parseSafeActions(body)).toEqual([
      expect.objectContaining({ type: "action", method: "fill", value: "qa@example.com" }),
      expect.objectContaining({ type: "action", method: "click" }),
      { type: "navigation", method: "goto", value: "/dashboard" },
    ]);
  });

  it("to attach ordered steps to interaction tests", () => {
    const parsed = parseDashboardSpecFile("actions.spec.ts", `// @qa-scenario: ACTIVE
// @qa-live-policy: safe-interaction
test("edits profile", async ({ page }) => {
  await page.getByLabel("Name").fill("Ada");
  await page.getByRole("button", { name: "Save" }).click();
});`);
    expect(parsed?.tests[0].steps).toHaveLength(2);
    expect(parsed?.tests[0].steps.map(step => step.method)).toEqual(["fill", "click"]);
  });
});
