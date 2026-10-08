import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeBrowseDecision } from "../judge-verdict.mjs";

// O20 (P1, P2, P3): plans of 2 to 5 checks and arbitrary top-level statuses, judged against the card's
// Then: status = worst(claim, worst per-check derived, coverage floor, identity floor); a skip, missing or
// other top-level status claims manual_review; the summary carries "N planned check(s) unaddressed:".
// Seed and run count are fixed so the same input stream runs every time.
const SEED = 20261008;
const NUM_RUNS = 500;

const SEVERITY = { pass: 0, manual_review: 1, fail: 2 } as const;
type Status = keyof typeof SEVERITY;
const worst = (a: Status, b: Status): Status => (SEVERITY[b] > SEVERITY[a] ? b : a);

const RESULTS = ["pass", "fail", "skip", "manual_review", "not-a-result"] as const;
const CONFIDENCES = [undefined, "low", "medium", "high"] as const;

type CheckPlan = {
  reported: boolean;
  result: (typeof RESULTS)[number];
  confidence: (typeof CONFIDENCES)[number];
  cited: boolean;
};
type Scenario = {
  checks: CheckPlan[];
  duplicateOf: number | null;
  unplanned: boolean;
  status: string | undefined;
};

// count: checks 2 to 5; unaddressed 0, 1, n (BVA column). The top-level status covers the four card
// statuses, a missing one and arbitrary strings (including near-miss casing).
const checkArb: fc.Arbitrary<CheckPlan> = fc.record({
  reported: fc.boolean(),
  result: fc.constantFrom(...RESULTS),
  confidence: fc.constantFrom(...CONFIDENCES),
  cited: fc.boolean(),
});
const statusArb = fc.oneof(
  fc.constantFrom<string | undefined>("pass", "fail", "manual_review", "skip", undefined, "PASS", "passed", ""),
  fc.string({ maxLength: 12 }),
);
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    checks: fc.array(checkArb, { minLength: 2, maxLength: 5 }),
    duplicateSlot: fc.option(fc.nat({ max: 4 }), { nil: null }),
    unplanned: fc.boolean(),
    status: statusArb,
  })
  .map(({ checks, duplicateSlot, unplanned, status }) => ({
    checks,
    duplicateOf: duplicateSlot === null ? null : duplicateSlot % checks.length,
    unplanned,
    status,
  }))
  // A duplicate repeats a report that exists.
  .filter(scenario => scenario.duplicateOf === null || scenario.checks[scenario.duplicateOf].reported);

// The unplanned report is a pass that cites nothing, so its own derived status is manual_review.
const UNPLANNED_REPORT: CheckPlan = { reported: true, result: "pass", confidence: undefined, cited: false };

const captureOf = (index: number) => `/runs/o20/capture-${index}.png`;

function runProduct(scenario: Scenario) {
  const plannedChecks = scenario.checks.map((_, index) => ({
    checkId: `C${index + 1}`,
    item: `Planned check number ${index + 1} title`,
  }));
  const report = (check: CheckPlan, index: number, checkId: string) => ({
    checkId,
    item: plannedChecks[index].item,
    detail: "observed the page",
    result: check.result,
    ...(check.confidence ? { confidence: check.confidence } : {}),
    ...(check.cited ? { evidenceRefs: [captureOf(index)] } : {}),
  });
  const checks = scenario.checks.flatMap((check, index) =>
    check.reported ? [report(check, index, plannedChecks[index].checkId)] : [],
  );
  if (scenario.duplicateOf !== null) {
    const index = scenario.duplicateOf;
    checks.push(report(scenario.checks[index], index, plannedChecks[index].checkId));
  }
  if (scenario.unplanned) checks.push(report(UNPLANNED_REPORT, 0, "X9"));
  const raw = { ...(scenario.status === undefined ? {} : { status: scenario.status }), summary: "agent summary", checks };
  const captures = new Set(scenario.checks.map((_, index) => captureOf(index)));
  return normalizeBrowseDecision(raw, {
    plannedChecks,
    runnerEvidence: { screenshots: [...captures] },
    fileExists: (file: string) => captures.has(file),
    readText: () => "",
  });
}

