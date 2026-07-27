import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { CODE_CONTEXT_VERSION, EVIDENCE_COMPARISON_VERSION, EXPECTATION_INTEGRITY_RESULT_VERSION, GITHUB_PUBLICATION_RESULT_VERSION, INDEPENDENT_REMEDIATION_REVIEW_VERSION, JUDGE_RESULT_VERSION, PATCH_APPLICATION_RESULT_VERSION, PATCH_PROPOSAL_VERSION, PROVIDER_CAPABILITIES_VERSION, VERIFICATION_RESULT_VERSION, canonicalHash } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { diagnoseFailure, recommendRepair } from "../../remediation/index.mjs";
import { remediateQaNative } from "../qa-native-remediate.mjs";

const temporaryDirectories = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("qa-native end-to-end remediation state machine", () => {
  it.each(["UNKNOWN", "ENVIRONMENT"])("routes %s failures directly to the evidence-backed Issue path", async (origin) => {
    const harness = remediationHarness({ origin });
    expect(await remediateQaNative(harness.options, harness.overrides)).toBe(0);
    expect(harness.publishIssue).toHaveBeenCalledOnce();
    expect(harness.publishDraft).not.toHaveBeenCalled();
    expect(harness.apply).not.toHaveBeenCalled();
  });

  it("updates an existing Issue for an identical unsafe recurrence without creating a Draft PR", async () => {
    const harness = remediationHarness({ verificationStatus: "FAILED", existing: [{ publication: "ISSUE", number: 7, url: "https://github.com/owner/repository/issues/7", body: "managed" }] });
    expect(await remediateQaNative(harness.options, harness.overrides)).toBe(0);
    expect(harness.publishIssue).toHaveBeenCalledOnce();
    expect(harness.publishDraft).not.toHaveBeenCalled();
  });

  it("publishes a clear verified PRODUCT_CODE remediation as a Draft PR and remains idempotent", async () => {
    const harness = remediationHarness();
    const before = readFileSync(harness.sourcePath, "utf8");
    expect(await remediateQaNative(harness.options, harness.overrides)).toBe(0);
    expect(harness.publishDraft).toHaveBeenCalledOnce();
    expect(harness.publishDraft.mock.calls[0][0].decision.action).toBe("CREATE_DRAFT_PR");
    expect(harness.publishIssue).not.toHaveBeenCalled();
    expect(readFileSync(harness.sourcePath, "utf8")).toBe(before);

    expect(await remediateQaNative(harness.options, harness.overrides)).toBe(0);
    expect(harness.propose).toHaveBeenCalledOnce();
    expect(harness.apply).toHaveBeenCalledOnce();
    expect(harness.verify).toHaveBeenCalledOnce();
    expect(harness.rerun).toHaveBeenCalledOnce();
    expect(harness.publishDraft).toHaveBeenCalledOnce();
  });

  it.each([
    ["stale patch hash", { applicationStatus: "PATCH_STALE" }],
    ["deterministic test failure", { verificationStatus: "FAILED" }],
    ["unchanged live rerun", { comparisonConclusion: "UNCHANGED" }],
    ["regressed live rerun", { comparisonConclusion: "REGRESSED" }],
    ["inconclusive live rerun", { comparisonConclusion: "INCONCLUSIVE" }],
    ["expectation weakening", { weakened: true }],
    ["independent reviewer rejection", { reviewDecision: "REJECT" }],
  ])("falls back to Issue for %s", async (_name, settings) => {
    const harness = remediationHarness(settings);
    expect(await remediateQaNative(harness.options, harness.overrides)).toBe(0);
    expect(harness.publishIssue).toHaveBeenCalledOnce();
    expect(harness.publishDraft).not.toHaveBeenCalled();
  });

  it("updates a matching managed Draft PR without duplicating it", async () => {
    const existing = [{ publication: "DRAFT_PR", number: 9, url: "https://github.com/owner/repository/pull/9", body: "managed" }];
    const harness = remediationHarness({ existing });
    expect(await remediateQaNative(harness.options, harness.overrides)).toBe(0);
    expect(harness.publishDraft).toHaveBeenCalledOnce();
    expect(harness.publishDraft.mock.calls[0][0].decision).toMatchObject({ action: "UPDATE_DRAFT_PR", target: { number: 9 } });
  });

  it("persists publication intent so a GitHub failure retries without rerunning remediation stages", async () => {
    const harness = remediationHarness();
    harness.publishDraft.mockRejectedValueOnce(new Error("GitHub unavailable"));
    await expect(remediateQaNative(harness.options, harness.overrides)).rejects.toThrow("GitHub unavailable");
    expect(await remediateQaNative(harness.options, harness.overrides)).toBe(0);
    expect(harness.apply).toHaveBeenCalledOnce();
    expect(harness.verify).toHaveBeenCalledOnce();
    expect(harness.rerun).toHaveBeenCalledOnce();
    expect(harness.publishDraft).toHaveBeenCalledTimes(2);
  });
});

