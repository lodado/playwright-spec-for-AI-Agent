import { createHash } from "node:crypto";

export type Distribution =
  | { type: "fixed"; value: number }
  | { type: "categorical"; values: Array<{ value: number | string; probability: number }> }
  | { type: "beta"; alpha: number; beta: number }
  | { type: "normal"; mean: number; stddev: number; min?: number; max?: number }
  | { type: "empirical"; samples: number[] };

export interface BehaviorPolicyDefinition {
  retryPropensity: Distribution;
  backtrackPropensity: Distribution;
  abandonmentPropensity: Distribution;
  signupResistance: Distribution;
  priceSensitivity: Distribution;
  explorationDepth: Distribution;
  readingDepth: Distribution;
  errorRecoveryAttempts: Distribution;
  noActionPropensity: Distribution;
}

export interface AttentionPolicyDefinition {
  viewportOnly: boolean;
  maxCandidateElements: number;
  primaryCtaWeight: number;
  headingWeight: number;
  textGoalMatchWeight: number;
  visualSaliencyWeight: number;
  priorExpectationWeight: number;
  inspectBelowFoldProbability: Distribution;
  inspectSecondaryNavigationProbability: Distribution;
}

export interface SampledBehaviorPolicy {
  seed: number;
  values: Record<keyof BehaviorPolicyDefinition, number | string>;
}

export interface PersonaRuntimeState {
  perceivedProgress: number;
  frustration: number;
  trust: number;
  perceivedValue: number;
  confidence: number;
  noProgressCount: number;
  recoveryAttempts: number;
  backtrackCount: number;
  knownFacts: string[];
  uncertainties: string[];
}

type ObservedElement = {
  id: string;
  visible: boolean;
  enabled?: boolean;
  inViewport?: boolean;
  occluded?: boolean;
  viewportPosition?: { inViewport?: boolean; occluded?: boolean };
  secondaryNavigation?: boolean;
  primaryCta?: boolean;
  heading?: boolean;
  goalMatch?: number;
  salience?: number;
};

export const PRESETS = Object.freeze({
  impatient_new_user: preset(0.15, 0.15, 0.8, 0.8, 0.7, 0.2, 0.2, 1, 0.35),
  careful_business_buyer: preset(0.45, 0.35, 0.25, 0.45, 0.5, 0.65, 0.9, 2, 0.15),
  low_domain_knowledge_user: preset(0.35, 0.7, 0.55, 0.5, 0.45, 0.4, 0.55, 2, 0.25),
  exploratory_power_user: preset(0.8, 0.55, 0.1, 0.2, 0.2, 0.95, 0.7, 4, 0.08),
  price_sensitive_user: preset(0.3, 0.45, 0.65, 0.8, 0.95, 0.5, 0.65, 2, 0.2),
});

function preset(
  retry: number,
  backtrack: number,
  abandon: number,
  signup: number,
  price: number,
  explore: number,
  read: number,
  recovery: number,
  noAction: number,
): BehaviorPolicyDefinition {
  const fixed = (value: number): Distribution => ({ type: "fixed", value });
  return {
    retryPropensity: fixed(retry),
    backtrackPropensity: fixed(backtrack),
    abandonmentPropensity: fixed(abandon),
    signupResistance: fixed(signup),
    priceSensitivity: fixed(price),
    explorationDepth: fixed(explore),
    readingDepth: fixed(read),
    errorRecoveryAttempts: fixed(recovery),
    noActionPropensity: fixed(noAction),
  };
}

export function deriveSessionSeed(
  studySeed: number,
  taskId: string,
  personaId: string,
  variant = "default",
  repetitionIndex = 0,
): number {
  return createHash("sha256")
    .update(`${studySeed}\0${taskId}\0${personaId}\0${variant}\0${repetitionIndex}`)
    .digest()
    .readUInt32BE(0);
}

export function createRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleDistribution(distribution: Distribution, random: () => number): number | string {
  switch (distribution.type) {
    case "fixed":
      return distribution.value;
    case "categorical": {
      if (distribution.values.length === 0) throw new Error("categorical distribution requires values");
      const total = distribution.values.reduce((sum, item) => sum + item.probability, 0);
      if (Math.abs(total - 1) > 1e-9 || distribution.values.some(item => item.probability < 0)) {
        throw new Error("categorical probabilities must be non-negative and sum to 1");
      }
      const choice = random();
      let cumulative = 0;
      for (const item of distribution.values) {
        cumulative += item.probability;
        if (choice <= cumulative) return item.value;
      }
      return distribution.values.at(-1)!.value;
    }
    case "normal": {
      if (distribution.stddev < 0) throw new Error("normal stddev must be non-negative");
      const u1 = Math.max(random(), Number.EPSILON);
      const u2 = random();
      const sampled = distribution.mean + distribution.stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.min(distribution.max ?? Infinity, Math.max(distribution.min ?? -Infinity, sampled));
    }
    case "beta": {
      if (distribution.alpha <= 0 || distribution.beta <= 0) {
        throw new Error("beta parameters must be positive");
      }
      const left = sampleGamma(distribution.alpha, random);
      return left / (left + sampleGamma(distribution.beta, random));
    }
    case "empirical":
      if (distribution.samples.length === 0) throw new Error("empirical distribution requires samples");
      return distribution.samples[Math.floor(random() * distribution.samples.length)]!;
  }
}

