import { describe, expect, it, vi } from "vitest";
import { canonicalHash, validateContract } from "../../contracts/index.mjs";
import { compilePlaywrightSpec, extractPlaywrightStaticManifest, recoverPlaywrightSpecWithAi } from "../index.mjs";

const source = `// @qa-scenario: DASHBOARD_READONLY
// @qa-page: /dashboard
// @qa-live-policy: readonly
test("loads dashboard", async ({ page }) => {
  await expect(page.getByTestId("heading")).toContainText("Dashboard");
});
`;

describe("Playwright static manifest", () => {
  it("extracts immutable identity and inherited policy despite unsupported matcher semantics", () => {
    const input = `// @qa-scenario: MANIFEST\n// @qa-page: /dashboard\ntest.describe("suite", () => {\n  // @qa-live-policy: safe-interaction-no-confirm\n  test.describe("nested", () => {\n    test("dynamic matcher", async ({ page }) => { await expect(page).toUnknownMatcher(helper()); });\n  });\n});\n`;
    const manifest = extractPlaywrightStaticManifest({ source: input, sourcePath: "manifest.spec.ts" });
    expect(manifest.scenario).toMatchObject({ id: "MANIFEST", page: "/dashboard" });
    expect(manifest.tests).toHaveLength(1);
    expect(manifest.tests[0]).toMatchObject({
      testId: expect.stringMatching(/^static-test-/),
      title: "dynamic matcher",
      livePolicyAnnotation: "safe-interaction-no-confirm",
      liveRunPolicy: "judgment-interaction-no-confirm",
      policy: { navigation: "ALLOWED", readDom: true, click: "SAFE_ONLY" },
    });
    expect(input.slice(manifest.tests[0].range.start, manifest.tests[0].range.end)).toContain('test("dynamic matcher"');
  });

  it("preserves only fully static safe click flows", () => {
    const input = `// @qa-scenario: MENU\n// @qa-live-policy: safe-interaction\ntest("opens menu", async ({ page }) => {\n  await page.getByRole("button", { name: "Menu" }).click();\n  await page.getByText("Settings").click();\n});\n`;
    const result = extractPlaywrightStaticManifest({ source: input, sourcePath: "menu.spec.ts" });

    expect(result.tests[0].actions).toMatchObject([
      { action: "CLICK", target: { role: "button", accessibleName: { kind: "literal", value: "Menu" } } },
      { action: "CLICK", target: { text: { kind: "literal", value: "Settings" } } },
    ]);
  });

  it.each([
    ["mixed action", 'await page.getByTestId("menu").click(); await page.getByTestId("name").fill("value");'],
    ["raw selector", 'await page.locator(".menu").click();'],
    ["opaque step", 'await openMenu(page); await page.getByTestId("menu").click();'],
    ["click options", 'await page.getByTestId("menu").click({ trial: true });'],
    ["locator narrowing", 'await page.getByTestId("menu").nth(2).click();'],
    ["locator options", 'await page.getByText("Delete", { exact: true }).click();'],
  ])("omits the entire authored flow for %s", (_label, body) => {
    const input = `// @qa-scenario: UNSAFE\n// @qa-live-policy: safe-interaction\ntest("unsafe", async ({ page }) => { ${body} });\n`;
    expect(extractPlaywrightStaticManifest({ source: input, sourcePath: "unsafe.spec.ts" }).tests[0].actions).toBeUndefined();
  });

  it("does not execute judgment-only clicks", () => {
    const input = `// @qa-scenario: MOCK\n// @qa-live-policy: mock-judgment\ntest("mock", async ({ page }) => { await page.getByTestId("menu").click(); });\n`;
    expect(extractPlaywrightStaticManifest({ source: input, sourcePath: "mock.spec.ts" }).tests[0].actions).toBeUndefined();
  });
});

