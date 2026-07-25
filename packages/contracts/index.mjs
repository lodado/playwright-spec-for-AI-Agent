import { createHash } from "node:crypto";

export const CONTRACT_VIOLATION = "CONTRACT_VIOLATION";
export const ARTIFACT_VERSION = "artifact/0.1";
export const QA_IR_VERSION = "qa-ir/0.1";
export const COMPILE_RESULT_VERSION = "compile-result/0.1";
export const DIAGNOSTIC_VERSION = "diagnostic/0.1";
export const PROVIDER_CAPABILITIES_VERSION = "provider-capabilities/0.1";
export const EXECUTION_PLAN_VERSION = "execution-plan/0.1";
export const RUNTIME_OUTCOME_VERSION = "runtime-outcome/0.1";
export const DETERMINISTIC_EVALUATION_VERSION = "deterministic-evaluation/0.1";
export const EVIDENCE_BUNDLE_VERSION = "evidence-bundle/0.1";
export const EVIDENCE_MANIFEST_VERSION = "evidence-manifest/0.1";
export const JUDGE_RESULT_VERSION = "judge-result/0.1";
export const SEMANTIC_JUDGE_INPUT_VERSION = "semantic-judge-input/0.1";
export const SEMANTIC_JUDGE_DECISION_VERSION = "semantic-judge-decision/0.1";
export const FAILURE_DIAGNOSIS_VERSION = "failure-diagnosis/0.1";
export const CODE_CONTEXT_VERSION = "code-context/0.1";
export const REPAIR_RECOMMENDATION_VERSION = "repair-recommendation/0.1";

export const VERDICTS = Object.freeze(["PASS", "FAIL", "SKIP", "MANUAL_REVIEW"]);
export const EXPECTATION_STATUSES = Object.freeze(["MATCHED", "CONTRADICTED", "NOT_OBSERVED", "AMBIGUOUS", "NOT_APPLICABLE"]);
export const RUNTIME_ERROR_CODES = Object.freeze([
  "BROWSER_START_FAILED",
  "AUTHENTICATION_FAILED",
  CONTRACT_VIOLATION,
  "EVIDENCE_STORAGE_FAILED",
  "MODEL_PROVIDER_FAILED",
  "POLICY_VIOLATION",
  "UNKNOWN_RUNTIME_ERROR",
]);

const runtimeStages = ["compile", "plan", "execute", "evidence", "evaluate", "judge", "diagnose", "report"];
const failureOrigins = ["PRODUCT_CODE", "TEST_CODE", "QA_SPEC", "API_CONTRACT", "FIXTURE_OR_MOCK", "TEST_DATA", "ENVIRONMENT", "THIRD_PARTY", "UNKNOWN"];
const codeMatchReasons = ["TEST_ID_MATCH", "VISIBLE_TEXT_MATCH", "ROUTE_MATCH", "NETWORK_ENDPOINT_MATCH", "STACK_TRACE_MATCH", "RECENTLY_CHANGED", "DEPENDENCY_MATCH"];
const payloadHashNoise = new Set([
  "appliedAt",
  "capturedAt",
  "createdAt",
  "durationMs",
  "endedAt",
  "generatedAt",
  "observedAt",
  "providerLatencyMs",
  "runtimeMetadata",
  "sealedAt",
  "startedAt",
  "timestamp",
  "timestamps",
  "updatedAt",
]);

const schemas = {
  ArtifactEnvelope: validateArtifactEnvelope,
  QaIrDocument: validateQaIrDocument,
  CompileResult: validateCompileResult,
  Diagnostic: validateDiagnostic,
  ProviderCapabilities: validateProviderCapabilities,
  ExecutionPlan: validateExecutionPlan,
  RuntimeOutcome: validateRuntimeOutcome,
  DeterministicEvaluationResult: validateDeterministicEvaluationResult,
  EvidenceBundle: validateEvidenceBundle,
  EvidenceManifest: validateEvidenceManifest,
  JudgeResult: validateJudgeResult,
  SemanticJudgeInput: validateSemanticJudgeInput,
  SemanticJudgeDecision: validateSemanticJudgeDecision,
  FailureDiagnosis: validateFailureDiagnosis,
  CodeContextBundle: validateCodeContextBundle,
  RepairRecommendation: validateRepairRecommendation,
};

