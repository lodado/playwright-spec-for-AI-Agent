import { createHash } from "node:crypto";

export const CONTRACT_VIOLATION = "CONTRACT_VIOLATION";
export const ARTIFACT_VERSION = "artifact/0.1";
export const QA_IR_VERSION = "qa-ir/0.2";
export const COMPILE_RESULT_VERSION = "compile-result/0.1";
export const DIAGNOSTIC_VERSION = "diagnostic/0.1";
export const PROVIDER_CAPABILITIES_VERSION = "provider-capabilities/0.1";
export const EXECUTION_PLAN_VERSION = "execution-plan/0.2";
export const EXECUTION_AGENT_INPUT_VERSION = "execution-agent-input/0.3";
export const EXECUTION_ACTION_PROPOSAL_VERSION = "execution-action-proposal/0.2";
export const EXECUTION_ACTION_RESULT_VERSION = "execution-action-result/0.1";
export const EXECUTION_AGENT_OUTCOME_VERSION = "execution-agent-outcome/0.1";
export const RUNTIME_OUTCOME_VERSION = "runtime-outcome/0.1";
export const RUN_ENVELOPE_VERSION = "run-envelope/0.2";
export const DETERMINISTIC_EVALUATION_VERSION = "deterministic-evaluation/0.1";
export const EVIDENCE_BUNDLE_VERSION = "evidence-bundle/0.1";
export const EVIDENCE_MANIFEST_VERSION = "evidence-manifest/0.1";
export const JUDGE_RESULT_VERSION = "judge-result/0.1";
export const SEMANTIC_JUDGE_INPUT_VERSION = "semantic-judge-input/0.2";
export const SEMANTIC_JUDGE_DECISION_VERSION = "semantic-judge-decision/0.1";
export const FAILURE_DIAGNOSIS_VERSION = "failure-diagnosis/0.1";
export const CODE_CONTEXT_VERSION = "code-context/0.1";
export const REPAIR_RECOMMENDATION_VERSION = "repair-recommendation/0.1";
export const PATCH_PROPOSAL_VERSION = "patch-proposal/0.1";
export const PATCH_APPLICATION_RESULT_VERSION = "patch-application-result/0.1";
export const VERIFICATION_RESULT_VERSION = "verification-result/0.1";
export const EVIDENCE_COMPARISON_VERSION = "evidence-comparison/0.1";
export const EXPECTATION_INTEGRITY_RESULT_VERSION = "expectation-integrity-result/0.1";
export const INDEPENDENT_REMEDIATION_REVIEW_VERSION = "independent-remediation-review/0.1";
export const PUBLICATION_DECISION_VERSION = "publication-decision/0.1";
export const GITHUB_PUBLICATION_RESULT_VERSION = "github-publication-result/0.2";

export const VERDICTS = Object.freeze(["PASS", "FAIL", "SKIP", "MANUAL_REVIEW"]);
export const EXPECTATION_STATUSES = Object.freeze(["MATCHED", "CONTRADICTED", "NOT_OBSERVED", "AMBIGUOUS", "NOT_APPLICABLE"]);
export const MILESTONE_CLASSES = Object.freeze(["REQUIRED_EXACT_ACTION", "REQUIRED_SEMANTIC_MILESTONE", "OPTIONAL_HINT"]);
// The single adaptive action vocabulary. Every consumer derives from this table instead of
// keeping its own copy of the action names: lease building and safe-recovery filtering (core),
// milestone semantics (core milestoneCompletionRule via provesSemantic), the gateway dispatch
// guard (provider-playwright), the prompt prose (provider-hermes via params), parameter key
// validation (validateAdaptiveActionParameters below), element-bound action lists, and the audit
// artifact shape (auditArtifactShape via extraArtifacts). Adding an action here reaches all of
// them; the per-action *value* rules (URL shape, non-zero scroll, etc.) still live in the
// validator, which is their single authority.
//   params          — ordered parameter key names (drives allowedKeys + prompt prose)
//   requiresPolicy  — scenario policy gate for lease inclusion ("navigation" | "click")
//   recovery        — offered as a safe-recovery action to the authorizer
//   elementBound    — may be listed as an observed element's allowedAction
//   provesSemantic  — proves a semantic milestone: true, or the allowed wait states
//   terminal        — ends the run (report_blocked)
//   extraArtifacts  — audit artifact types sealed beyond the five snapshots
const NO_PARAMS = Object.freeze([]);
const OBSERVED_ELEMENT_PARAMS = Object.freeze(["observationId", "elementId"]);
export const ACTION_SPECS = Object.freeze({
  observe_dom:            Object.freeze({ params: NO_PARAMS, recovery: true, provesSemantic: true }),
  observe_aria:           Object.freeze({ params: NO_PARAMS, recovery: true, provesSemantic: true }),
  get_current_url:        Object.freeze({ params: NO_PARAMS, recovery: true }),
  navigate:               Object.freeze({ params: Object.freeze(["url"]), requiresPolicy: "navigation" }),
  click_observed_element: Object.freeze({ params: OBSERVED_ELEMENT_PARAMS, requiresPolicy: "click", recovery: true, elementBound: true }),
  press_key:              Object.freeze({ params: Object.freeze(["key"]), requiresPolicy: "click", recovery: true }),
  hover_observed_element: Object.freeze({ params: OBSERVED_ELEMENT_PARAMS, requiresPolicy: "click", recovery: true, elementBound: true }),
  scroll_view:            Object.freeze({ params: Object.freeze(["deltaX", "deltaY"]), recovery: true }),
  wait_for_element_state: Object.freeze({ params: Object.freeze(["observationId", "elementId", "state", "timeoutMs"]), recovery: true, elementBound: true, provesSemantic: Object.freeze(["present", "visible"]) }),
  go_back:                Object.freeze({ params: NO_PARAMS, requiresPolicy: "navigation" }),
  reload_page:            Object.freeze({ params: NO_PARAMS, requiresPolicy: "navigation" }),
  report_blocked:         Object.freeze({ params: Object.freeze(["milestoneId", "reason"]), recovery: true, terminal: true, extraArtifacts: Object.freeze(["VISIBLE_TEXT"]) }),
});
export const ADAPTIVE_ACTIONS = Object.freeze(Object.keys(ACTION_SPECS));
export const ELEMENT_BOUND_ACTIONS = Object.freeze(ADAPTIVE_ACTIONS.filter((action) => ACTION_SPECS[action].elementBound));
// Single definition of what a sealed adaptive audit looks like. The provider builds each audit
// from this shape and the evidence validator counts against it — neither side keeps its own copy
// of "exactly five snapshots plus, for report_blocked, one VISIBLE_TEXT". Optional types are
// per-audit 0-or-1.
const AUDIT_REQUIRED_ARTIFACTS = Object.freeze([
  Object.freeze({ suffix: "before:dom", type: "DOM_SNAPSHOT" }),
  Object.freeze({ suffix: "before:aria", type: "ARIA_SNAPSHOT" }),
  Object.freeze({ suffix: "action", type: "ACTION_LOG" }),
  Object.freeze({ suffix: "after:dom", type: "DOM_SNAPSHOT" }),
  Object.freeze({ suffix: "after:aria", type: "ARIA_SNAPSHOT" }),
]);

export function auditArtifactShape(action) {
  return Object.freeze({ required: AUDIT_REQUIRED_ARTIFACTS, optional: ACTION_SPECS[action]?.extraArtifacts ?? NO_PARAMS });
}

export const RUNTIME_ERROR_CODES = Object.freeze([
  "BROWSER_START_FAILED",
  "AUTHENTICATION_FAILED",
  CONTRACT_VIOLATION,
  "EVIDENCE_STORAGE_FAILED",
  "MODEL_PROVIDER_FAILED",
  "POLICY_VIOLATION",
  "UNKNOWN_RUNTIME_ERROR",
]);

const runtimeStages = ["compile", "plan", "execute", "evidence", "evaluate", "judge", "diagnose", "report", "propose-patch", "apply-patch", "verify-patch"];
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
  ExecutionAgentInput: validateExecutionAgentInput,
  ExecutionActionProposal: validateExecutionActionProposal,
  ExecutionActionResult: validateExecutionActionResult,
  ExecutionAgentOutcome: validateExecutionAgentOutcome,
  RuntimeOutcome: validateRuntimeOutcome,
  RunEnvelope: validateRunEnvelope,
  DeterministicEvaluationResult: validateDeterministicEvaluationResult,
  EvidenceBundle: validateEvidenceBundle,
  EvidenceManifest: validateEvidenceManifest,
  JudgeResult: validateJudgeResult,
  SemanticJudgeInput: validateSemanticJudgeInput,
  SemanticJudgeDecision: validateSemanticJudgeDecision,
  FailureDiagnosis: validateFailureDiagnosis,
  CodeContextBundle: validateCodeContextBundle,
  RepairRecommendation: validateRepairRecommendation,
  PatchProposal: validatePatchProposal,
  PatchApplicationResult: validatePatchApplicationResult,
  VerificationResult: validateVerificationResult,
  EvidenceComparison: validateEvidenceComparison,
  ExpectationIntegrityResult: validateExpectationIntegrityResult,
  IndependentRemediationReview: validateIndependentRemediationReview,
  PublicationDecision: validatePublicationDecision,
  GitHubPublicationResult: validateGitHubPublicationResult,
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

