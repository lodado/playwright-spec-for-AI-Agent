import { createServer } from "node:http";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXECUTION_ACTION_PROPOSAL_VERSION, EXECUTION_AGENT_INPUT_VERSION, RUNTIME_OUTCOME_VERSION, validateContract } from "../../contracts/index.mjs";
import { createAdaptiveExecutionInput, DEFAULT_ADAPTIVE_BUDGET } from "../../core/index.mjs";
import { createInMemoryEvidenceStore, readEvidenceArchive } from "../../evidence/index.mjs";
import { playwrightExecutionCapabilities, runAdaptiveSuiteWithPlaywright, runAdaptiveWithPlaywright } from "../../provider-playwright/index.mjs";
import { compilePlaywrightSpec } from "../../adapter-playwright/index.mjs";
import { executeQaNative, mergeCompileResults } from "../qa-native-execute.mjs";
import { runQaNative } from "../qa-native.mjs";

describe("mergeCompileResults", () => {
  const compileSource = (scenario, sourcePath) => compilePlaywrightSpec({
    source: `// @qa-scenario: ${scenario}\ntest.describe("${scenario}", () => {\n  // @qa-live-policy: readonly\n  test("t", async ({ page }) => { await expect(page.getByText("X")).toBeVisible(); });\n});\n`,
    sourcePath,
  });

  it("unions the scenarios of every compiled spec into one QA IR", () => {
    const merged = mergeCompileResults([compileSource("A", "dir/a.spec.ts"), compileSource("B", "dir/b.spec.ts")]);
    expect(merged.ok).toBe(true);
    expect(merged.qaIr.suites).toHaveLength(2);
    expect(merged.qaIr.suites.flatMap((suite) => suite.scenarios)).toHaveLength(2);
    expect(merged.qaIr.id).toMatch(/^qa-ir:/);
  });

  it("carries the union of blocked scenario ids so page mode can skip them", () => {
    const runnable = compileSource("A", "dir/a.spec.ts");
    const blocked = compilePlaywrightSpec({
      source: `// @qa-scenario: B\ntest.describe("B", () => {\n  // @qa-live-policy: skip\n  test("t", async ({ page }) => { await expect(page.getByText("X")).toBeVisible(); });\n});\n`,
      sourcePath: "dir/b.spec.ts",
    });
    const merged = mergeCompileResults([runnable, blocked]);
    expect(merged.qaIr.extensions.blockedScenarioIds ?? []).toEqual(blocked.qaIr.extensions.blockedScenarioIds);
  });
});

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x63);
const source = `// @qa-scenario: DASHBOARD_READONLY
test.describe("dashboard", () => {
  // @qa-live-policy: readonly
  test("shows dashboard", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
    await expect(page.getByText("Sign in")).not.toBeVisible();
  });
});
`;

const multiSource = `// @qa-scenario: DASHBOARD_READONLY
test.describe("dashboard", () => {
  // @qa-live-policy: readonly
  test("shows dashboard", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
  // @qa-live-policy: readonly
  test("shows metrics", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
  // @qa-live-policy: readonly
  test("hides sign in", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
});
`;

const pairSource = `// @qa-scenario: DASHBOARD_READONLY
test.describe("dashboard", () => {
  // @qa-live-policy: readonly
  test("completes", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
  // @qa-live-policy: readonly
  test("exhausts", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
});
`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project(specSource = source) {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-execute-"));
  temporaryDirectories.push(cwd);
  writeFileSync(join(cwd, "dashboard.spec.ts"), specSource);
  return cwd;
}

async function fixtureExecution({ qaIr, plan, runId }) {
  const store = createInMemoryEvidenceStore({
    providerCapabilities: playwrightExecutionCapabilities(),
    producer: { name: "execute-cli-test", version: "0.1.0" },
  });
  const scenario = qaIr.suites[0].scenarios[0];
  const checkpoint = scenario.steps.find((step) => step.kind === "CHECKPOINT");
  const artifact = store.captureArtifact({ id: "visible-text", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Dashboard" });
  const bundle = store.createBundle({
    runId,
    scenarioId: scenario.id,
    checkpointId: checkpoint.checkpointId,
    capturedAt: "2026-07-25T00:00:00.000Z",
    environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } },
    artifacts: [artifact],
    facts: [],
  });
  return {
    outcome: validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED" }),
    bundles: [bundle],
    manifest: store.appendCheckpoint(bundle),
    readBlob: store.readBlob,
    plan,
  };
}

