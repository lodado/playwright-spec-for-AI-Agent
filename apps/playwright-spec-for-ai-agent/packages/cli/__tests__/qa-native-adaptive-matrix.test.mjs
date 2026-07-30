import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXECUTION_ACTION_PROPOSAL_VERSION } from "../../contracts/index.mjs";
import { readEvidenceArchive } from "../../evidence/index.mjs";
import { judgeWithHermes } from "../../provider-hermes/index.mjs";
import { runAdaptiveSuiteWithPlaywright } from "../../provider-playwright/index.mjs";
import { executeQaNative } from "../qa-native-execute.mjs";
import { judgeQaNative } from "../qa-native-judge.mjs";
import { runQaNative } from "../qa-native.mjs";

// Mirrors the consumer repo's dashboard-inactive.spec.ts shape: two semantic (mock-judgment),
// two readonly, and one safe-interaction scenario sharing one spec file. Every adaptive protocol
// change must keep these three cases green — they are the record/replay stand-in for a live model.
const matrixSource = readFileSync(new URL("./fixtures/policy-matrix.spec.ts", import.meta.url), "utf8");
const pageHtml = '<!doctype html><h1>Dashboard</h1><p>No active plans</p><p>Usage</p><p>Metrics</p><button data-testid="settings">Settings</button><section>Settings Panel</section>';

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x64);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project(specSource = matrixSource) {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-matrix-"));
  temporaryDirectories.push(cwd);
  writeFileSync(join(cwd, "dashboard.spec.ts"), specSource);
  return cwd;
}

