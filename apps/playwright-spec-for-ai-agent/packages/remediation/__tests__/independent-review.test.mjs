import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CODE_CONTEXT_VERSION, EVIDENCE_COMPARISON_VERSION, EXPECTATION_INTEGRITY_RESULT_VERSION, FAILURE_DIAGNOSIS_VERSION, INDEPENDENT_REMEDIATION_REVIEW_VERSION, PATCH_PROPOSAL_VERSION, REPAIR_RECOMMENDATION_VERSION, VERIFICATION_RESULT_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { applyPatchProposal, createIndependentRemediationReview } from "../index.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("independent remediation review", () => {
  it("binds an approval to immutable artifacts through a distinct read-only invocation", async () => {
    const fixture = reviewFixture();
    let received;
    const review = await createIndependentRemediationReview({
      ...fixture,
      generatorIdentity: { provider: "hermes", model: "generator", invocationId: "generate-1" },
      reviewerIdentity: { provider: "hermes-review", model: "reviewer", invocationId: "review-1" },
      async reviewer(input) {
        received = input;
        return { decision: "APPROVE_DRAFT", confidence: 0.9, risks: ["Human review still required"], unsupportedClaims: [], rationale: "Diff and evidence references are consistent.", referenceHashes: input.referenceHashes };
      },
    });

    expect(validateContract("IndependentRemediationReview", review, fixture)).toBe(review);
    expect(review).toMatchObject({ schemaVersion: INDEPENDENT_REMEDIATION_REVIEW_VERSION, decision: "APPROVE_DRAFT" });
    expect(received).toHaveProperty("appliedDiff");
    expect(received).not.toHaveProperty("worktreePath");
    expect(received).not.toHaveProperty("browser");
    expect(received).not.toHaveProperty("tools");
  });

  it("rejects self-review and forged or missing artifact references", async () => {
    const fixture = reviewFixture();
    const identity = { provider: "hermes", model: "same", invocationId: "same-invocation" };
    await expect(createIndependentRemediationReview({ ...fixture, generatorIdentity: identity, reviewerIdentity: identity, reviewer: async () => ({}) })).rejects.toThrow(/cannot use the patch generator invocation/);

    await expect(createIndependentRemediationReview({
      ...fixture,
      generatorIdentity: { provider: "hermes", model: "generator", invocationId: "generate-2" },
      reviewerIdentity: { provider: "other", model: "reviewer", invocationId: "review-2" },
      reviewer: async (input) => ({ decision: "REJECT", confidence: 0.8, risks: [], unsupportedClaims: ["Unsupported fix claim"], rationale: "References are forged.", referenceHashes: { ...input.referenceHashes, diff: `sha256:${"0".repeat(64)}` } }),
    })).rejects.toThrow(/references do not match/);
  });

  it("turns provider failure into an auditable MANUAL_REVIEW result", async () => {
    const fixture = reviewFixture();
    const review = await createIndependentRemediationReview({
      ...fixture,
      generatorIdentity: { provider: "hermes", model: "generator", invocationId: "generate-3" },
      reviewerIdentity: { provider: "other", model: "reviewer", invocationId: "review-3" },
      reviewer: async () => { throw new Error("provider unavailable"); },
    });
    expect(review).toMatchObject({ decision: "MANUAL_REVIEW", confidence: 0 });
    expect(review.rationale).toMatch(/Provider failure/);
  });
});