describe("compilePlaywrightSpec @qa-fixture uploads", () => {
  it("carries the fixture map and an UPLOAD step naming its fixture", () => {
    const spec = `// @qa-scenario: UPLOAD\n// @qa-live-policy: safe-interaction\n// @qa-fixture: doc=fixtures/sample.pdf\ntest("uploads a document", async ({ page }) => {\n  await page.getByTestId("file-input").setInputFiles("doc");\n  await expect(page.getByText("Uploaded")).toBeVisible();\n});\n`;
    const result = compilePlaywrightSpec({ source: spec, sourcePath: "upload.spec.ts" });
    validateContract("CompileResult", result);
    const scenario = result.qaIr.suites[0].scenarios[0];
    expect(scenario.fixtures).toEqual({ doc: "fixtures/sample.pdf" });
    const upload = scenario.steps.find((step) => step.kind === "INTERACT");
    expect(upload).toMatchObject({ action: "UPLOAD", value: "doc" });
    expect(result.qaIr.extensions.blockedScenarioIds ?? []).not.toContain(scenario.id);
  });

  it("blocks an upload whose fixture name is not declared with @qa-fixture", () => {
    const spec = `// @qa-scenario: UPLOAD_MISS\n// @qa-live-policy: safe-interaction\ntest("uploads without fixture", async ({ page }) => {\n  await page.getByTestId("file-input").setInputFiles("nope");\n});\n`;
    const result = compilePlaywrightSpec({ source: spec, sourcePath: "miss.spec.ts" });
    const scenario = result.qaIr.suites[0].scenarios[0];
    expect(result.qaIr.extensions.blockedScenarioIds).toContain(scenario.id);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("UPLOAD_FIXTURE_UNRESOLVED");
  });
});

