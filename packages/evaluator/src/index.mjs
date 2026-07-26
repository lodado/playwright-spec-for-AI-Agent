import {
  FUNCTIONAL_EVALUATION_VERSION,
  ContractValidationError,
  validateEvidenceManifest,
  validateFunctionalEvaluation,
  validateSessionRecord,
} from "@persona-runtime/contracts";

export const EVALUATOR_ERROR_CODES = Object.freeze({
  EVIDENCE_NOT_SEALED: "EVIDENCE_NOT_SEALED",
  EVIDENCE_LINK_INVALID: "EVIDENCE_LINK_INVALID",
  CUSTOM_EVALUATOR_NOT_ALLOWED: "CUSTOM_EVALUATOR_NOT_ALLOWED",
  ORACLE_INVALID: "ORACLE_INVALID",
});

export class EvaluatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvaluatorError";
    this.code = code;
  }
}

export async function evaluateFunctionalSession({
  task,
  session,
  observations = [],
  events = [],
  manifest,
  customEvaluators = {},
} = {}) {
  if (!task || typeof task !== "object") throw new EvaluatorError(EVALUATOR_ERROR_CODES.ORACLE_INVALID, "task is required");
  const sealedManifest = requireSealedManifest(manifest);
  const sealedSession = validateSessionRecord(session);
  assertEvidenceLinks({ session: sealedSession, observations, events, manifest: sealedManifest });

  const context = buildEvaluationContext({ observations, events, manifest: sealedManifest });
  const successResults = await evaluateOracles(task.successOracles ?? [], context, customEvaluators);
  const failureResults = await evaluateOracles(task.failureOracles ?? [], context, customEvaluators);
  const allResults = [...successResults, ...failureResults];

  const satisfiedOracleIds = allResults.filter((result) => result.state === "satisfied").map((result) => result.id);
  const violatedOracleIds = allResults.filter((result) => result.state === "violated").map((result) => result.id);
  const unknownOracleIds = allResults.filter((result) => result.state === "unknown").map((result) => result.id);
  const evidenceIds = unique(allResults.flatMap((result) => result.evidenceIds));
  const reasons = [];

  let status;
  const satisfiedFailure = failureResults.find((result) => result.state === "satisfied");
  if (satisfiedFailure) {
    status = "failure";
    reasons.push(`failure oracle satisfied: ${satisfiedFailure.id}`);
  } else if ((task.successOracles ?? []).length > 0 && successResults.every((result) => result.state === "satisfied")) {
    status = "success";
    reasons.push("all success oracles satisfied");
  } else if (sealedSession.status === "runtime_error") {
    status = "runtime_error";
    reasons.push("session ended with runtime_error");
  } else if (successResults.some((result) => result.state === "satisfied")) {
    status = "partial";
    reasons.push("some success oracles satisfied");
  } else if (unknownOracleIds.length > 0 || (task.successOracles ?? []).length === 0) {
    status = "manual_review";
    reasons.push("one or more oracles require manual review");
  } else {
    status = "failure";
    reasons.push("success oracles were not satisfied");
  }

  return validateFunctionalEvaluation({
    schemaVersion: FUNCTIONAL_EVALUATION_VERSION,
    status,
    satisfiedOracleIds,
    violatedOracleIds,
    unknownOracleIds,
    evidenceIds,
    reasons,
  });
}

export async function evaluateOracle(oracle, context, customEvaluators = {}) {
  if (!oracle || typeof oracle !== "object" || typeof oracle.id !== "string") {
    throw new EvaluatorError(EVALUATOR_ERROR_CODES.ORACLE_INVALID, "oracle.id is required");
  }

  switch (oracle.type) {
    case "url":
      return statefulResult(oracle, matchText(context.latestObservation?.page?.url ?? "", oracle.operation, oracle.value), context.latestEvidenceIds);
    case "visible_text":
      return statefulResult(oracle, matchVisibleText(context.visibleText, oracle), context.latestEvidenceIds);
    case "element":
      return evaluateElementOracle(oracle, context);
    case "network":
      return evaluateMetadataOracle(oracle, context.networkRecords, (record) => matchNetwork(record, oracle));
    case "event":
      return evaluateMetadataOracle(oracle, context.eventRecords, (record) => matchEvent(record, oracle));
    case "download":
      return evaluateMetadataOracle(oracle, context.downloadRecords, (record) => matchDownload(record, oracle));
    case "custom":
      return evaluateCustomOracle(oracle, context, customEvaluators);
    default:
      return { id: oracle.id, state: "unknown", evidenceIds: [], reason: `unsupported oracle type: ${oracle.type}` };
  }
}

