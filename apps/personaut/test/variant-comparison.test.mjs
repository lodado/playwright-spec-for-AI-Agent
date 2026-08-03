import assert from "node:assert/strict";
import test from "node:test";

import { compareVariants, evaluateReleaseGate } from "../src/evaluator.mjs";

test("compares paired variant metrics as relative release evidence", () => {
  const baselineSessions = ["b1", "b2", "b3", "b4", "b5"].map((id, index) => session(id, `p${index + 1}`, "success"));
  const candidateSessions = [
    session("c1", "p1", "abandoned"), session("c2", "p2", "failure"), session("c3", "p3", "abandoned"),
    session("c4", "p4", "failure"), session("c5", "p5", "success"),
  ];
  const report = compareVariants({
    baselineSessions,
    candidateSessions,
    baselineFingerprints: ["b1", "b2", "b3", "b4", "b5"].map((id) => fp(id, 4, 0)),
    candidateFingerprints: ["c1", "c2", "c3", "c4", "c5"].map((id, index) => fp(id, 8 + (index % 3), 0.2)),
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

test("reports candidate_better with candidate-minus-baseline delta direction", () => {
  const report = compareVariants({
    baselineSessions: ["b1", "b2", "b3", "b4", "b5"].map((id, index) => session(id, `p${index + 1}`, index % 2 ? "failure" : "abandoned")),
    candidateSessions: ["c1", "c2", "c3", "c4", "c5"].map((id, index) => session(id, `p${index + 1}`, "success")),
    baselineFingerprints: ["b1", "b2", "b3", "b4", "b5"].map((id) => fp(id, 8, 0.2)),
    candidateFingerprints: ["c1", "c2", "c3", "c4", "c5"].map((id) => fp(id, 4, 0)),
    orderResults: ["candidate_better", "candidate_better"],
  });

  assert.equal(report.status, "candidate_better");
  assert.equal(report.winner, "candidate");
  assert.ok(report.delta.completionDelta > 0);
  assert.ok(report.delta.medianActionDelta < 0);
  assert.equal(report.delta.confidence.orderConsistency, 1);
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
  assert.equal(report.status, "insufficient_evidence");
  assert.equal(report.candidate.failureRate, 0);
  assert.ok(report.delta.confidence.limitations.some((item) => item.includes("infrastructure")));
  assert.equal(report.delta.confidence.orderConsistency, "not_available");
  assert.ok(report.delta.confidence.limitations.some((item) => item.includes("not measured")));
});

test("excludes both sides of a paired comparison after one infrastructure failure", () => {
  const baselineSessions = [
    { session: { ...session("b1", "p1", "success"), seed: 1 }, functionalEvaluation: { status: "success" } },
    { session: { ...session("b2", "p2", "success"), seed: 1 }, functionalEvaluation: { status: "success" } },
  ];
  const candidateSessions = [
    { session: { ...session("c1", "p1", "runtime_error"), seed: 1 }, functionalEvaluation: { status: "runtime_error" } },
    { session: { ...session("c2", "p2", "success"), seed: 1 }, functionalEvaluation: { status: "success" } },
  ];
  const report = compareVariants({ baselineSessions, candidateSessions, assignment: "paired" });

  assert.equal(report.baseline.completionRate, 1);
  assert.equal(report.candidate.completionRate, 1);
  assert.ok(report.delta.confidence.limitations.some((item) => item.includes("1 infrastructure-failed pair")));
});

test("release gate never reports a baseline-better comparison as success", () => {
  const comparisonReport = { status: "baseline_better" };
  const warning = evaluateReleaseGate({ comparisonReport });
  const blocked = evaluateReleaseGate({ findings: [finding("f-critical", "critical", "reproduced_synthetic_finding", "high")], comparisonReport });

  assert.equal(warning.conclusion, "neutral");
  assert.match(warning.reasons.join(" "), /candidate regressed/);
  assert.equal(blocked.conclusion, "failure");
});

test("release gate exposes infrastructure failure without inventing a product finding", () => {
  const report = evaluateReleaseGate({ infrastructureFailure: true });
  assert.equal(report.infrastructureFailure, true);
  assert.equal(report.conclusion, "action_required");
  assert.match(report.reasons.join(" "), /infrastructure/);
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
