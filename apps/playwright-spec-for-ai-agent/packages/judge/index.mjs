import {
  CONTRACT_VIOLATION,
  DETERMINISTIC_EVALUATION_VERSION,
  JUDGE_RESULT_VERSION,
  RUNTIME_OUTCOME_VERSION,
  SEMANTIC_JUDGE_INPUT_VERSION,
  canonicalHash,
  validateContract,
} from "../contracts/index.mjs";
import { redactSensitiveText, verifyStoredEvidence } from "../evidence/index.mjs";

const DEFAULT_JUDGE = Object.freeze({
  provider: "deterministic",
  model: "rules",
  promptVersion: "deterministic-evidence/0.1",
});
const TEXT_EVIDENCE_TYPES = new Set(["DOM_SNAPSHOT", "ARIA_SNAPSHOT", "VISIBLE_TEXT", "NETWORK_LOG", "CONSOLE_LOG", "ACTION_LOG"]);
const MAX_ITEM_CHARS = 8_192;
const MAX_EVIDENCE_CHARS = 32_768;
const MAX_SEMANTIC_INPUT_CHARS = 65_536;

export function evaluateDeterministically({ qaIr, bundle, manifest, readBlob }) {
  const qaIrSnapshot = jsonSnapshot(qaIr, "QA IR");
  validateContract("QaIrDocument", qaIrSnapshot);
  return evaluateVerified(qaIrSnapshot, verifyStoredEvidence({ bundle, manifest, readBlob }));
}

function evaluateVerified(qaIr, verified) {
  const scenario = findScenario(qaIr, verified.bundle.scenarioId);
  const resolvedChecks = [];
  const unresolvedChecks = [];

  for (const expectation of scenario.expectations) {
    const check = deterministicCheck(expectation, verified.bundle, verified.readBlob);
    if (check) resolvedChecks.push(check);
    else unresolvedChecks.push({ expectationId: expectation.id, reason: "No structured element observation was captured" });
  }

  return validateContract("DeterministicEvaluationResult", {
    schemaVersion: DETERMINISTIC_EVALUATION_VERSION,
    status: scenario.expectations.length === 0 ? "MANUAL_REVIEW" : statusFromChecks(resolvedChecks, unresolvedChecks),
    resolvedChecks,
    unresolvedChecks,
  });
}

export function buildSemanticJudgeInput({ qaIr, bundle, manifest, readBlob, evaluation, secrets = [] }) {
  const qaIrSnapshot = jsonSnapshot(qaIr, "QA IR");
  const evaluationSnapshot = jsonSnapshot(evaluation, "deterministic evaluation");
  validateContract("QaIrDocument", qaIrSnapshot);
  validateContract("DeterministicEvaluationResult", evaluationSnapshot);
  const verified = verifyStoredEvidence({ bundle, manifest, readBlob });
  return buildSemanticInput(qaIrSnapshot, verified, evaluationSnapshot, snapshotSecrets(secrets));
}

