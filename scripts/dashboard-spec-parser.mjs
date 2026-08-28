import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as projectConfig from "./hermes-qa-project-config.mjs";
import { UsageError } from "./errors.mjs";

/**
 * Extract QA annotations from spec file source.
 * Every annotation must start its own comment line — prose that merely mentions
 * one is documentation, not an annotation.
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
// ends the template early. Both are fine for spec bodies, not for a JS parser.
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

  const roleMatch = expression.match(
    /page\.getByRole\(\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/
  );
  if (roleMatch) {
    const nameMatch = roleMatch[3]?.match(
      /\bname\s*:\s*(["'`])((?:\\.|(?!\1).)*?)\1/
    );
    return {
      kind: "role",
      value: unescapeString(roleMatch[2]),
      ...(nameMatch
        ? { name: parseStringLiteral(unescapeString(nameMatch[2])) }
        : {}),
    };
  }

  for (const [method, kind] of [
    ["getByLabel", "label"],
    ["getByPlaceholder", "placeholder"],
    ["getByAltText", "altText"],
    ["getByTitle", "title"],
    ["locator", "css"],
  ]) {
    const match = expression.match(
      new RegExp(`page\\.${method}\\(\\s*(["'\\x60])((?:\\\\.|(?!\\1).)*?)\\1\\s*\\)`)
    );
    if (match) return { kind, value: unescapeString(match[2]) };
  }

  return null;
}

/**
 * A `${...}` hole is mock-run data, so keep the shape (the static copy around
 * it) and wildcard the interpolation rather than pinning any app's word.
 */
function parseStringLiteral(value) {
  if (!value.includes("${")) return { kind: "literal", value };

  const shape = value
    .split(/\$\{[^}]*\}/g)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");

  return { kind: "template", pattern: `^${shape}$` };
}

