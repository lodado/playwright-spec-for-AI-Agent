import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as projectConfig from "./hermes-qa-project-config.mjs";
import { UsageError } from "./errors.mjs";

/**
 * Reads QA annotations out of Playwright spec files.
 *
 * This module deliberately does NOT interpret assertions. It answers only the
 * questions the pipeline actually needs to route a test — which page, which
 * scenario, which live policy, which fixtures — and leaves the meaning of the
 * test body to the agent that reads the source. An earlier version parsed
 * `expect(...)` chains into a structured `expectations` array; it was deleted
 * because it could only name the matchers it happened to support, so every
 * unsupported assertion silently narrowed the plan, and every Playwright
 * release threatened to widen that gap.
 *
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
 * Extra policy names may be aliased onto an existing liveRunPolicy through the
 * `livePolicies` config block (see getLivePolicyOverrides).
 *
 * Policy meanings:
 *   readonly — DOM-only checks; no interaction needed on live
 *   safe-interaction — safe UI actions that still require live test replay to verify
 *   safe-interaction-no-confirm — verification would be dangerous on live; mock may click confirm, Hermes must not
 */
/**
 * Stamped into the spec artifact's source hash so a change in how annotations
 * are read invalidates cached plans. Bumped to 2.0.0 when the assertion parser
 * was removed: artifacts from 1.x carry `expectations` fields that no longer
 * exist, and must not be reused.
 */
export const SPEC_READER_VERSION = "2.0.0";

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

// Anchored to a whole comment line, mirroring listAnnotatedSpecFiles in
// ./page-qa-paths.mjs: documentation that quotes an annotation
// ("// @qa-live-skip: true on a file means Hermes skips it") must not activate it.
const PAGE_LINE = /^[ \t]*\/\/[ \t]*@qa-page:[ \t]*(\S+)/m;
const SCENARIO_LINE = /^[ \t]*\/\/[ \t]*@qa-scenario:[ \t]*(\S+)/m;
const LIVE_SKIP_LINE = /^[ \t]*\/\/[ \t]*@qa-live-skip:[ \t]*true[ \t]*\r?$/m;
const ALWAYS_RUN_LINE = /^[ \t]*\/\/[ \t]*@qa-always-run:[ \t]*true[ \t]*\r?$/m;

export function parseAnnotations(source) {
  const pageMatch = source.match(PAGE_LINE);
  const scenarioMatch = source.match(SCENARIO_LINE);

  return {
    page: pageMatch?.[1] ?? null,
    scenario: scenarioMatch?.[1] ?? null,
    liveSkip: LIVE_SKIP_LINE.test(source),
    alwaysRun: ALWAYS_RUN_LINE.test(source),
  };
}

const SCENARIO_LABEL_PATTERN =
  /test\.describe\(\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*,/;

function unescapeString(value) {
  return value.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, "`");
}

function skipQuoted(source, index) {
  const quote = source[index];
  let cursor = index + 1;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor += 1;
  }

  return source.length;
}

function skipRegexLiteral(source, index) {
  let cursor = index + 1;
  let inCharClass = false;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "\n") return index + 1;
    if (char === "[") inCharClass = true;
    else if (char === "]") inCharClass = false;
    else if (char === "/" && !inCharClass) return cursor + 1;
    cursor += 1;
  }

  return source.length;
}

// A `/` opens a regex only when the previous meaningful character cannot end an
// expression. Heuristic: `return /re/` reads as division, and a `${...}` hole
// inside a template literal is skipped whole, so a backtick nested in a hole
// ends the template early. Both are fine for locating block boundaries.
const REGEX_START_AFTER = /[({[,;=:!&|?+\-*%^~<>]/;

/**
 * Index of the `}` closing the block whose body starts at `bodyStart`, skipping
 * strings, template literals, comments, and regex literals so a body containing
 * `"}"` in a literal is not truncated.
 */
function findBlockEnd(source, bodyStart) {
  let depth = 1;
  let cursor = bodyStart;
  let previous = "";

  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];

    if (char === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", cursor);
      cursor = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", cursor + 2);
      cursor = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      cursor = skipQuoted(source, cursor);
      previous = char;
      continue;
    }
    if (char === "/" && (previous === "" || REGEX_START_AFTER.test(previous))) {
      cursor = skipRegexLiteral(source, cursor);
      previous = "/";
      continue;
    }

    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }

    if (!/\s/.test(char)) previous = char;
    cursor += 1;
  }

  return source.length;
}

