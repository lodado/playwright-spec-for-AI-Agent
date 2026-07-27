import { describe, expect, it, vi } from "vitest";
import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { CODE_CONTEXT_VERSION, EVIDENCE_COMPARISON_VERSION, EXPECTATION_INTEGRITY_RESULT_VERSION, INDEPENDENT_REMEDIATION_REVIEW_VERSION, JUDGE_RESULT_VERSION, PATCH_APPLICATION_RESULT_VERSION, PATCH_PROPOSAL_VERSION, PROVIDER_CAPABILITIES_VERSION, VERIFICATION_RESULT_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { decidePublication, diagnoseFailure, recommendRepair } from "../../remediation/index.mjs";
import { createFailureFingerprint, publishGitHubFailureIssue, publishGitHubVerifiedDraft, renderGitHubFailureIssue, renderGitHubOccurrenceRecord } from "../index.mjs";

function fixture({ runId = "run-1", targetUrl = "https://user:secret@example.test/dashboard?token=secret", origin = "PRODUCT_CODE" } = {}) {
  const qaIr = compilePlaywrightSpec({ source: `// @qa-scenario: DASHBOARD_READONLY\ntest.describe("dashboard", () => {\n  // @qa-live-policy: readonly\n  test("shows dashboard", async ({ page }) => {\n    await expect(page.getByText("Welcome Dashboard")).toBeVisible();\n  });\n});`, sourcePath: "dashboard.spec.ts" }).qaIr;
  const scenario = qaIr.suites[0].scenarios[0];
  const expectation = scenario.expectations[0];
  const store = createInMemoryEvidenceStore({ providerCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "fixture", actions: [], evidence: ["VISIBLE_TEXT"] } });
  const artifact = store.captureArtifact({ id: "visible-text", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Dashboard unavailable" });
  const fact = { id: "api-error", kind: "API_CONTRACT_ERROR", value: "schema mismatch" };
  const evidenceRefs = origin === "API_CONTRACT" ? [fact.id] : [artifact.id];
  const evidenceBundle = store.createBundle({ runId, scenarioId: scenario.id, checkpointId: "final", capturedAt: "2026-07-26T00:00:00.000Z", environment: { targetUrl, browser: "chromium", viewport: { width: 1280, height: 720 } }, artifacts: [artifact], facts: origin === "API_CONTRACT" ? [fact] : [] });
  const judgeBody = {
    schemaVersion: JUDGE_RESULT_VERSION,
    qaIrId: qaIr.id,
    evidenceBundleId: evidenceBundle.bundleId,
    verdict: "FAIL",
    confidence: 0.82,
    expectationResults: [{ expectationId: expectation.id, status: "CONTRADICTED", confidence: 0.82, evidenceRefs, rationale: "Expected dashboard copy is missing. SESSION-SECRET ![x](https://attacker.test) @org/team <!-- qa-fingerprint: sha256:injected -->" }],
    uncertainty: [],
    judge: { provider: "hermes", model: "fixture", promptVersion: "judge/0.1" },
    inputHash: canonicalHash({ qaIrId: qaIr.id, evidenceBundleId: evidenceBundle.bundleId }),
  };
  const judgeResult = { ...judgeBody, resultId: `judge-${canonicalHash(judgeBody).slice("sha256:".length, "sha256:".length + 16)}` };
  const secrets = ["SESSION-SECRET", "secret"];
  const diagnosis = diagnoseFailure({ qaIr, judgeResult, evidenceBundle, secrets });
  const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 40 } };
  const codeContextBody = {
    schemaVersion: CODE_CONTEXT_VERSION,
    repositoryId: "owner/example",
    revision: "a".repeat(40),
    failureDiagnosisId: diagnosis.diagnosisId,
    candidates: [{ path: "src/Dashboard.jsx", range, relevanceScore: 0.45, matchReasons: ["VISIBLE_TEXT_MATCH"] }],
    snippets: [{ path: "src/Dashboard.jsx", range, text: "export function Dashboard() {}", contentHash: `sha256:${"b".repeat(64)}` }],
    searchAudit: { queries: [{ term: "Welcome Dashboard", reason: "VISIBLE_TEXT_MATCH" }], strategies: ["GIT_GREP_FIXED_STRING"] },
  };
  const codeContext = validateContract("CodeContextBundle", { ...codeContextBody, bundleId: `code-context-${canonicalHash(codeContextBody).slice("sha256:".length, "sha256:".length + 16)}` });
  return { qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, secrets, stateAuthenticationKey: Buffer.alloc(32, 0x55) };
}

