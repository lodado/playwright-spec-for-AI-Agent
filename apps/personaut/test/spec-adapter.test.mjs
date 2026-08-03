import assert from "node:assert/strict";
import test from "node:test";
import { compilePlaywrightIRToStudyResult } from "../src/spec-adapter.mjs";

test("Playwright StudySpec compiler maps expectations and safety without weakening blocked policies", () => {
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

  assert.deepEqual(studySpec.tasks[0].successOracles[0], { id: studySpec.tasks[0].successOracles[0].id, type: "visible_text", operation: "contains", value: "$10" });
  assert.equal(studySpec.tasks[1].safetyPolicy.allowClick, false);
  assert.equal(studySpec.tasks[1].abandonmentAllowed, false);
  assert.deepEqual(warnings.map(item => item.code), ["MOCK_ONLY_EXPECTATION", "BLOCKED_MUTATION"]);
});
