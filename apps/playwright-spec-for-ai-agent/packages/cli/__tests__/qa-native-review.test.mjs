import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { JUDGE_RESULT_VERSION, JUDGMENT_REVIEW_VERSION, PROVIDER_CAPABILITIES_VERSION, canonicalHash } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { reviewQaNative } from "../qa-native-review.mjs";
import { reportQaNative } from "../qa-native-report.mjs";
import { createExclusiveQaDirectory } from "../qa-native.mjs";

const directories = [];

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("qa-native judgment review", () => {
  it("persists a complete independent review set and gates unapproved judgments", async () => {
    const fixture = reviewFixture();
    const reviewOne = vi.fn(async ({ qaIr, bundle, judgeResult }) => reviewResult({ qaIr, bundle, judgeResult, status: "REVISE" }));
    const loadJudgments = vi.fn(() => [{ result: fixture.judgeResult, bundle: fixture.bundle }]);
    const report = vi.fn();

    const status = await reviewQaNative({ runDirectory: fixture.runDirectory, judgmentPath: join(fixture.runDirectory, "judgments", "selected"), integrityKey: Buffer.alloc(32), cwd: fixture.cwd }, {
      loadExecution: () => ({ qaIr: fixture.qaIr, archive: fixture.archive, bundles: [fixture.bundle] }),
      loadJudgments,
      reviewOne,
      reviewer: async () => ({ status: "REVISE", issues: ["missing proof"] }),
      report,
    });

    expect(status).toBe(1);
    expect(loadJudgments).toHaveBeenCalledWith(expect.objectContaining({ judgmentPath: join(fixture.runDirectory, "judgments", "selected"), requireComplete: true }));
    expect(reviewOne).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ totals: { APPROVED: 0, REVISE: 1, MANUAL_REVIEW: 0 } }));
    const root = join(fixture.runDirectory, "reviews");
    const directory = join(root, readdirSync(root)[0]);
    expect(readdirSync(directory).sort()).toEqual(expect.arrayContaining(["run.json", expect.stringMatching(/^review-result-/)]));
  });

  it("reports unapproved review issues without turning them into remediation", async () => {
    const fixture = reviewFixture();
    const review = reviewResult({ qaIr: fixture.qaIr, bundle: fixture.bundle, judgeResult: fixture.judgeResult, status: "MANUAL_REVIEW", issues: ["# forged\n<script>alert(1)</script>"] });

    await expect(reportQaNative({ runDirectory: fixture.runDirectory, repositoryRoot: fixture.cwd, revision: "HEAD", integrityKey: Buffer.alloc(32), cwd: fixture.cwd }, {
      prepare: () => ({ qaIr: fixture.qaIr, judged: 1, items: [], unapprovedReviews: [review] }),
      reportSummary: vi.fn(),
    })).resolves.toBe(0);

    const root = join(fixture.runDirectory, "reports");
    const directory = join(root, readdirSync(root)[0]);
    expect(readdirSync(directory).sort()).toEqual(expect.arrayContaining(["run.json", expect.stringMatching(/^judgment-review-.*\.json$/), expect.stringMatching(/^judgment-review-.*\.md$/)]));
    const markdownFile = readdirSync(directory).find((file) => file.endsWith(".md"));
    const markdown = readFileSync(join(directory, markdownFile), "utf8");
    expect(markdown).toContain("\\# forged &lt;script&gt;alert\\(1\\)&lt;/script&gt;");
    expect(markdown).not.toContain("\n# forged");
  });
});

function reviewFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-review-"));
  directories.push(cwd);
  const runDirectory = createExclusiveQaDirectory(".qa/runs/run-1", { cwd });
  const qaIr = compilePlaywrightSpec({ source: source(), sourcePath: "dashboard.spec.ts" }).qaIr;
  const scenario = qaIr.suites[0].scenarios[0];
  const expectation = scenario.expectations[0];
  const store = createInMemoryEvidenceStore({ providerCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "fixture", actions: [], evidence: ["VISIBLE_TEXT"] } });
  const artifact = store.captureArtifact({ id: "visible", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Welcome Dashboard" });
  const bundle = store.createBundle({ runId: "run-1", scenarioId: scenario.id, checkpointId: "final", capturedAt: "2026-07-31T00:00:00.000Z", environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } }, artifacts: [artifact], facts: [] });
  const manifest = store.appendCheckpoint(bundle);
  const body = { schemaVersion: JUDGE_RESULT_VERSION, qaIrId: qaIr.id, evidenceBundleId: bundle.bundleId, verdict: "PASS", confidence: 0.8, expectationResults: [{ expectationId: expectation.id, status: "MATCHED", confidence: 0.8, evidenceRefs: [artifact.id], rationale: "Visible evidence matches." }], uncertainty: [], judge: { provider: "hermes", model: "judge", promptVersion: "judge/1" }, inputHash: canonicalHash("judge-input") };
  const judgeResult = { ...body, resultId: `judge-${canonicalHash(body).slice(7, 23)}` };
  return { cwd, runDirectory, qaIr, bundle, judgeResult, archive: { manifest, readBlob: store.readBlob } };
}

function reviewResult({ qaIr, bundle, judgeResult, status, issues = ["missing proof"] }) {
  const body = { schemaVersion: JUDGMENT_REVIEW_VERSION, qaIrId: qaIr.id, evidenceBundleId: bundle.bundleId, judgeResultId: judgeResult.resultId, status, issues: status === "APPROVED" ? [] : issues, reviewer: { provider: "fixture", model: "reviewer", promptVersion: "review/1" }, inputHash: canonicalHash("review-input") };
  return { ...body, reviewId: `review-${canonicalHash(body).slice(7, 23)}` };
}

function source() {
  return `// @qa-scenario: DASHBOARD_READONLY\n\ntest.describe("dashboard", () => {\n  // @qa-live-policy: readonly\n  test("shows dashboard", async ({ page }) => {\n    await expect(page.getByText("Welcome Dashboard")).toBeVisible();\n  });\n});\n`;
}
