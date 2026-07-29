import {
  canonicalHash,
  COMPILE_RESULT_VERSION,
  DIAGNOSTIC_VERSION,
  QA_IR_VERSION,
  validateContract,
} from "../contracts/index.mjs";
import { parsePlaywrightSource } from "../../scripts/dashboard-spec-parser.mjs";

const ADAPTER_NAME = "adapter-playwright";
const ADAPTER_VERSION = "0.2.0";

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

  const parsed = parsePlaywrightSource(sourcePath, source);
  const diagnostics = parsed.diagnostics.map(item => diagnostic(
    item.code,
    item.severity,
    item.message,
    sourcePath,
    positionFromPath(item.path),
  ));
  const annotations = parsed.annotations;
  if (!annotations.scenario) {
    diagnostics.push(diagnostic("MISSING_QA_SCENARIO", "ERROR", "Missing @qa-scenario annotation.", sourcePath));
  }

  const blocks = parsed.blocks;
  const legacy = parsed.scenario;

  // A parse error tied to a specific test (`testIndex`) blocks only that test's static
  // compilation; an error with no test index (e.g. a missing annotation) blocks the file.
  const fileLevelError = parsed.diagnostics.some(item => item.severity === "ERROR" && typeof item.testIndex !== "number");
  const blockedTestIndices = new Set(
    parsed.diagnostics.filter(item => item.severity === "ERROR" && typeof item.testIndex === "number").map(item => item.testIndex),
  );

  const blockedScenarioIds = [];
  const scenarios = legacy
    ? legacy.tests.map((test, index) => scenarioFromLegacyTest(legacy, test, index, blocks[index], source, sourcePath, revision, diagnostics, fileLevelError || blockedTestIndices.has(index), blockedScenarioIds))
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
      ...(blockedScenarioIds.length > 0 ? { blockedScenarioIds } : {}),
    },
  };

  return validateContract("CompileResult", {
    schemaVersion: COMPILE_RESULT_VERSION,
    ok: diagnostics.every(item => item.severity !== "ERROR"),
    qaIr,
    diagnostics,
  });
}

function scenarioFromLegacyTest(legacy, test, index, block, source, sourcePath, revision, diagnostics, scenarioBlocked, blockedScenarioIds) {
  const provenance = blockProvenance(source, sourcePath, block, revision);
  const discriminator = `${index}:${block?.index ?? "unknown"}`;
  const executableInteraction = test.liveRunPolicy === "executable-interaction";
  const parsedActions = executableInteraction && !scenarioBlocked ? normalizeActions(test.actions ?? []) : [];
  const expectations = (test.expectations ?? []).map((expectation, expectationIndex) =>
    expectationFromLegacy(legacy, test, discriminator, expectation, expectationIndex, provenance),
  );
  if (executableInteraction && parsedActions === undefined) {
    diagnostics.push(diagnostic("UNSUPPORTED_INTERACTION_STEPS", "ERROR", `Unsupported interaction action found in test: ${test.title}`, sourcePath, positionAt(source, block?.index ?? 0)));
  } else if (test.stagingMode === "interaction" && !executableInteraction) {
    diagnostics.push(diagnostic("DEFERRED_INTERACTION_STEPS", "WARNING", `Interaction steps are deferred for Playwright execution: ${test.title}`, sourcePath, positionAt(source, block?.index ?? 0)));
  }

  const id = stableId("scenario", legacy.scenarioId, test.checkId, discriminator);
  // A scenario the parser flagged, or whose interaction steps could not be normalized, cannot
  // run statically — record its id so `execute --allow-partial` can skip it.
  if (scenarioBlocked || parsedActions === undefined) blockedScenarioIds.push(id);

  return {
    id,
    title: test.title,
    preconditions: [],
    steps: stepsFromLegacy(legacy, test, discriminator, expectations, parsedActions ?? []),
    expectations,
    policy: clonePolicy(POLICY_BY_LIVE_RUN[test.liveRunPolicy] ?? blockedPolicy()),
    provenance: [clone(provenance)],
  };
}

