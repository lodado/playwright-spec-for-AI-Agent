import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CTRF_SPEC_VERSION, ctrfStatus, toCtrf, writeCtrf } from "../qa-ctrf.mjs";
import {
  appendVerdict,
  flakinessReport,
  readHistory,
  stableVerdict,
} from "../qa-verdict-history.mjs";
import {
  appendStepSummary,
  renderChecksTable,
  renderJudgmentSummary,
  renderRunTable,
} from "../github-summary.mjs";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "qa-output-formats-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  delete process.env.GITHUB_STEP_SUMMARY;
});

const judgment = {
  schemaVersion: 1,
  artifactKind: "judgment",
  runId: "run-abc123",
  page: "dashboard",
  judgedAt: "2026-01-02T03:04:05.000Z",
  targetUrl: "https://staging.acmecorp.com/dashboard",
  targetPath: "/dashboard",
  specHash: "sha256:aaa",
  status: "fail",
  cause: "PRODUCT_DEFECT",
  summary: "Filter chips do not clear.",
  recommendedAction: "File a bug against the dashboard filters.",
  source: "hermes",
  agentMeta: { adapter: "hermes", model: "opus", durationMs: 5000 },
  checks: [
    {
      item: "renders KPI cards",
      result: "pass",
      detail: "four cards visible",
      confidence: "high",
      cause: "NONE",
      evidenceRefs: ["shot-1.png"],
    },
    { item: "clears filters", result: "fail", detail: "chip | stays active" },
    { item: "exports CSV", result: "skip", detail: "" },
    { item: "toast copy", result: "manual_review", detail: "wording unclear" },
    { item: "legacy probe", result: "weird-new-status", detail: "" },
  ],
  coverage: { planned: 6, addressed: 5, missing: ["date range"] },
  evidence: ["/tmp/out/evidence/shot-1.png"],
  runnerEvidence: null,
};

describe("CTRF projection", () => {
  it("maps every judgment result onto a CTRF status", () => {
    expect(ctrfStatus("pass")).toBe("passed");
    expect(ctrfStatus("fail")).toBe("failed");
    expect(ctrfStatus("skip")).toBe("skipped");
    expect(ctrfStatus("manual_review")).toBe("other");
    expect(ctrfStatus("something-new")).toBe("other");
    expect(ctrfStatus(undefined)).toBe("other");
  });

  it("produces a schema-shaped report whose summary counts add up", () => {
    const report = toCtrf(judgment, { page: "dashboard" });

    expect(report.reportFormat).toBe("CTRF");
    expect(report.specVersion).toBe(CTRF_SPEC_VERSION);
    expect(report.reportId).toBe("run-abc123");
    expect(report.results.tool).toMatchObject({ name: "hermes", version: "opus" });

    const { summary, tests } = report.results;
    expect(summary.tests).toBe(tests.length);
    expect(
      summary.passed + summary.failed + summary.pending + summary.skipped + summary.other
    ).toBe(summary.tests);
    expect(summary).toMatchObject({ passed: 1, failed: 1, skipped: 1, other: 2 });
    expect(summary.stop - summary.start).toBe(5000);
    expect(summary.stop).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
  });

  it("carries detail, cause, confidence and evidence refs without inventing top-level fields", () => {
    const { tests } = toCtrf(judgment, { page: "dashboard" }).results;
    const [first, failing, , manual] = tests;

    expect(first).toMatchObject({
      name: "renders KPI cards",
      status: "passed",
      duration: 0,
      rawStatus: "pass",
      extra: { cause: "NONE", confidence: "high", evidenceRefs: ["shot-1.png"] },
    });
    expect(failing.message).toBe("chip | stays active");
    expect(manual).toMatchObject({ status: "other", message: "wording unclear" });
    // A check with no detail carries no empty message key.
    expect(tests[2]).not.toHaveProperty("message");
    expect(Object.keys(first)).toEqual(
      expect.arrayContaining(["name", "status", "duration"])
    );
  });

  it("keeps judgment-only fields under results.extra", () => {
    const { extra, environment } = toCtrf(judgment, { page: "dashboard" }).results;
    expect(extra).toMatchObject({
      page: "dashboard",
      status: "fail",
      cause: "PRODUCT_DEFECT",
      specHash: "sha256:aaa",
      coverage: { planned: 6, addressed: 5 },
    });
    expect(extra).not.toHaveProperty("runnerEvidence");
    expect(environment).toMatchObject({
      reportName: "dashboard QA",
      testEnvironment: "https://staging.acmecorp.com/dashboard",
    });
  });

  it("survives an older judgment that has none of the optional fields", () => {
    const report = toCtrf({ status: "pass" }, {});
    expect(report.results.summary).toMatchObject({
      tests: 0,
      passed: 0,
      failed: 0,
      start: 0,
      stop: 0,
      duration: 0,
    });
    expect(report.results.tests).toEqual([]);
    expect(report.results.tool.name).toBe("playwright-spec-for-ai-agent");
    expect(report.results).not.toHaveProperty("environment");
    expect(report).not.toHaveProperty("reportId");
  });

  it("writes the report as JSON", () => {
    const path = join(tempDir(), "report.ctrf.json");
    const written = writeCtrf(path, judgment, { page: "dashboard" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(written);
  });
});

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    judgedAt: "2026-01-01T00:00:00.000Z",
    status: "pass",
    specHash: "sha256:aaa",
    checks: [{ item: "clears filters", result: "pass" }],
    ...overrides,
  };
}

