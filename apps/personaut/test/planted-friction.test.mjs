import assert from "node:assert/strict";
import test from "node:test";

import { extractFrictionPoints } from "../src/evaluator.mjs";

const scenarios = [
  ["control", true],
  ["dead button", false],
  ["ambiguous label", false],
  ["required input", false],
  ["hidden CTA", false],
  ["wrong route", false],
];

test("planted friction benchmark separates progress control from stalled UX cases", () => {
  for (const [name, progressChanged] of scenarios) {
    const evidenceId = `evidence-${name.replaceAll(" ", "-")}`;
    const event = {
      id: `event-${name.replaceAll(" ", "-")}`,
      index: 0,
      action: { type: name === "hidden CTA" ? "scroll" : "click", elementId: `element-${name}` },
      result: { status: progressChanged ? "success" : "no_change" },
      urlBefore: "/start",
      urlAfter: name === "wrong route" ? "/unexpected" : "/start",
      evidenceIds: [evidenceId],
      derivedSignals: { progressChanged, failedInteraction: false, noProgress: !progressChanged },
    };
    const points = extractFrictionPoints({
      session: { sessionId: `session-${name}`, taskId: "task", personaId: "persona" },
      events: [event],
      manifest: { entries: [{ id: evidenceId }] },
    });
    assert.equal(points.length, progressChanged ? 0 : 1, name);
    if (!progressChanged) assert.deepEqual(points[0].evidenceIds, [evidenceId], name);
  }
});
