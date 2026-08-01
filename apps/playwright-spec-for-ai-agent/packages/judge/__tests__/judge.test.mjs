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

function qaIr({ semantic = true, semanticJudgment = false } = {}) {
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
    ...(semanticJudgment ? { extensions: { semanticJudgmentScenarioIds: ["scenario-dashboard"] } } : {}),
  };
}

function fixture(options = {}) {
  const target = createInMemoryEvidenceStore({
    providerCapabilities: {
      schemaVersion: PROVIDER_CAPABILITIES_VERSION,
      providerId: "fixture-provider",
      actions: [],
      evidence: ["VISIBLE_TEXT", ...(options.actionLog ? ["ACTION_LOG"] : [])],
    },
    secrets: ["stored-secret"],
  });
  const artifact = target.captureArtifact({
    id: "visible-text",
    type: "VISIBLE_TEXT",
    contentType: "text/plain",
    content: options.artifactContent ?? "Dashboard Save balanced layout stored-secret",
  });
  const artifacts = [artifact];
  if (options.actionLog) {
    artifacts.push(target.captureArtifact({
      id: "action-log",
      type: "ACTION_LOG",
      contentType: "application/json",
      content: JSON.stringify(options.actionLog),
    }));
  }
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
    artifacts,
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

describe("semantic-judgment routing", () => {
  it("includes first-class semantics and the required path in the judge input", () => {
    const evidence = fixture({ url: "https://example.test/login" });
    const ir = qaIr({ semantic: false });
    const scenario = ir.suites[0].scenarios[0];
    scenario.semantics = {
      applicability: ["the user is signed in"],
      when: ["the dashboard is observed"],
      claims: ["Dashboard is visible"],
      classification: "LIVE_EXECUTABLE",
    };
    scenario.steps.unshift({ id: "navigate", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } });
    const evaluation = evaluateDeterministically({ qaIr: ir, ...evidence });
    const input = buildSemanticJudgeInput({ qaIr: ir, ...evidence, evaluation });

    expect(input.scenario).toMatchObject({ requiredPath: "/dashboard", semantics: scenario.semantics });
    expect(input.expectations.every(item => item.judgment === "SEMANTIC")).toBe(true);
    expect(validateContract("SemanticJudgeInput", input)).toBe(input);
  });

  it("marks routed expectations judgment SEMANTIC when the scenario is listed", () => {
    const evidence = fixture();
    const ir = qaIr({ semantic: false, semanticJudgment: true });
    const evaluation = evaluateDeterministically({ qaIr: ir, ...evidence });
    const input = buildSemanticJudgeInput({ qaIr: ir, ...evidence, evaluation });

    expect(evaluation.resolvedChecks).toEqual([]);
    expect(input.expectations.map((item) => item.id)).toEqual(["url", "text", "visible", "role", "name", "attribute"]);
    expect(input.expectations.every((item) => item.judgment === "SEMANTIC")).toBe(true);
    expect(validateContract("SemanticJudgeInput", input)).toBe(input);
  });

  it("keeps expectation-adjacent evidence when the relevant section sits past the item budget", () => {
    // Consumer repro: a 51KB DOM whose subscription section sits at the tail was head-sliced out
    // of the prompt, so the judge answered TRUNCATED_DOM / NOT_OBSERVED. Slicing must prioritise
    // the window around the routed expectation's clues (testId, expected text) over the head.
    const clue = "<h1 data-testid=\"heading\">Dashboard heading rendered late</h1>";
    const evidence = fixture({ omitText: true, artifactContent: `${"<div>filler</div>".repeat(3_000)}${clue}` });
    const ir = qaIr({ semantic: false });
    const evaluation = evaluateDeterministically({ qaIr: ir, ...evidence });
    const input = buildSemanticJudgeInput({ qaIr: ir, ...evidence, evaluation });

    const visibleText = input.evidence.find((item) => item.kind === "VISIBLE_TEXT");
    expect(visibleText.content).toContain("data-testid=\"heading\"");
    expect(visibleText.truncated).toBe(true);
  });

  it("omits empty evidence items instead of violating the semantic input contract", () => {
    // A page observed before it rendered seals an empty VISIBLE_TEXT artifact; an empty item
    // carries no signal for the judge and must not make the whole run unjudgeable.
    const evidence = fixture({ omitText: true, artifactContent: "" });
    const ir = qaIr({ semantic: false });
    const evaluation = evaluateDeterministically({ qaIr: ir, ...evidence });
    const input = buildSemanticJudgeInput({ qaIr: ir, ...evidence, evaluation });

    expect(validateContract("SemanticJudgeInput", input)).toBe(input);
    expect(input.evidence.length).toBeGreaterThan(0);
    expect(input.evidence.every((item) => item.content.length > 0)).toBe(true);
  });

  it("leaves routed expectations without a judgment key when the scenario is not listed", () => {
    const evidence = fixture({ text: "Overview panel" });
    const ir = qaIr({ semantic: false });
    const evaluation = evaluateDeterministically({ qaIr: ir, ...evidence });
    const input = buildSemanticJudgeInput({ qaIr: ir, ...evidence, evaluation });

    expect(input.expectations.map((item) => item.id)).toContain("text");
    expect(input.expectations.every((item) => item.judgment === undefined)).toBe(true);
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

  it("sends an AI-extracted claim and sealed action log to the independent judge", async () => {
    const ir = qaIr({ semantic: false, semanticJudgment: true });
    ir.suites[0].scenarios[0].expectations = [{
      id: "claim",
      kind: "VISIBLE_TEXT",
      text: { kind: "literal", value: "No restore POST request is sent" },
    }];
    const evidence = fixture({ actionLog: { action: "CLICK", allowedRequests: [] } });
    const semanticJudge = vi.fn(async input => semanticDecision(input));

    const result = await judgeEvidence({ qaIr: ir, ...evidence, semanticJudge });

    expect(semanticJudge).toHaveBeenCalledTimes(1);
    expect(semanticJudge.mock.calls[0][0].expectations[0]).toMatchObject({ id: "claim", judgment: "SEMANTIC" });
    expect(semanticJudge.mock.calls[0][0].evidence).toContainEqual(expect.objectContaining({ kind: "ACTION_LOG", content: expect.stringContaining("allowedRequests") }));
    expect(result.judge.provider).toBe("fake");
  });

  it("classifies an entirely inapplicable scenario as SKIP instead of PASS", async () => {
    const evidence = fixture();
    const result = await judgeEvidence({
      qaIr: qaIr({ semantic: false, semanticJudgment: true }),
      ...evidence,
      semanticJudge: async input => semanticDecision(input, {
        expectationResults: input.expectations.map(expectation => ({
          expectationId: expectation.id,
          status: "NOT_APPLICABLE",
          confidence: 0.9,
          evidenceRefs: [input.evidence[0].id],
          rationale: "The scenario applicability was not reached.",
        })),
      }),
    });

    expect(result.verdict).toBe("SKIP");
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

  it("resamples the model once when a decision violates the contract", async () => {
    // gpt-class models occasionally emit a status outside the enum; one fresh sample recovers the
    // judgment without weakening it — an invalid decision is discarded, never coerced.
    const evidence = fixture();
    let calls = 0;
    const semanticJudge = vi.fn(async (input) => {
      calls += 1;
      if (calls === 1) {
        const invalid = semanticDecision(input);
        return { ...invalid, expectationResults: invalid.expectationResults.map((item) => ({ ...item, status: "PASSED" })) };
      }
      return semanticDecision(input);
    });
    const result = await judgeEvidence({ qaIr: qaIr(), ...evidence, semanticJudge });

    expect(semanticJudge).toHaveBeenCalledTimes(2);
    expect(result.verdict).toBe("PASS");
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
    oversized.suites[0].scenarios[0].title = "x".repeat(140_000);
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
