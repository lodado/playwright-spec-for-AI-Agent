import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  EVIDENCE_MANIFEST_VERSION,
  INTERACTION_EVENT_VERSION,
  INTERACTION_RESULT_CODES,
  MODEL_ATTEMPT_VERSION,
  OBSERVATION_VERSION,
  SESSION_VERSION,
  canonicalHash,
  redactStudySecrets,
  validateBrowserAction,
  validateEvidenceManifest,
  validateInteractionEvent,
  validateModelAttempt,
  validateSessionRecord,
} from "./contracts.mjs";

export const RUNTIME_SESSION_SCHEMA_VERSION = "runtime-session/0.1";
export const OBSERVATION_SCHEMA_VERSION = OBSERVATION_VERSION;
export const INTERACTION_EVENT_SCHEMA_VERSION = INTERACTION_EVENT_VERSION;
export const EVIDENCE_MANIFEST_SCHEMA_VERSION = EVIDENCE_MANIFEST_VERSION;

export const SESSION_PHASES = Object.freeze([
  "CREATED",
  "VALIDATED",
  "QUEUED",
  "STARTING_BROWSER",
  "RUNNING",
  "SUCCESS",
  "PARTIAL",
  "FAILURE",
  "ABANDONED",
  "RUNTIME_ERROR",
  "MANUAL_REVIEW",
  "EVIDENCE_SEALED",
  "EVALUATED",
  "REPORTED",
]);

export const TERMINAL_PHASES = Object.freeze([
  "SUCCESS",
  "PARTIAL",
  "FAILURE",
  "ABANDONED",
  "RUNTIME_ERROR",
  "MANUAL_REVIEW",
]);

export const BROWSER_ACTION_TYPES = Object.freeze([
  "click",
  "type",
  "select",
  "scroll",
  "back",
  "wait",
  "observe_more",
  "ignore",
  "idle",
  "finish",
  "abandon",
]);

export const RUNTIME_ERROR_CODES = Object.freeze({
  SPEC_INVALID: "SPEC_INVALID",
  BROWSER_START_FAILED: "BROWSER_START_FAILED",
  MODEL_INVALID_OUTPUT: "MODEL_INVALID_OUTPUT",
  MODEL_TIMEOUT: "MODEL_TIMEOUT",
  MODEL_PROVIDER_FAILED: "MODEL_PROVIDER_FAILED",
  ACTION_NOT_ALLOWED: "ACTION_NOT_ALLOWED",
  ACTION_BUDGET_EXHAUSTED: "ACTION_BUDGET_EXHAUSTED",
  TIME_BUDGET_EXHAUSTED: "TIME_BUDGET_EXHAUSTED",
  NO_PROGRESS_BUDGET_EXHAUSTED: "NO_PROGRESS_BUDGET_EXHAUSTED",
  CANCELLED: "CANCELLED",
  EVIDENCE_WRITE_FAILED: "EVIDENCE_WRITE_FAILED",
  EVIDENCE_SEAL_FAILED: "EVIDENCE_SEAL_FAILED",
  DRIVER_FAILED: "DRIVER_FAILED",
});

const STATUS_BY_TERMINAL_PHASE = Object.freeze({
  SUCCESS: "success",
  PARTIAL: "partial",
  FAILURE: "failure",
  ABANDONED: "abandoned",
  RUNTIME_ERROR: "runtime_error",
  MANUAL_REVIEW: "manual_review",
});

// Budget exhaustion is a behavioral outcome (the persona ran out of actions/time/patience), not an
// infrastructure fault — it terminates as ABANDONED with the budget code preserved, never runtime_error.
const BUDGET_TERMINAL_REASONS = Object.freeze({
  ACTION_BUDGET_EXHAUSTED: "action_budget",
  TIME_BUDGET_EXHAUSTED: "time_budget",
  NO_PROGRESS_BUDGET_EXHAUSTED: "no_progress",
});

const ELEMENT_ACTIONS = new Set(["click", "type", "select", "ignore"]);
const NON_PROGRESS_ACTIONS = new Set(["wait", "observe_more", "ignore", "idle"]);
const INTERACTION_RESULT_CODE_SET = new Set(INTERACTION_RESULT_CODES);