export function snapshotContract(contract, value, context = {}) {
  validateContract(contract, value, context);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail(contract, "$", "must be JSON-serializable");
  const snapshot = JSON.parse(serialized);
  validateContract(contract, snapshot, context);
  return deepFreeze(snapshot);
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
  array(value.expectations, `${path}.expectations`, "QaIrDocument");
  value.expectations.forEach((expectation, index) => {
    const expectationPath = `${path}.expectations[${index}]`;
    object(expectation, expectationPath, "QaIrDocument");
    allowedKeys(expectation, ["id", "kind", "target", "expected", "url", "value", "text", "attribute", "provenance"], expectationPath, "QaIrDocument");
    string(expectation.id, `${expectationPath}.id`, "QaIrDocument");
    oneOf(expectation.kind, ["CONTAINS_TEXT", "VISIBLE", "NOT_VISIBLE", "PRESENT", "DISABLED", "ROLE", "NAME", "ATTRIBUTE", "URL", "URL_MATCH", "VISIBLE_TEXT", "VISUAL_CONSISTENCY", "VISUAL_STABILITY"], `${expectationPath}.kind`, "QaIrDocument");
    if (expectation.target !== undefined) validateSemanticTarget(expectation.target, `${expectationPath}.target`);
    if (expectation.provenance !== undefined) {
      array(expectation.provenance, `${expectationPath}.provenance`, "QaIrDocument");
      expectation.provenance.forEach((item, provenanceIndex) => validateSourceProvenance(item, `${expectationPath}.provenance[${provenanceIndex}]`, "QaIrDocument"));
    }
  });
  const expectationIds = value.expectations.map((expectation) => expectation.id);
  if (new Set(expectationIds).size !== expectationIds.length) fail("QaIrDocument", `${path}.expectations`, "expectation ids must be unique within a scenario");
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
    allowedKeys(value, ["id", "kind", "milestoneClass", "target"], path, "QaIrDocument");
    exact(value.milestoneClass, "REQUIRED_SEMANTIC_MILESTONE", `${path}.milestoneClass`, "QaIrDocument");
    object(value.target, `${path}.target`, "QaIrDocument");
    allowedKeys(value.target, ["type", "value"], `${path}.target`, "QaIrDocument");
    oneOf(value.target.type, ["PATH", "URL"], `${path}.target.type`, "QaIrDocument");
    string(value.target.value, `${path}.target.value`, "QaIrDocument");
  } else if (value.kind === "INTERACT") {
    allowedKeys(value, ["id", "kind", "milestoneClass", "action", "target", "value"], path, "QaIrDocument");
    exact(value.milestoneClass, "REQUIRED_EXACT_ACTION", `${path}.milestoneClass`, "QaIrDocument");
    oneOf(value.action, ["CLICK", "TYPE", "UPLOAD", "SELECT", "PRESS"], `${path}.action`, "QaIrDocument");
    validateSemanticTarget(value.target, `${path}.target`);
  } else if (value.kind === "OBSERVE") {
    allowedKeys(value, ["id", "kind", "requests"], path, "QaIrDocument");
    array(value.requests, `${path}.requests`, "QaIrDocument");
    value.requests.forEach((request, index) => {
      const requestPath = `${path}.requests[${index}]`;
      object(request, requestPath, "QaIrDocument");
      allowedKeys(request, ["type"], requestPath, "QaIrDocument");
      oneOf(request.type, ["SCREENSHOT", "DOM_SNAPSHOT", "ARIA_SNAPSHOT", "VISIBLE_TEXT", "NETWORK_LOG", "CONSOLE_LOG", "TRACE", "ACTION_LOG", "ELEMENT_OBSERVATION"], `${requestPath}.type`, "QaIrDocument");
    });
    const requestTypes = value.requests.map((request) => request.type);
    if (new Set(requestTypes).size !== requestTypes.length) fail("QaIrDocument", `${path}.requests`, "request types must be unique within an observation step");
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

function validateSemanticTarget(value, path, contract = "QaIrDocument") {
  object(value, path, contract);
  allowedKeys(value, ["role", "accessibleName", "text", "testId", "hints"], path, contract);
  if (value.role !== undefined) boundedString(value.role, 256, `${path}.role`, contract);
  if (value.accessibleName !== undefined) validateSemanticMatch(value.accessibleName, `${path}.accessibleName`, contract);
  if (value.text !== undefined) validateSemanticMatch(value.text, `${path}.text`, contract);
  if (value.testId !== undefined) boundedString(value.testId, 1_024, `${path}.testId`, contract);
  if (value.role === undefined && value.accessibleName === undefined && value.text === undefined && value.testId === undefined) fail(contract, path, "requires a role, accessibleName, text, or testId identity");
  if (value.hints !== undefined) {
    array(value.hints, `${path}.hints`, contract);
    value.hints.forEach((hint, index) => {
      object(hint, `${path}.hints[${index}]`, contract);
      allowedKeys(hint, ["adapter", "data"], `${path}.hints[${index}]`, contract);
      string(hint.adapter, `${path}.hints[${index}].adapter`, contract);
      present(hint.data, `${path}.hints[${index}].data`, contract);
      const serialized = JSON.stringify(hint.data);
      if (serialized === undefined || serialized.length > 4_096) fail(contract, `${path}.hints[${index}].data`, "must be bounded JSON data");
    });
  }
}

function validateSemanticMatch(value, path, contract) {
  object(value, path, contract);
  allowedKeys(value, ["kind", "value"], path, contract);
  oneOf(value.kind, ["literal", "regex"], `${path}.kind`, contract);
  boundedString(value.value, 4_096, `${path}.value`, contract);
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
  value.nodes.forEach((node, index) => {
    const nodePath = `${path}.nodes[${index}]`;
    object(node, nodePath, "ExecutionPlan");
    allowedKeys(node, ["nodeId", "suiteId", "scenarioId", "stepId", "kind", "milestoneClass", "action", "evidence", "policy"], nodePath, "ExecutionPlan");
    string(node.nodeId, `${nodePath}.nodeId`, "ExecutionPlan");
    string(node.suiteId, `${nodePath}.suiteId`, "ExecutionPlan");
    string(node.scenarioId, `${nodePath}.scenarioId`, "ExecutionPlan");
    string(node.stepId, `${nodePath}.stepId`, "ExecutionPlan");
    oneOf(node.kind, ["NAVIGATE", "INTERACT", "OBSERVE", "CHECKPOINT"], `${nodePath}.kind`, "ExecutionPlan");
    if (node.kind === "NAVIGATE") exact(node.milestoneClass, "REQUIRED_SEMANTIC_MILESTONE", `${nodePath}.milestoneClass`, "ExecutionPlan");
    if (node.kind === "INTERACT") exact(node.milestoneClass, "REQUIRED_EXACT_ACTION", `${nodePath}.milestoneClass`, "ExecutionPlan");
    if (node.kind !== "NAVIGATE" && node.kind !== "INTERACT" && node.milestoneClass !== undefined) fail("ExecutionPlan", `${nodePath}.milestoneClass`, "is not allowed for this node kind");
    string(node.action, `${nodePath}.action`, "ExecutionPlan");
    uniqueStringArray(node.evidence, `${nodePath}.evidence`, "ExecutionPlan");
    object(node.policy, `${nodePath}.policy`, "ExecutionPlan");
    validateCapabilityPolicy(node.policy, `${nodePath}.policy`, "ExecutionPlan");
  });
  array(value.edges, `${path}.edges`, "ExecutionPlan");
  value.edges.forEach((edge, index) => {
    const edgePath = `${path}.edges[${index}]`;
    object(edge, edgePath, "ExecutionPlan");
    allowedKeys(edge, ["from", "to"], edgePath, "ExecutionPlan");
    string(edge.from, `${edgePath}.from`, "ExecutionPlan");
    string(edge.to, `${edgePath}.to`, "ExecutionPlan");
  });
  object(value.retryPolicy, `${path}.retryPolicy`, "ExecutionPlan");
  allowedKeys(value.retryPolicy, ["maxAttempts"], `${path}.retryPolicy`, "ExecutionPlan");
  boundedInteger(value.retryPolicy.maxAttempts, 1, 100, `${path}.retryPolicy.maxAttempts`, "ExecutionPlan");
  object(value.timeoutPolicy, `${path}.timeoutPolicy`, "ExecutionPlan");
  allowedKeys(value.timeoutPolicy, ["perNodeMs", "runMs"], `${path}.timeoutPolicy`, "ExecutionPlan");
  boundedInteger(value.timeoutPolicy.perNodeMs, 1, Number.MAX_SAFE_INTEGER, `${path}.timeoutPolicy.perNodeMs`, "ExecutionPlan");
  boundedInteger(value.timeoutPolicy.runMs, value.timeoutPolicy.perNodeMs, Number.MAX_SAFE_INTEGER, `${path}.timeoutPolicy.runMs`, "ExecutionPlan");
}

function validateExecutionAgentInput(value, path) {
  const contract = "ExecutionAgentInput";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "runId", "scenarioId", "goal", "milestones", "currentMilestoneId", "currentPage", "recentObservations", "capabilityLease", "remainingBudget"], path, contract);
  exact(value.schemaVersion, EXECUTION_AGENT_INPUT_VERSION, `${path}.schemaVersion`, contract);
  boundedString(value.runId, 256, `${path}.runId`, contract);
  boundedString(value.scenarioId, 256, `${path}.scenarioId`, contract);
  object(value.goal, `${path}.goal`, contract);
  allowedKeys(value.goal, ["id", "description"], `${path}.goal`, contract);
  boundedString(value.goal.id, 256, `${path}.goal.id`, contract);
  boundedString(value.goal.description, 4_096, `${path}.goal.description`, contract);
  array(value.milestones, `${path}.milestones`, contract);
  if (value.milestones.length === 0 || value.milestones.length > 64) fail(contract, `${path}.milestones`, "must contain between 1 and 64 milestones");
  value.milestones.forEach((milestone, index) => {
    const milestonePath = `${path}.milestones[${index}]`;
    object(milestone, milestonePath, contract);
    allowedKeys(milestone, ["id", "class", "status", "description", "requiredAction", "target", "expectation"], milestonePath, contract);
    boundedString(milestone.id, 256, `${milestonePath}.id`, contract);
    oneOf(milestone.class, MILESTONE_CLASSES, `${milestonePath}.class`, contract);
    oneOf(milestone.status, ["PENDING", "COMPLETED", "BLOCKED"], `${milestonePath}.status`, contract);
    boundedString(milestone.description, 4_096, `${milestonePath}.description`, contract);
    if (milestone.target !== undefined) validateSemanticTarget(milestone.target, `${milestonePath}.target`, contract);
    if (milestone.expectation !== undefined) {
      object(milestone.expectation, `${milestonePath}.expectation`, contract);
      allowedKeys(milestone.expectation, ["kind", "expected"], `${milestonePath}.expectation`, contract);
      oneOf(milestone.expectation.kind, ["CONTAINS_TEXT", "VISIBLE", "NOT_VISIBLE", "PRESENT", "DISABLED", "ROLE", "NAME"], `${milestonePath}.expectation.kind`, contract);
      if (milestone.expectation.expected !== undefined) validateSemanticMatch(milestone.expectation.expected, `${milestonePath}.expectation.expected`, contract);
      if (milestone.expectation.kind === "CONTAINS_TEXT" && milestone.expectation.expected?.kind !== "literal") fail(contract, `${milestonePath}.expectation.expected`, "must be a literal for CONTAINS_TEXT");
    }
    if (milestone.class === "REQUIRED_EXACT_ACTION") {
      oneOf(milestone.requiredAction, ADAPTIVE_ACTIONS, `${milestonePath}.requiredAction`, contract);
      if (milestone.target === undefined) fail(contract, `${milestonePath}.target`, "is required for REQUIRED_EXACT_ACTION");
    }
    else if (milestone.requiredAction !== undefined) fail(contract, `${milestonePath}.requiredAction`, "is only allowed for REQUIRED_EXACT_ACTION");
  });
  const milestoneIds = value.milestones.map((milestone) => milestone.id);
  if (new Set(milestoneIds).size !== milestoneIds.length) fail(contract, `${path}.milestones`, "milestone ids must be unique");
  boundedString(value.currentMilestoneId, 256, `${path}.currentMilestoneId`, contract);
  const currentMilestone = value.milestones.find((milestone) => milestone.id === value.currentMilestoneId);
  if (!currentMilestone || currentMilestone.status !== "PENDING") fail(contract, `${path}.currentMilestoneId`, "must reference a pending milestone");
  validateAdaptivePage(value.currentPage, `${path}.currentPage`, contract);
  array(value.recentObservations, `${path}.recentObservations`, contract);
  if (value.recentObservations.length > 8) fail(contract, `${path}.recentObservations`, "must contain at most 8 observations");
  value.recentObservations.forEach((observation, index) => validateAdaptiveObservation(observation, `${path}.recentObservations[${index}]`, contract));
  const observationIds = value.recentObservations.map((observation) => observation.observationId);
  if (new Set(observationIds).size !== observationIds.length) fail(contract, `${path}.recentObservations`, "observation ids must be unique");
  object(value.capabilityLease, `${path}.capabilityLease`, contract);
  allowedKeys(value.capabilityLease, ["leaseId", "actions", "allowedOrigins"], `${path}.capabilityLease`, contract);
  boundedString(value.capabilityLease.leaseId, 256, `${path}.capabilityLease.leaseId`, contract);
  uniqueStringArray(value.capabilityLease.actions, `${path}.capabilityLease.actions`, contract);
  if (value.capabilityLease.actions.length === 0 || value.capabilityLease.actions.length > ADAPTIVE_ACTIONS.length) fail(contract, `${path}.capabilityLease.actions`, "must contain bounded actions");
  value.capabilityLease.actions.forEach((action, index) => oneOf(action, ADAPTIVE_ACTIONS, `${path}.capabilityLease.actions[${index}]`, contract));
  uniqueStringArray(value.capabilityLease.allowedOrigins, `${path}.capabilityLease.allowedOrigins`, contract);
  if (value.capabilityLease.allowedOrigins.length === 0 || value.capabilityLease.allowedOrigins.length > 8) fail(contract, `${path}.capabilityLease.allowedOrigins`, "must contain between 1 and 8 origins");
  value.capabilityLease.allowedOrigins.forEach((origin, index) => httpOrigin(origin, `${path}.capabilityLease.allowedOrigins[${index}]`, contract));
  if (!value.capabilityLease.allowedOrigins.includes(new URL(value.currentPage.url).origin)) fail(contract, `${path}.currentPage.url`, "origin is outside the capability lease");
  validateAdaptiveBudget(value.remainingBudget, `${path}.remainingBudget`, contract);
}

