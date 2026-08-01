import { describe, expect, it, vi } from "vitest";

import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { JUDGE_RESULT_VERSION, PROVIDER_CAPABILITIES_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { reviewJudgment } from "../index.mjs";

describe("independent judgment review", () => {
  it("binds an independent approval to the judgment and sealed evidence", async () => {
    const qaIr = compilePlaywrightSpec({ source: source(), sourcePath: "dashboard.spec.ts" }).qaIr;
    const scenario = qaIr.suites[0].scenarios[0];
    scenario.semantics = { applicability: ["the dashboard route is loaded"], when: ["the dashboard is observed"], claims: ["Welcome Dashboard is visible"], classification: "LIVE_EXECUTABLE" };
    scenario.steps.unshift({ id: "navigate-dashboard", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } });
    const expectation = scenario.expectations[0];
    const store = createInMemoryEvidenceStore({ providerCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "fixture", actions: [], evidence: ["VISIBLE_TEXT"] } });
    const artifact = store.captureArtifact({ id: "visible", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Welcome Dashboard" });
    const bundle = store.createBundle({ runId: "run-1", scenarioId: scenario.id, checkpointId: "final", capturedAt: "2026-07-31T00:00:00.000Z", environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } }, artifacts: [artifact], facts: [] });
    const manifest = store.appendCheckpoint(bundle);
    const body = {
      schemaVersion: JUDGE_RESULT_VERSION,
      qaIrId: qaIr.id,
      evidenceBundleId: bundle.bundleId,
      verdict: "PASS",
      confidence: 0.8,
      expectationResults: [{ expectationId: expectation.id, status: "MATCHED", confidence: 0.8, evidenceRefs: [artifact.id], rationale: "Visible evidence matches." }],
      uncertainty: [],
      judge: { provider: "hermes", model: "judge", promptVersion: "judge/1" },
      inputHash: canonicalHash("judge-input"),
    };
    const judgeResult = { ...body, resultId: `judge-${canonicalHash(body).slice(7, 23)}` };
    const reviewer = vi.fn(async () => ({ status: "APPROVED" }));
    reviewer.identity = { provider: "hermes", model: "reviewer", modelVersion: "1" };
    reviewer.promptVersion = "review/1";

    const result = await reviewJudgment({ qaIr, bundle, manifest, readBlob: store.readBlob, judgeResult, reviewer });

    expect(reviewer).toHaveBeenCalledOnce();
    expect(reviewer.mock.calls[0][0]).toMatchObject({ scenario: { id: scenario.id, requiredPath: "/dashboard", semantics: scenario.semantics }, judgment: { resultId: judgeResult.resultId } });
    expect(validateContract("JudgmentReview", result, { qaIr, judgeResult, evidenceBundle: bundle })).toMatchObject({ status: "APPROVED", reviewer: { model: "reviewer" } });
  });

  it("preserves material review issues instead of promoting the judge verdict", async () => {
    const reviewer = async () => ({ status: "REVISE", issues: ["The cited evidence does not prove the negative claim."] });
    reviewer.identity = { provider: "fixture", model: "reviewer" };
    reviewer.promptVersion = "review/1";
    await expect(reviewFixture(reviewer)).resolves.toMatchObject({ status: "REVISE", issues: ["The cited evidence does not prove the negative claim."] });
  });
});

async function reviewFixture(reviewer) {
  const qaIr = compilePlaywrightSpec({ source: source(), sourcePath: "dashboard.spec.ts" }).qaIr;
  const scenario = qaIr.suites[0].scenarios[0];
  const expectation = scenario.expectations[0];
  const store = createInMemoryEvidenceStore({ providerCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "fixture", actions: [], evidence: ["VISIBLE_TEXT"] } });
  const artifact = store.captureArtifact({ id: "visible", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Welcome Dashboard" });
  const bundle = store.createBundle({ runId: "run-1", scenarioId: scenario.id, checkpointId: "final", capturedAt: "2026-07-31T00:00:00.000Z", environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } }, artifacts: [artifact], facts: [] });
  const manifest = store.appendCheckpoint(bundle);
  const body = { schemaVersion: JUDGE_RESULT_VERSION, qaIrId: qaIr.id, evidenceBundleId: bundle.bundleId, verdict: "PASS", confidence: 0.8, expectationResults: [{ expectationId: expectation.id, status: "MATCHED", confidence: 0.8, evidenceRefs: [artifact.id], rationale: "Visible evidence matches." }], uncertainty: [], judge: { provider: "hermes", model: "judge", promptVersion: "judge/1" }, inputHash: canonicalHash("judge-input") };
  const judgeResult = { ...body, resultId: `judge-${canonicalHash(body).slice(7, 23)}` };
  return reviewJudgment({ qaIr, bundle, manifest, readBlob: store.readBlob, judgeResult, reviewer });
}

function source() {
  return `// @qa-scenario: DASHBOARD_READONLY\n\ntest.describe("dashboard", () => {\n  // @qa-live-policy: readonly\n  test("shows dashboard", async ({ page }) => {\n    await expect(page.getByText("Welcome Dashboard")).toBeVisible();\n  });\n});\n`;
}
