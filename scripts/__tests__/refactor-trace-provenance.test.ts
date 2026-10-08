// Oracle refactor-modularity, rows O11 and O12 (P4): the stamp check at the entry of the judge and the review
// stage. The judge decides on the live plan against the raw spec; the review on the judge plan against the
// judgment. Expected values restate S7: only an actual mismatch refuses, with exit 2 and the command to
// re-run (abstract-ai for judge, judge for review); a stamp that cannot be established proceeds. The stages
// are entered through their shells (`main` / `run`), where the UsageError and its exit code are observable
// both before and after the stamp decision moves into judge-plan.mjs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock("../ai-agent-adapter.mjs", () => ({
  prepareAdapter: async () => ({
    name: "test-adapter",
    run: mocks.runAgent,
    capabilities: {
      auth: "credentials-in-prompt",
      supportsMaxTurns: true,
      supportsToolsetDisable: false,
      supportsVideo: false,
      blocksEventLoop: true,
    },
  }),
  runAgent: mocks.runAgent,
  runAgentAsync: mocks.runAgent,
  resolveAdapterName: () => "test-adapter",
}));

import { enterJudgeStage, enterReviewStage } from "./refactor-trace-fixtures.mjs";

beforeEach(() => {
  mocks.runAgent.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 })));
  return () => vi.unstubAllGlobals();
});

describe("judge stage as a live plan whose sourceHash differs from the raw spec hash (O11)", () => {
  it("to be exit 2 naming abstract-ai as the command to re-run", async () => {
    const result = await enterJudgeStage("differs");

    expect(result).toMatchObject({ entered: false, exitCode: 2 });
    expect(result.message).toContain("judge input is stale: it was generated from a different abstract-ai revision.");
    expect(result.hint).toBe("Re-run: npx playwright-spec-for-ai-agent abstract-ai --page=demo");
  });

  it("to be 0 agent runs and 0 preflight requests when the judge is started for real", async () => {
    const result = await enterJudgeStage("differs", { dryRun: false });

    expect(result).toMatchObject({ entered: false, exitCode: 2 });
    expect(result.message).toContain("different abstract-ai revision");
    expect(mocks.runAgent).toHaveBeenCalledTimes(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(0);
  });
});

describe("review stage as a judge plan whose first-line specHash differs from the judgment's (O11)", () => {
  it("to be exit 2 naming judge as the command to re-run", async () => {
    const result = await enterReviewStage("differs");

    expect(result).toMatchObject({ entered: false, exitCode: 2 });
    expect(result.message).toContain("review input is stale: it was generated from a different judge plan revision.");
    expect(result.hint).toContain("Re-run `npx playwright-spec-for-ai-agent judge --page=demo`");
  });

  it("to be 0 agent runs when the review is started for real", async () => {
    const result = await enterReviewStage("differs", { dryRun: false });

    expect(result).toMatchObject({ entered: false, exitCode: 2 });
    expect(result.message).toContain("different judge plan revision");
    expect(mocks.runAgent).toHaveBeenCalledTimes(0);
  });
});

describe("judge stage as an input whose staleness cannot be established (O12)", () => {
  it.each([
    ["a live plan written before stamps existed", "absent"],
    ["a missing raw spec", "missing-raw-spec"],
    ["a live plan stamped with the raw spec hash", "matches"],
  ] as const)("to be proceeding with %s, never exit 2", async (_situation, stamp) => {
    expect(await enterJudgeStage(stamp)).toEqual({ entered: true });
  });
});

describe("review stage as a judge plan whose stamp cannot be established (O12)", () => {
  it.each([
    ["a judge plan written before stamps existed", "absent"],
    ["a judge plan stamped with the judgment's specHash", "matches"],
  ] as const)("to be proceeding with %s, never exit 2", async (_situation, stamp) => {
    expect(await enterReviewStage(stamp)).toEqual({ entered: true });
  });
});
