import assert from "node:assert/strict";
import test from "node:test";

import { renderBehavioralHtmlReport } from "../src/reporter-html.mjs";

const report = Object.freeze({
  summary: { title: "Upload <Study>", status: "complete", humanValidation: "required" },
  validity: {
    calibration: { level: "uncalibrated", reason: "synthetic only" },
    recommendedUse: "human_validation_required",
    diversity: { personas: 2 },
    stability: { seedVariance: "not_available", modelAgreement: "not_available", orderConsistency: "not_available" },
    forbiddenInterpretations: ["actual user conversion claims"],
  },
  outcomes: [{ status: "success", count: 1, rate: 0.5 }, { status: "failure", count: 1, rate: 0.5 }],
  findings: [{
    schemaVersion: "finding/0.1",
    id: "finding-1",
    title: "CTA <missing>",
    severity: "high",
    category: "behavioral",
    maturity: "reproduced_synthetic_finding",
    observation: "2 < 3 sessions & stalled",
    interpretation: "CTA may be hidden",
    recommendation: "Move CTA above fold",
    affectedSessionIds: ["session-1", "session-2"],
    affectedPersonaIds: ["persona-1"],
    affectedTaskIds: ["task-1"],
    eventIds: ["event-8"],
    evidenceIds: ["evidence-shot-1"],
    totalSessionCount: 3,
    recurrenceRate: 0.66,
    confidence: {
      evidenceConfidence: 1,
      recurrenceConfidence: 0.5,
      seedStability: "not_available",
      modelAgreement: "not_available",
      calibrationConfidence: "not_available",
      orderConsistency: "not_available",
      overall: "medium",
      limitations: ["uncalibrated"],
    },
  }],
  personas: [{ personaId: "persona-1", sessions: 2, successRate: 0.5, findingIds: ["finding-1"] }],
  variant: { status: "insufficient_evidence", winner: "none" },
  timeline: [{
    sessionId: "session-1",
    personaId: "persona-1",
    taskId: "task-1",
    status: "failure",
    steps: [{
      index: 8,
      urlAfter: "https://example.test/upload",
      perceivedElements: ["Upload complete"],
      action: { type: "click", elementId: "button-view", reasonCode: "primary_action_match" },
      result: { status: "no_change" },
      derivedSignals: { progressChanged: false },
      evidenceIds: ["evidence-shot-1"],
    }],
  }],
  evidence: { entries: [{
    id: "evidence-shot-1",
    type: "screenshot",
    path: "/Users/chungheon/private/project/evidence/shot.png",
    metadata: { url: "https://example.test/upload?token=abc123", note: "uses sk-testSECRET123456" },
  }] },
  runtime: [{ sessionId: "session-1", type: "console", message: "bad <script>", evidenceId: "evidence-shot-1" }],
  cost: { model: "test-model", inputTokens: 10, secret: "api_key=abc123" },
});

test("renders validity, calibration, and recommended use before later report sections", () => {
  const html = renderBehavioralHtmlReport(report, { secrets: ["abc123"] });
  const validity = html.indexOf('id="validity"');
  assert.ok(validity > -1);
  for (const id of ["outcomes", "findings", "personas", "variant", "timeline", "evidence", "runtime", "cost"]) {
    assert.ok(validity < html.indexOf(`id="${id}"`), `${id} should render after validity`);
  }
  assert.ok(html.indexOf("Simulation calibration") < html.indexOf("Outcome Distribution"));
  assert.ok(html.indexOf("Recommended use") < html.indexOf("Outcome Distribution"));
});

test("escapes report text instead of injecting markup", () => {
  const html = renderBehavioralHtmlReport(report);
  assert.match(html, /CTA &lt;missing&gt;/);
  assert.match(html, /2 &lt; 3 sessions &amp; stalled/);
  assert.doesNotMatch(html, /<script>/);
});

test("links findings and timeline steps to relative evidence anchors", () => {
  const html = renderBehavioralHtmlReport(report);
  assert.match(html, /href="#evidence-shot-1"/);
  assert.match(html, /id="evidence-shot-1"/);
  assert.doesNotMatch(html, /href="\//);
  assert.doesNotMatch(html, /href="file:/);
});

test("renders screenshot and video evidence inline from relative session paths", () => {
  const html = renderBehavioralHtmlReport({
    evidence: { entries: [
      { id: "shot-1", type: "screenshot", src: "../sessions/session-1/screenshots/1.png" },
      { id: "vid-1", type: "video", src: "../sessions/session-1/videos/1.webm" },
    ] },
  });
  assert.match(html, /<img class="evidence-media"[^>]*src="\.\.\/sessions\/session-1\/screenshots\/1\.png"/);
  assert.match(html, /<video class="evidence-media"[^>]*src="\.\.\/sessions\/session-1\/videos\/1\.webm"/);
  assert.doesNotMatch(html, /src="\/[^/]/);
  assert.doesNotMatch(html, /src="file:/);
});

test("redacts secrets and private absolute paths", () => {
  const html = renderBehavioralHtmlReport(report, { secrets: ["abc123"] });
  assert.doesNotMatch(html, /\/Users\/chungheon/);
  assert.doesNotMatch(html, /abc123/);
  assert.doesNotMatch(html, /sk-testSECRET123456/);
  assert.match(html, /\[redacted-path\]/);
  assert.match(html, /\[redacted-secret\]/);
});