function remediationHarness(settings = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-remediate-"));
  temporaryDirectories.push(cwd);
  const runDirectory = join(cwd, ".qa", "runs", "run-fixture");
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  for (const path of [join(cwd, ".qa"), join(cwd, ".qa", "runs"), runDirectory]) chmodPrivate(path);
  const repositoryRoot = join(cwd, "repository");
  const sourcePath = join(repositoryRoot, "src", "value.mjs");
  mkdirSync(join(repositoryRoot, "src"), { recursive: true });
  writeFileSync(sourcePath, "export const value = 1;\n");
  const prepared = preparedFixture(settings.origin ?? "PRODUCT_CODE");
  const chain = pipelineChain(prepared, settings);
  const options = { cwd, runDirectory, repositoryRoot, repository: "owner/repository", revision: "HEAD", integrityKey: Buffer.alloc(32, 0x11), publicationKey: Buffer.alloc(32, 0x22), publish: "auto" };
  const propose = vi.fn(async () => ({ model: "proposal" }));
  const apply = vi.fn(() => chain.application);
  const verify = vi.fn(() => ({ result: chain.verification, outputs: [] }));
  const rerun = vi.fn(async () => ({ comparison: chain.comparison, after: { qaIr: prepared.qaIr } }));
  const publishIssue = vi.fn(async () => 0);
  const publishDraft = vi.fn(async ({ decision }) => githubResult(prepared, chain, decision));
  const reviewer = Object.assign(async () => ({}), { identity: { provider: "fixture", model: "reviewer", invocationId: "review-fixture" } });
  const issueTransport = { findOpenPublications: vi.fn(async () => settings.existing ?? []) };
  const overrides = {
    prepare: vi.fn(() => prepared),
    propose,
    buildProposal: vi.fn(() => chain.proposal),
    apply,
    verify,
    buildBefore: vi.fn(() => ({})),
    rerun,
    checkIntegrity: vi.fn(() => chain.integrity),
    createReview: vi.fn(async () => chain.review),
    reviewer,
    issueTransport,
    publishIssue,
    publishDraft,
    loadConfig: vi.fn(async () => ({ remediation: {} })),
  };
  return { options, overrides, sourcePath, propose, apply, verify, rerun, publishIssue, publishDraft };
}

function preparedFixture(origin) {
  const qaIr = compilePlaywrightSpec({
    source: `// @qa-scenario: SETTINGS
// @qa-live-policy: readonly
test("opens", async ({ page }) => {
  await expect(page.getByText("Settings")).toBeVisible();
});
`,
    sourcePath: "tests/settings.spec.ts",
  }).qaIr;
  const scenario = qaIr.suites[0].scenarios[0];
  const expectation = scenario.expectations[0];
  const store = createInMemoryEvidenceStore({ providerCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "fixture", actions: [], evidence: ["VISIBLE_TEXT"] } });
  const artifact = store.captureArtifact({ id: "visible", type: "VISIBLE_TEXT", contentType: "text/plain", content: "missing" });
  const fact = origin === "ENVIRONMENT" ? { id: "environment", kind: "ENVIRONMENT_ERROR", value: "unavailable" } : { id: "text", kind: "TEXT", value: "missing" };
  const evidenceBundle = store.createBundle({ runId: "run-fixture", scenarioId: scenario.id, checkpointId: "final", capturedAt: "2026-07-27T00:00:00.000Z", environment: { targetUrl: "https://example.test/settings", browser: "chromium", viewport: { width: 1280, height: 720 } }, artifacts: [artifact], facts: [fact] });
  const status = origin === "UNKNOWN" ? "NOT_OBSERVED" : "CONTRADICTED";
  const verdict = origin === "UNKNOWN" ? "MANUAL_REVIEW" : "FAIL";
  const evidenceRef = origin === "PRODUCT_CODE" ? artifact.id : fact.id;
  const judgeBody = { schemaVersion: JUDGE_RESULT_VERSION, qaIrId: qaIr.id, evidenceBundleId: evidenceBundle.bundleId, verdict, confidence: 0.9, expectationResults: [{ expectationId: expectation.id, status, confidence: 0.9, evidenceRefs: [evidenceRef], rationale: "fixture failure" }], uncertainty: [], judge: { provider: "fixture", model: "fixture", promptVersion: "fixture/0.1" }, inputHash: canonicalHash({ qaIrId: qaIr.id, evidenceBundleId: evidenceBundle.bundleId }) };
  const judgeResult = { ...judgeBody, resultId: `judge-${canonicalHash(judgeBody).slice(7, 23)}` };
  const diagnosis = diagnoseFailure({ qaIr, judgeResult, evidenceBundle });
  const revision = "1".repeat(40);
  const contextBody = { schemaVersion: CODE_CONTEXT_VERSION, repositoryId: "owner/repository", revision, failureDiagnosisId: diagnosis.diagnosisId, candidates: [{ path: "src/value.mjs", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 24 } }, relevanceScore: 0.9, matchReasons: ["VISIBLE_TEXT_MATCH"] }], snippets: [{ path: "src/value.mjs", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 24 } }, text: "export const value = 1;", contentHash: hash("export const value = 1;\n") }], searchAudit: { queries: [{ term: "Settings", reason: "VISIBLE_TEXT_MATCH" }], strategies: ["PINNED_GIT_BLOB"] } };
  const codeContext = { ...contextBody, bundleId: `code-context-${canonicalHash(contextBody).slice(7, 23)}` };
  const recommendation = recommendRepair({ diagnosis, codeContext, qaIr, judgeResult, evidenceBundle });
  return { qaIr, repositoryRevision: revision, items: [{ judgeResult, evidenceBundle, diagnosis, codeContext, recommendation }] };
}

