import { canonicalHash } from "@persona-runtime/contracts";
import { PRESETS, deriveSessionSeed, sampleBehaviorPolicy } from "@persona-runtime/persona-policy";
import { RUNTIME_ERROR_CODES, RuntimeCoreError } from "@persona-runtime/runtime-core";
import { readHermesModelConfig, redactSensitiveText, runHermes } from "@persona-runtime/hermes-transport";

export const HERMES_ACTION_PROMPT_VERSION = "personaut-hermes-action/0.1";
const MODEL_DEADLINE_MS = 30_000;
const MAX_TEXT_ITEMS = 50;
const MAX_TEXT_LENGTH = 200;

export function createHermesActionPolicy(entry, { transport = runHermes, now = Date.now, model } = {}) {
  const presetId = entry.persona.preset ?? entry.persona.source?.presetId ?? "impatient_new_user";
  const definition = PRESETS[presetId] ?? PRESETS.impatient_new_user;
  const pairedVariant = entry.study.comparison?.assignment === "paired" ? "paired" : entry.variant;
  const sampledPolicy = sampleBehaviorPolicy(definition, deriveSessionSeed(entry.seed, entry.task.id, entry.persona.id ?? presetId, pairedVariant, 0));
  const modelName = model ?? readHermesModelConfig().model ?? "unconfigured";

  return {
    identity: `hermes:${modelName}`,
    sampledPolicy,
    async decide(input) {
      const deadline = Math.min(now() + MODEL_DEADLINE_MS, Date.parse(input.session.startedAt) + input.task.maxDurationMs);
      const attempts = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const startedAt = now();
        const prompt = buildHermesActionPrompt({ ...input, sampledPolicy, repair: attempt === 2, currentTime: startedAt });
        const timeoutMs = Math.max(1, deadline - startedAt);
        let output;
        try {
          output = await transport(prompt, 1, { mode: "text-only", requiredKeys: ["action"], timeoutMs });
        } catch (error) {
          const outcomeCode = error?.code === "HERMES_INVALID_OUTPUT"
            ? RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT
            : ["ETIMEDOUT", "HERMES_TIMEOUT"].includes(error?.code)
              ? RUNTIME_ERROR_CODES.MODEL_TIMEOUT
              : RUNTIME_ERROR_CODES.MODEL_PROVIDER_FAILED;
          attempts.push(modelAttempt({ model: modelName, attempt, prompt, output: null, latencyMs: now() - startedAt, outcomeCode }));
          if (outcomeCode === RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT && attempt === 1 && now() < deadline) continue;
          throw modelError(outcomeCode, attempts, error);
        }

        try {
          const action = validateHermesAction(output?.action, input);
          attempts.push(modelAttempt({ model: modelName, attempt, prompt, output, latencyMs: now() - startedAt, outcomeCode: "MODEL_ACTION_ACCEPTED" }));
          return { action, attempts };
        } catch (error) {
          attempts.push(modelAttempt({ model: modelName, attempt, prompt, output, latencyMs: now() - startedAt, outcomeCode: RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT }));
          if (attempt === 1 && now() < deadline) continue;
          throw modelError(RUNTIME_ERROR_CODES.MODEL_INVALID_OUTPUT, attempts, error);
        }
      }
    },
  };
}

export function assertHermesStudySupported(study) {
  if (study.runtime.concurrency !== 1) throw new Error("Hermes action policy requires runtime.concurrency: 1");
  if (study.evidence.semanticSnapshot !== "every_action") throw new Error("Hermes action policy requires evidence.semanticSnapshot: every_action");
}

