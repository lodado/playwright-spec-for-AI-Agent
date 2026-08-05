import { createHash } from "node:crypto";
import { canonicalHash as sharedCanonicalHash, canonicalJson as sharedCanonicalJson } from "qa-kit/canonical";

export const STUDY_SPEC_VERSION = "study-spec/0.1";
export const SESSION_VERSION = "session/0.1";
export const OBSERVATION_VERSION = "observation/0.1";
export const INTERACTION_EVENT_VERSION = "interaction-event/0.2";
export const MODEL_ATTEMPT_VERSION = "model-attempt/0.1";
export const EVIDENCE_MANIFEST_VERSION = "evidence-manifest/0.3";
export const FUNCTIONAL_EVALUATION_VERSION = "functional-evaluation/0.1";
export const FRICTION_POINT_VERSION = "friction-point/0.1";
export const FINDING_VERSION = "finding/0.1";
export const SIMULATION_VALIDITY_VERSION = "simulation-validity/0.1";
export const VARIANT_COMPARISON_REPORT_VERSION = "variant-comparison-report/0.1";

export const INTERACTION_RESULT_CODES = Object.freeze([
  "ELEMENT_NOT_FOUND",
  "ACTION_NOT_ALLOWED",
  "ORIGIN_BLOCKED",
  "DRIVER_ACTION_FAILED",
]);

export const VALIDATION_ERROR_CODE = "CONTRACT_VALIDATION_FAILED";
export const MIGRATION_ERROR_CODE = "CONTRACT_MIGRATION_FAILED";

export class ContractValidationError extends Error {
  constructor(message, path = "$") {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
    this.code = VALIDATION_ERROR_CODE;
    this.path = path;
  }
}

export class ContractMigrationError extends Error {
  constructor(message, path = "$") {
    super(`${path}: ${message}`);
    this.name = "ContractMigrationError";
    this.code = MIGRATION_ERROR_CODE;
    this.path = path;
  }
}

export function canonicalJson(value) {
  return sharedCanonicalJson(value);
}

export function canonicalHash(value) {
  return sharedCanonicalHash(value);
}

export function redactStudySecrets(study) {
  const copy = structuredClone(study);
  if (copy?.environment?.fixtures) {
    copy.environment.fixtures = Object.fromEntries(Object.keys(copy.environment.fixtures).map((key) => [key, "[REDACTED]"]));
  }
  if (copy?.environment?.auth) copy.environment.auth = redactStringLeaves(copy.environment.auth);
  if (copy?.environment?.storageStatePath) copy.environment.storageStatePath = "[REDACTED]";
  return copy;
}

function redactStringLeaves(value) {
  if (Array.isArray(value)) return value.map(redactStringLeaves);
  if (!value || typeof value !== "object") return typeof value === "string" ? "[REDACTED]" : value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactStringLeaves(child)]));
}

export function stableId(prefix, parts) {
  if (!Array.isArray(parts) || parts.length === 0) throw new ContractValidationError("parts must be a non-empty array", "$.parts");
  return `${prefix}_${createHash("sha256").update(parts.map((part) => canonicalJson(part)).join("\n")).digest("hex").slice(0, 16)}`;
}

export function createSessionId({ runId, taskId, personaId, seed, variant = "default" }) {
  return stableId("session", [runId, taskId, personaId, seed, variant]);
}

export function createEventId(sessionId, sequence) {
  return stableId("event", [sessionId, sequence]);
}

export function createEvidenceId({ sessionId, type, sequence, contentHash }) {
  return stableId("evidence", [sessionId, type, sequence, contentHash]);
}

export function validateContract(contractName, value) {
  const validator = validators[contractName];
  if (!validator) throw new ContractValidationError(`unknown contract ${contractName}`);
  return validator(value);
}

export function validateStudySpec(value) {
  object(value, "$", ["schemaVersion", "study", "product", "environment", "tasks", "personas", "runtime", "evidence", "evaluation", "comparison", "provenance"]);
  version(value, STUDY_SPEC_VERSION, "$");
  object(value.study, "$.study", ["id", "name", "description", "tags"]);
  string(value.study.id, "$.study.id");
  string(value.study.name, "$.study.name");
  optional(value.study.description, string, "$.study.description");
  optional(value.study.tags, arrayOf(string), "$.study.tags");
  object(value.product, "$.product", ["description", "domain", "audience", "metadata"]);
  string(value.product.description, "$.product.description");
  optional(value.product.domain, string, "$.product.domain");
  optional(value.product.audience, string, "$.product.audience");
  optionalRecord(value.product.metadata, "$.product.metadata");
  validateEnvironment(value.environment, "$.environment");
  nonEmptyArray(value.tasks, "$.tasks").forEach((task, index) => validateTask(task, `$.tasks[${index}]`));
  nonEmptyArray(value.personas, "$.personas").forEach((persona, index) => validatePersona(persona, `$.personas[${index}]`));
  validateRuntimeConfig(value.runtime, "$.runtime");
  uniqueIdentities(value.tasks, (task) => task.id, "$.tasks", "task id");
  uniqueIdentities(value.personas, (persona) => persona.id ?? persona.preset, "$.personas", "persona identity");
  uniqueIdentities(value.runtime.seeds, (seed) => seed, "$.runtime.seeds", "seed");
  validateEvidencePolicy(value.evidence, "$.evidence");
  validateEvaluationPolicy(value.evaluation, "$.evaluation");
  optional(value.comparison, validateVariantComparisonSpec, "$.comparison");
  if (value.provenance !== undefined) {
    object(value.provenance, "$.provenance", ["source", "sourceRefs", "generatedAt"]);
    oneOf(value.provenance.source, ["manual", "playwright-spec", "qa-ir", "generated"], "$.provenance.source");
    optional(value.provenance.sourceRefs, arrayOf(string), "$.provenance.sourceRefs");
    optional(value.provenance.generatedAt, string, "$.provenance.generatedAt");
  }
  return deepFreeze(value);
}

