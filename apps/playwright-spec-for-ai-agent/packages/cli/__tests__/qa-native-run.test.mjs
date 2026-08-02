import { describe, expect, it, vi } from "vitest";
import { runPipelineQaNative } from "../qa-native-run.mjs";

describe("QA Native v3 composition", () => {
  it("runs the single AI-native pipeline in order", async () => {
    const calls = [];
    const stage = name => vi.fn(async options => { calls.push([name, options]); return 0; });

    await expect(runPipelineQaNative({ runDirectory: "/tmp/run", compiler: "ignored" }, {
      execute: stage("execute"),
      judge: stage("judge"),
      review: stage("review"),
      report: stage("report"),
    })).resolves.toBe(0);

    expect(calls.map(([name]) => name)).toEqual(["execute", "judge", "review", "report"]);
    expect(calls[0][1]).toEqual({ runDirectory: "/tmp/run", compiler: "ignored" });
  });

  it("stops before decisions when execution fails", async () => {
    const judge = vi.fn();

    await expect(runPipelineQaNative({}, { execute: async () => 1, judge, review: vi.fn(), report: vi.fn() })).rejects.toThrow(/execute/);
    expect(judge).not.toHaveBeenCalled();
  });
});
