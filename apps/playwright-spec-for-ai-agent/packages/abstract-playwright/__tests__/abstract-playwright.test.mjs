import { describe, expect, it, vi } from "vitest";
import { extractStaticAuthority } from "../../static-authority/index.mjs";
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
const manifest = extractStaticAuthority({ source, sourcePath: "dashboard.spec.ts" });
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
    expect(() => normalizeFullSpecAbstraction(legacy, { source, manifest })).toThrow(/Given, When, Then/);
    expect(() => normalizeFullSpecAbstraction({ ...candidate, tests: candidate.tests.map(test => ({ ...test, claims: test.then })) }, { source, manifest })).toThrow(/unsupported fields/);
  });

  it("normalizes model order back to immutable manifest order", () => {
    const normalized = normalizeFullSpecAbstraction({ ...candidate, tests: [...candidate.tests].reverse() }, { source, manifest });
    expect(normalized.tests.map(test => test.testId)).toEqual(manifest.tests.map(test => test.testId));
  });

  it("accepts the independent reviewer's corrected final artifact without a revision loop", async () => {
    const revised = structuredClone(candidate);
    revised.tests[0].then = ["Dashboard heading is visible"];
    const extract = vi.fn().mockResolvedValue(candidate);
    const review = vi.fn().mockResolvedValue({ status: "APPROVED", tests: revised.tests });

    const artifact = await abstractPlaywrightSource({ source, sourcePath: "dashboard.spec.ts", manifest, extract, review });

    expect(artifact.status).toBe("APPROVED");
    expect(artifact.tests[0].then).toEqual(["Dashboard heading is visible"]);
    expect(artifact.source.manifestHash).toBeDefined();
    expect(artifact.review).toMatchObject({ candidateHash: expect.any(String), approvedHash: expect.any(String) });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][0].manifest).toEqual(manifest);
    expect(review.mock.calls[0][0]).toMatchObject({ manifest, candidate });
  });

  it("fails closed on a manual review or malformed extraction", async () => {
    const rejected = await abstractPlaywrightSource({ source, sourcePath: "dashboard.spec.ts", manifest, extract: async () => candidate, review: async () => ({ status: "MANUAL_REVIEW", reason: "Meaning is ambiguous" }) });
    expect(rejected).toMatchObject({ status: "MANUAL_REVIEW", reason: "Meaning is ambiguous" });
    const malformed = await abstractPlaywrightSource({ source, sourcePath: "dashboard.spec.ts", manifest, extract: async () => ({ status: "ABSTRACTED", tests: [] }), review: vi.fn() });
    expect(malformed).toMatchObject({ status: "MANUAL_REVIEW", reason: expect.stringContaining("must cover exactly 2") });
  });
});

describe("abstract Playwright compiler", () => {
  it("takes inherited policy, page, title, and provenance only from static manifest", async () => {
    const input = `// @qa-scenario: MENU\n// @qa-page: /dashboard\n// @qa-live-policy: safe-interaction\ntest.describe("menu", () => {\n  test("opens menu", async ({ page }) => { await page.getByRole("button", { name: "Menu" }).click(); });\n});\n`;
    const staticManifest = extractStaticAuthority({ source: input, sourcePath: "menu.spec.ts" });
    const extracted = { status: "ABSTRACTED", tests: [{ testId: staticManifest.tests[0].testId, given: ["a user is signed in"], when: ["the menu is opened"], then: ["the menu is visible"], classification: "LIVE_EXECUTABLE" }] };
    const artifact = await abstractPlaywrightSource({ source: input, sourcePath: "menu.spec.ts", manifest: staticManifest, extract: async () => extracted, review: async () => ({ status: "APPROVED", tests: extracted.tests }) });
    const result = compileAbstractPlaywrightArtifact({ artifact, manifest: staticManifest, source: input, sourcePath: "menu.spec.ts" });

    expect(result.ok).toBe(true);
    const scenario = result.qaIr.suites[0].scenarios[0];
    expect(scenario.title).toBe("opens menu");
    expect(scenario.policy).toMatchObject({ navigation: "ALLOWED", readDom: true, click: "SAFE_ONLY" });
    expect(scenario.steps[0].target).toEqual({ type: "PATH", value: "/dashboard" });
    expect(scenario.steps.map(step => step.kind)).toEqual(["NAVIGATE", "OBSERVE", "CHECKPOINT"]);
    expect(result.qaIr.extensions.staticManifestHash).toBe(artifact.source.manifestHash);
    expect(scenario.semantics.then).toEqual(["the menu is visible"]);
    expect(scenario.expectations[0].kind).toBe("SEMANTIC_CLAIM");
    expect(result.qaIr.extensions.abstractScenarios).toBeUndefined();
  });

  it("blocks non-live classification even when static policy permits observation", async () => {
    const extracted = { status: "ABSTRACTED", tests: candidate.tests.map(test => ({ ...test, classification: "MOCK_ONLY" })) };
    const artifact = await abstractPlaywrightSource({ source, sourcePath: "dashboard.spec.ts", manifest, extract: async () => extracted, review: async () => ({ status: "APPROVED", tests: extracted.tests }) });
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