export class RuntimeCoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "RuntimeCoreError";
    this.code = code;
    this.cause = options.cause;
    this.modelAttempts = options.modelAttempts;
  }
}

export function createSessionRecord({ runId, sessionId, studyId, taskId, personaId, seed, variant, model, sampledPolicy = {}, now = new Date() } = {}) {
  assertNonEmptyString(runId, "runId");
  assertNonEmptyString(sessionId, "sessionId");
  assertNonEmptyString(studyId, "studyId");
  assertNonEmptyString(taskId, "taskId");
  assertNonEmptyString(personaId, "personaId");
  assertInteger(seed, "seed");
  return deepFreeze({
    schemaVersion: RUNTIME_SESSION_SCHEMA_VERSION,
    runId,
    sessionId,
    studyId,
    taskId,
    personaId,
    seed,
    ...(variant === undefined ? {} : { variant }),
    ...(model === undefined ? {} : { model }),
    phase: "CREATED",
    status: "created",
    startedAt: toIso(now),
    sampledPolicy: structuredClone(sampledPolicy),
    terminalReason: undefined,
    eventIds: [],
    evidenceManifestId: undefined,
    transitions: [{ phase: "CREATED", at: toIso(now) }],
  });
}

export function transitionSession(session, phase, details = {}) {
  if (!SESSION_PHASES.includes(phase)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, `unknown session phase ${phase}`);
  if (!canTransition(session.phase, phase)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, `invalid transition ${session.phase} -> ${phase}`);
  const at = toIso(details.now ?? new Date());
  const terminalStatus = STATUS_BY_TERMINAL_PHASE[phase];
  return deepFreeze({
    ...session,
    phase,
    status: terminalStatus ?? statusForPostTerminal(session, phase),
    ...(terminalStatus ? { completedAt: at, terminalReason: details.terminalReason ?? session.terminalReason } : {}),
    ...(details.evidenceManifestId ? { evidenceManifestId: details.evidenceManifestId } : {}),
    transitions: [...session.transitions, { phase, at, ...(details.reasonCode ? { reasonCode: details.reasonCode } : {}) }],
  });
}

export function toSessionRecord(session) {
  const terminal = TERMINAL_PHASES.includes(session.phase) || ["EVIDENCE_SEALED", "EVALUATED", "REPORTED"].includes(session.phase);
  return validateSessionRecord({
    schemaVersion: SESSION_VERSION,
    runId: session.runId,
    sessionId: session.sessionId,
    studyId: session.studyId,
    taskId: session.taskId,
    personaId: session.personaId,
    seed: session.seed,
    ...(session.variant ? { variant: session.variant } : {}),
    ...(session.model ? { model: session.model } : {}),
    status: session.status,
    startedAt: session.startedAt,
    ...(terminal && session.completedAt ? { completedAt: session.completedAt } : {}),
    sampledPolicy: session.sampledPolicy,
    ...(session.terminalReason ? { terminalReason: session.terminalReason } : {}),
    eventIds: session.eventIds,
    ...(session.evidenceManifestId ? { evidenceManifestId: session.evidenceManifestId } : {}),
  });
}

export function buildSessionMatrix({ study, runId = `run-${hashJson({ study: study?.study?.id ?? "study" }).slice(0, 12)}` } = {}) {
  validateStudyShape(study);
  const seeds = Array.isArray(study.runtime?.seeds) && study.runtime.seeds.length > 0 ? study.runtime.seeds : [1];
  const variants = study.comparison ? [study.comparison.baseline?.id ?? "baseline", study.comparison.candidate?.id ?? "candidate"] : [undefined];
  const rows = [];
  for (const task of study.tasks) {
    for (const [personaIndex, persona] of study.personas.entries()) {
      for (const [seedIndex, seed] of seeds.entries()) {
        const orderedVariants = study.comparison?.counterbalanceOrder && (personaIndex + seedIndex) % 2 === 1
          ? [...variants].reverse()
          : variants;
        for (const variant of orderedVariants) {
          rows.push({
            runId,
            study,
            task,
            persona,
            seed,
            variant,
            sessionId: stableSessionId({ runId, taskId: task.id, personaId: persona.id ?? persona.preset, seed, variant }),
          });
        }
      }
    }
  }
  return deepFreeze(rows);
}