describe("compilePlaywrightSpec", () => {
  it("emits valid deterministic QA IR without timestamps", () => {
    const first = compilePlaywrightSpec({ source, sourcePath: "dashboard.spec.ts", revision: "abc123" });
    const second = compilePlaywrightSpec({ source, sourcePath: "dashboard.spec.ts", revision: "abc123" });

    expect(validateContract("CompileResult", first)).toEqual(first);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain("generatedAt");
    expect(first.qaIr.source).toEqual({
      adapter: "adapter-playwright",
      adapterVersion: "0.3.0",
      uri: "dashboard.spec.ts",
      revision: "abc123",
    });
    expect(first.qaIr.suites).toHaveLength(1);
    expect(first.qaIr.suites[0].scenarios).toHaveLength(1);
    expect([first.qaIr.id, first.qaIr.suites[0].id, first.qaIr.suites[0].scenarios[0].id, ...first.qaIr.suites[0].scenarios[0].steps.map((step) => step.id), ...first.qaIr.suites[0].scenarios[0].expectations.map((expectation) => expectation.id)].every((id) => id.length <= 33)).toBe(true);
  });

  it("records per-test source provenance with exact line and column", () => {
    const result = compilePlaywrightSpec({ source, sourcePath: "dashboard.spec.ts", revision: "abc123" });
    const provenance = result.qaIr.suites[0].scenarios[0].provenance[0];

    expect(provenance).toEqual({
      path: "dashboard.spec.ts",
      range: {
        start: { line: 4, column: 1, offset: source.indexOf("test(") },
        end: { line: 6, column: 3, offset: source.indexOf("});") + 2 },
      },
      adapter: { name: "adapter-playwright", version: "0.3.0" },
      contentHash: canonicalHash(source.slice(source.indexOf("test("), source.indexOf("});") + 2)),
      revision: "abc123",
    });
    expect(result.qaIr.suites[0].scenarios[0].expectations[0].provenance).toEqual([provenance]);
  });

  it("keeps Playwright selector details in adapter hint data and preserves match semantics", () => {
    const scenario = compilePlaywrightSpec({ source, sourcePath: "dashboard.spec.ts" }).qaIr.suites[0].scenarios[0];
    const expectation = scenario.expectations[0];

    expect(expectation.kind).toBe("CONTAINS_TEXT");
    expect(expectation.target).toMatchObject({ testId: "heading" });
    expect(expectation.target.text).toBeUndefined();
    expect(expectation.expected).toEqual({ kind: "literal", value: "Dashboard" });
    expect(expectation.target.selector).toBeUndefined();
    expect(expectation.target.hints).toEqual([{ adapter: "playwright", data: { kind: "testId", value: "heading" } }]);
    expect(scenario.steps.map(step => step.kind)).toEqual(["NAVIGATE", "OBSERVE", "CHECKPOINT"]);
    expect(scenario.steps[1].requests).toEqual([{ type: "ELEMENT_OBSERVATION" }, { type: "VISIBLE_TEXT" }]);

    const regexSource = source.replace("toContainText(\"Dashboard\")", "toContainText(/Dash.+/) ");
    const regexExpectation = compilePlaywrightSpec({ source: regexSource, sourcePath: "dashboard.spec.ts" }).qaIr.suites[0].scenarios[0].expectations[0];
    expect(regexExpectation.expected).toEqual({ kind: "regex", value: "Dash.+" });
    expect(regexExpectation.target).toMatchObject({ testId: "heading" });
    expect(regexExpectation.target.text).toBeUndefined();
  });


  it("maps text locator identity separately from assertion value", () => {
    const textSource = `// @qa-scenario: TEXT\n// @qa-live-policy: readonly\ntest("text locator", async ({ page }) => {\n  await expect(page.getByText("Status")).toContainText("Ready");\n});\n`;
    const expectation = compilePlaywrightSpec({ source: textSource, sourcePath: "text.spec.ts" }).qaIr.suites[0].scenarios[0].expectations[0];
    expect(expectation.target.text).toEqual({ kind: "literal", value: "Status" });
    expect(expectation.expected).toEqual({ kind: "literal", value: "Ready" });
  });

  it("preserves disabled assertions for adaptive execution", () => {
    const disabledSource = `// @qa-scenario: DISABLED\n// @qa-live-policy: readonly\ntest("disabled", async ({ page }) => {\n  await expect(page.getByTestId("payment")).toBeDisabled();\n});\n`;
    const expectation = compilePlaywrightSpec({ source: disabledSource, sourcePath: "disabled.spec.ts" }).qaIr.suites[0].scenarios[0].expectations[0];
    expect(expectation).toMatchObject({ kind: "DISABLED", target: { testId: "payment" } });
  });

  it("omits navigate steps when no qa page is present", () => {
    const noPage = source.replace("// @qa-page: /dashboard\n", "");
    const scenario = compilePlaywrightSpec({ source: noPage, sourcePath: "dashboard.spec.ts" }).qaIr.suites[0].scenarios[0];
    expect(scenario.steps.map(step => step.kind)).toEqual(["OBSERVE", "CHECKPOINT"]);
  });

  it("uses deterministic discriminators for duplicate titles", () => {
    const duplicateSource = `// @qa-scenario: DUPES\n// @qa-live-policy: readonly\ntest("same", async ({ page }) => {\n  await expect(page.getByText("A")).toContainText("A");\n});\n// @qa-live-policy: readonly\ntest("same", async ({ page }) => {\n  await expect(page.getByText("B")).toContainText("B");\n});\n`;
    const scenarios = compilePlaywrightSpec({ source: duplicateSource, sourcePath: "dupes.spec.ts" }).qaIr.suites[0].scenarios;
    expect(new Set(scenarios.map(item => item.id)).size).toBe(2);
    expect(new Set(scenarios.flatMap(item => item.expectations.map(expectation => expectation.id))).size).toBe(2);
  });

  it("clones policies and provenance between compiles", () => {
    const first = compilePlaywrightSpec({ source, sourcePath: "dashboard.spec.ts" });
    first.qaIr.suites[0].scenarios[0].policy.navigation = "BLOCKED";
    first.qaIr.suites[0].scenarios[0].provenance[0].path = "mutated";

    const second = compilePlaywrightSpec({ source, sourcePath: "dashboard.spec.ts" });
    expect(second.qaIr.suites[0].scenarios[0].policy.navigation).toBe("ALLOWED");
    expect(second.qaIr.suites[0].scenarios[0].provenance[0].path).toBe("dashboard.spec.ts");
  });

  it("maps provider-neutral allowed and blocked policies", () => {
    const policies = Object.fromEntries(
      ["readonly", "safe-interaction", "mock-judgment", "subscription-mutation", "auth-mock", "skip"].map(policy => {
        const policySource = `// @qa-scenario: POLICY\n// @qa-live-policy: ${policy}\ntest("${policy}", async ({ page }) => {\n  await expect(page.getByText("A")).toContainText("A");\n});\n`;
        return [policy, compilePlaywrightSpec({ source: policySource, sourcePath: `${policy}.spec.ts` }).qaIr.suites[0].scenarios[0].policy];
      }),
    );

    expect(policies.readonly).toMatchObject({ navigation: "ALLOWED", readDom: true, click: "NONE", destructiveMutation: false });
    expect(policies["safe-interaction"]).toMatchObject({ navigation: "ALLOWED", click: "SAFE_ONLY", type: "NON_SECRET" });
    expect(policies["mock-judgment"]).toMatchObject({ navigation: "ALLOWED", readNetwork: false, click: "NONE" });
    expect(policies["subscription-mutation"]).toMatchObject({ navigation: "BLOCKED", readDom: false, click: "NONE" });
    expect(policies["auth-mock"]).toMatchObject({ navigation: "BLOCKED", readDom: false, click: "NONE" });
    expect(policies.skip).toMatchObject({ navigation: "BLOCKED", readDom: false, click: "NONE" });
  });

  it("imports modifiers and callback variants without dropping tests", () => {
    const unsupported = `// @qa-scenario: SKIPPED\n// @qa-live-policy: readonly\ntest.skip("skipped", async ({ page }) => {\n  await expect(page.getByText("A")).toContainText("A");\n});\n// @qa-live-policy: readonly\ntest("plain callback", ({ page }) => {\n  expect(page.getByText("B")).toBeVisible();\n});\n`;
    const result = compilePlaywrightSpec({ source: unsupported, sourcePath: "unsupported.spec.ts" });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.qaIr.suites[0].scenarios).toHaveLength(2);
    expect(result.qaIr.suites[0].scenarios[0].policy.navigation).toBe("BLOCKED");
    expect(result.qaIr.suites[0].scenarios[1].expectations).toHaveLength(1);
  });

  it("fails missing scenario and supports locator count assertions", () => {
    const missingScenario = `// @qa-live-policy: readonly\ntest("missing", async ({ page }) => {\n  await expect(page.getByText("A")).toContainText("A");\n});\n`;
    expect(compilePlaywrightSpec({ source: missingScenario, sourcePath: "missing.spec.ts" })).toMatchObject({ ok: false });

    const unsupportedAssertion = `// @qa-scenario: BAD\n// @qa-live-policy: readonly\ntest("bad", async ({ page }) => {\n  await expect(page.getByText("A")).toBeVisible();\n  await expect(page.locator("h1")).toHaveCount(1);\n});\n`;
    const result = compilePlaywrightSpec({ source: unsupportedAssertion, sourcePath: "bad.spec.ts" });
    expect(result.qaIr.suites[0].scenarios[0].expectations).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("compiles static semantic clicks without using Playwright selectors as runtime authority", () => {
    const interaction = `// @qa-scenario: CLICK\n// @qa-page: /dashboard\n// @qa-live-policy: safe-interaction\ntest("clicks", async ({ page }) => {\n  await page.getByTestId("menu").click();\n  await page.getByText("Settings").click();\n  await page.getByRole("button", { name: "Open" }).click();\n  await expect(page.getByText("Opened")).toBeVisible();\n});\n`;
    const result = compilePlaywrightSpec({ source: interaction, sourcePath: "interaction.spec.ts" });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.qaIr.suites[0].scenarios[0].steps.map(step => step.kind)).toEqual(["NAVIGATE", "INTERACT", "INTERACT", "INTERACT", "OBSERVE", "CHECKPOINT"]);
    expect(result.qaIr.suites[0].scenarios[0].steps[0].milestoneClass).toBe("REQUIRED_SEMANTIC_MILESTONE");
    expect(result.qaIr.suites[0].scenarios[0].steps.filter(step => step.kind === "INTERACT")).toMatchObject([
      { milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { testId: "menu" } },
      { milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { text: { kind: "literal", value: "Settings" } } },
      { milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { role: "button", accessibleName: { kind: "literal", value: "Open" } } },
    ]);
  });

  it("preserves literal role and accessible-name dialog expectations for adaptive milestones", () => {
    const source = `// @qa-scenario: DIALOG\n// @qa-page: /settings\n// @qa-live-policy: safe-interaction\ntest("dialog", async ({ page }) => {\n  await page.getByTestId("settings").click();\n  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();\n});\n`;

    const result = compilePlaywrightSpec({ source, sourcePath: "dialog.spec.ts" });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.qaIr.suites[0].scenarios[0].expectations).toMatchObject([{
      kind: "VISIBLE",
      target: { role: "dialog", accessibleName: { kind: "literal", value: "Settings" } },
    }]);
  });

  it("omits accessibleName for role-only locators so role alone identifies the target", () => {
    const source = `// @qa-scenario: DIALOG\n// @qa-page: /settings\n// @qa-live-policy: safe-interaction\ntest("dialog", async ({ page }) => {\n  await page.getByTestId("settings").click();\n  await expect(page.getByRole("dialog")).toBeVisible();\n});\n`;

    const result = compilePlaywrightSpec({ source, sourcePath: "dialog.spec.ts" });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    const [expectation] = result.qaIr.suites[0].scenarios[0].expectations;
    expect(expectation).toMatchObject({ kind: "VISIBLE", target: { role: "dialog" } });
    expect(expectation.target.accessibleName).toBeUndefined();
  });

  it("blocks only the scenario that owns an opaque step and compiles its clean siblings", () => {
    const source = [
      "// @qa-scenario: PARTIAL",
      "// @qa-page: /dashboard",
      "// @qa-live-policy: safe-interaction",
      'test("clean", async ({ page }) => {',
      '  await page.getByTestId("menu").click();',
      '  await expect(page.getByText("Opened")).toBeVisible();',
      "});",
      "// @qa-live-policy: safe-interaction",
      'test("opaque", async ({ page }) => {',
      "  await openDialog(page);",
      '  await expect(page.getByText("Dialog")).toBeVisible();',
      "});",
      "",
    ].join("\n");

    const result = compilePlaywrightSpec({ source, sourcePath: "partial.spec.ts" });

    expect(result.ok).toBe(false);
    const scenarios = result.qaIr.suites[0].scenarios;
    expect(scenarios).toHaveLength(2);
    // The clean scenario keeps its interaction step instead of being wiped by its sibling's error.
    expect(scenarios[0].steps.some(step => step.kind === "INTERACT")).toBe(true);
    expect(result.qaIr.extensions.blockedScenarioIds).toContain(scenarios[1].id);
    expect(result.qaIr.extensions.blockedScenarioIds).not.toContain(scenarios[0].id);
  });

  it("compiles locator, fill, and count patterns while preserving only statically known helper-adjacent actions", () => {
    const interaction = `// @qa-scenario: MIXED\n// @qa-live-policy: safe-interaction\ntest("mixed", async ({ page }) => {\n  // await page.getByTestId("comment-only").click();\n  await page.getByTestId("menu").click();\n  await page.locator(".unsafe").click();\n  await page.getByTestId("name").fill("value");\n  await expect(page.locator(".result")).toHaveCount(1);\n});\n`;
    const result = compilePlaywrightSpec({ source: interaction, sourcePath: "mixed.spec.ts" });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.qaIr.suites[0].scenarios[0].steps.filter(step => step.kind === "INTERACT")).toHaveLength(3);
    expect(result.qaIr.suites[0].scenarios[0].expectations).toHaveLength(1);

    for (const hidden of [
      `if (false) {\n    await page.getByTestId("conditional").click();\n  }`,
      `await replayHelper(page);\n  await page.getByTestId("after-helper").click();`,
      `await page.getByTestId("before-helper").click();\n  await expect(page.getByText("Ready")).toBeVisible(); await replayHelper(page);`,
    ]) {
      const candidate = `// @qa-scenario: HIDDEN\n// @qa-live-policy: safe-interaction\ntest("hidden", async ({ page }) => {\n  ${hidden}\n});\n`;
      const compiled = compilePlaywrightSpec({ source: candidate, sourcePath: "hidden.spec.ts" });
      expect(compiled.ok).toBe(false);
      expect(compiled.qaIr.suites[0].scenarios[0].steps.filter(step => step.kind === "INTERACT")).toHaveLength(1);
      expect(compiled.qaIr.extensions.blockedScenarioIds).toContain(compiled.qaIr.suites[0].scenarios[0].id);
    }

    const commentedAssertion = `// @qa-scenario: COMMENT\n// @qa-live-policy: safe-interaction\ntest("comment", async ({ page }) => {\n  await page.getByTestId("run").click();\n  // await expect(page.getByText("Never")).toBeVisible();\n});\n`;
    const compiled = compilePlaywrightSpec({ source: commentedAssertion, sourcePath: "comment.spec.ts" });
    expect(compiled.ok).toBe(true);
    expect(compiled.qaIr.suites[0].scenarios[0].expectations).toEqual([]);
    expect(compiled.qaIr.suites[0].scenarios[0].steps.map(step => step.kind)).toEqual(["INTERACT", "CHECKPOINT"]);
  });

  it("attributes an AST-level opaque assertion to its own scenario for --allow-partial", () => {
    // OPAQUE_ASSERTION_TARGET originates in the AST layer, which carried no testIndex — so it used
    // to be treated as a file-level error and block every scenario. It must block only its owner.
    const source = [
      "// @qa-scenario: PARTIAL",
      "// @qa-page: /dashboard",
      "// @qa-live-policy: readonly",
      'test("clean", async ({ page }) => {',
      '  await expect(page.getByText("Opened")).toBeVisible();',
      "});",
      "// @qa-live-policy: readonly",
      'test("opaque", async ({ page }) => {',
      "  await expect(mystery).toBeVisible();",
      "});",
      "",
    ].join("\n");

    const result = compilePlaywrightSpec({ source, sourcePath: "partial.spec.ts" });

    expect(result.ok).toBe(false);
    const scenarios = result.qaIr.suites[0].scenarios;
    expect(scenarios).toHaveLength(2);
    expect(result.qaIr.extensions.blockedScenarioIds).toEqual([scenarios[1].id]);
    expect(result.diagnostics.some(item => item.code === "OPAQUE_ASSERTION_TARGET")).toBe(true);
  });

  it("marks live-policy blocked scenarios as blocked so --allow-partial can skip them", () => {
    const source = [
      "// @qa-scenario: MIXED",
      "// @qa-page: /dashboard",
      "// @qa-live-policy: readonly",
      'test("runnable", async ({ page }) => {',
      '  await expect(page.getByText("Ready")).toBeVisible();',
      "});",
      "// @qa-live-policy: skip",
      'test("skipped", async ({ page }) => {',
      '  await expect(page.getByText("Nope")).toBeVisible();',
      "});",
      "",
    ].join("\n");

    const result = compilePlaywrightSpec({ source, sourcePath: "mixed.spec.ts" });

    // A skip policy is not a compile error, so the file still compiles ok...
    expect(result.ok).toBe(true);
    const scenarios = result.qaIr.suites[0].scenarios;
    // ...but the blocked scenario is recorded so partial execution can prune it.
    expect(result.qaIr.extensions.blockedScenarioIds).toEqual([scenarios[1].id]);
  });

  it("records judgment-policy scenario ids in semanticJudgmentScenarioIds", () => {
    const source = [
      "// @qa-scenario: JUDGMENT",
      "// @qa-page: /dashboard",
      "// @qa-live-policy: mock-judgment",
      'test("mock judgment", async ({ page }) => {',
      '  await expect(page.getByTestId("greeting")).toContainText("dev-user");',
      "});",
      "// @qa-live-policy: readonly",
      'test("readonly", async ({ page }) => {',
      '  await expect(page.getByTestId("heading")).toContainText("Dashboard");',
      "});",
      "",
    ].join("\n");

    const result = compilePlaywrightSpec({ source, sourcePath: "judgment.spec.ts" });
    const scenarios = result.qaIr.suites[0].scenarios;

    expect(result.qaIr.extensions.semanticJudgmentScenarioIds).toEqual([scenarios[0].id]);
    expect(result.qaIr.extensions.semanticJudgmentScenarioIds).not.toContain(scenarios[1].id);
  });

  it("keeps no-confirm interactions deferred instead of guessing a safe stopping point", () => {
    const interaction = `// @qa-scenario: CONFIRM\n// @qa-live-policy: safe-interaction-no-confirm\ntest("confirm", async ({ page }) => {\n  await page.getByTestId("cancel").click();\n});\n`;
    const result = compilePlaywrightSpec({ source: interaction, sourcePath: "confirm.spec.ts" });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toMatchObject([{ code: "DEFERRED_INTERACTION_STEPS", severity: "WARNING" }]);
    expect(result.qaIr.suites[0].scenarios[0].steps.some(step => step.kind === "INTERACT")).toBe(false);
  });
});

