import { describe, expect, it } from "vitest";
import {
  adaptExpectationForLive,
  classifyLiveRunPolicy,
  describeLiveRunPolicy,
  detectApiMock,
  detectSubscriptionMutation,
  liveRegexFromLiteral,
  literalExpectedForLive,
  mapLivePolicyAnnotation,
  parseAnnotations,
  parseDashboardSpecFile,
  parseLivePolicyBeforeIndex,
  resolveTestLivePolicy,
} from "../dashboard-spec-parser.mjs";

describe("parseAnnotations", () => {
  it("extracts all three annotations", () => {
    const source = `// @qa-page: pricing\n// @qa-scenario: ACTIVE\nimport { test } from '@playwright/test';`;
    expect(parseAnnotations(source)).toEqual({
      page: "pricing",
      scenario: "ACTIVE",
      liveSkip: false,
      alwaysRun: false,
    });
  });

  it("detects @qa-live-skip: true", () => {
    const source = `// @qa-page: pricing\n// @qa-scenario: ERROR\n// @qa-live-skip: true\n`;
    expect(parseAnnotations(source)).toMatchObject({ liveSkip: true });
  });

  it("detects @qa-always-run: true", () => {
    const source = `// @qa-scenario: CREDIT_BVA\n// @qa-always-run: true\n`;
    expect(parseAnnotations(source)).toMatchObject({ alwaysRun: true });
  });

  it("returns nulls when annotations absent", () => {
    expect(
      parseAnnotations("import { test } from '@playwright/test';"),
    ).toEqual({
      page: null,
      scenario: null,
      liveSkip: false,
      alwaysRun: false,
    });
  });
});

describe("dashboard-spec-parser live numeric adaptation", () => {
  it("converts comma-formatted mock numbers to digit wildcards", () => {
    expect(liveRegexFromLiteral("42,835")).toBe("[\\d,]+");
    expect(literalExpectedForLive("42,835")).toMatchObject({
      kind: "regex",
      pattern: "[\\d,]+",
    });
  });

  it("preserves static prefix while wildcarding numeric suffix", () => {
    expect(liveRegexFromLiteral("Credit 0")).toBe("Credit [\\d,]+");
    expect(literalExpectedForLive("Credit 0")).toMatchObject({
      kind: "regex",
      pattern: "Credit [\\d,]+",
    });
  });

  it("keeps non-numeric copy literals unchanged", () => {
    expect(literalExpectedForLive("Subscription Info")).toEqual({
      kind: "literal",
      value: "Subscription Info",
    });
  });

  it("adapts CREDIT_BVA credit literals for live wildcard matching", () => {
    const adapted = adaptExpectationForLive(
      {
        type: "containText",
        locator: { kind: "testId", value: "credit-remaining" },
        expected: { kind: "literal", value: "Credit 0" },
      },
      "shows Credit 0 when remaining_credits is 0",
      "CREDIT_BVA",
    );

    expect(adapted.liveSkip).toBeUndefined();
    expect(adapted.expected).toMatchObject({
      kind: "regex",
      pattern: "Credit [\\d,]+",
    });
  });
});

describe("@qa-live-policy", () => {
  it("reads policy from line directly above test", () => {
    const source = `
// @qa-live-policy: safe-interaction
test("opens dialog", async ({ page }) => {
  await page.getByRole("button").click();
});
`;
    const testIndex = source.indexOf('test("opens dialog"');
    expect(parseLivePolicyBeforeIndex(source, testIndex)).toBe(
      "safe-interaction",
    );
    expect(resolveTestLivePolicy(source, testIndex)).toMatchObject({
      liveRunPolicy: "executable-interaction",
    });
  });

  it("inherits policy from enclosing test.describe", () => {
    const source = `
// @qa-live-policy: mock-judgment
test.describe("group", () => {
  test("child", async ({ page }) => {
    await setup(page);
  });
});
`;
    const testIndex = source.indexOf('test("child"');
    expect(resolveTestLivePolicy(source, testIndex)).toMatchObject({
      annotation: "mock-judgment",
      liveRunPolicy: "judgment-mock-api",
    });
  });

  it("maps safe-interaction-no-confirm for live destructive confirm ban", () => {
    expect(
      mapLivePolicyAnnotation("safe-interaction-no-confirm"),
    ).toMatchObject({
      liveRunPolicy: "judgment-interaction-no-confirm",
      stagingMode: "interaction",
    });
  });

  it("prefers test-level policy over describe inheritance", () => {
    const source = `
// @qa-live-policy: mock-judgment
test.describe("group", () => {
  // @qa-live-policy: subscription-mutation
  test("child", async ({ page }) => {});
});
`;
    expect(
      resolveTestLivePolicy(source, source.indexOf('test("child",')).annotation,
    ).toBe("subscription-mutation");
  });

  it("throws on unknown policy keyword", () => {
    expect(() => mapLivePolicyAnnotation("unknown")).toThrow(
      /Unknown @qa-live-policy/,
    );
  });

  it("requires @qa-live-policy on every test in @qa-scenario files", () => {
    expect(() =>
      parseDashboardSpecFile(
        "bad.spec.ts",
        `// @qa-scenario: ACTIVE
test.describe("x", () => {
  test("no policy", async ({ page }) => {});
});`,
      ),
    ).toThrow(/Missing \/\/ @qa-live-policy/);
  });
});

describe("classifyLiveRunPolicy", () => {
  it("allows dialog-open interactions without mutation", () => {
    const body = `
      await page.getByTestId("subscription-history-button").click();
      await expect(page.getByText("Subscription History")).toBeVisible();
    `;
    expect(classifyLiveRunPolicy(body, "interaction")).toBe(
      "executable-interaction",
    );
    expect(detectSubscriptionMutation(body)).toBe(false);
  });

  it("blocks resume confirm + mocked POST", () => {
    const body = `
      await page.route("**/api/v1/plans/subscription/resume", route => {
        route.fulfill({ status: 204 });
      });
      await resumeLink.click();
      await page.getByRole("button", { name: "confirm" }).click();
    `;
    expect(detectSubscriptionMutation(body)).toBe(true);
    expect(classifyLiveRunPolicy(body, "interaction")).toBe(
      "blocked-subscription-mutation",
    );
  });

  it("blocks auth mock tests", () => {
    const body = `
      await page.route("**/api/v1/auth/me", route =>
        route.fulfill({ status: 401 })
      );
      await expect(page).toHaveURL(/\\/login/);
    `;
    expect(classifyLiveRunPolicy(body, "auth")).toBe("blocked-auth-mock");
  });

  it("blocks tests that depend on page.route mock setup", () => {
    const body = `
      await setupDashboardWithCredit(page, 0);
      await expect(page.getByTestId("credit-remaining")).toContainText("Credit 0");
    `;
    expect(detectApiMock(body)).toBe(true);
    expect(classifyLiveRunPolicy(body, "read-only")).toBe("judgment-mock-api");
  });

  it("describes judgment-mock-api for Hermes discretion", () => {
    expect(describeLiveRunPolicy("judgment-mock-api")).toMatch(/Hermes judges/);
  });
});
