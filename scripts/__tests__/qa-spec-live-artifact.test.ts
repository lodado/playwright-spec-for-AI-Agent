import { beforeEach, describe, expect, it, vi } from "vitest";

const artifacts = vi.hoisted(() => ({
  buildUploadFixturesPayload: vi.fn(),
}));
vi.mock("../qa-spec-artifacts.mjs", () => artifacts);

import { renderLiveSpecMarkdown } from "../qa-spec-live-artifact.mjs";

const SPEC = {
  sourceHash: "sha256:src",
  promptRev: "rev-7",
  abstraction: { rulesVersion: "rules-2", aiAppliedAt: "2026-02-03T04:05:06Z" },
  scenarios: [
    {
      scenarioId: "list",
      label: "List page",
      sourceFile: "list.spec.ts",
      alwaysRun: true,
      tests: [
        {
          title: "shows rows",
          checkId: "shows-rows",
          stagingMode: "read-only",
          liveRunPolicy: "executable-readonly",
        },
      ],
    },
  ],
};

beforeEach(() => {
  artifacts.buildUploadFixturesPayload.mockReset();
  artifacts.buildUploadFixturesPayload.mockReturnValue({
    projectRoot: "/p",
    defaults: {},
    byCheckId: {},
  });
});

describe("renderLiveSpecMarkdown as a spec with every stamp present", () => {
  it("to be front matter carrying page and the four stamps, then the page heading", () => {
    const doc = renderLiveSpecMarkdown({ spec: SPEC, page: "admin/users" });

    expect(
      doc.startsWith(
        [
          "---",
          "page: admin/users",
          "sourceHash: sha256:src",
          "promptRev: rev-7",
          "rulesVersion: rules-2",
          "generatedAt: 2026-02-03T04:05:06Z",
          "---",
          "",
          "# Admin Users QA spec (Live)",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("to be a document that ends with exactly one newline", () => {
    const doc = renderLiveSpecMarkdown({ spec: SPEC, page: "dashboard" });

    expect(doc.endsWith("\n")).toBe(true);
    expect(doc.endsWith("\n\n")).toBe(false);
  });
});

describe("renderLiveSpecMarkdown as a spec with missing stamps", () => {
  it("to be front matter that omits absent fields", () => {
    const doc = renderLiveSpecMarkdown({
      spec: { scenarios: [] },
      page: "dashboard",
    });

    expect(doc.split("\n").slice(0, 3)).toEqual([
      "---",
      "page: dashboard",
      "---",
    ]);
  });
});

describe("renderLiveSpecMarkdown as an agent plan versus the rule-based fallback", () => {
  it("to be the trimmed agent plan with no fallback warning", () => {
    const doc = renderLiveSpecMarkdown({
      spec: SPEC,
      page: "dashboard",
      gwtBody: "\n## Agent plan\n- Never: x\n\n",
    });

    expect(doc).toContain("# Dashboard QA spec (Live)\n\n## Agent plan\n- Never: x\n");
    expect(doc).not.toContain("Rule-based fallback plan");
  });

  it.each([[null], [undefined], [""], ["  \n\t "]])(
    "to be the fallback warning followed by the rule-based plan for gwtBody %j",
    gwtBody => {
      const doc = renderLiveSpecMarkdown({ spec: SPEC, page: "dashboard", gwtBody });

      expect(doc).toContain(
        "> Rule-based fallback plan: the abstraction agent produced no livePlan",
      );
      expect(doc).toContain("## List page");
      expect(doc).toContain("id:`list` file:`list.spec.ts` always-run");
    },
  );
});

describe("renderLiveSpecMarkdown as a spec with upload fixtures and an audit", () => {
  it("to be an Uploads appendix, then the audit appendix, when both exist", () => {
    artifacts.buildUploadFixturesPayload.mockReturnValue({
      projectRoot: "/p",
      defaults: { sample: "/p/fixtures/sample.pdf" },
      byCheckId: {},
    });

    const doc = renderLiveSpecMarkdown({
      spec: SPEC,
      page: "dashboard",
      gwtBody: "plan",
      audit: {
        changes: [
          { checkId: "shows-rows", field: "then", reason: "tightened", confidence: "high" },
        ],
      },
    });

    expect(artifacts.buildUploadFixturesPayload).toHaveBeenCalledWith(SPEC, "dashboard");
    expect(doc).toContain("## Uploads\n\n- sample: `/p/fixtures/sample.pdf`");
    expect(doc.indexOf("plan")).toBeLessThan(doc.indexOf("## Uploads"));
    expect(doc.indexOf("## Uploads")).toBeLessThan(
      doc.indexOf("## abstract-ai changes"),
    );
    expect(doc).toContain("- `shows-rows` then: tightened (high)");
  });

  it("to be no audit appendix and no Uploads when there are none", () => {
    const doc = renderLiveSpecMarkdown({
      spec: SPEC,
      page: "dashboard",
      gwtBody: "plan",
      audit: { changes: [] },
    });

    expect(doc).not.toContain("## Uploads");
    expect(doc).not.toContain("abstract-ai changes");
  });
});
