import { describe, expect, it } from "vitest";
import { OBSERVATION_SETTLE_POLICY, observationSettleBudget } from "../index.mjs";

describe("observationSettleBudget", () => {
  it("caps at the policy maximum when the remaining budget is ample", () => {
    expect(observationSettleBudget(10_000)).toEqual({ capMs: 5_000, quietMs: 300 });
  });

  it("clamps below the remaining budget, keeping the reserve", () => {
    expect(observationSettleBudget(3_000)).toEqual({ capMs: 2_000, quietMs: 300 });
  });

  it("is a no-op under budget pressure, never negative", () => {
    expect(observationSettleBudget(1_000)).toBeUndefined();
    expect(observationSettleBudget(0)).toBeUndefined();
    expect(observationSettleBudget(-5)).toBeUndefined();
  });

  it("is a no-op for non-finite input", () => {
    expect(observationSettleBudget(Number.NaN)).toBeUndefined();
    expect(observationSettleBudget(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("freezes the policy constant", () => {
    expect(Object.isFrozen(OBSERVATION_SETTLE_POLICY)).toBe(true);
  });
});
