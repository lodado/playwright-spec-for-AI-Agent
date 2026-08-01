import {
  ACTION_SPECS,
  ADAPTIVE_ACTIONS,
  CONTRACT_VIOLATION,
  ELEMENT_BOUND_ACTIONS,
  EXECUTION_AGENT_INPUT_VERSION,
  EXECUTION_AGENT_OUTCOME_VERSION,
  EXECUTION_PLAN_VERSION,
  PROVIDER_CAPABILITIES_VERSION,
  RUNTIME_OUTCOME_VERSION,
  RUNTIME_ERROR_CODES,
  canonicalHash,
  snapshotContract,
  validateContract,
} from "../contracts/index.mjs";

export const DEFAULT_RETRY_POLICY = Object.freeze({ maxAttempts: 1 });
export const DEFAULT_TIMEOUT_POLICY = Object.freeze({ perNodeMs: 30000, runMs: 120000 });
const MAX_DEFAULT_RUN_TIMEOUT_MS = 300_000;
export const DEFAULT_ADAPTIVE_BUDGET = Object.freeze({ actions: 32, turns: 32, timeMs: 300_000, tokens: 100_000 });

// Single observation-settle policy: how long any evidence capture (a strict OBSERVE node or an
// adaptive snapshot) may wait for the DOM to fall quiet before sealing. Execution lives in the
// provider; the numbers and the clamp rule live here so runtime, validator docs, and prompts can
// never disagree about them. Returns undefined when the remaining budget cannot fund a settle —
// callers must treat that as "capture as-is", never as an error (a bounded wait must never become
// a run-killing timeout).
export const OBSERVATION_SETTLE_POLICY = Object.freeze({ capMs: 5_000, quietMs: 300, reserveMs: 1_000 });

export function observationSettleBudget(remainingMs, policy = OBSERVATION_SETTLE_POLICY) {
  if (!Number.isFinite(remainingMs)) return undefined;
  const capMs = Math.min(policy.capMs, remainingMs - policy.reserveMs);
  return capMs > 0 ? { capMs, quietMs: policy.quietMs } : undefined;
}

const INTERNAL_ERROR = Symbol("core.internalError");
const REQUIRED_ACTIONS = Object.freeze({
  NAVIGATE: "NAVIGATE",
  OBSERVE: "OBSERVE",
  CHECKPOINT: "CHECKPOINT",
});

export function createExecutionPlan({ qaIr, providerCapabilities, retryPolicy = DEFAULT_RETRY_POLICY, timeoutPolicy } = {}) {
  validateContract("QaIrDocument", qaIr);
  validateProviderCapabilitiesInput(providerCapabilities);
  validateRetryPolicy(retryPolicy, "plan");

  const scenarios = qaIr.suites.flatMap((suite) => suite.scenarios.map((scenario) => ({ suite, scenario })));
  // ponytail: page runs cap at the provider's five-minute limit; split larger suites if they exhaust it.
  const effectiveTimeoutPolicy = timeoutPolicy ?? {
    ...DEFAULT_TIMEOUT_POLICY,
    runMs: Math.min(MAX_DEFAULT_RUN_TIMEOUT_MS, Math.max(DEFAULT_TIMEOUT_POLICY.runMs, scenarios.length * DEFAULT_TIMEOUT_POLICY.perNodeMs)),
  };
  validateTimeoutPolicy(effectiveTimeoutPolicy, "plan");
  const nodes = scenarios.flatMap(({ suite, scenario }) => nodesForScenario(suite, scenario));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].nodeId, to: node.nodeId }));
  const body = {
    schemaVersion: EXECUTION_PLAN_VERSION,
    qaIrId: qaIr.id,
    nodes,
    edges,
    retryPolicy: { ...retryPolicy },
    timeoutPolicy: { ...effectiveTimeoutPolicy },
  };
  const plan = { ...body, planId: stableId("plan", { ...body, qaIrHash: canonicalHash(qaIr) }) };

  validatePlanShape(plan, "plan");
  validatePolicyAndCapabilities(plan, providerCapabilities, "plan");
  return validateContract("ExecutionPlan", plan);
}