export function validateSessionRecord(value) {
  object(value, "$", ["schemaVersion", "runId", "sessionId", "studyId", "taskId", "personaId", "seed", "variant", "model", "status", "startedAt", "completedAt", "sampledPolicy", "terminalReason", "eventIds", "evidenceManifestId"]);
  version(value, SESSION_VERSION, "$");
  ["runId", "sessionId", "studyId", "taskId", "personaId", "startedAt"].forEach((key) => string(value[key], `$.${key}`));
  integer(value.seed, "$.seed");
  optional(value.variant, string, "$.variant");
  optional(value.model, string, "$.model");
  oneOf(value.status, ["created", "running", "success", "partial", "failure", "abandoned", "runtime_error", "manual_review"], "$.status");
  optional(value.completedAt, string, "$.completedAt");
  object(value.sampledPolicy, "$.sampledPolicy");
  optionalRecord(value.terminalReason, "$.terminalReason");
  arrayOf(string)(value.eventIds, "$.eventIds");
  optional(value.evidenceManifestId, string, "$.evidenceManifestId");
  return deepFreeze(value);
}

export function validateObservation(value) {
  object(value, "$", ["schemaVersion", "id", "sessionId", "sequence", "timestamp", "page", "semantic", "visual", "runtime", "oracleSignals"]);
  version(value, OBSERVATION_VERSION, "$");
  ["id", "sessionId", "timestamp"].forEach((key) => string(value[key], `$.${key}`));
  integer(value.sequence, "$.sequence");
  object(value.page, "$.page", ["url", "title", "viewport"]);
  string(value.page.url, "$.page.url");
  string(value.page.title, "$.page.title");
  validateViewport(value.page.viewport, "$.page.viewport");
  object(value.semantic, "$.semantic", ["visibleText", "headings", "landmarks", "interactiveElements"]);
  arrayOf(string)(value.semantic.visibleText, "$.semantic.visibleText");
  arrayOf(validateSemanticNode)(value.semantic.headings, "$.semantic.headings");
  arrayOf(validateSemanticNode)(value.semantic.landmarks, "$.semantic.landmarks");
  arrayOf(validateInteractiveElement)(value.semantic.interactiveElements, "$.semantic.interactiveElements");
  object(value.visual, "$.visual", ["screenshotEvidenceId", "occludedElementFingerprints"]);
  optional(value.visual.screenshotEvidenceId, string, "$.visual.screenshotEvidenceId");
  optional(value.visual.occludedElementFingerprints, arrayOf(string), "$.visual.occludedElementFingerprints");
  object(value.runtime, "$.runtime", ["consoleIssues", "networkFailures", "pendingRequestCount", "loadingIndicators"]);
  arrayOf(validateRuntimeIssue)(value.runtime.consoleIssues, "$.runtime.consoleIssues");
  arrayOf(validateRuntimeIssue)(value.runtime.networkFailures, "$.runtime.networkFailures");
  integer(value.runtime.pendingRequestCount, "$.runtime.pendingRequestCount");
  arrayOf(string)(value.runtime.loadingIndicators, "$.runtime.loadingIndicators");
  validateOracleSignals(value.oracleSignals, "$.oracleSignals");
  return deepFreeze(value);
}

export function validateInteractionEvent(value) {
  object(value, "$", ["schemaVersion", "id", "sessionId", "index", "timestamp", "observationId", "action", "result", "urlBefore", "urlAfter", "evidenceIds", "derivedSignals"]);
  version(value, INTERACTION_EVENT_VERSION, "$");
  ["id", "sessionId", "timestamp", "observationId", "urlBefore", "urlAfter"].forEach((key) => string(value[key], `$.${key}`));
  integer(value.index, "$.index");
  validateBrowserAction(value.action, "$.action");
  object(value.result, "$.result", ["status", "code", "message"]);
  oneOf(value.result.status, ["success", "failure", "no_change", "blocked"], "$.result.status");
  optional(value.result.code, (code, path) => oneOf(code, INTERACTION_RESULT_CODES, path), "$.result.code");
  optional(value.result.message, string, "$.result.message");
  arrayOf(string)(value.evidenceIds, "$.evidenceIds");
  object(value.derivedSignals, "$.derivedSignals", ["progressChanged", "backtrack", "repeatedPage", "failedInteraction", "noProgress"]);
  ["progressChanged", "backtrack", "repeatedPage", "failedInteraction", "noProgress"].forEach((key) => boolean(value.derivedSignals[key], `$.derivedSignals.${key}`));
  return deepFreeze(value);
}

