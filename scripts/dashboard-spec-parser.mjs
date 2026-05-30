import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Extract QA annotations from spec file source.
 * Supported file-level annotations:
 *   // @qa-page: dashboard
 *   // @qa-scenario: ACTIVE
 *   // @qa-live-skip: true
 *   // @qa-always-run: true
 *
 * Per-test (or test.describe) live policy — required on every test in @qa-scenario files:
 *   // @qa-live-policy: readonly | safe-interaction | safe-interaction-no-confirm | mock-judgment | subscription-mutation | auth-mock | skip
 */
export const QA_LIVE_POLICY_MAP = {
  readonly: {
    liveRunPolicy: "executable-readonly",
    stagingMode: "read-only",
  },
  "safe-interaction": {
    liveRunPolicy: "executable-interaction",
    stagingMode: "interaction",
  },
  "safe-interaction-no-confirm": {
    liveRunPolicy: "judgment-interaction-no-confirm",
    stagingMode: "interaction",
  },
  "mock-judgment": {
    liveRunPolicy: "judgment-mock-api",
    stagingMode: "read-only",
  },
  "subscription-mutation": {
    liveRunPolicy: "blocked-subscription-mutation",
    stagingMode: "interaction",
  },
  "auth-mock": {
    liveRunPolicy: "blocked-auth-mock",
    stagingMode: "auth",
  },
  skip: {
    liveRunPolicy: "blocked-live-skip",
    stagingMode: "live-skip",
  },
};

export function parseAnnotations(source) {
  const pageMatch = source.match(/\/\/\s*@qa-page:\s*(\S+)/);
  const scenarioMatch = source.match(/\/\/\s*@qa-scenario:\s*(\S+)/);
  const liveSkipMatch = /\/\/\s*@qa-live-skip:\s*true/.test(source);
  const alwaysRunMatch = /\/\/\s*@qa-always-run:\s*true/.test(source);

  return {
    page: pageMatch?.[1] ?? null,
    scenario: scenarioMatch?.[1] ?? null,
    liveSkip: liveSkipMatch,
    alwaysRun: alwaysRunMatch,
  };
}

const SCENARIO_LABEL_PATTERN =
  /test\.describe\(\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*,/;

function unescapeString(value) {
  return value.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, "`");
}

export function extractTestBlocks(source) {
  const blocks = [];
  const pattern =
    /test\(\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*,\s*async\s*\(\{[^}]*\}\)\s*=>\s*\{/g;

  for (const match of source.matchAll(pattern)) {
    const title = unescapeString(match[2]);
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let index = bodyStart;

    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }

    blocks.push({
      title,
      body: source.slice(bodyStart, index - 1),
      index: match.index,
    });
  }

  return blocks;
}

const LIVE_POLICY_COMMENT_PATTERN = /^\/\/\s*@qa-live-policy:\s*(\S+)\s*$/;

/** Read the nearest `// @qa-live-policy:` directly above `index` (skips blank and other // lines). */
export function parseLivePolicyBeforeIndex(source, index) {
  const lines = source.slice(0, index).split("\n");
  let policy = null;

  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const trimmed = lines[lineIndex].trim();
    if (trimmed === "") continue;

    const match = trimmed.match(LIVE_POLICY_COMMENT_PATTERN);
    if (match) {
      policy = match[1];
      continue;
    }

    if (trimmed.startsWith("//")) continue;
    break;
  }

  return policy;
}

export function mapLivePolicyAnnotation(annotation) {
  const mapped = QA_LIVE_POLICY_MAP[annotation];
  if (!mapped) {
    throw new Error(
      `Unknown @qa-live-policy: ${annotation}. Use one of: ${Object.keys(QA_LIVE_POLICY_MAP).join(", ")}`
    );
  }
  return mapped;
}