export async function runStudy({ study, runId = `run-${randomUUID()}`, driverFactory, policyFactory, oracle, storeFactory, concurrency, signal } = {}) {
  validateStudyShape(study);
  if (typeof driverFactory !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "driverFactory must be a function");
  if (typeof policyFactory !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "policyFactory must be a function");
  if (typeof oracle?.evaluate !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "oracle.evaluate must be a function");
  if (typeof storeFactory !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "storeFactory must be a function");

  const limit = positiveConcurrency(concurrency ?? study.runtime?.concurrency ?? 1);
  const matrix = buildSessionMatrix({ study, runId });
  const results = await mapLimit(matrix, limit, signal, async (entry) => {
    const driver = driverFactory(entry);
    const policy = policyFactory(entry);
    const store = storeFactory(entry);
    return runSession({ ...entry, driver, policy, oracle, store, signal });
  });
  return deepFreeze({ runId: matrix[0]?.runId ?? "run-empty", sessionCount: results.length, results });
}

export async function runSession({ study, task, persona, seed, variant, runId, sessionId, driver, policy, oracle, store, signal, now = () => new Date() } = {}) {
  validateStudyShape(study);
  validateTaskShape(task);
  if (typeof driver?.start !== "function" || typeof driver.observe !== "function" || typeof driver.execute !== "function" || typeof driver.close !== "function") {
    throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "driver must implement start/observe/execute/close");
  }
  if (typeof policy?.decide !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "policy.decide must be a function");
  if (typeof oracle?.evaluate !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "oracle.evaluate must be a function");
  if (!store) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "store is required");

  let session = createSessionRecord({
    runId,
    sessionId,
    studyId: study.study.id,
    taskId: task.id,
    personaId: persona.id ?? persona.preset,
    seed,
    variant,
    model: typeof policy.identity === "string" ? policy.identity : undefined,
    sampledPolicy: policy.sampledPolicy ?? {},
    now: now(),
  });
  let handle;
  const events = [];
  const observations = [];
  const driverEvidence = [];
  const modelAttempts = [];
  const budgets = createBudget(task, now());

  const saveSession = async () => store.saveSession?.(session);
  const setPhase = async (phase, details = {}) => {
    session = transitionSession(session, phase, { ...details, now: now() });
    await saveSession();
  };

  try {
    throwIfAborted(signal);
    await saveSession();
    await setPhase("VALIDATED");
    await setPhase("QUEUED");
    await setPhase("STARTING_BROWSER");
    handle = await driver.start({
      study,
      task,
      persona,
      seed,
      variant,
      sessionId,
      signal,
      environment: {
        ...environmentFor(study, variant),
        startPath: task.startPath ?? study.environment?.startPath,
      },
      safetyPolicy: task.safetyPolicy,
      evidencePolicy: study.evidence,
      evidenceDir: store.sessionDir,
      valueRefs: study.environment?.fixtures ?? {},
    });
    await setPhase("RUNNING");

    while (true) {
      throwIfAborted(signal);
      const rawObservation = await driver.observe(handle, { signal });
      driverEvidence.push(...evidenceFrom(rawObservation));
      const observation = normalizeObservation(rawObservation, sessionId, observations.length);
      observations.push(observation);
    if ((study.evidence?.semanticSnapshot ?? "every_action") === "every_action") await store.appendObservation?.(observation);

      const oracleResult = await oracle.evaluate({ study, task, persona, session, observation, observations, events, signal });
      const terminal = terminalFromOracle(oracleResult);
      if (terminal) {
        await setPhase(terminal.phase, { terminalReason: terminal.reason });
        break;
      }

      enforceBudget(budgets, now());

      const perceivedObservation = buildPerceivedObservation(observation);
      const decision = await policy.decide({
        study,
        task,
        persona,
        session,
        observation: perceivedObservation,
        perceivedObservation,
        events,
        signal,
      });
      collectModelAttempts(modelAttempts, decision?.attempts);
      const action = validateAction(decision, perceivedObservation, task);
      const actionTerminal = terminalFromAction(action);
      if (actionTerminal) {
        await setPhase(actionTerminal.phase, { terminalReason: actionTerminal.reason });
        break;
      }

      budgets.consume(action);
      const result = normalizeActionResult(await driver.execute(handle, action, { signal }));
      driverEvidence.push(...evidenceFrom(result));
      const event = deriveInteractionEvent({ sessionId, index: events.length, observation, action, result });
      events.push(event);
      await store.appendEvent?.(event);
      session = deepFreeze({ ...session, eventIds: [...session.eventIds, event.id] });
      await saveSession();
    }
  } catch (error) {
    let runtimeError;
    try {
      collectModelAttempts(modelAttempts, error?.modelAttempts);
      runtimeError = toRuntimeError(error);
    } catch (metadataError) {
      runtimeError = toRuntimeError(metadataError);
    }
    if (!TERMINAL_PHASES.includes(session.phase)) {
      const budgetReason = BUDGET_TERMINAL_REASONS[runtimeError.code];
      if (budgetReason) {
        await setPhase("ABANDONED", { terminalReason: { code: runtimeError.code, message: runtimeError.message }, reasonCode: budgetReason });
      } else {
        await setPhase("RUNTIME_ERROR", { terminalReason: { code: runtimeError.code, message: runtimeError.message } });
      }
    }
  } finally {
    if (handle !== undefined) {
      try {
        const closeResult = await driver.close(handle);
        driverEvidence.push(...evidenceFrom(closeResult));
      } catch (error) {
        if (session.phase !== "RUNTIME_ERROR") {
          await setPhase("RUNTIME_ERROR", { terminalReason: { code: RUNTIME_ERROR_CODES.DRIVER_FAILED, message: "driver close failed" } });
        }
      }
    }
  }

  if (!TERMINAL_PHASES.includes(session.phase)) {
    await setPhase("MANUAL_REVIEW", { terminalReason: { code: "NO_TERMINAL_RESULT", message: "session ended without a terminal result" } });
  }

  if (study.evidence?.semanticSnapshot === "on_failure" && session.status !== "success") {
    for (const observation of observations) await store.appendObservation?.(observation);
  }

  const { manifest, sealError } = await sealSessionEvidence({ study, session, observations, events, driverEvidence, modelAttempts, store, now: now() });
  if (sealError) {
    if (session.phase !== "RUNTIME_ERROR") {
      await setPhase("RUNTIME_ERROR", { terminalReason: { code: sealError.code, message: sealError.message } });
    }
  } else {
    await setPhase("EVIDENCE_SEALED", { evidenceManifestId: manifest.id });
  }
  return deepFreeze({ session, manifest, observations, events });
}

