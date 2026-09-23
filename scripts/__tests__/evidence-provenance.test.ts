import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hasConcreteEvidence, normalizeBrowseDecision } from "../judge-verdict.mjs";
import { findUncitedChecks, normalizeJudgeReview, REVIEW_CRITERIA } from "../normalize-judge-review.mjs";

const dir = mkdtempSync(join(tmpdir(), "qa-evidence-provenance-"));
const snapshot = join(dir, "current-run.yaml");
const unrelated = join(dir, "previous-run.yaml");
writeFileSync(snapshot, '- heading "Pro plan"\n- text: 98 pts\n- text: Product\n');
writeFileSync(unrelated, '- text: 42 pts\n');
const runnerEvidence = { ariaSnapshots: [snapshot] };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runner-owned evidence provenance", () => {
  it("links same-check captures for review without turning an unverified claim into pass", () => {
    const plannedChecks = [{ checkId: "score", item: "score" }];
    const raw = { checks: [{ item: "score", result: "pass", detail: 'Observed "98 pts", not "Failed"' }] };
    const evidence = { ...runnerEvidence, checkpoints: [{ checkId: "score", evidenceRefs: [snapshot] }] };
    const decision = normalizeBrowseDecision(raw, { plannedChecks, runnerEvidence: evidence });
    expect(decision.checks[0].evidenceRefs).toEqual([snapshot]);
    expect(decision.checks[0].result).toBe("manual_review");
    expect(decision.checks[0].demotedFrom).toBe("pass");
    expect(normalizeBrowseDecision(decision, { plannedChecks, runnerEvidence: evidence }).status).toBe("manual_review");
  });

  it("does not link foreign, unregistered, or missing checkpoint files", () => {
    const plannedChecks = [{ checkId: "score", item: "score" }];
    for (const checkpoint of [
      { checkId: "other", evidenceRefs: [snapshot] },
      { checkId: "score", evidenceRefs: [unrelated] },
      { checkId: "score", evidenceRefs: [join(dir, "missing.yaml")] },
    ]) {
      const decision = normalizeBrowseDecision({ checks: [{ item: "score", result: "pass", detail: "Looks fine" }] },
        { plannedChecks, runnerEvidence: { ...runnerEvidence, checkpoints: [checkpoint] } });
      expect(decision.checks[0].evidenceRefs).toEqual([]);
      expect(decision.checks[0].result).toBe("manual_review");
    }
  });

  it.each([
    { detail: 'Observed "98 pts"' },
    { detail: "Observed 98%" },
    { detail: "Visited https://example.com/dashboard" },
    { detail: "Observed the page", evidenceRefs: [unrelated] },
  ])("demotes unsupported observations: %j", check => {
    const raw = { item: "score", result: "pass", confidence: "high", ...check };
    const decision = normalizeBrowseDecision({ status: "pass", checks: [raw] });
    expect(decision.status).toBe("manual_review");
    expect(decision.checks[0].demotedFrom).toBe("pass");
    expect(findUncitedChecks({ checks: [raw] })).toEqual(["score"]);
  });

  it.each([snapshot, basename(snapshot)])("accepts a current captured reference: %s", ref => {
    expect(hasConcreteEvidence({ evidenceRefs: [ref] }, runnerEvidence)).toBe(true);
  });

  it.each([
    unrelated,
    join(dir, "other-run", basename(snapshot)),
    "invented.png",
  ])("rejects unrelated or fabricated references: %s", ref => {
    expect(hasConcreteEvidence({ evidenceRefs: [ref] }, runnerEvidence)).toBe(false);
  });

  it("rejects missing captures and ambiguous basename references", () => {
    expect(hasConcreteEvidence({ evidenceRefs: ["missing.yaml"] }, {
      ariaSnapshots: [join(dir, "missing.yaml")],
    })).toBe(false);
    expect(hasConcreteEvidence({ evidenceRefs: [basename(snapshot)] }, {
      ariaSnapshots: [snapshot, join(dir, "other-run", basename(snapshot))],
    })).toBe(false);
  });

  it("rejects directories, empty files, and unreadable ARIA", () => {
    const empty = join(dir, "empty.yaml");
    writeFileSync(empty, "");
    for (const file of [dir, empty]) {
      expect(hasConcreteEvidence({ evidenceRefs: [file] }, {
        ariaSnapshots: [file],
      })).toBe(false);
    }
    expect(hasConcreteEvidence({ detail: 'Observed "98 pts"' }, {
      ariaSnapshots: [dir],
    }, { fileExists: () => true })).toBe(false);
  });

  it("ignores malformed references and malformed capture lists", () => {
    expect(hasConcreteEvidence({ evidenceRefs: "invented.png" }, {
      screenshots: "invented.png", ariaSnapshots: null,
    })).toBe(false);
  });

  it("grounds quoted observations in captured ARIA and records the source", () => {
    const decision = normalizeBrowseDecision({
      status: "pass",
      checks: [{ item: "score", result: "pass", detail: 'Observed "98 pts"' }],
    }, { runnerEvidence });
    expect(decision.status).toBe("pass");
    expect(decision.checks[0].evidenceRefs).toEqual([snapshot]);
    expect(findUncitedChecks({ ...decision, runnerEvidence })).toEqual([]);
  });

  it.each(['Observed "42 pts"', 'Observed "Produ"', 'Observed "98 pts" and "42 pts"', 'Observed "98 pts" and "0"'])(
    "rejects unobserved or partial quotes: %s", detail => {
      expect(hasConcreteEvidence({ detail }, runnerEvidence)).toBe(false);
    },
  );

  it("floors a reviewer that approves an unsupported observation", () => {
    const review = normalizeJudgeReview({
      overallReview: "approved",
      criteria: REVIEW_CRITERIA.map(({ id }) => ({ id, verdict: "pass" })),
    }, { checks: [{ item: "score", result: "pass", detail: 'Observed "42 pts"' }], runnerEvidence });
    expect(review.overallReview).toBe("flagged");
    expect(review.criteria.find(({ id }) => id === "evidence-cited")?.verdict).toBe("concern");
  });
});
