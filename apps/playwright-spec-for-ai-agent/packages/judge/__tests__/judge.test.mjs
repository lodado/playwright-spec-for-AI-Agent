import { describe, expect, it, vi } from "vitest";

import { compilePlaywrightSpec } from "../../__tests__/fixtures/compile-playwright-spec.mjs";
import { PROVIDER_CAPABILITIES_VERSION, SEMANTIC_JUDGE_DECISION_VERSION } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { judgeEvidence } from "../index.mjs";

describe("AI-native evidence judge", () => {
  it("routes even simple expectations through the independent semantic judge", async () => {
    const fixture = evidenceFixture();
    const semanticJudge = vi.fn(async input => decision(input, fixture.artifact.id));

    await expect(judgeEvidence({ ...fixture, semanticJudge })).resolves.toMatchObject({ verdict: "PASS", judge: { provider: "fixture-ai" } });

    expect(semanticJudge).toHaveBeenCalledOnce();
    expect(semanticJudge.mock.calls[0][0].evidence).toEqual(expect.arrayContaining([expect.objectContaining({ id: fixture.artifact.id })]));
  });

  it("rejects model citations that are not present in the sealed evidence", async () => {
    const fixture = evidenceFixture();
    const semanticJudge = vi.fn(async input => decision(input, "invented-evidence"));

    await expect(judgeEvidence({ ...fixture, semanticJudge })).resolves.toMatchObject({ stage: "judge", type: "ERROR", code: "MODEL_PROVIDER_FAILED" });
    expect(semanticJudge).toHaveBeenCalledTimes(2);
  });

  it("does not call AI when stored evidence cannot be verified", async () => {
    const fixture = evidenceFixture();
    const semanticJudge = vi.fn();
    const tampered = structuredClone(fixture.bundle);
    tampered.environment.targetUrl = "https://attacker.test";

    await expect(judgeEvidence({ ...fixture, bundle: tampered, semanticJudge })).resolves.toMatchObject({ stage: "judge", type: "ERROR", code: "EVIDENCE_STORAGE_FAILED" });
    expect(semanticJudge).not.toHaveBeenCalled();
  });
});

function evidenceFixture() {
  const qaIr = compilePlaywrightSpec({
    source: `// @qa-scenario: GENERIC\n// @qa-live-policy: readonly\ntest("shows items", async ({ page }) => { await expect(page.getByText("Items")).toBeVisible(); });`,
    sourcePath: "items.spec.ts",
  }).qaIr;
  const scenario = qaIr.suites[0].scenarios[0];
  const store = createInMemoryEvidenceStore({ providerCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "fixture", actions: [], evidence: ["VISIBLE_TEXT"] } });
  const artifact = store.captureArtifact({ id: "visible", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Items" });
  const bundle = store.createBundle({
    runId: "run-1",
    scenarioId: scenario.id,
    checkpointId: "final",
    capturedAt: "2026-08-02T00:00:00.000Z",
    environment: { targetUrl: "https://example.test/items", browser: "chromium", viewport: { width: 1280, height: 720 } },
    artifacts: [artifact],
    facts: [],
  });
  const manifest = store.appendCheckpoint(bundle);
  return { qaIr, bundle, manifest, readBlob: store.readBlob, artifact };
}

function decision(input, evidenceRef) {
  return {
    schemaVersion: SEMANTIC_JUDGE_DECISION_VERSION,
    expectationResults: input.expectations.map(expectation => ({ expectationId: expectation.id, status: "MATCHED", confidence: 0.9, evidenceRefs: [evidenceRef], rationale: "The sealed visible text supports the expectation." })),
    uncertainty: [],
    judge: { provider: "fixture-ai", model: "judge", promptVersion: "judge/3" },
  };
}
