import { describe, expect, it } from "vitest";
import {
  buildStateDetectionQuery,
  normalizeStateDetection,
  parseStateOverride,
  reconcileState,
  scenarioHints,
  selectableScenarioIds,
  UNKNOWN_STATE,
} from "../judge-state-detection.mjs";
import { selectScenariosForLiveRun } from "../dashboard-spec-parser.mjs";

const SPEC = {
  scenarios: [
    { scenarioId: "ACTIVE", label: "Paid subscription", tests: [{ title: "a" }] },
    { scenarioId: "INACTIVE", label: "Free plan", tests: [{ title: "b" }] },
    { scenarioId: "CREDIT_BVA", alwaysRun: true, tests: [{ title: "c" }] },
    { scenarioId: "LEGACY", liveSkip: true, tests: [{ title: "d" }] },
  ],
};

describe("what the detector is asked to choose between", () => {
  it("offers the real states, never always-run or live-skipped ones", () => {
    expect(selectableScenarioIds(SPEC)).toEqual(["ACTIVE", "INACTIVE"]);
    expect(scenarioHints(SPEC)).toEqual({
      ACTIVE: "Paid subscription",
      INACTIVE: "Free plan",
    });
  });

  it("names every option, UNKNOWN included, and forbids mutation", () => {
    const query = buildStateDetectionQuery({
      targetUrl: "https://staging.acmecorp.com/dashboard",
      scenarioIds: ["ACTIVE", "INACTIVE"],
      scenarioHints: { ACTIVE: "Paid subscription" },
    });

    expect(query).toContain("`ACTIVE` — Paid subscription");
    expect(query).toContain("`INACTIVE`");
    expect(query).toContain(UNKNOWN_STATE);
    expect(query).toMatch(/Do not click anything that submits/);
    expect(query).toContain("https://staging.acmecorp.com/dashboard");
  });
});

describe("reading the detector's answer", () => {
  const options = { scenarioIds: ["ACTIVE", "INACTIVE"] };

  it("accepts a known state backed by a quote", () => {
    expect(
      normalizeStateDetection(
        { state: "INACTIVE", evidence: 'header reads "Free 플랜"', confidence: "high" },
        options,
      ),
    ).toMatchObject({ state: "INACTIVE", confidence: "high", reasons: [] });
  });

  it("refuses an impression in place of page text", () => {
    const result = normalizeStateDetection(
      { state: "ACTIVE", evidence: "it looked like a paid account", confidence: "high" },
      options,
    );
    expect(result.state).toBe(UNKNOWN_STATE);
    expect(result.reasons.join(" ")).toMatch(/without page text/);
  });

  it("refuses an empty or state-name-only evidence field", () => {
    expect(normalizeStateDetection({ state: "ACTIVE", evidence: "" }, options).state)
      .toBe(UNKNOWN_STATE);
    expect(
      normalizeStateDetection({ state: "ACTIVE", evidence: "ACTIVE ACTIVE" }, options).state,
    ).toBe(UNKNOWN_STATE);
  });

  it("refuses to narrow the run on a low-confidence answer", () => {
    const result = normalizeStateDetection(
      {
        state: "INACTIVE",
        evidence: "lee 님은 Free 플랜을 사용하고 있습니다",
        confidence: "low",
      },
      options,
    );
    expect(result.state).toBe(UNKNOWN_STATE);
    expect(result.reasons.join(" ")).toMatch(/low confidence/);
  });

  it("accepts page text pasted without quotation marks", () => {
    // The real answer from a live run, refused by an earlier predicate that
    // demanded quote characters inside a field that is itself the quote.
    expect(
      normalizeStateDetection(
        {
          state: "INACTIVE",
          evidence: "lee 님은 Free 플랜을 사용하고 있습니다. / FREE",
          confidence: "high",
        },
        options,
      ).state,
    ).toBe("INACTIVE");
  });

  it("refuses a state the page's specs do not define", () => {
    const result = normalizeStateDetection(
      { state: "TRIAL", evidence: 'reads "Trial"' },
      options,
    );
    expect(result.state).toBe(UNKNOWN_STATE);
    expect(result.reasons.join(" ")).toMatch(/not one of the page's scenarios/);
  });

  it("treats an empty answer as unknown, not as a failure", () => {
    expect(normalizeStateDetection({}, options)).toMatchObject({
      state: UNKNOWN_STATE,
      confidence: "low",
    });
  });
});

describe("reconciling against what the project expected", () => {
  const detected = { state: "INACTIVE", evidence: 'reads "Free 플랜"' };

  it("reports a mismatch when the account is not the configured one", () => {
    const result = reconcileState(detected, "ACTIVE");
    expect(result).toMatchObject({ state: "INACTIVE", expected: "ACTIVE", mismatch: true });
    expect(result.note).toContain("Free");
  });

  it("is quiet when they agree, or when nothing was expected", () => {
    expect(reconcileState(detected, "INACTIVE").mismatch).toBe(false);
    expect(reconcileState(detected, "").mismatch).toBe(false);
  });

  it("never calls an undetermined state a mismatch", () => {
    expect(
      reconcileState({ state: UNKNOWN_STATE, evidence: "" }, "ACTIVE").mismatch,
    ).toBe(false);
  });
});

describe("scoping the plan to the detected state", () => {
  it("keeps that state plus the always-run scenarios, and nothing else", () => {
    const scoped = selectScenariosForLiveRun(SPEC, "INACTIVE").map(s => s.scenarioId);
    expect(scoped).toEqual(["INACTIVE", "CREDIT_BVA"]);
  });
});

describe("--state override", () => {
  it("reads a forced state and rejects an empty one", () => {
    expect(parseStateOverride(["--state=ACTIVE"])).toBe("ACTIVE");
    expect(parseStateOverride([])).toBeNull();
    expect(() => parseStateOverride(["--state="])).toThrow(/needs a scenario id/);
  });
});

describe("scoping a written live plan", () => {
  const PLAN = [
    "---",
    "page: dashboard",
    "---",
    "",
    "# Dashboard QA spec (Live)",
    "",
    "### ACTIVE — shows the paid badge",
    "Given: a paid account",
    "",
    "### INACTIVE — shows the free badge",
    "Given: a free account",
    "",
    "### CREDIT_BVA — shows remaining credit",
    "Given: any account",
  ].join("\n");

  it("keeps the scoped scenarios' blocks and the preamble", async () => {
    const { scopePlanMarkdown } = await import("../judge-state-detection.mjs");
    const scoped = scopePlanMarkdown(PLAN, ["INACTIVE", "CREDIT_BVA"]);

    expect(scoped).toContain("# Dashboard QA spec (Live)");
    expect(scoped).toContain("### INACTIVE — shows the free badge");
    expect(scoped).toContain("### CREDIT_BVA — shows remaining credit");
    expect(scoped).not.toContain("### ACTIVE — shows the paid badge");
    expect(scoped.match(/^###\s/gm)).toHaveLength(2);
  });

  it("leaves the plan whole when nothing matches, rather than sending an empty one", async () => {
    const { scopePlanMarkdown } = await import("../judge-state-detection.mjs");
    expect(scopePlanMarkdown(PLAN, ["NOPE"])).toBe(PLAN);
    expect(scopePlanMarkdown(PLAN, [])).toBe(PLAN);
    expect(scopePlanMarkdown("### Fixture — no scenario id", ["ACTIVE"])).toBe(
      "### Fixture — no scenario id",
    );
  });
});