function sampleGamma(shape: number, random: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, random) * random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = Math.sqrt(-2 * Math.log(Math.max(random(), Number.EPSILON))) * Math.cos(2 * Math.PI * random());
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBehaviorPolicy(definition: BehaviorPolicyDefinition, seed: number): SampledBehaviorPolicy {
  const random = createRandom(seed);
  return {
    seed,
    values: Object.fromEntries(
      Object.entries(definition).map(([key, distribution]) => [key, sampleDistribution(distribution, random)]),
    ) as SampledBehaviorPolicy["values"],
  };
}

export function createPersonaState(): PersonaRuntimeState {
  return {
    perceivedProgress: 0,
    frustration: 0,
    trust: 1,
    perceivedValue: 0,
    confidence: 0.5,
    noProgressCount: 0,
    recoveryAttempts: 0,
    backtrackCount: 0,
    knownFacts: [],
    uncertainties: [],
  };
}

export function reducePersonaState(
  state: PersonaRuntimeState,
  signals: { progressChanged?: boolean; failedInteraction?: boolean; backtrack?: boolean; recovered?: boolean; runtimeFailure?: boolean },
): PersonaRuntimeState {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return {
    ...state,
    perceivedProgress: clamp(state.perceivedProgress + (signals.progressChanged ? 0.2 : 0)),
    frustration: clamp(state.frustration + (signals.failedInteraction ? 0.2 : 0) - (signals.recovered ? 0.1 : 0)),
    trust: clamp(state.trust - (signals.runtimeFailure ? 0.25 : 0) + (signals.recovered ? 0.05 : 0)),
    confidence: clamp(state.confidence + (signals.progressChanged ? 0.1 : 0) - (signals.failedInteraction ? 0.1 : 0)),
    noProgressCount: signals.progressChanged ? 0 : state.noProgressCount + 1,
    recoveryAttempts: state.recoveryAttempts + (signals.recovered ? 1 : 0),
    backtrackCount: state.backtrackCount + (signals.backtrack ? 1 : 0),
  };
}

export function filterPerceivedElements(
  elements: readonly ObservedElement[],
  attention: AttentionPolicyDefinition,
  seed: number,
): ObservedElement[] {
  const random = createRandom(seed);
  const inspectBelowFold = Number(sampleDistribution(attention.inspectBelowFoldProbability, random)) >= random();
  const inspectSecondary = Number(sampleDistribution(attention.inspectSecondaryNavigationProbability, random)) >= random();
  return elements
    .filter(element => element.visible && !(element.occluded ?? element.viewportPosition?.occluded))
    .filter(element => !attention.viewportOnly || (element.inViewport ?? element.viewportPosition?.inViewport) || inspectBelowFold)
    .filter(element => !element.secondaryNavigation || inspectSecondary)
    .map(element => ({
      element,
      score:
        Number(element.primaryCta) * attention.primaryCtaWeight +
        Number(element.heading) * attention.headingWeight +
        (element.goalMatch ?? 0) * attention.textGoalMatchWeight +
        (element.salience ?? 0) * attention.visualSaliencyWeight,
    }))
    .sort((left, right) => right.score - left.score || left.element.id.localeCompare(right.element.id))
    .slice(0, attention.maxCandidateElements)
    .map(({ element }) => ({ ...element }));
}

export function evaluateAbandonment(input: {
  state: PersonaRuntimeState;
  sampledPolicy: SampledBehaviorPolicy;
  actionCount: number;
  maxActions: number;
  elapsedMs: number;
  maxDurationMs: number;
  abandonmentAllowed: boolean;
  safetyBlocked?: boolean;
  randomValue?: number;
}): { shouldAbandon: boolean; reasonCode?: string; deterministicSignals: string[]; sampledProbability?: number } {
  if (input.actionCount >= input.maxActions) return abandon("action_budget", ["action_budget_exhausted"]);
  if (input.elapsedMs >= input.maxDurationMs) return abandon("time_budget", ["time_budget_exhausted"]);
  if (input.safetyBlocked) return abandon("trust_failure", ["safety_blocked"]);
  if (!input.abandonmentAllowed) return { shouldAbandon: false, deterministicSignals: [] };
  if (input.state.noProgressCount >= 3) return abandon("no_progress", ["consecutive_no_progress"]);
  const probability = Number(input.sampledPolicy.values.abandonmentPropensity);
  if ((input.randomValue ?? 1) < probability) {
    return { ...abandon("persona_choice", []), sampledProbability: probability };
  }
  return { shouldAbandon: false, deterministicSignals: [], sampledProbability: probability };
}

function abandon(reasonCode: string, deterministicSignals: string[]) {
  return { shouldAbandon: true, reasonCode, deterministicSignals };
}