export function validateEvidenceManifest(value) {
  object(value, "$", ["schemaVersion", "id", "runId", "sessionId", "createdAt", "sealedAt", "sealed", "repositoryRevision", "studyHash", "policyHash", "entries", "manifestHash", "redactionSummary"]);
  version(value, EVIDENCE_MANIFEST_VERSION, "$");
  ["id", "runId", "sessionId", "createdAt", "sealedAt", "studyHash", "policyHash", "manifestHash"].forEach((key) => string(value[key], `$.${key}`));
  if (value.sealed !== true) throw new ContractValidationError("must be true", "$.sealed");
  optional(value.repositoryRevision, string, "$.repositoryRevision");
  arrayOf(validateEvidenceEntry)(value.entries, "$.entries");
  object(value.redactionSummary, "$.redactionSummary", ["redactedCount", "rulesVersion"]);
  integer(value.redactionSummary.redactedCount, "$.redactionSummary.redactedCount");
  string(value.redactionSummary.rulesVersion, "$.redactionSummary.rulesVersion");
  return deepFreeze(value);
}

export function validateModelAttempt(value) {
  object(value, "$", ["schemaVersion", "provider", "model", "promptVersion", "attempt", "inputDigest", "outputDigest", "latencyMs", "outcomeCode"]);
  version(value, MODEL_ATTEMPT_VERSION, "$");
  ["provider", "model", "promptVersion", "inputDigest", "outputDigest"].forEach((key) => string(value[key], `$.${key}`));
  positiveInteger(value.attempt, "$.attempt");
  integer(value.latencyMs, "$.latencyMs");
  if (value.latencyMs < 0) throw new ContractValidationError("must not be negative", "$.latencyMs");
  oneOf(value.outcomeCode, ["MODEL_ACTION_ACCEPTED", "MODEL_INVALID_OUTPUT", "MODEL_TIMEOUT", "MODEL_PROVIDER_FAILED"], "$.outcomeCode");
  return deepFreeze(value);
}

export function validateFunctionalEvaluation(value) {
  object(value, "$", ["schemaVersion", "status", "satisfiedOracleIds", "violatedOracleIds", "unknownOracleIds", "evidenceIds", "reasons"]);
  version(value, FUNCTIONAL_EVALUATION_VERSION, "$");
  oneOf(value.status, ["success", "partial", "failure", "runtime_error", "manual_review"], "$.status");
  ["satisfiedOracleIds", "violatedOracleIds", "unknownOracleIds", "evidenceIds", "reasons"].forEach((key) => arrayOf(string)(value[key], `$.${key}`));
  return deepFreeze(value);
}

export function validateBehavioralFingerprint(value) {
  object(value, "$", ["schemaVersion", "sessionId", "actionCount", "actionTypeRates", "uniqueActionTypeCount", "routeSequence", "routeEntropy", "firstActionType", "firstActionTargetFingerprint", "backtrackRate", "retryRate", "failedInteractionRate", "noActionRate", "abandonmentOccurred", "abandonmentRoute", "abandonmentReasonCode", "errorReactionVector", "progressCurve", "frustrationCurve", "trustCurve", "goalDirectednessScore"]);
  optionalVersion(value, "behavioral-fingerprint/0.1", "$");
  string(value.sessionId, "$.sessionId");
  integer(value.actionCount, "$.actionCount");
  numberRecord(value.actionTypeRates, "$.actionTypeRates");
  integer(value.uniqueActionTypeCount, "$.uniqueActionTypeCount");
  arrayOf(string)(value.routeSequence, "$.routeSequence");
  ["routeEntropy", "backtrackRate", "retryRate", "failedInteractionRate", "noActionRate", "goalDirectednessScore"].forEach((key) => number(value[key], `$.${key}`));
  optional(value.firstActionType, string, "$.firstActionType");
  optional(value.firstActionTargetFingerprint, string, "$.firstActionTargetFingerprint");
  boolean(value.abandonmentOccurred, "$.abandonmentOccurred");
  optional(value.abandonmentRoute, string, "$.abandonmentRoute");
  optional(value.abandonmentReasonCode, string, "$.abandonmentReasonCode");
  object(value.errorReactionVector, "$.errorReactionVector", ["retry", "backtrack", "ignore", "abandon"]);
  ["retry", "backtrack", "ignore", "abandon"].forEach((key) => number(value.errorReactionVector[key], `$.errorReactionVector.${key}`));
  ["progressCurve", "frustrationCurve", "trustCurve"].forEach((key) => arrayOf(number)(value[key], `$.${key}`));
  return deepFreeze(value);
}

export function validateFrictionPoint(value) {
  object(value, "$", ["schemaVersion", "id", "sessionId", "category", "observation", "interpretation", "severityCandidate", "route", "elementFingerprint", "oracleIds", "eventIds", "evidenceIds", "evaluatorConfidence"]);
  version(value, FRICTION_POINT_VERSION, "$");
  ["id", "sessionId", "observation", "interpretation"].forEach((key) => string(value[key], `$.${key}`));
  oneOf(value.category, categories, "$.category");
  oneOf(value.severityCandidate, severities, "$.severityCandidate");
  optional(value.route, string, "$.route");
  optional(value.elementFingerprint, string, "$.elementFingerprint");
  ["oracleIds", "eventIds", "evidenceIds"].forEach((key) => arrayOf(string)(value[key], `$.${key}`));
  if (value.eventIds.length === 0 || value.evidenceIds.length === 0) throw new ContractValidationError("friction points need event and evidence refs", "$");
  ratio(value.evaluatorConfidence, "$.evaluatorConfidence");
  return deepFreeze(value);
}