export class ContractViolationError extends Error {
  constructor(contract, message, path = "$") {
    super(`${contract}: ${path} ${message}`);
    this.name = "ContractViolationError";
    this.code = CONTRACT_VIOLATION;
    this.contract = contract;
    this.path = path;
    this.diagnostic = {
      schemaVersion: DIAGNOSTIC_VERSION,
      code: CONTRACT_VIOLATION,
      severity: "ERROR",
      message: this.message,
      path,
    };
  }
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function payloadContentHash(payload) {
  return canonicalHash(payload);
}

export function createArtifactEnvelope(payload, { artifactId, createdAt, producer }) {
  return validateContract("ArtifactEnvelope", {
    artifactVersion: ARTIFACT_VERSION,
    artifactId,
    contentHash: payloadContentHash(payload),
    createdAt,
    producer,
    payload,
  });
}

export function contractViolationOutcome(stage, error) {
  return {
    schemaVersion: RUNTIME_OUTCOME_VERSION,
    stage,
    type: "ERROR",
    code: CONTRACT_VIOLATION,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function validateContract(contract, value, context = {}) {
  const validate = schemas[contract];
  if (!validate) fail(contract, "$", "is not a known contract");
  validate(value, "$", context);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !payloadHashNoise.has(key))
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function validateArtifactEnvelope(value, path) {
  object(value, path, "ArtifactEnvelope");
  allowedKeys(value, ["artifactVersion", "artifactId", "contentHash", "createdAt", "producer", "payload"], path, "ArtifactEnvelope");
  exact(value.artifactVersion, ARTIFACT_VERSION, `${path}.artifactVersion`, "ArtifactEnvelope");
  string(value.artifactId, `${path}.artifactId`, "ArtifactEnvelope");
  string(value.contentHash, `${path}.contentHash`, "ArtifactEnvelope");
  string(value.createdAt, `${path}.createdAt`, "ArtifactEnvelope");
  object(value.producer, `${path}.producer`, "ArtifactEnvelope");
  allowedKeys(value.producer, ["name", "version"], `${path}.producer`, "ArtifactEnvelope");
  string(value.producer.name, `${path}.producer.name`, "ArtifactEnvelope");
  string(value.producer.version, `${path}.producer.version`, "ArtifactEnvelope");
  present(value.payload, `${path}.payload`, "ArtifactEnvelope");
  exact(value.contentHash, payloadContentHash(value.payload), `${path}.contentHash`, "ArtifactEnvelope");
}

function validateQaIrDocument(value, path) {
  object(value, path, "QaIrDocument");
  allowedKeys(value, ["schemaVersion", "id", "source", "suites", "extensions"], path, "QaIrDocument");
  exact(value.schemaVersion, QA_IR_VERSION, `${path}.schemaVersion`, "QaIrDocument");
  string(value.id, `${path}.id`, "QaIrDocument");
  object(value.source, `${path}.source`, "QaIrDocument");
  allowedKeys(value.source, ["adapter", "adapterVersion", "uri", "revision"], `${path}.source`, "QaIrDocument");
  string(value.source.adapter, `${path}.source.adapter`, "QaIrDocument");
  string(value.source.adapterVersion, `${path}.source.adapterVersion`, "QaIrDocument");
  string(value.source.uri, `${path}.source.uri`, "QaIrDocument");
  if (value.source.revision !== undefined) string(value.source.revision, `${path}.source.revision`, "QaIrDocument");
  array(value.suites, `${path}.suites`, "QaIrDocument");
  value.suites.forEach((suite, index) => validateQaSuite(suite, `${path}.suites[${index}]`));
  const scenarioIds = value.suites.flatMap((suite) => suite.scenarios.map((scenario) => scenario.id));
  if (new Set(scenarioIds).size !== scenarioIds.length) fail("QaIrDocument", `${path}.suites`, "scenario ids must be globally unique");
  if (value.extensions !== undefined) object(value.extensions, `${path}.extensions`, "QaIrDocument");
}

function validateQaSuite(value, path) {
  object(value, path, "QaIrDocument");
  allowedKeys(value, ["id", "title", "tags", "scenarios", "provenance"], path, "QaIrDocument");
  string(value.id, `${path}.id`, "QaIrDocument");
  string(value.title, `${path}.title`, "QaIrDocument");
  stringArray(value.tags, `${path}.tags`, "QaIrDocument");
  array(value.scenarios, `${path}.scenarios`, "QaIrDocument");
  value.scenarios.forEach((scenario, index) => validateQaScenario(scenario, `${path}.scenarios[${index}]`));
  array(value.provenance, `${path}.provenance`, "QaIrDocument");
  value.provenance.forEach((item, index) => validateSourceProvenance(item, `${path}.provenance[${index}]`, "QaIrDocument"));
}

function validateQaScenario(value, path) {
  object(value, path, "QaIrDocument");
  allowedKeys(value, ["id", "title", "preconditions", "steps", "expectations", "policy", "provenance"], path, "QaIrDocument");
  string(value.id, `${path}.id`, "QaIrDocument");
  string(value.title, `${path}.title`, "QaIrDocument");
  recordArray(value.preconditions, `${path}.preconditions`, "QaIrDocument");
  array(value.steps, `${path}.steps`, "QaIrDocument");
  value.steps.forEach((step, index) => validateQaStep(step, `${path}.steps[${index}]`));
  const stepIds = value.steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) fail("QaIrDocument", `${path}.steps`, "step ids must be unique within a scenario");
  recordArray(value.expectations, `${path}.expectations`, "QaIrDocument");
  object(value.policy, `${path}.policy`, "QaIrDocument");
  validateCapabilityPolicy(value.policy, `${path}.policy`, "QaIrDocument");
  array(value.provenance, `${path}.provenance`, "QaIrDocument");
  value.provenance.forEach((item, index) => validateSourceProvenance(item, `${path}.provenance[${index}]`, "QaIrDocument"));
}

function validateQaStep(value, path) {
  object(value, path, "QaIrDocument");
  string(value.id, `${path}.id`, "QaIrDocument");
  oneOf(value.kind, ["NAVIGATE", "INTERACT", "OBSERVE", "CHECKPOINT"], `${path}.kind`, "QaIrDocument");
  if (value.kind === "NAVIGATE") {
    allowedKeys(value, ["id", "kind", "target"], path, "QaIrDocument");
    object(value.target, `${path}.target`, "QaIrDocument");
    allowedKeys(value.target, ["type", "value"], `${path}.target`, "QaIrDocument");
    oneOf(value.target.type, ["PATH", "URL"], `${path}.target.type`, "QaIrDocument");
    string(value.target.value, `${path}.target.value`, "QaIrDocument");
  } else if (value.kind === "INTERACT") {
    allowedKeys(value, ["id", "kind", "action", "target", "value"], path, "QaIrDocument");
    oneOf(value.action, ["CLICK", "TYPE", "UPLOAD", "SELECT", "PRESS"], `${path}.action`, "QaIrDocument");
    validateSemanticTarget(value.target, `${path}.target`);
  } else if (value.kind === "OBSERVE") {
    allowedKeys(value, ["id", "kind", "requests"], path, "QaIrDocument");
    recordArray(value.requests, `${path}.requests`, "QaIrDocument");
  } else {
    allowedKeys(value, ["id", "kind", "checkpointId"], path, "QaIrDocument");
    string(value.checkpointId, `${path}.checkpointId`, "QaIrDocument");
  }
}

function validateCapabilityPolicy(value, path, contract) {
  allowedKeys(value, ["navigation", "readDom", "readNetwork", "click", "type", "upload", "submit", "destructiveMutation", "confirmation", "secrets"], path, contract);
  oneOf(value.navigation, ["ALLOWED", "BLOCKED"], `${path}.navigation`, contract);
  bool(value.readDom, `${path}.readDom`, contract);
  bool(value.readNetwork, `${path}.readNetwork`, contract);
  oneOf(value.click, ["NONE", "SAFE_ONLY", "ALL"], `${path}.click`, contract);
  oneOf(value.type, ["NONE", "NON_SECRET", "ALL"], `${path}.type`, contract);
  bool(value.upload, `${path}.upload`, contract);
  bool(value.submit, `${path}.submit`, contract);
  exact(value.destructiveMutation, false, `${path}.destructiveMutation`, contract);
  oneOf(value.confirmation, ["DENY", "ALLOW_SAFE"], `${path}.confirmation`, contract);
  exact(value.secrets, "RUNTIME_INJECTED", `${path}.secrets`, contract);
}

function validateSemanticTarget(value, path) {
  object(value, path, "QaIrDocument");
  allowedKeys(value, ["role", "accessibleName", "text", "testId", "hints"], path, "QaIrDocument");
  if (value.role !== undefined) string(value.role, `${path}.role`, "QaIrDocument");
  if (value.accessibleName !== undefined) present(value.accessibleName, `${path}.accessibleName`, "QaIrDocument");
  if (value.text !== undefined) present(value.text, `${path}.text`, "QaIrDocument");
  if (value.testId !== undefined) string(value.testId, `${path}.testId`, "QaIrDocument");
  if (value.hints !== undefined) {
    array(value.hints, `${path}.hints`, "QaIrDocument");
    value.hints.forEach((hint, index) => {
      object(hint, `${path}.hints[${index}]`, "QaIrDocument");
      allowedKeys(hint, ["adapter", "data"], `${path}.hints[${index}]`, "QaIrDocument");
      string(hint.adapter, `${path}.hints[${index}].adapter`, "QaIrDocument");
      present(hint.data, `${path}.hints[${index}].data`, "QaIrDocument");
    });
  }
}

function validateCompileResult(value, path) {
  object(value, path, "CompileResult");
  allowedKeys(value, ["schemaVersion", "ok", "qaIr", "diagnostics"], path, "CompileResult");
  exact(value.schemaVersion, COMPILE_RESULT_VERSION, `${path}.schemaVersion`, "CompileResult");
  bool(value.ok, `${path}.ok`, "CompileResult");
  if (value.qaIr !== undefined) validateQaIrDocument(value.qaIr, `${path}.qaIr`);
  diagnostics(value.diagnostics, `${path}.diagnostics`, "CompileResult");
  if (value.ok === false && value.diagnostics.length === 0) fail("CompileResult", `${path}.diagnostics`, "failed compilation requires at least one diagnostic");
}

function validateDiagnostic(value, path) {
  object(value, path, "Diagnostic");
  allowedKeys(value, ["schemaVersion", "code", "severity", "message", "path"], path, "Diagnostic");
  exact(value.schemaVersion, DIAGNOSTIC_VERSION, `${path}.schemaVersion`, "Diagnostic");
  string(value.code, `${path}.code`, "Diagnostic");
  oneOf(value.severity, ["INFO", "WARNING", "ERROR"], `${path}.severity`, "Diagnostic");
  string(value.message, `${path}.message`, "Diagnostic");
}

function validateProviderCapabilities(value, path) {
  object(value, path, "ProviderCapabilities");
  allowedKeys(value, ["schemaVersion", "providerId", "actions", "evidence", "unsupportedEvidence"], path, "ProviderCapabilities");
  exact(value.schemaVersion, PROVIDER_CAPABILITIES_VERSION, `${path}.schemaVersion`, "ProviderCapabilities");
  string(value.providerId, `${path}.providerId`, "ProviderCapabilities");
  stringArray(value.actions, `${path}.actions`, "ProviderCapabilities");
  stringArray(value.evidence, `${path}.evidence`, "ProviderCapabilities");
  if (value.unsupportedEvidence !== undefined) stringArray(value.unsupportedEvidence, `${path}.unsupportedEvidence`, "ProviderCapabilities");
}

function validateExecutionPlan(value, path) {
  object(value, path, "ExecutionPlan");
  allowedKeys(value, ["schemaVersion", "planId", "qaIrId", "nodes", "edges", "retryPolicy", "timeoutPolicy"], path, "ExecutionPlan");
  exact(value.schemaVersion, EXECUTION_PLAN_VERSION, `${path}.schemaVersion`, "ExecutionPlan");
  string(value.planId, `${path}.planId`, "ExecutionPlan");
  string(value.qaIrId, `${path}.qaIrId`, "ExecutionPlan");
  array(value.nodes, `${path}.nodes`, "ExecutionPlan");
  value.nodes.forEach((node, index) => { object(node, `${path}.nodes[${index}]`, "ExecutionPlan"); string(node.nodeId, `${path}.nodes[${index}].nodeId`, "ExecutionPlan"); });
  array(value.edges, `${path}.edges`, "ExecutionPlan");
  value.edges.forEach((edge, index) => { object(edge, `${path}.edges[${index}]`, "ExecutionPlan"); string(edge.from, `${path}.edges[${index}].from`, "ExecutionPlan"); string(edge.to, `${path}.edges[${index}].to`, "ExecutionPlan"); });
  object(value.retryPolicy, `${path}.retryPolicy`, "ExecutionPlan");
  object(value.timeoutPolicy, `${path}.timeoutPolicy`, "ExecutionPlan");
}

function validateRuntimeOutcome(value, path) {
  object(value, path, "RuntimeOutcome");
  allowedKeys(value, value.type === "ERROR" ? ["schemaVersion", "stage", "type", "code", "message"] : ["schemaVersion", "stage", "type"], path, "RuntimeOutcome");
  exact(value.schemaVersion, RUNTIME_OUTCOME_VERSION, `${path}.schemaVersion`, "RuntimeOutcome");
  oneOf(value.stage, runtimeStages, `${path}.stage`, "RuntimeOutcome");
  oneOf(value.type, ["COMPLETED", "ERROR"], `${path}.type`, "RuntimeOutcome");
  if (value.verdict !== undefined) fail("RuntimeOutcome", `${path}.verdict`, "belongs in JudgeResult, not RuntimeOutcome");
  if (value.type === "ERROR") {
    oneOf(value.code, RUNTIME_ERROR_CODES, `${path}.code`, "RuntimeOutcome");
    string(value.message, `${path}.message`, "RuntimeOutcome");
  }
}

function validateDeterministicEvaluationResult(value, path) {
  object(value, path, "DeterministicEvaluationResult");
  allowedKeys(value, ["schemaVersion", "status", "resolvedChecks", "unresolvedChecks"], path, "DeterministicEvaluationResult");
  exact(value.schemaVersion, DETERMINISTIC_EVALUATION_VERSION, `${path}.schemaVersion`, "DeterministicEvaluationResult");
  oneOf(value.status, ["PASS", "FAIL", "MANUAL_REVIEW"], `${path}.status`, "DeterministicEvaluationResult");
  array(value.resolvedChecks, `${path}.resolvedChecks`, "DeterministicEvaluationResult");
  array(value.unresolvedChecks, `${path}.unresolvedChecks`, "DeterministicEvaluationResult");
  const expectationIds = new Set();
  value.resolvedChecks.forEach((item, index) => {
    const itemPath = `${path}.resolvedChecks[${index}]`;
    object(item, itemPath, "DeterministicEvaluationResult");
    allowedKeys(item, ["expectationId", "status", "evidenceRefs", "rationale"], itemPath, "DeterministicEvaluationResult");
    string(item.expectationId, `${itemPath}.expectationId`, "DeterministicEvaluationResult");
    if (expectationIds.has(item.expectationId)) fail("DeterministicEvaluationResult", `${itemPath}.expectationId`, "must be unique");
    expectationIds.add(item.expectationId);
    oneOf(item.status, ["MATCHED", "CONTRADICTED", "NOT_APPLICABLE"], `${itemPath}.status`, "DeterministicEvaluationResult");
    stringArray(item.evidenceRefs, `${itemPath}.evidenceRefs`, "DeterministicEvaluationResult");
    if (item.evidenceRefs.length === 0) fail("DeterministicEvaluationResult", `${itemPath}.evidenceRefs`, "resolved checks require evidence");
    string(item.rationale, `${itemPath}.rationale`, "DeterministicEvaluationResult");
  });
  value.unresolvedChecks.forEach((item, index) => {
    const itemPath = `${path}.unresolvedChecks[${index}]`;
    object(item, itemPath, "DeterministicEvaluationResult");
    allowedKeys(item, ["expectationId", "reason"], itemPath, "DeterministicEvaluationResult");
    string(item.expectationId, `${itemPath}.expectationId`, "DeterministicEvaluationResult");
    if (expectationIds.has(item.expectationId)) fail("DeterministicEvaluationResult", `${itemPath}.expectationId`, "must be unique");
    expectationIds.add(item.expectationId);
    string(item.reason, `${itemPath}.reason`, "DeterministicEvaluationResult");
  });
  const expectedStatus = value.resolvedChecks.some((item) => item.status === "CONTRADICTED")
    ? "FAIL"
    : value.unresolvedChecks.length > 0 || value.resolvedChecks.length === 0
      ? "MANUAL_REVIEW"
      : "PASS";
  exact(value.status, expectedStatus, `${path}.status`, "DeterministicEvaluationResult");
}

function validateEvidenceBundle(value, path) {
  object(value, path, "EvidenceBundle");
  allowedKeys(value, ["schemaVersion", "bundleId", "runId", "scenarioId", "checkpointId", "capturedAt", "environment", "artifacts", "facts", "redaction"], path, "EvidenceBundle");
  exact(value.schemaVersion, EVIDENCE_BUNDLE_VERSION, `${path}.schemaVersion`, "EvidenceBundle");
  for (const key of ["bundleId", "runId", "scenarioId", "checkpointId", "capturedAt"]) string(value[key], `${path}.${key}`, "EvidenceBundle");
  object(value.environment, `${path}.environment`, "EvidenceBundle");
  allowedKeys(value.environment, ["targetUrl", "browser", "viewport", "locale", "timezone"], `${path}.environment`, "EvidenceBundle");
  string(value.environment.targetUrl, `${path}.environment.targetUrl`, "EvidenceBundle");
  string(value.environment.browser, `${path}.environment.browser`, "EvidenceBundle");
  object(value.environment.viewport, `${path}.environment.viewport`, "EvidenceBundle");
  allowedKeys(value.environment.viewport, ["width", "height"], `${path}.environment.viewport`, "EvidenceBundle");
  number(value.environment.viewport.width, `${path}.environment.viewport.width`, "EvidenceBundle");
  number(value.environment.viewport.height, `${path}.environment.viewport.height`, "EvidenceBundle");
  if (value.environment.locale !== undefined) string(value.environment.locale, `${path}.environment.locale`, "EvidenceBundle");
  if (value.environment.timezone !== undefined) string(value.environment.timezone, `${path}.environment.timezone`, "EvidenceBundle");
  array(value.artifacts, `${path}.artifacts`, "EvidenceBundle");
  value.artifacts.forEach((artifact, index) => validateEvidenceArtifact(artifact, `${path}.artifacts[${index}]`));
  array(value.facts, `${path}.facts`, "EvidenceBundle");
  value.facts.forEach((fact, index) => validateObservedFact(fact, `${path}.facts[${index}]`));
  const evidenceIds = [...value.artifacts, ...value.facts].map((item) => item.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) fail("EvidenceBundle", path, "artifact and fact ids must be globally unique");
  object(value.redaction, `${path}.redaction`, "EvidenceBundle");
  allowedKeys(value.redaction, ["rules", "replacements"], `${path}.redaction`, "EvidenceBundle");
  stringArray(value.redaction.rules, `${path}.redaction.rules`, "EvidenceBundle");
  number(value.redaction.replacements, `${path}.redaction.replacements`, "EvidenceBundle");
}

function validateObservedFact(value, path) {
  object(value, path, "EvidenceBundle");
  allowedKeys(value, ["id", "kind", "value"], path, "EvidenceBundle");
  string(value.id, `${path}.id`, "EvidenceBundle");
  string(value.kind, `${path}.kind`, "EvidenceBundle");
  present(value.value, `${path}.value`, "EvidenceBundle");
}

function validateEvidenceArtifact(value, path) {
  object(value, path, "EvidenceBundle");
  allowedKeys(value, ["id", "type", "contentType", "contentHash", "size", "storageRef"], path, "EvidenceBundle");
  string(value.id, `${path}.id`, "EvidenceBundle");
  oneOf(value.type, ["SCREENSHOT", "DOM_SNAPSHOT", "ARIA_SNAPSHOT", "VISIBLE_TEXT", "NETWORK_LOG", "CONSOLE_LOG", "TRACE", "ACTION_LOG"], `${path}.type`, "EvidenceBundle");
  string(value.contentType, `${path}.contentType`, "EvidenceBundle");
  string(value.contentHash, `${path}.contentHash`, "EvidenceBundle");
  number(value.size, `${path}.size`, "EvidenceBundle");
  string(value.storageRef, `${path}.storageRef`, "EvidenceBundle");
}

function validateEvidenceManifest(value, path) {
  object(value, path, "EvidenceManifest");
  allowedKeys(value, ["schemaVersion", "runId", "checkpoints"], path, "EvidenceManifest");
  exact(value.schemaVersion, EVIDENCE_MANIFEST_VERSION, `${path}.schemaVersion`, "EvidenceManifest");
  string(value.runId, `${path}.runId`, "EvidenceManifest");
  array(value.checkpoints, `${path}.checkpoints`, "EvidenceManifest");
  const checkpointIds = new Set();
  let previousStage = -1;
  value.checkpoints.forEach((checkpoint, index) => {
    const checkpointPath = `${path}.checkpoints[${index}]`;
    object(checkpoint, checkpointPath, "EvidenceManifest");
    allowedKeys(checkpoint, ["checkpointId", "stage", "evidenceBundleId", "evidenceBundleHash", "sealed", "contentHash", "producer"], checkpointPath, "EvidenceManifest");
    string(checkpoint.checkpointId, `${checkpointPath}.checkpointId`, "EvidenceManifest");
    if (checkpointIds.has(checkpoint.checkpointId)) fail("EvidenceManifest", `${checkpointPath}.checkpointId`, "must be unique");
    checkpointIds.add(checkpoint.checkpointId);
    oneOf(checkpoint.stage, runtimeStages, `${checkpointPath}.stage`, "EvidenceManifest");
    const stageIndex = runtimeStages.indexOf(checkpoint.stage);
    if (stageIndex < previousStage) fail("EvidenceManifest", `${checkpointPath}.stage`, "must be non-decreasing");
    previousStage = stageIndex;
    string(checkpoint.evidenceBundleId, `${checkpointPath}.evidenceBundleId`, "EvidenceManifest");
    string(checkpoint.evidenceBundleHash, `${checkpointPath}.evidenceBundleHash`, "EvidenceManifest");
    exact(checkpoint.sealed, true, `${checkpointPath}.sealed`, "EvidenceManifest");
    string(checkpoint.contentHash, `${checkpointPath}.contentHash`, "EvidenceManifest");
    object(checkpoint.producer, `${checkpointPath}.producer`, "EvidenceManifest");
    allowedKeys(checkpoint.producer, ["name", "version"], `${checkpointPath}.producer`, "EvidenceManifest");
    string(checkpoint.producer.name, `${checkpointPath}.producer.name`, "EvidenceManifest");
    string(checkpoint.producer.version, `${checkpointPath}.producer.version`, "EvidenceManifest");
    exact(checkpoint.contentHash, checkpointContentHash(checkpoint), `${checkpointPath}.contentHash`, "EvidenceManifest");
  });
}

function validateSemanticJudgeInput(value, path) {
  object(value, path, "SemanticJudgeInput");
  allowedKeys(value, ["schemaVersion", "qaIrId", "evidenceBundleId", "scenario", "expectations", "evidence"], path, "SemanticJudgeInput");
  exact(value.schemaVersion, SEMANTIC_JUDGE_INPUT_VERSION, `${path}.schemaVersion`, "SemanticJudgeInput");
  string(value.qaIrId, `${path}.qaIrId`, "SemanticJudgeInput");
  string(value.evidenceBundleId, `${path}.evidenceBundleId`, "SemanticJudgeInput");
  object(value.scenario, `${path}.scenario`, "SemanticJudgeInput");
  allowedKeys(value.scenario, ["id", "title"], `${path}.scenario`, "SemanticJudgeInput");
  string(value.scenario.id, `${path}.scenario.id`, "SemanticJudgeInput");
  string(value.scenario.title, `${path}.scenario.title`, "SemanticJudgeInput");
  array(value.expectations, `${path}.expectations`, "SemanticJudgeInput");
  const expectationIds = new Set();
  value.expectations.forEach((item, index) => {
    const itemPath = `${path}.expectations[${index}]`;
    object(item, itemPath, "SemanticJudgeInput");
    allowedKeys(item, ["id", "kind", "target", "expected", "text", "attribute"], itemPath, "SemanticJudgeInput");
    string(item.id, `${itemPath}.id`, "SemanticJudgeInput");
    if (expectationIds.has(item.id)) fail("SemanticJudgeInput", `${itemPath}.id`, "must be unique");
    expectationIds.add(item.id);
    string(item.kind, `${itemPath}.kind`, "SemanticJudgeInput");
    if (item.target !== undefined) validatePromptSemanticTarget(item.target, `${itemPath}.target`);
    for (const key of ["expected", "text", "attribute"]) if (item[key] !== undefined) present(item[key], `${itemPath}.${key}`, "SemanticJudgeInput");
  });
  array(value.evidence, `${path}.evidence`, "SemanticJudgeInput");
  const evidenceIds = new Set();
  value.evidence.forEach((item, index) => {
    const itemPath = `${path}.evidence[${index}]`;
    object(item, itemPath, "SemanticJudgeInput");
    allowedKeys(item, ["id", "kind", "content", "truncated"], itemPath, "SemanticJudgeInput");
    string(item.id, `${itemPath}.id`, "SemanticJudgeInput");
    if (evidenceIds.has(item.id)) fail("SemanticJudgeInput", `${itemPath}.id`, "must be unique");
    evidenceIds.add(item.id);
    string(item.kind, `${itemPath}.kind`, "SemanticJudgeInput");
    string(item.content, `${itemPath}.content`, "SemanticJudgeInput");
    bool(item.truncated, `${itemPath}.truncated`, "SemanticJudgeInput");
  });
}

function validatePromptSemanticTarget(value, path) {
  object(value, path, "SemanticJudgeInput");
  allowedKeys(value, ["role", "accessibleName", "text", "testId", "hints"], path, "SemanticJudgeInput");
  if (value.role !== undefined) string(value.role, `${path}.role`, "SemanticJudgeInput");
  if (value.accessibleName !== undefined) present(value.accessibleName, `${path}.accessibleName`, "SemanticJudgeInput");
  if (value.text !== undefined) present(value.text, `${path}.text`, "SemanticJudgeInput");
  if (value.testId !== undefined) string(value.testId, `${path}.testId`, "SemanticJudgeInput");
  if (value.hints !== undefined) {
    array(value.hints, `${path}.hints`, "SemanticJudgeInput");
    value.hints.forEach((hint, index) => {
      object(hint, `${path}.hints[${index}]`, "SemanticJudgeInput");
      allowedKeys(hint, ["adapter", "data"], `${path}.hints[${index}]`, "SemanticJudgeInput");
      string(hint.adapter, `${path}.hints[${index}].adapter`, "SemanticJudgeInput");
      present(hint.data, `${path}.hints[${index}].data`, "SemanticJudgeInput");
    });
  }
}

function validateSemanticJudgeDecision(value, path, context = {}) {
  object(value, path, "SemanticJudgeDecision");
  allowedKeys(value, ["schemaVersion", "expectationResults", "uncertainty", "judge"], path, "SemanticJudgeDecision");
  exact(value.schemaVersion, SEMANTIC_JUDGE_DECISION_VERSION, `${path}.schemaVersion`, "SemanticJudgeDecision");
  array(value.expectationResults, `${path}.expectationResults`, "SemanticJudgeDecision");
  const input = context.semanticJudgeInput;
  if (input) validateSemanticJudgeInput(input, "$.semanticJudgeInput");
  const evidenceIds = input ? new Set(input.evidence.map((item) => item.id)) : context.evidenceIds ? new Set(context.evidenceIds) : undefined;
  const expectationIds = input ? new Set(input.expectations.map((item) => item.id)) : context.expectationIds ? new Set(context.expectationIds) : undefined;
  const seen = new Set();
  value.expectationResults.forEach((item, index) => {
    const itemPath = `${path}.expectationResults[${index}]`;
    validateExpectationJudgment(item, itemPath, undefined, evidenceIds, "SemanticJudgeDecision", expectationIds);
    if (seen.has(item.expectationId)) fail("SemanticJudgeDecision", `${itemPath}.expectationId`, "must be unique");
    seen.add(item.expectationId);
  });
  array(value.uncertainty, `${path}.uncertainty`, "SemanticJudgeDecision");
  value.uncertainty.forEach((item, index) => {
    const itemPath = `${path}.uncertainty[${index}]`;
    object(item, itemPath, "SemanticJudgeDecision");
    allowedKeys(item, ["code", "description"], itemPath, "SemanticJudgeDecision");
    string(item.code, `${itemPath}.code`, "SemanticJudgeDecision");
    string(item.description, `${itemPath}.description`, "SemanticJudgeDecision");
  });
  object(value.judge, `${path}.judge`, "SemanticJudgeDecision");
  allowedKeys(value.judge, ["provider", "model", "modelVersion", "promptVersion"], `${path}.judge`, "SemanticJudgeDecision");
  for (const key of ["provider", "model", "promptVersion"]) string(value.judge[key], `${path}.judge.${key}`, "SemanticJudgeDecision");
  if (value.judge.modelVersion !== undefined) string(value.judge.modelVersion, `${path}.judge.modelVersion`, "SemanticJudgeDecision");
}

function validateJudgeResult(value, path, context) {
  object(value, path, "JudgeResult");
  allowedKeys(value, ["schemaVersion", "resultId", "qaIrId", "evidenceBundleId", "verdict", "confidence", "expectationResults", "uncertainty", "judge", "inputHash"], path, "JudgeResult");
  exact(value.schemaVersion, JUDGE_RESULT_VERSION, `${path}.schemaVersion`, "JudgeResult");
  for (const key of ["resultId", "qaIrId", "evidenceBundleId", "inputHash"]) string(value[key], `${path}.${key}`, "JudgeResult");
  if (context.qaIr) {
    validateQaIrDocument(context.qaIr, "$.qaIr");
    exact(value.qaIrId, context.qaIr.id, `${path}.qaIrId`, "JudgeResult");
  }
  oneOf(value.verdict, VERDICTS, `${path}.verdict`, "JudgeResult");
  probability(value.confidence, `${path}.confidence`, "JudgeResult");
  array(value.expectationResults, `${path}.expectationResults`, "JudgeResult");
  const evidenceIds = context.evidenceBundle ? collectEvidenceIds(context.evidenceBundle, value.evidenceBundleId) : undefined;
  value.expectationResults.forEach((item, index) => validateExpectationJudgment(item, `${path}.expectationResults[${index}]`, value.verdict, evidenceIds));
  array(value.uncertainty, `${path}.uncertainty`, "JudgeResult");
  value.uncertainty.forEach((item, index) => {
    object(item, `${path}.uncertainty[${index}]`, "JudgeResult");
    allowedKeys(item, ["code", "description"], `${path}.uncertainty[${index}]`, "JudgeResult");
    string(item.code, `${path}.uncertainty[${index}].code`, "JudgeResult");
    string(item.description, `${path}.uncertainty[${index}].description`, "JudgeResult");
  });
  object(value.judge, `${path}.judge`, "JudgeResult");
  allowedKeys(value.judge, ["provider", "model", "modelVersion", "promptVersion"], `${path}.judge`, "JudgeResult");
  for (const key of ["provider", "model", "promptVersion"]) string(value.judge[key], `${path}.judge.${key}`, "JudgeResult");
  if (value.judge.modelVersion !== undefined) string(value.judge.modelVersion, `${path}.judge.modelVersion`, "JudgeResult");
}

function validateExpectationJudgment(value, path, verdict, evidenceIds, contract = "JudgeResult", expectationIds) {
  object(value, path, contract);
  allowedKeys(value, ["expectationId", "status", "confidence", "evidenceRefs", "rationale"], path, contract);
  string(value.expectationId, `${path}.expectationId`, contract);
  if (expectationIds && !expectationIds.has(value.expectationId)) fail(contract, `${path}.expectationId`, `unknown expectation ${value.expectationId}`);
  oneOf(value.status, EXPECTATION_STATUSES, `${path}.status`, contract);
  probability(value.confidence, `${path}.confidence`, contract);
  stringArray(value.evidenceRefs, `${path}.evidenceRefs`, contract);
  string(value.rationale, `${path}.rationale`, contract);
  if (verdict === "PASS" && !["MATCHED", "NOT_APPLICABLE"].includes(value.status)) fail(contract, `${path}.status`, "PASS requires all applicable expectations to be matched");
  if (verdict !== "SKIP" && value.evidenceRefs.length === 0) fail(contract, `${path}.evidenceRefs`, "Every non-skipped expectation judgment requires evidence");
  if (evidenceIds) for (const ref of value.evidenceRefs) if (!evidenceIds.has(ref)) fail(contract, `${path}.evidenceRefs`, `unknown evidence ref ${ref}`);
}

function validateFailureDiagnosis(value, path, context = {}) {
  object(value, path, "FailureDiagnosis");
  allowedKeys(value, ["schemaVersion", "diagnosisId", "judgeResultId", "origin", "confidence", "symptom", "likelyCause", "supportingEvidenceRefs", "contradictingEvidenceRefs", "remediationEligible", "manualReviewReasons"], path, "FailureDiagnosis");
  exact(value.schemaVersion, FAILURE_DIAGNOSIS_VERSION, `${path}.schemaVersion`, "FailureDiagnosis");
  for (const key of ["diagnosisId", "judgeResultId"]) boundedString(value[key], 512, `${path}.${key}`, "FailureDiagnosis");
  boundedString(value.symptom, 4_096, `${path}.symptom`, "FailureDiagnosis");
  boundedString(value.likelyCause, 4_096, `${path}.likelyCause`, "FailureDiagnosis");
  oneOf(value.origin, failureOrigins, `${path}.origin`, "FailureDiagnosis");
  probability(value.confidence, `${path}.confidence`, "FailureDiagnosis");
  uniqueStringArray(value.supportingEvidenceRefs, `${path}.supportingEvidenceRefs`, "FailureDiagnosis");
  uniqueStringArray(value.contradictingEvidenceRefs, `${path}.contradictingEvidenceRefs`, "FailureDiagnosis");
  bool(value.remediationEligible, `${path}.remediationEligible`, "FailureDiagnosis");
  uniqueStringArray(value.manualReviewReasons, `${path}.manualReviewReasons`, "FailureDiagnosis");
  value.supportingEvidenceRefs.forEach((ref, index) => boundedString(ref, 512, `${path}.supportingEvidenceRefs[${index}]`, "FailureDiagnosis"));
  value.contradictingEvidenceRefs.forEach((ref, index) => boundedString(ref, 512, `${path}.contradictingEvidenceRefs[${index}]`, "FailureDiagnosis"));
  value.manualReviewReasons.forEach((reason, index) => boundedString(reason, 2_000, `${path}.manualReviewReasons[${index}]`, "FailureDiagnosis"));
  if (value.supportingEvidenceRefs.length > 100 || value.contradictingEvidenceRefs.length > 100) fail("FailureDiagnosis", path, "must reference at most 100 evidence items per category");
  if (value.manualReviewReasons.length > 20) fail("FailureDiagnosis", `${path}.manualReviewReasons`, "must contain at most 20 reasons");
  if (value.supportingEvidenceRefs.some((ref) => value.contradictingEvidenceRefs.includes(ref))) fail("FailureDiagnosis", path, "supporting and contradicting evidence must be disjoint");
  if (value.remediationEligible && value.supportingEvidenceRefs.length === 0) fail("FailureDiagnosis", `${path}.supportingEvidenceRefs`, "eligible remediation requires evidence");
  if (["UNKNOWN", "ENVIRONMENT", "THIRD_PARTY"].includes(value.origin)) {
    if (value.remediationEligible) fail("FailureDiagnosis", `${path}.remediationEligible`, `${value.origin} diagnoses cannot auto-patch`);
    if (value.manualReviewReasons.length === 0) fail("FailureDiagnosis", `${path}.manualReviewReasons`, `${value.origin} diagnoses require manual review`);
  }
  if (context.judgeResult) {
    validateJudgeResult(context.judgeResult, "$.judgeResult", context);
    exact(value.judgeResultId, context.judgeResult.resultId, `${path}.judgeResultId`, "FailureDiagnosis");
  }
  if (context.evidenceBundle) {
    validateEvidenceBundle(context.evidenceBundle, "$.evidenceBundle");
    const evidenceIds = collectEvidenceIds(context.evidenceBundle, context.evidenceBundle.bundleId);
    for (const ref of [...value.supportingEvidenceRefs, ...value.contradictingEvidenceRefs]) {
      if (!evidenceIds.has(ref)) fail("FailureDiagnosis", path, `unknown evidence ref ${ref}`);
    }
  }
}

function validateCodeContextBundle(value, path) {
  object(value, path, "CodeContextBundle");
  allowedKeys(value, ["schemaVersion", "bundleId", "repositoryId", "revision", "failureDiagnosisId", "candidates", "snippets", "searchAudit"], path, "CodeContextBundle");
  exact(value.schemaVersion, CODE_CONTEXT_VERSION, `${path}.schemaVersion`, "CodeContextBundle");
  for (const key of ["bundleId", "repositoryId", "failureDiagnosisId"]) boundedString(value[key], 512, `${path}.${key}`, "CodeContextBundle");
  boundedString(value.revision, 128, `${path}.revision`, "CodeContextBundle");
  array(value.candidates, `${path}.candidates`, "CodeContextBundle");
  if (value.candidates.length > 10) fail("CodeContextBundle", `${path}.candidates`, "must contain at most 10 candidates");
  value.candidates.forEach((candidate, index) => validateCodeCandidate(candidate, `${path}.candidates[${index}]`));
  const candidateKeys = value.candidates.map((candidate) => JSON.stringify([candidate.path, candidate.symbol, candidate.range]));
  if (new Set(candidateKeys).size !== candidateKeys.length) fail("CodeContextBundle", `${path}.candidates`, "must be unique");
  array(value.snippets, `${path}.snippets`, "CodeContextBundle");
  if (value.snippets.length > 10) fail("CodeContextBundle", `${path}.snippets`, "must contain at most 10 snippets");
  value.snippets.forEach((snippet, index) => validateCodeSnippet(snippet, `${path}.snippets[${index}]`));
  if (value.snippets.reduce((total, snippet) => total + snippet.text.length, 0) > 131_072) fail("CodeContextBundle", `${path}.snippets`, "combined snippet text is too large");
  const candidatePaths = new Set(value.candidates.map((candidate) => candidate.path));
  const snippetPaths = value.snippets.map((snippet) => snippet.path);
  if (new Set(snippetPaths).size !== snippetPaths.length) fail("CodeContextBundle", `${path}.snippets`, "must contain at most one snippet per path");
  if (snippetPaths.some((snippetPath) => !candidatePaths.has(snippetPath))) fail("CodeContextBundle", `${path}.snippets`, "must belong to a candidate path");
  object(value.searchAudit, `${path}.searchAudit`, "CodeContextBundle");
  allowedKeys(value.searchAudit, ["queries", "strategies"], `${path}.searchAudit`, "CodeContextBundle");
  array(value.searchAudit.queries, `${path}.searchAudit.queries`, "CodeContextBundle");
  if (value.searchAudit.queries.length > 20) fail("CodeContextBundle", `${path}.searchAudit.queries`, "must contain at most 20 queries");
  value.searchAudit.queries.forEach((query, index) => {
    const queryPath = `${path}.searchAudit.queries[${index}]`;
    object(query, queryPath, "CodeContextBundle");
    allowedKeys(query, ["term", "reason"], queryPath, "CodeContextBundle");
    boundedString(query.term, 200, `${queryPath}.term`, "CodeContextBundle");
    oneOf(query.reason, codeMatchReasons, `${queryPath}.reason`, "CodeContextBundle");
  });
  const queryKeys = value.searchAudit.queries.map((query) => `${query.reason}\0${query.term}`);
  if (new Set(queryKeys).size !== queryKeys.length) fail("CodeContextBundle", `${path}.searchAudit.queries`, "must be unique");
  uniqueStringArray(value.searchAudit.strategies, `${path}.searchAudit.strategies`, "CodeContextBundle");
  if (value.searchAudit.strategies.length > 10) fail("CodeContextBundle", `${path}.searchAudit.strategies`, "must contain at most 10 strategies");
  value.searchAudit.strategies.forEach((strategy, index) => boundedString(strategy, 100, `${path}.searchAudit.strategies[${index}]`, "CodeContextBundle"));
}

function validateCodeCandidate(value, path) {
  object(value, path, "CodeContextBundle");
  allowedKeys(value, ["path", "symbol", "range", "relevanceScore", "matchReasons"], path, "CodeContextBundle");
  repositoryPath(value.path, `${path}.path`, "CodeContextBundle");
  if (value.symbol !== undefined) boundedString(value.symbol, 512, `${path}.symbol`, "CodeContextBundle");
  if (value.range !== undefined) validateSourceRange(value.range, `${path}.range`, "CodeContextBundle");
  probability(value.relevanceScore, `${path}.relevanceScore`, "CodeContextBundle");
  array(value.matchReasons, `${path}.matchReasons`, "CodeContextBundle");
  value.matchReasons.forEach((reason, index) => oneOf(reason, codeMatchReasons, `${path}.matchReasons[${index}]`, "CodeContextBundle"));
  if (value.matchReasons.length === 0 || new Set(value.matchReasons).size !== value.matchReasons.length) fail("CodeContextBundle", `${path}.matchReasons`, "must contain unique match reasons");
}

function validateCodeSnippet(value, path) {
  object(value, path, "CodeContextBundle");
  allowedKeys(value, ["path", "range", "text", "contentHash"], path, "CodeContextBundle");
  repositoryPath(value.path, `${path}.path`, "CodeContextBundle");
  validateSourceRange(value.range, `${path}.range`, "CodeContextBundle");
  boundedString(value.text, 32_768, `${path}.text`, "CodeContextBundle");
  string(value.contentHash, `${path}.contentHash`, "CodeContextBundle");
  if (!/^sha256:[0-9a-f]{64}$/i.test(value.contentHash)) fail("CodeContextBundle", `${path}.contentHash`, "must be a sha256 hash");
  if (value.range.end.line - value.range.start.line + 1 > 120) fail("CodeContextBundle", `${path}.range`, "must contain at most 120 lines");
}

function validateRepairRecommendation(value, path, context = {}) {
  object(value, path, "RepairRecommendation");
  allowedKeys(value, ["schemaVersion", "recommendationId", "diagnosisId", "repositoryRevision", "title", "severity", "summary", "rootCause", "confidence", "locations", "changes", "verificationPlan", "evidenceRefs", "codeContextRefs", "patchEligibility"], path, "RepairRecommendation");
  exact(value.schemaVersion, REPAIR_RECOMMENDATION_VERSION, `${path}.schemaVersion`, "RepairRecommendation");
  for (const key of ["recommendationId", "diagnosisId"]) boundedString(value[key], 512, `${path}.${key}`, "RepairRecommendation");
  boundedString(value.repositoryRevision, 128, `${path}.repositoryRevision`, "RepairRecommendation");
  boundedString(value.title, 500, `${path}.title`, "RepairRecommendation");
  boundedString(value.summary, 4_096, `${path}.summary`, "RepairRecommendation");
  boundedString(value.rootCause, 4_096, `${path}.rootCause`, "RepairRecommendation");
  oneOf(value.severity, ["BLOCKER", "HIGH", "MEDIUM", "LOW"], `${path}.severity`, "RepairRecommendation");
  probability(value.confidence, `${path}.confidence`, "RepairRecommendation");
  array(value.locations, `${path}.locations`, "RepairRecommendation");
  if (value.locations.length > 10) fail("RepairRecommendation", `${path}.locations`, "must contain at most 10 locations");
  value.locations.forEach((location, index) => {
    const locationPath = `${path}.locations[${index}]`;
    object(location, locationPath, "RepairRecommendation");
    allowedKeys(location, ["path", "symbol", "range", "reason"], locationPath, "RepairRecommendation");
    repositoryPath(location.path, `${locationPath}.path`, "RepairRecommendation");
    if (location.symbol !== undefined) boundedString(location.symbol, 512, `${locationPath}.symbol`, "RepairRecommendation");
    if (location.range !== undefined) validateSourceRange(location.range, `${locationPath}.range`, "RepairRecommendation");
    boundedString(location.reason, 1_000, `${locationPath}.reason`, "RepairRecommendation");
  });
  array(value.changes, `${path}.changes`, "RepairRecommendation");
  if (value.changes.length > 10) fail("RepairRecommendation", `${path}.changes`, "must contain at most 10 changes");
  value.changes.forEach((change, index) => {
    const changePath = `${path}.changes[${index}]`;
    object(change, changePath, "RepairRecommendation");
    allowedKeys(change, ["path", "recommendation", "expectedEffect", "risks"], changePath, "RepairRecommendation");
    repositoryPath(change.path, `${changePath}.path`, "RepairRecommendation");
    boundedString(change.recommendation, 4_096, `${changePath}.recommendation`, "RepairRecommendation");
    boundedString(change.expectedEffect, 4_096, `${changePath}.expectedEffect`, "RepairRecommendation");
    uniqueStringArray(change.risks, `${changePath}.risks`, "RepairRecommendation");
    if (change.risks.length > 20) fail("RepairRecommendation", `${changePath}.risks`, "must contain at most 20 risks");
    change.risks.forEach((risk, riskIndex) => boundedString(risk, 2_000, `${changePath}.risks[${riskIndex}]`, "RepairRecommendation"));
  });
  array(value.verificationPlan, `${path}.verificationPlan`, "RepairRecommendation");
  if (value.verificationPlan.length > 20) fail("RepairRecommendation", `${path}.verificationPlan`, "must contain at most 20 steps");
  value.verificationPlan.forEach((step, index) => {
    const stepPath = `${path}.verificationPlan[${index}]`;
    object(step, stepPath, "RepairRecommendation");
    allowedKeys(step, ["command", "purpose"], stepPath, "RepairRecommendation");
    boundedString(step.command, 1_000, `${stepPath}.command`, "RepairRecommendation");
    boundedString(step.purpose, 2_000, `${stepPath}.purpose`, "RepairRecommendation");
  });
  uniqueStringArray(value.evidenceRefs, `${path}.evidenceRefs`, "RepairRecommendation");
  uniqueStringArray(value.codeContextRefs, `${path}.codeContextRefs`, "RepairRecommendation");
  if (value.evidenceRefs.length > 100 || value.codeContextRefs.length > 10) fail("RepairRecommendation", path, "contains too many references");
  value.evidenceRefs.forEach((ref, index) => boundedString(ref, 512, `${path}.evidenceRefs[${index}]`, "RepairRecommendation"));
  value.codeContextRefs.forEach((ref, index) => boundedString(ref, 512, `${path}.codeContextRefs[${index}]`, "RepairRecommendation"));
  oneOf(value.patchEligibility, ["SUGGESTION_ONLY", "PATCH_ALLOWED", "MANUAL_REVIEW_REQUIRED"], `${path}.patchEligibility`, "RepairRecommendation");
  if (value.patchEligibility === "PATCH_ALLOWED" && context.patchGateVerified !== true) fail("RepairRecommendation", `${path}.patchEligibility`, "PATCH_ALLOWED requires a verified patch gate");
  if (context.diagnosis) {
    validateFailureDiagnosis(context.diagnosis, "$.diagnosis");
    exact(value.diagnosisId, context.diagnosis.diagnosisId, `${path}.diagnosisId`, "RepairRecommendation");
    const diagnosisEvidence = new Set([...context.diagnosis.supportingEvidenceRefs, ...context.diagnosis.contradictingEvidenceRefs]);
    if (value.evidenceRefs.some((ref) => !diagnosisEvidence.has(ref))) fail("RepairRecommendation", `${path}.evidenceRefs`, "must come from the diagnosis");
    if (!context.diagnosis.remediationEligible && value.patchEligibility !== "MANUAL_REVIEW_REQUIRED") fail("RepairRecommendation", `${path}.patchEligibility`, "ineligible diagnoses require manual review");
  }
  if (context.codeContext) {
    validateCodeContextBundle(context.codeContext, "$.codeContext");
    exact(value.repositoryRevision, context.codeContext.revision, `${path}.repositoryRevision`, "RepairRecommendation");
    if (!value.codeContextRefs.includes(context.codeContext.bundleId)) fail("RepairRecommendation", `${path}.codeContextRefs`, "must reference the CodeContextBundle");
    const candidatePaths = new Set(context.codeContext.candidates.map((candidate) => candidate.path));
    if (value.locations.some((location) => !candidatePaths.has(location.path)) || value.changes.some((change) => !candidatePaths.has(change.path))) {
      fail("RepairRecommendation", path, "locations and changes must come from CodeContext candidates");
    }
    if (context.diagnosis) exact(context.codeContext.failureDiagnosisId, context.diagnosis.diagnosisId, "$.codeContext.failureDiagnosisId", "RepairRecommendation");
  }
}

function validateSourceProvenance(value, path, contract) {
  object(value, path, contract);
  allowedKeys(value, ["repository", "revision", "path", "range", "symbol", "adapter", "contentHash"], path, contract);
  if (value.repository !== undefined) string(value.repository, `${path}.repository`, contract);
  if (value.revision !== undefined) string(value.revision, `${path}.revision`, contract);
  string(value.path, `${path}.path`, contract);
  validateSourceRange(value.range, `${path}.range`, contract);
  if (value.symbol !== undefined) string(value.symbol, `${path}.symbol`, contract);
  object(value.adapter, `${path}.adapter`, contract);
  allowedKeys(value.adapter, ["name", "version"], `${path}.adapter`, contract);
  string(value.adapter.name, `${path}.adapter.name`, contract);
  string(value.adapter.version, `${path}.adapter.version`, contract);
  string(value.contentHash, `${path}.contentHash`, contract);
}

function validateSourceRange(value, path, contract) {
  object(value, path, contract);
  allowedKeys(value, ["start", "end"], path, contract);
  for (const edge of ["start", "end"]) {
    const edgePath = `${path}.${edge}`;
    object(value[edge], edgePath, contract);
    allowedKeys(value[edge], ["line", "column", "offset"], edgePath, contract);
    number(value[edge].line, `${edgePath}.line`, contract);
    number(value[edge].column, `${edgePath}.column`, contract);
    if (!Number.isInteger(value[edge].line) || value[edge].line < 1) fail(contract, `${edgePath}.line`, "must be a positive integer");
    if (!Number.isInteger(value[edge].column) || value[edge].column < 1) fail(contract, `${edgePath}.column`, "must be a positive integer");
    if (value[edge].offset !== undefined) {
      number(value[edge].offset, `${edgePath}.offset`, contract);
      if (!Number.isInteger(value[edge].offset) || value[edge].offset < 0) fail(contract, `${edgePath}.offset`, "must be a non-negative integer");
    }
  }
  if (value.end.line < value.start.line || (value.end.line === value.start.line && value.end.column < value.start.column)) fail(contract, path, "end must not precede start");
}

function checkpointContentHash(checkpoint) {
  return canonicalHash({
    checkpointId: checkpoint.checkpointId,
    stage: checkpoint.stage,
    evidenceBundleId: checkpoint.evidenceBundleId,
    evidenceBundleHash: checkpoint.evidenceBundleHash,
    sealed: checkpoint.sealed,
    producer: checkpoint.producer,
  });
}

function collectEvidenceIds(bundle, expectedBundleId) {
  validateEvidenceBundle(bundle, "$.evidenceBundle");
  exact(bundle.bundleId, expectedBundleId, "$.evidenceBundle.bundleId", "JudgeResult");
  return new Set([
    ...bundle.artifacts.map((artifact) => artifact.id),
    ...bundle.facts.filter((fact) => fact.id !== undefined).map((fact) => fact.id),
  ]);
}

function diagnostics(value, path, contract) { array(value, path, contract); value.forEach((item, index) => validateDiagnostic(item, `${path}[${index}]`)); }
function recordArray(value, path, contract) { array(value, path, contract); value.forEach((item, index) => object(item, `${path}[${index}]`, contract)); }
function allowedKeys(value, allowed, path, contract) { rejectKeys(value, Object.keys(value).filter((key) => !allowed.includes(key)), path, contract); }
function rejectKeys(value, keys, path, contract) { for (const key of keys) if (Object.hasOwn(value, key)) fail(contract, `${path}.${key}`, "is not allowed"); }
function object(value, path, contract) { if (!isRecord(value)) fail(contract, path, "must be an object"); }
function array(value, path, contract) { if (!Array.isArray(value)) fail(contract, path, "must be an array"); }
function stringArray(value, path, contract) { array(value, path, contract); value.forEach((item, index) => string(item, `${path}[${index}]`, contract)); }
function uniqueStringArray(value, path, contract) { stringArray(value, path, contract); if (new Set(value).size !== value.length) fail(contract, path, "must contain unique strings"); }
function string(value, path, contract) { if (typeof value !== "string" || value.length === 0) fail(contract, path, "must be a non-empty string"); }
function boundedString(value, maxLength, path, contract) { string(value, path, contract); if (value.length > maxLength) fail(contract, path, `must contain at most ${maxLength} characters`); }
function repositoryPath(value, path, contract) { boundedString(value, 4_096, path, contract); if (/^(?:[a-z]:[\\/]|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)|[\0\r\n]/i.test(value)) fail(contract, path, "must be a safe repository-relative path"); }
function number(value, path, contract) { if (typeof value !== "number" || Number.isNaN(value)) fail(contract, path, "must be a number"); }
function probability(value, path, contract) { number(value, path, contract); if (!Number.isFinite(value) || value < 0 || value > 1) fail(contract, path, "must be between 0 and 1"); }
function bool(value, path, contract) { if (typeof value !== "boolean") fail(contract, path, "must be a boolean"); }
function present(value, path, contract) { if (value === undefined) fail(contract, path, "is required"); }
function exact(value, expected, path, contract) { if (value !== expected) fail(contract, path, `must equal ${JSON.stringify(expected)}`); }
function oneOf(value, allowed, path, contract) { if (!allowed.includes(value)) fail(contract, path, `must be one of: ${allowed.join(", ")}`); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(contract, path, message) { throw new ContractViolationError(contract, message, path); }
