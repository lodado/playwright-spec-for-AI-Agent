import { COMPILE_RESULT_VERSION, DIAGNOSTIC_VERSION, PLAYWRIGHT_STATIC_MANIFEST_VERSION, QA_IR_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";

export const ABSTRACT_PLAYWRIGHT_SPEC_VERSION = "behavioral-spec/3.0";
const ABSTRACT_ADAPTER_VERSION = "0.3.0";
const CLASSIFICATIONS = new Set(["LIVE_EXECUTABLE", "LIVE_JUDGMENT_ONLY", "MOCK_ONLY", "AMBIGUOUS"]);

export function countPlaywrightTestDeclarations(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const code = maskCommentsAndStrings(source);
  return [...code.matchAll(/(?<![\w.$])(?:test|it)(?:\s*\.\s*(?:only|skip|fixme|fail|slow|each))?\s*\(/g)].length;
}

export function normalizeFullSpecAbstraction(value, { source, manifest } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("full spec abstraction must be an object");
  if (Object.keys(value).some(key => !["status", "tests", "reason"].includes(key))) throw new TypeError("full spec abstraction contains unsupported fields");
  if (value.status === "MANUAL_REVIEW") {
    if (typeof value.reason !== "string" || value.reason.trim().length === 0 || value.reason.length > 2_000 || value.tests !== undefined) throw new TypeError("full spec manual review is invalid");
    return { status: "MANUAL_REVIEW", reason: value.reason.trim() };
  }
  if (value.status !== "ABSTRACTED" || !Array.isArray(value.tests) || value.reason !== undefined) throw new TypeError("full spec abstraction is invalid");
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const staticManifest = normalizeStaticManifest(manifest, { source });
  if (value.tests.length !== staticManifest.tests.length) throw new TypeError(`full spec abstraction must cover exactly ${staticManifest.tests.length} manifest test(s)`);
  const testsById = new Map(value.tests.map((test, index) => {
    const normalized = normalizeAbstractedTest(test, index);
    if (!staticManifest.tests.some(item => item.testId === normalized.testId)) throw new TypeError("abstracted testId is not present in static manifest");
    return [normalized.testId, normalized];
  }));
  if (testsById.size !== staticManifest.tests.length) throw new TypeError("full spec abstraction testIds must be unique and complete");
  return { status: "ABSTRACTED", tests: staticManifest.tests.map(test => testsById.get(test.testId)) };
}

export function normalizeFullSpecReview(value, { source, manifest } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("full spec review must be an object");
  if (Object.keys(value).some(key => !["status", "tests", "reason"].includes(key))) throw new TypeError("full spec review contains unsupported fields");
  if (value.status === "APPROVED") {
    if (value.reason !== undefined) throw new TypeError("approved full spec review cannot contain a reason");
    return { status: "APPROVED", tests: normalizeFullSpecAbstraction({ status: "ABSTRACTED", tests: value.tests }, { source, manifest }).tests };
  }
  if (value.status !== "MANUAL_REVIEW" || value.tests !== undefined) throw new TypeError("full spec review is invalid");
  return { status: "MANUAL_REVIEW", reason: boundedText(value.reason, 2_000, "full spec review reason") };
}

export async function abstractPlaywrightSource({ source, sourcePath, manifest, extract, review } = {}) {
  if (typeof source !== "string" || source.length === 0) throw new TypeError("source must be a non-empty string");
  if (typeof sourcePath !== "string" || sourcePath.length === 0) throw new TypeError("sourcePath must be a non-empty string");
  if (typeof extract !== "function" || typeof review !== "function") throw new TypeError("extract and review must be functions");
  const staticManifest = normalizeStaticManifest(manifest, { source, sourcePath });
  const sourceRecord = { path: sourcePath, contentHash: canonicalHash(source), manifestHash: canonicalHash(staticManifest), testCount: staticManifest.tests.length };
  let candidate;
  try {
    candidate = normalizeFullSpecAbstraction(await extract({ sourcePath, source, manifest: staticManifest }), { source, manifest: staticManifest });
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof SyntaxError)) throw error;
    return manualArtifact(sourceRecord, validationFailure("Extractor", error));
  }
  if (candidate.status === "MANUAL_REVIEW") return manualArtifact(sourceRecord, candidate.reason);
  try {
    const decision = normalizeFullSpecReview(await review({ sourcePath, source, manifest: staticManifest, candidate }), { source, manifest: staticManifest });
    if (decision.status === "MANUAL_REVIEW") return manualArtifact(sourceRecord, decision.reason);
    return {
      schemaVersion: ABSTRACT_PLAYWRIGHT_SPEC_VERSION,
      status: "APPROVED",
      source: sourceRecord,
      tests: decision.tests,
      review: { candidateHash: canonicalHash(candidate), approvedHash: canonicalHash(decision.tests) },
    };
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof SyntaxError)) throw error;
    return manualArtifact(sourceRecord, validationFailure("Independent reviewer", error));
  }
}