export async function executePlan({ plan, providerCapabilities, executeNode } = {}) {
  try {
    validateContract("ExecutionPlan", plan);
    validateProviderCapabilitiesInput(providerCapabilities);
    validatePlanShape(plan, "execute");
    if (typeof executeNode !== "function") throw contractError("execute", "executeNode must be a function");
    validatePolicyAndCapabilities(plan, providerCapabilities, "execute");

    const startedAt = Date.now();
    const nodes = topologicalNodes(plan);
    for (const [index, node] of nodes.entries()) {
      await runWithRetries({ node, executeNode, retryPolicy: plan.retryPolicy, timeoutPolicy: plan.timeoutPolicy, startedAt, remainingNodes: nodes.length - index });
    }

    return completed("execute");
  } catch (error) {
    if (error?.[INTERNAL_ERROR] && (error.code === CONTRACT_VIOLATION || error.code === "POLICY_VIOLATION")) {
      return runtimeError("execute", error.code, error.message);
    }
    if (error?.code === "TIMEOUT") return runtimeError("execute", "UNKNOWN_RUNTIME_ERROR", "Execution timed out");
    return runtimeError("execute", runtimeErrorCode(error?.code), "Execution provider failed");
  }
}

export function validateExecutionPlanBinding({ qaIr, plan, providerCapabilities } = {}) {
  validateContract("QaIrDocument", qaIr);
  validateContract("ExecutionPlan", plan);
  validateProviderCapabilitiesInput(providerCapabilities);
  const expected = createExecutionPlan({
    qaIr,
    providerCapabilities,
    retryPolicy: plan.retryPolicy,
    timeoutPolicy: plan.timeoutPolicy,
  });
  if (canonicalHash(plan) !== canonicalHash(expected)) throw contractError("execute", "execution plan does not match QA IR and provider capabilities");
  return plan;
}

