import {
  RUNTIME_OUTCOME_VERSION,
  validateContract,
} from "../contracts/index.mjs";
import {
  executePlan,
  providerCapabilities,
  validateExecutionPlanBinding,
} from "../core/index.mjs";
import { createInMemoryEvidenceStore } from "../evidence/index.mjs";

const PROVIDER_ID = "playwright-readonly";
const PROVIDER_VERSION = "0.1.0";
const TEXT_LIMIT = 1024 * 1024;
const DOM_LIMIT = 4 * 1024 * 1024;
const ACTION_LOG_LIMIT = 16 * 1024;
const ELEMENT_TEXT_LIMIT = 4 * 1024;
const MAX_ELEMENT_OBSERVATIONS = 128;
const MAX_PLAN_NODES = 128;
const MAX_RUN_ARTIFACTS = 256;
const MAX_RUN_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_NODE_TIMEOUT_MS = 60_000;
const MAX_RUN_TIMEOUT_MS = 300_000;
const MAX_VIEWPORT_DIMENSION = 4096;
const MAX_VIEWPORT_AREA = 4096 * 4096;

export function playwrightExecutionCapabilities() {
  return providerCapabilities({
    providerId: PROVIDER_ID,
    actions: ["NAVIGATE", "CLICK", "OBSERVE", "CHECKPOINT"],
    evidence: ["VISIBLE_TEXT", "DOM_SNAPSHOT", "ACTION_LOG", "ELEMENT_OBSERVATION"],
  });
}

export async function executeWithPlaywright({
  qaIr,
  plan,
  baseUrl,
  runId,
  browserName = "chromium",
  browserType,
  viewport = { width: 1280, height: 720 },
  locale,
  timezoneId,
  secrets = [],
  now = () => new Date().toISOString(),
} = {}) {
  let runtime;
  try {
    qaIr = jsonSnapshot(qaIr);
    plan = jsonSnapshot(plan);
    validateContract("QaIrDocument", qaIr);
    validateContract("ExecutionPlan", plan);
    const capabilities = playwrightExecutionCapabilities();
    validateExecutionPlanBinding({ qaIr, plan, providerCapabilities: capabilities });
    if (plan.nodes.length > MAX_PLAN_NODES || plan.retryPolicy.maxAttempts !== 1) throw new Error("execution plan exceeds readonly provider limits");
    if (plan.timeoutPolicy.perNodeMs > MAX_NODE_TIMEOUT_MS || plan.timeoutPolicy.runMs > MAX_RUN_TIMEOUT_MS) throw new Error("execution timeout exceeds readonly provider limits");
    runtime = createRuntime({ qaIr, baseUrl, runId, browserName, browserType, viewport, locale, timezoneId, secrets, now, capabilities, nodeTimeoutMs: plan.timeoutPolicy.perNodeMs });
  } catch {
    return executionResult(runtimeError("CONTRACT_VIOLATION", "Execution provider input is invalid"));
  }

  let outcome = await executePlan({
    plan,
    providerCapabilities: runtime.capabilities,
    executeNode: runtime.executeNode,
  });
  if (outcome.type === "COMPLETED" && !runtime.hasCompleteEvidence()) {
    outcome = runtimeError("EVIDENCE_STORAGE_FAILED", "Execution completed without complete sealed evidence");
  }
  try {
    await runtime.close();
  } catch {
    if (outcome.type === "COMPLETED") outcome = runtimeError("UNKNOWN_RUNTIME_ERROR", "Execution provider cleanup failed");
  }
  if (outcome.type === "COMPLETED" && runtime.hasInteractionPolicyViolation()) {
    outcome = runtimeError("POLICY_VIOLATION", "Execution provider failed");
  }
  return executionResult(outcome, runtime);
}

