import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { JUDGE_RESULT_VERSION, PROVIDER_CAPABILITIES_VERSION, RUNTIME_OUTCOME_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore, writeEvidenceArchive } from "../../evidence/index.mjs";
import { reportQaNative } from "../qa-native-report.mjs";
import { createExclusiveQaDirectory, runQaNative, writePrivateJsonExclusive } from "../qa-native.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x63);
const capabilities = Object.freeze({
  schemaVersion: PROVIDER_CAPABILITIES_VERSION,
  providerId: "fixture-provider",
  actions: [],
  evidence: ["VISIBLE_TEXT"],
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("qa-native repository report", () => {
  it("writes suggestion-only remediation artifacts from persisted evidence and judgment", async () => {
    const fixture = persistedFailedRun();
    expect(await dispatch(fixture.cwd)).toBe(0);

    const reportDirectory = completedReportDirectory(fixture.runDirectory);
    const files = readdirSync(reportDirectory).sort();
    expect(files).toEqual(expect.arrayContaining(["run.json"]));
    const recommendation = readJson(join(reportDirectory, files.find((file) => file.startsWith("repair-recommendation-"))));
    expect(validateContract("RepairRecommendation", recommendation, {
      diagnosis: readJson(join(reportDirectory, files.find((file) => file.startsWith("diagnosis-")))),
      codeContext: readJson(join(reportDirectory, files.find((file) => file.startsWith("code-context-")))),
    })).toMatchObject({
      patchEligibility: "SUGGESTION_ONLY",
      locations: [expect.objectContaining({ path: "src/Dashboard.jsx" })],
    });
    const markdown = readFileSync(join(reportDirectory, files.find((file) => file.endsWith(".md"))), "utf8");
    expect(markdown).toContain("src/Dashboard.jsx");
    expect(markdown).toContain("SUGGESTION_ONLY");
    expect(readJson(join(reportDirectory, "run.json"))).toEqual({ schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "report", type: "COMPLETED" });
  });

  it("rejects wrong evidence keys and keeps report output immutable", async () => {
    const wrongKey = persistedFailedRun();
    const stderr = vi.fn();
    expect(await dispatch(wrongKey.cwd, { key: Buffer.alloc(32, 0x64), stderr })).toBe(1);
    expect(existsSync(join(wrongKey.runDirectory, "reports"))).toBe(false);
    expect(stderr).toHaveBeenCalledWith("qa-native: command failed\n");

    const fixture = persistedFailedRun();
    expect(await dispatch(fixture.cwd)).toBe(0);
    const directory = completedReportDirectory(fixture.runDirectory);
    const before = readdirSync(directory).sort();
    expect(await dispatch(fixture.cwd)).toBe(1);
    expect(readdirSync(directory).sort()).toEqual(before);
  });
});

async function dispatch(cwd, { key = integrityKey, stderr = vi.fn() } = {}) {
  return runQaNative(["report", "--run-dir=.qa/runs/run-1", "--repository-root=."], {
    cwd,
    env: { QA_NATIVE_INTEGRITY_KEY: key.toString("base64") },
    handlers: { report: reportQaNative },
    stdout: vi.fn(),
    stderr,
  });
}

function persistedFailedRun() {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-report-"));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "Dashboard.jsx"), "export function Dashboard() { return <h1>Welcome Dashboard</h1>; }\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "src/Dashboard.jsx"], { cwd });
  execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", "fixture"], { cwd });

  const runDirectory = createExclusiveQaDirectory(".qa/runs/run-1", { cwd });
  const qaIr = compilePlaywrightSpec({ source: source(), sourcePath: "dashboard.spec.ts" }).qaIr;
  const scenario = qaIr.suites[0].scenarios[0];
  const expectation = scenario.expectations[0];
  const store = createInMemoryEvidenceStore({ providerCapabilities: capabilities });
  const artifact = store.captureArtifact({ id: "visible-text-0", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Welcome Dashboard" });
  const bundle = store.createBundle({
    runId: "run-1",
    scenarioId: scenario.id,
    checkpointId: scenario.steps.find((step) => step.kind === "CHECKPOINT").checkpointId,
    capturedAt: "2026-07-25T00:00:00.000Z",
    environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } },
    artifacts: [artifact],
    facts: [],
  });
  const manifest = store.appendCheckpoint(bundle);
  const judgment = {
    schemaVersion: JUDGE_RESULT_VERSION,
    resultId: "judge-fail",
    qaIrId: qaIr.id,
    evidenceBundleId: bundle.bundleId,
    verdict: "FAIL",
    confidence: 0.82,
    expectationResults: [{ expectationId: expectation.id, status: "CONTRADICTED", confidence: 0.82, evidenceRefs: [artifact.id], rationale: "Expected dashboard copy is missing." }],
    uncertainty: [],
    judge: { provider: "hermes", model: "fixture", promptVersion: "judge-prompt/0.1" },
    inputHash: canonicalHash({ qaIrId: qaIr.id, evidenceBundleId: bundle.bundleId }),
  };

  writePrivateJsonExclusive(".qa/runs/run-1/qa-ir.json", qaIr, { cwd });
  writeEvidenceArchive({ directory: join(runDirectory, "evidence"), bundles: [bundle], manifest, readBlob: store.readBlob, integrityKey });
  writePrivateJsonExclusive(".qa/runs/run-1/run.json", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED" }, { cwd });
  createExclusiveQaDirectory(".qa/runs/run-1/judgments/judge-fixture", { cwd });
  writePrivateJsonExclusive(".qa/runs/run-1/judgments/judge-fixture/judge-result-fail.json", judgment, { cwd });
  writePrivateJsonExclusive(".qa/runs/run-1/judgments/judge-fixture/run.json", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "COMPLETED" }, { cwd });
  return { cwd, runDirectory };
}

function source() {
  return `// @qa-scenario: DASHBOARD_READONLY

test.describe("dashboard", () => {
  // @qa-live-policy: readonly
  test("shows dashboard", async ({ page }) => {
    await expect(page.getByText("Welcome Dashboard")).toBeVisible();
  });
});
`;
}

function completedReportDirectory(runDirectory) {
  const root = join(runDirectory, "reports");
  const directories = readdirSync(root);
  expect(directories).toHaveLength(1);
  return join(root, directories[0]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
