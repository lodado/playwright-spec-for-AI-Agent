import { describe, expect, it } from "vitest";

import { CODE_CONTEXT_VERSION, EVIDENCE_COMPARISON_VERSION, EXPECTATION_INTEGRITY_RESULT_VERSION, FAILURE_DIAGNOSIS_VERSION, INDEPENDENT_REMEDIATION_REVIEW_VERSION, PATCH_APPLICATION_RESULT_VERSION, PATCH_PROPOSAL_VERSION, PUBLICATION_DECISION_VERSION, REPAIR_RECOMMENDATION_VERSION, VERIFICATION_RESULT_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { decidePublication } from "../index.mjs";

const repository = "owner/repository";
const fingerprint = `sha256:${"f".repeat(64)}`;

describe("deterministic remediation publication decision", () => {
  it("creates or updates only a Draft PR when every independent gate passes", () => {
    const chain = fullChain();
    const created = decidePublication({ repository, publicationFingerprint: fingerprint, ...chain });
    expect(validateContract("PublicationDecision", created)).toBe(created);
    expect(created).toMatchObject({ schemaVersion: PUBLICATION_DECISION_VERSION, action: "CREATE_DRAFT_PR", publication: "DRAFT_PR", eligibleDraft: true, branch: chain.application.worktree.branch });

    const draft = { publication: "DRAFT_PR", number: 42, url: "https://github.com/owner/repository/pull/42" };
    expect(decidePublication({ repository, publicationFingerprint: fingerprint, ...chain, existingPublications: [draft] })).toMatchObject({ action: "UPDATE_DRAFT_PR", target: draft });
    expect(decidePublication({ repository, publicationFingerprint: fingerprint, ...chain, existingPublications: [draft], currentSourcePublished: true })).toMatchObject({ action: "NOOP", publication: "NONE" });
  });

  it.each([
    ["deterministic check failure", { verificationStatus: "FAILED" }, "DETERMINISTIC_VERIFICATION"],
    ["unchanged live rerun", { comparisonConclusion: "UNCHANGED" }, "LIVE_COMPARISON"],
    ["expectation weakening", { weakened: true }, "EXPECTATION_INTEGRITY"],
    ["reviewer rejection", { reviewDecision: "REJECT" }, "INDEPENDENT_REVIEW"],
  ])("routes %s to an Issue even if other gates and reviewer approval pass", (_name, options, failedGate) => {
    const decision = decidePublication({ repository, publicationFingerprint: fingerprint, ...fullChain(options) });
    expect(decision).toMatchObject({ action: "CREATE_ISSUE", publication: "ISSUE", eligibleDraft: false });
    expect(decision.gates.find((gate) => gate.gate === failedGate).status).toBe("FAIL");
  });

  it("routes ineligible or incomplete origins to Issue and never invents a patch PASS", () => {
    const diagnosis = { schemaVersion: FAILURE_DIAGNOSIS_VERSION, diagnosisId: "diagnosis-environment", judgeResultId: "judge-environment", origin: "ENVIRONMENT", confidence: 0.4, symptom: "Environment unavailable", likelyCause: "Deployment failed", supportingEvidenceRefs: ["fact"], contradictingEvidenceRefs: [], remediationEligible: false, manualReviewReasons: ["Environment recovery required"] };
    const codeContext = { schemaVersion: CODE_CONTEXT_VERSION, bundleId: "context-environment", repositoryId: repository, revision: "1".repeat(40), failureDiagnosisId: diagnosis.diagnosisId, candidates: [], snippets: [], searchAudit: { queries: [], strategies: [] } };
    const decision = decidePublication({ repository, publicationFingerprint: fingerprint, diagnosis, codeContext });
    expect(decision).toMatchObject({ action: "CREATE_ISSUE", eligibleDraft: false });
    expect(decision.gates.find((gate) => gate.gate === "PATCH_APPLICATION").status).toBe("UNKNOWN");
  });

  it("updates the matching Issue and fails closed on ambiguous or unsafe matching Draft PRs", () => {
    const chain = fullChain();
    const issue = { publication: "ISSUE", number: 7, url: "https://github.com/owner/repository/issues/7" };
    expect(decidePublication({ repository, publicationFingerprint: fingerprint, ...chain, existingPublications: [issue] })).toMatchObject({ action: "UPDATE_ISSUE", target: issue });

    const unsafe = fullChain({ verificationStatus: "FAILED" });
    const draft = { publication: "DRAFT_PR", number: 8, url: "https://github.com/owner/repository/pull/8" };
    expect(decidePublication({ repository, publicationFingerprint: fingerprint, ...unsafe, existingPublications: [draft] })).toMatchObject({ action: "MANUAL_REVIEW", publication: "NONE" });
    expect(decidePublication({ repository, publicationFingerprint: fingerprint, ...chain, existingPublications: [issue, draft] })).toMatchObject({ action: "MANUAL_REVIEW", publication: "NONE" });
  });
});

function fullChain({ verificationStatus = "PASS", comparisonConclusion = "IMPROVED", weakened = false, reviewDecision = "APPROVE_DRAFT" } = {}) {
  const revision = "1".repeat(40);
  const sourceHash = `sha256:${"2".repeat(64)}`;
  const diagnosis = { schemaVersion: FAILURE_DIAGNOSIS_VERSION, diagnosisId: "diagnosis-fixture", judgeResultId: "judge-fixture", origin: "PRODUCT_CODE", confidence: 0.8, symptom: "Wrong value", likelyCause: "Implementation is stale", supportingEvidenceRefs: ["fact"], contradictingEvidenceRefs: [], remediationEligible: true, manualReviewReasons: [] };
  const codeContext = { schemaVersion: CODE_CONTEXT_VERSION, bundleId: "context-fixture", repositoryId: repository, revision, failureDiagnosisId: diagnosis.diagnosisId, candidates: [{ path: "src/value.mjs", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 20 } }, relevanceScore: 0.9, matchReasons: ["STACK_TRACE_MATCH"] }], snippets: [{ path: "src/value.mjs", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 20 } }, text: "export const value=1", contentHash: sourceHash }], searchAudit: { queries: [{ term: "value", reason: "STACK_TRACE_MATCH" }], strategies: ["PINNED_GIT_BLOB"] } };
  const recommendationBody = { schemaVersion: REPAIR_RECOMMENDATION_VERSION, diagnosisId: diagnosis.diagnosisId, repositoryRevision: revision, title: "Fix value", severity: "MEDIUM", summary: diagnosis.symptom, rootCause: diagnosis.likelyCause, confidence: 0.8, locations: [{ path: "src/value.mjs", range: codeContext.candidates[0].range, reason: "STACK_TRACE_MATCH" }], changes: [{ path: "src/value.mjs", recommendation: "Return expected value", expectedEffect: "Expectation passes", risks: ["Review"] }], verificationPlan: [{ command: "npm test", purpose: "Run tests" }], evidenceRefs: ["fact"], codeContextRefs: [codeContext.bundleId], patchEligibility: "SUGGESTION_ONLY" };
  const recommendation = { ...recommendationBody, recommendationId: `recommendation-${canonicalHash(recommendationBody).slice(7, 23)}` };
  const proposal = { schemaVersion: PATCH_PROPOSAL_VERSION, proposalId: "patch-proposal-1111111111111111", diagnosisId: diagnosis.diagnosisId, codeContextBundleId: codeContext.bundleId, repairRecommendationId: recommendation.recommendationId, baseRevision: revision, intent: "Fix value", expectedEffect: "Expectation passes", risks: ["Review"], files: [{ path: "src/value.mjs", action: "MODIFY", originalContentHash: sourceHash }], operations: [{ type: "REPLACE_RANGE", path: "src/value.mjs", startLine: 1, endLine: 1, replacement: "export const value=2" }], verificationPlan: recommendation.verificationPlan };
  const application = { schemaVersion: PATCH_APPLICATION_RESULT_VERSION, applicationId: "application-fixture", proposalId: proposal.proposalId, baseRevision: revision, status: "APPLIED", worktree: { worktreeId: "worktree-fixture", path: ".qa/worktrees/worktree-fixture", branch: "qa/fix-fixture", revision }, appliedFiles: [{ path: "src/value.mjs", action: "MODIFY", beforeHash: sourceHash, afterHash: `sha256:${"3".repeat(64)}` }], diff: { fileCount: 1, changedLines: 2, contentHash: `sha256:${"4".repeat(64)}` } };
  const checks = ["format", "lint", "typecheck", "unit", "playwright"].map((name, index) => ({ name, required: true, status: verificationStatus === "FAILED" && index === 0 ? "FAIL" : "PASS", exitCode: verificationStatus === "FAILED" && index === 0 ? 1 : 0, durationMs: 1, resourceOutcome: "WITHIN_LIMITS" }));
  const verification = { schemaVersion: VERIFICATION_RESULT_VERSION, verificationId: "verification-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, worktreeRevision: revision, diffHash: application.diff.contentHash, status: verificationStatus, checks, ...(verificationStatus === "PASS" ? {} : { reason: "required check failed" }) };
  const qaIrHash = `sha256:${"5".repeat(64)}`;
  const comparison = { schemaVersion: EVIDENCE_COMPARISON_VERSION, comparisonId: "comparison-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, verificationId: verification.verificationId, before: { runId: "before", evidenceBundleId: "before-evidence", judgeResultId: "before-judge", qaIrHash, authenticated: true }, after: { runId: "after", evidenceBundleId: "after-evidence", judgeResultId: "after-judge", qaIrHash, authenticated: true }, fixedExpectationIds: comparisonConclusion === "IMPROVED" ? ["expectation"] : [], newlyFailedExpectationIds: [], unchangedFailureIds: comparisonConclusion === "UNCHANGED" ? ["expectation"] : [], requiredMilestoneIds: ["milestone"], preservedMilestoneIds: ["milestone"], policyChanges: [], routeChanges: [], conclusion: comparisonConclusion, inconclusiveReasons: [] };
  const rules = ["SKIP_OR_ONLY", "ASSERTION_REMOVAL", "MILESTONE_STRENGTH", "EXPECTATION_STRENGTH", "TIMEOUT_RETRY_INFLATION", "CONDITIONAL_BYPASS", "SWALLOWED_ERROR", "FORCED_RESULT", "QA_POLICY_WEAKENING", "GATE_LOWERING", "QA_IR_CHANGE"];
  const ruleResults = rules.map((rule, index) => ({ rule, status: weakened && index === 0 ? "FAIL" : "PASS", matches: weakened && index === 0 ? 1 : 0 }));
  const integrity = { schemaVersion: EXPECTATION_INTEGRITY_RESULT_VERSION, integrityId: "integrity-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, comparisonId: comparison.comparisonId, weakened, manualReview: false, removedExpectationIds: [], modifiedSemanticStrength: [], suspiciousRanges: weakened ? [{ path: "src/value.mjs", startLine: 1, endLine: 1, rule: rules[0], reason: "fixture weakening" }] : [], beforeQaIrHash: qaIrHash, afterQaIrHash: qaIrHash, ruleResults };
  const referenceHashes = { proposal: canonicalHash(proposal), application: canonicalHash(application), verification: canonicalHash(verification), comparison: canonicalHash(comparison), integrity: canonicalHash(integrity), diff: application.diff.contentHash };
  const review = { schemaVersion: INDEPENDENT_REMEDIATION_REVIEW_VERSION, reviewId: "review-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, verificationId: verification.verificationId, comparisonId: comparison.comparisonId, integrityId: integrity.integrityId, generator: { provider: "generator", model: "generator", invocationId: "generate" }, reviewer: { provider: "reviewer", model: "reviewer", invocationId: "review" }, referenceHashes, decision: reviewDecision, confidence: 0.9, risks: [], unsupportedClaims: reviewDecision === "REJECT" ? ["Unsupported claim"] : [], rationale: "Fixture review" };
  return { diagnosis, codeContext, recommendation, proposal, application, verification, comparison, integrity, review };
}
