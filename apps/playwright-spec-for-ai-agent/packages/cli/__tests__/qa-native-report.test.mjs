import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { EXECUTION_ACTION_PROPOSAL_VERSION, EXECUTION_AGENT_OUTCOME_VERSION, JUDGE_RESULT_VERSION, PATCH_PROPOSAL_VERSION, PROVIDER_CAPABILITIES_VERSION, RUNTIME_OUTCOME_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { createAdaptiveExecutionInput, createExecutionPlan } from "../../core/index.mjs";
import { createInMemoryEvidenceStore, writeEvidenceArchive } from "../../evidence/index.mjs";
import { playwrightBrowserToolCapabilities, playwrightExecutionCapabilities } from "../../provider-playwright/index.mjs";
import { publishIssueQaNative } from "../qa-native-publish-issue.mjs";
import { proposePatchQaNative } from "../qa-native-propose-patch.mjs";
import { reportQaNative } from "../qa-native-report.mjs";
import { writeAuthenticatedRunEnvelope } from "../qa-native-run-envelope.mjs";
import { createExclusiveQaDirectory, runQaNative, writePrivateJsonExclusive } from "../qa-native.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x63);
const publicationKey = Buffer.alloc(32, 0x64);
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
    const workingCopy = "export function Dashboard() { return <h1>Uncommitted replacement</h1>; }\n";
    writeFileSync(join(fixture.cwd, "src", "Dashboard.jsx"), workingCopy);
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
      repositoryRevision: fixture.revision,
    });
    const codeContext = readJson(join(reportDirectory, files.find((file) => file.startsWith("code-context-"))));
    expect(codeContext.snippets[0].text).toContain("Welcome Dashboard");
    expect(codeContext.snippets[0].text).not.toContain("Uncommitted replacement");
    const markdown = readFileSync(join(reportDirectory, files.find((file) => file.endsWith(".md"))), "utf8");
    expect(markdown).toContain("src/Dashboard.jsx");
    expect(markdown).toContain("SUGGESTION_ONLY");
    expect(readJson(join(reportDirectory, "run.json"))).toEqual({ schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "report", type: "COMPLETED" });
    expect(readFileSync(join(fixture.cwd, "src", "Dashboard.jsx"), "utf8")).toBe(workingCopy);
  });

  it("reports the final adaptive checkpoint without requiring judgments for intermediate actions", async () => {
    const fixture = persistedFailedRun({ adaptive: true });

    expect(await dispatch(fixture.cwd)).toBe(0);
    expect(readdirSync(completedReportDirectory(fixture.runDirectory)).some((file) => file.endsWith(".md"))).toBe(true);
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

  it("requires a completed unambiguous judgment set unless a result is selected explicitly", async () => {
    const incomplete = persistedFailedRun();
    rmSync(join(incomplete.judgmentDirectory, "run.json"));
    expect(await dispatch(incomplete.cwd)).toBe(1);
    expect(existsSync(join(incomplete.runDirectory, "reports"))).toBe(false);

    const multiple = persistedFailedRun();
    const secondDirectory = createExclusiveQaDirectory(".qa/runs/run-1/judgments/judge-second", { cwd: multiple.cwd });
    writePrivateJsonExclusive(".qa/runs/run-1/judgments/judge-second/judge-result-fail.json", multiple.judgment, { cwd: multiple.cwd });
    writePrivateJsonExclusive(".qa/runs/run-1/judgments/judge-second/run.json", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "COMPLETED" }, { cwd: multiple.cwd });
    expect(await dispatch(multiple.cwd)).toBe(1);
    expect(existsSync(join(multiple.runDirectory, "reports"))).toBe(false);
    expect(await dispatch(multiple.cwd, { judgment: "judgments/judge-second/judge-result-fail.json" })).toBe(0);
    expect(existsSync(secondDirectory)).toBe(true);

    const duplicate = persistedFailedRun();
    writePrivateJsonExclusive(".qa/runs/run-1/judgments/judge-fixture/judge-result-duplicate.json", duplicate.judgment, { cwd: duplicate.cwd });
    expect(await dispatch(duplicate.cwd)).toBe(1);
    expect(existsSync(join(duplicate.runDirectory, "reports"))).toBe(false);

    const linked = persistedFailedRun();
    symlinkSync(linked.judgmentDirectory, join(linked.runDirectory, "judgments", "linked"));
    expect(await dispatch(linked.cwd)).toBe(1);
    expect(existsSync(join(linked.runDirectory, "reports"))).toBe(false);
  });
});