function stepsFromLegacy(legacy, test, discriminator, expectations, actions) {
  const steps = [];
  if (legacy.page) {
    steps.push({ id: stableId("step-navigate", legacy.scenarioId, test.checkId, discriminator), kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: legacy.page } });
  }
  actions.forEach((interaction, index) => {
    steps.push({
      id: stableId("step-interact", legacy.scenarioId, test.checkId, discriminator, index),
      kind: "INTERACT",
      milestoneClass: "REQUIRED_EXACT_ACTION",
      action: interaction.action,
      target: semanticTargetFromLocator(interaction.target),
      ...(interaction.value !== undefined ? { value: interaction.value } : {}),
    });
  });
  if (expectations.length > 0) {
    steps.push({ id: stableId("step-observe", legacy.scenarioId, test.checkId, discriminator), kind: "OBSERVE", requests: [{ type: "ELEMENT_OBSERVATION" }, { type: "VISIBLE_TEXT" }] });
  }
  steps.push({ id: stableId("step-checkpoint", legacy.scenarioId, test.checkId, discriminator), kind: "CHECKPOINT", checkpointId: stableId("checkpoint", legacy.scenarioId, test.checkId, discriminator) });
  return steps;
}

function normalizeActions(actions) {
  const result = [];
  const actionMap = {
    click: "CLICK",
    fill: "TYPE",
    type: "TYPE",
    pressSequentially: "TYPE",
    setInputFiles: "UPLOAD",
    selectOption: "SELECT",
    press: "PRESS",
  };
  for (const action of actions) {
    const mapped = actionMap[action.type];
    if (!mapped) return undefined;
    const value = action.arguments?.[0]?.kind === "literal" ? action.arguments[0].value : undefined;
    result.push({ action: mapped, target: action.target, ...(value !== undefined ? { value } : {}) });
  }
  return result;
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
  if (expectation.type === "disabled") return "DISABLED";
  if (expectation.type === "containText") return "CONTAINS_TEXT";
  if (expectation.type === "url") return expectation.expected?.kind === "regex" ? "URL_MATCH" : "URL";
  if (expectation.type === "accessibleName") return "NAME";
  if (["attribute", "cSS", "id", "jSProperty"].includes(expectation.type)) return "ATTRIBUTE";
  return "VISIBLE_TEXT";
}

function semanticTargetFromLocator(locator = {}) {
  const hintData = { kind: locator.kind ?? "unknown" };
  for (const key of ["value", "role", "name"]) {
    if (locator[key] !== undefined) hintData[key] = locator[key];
  }
  const base = { hints: [{ adapter: "playwright", data: hintData }] };
  if (locator.kind === "testId") return { ...base, testId: String(locator.value) };
  if (locator.kind === "text") return { ...base, text: { kind: "literal", value: String(locator.value) } };
  if (locator.kind === "role") {
    // Role alone is a valid identity (contract). Only attach accessibleName when the
    // locator carries an explicit name — never fall back to the role string.
    const name = typeof locator.name === "string" ? locator.name : undefined;
    return {
      ...base,
      role: String(locator.role ?? locator.value),
      ...(name === undefined || name === "" ? {} : { accessibleName: { kind: "literal", value: name } }),
    };
  }
  if (locator.kind === "chain") {
    const operations = locator.operations ?? [];
    const lastSemantic = [...operations].reverse().find(operation => ["getByRole", "getByTestId", "getByText"].includes(operation.method));
    if (lastSemantic) {
      const [first, options] = lastSemantic.arguments ?? [];
      if (lastSemantic.method === "getByTestId") return semanticTargetFromLocator({ kind: "testId", value: first?.value });
      if (lastSemantic.method === "getByText") return semanticTargetFromLocator({ kind: "text", value: first?.value });
      return semanticTargetFromLocator({ kind: "role", role: first?.value, name: options?.value?.name?.value });
    }
    return semanticTargetFromLocator(locator.root);
  }
  return { ...base, text: { kind: "literal", value: String(locator.value ?? "document") } };
}

function matchValue(expected = {}) {
  if (expected.kind === "literal") return { kind: "literal", value: expected.value };
  if (expected.kind === "regex") return { kind: "regex", value: expected.pattern };
  if (expected.kind === "array") return { kind: "literal", value: expected.value };
  return undefined;
}

function positionFromPath(path) {
  const match = String(path ?? "").match(/:(\d+):(\d+)$/);
  return match ? { line: Number(match[1]), column: Number(match[2]) } : undefined;
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

function stableId(...parts) {
  const text = parts.filter(part => part !== undefined && part !== null).join(":");
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "item";
  return `${slug}-${canonicalHash(text).slice("sha256:".length, "sha256:".length + 12)}`;
}