function requireSealedManifest(manifest) {
  try {
    return validateEvidenceManifest(manifest);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new EvaluatorError(EVALUATOR_ERROR_CODES.EVIDENCE_NOT_SEALED, "functional evaluation requires sealed evidence");
    }
    throw error;
  }
}

function assertEvidenceLinks({ session, observations, events, manifest }) {
  if (manifest.sessionId !== session.sessionId || manifest.runId !== session.runId) {
    throw new EvaluatorError(EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID, "manifest does not belong to the session");
  }
  if (session.evidenceManifestId && session.evidenceManifestId !== manifest.id) {
    throw new EvaluatorError(EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID, "session references a different evidence manifest");
  }

  const observationIds = new Set();
  for (const observation of observations) {
    if (observation.sessionId !== session.sessionId) throw new EvaluatorError(EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID, "observation belongs to a different session");
    observationIds.add(observation.id);
  }

  const manifestEvidenceIds = new Set(manifest.entries.map((entry) => entry.id));
  const eventIds = new Set(events.map((event) => event.id));
  for (const id of session.eventIds) {
    if (!eventIds.has(id)) throw new EvaluatorError(EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID, `session event is missing: ${id}`);
  }

  for (const event of events) {
    if (event.sessionId !== session.sessionId) throw new EvaluatorError(EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID, "event belongs to a different session");
    if (!observationIds.has(event.observationId)) throw new EvaluatorError(EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID, `event observation is missing: ${event.observationId}`);
    for (const evidenceId of event.evidenceIds ?? []) {
      if (!manifestEvidenceIds.has(evidenceId)) throw new EvaluatorError(EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID, `event evidence is missing: ${evidenceId}`);
    }
  }
}

async function evaluateOracles(oracles, context, customEvaluators) {
  const results = [];
  for (const oracle of oracles) results.push(await evaluateOracle(oracle, context, customEvaluators));
  return results;
}

function buildEvaluationContext({ observations, events, manifest }) {
  const sortedObservations = [...observations].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const latestObservation = sortedObservations.at(-1);
  const entriesByObservation = new Map();
  const networkRecords = [];
  const eventRecords = [];
  const downloadRecords = [];

  for (const entry of manifest.entries) {
    const record = { ...entry.metadata, evidenceId: entry.id, type: entry.type };
    if (entry.metadata?.observationId) addMapList(entriesByObservation, entry.metadata.observationId, entry.id);
    if (entry.type === "network_failure" || entry.metadata?.network === true) networkRecords.push(record);
    if (entry.type === "download") downloadRecords.push(record);
    if (entry.type === "action_result" || entry.metadata?.eventName || entry.metadata?.name) eventRecords.push(record);
  }
  for (const observation of sortedObservations) {
    for (const issue of observation.runtime?.networkFailures ?? []) networkRecords.push({ ...issue, evidenceId: issue.evidenceId });
  }
  for (const event of events) {
    eventRecords.push({ ...event, evidenceId: event.evidenceIds?.[0] });
  }

  return Object.freeze({
    observations: sortedObservations,
    events,
    manifest,
    latestObservation,
    latestEvidenceIds: latestObservation ? entriesByObservation.get(latestObservation.id) ?? [latestObservation.visual?.screenshotEvidenceId].filter(Boolean) : [],
    visibleText: collectVisibleText(latestObservation),
    elements: collectElements(latestObservation),
    networkRecords,
    eventRecords,
    downloadRecords,
  });
}

function evaluateElementOracle(oracle, context) {
  const matches = context.elements.filter((element) => elementMatches(element, oracle));
  if (oracle.state === "hidden") {
    return statefulResult(oracle, !matches.some((element) => element.visible !== false), evidenceForElements(matches, context));
  }
  if (oracle.state === "checked" && (matches.length === 0 || matches.some((element) => element.checked === undefined))) {
    return { id: oracle.id, state: "unknown", evidenceIds: evidenceForElements(matches, context), reason: "checked state was not captured" };
  }
  const satisfied = matches.some((element) => {
    if (oracle.state === "visible") return element.visible !== false;
    if (oracle.state === "enabled") return element.enabled !== false;
    if (oracle.state === "disabled") return element.enabled === false;
    if (oracle.state === "checked") return element.checked === true;
    return false;
  });
  return statefulResult(oracle, satisfied, evidenceForElements(matches, context));
}