export async function evaluateSealedSession({ sessionResult, evaluator, store, now = () => new Date() } = {}) {
  if (sessionResult?.session?.phase !== "EVIDENCE_SEALED") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "session must be evidence sealed before evaluation");
  if (typeof evaluator?.evaluate !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "evaluator.evaluate must be a function");
  const evaluation = await evaluator.evaluate(sessionResult);
  const session = transitionSession(sessionResult.session, "EVALUATED", { now: now() });
  await store?.saveSession?.(session);
  return deepFreeze({ ...sessionResult, session, evaluation });
}

export async function markSessionReported({ evaluatedSessionResult, reporterResult, store, now = () => new Date() } = {}) {
  if (evaluatedSessionResult?.session?.phase !== "EVALUATED") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "session must be evaluated before reporting");
  const session = transitionSession(evaluatedSessionResult.session, "REPORTED", { now: now() });
  await store?.saveSession?.(session);
  return deepFreeze({ ...evaluatedSessionResult, session, report: reporterResult });
}

export function createFileSessionStore({ rootDir, sessionId } = {}) {
  assertNonEmptyString(rootDir, "rootDir");
  assertNonEmptyString(sessionId, "sessionId");
  const sessionDir = join(rootDir, "sessions", sessionId);
  return Object.freeze({
    sessionDir,
    async saveSession(session) {
      await atomicWriteJson(join(sessionDir, "session.json"), session);
    },
    async appendObservation(observation) {
      await appendJsonLine(join(sessionDir, "observations.jsonl"), observation);
    },
    async appendEvent(event) {
      await appendJsonLine(join(sessionDir, "events.jsonl"), event);
    },
    async sealManifest(manifest) {
      await atomicWriteJson(join(sessionDir, "evidence-manifest.json"), manifest);
    },
  });
}

