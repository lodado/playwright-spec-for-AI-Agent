import { describe, expect, it, vi } from "vitest";
import { extractPlaywrightStaticManifest } from "../../adapter-playwright/index.mjs";
import { abstractPlaywrightSource, compileAbstractPlaywrightArtifact, countPlaywrightTestDeclarations, normalizeFullSpecAbstraction } from "../index.mjs";

const source = `// @qa-scenario: DASHBOARD
// @qa-page: /dashboard
test.describe("page", () => {
  // @qa-live-policy: readonly
  test("shows dashboard", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
  // @qa-live-policy: mock-judgment
  test.skip("mock only", async ({ page }) => {
    await page.route("**/api", route => route.fulfill({ json: {} }));
  });
});
`;
const manifest = extractPlaywrightStaticManifest({ source, sourcePath: "dashboard.spec.ts" });
const candidate = {
  status: "ABSTRACTED",
  tests: [
    { testId: manifest.tests[0].testId, given: ["the dashboard is available"], when: ["open the dashboard"], then: ["Dashboard content is visible"], classification: "LIVE_EXECUTABLE" },
    { testId: manifest.tests[1].testId, given: [], when: [], then: ["The mocked API response is rendered"], classification: "MOCK_ONLY" },
  ],
};

describe("AI-first Playwright abstraction", () => {
  it("counts declarations without counting comments, strings, or describe blocks", () => {
    expect(countPlaywrightTestDeclarations(source)).toBe(2);
    expect(countPlaywrightTestDeclarations(`const x = "test('fake')"; it.each([[1]])("case", () => {});`)).toBe(1);
  });

  it("requires exact manifest testId coverage and forbids authority-bearing output", () => {
    expect(normalizeFullSpecAbstraction(candidate, { source, manifest })).toEqual(candidate);
    expect(() => normalizeFullSpecAbstraction({ ...candidate, tests: candidate.tests.slice(0, 1) }, { source, manifest })).toThrow(/cover exactly 2/);
    expect(() => normalizeFullSpecAbstraction({ ...candidate, tests: candidate.tests.map(test => ({ ...test, policy: "readonly" })) }, { source, manifest })).toThrow(/unsupported fields/);
    expect(() => normalizeFullSpecAbstraction({ ...candidate, tests: candidate.tests.map(test => ({ ...test, actions: [] })) }, { source, manifest })).toThrow(/unsupported fields/);
    expect(() => normalizeFullSpecAbstraction({ ...candidate, tests: candidate.tests.map(test => ({ ...test, testId: "invented" })) }, { source, manifest })).toThrow(/testId/);
    expect(() => normalizeFullSpecAbstraction({ ...candidate, tests: [candidate.tests[0], candidate.tests[0]] }, { source, manifest })).toThrow(/unique and complete/);
    const legacy = { ...candidate, tests: candidate.tests.map(({ given, then, ...test }) => ({ ...test, applicability: given, claims: then })) };
    expect(normalizeFullSpecAbstraction(legacy, { source, manifest })).toEqual(candidate);
    expect(() => normalizeFullSpecAbstraction({ ...candidate, tests: candidate.tests.map(test => ({ ...test, claims: test.then })) }, { source, manifest })).toThrow(/Given, When, Then/);
  });

  it("normalizes model order back to immutable manifest order", () => {
    const normalized = normalizeFullSpecAbstraction({ ...candidate, tests: [...candidate.tests].reverse() }, { source, manifest });
    expect(normalized.tests.map(test => test.testId)).toEqual(manifest.tests.map(test => test.testId));
  });

  it("uses an independent review and allows exactly one reviewed revision", async () => {
    const revised = structuredClone(candidate);
    revised.tests[0].then = ["Dashboard heading is visible"];
    const extract = vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(revised);
    const review = vi.fn().mockResolvedValueOnce({ status: "REVISE", issues: ["Preserve the heading requirement"] }).mockResolvedValueOnce({ status: "APPROVED" });

    const artifact = await abstractPlaywrightSource({ source, sourcePath: "dashboard.spec.ts", manifest, extract, review });

    expect(artifact.status).toBe("APPROVED");
    expect(artifact.tests[0].then).toEqual(["Dashboard heading is visible"]);
    expect(artifact.source.manifestHash).toBeDefined();
    expect(artifact.attempts.map(item => item.reviewStatus)).toEqual(["REVISE", "APPROVED"]);
    expect(extract.mock.calls[0][0].manifest).toEqual(manifest);
    expect(extract.mock.calls[1][0].reviewerIssues).toEqual(["Preserve the heading requirement"]);
    expect(review.mock.calls[0][0]).toMatchObject({ manifest, candidate });
  });

  it("fails closed after three rejected revisions and isolates malformed output", async () => {
    const rejected = await abstractPlaywrightSource({ source, sourcePath: "dashboard.spec.ts", manifest, extract: async () => candidate, review: async () => ({ status: "REVISE", issues: ["Meaning is weakened"] }) });
    expect(rejected).toMatchObject({ status: "MANUAL_REVIEW", attempts: [{ reviewStatus: "REVISE" }, { reviewStatus: "REVISE" }, { reviewStatus: "REVISE" }, { reviewStatus: "REVISE" }] });
    const malformed = await abstractPlaywrightSource({ source, sourcePath: "dashboard.spec.ts", manifest, extract: async () => ({ status: "ABSTRACTED", tests: [] }), review: vi.fn() });
    expect(malformed).toMatchObject({ status: "MANUAL_REVIEW", reason: expect.stringContaining("must cover exactly 2") });
  });
});