function findDescribeBlocks(source) {
  const blocks = [];
  const pattern = /test\.describe\s*\(/g;

  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const after = source.slice(start);
    const arrow = after.match(/=>\s*\{/);
    if (!arrow) continue;

    const bodyStart = start + arrow.index + arrow[0].length - 1;
    let depth = 1;
    let cursor = bodyStart + 1;

    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      cursor += 1;
    }

    blocks.push({
      start,
      end: cursor,
      policy: parseLivePolicyBeforeIndex(source, start),
    });
  }

  return blocks;
}

/**
 * Resolve live policy for a test: test-level comment wins, else innermost enclosing test.describe.
 */
export function resolveTestLivePolicy(source, testIndex) {
  const direct = parseLivePolicyBeforeIndex(source, testIndex);
  if (direct) {
    return { annotation: direct, ...mapLivePolicyAnnotation(direct) };
  }

  const enclosing = findDescribeBlocks(source)
    .filter(block => block.start < testIndex && testIndex < block.end)
    .sort((left, right) => right.start - left.start);

  const inherited = enclosing.find(block => block.policy)?.policy;
  if (inherited) {
    return { annotation: inherited, ...mapLivePolicyAnnotation(inherited) };
  }

  return null;
}

export function classifyStagingTest(body) {
  if (/toHaveURL\(\s*\/\\\/login/.test(body) || /status:\s*401/.test(body)) {
    return "auth";
  }
  if (/\.click\(/.test(body)) return "interaction";
  if (/open(History|Cancel|Resume)Dialog/.test(body)) return "interaction";
  if (/route\(\s*(["'`])[^"'`]*plans\/subscription\/resume/.test(body)) {
    return "interaction";
  }
  return "read-only";
}

/** True when the test body performs or mocks subscription/billing state changes. */
export function detectSubscriptionMutation(body) {
  if (
    /page\.route\([^)]*(?:subscription\/(?:cancel|resume)|checkout|paddle|billing)/i.test(
      body
    )
  ) {
    return true;
  }

  if (
    /route\.fulfill\(\s*\{[^}]*status:\s*204/i.test(body) &&
    /subscription|resume|cancel|checkout|paddle|billing/i.test(body)
  ) {
    return true;
  }

  // Detect confirm-button click combined with subscription action links.
  // Adapt the button name patterns to match your application's confirm dialogs.
  if (
    /getByRole\(\s*["']button["'][^)]*confirm[^)]*\)\.click\(\)/.test(body) &&
    /open(Resume|Cancel)Dialog|subscription-(resume|cancel)-link|resumeLink|cancelLink/i.test(
      body
    )
  ) {
    return true;
  }

  // Detect clicks on subscription purchase / checkout buttons.
  // Adapt the button name patterns to match your application's subscription flow.
  if (
    /getByRole\(\s*["']button["'][^)]*\)\.click\(\)/.test(body) &&
    /Subscribe|checkout|paddle/i.test(body)
  ) {
    return true;
  }

  return false;
}

/** True when the test relies on Playwright page.route() or mock setup helpers. */
export function detectApiMock(body) {
  return (
    /page\.route\(/.test(body) ||
    /setupDashboardWithCredit|setupDashboardWithMocks|setupDashboard/i.test(
      body
    )
  );
}

/**
 * How a test may run on live staging.
 * - executable-readonly: Hermes verifies parsed expectations on live DOM
 * - executable-interaction: Hermes browse may replay clicks (no billing mutation)
 * - judgment-mock-api: Playwright skips mocks; Hermes judges live equivalent
 * - blocked-*: Hermes skips or manual_review only
 */
export function classifyLiveRunPolicy(body, stagingMode) {
  if (stagingMode === "live-skip") return "blocked-live-skip";
  if (stagingMode === "auth") return "blocked-auth-mock";
  if (stagingMode === "interaction") {
    if (detectSubscriptionMutation(body))
      return "blocked-subscription-mutation";
    if (detectApiMock(body)) return "judgment-mock-api";
    return "executable-interaction";
  }
  if (detectApiMock(body)) return "judgment-mock-api";
  if (stagingMode === "read-only") return "executable-readonly";
  return "blocked-unknown";
}

export function describeLiveRunPolicy(liveRunPolicy) {
  switch (liveRunPolicy) {
    case "executable-interaction":
      return "Hermes may execute on staging (safe interaction — UI only, no subscription/billing mutation; never click a destructive confirm button)";
    case "judgment-interaction-no-confirm":
      return "Playwright E2E runs full test; on live Hermes opens dialog and verifies, closes with Esc only — NEVER clicks a destructive confirm button (avoids accidental cancel/resume)";
    case "judgment-mock-api":
      return "Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking";
    case "blocked-subscription-mutation":
      return "skipped on Playwright; Hermes must not mutate subscription/billing";
    case "blocked-auth-mock":
      return "skipped (requires mocked unauthenticated flow)";
    case "blocked-live-skip":
      return "skipped (@qa-live-skip: true)";
    case "blocked-unknown":
      return "skipped (unclassified staging mode)";
    default:
      return null;
  }
}

function parseLocatorExpression(expression) {
  const testIdMatch = expression.match(
    /page\.getByTestId\(\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*\)/
  );
  if (testIdMatch) {
    return { kind: "testId", value: unescapeString(testIdMatch[2]) };
  }

  const textMatch = expression.match(
    /page\.getByText\(\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*\)/
  );
  if (textMatch) {
    return { kind: "text", value: unescapeString(textMatch[2]) };
  }

  return null;
}

function parseStringLiteral(value) {
  if (value.includes("${")) {
    return { kind: "template", pattern: "^Credit [\\d,]+$" };
  }
  return { kind: "literal", value };
}

export function parseReadOnlyExpectations(body) {
  const expectations = [];
  const chunks = body.split(/await expect\(/).slice(1);

  for (const chunk of chunks) {
    const statement = `await expect(${chunk}`;
    const notVisibleMatch = statement.match(
      /expect\(\s*([\s\S]*?)\s*\)\.not\.toBeVisible/m
    );
    if (notVisibleMatch) {
      const locator = parseLocatorExpression(notVisibleMatch[1]);
      if (locator) expectations.push({ type: "notVisible", locator });
      continue;
    }

    const containTextMatch = statement.match(
      /expect\(\s*([\s\S]*?)\s*\)\.toContainText\(\s*(["'`])((?:\\.|(?!\2).)*?)\2/m
    );
    if (containTextMatch) {
      const locator = parseLocatorExpression(containTextMatch[1]);
      if (locator) {
        expectations.push({
          type: "containText",
          locator,
          expected: parseStringLiteral(unescapeString(containTextMatch[3])),
        });
      }
      continue;
    }

    const visibleMatch = statement.match(
      /expect\(\s*([\s\S]*?)\s*\)\.toBeVisible/m
    );
    if (visibleMatch) {
      const locator = parseLocatorExpression(visibleMatch[1]);
      if (locator) expectations.push({ type: "visible", locator });
    }
  }

  return expectations;
}

const CREDIT_REMAINING_LIVE_PATTERN = "^Credit [\\d,]+$";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDigit(value) {
  return /\d/.test(value);
}

export function liveRegexFromLiteral(value) {
  return value
    .split(/(\d[\d,]*)/g)
    .map(part => {
      if (/^\d[\d,]*$/.test(part)) return "[\\d,]+";
      return escapeRegex(part);
    })
    .join("");
}

export function literalExpectedForLive(value) {
  if (value.includes("${")) {
    return {
      kind: "regex",
      pattern: CREDIT_REMAINING_LIVE_PATTERN,
      liveNote: "mock template value; live uses numeric wildcard matching",
    };
  }

  if (!hasDigit(value)) {
    return { kind: "literal", value };
  }

  return {
    kind: "regex",
    pattern: liveRegexFromLiteral(value),
    liveNote: "mock numeric fixture; live uses digit wildcard matching",
  };
}

export function liveTextLocatorForLive(value) {
  // Adapt this regex to match your app's username/plan label copy pattern.
  if (/user is on .* plan/.test(value)) {
    return {
      kind: "text",
      value: { kind: "regex", pattern: "plan" },
      liveNote: "mock username/plan label; live only checks plan title copy",
    };
  }

  if (!hasDigit(value)) {
    return { kind: "text", value };
  }

  return {
    kind: "text",
    value: { kind: "regex", pattern: liveRegexFromLiteral(value) },
    liveNote: "mock numeric text; live uses digit wildcard matching",
  };
}

export function adaptExpectationForLive(expectation, _testTitle, scenarioId) {
  if (expectation.type === "containText" && expectation.expected) {
    if (expectation.expected.kind === "literal") {
      const adapted = literalExpectedForLive(expectation.expected.value);
      if (adapted.kind === "regex") {
        return {
          ...expectation,
          expected: {
            kind: "regex",
            pattern: adapted.pattern,
          },
          liveNote: adapted.liveNote,
        };
      }
    }

    if (expectation.expected.kind === "template") {
      return {
        ...expectation,
        expected: { kind: "regex", pattern: CREDIT_REMAINING_LIVE_PATTERN },
        liveNote: "mock dynamic credit; live uses numeric wildcard matching",
      };
    }
  }

  if (
    expectation.type === "visible" &&
    expectation.locator.kind === "text" &&
    typeof expectation.locator.value === "string"
  ) {
    const adaptedLocator = liveTextLocatorForLive(expectation.locator.value);
    if (adaptedLocator.liveNote) {
      return {
        ...expectation,
        locator: {
          kind: adaptedLocator.kind,
          value: adaptedLocator.value,
        },
        liveNote: adaptedLocator.liveNote,
      };
    }
  }

  return expectation;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export function parseDashboardSpecFile(fileName, source) {
  const annotations = parseAnnotations(source);
  const scenarioId = annotations.scenario;
  if (!scenarioId) return null;

  const labelMatch = source.match(SCENARIO_LABEL_PATTERN);
  const label = labelMatch ? unescapeString(labelMatch[2]) : fileName;

  const tests = extractTestBlocks(source).map(block => {
    // Whole-file @qa-live-skip marks every test as liveSkip.
    if (annotations.liveSkip) {
      return {
        title: block.title,
        stagingMode: "live-skip",
        liveRunPolicy: "blocked-live-skip",
        expectations: [],
        checkId: slugify(block.title) || "unnamed-test",
      };
    }

    const declared = resolveTestLivePolicy(source, block.index);
    if (!declared) {
      throw new Error(
        `Missing // @qa-live-policy on test "${block.title}" in ${fileName}. ` +
          `Add it on the test or an enclosing test.describe.`
      );
    }

    const {
      stagingMode,
      liveRunPolicy,
      annotation: livePolicyAnnotation,
    } = declared;
    const expectations =
      stagingMode === "read-only"
        ? parseReadOnlyExpectations(block.body).map(expectation =>
            adaptExpectationForLive(expectation, block.title, scenarioId)
          )
        : [];

    return {
      title: block.title,
      stagingMode,
      liveRunPolicy,
      livePolicyAnnotation,
      expectations,
      checkId: slugify(block.title) || "unnamed-test",
    };
  });

  return {
    scenarioId,
    page: annotations.page ?? null,
    liveSkip: annotations.liveSkip,
    alwaysRun: annotations.alwaysRun,
    sourceFile: fileName,
    label,
    tests,
  };
}

/** Parse all annotated spec files in a directory. Requires @qa-scenario. */
export function parseSpecDirectory(specDir) {
  const files = readdirSync(specDir)
    .filter(file => file.endsWith(".spec.ts"))
    .sort();

  const scenarios = files
    .map(file => {
      const source = readFileSync(join(specDir, file), "utf8");
      return parseDashboardSpecFile(file, source);
    })
    .filter(Boolean);

  return {
    generatedAt: new Date().toISOString(),
    sourceDirectory: specDir,
    scenarios,
  };
}

export function selectScenariosForLiveRun(spec, scenarioId) {
  const primary = spec.scenarios.find(item => item.scenarioId === scenarioId);
  const alwaysRun = listAlwaysRunScenarios(spec).filter(
    scenario => scenario.scenarioId !== scenarioId
  );
  if (!primary) return alwaysRun;
  return [primary, ...alwaysRun];
}

export function listAlwaysRunScenarios(spec) {
  return spec.scenarios.filter(
    scenario => scenario.alwaysRun && !scenario.liveSkip
  );
}

/** Flat checklist for Hermes browse — includes always-run scenarios regardless of plan. */
export function buildBrowseChecklist(spec) {
  const alwaysRunIds = new Set(
    listAlwaysRunScenarios(spec).map(scenario => scenario.scenarioId)
  );

  return spec.scenarios
    .filter(scenario => !scenario.liveSkip)
    .flatMap(scenario =>
      scenario.tests.map(test => ({
        scenarioId: scenario.scenarioId,
        alwaysRun: alwaysRunIds.has(scenario.scenarioId),
        title: test.title,
        liveRunPolicy: test.liveRunPolicy,
        stagingMode: test.stagingMode,
      }))
    );
}

export function flattenExecutableTests(scenarios, scenarioId) {
  const executable = [];

  for (const scenario of scenarios) {
    for (const test of scenario.tests) {
      if (
        test.liveRunPolicy !== "executable-readonly" ||
        test.stagingMode !== "read-only" ||
        test.expectations.length === 0
      ) {
        continue;
      }

      for (const [index, expectation] of test.expectations.entries()) {
        if (expectation.liveSkip) continue;
        if (
          Array.isArray(expectation.runWhenScenario) &&
          !expectation.runWhenScenario.includes(scenarioId)
        ) {
          continue;
        }

        executable.push({
          scenarioId: scenario.scenarioId,
          sourceFile: scenario.sourceFile,
          testTitle: test.title,
          checkId: `${scenario.scenarioId}:${test.checkId}:${index}`,
          expectation,
        });
      }
    }
  }

  return executable;
}

/** Per-scenario counts for qa:spec console summary and tooling. */
export function summarizeScenarioCoverage(spec, scenarioId) {
  const scenario = spec.scenarios.find(item => item.scenarioId === scenarioId);
  if (!scenario) {
    return {
      testCount: 0,
      playwrightExpectations: 0,
      testsByPolicy: {},
    };
  }

  const playwrightExpectations = flattenExecutableTests(
    [scenario],
    scenarioId
  ).length;
  const testsByPolicy = {};

  for (const test of scenario.tests) {
    testsByPolicy[test.liveRunPolicy] =
      (testsByPolicy[test.liveRunPolicy] ?? 0) + 1;
  }

  return {
    testCount: scenario.tests.length,
    playwrightExpectations,
    testsByPolicy,
  };
}

export function formatScenarioCoverageSummary(spec, scenarioId) {
  const scenario = spec.scenarios.find(item => item.scenarioId === scenarioId);
  if (scenario?.liveSkip) {
    return `${scenarioId}: skipped (@qa-live-skip)`;
  }

  const { testCount, playwrightExpectations, testsByPolicy } =
    summarizeScenarioCoverage(spec, scenarioId);
  const parts = [`${testCount} test(s)`];

  if (playwrightExpectations > 0) {
    parts.push(`playwright: ${playwrightExpectations} expectation(s)`);
  }

  for (const [policy, count] of Object.entries(testsByPolicy).sort()) {
    if (policy === "executable-readonly") continue;
    parts.push(`${policy}: ${count}`);
  }

  return `${scenarioId}: ${parts.join(", ")}`;
}
