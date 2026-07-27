import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalHash } from "@persona-runtime/contracts";

import {
  EVALUATOR_ERROR_CODES,
  EvaluatorError,
  evaluateFunctionalSession,
} from "../src/index.mjs";

const baseTask = Object.freeze({
  id: "task-1",
  name: "Task",
  goal: "Finish",
  successOracles: [{ id: "result-url", type: "url", operation: "contains", value: "/done" }],
  failureOracles: [],
});

const session = Object.freeze({
  schemaVersion: "session/0.1",
  runId: "run-1",
  sessionId: "session-1",
  studyId: "study-1",
  taskId: "task-1",
  personaId: "persona-1",
  seed: 101,
  status: "success",
  startedAt: "2026-07-26T00:00:00.000Z",
  completedAt: "2026-07-26T00:00:01.000Z",
  sampledPolicy: {},
  eventIds: ["event-1"],
  evidenceManifestId: "manifest-1",
});

const observation = Object.freeze({
  schemaVersion: "observation/0.1",
  id: "observation-1",
  sessionId: "session-1",
  sequence: 1,
  timestamp: "2026-07-26T00:00:01.000Z",
  page: { url: "https://example.test/done", title: "Done", viewport: { width: 390, height: 844 } },
  semantic: {
    visibleText: ["Upload complete", "Download receipt"],
    headings: [{ role: "heading", name: "Extracted Result" }],
    landmarks: [],
    interactiveElements: [{ id: "button-1", role: "button", name: "Download", enabled: true, visible: true, fingerprint: "button/download" }],
  },
  visual: { screenshotEvidenceId: "evidence-screenshot-1" },
  runtime: {
    consoleIssues: [],
    networkFailures: [{ id: "net-1", type: "network", message: "POST /api/upload 200", url: "https://example.test/api/upload", status: 200, method: "POST", evidenceId: "evidence-network-1" }],
    pendingRequestCount: 0,
    loadingIndicators: [],
  },
  oracleSignals: { satisfied: [], violated: [], unknown: [] },
});

const event = Object.freeze({
    schemaVersion: "interaction-event/0.2",
  id: "event-1",
  sessionId: "session-1",
  index: 0,
  timestamp: "2026-07-26T00:00:00.500Z",
  observationId: "observation-1",
  action: { type: "click", elementId: "button-1", reasonCode: "primary_action_match" },
  result: { status: "success" },
  urlBefore: "https://example.test/start",
  urlAfter: "https://example.test/done",
  evidenceIds: ["evidence-event-1"],
  derivedSignals: { progressChanged: true, backtrack: false, repeatedPage: false, failedInteraction: false, noProgress: false },
});

const manifestBody = {
  schemaVersion: "evidence-manifest/0.3",
  id: "manifest-1",
  runId: "run-1",
  sessionId: "session-1",
  createdAt: "2026-07-26T00:00:00.000Z",
  sealedAt: "2026-07-26T00:00:01.000Z",
  sealed: true,
  studyHash: "sha256:study",
  policyHash: "sha256:policy",
  entries: [
    { id: "evidence-observation-1", type: "semantic_snapshot", contentHash: canonicalHash(observation), metadata: { observationId: "observation-1" } },
    { id: "evidence-screenshot-1", type: "screenshot", contentHash: "sha256:shot", metadata: { observationId: "observation-1" } },
    { id: "evidence-event-1", type: "action_result", contentHash: canonicalHash(event), metadata: { eventId: "event-1", eventName: "click", properties: { elementId: "button-1" } } },
    { id: "evidence-network-1", type: "network_failure", contentHash: "sha256:net", metadata: { network: true, method: "POST", url: "https://example.test/api/upload", status: 200 } },
    { id: "evidence-download-1", type: "download", contentHash: "sha256:download", metadata: { filename: "receipt.pdf", mimeType: "application/pdf" } },
  ],
  redactionSummary: { redactedCount: 0, rulesVersion: "test" },
};
const manifest = Object.freeze({ ...manifestBody, manifestHash: canonicalHash(manifestBody) });

