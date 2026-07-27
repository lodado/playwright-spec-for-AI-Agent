import { describe, expect, it } from "vitest";
import {
  buildJudgeBrowseDocument,
  collectUniqueUploadFixtures,
  renderFriendlyQaSpecMarkdown,
  renderJudgeHermesDocument,
} from "../qa-spec-judge-document.mjs";
import { buildBrowseHermesQuery } from "../run-hermes-page-judge.mjs";

const sampleSpec = {
  generatedAt: "2026-06-01T00:00:00.000Z",
  scenarios: [
    {
      scenarioId: "ACTIVE",
      label: "Dashboard — ACTIVE",
      sourceFile: "dashboard-active.spec.ts",
      alwaysRun: false,
      tests: [
        {
          title: "shows health score",
          checkId: "shows-health-score",
          liveRunPolicy: "judgment-mock-api",
          expectations: [
            {
              type: "containText",
              locator: { kind: "testId", value: "health-score" },
              expected: {
                kind: "semantic",
                intent: "A numeric health score with unit is displayed",
                constraints: [{ type: "numeric", role: "score" }],
              },
              provenance: { originalLiteral: "98점" },
            },
          ],
        },
      ],
    },
  ],
};

describe("renderJudgeHermesDocument", () => {
  it("uses compact GWT without JSON blobs or lecture text", () => {
    const doc = renderJudgeHermesDocument({
      page: "dashboard",
      spec: sampleSpec,
      stagingLogin: {
        loginUrl: "https://staging.example/login",
        email: "qa@example.com",
        targetUrl: "https://staging.example/dashboard",
      },
      alwaysRunScenarioIds: [],
      specSourceFiles: {},
    });

    expect(doc).toContain("shows health score");
    expect(doc).toContain("**Given:**");
    expect(doc).toContain("**When:**");
    expect(doc).toContain("**Then:**");
    expect(doc).toContain('[data-testid="health-score"]');
    expect(doc).toContain("numeric health score");
    expect(doc).toContain('mock:"98점"');
    expect(doc).not.toContain('"specDefinition"');
    expect(doc).not.toContain("non-deterministic");
    expect(doc).not.toContain("How to use this plan");
  });

  it("renders parsed actions and non-legacy matchers into When/Then", () => {
    const spec = {
      scenarios: [{
        scenarioId: "PRICING",
        label: "Pricing",
        sourceFile: "pricing.spec.ts",
        tests: [{
          title: "edits a plan",
          liveRunPolicy: "executable-interaction",
          actions: [{
            type: "fill",
            target: { kind: "label", value: "Plan name" },
            arguments: [{ kind: "literal", value: "Enterprise" }],
          }],
          expectations: [{
            type: "count",
            locator: { kind: "locator", value: ".feature" },
            expected: { kind: "literal", value: 3 },
          }],
        }],
      }],
    };

    const doc = renderJudgeHermesDocument({ page: "pricing", spec, includeSession: false });

    expect(doc).toContain('fill label:"Plan name" with "Enterprise"');
    expect(doc).toContain('locator:".feature" count: 3');
  });
});

describe("buildBrowseHermesQuery", () => {
  it("embeds markdown test plan and omits JSON payload", () => {
    const doc = renderJudgeHermesDocument({
      page: "dashboard",
      spec: sampleSpec,
      stagingLogin: {
        loginUrl: "https://staging.example/login",
        email: "qa@example.com",
        targetUrl: "https://staging.example/dashboard",
      },
      alwaysRunScenarioIds: [],
      specSourceFiles: {},
    });

    const query = buildBrowseHermesQuery({
      judgeDocument: doc,
      stagingLogin: {
        loginUrl: "https://staging.example/login",
        email: "qa@example.com",
        password: "secret",
        targetUrl: "https://staging.example/dashboard",
      },
    });

    expect(query).toContain("shows health score");
    expect(query).not.toContain('"scenarios"');
    expect(query).not.toContain("specDefinition");
    expect(query).toContain("Password: secret");
  });
});

