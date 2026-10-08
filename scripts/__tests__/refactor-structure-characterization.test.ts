import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { computeCorpus } from "./fixtures/refactor-characterization/corpus.mjs";

// O13: the refactored code answers the corpus of fast-check inputs (fixed seeds) exactly as the
// baseline 9b2031c recorded in baseline.json. The corpus keeps the fix questions Q10, Q11, Q15 and
// Q17 out of its inputs (see corpus.mjs), so outside those domains no difference is allowed.
type Case = { input: unknown; output: unknown; summaryComparable?: boolean };
type Corpus = { seeds: Record<string, number>; runs: Record<string, number>; cases: Record<string, Case[]> };

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/refactor-characterization");
const baseline = JSON.parse(readFileSync(join(fixtureDir, "baseline.json"), "utf8")) as Corpus & { baselineCommit: string };

const ENTRY_POINTS = {
  normalizer: "normalizeBrowseDecision",
  verdictParts: "pairPlannedChecks, buildCoverage, normalizeCause, isReadOnlyPlan, analyzeHarViolations",
  hash: "spec-hash functions",
  ledger: "qa-run-ledger append, verify, read, last, findLast",
  specReader: "parseAnnotations, parseSpecFile, buildBrowseChecklist, selectScenariosForLiveRun",
  exitFold: "worstExitCode",
  judgeStage: "decideAuthMode, verdictExitCode",
} as const;

// Q17 may add a floor note, so a summary is compared only where the corpus flagged it floor-free.
function comparable(entry: string, item: Case) {
  if (entry !== "normalizer") return item.output;
  const output = structuredClone(item.output) as { value?: { summary?: string } };
  if (!item.summaryComparable && output.value) delete output.value.summary;
  return output;
}

describe("characterization corpus as baseline 9b2031c versus the checked-out code", () => {
  let current: Corpus;

  beforeAll(async () => {
    current = (await computeCorpus()) as Corpus;
  }, 120_000);

  it("to be recorded from commit 9b2031c with the fixed seeds and run counts the corpus declares", () => {
    expect(baseline.baselineCommit).toBe("9b2031c");
    expect(baseline.seeds).toStrictEqual(current.seeds);
    expect(baseline.runs).toStrictEqual(current.runs);
    for (const [entry, runs] of Object.entries(baseline.runs)) {
      expect(baseline.cases[entry], entry).toHaveLength(runs);
      expect(current.cases[entry], entry).toHaveLength(runs);
    }
  });

  it("to be the same inputs drawn from the same seeds", () => {
    for (const entry of Object.keys(ENTRY_POINTS)) {
      expect(
        current.cases[entry].map((item) => item.input),
        entry,
      ).toStrictEqual(baseline.cases[entry].map((item) => item.input));
    }
  });

  for (const [entry, entryPoints] of Object.entries(ENTRY_POINTS)) {
    it(`to be zero regressed cases for ${entryPoints} [O13]`, () => {
      const regressed = baseline.cases[entry].flatMap((item, index) => {
        const after = current.cases[entry][index];
        const before = comparable(entry, item);
        const now = comparable(entry, { ...after, summaryComparable: item.summaryComparable });
        return JSON.stringify(before) === JSON.stringify(now) ? [] : [{ index, input: item.input, before, now }];
      });
      expect(regressed).toStrictEqual([]);
    });
  }

  it("to be 67 floor-free normalizer cases whose summary is compared, none carrying a floor note", () => {
    const compared = baseline.cases.normalizer.filter((item) => item.summaryComparable);
    expect(compared).toHaveLength(67);
    for (const item of compared) {
      expect((item.output as { value: { summary: string } }).value.summary).not.toContain("Verdict floor applied");
    }
  });
});