function createRuntime({ qaIr, baseUrl, runId, browserName, browserType, viewport, locale, timezoneId, secrets, now, capabilities, nodeTimeoutMs }) {
  const base = runtimeUrl(baseUrl);
  if (typeof runId !== "string" || runId.length === 0) throw new Error("runId must be a non-empty string");
  if (!Array.isArray(secrets)) throw new Error("secrets must be an array");
  if (!["chromium", "firefox", "webkit"].includes(browserName)) throw new Error("browserName is unsupported");
  if (locale !== undefined && (typeof locale !== "string" || locale.length === 0)) throw new Error("locale must be a non-empty string");
  if (timezoneId !== undefined && (typeof timezoneId !== "string" || timezoneId.length === 0)) throw new Error("timezoneId must be a non-empty string");
  if (!Number.isInteger(viewport?.width) || viewport.width <= 0 || viewport.width > MAX_VIEWPORT_DIMENSION || !Number.isInteger(viewport?.height) || viewport.height <= 0 || viewport.height > MAX_VIEWPORT_DIMENSION || viewport.width * viewport.height > MAX_VIEWPORT_AREA) throw new Error("viewport is outside readonly provider limits");
  if (typeof now !== "function") throw new Error("now must be a function");
  const store = createInMemoryEvidenceStore({
    providerCapabilities: capabilities,
    producer: { name: PROVIDER_ID, version: PROVIDER_VERSION },
    secrets,
  });
  const scenarios = new Map(qaIr.suites.flatMap((suite) => suite.scenarios.map((scenario) => [scenario.id, {
    scenario,
    steps: new Map(scenario.steps.map((step) => [step.id, step])),
  }])));
  if ([...scenarios.values()].some(({ scenario }) => scenario.expectations.length > MAX_ELEMENT_OBSERVATIONS)) throw new Error("scenario exceeds element observation limit");
  const observations = new Map();
  const bundles = [];
  let manifest;
  let session;
  let activeBrowser;
  let closed = false;
  let evidenceBytes = 0;
  let artifactCount = 0;
  let interactionStarted = false;
  let interactionPolicyViolation = false;

  async function openPage() {
    if (session) return session.page;
    let browser;
    try {
      const selectedBrowserType = browserType ?? await loadBrowserType(browserName);
      if (typeof selectedBrowserType?.launch !== "function") throw new Error("browser type cannot launch");
      if (closed) throw providerError("BROWSER_START_FAILED");
      browser = await selectedBrowserType.launch({ timeout: nodeTimeoutMs });
      if (closed) {
        await browser.close().catch(() => undefined);
        browser = undefined;
        throw providerError("BROWSER_START_FAILED");
      }
      activeBrowser = browser;
      const contextOptions = { viewport: { ...viewport }, serviceWorkers: "block" };
      if (locale !== undefined) contextOptions.locale = locale;
      if (timezoneId !== undefined) contextOptions.timezoneId = timezoneId;
      const context = await browser.newContext(contextOptions);
      if (typeof context.route !== "function" || typeof context.routeWebSocket !== "function") throw new Error("browser context cannot enforce request policy");
      await context.route("**/*", async (route) => {
        try {
          const request = route.request();
          const requestUrl = new URL(request.url());
          if (interactionStarted) {
            interactionPolicyViolation = true;
            await route.abort("blockedbyclient");
            return;
          }
          if (!["GET", "HEAD"].includes(request.method()) || !["http:", "https:"].includes(requestUrl.protocol) || requestUrl.origin !== base.origin || requestUrl.username || requestUrl.password) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket("**/*", (webSocket) => {
        if (interactionStarted) interactionPolicyViolation = true;
        webSocket.close();
      });
      const page = await context.newPage();
      session = { browser, page };
      return page;
    } catch {
      await browser?.close().catch(() => undefined);
      if (activeBrowser === browser) activeBrowser = undefined;
      throw providerError("BROWSER_START_FAILED");
    }
  }

  async function executeNode(node) {
    const entry = scenarios.get(node.scenarioId);
    const step = entry?.steps.get(node.stepId);
    if (!entry || !step || step.kind !== node.kind) throw providerError("CONTRACT_VIOLATION");
    if (node.kind === "NAVIGATE") {
      const target = navigationUrl(step.target, base);
      const page = await openPage();
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: nodeTimeoutMs });
      assertPageOrigin(page, base);
      return;
    }
    if (node.kind === "OBSERVE") {
      const page = await openPage();
      assertPageOrigin(page, base);
      const state = observationState(observations, node.scenarioId);
      try {
        const captured = [];
        for (const type of node.evidence) {
          if (type === "ELEMENT_OBSERVATION") {
            state.facts.push(...(await observeExpectations(page, entry.scenario.expectations, node.nodeId, nodeTimeoutMs)).map(captureFact));
            continue;
          }
          const content = await observe(page, type, nodeTimeoutMs);
          captured.push(captureArtifact(`${node.nodeId}:${type.toLowerCase()}`, type, type === "DOM_SNAPSHOT" ? "text/html" : "text/plain", content));
        }
        state.artifacts.push(...captured);
      } catch (error) {
        if (error?.code) throw error;
        throw providerError("EVIDENCE_STORAGE_FAILED");
      }
      return;
    }
    if (node.kind === "INTERACT") {
      if (node.action !== "CLICK" || node.evidence.length !== 1 || node.evidence[0] !== "ACTION_LOG") throw providerError("POLICY_VIOLATION");
      const page = await openPage();
      const beforeUrl = evidenceUrl(page, base);
      const locator = semanticLocator(page, step.target, { requireAccessibleName: true });
      if (!locator) throw providerError("CONTRACT_VIOLATION");
      await assertSafeClickTarget(locator, nodeTimeoutMs);
      interactionStarted = true;
      await locator.click({ timeout: nodeTimeoutMs });
      if (interactionPolicyViolation) throw providerError("POLICY_VIOLATION");
      const afterUrl = evidenceUrl(page, base);
      const content = boundedText(JSON.stringify({ action: "CLICK", target: actionLogTarget(step.target), beforeUrl, afterUrl, status: "SUCCEEDED" }), ACTION_LOG_LIMIT, "ACTION_LOG");
      observationState(observations, node.scenarioId).artifacts.push(captureArtifact(`${node.nodeId}:action_log`, "ACTION_LOG", "application/json", content));
      return;
    }
    if (node.kind === "CHECKPOINT") {
      const page = await openPage();
      const targetUrl = evidenceUrl(page, base);
      const state = observationState(observations, node.scenarioId);
      try {
        const bundle = store.createBundle({
          runId,
          scenarioId: node.scenarioId,
          checkpointId: step.checkpointId,
          capturedAt: now(),
          environment: {
            targetUrl,
            browser: browserName,
            viewport: page.viewportSize?.() ?? { ...viewport },
            ...(locale === undefined ? {} : { locale }),
            ...(timezoneId === undefined ? {} : { timezone: timezoneId }),
          },
          artifacts: state.artifacts,
          facts: [...state.facts, { id: `${node.nodeId}:url`, kind: "URL", value: targetUrl }],
        });
        manifest = store.appendCheckpoint(bundle, manifest === undefined ? {} : { suppliedManifest: manifest });
        bundles.push(bundle);
        observations.delete(node.scenarioId);
      } catch {
        throw providerError("EVIDENCE_STORAGE_FAILED");
      }
      if (interactionStarted) await closeInteractionSession();
    }
  }

  async function closeInteractionSession() {
    const browser = activeBrowser;
    if (browser) await browser.close();
    if (activeBrowser === browser) activeBrowser = undefined;
    if (session?.browser === browser) session = undefined;
    interactionStarted = false;
    if (interactionPolicyViolation) throw providerError("POLICY_VIOLATION");
  }

  function captureArtifact(id, type, contentType, content) {
    const size = Buffer.byteLength(content);
    if (artifactCount + 1 > MAX_RUN_ARTIFACTS || evidenceBytes + size > MAX_RUN_EVIDENCE_BYTES) throw providerError("EVIDENCE_STORAGE_FAILED");
    artifactCount += 1;
    evidenceBytes += size;
    return store.captureArtifact({ id, type, contentType, content });
  }

  function captureFact(fact) {
    const size = Buffer.byteLength(JSON.stringify(fact));
    if (evidenceBytes + size > MAX_RUN_EVIDENCE_BYTES) throw providerError("EVIDENCE_STORAGE_FAILED");
    evidenceBytes += size;
    return fact;
  }

  return {
    capabilities,
    bundles,
    executeNode,
    hasCompleteEvidence() {
      return bundles.length > 0 && bundles.length === planCheckpointCount(qaIr) && observations.size === 0;
    },
    hasInteractionPolicyViolation() { return interactionPolicyViolation; },
    get manifest() { return manifest; },
    readBlob: store.readBlob,
    async close() {
      closed = true;
      if (activeBrowser) await activeBrowser.close();
      activeBrowser = undefined;
    },
  };
}

async function assertSafeClickTarget(locator, timeout) {
  const target = await locator.evaluate((element) => ({
    anchor: element.closest("a[href]") !== null,
    form: element.closest("form") !== null,
    editable: element.isContentEditable,
  }), undefined, { timeout });
  if (!target || target.anchor !== false || target.form !== false || target.editable !== false) throw providerError("POLICY_VIOLATION");
}

function semanticLocator(page, target, { requireAccessibleName = false, allowUnsupported = false } = {}) {
  const identities = [target?.testId !== undefined, target?.text !== undefined, target?.role !== undefined].filter(Boolean).length;
  if (identities === 0) return undefined;
  if (identities !== 1) {
    if (allowUnsupported) return undefined;
    throw providerError("CONTRACT_VIOLATION");
  }
  if (target.testId !== undefined) return boundedLocatorValue(target.testId) ? page.getByTestId(target.testId) : undefined;
  if (target.text?.kind === "literal" && boundedLocatorValue(target.text.value)) return page.getByText(target.text.value);
  if (typeof target.role === "string") {
    const name = target.accessibleName?.kind === "literal" && typeof target.accessibleName.value === "string" ? target.accessibleName.value : undefined;
    if (!boundedLocatorValue(target.role) || (target.accessibleName !== undefined && !boundedLocatorValue(name))) return undefined;
    if (requireAccessibleName && name === undefined) return undefined;
    return page.getByRole(target.role, name === undefined ? {} : { name });
  }
  throw providerError("CONTRACT_VIOLATION");
}

async function observeExpectations(page, expectations, nodeId, timeout) {
  const facts = [];
  for (const expectation of expectations) {
    if (!["CONTAINS_TEXT", "VISIBLE", "NOT_VISIBLE", "PRESENT"].includes(expectation.kind)) continue;
    const locator = semanticLocator(page, expectation.target, { allowUnsupported: true });
    if (!locator) continue;
    const count = await locator.count();
    const id = `${nodeId}:element:${expectation.id}`;
    if (count === 0) {
      facts.push({ id, kind: "ELEMENT_OBSERVATION", value: { expectationId: expectation.id, resolution: "MISSING" } });
      continue;
    }
    if (count > 1) {
      facts.push({ id, kind: "ELEMENT_OBSERVATION", value: { expectationId: expectation.id, resolution: "AMBIGUOUS", count } });
      continue;
    }
    const captured = await locator.evaluate((element, maxChars) => (element.textContent ?? "").slice(0, maxChars + 1), ELEMENT_TEXT_LIMIT, { timeout });
    if (typeof captured !== "string") throw providerError("EVIDENCE_STORAGE_FAILED");
    const value = { expectationId: expectation.id, resolution: "FOUND", visible: await locator.isVisible({ timeout }) };
    if (captured.length <= ELEMENT_TEXT_LIMIT) Object.assign(value, { text: captured, textTruncated: false });
    facts.push({ id, kind: "ELEMENT_OBSERVATION", value });
  }
  return facts;
}

function boundedLocatorValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024;
}

