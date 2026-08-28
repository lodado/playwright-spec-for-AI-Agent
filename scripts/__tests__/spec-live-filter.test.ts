import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { run as runSpec } from "../extract-page-e2e-spec.mjs";
import {
  collectLiveSkippedEntries,
  countLiveSpecTests,
  countUnparsedSpecTests,
  filterSpecForLiveJson,
  isLiveSkippedTest,
  liveSkipReason,
} from "../spec-live-filter.mjs";

const sampleSpec = {
  scenarios: [
    {
      scenarioId: "LOGGED_IN_WITH_DATA",
      sourceFile: "mixed.spec.ts",
      label: "Mixed",
      liveSkip: false,
      tests: [
        {
          title: "readonly check",
          stagingMode: "read-only",
          liveRunPolicy: "executable-readonly",
          livePolicyAnnotation: "readonly",
        },
        {
          title: "skip me",
          stagingMode: "live-skip",
          liveRunPolicy: "blocked-live-skip",
          livePolicyAnnotation: "skip",
        },
      ],
    },
    {
      scenarioId: "WORKSPACE_TASK_DETAIL_LOADED",
      sourceFile: "msw.spec.ts",
      label: "MSW",
      liveSkip: true,
      tests: [
        {
          title: "bbox overlay",
          stagingMode: "live-skip",
          liveRunPolicy: "blocked-live-skip",
        },
      ],
    },
    {
      scenarioId: "LOGGED_IN_WITH_DATA",
      sourceFile: "all-skip.spec.ts",
      label: "All skip",
      liveSkip: false,
      tests: [
        {
          title: "only skip",
          stagingMode: "live-skip",
          liveRunPolicy: "blocked-live-skip",
          livePolicyAnnotation: "skip",
        },
      ],
    },
  ],
};

describe("isLiveSkippedTest", () => {
  it("treats blocked policies and live-skip staging as skipped", () => {
    expect(
      isLiveSkippedTest({
        stagingMode: "live-skip",
        liveRunPolicy: "blocked-live-skip",
      }),
    ).toBe(true);
    expect(
      isLiveSkippedTest({
        stagingMode: "interaction",
        liveRunPolicy: "blocked-subscription-mutation",
      }),
    ).toBe(true);
    expect(
      isLiveSkippedTest({
        stagingMode: "read-only",
        liveRunPolicy: "executable-readonly",
      }),
    ).toBe(false);
  });
});

describe("filterSpecForLiveJson", () => {
  it("removes skipped tests and liveSkip scenarios", () => {
    const filtered = filterSpecForLiveJson(sampleSpec);

    expect(filtered.scenarios).toHaveLength(1);
    expect(filtered.scenarios[0].sourceFile).toBe("mixed.spec.ts");
    expect(filtered.scenarios[0].tests).toHaveLength(1);
    expect(filtered.scenarios[0].tests[0].title).toBe("readonly check");
  });
});

describe("collectLiveSkippedEntries", () => {
  it("lists every skipped test with reason", () => {
    const entries = collectLiveSkippedEntries(sampleSpec);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      sourceFile: "mixed.spec.ts",
      reason: "@qa-live-policy: skip",
      policy: "skip",
    });
    expect(entries[1].policy).toBe("blocked-live-skip");
    expect(entries[1]).toMatchObject({
      sourceFile: "msw.spec.ts",
      reason: "@qa-live-skip",
    });
    expect(entries[2]).toMatchObject({
      sourceFile: "all-skip.spec.ts",
      reason: "@qa-live-policy: skip",
    });
  });
});

describe("liveSkipReason", () => {
  it("prefers file-level @qa-live-skip over test policy", () => {
    expect(
      liveSkipReason(
        { liveSkip: true },
        { livePolicyAnnotation: "skip", liveRunPolicy: "blocked-live-skip" },
      ),
    ).toBe("@qa-live-skip");
  });
});

describe("countLiveSpecTests", () => {
  it("counts tests across scenarios", () => {
    expect(countLiveSpecTests(sampleSpec)).toBe(4);
    expect(countLiveSpecTests(filterSpecForLiveJson(sampleSpec))).toBe(1);
  });
});

