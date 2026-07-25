import { describe, expect, it } from "vitest";
import {
  ARTIFACT_VERSION,
  CODE_CONTEXT_VERSION,
  COMPILE_RESULT_VERSION,
  CONTRACT_VIOLATION,
  DETERMINISTIC_EVALUATION_VERSION,
  DIAGNOSTIC_VERSION,
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_MANIFEST_VERSION,
  EXECUTION_PLAN_VERSION,
  FAILURE_DIAGNOSIS_VERSION,
  JUDGE_RESULT_VERSION,
  PROVIDER_CAPABILITIES_VERSION,
  QA_IR_VERSION,
  REPAIR_RECOMMENDATION_VERSION,
  RUNTIME_OUTCOME_VERSION,
  canonicalHash,
  contractViolationOutcome,
  createArtifactEnvelope,
  payloadContentHash,
  validateContract,
} from "../index.mjs";

const policy = {
  navigation: "ALLOWED",
  readDom: true,
  readNetwork: false,
  click: "SAFE_ONLY",
  type: "NON_SECRET",
  upload: false,
  submit: false,
  destructiveMutation: false,
  confirmation: "DENY",
  secrets: "RUNTIME_INJECTED",
};

const provenance = [{ path: "qa/dashboard.yaml", range: { start: { line: 1, column: 1, offset: 0 }, end: { line: 10, column: 1, offset: 120 } }, adapter: { name: "qa-spec-adapter", version: "0.1.0" }, contentHash: canonicalHash({ fixture: "qa/dashboard.yaml" }) }];