export function createAdaptiveActionAuthorizer({ input, now = Date.now } = {}) {
  if (typeof now !== "function") throw contractError("execute", "now must be a function");
  const inputSnapshot = snapshotContract("ExecutionAgentInput", input);
  const readNow = () => {
    const value = now();
    if (!Number.isFinite(value)) throw contractError("execute", "now must return a finite number");
    return value;
  };
  const startedAt = readNow();
  const deadline = startedAt + inputSnapshot.remainingBudget.timeMs;
  const seenProposalIds = new Set();
  let actions = inputSnapshot.remainingBudget.actions;
  let turns = inputSnapshot.remainingBudget.turns;
  let timeMs = inputSnapshot.remainingBudget.timeMs;
  let tokens = inputSnapshot.remainingBudget.tokens;

  function remainingBudget() {
    timeMs = Math.min(timeMs, Math.max(0, Math.floor(deadline - readNow())));
    return Object.freeze({ actions, turns, timeMs, tokens });
  }

  function authorize({ proposal, tokensUsed = 0 } = {}) {
    const proposalSnapshot = snapshotContract("ExecutionActionProposal", proposal);
    if (!Number.isInteger(tokensUsed) || tokensUsed < 0) throw contractError("execute", "tokensUsed must be a non-negative integer");
    if (seenProposalIds.has(proposalSnapshot.proposalId)) throw contractError("execute", "action proposal was already consumed");
    const before = remainingBudget();
    if (before.actions < 1 || before.turns < 1 || before.timeMs < 1 || tokensUsed > before.tokens || before.tokens < 1) throw contractError("execute", "adaptive execution budget is exhausted");
    seenProposalIds.add(proposalSnapshot.proposalId);
    actions -= 1;
    turns -= 1;
    tokens -= tokensUsed;

    if (proposalSnapshot.runId !== inputSnapshot.runId || proposalSnapshot.scenarioId !== inputSnapshot.scenarioId) throw contractError("execute", "action proposal is bound to a different run or scenario");
    if (proposalSnapshot.milestoneId !== inputSnapshot.currentMilestoneId) throw contractError("execute", "action proposal does not target the current milestone");
    if (proposalSnapshot.leaseId !== inputSnapshot.capabilityLease.leaseId || !inputSnapshot.capabilityLease.actions.includes(proposalSnapshot.action)) throw contractError("execute", "action is outside the capability lease");
    if (proposalSnapshot.action === "wait_for_element_state" && proposalSnapshot.parameters.timeoutMs > remainingBudget().timeMs) throw contractError("execute", "wait exceeds the remaining time budget");
    if (proposalSnapshot.action === "report_blocked" && proposalSnapshot.parameters.milestoneId !== inputSnapshot.currentMilestoneId) throw contractError("execute", "report_blocked must target the current milestone");

    const milestone = inputSnapshot.milestones.find((item) => item.id === inputSnapshot.currentMilestoneId);
    const safeRecoveryActions = ADAPTIVE_ACTIONS.filter((action) => ACTION_SPECS[action].recovery);
    if (milestone.class === "REQUIRED_EXACT_ACTION" && proposalSnapshot.action !== milestone.requiredAction && !safeRecoveryActions.includes(proposalSnapshot.action)) throw contractError("execute", "action does not match the required exact action");
    if (ELEMENT_BOUND_ACTIONS.includes(proposalSnapshot.action)) {
      const observation = inputSnapshot.recentObservations.find((item) => item.observationId === proposalSnapshot.parameters.observationId);
      if (!observation || observation.pageId !== inputSnapshot.currentPage.pageId || observation.domGeneration !== inputSnapshot.currentPage.domGeneration) throw contractError("execute", "stale observation cannot authorize an action");
      const element = observation.elements.find((item) => item.elementId === proposalSnapshot.parameters.elementId);
      if (!element) throw contractError("execute", "unknown element cannot authorize an action");
      if (!element.allowedActions.includes(proposalSnapshot.action)) throw contractError("execute", "element does not allow the proposed action");
      if (proposalSnapshot.action === "click_observed_element" && !element.milestoneIds.includes(milestone.id)) {
        const optionalRecovery = element.milestoneIds.some((id) => inputSnapshot.milestones.some((item) => item.id === id && item.class === "OPTIONAL_HINT"));
        const autonomousRecovery = milestone.class === "REQUIRED_EXACT_ACTION";
        if (!optionalRecovery && !autonomousRecovery) throw contractError("execute", "observed click is outside exact and recovery boundaries");
      }
    }
    if (proposalSnapshot.action === "navigate" && !inputSnapshot.capabilityLease.allowedOrigins.includes(new URL(proposalSnapshot.parameters.url).origin)) throw contractError("execute", "navigation origin is outside the capability lease");
    return Object.freeze({ proposal: proposalSnapshot, remainingBudget: remainingBudget() });
  }

  return Object.freeze({ authorize, remainingBudget });
}

