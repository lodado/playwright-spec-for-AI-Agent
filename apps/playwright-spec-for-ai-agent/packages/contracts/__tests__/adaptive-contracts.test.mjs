import { describe, expect, it } from "vitest";
import {
  EXECUTION_ACTION_PROPOSAL_VERSION,
  EXECUTION_ACTION_RESULT_VERSION,
  EXECUTION_AGENT_INPUT_VERSION,
  EXECUTION_AGENT_OUTCOME_VERSION,
  snapshotContract,
  validateContract,
} from "../index.mjs";

export function executionAgentInput() {
  return {
    schemaVersion: EXECUTION_AGENT_INPUT_VERSION,
    runId: "run-adaptive",
    scenarioId: "scenario-settings",
    goal: { id: "goal-settings", description: "Open the settings dialog." },
    milestones: [
      { id: "open-settings", class: "REQUIRED_EXACT_ACTION", status: "PENDING", description: "Click the observed Settings entry.", requiredAction: "click_observed_element", target: { testId: "settings" } },
      { id: "dialog-visible", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Observe the settings dialog." },
    ],
    currentMilestoneId: "open-settings",
    currentPage: { pageId: "page-1", domGeneration: 3, url: "https://example.test/dashboard" },
    recentObservations: [{ observationId: "observation-3", pageId: "page-1", domGeneration: 3, elements: [{ elementId: "element-settings", milestoneIds: ["open-settings"], allowedActions: ["click_observed_element", "wait_for_element_state"] }] }],
    capabilityLease: {
      leaseId: "lease-safe-ui",
      actions: ["observe_dom", "click_observed_element", "navigate"],
      allowedOrigins: ["https://example.test"],
    },
    remainingBudget: { actions: 4, turns: 4, timeMs: 30_000, tokens: 8_000 },
  };
}

export function clickProposal() {
  return {
    schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
    proposalId: "proposal-click-settings",
    runId: "run-adaptive",
    scenarioId: "scenario-settings",
    milestoneId: "open-settings",
    leaseId: "lease-safe-ui",
    action: "click_observed_element",
    parameters: { observationId: "observation-3", elementId: "element-settings" },
  };
}

describe("adaptive execution contracts", () => {
  it("validates bounded exact input, proposal, result, and non-verdict outcome shapes", () => {
    const input = executionAgentInput();
    const proposal = clickProposal();
    const result = {
      schemaVersion: EXECUTION_ACTION_RESULT_VERSION,
      resultId: "result-click-settings",
      proposalId: proposal.proposalId,
      accepted: true,
      policyReason: "ACCEPTED",
      evidenceRefs: ["action-click-settings"],
      page: { pageId: "page-1", domGeneration: 4, url: "https://example.test/dashboard" },
      remainingBudget: { actions: 3, turns: 3, timeMs: 29_000, tokens: 7_500 },
    };
    const outcome = {
      schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
      runId: input.runId,
      scenarioId: input.scenarioId,
      type: "COMPLETED",
      completedMilestoneIds: ["open-settings", "dialog-visible"],
    };

    expect(validateContract("ExecutionAgentInput", input)).toBe(input);
    expect(validateContract("ExecutionActionProposal", proposal)).toBe(proposal);
    expect(validateContract("ExecutionActionResult", result, { input, proposal })).toBe(result);
    expect(validateContract("ExecutionAgentOutcome", outcome, { input })).toBe(outcome);
  });

  it("rejects capability expansion, credentials, unbounded actions, and verdict-bearing outcomes", () => {
    expect(() => validateContract("ExecutionAgentInput", { ...executionAgentInput(), credentials: { password: "secret" } })).toThrow(/credentials/);
    expect(() => validateContract("ExecutionActionProposal", { ...clickProposal(), action: "observe_screenshot" })).toThrow(/observe_dom/);
    expect(() => validateContract("ExecutionActionProposal", { ...clickProposal(), parameters: { observationId: "observation-3", elementId: "element-settings", selector: "#settings" } })).toThrow(/selector/);
    expect(() => validateContract("ExecutionAgentOutcome", {
      schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
      runId: "run-adaptive",
      scenarioId: "scenario-settings",
      type: "COMPLETED",
      completedMilestoneIds: [],
      verdict: "PASS",
    })).toThrow(/verdict/);

    const hiddenVerdict = {
      schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
      runId: "run-adaptive",
      scenarioId: "scenario-settings",
      type: "COMPLETED",
      completedMilestoneIds: ["open-settings", "dialog-visible"],
    };
    Object.defineProperty(hiddenVerdict, "verdict", { value: "PASS" });
    expect(() => snapshotContract("ExecutionAgentOutcome", hiddenVerdict, { input: executionAgentInput() })).toThrow(/verdict/);

    const nonJson = clickProposal();
    nonJson.parameters.selector = undefined;
    expect(() => snapshotContract("ExecutionActionProposal", nonJson)).toThrow(/selector/);

    const credentialUrl = executionAgentInput();
    credentialUrl.currentPage.url = "https://example.test/dashboard?access_token=secret";
    expect(() => validateContract("ExecutionAgentInput", credentialUrl)).toThrow(/query/);
  });

  it("requires runtime-owned budgets to decrease monotonically", () => {
    const input = executionAgentInput();
    const proposal = clickProposal();
    const result = {
      schemaVersion: EXECUTION_ACTION_RESULT_VERSION,
      resultId: "result-click-settings",
      proposalId: proposal.proposalId,
      accepted: true,
      policyReason: "ACCEPTED",
      evidenceRefs: ["action-click-settings"],
      page: { ...input.currentPage },
      remainingBudget: { ...input.remainingBudget, actions: input.remainingBudget.actions - 1, turns: input.remainingBudget.turns - 1 },
    };
    expect(validateContract("ExecutionActionResult", result, { input, proposal })).toBe(result);

    result.remainingBudget.actions = input.remainingBudget.actions;
    expect(() => validateContract("ExecutionActionResult", result, { input, proposal })).toThrow(/actions/);
    result.remainingBudget.actions -= 1;
    result.remainingBudget.tokens += 1;
    expect(() => validateContract("ExecutionActionResult", result, { input, proposal })).toThrow(/tokens/);

    result.remainingBudget.tokens -= 1;
    result.page.url = "https://attacker.test/collect";
    expect(() => validateContract("ExecutionActionResult", result, { input, proposal })).toThrow(/origin/);

    result.page = { ...input.currentPage, domGeneration: input.currentPage.domGeneration - 1 };
    expect(() => validateContract("ExecutionActionResult", result, { input, proposal })).toThrow(/regress/);

    result.page = { ...input.currentPage };
    const unleased = executionAgentInput();
    unleased.capabilityLease.actions = ["observe_dom"];
    expect(() => validateContract("ExecutionActionResult", result, { input: unleased, proposal })).toThrow(/capability lease/);
  });
});