export function compileAbstractPlaywrightArtifact({ artifact, manifest, source, sourcePath, revision } = {}) {
  if (artifact?.schemaVersion !== ABSTRACT_PLAYWRIGHT_SPEC_VERSION || artifact.status !== "APPROVED") throw new TypeError("approved abstract Playwright artifact is required");
  const staticManifest = normalizeStaticManifest(manifest, { source, sourcePath });
  if (artifact.source?.contentHash !== canonicalHash(source) || artifact.source.path !== sourcePath || artifact.source.manifestHash !== canonicalHash(staticManifest)) throw new TypeError("abstract Playwright artifact does not match source manifest");
  const meanings = new Map(artifact.tests.map(test => [test.testId, test]));
  const blockedScenarioIds = [];
  const diagnostics = [];
  const suiteProvenance = wholeFileProvenance(source, sourcePath, revision);
  const scenarios = staticManifest.tests.map((staticTest, index) => {
    const test = meanings.get(staticTest.testId);
    if (!test) throw new TypeError("approved abstraction is missing a manifest testId");
    const id = stableId("abstract-scenario", sourcePath, staticTest.testId);
    const policy = structuredClone(staticTest.policy);
    const provenance = provenanceForRange(source, sourcePath, staticTest.range, revision);
    const liveClassification = ["LIVE_EXECUTABLE", "LIVE_JUDGMENT_ONLY"].includes(test.classification);
    if (!liveClassification || policy.navigation !== "ALLOWED" || policy.readDom !== true) {
      blockedScenarioIds.push(id);
      diagnostics.push(diagnostic(
        !liveClassification ? "ABSTRACT_NON_LIVE" : "ABSTRACT_POLICY_BLOCKED",
        "ERROR",
        !liveClassification ? "Abstracted test is not eligible for live execution." : "Static manifest policy blocks live execution.",
        sourcePath,
      ));
    }
    const semantics = { given: test.given, when: test.when, then: test.then, classification: test.classification };
    const expectations = test.then.map((claim, claimIndex) => ({
      id: stableId("abstract-expectation", id, claimIndex, claim),
      kind: "SEMANTIC_CLAIM",
      text: { kind: "literal", value: claim },
      provenance: [provenance],
    }));
    return {
      id,
      title: staticTest.title,
      preconditions: [],
      steps: [
        { id: stableId("abstract-navigate", id), kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: staticManifest.scenario.page ?? "/" } },
        ...(staticTest.actions ?? []).map((action, actionIndex) => ({
          id: stableId("abstract-interact", id, actionIndex),
          kind: "INTERACT",
          milestoneClass: "REQUIRED_EXACT_ACTION",
          action: action.action,
          target: structuredClone(action.target),
        })),
        { id: stableId("abstract-observe", id), kind: "OBSERVE", requests: [{ type: "DOM_SNAPSHOT" }, { type: "ARIA_SNAPSHOT" }, { type: "VISIBLE_TEXT" }] },
        { id: stableId("abstract-checkpoint", id), kind: "CHECKPOINT", checkpointId: stableId("abstract-checkpoint-id", id) },
      ],
      expectations,
      semantics,
      policy,
      provenance: [provenance],
      ...(staticTest.fixtures ? { fixtures: structuredClone(staticTest.fixtures) } : {}),
    };
  });
  const qaIr = {
    schemaVersion: QA_IR_VERSION,
    id: stableId("abstract-qa-ir", sourcePath, artifact.source.contentHash),
    source: { adapter: "abstract-playwright", adapterVersion: ABSTRACT_ADAPTER_VERSION, uri: sourcePath, ...(revision ? { revision } : {}) },
    suites: [{ id: stableId("abstract-suite", sourcePath), title: staticManifest.scenario.label, tags: ["playwright", "abstract-ai"], scenarios, provenance: [suiteProvenance] }],
    extensions: {
      sourceContentHash: artifact.source.contentHash,
      staticManifestHash: artifact.source.manifestHash,
      ...(blockedScenarioIds.length > 0 ? { blockedScenarioIds } : {}),
    },
  };
  return validateContract("CompileResult", { schemaVersion: COMPILE_RESULT_VERSION, ok: diagnostics.length === 0, qaIr, diagnostics });
}

