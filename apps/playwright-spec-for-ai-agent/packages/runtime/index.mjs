import {
  ACTION_SPECS,
  ADAPTIVE_ACTIONS,
  CONTRACT_VIOLATION,
  ELEMENT_BOUND_ACTIONS,
  EXECUTION_AGENT_INPUT_VERSION,
  EXECUTION_AGENT_OUTCOME_VERSION,
  PROVIDER_CAPABILITIES_VERSION,
  canonicalHash,
  snapshotContract,
  validateContract,
} from "../contracts/index.mjs";

export const DEFAULT_ADAPTIVE_BUDGET = Object.freeze({ actions: 32, turns: 32, timeMs: 300_000, tokens: 100_000 });

// Single observation-settle policy: how long an adaptive evidence capture may wait for the DOM
// to fall quiet before sealing. Execution lives in the
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
  const abstractGoal = semantics === undefined ? scenario.title : abstractScenarioGoal(semantics);
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

function abstractScenarioGoal(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.given) || !Array.isArray(value.when) || !Array.isArray(value.then)) throw contractError("execute", "abstract scenario metadata is invalid");
  // Given is evidence context for Judge, never an instruction for the execution agent.
  const items = [...value.when.map(item => `Authored flow: ${item}`), ...value.then.map(item => `Required evidence: ${item}`)];
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
  if (target.origin !== base.origin || target.username || target.password || target.hash) throw contractError("execute", "adaptive start URL must stay on the base origin without credentials or fragment");
  return target.href;
}

function adaptiveSemanticExpectation(expectation) {
  if (!["CONTAINS_TEXT", "VISIBLE", "NOT_VISIBLE", "PRESENT", "DISABLED", "ROLE", "NAME"].includes(expectation.kind) || expectation.target === undefined) return false;
  if (expectation.kind === "CONTAINS_TEXT" && expectation.expected?.kind !== "literal") return false;
  return [expectation.target.accessibleName, expectation.target.text].every((match) => match === undefined || match.kind === "literal");
}

// Single source of truth for "can this accepted action prove this milestone complete".
// The runtime (advanceAdaptiveMilestone) applies this rule PLUS live-only bindings (element
// handles and observation page match); the runtime evidence validator
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

function policyError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  error.code = "POLICY_VIOLATION";
  return error;
}

function contractError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  error.code = CONTRACT_VIOLATION;
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
