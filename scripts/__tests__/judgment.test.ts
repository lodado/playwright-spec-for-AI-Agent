// Regression coverage for scripts/judgment.mjs (buildJudgment, renderMarkdown, verdictExitCode).
// Risk: Low (existing, approved behavior; expectations from docs/explanation/how-verdicts-are-decided.md,
// docs/reference/artifacts.md and the CONTRIBUTING exit-code table); no Oracle card.
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_VERDICT_FAIL } from "../errors.mjs";
import { buildJudgment, renderMarkdown, verdictExitCode } from "../judgment.mjs";

const SHOT = "/runs/r1/shot.png";
const planned = (checkId: string, item: string) => ({ checkId, item, uploadFixtures: {}, requiredUploadFixtures: {} });

/** In-memory evidence port: only the listed paths exist, with the given text. */
function memoryIo(files: Record<string, string>) {
  return {
    fileExists: (path: string) => (files[path] ?? "").length > 0,
    readText: (path: string) => files[path] ?? "",
  };
}

const run = {
  runId: "run-1",
  page: "dashboard",
  targetUrl: "https://stage.example.com/dashboard",
  targetPath: "/dashboard",
};
const judgedAt = "2026-10-08T00:00:00.000Z";

function inputs(overrides: Record<string, unknown> = {}) {
  return {
    run,
    plan: {
      plannedChecks: [planned("chk_a", "Open the dashboard")],
      planSource: "spec-live.json",
      specHash: "sha256:abc",
      notApplicable: ["SCN_OTHER"],
    },
    result: {
      raw: {
        status: "pass",
        summary: "All good.",
        checks: [
          { checkId: "chk_a", result: "pass", detail: "Opened.", evidenceRefs: [SHOT] },
        ],
        evidence: ["saw the heading"],
        recommendedAction: "none needed",
        source: "hermes-agent",
      },
      runnerEvidence: { screenshots: [SHOT] },
      violations: [],
    },
    accountState: null,
    judgedAt,
    ...overrides,
  };
}

describe("buildJudgment as a fully evidenced passing run with an in-memory io", () => {
  const judgment = buildJudgment(inputs() as never, { io: memoryIo({ [SHOT]: "png" }) });

  it("to be the run identity and plan provenance the shell stamps and stores", () => {
    expect(judgment).toMatchObject({
      runId: "run-1",
      page: "dashboard",
      judgedAt,
      targetUrl: "https://stage.example.com/dashboard",
      targetPath: "/dashboard",
      planSource: "spec-live.json",
      specHash: "sha256:abc",
      notApplicable: ["SCN_OTHER"],
      accountState: null,
    });
  });

  it("to be a pass with the one planned check addressed and no floor note", () => {
    expect(judgment.status).toBe("pass");
    expect(judgment.summary).toBe("All good.");
    expect(judgment.coverage).toEqual({ planned: 1, addressed: 1, missing: [], missingCheckIds: [], unplannedCheckIds: [] });
    expect(judgment.checks).toHaveLength(1);
    expect(judgment.checks[0]).toMatchObject({ checkId: "chk_a", item: "Open the dashboard", result: "pass", evidenceRefs: [SHOT] });
  });

  it("to be the agent's evidence, action, source and the runner evidence passed through", () => {
    expect(judgment.evidence).toEqual(["saw the heading"]);
    expect(judgment.recommendedAction).toBe("none needed");
    expect(judgment.source).toBe("hermes-agent");
    expect(judgment.runnerEvidence).toEqual({ screenshots: [SHOT] });
    expect("agentMeta" in judgment).toBe(false);
  });
});

describe("buildJudgment as a pass claim whose cited evidence file is empty", () => {
  it("to be manual_review with the check demoted from pass and a floor note", () => {
    const judgment = buildJudgment(inputs() as never, { io: memoryIo({ [SHOT]: "" }) });

    expect(judgment.status).toBe("manual_review");
    expect(judgment.checks[0]).toMatchObject({ result: "manual_review", demotedFrom: "pass" });
    expect(judgment.summary).toContain("Verdict floor applied — ");
    expect(judgment.summary).toContain('"Open the dashboard" passed without citing concrete evidence');
  });
});

describe("buildJudgment as a run judged in an account state nobody asked for", () => {
  it("to be manual_review carrying the mismatch note, with the account state summarized", () => {
    const accountState = { state: "ACTIVE", expected: "TRIAL", mismatch: true, source: "dom", note: "saw ACTIVE not TRIAL", extra: "dropped" };
    const judgment = buildJudgment(inputs({ accountState }) as never, { io: memoryIo({ [SHOT]: "png" }) });

    expect(judgment.status).toBe("manual_review");
    expect(judgment.summary).toContain("account-state-mismatch: saw ACTIVE not TRIAL");
    expect(judgment.accountState).toEqual({ state: "ACTIVE", expected: "TRIAL", mismatch: true, source: "dom", evidence: null });
  });
});

describe("buildJudgment as an agent answer that reports a planned check as failed", () => {
  it("to be fail, believing the agent", () => {
    const raw = { status: "fail", checks: [{ checkId: "chk_a", result: "fail", detail: "Heading missing." }] };
    const judgment = buildJudgment(
      inputs({ result: { raw, runnerEvidence: null, violations: [] } }) as never,
      { io: memoryIo({}) },
    );

    expect(judgment.status).toBe("fail");
    expect(judgment.runnerEvidence).toBeNull();
  });
});