function jsonSnapshot(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("provider input must be JSON-serializable");
  return JSON.parse(serialized);
}

function actionLogTarget(target) {
  if (target.testId !== undefined) return { type: "TEST_ID", value: target.testId };
  if (target.text !== undefined) return { type: "TEXT", value: target.text.value };
  return { type: "ROLE", role: target.role, name: target.accessibleName.value };
}

function planCheckpointCount(qaIr) {
  return qaIr.suites.reduce((total, suite) => total + suite.scenarios.reduce((suiteTotal, scenario) => suiteTotal + scenario.steps.filter((step) => step.kind === "CHECKPOINT").length, 0), 0);
}

async function observe(page, type, timeout) {
  if (type === "VISIBLE_TEXT") return boundedText(await page.locator("body").evaluate((element, maxChars) => element.innerText.slice(0, maxChars), TEXT_LIMIT + 1, { timeout }), TEXT_LIMIT, type);
  if (type === "DOM_SNAPSHOT") return boundedText(await page.locator("html").evaluate((element, maxChars) => element.outerHTML.slice(0, maxChars), DOM_LIMIT + 1, { timeout }), DOM_LIMIT, type);
  throw providerError("POLICY_VIOLATION");
}

function boundedText(value, limit, type) {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit) throw providerError("EVIDENCE_STORAGE_FAILED", `${type} exceeds evidence limit`);
  return value;
}