export function deriveInteractionEvent({ sessionId, index, observation, action, result, now = new Date() } = {}) {
  const eventId = stableEventId(sessionId, index);
  const urlBefore = observation.page?.url ?? "about:blank";
  const urlAfter = result.urlAfter ?? urlBefore;
  const progressChanged = result.status === "success"
    && (typeof result.progressChanged === "boolean" ? result.progressChanged : urlAfter !== urlBefore);
  const event = {
    schemaVersion: INTERACTION_EVENT_SCHEMA_VERSION,
    id: eventId,
    sessionId,
    index,
    timestamp: toIso(now),
    observationId: observation.id,
    action: structuredClone(action),
    result: {
      status: result.status,
      ...(result.code ? { code: result.code } : {}),
      ...(result.message ? { message: result.message } : {}),
    },
    urlBefore,
    urlAfter,
    evidenceIds: Array.isArray(result.evidenceIds) && result.evidenceIds.length > 0
      ? [...result.evidenceIds]
      : [`evidence-${eventId}`],
    derivedSignals: {
      progressChanged,
      backtrack: action.type === "back" || result.backtrack === true,
      repeatedPage: result.repeatedPage === true,
      failedInteraction: false,
      noProgress: !progressChanged,
    },
  };
  return validateInteractionEvent(event);
}

async function sealSessionEvidence({ study, session, observations, events, driverEvidence, modelAttempts, store, now }) {
  const manifestBody = {
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    id: `manifest-${session.sessionId}`,
    runId: session.runId,
    sessionId: session.sessionId,
    createdAt: session.startedAt,
    sealedAt: toIso(now),
    sealed: true,
    studyHash: hashJson(redactStudySecrets(study)),
    policyHash: hashJson(session.sampledPolicy),
    entries: [
      ...deduplicateEvidence(driverEvidence),
      ...persistedSemanticObservations(study.evidence?.semanticSnapshot ?? "every_action", session.status, observations).map((observation) => ({
        id: `evidence-${observation.id}`,
        type: "semantic_snapshot",
        contentHash: hashJson(observation),
        metadata: { observationId: observation.id, sequence: observation.sequence },
      })),
      ...events.map((event) => ({
        id: `evidence-${event.id}`,
        type: "action_result",
        contentHash: hashJson(event),
        metadata: { eventId: event.id, index: event.index },
      })),
      ...modelAttempts.map((attempt, index) => ({
        id: `evidence-model-attempt-${session.sessionId}-${index}`,
        type: "model_attempt",
        contentHash: hashJson(attempt),
        metadata: attempt,
      })),
    ],
    redactionSummary: {
      redactedCount: Object.keys(study.environment?.fixtures ?? {}).length,
      rulesVersion: "runtime-core/0.1",
    },
  };
  const manifest = validateEvidenceManifest({ ...manifestBody, manifestHash: hashJson(manifestBody) });
  // The manifest is valid in memory before persistence; a failed disk write degrades this one session
  // to runtime_error but must not abort the run, so surface the error rather than throwing it.
  let sealError;
  try {
    await store.sealManifest?.(manifest);
  } catch (error) {
    sealError = new RuntimeCoreError(RUNTIME_ERROR_CODES.EVIDENCE_SEAL_FAILED, "failed to seal session evidence", { cause: error });
  }
  return { manifest, sealError };
}

function collectModelAttempts(target, attempts) {
  if (attempts === undefined) return;
  if (!Array.isArray(attempts)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "policy returned invalid model attempt metadata");
  try {
    target.push(...attempts.map(attempt => validateModelAttempt({ ...attempt, schemaVersion: attempt.schemaVersion ?? MODEL_ATTEMPT_VERSION })));
  } catch (error) {
    throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "policy returned invalid model attempt metadata", { cause: error });
  }
}