async function withServer(run) {
  const server = createServer((_request, response) => response.end(pageHtml));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Scripted stand-in for the Hermes proposer: observe until the current milestone is an exact
// click backed by an observed element, then click it. `blockScenarioIds` switches a scenario to a
// report_blocked claim instead.
function scriptedProposer({ blockScenarioIds = [] } = {}) {
  let proposalId = 0;
  return () => async (input) => {
    const base = {
      schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
      proposalId: `p-${++proposalId}`,
      runId: input.runId,
      scenarioId: input.scenarioId,
      milestoneId: input.currentMilestoneId,
      leaseId: input.capabilityLease.leaseId,
    };
    if (blockScenarioIds.includes(input.scenarioId)) {
      return { tokensUsed: 0, proposal: { ...base, action: "report_blocked", parameters: { milestoneId: input.currentMilestoneId, reason: "Target content never rendered on the live page." } } };
    }
    const milestone = input.milestones.find((item) => item.id === input.currentMilestoneId);
    if (milestone.requiredAction === "click_observed_element") {
      const observation = input.recentObservations[0];
      const element = observation?.elements.find((item) => item.milestoneIds.includes(milestone.id) && item.allowedActions.includes("click_observed_element"));
      if (element) {
        return { tokensUsed: 0, proposal: { ...base, action: "click_observed_element", parameters: { observationId: observation.observationId, elementId: element.elementId } } };
      }
    }
    return { tokensUsed: 0, proposal: { ...base, action: "observe_dom", parameters: {} } };
  };
}

async function executeMatrix({ cwd, baseUrl, runDir, proposer, extraArgs = [] }) {
  return runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=${baseUrl}`, `--run-dir=${runDir}`, "--provider=hermes", "--mode=adaptive", ...extraArgs], {
    cwd,
    env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
    handlers: { execute: (args) => executeQaNative(args, { createProposer: proposer, executeAdaptive: (options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium }) }) },
    stdout: vi.fn(),
    stderr: vi.fn(),
  });
}

function outcomesOf(cwd, runDir) {
  return JSON.parse(readFileSync(join(cwd, runDir, "execution-agent-outcomes.json"), "utf8"));
}

describe("adaptive policy matrix", () => {
  it("completes every policy class and survives judgment", async () => {
    const cwd = project();
    await withServer(async (baseUrl) => {
      expect(await executeMatrix({ cwd, baseUrl, runDir: ".qa/runs/matrix", proposer: scriptedProposer() })).toBe(0);
    });

    const outcomes = outcomesOf(cwd, ".qa/runs/matrix");
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome.type === "COMPLETED")).toBe(true);

    const judge = (args) => {
      const scenario = args.qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === args.bundle.scenarioId);
      const transport = async () => ({
        expectationResults: scenario.expectations.map((expectation) => ({
          expectationId: expectation.id,
          status: "MATCHED",
          confidence: 0.9,
          evidenceRefs: [args.bundle.artifacts[0].id],
          rationale: "Visible evidence supports the expectation.",
        })),
        uncertainty: [],
      });
      return judgeWithHermes({ ...args, transport, model: "hermes-test" });
    };
    const status = await runQaNative(["judge", "--run-dir=.qa/runs/matrix", "--fail-on=fail"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { judge: (args) => judgeQaNative(args, { judge }) },
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    expect(status).toBe(0);
  }, 30_000);

  it("keeps the run and its sealed evidence when one scenario reports blocked", async () => {
    const cwd = project();
    await withServer(async (baseUrl) => {
      const probe = scriptedProposer();
      // Block the first semantic scenario; its id is only known at runtime, so capture it lazily.
      let blockedScenarioId;
      const proposer = () => {
        const propose = probe();
        return async (input) => {
          blockedScenarioId ??= input.scenarioId;
          if (input.scenarioId === blockedScenarioId) {
            return {
              tokensUsed: 0,
              proposal: {
                schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
                proposalId: `blocked-${input.currentMilestoneId}`,
                runId: input.runId,
                scenarioId: input.scenarioId,
                milestoneId: input.currentMilestoneId,
                leaseId: input.capabilityLease.leaseId,
                action: "report_blocked",
                parameters: { milestoneId: input.currentMilestoneId, reason: "Target content never rendered on the live page." },
              },
            };
          }
          return propose(input);
        };
      };
      expect(await executeMatrix({ cwd, baseUrl, runDir: ".qa/runs/blocked", proposer })).toBe(0);
    });

    expect(existsSync(join(cwd, ".qa/runs/blocked"))).toBe(true);
    expect(existsSync(join(cwd, ".qa/runs/blocked.invalid"))).toBe(false);
    const outcomes = outcomesOf(cwd, ".qa/runs/blocked");
    expect(outcomes.map((outcome) => outcome.type).sort()).toEqual(["BLOCKED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]);
    const replay = readEvidenceArchive({ directory: join(cwd, ".qa/runs/blocked", "evidence"), integrityKey });
    expect(new Set(replay.bundles.map((bundle) => bundle.scenarioId)).size).toBe(5);
  }, 30_000);

  it("completes a lazy-rendered expectation by scrolling before re-observing", async () => {
    // Virtual lists and IntersectionObserver-gated sections do not exist in the DOM until the
    // page scrolls; the scroll_view action is how an adaptive run unlocks them. This exercises
    // proposer → authorizer → gateway wheel → re-observe → evidence validator end to end.
    const lazySource = `// @qa-scenario: DASHBOARD_LAZY
test.describe("lazy dashboard", () => {
  // @qa-live-policy: readonly
  test("shows lazy metrics", async ({ page }) => {
    await expect(page.getByText("Lazy Loaded Metrics")).toBeVisible();
  });
});
`;
    const lazyHtml = '<!doctype html><h1>Dashboard</h1><div style="height:4000px"></div><div id="lazy"></div><script>addEventListener("wheel", () => { document.getElementById("lazy").textContent = "Lazy Loaded Metrics"; }, { once: true });</script>';
    const cwd = project(lazySource);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(lazyHtml);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    let proposalId = 0;
    const scrolled = new Set();
    const createProposer = () => async (input) => {
      const base = {
        schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
        proposalId: `p-${++proposalId}`,
        runId: input.runId,
        scenarioId: input.scenarioId,
        milestoneId: input.currentMilestoneId,
        leaseId: input.capabilityLease.leaseId,
      };
      const observedUnsatisfied = input.recentObservations.some((observation) => !observation.satisfiedMilestoneIds.includes(input.currentMilestoneId));
      if (observedUnsatisfied && !scrolled.has(input.scenarioId)) {
        scrolled.add(input.scenarioId);
        return { tokensUsed: 0, proposal: { ...base, action: "scroll_view", parameters: { deltaX: 0, deltaY: 4_000 } } };
      }
      return { tokensUsed: 0, proposal: { ...base, action: "observe_dom", parameters: {} } };
    };
    let status;
    try {
      status = await executeMatrix({ cwd, baseUrl: `http://127.0.0.1:${address.port}`, runDir: ".qa/runs/lazy", proposer: createProposer });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(status).toBe(0);
    const outcomes = outcomesOf(cwd, ".qa/runs/lazy");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].type).toBe("COMPLETED");
    expect(scrolled.size).toBe(1);
  }, 30_000);

  it("keeps the run and its sealed evidence when one scenario exhausts its budget", async () => {
    const cwd = project();
    await withServer(async (baseUrl) => {
      // --budget-actions=2 lets observe-only scenarios finish (1 action) but starves the
      // interaction scenario (observe + click + verifying observe = 3 actions).
      expect(await executeMatrix({ cwd, baseUrl, runDir: ".qa/runs/starved", proposer: scriptedProposer(), extraArgs: ["--budget-actions=2"] })).toBe(0);
    });

    expect(existsSync(join(cwd, ".qa/runs/starved"))).toBe(true);
    const outcomes = outcomesOf(cwd, ".qa/runs/starved");
    expect(outcomes.map((outcome) => outcome.type).sort()).toEqual(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "ERROR"]);
    expect(outcomes.find((outcome) => outcome.type === "ERROR").reason).toMatch(/^BUDGET_EXHAUSTED/);
    const replay = readEvidenceArchive({ directory: join(cwd, ".qa/runs/starved", "evidence"), integrityKey });
    expect(replay.bundles.length).toBeGreaterThan(0);
  }, 30_000);
});
