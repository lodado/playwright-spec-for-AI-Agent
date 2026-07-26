import { describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CAPABILITIES_VERSION,
  QA_IR_VERSION,
  SEMANTIC_JUDGE_DECISION_VERSION,
  validateContract,
} from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import {
  buildSemanticJudgeInput,
  evaluateDeterministically,
  judgeEvidence,
} from "../index.mjs";

const policy = {
  navigation: "ALLOWED",
  readDom: true,
  readNetwork: false,
  click: "NONE",
  type: "NONE",
  upload: false,
  submit: false,
  destructiveMutation: false,
  confirmation: "DENY",
  secrets: "RUNTIME_INJECTED",
};
const provenance = [{
  path: "dashboard.spec.ts",
  range: {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 10, column: 1, offset: 100 },
  },
  adapter: { name: "adapter-playwright", version: "0.1.0" },
  contentHash: "sha256:source",
}];

function qaIr({ semantic = true } = {}) {
  const expectations = [
    { id: "url", kind: "URL", expected: { kind: "literal", value: "/dashboard" } },
    { id: "text", kind: "CONTAINS_TEXT", target: { testId: "heading" }, expected: { kind: "literal", value: "Dashboard" } },
    { id: "visible", kind: "VISIBLE", target: { testId: "heading" } },
    { id: "role", kind: "ROLE", target: { role: "button" }, expected: { kind: "literal", value: "button" } },
    { id: "name", kind: "NAME", target: { accessibleName: { kind: "literal", value: "Save" } }, expected: { kind: "literal", value: "Save" } },
    { id: "attribute", kind: "ATTRIBUTE", target: { testId: "status" }, attribute: "data-state", expected: { kind: "literal", value: "ready" } },
    ...(semantic ? [{ id: "visual", kind: "VISUAL_CONSISTENCY", expected: { kind: "literal", value: "balanced layout client_secret=qa-secret" } }] : []),
  ];
  return {
    schemaVersion: QA_IR_VERSION,
    id: "qa-ir-dashboard",
    source: { adapter: "adapter-playwright", adapterVersion: "0.1.0", uri: "secret/repository/path.spec.ts" },
    suites: [{
      id: "suite-dashboard",
      title: "Dashboard",
      tags: ["readonly"],
      provenance,
      scenarios: [{
        id: "scenario-dashboard",
        title: "Dashboard loads",
        preconditions: [],
        steps: [{ id: "checkpoint", kind: "CHECKPOINT", checkpointId: "loaded" }],
        expectations,
        policy,
        provenance,
      }],
    }],
  };
}

function fixture(options = {}) {
  const target = createInMemoryEvidenceStore({
    providerCapabilities: {
      schemaVersion: PROVIDER_CAPABILITIES_VERSION,
      providerId: "fixture-provider",
      actions: [],
      evidence: ["VISIBLE_TEXT"],
    },
    secrets: ["stored-secret"],
  });
  const artifact = target.captureArtifact({
    id: "visible-text",
    type: "VISIBLE_TEXT",
    contentType: "text/plain",
    content: "Dashboard Save balanced layout stored-secret",
  });
  const facts = [
    { id: "fact-url", kind: "URL", value: options.url ?? "https://example.test/dashboard" },
    observation("text", options.omitText ? {} : { text: options.text ?? "Dashboard overview" }),
    ...(options.duplicateText ? [{ ...observation("text-copy", { text: "Dashboard overview" }), value: { expectationId: "text", resolution: "FOUND", text: "Dashboard overview", textTruncated: false } }] : []),
    observation("visible", options.omitVisible ? {} : { visible: true }),
    observation("role", { role: "button" }),
    observation("name", { accessibleName: "Save" }),
    observation("attribute", { attributes: { "data-state": "ready" } }),
    { id: "fact-generic", kind: "PAGE_CONTEXT", value: { apiToken: "derived-token", note: "semantic evidence" } },
  ];
  const bundle = target.createBundle({
    runId: "run-judge",
    scenarioId: "scenario-dashboard",
    checkpointId: "loaded",
    capturedAt: "2026-07-25T00:00:00.000Z",
    environment: {
      targetUrl: "https://user:environment-secret@example.test/dashboard",
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
    },
    artifacts: [artifact],
    facts,
  });
  const manifest = target.appendCheckpoint(bundle);
  return {
    artifact,
    bundle,
    manifest,
    readBlob: target.readBlob,
  };
}