function validateExecutionActionProposal(value, path) {
  const contract = "ExecutionActionProposal";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "proposalId", "runId", "scenarioId", "milestoneId", "leaseId", "action", "parameters"], path, contract);
  exact(value.schemaVersion, EXECUTION_ACTION_PROPOSAL_VERSION, `${path}.schemaVersion`, contract);
  for (const key of ["proposalId", "runId", "scenarioId", "milestoneId", "leaseId"]) boundedString(value[key], 256, `${path}.${key}`, contract);
  oneOf(value.action, ADAPTIVE_ACTIONS, `${path}.action`, contract);
  validateAdaptiveActionParameters(value.action, value.parameters, `${path}.parameters`, contract);
}

function validateExecutionActionResult(value, path, context = {}) {
  const contract = "ExecutionActionResult";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "resultId", "proposalId", "accepted", "policyReason", "evidenceRefs", "page", "remainingBudget"], path, contract);
  exact(value.schemaVersion, EXECUTION_ACTION_RESULT_VERSION, `${path}.schemaVersion`, contract);
  boundedString(value.resultId, 256, `${path}.resultId`, contract);
  boundedString(value.proposalId, 256, `${path}.proposalId`, contract);
  bool(value.accepted, `${path}.accepted`, contract);
  oneOf(value.policyReason, ["ACCEPTED", "STALE_OBSERVATION", "UNKNOWN_ELEMENT", "CAPABILITY_DENIED", "ORIGIN_DENIED", "BUDGET_EXHAUSTED", "INVALID_ACTION", "POLICY_DENIED", "EXECUTION_FAILED"], `${path}.policyReason`, contract);
  if (value.accepted !== (value.policyReason === "ACCEPTED")) fail(contract, `${path}.policyReason`, "must agree with accepted");
  uniqueStringArray(value.evidenceRefs, `${path}.evidenceRefs`, contract);
  if (value.evidenceRefs.length > 64) fail(contract, `${path}.evidenceRefs`, "must contain at most 64 references");
  value.evidenceRefs.forEach((ref, index) => boundedString(ref, 256, `${path}.evidenceRefs[${index}]`, contract));
  if (value.accepted && value.evidenceRefs.length === 0) fail(contract, `${path}.evidenceRefs`, "accepted actions require evidence");
  validateAdaptivePage(value.page, `${path}.page`, contract);
  validateAdaptiveBudget(value.remainingBudget, `${path}.remainingBudget`, contract);
  if (context.proposal !== undefined) {
    validateExecutionActionProposal(context.proposal, "$.proposal");
    exact(value.proposalId, context.proposal.proposalId, `${path}.proposalId`, contract);
  }
  if (context.input !== undefined) {
    validateExecutionAgentInput(context.input, "$.input");
    const before = context.input.remainingBudget;
    if (before.actions < 1 || value.remainingBudget.actions !== before.actions - 1) fail(contract, `${path}.remainingBudget.actions`, "must consume exactly one action");
    if (before.turns < 1 || value.remainingBudget.turns !== before.turns - 1) fail(contract, `${path}.remainingBudget.turns`, "must consume exactly one turn");
    if (value.remainingBudget.timeMs > before.timeMs) fail(contract, `${path}.remainingBudget.timeMs`, "must not increase");
    if (value.remainingBudget.tokens > before.tokens) fail(contract, `${path}.remainingBudget.tokens`, "must not increase");
    if (!context.input.capabilityLease.allowedOrigins.includes(new URL(value.page.url).origin)) fail(contract, `${path}.page.url`, "origin is outside the capability lease");
    if (!value.accepted && (value.page.pageId !== context.input.currentPage.pageId || value.page.domGeneration !== context.input.currentPage.domGeneration || value.page.url !== context.input.currentPage.url)) fail(contract, `${path}.page`, "rejected actions must not change page state");
    if (value.accepted && value.page.pageId === context.input.currentPage.pageId && value.page.domGeneration < context.input.currentPage.domGeneration) fail(contract, `${path}.page.domGeneration`, "must not regress on the same page");
    if (context.proposal !== undefined) {
      exact(context.proposal.runId, context.input.runId, "$.proposal.runId", contract);
      exact(context.proposal.scenarioId, context.input.scenarioId, "$.proposal.scenarioId", contract);
      exact(context.proposal.milestoneId, context.input.currentMilestoneId, "$.proposal.milestoneId", contract);
      exact(context.proposal.leaseId, context.input.capabilityLease.leaseId, "$.proposal.leaseId", contract);
      if (!context.input.capabilityLease.actions.includes(context.proposal.action)) fail(contract, "$.proposal.action", "is outside the capability lease");
      if (context.proposal.action === "navigate" && !context.input.capabilityLease.allowedOrigins.includes(new URL(context.proposal.parameters.url).origin)) fail(contract, "$.proposal.parameters.url", "origin is outside the capability lease");
    }
  }
}

function validateExecutionAgentOutcome(value, path, context = {}) {
  const contract = "ExecutionAgentOutcome";
  object(value, path, contract);
  const completed = value.type === "COMPLETED";
  allowedKeys(value, completed ? ["schemaVersion", "runId", "scenarioId", "type", "completedMilestoneIds"] : ["schemaVersion", "runId", "scenarioId", "type", "completedMilestoneIds", "reason"], path, contract);
  exact(value.schemaVersion, EXECUTION_AGENT_OUTCOME_VERSION, `${path}.schemaVersion`, contract);
  boundedString(value.runId, 256, `${path}.runId`, contract);
  boundedString(value.scenarioId, 256, `${path}.scenarioId`, contract);
  oneOf(value.type, ["COMPLETED", "BLOCKED", "AMBIGUOUS", "ERROR"], `${path}.type`, contract);
  uniqueStringArray(value.completedMilestoneIds, `${path}.completedMilestoneIds`, contract);
  if (value.completedMilestoneIds.length > 64) fail(contract, `${path}.completedMilestoneIds`, "must contain at most 64 milestones");
  if (!completed) boundedString(value.reason, 4_096, `${path}.reason`, contract);
  if (context.input !== undefined) {
    validateExecutionAgentInput(context.input, "$.input");
    exact(value.runId, context.input.runId, `${path}.runId`, contract);
    exact(value.scenarioId, context.input.scenarioId, `${path}.scenarioId`, contract);
    const known = new Set(context.input.milestones.map((milestone) => milestone.id));
    if (value.completedMilestoneIds.some((id) => !known.has(id))) fail(contract, `${path}.completedMilestoneIds`, "contains an unknown milestone");
    if (completed) {
      const completedIds = new Set(value.completedMilestoneIds);
      const missing = context.input.milestones.find((milestone) => milestone.class !== "OPTIONAL_HINT" && !completedIds.has(milestone.id));
      if (missing) fail(contract, `${path}.completedMilestoneIds`, "must include every required milestone");
    }
  }
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

function validateRunEnvelope(value, path) {
  const contract = "RunEnvelope";
  object(value, path, contract);
  const adaptive = value.mode === "adaptive";
  allowedKeys(value, adaptive
    ? ["schemaVersion", "runId", "mode", "qaIrHash", "runtimeOutcomeHash", "evidenceManifestHash", "executionAgentInputsHash", "executionAgentOutcomesHash", "authentication"]
    : ["schemaVersion", "runId", "mode", "qaIrHash", "runtimeOutcomeHash", "evidenceManifestHash", "executionPlanHash", "authentication"], path, contract);
  exact(value.schemaVersion, RUN_ENVELOPE_VERSION, `${path}.schemaVersion`, contract);
  boundedString(value.runId, 256, `${path}.runId`, contract);
  oneOf(value.mode, ["strict", "adaptive"], `${path}.mode`, contract);
  const hashes = adaptive
    ? ["qaIrHash", "runtimeOutcomeHash", "evidenceManifestHash", "executionAgentInputsHash", "executionAgentOutcomesHash"]
    : ["qaIrHash", "runtimeOutcomeHash", "evidenceManifestHash", "executionPlanHash"];
  for (const key of hashes) sha256Hash(value[key], `${path}.${key}`, contract);
  boundedString(value.authentication, 128, `${path}.authentication`, contract);
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(value.authentication)) fail(contract, `${path}.authentication`, "must be an HMAC-SHA256 value");
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
  if (value.kind === "ELEMENT_OBSERVATION") validateElementObservation(value.value, `${path}.value`);
}