function normalizeAbstractedTest(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`abstracted test ${index} must be an object`);
  const keys = Object.keys(value);
  const gwt = ["given", "when", "then"];
  const allowed = gwt.every(key => keys.includes(key)) ? ["testId", ...gwt, "classification"] : [];
  if (allowed.length === 0) throw new TypeError("abstracted test must contain exactly Given, When, Then semantics");
  if (keys.some(key => !allowed.includes(key))) throw new TypeError("abstracted test contains unsupported fields");
  const testId = boundedText(value.testId, 256, "abstracted testId");
  if (!CLASSIFICATIONS.has(value.classification)) throw new TypeError("abstracted test classification is invalid");
  return {
    testId,
    given: boundedTextArray(value.given, 10, "abstracted test Given"),
    when: boundedTextArray(value.when, 20, "abstracted test when"),
    then: boundedTextArray(value.then, 20, "abstracted test Then", { nonEmpty: true }),
    classification: value.classification,
  };
}

function boundedTextArray(value, maxItems, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > maxItems || (nonEmpty && value.length === 0)) throw new TypeError(`${label} is invalid`);
  return value.map(item => boundedText(item, 4_096, label));
}

function boundedText(value, maxLength, label) {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function manualArtifact(source, reason) {
  return {
    schemaVersion: ABSTRACT_PLAYWRIGHT_SPEC_VERSION,
    status: "MANUAL_REVIEW",
    source,
    tests: [],
    reason,
  };
}

function normalizeStaticManifest(value, { source, sourcePath } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== PLAYWRIGHT_STATIC_MANIFEST_VERSION) throw new TypeError("static manifest is invalid");
  if (value.source?.contentHash !== canonicalHash(source) || (sourcePath !== undefined && value.source?.path !== sourcePath)) throw new TypeError("static manifest does not match source");
  if (!value.scenario || typeof value.scenario !== "object" || !Array.isArray(value.tests) || value.tests.length !== countPlaywrightTestDeclarations(source)) throw new TypeError("static manifest test coverage is invalid");
  const scenario = {
    id: boundedText(value.scenario.id, 1_000, "static manifest scenario id"),
    label: boundedText(value.scenario.label, 1_000, "static manifest scenario label"),
    ...(value.scenario.page == null ? {} : { page: boundedText(value.scenario.page, 2_000, "static manifest page") }),
    liveSkip: value.scenario.liveSkip === true,
    alwaysRun: value.scenario.alwaysRun === true,
  };
  const seen = new Set();
  const tests = value.tests.map((test, index) => {
    if (!test || typeof test !== "object" || Array.isArray(test)) throw new TypeError(`static manifest test ${index} is invalid`);
    const testId = boundedText(test.testId, 256, "static manifest testId");
    if (seen.has(testId)) throw new TypeError("static manifest testIds must be unique");
    seen.add(testId);
    if (!Number.isInteger(test.range?.start) || !Number.isInteger(test.range?.end) || test.range.start < 0 || test.range.end <= test.range.start || test.range.end > source.length) throw new TypeError("static manifest test range is invalid");
    if (test.livePolicyAnnotation !== null && typeof test.livePolicyAnnotation !== "string") throw new TypeError("static manifest live policy annotation is invalid");
    return {
      testId,
      title: boundedText(test.title, 1_000, "static manifest test title"),
      checkId: boundedText(test.checkId, 1_000, "static manifest checkId"),
      range: { start: test.range.start, end: test.range.end },
      livePolicyAnnotation: test.livePolicyAnnotation,
      liveRunPolicy: boundedText(test.liveRunPolicy, 256, "static manifest live policy"),
      policy: normalizePolicy(test.policy),
      ...(test.modifier === undefined ? {} : { modifier: boundedText(test.modifier, 64, "static manifest modifier") }),
      ...(test.fixtures === undefined ? {} : { fixtures: normalizeFixtures(test.fixtures) }),
      ...(test.actions === undefined ? {} : { actions: normalizeStaticActions(test.actions) }),
    };
  });
  return { schemaVersion: PLAYWRIGHT_STATIC_MANIFEST_VERSION, source: { path: value.source.path, contentHash: value.source.contentHash }, scenario, tests };
}

function normalizeStaticActions(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("static manifest actions are invalid");
  return value.map(action => {
    if (!action || typeof action !== "object" || Array.isArray(action) || Object.keys(action).some(key => !["action", "target"].includes(key)) || action.action !== "CLICK") throw new TypeError("static manifest action is invalid");
    return { action: "CLICK", target: normalizeSemanticTarget(action.target) };
  });
}