function observationState(observations, scenarioId) {
  if (!observations.has(scenarioId)) observations.set(scenarioId, { artifacts: [], facts: [] });
  return observations.get(scenarioId);
}

function runtimeUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("baseUrl must be an HTTP(S) URL without credentials");
  return url;
}

function navigationUrl(target, base) {
  if (!target || !["PATH", "URL"].includes(target.type) || typeof target.value !== "string") throw providerError("CONTRACT_VIOLATION");
  const url = new URL(target.value, base);
  if (url.origin !== base.origin || url.username || url.password) throw providerError("POLICY_VIOLATION");
  return url;
}

function assertPageOrigin(page, base) {
  const url = new URL(String(page.url()));
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== base.origin || url.username || url.password) throw providerError("POLICY_VIOLATION");
  return url;
}

function evidenceUrl(page, base) {
  const url = assertPageOrigin(page, base);
  url.search = "";
  url.hash = "";
  return url.href;
}

async function loadBrowserType(browserName) {
  const playwright = await import("@playwright/test");
  if (!playwright[browserName]) throw new Error("unsupported browser");
  return playwright[browserName];
}

function providerError(code) {
  const error = new Error("Execution provider failed");
  error.code = code;
  return error;
}

function runtimeError(code, message) {
  return validateContract("RuntimeOutcome", {
    schemaVersion: RUNTIME_OUTCOME_VERSION,
    stage: "execute",
    type: "ERROR",
    code,
    message,
  });
}

function executionResult(outcome, runtime) {
  const completed = outcome.type === "COMPLETED";
  return Object.freeze({
    outcome,
    bundles: Object.freeze(completed ? [...(runtime?.bundles ?? [])] : []),
    ...(completed && runtime?.manifest !== undefined ? { manifest: runtime.manifest } : {}),
    readBlob: completed ? runtime?.readBlob ?? (() => undefined) : () => undefined,
  });
}