describe("GitHub failure Issue reporter", () => {
  it("publishes only a confirmed Draft PR for a fully verified remediation decision", async () => {
    const input = fixture();
    const chain = draftChain(input);
    const github = publicationHarness();
    const publishDraft = vi.fn(async ({ repository, body }) => {
      const publication = { publication: "DRAFT_PR", number: 42, url: `https://github.com/${repository}/pull/42`, body };
      github.publications.push(publication);
      return { number: publication.number, url: publication.url };
    });
    const result = await publishGitHubVerifiedDraft({ repository: "owner/example", ...input, ...chain, worktreePath: "/private/worktree", publishDraft, ...github.dependencies });

    expect(validateContract("GitHubPublicationResult", result)).toMatchObject({ publication: "DRAFT_PR", action: "CREATED", target: { number: 42 } });
    const request = publishDraft.mock.calls[0][0];
    expect(request.action).toBe("CREATE_DRAFT_PR");
    expect(request.expectedDiffHash).toBe(chain.application.diff.contentHash);
    expect(request.body).toContain("## Verified QA remediation");
    expect(request.body).toContain("never merges automatically");
    expect(request.body).not.toMatch(/SESSION-SECRET|user:secret|token=secret/);
  });

  it("publishes one bounded evidence-backed Issue without leaking secrets or unsafe URLs", async () => {
    const input = fixture();
    const github = publicationHarness();
    const verifyCodeContext = vi.fn(async () => true);
    const result = await publishGitHubFailureIssue({ repository: "Owner/Example", ...input, verifyCodeContext, ...github.dependencies });

    expect(validateContract("GitHubPublicationResult", result)).toMatchObject({ action: "CREATED", target: { publication: "ISSUE", number: 42 }, publicationFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    const request = github.dependencies.transport.mock.calls[0][0];
    expect(request.labels).toEqual(expect.arrayContaining(["qa-runtime", "auto-generated", "origin:product-code"]));
    expect(request.title).toMatch(/^\[QA\]/);
    expect(request.body).toContain("src/Dashboard.jsx:1-1");
    expect(request.body).toContain("visible-text");
    expect(request.body).toContain("Final safe URL: `/dashboard`");
    expect(request.body).not.toContain("example.test");
    expect(request.body).toContain("qa-native replay --run-dir=.qa/runs/run-1");
    expect(request.body).not.toMatch(/!\[x\]\(|@org\/team/);
    expect(request.body).toContain(`<!-- qa-fingerprint: ${result.publicationFingerprint} -->`);
    expect(request.body.match(/<!-- qa-fingerprint:/g)).toHaveLength(1);
    const publicationState = Buffer.from(request.body.match(/<!-- qa-publication-state: ([A-Za-z0-9_-]+) -->/)[1], "base64url").toString("utf8");
    expect(publicationState).not.toMatch(/run-1|judge-|evidence-/);
    expect(JSON.stringify(request)).not.toMatch(/SESSION-SECRET|user:secret|token=secret|export function/);
    expect(verifyCodeContext).toHaveBeenCalledWith({ repository: "Owner/Example", revision: "a".repeat(40), files: [{ path: "src/Dashboard.jsx", contentHash: `sha256:${"b".repeat(64)}` }] });
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0].body).toContain("<!-- qa-occurrence:");
    const occurrenceState = Buffer.from(github.comments[0].body.match(/<!-- qa-occurrence: ([A-Za-z0-9_-]+) -->/)[1], "base64url").toString("utf8");
    expect(occurrenceState).not.toMatch(/run-1|judge-|evidence-/);
  });

  it("fingerprints stable failure meaning without run, query, credential, or evidence IDs", () => {
    const first = fixture();
    const second = fixture({ runId: "run-999", targetUrl: "https://other:credential@example.test/dashboard?new=secret#fragment" });
    expect(createFailureFingerprint(first)).toBe(createFailureFingerprint(second));

    const changed = fixture({ origin: "API_CONTRACT" });
    expect(createFailureFingerprint(changed)).not.toBe(createFailureFingerprint(first));

    const reordered = fixture();
    const secondary = { ...reordered.codeContext.candidates[0], path: "src/Secondary.jsx", relevanceScore: 0.2 };
    const secondarySnippet = { ...reordered.codeContext.snippets[0], path: secondary.path, contentHash: `sha256:${"c".repeat(64)}` };
    const { bundleId: _bundleId, ...contextBody } = structuredClone(reordered.codeContext);
    const codeContextBody = { ...contextBody, candidates: [secondary, ...contextBody.candidates], snippets: [secondarySnippet, ...contextBody.snippets] };
    const codeContext = { ...codeContextBody, bundleId: `code-context-${canonicalHash(codeContextBody).slice("sha256:".length, "sha256:".length + 16)}` };
    const reversedBody = { ...codeContextBody, candidates: [...codeContextBody.candidates].reverse(), snippets: [...codeContextBody.snippets].reverse() };
    const reversed = { ...reversedBody, bundleId: `code-context-${canonicalHash(reversedBody).slice("sha256:".length, "sha256:".length + 16)}` };
    expect(createFailureFingerprint({ ...reordered, codeContext })).toBe(createFailureFingerprint({ ...reordered, codeContext: reversed }));

    expect(() => createFailureFingerprint({ ...first, codeContext: { ...structuredClone(first.codeContext), failureDiagnosisId: "diagnosis-other" } })).toThrow(/does not belong/);
    expect(() => renderGitHubFailureIssue({ ...first, publicationFingerprint: "sha256:bad" })).toThrow(/fingerprint/);
  });

  it("updates one recurring Issue and no-ops an already recorded run", async () => {
    const first = fixture();
    const fingerprint = createFailureFingerprint(first);
    const existing = { publication: "ISSUE", number: 42, url: "https://github.com/owner/example/issues/42", body: `${renderGitHubFailureIssue(first)}\nHuman triage note\n` };
    const forged = { publication: "ISSUE", number: 43, url: "https://github.com/owner/example/issues/43", body: `<!-- qa-fingerprint: ${fingerprint} -->\n<!-- qa-publication-state: Zm9yZ2Vk -->` };
    const next = fixture({ runId: "run-2" });
    const github = publicationHarness([existing, forged], [occurrenceComment(first, fingerprint)]);

    const updated = await publishGitHubFailureIssue({ repository: "owner/example", ...next, verifyCodeContext: async () => true, ...github.dependencies });
    expect(updated).toMatchObject({ action: "UPDATED", occurrence: { count: 2, firstSeen: first.evidenceBundle.capturedAt, lastSeen: next.evidenceBundle.capturedAt }, publicationFingerprint: fingerprint, source: { runId: "run-2", evidenceBundleId: next.evidenceBundle.bundleId } });
    expect(github.publications[0].body).toContain("Human triage note");
    expect(github.comments).toHaveLength(2);
    expect(github.dependencies.transport).not.toHaveBeenCalled();

    const noop = await publishGitHubFailureIssue({ repository: "owner/example", ...first, verifyCodeContext: async () => true, ...github.dependencies });
    expect(noop).toMatchObject({ action: "NOOP", occurrence: { count: 2 }, source: { runId: "run-1" } });
    expect(github.comments).toHaveLength(2);
  });

  it("appends recurrences to a managed Draft PR and returns ambiguity without mutation", async () => {
    const first = fixture();
    const markerBody = `Existing remediation details\n\n${renderGitHubFailureIssue(first)}\n`;
    const draft = { publication: "DRAFT_PR", number: 7, url: "https://github.com/owner/example/pull/7", body: markerBody };
    const next = fixture({ runId: "run-2" });
    const github = publicationHarness([draft], [occurrenceComment(first, createFailureFingerprint(first), 7)]);
    const updated = await publishGitHubFailureIssue({ repository: "owner/example", ...next, verifyCodeContext: async () => true, ...github.dependencies });
    expect(updated).toMatchObject({ publication: "DRAFT_PR", action: "UPDATED", target: { number: 7 } });
    expect(github.publications[0].body).toBe(markerBody);
    expect(github.comments).toHaveLength(2);

    const issue = { publication: "ISSUE", number: 8, url: "https://github.com/owner/example/issues/8", body: markerBody };
    const ambiguousGithub = publicationHarness([draft, issue]);
    const ambiguous = await publishGitHubFailureIssue({ repository: "owner/example", ...next, verifyCodeContext: async () => true, ...ambiguousGithub.dependencies });
    expect(ambiguous).toMatchObject({ publication: "UNRESOLVED", action: "AMBIGUOUS", matches: [{ publication: "DRAFT_PR", number: 7 }, { publication: "ISSUE", number: 8 }] });
    expect(ambiguousGithub.dependencies.transport).not.toHaveBeenCalled();
    expect(ambiguousGithub.dependencies.createOccurrenceRecord).not.toHaveBeenCalled();
  });

  it("keeps concurrent occurrence comments append-only and deduplicates retry records", async () => {
    const first = fixture();
    const second = fixture({ runId: "run-2" });
    const third = fixture({ runId: "run-3" });
    const fingerprint = createFailureFingerprint(first);
    const existing = { publication: "ISSUE", number: 42, url: "https://github.com/owner/example/issues/42", body: renderGitHubFailureIssue(first) };
    const firstComment = occurrenceComment(first, fingerprint);
    const duplicateFirst = { ...firstComment, id: 2, url: "https://github.com/owner/example/issues/42#issuecomment-2" };
    const forged = { id: 4, url: "https://github.com/owner/example/issues/42#issuecomment-4", body: "<!-- qa-occurrence: Zm9yZ2Vk -->", createdAt: first.evidenceBundle.capturedAt };
    const github = publicationHarness([existing], [firstComment, duplicateFirst, occurrenceComment(second, fingerprint, 42, 3), forged]);

    const updated = await publishGitHubFailureIssue({ repository: "owner/example", ...third, verifyCodeContext: async () => true, ...github.dependencies });
    expect(updated).toMatchObject({ action: "UPDATED", occurrence: { count: 3 } });
    expect(github.comments).toHaveLength(5);
    expect(github.publications[0].body).toBe(existing.body);
  });

  it("detects a concurrent duplicate after creation instead of selecting one", async () => {
    const input = fixture();
    const github = publicationHarness();
    github.dependencies.findRecentPublications.mockImplementation(async () => [
      ...github.publications,
      { publication: "ISSUE", number: 43, url: "https://github.com/owner/example/issues/43", body: github.publications[0].body },
    ]);
    const result = await publishGitHubFailureIssue({ repository: "owner/example", ...input, verifyCodeContext: async () => true, ...github.dependencies });
    expect(result).toMatchObject({ action: "AMBIGUOUS", publication: "UNRESOLVED", matches: [{ number: 42 }, { number: 43 }] });
  });

  it("rejects PASS publication and invalid transport results", async () => {
    const input = fixture();
    const pass = structuredClone(input.judgeResult);
    pass.verdict = "PASS";
    pass.expectationResults[0].status = "MATCHED";
    const { resultId: _resultId, ...passBody } = pass;
    pass.resultId = `judge-${canonicalHash(passBody).slice("sha256:".length, "sha256:".length + 16)}`;
    const verifyCodeContext = async () => true;
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, judgeResult: pass, verifyCodeContext, ...publicationHarness().dependencies })).rejects.toThrow(/only failed/);
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, verifyCodeContext, ...publicationHarness([], [], { invalidCreate: true }).dependencies })).rejects.toThrow(/publication data/);
    await expect(publishGitHubFailureIssue({ repository: "owner/other", ...input, verifyCodeContext, ...publicationHarness().dependencies })).rejects.toThrow(/different repository/);
    const invalidJudge = { ...input.judgeResult, resultId: "judge-forged" };
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, judgeResult: invalidJudge, verifyCodeContext, ...publicationHarness().dependencies })).rejects.toThrow(/judge artifact identity/);
    const invalidContext = { ...input.codeContext, bundleId: "code-context-forged" };
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, codeContext: invalidContext, verifyCodeContext, ...publicationHarness().dependencies })).rejects.toThrow(/code-context artifact identity/);
    const mismatchedContextBody = { ...input.codeContext, candidates: [{ ...input.codeContext.candidates[0], range: { start: { line: 2, column: 1 }, end: { line: 2, column: 40 } } }] };
    const { bundleId: _bundleId, ...mismatchedBody } = mismatchedContextBody;
    const mismatchedContext = { ...mismatchedBody, bundleId: `code-context-${canonicalHash(mismatchedBody).slice("sha256:".length, "sha256:".length + 16)}` };
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, codeContext: mismatchedContext, verifyCodeContext, ...publicationHarness().dependencies })).rejects.toThrow(/candidates do not match/);
    const invalidEvidence = { ...input.evidenceBundle, environment: { ...input.evidenceBundle.environment, targetUrl: "https://attacker.test/changed" } };
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, evidenceBundle: invalidEvidence, verifyCodeContext, ...publicationHarness().dependencies })).rejects.toThrow(/Evidence Bundle identity/);
    const github = publicationHarness();
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, verifyCodeContext: async () => false, ...github.dependencies })).rejects.toThrow(/pinned Code Context/);
    expect(github.dependencies.transport).not.toHaveBeenCalled();
  });

  it("propagates provider failures without converting them to a product verdict", async () => {
    const input = fixture();
    const github = publicationHarness();
    github.dependencies.transport.mockRejectedValue(new Error("GitHub unavailable"));
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, verifyCodeContext: async () => true, ...github.dependencies })).rejects.toThrow("GitHub unavailable");
  });
});

