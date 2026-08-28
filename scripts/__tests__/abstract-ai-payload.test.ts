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

  it("to carry every declared annotation so the plan is written against the contract", () => {
    const compact = buildGwtPromptSpec({
      scenarios: [
        {
          scenarioId: "ACTIVE",
          page: "dashboard",
          label: "Active",
          sourceFile: "dash.spec.ts",
          fixtures: { logo: "tests/fixtures/logo.png" },
          tests: [
            {
              title: "shows plan",
              checkId: "shows-plan",
              livePolicyAnnotation: "readonly",
              liveRunPolicy: "executable-readonly",
              fixtures: { avatar: "tests/fixtures/avatar.png" },
            },
          ],
        },
      ],
    });

    expect(compact.scenarios[0]).toMatchObject({
      page: "dashboard",
      fixtures: { logo: "tests/fixtures/logo.png" },
    });
    expect(compact.scenarios[0].tests[0]).toMatchObject({
      qaLivePolicy: "readonly",
      fixtures: { avatar: "tests/fixtures/avatar.png" },
    });
  });

  it("to withhold the playwright body so the plan describes behaviour, not implementation", () => {
    const compact = buildGwtPromptSpec({
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
          ],
        },
      ],
    });

    expect(compact.scenarios[0].tests[0]).not.toHaveProperty("source");
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

  it("to tell the agent it has no code and must not invent implementation detail", () => {
    const query = buildAbstractHermesQuery({ task: "abstract-qa-spec-gwt" });

    expect(query).toContain("not its code");
    expect(query).toContain("Do not invent selectors");
  });
});
