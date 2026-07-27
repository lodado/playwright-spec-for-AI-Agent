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
  parseFileFixtures,
  parseFixtureFromCommentLine,
  parseFixturesBeforeIndex,
  parseLivePolicyBeforeIndex,
  parsePlaywrightSource,
  resolveTestFixtures,
  resolveTestLivePolicy,
} from "../dashboard-spec-parser.mjs";

describe("AST Playwright parsing", () => {
  it("parses callback variants and ignores braces inside strings and templates", () => {
    const source = `// @qa-scenario: AST
// @qa-live-policy: readonly
test("arrow", async ({ page }) => {
  const selector = '[data-json="{\\"open\\":true}"]';
  await expect(page.locator(selector)).toHaveCount(1);
});
// @qa-live-policy: readonly
test.only("function callback", async function ({ page }) {
  await expect(page.getByRole("heading", { name: "Pricing" })).toHaveText(\`Plans {today}\`);
});`;

    const result = parsePlaywrightSource("ast.spec.ts", source);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "FOCUSED_TEST", severity: "WARNING" }),
    ]);
    expect(result.scenario?.tests).toMatchObject([
      {
        title: "arrow",
        expectations: [{ type: "count", expected: { kind: "literal", value: 1 } }],
      },
      {
        title: "function callback",
        modifier: "only",
        expectations: [{ type: "text", expected: { kind: "literal", value: "Plans {today}" } }],
      },
    ]);
  });

  it("parses nested locators, actions, negation, regex, and arrays", () => {
    const source = `// @qa-scenario: INTERACTION
// @qa-live-policy: safe-interaction
test("edits a plan", async ({ page }) => {
  const card = page.getByRole("listitem").filter({ hasText: "Pro" }).first();
  await card.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Plan name").fill("Enterprise");
  await expect(card).not.toBeHidden();
  await expect(page.getByTestId("features")).toHaveText(["SSO", /Audit/]);
});`;

    const result = parsePlaywrightSource("interaction.spec.ts", source);
    const test = result.scenario?.tests[0];

    expect(result.diagnostics).toEqual([]);
    expect(test?.actions.map(action => action.type)).toEqual(["click", "fill"]);
    expect(test?.actions[0].target).toMatchObject({ kind: "chain" });
    expect(test?.expectations).toMatchObject([
      { type: "visible", negated: true },
      {
        type: "text",
        expected: {
          kind: "array",
          value: [
            { kind: "literal", value: "SSO" },
            { kind: "regex", pattern: "Audit", flags: "" },
          ],
        },
      },
    ]);
  });

  it("extracts skipped tests and reports unsupported matchers instead of dropping them", () => {
    const source = `// @qa-scenario: DIAGNOSTICS
// @qa-live-policy: readonly
test.skip("temporarily skipped", async ({ page }) => {
  await expect(page.getByText("Soon")).toBeVisible();
});
// @qa-live-policy: readonly
test("custom assertion", async ({ page }) => {
  await expect(page.getByText("A")).toBeVisible();
  await expect(page.getByText("B")).toUseCustomMatcher();
});`;

    const result = parsePlaywrightSource("diagnostics.spec.ts", source);

    expect(result.scenario?.tests[0]).toMatchObject({
      title: "temporarily skipped",
      modifier: "skip",
      liveRunPolicy: "blocked-live-skip",
    });
    expect(result.scenario?.tests[1].expectations).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_MATCHER", severity: "ERROR" }),
    ]);
  });

  it("resolves aliased imports, describe modifiers, scenario labels, and dynamic-value diagnostics", () => {
    const source = `// @qa-scenario: ACCOUNT
// @qa-scenario-label: "Account settings"
import { test as pwTest, expect as assert } from "@playwright/test";
// @qa-live-policy: readonly
pwTest.describe.skip("disabled suite", () => {
  pwTest("uses an alias", async ({ page }) => {
    const expected = loadExpectedName();
    await assert(page.getByLabel("Name")).toHaveValue(expected);
  });
});`;

    const result = parsePlaywrightSource("alias.spec.ts", source);

    expect(result.scenario).toMatchObject({
      label: "Account settings",
      tests: [{
        title: "uses an alias",
        modifier: "skip",
        liveRunPolicy: "blocked-live-skip",
      }],
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "DYNAMIC_EXPECTED_VALUE", severity: "ERROR" }),
    ]);
  });
});

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

  it("preserves multi-word scenario intent", () => {
    expect(parseAnnotations("// @qa-scenario: A visitor understands pricing\n")).toMatchObject({
      scenario: "A visitor understands pricing",
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

  it("maps safe-interaction-no-confirm when verification would be dangerous on live", () => {
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

describe("@qa-fixture", () => {
  it("parses name=path from comment lines", () => {
    expect(
      parseFixtureFromCommentLine(
        "// @qa-fixture: avatar=tests/fixtures/qa-avatar.png",
      ),
    ).toEqual({
      name: "avatar",
      path: "tests/fixtures/qa-avatar.png",
    });
    expect(
      parseFixtureFromCommentLine(
        '// @qa-fixture: doc="tests/fixtures/a b.pdf"',
      ),
    ).toEqual({
      name: "doc",
      path: "tests/fixtures/a b.pdf",
    });
  });

  it("merges file, describe, and test fixtures with inner overrides", () => {
    const source = `
// @qa-fixture: avatar=tests/fixtures/file.png
// @qa-scenario: ACTIVE
test.describe("uploads", () => {
  // @qa-fixture: avatar=tests/fixtures/describe.png
  // @qa-live-policy: safe-interaction
  test("uploads avatar", async ({ page }) => {
    await page.setInputFiles("x");
  });
});
`;
    const testIndex = source.indexOf('test("uploads avatar"');
    expect(parseFileFixtures(source)).toEqual({
      avatar: "tests/fixtures/file.png",
    });
    expect(parseFixturesBeforeIndex(source, testIndex)).toEqual({
      avatar: "tests/fixtures/describe.png",
    });
    expect(
      resolveTestFixtures(source, testIndex, parseFileFixtures(source)),
    ).toEqual({
      avatar: "tests/fixtures/describe.png",
    });
  });

  it("includes fixtures on parsed tests", () => {
    const parsed = parseDashboardSpecFile(
      "upload.spec.ts",
      `// @qa-scenario: ACTIVE
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png
// @qa-live-policy: safe-interaction
test("uploads avatar", async ({ page }) => {
  await page.getByTestId("avatar-input").setInputFiles("tests/fixtures/qa-avatar.png");
});`,
    );

    expect(parsed?.fixtures).toEqual({
      avatar: "tests/fixtures/qa-avatar.png",
    });
    expect(parsed?.tests[0].fixtures).toEqual({
      avatar: "tests/fixtures/qa-avatar.png",
    });
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
    expect(describeLiveRunPolicy("judgment-mock-api")).toMatch(
      /reasonably matches intent/i,
    );
  });
});