describe("qa-native PatchProposal generation", () => {
  it("re-derives one authenticated failure and persists a proposal without repository mutation", async () => {
    const fixture = persistedFailedRun();
    const sourcePath = join(fixture.cwd, "src", "Dashboard.jsx");
    const before = readFileSync(sourcePath);
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.cwd, encoding: "utf8" }).trim();

    expect(await dispatchProposal(fixture.cwd)).toBe(0);

    const directory = completedProposalDirectory(fixture.runDirectory);
    expect(readdirSync(directory).sort()).toEqual(["model-output.json", "patch-proposal.json", "run.json"]);
    expect(readJson(join(directory, "patch-proposal.json"))).toMatchObject({ schemaVersion: PATCH_PROPOSAL_VERSION, baseRevision: fixture.revision, files: [{ path: "src/Dashboard.jsx", action: "MODIFY" }] });
    expect(readJson(join(directory, "run.json"))).toEqual({ schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "propose-patch", type: "COMPLETED" });
    expect(readFileSync(sourcePath)).toEqual(before);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.cwd, encoding: "utf8" }).trim()).toBe(revision);
    expect(existsSync(join(fixture.runDirectory, "worktrees"))).toBe(false);
    expect(existsSync(join(fixture.runDirectory, "publications"))).toBe(false);
  });
});

describe("qa-native GitHub Issue publication", () => {
  it("publishes one verified failure and persists only the bounded result", async () => {
    const fixture = persistedFailedRun();
    const githubTransport = fakeGitHubTransport();

    expect(await dispatchIssue(fixture.cwd, githubTransport)).toBe(0);

    expect(githubTransport.verifyCodeContext).toHaveBeenCalledWith(expect.objectContaining({ repository: "owner/example", revision: fixture.revision }));
    const directory = completedPublicationDirectory(fixture.runDirectory);
    expect(readdirSync(directory).sort()).toEqual(["github-publication-intent.json", "github-publication-result.json"]);
    expect(readJson(join(directory, "github-publication-result.json"))).toMatchObject({
      repository: "owner/example",
      publication: "ISSUE",
      action: "CREATED",
      target: { publication: "ISSUE", number: 42, url: "https://github.com/owner/example/issues/42" },
    });
  });

  it("removes its guard before remote mutation but retains it after any remote attempt", async () => {
    const rejected = persistedFailedRun();
    expect(await dispatchIssue(rejected.cwd, fakeGitHubTransport({ verifyCodeContext: vi.fn(async () => false) }))).toBe(1);
    expect(readdirSync(join(rejected.runDirectory, "publications"))).toEqual([]);

    const failed = persistedFailedRun();
    expect(await dispatchIssue(failed.cwd, fakeGitHubTransport({ createIssue: vi.fn(async () => { throw new Error("provider-secret"); }) }))).toBe(1);
    expect(existsSync(completedPublicationDirectory(failed.runDirectory))).toBe(true);

    const uncertain = persistedFailedRun();
    const transport = fakeGitHubTransport({
      createIssue: vi.fn(async () => {
        const directory = completedPublicationDirectory(uncertain.runDirectory);
        writeFileSync(join(directory, "github-publication-result.json"), "occupied");
        return { number: 42, url: "https://github.com/owner/example/issues/42" };
      }),
    });
    expect(await dispatchIssue(uncertain.cwd, transport)).toBe(1);
    expect(existsSync(completedPublicationDirectory(uncertain.runDirectory))).toBe(true);
  });

  it("rejects non-failing judgments before creating publication state", async () => {
    const fixture = persistedFailedRun();
    fixture.judgment.verdict = "PASS";
    fixture.judgment.expectationResults[0].status = "MATCHED";
    writeFileSync(join(fixture.judgmentDirectory, "judge-result-fail.json"), `${JSON.stringify(fixture.judgment)}\n`);

    expect(await dispatchIssue(fixture.cwd, fakeGitHubTransport())).toBe(1);
    expect(existsSync(join(fixture.runDirectory, "publications"))).toBe(false);
  });

  it("rejects ambiguous multi-failure publication before creating remote state", async () => {
    const fixture = persistedFailedRun({ strictFailureCount: 2 });
    const githubTransport = fakeGitHubTransport();

    expect(await dispatchIssue(fixture.cwd, githubTransport)).toBe(1);
    expect(githubTransport.verifyCodeContext).not.toHaveBeenCalled();
    expect(githubTransport.createIssue).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.runDirectory, "publications"))).toBe(false);
  });

  it("persists an ambiguous remote fingerprint result without creating another Issue", async () => {
    const fixture = persistedFailedRun();
    let createdBody;
    const githubTransport = fakeGitHubTransport();
    githubTransport.createIssue = vi.fn(async ({ body }) => { createdBody = body; return { number: 4, url: "https://github.com/owner/example/issues/4" }; });
    githubTransport.readPublication = vi.fn(async ({ publication, number, url }) => ({ publication, number, url, body: createdBody }));
    githubTransport.findOpenPublications = vi.fn(async () => []);
    githubTransport.findRecentPublications = vi.fn(async () => [
        { publication: "ISSUE", number: 4, url: "https://github.com/owner/example/issues/4", body: createdBody },
        { publication: "DRAFT_PR", number: 5, url: "https://github.com/owner/example/pull/5", body: createdBody },
      ]);

    expect(await dispatchIssue(fixture.cwd, githubTransport)).toBe(1);
    const result = readJson(join(completedPublicationDirectory(fixture.runDirectory), "github-publication-result.json"));
    expect(result).toMatchObject({ action: "AMBIGUOUS", publication: "UNRESOLVED" });
    expect(githubTransport.createIssue).toHaveBeenCalledOnce();
    expect(githubTransport.createOccurrenceRecord).toHaveBeenCalledOnce();
  });
});

