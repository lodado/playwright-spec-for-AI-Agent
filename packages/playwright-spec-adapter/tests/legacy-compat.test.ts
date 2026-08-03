import { describe, expect, it } from "vitest";
import {
  literalExpectedForLive,
  parseDashboardSpecFile,
} from "playwright-spec-extract/spec-parser";
import { collectLiveSkippedEntries } from "../src/policy/live-filter.mjs";

describe("playwright-spec-adapter shared extraction", () => {
  it("preserves parser, abstraction, and live filter behavior", () => {
    const spec = parseDashboardSpecFile(
      "pricing.spec.ts",
      `// @qa-page: pricing
// @qa-scenario: ACTIVE
// @qa-live-policy: readonly
test("shows credits", async ({ page }) => {
  await expect(page.getByTestId("credit-remaining")).toContainText("Credit 0");
});
// @qa-live-policy: skip
test("skipped on live", async ({ page }) => {
  await expect(page.getByText("Hidden")).toBeVisible();
});`,
    );

    expect(spec?.tests[0].expectations[0].expected).toEqual({
      kind: "regex",
      pattern: "Credit [\\d,]+",
    });
    expect(literalExpectedForLive("98점")).toMatchObject({
      kind: "semantic",
      constraints: [{ type: "numeric", role: "score" }],
    });
    expect(collectLiveSkippedEntries({ scenarios: [spec] })).toMatchObject([
      { scenarioId: "ACTIVE", title: "skipped on live", reason: "@qa-live-policy: skip" },
    ]);
  });
});
