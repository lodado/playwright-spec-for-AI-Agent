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
    actions: ["NAVIGATE", "OBSERVE", "CHECKPOINT"],
    evidence: ["VISIBLE_TEXT", "DOM_SNAPSHOT"],
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
  const observations = new Map();
  const bundles = [];
  let manifest;
  let session;
  let activeBrowser;
  let closed = false;
  let evidenceBytes = 0;
  let artifactCount = 0;

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
          if (!["GET", "HEAD"].includes(request.method()) || !["http:", "https:"].includes(requestUrl.protocol) || requestUrl.origin !== base.origin || requestUrl.username || requestUrl.password) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket("**/*", (webSocket) => webSocket.close());
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
          const content = await observe(page, type, nodeTimeoutMs);
          const size = Buffer.byteLength(content);
          if (artifactCount + 1 > MAX_RUN_ARTIFACTS || evidenceBytes + size > MAX_RUN_EVIDENCE_BYTES) throw providerError("EVIDENCE_STORAGE_FAILED");
          artifactCount += 1;
          evidenceBytes += size;
          captured.push(store.captureArtifact({
            id: `${node.nodeId}:${type.toLowerCase()}`,
            type,
            contentType: type === "DOM_SNAPSHOT" ? "text/html" : "text/plain",
            content,
          }));
        }
        state.artifacts.push(...captured);
      } catch (error) {
        if (error?.code) throw error;
        throw providerError("EVIDENCE_STORAGE_FAILED");
      }
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
          facts: [{ id: `${node.nodeId}:url`, kind: "URL", value: targetUrl }],
        });
        manifest = store.appendCheckpoint(bundle, manifest === undefined ? {} : { suppliedManifest: manifest });
        bundles.push(bundle);
        observations.delete(node.scenarioId);
      } catch {
        throw providerError("EVIDENCE_STORAGE_FAILED");
      }
    }
  }

  return {
    capabilities,
    bundles,
    executeNode,
    hasCompleteEvidence() {
      return bundles.length > 0 && bundles.length === planCheckpointCount(qaIr) && observations.size === 0;
    },
    get manifest() { return manifest; },
    readBlob: store.readBlob,
    async close() {
      closed = true;
      if (activeBrowser) await activeBrowser.close();
      activeBrowser = undefined;
    },
  };
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
  if (!observations.has(scenarioId)) observations.set(scenarioId, { artifacts: [] });
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
  return Object.freeze({
    outcome,
    bundles: Object.freeze([...(runtime?.bundles ?? [])]),
    ...(runtime?.manifest === undefined ? {} : { manifest: runtime.manifest }),
    readBlob: runtime?.readBlob ?? (() => undefined),
  });
}