function evaluateMetadataOracle(oracle, records, matcher) {
  const matches = records.filter(matcher);
  return statefulResult(oracle, matches.length > 0, unique(matches.map((record) => record.evidenceId).filter(Boolean)));
}

async function evaluateCustomOracle(oracle, context, customEvaluators) {
  const evaluator = customEvaluators[oracle.evaluatorId];
  if (typeof evaluator !== "function") {
    throw new EvaluatorError(EVALUATOR_ERROR_CODES.CUSTOM_EVALUATOR_NOT_ALLOWED, `custom evaluator is not allowlisted: ${oracle.evaluatorId}`);
  }
  const result = await evaluator({ oracle, context });
  if (!["satisfied", "violated", "unknown"].includes(result?.state)) {
    throw new EvaluatorError(EVALUATOR_ERROR_CODES.ORACLE_INVALID, "custom evaluator must return state");
  }
  return {
    id: oracle.id,
    state: result.state,
    evidenceIds: unique(result.evidenceIds ?? []),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function statefulResult(oracle, satisfied, evidenceIds) {
  return {
    id: oracle.id,
    state: satisfied ? "satisfied" : "violated",
    evidenceIds: unique(evidenceIds),
  };
}

function matchVisibleText(visibleText, oracle) {
  const haystack = visibleText.join("\n");
  const matched = matchText(haystack, oracle.operation, oracle.value);
  return oracle.operation === "not_contains" ? matched : matched;
}

function matchText(actual, operation, expected) {
  if (operation === "equals") return actual === expected;
  if (operation === "contains") return actual.includes(expected);
  if (operation === "not_contains") return !actual.includes(expected);
  if (operation === "matches") return new RegExp(expected).test(actual);
  return false;
}

function elementMatches(element, oracle) {
  if (oracle.role && element.role !== oracle.role) return false;
  if (oracle.name && element.name !== oracle.name && element.text !== oracle.name) return false;
  return true;
}

function matchNetwork(record, oracle) {
  if (oracle.method && String(record.method ?? "").toUpperCase() !== oracle.method.toUpperCase()) return false;
  if (!new RegExp(oracle.urlPattern).test(String(record.url ?? record.requestUrl ?? ""))) return false;
  if (oracle.status !== undefined && Number(record.status) !== oracle.status) return false;
  return true;
}

function matchEvent(record, oracle) {
  const name = record.name ?? record.eventName ?? record.action?.type;
  if (name !== oracle.name) return false;
  for (const [key, value] of Object.entries(oracle.properties ?? {})) {
    const properties = record.properties ?? record.metadata ?? record;
    if (properties[key] !== value) return false;
  }
  return true;
}

function matchDownload(record, oracle) {
  if (oracle.filenamePattern && !new RegExp(oracle.filenamePattern).test(String(record.filename ?? record.fileName ?? ""))) return false;
  if (oracle.mimeType && String(record.mimeType ?? "") !== oracle.mimeType) return false;
  return true;
}

function collectVisibleText(observation) {
  if (!observation) return [];
  const semantic = observation.semantic ?? {};
  return unique([
    ...(semantic.visibleText ?? []),
    ...(semantic.headings ?? []).flatMap(textParts),
    ...(semantic.landmarks ?? []).flatMap(textParts),
    ...(semantic.interactiveElements ?? []).filter((element) => element.visible !== false).flatMap(textParts),
  ].filter(Boolean));
}

function collectElements(observation) {
  if (!observation) return [];
  const semantic = observation.semantic ?? {};
  return [
    ...(semantic.interactiveElements ?? []),
    ...(semantic.headings ?? []).map((item) => ({ ...item, visible: true })),
    ...(semantic.landmarks ?? []).map((item) => ({ ...item, visible: true })),
  ];
}

function evidenceForElements(matches, context) {
  const ids = [...context.latestEvidenceIds];
  for (const match of matches) {
    if (match.evidenceId) ids.push(match.evidenceId);
  }
  return unique(ids);
}

function textParts(value) {
  return [value.name, value.text].filter(Boolean);
}

function addMapList(map, key, value) {
  const items = map.get(key) ?? [];
  items.push(value);
  map.set(key, items);
}

function unique(items) {
  return [...new Set(items)];
}