// Accepts `test`, `test.only`, `test.skip`, `test.fixme`; any quote style; an
// empty, named, or destructured argument list (optionally with `testInfo`); and
// whitespace or newlines anywhere inside the signature.
const TEST_BLOCK_PATTERN =
  /\btest(?:\s*\.\s*(?:only|skip|fixme))?\s*\(\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*,\s*(?:\{[\s\S]*?\}\s*,\s*)?(?:async\s*)?(?:function\s*\*?\s*)?\(\s*(?:\{[\s\S]*?\}|[A-Za-z_$][\w$]*)?\s*(?:,[^)]*)?\)\s*(?:=>\s*)?\{/g;

// Loose enough to spot a declaration TEST_BLOCK_PATTERN failed to parse, strict
// enough to ignore hooks (`test.beforeEach`) and in-body modifiers (`test.skip(cond)`).
const LOOSE_TEST_CALL_PATTERN =
  /\btest(?:\s*\.\s*([A-Za-z_$][\w$]*)\s*)?\(\s*["'`]/g;
const TEST_DECLARATION_MODIFIERS = new Set(["only", "skip", "fixme"]);

/**
 * Locate each `test(...)` declaration and its body. The body is carried through
 * verbatim for the agent to read; nothing here interprets it.
 */
export function extractTestBlocks(source) {
  const blocks = [];

  for (const match of source.matchAll(TEST_BLOCK_PATTERN)) {
    const bodyStart = match.index + match[0].length;
    blocks.push({
      title: unescapeString(match[2]),
      body: source.slice(bodyStart, findBlockEnd(source, bodyStart)),
      bodyStart,
      index: match.index,
    });
  }

  return blocks;
}

/** Test declarations that produced no block — a silent drop is a coverage hole. */
export function countUnparsedTests(source, blocks = extractTestBlocks(source)) {
  const parsedIndexes = new Set(blocks.map(block => block.index));
  let unparsed = 0;

  for (const match of source.matchAll(LOOSE_TEST_CALL_PATTERN)) {
    const modifier = match[1];
    if (modifier && !TEST_DECLARATION_MODIFIERS.has(modifier)) continue;
    if (parsedIndexes.has(match.index)) continue;
    unparsed += 1;
  }

  return unparsed;
}

// Trailing `// note` prose and trailing whitespace/CR are tolerated; the
// annotation itself must still start the line.
const LIVE_POLICY_COMMENT_PATTERN =
  /^[ \t]*\/\/[ \t]*@qa-live-policy:[ \t]*(\S+)[ \t]*(?:\/\/.*)?\r?$/;
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

const BUILT_IN_LIVE_RUN_POLICIES = Object.values(QA_LIVE_POLICY_MAP).map(
  entry => entry.liveRunPolicy
);

/** Project config may alias extra annotation names onto an existing verb. */
function configuredLivePolicies() {
  try {
    return projectConfig.getLivePolicyOverrides?.() ?? {};
  } catch {
    return {};
  }
}

export function mapLivePolicyAnnotation(annotation) {
  const configured = configuredLivePolicies();

  if (Object.hasOwn(configured, annotation)) {
    const { liveRunPolicy, stagingMode } = configured[annotation];
    if (!BUILT_IN_LIVE_RUN_POLICIES.includes(liveRunPolicy)) {
      throw new UsageError(
        `Configured @qa-live-policy "${annotation}" maps to unknown liveRunPolicy "${liveRunPolicy}".`,
        {
          hint: `A custom policy must reuse one of: ${BUILT_IN_LIVE_RUN_POLICIES.join(", ")}`,
        }
      );
    }
    return {
      liveRunPolicy,
      stagingMode:
        stagingMode ??
        Object.values(QA_LIVE_POLICY_MAP).find(
          entry => entry.liveRunPolicy === liveRunPolicy
        )?.stagingMode,
    };
  }

  if (!Object.hasOwn(QA_LIVE_POLICY_MAP, annotation)) {
    const custom = Object.keys(configured);
    throw new UsageError(
      `Unknown @qa-live-policy: ${annotation}. Use one of: ${Object.keys(QA_LIVE_POLICY_MAP).join(", ")}` +
        (custom.length > 0
          ? `; or a configured custom policy: ${custom.join(", ")}`
          : "")
    );
  }

  return QA_LIVE_POLICY_MAP[annotation];
}

function findDescribeBlocks(source) {
  const blocks = [];
  const pattern = /test\.describe\s*\(/g;

  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const after = source.slice(start);
    const arrow = after.match(/=>\s*\{/);
    if (!arrow) continue;

    const bodyStart = start + arrow.index + arrow[0].length;

    blocks.push({
      start,
      end: findBlockEnd(source, bodyStart) + 1,
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

/**
 * How a test may run on live staging.
 * - executable-readonly: agent verifies the test's assertions against live DOM
 * - executable-interaction: safe actions that need live replay (no billing mutation)
 * - judgment-mock-api: Playwright mocks are not replayable; agent judges live equivalent
 * - blocked-*: agent skips or manual_review only
 *
 * The value comes from the declared `@qa-live-policy` and nothing else. It used
 * to be inferred by grepping the body for `.click(` and billing-ish route
 * patterns; that guessing was removed, because a safety decision that depends
 * on a regex noticing the right substring fails open on the cases that matter.
 */
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

/**
 * `checkId` keys per-test upload fixtures, so it has to survive a non-Latin
 * title: stripping to `[a-z0-9]` collapsed every Korean or Japanese title to
 * the same `unnamed-test`, and two such tests in one file then shared one
 * fixture entry. Unicode letters and digits are kept as-is.
 */
function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export function parseSpecFile(fileName, source) {
  const annotations = parseAnnotations(source);
  const scenarioId = annotations.scenario;
  if (!scenarioId) return null;

  const labelMatch = source.match(SCENARIO_LABEL_PATTERN);
  const label = labelMatch ? unescapeString(labelMatch[2]) : fileName;
  const fileFixtures = parseFileFixtures(source);

  const blocks = extractTestBlocks(source);
  const unparsedTestCount = countUnparsedTests(source, blocks);
  if (unparsedTestCount > 0) {
    console.warn(
      `[qa-spec] ${fileName}: ${unparsedTestCount} test(s) could not be read and are missing from the QA spec.`
    );
  }

  const tests = blocks.map(block => {
    // Whole-file @qa-live-skip marks every test as liveSkip.
    if (annotations.liveSkip) {
      return {
        title: block.title,
        stagingMode: "live-skip",
        liveRunPolicy: "blocked-live-skip",
        checkId: slugify(block.title) || "unnamed-test",
      };
    }

    const declared = resolveTestLivePolicy(source, block.index);
    if (!declared) {
      const line = source.slice(0, block.index).split("\n").length;
      throw new UsageError(
        `Missing // @qa-live-policy on test "${block.title}" (${fileName}:${line}).`,
        {
          hint: "Add it on the test or an enclosing test.describe, e.g. `// @qa-live-policy: readonly`.",
        }
      );
    }

    const {
      stagingMode,
      liveRunPolicy,
      annotation: livePolicyAnnotation,
    } = declared;

    const fixtures = resolveTestFixtures(source, block.index, fileFixtures);

    return {
      title: block.title,
      stagingMode,
      liveRunPolicy,
      livePolicyAnnotation,
      ...(Object.keys(fixtures).length > 0 ? { fixtures } : {}),
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
    ...(Object.keys(fileFixtures).length > 0 ? { fixtures: fileFixtures } : {}),
    ...(unparsedTestCount > 0 ? { unparsedTestCount } : {}),
    tests,
  };
}

/** Read all annotated spec files in a directory. Requires @qa-scenario. */
export function parseSpecDirectory(specDir) {
  const files = readdirSync(specDir)
    .filter(file => file.endsWith(".spec.ts"))
    .sort();

  const scenarios = files
    .map(file => {
      const source = readFileSync(join(specDir, file), "utf8");
      return parseSpecFile(file, source);
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

/** Per-scenario counts for qa:spec console summary and tooling. */
export function summarizeScenarioCoverage(spec, scenarioId) {
  const scenario = spec.scenarios.find(item => item.scenarioId === scenarioId);
  if (!scenario) {
    return { testCount: 0, testsByPolicy: {} };
  }

  const testsByPolicy = {};

  for (const test of scenario.tests) {
    testsByPolicy[test.liveRunPolicy] =
      (testsByPolicy[test.liveRunPolicy] ?? 0) + 1;
  }

  return {
    testCount: scenario.tests.length,
    testsByPolicy,
  };
}

export function formatScenarioCoverageSummary(spec, scenarioId) {
  const scenario = spec.scenarios.find(item => item.scenarioId === scenarioId);
  if (scenario?.liveSkip) {
    return `${scenarioId}: skipped (@qa-live-skip)`;
  }

  const { testCount, testsByPolicy } = summarizeScenarioCoverage(
    spec,
    scenarioId
  );
  const parts = [`${testCount} test(s)`];

  for (const [policy, count] of Object.entries(testsByPolicy).sort()) {
    parts.push(`${policy}: ${count}`);
  }

  return `${scenarioId}: ${parts.join(", ")}`;
}
