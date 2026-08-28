import { describe, expect, it } from "vitest";
import { crossCheckLivePlan } from "../live-plan-cross-check.mjs";

/**
 * The parser reads a test's assertions independently of the abstraction agent.
 * Two independent derivations from the same source disagreeing is the only
 * signal available that one of them is wrong, so a mismatch caps the check at
 * manual_review rather than silently trusting the prose.
 */
const specWithLocators = {
  scenarios: [
    {
      scenarioId: "ACTIVE",
      sourceFile: "dash.spec.ts",
      tests: [
        {
          title: "shows plan",
          checkId: "shows-plan",
          liveRunPolicy: "executable-readonly",
          parserIntegrity: "complete",
          expectations: [
            {
              type: "containText",
              locator: { kind: "testId", value: "plan-name" },
              expected: { kind: "literal", value: "Growth" },
            },
          ],
        },
      ],
    },
  ],
};

const planFor = (body: string) =>
  ["### ACTIVE — shows plan", body].join("\n");

describe("crossCheckLivePlan as an oracle over the agent plan", () => {
  it("to report no disagreement when the plan names the locator the parser read", () => {
    const result = crossCheckLivePlan(
      specWithLocators,
      planFor(
        [
          "Given: the dashboard is open",
          'When: the plan name area is read',
          'Then: `plan-name` shows the account plan',
          "Never: the area is empty; mutations: 0",
        ].join("\n")
      )
    );

    expect(result.disagreements).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it("to flag a plan that never mentions the locator the parser read", () => {
    const result = crossCheckLivePlan(
      specWithLocators,
      planFor(
        [
          "Given: the dashboard is open",
          "When: the page settles",
          "Then: the page looks correct",
          "Never: an error appears; mutations: 0",
        ].join("\n")
      )
    );

    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0]).toMatchObject({
      scenarioId: "ACTIVE",
      title: "shows plan",
      kind: "locator-unmentioned",
    });
    expect(result.disagreements[0].missing).toEqual(["plan-name"]);
  });

  it("to stay silent for a test whose assertions the parser could not read", () => {
    const unreadable = {
      scenarios: [
        {
          scenarioId: "ACTIVE",
          sourceFile: "dash.spec.ts",
          tests: [
            {
              title: "shows plan",
              liveRunPolicy: "judgment-parser-gap",
              parserIntegrity: "incomplete",
              expectations: [],
            },
          ],
        },
      ],
    };

    const result = crossCheckLivePlan(
      unreadable,
      planFor("Given: a\nWhen: b\nThen: c\nNever: d")
    );

    // Nothing was read, so there is no second opinion to disagree with.
    expect(result.disagreements).toEqual([]);
    expect(result.checked).toBe(0);
  });

  it("to stay silent when no plan was produced at all", () => {
    expect(crossCheckLivePlan(specWithLocators, null)).toEqual({
      checked: 0,
      disagreements: [],
    });
  });
});
