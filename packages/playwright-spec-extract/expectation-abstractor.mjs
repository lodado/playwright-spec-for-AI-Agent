/**
 * Rule-based abstraction of Playwright expectations for non-deterministic live QA.
 */

export const ABSTRACTION_RULES_VERSION = "1.2.0";

const SCORE_KO_PATTERN = /^[\d,]+(?:\.\d+)?\s*점$/;
const PERCENT_PATTERN = /^[\d,]+(?:\.\d+)?\s*%$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDigit(value) {
  return /\d/.test(value);
}

export function liveRegexFromLiteral(value) {
  return value
    .split(/(\d[\d,]*)/g)
    .map((part) => {
      if (/^\d[\d,]*$/.test(part)) return "[\\d,]+";
      return escapeRegex(part);
    })
    .join("");
}

function semanticScoreExpected(originalLiteral, testTitle) {
  const titleHint = testTitle ? ` (${testTitle})` : "";
  return {
    kind: "semantic",
    intent: `A numeric score with unit is displayed${titleHint}`.trim(),
    constraints: [{ type: "numeric", role: "score" }],
    provenance: {
      rule: "score-ko",
      originalLiteral: originalLiteral ?? undefined,
    },
  };
}

function semanticPercentExpected(originalLiteral, testTitle) {
  const titleHint = testTitle ? ` (${testTitle})` : "";
  return {
    kind: "semantic",
    intent: `A percentage value is displayed${titleHint}`.trim(),
    constraints: [{ type: "numeric", role: "percent" }],
    provenance: {
      rule: "percent",
      originalLiteral: originalLiteral ?? undefined,
    },
  };
}

function semanticIsoDateExpected(originalLiteral) {
  return {
    kind: "semantic",
    intent: "A calendar date is shown (format may differ on live staging)",
    constraints: [{ type: "format", pattern: "iso-date" }],
    provenance: {
      rule: "iso-date",
      originalLiteral: originalLiteral ?? undefined,
    },
  };
}

export function literalExpectedForLive(value) {
  if (value.includes("${")) return { kind: "literal", value };

  if (SCORE_KO_PATTERN.test(value.trim())) {
    return {
      kind: "semantic",
      ...semanticScoreExpected(value),
      liveNote: "mock score with unit; live accepts any numeric score",
    };
  }

  if (PERCENT_PATTERN.test(value.trim())) {
    return {
      kind: "semantic",
      ...semanticPercentExpected(value),
      liveNote: "mock percent; live accepts any percentage display",
    };
  }

  if (ISO_DATE_PATTERN.test(value.trim())) {
    return {
      kind: "semantic",
      ...semanticIsoDateExpected(value),
      liveNote: "mock ISO date; live accepts equivalent date display",
    };
  }

  if (!hasDigit(value)) {
    return { kind: "literal", value };
  }

  return {
    kind: "regex",
    pattern: liveRegexFromLiteral(value),
    liveNote: "mock numeric fixture; live uses digit wildcard matching",
  };
}

export function liveTextLocatorForLive(value) {
  if (!hasDigit(value)) {
    return { kind: "text", value };
  }

  return {
    kind: "text",
    value: { kind: "regex", pattern: liveRegexFromLiteral(value) },
    liveNote: "mock numeric text; live uses digit wildcard matching",
  };
}

/**
 * Adapt a single parsed expectation for live / abstracted QA (parser stage).
 */
export function adaptExpectationForLive(expectation, _testTitle, _scenarioId) {
  if (expectation.type === "containText" && expectation.expected) {
    if (expectation.expected.kind === "literal") {
      const adapted = literalExpectedForLive(expectation.expected.value);
      if (adapted.kind === "semantic") {
        return {
          ...expectation,
          expected: {
            kind: "semantic",
            intent: adapted.intent,
            constraints: adapted.constraints,
          },
          liveNote: adapted.liveNote,
          provenance: adapted.provenance,
        };
      }
      if (adapted.kind === "regex") {
        return {
          ...expectation,
          expected: { kind: "regex", pattern: adapted.pattern },
          liveNote: adapted.liveNote,
        };
      }
    }
  }

  if (
    expectation.type === "visible" &&
    expectation.locator?.kind === "text" &&
    typeof expectation.locator.value === "string"
  ) {
    const adaptedLocator = liveTextLocatorForLive(expectation.locator.value);
    if (adaptedLocator.liveNote) {
      return {
        ...expectation,
        locator: {
          kind: adaptedLocator.kind,
          value: adaptedLocator.value,
        },
        liveNote: adaptedLocator.liveNote,
      };
    }
  }

  return expectation;
}

/**
 * Second-pass rule abstraction on an already-parsed spec (produces abstracted artifact).
 */
export function abstractExpectation(expectation, context) {
  return adaptExpectationForLive(
    expectation,
    context.testTitle,
    context.scenarioId,
  );
}

export function abstractSpec(spec) {
  const scenarios = (spec.scenarios ?? []).map((scenario) => ({
    ...scenario,
    tests: (scenario.tests ?? []).map((test) => ({
      ...test,
      expectations: (test.expectations ?? []).map((expectation) =>
        abstractExpectation(expectation, {
          testTitle: test.title,
          scenarioId: scenario.scenarioId,
          locator: expectation.locator,
        }),
      ),
    })),
  }));

  return {
    ...spec,
    scenarios,
    abstraction: {
      rulesVersion: ABSTRACTION_RULES_VERSION,
      appliedAt: new Date().toISOString(),
      stage: "rules",
    },
  };
}