export function createAdaptiveExecutionInput({ qaIr, scenarioId, baseUrl, runId, budget = DEFAULT_ADAPTIVE_BUDGET, allowedOrigins = [] } = {}) {
  const qaIrSnapshot = snapshotContract("QaIrDocument", qaIr);
  if (typeof runId !== "string" || runId.length === 0) throw contractError("execute", "runId must be a non-empty string");
  const scenario = qaIrSnapshot.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === scenarioId);
  if (!scenario) throw contractError("execute", "scenarioId does not exist in QA IR");
  const navigationStep = scenario.steps.find((step) => step.kind === "NAVIGATE");
  const interactionSteps = scenario.steps.filter((step) => step.kind === "INTERACT");
  if (scenario.policy.readDom !== true) throw policyError("execute", "adaptive DOM observation is blocked by scenario policy");
  if (navigationStep && scenario.policy.navigation !== "ALLOWED") throw policyError("execute", "adaptive startup navigation is blocked by scenario policy");
  if (interactionSteps.length > 0 && !["SAFE_ONLY", "ALL"].includes(scenario.policy.click)) throw policyError("execute", "adaptive interaction is blocked by scenario policy");
  const semantics = scenario.semantics ?? qaIrSnapshot.extensions?.abstractScenarios?.[scenario.id];
  const isSemantic = semantics !== undefined || (qaIrSnapshot.extensions?.semanticJudgmentScenarioIds ?? []).includes(scenario.id);
  const abstractGoal = abstractScenarioGoal(semantics, scenario.title);
  if (!isSemantic) {
    const unsupportedExpectations = scenario.expectations.filter((expectation) => !adaptiveSemanticExpectation(expectation));
    if (unsupportedExpectations.length > 0) throw contractError("execute", `adaptive execution does not support expectation ${unsupportedExpectations[0].kind}`);
  }
  const startUrl = adaptiveStartUrl(baseUrl, navigationStep);
  const leaseOrigins = adaptiveAllowedOrigins(startUrl, allowedOrigins);
  const interactionMilestones = interactionSteps.map((step) => {
    if (step.action === "CLICK") {
      return { id: step.id, class: step.milestoneClass, status: "PENDING", description: "Perform required click action.", requiredAction: "click_observed_element", target: structuredClone(step.target) };
    }
    if (step.action === "UPLOAD") {
      // File upload is designated by @qa-fixture (author-controlled): the AI replays exactly that
      // file, never one it chose. The scenario is blocked at compile time when the fixture is absent.
      const fixturePath = scenario.fixtures?.[step.value];
      if (typeof step.value !== "string" || typeof fixturePath !== "string") throw contractError("execute", "adaptive upload requires a declared @qa-fixture");
      return { id: step.id, class: step.milestoneClass, status: "PENDING", description: "Upload the designated fixture to the required file input.", requiredAction: "upload_observed_element", target: structuredClone(step.target), fixture: { id: step.value, path: fixturePath } };
    }
    throw contractError("execute", `${step.action} is not supported by adaptive execution`);
  });
  const milestones = isSemantic
    ? [
        ...interactionMilestones,
        {
          id: `evidence-${canonicalHash({ runId, scenarioId: scenario.id }).slice("sha256:".length, "sha256:".length + 16)}`,
          class: "REQUIRED_SEMANTIC_MILESTONE",
          status: "PENDING",
          description: "Observe the page and collect visible text and ARIA evidence for semantic judgment.",
          ...(semantics === undefined ? {} : { exploratory: true }),
        },
      ]
    : [
        ...interactionMilestones,
        ...scenario.expectations.map((expectation) => ({
          id: expectation.id,
          class: "REQUIRED_SEMANTIC_MILESTONE",
          status: "PENDING",
          description: `Observe required ${expectation.kind.toLowerCase()} target.`,
          target: structuredClone(expectation.target),
          expectation: {
            kind: expectation.kind,
            ...(expectation.expected === undefined ? {} : { expected: structuredClone(expectation.expected) }),
          },
        })),
      ];
  if (milestones.length === 0) throw contractError("execute", "scenario has no adaptive milestones");
  // Lease order is base actions, then navigation, then click — grouped, not interleaved — because
  // the order feeds the leaseId hash and pre-refactor runs relied on this grouping.
  const leasePolicyAllows = (action) => {
    const requires = ACTION_SPECS[action].requiresPolicy;
    if (requires === "navigation") return scenario.policy.navigation === "ALLOWED";
    if (requires === "click") return ["SAFE_ONLY", "ALL"].includes(scenario.policy.click);
    return true;
  };
  const leaseGroup = (group) => ADAPTIVE_ACTIONS.filter((action) => ACTION_SPECS[action].requiresPolicy === group && leasePolicyAllows(action));
  const actions = [...leaseGroup(undefined), ...leaseGroup("navigation"), ...leaseGroup("click")];
  return snapshotContract("ExecutionAgentInput", {
    schemaVersion: EXECUTION_AGENT_INPUT_VERSION,
    runId,
    scenarioId: scenario.id,
    goal: { id: `goal-${canonicalHash({ qaIrId: qaIrSnapshot.id, scenarioId: scenario.id }).slice("sha256:".length, "sha256:".length + 16)}`, description: abstractGoal },
    milestones,
    currentMilestoneId: milestones[0].id,
    currentPage: { pageId: `page-${canonicalHash({ runId, scenarioId: scenario.id, startUrl }).slice("sha256:".length, "sha256:".length + 12)}`, domGeneration: 1, url: startUrl },
    recentObservations: [],
    capabilityLease: { leaseId: `lease-${canonicalHash({ runId, scenarioId: scenario.id, actions, origins: leaseOrigins }).slice("sha256:".length, "sha256:".length + 16)}`, actions, allowedOrigins: leaseOrigins },
    remainingBudget: { ...budget },
  });
}

