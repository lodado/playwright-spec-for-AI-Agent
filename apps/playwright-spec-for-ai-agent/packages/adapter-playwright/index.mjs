import {
  canonicalHash,
  COMPILE_RESULT_VERSION,
  DIAGNOSTIC_VERSION,
  PLAYWRIGHT_STATIC_MANIFEST_VERSION,
  QA_IR_VERSION,
  validateContract,
} from "../contracts/index.mjs";
import { parsePlaywrightSource } from "../../scripts/dashboard-spec-parser.mjs";

export { PLAYWRIGHT_STATIC_MANIFEST_VERSION };

const ADAPTER_NAME = "adapter-playwright";
const ADAPTER_VERSION = "0.3.0";
const AI_FALLBACK_CACHE_VERSION = "playwright-spec-ai-cache/0.1";
const AI_RECOVERABLE_DIAGNOSTICS = new Set(["UNSUPPORTED_MATCHER", "OPAQUE_ASSERTION_TARGET", "DYNAMIC_EXPECTED_VALUE", "DYNAMIC_EXECUTION_VALUE", "OPAQUE_ACTION_TARGET", "OPAQUE_INTERACTION_STEP"]);

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

export function extractPlaywrightStaticManifest({ source, sourcePath } = {}) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (typeof sourcePath !== "string" || sourcePath.length === 0) throw new TypeError("sourcePath must be a non-empty string");
  const parsed = parsePlaywrightSource(sourcePath, source);
  if (!parsed.scenario || parsed.scenario.tests.length !== parsed.blocks.length) throw new TypeError("static manifest requires an annotated Playwright scenario");
  const scenario = parsed.scenario;
  return {
    schemaVersion: PLAYWRIGHT_STATIC_MANIFEST_VERSION,
    source: { path: sourcePath, contentHash: canonicalHash(source) },
    scenario: {
      id: scenario.scenarioId,
      label: scenario.label,
      ...(scenario.page ? { page: scenario.page } : {}),
      liveSkip: scenario.liveSkip,
      alwaysRun: scenario.alwaysRun,
    },
    tests: scenario.tests.map((test, index) => {
      const actions = staticManifestActions(test, parsed.diagnostics, index);
      return {
        testId: stableId("static-test", sourcePath, scenario.scenarioId, index, parsed.blocks[index].index),
        title: test.title,
        checkId: test.checkId,
        range: { start: parsed.blocks[index].index, end: parsed.blocks[index].endIndex },
        livePolicyAnnotation: test.livePolicyAnnotation ?? null,
        liveRunPolicy: test.liveRunPolicy,
        policy: clonePolicy(POLICY_BY_LIVE_RUN[test.liveRunPolicy] ?? blockedPolicy()),
        ...(test.modifier ? { modifier: test.modifier } : {}),
        ...(test.fixtures ? { fixtures: clone(test.fixtures) } : {}),
        ...(actions ? { actions } : {}),
      };
    }),
  };
}

export function compilePlaywrightSpec({ source, sourcePath, revision } = {}) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (typeof sourcePath !== "string" || sourcePath.length === 0) throw new TypeError("sourcePath must be a non-empty string");

  const parsed = parsePlaywrightSource(sourcePath, source);
  const blocks = parsed.blocks;
  const diagnostics = parsed.diagnostics.map(item => diagnostic(
    item.code,
    item.severity,
    item.message,
    sourcePath,
    positionFromPath(item.path) ?? (typeof item.testIndex === "number" ? positionAt(source, blocks[item.testIndex]?.index ?? 0) : undefined),
  ));
  const annotations = parsed.annotations;
  if (!annotations.scenario) {
    diagnostics.push(diagnostic("MISSING_QA_SCENARIO", "ERROR", "Missing @qa-scenario annotation.", sourcePath));
  }

  const legacy = parsed.scenario;

  // A parse error tied to a specific test (`testIndex`) blocks only that test's static
  // compilation; an error with no test index (e.g. a missing annotation) blocks the file.
  const fileLevelError = parsed.diagnostics.some(item => item.severity === "ERROR" && typeof item.testIndex !== "number");
  const blockedTestIndices = new Set(
    parsed.diagnostics.filter(item => item.severity === "ERROR" && typeof item.testIndex === "number").map(item => item.testIndex),
  );

  const blockedScenarioIds = [];
  const semanticJudgmentScenarioIds = [];
  const scenarios = legacy
    ? legacy.tests.map((test, index) => scenarioFromLegacyTest(legacy, test, index, blocks[index], source, sourcePath, revision, diagnostics, fileLevelError || blockedTestIndices.has(index), blockedScenarioIds, semanticJudgmentScenarioIds))
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
      ...(semanticJudgmentScenarioIds.length > 0 ? { semanticJudgmentScenarioIds } : {}),
    },
  };

  return validateContract("CompileResult", {
    schemaVersion: COMPILE_RESULT_VERSION,
    ok: diagnostics.every(item => item.severity !== "ERROR"),
    qaIr,
    diagnostics,
  });
}