export function validateFinding(value) {
  object(value, "$", ["schemaVersion", "id", "fingerprint", "title", "category", "severity", "maturity", "observation", "interpretation", "recommendation", "affectedSessionIds", "affectedPersonaIds", "affectedTaskIds", "eventIds", "evidenceIds", "recurrenceRate", "confidence", "humanValidation"]);
  version(value, FINDING_VERSION, "$");
  ["id", "fingerprint", "title", "observation", "interpretation"].forEach((key) => string(value[key], `$.${key}`));
  oneOf(value.category, categories, "$.category");
  oneOf(value.severity, severities, "$.severity");
  oneOf(value.maturity, ["exploratory_signal", "reproduced_synthetic_finding", "calibrated_behavioral_risk", "human_validated_finding"], "$.maturity");
  optional(value.recommendation, string, "$.recommendation");
  ["affectedSessionIds", "affectedPersonaIds", "affectedTaskIds", "eventIds", "evidenceIds"].forEach((key) => arrayOf(string)(value[key], `$.${key}`));
  if (value.eventIds.length === 0 || value.evidenceIds.length === 0) throw new ContractValidationError("findings need event and evidence refs", "$");
  ratio(value.recurrenceRate, "$.recurrenceRate");
  validateFindingConfidence(value.confidence, "$.confidence");
  validateHumanValidation(value.humanValidation, "$.humanValidation");
  return deepFreeze(value);
}

export function validateSimulationValidityReport(value) {
  object(value, "$", ["schemaVersion", "calibration", "stability", "diversity", "detectedRisks", "recommendedUse", "forbiddenInterpretations"]);
  version(value, SIMULATION_VALIDITY_VERSION, "$");
  object(value.calibration, "$.calibration");
  if (value.calibration.level === "uncalibrated") string(value.calibration.reason, "$.calibration.reason");
  else optionalRecord(value.calibration, "$.calibration");
  object(value.stability, "$.stability", ["seedVariance", "modelAgreement", "orderConsistency"]);
  ["seedVariance", "modelAgreement", "orderConsistency"].forEach((key) => numberOrUnavailable(value.stability[key], `$.stability.${key}`));
  validatePopulationDiversity(value.diversity, "$.diversity");
  arrayOf((risk, path) => oneOf(risk, ["hyperactivity", "excessive_cooperation", "positivity_bias", "directive_amplification", "persona_homogenization", "domain_transfer", "position_bias", "insufficient_sample"], path))(value.detectedRisks, "$.detectedRisks");
  oneOf(value.recommendedUse, ["exploration_only", "release_warning", "human_review_required", "human_validation_required", "decision_support"], "$.recommendedUse");
  arrayOf(string)(value.forbiddenInterpretations, "$.forbiddenInterpretations");
  return deepFreeze(value);
}

export function validateVariantComparisonSpec(value, path = "$") {
  object(value, path, ["baseline", "candidate", "assignment", "counterbalanceOrder", "metrics"]);
  validateVariantRef(value.baseline, `${path}.baseline`);
  validateVariantRef(value.candidate, `${path}.candidate`);
  if (value.baseline.id === value.candidate.id) throw new ContractValidationError("must differ from baseline id", `${path}.candidate.id`);
  oneOf(value.assignment, ["paired", "independent"], `${path}.assignment`);
  boolean(value.counterbalanceOrder, `${path}.counterbalanceOrder`);
  arrayOf((metric, metricPath) => oneOf(metric, ["task_completion", "action_count", "backtrack", "failed_interaction", "abandonment", "finding_recurrence", "route_entropy"], metricPath))(value.metrics, `${path}.metrics`);
  return deepFreeze(value);
}

export function validateVariantComparisonReport(value) {
  object(value, "$", ["schemaVersion", "status", "baseline", "candidate", "metrics", "delta", "findingIds", "winner"]);
  version(value, VARIANT_COMPARISON_REPORT_VERSION, "$");
  oneOf(value.status, ["candidate_better", "baseline_better", "no_clear_difference", "unstable", "insufficient_evidence"], "$.status");
  validateVariantMetrics(value.baseline, "$.baseline");
  validateVariantMetrics(value.candidate, "$.candidate");
  validateVariantMetrics(value.metrics, "$.metrics");
  object(value.delta, "$.delta", ["completionDelta", "abandonmentDelta", "medianActionDelta", "backtrackDelta", "failedInteractionDelta", "affectedPersonaIds", "confidence"]);
  ["completionDelta", "abandonmentDelta", "medianActionDelta", "backtrackDelta", "failedInteractionDelta"].forEach((key) => number(value.delta[key], `$.delta.${key}`));
  arrayOf(string)(value.delta.affectedPersonaIds, "$.delta.affectedPersonaIds");
  validateFindingConfidence(value.delta.confidence, "$.delta.confidence");
  arrayOf(string)(value.findingIds, "$.findingIds");
  optional(value.winner, (winner, path) => oneOf(winner, ["baseline", "candidate", "none"], path), "$.winner");
  return deepFreeze(value);
}

