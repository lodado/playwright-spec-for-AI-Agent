import { describe, expect, it } from "vitest";
import { renderReport } from "../qa-native-report.mjs";

describe("QA Native report", () => {
  it("renders only evidence-bound judgment and review results", () => {
    const markdown = renderReport([
      { scenarioId: "scenario-a", verdict: "PASS", confidence: 0.9, review: "APPROVED" },
      { scenarioId: "scenario-b", verdict: "MANUAL_REVIEW", confidence: 0.4, review: "MANUAL_REVIEW" },
    ]);

    expect(markdown).toContain("- PASS: 1");
    expect(markdown).toContain("- MANUAL_REVIEW: 1");
    expect(markdown).toContain("| scenario-a | PASS | 0.9 | APPROVED |");
    expect(markdown).not.toContain("recommendation");
  });
});
