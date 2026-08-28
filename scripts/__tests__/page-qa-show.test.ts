import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProjectConfig,
  resetProjectConfigForTests,
} from "../hermes-qa-project-config.mjs";
import { buildShowReport, renderShowReport } from "../page-qa-show.mjs";

let root = "";
let qaDir = "";

const JUDGMENT = {
  schemaVersion: 1,
  artifactKind: "judgment",
  runId: "run-1234abcd",
  page: "demo",
  judgedAt: "2026-08-28T02:00:00.000Z",
  targetUrl: "https://staging.acme.test/dashboard",
  planSource: "spec-live.md",
  specHash: "sha256:deadbeef",
  status: "fail",
  cause: "PRODUCT_DEFECT",
  summary: "The health score widget never rendered.",
  recommendedAction: "Roll back the widget deploy.",
  agentMeta: { adapter: "hermes", model: "opus", durationMs: 42_000 },
  checks: [
    {
      item: "shows the plan name",
      result: "pass",
      detail: "Growth is visible in the header",
      confidence: "high",
      cause: "NONE",
      evidenceRefs: [],
    },
    {
      item: "shows an account health score",
      result: "fail",
      detail: "the score area stayed empty after the page settled",
      confidence: "high",
      cause: "PRODUCT_DEFECT",
      evidenceRefs: ["evidence/health.png"],
    },
  ],
  coverage: { planned: 3, addressed: 2, missing: ["opens the plan details panel"] },
  evidence: ["screenshot: health.png"],
  runnerEvidence: {
    tracePath: "/nowhere/trace.zip",
    harPath: null,
    videoPath: null,
    screenshots: [],
    ariaSnapshots: [],
    violations: [],
  },
};

async function useProject() {
  const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
  writeFileSync(
    configPath,
    `export default ${JSON.stringify(
      {
        root,
        paths: { specDir: join(root, "specs"), outputDir: qaDir },
        pages: { demo: { baseUrl: "https://staging.acme.test", targetPath: "/dashboard" } },
      },
      null,
      2
    )};\n`
  );
  await loadProjectConfig([`--config=${configPath}`, `--project-root=${root}`]);
}

function writeArtifact(name: string, body: unknown) {
  writeFileSync(join(qaDir, name), `${JSON.stringify(body, null, 2)}\n`);
}

beforeEach(async () => {
  resetProjectConfigForTests();
  root = mkdtempSync(join(tmpdir(), "qa-show-"));
  qaDir = join(root, "__QA__");
  mkdirSync(qaDir, { recursive: true });
  await useProject();
});

afterEach(() => {
  resetProjectConfigForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("buildShowReport", () => {
  it("reads verdict, identity, checks, coverage, and review", () => {
    writeArtifact("demo-hermes-judgment.json", JUDGMENT);
    writeArtifact("demo-hermes-judge-review.json", {
      overallReview: "flagged",
      summary: "Evidence is thin for the failing check.",
      criteria: [
        { id: "sufficient-evidence", verdict: "concern", detail: "one screenshot only" },
      ],
    });

    const report = buildShowReport("demo");

    expect(report.judgment?.status).toBe("fail");
    expect(report.judgment?.cause).toBe("PRODUCT_DEFECT");
    expect(report.checks).toHaveLength(2);
    expect(report.coverage?.missing).toEqual(["opens the plan details panel"]);
    expect(report.review?.overallReview).toBe("flagged");
    expect(report.runnerEvidence).toEqual([
      { kind: "tracePath", path: "/nowhere/trace.zip", exists: false },
    ]);
  });

  it("reports a page with no artifacts as not run instead of throwing", () => {
    const report = buildShowReport("demo");

    expect(report.judgment).toBeNull();
    expect(report.review).toBeNull();
    expect(report.checks).toEqual([]);
    expect(() => renderShowReport(report)).not.toThrow();
    expect(renderShowReport(report)).toContain("Verdict: not run");
    expect(renderShowReport(report)).toContain("Review:\n  not run.");
  });

  it("survives an unparseable judgment and an older artifact without the new fields", () => {
    writeFileSync(join(qaDir, "demo-hermes-judgment.json"), "{ not json");
    expect(buildShowReport("demo").judgment).toBeNull();

    writeArtifact("demo-hermes-judgment.json", {
      status: "pass",
      summary: "All good.",
      checks: [{ item: "legacy check", result: "pass", detail: "fine" }],
    });
    const report = buildShowReport("demo");

    expect(report.judgment?.status).toBe("pass");
    expect(report.coverage).toBeNull();
    expect(report.spec.state).toBe("unrecorded");
    expect(renderShowReport(report)).toContain("not recorded by this judgment");
  });

  it("flags a judgment whose spec hash no longer matches the spec on disk", () => {
    writeArtifact("demo-hermes-judgment.json", JUDGMENT);
    writeArtifact("demo-qa-spec.json", { scenarios: [{ scenarioId: "ACTIVE", tests: [] }] });

    const report = buildShowReport("demo");

    expect(report.spec.state).toBe("stale");
    expect(renderShowReport(report)).toContain("STALE");
  });
});

describe("renderShowReport", () => {
  it("prints the verdict, the failing check, and the missing coverage", () => {
    writeArtifact("demo-hermes-judgment.json", JUDGMENT);
    const text = renderShowReport(buildShowReport("demo"));

    expect(text).toContain("Verdict: FAIL (PRODUCT_DEFECT)");
    expect(text).toContain("The health score widget never rendered.");
    expect(text).toContain("run-1234abcd");
    expect(text).toContain("hermes (opus), 42s");
    expect(text).toContain("shows an account health score");
    expect(text).toContain("2/3 planned checks addressed.");
    expect(text).toContain("- opens the plan details panel");
    expect(text).toContain("MISSING tracePath");
  });

  it("shows a quarantine banner with its reason when the run is marked invalid", () => {
    writeArtifact("demo-hermes-judgment.json", JUDGMENT);
    writeArtifact("demo-qa-run.invalid", {
      reason: "hermes exited 1 before writing a verdict",
      at: "2026-08-28T02:03:04.000Z",
    });

    const text = renderShowReport(buildShowReport("demo"));

    expect(text).toContain("QUARANTINED");
    expect(text).toContain("hermes exited 1 before writing a verdict");
    expect(text).toContain("2026-08-28T02:03:04.000Z");
  });

  it("--failed keeps only the non-pass checks", () => {
    writeArtifact("demo-hermes-judgment.json", JUDGMENT);
    const text = renderShowReport(buildShowReport("demo"), {
      checksOnly: true,
      failed: true,
    });

    expect(text).toContain("shows an account health score");
    expect(text).not.toContain("shows the plan name");
  });

  it("--evidence prints only paths, with an existence marker", () => {
    writeArtifact("demo-hermes-judgment.json", JUDGMENT);
    const text = renderShowReport(buildShowReport("demo"), { evidence: true });

    expect(text).toContain("hermesJudgmentJson");
    expect(text).toContain("MISSING tracePath");
    expect(text).not.toContain("Verdict:");
  });
});