export async function recoverPlaywrightSpecWithAi({ compileResult, source, abstractScenario, cache, promptVersion = "unknown", model = "unknown", modelVersion = "unknown" } = {}) {
  validateContract("CompileResult", compileResult);
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const blocked = new Set(compileResult.qaIr.extensions?.blockedScenarioIds ?? []);
  if (blocked.size === 0) return compileResult;
  if (canonicalHash(source) !== compileResult.qaIr.extensions?.sourceContentHash) throw new TypeError("source does not match compile result");
  if (typeof abstractScenario !== "function") throw new TypeError("abstractScenario must be a function");

  const qaIr = clone(compileResult.qaIr);
  const diagnostics = clone(compileResult.diagnostics);
  const recoveries = [...(qaIr.extensions.aiFallbacks ?? [])];

  for (const suite of qaIr.suites) {
    for (let index = 0; index < suite.scenarios.length; index += 1) {
      const scenario = suite.scenarios[index];
      const provenance = scenario.provenance[0];
      const errors = diagnostics.filter(item => item.severity === "ERROR" && diagnosticInRange(item, provenance));
      if (!blocked.has(scenario.id) || errors.length === 0 || errors.some(item => !AI_RECOVERABLE_DIAGNOSTICS.has(item.code))) continue;

      const diagnosticCodes = [...new Set(errors.map(item => item.code))].sort();
      const sourceSlice = source.slice(provenance.range.start.offset, provenance.range.end.offset);
      const metadata = {
        sourceSliceHash: canonicalHash(sourceSlice),
        staticDiagnosticCodes: diagnosticCodes,
        qaLivePolicy: scenario.policy,
        parserVersion: compileResult.qaIr.source.adapterVersion,
        fallbackPromptVersion: promptVersion,
        model,
        modelVersion,
      };
      const cacheKey = canonicalHash(metadata).slice("sha256:".length);

      try {
        let artifact = cache?.read ? await cache.read(cacheKey) : undefined;
        if (artifact === undefined) {
          const result = normalizePlaywrightSpecFallback(await abstractScenario({
            sourcePath: provenance.path,
            range: provenance.range,
            sourceSlice,
            diagnosticCodes,
            qaLivePolicy: scenario.policy,
          }));
          artifact = { cacheVersion: AI_FALLBACK_CACHE_VERSION, cacheKey, metadata, result };
          if (cache?.write) await cache.write(cacheKey, artifact);
        } else {
          validateCacheArtifact(artifact, cacheKey, metadata);
        }
        const result = normalizePlaywrightSpecFallback(artifact.result);
        if (result.status !== "ABSTRACTED") {
          diagnostics.push(diagnostic("AI_FALLBACK_MANUAL_REVIEW", "WARNING", "AI fallback found the test meaning too ambiguous for semantic extraction.", provenance.path, provenance.range.start));
          continue;
        }

        suite.scenarios[index] = scenarioWithAiClaims(scenario, result.claims);
        if (scenario.policy.navigation === "ALLOWED" && scenario.policy.readDom === true) blocked.delete(scenario.id);
        const semanticIds = new Set(qaIr.extensions.semanticJudgmentScenarioIds ?? []);
        semanticIds.add(scenario.id);
        qaIr.extensions.semanticJudgmentScenarioIds = [...semanticIds];
        for (const item of diagnostics) {
          if (item.severity === "ERROR" && diagnosticInRange(item, provenance) && diagnosticCodes.includes(item.code)) item.severity = "WARNING";
        }
        recoveries.push({
          scenarioId: scenario.id,
          source: { path: provenance.path, range: provenance.range, contentHash: provenance.contentHash },
          diagnosticCodes,
          cacheKey,
          promptVersion,
          model,
          modelVersion,
        });
      } catch {
        // Invalid/tampered cache or model output stays blocked. Existing diagnostics retain the reason.
        diagnostics.push(diagnostic("AI_FALLBACK_FAILED", "WARNING", "AI fallback failed closed; the original static diagnostic remains authoritative.", provenance.path, provenance.range.start));
      }
    }
  }

  if (blocked.size > 0) qaIr.extensions.blockedScenarioIds = [...blocked];
  else delete qaIr.extensions.blockedScenarioIds;
  if (recoveries.length > 0) qaIr.extensions.aiFallbacks = recoveries;
  return validateContract("CompileResult", {
    ...compileResult,
    ok: diagnostics.every(item => item.severity !== "ERROR"),
    qaIr,
    diagnostics,
  });
}

