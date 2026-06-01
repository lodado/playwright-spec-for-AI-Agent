import { describe, expect, it } from "vitest";
import { normalizeAbstractAiResult } from "../normalize-abstracted-spec.mjs";

const baseSpec = {
  scenarios: [
    {
      scenarioId: "ACTIVE",
      tests: [
        {
          checkId: "t1",
          title: "shows score",
          liveRunPolicy: "judgment-mock-api",
          expectations: [
            {
              type: "containText",
              expected: { kind: "semantic", intent: "score visible" },
            },
          ],
        },
      ],
    },
  ],
};

describe("normalizeAbstractAiResult", () => {
  it("accepts valid AI output with matching structure", () => {
    const result = normalizeAbstractAiResult(baseSpec, {
      spec: {
        ...baseSpec,
        abstraction: { stage: "rules+ai" },
        scenarios: [
          {
            ...baseSpec.scenarios[0],
            tests: [
              {
                ...baseSpec.scenarios[0].tests[0],
                liveIntent: "User sees a score",
              },
            ],
          },
        ],
      },
      changes: [
        {
          checkId: "t1",
          field: "liveIntent",
          reason: "clarified",
          confidence: "high",
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.spec?.scenarios[0].tests[0].liveIntent).toBe(
      "User sees a score"
    );
  });

  it("rejects when liveRunPolicy changes", () => {
    const result = normalizeAbstractAiResult(baseSpec, {
      spec: {
        scenarios: [
          {
            scenarioId: "ACTIVE",
            tests: [
              {
                ...baseSpec.scenarios[0].tests[0],
                liveRunPolicy: "executable-readonly",
              },
            ],
          },
        ],
      },
      changes: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.some(e => /liveRunPolicy/.test(e))).toBe(true);
  });

  it("rejects when all expectations are removed", () => {
    const result = normalizeAbstractAiResult(baseSpec, {
      spec: {
        scenarios: [
          {
            scenarioId: "ACTIVE",
            tests: [
              {
                ...baseSpec.scenarios[0].tests[0],
                expectations: [],
              },
            ],
          },
        ],
      },
      changes: [],
    });

    expect(result.ok).toBe(false);
  });
});
