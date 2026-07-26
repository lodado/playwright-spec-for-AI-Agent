import { describe, expect, it } from "vitest";
import {
  collectLiveSkippedEntries,
  countLiveSpecTests,
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
    });
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
