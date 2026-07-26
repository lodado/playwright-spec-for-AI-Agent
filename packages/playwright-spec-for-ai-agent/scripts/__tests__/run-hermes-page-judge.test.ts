import { describe, expect, it } from "vitest";
import {
  buildBrowseHermesQuery,
  normalizeBrowseDecision,
} from "../run-hermes-page-judge.mjs";

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

describe("buildBrowseHermesQuery", () => {
  it("includes annotation guide in judge prompt", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan\n\n### 1. test",
      stagingLogin: {
        loginUrl: "https://example.com/login",
        email: "qa@example.com",
        password: "pw",
        targetUrl: "https://example.com/dashboard",
      },
    });

    expect(query).toContain("## Annotation guide");
    expect(query).toContain("`mock-judgment` -> `judgment-mock-api`");
    expect(query).toContain("If `blocked-*`, mark `skip`.");
    expect(query).toContain(
      "Value mismatch alone (e.g., `0` vs `8`) is not a failure",
    );
  });

  it("instructs Hermes to skip login when auth is disabled", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan\n\n### 1. public page",
      stagingLogin: {
        authRequired: false,
        loginUrl: "https://example.com/login",
        email: "",
        password: "",
        targetUrl: "https://example.com/pricing",
      },
    });

    expect(query).toContain("Open the target page directly without logging in");
    expect(query).toContain("Login required: false");
    expect(query).not.toContain("Password:");
  });
});
