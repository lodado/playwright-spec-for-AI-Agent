/**
 * Validate and merge Hermes abstract-ai output into a live spec artifact.
 */

function collectCheckIds(spec) {
  const ids = new Set();
  for (const scenario of spec?.scenarios ?? []) {
    for (const test of scenario.tests ?? []) {
      if (test.checkId) ids.add(test.checkId);
    }
  }
  return ids;
}

function collectStructureFingerprint(spec) {
  return (spec?.scenarios ?? []).map(scenario => ({
    scenarioId: scenario.scenarioId,
    testCount: scenario.tests?.length ?? 0,
    checkIds: (scenario.tests ?? []).map(test => test.checkId),
    policies: (scenario.tests ?? []).map(test => test.liveRunPolicy),
  }));
}

export function normalizeAbstractAiResult(inputSpec, raw) {
  const errors = [];

  if (!raw?.spec || typeof raw.spec !== "object") {
    return { ok: false, errors: ["Missing spec object in Hermes response"], spec: inputSpec };
  }

  const outputSpec = raw.spec;
  const inputFp = JSON.stringify(collectStructureFingerprint(inputSpec));
  const outputFp = JSON.stringify(collectStructureFingerprint(outputSpec));

  if (inputFp !== outputFp) {
    errors.push(
      "Scenario/test structure changed (scenarioId, checkId, or test count mismatch)"
    );
  }

  const inputIds = collectCheckIds(inputSpec);
  for (const change of raw.changes ?? []) {
    if (change.checkId && !inputIds.has(change.checkId)) {
      errors.push(`Unknown checkId in changes: ${change.checkId}`);
    }
  }

  for (const scenario of outputSpec.scenarios ?? []) {
    for (const test of scenario.tests ?? []) {
      const inputTest = inputSpec.scenarios
        ?.find(s => s.scenarioId === scenario.scenarioId)
        ?.tests?.find(t => t.checkId === test.checkId);

      if (!inputTest) continue;

      if (test.liveRunPolicy !== inputTest.liveRunPolicy) {
        errors.push(
          `liveRunPolicy changed for ${test.checkId}: ${inputTest.liveRunPolicy} → ${test.liveRunPolicy}`
        );
      }

      const inputCount = inputTest.expectations?.length ?? 0;
      const outputCount = test.expectations?.length ?? 0;
      if (inputCount > 0 && outputCount === 0) {
        errors.push(`All expectations removed for ${test.checkId}`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, spec: inputSpec, changes: raw.changes ?? [] };
  }

  const model = process.env.HERMES_INFERENCE_MODEL?.trim() || null;

  return {
    ok: true,
    spec: {
      ...outputSpec,
      abstraction: {
        ...(outputSpec.abstraction ?? {}),
        rulesVersion: inputSpec.abstraction?.rulesVersion,
        aiAppliedAt: new Date().toISOString(),
        stage: "rules+ai",
        aiModel: model,
      },
    },
    audit: {
      generatedAt: new Date().toISOString(),
      changes: raw.changes ?? [],
      changeCount: (raw.changes ?? []).length,
    },
  };
}