export async function judgeEvidence({ qaIr, bundle, manifest, readBlob, semanticJudge = null, secrets = [] }) {
  let verified;
  let evaluation;
  let qaIrSnapshot;
  let secretList;
  try {
    secretList = snapshotSecrets(secrets);
    qaIrSnapshot = jsonSnapshot(qaIr, "QA IR");
    validateContract("QaIrDocument", qaIrSnapshot);
  } catch {
    return runtimeError(CONTRACT_VIOLATION, "Judge input violated its contract");
  }
  try {
    verified = verifyStoredEvidence({ bundle, manifest, readBlob });
  } catch {
    return runtimeError("EVIDENCE_STORAGE_FAILED", "Stored evidence verification failed");
  }
  try {
    evaluation = evaluateVerified(qaIrSnapshot, verified);
  } catch {
    return runtimeError(CONTRACT_VIOLATION, "Judge input violated its contract");
  }

  if (evaluation.unresolvedChecks.length === 0) {
    return buildJudgeResult({
      qaIr: qaIrSnapshot,
      bundle: verified.bundle,
      expectationResults: evaluation.resolvedChecks.map((check) => withConfidence(check, 1)),
      judge: DEFAULT_JUDGE,
      inputHash: canonicalHash({ qaIrId: qaIrSnapshot.id, evidenceBundleId: verified.bundle.bundleId, evaluation }),
    });
  }
  if (typeof semanticJudge !== "function") return runtimeError("MODEL_PROVIDER_FAILED", "Semantic judge provider is required");

  let semanticInput;
  try {
    semanticInput = buildSemanticInput(qaIrSnapshot, verified, evaluation, secretList);
  } catch (error) {
    debugJudgeFailure(error);
    return runtimeError(CONTRACT_VIOLATION, "Semantic judge input violated its contract");
  }
  if (semanticInput.evidence.length === 0) {
    return runtimeError("EVIDENCE_STORAGE_FAILED", "No textual evidence is available for semantic judgment");
  }

  try {
    const scenario = findScenario(qaIrSnapshot, verified.bundle.scenarioId);
    const byExpectation = new Map(evaluation.resolvedChecks.map((check) => [check.expectationId, withConfidence(check, 1)]));
    // Models occasionally emit a decision outside the contract (invalid status enum, missing
    // expectation). One fresh sample recovers the judgment without weakening it: an invalid
    // decision is discarded, never coerced, and two invalid samples still fail the judge.
    let semanticDecision;
    let lastDecisionError;
    for (let attempt = 0; attempt < 2 && semanticDecision === undefined; attempt += 1) {
      try {
        const candidate = redactValue(jsonSnapshot(await semanticJudge(semanticInput), "semantic judge decision"), secretList);
        validateContract("SemanticJudgeDecision", candidate, { semanticJudgeInput: semanticInput });
        assertCompleteDecision(semanticInput, candidate);
        semanticDecision = candidate;
      } catch (decisionError) {
        lastDecisionError = decisionError;
      }
    }
    if (semanticDecision === undefined) throw lastDecisionError;
    for (const check of semanticDecision.expectationResults) byExpectation.set(check.expectationId, check);
    const expectationResults = scenario.expectations.map((expectation) => byExpectation.get(expectation.id));
    if (expectationResults.some((item) => item === undefined)) throw new Error("Every expectation requires a judgment");
    return buildJudgeResult({
      qaIr: qaIrSnapshot,
      bundle: verified.bundle,
      expectationResults,
      judge: semanticDecision.judge,
      uncertainty: semanticDecision.uncertainty,
      inputHash: canonicalHash(semanticInput),
    });
  } catch (error) {
    debugJudgeFailure(error);
    return runtimeError("MODEL_PROVIDER_FAILED", "Semantic judge provider failed");
  }
}

// Diagnostics must never be swallowed: the public outcome stays a redacted enumeration, but the
// underlying error (which separates a model outage from a protocol bug) is reachable on demand.
function debugJudgeFailure(error) {
  if (process.env.QA_NATIVE_DEBUG) process.stderr.write(`qa-native judge debug: ${error?.stack ?? String(error?.message ?? error)}\n`);
}

function deterministicCheck(expectation, bundle, readBlob) {
  if (["URL", "URL_MATCH"].includes(expectation.kind)) {
    const fact = bundle.facts.find((item) => item.kind === "URL");
    if (!fact) return null;
    const observed = typeof fact.value === "string" ? fact.value : fact.value?.url;
    const expected = literalValue(expectation.expected ?? expectation.url ?? expectation.value);
    if (typeof observed !== "string" || expected === undefined) return null;
    let passed = observed === expected;
    if (!passed && expected.startsWith("/")) {
      try {
        const url = new URL(observed);
        passed = `${url.pathname}${url.search}` === expected || url.pathname === expected;
      } catch {
        passed = false;
      }
    }
    return check(expectation, passed, fact.id);
  }

  const observations = bundle.facts.filter((item) => item.kind === "ELEMENT_OBSERVATION" && item.value?.expectationId === expectation.id);
  if (observations.length === 1) return checkExpectationObservation(expectation, observations[0]);

  if (expectation.kind === "VISIBLE_TEXT" && literalValue(expectation.expected ?? expectation.text) !== undefined) {
    const expected = literalValue(expectation.expected ?? expectation.text);
    const artifacts = bundle.artifacts.filter((artifact) => artifact.type === "VISIBLE_TEXT");
    if (artifacts.length === 0) return null;
    for (const artifact of artifacts) {
      const text = readBlob(artifact.storageRef).toString("utf8");
      if (!text.includes("[REDACTED]") && normalizedText(text).includes(normalizedText(expected))) return check(expectation, true, artifact.id);
    }
    return null;
  }

  return null;
}

