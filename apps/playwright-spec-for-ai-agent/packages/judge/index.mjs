import {
  CONTRACT_VIOLATION,
  JUDGE_RESULT_VERSION,
  RUNTIME_OUTCOME_VERSION,
  SEMANTIC_JUDGE_INPUT_VERSION,
  canonicalHash,
  validateContract,
} from "../contracts/index.mjs";
import { redactSensitiveText, verifyStoredEvidence } from "../evidence/index.mjs";

const TEXT_EVIDENCE_TYPES = new Set(["DOM_SNAPSHOT", "ARIA_SNAPSHOT", "VISIBLE_TEXT", "NETWORK_LOG", "CONSOLE_LOG", "ACTION_LOG"]);
const MAX_ITEM_CHARS = 16_384;
const MAX_EVIDENCE_CHARS = 65_536;
const MAX_SEMANTIC_INPUT_CHARS = 131_072;

export function buildSemanticJudgeInput({ qaIr, bundle, manifest, readBlob, secrets = [] }) {
  const qaIrSnapshot = jsonSnapshot(qaIr, "QA IR");
  validateContract("QaIrDocument", qaIrSnapshot);
  const verified = verifyStoredEvidence({ bundle, manifest, readBlob });
  return buildSemanticInput(qaIrSnapshot, verified, snapshotSecrets(secrets));
}

export async function judgeEvidence({ qaIr, bundle, manifest, readBlob, semanticJudge, secrets = [] }) {
  let qaIrSnapshot;
  let verified;
  let semanticInput;
  const secretList = snapshotSecrets(secrets);
  try {
    qaIrSnapshot = jsonSnapshot(qaIr, "QA IR");
    validateContract("QaIrDocument", qaIrSnapshot);
    verified = verifyStoredEvidence({ bundle, manifest, readBlob });
    semanticInput = buildSemanticInput(qaIrSnapshot, verified, secretList);
  } catch (error) {
    debugJudgeFailure(error);
    return runtimeError(error?.message?.includes("evidence") ? "EVIDENCE_STORAGE_FAILED" : CONTRACT_VIOLATION, "Judge input verification failed");
  }
  if (typeof semanticJudge !== "function") return runtimeError("MODEL_PROVIDER_FAILED", "Semantic judge provider is required");
  if (semanticInput.evidence.length === 0) return runtimeError("EVIDENCE_STORAGE_FAILED", "No textual evidence is available for semantic judgment");

  let decision;
  let lastError;
  for (let attempt = 0; attempt < 2 && decision === undefined; attempt += 1) {
    try {
      const candidate = redactValue(jsonSnapshot(await semanticJudge(semanticInput), "semantic judge decision"), secretList);
      validateContract("SemanticJudgeDecision", candidate, { semanticJudgeInput: semanticInput });
      assertCompleteDecision(semanticInput, candidate);
      decision = candidate;
    } catch (error) {
      lastError = error;
    }
  }
  if (decision === undefined) {
    debugJudgeFailure(lastError);
    return runtimeError("MODEL_PROVIDER_FAILED", "Semantic judge provider failed");
  }
  return buildJudgeResult({
    qaIr: qaIrSnapshot,
    bundle: verified.bundle,
    expectationResults: decision.expectationResults,
    judge: decision.judge,
    uncertainty: decision.uncertainty,
    inputHash: canonicalHash(semanticInput),
  });
}

// Diagnostics must never be swallowed: the public outcome stays a redacted enumeration, but the
// underlying error (which separates a model outage from a protocol bug) is reachable on demand.
function debugJudgeFailure(error) {
  if (process.env.QA_NATIVE_DEBUG) process.stderr.write(`qa-native judge debug: ${error?.stack ?? String(error?.message ?? error)}\n`);
}

