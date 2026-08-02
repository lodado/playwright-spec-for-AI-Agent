import { createHash } from "node:crypto";

export const CONTRACT_VIOLATION = "CONTRACT_VIOLATION";
export const ARTIFACT_VERSION = "artifact/0.1";
export const QA_IR_VERSION = "qa-ir/0.3";
export const PLAYWRIGHT_STATIC_MANIFEST_VERSION = "playwright-static-manifest/0.2";
export const COMPILE_RESULT_VERSION = "compile-result/0.1";
export const DIAGNOSTIC_VERSION = "diagnostic/0.1";
export const PROVIDER_CAPABILITIES_VERSION = "provider-capabilities/0.1";
export const EXECUTION_AGENT_INPUT_VERSION = "execution-agent-input/0.3";
export const EXECUTION_ACTION_PROPOSAL_VERSION = "execution-action-proposal/0.2";
export const EXECUTION_ACTION_RESULT_VERSION = "execution-action-result/0.1";
export const EXECUTION_AGENT_OUTCOME_VERSION = "execution-agent-outcome/0.1";
export const RUNTIME_OUTCOME_VERSION = "runtime-outcome/0.1";
export const EVIDENCE_BUNDLE_VERSION = "evidence-bundle/0.1";
export const EVIDENCE_MANIFEST_VERSION = "run-evidence/3.0";
export const JUDGE_RESULT_VERSION = "judge-result/0.1";
export const JUDGMENT_REVIEW_VERSION = "judgment-review/0.1";
export const SEMANTIC_JUDGE_INPUT_VERSION = "semantic-judge-input/0.3";
export const SEMANTIC_JUDGE_DECISION_VERSION = "semantic-judge-decision/0.1";

export const VERDICTS = Object.freeze(["PASS", "FAIL", "SKIP", "MANUAL_REVIEW"]);
export const EXPECTATION_STATUSES = Object.freeze(["MATCHED", "CONTRADICTED", "NOT_OBSERVED", "AMBIGUOUS", "NOT_APPLICABLE"]);
export const MILESTONE_CLASSES = Object.freeze(["REQUIRED_EXACT_ACTION", "REQUIRED_SEMANTIC_MILESTONE", "OPTIONAL_HINT"]);
export const EVIDENCE_ARCHIVE_LIMITS = Object.freeze({ checkpoints: 1_024, artifacts: 8_192 });
// The single adaptive action vocabulary. Every consumer derives from this table instead of
// keeping its own copy of the action names: lease building, milestone semantics, the Playwright
// gateway dispatch guard, the provider prompt, parameter key
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
  // Replays the milestone's designated @qa-fixture file into the observed file input. Not a recovery
  // action — only offered when the scenario declares an upload milestone with a fixture.
  upload_observed_element: Object.freeze({ params: OBSERVED_ELEMENT_PARAMS, requiresPolicy: "click", elementBound: true }),
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

const runtimeStages = ["execute", "evidence", "judge", "review", "report"];
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
  ExecutionAgentInput: validateExecutionAgentInput,
  ExecutionActionProposal: validateExecutionActionProposal,
  ExecutionActionResult: validateExecutionActionResult,
  ExecutionAgentOutcome: validateExecutionAgentOutcome,
  RuntimeOutcome: validateRuntimeOutcome,
  EvidenceBundle: validateEvidenceBundle,
  EvidenceManifest: validateEvidenceManifest,
  JudgeResult: validateJudgeResult,
  JudgmentReview: validateJudgmentReview,
  SemanticJudgeInput: validateSemanticJudgeInput,
  SemanticJudgeDecision: validateSemanticJudgeDecision,
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
  allowedKeys(value, ["id", "title", "preconditions", "steps", "expectations", "policy", "provenance", "fixtures", "semantics"], path, "QaIrDocument");
  string(value.id, `${path}.id`, "QaIrDocument");
  string(value.title, `${path}.title`, "QaIrDocument");
  // Optional additive field (no schemaVersion bump): `@qa-fixture` name→repo-relative path map for
  // file-upload replay. Old IRs without it stay valid.
  if (value.fixtures !== undefined) {
    object(value.fixtures, `${path}.fixtures`, "QaIrDocument");
    for (const [name, fixturePath] of Object.entries(value.fixtures)) {
      boundedString(name, 128, `${path}.fixtures.${name}`, "QaIrDocument");
      boundedString(fixturePath, 1_024, `${path}.fixtures.${name}`, "QaIrDocument");
    }
  }
  if (value.semantics !== undefined) validateScenarioSemantics(value.semantics, `${path}.semantics`);
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
    oneOf(expectation.kind, ["CONTAINS_TEXT", "VISIBLE", "NOT_VISIBLE", "PRESENT", "DISABLED", "ROLE", "NAME", "ATTRIBUTE", "URL", "URL_MATCH", "VISIBLE_TEXT", "SEMANTIC_CLAIM", "VISUAL_CONSISTENCY", "VISUAL_STABILITY"], `${expectationPath}.kind`, "QaIrDocument");
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