function normalizeSemanticTarget(value) {
  const allowed = ["role", "accessibleName", "text", "testId", "hints"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("static manifest action target is invalid");
  const target = {
    ...(value.role === undefined ? {} : { role: boundedText(value.role, 256, "static manifest action role") }),
    ...(value.accessibleName === undefined ? {} : { accessibleName: normalizeSemanticMatch(value.accessibleName) }),
    ...(value.text === undefined ? {} : { text: normalizeSemanticMatch(value.text) }),
    ...(value.testId === undefined ? {} : { testId: boundedText(value.testId, 1_024, "static manifest action testId") }),
  };
  if (Object.keys(target).length === 0) throw new TypeError("static manifest action target requires semantic identity");
  if (value.hints !== undefined) target.hints = normalizeHints(value.hints);
  return target;
}

function normalizeSemanticMatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["kind", "value"].includes(key)) || !["literal", "regex"].includes(value.kind)) throw new TypeError("static manifest semantic match is invalid");
  return { kind: value.kind, value: boundedText(value.value, 4_096, "static manifest semantic match") };
}

function normalizeHints(value) {
  if (!Array.isArray(value)) throw new TypeError("static manifest action hints are invalid");
  return value.map(hint => {
    if (!hint || typeof hint !== "object" || Array.isArray(hint) || Object.keys(hint).some(key => !["adapter", "data"].includes(key))) throw new TypeError("static manifest action hint is invalid");
    const adapter = boundedText(hint.adapter, 256, "static manifest action hint adapter");
    const serialized = JSON.stringify(hint.data);
    if (serialized === undefined || serialized.length > 4_096) throw new TypeError("static manifest action hint data is invalid");
    return { adapter, data: structuredClone(hint.data) };
  });
}

function normalizePolicy(value) {
  const expected = ["navigation", "readDom", "readNetwork", "click", "type", "upload", "submit", "destructiveMutation", "confirmation", "secrets"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !expected.includes(key))) throw new TypeError("static manifest policy is invalid");
  if (!["ALLOWED", "BLOCKED"].includes(value.navigation) || typeof value.readDom !== "boolean" || typeof value.readNetwork !== "boolean" || !["NONE", "SAFE_ONLY", "ALL"].includes(value.click) || !["NONE", "NON_SECRET", "ALL"].includes(value.type) || ["upload", "submit", "destructiveMutation"].some(key => typeof value[key] !== "boolean") || !["DENY", "ALLOW_SAFE"].includes(value.confirmation) || value.secrets !== "RUNTIME_INJECTED") throw new TypeError("static manifest policy is invalid");
  return Object.fromEntries(expected.map(key => [key, value[key]]));
}

function normalizeFixtures(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("static manifest fixtures are invalid");
  return Object.fromEntries(Object.entries(value).map(([key, path]) => [boundedText(key, 128, "static manifest fixture"), boundedText(path, 4_096, "static manifest fixture path")]));
}

function wholeFileProvenance(source, sourcePath, revision) {
  return provenanceForRange(source, sourcePath, { start: 0, end: source.length }, revision);
}

function provenanceForRange(source, sourcePath, range, revision) {
  return { path: sourcePath, range: { start: positionAt(source, range.start), end: positionAt(source, range.end) }, adapter: { name: "abstract-playwright", version: ABSTRACT_ADAPTER_VERSION }, contentHash: canonicalHash(source.slice(range.start, range.end)), ...(revision ? { revision } : {}) };
}

function positionAt(source, offset) {
  const lines = source.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1, offset };
}

function stableId(...parts) {
  const text = parts.join(":");
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "item";
  return `${slug}-${canonicalHash(text).slice("sha256:".length, "sha256:".length + 12)}`;
}

function diagnostic(code, severity, message, path) {
  return { schemaVersion: DIAGNOSTIC_VERSION, code, severity, message, path };
}

function validationFailure(stage, error) {
  const detail = typeof error?.message === "string" ? error.message.replace(/[^A-Za-z0-9 _().:/-]/g, "").slice(0, 200) : "invalid output";
  return `${stage} output failed contract validation: ${detail}`;
}

function maskCommentsAndStrings(source) {
  const chars = [...source];
  let state = "code";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { chars[index] = chars[index + 1] = " "; state = "line"; index += 1; continue; }
      if (char === "/" && next === "*") { chars[index] = chars[index + 1] = " "; state = "block"; index += 1; continue; }
      if (char === "'") { chars[index] = " "; state = "single"; continue; }
      if (char === '"') { chars[index] = " "; state = "double"; continue; }
      if (char === "`") { chars[index] = " "; state = "template"; continue; }
      continue;
    }
    if (char === "\n" && state === "line") { state = "code"; continue; }
    if (state === "block" && char === "*" && next === "/") { chars[index] = chars[index + 1] = " "; state = "code"; index += 1; continue; }
    if (["single", "double", "template"].includes(state) && char === "\\") { chars[index] = " "; if (next !== undefined && next !== "\n") chars[index + 1] = " "; index += 1; continue; }
    if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) { chars[index] = " "; state = "code"; continue; }
    if (char !== "\n") chars[index] = " ";
  }
  return chars.join("");
}
