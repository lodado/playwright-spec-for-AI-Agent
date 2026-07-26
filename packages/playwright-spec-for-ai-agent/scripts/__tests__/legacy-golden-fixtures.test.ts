import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildBrowseChecklist,
  flattenExecutableTests,
  formatScenarioCoverageSummary,
  parseDashboardSpecFile,
  selectScenariosForLiveRun,
} from "../dashboard-spec-parser.mjs";
import {
  collectLiveSkippedEntries,
  countLiveSpecTests,
  filterSpecForLiveJson,
} from "../spec-live-filter.mjs";

const fixtureDir = "scripts/fixtures/legacy-qa-specs";
const goldenPath = join(
  "scripts",
  "fixtures",
  "legacy-golden",
  "current-behavior.json",
);

function currentBehavior() {
  const scenarios = readdirSync(fixtureDir)
    .filter(file => file.endsWith(".fixture.ts"))
    .sort()
    .map(file =>
      parseDashboardSpecFile(
        file.replace(".fixture.ts", ".spec.ts"),
        readFileSync(join(fixtureDir, file), "utf8"),
      ),
    )
    .filter(Boolean);
  const spec = {
    generatedAt: new Date().toISOString(),
    sourceDirectory: fixtureDir,
    scenarios,
  };
  const live = filterSpecForLiveJson(spec);
  spec.generatedAt = "<generatedAt>";
  live.generatedAt = "<generatedAt>";

  return {
    spec,
    live,
    selectedForDashboardReadonly: selectScenariosForLiveRun(
      spec,
      "DASHBOARD_READONLY",
    ).map(scenario => scenario.scenarioId),
    alwaysRun: selectScenariosForLiveRun(spec, "DASHBOARD_READONLY")
      .filter(scenario => scenario.alwaysRun)
      .map(scenario => scenario.scenarioId),
    browseChecklist: buildBrowseChecklist(spec),
    executableChecks: flattenExecutableTests(
      spec.scenarios,
      "DASHBOARD_READONLY",
    ).map(check => ({
      scenarioId: check.scenarioId,
      sourceFile: check.sourceFile,
      testTitle: check.testTitle,
      checkId: check.checkId,
      expectation: check.expectation,
    })),
    skipped: collectLiveSkippedEntries(spec),
    counts: {
      all: countLiveSpecTests(spec),
      live: countLiveSpecTests(live),
    },
    coverage: Object.fromEntries(
      spec.scenarios.map(scenario => [
        scenario.scenarioId,
        formatScenarioCoverageSummary(spec, scenario.scenarioId),
      ]),
    ),
  };
}

describe("legacy QA golden fixtures", () => {
  it("freezes representative parser and live-filter behavior", () => {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    const current = currentBehavior();
    const policies = new Set(
      current.spec.scenarios.flatMap(scenario =>
        scenario.tests.map(test => test.liveRunPolicy),
      ),
    );

    expect([...policies].sort()).toEqual([
      "blocked-auth-mock",
      "blocked-live-skip",
      "blocked-subscription-mutation",
      "executable-interaction",
      "executable-readonly",
      "judgment-interaction-no-confirm",
      "judgment-mock-api",
    ]);
    expect(current.alwaysRun).toEqual(["GLOBAL_NAV"]);
    expect(current.selectedForDashboardReadonly).toEqual([
      "DASHBOARD_READONLY",
      "GLOBAL_NAV",
    ]);

    expect(current).toEqual(golden);
  });
});
