import { describe, expect, it } from "vitest";
import { compilePlaywrightIRToStudyResult } from "../src/compiler.mjs";

describe("Playwright StudySpec compiler", () => {
  it("maps expectations and safety without weakening blocked policies", () => {
    const { studySpec, warnings } = compilePlaywrightIRToStudyResult({
      schemaVersion: "qa-ir/0.1",
      sourceDirectory: "tests",
      scenarios: [{
        scenarioId: "PRICING",
        sourceFile: "pricing.spec.ts",
        label: "Pricing",
        page: "/pricing",
        tests: [
          { checkId: "price", title: "shows price", liveRunPolicy: "executable-readonly", expectations: [{ type: "containText", expected: { kind: "literal", value: "$10" } }] },
          { checkId: "buy", title: "changes subscription", liveRunPolicy: "blocked-subscription-mutation", expectations: [] },
        ],
      }],
    }, { baseUrl: "https://example.test" });

    expect(studySpec.tasks[0].successOracles[0]).toMatchObject({ type: "visible_text", operation: "contains", value: "$10" });
    expect(studySpec.tasks[1].safetyPolicy.allowClick).toBe(false);
    expect(studySpec.tasks[1].abandonmentAllowed).toBe(false);
    expect(warnings.map(item => item.code)).toEqual(["MOCK_ONLY_EXPECTATION", "BLOCKED_MUTATION"]);
  });
});
