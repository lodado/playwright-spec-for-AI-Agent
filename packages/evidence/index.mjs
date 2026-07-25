import { createHash } from "node:crypto";
import {
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_MANIFEST_VERSION,
  canonicalHash,
  validateContract,
} from "../contracts/index.mjs";

const REDACTION_RULES = Object.freeze([
  "authorization-bearer/0.1",
  "credential-key-value/0.1",
  "sensitive-object-key/0.1",
  "supplied-value/0.1",
]);

const CREDENTIAL_PATTERN =
  /["']?\b(access[_-]?token|refresh[_-]?token|id[_-]?token|session(?:[_-]?id)?|token|api[_-]?key|client[_-]?secret|password|passwd|secret)\b["']?(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}&]+)/gi;
const AUTHORIZATION_PATTERN = /(["']?\b(?:proxy[-_\s]?)?authorization\b["']?\s*(?::|=|,\s*))(?:(?:"[^"\r\n]*"|'[^'\r\n]*')|[^\r\n,\]}]+)/gi;
const COOKIE_PATTERN = /(["']?\b(?:set[-_\s]?)?cookie\b["']?\s*(?::|=|,\s*))(?:(?:"[^"\r\n]*"|'[^'\r\n]*')|[^\r\n,\]}]+)/gi;
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@]*@/gi;
const BINARY_ARTIFACT_TYPES = new Set(["SCREENSHOT", "TRACE"]);

