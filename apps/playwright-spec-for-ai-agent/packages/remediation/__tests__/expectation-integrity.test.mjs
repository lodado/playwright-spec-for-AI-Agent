import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EVIDENCE_COMPARISON_VERSION, PATCH_PROPOSAL_VERSION, QA_IR_VERSION, VERIFICATION_RESULT_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { applyPatchProposal, checkExpectationIntegrity } from "../index.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("expectation integrity and weakening detection", () => {
  it.each([
    ["skip/only", "expect(value).toBe(1);\n", "test.skip('bypass', () => {});\nexpect(value).toBe(1);\n", undefined, "SKIP_OR_ONLY"],
    ["assertion removal", "expect(value).toBe(1);\n", "// assertion removed\n", undefined, "ASSERTION_REMOVAL"],
    ["timeout inflation", "test.setTimeout(1000);\n", "test.setTimeout(5000);\n", undefined, "TIMEOUT_RETRY_INFLATION"],
    ["conditional bypass", "expect(value).toBe(1);\n", "if (ready) expect(value).toBe(1);\n", undefined, "CONDITIONAL_BYPASS"],
    ["swallowed error", "expect(value).toBe(1);\n", "try { expect(value).toBe(1); } catch {}\n", undefined, "SWALLOWED_ERROR"],
    ["forced result", "return result;\n", "return 'PASS';\n", undefined, "FORCED_RESULT"],
    ["confidence lowering", "minimumConfidence: 0.7,\n", "minimumConfidence: 0.5,\n", undefined, "GATE_LOWERING"],
    ["verification disabled", "verificationRequired: true,\n", "verificationRequired: false,\n", undefined, "GATE_LOWERING"],
    ["exact action changed", "// before\n", "// after\n", weakenMilestone, "MILESTONE_STRENGTH"],
    ["exact name weakened", "// before\n", "// after\n", weakenExpectation, "EXPECTATION_STRENGTH"],
    ["QA policy disabled", "// before\n", "// after\n", weakenPolicy, "QA_POLICY_WEAKENING"],
  ])("blocks %s", (_name, beforeSource, afterSource, mutateQaIr, expectedRule) => {
    const beforeQaIr = qaIrFixture();
    const afterQaIr = structuredClone(beforeQaIr);
    mutateQaIr?.(afterQaIr);
    const fixture = integrityFixture({ beforeSource, afterSource, beforeQaIr, afterQaIr });
    const result = checkExpectationIntegrity(fixture);

    expect(validateContract("ExpectationIntegrityResult", result, fixture)).toBe(result);
    expect(result.weakened).toBe(true);
    expect(result.ruleResults.find((rule) => rule.rule === expectedRule)).toMatchObject({ status: "FAIL" });
  });

  it("requires manual review for a legitimate QA semantic change without silently marking it safe", () => {
    const beforeQaIr = qaIrFixture();
    const afterQaIr = structuredClone(beforeQaIr);
    afterQaIr.suites[0].scenarios[0].expectations[0].target.testId = "settings-title";
    const fixture = integrityFixture({ beforeSource: "// old selector\n", afterSource: "// stronger selector\n", beforeQaIr, afterQaIr });
    const result = checkExpectationIntegrity(fixture);
    expect(result.weakened).toBe(false);
    expect(result.manualReview).toBe(true);
  });

  it("passes an ordinary product-code fix when QA IR remains identical", () => {
    const qaIr = qaIrFixture();
    const fixture = integrityFixture({ beforeSource: "export const value = 1;\n", afterSource: "export const value = 2;\n", beforeQaIr: qaIr, afterQaIr: structuredClone(qaIr), path: "src/value.mjs" });
    const result = checkExpectationIntegrity(fixture);
    expect(result.weakened).toBe(false);
    expect(result.manualReview).toBe(false);
    expect(result.suspiciousRanges).toEqual([]);
  });
});

function weakenMilestone(qaIr) {
  qaIr.suites[0].scenarios[0].steps[1].action = "PRESS";
}

function weakenExpectation(qaIr) {
  delete qaIr.suites[0].scenarios[0].expectations[0].target.accessibleName;
}