function createBudget(task, startedAt) {
  let actions = task.maxActions;
  let consecutiveNoProgress = 0;
  return Object.freeze({
    consume(action) {
      if (actions <= 0) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.ACTION_BUDGET_EXHAUSTED, "action budget exhausted");
      actions -= 1;
      consecutiveNoProgress = NON_PROGRESS_ACTIONS.has(action.type) ? consecutiveNoProgress + 1 : 0;
      if (consecutiveNoProgress > task.maxConsecutiveNoProgressActions) {
        throw new RuntimeCoreError(RUNTIME_ERROR_CODES.NO_PROGRESS_BUDGET_EXHAUSTED, "no-progress action budget exhausted");
      }
    },
    enforce(now) {
      if (Number(now) - Number(startedAt) > task.maxDurationMs) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.TIME_BUDGET_EXHAUSTED, "time budget exhausted");
      if (actions <= 0) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.ACTION_BUDGET_EXHAUSTED, "action budget exhausted");
    },
  });
}

function enforceBudget(budgets, now) {
  budgets.enforce(now);
}

function validateAction(decision, observation, task) {
  const action = decision?.action ?? decision;
  if (!isRecord(action) || !BROWSER_ACTION_TYPES.includes(action.type)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "policy returned an invalid action");
  if (typeof action.reasonCode !== "string" || action.reasonCode.length === 0) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "action requires reasonCode");

  if (ELEMENT_ACTIONS.has(action.type) && action.elementId !== undefined) {
    const elements = observation.semantic?.interactiveElements ?? [];
    if (!elements.some((element) => element.id === action.elementId || element.elementId === action.elementId)) {
      throw new RuntimeCoreError(RUNTIME_ERROR_CODES.ACTION_NOT_ALLOWED, "action references an element outside the current observation");
    }
  }

  if (action.type === "click" && task.safetyPolicy?.allowClick === false) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.ACTION_NOT_ALLOWED, "click is blocked by task safety policy");
  if (action.type === "type" && task.safetyPolicy?.allowTyping === false) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.ACTION_NOT_ALLOWED, "typing is blocked by task safety policy");
  if (action.type === "abandon" && task.abandonmentAllowed === false) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.ACTION_NOT_ALLOWED, "abandonment is blocked by task policy");
  if (action.type === "type" && (typeof action.valueRef !== "string" || action.valueRef.length === 0)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "type action requires valueRef");
  if (action.type === "select" && typeof action.value !== "string") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "select action requires value");
  try {
    return validateBrowserAction(canonicalAction(action));
  } catch (error) {
    throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "policy returned an invalid action", { cause: error });
  }
}

function canonicalAction(action) {
  const result = { type: action.type, reasonCode: action.reasonCode };
  if (["click", "type", "select", "ignore"].includes(action.type) && action.elementId !== undefined) result.elementId = action.elementId;
  if (action.type === "type") result.valueRef = action.valueRef;
  if (action.type === "select") result.value = action.value;
  if (action.type === "scroll") {
    result.direction = action.direction;
    result.amount = action.amount;
  }
  if (["wait", "idle"].includes(action.type)) result.durationMs = action.durationMs;
  return result;
}

function terminalFromOracle(result) {
  if (result?.definitiveSuccess) return { phase: "SUCCESS", reason: { code: "success_oracle_satisfied", message: result.reason ?? "success oracle satisfied" } };
  if (result?.definitiveFailure) return { phase: "FAILURE", reason: { code: "failure_oracle_satisfied", message: result.reason ?? "failure oracle satisfied" } };
  if (result?.manualReview) return { phase: "MANUAL_REVIEW", reason: { code: "oracle_manual_review", message: result.reason ?? "oracle requested manual review" } };
  return undefined;
}

function terminalFromAction(action) {
  if (action.type === "finish") return { phase: "PARTIAL", reason: { code: action.reasonCode, message: "policy finished without definitive oracle success" } };
  if (action.type === "abandon") return { phase: "ABANDONED", reason: { code: action.reasonCode, message: "policy abandoned the session" } };
  return undefined;
}

