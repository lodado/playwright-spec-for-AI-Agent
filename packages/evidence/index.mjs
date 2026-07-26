import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_MANIFEST_VERSION,
  canonicalHash,
  validateContract,
} from "../contracts/index.mjs";

const REDACTION_RULES = Object.freeze([
  "authorization-bearer/0.1",
  "credential-key-value/0.1",
  "high-confidence-token/0.1",
  "sensitive-object-key/0.1",
  "supplied-value/0.1",
]);

const CREDENTIAL_PATTERN =
  /["']?\b(access[_-]?token|refresh[_-]?token|id[_-]?token|[a-z0-9_-]*token|session(?:[_-]?id)?|api[_-]?key|client[_-]?secret|password|passwd|secret)\b["']?(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}&]+)/gi;
const AUTHORIZATION_PATTERN = /(["']?\b(?:proxy[-_\s]?)?authorization\b["']?\s*(?::|=|,\s*))(?:(?:"[^"\r\n]*"|'[^'\r\n]*')|[^\r\n,\]}]+)/gi;
const COOKIE_PATTERN = /(["']?\b(?:set[-_\s]?)?cookie\b["']?\s*(?::|=|,\s*))(?:(?:"[^"\r\n]*"|'[^'\r\n]*')|[^\r\n,\]}]+)/gi;
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@]*@/gi;
const HIGH_CONFIDENCE_TOKEN_PATTERN = /\b(?:gh[pousr]_[a-z0-9]{20,}|npm_[a-z0-9]{20,}|sk-(?:proj-)?[a-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9a-z_-]{35}|xox[baprs]-[a-z0-9-]{10,}|eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})\b/gi;
const HIGH_ENTROPY_QUOTED_PATTERN = /(["'])([a-z0-9+\/_-]{40,}={0,2})\1/gi;
const BINARY_ARTIFACT_TYPES = new Set(["SCREENSHOT", "TRACE"]);
const MAX_ARCHIVE_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BLOB_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_CHECKPOINTS = 128;
const MAX_ARCHIVE_ARTIFACTS = 1024;
const MAX_ARCHIVE_JSON_DEPTH = 64;

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

export function redactSensitiveText(value, secrets = []) {
  if (typeof value !== "string") throw new TypeError("redacted value must be a string");
  return redactString(value, [...secrets].filter(Boolean).map(String)).value;
}

export function verifyStoredEvidence({ bundle, manifest, readBlob }) {
  if (typeof readBlob !== "function") throw new Error("stored evidence requires a readBlob function");
  const verified = verifyStoredEvidenceMetadata(bundle, manifest);

  const verifiedBlobs = new Map();
  for (const artifact of verified.bundle.artifacts) {
    const source = readBlob(artifact.storageRef);
    if (!(source instanceof Uint8Array)) throw new Error(`missing stored blob ${artifact.storageRef}`);
    const blob = Buffer.from(source);
    assertStoredBlob(artifact, blob);
    verifiedBlobs.set(artifact.storageRef, blob);
  }

  return Object.freeze({
    bundle: verified.bundle,
    manifest: verified.manifest,
    readBlob(storageRef) {
      const blob = verifiedBlobs.get(storageRef);
      return blob === undefined ? undefined : Buffer.from(blob);
    },
  });
}

export function writeEvidenceArchive(options = {}) {
  const key = archiveIntegrityKey(options?.integrityKey);
  try {
    return writeEvidenceArchiveWithKey(options, key);
  } finally {
    key.fill(0);
  }
}

function writeEvidenceArchiveWithKey({ directory, bundles, manifest, readBlob, secrets = [] } = {}, key) {
  // ponytail: archive roots must be private; use descriptor-based no-follow I/O for hostile shared filesystems.
  if (typeof directory !== "string" || directory.length === 0) throw new TypeError("evidence archive directory must be a non-empty string");
  if (!Array.isArray(bundles) || bundles.length === 0) throw new TypeError("evidence archive requires at least one bundle");
  if (bundles.length > MAX_ARCHIVE_CHECKPOINTS) throw new Error("evidence archive exceeds checkpoint count limit");
  const secretList = archiveSecrets(secrets);
  validateArchiveCheckpointCount(manifest);
  assertJsonDepth(manifest, "evidence archive manifest");
  for (const bundle of bundles) assertJsonDepth(bundle, "evidence archive bundle");
  const manifestSnapshot = jsonClone(manifest, "evidence archive manifest");
  const bundleSnapshots = bundles.map((bundle) => jsonClone(bundle, "evidence archive bundle"));
  validateArchiveLimits(bundleSnapshots, manifestSnapshot);
  validateArchiveSet(bundleSnapshots, manifestSnapshot);
  if (typeof readBlob !== "function") throw new Error("evidence archive requires a readBlob function");

  const blobs = new Map();
  const verifiedBundles = bundleSnapshots.map((bundle) => verifyStoredEvidenceMetadata(bundle, manifestSnapshot).bundle);
  for (const bundle of verifiedBundles) {
    assertSecretFreeJson("evidence bundle", bundle, secretList);
    for (const artifact of bundle.artifacts) {
      let blob = blobs.get(artifact.storageRef);
      if (blob === undefined) {
        const source = readBlob(artifact.storageRef);
        if (!(source instanceof Uint8Array)) throw new Error(`missing stored blob ${artifact.storageRef}`);
        blob = Buffer.from(source);
        blobs.set(artifact.storageRef, blob);
      }
      assertStoredBlob(artifact, blob);
      if (blob.byteLength > MAX_ARCHIVE_BLOB_BYTES) throw new Error(`evidence blob ${artifact.storageRef} exceeds archive size limit`);
      assertNoSecretBytes(`evidence blob ${artifact.storageRef}`, blob, secretList);
      assertNoHighConfidenceTokenBytes(`evidence blob ${artifact.storageRef}`, blob);
      if (isTextContentType(artifact.contentType)) assertSecretFreeText(`evidence blob ${artifact.storageRef}`, decodeUtf8(blob, artifact.storageRef), secretList);
    }
  }
  const totalBlobBytes = [...blobs.values()].reduce((sum, blob) => sum + blob.byteLength, 0);
  if (totalBlobBytes > MAX_ARCHIVE_TOTAL_BLOB_BYTES) throw new Error("evidence archive exceeds total blob size limit");
  const manifestJson = exactJson(manifestSnapshot);
  assertMetadataSize(manifestJson, "evidence manifest");
  assertSecretFreeJson("evidence manifest", manifestSnapshot, secretList);
  for (const bundle of verifiedBundles) assertMetadataSize(exactJson(bundle), `evidence bundle ${bundle.bundleId}`);

  const archivePath = resolve(directory);
  if (existsSync(archivePath)) throw new Error(`evidence archive already exists: ${archivePath}`);
  mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    mkdirSync(archivePath, { mode: 0o700 });
    created = true;
    mkdirSync(join(archivePath, "bundles"), { mode: 0o700 });
    mkdirSync(join(archivePath, "blobs"), { mode: 0o700 });
    for (const bundle of verifiedBundles) {
      writePrivateFile(join(archivePath, "bundles", `${hashFileName(bundle.bundleId, "bundle id")}.json`), exactJson(bundle));
    }
    for (const [storageRef, blob] of blobs) writePrivateFile(join(archivePath, "blobs", hashFileName(storageRef, "storage ref")), blob);
    writePrivateFile(join(archivePath, "evidence-manifest.json"), manifestJson);
    writePrivateFile(join(archivePath, "archive-auth"), archiveAuthentication(manifestSnapshot, key));
  } catch (error) {
    if (created) rmSync(archivePath, { recursive: true, force: true });
    throw error;
  }
}

export function readEvidenceArchive(options = {}) {
  const key = archiveIntegrityKey(options?.integrityKey);
  try {
    return readEvidenceArchiveWithKey(options, key);
  } finally {
    key.fill(0);
  }
}

function readEvidenceArchiveWithKey({ directory, secrets = [] } = {}, key) {
  if (typeof directory !== "string" || directory.length === 0) throw new TypeError("evidence archive directory must be a non-empty string");
  const secretList = archiveSecrets(secrets);
  const archivePath = resolve(directory);
  assertDirectory(archivePath, "evidence archive");
  assertEntries(archivePath, new Set(["archive-auth", "blobs", "bundles", "evidence-manifest.json"]), "evidence archive");
  assertDirectory(join(archivePath, "bundles"), "evidence bundle directory");
  assertDirectory(join(archivePath, "blobs"), "evidence blob directory");

  const manifestText = readPrivateFile(join(archivePath, "evidence-manifest.json"), MAX_ARCHIVE_METADATA_BYTES, "evidence manifest").toString("utf8");
  const manifest = parseJson(manifestText, "evidence manifest");
  assertJsonDepth(manifest, "evidence manifest");
  validateArchiveCheckpointCount(manifest);
  validateContract("EvidenceManifest", manifest);
  const authentication = readPrivateFile(join(archivePath, "archive-auth"), 128, "evidence archive authentication").toString("utf8");
  if (!authenticatedArchive(manifest, key, authentication)) throw new Error("evidence archive authentication failed");
  assertSecretFreeJson("evidence manifest", manifest, secretList);

  const expectedBundleFiles = new Set(manifest.checkpoints.map((checkpoint) => `${hashFileName(checkpoint.evidenceBundleId, "bundle id")}.json`));
  assertEntries(join(archivePath, "bundles"), expectedBundleFiles, "evidence bundle directory");
  let totalMetadataBytes = Buffer.byteLength(manifestText);
  for (const file of expectedBundleFiles) totalMetadataBytes += privateFileSize(join(archivePath, "bundles", file), MAX_ARCHIVE_METADATA_BYTES, "evidence bundle");
  if (totalMetadataBytes > MAX_ARCHIVE_TOTAL_METADATA_BYTES) throw new Error("evidence archive exceeds total metadata size limit");
  const bundles = manifest.checkpoints.map((checkpoint) => {
    const text = readPrivateFile(join(archivePath, "bundles", `${hashFileName(checkpoint.evidenceBundleId, "bundle id")}.json`), MAX_ARCHIVE_METADATA_BYTES, "evidence bundle").toString("utf8");
    const bundle = parseJson(text, "evidence bundle");
    assertJsonDepth(bundle, "evidence bundle");
    validateContract("EvidenceBundle", bundle);
    if (bundle.bundleId !== checkpoint.evidenceBundleId) throw new Error(`evidence bundle file does not match ${checkpoint.evidenceBundleId}`);
    assertSecretFreeJson("evidence bundle", bundle, secretList);
    return bundle;
  });
  validateArchiveLimits(bundles, manifest);
  validateArchiveSet(bundles, manifest);

  const expectedBlobFiles = new Set(bundles.flatMap((bundle) => bundle.artifacts.map((artifact) => hashFileName(artifact.storageRef, "storage ref"))));
  assertEntries(join(archivePath, "blobs"), expectedBlobFiles, "evidence blob directory");
  const rawBlobs = new Map();
  const loadBlob = (storageRef) => {
    if (!expectedBlobFiles.has(hashFileName(storageRef, "storage ref"))) return undefined;
    if (!rawBlobs.has(storageRef)) {
      rawBlobs.set(storageRef, readPrivateFile(join(archivePath, "blobs", hashFileName(storageRef, "storage ref")), MAX_ARCHIVE_BLOB_BYTES, "evidence blob"));
      if ([...rawBlobs.values()].reduce((sum, blob) => sum + blob.byteLength, 0) > MAX_ARCHIVE_TOTAL_BLOB_BYTES) throw new Error("evidence archive exceeds total blob size limit");
    }
    return rawBlobs.get(storageRef);
  };
  const verifiedBundles = [];
  for (const bundle of bundles) {
    const verified = verifyStoredEvidenceMetadata(bundle, manifest);
    verifiedBundles.push(verified.bundle);
    for (const artifact of verified.bundle.artifacts) {
      const blob = loadBlob(artifact.storageRef);
      assertStoredBlob(artifact, blob);
      assertNoSecretBytes(`evidence blob ${artifact.storageRef}`, blob, secretList);
      assertNoHighConfidenceTokenBytes(`evidence blob ${artifact.storageRef}`, blob);
      if (isTextContentType(artifact.contentType)) assertSecretFreeText(`evidence blob ${artifact.storageRef}`, decodeUtf8(blob, artifact.storageRef), secretList);
    }
  }

  return Object.freeze({
    bundles: deepFreeze(verifiedBundles),
    manifest: deepFreeze(structuredClone(manifest)),
    readBlob(storageRef) {
      const blob = rawBlobs.get(storageRef);
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

function verifyStoredEvidenceMetadata(bundle, manifest) {
  const bundleSnapshot = jsonClone(bundle, "stored evidence bundle");
  const manifestSnapshot = jsonClone(manifest, "stored evidence manifest");
  validateContract("EvidenceBundle", bundleSnapshot);
  validateContract("EvidenceManifest", manifestSnapshot);
  assertUnique(bundleSnapshot.artifacts.map((artifact) => artifact.id), "artifact id");
  assertUnique(bundleSnapshot.facts.map((fact) => fact.id), "fact id");
  assertKnownArtifactRefs(bundleSnapshot.facts, new Set(bundleSnapshot.artifacts.map((artifact) => artifact.id)));
  if (derivedBundleId(bundleSnapshot) !== bundleSnapshot.bundleId) throw new Error(`tampered evidence bundle id ${bundleSnapshot.bundleId}`);
  if (manifestSnapshot.runId !== bundleSnapshot.runId) throw new Error(`manifest runId ${manifestSnapshot.runId} does not match bundle runId ${bundleSnapshot.runId}`);
  const checkpoint = manifestSnapshot.checkpoints.find((entry) => entry.checkpointId === bundleSnapshot.checkpointId);
  if (!checkpoint || checkpoint.evidenceBundleId !== bundleSnapshot.bundleId || checkpoint.evidenceBundleHash !== exactHash(bundleSnapshot)) {
    throw new Error(`manifest checkpoint does not seal evidence bundle ${bundleSnapshot.bundleId}`);
  }
  return {
    bundle: deepFreeze(bundleSnapshot),
    manifest: deepFreeze(manifestSnapshot),
  };
}

function assertStoredBlob(artifact, blob) {
  if (!(blob instanceof Uint8Array)) throw new Error(`missing stored blob ${artifact.storageRef}`);
  if (artifact.storageRef !== artifact.contentHash || artifact.contentHash !== exactHash(blob) || artifact.size !== blob.byteLength) {
    throw new Error(`tampered stored blob ${artifact.storageRef}`);
  }
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
  let marker = ",\0QA_NATIVE_REDACTED\0";
  while (value.includes(marker)) marker += "\0";
  const protectedValue = protectSuppliedSecrets(value, secrets, marker);
  replacements += protectedValue.replacements;
  let redacted = protectedValue.value;
  redacted = redacted.replace(CREDENTIAL_PATTERN, (_, key, separator) => {
    replacements += 1;
    return `${key}${separator}${marker}`;
  });
  redacted = redacted.replace(AUTHORIZATION_PATTERN, (_, prefix) => {
    replacements += 1;
    return `${prefix}${marker}`;
  });
  redacted = redacted.replace(COOKIE_PATTERN, (_, prefix) => {
    replacements += 1;
    return `${prefix}${marker}`;
  });
  redacted = redacted.replace(URL_USERINFO_PATTERN, (_, scheme) => {
    replacements += 1;
    return `${scheme}${marker}@`;
  });
  redacted = redacted.replace(HIGH_CONFIDENCE_TOKEN_PATTERN, () => {
    replacements += 1;
    return marker;
  });
  redacted = redacted.replace(HIGH_ENTROPY_QUOTED_PATTERN, (_, quote) => {
    replacements += 1;
    return `${quote}${marker}${quote}`;
  });
  return { value: redacted.split(marker).join("[REDACTED]"), replacements };
}

function protectSuppliedSecrets(value, secrets, marker) {
  let offset = 0;
  let replacements = 0;
  let protectedValue = "";
  while (offset < value.length) {
    const redactionIndex = value.indexOf("[REDACTED]", offset);
    let secretIndex = -1;
    let secretLength = 0;
    for (const secret of secrets) {
      const index = value.indexOf(secret, offset);
      if (index !== -1 && (secretIndex === -1 || index < secretIndex || (index === secretIndex && secret.length > secretLength))) {
        secretIndex = index;
        secretLength = secret.length;
      }
    }
    if (secretIndex !== -1 && (redactionIndex === -1 || secretIndex <= redactionIndex)) {
      protectedValue += `${value.slice(offset, secretIndex)}${marker}`;
      offset = secretIndex + secretLength;
      replacements += 1;
    } else if (redactionIndex !== -1) {
      protectedValue += `${value.slice(offset, redactionIndex)}${marker}`;
      offset = redactionIndex + "[REDACTED]".length;
    } else {
      protectedValue += value.slice(offset);
      break;
    }
  }
  return { value: protectedValue, replacements };
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

function validateArchiveSet(bundles, manifest) {
  validateContract("EvidenceManifest", manifest);
  const expected = new Set(manifest.checkpoints.map((checkpoint) => checkpoint.evidenceBundleId));
  const actual = new Set(bundles.map((bundle) => bundle.bundleId));
  if (actual.size !== bundles.length) throw new Error("evidence archive contains duplicate bundles");
  if (expected.size !== manifest.checkpoints.length || expected.size !== actual.size || [...expected].some((bundleId) => !actual.has(bundleId))) {
    throw new Error("evidence archive bundles do not match manifest checkpoints");
  }
}

function validateArchiveLimits(bundles, manifest) {
  validateArchiveCheckpointCount(manifest);
  const artifactCount = bundles.reduce((sum, bundle) => sum + (Array.isArray(bundle?.artifacts) ? bundle.artifacts.length : 0), 0);
  if (artifactCount > MAX_ARCHIVE_ARTIFACTS) throw new Error("evidence archive exceeds artifact count limit");
  const metadataBytes = Buffer.byteLength(exactJson(manifest)) + bundles.reduce((sum, bundle) => sum + Buffer.byteLength(exactJson(bundle)), 0);
  if (metadataBytes > MAX_ARCHIVE_TOTAL_METADATA_BYTES) throw new Error("evidence archive exceeds total metadata size limit");
}

function validateArchiveCheckpointCount(manifest) {
  if (Array.isArray(manifest?.checkpoints) && manifest.checkpoints.length > MAX_ARCHIVE_CHECKPOINTS) throw new Error("evidence archive exceeds checkpoint count limit");
}

function hashFileName(value, label) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  if (!match) throw new Error(`${label} must be a sha256 content hash`);
  return match[1];
}

function assertSecretFreeText(label, value, secrets) {
  if (redactSensitiveText(value, secrets) !== value) throw new Error(`${label} contains sensitive data`);
}

function assertSecretFreeJson(label, value, secrets) {
  if (exactJson(redact(value, secrets).value) !== exactJson(value)) throw new Error(`${label} contains sensitive data`);
}

function assertNoSecretBytes(label, value, secrets) {
  for (const secret of secrets) if (value.indexOf(Buffer.from(secret)) !== -1) throw new Error(`${label} contains sensitive data`);
}

function assertNoHighConfidenceTokenBytes(label, value) {
  // ponytail: raw-byte checks complement the required binary redactor; add OCR/archive inspection when those artifacts are enabled.
  const text = value.toString("latin1");
  if (new RegExp(HIGH_CONFIDENCE_TOKEN_PATTERN.source, "i").test(text) || new RegExp(HIGH_ENTROPY_QUOTED_PATTERN.source, "i").test(text)) {
    throw new Error(`${label} contains sensitive data`);
  }
}

function archiveSecrets(secrets) {
  if (!Array.isArray(secrets)) throw new TypeError("evidence archive secrets must be an array");
  const normalized = secrets.filter(Boolean).map(String);
  if (normalized.includes("[REDACTED]")) throw new TypeError("evidence archive secret cannot equal the redaction marker");
  return Object.freeze(normalized);
}

function archiveIntegrityKey(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("evidence archive integrityKey must contain at least 32 bytes");
  const key = Buffer.from(value);
  if (key.byteLength < 32) {
    key.fill(0);
    throw new TypeError("evidence archive integrityKey must contain at least 32 bytes");
  }
  return key;
}

function archiveAuthentication(manifest, key) {
  return `hmac-sha256:${createHmac("sha256", key).update(exactJson(manifest)).digest("hex")}`;
}

function authenticatedArchive(manifest, key, actual) {
  const expected = Buffer.from(archiveAuthentication(manifest, key));
  const supplied = Buffer.from(actual);
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function assertMetadataSize(value, label) {
  if (Buffer.byteLength(value) > MAX_ARCHIVE_METADATA_BYTES) throw new Error(`${label} exceeds archive size limit`);
}

function decodeUtf8(value, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`evidence blob ${label} is not valid UTF-8 text`);
  }
}

function writePrivateFile(path, value) {
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}

function readPrivateFile(path, maxBytes, label) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds archive size limit`);
  return readFileSync(path);
}

function privateFileSize(path, maxBytes, label) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds archive size limit`);
  return stat.size;
}

function assertDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
}

function assertEntries(path, expected, label) {
  const actual = readdirSync(path);
  if (actual.length !== expected.size || actual.some((entry) => !expected.has(entry))) throw new Error(`${label} contains unexpected entries`);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function assertJsonDepth(value, label) {
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current.value || typeof current.value !== "object") continue;
    if (current.depth > MAX_ARCHIVE_JSON_DEPTH) throw new Error(`${label} exceeds JSON nesting depth limit`);
    if (seen.has(current.value)) throw new Error(`${label} contains repeated object references`);
    seen.add(current.value);
    for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
  }
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
