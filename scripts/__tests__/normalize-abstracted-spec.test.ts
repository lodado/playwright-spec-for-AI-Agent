import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { normalizeAbstractAiResult } from "../normalize-abstracted-spec.mjs";
import {
  ABSTRACT_PROMPT_REV,
  run as runAbstractAi,
} from "../run-hermes-spec-abstractor.mjs";

const baseSpec = {
  abstraction: { rulesVersion: "1.0.0", stage: "rules" },
  scenarios: [
    {
      scenarioId: "ACTIVE",
      tests: [
        {
          checkId: "t1",
          title: "shows score",
          livePolicyAnnotation: "safe-interaction",
        },
      ],
    },
  ],
};

function plan(...lines: string[]) {
  return lines.join("\n");
}

const validPlan = plan(
  "### ACTIVE — shows score",
  "Given: the user is signed in",
  "When: the dashboard finishes loading",
  "Then: a numeric score is displayed",
  "Never: the score area renders an error state or stays empty",
);

describe("normalizeAbstractAiResult", () => {
  it("accepts a plan that covers every test with a Never clause", () => {
    const result = normalizeAbstractAiResult(baseSpec, { livePlan: validPlan });

    expect(result.ok).toBe(true);
    expect(result.livePlan).toBe(validPlan);
    expect(result.spec.scenarios).toEqual(baseSpec.scenarios);
    expect(result.spec.abstraction.stage).toBe("rules+ai-gwt");
    expect(result.audit.coverage).toEqual({
      planned: 1,
      addressed: 1,
      missing: [],
    });
    expect(result.audit.repairs).toEqual([]);
  });

  it("plans the same title once per scenario without calling it a duplicate", () => {
    // Real shape: one page, several account states, the same check in each.
    const sharedTitleSpec = {
      ...baseSpec,
      scenarios: ["ACTIVE", "INACTIVE", "CANCEL_PENDING"].map(scenarioId => ({
        scenarioId,
        tests: [
          {
            checkId: `${scenarioId}-t1`,
            title: "구독 이력 다이얼로그가 열린다",
            livePolicyAnnotation: "safe-interaction",
          },
        ],
      })),
    };
    const sharedPlan = plan(
      ...["ACTIVE", "INACTIVE", "CANCEL_PENDING"].flatMap(scenarioId => [
        `### ${scenarioId} — 구독 이력 다이얼로그가 열린다`,
        `Given: the account is ${scenarioId}`,
        "When: the history control is used",
        "Then: the dialog opens",
        "Never: the dialog stays closed or renders an error",
        "",
      ]),
    );

    const result = normalizeAbstractAiResult(sharedTitleSpec, {
      livePlan: sharedPlan,
    });

    expect(result.ok).toBe(true);
    expect(result.audit.coverage).toEqual({
      planned: 3,
      addressed: 3,
      missing: [],
    });
  });

  it("succeeds with empty livePlan (rule GWT fallback in markdown render)", () => {
    const result = normalizeAbstractAiResult(baseSpec, { livePlan: "  " });

    expect(result.ok).toBe(true);
    expect(result.livePlan).toBeNull();
    expect(result.spec.abstraction.stage).toBe("rules");
  });

  it("to cap a check at manual_review when the plan never mentions what the parser read", () => {
    const withLocator = {
      ...baseSpec,
      scenarios: [
        {
          scenarioId: "ACTIVE",
          tests: [
            {
              checkId: "t1",
              title: "shows score",
              livePolicyAnnotation: "safe-interaction",
              parserIntegrity: "complete",
              expectations: [
                {
                  type: "visible",
                  locator: { kind: "testId", value: "health-score" },
                },
              ],
            },
          ],
        },
      ],
    };

    const result = normalizeAbstractAiResult(withLocator, {
      livePlan: validPlan,
    });

    expect(result.audit.repairs).toEqual([
      {
        kind: "plan-parser-disagreement",
        checkId: "t1",
        title: "shows score",
        detail:
          "the plan never mentions health-score, which this test asserts on; capped at manual_review",
      },
    ]);
    expect(result.livePlan).toContain("health-score");
    expect(result.livePlan).toContain("manual_review");
    // The caution goes inside the existing block: a second heading for the same
    // test would inflate the planned count and report the check twice.
    expect(result.livePlan!.match(/^###\s/gm)).toHaveLength(1);
    expect(result.audit.coverage).toMatchObject({ planned: 1, addressed: 1 });
  });

  it("repairs a plan that misses a planned test", () => {
    const twoTests = {
      ...baseSpec,
      scenarios: [
        {
          scenarioId: "ACTIVE",
          tests: [
            ...baseSpec.scenarios[0].tests,
            {
              checkId: "t2",
              title: "shows renewal date",
              livePolicyAnnotation: "safe-interaction",
            },
          ],
        },
      ],
    };

    const result = normalizeAbstractAiResult(twoTests, { livePlan: validPlan });

    expect(result.audit.coverage).toMatchObject({
      planned: 2,
      addressed: 1,
      missing: ["shows renewal date"],
    });
    expect(result.audit.repairs).toEqual([
      {
        kind: "missing-test",
        checkId: "t2",
        title: "shows renewal date",
        detail: "not covered by the agent plan; appended as manual_review",
      },
    ]);
    expect(result.livePlan).toContain("### ACTIVE — shows renewal date");
    expect(result.livePlan).toContain("manual_review");
    expect(result.livePlan).toContain("Never:");
  });

  it("rejects a plan that invents a test title", () => {
    const invented = plan(
      validPlan,
      "",
      "### ACTIVE — deletes the workspace",
      "Given: the user is signed in",
      "When: they press delete",
      "Then: the workspace is gone",
      "Never: the workspace survives",
    );

    expect(() => normalizeAbstractAiResult(baseSpec, { livePlan: invented }))
      .toThrow(/invented scenario not present in the spec: "ACTIVE — deletes the workspace"/);
  });

  it("rejects a scenario with no Never clause", () => {
    const noNever = plan(
      "### ACTIVE — shows score",
      "Given: the user is signed in",
      "When: the dashboard loads",
      "Then: a numeric score is displayed",
    );

    expect(() => normalizeAbstractAiResult(baseSpec, { livePlan: noNever })).toThrow(
      /has no `Never:` clause/,
    );
  });

  it("rejects an empty Given/When/Then section", () => {
    const emptyWhen = plan(
      "### ACTIVE — shows score",
      "Given: the user is signed in",
      "When:",
      "Then: a numeric score is displayed",
      "Never: the score stays empty",
    );

    expect(() => normalizeAbstractAiResult(baseSpec, { livePlan: emptyWhen })).toThrow(
      /empty when section/,
    );
  });

  it("rejects a readonly test whose plan states no `mutations: 0` expectation", () => {
    const readonlySpec = {
      ...baseSpec,
      scenarios: [
        {
          scenarioId: "ACTIVE",
          tests: [
            { checkId: "t1", title: "shows score", livePolicyAnnotation: "readonly" },
          ],
        },
      ],
    };

    expect(() =>
      normalizeAbstractAiResult(readonlySpec, { livePlan: validPlan }),
    ).toThrow(/states no `mutations: 0` expectation/);

    const withMutations = plan(
      validPlan,
      "And: mutations: 0 — nothing is written",
    );
    expect(
      normalizeAbstractAiResult(readonlySpec, { livePlan: withMutations }).ok,
    ).toBe(true);
  });

  it("tolerates bullet and bold markdown around section keywords", () => {
    const formatted = plan(
      "### ACTIVE — shows score",
      "**Given:**",
      "- the user is signed in",
      "**When:**",
      "- the dashboard loads",
      "**Then:**",
      "- a numeric score is displayed",
      "**Never:**",
      "- the score area shows an error state",
    );

    expect(normalizeAbstractAiResult(baseSpec, { livePlan: formatted }).ok).toBe(true);
  });

  it("prefers the adapter-reported model over the legacy env var", () => {
    const result = normalizeAbstractAiResult(baseSpec, {
      livePlan: validPlan,
      agentMeta: { adapter: "exec", model: "acme-1", durationMs: 12 },
    });

    expect(result.spec.abstraction.aiModel).toBe("acme-1");
  });
});

describe("abstract-ai stage", () => {
  let root = "";
  let outputDir = "";
  let fixtureDir = "";

  const argv = () => [
    "--page=dashboard",
    `--project-root=${root}`,
    "--output-dir=out/{page}",
  ];

  const inputSpec = {
    schemaVersion: 1,
    artifactKind: "qa-spec",
    sourceHash: "sha256:spec-sources",
    parserVersion: "1.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    excluded: [],
    unparsedTestCount: 0,
    abstraction: { rulesVersion: "1.0.0", stage: "rules" },
    scenarios: [
      {
        scenarioId: "ACTIVE",
        sourceFile: "dashboard.spec.ts",
        label: "Dashboard",
        tests: [
          {
            checkId: "shows-score",
            title: "shows score",
            stagingMode: "read-only",
            liveRunPolicy: "executable-readonly",
            livePolicyAnnotation: "readonly",
            expectations: [],
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    resetProjectConfigForTests();
    root = mkdtempSync(join(tmpdir(), "qa-abstract-"));
    outputDir = join(root, "out", "dashboard");
    fixtureDir = join(root, "fixtures");
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(fixtureDir, { recursive: true });

    writeFileSync(
      join(outputDir, "dashboard-qa-spec-abstracted.json"),
      JSON.stringify(inputSpec, null, 2),
    );
    writeFileSync(
      join(fixtureDir, "abstract.json"),
      JSON.stringify({
        livePlan: plan(
          "### ACTIVE — shows score",
          "Given: the user is signed in on staging",
          "When: the dashboard finishes loading",
          "Then: a numeric score is displayed",
          "Never: the score area renders an error; mutations: 0",
        ),
      }),
    );

    process.env.QA_AI_ADAPTER = "fixture";
    process.env.QA_FIXTURE_DIR = fixtureDir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.QA_AI_ADAPTER;
    delete process.env.QA_FIXTURE_DIR;
    resetProjectConfigForTests();
    rmSync(root, { recursive: true, force: true });
  });

  const read = (file: string) =>
    JSON.parse(readFileSync(join(outputDir, file), "utf8"));

  const rawOutputPath = () =>
    join(outputDir, "dashboard-hermes-abstract-raw-output.txt");

  it("stamps the input hash and prompt revision, then reuses them", async () => {
    await runAbstractAi(argv());

    const live = read("dashboard-qa-spec-live.json");
    expect(live.sourceHash).toMatch(/^sha256:/);
    expect(live.promptRev).toBe(ABSTRACT_PROMPT_REV);
    expect(read("dashboard-qa-abstract-audit.json")).toMatchObject({
      reused: false,
      adapter: "fixture",
      promptRev: ABSTRACT_PROMPT_REV,
      coverage: { planned: 1, addressed: 1 },
    });

    const markdown = readFileSync(
      join(outputDir, "dashboard-qa-spec-live.md"),
      "utf8",
    );
    expect(markdown.startsWith("---\n")).toBe(true);
    expect(markdown).toContain(`sourceHash: ${live.sourceHash}`);
    expect(markdown).toContain(`promptRev: ${ABSTRACT_PROMPT_REV}`);
    expect(markdown).toContain("Never:");

    // Second run: same input, so the agent must not be called again.
    rmSync(rawOutputPath());
    resetProjectConfigForTests();
    await runAbstractAi(argv());

    expect(existsSync(rawOutputPath())).toBe(false);
    expect(read("dashboard-qa-abstract-audit.json")).toMatchObject({
      reused: true,
      coverage: { planned: 1, addressed: 1 },
    });
  });

  it("--force regenerates even when the input is unchanged", async () => {
    await runAbstractAi(argv());
    rmSync(rawOutputPath());
    resetProjectConfigForTests();

    await runAbstractAi([...argv(), "--force"]);

    expect(existsSync(rawOutputPath())).toBe(true);
    expect(read("dashboard-qa-abstract-audit.json").reused).toBe(false);
  });

  it("re-runs the agent when the input spec changed", async () => {
    await runAbstractAi(argv());
    rmSync(rawOutputPath());

    writeFileSync(
      join(outputDir, "dashboard-qa-spec-abstracted.json"),
      JSON.stringify(
        {
          ...inputSpec,
          scenarios: [
            {
              ...inputSpec.scenarios[0],
              tests: [
                { ...inputSpec.scenarios[0].tests[0], title: "shows score" },
                {
                  checkId: "shows-plan",
                  title: "shows plan",
                  stagingMode: "read-only",
                  liveRunPolicy: "executable-readonly",
                  livePolicyAnnotation: "safe-interaction",
                  expectations: [],
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
    resetProjectConfigForTests();

    await runAbstractAi(argv());

    expect(existsSync(rawOutputPath())).toBe(true);
    const audit = read("dashboard-qa-abstract-audit.json");
    expect(audit.reused).toBe(false);
    expect(audit.coverage).toMatchObject({
      planned: 2,
      addressed: 1,
      missing: ["shows plan"],
    });
  });
});
