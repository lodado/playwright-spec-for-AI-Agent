import { describe, expect, it, vi } from "vitest";
import { OBSERVATION_SETTLE_POLICY, observationSettleBudget } from "../index.mjs";
import { settleDomForObservation } from "../playwright.mjs";

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

describe("settleDomForObservation", () => {
  it("waits for network idle before checking DOM quiet", async () => {
    const page = {
      waitForLoadState: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
    };

    await settleDomForObservation(page, 10_000);

    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 5_000 });
    expect(page.waitForLoadState.mock.invocationCallOrder[0]).toBeLessThan(page.evaluate.mock.invocationCallOrder[0]);
  });
});