describe("abstract Playwright compiler", () => {
  it("takes inherited policy, page, title, and provenance only from static manifest", async () => {
    const input = `// @qa-scenario: MENU\n// @qa-page: /dashboard\n// @qa-live-policy: safe-interaction\ntest.describe("menu", () => {\n  test("opens menu", async ({ page }) => { await page.getByRole("button", { name: "Menu" }).click(); });\n});\n`;
    const staticManifest = extractPlaywrightStaticManifest({ source: input, sourcePath: "menu.spec.ts" });
    const extracted = { status: "ABSTRACTED", tests: [{ testId: staticManifest.tests[0].testId, given: ["a user is signed in"], when: ["the menu is opened"], then: ["the menu is visible"], classification: "LIVE_EXECUTABLE" }] };
    const artifact = await abstractPlaywrightSource({ source: input, sourcePath: "menu.spec.ts", manifest: staticManifest, extract: async () => extracted, review: async () => ({ status: "APPROVED" }) });
    const result = compileAbstractPlaywrightArtifact({ artifact, manifest: staticManifest, source: input, sourcePath: "menu.spec.ts" });

    expect(result.ok).toBe(true);
    const scenario = result.qaIr.suites[0].scenarios[0];
    expect(scenario.title).toBe("opens menu");
    expect(scenario.policy).toMatchObject({ navigation: "ALLOWED", readDom: true, click: "SAFE_ONLY" });
    expect(scenario.steps[0].target).toEqual({ type: "PATH", value: "/dashboard" });
    expect(scenario.steps.map(step => step.kind)).toEqual(["NAVIGATE", "INTERACT", "OBSERVE", "CHECKPOINT"]);
    expect(scenario.steps[1]).toMatchObject({ kind: "INTERACT", milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { role: "button", accessibleName: { kind: "literal", value: "Menu" } } });
    expect(result.qaIr.extensions.staticManifestHash).toBe(artifact.source.manifestHash);
    expect(scenario.semantics.claims).toEqual(["the menu is visible"]);
    expect(scenario.expectations[0].kind).toBe("SEMANTIC_CLAIM");
    expect(result.qaIr.extensions.abstractScenarios).toBeUndefined();
  });

  it("blocks non-live classification even when static policy permits observation", async () => {
    const extracted = { status: "ABSTRACTED", tests: candidate.tests.map(test => ({ ...test, classification: "MOCK_ONLY" })) };
    const artifact = await abstractPlaywrightSource({ source, sourcePath: "dashboard.spec.ts", manifest, extract: async () => extracted, review: async () => ({ status: "APPROVED" }) });
    const result = compileAbstractPlaywrightArtifact({ artifact, manifest, source, sourcePath: "dashboard.spec.ts" });
    expect(result.ok).toBe(false);
    expect(result.qaIr.extensions.blockedScenarioIds).toHaveLength(2);
    expect(result.diagnostics.map(item => item.code)).toEqual(["ABSTRACT_NON_LIVE", "ABSTRACT_NON_LIVE"]);
  });

  it("rejects malformed static actions instead of granting execution authority", () => {
    const invalid = structuredClone(manifest);
    invalid.tests[0].actions = [{ action: "TYPE", target: { testId: "email" } }];
    expect(() => normalizeFullSpecAbstraction(candidate, { source, manifest: invalid })).toThrow(/static manifest action/);
  });
});
