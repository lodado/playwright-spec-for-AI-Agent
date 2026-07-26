import {
  CONTRACT_VIOLATION,
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

const INTERNAL_ERROR = Symbol("core.internalError");
const REQUIRED_ACTIONS = Object.freeze({
  NAVIGATE: "NAVIGATE",
  OBSERVE: "OBSERVE",
  CHECKPOINT: "CHECKPOINT",
});

export function createExecutionPlan({ qaIr, providerCapabilities, retryPolicy = DEFAULT_RETRY_POLICY, timeoutPolicy = DEFAULT_TIMEOUT_POLICY } = {}) {
  validateContract("QaIrDocument", qaIr);
  validateProviderCapabilitiesInput(providerCapabilities);
  validateRetryPolicy(retryPolicy, "plan");
  validateTimeoutPolicy(timeoutPolicy, "plan");

  const scenarios = qaIr.suites.flatMap((suite) => suite.scenarios.map((scenario) => ({ suite, scenario })));
  const nodes = scenarios.flatMap(({ suite, scenario }) => nodesForScenario(suite, scenario));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].nodeId, to: node.nodeId }));
  const body = {
    schemaVersion: EXECUTION_PLAN_VERSION,
    qaIrId: qaIr.id,
    nodes,
    edges,
    retryPolicy: { ...retryPolicy },
    timeoutPolicy: { ...timeoutPolicy },
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
    for (const node of topologicalNodes(plan)) {
      await runWithRetries({ node, executeNode, retryPolicy: plan.retryPolicy, timeoutPolicy: plan.timeoutPolicy, startedAt });
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

    const milestone = inputSnapshot.milestones.find((item) => item.id === inputSnapshot.currentMilestoneId);
    const passiveRecoveryActions = ["observe_dom", "observe_aria", "get_current_url", "scroll_view", "wait_for_element_state"];
    if (milestone.class === "REQUIRED_EXACT_ACTION" && proposalSnapshot.action !== milestone.requiredAction && !passiveRecoveryActions.includes(proposalSnapshot.action)) throw contractError("execute", "action does not match the required exact action");
    if (["click_observed_element", "hover_observed_element", "wait_for_element_state"].includes(proposalSnapshot.action)) {
      const observation = inputSnapshot.recentObservations.find((item) => item.observationId === proposalSnapshot.parameters.observationId);
      if (!observation || observation.pageId !== inputSnapshot.currentPage.pageId || observation.domGeneration !== inputSnapshot.currentPage.domGeneration) throw contractError("execute", "stale observation cannot authorize an action");
      const element = observation.elements.find((item) => item.elementId === proposalSnapshot.parameters.elementId);
      if (!element) throw contractError("execute", "unknown element cannot authorize an action");
      if (!element.allowedActions.includes(proposalSnapshot.action)) throw contractError("execute", "element does not allow the proposed action");
      if (["click_observed_element", "hover_observed_element"].includes(proposalSnapshot.action) && !element.milestoneIds.includes(milestone.id)) throw contractError("execute", "observed element does not match the current milestone");
    }
    if (proposalSnapshot.action === "navigate" && !inputSnapshot.capabilityLease.allowedOrigins.includes(new URL(proposalSnapshot.parameters.url).origin)) throw contractError("execute", "navigation origin is outside the capability lease");
    return Object.freeze({ proposal: proposalSnapshot, remainingBudget: remainingBudget() });
  }

  return Object.freeze({ authorize, remainingBudget });
}

export function advanceAdaptiveMilestone({ input, proposal, result, observation } = {}) {
  const inputSnapshot = snapshotContract("ExecutionAgentInput", input);
  const proposalSnapshot = snapshotContract("ExecutionActionProposal", proposal);
  const resultSnapshot = snapshotContract("ExecutionActionResult", result, { input: inputSnapshot, proposal: proposalSnapshot });
  const observationSnapshot = observation === undefined ? undefined : snapshotContract("ExecutionAgentInput", {
    ...inputSnapshot,
    recentObservations: [observation],
  }).recentObservations[0];
  const milestone = inputSnapshot.milestones.find((item) => item.id === inputSnapshot.currentMilestoneId);
  const boundElement = referencedMilestoneElement(inputSnapshot, proposalSnapshot, milestone.id);
  const matchedObservation = ["observe_dom", "observe_aria"].includes(proposalSnapshot.action)
    && observationSnapshot?.pageId === inputSnapshot.currentPage.pageId
    && observationSnapshot.domGeneration === inputSnapshot.currentPage.domGeneration
    && observationSnapshot.elements.some((element) => element.milestoneIds.includes(milestone.id));
  const acceptedBoundAction = ["click_observed_element", "hover_observed_element", "wait_for_element_state"].includes(proposalSnapshot.action) && boundElement !== undefined;
  const satisfied = resultSnapshot.accepted && (
    (milestone.class === "REQUIRED_EXACT_ACTION" && proposalSnapshot.action === milestone.requiredAction && (!["click_observed_element", "hover_observed_element", "wait_for_element_state"].includes(proposalSnapshot.action) || boundElement !== undefined))
    || (milestone.class === "REQUIRED_SEMANTIC_MILESTONE" && (matchedObservation || (proposalSnapshot.action === "wait_for_element_state" && ["present", "visible"].includes(proposalSnapshot.parameters.state) && boundElement !== undefined)))
    || (milestone.class === "OPTIONAL_HINT" && acceptedBoundAction)
  );
  if (!satisfied) return undefined;

  const milestones = inputSnapshot.milestones.map((item) => item.id === milestone.id ? { ...item, status: "COMPLETED" } : item);
  const next = milestones.find((item) => item.status === "PENDING" && item.class !== "OPTIONAL_HINT");
  if (next === undefined) {
    return Object.freeze({
      outcome: snapshotContract("ExecutionAgentOutcome", {
        schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
        runId: inputSnapshot.runId,
        scenarioId: inputSnapshot.scenarioId,
        type: "COMPLETED",
        completedMilestoneIds: milestones.filter((item) => item.status === "COMPLETED").map((item) => item.id),
      }, { input: inputSnapshot }),
    });
  }
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

function referencedMilestoneElement(input, proposal, milestoneId) {
  if (!["click_observed_element", "hover_observed_element", "wait_for_element_state"].includes(proposal.action)) return undefined;
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

async function runWithRetries({ node, executeNode, retryPolicy, timeoutPolicy, startedAt }) {
  let lastError;
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    try {
      await withTimeout(runRemainingMs(timeoutPolicy, startedAt), "Execution timed out", () =>
        withTimeout(timeoutPolicy.perNodeMs, "Execution timed out", () => executeNode(node))
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
  if (node.action !== "CLICK") throw policyError(stage, `${node.action} is not supported for execution`);
  if (node.policy?.click !== "SAFE_ONLY" && node.policy?.click !== "ALL") throw policyError(stage, `${node.nodeId} click is blocked by policy`);
  if (node.policy?.submit !== false || node.policy?.destructiveMutation !== false) throw policyError(stage, `${node.nodeId} click exceeds safe interaction policy`);
  if (node.evidence?.length !== 1 || node.evidence[0] !== "ACTION_LOG") throw policyError(stage, `${node.nodeId} click requires ACTION_LOG evidence`);
}

function evidenceRequests(step) {
  if (step.kind === "INTERACT" && step.action === "CLICK") return ["ACTION_LOG"];
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