export const defaultMigrationRegistry = createMigrationRegistry();
defaultMigrationRegistry.register({
  from: "interaction-event/0.1",
  to: INTERACTION_EVENT_VERSION,
  migrate(value) {
    return { ...value, schemaVersion: INTERACTION_EVENT_VERSION };
  },
});
defaultMigrationRegistry.register({
  from: "evidence-manifest/0.1",
  to: EVIDENCE_MANIFEST_VERSION,
  migrate(value) {
    return { ...value, schemaVersion: EVIDENCE_MANIFEST_VERSION, sealed: true };
  },
});
defaultMigrationRegistry.register({
  from: "evidence-manifest/0.2",
  to: EVIDENCE_MANIFEST_VERSION,
  migrate(value) {
    return { ...value, schemaVersion: EVIDENCE_MANIFEST_VERSION };
  },
});

export function createMigrationRegistry() {
  const migrators = new Map();
  return {
    register(migrator) {
      object(migrator, "$.migrator", ["from", "to", "migrate"]);
      string(migrator.from, "$.migrator.from");
      string(migrator.to, "$.migrator.to");
      if (typeof migrator.migrate !== "function") throw new ContractMigrationError("migrate must be a function", "$.migrator.migrate");
      migrators.set(`${migrator.from}->${migrator.to}`, migrator);
    },
    migrate(value, to) {
      object(value, "$");
      string(value.schemaVersion, "$.schemaVersion");
      if (value.schemaVersion === to) return value;
      const migrator = migrators.get(`${value.schemaVersion}->${to}`);
      if (!migrator) throw new ContractMigrationError(`no migration ${value.schemaVersion}->${to}`);
      return migrator.migrate(value);
    },
  };
}

export function migrateContract(value, to, registry = defaultMigrationRegistry) {
  return registry.migrate(value, to);
}

export const validators = Object.freeze({
  StudySpec: validateStudySpec,
  SessionRecord: validateSessionRecord,
  Observation: validateObservation,
  InteractionEvent: validateInteractionEvent,
  ModelAttempt: validateModelAttempt,
  EvidenceManifest: validateEvidenceManifest,
  FunctionalEvaluation: validateFunctionalEvaluation,
  BehavioralFingerprint: validateBehavioralFingerprint,
  FrictionPoint: validateFrictionPoint,
  Finding: validateFinding,
  SimulationValidityReport: validateSimulationValidityReport,
  VariantComparisonSpec: validateVariantComparisonSpec,
  VariantComparisonReport: validateVariantComparisonReport,
});

const categories = ["functional", "behavioral", "visual", "business", "accessibility", "performance", "security"];
const severities = ["critical", "high", "medium", "low"];

function validateEnvironment(value, path) {
  object(value, path, ["baseUrl", "startPath", "allowedOrigins", "blockedOrigins", "viewport", "locale", "timezoneId", "auth", "storageStatePath", "fixtures", "network", "reset"]);
  string(value.baseUrl, `${path}.baseUrl`);
  optional(value.startPath, string, `${path}.startPath`);
  nonEmptyArray(value.allowedOrigins, `${path}.allowedOrigins`).forEach((origin, index) => string(origin, `${path}.allowedOrigins[${index}]`));
  optional(value.blockedOrigins, arrayOf(string), `${path}.blockedOrigins`);
  validateViewport(value.viewport, `${path}.viewport`);
  optional(value.locale, string, `${path}.locale`);
  optional(value.timezoneId, string, `${path}.timezoneId`);
  if (value.auth !== undefined) optionalRecord(value.auth, `${path}.auth`);
  optional(value.storageStatePath, string, `${path}.storageStatePath`);
  optionalStringRecord(value.fixtures, `${path}.fixtures`);
  if (value.network !== undefined) {
    object(value.network, `${path}.network`, ["offline", "latencyMs", "downloadKbps", "uploadKbps"]);
    optional(value.network.offline, boolean, `${path}.network.offline`);
    ["latencyMs", "downloadKbps", "uploadKbps"].forEach((key) => optional(value.network[key], integer, `${path}.network.${key}`));
  }
  if (value.reset !== undefined) {
    object(value.reset, `${path}.reset`, ["beforeSessionCommand", "afterSessionCommand"]);
    optional(value.reset.beforeSessionCommand, string, `${path}.reset.beforeSessionCommand`);
    optional(value.reset.afterSessionCommand, string, `${path}.reset.afterSessionCommand`);
  }
}

function validateTask(value, path) {
  object(value, path, ["id", "name", "goal", "context", "startPath", "startingState", "successOracles", "failureOracles", "businessOracles", "safetyPolicy", "maxActions", "maxDurationMs", "maxConsecutiveNoProgressActions", "abandonmentAllowed", "humanValidation"]);
  ["id", "name", "goal"].forEach((key) => string(value[key], `${path}.${key}`));
  optional(value.context, string, `${path}.context`);
  optional(value.startPath, string, `${path}.startPath`);
  optionalRecord(value.startingState, `${path}.startingState`);
  nonEmptyArray(value.successOracles, `${path}.successOracles`).forEach((oracle, index) => validateOracle(oracle, `${path}.successOracles[${index}]`));
  optional(value.failureOracles, arrayOf(validateOracle), `${path}.failureOracles`);
  optional(value.businessOracles, arrayOf(validateOracle), `${path}.businessOracles`);
  validateActionSafetyPolicy(value.safetyPolicy, `${path}.safetyPolicy`);
  ["maxActions", "maxDurationMs", "maxConsecutiveNoProgressActions"].forEach((key) => positiveInteger(value[key], `${path}.${key}`));
  boolean(value.abandonmentAllowed, `${path}.abandonmentAllowed`);
  optional(value.humanValidation, validateHumanValidation, `${path}.humanValidation`);
}