describe("buildJudgment as an agent answer carrying agentMeta", () => {
  it("to be a judgment that keeps agentMeta", () => {
    const agentMeta = { adapter: "hermes", model: "m1", durationMs: 4000 };
    const result = { ...inputs().result, raw: { ...inputs().result.raw, agentMeta } };
    const judgment = buildJudgment(inputs({ result }) as never, { io: memoryIo({ [SHOT]: "png" }) });

    expect(judgment.agentMeta).toEqual(agentMeta);
  });
});

describe("renderMarkdown as a judgment with a floor note and a demoted check", () => {
  const judgment = {
    runId: "run-9",
    page: "settings",
    judgedAt,
    targetPath: "/settings",
    planSource: "spec-live.json",
    source: "hermes-agent",
    status: "manual_review",
    cause: "EVIDENCE_GAP",
    summary: "Looked fine.\n\nVerdict floor applied — \"Save\" passed without citing concrete evidence.",
    recommendedAction: "Re-run with screenshots",
    coverage: { planned: 2, addressed: 1, missing: ["Open the menu"] },
    checks: [
      { checkId: "chk_a", item: "Save", result: "manual_review", demotedFrom: "pass", cause: "EVIDENCE_GAP", detail: "a|b" },
      { checkId: "chk_b", item: "Reset", result: "pass", detail: "ok" },
    ],
    evidence: ["note one"],
    agentMeta: { adapter: "hermes", model: "m1", durationMs: 12400 },
  };
  const markdown = renderMarkdown(judgment);

  it("to be a heading and status, cause, run, page, plan source, coverage lines", () => {
    expect(markdown).toContain("# Hermes QA Judgment — settings");
    expect(markdown).toContain("- Status: **manual_review**");
    expect(markdown).toContain("- Cause: `EVIDENCE_GAP`");
    expect(markdown).toContain("- Run: `run-9` at " + judgedAt);
    expect(markdown).toContain("- Page: `/settings`");
    expect(markdown).toContain("- Plan source: spec-live.json");
    expect(markdown).toContain("- Coverage: 1/2 planned checks addressed");
    expect(markdown).toContain("- Adapter: hermes (m1), 12s");
  });

  it("to be the floor note inside the summary and the unaddressed check listed", () => {
    expect(markdown).toContain('Verdict floor applied — "Save" passed without citing concrete evidence.');
    expect(markdown).toContain("## Unaddressed planned checks\n\n- Open the menu");
  });

  it("to be one table row per check, with the demotion shown and pipes in detail escaped", () => {
    expect(markdown).toContain("| manual_review (was pass) | EVIDENCE_GAP | Save | a\\|b |");
    expect(markdown).toContain("| pass |  | Reset | ok |");
  });

  it("to be the evidence list and the recommended action", () => {
    expect(markdown).toContain("## Evidence\n\n- note one");
    expect(markdown).toContain("## Recommended action\n\nRe-run with screenshots");
  });
});

describe("renderMarkdown as a minimal judgment with nothing optional", () => {
  it("to be 'none' for empty evidence and action, with no checks table or unaddressed section", () => {
    const markdown = renderMarkdown({
      runId: "r", page: "p", judgedAt, targetPath: "/p", planSource: null, source: "s",
      status: "pass", cause: "NONE", summary: "ok", recommendedAction: "",
      coverage: { planned: 0, addressed: 0, missing: [] }, checks: [], evidence: [],
    });

    expect(markdown).toContain("## Evidence\n\n- none");
    expect(markdown).toContain("## Recommended action\n\nnone");
    expect(markdown).not.toContain("## Checks");
    expect(markdown).not.toContain("## Unaddressed planned checks");
    expect(markdown).not.toContain("- Adapter:");
  });
});

describe("renderMarkdown as a judgment with runner-captured evidence", () => {
  it("to be a runner evidence section with paths, counts and violations", () => {
    const markdown = renderMarkdown({
      runId: "r", page: "p", judgedAt, targetPath: "/p", planSource: "x", source: "s",
      status: "fail", cause: "PRODUCT_DEFECT", summary: "bad", recommendedAction: "fix",
      coverage: { planned: 0, addressed: 0, missing: [] }, checks: [], evidence: [],
      runnerEvidence: {
        tracePath: "/t.zip",
        screenshots: ["/a.png", "/b.png"],
        ariaSnapshots: ["/a.aria"],
        violations: [{ kind: "unexpected-mutation", detail: "POST /x" }],
      },
    });

    expect(markdown).toContain("## Runner-captured evidence");
    expect(markdown).toContain("- trace: `/t.zip`");
    expect(markdown).toContain("- screenshots: 2");
    expect(markdown).toContain("- aria snapshots: 1");
    expect(markdown).toContain("- violation: unexpected-mutation — POST /x");
  });
});

describe("verdictExitCode as the CI gate over a judged status", () => {
  it.each([
    ["pass", "fail", EXIT_OK],
    ["fail", "fail", EXIT_VERDICT_FAIL],
    ["manual_review", "fail", EXIT_OK],
    ["skip", "fail", EXIT_OK],
    ["error", "fail", EXIT_OK],
    ["pass", "manual_review", EXIT_OK],
    ["fail", "manual_review", EXIT_VERDICT_FAIL],
    ["manual_review", "manual_review", EXIT_VERDICT_FAIL],
    ["skip", "manual_review", EXIT_OK],
    ["error", "manual_review", EXIT_OK],
    ["pass", "never", EXIT_OK],
    ["fail", "never", EXIT_OK],
    ["manual_review", "never", EXIT_OK],
  ])("to be the documented code for status %s under --fail-on=%s", (status, failOn, code) => {
    expect(verdictExitCode(status, failOn)).toBe(code);
  });

  it("to be the documented numbers 0 and 1", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_VERDICT_FAIL).toBe(1);
  });
});
