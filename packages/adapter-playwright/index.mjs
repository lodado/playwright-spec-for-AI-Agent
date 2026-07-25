import {
  canonicalHash,
  COMPILE_RESULT_VERSION,
  DIAGNOSTIC_VERSION,
  QA_IR_VERSION,
  validateContract,
} from "../contracts/index.mjs";
import { extractTestBlocks, parseAnnotations, parseDashboardSpecFile } from "../../scripts/dashboard-spec-parser.mjs";

const ADAPTER_NAME = "adapter-playwright";
const ADAPTER_VERSION = "0.1.0";

const POLICY_BY_LIVE_RUN = {
  "executable-readonly": allowedPolicy({ click: "NONE", type: "NONE" }),
  "executable-interaction": allowedPolicy({ click: "SAFE_ONLY", type: "NON_SECRET" }),
  "judgment-mock-api": allowedPolicy({ click: "NONE", type: "NONE" }),
  "judgment-interaction-no-confirm": allowedPolicy({ click: "SAFE_ONLY", type: "NON_SECRET" }),
  "blocked-live-skip": blockedPolicy(),
  "blocked-auth-mock": blockedPolicy(),
  "blocked-subscription-mutation": blockedPolicy(),
  "blocked-unknown": blockedPolicy(),
};

export function compilePlaywrightSpec({ source, sourcePath, revision } = {}) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (typeof sourcePath !== "string" || sourcePath.length === 0) throw new TypeError("sourcePath must be a non-empty string");

  const diagnostics = detectUnsupportedSyntax(source, sourcePath);
  const annotations = parseAnnotations(source);
  if (!annotations.scenario) {
    diagnostics.push(diagnostic("MISSING_QA_SCENARIO", "ERROR", "Missing @qa-scenario annotation.", sourcePath));
  }

  const blocks = extractTestBlocks(source);
  let legacy;
  if (annotations.scenario) {
    try {
      legacy = parseDashboardSpecFile(sourcePath, source);
    } catch (error) {
      diagnostics.push(diagnostic("UNSUPPORTED_PLAYWRIGHT_SPEC", "ERROR", error.message, sourcePath));
    }
  }

  const scenarios = legacy
    ? legacy.tests.map((test, index) => scenarioFromLegacyTest(legacy, test, index, blocks[index], source, sourcePath, revision, diagnostics))
    : [];

  const qaIr = {
    schemaVersion: QA_IR_VERSION,
    id: stableId("qa-ir", sourcePath, source),
    source: {
      adapter: ADAPTER_NAME,
      adapterVersion: ADAPTER_VERSION,
      uri: sourcePath,
      ...(revision ? { revision } : {}),
    },
    suites: [
      {
        id: stableId("suite", sourcePath),
        title: legacy?.label ?? sourcePath,
        tags: ["playwright"],
        scenarios,
        provenance: [wholeFileProvenance(source, sourcePath, revision)],
      },
    ],
    extensions: {
      sourceContentHash: canonicalHash(source),
    },
  };

  return validateContract("CompileResult", {
    schemaVersion: COMPILE_RESULT_VERSION,
    ok: diagnostics.every(item => item.severity !== "ERROR"),
    qaIr,
    diagnostics,
  });
}

function scenarioFromLegacyTest(legacy, test, index, block, source, sourcePath, revision, diagnostics) {
  const provenance = blockProvenance(source, sourcePath, block, revision);
  const discriminator = `${index}:${block?.index ?? "unknown"}`;
  const expectations = normalizeExpectations(test.expectations ?? [], block?.body ?? "").map((expectation, expectationIndex) =>
    expectationFromLegacy(legacy, test, discriminator, expectation, expectationIndex, provenance),
  );

  if (isReadonly(test.liveRunPolicy)) {
    const assertionCount = countAssertions(block?.body ?? "");
    if (assertionCount === 0 || assertionCount !== expectations.length) {
      diagnostics.push(diagnostic("UNSUPPORTED_READONLY_ASSERTIONS", "ERROR", `Unsupported readonly assertions found in test: ${test.title}`, sourcePath, positionAt(source, block?.index ?? 0)));
    }
  }
  if (test.stagingMode === "interaction") {
    diagnostics.push(diagnostic("DEFERRED_INTERACTION_STEPS", "WARNING", `Interaction steps are deferred for Playwright execution: ${test.title}`, sourcePath, positionAt(source, block?.index ?? 0)));
  }

  return {
    id: stableId("scenario", legacy.scenarioId, test.checkId, discriminator),
    title: test.title,
    preconditions: [],
    steps: stepsFromLegacy(legacy, test, discriminator, expectations),
    expectations,
    policy: clonePolicy(POLICY_BY_LIVE_RUN[test.liveRunPolicy] ?? blockedPolicy()),
    provenance: [clone(provenance)],
  };
}

