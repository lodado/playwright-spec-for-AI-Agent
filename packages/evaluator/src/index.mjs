import {
  FINDING_VERSION,
  FRICTION_POINT_VERSION,
  FUNCTIONAL_EVALUATION_VERSION,
  SIMULATION_VALIDITY_VERSION,
  ContractValidationError,
  validateBehavioralFingerprint,
  validateEvidenceManifest,
  validateFinding,
  validateFrictionPoint,
  validateFunctionalEvaluation,
  validateSessionRecord,
  validateSimulationValidityReport,
  stableId,
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


export function createBehavioralFingerprint({ session, events = [], observations = [] } = {}) {
  const eventCount = events.length;
  const actionTypes = events.map((event) => event.action?.type).filter(Boolean);
  const actionTypeCounts = countBy(actionTypes);
  const routeSequence = events.length > 0
    ? events.map((event) => routeKey(event.urlAfter ?? event.urlBefore)).filter(Boolean)
    : observations.map((observation) => routeKey(observation.page?.url)).filter(Boolean);
  const terminal = session?.terminalReason ?? {};
  const backtrackCount = events.filter((event) => event.derivedSignals?.backtrack || event.action?.type === "back").length;
  const failedCount = events.filter((event) => event.derivedSignals?.failedInteraction || ["failure", "blocked"].includes(event.result?.status)).length;
  const retryCount = events.filter((event, index) => index > 0 && sameActionTarget(event, events[index - 1])).length;
  const noActionCount = events.filter((event) => ["wait", "observe_more", "ignore", "idle"].includes(event.action?.type)).length;
  const firstAction = events[0]?.action;
  const fingerprint = {
    schemaVersion: "behavioral-fingerprint/0.1",
    sessionId: session?.sessionId ?? "unknown-session",
    actionCount: eventCount,
    actionTypeRates: rates(actionTypeCounts, Math.max(eventCount, 1)),
    uniqueActionTypeCount: Object.keys(actionTypeCounts).length,
    routeSequence,
    routeEntropy: entropy(routeSequence),
    ...(firstAction?.type ? { firstActionType: firstAction.type } : {}),
    ...(firstAction?.elementId ? { firstActionTargetFingerprint: firstAction.elementId } : {}),
    backtrackRate: ratio(backtrackCount, eventCount),
    retryRate: ratio(retryCount, eventCount),
    failedInteractionRate: ratio(failedCount, eventCount),
    noActionRate: ratio(noActionCount, eventCount),
    abandonmentOccurred: session?.status === "abandoned",
    ...(session?.status === "abandoned" && routeSequence.at(-1) ? { abandonmentRoute: routeSequence.at(-1) } : {}),
    ...(session?.status === "abandoned" && terminal.code ? { abandonmentReasonCode: terminal.code } : {}),
    errorReactionVector: {
      retry: ratio(retryCount, Math.max(failedCount, 1)),
      backtrack: ratio(backtrackCount, Math.max(failedCount, 1)),
      ignore: ratio(events.filter((event) => event.action?.type === "ignore").length, Math.max(failedCount, 1)),
      abandon: session?.status === "abandoned" && failedCount > 0 ? 1 : 0,
    },
    progressCurve: events.map((event, index) => event.derivedSignals?.progressChanged ? ratio(index + 1, eventCount) : 0),
    frustrationCurve: events.map((event, index) => ratio(events.slice(0, index + 1).filter((item) => item.derivedSignals?.noProgress || item.derivedSignals?.failedInteraction).length, eventCount)),
    trustCurve: events.map((event, index) => 1 - ratio(events.slice(0, index + 1).filter((item) => item.derivedSignals?.failedInteraction).length, eventCount)),
    goalDirectednessScore: clamp01(ratio(events.filter((event) => event.derivedSignals?.progressChanged).length, Math.max(eventCount, 1)) - ratio(backtrackCount + noActionCount, Math.max(eventCount * 2, 1)) + 0.5),
  };
  return validateBehavioralFingerprint(fingerprint);
}

export function evaluateSimulationValidity({ sessions = [], fingerprints = [], taskMaxActions, humanReference } = {}) {
  const normalizedFingerprints = fingerprints.length > 0
    ? fingerprints
    : sessions.map((item) => createBehavioralFingerprint({ session: item.session ?? item, events: item.events ?? [], observations: item.observations ?? [] }));
  const sessionRecords = sessions.map((item) => item.session ?? item);
  const personaIds = unique(sessionRecords.map((session) => session.personaId).filter(Boolean));
  const diversity = populationDiversity(normalizedFingerprints, sessionRecords);
  const detectedRisks = [];
  if (normalizedFingerprints.length < 3) detectedRisks.push("insufficient_sample");
  if (diversity.homogenizationRisk === "high") detectedRisks.push("persona_homogenization");
  if (isHyperactive(normalizedFingerprints, taskMaxActions)) detectedRisks.push("hyperactivity");
  if (normalizedFingerprints.length > 0 && normalizedFingerprints.every((item) => item.noActionRate === 0 && !item.abandonmentOccurred)) detectedRisks.push("excessive_cooperation");
  if (normalizedFingerprints.length > 0 && normalizedFingerprints.every((item) => item.trustCurve.every((value) => value > 0.8))) detectedRisks.push("positivity_bias");

  const report = {
    schemaVersion: SIMULATION_VALIDITY_VERSION,
    calibration: humanReference
      ? { level: "calibrated", datasetId: humanReference.id, sampleSize: humanReference.sampleSize }
      : { level: "uncalibrated", reason: "No human reference dataset was provided." },
    stability: {
      seedVariance: variance(normalizedFingerprints.map((item) => item.actionCount)),
      modelAgreement: "not_available",
      orderConsistency: "not_available",
    },
    diversity: { ...diversity, personaCount: personaIds.length },
    detectedRisks: unique(detectedRisks),
    recommendedUse: recommendedUseForRisks(detectedRisks, humanReference),
    forbiddenInterpretations: humanReference ? [] : [
      "Do not describe synthetic sessions as actual user conversion rates.",
      "Do not claim demographic behavior without human validation.",
      "Do not use uncalibrated results as a sole blocking decision for high-severity behavioral risk.",
    ],
  };
  return validateSimulationValidityReport(report);
}

function populationDiversity(fingerprints, sessions) {
  const pairDistances = [];
  const intra = [];
  const inter = [];
  for (let i = 0; i < fingerprints.length; i += 1) {
    for (let j = i + 1; j < fingerprints.length; j += 1) {
      const distance = fingerprintDistance(fingerprints[i], fingerprints[j]);
      pairDistances.push(distance);
      if (sessions[i]?.personaId && sessions[i]?.personaId === sessions[j]?.personaId) intra.push(distance);
      else inter.push(distance);
    }
  }
  const routes = fingerprints.map((item) => item.routeSequence.join(" > "));
  const actions = fingerprints.flatMap((item) => Object.entries(item.actionTypeRates).flatMap(([action, rate]) => rate > 0 ? [action] : []));
  const interDistance = inter.length ? average(inter) : "not_available";
  const intraDistance = intra.length ? average(intra) : "not_available";
  const separability = typeof interDistance === "number" && typeof intraDistance === "number" ? Math.max(0, interDistance - intraDistance) : "not_available";
  const routeDiversity = entropy(routes);
  const actionDiversity = entropy(actions);
  const clusterCoverage = ratio(new Set(routes).size, Math.max(fingerprints.length, 1));
  const homogenizationRisk = fingerprints.length < 2 ? "unknown" : (clusterCoverage <= 0.34 || average(pairDistances) < 0.15 ? "high" : (clusterCoverage < 0.67 ? "medium" : "low"));
  return {
    sessionCount: fingerprints.length,
    personaCount: unique(sessions.map((session) => session?.personaId).filter(Boolean)).length,
    intraPersonaDistance: intraDistance,
    interPersonaDistance: interDistance,
    personaSeparability: separability,
    routeEntropy: routeDiversity,
    actionEntropy: actionDiversity,
    clusterCoverage,
    homogenizationRisk,
    warnings: homogenizationRisk === "high" ? ["Persona behavior appears homogeneous across sessions."] : [],
  };
}

function fingerprintDistance(left, right) {
  const actionDistance = 1 - cosine(left.actionTypeRates, right.actionTypeRates);
  const routeDistance = 1 - jaccard(new Set(left.routeSequence), new Set(right.routeSequence));
  const outcomeDistance = left.abandonmentOccurred === right.abandonmentOccurred ? 0 : 1;
  const behaviorDistance = Math.abs(left.backtrackRate - right.backtrackRate) + Math.abs(left.retryRate - right.retryRate) + Math.abs(left.failedInteractionRate - right.failedInteractionRate);
  return clamp01((actionDistance + routeDistance + outcomeDistance + behaviorDistance) / 4);
}

function isHyperactive(fingerprints, taskMaxActions) {
  if (!taskMaxActions || fingerprints.length === 0) return false;
  return fingerprints.every((item) => item.actionCount >= taskMaxActions * 0.8 && !item.abandonmentOccurred && item.noActionRate === 0);
}

function recommendedUseForRisks(risks, humanReference) {
  if (!humanReference) return risks.includes("insufficient_sample") ? "exploration_only" : "human_review_required";
  if (risks.includes("persona_homogenization") || risks.includes("hyperactivity")) return "human_validation_required";
  return "decision_support";
}

function countBy(items) {
  const counts = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

function rates(counts, denominator) {
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, ratio(value, denominator)]));
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return clamp01(numerator / denominator);
}