function abstractScenarioGoal(value, fallback) {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || !Array.isArray(value.applicability) || !Array.isArray(value.when) || !Array.isArray(value.claims)) throw contractError("execute", "abstract scenario metadata is invalid");
  const items = [fallback, ...value.applicability.map(item => `Applicable when: ${item}`), ...value.when.map(item => `Authored flow: ${item}`), ...value.claims.map(item => `Required evidence: ${item}`)];
  if (items.some(item => typeof item !== "string")) throw contractError("execute", "abstract scenario metadata is invalid");
  return items.join("\n").slice(0, 4_096);
}

function adaptiveAllowedOrigins(startUrl, allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 7) throw contractError("execute", "allowedOrigins must contain at most seven explicit HTTP(S) origins");
  const origins = [new URL(startUrl).origin];
  for (const value of allowedOrigins) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw contractError("execute", "allowedOrigins must contain HTTP(S) origins");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw contractError("execute", "allowedOrigins must contain HTTP(S) origins");
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

function adaptiveStartUrl(baseUrl, navigationStep) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw contractError("execute", "baseUrl must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw contractError("execute", "baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment");
  const target = navigationStep === undefined ? base : new URL(navigationStep.target.value, base);
  if (target.origin !== base.origin || target.username || target.password || target.search || target.hash) throw contractError("execute", "adaptive start URL must stay on the base origin without credentials, query, or fragment");
  return target.href;
}

function adaptiveSemanticExpectation(expectation) {
  if (!["CONTAINS_TEXT", "VISIBLE", "NOT_VISIBLE", "PRESENT", "DISABLED", "ROLE", "NAME"].includes(expectation.kind) || expectation.target === undefined) return false;
  if (expectation.kind === "CONTAINS_TEXT" && expectation.expected?.kind !== "literal") return false;
  return [expectation.target.accessibleName, expectation.target.text].every((match) => match === undefined || match.kind === "literal");
}

// Single source of truth for "can this accepted action prove this milestone complete".
// The runtime (advanceAdaptiveMilestone) applies this rule PLUS live-only bindings (element
// handles, observation page match); the evidence validator (cli/qa-native-adaptive-evidence)
// applies exactly this rule — so validator acceptance stays a necessary condition of runtime
// acceptance and the two can never drift apart again.
export function milestoneCompletionRule({ action, parameters, satisfiedMilestoneIds } = {}, milestone) {
  if (milestone.class === "REQUIRED_EXACT_ACTION") {
    if (action !== milestone.requiredAction) return false;
    return ACTION_SPECS[action]?.elementBound !== true || satisfiedMilestoneIds?.includes(milestone.id) === true;
  }
  if (milestone.class !== "REQUIRED_SEMANTIC_MILESTONE") return false;
  const proof = ACTION_SPECS[action]?.provesSemantic;
  const observeAction = proof === true;
  const waitAction = Array.isArray(proof) && proof.includes(parameters?.state);
  if (!observeAction && !waitAction) return false;
  // Milestones without an expectation (observe-only evidence milestones, bare targets) are proven
  // by the observation itself; the gateway seals satisfiedMilestoneIds only for expectation checks.
  if (milestone.expectation === undefined) return true;
  return waitAction || satisfiedMilestoneIds?.includes(milestone.id) === true;
}