describe("recoverPlaywrightSpecWithAi", () => {
  const unsupportedSource = `// @qa-scenario: FALLBACK\n// @qa-page: /dashboard\n// @qa-live-policy: readonly\ntest("uses unsupported matcher", async ({ page }) => {\n  await expect(page.getByText("Ready")).toMatchAriaSnapshot();\n});\n`;

  it("does not call AI for statically compilable scenarios", async () => {
    const abstractScenario = vi.fn();
    const result = await recoverPlaywrightSpecWithAi({
      compileResult: compilePlaywrightSpec({ source, sourcePath: "dashboard.spec.ts" }),
      source,
      abstractScenario,
    });

    expect(result).toEqual(compilePlaywrightSpec({ source, sourcePath: "dashboard.spec.ts" }));
    expect(abstractScenario).not.toHaveBeenCalled();
  });

  it("abstracts only the failed test slice, caches it, and replaces the blocked scenario", async () => {
    const compileResult = compilePlaywrightSpec({ source: unsupportedSource, sourcePath: "fallback.spec.ts" });
    const entries = new Map();
    const cache = {
      read: vi.fn(key => entries.get(key)),
      write: vi.fn((key, value) => entries.set(key, value)),
    };
    const abstractScenario = vi.fn(async () => ({
      status: "ABSTRACTED",
      claims: ["Ready text is visible"],
    }));
    const options = {
      compileResult,
      source: unsupportedSource,
      abstractScenario,
      cache,
      promptVersion: "spec-fallback/1",
      model: "test-model",
      modelVersion: "2026-07-31",
    };

    const first = await recoverPlaywrightSpecWithAi(options);
    const second = await recoverPlaywrightSpecWithAi(options);
    const scenario = first.qaIr.suites[0].scenarios[0];

    expect(abstractScenario).toHaveBeenCalledTimes(1);
    expect(abstractScenario.mock.calls[0][0].sourceSlice).toContain('test("uses unsupported matcher"');
    expect(abstractScenario.mock.calls[0][0].sourceSlice).not.toContain("@qa-scenario");
    expect(first.ok).toBe(true);
    expect(first.qaIr.extensions.blockedScenarioIds ?? []).not.toContain(scenario.id);
    expect(first.qaIr.extensions.semanticJudgmentScenarioIds).toContain(scenario.id);
    expect(scenario.expectations).toMatchObject([{ kind: "VISIBLE_TEXT", text: { kind: "literal", value: "Ready text is visible" } }]);
    expect(scenario.steps.map(step => step.kind)).toEqual(["NAVIGATE", "OBSERVE", "CHECKPOINT"]);
    expect(second).toEqual(first);
  });

  it("invalidates the cache when source, prompt, model, or policy metadata changes", async () => {
    const abstractScenario = vi.fn(async () => ({ status: "MANUAL_REVIEW", reason: "network observation is unsupported" }));
    const entries = new Map();
    const cache = { read: key => entries.get(key), write: (key, value) => entries.set(key, value) };
    const base = {
      compileResult: compilePlaywrightSpec({ source: unsupportedSource, sourcePath: "fallback.spec.ts" }),
      source: unsupportedSource,
      abstractScenario,
      cache,
      promptVersion: "spec-fallback/1",
      model: "model-a",
      modelVersion: "v1",
    };

    await recoverPlaywrightSpecWithAi(base);
    await recoverPlaywrightSpecWithAi(base);
    await recoverPlaywrightSpecWithAi({ ...base, promptVersion: "spec-fallback/2" });
    await recoverPlaywrightSpecWithAi({ ...base, model: "model-b" });
    await recoverPlaywrightSpecWithAi({ ...base, modelVersion: "v2" });
    const policyChanged = structuredClone(base.compileResult);
    policyChanged.qaIr.suites[0].scenarios[0].policy.readNetwork = true;
    await recoverPlaywrightSpecWithAi({ ...base, compileResult: policyChanged });
    const changedSource = unsupportedSource.replace("Ready", "Loaded");
    await recoverPlaywrightSpecWithAi({ ...base, source: changedSource, compileResult: compilePlaywrightSpec({ source: changedSource, sourcePath: "fallback.spec.ts" }) });

    expect(abstractScenario).toHaveBeenCalledTimes(6);
  });

  it("fails closed when AI output expands the schema", async () => {
    const compileResult = compilePlaywrightSpec({ source: unsupportedSource, sourcePath: "fallback.spec.ts" });
    const result = await recoverPlaywrightSpecWithAi({
      compileResult,
      source: unsupportedSource,
      abstractScenario: async () => ({
        status: "ABSTRACTED",
        policy: { click: "ALL" },
        claims: ["Ready text is visible"],
      }),
      promptVersion: "spec-fallback/1",
      model: "test-model",
    });

    expect(result.ok).toBe(false);
    expect(result.qaIr.extensions.blockedScenarioIds).toEqual(compileResult.qaIr.extensions.blockedScenarioIds);
  });
});
