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
  SEMANTIC_JUDGE_DECISION_VERSION,
  SEMANTIC_JUDGE_INPUT_VERSION,
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
              { id: "navigate", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } },
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

function executionPlan() {
  return {
    schemaVersion: EXECUTION_PLAN_VERSION,
    planId: "plan-1",
    qaIrId: "qa-ir-dashboard",
    nodes: [
      { nodeId: "navigate", suiteId: "suite-dashboard", scenarioId: "scenario-dashboard-loads", stepId: "navigate", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", action: "NAVIGATE", evidence: [], policy },
      { nodeId: "observe", suiteId: "suite-dashboard", scenarioId: "scenario-dashboard-loads", stepId: "observe", kind: "OBSERVE", action: "OBSERVE", evidence: ["VISIBLE_TEXT"], policy },
    ],
    edges: [{ from: "navigate", to: "observe" }],
    retryPolicy: { maxAttempts: 1 },
    timeoutPolicy: { perNodeMs: 30_000, runMs: 120_000 },
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


function semanticJudgeInput(overrides = {}) {
  return {
    schemaVersion: SEMANTIC_JUDGE_INPUT_VERSION,
    qaIrId: "qa-ir-dashboard",
    evidenceBundleId: "bundle-1",
    scenario: { id: "scenario-dashboard-loads", title: "Dashboard loads" },
    expectations: [
      {
        id: "expect-heading",
        kind: "VISIBLE_TEXT",
        target: { text: "Dashboard" },
        expected: { kind: "TEXT", value: "Dashboard" },
      },
    ],
    evidence: [
      { id: "artifact-visible-text", kind: "VISIBLE_TEXT", content: "Dashboard", truncated: false },
    ],
    ...overrides,
  };
}

function semanticJudgeDecision(overrides = {}) {
  return {
    schemaVersion: SEMANTIC_JUDGE_DECISION_VERSION,
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
    judge: { provider: "hermes", model: "judge-model", promptVersion: "semantic-judge-prompt/0.1" },
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
  it("requires globally unique QA IR scenario ids", () => {
    const value = qaIr();
    value.suites.push({ ...structuredClone(value.suites[0]), id: "suite-other" });
    expect(() => validateContract("QaIrDocument", value)).toThrow(/scenario ids must be globally unique/);
  });

  it("requires unique step ids within each QA IR scenario", () => {
    const value = qaIr();
    value.suites[0].scenarios[0].steps[1].id = value.suites[0].scenarios[0].steps[0].id;
    expect(() => validateContract("QaIrDocument", value)).toThrow(/step ids must be unique/);
  });

  it("requires a valid milestone class on executable QA steps", () => {
    const missing = qaIr();
    delete missing.suites[0].scenarios[0].steps[0].milestoneClass;
    expect(() => validateContract("QaIrDocument", missing)).toThrow(/milestoneClass/);

    const invalid = qaIr();
    invalid.suites[0].scenarios[0].steps[0].milestoneClass = "OPTIONAL_EXACT_ACTION";
    expect(() => validateContract("QaIrDocument", invalid)).toThrow(/REQUIRED_SEMANTIC_MILESTONE/);

    const weakened = qaIr();
    weakened.suites[0].scenarios[0].steps[0] = {
      id: "click",
      kind: "INTERACT",
      milestoneClass: "OPTIONAL_HINT",
      action: "CLICK",
      target: { testId: "settings" },
    };
    expect(() => validateContract("QaIrDocument", weakened)).toThrow(/REQUIRED_EXACT_ACTION/);
  });

  it("rejects unknown fields inside execution-plan nodes, edges, and policies", () => {
    const node = executionPlan();
    node.nodes[0].injected = true;
    expect(() => validateContract("ExecutionPlan", node)).toThrow(/injected/);

    const edge = executionPlan();
    edge.edges[0].injected = true;
    expect(() => validateContract("ExecutionPlan", edge)).toThrow(/injected/);

    const retry = executionPlan();
    retry.retryPolicy.extra = true;
    expect(() => validateContract("ExecutionPlan", retry)).toThrow(/extra/);
  });

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
      ExecutionPlan: executionPlan(),
      RuntimeOutcome: { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "ERROR", code: CONTRACT_VIOLATION, message: "invalid judge payload" },
      DeterministicEvaluationResult: {
        schemaVersion: DETERMINISTIC_EVALUATION_VERSION,
        status: "MANUAL_REVIEW",
        resolvedChecks: [{ expectationId: "expect-url", status: "MATCHED", evidenceRefs: ["fact-url"], rationale: "URL fact is deterministic evidence." }],
        unresolvedChecks: [{ expectationId: "expect-heading", reason: "visible text requires semantic judgment" }],
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
      SemanticJudgeInput: semanticJudgeInput(),
      SemanticJudgeDecision: semanticJudgeDecision(),
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
    expect(() => validateContract("QaIrDocument", { ...qaIr(), schemaVersion: "qa-ir/9" })).toThrow(/qa-ir\/0.2/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ id: "suite", title: "Dashboard", tags: [], provenance: [] }] })).toThrow(/scenarios/);
    expect(() => validateContract("ExecutionPlan", { schemaVersion: EXECUTION_PLAN_VERSION, planId: "p", qaIrId: "q", nodes: [], edges: [], retryPolicy: { maxAttempts: 1 } })).toThrow(/timeoutPolicy/);
    expect(() => validateContract("EvidenceBundle", { ...evidenceBundle(), environment: { targetUrl: "https://example.test" } })).toThrow(/browser/);
    expect(() => validateContract("EvidenceBundle", { ...evidenceBundle(), facts: [{ id: "fact-bad", kind: "URL" }] })).toThrow(/value/);
    expect(() => validateContract("EvidenceBundle", { ...evidenceBundle(), facts: [{ id: "fact-element", kind: "ELEMENT_OBSERVATION", value: { expectationId: "expect-heading", visible: true } }] })).toThrow(/resolution/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ ...qaIr().suites[0], scenarios: [{ ...qaIr().suites[0].scenarios[0], steps: [{ id: "bogus", kind: "BOGUS" }] }] }] })).toThrow(/NAVIGATE/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ ...qaIr().suites[0], scenarios: [{ ...qaIr().suites[0].scenarios[0], steps: [{ id: "observe", kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT", selector: "body" }] }] }] }] })).toThrow(/selector/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ ...qaIr().suites[0], scenarios: [{ ...qaIr().suites[0].scenarios[0], steps: [{ id: "observe", kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT" }, { type: "VISIBLE_TEXT" }] }] }] }] })).toThrow(/unique/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ ...qaIr().suites[0], scenarios: [{ ...qaIr().suites[0].scenarios[0], expectations: [qaIr().suites[0].scenarios[0].expectations[0], qaIr().suites[0].scenarios[0].expectations[0]] }] }] })).toThrow(/unique/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ ...qaIr().suites[0], scenarios: [{ ...qaIr().suites[0].scenarios[0], expectations: [{ id: "bad", kind: "BOGUS", garbage: true }] }] }] })).toThrow(/garbage|BOGUS/);
    expect(() => validateContract("QaIrDocument", { ...qaIr(), suites: [{ ...qaIr().suites[0], provenance: [{ path: "qa/dashboard.yaml" }] }] })).toThrow(/range/);
    expect(() => validateContract("JudgeResult", { ...judgeResult(), stage: "judge" })).toThrow(/not allowed/);
  });

  it("rejects lowercase JudgeResult verdicts and invalid PASS/non-skip evidence invariants", () => {
    expect(() => validateContract("JudgeResult", judgeResult({ verdict: "pass" }))).toThrow(/PASS/);
    expect(() => validateContract("JudgeResult", judgeResult({ expectationResults: [{ ...judgeResult().expectationResults[0], status: "CONTRADICTED" }] }))).toThrow(/PASS requires/);
    expect(() => validateContract("JudgeResult", judgeResult({ verdict: "FAIL", expectationResults: [{ ...judgeResult().expectationResults[0], evidenceRefs: [] }] }))).toThrow(/evidenceRefs/);
  });

  it("validates judge evidence refs against an optional EvidenceBundle context", () => {
    expect(validateContract("JudgeResult", judgeResult(), { qaIr: qaIr(), evidenceBundle: evidenceBundle() })).toMatchObject({ verdict: "PASS" });
    expect(() =>
      validateContract("JudgeResult", judgeResult({ expectationResults: [{ ...judgeResult().expectationResults[0], evidenceRefs: ["missing"] }] }), {
        evidenceBundle: evidenceBundle(),
      }),
    ).toThrow(/unknown evidence ref/);
    expect(() => validateContract("JudgeResult", judgeResult({ evidenceBundleId: "other-bundle" }), { evidenceBundle: evidenceBundle() })).toThrow(/bundleId/);
    expect(() => validateContract("JudgeResult", judgeResult({ expectationResults: [] }), { qaIr: qaIr(), evidenceBundle: evidenceBundle() })).toThrow(/every scenario expectation/);
    expect(() => validateContract("JudgeResult", judgeResult({ expectationResults: [judgeResult().expectationResults[0], judgeResult().expectationResults[0]] }), { qaIr: qaIr(), evidenceBundle: evidenceBundle() })).toThrow(/unique/);
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

  it("rejects DeterministicEvaluationResult drift", () => {
    const result = {
      schemaVersion: DETERMINISTIC_EVALUATION_VERSION,
      status: "MANUAL_REVIEW",
      resolvedChecks: [{ expectationId: "expect-url", status: "MATCHED", evidenceRefs: ["fact-url"], rationale: "URL fact is deterministic evidence." }],
      unresolvedChecks: [{ expectationId: "expect-heading", reason: "visible text requires semantic judgment" }],
    };

    expect(() => validateContract("DeterministicEvaluationResult", {
      ...result,
      resolvedChecks: [{ ...result.resolvedChecks[0], status: "PASS" }],
    })).toThrow(/MATCHED/);
    expect(() => validateContract("DeterministicEvaluationResult", {
      ...result,
      resolvedChecks: [{ ...result.resolvedChecks[0], evidenceRefs: [] }],
    })).toThrow(/require evidence/);
    expect(() => validateContract("DeterministicEvaluationResult", {
      ...result,
      unresolvedChecks: [{ expectationId: "expect-url", reason: "duplicate" }],
    })).toThrow(/unique/);
    expect(() => validateContract("DeterministicEvaluationResult", { ...result, status: "PASS" })).toThrow(/must equal/);
  });

  it("rejects SemanticJudgeInput and SemanticJudgeDecision drift", () => {
    const input = semanticJudgeInput();
    const decision = semanticJudgeDecision();

    expect(validateContract("SemanticJudgeInput", input)).toMatchObject({ schemaVersion: SEMANTIC_JUDGE_INPUT_VERSION });
    expect(validateContract("SemanticJudgeDecision", decision, { semanticJudgeInput: input })).toMatchObject({ schemaVersion: SEMANTIC_JUDGE_DECISION_VERSION });
    expect(() => validateContract("SemanticJudgeInput", { ...input, prompt: "leak" })).toThrow(/not allowed/);
    expect(() => validateContract("SemanticJudgeInput", {
      ...input,
      expectations: [...input.expectations, { ...input.expectations[0] }],
    })).toThrow(/unique/);
    expect(() => validateContract("SemanticJudgeDecision", {
      ...decision,
      expectationResults: [{ ...decision.expectationResults[0], evidenceRefs: ["missing"] }],
    }, { semanticJudgeInput: input })).toThrow(/unknown evidence ref missing/);
    expect(() => validateContract("SemanticJudgeDecision", {
      ...decision,
      expectationResults: [{ ...decision.expectationResults[0], expectationId: "missing" }],
    }, { semanticJudgeInput: input })).toThrow(/unknown expectation missing/);
    expect(() => validateContract("SemanticJudgeDecision", {
      ...decision,
      expectationResults: [{ ...decision.expectationResults[0], verdict: "PASS" }],
    }, { semanticJudgeInput: input })).toThrow(/not allowed/);
    expect(() => validateContract("SemanticJudgeDecision", {
      ...decision,
      expectationResults: [{ ...decision.expectationResults[0], confidence: -1 }],
    }, { semanticJudgeInput: input })).toThrow(/between 0 and 1/);
  });

  it("rejects ambiguous evidence ids and out-of-range judge confidence", () => {
    const bundle = evidenceBundle();
    bundle.facts[0].id = bundle.artifacts[0].id;
    expect(() => validateContract("EvidenceBundle", bundle)).toThrow(/globally unique/);
    expect(() => validateContract("JudgeResult", judgeResult({ confidence: 2 }))).toThrow(/between 0 and 1/);
    expect(() => validateContract("JudgeResult", judgeResult({
      expectationResults: [{ ...judgeResult().expectationResults[0], confidence: -1 }],
    }))).toThrow(/between 0 and 1/);
  });

  it("enforces evidence-linked remediation and safe repository context", () => {
    const diagnosis = {
      schemaVersion: FAILURE_DIAGNOSIS_VERSION,
      diagnosisId: "diagnosis-1",
      judgeResultId: "judge-1",
      origin: "PRODUCT_CODE",
      confidence: 0.7,
      symptom: "Heading missing",
      likelyCause: "Rendering changed",
      supportingEvidenceRefs: ["artifact-visible-text"],
      contradictingEvidenceRefs: [],
      remediationEligible: true,
      manualReviewReasons: [],
    };
    expect(() => validateContract("FailureDiagnosis", { ...diagnosis, confidence: 2 })).toThrow(/between 0 and 1/);
    expect(() => validateContract("FailureDiagnosis", {
      ...diagnosis,
      origin: "UNKNOWN",
      remediationEligible: false,
      manualReviewReasons: [],
    })).toThrow(/manual review/);
    expect(() => validateContract("FailureDiagnosis", {
      ...diagnosis,
      supportingEvidenceRefs: ["invented"],
    }, { judgeResult: judgeResult(), evidenceBundle: evidenceBundle() })).toThrow(/unknown evidence ref/);

    const context = {
      schemaVersion: CODE_CONTEXT_VERSION,
      bundleId: "context-1",
      repositoryId: "repo-1",
      revision: "abc123",
      failureDiagnosisId: "diagnosis-1",
      candidates: [{
        path: "src/Dashboard.tsx",
        range: { start: { line: 3, column: 1 }, end: { line: 5, column: 2 } },
        relevanceScore: 0.9,
        matchReasons: ["TEST_ID_MATCH"],
      }],
      snippets: [{
        path: "src/Dashboard.tsx",
        range: { start: { line: 3, column: 1 }, end: { line: 5, column: 2 } },
        text: "Dashboard",
        contentHash: `sha256:${"a".repeat(64)}`,
      }],
      searchAudit: { queries: [{ term: "dashboard", reason: "TEST_ID_MATCH" }], strategies: ["GIT_GREP_FIXED_STRING"] },
    };
    expect(validateContract("CodeContextBundle", context)).toBe(context);
    expect(() => validateContract("CodeContextBundle", {
      ...context,
      candidates: [{ ...context.candidates[0], path: "../.env" }],
    })).toThrow(/safe repository-relative path/);
    expect(() => validateContract("CodeContextBundle", {
      ...context,
      candidates: [{ ...context.candidates[0], relevanceScore: -1 }],
    })).toThrow(/between 0 and 1/);
    expect(() => validateContract("CodeContextBundle", {
      ...context,
      snippets: [{ ...context.snippets[0], text: "x".repeat(32_769) }],
    })).toThrow(/at most 32768 characters/);

    const recommendation = {
      schemaVersion: REPAIR_RECOMMENDATION_VERSION,
      recommendationId: "recommendation-1",
      diagnosisId: "diagnosis-1",
      repositoryRevision: "abc123",
      title: "Review dashboard",
      severity: "MEDIUM",
      summary: "Heading missing",
      rootCause: "Rendering changed",
      confidence: 0.7,
      locations: [{ path: "src/Dashboard.tsx", range: context.candidates[0].range, reason: "TEST_ID_MATCH" }],
      changes: [{ path: "src/Dashboard.tsx", recommendation: "Restore heading", expectedEffect: "Heading is visible", risks: ["Copy may be intentional"] }],
      verificationPlan: [{ command: "npm test", purpose: "Run regressions" }],
      evidenceRefs: ["artifact-visible-text"],
      codeContextRefs: ["context-1"],
      patchEligibility: "SUGGESTION_ONLY",
    };
    expect(validateContract("RepairRecommendation", recommendation, { diagnosis, codeContext: context })).toBe(recommendation);
    expect(() => validateContract("RepairRecommendation", { ...recommendation, confidence: Infinity })).toThrow(/between 0 and 1/);
    expect(() => validateContract("RepairRecommendation", { ...recommendation, patchEligibility: "PATCH_ALLOWED" })).toThrow(/verified patch gate/);
    const manualDiagnosis = {
      ...diagnosis,
      origin: "UNKNOWN",
      remediationEligible: false,
      manualReviewReasons: ["Owner is unknown"],
    };
    expect(() => validateContract("RepairRecommendation", recommendation, {
      diagnosis: manualDiagnosis,
      codeContext: context,
    })).toThrow(/ineligible diagnoses require manual review/);
  });

});
