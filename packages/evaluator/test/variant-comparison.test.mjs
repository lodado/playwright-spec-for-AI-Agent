import assert from "node:assert/strict";
import test from "node:test";

import { compareVariants, evaluateReleaseGate } from "../src/index.mjs";

test("compares paired variant metrics as relative release evidence", () => {
  const baselineSessions = [session("b1", "p1", "success"), session("b2", "p2", "success"), session("b3", "p3", "success")];
  const candidateSessions = [session("c1", "p1", "abandoned"), session("c2", "p2", "failure"), session("c3", "p3", "success")];
  const report = compareVariants({
    baselineSessions,
    candidateSessions,
    baselineFingerprints: [fp("b1", 4, 0), fp("b2", 5, 0), fp("b3", 5, 0)],
    candidateFingerprints: [fp("c1", 9, 0.2), fp("c2", 10, 0.3), fp("c3", 8, 0.1)],
    candidateFindings: [{ id: "finding-candidate", maturity: "reproduced_synthetic_finding" }],
    orderResults: ["baseline_better", "baseline_better"],
  });

  assert.equal(report.schemaVersion, "variant-comparison-report/0.1");
  assert.equal(report.status, "baseline_better");
  assert.equal(report.winner, "baseline");
  assert.deepEqual(report.findingIds, ["finding-candidate"]);
  assert.equal(report.delta.confidence.orderConsistency, 1);
  assert.ok(report.delta.completionDelta < 0);
  assert.ok(report.delta.confidence.limitations.some((item) => item.includes("Relative")));
});

test("marks reversed order disagreement unstable", () => {
  const report = compareVariants({
    baselineSessions: [session("b1", "p1", "success")],
    candidateSessions: [session("c1", "p1", "success")],
    baselineFingerprints: [fp("b1", 1, 0)],
    candidateFingerprints: [fp("c1", 1, 0)],
    orderResults: ["baseline_better", "candidate_better"],
  });

  assert.equal(report.status, "unstable");
  assert.equal(report.winner, "none");
  assert.equal(report.delta.confidence.orderConsistency, 0);
});

test("maps variant-local findings to canonical report ids by fingerprint", () => {
  const report = compareVariants({
    baselineSessions: [session("b1", "p1", "success")],
    candidateSessions: [session("c1", "p1", "success")],
    baselineFingerprints: [fp("b1", 1, 0)],
    candidateFingerprints: [fp("c1", 1, 0)],
    candidateFindings: [{ id: "local-finding", fingerprint: "shared-fingerprint", maturity: "exploratory_signal" }],
    canonicalFindings: [{ id: "canonical-finding", fingerprint: "shared-fingerprint" }],
  });

  assert.deepEqual(report.findingIds, ["canonical-finding"]);
});

test("does not count runtime success when sealed functional evaluation failed", () => {
  const report = compareVariants({
    baselineSessions: [{ session: session("b1", "p1", "success"), functionalEvaluation: { status: "success" }, fingerprint: fp("b1", 1, 0) }],
    candidateSessions: [{ session: session("c1", "p1", "success"), functionalEvaluation: { status: "runtime_error" }, fingerprint: fp("c1", 1, 0) }],
  });
  assert.equal(report.baseline.completionRate, 1);
  assert.equal(report.candidate.completionRate, 0);
  assert.equal(report.candidate.failureRate, 1);
  assert.equal(report.delta.confidence.orderConsistency, "not_available");
  assert.ok(report.delta.confidence.limitations.some((item) => item.includes("not measured")));
});

test("release gate never reports a baseline-better comparison as success", () => {
  const comparisonReport = { status: "baseline_better" };
  const warning = evaluateReleaseGate({ comparisonReport });
  const blocked = evaluateReleaseGate({ findings: [finding("f-critical", "critical", "reproduced_synthetic_finding", "high")], comparisonReport });

  assert.equal(warning.conclusion, "neutral");
  assert.match(warning.reasons.join(" "), /candidate regressed/);
  assert.equal(blocked.conclusion, "failure");
});

test("release gate blocks reproduced critical behavioral findings but not uncalibrated exploratory singles", () => {
  const critical = finding("f-critical", "critical", "reproduced_synthetic_finding", "high");
  const exploratory = finding("f-single", "critical", "exploratory_signal", "high");
  const validityReport = { calibration: { level: "uncalibrated" }, recommendedUse: "release_warning" };

  const blocked = evaluateReleaseGate({ findings: [critical], validityReport });
  const notBlocked = evaluateReleaseGate({ findings: [exploratory], validityReport });

  assert.equal(blocked.conclusion, "failure");
  assert.deepEqual(blocked.blockingFindingIds, ["f-critical"]);
  assert.notEqual(notBlocked.conclusion, "failure");
  assert.deepEqual(notBlocked.blockingFindingIds, []);
});

function session(sessionId, personaId, status) {
  return { sessionId, personaId, taskId: "task", status };
}

function fp(sessionId, actionCount, backtrackRate) {
  return {
    sessionId,
    actionCount,
    actionTypeRates: { click: 1 },
    uniqueActionTypeCount: 1,
    routeSequence: ["/start", "/done"],
    routeEntropy: 1,
    backtrackRate,
    retryRate: 0,
    failedInteractionRate: 0,
    noActionRate: 0,
    abandonmentOccurred: false,
    errorReactionVector: { retry: 0, backtrack: 0, ignore: 0, abandon: 0 },
    progressCurve: [1],
    frustrationCurve: [0],
    trustCurve: [1],
    goalDirectednessScore: 1,
  };
}

function finding(id, severity, maturity, confidence) {
  return { id, category: "behavioral", severity, maturity, confidence: { overall: confidence } };
}
