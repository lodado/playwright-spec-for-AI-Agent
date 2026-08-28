import { describe, expect, it } from "vitest";
import { buildGwtPromptSpec } from "../abstract-ai-payload.mjs";
import { buildAbstractHermesQuery } from "../run-hermes-spec-abstractor.mjs";

describe("buildGwtPromptSpec", () => {
  it("includes only qaLivePolicy annotation per test", () => {
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
    });
    expect(compact.scenarios[0].tests[0]).not.toHaveProperty("liveRunPolicy");
    expect(compact.scenarios[0]).not.toHaveProperty("fileAnnotations");
  });

  it("to quote the playwright source of each runnable test so the plan is derived from the spec, not from the parser", () => {
    const compact = buildGwtPromptSpec(
      {
        scenarios: [
          {
            scenarioId: "ACTIVE",
            label: "Active",
            sourceFile: "dash.spec.ts",
            tests: [
              {
                title: "shows plan",
                checkId: "shows-plan",
                livePolicyAnnotation: "readonly",
                liveRunPolicy: "executable-readonly",
              },
              {
                title: "cancels plan",
                checkId: "cancels-plan",
                livePolicyAnnotation: "subscription-mutation",
                liveRunPolicy: "blocked-subscription-mutation",
              },
            ],
          },
        ],
      },
      {
        specSourceFiles: {
          "dash.spec.ts": [
            'test("shows plan", async ({ page }) => {',
            '  await expect(page.getByTestId("plan")).toHaveScreenshot();',
            "});",
            'test("cancels plan", async ({ page }) => {',
            '  await page.getByTestId("cancel").click();',
            "});",
          ].join("\n"),
        },
      },
    );

    // The parser cannot represent toHaveScreenshot, but the agent still sees it.
    expect(compact.scenarios[0].tests[0].source).toContain("toHaveScreenshot()");
    // A blocked test is never run: quoting it is prompt weight with no reader.
    expect(compact.scenarios[0].tests[1]).not.toHaveProperty("source");
  });
});

describe("buildAbstractHermesQuery", () => {
  it("demands a Never clause per block and mutations: 0 for readonly", () => {
    const query = buildAbstractHermesQuery({ task: "abstract-qa-spec-gwt" });

    expect(query).toContain("`Never:` line");
    expect(query).toContain("mutations: 0");
    expect(query).toContain("Never invent a test");
    expect(query).toContain("Never: ...");
  });

  it("to tell the agent the playwright source outranks the test title", () => {
    const query = buildAbstractHermesQuery({ task: "abstract-qa-spec-gwt" });

    expect(query).toContain("`source`");
    expect(query).toContain("authority on what the check asserts");
  });
});
