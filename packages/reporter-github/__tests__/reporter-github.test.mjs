import { describe, expect, it, vi } from "vitest";
import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { CODE_CONTEXT_VERSION, JUDGE_RESULT_VERSION, PROVIDER_CAPABILITIES_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { diagnoseFailure } from "../../remediation/index.mjs";
import { createFailureFingerprint, publishGitHubFailureIssue, renderGitHubFailureIssue } from "../index.mjs";

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
    expectationResults: [{ expectationId: expectation.id, status: "CONTRADICTED", confidence: 0.82, evidenceRefs, rationale: "Expected dashboard copy is missing. SESSION-SECRET ![x](https://attacker.test) @org/team" }],
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
  return { qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, secrets };
}

describe("GitHub failure Issue reporter", () => {
  it("publishes one bounded evidence-backed Issue without leaking secrets or unsafe URLs", async () => {
    const input = fixture();
    const transport = vi.fn(async () => ({ number: 42, url: "https://github.com/owner/example/issues/42" }));
    const verifyCodeContext = vi.fn(async () => true);
    const result = await publishGitHubFailureIssue({ repository: "Owner/Example", ...input, verifyCodeContext, transport: async (request) => { transport(request); return { number: 42, url: "https://github.com/owner/example/issues/42" }; } });

    expect(validateContract("GitHubPublicationResult", result)).toMatchObject({ action: "CREATED", target: { publication: "ISSUE", number: 42 }, publicationFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    const request = transport.mock.calls[0][0];
    expect(request.labels).toEqual(expect.arrayContaining(["qa-runtime", "auto-generated", "origin:product-code"]));
    expect(request.title).toMatch(/^\[QA\]/);
    expect(request.body).toContain("src/Dashboard.jsx:1-1");
    expect(request.body).toContain("visible-text");
    expect(request.body).toContain("Final safe URL: `/dashboard`");
    expect(request.body).not.toContain("example.test");
    expect(request.body).toContain("qa-native replay --run-dir=.qa/runs/run-1");
    expect(request.body).not.toMatch(/!\[x\]\(|@org\/team/);
    expect(request.body).toContain(`<!-- qa-fingerprint: ${result.publicationFingerprint} -->`);
    expect(JSON.stringify(request)).not.toMatch(/SESSION-SECRET|user:secret|token=secret|export function/);
    expect(verifyCodeContext).toHaveBeenCalledWith({ repository: "Owner/Example", revision: "a".repeat(40), files: [{ path: "src/Dashboard.jsx", contentHash: `sha256:${"b".repeat(64)}` }] });
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

  it("rejects PASS publication and invalid transport results", async () => {
    const input = fixture();
    const pass = structuredClone(input.judgeResult);
    pass.verdict = "PASS";
    pass.expectationResults[0].status = "MATCHED";
    const { resultId: _resultId, ...passBody } = pass;
    pass.resultId = `judge-${canonicalHash(passBody).slice("sha256:".length, "sha256:".length + 16)}`;
    const verifyCodeContext = async () => true;
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, judgeResult: pass, verifyCodeContext, transport: vi.fn() })).rejects.toThrow(/only failed/);
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, verifyCodeContext, transport: async () => ({ number: 0, url: "javascript:bad" }) })).rejects.toThrow(/invalid result/);
    await expect(publishGitHubFailureIssue({ repository: "owner/other", ...input, verifyCodeContext, transport: vi.fn() })).rejects.toThrow(/different repository/);
    const invalidJudge = { ...input.judgeResult, resultId: "judge-forged" };
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, judgeResult: invalidJudge, verifyCodeContext, transport: vi.fn() })).rejects.toThrow(/judge artifact identity/);
    const invalidContext = { ...input.codeContext, bundleId: "code-context-forged" };
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, codeContext: invalidContext, verifyCodeContext, transport: vi.fn() })).rejects.toThrow(/code-context artifact identity/);
    const mismatchedContextBody = { ...input.codeContext, candidates: [{ ...input.codeContext.candidates[0], range: { start: { line: 2, column: 1 }, end: { line: 2, column: 40 } } }] };
    const { bundleId: _bundleId, ...mismatchedBody } = mismatchedContextBody;
    const mismatchedContext = { ...mismatchedBody, bundleId: `code-context-${canonicalHash(mismatchedBody).slice("sha256:".length, "sha256:".length + 16)}` };
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, codeContext: mismatchedContext, verifyCodeContext, transport: vi.fn() })).rejects.toThrow(/candidates do not match/);
    const invalidEvidence = { ...input.evidenceBundle, environment: { ...input.evidenceBundle.environment, targetUrl: "https://attacker.test/changed" } };
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, evidenceBundle: invalidEvidence, verifyCodeContext, transport: vi.fn() })).rejects.toThrow(/Evidence Bundle identity/);
    const createIssue = vi.fn();
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, verifyCodeContext: async () => false, transport: createIssue })).rejects.toThrow(/pinned Code Context/);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("propagates provider failures without converting them to a product verdict", async () => {
    const input = fixture();
    await expect(publishGitHubFailureIssue({ repository: "owner/example", ...input, verifyCodeContext: async () => true, transport: async () => { throw new Error("GitHub unavailable"); } })).rejects.toThrow("GitHub unavailable");
  });
});