function entropy(items) {
  const values = items.filter(Boolean);
  if (values.length === 0) return 0;
  const counts = countBy(values);
  return Object.values(counts).reduce((total, count) => {
    const probability = count / values.length;
    return total - probability * Math.log2(probability);
  }, 0);
}

function routeKey(url) {
  if (!url) return "";
  try {
    return new URL(url).pathname || "/";
  } catch {
    return String(url);
  }
}

function sameActionTarget(left, right) {
  return left?.action?.type === right?.action?.type && (left?.action?.elementId ?? "") === (right?.action?.elementId ?? "");
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return "not_available";
  const mean = average(values);
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function cosine(left, right) {
  const keys = unique([...Object.keys(left), ...Object.keys(right)]);
  const dot = keys.reduce((sum, key) => sum + (left[key] ?? 0) * (right[key] ?? 0), 0);
  const leftNorm = Math.sqrt(keys.reduce((sum, key) => sum + (left[key] ?? 0) ** 2, 0));
  const rightNorm = Math.sqrt(keys.reduce((sum, key) => sum + (right[key] ?? 0) ** 2, 0));
  if (!leftNorm || !rightNorm) return 0;
  return dot / (leftNorm * rightNorm);
}

function jaccard(left, right) {
  const unionSize = new Set([...left, ...right]).size;
  if (!unionSize) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / unionSize;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}


export function extractFrictionPoints({ session, functionalEvaluation, observations = [], events = [], manifest } = {}) {
  const latest = [...observations].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)).at(-1);
  const lastEvent = [...events].sort((left, right) => (left.index ?? 0) - (right.index ?? 0)).at(-1);
  const points = [];
  for (const event of events) {
    if (!event.derivedSignals?.failedInteraction && !event.derivedSignals?.noProgress && event.result?.status === "success") continue;
    const evidenceIds = event.evidenceIds?.filter(Boolean) ?? [];
    if (evidenceIds.length === 0) continue;
    points.push(makeFrictionPoint({
      session,
      route: routeKey(event.urlAfter ?? event.urlBefore),
      category: event.derivedSignals?.failedInteraction ? "functional" : "behavioral",
      observation: event.derivedSignals?.failedInteraction ? `Action ${event.action?.type} failed or was blocked on ${routeKey(event.urlBefore)}.` : `Action ${event.action?.type} made no progress on ${routeKey(event.urlBefore)}.`,
      interpretation: event.derivedSignals?.failedInteraction ? "The user-facing interaction did not complete successfully." : "The session showed a repeated or stalled step before task completion.",
      severityCandidate: event.derivedSignals?.failedInteraction ? "high" : "medium",
      eventIds: [event.id],
      evidenceIds,
      elementFingerprint: event.action?.elementId,
    }));
  }

  if (functionalEvaluation && functionalEvaluation.status !== "success" && lastEvent) {
    const oracleIds = [...(functionalEvaluation.violatedOracleIds ?? []), ...(functionalEvaluation.unknownOracleIds ?? [])];
    const evidenceIds = functionalEvaluation.evidenceIds?.length ? functionalEvaluation.evidenceIds : lastEvent.evidenceIds ?? [];
    if (oracleIds.length > 0 && evidenceIds.length > 0) {
      points.push(makeFrictionPoint({
        session,
        route: routeKey(latest?.page?.url ?? lastEvent.urlAfter),
        category: functionalEvaluation.status === "runtime_error" ? "functional" : "behavioral",
        observation: `${functionalEvaluation.status} with oracle signal(s): ${oracleIds.join(", ")}.`,
        interpretation: "The sealed evidence did not prove deterministic task success.",
        severityCandidate: functionalEvaluation.status === "failure" || functionalEvaluation.status === "runtime_error" ? "high" : "medium",
        eventIds: [lastEvent.id],
        evidenceIds,
        oracleIds,
      }));
    }
  }

  if (manifest) {
    const manifestEvidenceIds = new Set(manifest.entries?.map((entry) => entry.id) ?? []);
    return points.filter((point) => point.evidenceIds.every((id) => manifestEvidenceIds.has(id)));
  }
  return points;
}