function observation(expectationId, value) {
  return {
    id: `fact-${expectationId}`,
    kind: "ELEMENT_OBSERVATION",
    value: { expectationId, resolution: "FOUND", ...value, ...(value.text === undefined ? {} : { textTruncated: false }) },
  };
}

function semanticDecision(input, overrides = {}) {
  return {
    schemaVersion: SEMANTIC_JUDGE_DECISION_VERSION,
    expectationResults: input.expectations.map((expectation) => ({
      expectationId: expectation.id,
      status: "MATCHED",
      confidence: 0.8,
      evidenceRefs: [input.evidence[0].id],
      rationale: "Evidence supports the semantic expectation.",
    })),
    uncertainty: [],
    judge: {
      provider: "fake",
      model: "fake-model",
      modelVersion: "1",
      promptVersion: "fake-prompt/0.1",
    },
    ...overrides,
  };
}

describe("deterministic evidence evaluation", () => {
  it("resolves literal URL, text, visibility, role, name, and attribute checks", () => {
    const evidence = fixture();
    const evaluation = evaluateDeterministically({ qaIr: qaIr(), ...evidence });

    expect(validateContract("DeterministicEvaluationResult", evaluation)).toBe(evaluation);
    expect(evaluation.status).toBe("MANUAL_REVIEW");
    expect(evaluation.resolvedChecks.map((item) => [item.expectationId, item.status])).toEqual([
      ["url", "MATCHED"],
      ["text", "MATCHED"],
      ["visible", "MATCHED"],
      ["role", "MATCHED"],
      ["name", "MATCHED"],
      ["attribute", "MATCHED"],
    ]);
    expect(evaluation.unresolvedChecks).toEqual([{
      expectationId: "visual",
      reason: "No structured element observation was captured",
    }]);
  });

  it("reports stable URL contradictions without model reasoning", () => {
    const evidence = fixture({ url: "https://example.test/billing" });
    const evaluation = evaluateDeterministically({ qaIr: qaIr({ semantic: false }), ...evidence });
    expect(evaluation.status).toBe("FAIL");
    expect(evaluation.resolvedChecks.find((item) => item.expectationId === "url")).toMatchObject({
      status: "CONTRADICTED",
      evidenceRefs: ["fact-url"],
    });
  });

  it("keeps exact relative URLs and missing observation fields out of false contradictions", () => {
    const evidence = fixture({ url: "/dashboard", omitText: true, omitVisible: true });
    const evaluation = evaluateDeterministically({ qaIr: qaIr({ semantic: false }), ...evidence });

    expect(evaluation.resolvedChecks.find((item) => item.expectationId === "url")?.status).toBe("MATCHED");
    expect(evaluation.unresolvedChecks.map((item) => item.expectationId)).toEqual(["text", "visible"]);
    expect(evaluation.status).toBe("MANUAL_REVIEW");
  });

  it("keeps duplicate observations unresolved instead of trusting the first fact", () => {
    const evidence = fixture({ duplicateText: true });
    const evaluation = evaluateDeterministically({ qaIr: qaIr({ semantic: false }), ...evidence });

    expect(evaluation.unresolvedChecks.map(item => item.expectationId)).toContain("text");
    expect(evaluation.resolvedChecks.some(item => item.expectationId === "text")).toBe(false);
  });
});

