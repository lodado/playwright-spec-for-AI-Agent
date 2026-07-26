import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError,
  EVIDENCE_MANIFEST_VERSION,
  STUDY_SPEC_VERSION,
  canonicalHash,
  createEventId,
  createEvidenceId,
  createSessionId,
  migrateContract,
  validateEvidenceManifest,
  validateFinding,
  validateInteractionEvent,
  validateStudySpec,
} from "../index.mjs";

function studySpec() {
  return {
    schemaVersion: STUDY_SPEC_VERSION,
    study: { id: "hidden-cta-onboarding", name: "Hidden CTA onboarding evaluation" },
    product: { description: "PDF upload SaaS" },
    environment: {
      baseUrl: "http://127.0.0.1:4173",
      startPath: "/ko",
      allowedOrigins: ["http://127.0.0.1:4173"],
      viewport: { width: 390, height: 844, isMobile: true },
    },
    tasks: [{
      id: "upload-and-view-result",
      name: "Upload PDF and view result",
      goal: "Upload a PDF and see extracted results",
      maxActions: 20,
      maxDurationMs: 120000,
      maxConsecutiveNoProgressActions: 4,
      abandonmentAllowed: true,
      successOracles: [{ id: "result-visible", type: "element", role: "heading", name: "Extracted result", state: "visible" }],
      safetyPolicy: {
        allowRead: true,
        allowNavigation: true,
        allowClick: true,
        allowTyping: true,
        allowFileUpload: true,
        allowStateMutation: true,
        allowExternalOrigin: false,
        forbiddenActions: ["payment", "account_delete", "data_delete"],
        stopBeforeConfirmation: true,
      },
    }],
    personas: [{ preset: "impatient_new_user" }, { preset: "careful_business_buyer" }],
    runtime: { seeds: [101, 202], concurrency: 2, modelRoles: { action: "default", evaluator: "default" } },
    evidence: { screenshot: "every_action", trace: true, video: "on_failure", semanticSnapshot: "every_action" },
    evaluation: { minimumRecurrenceForFinding: 2, validityReport: true },
  };
}

function manifest() {
  return {
    schemaVersion: EVIDENCE_MANIFEST_VERSION,
    id: "manifest-1",
    runId: "run-1",
    sessionId: "session-1",
    createdAt: "2026-07-26T00:00:00.000Z",
    sealedAt: "2026-07-26T00:00:01.000Z",
    sealed: true,
    studyHash: "sha256:study",
    policyHash: "sha256:policy",
    entries: [{ id: "evidence-1", type: "screenshot", relativePath: "screenshots/1.png", contentHash: "sha256:entry", byteSize: 12, metadata: {} }],
    manifestHash: "sha256:manifest",
    redactionSummary: { redactedCount: 0, rulesVersion: "redaction/0.1" },
  };
}

test("StudySpec validates and round-trips without hidden custom evaluator execution hooks", () => {
  const spec = studySpec();
  const validated = validateStudySpec(spec);
  assert.equal(JSON.parse(JSON.stringify(validated)).schemaVersion, STUDY_SPEC_VERSION);
  assert.throws(() => validateStudySpec({ ...spec, tasks: [{ ...spec.tasks[0], successOracles: [{ id: "bad", type: "custom", evaluatorId: "./run-me.js" }] }] }), ContractValidationError);
  assert.throws(() => validateStudySpec({ ...spec, unknown: true }), /unknown field/);
});

test("StudySpec rejects session identity collisions", () => {
  const spec = studySpec();
  assert.throws(() => validateStudySpec({ ...spec, tasks: [spec.tasks[0], { ...spec.tasks[0] }] }), /task id must be unique/);
  assert.throws(() => validateStudySpec({ ...spec, personas: [{ preset: "same" }, { preset: "other", id: "same" }] }), /persona identity must be unique/);
  assert.throws(() => validateStudySpec({ ...spec, runtime: { ...spec.runtime, seeds: [101, 101] } }), /seed must be unique/);
  assert.throws(() => validateStudySpec({
    ...spec,
    comparison: {
      baseline: { id: "same", baseUrl: "https://baseline.test" },
      candidate: { id: "same", baseUrl: "https://candidate.test" },
      assignment: "paired",
      counterbalanceOrder: true,
      metrics: ["task_completion"],
    },
  }), /must differ from baseline id/);
});

