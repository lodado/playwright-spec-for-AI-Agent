import {
  CONTRACT_VIOLATION,
  EXECUTION_PLAN_VERSION,
  PROVIDER_CAPABILITIES_VERSION,
  RUNTIME_OUTCOME_VERSION,
  RUNTIME_ERROR_CODES,
  canonicalHash,
  validateContract,
} from "../contracts/index.mjs";

export const DEFAULT_RETRY_POLICY = Object.freeze({ maxAttempts: 1 });
export const DEFAULT_TIMEOUT_POLICY = Object.freeze({ perNodeMs: 30000, runMs: 120000 });

const INTERNAL_ERROR = Symbol("core.internalError");
const MUTATING_KINDS = new Set(["INTERACT"]);
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
  const plan = { ...body, planId: stableId("plan", body) };

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

function nodesForScenario(suite, scenario) {
  return scenario.steps.map((step, index) => ({
    nodeId: stableId("node", [suite.id, scenario.id, step.id ?? index, step.kind]),
    suiteId: suite.id,
    scenarioId: scenario.id,
    stepId: step.id ?? String(index),
    kind: step.kind,
    action: REQUIRED_ACTIONS[step.kind],
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
    if (isMutation(node)) throw policyError(stage, `${node.nodeId} is not allowed in readonly execution`);
    if (node.kind === "NAVIGATE" && node.policy?.navigation !== "ALLOWED") throw policyError(stage, `${node.nodeId} navigation is blocked by policy`);
    if (node.action && !actions.has(node.action)) throw policyError(stage, `${node.action} requires provider action capability`);
    for (const request of node.evidence ?? []) {
      if (request === "NETWORK_LOG" && node.policy?.readNetwork !== true) throw policyError(stage, `${request} requires readNetwork policy`);
      if (request !== "NETWORK_LOG" && node.policy?.readDom !== true) throw policyError(stage, `${request} requires readDom policy`);
      if (!evidence.has(request)) throw policyError(stage, `${request} requires provider evidence capability`);
    }
  }
}

function isMutation(node) {
  const policy = node.policy ?? {};
  return MUTATING_KINDS.has(node.kind)
    || policy.click !== "NONE"
    || policy.type !== "NONE"
    || policy.upload === true
    || policy.submit === true
    || policy.destructiveMutation !== false;
}

function evidenceRequests(step) {
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