function stepsFromLegacy(legacy, test, discriminator, expectations) {
  const steps = [];
  if (legacy.page) {
    steps.push({ id: stableId("step-navigate", legacy.scenarioId, test.checkId, discriminator), kind: "NAVIGATE", target: { type: "PATH", value: legacy.page } });
  }
  if (expectations.length > 0) {
    steps.push({ id: stableId("step-observe", legacy.scenarioId, test.checkId, discriminator), kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT" }] });
  }
  steps.push({ id: stableId("step-checkpoint", legacy.scenarioId, test.checkId, discriminator), kind: "CHECKPOINT", checkpointId: stableId("checkpoint", legacy.scenarioId, test.checkId, discriminator) });
  return steps;
}

function normalizeExpectations(expectations, body) {
  if (expectations.length > 0) return expectations;
  return parseRegexContainTextExpectations(body);
}

function parseRegexContainTextExpectations(body) {
  const found = [];
  for (const match of body.matchAll(/expect\(\s*([\s\S]*?)\s*\)\.toContainText\(\s*\/((?:\\\/|[^/])+)\//g)) {
    found.push({
      type: "containText",
      locator: parseHintLocator(match[1]),
      expected: { kind: "regex", pattern: match[2].replace(/\\\//g, "/") },
    });
  }
  return found;
}

function parseHintLocator(expression) {
  const testId = expression.match(/getByTestId\(\s*["'`]([^"'`]+)["'`]\s*\)/);
  if (testId) return { kind: "testId", value: testId[1] };
  const text = expression.match(/getByText\(\s*["'`]([^"'`]+)["'`]\s*\)/);
  if (text) return { kind: "text", value: text[1] };
  return { kind: "locator", value: expression.trim() };
}

function expectationFromLegacy(legacy, test, discriminator, expectation, index, provenance) {
  const expected = matchValue(expectation.expected);
  return {
    id: stableId("expectation", legacy.scenarioId, test.checkId, discriminator, index),
    kind: expectationKind(expectation),
    target: semanticTargetFromLocator(expectation.locator),
    ...(expected ? { expected } : {}),
    provenance: [clone(provenance)],
  };
}

function expectationKind(expectation) {
  if (expectation.type === "notVisible") return "NOT_VISIBLE";
  if (expectation.type === "visible") return "VISIBLE";
  return "CONTAINS_TEXT";
}

function semanticTargetFromLocator(locator = {}) {
  const hintData = { kind: locator.kind ?? "unknown" };
  for (const key of ["value", "role", "name"]) {
    if (locator[key] !== undefined) hintData[key] = locator[key];
  }
  const base = { hints: [{ adapter: "playwright", data: hintData }] };
  if (locator.kind === "testId") return { ...base, testId: String(locator.value) };
  if (locator.kind === "text") return { ...base, text: { kind: "literal", value: String(locator.value) } };
  if (locator.kind === "role") return {
    ...base,
    role: String(locator.role ?? locator.value),
    accessibleName: { kind: "literal", value: String(locator.name ?? locator.value ?? "") },
  };
  return { ...base, text: { kind: "literal", value: String(locator.value ?? "document") } };
}

function countAssertions(body) {
  return (body.match(/\bexpect\s*\(/g) ?? []).length;
}

function matchValue(expected = {}) {
  if (expected.kind === "literal") return { kind: "literal", value: expected.value };
  if (expected.kind === "regex") return { kind: "regex", value: expected.pattern };
  return undefined;
}

function detectUnsupportedSyntax(source, sourcePath) {
  const diagnostics = [];
  for (const match of source.matchAll(/\btest\.(skip|only|fixme)\s*\(/g)) {
    diagnostics.push(diagnostic("UNSUPPORTED_TEST_MODIFIER", "ERROR", "test.skip/only/fixme is not compiled to QA IR.", sourcePath, positionAt(source, match.index)));
  }

  for (const match of source.matchAll(/\btest\s*\(/g)) {
    const header = source.slice(match.index, match.index + 240);
    if (!/test\s*\(\s*["'`][\s\S]*?["'`]\s*,\s*async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{/.test(header)) {
      diagnostics.push(diagnostic("UNSUPPORTED_TEST_CALLBACK", "ERROR", "Only async Playwright callbacks with a destructured fixture parameter are compiled.", sourcePath, positionAt(source, match.index)));
    }
  }
  return diagnostics;
}

function diagnostic(code, severity, message, sourcePath, position) {
  return {
    schemaVersion: DIAGNOSTIC_VERSION,
    code,
    severity,
    message,
    ...(sourcePath ? { path: position ? `${sourcePath}:${position.line}:${position.column}` : sourcePath } : {}),
  };
}

function wholeFileProvenance(source, sourcePath, revision) {
  return provenance(sourcePath, revision, {
    start: { line: 1, column: 1, offset: 0 },
    end: positionAt(source, source.length),
  }, source);
}

function blockProvenance(source, sourcePath, block, revision) {
  if (!block) return wholeFileProvenance(source, sourcePath, revision);
  return provenance(sourcePath, revision, {
    start: positionAt(source, block.index),
    end: positionAt(source, block.endIndex),
  }, source.slice(block.index, block.endIndex));
}

function provenance(sourcePath, revision, range, content) {
  return {
    path: sourcePath,
    range,
    adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
    contentHash: canonicalHash(content),
    ...(revision ? { revision } : {}),
  };
}

function positionAt(source, offset) {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1, offset };
}

function allowedPolicy(overrides) {
  return {
    navigation: "ALLOWED",
    readDom: true,
    readNetwork: false,
    click: "SAFE_ONLY",
    type: "NON_SECRET",
    upload: false,
    submit: false,
    destructiveMutation: false,
    confirmation: "DENY",
    secrets: "RUNTIME_INJECTED",
    ...overrides,
  };
}

function blockedPolicy() {
  return {
    navigation: "BLOCKED",
    readDom: false,
    readNetwork: false,
    click: "NONE",
    type: "NONE",
    upload: false,
    submit: false,
    destructiveMutation: false,
    confirmation: "DENY",
    secrets: "RUNTIME_INJECTED",
  };
}

function clonePolicy(policy) {
  return { ...policy };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isReadonly(liveRunPolicy) {
  return liveRunPolicy === "executable-readonly" || liveRunPolicy === "judgment-mock-api";
}

function stableId(...parts) {
  const text = parts.filter(part => part !== undefined && part !== null).join(":");
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
  return `${slug}-${canonicalHash(text).slice("sha256:".length, "sha256:".length + 12)}`;
}
