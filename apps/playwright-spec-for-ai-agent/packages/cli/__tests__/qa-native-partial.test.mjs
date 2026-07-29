import { describe, expect, it } from "vitest";
import { withoutBlockedScenarios } from "../qa-native-execute.mjs";

const qaIr = (blockedScenarioIds) => ({
  suites: [{ id: "s1", scenarios: [{ id: "keep" }, { id: "drop" }] }],
  extensions: { sourceContentHash: "sha256:abc", ...(blockedScenarioIds ? { blockedScenarioIds } : {}) },
});

describe("withoutBlockedScenarios", () => {
  it("drops blocked scenarios and strips the blocked list", () => {
    const filtered = withoutBlockedScenarios(qaIr(["drop"]));
    expect(filtered.suites[0].scenarios.map((s) => s.id)).toEqual(["keep"]);
    expect(filtered.extensions).toEqual({ sourceContentHash: "sha256:abc" });
  });

  it("returns the input unchanged when nothing is blocked", () => {
    const input = qaIr();
    expect(withoutBlockedScenarios(input)).toBe(input);
  });

  it("does not mutate the source qa ir", () => {
    const input = qaIr(["drop"]);
    withoutBlockedScenarios(input);
    expect(input.suites[0].scenarios.map((s) => s.id)).toEqual(["keep", "drop"]);
    expect(input.extensions.blockedScenarioIds).toEqual(["drop"]);
  });
});
