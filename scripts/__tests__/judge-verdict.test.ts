import { describe, expect, it } from "vitest";
import {
  analyzeHarViolations,
  buildCoverage,
  buildEvidenceManifest,
  hasConcreteEvidence,
  isReadOnlyPlan,
  normalizeBrowseDecision,
  normalizeCause,
  resolveJudgeTurnBudget,
} from "../judge-verdict.mjs";

/** A pass that survives the evidence floor. */
function passing(item: string, detail = 'header reads "Pro plan"') {
  return { item, detail, result: "pass", confidence: "high" };
}

describe("verdict floor", () => {
  it("passes when every check passes with concrete evidence", () => {
    expect(normalizeBrowseDecision({ checks: [passing("a")] }).status).toBe(
      "pass",
    );
  });

  it("passes when checks are pass and skip (skip does not elevate status)", () => {
    expect(
      normalizeBrowseDecision({
        checks: [
          passing("a"),
          { item: "b", result: "skip", detail: "blocked on live" },
        ],
      }).status,
    ).toBe("pass");
  });

  it("manual_reviews when all checks are skip (nothing was verified)", () => {
    expect(
      normalizeBrowseDecision({
        status: "pass",
        checks: [{ item: "a", result: "skip", detail: "login failed" }],
      }).status,
    ).toBe("manual_review");
  });

  it("manual_reviews when the checks array is empty", () => {
    expect(normalizeBrowseDecision({ checks: [] }).status).toBe(
      "manual_review",
    );
  });

  it("never upgrades the agent's own verdict", () => {
    expect(
      normalizeBrowseDecision({ status: "manual_review", checks: [passing("a")] })
        .status,
    ).toBe("manual_review");
    expect(
      normalizeBrowseDecision({ status: "fail", checks: [passing("a")] }).status,
    ).toBe("fail");
  });

  it("downgrades the agent's verdict when checks are worse", () => {
    expect(
      normalizeBrowseDecision({
        status: "pass",
        checks: [{ item: "a", result: "fail", detail: "", cause: "PRODUCT_DEFECT" }],
      }).status,
    ).toBe("fail");
  });

  it("passes agentMeta through to the decision", () => {
    expect(
      normalizeBrowseDecision({
        checks: [passing("a")],
        agentMeta: { adapter: "aside", model: "m", durationMs: 12 },
      }).agentMeta,
    ).toEqual({ adapter: "aside", model: "m", durationMs: 12 });
  });
});

describe("scenario coverage", () => {
  it("counts planned checks the agent never addressed and forces manual_review", () => {
    const decision = normalizeBrowseDecision(
      { status: "pass", checks: [passing("shows health score")] },
      { plannedChecks: ["shows health score", "shows renewal date"] },
    );

    expect(decision.coverage).toEqual({
      planned: 2,
      addressed: 1,
      missing: ["shows renewal date"],
    });
    expect(decision.status).toBe("manual_review");
    expect(decision.summary).toContain("shows renewal date");
  });

  it("matches planned checks ignoring case and whitespace", () => {
    expect(
      buildCoverage(
        ["Shows   health score"],
        [{ item: "shows health score" }],
      ),
    ).toEqual({ planned: 1, addressed: 1, missing: [] });
  });

  it("matches a title the agent paraphrased by dropping a project prefix", () => {
    // Observed live: the plan says `to be: <title>`, the agent reports <title>.
    expect(
      buildCoverage(
        ["to be: '구독 정보' 섹션이 표시된다", "to be: 구독 이력 다이얼로그가 열린다"],
        [
          { item: "'구독 정보' 섹션이 표시된다" },
          { item: "구독 이력 다이얼로그가 열린다" },
        ],
      ),
    ).toEqual({ planned: 2, addressed: 2, missing: [] });
  });

  it("does not let one vague line cover the whole plan", () => {
    const coverage = buildCoverage(
      ["shows the health score card", "shows the health score card footer"],
      [{ item: "shows the health score card" }],
    );
    expect(coverage.addressed).toBe(1);
    expect(coverage.missing).toHaveLength(1);
  });

  it("ignores a fragment too short to identify a check", () => {
    expect(buildCoverage(["shows the plan name"], [{ item: "plan" }])).toEqual({
      planned: 1,
      addressed: 0,
      missing: ["shows the plan name"],
    });
  });

  it("stays pass when every planned check is addressed", () => {
    const decision = normalizeBrowseDecision(
      { checks: [passing("shows health score")] },
      { plannedChecks: ["shows health score"] },
    );
    expect(decision.status).toBe("pass");
    expect(decision.coverage.missing).toEqual([]);
  });
});