function validateScenarioSemantics(value, path, contract = "QaIrDocument") {
  object(value, path, contract);
  allowedKeys(value, ["given", "when", "then", "classification"], path, contract);
  for (const key of ["given", "when", "then"]) {
    array(value[key], `${path}.${key}`, contract);
    if (value[key].length > 20 || (key === "then" && value[key].length === 0)) fail(contract, `${path}.${key}`, `must contain ${key === "then" ? "1 to" : "at most"} 20 items`);
    value[key].forEach((item, index) => boundedString(item, 4_096, `${path}.${key}[${index}]`, contract));
  }
  oneOf(value.classification, ["LIVE_EXECUTABLE", "LIVE_JUDGMENT_ONLY", "MOCK_ONLY", "AMBIGUOUS"], `${path}.classification`, contract);
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
    allowedKeys(milestone, ["id", "class", "status", "description", "requiredAction", "target", "expectation", "fixture", "exploratory"], milestonePath, contract);
    boundedString(milestone.id, 256, `${milestonePath}.id`, contract);
    oneOf(milestone.class, MILESTONE_CLASSES, `${milestonePath}.class`, contract);
    oneOf(milestone.status, ["PENDING", "COMPLETED", "BLOCKED"], `${milestonePath}.status`, contract);
    boundedString(milestone.description, 4_096, `${milestonePath}.description`, contract);
    if (milestone.exploratory !== undefined) {
      bool(milestone.exploratory, `${milestonePath}.exploratory`, contract);
      if (milestone.exploratory !== true || milestone.class !== "REQUIRED_SEMANTIC_MILESTONE" || milestone.target !== undefined || milestone.expectation !== undefined) fail(contract, `${milestonePath}.exploratory`, "is only allowed on a targetless semantic milestone");
    }
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
    // A designated @qa-fixture for an upload milestone: its id (fixture name) and repo-relative path.
    if (milestone.fixture !== undefined) {
      if (milestone.requiredAction !== "upload_observed_element") fail(contract, `${milestonePath}.fixture`, "is only allowed for an upload_observed_element milestone");
      object(milestone.fixture, `${milestonePath}.fixture`, contract);
      allowedKeys(milestone.fixture, ["id", "path"], `${milestonePath}.fixture`, contract);
      boundedString(milestone.fixture.id, 128, `${milestonePath}.fixture.id`, contract);
      boundedString(milestone.fixture.path, 1_024, `${milestonePath}.fixture.path`, contract);
    }
    if (milestone.requiredAction === "upload_observed_element" && milestone.fixture === undefined) fail(contract, `${milestonePath}.fixture`, "is required for an upload_observed_element milestone");
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
  allowedKeys(value, ["schemaVersion", "runId", "checkpoints", "bindings"], path, "EvidenceManifest");
  exact(value.schemaVersion, EVIDENCE_MANIFEST_VERSION, `${path}.schemaVersion`, "EvidenceManifest");
  string(value.runId, `${path}.runId`, "EvidenceManifest");
  if (value.bindings !== undefined) {
    object(value.bindings, `${path}.bindings`, "EvidenceManifest");
    allowedKeys(value.bindings, ["authorityHash", "behaviorHash"], `${path}.bindings`, "EvidenceManifest");
    string(value.bindings.authorityHash, `${path}.bindings.authorityHash`, "EvidenceManifest");
    string(value.bindings.behaviorHash, `${path}.bindings.behaviorHash`, "EvidenceManifest");
  }
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
  allowedKeys(value.scenario, ["id", "title", "semantics", "requiredPath"], `${path}.scenario`, "SemanticJudgeInput");
  string(value.scenario.id, `${path}.scenario.id`, "SemanticJudgeInput");
  string(value.scenario.title, `${path}.scenario.title`, "SemanticJudgeInput");
  if (value.scenario.semantics !== undefined) validateScenarioSemantics(value.scenario.semantics, `${path}.scenario.semantics`, "SemanticJudgeInput");
  if (value.scenario.requiredPath !== undefined) boundedString(value.scenario.requiredPath, 2_048, `${path}.scenario.requiredPath`, "SemanticJudgeInput");
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

function validateJudgmentReview(value, path, context = {}) {
  const contract = "JudgmentReview";
  object(value, path, contract);
  allowedKeys(value, ["schemaVersion", "reviewId", "qaIrId", "evidenceBundleId", "judgeResultId", "status", "issues", "reviewer", "inputHash"], path, contract);
  exact(value.schemaVersion, JUDGMENT_REVIEW_VERSION, `${path}.schemaVersion`, contract);
  for (const key of ["reviewId", "qaIrId", "evidenceBundleId", "judgeResultId", "inputHash"]) boundedString(value[key], 512, `${path}.${key}`, contract);
  oneOf(value.status, ["APPROVED", "MANUAL_REVIEW"], `${path}.status`, contract);
  array(value.issues, `${path}.issues`, contract);
  if (value.issues.length > 20 || (value.status === "APPROVED" && value.issues.length !== 0) || (value.status !== "APPROVED" && value.issues.length === 0)) fail(contract, `${path}.issues`, "must agree with review status");
  value.issues.forEach((issue, index) => boundedString(issue, 2_000, `${path}.issues[${index}]`, contract));
  object(value.reviewer, `${path}.reviewer`, contract);
  allowedKeys(value.reviewer, ["provider", "model", "modelVersion", "promptVersion"], `${path}.reviewer`, contract);
  for (const key of ["provider", "model", "promptVersion"]) boundedString(value.reviewer[key], 512, `${path}.reviewer.${key}`, contract);
  if (value.reviewer.modelVersion !== undefined) boundedString(value.reviewer.modelVersion, 512, `${path}.reviewer.modelVersion`, contract);
  if (context.qaIr !== undefined) {
    validateQaIrDocument(context.qaIr, "$.qaIr");
    exact(value.qaIrId, context.qaIr.id, `${path}.qaIrId`, contract);
  }
  if (context.judgeResult !== undefined) {
    validateJudgeResult(context.judgeResult, "$.judgeResult", context);
    exact(value.judgeResultId, context.judgeResult.resultId, `${path}.judgeResultId`, contract);
    exact(value.evidenceBundleId, context.judgeResult.evidenceBundleId, `${path}.evidenceBundleId`, contract);
  }
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
  httpUrl(value.url, `${path}.url`, contract, { allowQuery: true });
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
  } else if (action === "click_observed_element" || action === "hover_observed_element" || action === "upload_observed_element") {
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

function httpUrl(value, path, contract, { allowQuery = false } = {}) {
  boundedString(value, 4_096, path, contract);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(contract, path, "must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || (!allowQuery && url.search)) fail(contract, path, allowQuery ? "must be an absolute HTTP(S) URL without credentials or fragment" : "must be an absolute HTTP(S) URL without credentials, query, or fragment");
  if (allowQuery && [...url.searchParams.keys()].some(isSensitiveQueryKey)) fail(contract, path, "must not contain sensitive query parameters");
  return url;
}

function isSensitiveCredentialKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return ["authentication", "authorization", "cookie", "credential", "jwt", "token", "password", "passwd", "secret", "signature", "apikey", "session", "sessionid", "sessid", "assertion", "auth"].some((suffix) => normalized.endsWith(suffix)) ||
    ["sig", "sid", "csrf", "otp", "nonce", "oauthcode", "oauthstate", "samlresponse", "samlassertion", "loginticket"].includes(normalized);
}

export function isSensitiveQueryKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return isSensitiveCredentialKey(key) || ["code", "state", "ticket"].includes(normalized);
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
