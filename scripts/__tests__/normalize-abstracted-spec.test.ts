import { describe, expect, it } from "vitest";
import { normalizeAbstractAiResult } from "../normalize-abstracted-spec.mjs";

const baseSpec = {
  abstraction: { rulesVersion: "1.0.0", stage: "rules" },
  scenarios: [
    {
      scenarioId: "ACTIVE",
      tests: [{ checkId: "t1", title: "shows score" }],
    },
  ],
};

describe("normalizeAbstractAiResult", () => {
  it("keeps input spec and attaches livePlan as-is", () => {
    const livePlan =
      "### ACTIVE — shows score\nGiven user\nWhen view\nThen score";
    const result = normalizeAbstractAiResult(baseSpec, { livePlan });

    expect(result.ok).toBe(true);
    expect(result.livePlan).toBe(livePlan);
    expect(result.spec.scenarios).toEqual(baseSpec.scenarios);
    expect(result.spec.abstraction.stage).toBe("rules+ai-gwt");
  });

  it("succeeds with empty livePlan (rule GWT fallback in markdown render)", () => {
    const result = normalizeAbstractAiResult(baseSpec, { livePlan: "  " });

    expect(result.ok).toBe(true);
    expect(result.livePlan).toBeNull();
    expect(result.spec.abstraction.stage).toBe("rules");
  });
});