function buildJudgeResult({ qaIr, bundle, expectationResults, judge, uncertainty = [], inputHash }) {
  const verdict = verdictFromExpectationResults(expectationResults);
  const body = {
    schemaVersion: JUDGE_RESULT_VERSION,
    qaIrId: qaIr.id,
    evidenceBundleId: bundle.bundleId,
    verdict,
    confidence: expectationResults.length ? Math.min(...expectationResults.map((item) => item.confidence)) : 0,
    expectationResults,
    uncertainty,
    judge,
    inputHash,
  };
  return validateContract("JudgeResult", { ...body, resultId: stableId("judge", body) }, { qaIr, evidenceBundle: bundle });
}

function buildSemanticInput(qaIr, verified, secrets) {
  const scenario = findScenario(qaIr, verified.bundle.scenarioId);
  const isSemantic = scenario.semantics !== undefined || (qaIr.extensions?.semanticJudgmentScenarioIds ?? []).includes(scenario.id);
  const unresolved = new Set(scenario.expectations.map((expectation) => expectation.id));
  const candidates = [];

  for (const fact of verified.bundle.facts) {
    if (fact.value?.expectationId && !unresolved.has(fact.value.expectationId)) continue;
    const content = JSON.stringify(redactValue(fact.value, secrets));
    candidates.push({ id: fact.id, kind: fact.kind, content, truncated: content.length > MAX_ITEM_CHARS });
  }
  for (const artifact of verified.bundle.artifacts) {
    if (!TEXT_EVIDENCE_TYPES.has(artifact.type)) continue;
    const blob = verified.readBlob(artifact.storageRef);
    const byteLimit = MAX_ITEM_CHARS * 4;
    candidates.push({
      id: artifact.id,
      kind: artifact.type,
      content: redactText(blob.subarray(0, byteLimit).toString("utf8"), secrets),
      truncated: blob.byteLength > byteLimit,
    });
  }

  const clues = expectationClues(scenario, unresolved);
  let remaining = MAX_EVIDENCE_CHARS;
  const evidence = [];
  for (const item of candidates.sort((left, right) => left.id.localeCompare(right.id))) {
    // A page observed before it rendered seals empty artifacts; an empty item carries no signal
    // for the judge and would violate the SemanticJudgeInput contract, making the run unjudgeable.
    if (item.content.length === 0 || remaining === 0 || evidence.some((entry) => entry.id === item.id)) continue;
    const length = Math.min(item.content.length, MAX_ITEM_CHARS, remaining);
    // Head-slicing dropped whatever the routed expectations were actually about whenever it sat
    // past the item budget (the judge then answers TRUNCATED_DOM). Centre the slice on the
    // earliest clue match instead; items whose clues fit in the head keep the plain head slice.
    const start = clueWindowStart(item.content, clues, length);
    evidence.push({ id: item.id, kind: item.kind, content: item.content.slice(start, start + length), truncated: item.truncated || length < item.content.length });
    remaining -= length;
  }

  const input = redactValue({
    schemaVersion: SEMANTIC_JUDGE_INPUT_VERSION,
    qaIrId: qaIr.id,
    evidenceBundleId: verified.bundle.bundleId,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      ...(scenario.semantics === undefined ? {} : { semantics: structuredClone(scenario.semantics) }),
      ...requiredPathFromScenario(scenario),
    },
    expectations: scenario.expectations.filter((expectation) => unresolved.has(expectation.id)).map((expectation) => copyExpectationForPrompt(expectation, isSemantic)),
    evidence,
  }, secrets);
  const validated = validateContract("SemanticJudgeInput", input);
  if (JSON.stringify(validated).length > MAX_SEMANTIC_INPUT_CHARS) throw new Error("Semantic judge input exceeds size limit");
  return deepFreeze(validated);
}

function requiredPathFromScenario(scenario) {
  const step = scenario.steps.find(item => item.kind === "NAVIGATE" && item.target?.type === "PATH");
  return step ? { requiredPath: step.target.value } : {};
}