describe("evidence-or-demote", () => {
  it("accepts a quoted observed value", () => {
    expect(
      hasConcreteEvidence({ detail: 'plan badge reads "Pro"', evidenceRefs: [] }),
    ).toBe(true);
  });

  it("accepts a URL path and a number with a unit", () => {
    expect(hasConcreteEvidence({ detail: "landed on /dashboard/billing" })).toBe(
      true,
    );
    expect(hasConcreteEvidence({ detail: "score rendered as 98%" })).toBe(true);
  });

  it("rejects vague prose", () => {
    expect(
      hasConcreteEvidence({ detail: "everything looked correct on the page" }),
    ).toBe(false);
  });

  it("accepts an evidenceRef that resolves to a captured artifact", () => {
    expect(
      hasConcreteEvidence(
        { detail: "looked fine", evidenceRefs: ["dashboard-final.png"] },
        { screenshots: ["/tmp/evidence/dashboard-final.png"] },
        { fileExists: () => false },
      ),
    ).toBe(true);
  });

  it("rejects an evidenceRef that names no real file", () => {
    expect(
      hasConcreteEvidence(
        { detail: "looked fine", evidenceRefs: ["imagined.png"] },
        { screenshots: ["/tmp/evidence/dashboard-final.png"] },
        { fileExists: () => false },
      ),
    ).toBe(false);
  });

  it("demotes a pass that cites nothing concrete", () => {
    const decision = normalizeBrowseDecision({
      status: "pass",
      checks: [{ item: "a", result: "pass", detail: "all good" }],
    });

    expect(decision.status).toBe("manual_review");
    expect(decision.checks[0]).toMatchObject({
      result: "manual_review",
      demotedFrom: "pass",
      cause: "HARNESS_DEFECT",
    });
    expect(decision.summary).toContain("without citing concrete evidence");
  });

  it("demotes a pass reported with low confidence", () => {
    const decision = normalizeBrowseDecision({
      status: "pass",
      checks: [
        { item: "a", result: "pass", detail: 'reads "Pro"', confidence: "low" },
      ],
    });

    expect(decision.status).toBe("manual_review");
    expect(decision.summary).toContain("low confidence");
  });

  it("treats a missing confidence as medium, not low", () => {
    const decision = normalizeBrowseDecision({
      checks: [{ item: "a", result: "pass", detail: 'reads "Pro"' }],
    });
    expect(decision.status).toBe("pass");
    expect(decision.checks[0].confidence).toBe("medium");
  });
});

