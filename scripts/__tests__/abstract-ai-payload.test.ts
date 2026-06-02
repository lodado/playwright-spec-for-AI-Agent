import { describe, expect, it } from "vitest";
import { buildGwtPromptSpec } from "../abstract-ai-payload.mjs";

describe("buildGwtPromptSpec", () => {
  it("includes file and test annotation context", () => {
    const compact = buildGwtPromptSpec({
      scenarios: [
        {
          scenarioId: "CREDIT_BVA",
          page: "dashboard",
          label: "BVA",
          sourceFile: "dashboard-credit-bva.spec.ts",
          alwaysRun: true,
          tests: [
            {
              title: "credit zero",
              checkId: "to-be-0",
              livePolicyAnnotation: "mock-judgment",
              liveRunPolicy: "judgment-mock-api",
              stagingMode: "read-only",
            },
          ],
        },
      ],
    });

    expect(compact.annotationLegend).toBeDefined();
    expect(compact.scenarios[0].fileAnnotations).toMatchObject({
      qaScenario: "CREDIT_BVA",
      qaPage: "dashboard",
      qaAlwaysRun: true,
    });
    expect(compact.scenarios[0].tests[0].testAnnotations).toMatchObject({
      qaLivePolicy: "mock-judgment",
      liveRunPolicy: "judgment-mock-api",
      stagingMode: "read-only",
    });
  });
});