export function clusterFrictionPoints(frictionPoints = []) {
  const groups = new Map();
  for (const point of frictionPoints) {
    const key = frictionClusterKey(point);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  }
  return [...groups.entries()].map(([key, points]) => Object.freeze({ key, points: Object.freeze(points) }));
}

export function createFindings({ frictionPoints = [], sessions = [], minimumRecurrence = 2, validityReport } = {}) {
  const sessionById = new Map(sessions.map((item) => [item.sessionId ?? item.session?.sessionId, item.session ?? item]));
  return clusterFrictionPoints(frictionPoints).map(({ key, points }) => {
    const affectedSessionIds = unique(points.map((point) => point.sessionId));
    const affectedSessions = affectedSessionIds.map((id) => sessionById.get(id)).filter(Boolean);
    const severity = severityFromPoints(points, affectedSessionIds.length);
    const maturity = affectedSessionIds.length >= minimumRecurrence ? "reproduced_synthetic_finding" : "exploratory_signal";
    const evidenceConfidence = points.every((point) => point.evidenceIds.length > 0 && point.eventIds.length > 0) ? 1 : 0;
    const recurrenceConfidence = ratio(affectedSessionIds.length, Math.max(sessions.length || affectedSessionIds.length, 1));
    const calibrationUnavailable = validityReport?.calibration?.level !== "calibrated";
    const finding = {
      schemaVersion: FINDING_VERSION,
      id: stableId("finding", [key, affectedSessionIds]),
      fingerprint: stableId("findingfp", [key]),
      title: titleForFinding(points[0]),
      category: points[0].category,
      severity,
      maturity,
      observation: summarizeObservations(points),
      interpretation: points[0].interpretation,
      recommendation: recommendationFor(points[0]),
      affectedSessionIds,
      affectedPersonaIds: unique(affectedSessions.map((session) => session.personaId).filter(Boolean)),
      affectedTaskIds: unique(affectedSessions.map((session) => session.taskId).filter(Boolean)),
      eventIds: unique(points.flatMap((point) => point.eventIds)),
      evidenceIds: unique(points.flatMap((point) => point.evidenceIds)),
      recurrenceRate: recurrenceConfidence,
      confidence: {
        evidenceConfidence,
        recurrenceConfidence,
        seedStability: "not_available",
        modelAgreement: "not_available",
        calibrationConfidence: calibrationUnavailable ? "not_available" : 0.5,
        orderConsistency: "not_available",
        overall: evidenceConfidence === 1 && affectedSessionIds.length >= minimumRecurrence && !calibrationUnavailable ? "high" : (evidenceConfidence === 1 && affectedSessionIds.length >= minimumRecurrence ? "medium" : "low"),
        limitations: [
          ...(affectedSessionIds.length < minimumRecurrence ? ["Finding is not recurrent enough for reproduced maturity."] : []),
          ...(calibrationUnavailable ? ["Synthetic result is not calibrated with human reference data."] : []),
        ],
      },
      humanValidation: {
        required: calibrationUnavailable && ["critical", "high"].includes(severity),
        level: calibrationUnavailable && ["critical", "high"].includes(severity) ? "required" : "recommended",
        reason: calibrationUnavailable ? "Uncalibrated synthetic finding needs human review before release claims." : "Evidence-linked synthetic finding.",
      },
    };
    return validateFinding(finding);
  });
}