async function dispatch(cwd, { key = integrityKey, stderr = vi.fn(), judgment } = {}) {
  const args = ["report", "--run-dir=.qa/runs/run-1", "--repository-root=."];
  if (judgment) args.push(`--judgment=${judgment}`);
  return runQaNative(args, {
    cwd,
    env: { QA_NATIVE_INTEGRITY_KEY: key.toString("base64") },
    handlers: { report: reportQaNative },
    stdout: vi.fn(),
    stderr,
  });
}

async function dispatchIssue(cwd, githubTransport, { key = integrityKey, stderr = vi.fn() } = {}) {
  return runQaNative(["publish-issue", "--run-dir=.qa/runs/run-1", "--repository-root=.", "--repository=owner/example"], {
    cwd,
    env: { QA_NATIVE_INTEGRITY_KEY: key.toString("base64"), QA_NATIVE_PUBLICATION_KEY: publicationKey.toString("base64") },
    handlers: { "publish-issue": (options) => publishIssueQaNative({ ...options, githubTransport }) },
    stdout: vi.fn(),
    stderr,
  });
}

async function dispatchProposal(cwd, { key = integrityKey, stderr = vi.fn() } = {}) {
  return runQaNative(["propose-patch", "--run-dir=.qa/runs/run-1", "--repository-root=."], {
    cwd,
    env: { QA_NATIVE_INTEGRITY_KEY: key.toString("base64") },
    handlers: { "propose-patch": (options) => proposePatchQaNative(options, { loadPolicy: async () => ({ minimumConfidence: 0.2 }), propose: async ({ diagnosis, codeContext, recommendation }) => {
      const snippet = codeContext.snippets[0];
      return {
        schemaVersion: PATCH_PROPOSAL_VERSION,
        proposalId: "model-proposal",
        diagnosisId: diagnosis.diagnosisId,
        codeContextBundleId: codeContext.bundleId,
        repairRecommendationId: recommendation.recommendationId,
        baseRevision: codeContext.revision,
        intent: recommendation.changes[0].recommendation,
        expectedEffect: recommendation.changes[0].expectedEffect,
        risks: recommendation.changes[0].risks,
        files: [{ path: snippet.path, action: "MODIFY", originalContentHash: snippet.contentHash }],
        operations: [{ type: "REPLACE_RANGE", path: snippet.path, startLine: codeContext.candidates[0].range.start.line, endLine: codeContext.candidates[0].range.start.line, replacement: "export function Dashboard() { return <h1>Dashboard</h1>; }" }],
        verificationPlan: recommendation.verificationPlan,
      };
    } }) },
    stdout: vi.fn(),
    stderr,
  });
}