describe("offline judge runtime", () => {
  it("builds a bounded allowlisted payload containing only unresolved expectations", () => {
    const evidence = fixture();
    const evaluation = evaluateDeterministically({ qaIr: qaIr(), ...evidence });
    const input = buildSemanticJudgeInput({
      qaIr: qaIr(),
      ...evidence,
      evaluation,
      secrets: ["prompt-secret"],
    });
    const serialized = JSON.stringify(input);

    expect(validateContract("SemanticJudgeInput", input)).toBe(input);
    expect(input.expectations.map((item) => item.id)).toEqual(["visual"]);
    expect(serialized).not.toContain("secret/repository");
    expect(serialized).not.toContain("environment-secret");
    expect(serialized).not.toContain("derived-token");
    expect(serialized).not.toContain("qa-secret");
    expect(serialized).not.toContain("storageRef");
    expect(serialized).not.toContain('"policy"');
    expect(Object.isFrozen(input)).toBe(true);
  });

  it("bypasses the model when every expectation is deterministic", async () => {
    const evidence = fixture();
    const semanticJudge = vi.fn();
    const result = await judgeEvidence({
      qaIr: qaIr({ semantic: false }),
      ...evidence,
      semanticJudge,
    });

    expect(validateContract("JudgeResult", result, { evidenceBundle: evidence.bundle })).toBe(result);
    expect(result.verdict).toBe("PASS");
    expect(result.judge.provider).toBe("deterministic");
    expect(semanticJudge).not.toHaveBeenCalled();
  });

  it("routes only unresolved checks and produces stable offline judgments", async () => {
    const evidence = fixture();
    const semanticJudge = vi.fn(async (input) => semanticDecision(input));
    const args = { qaIr: qaIr(), ...evidence, semanticJudge };
    const first = await judgeEvidence(args);
    const second = await judgeEvidence(args);

    expect(first.verdict).toBe("PASS");
    expect(first.expectationResults).toHaveLength(7);
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.resultId).toBe(second.resultId);
    expect(semanticJudge).toHaveBeenCalledTimes(2);
    expect(semanticJudge.mock.calls[0][0].expectations.map((item) => item.id)).toEqual(["visual"]);
  });

  it("keeps model/provider failures separate from product verdicts", async () => {
    const evidence = fixture();
    const providerFailure = await judgeEvidence({
      qaIr: qaIr(),
      ...evidence,
      semanticJudge: async () => {
        throw new Error("Bearer provider-secret");
      },
    });
    expect(providerFailure).toEqual({
      schemaVersion: "runtime-outcome/0.1",
      stage: "judge",
      type: "ERROR",
      code: "MODEL_PROVIDER_FAILED",
      message: "Semantic judge provider failed",
    });
    expect(JSON.stringify(providerFailure)).not.toContain("provider-secret");

    const invalidReference = await judgeEvidence({
      qaIr: qaIr(),
      ...evidence,
      semanticJudge: async (input) => semanticDecision(input, {
        expectationResults: [{
          expectationId: "visual",
          status: "CONTRADICTED",
          confidence: 1,
          evidenceRefs: ["invented"],
          rationale: "Invented evidence.",
        }],
      }),
    });
    expect(invalidReference).toMatchObject({ type: "ERROR", code: "MODEL_PROVIDER_FAILED" });
  });

  it("redacts credentials returned by the semantic model", async () => {
    const evidence = fixture();
    const secrets = ["QUASAR-CREDENTIAL-9Z"];
    const result = await judgeEvidence({
      qaIr: qaIr(),
      ...evidence,
      secrets,
      semanticJudge: async (input) => {
        secrets.length = 0;
        return semanticDecision(input, {
          expectationResults: semanticDecision(input).expectationResults.map((item) => ({
            ...item,
            rationale: "Cookie = SID=MODEL-COOKIE QUASAR-CREDENTIAL-9Z",
          })),
          uncertainty: [{ code: "AUTH", description: "Authorization = Basic MODEL-AUTH" }],
        });
      },
    });

    expect(result.verdict).toBe("PASS");
    expect(JSON.stringify(result)).not.toContain("MODEL-COOKIE");
    expect(JSON.stringify(result)).not.toContain("MODEL-AUTH");
    expect(JSON.stringify(result)).not.toContain("QUASAR-CREDENTIAL-9Z");
  });

  it("rejects oversized semantic input before calling a model", async () => {
    const evidence = fixture();
    const oversized = qaIr();
    oversized.suites[0].scenarios[0].title = "x".repeat(70_000);
    const semanticJudge = vi.fn();
    const result = await judgeEvidence({ qaIr: oversized, ...evidence, semanticJudge });

    expect(result).toMatchObject({ type: "ERROR", code: "CONTRACT_VIOLATION" });
    expect(semanticJudge).not.toHaveBeenCalled();
  });

  it("snapshots mutable QA IR input once before validation and judgment", async () => {
    const evidence = fixture();
    const mutable = qaIr({ semantic: false });
    let reads = 0;
    Object.defineProperty(mutable, "id", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "qa-ir-dashboard" : "tampered";
      },
    });

    const result = await judgeEvidence({ qaIr: mutable, ...evidence });
    expect(result.qaIrId).toBe("qa-ir-dashboard");
    expect(reads).toBe(1);
  });

  it("rejects tampered stored evidence before any model call", async () => {
    const evidence = fixture();
    const tampered = structuredClone(evidence.bundle);
    tampered.facts[0].value = "https://attacker.test";
    const semanticJudge = vi.fn();
    const result = await judgeEvidence({
      qaIr: qaIr(),
      ...evidence,
      bundle: tampered,
      semanticJudge,
    });
    expect(result).toMatchObject({ type: "ERROR", code: "EVIDENCE_STORAGE_FAILED" });
    expect(semanticJudge).not.toHaveBeenCalled();
  });
});