export function normalizePlaywrightSpecFallback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("AI fallback must be an object");
  if (Object.keys(value).some(key => !["status", "claims", "reason"].includes(key))) throw new TypeError("AI fallback contains unsupported fields");
  if (value.status === "MANUAL_REVIEW") {
    if (typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 2_000 || value.claims !== undefined) throw new TypeError("AI fallback manual review is invalid");
    return { status: value.status, reason: value.reason };
  }
  if (value.status !== "ABSTRACTED" || !Array.isArray(value.claims) || value.claims.length === 0 || value.claims.length > 10 || value.reason !== undefined) throw new TypeError("AI fallback abstraction is invalid");
  const claims = value.claims.map(claim => {
    if (typeof claim !== "string") throw new TypeError("AI fallback claim is invalid");
    const normalized = claim.trim();
    if (normalized.length === 0 || normalized.length > 4_096) throw new TypeError("AI fallback claim is invalid");
    return normalized;
  });
  return { status: value.status, claims };
}

function scenarioWithAiClaims(scenario, claims) {
  const expectations = claims.map((claim, index) => ({
    id: stableId("expectation-ai", scenario.id, index, claim),
    kind: "VISIBLE_TEXT",
    text: { kind: "literal", value: claim },
    provenance: clone(scenario.provenance),
  }));
  const steps = scenario.steps.filter(step => step.kind !== "OBSERVE");
  const checkpointIndex = steps.findIndex(step => step.kind === "CHECKPOINT");
  steps.splice(checkpointIndex < 0 ? steps.length : checkpointIndex, 0, {
    id: stableId("step-observe-ai", scenario.id, canonicalHash(expectations)),
    kind: "OBSERVE",
    requests: [{ type: "DOM_SNAPSHOT" }, { type: "VISIBLE_TEXT" }],
  });
  return { ...scenario, steps, expectations };
}

function diagnosticInRange(item, provenance) {
  if (!item.path || !provenance?.range) return false;
  const match = item.path.match(/:(\d+):(\d+)$/);
  if (!match || !item.path.startsWith(`${provenance.path}:`)) return false;
  const line = Number(match[1]);
  const column = Number(match[2]);
  const { start, end } = provenance.range;
  return (line > start.line || (line === start.line && column >= start.column)) && (line < end.line || (line === end.line && column <= end.column));
}

function validateCacheArtifact(artifact, cacheKey, metadata) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || Object.keys(artifact).some(key => !["cacheVersion", "cacheKey", "metadata", "result"].includes(key))) throw new TypeError("AI fallback cache is invalid");
  if (artifact.cacheVersion !== AI_FALLBACK_CACHE_VERSION || artifact.cacheKey !== cacheKey || canonicalHash(artifact.metadata) !== canonicalHash(metadata)) throw new TypeError("AI fallback cache metadata is invalid");
}