function normalizeObservation(observation, sessionId, sequence) {
  if (!isRecord(observation)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.DRIVER_FAILED, "driver returned an invalid observation");
  return deepFreeze({
    schemaVersion: observation.schemaVersion ?? OBSERVATION_SCHEMA_VERSION,
    id: observation.id ?? stableObservationId(sessionId, sequence),
    sessionId,
    sequence,
    timestamp: observation.timestamp ?? new Date().toISOString(),
    page: observation.page ?? { url: "about:blank", title: "", viewport: { width: 0, height: 0 } },
    semantic: {
      visibleText: observation.semantic?.visibleText ?? [],
      headings: observation.semantic?.headings ?? [],
      landmarks: observation.semantic?.landmarks ?? [],
      interactiveElements: observation.semantic?.interactiveElements ?? [],
    },
    visual: {
      screenshotEvidenceId: observation.visual?.screenshotEvidenceId ?? `missing-screenshot-${sessionId}-${sequence}`,
      ...(observation.visual?.occludedElementFingerprints
        ? { occludedElementFingerprints: observation.visual.occludedElementFingerprints }
        : {}),
    },
    runtime: {
      consoleIssues: observation.runtime?.consoleIssues ?? [],
      networkFailures: observation.runtime?.networkFailures ?? [],
      pendingRequestCount: observation.runtime?.pendingRequestCount ?? 0,
      loadingIndicators: observation.runtime?.loadingIndicators ?? [],
    },
    oracleSignals: observation.oracleSignals ?? { satisfied: [], violated: [], unknown: [] },
  });
}

function buildPerceivedObservation(observation) {
  const viewport = observation.page?.viewport ?? { width: 0, height: 0 };
  const semantic = observation.semantic ?? {};
  const headings = (semantic.headings ?? []).filter((node) => isViewportSafe(node, viewport));
  const landmarks = (semantic.landmarks ?? []).filter((node) => isViewportSafe(node, viewport));
  const interactiveElements = (semantic.interactiveElements ?? []).filter((node) => isViewportSafe(node, viewport));
  const visibleText = uniqueStrings([
    ...(semantic.visibleText ?? []).filter((text) => typeof text === "string"),
    ...headings.flatMap(textParts),
    ...landmarks.flatMap(textParts),
    ...interactiveElements.flatMap(textParts),
  ]);
  return deepFreeze({
    ...observation,
    semantic: { visibleText, headings, landmarks, interactiveElements },
  });
}

function isViewportSafe(node, viewport) {
  if (!isRecord(node) || node.visible === false || node.viewportPosition?.occluded === true) return false;
  if (node.viewportPosition) return node.viewportPosition.inViewport === true;
  const box = node.boundingBox;
  return isRecord(box)
    && box.width > 0
    && box.height > 0
    && box.x + box.width > 0
    && box.y + box.height > 0
    && box.x < viewport.width
    && box.y < viewport.height;
}

function textParts(value) {
  return [value.name, value.text].filter((item) => typeof item === "string" && item.length > 0);
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function evidenceFrom(value) {
  return Array.isArray(value?.evidence) ? value.evidence.filter(isRecord).map(item => structuredClone(item)) : [];
}

function persistedSemanticObservations(policy, status, observations) {
  if (policy === "every_action" || (policy === "on_failure" && status !== "success")) return observations;
  return [];
}

function deduplicateEvidence(entries) {
  return [...new Map(entries.map(entry => [entry.id, entry])).values()];
}

function normalizeActionResult(result) {
  if (!isRecord(result) || !["success", "failure", "no_change", "blocked"].includes(result.status)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.DRIVER_FAILED, "driver returned an invalid action result");
  const code = result.code ?? (result.status === "failure" ? "DRIVER_ACTION_FAILED" : result.status === "blocked" ? "ACTION_NOT_ALLOWED" : undefined);
  if (code !== undefined && !INTERACTION_RESULT_CODE_SET.has(code)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.DRIVER_FAILED, "driver returned an invalid action result code");
  return deepFreeze({
    status: result.status,
    ...(code ? { code } : {}),
    ...(typeof result.message === "string" && result.message.length > 0 ? { message: result.message } : {}),
    ...(typeof result.urlAfter === "string" ? { urlAfter: result.urlAfter } : {}),
    ...(Array.isArray(result.evidenceIds) ? { evidenceIds: [...result.evidenceIds] } : {}),
    ...(Array.isArray(result.evidence) ? { evidence: [...result.evidence] } : {}),
    ...(typeof result.progressChanged === "boolean" ? { progressChanged: result.progressChanged } : {}),
    ...(result.backtrack === true ? { backtrack: true } : {}),
    ...(result.repeatedPage === true ? { repeatedPage: true } : {}),
  });
}

function validateStudyShape(study) {
  if (!isRecord(study) || !isRecord(study.study) || typeof study.study.id !== "string" || !Array.isArray(study.tasks) || !Array.isArray(study.personas)) {
    throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "study must include study.id, tasks, and personas");
  }
}

