/**
 * Compact Hermes payload for abstract-ai (GWT livePlan + annotation context).
 */

/** Playwright comment annotations → internal fields (for prompt legend). */
export const QA_ANNOTATION_LEGEND = {
  file: {
    "@qa-page": "Page slug (optional; usually matches CLI --page)",
    "@qa-scenario": "Scenario id (ACTIVE, INACTIVE, CANCEL_PENDING, CREDIT_BVA, …)",
    "@qa-live-skip": "true → entire file skipped on live judge",
    "@qa-always-run": "true → run this scenario even when account state differs",
    "@qa-fixture": "name=repo/relative/path — default upload for tests in file",
  },
  test: {
    "@qa-live-policy":
      "readonly | safe-interaction | safe-interaction-no-confirm | mock-judgment | subscription-mutation | auth-mock | skip",
    "@qa-fixture": "Per-test upload override (same name=path syntax)",
  },
  derived: {
    livePolicyAnnotation: "Value from @qa-live-policy comment",
    liveRunPolicy:
      "Internal policy sent to judge (executable-readonly, judgment-mock-api, blocked-*, …)",
    stagingMode: "read-only | interaction | auth | live-skip",
  },
};

function fileAnnotationsForScenario(scenario) {
  const ann = {
    qaScenario: scenario.scenarioId,
    ...(scenario.page ? { qaPage: scenario.page } : {}),
    ...(scenario.liveSkip ? { qaLiveSkip: true } : {}),
    ...(scenario.alwaysRun ? { qaAlwaysRun: true } : {}),
  };

  if (scenario.fixtures && Object.keys(scenario.fixtures).length > 0) {
    ann.qaFixtureFile = scenario.fixtures;
  }

  return ann;
}

function testAnnotationsForTest(test) {
  const ann = {
    qaLivePolicy: test.livePolicyAnnotation ?? null,
    liveRunPolicy: test.liveRunPolicy,
    stagingMode: test.stagingMode,
  };

  if (test.fixtures && Object.keys(test.fixtures).length > 0) {
    ann.qaFixtureTest = test.fixtures;
  }

  if (test.abstractReview) {
    ann.abstractReview = true;
  }

  return ann;
}

export function buildGwtPromptSpec(spec) {
  return {
    annotationLegend: QA_ANNOTATION_LEGEND,
    scenarios: (spec?.scenarios ?? []).map(scenario => ({
      scenarioId: scenario.scenarioId,
      label: scenario.label,
      sourceFile: scenario.sourceFile,
      fileAnnotations: fileAnnotationsForScenario(scenario),
      tests: (scenario.tests ?? []).map(test => ({
        title: test.title,
        checkId: test.checkId,
        testAnnotations: testAnnotationsForTest(test),
      })),
    })),
  };
}
