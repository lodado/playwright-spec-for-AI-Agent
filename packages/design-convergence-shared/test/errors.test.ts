import { describe, expect, it } from "vitest";
import {
  DesignConvergenceError,
  RUNTIME_ERROR_KINDS,
  runtimeErrorKindSchema,
} from "../src/index.js";

describe("RuntimeErrorKind taxonomy", () => {
  it("enumerates the fixed set of failure kinds", () => {
    expect(RUNTIME_ERROR_KINDS).toHaveLength(19);
    expect(RUNTIME_ERROR_KINDS).toContain("figma-auth");
    expect(RUNTIME_ERROR_KINDS).toContain("style-extraction");
    expect(RUNTIME_ERROR_KINDS).toContain("verification");
  });

  it("rejects an arbitrary string as a kind", () => {
    expect(runtimeErrorKindSchema.safeParse("not-a-real-kind").success).toBe(
      false,
    );
  });

  it("accepts a known kind", () => {
    expect(runtimeErrorKindSchema.safeParse("diff").success).toBe(true);
  });
});

describe("DesignConvergenceError", () => {
  it("carries kind and structured detail and is an Error", () => {
    const err = new DesignConvergenceError("diff", "boom", {
      case: "pricing-desktop",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("diff");
    expect(err.detail).toEqual({ case: "pricing-desktop" });
    expect(err.message).toBe("boom");
  });

  it("defaults detail to an empty object", () => {
    const err = new DesignConvergenceError("configuration", "bad config");
    expect(err.detail).toEqual({});
  });
});
