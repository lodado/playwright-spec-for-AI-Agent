import assert from "node:assert/strict";
import test from "node:test";
import {
  literalExpectedForLive,
  parseDashboardSpecFile,
} from "playwright-spec-extract/spec-parser";
import { collectLiveSkippedEntries } from "../src/spec-adapter-live-filter.mjs";

test("shared extraction preserves parser, abstraction, and live filter behavior", () => {
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

  assert.deepEqual(spec?.tests[0].expectations[0].expected, {
      kind: "regex",
      pattern: "Credit [\\d,]+",
    });
  assert.deepEqual(literalExpectedForLive("98점"), {
    kind: "semantic",
    intent: "A numeric score with unit is displayed",
    constraints: [{ type: "numeric", role: "score" }],
    liveNote: "mock score with unit; live accepts any numeric score",
    provenance: { rule: "score-ko", originalLiteral: "98점" },
  });
  assert.deepEqual(collectLiveSkippedEntries({ scenarios: [spec] }), [
      { sourceFile: "pricing.spec.ts", scenarioId: "ACTIVE", title: "skipped on live", reason: "@qa-live-policy: skip" },
    ]);
});