describe("countUnparsedSpecTests", () => {
  it("sums the parser's per-file unparsed counts", () => {
    expect(countUnparsedSpecTests(sampleSpec)).toBe(0);
    expect(
      countUnparsedSpecTests({
        scenarios: [{ unparsedTestCount: 2 }, {}, { unparsedTestCount: 1 }],
      }),
    ).toBe(3);
  });
});

const SPEC_SOURCE = `// @qa-page: dashboard
// @qa-scenario: ACTIVE
import { expect, test } from "@playwright/test";

test.describe("Dashboard", () => {
  // @qa-live-policy: readonly
  test("shows score", async ({ page }) => {
    await expect(page.getByTestId("score")).toContainText("98점");
  });

  // @qa-live-policy: skip
  test("changes the subscription plan", async ({ page }) => {
    await page.getByRole("button", { name: "Upgrade" }).click();
  });
});
`;

describe("spec stage artifact", () => {
  let root = "";
  let specDir = "";
  let outputDir = "";

  const argv = (...extra: string[]) => [
    "--page=dashboard",
    `--project-root=${root}`,
    "--spec-dir=specs/{page}",
    "--output-dir=out/{page}",
    ...extra,
  ];

  beforeEach(() => {
    resetProjectConfigForTests();
    root = mkdtempSync(join(tmpdir(), "qa-spec-stage-"));
    specDir = join(root, "specs", "dashboard");
    outputDir = join(root, "out", "dashboard");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "dashboard.spec.ts"), SPEC_SOURCE);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProjectConfigForTests();
    rmSync(root, { recursive: true, force: true });
  });

  const read = (file: string) =>
    JSON.parse(readFileSync(join(outputDir, file), "utf8"));

  it("records excluded tests, their reasons, and the spec-sources hash", async () => {
    await runSpec(argv());

    const spec = read("dashboard-qa-spec.json");
    expect(spec.artifactKind).toBe("qa-spec");
    expect(spec.specSourcesHash).toMatch(/^sha256:/);
    expect(spec.parserVersion).toBe("1.0.0");
    expect(spec.unparsedTestCount).toBe(0);
    expect(spec.excluded).toEqual([
      {
        sourceFile: "dashboard.spec.ts",
        scenarioId: "ACTIVE",
        title: "changes the subscription plan",
        reason: "@qa-live-policy: skip",
        policy: "skip",
      },
    ]);
    expect(countLiveSpecTests(spec)).toBe(1);

    // Same stamps on the rule-abstracted artifact abstract-ai actually reads.
    const abstracted = read("dashboard-qa-spec-abstracted.json");
    expect(abstracted.specSourcesHash).toBe(spec.specSourcesHash);
    expect(abstracted.excluded).toEqual(spec.excluded);
  });

  it("changes the spec-sources hash when a spec file changes", async () => {
    await runSpec(argv());
    const first = read("dashboard-qa-spec.json").specSourcesHash;

    resetProjectConfigForTests();
    writeFileSync(
      join(specDir, "dashboard.spec.ts"),
      SPEC_SOURCE.replace("shows score", "shows the score"),
    );
    await runSpec(argv());

    expect(read("dashboard-qa-spec.json").specSourcesHash).not.toBe(first);
  });

  it("records tests the parser could not read", async () => {
    writeFileSync(
      join(specDir, "dashboard.spec.ts"),
      `${SPEC_SOURCE}\ntest("delegated to a shared handler", sharedHandler);\n`,
    );
    await runSpec(argv());

    expect(read("dashboard-qa-spec.json").unparsedTestCount).toBe(1);
  });

  it("fails with the absolute path when a fixture is missing", async () => {
    writeFileSync(
      join(specDir, "dashboard.spec.ts"),
      SPEC_SOURCE.replace(
        "  // @qa-live-policy: readonly",
        `// @qa-fixture: invoice=fixtures/invoice.pdf\n  // @qa-live-policy: readonly`,
      ),
    );

    await expect(runSpec(argv())).rejects.toThrow(
      join(root, "fixtures", "invoice.pdf"),
    );

    resetProjectConfigForTests();
    await runSpec(argv("--allow-missing-fixtures"));
    expect(read("dashboard-qa-spec.json").scenarios[0].tests[0]).toMatchObject({
      fixtures: { invoice: "fixtures/invoice.pdf" },
    });
  });
});