describe("renderFriendlyQaSpecMarkdown", () => {
  it("omits login section for saved spec files", () => {
    const md = renderFriendlyQaSpecMarkdown(sampleSpec, "dashboard");
    expect(md).toContain("Dashboard QA spec");
    expect(md).not.toContain("login:");
    expect(md).not.toContain("non-deterministic");
  });

  it("includes Playwright sources when provided", () => {
    const md = renderFriendlyQaSpecMarkdown(sampleSpec, "dashboard", {
      specSourceFiles: {
        "dashboard-active.spec.ts": 'test("x", async () => {});',
      },
    });
    expect(md).toContain("## Playwright");
    expect(md).toContain("dashboard-active.spec.ts");
  });
});

describe("buildJudgeBrowseDocument", () => {
  it("prepends compact session header to spec-live markdown", () => {
    const liveBody = renderFriendlyQaSpecMarkdown(sampleSpec, "dashboard");
    const { document, planSource } = buildJudgeBrowseDocument({
      page: "dashboard",
      spec: sampleSpec,
      specLiveMarkdown: liveBody,
      planSource: "spec-live.md",
      stagingLogin: {
        loginUrl: "https://staging.example/login",
        email: "qa@example.com",
        targetUrl: "https://staging.example/dashboard",
      },
      alwaysRunScenarioIds: [],
    });

    expect(planSource).toBe("spec-live.md");
    expect(document).toContain("login:");
    expect(document).toContain("shows health score");
  });
});

describe("collectUniqueUploadFixtures", () => {
  it("dedupes by absolute path across defaults and byCheckId", () => {
    const sharedPath = "/repo/fixtures/upload.pdf";
    const otherPath = "/repo/fixtures/invoice.pdf";

    const unique = collectUniqueUploadFixtures({
      defaults: { workspace_pdf: sharedPath },
      byCheckId: {
        "to-be-3": { workspace_pdf: sharedPath },
        "to-be-post-tasks": { pdf: otherPath },
        "to-be-20": { pdf: otherPath },
      },
    });

    expect(unique).toEqual([
      { name: "workspace_pdf", absPath: sharedPath },
      { name: "pdf", absPath: otherPath },
    ]);
  });
});

describe("renderJudgeHermesDocument uploads", () => {
  it("renders unique fixture paths only once in Uploads section", () => {
    const sharedPath = "/repo/fixtures/upload.pdf";

    const doc = renderJudgeHermesDocument({
      page: "workspace",
      spec: sampleSpec,
      includeSession: false,
      alwaysRunScenarioIds: [],
      specSourceFiles: {},
      uploadFixtures: {
        defaults: {},
        byCheckId: {
          "to-be-a": { workspace_pdf: sharedPath },
          "to-be-b": { workspace_pdf: sharedPath },
        },
      },
    });

    expect(doc).toContain("## Uploads");
    expect(doc).toContain("- workspace_pdf: `/repo/fixtures/upload.pdf`");
    expect(doc.match(/upload\.pdf/g)).toHaveLength(1);
    expect(doc).not.toContain("to-be-a/");
  });
});

describe("Given-When-Then for blocked policies", () => {
  it("marks When as skip and Then as skip", () => {
    const spec = {
      scenarios: [
        {
          scenarioId: "ACTIVE",
          label: "Active",
          sourceFile: "x.spec.ts",
          tests: [
            {
              title: "cancels subscription",
              liveRunPolicy: "blocked-subscription-mutation",
              expectations: [],
            },
          ],
        },
      ],
    };

    const doc = renderJudgeHermesDocument({
      page: "dashboard",
      spec,
      includeSession: false,
      alwaysRunScenarioIds: [],
      specSourceFiles: {},
    });

    expect(doc).toContain("Skip on live");
    expect(doc).toContain("- skip");
  });
});
