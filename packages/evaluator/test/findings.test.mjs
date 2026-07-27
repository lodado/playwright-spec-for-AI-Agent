import assert from "node:assert/strict";
import test from "node:test";

import { createFindings, extractFrictionPoints } from "../src/index.mjs";

const manifest = Object.freeze({ entries: [{ id: "ev-1" }, { id: "ev-2" }] });

test("suppresses driver failures and extracts evidence-linked behavioral no-progress", () => {
  const session = { sessionId: "s1", personaId: "p1", taskId: "t1" };
  const points = extractFrictionPoints({
    session,
    events: [
      event("s1", "e1", "click", "failure", { failedInteraction: true }, ["ev-1"], "DRIVER_ACTION_FAILED"),
      event("s1", "e2", "wait", "success", { noProgress: true }, ["ev-2"]),
    ],
    manifest,
  });

  assert.equal(points.length, 1);
  assert.equal(points[0].category, "behavioral");
  assert.ok(points.every((point) => point.schemaVersion === "friction-point/0.1"));
  assert.ok(points.every((point) => point.eventIds.length === 1 && point.evidenceIds.length === 1));
});

test("clusters repeated behavioral friction into stable evidence-backed findings", () => {
  const sessions = [
    { sessionId: "s1", personaId: "p1", taskId: "t1" },
    { sessionId: "s2", personaId: "p2", taskId: "t1" },
  ];
  const points = sessions.flatMap((session, index) => extractFrictionPoints({
    session,
    events: [event(session.sessionId, `e${index}`, "wait", "success", { noProgress: true }, [`ev-${index + 1}`])],
    manifest: { entries: [{ id: `ev-${index + 1}` }] },
  }));
  const findings = createFindings({
    frictionPoints: points,
    sessions,
    minimumRecurrence: 2,
    validityReport: { calibration: { level: "uncalibrated" } },
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].schemaVersion, "finding/0.1");
  assert.equal(findings[0].maturity, "reproduced_synthetic_finding");
  assert.equal(findings[0].severity, "medium");
  assert.equal(findings[0].humanValidation.required, false);
  assert.deepEqual([...findings[0].affectedPersonaIds].sort(), ["p1", "p2"]);
});

test("creates functional friction only for an explicit failure oracle", () => {
  const session = { sessionId: "s1", personaId: "p1", taskId: "t1" };
  const points = extractFrictionPoints({
    session,
    events: [event("s1", "e1", "click", "success", {}, ["ev-1"])],
    observations: [{ sequence: 0, page: { url: "https://app.test/upload" } }],
    functionalEvaluation: {
      status: "failure",
      satisfiedOracleIds: ["payment-blocked"],
      violatedOracleIds: [],
      unknownOracleIds: [],
      evidenceIds: ["ev-1"],
      reasons: ["failure oracle satisfied: payment-blocked"],
    },
    manifest,
  });

  assert.equal(points.length, 1);
  assert.equal(points[0].category, "functional");
  assert.equal(points[0].severityCandidate, "high");
});

function event(sessionId, id, actionType, resultStatus, signals, evidenceIds, code) {
  return {
    id,
    sessionId,
    action: { type: actionType, elementId: "cta-primary", reasonCode: "test" },
    result: { status: resultStatus, ...(code ? { code } : {}) },
    urlBefore: "https://app.test/upload",
    urlAfter: "https://app.test/upload",
    evidenceIds,
    derivedSignals: { progressChanged: false, backtrack: false, repeatedPage: false, failedInteraction: false, noProgress: false, ...signals },
  };
}
