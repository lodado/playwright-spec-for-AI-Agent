import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { EXECUTION_ACTION_PROPOSAL_VERSION, EXECUTION_AGENT_OUTCOME_VERSION, PROVIDER_CAPABILITIES_VERSION, RUNTIME_OUTCOME_VERSION, validateContract } from "../../contracts/index.mjs";
import { createAdaptiveExecutionInput, createExecutionPlan } from "../../core/index.mjs";
import { createInMemoryEvidenceStore, writeEvidenceArchive } from "../../evidence/index.mjs";
import { judgeWithHermes } from "../../provider-hermes/index.mjs";
import { playwrightBrowserToolCapabilities, playwrightExecutionCapabilities } from "../../provider-playwright/index.mjs";
import { judgeQaNative } from "../qa-native-judge.mjs";
import { writeAuthenticatedRunEnvelope } from "../qa-native-run-envelope.mjs";
import { createExclusiveQaDirectory, runQaNative, writePrivateJsonExclusive } from "../qa-native.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x61);
const capabilities = Object.freeze({
  schemaVersion: PROVIDER_CAPABILITIES_VERSION,
  providerId: "fixture-provider",
  actions: [],
  evidence: ["VISIBLE_TEXT"],
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("qa-native offline judge", () => {
  it("judges every persisted bundle without reopening a browser", async () => {
    const fixture = persistedRun({ scenarioCount: 2, deterministic: true });
    const transport = vi.fn();
    expect(await dispatch(fixture.cwd, {
      judge: (args) => judgeWithHermes({ ...args, transport, model: "hermes-test" }),
    })).toBe(0);

    expect(transport).not.toHaveBeenCalled();
    const directory = completedJudgmentDirectory(fixture.runDirectory);
    const resultFiles = readdirSync(directory).filter((file) => file.startsWith("judge-result-"));
    expect(resultFiles).toHaveLength(2);
    for (const file of resultFiles) {
      const result = readJson(join(directory, file));
      const bundle = fixture.bundles.find((candidate) => candidate.bundleId === result.evidenceBundleId);
      expect(validateContract("JudgeResult", result, { qaIr: fixture.qaIr, evidenceBundle: bundle }).verdict).toBe("PASS");
    }
    expect(readJson(join(directory, "run.json"))).toEqual({ schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "COMPLETED" });
    expect(readFileSync(new URL("../qa-native-judge.mjs", import.meta.url), "utf8")).not.toContain("provider-playwright");
  });

  it("routes only unresolved expectations through Hermes text-only", async () => {
    const fixture = persistedRun({ deterministic: false });
    const transport = vi.fn(async () => ({
      expectationResults: [{
        expectationId: fixture.expectationIds[0],
        status: "MATCHED",
        confidence: 0.8,
        evidenceRefs: [fixture.bundles[0].artifacts[0].id],
        rationale: "Visible evidence supports the expectation.",
      }],
      uncertainty: [],
    }));

    expect(await dispatch(fixture.cwd, {
      judge: (args) => judgeWithHermes({ ...args, transport, model: "hermes-test" }),
    })).toBe(0);
    const [query, maxTurns, options] = transport.mock.calls[0];
    expect(query).toContain("Do not browse");
    expect(maxTurns).toBeLessThanOrEqual(3);
    expect(options).toMatchObject({ mode: "text-only" });
    const directory = completedJudgmentDirectory(fixture.runDirectory);
    const resultFile = readdirSync(directory).find((file) => file.startsWith("judge-result-"));
    expect(readJson(join(directory, resultFile))).toMatchObject({ verdict: "PASS", judge: { provider: "hermes" } });
  });

  it("judges only the final adaptive checkpoint while retaining the full evidence archive", async () => {
    const fixture = persistedRun({ deterministic: true, checkpointsPerScenario: 2, adaptive: true });
    const judge = vi.fn((args) => judgeWithHermes({ ...args, transport: vi.fn(), model: "hermes-test" }));

    expect(await dispatch(fixture.cwd, { judge })).toBe(0);

    expect(judge).toHaveBeenCalledOnce();
    expect(judge.mock.calls[0][0].bundle.bundleId).toBe(fixture.bundles.at(-1).bundleId);
    expect(fixture.bundles).toHaveLength(2);
    const resultFiles = readdirSync(completedJudgmentDirectory(fixture.runDirectory)).filter((file) => file.startsWith("judge-result-"));
    expect(resultFiles).toHaveLength(1);
  });

  it("rejects unauthenticated evidence and multi-bundle provider failures without partial output", async () => {
    const unauthenticated = persistedRun({ deterministic: true });
    const stderr = vi.fn();
    expect(await dispatch(unauthenticated.cwd, {}, { key: Buffer.alloc(32, 0x62), stderr })).toBe(1);
    expect(existsSync(join(unauthenticated.runDirectory, "judgments"))).toBe(false);
    expect(stderr).toHaveBeenCalledWith("qa-native: command failed\n");

    const failed = persistedRun({ scenarioCount: 2, deterministic: true });
    let calls = 0;
    expect(await dispatch(failed.cwd, { judge: async (args) => {
      calls += 1;
      if (calls === 2) return { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "judge", type: "ERROR", code: "MODEL_PROVIDER_FAILED", message: "Semantic judge provider failed" };
      return judgeWithHermes({ ...args, transport: vi.fn(), model: "hermes-test" });
    } })).toBe(1);
    expect(calls).toBe(2);
    expect(existsSync(join(failed.runDirectory, "judgments"))).toBe(false);
  });

  it("rejects valid JSON metadata that no longer matches the authenticated run envelope", async () => {
    const strict = persistedRun({ deterministic: true });
    const strictQaIr = readJson(join(strict.runDirectory, "qa-ir.json"));
    strictQaIr.suites[0].scenarios[0].title = "Tampered strict meaning";
    writeFileSync(join(strict.runDirectory, "qa-ir.json"), JSON.stringify(strictQaIr));
    expect(await dispatch(strict.cwd)).toBe(1);
    expect(existsSync(join(strict.runDirectory, "judgments"))).toBe(false);

    const adaptive = persistedRun({ deterministic: true, checkpointsPerScenario: 2, adaptive: true });
    const input = readJson(join(adaptive.runDirectory, "execution-agent-input.json"));
    input.goal.description = "Tampered adaptive meaning";
    writeFileSync(join(adaptive.runDirectory, "execution-agent-input.json"), JSON.stringify(input));
    expect(await dispatch(adaptive.cwd)).toBe(1);
    expect(existsSync(join(adaptive.runDirectory, "judgments"))).toBe(false);

    const authentication = persistedRun({ deterministic: true });
    const envelope = readJson(join(authentication.runDirectory, "run-envelope.json"));
    envelope.authentication = `hmac-sha256:${"0".repeat(64)}`;
    writeFileSync(join(authentication.runDirectory, "run-envelope.json"), JSON.stringify(envelope));
    expect(await dispatch(authentication.cwd)).toBe(1);
    expect(existsSync(join(authentication.runDirectory, "judgments"))).toBe(false);
  });

  it("keeps completed judgment sets immutable", async () => {
    const fixture = persistedRun({ deterministic: true });
    expect(await dispatch(fixture.cwd)).toBe(0);
    const directory = completedJudgmentDirectory(fixture.runDirectory);
    const before = readdirSync(directory).sort();
    expect(await dispatch(fixture.cwd)).toBe(1);
    expect(readdirSync(directory).sort()).toEqual(before);
  });
});

async function dispatch(cwd, overrides = {}, { key = integrityKey, stderr = vi.fn() } = {}) {
  return runQaNative(["judge", "--run-dir=.qa/runs/run-1"], {
    cwd,
    env: { QA_NATIVE_INTEGRITY_KEY: key.toString("base64") },
    handlers: { judge: (args) => judgeQaNative(args, overrides) },
    stdout: vi.fn(),
    stderr,
  });
}

function persistedRun({ scenarioCount = 1, checkpointsPerScenario = 1, deterministic, adaptive = false }) {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-judge-"));
  temporaryDirectories.push(cwd);
  const runDirectory = createExclusiveQaDirectory(".qa/runs/run-1", { cwd });
  const qaIr = compilePlaywrightSpec({ source: sourceFor(scenarioCount), sourcePath: "dashboard.spec.ts" }).qaIr;
  const adaptiveInput = adaptive ? createAdaptiveExecutionInput({ qaIr, scenarioId: qaIr.suites[0].scenarios[0].id, baseUrl: "https://example.test/dashboard", runId: "run-1" }) : undefined;
  const store = createInMemoryEvidenceStore({ providerCapabilities: adaptive ? playwrightBrowserToolCapabilities() : capabilities });
  const bundles = [];
  const expectationIds = [];
  let manifest;
  for (const [index, scenario] of qaIr.suites[0].scenarios.entries()) {
    const expectation = scenario.expectations[0];
    expectationIds.push(expectation.id);
    for (let checkpointIndex = 0; checkpointIndex < checkpointsPerScenario; checkpointIndex += 1) {
      const proposal = adaptive ? {
        schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
        proposalId: `proposal-${checkpointIndex}`,
        runId: adaptiveInput.runId,
        scenarioId: adaptiveInput.scenarioId,
        milestoneId: adaptiveInput.currentMilestoneId,
        leaseId: adaptiveInput.capabilityLease.leaseId,
        action: checkpointIndex === checkpointsPerScenario - 1 ? "observe_dom" : "get_current_url",
        parameters: {},
      } : undefined;
      const page = adaptiveInput?.currentPage;
      const artifacts = adaptive ? [
        store.captureArtifact({ id: `${proposal.proposalId}:before:dom`, type: "DOM_SNAPSHOT", contentType: "text/html", content: `<button>Dashboard ${index + 1}</button>` }),
        store.captureArtifact({ id: `${proposal.proposalId}:before:aria`, type: "ARIA_SNAPSHOT", contentType: "text/plain", content: `- button: Dashboard ${index + 1}` }),
        store.captureArtifact({ id: `${proposal.proposalId}:action`, type: "ACTION_LOG", contentType: "application/json", content: JSON.stringify({ proposal, status: "ACCEPTED", before: page, after: page }) }),
        store.captureArtifact({ id: `${proposal.proposalId}:after:dom`, type: "DOM_SNAPSHOT", contentType: "text/html", content: `<button>Dashboard ${index + 1}</button>` }),
        store.captureArtifact({ id: `${proposal.proposalId}:after:aria`, type: "ARIA_SNAPSHOT", contentType: "text/plain", content: `- button: Dashboard ${index + 1}` }),
      ] : [store.captureArtifact({ id: `visible-text-${index}-${checkpointIndex}`, type: "VISIBLE_TEXT", contentType: "text/plain", content: `Dashboard ${index + 1}` })];
      const bundle = store.createBundle({
        runId: "run-1",
        scenarioId: scenario.id,
        checkpointId: adaptive ? proposal.proposalId : `${scenario.steps.find((step) => step.kind === "CHECKPOINT").checkpointId}-${checkpointIndex}`,
        capturedAt: `2026-07-25T00:00:${index}${checkpointIndex}.000Z`,
        environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } },
        artifacts,
        facts: deterministic ? [{ id: `visible-${index}-${checkpointIndex}`, kind: "ELEMENT_OBSERVATION", value: { expectationId: expectation.id, resolution: "FOUND", visible: true } }] : [],
      });
      bundles.push(bundle);
      manifest = store.appendCheckpoint(bundle, adaptive ? { stage: "execute" } : undefined);
    }
  }

  writePrivateJsonExclusive(".qa/runs/run-1/qa-ir.json", qaIr, { cwd });
  writeEvidenceArchive({ directory: join(runDirectory, "evidence"), bundles, manifest, readBlob: store.readBlob, integrityKey });
  const runtimeOutcome = { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED" };
  writePrivateJsonExclusive(".qa/runs/run-1/run.json", runtimeOutcome, { cwd });
  if (adaptive) {
    const agentOutcome = { schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION, runId: "run-1", scenarioId: adaptiveInput.scenarioId, type: "COMPLETED", completedMilestoneIds: adaptiveInput.milestones.map((milestone) => milestone.id) };
    writePrivateJsonExclusive(".qa/runs/run-1/execution-agent-input.json", adaptiveInput, { cwd });
    writePrivateJsonExclusive(".qa/runs/run-1/execution-agent-outcome.json", agentOutcome, { cwd });
    writeAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey, runId: "run-1", mode: "adaptive", qaIr, runtimeOutcome, evidenceManifest: manifest, executionAgentInput: adaptiveInput, executionAgentOutcome: agentOutcome });
  } else {
    const executionPlan = createExecutionPlan({ qaIr, providerCapabilities: playwrightExecutionCapabilities() });
    writePrivateJsonExclusive(".qa/runs/run-1/execution-plan.json", executionPlan, { cwd });
    writeAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey, runId: "run-1", mode: "strict", qaIr, runtimeOutcome, evidenceManifest: manifest, executionPlan });
  }
  return { cwd, runDirectory, qaIr, bundles, expectationIds };
}

function sourceFor(count) {
  const tests = Array.from({ length: count }, (_, index) => `  // @qa-live-policy: readonly\n  test("shows dashboard ${index + 1}", async ({ page }) => {\n    await expect(page.getByText("Dashboard ${index + 1}")).toBeVisible();\n  });`).join("\n");
  return `// @qa-scenario: DASHBOARD_READONLY\n\ntest.describe("dashboard", () => {\n${tests}\n});\n`;
}

function completedJudgmentDirectory(runDirectory) {
  const root = join(runDirectory, "judgments");
  const directories = readdirSync(root);
  expect(directories).toHaveLength(1);
  return join(root, directories[0]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
