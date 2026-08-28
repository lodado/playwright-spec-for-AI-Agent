/**
 * Compact payload for abstract-ai (GWT livePlan + @qa-live-policy only).
 *
 * The agent is given the test titles and every QA annotation the spec declares,
 * but not the Playwright body. A title is a claim about behaviour; asking the
 * agent to restate a body it was just shown produces a plan that paraphrases
 * the implementation instead of describing the user-visible outcome the check
 * is supposed to defend. The source is still quoted for the judge, which needs
 * to verify against what the test actually does.
 *
 * The annotations travel with it: they are the declared contract (which page,
 * which scenario, which policy, which upload fixtures), and the plan has to be
 * written against that contract rather than against a guess at it.
 */

export function buildGwtPromptSpec(spec) {
  return {
    scenarios: (spec?.scenarios ?? []).map(scenario => ({
      scenarioId: scenario.scenarioId,
      label: scenario.label,
      sourceFile: scenario.sourceFile,
      ...(scenario.page ? { page: scenario.page } : {}),
      ...(scenario.alwaysRun ? { alwaysRun: true } : {}),
      ...(scenario.liveSkip ? { liveSkip: true } : {}),
      ...(scenario.fixtures ? { fixtures: scenario.fixtures } : {}),
      tests: (scenario.tests ?? []).map(test => ({
        title: test.title,
        checkId: test.checkId,
        qaLivePolicy: test.livePolicyAnnotation ?? null,
        ...(test.fixtures ? { fixtures: test.fixtures } : {}),
      })),
    })),
  };
}