function reviewFixture() {
  const workspace = mkdtempSync(join(tmpdir(), "qa-native-review-"));
  temporaryDirectories.push(workspace);
  const repository = join(workspace, "repository");
  const path = "src/value.mjs";
  const source = "export const value = 1;\n";
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, path), source);
  git(repository, ["init", "-q"]);
  git(repository, ["add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);
  const sourceHash = hash(Buffer.from(source));
  const diagnosis = { schemaVersion: FAILURE_DIAGNOSIS_VERSION, diagnosisId: "diagnosis-fixture", judgeResultId: "judge-fixture", origin: "PRODUCT_CODE", confidence: 0.8, symptom: "Value is incorrect", likelyCause: "Implementation returns stale value", supportingEvidenceRefs: ["fact-fixture"], contradictingEvidenceRefs: [], remediationEligible: true, manualReviewReasons: [] };
  const codeContext = {
    schemaVersion: CODE_CONTEXT_VERSION,
    bundleId: "code-context-fixture",
    repositoryId: "fixture/repository",
    revision,
    failureDiagnosisId: diagnosis.diagnosisId,
    candidates: [{ path, range: { start: { line: 1, column: 1 }, end: { line: 1, column: source.length } }, relevanceScore: 0.9, matchReasons: ["STACK_TRACE_MATCH"] }],
    snippets: [{ path, range: { start: { line: 1, column: 1 }, end: { line: 1, column: source.length } }, text: source, contentHash: sourceHash }],
    searchAudit: { queries: [{ term: "value", reason: "STACK_TRACE_MATCH" }], strategies: ["PINNED_GIT_BLOB"] },
  };
  const recommendationBody = {
    schemaVersion: REPAIR_RECOMMENDATION_VERSION,
    diagnosisId: diagnosis.diagnosisId,
    repositoryRevision: revision,
    title: "Fix value",
    severity: "MEDIUM",
    summary: diagnosis.symptom,
    rootCause: diagnosis.likelyCause,
    confidence: 0.8,
    locations: [{ path, range: codeContext.candidates[0].range, reason: "STACK_TRACE_MATCH" }],
    changes: [{ path, recommendation: "Return the expected value", expectedEffect: "Expectation passes", risks: ["Review required"] }],
    verificationPlan: [{ command: "npm test", purpose: "Run tests" }],
    evidenceRefs: diagnosis.supportingEvidenceRefs,
    codeContextRefs: [codeContext.bundleId],
    patchEligibility: "SUGGESTION_ONLY",
  };
  const recommendation = { ...recommendationBody, recommendationId: `recommendation-${canonicalHash(recommendationBody).slice(7, 23)}` };
  const proposal = {
    schemaVersion: PATCH_PROPOSAL_VERSION,
    proposalId: `patch-proposal-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`,
    diagnosisId: diagnosis.diagnosisId,
    codeContextBundleId: codeContext.bundleId,
    repairRecommendationId: recommendation.recommendationId,
    baseRevision: revision,
    intent: "Fix value",
    expectedEffect: "Expectation passes",
    risks: ["Review required"],
    files: [{ path, action: "MODIFY", originalContentHash: sourceHash }],
    operations: [{ type: "REPLACE_RANGE", path, startLine: 1, endLine: 1, replacement: "export const value = 2;" }],
    verificationPlan: recommendation.verificationPlan,
  };
  const application = applyPatchProposal({ proposal, repositoryRoot: repository, cwd: workspace });
  expect(application.status).toBe("APPLIED");
  const checks = ["format", "lint", "typecheck", "unit", "playwright"].map((name) => ({ name, required: true, status: "PASS", exitCode: 0, durationMs: 1, resourceOutcome: "WITHIN_LIMITS" }));
  const verification = { schemaVersion: VERIFICATION_RESULT_VERSION, verificationId: "verification-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, worktreeRevision: revision, diffHash: application.diff.contentHash, status: "PASS", checks };
  const qaIrHash = `sha256:${"4".repeat(64)}`;
  const comparison = { schemaVersion: EVIDENCE_COMPARISON_VERSION, comparisonId: "comparison-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, verificationId: verification.verificationId, before: { runId: "before", evidenceBundleId: "before-evidence", judgeResultId: "before-judge", qaIrHash, authenticated: true }, after: { runId: "after", evidenceBundleId: "after-evidence", judgeResultId: "after-judge", qaIrHash, authenticated: true }, fixedExpectationIds: ["expectation"], newlyFailedExpectationIds: [], unchangedFailureIds: [], requiredMilestoneIds: ["milestone"], preservedMilestoneIds: ["milestone"], policyChanges: [], routeChanges: [], conclusion: "IMPROVED", inconclusiveReasons: [] };
  const ruleResults = ["SKIP_OR_ONLY", "ASSERTION_REMOVAL", "MILESTONE_STRENGTH", "EXPECTATION_STRENGTH", "TIMEOUT_RETRY_INFLATION", "CONDITIONAL_BYPASS", "SWALLOWED_ERROR", "FORCED_RESULT", "QA_POLICY_WEAKENING", "GATE_LOWERING", "QA_IR_CHANGE"].map((rule) => ({ rule, status: "PASS", matches: 0 }));
  const integrity = { schemaVersion: EXPECTATION_INTEGRITY_RESULT_VERSION, integrityId: "integrity-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, comparisonId: comparison.comparisonId, weakened: false, manualReview: false, removedExpectationIds: [], modifiedSemanticStrength: [], suspiciousRanges: [], beforeQaIrHash: qaIrHash, afterQaIrHash: qaIrHash, ruleResults };
  return { diagnosis, codeContext, recommendation, proposal, application, verification, comparison, integrity, cwd: workspace };
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
