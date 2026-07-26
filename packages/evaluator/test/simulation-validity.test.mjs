import assert from "node:assert/strict";
import test from "node:test";

import { createBehavioralFingerprint, evaluateSimulationValidity } from "../src/index.mjs";

test("creates behavioral fingerprints from session events", () => {
  const fingerprint = createBehavioralFingerprint({
    session: { sessionId: "s1", status: "abandoned", terminalReason: { code: "no_progress" } },
    observations: [{ page: { url: "https://app.test/start" } }],
    events: [
      event("s1", 0, "click", "/start", "/upload", { progressChanged: true }),
      event("s1", 1, "back", "/upload", "/start", { backtrack: true, noProgress: true }),
      event("s1", 2, "idle", "/start", "/start", { noProgress: true }),
    ],
  });

  assert.equal(fingerprint.schemaVersion, "behavioral-fingerprint/0.1");
  assert.equal(fingerprint.actionCount, 3);
  assert.equal(fingerprint.abandonmentOccurred, true);
  assert.equal(fingerprint.abandonmentReasonCode, "no_progress");
  assert.ok(fingerprint.backtrackRate > 0);
  assert.ok(fingerprint.noActionRate > 0);
});

test("validity defaults to uncalibrated and warns on homogeneous hyperactive samples", () => {
  const sessions = ["s1", "s2", "s3"].map((id, index) => ({
    session: { sessionId: id, personaId: `p${index}`, status: "success" },
    events: Array.from({ length: 5 }, (_, actionIndex) => event(id, actionIndex, "click", "/start", "/done", { progressChanged: true })),
  }));
  const report = evaluateSimulationValidity({ sessions, taskMaxActions: 5 });

  assert.equal(report.schemaVersion, "simulation-validity/0.1");
  assert.equal(report.calibration.level, "uncalibrated");
  assert.equal(report.diversity.homogenizationRisk, "high");
  assert.ok(report.detectedRisks.includes("persona_homogenization"));
  assert.ok(report.detectedRisks.includes("hyperactivity"));
  assert.ok(report.forbiddenInterpretations.some((item) => item.includes("conversion")));
});

function event(sessionId, index, type, before, after, signals = {}) {
  return {
    id: `${sessionId}-e${index}`,
    sessionId,
    index,
    action: { type, reasonCode: "test" },
    urlBefore: `https://app.test${before}`,
    urlAfter: `https://app.test${after}`,
    result: { status: "success" },
    derivedSignals: {
      progressChanged: false,
      backtrack: false,
      repeatedPage: false,
      failedInteraction: false,
      noProgress: false,
      ...signals,
    },
  };
}
