import { describe, expect, it } from "vitest";
import { buildGwtPromptSpec } from "../abstract-ai-payload.mjs";

describe("buildGwtPromptSpec", () => {
  it("includes compact actions and expectations with the declared policy", () => {
    const compact = buildGwtPromptSpec({
      scenarios: [
        {
          scenarioId: "CREDIT_BVA",
          page: "dashboard",
          label: "BVA",
          sourceFile: "dashboard-credit-bva.spec.ts",
          alwaysRun: true,
          liveSkip: false,
          tests: [
            {
              title: "credit zero",
              checkId: "to-be-0",
              livePolicyAnnotation: "mock-judgment",
              liveRunPolicy: "judgment-mock-api",
              stagingMode: "read-only",
              actions: [{ type: "click", target: { kind: "text", value: "Details" }, arguments: [] }],
              expectations: [{ type: "visible", locator: { kind: "role", role: "dialog", name: "Details" } }],
            },
          ],
        },
      ],
    });

    expect(compact.scenarios[0]).toMatchObject({
      scenarioId: "CREDIT_BVA",
      alwaysRun: true,
    });
    expect(compact.scenarios[0].tests[0]).toMatchObject({
      title: "credit zero",
      checkId: "to-be-0",
      qaLivePolicy: "mock-judgment",
      actions: [{ type: "click", target: { kind: "text", value: "Details" }, arguments: [] }],
      expectations: [{ type: "visible", locator: { kind: "role", role: "dialog", name: "Details" } }],
    });
    expect(compact.scenarios[0].tests[0]).not.toHaveProperty("liveRunPolicy");
    expect(compact.scenarios[0]).not.toHaveProperty("fileAnnotations");
  });
});