function validateElementObservation(value, path) {
  object(value, path, "EvidenceBundle");
  string(value.expectationId, `${path}.expectationId`, "EvidenceBundle");
  oneOf(value.resolution, ["FOUND", "MISSING", "AMBIGUOUS", "UNSUPPORTED", "UNSTABLE"], `${path}.resolution`, "EvidenceBundle");
  if (value.resolution === "FOUND") {
    allowedKeys(value, ["expectationId", "resolution", "visible", "text", "textTruncated", "role", "accessibleName", "attributes"], path, "EvidenceBundle");
    if (value.visible !== undefined) bool(value.visible, `${path}.visible`, "EvidenceBundle");
    if (value.text !== undefined) {
      if (typeof value.text !== "string" || value.text.length > 4_096) fail("EvidenceBundle", `${path}.text`, "must be a string of at most 4096 characters");
      bool(value.textTruncated, `${path}.textTruncated`, "EvidenceBundle");
    } else if (value.textTruncated !== undefined) fail("EvidenceBundle", `${path}.textTruncated`, "requires text");
    if (value.role !== undefined) boundedString(value.role, 1_024, `${path}.role`, "EvidenceBundle");
    if (value.accessibleName !== undefined && (typeof value.accessibleName !== "string" || value.accessibleName.length > 4_096)) fail("EvidenceBundle", `${path}.accessibleName`, "must be a string of at most 4096 characters");
    if (value.attributes !== undefined) {
      object(value.attributes, `${path}.attributes`, "EvidenceBundle");
      for (const [name, attribute] of Object.entries(value.attributes)) {
        boundedString(name, 512, `${path}.attributes`, "EvidenceBundle");
        if (typeof attribute !== "string" || attribute.length > 4_096) fail("EvidenceBundle", `${path}.attributes.${name}`, "must be a string of at most 4096 characters");
      }
    }
    return;
  }
  if (value.resolution === "AMBIGUOUS") {
    allowedKeys(value, ["expectationId", "resolution", "count"], path, "EvidenceBundle");
    number(value.count, `${path}.count`, "EvidenceBundle");
    if (!Number.isInteger(value.count) || value.count < 2) fail("EvidenceBundle", `${path}.count`, "must be an integer greater than one");
    return;
  }
  allowedKeys(value, ["expectationId", "resolution"], path, "EvidenceBundle");
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
    allowedKeys(item, ["id", "kind", "target", "expected", "text", "attribute", "judgment"], itemPath, "SemanticJudgeInput");
    string(item.id, `${itemPath}.id`, "SemanticJudgeInput");
    if (expectationIds.has(item.id)) fail("SemanticJudgeInput", `${itemPath}.id`, "must be unique");
    expectationIds.add(item.id);
    string(item.kind, `${itemPath}.kind`, "SemanticJudgeInput");
    if (item.judgment !== undefined) exact(item.judgment, "SEMANTIC", `${itemPath}.judgment`, "SemanticJudgeInput");
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
  const expectedIds = context.qaIr && context.evidenceBundle ? scenarioExpectationIds(context.qaIr, context.evidenceBundle) : undefined;
  const actualIds = new Set();
  value.expectationResults.forEach((item, index) => {
    validateExpectationJudgment(item, `${path}.expectationResults[${index}]`, value.verdict, evidenceIds, "JudgeResult", expectedIds);
    if (actualIds.has(item.expectationId)) fail("JudgeResult", `${path}.expectationResults[${index}].expectationId`, "must be unique");
    actualIds.add(item.expectationId);
  });
  if (expectedIds && (actualIds.size !== expectedIds.size || [...expectedIds].some((id) => !actualIds.has(id)))) {
    fail("JudgeResult", `${path}.expectationResults`, "must resolve every scenario expectation exactly once");
  }
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

function validatePatchProposal(value, path, context = {}) {
  const contract = "PatchProposal";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "proposalId", "diagnosisId", "codeContextBundleId", "repairRecommendationId", "baseRevision", "intent", "expectedEffect", "risks", "files", "operations", "verificationPlan"], path, contract);
  exact(value.schemaVersion, PATCH_PROPOSAL_VERSION, `${path}.schemaVersion`, contract);
  for (const key of ["proposalId", "diagnosisId", "codeContextBundleId", "repairRecommendationId"]) boundedString(value[key], 512, `${path}.${key}`, contract);
  boundedString(value.baseRevision, 128, `${path}.baseRevision`, contract);
  boundedString(value.intent, 4_096, `${path}.intent`, contract);
  boundedString(value.expectedEffect, 4_096, `${path}.expectedEffect`, contract);
  uniqueStringArray(value.risks, `${path}.risks`, contract);
  if (value.risks.length > 20) fail(contract, `${path}.risks`, "must contain at most 20 risks");
  value.risks.forEach((risk, index) => boundedString(risk, 2_000, `${path}.risks[${index}]`, contract));

  array(value.files, `${path}.files`, contract);
  if (value.files.length === 0 || value.files.length > 10) fail(contract, `${path}.files`, "must contain 1 to 10 files");
  value.files.forEach((file, index) => {
    const filePath = `${path}.files[${index}]`;
    object(file, filePath, contract);
    allowedKeys(file, ["path", "action", "originalContentHash"], filePath, contract);
    repositoryPath(file.path, `${filePath}.path`, contract);
    oneOf(file.action, ["MODIFY", "CREATE"], `${filePath}.action`, contract);
    if (file.action === "MODIFY") sha256Hash(file.originalContentHash, `${filePath}.originalContentHash`, contract);
    else if (file.originalContentHash !== undefined) fail(contract, `${filePath}.originalContentHash`, "is not allowed for a created file");
  });
  const filePaths = value.files.map((file) => file.path);
  if (new Set(filePaths).size !== filePaths.length) fail(contract, `${path}.files`, "must contain unique paths");

  array(value.operations, `${path}.operations`, contract);
  if (value.operations.length === 0 || value.operations.length > 20) fail(contract, `${path}.operations`, "must contain 1 to 20 operations");
  value.operations.forEach((operation, index) => {
    const operationPath = `${path}.operations[${index}]`;
    object(operation, operationPath, contract);
    if (operation.type === "REPLACE_RANGE") {
      allowedKeys(operation, ["type", "path", "startLine", "endLine", "replacement"], operationPath, contract);
      repositoryPath(operation.path, `${operationPath}.path`, contract);
      boundedInteger(operation.startLine, 1, 1_000_000, `${operationPath}.startLine`, contract);
      boundedInteger(operation.endLine, operation.startLine, 1_000_000, `${operationPath}.endLine`, contract);
      utf8Text(operation.replacement, 131_072, true, `${operationPath}.replacement`, contract);
    } else if (operation.type === "CREATE_FILE") {
      allowedKeys(operation, ["type", "path", "content"], operationPath, contract);
      repositoryPath(operation.path, `${operationPath}.path`, contract);
      utf8Text(operation.content, 131_072, false, `${operationPath}.content`, contract);
    } else {
      fail(contract, `${operationPath}.type`, "must be one of: REPLACE_RANGE, CREATE_FILE");
    }
  });
  for (const operation of value.operations) {
    const file = value.files.find((candidate) => candidate.path === operation.path);
    if (!file) fail(contract, `${path}.operations`, `unknown file ${operation.path}`);
    if ((operation.type === "REPLACE_RANGE") !== (file.action === "MODIFY")) fail(contract, `${path}.operations`, `operation does not match file action for ${operation.path}`);
  }
  for (const file of value.files) if (!value.operations.some((operation) => operation.path === file.path)) fail(contract, `${path}.operations`, `missing operation for ${file.path}`);
  for (const file of value.files.filter((candidate) => candidate.action === "CREATE")) {
    if (value.operations.filter((operation) => operation.path === file.path).length !== 1) fail(contract, `${path}.operations`, `created file ${file.path} requires exactly one operation`);
  }
  const replacements = value.operations.filter((operation) => operation.type === "REPLACE_RANGE");
  for (let index = 0; index < replacements.length; index += 1) {
    for (let next = index + 1; next < replacements.length; next += 1) {
      if (replacements[index].path === replacements[next].path && replacements[index].startLine <= replacements[next].endLine && replacements[next].startLine <= replacements[index].endLine) {
        fail(contract, `${path}.operations`, `replacement ranges overlap for ${replacements[index].path}`);
      }
    }
  }

  array(value.verificationPlan, `${path}.verificationPlan`, contract);
  if (value.verificationPlan.length === 0 || value.verificationPlan.length > 20) fail(contract, `${path}.verificationPlan`, "must contain 1 to 20 commands");
  value.verificationPlan.forEach((step, index) => {
    const stepPath = `${path}.verificationPlan[${index}]`;
    object(step, stepPath, contract);
    allowedKeys(step, ["command", "purpose"], stepPath, contract);
    boundedString(step.command, 1_000, `${stepPath}.command`, contract);
    boundedString(step.purpose, 2_000, `${stepPath}.purpose`, contract);
  });

  if (context.diagnosis) {
    validateFailureDiagnosis(context.diagnosis, "$.diagnosis");
    exact(value.diagnosisId, context.diagnosis.diagnosisId, `${path}.diagnosisId`, contract);
  }
  if (context.codeContext) {
    validateCodeContextBundle(context.codeContext, "$.codeContext");
    exact(value.codeContextBundleId, context.codeContext.bundleId, `${path}.codeContextBundleId`, contract);
    exact(value.baseRevision, context.codeContext.revision, `${path}.baseRevision`, contract);
    if (context.diagnosis) exact(context.codeContext.failureDiagnosisId, context.diagnosis.diagnosisId, "$.codeContext.failureDiagnosisId", contract);
    for (const file of value.files.filter((candidate) => candidate.action === "MODIFY")) {
      const candidate = context.codeContext.candidates.find((item) => item.path === file.path);
      const snippet = context.codeContext.snippets.find((item) => item.path === file.path);
      if (!candidate || !snippet) fail(contract, `${path}.files`, `modified file ${file.path} is not bound to CodeContext`);
      exact(file.originalContentHash, snippet.contentHash, `${path}.files.${file.path}.originalContentHash`, contract);
      for (const operation of value.operations.filter((item) => item.path === file.path)) {
        const startLine = Math.max(candidate.range?.start.line ?? 1, snippet.range.start.line);
        const endLine = Math.min(candidate.range?.end.line ?? Number.MAX_SAFE_INTEGER, snippet.range.end.line);
        if (operation.startLine < startLine || operation.endLine > endLine) fail(contract, `${path}.operations`, `replacement range for ${file.path} is outside CodeContext`);
      }
    }
  }
  if (context.recommendation) {
    validateRepairRecommendation(context.recommendation, "$.recommendation", { diagnosis: context.diagnosis, codeContext: context.codeContext });
    exact(value.repairRecommendationId, context.recommendation.recommendationId, `${path}.repairRecommendationId`, contract);
    exact(value.baseRevision, context.recommendation.repositoryRevision, `${path}.baseRevision`, contract);
    if (canonicalHash(value.verificationPlan) !== canonicalHash(context.recommendation.verificationPlan)) fail(contract, `${path}.verificationPlan`, "must use the trusted RepairRecommendation verification plan");
  }
}

