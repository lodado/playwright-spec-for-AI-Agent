import { describe, expect, it } from "vitest";
import { EXECUTION_ACTION_PROPOSAL_VERSION, EXECUTION_AGENT_INPUT_VERSION } from "../../contracts/index.mjs";
import { createAdaptiveActionAuthorizer } from "../index.mjs";

function executionAgentInput() {
  return {
    schemaVersion: EXECUTION_AGENT_INPUT_VERSION,
    runId: "run-adaptive",
    scenarioId: "scenario-settings",
    goal: { id: "goal-settings", description: "Open the settings dialog." },
    milestones: [
      { id: "open-settings", class: "REQUIRED_EXACT_ACTION", status: "PENDING", description: "Click Settings.", requiredAction: "click_observed_element" },
      { id: "dialog-visible", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Observe the dialog." },
    ],
    currentMilestoneId: "open-settings",
    currentPage: { pageId: "page-1", domGeneration: 3, url: "https://example.test/dashboard" },
    recentObservations: [{ observationId: "observation-3", pageId: "page-1", domGeneration: 3, elements: [{ elementId: "element-settings", milestoneIds: ["open-settings"], allowedActions: ["click_observed_element", "wait_for_element_state"] }] }],
    capabilityLease: { leaseId: "lease-safe-ui", actions: ["observe_dom", "click_observed_element", "navigate"], allowedOrigins: ["https://example.test"] },
    remainingBudget: { actions: 4, turns: 4, timeMs: 30_000, tokens: 8_000 },
  };
}

function clickProposal() {
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

describe("adaptive execution authorization", () => {
  it("authorizes one exact observed-element action from the current DOM generation", () => {
    const result = createAdaptiveActionAuthorizer({ input: executionAgentInput(), now: () => 1_000 }).authorize({ proposal: clickProposal(), tokensUsed: 100 });
    expect(result.proposal).toEqual(clickProposal());
    expect(result.remainingBudget).toEqual({ actions: 3, turns: 3, timeMs: 30_000, tokens: 7_900 });
    expect(Object.isFrozen(result.proposal.parameters)).toBe(true);
  });

  it("rejects stale or invented element identities and exact-action bypasses", () => {
    const input = executionAgentInput();
    const stale = structuredClone(input);
    stale.recentObservations[0].domGeneration = 2;
    expect(() => createAdaptiveActionAuthorizer({ input: stale }).authorize({ proposal: clickProposal() })).toThrow(/stale observation/);

    const invented = clickProposal();
    invented.parameters.elementId = "element-invented";
    expect(() => createAdaptiveActionAuthorizer({ input }).authorize({ proposal: invented })).toThrow(/unknown element/);

    const bypass = clickProposal();
    bypass.milestoneId = "dialog-visible";
    expect(() => createAdaptiveActionAuthorizer({ input }).authorize({ proposal: bypass })).toThrow(/current milestone/);
  });

  it("rejects exhausted budgets, unleased actions, and disallowed navigation origins", () => {
    const exhausted = executionAgentInput();
    exhausted.remainingBudget.actions = 0;
    expect(() => createAdaptiveActionAuthorizer({ input: exhausted }).authorize({ proposal: clickProposal() })).toThrow(/budget/);

    const unleased = executionAgentInput();
    unleased.capabilityLease.actions = ["observe_dom"];
    expect(() => createAdaptiveActionAuthorizer({ input: unleased }).authorize({ proposal: clickProposal() })).toThrow(/capability lease/);

    const navigate = { ...clickProposal(), action: "navigate", parameters: { url: "https://attacker.test/settings" } };
    expect(() => createAdaptiveActionAuthorizer({ input: executionAgentInput() }).authorize({ proposal: navigate })).toThrow(/required exact action|origin/);
  });

  it("consumes proposal ids and budgets exactly once", () => {
    const authorizer = createAdaptiveActionAuthorizer({ input: executionAgentInput(), now: () => 1_000 });
    const proposal = clickProposal();
    authorizer.authorize({ proposal, tokensUsed: 10 });
    expect(authorizer.remainingBudget()).toEqual({ actions: 3, turns: 3, timeMs: 30_000, tokens: 7_990 });
    expect(() => authorizer.authorize({ proposal, tokensUsed: 10 })).toThrow(/already consumed/);
    expect(authorizer.remainingBudget()).toEqual({ actions: 3, turns: 3, timeMs: 30_000, tokens: 7_990 });
  });

  it("does not restore time when the supplied clock moves backward", () => {
    const readings = [1_000, 1_500, 500];
    const authorizer = createAdaptiveActionAuthorizer({ input: executionAgentInput(), now: () => readings.shift() });
    expect(authorizer.remainingBudget().timeMs).toBe(29_500);
    expect(authorizer.remainingBudget().timeMs).toBe(29_500);
  });

  it("bounds recovery actions by exact-action identity and the remaining deadline", () => {
    const wrongElement = executionAgentInput();
    wrongElement.recentObservations[0].elements[0].milestoneIds = ["dialog-visible"];
    expect(() => createAdaptiveActionAuthorizer({ input: wrongElement }).authorize({ proposal: clickProposal() })).toThrow(/current milestone/);

    for (const action of ["go_back", "reload_page"]) {
      const input = executionAgentInput();
      input.capabilityLease.actions.push(action);
      const recovery = { ...clickProposal(), proposalId: `proposal-${action}`, action, parameters: {} };
      expect(() => createAdaptiveActionAuthorizer({ input }).authorize({ proposal: recovery })).toThrow(/required exact action/);
    }

    const input = executionAgentInput();
    input.remainingBudget.timeMs = 5;
    input.capabilityLease.actions.push("wait_for_element_state");
    const wait = {
      ...clickProposal(),
      proposalId: "proposal-wait",
      action: "wait_for_element_state",
      parameters: { observationId: "observation-3", elementId: "element-settings", state: "visible", timeoutMs: 6 },
    };
    expect(() => createAdaptiveActionAuthorizer({ input, now: () => 1_000 }).authorize({ proposal: wait })).toThrow(/remaining time budget/);
  });
});
