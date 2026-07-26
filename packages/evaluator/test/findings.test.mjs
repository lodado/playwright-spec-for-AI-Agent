import assert from "node:assert/strict";
import test from "node:test";

import { createFindings, extractFrictionPoints } from "../src/index.mjs";

const manifest = Object.freeze({ entries: [{ id: "ev-1" }, { id: "ev-2" }] });

test("extracts evidence-linked friction from failed and no-progress events", () => {
  const session = { sessionId: "s1", personaId: "p1", taskId: "t1" };
  const points = extractFrictionPoints({
    session,
    events: [
      event("s1", "e1", "click", "failure", { failedInteraction: true }, ["ev-1"]),
      event("s1", "e2", "wait", "success", { noProgress: true }, ["ev-2"]),
    ],
    manifest,
  });

  assert.equal(points.length, 2);
  assert.ok(points.every((point) => point.schemaVersion === "friction-point/0.1"));
  assert.ok(points.every((point) => point.eventIds.length === 1 && point.evidenceIds.length === 1));
});

test("clusters repeated friction into stable evidence-backed findings", () => {
  const sessions = [
    { sessionId: "s1", personaId: "p1", taskId: "t1" },
    { sessionId: "s2", personaId: "p2", taskId: "t1" },
  ];
  const points = sessions.flatMap((session, index) => extractFrictionPoints({
    session,
    events: [event(session.sessionId, `e${index}`, "click", "failure", { failedInteraction: true }, [`ev-${index + 1}`])],
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
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].humanValidation.required, true);
  assert.deepEqual([...findings[0].affectedPersonaIds].sort(), ["p1", "p2"]);
});

function event(sessionId, id, actionType, resultStatus, signals, evidenceIds) {
  return {
    id,
    sessionId,
    action: { type: actionType, elementId: "cta-primary", reasonCode: "test" },
    result: { status: resultStatus },
    urlBefore: "https://app.test/upload",
    urlAfter: "https://app.test/upload",
    evidenceIds,
    derivedSignals: { progressChanged: false, backtrack: false, repeatedPage: false, failedInteraction: false, noProgress: false, ...signals },
  };
}
