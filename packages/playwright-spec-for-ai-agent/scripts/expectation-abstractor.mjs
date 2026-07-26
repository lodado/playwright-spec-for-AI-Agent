/**
 * Rule-based abstraction of Playwright expectations for non-deterministic live QA.
 */

export const ABSTRACTION_RULES_VERSION = "1.0.0";

const CREDIT_REMAINING_LIVE_PATTERN = "^Credit [\\d,]+$";

const SCORE_KO_PATTERN = /^[\d,]+(?:\.\d+)?\s*점$/;
const PERCENT_PATTERN = /^[\d,]+(?:\.\d+)?\s*%$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SCORE_TITLE_HINT = /\b(score|points?|pts|점|health)\b/i;
const PERCENT_TITLE_HINT = /\b(percent|%|rate|ratio)\b/i;
const CREDIT_TITLE_HINT = /\b(credit|credits|remaining)\b/i;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDigit(value) {
  return /\d/.test(value);
}

export function liveRegexFromLiteral(value) {
  return value
    .split(/(\d[\d,]*)/g)
    .map(part => {
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

function semanticNumericCountExpected(originalLiteral, testTitle, locator) {
  const locatorHint =
    locator?.kind === "testId" ? ` near [data-testid="${locator.value}"]` : "";
  return {
    kind: "semantic",
    intent: `A formatted numeric count or amount is displayed${locatorHint}${
      testTitle ? ` (${testTitle})` : ""
    }`.trim(),
    constraints: [{ type: "numeric", role: "count" }],
    provenance: {
      rule: "numeric-count",
      originalLiteral: originalLiteral ?? undefined,
    },
  };
}

export function literalExpectedForLive(value) {
  if (value.includes("${")) {
    return {
      kind: "regex",
      pattern: CREDIT_REMAINING_LIVE_PATTERN,
      liveNote: "mock template value; live uses numeric wildcard matching",
    };
  }

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
  if (/user is on .* plan/.test(value)) {
    return {
      kind: "text",
      value: { kind: "regex", pattern: "plan" },
      liveNote: "mock username/plan label; live only checks plan title copy",
    };
  }

  if (!hasDigit(value)) {
    return { kind: "text", value };
  }

  return {
    kind: "text",
    value: { kind: "regex", pattern: liveRegexFromLiteral(value) },
    liveNote: "mock numeric text; live uses digit wildcard matching",
  };
}

function upgradeRegexExpectedToSemantic(expected, context) {
  if (expected.kind !== "regex" || !expected.pattern) return null;

  const { testTitle, locator } = context;
  const pattern = expected.pattern;

  if (pattern === CREDIT_REMAINING_LIVE_PATTERN || /^Credit \[\\d,\]\+$/.test(pattern)) {
    return {
      kind: "semantic",
      intent: "Credit balance label with a numeric amount",
      constraints: [{ type: "numeric", role: "currency" }],
      provenance: { rule: "credit-label-regex", pattern },
    };
  }

  if (pattern === "[\\d,]+" || pattern === "^[\\d,]+$") {
    if (SCORE_TITLE_HINT.test(testTitle ?? "")) {
      return semanticScoreExpected(undefined, testTitle);
    }
    if (PERCENT_TITLE_HINT.test(testTitle ?? "")) {
      return semanticPercentExpected(undefined, testTitle);
    }
    if (
      CREDIT_TITLE_HINT.test(testTitle ?? "") ||
      /credit/i.test(locator?.value ?? "")
    ) {
      return semanticNumericCountExpected(undefined, testTitle, locator);
    }
  }

  if (/Score:\s*\[\\d,\]\+/.test(pattern) || /score/i.test(pattern)) {
    return semanticScoreExpected(undefined, testTitle);
  }

  return null;
}

/**
 * Adapt a single parsed expectation for live / abstracted QA (parser stage).
 */
export function adaptExpectationForLive(expectation, testTitle, _scenarioId) {
  const context = { testTitle, locator: expectation.locator };

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

    if (expectation.expected.kind === "template") {
      return {
        ...expectation,
        expected: { kind: "regex", pattern: CREDIT_REMAINING_LIVE_PATTERN },
        liveNote: "mock dynamic credit; live uses numeric wildcard matching",
      };
    }

    if (expectation.expected.kind === "regex" && !expectation.expected.pattern) {
      return expectation;
    }

    if (expectation.expected.kind === "regex") {
      const upgraded = upgradeRegexExpectedToSemantic(
        expectation.expected,
        context
      );
      if (upgraded) {
        return {
          ...expectation,
          expected: upgraded,
          liveNote: "rule-based semantic upgrade from regex mock",
          provenance: upgraded.provenance,
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
  const adapted = adaptExpectationForLive(
    expectation,
    context.testTitle,
    context.scenarioId
  );

  if (adapted.expected?.kind === "regex") {
    const upgraded = upgradeRegexExpectedToSemantic(adapted.expected, context);
    if (upgraded) {
      return {
        ...adapted,
        expected: upgraded,
        liveNote: adapted.liveNote ?? "rule-based semantic upgrade",
        provenance: upgraded.provenance,
      };
    }
  }

  return adapted;
}

export function abstractSpec(spec) {
  const scenarios = (spec.scenarios ?? []).map(scenario => ({
    ...scenario,
    tests: (scenario.tests ?? []).map(test => ({
      ...test,
      expectations: (test.expectations ?? []).map(expectation =>
        abstractExpectation(expectation, {
          testTitle: test.title,
          scenarioId: scenario.scenarioId,
          locator: expectation.locator,
        })
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

