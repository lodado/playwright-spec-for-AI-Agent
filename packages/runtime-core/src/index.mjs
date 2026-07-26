import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  EVIDENCE_MANIFEST_VERSION,
  validateEvidenceManifest,
} from "@persona-runtime/contracts";

export const RUNTIME_SESSION_SCHEMA_VERSION = "runtime-session/0.1";
export const OBSERVATION_SCHEMA_VERSION = "observation/0.1";
export const INTERACTION_EVENT_SCHEMA_VERSION = "interaction-event/0.1";
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

const ELEMENT_ACTIONS = new Set(["click", "type", "select", "ignore"]);
const NON_PROGRESS_ACTIONS = new Set(["wait", "observe_more", "ignore", "idle"]);

export class RuntimeCoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "RuntimeCoreError";
    this.code = code;
    this.cause = options.cause;
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

export function buildSessionMatrix({ study, runId = `run-${hashJson({ study: study?.study?.id ?? "study" }).slice(0, 12)}` } = {}) {
  validateStudyShape(study);
  const seeds = Array.isArray(study.runtime?.seeds) && study.runtime.seeds.length > 0 ? study.runtime.seeds : [1];
  const variants = study.comparison ? [study.comparison.baseline?.id ?? "baseline", study.comparison.candidate?.id ?? "candidate"] : [undefined];
  const rows = [];
  for (const task of study.tasks) {
    for (const persona of study.personas) {
      for (const seed of seeds) {
        for (const variant of variants) {
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

export async function runStudy({ study, driverFactory, policyFactory, oracle, storeFactory, concurrency, signal } = {}) {
  validateStudyShape(study);
  if (typeof driverFactory !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "driverFactory must be a function");
  if (typeof policyFactory !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "policyFactory must be a function");
  if (typeof oracle?.evaluate !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "oracle.evaluate must be a function");
  if (typeof storeFactory !== "function") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "storeFactory must be a function");

  const limit = positiveConcurrency(concurrency ?? study.runtime?.concurrency ?? 1);
  const matrix = buildSessionMatrix({ study });
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
    sampledPolicy: policy.sampledPolicy ?? {},
    now: now(),
  });
  let handle;
  const events = [];
  const observations = [];
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
    handle = await driver.start({ study, task, persona, seed, variant, sessionId, signal });
    await setPhase("RUNNING");

    while (true) {
      throwIfAborted(signal);
      enforceBudget(budgets, now());

      const observation = normalizeObservation(await driver.observe(handle, { signal }), sessionId, observations.length);
      observations.push(observation);
      await store.appendObservation?.(observation);

      const oracleResult = await oracle.evaluate({ study, task, persona, session, observation, events, signal });
      const terminal = terminalFromOracle(oracleResult);
      if (terminal) {
        await setPhase(terminal.phase, { terminalReason: terminal.reason });
        break;
      }

      const action = validateAction(await policy.decide({ study, task, persona, session, observation, events, signal }), observation, task);
      const actionTerminal = terminalFromAction(action);
      if (actionTerminal) {
        await setPhase(actionTerminal.phase, { terminalReason: actionTerminal.reason });
        break;
      }

      budgets.consume(action);
      const result = normalizeActionResult(await driver.execute(handle, action, { signal }));
      const event = deriveInteractionEvent({ sessionId, index: events.length, observation, action, result });
      events.push(event);
      await store.appendEvent?.(event);
      session = deepFreeze({ ...session, eventIds: [...session.eventIds, event.id] });
      await saveSession();
    }
  } catch (error) {
    const runtimeError = toRuntimeError(error);
    if (!TERMINAL_PHASES.includes(session.phase)) {
      await setPhase("RUNTIME_ERROR", { terminalReason: { code: runtimeError.code, message: runtimeError.message } });
    }
  } finally {
    if (handle !== undefined) {
      try {
        await driver.close(handle);
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

  const manifest = await sealSessionEvidence({ session, observations, events, store, now: now() });
  await setPhase("EVIDENCE_SEALED", { evidenceManifestId: manifest.id });
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
      ...(result.message ? { message: result.message } : {}),
    },
    urlBefore: observation.page?.url ?? "about:blank",
    urlAfter: result.urlAfter ?? observation.page?.url ?? "about:blank",
    evidenceIds: Array.isArray(result.evidenceIds) && result.evidenceIds.length > 0
      ? [...result.evidenceIds]
      : [`evidence-${eventId}`],
    derivedSignals: {
      progressChanged: Boolean(result.progressChanged),
      backtrack: action.type === "back" || result.backtrack === true,
      repeatedPage: result.repeatedPage === true,
      failedInteraction: result.status === "failure" || result.status === "blocked",
      noProgress: result.progressChanged !== true,
    },
  };
  return deepFreeze(event);
}

async function sealSessionEvidence({ session, observations, events, store, now }) {
  const manifestBody = {
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    id: `manifest-${session.sessionId}`,
    runId: session.runId,
    sessionId: session.sessionId,
    createdAt: session.startedAt,
    sealedAt: toIso(now),
    sealed: true,
    studyHash: hashJson({ studyId: session.studyId, taskId: session.taskId }),
    policyHash: hashJson(session.sampledPolicy),
    entries: [
      ...observations.map((observation) => ({
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
    ],
    redactionSummary: { redactedCount: 0, rulesVersion: "runtime-core/0.1" },
  };
  const manifest = validateEvidenceManifest({ ...manifestBody, manifestHash: hashJson(manifestBody) });
  try {
    await store.sealManifest?.(manifest);
  } catch (error) {
    throw new RuntimeCoreError(RUNTIME_ERROR_CODES.EVIDENCE_SEAL_FAILED, "failed to seal session evidence", { cause: error });
  }
  return manifest;
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
  if (action.type === "type" && (typeof action.valueRef !== "string" || action.valueRef.length === 0)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "type action requires valueRef");
  if (action.type === "select" && typeof action.value !== "string") throw new RuntimeCoreError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, "select action requires value");
  return deepFreeze(structuredClone(action));
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
    semantic: observation.semantic ?? { visibleText: [], headings: [], landmarks: [], interactiveElements: [] },
    visual: observation.visual ?? {},
    runtime: observation.runtime ?? { consoleIssues: [], networkFailures: [], pendingRequestCount: 0, loadingIndicators: [] },
    oracleSignals: observation.oracleSignals ?? { satisfied: [], violated: [], unknown: [] },
  });
}

function normalizeActionResult(result) {
  if (!isRecord(result) || !["success", "failure", "no_change", "blocked"].includes(result.status)) throw new RuntimeCoreError(RUNTIME_ERROR_CODES.DRIVER_FAILED, "driver returned an invalid action result");
  return result;
}

function validateStudyShape(study) {
  if (!isRecord(study) || !isRecord(study.study) || typeof study.study.id !== "string" || !Array.isArray(study.tasks) || !Array.isArray(study.personas)) {
    throw new RuntimeCoreError(RUNTIME_ERROR_CODES.SPEC_INVALID, "study must include study.id, tasks, and personas");
  }
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
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true });
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWriteRaw(path, `${current}${JSON.stringify(value)}\n`);
}

async function atomicWriteRaw(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

async function mapLimit(items, limit, signal, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      throwIfAborted(signal);
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
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
  return new RuntimeCoreError(error?.code ?? RUNTIME_ERROR_CODES.DRIVER_FAILED, error?.message ?? "runtime failed", { cause: error });
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