function scenarioFromLegacyTest(legacy, test, index, block, source, sourcePath, revision, diagnostics, scenarioBlocked, blockedScenarioIds, semanticJudgmentScenarioIds) {
  const provenance = blockProvenance(source, sourcePath, block, revision);
  const discriminator = `${index}:${block?.index ?? "unknown"}`;
  const executableInteraction = test.liveRunPolicy === "executable-interaction";
  const parsedActions = executableInteraction ? normalizeActions(test.actions ?? []) : [];
  const expectations = (test.expectations ?? []).map((expectation, expectationIndex) =>
    expectationFromLegacy(legacy, test, discriminator, expectation, expectationIndex, provenance),
  );
  if (executableInteraction && parsedActions === undefined) {
    diagnostics.push(diagnostic("UNSUPPORTED_INTERACTION_STEPS", "ERROR", `Unsupported interaction action found in test: ${test.title}`, sourcePath, positionAt(source, block?.index ?? 0)));
  } else if (test.stagingMode === "interaction" && !executableInteraction) {
    diagnostics.push(diagnostic("DEFERRED_INTERACTION_STEPS", "WARNING", `Interaction steps are deferred for Playwright execution: ${test.title}`, sourcePath, positionAt(source, block?.index ?? 0)));
  }

  const id = stableId("scenario", legacy.scenarioId, test.checkId, discriminator);
  // A scenario the parser flagged, whose interaction steps could not be normalized, or whose
  // live policy blocks navigation/DOM (skip, auth-mock, subscription-mutation) cannot run
  // statically — record its id so `execute --allow-partial` skips it instead of exploding in
  // createExecutionPlan (a NAVIGATE step under a BLOCKED policy is a plan-validation error).
  const policyBlocked = String(test.liveRunPolicy ?? "").startsWith("blocked-");
  // File upload is an exception path: an UPLOAD step replays a declared `@qa-fixture` file, so its
  // setInputFiles argument must name a fixture the test declared. An upload with no resolvable
  // fixture cannot run statically — block the scenario so it is skipped, never executed blind.
  const fixtures = test.fixtures ?? {};
  const uploadFixtureUnresolved = (parsedActions ?? []).some(
    (action) => action.action === "UPLOAD" && (typeof action.value !== "string" || !Object.hasOwn(fixtures, action.value)),
  );
  if (uploadFixtureUnresolved) diagnostics.push(diagnostic("UPLOAD_FIXTURE_UNRESOLVED", "WARNING", `Upload step has no matching @qa-fixture in test: ${test.title}`, sourcePath, positionAt(source, block?.index ?? 0)));
  if (scenarioBlocked || parsedActions === undefined || policyBlocked || uploadFixtureUnresolved) blockedScenarioIds.push(id);
  // A judgment-* live policy (mock-api / interaction-no-confirm) means the expectations were
  // authored against mock data — record the id so the judge/adaptive layers judge structure,
  // not literals. Mirrors the blockedScenarioIds side channel above.
  if (String(test.liveRunPolicy ?? "").startsWith("judgment-")) semanticJudgmentScenarioIds.push(id);

  return {
    id,
    title: test.title,
    preconditions: [],
    steps: stepsFromLegacy(legacy, test, discriminator, expectations, parsedActions ?? []),
    expectations,
    policy: clonePolicy(POLICY_BY_LIVE_RUN[test.liveRunPolicy] ?? blockedPolicy()),
    ...(test.fixtures && Object.keys(test.fixtures).length > 0 ? { fixtures: clone(test.fixtures) } : {}),
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

function staticManifestActions(test, diagnostics, testIndex) {
  if (test.liveRunPolicy !== "executable-interaction" || !Array.isArray(test.actions) || test.actions.length === 0) return undefined;
  if (diagnostics.some(item => item.testIndex === testIndex && ["OPAQUE_ACTION_TARGET", "OPAQUE_INTERACTION_STEP", "DYNAMIC_EXECUTION_VALUE"].includes(item.code))) return undefined;
  if (test.actions.some(item => item.type !== "click" || (item.arguments?.length ?? 0) > 0)) return undefined;
  const actions = normalizeActions(test.actions);
  if (!actions || actions.some(item => item.action !== "CLICK" || !isStaticSemanticLocator(item.target))) return undefined;
  return actions.map(item => ({ action: item.action, target: semanticTargetFromLocator(item.target) }));
}

function isStaticSemanticLocator(locator = {}) {
  if (locator.unrepresentable === true) return false;
  if (["testId", "text"].includes(locator.kind)) return typeof locator.value === "string" && locator.value.length > 0;
  if (locator.kind === "role") {
    const role = locator.role ?? locator.value;
    return typeof role === "string" && role.length > 0 && (locator.name === undefined || typeof locator.name === "string");
  }
  return false;
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