function validateOracle(value, path) {
  object(value, path, ["id", "type", "operation", "value", "role", "name", "state", "method", "urlPattern", "status", "properties", "filenamePattern", "mimeType", "evaluatorId", "input"]);
  string(value.id, `${path}.id`);
  oneOf(value.type, ["url", "visible_text", "element", "network", "event", "download", "custom"], `${path}.type`);
  if (value.type === "url") {
    oneOf(value.operation, ["equals", "contains", "matches"], `${path}.operation`);
    string(value.value, `${path}.value`);
  } else if (value.type === "visible_text") {
    oneOf(value.operation, ["contains", "not_contains", "matches"], `${path}.operation`);
    string(value.value, `${path}.value`);
  } else if (value.type === "element") {
    optional(value.role, string, `${path}.role`);
    optional(value.name, string, `${path}.name`);
    oneOf(value.state, ["visible", "hidden", "enabled", "disabled", "checked"], `${path}.state`);
  } else if (value.type === "network") {
    optional(value.method, string, `${path}.method`);
    string(value.urlPattern, `${path}.urlPattern`);
    optional(value.status, integer, `${path}.status`);
  } else if (value.type === "event") {
    string(value.name, `${path}.name`);
    optionalRecord(value.properties, `${path}.properties`);
  } else if (value.type === "download") {
    optional(value.filenamePattern, string, `${path}.filenamePattern`);
    optional(value.mimeType, string, `${path}.mimeType`);
  } else {
    string(value.evaluatorId, `${path}.evaluatorId`);
    if (!/^[a-z][a-z0-9_.:-]*$/i.test(value.evaluatorId)) throw new ContractValidationError("must be registry id, not a code path", `${path}.evaluatorId`);
    optionalRecord(value.input, `${path}.input`);
  }
}

function validateActionSafetyPolicy(value, path) {
  object(value, path, ["allowRead", "allowNavigation", "allowClick", "allowTyping", "allowFileUpload", "allowStateMutation", "allowExternalOrigin", "forbiddenActions", "stopBeforeConfirmation"]);
  ["allowRead", "allowNavigation", "allowClick", "allowTyping", "allowFileUpload", "allowStateMutation", "allowExternalOrigin", "stopBeforeConfirmation"].forEach((key) => boolean(value[key], `${path}.${key}`));
  arrayOf((action, actionPath) => oneOf(action, ["payment", "subscription_change", "account_delete", "data_delete", "send_message", "confirm_destructive"], actionPath))(value.forbiddenActions, `${path}.forbiddenActions`);
}

function validatePersona(value, path) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "preset")) {
    object(value, path, ["preset", "id", "name"]);
    string(value.preset, `${path}.preset`);
    optional(value.id, string, `${path}.id`);
    optional(value.name, string, `${path}.name`);
    return;
  }
  object(value, path, ["id", "name", "description", "source", "narrative", "policy", "attention", "abandonmentRules", "grounding"]);
  ["id", "name", "description"].forEach((key) => string(value[key], `${path}.${key}`));
  object(value.source, `${path}.source`, ["type", "presetId", "datasetId", "clusterId", "sampleSize"]);
  oneOf(value.source.type, ["preset", "manual", "observed_cluster"], `${path}.source.type`);
  object(value.narrative, `${path}.narrative`);
  object(value.policy, `${path}.policy`);
  object(value.attention, `${path}.attention`);
  array(value.abandonmentRules, `${path}.abandonmentRules`);
  object(value.grounding, `${path}.grounding`);
}

function validateRuntimeConfig(value, path) {
  object(value, path, ["seeds", "concurrency", "modelRoles", "budgets"]);
  nonEmptyArray(value.seeds, `${path}.seeds`).forEach((seed, index) => integer(seed, `${path}.seeds[${index}]`));
  positiveInteger(value.concurrency, `${path}.concurrency`);
  object(value.modelRoles, `${path}.modelRoles`, ["action", "evaluator", "cluster"]);
  string(value.modelRoles.action, `${path}.modelRoles.action`);
  string(value.modelRoles.evaluator, `${path}.modelRoles.evaluator`);
  optional(value.modelRoles.cluster, string, `${path}.modelRoles.cluster`);
  optionalRecord(value.budgets, `${path}.budgets`);
}

function validateEvidencePolicy(value, path) {
  object(value, path, ["screenshot", "trace", "video", "semanticSnapshot"]);
  oneOf(value.screenshot, ["off", "on_failure", "every_action"], `${path}.screenshot`);
  boolean(value.trace, `${path}.trace`);
  oneOf(value.video, ["off", "on_failure", "all"], `${path}.video`);
  oneOf(value.semanticSnapshot, ["off", "on_failure", "every_action"], `${path}.semanticSnapshot`);
}

function validateEvaluationPolicy(value, path) {
  object(value, path, ["minimumRecurrenceForFinding", "validityReport"]);
  positiveInteger(value.minimumRecurrenceForFinding, `${path}.minimumRecurrenceForFinding`);
  boolean(value.validityReport, `${path}.validityReport`);
}

