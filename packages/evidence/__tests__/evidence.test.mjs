import { describe, expect, it } from "vitest";
import {
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_MANIFEST_VERSION,
  PROVIDER_CAPABILITIES_VERSION,
  validateContract,
} from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore, verifyStoredEvidence } from "../index.mjs";

const providerCapabilities = {
  schemaVersion: PROVIDER_CAPABILITIES_VERSION,
  providerId: "test-provider",
  actions: [],
  evidence: ["VISIBLE_TEXT", "JSON_FACT"],
};

const environment = {
  targetUrl: "https://example.test/dashboard",
  browser: "chromium",
  viewport: { width: 1280, height: 720 },
  locale: "en-US",
  timezone: "UTC",
};

function store(options = {}) {
  return createInMemoryEvidenceStore({
    providerCapabilities,
    secrets: ["supplied-secret"],
    ...options,
  });
}

function visibleText(target = store(), overrides = {}) {
  return target.captureArtifact({
    id: "artifact-visible-text",
    type: "VISIBLE_TEXT",
    contentType: "text/plain",
    content: "Authorization: Bearer bearer-secret token=abc123 supplied-secret Dashboard",
    ...overrides,
  });
}

function bundle(target = store(), overrides = {}) {
  const artifact = visibleText(target);
  return target.createBundle({
    runId: "run-1",
    scenarioId: "scenario-1",
    checkpointId: "checkpoint-1",
    capturedAt: "2026-07-25T00:00:00.000Z",
    environment,
    artifacts: [artifact],
    facts: [{ id: "fact-url", kind: "URL", value: "https://example.test?api_key=json-secret" }],
    ...overrides,
  });
}