// The card's Then, restated per check: S3 floors, S4 coverage floor, S5 identity floor, Q15 claim.
function expected(scenario: Scenario) {
  const claimRecognised = scenario.status === "pass" || scenario.status === "fail" || scenario.status === "manual_review";
  const claim: Status = claimRecognised ? (scenario.status as Status) : "manual_review";
  const reported = [...scenario.checks.filter(check => check.reported), ...(scenario.unplanned ? [UNPLANNED_REPORT] : [])];
  const demoted = (check: CheckPlan) => check.result === "pass" && (check.confidence === "low" || !check.cited);
  const perCheck = (check: CheckPlan): Status | "skip" => {
    if (check.result === "fail") return "fail";
    if (check.result === "skip") return "skip";
    if (check.result === "pass") return demoted(check) ? "manual_review" : "pass";
    return "manual_review";
  };
  const derivedChecks = reported.map(perCheck);
  const executed = derivedChecks.filter(result => result !== "skip");
  let derived: Status = "pass";
  if (derivedChecks.includes("fail")) derived = "fail";
  else if (derivedChecks.includes("manual_review") || executed.length === 0) derived = "manual_review";
  const hasDuplicate = scenario.duplicateOf !== null;
  const unaddressed = scenario.checks.filter((check, index) => !check.reported || scenario.duplicateOf === index).length;
  const unaddressedCount = scenario.checks.filter(check => !check.reported).length;
  const identityFloor = hasDuplicate || scenario.unplanned;
  const coverageFloor = unaddressed > 0;
  const status = [derived, coverageFloor ? "manual_review" : "pass", identityFloor ? "manual_review" : "pass"].reduce(
    (acc, next) => worst(acc as Status, next as Status),
    claim,
  ) as Status;
  const floorFired =
    reported.some(check => demoted(check) || check.result === "not-a-result") ||
    executed.length === 0 ||
    coverageFloor ||
    identityFloor ||
    !claimRecognised;
  return { status, claim, noted: floorFired || status !== claim, hasDuplicate, unaddressedCount };
}

function property(name: string, check: (scenario: Scenario) => void) {
  let executedRuns = 0;
  fc.assert(
    fc.property(scenarioArb, scenario => {
      executedRuns += 1;
      check(scenario);
    }),
    { numRuns: NUM_RUNS, seed: SEED },
  );
  expect(executedRuns, `${name}: executed fast-check runs`).toBe(NUM_RUNS);
}

describe("normalizeBrowseDecision as a plan of 2 to 5 checks with an arbitrary top-level status", () => {
  it("[O20] to be the worst of the claim, the per-check results, the coverage floor and the identity floor", () => {
    property("status", scenario => {
      expect(runProduct(scenario).status, JSON.stringify(scenario)).toBe(expected(scenario).status);
    });
  });

  it("[O20] to be a Verdict floor applied note exactly when a floor fired or the status is not the claim", () => {
    property("note", scenario => {
      const summary = runProduct(scenario).summary;
      expect(summary.includes("Verdict floor applied"), JSON.stringify(scenario)).toBe(expected(scenario).noted);
    });
  });

  it("[O20] to be the unaddressed count N in the note N planned check(s) unaddressed:", () => {
    property("unaddressed", scenario => {
      const { hasDuplicate, unaddressedCount } = expected(scenario);
      // A duplicated ID is not contracted as addressed or unaddressed, so only unambiguous plans assert N.
      if (hasDuplicate) return;
      const summary = runProduct(scenario).summary;
      if (unaddressedCount === 0) {
        expect(summary, JSON.stringify(scenario)).not.toContain("planned check(s) unaddressed:");
      } else {
        expect(summary, JSON.stringify(scenario)).toContain(`${unaddressedCount} planned check(s) unaddressed:`);
      }
    });
  });
});