export function createInMemoryEvidenceStore({
  providerCapabilities,
  producer = { name: "evidence-store", version: "0.1.0" },
  secrets = [],
  binaryRedactor,
} = {}) {
  const capabilities = deepFreeze(
    validateContract("ProviderCapabilities", structuredClone(providerCapabilities)),
  );
  const secretList = Object.freeze([...secrets].filter(Boolean).map(String));
  const producerRedaction = redact(jsonClone(producer, "producer"), secretList);
  const producerSnapshot = deepFreeze(producerRedaction.value);
  validateProducer(producerSnapshot);
  const blobs = new Map();
  const capturedArtifacts = new WeakMap();
  const bundles = new Map();
  const manifests = new Map();

  function captureArtifact({ id, type, contentType, content }) {
    assertProviderEvidence(capabilities, type);
    const idRedaction = redactRequiredString(id, "artifact id", secretList);
    const contentTypeRedaction = redactRequiredString(
      normalizeContentType(contentType),
      "artifact contentType",
      secretList,
    );
    const captured = prepareArtifactContent(
      type,
      contentTypeRedaction.value,
      content,
      secretList,
      binaryRedactor,
    );
    const contentHash = exactHash(captured.bytes);
    const artifact = deepFreeze(
      validateContract("EvidenceBundle", {
        schemaVersion: EVIDENCE_BUNDLE_VERSION,
        bundleId: "capture-validation",
        runId: "capture-validation",
        scenarioId: "capture-validation",
        checkpointId: "capture-validation",
        capturedAt: "capture-validation",
        environment: {
          targetUrl: "about:blank",
          browser: "capture-validation",
          viewport: { width: 0, height: 0 },
        },
        artifacts: [{
          id: idRedaction.value,
          type,
          contentType: contentTypeRedaction.value,
          contentHash,
          size: captured.bytes.byteLength,
          storageRef: contentHash,
        }],
        facts: [],
        redaction: { rules: [], replacements: 0 },
      }).artifacts[0],
    );

    if (!blobs.has(contentHash)) blobs.set(contentHash, Buffer.from(captured.bytes));
    capturedArtifacts.set(artifact, {
      artifactHash: exactHash(artifact),
      replacements: idRedaction.replacements + contentTypeRedaction.replacements + captured.replacements,
    });
    return artifact;
  }

  function createBundle(fields) {
    if (fields.bundleId !== undefined) throw new Error("bundleId is derived from evidence content");

    const artifactsWithMetadata = (fields.artifacts ?? []).map((artifact) => {
      assertProviderEvidence(capabilities, artifact.type);
      const metadata = capturedArtifacts.get(artifact);
      if (!metadata || metadata.artifactHash !== exactHash(artifact)) {
        throw new Error(`unknown captured artifact ${artifact.id}`);
      }
      const blob = blobs.get(artifact.storageRef);
      if (
        blob === undefined ||
        artifact.storageRef !== artifact.contentHash ||
        artifact.contentHash !== exactHash(blob) ||
        artifact.size !== blob.byteLength
      ) {
        throw new Error(`tampered artifact ${artifact.id}`);
      }
      return { artifact: structuredClone(artifact), replacements: metadata.replacements };
    });
    const artifacts = artifactsWithMetadata.map(({ artifact }) => artifact);
    assertUnique(artifacts.map((artifact) => artifact.id), "artifact id");

    const factsWithRedactions = (fields.facts ?? []).map((fact) => redact(jsonClone(fact, "fact"), secretList));
    const facts = factsWithRedactions.map(({ value }) => value);
    assertUnique(facts.map((fact) => fact.id), "fact id");
    assertKnownArtifactRefs(facts, new Set(artifacts.map((artifact) => artifact.id)));

    const environment = redact(jsonClone(fields.environment, "environment"), secretList);
    const identityFields = ["runId", "scenarioId", "checkpointId", "capturedAt"].map((key) => {
      const value = fields[key] ?? (key === "capturedAt" ? new Date().toISOString() : undefined);
      return [key, redactRequiredString(value, key, secretList)];
    });
    const identities = Object.fromEntries(identityFields.map(([key, item]) => [key, item.value]));
    const replacements =
      producerRedaction.replacements +
      environment.replacements +
      identityFields.reduce((sum, [, item]) => sum + item.replacements, 0) +
      artifactsWithMetadata.reduce((sum, item) => sum + item.replacements, 0) +
      factsWithRedactions.reduce((sum, item) => sum + item.replacements, 0);
    const body = {
      schemaVersion: EVIDENCE_BUNDLE_VERSION,
      ...identities,
      environment: environment.value,
      artifacts,
      facts,
      redaction: { rules: [...REDACTION_RULES], replacements },
    };
    const bundle = deepFreeze(
      validateContract("EvidenceBundle", {
        ...body,
        bundleId: exactHash(body),
      }),
    );
    bundles.set(bundle.bundleId, { hash: exactHash(bundle), value: bundle });
    return bundle;
  }

  function appendCheckpoint(bundle, { stage = "evidence", manifest: suppliedManifest } = {}) {
    const bundleSnapshot = jsonClone(bundle, "evidence bundle");
    const bundleHash = validateBundleIntegrity(bundleSnapshot, blobs, bundles);
    const current = manifests.get(bundleSnapshot.runId);
    if (suppliedManifest !== undefined) {
      const suppliedManifestSnapshot = jsonClone(suppliedManifest, "evidence manifest");
      validateContract("EvidenceManifest", suppliedManifestSnapshot);
      if (!current || exactHash(suppliedManifestSnapshot) !== exactHash(current)) {
        throw new Error(`manifest for run ${bundleSnapshot.runId} is not current store state`);
      }
    }
    const checkpoint = {
      checkpointId: bundleSnapshot.checkpointId,
      stage,
      evidenceBundleId: bundleSnapshot.bundleId,
      evidenceBundleHash: bundleHash,
      sealed: true,
      producer: structuredClone(producerSnapshot),
    };
    checkpoint.contentHash = canonicalHash(checkpoint);

    if (current?.checkpoints.some((entry) => entry.checkpointId === checkpoint.checkpointId)) {
      throw new Error(`duplicate checkpoint id ${checkpoint.checkpointId}`);
    }
    const next = deepFreeze(
      validateContract("EvidenceManifest", {
        schemaVersion: EVIDENCE_MANIFEST_VERSION,
        runId: bundleSnapshot.runId,
        checkpoints: [...(current?.checkpoints ?? []), checkpoint],
      }),
    );
    manifests.set(bundleSnapshot.runId, next);
    return next;
  }

  function readBlob(storageRef) {
    const blob = blobs.get(storageRef);
    return blob === undefined ? undefined : Buffer.from(blob);
  }

  function readBundle(bundleId) {
    const bundle = bundles.get(bundleId)?.value;
    return bundle === undefined ? undefined : deepFreeze(structuredClone(bundle));
  }

  function readManifest(runId) {
    const manifest = manifests.get(runId);
    return manifest === undefined ? undefined : deepFreeze(structuredClone(manifest));
  }

  return {
    appendCheckpoint,
    blobCount: () => blobs.size,
    captureArtifact,
    createBundle,
    readBlob,
    readBundle,
    readManifest,
  };
}

