import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { basename, join, relative } from "node:path";
import { RUN_ENVELOPE_VERSION, validateContract } from "../contracts/index.mjs";
import { readPrivateJson, writePrivateJsonExclusive } from "./qa-native.mjs";

export function writeAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey, ...bindings }) {
  const body = runEnvelopeBody(bindings);
  if (body.runId !== basename(runDirectory)) throw new Error("run envelope does not match its directory");
  const envelope = validateContract("RunEnvelope", { ...body, authentication: authenticate(body, integrityKey) });
  writePrivateJsonExclusive(relative(cwd, join(runDirectory, "run-envelope.json")), envelope, { cwd });
  return envelope;
}

export function readAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey }) {
  const envelope = readPrivateJson(relative(cwd, join(runDirectory, "run-envelope.json")), { cwd });
  validateContract("RunEnvelope", envelope);
  const { authentication, ...body } = envelope;
  if (body.runId !== basename(runDirectory) || !authenticated(body, integrityKey, authentication)) throw new Error("run envelope authentication failed");
  return envelope;
}

export function verifyRunEnvelopeBindings({ envelope, ...bindings }) {
  validateContract("RunEnvelope", envelope);
  const { authentication: _authentication, ...body } = envelope;
  if (exactHash(body) !== exactHash(runEnvelopeBody(bindings))) throw new Error("run envelope bindings do not match persisted artifacts");
  return envelope;
}

function runEnvelopeBody({ runId, mode, qaIr, runtimeOutcome, evidenceManifest, executionPlan, executionAgentInputs, executionAgentOutcomes }) {
  validateContract("QaIrDocument", qaIr);
  validateContract("RuntimeOutcome", runtimeOutcome);
  validateContract("EvidenceManifest", evidenceManifest);
  if (typeof runId !== "string" || runId.length === 0 || evidenceManifest.runId !== runId) throw new Error("run envelope input is invalid");
  const common = {
    schemaVersion: RUN_ENVELOPE_VERSION,
    runId,
    mode,
    qaIrHash: exactHash(qaIr),
    runtimeOutcomeHash: exactHash(runtimeOutcome),
    evidenceManifestHash: exactHash(evidenceManifest),
  };
  if (mode === "strict") {
    validateContract("ExecutionPlan", executionPlan);
    return { ...common, executionPlanHash: exactHash(executionPlan) };
  }
  if (mode === "adaptive") {
    if (!Array.isArray(executionAgentInputs) || executionAgentInputs.length === 0 || !Array.isArray(executionAgentOutcomes) || executionAgentOutcomes.length !== executionAgentInputs.length) throw new Error("run envelope input is invalid");
    executionAgentInputs.forEach((executionAgentInput, index) => {
      validateContract("ExecutionAgentInput", executionAgentInput);
      validateContract("ExecutionAgentOutcome", executionAgentOutcomes[index], { input: executionAgentInput });
      if (executionAgentInput.runId !== runId || executionAgentOutcomes[index].runId !== runId) throw new Error("run envelope input is invalid");
    });
    return { ...common, executionAgentInputsHash: exactHash(executionAgentInputs), executionAgentOutcomesHash: exactHash(executionAgentOutcomes) };
  }
  throw new Error("run envelope mode is invalid");
}

function authenticate(body, integrityKey) {
  const key = integrityKeySnapshot(integrityKey);
  try {
    return `hmac-sha256:${createHmac("sha256", key).update(exactJson(body)).digest("hex")}`;
  } finally {
    key.fill(0);
  }
}

function authenticated(body, integrityKey, actual) {
  const expected = Buffer.from(authenticate(body, integrityKey));
  const supplied = Buffer.from(actual);
  return expected.byteLength === supplied.byteLength && timingSafeEqual(expected, supplied);
}

function integrityKeySnapshot(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 32) throw new TypeError("run envelope integrityKey must contain at least 32 bytes");
  return Buffer.from(value);
}

function exactHash(value) {
  return `sha256:${createHash("sha256").update(exactJson(value)).digest("hex")}`;
}

function exactJson(value) {
  return JSON.stringify(sortJson(JSON.parse(JSON.stringify(value))));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}