// Literal strings that identify what the routed expectations are about: testIds, accessible
// names, expected texts. They anchor evidence slicing to the relevant part of large artifacts.
function expectationClues(scenario, unresolved) {
  const clues = [];
  for (const expectation of scenario.expectations) {
    if (!unresolved.has(expectation.id)) continue;
    for (const value of [expectation.target?.testId, promptLiteral(expectation.target?.accessibleName), promptLiteral(expectation.target?.text), promptLiteral(expectation.text), promptLiteral(expectation.expected)]) {
      if (typeof value === "string" && value.length >= 2) clues.push(value);
    }
  }
  return clues;
}

function promptLiteral(value) {
  if (typeof value === "string") return value;
  return value?.kind === "literal" || value?.kind === "TEXT" ? value.value : undefined;
}

function clueWindowStart(content, clues, length) {
  if (content.length <= length) return 0;
  let earliest = -1;
  for (const clue of clues) {
    const index = content.indexOf(clue);
    if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index;
  }
  if (earliest === -1 || earliest + Math.min(64, length) <= length) return 0;
  return Math.min(Math.max(0, earliest - Math.floor(length / 2)), content.length - length);
}

function assertCompleteDecision(input, decision) {
  const expected = input.expectations.map((item) => item.id).sort();
  const actual = decision.expectationResults.map((item) => item.expectationId).sort();
  if (expected.join("\0") !== actual.join("\0")) {
    throw new Error("Semantic decision must resolve every routed expectation exactly once");
  }
}

function copyExpectationForPrompt(expectation, isSemantic) {
  const copy = Object.fromEntries(
    ["id", "kind", "target", "expected", "text", "attribute"]
      .filter((key) => expectation[key] !== undefined)
      .map((key) => [key, structuredClone(expectation[key])]),
  );
  if (copy.target) {
    copy.target = Object.fromEntries(
      ["role", "accessibleName", "text", "testId"]
        .filter((key) => copy.target[key] !== undefined)
        .map((key) => [key, copy.target[key]]),
    );
  }
  if (isSemantic) copy.judgment = "SEMANTIC";
  return copy;
}

function findScenario(qaIr, scenarioId) {
  const scenario = qaIr.suites.flatMap((suite) => suite.scenarios).find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error(`scenario ${scenarioId} not found in QA IR`);
  return scenario;
}

function verdictFromExpectationResults(results) {
  if (results.length === 0) return "MANUAL_REVIEW";
  if (results.every((item) => item.status === "NOT_APPLICABLE")) return "SKIP";
  if (results.some((item) => item.status === "MATCHED") && results.every((item) => ["MATCHED", "NOT_APPLICABLE"].includes(item.status))) return "PASS";
  if (results.some((item) => item.status === "CONTRADICTED")) return "FAIL";
  return "MANUAL_REVIEW";
}

function runtimeError(code, message) {
  return validateContract("RuntimeOutcome", {
    schemaVersion: RUNTIME_OUTCOME_VERSION,
    stage: "judge",
    type: "ERROR",
    code,
    message,
  });
}

function redactValue(value, secrets) {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) {
    if (typeof value[0] === "string" && sensitiveKey(value[0]) && value.length > 1) {
      return [value[0], "[REDACTED]", ...value.slice(2).map((item) => redactValue(item, secrets))];
    }
    return value.map((item) => redactValue(item, secrets));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sensitiveKey(key) ? "[REDACTED]" : redactValue(child, secrets),
  ]));
}

function redactText(value, secrets) {
  return redactSensitiveText(value, secrets);
}

function sensitiveKey(key) {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return ["authorization", "cookie", "token", "password", "passwd", "secret", "apikey", "session", "sessionid"].some(
    (suffix) => normalized.endsWith(suffix),
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function snapshotSecrets(secrets) {
  return Object.freeze([...secrets].filter(Boolean).map(String));
}

function jsonSnapshot(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable`);
  return JSON.parse(serialized);
}

function stableId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice("sha256:".length, "sha256:".length + 16)}`;
}