function qaIr() {
  return {
    schemaVersion: QA_IR_VERSION,
    id: "qa-ir-dashboard",
    source: { adapter: "qa-spec-adapter", adapterVersion: "0.1.0", uri: "qa/dashboard.yaml", revision: "abc123" },
    suites: [
      {
        id: "suite-dashboard",
        title: "Dashboard",
        tags: ["readonly"],
        provenance,
        scenarios: [
          {
            id: "scenario-dashboard-loads",
            title: "Dashboard loads",
            preconditions: [],
            steps: [
              { id: "navigate", kind: "NAVIGATE", target: { type: "PATH", value: "/dashboard" } },
              { id: "observe", kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT" }] },
              { id: "checkpoint", kind: "CHECKPOINT", checkpointId: "loaded" },
            ],
            expectations: [{ id: "expect-heading", kind: "VISIBLE_TEXT", text: "Dashboard" }],
            policy,
            provenance,
          },
        ],
      },
    ],
  };
}

function evidenceBundle() {
  return {
    schemaVersion: EVIDENCE_BUNDLE_VERSION,
    bundleId: "bundle-1",
    runId: "run-1",
    scenarioId: "scenario-dashboard-loads",
    checkpointId: "loaded",
    capturedAt: "2026-07-25T00:00:00.000Z",
    environment: {
      targetUrl: "https://example.test/dashboard",
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      timezone: "UTC",
    },
    artifacts: [
      {
        id: "artifact-visible-text",
        type: "VISIBLE_TEXT",
        contentType: "text/plain",
        contentHash: canonicalHash({ text: "Dashboard" }),
        size: 9,
        storageRef: "evidence/run-1/visible-text.txt",
      },
    ],
    facts: [{ id: "fact-url", kind: "URL", value: "https://example.test/dashboard" }],
    redaction: { rules: ["secret-redaction/0.1"], replacements: 0 },
  };
}

function judgeResult(overrides = {}) {
  return {
    schemaVersion: JUDGE_RESULT_VERSION,
    resultId: "judge-1",
    qaIrId: "qa-ir-dashboard",
    evidenceBundleId: "bundle-1",
    verdict: "PASS",
    confidence: 0.99,
    expectationResults: [
      {
        expectationId: "expect-heading",
        status: "MATCHED",
        confidence: 0.99,
        evidenceRefs: ["artifact-visible-text"],
        rationale: "Visible text includes Dashboard.",
      },
    ],
    uncertainty: [],
    judge: {
      provider: "hermes",
      model: "judge-model",
      modelVersion: "2026-07-25",
      promptVersion: "judge-prompt/0.1",
    },
    inputHash: canonicalHash({ qaIrId: "qa-ir-dashboard", evidenceBundleId: "bundle-1" }),
    ...overrides,
  };
}

function checkpoint(fields) {
  const body = {
    checkpointId: fields.checkpointId,
    stage: fields.stage,
    evidenceBundleId: fields.evidenceBundleId,
    evidenceBundleHash: fields.evidenceBundleHash ?? canonicalHash({ bundleId: fields.evidenceBundleId }),
    sealed: true,
    producer: { name: "contracts-test", version: "0.1.0" },
  };
  return { ...body, contentHash: canonicalHash(body) };
}

describe("documented runtime contracts", () => {
  it("validates documented core shapes and exact versions", () => {
    const diagnostic = {
      schemaVersion: DIAGNOSTIC_VERSION,
      code: "UNSUPPORTED_SYNTAX",
      severity: "WARNING",
      message: "Unsupported syntax was diagnosed, not ignored.",
    };
    const bundle = evidenceBundle();
    const examples = {
      ArtifactEnvelope: createArtifactEnvelope(qaIr(), {
        artifactId: "artifact-qa-ir",
        createdAt: "2026-07-25T00:00:00.000Z",
        producer: { name: "contracts-test", version: "0.1.0" },
      }),
      QaIrDocument: qaIr(),
      CompileResult: { schemaVersion: COMPILE_RESULT_VERSION, ok: true, qaIr: qaIr(), diagnostics: [diagnostic] },
      Diagnostic: diagnostic,
      ProviderCapabilities: {
        schemaVersion: PROVIDER_CAPABILITIES_VERSION,
        providerId: "local-executor",
        actions: ["NAVIGATE", "OBSERVE"],
        evidence: ["VISIBLE_TEXT"],
        unsupportedEvidence: ["RAW_BROWSER_SESSION_DUMP"],
      },
      ExecutionPlan: {
        schemaVersion: EXECUTION_PLAN_VERSION,
        planId: "plan-1",
        qaIrId: "qa-ir-dashboard",
        nodes: [{ nodeId: "navigate", stepId: "navigate" }, { nodeId: "observe", stepId: "observe" }],
        edges: [{ from: "navigate", to: "observe" }],
        retryPolicy: { maxAttempts: 1 },
        timeoutPolicy: { perNodeMs: 30_000, runMs: 120_000 },
      },
      RuntimeOutcome: { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "ERROR", code: CONTRACT_VIOLATION, message: "invalid judge payload" },
      DeterministicEvaluationResult: {
        schemaVersion: DETERMINISTIC_EVALUATION_VERSION,
        status: "MANUAL_REVIEW",
        resolvedChecks: [{ expectationId: "expect-url", status: "PASS" }],
        unresolvedChecks: [{ expectationId: "expect-heading" }],
      },
      EvidenceBundle: bundle,
      EvidenceManifest: {
        schemaVersion: EVIDENCE_MANIFEST_VERSION,
        runId: "run-1",
        checkpoints: [
          checkpoint({ checkpointId: "loaded", stage: "execute", evidenceBundleId: "bundle-1" }),
          checkpoint({ checkpointId: "observed", stage: "evidence", evidenceBundleId: "bundle-2" }),
        ],
      },
      JudgeResult: judgeResult(),
      FailureDiagnosis: {
        schemaVersion: FAILURE_DIAGNOSIS_VERSION,
        diagnosisId: "diagnosis-1",
        judgeResultId: "judge-1",
        origin: "PRODUCT_CODE",
        confidence: 0.8,
        symptom: "Dashboard heading missing",
        likelyCause: "Heading rendering regressed",
        supportingEvidenceRefs: ["artifact-visible-text"],
        contradictingEvidenceRefs: [],
        remediationEligible: true,
        manualReviewReasons: [],
      },
      CodeContextBundle: {
        schemaVersion: CODE_CONTEXT_VERSION,
        bundleId: "code-context-1",
        repositoryId: "repo-1",
        revision: "abc123",
        failureDiagnosisId: "diagnosis-1",
        candidates: [],
        snippets: [],
        searchAudit: { queries: [], strategies: [] },
      },
      RepairRecommendation: {
        schemaVersion: REPAIR_RECOMMENDATION_VERSION,
        recommendationId: "rec-1",
        diagnosisId: "diagnosis-1",
        repositoryRevision: "abc123",
        title: "Restore dashboard heading",
        severity: "MEDIUM",
        summary: "Visible heading no longer matches expectation.",
        rootCause: "Heading copy changed unexpectedly.",
        confidence: 0.75,
        locations: [],
        changes: [],
        verificationPlan: [],
        evidenceRefs: ["artifact-visible-text"],
        codeContextRefs: ["code-context-1"],
        patchEligibility: "SUGGESTION_ONLY",
      },
    };

    for (const [contract, value] of Object.entries(examples)) {
      expect(validateContract(contract, value)).toBe(value);
    }
  });

  it("hashes ArtifactEnvelope payload only and excludes createdAt from canonical payload identity", () => {
    const payloadA = { id: "qa-ir-dashboard", createdAt: "2026-01-01T00:00:00.000Z", suites: [{ id: "suite" }] };
    const payloadB = { suites: [{ id: "suite" }], id: "qa-ir-dashboard", createdAt: "2026-07-25T00:00:00.000Z" };
    expect(payloadContentHash(payloadA)).toBe(payloadContentHash(payloadB));
    expect(payloadContentHash({ id: "x", nested: { generatedAt: "then", runtimeMetadata: { providerLatencyMs: 99 } } })).toBe(
      payloadContentHash({ id: "x", nested: {} }),
    );
    expect(canonicalHash(JSON.parse('{"__proto__":{"x":1}}'))).not.toBe(canonicalHash({}));

    const envelopeA = createArtifactEnvelope(payloadA, {
      artifactId: "artifact-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { name: "test", version: "0.1" },
    });
    const envelopeB = { ...envelopeA, createdAt: "2026-07-25T00:00:00.000Z", payload: payloadB };
    expect(validateContract("ArtifactEnvelope", envelopeB).contentHash).toBe(envelopeA.contentHash);
  });

  it("rejects wrong versions and missing documented nested structures", () => {
    expect(() => validateContract("ArtifactEnvelope", { artifactVersion: "artifact/9", artifactId: "a", contentHash: "h", createdAt: "t", producer: {}, payload: {} })).toThrow(/artifact\/0.1/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), schemaVersion: "qa-ir/9" })).toThrow(/qa-ir\/0.1/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ id: "suite", title: "Dashboard", tags: [], provenance: [] }] })).toThrow(/scenarios/);
    expect(() => validateContract("ExecutionPlan", { schemaVersion: EXECUTION_PLAN_VERSION, planId: "p", qaIrId: "q", nodes: [], edges: [], retryPolicy: {} })).toThrow(/timeoutPolicy/);
    expect(() => validateContract("EvidenceBundle", { ...evidenceBundle(), environment: { targetUrl: "https://example.test" } })).toThrow(/browser/);
    expect(() => validateContract("EvidenceBundle", { ...evidenceBundle(), facts: [{ id: "fact-bad", kind: "URL" }] })).toThrow(/value/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ ...qaIr().suites[0], scenarios: [{ ...qaIr().suites[0].scenarios[0], steps: [{ id: "bogus", kind: "BOGUS" }] }] }] })).toThrow(/NAVIGATE/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ ...qaIr().suites[0], provenance: [{ path: "qa/dashboard.yaml" }] }] })).toThrow(/range/);
    expect(() => validateContract("JudgeResult", { ...judgeResult(), stage: "judge" })).toThrow(/not allowed/);
  });

  it("rejects lowercase JudgeResult verdicts and invalid PASS/non-skip evidence invariants", () => {
    expect(() => validateContract("JudgeResult", judgeResult({ verdict: "pass" }))).toThrow(/PASS/);
    expect(() => validateContract("JudgeResult", judgeResult({ expectationResults: [{ ...judgeResult().expectationResults[0], status: "CONTRADICTED" }] }))).toThrow(/PASS requires/);
    expect(() => validateContract("JudgeResult", judgeResult({ verdict: "FAIL", expectationResults: [{ ...judgeResult().expectationResults[0], evidenceRefs: [] }] }))).toThrow(/requires evidence/);
  });

  it("validates judge evidence refs against an optional EvidenceBundle context", () => {
    expect(validateContract("JudgeResult", judgeResult(), { evidenceBundle: evidenceBundle() })).toMatchObject({ verdict: "PASS" });
    expect(() =>
      validateContract("JudgeResult", judgeResult({ expectationResults: [{ ...judgeResult().expectationResults[0], evidenceRefs: ["missing"] }] }), {
        evidenceBundle: evidenceBundle(),
      }),
    ).toThrow(/unknown evidence ref/);
    expect(() => validateContract("JudgeResult", judgeResult({ evidenceBundleId: "other-bundle" }), { evidenceBundle: evidenceBundle() })).toThrow(/bundleId/);
  });

  it("maps invalid model output to RuntimeOutcome ERROR/CONTRACT_VIOLATION without fake product failure", () => {
    let error;
    try {
      validateContract("JudgeResult", judgeResult({ verdict: "crashed" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: CONTRACT_VIOLATION, contract: "JudgeResult", path: "$.verdict" });
    expect(error.diagnostic).toMatchObject({ schemaVersion: DIAGNOSTIC_VERSION, code: CONTRACT_VIOLATION, severity: "ERROR" });
    expect(validateContract("RuntimeOutcome", contractViolationOutcome("judge", error))).toMatchObject({
      schemaVersion: RUNTIME_OUTCOME_VERSION,
      stage: "judge",
      type: "ERROR",
      code: CONTRACT_VIOLATION,
    });
    expect(() => validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "ERROR", code: CONTRACT_VIOLATION, message: "bad", verdict: "FAIL" })).toThrow(/not allowed/);
  });


  it("enforces stage-aware RuntimeOutcome and immutable checkpoint manifests", () => {
    expect(() => validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, type: "COMPLETED" })).toThrow(/stage/);
    expect(() => validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED", verdict: "PASS" })).toThrow(/not allowed/);
    expect(() => validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED", code: CONTRACT_VIOLATION })).toThrow(/not allowed/);
    expect(() => validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "ERROR", code: CONTRACT_VIOLATION, message: "bad", judgeResult: {} })).toThrow(/not allowed/);

    const sealedCheckpoint = checkpoint({ checkpointId: "loaded", stage: "evidence", evidenceBundleId: "bundle-1" });
    expect(() => validateContract("EvidenceManifest", { schemaVersion: EVIDENCE_MANIFEST_VERSION, runId: "run-1", checkpoints: [sealedCheckpoint, sealedCheckpoint] })).toThrow(/unique/);
    expect(() => validateContract("EvidenceManifest", { schemaVersion: EVIDENCE_MANIFEST_VERSION, runId: "run-1", checkpoints: [{ ...sealedCheckpoint, contentHash: "" }] })).toThrow(/contentHash/);
    expect(() => validateContract("EvidenceManifest", { schemaVersion: EVIDENCE_MANIFEST_VERSION, runId: "run-1", checkpoints: [{ ...sealedCheckpoint, contentHash: canonicalHash({ wrong: true }) }] })).toThrow(/must equal/);
    expect(() => validateContract("EvidenceManifest", { schemaVersion: EVIDENCE_MANIFEST_VERSION, runId: "run-1", checkpoints: [checkpoint({ checkpointId: "late", stage: "judge", evidenceBundleId: "bundle-1" }), checkpoint({ checkpointId: "early", stage: "execute", evidenceBundleId: "bundle-2" })] })).toThrow(/non-decreasing/);
  });

  it("rejects invalid stable minimal contracts", () => {
    const invalid = {
      CompileResult: { schemaVersion: COMPILE_RESULT_VERSION, ok: false, diagnostics: [] },
      Diagnostic: { schemaVersion: DIAGNOSTIC_VERSION, code: "X", severity: "fatal", message: "bad" },
      ProviderCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "p", actions: [], evidence: [], unsupportedEvidence: [1] },
      DeterministicEvaluationResult: { schemaVersion: DETERMINISTIC_EVALUATION_VERSION, status: "PASS", resolvedChecks: [], unresolvedChecks: "no" },
      EvidenceManifest: { schemaVersion: EVIDENCE_MANIFEST_VERSION, runId: "r", checkpoints: [{ checkpointId: "c", stage: "evidence", evidenceBundleId: "b", sealed: false, contentHash: "h" }] },
      FailureDiagnosis: { schemaVersion: FAILURE_DIAGNOSIS_VERSION, diagnosisId: "d", judgeResultId: "j", origin: "ALIEN", confidence: 0.5, symptom: "s", likelyCause: "l", supportingEvidenceRefs: [], contradictingEvidenceRefs: [], remediationEligible: false, manualReviewReasons: [] },
      CodeContextBundle: { schemaVersion: CODE_CONTEXT_VERSION, bundleId: "b", repositoryId: "r", revision: "rev", failureDiagnosisId: "d", candidates: [], snippets: [] },
      RepairRecommendation: { schemaVersion: REPAIR_RECOMMENDATION_VERSION, recommendationId: "r", diagnosisId: "d", repositoryRevision: "rev", title: "t", severity: "MEDIUM", summary: "s", rootCause: "r", confidence: 1, locations: [], changes: [], verificationPlan: [], evidenceRefs: [], codeContextRefs: [], patchEligibility: "AUTO_PATCH" },
    };
    for (const [contract, value] of Object.entries(invalid)) expect(() => validateContract(contract, value), contract).toThrow();
  });
});