function validatePatchApplicationResult(value, path, context = {}) {
  const contract = "PatchApplicationResult";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "applicationId", "proposalId", "baseRevision", "status", "worktree", "appliedFiles", "diff", "reason"], path, contract);
  exact(value.schemaVersion, PATCH_APPLICATION_RESULT_VERSION, `${path}.schemaVersion`, contract);
  for (const key of ["applicationId", "proposalId"]) boundedString(value[key], 512, `${path}.${key}`, contract);
  boundedString(value.baseRevision, 128, `${path}.baseRevision`, contract);
  oneOf(value.status, ["APPLIED", "PATCH_STALE", "REJECTED", "ERROR"], `${path}.status`, contract);
  if (value.reason !== undefined) boundedString(value.reason, 2_000, `${path}.reason`, contract);

  if (value.worktree !== undefined) {
    object(value.worktree, `${path}.worktree`, contract);
    allowedKeys(value.worktree, ["worktreeId", "path", "branch", "revision"], `${path}.worktree`, contract);
    boundedString(value.worktree.worktreeId, 128, `${path}.worktree.worktreeId`, contract);
    repositoryPath(value.worktree.path, `${path}.worktree.path`, contract);
    if (!value.worktree.path.startsWith(".qa/worktrees/")) fail(contract, `${path}.worktree.path`, "must be private .qa worktree storage");
    boundedString(value.worktree.branch, 128, `${path}.worktree.branch`, contract);
    if (!/^qa\/fix-[a-z0-9-]+$/.test(value.worktree.branch)) fail(contract, `${path}.worktree.branch`, "must be a safe qa/fix branch");
    exact(value.worktree.revision, value.baseRevision, `${path}.worktree.revision`, contract);
  }

  array(value.appliedFiles, `${path}.appliedFiles`, contract);
  if (value.appliedFiles.length > 10) fail(contract, `${path}.appliedFiles`, "must contain at most 10 files");
  value.appliedFiles.forEach((file, index) => {
    const filePath = `${path}.appliedFiles[${index}]`;
    object(file, filePath, contract);
    allowedKeys(file, ["path", "action", "beforeHash", "afterHash"], filePath, contract);
    repositoryPath(file.path, `${filePath}.path`, contract);
    oneOf(file.action, ["MODIFY", "CREATE"], `${filePath}.action`, contract);
    if (file.action === "MODIFY") sha256Hash(file.beforeHash, `${filePath}.beforeHash`, contract);
    else if (file.beforeHash !== undefined) fail(contract, `${filePath}.beforeHash`, "is not allowed for a created file");
    sha256Hash(file.afterHash, `${filePath}.afterHash`, contract);
  });
  const appliedPaths = value.appliedFiles.map((file) => file.path);
  if (new Set(appliedPaths).size !== appliedPaths.length) fail(contract, `${path}.appliedFiles`, "must contain unique paths");

  object(value.diff, `${path}.diff`, contract);
  allowedKeys(value.diff, ["fileCount", "changedLines", "contentHash"], `${path}.diff`, contract);
  boundedInteger(value.diff.fileCount, 0, 10, `${path}.diff.fileCount`, contract);
  boundedInteger(value.diff.changedLines, 0, 10_000, `${path}.diff.changedLines`, contract);
  sha256Hash(value.diff.contentHash, `${path}.diff.contentHash`, contract);
  exact(value.diff.fileCount, value.appliedFiles.length, `${path}.diff.fileCount`, contract);

  if (value.status === "APPLIED") {
    if (value.worktree === undefined || value.appliedFiles.length === 0 || value.reason !== undefined) fail(contract, path, "an applied result requires a retained worktree and files without a failure reason");
  } else if (value.worktree !== undefined || value.appliedFiles.length !== 0 || value.reason === undefined) {
    fail(contract, path, "a failed application cannot expose a publishable worktree or files");
  }
  if (context.proposal) {
    validatePatchProposal(context.proposal, "$.proposal");
    exact(value.proposalId, context.proposal.proposalId, `${path}.proposalId`, contract);
    exact(value.baseRevision, context.proposal.baseRevision, `${path}.baseRevision`, contract);
    if (value.status === "APPLIED") {
      const expectedFiles = [...context.proposal.files].sort((left, right) => left.path.localeCompare(right.path));
      const actualFiles = [...value.appliedFiles].sort((left, right) => left.path.localeCompare(right.path));
      if (expectedFiles.length !== actualFiles.length || expectedFiles.some((file, index) => file.path !== actualFiles[index].path || file.action !== actualFiles[index].action)) fail(contract, `${path}.appliedFiles`, "must match the PatchProposal files");
    }
  }
}

function validateVerificationResult(value, path, context = {}) {
  const contract = "VerificationResult";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "verificationId", "proposalId", "applicationId", "worktreeRevision", "diffHash", "status", "checks", "reason"], path, contract);
  exact(value.schemaVersion, VERIFICATION_RESULT_VERSION, `${path}.schemaVersion`, contract);
  for (const key of ["verificationId", "proposalId", "applicationId"]) boundedString(value[key], 512, `${path}.${key}`, contract);
  boundedString(value.worktreeRevision, 128, `${path}.worktreeRevision`, contract);
  sha256Hash(value.diffHash, `${path}.diffHash`, contract);
  oneOf(value.status, ["PASS", "FAILED", "MANUAL_REVIEW", "ERROR"], `${path}.status`, contract);
  if (value.reason !== undefined) boundedString(value.reason, 2_000, `${path}.reason`, contract);
  array(value.checks, `${path}.checks`, contract);
  if (value.checks.length === 0 || value.checks.length > 10) fail(contract, `${path}.checks`, "must contain 1 to 10 checks");
  value.checks.forEach((check, index) => {
    const checkPath = `${path}.checks[${index}]`;
    object(check, checkPath, contract);
    allowedKeys(check, ["name", "required", "status", "exitCode", "signal", "durationMs", "stdoutArtifact", "stderrArtifact", "resourceOutcome"], checkPath, contract);
    oneOf(check.name, ["format", "lint", "typecheck", "unit", "playwright"], `${checkPath}.name`, contract);
    bool(check.required, `${checkPath}.required`, contract);
    oneOf(check.status, ["PASS", "FAIL", "TIMEOUT", "ERROR", "MISSING", "SKIPPED"], `${checkPath}.status`, contract);
    if (check.exitCode !== undefined) boundedInteger(check.exitCode, 0, 255, `${checkPath}.exitCode`, contract);
    if (check.signal !== undefined) boundedString(check.signal, 64, `${checkPath}.signal`, contract);
    boundedInteger(check.durationMs, 0, 3_600_000, `${checkPath}.durationMs`, contract);
    oneOf(check.resourceOutcome, ["WITHIN_LIMITS", "TIMEOUT", "OUTPUT_LIMIT", "NOT_RUN"], `${checkPath}.resourceOutcome`, contract);
    for (const key of ["stdoutArtifact", "stderrArtifact"]) {
      const artifact = check[key];
      if (artifact === undefined) continue;
      object(artifact, `${checkPath}.${key}`, contract);
      allowedKeys(artifact, ["artifactId", "contentHash", "size", "truncated"], `${checkPath}.${key}`, contract);
      boundedString(artifact.artifactId, 128, `${checkPath}.${key}.artifactId`, contract);
      sha256Hash(artifact.contentHash, `${checkPath}.${key}.contentHash`, contract);
      boundedInteger(artifact.size, 0, 65_536, `${checkPath}.${key}.size`, contract);
      bool(artifact.truncated, `${checkPath}.${key}.truncated`, contract);
    }
    if (["MISSING", "SKIPPED"].includes(check.status) && (check.exitCode !== undefined || check.signal !== undefined || check.stdoutArtifact !== undefined || check.stderrArtifact !== undefined || check.resourceOutcome !== "NOT_RUN")) fail(contract, checkPath, "a non-run check cannot contain process artifacts");
  });
  const checkNames = value.checks.map((check) => check.name);
  if (new Set(checkNames).size !== checkNames.length) fail(contract, `${path}.checks`, "must contain unique check names");
  const expectedStatus = value.checks.some((check) => check.required && ["FAIL", "TIMEOUT"].includes(check.status))
    ? "FAILED"
    : value.checks.some((check) => check.required && check.status === "ERROR")
      ? "ERROR"
      : value.checks.some((check) => check.required && ["MISSING", "SKIPPED"].includes(check.status))
        ? "MANUAL_REVIEW"
        : "PASS";
  exact(value.status, expectedStatus, `${path}.status`, contract);
  if (value.status === "PASS" && value.reason !== undefined) fail(contract, `${path}.reason`, "is not allowed for a passing result");
  if (context.proposal) {
    validatePatchProposal(context.proposal, "$.proposal");
    exact(value.proposalId, context.proposal.proposalId, `${path}.proposalId`, contract);
  }
  if (context.application) {
    validatePatchApplicationResult(context.application, "$.application", { proposal: context.proposal });
    exact(context.application.status, "APPLIED", "$.application.status", contract);
    exact(value.applicationId, context.application.applicationId, `${path}.applicationId`, contract);
    exact(value.worktreeRevision, context.application.baseRevision, `${path}.worktreeRevision`, contract);
    exact(value.diffHash, context.application.diff.contentHash, `${path}.diffHash`, contract);
  }
}

