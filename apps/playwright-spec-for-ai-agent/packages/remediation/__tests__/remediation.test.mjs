import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_BUNDLE_VERSION,
  JUDGE_RESULT_VERSION,
  QA_IR_VERSION,
  canonicalHash,
  validateContract,
} from "../../contracts/index.mjs";
import { createLocalRepositorySnapshot, locateCode } from "../../repository-provider/index.mjs";
import { renderRemediationReport } from "../../reporter-markdown/index.mjs";
import { diagnoseFailure, recommendRepair } from "../index.mjs";

const policy = {
  navigation: "ALLOWED",
  readDom: true,
  readNetwork: false,
  click: "NONE",
  type: "NONE",
  upload: false,
  submit: false,
  destructiveMutation: false,
  confirmation: "DENY",
  secrets: "RUNTIME_INJECTED",
};

function qaIr() {
  return {
    schemaVersion: QA_IR_VERSION,
    id: "qa-ir-dashboard",
    source: { adapter: "test", adapterVersion: "0.1.0", uri: "qa/dashboard.yaml" },
    suites: [{
      id: "suite-dashboard",
      title: "Dashboard",
      tags: [],
      provenance: [],
      scenarios: [{
        id: "scenario-dashboard",
        title: "Dashboard loads",
        preconditions: [],
        steps: [{ id: "navigate", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } }],
        expectations: [{
          id: "expect-heading",
          kind: "VISIBLE_TEXT",
          target: { testId: "health-score" },
          text: "ghp_abcdefghijklmnopqrstuvwxyz",
          expected: { kind: "literal", value: "Dashboard" },
        }],
        policy,
        provenance: [],
      }],
    }],
  };
}

function evidenceBundle(facts = [{ id: "fact-url", kind: "URL", value: "https://example.test/dashboard" }]) {
  return {
    schemaVersion: EVIDENCE_BUNDLE_VERSION,
    bundleId: "bundle-dashboard",
    runId: "run-dashboard",
    scenarioId: "scenario-dashboard",
    checkpointId: "loaded",
    capturedAt: "2026-07-25T00:00:00.000Z",
    environment: {
      targetUrl: "https://example.test/dashboard",
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
    },
    artifacts: [{
      id: "artifact-visible-text",
      type: "VISIBLE_TEXT",
      contentType: "text/plain",
      contentHash: "sha256:visible-text",
      size: 9,
      storageRef: "sha256:visible-text",
    }],
    facts,
    redaction: { rules: ["secret-redaction/0.1"], replacements: 0 },
  };
}

function judgeResult(evidenceRefs = ["artifact-visible-text"]) {
  return {
    schemaVersion: JUDGE_RESULT_VERSION,
    resultId: "judge-dashboard",
    qaIrId: "qa-ir-dashboard",
    evidenceBundleId: "bundle-dashboard",
    verdict: "FAIL",
    confidence: 0.9,
    expectationResults: [{
      expectationId: "expect-heading",
      status: "CONTRADICTED",
      confidence: 0.8,
      evidenceRefs,
      rationale: "The expected dashboard heading was absent.",
    }],
    uncertainty: [],
    judge: { provider: "hermes", model: "judge-model", promptVersion: "judge-prompt/0.1" },
    inputHash: canonicalHash({ qaIrId: "qa-ir-dashboard", evidenceBundleId: "bundle-dashboard" }),
  };
}