function weakenPolicy(qaIr) {
  qaIr.suites[0].scenarios[0].policy.navigation = "BLOCKED";
}

function integrityFixture({ beforeSource, afterSource, beforeQaIr, afterQaIr, path = "tests/settings.spec.ts" }) {
  const workspace = mkdtempSync(join(tmpdir(), "qa-native-integrity-"));
  temporaryDirectories.push(workspace);
  const repository = join(workspace, "repository");
  mkdirSync(join(repository, path.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(repository, path), beforeSource);
  git(repository, ["init", "-q"]);
  git(repository, ["add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);
  const proposal = {
    schemaVersion: PATCH_PROPOSAL_VERSION,
    proposalId: `patch-proposal-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`,
    diagnosisId: "diagnosis-fixture",
    codeContextBundleId: "code-context-fixture",
    repairRecommendationId: "recommendation-fixture",
    baseRevision: revision,
    intent: "Fix behavior",
    expectedEffect: "Scenario passes",
    risks: ["Review required"],
    files: [{ path, action: "MODIFY", originalContentHash: hash(readFileSync(join(repository, path))) }],
    operations: [{ type: "REPLACE_RANGE", path, startLine: 1, endLine: beforeSource.split(/\r\n|\r|\n/).length - (beforeSource.endsWith("\n") ? 1 : 0), replacement: afterSource.replace(/\n$/, "") }],
    verificationPlan: [{ command: "npm test", purpose: "Run tests" }],
  };
  const application = applyPatchProposal({ proposal, repositoryRoot: repository, cwd: workspace });
  expect(application.status).toBe("APPLIED");
  const checks = ["format", "lint", "typecheck", "unit", "playwright"].map((name) => ({ name, required: true, status: "PASS", exitCode: 0, durationMs: 1, resourceOutcome: "WITHIN_LIMITS" }));
  const verification = { schemaVersion: VERIFICATION_RESULT_VERSION, verificationId: "verification-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, worktreeRevision: revision, diffHash: application.diff.contentHash, status: "PASS", checks };
  const comparison = {
    schemaVersion: EVIDENCE_COMPARISON_VERSION,
    comparisonId: "comparison-fixture",
    proposalId: proposal.proposalId,
    applicationId: application.applicationId,
    verificationId: verification.verificationId,
    before: { runId: "before", evidenceBundleId: "before-evidence", judgeResultId: "before-judge", qaIrHash: canonicalHash(beforeQaIr), authenticated: true },
    after: { runId: "after", evidenceBundleId: "after-evidence", judgeResultId: "after-judge", qaIrHash: canonicalHash(afterQaIr), authenticated: true },
    fixedExpectationIds: ["expect-title"],
    newlyFailedExpectationIds: [],
    unchangedFailureIds: [],
    requiredMilestoneIds: ["navigate-dashboard", "open-settings"],
    preservedMilestoneIds: ["navigate-dashboard", "open-settings"],
    policyChanges: [],
    routeChanges: [],
    conclusion: "IMPROVED",
    inconclusiveReasons: [],
  };
  return { proposal, application, verification, comparison, beforeQaIr, afterQaIr, cwd: workspace };
}

function qaIrFixture() {
  return {
    schemaVersion: QA_IR_VERSION,
    id: "qa-settings",
    source: { adapter: "playwright", adapterVersion: "0.1", uri: "tests/settings.spec.ts", revision: "fixture" },
    suites: [{ id: "suite", title: "Settings", tags: [], provenance: [], scenarios: [{
      id: "scenario-settings",
      title: "opens settings",
      preconditions: [],
      steps: [
        { id: "navigate-dashboard", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } },
        { id: "open-settings", kind: "INTERACT", milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { role: "button", accessibleName: { kind: "literal", value: "Settings" } } },
      ],
      expectations: [{ id: "expect-title", kind: "VISIBLE", target: { role: "heading", accessibleName: { kind: "literal", value: "Settings" } } }],
      policy: { navigation: "ALLOWED", readDom: true, readNetwork: true, click: "SAFE_ONLY", type: "NONE", upload: false, submit: false, destructiveMutation: false, confirmation: "DENY", secrets: "RUNTIME_INJECTED" },
      provenance: [],
    }] }],
  };
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
