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

// The review stage reads ARIA text, not images: a check that cites only the
// screenshot of a checkpoint must carry that checkpoint's snapshot too, or the
// reviewer sees a path it cannot open and flags the pass as uncited.
describe("checkpoint captures travel together", () => {
  it("adds the same checkpoint's ARIA snapshot to a screenshot-only citation", () => {
    const screenshot = join(dir, "checkpoint-4-1.png");
    const aria = join(dir, "checkpoint-4-1.yaml");
    writeFileSync(screenshot, "png-bytes");
    writeFileSync(aria, '- heading "DEEP Parser"\n');
    const evidence = {
      screenshots: [screenshot],
      ariaSnapshots: [aria],
      checkpoints: [{ checkId: "select", evidenceRefs: [screenshot, aria] }],
    };
    const decision = normalizeBrowseDecision(
      { checks: [{ item: "select", result: "pass", detail: "Heading showed DEEP Parser", evidenceRefs: [screenshot] }] },
      { plannedChecks: [{ checkId: "select", item: "select" }], runnerEvidence: evidence },
    );
    expect(decision.checks[0].evidenceRefs).toEqual([screenshot, aria]);
    expect(decision.checks[0].result).toBe("pass");
  });

  it("never pulls in another check's checkpoint", () => {
    const screenshot = join(dir, "checkpoint-5-1.png");
    const foreign = join(dir, "checkpoint-5-other.yaml");
    writeFileSync(screenshot, "png-bytes");
    writeFileSync(foreign, '- text: other\n');
    const evidence = {
      screenshots: [screenshot],
      ariaSnapshots: [foreign],
      checkpoints: [
        { checkId: "select", evidenceRefs: [screenshot] },
        { checkId: "other", evidenceRefs: [foreign] },
      ],
    };
    const decision = normalizeBrowseDecision(
      { checks: [{ item: "select", result: "pass", detail: "ok", evidenceRefs: [screenshot] }] },
      { plannedChecks: [{ checkId: "select", item: "select" }, { checkId: "other", item: "other" }], runnerEvidence: evidence },
    );
    expect(decision.checks[0].evidenceRefs).toEqual([screenshot]);
  });
});

// A citation is trusted only as far as the captured text goes: a pass whose
// cited ARIA snapshot contains none of its quotes was captured at a different
// moment than the one it describes. One missing quote is not enough — agents
// also quote what was absent ("검수 필요" rather than "실패").
describe("quotes must be in the cited snapshot", () => {
  const plannedChecks = [{ checkId: "upload", item: "upload" }];
  function decide(detail: string) {
    const aria = join(dir, "checkpoint-8-1.yaml");
    writeFileSync(aria, '- button "parser-upload.png 삭제"\n- text: 검수 필요 · 1p\n');
    return normalizeBrowseDecision(
      { checks: [{ item: "upload", result: "pass", detail, evidenceRefs: [aria] }] },
      { plannedChecks, runnerEvidence: { ariaSnapshots: [aria], checkpoints: [{ checkId: "upload", evidenceRefs: [aria] }] } },
    ).checks[0];
  }

  it("keeps a pass whose every quote is in the cited snapshot", () => {
    expect(decide('Row "parser-upload.png 삭제" shows "검수 필요 · 1p"').result).toBe("pass");
  });

  it("keeps a pass that also quotes text it says was absent", () => {
    expect(decide('Row shows "검수 필요" rather than "실패"').result).toBe("pass");
  });

  it("demotes a pass whose cited snapshot contains none of its quotes", () => {
    const check = decide('Dialog showed "파싱 중 · 지금" and "파일 업로드 영역"');
    expect(check.result).toBe("manual_review");
    expect(check.demotedFrom).toBe("pass");
  });
});