function occurrenceComment(input, publicationFingerprint, number = 42, id = 1) {
  const source = {
    runId: input.evidenceBundle.runId,
    evidenceBundleId: input.evidenceBundle.bundleId,
    judgeResultId: input.judgeResult.resultId,
    failureDiagnosisId: input.diagnosis.diagnosisId,
    codeContextBundleId: input.codeContext.bundleId,
  };
  return {
    id,
    url: `https://github.com/owner/example/issues/${number}#issuecomment-${id}`,
    body: renderGitHubOccurrenceRecord({ repository: input.codeContext.repositoryId, publicationFingerprint, source, occurredAt: input.evidenceBundle.capturedAt, stateAuthenticationKey: input.stateAuthenticationKey }),
    createdAt: input.evidenceBundle.capturedAt,
  };
}

function draftChain(input) {
  const recommendation = recommendRepair(input);
  const proposal = { schemaVersion: PATCH_PROPOSAL_VERSION, proposalId: "patch-proposal-1111111111111111", diagnosisId: input.diagnosis.diagnosisId, codeContextBundleId: input.codeContext.bundleId, repairRecommendationId: recommendation.recommendationId, baseRevision: input.codeContext.revision, intent: "Fix dashboard copy", expectedEffect: "The original expectation matches", risks: ["Human review required"], files: [{ path: input.codeContext.snippets[0].path, action: "MODIFY", originalContentHash: input.codeContext.snippets[0].contentHash }], operations: [{ type: "REPLACE_RANGE", path: input.codeContext.snippets[0].path, startLine: 1, endLine: 1, replacement: "export function Dashboard() { return 'Welcome Dashboard'; }" }], verificationPlan: recommendation.verificationPlan };
  const application = { schemaVersion: PATCH_APPLICATION_RESULT_VERSION, applicationId: "application-fixture", proposalId: proposal.proposalId, baseRevision: proposal.baseRevision, status: "APPLIED", worktree: { worktreeId: "worktree-fixture", path: ".qa/worktrees/worktree-fixture", branch: "qa/fix-fixture", revision: proposal.baseRevision }, appliedFiles: [{ path: proposal.files[0].path, action: "MODIFY", beforeHash: proposal.files[0].originalContentHash, afterHash: `sha256:${"c".repeat(64)}` }], diff: { fileCount: 1, changedLines: 2, contentHash: `sha256:${"d".repeat(64)}` } };
  const checks = ["format", "lint", "typecheck", "unit", "playwright"].map((name) => ({ name, required: true, status: "PASS", exitCode: 0, durationMs: 1, resourceOutcome: "WITHIN_LIMITS" }));
  const verification = { schemaVersion: VERIFICATION_RESULT_VERSION, verificationId: "verification-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, worktreeRevision: proposal.baseRevision, diffHash: application.diff.contentHash, status: "PASS", checks };
  const qaIrHash = canonicalHash(input.qaIr);
  const comparison = { schemaVersion: EVIDENCE_COMPARISON_VERSION, comparisonId: "comparison-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, verificationId: verification.verificationId, before: { runId: input.evidenceBundle.runId, evidenceBundleId: input.evidenceBundle.bundleId, judgeResultId: input.judgeResult.resultId, qaIrHash, authenticated: true }, after: { runId: "after-run", evidenceBundleId: "after-evidence", judgeResultId: "after-judge", qaIrHash, authenticated: true }, fixedExpectationIds: [input.judgeResult.expectationResults[0].expectationId], newlyFailedExpectationIds: [], unchangedFailureIds: [], requiredMilestoneIds: [], preservedMilestoneIds: [], policyChanges: [], routeChanges: [], conclusion: "IMPROVED", inconclusiveReasons: [] };
  const ruleNames = ["SKIP_OR_ONLY", "ASSERTION_REMOVAL", "MILESTONE_STRENGTH", "EXPECTATION_STRENGTH", "TIMEOUT_RETRY_INFLATION", "CONDITIONAL_BYPASS", "SWALLOWED_ERROR", "FORCED_RESULT", "QA_POLICY_WEAKENING", "GATE_LOWERING", "QA_IR_CHANGE"];
  const integrity = { schemaVersion: EXPECTATION_INTEGRITY_RESULT_VERSION, integrityId: "integrity-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, comparisonId: comparison.comparisonId, weakened: false, manualReview: false, removedExpectationIds: [], modifiedSemanticStrength: [], suspiciousRanges: [], beforeQaIrHash: qaIrHash, afterQaIrHash: qaIrHash, ruleResults: ruleNames.map((rule) => ({ rule, status: "PASS", matches: 0 })) };
  const referenceHashes = { proposal: canonicalHash(proposal), application: canonicalHash(application), verification: canonicalHash(verification), comparison: canonicalHash(comparison), integrity: canonicalHash(integrity), diff: application.diff.contentHash };
  const review = { schemaVersion: INDEPENDENT_REMEDIATION_REVIEW_VERSION, reviewId: "review-fixture", proposalId: proposal.proposalId, applicationId: application.applicationId, verificationId: verification.verificationId, comparisonId: comparison.comparisonId, integrityId: integrity.integrityId, generator: { provider: "generator", model: "generator", invocationId: "generate" }, reviewer: { provider: "reviewer", model: "reviewer", invocationId: "review" }, referenceHashes, decision: "APPROVE_DRAFT", confidence: 0.9, risks: [], unsupportedClaims: [], rationale: "Verified" };
  const publicationFingerprint = createFailureFingerprint(input);
  const decision = decidePublication({ repository: "owner/example", publicationFingerprint, diagnosis: input.diagnosis, codeContext: input.codeContext, recommendation, proposal, application, verification, comparison, integrity, review });
  return { recommendation, proposal, application, verification, comparison, integrity, review, decision };
}

function publicationHarness(initialPublications = [], initialComments = [], { invalidCreate = false } = {}) {
  const publications = structuredClone(initialPublications);
  const comments = structuredClone(initialComments);
  const transport = vi.fn(async ({ repository, body }) => {
    if (invalidCreate) return { number: 0, url: "javascript:bad" };
    const publication = { publication: "ISSUE", number: 42, url: `https://github.com/${repository}/issues/42`, body };
    publications.push(publication);
    return { number: publication.number, url: publication.url };
  });
  const dependencies = {
    findOpenPublications: vi.fn(async () => publications),
    findRecentPublications: vi.fn(async () => publications),
    readPublication: vi.fn(async ({ publication, number }) => publications.find((item) => item.publication === publication && item.number === number)),
    listOccurrenceRecords: vi.fn(async ({ number }) => comments.filter((comment) => comment.number === undefined || comment.number === number)),
    createOccurrenceRecord: vi.fn(async ({ number, body }) => {
      const id = comments.length + 1;
      const record = { id, number, url: `https://github.com/owner/example/issues/${number}#issuecomment-${id}`, body, createdAt: "2026-07-26T00:00:00.000Z" };
      comments.push(record);
      return record;
    }),
    transport,
  };
  return { publications, comments, dependencies };
}