function parseStaticExpected(value) {
  const trimmed = value.trim();
  const stringMatch = trimmed.match(/^(["'`])((?:\\.|(?!\1).)*)\1$/s);
  if (stringMatch) return parseStringLiteral(unescapeString(stringMatch[2]));
  const regexMatch = trimmed.match(/^\/((?:\\.|[^/])*)\/([dgimsuvy]*)$/s);
  if (regexMatch) {
    return { kind: "regex", pattern: regexMatch[1], flags: regexMatch[2] };
  }
  return null;
}

export function parseReadOnlyExpectations(body) {
  const expectations = [];
  const chunks = body.split(/await expect\(/).slice(1);

  for (const chunk of chunks) {
    const statement = `await expect(${chunk}`;
    const targetMatch = statement.match(
      /expect\(\s*([\s\S]*?)\s*\)\s*\.\s*(not\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\)/m
    );
    if (!targetMatch) continue;
    const locator = parseLocatorExpression(targetMatch[1]);
    if (!locator) continue;
    const negated = Boolean(targetMatch[2]);
    const matcher = targetMatch[3];
    const argument = targetMatch[4];

    if (matcher === "toBeHidden" || (matcher === "toBeVisible" && negated)) {
      expectations.push({ type: "notVisible", locator });
      continue;
    }
    if (matcher === "toBeVisible") {
      expectations.push({ type: "visible", locator });
      continue;
    }
    if (matcher === "toContainText" || matcher === "toHaveText") {
      const expected = parseStaticExpected(argument);
      if (expected) {
        expectations.push({
          type: matcher === "toContainText" ? "containText" : "haveText",
          locator,
          expected,
          ...(negated ? { negated: true } : {}),
        });
      }
      continue;
    }
    if (matcher === "toHaveCount") {
      const expected = Number(argument.trim());
      if (Number.isInteger(expected)) expectations.push({ type: "count", locator, expected });
      continue;
    }
    if (matcher === "toHaveValue") {
      const expected = parseStaticExpected(argument);
      if (expected) expectations.push({ type: "value", locator, expected });
      continue;
    }
    const stateTypes = {
      toBeEnabled: "enabled",
      toBeDisabled: "disabled",
      toBeChecked: "checked",
      toBeEditable: "editable",
      toBeEmpty: "empty",
      toBeFocused: "focused",
      toBeAttached: "attached",
      toBeInViewport: "inViewport",
    };
    if (stateTypes[matcher]) {
      expectations.push({ type: stateTypes[matcher], locator, ...(negated ? { negated: true } : {}) });
      continue;
    }

    /* Legacy fallbacks below remain during artifact migration. */
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

function sourceLocation(source, index, fileName) {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return {
    file: fileName,
    line: lines.length,
    column: lines.at(-1).length + 1,
  };
}

/** Account for every static `await expect(...)` candidate, including unsupported ones. */
export function analyzeReadOnlyExpectations(
  body,
  { fileName = "<source>", sourceOffset = 0, source = body } = {}
) {
  const expectations = [];
  const unsupportedConstructs = [];
  const candidates = [...body.matchAll(/await\s+expect\s*\(/g)];

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const end = candidates[candidateIndex + 1]?.index ?? body.length;
    const statement = body.slice(candidate.index, end);
    const parsed = parseReadOnlyExpectations(statement);
    if (parsed.length > 0) {
      expectations.push(...parsed);
      continue;
    }

    const matcher = statement.match(/\)\s*\.\s*(?:not\s*\.\s*)?([A-Za-z_$][\w$]*)/)?.[1];
    unsupportedConstructs.push({
      api: matcher ?? "expect",
      category: "assertion",
      reason: "unsupported assertion or locator expression",
      severity: "error",
      location: sourceLocation(source, sourceOffset + candidate.index, fileName),
    });
  }

  return {
    expectations,
    unsupportedConstructs,
    coverage: {
      assertionsFound: candidates.length,
      assertionsParsed: expectations.length,
      unsupportedCount: unsupportedConstructs.length,
    },
  };
}

/** Parse statically representable, line-oriented safe actions in source order. */
export function parseSafeActions(body) {
  const steps = [];
  const actionMethods = new Set([
    "blur",
    "check",
    "click",
    "dblclick",
    "dragTo",
    "fill",
    "focus",
    "hover",
    "press",
    "selectOption",
    "setInputFiles",
    "uncheck",
  ]);

  for (const line of body.split("\n")) {
    const navigation = line.match(
      /await\s+page\.(goto|goBack|goForward|reload)\(\s*(.*?)\s*\)\s*;?/
    );
    if (navigation) {
      const expected = parseStaticExpected(navigation[2]);
      steps.push({
        type: "navigation",
        method: navigation[1],
        ...(expected?.kind === "literal" ? { value: expected.value } : {}),
      });
      continue;
    }

    const action = line.match(
      /await\s+([\s\S]+)\.([A-Za-z_$][\w$]*)\(\s*(.*?)\s*\)\s*;?$/
    );
    if (!action || !actionMethods.has(action[2])) continue;
    const locator = parseLocatorExpression(action[1]);
    if (!locator) continue;
    const expected = parseStaticExpected(action[3]);
    steps.push({
      type: "action",
      method: action[2],
      locator,
      ...(expected?.kind === "literal" ? { value: expected.value } : {}),
    });
  }

  return steps;
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

export function parseDashboardSpecFile(fileName, source) {
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
      `[qa-spec] ${fileName}: ${unparsedTestCount} test(s) could not be parsed and are missing from the QA spec.`
    );
  }

  const tests = blocks.map(block => {
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
    const analysis =
      stagingMode === "read-only"
        ? analyzeReadOnlyExpectations(block.body, {
            fileName,
            sourceOffset: block.bodyStart,
            source,
          })
        : {
            expectations: [],
            unsupportedConstructs: [],
            coverage: {
              assertionsFound: 0,
              assertionsParsed: 0,
              unsupportedCount: 0,
            },
          };
    const expectations = analysis.expectations.map(expectation =>
      adaptExpectationForLive(expectation, block.title, scenarioId)
    );
    const parserIntegrity =
      analysis.unsupportedConstructs.length > 0 ? "incomplete" : "complete";
    const steps = parseSafeActions(block.body);

    const fixtures = resolveTestFixtures(source, block.index, fileFixtures);

    return {
      title: block.title,
      stagingMode,
      liveRunPolicy,
      livePolicyAnnotation,
      expectations,
      ...(steps.length > 0 ? { steps } : {}),
      parserIntegrity,
      parserCoverage: analysis.coverage,
      ...(analysis.unsupportedConstructs.length > 0
        ? { unsupportedConstructs: analysis.unsupportedConstructs }
        : {}),
      ...(Object.keys(fixtures).length > 0 ? { fixtures } : {}),
      checkId: slugify(block.title) || "unnamed-test",
    };
  });

  const parserCoverage = tests.reduce(
    (coverage, test) => {
      coverage.assertionsFound += test.parserCoverage?.assertionsFound ?? 0;
      coverage.assertionsParsed += test.parserCoverage?.assertionsParsed ?? 0;
      coverage.unsupportedCount += test.parserCoverage?.unsupportedCount ?? 0;
      return coverage;
    },
    {
      testsFound: blocks.length + unparsedTestCount,
      testsParsed: blocks.length,
      assertionsFound: 0,
      assertionsParsed: 0,
      unsupportedCount: unparsedTestCount,
    }
  );

  return {
    scenarioId,
    page: annotations.page ?? null,
    liveSkip: annotations.liveSkip,
    alwaysRun: annotations.alwaysRun,
    sourceFile: fileName,
    label,
    ...(Object.keys(fileFixtures).length > 0 ? { fixtures: fileFixtures } : {}),
    ...(unparsedTestCount > 0 ? { unparsedTestCount } : {}),
    parserCoverage,
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
