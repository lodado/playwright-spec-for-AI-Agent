import { describe, expect, it } from "vitest";
import {
  PRESETS,
  createPersonaState,
  deriveSessionSeed,
  evaluateAbandonment,
  filterPerceivedElements,
  reducePersonaState,
  sampleBehaviorPolicy,
  sampleDistribution,
} from "../src/persona-policy.mjs";

describe("persona policy", () => {
  it("reproduces sampled policy from the derived session seed", () => {
    const seed = deriveSessionSeed(101, "task", "persona", "candidate", 1);
    expect(seed).toBe(deriveSessionSeed(101, "task", "persona", "candidate", 1));
    expect(sampleBehaviorPolicy(PRESETS.impatient_new_user, seed)).toEqual(
      sampleBehaviorPolicy(PRESETS.impatient_new_user, seed),
    );
    expect(seed).not.toBe(deriveSessionSeed(101, "task", "persona", "baseline", 1));
  });

  it("rejects invalid probability distributions", () => {
    expect(() =>
      sampleDistribution(
        { type: "categorical", values: [{ value: 1, probability: 0.4 }] },
        () => 0.2,
      ),
    ).toThrow(/sum to 1/);
    expect(sampleDistribution({ type: "beta", alpha: 2, beta: 5 }, () => 0.5)).toBeGreaterThan(0);
  });

  it("keeps hidden, occluded, and below-fold controls out of perception", () => {
    const full = [
      { id: "visible", visible: true, inViewport: true, primaryCta: true },
      { id: "hidden", visible: false, inViewport: true },
      { id: "occluded", visible: true, inViewport: true, occluded: true },
      { id: "below", visible: true, inViewport: false },
    ];
    const perceived = filterPerceivedElements(full, {
      viewportOnly: true,
      maxCandidateElements: 5,
      primaryCtaWeight: 1,
      headingWeight: 1,
      textGoalMatchWeight: 1,
      visualSaliencyWeight: 1,
      priorExpectationWeight: 1,
      inspectBelowFoldProbability: { type: "fixed", value: 0 },
      inspectSecondaryNavigationProbability: { type: "fixed", value: 0 },
    }, 1);
    expect(perceived.map(element => element.id)).toEqual(["visible"]);
    expect(full).toHaveLength(4);
  });

  it("updates state from events and treats abandonment as a normal decision", () => {
    const state = reducePersonaState(createPersonaState(), { failedInteraction: true, runtimeFailure: true });
    state.noProgressCount = 3;
    expect(state.frustration).toBeGreaterThan(0);
    expect(evaluateAbandonment({
      state,
      sampledPolicy: sampleBehaviorPolicy(PRESETS.careful_business_buyer, 2),
      actionCount: 1,
      maxActions: 20,
      elapsedMs: 10,
      maxDurationMs: 1000,
      abandonmentAllowed: true,
    })).toMatchObject({ shouldAbandon: true, reasonCode: "no_progress" });
  });
});