describe("evidence store", () => {
  it("redacts secrets before blob, bundle, and manifest storage", () => {
    const target = store();
    const artifact = visibleText(target);
    const evidenceBundle = target.createBundle({
      runId: "run-1",
      scenarioId: "scenario-1",
      checkpointId: "checkpoint-1",
      capturedAt: "2026-07-25T00:00:00.000Z",
      environment,
      artifacts: [artifact],
      facts: [
        {
          id: "fact-json",
          kind: "JSON",
          value: { nested: { password: "letmein", artifactRef: artifact.id } },
        },
      ],
    });
    const manifest = target.appendCheckpoint(evidenceBundle);

    const serialized = [
      target.readBlob(artifact.storageRef).toString("utf8"),
      JSON.stringify(evidenceBundle),
      JSON.stringify(manifest),
    ].join("\n");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("supplied-secret");
    expect(serialized).not.toContain("letmein");
    expect(evidenceBundle.redaction.replacements).toBeGreaterThanOrEqual(4);
  });

  it("dedupes content-addressed blobs and exposes read/count", () => {
    const target = store();
    const first = visibleText(target, { id: "a" });
    const second = visibleText(target, { id: "b" });

    expect(first.contentHash).toBe(second.contentHash);
    expect(first.storageRef).toBe(second.storageRef);
    expect(target.blobCount()).toBe(1);
    expect(target.readBlob(first.storageRef).toString("utf8")).toContain("[REDACTED]");
  });

  it("returns validated deep-frozen EvidenceBundle values", () => {
    const target = store();
    const evidenceBundle = bundle(target);

    expect(validateContract("EvidenceBundle", evidenceBundle)).toBe(evidenceBundle);
    expect(evidenceBundle.schemaVersion).toBe(EVIDENCE_BUNDLE_VERSION);
    expect(Object.isFrozen(evidenceBundle)).toBe(true);
    expect(Object.isFrozen(evidenceBundle.artifacts[0])).toBe(true);
    expect(() => {
      evidenceBundle.artifacts[0].id = "mutated";
    }).toThrow();
  });

  it("appends validated multi-checkpoint manifests with self-verifying hashes", () => {
    const target = store();
    const first = bundle(target, { checkpointId: "checkpoint-1" });
    const second = bundle(target, { checkpointId: "checkpoint-2" });

    target.appendCheckpoint(first, { stage: "execute" });
    const manifest = target.appendCheckpoint(second, { stage: "evidence" });

    expect(validateContract("EvidenceManifest", manifest)).toBe(manifest);
    expect(manifest.schemaVersion).toBe(EVIDENCE_MANIFEST_VERSION);
    expect(manifest.checkpoints).toHaveLength(2);
    expect(Object.isFrozen(manifest.checkpoints[0])).toBe(true);
  });

  it("rejects duplicate checkpoint ids, duplicate artifact/fact ids, unknown refs, tamper, and missing provider capability", () => {
    const target = store();
    const evidenceBundle = bundle(target);
    const manifest = target.appendCheckpoint(evidenceBundle);
    const duplicateArtifact = visibleText(target, { id: "duplicate" });

    expect(() => target.appendCheckpoint(evidenceBundle)).toThrow(/duplicate/);
    expect(() =>
      bundle(target, { artifacts: [duplicateArtifact, duplicateArtifact] }),
    ).toThrow(/duplicate artifact id/);
    expect(() =>
      bundle(target, {
        facts: [
          { id: "fact-1", kind: "JSON", value: { artifactRef: "missing" } },
          { id: "fact-1", kind: "JSON", value: { ok: true } },
        ],
      }),
    ).toThrow(/duplicate fact id/);
    expect(() =>
      bundle(target, { facts: [{ id: "fact-1", kind: "JSON", value: { artifactRef: "missing" } }] }),
    ).toThrow(/unknown artifact ref/);
    expect(() =>
      bundle(target, {
        artifacts: [{ ...evidenceBundle.artifacts[0], size: evidenceBundle.artifacts[0].size + 1 }],
      }),
    ).toThrow(/unknown captured artifact/);
    expect(() =>
      target.appendCheckpoint(bundle(target, { checkpointId: "checkpoint-2" }), {
        manifest: {
          ...manifest,
          checkpoints: [{ ...manifest.checkpoints[0], contentHash: "sha256:tampered" }],
        },
      }),
    ).toThrow(/must equal/);
    expect(() =>
      store({
        providerCapabilities: {
          ...providerCapabilities,
          evidence: [],
          unsupportedEvidence: ["VISIBLE_TEXT"],
        },
      }).captureArtifact({
        id: "blocked",
        type: "VISIBLE_TEXT",
        contentType: "text/plain",
        content: "blocked",
      }),
    ).toThrow(/provider evidence capability/);
  });

  it("hashes exact stored bytes, isolates caller mutations, and rejects foreign run/bundle state", () => {
    const secrets = ["buffer-secret"];
    const mutableCapabilities = {
      ...providerCapabilities,
      evidence: ["VISIBLE_TEXT"],
    };
    const target = createInMemoryEvidenceStore({ providerCapabilities: mutableCapabilities, secrets });
    mutableCapabilities.evidence.length = 0;
    secrets.length = 0;

    const bufferArtifact = target.captureArtifact({
      id: "buffer",
      type: "VISIBLE_TEXT",
      contentType: "text/plain",
      content: Buffer.from("Authorization: Bearer buffer-secret"),
    });
    expect(target.readBlob(bufferArtifact.storageRef).toString("utf8")).not.toContain("buffer-secret");

    const first = target.captureArtifact({
      id: "timestamp-a",
      type: "VISIBLE_TEXT",
      contentType: "application/json",
      content: { message: "same", timestamp: "A" },
    });
    const second = target.captureArtifact({
      id: "timestamp-b",
      type: "VISIBLE_TEXT",
      contentType: "application/json",
      content: { message: "same", timestamp: "B" },
    });
    expect(first.contentHash).not.toBe(second.contentHash);
    expect(target.blobCount()).toBe(3);

    const headers = target.createBundle({
      runId: "run-headers",
      scenarioId: "scenario-1",
      checkpointId: "headers",
      capturedAt: "2026-07-25T00:00:00.000Z",
      environment,
      artifacts: [bufferArtifact],
      facts: [{ id: "headers", kind: "JSON", value: { headers: { authorization: "Bearer structured", cookie: "sid=abc" } } }],
    });
    expect(JSON.stringify(headers)).not.toContain("structured");
    expect(JSON.stringify(headers)).not.toContain("sid=abc");

    const foreignStore = store();
    const otherStoreBundle = foreignStore.createBundle({
      runId: "run-foreign",
      scenarioId: "scenario-1",
      checkpointId: "foreign",
      capturedAt: "2026-07-25T00:00:00.000Z",
      environment,
      artifacts: [visibleText(foreignStore, { id: "foreign" })],
      facts: [],
    });
    expect(() => target.appendCheckpoint(otherStoreBundle)).toThrow(/unknown evidence bundle/);

    const firstManifest = target.appendCheckpoint(headers);
    const runMismatch = target.createBundle({
      runId: "run-other",
      scenarioId: "scenario-1",
      checkpointId: "other-run",
      capturedAt: "2026-07-25T00:00:00.000Z",
      environment,
      artifacts: [bufferArtifact],
      facts: [],
    });
    expect(() => target.appendCheckpoint(runMismatch, { manifest: firstManifest })).toThrow(/not current store state/);
    const tamperedBundle = structuredClone(headers);
    tamperedBundle.facts[0].value.timestamp = "changed";
    expect(() => target.appendCheckpoint(tamperedBundle)).toThrow(/unknown evidence bundle/);
  });

  it("redacts JSON strings and mutable metadata before persistence", () => {
    const mutableProducer = { name: "producer-supplied-secret", version: "0.1.0" };
    const mutableEnvironment = {
      ...environment,
      targetUrl: "https://example.test?token=supplied-secret",
    };
    const mutableFact = {
      id: "credentials",
      kind: "JSON",
      value: { accessToken: "fact-secret", headers: { cookie: "sid=fact-cookie" } },
    };
    const target = store({ producer: mutableProducer });
    const artifact = target.captureArtifact({
      id: "json",
      type: "VISIBLE_TEXT",
      contentType: "application/json",
      content: JSON.stringify({
        headers: {
          authorization: "Bearer json-secret",
          "proxy-authorization": "Basic proxy-secret",
          "set-cookie": "sid=json-cookie",
          sessionCookie: "sid=session-cookie",
        },
      }),
    });
    const evidenceBundle = target.createBundle({
      runId: "run-json",
      scenarioId: "scenario-json",
      checkpointId: "checkpoint-json",
      capturedAt: "2026-07-25T00:00:00.000Z",
      environment: mutableEnvironment,
      artifacts: [artifact],
      facts: [mutableFact],
    });
    mutableProducer.name = "mutated-secret";
    mutableEnvironment.targetUrl = "https://mutated-secret.test";
    mutableFact.value.accessToken = "mutated-secret";
    const manifest = target.appendCheckpoint(evidenceBundle);

    const persisted = [
      target.readBlob(artifact.storageRef).toString("utf8"),
      JSON.stringify(evidenceBundle),
      JSON.stringify(manifest),
    ].join("\n");
    for (const secret of [
      "supplied-secret",
      "json-secret",
      "json-cookie",
      "proxy-secret",
      "session-cookie",
      "fact-secret",
      "fact-cookie",
      "mutated-secret",
    ]) {
      expect(persisted).not.toContain(secret);
    }
    expect(Object.isFrozen(mutableProducer)).toBe(false);
    expect(Object.isFrozen(mutableEnvironment)).toBe(false);
    expect(Object.isFrozen(mutableFact)).toBe(false);
  });

  it("redacts derived authentication material in text and structured metadata", () => {
    const target = store({
      providerCapabilities: {
        ...providerCapabilities,
        evidence: ["VISIBLE_TEXT", "NETWORK_LOG"],
      },
    });
    const artifact = target.captureArtifact({
      id: "auth-log",
      type: "NETWORK_LOG",
      contentType: "text/plain",
      content: [
        "Authorization: Basic dXNlcjpwYXNz",
        '"Authorization" : "Bearer quoted-secret"',
        "Authorization = Basic equals-secret",
        "Cookie: session=raw-cookie",
        "Cookie = SID=equals-cookie",
        "GET https://example.test/?access_token=url-token&safe=true",
        'client_secret="hello world"',
        "'client_secret' = 'quoted-key-secret'",
      ].join("\n"),
    });
    const evidenceBundle = target.createBundle({
      runId: "run-auth",
      scenarioId: "scenario-auth",
      checkpointId: "checkpoint-auth",
      capturedAt: "2026-07-25T00:00:00.000Z",
      environment: {
        ...environment,
        targetUrl: "https://alice:userinfo-secret@example.test/?refresh_token=environment-token",
      },
      artifacts: [artifact],
      facts: [{
        id: "session",
        kind: "JSON",
        value: {
          sessionId: "derived-session",
          links: [
            "https://token-secret@example.test/",
            "ssh://git-secret@example.test/repo",
            "https://:password-secret@example.test/",
          ],
          headers: [["Authorization", "Bearer pair-secret"], ["Cookie", "SID=pair-cookie"]],
        },
      }],
    });
    const persisted = `${target.readBlob(artifact.storageRef).toString("utf8")}\n${JSON.stringify(evidenceBundle)}`;
    for (const secret of [
      "dXNlcjpwYXNz",
      "raw-cookie",
      "quoted-secret",
      "equals-secret",
      "equals-cookie",
      "url-token",
      "hello world",
      "quoted-key-secret",
      "environment-token",
      "userinfo-secret",
      "derived-session",
      "token-secret",
      "git-secret",
      "password-secret",
      "pair-secret",
      "pair-cookie",
    ]) {
      expect(persisted).not.toContain(secret);
    }
  });

  it("rejects opaque binary evidence and preserves stored text bytes behind copy-on-read", () => {
    const target = store({
      providerCapabilities: {
        ...providerCapabilities,
        evidence: ["VISIBLE_TEXT", "SCREENSHOT"],
      },
    });
    expect(() =>
      target.captureArtifact({
        id: "screenshot",
        type: "SCREENSHOT",
        contentType: "image/png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }),
    ).toThrow(/trusted redactor/);
    expect(() =>
      target.captureArtifact({
        id: "spoofed-screenshot",
        type: "SCREENSHOT",
        contentType: "text/plain",
        content: "not really a screenshot",
      }),
    ).toThrow(/trusted redactor/);
    expect(() =>
      target.captureArtifact({
        id: "spaced-image",
        type: "SCREENSHOT",
        contentType: " image/png ",
        content: "not really a screenshot",
      }),
    ).toThrow(/trusted redactor/);
    expect(() =>
      target.captureArtifact({
        id: "invalid-utf8",
        type: "VISIBLE_TEXT",
        contentType: "text/plain",
        content: Buffer.from([0xff]),
      }),
    ).toThrow(/valid UTF-8/);
    expect(() =>
      target.captureArtifact({
        id: "gzip-spoof",
        type: "VISIBLE_TEXT",
        contentType: "application/gzip",
        content: "not textual evidence",
      }),
    ).toThrow(/textual contentType/);

    const artifact = visibleText(target, { content: Buffer.from("stable bytes") });
    const firstRead = target.readBlob(artifact.storageRef);
    firstRead[0] = 0;
    expect(target.readBlob(artifact.storageRef).toString("utf8")).toBe("stable bytes");

    const binaryTarget = store({
      providerCapabilities: {
        ...providerCapabilities,
        evidence: ["SCREENSHOT"],
      },
      binaryRedactor: () => ({ content: Buffer.from("sanitized-pixels"), replacements: 1 }),
    });
    const screenshot = binaryTarget.captureArtifact({
      id: "redacted-screenshot",
      type: "SCREENSHOT",
      contentType: "image/png",
      content: Buffer.from("raw-secret-pixels"),
    });
    expect(binaryTarget.readBlob(screenshot.storageRef).toString("utf8")).toBe("sanitized-pixels");
  });

  it("keeps manifests per run and binds seals to exact bundle content", () => {
    const target = store();
    const first = bundle(target, { runId: "run-a", checkpointId: "same-checkpoint" });
    const second = bundle(target, {
      runId: "run-b",
      checkpointId: "same-checkpoint",
      facts: [{ id: "time", kind: "JSON", value: { timestamp: "B" } }],
    });
    const firstManifest = target.appendCheckpoint(first);
    const secondManifest = target.appendCheckpoint(second);

    expect(firstManifest.runId).toBe("run-a");
    expect(secondManifest.runId).toBe("run-b");
    expect(first.bundleId).not.toBe(second.bundleId);
    expect(firstManifest.checkpoints[0].evidenceBundleHash).not.toBe(
      secondManifest.checkpoints[0].evidenceBundleHash,
    );
    expect(firstManifest.checkpoints[0].contentHash).not.toBe(
      secondManifest.checkpoints[0].contentHash,
    );

    const saved = JSON.stringify({
      bundle: target.readBundle(first.bundleId),
      manifest: target.readManifest(first.runId),
      blob: target.readBlob(first.artifacts[0].storageRef).toString("base64"),
    });
    const reloaded = JSON.parse(saved);
    const replayBlob = Buffer.from(reloaded.blob, "base64");
    const verified = verifyStoredEvidence({
      bundle: reloaded.bundle,
      manifest: reloaded.manifest,
      readBlob: () => replayBlob,
    });
    expect(verified.bundle).toEqual(first);
    expect(verified.readBlob(first.artifacts[0].storageRef)).toEqual(
      target.readBlob(first.artifacts[0].storageRef),
    );
    replayBlob[0] = 0;
    expect(verified.readBlob(first.artifacts[0].storageRef)).toEqual(
      target.readBlob(first.artifacts[0].storageRef),
    );
    expect(Object.isFrozen(target.readBundle(first.bundleId))).toBe(true);
    expect(Object.isFrozen(target.readManifest(first.runId))).toBe(true);

    const tamperedBundle = structuredClone(reloaded.bundle);
    tamperedBundle.facts[0] = { id: "forged", kind: "TEXT", value: "forged" };
    expect(() =>
      verifyStoredEvidence({
        bundle: tamperedBundle,
        manifest: reloaded.manifest,
        readBlob: () => Buffer.from(reloaded.blob, "base64"),
      }),
    ).toThrow(/tampered evidence bundle id/);
    expect(() =>
      verifyStoredEvidence({
        bundle: reloaded.bundle,
        manifest: reloaded.manifest,
        readBlob: () => Buffer.from("tampered blob"),
      }),
    ).toThrow(/tampered stored blob/);
  });

  it("tracks redaction and provenance per captured artifact", () => {
    const target = store({ secrets: ["same-secret"] });
    const secret = target.captureArtifact({
      id: "same",
      type: "VISIBLE_TEXT",
      contentType: "text/plain",
      content: "same-secret",
    });
    const literal = target.captureArtifact({
      id: "same",
      type: "VISIBLE_TEXT",
      contentType: "text/plain",
      content: "[REDACTED]",
    });
    const secretBundle = target.createBundle({
      runId: "run-redacted",
      scenarioId: "scenario",
      checkpointId: "secret",
      capturedAt: "2026-07-25T00:00:00.000Z",
      environment,
      artifacts: [secret],
      facts: [],
    });
    const literalBundle = target.createBundle({
      runId: "run-redacted",
      scenarioId: "scenario",
      checkpointId: "literal",
      capturedAt: "2026-07-25T00:00:00.000Z",
      environment,
      artifacts: [literal],
      facts: [],
    });
    expect(secret.contentHash).toBe(literal.contentHash);
    expect(secretBundle.redaction.replacements).toBe(literalBundle.redaction.replacements + 1);

    const forged = { ...secret, type: "SCREENSHOT", contentType: "image/png" };
    expect(() =>
      target.createBundle({
        runId: "run-forged",
        scenarioId: "scenario",
        checkpointId: "forged",
        capturedAt: "2026-07-25T00:00:00.000Z",
        environment,
        artifacts: [forged],
        facts: [],
      }),
    ).toThrow(/provider evidence capability|unknown captured artifact/);
  });

  it("snapshots accessor-backed capabilities and bundles before validation", () => {
    let capabilityReads = 0;
    const accessorCapabilities = {
      schemaVersion: PROVIDER_CAPABILITIES_VERSION,
      providerId: "accessor-provider",
      actions: [],
      get evidence() {
        capabilityReads += 1;
        return capabilityReads === 1 ? [] : ["SCREENSHOT"];
      },
    };
    const capabilityTarget = createInMemoryEvidenceStore({
      providerCapabilities: accessorCapabilities,
      binaryRedactor: () => ({ content: Buffer.from("safe"), replacements: 1 }),
    });
    expect(() =>
      capabilityTarget.captureArtifact({
        id: "accessor-screenshot",
        type: "SCREENSHOT",
        contentType: "image/png",
        content: Buffer.from("secret pixels"),
      }),
    ).toThrow(/provider evidence capability/);

    const target = store();
    const evidenceBundle = bundle(target);
    let forged = false;
    const switchingBundle = new Proxy(structuredClone(evidenceBundle), {
      get(object, key, receiver) {
        if (forged && key === "runId") return "forged-run";
        if (forged && key === "checkpointId") return "forged-checkpoint";
        if (forged && key === "bundleId") return "forged-bundle";
        const value = Reflect.get(object, key, receiver);
        if (key === "bundleId") forged = true;
        return value;
      },
    });
    const manifest = target.appendCheckpoint(switchingBundle);
    expect(manifest.runId).toBe(evidenceBundle.runId);
    expect(manifest.checkpoints[0].checkpointId).toBe(evidenceBundle.checkpointId);
    expect(manifest.checkpoints[0].evidenceBundleId).toBe(evidenceBundle.bundleId);
  });
});