export function validateBrowserAction(value, path = "$") {
  object(value, path, ["type", "elementId", "valueRef", "value", "direction", "amount", "durationMs", "reasonCode"]);
  oneOf(value.type, ["click", "type", "select", "scroll", "back", "wait", "observe_more", "ignore", "idle", "finish", "abandon"], `${path}.type`);
  string(value.reasonCode, `${path}.reasonCode`);
  if (["click", "ignore"].includes(value.type)) optional(value.elementId, string, `${path}.elementId`);
  if (value.type === "click") string(value.elementId, `${path}.elementId`);
  if (value.type === "type") {
    string(value.elementId, `${path}.elementId`);
    string(value.valueRef, `${path}.valueRef`);
    if (value.value !== undefined) throw new ContractValidationError("use valueRef for typed input", `${path}.value`);
  }
  if (value.type === "select") {
    string(value.elementId, `${path}.elementId`);
    string(value.value, `${path}.value`);
  }
  if (value.type === "scroll") {
    oneOf(value.direction, ["up", "down"], `${path}.direction`);
    oneOf(value.amount, ["small", "medium", "large"], `${path}.amount`);
  }
  if (["wait", "idle"].includes(value.type)) positiveInteger(value.durationMs, `${path}.durationMs`);
  return deepFreeze(value);
}

function validateSemanticNode(value, path) {
  object(value, path, ["id", "role", "name", "text", "level", "fingerprint", "viewportPosition", "boundingBox"]);
  optional(value.id, string, `${path}.id`);
  optional(value.role, string, `${path}.role`);
  optional(value.name, string, `${path}.name`);
  optional(value.text, string, `${path}.text`);
  optional(value.level, integer, `${path}.level`);
  optional(value.fingerprint, string, `${path}.fingerprint`);
  optionalRecord(value.viewportPosition, `${path}.viewportPosition`);
  optionalRecord(value.boundingBox, `${path}.boundingBox`);
}

function validateInteractiveElement(value, path) {
  object(value, path, ["id", "role", "name", "text", "checked", "enabled", "focused", "visible", "viewportPosition", "boundingBox", "fingerprint"]);
  ["id", "fingerprint"].forEach((key) => string(value[key], `${path}.${key}`));
  optional(value.role, string, `${path}.role`);
  optional(value.name, string, `${path}.name`);
  optional(value.text, string, `${path}.text`);
  optional(value.checked, boolean, `${path}.checked`);
  ["enabled", "focused", "visible"].forEach((key) => optional(value[key], boolean, `${path}.${key}`));
  optionalRecord(value.viewportPosition, `${path}.viewportPosition`);
  optionalRecord(value.boundingBox, `${path}.boundingBox`);
}

function validateRuntimeIssue(value, path) {
  object(value, path, ["id", "type", "severity", "message", "url", "timestamp", "method", "status", "filename", "mimeType"]);
  string(value.id, `${path}.id`);
  oneOf(value.type, ["console", "pageerror", "network", "download", "popup", "dialog", "navigation", "loading"], `${path}.type`);
  optional(value.severity, string, `${path}.severity`);
  string(value.message, `${path}.message`);
  optional(value.url, string, `${path}.url`);
  optional(value.timestamp, string, `${path}.timestamp`);
  optional(value.method, string, `${path}.method`);
  optional(value.status, integer, `${path}.status`);
  optional(value.filename, string, `${path}.filename`);
  optional(value.mimeType, string, `${path}.mimeType`);
}

function validateOracleSignals(value, path) {
  object(value, path, ["satisfied", "violated", "unknown"]);
  ["satisfied", "violated", "unknown"].forEach((key) => arrayOf(string)(value[key], `${path}.${key}`));
}

function validateEvidenceEntry(value, path) {
  object(value, path, ["id", "type", "relativePath", "contentHash", "byteSize", "metadata"]);
  string(value.id, `${path}.id`);
  oneOf(value.type, ["screenshot", "semantic_snapshot", "trace", "video", "console_issue", "network_failure", "download", "oracle_result", "action_result", "model_attempt"], `${path}.type`);
  optional(value.relativePath, string, `${path}.relativePath`);
  if (value.relativePath !== undefined && (value.relativePath.startsWith("/") || value.relativePath.includes("\\") || value.relativePath.split("/").includes(".."))) {
    throw new ContractValidationError("must be a contained relative path", `${path}.relativePath`);
  }
  string(value.contentHash, `${path}.contentHash`);
  optional(value.byteSize, integer, `${path}.byteSize`);
  optionalRecord(value.metadata, `${path}.metadata`);
}

function validateFindingConfidence(value, path) {
  object(value, path, ["evidenceConfidence", "recurrenceConfidence", "seedStability", "modelAgreement", "calibrationConfidence", "orderConsistency", "overall", "limitations"]);
  ratio(value.evidenceConfidence, `${path}.evidenceConfidence`);
  ratio(value.recurrenceConfidence, `${path}.recurrenceConfidence`);
  ["seedStability", "modelAgreement", "calibrationConfidence", "orderConsistency"].forEach((key) => numberOrUnavailable(value[key], `${path}.${key}`));
  oneOf(value.overall, ["low", "medium", "high"], `${path}.overall`);
  arrayOf(string)(value.limitations, `${path}.limitations`);
}