function makeFrictionPoint({ session, category, observation, interpretation, severityCandidate, route, elementFingerprint, oracleIds = [], eventIds, evidenceIds }) {
  return validateFrictionPoint({
    schemaVersion: FRICTION_POINT_VERSION,
    id: stableId("friction", [session?.sessionId, category, route, elementFingerprint, oracleIds, eventIds]),
    sessionId: session?.sessionId ?? "unknown-session",
    category,
    observation,
    interpretation,
    severityCandidate,
    ...(route ? { route } : {}),
    ...(elementFingerprint ? { elementFingerprint } : {}),
    oracleIds,
    eventIds,
    evidenceIds: unique(evidenceIds),
    evaluatorConfidence: 0.9,
  });
}

function frictionClusterKey(point) {
  return [point.category, point.route ?? "", point.elementFingerprint ?? "", [...point.oracleIds].sort().join("+")].join("|");
}

function severityFromPoints(points, affectedCount) {
  if (points.some((point) => point.severityCandidate === "critical")) return "critical";
  if (points.some((point) => point.severityCandidate === "high") || affectedCount >= 3) return "high";
  if (points.some((point) => point.severityCandidate === "medium")) return "medium";
  return "low";
}

function titleForFinding(point) {
  if (point.category === "functional") return `Functional friction on ${point.route ?? "task"}`;
  return `Behavioral friction on ${point.route ?? "task"}`;
}

function summarizeObservations(points) {
  return `${points.length} evidence-linked friction point(s): ${points.map((point) => point.observation).join(" ")}`;
}

function recommendationFor(point) {
  if (point.category === "functional") return "Inspect the failing interaction and deterministic oracle evidence before release.";
  return "Review the route, visible affordances, and repeated no-progress action evidence with a human reviewer.";
}
