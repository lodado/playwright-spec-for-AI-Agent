import { describe, expect, it } from "vitest";
import {
  PLAYWRIGHT_1_60_LOCATOR_ASSERTIONS,
  SUPPORTED_ASSERTION_METHODS,
  computeApiCoverage,
  parseLocatorAssertionMethods,
} from "../playwright-api-manifest.mjs";

describe("Playwright API manifest as a version drift boundary", () => {
  it("to be exact about supported and reviewed assertion methods", () => {
    expect(SUPPORTED_ASSERTION_METHODS).toContain("toBeVisible");
    expect(SUPPORTED_ASSERTION_METHODS).toContain("toHaveText");
    expect(PLAYWRIGHT_1_60_LOCATOR_ASSERTIONS).toHaveLength(27);
    expect(computeApiCoverage(PLAYWRIGHT_1_60_LOCATOR_ASSERTIONS)).toMatchObject({
      total: 27,
      supported: SUPPORTED_ASSERTION_METHODS.length,
    });
  });

  it("to detect a newly added matcher from a type definition", () => {
    const methods = parseLocatorAssertionMethods(`
      interface LocatorAssertions {
        toBeVisible(options?: object): Promise<void>;
        toBeNewInNextVersion(): Promise<void>;
      }
    `);
    expect(methods).toEqual(["toBeNewInNextVersion", "toBeVisible"]);
  });
});
