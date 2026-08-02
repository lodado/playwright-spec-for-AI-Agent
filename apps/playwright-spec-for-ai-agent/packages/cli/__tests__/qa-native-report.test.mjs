import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reportQaNative, renderReport } from "../qa-native-report.mjs";

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

  it("takes the scenario identity from the sealed evidence bundle", () => {
    const cwd = mkdtempSync(join(tmpdir(), "qa-native-report-"));
    const runDirectory = join(cwd, ".qa", "runs", "report");
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const result = { resultId: "judge-1", verdict: "PASS", confidence: 0.9 };

    expect(reportQaNative({ runDirectory, cwd }, {
      loadExecution: () => ({ qaIr: {}, bundles: [] }),
      loadJudgments: () => [{ result, bundle: { scenarioId: "scenario-from-evidence" } }],
      loadReviews: () => [{ judgeResultId: "judge-1", status: "APPROVED" }],
      report: vi.fn(),
    })).toBe(0);

    expect(readFileSync(join(runDirectory, "report.md"), "utf8")).toContain("| scenario-from-evidence | PASS | 0.9 | APPROVED |");
  });
});