function checkExpectationObservation(expectation, observed) {
  const value = observed.value;
  if (value.resolution === "MISSING") {
    if (expectation.kind === "NOT_VISIBLE") return check(expectation, true, observed.id);
    return null;
  }
  if (value.resolution !== "FOUND") return null;
  if (expectation.kind === "CONTAINS_TEXT") {
    const expected = literalValue(expectation.expected);
    if (expected === undefined || typeof value.text !== "string") return null;
    if (value.textTruncated || value.text.includes("[REDACTED]")) return null;
    const normalizedObserved = normalizedText(value.text);
    const normalizedExpected = normalizedText(expected);
    return normalizedObserved.includes(normalizedExpected) ? check(expectation, true, observed.id) : null;
  }
  if (expectation.kind === "VISIBLE") return value.visible === true ? check(expectation, true, observed.id) : null;
  if (expectation.kind === "NOT_VISIBLE") return value.visible === false ? check(expectation, true, observed.id) : null;
  if (expectation.kind === "PRESENT") return check(expectation, true, observed.id);
  if (expectation.kind === "ROLE") return exactObservation(expectation, value.role, expectation.expected ?? expectation.target?.role, observed.id);
  if (expectation.kind === "NAME") return exactObservation(expectation, value.accessibleName, expectation.expected ?? expectation.target?.accessibleName, observed.id);
  if (expectation.kind === "ATTRIBUTE") {
    const name = typeof expectation.attribute === "string" ? expectation.attribute : expectation.attribute?.name;
    return name && Object.hasOwn(value.attributes ?? {}, name)
      ? exactObservation(expectation, value.attributes[name], expectation.expected, observed.id)
      : null;
  }
  return null;
}

function normalizedText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function exactObservation(expectation, observed, expectedValue, evidenceRef) {
  const expected = literalValue(expectedValue);
  return typeof observed === "string" && expected !== undefined && observed === expected ? check(expectation, true, evidenceRef) : null;
}

function check(expectation, passed, evidenceRef) {
  return {
    expectationId: expectation.id,
    status: passed ? "MATCHED" : "CONTRADICTED",
    evidenceRefs: [evidenceRef],
    rationale: passed ? "Structured evidence matched the expectation." : "Structured evidence contradicted the expectation.",
  };
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

function withConfidence(check, confidence) {
  return { ...check, confidence };
}

function buildSemanticInput(qaIr, verified, evaluation, secrets) {
  const scenario = findScenario(qaIr, verified.bundle.scenarioId);
  const isSemantic = (qaIr.extensions?.semanticJudgmentScenarioIds ?? []).includes(scenario.id);
  const unresolved = new Set(evaluation.unresolvedChecks.map((check) => check.expectationId));
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

  let remaining = MAX_EVIDENCE_CHARS;
  const evidence = [];
  for (const item of candidates.sort((left, right) => left.id.localeCompare(right.id))) {
    // A page observed before it rendered seals empty artifacts; an empty item carries no signal
    // for the judge and would violate the SemanticJudgeInput contract, making the run unjudgeable.
    if (item.content.length === 0 || remaining === 0 || evidence.some((entry) => entry.id === item.id)) continue;
    const length = Math.min(item.content.length, MAX_ITEM_CHARS, remaining);
    evidence.push({ id: item.id, kind: item.kind, content: item.content.slice(0, length), truncated: item.truncated || length < item.content.length });
    remaining -= length;
  }

  const input = redactValue({
    schemaVersion: SEMANTIC_JUDGE_INPUT_VERSION,
    qaIrId: qaIr.id,
    evidenceBundleId: verified.bundle.bundleId,
    scenario: { id: scenario.id, title: scenario.title },
    expectations: scenario.expectations.filter((expectation) => unresolved.has(expectation.id)).map((expectation) => copyExpectationForPrompt(expectation, isSemantic)),
    evidence,
  }, secrets);
  const validated = validateContract("SemanticJudgeInput", input);
  if (JSON.stringify(validated).length > MAX_SEMANTIC_INPUT_CHARS) throw new Error("Semantic judge input exceeds size limit");
  return deepFreeze(validated);
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

function literalValue(value) {
  if (typeof value === "string") return value;
  return value?.kind === "literal" && typeof value.value === "string" ? value.value : undefined;
}

function statusFromChecks(resolvedChecks, unresolvedChecks) {
  if (resolvedChecks.some((check) => check.status === "CONTRADICTED")) return "FAIL";
  if (unresolvedChecks.length > 0) return "MANUAL_REVIEW";
  return "PASS";
}

function verdictFromExpectationResults(results) {
  if (results.length === 0) return "MANUAL_REVIEW";
  if (results.every((item) => ["MATCHED", "NOT_APPLICABLE"].includes(item.status))) return "PASS";
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
