import { describe, expect, it } from "vitest";
import { EXECUTION_ACTION_PROPOSAL_VERSION, EXECUTION_ACTION_RESULT_VERSION, EXECUTION_AGENT_INPUT_VERSION, EXECUTION_AGENT_OUTCOME_VERSION } from "../../contracts/index.mjs";
import { advanceAdaptiveMilestone, createAdaptiveActionAuthorizer, createAdaptiveExecutionInput, milestoneCompletionRule } from "../index.mjs";

function executionAgentInput() {
  return {
    schemaVersion: EXECUTION_AGENT_INPUT_VERSION,
    runId: "run-adaptive",
    scenarioId: "scenario-settings",
    goal: { id: "goal-settings", description: "Open the settings dialog." },
    milestones: [
      { id: "open-settings", class: "REQUIRED_EXACT_ACTION", status: "PENDING", description: "Click Settings.", requiredAction: "click_observed_element", target: { testId: "settings" } },
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

function acceptedResult(input, proposal) {
  return {
    schemaVersion: EXECUTION_ACTION_RESULT_VERSION,
    resultId: `result-${proposal.proposalId}`,
    proposalId: proposal.proposalId,
    accepted: true,
    policyReason: "ACCEPTED",
    evidenceRefs: [`${proposal.proposalId}:action`],
    page: { ...input.currentPage, domGeneration: input.currentPage.domGeneration + 1 },
    remainingBudget: { ...input.remainingBudget, actions: input.remainingBudget.actions - 1, turns: input.remainingBudget.turns - 1 },
  };
}

function reportBlockedProposal(input, reason = "Settings entry never renders after repeated observation.") {
  return {
    schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
    proposalId: "proposal-report-blocked",
    runId: input.runId,
    scenarioId: input.scenarioId,
    milestoneId: input.currentMilestoneId,
    leaseId: input.capabilityLease.leaseId,
    action: "report_blocked",
    parameters: { milestoneId: input.currentMilestoneId, reason },
  };
}

describe("adaptive execution authorization", () => {
  it("compiles deterministic adaptive milestones and leases from QA IR", () => {
    const qaIr = adaptiveQaIr();
    const input = createAdaptiveExecutionInput({ qaIr, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-compiled" });

    expect(input).toMatchObject({
      scenarioId: "scenario-settings",
      currentPage: { url: "https://example.test/dashboard" },
      currentMilestoneId: "click-settings",
      milestones: [
        { id: "click-settings", class: "REQUIRED_EXACT_ACTION", requiredAction: "click_observed_element", target: { testId: "settings" } },
        { id: "dialog-visible", class: "REQUIRED_SEMANTIC_MILESTONE", target: { role: "dialog", accessibleName: { kind: "literal", value: "Settings" } } },
      ],
    });
    expect(input.capabilityLease.actions).toEqual(expect.arrayContaining(["observe_dom", "observe_aria", "click_observed_element", "scroll_view", "wait_for_element_state"]));
    expect(createAdaptiveExecutionInput({ qaIr, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-compiled" })).toEqual(input);
  });

  it("keeps supported text and negative-visibility predicates in adaptive milestones", () => {
    const qaIr = adaptiveQaIr();
    qaIr.suites[0].scenarios[0].expectations = [
      { id: "contains-dashboard", kind: "CONTAINS_TEXT", target: { testId: "dashboard" }, expected: { kind: "literal", value: "Dashboard" }, provenance: [] },
      { id: "login-hidden", kind: "NOT_VISIBLE", target: { testId: "login-form" }, provenance: [] },
    ];

    const input = createAdaptiveExecutionInput({ qaIr, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-predicates" });

    expect(input.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "contains-dashboard", expectation: { kind: "CONTAINS_TEXT", expected: { kind: "literal", value: "Dashboard" } } }),
      expect.objectContaining({ id: "login-hidden", expectation: { kind: "NOT_VISIBLE" } }),
    ]));
  });

  it("adds explicit read origins to the adaptive capability lease", () => {
    const input = createAdaptiveExecutionInput({
      qaIr: adaptiveQaIr(),
      scenarioId: "scenario-settings",
      baseUrl: "https://example.test",
      runId: "run-read-origin",
      allowedOrigins: ["https://api.example.test"],
    });
    expect(input.capabilityLease.allowedOrigins).toEqual(["https://example.test", "https://api.example.test"]);
  });

  it("rejects cross-origin startup and scenarios without executable adaptive milestones", () => {
    const crossOrigin = adaptiveQaIr();
    crossOrigin.suites[0].scenarios[0].steps[0].target = { type: "URL", value: "https://attacker.test/collect" };
    expect(() => createAdaptiveExecutionInput({ qaIr: crossOrigin, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-cross-origin" })).toThrow(/base origin/);

    const unsupported = adaptiveQaIr();
    unsupported.suites[0].scenarios[0].expectations[0].kind = "ATTRIBUTE";
    expect(() => createAdaptiveExecutionInput({ qaIr: unsupported, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-unsupported" })).toThrow(/does not support expectation ATTRIBUTE/);

    const empty = adaptiveQaIr();
    empty.suites[0].scenarios[0].steps = empty.suites[0].scenarios[0].steps.filter((step) => step.kind !== "INTERACT");
    empty.suites[0].scenarios[0].expectations = [];
    expect(() => createAdaptiveExecutionInput({ qaIr: empty, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-empty" })).toThrow(/no adaptive milestones/);

    const blocked = adaptiveQaIr();
    blocked.suites[0].scenarios[0].policy.click = "NONE";
    expect(() => createAdaptiveExecutionInput({ qaIr: blocked, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-blocked" })).toThrow(/blocked by scenario policy/);

    const domDenied = adaptiveQaIr();
    domDenied.suites[0].scenarios[0].policy.readDom = false;
    expect(() => createAdaptiveExecutionInput({ qaIr: domDenied, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-dom-denied" })).toThrow(/DOM observation is blocked/);
  });

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

  it("allows bounded reversible recovery without completing the required exact action", () => {
    const wrongElement = executionAgentInput();
    wrongElement.milestones.push({ id: "dismiss-cookie", class: "OPTIONAL_HINT", status: "PENDING", description: "Dismiss the cookie banner if it blocks progress.", target: { testId: "cookie-close" } });
    wrongElement.recentObservations[0].elements[0].milestoneIds = ["dismiss-cookie"];
    const proposal = clickProposal();
    const authorization = createAdaptiveActionAuthorizer({ input: wrongElement }).authorize({ proposal });
    expect(authorization.proposal).toEqual(proposal);
    expect(advanceAdaptiveMilestone({ input: wrongElement, proposal, result: acceptedResult(wrongElement, proposal) })).toBeUndefined();

    const undeclared = executionAgentInput();
    undeclared.recentObservations[0].elements[0].milestoneIds = ["dialog-visible"];
    expect(() => createAdaptiveActionAuthorizer({ input: undeclared }).authorize({ proposal: clickProposal() })).toThrow(/outside exact and optional milestone boundaries/);

    for (const [action, parameters] of [["hover_observed_element", { observationId: "observation-3", elementId: "element-settings" }], ["press_key", { key: "Escape" }]]) {
      const recoveryInput = executionAgentInput();
      recoveryInput.capabilityLease.actions.push(action);
      if (action === "hover_observed_element") recoveryInput.recentObservations[0].elements[0].allowedActions.push(action);
      const recovery = { ...clickProposal(), proposalId: `proposal-${action}`, action, parameters };
      expect(createAdaptiveActionAuthorizer({ input: recoveryInput }).authorize({ proposal: recovery }).proposal).toEqual(recovery);
    }

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

  it("advances exact milestones only after their bound required action", () => {
    const input = executionAgentInput();
    const observe = { ...clickProposal(), proposalId: "proposal-observe", action: "observe_dom", parameters: {} };
    expect(advanceAdaptiveMilestone({ input, proposal: observe, result: acceptedResult(input, observe), observation: input.recentObservations[0] })).toBeUndefined();

    const click = clickProposal();
    const transition = advanceAdaptiveMilestone({ input, proposal: click, result: acceptedResult(input, click) });
    expect(transition.input).toMatchObject({
      currentMilestoneId: "dialog-visible",
      milestones: [
        { id: "open-settings", status: "COMPLETED" },
        { id: "dialog-visible", status: "PENDING" },
      ],
      recentObservations: [],
    });
  });

  it("finishes with a non-verdict outcome when a semantic target is observed", () => {
    const input = executionAgentInput();
    input.milestones[0].status = "COMPLETED";
    input.milestones[1].target = { role: "dialog", accessibleName: { kind: "literal", value: "Settings" } };
    input.currentMilestoneId = "dialog-visible";
    input.recentObservations = [];
    input.capabilityLease.actions.push("observe_aria");
    const observe = { ...clickProposal(), proposalId: "proposal-dialog", milestoneId: "dialog-visible", action: "observe_aria", parameters: {} };
    const observation = {
      observationId: "observation-dialog",
      pageId: input.currentPage.pageId,
      domGeneration: input.currentPage.domGeneration,
      elements: [{ elementId: "element-dialog", milestoneIds: ["dialog-visible"], allowedActions: [], role: "dialog", accessibleName: "Settings" }],
    };

    const transition = advanceAdaptiveMilestone({ input, proposal: observe, result: acceptedResult(input, observe), observation });
    expect(transition.outcome).toEqual({
      schemaVersion: "execution-agent-outcome/0.1",
      runId: input.runId,
      scenarioId: input.scenarioId,
      type: "COMPLETED",
      completedMilestoneIds: ["open-settings", "dialog-visible"],
    });
    expect(transition.outcome).not.toHaveProperty("verdict");
  });

  it("always leases report_blocked so the agent can surrender with sealed evidence", () => {
    const input = createAdaptiveExecutionInput({ qaIr: adaptiveQaIr(), scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-blocked-lease" });
    expect(input.capabilityLease.actions).toContain("report_blocked");
  });

  it("authorizes report_blocked for the current milestone even under a required exact action", () => {
    const input = executionAgentInput();
    input.capabilityLease.actions.push("report_blocked");
    const proposal = reportBlockedProposal(input);
    expect(createAdaptiveActionAuthorizer({ input }).authorize({ proposal }).proposal).toEqual(proposal);

    const mismatched = reportBlockedProposal(input);
    mismatched.parameters.milestoneId = "dialog-visible";
    expect(() => createAdaptiveActionAuthorizer({ input }).authorize({ proposal: mismatched })).toThrow(/current milestone/);
  });

  it("marks the milestone BLOCKED on report_blocked and advances to the next required milestone", () => {
    const input = executionAgentInput();
    input.capabilityLease.actions.push("report_blocked");
    const proposal = reportBlockedProposal(input);

    const transition = advanceAdaptiveMilestone({ input, proposal, result: acceptedResult(input, proposal) });

    expect(transition.input).toMatchObject({
      currentMilestoneId: "dialog-visible",
      milestones: [
        { id: "open-settings", status: "BLOCKED" },
        { id: "dialog-visible", status: "PENDING" },
      ],
      recentObservations: [],
    });
  });

  it("returns a BLOCKED outcome carrying the claim when the last milestone is reported blocked", () => {
    const input = executionAgentInput();
    input.milestones[0].status = "COMPLETED";
    input.currentMilestoneId = "dialog-visible";
    input.recentObservations = [];
    input.capabilityLease.actions.push("report_blocked");
    const proposal = reportBlockedProposal(input, "The dialog cannot be reached.");

    const transition = advanceAdaptiveMilestone({ input, proposal, result: acceptedResult(input, proposal) });

    expect(transition.outcome).toMatchObject({
      type: "BLOCKED",
      completedMilestoneIds: ["open-settings"],
      reason: expect.stringContaining("The dialog cannot be reached."),
    });
    expect(transition.outcome).not.toHaveProperty("verdict");
  });

  it("replaces literal expectations with a single observe-only milestone for semantic-judgment scenarios", () => {
    const qaIr = semanticJudgmentQaIr();
    qaIr.suites[0].scenarios[0].expectations = [
      { id: "greets-user", kind: "CONTAINS_TEXT", target: { testId: "greeting" }, expected: { kind: "literal", value: "dev-user님은" }, provenance: [] },
    ];

    const input = createAdaptiveExecutionInput({ qaIr, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-semantic" });

    expect(input.milestones.filter((milestone) => milestone.expectation !== undefined)).toEqual([]);
    const observeOnly = input.milestones.filter((milestone) => milestone.class === "REQUIRED_SEMANTIC_MILESTONE" && milestone.target === undefined && milestone.expectation === undefined);
    expect(observeOnly).toHaveLength(1);
    expect(observeOnly[0]).toMatchObject({ status: "PENDING", description: "Observe the page and collect visible text and ARIA evidence for semantic judgment." });
    expect(observeOnly[0].id).toMatch(/^evidence-/);
    expect(input.milestones).toEqual(expect.arrayContaining([expect.objectContaining({ id: "click-settings", class: "REQUIRED_EXACT_ACTION" })]));
  });

  it("skips the unsupported-expectation gate for semantic-judgment scenarios", () => {
    const qaIr = semanticJudgmentQaIr();
    qaIr.suites[0].scenarios[0].expectations[0].kind = "ATTRIBUTE";
    expect(() => createAdaptiveExecutionInput({ qaIr, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-semantic-unsupported" })).not.toThrow();
  });

  it("completes an observe-only semantic milestone from any fresh accepted observation", () => {
    const qaIr = semanticJudgmentQaIr();
    qaIr.suites[0].scenarios[0].steps = qaIr.suites[0].scenarios[0].steps.filter((step) => step.kind !== "INTERACT");
    const input = createAdaptiveExecutionInput({ qaIr, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-observe-only" });
    const evidence = input.milestones.find((milestone) => milestone.id.startsWith("evidence-"));
    expect(input.currentMilestoneId).toBe(evidence.id);

    const observe = {
      schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
      proposalId: "proposal-observe-evidence",
      runId: input.runId,
      scenarioId: input.scenarioId,
      milestoneId: evidence.id,
      leaseId: input.capabilityLease.leaseId,
      action: "observe_dom",
      parameters: {},
    };
    const observation = {
      observationId: "observation-evidence",
      pageId: input.currentPage.pageId,
      domGeneration: input.currentPage.domGeneration,
      elements: [{ elementId: "element-any", milestoneIds: [], allowedActions: [] }],
    };

    const transition = advanceAdaptiveMilestone({ input, proposal: observe, result: acceptedResult(input, observe), observation });
    expect(transition.outcome).toEqual({
      schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
      runId: input.runId,
      scenarioId: input.scenarioId,
      type: "COMPLETED",
      completedMilestoneIds: [evidence.id],
    });
  });
});

describe("milestone completion rule", () => {
  const semanticObserveOnly = { id: "m-ev", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Observe the page for semantic judgment." };
  const semanticExpectation = { id: "m-exp", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Observe the dialog.", target: { role: "dialog" }, expectation: { kind: "VISIBLE" } };
  const exactClick = { id: "m-click", class: "REQUIRED_EXACT_ACTION", status: "PENDING", description: "Click settings.", requiredAction: "click_observed_element" };

  it("lets observe actions prove an observe-only semantic milestone even when the sealed satisfiedMilestoneIds is empty", () => {
    expect(milestoneCompletionRule({ action: "observe_dom", parameters: {}, satisfiedMilestoneIds: [] }, semanticObserveOnly)).toBe(true);
    expect(milestoneCompletionRule({ action: "observe_aria", parameters: {}, satisfiedMilestoneIds: [] }, semanticObserveOnly)).toBe(true);
  });

  it("requires satisfiedMilestoneIds membership for an expectation milestone proven by observation", () => {
    expect(milestoneCompletionRule({ action: "observe_dom", parameters: {}, satisfiedMilestoneIds: [] }, semanticExpectation)).toBe(false);
    expect(milestoneCompletionRule({ action: "observe_dom", parameters: {}, satisfiedMilestoneIds: ["m-exp"] }, semanticExpectation)).toBe(true);
  });

  it("lets wait_for_element_state prove a semantic milestone only for present or visible states", () => {
    expect(milestoneCompletionRule({ action: "wait_for_element_state", parameters: { state: "visible" }, satisfiedMilestoneIds: [] }, semanticExpectation)).toBe(true);
    expect(milestoneCompletionRule({ action: "wait_for_element_state", parameters: { state: "present" }, satisfiedMilestoneIds: [] }, semanticObserveOnly)).toBe(true);
    expect(milestoneCompletionRule({ action: "wait_for_element_state", parameters: { state: "hidden" }, satisfiedMilestoneIds: [] }, semanticExpectation)).toBe(false);
  });

  it("never lets get_current_url or report_blocked prove any milestone", () => {
    for (const action of ["get_current_url", "report_blocked"]) {
      expect(milestoneCompletionRule({ action, parameters: {}, satisfiedMilestoneIds: [] }, semanticObserveOnly)).toBe(false);
      expect(milestoneCompletionRule({ action, parameters: {}, satisfiedMilestoneIds: [] }, exactClick)).toBe(false);
    }
  });

  it("requires exactly the required action for an exact-action milestone", () => {
    expect(milestoneCompletionRule({ action: "click_observed_element", parameters: {} }, exactClick)).toBe(true);
    expect(milestoneCompletionRule({ action: "hover_observed_element", parameters: {} }, exactClick)).toBe(false);
  });

  it("never completes an optional hint through the rule", () => {
    const optional = { id: "m-opt", class: "OPTIONAL_HINT", status: "PENDING", description: "Optional recovery." };
    expect(milestoneCompletionRule({ action: "click_observed_element", parameters: {} }, optional)).toBe(false);
  });
});

describe("adaptive file upload", () => {
  const uploadQaIr = () => {
    const qaIr = adaptiveQaIr();
    const scenario = qaIr.suites[0].scenarios[0];
    scenario.steps = scenario.steps.map((step) => (step.id === "click-settings" ? { ...step, action: "UPLOAD", value: "doc" } : step));
    scenario.fixtures = { doc: "src/page/deep-parser/__QA__/fixtures/sample.pdf" };
    return qaIr;
  };

  it("builds an upload_observed_element milestone carrying the designated @qa-fixture", () => {
    const input = createAdaptiveExecutionInput({ qaIr: uploadQaIr(), scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-upload" });
    const milestone = input.milestones.find((item) => item.requiredAction === "upload_observed_element");
    expect(milestone).toBeDefined();
    expect(milestone.fixture).toEqual({ id: "doc", path: "src/page/deep-parser/__QA__/fixtures/sample.pdf" });
    expect(input.capabilityLease.actions).toContain("upload_observed_element"); // offered under the click policy
  });

  it("rejects an upload step whose fixture is not declared with @qa-fixture", () => {
    const qaIr = uploadQaIr();
    delete qaIr.suites[0].scenarios[0].fixtures;
    expect(() => createAdaptiveExecutionInput({ qaIr, scenarioId: "scenario-settings", baseUrl: "https://example.test", runId: "run-x" }))
      .toThrow(/adaptive upload requires a declared @qa-fixture/);
  });
});

function semanticJudgmentQaIr() {
  const qaIr = adaptiveQaIr();
  qaIr.extensions = { semanticJudgmentScenarioIds: ["scenario-settings"] };
  return qaIr;
}

function adaptiveQaIr() {
  return {
    schemaVersion: "qa-ir/0.2",
    id: "qa-ir-settings",
    source: { adapter: "adapter-playwright", adapterVersion: "0.2.0", uri: "settings.spec.ts" },
    suites: [{
      id: "suite-settings",
      title: "Settings",
      tags: ["playwright"],
      scenarios: [{
        id: "scenario-settings",
        title: "Open settings dialog",
        preconditions: [],
        steps: [
          { id: "navigate-dashboard", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } },
          { id: "click-settings", kind: "INTERACT", milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { testId: "settings" } },
          { id: "observe", kind: "OBSERVE", requests: [{ type: "ELEMENT_OBSERVATION" }] },
          { id: "checkpoint", kind: "CHECKPOINT", checkpointId: "checkpoint-settings" },
        ],
        expectations: [{ id: "dialog-visible", kind: "VISIBLE", target: { role: "dialog", accessibleName: { kind: "literal", value: "Settings" } }, provenance: [] }],
        policy: { navigation: "ALLOWED", readDom: true, readNetwork: false, click: "SAFE_ONLY", type: "NONE", upload: false, submit: false, destructiveMutation: false, confirmation: "ALLOW_SAFE", secrets: "RUNTIME_INJECTED" },
        provenance: [],
      }],
      provenance: [],
    }],
    extensions: {},
  };
}