function validateEvidenceComparison(value, path, context = {}) {
  const contract = "EvidenceComparison";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "comparisonId", "proposalId", "applicationId", "verificationId", "before", "after", "fixedExpectationIds", "newlyFailedExpectationIds", "unchangedFailureIds", "requiredMilestoneIds", "preservedMilestoneIds", "policyChanges", "routeChanges", "conclusion", "inconclusiveReasons"], path, contract);
  exact(value.schemaVersion, EVIDENCE_COMPARISON_VERSION, `${path}.schemaVersion`, contract);
  for (const key of ["comparisonId", "proposalId", "applicationId", "verificationId"]) boundedString(value[key], 512, `${path}.${key}`, contract);
  for (const side of ["before", "after"]) {
    const sidePath = `${path}.${side}`;
    object(value[side], sidePath, contract);
    allowedKeys(value[side], ["runId", "evidenceBundleId", "judgeResultId", "qaIrHash", "authenticated"], sidePath, contract);
    for (const key of ["runId", "evidenceBundleId", "judgeResultId"]) boundedString(value[side][key], 512, `${sidePath}.${key}`, contract);
    sha256Hash(value[side].qaIrHash, `${sidePath}.qaIrHash`, contract);
    bool(value[side].authenticated, `${sidePath}.authenticated`, contract);
  }
  for (const key of ["fixedExpectationIds", "newlyFailedExpectationIds", "unchangedFailureIds", "requiredMilestoneIds", "preservedMilestoneIds", "inconclusiveReasons"]) {
    uniqueStringArray(value[key], `${path}.${key}`, contract);
    if (value[key].length > 100) fail(contract, `${path}.${key}`, "must contain at most 100 entries");
    value[key].forEach((item, index) => boundedString(item, key === "inconclusiveReasons" ? 2_000 : 512, `${path}.${key}[${index}]`, contract));
  }
  array(value.policyChanges, `${path}.policyChanges`, contract);
  if (value.policyChanges.length > 20) fail(contract, `${path}.policyChanges`, "must contain at most 20 entries");
  value.policyChanges.forEach((change, index) => {
    const changePath = `${path}.policyChanges[${index}]`;
    object(change, changePath, contract);
    allowedKeys(change, ["scenarioId", "beforeHash", "afterHash"], changePath, contract);
    boundedString(change.scenarioId, 512, `${changePath}.scenarioId`, contract);
    sha256Hash(change.beforeHash, `${changePath}.beforeHash`, contract);
    sha256Hash(change.afterHash, `${changePath}.afterHash`, contract);
    if (change.beforeHash === change.afterHash) fail(contract, changePath, "must describe a real policy change");
  });
  array(value.routeChanges, `${path}.routeChanges`, contract);
  if (value.routeChanges.length > 20) fail(contract, `${path}.routeChanges`, "must contain at most 20 entries");
  value.routeChanges.forEach((change, index) => {
    const changePath = `${path}.routeChanges[${index}]`;
    object(change, changePath, contract);
    allowedKeys(change, ["before", "after"], changePath, contract);
    boundedString(change.before, 4_096, `${changePath}.before`, contract);
    boundedString(change.after, 4_096, `${changePath}.after`, contract);
    if (change.before === change.after) fail(contract, changePath, "must describe a real route change");
  });
  oneOf(value.conclusion, ["IMPROVED", "UNCHANGED", "REGRESSED", "INCONCLUSIVE"], `${path}.conclusion`, contract);
  if ((value.conclusion === "INCONCLUSIVE") !== (value.inconclusiveReasons.length > 0)) fail(contract, `${path}.inconclusiveReasons`, "must exist only for an inconclusive comparison");
  if (value.conclusion === "IMPROVED" && (value.fixedExpectationIds.length === 0 || value.newlyFailedExpectationIds.length > 0 || !value.after.authenticated || value.preservedMilestoneIds.length !== value.requiredMilestoneIds.length)) fail(contract, path, "an improved comparison must fix an expectation without regressions and preserve required milestones");
  if (value.conclusion === "REGRESSED" && value.newlyFailedExpectationIds.length === 0) fail(contract, `${path}.newlyFailedExpectationIds`, "a regression requires a newly failed expectation");
  if (context.proposal) exact(value.proposalId, context.proposal.proposalId, `${path}.proposalId`, contract);
  if (context.application) exact(value.applicationId, context.application.applicationId, `${path}.applicationId`, contract);
  if (context.verification) {
    validateVerificationResult(context.verification, "$.verification", { proposal: context.proposal, application: context.application });
    exact(value.verificationId, context.verification.verificationId, `${path}.verificationId`, contract);
  }
}

function validateExpectationIntegrityResult(value, path, context = {}) {
  const contract = "ExpectationIntegrityResult";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "integrityId", "proposalId", "applicationId", "comparisonId", "weakened", "manualReview", "removedExpectationIds", "modifiedSemanticStrength", "suspiciousRanges", "beforeQaIrHash", "afterQaIrHash", "ruleResults"], path, contract);
  exact(value.schemaVersion, EXPECTATION_INTEGRITY_RESULT_VERSION, `${path}.schemaVersion`, contract);
  for (const key of ["integrityId", "proposalId", "applicationId", "comparisonId"]) boundedString(value[key], 512, `${path}.${key}`, contract);
  bool(value.weakened, `${path}.weakened`, contract);
  bool(value.manualReview, `${path}.manualReview`, contract);
  uniqueStringArray(value.removedExpectationIds, `${path}.removedExpectationIds`, contract);
  if (value.removedExpectationIds.length > 100) fail(contract, `${path}.removedExpectationIds`, "must contain at most 100 entries");
  array(value.modifiedSemanticStrength, `${path}.modifiedSemanticStrength`, contract);
  if (value.modifiedSemanticStrength.length > 100) fail(contract, `${path}.modifiedSemanticStrength`, "must contain at most 100 entries");
  value.modifiedSemanticStrength.forEach((change, index) => {
    const changePath = `${path}.modifiedSemanticStrength[${index}]`;
    object(change, changePath, contract);
    allowedKeys(change, ["expectationId", "beforeStrength", "afterStrength", "reason"], changePath, contract);
    boundedString(change.expectationId, 512, `${changePath}.expectationId`, contract);
    boundedInteger(change.beforeStrength, 0, 100, `${changePath}.beforeStrength`, contract);
    boundedInteger(change.afterStrength, 0, 100, `${changePath}.afterStrength`, contract);
    boundedString(change.reason, 2_000, `${changePath}.reason`, contract);
  });
  array(value.suspiciousRanges, `${path}.suspiciousRanges`, contract);
  if (value.suspiciousRanges.length > 200) fail(contract, `${path}.suspiciousRanges`, "must contain at most 200 entries");
  value.suspiciousRanges.forEach((range, index) => {
    const rangePath = `${path}.suspiciousRanges[${index}]`;
    object(range, rangePath, contract);
    allowedKeys(range, ["path", "startLine", "endLine", "rule", "reason"], rangePath, contract);
    repositoryPath(range.path, `${rangePath}.path`, contract);
    boundedInteger(range.startLine, 1, 1_000_000, `${rangePath}.startLine`, contract);
    boundedInteger(range.endLine, range.startLine, 1_000_000, `${rangePath}.endLine`, contract);
    boundedString(range.rule, 128, `${rangePath}.rule`, contract);
    boundedString(range.reason, 2_000, `${rangePath}.reason`, contract);
  });
  sha256Hash(value.beforeQaIrHash, `${path}.beforeQaIrHash`, contract);
  sha256Hash(value.afterQaIrHash, `${path}.afterQaIrHash`, contract);
  array(value.ruleResults, `${path}.ruleResults`, contract);
  if (value.ruleResults.length === 0 || value.ruleResults.length > 20) fail(contract, `${path}.ruleResults`, "must contain 1 to 20 rules");
  value.ruleResults.forEach((rule, index) => {
    const rulePath = `${path}.ruleResults[${index}]`;
    object(rule, rulePath, contract);
    allowedKeys(rule, ["rule", "status", "matches"], rulePath, contract);
    boundedString(rule.rule, 128, `${rulePath}.rule`, contract);
    oneOf(rule.status, ["PASS", "FAIL", "MANUAL_REVIEW"], `${rulePath}.status`, contract);
    boundedInteger(rule.matches, 0, 200, `${rulePath}.matches`, contract);
    if ((rule.status === "PASS") !== (rule.matches === 0)) fail(contract, rulePath, "PASS must have no matches and a finding must have matches");
  });
  const ruleNames = value.ruleResults.map((rule) => rule.rule);
  if (new Set(ruleNames).size !== ruleNames.length) fail(contract, `${path}.ruleResults`, "must contain unique rules");
  exact(value.weakened, value.ruleResults.some((rule) => rule.status === "FAIL"), `${path}.weakened`, contract);
  exact(value.manualReview, value.ruleResults.some((rule) => rule.status === "MANUAL_REVIEW"), `${path}.manualReview`, contract);
  if (context.proposal) exact(value.proposalId, context.proposal.proposalId, `${path}.proposalId`, contract);
  if (context.application) exact(value.applicationId, context.application.applicationId, `${path}.applicationId`, contract);
  if (context.comparison) {
    validateEvidenceComparison(context.comparison, "$.comparison", { proposal: context.proposal, application: context.application, verification: context.verification });
    exact(value.comparisonId, context.comparison.comparisonId, `${path}.comparisonId`, contract);
    exact(value.beforeQaIrHash, context.comparison.before.qaIrHash, `${path}.beforeQaIrHash`, contract);
    exact(value.afterQaIrHash, context.comparison.after.qaIrHash, `${path}.afterQaIrHash`, contract);
  }
}