describe("verdict history", () => {
  it("reads an absent history as empty", () => {
    expect(readHistory(join(tempDir(), "missing.json"))).toEqual({ runs: [] });
  });

  it("keeps a bounded ring of the most recent runs", () => {
    const path = join(tempDir(), "history.json");
    for (let index = 0; index < 8; index += 1) {
      appendVerdict(path, verdict({ runId: `run-${index}` }), { keep: 3 });
    }
    const history = readHistory(path);
    expect(history.runs).toHaveLength(3);
    expect(history.runs.map(run => run.runId)).toEqual(["run-5", "run-6", "run-7"]);
    expect(history.artifactKind).toBe("verdict-history");
  });

  it("counts flips only across runs sharing the current specHash", () => {
    const path = join(tempDir(), "history.json");
    // Under the OLD spec the check flipped every night — irrelevant history.
    appendVerdict(path, verdict({ specHash: "sha256:old", status: "pass" }));
    appendVerdict(
      path,
      verdict({
        specHash: "sha256:old",
        status: "fail",
        checks: [{ item: "clears filters", result: "fail" }],
      })
    );
    // Under the CURRENT spec it has been steady.
    appendVerdict(path, verdict({ specHash: "sha256:new" }));
    appendVerdict(path, verdict({ specHash: "sha256:new" }));
    appendVerdict(path, verdict({ specHash: "sha256:new" }));

    const report = flakinessReport(readHistory(path));
    expect(report.specHash).toBe("sha256:new");
    expect(report.summary.runs).toBe(3);
    expect(report.checks).toEqual([
      {
        item: "clears filters",
        runs: 3,
        flips: 0,
        flipRate: 0,
        flaky: false,
        lastResults: ["pass", "pass", "pass"],
      },
    ]);
    expect(report.summary.flakyChecks).toBe(0);
  });

  it("flags a check that flips on an unchanged spec", () => {
    const path = join(tempDir(), "history.json");
    for (const result of ["pass", "fail", "pass", "fail"]) {
      appendVerdict(
        path,
        verdict({ status: result, checks: [{ item: "clears filters", result }] })
      );
    }
    const report = flakinessReport(readHistory(path), { threshold: 0.3 });
    expect(report.checks[0]).toMatchObject({ flips: 3, flipRate: 1, flaky: true });
    expect(report.summary.flakyItems).toEqual(["clears filters"]);
    expect(report.summary.verdictFlaky).toBe(true);
  });

  it("never calls a single run flaky, and tolerates an empty history", () => {
    const empty = flakinessReport({ runs: [] });
    expect(empty).toMatchObject({ specHash: null, checks: [] });
    expect(empty.summary).toMatchObject({ runs: 0, flakyChecks: 0 });

    const path = join(tempDir(), "history.json");
    appendVerdict(path, verdict());
    expect(flakinessReport(readHistory(path)).checks[0]).toMatchObject({
      runs: 1,
      flipRate: 0,
      flaky: false,
    });
  });

  it("requires a full sample with a strict majority before calling a verdict stable", () => {
    const path = join(tempDir(), "history.json");
    appendVerdict(path, verdict({ status: "pass" }));
    appendVerdict(path, verdict({ status: "pass" }));
    // Two of three samples: not enough runs yet.
    expect(stableVerdict(readHistory(path), { samples: 3 })).toMatchObject({
      unstable: true,
      considered: 2,
    });

    appendVerdict(path, verdict({ status: "fail" }));
    // pass, pass, fail — 2-of-3 agreement is the rule, so this is stable.
    expect(stableVerdict(readHistory(path), { samples: 3 })).toMatchObject({
      verdict: "pass",
      agreement: 2 / 3,
      unstable: false,
    });
  });

  it("reports unstable when the last runs disagree without a majority", () => {
    const path = join(tempDir(), "history.json");
    appendVerdict(path, verdict({ status: "pass" }));
    appendVerdict(path, verdict({ status: "fail" }));
    appendVerdict(path, verdict({ status: "manual_review" }));

    expect(stableVerdict(readHistory(path), { samples: 3 })).toMatchObject({
      agreement: 1 / 3,
      unstable: true,
    });
    expect(stableVerdict({ runs: [] })).toMatchObject({
      verdict: null,
      unstable: true,
      considered: 0,
    });
  });
});