function pipelineChain(prepared, settings) {
  const { diagnosis, codeContext, recommendation } = prepared.items[0];
  const proposal = { schemaVersion: PATCH_PROPOSAL_VERSION, proposalId: "patch-proposal-aaaaaaaaaaaaaaaa", diagnosisId: diagnosis.diagnosisId, codeContextBundleId: codeContext.bundleId, repairRecommendationId: recommendation.recommendationId, baseRevision: codeContext.revision, intent: "Fix value", expectedEffect: "Expectation passes", risks: ["Review"], files: [{ path: "src/value.mjs", action: "MODIFY", originalContentHash: codeContext.snippets[0].contentHash }], operations: [{ type: "REPLACE_RANGE", path: "src/value.mjs", startLine: 1, endLine: 1, replacement: "export const value = 2;" }], verificationPlan: recommendation.verificationPlan };
  const applied = settings.applicationStatus !== "PATCH_STALE";
  const application = applied
    ? { schemaVersion: PATCH_APPLICATION_RESULT_VERSION, applicationId: "application-fixture", proposalId: proposal.proposalId, baseRevision: proposal.baseRevision, status: "APPLIED", worktree: { worktreeId: "worktree-fixture", path: ".qa/worktrees/worktree-fixture", branch: "qa/fix-fixture", revision: proposal.baseRevision }, appliedFiles: [{ path: "src/value.mjs", action: "MODIFY", beforeHash: proposal.files[0].originalContentHash, afterHash: `sha256:${"2".repeat(64)}` }], diff: { fileCount: 1, changedLines: 2, contentHash: `sha256:${"3".repeat(64)}` } }
    : { schemaVersion: PATCH_APPLICATION_RESULT_VERSION, applicationId: "application-stale", proposalId: proposal.proposalId, baseRevision: proposal.baseRevision, status: "PATCH_STALE", appliedFiles: [], diff: { fileCount: 0, changedLines: 0, contentHash: hash("") }, reason: "stale" };
  if (!applied) return { proposal, application };
  const verificationStatus = settings.verificationStatus ?? "PASS";
  const checks = ["format", "lint", "typecheck", "unit", "playwright"].map((name, index) => ({ name, required: true, status: verificationStatus === "FAILED" && index === 0 ? "FAIL" : "PASS", exitCode: verificationStatus === "FAILED" && index === 0 ? 1 : 0, durationMs: 1, resourceOutcome: "WITHIN_LIMITS" }));
  const verification = { schemaVersion: VERIFICATION_RESULT_VERSION, verificationId: "verification-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, worktreeRevision: proposal.baseRevision, diffHash: application.diff.contentHash, status: verificationStatus, checks, ...(verificationStatus === "PASS" ? {} : { reason: "failed" }) };
  if (verificationStatus !== "PASS") return { proposal, application, verification };
  const conclusion = settings.comparisonConclusion ?? "IMPROVED";
  const qaIrHash = canonicalHash(prepared.qaIr);
  const comparison = { schemaVersion: EVIDENCE_COMPARISON_VERSION, comparisonId: "comparison-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, verificationId: verification.verificationId, before: { runId: "before", evidenceBundleId: "before-evidence", judgeResultId: "before-judge", qaIrHash, authenticated: true }, after: { runId: "after", evidenceBundleId: "after-evidence", judgeResultId: "after-judge", qaIrHash, authenticated: conclusion !== "INCONCLUSIVE" }, fixedExpectationIds: conclusion === "IMPROVED" ? ["expectation"] : [], newlyFailedExpectationIds: conclusion === "REGRESSED" ? ["new-failure"] : [], unchangedFailureIds: conclusion === "UNCHANGED" ? ["expectation"] : [], requiredMilestoneIds: [], preservedMilestoneIds: [], policyChanges: [], routeChanges: [], conclusion, inconclusiveReasons: conclusion === "INCONCLUSIVE" ? ["runtime failure"] : [] };
  if (conclusion !== "IMPROVED") return { proposal, application, verification, comparison };
  const weakened = settings.weakened ?? false;
  const rules = ["SKIP_OR_ONLY", "ASSERTION_REMOVAL", "MILESTONE_STRENGTH", "EXPECTATION_STRENGTH", "TIMEOUT_RETRY_INFLATION", "CONDITIONAL_BYPASS", "SWALLOWED_ERROR", "FORCED_RESULT", "QA_POLICY_WEAKENING", "GATE_LOWERING", "QA_IR_CHANGE"];
  const integrity = { schemaVersion: EXPECTATION_INTEGRITY_RESULT_VERSION, integrityId: "integrity-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, comparisonId: comparison.comparisonId, weakened, manualReview: false, removedExpectationIds: [], modifiedSemanticStrength: [], suspiciousRanges: weakened ? [{ path: "src/value.mjs", startLine: 1, endLine: 1, rule: rules[0], reason: "weakened" }] : [], beforeQaIrHash: qaIrHash, afterQaIrHash: qaIrHash, ruleResults: rules.map((rule, index) => ({ rule, status: weakened && index === 0 ? "FAIL" : "PASS", matches: weakened && index === 0 ? 1 : 0 })) };
  if (weakened) return { proposal, application, verification, comparison, integrity };
  const reviewDecision = settings.reviewDecision ?? "APPROVE_DRAFT";
  const referenceHashes = { proposal: canonicalHash(proposal), application: canonicalHash(application), verification: canonicalHash(verification), comparison: canonicalHash(comparison), integrity: canonicalHash(integrity), diff: application.diff.contentHash };
  const review = { schemaVersion: INDEPENDENT_REMEDIATION_REVIEW_VERSION, reviewId: "review-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, verificationId: verification.verificationId, comparisonId: comparison.comparisonId, integrityId: integrity.integrityId, generator: { provider: "generator", model: "generator", invocationId: "generate" }, reviewer: { provider: "reviewer", model: "reviewer", invocationId: "review" }, referenceHashes, decision: reviewDecision, confidence: 0.9, risks: [], unsupportedClaims: reviewDecision === "REJECT" ? ["unsupported"] : [], rationale: "fixture" };
  return { proposal, application, verification, comparison, integrity, review };
}

function githubResult(prepared, chain, decision) {
  const item = prepared.items[0];
  const target = decision.target ?? { publication: "DRAFT_PR", number: 42, url: "https://github.com/owner/repository/pull/42" };
  return { schemaVersion: GITHUB_PUBLICATION_RESULT_VERSION, repository: "owner/repository", publication: "DRAFT_PR", action: decision.action === "UPDATE_DRAFT_PR" ? "UPDATED" : "CREATED", target, occurrence: { count: 1, firstSeen: item.evidenceBundle.capturedAt, lastSeen: item.evidenceBundle.capturedAt }, source: { runId: item.evidenceBundle.runId, evidenceBundleId: item.evidenceBundle.bundleId, judgeResultId: item.judgeResult.resultId, failureDiagnosisId: item.diagnosis.diagnosisId, codeContextBundleId: item.codeContext.bundleId, repairRecommendationId: item.recommendation.recommendationId }, publicationFingerprint: decision.publicationFingerprint };
}

function chmodPrivate(path) {
  chmodSync(path, 0o700);
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
