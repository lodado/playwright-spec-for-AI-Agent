import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  flattenExecutableTests,
  selectScenariosForLiveRun,
} from "./dashboard-spec-parser.mjs";

const TIMEOUT_MS = 20_000;

function truncateText(value, maxLength = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function loadPageQaSpec(outputDir, slug, pageForHelp = slug) {
  const specPath = join(outputDir, `${slug}-qa-spec.json`);
  if (!existsSync(specPath)) {
    throw new Error(
      `Missing ${slug}-qa-spec.json. Run \`node scripts/extract-page-e2e-spec.mjs --page=${pageForHelp}\` first.`
    );
  }
  return JSON.parse(readFileSync(specPath, "utf8"));
}

/** @deprecated Use loadPageQaSpec */
export function loadDashboardQaSpec(outputDir) {
  return loadPageQaSpec(outputDir, "dashboard");
}

export async function inspectScenarioFromPage(page, config) {
  const signals = {
    subtitle: truncateText(
      (await page
        .getByTestId("dashboard-subtitle")
        .innerText()
        .catch(() => "")) || ""
    ),
    subscriptionCancelLink: await page
      .getByTestId("subscription-cancel-link")
      .isVisible()
      .catch(() => false),
    subscriptionResumeLink: await page
      .getByTestId("subscription-resume-link")
      .isVisible()
      .catch(() => false),
    subscriptionDisabledLink: await page
      .getByTestId("subscription-disabled-link")
      .isVisible()
      .catch(() => false),
  };

  if (config.expectedSubscriptionStatus) {
    const normalized = config.expectedSubscriptionStatus.toUpperCase();
    if (["ACTIVE", "INACTIVE", "CANCEL_PENDING"].includes(normalized)) {
      return {
        scenarioId: normalized,
        inferredFrom: "override",
        signals,
      };
    }
  }

  // Infer scenario from visible subscription action links and subtitle text.
  // Adapt these heuristics to match your application's DOM structure.
  if (signals.subscriptionResumeLink) {
    return {
      scenarioId: "CANCEL_PENDING",
      inferredFrom: "subscription-resume-link",
      signals,
    };
  }
  if (signals.subscriptionCancelLink) {
    return {
      scenarioId: "ACTIVE",
      inferredFrom: "subscription-cancel-link",
      signals,
    };
  }
  if (signals.subscriptionDisabledLink) {
    return {
      scenarioId: "INACTIVE",
      inferredFrom: "subscription-disabled-link",
      signals,
    };
  }

  return { scenarioId: null, inferredFrom: null, signals };
}

export async function inferScenarioFromPage(page, config) {
  const { scenarioId } = await inspectScenarioFromPage(page, config);
  return scenarioId;
}

function resolveLocator(page, locator) {
  if (locator.kind === "testId") {
    return page.getByTestId(locator.value).first();
  }

  if (locator.kind === "text") {
    if (typeof locator.value === "object" && locator.value.kind === "regex") {
      return page.getByText(new RegExp(locator.value.pattern)).first();
    }
    return page.getByText(locator.value).first();
  }

  throw new Error(`Unsupported locator: ${JSON.stringify(locator)}`);
}

function formatExpected(expectation) {
  if (expectation.type === "notVisible") {
    return `${expectation.locator.kind}=${JSON.stringify(expectation.locator.value)} hidden`;
  }
  if (expectation.type === "visible") {
    return `${expectation.locator.kind}=${JSON.stringify(expectation.locator.value)} visible`;
  }
  if (expectation.expected.kind === "literal") {
    return `${expectation.locator.kind}=${JSON.stringify(expectation.locator.value)} contains "${expectation.expected.value}"`;
  }
  if (expectation.expected.kind === "regex") {
    return `${expectation.locator.kind}=${JSON.stringify(expectation.locator.value)} matches /${expectation.expected.pattern}/`;
  }
  return JSON.stringify(expectation);
}

async function runExpectation(page, expectation) {
  const locator = resolveLocator(page, expectation.locator);

  if (expectation.type === "visible") {
    await locator.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    return truncateText((await locator.innerText()) || "visible");
  }

  if (expectation.type === "notVisible") {
    await locator.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
    return `${expectation.locator.kind}=${expectation.locator.value} hidden`;
  }

  if (expectation.type === "containText") {
    await locator.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    const text = (await locator.innerText()) || "";

    if (expectation.expected.kind === "literal") {
      if (!text.includes(expectation.expected.value)) {
        throw new Error(
          `Expected to contain "${expectation.expected.value}" but saw "${truncateText(text)}"`
        );
      }
      return truncateText(text);
    }

    if (expectation.expected.kind === "regex") {
      const regex = new RegExp(expectation.expected.pattern);
      if (!regex.test(text)) {
        throw new Error(
          `Expected to match /${expectation.expected.pattern}/ but saw "${truncateText(text)}"`
        );
      }
      return truncateText(text);
    }
  }

  throw new Error(`Unsupported expectation type: ${expectation.type}`);
}

export async function runDashboardSpecAssertions({
  page,
  spec,
  scenarioId,
  checks,
  steps,
  createCheck,
  createStep,
}) {
  const scenarios = selectScenariosForLiveRun(spec, scenarioId);
  const executable = flattenExecutableTests(scenarios, scenarioId);
  const skippedTests = [];

  for (const scenario of spec.scenarios) {
    for (const test of scenario.tests) {
      if (test.stagingMode !== "read-only") {
        skippedTests.push({
          scenarioId: scenario.scenarioId,
          title: test.title,
          reason: test.stagingMode,
        });
      }
    }
  }

  if (executable.length === 0) {
    checks.push(
      createCheck(
        "spec-assertions",
        "fail",
        `No read-only assertions found for scenario ${scenarioId ?? "unknown"}`
      )
    );
    return {
      scenarioId,
      executedCount: 0,
      skippedTests,
      inferredScenario: Boolean(scenarioId),
    };
  }

  for (const item of executable) {
    const name = item.checkId;
    const target = `[${item.scenarioId}] ${item.testTitle}`;
    const expected = formatExpected(item.expectation);

    try {
      const details = await runExpectation(page, item.expectation);
      checks.push(createCheck(name, "pass", details));
      createStep(steps, {
        phase: "spec",
        action: item.expectation.type,
        target,
        expected,
        outcome: "pass",
        details,
        url: page.url(),
        sourceFile: item.sourceFile,
        testTitle: item.testTitle,
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      checks.push(createCheck(name, "fail", details));
      createStep(steps, {
        phase: "spec",
        action: item.expectation.type,
        target,
        expected,
        outcome: "fail",
        details,
        url: page.url(),
        sourceFile: item.sourceFile,
        testTitle: item.testTitle,
      });
    }
  }

  return {
    scenarioId,
    executedCount: executable.length,
    skippedTests,
    inferredScenario: Boolean(scenarioId),
  };
}