function environmentFor(study, variant) {
  if (!study.comparison || !variant) return study.environment;
  const selected = [study.comparison.baseline, study.comparison.candidate].find(item => item?.id === variant);
  if (!selected?.baseUrl) return study.environment;
  return {
    ...study.environment,
    baseUrl: selected.baseUrl,
    allowedOrigins: [new URL(selected.baseUrl).origin],
  };
}

function validateTaskShape(task) {
  if (!isRecord(task) || typeof task.id !== "string") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "task.id is required");
  assertPositiveInteger(task.maxActions, "task.maxActions");
  assertPositiveInteger(task.maxDurationMs, "task.maxDurationMs");
  assertPositiveInteger(task.maxConsecutiveNoProgressActions, "task.maxConsecutiveNoProgressActions");
}

function stableSessionId({ runId, taskId, personaId, seed, variant }) {
  return `session-${hashJson({ runId, taskId, personaId, seed, variant }).slice(7, 23)}`;
}

function stableObservationId(sessionId, sequence) {
  return `observation-${sessionId}-${sequence}`;
}

function stableEventId(sessionId, index) {
  return `event-${sessionId}-${index}`;
}

function hashJson(value) {
  return canonicalHash(value);
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(path, `${current}${JSON.stringify(value)}\n`);
}

export async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

async function mapLimit(items, limit, signal, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  async function runOne() {
    while (next < items.length && failure === undefined) {
      try {
        throwIfAborted(signal);
      } catch (error) {
        failure ??= error;
        return;
      }
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  if (failure) throw failure;
  return results;
}

function canTransition(from, to) {
  if (from === to) return true;
  if (from === "CREATED") return to === "VALIDATED";
  if (from === "VALIDATED") return to === "QUEUED";
  if (from === "QUEUED") return to === "STARTING_BROWSER";
  if (from === "STARTING_BROWSER") return to === "RUNNING" || to === "RUNTIME_ERROR";
  if (from === "RUNNING") return TERMINAL_PHASES.includes(to);
  if (TERMINAL_PHASES.includes(from)) return to === "EVIDENCE_SEALED" || (to === "RUNTIME_ERROR" && from !== "RUNTIME_ERROR");
  if (from === "EVIDENCE_SEALED") return to === "EVALUATED";
  if (from === "EVALUATED") return to === "REPORTED";
  return false;
}

function statusForPostTerminal(session, phase) {
  if (["EVIDENCE_SEALED", "EVALUATED", "REPORTED"].includes(phase) && TERMINAL_PHASES.includes(session.phase)) return session.status;
  if (["CREATED", "VALIDATED", "QUEUED", "STARTING_BROWSER"].includes(phase)) return "created";
  if (["RUNNING", "EVIDENCE_SEALED", "EVALUATED", "REPORTED"].includes(phase)) return "running";
  return "runtime_error";
}

function positiveConcurrency(value) {
  assertPositiveInteger(value, "concurrency");
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.CANCELLED, "runtime execution was cancelled");
}

function toRuntimeError(error) {
  if (error instanceof RuntimeCoreError) return error;
  return new RuntimeCoreError(RUNTIME_ERROR_CODES.DRIVER_FAILED, "runtime failed", { cause: error });
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, `${name} must be a non-empty string`);
}

function assertInteger(value, name) {
  if (!Number.isInteger(value)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, `${name} must be an integer`);
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, `${name} must be a positive integer`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function removeFileSessionStore(rootDir) {
  await rm(rootDir, { recursive: true, force: true });
}
