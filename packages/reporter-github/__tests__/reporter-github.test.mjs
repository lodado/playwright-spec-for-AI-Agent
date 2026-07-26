import { describe, expect, it, vi } from "vitest";
import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { CODE_CONTEXT_VERSION, JUDGE_RESULT_VERSION, PROVIDER_CAPABILITIES_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { diagnoseFailure } from "../../remediation/index.mjs";
import { publishGitHubFailureIssue } from "../index.mjs";

function fixture() {
  const qaIr = compilePlaywrightSpec({ source: `// @qa-scenario: DASHBOARD_READONLY\ntest.describe("dashboard", () => {\n  // @qa-live-policy: readonly\n  test("shows dashboard", async ({ page }) => {\n    await expect(page.getByText("Welcome Dashboard")).toBeVisible();\n  });\n});`, sourcePath: "dashboard.spec.ts" }).qaIr;
  const scenario = qaIr.suites[0].scenarios[0];
  const expectation = scenario.expectations[0];
  const store = createInMemoryEvidenceStore({ providerCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "fixture", actions: [], evidence: ["VISIBLE_TEXT"] } });
  const artifact = store.captureArtifact({ id: "visible-text", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Dashboard unavailable" });
  const evidenceBundle = store.createBundle({ runId: "run-1", scenarioId: scenario.id, checkpointId: "final", capturedAt: "2026-07-26T00:00:00.000Z", environment: { targetUrl: "https://user:secret@example.test/dashboard?token=secret", browser: "chromium", viewport: { width: 1280, height: 720 } }, artifacts: [artifact], facts: [] });
  const judgeBody = {
    schemaVersion: JUDGE_RESULT_VERSION,
    qaIrId: qaIr.id,
    evidenceBundleId: evidenceBundle.bundleId,
    verdict: "FAIL",
    confidence: 0.82,
    expectationResults: [{ expectationId: expectation.id, status: "CONTRADICTED", confidence: 0.82, evidenceRefs: [artifact.id], rationale: "Expected dashboard copy is missing. SESSION-SECRET ![x](https://attacker.test) @org/team" }],
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

    expect(validateContract("GitHubPublicationResult", result)).toMatchObject({ action: "CREATED", issue: { number: 42 }, publicationFingerprint: "UNASSIGNED" });
    const request = transport.mock.calls[0][0];
    expect(request.labels).toEqual(expect.arrayContaining(["qa-runtime", "auto-generated", "origin:product-code"]));
    expect(request.title).toMatch(/^\[QA\]/);
    expect(request.body).toContain("src/Dashboard.jsx:1-1");
    expect(request.body).toContain("visible-text");
    expect(request.body).toContain("Final safe URL: `/dashboard`");
    expect(request.body).not.toContain("example.test");
    expect(request.body).toContain("qa-native replay --run-dir=.qa/runs/run-1");
    expect(request.body).not.toMatch(/!\[x\]\(|@org\/team/);
    expect(JSON.stringify(request)).not.toMatch(/SESSION-SECRET|user:secret|token=secret|export function/);
    expect(verifyCodeContext).toHaveBeenCalledWith({ repository: "Owner/Example", revision: "a".repeat(40), files: [{ path: "src/Dashboard.jsx", contentHash: `sha256:${"b".repeat(64)}` }] });
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
