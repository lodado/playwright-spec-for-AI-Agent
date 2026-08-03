import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePlaywrightAst } from "./ast-parser.mjs";

/**
 * Extract QA annotations from spec file source.
 * Supported file-level annotations:
 *   // @qa-page: dashboard
 *   // @qa-scenario: ACTIVE
 *   // @qa-live-skip: true
 *   // @qa-always-run: true
 *
 * Upload fixtures for live file-input replay (optional):
 *   // @qa-fixture: avatar=tests/fixtures/qa-avatar.png
 *   Paths are repo-relative; override per test, describe, file, or hermes-qa.config.
 *   // @qa-live-policy: readonly | safe-interaction | safe-interaction-no-confirm | mock-judgment | subscription-mutation | auth-mock | skip
 *
 * Policy meanings:
 *   readonly — DOM-only checks; no interaction needed on live
 *   safe-interaction — safe UI actions that still require live test replay to verify
 *   safe-interaction-no-confirm — verification would be dangerous on live; mock may click confirm, Hermes must not
 */
export const QA_LIVE_POLICY_MAP = {
  readonly: {
    liveRunPolicy: "executable-readonly",
    stagingMode: "read-only",
  },
  /** Safe actions that need live test replay — not verifiable from static DOM alone. */
  "safe-interaction": {
    liveRunPolicy: "executable-interaction",
    stagingMode: "interaction",
  },
  /** Verification would be dangerous on live (e.g. confirm mutates state). */
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
  const pageMatch = source.match(/\/\/\s*@qa-page:\s*([^\r\n]+)/);
  const scenarioMatch = source.match(/\/\/\s*@qa-scenario:\s*([^\r\n]+)/);
  const liveSkipMatch = /\/\/\s*@qa-live-skip:\s*true/.test(source);
  const alwaysRunMatch = /\/\/\s*@qa-always-run:\s*true/.test(source);

  return {
    page: pageMatch?.[1].trim() ?? null,
    scenario: scenarioMatch?.[1].trim() ?? null,
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
  return parsePlaywrightAst("inline.spec.ts", source).tests;
}

const LIVE_POLICY_COMMENT_PATTERN = /^\/\/\s*@qa-live-policy:\s*(\S+)\s*$/;
const FIXTURE_COMMENT_PATTERN =
  /^\/\/\s*@qa-fixture:\s*([A-Za-z0-9_-]+)\s*=\s*(.+)\s*$/;

function unquoteFixturePath(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse a single `// @qa-fixture: name=path` comment line. */
export function parseFixtureFromCommentLine(line) {
  const match = line.match(FIXTURE_COMMENT_PATTERN);
  if (!match) return null;
  return { name: match[1], path: unquoteFixturePath(match[2]) };
}

/** Collect `@qa-fixture` lines directly above `index` (closest wins per name). */
export function parseFixturesBeforeIndex(source, index) {
  const fixtures = {};
  const lines = source.slice(0, index).split("\n");

  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const trimmed = lines[lineIndex].trim();
    if (trimmed === "") continue;

    const parsed = parseFixtureFromCommentLine(trimmed);
    if (parsed) {
      if (!(parsed.name in fixtures)) {
        fixtures[parsed.name] = parsed.path;
      }
      continue;
    }

    if (trimmed.startsWith("//")) continue;
    break;
  }

  return fixtures;
}

/** File-level fixtures from header comments before the first test block. */
export function parseFileFixtures(source) {
  const firstTest = source.search(/\btest(?:\.describe)?\s*\(/);
  const header = firstTest === -1 ? source : source.slice(0, firstTest);
  const fixtures = {};

  for (const line of header.split("\n")) {
    const parsed = parseFixtureFromCommentLine(line.trim());
    if (parsed) fixtures[parsed.name] = parsed.path;
  }

  return fixtures;
}

/**
 * Merge file → enclosing describe(s) → test fixtures.
 * Inner describe and test override outer defaults.
 */
export function resolveTestFixtures(source, testIndex, fileFixtures = {}) {
  const merged = { ...fileFixtures };

  const enclosing = findDescribeBlocks(source)
    .filter(block => block.start < testIndex && testIndex < block.end)
    .sort((left, right) => left.start - right.start);

  for (const block of enclosing) {
    Object.assign(merged, parseFixturesBeforeIndex(source, block.start));
  }

  Object.assign(merged, parseFixturesBeforeIndex(source, testIndex));
  return merged;
}

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
  return parsePlaywrightAst("inline.spec.ts", source).describes.map(block => ({
    ...block,
    policy: parseLivePolicyBeforeIndex(source, block.start),
  }));
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
 * - executable-interaction: safe actions that need live test replay to verify (no billing mutation)
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
      return "Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)";
    case "judgment-interaction-no-confirm":
      return "UI action where completing verification would be dangerous on live — Hermes replays safe open steps, verifies up to the dangerous point, dismisses with Esc only (never clicks confirm)";
    case "judgment-mock-api":
      return "CI uses API mocks (not replayable on live); Hermes passes if live UI reasonably matches intent, manual_review if ambiguous";
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

export function parseReadOnlyExpectations(body) {
  const wrapped = `test("inline", async ({ page }) => {${body}\n});`;
  return parsePlaywrightAst("inline.spec.ts", wrapped).tests[0]?.expectations ?? [];
}

import {
  adaptExpectationForLive,
  liveRegexFromLiteral,
  literalExpectedForLive,
  liveTextLocatorForLive,
} from "./expectation-abstractor.mjs";

export {
  adaptExpectationForLive,
  liveRegexFromLiteral,
  literalExpectedForLive,
  liveTextLocatorForLive,
};

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Attach `testIndex` to an AST diagnostic by locating the test block whose source range
 * contains the diagnostic's `offset`. Diagnostics outside any test (e.g. a file-level parse
 * error) keep no `testIndex` and remain file-level. `tests` is ordered by `index`.
 */
function attributeDiagnosticToTest(item, tests) {
  const { offset, ...rest } = item;
  if (typeof offset !== "number" || typeof rest.testIndex === "number") return rest;
  const testIndex = tests.findIndex(test => offset >= test.index && offset < test.endIndex);
  return testIndex === -1 ? rest : { ...rest, testIndex };
}

export function parsePlaywrightSource(fileName, source) {
  const ast = parsePlaywrightAst(fileName, source);
  const headerEnd = ast.sourceFile.statements[0]?.getStart(ast.sourceFile) ?? source.length;
  const header = source.slice(0, headerEnd);
  const annotations = parseAnnotations(header);
  const scenarioId = annotations.scenario;
  // AST diagnostics carry a raw source `offset` but no owning test. Attribute each to the test
  // whose [index, endIndex) range contains it so authority errors retain a precise source owner.
  const diagnostics = ast.diagnostics.map(item => attributeDiagnosticToTest(item, ast.tests));
  if (!scenarioId) return { scenario: null, blocks: ast.tests, diagnostics, annotations };

  const scenarioLabelMatch = header.match(/\/\/\s*@qa-scenario-label:\s*([^\r\n]+)/);
  const labelMatch = source.match(SCENARIO_LABEL_PATTERN);
  const label = scenarioLabelMatch
    ? scenarioLabelMatch[1].trim().replace(/^(["'])(.*)\1$/, "$2")
    : ast.describes[0]?.title ?? (labelMatch ? unescapeString(labelMatch[2]) : fileName);
  const fileFixtures = parseFileFixtures(source);

  const tests = ast.tests.map((block, testIndex) => {
    const inheritedModifier = [...block.describes]
      .reverse()
      .find(describe => ["skip", "fixme"].includes(describe.modifier))?.modifier;
    const modifier = block.modifier ?? inheritedModifier ?? null;

    // Whole-file @qa-live-skip marks every test as liveSkip.
    if (annotations.liveSkip || modifier === "skip" || modifier === "fixme") {
      return {
        title: block.title,
        stagingMode: "live-skip",
        liveRunPolicy: "blocked-live-skip",
        ...(modifier ? { modifier } : {}),
        expectations: [],
        checkId: slugify(block.title) || "unnamed-test",
      };
    }

    let declared;
    let policyError = false;
    try {
      const direct = parseLivePolicyBeforeIndex(source, block.index);
      const inherited = [...block.describes]
        .reverse()
        .map(describe => parseLivePolicyBeforeIndex(source, describe.start))
        .find(Boolean);
      const annotation = direct ?? inherited;
      declared = annotation
        ? { annotation, ...mapLivePolicyAnnotation(annotation) }
        : null;
    } catch (error) {
      policyError = true;
      diagnostics.push({
        code: "UNKNOWN_LIVE_POLICY",
        testIndex,
        severity: "ERROR",
        message: error.message,
        path: fileName,
      });
      declared = null;
    }
    if (!declared) {
      if (!policyError) {
        diagnostics.push({
          code: "MISSING_LIVE_POLICY",
        testIndex,
          severity: "ERROR",
          message: `Missing // @qa-live-policy on test "${block.title}" in ${fileName}. Add it on the test or an enclosing test.describe.`,
          path: fileName,
        });
      }
      return {
        title: block.title,
        stagingMode: "live-skip",
        liveRunPolicy: "blocked-unknown",
        expectations: [],
        checkId: slugify(block.title) || "unnamed-test",
      };
    }

    const {
      stagingMode,
      liveRunPolicy,
      annotation: livePolicyAnnotation,
    } = declared;
    const expectations = block.expectations.map(expectation =>
      adaptExpectationForLive(expectation, block.title, scenarioId)
    );
    const actions = block.actions;
    if (stagingMode === "read-only" && actions.length > 0) {
      diagnostics.push({
        code: "POLICY_ACTION_CONFLICT",
        testIndex,
        severity: "ERROR",
        message: `readonly test "${block.title}" contains browser actions.`,
        path: fileName,
      });
    }
    if (liveRunPolicy === "executable-interaction" && block.opaqueCalls.length > 0) {
      diagnostics.push({
        code: "OPAQUE_INTERACTION_STEP",
        testIndex,
        severity: "ERROR",
        message: `safe-interaction test "${block.title}" contains steps that cannot be statically compiled: ${block.opaqueCalls.join("; ")}`,
        path: fileName,
      });
    }
    if (
      !liveRunPolicy.startsWith("blocked-") &&
      JSON.stringify({ actions, expectations }).includes('"kind":"dynamic"')
    ) {
      diagnostics.push({
        code: "DYNAMIC_EXECUTION_VALUE",
        testIndex,
        severity: "ERROR",
        message: `live test "${block.title}" contains a locator or action value that cannot be resolved statically.`,
        path: fileName,
      });
    }

    const fixtures = resolveTestFixtures(source, block.index, fileFixtures);

    return {
      title: block.title,
      stagingMode,
      liveRunPolicy,
      livePolicyAnnotation,
      ...(modifier ? { modifier } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      expectations,
      ...(Object.keys(fixtures).length > 0 ? { fixtures } : {}),
      checkId: slugify(block.title) || "unnamed-test",
    };
  });

  for (const describe of ast.describes.filter(item => item.modifier === "only")) {
    diagnostics.push({
      code: "FOCUSED_TEST",
      severity: "WARNING",
      message: "test.describe.only is imported without filtering sibling tests.",
      path: fileName,
    });
  }

  const scenario = {
    scenarioId,
    page: annotations.page ?? null,
    liveSkip: annotations.liveSkip,
    alwaysRun: annotations.alwaysRun,
    sourceFile: fileName,
    label,
    ...(Object.keys(fileFixtures).length > 0 ? { fixtures: fileFixtures } : {}),
    tests,
  };

  return { scenario, blocks: ast.tests, diagnostics, annotations };
}

export function parseDashboardSpecFile(fileName, source) {
  const result = parsePlaywrightSource(fileName, source);
  const error = result.diagnostics.find(item => item.severity === "ERROR");
  if (error) throw new Error(error.message);
  return result.scenario;
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