function validateIndependentRemediationReview(value, path, context = {}) {
  const contract = "IndependentRemediationReview";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "reviewId", "proposalId", "applicationId", "verificationId", "comparisonId", "integrityId", "generator", "reviewer", "referenceHashes", "decision", "confidence", "risks", "unsupportedClaims", "rationale"], path, contract);
  exact(value.schemaVersion, INDEPENDENT_REMEDIATION_REVIEW_VERSION, `${path}.schemaVersion`, contract);
  for (const key of ["reviewId", "proposalId", "applicationId", "verificationId", "comparisonId", "integrityId"]) boundedString(value[key], 512, `${path}.${key}`, contract);
  for (const identity of ["generator", "reviewer"]) {
    const identityPath = `${path}.${identity}`;
    object(value[identity], identityPath, contract);
    allowedKeys(value[identity], ["provider", "model", "invocationId"], identityPath, contract);
    for (const key of ["provider", "model", "invocationId"]) boundedString(value[identity][key], 512, `${identityPath}.${key}`, contract);
  }
  if (value.generator.invocationId === value.reviewer.invocationId) fail(contract, `${path}.reviewer.invocationId`, "must differ from the patch generator invocation");
  object(value.referenceHashes, `${path}.referenceHashes`, contract);
  allowedKeys(value.referenceHashes, ["proposal", "application", "verification", "comparison", "integrity", "diff"], `${path}.referenceHashes`, contract);
  for (const key of ["proposal", "application", "verification", "comparison", "integrity", "diff"]) sha256Hash(value.referenceHashes[key], `${path}.referenceHashes.${key}`, contract);
  oneOf(value.decision, ["APPROVE_DRAFT", "REJECT", "MANUAL_REVIEW"], `${path}.decision`, contract);
  probability(value.confidence, `${path}.confidence`, contract);
  for (const key of ["risks", "unsupportedClaims"]) {
    uniqueStringArray(value[key], `${path}.${key}`, contract);
    if (value[key].length > 50) fail(contract, `${path}.${key}`, "must contain at most 50 entries");
    value[key].forEach((item, index) => boundedString(item, 2_000, `${path}.${key}[${index}]`, contract));
  }
  boundedString(value.rationale, 4_096, `${path}.rationale`, contract);
  if (value.decision === "APPROVE_DRAFT" && (value.confidence < 0.5 || value.unsupportedClaims.length > 0)) fail(contract, path, "approval requires confidence and no unsupported claims");
  const bindings = [
    ["proposal", context.proposal, "proposalId"],
    ["application", context.application, "applicationId"],
    ["verification", context.verification, "verificationId"],
    ["comparison", context.comparison, "comparisonId"],
    ["integrity", context.integrity, "integrityId"],
  ];
  for (const [key, artifact, idKey] of bindings) {
    if (!artifact) continue;
    exact(value[idKey], artifact[idKey], `${path}.${idKey}`, contract);
    exact(value.referenceHashes[key], canonicalHash(artifact), `${path}.referenceHashes.${key}`, contract);
  }
  if (context.application) exact(value.referenceHashes.diff, context.application.diff.contentHash, `${path}.referenceHashes.diff`, contract);
}

function validatePublicationDecision(value, path) {
  const contract = "PublicationDecision";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "decisionId", "repository", "action", "publication", "eligibleDraft", "publicationFingerprint", "source", "gates", "existingTargets", "target", "branch", "baseRevision"], path, contract);
  exact(value.schemaVersion, PUBLICATION_DECISION_VERSION, `${path}.schemaVersion`, contract);
  boundedString(value.decisionId, 512, `${path}.decisionId`, contract);
  repositorySlug(value.repository, `${path}.repository`, contract);
  oneOf(value.action, ["CREATE_ISSUE", "UPDATE_ISSUE", "CREATE_DRAFT_PR", "UPDATE_DRAFT_PR", "NOOP", "MANUAL_REVIEW"], `${path}.action`, contract);
  oneOf(value.publication, ["ISSUE", "DRAFT_PR", "NONE"], `${path}.publication`, contract);
  bool(value.eligibleDraft, `${path}.eligibleDraft`, contract);
  sha256Hash(value.publicationFingerprint, `${path}.publicationFingerprint`, contract);
  object(value.source, `${path}.source`, contract);
  allowedKeys(value.source, ["diagnosisId", "codeContextBundleId", "repairRecommendationId", "proposalId", "applicationId", "verificationId", "comparisonId", "integrityId", "reviewId"], `${path}.source`, contract);
  for (const [key, item] of Object.entries(value.source)) boundedString(item, 512, `${path}.source.${key}`, contract);
  for (const key of ["diagnosisId", "codeContextBundleId"]) if (value.source[key] === undefined) fail(contract, `${path}.source.${key}`, "is required");
  array(value.gates, `${path}.gates`, contract);
  if (value.gates.length === 0 || value.gates.length > 20) fail(contract, `${path}.gates`, "must contain 1 to 20 gates");
  value.gates.forEach((gate, index) => {
    const gatePath = `${path}.gates[${index}]`;
    object(gate, gatePath, contract);
    allowedKeys(gate, ["gate", "status", "reason"], gatePath, contract);
    boundedString(gate.gate, 128, `${gatePath}.gate`, contract);
    oneOf(gate.status, ["PASS", "FAIL", "UNKNOWN"], `${gatePath}.status`, contract);
    boundedString(gate.reason, 2_000, `${gatePath}.reason`, contract);
  });
  const gateNames = value.gates.map((gate) => gate.gate);
  if (new Set(gateNames).size !== gateNames.length) fail(contract, `${path}.gates`, "must contain unique gates");
  exact(value.eligibleDraft, value.gates.every((gate) => gate.status === "PASS"), `${path}.eligibleDraft`, contract);
  array(value.existingTargets, `${path}.existingTargets`, contract);
  if (value.existingTargets.length > 10) fail(contract, `${path}.existingTargets`, "must contain at most 10 targets");
  value.existingTargets.forEach((target, index) => validateGitHubPublicationTarget(target, `${path}.existingTargets[${index}]`, value.repository, contract));
  if (value.target !== undefined) {
    object(value.target, `${path}.target`, contract);
    allowedKeys(value.target, ["publication", "number", "url"], `${path}.target`, contract);
    if (!value.existingTargets.some((target) => canonicalHash(target) === canonicalHash(value.target))) fail(contract, `${path}.target`, "must select an existing target");
  }
  if (value.branch !== undefined) {
    boundedString(value.branch, 128, `${path}.branch`, contract);
    if (!/^qa\/fix-[a-z0-9-]+$/.test(value.branch)) fail(contract, `${path}.branch`, "must be a safe qa/fix branch");
  }
  if (value.baseRevision !== undefined) boundedString(value.baseRevision, 128, `${path}.baseRevision`, contract);
  if (["CREATE_DRAFT_PR", "UPDATE_DRAFT_PR"].includes(value.action) && (value.publication !== "DRAFT_PR" || !value.eligibleDraft || value.branch === undefined || value.baseRevision === undefined)) fail(contract, path, "Draft PR action requires every gate and a bounded branch");
  if (["CREATE_ISSUE", "UPDATE_ISSUE"].includes(value.action) && value.publication !== "ISSUE") fail(contract, `${path}.publication`, "must be ISSUE for an Issue action");
  if (["NOOP", "MANUAL_REVIEW"].includes(value.action) && value.publication !== "NONE") fail(contract, `${path}.publication`, "must be NONE without a publication side effect");
  if (["UPDATE_ISSUE", "UPDATE_DRAFT_PR", "NOOP"].includes(value.action) && value.target === undefined) fail(contract, `${path}.target`, "is required for an existing publication action");
  if (["CREATE_ISSUE", "CREATE_DRAFT_PR", "MANUAL_REVIEW"].includes(value.action) && value.target !== undefined) fail(contract, `${path}.target`, "is not allowed for this action");
}

function validateGitHubPublicationResult(value, path) {
  const contract = "GitHubPublicationResult";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "repository", "publication", "action", "target", "matches", "occurrence", "source", "publicationFingerprint"], path, contract);
  exact(value.schemaVersion, GITHUB_PUBLICATION_RESULT_VERSION, `${path}.schemaVersion`, contract);
  repositorySlug(value.repository, `${path}.repository`, contract);
  oneOf(value.publication, ["ISSUE", "DRAFT_PR", "UNRESOLVED"], `${path}.publication`, contract);
  oneOf(value.action, ["CREATED", "UPDATED", "NOOP", "AMBIGUOUS"], `${path}.action`, contract);
  if (value.action === "AMBIGUOUS") {
    exact(value.publication, "UNRESOLVED", `${path}.publication`, contract);
    if (value.target !== undefined || value.occurrence !== undefined) fail(contract, path, "ambiguous publication cannot select a target");
    array(value.matches, `${path}.matches`, contract);
    if (value.matches.length < 2 || value.matches.length > 10) fail(contract, `${path}.matches`, "must contain 2 to 10 matches");
    value.matches.forEach((match, index) => validateGitHubPublicationTarget(match, `${path}.matches[${index}]`, value.repository, contract));
    const matchKeys = value.matches.map((match) => String(match.number));
    if (new Set(matchKeys).size !== matchKeys.length) fail(contract, `${path}.matches`, "must contain unique publications");
  } else {
    oneOf(value.publication, ["ISSUE", "DRAFT_PR"], `${path}.publication`, contract);
    if (value.matches !== undefined) fail(contract, `${path}.matches`, "is only allowed for ambiguous publication");
    validateGitHubPublicationTarget(value.target, `${path}.target`, value.repository, contract);
    exact(value.target.publication, value.publication, `${path}.target.publication`, contract);
    object(value.occurrence, `${path}.occurrence`, contract);
    allowedKeys(value.occurrence, ["count", "firstSeen", "lastSeen"], `${path}.occurrence`, contract);
    boundedInteger(value.occurrence.count, 1, Number.MAX_SAFE_INTEGER, `${path}.occurrence.count`, contract);
    boundedString(value.occurrence.firstSeen, 128, `${path}.occurrence.firstSeen`, contract);
    boundedString(value.occurrence.lastSeen, 128, `${path}.occurrence.lastSeen`, contract);
    if (value.action === "CREATED" && value.occurrence.count !== 1) fail(contract, `${path}.occurrence.count`, "must be 1 for a created publication");
  }
  object(value.source, `${path}.source`, contract);
  allowedKeys(value.source, ["runId", "evidenceBundleId", "judgeResultId", "failureDiagnosisId", "codeContextBundleId", "repairRecommendationId"], `${path}.source`, contract);
  for (const key of ["runId", "evidenceBundleId", "judgeResultId", "failureDiagnosisId", "codeContextBundleId"]) boundedString(value.source[key], 512, `${path}.source.${key}`, contract);
  if (value.source.repairRecommendationId !== undefined) boundedString(value.source.repairRecommendationId, 512, `${path}.source.repairRecommendationId`, contract);
  sha256Hash(value.publicationFingerprint, `${path}.publicationFingerprint`, contract);
}

