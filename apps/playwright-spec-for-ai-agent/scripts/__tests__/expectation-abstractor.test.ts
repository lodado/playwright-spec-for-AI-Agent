import { describe, expect, it } from "vitest";
import {
  ABSTRACTION_RULES_VERSION,
  abstractExpectation,
  abstractSpec,
  adaptExpectationForLive,
  literalExpectedForLive,
  liveRegexFromLiteral,
  liveTextLocatorForLive,
} from "playwright-spec-extract/expectation-abstractor";

describe("literalExpectedForLive", () => {
  it("converts comma-formatted mock numbers to digit wildcards", () => {
    expect(liveRegexFromLiteral("42,835")).toBe("[\\d,]+");
    expect(literalExpectedForLive("42,835")).toMatchObject({
      kind: "regex",
      pattern: "[\\d,]+",
    });
  });

  it("preserves static prefix while wildcarding numeric suffix", () => {
    expect(liveRegexFromLiteral("Credit 0")).toBe("Credit [\\d,]+");
    expect(literalExpectedForLive("Credit 0")).toMatchObject({
      kind: "regex",
      pattern: "Credit [\\d,]+",
    });
  });

  it("keeps non-numeric copy literals unchanged", () => {
    expect(literalExpectedForLive("Subscription Info")).toEqual({
      kind: "literal",
      value: "Subscription Info",
    });
  });

  it("does not invent product semantics for unresolved templates or labels", () => {
    expect(literalExpectedForLive("Balance ${remaining}")).toEqual({
      kind: "literal",
      value: "Balance ${remaining}",
    });
    expect(liveTextLocatorForLive("user is on enterprise plan")).toEqual({
      kind: "text",
      value: "user is on enterprise plan",
    });
  });

  it("abstracts Korean score literals to semantic", () => {
    expect(literalExpectedForLive("98점")).toMatchObject({
      kind: "semantic",
      constraints: [{ type: "numeric", role: "score" }],
    });
    expect(literalExpectedForLive("1,234점").provenance).toMatchObject({
      rule: "score-ko",
    });
  });

  it("abstracts percent literals to semantic", () => {
    expect(literalExpectedForLive("12%")).toMatchObject({
      kind: "semantic",
      constraints: [{ type: "numeric", role: "percent" }],
    });
  });

  it("abstracts ISO dates to semantic", () => {
    expect(literalExpectedForLive("2026-05-30")).toMatchObject({
      kind: "semantic",
      constraints: [{ type: "format", pattern: "iso-date" }],
    });
  });
});

describe("adaptExpectationForLive", () => {
  it("adapts CREDIT_BVA credit literals for live wildcard matching", () => {
    const adapted = adaptExpectationForLive(
      {
        type: "containText",
        locator: { kind: "testId", value: "credit-remaining" },
        expected: { kind: "literal", value: "Credit 0" },
      },
      "shows Credit 0 when remaining_credits is 0",
      "CREDIT_BVA",
    );

    expect(adapted.expected).toMatchObject({
      kind: "regex",
      pattern: "Credit [\\d,]+",
    });
  });

  it("does not infer regex meaning from a test title", () => {
    const adapted = adaptExpectationForLive(
      {
        type: "containText",
        locator: { kind: "testId", value: "health-score" },
        expected: { kind: "regex", pattern: "[\\d,]+" },
      },
      "shows health score on dashboard",
      "ACTIVE",
    );

    expect(adapted.expected).toEqual({
      kind: "regex",
      pattern: "[\\d,]+",
    });
  });
});

describe("abstractSpec", () => {
  it("adds abstraction metadata", () => {
    const spec = abstractSpec({
      generatedAt: "2026-01-01T00:00:00.000Z",
      scenarios: [
        {
          scenarioId: "ACTIVE",
          tests: [
            {
              title: "shows 98점",
              checkId: "shows-98",
              expectations: [
                {
                  type: "containText",
                  locator: { kind: "testId", value: "score" },
                  expected: { kind: "literal", value: "98점" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(spec.abstraction).toMatchObject({
      rulesVersion: ABSTRACTION_RULES_VERSION,
      stage: "rules",
    });
    expect(spec.scenarios[0].tests[0].expectations[0].expected).toMatchObject({
      kind: "semantic",
    });
  });
});

describe("abstractExpectation", () => {
  it("does not infer product meaning from a title or locator", () => {
    const result = abstractExpectation(
      {
        type: "containText",
        locator: { kind: "testId", value: "credit-remaining" },
        expected: { kind: "regex", pattern: "[\\d,]+" },
        liveNote: "mock numeric fixture",
      },
      {
        testTitle: "remaining credits display",
        scenarioId: "ACTIVE",
        locator: { kind: "testId", value: "credit-remaining" },
      },
    );

    expect(result.expected).toEqual({
      kind: "regex",
      pattern: "[\\d,]+",
    });
  });
});