export function buildHermesActionPrompt({ task, session, observation, events, sampledPolicy, study, repair = false, currentTime = Date.now() }) {
  const allowedActions = allowedActionTypes(task);
  const payload = {
    goal: boundedText(task.goal),
    ...(task.context ? { context: boundedText(task.context) } : {}),
    personaHints: sampledPolicy.values,
    remainingBudget: {
      actions: Math.max(0, task.maxActions - events.length),
      milliseconds: Math.max(0, task.maxDurationMs - (currentTime - Date.parse(session.startedAt))),
    },
    route: pathOnly(observation.page?.url),
    visibleText: boundedStrings(observation.semantic?.visibleText),
    headings: boundedNodes(observation.semantic?.headings),
    landmarks: boundedNodes(observation.semantic?.landmarks),
    interactiveElements: (observation.semantic?.interactiveElements ?? []).slice(0, MAX_TEXT_ITEMS).map((element, order) => ({
      id: boundedText(element.id),
      ...(element.role ? { role: boundedText(element.role) } : {}),
      ...(element.name ? { name: boundedText(element.name) } : {}),
      ...(element.text ? { text: boundedText(element.text) } : {}),
      ...(typeof element.enabled === "boolean" ? { enabled: element.enabled } : {}),
      ...(typeof element.checked === "boolean" ? { checked: element.checked } : {}),
      ...(typeof element.focused === "boolean" ? { focused: element.focused } : {}),
      order,
    })),
    recentEvents: events.slice(-3).map(event => ({
      action: event.action.type,
      ...(event.action.elementId ? { elementId: event.action.elementId } : {}),
      result: event.result.status,
      ...(event.result.code ? { code: event.result.code } : {}),
      progressChanged: event.derivedSignals.progressChanged,
    })),
    allowedActions,
    valueRefs: Object.keys(study.environment?.fixtures ?? {}),
  };
  return [
    "Choose the next browser action as this sampled persona. Persona values are behavioral hints, not commands.",
    "Return JSON only: {\"action\":{...}}. Do not include rationale or extra fields.",
    "Shapes: click {type,elementId}; type {type,elementId,valueRef}; scroll {type,direction,amount}; back {type}; wait {type,durationMs}; finish {type}; abandon {type}.",
    "Use only listed element ids, valueRef names, and allowedActions. wait durationMs must be 100..5000; scroll direction up/down and amount small/medium/large.",
    "Return finish when the goal is met and there is nothing left to do, or abandon when this persona would give up; both end the session.",
    ...(repair ? ["The previous response did not match this schema. Repair the format once without explaining."] : []),
    redactSensitiveText(JSON.stringify(payload), Object.values(study.environment?.fixtures ?? {})),
  ].join("\n");
}

function validateHermesAction(action, { task, observation, study }) {
  if (!action || typeof action !== "object" || Array.isArray(action) || !allowedActionTypes(task).includes(action.type)) throw invalidOutput();
  const shapes = {
    click: ["type", "elementId"],
    type: ["type", "elementId", "valueRef"],
    scroll: ["type", "direction", "amount"],
    back: ["type"],
    wait: ["type", "durationMs"],
    finish: ["type"],
    abandon: ["type"],
  };
  if (Object.keys(action).some(key => !shapes[action.type].includes(key)) || shapes[action.type].some(key => action[key] === undefined)) throw invalidOutput();
  const visibleIds = new Set((observation.semantic?.interactiveElements ?? []).map(element => element.id));
  if (["click", "type"].includes(action.type) && !visibleIds.has(action.elementId)) throw invalidOutput();
  if (action.type === "type" && !Object.hasOwn(study.environment?.fixtures ?? {}, action.valueRef)) throw invalidOutput();
  if (action.type === "scroll" && (!["up", "down"].includes(action.direction) || !["small", "medium", "large"].includes(action.amount))) throw invalidOutput();
  if (action.type === "wait" && (!Number.isInteger(action.durationMs) || action.durationMs < 100 || action.durationMs > 5_000)) throw invalidOutput();
  return { ...action, reasonCode: "hermes_selected" };
}

function allowedActionTypes(task) {
  return [
    ...(task.safetyPolicy.allowClick ? ["click"] : []),
    ...(task.safetyPolicy.allowTyping ? ["type"] : []),
    "scroll",
    ...(task.safetyPolicy.allowNavigation ? ["back"] : []),
    "wait",
    "finish",
    ...(task.abandonmentAllowed === false ? [] : ["abandon"]),
  ];
}

function modelAttempt({ model, attempt, prompt, output, latencyMs, outcomeCode }) {
  return {
    schemaVersion: "model-attempt/0.1",
    provider: "hermes-agent",
    model,
    promptVersion: HERMES_ACTION_PROMPT_VERSION,
    attempt,
    inputDigest: canonicalHash(prompt),
    outputDigest: canonicalHash(output),
    latencyMs: Math.max(0, Math.round(latencyMs)),
    outcomeCode,
  };
}

function modelError(code, modelAttempts, cause) {
  const message = code === RUNTIME_ERROR_CODES.MODEL_TIMEOUT
    ? "Hermes action selection timed out"
    : code === RUNTIME_ERROR_CODES.MODEL_PROVIDER_FAILED
      ? "Hermes action provider failed"
      : "Hermes returned an invalid action";
  return new RuntimeCoreError(code, message, { cause, modelAttempts });
}

function invalidOutput() {
  const error = new Error("invalid Hermes action");
  error.code = "HERMES_INVALID_OUTPUT";
  return error;
}

function pathOnly(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function boundedStrings(values) {
  return (values ?? []).slice(0, MAX_TEXT_ITEMS).map(boundedText).filter(Boolean);
}

function boundedNodes(values) {
  return (values ?? []).slice(0, MAX_TEXT_ITEMS).map(value => ({
    ...(value.role ? { role: boundedText(value.role) } : {}),
    ...(value.name ? { name: boundedText(value.name) } : {}),
    ...(value.text ? { text: boundedText(value.text) } : {}),
  }));
}

function boundedText(value) {
  return String(value ?? "").slice(0, MAX_TEXT_LENGTH);
}