export function advanceAdaptiveMilestone({ input, proposal, result, observation, satisfiedMilestoneIds = [] } = {}) {
  const inputSnapshot = snapshotContract("ExecutionAgentInput", input);
  const proposalSnapshot = snapshotContract("ExecutionActionProposal", proposal);
  const resultSnapshot = snapshotContract("ExecutionActionResult", result, { input: inputSnapshot, proposal: proposalSnapshot });
  const observationSnapshot = observation === undefined ? undefined : snapshotContract("ExecutionAgentInput", {
    ...inputSnapshot,
    recentObservations: [observation],
  }).recentObservations[0];
  const milestone = inputSnapshot.milestones.find((item) => item.id === inputSnapshot.currentMilestoneId);
  if (proposalSnapshot.action === "report_blocked" && resultSnapshot.accepted) {
    const milestones = inputSnapshot.milestones.map((item) => item.id === milestone.id ? { ...item, status: "BLOCKED" } : item);
    const next = milestones.find((item) => item.status === "PENDING" && item.class !== "OPTIONAL_HINT");
    if (next === undefined) return Object.freeze({ outcome: adaptiveTerminalOutcome(inputSnapshot, milestones, proposalSnapshot.parameters.reason) });
    return Object.freeze({
      input: snapshotContract("ExecutionAgentInput", {
        ...inputSnapshot,
        milestones,
        currentMilestoneId: next.id,
        currentPage: resultSnapshot.page,
        recentObservations: [],
        remainingBudget: resultSnapshot.remainingBudget,
      }),
    });
  }
  const boundElement = referencedMilestoneElement(inputSnapshot, proposalSnapshot, milestone.id);
  const boundAction = ELEMENT_BOUND_ACTIONS.includes(proposalSnapshot.action);
  // Live-only bindings on top of milestoneCompletionRule: an observation must describe the page
  // the action ran on (and name the milestone's element when the milestone has a bare target),
  // and element-bound actions must reference an element observed for this milestone.
  const matchedObservation = ACTION_SPECS[proposalSnapshot.action]?.provesSemantic === true
    && observationSnapshot?.pageId === inputSnapshot.currentPage.pageId
    && observationSnapshot.domGeneration === inputSnapshot.currentPage.domGeneration
    && (milestone.expectation === undefined && milestone.target !== undefined
      ? observationSnapshot.elements.some((element) => element.milestoneIds.includes(milestone.id))
      : true);
  const acceptedBoundAction = boundAction && boundElement !== undefined;
  const ruleProof = milestoneCompletionRule({
    action: proposalSnapshot.action,
    parameters: proposalSnapshot.parameters,
    satisfiedMilestoneIds: [...new Set([...(observationSnapshot?.satisfiedMilestoneIds ?? []), ...satisfiedMilestoneIds])],
  }, milestone);
  const satisfied = resultSnapshot.accepted && (
    (ruleProof && (ACTION_SPECS[proposalSnapshot.action]?.provesSemantic === true ? matchedObservation : !boundAction || boundElement !== undefined))
    || (milestone.class === "OPTIONAL_HINT" && acceptedBoundAction)
  );
  if (!satisfied) return undefined;

  let completeSemanticMilestones = milestone.class === "REQUIRED_SEMANTIC_MILESTONE";
  const milestones = inputSnapshot.milestones.map((item) => {
    if (item.id === milestone.id) return { ...item, status: "COMPLETED" };
    if (completeSemanticMilestones && item.status === "PENDING" && item.class === "REQUIRED_SEMANTIC_MILESTONE" && observationSnapshot?.satisfiedMilestoneIds?.includes(item.id)) return { ...item, status: "COMPLETED" };
    if (item.status === "PENDING" && item.class !== "OPTIONAL_HINT") completeSemanticMilestones = false;
    return item;
  });
  const next = milestones.find((item) => item.status === "PENDING" && item.class !== "OPTIONAL_HINT");
  if (next === undefined) return Object.freeze({ outcome: adaptiveTerminalOutcome(inputSnapshot, milestones) });
  return Object.freeze({
    input: snapshotContract("ExecutionAgentInput", {
      ...inputSnapshot,
      milestones,
      currentMilestoneId: next.id,
      currentPage: resultSnapshot.page,
      recentObservations: [],
      remainingBudget: resultSnapshot.remainingBudget,
    }),
  });
}

// The reason is the agent's claim, never a verdict — the judge rules on the sealed evidence.
function adaptiveTerminalOutcome(input, milestones, reportedReason) {
  const blockedIds = milestones.filter((item) => item.status === "BLOCKED").map((item) => item.id);
  return snapshotContract("ExecutionAgentOutcome", {
    schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
    runId: input.runId,
    scenarioId: input.scenarioId,
    ...(blockedIds.length === 0 ? { type: "COMPLETED" } : {
      type: "BLOCKED",
      reason: `Milestone(s) ${blockedIds.join(", ")} reported blocked by the execution agent${reportedReason === undefined ? "" : `; unverified claim: ${reportedReason}`}`.slice(0, 4_096),
    }),
    completedMilestoneIds: milestones.filter((item) => item.status === "COMPLETED").map((item) => item.id),
  }, { input });
}

