import { describe, expect, it } from "vitest";
import {
  analyzeReadOnlyExpectations,
  parseDashboardSpecFile,
} from "../dashboard-spec-parser.mjs";
import {
  assertParserIntegrity,
  summarizeParserCoverage,
} from "../extract-page-e2e-spec.mjs";

describe("spec parser integrity as a mixed supported and unsupported test", () => {
  it("to be accountable for every Playwright assertion without silent loss", () => {
    const body = `
      await expect(page.getByTestId("ready")).toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toHaveScreenshot();
    `;

    const analysis = analyzeReadOnlyExpectations(body, {
      fileName: "mixed.spec.ts",
      sourceOffset: 100,
      source: `${" ".repeat(100)}${body}`,
    });

    expect(analysis.coverage).toEqual({
      assertionsFound: 2,
      assertionsParsed: 1,
      unsupportedCount: 1,
    });
    expect(analysis.expectations).toHaveLength(1);
    expect(analysis.unsupportedConstructs).toEqual([
      expect.objectContaining({
        api: "toHaveScreenshot",
        category: "assertion",
        reason: "unsupported assertion or locator expression",
        severity: "error",
        location: expect.objectContaining({ file: "mixed.spec.ts" }),
      }),
    ]);
  });
});

describe("dashboard spec as a read-only test with unsupported assertions", () => {
  it("to record the gap without demoting the policy, because the agent reads the source itself", () => {
    const parsed = parseDashboardSpecFile(
      "unsupported.spec.ts",
      `// @qa-scenario: ACTIVE
// @qa-live-policy: readonly
test("uses common APIs", async ({ page }) => {
  await expect(pageObject.saveButton).toBeVisible();
  await expect(page.getByTestId("title")).toHaveScreenshot();
});`,
    );

    expect(parsed?.parserCoverage).toEqual({
      testsFound: 1,
      testsParsed: 1,
      assertionsFound: 2,
      assertionsParsed: 0,
      unsupportedCount: 2,
    });
    expect(parsed?.tests[0]).toMatchObject({
      // The gap is still stated: it is what makes the cross-check stand down.
      parserIntegrity: "incomplete",
      // ...but the check still runs. The abstraction agent is handed the
      // Playwright body, so an assertion this parser cannot name is not an
      // assertion nobody can read.
      liveRunPolicy: "executable-readonly",
      expectations: [],
    });
    expect(parsed?.tests[0].unsupportedConstructs).toHaveLength(2);
  });
});

describe("spec command as a parser integrity boundary", () => {
  it("to be explicit about aggregate coverage and strict failure", () => {
    const spec = {
      scenarios: [
        {
          parserCoverage: {
            testsFound: 1,
            testsParsed: 1,
            assertionsFound: 2,
            assertionsParsed: 1,
            unsupportedCount: 1,
          },
          tests: [],
        },
      ],
    };

    expect(summarizeParserCoverage(spec)).toEqual({
      testsFound: 1,
      testsParsed: 1,
      assertionsFound: 2,
      assertionsParsed: 1,
      unsupportedCount: 1,
    });
    expect(() => assertParserIntegrity(spec, { strict: true })).toThrow(
      /1 unsupported Playwright construct/
    );
    expect(() => assertParserIntegrity(spec, { strict: false })).not.toThrow();
  });
});

describe("analyzeReadOnlyExpectations as a test that binds its locator first", () => {
  it("to count an aliased assertion as parsed, not as an unsupported construct", () => {
    const body = [
      `const amount = page.getByTestId("scheduled-amount");`,
      `await expect(amount).toContainText("VAT 포함", { timeout: 20_000 });`,
      `await expect(amount).not.toContainText("₩251,000");`,
    ].join("\n");

    const analysis = analyzeReadOnlyExpectations(body, {
      fileName: "payg.spec.ts",
    });

    expect(analysis.coverage).toEqual({
      assertionsFound: 2,
      assertionsParsed: 2,
      unsupportedCount: 0,
    });
    expect(analysis.unsupportedConstructs).toEqual([]);
  });
});