describe("GitHub step summary", () => {
  it("is a no-op when GITHUB_STEP_SUMMARY is unset", () => {
    expect(appendStepSummary("# nothing to see")).toBe(false);
  });

  it("appends to the file GITHUB_STEP_SUMMARY points at", () => {
    const path = join(tempDir(), "summary.md");
    process.env.GITHUB_STEP_SUMMARY = path;

    expect(appendStepSummary("### first")).toBe(true);
    expect(appendStepSummary("### second")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("### first\n\n### second\n\n");
  });

  it("never throws on an unwritable summary path", () => {
    process.env.GITHUB_STEP_SUMMARY = join(tempDir(), "nope", "summary.md");
    expect(appendStepSummary("### orphan")).toBe(false);
  });

  it("truncates the check table and escapes cell separators", () => {
    const checks = Array.from({ length: 14 }, (_, index) => ({
      item: `check ${index}`,
      result: "fail",
      detail: "a | b\nc",
    }));
    const markdown = renderChecksTable(checks, { limit: 3 });
    expect(markdown.split("\n").filter(line => line.startsWith("| check"))).toHaveLength(3);
    expect(markdown).toContain("+11 more");
    expect(markdown).toContain("a \\| b c");
  });

  it("returns an empty string rather than an empty table", () => {
    expect(renderChecksTable([])).toBe("");
    expect(renderChecksTable(undefined)).toBe("");
    expect(renderRunTable([])).toBe("");
  });

  it("renders a run table defensively", () => {
    const markdown = renderRunTable([
      { page: "dashboard", status: "fail", failed: 2, total: 7, runId: "run-abc" },
      {},
    ]);
    expect(markdown).toContain("| dashboard | fail | 2/7 failing | run-abc |");
    expect(markdown).toContain("| (unknown) | unknown | — | — |");
  });

  it("renders a judgment with status, checks, coverage and evidence names", () => {
    const markdown = renderJudgmentSummary(judgment, { page: "dashboard" });
    expect(markdown).toContain("### dashboard QA — FAIL");
    expect(markdown).toContain("**Cause:** PRODUCT_DEFECT");
    expect(markdown).toContain("run `run-abc123`");
    expect(markdown).toContain("| clears filters | fail |");
    expect(markdown).toContain("**Coverage:** 5/6 addressed — missing: date range");
    expect(markdown).toContain("**Evidence:** shot-1.png");
  });

  it("renders an empty or unknown judgment without throwing", () => {
    expect(renderJudgmentSummary({}, {})).toContain("QA — UNKNOWN");
    expect(renderJudgmentSummary(undefined, {})).toContain("**Status:** unknown");
    expect(renderJudgmentSummary(null, { page: "pricing" })).toContain("### pricing QA");
  });
});