describe("cause classification", () => {
  it("normalizes an unknown cause on a non-pass check to HARNESS_DEFECT", () => {
    expect(normalizeCause("flaky", { result: "fail" })).toBe("HARNESS_DEFECT");
    expect(normalizeCause(undefined, { result: "manual_review" })).toBe(
      "HARNESS_DEFECT",
    );
  });

  it("keeps a passing check causeless", () => {
    expect(normalizeCause("PRODUCT_DEFECT", { result: "pass" })).toBe("NONE");
  });

  it("reports NONE for a green run", () => {
    expect(normalizeBrowseDecision({ checks: [passing("a")] }).cause).toBe(
      "NONE",
    );
  });

  it("keeps the agent's declared top-level cause", () => {
    expect(
      normalizeBrowseDecision({
        status: "fail",
        cause: "PRODUCT_DEFECT",
        checks: [
          { item: "a", result: "fail", detail: "no button", cause: "PRODUCT_DEFECT" },
        ],
      }).cause,
    ).toBe("PRODUCT_DEFECT");
  });

  it("derives the cause from the checks when the agent gives none", () => {
    expect(
      normalizeBrowseDecision({
        status: "manual_review",
        checks: [
          { item: "a", result: "skip", detail: "login page", cause: "ENVIRONMENT_DEFECT" },
        ],
      }).cause,
    ).toBe("ENVIRONMENT_DEFECT");
  });

  it("prefers a product defect over an environment defect on a mixed run", () => {
    expect(
      normalizeBrowseDecision({
        status: "fail",
        checks: [
          { item: "a", result: "fail", detail: "x", cause: "PRODUCT_DEFECT" },
          { item: "b", result: "skip", detail: "y", cause: "ENVIRONMENT_DEFECT" },
        ],
      }).cause,
    ).toBe("PRODUCT_DEFECT");
  });
});

describe("HAR violation analysis", () => {
  const staging = ["https://staging.acmecorp.com"];

  it("flags a main-frame navigation off the allowed origins", () => {
    const violations = analyzeHarViolations(
      {
        log: {
          entries: [
            {
              _resourceType: "document",
              request: { method: "GET", url: "https://evil.example.net/page" },
            },
          ],
        },
      },
      { allowedOrigins: staging },
    );

    expect(violations).toEqual([
      { kind: "off-origin-navigation", detail: "https://evil.example.net/page" },
    ]);
  });

  it("flags a write on a read-only plan and dedupes repeats", () => {
    const violations = analyzeHarViolations(
      {
        log: {
          entries: [
            { request: { method: "POST", url: "https://staging.acmecorp.com/api/x" } },
            { request: { method: "POST", url: "https://staging.acmecorp.com/api/x" } },
            { request: { method: "GET", url: "https://staging.acmecorp.com/api/y" } },
          ],
        },
      },
      { allowedOrigins: staging, readOnly: true },
    );

    expect(violations).toEqual([
      { kind: "unexpected-mutation", detail: "POST /api/x" },
    ]);
  });

  it("ignores writes when the plan is not read-only", () => {
    expect(
      analyzeHarViolations(
        {
          log: {
            entries: [
              { request: { method: "POST", url: "https://staging.acmecorp.com/api/x" } },
            ],
          },
        },
        { allowedOrigins: staging, readOnly: false },
      ),
    ).toEqual([]);
  });

  it("skips mutation analysis with no configured origin to compare against", () => {
    expect(
      analyzeHarViolations(
        {
          log: {
            entries: [
              { request: { method: "POST", url: "https://anything.example/api" } },
            ],
          },
        },
        { allowedOrigins: [], readOnly: true },
      ),
    ).toEqual([]);
  });

  it("fails the verdict with HARNESS_DEFECT on an off-origin navigation", () => {
    const decision = normalizeBrowseDecision(
      { status: "pass", checks: [passing("a")] },
      {
        violations: [
          { kind: "off-origin-navigation", detail: "https://evil.example.net/" },
        ],
      },
    );

    expect(decision.status).toBe("fail");
    expect(decision.cause).toBe("HARNESS_DEFECT");
  });

  it("forces manual_review on an unexpected mutation", () => {
    const decision = normalizeBrowseDecision(
      { status: "pass", checks: [passing("a")] },
      { violations: [{ kind: "unexpected-mutation", detail: "POST /api/x" }] },
    );

    expect(decision.status).toBe("manual_review");
  });

  it("records a capture failure without moving the verdict", () => {
    const decision = normalizeBrowseDecision(
      { checks: [passing("a")] },
      { violations: [{ kind: "capture-failed", detail: "tracing.stop" }] },
    );

    expect(decision.status).toBe("pass");
    expect(decision.violations).toHaveLength(1);
  });
});