function fakeGitHubTransport(overrides = {}) {
  const { createIssue, ...rest } = overrides;
  let createdBody;
  const records = [];
  return {
    findOpenPublications: vi.fn(async () => []),
    findRecentPublications: vi.fn(async () => createdBody ? [{ publication: "ISSUE", number: 42, url: "https://github.com/owner/example/issues/42", body: createdBody }] : []),
    readPublication: vi.fn(async ({ publication, number, url }) => ({ publication, number, url, body: createdBody })),
    listOccurrenceRecords: vi.fn(async () => records),
    verifyCodeContext: vi.fn(async () => true),
    createIssue: vi.fn(async (request) => { createdBody = request.body; return createIssue ? createIssue(request) : { number: 42, url: "https://github.com/owner/example/issues/42" }; }),
    createOccurrenceRecord: vi.fn(async ({ body }) => { const record = { id: records.length + 1, url: `https://github.com/owner/example/issues/42#issuecomment-${records.length + 1}`, body, createdAt: "2026-07-26T00:00:00.000Z" }; records.push(record); return record; }),
    ...rest,
  };
}

function persistedFailedRun({ adaptive = false, strictFailureCount = 1 } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-report-"));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "Dashboard.jsx"), "export function Dashboard() { return <h1>Welcome Dashboard</h1>; }\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "src/Dashboard.jsx"], { cwd });
  execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", "fixture"], { cwd });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

  const runDirectory = createExclusiveQaDirectory(".qa/runs/run-1", { cwd });
  const qaIr = compilePlaywrightSpec({ source: source(), sourcePath: "dashboard.spec.ts" }).qaIr;
  const scenario = qaIr.suites[0].scenarios[0];
  const expectation = scenario.expectations[0];
  const input = adaptive ? createAdaptiveExecutionInput({ qaIr, scenarioId: scenario.id, baseUrl: "https://example.test/dashboard", runId: "run-1" }) : undefined;
  const store = createInMemoryEvidenceStore({ providerCapabilities: adaptive ? playwrightBrowserToolCapabilities() : capabilities });
  const bundles = [];
  let manifest;
  for (let index = 0; index < (adaptive ? 2 : strictFailureCount); index += 1) {
    const proposal = adaptive ? { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `proposal-${index}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: index === 1 ? "observe_dom" : "get_current_url", parameters: {} } : undefined;
    const page = input?.currentPage;
    const artifacts = adaptive ? [
      store.captureArtifact({ id: `${proposal.proposalId}:before:dom`, type: "DOM_SNAPSHOT", contentType: "text/html", content: "<main>Welcome Dashboard</main>" }),
      store.captureArtifact({ id: `${proposal.proposalId}:before:aria`, type: "ARIA_SNAPSHOT", contentType: "text/plain", content: "- main: Welcome Dashboard" }),
      store.captureArtifact({ id: `${proposal.proposalId}:action`, type: "ACTION_LOG", contentType: "application/json", content: JSON.stringify({ proposal, status: "ACCEPTED", before: page, after: page }) }),
      store.captureArtifact({ id: `${proposal.proposalId}:after:dom`, type: "DOM_SNAPSHOT", contentType: "text/html", content: "<main>Welcome Dashboard</main>" }),
      store.captureArtifact({ id: `${proposal.proposalId}:after:aria`, type: "ARIA_SNAPSHOT", contentType: "text/plain", content: "- main: Welcome Dashboard" }),
    ] : [store.captureArtifact({ id: `visible-text-${index}`, type: "VISIBLE_TEXT", contentType: "text/plain", content: "Welcome Dashboard" })];
    const bundle = store.createBundle({
      runId: "run-1",
      scenarioId: scenario.id,
      checkpointId: adaptive ? proposal.proposalId : `${scenario.steps.find((step) => step.kind === "CHECKPOINT").checkpointId}-${index}`,
      capturedAt: `2026-07-25T00:00:0${index}.000Z`,
      environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } },
      artifacts,
      facts: [],
    });
    bundles.push(bundle);
    manifest = store.appendCheckpoint(bundle, adaptive ? { stage: "execute" } : undefined);
  }
  const judgedBundles = adaptive ? [bundles.at(-1)] : bundles;
  const judgments = judgedBundles.map((bundle) => {
    const artifact = bundle.artifacts[0];
    const body = {
      schemaVersion: JUDGE_RESULT_VERSION,
      qaIrId: qaIr.id,
      evidenceBundleId: bundle.bundleId,
      verdict: "FAIL",
      confidence: 0.82,
      expectationResults: [{ expectationId: expectation.id, status: "CONTRADICTED", confidence: 0.82, evidenceRefs: [artifact.id], rationale: "Expected dashboard copy is missing." }],
      uncertainty: [],
      judge: { provider: "hermes", model: "fixture", promptVersion: "judge-prompt/0.1" },
      inputHash: canonicalHash({ qaIrId: qaIr.id, evidenceBundleId: bundle.bundleId }),
    };
    return { ...body, resultId: `judge-${canonicalHash(body).slice("sha256:".length, "sha256:".length + 16)}` };
  });
  const judgment = judgments[0];

  writePrivateJsonExclusive(".qa/runs/run-1/qa-ir.json", qaIr, { cwd });
  writeEvidenceArchive({ directory: join(runDirectory, "evidence"), bundles, manifest, readBlob: store.readBlob, integrityKey });
  const runtimeOutcome = { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED" };
  writePrivateJsonExclusive(".qa/runs/run-1/run.json", runtimeOutcome, { cwd });
  if (adaptive) {
    const outcome = { schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION, runId: input.runId, scenarioId: input.scenarioId, type: "COMPLETED", completedMilestoneIds: input.milestones.map((milestone) => milestone.id) };
    writePrivateJsonExclusive(".qa/runs/run-1/execution-agent-inputs.json", [input], { cwd });
    writePrivateJsonExclusive(".qa/runs/run-1/execution-agent-outcomes.json", [outcome], { cwd });
    writeAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey, runId: "run-1", mode: "adaptive", qaIr, runtimeOutcome, evidenceManifest: manifest, executionAgentInputs: [input], executionAgentOutcomes: [outcome] });
  } else {
    const executionPlan = createExecutionPlan({ qaIr, providerCapabilities: playwrightExecutionCapabilities() });
    writePrivateJsonExclusive(".qa/runs/run-1/execution-plan.json", executionPlan, { cwd });
    writeAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey, runId: "run-1", mode: "strict", qaIr, runtimeOutcome, evidenceManifest: manifest, executionPlan });
  }
  const judgmentDirectory = createExclusiveQaDirectory(".qa/runs/run-1/judgments/judge-fixture", { cwd });
  judgments.forEach((result, index) => writePrivateJsonExclusive(`.qa/runs/run-1/judgments/judge-fixture/judge-result-fail${index === 0 ? "" : `-${index}`}.json`, result, { cwd }));
  writePrivateJsonExclusive(".qa/runs/run-1/judgments/judge-fixture/run.json", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "COMPLETED" }, { cwd });
  return { cwd, runDirectory, judgmentDirectory, judgment, revision };
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

function completedPublicationDirectory(runDirectory) {
  const root = join(runDirectory, "publications");
  const directories = readdirSync(root);
  expect(directories).toHaveLength(1);
  return join(root, directories[0]);
}

function completedProposalDirectory(runDirectory) {
  const root = join(runDirectory, "proposals");
  const directories = readdirSync(root);
  expect(directories).toHaveLength(1);
  return join(root, directories[0]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
