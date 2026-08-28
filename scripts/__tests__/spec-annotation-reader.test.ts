import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countUnparsedTests,
  describeLiveRunPolicy,
  extractTestBlocks,
  mapLivePolicyAnnotation,
  parseAnnotations,
  parseFileFixtures,
  parseFixtureFromCommentLine,
  parseFixturesBeforeIndex,
  parseLivePolicyBeforeIndex,
  parseSpecFile,
  resolveTestFixtures,
  resolveTestLivePolicy,
} from "../spec-annotation-reader.mjs";
import { getLivePolicyOverrides } from "../hermes-qa-project-config.mjs";

vi.mock("../hermes-qa-project-config.mjs", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../hermes-qa-project-config.mjs")>();
  return { ...actual, getLivePolicyOverrides: vi.fn(() => ({})) };
});

afterEach(() => {
  vi.mocked(getLivePolicyOverrides).mockReturnValue({});
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
      parseSpecFile(
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
    const parsed = parseSpecFile(
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

describe("describeLiveRunPolicy", () => {
  it("describes judgment-mock-api for Hermes discretion", () => {
    expect(describeLiveRunPolicy("judgment-mock-api")).toMatch(
      /reasonably matches intent/i,
    );
  });
});

describe("annotation line anchoring", () => {
  it("ignores prose that merely mentions @qa-live-skip", () => {
    const source = [
      "// @qa-scenario: ACTIVE",
      "/* @qa-live-skip: true on a file means Hermes skips it entirely. */",
      "// The annotation @qa-live-skip: true only counts on its own line.",
      "// @qa-live-policy: readonly",
      'test("shows plan", async ({ page }) => {',
      '  await expect(page.getByTestId("plan-name")).toBeVisible();',
      "});",
    ].join("\n");

    expect(parseAnnotations(source).liveSkip).toBe(false);
    expect(parseSpecFile("prose.spec.ts", source)?.tests).toHaveLength(
      1,
    );
  });

  it("still honours a real whole-line annotation, CRLF included", () => {
    expect(
      parseAnnotations("// @qa-scenario: ACTIVE\r\n// @qa-live-skip: true\r\n"),
    ).toMatchObject({ scenario: "ACTIVE", liveSkip: true });
  });
});

describe("extractTestBlocks", () => {
  it("extracts Playwright test details objects without dropping the declaration", () => {
    const source = `test("tagged", { tag: "@slow", annotation: { type: "issue", description: "QA-1" } }, async ({ page }) => {
      await expect(page.getByTestId("root")).toBeVisible();
    });`;

    expect(extractTestBlocks(source).map(block => block.title)).toEqual(["tagged"]);
    expect(countUnparsedTests(source)).toBe(0);
  });

  it("extracts modifier, quote-style, and signature variants", () => {
    const source = [
      "test.only('only test', async () => {});",
      'test.skip("skip test", async ({ page }) => {});',
      "test(`template title`, async ({",
      "  page,",
      "}, testInfo) => {});",
      'test.beforeEach("hook", async ({ page }) => {});',
    ].join("\n");

    expect(extractTestBlocks(source).map(block => block.title)).toEqual([
      "only test",
      "skip test",
      "template title",
    ]);
    expect(countUnparsedTests(source)).toBe(0);
  });

  it("does not truncate a body containing a brace inside a string", () => {
    const source = [
      'test("keeps the whole body", async ({ page }) => {',
      '  await page.getByText("}").click();',
      "  await page.route(/\\/api\\/{x}/, r => r.fulfill({ status: 200 }));",
      "  // a trailing } in a comment",
      '  await expect(page.getByTestId("done")).toBeVisible();',
      "});",
    ].join("\n");

    const [block] = extractTestBlocks(source);
    expect(block.body).toContain('getByTestId("done")');
    expect(countUnparsedTests(source)).toBe(0);
  });

  it("does not warn or drop a test details declaration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = [
      "// @qa-scenario: ACTIVE",
      "// @qa-live-policy: readonly",
      'test("parsed", async ({ page }) => {});',
      "// @qa-live-policy: readonly",
      'test("tagged", { tag: "@slow" }, async ({ page }) => {});',
    ].join("\n");

    const parsed = parseSpecFile("drops.spec.ts", source);

    expect(parsed?.tests).toHaveLength(2);
    expect(parsed?.unparsedTestCount).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("@qa-live-policy vocabulary", () => {
  it("accepts a trailing comment after the policy", () => {
    const source = [
      "// @qa-live-policy: readonly // DOM-only, safe on live  ",
      'test("reads", async ({ page }) => {});',
    ].join("\n");
    const testIndex = source.indexOf('test("reads"');

    expect(parseLivePolicyBeforeIndex(source, testIndex)).toBe("readonly");
  });

  it("resolves a project-configured custom policy name", () => {
    vi.mocked(getLivePolicyOverrides).mockReturnValue({
      "payments-mutation": { liveRunPolicy: "blocked-subscription-mutation" },
    });

    expect(mapLivePolicyAnnotation("payments-mutation")).toEqual({
      liveRunPolicy: "blocked-subscription-mutation",
      stagingMode: "interaction",
    });
  });

  it("rejects a custom policy pointing at an unknown verb", () => {
    vi.mocked(getLivePolicyOverrides).mockReturnValue({
      bogus: { liveRunPolicy: "not-a-verb" },
    });

    expect(() => mapLivePolicyAnnotation("bogus")).toThrow(
      /unknown liveRunPolicy "not-a-verb"/,
    );
  });

  it("lists configured custom names when an annotation is unknown", () => {
    vi.mocked(getLivePolicyOverrides).mockReturnValue({
      "payments-mutation": { liveRunPolicy: "blocked-subscription-mutation" },
    });

    expect(() => mapLivePolicyAnnotation("typo")).toThrow(
      /payments-mutation/,
    );
  });

  it("names file and line when a test has no policy", () => {
    expect(() =>
      parseSpecFile(
        "bad.spec.ts",
        `// @qa-scenario: ACTIVE\n\ntest("no policy", async ({ page }) => {});`,
      ),
    ).toThrow(/bad\.spec\.ts:3/);
  });
});

describe("shipped examples", () => {
  it("parses examples/sample-spec.ts with live-runnable tests", () => {
    const path = fileURLToPath(
      new URL("../../examples/sample-spec.ts", import.meta.url),
    );
    const parsed = parseSpecFile(
      "sample-spec.ts",
      readFileSync(path, "utf8"),
    );

    expect(parsed?.liveSkip).toBe(false);
    expect(parsed?.unparsedTestCount).toBeUndefined();
    expect(parsed?.tests).toHaveLength(4);

    const includedTests = parsed!.tests.filter(
      test => !test.liveRunPolicy.startsWith("blocked-"),
    );
    expect(includedTests.map(test => test.liveRunPolicy)).toEqual([
      "executable-readonly",
      "executable-interaction",
      "executable-interaction",
    ]);
  });
});

describe("checkId slugs", () => {
  it("keeps a non-Latin title distinguishable instead of collapsing it to unnamed-test", () => {
    const source = `
// @qa-scenario: PUBLIC
// @qa-live-policy: readonly
test("공개 랜딩이 서비스 소개를 보여준다", async ({ page }) => {});
// @qa-live-policy: readonly
test("로그인 후 기록을 시작한다", async ({ page }) => {});
`;
    const parsed = parseSpecFile("home.spec.ts", source)!;
    const ids = parsed.tests.map(test => test.checkId);

    expect(ids).not.toContain("unnamed-test");
    // Two upload-fixture keys that collide are two tests sharing one fixture.
    expect(new Set(ids).size).toBe(2);
  });
});