export function verifyStoredEvidence({ bundle, manifest, readBlob }) {
  if (typeof readBlob !== "function") throw new Error("stored evidence requires a readBlob function");
  const bundleSnapshot = jsonClone(bundle, "stored evidence bundle");
  const manifestSnapshot = jsonClone(manifest, "stored evidence manifest");
  validateContract("EvidenceBundle", bundleSnapshot);
  validateContract("EvidenceManifest", manifestSnapshot);
  assertUnique(bundleSnapshot.artifacts.map((artifact) => artifact.id), "artifact id");
  assertUnique(bundleSnapshot.facts.map((fact) => fact.id), "fact id");
  assertKnownArtifactRefs(
    bundleSnapshot.facts,
    new Set(bundleSnapshot.artifacts.map((artifact) => artifact.id)),
  );

  if (derivedBundleId(bundleSnapshot) !== bundleSnapshot.bundleId) {
    throw new Error(`tampered evidence bundle id ${bundleSnapshot.bundleId}`);
  }
  if (manifestSnapshot.runId !== bundleSnapshot.runId) {
    throw new Error(`manifest runId ${manifestSnapshot.runId} does not match bundle runId ${bundleSnapshot.runId}`);
  }
  const bundleHash = exactHash(bundleSnapshot);
  const checkpoint = manifestSnapshot.checkpoints.find(
    (entry) => entry.checkpointId === bundleSnapshot.checkpointId,
  );
  if (
    !checkpoint ||
    checkpoint.evidenceBundleId !== bundleSnapshot.bundleId ||
    checkpoint.evidenceBundleHash !== bundleHash
  ) {
    throw new Error(`manifest checkpoint does not seal evidence bundle ${bundleSnapshot.bundleId}`);
  }

  const verifiedBlobs = new Map();
  for (const artifact of bundleSnapshot.artifacts) {
    const source = readBlob(artifact.storageRef);
    if (!(source instanceof Uint8Array)) throw new Error(`missing stored blob ${artifact.storageRef}`);
    const blob = Buffer.from(source);
    if (
      artifact.storageRef !== artifact.contentHash ||
      artifact.contentHash !== exactHash(blob) ||
      artifact.size !== blob.byteLength
    ) {
      throw new Error(`tampered stored blob ${artifact.storageRef}`);
    }
    verifiedBlobs.set(artifact.storageRef, blob);
  }

  return Object.freeze({
    bundle: deepFreeze(bundleSnapshot),
    manifest: deepFreeze(manifestSnapshot),
    readBlob(storageRef) {
      const blob = verifiedBlobs.get(storageRef);
      return blob === undefined ? undefined : Buffer.from(blob);
    },
  });
}

function prepareArtifactContent(type, contentType, content, secrets, binaryRedactor) {
  const binaryType = BINARY_ARTIFACT_TYPES.has(type);
  if (binaryType) {
    if (typeof binaryRedactor !== "function") {
      throw new Error(`${type} opaque binary evidence requires a trusted redactor`);
    }
    if (type === "SCREENSHOT" && !/^image\//i.test(contentType)) {
      throw new Error("SCREENSHOT requires an image contentType");
    }
    if (!(content instanceof Uint8Array)) throw new Error(`${type} binary evidence must be bytes`);
    const result = binaryRedactor({ type, contentType, content: Buffer.from(content) });
    if (
      !result ||
      !(result.content instanceof Uint8Array) ||
      !Number.isSafeInteger(result.replacements) ||
      result.replacements < 0
    ) {
      throw new Error("trusted binary redactor must return { content: Uint8Array, replacements: non-negative integer }");
    }
    return { bytes: Buffer.from(result.content), replacements: result.replacements };
  }
  if (!isTextContentType(contentType)) {
    throw new Error(`${type} requires a textual contentType`);
  }
  let value = content;
  if (content instanceof Uint8Array) {
    if (!isTextContentType(contentType)) {
      throw new Error(`${type} opaque binary evidence requires a trusted redactor`);
    }
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error(`${type} evidence is not valid UTF-8 text`);
    }
  }
  if (isJsonContentType(contentType)) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error(`${type} application/json evidence must contain valid JSON`);
      }
    }
    const redacted = redact(jsonClone(value, `${type} JSON evidence`), secrets);
    return { bytes: Buffer.from(exactJson(redacted.value)), replacements: redacted.replacements };
  }
  if (typeof value !== "string") throw new Error(`${type} ${contentType} evidence must be text`);
  const redacted = redactString(value, secrets);
  return { bytes: Buffer.from(redacted.value), replacements: redacted.replacements };
}

function validateBundleIntegrity(bundle, blobs, bundles) {
  validateContract("EvidenceBundle", bundle);
  const bundleHash = exactHash(bundle);
  if (derivedBundleId(bundle) !== bundle.bundleId || bundles.get(bundle.bundleId)?.hash !== bundleHash) {
    throw new Error(`unknown evidence bundle ${bundle.bundleId}`);
  }
  assertUnique(bundle.artifacts.map((artifact) => artifact.id), "artifact id");
  assertUnique(bundle.facts.map((fact) => fact.id), "fact id");
  assertKnownArtifactRefs(bundle.facts, new Set(bundle.artifacts.map((artifact) => artifact.id)));
  for (const artifact of bundle.artifacts) {
    const blob = blobs.get(artifact.storageRef);
    if (
      blob === undefined ||
      artifact.storageRef !== artifact.contentHash ||
      artifact.contentHash !== exactHash(blob) ||
      artifact.size !== blob.byteLength
    ) {
      throw new Error(`tampered artifact ${artifact.id}`);
    }
  }
  return bundleHash;
}