function referencedMilestoneElement(input, proposal, milestoneId) {
  if (!ELEMENT_BOUND_ACTIONS.includes(proposal.action)) return undefined;
  const observation = input.recentObservations.find((item) => item.observationId === proposal.parameters.observationId);
  if (observation?.pageId !== input.currentPage.pageId || observation.domGeneration !== input.currentPage.domGeneration) return undefined;
  return observation.elements.find((item) => item.elementId === proposal.parameters.elementId && item.milestoneIds.includes(milestoneId));
}

function nodesForScenario(suite, scenario) {
  return scenario.steps.map((step, index) => ({
    nodeId: stableId("node", [suite.id, scenario.id, step.id ?? index, step.kind]),
    suiteId: suite.id,
    scenarioId: scenario.id,
    stepId: step.id ?? String(index),
    kind: step.kind,
    ...((step.kind === "NAVIGATE" || step.kind === "INTERACT") ? { milestoneClass: step.milestoneClass } : {}),
    action: step.kind === "INTERACT" ? step.action : REQUIRED_ACTIONS[step.kind],
    ...(step.kind === "INTERACT" && step.value !== undefined ? { value: step.value } : {}),
    evidence: evidenceRequests(step),
    policy: { ...scenario.policy },
  }));
}

function validatePlanShape(plan, stage) {
  validateRetryPolicy(plan.retryPolicy, stage);
  validateTimeoutPolicy(plan.timeoutPolicy, stage);
  topologicalNodes(plan, stage);
}

function validateRetryPolicy(policy, stage) {
  if (!isExactObject(policy, ["maxAttempts"]) || !positiveInteger(policy.maxAttempts)) {
    throw contractError(stage, "retryPolicy must be exactly {maxAttempts} with a positive integer");
  }
}

function validateTimeoutPolicy(policy, stage) {
  if (!isExactObject(policy, ["perNodeMs", "runMs"]) || !positiveInteger(policy.perNodeMs) || !positiveInteger(policy.runMs) || policy.runMs < policy.perNodeMs) {
    throw contractError(stage, "timeoutPolicy must be exactly {perNodeMs, runMs} with positive integers and runMs >= perNodeMs");
  }
}

function topologicalNodes(plan, stage = "execute") {
  const byId = new Map();
  plan.nodes.forEach((node, index) => {
    if (byId.has(node.nodeId)) throw contractError(stage, `duplicate nodeId ${node.nodeId}`);
    byId.set(node.nodeId, { node, index, indegree: 0, next: [] });
  });

  for (const edge of plan.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) throw contractError(stage, `edge references unknown node ${edge.from} -> ${edge.to}`);
    from.next.push(to);
    to.indegree += 1;
  }

  const ready = [...byId.values()].filter((item) => item.indegree === 0).sort(byOriginalIndex);
  const ordered = [];
  while (ready.length) {
    const item = ready.shift();
    ordered.push(item.node);
    for (const next of item.next.sort(byOriginalIndex)) {
      next.indegree -= 1;
      if (next.indegree === 0) ready.push(next);
    }
    ready.sort(byOriginalIndex);
  }

  if (ordered.length !== plan.nodes.length) throw contractError(stage, "execution graph contains a cycle");
  return ordered;
}