function validateHumanValidation(value, path) {
  object(value, path, ["required", "level", "reason", "sensitive"]);
  optional(value.required, boolean, `${path}.required`);
  optional(value.level, (level, levelPath) => oneOf(level, ["none", "recommended", "required"], levelPath), `${path}.level`);
  optional(value.reason, string, `${path}.reason`);
  optional(value.sensitive, boolean, `${path}.sensitive`);
}

function validatePopulationDiversity(value, path) {
  object(value, path, ["sessionCount", "personaCount", "intraPersonaDistance", "interPersonaDistance", "personaSeparability", "routeEntropy", "actionEntropy", "clusterCoverage", "homogenizationRisk", "warnings"]);
  ["sessionCount", "personaCount"].forEach((key) => integer(value[key], `${path}.${key}`));
  ["intraPersonaDistance", "interPersonaDistance", "personaSeparability"].forEach((key) => numberOrUnavailable(value[key], `${path}.${key}`));
  ["routeEntropy", "actionEntropy", "clusterCoverage"].forEach((key) => number(value[key], `${path}.${key}`));
  oneOf(value.homogenizationRisk, ["low", "medium", "high", "unknown"], `${path}.homogenizationRisk`);
  arrayOf(string)(value.warnings, `${path}.warnings`);
}

function validateVariantRef(value, path) {
  object(value, path, ["id", "baseUrl", "revision"]);
  string(value.id, `${path}.id`);
  string(value.baseUrl, `${path}.baseUrl`);
  optional(value.revision, string, `${path}.revision`);
}

function validateVariantMetrics(value, path) {
  object(value, path, ["completionRate", "partialRate", "failureRate", "abandonmentRate", "medianActionCount", "medianBacktrackCount", "medianFailedInteractionCount", "routeEntropy", "recurringFindingCount"]);
  ["completionRate", "partialRate", "failureRate", "abandonmentRate"].forEach((key) => ratio(value[key], `${path}.${key}`));
  ["medianActionCount", "medianBacktrackCount", "medianFailedInteractionCount", "routeEntropy"].forEach((key) => number(value[key], `${path}.${key}`));
  integer(value.recurringFindingCount, `${path}.recurringFindingCount`);
}

function version(value, expected, path) {
  object(value, path);
  if (value.schemaVersion !== expected) throw new ContractValidationError(`expected schemaVersion ${expected}`, `${path}.schemaVersion`);
}

function optionalVersion(value, expected, path) {
  if (value.schemaVersion !== undefined) version(value, expected, path);
}

function object(value, path, allowedKeys, partial = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractValidationError("must be an object", path);
  if (allowedKeys) {
    for (const key of Object.keys(value)) {
      if (!allowedKeys.includes(key)) throw new ContractValidationError("unknown field", `${path}.${key}`);
    }
    if (!partial) {
      for (const key of allowedKeys) {
        if (value[key] === undefined && key !== "schemaVersion") continue;
      }
    }
  }
  return value;
}

function optional(value, validator, path) {
  if (value !== undefined) validator(value, path);
}

function string(value, path) {
  if (typeof value !== "string" || value.length === 0) throw new ContractValidationError("must be a non-empty string", path);
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw new ContractValidationError("must be a boolean", path);
}

function number(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ContractValidationError("must be a finite number", path);
}

function integer(value, path) {
  if (!Number.isInteger(value)) throw new ContractValidationError("must be an integer", path);
}

function positiveInteger(value, path) {
  integer(value, path);
  if (value <= 0) throw new ContractValidationError("must be positive", path);
}

function ratio(value, path) {
  number(value, path);
  if (value < 0 || value > 1) throw new ContractValidationError("must be between 0 and 1", path);
}

function numberOrUnavailable(value, path) {
  if (value === "not_available") return;
  number(value, path);
}

function array(value, path) {
  if (!Array.isArray(value)) throw new ContractValidationError("must be an array", path);
  return value;
}

function nonEmptyArray(value, path) {
  array(value, path);
  if (value.length === 0) throw new ContractValidationError("must not be empty", path);
  return value;
}

function uniqueIdentities(values, identity, path, label) {
  const seen = new Set();
  values.forEach((value, index) => {
    const id = identity(value);
    if (seen.has(id)) throw new ContractValidationError(`${label} must be unique`, `${path}[${index}]`);
    seen.add(id);
  });
}

function arrayOf(validator) {
  return (value, path) => {
    array(value, path).forEach((item, index) => validator(item, `${path}[${index}]`));
  };
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) throw new ContractValidationError(`must be one of ${allowed.join(", ")}`, path);
}

function optionalRecord(value, path) {
  if (value === undefined) return;
  object(value, path);
}

function optionalStringRecord(value, path) {
  if (value === undefined) return;
  object(value, path);
  for (const [key, recordValue] of Object.entries(value)) string(recordValue, `${path}.${key}`);
}

function numberRecord(value, path) {
  object(value, path);
  for (const [key, recordValue] of Object.entries(value)) number(recordValue, `${path}.${key}`);
}

function validateViewport(value, path) {
  object(value, path, ["width", "height", "deviceScaleFactor", "isMobile"]);
  positiveInteger(value.width, `${path}.width`);
  positiveInteger(value.height, `${path}.height`);
  optional(value.deviceScaleFactor, number, `${path}.deviceScaleFactor`);
  optional(value.isMobile, boolean, `${path}.isMobile`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