function validateGitHubPublicationTarget(value, path, repository, contract) {
  object(value, path, contract);
  allowedKeys(value, ["publication", "number", "url"], path, contract);
  oneOf(value.publication, ["ISSUE", "DRAFT_PR"], `${path}.publication`, contract);
  boundedInteger(value.number, 1, Number.MAX_SAFE_INTEGER, `${path}.number`, contract);
  boundedString(value.url, 2_048, `${path}.url`, contract);
  let url;
  try { url = new URL(value.url); } catch { fail(contract, `${path}.url`, "must be a GitHub publication URL"); }
  const segment = value.publication === "ISSUE" ? "issues" : "pull";
  if (url?.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || url.pathname.toLowerCase() !== `/${repository}/${segment}/${value.number}`.toLowerCase()) fail(contract, `${path}.url`, "must match the GitHub publication");
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

function validateAdaptivePage(value, path, contract) {
  object(value, path, contract);
  allowedKeys(value, ["pageId", "domGeneration", "url"], path, contract);
  boundedString(value.pageId, 256, `${path}.pageId`, contract);
  boundedInteger(value.domGeneration, 1, Number.MAX_SAFE_INTEGER, `${path}.domGeneration`, contract);
  httpUrl(value.url, `${path}.url`, contract);
}

function validateAdaptiveObservation(value, path, contract) {
  object(value, path, contract);
  allowedKeys(value, ["observationId", "pageId", "domGeneration", "elements", "satisfiedMilestoneIds"], path, contract);
  boundedString(value.observationId, 256, `${path}.observationId`, contract);
  boundedString(value.pageId, 256, `${path}.pageId`, contract);
  boundedInteger(value.domGeneration, 1, Number.MAX_SAFE_INTEGER, `${path}.domGeneration`, contract);
  array(value.elements, `${path}.elements`, contract);
  if (value.elements.length > 256) fail(contract, `${path}.elements`, "must contain at most 256 elements");
  value.elements.forEach((element, index) => {
    const elementPath = `${path}.elements[${index}]`;
    object(element, elementPath, contract);
    allowedKeys(element, ["elementId", "milestoneIds", "allowedActions", "role", "accessibleName", "text"], elementPath, contract);
    boundedString(element.elementId, 256, `${elementPath}.elementId`, contract);
    uniqueStringArray(element.milestoneIds, `${elementPath}.milestoneIds`, contract);
    if (element.milestoneIds.length > 64) fail(contract, `${elementPath}.milestoneIds`, "must contain at most 64 milestones");
    element.milestoneIds.forEach((id, milestoneIndex) => boundedString(id, 256, `${elementPath}.milestoneIds[${milestoneIndex}]`, contract));
    uniqueStringArray(element.allowedActions, `${elementPath}.allowedActions`, contract);
    element.allowedActions.forEach((action, actionIndex) => oneOf(action, ELEMENT_BOUND_ACTIONS, `${elementPath}.allowedActions[${actionIndex}]`, contract));
    if (element.role !== undefined) boundedString(element.role, 256, `${elementPath}.role`, contract);
    if (element.accessibleName !== undefined) boundedString(element.accessibleName, 1_024, `${elementPath}.accessibleName`, contract);
    if (element.text !== undefined) boundedString(element.text, 1_024, `${elementPath}.text`, contract);
  });
  const elementIds = value.elements.map((element) => element.elementId);
  if (new Set(elementIds).size !== elementIds.length) fail(contract, `${path}.elements`, "element ids must be unique");
  if (value.satisfiedMilestoneIds !== undefined) {
    uniqueStringArray(value.satisfiedMilestoneIds, `${path}.satisfiedMilestoneIds`, contract);
    if (value.satisfiedMilestoneIds.length > 64) fail(contract, `${path}.satisfiedMilestoneIds`, "must contain at most 64 milestones");
  }
}

function validateAdaptiveBudget(value, path, contract) {
  object(value, path, contract);
  allowedKeys(value, ["actions", "turns", "timeMs", "tokens"], path, contract);
  boundedInteger(value.actions, 0, 256, `${path}.actions`, contract);
  boundedInteger(value.turns, 0, 256, `${path}.turns`, contract);
  boundedInteger(value.timeMs, 0, 600_000, `${path}.timeMs`, contract);
  boundedInteger(value.tokens, 0, 1_000_000, `${path}.tokens`, contract);
}

function validateAdaptiveActionParameters(action, value, path, contract) {
  object(value, path, contract);
  // The permitted key set is the single source in ACTION_SPECS; only the per-action *value* rules
  // (URL shape, non-zero scroll delta, state enum, string/integer bounds) live here.
  allowedKeys(value, ACTION_SPECS[action].params, path, contract);
  if (action === "navigate") {
    httpUrl(value.url, `${path}.url`, contract);
  } else if (action === "click_observed_element" || action === "hover_observed_element") {
    boundedString(value.observationId, 256, `${path}.observationId`, contract);
    boundedString(value.elementId, 256, `${path}.elementId`, contract);
  } else if (action === "press_key") {
    exact(value.key, "Escape", `${path}.key`, contract);
  } else if (action === "scroll_view") {
    boundedInteger(value.deltaX, -4_096, 4_096, `${path}.deltaX`, contract);
    boundedInteger(value.deltaY, -4_096, 4_096, `${path}.deltaY`, contract);
    if (value.deltaX === 0 && value.deltaY === 0) fail(contract, path, "scroll delta must be non-zero");
  } else if (action === "wait_for_element_state") {
    boundedString(value.observationId, 256, `${path}.observationId`, contract);
    boundedString(value.elementId, 256, `${path}.elementId`, contract);
    oneOf(value.state, ["present", "absent", "visible", "hidden"], `${path}.state`, contract);
    boundedInteger(value.timeoutMs, 1, 10_000, `${path}.timeoutMs`, contract);
  } else if (action === "report_blocked") {
    boundedString(value.milestoneId, 256, `${path}.milestoneId`, contract);
    boundedString(value.reason, 4_096, `${path}.reason`, contract);
  }
}

function httpUrl(value, path, contract) {
  boundedString(value, 4_096, path, contract);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(contract, path, "must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(contract, path, "must be an absolute HTTP(S) URL without credentials, query, or fragment");
  return url;
}

function httpOrigin(value, path, contract) {
  const url = httpUrl(value, path, contract);
  if (value !== url.origin) fail(contract, path, "must be an origin without path, query, or fragment");
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

function scenarioExpectationIds(qaIr, bundle) {
  const scenario = qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === bundle.scenarioId);
  if (!scenario) fail("JudgeResult", "$.evidenceBundle.scenarioId", `unknown scenario ${bundle.scenarioId}`);
  return new Set(scenario.expectations.map((expectation) => expectation.id));
}

function diagnostics(value, path, contract) { array(value, path, contract); value.forEach((item, index) => validateDiagnostic(item, `${path}[${index}]`)); }
function recordArray(value, path, contract) { array(value, path, contract); value.forEach((item, index) => object(item, `${path}[${index}]`, contract)); }
function allowedKeys(value, allowed, path, contract) { rejectKeys(value, Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.includes(key)), path, contract); }
function rejectKeys(value, keys, path, contract) { for (const key of keys) if (Object.hasOwn(value, key)) fail(contract, `${path}.${String(key)}`, "is not allowed"); }
function object(value, path, contract) { if (!isRecord(value)) fail(contract, path, "must be an object"); }
function array(value, path, contract) { if (!Array.isArray(value)) fail(contract, path, "must be an array"); }
function stringArray(value, path, contract) { array(value, path, contract); value.forEach((item, index) => string(item, `${path}[${index}]`, contract)); }
function uniqueStringArray(value, path, contract) { stringArray(value, path, contract); if (new Set(value).size !== value.length) fail(contract, path, "must contain unique strings"); }
function string(value, path, contract) { if (typeof value !== "string" || value.length === 0) fail(contract, path, "must be a non-empty string"); }
function boundedString(value, maxLength, path, contract) { string(value, path, contract); if (value.length > maxLength) fail(contract, path, `must contain at most ${maxLength} characters`); }
function utf8Text(value, maxBytes, allowEmpty, path, contract) { if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) fail(contract, path, "must be bounded UTF-8 text"); const encoded = new TextEncoder().encode(value); if (encoded.length > maxBytes || new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== value) fail(contract, path, "must be bounded UTF-8 text"); }
function sha256Hash(value, path, contract) { if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) fail(contract, path, "must be a SHA-256 hash"); }
function boundedInteger(value, min, max, path, contract) { number(value, path, contract); if (!Number.isInteger(value) || value < min || value > max) fail(contract, path, `must be an integer between ${min} and ${max}`); }
function repositoryPath(value, path, contract) { boundedString(value, 4_096, path, contract); if (/^(?:[a-z]:[\\/]|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)|[\0\r\n]/i.test(value)) fail(contract, path, "must be a safe repository-relative path"); }
function repositorySlug(value, path, contract) { boundedString(value, 201, path, contract); const parts = value.split("/"); if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value) || parts.some((part) => part === "." || part === "..")) fail(contract, path, "must be an owner/repository slug"); }
function number(value, path, contract) { if (typeof value !== "number" || Number.isNaN(value)) fail(contract, path, "must be a number"); }
function probability(value, path, contract) { number(value, path, contract); if (!Number.isFinite(value) || value < 0 || value > 1) fail(contract, path, "must be between 0 and 1"); }
function bool(value, path, contract) { if (typeof value !== "boolean") fail(contract, path, "must be a boolean"); }
function present(value, path, contract) { if (value === undefined) fail(contract, path, "is required"); }
function exact(value, expected, path, contract) { if (value !== expected) fail(contract, path, `must equal ${JSON.stringify(expected)}`); }
function oneOf(value, allowed, path, contract) { if (!allowed.includes(value)) fail(contract, path, `must be one of: ${allowed.join(", ")}`); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function deepFreeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
function fail(contract, path, message) { throw new ContractViolationError(contract, message, path); }