async function runWithRetries({ node, executeNode, retryPolicy, timeoutPolicy, startedAt, remainingNodes }) {
  let lastError;
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    try {
      const remainingRunMs = runRemainingMs(timeoutPolicy, startedAt);
      const nodeTimeoutMs = Math.max(1, Math.min(timeoutPolicy.perNodeMs, Math.floor(remainingRunMs / remainingNodes)));
      await withTimeout(remainingRunMs, "Execution timed out", () =>
        withTimeout(nodeTimeoutMs, "Execution timed out", () => executeNode(node, { timeoutMs: nodeTimeoutMs }))
      );
      return;
    } catch (error) {
      if (error?.code === "TIMEOUT") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function runRemainingMs(timeoutPolicy, startedAt) {
  return Math.max(1, timeoutPolicy.runMs - (Date.now() - startedAt));
}

// ponytail: Promise.race does not cancel provider work; add AbortSignal when provider cancellation is required.
function withTimeout(ms, message, fn) {
  let timer;
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = "TIMEOUT";
        reject(error);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function validatePolicyAndCapabilities(plan, providerCapabilities, stage) {
  const actions = new Set(providerCapabilities.actions);
  const evidence = new Set(providerCapabilities.evidence);

  for (const node of plan.nodes) {
    validateCanonicalNode(node, stage);
    if (node.kind === "INTERACT") validateInteractionPolicy(node, stage);
    if (node.kind === "NAVIGATE" && node.policy?.navigation !== "ALLOWED") throw policyError(stage, `${node.nodeId} navigation is blocked by policy`);
    if (node.action && !actions.has(node.action)) throw policyError(stage, `${node.action} requires provider action capability`);
    for (const request of node.evidence ?? []) {
      if (request === "NETWORK_LOG" && node.policy?.readNetwork !== true) throw policyError(stage, `${request} requires readNetwork policy`);
      if (request !== "NETWORK_LOG" && request !== "ACTION_LOG" && node.policy?.readDom !== true) throw policyError(stage, `${request} requires readDom policy`);
      if (!evidence.has(request)) throw policyError(stage, `${request} requires provider evidence capability`);
    }
  }
}

function validateCanonicalNode(node, stage) {
  if (node.kind === "INTERACT") return;
  const action = REQUIRED_ACTIONS[node.kind];
  if (action === undefined || node.action !== action) throw contractError(stage, `${node.nodeId} has a non-canonical kind/action combination`);
  if (node.kind !== "OBSERVE" && node.evidence?.length !== 0) throw contractError(stage, `${node.nodeId} has non-canonical evidence`);
  if (node.kind === "OBSERVE" && node.evidence?.includes("ACTION_LOG")) throw contractError(stage, `${node.nodeId} has non-canonical evidence`);
}

function validateInteractionPolicy(node, stage) {
  // CLICK and UPLOAD are the executable strict interactions; both stay inside the same safe envelope
  // (no form submit, no destructive mutation) and require a click-enabled policy.
  if (node.action !== "CLICK" && node.action !== "UPLOAD") throw policyError(stage, `${node.action} is not supported for execution`);
  if (node.policy?.click !== "SAFE_ONLY" && node.policy?.click !== "ALL") throw policyError(stage, `${node.nodeId} click is blocked by policy`);
  if (node.policy?.submit !== false || node.policy?.destructiveMutation !== false) throw policyError(stage, `${node.nodeId} click exceeds safe interaction policy`);
  if (node.evidence?.length !== 1 || node.evidence[0] !== "ACTION_LOG") throw policyError(stage, `${node.nodeId} click requires ACTION_LOG evidence`);
}

function evidenceRequests(step) {
  if (step.kind === "INTERACT" && (step.action === "CLICK" || step.action === "UPLOAD")) return ["ACTION_LOG"];
  if (step.kind !== "OBSERVE") return [];
  return (step.requests ?? []).map((request) => request.type).filter(Boolean).sort();
}

function validateProviderCapabilitiesInput(providerCapabilities) {
  return validateContract("ProviderCapabilities", providerCapabilities);
}

function stableId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice("sha256:".length, "sha256:".length + 16)}`;
}

function completed(stage) {
  return validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage, type: "COMPLETED" });
}

function runtimeError(stage, code, message) {
  return validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage, type: "ERROR", code, message });
}

function runtimeErrorCode(code) {
  return RUNTIME_ERROR_CODES.includes(code) ? code : "UNKNOWN_RUNTIME_ERROR";
}

function policyError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  error.code = "POLICY_VIOLATION";
  error[INTERNAL_ERROR] = true;
  return error;
}

function contractError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  error.code = CONTRACT_VIOLATION;
  error[INTERNAL_ERROR] = true;
  return error;
}

function isExactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function byOriginalIndex(left, right) {
  return left.index - right.index;
}

export function providerCapabilities({ providerId = "test-provider", actions = ["NAVIGATE", "OBSERVE", "CHECKPOINT"], evidence = ["VISIBLE_TEXT"] } = {}) {
  return validateContract("ProviderCapabilities", {
    schemaVersion: PROVIDER_CAPABILITIES_VERSION,
    providerId,
    actions,
    evidence,
  });
}