describe("qa-native execute persistence", () => {
  it("compiles, plans, executes, and persists an authenticated run", async () => {
    const cwd = project();
    const stderr = vi.fn();
    const status = await runQaNative([
      "execute",
      "--spec=dashboard.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/run-1",
    ], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => executeQaNative(args, { execute: fixtureExecution }) },
      stdout: vi.fn(),
      stderr,
    });

    expect(status).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    const runDirectory = join(cwd, ".qa", "runs", "run-1");
    expect(lstatSync(runDirectory).mode & 0o777).toBe(0o700);
    const qaIr = JSON.parse(readFileSync(join(runDirectory, "qa-ir.json"), "utf8"));
    const plan = JSON.parse(readFileSync(join(runDirectory, "execution-plan.json"), "utf8"));
    const outcome = JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8"));
    const envelope = JSON.parse(readFileSync(join(runDirectory, "run-envelope.json"), "utf8"));
    expect(validateContract("QaIrDocument", qaIr)).toBe(qaIr);
    expect(validateContract("ExecutionPlan", plan)).toBe(plan);
    expect(validateContract("RuntimeOutcome", outcome).type).toBe("COMPLETED");
    expect(validateContract("RunEnvelope", envelope)).toMatchObject({ runId: "run-1", mode: "strict" });
    expect(existsSync(join(runDirectory, "execution-outcome.json"))).toBe(false);
    expect(lstatSync(join(runDirectory, "qa-ir.json")).mode & 0o777).toBe(0o600);
    const replay = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
    expect(replay.bundles).toHaveLength(1);
    expect(replay.readBlob(replay.bundles[0].artifacts[0].storageRef).toString("utf8")).toBe("Dashboard");
  });

  it("persists every declared scenario of a multi-scenario Hermes adaptive execution", async () => {
    const cwd = project(multiSource);
    const server = createServer((_request, response) => response.end("<!doctype html><button>Dashboard</button>"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    let proposalId = 0;
    const createProposer = vi.fn(() => async (input) => ({ tokensUsed: 0, proposal: { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `p-${++proposalId}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: "observe_dom", parameters: {} } }));
    let status;
    try {
      status = await runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=http://127.0.0.1:${address.port}`, "--run-dir=.qa/runs/adaptive", "--provider=hermes", "--mode=adaptive"], {
        cwd,
        env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
        handlers: { execute: (args) => executeQaNative(args, { createProposer, executeAdaptive: (options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium }) }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(status).toBe(0);
    const runDirectory = join(cwd, ".qa", "runs", "adaptive");
    const inputs = JSON.parse(readFileSync(join(runDirectory, "execution-agent-inputs.json"), "utf8"));
    const outcomes = JSON.parse(readFileSync(join(runDirectory, "execution-agent-outcomes.json"), "utf8"));
    expect(inputs).toHaveLength(3);
    expect(outcomes).toHaveLength(3);
    inputs.forEach((input) => validateContract("ExecutionAgentInput", input));
    outcomes.forEach((outcome, index) => validateContract("ExecutionAgentOutcome", outcome, { input: inputs[index] }));
    expect(existsSync(join(runDirectory, "execution-agent-input.json"))).toBe(false);
    expect(validateContract("RuntimeOutcome", JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8"))).type).toBe("COMPLETED");
    expect(validateContract("RunEnvelope", JSON.parse(readFileSync(join(runDirectory, "run-envelope.json"), "utf8")))).toMatchObject({ runId: "adaptive", mode: "adaptive" });
    expect(existsSync(join(runDirectory, "execution-plan.json"))).toBe(false);
    const replay = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
    expect(new Set(replay.bundles.map((bundle) => bundle.scenarioId)).size).toBe(3);
  });

  it("threads --budget-actions overrides through to the adaptive execution input, defaulting the rest", async () => {
    const cwd = project(multiSource);
    const server = createServer((_request, response) => response.end("<!doctype html><button>Dashboard</button>"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    let proposalId = 0;
    const createProposer = vi.fn(() => async (input) => ({ tokensUsed: 0, proposal: { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `p-${++proposalId}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: "observe_dom", parameters: {} } }));
    const createAdaptiveInput = vi.fn((args) => createAdaptiveExecutionInput(args));
    let status;
    try {
      status = await runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=http://127.0.0.1:${address.port}`, "--run-dir=.qa/runs/adaptive-budget", "--provider=hermes", "--mode=adaptive", "--budget-actions=3"], {
        cwd,
        env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
        handlers: { execute: (args) => executeQaNative(args, { createAdaptiveInput, createProposer, executeAdaptive: (options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium }) }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(status).toBe(0);
    expect(createAdaptiveInput).toHaveBeenCalled();
    for (const call of createAdaptiveInput.mock.calls) {
      expect(call[0].budget).toEqual({ ...DEFAULT_ADAPTIVE_BUDGET, actions: 3 });
    }
  });

  it("rejects a non-positive-integer --budget-actions value before executing", async () => {
    const cwd = project();
    const handler = vi.fn();
    const stderr = vi.fn();
    const status = await runQaNative(["execute", "--spec=dashboard.spec.ts", "--base-url=https://example.test", "--run-dir=.qa/runs/invalid-budget", "--provider=hermes", "--mode=adaptive", "--budget-actions=0"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: handler },
      stdout: vi.fn(),
      stderr,
    });

    expect(status).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("qa-native: budget actions must be a positive integer\n");
  });

  it("seals partial evidence and reports the non-completed scenario when one exhausts its budget", async () => {
    const cwd = project(pairSource);
    const server = createServer((_request, response) => response.end('<!doctype html><main data-testid="dashboard">Enterprise Dashboard</main>'));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const origin = new URL(url).origin;
    let call = 0;
    const createAdaptiveInput = ({ scenarioId, runId }) => {
      const exhaust = call++ === 1;
      return {
        schemaVersion: EXECUTION_AGENT_INPUT_VERSION,
        runId,
        scenarioId,
        goal: { id: `goal-${scenarioId}`, description: "Observe the dashboard." },
        milestones: [{ id: "contains", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Dashboard text is present.", target: { testId: "dashboard" }, expectation: { kind: "CONTAINS_TEXT", expected: { kind: "literal", value: exhaust ? "Never Present Text" : "Dashboard" } } }],
        currentMilestoneId: "contains",
        currentPage: { pageId: `page-${scenarioId}`, domGeneration: 1, url },
        recentObservations: [],
        capabilityLease: { leaseId: `lease-${scenarioId}`, actions: ["observe_dom"], allowedOrigins: [origin] },
        remainingBudget: { actions: 2, turns: 2, timeMs: 30_000, tokens: 2 },
      };
    };
    let proposalId = 0;
    const createProposer = () => async (input) => ({ tokensUsed: 0, proposal: { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `p-${++proposalId}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: "observe_dom", parameters: {} } });
    const reportSummary = vi.fn();
    const reportScenario = vi.fn();
    let status;
    try {
      status = await runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=${url}`, "--run-dir=.qa/runs/partial-adaptive", "--provider=hermes", "--mode=adaptive"], {
        cwd,
        env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
        handlers: { execute: (args) => executeQaNative(args, { createAdaptiveInput, createProposer, executeAdaptive: (options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium }), reportSummary, reportScenario }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(status).toBe(0);
    const runDirectory = join(cwd, ".qa", "runs", "partial-adaptive");
    expect(existsSync(runDirectory)).toBe(true);
    const outcomes = JSON.parse(readFileSync(join(runDirectory, "execution-agent-outcomes.json"), "utf8"));
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((outcome) => outcome.type).sort()).toEqual(["COMPLETED", "ERROR"]);
    expect(outcomes.find((outcome) => outcome.type === "ERROR").reason).toMatch(/^BUDGET_EXHAUSTED/);
    const replay = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
    expect(replay.bundles.length).toBeGreaterThan(0);
    expect(reportSummary).toHaveBeenCalledWith(expect.objectContaining({ executed: 2, nonCompleted: 1, provider: "hermes", mode: "adaptive" }));
    expect(reportScenario).toHaveBeenCalledTimes(1);
    expect(reportScenario).toHaveBeenCalledWith(expect.objectContaining({ type: "ERROR", reason: expect.stringMatching(/^BUDGET_EXHAUSTED/) }));
  }, 30_000);

  it("accepts an adaptive run whose startup navigation redirected within the capability lease", async () => {
    const cwd = project(multiSource);
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.statusCode = 302;
        response.setHeader("location", "/home");
        response.end();
        return;
      }
      response.end("<!doctype html><button>Dashboard</button>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    let proposalId = 0;
    const createProposer = vi.fn(() => async (input) => ({ tokensUsed: 0, proposal: { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `p-${++proposalId}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: "observe_dom", parameters: {} } }));
    let status;
    try {
      status = await runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=http://127.0.0.1:${address.port}`, "--run-dir=.qa/runs/redirected", "--provider=hermes", "--mode=adaptive"], {
        cwd,
        env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
        handlers: { execute: (args) => executeQaNative(args, { createProposer, executeAdaptive: (options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium }) }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(status).toBe(0);
    const runDirectory = join(cwd, ".qa", "runs", "redirected");
    expect(existsSync(join(runDirectory, "run.json"))).toBe(true);
    expect(existsSync(`${runDirectory}.invalid`)).toBe(false);
  });

  it("accepts a semantic scenario completed by an observe-only evidence milestone", async () => {
    const semanticSource = `// @qa-scenario: DASHBOARD_SEMANTIC
test.describe("dashboard", () => {
  // @qa-live-policy: mock-judgment
  test("renders localized dashboard", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
});
`;
    const cwd = project(semanticSource);
    const server = createServer((_request, response) => response.end("<!doctype html><button>Dashboard</button>"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    let proposalId = 0;
    const createProposer = vi.fn(() => async (input) => ({ tokensUsed: 0, proposal: { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `p-${++proposalId}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: "observe_dom", parameters: {} } }));
    let status;
    try {
      status = await runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=http://127.0.0.1:${address.port}`, "--run-dir=.qa/runs/semantic", "--provider=hermes", "--mode=adaptive"], {
        cwd,
        env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
        handlers: { execute: (args) => executeQaNative(args, { createProposer, executeAdaptive: (options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium }) }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(status).toBe(0);
    const runDirectory = join(cwd, ".qa", "runs", "semantic");
    const outcomes = JSON.parse(readFileSync(join(runDirectory, "execution-agent-outcomes.json"), "utf8"));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].type).toBe("COMPLETED");
  });

  it("preserves sealed evidence as <run-dir>.invalid when adaptive evidence validation rejects the run", async () => {
    const cwd = project(multiSource);
    const server = createServer((_request, response) => response.end("<!doctype html><button>Dashboard</button>"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    let proposalId = 0;
    const createProposer = vi.fn(() => async (input) => ({ tokensUsed: 0, proposal: { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `p-${++proposalId}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: "observe_dom", parameters: {} } }));
    const reportInvalidRun = vi.fn();
    let status;
    try {
      status = await runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=http://127.0.0.1:${address.port}`, "--run-dir=.qa/runs/rejected", "--provider=hermes", "--mode=adaptive"], {
        cwd,
        env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
        handlers: { execute: (args) => executeQaNative(args, { createProposer, executeAdaptive: (options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium }), validateEvidence: () => { throw new Error("forced invalid evidence"); }, reportInvalidRun }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(status).toBe(1);
    const runDirectory = join(cwd, ".qa", "runs", "rejected");
    expect(existsSync(runDirectory)).toBe(false);
    const quarantined = `${runDirectory}.invalid`;
    const inputs = JSON.parse(readFileSync(join(quarantined, "execution-agent-inputs.json"), "utf8"));
    expect(inputs).toHaveLength(3);
    const replay = readEvidenceArchive({ directory: join(quarantined, "evidence"), integrityKey });
    expect(replay.bundles.length).toBeGreaterThan(0);
    expect(reportInvalidRun).toHaveBeenCalledWith({ preservedAt: join(".qa", "runs", "rejected.invalid") });
  });

  it("quarantines the run directory when a later adaptive scenario fails without evidence", async () => {
    const cwd = project(multiSource);
    const server = createServer((_request, response) => response.end("<!doctype html><button>Dashboard</button>"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    let seen = 0;
    const createProposer = vi.fn(() => async (input) => {
      if (++seen === 2) throw new Error("scenario-secret");
      return { tokensUsed: 0, proposal: { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `p-${seen}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: "observe_dom", parameters: {} } };
    });
    let status;
    try {
      status = await runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=http://127.0.0.1:${address.port}`, "--run-dir=.qa/runs/partial", "--provider=hermes", "--mode=adaptive"], {
        cwd,
        env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
        handlers: { execute: (args) => executeQaNative(args, { createProposer, executeAdaptive: (options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium }) }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(status).toBe(1);
    expect(existsSync(join(cwd, ".qa", "runs", "partial"))).toBe(false);
    expect(existsSync(join(cwd, ".qa", "runs", "partial.invalid", "evidence"))).toBe(true);
  });

  it("rejects adaptive completion output that did not originate from the Playwright gateway", async () => {
    const cwd = project();
    const status = await runQaNative(["execute", "--spec=dashboard.spec.ts", "--base-url=https://example.test", "--run-dir=.qa/runs/forged", "--provider=hermes", "--mode=adaptive"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => executeQaNative(args, { createProposer: () => vi.fn(), executeAdaptive: async () => ({}) }) },
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(status).toBe(1);
    expect(existsSync(join(cwd, ".qa", "runs", "forged"))).toBe(false);
  });

  it("surfaces the runtime outcome and quarantines evidence when strict execution fails", async () => {
    const cwd = project();
    const stderr = vi.fn();
    const failingExecution = async (args) => {
      const result = await fixtureExecution(args);
      return { ...result, outcome: { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "ERROR", code: "UNKNOWN_RUNTIME_ERROR", message: "Execution timed out" } };
    };
    const status = await runQaNative([
      "execute",
      "--spec=dashboard.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/strict-fail",
    ], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => executeQaNative(args, { execute: failingExecution }) },
      stdout: vi.fn(),
      stderr,
    });

    expect(status).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("type=ERROR"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("code=UNKNOWN_RUNTIME_ERROR"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Execution timed out"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("bundles=1"));
    expect(existsSync(join(cwd, ".qa", "runs", "strict-fail"))).toBe(false);
    const replay = readEvidenceArchive({ directory: join(cwd, ".qa", "runs", "strict-fail.invalid", "evidence"), integrityKey });
    expect(replay.bundles).toHaveLength(1);
  });

  it("removes the run directory when persistence fails", async () => {
    const cwd = project();
    const stderr = vi.fn();
    const status = await runQaNative([
      "execute",
      "--spec=dashboard.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/failed",
    ], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => executeQaNative(args, { execute: fixtureExecution, writeArchive: () => { throw new Error("archive-secret"); } }) },
      stdout: vi.fn(),
      stderr,
    });

    expect(status).toBe(1);
    expect(existsSync(join(cwd, ".qa", "runs", "failed"))).toBe(false);
    expect(stderr).toHaveBeenCalledWith("qa-native: execute failed: Error\n");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("archive-secret");
  });

  it("surfaces the failure detail only when QA_NATIVE_DEBUG is set", async () => {
    const cwd = project();
    const stderr = vi.fn();
    const status = await runQaNative([
      "execute",
      "--spec=dashboard.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/debug",
    ], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64"), QA_NATIVE_DEBUG: "1" },
      handlers: { execute: (args) => executeQaNative(args, { execute: fixtureExecution, writeArchive: () => { throw new Error("archive-secret"); } }) },
      stdout: vi.fn(),
      stderr,
    });

    expect(status).toBe(1);
    expect(JSON.stringify(stderr.mock.calls)).toContain("archive-secret");
  });

  it("emits a scenario summary on a successful run", async () => {
    const cwd = project();
    const reportSummary = vi.fn();
    const status = await runQaNative([
      "execute",
      "--spec=dashboard.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/summary",
    ], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => executeQaNative(args, { execute: fixtureExecution, reportSummary }) },
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(status).toBe(0);
    expect(reportSummary).toHaveBeenCalledWith(expect.objectContaining({ executed: 1, skipped: 0, provider: "playwright", mode: "strict" }));
  });

  it("publishes only the functional execute command", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.bin).toEqual({ "qa-native": "./bin/qa-native.mjs" });
    expect(packageJson.exports).toMatchObject({
      "./cli/qa-native": "./packages/cli/qa-native.mjs",
      "./cli/qa-native-execute": "./packages/cli/qa-native-execute.mjs",
    });
    expect(packageJson.files).toEqual(expect.arrayContaining(["packages/cli/qa-native.mjs", "packages/cli/qa-native-execute.mjs", "packages/cli/qa-native-adaptive-evidence.mjs", "packages/cli/qa-native-run-envelope.mjs"]));
  });

  function writeSharedStorageState(cwd, mode = 0o600) {
    mkdirSync(join(cwd, ".private"), { recursive: true });
    const authFile = join(cwd, ".private", "storage-state.json");
    writeFileSync(authFile, "{}");
    chmodSync(authFile, mode);
    return authFile;
  }

  async function runStrictExecute(cwd, { runDir, capture, stderr = vi.fn() } = {}) {
    return runQaNative(["execute", "--spec=dashboard.spec.ts", "--base-url=https://example.test", `--run-dir=${runDir}`], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => { capture?.(args); return executeQaNative(args, { execute: fixtureExecution }); } },
      stdout: vi.fn(),
      stderr,
    });
  }

  it("auto-discovers a private shared storage state at .private/storage-state.json", async () => {
    const cwd = project();
    writeSharedStorageState(cwd);
    let captured;
    const status = await runStrictExecute(cwd, { runDir: ".qa/runs/run-auth", capture: (args) => { captured = args.storageStatePath; } });
    expect(status).toBe(0);
    expect(captured).toMatch(/\.private\/storage-state\.json$/);
  });

  it("runs unauthenticated when no shared storage state is present", async () => {
    const cwd = project();
    let captured = "unset";
    const status = await runStrictExecute(cwd, { runDir: ".qa/runs/run-noauth", capture: (args) => { captured = args.storageStatePath; } });
    expect(status).toBe(0);
    expect(captured).toBeUndefined();
  });

  it("rejects a shared storage state that is not private", async () => {
    const cwd = project();
    writeSharedStorageState(cwd, 0o644);
    const status = await runStrictExecute(cwd, { runDir: ".qa/runs/run-loose" });
    expect(status).toBe(1);
    expect(existsSync(join(cwd, ".qa", "runs", "run-loose"))).toBe(false);
  });

  it("prefers an explicit --storage-state over the shared default", async () => {
    const cwd = project();
    writeSharedStorageState(cwd);
    const explicit = join(cwd, "explicit.storage.json");
    writeFileSync(explicit, "{}");
    chmodSync(explicit, 0o600);
    let captured;
    const status = await runQaNative(["execute", "--spec=dashboard.spec.ts", "--base-url=https://example.test", "--run-dir=.qa/runs/run-explicit", "--storage-state=explicit.storage.json"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => { captured = args.storageStatePath; return executeQaNative(args, { execute: fixtureExecution }); } },
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    expect(status).toBe(0);
    expect(captured).toMatch(/explicit\.storage\.json$/);
  });
});
