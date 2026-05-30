import { describe, expect, it } from "vitest";
import { normalizeBrowseDecision } from "../run-hermes-page-judge.mjs";

describe("normalizeBrowseDecision", () => {
  it("passes when checks are all pass", () => {
    expect(
      normalizeBrowseDecision({
        checks: [{ item: "a", result: "pass", detail: "" }],
      }).status,
    ).toBe("pass");
  });

  it("passes when checks are pass and skip (skip does not elevate status)", () => {
    expect(
      normalizeBrowseDecision({
        checks: [
          { item: "a", result: "pass", detail: "" },
          { item: "b", result: "skip", detail: "blocked on live" },
        ],
      }).status,
    ).toBe("pass");
  });

  it("passes when all checks are skip", () => {
    expect(
      normalizeBrowseDecision({
        checks: [{ item: "a", result: "skip", detail: "" }],
      }).status,
    ).toBe("pass");
  });

  it("fails when any check fails", () => {
    expect(
      normalizeBrowseDecision({
        checks: [
          { item: "a", result: "pass", detail: "" },
          { item: "b", result: "fail", detail: "" },
          { item: "c", result: "skip", detail: "" },
        ],
      }).status,
    ).toBe("fail");
  });

  it("manual_reviews when any check needs human review", () => {
    expect(
      normalizeBrowseDecision({
        checks: [
          { item: "a", result: "pass", detail: "" },
          { item: "b", result: "manual_review", detail: "" },
        ],
      }).status,
    ).toBe("manual_review");
  });

  it("manual_reviews when checks array is empty", () => {
    expect(normalizeBrowseDecision({ checks: [] }).status).toBe(
      "manual_review",
    );
  });
});
