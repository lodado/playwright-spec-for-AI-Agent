// Oracle refactor-modularity, row O5 (P5): the nightly exit fold. Expected values restate S9
// ("0 < 1 < 2 < 4 < 3, an unrecognised code outranks all of them") and Q10 a ("between two
// unrecognised codes the numerically larger one is worse"); they are not read from the product.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { run, worstExitCode } from "../run-page-qa-nightly.mjs";

/** 0 ok, 1 verdict, 2 usage, 4 agent output, 3 environment: the card's severity, worst last. */
const RECOGNISED_BY_SEVERITY = [0, 1, 2, 4, 3];
const UNRECOGNISED = [5, 6];
const ALL_CODES = [...RECOGNISED_BY_SEVERITY, ...UNRECOGNISED];

/** Rank of a code under S9 + Q10 a: recognised codes by severity, unrecognised ones above, larger worse. */
function rankOf(code: number): number {
  const severity = RECOGNISED_BY_SEVERITY.indexOf(code);
  return severity === -1 ? RECOGNISED_BY_SEVERITY.length + code : severity;
}

function expectedWorst(codes: number[]): number {
  return codes.reduce((worst, code) => (rankOf(code) > rankOf(worst) ? code : worst), 0);
}

function sequencesUpTo(length: number): number[][] {
  let layer: number[][] = [[]];
  const all: number[][] = [];
  for (let size = 1; size <= length; size += 1) {
    layer = layer.flatMap(prefix => ALL_CODES.filter(code => !prefix.includes(code)).map(code => [...prefix, code]));
    all.push(...layer);
  }
  return all;
}

describe("worstExitCode as stage exits arriving in every order", () => {
  it("to be the severest code for each of the 1099 ordered selections of up to 4 distinct exits", () => {
    const sequences = sequencesUpTo(4);
    const wrong = sequences
      .filter(codes => worstExitCode(codes) !== expectedWorst(codes))
      .map(codes => ({ codes, got: worstExitCode(codes), want: expectedWorst(codes) }));

    expect(sequences).toHaveLength(7 + 42 + 210 + 840);
    expect(wrong).toEqual([]);
  });

  it.each([
    [[3, 1], 3],
    [[1, 3], 3],
    [[3, 2], 3],
    [[3, 4], 3],
    [[4, 3, 1, 2], 3],
    [[2, 4], 4],
    [[4, 2], 4],
    [[1, 2], 2],
    [[0, 0], 0],
    [[], 0],
  ])("to be %j folded to exit %i (an environment exit is never replaced by a later 1, 2 or 4)", (codes, want) => {
    expect(worstExitCode(codes)).toBe(want);
  });

  it.each([
    [[5, 3], 5],
    [[3, 5], 5],
    [[6, 3], 6],
    [[3, 6], 6],
  ])("to be %j folded to the unrecognised exit %i, above the environment exit 3", (codes, want) => {
    expect(worstExitCode(codes)).toBe(want);
  });

  it.each([
    [[5, 6], 6],
    [[6, 5], 6],
  ])("to be %j folded to 6, the larger of two unrecognised exits (Q10 a)", (codes, want) => {
    expect(worstExitCode(codes)).toBe(want);
  });
});

describe("nightly run as stages exiting with scripted codes", () => {
  let root: string;

  function writeConfigAndSpec() {
    writeFileSync(
      join(root, "playwright-spec-for-ai-agent.config.mjs"),
      `export default { pages: { dashboard: { targetPath: "/dashboard" } } };`,
    );
    const dir = join(root, "qa", "dashboard");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "dashboard-qa-spec.json"),
      JSON.stringify({ scenarios: [{ scenarioId: "s1", tests: [{ title: "renders" }] }] }),
    );
  }

  const ARGS = () => [`--project-root=${root}`, "--output-dir={root}/qa/{page}", "--page=dashboard"];

  /** spawn stub: each stage script exits with the scripted code, else 0 */
  function scripted(codes: Record<string, number>) {
    const calls: string[] = [];
    return {
      calls,
      spawn: (script: string) => {
        calls.push(script);
        return codes[script] ?? 0;
      },
    };
  }

  beforeEach(() => {
    resetProjectConfigForTests();
    root = mkdtempSync(join(tmpdir(), "refactor-trace-fold-"));
    writeConfigAndSpec();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProjectConfigForTests();
  });

  it("to be exit 3 when judge exits 3 and the later slack and issues stages exit 1 and 2", async () => {
    const stages = scripted({ "run-hermes-page-judge.mjs": 3, "slack-page-qa-report.mjs": 1, "page-qa-issues.mjs": 2 });

    const code = await run([...ARGS(), "--with-slack", "--with-issues"], { spawn: stages.spawn });

    expect(code).toBe(3);
    expect(stages.calls).toEqual([
      "extract-page-e2e-spec.mjs",
      "run-hermes-spec-abstractor.mjs",
      "run-hermes-page-judge.mjs",
      "slack-page-qa-report.mjs",
      "page-qa-issues.mjs",
    ]);
  });

  it("to be exit 6 when abstract-ai exits 5 and the later judge stage exits 6", async () => {
    const stages = scripted({ "run-hermes-spec-abstractor.mjs": 5, "run-hermes-page-judge.mjs": 6 });

    expect(await run(ARGS(), { spawn: stages.spawn })).toBe(6);
  });

  it("to be exit 6 when abstract-ai exits 6 and the later judge stage exits 5", async () => {
    const stages = scripted({ "run-hermes-spec-abstractor.mjs": 6, "run-hermes-page-judge.mjs": 5 });

    expect(await run(ARGS(), { spawn: stages.spawn })).toBe(6);
  });
});
