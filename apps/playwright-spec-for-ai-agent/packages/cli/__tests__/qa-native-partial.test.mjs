import { describe, expect, it } from "vitest";
import { withoutBlockedScenarios } from "../qa-native-execute.mjs";
import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { createExecutionPlan } from "../../core/index.mjs";
import { playwrightExecutionCapabilities } from "../../provider-playwright/index.mjs";

const qaIr = (blockedScenarioIds) => ({
  suites: [{ id: "s1", scenarios: [{ id: "keep" }, { id: "drop" }] }],
  extensions: { sourceContentHash: "sha256:abc", ...(blockedScenarioIds ? { blockedScenarioIds } : {}) },
});

describe("withoutBlockedScenarios", () => {
  it("drops blocked scenarios and strips the blocked list", () => {
    const filtered = withoutBlockedScenarios(qaIr(["drop"]));
    expect(filtered.suites[0].scenarios.map((s) => s.id)).toEqual(["keep"]);
    expect(filtered.extensions).toEqual({ sourceContentHash: "sha256:abc" });
  });

  it("returns the input unchanged when nothing is blocked", () => {
    const input = qaIr();
    expect(withoutBlockedScenarios(input)).toBe(input);
  });

  it("does not mutate the source qa ir", () => {
    const input = qaIr(["drop"]);
    withoutBlockedScenarios(input);
    expect(input.suites[0].scenarios.map((s) => s.id)).toEqual(["keep", "drop"]);
    expect(input.extensions.blockedScenarioIds).toEqual(["drop"]);
  });
});

describe("partial execution of a mixed spec", () => {
  const mixedSource = [
    "// @qa-scenario: MIXED",
    "// @qa-page: /dashboard",
    "// @qa-live-policy: readonly",
    'test("runnable", async ({ page }) => {',
    '  await expect(page.getByText("Ready")).toBeVisible();',
    "});",
    "// @qa-live-policy: skip",
    'test("skipped", async ({ page }) => {',
    '  await expect(page.getByText("Nope")).toBeVisible();',
    "});",
    "",
  ].join("\n");

  it("prunes the policy-blocked scenario and plans the runnable remainder", () => {
    const compiled = compilePlaywrightSpec({ source: mixedSource, sourcePath: "mixed.spec.ts" });
    const pruned = withoutBlockedScenarios(compiled.qaIr);

    expect(pruned.suites[0].scenarios).toHaveLength(1);
    expect(() =>
      createExecutionPlan({ qaIr: pruned, providerCapabilities: playwrightExecutionCapabilities() }),
    ).not.toThrow();
  });

  it("would explode the plan without pruning — the regression --allow-partial must survive", () => {
    const compiled = compilePlaywrightSpec({ source: mixedSource, sourcePath: "mixed.spec.ts" });

    expect(() =>
      createExecutionPlan({ qaIr: compiled.qaIr, providerCapabilities: playwrightExecutionCapabilities() }),
    ).toThrow(/navigation is blocked/);
  });
});