function assertProviderEvidence(capabilities, type) {
  if (capabilities.unsupportedEvidence?.includes(type) || !capabilities.evidence.includes(type)) {
    throw new Error(`${type} requires provider evidence capability`);
  }
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label} ${value}`);
    seen.add(value);
  }
}

function assertKnownArtifactRefs(facts, artifactIds) {
  for (const ref of facts.flatMap((fact) => artifactRefs(fact.value))) {
    if (!artifactIds.has(ref)) throw new Error(`unknown artifact ref ${ref}`);
  }
}

function artifactRefs(value) {
  if (Array.isArray(value)) return value.flatMap(artifactRefs);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (["artifactRef", "artifactId", "evidenceRef"].includes(key) && typeof child === "string") return [child];
    if (["artifactRefs", "artifactIds", "evidenceRefs"].includes(key) && Array.isArray(child)) {
      return child.filter((item) => typeof item === "string");
    }
    return artifactRefs(child);
  });
}

function redact(value, secrets) {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) {
    if (typeof value[0] === "string" && isSensitiveKey(value[0]) && value.length > 1) {
      const tail = value.slice(2).map((item) => redact(item, secrets));
      return {
        value: [value[0], "[REDACTED]", ...tail.map((item) => item.value)],
        replacements: 1 + sumReplacements(tail),
      };
    }
    const items = value.map((item) => redact(item, secrets));
    return { value: items.map((item) => item.value), replacements: sumReplacements(items) };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? redactCredentialValue(child) : redact(child, secrets),
    ]);
    return {
      value: Object.fromEntries(entries.map(([key, child]) => [key, child.value])),
      replacements: sumReplacements(entries.map(([, child]) => child)),
    };
  }
  return { value, replacements: 0 };
}

function isSensitiveKey(key) {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return ["authorization", "cookie", "token", "password", "passwd", "secret", "apikey", "session", "sessionid"].some((suffix) =>
      normalized.endsWith(suffix),
  );
}

function validateProducer(producer) {
  if (
    !producer ||
    typeof producer !== "object" ||
    Array.isArray(producer) ||
    Object.keys(producer).some((key) => !["name", "version"].includes(key)) ||
    typeof producer.name !== "string" ||
    typeof producer.version !== "string"
  ) {
    throw new Error("producer must contain only string name and version fields");
  }
}

function redactCredentialValue(value) {
  if (value === undefined || value === null) return { value, replacements: 0 };
  return { value: "[REDACTED]", replacements: 1 };
}

function redactString(value, secrets) {
  let replacements = 0;
  let redacted = value;
  for (const secret of secrets) {
    const parts = redacted.split(secret);
    replacements += parts.length - 1;
    redacted = parts.join("[REDACTED]");
  }
  redacted = redacted.replace(CREDENTIAL_PATTERN, (_, key, separator) => {
    replacements += 1;
    return `${key}${separator}[REDACTED]`;
  });
  redacted = redacted.replace(AUTHORIZATION_PATTERN, (_, prefix) => {
    replacements += 1;
    return `${prefix}[REDACTED]`;
  });
  redacted = redacted.replace(COOKIE_PATTERN, (_, prefix) => {
    replacements += 1;
    return `${prefix}[REDACTED]`;
  });
  redacted = redacted.replace(URL_USERINFO_PATTERN, (_, scheme) => {
    replacements += 1;
    return `${scheme}[REDACTED]@`;
  });
  return { value: redacted, replacements };
}

function redactRequiredString(value, label, secrets) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return redactString(value, secrets);
}

function normalizeContentType(value) {
  if (typeof value !== "string") throw new Error("artifact contentType must be a string");
  const normalized = value.trim();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]+)?$/i.test(normalized)) {
    throw new Error(`invalid artifact contentType ${value}`);
  }
  return normalized;
}

function sumReplacements(items) {
  return items.reduce((sum, item) => sum + item.replacements, 0);
}

function jsonClone(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable`);
  return JSON.parse(serialized);
}

function exactJson(value) {
  return JSON.stringify(sortJson(jsonClone(value, "evidence value")));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function exactHash(value) {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(exactJson(value));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function derivedBundleId(bundle) {
  const { bundleId: _bundleId, ...body } = bundle;
  return exactHash(body);
}

function isJsonContentType(contentType) {
  return /^(application\/json\b|[^;]+\+json\b)/i.test(contentType);
}

function isTextContentType(contentType) {
  return /^text\//i.test(contentType) ||
    isJsonContentType(contentType) ||
    /\b(?:xml|javascript)\b/i.test(contentType) ||
    /^application\/x-ndjson\b/i.test(contentType);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
