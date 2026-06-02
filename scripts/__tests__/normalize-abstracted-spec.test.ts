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

const sampleLivePlan = [
  "## Active",
  "",
  "id:`ACTIVE` file:`x.spec.ts`",
  "",
  "### 1. shows score",
  "",
  "**Given:**",
  "- `ACTIVE`",
  "**When:**",
  "- View page; judge by intent (mock-api).",
  "**Then:**",
  "- score visible",
  "",
].join("\n");

describe("normalizeAbstractAiResult", () => {
  it("accepts valid AI output with matching structure and livePlan", () => {
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
      livePlan: sampleLivePlan,
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
    expect(result.livePlan).toContain("shows score");
    expect(result.spec?.scenarios[0].tests[0].liveIntent).toBe(
      "User sees a score",
    );
  });

  it("rejects when livePlan is missing a test title", () => {
    const result = normalizeAbstractAiResult(baseSpec, {
      spec: baseSpec,
      livePlan: "**Given:**\n- x\n**When:**\n- y\n**Then:**\n- z",
      changes: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /missing test title/.test(e))).toBe(true);
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
      livePlan: sampleLivePlan,
      changes: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /liveRunPolicy/.test(e))).toBe(true);
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
      livePlan: sampleLivePlan,
      changes: [],
    });

    expect(result.ok).toBe(false);
  });
});
