/**
 * Compact Hermes payload for abstract-ai (GWT livePlan + @qa-live-policy only).
 */

export function buildGwtPromptSpec(spec) {
  return {
    scenarios: (spec?.scenarios ?? []).map(scenario => ({
      scenarioId: scenario.scenarioId,
      label: scenario.label,
      sourceFile: scenario.sourceFile,
      ...(scenario.alwaysRun ? { alwaysRun: true } : {}),
      ...(scenario.liveSkip ? { liveSkip: true } : {}),
      tests: (scenario.tests ?? []).map(test => ({
        title: test.title,
        checkId: test.checkId,
        qaLivePolicy: test.livePolicyAnnotation ?? null,
        ...(test.actions?.length ? { actions: test.actions } : {}),
        ...(test.expectations?.length ? { expectations: test.expectations } : {}),
      })),
    })),
  };
}