describe("evidence manifest", () => {
  it("marks planned checks the agent never reported", () => {
    const { items } = buildEvidenceManifest({
      plannedChecks: ["a", "b"],
      checks: [
        { item: "a", result: "pass", cause: "NONE", detail: "x", evidenceRefs: ["s.png"] },
        { item: "c", result: "fail", cause: "PRODUCT_DEFECT", detail: "y", evidenceRefs: [] },
      ],
    });

    expect(items).toEqual([
      {
        item: "a",
        planned: true,
        addressed: true,
        result: "pass",
        cause: "NONE",
        detail: "x",
        evidenceRefs: ["s.png"],
      },
      {
        item: "b",
        planned: true,
        addressed: false,
        result: "unaddressed",
        cause: "HARNESS_DEFECT",
        detail: "The agent never reported this planned check.",
        evidenceRefs: [],
      },
      {
        item: "c",
        planned: false,
        addressed: true,
        result: "fail",
        cause: "PRODUCT_DEFECT",
        detail: "y",
        evidenceRefs: [],
      },
    ]);
  });
});

describe("turn budget", () => {
  it("scales with the plan and clamps at both ends", () => {
    expect(resolveJudgeTurnBudget(0, undefined)).toBe(20);
    expect(resolveJudgeTurnBudget(3, undefined)).toBe(36);
    expect(resolveJudgeTurnBudget(30, undefined)).toBe(150);
  });

  it("honours an explicit override", () => {
    expect(resolveJudgeTurnBudget(3, "42")).toBe(42);
    expect(resolveJudgeTurnBudget(3, "not-a-number")).toBe(36);
  });
});

describe("isReadOnlyPlan", () => {
  it("is false as soon as one test may interact", () => {
    expect(
      isReadOnlyPlan([
        { liveRunPolicy: "executable-readonly" },
        { liveRunPolicy: "executable-interaction" },
      ]),
    ).toBe(false);
    expect(isReadOnlyPlan([{ liveRunPolicy: "judgment-mock-api" }])).toBe(true);
  });
});

describe("coverage and the evidence manifest agree", () => {
  it("counts a paraphrased title as addressed in both", async () => {
    const { buildCoverage, buildEvidenceManifest } = await import(
      "../judge-verdict.mjs"
    );
    const planned = ["to be: '구독 정보' 섹션이 표시된다"];
    const checks = [
      {
        item: "'구독 정보' 섹션이 표시된다",
        result: "pass",
        detail: 'header reads "구독 정보"',
        cause: "NONE",
        evidenceRefs: [],
      },
    ];

    expect(buildCoverage(planned, checks).addressed).toBe(1);
    const manifest = buildEvidenceManifest({ plannedChecks: planned, checks });
    // Previously the manifest matched by normalized title only, so the same
    // check was "unaddressed" here and a stray unplanned entry as well.
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]).toMatchObject({
      planned: true,
      addressed: true,
      result: "pass",
    });
  });

  it("still lists a check nobody planned", async () => {
    const { buildEvidenceManifest } = await import("../judge-verdict.mjs");
    const manifest = buildEvidenceManifest({
      plannedChecks: ["shows the plan name"],
      checks: [
        { item: "shows the plan name", result: "pass", detail: 'reads "Pro"' },
        { item: "an entirely different thing", result: "fail", detail: "boom" },
      ],
    });

    expect(manifest.items.map(entry => entry.planned)).toEqual([true, false]);
  });
});

describe("account state mismatch", () => {
  it("floors the verdict at manual_review with cause ENVIRONMENT_DEFECT", async () => {
    const { normalizeBrowseDecision } = await import("../judge-verdict.mjs");
    const decision = normalizeBrowseDecision(
      { status: "pass", checks: [passing("shows the plan name")] },
      {
        violations: [
          {
            kind: "account-state-mismatch",
            detail: "the account is INACTIVE, but this page expects ACTIVE",
          },
        ],
      },
    );

    expect(decision.status).toBe("manual_review");
    expect(decision.cause).toBe("ENVIRONMENT_DEFECT");
    expect(decision.summary).toContain("account-state-mismatch");
  });
});