test("deterministic success oracles evaluate without a model", async () => {
  let modelCalls = 0;
  const result = await evaluateFunctionalSession({
    task: {
      ...baseTask,
      successOracles: [
        ...baseTask.successOracles,
        { id: "result-heading", type: "element", role: "heading", name: "Extracted Result", state: "visible" },
        { id: "upload-network", type: "network", method: "POST", urlPattern: "/api/upload", status: 200 },
        { id: "receipt-download", type: "download", filenamePattern: "receipt\\.pdf", mimeType: "application/pdf" },
        { id: "click-event", type: "event", name: "click", properties: { elementId: "button-1" } },
      ],
    },
    session,
    observations: [observation],
    events: [event],
    manifest,
    customEvaluators: { shouldNotRun: () => { modelCalls += 1; } },
  });

  assert.equal(result.schemaVersion, "functional-evaluation/0.1");
  assert.equal(result.status, "success");
  assert.deepEqual(result.unknownOracleIds, []);
  assert.equal(modelCalls, 0);
  assert.ok(result.evidenceIds.includes("evidence-observation-1"));
});

test("rejects unsafe regex oracles before evaluation", async () => {
  const unsafeTask = {
    ...baseTask,
    successOracles: [{ id: "unsafe", type: "visible_text", operation: "matches", value: "(a+)+$" }],
  };
  await assert.rejects(
    () => evaluateFunctionalSession({ task: unsafeTask, session, observations: [observation], events: [event], manifest }),
    (error) => error instanceof EvaluatorError && error.code === EVALUATOR_ERROR_CODES.ORACLE_INVALID,
  );
});

test("unknown deterministic state maps to manual_review", async () => {
  const result = await evaluateFunctionalSession({
    task: { ...baseTask, successOracles: [{ id: "remember-me", type: "element", role: "checkbox", name: "Remember me", state: "checked" }] },
    session: { ...session, status: "manual_review" },
    observations: [observation],
    events: [event],
    manifest,
  });

  assert.equal(result.status, "manual_review");
  assert.deepEqual(result.unknownOracleIds, ["remember-me"]);
});

test("unsupported custom evaluators are rejected instead of executed from study input", async () => {
  await assert.rejects(
    () => evaluateFunctionalSession({
      task: { ...baseTask, successOracles: [{ id: "custom-1", type: "custom", evaluatorId: "not-allowed" }] },
      session,
      observations: [observation],
      events: [event],
      manifest,
    }),
    (error) => error instanceof EvaluatorError && error.code === EVALUATOR_ERROR_CODES.CUSTOM_EVALUATOR_NOT_ALLOWED,
  );
});

test("evaluation requires a sealed manifest linked to the session evidence", async () => {
  await assert.rejects(
    () => evaluateFunctionalSession({ task: baseTask, session, observations: [observation], events: [event], manifest: { ...manifest, sealed: false } }),
    (error) => error instanceof EvaluatorError && error.code === EVALUATOR_ERROR_CODES.EVIDENCE_NOT_SEALED,
  );

  await assert.rejects(
    () => evaluateFunctionalSession({ task: baseTask, session, observations: [observation], events: [{ ...event, evidenceIds: ["missing-evidence"] }], manifest }),
    (error) => error instanceof EvaluatorError && error.code === EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID,
  );
});

test("evaluation rejects a non-canonical manifest hash", async () => {
  await assert.rejects(
    () => evaluateFunctionalSession({ task: baseTask, session, observations: [observation], events: [event], manifest: { ...manifest, manifestHash: "sha256:tampered" } }),
    (error) => error instanceof EvaluatorError && error.code === EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID,
  );
});

test("evaluation rejects observation or event evidence tampering even after resealing", async () => {
  const tamperedObservation = { ...observation, semantic: { ...observation.semantic, visibleText: ["Forged result"] } };
  await assert.rejects(
    () => evaluateFunctionalSession({ task: baseTask, session, observations: [tamperedObservation], events: [event], manifest }),
    (error) => error instanceof EvaluatorError && error.code === EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID,
  );

  const entries = manifest.entries.map((entry) => entry.id === "evidence-event-1" ? { ...entry, id: "evidence-forged-event-1" } : entry);
  const resealedBody = { ...manifestBody, entries };
  const resealedManifest = { ...resealedBody, manifestHash: canonicalHash(resealedBody) };
  await assert.rejects(
    () => evaluateFunctionalSession({ task: baseTask, session, observations: [observation], events: [event], manifest: resealedManifest }),
    (error) => error instanceof EvaluatorError && error.code === EVALUATOR_ERROR_CODES.EVIDENCE_LINK_INVALID,
  );
});

test("browserless evaluator package does not import browser automation", async () => {
  const source = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.equal(/playwright|puppeteer|browser/i.test(source), false);
});