describe("repository-aware remediation vertical slice", () => {
  it("classifies a judge-flagged context or auth mismatch as ENVIRONMENT", () => {
    const judgment = judgeResult();
    judgment.uncertainty = [{ code: "CONTEXT_MISMATCH", description: "Live plan state does not match the mocked INACTIVE state." }];
    const diagnosis = diagnoseFailure({ qaIr: qaIr(), judgeResult: judgment, evidenceBundle: evidenceBundle() });
    expect(diagnosis.origin).toBe("ENVIRONMENT");
    expect(diagnosis.remediationEligible).toBe(false);
  });

  it("ranks the executed spec file first among pure route matches", () => {
    const repository = fixtureRepository({ "tests/dashboard.spec.ts": "test(\"dashboard\", () => visit(\"/dashboard\"));\n", "src/routes.js": "export const dashboardRoute = \"/dashboard\";\n" });
    const qa = qaIr();
    qa.source.uri = "tests/dashboard.spec.ts";
    const evidence = evidenceBundle();
    const judgment = judgeResult();
    const diagnosis = diagnoseFailure({ qaIr: qa, judgeResult: judgment, evidenceBundle: evidence });
    const codeContext = locateCode({ snapshot: createLocalRepositorySnapshot({ root: repository }), diagnosis, judgeResult: judgment, qaIr: qa, evidenceBundle: evidence });

    const paths = codeContext.candidates.map((candidate) => candidate.path);
    expect(paths).toContain("tests/dashboard.spec.ts");
    expect(paths.indexOf("tests/dashboard.spec.ts")).toBeLessThan(paths.indexOf("src/routes.js"));
  });

  it("produces evidence-backed locations, suggestion-only guidance, and Markdown", () => {
    const repository = fixtureRepository();
    const qa = qaIr();
    const evidence = evidenceBundle();
    const judgment = judgeResult();
    const secrets = ["REPORT-SECRET"];
    judgment.expectationResults[0].rationale = "<script>alert(1)</script> Authorization = Basic REPORT-SECRET ghp_abcdefghijklmnopqrstuvwxyz";
    const diagnosis = diagnoseFailure({ qaIr: qa, judgeResult: judgment, evidenceBundle: evidence, secrets });
    expect(validateContract("FailureDiagnosis", diagnosis, { judgeResult: judgment, evidenceBundle: evidence })).toMatchObject({
      origin: "PRODUCT_CODE",
      remediationEligible: true,
    });

    const codeContext = locateCode({
      snapshot: createLocalRepositorySnapshot({ root: repository }),
      diagnosis,
      judgeResult: judgment,
      qaIr: qa,
      evidenceBundle: evidence,
      secrets,
    });
    expect(codeContext.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(codeContext.candidates[0]).toMatchObject({
      path: "src/Dashboard.jsx",
      matchReasons: expect.arrayContaining(["TEST_ID_MATCH", "VISIBLE_TEXT_MATCH", "ROUTE_MATCH"]),
    });
    expect(codeContext.snippets[0]).toMatchObject({ path: "src/Dashboard.jsx", contentHash: expect.stringMatching(/^sha256:/) });
    expect(JSON.stringify(codeContext)).not.toContain("LOCATOR-SECRET");
    expect(JSON.stringify(codeContext)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(codeContext.searchAudit.queries).toEqual(expect.arrayContaining([
      { term: "Dashboard", reason: "VISIBLE_TEXT_MATCH" },
      { term: "health-score", reason: "TEST_ID_MATCH" },
      { term: "/dashboard", reason: "ROUTE_MATCH" },
    ]));
    expect(codeContext.candidates.some((item) => item.path.includes("secrets"))).toBe(false);

    const recommendation = recommendRepair({ diagnosis, codeContext, qaIr: qa, judgeResult: judgment, evidenceBundle: evidence, secrets });
    expect(recommendation).toMatchObject({
      patchEligibility: "SUGGESTION_ONLY",
      locations: [{ path: "src/Dashboard.jsx", reason: expect.stringContaining("TEST_ID_MATCH"), range: expect.any(Object) }],
    });
    const report = renderRemediationReport({
      diagnosis,
      codeContext,
      recommendation,
      qaIr: qa,
      judgeResult: judgment,
      evidenceBundle: evidence,
      secrets,
    });
    expect(report).toContain("src/Dashboard.jsx");
    expect(report).toContain("artifact-visible-text");
    expect(report).toContain("npm test");
    expect(report).not.toContain("REPORT-SECRET");
    expect(report).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(report).not.toContain("<script>");
    expect(report).not.toContain("return <main");
  });

  it("keeps explicit environment failures in manual review", () => {
    const qa = qaIr();
    const evidence = evidenceBundle([{ id: "fact-env", kind: "ENVIRONMENT_ERROR", value: { message: "staging unavailable" } }]);
    const judgment = judgeResult(["fact-env"]);
    const diagnosis = diagnoseFailure({ qaIr: qa, judgeResult: judgment, evidenceBundle: evidence });
    expect(diagnosis).toMatchObject({ origin: "ENVIRONMENT", remediationEligible: false });
    expect(diagnosis.manualReviewReasons).not.toHaveLength(0);
    const forged = { ...diagnosis, origin: "PRODUCT_CODE", remediationEligible: true, manualReviewReasons: [] };
    const codeContext = locateCode({
      snapshot: createLocalRepositorySnapshot({ root: fixtureRepository() }),
      diagnosis,
      judgeResult: judgment,
      qaIr: qa,
      evidenceBundle: evidence,
    });
    expect(() => recommendRepair({
      diagnosis: forged,
      codeContext,
      qaIr: qa,
      judgeResult: judgment,
      evidenceBundle: evidence,
    })).toThrow(/does not match Judge evidence/);
  });

  it("classifies contradictions in a semantic-judgment scenario as TEST_DATA origin", () => {
    const qa = { ...qaIr(), extensions: { semanticJudgmentScenarioIds: ["scenario-dashboard"] } };
    const evidence = evidenceBundle();
    const judgment = judgeResult();
    const diagnosis = diagnoseFailure({ qaIr: qa, judgeResult: judgment, evidenceBundle: evidence });
    expect(diagnosis).toMatchObject({ origin: "TEST_DATA", remediationEligible: true });
    expect(diagnosis.likelyCause).toContain("mock data");
  });

  it("keeps the same contradiction outside a semantic-judgment scenario as PRODUCT_CODE", () => {
    const qa = { ...qaIr(), extensions: { semanticJudgmentScenarioIds: ["other-scenario"] } };
    const evidence = evidenceBundle();
    const judgment = judgeResult();
    const diagnosis = diagnoseFailure({ qaIr: qa, judgeResult: judgment, evidenceBundle: evidence });
    expect(diagnosis).toMatchObject({ origin: "PRODUCT_CODE" });
  });

  it("rejects runtime errors and invented evidence instead of diagnosing them as product failures", () => {
    expect(() => diagnoseFailure({
      qaIr: qaIr(),
      evidenceBundle: evidenceBundle(),
      judgeResult: { schemaVersion: "runtime-outcome/0.1", stage: "judge", type: "ERROR", code: "MODEL_PROVIDER_FAILED", message: "offline" },
    })).toThrow(/JudgeResult/);
    expect(() => diagnoseFailure({ qaIr: qaIr(), evidenceBundle: evidenceBundle(), judgeResult: judgeResult(["invented"]) })).toThrow(/unknown evidence ref/);
    expect(() => recommendRepair({ diagnosis: {}, codeContext: {} })).toThrow(/QaIrDocument/);
  });
});

function fixtureRepository(extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "qa-native-remediation-"));
  mkdirSync(join(root, "src", "secrets"), { recursive: true });
  for (const [path, content] of Object.entries(extraFiles)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  writeFileSync(join(root, "src", "Dashboard.jsx"), [
    "export function Dashboard() {",
    "  const apiKey = 'LOCATOR-SECRET';",
    "  const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz';",
    "  const route = '/dashboard';",
    "  return <main data-testid=\"health-score\">Dashboard</main>;",
    "}",
  ].join("\n"));
  writeFileSync(join(root, "src", "secrets", "token.ts"), "export const hidden = 'health-score Dashboard /dashboard';\n");
  writeFileSync(join(root, ".env"), "TOKEN=REPORT-SECRET\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "qa@example.test"]);
  git(root, ["config", "user.name", "QA Runtime"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