test("stable ids and hashes ignore property order, not runtime wording", () => {
  assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }));
  assert.equal(
    createSessionId({ runId: "run", taskId: "task", personaId: "persona", seed: 101, variant: "candidate" }),
    createSessionId({ runId: "run", taskId: "task", personaId: "persona", seed: 101, variant: "candidate" }),
  );
  assert.equal(createEventId("session", 3), createEventId("session", 3));
  assert.equal(createEvidenceId({ sessionId: "session", type: "screenshot", sequence: 1, contentHash: "sha256:x" }), createEvidenceId({ sessionId: "session", type: "screenshot", sequence: 1, contentHash: "sha256:x" }));
});

test("typed actions require valueRef and reject plaintext value artifacts", () => {
  const event = {
    schemaVersion: "interaction-event/0.1",
    id: "event-1",
    sessionId: "session-1",
    index: 0,
    timestamp: "2026-07-26T00:00:00.000Z",
    observationId: "observation-1",
    action: { type: "type", elementId: "el-1", valueRef: "secret:email", reasonCode: "fill_required_email" },
    result: { status: "success" },
    urlBefore: "https://example.test/signup",
    urlAfter: "https://example.test/signup",
    evidenceIds: ["evidence-1"],
    derivedSignals: { progressChanged: true, backtrack: false, repeatedPage: false, failedInteraction: false, noProgress: false },
  };
  validateInteractionEvent(event);
  assert.throws(() => validateInteractionEvent({ ...event, action: { ...event.action, value: "plain@example.test" } }), /valueRef/);
});

test("EvidenceManifest 0.2 must be sealed, frozen, and migratable from 0.1", () => {
  const validated = validateEvidenceManifest(manifest());
  assert.equal(Object.isFrozen(validated.entries[0]), true);
  assert.throws(() => { validated.entries[0].metadata.changed = true; }, TypeError);
  assert.throws(() => validateEvidenceManifest({ ...manifest(), sealed: false }), /must be true/);
  const migrated = migrateContract(({ ...manifest(), schemaVersion: "evidence-manifest/0.1" }), EVIDENCE_MANIFEST_VERSION);
  assert.equal(migrated.schemaVersion, EVIDENCE_MANIFEST_VERSION);
  assert.equal(migrated.sealed, true);
  validateEvidenceManifest(migrated);
});

test("findings require event and evidence references", () => {
  const confidence = {
    evidenceConfidence: 1,
    recurrenceConfidence: 0.5,
    seedStability: "not_available",
    modelAgreement: "not_available",
    calibrationConfidence: "not_available",
    orderConsistency: "not_available",
    overall: "medium",
    limitations: ["uncalibrated"],
  };
  validateFinding({
    schemaVersion: "finding/0.1",
    id: "finding-1",
    fingerprint: "fp-1",
    title: "CTA below fold",
    category: "behavioral",
    severity: "medium",
    maturity: "reproduced_synthetic_finding",
    observation: "2 of 3 sessions did not discover the CTA.",
    interpretation: "The primary action may not be discoverable in the initial viewport.",
    affectedSessionIds: ["session-1"],
    affectedPersonaIds: ["persona-1"],
    affectedTaskIds: ["task-1"],
    eventIds: ["event-1"],
    evidenceIds: ["evidence-1"],
    recurrenceRate: 0.66,
    confidence,
    humanValidation: { level: "recommended", reason: "synthetic uncalibrated" },
  });
  assert.throws(() => validateFinding({
    schemaVersion: "finding/0.1",
    id: "finding-2",
    fingerprint: "fp-2",
    title: "No evidence",
    category: "behavioral",
    severity: "low",
    maturity: "exploratory_signal",
    observation: "No linked event.",
    interpretation: "Should be rejected.",
    affectedSessionIds: [],
    affectedPersonaIds: [],
    affectedTaskIds: [],
    eventIds: [],
    evidenceIds: [],
    recurrenceRate: 0,
    confidence,
    humanValidation: { level: "required" },
  }), /event and evidence refs/);
});
